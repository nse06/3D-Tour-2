import Foundation

/// The scan manifest — "atrium.scan-manifest/v1". Mirrors `ScanManifest` in
/// the web app (src/lib/tour/scan-manifest.ts): floors, rooms with camera
/// waypoints, and walkable links between rooms. Plan points are (x, z).
public struct ScanManifest: Codable, Sendable, Equatable {
    public static let schemaIdentifier = "atrium.scan-manifest/v1"

    public struct Source: Codable, Sendable, Equatable {
        public var kind: String
        public var generator: String?
        public var note: String?
    }

    public struct Feature: Codable, Sendable, Equatable {
        /// "stairs" or "void".
        public var type: String
        public var polygon: [[Double]]
        public var label: String?
        /// "up" or "down".
        public var direction: String?
        public var treads: Int?
    }

    public struct Floor: Codable, Sendable, Equatable {
        public var key: String
        public var name: String
        public var level: Int
        public var elevation: Double
        public var outline: [[Double]]?
        public var features: [Feature]?
    }

    public struct Waypoint: Codable, Sendable, Equatable {
        public var position: [Double]
        /// Radians; 0 looks toward −Z, positive turns left.
        public var yaw: Double
        public var pitch: Double
    }

    public struct Room: Codable, Sendable, Equatable {
        public var key: String
        public var name: String
        public var floor: String
        public var order: Int
        public var footprint: [[Double]]?
        public var waypoint: Waypoint
    }

    public struct Link: Codable, Sendable, Equatable {
        public var from: String
        public var to: String
        public var via: [[Double]]
        /// "door" or "stairs".
        public var kind: String?
    }

    public var schema: String
    public var source: Source?
    public var units: String
    public var upAxis: String
    public var eyeHeight: Double
    public var floors: [Floor]
    public var rooms: [Room]
    public var links: [Link]
    /// "captured" when the model is photo-textured (lighting baked into the photos).
    public var appearance: String? = nil

    public func jsonData(prettyPrinted: Bool = false) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = prettyPrinted ? [.prettyPrinted, .sortedKeys] : [.sortedKeys]
        return try encoder.encode(self)
    }
}

/// Builds the manifest: floors from room heights, a viewpoint per room, and
/// links through doors and along the path the phone actually walked.
struct ManifestBuilder {
    let rooms: [RoomInfo]
    let walls: [WallInfo]
    let openings: [ScanOpening]
    let objects: [ScanObject]
    let trajectory: [PoseSample]
    let eyeHeight: Double

    func build(generator: String) -> ScanManifest {
        let floorOfRoom = clusterFloors()
        let floorCount = (floorOfRoom.values.max() ?? 0) + 1
        let elevations = (0..<floorCount).map { level -> Double in
            median(rooms.filter { floorOfRoom[$0.index] == level }.map(\.floorY))
        }
        let floors = (0..<floorCount).map { level in
            ScanManifest.Floor(
                key: "level-\(level + 1)", name: floorName(level, of: floorCount), level: level + 1, elevation: rounded(elevations[level]),
                outline: nil, features: stairsFeatures(onLevel: level, elevations: elevations))
        }

        let roomOfSample = trajectory.map { Layout.room(at: $0.p, rooms: rooms)?.index }
        let order = visitOrder(roomOfSample)
        var manifestRooms: [ScanManifest.Room] = []
        for r in rooms {
            manifestRooms.append(
                ScanManifest.Room(
                    key: r.room.id, name: r.room.name.isEmpty ? "Room \(r.index + 1)" : r.room.name, floor: "level-\((floorOfRoom[r.index] ?? 0) + 1)",
                    order: order[r.index] ?? r.index, footprint: r.poly.map { [rounded($0.x), rounded($0.y)] }, waypoint: waypoint(for: r)))
        }
        manifestRooms.sort { $0.order < $1.order }

        var links = doorLinks()
        links += pathLinks(roomOfSample, existing: Set(links.map { pairKey($0.from, $0.to) }))
        links += openPlanLinks(existing: Set(links.map { pairKey($0.from, $0.to) }))
        return ScanManifest(
            schema: ScanManifest.schemaIdentifier,
            source: .init(kind: "ios_scan", generator: generator, note: "Built from an iPhone LiDAR scan (RoomPlan) and the path walked while scanning."),
            units: "meters", upAxis: "y", eyeHeight: eyeHeight, floors: floors, rooms: manifestRooms, links: links)
    }

