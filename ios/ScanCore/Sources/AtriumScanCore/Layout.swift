import Foundation

/// A room after cleanup, in plan view.
struct RoomInfo {
    let index: Int
    let room: ScanRoom
    /// Cleaned floor outline, counter-clockwise in (x, z).
    let poly: [P2]
    let floorY: Double
    let ceilingY: Double
    let area: Double
    /// An interior point far from the walls (always inside the outline).
    let center: P2
    /// Bathrooms and laundry rooms get tile floors.
    let isWet: Bool
}

/// A wall prepared for meshing. "s" runs along the wall from `a` to `b`;
/// "depth" goes from the inside face (0) out through the wall (`thickness`).
struct WallInfo {
    let index: Int
    let id: String
    let roomIndex: Int?
    let a: P2
    let b: P2
    /// Unit direction a → b.
    let u: P2
    /// Unit normal pointing into the room the wall was scanned from.
    let nIn: P2
    let length: Double
    var y0: Double
    var y1: Double
    var thickness: Double
    var holes: [WallHole] = []

    /// World position of a wall-local point.
    func point(s: Double, y: Double, depth: Double) -> Vec3 {
        world(a + u * s - nIn * depth, y: y)
    }

    /// Along-wall coordinate of a plan point.
    func s(of p: P2) -> Double { pdot(p - a, u) }

    /// Signed distance of a plan point from the inside face (positive = inside the room).
    func offset(of p: P2) -> Double { pdot(p - a, nIn) }
}

struct WallHole {
    var s0: Double
    var s1: Double
    var y0: Double
    var y1: Double
    var kind: ScanOpening.Kind
    /// The wall the opening was scanned on (others are the far faces of the same partition).
    var primary: Bool
}

enum Layout {
    static let wetRoomWords = ["bath", "powder", "laundry", "utility", "wc", "toilet", "shower", "mudroom"]

    static func rooms(from scan: CaptureScan) -> [RoomInfo] {
        var out: [RoomInfo] = []
        for room in scan.rooms {
            guard room.floorY.isFinite, room.ceilingY.isFinite,
                  let poly0 = cleanPolygon(room.floorPolygon.map(plan))
            else { continue }
            let poly = signedArea(poly0) < 0 ? Array(poly0.reversed()) : poly0
            let floorY = Double(room.floorY)
            var ceilingY = Double(room.ceilingY)
            if !(ceilingY - floorY > 1.6 && ceilingY - floorY < 8) { ceilingY = floorY + 2.5 }
            let words = (room.name + " " + (room.label ?? "")).lowercased()
            let wet = wetRoomWords.contains { words.contains($0) }
            out.append(
                RoomInfo(
                    index: out.count, room: room, poly: poly, floorY: floorY, ceilingY: ceilingY, area: area(poly), center: interiorCenter(poly), isWet: wet
                ))
        }
        return out
    }

    /// The room a world point lies in (plan containment plus a plausible height), if any.
    static func room(at p: Vec3, rooms: [RoomInfo], headroom: Double = 0.6) -> RoomInfo? {
        let q = plan(p)
        let y = Double(p.y)
        var best: RoomInfo?
        var bestDy = Double.infinity
        for r in rooms where y > r.floorY - 0.3 && y < r.ceilingY + headroom && pointInPolygon(q, r.poly) {
            let dy = abs(y - (r.floorY + 1.3))
            if dy < bestDy {
                bestDy = dy
                best = r
            }
        }
        return best
    }

    /// The room whose outline is nearest to a plan point at roughly the given height.
    static func nearestRoom(to p: P2, y: Double, rooms: [RoomInfo]) -> RoomInfo? {
        rooms
            .filter { y > $0.floorY - 0.6 && y < $0.ceilingY + 0.6 }
            .min { distanceToBoundary(p, $0.poly) < distanceToBoundary(p, $1.poly) }
    }

    // MARK: Walls

    static func walls(from scan: CaptureScan, rooms: [RoomInfo], defaultThickness: Double) -> [WallInfo] {
        let roomIndexById = Dictionary(rooms.map { ($0.room.id, $0.index) }, uniquingKeysWith: { a, _ in a })
        var walls: [WallInfo] = []
        for w in scan.walls {
            let width = Double(w.width), height = Double(w.height)
            guard width > 0.05, height > 0.2, w.transform.isFinite else { continue }
            let u = pnormalize(plan(w.transform.xAxis))
            guard plength(u) > 0.5 else { continue }  // not a vertical wall
            let c = w.transform.translation
            let mid = plan(c)
            let y0 = Double(c.y) - height / 2, y1 = Double(c.y) + height / 2
            let owner: RoomInfo? =
                w.roomId.flatMap { roomIndexById[$0] }.map { rooms[$0] } ?? nearestRoom(to: mid, y: (y0 + y1) / 2, rooms: rooms)
            var n = perp(u)
            if let r = owner {
                let inA = pointInPolygon(mid + n * 0.25, r.poly), inB = pointInPolygon(mid - n * 0.25, r.poly)
                if inB && !inA || (inA == inB && pdot(r.center - mid, n) < 0) { n = -n }
            }
            walls.append(
                WallInfo(
                    index: walls.count, id: w.id, roomIndex: owner?.index, a: mid - u * (width / 2), b: mid + u * (width / 2), u: u, nIn: n,
                    length: width, y0: y0, y1: y1, thickness: defaultThickness))
        }
        reachFloorAndCeiling(&walls, rooms: rooms)
        assignPartitionThickness(&walls, defaultThickness: defaultThickness)
        return walls
    }

