import Foundation
import XCTest

@testable import AtriumScanCore

/// Rooms whose outlines overlap: the room whose scan saw the overlap best keeps it — its shapes, its
/// floor and its photos — so furniture there isn't one run's shape painted with the other's photos.
final class RoomOverlapsTests: XCTestCase {
    static let officeId = "R0000000-0000-4000-8000-000000000002"
    /// How far the office's run lines up off the bedroom's.
    static let drift = Vec3(0.06, 0, 0)

    /// The test room (a bedroom, with the pouf), and an office scanned before it whose outline reaches
    /// over the bedroom's corner where the pouf stands: the phone carried in while scanning the office.
    /// The office's run saw the pouf too, 6 cm off, and nothing else of that corner.
    static func scan() -> CaptureScan {
        var scan = PhotoTexturingTests.room()
        scan.rooms[0].captureIndex = 1
        let y = PhotoTexturingTests.size.y
        let office = ScanRoom(
            id: officeId, name: "Office", captureIndex: 0,
            floorPolygon: [Vec3(-2, 0, 1.4), Vec3(1.6, 0, 1.4), Vec3(1.6, 0, 3), Vec3(-2, 0, 3)], floorY: 0, ceilingY: y)
        scan.rooms.insert(office, at: 0)
        let s = MeshShapesTests.sphere(center: MeshShapesTests.pouf.center + drift, radius: MeshShapesTests.pouf.radius)
        let officeMesh = ScanMesh(vertices: s.vertices, normals: s.normals, indices: s.indices, roomId: officeId)
        scan.meshes = [MeshShapesTests.roomMesh(), officeMesh]
        return scan
    }

    static let office = 0, bedroom = 1

    func testTheRoomThatScannedAnOverlapBestOwnsIt() {
        let scan = Self.scan()
        let rooms = Layout.rooms(from: scan)
        XCTAssertEqual(rooms.map(\.room.id), [Self.officeId, MeshShapesTests.roomId])
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        let overlaps = RoomOverlaps.find(rooms: rooms, meshes: scan.meshes, frames: [])
        // The bedroom's run saw its corner's floor, ceiling and pouf; the office's only the pouf.
        XCTAssertEqual(overlaps.regions.count, 1)
        XCTAssertEqual(overlaps.regions.first?.owner, Self.bedroom)
        XCTAssertEqual(overlaps.area, 1.6 * 1.6, accuracy: 0.3)
        XCTAssertEqual(overlaps.owner(of: Vec3(0.8, 1, 2.3)), Self.bedroom)
        XCTAssertEqual(overlaps.owner(of: Vec3(-1, 1, 2)), Self.office, "the office's own part")
        XCTAssertEqual(overlaps.owner(of: Vec3(3, 1, 1)), Self.bedroom)
        XCTAssertNil(overlaps.owner(of: Vec3(-5, 1, 0)))
        XCTAssertNil(overlaps.owner(of: Vec3(0.8, 4, 2.3)), "above the ceiling")
        let order = overlaps.floorOrder()
        XCTAssertGreaterThan(order[Self.bedroom]!, order[Self.office]!, "the bedroom's floor on top in the corner")

        // The pouf comes from the bedroom's mesh, where it really is.
        let shapes = MeshShapes.build(scan.meshes, rooms: rooms, walls: walls, objects: scan.objects, overlaps: overlaps)
        let (c, r) = MeshShapesTests.pouf
        XCTAssertGreaterThan(shapes.triangles.count, 300)
        for v in shapes.vertices { XCTAssertEqual(vlength(v - c), r, accuracy: 0.03, "\(v) is off the pouf") }
        XCTAssertEqual(Set(shapes.roomOf), [Int32(Self.bedroom)])
        XCTAssertTrue(shapes.patches.allSatisfy { $0.room == Self.bedroom })
        // Going by capture order (as before), the office took the corner: its copy, 6 cm off.
        let first = MeshShapes.build(scan.meshes, rooms: rooms, walls: walls, objects: scan.objects)
        let center = first.vertices.reduce(Vec3(0, 0, 0), +) / Float(max(first.vertices.count, 1))
        XCTAssertEqual(center.x, c.x + Self.drift.x, accuracy: 0.02)
    }

    func testWithoutAMeshThePhotosTakenThereDecide() {
        var scan = Self.scan()
        scan.meshes = []
        let rooms = Layout.rooms(from: scan)
        // No mesh, no photos: the room scanned first.
        XCTAssertEqual(RoomOverlaps.find(rooms: rooms, meshes: [], frames: []).regions.first?.owner, Self.office)
        // Most photos taken standing in the corner are the bedroom's.
        var frames = PhotoTexturingTests.frames(at: Vec3(0.9, 1.45, 2.0), prefix: "b")
        for k in frames.indices { frames[k].roomId = MeshShapesTests.roomId }
        var office = Array(PhotoTexturingTests.frames(at: Vec3(1.2, 1.45, 2.4), prefix: "o").prefix(5))
        for k in office.indices { office[k].roomId = Self.officeId }
        XCTAssertEqual(RoomOverlaps.find(rooms: rooms, meshes: [], frames: frames + office).regions.first?.owner, Self.bedroom)
    }

