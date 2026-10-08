import Foundation

/// Furniture and clutter from the LiDAR mesh: whatever stands in a room besides its walls, floor
/// and ceiling — sofas, tables, plants, lamps, shelves — in its real shape instead of RoomPlan's
/// boxes. The mesh is cropped to each room, the parts lying on the room's walls, floor and ceiling
/// are dropped (those are the room's own surfaces), the rest is simplified and cut into nearly flat
/// patches the photos are painted onto. A RoomPlan object keeps its box when the mesh barely saw it
/// (a TV on the wall, a corner the scan rushed past).
struct MeshShapes {
    /// A nearly flat piece of the mesh: one photo chart.
    struct Patch {
        /// Triangles, as indices into `triangles`.
        var faces: [Int]
        /// Area-weighted average of its faces' normals.
        var normal: Vec3
        var origin: Vec3
        var u: Vec3
        var v: Vec3
    }

    struct Options {
        /// Mesh this close to a wall, the floor or the ceiling (and facing the same way) is that surface, meters.
        var surfaceMargin: Double = 0.06
        /// ...and this close if ARKit also classified it as one.
        var classifiedMargin: Double = 0.15
        /// Vertex grid the mesh is simplified on, meters (coarsened to stay within `maxTriangles`).
        var grid: Float = 0.035
        var maxTriangles = 60_000
        /// Loose pieces smaller than this across (meters) are noise.
        var minPiece: Float = 0.1
        /// A patch's faces turn at most this far from its normal (cosine; about 44°: each texel is
        /// painted at its own point on the faces, so a patch only has to stay unfolded).
        var patchCos: Float = 0.72
        /// Patches smaller than this (square meters) join a neighbour: every patch costs atlas padding.
        var tinyPatch: Float = 0.01
        /// A room's mesh counts if this many of its triangles are furniture or clutter.
        var minRoomTriangles = 200
    }

    var vertices: [Vec3] = []
    /// Three vertex indices per triangle, counter-clockwise seen from outside.
    var triangles: [SIMD3<Int32>] = []
    var patches: [Patch] = []
    /// RoomPlan objects the mesh replaces.
    var replaced: Set<String> = []
    /// Rooms (by index) whose mesh is used.
    var rooms: Set<Int> = []
    /// Simplification grid used, meters.
    var grid: Float = 0

    /// One triangle of the cropped mesh before simplification, with the side it faces.
    private struct Source {
        var a: Vec3, b: Vec3, c: Vec3
        var facing: Vec3
    }

    static func build(_ meshes: [ScanMesh], rooms: [RoomInfo], walls: [WallInfo], objects: [ScanObject], options: Options = .init()) -> MeshShapes {
        var shapes = MeshShapes()
        guard !meshes.isEmpty else { return shapes }

        // 1. Each room's furniture and clutter: its mesh inside its outline, off its surfaces.
        var soup: [Source] = []
        var claimed: [RoomInfo] = []
        for room in rooms {
            let own = meshes.filter { $0.roomId == room.room.id || $0.roomId == nil }
            guard !own.isEmpty else { continue }
            var kept: [Source] = []
            for mesh in own {
                let hasNormals = mesh.normals.count == mesh.vertices.count, hasClasses = mesh.classes.count == mesh.triangleCount
                for t in 0..<mesh.triangleCount {
                    let ia = Int(mesh.indices[t * 3]), ib = Int(mesh.indices[t * 3 + 1]), ic = Int(mesh.indices[t * 3 + 2])
                    let a = mesh.vertices[ia], b = mesh.vertices[ib], c = mesh.vertices[ic]
                    let cross = vcross(b - a, c - a)
                    guard vlength(cross) > 1e-10 else { continue }
                    var facing = vnormalize(cross)
                    if hasNormals {
                        let n = mesh.normals[ia] + mesh.normals[ib] + mesh.normals[ic]
                        if vlength(n) > 1e-6, vdot(n, facing) < 0 { facing = -facing }
                    }
                    let surface = hasClasses ? ScanMesh.Surface(rawValue: mesh.classes[t]) : nil
                    let g = (a + b + c) / 3
                    let q = plan(g)
                    // In this room, and not already taken by an overlapping room scanned before it.
                    guard pointInPolygon(q, room.poly), !claimed.contains(where: { pointInPolygon(q, $0.poly) }) else { continue }
                    guard !isRoomSurface(g, facing: facing, surface: surface, room: room, walls: walls, options: options) else { continue }
                    kept.append(Source(a: a, b: b, c: c, facing: facing))
                }
            }
            guard kept.count >= options.minRoomTriangles else { continue }
            soup += kept
            claimed.append(room)
            shapes.rooms.insert(room.index)
        }
        guard !soup.isEmpty else { return shapes }

        // 2. Simplified on a grid, coarser until it fits the budget; loose bits of noise dropped.
        var grid = options.grid
        repeat {
            shapes.weld(soup, grid: grid)
            shapes.dropSmallPieces(options.minPiece)
            if shapes.triangles.count <= options.maxTriangles { break }
            grid *= 1.25
        } while grid < 0.5
        shapes.grid = grid

        // 3. Objects the mesh shows replace their boxes; the others keep them, and the mesh inside goes.
        shapes.settle(objects, rooms: rooms)

        // 4. Patches.
        shapes.makePatches(options)
        return shapes
    }

