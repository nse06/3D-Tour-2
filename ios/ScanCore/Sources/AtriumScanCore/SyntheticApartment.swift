import Foundation

/// A realistic two-bedroom apartment scan, generated the way the iPhone app
/// reports a RoomPlan capture: every room lists its own walls (so partitions
/// appear twice, once per side), doors appear on one or both sides, and the
/// path walked from room to room is recorded. Placed in an arbitrary ARKit-like
/// world frame (rotated, floor 1.4 m below the start). Used by tests and by
/// `scanproc demo-scan`.
public enum SyntheticApartment {
    struct RoomSpec {
        let name: String
        let label: String?
        let x: (Double, Double)
        let z: (Double, Double)
    }

    struct OpeningSpec {
        let kind: ScanOpening.Kind
        /// Index of the room whose wall carries it, and which side of that room ("n", "s", "e", "w").
        let sides: [(room: Int, side: Character)]
        /// Center along the wall (x for n/s walls, z for e/w walls).
        let at: Double
        let width: Double
        let bottom: Double
        let height: Double
    }

    static let ceiling = 2.6

    static let rooms: [RoomSpec] = [
        RoomSpec(name: "Living Room", label: "livingRoom", x: (0, 5.0), z: (0, 4.2)),
        RoomSpec(name: "Kitchen", label: "kitchen", x: (5.12, 8.2), z: (0, 4.2)),
        RoomSpec(name: "Hallway", label: nil, x: (3.0, 8.2), z: (4.32, 5.52)),
        RoomSpec(name: "Bedroom", label: "bedroom", x: (0, 2.88), z: (4.32, 8.0)),
        RoomSpec(name: "Bathroom", label: "bathroom", x: (3.0, 5.4), z: (5.64, 8.0)),
        RoomSpec(name: "Primary Bedroom", label: "bedroom", x: (5.52, 8.2), z: (5.64, 8.6)),
    ]

    static let openings: [OpeningSpec] = [
        // Living ↔ hallway door, scanned from both sides.
        OpeningSpec(kind: .door, sides: [(0, "s"), (2, "n")], at: 4.0, width: 0.9, bottom: 0, height: 2.05),
        // Living ↔ kitchen: a wide cased opening, scanned from the living room only.
        OpeningSpec(kind: .opening, sides: [(0, "e")], at: 2.0, width: 1.8, bottom: 0, height: 2.15),
        // Hallway doors.
        OpeningSpec(kind: .door, sides: [(2, "w"), (3, "e")], at: 4.92, width: 0.85, bottom: 0, height: 2.05),
        OpeningSpec(kind: .door, sides: [(2, "s")], at: 4.2, width: 0.8, bottom: 0, height: 2.05),
        OpeningSpec(kind: .door, sides: [(2, "s"), (5, "n")], at: 6.8, width: 0.85, bottom: 0, height: 2.05),
        // Front door (to the building corridor: no room beyond).
        OpeningSpec(kind: .door, sides: [(2, "e")], at: 4.92, width: 0.95, bottom: 0, height: 2.1),
        // Windows on exterior walls.
        OpeningSpec(kind: .window, sides: [(0, "n")], at: 1.3, width: 1.5, bottom: 0.7, height: 1.55),
        OpeningSpec(kind: .window, sides: [(0, "w")], at: 2.1, width: 1.4, bottom: 0.7, height: 1.55),
        OpeningSpec(kind: .window, sides: [(1, "n")], at: 6.6, width: 1.2, bottom: 1.05, height: 1.1),
        OpeningSpec(kind: .window, sides: [(3, "s")], at: 0.9, width: 1.0, bottom: 0.8, height: 1.4),
        OpeningSpec(kind: .window, sides: [(4, "s")], at: 4.2, width: 0.6, bottom: 1.45, height: 0.6),
        OpeningSpec(kind: .window, sides: [(5, "s")], at: 6.9, width: 1.6, bottom: 0.8, height: 1.4),
        OpeningSpec(kind: .window, sides: [(5, "e")], at: 7.2, width: 1.2, bottom: 0.8, height: 1.4),
    ]