    func testRoomsThatDontOverlapAreLeftAsTheyWere() {
        let scan = PhotoTexturingTests.room()
        let rooms = Layout.rooms(from: scan)
        let overlaps = RoomOverlaps.find(rooms: rooms, meshes: [MeshShapesTests.roomMesh()], frames: [])
        XCTAssertTrue(overlaps.regions.isEmpty)
        XCTAssertEqual(overlaps.floorOrder(), [0: 0])
        XCTAssertEqual(overlaps.owner(of: Vec3(1, 1, 1)), 0)
    }

    func testARoomOnTheFloorAboveIsNoOverlap() {
        // The same room again, a floor up (a bedroom over the living room), with its own pouf.
        var scan = PhotoTexturingTests.room()
        let lift: Float = 2.8
        var upstairs = scan.rooms[0]
        upstairs.id = Self.officeId
        upstairs.captureIndex = 1
        upstairs.floorPolygon = upstairs.floorPolygon.map { $0 + Vec3(0, lift, 0) }
        upstairs.floorY += lift
        upstairs.ceilingY += lift
        scan.rooms.append(upstairs)
        let up = Transform.translating(Vec3(0, lift, 0))
        scan.walls += scan.walls.map { w in
            var copy = w
            copy.id += "-up"
            copy.roomId = Self.officeId
            copy.transform = up * w.transform
            return copy
        }
        var upstairsMesh = MeshShapesTests.roomMesh().transformed(by: up)
        upstairsMesh.roomId = Self.officeId
        scan.meshes = [MeshShapesTests.roomMesh(), upstairsMesh]
        let rooms = Layout.rooms(from: scan)
        let overlaps = RoomOverlaps.find(rooms: rooms, meshes: scan.meshes, frames: [])
        XCTAssertTrue(overlaps.regions.isEmpty)
        XCTAssertEqual(overlaps.owner(of: Vec3(0.8, 0.5, 2.3)), 0)
        XCTAssertEqual(overlaps.owner(of: Vec3(0.8, lift + 0.5, 2.3)), 1)
        // Both poufs stay.
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        let shapes = MeshShapes.build(scan.meshes, rooms: rooms, walls: walls, objects: [], overlaps: overlaps)
        XCTAssertEqual(shapes.rooms, [0, 1])
        let (c, r) = MeshShapesTests.pouf
        for v in shapes.vertices {
            XCTAssertEqual(min(vlength(v - c), vlength(v - c - Vec3(0, lift, 0))), r, accuracy: 0.03, "\(v) is off both poufs")
        }
        XCTAssertTrue(shapes.vertices.contains { $0.y > lift } && shapes.vertices.contains { $0.y < lift })
    }

