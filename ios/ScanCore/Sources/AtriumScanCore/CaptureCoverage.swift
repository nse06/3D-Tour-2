import Foundation

/// How well the photos taken so far cover the room being scanned — which walls, stretches of floor
/// and pieces of furniture already have a good photo and which still need one — for the capture
/// screen's map. A photo covers a spot by the painting's own rules: it faces the spot, points at it,
/// is close enough and nothing stands in between (walls, furniture boxes). Good: within 60° of
/// head-on, 4.5 m and away from the photo's edges; weak: seen at all (from the side, far away or at
/// the edge of the frame), which paints soft or stretched. What furniture stands right in front of
/// (the wall behind a wardrobe, the side of a cabinet against the next one) needs no photo and
/// doesn't count.
public struct CaptureCoverage: Sendable, Equatable {
    public enum Level: UInt8, Sendable, Comparable {
        case missing = 0, weak = 1, good = 2

        public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
    }

    /// A wall seen from above: from `a` to `b` (plan x, z), its stretches in order, each 25 cm or so
    /// (nil where furniture stands against it and hides it).
    public struct Wall: Sendable, Equatable {
        public var a: SIMD2<Double>
        public var b: SIMD2<Double>
        public var levels: [Level?]
    }

    /// A square of floor, `cellSize` across.
    public struct Cell: Sendable, Equatable {
        public var center: SIMD2<Double>
        public var level: Level
    }

    /// A piece of furniture's footprint.
    public struct Item: Sendable, Equatable {
        public var corners: [SIMD2<Double>]
        public var level: Level
    }

    public var outline: [SIMD2<Double>] = []
    public var walls: [Wall] = []
    public var floor: [Cell] = []
    public var cellSize: Double = 0.3
    public var items: [Item] = []
    /// Shares covered well (0–1, furniture by surface; nil where there's nothing of that kind yet).
    public var wallShare: Double?
    public var floorShare: Double?
    public var itemShare: Double?

    public init() {}

