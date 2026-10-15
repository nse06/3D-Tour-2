import Foundation
import XCTest

@testable import AtriumScanCore

/// Furniture and clutter in their real shapes, from the LiDAR mesh.
final class MeshShapesTests: XCTestCase {
    static let roomId = "R0000000-0000-4000-8000-000000000001"
    /// A round pouf standing in the test room.
    static let pouf = (center: Vec3(0.8, 0.45, 2.3), radius: Float(0.35))

    /// A UV sphere, faces wound counter-clockwise from outside, normals out.
    static func sphere(center: Vec3, radius: Float, slices: Int = 32, stacks: Int = 16) -> (vertices: [Vec3], normals: [Vec3], indices: [UInt32]) {
        var vertices: [Vec3] = [], normals: [Vec3] = [], indices: [UInt32] = []
        for i in 0...stacks {
            let phi = Float.pi * Float(i) / Float(stacks)
            for j in 0..<slices {
                let theta = 2 * Float.pi * Float(j) / Float(slices)
                let n = Vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta))
                vertices.append(center + n * radius)
                normals.append(n)
            }
        }
        for i in 0..<stacks {
            for j in 0..<slices {
                let a = UInt32(i * slices + j), b = UInt32(i * slices + (j + 1) % slices)
                let c = UInt32((i + 1) * slices + j), d = UInt32((i + 1) * slices + (j + 1) % slices)
                // Outward: (a, b, c) turns the right way round seen from outside.
                indices += [a, b, c, b, d, c]
            }
        }
        return (vertices, normals, indices)
    }

    /// A flat grid (wall, floor) as noisy triangles facing `normal`.
    static func grid(origin: Vec3, u: Vec3, v: Vec3, normal: Vec3, steps: Int, noise: Float, seed: UInt32) -> ScanMesh {
        var random = SeededRandom(seed: seed)
        var vertices: [Vec3] = [], indices: [UInt32] = []
        for j in 0...steps {
            for i in 0...steps {
                let jitter = normal * Float((random.next() - 0.5) * 2) * noise
                vertices.append(origin + u * (Float(i) / Float(steps)) + v * (Float(j) / Float(steps)) + jitter)
            }
        }
        for j in 0..<steps {
            for i in 0..<steps {
                let a = UInt32(j * (steps + 1) + i), b = a + 1, c = a + UInt32(steps + 1), d = c + 1
                var tris = [[a, b, d], [a, d, c]]
                let p = vertices[Int(a)], q = vertices[Int(b)], r = vertices[Int(d)]
                if vdot(vcross(q - p, r - p), normal) < 0 { tris = tris.map { [$0[0], $0[2], $0[1]] } }
                indices += tris.flatMap { $0 }
            }
        }
        return ScanMesh(vertices: vertices, normals: [Vec3](repeating: normal, count: vertices.count), indices: indices)
    }

    /// The test room's LiDAR mesh: the pouf, plus bits of the floor, a wall and the ceiling.
    static func roomMesh() -> ScanMesh {
        let s = sphere(center: pouf.center, radius: pouf.radius)
        var mesh = ScanMesh(vertices: s.vertices, normals: s.normals, indices: s.indices)
        let size = PhotoTexturingTests.size
        for part in [
            grid(origin: Vec3(0.2, 0, 0.2), u: Vec3(3.6, 0, 0), v: Vec3(0, 0, 2.6), normal: Vec3(0, 1, 0), steps: 30, noise: 0.015, seed: 1),
            grid(origin: Vec3(0.2, 0.2, 0), u: Vec3(3.6, 0, 0), v: Vec3(0, 2.1, 0), normal: Vec3(0, 0, 1), steps: 30, noise: 0.02, seed: 2),
            grid(origin: Vec3(0.2, size.y, 0.2), u: Vec3(3.6, 0, 0), v: Vec3(0, 0, 2.6), normal: Vec3(0, -1, 0), steps: 20, noise: 0.015, seed: 3),
        ] {
            let base = UInt32(mesh.vertices.count)
            mesh.vertices += part.vertices
            mesh.normals += part.normals
            mesh.indices += part.indices.map { $0 + base }
        }
        mesh.classes = [UInt8](repeating: 0, count: mesh.triangleCount)
        mesh.roomId = roomId
        return mesh
    }

    /// A box's top and sides as noisy grids (its bottom is the floor, which the scanner sees instead).
    static func box(lo: Vec3, hi: Vec3, seed: UInt32) -> [ScanMesh] {
        let d = hi - lo
        return [
            grid(origin: Vec3(lo.x, hi.y, lo.z), u: Vec3(d.x, 0, 0), v: Vec3(0, 0, d.z), normal: Vec3(0, 1, 0), steps: 12, noise: 0.005, seed: seed),
            grid(origin: lo, u: Vec3(0, 0, d.z), v: Vec3(0, d.y, 0), normal: Vec3(-1, 0, 0), steps: 12, noise: 0.005, seed: seed + 1),
            grid(origin: Vec3(hi.x, lo.y, lo.z), u: Vec3(0, 0, d.z), v: Vec3(0, d.y, 0), normal: Vec3(1, 0, 0), steps: 12, noise: 0.005, seed: seed + 2),
            grid(origin: lo, u: Vec3(d.x, 0, 0), v: Vec3(0, d.y, 0), normal: Vec3(0, 0, -1), steps: 12, noise: 0.005, seed: seed + 3),
            grid(origin: Vec3(lo.x, lo.y, hi.z), u: Vec3(d.x, 0, 0), v: Vec3(0, d.y, 0), normal: Vec3(0, 0, 1), steps: 12, noise: 0.005, seed: seed + 4),
        ]
    }

    /// `mesh` with `parts` added (one room's mesh, unclassified).
    static func adding(_ parts: [ScanMesh], to mesh: ScanMesh) -> ScanMesh {
        var out = mesh
        for part in parts {
            let base = UInt32(out.vertices.count)
            out.vertices += part.vertices
            out.normals += part.normals
            out.indices += part.indices.map { $0 + base }
        }
        out.classes = [UInt8](repeating: 0, count: out.triangleCount)
        return out
    }

    func testMeshFilesRoundTrip() throws {
        var mesh = Self.roomMesh()
        mesh.classes = (0..<mesh.triangleCount).map { UInt8($0 % 8) }
        let data = mesh.encoded()
        var back = try ScanMesh(decoding: data, roomId: Self.roomId)
        XCTAssertEqual(back, mesh)
        back.normals = []
        back.classes = []
        XCTAssertEqual(try ScanMesh(decoding: back.encoded()), ScanMesh(vertices: mesh.vertices, indices: mesh.indices))
        XCTAssertThrowsError(try ScanMesh(decoding: data.prefix(data.count - 3)))
        XCTAssertThrowsError(try ScanMesh(decoding: Data("not a mesh at all".utf8)))
        // Triangles that point past the vertices are dropped, not trusted.
        let broken = ScanMesh(vertices: [Vec3(0, 0, 0), Vec3(1, 0, 0), Vec3(0, 1, 0)], indices: [0, 1, 2, 0, 1, 7])
        XCTAssertEqual(broken.sanitized().indices, [0, 1, 2])
    }

    func testOnlyFurnitureAndClutterAreKept() {
        let scan = PhotoTexturingTests.room()
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        let shapes = MeshShapes.build([Self.roomMesh()], rooms: rooms, walls: walls, objects: scan.objects)
        XCTAssertEqual(shapes.rooms, [0])
        XCTAssertGreaterThan(shapes.triangles.count, 300)
        // What's left is the pouf: the floor, the wall and the ceiling are the room's own surfaces.
        let (c, r) = Self.pouf
        for v in shapes.vertices { XCTAssertEqual(vlength(v - c), r, accuracy: 0.03, "\(v) is not on the pouf") }
        // Outward-facing, in a handful of nearly flat patches.
        for t in shapes.triangles { XCTAssertGreaterThan(vdot(shapes.normal(t), vnormalize(shapes.center(t) - c)), 0.8) }
        XCTAssertGreaterThan(shapes.patches.count, 6)
        XCTAssertLessThan(shapes.patches.count, 40)
        for p in shapes.patches {
            for f in p.faces { XCTAssertGreaterThan(vdot(shapes.normal(shapes.triangles[f]), p.normal), 0.3) }
        }
        // The cabinet box stays: the mesh doesn't cover it.
        XCTAssertTrue(shapes.replaced.isEmpty)
    }

    func testLowClutterOnTheFloorIsLeftToTheFloorsPhotos() {
        let scan = PhotoTexturingTests.room()
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        // A shoe and a heap of clothes on the floor (cut off at the floor, their tops would float), and
        // a coffee table.
        let shoe = Self.sphere(center: Vec3(2.2, 0.04, 1.4), radius: 0.1)
        let heap = Self.sphere(center: Vec3(1.6, 0, 0.9), radius: 0.2)
        let mesh = Self.adding(
            [ScanMesh(vertices: shoe.vertices, normals: shoe.normals, indices: shoe.indices), ScanMesh(vertices: heap.vertices, normals: heap.normals, indices: heap.indices)]
                + Self.box(lo: Vec3(2, 0, 2), hi: Vec3(2.9, 0.42, 2.5), seed: 7),
            to: Self.roomMesh())
        let shapes = MeshShapes.build([mesh], rooms: rooms, walls: walls, objects: scan.objects)
        let near = { (c: Vec3, r: Float) in shapes.vertices.contains { vlength($0 - c) < r } }
        XCTAssertFalse(near(Vec3(2.2, 0.08, 1.4), 0.15), "the shoe goes")
        XCTAssertFalse(near(Vec3(1.6, 0.1, 0.9), 0.25), "the heap goes")
        XCTAssertTrue(near(Self.pouf.center, Self.pouf.radius + 0.05), "the pouf stays")
        XCTAssertTrue(shapes.vertices.contains { $0.y > 0.38 && $0.x > 2 && $0.x < 2.9 && $0.z > 2 && $0.z < 2.5 }, "the coffee table stays")
    }

    func testALowPieceRoomPlanKnowsIsKept() {
        var scan = PhotoTexturingTests.room()
        // An ottoman, low enough to pass for clutter, but RoomPlan saw it: the mesh shapes it.
        scan.objects.append(ScanObject(id: "OT", roomId: scan.rooms[0].id, category: "storage", transform: .translating(Vec3(2, 0.14, 1.6)), size: Vec3(0.5, 0.28, 0.5)))
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        let mesh = Self.adding(Self.box(lo: Vec3(1.75, 0, 1.35), hi: Vec3(2.25, 0.28, 1.85), seed: 11), to: Self.roomMesh())
        let shapes = MeshShapes.build([mesh], rooms: rooms, walls: walls, objects: scan.objects)
        XCTAssertTrue(shapes.replaced.contains("OT"))
        XCTAssertTrue(shapes.vertices.contains { $0.y > 0.25 && abs($0.x - 2) < 0.25 && abs($0.z - 1.6) < 0.25 })
    }

    func testWhatTouchesNothingGoes() {
        let scan = PhotoTexturingTests.room()
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        // What the scanner kept of someone walking through: a shin, floating mid-room. A coat on a
        // hook (by the wall) and a pendant light (under the ceiling) touch something.
        let shin = Self.box(lo: Vec3(2, 0.3, 1.4), hi: Vec3(2.15, 0.8, 1.55), seed: 21)
        let mesh = Self.adding(
            [shin[1], shin[3]]  // the sides the scanner saw as it went by
                + Self.box(lo: Vec3(0.08, 1, 1), hi: Vec3(0.16, 1.25, 1.12), seed: 31)
                + Self.box(lo: Vec3(1.5, 2, 1.2), hi: Vec3(1.7, 2.2, 1.4), seed: 41),
            to: Self.roomMesh())
        let shapes = MeshShapes.build([mesh], rooms: rooms, walls: walls, objects: scan.objects)
        let within = { (lo: Vec3, hi: Vec3) in shapes.vertices.contains { $0.x > lo.x && $0.y > lo.y && $0.z > lo.z && $0.x < hi.x && $0.y < hi.y && $0.z < hi.z } }
        XCTAssertFalse(within(Vec3(1.95, 0.25, 1.35), Vec3(2.2, 0.85, 1.6)), "the shin goes")
        XCTAssertTrue(within(Vec3(0.05, 0.95, 0.95), Vec3(0.2, 1.3, 1.15)), "the coat by the wall stays")
        XCTAssertTrue(within(Vec3(1.45, 1.95, 1.15), Vec3(1.75, 2.25, 1.45)), "the pendant light stays")
        XCTAssertTrue(within(Self.pouf.center - Vec3(repeating: 0.4), Self.pouf.center + Vec3(repeating: 0.4)), "the pouf stays")
    }

    func testAChairScannedWithoutItsLegsKeepsRoomPlans() {
        var scan = PhotoTexturingTests.room()
        let id = scan.rooms[0].id
        scan.objects += [
            ScanObject(id: "BARE", roomId: id, category: "chair", transform: .translating(Vec3(2, 0.42, 1.5)), size: Vec3(0.5, 0.84, 0.5)),
            ScanObject(id: "LEGS", roomId: id, category: "chair", transform: .translating(Vec3(1.2, 0.42, 1.5)), size: Vec3(0.5, 0.84, 0.5)),
        ]
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        func chair(_ x: Float, legs: Bool, seed: UInt32) -> [ScanMesh] {
            var parts = Self.box(lo: Vec3(x - 0.25, 0.4, 1.25), hi: Vec3(x + 0.25, 0.46, 1.75), seed: seed)
                + Self.box(lo: Vec3(x - 0.25, 0.46, 1.69), hi: Vec3(x + 0.25, 0.84, 1.75), seed: seed + 10)
            if legs {
                for (dx, dz) in [(-0.22, -0.22), (0.18, -0.22), (-0.22, 0.18), (0.18, 0.18)] as [(Float, Float)] {
                    parts += Self.box(lo: Vec3(x + dx, 0, 1.5 + dz), hi: Vec3(x + dx + 0.04, 0.4, 1.5 + dz + 0.04), seed: seed + 20)
                }
            }
            return parts
        }
        let mesh = Self.adding(chair(2, legs: false, seed: 51) + chair(1.2, legs: true, seed: 81), to: Self.roomMesh())
        let shapes = MeshShapes.build([mesh], rooms: rooms, walls: walls, objects: scan.objects)
        // The scanned chair stands on its legs; the bare one keeps RoomPlan's chair, legs and all,
        // and its floating seat and back go.
        XCTAssertTrue(shapes.replaced.contains("LEGS"))
        XCTAssertFalse(shapes.replaced.contains("BARE"))
        XCTAssertFalse(shapes.vertices.contains { abs($0.x - 2) < 0.3 && abs($0.z - 1.5) < 0.3 && $0.y > 0.3 }, "the seat doesn't float")
    }

    func testTheMeshReplacesBoxesItCoversOnly() {
        var scan = PhotoTexturingTests.room()
        let (c, r) = Self.pouf
        // RoomPlan saw the pouf as a box, and a TV on the wall the mesh can't tell from the wall.
        scan.objects.append(ScanObject(id: "Pouf", roomId: Self.roomId, category: "chair", transform: Transform.translating(c), size: Vec3(repeating: 2 * r)))
        scan.objects.append(
            ScanObject(id: "TV", roomId: Self.roomId, category: "television", transform: Transform.translating(Vec3(1.5, 1.4, 0.04)), size: Vec3(1.2, 0.7, 0.06)))
        scan.meshes = [Self.roomMesh()]
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        let shapes = MeshShapes.build(scan.meshes, rooms: rooms, walls: walls, objects: scan.objects)
        XCTAssertEqual(shapes.replaced, ["Pouf"])
        let model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        XCTAssertEqual(model.meshObjects, 1)
        XCTAssertEqual(model.meshTriangles, shapes.triangles.count)
        // The cabinet and the TV are boxes (five faces, and six for the TV); the pouf is the mesh.
        XCTAssertEqual(model.charts.filter { $0.kind == .object && !$0.curved }.count, 11)
        XCTAssertEqual(model.charts.filter(\.curved).count, shapes.patches.count)

        // A room without a mesh keeps every box.
        let plain = PhotoModel.build(scan: PhotoTexturingTests.room(), rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        XCTAssertEqual(plain.meshTriangles, 0)
        XCTAssertFalse(plain.charts.contains(where: \.curved))
    }

    /// The test room's photos with the pouf in them (its surface patterned like the room's).
    struct WithPouf: PhotoSource {
        var poses = Dictionary(uniqueKeysWithValues: PhotoTexturingTests.frames().map { ($0.file, $0.transform) })

        func image(for frame: CameraFrame) -> RGBImage? {
            guard let t = poses[frame.file] else { return nil }
            let w = frame.imageWidth, h = frame.imageHeight, k = frame.intrinsics
            let (c, r) = MeshShapesTests.pouf
            var pixels = [UInt8](repeating: 0, count: w * h * 3)
            for v in 0..<h {
                for u in 0..<w {
                    let o = t.translation
                    let d = vnormalize(t.applyDirection(Vec3((Float(u) + 0.5 - k[6]) / k[0], -(Float(v) + 0.5 - k[7]) / k[4], -1)))
                    let room = PhotoTexturingTests.hit(from: o, d)
                    var color = room.cabinet ? PhotoTexturingTests.magenta : PhotoTexturingTests.color(at: room.point)
                    // The pouf, if it's nearer.
                    let oc = o - c, b = vdot(oc, d), disc = b * b - (vdot(oc, oc) - r * r)
                    if disc > 0 {
                        let s = -b - disc.squareRoot()
                        if s > 0, s < vlength(room.point - o) { color = PhotoTexturingTests.color(at: o + d * s) }
                    }
                    let i = (v * w + u) * 3
                    pixels[i] = UInt8(clamp(color.0, 0, 255))
                    pixels[i + 1] = UInt8(clamp(color.1, 0, 255))
                    pixels[i + 2] = UInt8(clamp(color.2, 0, 255))
                }
            }
            return RGBImage(width: w, height: h, pixels: pixels)
        }
    }

    func testMeshShapesArePaintedWhereTheirSurfaceIs() throws {
        var scan = PhotoTexturingTests.room()
        scan.frames = PhotoTexturingTests.frames()
        scan.meshes = [Self.roomMesh()]
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        model.measureCharts()
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.01, depthWidth: 160)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: WithPouf(), atlasCount: atlases, options: options)

        // Every seen texel of the pouf shows the pattern at its own point on the pouf's surface
        // (not at the point on its patch's plane, which can be centimeters off).
        var errors: [Float] = [], planeErrors: [Float] = []
        for (ci, chart) in model.charts.enumerated() where chart.curved {
            let surface = try XCTUnwrap(PhotoBaker.coverage(of: chart, faces: model.mesh.buffers[PhotoModel.chartMaterial(ci)]).surface)
            for j in (PhotoChart.pad + 1)..<(chart.h - PhotoChart.pad - 1) {
                for i in (PhotoChart.pad + 1)..<(chart.w - PhotoChart.pad - 1) where baked.seen[ci][j * chart.w + i] {
                    let p = surface.points[j * chart.w + i]
                    XCTAssertEqual(vlength(p - Self.pouf.center), Self.pouf.radius, accuracy: 0.01)
                    let a = ((chart.y + j) * options.atlasSize + chart.x + i) * 3, px = baked.atlases[chart.atlas].pixels
                    let got = (Float(px[a]), Float(px[a + 1]), Float(px[a + 2]))
                    let want = PhotoTexturingTests.color(at: p), flat = PhotoTexturingTests.color(at: chart.point(i, j))
                    errors.append(max(abs(got.0 - want.0), abs(got.1 - want.1), abs(got.2 - want.2)))
                    planeErrors.append(max(abs(flat.0 - want.0), abs(flat.1 - want.1), abs(flat.2 - want.2)))
                }
            }
        }
        XCTAssertGreaterThan(errors.count, 1500)
        errors.sort()
        planeErrors.sort()
        let median = errors[errors.count / 2], p90 = errors[errors.count * 9 / 10], planeMedian = planeErrors[planeErrors.count / 2]
        // Measured: median 1.3, 90th percentile 3.0; points on the patches' planes would be off by 3.6 (median).
        XCTAssertLessThan(median, 4, "median error \(median)")
        XCTAssertLessThan(p90, 10, "90th percentile error \(p90)")
        XCTAssertLessThan(median * 2, planeMedian, "the patches' planes alone would do about as well")
    }

    func testMeshesFollowTheirRoomIntoTheScan() throws {
        // The room scanned in its own frame, a quarter turn and a few meters away from the scan's.
        let scan = PhotoTexturingTests.room()
        var mesh = Self.roomMesh()
        mesh.roomId = nil
        var part = RoomPart(room: scan.rooms[0], walls: scan.walls, objects: scan.objects, segment: 0, mesh: mesh)
        part = part.moved(by: Motion(yaw: .pi / 2, t: Vec3(3, 0, -2)))
        let aligned = RoomAlignment.align(parts: [part], structure: nil, path: [], frames: [])
        XCTAssertEqual(aligned.scan.meshes.count, 1)
        XCTAssertEqual(aligned.scan.meshes[0].roomId, Self.roomId)
        // Processing normalizes the frame; the mesh moves with the room and still shapes the pouf.
        var full = aligned.scan
        full.frames = []
        let processed = try ScanProcessor.process(full, options: ScanProcessorOptions(textureSize: 32))
        XCTAssertNil(processed.stats.meshTriangles, "the styled model has no photos to paint the mesh with")
        let normalized = full.transformed(by: ScanProcessor.normalizingFrame(for: full))
        let rooms = Layout.rooms(from: normalized)
        let walls = Layout.walls(from: normalized, rooms: rooms, defaultThickness: 0.12)
        let shapes = MeshShapes.build(normalized.meshes, rooms: rooms, walls: walls, objects: normalized.objects)
        XCTAssertGreaterThan(shapes.triangles.count, 300)
        let center = shapes.vertices.reduce(Vec3(0, 0, 0), +) / Float(shapes.vertices.count)
        let radii = shapes.vertices.map { vlength($0 - center) }
        XCTAssertEqual(radii.max() ?? 0, Self.pouf.radius, accuracy: 0.05, "only the pouf is left")
        XCTAssertEqual(radii.min() ?? 0, Self.pouf.radius, accuracy: 0.05, "only the pouf is left")
    }

    func testSmoothingFlattensBumpsWithoutShrinking() {
        // A 1 m square tabletop of 2.5 cm triangles, its inner vertices bumped up to ±1 cm.
        var shapes = MeshShapes()
        let n = 40
        var seed: UInt32 = 7
        func bump() -> Float {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            return (Float(seed >> 8) / Float(1 << 24) - 0.5) * 0.02
        }
        for j in 0...n {
            for i in 0...n {
                let inner = i > 0 && j > 0 && i < n && j < n
                shapes.vertices.append(Vec3(Float(i) / Float(n), 0.75 + (inner ? bump() : 0), Float(j) / Float(n)))
            }
        }
        for j in 0..<n {
            for i in 0..<n {
                let a = Int32(j * (n + 1) + i), b = a + 1, c = a + Int32(n + 1), d = c + 1
                shapes.triangles += [SIMD3(a, c, b), SIMD3(b, c, d)]
            }
        }
        func roughness() -> Float {
            let ys = shapes.vertices.map(\.y)
            let mean = ys.reduce(0, +) / Float(ys.count)
            return (ys.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Float(ys.count)).squareRoot()
        }
        let before = roughness(), corner = shapes.vertices[0]
        shapes.smooth(iterations: 4)
        XCTAssertLessThan(roughness(), before * 0.5, "bumps flattened")
        XCTAssertEqual(shapes.vertices[0], corner, "the open edge stays put")
        let xs = shapes.vertices.map(\.x)
        XCTAssertEqual(xs.max()! - xs.min()!, 1, accuracy: 1e-5, "no shrinking")
    }
}
