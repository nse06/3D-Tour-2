import Foundation
import XCTest

@testable import AtriumScanCore

/// Photos synthesized by ray casting a box room whose surfaces are colored by
/// position, with a magenta cabinet in one corner. Baked textures must
/// reproduce the pattern, and the cabinet must not leak onto the wall behind it.
final class PhotoTexturingTests: XCTestCase {
    static let size = (x: Float(4), y: Float(2.5), z: Float(3))
    static let cabinet = (lo: Vec3(2.9, 0, 0.05), hi: Vec3(3.9, 1.1, 0.6))

    /// The pattern every surface is painted with.
    static func color(at p: Vec3) -> (Float, Float, Float) {
        (128 + 90 * sin(2 * .pi * p.x / 1.3), 128 + 90 * sin(2 * .pi * p.z / 1.1), 128 + 90 * sin(2 * .pi * p.y / 0.9))
    }

    static let magenta: (Float, Float, Float) = (255, 0, 255)

    /// Renders the photo a frame names, from the pose it was taken at (like the app reading
    /// the JPEG: ScanProcessor may hand over the frame moved into its normalized frame).
    struct Raycast: PhotoSource {
        let poses = Dictionary(uniqueKeysWithValues: PhotoTexturingTests.frames().map { ($0.file, $0.transform) })

        func image(for frame: CameraFrame) -> RGBImage? {
            let w = frame.imageWidth, h = frame.imageHeight
            let k = frame.intrinsics
            guard let t = poses[frame.file] else { return nil }
            var pixels = [UInt8](repeating: 0, count: w * h * 3)
            for v in 0..<h {
                for u in 0..<w {
                    let dc = Vec3((Float(u) + 0.5 - k[6]) / k[0], -(Float(v) + 0.5 - k[7]) / k[4], -1)
                    let d = vnormalize(t.applyDirection(dc))
                    let (r, g, b) = PhotoTexturingTests.trace(from: t.translation, d)
                    let i = (v * w + u) * 3
                    pixels[i] = UInt8(clamp(r, 0, 255))
                    pixels[i + 1] = UInt8(clamp(g, 0, 255))
                    pixels[i + 2] = UInt8(clamp(b, 0, 255))
                }
            }
            return RGBImage(width: w, height: h, pixels: pixels)
        }
    }

    static func trace(from o: Vec3, _ d: Vec3) -> (Float, Float, Float) {
        // The cabinet (slab test) first, then the room's six planes from the inside.
        var tNear: Float = -.infinity, tFar: Float = .infinity
        for axis in 0..<3 {
            let lo = cabinet.lo[axis], hi = cabinet.hi[axis]
            if abs(d[axis]) < 1e-9 {
                if o[axis] < lo || o[axis] > hi { tNear = .infinity }
                continue
            }
            var t0 = (lo - o[axis]) / d[axis], t1 = (hi - o[axis]) / d[axis]
            if t0 > t1 { swap(&t0, &t1) }
            tNear = max(tNear, t0)
            tFar = min(tFar, t1)
        }
        let cabinetHit: Float? = tNear <= tFar && tNear > 0 ? tNear : nil
        var best = Float.infinity
        let bounds: [(Int, Float)] = [(0, 0), (0, size.x), (1, 0), (1, size.y), (2, 0), (2, size.z)]
        for (axis, value) in bounds where abs(d[axis]) > 1e-9 {
            let t = (value - o[axis]) / d[axis]
            if t > 1e-4 && t < best { best = t }
        }
        if let c = cabinetHit, c < best { return magenta }
        return color(at: o + d * best)
    }

