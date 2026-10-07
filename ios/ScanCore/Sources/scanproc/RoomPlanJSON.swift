import AtriumScanCore
import Foundation

/// Reads RoomPlan's Codable JSON (`CapturedRoom`, `CapturedStructure`) without
/// the RoomPlan framework, the way the iPhone app's RoomPlanAdapter reads the
/// live types. For checking ScanCore against real captures on any machine.
enum RoomPlanJSON {
    struct Room {
        var part: RoomPart
        /// Element poses by identifier.
        var poses: [String: Transform]
    }

    enum Failure: Error, CustomStringConvertible {
        case unreadable(String)
        var description: String {
            switch self {
            case let .unreadable(message): return message
            }
        }
    }

    /// The rooms in a file: one for a CapturedRoom, all of `rooms` for a CapturedStructure.
    static func rooms(in url: URL, firstIndex: Int, name: String?) throws -> [Room] {
        guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw Failure.unreadable("\(url.lastPathComponent): not a JSON object")
        }
        let list = (object["rooms"] as? [[String: Any]]) ?? [object]
        return list.enumerated().compactMap { offset, room in
            let label = name.map { list.count > 1 ? "\($0) \(offset + 1)" : $0 } ?? "Room \(firstIndex + offset + 1)"
            return self.room(room, index: firstIndex + offset, name: label)
        }
    }

    /// Element poses of a merged structure: its rooms' elements, then the merged top-level ones.
    static func structurePoses(in url: URL, topLevelOnly: Bool) throws -> [String: Transform] {
        guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw Failure.unreadable("\(url.lastPathComponent): not a JSON object")
        }
        var poses: [String: Transform] = [:]
        if !topLevelOnly {
            for room in (object["rooms"] as? [[String: Any]]) ?? [] {
                for (id, t) in elementPoses(room) where poses[id] == nil { poses[id] = t }
            }
        }
        for (id, t) in elementPoses(object) where poses[id] == nil { poses[id] = t }
        return poses
    }

    static func elementPoses(_ object: [String: Any]) -> [String: Transform] {
        var poses: [String: Transform] = [:]
        for key in ["walls", "doors", "windows", "openings", "objects"] {
            for e in (object[key] as? [[String: Any]]) ?? [] {
                if let id = e["identifier"] as? String, let t = transform(e["transform"]) { poses[id] = t }
            }
        }
        return poses
    }

    static func room(_ d: [String: Any], index: Int, name: String) -> Room? {
        let roomId = (d["identifier"] as? String) ?? String(format: "R%07d-0000-4000-8000-000000000000", index)
        let walls = surfaces(d["walls"])
        let tops = walls.map { $0.t.translation.y + $0.size.y / 2 }
        let bottoms = walls.map { $0.t.translation.y - $0.size.y / 2 }
        var floorY: Float
        var polygon: [Vec3]
        let floors = surfaces(d["floors"])
        if let floor = floors.max(by: { $0.size.x * $0.size.y < $1.size.x * $1.size.y }) {
            floorY = floor.t.translation.y
            var corners = floor.corners
            if corners.count < 3 {
                let hx = floor.size.x / 2, hy = floor.size.y / 2
                corners = [Vec3(-hx, -hy, 0), Vec3(hx, -hy, 0), Vec3(hx, hy, 0), Vec3(-hx, hy, 0)]
            }
            polygon = corners.map(floor.t.apply)
        } else {
            return nil
        }
        _ = bottoms
        let ceilingY = tops.max() ?? floorY + 2.5
        let sections = (d["sections"] as? [[String: Any]]) ?? []
        let label = sections.compactMap { ($0["label"] as? String) }.first { $0 != "unidentified" }
        var part = RoomPart(
            room: ScanRoom(id: roomId, name: name, label: label, captureIndex: index, floorPolygon: polygon, floorY: floorY, ceilingY: ceilingY))
        part.walls = walls.map { ScanWall(id: $0.id, roomId: roomId, transform: $0.t, width: $0.size.x, height: $0.size.y) }
        for (key, kind) in [("doors", ScanOpening.Kind.door), ("windows", .window), ("openings", .opening)] {
            for s in surfaces(d[key]) {
                part.openings.append(
                    ScanOpening(
                        id: s.id, kind: kind, isOpen: kind == .door ? s.isOpen : nil, wallId: s.parent, roomId: roomId, transform: s.t, width: s.size.x,
                        height: s.size.y))
            }
        }
        for o in (d["objects"] as? [[String: Any]]) ?? [] {
            guard let id = o["identifier"] as? String, let t = transform(o["transform"]), let size = vec(o["dimensions"]) else { continue }
            let category = (o["category"] as? [String: Any])?.keys.first ?? "unknown"
            part.objects.append(ScanObject(id: id, roomId: roomId, category: category, transform: t, size: size))
        }
        return Room(part: part, poses: elementPoses(d))
    }

    struct Surface {
        var id: String
        var t: Transform
        var size: Vec3
        var corners: [Vec3]
        var parent: String?
        var isOpen: Bool?
    }

    static func surfaces(_ value: Any?) -> [Surface] {
        ((value as? [[String: Any]]) ?? []).compactMap { s in
            guard let id = s["identifier"] as? String, let t = transform(s["transform"]), let size = vec(s["dimensions"]) else { return nil }
            let corners = ((s["polygonCorners"] as? [Any]) ?? []).compactMap(vec)
            var isOpen: Bool?
            if let door = (s["category"] as? [String: Any])?["door"] as? [String: Any] { isOpen = door["isOpen"] as? Bool }
            return Surface(id: id, t: t, size: size, corners: corners, parent: s["parentIdentifier"] as? String, isOpen: isOpen)
        }
    }

    static func transform(_ value: Any?) -> Transform? {
        guard let numbers = value as? [NSNumber], numbers.count == 16 else { return nil }
        let t = Transform(columnMajor: numbers.map { $0.floatValue })
        return t.isFinite ? t : nil
    }

    static func vec(_ value: Any?) -> Vec3? {
        guard let numbers = value as? [NSNumber], numbers.count >= 3 else { return nil }
        return Vec3(numbers[0].floatValue, numbers[1].floatValue, numbers[2].floatValue)
    }
}