    func testPhotosRememberTheRoomBeingScanned() {
        let truth = SyntheticApartment.make()
        let s = AlignmentTests.scramble(truth, tagged: true)
        // A photo in the middle of each room's run.
        let frames = s.starts.indices.map { k -> CameraFrame in
            let end = k + 1 < s.starts.count ? s.starts[k + 1] : s.path.count
            let i = (s.starts[k] + end) / 2
            return CameraFrame(
                file: "frames/\(k).jpg", t: s.path[i].t, transform: Transform.translating(s.path[i].p), intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1], width: 4,
                height: 3, imageWidth: 4, imageHeight: 3, segment: k)
        }
        let result = RoomAlignment.align(parts: s.parts, structure: nil, path: s.path, frames: frames)
        XCTAssertEqual(result.scan.frames.count, frames.count)
        for f in result.scan.frames {
            let k = Int(f.file.dropFirst("frames/".count).dropLast(".jpg".count))!
            XCTAssertEqual(f.roomId, truth.rooms[k].id, f.file)
        }
        // A single room's photos are its own.
        let one = RoomAlignment.align(parts: [s.parts[0]], structure: nil, path: [], frames: [frames[0]])
        XCTAssertEqual(one.scan.frames.first?.roomId, truth.rooms[0].id)
    }

    func testTheOtherRoomsCopyOfAnObjectInAnOverlapGoes() {
        var scan = Self.scan()
        let (c, r) = MeshShapesTests.pouf
        // Both runs found the pouf; the office's box lies where its run put it, 6 cm off.
        scan.objects.append(ScanObject(id: "PoufB", roomId: MeshShapesTests.roomId, category: "chair", transform: Transform.translating(c), size: Vec3(repeating: 2 * r)))
        scan.objects.append(
            ScanObject(id: "PoufO", roomId: Self.officeId, category: "chair", transform: Transform.translating(c + Self.drift), size: Vec3(repeating: 2 * r)))
        // And a table only the office found: it stays.
        scan.objects.append(
            ScanObject(id: "Table", roomId: Self.officeId, category: "table", transform: Transform.translating(Vec3(1.2, 0.35, 1.8)), size: Vec3(0.5, 0.7, 0.5)))
        let rooms = Layout.rooms(from: scan)
        let overlaps = RoomOverlaps.find(rooms: rooms, meshes: scan.meshes, frames: [])
        XCTAssertEqual(PhotoModel.duplicateObjects(scan.objects, rooms: rooms, overlaps: overlaps), ["PoufO"])
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        let model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        XCTAssertEqual(model.droppedDuplicates, 1)
        XCTAssertEqual(model.replacedObjects, ["PoufB"], "the bedroom's box gives way to its mesh")
        XCTAssertEqual(model.overlapArea, 1.6 * 1.6, accuracy: 0.3)
        // Floors and ceilings, the boxes and the mesh's patches each say whose photos paint them.
        let floors = model.charts.filter { $0.kind == .floor }
        XCTAssertEqual(Set(floors.compactMap(\.room)), [Self.officeId, MeshShapesTests.roomId])
        XCTAssertTrue(model.charts.filter(\.curved).allSatisfy { $0.room == MeshShapesTests.roomId })
        XCTAssertTrue(model.charts.filter { $0.kind == .wall }.allSatisfy { $0.room == nil }, "walls take any photo")
    }

    /// Photos of the bedroom's run, and of the office's taken standing in the bedroom's corner but
    /// recorded 6 cm off (as its run lines up); the photos themselves show the room as it is.
    static func photos() -> (frames: [CameraFrame], source: MeshShapesTests.WithPouf) {
        var bedroom = PhotoTexturingTests.frames(prefix: "b")
        for k in bedroom.indices { bedroom[k].roomId = MeshShapesTests.roomId }
        var office = PhotoTexturingTests.frames(at: Vec3(1.1, 1.45, 1.9), prefix: "o")
        var truth = Dictionary(uniqueKeysWithValues: bedroom.map { ($0.file, $0.transform) })
        for k in office.indices {
            truth[office[k].file] = office[k].transform
            office[k].transform = Transform.translating(drift) * office[k].transform
            office[k].roomId = officeId
        }
        return (bedroom + office, MeshShapesTests.WithPouf(poses: truth))
    }

    /// The median error of the pouf's painted texels against the pattern at their points.
    func poufError(_ frames: [CameraFrame], _ source: MeshShapesTests.WithPouf) throws -> Float {
        var scan = Self.scan()
        scan.frames = frames
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        model.measureCharts()
        // Without lining the photos up first: the test is which photos paint the pouf.
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.01, depthWidth: 160, alignPhotos: false)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: source, atlasCount: atlases, options: options)
        var errors: [Float] = []
        for (ci, chart) in model.charts.enumerated() where chart.curved {
            let surface = try XCTUnwrap(PhotoBaker.coverage(of: chart, faces: model.mesh.buffers[PhotoModel.chartMaterial(ci)]).surface)
            for j in (PhotoChart.pad + 1)..<(chart.h - PhotoChart.pad - 1) {
                for i in (PhotoChart.pad + 1)..<(chart.w - PhotoChart.pad - 1) where baked.seen[ci][j * chart.w + i] {
                    let p = surface.points[j * chart.w + i]
                    let a = ((chart.y + j) * options.atlasSize + chart.x + i) * 3, px = baked.atlases[chart.atlas].pixels
                    let want = PhotoTexturingTests.color(at: p)
                    errors.append(max(abs(Float(px[a]) - want.0), abs(Float(px[a + 1]) - want.1), abs(Float(px[a + 2]) - want.2)))
                }
            }
        }
        XCTAssertGreaterThan(errors.count, 1000)
        errors.sort()
        return errors[errors.count / 2]
    }

    func testFurnitureInAnOverlapIsPaintedWithItsOwnersPhotos() throws {
        let (frames, source) = Self.photos()
        let own = try poufError(frames, source)
        // Any photo (as before): the office's, nearer the pouf, paint most of it 6 cm off.
        let any = try poufError(frames.map { var f = $0; f.roomId = nil; return f }, source)
        // Measured: 1.3 with the bedroom's photos, 2.6 with any.
        XCTAssertLessThan(own, 4, "median error \(own)")
        XCTAssertGreaterThan(any, 1.6 * own, "any photo: \(any), the bedroom's: \(own)")
    }
}