    /// Whether a triangle (center `g`, facing `facing`) lies on one of the room's walls, its floor or its ceiling.
    static func isRoomSurface(_ g: Vec3, facing: Vec3, surface: ScanMesh.Surface?, room: RoomInfo, walls: [WallInfo], options: Options) -> Bool {
        let y = Double(g.y)
        let floorMargin = surface == .floor ? options.classifiedMargin : options.surfaceMargin * 0.7
        if y < room.floorY + floorMargin { return true }
        let ceilingMargin = surface == .ceiling ? options.classifiedMargin : options.surfaceMargin
        if y > room.ceilingY - ceilingMargin { return true }
        let wallLike = surface == .wall || surface == .window || surface == .door
        let margin = wallLike ? options.classifiedMargin : options.surfaceMargin
        let q = plan(g)
        for w in walls {
            let d = w.offset(of: q)
            guard abs(d) < margin, y > w.y0 - margin, y < w.y1 + margin else { continue }
            let s = w.s(of: q)
            guard s > -margin, s < w.length + margin else { continue }
            // Facing along the wall's normal (either way): part of the wall, or something flat on it.
            if abs(Double(facing.x) * w.nIn.x + Double(facing.z) * w.nIn.y) > 0.75 || wallLike { return true }
        }
        return false
    }

    /// Vertex clustering: every vertex moves to the average of its grid cell, triangles that
    /// collapse go, and each keeps facing its original side.
    private mutating func weld(_ soup: [Source], grid: Float) {
        var cellIndex: [SIMD3<Int32>: Int32] = [:]
        var sums: [Vec3] = []
        var counts: [Float] = []
        func cluster(_ p: Vec3) -> Int32 {
            let key = SIMD3<Int32>(Int32((p.x / grid).rounded(.down)), Int32((p.y / grid).rounded(.down)), Int32((p.z / grid).rounded(.down)))
            if let i = cellIndex[key] {
                sums[Int(i)] += p
                counts[Int(i)] += 1
                return i
            }
            let i = Int32(sums.count)
            cellIndex[key] = i
            sums.append(p)
            counts.append(1)
            return i
        }
        var faces: [(SIMD3<Int32>, Vec3)] = []
        faces.reserveCapacity(soup.count)
        for s in soup {
            let ia = cluster(s.a), ib = cluster(s.b), ic = cluster(s.c)
            guard ia != ib, ib != ic, ia != ic else { continue }
            faces.append((SIMD3(ia, ib, ic), s.facing))
        }
        let points = sums.indices.map { sums[$0] / counts[$0] }
        // One triangle per vertex triple and side (a thin table top that collapses keeps both its
        // sides); each keeps facing the side it was seen from.
        var seen = Set<SIMD3<Int32>>()
        var used = [Int32](repeating: -1, count: points.count)
        vertices = []
        triangles = []
        for (f, facing) in faces {
            let a = points[Int(f.x)], b = points[Int(f.y)], c = points[Int(f.z)]
            let n = vcross(b - a, c - a)
            guard vlength(n) > 1e-9 else { continue }
            let tri = vdot(n, facing) < 0 ? SIMD3(f.x, f.z, f.y) : f
            // The same triangle, starting from its lowest vertex.
            let key = tri.x <= tri.y && tri.x <= tri.z ? tri : tri.y <= tri.z ? SIMD3(tri.y, tri.z, tri.x) : SIMD3(tri.z, tri.x, tri.y)
            guard seen.insert(key).inserted else { continue }
            for k in 0..<3 where used[Int(tri[k])] < 0 {
                used[Int(tri[k])] = Int32(vertices.count)
                vertices.append(points[Int(tri[k])])
            }
            triangles.append(SIMD3(used[Int(tri.x)], used[Int(tri.y)], used[Int(tri.z)]))
        }
    }