    /// (category, room, center x, center z, size x, size y, size z); bottoms on the floor except where `elevated` says.
    static let furniture: [(String, Int, Double, Double, Double, Double, Double)] = [
        ("sofa", 0, 3.0, 3.72, 2.2, 0.85, 0.9),
        ("chair", 0, 1.0, 2.7, 0.8, 0.8, 0.8),
        ("table", 0, 3.0, 2.6, 1.1, 0.42, 0.6),
        ("storage", 0, 3.4, 0.22, 1.6, 0.5, 0.42),
        ("television", 0, 3.4, 0.08, 1.3, 0.75, 0.06),
        ("storage", 1, 7.9, 1.65, 0.6, 0.9, 0.5),
        ("sink", 1, 7.9, 2.3, 0.6, 0.9, 0.8),
        ("storage", 1, 7.9, 2.95, 0.6, 0.9, 0.5),
        ("stove", 1, 7.9, 1.05, 0.6, 0.92, 0.7),
        ("refrigerator", 1, 7.85, 3.7, 0.7, 1.8, 0.75),
        ("table", 1, 6.3, 2.2, 0.9, 0.75, 1.5),
        ("chair", 1, 5.75, 1.85, 0.45, 0.9, 0.45),
        ("chair", 1, 5.75, 2.55, 0.45, 0.9, 0.45),
        ("chair", 1, 6.85, 1.85, 0.45, 0.9, 0.45),
        ("chair", 1, 6.85, 2.55, 0.45, 0.9, 0.45),
        ("storage", 2, 5.9, 4.55, 1.0, 0.5, 0.4),
        ("bed", 3, 1.1, 6.4, 2.05, 0.55, 1.6),
        ("storage", 3, 0.25, 5.3, 0.45, 0.55, 0.45),
        ("storage", 3, 0.25, 7.5, 0.45, 0.55, 0.45),
        ("storage", 3, 2.2, 7.65, 1.2, 2.0, 0.6),
        ("toilet", 4, 3.35, 7.6, 0.4, 0.75, 0.65),
        ("bathtub", 4, 5.0, 6.9, 0.75, 0.55, 1.7),
        ("sink", 4, 3.27, 6.3, 0.5, 0.85, 0.8),
        ("bed", 5, 6.86, 7.5, 1.8, 0.55, 2.1),
        ("storage", 5, 7.95, 6.4, 0.5, 0.8, 1.2),
    ]

    /// The walk: through every room, via the doorways.
    static let path: [(Double, Double)] = [
        (2.0, 2.0), (1.0, 1.4), (3.6, 1.6), (4.3, 2.0), (5.06, 2.0), (6.0, 1.4), (6.9, 1.0), (6.9, 3.5), (6.0, 3.4), (5.06, 2.4),
        (4.2, 3.1), (4.0, 3.95), (4.0, 4.26), (4.0, 4.92), (3.4, 4.92), (2.94, 4.92), (2.5, 5.2), (2.55, 6.9), (2.6, 5.3), (2.94, 4.92),
        (3.7, 4.92), (4.2, 4.92), (4.2, 5.58), (4.2, 6.6), (3.7, 7.0), (4.2, 6.3), (4.2, 5.58), (5.4, 4.92), (6.8, 4.92), (6.8, 5.58),
        (6.8, 6.1), (5.8, 6.2), (5.75, 7.8), (6.4, 6.2), (7.5, 6.0),
    ]