    // MARK: Floors

    /// Level (0-based, bottom up) of each room: rooms are grouped by floor height, a jump of more than 1.2 m starts a new level.
    func clusterFloors() -> [Int: Int] {
        var result: [Int: Int] = [:]
        var level = 0
        var last: Double?
        for r in rooms.sorted(by: { $0.floorY < $1.floorY }) {
            if let l = last, r.floorY - l > 1.2 { level += 1 }
            result[r.index] = level
            last = r.floorY
        }
        return result
    }

    func floorName(_ level: Int, of count: Int) -> String {
        switch count {
        case 1: return "Main Level"
        case 2: return level == 0 ? "Main Level" : "Upper Level"
        default: return "Level \(level + 1)"
        }
    }

    func stairsFeatures(onLevel level: Int, elevations: [Double]) -> [ScanManifest.Feature]? {
        var features: [ScanManifest.Feature] = []
        for o in objects where o.category == "stairs" {
            let bottom = Double(o.transform.translation.y - o.size.y / 2)
            guard let nearest = elevations.indices.min(by: { abs(elevations[$0] - bottom) < abs(elevations[$1] - bottom) }), nearest == level else { continue }
            let t = o.transform, hx = o.size.x / 2, hz = o.size.z / 2
            let corners = [Vec3(-hx, 0, -hz), Vec3(hx, 0, -hz), Vec3(hx, 0, hz), Vec3(-hx, 0, hz)].map { plan(t.apply($0)) }
            features.append(
                ScanManifest.Feature(
                    type: "stairs", polygon: corners.map { [rounded($0.x), rounded($0.y)] }, label: "Stairs", direction: "up",
                    treads: max(2, Int((Double(o.size.y) / 0.18).rounded()))))
        }
        return features.isEmpty ? nil : features
    }

    // MARK: Rooms

    /// Rooms in the order the phone first entered them; rooms never visited follow in scan order.
    func visitOrder(_ roomOfSample: [Int?]) -> [Int: Int] {
        var order: [Int: Int] = [:]
        for case let r? in roomOfSample where order[r] == nil { order[r] = order.count }
        for r in rooms.sorted(by: { $0.room.captureIndex < $1.room.captureIndex }) where order[r.index] == nil { order[r.index] = order.count }
        return order
    }

    /// A viewpoint with a deep view across the room: candidates are the spots
    /// the phone stood in plus the room's center; the best keeps clear of walls
    /// and furniture and sees the farthest corner.
    func waypoint(for r: RoomInfo) -> ScanManifest.Waypoint {
        var candidates = [r.center]
        for s in trajectory where Layout.room(at: s.p, rooms: rooms)?.index == r.index { candidates.append(plan(s.p)) }
        let furniture: [[P2]] = objects.compactMap { o in
            guard o.size.y > 0.3, o.category != "stairs" else { return nil }
            let c = Double(o.transform.translation.y)
            guard c > r.floorY - 0.2, c < r.ceilingY else { return nil }
            let hx = o.size.x / 2, hz = o.size.z / 2
            return [Vec3(-hx, 0, -hz), Vec3(hx, 0, -hz), Vec3(hx, 0, hz), Vec3(-hx, 0, hz)].map { plan(o.transform.apply($0)) }
        }
        let minClearance = min(0.6, interiorClearance(r) * 0.8)
        var best = r.center
        var bestScore = -Double.infinity
        for p in candidates where pointInPolygon(p, r.poly) {
            let clearance = distanceToBoundary(p, r.poly)
            var score = r.poly.map { plength($0 - p) }.max() ?? 0
            if clearance < minClearance { score -= (minClearance - clearance) * 8 }
            // Never inside furniture, and preferably not brushing against it.
            for f in furniture {
                if pointInPolygon(p, f) {
                    score -= 4
                } else {
                    score -= max(0, 0.5 - distanceToBoundary(p, f)) * 3
                }
            }
            if score > bestScore {
                bestScore = score
                best = p
            }
        }
        // Look toward the middle of the room's deepest view.
        let far = r.poly.max { plength($0 - best) < plength($1 - best) } ?? r.center
        var target = (far + r.center) / 2
        if plength(target - best) < 0.3 { target = far }
        let d = target - best
        let yaw = plength(d) > 1e-6 ? atan2(-d.x, -d.y) : 0
        return ScanManifest.Waypoint(position: [rounded(best.x), rounded(r.floorY + eyeHeight), rounded(best.y)], yaw: rounded(yaw), pitch: -0.08)
    }