    /// The room `part` (in the frame its photos were taken in) and the photos taken in that frame.
    public static func compute(_ part: RoomPart, photos: [CameraFrame]) -> CaptureCoverage {
        var out = CaptureCoverage()
        let room = part.room
        let outline = room.floorPolygon.map(plan)
        guard outline.count >= 3 else { return out }
        out.outline = outline
        let floorY = Double(room.floorY)
        let centroid = outline.reduce(P2(0, 0), +) / Double(outline.count)
        let views = photos.compactMap(View.init)
        var occluders = Occluders()

        // Walls: segments in plan, their bottom and top, facing into the room.
        struct WallGeometry {
            var a: P2, b: P2, bottom: Double, top: Double, normal: Vec3
        }
        var walls: [WallGeometry] = []
        for w in part.walls where w.transform.isFinite && w.width > 0.05 {
            let c = w.transform.translation, x = vnormalize(w.transform.xAxis)
            let a = plan(c - x * (w.width / 2)), b = plan(c + x * (w.width / 2))
            let along = b - a
            var n = P2(-along.y, along.x) / max(plength(along), 1e-9)
            if pdot(n, centroid - (a + b) / 2) < 0 { n = -n }
            walls.append(WallGeometry(a: a, b: b, bottom: Double(c.y - w.height / 2), top: Double(c.y + w.height / 2), normal: Vec3(Float(n.x), 0, Float(n.y))))
            occluders.walls.append((a, b))
        }
        // Furniture: boxes (they hide what's behind them), their tops and open sides sampled.
        for o in part.objects where o.transform.isFinite && o.size.x > 0.05 && o.size.z > 0.05 {
            occluders.boxes.append((o.transform, o.size / 2))
        }

        // Walls: a column of three spots every 25 cm.
        var wallGood = 0, wallTotal = 0
        for (k, w) in walls.enumerated() {
            let length = plength(w.b - w.a)
            let columns = max(1, Int((length / 0.25).rounded()))
            var levels: [Level?] = []
            for i in 0..<columns {
                let s = (Double(i) + 0.5) / Double(columns)
                let q = w.a + (w.b - w.a) * s
                var column: [Level] = []
                for h in [0.35, 1.1, 1.85] where w.bottom + h < w.top - 0.05 {
                    let p = Vec3(Float(q.x), Float(w.bottom + h), Float(q.y)) + w.normal * 0.01
                    if occluders.covers(p, facing: w.normal, skipBox: nil) { continue }
                    let level = best(views, at: p, normal: w.normal, occluders: occluders, skipWall: k, skipBox: nil)
                    column.append(level)
                    wallTotal += 1
                    if level == .good { wallGood += 1 }
                }
                levels.append(column.isEmpty ? nil : column.sorted()[column.count / 2])
            }
            out.walls.append(Wall(a: w.a, b: w.b, levels: levels))
        }
        if wallTotal > 0 { out.wallShare = Double(wallGood) / Double(wallTotal) }

        // Floor: cells inside the outline and not under furniture.
        let xs = outline.map(\.x), zs = outline.map(\.y)
        let size = out.cellSize
        var floorGood = 0
        var z = (zs.min() ?? 0) + size / 2
        while z < (zs.max() ?? 0) {
            var x = (xs.min() ?? 0) + size / 2
            while x < (xs.max() ?? 0) {
                let c = P2(x, z)
                let p = Vec3(Float(x), Float(floorY + 0.01), Float(z))
                if pointInPolygon(c, outline), !occluders.boxes.contains(where: { MeshShapes.inside(p + Vec3(0, 0.05, 0), $0.frame, $0.half) }) {
                    let level = best(views, at: p, normal: Vec3(0, 1, 0), occluders: occluders, skipWall: nil, skipBox: nil)
                    out.floor.append(Cell(center: c, level: level))
                    if level == .good { floorGood += 1 }
                }
                x += size
            }
            z += size
        }
        if !out.floor.isEmpty { out.floorShare = Double(floorGood) / Double(out.floor.count) }

        // Furniture: its top (unless it's above eye level, where no one sees it) and its sides, a spot
        // every 30 cm (60 cm up the sides) that isn't against a wall or other furniture; its level is
        // the best that at least half of what shows of it reaches.
        var itemGoodArea = 0.0, itemArea = 0.0
        for (k, box) in occluders.boxes.enumerated() {
            let (t, half) = box
            let X = vnormalize(t.xAxis), Y = vnormalize(t.yAxis), Z = vnormalize(t.zAxis), c = t.translation
            var spots: [(level: Level, area: Double)] = []
            /// The face around `center` facing `normal`, spanning ±`hu` along `u` and ±`hv` along `v`.
            func face(_ center: Vec3, _ normal: Vec3, _ u: Vec3, _ hu: Float, _ v: Vec3, _ hv: Float, step: (Float, Float), isSide: Bool) {
                let nu = max(1, Int((2 * hu / step.0).rounded())), nv = max(1, Int((2 * hv / step.1).rounded()))
                let area = Double(4 * hu * hv) / Double(nu * nv)
                for i in 0..<nu {
                    for j in 0..<nv {
                        let a = (Float(i) + 0.5) / Float(nu) * 2 - 1, b = (Float(j) + 0.5) / Float(nv) * 2 - 1
                        let p = center + u * (a * hu) + v * (b * hv) + normal * 0.01
                        // A side right against a wall shows nothing.
                        if isSide, occluders.walls.contains(where: { distanceToSegment(plan(p), $0.0, $0.1) < 0.12 }) { continue }
                        if occluders.covers(p, facing: normal, skipBox: k) { continue }
                        spots.append((best(views, at: p, normal: normal, occluders: occluders, skipWall: nil, skipBox: k), area))
                    }
                }
            }
            if Double(c.y + half.y) - floorY < 1.4 { face(c + Y * half.y, Y, X, half.x, Z, half.z, step: (0.3, 0.3), isSide: false) }
            face(c + X * half.x, X, Z, half.z, Y, half.y, step: (0.3, 0.6), isSide: true)
            face(c - X * half.x, -X, Z, half.z, Y, half.y, step: (0.3, 0.6), isSide: true)
            face(c + Z * half.z, Z, X, half.x, Y, half.y, step: (0.3, 0.6), isSide: true)
            face(c - Z * half.z, -Z, X, half.x, Y, half.y, step: (0.3, 0.6), isSide: true)
            // Nothing of it shows (a box inside another one): nothing to photograph.
            let total = spots.reduce(0) { $0 + $1.area }
            guard total > 0 else { continue }
            func share(_ least: Level) -> Double { spots.filter { $0.level >= least }.reduce(0) { $0 + $1.area } / total }
            let level: Level = share(.good) >= 0.5 ? .good : share(.weak) >= 0.5 ? .weak : .missing
            itemArea += total
            itemGoodArea += share(.good) * total
            let corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)].map { sx, sz in plan(c + X * (Float(sx) * half.x) + Z * (Float(sz) * half.z)) }
            out.items.append(Item(corners: corners, level: level))
        }
        if itemArea > 0 { out.itemShare = itemGoodArea / itemArea }
        return out
    }

    /// A photo, ready for projection (ARKit camera: x right, y up, looking along −z).
    struct View {
        let position: Vec3, right: Vec3, up: Vec3, back: Vec3
        let fx: Float, fy: Float, cx: Float, cy: Float, width: Float, height: Float

        init?(_ f: CameraFrame) {
            let k = f.intrinsics
            guard k.count == 9, f.width > 0, f.height > 0, f.transform.isFinite, k[0] > 1, k[4] > 1 else { return nil }
            position = f.transform.translation
            right = vnormalize(f.transform.xAxis)
            up = vnormalize(f.transform.yAxis)
            back = vnormalize(f.transform.zAxis)
            (fx, fy, cx, cy) = (k[0], k[4], k[6], k[7])
            (width, height) = (Float(f.width), Float(f.height))
        }
    }

    /// What may stand between a photo and a spot.
    struct Occluders {
        var walls: [(P2, P2)] = []
        var boxes: [(frame: Transform, half: Vec3)] = []

        /// Whether furniture (but box `skipBox`) stands right in front of spot p facing `normal`: the
        /// wall behind a wardrobe or a headboard, the side of a cabinet against the next one.
        func covers(_ p: Vec3, facing normal: Vec3, skipBox: Int?) -> Bool {
            let q = p + normal * 0.12
            for (k, box) in boxes.enumerated() where k != skipBox {
                if MeshShapes.inside(q, box.frame, box.half + Vec3(repeating: 0.02)) { return true }
            }
            return false
        }
    }

    /// The best any photo does at point p (facing `normal`).
    static func best(_ views: [View], at p: Vec3, normal: Vec3, occluders: Occluders, skipWall: Int?, skipBox: Int?) -> Level {
        var best = Level.missing
        for v in views {
            let toCam = v.position - p
            let dist = vlength(toCam)
            guard dist > 0.2, dist < 7 else { continue }
            let facing = vdot(normal, toCam) / dist
            guard facing > 0.2 else { continue }
            let d = p - v.position
            let z = -vdot(d, v.back)
            guard z > 0.1 else { continue }
            let u = (v.fx * vdot(d, v.right) / z + v.cx) / v.width, w = (-v.fy * vdot(d, v.up) / z + v.cy) / v.height
            guard u > 0.02, u < 0.98, w > 0.02, w < 0.98 else { continue }
            let level: Level = facing >= 0.5 && dist <= 4.5 && abs(u - 0.5) < 0.42 && abs(w - 0.5) < 0.42 ? .good : .weak
            guard level > best, !blocked(from: v.position, to: p, occluders, skipWall: skipWall, skipBox: skipBox) else { continue }
            best = level
            if best == .good { break }
        }
        return best
    }

    /// Whether a wall or a piece of furniture stands between `a` (the camera) and `b` (the spot).
    static func blocked(from a: Vec3, to b: Vec3, _ occluders: Occluders, skipWall: Int?, skipBox: Int?) -> Bool {
        let pa = plan(a), pb = plan(b)
        for (k, w) in occluders.walls.enumerated() where k != skipWall {
            // Spots on a wall's end or in a corner touch the neighbouring wall: stop 5 cm short.
            let dir = pb - pa, length = plength(dir)
            guard length > 0.06 else { continue }
            if segmentsCross(pa, pa + dir * ((length - 0.05) / length), w.0, w.1) { return true }
        }
        for (k, box) in occluders.boxes.enumerated() where k != skipBox {
            if segmentHitsBox(a, b, box.frame, box.half - Vec3(repeating: 0.02)) { return true }
        }
        return false
    }

    static func segmentsCross(_ p1: P2, _ p2: P2, _ q1: P2, _ q2: P2) -> Bool {
        func orient(_ a: P2, _ b: P2, _ c: P2) -> Double { (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) }
        let d1 = orient(q1, q2, p1), d2 = orient(q1, q2, p2), d3 = orient(p1, p2, q1), d4 = orient(p1, p2, q2)
        return d1 * d2 < 0 && d3 * d4 < 0
    }

    /// Slab test in the box's own axes.
    static func segmentHitsBox(_ a: Vec3, _ b: Vec3, _ frame: Transform, _ half: Vec3) -> Bool {
        let axes = [vnormalize(frame.xAxis), vnormalize(frame.yAxis), vnormalize(frame.zAxis)]
        let o = a - frame.translation, d = b - a
        var t0: Float = 0, t1: Float = 1
        for k in 0..<3 {
            let oa = vdot(o, axes[k]), da = vdot(d, axes[k]), h = half[k]
            if abs(da) < 1e-9 {
                if abs(oa) > h { return false }
                continue
            }
            var near = (-h - oa) / da, far = (h - oa) / da
            if near > far { swap(&near, &far) }
            t0 = max(t0, near)
            t1 = min(t1, far)
            if t0 > t1 { return false }
        }
        return true
    }
}