    public static func make(rotation: Float = 0.41, offset: Vec3 = Vec3(1.3, -1.42, -2.1), walkingSpeed: Double = 0.55) -> CaptureScan {
        var scanRooms: [ScanRoom] = []
        var walls: [ScanWall] = []
        var wallIds: [Int: [Character: String]] = [:]
        var scanOpenings: [ScanOpening] = []
        var objects: [ScanObject] = []
        var counter = 0
        func nextId(_ prefix: String) -> String {
            counter += 1
            let digits = String(counter)
            return "\(prefix)-0000-4000-8000-" + String(repeating: "0", count: max(0, 12 - digits.count)) + digits
        }

        for (i, r) in rooms.enumerated() {
            let id = nextId("A0000001")
            let corners: [(Double, Double)] = [(r.x.0, r.z.0), (r.x.1, r.z.0), (r.x.1, r.z.1), (r.x.0, r.z.1)]
            scanRooms.append(
                ScanRoom(
                    id: id, name: r.name, label: r.label, captureIndex: i, floorPolygon: corners.map { Vec3(Float($0.0), 0, Float($0.1)) }, floorY: 0,
                    ceilingY: Float(ceiling)))
            // Walls: n (z0), e (x1), s (z1), w (x0). Alternate the normal's sign like real scans do.
            let sides: [(Character, (Double, Double), (Double, Double))] = [
                ("n", (r.x.0, r.z.0), (r.x.1, r.z.0)), ("e", (r.x.1, r.z.0), (r.x.1, r.z.1)),
                ("s", (r.x.1, r.z.1), (r.x.0, r.z.1)), ("w", (r.x.0, r.z.1), (r.x.0, r.z.0)),
            ]
            for (k, (side, a, b)) in sides.enumerated() {
                let wid = nextId("B0000002")
                wallIds[i, default: [:]][side] = wid
                walls.append(
                    ScanWall(
                        id: wid, roomId: id, transform: surfaceTransform(from: a, to: b, centerY: ceiling / 2, flip: k % 2 == 1), width: Float(dist(a, b)),
                        height: Float(ceiling)))
            }
        }

        for o in openings {
            for (room, side) in o.sides {
                let r = rooms[room]
                let (a, b): ((Double, Double), (Double, Double))
                switch side {
                case "n": (a, b) = ((o.at - o.width / 2, r.z.0), (o.at + o.width / 2, r.z.0))
                case "s": (a, b) = ((o.at + o.width / 2, r.z.1), (o.at - o.width / 2, r.z.1))
                case "e": (a, b) = ((r.x.1, o.at - o.width / 2), (r.x.1, o.at + o.width / 2))
                default: (a, b) = ((r.x.0, o.at + o.width / 2), (r.x.0, o.at - o.width / 2))
                }
                scanOpenings.append(
                    ScanOpening(
                        id: nextId("C0000003"), kind: o.kind, isOpen: o.kind == .door ? true : nil, wallId: wallIds[room]?[side], roomId: scanRooms[room].id,
                        transform: surfaceTransform(from: a, to: b, centerY: o.bottom + o.height / 2, flip: false), width: Float(o.width),
                        height: Float(o.height)))
            }
        }

        for (category, room, x, z, sx, sy, sz) in furniture {
            // The TV stands on its console.
            let bottom = category == "television" ? 0.52 : 0
            objects.append(
                ScanObject(
                    id: nextId("D0000004"), roomId: scanRooms[room].id, category: category,
                    transform: Transform.translating(Vec3(Float(x), Float(bottom + sy / 2), Float(z))), size: Vec3(Float(sx), Float(sy), Float(sz))))
        }

        let trajectory = walk(speed: walkingSpeed)
        let local = CaptureScan(
            rooms: scanRooms, walls: walls, openings: scanOpenings, objects: objects, trajectory: trajectory, capturedAt: "2026-10-07T18:00:00Z",
            device: DeviceInfo(model: "iPhone16,1", system: "iOS 18.1", app: "synthetic"))
        // Into an ARKit-like world frame: arbitrary heading, start position as origin.
        return local.transformed(by: Transform.translating(offset) * Transform.rotationY(rotation))
    }

    /// Samples the walk at 4 Hz with the phone at 1.4 m, looking ahead and sweeping side to side.
    static func walk(speed: Double) -> [PoseSample] {
        var samples: [PoseSample] = []
        var t = 0.0
        let dt = 0.25
        for k in 0..<(path.count - 1) {
            let a = path[k], b = path[k + 1]
            let len = dist(a, b)
            let steps = max(1, Int((len / (speed * dt)).rounded()))
            let heading = atan2(b.1 - a.1, b.0 - a.0)
            for s in 0..<steps {
                let f = Double(s) / Double(steps)
                let x = a.0 + (b.0 - a.0) * f, z = a.1 + (b.1 - a.1) * f
                let sweep = sin(t * 0.9) * 0.6
                let dir = Vec3(Float(cos(heading + sweep)), -0.12, Float(sin(heading + sweep)))
                samples.append(PoseSample(t: t, p: Vec3(Float(x), 1.4, Float(z)), f: vnormalize(dir)))
                t += dt
            }
        }
        let last = path[path.count - 1]
        samples.append(PoseSample(t: t, p: Vec3(Float(last.0), 1.4, Float(last.1)), f: Vec3(0, -0.12, -1)))
        return samples
    }

    /// RoomPlan-style surface transform: X along a→b, Y up, Z the normal (sign varies).
    static func surfaceTransform(from a: (Double, Double), to b: (Double, Double), centerY: Double, flip: Bool) -> Transform {
        let dx = b.0 - a.0, dz = b.1 - a.1
        let l = (dx * dx + dz * dz).squareRoot()
        var x = Vec3(Float(dx / l), 0, Float(dz / l))
        if flip { x = -x }
        let y = Vec3(0, 1, 0)
        let z = vcross(x, y)
        let c = Vec3(Float((a.0 + b.0) / 2), Float(centerY), Float((a.1 + b.1) / 2))
        return Transform(columnMajor: [x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, c.x, c.y, c.z, 1])
    }

    static func dist(_ a: (Double, Double), _ b: (Double, Double)) -> Double { ((b.0 - a.0) * (b.0 - a.0) + (b.1 - a.1) * (b.1 - a.1)).squareRoot() }
}
