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
        var poses = Dictionary(uniqueKeysWithValues: PhotoTexturingTests.frames().map { ($0.file, $0.transform) })
        /// Auto-exposure: each photo comes out up to this much brighter or darker.
        var exposureSpread: Float = 0
        /// Each photo's colors shifted by up to this many levels per channel.
        var offsetSpread: Float = 0
        /// A glossy floor: in each photo the floor looks up to this many levels brighter or darker
        /// (what no per-photo gain fixes, since the walls in the same photo don't change).
        var floorGlare: Float = 0
        /// Plain painted surfaces instead of the pattern.
        var plain = false
        static let paint: (Float, Float, Float) = (186, 176, 162)

        static func hash(_ file: String, _ salt: UInt32) -> Float {
            let h = file.unicodeScalars.reduce(UInt32(2166136261) ^ salt) { ($0 ^ $1.value) &* 16777619 }
            return Float(h % 1000) / 500 - 1
        }

        func exposure(_ file: String) -> Float { 1 + exposureSpread * Self.hash(file, 0) }

        func offset(_ file: String) -> (Float, Float, Float) {
            (offsetSpread * Self.hash(file, 11), offsetSpread * Self.hash(file, 23), offsetSpread * Self.hash(file, 37))
        }

        func image(for frame: CameraFrame) -> RGBImage? {
            let w = frame.imageWidth, h = frame.imageHeight
            let k = frame.intrinsics
            guard let t = poses[frame.file] else { return nil }
            var pixels = [UInt8](repeating: 0, count: w * h * 3)
            for v in 0..<h {
                for u in 0..<w {
                    let dc = Vec3((Float(u) + 0.5 - k[6]) / k[0], -(Float(v) + 0.5 - k[7]) / k[4], -1)
                    let d = vnormalize(t.applyDirection(dc))
                    let hit = PhotoTexturingTests.hit(from: t.translation, d)
                    var (r, g, b) = hit.cabinet ? PhotoTexturingTests.magenta : plain ? Self.paint : PhotoTexturingTests.color(at: hit.point)
                    let e = exposure(frame.file), o = offset(frame.file)
                    let glare = !hit.cabinet && hit.point.y < 0.001 ? floorGlare * Self.hash(frame.file, 51) : 0
                    (r, g, b) = (r * e + o.0 + glare, g * e + o.1 + glare, b * e + o.2 + glare)
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
        let h = hit(from: o, d)
        return h.cabinet ? magenta : color(at: h.point)
    }

    /// Where a ray from inside the room lands, and whether that's the cabinet.
    static func hit(from o: Vec3, _ d: Vec3) -> (point: Vec3, cabinet: Bool) {
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
        if let c = cabinetHit, c < best { return (o + d * c, true) }
        return (o + d * best, false)
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
        // Each patch of a surface comes from one photo; only the seams between patches mix photos.
        XCTAssertLessThan(baked.blended, 0.2)

        // Every texel well inside a chart matches the pattern at its world position (cabinet faces: magenta).
        var errors: [Float] = []
        var leaks = 0, behindCabinet = 0
        for (ci, chart) in model.charts.enumerated() where !chart.isSolid && chart.w > 2 * PhotoChart.pad + 4 && chart.h > 2 * PhotoChart.pad + 4 {
            let isCabinet = chart.kind == .object
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

    func testExposureDifferencesBetweenPhotosAreEvenedOut() throws {
        var scan = Self.room()
        scan.frames = Self.frames()
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        model.measureCharts()
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.02, depthWidth: 160)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        let source = Raycast(exposureSpread: 0.2)
        let spread = Set(scan.frames.map { (source.exposure($0.file) * 100).rounded() })
        XCTAssertGreaterThan(spread.count, 8, "photos should differ in exposure")
        let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: source, atlasCount: atlases, options: options)

        // After one overall brightness factor, the surfaces match the pattern again.
        var pairs: [(got: Float, want: Float)] = []
        for (ci, chart) in model.charts.enumerated() where chart.kind != .object && !chart.isSolid && chart.w > 2 * PhotoChart.pad + 4 && chart.h > 2 * PhotoChart.pad + 4 {
            for j in (PhotoChart.pad + 2)..<(chart.h - PhotoChart.pad - 2) {
                for i in (PhotoChart.pad + 2)..<(chart.w - PhotoChart.pad - 2) where baked.seen[ci][j * chart.w + i] {
                    let p = chart.point(i, j)
                    let near = p.x > Self.cabinet.lo.x - 0.06 && p.x < Self.cabinet.hi.x + 0.06 && p.z < Self.cabinet.hi.z + 0.06 && p.y < Self.cabinet.hi.y + 0.06
                    if near { continue }
                    let a = ((chart.y + j) * options.atlasSize + chart.x + i) * 3
                    let want = Self.color(at: p)
                    pairs.append((Float(baked.atlases[chart.atlas].pixels[a]), want.0))
                    pairs.append((Float(baked.atlases[chart.atlas].pixels[a + 1]), want.1))
                    pairs.append((Float(baked.atlases[chart.atlas].pixels[a + 2]), want.2))
                }
            }
        }
        let ratios = pairs.filter { $0.want > 60 && $0.want < 200 }.map { $0.got / $0.want }.sorted()
        let scale = ratios[ratios.count / 2]
        var errors = pairs.map { abs($0.got - $0.want * scale) }
        errors.sort()
        let median = errors[errors.count / 2], p95 = errors[errors.count * 95 / 100]
        // Without matching: median ≈ 5.5, 95th percentile ≈ 23.
        XCTAssertLessThan(median, 2, "median error \(median) after scale \(scale)")
        XCTAssertLessThan(p95, 6, "95th percentile error \(p95) after scale \(scale)")
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

        // The "photos off" view comes along: the styled model of the same rooms, lit and not unlit.
        let clean = try glbJSON(try XCTUnwrap(processed.cleanGLB, "a clean model next to the photo model"))
        XCTAssertNotNil((clean["extensions"] as? [String: Any])?["KHR_lights_punctual"])
        XCTAssertFalse(((clean["materials"] as? [[String: Any]]) ?? []).contains { (($0["extensions"] as? [String: Any])?["KHR_materials_unlit"]) != nil })
        let cleanAtrium = (((clean["scenes"] as? [[String: Any]])?.first?["extras"] as? [String: Any])?["atrium"] as? [String: Any])
        XCTAssertEqual((cleanAtrium?["rooms"] as? [Any])?.count, processed.manifest.rooms.count)
        XCTAssertNil(cleanAtrium?["appearance"])

        // Without photos, the same scan still builds the styled model.
        let styled = try ScanProcessor.process(Self.room(), options: ScanProcessorOptions(textureSize: 32))
        XCTAssertNil(styled.manifest.appearance)
        XCTAssertNil(styled.stats.photoCoverage)
        XCTAssertNil(styled.cleanGLB, "the styled model is already clean")
    }

    func testPatchesMeetWithoutASeam() throws {
        // A plain room with a glossy floor whose glare differs from photo to photo — what no
        // per-photo gain fixes, since the walls in the same photos don't change. Seam leveling makes
        // neighbouring patches agree, so no step shows where one photo hands over to the next.
        var scan = Self.room()
        scan.frames = Self.frames()
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        model.measureCharts()
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.02, depthWidth: 160)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        let source = Raycast(floorGlare: 15, plain: true)
        let pad = PhotoChart.pad
        /// The color change between horizontally neighbouring texels (none on a plain surface), and
        /// how far the texels stray from the surface's typical color.
        func measure(leveling: Bool) -> (steps: [Float], spread: Float) {
            let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: source, atlasCount: atlases, options: options, leveling: leveling)
            func pixel(_ c: PhotoChart, _ i: Int, _ j: Int) -> SIMD3<Float> {
                let a = ((c.y + j) * options.atlasSize + c.x + i) * 3, px = baked.atlases[c.atlas].pixels
                return SIMD3(Float(px[a]), Float(px[a + 1]), Float(px[a + 2]))
            }
            var steps: [Float] = [], levels: [Float] = []
            for (ci, chart) in model.charts.enumerated() where chart.kind == .floor {
                for j in (pad + 2)..<(chart.h - pad - 2) {
                    for i in (pad + 2)..<(chart.w - pad - 3) where baked.seen[ci][j * chart.w + i] && baked.seen[ci][j * chart.w + i + 1] {
                        let p = chart.point(i, j)
                        let near = p.x > Self.cabinet.lo.x - 0.1 && p.x < Self.cabinet.hi.x + 0.1 && p.z < Self.cabinet.hi.z + 0.1 && p.y < Self.cabinet.hi.y + 0.1
                        if near { continue }
                        let d = pixel(chart, i, j) - pixel(chart, i + 1, j)
                        steps.append(max(abs(d.x), abs(d.y), abs(d.z)))
                        levels.append(pixel(chart, i, j).y)
                    }
                }
            }
            levels.sort()
            return (steps.sorted(), levels[levels.count * 99 / 100] - levels[levels.count / 100])
        }
        let raw = measure(leveling: false), leveled = measure(leveling: true)
        func share(_ steps: [Float]) -> Double { Double(steps.filter { $0 > 1.5 }.count) / Double(steps.count) }
        // Measured: 2.9% of neighbouring texels step by more than 1.5 levels without leveling, ~0 with it.
        XCTAssertGreaterThan(share(raw.steps), 0.01, "the photos should disagree at the seams")
        XCTAssertLessThan(share(leveled.steps), share(raw.steps) / 4, "steps: \(share(raw.steps)) → \(share(leveled.steps))")
        XCTAssertLessThan(leveled.steps[leveled.steps.count * 999 / 1000], 2, "largest steps")
        XCTAssertLessThan(leveled.spread, raw.spread, "patches end up closer to one color")
    }

    func testCellsLeanTowardTheirNeighboursPhoto() {
        // Photo 1 is best on the left half, photo 2 on the right; one cell on the left prefers
        // photo 2 by a hair, and a strip down the middle flips between them.
        let w = 12, h = 6, k = 2
        var cameras = [UInt16](repeating: .max, count: w * h * k), scores = [Float](repeating: 0, count: w * h * k)
        for y in 0..<h {
            for x in 0..<w {
                var a: Float = x < 6 ? 1 : 0.9, b: Float = x < 6 ? 0.9 : 1
                if x == 2 && y == 3 { b = 1.05 }
                if x == 5 || x == 6 { (a, b) = (y % 2 == 0) ? (1, 0.97) : (0.97, 1) }
                let c = (y * w + x) * k
                (cameras[c], scores[c], cameras[c + 1], scores[c + 1]) = a >= b ? (1, a, 2, b) : (2, b, 1, a)
            }
        }
        let labels = PhotoBaker.smoothLabels(width: w, height: h, cameras: cameras, scores: scores, perCell: k)
        XCTAssertEqual(labels[3 * w + 2], 1, "the stray cell follows its neighbours")
        for y in 0..<h {
            XCTAssertEqual(labels[y * w], 1)
            XCTAssertEqual(labels[y * w + w - 1], 2)
            // Across the flickering strip: one boundary per row, not a checkerboard.
            let row = (0..<w).map { labels[y * w + $0] }
            XCTAssertEqual(zip(row, row.dropFirst()).filter { $0 != $1 }.count, 1, "row \(y): \(row)")
        }
    }

    func testSteadyPhotosWinOverBlurryOnes() throws {
        // Every photo twice from (almost) the same spot: once steady, once while the phone was turning.
        var scan = Self.room()
        var poses: [String: Transform] = [:]
        for f in Self.frames() {
            var steady = f
            steady.angularSpeed = 0.05
            steady.exposureDuration = 1.0 / 60
            var blurry = f
            blurry.file = f.file.replacingOccurrences(of: ".jpg", with: "-moving.jpg")
            blurry.transform = Transform.translating(f.transform.xAxis * 0.01) * f.transform
            blurry.angularSpeed = 1.2
            blurry.exposureDuration = 1.0 / 60
            scan.frames += [steady, blurry]
            poses[steady.file] = steady.transform
            poses[blurry.file] = blurry.transform
        }
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        model.measureCharts()
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.03, depthWidth: 96)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: Raycast(poses: poses), atlasCount: atlases, options: options)
        let moving = zip(scan.frames, baked.texelsPerPhoto).filter { $0.0.file.contains("moving") }.reduce(0) { $0 + $1.1 }
        let all = baked.texelsPerPhoto.reduce(0, +)
        XCTAssertGreaterThan(all, 1000)
        XCTAssertLessThan(Double(moving) / Double(all), 0.03, "\(moving) of \(all) texels came from blurry photos")
    }

    func testFurnitureIsPaintedInParts() {
        // A bed with a headboard: the duvet is painted at mattress height, not on top of a box as tall as the headboard.
        var scan = Self.room()
        scan.objects = [ScanObject(id: "B", roomId: scan.rooms[0].id, category: "bed", transform: Transform.translating(Vec3(2, 0.55, 1.2)), size: Vec3(1.6, 1.1, 2.0))]
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        let model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        let parts = model.charts.filter { $0.kind == .object }
        XCTAssertGreaterThanOrEqual(parts.count, 12, "base, mattress and headboard, each with its own faces")
        let tops = parts.filter { $0.normal.y > 0.9 }.map(\.origin.y).sorted()
        XCTAssertTrue(tops.contains { abs($0 - 0.54) < 0.02 }, "mattress top in \(tops)")
        XCTAssertTrue(tops.contains { abs($0 - 1.1) < 0.02 }, "headboard top in \(tops)")
        XCTAssertFalse(tops.contains { abs($0 - 0.66) < 0.02 }, "no made-up pillows: \(tops)")

        // A bed measured at mattress height has no headboard; its mattress fills the measured height.
        scan.objects[0].size = Vec3(1.6, 0.6, 2.0)
        scan.objects[0].transform = Transform.translating(Vec3(2, 0.3, 1.2))
        let low = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        let lowParts = low.charts.filter { $0.kind == .object }
        XCTAssertEqual(lowParts.filter { $0.normal.y > 0.9 }.map(\.origin.y).max() ?? 0, 0.6, accuracy: 0.005)
        XCTAssertLessThan(lowParts.count, parts.count, "no headboard")
    }

    func testWallEdgesTakeTheWallsColor() throws {
        var scan = Self.room()
        scan.frames = Self.frames()
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        XCTAssertTrue(model.mesh.order.allSatisfy { $0.hasPrefix("chart:") }, "every face is painted: \(model.mesh.order)")
        model.measureCharts()
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.03, depthWidth: 96)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: Raycast(), atlasCount: atlases, options: options)
        func pixel(_ c: PhotoChart, _ i: Int, _ j: Int) -> [Int] {
            let a = ((c.y + j) * options.atlasSize + c.x + i) * 3
            return (0..<3).map { Int(baked.atlases[c.atlas].pixels[a + $0]) }
        }
        let solids = model.charts.filter(\.isSolid)
        XCTAssertEqual(solids.count, 4)
        for edge in solids {
            guard case let .solid(of) = edge.kind else { continue }
            let wall = model.charts[of]
            // The median of what the photos saw on the wall's inside face.
            var channels: [[Int]] = [[], [], []]
            for j in 0..<wall.h {
                for i in 0..<wall.w where baked.seen[of][j * wall.w + i] {
                    let p = pixel(wall, i, j)
                    for k in 0..<3 { channels[k].append(p[k]) }
                }
            }
            let median = channels.map { $0.sorted()[($0.count - 1) / 2] }
            let center = pixel(edge, edge.w / 2, edge.h / 2)
            for k in 0..<3 { XCTAssertEqual(Double(center[k]), Double(median[k]), accuracy: 1.5, "edge \(center) vs wall \(median)") }
            XCTAssertNotEqual(center, [233, 229, 222])
            // One color across the whole square.
            XCTAssertEqual(pixel(edge, 0, 0), center)
            XCTAssertEqual(pixel(edge, edge.w - 1, edge.h - 1), center)
        }
    }

    func testWallsReachTheCeilingAndFloor() {
        // RoomPlan measured one wall 30 cm short of the ceiling and another 10 cm off the floor;
        // a half wall and a wall that stops well short stay as measured.
        let id = "R1"
        let corners: [(Double, Double)] = [(0, 0), (4, 0), (4, 3), (0, 3)]
        var walls: [ScanWall] = []
        let spans: [(Double, Double)] = [(0, 2.6), (0, 2.3), (0.1, 2.6), (0, 1.9)]
        for k in 0..<4 {
            let a = corners[k], b = corners[(k + 1) % 4], (y0, y1) = spans[k]
            walls.append(
                ScanWall(
                    id: "W\(k)", roomId: id, transform: SyntheticApartment.surfaceTransform(from: a, to: b, centerY: (y0 + y1) / 2, flip: false),
                    width: Float(SyntheticApartment.dist(a, b)), height: Float(y1 - y0)))
        }
        walls.append(
            ScanWall(
                id: "Half", roomId: id, transform: SyntheticApartment.surfaceTransform(from: (1, 1.5), to: (3, 1.5), centerY: 0.5, flip: false), width: 2,
                height: 1))
        let room = ScanRoom(id: id, name: "Kitchen", captureIndex: 0, floorPolygon: corners.map { Vec3(Float($0.0), 0, Float($0.1)) }, floorY: 0, ceilingY: 2.6)
        let scan = CaptureScan(rooms: [room], walls: walls)
        let rooms = Layout.rooms(from: scan)
        let info = Dictionary(uniqueKeysWithValues: Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12).map { ($0.id, $0) })
        XCTAssertEqual(info["W1"]!.y1, 2.6, accuracy: 1e-4)
        XCTAssertEqual(info["W2"]!.y0, 0, accuracy: 1e-4)
        XCTAssertEqual(info["W3"]!.y1, 1.9, accuracy: 1e-4)
        XCTAssertEqual(info["Half"]!.y1, 1, accuracy: 1e-4)
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
