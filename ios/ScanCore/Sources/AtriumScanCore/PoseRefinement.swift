import Foundation

// Photo alignment. ARKit's tracking drifts a centimeter or two and a fraction of a degree between
// its corrections, and each photo keeps the pose it was taken with, so photos land slightly off the
// model and off each other: doubled edges, seams that don't meet, a chair's color on the wall behind
// it. As in Zhou & Koltun's color map optimization (its rigid form), the photos are nudged until they
// agree on the model's surfaces. Alternately: the brightness at sample points on the surfaces is the
// photos' consensus there, and each photo's pose (and exposure) is fitted to those brightnesses by
// Gauss–Newton, on small grayscale copies of the photos, coarse then fine.

/// A small grayscale copy of a photo, lightly blurred (smooth gradients for the fit).
struct GrayImage: Sendable {
    let width: Int, height: Int
    let pixels: [UInt8]

    init(width: Int, height: Int, pixels: [UInt8]) {
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    /// The photo's luma, box-filtered down to `target` pixels across (or kept, if smaller), then blurred 1-2-1.
    init(_ rgb: RGBImage, width target: Int) {
        let w = min(target, rgb.width), h = max(1, Int((Double(rgb.height) * Double(w) / Double(rgb.width)).rounded()))
        var sum = [Float](repeating: 0, count: w * h), count = [Float](repeating: 0, count: w * h)
        rgb.pixels.withUnsafeBufferPointer { px in
            for y in 0..<rgb.height {
                let ty = min(h - 1, y * h / rgb.height)
                for x in 0..<rgb.width {
                    let tx = min(w - 1, x * w / rgb.width), i = (y * rgb.width + x) * 3
                    sum[ty * w + tx] += 0.299 * Float(px[i]) + 0.587 * Float(px[i + 1]) + 0.114 * Float(px[i + 2])
                    count[ty * w + tx] += 1
                }
            }
        }
        var luma = (0..<(w * h)).map { count[$0] > 0 ? sum[$0] / count[$0] : 0 }
        luma = Self.blurred(luma, w, h)
        self.init(width: w, height: h, pixels: luma.map { UInt8(clamp($0.rounded(), 0, 255)) })
    }

    static func blurred(_ v: [Float], _ w: Int, _ h: Int) -> [Float] {
        var tmp = v, out = v
        for y in 0..<h {
            for x in 0..<w {
                let l = v[y * w + max(0, x - 1)], r = v[y * w + min(w - 1, x + 1)]
                tmp[y * w + x] = (l + 2 * v[y * w + x] + r) / 4
            }
        }
        for y in 0..<h {
            for x in 0..<w {
                let u = tmp[max(0, y - 1) * w + x], d = tmp[min(h - 1, y + 1) * w + x]
                out[y * w + x] = (u + 2 * tmp[y * w + x] + d) / 4
            }
        }
        return out
    }

    /// Half the size (2 × 2 averages).
    func halved() -> GrayImage {
        let w = max(1, width / 2), h = max(1, height / 2)
        var out = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let x0 = min(2 * x, width - 1), x1 = min(2 * x + 1, width - 1), y0 = min(2 * y, height - 1), y1 = min(2 * y + 1, height - 1)
                let s = Int(pixels[y0 * width + x0]) + Int(pixels[y0 * width + x1]) + Int(pixels[y1 * width + x0]) + Int(pixels[y1 * width + x1])
                out[y * w + x] = UInt8((s + 2) / 4)
            }
        }
        return GrayImage(width: w, height: h, pixels: out)
    }

    @inline(__always) func at(_ x: Float, _ y: Float) -> Float {
        let x0 = Int(x), y0 = Int(y)
        let ax = x - Float(x0), ay = y - Float(y0)
        let i = y0 * width + x0
        let top = Float(pixels[i]) * (1 - ax) + Float(pixels[i + 1]) * ax
        let bottom = Float(pixels[i + width]) * (1 - ax) + Float(pixels[i + width + 1]) * ax
        return top * (1 - ay) + bottom * ay
    }

    /// Brightness and its gradient (per pixel) at (x, y), pixel centers at whole numbers; nil near the border.
    @inline(__always) func sample(_ x: Float, _ y: Float) -> (value: Float, dx: Float, dy: Float)? {
        guard x >= 1, y >= 1, x < Float(width - 2), y < Float(height - 2) else { return nil }
        return (at(x, y), (at(x + 1, y) - at(x - 1, y)) / 2, (at(x, y + 1) - at(x, y - 1)) / 2)
    }
}

