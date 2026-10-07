import AtriumScanCore
import Foundation
import RoomPlan
import simd

/// A processed room and the name the realtor gave it.
struct NamedRoom {
    var name: String
    var room: CapturedRoom
}

/// Converts RoomPlan's rooms into ScanCore's portable `CaptureScan`
/// (docs/iphone-capture.md §1). All rooms come from one continuous AR session,
/// so they — and the recorded path — share one world coordinate space.
enum RoomPlanAdapter {
    static func makeScan(rooms: [NamedRoom], trajectory: [PoseSample], device: DeviceInfo, capturedAt: Date) -> CaptureScan {
        var scanRooms: [ScanRoom] = []
        var walls: [ScanWall] = []
        var openings: [ScanOpening] = []
        var objects: [ScanObject] = []

        for (index, entry) in rooms.enumerated() {
            let room = entry.room
            let roomId = room.identifier.uuidString
            let tops = room.walls.map { $0.transform.columns.3.y + $0.dimensions.y / 2 }
            let bottoms = room.walls.map { $0.transform.columns.3.y - $0.dimensions.y / 2 }

            var floorY: Float
            var polygon: [Vec3]
            if let floor = room.floors.max(by: { $0.dimensions.x * $0.dimensions.y < $1.dimensions.x * $1.dimensions.y }) {
                floorY = floor.transform.columns.3.y
                // Corners are in the floor's own plane coordinates.
                var corners = floor.polygonCorners
                if corners.count < 3 {
                    let hx = floor.dimensions.x / 2, hy = floor.dimensions.y / 2
                    corners = [SIMD3(-hx, -hy, 0), SIMD3(hx, -hy, 0), SIMD3(hx, hy, 0), SIMD3(-hx, hy, 0)]
                }
                polygon = corners.map { point($0, through: floor.transform) }
            } else {
                floorY = bottoms.min() ?? 0
                polygon = outline(of: room.walls, at: floorY)
            }
            let ceilingY = tops.max() ?? floorY + 2.5
            guard polygon.count >= 3 else { continue }

            scanRooms.append(
                ScanRoom(
                    id: roomId, name: entry.name, label: dominantLabel(of: room)?.rawValue, captureIndex: index, floorPolygon: polygon, floorY: floorY,
                    ceilingY: ceilingY))

            for w in room.walls {
                walls.append(ScanWall(id: w.identifier.uuidString, roomId: roomId, transform: Transform(w.transform), width: w.dimensions.x, height: w.dimensions.y))
            }
            for (kind, surfaces) in [(ScanOpening.Kind.door, room.doors), (.window, room.windows), (.opening, room.openings)] {
                for s in surfaces {
                    var isOpen: Bool?
                    if case let .door(open) = s.category { isOpen = open }
                    openings.append(
                        ScanOpening(
                            id: s.identifier.uuidString, kind: kind, isOpen: isOpen, wallId: s.parentIdentifier?.uuidString, roomId: roomId,
                            transform: Transform(s.transform), width: s.dimensions.x, height: s.dimensions.y))
                }
            }
            for o in room.objects {
                objects.append(
                    ScanObject(id: o.identifier.uuidString, roomId: roomId, category: categoryName(o.category), transform: Transform(o.transform), size: o.dimensions))
            }
        }

        let formatter = ISO8601DateFormatter()
        return CaptureScan(
            rooms: scanRooms, walls: walls, openings: openings, objects: objects, trajectory: trajectory, capturedAt: formatter.string(from: capturedAt),
            device: device)
    }

    /// RoomPlan's guess for the room type, from its largest share of sections.
    static func dominantLabel(of room: CapturedRoom) -> CapturedRoom.Section.Label? {
        var counts: [CapturedRoom.Section.Label: Int] = [:]
        for section in room.sections where section.label != .unidentified { counts[section.label, default: 0] += 1 }
        return counts.max { $0.value < $1.value }?.key
    }

    /// A friendly default name for a RoomPlan label.
    static func suggestedName(for label: CapturedRoom.Section.Label?) -> String? {
        switch label {
        case .livingRoom: return "Living Room"
        case .bedroom: return "Bedroom"
        case .bathroom: return "Bathroom"
        case .kitchen: return "Kitchen"
        case .diningRoom: return "Dining Room"
        default: return nil
        }
    }

    static func categoryName(_ category: CapturedRoom.Object.Category) -> String {
        switch category {
        case .storage: return "storage"
        case .refrigerator: return "refrigerator"
        case .stove: return "stove"
        case .bed: return "bed"
        case .sink: return "sink"
        case .washerDryer: return "washerDryer"
        case .toilet: return "toilet"
        case .bathtub: return "bathtub"
        case .oven: return "oven"
        case .dishwasher: return "dishwasher"
        case .table: return "table"
        case .sofa: return "sofa"
        case .chair: return "chair"
        case .fireplace: return "fireplace"
        case .television: return "television"
        case .stairs: return "stairs"
        @unknown default: return "unknown"
        }
    }

    private static func point(_ p: SIMD3<Float>, through t: simd_float4x4) -> Vec3 {
        let w = t * SIMD4<Float>(p.x, p.y, p.z, 1)
        return Vec3(w.x, w.y, w.z)
    }

    /// Floor outline from wall endpoints, for rooms RoomPlan reported without a floor.
    private static func outline(of walls: [CapturedRoom.Surface], at y: Float) -> [Vec3] {
        var points: [SIMD2<Float>] = []
        for w in walls {
            let c = w.transform.columns.3, x = w.transform.columns.0
            let half = SIMD2<Float>(x.x, x.z) * (w.dimensions.x / 2)
            points.append(SIMD2(c.x, c.z) + half)
            points.append(SIMD2(c.x, c.z) - half)
        }
        guard points.count >= 3 else { return [] }
        let center = points.reduce(SIMD2<Float>(0, 0), +) / Float(points.count)
        return points
            .sorted { atan2($0.y - center.y, $0.x - center.x) < atan2($1.y - center.y, $1.x - center.x) }
            .map { Vec3($0.x, y, $0.y) }
    }
}

extension Transform {
    init(_ m: simd_float4x4) {
        self.init(columnMajor: [m.columns.0, m.columns.1, m.columns.2, m.columns.3].flatMap { [$0.x, $0.y, $0.z, $0.w] })
    }
}
