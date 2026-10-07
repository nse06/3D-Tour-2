// Procedural texture generation for the synthetic demo property.
//
// Everything here is deterministic (seeded) so regenerating the demo asset
// produces the same file. Textures are encoded as JPEG (color) or PNG (alpha)
// and embedded straight into the .glb.

import zlib from "node:zlib";
import jpeg from "jpeg-js";

// ---------------------------------------------------------------------------
// Seeded randomness + tileable value noise
// ---------------------------------------------------------------------------

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, v) => smooth(clamp01((v - a) / (b - a)));

/** Value noise that tiles with period (px, py) in lattice units. */
function vnoise(x, y, px, py, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const u = smooth(xf);
  const v = smooth(yf);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Tileable fractal noise in [0,1]. u,v in [0,1); base frequency fx, fy (integers). */
export function fbm(u, v, fx, fy, octaves = 4, seed = 7) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let mx = fx;
  let my = fy;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(u * mx, v * my, mx, my, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    mx *= 2;
    my *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Image container + encoders
// ---------------------------------------------------------------------------

export class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }
  set(x, y, r, g, b, a = 255) {
    const i = (y * this.w + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }
  /** fn(u, v, x, y) => [r,g,b] or [r,g,b,a] with 0..255 floats */
  fill(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = fn((x + 0.5) / this.w, (y + 0.5) / this.h, x, y);
        this.set(
          x,
          y,
          clampByte(c[0]),
          clampByte(c[1]),
          clampByte(c[2]),
          c.length > 3 ? clampByte(c[3]) : 255,
        );
      }
    }
    return this;
  }
  jpeg(quality = 86) {
    return new Uint8Array(
      jpeg.encode({ data: this.data, width: this.w, height: this.h }, quality).data,
    );
  }
  png() {
    return encodePNG(this.w, this.h, this.data);
  }
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Texture recipes
// ---------------------------------------------------------------------------

/** Wide-plank white oak. Planks run along v. Texture covers `planks` planks. */
export function oakFloor(size = 1024, planks = 8) {
  const r = rng(11);
  const plankW = 1 / planks;
  // Per-column plank break positions and tints.
  const cols = Array.from({ length: planks }, () => {
    const offset = r();
    const tint = 0.9 + r() * 0.16;
    const breaks = [offset % 1, (offset + 0.42 + r() * 0.2) % 1];
    return { tint, breaks, tints: [0.9 + r() * 0.17, 0.9 + r() * 0.17] };
  });
  return new Img(size, size).fill((u, v) => {
    const ci = Math.min(planks - 1, Math.floor(u / plankW));
    const col = cols[ci];
    const lu = (u - ci * plankW) / plankW;
    // Which plank segment along v?
    const [b0, b1] = col.breaks;
    const inSeg = b0 < b1 ? v >= b0 && v < b1 : v >= b0 || v < b1;
    const tint = inSeg ? col.tints[0] : col.tints[1];
    const grain = fbm(u, v, planks * 2, 3, 5, 3 + ci);
    const streak = fbm(u * 1, v, planks * 12, 2, 3, 91 + ci);
    const knot = Math.pow(fbm(u, v, planks * 3, 6, 3, 17), 6) * 1.4;
    let k = 0.82 + grain * 0.22 + (streak - 0.5) * 0.16 - knot * 0.25;
    // Plank seams.
    const edge = Math.min(lu, 1 - lu) * size * plankW;
    const dist = (a) => Math.min(Math.abs(v - a), 1 - Math.abs(v - a)) * size;
    const endSeam = Math.min(dist(b0), dist(b1));
    if (edge < 1.3) k *= 0.62;
    else if (edge < 2.5) k *= 0.86;
    if (endSeam < 1.2) k *= 0.66;
    k *= tint;
    return [205 * k, 168 * k, 126 * k];
  });
}

/** Walnut / dark wood grain, grain along u. */
export function walnut(size = 512) {
  return new Img(size, size).fill((u, v) => {
    const g = fbm(u, v, 2, 24, 4, 5);
    const fine = fbm(u, v, 4, 96, 3, 9);
    const wave = Math.sin((v * 18 + fbm(u, v, 3, 3, 3, 2) * 3) * Math.PI * 2) * 0.5 + 0.5;
    const k = 0.72 + g * 0.3 + (fine - 0.5) * 0.2 + wave * 0.08;
    return [104 * k, 70 * k, 48 * k];
  });
}