enum PoseRefinement {
    /// A point on the model's surfaces and the photos that see it clearly (indices into the cameras).
    struct Sample {
        var point: Vec3
        var cameras: [Int32]
    }

    struct Options {
        /// Photos are compared this many pixels across (then at half that, first).
        var side = 320
        var coarseIterations = 5
        var fineIterations = 5
        /// Photos with fewer samples keep their pose.
        var minSamples = 40
        /// Expected size of a correction (a prior: textureless views stay put), meters and radians.
        var shiftScale: Float = 0.03
        var turnScale: Float = 0.01
        /// A correction never goes beyond these.
        var maxShift: Float = 0.08
        var maxTurn: Float = 0.025
    }

    struct Result {
        /// Photos fitted, and their mean correction (meters, radians).
        var aligned = 0
        var meanShift: Double = 0
        var meanTurn: Double = 0
        /// Agreement before and after: mean absolute difference from the consensus, gray levels.
        var errorBefore: Double = 0
        var errorAfter: Double = 0
        /// Per photo: the gain and offset that match its brightness to the others (1 and 0 if not fitted).
        var gains: [Float] = []
        var offsets: [Float] = []
    }

    /// Small grayscale copies of the photos (nil where one can't be read or isn't `wanted`).
    static func thumbnails(_ cams: [PhotoCamera], photos: PhotoSource, side: Int, wanted: [Bool]) -> SharedArray<GrayImage?> {
        let images = SharedArray<GrayImage?>(repeating: nil, count: cams.count)
        DispatchQueue.concurrentPerform(iterations: cams.count) { k in
            guard wanted[k], let rgb = photos.thumbnail(for: cams[k].frame, side: side), rgb.width > 8, rgb.height > 8 else { return }
            images.buffer[k] = GrayImage(rgb, width: side)
        }
        return images
    }

    /// A photo's current pose: where it is and which way its axes point.
    struct Pose {
        var position: Vec3
        var right: Vec3, up: Vec3, back: Vec3

        /// Turned by the small rotation `w` (axis × angle, world frame) about the camera's center.
        func turned(by w: Vec3) -> Pose {
            let angle = vlength(w)
            guard angle > 1e-9 else { return self }
            let k = w / angle, c = cos(angle), s = sin(angle)
            func rotate(_ v: Vec3) -> Vec3 { v * c + vcross(k, v) * s + k * (vdot(k, v) * (1 - c)) }
            // Re-orthonormalize so the axes never drift apart.
            let b = vnormalize(rotate(back)), r0 = rotate(right)
            let r = vnormalize(r0 - b * vdot(r0, b))
            return Pose(position: position, right: r, up: vcross(b, r), back: b)
        }
    }

