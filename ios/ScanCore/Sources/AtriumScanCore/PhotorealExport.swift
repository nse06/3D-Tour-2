import Foundation

/// What a cloud GPU needs to turn a photo scan into a photoreal walkthrough (Gaussian splats, see
/// docs/photoreal.md), written next to the scan when it is built:
///
/// * `cameras.json` — every photo's camera as painted (after the photos were lined up with each
///   other), in the walkthrough model's own frame, so the splats land exactly where the model is:
///   pose as a camera-to-world matrix (ARKit's camera: x right, y up, looking along −z), intrinsics
///   at the saved photo's size, plus the rooms (bounds, floor outlines) to keep the splats inside.
/// * `seeds.ply` — points on the painted model's surfaces in their painted colors, a few centimeters
///   apart: where the splats start from (binary little-endian PLY: float x y z nx ny nz, uchar red
///   green blue).
public struct PhotorealExport: Sendable {
    public var cameras: Data
    public var seeds: Data
    public var seedCount: Int
    public var seedSpacing: Double

    public static let format = "atrium-photoreal/1"
    /// Seeds are this far apart, or farther in big homes (at most `maxSeeds` of them).
    public static let spacing = 0.03
    public static let maxSeeds = 600_000

    /// - Parameters:
    ///   - frames: the photos' frames as given to the painting, and `poses` their poses as painted.
    ///   - model: the painted model; `atlases` its textures (`atlasSize` square) and `seen` which of
    ///     each chart's texels a photo saw.
    static func make(
        frames: [CameraFrame], poses: [Transform], rooms: [RoomInfo], model: PhotoModel, atlases: [RGBImage], seen: [[Bool]], atlasSize: Int
    ) throws -> PhotorealExport {
        var cameras: [[String: Any]] = []
        for (frame, pose) in zip(frames, poses) {
            guard let camera = PhotoCamera(frame, depthWidth: 1) else { continue }
            var entry: [String: Any] = [
                "file": frame.file, "width": frame.imageWidth, "height": frame.imageHeight,
                "fx": Double(camera.fx), "fy": Double(camera.fy), "cx": Double(camera.cx), "cy": Double(camera.cy),
                "pose": pose.m.map(Double.init), "t": frame.t,
            ]
            if let rate = frame.angularSpeed, rate.isFinite { entry["turnRate"] = Double(rate) }
            if let exposure = frame.exposureDuration, exposure.isFinite { entry["exposure"] = exposure }
            cameras.append(entry)
        }

        var lo = Vec3(repeating: .infinity), hi = Vec3(repeating: -.infinity)
        var roomList: [[String: Any]] = []
        for r in rooms {
            for p in r.poly {
                lo = pointwiseMin(lo, Vec3(Float(p.x), Float(r.floorY), Float(p.y)))
                hi = pointwiseMax(hi, Vec3(Float(p.x), Float(r.ceilingY), Float(p.y)))
            }
            roomList.append([
                "name": r.room.name, "floorY": r.floorY, "ceilingY": r.ceilingY, "polygon": r.poly.map { [$0.x, $0.y] },
            ])
        }

        let (seeds, count, spacing) = seedPoints(model: model, atlases: atlases, seen: seen, atlasSize: atlasSize)
        var doc: [String: Any] = [
            "format": format,
            "convention": "pose: camera-to-world 4x4, column-major; camera x right, y up, looking along -z (ARKit); meters, y up, the walkthrough model's frame",
            "frames": cameras, "rooms": roomList,
            "seeds": ["file": "seeds.ply", "count": count, "spacing": spacing],
        ]
        if lo.x.isFinite, hi.x.isFinite { doc["bounds"] = ["min": [lo.x, lo.y, lo.z].map(Double.init), "max": [hi.x, hi.y, hi.z].map(Double.init)] }
        let json = try JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys])
        return PhotorealExport(cameras: json, seeds: seeds, seedCount: count, seedSpacing: spacing)
    }

    /// Points spread evenly over the painted surfaces a photo saw (stratified per triangle, a fixed
    /// sequence so the same scan gives the same seeds), in their painted colors. Wall backs, tops and
    /// ends (one flat color) and whatever no photo saw are left out: nothing to learn there.
    static func seedPoints(model: PhotoModel, atlases: [RGBImage], seen: [[Bool]], atlasSize: Int) -> (Data, Int, Double) {
        let charts = model.charts.indices.filter { ci in
            !model.charts[ci].isSolid && ci < seen.count && model.charts[ci].atlas < atlases.count && model.mesh.buffers[PhotoModel.chartMaterial(ci)] != nil
        }
        var area = 0.0
        for ci in charts {
            let b = model.mesh.buffers[PhotoModel.chartMaterial(ci)]!
            let share = Double(seen[ci].lazy.filter { $0 }.count) / Double(max(1, seen[ci].count))
            var chartArea = 0.0
            for t in stride(from: 0, to: b.indices.count, by: 3) { chartArea += Double(triangleArea(b, t)) }
            // The chart's rectangle includes padding and holes; its faces are about this much seen.
            area += chartArea * min(1, share * 1.3)
        }
        let spacing = max(Self.spacing, (area / Double(Self.maxSeeds)).squareRoot())
        let density = 1 / (spacing * spacing)

        var body = Data()
        body.reserveCapacity(min(Self.maxSeeds, Int(area * density) + 16) * 27)
        var count = 0
        var carry = 0.0
        var sequence = 0
        for ci in charts {
            let chart = model.charts[ci], b = model.mesh.buffers[PhotoModel.chartMaterial(ci)]!
            let atlas = atlases[chart.atlas], mask = seen[ci]
            for t in stride(from: 0, to: b.indices.count, by: 3) {
                carry += Double(triangleArea(b, t)) * density
                let n = Int(carry)
                guard n > 0 else { continue }
                carry -= Double(n)
                let i0 = Int(b.indices[t]), i1 = Int(b.indices[t + 1]), i2 = Int(b.indices[t + 2])
                let p0 = position(b, i0), p1 = position(b, i1), p2 = position(b, i2)
                let m0 = uv(b, i0), m1 = uv(b, i1), m2 = uv(b, i2)
                let normal = vnormalize(vcross(p1 - p0, p2 - p0))
                for _ in 0..<n {
                    // R2 low-discrepancy sequence, folded into the triangle.
                    sequence += 1
                    var r1 = Float((Double(sequence) * 0.7548776662466927).truncatingRemainder(dividingBy: 1))
                    var r2 = Float((Double(sequence) * 0.5698402909980532).truncatingRemainder(dividingBy: 1))
                    if r1 + r2 > 1 { (r1, r2) = (1 - r1, 1 - r2) }
                    // Chart meters: the texel (did a photo see it?) and its place in the atlas.
                    let m = m0 + (m1 - m0) * r1 + (m2 - m0) * r2
                    let i = Int((Double(m.x) - chart.minU) / chart.texel) + PhotoChart.pad
                    let j = Int((Double(m.y) - chart.minV) / chart.texel) + PhotoChart.pad
                    guard i >= 0, i < chart.w, j >= 0, j < chart.h, mask[j * chart.w + i] else { continue }
                    let a = chart.atlasUV(m, size: atlasSize)
                    let x = min(atlas.width - 1, max(0, Int(a.x * Float(atlas.width)))), y = min(atlas.height - 1, max(0, Int(a.y * Float(atlas.height))))
                    let k = (y * atlas.width + x) * 3
                    let p = p0 + (p1 - p0) * r1 + (p2 - p0) * r2
                    appendFloats(&body, [p.x, p.y, p.z, normal.x, normal.y, normal.z])
                    body.append(contentsOf: [atlas.pixels[k], atlas.pixels[k + 1], atlas.pixels[k + 2]])
                    count += 1
                }
            }
        }
        let header = """
            ply
            format binary_little_endian 1.0
            comment Atrium photoreal seeds: points on the painted model, in its frame
            element vertex \(count)
            property float x
            property float y
            property float z
            property float nx
            property float ny
            property float nz
            property uchar red
            property uchar green
            property uchar blue
            end_header

            """
        var out = Data(header.utf8)
        out.append(body)
        return (out, count, spacing)
    }

    static func position(_ b: MeshBuffer, _ i: Int) -> Vec3 { Vec3(b.positions[i * 3], b.positions[i * 3 + 1], b.positions[i * 3 + 2]) }
    static func uv(_ b: MeshBuffer, _ i: Int) -> SIMD2<Float> { SIMD2(b.uvs[i * 2], b.uvs[i * 2 + 1]) }
    static func triangleArea(_ b: MeshBuffer, _ t: Int) -> Float {
        let p0 = position(b, Int(b.indices[t])), p1 = position(b, Int(b.indices[t + 1])), p2 = position(b, Int(b.indices[t + 2]))
        return vlength(vcross(p1 - p0, p2 - p0)) / 2
    }

    static func appendFloats(_ data: inout Data, _ values: [Float]) {
        for v in values { withUnsafeBytes(of: v.bitPattern.littleEndian) { data.append(contentsOf: $0) } }
    }
}

extension PhotoMask {
    /// The mask as a PNG (white where the photo shows people), for the photoreal training to leave
    /// those pixels out.
    public func png() -> Data {
        let gray = pixels.map { $0 ? UInt8(255) : 0 }
        return PNG.encode(RGBImage(width: width, height: height, pixels: gray.flatMap { [$0, $0, $0] }))
    }
}