/** Calacatta-style marble: warm white with soft grey/gold veins. */
export function marble(size = 1024, seed = 3) {
  return new Img(size, size).fill((u, v) => {
    const warp = fbm(u, v, 3, 3, 5, seed);
    const warp2 = fbm(u, v, 6, 6, 4, seed + 10);
    const s1 = Math.abs(Math.sin(Math.PI * 2 * (u * 1 + v * 2) + warp * 7.5));
    const s2 = Math.abs(Math.sin(Math.PI * 2 * (u * 3 - v * 1) + warp2 * 5.5));
    const vein = Math.pow(1 - s1, 18) * 0.85 + Math.pow(1 - s2, 40) * 0.5;
    const cloud = fbm(u, v, 4, 4, 5, seed + 20);
    const base = 234 + (cloud - 0.5) * 16;
    const vr = 128;
    const vg = 124;
    const vb = 120;
    const t = clamp01(vein);
    return [lerp(base, vr, t), lerp(base - 2, vg, t), lerp(base - 6, vb, t)];
  });
}

/** Large-format marble tile with grout lines. tiles = tiles per texture side. */
export function marbleTile(size = 1024, tiles = 2) {
  const m = marble(size, 41);
  const out = new Img(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const gx = (x / size) * tiles;
      const gy = (y / size) * tiles;
      const ex = Math.min(gx - Math.floor(gx), Math.ceil(gx) - gx) * (size / tiles);
      const ey = Math.min(gy - Math.floor(gy), Math.ceil(gy) - gy) * (size / tiles);
      const grout = Math.min(ex, ey) < 1.5;
      out.data[i] = grout ? 190 : m.data[i];
      out.data[i + 1] = grout ? 186 : m.data[i + 1];
      out.data[i + 2] = grout ? 180 : m.data[i + 2];
      out.data[i + 3] = 255;
    }
  }
  return out;
}

/** Honed travertine / limestone for the fireplace surround. */
export function travertine(size = 512) {
  return new Img(size, size).fill((u, v) => {
    const band = fbm(u, v, 1, 14, 4, 21);
    const pits = Math.pow(fbm(u, v, 24, 48, 2, 23), 5);
    const k = 0.9 + (band - 0.5) * 0.18 - pits * 0.5;
    return [222 * k, 208 * k, 186 * k];
  });
}

/** Neutral woven fabric, near white so materials can tint it. */
export function fabric(size = 512) {
  return new Img(size, size).fill((u, v, x, y) => {
    const weave = ((x >> 1) + (y >> 1)) % 2 === 0 ? 1 : 0.94;
    const n = fbm(u, v, 32, 32, 3, 31);
    const k = (0.9 + n * 0.1) * weave;
    return [255 * k, 255 * k, 255 * k];
  });
}

/** Very subtle plaster variation for walls/ceilings (near white, tinted by factor). */
export function plaster(size = 512) {
  return new Img(size, size).fill((u, v) => {
    const n = fbm(u, v, 4, 4, 5, 51);
    const k = 0.96 + n * 0.04;
    return [255 * k, 255 * k, 255 * k];
  });
}

/** Bright exterior "daylight" view used as an emissive map for window panes. */
export function windowView(w = 512, h = 512, seed = 61) {
  return new Img(w, h).fill((u, v) => {
    // v=0 at top in image space.
    const sky = [lerp(208, 246, v), lerp(226, 248, v), lerp(246, 250, v)];
    const treeLine = 0.58 + (fbm(u, 0.5, 6, 1, 4, seed) - 0.5) * 0.28;
    const canopy = smoothstep(treeLine - 0.04, treeLine + 0.08, v);
    const leaf = fbm(u, v, 10, 10, 4, seed + 1);
    const tree = [lerp(150, 196, leaf), lerp(178, 214, leaf), lerp(140, 178, leaf)];
    const lawn = smoothstep(0.86, 0.95, v);
    const grass = [184, 212, 160];
    const c = sky.map((s, i) => lerp(s, tree[i], canopy * 0.85));
    return c.map((s, i) => lerp(s, grass[i], lawn * 0.7));
  });
}

/** Soft rounded-rectangle contact shadow (alpha PNG). */
export function contactShadow(size = 256) {
  return new Img(size, size).fill((u, v) => {
    const dx = Math.max(Math.abs(u - 0.5) - 0.22, 0);
    const dy = Math.max(Math.abs(v - 0.5) - 0.22, 0);
    const d = Math.sqrt(dx * dx + dy * dy) / 0.28;
    const a = Math.pow(clamp01(1 - d), 1.5) * 0.85;
    return [0, 0, 0, a * 255];
  });
}