    /// RoomPlan measures each wall's own height, so a wall can stop short of its room's
    /// ceiling (the highest wall) or floor, leaving a gap you can see through. Full-height
    /// walls close the gap; half walls and counters stay as measured.
    static func reachFloorAndCeiling(_ walls: inout [WallInfo], rooms: [RoomInfo]) {
        for i in walls.indices {
            guard let r = walls[i].roomIndex.map({ rooms[$0] }), walls[i].y1 - walls[i].y0 > 1.6 else { continue }
            let top = r.ceilingY - walls[i].y1, bottom = walls[i].y0 - r.floorY
            if top > 0.005 && top < 0.6 { walls[i].y1 = r.ceilingY }
            if bottom > 0.005 && bottom < 0.3 { walls[i].y0 = r.floorY }
        }
    }

    /// Two rooms scanned on either side of one partition each report their own
    /// face of it. Each face becomes a slab that fills half the gap, so the two
    /// meet in the middle of the partition instead of poking through each other.
    static func assignPartitionThickness(_ walls: inout [WallInfo], defaultThickness: Double) {
        for i in walls.indices {
            for j in walls.indices where j > i {
                guard let gap = partitionGap(walls[i], walls[j]) else { continue }
                let t = clamp(gap / 2, 0.02, defaultThickness)
                walls[i].thickness = min(walls[i].thickness, t)
                walls[j].thickness = min(walls[j].thickness, t)
            }
        }
    }

    /// The distance between two facing walls if they are opposite faces of one partition.
    static func partitionGap(_ a: WallInfo, _ b: WallInfo) -> Double? {
        guard abs(pdot(a.u, b.u)) > 0.985, pdot(a.nIn, b.nIn) < -0.9 else { return nil }
        guard (a.y0 < b.y1 - 0.3) && (b.y0 < a.y1 - 0.3) else { return nil }
        // b's face must lie behind a's face (on a's outside), within a plausible wall thickness.
        let gap = -a.offset(of: (b.a + b.b) / 2)
        guard gap > -0.06, gap < 0.5 else { return nil }
        let sb0 = a.s(of: b.a), sb1 = a.s(of: b.b)
        let overlap = min(max(sb0, sb1), a.length) - max(min(sb0, sb1), 0)
        return overlap > 0.2 ? max(gap, 0) : nil
    }

    // MARK: Openings

    /// Cuts each door, window and opening into its wall and into the far face
    /// of the same partition (which the other room may have scanned without it).
    static func cutOpenings(_ openings: [ScanOpening], into walls: inout [WallInfo]) {
        let wallIndexById = Dictionary(walls.map { ($0.id, $0.index) }, uniquingKeysWith: { a, _ in a })
        for o in openings {
            let width = Double(o.width), height = Double(o.height)
            guard width > 0.2, height > 0.2, o.transform.isFinite else { continue }
            let uo = pnormalize(plan(o.transform.xAxis))
            guard plength(uo) > 0.5 else { continue }
            let c = o.transform.translation
            let mid = plan(c)
            let parent = o.wallId.flatMap { wallIndexById[$0] }
            let reach = o.kind == .window ? 0.35 : 0.5

            // The wall face nearest to the opening's plane, and every face within a partition's thickness of it.
            var candidates: [(index: Int, distance: Double)] = []
            for w in walls where abs(pdot(w.u, uo)) > 0.95 {
                let d = abs(w.offset(of: mid))
                let s = w.s(of: mid)
                guard s > -0.1, s < w.length + 0.1 else { continue }
                if w.index == parent || d <= reach { candidates.append((w.index, w.index == parent ? 0 : d)) }
            }
            guard let primary = candidates.min(by: { $0.distance < $1.distance }) else { continue }
            for cand in candidates {
                var w = walls[cand.index]
                // The far face must belong to the same partition as the primary face.
                if cand.index != primary.index {
                    let p = walls[primary.index]
                    guard partitionGap(p, w) != nil || abs(w.offset(of: mid) - p.offset(of: mid)) < 0.05 else { continue }
                }
                let sc = w.s(of: mid)
                var hole = WallHole(
                    s0: max(0, sc - width / 2), s1: min(w.length, sc + width / 2),
                    y0: Double(c.y) - height / 2, y1: Double(c.y) + height / 2,
                    kind: o.kind, primary: cand.index == primary.index)
                if o.kind != .window, hole.y0 - w.y0 < 0.25 { hole.y0 = w.y0 }  // doors reach the floor
                hole.y0 = max(hole.y0, w.y0)
                hole.y1 = min(hole.y1, w.y1)
                if w.y1 - hole.y1 < 0.04 { hole.y1 = w.y1 }  // no sliver of a header
                guard hole.s1 - hole.s0 > 0.2, hole.y1 - hole.y0 > 0.2 else { continue }
                w.holes.append(hole)
                walls[cand.index] = w
            }
        }
        for i in walls.indices { walls[i].holes = mergeHoles(walls[i].holes) }
    }

    /// Unions overlapping holes so the column decomposition stays simple.
    static func mergeHoles(_ holes: [WallHole]) -> [WallHole] {
        var result: [WallHole] = []
        let rank: [ScanOpening.Kind: Int] = [.door: 3, .opening: 2, .window: 1]
        for h in holes.sorted(by: { $0.s0 < $1.s0 }) {
            if let k = result.firstIndex(where: { $0.s0 < h.s1 + 0.01 && h.s0 < $0.s1 + 0.01 && $0.y0 < h.y1 && h.y0 < $0.y1 }) {
                var m = result[k]
                m.s0 = min(m.s0, h.s0)
                m.s1 = max(m.s1, h.s1)
                m.y0 = min(m.y0, h.y0)
                m.y1 = max(m.y1, h.y1)
                if rank[h.kind, default: 0] > rank[m.kind, default: 0] { m.kind = h.kind }
                m.primary = m.primary || h.primary
                result[k] = m
            } else {
                result.append(h)
            }
        }
        return result
    }
}
