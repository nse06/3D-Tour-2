// CPU tile rasterizer for 3D Gaussian splatting (forward and backward), after Kerbl et al. 2023.
// Pixel-space inputs: means2d (N,2), conics (N,3) = inverse 2D covariance (a, b, c) with
// power = -0.5 (a dx² + c dy²) - b dx dy, colors (N,3), opacities (N), depths (N), radii (N).
#include <torch/extension.h>
#include <omp.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace {
constexpr int TILE = 16;
#ifndef GS_ALPHA_MIN
#define GS_ALPHA_MIN (1.0f / 255.0f)
#endif
constexpr float ALPHA_MIN = GS_ALPHA_MIN;
// Overridable for splat/viewer_check.py, which imitates other renderers.
#ifndef GS_ALPHA_MAX
#define GS_ALPHA_MAX 0.99f
#endif
#ifndef GS_T_MIN
#define GS_T_MIN 1e-4f
#endif
constexpr float ALPHA_MAX = GS_ALPHA_MAX;
constexpr float T_MIN = GS_T_MIN;

struct Binning {
  std::vector<int32_t> list;   // Gaussian ids, sorted by tile then depth
  std::vector<int64_t> ranges; // per tile: [start, end) into list
};

Binning bin(const float* m2d, const float* depth, const int32_t* radii, int64_t n, int w, int h) {
  const int tw = (w + TILE - 1) / TILE, th = (h + TILE - 1) / TILE;
  std::vector<std::pair<uint64_t, int32_t>> keys;
  keys.reserve(n * 2);
  for (int64_t i = 0; i < n; i++) {
    const int r = radii[i];
    if (r <= 0) continue;
    const float x = m2d[2 * i], y = m2d[2 * i + 1];
    const int x0 = std::max(0, (int)std::floor((x - r) / TILE)), x1 = std::min(tw, (int)std::ceil((x + r) / TILE));
    const int y0 = std::max(0, (int)std::floor((y - r) / TILE)), y1 = std::min(th, (int)std::ceil((y + r) / TILE));
    if (x0 >= x1 || y0 >= y1) continue;
    // Depth as an order-preserving 32-bit key (depths are positive).
    float d = depth[i];
    uint32_t dk;
    std::memcpy(&dk, &d, 4);
    for (int ty = y0; ty < y1; ty++)
      for (int tx = x0; tx < x1; tx++) keys.emplace_back(((uint64_t)(ty * tw + tx) << 32) | dk, (int32_t)i);
  }
  std::sort(keys.begin(), keys.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  Binning out;
  out.list.resize(keys.size());
  out.ranges.assign((size_t)tw * th * 2, 0);
  for (size_t k = 0; k < keys.size(); k++) {
    out.list[k] = keys[k].second;
    const int64_t tile = (int64_t)(keys[k].first >> 32);
    if (k == 0 || (int64_t)(keys[k - 1].first >> 32) != tile) out.ranges[2 * tile] = (int64_t)k;
    if (k + 1 == keys.size() || (int64_t)(keys[k + 1].first >> 32) != tile) out.ranges[2 * tile + 1] = (int64_t)k + 1;
  }
  return out;
}
}  // namespace

