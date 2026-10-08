import Foundation
import XCTest

@testable import AtriumScanCore

final class ScanCoreTests: XCTestCase {
    let fast = ScanProcessorOptions(textureSize: 32)

    // MARK: Basics

    func testTransformAppliesColumnMajorAndRoundTripsAsJSON() throws {
        let t = Transform.translating(Vec3(1, 2, 3)) * Transform.rotationY(.pi / 2)
        let p = t.apply(Vec3(1, 0, 0))
        XCTAssertEqual(p.x, 1, accuracy: 1e-5)
        XCTAssertEqual(p.y, 2, accuracy: 1e-5)
        XCTAssertEqual(p.z, 2, accuracy: 1e-5)  // +X turned toward −Z, then moved by z = 3
        let data = try JSONEncoder().encode(t)
        let text = String(data: data, encoding: .utf8)!
        XCTAssertTrue(text.hasPrefix("[") && text.split(separator: ",").count == 16, text)
        XCTAssertEqual(try JSONDecoder().decode(Transform.self, from: data), t)
        XCTAssertThrowsError(try JSONDecoder().decode(Transform.self, from: Data("[1,2,3]".utf8)))
    }

    func testTriangulationCoversConcaveRooms() {
        let l: [P2] = [P2(0, 0), P2(4, 0), P2(4, 2), P2(2, 2), P2(2, 5), P2(0, 5)]
        for poly in [l, l.reversed()] {
            let tris = triangulate(poly)
            XCTAssertEqual(tris.count, poly.count - 2)
            let total = tris.reduce(0.0) { $0 + area([poly[$1.0], poly[$1.1], poly[$1.2]]) }
            XCTAssertEqual(total, 14, accuracy: 1e-9)
            for (a, b, c) in tris { XCTAssertGreaterThan(signedArea([poly[a], poly[b], poly[c]]), 0) }
        }
        let center = interiorCenter(l)
        XCTAssertTrue(pointInPolygon(center, l))
    }

    func testCleanPolygonDropsDuplicatesAndCollinearPoints() {
        let messy: [P2] = [P2(0, 0), P2(0, 0.001), P2(2, 0), P2(4, 0), P2(4, 3), P2(0, 3), P2(0, 0)]
        let clean = cleanPolygon(messy)
        XCTAssertEqual(clean?.count, 4)
        XCTAssertNil(cleanPolygon([P2(0, 0), P2(1, 0), P2(2, 0)]))
        XCTAssertNil(cleanPolygon([P2(0, 0), P2(.nan, 0), P2(1, 1)]))
    }