/** Wool rug with a border. palette: {field:[r,g,b], border:[r,g,b], accent:[r,g,b]} */
export function rug(w, h, palette, pattern = "plain", seed = 71) {
  const { field, border, accent } = palette;
  return new Img(w, h).fill((u, v, x, y) => {
    const n = fbm(u, v, 24, 24, 3, seed);
    const mottle = fbm(u, v, 4, 4, 4, seed + 3);
    const bu = Math.min(u, 1 - u);
    const bv = Math.min(v, 1 - v) * (h / w);
    const b = Math.min(bu, bv);
    let c = field;
    if (pattern === "lattice") {
      const gu = (u * 10) % 1;
      const gv = (v * 10 * (h / w)) % 1;
      const line = Math.min(Math.abs(gu - gv), Math.abs(gu + gv - 1));
      if (line < 0.06) c = accent;
    } else if (pattern === "medallion") {
      const du = (u - 0.5) * 2;
      const dv = ((v - 0.5) * 2 * h) / w;
      const r = Math.sqrt(du * du + dv * dv);
      const ang = Math.atan2(dv, du);
      const petal = Math.abs(Math.cos(ang * 6)) * 0.12;
      if (Math.abs(r - (0.34 + petal)) < 0.035 || r < 0.08) c = accent;
      const fade = fbm(u, v, 6, 6, 4, seed + 9);
      if (fade > 0.62) c = c.map((ch, i) => lerp(ch, field[i], 0.5));
    } else if (pattern === "stripe") {
      if (Math.abs(((u * 7) % 1) - 0.5) < 0.04) c = accent;
    }
    if (b < 0.06 && b > 0.045) c = accent;
    else if (b < 0.045) c = border;
    const k = 0.9 + n * 0.12 + (mottle - 0.5) * 0.08;
    const fringe = ((x + y) & 1) === 0 ? 1 : 0.985;
    return c.map((ch) => ch * k * fringe);
  });
}

// --- Artwork ---------------------------------------------------------------

export function artColorField(w = 512, h = 640) {
  return new Img(w, h).fill((u, v) => {
    const brush = fbm(u, v, 3, 40, 4, 101);
    const edge = (fbm(u, v, 8, 8, 3, 103) - 0.5) * 0.03;
    let c = [236, 228, 214];
    if (v > 0.08 + edge && v < 0.52 + edge && u > 0.09 + edge && u < 0.91 - edge) c = [182, 92, 58];
    if (v > 0.58 + edge && v < 0.92 + edge && u > 0.09 + edge && u < 0.91 - edge) c = [208, 162, 92];
    const k = 0.9 + brush * 0.16;
    return c.map((ch) => ch * k);
  });
}

export function artCircles(w = 512, h = 512) {
  const circles = [
    [0.38, 0.42, 0.27, [36, 52, 82]],
    [0.62, 0.55, 0.23, [196, 128, 92]],
    [0.5, 0.3, 0.13, [222, 196, 148]],
  ];
  return new Img(w, h).fill((u, v) => {
    let c = [240, 236, 228];
    for (const [cx, cy, r, col] of circles) {
      const d = Math.hypot(u - cx, (v - cy) * (h / w));
      if (d < r) c = c.map((ch, i) => lerp(ch, col[i], 0.82));
    }
    const grain = fbm(u, v, 48, 48, 2, 111);
    return c.map((ch) => ch * (0.94 + grain * 0.08));
  });
}

/** Abstract lake horizon — a nod to the Lake Michigan shoreline. */
export function artLake(w = 1024, h = 512) {
  return new Img(w, h).fill((u, v) => {
    const horizon = 0.46 + (fbm(u, 0.3, 3, 1, 3, 121) - 0.5) * 0.04;
    const brush = fbm(u, v, 2, 30, 4, 123);
    let c;
    if (v < horizon) {
      const t = v / horizon;
      c = [lerp(214, 236, t), lerp(222, 226, t), lerp(230, 214, t)];
    } else {
      const t = (v - horizon) / (1 - horizon);
      c = [lerp(120, 44, t), lerp(152, 72, t), lerp(170, 96, t)];
    }
    const k = 0.92 + brush * 0.14;
    return c.map((ch) => ch * k);
  });
}

export function artLines(w = 512, h = 640) {
  return new Img(w, h).fill((u, v) => {
    const base = 240 - fbm(u, v, 4, 4, 3, 131) * 10;
    const s1 = Math.abs(v - (0.3 + Math.sin(u * 5.5 + 0.4) * 0.12));
    const s2 = Math.abs(u - (0.55 + Math.sin(v * 4.2 + 1.2) * 0.18));
    const ink = Math.min(s1, s2) < 0.012 + fbm(u, v, 20, 20, 2, 133) * 0.01;
    return ink ? [34, 32, 30] : [base, base - 3, base - 8];
  });
}
