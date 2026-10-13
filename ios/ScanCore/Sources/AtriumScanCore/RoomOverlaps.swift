import Foundation

/// Where rooms' outlines overlap, the room each overlap belongs to.
///
/// Rooms are scanned one at a time, each in a RoomPlan run of its own, and put into one frame
/// afterwards (RoomAlignment), to within a few centimeters. When a room's scan reaches into its
/// neighbour (the phone carried through a doorway, or an outline drawn too big), both runs saw that
/// part of the home: two LiDAR meshes of the same bed a few centimeters apart, and two sets of photos,
/// each lined up with its own run. Mixed, they make shattered furniture: one run's shapes painted with
/// the other run's photos. So each overlap goes to the room whose run saw it best (the most LiDAR
/// surface there; without a mesh, the most photos taken standing in it), and there only that room's
/// shapes, floor and photos are used. Rooms overlap only on the same level: a bedroom above the
/// living room is another floor, not an overlap.
struct RoomOverlaps {
    /// Plan grid the overlaps are found on, meters.
    static let cell = 0.2
    /// Rooms whose floors lie within this of each other are on one level, meters.
    static let sameLevel = 1.0
    /// A point is in a room from this far below its floor to this far above its ceiling, meters.
    static let below = 0.25, above = 0.1

    struct Region {
        /// The rooms (indices) whose outlines all hold it.
        var rooms: [Int]
        var owner: Int
        /// Square meters.
        var area: Double
    }

    private(set) var rooms: [RoomInfo]
    private(set) var regions: [Region] = []
    /// Each room's level: the index of the first room on it.
    private let levelOf: [Int: Int]
    /// Overlap cells (x, z, level) and the room that owns each.
    private var owners: [SIMD3<Int32>: Int] = [:]

    /// No overlaps resolved: a point belongs to the first room (in capture order) that holds it.
    init(rooms: [RoomInfo]) {
        self.rooms = rooms
        var levels: [Int: Int] = [:]
        for (k, r) in rooms.enumerated() {
            let peer = rooms[..<k].first { abs($0.floorY - r.floorY) < Self.sameLevel }
            levels[r.index] = peer.flatMap { levels[$0.index] } ?? r.index
        }
        levelOf = levels
    }

    static func key(_ q: P2, level: Int) -> SIMD3<Int32> {
        SIMD3(Int32((q.x / cell).rounded(.down)), Int32((q.y / cell).rounded(.down)), Int32(level))
    }

    static func center(_ k: SIMD3<Int32>) -> P2 { P2((Double(k.x) + 0.5) * cell, (Double(k.y) + 0.5) * cell) }

    /// Square meters where two or more rooms overlap.
    var area: Double { regions.reduce(0) { $0 + $1.area } }

    /// Whether a point lies in a room: inside its outline, between its floor and ceiling.
    static func holds(_ r: RoomInfo, _ p: Vec3) -> Bool {
        let y = Double(p.y)
        return y > r.floorY - below && y < r.ceilingY + above && pointInPolygon(plan(p), r.poly)
    }

    /// The room a point belongs to: the one that holds it or, where rooms overlap, the overlap's
    /// owner. Nil outside every room.
    func owner(of p: Vec3) -> Int? {
        var first: RoomInfo?, count = 0
        for r in rooms where Self.holds(r, p) {
            if first == nil { first = r }
            count += 1
        }
        guard let first else { return nil }
        guard count > 1, let level = levelOf[first.index], let o = owners[Self.key(plan(p), level: level)],
            let room = rooms.first(where: { $0.index == o }), Self.holds(room, p)
        else { return first.index }
        return o
    }