// Returns image (H,W,3), final transmittance (H,W), last contributor per pixel (H,W) (index into the
// tile's list, +1), and the binning (list, ranges) for the backward pass.
std::vector<torch::Tensor> forward(torch::Tensor means2d, torch::Tensor conics, torch::Tensor colors, torch::Tensor opacities, torch::Tensor depths,
                                   torch::Tensor radii, int64_t w, int64_t h, torch::Tensor background) {
  means2d = means2d.contiguous();
  conics = conics.contiguous();
  colors = colors.contiguous();
  opacities = opacities.contiguous();
  depths = depths.contiguous();
  radii = radii.contiguous();
  const int64_t n = means2d.size(0);
  const float* m2d = means2d.data_ptr<float>();
  const float* con = conics.data_ptr<float>();
  const float* col = colors.data_ptr<float>();
  const float* op = opacities.data_ptr<float>();
  const float* bg = background.data_ptr<float>();
  Binning b = bin(m2d, depths.data_ptr<float>(), radii.data_ptr<int32_t>(), n, (int)w, (int)h);
  auto image = torch::zeros({h, w, 3}, torch::kFloat32);
  auto finalT = torch::zeros({h, w}, torch::kFloat32);
  auto contrib = torch::zeros({h, w}, torch::kInt32);
  float* img = image.data_ptr<float>();
  float* fT = finalT.data_ptr<float>();
  int32_t* nc = contrib.data_ptr<int32_t>();
  const int tw = (int)((w + TILE - 1) / TILE), th = (int)((h + TILE - 1) / TILE);
#pragma omp parallel for schedule(dynamic, 4)
  for (int tile = 0; tile < tw * th; tile++) {
    const int64_t start = b.ranges[2 * tile], end = b.ranges[2 * tile + 1];
    const int tx = tile % tw, ty = tile / tw;
    for (int py = ty * TILE; py < std::min((int)h, (ty + 1) * TILE); py++)
      for (int px = tx * TILE; px < std::min((int)w, (tx + 1) * TILE); px++) {
        const float fx = px + 0.5f, fy = py + 0.5f;
        float T = 1.0f, c0 = 0, c1 = 0, c2 = 0;
        int32_t last = 0;
        for (int64_t k = start; k < end; k++) {
          const int32_t g = b.list[k];
          const float dx = m2d[2 * g] - fx, dy = m2d[2 * g + 1] - fy;
          const float power = -0.5f * (con[3 * g] * dx * dx + con[3 * g + 2] * dy * dy) - con[3 * g + 1] * dx * dy;
          if (power > 0.0f) continue;
#ifdef GS_POWER_MIN
          if (power < GS_POWER_MIN) continue;  // a hard cutoff, in units of -r²/2
#endif
          const float alpha = std::min(ALPHA_MAX, op[g] * std::exp(power));
          if (alpha < ALPHA_MIN) continue;
          const float testT = T * (1.0f - alpha);
          if (testT < T_MIN) break;
          const float wgt = alpha * T;
          c0 += col[3 * g] * wgt;
          c1 += col[3 * g + 1] * wgt;
          c2 += col[3 * g + 2] * wgt;
          T = testT;
          last = (int32_t)(k - start + 1);
        }
        const int64_t p = (int64_t)py * w + px;
        img[3 * p] = c0 + T * bg[0];
        img[3 * p + 1] = c1 + T * bg[1];
        img[3 * p + 2] = c2 + T * bg[2];
        fT[p] = T;
        nc[p] = last;
      }
  }
  auto list = torch::from_blob(b.list.data(), {(int64_t)b.list.size()}, torch::kInt32).clone();
  auto ranges = torch::from_blob(b.ranges.data(), {(int64_t)b.ranges.size()}, torch::kInt64).clone();
  return {image, finalT, contrib, list, ranges};
}