    /// Drops connected pieces smaller than `size` across.
    private mutating func dropSmallPieces(_ size: Float) {
        var parent = Array(0..<Int32(vertices.count))
        func find(_ x: Int32) -> Int32 {
            var r = x
            while parent[Int(r)] != r { r = parent[Int(r)] }
            var y = x
            while parent[Int(y)] != r {
                let next = parent[Int(y)]
                parent[Int(y)] = r
                y = next
            }
            return r
        }
        for t in triangles {
            let a = find(t.x), b = find(t.y), c = find(t.z)
            parent[Int(b)] = a
            parent[Int(find(c))] = a
        }
        var lo: [Int32: Vec3] = [:], hi: [Int32: Vec3] = [:]
        for (i, p) in vertices.enumerated() {
            let r = find(Int32(i))
            lo[r] = lo[r].map { simd_min_(p, $0) } ?? p
            hi[r] = hi[r].map { simd_max_(p, $0) } ?? p
        }
        keep { t in
            let r = find(t.x)
            return vlength(hi[r]! - lo[r]!) >= size
        }
    }

    /// Keeps the triangles `include` accepts (and the vertices they use).
    private mutating func keep(_ include: (SIMD3<Int32>) -> Bool) {
        var used = [Int32](repeating: -1, count: vertices.count)
        var points: [Vec3] = []
        var kept: [SIMD3<Int32>] = []
        for t in triangles where include(t) {
            for k in 0..<3 where used[Int(t[k])] < 0 {
                used[Int(t[k])] = Int32(points.count)
                points.append(vertices[Int(t[k])])
            }
            kept.append(SIMD3(used[Int(t.x)], used[Int(t.y)], used[Int(t.z)]))
        }
        vertices = points
        triangles = kept
    }

    func center(_ t: SIMD3<Int32>) -> Vec3 { (vertices[Int(t.x)] + vertices[Int(t.y)] + vertices[Int(t.z)]) / 3 }

    func area(_ t: SIMD3<Int32>) -> Float {
        vlength(vcross(vertices[Int(t.y)] - vertices[Int(t.x)], vertices[Int(t.z)] - vertices[Int(t.x)])) / 2
    }

    func normal(_ t: SIMD3<Int32>) -> Vec3 {
        vnormalize(vcross(vertices[Int(t.y)] - vertices[Int(t.x)], vertices[Int(t.z)] - vertices[Int(t.x)]))
    }

    /// RoomPlan objects in rooms with a mesh: replaced by the mesh where it covers at least half the
    /// object's footprint (counting all its surfaces), else kept — and the scraps of mesh inside go.
    private mutating func settle(_ objects: [ScanObject], rooms all: [RoomInfo]) {
        let meshed = all.filter { rooms.contains($0.index) }
        var boxes: [(frame: Transform, half: Vec3)] = []
        for o in objects where o.transform.isFinite {
            let c = plan(o.transform.translation)
            let room = all.first { $0.room.id == o.roomId } ?? all.first { pointInPolygon(c, $0.poly) }
            guard let room, meshed.contains(where: { $0.index == room.index }) else { continue }
            let frame = Furniture.rigid(o.transform)
            let half = o.size / 2 + Vec3(repeating: 0.05)
            var area: Float = 0
            for t in triangles where Self.inside(center(t), frame, half) { area += self.area(t) }
            if area >= 0.5 * o.size.x * o.size.z {
                replaced.insert(o.id)
            } else {
                boxes.append((frame, half))
            }
        }
        guard !boxes.isEmpty else { return }
        let points = vertices
        keep { t in
            let g = (points[Int(t.x)] + points[Int(t.y)] + points[Int(t.z)]) / 3
            return !boxes.contains { Self.inside(g, $0.frame, $0.half) }
        }
    }