    func interiorClearance(_ r: RoomInfo) -> Double { distanceToBoundary(r.center, r.poly) }

    // MARK: Links

    func pairKey(_ a: String, _ b: String) -> String { a < b ? "\(a)|\(b)" : "\(b)|\(a)" }

    /// One link per pair of rooms joined by a door or opening: through the doorway at eye height.
    func doorLinks() -> [ScanManifest.Link] {
        var links: [ScanManifest.Link] = []
        var seen = Set<String>()
        for o in openings where o.kind != .window {
            let u = pnormalize(plan(o.transform.xAxis))
            guard plength(u) > 0.5, o.transform.isFinite else { continue }
            let c = o.transform.translation
            let n = perp(u)
            let mid = plan(c)
            let bottom = Double(c.y - o.height / 2)
            let probeY = Float(bottom + 1.0)
            guard let a = Layout.room(at: world(mid + n * 0.6, y: Double(probeY)), rooms: rooms),
                  let b = Layout.room(at: world(mid - n * 0.6, y: Double(probeY)), rooms: rooms), a.index != b.index
            else { continue }
            let key = pairKey(a.room.id, b.room.id)
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            let pa = mid + n * 0.6, pb = mid - n * 0.6
            links.append(
                ScanManifest.Link(
                    from: a.room.id, to: b.room.id,
                    via: [[rounded(pa.x), rounded(a.floorY + eyeHeight), rounded(pa.y)], [rounded(pb.x), rounded(b.floorY + eyeHeight), rounded(pb.y)]],
                    kind: "door"))
        }
        return links
    }

    /// Links for room changes along the walked path that no door explains
    /// (open-plan spaces, undetected doors, stairs).
    func pathLinks(_ roomOfSample: [Int?], existing: Set<String>) -> [ScanManifest.Link] {
        guard trajectory.count > 1 else { return [] }
        // The phone's typical height above the floor, to place the path at eye height.
        let heights: [Double] = zip(trajectory, roomOfSample).compactMap { s, r in r.map { Double(s.p.y) - rooms[$0].floorY } }
        let phoneHeight = heights.isEmpty ? 1.35 : median(heights)
        var seen = existing
        var links: [ScanManifest.Link] = []
        var lastRoom: Int?
        var lastIndex = 0
        for (i, r) in roomOfSample.enumerated() {
            guard let r else { continue }
            if let from = lastRoom, from != r {
                let a = rooms[from], b = rooms[r]
                let key = pairKey(a.room.id, b.room.id)
                if !seen.contains(key) {
                    seen.insert(key)
                    let stairs = abs(a.floorY - b.floorY) > 1.2
                    // From the last sample in the old room to the first in the new one.
                    var path = Array(trajectory[lastIndex...i])
                    let limit = stairs ? 12 : 8
                    if path.count > limit {
                        path = (0..<limit).map { path[Int((Double($0) / Double(limit - 1) * Double(path.count - 1)).rounded())] }
                    }
                    let via = path.map { s -> [Double] in
                        let y = stairs ? Double(s.p.y) - phoneHeight + eyeHeight : (Layout.room(at: s.p, rooms: rooms)?.floorY ?? a.floorY) + eyeHeight
                        return [rounded(Double(s.p.x)), rounded(y), rounded(Double(s.p.z))]
                    }
                    links.append(ScanManifest.Link(from: a.room.id, to: b.room.id, via: via, kind: stairs ? "stairs" : nil))
                }
            }
            lastRoom = r
            lastIndex = i
        }
        return links
    }
}