// Gradients for means2d (N,2), conics (N,3), colors (N,3), opacities (N).
std::vector<torch::Tensor> backward(torch::Tensor means2d, torch::Tensor conics, torch::Tensor colors, torch::Tensor opacities, torch::Tensor finalT,
                                    torch::Tensor contrib, torch::Tensor list, torch::Tensor ranges, int64_t w, int64_t h, torch::Tensor background,
                                    torch::Tensor gradImage) {
  means2d = means2d.contiguous();
  conics = conics.contiguous();
  colors = colors.contiguous();
  opacities = opacities.contiguous();
  gradImage = gradImage.contiguous();
  const int64_t n = means2d.size(0);
  const float* m2d = means2d.data_ptr<float>();
  const float* con = conics.data_ptr<float>();
  const float* col = colors.data_ptr<float>();
  const float* op = opacities.data_ptr<float>();
  const float* fT = finalT.data_ptr<float>();
  const int32_t* nc = contrib.data_ptr<int32_t>();
  const int32_t* lst = list.data_ptr<int32_t>();
  const int64_t* rng = ranges.data_ptr<int64_t>();
  const float* bg = background.data_ptr<float>();
  const float* gi = gradImage.data_ptr<float>();
  const int threads = omp_get_max_threads();
  // Per-thread accumulators: 2 + 3 + 3 + 1 floats per Gaussian.
  std::vector<std::vector<float>> acc(threads);
  const int tw = (int)((w + TILE - 1) / TILE), th = (int)((h + TILE - 1) / TILE);
#pragma omp parallel
  {
    const int t = omp_get_thread_num();
    std::vector<float>& a = acc[t];
    a.assign((size_t)n * 9, 0.0f);
#pragma omp for schedule(dynamic, 4)
    for (int tile = 0; tile < tw * th; tile++) {
      const int64_t start = rng[2 * tile];
      const int tx = tile % tw, ty = tile / tw;
      for (int py = ty * TILE; py < std::min((int)h, (ty + 1) * TILE); py++)
        for (int px = tx * TILE; px < std::min((int)w, (tx + 1) * TILE); px++) {
          const int64_t p = (int64_t)py * w + px;
          const int32_t last = nc[p];
          if (last == 0) continue;
          const float fx = px + 0.5f, fy = py + 0.5f;
          const float g0 = gi[3 * p], g1 = gi[3 * p + 1], g2 = gi[3 * p + 2];
          const float Tfinal = fT[p];
          const float bgDot = bg[0] * g0 + bg[1] * g1 + bg[2] * g2;
          float T = Tfinal;
          float acc0 = 0, acc1 = 0, acc2 = 0, lastAlpha = 0, lc0 = 0, lc1 = 0, lc2 = 0;
          for (int64_t k = start + last - 1; k >= start; k--) {
            const int32_t g = lst[k];
            const float dx = m2d[2 * g] - fx, dy = m2d[2 * g + 1] - fy;
            const float ca = con[3 * g], cb = con[3 * g + 1], cc = con[3 * g + 2];
            const float power = -0.5f * (ca * dx * dx + cc * dy * dy) - cb * dx * dy;
            if (power > 0.0f) continue;
#ifdef GS_POWER_MIN
          if (power < GS_POWER_MIN) continue;  // a hard cutoff, in units of -r²/2
#endif
            const float G = std::exp(power);
            const float alpha = std::min(ALPHA_MAX, op[g] * G);
            if (alpha < ALPHA_MIN) continue;
            T = T / (1.0f - alpha);
            const float wgt = alpha * T;
            const float r = col[3 * g], gg = col[3 * g + 1], bb = col[3 * g + 2];
            acc0 = lastAlpha * lc0 + (1.0f - lastAlpha) * acc0;
            acc1 = lastAlpha * lc1 + (1.0f - lastAlpha) * acc1;
            acc2 = lastAlpha * lc2 + (1.0f - lastAlpha) * acc2;
            lc0 = r;
            lc1 = gg;
            lc2 = bb;
            float dAlpha = ((r - acc0) * g0 + (gg - acc1) * g1 + (bb - acc2) * g2) * T;
            lastAlpha = alpha;
            dAlpha += (-Tfinal / (1.0f - alpha)) * bgDot;
            float* ag = &a[(size_t)g * 9];
            ag[5] += wgt * g0;
            ag[6] += wgt * g1;
            ag[7] += wgt * g2;
            // alpha = op * G (the 0.99 cap is ignored, as in the reference implementation).
            const float dG = op[g] * dAlpha;
            const float gdx = G * dx, gdy = G * dy;
            // d power / d mean = -(a dx + b dy), -(c dy + b dx)   (dx = mean - pixel)
            ag[0] += dG * (-gdx * ca - gdy * cb);
            ag[1] += dG * (-gdy * cc - gdx * cb);
            ag[2] += dG * (-0.5f * gdx * dx);
            ag[3] += dG * (-gdx * dy);
            ag[4] += dG * (-0.5f * gdy * dy);
            ag[8] += G * dAlpha;
          }
        }
    }
  }
  auto gm = torch::zeros({n, 2}, torch::kFloat32), gc = torch::zeros({n, 3}, torch::kFloat32);
  auto gcol = torch::zeros({n, 3}, torch::kFloat32), gop = torch::zeros({n}, torch::kFloat32);
  float *pm = gm.data_ptr<float>(), *pc = gc.data_ptr<float>(), *pcol = gcol.data_ptr<float>(), *pop = gop.data_ptr<float>();
#pragma omp parallel for schedule(static)
  for (int64_t g = 0; g < n; g++) {
    float s[9] = {0, 0, 0, 0, 0, 0, 0, 0, 0};
    for (int t = 0; t < threads; t++) {
      if (acc[t].empty()) continue;
      const float* ag = &acc[t][(size_t)g * 9];
      for (int k = 0; k < 9; k++) s[k] += ag[k];
    }
    pm[2 * g] = s[0];
    pm[2 * g + 1] = s[1];
    pc[3 * g] = s[2];
    pc[3 * g + 1] = s[3];
    pc[3 * g + 2] = s[4];
    pcol[3 * g] = s[5];
    pcol[3 * g + 1] = s[6];
    pcol[3 * g + 2] = s[7];
    pop[g] = s[8];
  }
  return {gm, gc, gcol, gop};
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
  m.def("forward", &forward, "rasterize Gaussians (CPU)");
  m.def("backward", &backward, "rasterize Gaussians, backward (CPU)");
}
