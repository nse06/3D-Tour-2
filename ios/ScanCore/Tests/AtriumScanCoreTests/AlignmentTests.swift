import Foundation
import XCTest

@testable import AtriumScanCore

/// Multi-room scans as RoomPlan delivers them: every room (and the path recorded
/// from its start) relative to where the phone was when that room's scan began.
final class AlignmentTests: XCTestCase {
    /// The synthetic apartment, re-expressed the way RoomPlan reports it. Room k
    /// starts at the first path sample inside it; its frame's origin is the
    /// phone's position there.
    struct Scrambled {
        var truth: CaptureScan
        var parts: [RoomPart]
        var path: [PoseSample]
        /// Each room's frame origin in the true frame.
        var origins: [Vec3]
        /// Path index where each room's run starts.
        var starts: [Int]
    }

    static func scramble(_ truth: CaptureScan, tagged: Bool, path override: [PoseSample]? = nil) -> Scrambled {
        let path = override ?? truth.trajectory
        let polys = truth.rooms.map { $0.floorPolygon.map(plan) }
        var starts: [Int] = [0]
        for k in 1..<truth.rooms.count {
            let first = path.indices.first { i in i > starts[k - 1] && pointInPolygon(plan(path[i].p), polys[k]) }!
            starts.append(first)
        }
        let origins = starts.map { path[$0].p }
        var parts: [RoomPart] = []
        for (k, room) in truth.rooms.enumerated() {
            let shift = Transform.translating(-origins[k])
            var r = room
            r.floorPolygon = room.floorPolygon.map(shift.apply)
            r.floorY -= origins[k].y
            r.ceilingY -= origins[k].y
            parts.append(
                RoomPart(
                    room: r, walls: truth.walls.filter { $0.roomId == room.id }.map { var w = $0; w.transform = shift * $0.transform; return w },
                    openings: truth.openings.filter { $0.roomId == room.id }.map { var o = $0; o.transform = shift * $0.transform; return o },
                    objects: truth.objects.filter { $0.roomId == room.id }.map { var o = $0; o.transform = shift * $0.transform; return o },
                    segment: tagged ? k : nil))
        }
        let scrambledPath = path.indices.map { i -> PoseSample in
            let k = starts.lastIndex { $0 <= i }!
            return PoseSample(t: path[i].t, p: path[i].p - origins[k], f: path[i].f, segment: tagged ? k : nil)
        }
        return Scrambled(truth: truth, parts: parts, path: scrambledPath, origins: origins, starts: starts)
    }

    /// Largest distance between matching wall/opening/object centers of two scans, after moving `a` by `m`.
    func maxError(_ a: CaptureScan, _ b: CaptureScan, through m: Motion = .identity) -> Float {
        var worst: Float = 0
        let bWalls = Dictionary(uniqueKeysWithValues: b.walls.map { ($0.id, $0.transform.translation) })
        let bOpenings = Dictionary(uniqueKeysWithValues: b.openings.map { ($0.id, $0.transform.translation) })
        let bObjects = Dictionary(uniqueKeysWithValues: b.objects.map { ($0.id, $0.transform.translation) })
        for w in a.walls { worst = max(worst, vlength(m.apply(w.transform.translation) - bWalls[w.id]!)) }
        for o in a.openings { worst = max(worst, vlength(m.apply(o.transform.translation) - bOpenings[o.id]!)) }
        for o in a.objects { worst = max(worst, vlength(m.apply(o.transform.translation) - bObjects[o.id]!)) }
        return worst
    }

    /// Per room (by name): the largest element error of `b` against `a` moved by `m`.
    func roomErrors(_ a: CaptureScan, _ b: CaptureScan, through m: Motion = .identity) -> [String: Float] {
        var out: [String: Float] = [:]
        for room in a.rooms {
            var one = a
            one.walls = a.walls.filter { $0.roomId == room.id }
            one.openings = a.openings.filter { $0.roomId == room.id }
            one.objects = a.objects.filter { $0.roomId == room.id }
            out[room.name] = maxError(one, b, through: m)
        }
        return out
    }