    static func inside(_ p: Vec3, _ frame: Transform, _ half: Vec3) -> Bool {
        let d = p - frame.translation
        return abs(vdot(d, frame.xAxis)) <= half.x && abs(vdot(d, frame.yAxis)) <= half.y && abs(vdot(d, frame.zAxis)) <= half.z
    }

    /// Region growing over shared edges: a patch takes neighbouring faces while they keep facing
    /// its way; tiny patches join the neighbour they face most like.
    private mutating func makePatches(_ options: Options) {
        let n = triangles.count
        guard n > 0 else { return }
        let normals = triangles.map(normal)
        let areas = triangles.map(area)
        // Faces around each edge.
        var edgeFaces: [UInt64: [Int32]] = [:]
        func key(_ a: Int32, _ b: Int32) -> UInt64 { UInt64(UInt32(min(a, b))) << 32 | UInt64(UInt32(max(a, b))) }
        for (f, t) in triangles.enumerated() {
            for (a, b) in [(t.x, t.y), (t.y, t.z), (t.z, t.x)] { edgeFaces[key(a, b), default: []].append(Int32(f)) }
        }
        func neighbours(_ f: Int) -> [Int] {
            let t = triangles[f]
            var out: [Int] = []
            for (a, b) in [(t.x, t.y), (t.y, t.z), (t.z, t.x)] {
                for g in edgeFaces[key(a, b)] ?? [] where Int(g) != f { out.append(Int(g)) }
            }
            return out
        }

        var patchOf = [Int](repeating: -1, count: n)
        var members: [[Int]] = []
        var sums: [Vec3] = []
        var areaOf: [Float] = []
        // Biggest faces first, so patches start in the middle of flat areas.
        for seed in (0..<n).sorted(by: { areas[$0] > areas[$1] }) where patchOf[seed] < 0 {
            let id = members.count
            var faces = [seed], sum = normals[seed] * areas[seed], total = areas[seed]
            patchOf[seed] = id
            var queue = [seed], head = 0
            while head < queue.count {
                let f = queue[head]
                head += 1
                let dir = vnormalize(sum)
                for g in neighbours(f) where patchOf[g] < 0 && vdot(normals[g], dir) > options.patchCos {
                    patchOf[g] = id
                    faces.append(g)
                    sum += normals[g] * areas[g]
                    total += areas[g]
                    queue.append(g)
                }
            }
            members.append(faces)
            sums.append(sum)
            areaOf.append(total)
        }

        // Tiny patches join the neighbouring patch they face most like (if it faces their way at all).
        for id in members.indices where areaOf[id] < options.tinyPatch && !members[id].isEmpty {
            let dir = vnormalize(sums[id])
            var best = -1, bestDot: Float = 0.35
            for f in members[id] {
                for g in neighbours(f) where patchOf[g] != id {
                    let other = patchOf[g]
                    let d = vdot(vnormalize(sums[other]), dir)
                    if d > bestDot, members[id].allSatisfy({ vdot(normals[$0], vnormalize(sums[other])) > 0.1 }) {
                        bestDot = d
                        best = other
                    }
                }
            }
            guard best >= 0 else { continue }
            for f in members[id] { patchOf[f] = best }
            members[best] += members[id]
            sums[best] += sums[id]
            areaOf[best] += areaOf[id]
            members[id] = []
        }

        patches = []
        for (id, faces) in members.enumerated() where !faces.isEmpty {
            let normal = vnormalize(sums[id])
            guard vlength(normal) > 0.5 else { continue }
            var origin = Vec3(0, 0, 0), total: Float = 0
            for f in faces {
                origin += center(triangles[f]) * areas[f]
                total += areas[f]
            }
            origin /= max(total, 1e-9)
            // Horizontal u on walls and fronts; along x on tops and bottoms.
            let u = abs(normal.y) > 0.9 ? vnormalize(Vec3(1, 0, 0) - normal * normal.x) : vnormalize(vcross(Vec3(0, 1, 0), normal))
            let v = vcross(normal, u)
            patches.append(Patch(faces: faces, normal: normal, origin: origin, u: u, v: v))
        }
    }
}

@inline(__always) private func simd_min_(_ a: Vec3, _ b: Vec3) -> Vec3 { Vec3(min(a.x, b.x), min(a.y, b.y), min(a.z, b.z)) }
@inline(__always) private func simd_max_(_ a: Vec3, _ b: Vec3) -> Vec3 { Vec3(max(a.x, b.x), max(a.y, b.y), max(a.z, b.z)) }