    /// Nudges the photos into agreement; `cams` get their refined poses (frames and axes; the depth
    /// images are the caller's to redraw).
    /// `fine`: the photos' grayscale copies (`thumbnails`).
    static func refine(_ cams: inout [PhotoCamera], samples: [Sample], images fine: SharedArray<GrayImage?>, options: Options = .init()) -> Result {
        let base = cams
        let n = base.count
        var seenBy = [[Int32]](repeating: [], count: n)
        for (s, sample) in samples.enumerated() {
            for k in sample.cameras { seenBy[Int(k)].append(Int32(s)) }
        }
        guard seenBy.contains(where: { $0.count >= options.minSamples }) else { return Result() }

        // The same copies at half size, for the first, coarse rounds.
        let observed = (0..<n).filter { !seenBy[$0].isEmpty }
        let coarse = SharedArray<GrayImage?>(repeating: nil, count: n)
        DispatchQueue.concurrentPerform(iterations: observed.count) { m in
            let k = observed[m]
            coarse.buffer[k] = fine.buffer[k]?.halved()
        }
        let fitted = (0..<n).filter { seenBy[$0].count >= options.minSamples && fine.buffer[$0] != nil }
        guard !fitted.isEmpty else { return Result() }

        var poses = base.map { Pose(position: $0.position, right: $0.right, up: $0.up, back: $0.back) }
        var shift = [Vec3](repeating: .zero, count: n), turn = [Vec3](repeating: .zero, count: n)
        var gain = [Float](repeating: 1, count: n), offset = [Float](repeating: 0, count: n)
        var result = Result()

        /// Where photo k at `pose` shows world point p, in an image `scale` × the photo's size: pixel
        /// position there, and the point's camera-space x, y and depth.
        @inline(__always) func project(_ k: Int, _ p: Vec3, _ pose: Pose, _ scale: Float) -> (x: Float, y: Float, cx: Float, cy: Float, z: Float)? {
            let d = p - pose.position
            let z = -vdot(d, pose.back)
            guard z > 0.1 else { return nil }
            let cx = vdot(d, pose.right), cy = vdot(d, pose.up)
            let c = base[k]
            return ((c.fx * cx / z + c.cx) * scale - 0.5, (-c.fy * cy / z + c.cy) * scale - 0.5, cx, cy, z)
        }

        // Priors, in units of an observation's noise (about 8 gray levels): a photo showing little
        // texture keeps close to where ARKit put it. Order: shift x y z, turn x y z, gain − 1, offset.
        let huber: Float = 10, noise = 64.0
        let priorScales = [Double](repeating: Double(options.shiftScale), count: 3) + [Double](repeating: Double(options.turnScale), count: 3) + [0.2, 20]
        let priorWeights = priorScales.map { noise / ($0 * $0) }
        func clampedShift(_ t: Vec3) -> Vec3 { vlength(t) > options.maxShift ? vnormalize(t) * options.maxShift : t }
        func clampedTurn(_ w: Vec3) -> Vec3 { vlength(w) > options.maxTurn ? vnormalize(w) * options.maxTurn : w }

        // The consensus brightness at each sample: the median of the photos, then the mean of those
        // that agree with it (a photo that sees something else there drops out). Returns the mean
        // absolute difference from the median: how much the photos disagree.
        let targets = SharedArray<Float>(repeating: .nan, count: samples.count)
        func consensus(_ images: SharedArray<GrayImage?>, _ poses: [Pose], _ gain: [Float], _ offset: [Float]) -> Double {
            let chunk = 2048, parts = (samples.count + chunk - 1) / chunk
            let spread = SharedArray<Double>(repeating: 0, count: max(parts, 1)), counted = SharedArray<Int>(repeating: 0, count: max(parts, 1))
            DispatchQueue.concurrentPerform(iterations: parts) { part in
                var values: [Float] = []
                for s in (part * chunk)..<min(samples.count, (part + 1) * chunk) {
                    values.removeAll(keepingCapacity: true)
                    for k32 in samples[s].cameras {
                        let k = Int(k32)
                        guard let image = images.buffer[k] else { continue }
                        let scale = Float(image.width) / Float(base[k].width)
                        guard let q = project(k, samples[s].point, poses[k], scale), let v = image.sample(q.x, q.y) else { continue }
                        values.append(gain[k] * v.value + offset[k])
                    }
                    targets.buffer[s] = .nan
                    guard values.count >= 2 else { continue }
                    values.sort()
                    let median = values[values.count / 2]
                    var sum: Float = 0, kept = 0, apart: Float = 0
                    for v in values {
                        apart += abs(v - median)
                        if abs(v - median) < 20 {
                            sum += v
                            kept += 1
                        }
                    }
                    if kept >= 2 { targets.buffer[s] = sum / Float(kept) }
                    spread.buffer[part] += Double(apart / Float(values.count))
                    counted.buffer[part] += 1
                }
            }
            let total = spread.array(0..<max(parts, 1)).reduce(0, +), count = counted.array(0..<max(parts, 1)).reduce(0, +)
            return count > 0 ? total / Double(count) : 0
        }
        /// Photo k's disagreement with the consensus (Huber) at a pose, gain and offset, plus its priors.
        func cost(_ k: Int, _ image: GrayImage, _ pose: Pose, _ shift: Vec3, _ turn: Vec3, _ gain: Float, _ offset: Float) -> Double {
            let scale = Float(image.width) / Float(base[k].width)
            var total = 0.0
            for s32 in seenBy[k] {
                let s = Int(s32)
                let target = targets.buffer[s]
                guard target.isFinite, let q = project(k, samples[s].point, pose, scale), let v = image.sample(q.x, q.y) else {
                    total += Double(huber * huber)  // seen no more: as bad as a clear miss
                    continue
                }
                let r = abs(gain * v.value + offset - target)
                total += Double(r <= huber ? r * r / 2 : huber * (r - huber / 2))
            }
            let state = [shift.x, shift.y, shift.z, turn.x, turn.y, turn.z, gain - 1, offset].map(Double.init)
            for i in 0..<8 { total += priorWeights[i] * state[i] * state[i] / 2 }
            return total
        }
        result.errorBefore = consensus(fine, poses, gain, offset)

        for (images, iterations) in [(coarse, options.coarseIterations), (fine, options.fineIterations)] {
            for _ in 0..<iterations {
                let current = poses, g = gain, o = offset, shiftNow = shift, turnNow = turn
                _ = consensus(images, current, g, o)
                // Each photo's pose, gain and offset fitted to the consensus: a damped Gauss–Newton step,
                // kept only if the photo then agrees better (else half of it, else none) — what the
                // photos disagree on for other reasons (glare on a glossy floor) mustn't move them.
                let step = SharedArray<(Vec3, Vec3, Float, Float)>(repeating: (.zero, .zero, 0, 0), count: n)
                DispatchQueue.concurrentPerform(iterations: fitted.count) { m in
                    let k = fitted[m]
                    guard let image = images.buffer[k] else { return }
                    let scale = Float(image.width) / Float(base[k].width)
                    let pose = current[k], c = base[k]
                    var H = [Double](repeating: 0, count: 64), b = [Double](repeating: 0, count: 8)
                    var used = 0
                    for s32 in seenBy[k] {
                        let s = Int(s32)
                        let target = targets.buffer[s]
                        guard target.isFinite, let q = project(k, samples[s].point, pose, scale), let v = image.sample(q.x, q.y) else { continue }
                        let r = g[k] * v.value + o[k] - target
                        let w: Float = abs(r) <= huber ? 1 : huber / abs(r)
                        let (jt, jw) = gradient(du: g[k] * v.dx * scale, dv: g[k] * v.dy * scale, camera: c, pose: pose, point: samples[s].point)
                        let J: [Float] = [jt.x, jt.y, jt.z, jw.x, jw.y, jw.z, v.value, 1]
                        for i in 0..<8 {
                            b[i] += Double(w * J[i] * r)
                            for j in i..<8 { H[i * 8 + j] += Double(w * J[i] * J[j]) }
                        }
                        used += 1
                    }
                    guard used >= options.minSamples / 2 else { return }
                    for i in 0..<8 {
                        for j in 0..<i { H[i * 8 + j] = H[j * 8 + i] }
                    }
                    let state = [shiftNow[k].x, shiftNow[k].y, shiftNow[k].z, turnNow[k].x, turnNow[k].y, turnNow[k].z, g[k] - 1, o[k]].map(Double.init)
                    for i in 0..<8 {
                        H[i * 8 + i] += priorWeights[i]
                        b[i] += priorWeights[i] * state[i]
                    }
                    for i in 0..<8 { H[i * 8 + i] *= 1.1 }  // Levenberg damping
                    guard let delta = solve8(H, b.map { -$0 }) else { return }
                    var dt = Vec3(Float(delta[0]), Float(delta[1]), Float(delta[2])), dw = Vec3(Float(delta[3]), Float(delta[4]), Float(delta[5]))
                    if vlength(dt) > 0.01 { dt = vnormalize(dt) * 0.01 }
                    if vlength(dw) > 0.004 { dw = vnormalize(dw) * 0.004 }
                    let before = cost(k, image, pose, shiftNow[k], turnNow[k], g[k], o[k])
                    for fraction: Float in [1, 0.5] {
                        let t = clampedShift(shiftNow[k] + dt * fraction), w = clampedTurn(turnNow[k] + dw * fraction)
                        var trial = pose.turned(by: w - turnNow[k])
                        trial.position = c.position + t
                        let dg = Float(delta[6]) * fraction, db = Float(delta[7]) * fraction
                        let gk = clamp(g[k] + dg, 0.5, 2), ok = clamp(o[k] + db, -60, 60)
                        if cost(k, image, trial, t, w, gk, ok) < before {
                            step.buffer[k] = (t - shiftNow[k], w - turnNow[k], gk - g[k], ok - o[k])
                            break
                        }
                    }
                }
                for k in fitted {
                    let (dt, dw, dg, db) = step.buffer[k]
                    guard dt != .zero || dw != .zero || dg != 0 || db != 0 else { continue }
                    poses[k] = poses[k].turned(by: dw)
                    shift[k] += dt
                    turn[k] += dw
                    poses[k].position = base[k].position + shift[k]
                    gain[k] += dg
                    offset[k] += db
                }
            }
        }
        // Photos the fit didn't clearly improve keep the pose they were taken with.
        _ = consensus(fine, poses, gain, offset)
        for k in fitted {
            guard let image = fine.buffer[k], shift[k] != .zero || turn[k] != .zero else { continue }
            let start = Pose(position: base[k].position, right: base[k].right, up: base[k].up, back: base[k].back)
            let moved = cost(k, image, poses[k], shift[k], turn[k], gain[k], offset[k])
            let stayed = cost(k, image, start, .zero, .zero, gain[k], offset[k])
            if moved > 0.97 * stayed {
                poses[k] = start
                shift[k] = .zero
                turn[k] = .zero
            }
        }
        result.errorAfter = consensus(fine, poses, gain, offset)
        // If the photos don't end up agreeing clearly better, they stay where they were.
        guard result.errorAfter < 0.98 * result.errorBefore else {
            return Result(errorBefore: result.errorBefore, errorAfter: result.errorBefore, gains: gain, offsets: offset)
        }

        // The refined poses become the photos' frames.
        for k in fitted {
            let p = poses[k]
            var frame = base[k].frame
            frame.transform = Transform(columnMajor: [
                p.right.x, p.right.y, p.right.z, 0, p.up.x, p.up.y, p.up.z, 0, p.back.x, p.back.y, p.back.z, 0, p.position.x, p.position.y, p.position.z, 1,
            ])
            guard var moved = PhotoCamera(frame, depthWidth: base[k].depthWidth) else { continue }
            moved.mask = base[k].mask
            cams[k] = moved
            result.aligned += 1
            result.meanShift += Double(vlength(shift[k]))
            result.meanTurn += Double(vlength(turn[k]))
        }
        if result.aligned > 0 {
            result.meanShift /= Double(result.aligned)
            result.meanTurn /= Double(result.aligned)
        }
        result.gains = gain
        result.offsets = offset
        return result
    }