    func testMotionComposesLikeTransforms() {
        let a = Motion(yaw: 0.7, t: Vec3(1, 2, 3)), b = Motion(yaw: -2.1, t: Vec3(-0.5, 0.25, 4))
        let p = Vec3(0.3, -1.2, 2.2)
        let viaTransforms = (a.transform * b.transform).apply(p)
        XCTAssertLessThan(vlength(a.after(b).apply(p) - viaTransforms), 1e-4)
        XCTAssertLessThan(vlength(a.apply(p) - a.transform.apply(p)), 1e-5)
        XCTAssertLessThan(vlength(a.inverse.apply(a.apply(p)) - p), 1e-5)
        XCTAssertEqual(wrapAngle(3 * .pi), .pi, accuracy: 1e-9)
        XCTAssertEqual(wrapAngle(-.pi), .pi, accuracy: 1e-9)
    }

    func testScrambledRoomsReallyOverlap() {
        // The bug this file fixes: rooms taken as-is pile up around the origin.
        let s = Self.scramble(SyntheticApartment.make(), tagged: false)
        let asIs = s.parts.map { $0.room.floorPolygon.map(plan) }
        let centers = asIs.map(centroid)
        let spread = centers.map { plength($0 - centers[0]) }.max()!
        let trueCenters = s.truth.rooms.map { centroid($0.floorPolygon.map(plan)) }
        let trueSpread = trueCenters.map { plength($0 - trueCenters[0]) }.max()!
        XCTAssertLessThan(spread, trueSpread * 0.8)
    }

    func testStructureFitRestoresTheLayout() throws {
        let truth = SyntheticApartment.make()
        let s = Self.scramble(truth, tagged: false)
        // StructureBuilder's frame: any rigid motion of the truth.
        let g = Motion(yaw: 0.9, t: Vec3(3, 0.4, -2))
        var structure: [String: Transform] = [:]
        for w in truth.walls { structure[w.id] = g.transform * w.transform }
        for o in truth.openings { structure[o.id] = g.transform * o.transform }
        for o in truth.objects { structure[o.id] = g.transform * o.transform }

        let result = RoomAlignment.align(parts: s.parts, structure: structure, path: s.path, frames: [])
        XCTAssertLessThan(maxError(truth, result.scan, through: g), 0.002)
        XCTAssertEqual(result.report.rooms.map(\.method), Array(repeating: .structure, count: truth.rooms.count))
        XCTAssertEqual(result.report.pathResets, truth.rooms.count - 1)
        XCTAssertGreaterThanOrEqual(result.report.doorwayPairs, 3)
        XCTAssertTrue(result.report.rooms.allSatisfy { $0.doorwayShift < 0.005 }, "\(result.report.rooms.map(\.doorwayShift))")
        // The path follows its rooms.
        XCTAssertEqual(result.scan.trajectory.count, truth.trajectory.count)
        for (a, b) in zip(result.scan.trajectory, truth.trajectory) { XCTAssertLessThan(vlength(a.p - g.apply(b.p)), 0.002) }
        XCTAssertTrue(result.report.summary.contains("RoomPlan's merged layout"), result.report.summary)

        // Processed, the rooms no longer overlap.
        let processed = try ScanProcessor.process(result.scan, options: ScanProcessorOptions(textureSize: 32))
        XCTAssertEqual(processed.stats.floorArea, try ScanProcessor.process(truth, options: ScanProcessorOptions(textureSize: 32)).stats.floorArea, accuracy: 0.01)
    }

    func testStructureFitToleratesMergedWalls() {
        let truth = SyntheticApartment.make()
        let s = Self.scramble(truth, tagged: true)
        var structure: [String: Transform] = [:]
        for (i, w) in truth.walls.enumerated() {
            // The merge extends some walls (center moves along the wall) and drops others.
            if i % 5 == 0 { continue }
            let slide = i % 3 == 0 ? Float(0.4) : 0
            structure[w.id] = Transform.translating(w.transform.xAxis * slide) * w.transform
        }
        for o in truth.objects.enumerated() where o.offset % 2 == 0 { structure[o.element.id] = o.element.transform }
        let result = RoomAlignment.align(parts: s.parts, structure: structure, path: s.path, frames: [])
        XCTAssertLessThan(maxError(truth, result.scan), 0.01)
    }