    static func room() -> CaptureScan {
        let id = "R0000000-0000-4000-8000-000000000001"
        let s = size
        let corners: [(Double, Double)] = [(0, 0), (Double(s.x), 0), (Double(s.x), Double(s.z)), (0, Double(s.z))]
        var walls: [ScanWall] = []
        for k in 0..<4 {
            let a = corners[k], b = corners[(k + 1) % 4]
            walls.append(
                ScanWall(
                    id: "W\(k)", roomId: id, transform: SyntheticApartment.surfaceTransform(from: a, to: b, centerY: Double(s.y) / 2, flip: k % 2 == 1),
                    width: Float(SyntheticApartment.dist(a, b)), height: s.y))
        }
        let c = cabinet
        let object = ScanObject(id: "O1", roomId: id, category: "storage", transform: Transform.translating((c.lo + c.hi) / 2), size: c.hi - c.lo)
        let room = ScanRoom(
            id: id, name: "Living Room", captureIndex: 0, floorPolygon: corners.map { Vec3(Float($0.0), 0, Float($0.1)) }, floorY: 0, ceilingY: s.y)
        return CaptureScan(rooms: [room], walls: walls, objects: [object])
    }

    /// Photos from the middle of the room, all the way round, slightly down and slightly up.
    static func frames() -> [CameraFrame] {
        var out: [CameraFrame] = []
        for (n, pitch) in [Float(-0.45), 0.25].enumerated() {
            for k in 0..<12 {
                let yaw = Float(k) * .pi / 6
                // ARKit camera: looks along −Z; turn about Y, then tilt about the camera's X.
                let turn = Transform.rotationY(yaw)
                let c = cos(pitch), s = sin(pitch)
                let tilt = Transform(columnMajor: [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1])
                let pose = Transform.translating(Vec3(1.7, 1.45, 1.6)) * turn * tilt
                out.append(
                    CameraFrame(
                        file: "frames/\(n)-\(k).jpg", t: Double(out.count), transform: pose, intrinsics: [230, 0, 0, 0, 230, 0, 160, 120, 1], width: 320,
                        height: 240, imageWidth: 320, imageHeight: 240))
            }
        }
        return out
    }

