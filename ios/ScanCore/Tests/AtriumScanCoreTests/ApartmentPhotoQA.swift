import Foundation
import XCTest

@testable import AtriumScanCore

/// Visual check on demand: the synthetic apartment photographed by ray casting its own
/// photo-mode mesh, baked, and written out for viewing. Skipped unless
/// ATRIUM_TEST_ARTIFACTS names a folder:
///
///     ATRIUM_TEST_ARTIFACTS=/tmp/out swift test -c release --filter ApartmentPhotoQA
final class ApartmentPhotoQA: XCTestCase {
    struct MeshRaycast: PhotoSource {
        let tris: [(Vec3, Vec3, Vec3, Bool)]  // world triangle, is furniture
        let poses: [String: Transform]

        func image(for frame: CameraFrame) -> RGBImage? {
            guard let t = poses[frame.file] else { return nil }
            let w = frame.imageWidth, h = frame.imageHeight, k = frame.intrinsics
            var px = [UInt8](repeating: 0, count: w * h * 3)
            let sx = Float(w) / Float(frame.width), sy = Float(h) / Float(frame.height)
            for v in 0..<h {
                for u in 0..<w {
                    let dc = Vec3((Float(u) + 0.5 - k[6] * sx) / (k[0] * sx), -(Float(v) + 0.5 - k[7] * sy) / (k[4] * sy), -1)
                    let d = vnormalize(t.applyDirection(dc)), o = t.translation
                    var best = Float.infinity, furniture = false
                    for (a, b, c, f) in tris {
                        let e1 = b - a, e2 = c - a, p = vcross(d, e2), det = vdot(e1, p)
                        if abs(det) < 1e-9 { continue }
                        let inv = 1 / det, s = o - a, uu = vdot(s, p) * inv
                        if uu < 0 || uu > 1 { continue }
                        let q = vcross(s, e1), vv = vdot(d, q) * inv
                        if vv < 0 || uu + vv > 1 { continue }
                        let tt = vdot(e2, q) * inv
                        if tt > 1e-3 && tt < best { best = tt; furniture = f }
                    }
                    let i = (v * w + u) * 3
                    guard best.isFinite else { continue }
                    let p = o + d * best
                    let c = furniture ? (230, 120, 40) : PhotoTexturingTests.color(at: p)
                    px[i] = UInt8(clamp(Float(c.0), 0, 255)); px[i + 1] = UInt8(clamp(Float(c.1), 0, 255)); px[i + 2] = UInt8(clamp(Float(c.2), 0, 255))
                }
            }
            return RGBImage(width: w, height: h, pixels: px)
        }
    }

    func testApartment() throws {
        guard let out = ProcessInfo.processInfo.environment["ATRIUM_TEST_ARTIFACTS"] else { return }
        var scan = SyntheticApartment.make()
        let rooms = Layout.rooms(from: scan)
        var walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        Layout.cutOpenings(scan.openings, into: &walls)
        let model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        var tris: [(Vec3, Vec3, Vec3, Bool)] = []
        let objectCharts = Set(model.charts.indices.filter { model.charts[$0].fallback == PhotoModel.objectColor }.map(PhotoModel.chartMaterial))
        for key in model.mesh.order {
            let b = model.mesh.buffers[key]!
            func v(_ i: UInt32) -> Vec3 { Vec3(b.positions[Int(i) * 3], b.positions[Int(i) * 3 + 1], b.positions[Int(i) * 3 + 2]) }
            for t in stride(from: 0, to: b.indices.count, by: 3) { tris.append((v(b.indices[t]), v(b.indices[t + 1]), v(b.indices[t + 2]), objectCharts.contains(key))) }
        }
        var frames: [CameraFrame] = []
        var last = -10.0
        for s in scan.trajectory where s.t - last >= 0.75 {
            last = s.t
            // Look ahead, alternating slightly up and down like a scan.
            let pitch: Float = frames.count % 3 == 0 ? -0.5 : (frames.count % 3 == 1 ? 0.0 : 0.45)
            let f0 = vnormalize(Vec3(s.f.x, 0, s.f.z))
            let f = vnormalize(f0 * cos(pitch) + Vec3(0, sin(pitch), 0))
            let right = vnormalize(vcross(f, Vec3(0, 1, 0))), up = vcross(right, f), back = -f
            let t = Transform(columnMajor: [right.x, right.y, right.z, 0, up.x, up.y, up.z, 0, back.x, back.y, back.z, 0, s.p.x, s.p.y, s.p.z, 1])
            frames.append(CameraFrame(file: "f\(frames.count).jpg", t: s.t, transform: t, intrinsics: [1340, 0, 0, 0, 1340, 0, 960, 720, 1], width: 1920, height: 1440, imageWidth: 240, imageHeight: 180))
        }
        scan.frames = frames
        let source = MeshRaycast(tris: tris, poses: Dictionary(uniqueKeysWithValues: frames.map { ($0.file, $0.transform) }))
        let start = Date()
        let processed = try ScanProcessor.process(scan, photos: source, photoOptions: PhotoTexturingOptions(atlasSize: 2048, maxAtlases: 3, texelSize: 0.015))
        print(String(format: "QA frames %d · %.1f s · coverage %.2f", frames.count, Date().timeIntervalSince(start), processed.stats.photoCoverage ?? -1))
        try processed.glb.write(to: URL(fileURLWithPath: out).appendingPathComponent("apartment-photo.glb"))
        try processed.manifest.jsonData(prettyPrinted: true).write(to: URL(fileURLWithPath: out).appendingPathComponent("apartment-photo.manifest.json"))
    }
}