    func testPathLinksPlaceRoomsWithoutStructure() {
        // An old capture: nothing tagged, 4 Hz path, no merged structure.
        let truth = SyntheticApartment.make()
        let s = Self.scramble(truth, tagged: false)
        let result = RoomAlignment.align(parts: s.parts, structure: nil, path: s.path, frames: [])
        XCTAssertEqual(result.report.pathResets, truth.rooms.count - 1)
        XCTAssertTrue(result.report.rooms.allSatisfy { $0.method == .path }, "\(result.report.rooms.map(\.method))")
        // Placed relative to the first room's frame.
        let back = Motion(yaw: 0, t: -s.origins[0])
        XCTAssertLessThan(maxError(truth, result.scan, through: back), 0.08)
        XCTAssertEqual(result.scan.trajectory.count, truth.trajectory.count)
        let jumps = zip(result.scan.trajectory, result.scan.trajectory.dropFirst()).map { vlength($1.p - $0.p) }
        XCTAssertLessThan(jumps.max()!, 0.3)
    }

    func testTaggedRunsFindTheLateReset() {
        // A new capture: 30 Hz path, every sample tagged with its run, but each
        // reset lands a few frames after the tag changes.
        let truth = SyntheticApartment.make()
        var dense: [PoseSample] = []
        for (a, b) in zip(truth.trajectory, truth.trajectory.dropFirst()) {
            for k in 0..<8 {
                let f = Float(k) / 8
                dense.append(PoseSample(t: a.t + (b.t - a.t) * Double(f), p: a.p + (b.p - a.p) * f, f: a.f))
            }
        }
        var s = Self.scramble(truth, tagged: true, path: dense)
        let late = 4
        for k in 1..<s.starts.count {
            for i in (s.starts[k] - late)..<s.starts[k] {
                s.path[i].segment = k  // tagged with the new run, still in the old frame
            }
        }
        // Photos taken with path samples, including inside those late windows.
        let frames = stride(from: 3, to: s.path.count, by: 37).map { i in
            CameraFrame(
                file: "frames/\(i).jpg", t: s.path[i].t, transform: Transform.translating(s.path[i].p), intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1], width: 4,
                height: 3, imageWidth: 4, imageHeight: 3, segment: s.path[i].segment)
        } + (1..<s.starts.count).map { k in
            let i = s.starts[k] - 2
            return CameraFrame(
                file: "frames/late\(k).jpg", t: s.path[i].t, transform: Transform.translating(s.path[i].p), intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1],
                width: 4, height: 3, imageWidth: 4, imageHeight: 3, segment: k)
        }
        let result = RoomAlignment.align(parts: s.parts, structure: nil, path: s.path, frames: frames)
        XCTAssertEqual(result.report.pathResets, truth.rooms.count - 1)
        let back = Motion(yaw: 0, t: -s.origins[0])
        XCTAssertLessThan(maxError(truth, result.scan, through: back), 0.03)
        let jumps = zip(result.scan.trajectory, result.scan.trajectory.dropFirst()).map { vlength($1.p - $0.p) }
        XCTAssertLessThan(jumps.max()!, 0.1)
        // Every photo lands on the true path.
        XCTAssertEqual(result.scan.frames.count, frames.count)
        for f in result.scan.frames {
            let i = dense.indices.min { abs(dense[$0].t - f.t) < abs(dense[$1].t - f.t) }!
            XCTAssertLessThan(vlength(f.transform.translation - back.apply(dense[i].p)), 0.03, f.file)
        }
    }

    func testDoorwaySnappingRemovesDrift() {
        let truth = SyntheticApartment.make()
        var s = Self.scramble(truth, tagged: true)
        // Tracking drifted while scanning the hallway: it comes out 22 cm off.
        let drift = Transform.translating(Vec3(0.17, 0, -0.14))
        let hall = 2
        s.parts[hall].walls = s.parts[hall].walls.map { var w = $0; w.transform = drift * $0.transform; return w }
        s.parts[hall].openings = s.parts[hall].openings.map { var o = $0; o.transform = drift * $0.transform; return o }
        s.parts[hall].objects = s.parts[hall].objects.map { var o = $0; o.transform = drift * $0.transform; return o }
        s.parts[hall].room.floorPolygon = s.parts[hall].room.floorPolygon.map(drift.apply)
        let result = RoomAlignment.align(parts: s.parts, structure: nil, path: s.path, frames: [])
        XCTAssertGreaterThanOrEqual(result.report.doorwayPairs, 3)
        let back = Motion(yaw: 0, t: -s.origins[0])
        // The hallway's doors line up with their other sides again; the rooms it connects stay put.
        let errors = roomErrors(truth, result.scan, through: back)
        for name in ["Living Room", "Hallway", "Bedroom", "Primary Bedroom"] { XCTAssertLessThan(errors[name]!, 0.01, name) }
        // Rooms without a two-sided doorway keep their path-based placement (a few cm at 4 Hz).
        XCTAssertLessThan(errors.values.max()!, 0.06, "\(errors)")
        XCTAssertEqual(result.report.rooms[hall].doorwayShift, 0.22, accuracy: 0.01)
    }

    func testRescannedRoomLeavesAnExtraRunThatIsSkipped() {
        // An old capture where the bedroom was scanned twice: the first attempt's
        // run shows up in the path but has no room.
        let truth = SyntheticApartment.make()
        let s = Self.scramble(truth, tagged: false)
        var path = s.path
        let bedroom = 3
        let restart = s.starts[bedroom] + 16
        // From `restart` on, the bedroom's run starts over where the phone is.
        let origin = path[restart].p
        for i in restart..<(bedroom + 1 < s.starts.count ? s.starts[bedroom + 1] : path.count) { path[i].p -= origin }
        var parts = s.parts
        // The kept room is the second attempt's: in the frame starting at `restart`.
        parts[bedroom] = parts[bedroom].moved(by: Motion(yaw: 0, t: -origin))
        let result = RoomAlignment.align(parts: parts, structure: nil, path: path, frames: [])
        XCTAssertEqual(result.report.segments, truth.rooms.count + 1)
        XCTAssertEqual(result.report.rooms[bedroom].segment, bedroom + 1)
        let back = Motion(yaw: 0, t: -s.origins[0])
        let errors = roomErrors(truth, result.scan, through: back)
        XCTAssertLessThan(errors.values.max()!, 0.1, "\(errors)")
    }

    func testSingleRoomAndSharedFrameScansAreKeptAsRecorded() {
        let truth = SyntheticApartment.make()
        // Rooms already in one frame (e.g. the demo, or Apple's sample data): nothing to undo.
        let parts = truth.rooms.map { room in
            RoomPart(
                room: room, walls: truth.walls.filter { $0.roomId == room.id }, openings: truth.openings.filter { $0.roomId == room.id },
                objects: truth.objects.filter { $0.roomId == room.id })
        }
        let result = RoomAlignment.align(parts: parts, structure: nil, path: [], frames: [])
        XCTAssertLessThan(maxError(truth, result.scan), 0.001)
        XCTAssertTrue(result.report.rooms.allSatisfy { $0.method == .asRecorded })
        let one = RoomAlignment.align(parts: [parts[0]], structure: nil, path: truth.trajectory, frames: [])
        XCTAssertEqual(one.report.rooms.first?.method, .asRecorded)
        XCTAssertEqual(one.scan.trajectory.count, truth.trajectory.count)
    }

    func testRawPathAndFramesRoundTripAsJSON() throws {
        let sample = PoseSample(t: 1.5, p: Vec3(1, 2, 3), f: Vec3(0, 0, -1), segment: 2)
        let decoded = try JSONDecoder().decode(PoseSample.self, from: JSONEncoder().encode(sample))
        XCTAssertEqual(decoded, sample)
        // Old samples and frames (no segment) still read.
        let old = try JSONDecoder().decode(PoseSample.self, from: Data(#"{"t":0.5,"p":[0,1,0],"f":[0,0,-1]}"#.utf8))
        XCTAssertNil(old.segment)
        let frame = try JSONDecoder().decode(
            CameraFrame.self,
            from: Data(
                #"{"file":"frames/000001.jpg","t":2,"transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"intrinsics":[1,0,0,0,1,0,0,0,1],"width":1920,"height":1440,"imageWidth":1280,"imageHeight":960}"#
                    .utf8))
        XCTAssertEqual(frame.imageWidth, 1280)
        XCTAssertNil(frame.segment)
    }
}