    /// How a quantity that changes by (`du`, `dv`) per pixel of the photo changes when the camera at
    /// `pose` moves (per meter) and turns (per radian, about its center) while looking at `point`.
    @inline(__always) static func gradient(du: Float, dv: Float, camera c: PhotoCamera, pose: Pose, point: Vec3) -> (shift: Vec3, turn: Vec3) {
        let d = point - pose.position
        let z = -vdot(d, pose.back), x = vdot(d, pose.right), y = vdot(d, pose.up)
        // u = fx x / z + cx, v = −fy y / z + cy, z = −(d · back).
        let jx = du * c.fx / z, jy = -dv * c.fy / z
        let jz = (du * c.fx * x - dv * c.fy * y) / (z * z)
        // As a world vector a (the change per meter the point moves relative to the camera):
        // moving the camera by t moves the point by −t; turning it by w moves the point by d × w,
        // and a · (d × w) = w · (a × d).
        let a = pose.right * jx + pose.up * jy + pose.back * jz
        return (-a, vcross(a, d))
    }

    /// Solves the 8 × 8 symmetric positive-definite system A x = b (Cholesky); nil if it isn't.
    static func solve8(_ A: [Double], _ b: [Double]) -> [Double]? {
        var L = [Double](repeating: 0, count: 64)
        for i in 0..<8 {
            for j in 0...i {
                var sum = A[i * 8 + j]
                for k in 0..<j { sum -= L[i * 8 + k] * L[j * 8 + k] }
                if i == j {
                    guard sum > 1e-12 else { return nil }
                    L[i * 8 + i] = sum.squareRoot()
                } else {
                    L[i * 8 + j] = sum / L[j * 8 + j]
                }
            }
        }
        var y = [Double](repeating: 0, count: 8), x = [Double](repeating: 0, count: 8)
        for i in 0..<8 {
            var sum = b[i]
            for k in 0..<i { sum -= L[i * 8 + k] * y[k] }
            y[i] = sum / L[i * 8 + i]
        }
        for i in stride(from: 7, through: 0, by: -1) {
            var sum = y[i]
            for k in (i + 1)..<8 { sum -= L[k * 8 + i] * x[k] }
            x[i] = sum / L[i * 8 + i]
        }
        return x
    }
}