    func testPNGEncoderProducesValidChunks() {
        XCTAssertEqual(PNG.crc32(Data("123456789".utf8)), 0xCBF4_3926)
        XCTAssertEqual(PNG.adler32(Array("Wikipedia".utf8)), 0x11E6_0398)
        let png = PNG.encode(ProceduralTexture.tile(size: 16))
        XCTAssertEqual(Array(png.prefix(8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        // Walk the chunks and check every CRC.
        var offset = 8
        var types: [String] = []
        while offset < png.count {
            let length = Int(readUInt32BE(png, offset))
            let body = png.subdata(in: (offset + 4)..<(offset + 8 + length))
            types.append(String(data: body.prefix(4), encoding: .ascii)!)
            XCTAssertEqual(readUInt32BE(png, offset + 8 + length), PNG.crc32(body))
            offset += 12 + length
        }
        XCTAssertEqual(types, ["IHDR", "IDAT", "IEND"])
        // Stored deflate round trip: blocks carry the bytes verbatim.
        let bytes = (0..<70000).map { UInt8($0 % 251) }
        let stored = PNG.storedDeflate(bytes)
        XCTAssertEqual(stored.count, bytes.count + 5 * 2)
    }

    func testScanJSONRoundTrips() throws {
        let scan = SyntheticApartment.make()
        let decoded = try CaptureScan.decode(from: try scan.jsonData())
        XCTAssertEqual(decoded, scan)
        XCTAssertEqual(decoded.format, CaptureScan.formatIdentifier)
        // Minimal hand-written scans: only rooms are required.
        let minimal = try CaptureScan.decode(
            from: Data(
                """
                {"format":"atrium.capture-scan/v1","rooms":[{"id":"r1","name":"Studio","captureIndex":0,
                "floorPolygon":[[0,0,0],[4,0,0],[4,0,3],[0,0,3]],"floorY":0,"ceilingY":2.5}]}
                """.utf8))
        XCTAssertEqual(minimal.rooms.count, 1)
        XCTAssertTrue(minimal.walls.isEmpty && minimal.trajectory.isEmpty)
    }

    // MARK: Processing the synthetic apartment

    func testSyntheticApartmentBecomesAWalkthrough() throws {
        let scan = SyntheticApartment.make()
        let result = try ScanProcessor.process(scan, options: fast)
        let m = result.manifest

        XCTAssertEqual(m.schema, "atrium.scan-manifest/v1")
        XCTAssertEqual(m.floors.count, 1)
        XCTAssertEqual(m.floors[0].name, "Main Level")
        XCTAssertEqual(m.floors[0].elevation, 0, accuracy: 1e-6)  // normalized: lowest floor at y = 0
        XCTAssertEqual(m.rooms.count, 6)
        XCTAssertEqual(m.rooms.map(\.order), Array(0..<6))
        // Visit order follows the walk: living room, kitchen, hallway, bedroom, bathroom, primary.
        XCTAssertEqual(m.rooms.map(\.name), ["Living Room", "Kitchen", "Hallway", "Bedroom", "Bathroom", "Primary Bedroom"])

        let byName = Dictionary(uniqueKeysWithValues: m.rooms.map { ($0.name, $0) })
        let pairs = Set(m.links.map { link -> String in
            let a = m.rooms.first { $0.key == link.from }!.name, b = m.rooms.first { $0.key == link.to }!.name
            return [a, b].sorted().joined(separator: "+")
        })
        XCTAssertEqual(
            pairs,
            ["Hallway+Living Room", "Kitchen+Living Room", "Bedroom+Hallway", "Bathroom+Hallway", "Hallway+Primary Bedroom"])
        XCTAssertTrue(m.links.allSatisfy { $0.via.allSatisfy { abs($0[1] - 1.6) < 1e-6 } })

        for room in m.rooms {
            let footprint = room.footprint!.map { P2($0[0], $0[1]) }
            let p = room.waypoint.position
            XCTAssertTrue(pointInPolygon(P2(p[0], p[2]), footprint), "\(room.name) viewpoint outside its room")
            XCTAssertEqual(p[1], 1.6, accuracy: 1e-6)
            XCTAssertTrue(room.waypoint.yaw.isFinite)
        }
        // Normalization lined the walls up with the axes again.
        for (x, z) in byName["Living Room"]!.footprint!.map({ ($0[0], $0[1]) }) {
            XCTAssertTrue(byName["Living Room"]!.footprint!.contains { abs($0[0] - x) < 1e-3 && abs($0[1] - z) > 1 })
        }

        XCTAssertEqual(result.stats.rooms, 6)
        XCTAssertEqual(result.stats.floorArea, 64.4, accuracy: 0.5)
        XCTAssertGreaterThan(result.stats.triangles, 1000)
        try assertValidGLB(result.glb, expectRooms: 6)
    }

    func testViewpointsKeepClearOfFurniture() throws {
        let result = try ScanProcessor.process(SyntheticApartment.make(), options: fast)
        let scan = SyntheticApartment.make().transformed(by: result.frame)
        for room in result.manifest.rooms {
            let p = P2(room.waypoint.position[0], room.waypoint.position[2])
            for o in scan.objects where o.size.y > 0.3 {
                let hx = o.size.x / 2, hz = o.size.z / 2
                let box = [Vec3(-hx, 0, -hz), Vec3(hx, 0, -hz), Vec3(hx, 0, hz), Vec3(-hx, 0, hz)].map { plan(o.transform.apply($0)) }
                XCTAssertFalse(pointInPolygon(p, box), "\(room.name) viewpoint is inside a \(o.category)")
            }
        }
    }

    // MARK: Walls and openings

    func testPartitionFacesShareTheGap() throws {
        let walls = Layout.walls(from: twoRoomScan(withDoorOnBothSides: false), rooms: Layout.rooms(from: twoRoomScan(withDoorOnBothSides: false)), defaultThickness: 0.12)
        let partition = walls.filter { abs($0.a.x - 3) < 0.2 && abs($0.b.x - 3) < 0.2 }
        XCTAssertEqual(partition.count, 2)
        for w in partition { XCTAssertEqual(w.thickness, 0.07, accuracy: 1e-6) }
        let outer = walls.filter { abs($0.a.y - $0.b.y) < 1e-6 && abs($0.a.y) < 1e-6 }
        XCTAssertTrue(outer.allSatisfy { abs($0.thickness - 0.12) < 1e-9 })
    }

    func testDoorScannedFromOneSideCutsBothFaces() throws {
        let scan = twoRoomScan(withDoorOnBothSides: false)
        let rooms = Layout.rooms(from: scan)
        var walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        Layout.cutOpenings(scan.openings, into: &walls)
        let holed = walls.filter { !$0.holes.isEmpty }
        XCTAssertEqual(holed.count, 2)
        XCTAssertEqual(holed.filter { $0.holes[0].primary }.count, 1)
        for w in holed {
            XCTAssertEqual(w.holes[0].y0, w.y0, accuracy: 1e-6)  // doors reach the floor
            XCTAssertEqual(w.holes[0].s1 - w.holes[0].s0, 0.9, accuracy: 1e-4)
        }
        let result = try ScanProcessor.process(scan, options: fast)
        XCTAssertEqual(result.manifest.links.count, 1)
        XCTAssertEqual(result.manifest.links[0].kind, "door")
    }

    func testOpenPlanRoomsAreLinkedByTheWalkedPath() throws {
        var scan = twoRoomScan(withDoorOnBothSides: false)
        scan.openings = []
        scan.walls = []
        scan.trajectory = (0...40).map { i in
            PoseSample(t: Double(i) * 0.25, p: Vec3(0.5 + Float(i) * 0.12, 1.4, 1.5), f: Vec3(1, 0, 0))
        }
        let m = try ScanProcessor.process(scan, options: fast).manifest
        XCTAssertEqual(m.links.count, 1)
        XCTAssertNil(m.links[0].kind)
        XCTAssertGreaterThanOrEqual(m.links[0].via.count, 2)
        XCTAssertLessThanOrEqual(m.links[0].via.count, 8)
    }

    func testOpenPlanRoomsAreLinkedWithoutAPath() throws {
        var scan = twoRoomScan(withDoorOnBothSides: false)
        scan.openings = []
        // Drop the partition (room a's east wall, room b's west wall): one open space scanned as two rooms.
        scan.walls.removeAll { $0.id == "a1" || $0.id == "b3" }
        let m = try ScanProcessor.process(scan, options: fast).manifest
        XCTAssertEqual(m.links.count, 1)
        let via = m.links[0].via
        XCTAssertLessThan(via[0][0], via[1][0] + 1e-9 + (m.links[0].from == "a" ? 0 : 10))
        // With the partition in place and no door, the rooms stay unlinked.
        var closed = twoRoomScan(withDoorOnBothSides: false)
        closed.openings = []
        XCTAssertTrue(try ScanProcessor.process(closed, options: fast).manifest.links.isEmpty)
    }

    func testRoomsAreGroupedIntoLevels() throws {
        var scan = twoRoomScan(withDoorOnBothSides: true)
        let upstairs = scan.rooms[1]
        scan.rooms[1].floorPolygon = upstairs.floorPolygon.map { Vec3($0.x, $0.y + 2.9, $0.z) }
        scan.rooms[1].floorY += 2.9
        scan.rooms[1].ceilingY += 2.9
        let m = try ScanProcessor.process(scan, options: fast).manifest
        XCTAssertEqual(m.floors.map(\.name), ["Main Level", "Upper Level"])
        XCTAssertEqual(m.floors[1].elevation, 2.9, accuracy: 1e-4)
        XCTAssertEqual(Set(m.rooms.map(\.floor)), ["level-1", "level-2"])
    }

    // MARK: Robustness

    func testRejectsScansWithoutRoomsOrInTheWrongFormat() {
        XCTAssertThrowsError(try ScanProcessor.process(CaptureScan(rooms: []), options: fast)) { error in
            XCTAssertEqual(error as? ScanProcessingError, .noRooms)
        }
        var scan = twoRoomScan(withDoorOnBothSides: true)
        scan.format = "something-else/v9"
        XCTAssertThrowsError(try ScanProcessor.process(scan, options: fast)) { error in
            XCTAssertEqual(error as? ScanProcessingError, .unsupportedFormat("something-else/v9"))
        }
    }

    func testNonFiniteValuesAreDroppedNotFatal() throws {
        var scan = twoRoomScan(withDoorOnBothSides: true)
        scan.walls.append(ScanWall(id: "bad", transform: Transform(columnMajor: Array(repeating: .nan, count: 16)), width: 2, height: 2))
        scan.objects.append(ScanObject(id: "bad", category: "sofa", transform: .identity, size: Vec3(.infinity, 1, 1)))
        scan.trajectory.append(PoseSample(t: .nan, p: Vec3(0, 0, 0), f: Vec3(0, 0, -1)))
        XCTAssertNoThrow(try scan.jsonData())
        let result = try ScanProcessor.process(scan, options: fast)
        XCTAssertEqual(result.stats.rooms, 2)
        try assertValidGLB(result.glb, expectRooms: 2)
    }

    // MARK: Helpers

    /// Two 3 m × 3 m rooms side by side, a 0.14 m partition at x = 3…3.14, a door in it.
    func twoRoomScan(withDoorOnBothSides: Bool) -> CaptureScan {
        func rect(_ x0: Float, _ x1: Float) -> [Vec3] { [Vec3(x0, 0, 0), Vec3(x1, 0, 0), Vec3(x1, 0, 3), Vec3(x0, 0, 3)] }
        let rooms = [
            ScanRoom(id: "a", name: "Living Room", captureIndex: 0, floorPolygon: rect(0, 3), floorY: 0, ceilingY: 2.5),
            ScanRoom(id: "b", name: "Kitchen", captureIndex: 1, floorPolygon: rect(3.14, 6.14), floorY: 0, ceilingY: 2.5),
        ]
        var walls: [ScanWall] = []
        var openings: [ScanOpening] = []
        for (room, x0, x1) in [("a", Float(0), Float(3)), ("b", Float(3.14), Float(6.14))] {
            let corners = [(x0, Float(0)), (x1, 0), (x1, 3), (x0, 3)]
            for k in 0..<4 {
                let a = corners[k], b = corners[(k + 1) % 4]
                walls.append(
                    ScanWall(
                        id: "\(room)\(k)", roomId: room,
                        transform: SyntheticApartment.surfaceTransform(from: (Double(a.0), Double(a.1)), to: (Double(b.0), Double(b.1)), centerY: 1.25, flip: k == 1),
                        width: 3, height: 2.5))
            }
        }
        // Room a's east wall is "a1", room b's west wall is "b3".
        openings.append(
            ScanOpening(
                id: "d1", kind: .door, isOpen: true, wallId: "a1", roomId: "a",
                transform: SyntheticApartment.surfaceTransform(from: (3, 1.05), to: (3, 1.95), centerY: 1.025, flip: false), width: 0.9, height: 2.05))
        if withDoorOnBothSides {
            openings.append(
                ScanOpening(
                    id: "d2", kind: .door, isOpen: true, wallId: "b3", roomId: "b",
                    transform: SyntheticApartment.surfaceTransform(from: (3.14, 1.95), to: (3.14, 1.05), centerY: 1.025, flip: false), width: 0.9,
                    height: 2.05))
        }
        return CaptureScan(rooms: rooms, walls: walls, openings: openings)
    }

    func readUInt32BE(_ d: Data, _ o: Int) -> UInt32 {
        let b = [UInt8](d[(d.startIndex + o)..<(d.startIndex + o + 4)])
        return (UInt32(b[0]) << 24) | (UInt32(b[1]) << 16) | (UInt32(b[2]) << 8) | UInt32(b[3])
    }

    func readUInt32LE(_ d: Data, _ o: Int) -> UInt32 {
        let b = [UInt8](d[(d.startIndex + o)..<(d.startIndex + o + 4)])
        return (UInt32(b[3]) << 24) | (UInt32(b[2]) << 16) | (UInt32(b[1]) << 8) | UInt32(b[0])
    }

    /// Structural checks a glTF validator would make on our output.
    func assertValidGLB(_ glb: Data, expectRooms: Int, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(readUInt32LE(glb, 0), 0x4654_6C67, "magic", file: file, line: line)
        XCTAssertEqual(readUInt32LE(glb, 4), 2, file: file, line: line)
        XCTAssertEqual(Int(readUInt32LE(glb, 8)), glb.count, file: file, line: line)
        let jsonLength = Int(readUInt32LE(glb, 12))
        XCTAssertEqual(readUInt32LE(glb, 16), 0x4E4F_534A, file: file, line: line)
        XCTAssertEqual(jsonLength % 4, 0, file: file, line: line)
        let json = try JSONSerialization.jsonObject(with: glb.subdata(in: 20..<(20 + jsonLength))) as! [String: Any]
        let binHeader = 20 + jsonLength
        let binLength = Int(readUInt32LE(glb, binHeader))
        XCTAssertEqual(readUInt32LE(glb, binHeader + 4), 0x004E_4942, file: file, line: line)
        XCTAssertEqual(binLength % 4, 0, file: file, line: line)
        XCTAssertEqual(binHeader + 8 + binLength, glb.count, file: file, line: line)

        let buffers = json["buffers"] as! [[String: Any]]
        XCTAssertEqual(buffers[0]["byteLength"] as? Int, binLength, file: file, line: line)
        let views = json["bufferViews"] as! [[String: Any]]
        for v in views {
            let offset = v["byteOffset"] as! Int, length = v["byteLength"] as! Int
            XCTAssertEqual(offset % 4, 0, file: file, line: line)
            XCTAssertLessThanOrEqual(offset + length, binLength, file: file, line: line)
        }
        let accessors = json["accessors"] as! [[String: Any]]
        let sizes: [String: Int] = ["SCALAR": 1, "VEC2": 2, "VEC3": 3]
        for a in accessors {
            let view = views[a["bufferView"] as! Int]
            let count = a["count"] as! Int
            XCTAssertEqual(count * sizes[a["type"] as! String]! * 4, view["byteLength"] as! Int, file: file, line: line)
        }
        for mesh in json["meshes"] as! [[String: Any]] {
            for prim in mesh["primitives"] as! [[String: Any]] {
                let attrs = prim["attributes"] as! [String: Int]
                let position = accessors[attrs["POSITION"]!]
                XCTAssertNotNil(position["min"], file: file, line: line)
                let vertexCount = position["count"] as! Int
                // Unlit (photo) models carry no normals.
                if let normal = attrs["NORMAL"] { XCTAssertEqual(accessors[normal]["count"] as? Int, vertexCount, file: file, line: line) }
                XCTAssertEqual(accessors[attrs["TEXCOORD_0"]!]["count"] as? Int, vertexCount, file: file, line: line)
                // Every index points at a vertex.
                let indices = accessors[prim["indices"] as! Int]
                let iv = views[indices["bufferView"] as! Int]
                let start = 20 + jsonLength + 8 + (iv["byteOffset"] as! Int)
                let maxIndex = (0..<(indices["count"] as! Int)).map { readUInt32LE(glb, start + $0 * 4) }.max() ?? 0
                XCTAssertLessThan(Int(maxIndex), vertexCount, file: file, line: line)
            }
        }
        let scenes = json["scenes"] as! [[String: Any]]
        let atrium = (scenes[0]["extras"] as! [String: Any])["atrium"] as! [String: Any]
        XCTAssertEqual(atrium["schema"] as? String, "atrium.scan-manifest/v1", file: file, line: line)
        XCTAssertEqual((atrium["rooms"] as? [Any])?.count, expectRooms, file: file, line: line)
        let lights = ((json["extensions"] as? [String: Any])?["KHR_lights_punctual"] as? [String: Any])?["lights"] as? [Any]
        XCTAssertEqual(lights?.count, expectRooms, file: file, line: line)
    }
}