    /// Finds the overlaps and gives each to the room whose run saw it best: the most LiDAR surface
    /// (its own mesh, any kind of surface) there, then the most photos taken standing there, then
    /// the room scanned first.
    static func find(rooms: [RoomInfo], meshes: [ScanMesh], frames: [CameraFrame]) -> RoomOverlaps {
        var out = RoomOverlaps(rooms: rooms)
        guard rooms.count > 1 else { return out }
        let levelOf = out.levelOf
        // Cells inside two or more outlines on one level, with the rooms they're in.
        let bounds = rooms.map { r in
            (lo: r.poly.reduce(P2(.infinity, .infinity)) { P2(min($0.x, $1.x), min($0.y, $1.y)) },
             hi: r.poly.reduce(P2(-.infinity, -.infinity)) { P2(max($0.x, $1.x), max($0.y, $1.y)) })
        }
        var cellRooms: [SIMD3<Int32>: [Int]] = [:]
        for i in rooms.indices {
            guard let level = levelOf[rooms[i].index] else { continue }
            let peers = rooms.filter { levelOf[$0.index] == level }
            for j in rooms.indices where j > i && levelOf[rooms[j].index] == level {
                let lo = P2(max(bounds[i].lo.x, bounds[j].lo.x), max(bounds[i].lo.y, bounds[j].lo.y))
                let hi = P2(min(bounds[i].hi.x, bounds[j].hi.x), min(bounds[i].hi.y, bounds[j].hi.y))
                guard lo.x < hi.x, lo.y < hi.y else { continue }
                let k0 = key(lo, level: level), k1 = key(hi, level: level)
                for x in k0.x...k1.x {
                    for y in k0.y...k1.y {
                        let k = SIMD3(x, y, Int32(level))
                        guard cellRooms[k] == nil else { continue }
                        let c = center(k)
                        let inside = peers.filter { pointInPolygon(c, $0.poly) }.map(\.index)
                        if inside.count > 1 { cellRooms[k] = inside }
                    }
                }
            }
        }
        guard !cellRooms.isEmpty else { return out }

        // Connected cells held by the same rooms make a region.
        var regionOf: [SIMD3<Int32>: Int] = [:]
        var cellsOf: [[SIMD3<Int32>]] = []
        var setOf: [[Int]] = []
        let sorted = cellRooms.keys.sorted { ($0.z, $0.x, $0.y) < ($1.z, $1.x, $1.y) }
        for start in sorted where regionOf[start] == nil {
            let id = cellsOf.count, set = cellRooms[start]!
            var cells: [SIMD3<Int32>] = [], stack = [start]
            regionOf[start] = id
            while let k = stack.popLast() {
                cells.append(k)
                for d in [SIMD3<Int32>(1, 0, 0), SIMD3(-1, 0, 0), SIMD3(0, 1, 0), SIMD3(0, -1, 0)] {
                    let n = k &+ d
                    if regionOf[n] == nil, cellRooms[n] == set {
                        regionOf[n] = id
                        stack.append(n)
                    }
                }
            }
            cellsOf.append(cells)
            setOf.append(set)
        }

        // How much each room's run saw of each region.
        let indexOf = Dictionary(rooms.map { ($0.room.id, $0.index) }, uniquingKeysWith: { a, _ in a })
        let keys = Array(cellRooms.keys)
        let lo = P2(Double(keys.map(\.x).min()!) * cell, Double(keys.map(\.y).min()!) * cell)
        let hi = P2(Double(keys.map(\.x).max()! + 1) * cell, Double(keys.map(\.y).max()! + 1) * cell)
        var surface = setOf.map { [Double](repeating: 0, count: $0.count) }, photos = setOf.map { [Int](repeating: 0, count: $0.count) }
        func slot(_ q: P2, _ room: Int) -> (Int, Int)? {
            guard q.x >= lo.x, q.x < hi.x, q.y >= lo.y, q.y < hi.y, let level = levelOf[room],
                let r = regionOf[key(q, level: level)], let s = setOf[r].firstIndex(of: room)
            else { return nil }
            return (r, s)
        }
        for mesh in meshes {
            guard let id = mesh.roomId, let room = indexOf[id] else { continue }
            for t in 0..<mesh.triangleCount {
                let ia = Int(mesh.indices[t * 3]), ib = Int(mesh.indices[t * 3 + 1]), ic = Int(mesh.indices[t * 3 + 2])
                guard ia < mesh.vertices.count, ib < mesh.vertices.count, ic < mesh.vertices.count else { continue }
                let a = mesh.vertices[ia], b = mesh.vertices[ib], c = mesh.vertices[ic]
                guard let (r, s) = slot(plan((a + b + c) / 3), room) else { continue }
                surface[r][s] += Double(vlength(vcross(b - a, c - a))) / 2
            }
        }
        for f in frames {
            guard let id = f.roomId, let room = indexOf[id], let (r, s) = slot(plan(f.transform.translation), room) else { continue }
            photos[r][s] += 1
        }

        for r in setOf.indices {
            // Rooms come in capture order, so on a tie the first scanned wins.
            var best = 0
            for s in setOf[r].indices.dropFirst() where (surface[r][s], photos[r][s]) > (surface[r][best], photos[r][best]) { best = s }
            let owner = setOf[r][best]
            for k in cellsOf[r] { out.owners[k] = owner }
            out.regions.append(Region(rooms: setOf[r], owner: owner, area: Double(cellsOf[r].count) * cell * cell))
        }
        return out
    }

    /// Each room's place in the stack of floors, 0 at the bottom (each a hair above the one below):
    /// capture order, except that where rooms overlap the owner's floor lies on top, the one seen.
    func floorOrder() -> [Int: Int] {
        var rank = Dictionary(rooms.enumerated().map { ($1.index, $0) }, uniquingKeysWith: { a, _ in a })
        // Owners rise above the rooms they share with; a loop of owners (three rooms, each over the
        // next) stops rising after a few rounds.
        for _ in 0...rooms.count {
            var moved = false
            for region in regions {
                let top = region.rooms.filter { $0 != region.owner }.compactMap { rank[$0] }.max() ?? -1
                if let own = rank[region.owner], own <= top {
                    rank[region.owner] = top + 1
                    moved = true
                }
            }
            if !moved { break }
        }
        let order = rooms.map(\.index).sorted { (rank[$0] ?? 0, $0) < (rank[$1] ?? 0, $1) }
        return Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
    }
}