extension ManifestBuilder {
    /// Rooms that flow into each other with no wall between them (an open
    /// kitchen and dining room, two halves of a hallway): walk along each
    /// room's edge and look for stretches where the neighbouring floor
    /// continues and no wall stands in the way.
    func openPlanLinks(existing: Set<String>) -> [ScanManifest.Link] {
        var seen = existing
        var links: [ScanManifest.Link] = []
        for a in rooms {
            var open: [Int: [(p: P2, out: P2)]] = [:]
            for i in a.poly.indices {
                let p0 = a.poly[i], p1 = a.poly[(i + 1) % a.poly.count]
                let e = p1 - p0
                let length = plength(e)
                guard length > 0.1 else { continue }
                let out = -perp(e / length)
                let steps = max(1, Int(length / 0.2))
                for k in 0..<steps {
                    let p = p0 + e * ((Double(k) + 0.5) / Double(steps))
                    let beyond = p + out * 0.35
                    guard let b = rooms.first(where: { $0.index != a.index && abs($0.floorY - a.floorY) < 0.4 && pointInPolygon(beyond, $0.poly) }),
                          !blocked(from: p - out * 0.3, to: beyond, floorY: a.floorY)
                    else { continue }
                    open[b.index, default: []].append((p, out))
                }
            }
            for (bIndex, samples) in open.sorted(by: { $0.key < $1.key }) where samples.count >= 3 {
                let b = rooms[bIndex]
                let key = pairKey(a.room.id, b.room.id)
                guard !seen.contains(key) else { continue }
                seen.insert(key)
                let s = samples[samples.count / 2]
                var pa = s.p - s.out * 0.5, pb = s.p + s.out * 0.6
                if !pointInPolygon(pa, a.poly) { pa = s.p - s.out * 0.15 }
                if !pointInPolygon(pb, b.poly) { pb = s.p + s.out * 0.35 }
                links.append(
                    ScanManifest.Link(
                        from: a.room.id, to: b.room.id,
                        via: [[rounded(pa.x), rounded(a.floorY + eyeHeight), rounded(pa.y)], [rounded(pb.x), rounded(b.floorY + eyeHeight), rounded(pb.y)]],
                        kind: nil))
            }
        }
        return links
    }

    /// Whether a short walk in plan crosses a wall (other than through a doorway).
    func blocked(from p: P2, to q: P2, floorY: Double) -> Bool {
        let eye = floorY + 1.0
        for w in walls where w.y0 < eye && w.y1 > eye {
            guard let hit = segmentIntersection(p, q, w.a, w.b) else { continue }
            let s = w.s(of: hit)
            let passable = w.holes.contains { h in h.kind != .window && h.s0 <= s && s <= h.s1 && h.y0 < floorY + 0.3 && h.y1 > floorY + 1.8 }
            if !passable { return true }
        }
        return false
    }
}

/// The crossing point of segments p→q and a→b, if they cross.
func segmentIntersection(_ p: P2, _ q: P2, _ a: P2, _ b: P2) -> P2? {
    let r = q - p, s = b - a
    let denom = pcross(r, s)
    guard abs(denom) > 1e-12 else { return nil }
    let t = pcross(a - p, s) / denom
    let u = pcross(a - p, r) / denom
    guard t >= 0, t <= 1, u >= 0, u <= 1 else { return nil }
    return p + r * t
}

func median(_ values: [Double]) -> Double {
    guard !values.isEmpty else { return 0 }
    let s = values.sorted()
    return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
}