    func testBakedTexturesReproduceThePhotos() throws {
        var scan = Self.room()
        scan.frames = Self.frames()
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        model.measureCharts()
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.02, depthWidth: 160)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: Raycast(), atlasCount: atlases, options: options)
        // The floor right under the camera and the far side of the cabinet are never photographed.
        XCTAssertGreaterThan(baked.coverage, 0.7)
        XCTAssertEqual(baked.photosUsed, cameras.count)

        // Every texel well inside a chart matches the pattern at its world position (cabinet faces: magenta).
        var errors: [Float] = []
        var leaks = 0, behindCabinet = 0
        for (ci, chart) in model.charts.enumerated() where chart.w > 2 * PhotoChart.pad + 4 && chart.h > 2 * PhotoChart.pad + 4 {
            let isCabinet = chart.fallback == PhotoModel.objectColor
            for j in (PhotoChart.pad + 2)..<(chart.h - PhotoChart.pad - 2) {
                for i in (PhotoChart.pad + 2)..<(chart.w - PhotoChart.pad - 2) {
                    let p = chart.point(i, j)
                    let a = ((chart.y + j) * options.atlasSize + chart.x + i) * 3
                    let got = (Float(baked.atlases[chart.atlas].pixels[a]), Float(baked.atlases[chart.atlas].pixels[a + 1]), Float(baked.atlases[chart.atlas].pixels[a + 2]))
                    let want = isCabinet ? Self.magenta : Self.color(at: p)
                    // The wall right behind the cabinet is never seen; it must not take the cabinet's color.
                    let hidden = !isCabinet && p.z < 0.02 && p.x > Self.cabinet.lo.x + 0.05 && p.x < Self.cabinet.hi.x - 0.05 && p.y < Self.cabinet.hi.y - 0.05
                    if hidden {
                        behindCabinet += 1
                        if got.0 > 200 && got.1 < 60 && got.2 > 200 { leaks += 1 }
                        continue
                    }
                    // Skip the cabinet's own outline on the floor and wall (one-texel seams).
                    let nearCabinet = p.x > Self.cabinet.lo.x - 0.06 && p.x < Self.cabinet.hi.x + 0.06 && p.z < Self.cabinet.hi.z + 0.06 && p.y < Self.cabinet.hi.y + 0.06
                    if nearCabinet && !isCabinet { continue }
                    guard baked.seen[ci][j * chart.w + i] else { continue }
                    errors.append(max(abs(got.0 - want.0), abs(got.1 - want.1), abs(got.2 - want.2)))
                }
            }
        }
        errors.sort()
        let median = errors[errors.count / 2], p95 = errors[errors.count * 95 / 100]
        XCTAssertLessThan(median, 6, "median error \(median)")
        XCTAssertLessThan(p95, 30, "95th percentile error \(p95)")
        XCTAssertGreaterThan(behindCabinet, 50)
        XCTAssertEqual(leaks, 0, "\(leaks) of \(behindCabinet) hidden wall texels took the cabinet's color")
    }

    func testPhotoTexturedModelIsUnlitAndAsksForTheCapturedLook() throws {
        var scan = Self.room()
        scan.frames = Self.frames()
        let processed = try ScanProcessor.process(
            scan, options: ScanProcessorOptions(normalizeFrame: true), photos: Raycast(),
            photoOptions: PhotoTexturingOptions(atlasSize: 512, maxAtlases: 2, texelSize: 0.03, depthWidth: 96))
        if let dir = ProcessInfo.processInfo.environment["ATRIUM_TEST_ARTIFACTS"] {
            try processed.glb.write(to: URL(fileURLWithPath: dir).appendingPathComponent("photo-room.glb"))
        }
        XCTAssertEqual(processed.manifest.appearance, "captured")
        XCTAssertGreaterThan(processed.stats.photoCoverage ?? 0, 0.7)
        let gltf = try glbJSON(processed.glb)
        let materials = try XCTUnwrap(gltf["materials"] as? [[String: Any]])
        XCTAssertTrue(materials.allSatisfy { (($0["extensions"] as? [String: Any])?["KHR_materials_unlit"]) != nil })
        XCTAssertTrue((gltf["extensionsUsed"] as? [String])?.contains("KHR_materials_unlit") == true)
        XCTAssertNil((gltf["extensions"] as? [String: Any])?["KHR_lights_punctual"], "photo models carry no lights")
        let images = try XCTUnwrap(gltf["images"] as? [[String: Any]])
        XCTAssertFalse(images.isEmpty)
        let samplers = try XCTUnwrap(gltf["samplers"] as? [[String: Any]])
        let textures = try XCTUnwrap(gltf["textures"] as? [[String: Any]])
        // Photo atlases are clamped, not repeated.
        for t in textures { XCTAssertEqual(samplers[t["sampler"] as! Int]["wrapS"] as? Int, 33071) }

        // Without photos, the same scan still builds the styled model.
        let styled = try ScanProcessor.process(Self.room(), options: ScanProcessorOptions(textureSize: 32))
        XCTAssertNil(styled.manifest.appearance)
        XCTAssertNil(styled.stats.photoCoverage)
    }

    func testDoorsBetweenRoomsAreHolesButOthersStayOnTheWall() {
        let scan = SyntheticApartment.make()
        let rooms = Layout.rooms(from: scan)
        let passages = scan.openings.filter { PhotoModel.isPassage($0, rooms: rooms) }
        // Living ↔ hallway, hallway ↔ bedroom, hallway ↔ primary (both sides each), the living/kitchen opening,
        // and the bathroom door; not the front door, not windows.
        XCTAssertTrue(passages.allSatisfy { $0.kind != .window })
        XCTAssertEqual(passages.filter { $0.kind == .opening }.count, 1)
        let frontDoor = scan.openings.filter { $0.kind == .door && !PhotoModel.isPassage($0, rooms: rooms) }
        XCTAssertEqual(frontDoor.count, 1)
    }

    func glbJSON(_ glb: Data) throws -> [String: Any] {
        let length = glb.subdata(in: 12..<16).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        let json = glb.subdata(in: 20..<(20 + Int(length)))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: json) as? [String: Any])
    }
}
