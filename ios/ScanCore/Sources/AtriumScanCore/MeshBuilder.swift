import Foundation

/// Triangle soup for one material: positions, normals, UVs and indices.
struct MeshBuffer {
    var positions: [Float] = []
    var normals: [Float] = []
    var uvs: [Float] = []
    var indices: [UInt32] = []

    var vertexCount: Int { positions.count / 3 }
    var triangleCount: Int { indices.count / 3 }
    var isEmpty: Bool { indices.isEmpty }

    mutating func addVertex(_ p: Vec3, _ n: Vec3, _ uv: SIMD2<Float>) -> UInt32 {
        let i = UInt32(vertexCount)
        positions += [p.x, p.y, p.z]
        normals += [n.x, n.y, n.z]
        uvs += [uv.x, uv.y]
        return i
    }
}

/// UVs: world-space planar mapping (so textures line up across separate pieces).
enum UVMode {
    /// Floors and ceilings: (x, z) / scale.
    case planXZ(scale: Float)
    /// Vertical faces: (distance along `axis`, height) / scale.
    case vertical(axis: Vec3, scale: Float)
    /// Photo charts: meters along two in-plane axes from `origin` (turned into atlas UVs later).
    case chart(origin: Vec3, u: Vec3, v: Vec3)

    func uv(_ p: Vec3) -> SIMD2<Float> {
        switch self {
        case let .planXZ(scale):
            return SIMD2(p.x / scale, p.z / scale)
        case let .vertical(axis, scale):
            return SIMD2(vdot(p, axis) / scale, -p.y / scale)
        case let .chart(origin, u, v):
            return SIMD2(vdot(p - origin, u), vdot(p - origin, v))
        }
    }
}

/// Collects geometry per material and keeps every face's winding consistent
/// with its intended normal (glTF front faces are counter-clockwise).
struct MeshBuilder {
    private(set) var buffers: [String: MeshBuffer] = [:]
    /// Material keys in first-use order, for deterministic output.
    private(set) var order: [String] = []

    var triangleCount: Int { buffers.values.reduce(0) { $0 + $1.triangleCount } }

    private mutating func withBuffer(_ material: String, _ body: (inout MeshBuffer) -> Void) {
        if buffers[material] == nil {
            buffers[material] = MeshBuffer()
            order.append(material)
        }
        body(&buffers[material]!)
    }

    /// A flat polygon (convex, in order around its edge) facing `normal`.
    mutating func addFace(_ points: [Vec3], normal: Vec3, material: String, uv: UVMode? = nil) {
        guard points.count >= 3, points.allSatisfy(isFinite) else { return }
        let n = vnormalize(normal)
        guard vlength(n) > 0.5 else { return }
        // Flip the winding if the geometric normal disagrees with the intended one.
        var face = points
        var geometric = Vec3(0, 0, 0)
        for i in 1..<(face.count - 1) { geometric += vcross(face[i] - face[0], face[i + 1] - face[0]) }
        guard vlength(geometric) > 1e-9 else { return }
        if vdot(geometric, n) < 0 { face.reverse() }
        let mode = uv ?? Self.defaultUV(for: n)
        withBuffer(material) { buf in
            let base = face.map { buf.addVertex($0, n, mode.uv($0)) }
            for i in 1..<(base.count - 1) { buf.indices += [base[0], base[i], base[i + 1]] }
        }
    }

    /// A triangulated plan polygon at height `y`, facing up or down.
    mutating func addPlanPolygon(_ poly: [P2], y: Double, facingUp: Bool, material: String, uvScale: Float, uv: UVMode? = nil) {
        let tris = triangulate(poly)
        guard !tris.isEmpty else { return }
        let n = Vec3(0, facingUp ? 1 : -1, 0)
        let mode = uv ?? UVMode.planXZ(scale: uvScale)
        withBuffer(material) { buf in
            let base = poly.map { p -> UInt32 in
                let v = world(p, y: y)
                return buf.addVertex(v, n, mode.uv(v))
            }
            for (a, b, c) in tris {
                // `triangulate` returns counter-clockwise (x, z) triangles, whose
                // geometric normal points −Y (x × z = −y in a right-handed frame).
                if facingUp { buf.indices += [base[a], base[c], base[b]] } else { buf.indices += [base[a], base[b], base[c]] }
            }
        }
    }

    /// An oriented box from its 8 corners' generator: `corner(sx, sy, sz)` with s ∈ {0, 1}.
    mutating func addBox(material: String, skipBottom: Bool = false, corner: (Int, Int, Int) -> Vec3) {
        let c = (0..<8).map { i in corner(i & 1, (i >> 1) & 1, (i >> 2) & 1) }
        guard c.allSatisfy(isFinite) else { return }
        let center = c.reduce(Vec3(0, 0, 0), +) / 8
        // Faces as corner index quads; outward normal from the box center.
        let faces: [[Int]] = [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]]
        for (k, f) in faces.enumerated() {
            if skipBottom && k == 2 { continue }
            let pts = f.map { c[$0] }
            let faceCenter = pts.reduce(Vec3(0, 0, 0), +) / 4
            var n = vcross(pts[1] - pts[0], pts[3] - pts[0])
            if vdot(n, faceCenter - center) < 0 { n = -n }
            addFace(pts, normal: n, material: material)
        }
    }

    /// An axis-aligned-in-`frame` box: local min/max mapped through a rigid transform.
    mutating func addBox(_ frame: Transform, min lo: Vec3, max hi: Vec3, material: String, skipBottom: Bool = false) {
        guard hi.x > lo.x, hi.y > lo.y, hi.z > lo.z else { return }
        addBox(material: material, skipBottom: skipBottom) { sx, sy, sz in
            frame.apply(Vec3(sx == 0 ? lo.x : hi.x, sy == 0 ? lo.y : hi.y, sz == 0 ? lo.z : hi.z))
        }
    }

    /// Appends another buffer's triangles under `material`, mapping its UVs.
    mutating func append(_ other: MeshBuffer, material: String, uv map: (SIMD2<Float>) -> SIMD2<Float>) {
        guard !other.isEmpty else { return }
        withBuffer(material) { buf in
            let base = UInt32(buf.vertexCount)
            buf.positions += other.positions
            buf.normals += other.normals
            for i in stride(from: 0, to: other.uvs.count, by: 2) {
                let m = map(SIMD2(other.uvs[i], other.uvs[i + 1]))
                buf.uvs += [m.x, m.y]
            }
            buf.indices += other.indices.map { $0 + base }
        }
    }

    static func defaultUV(for n: Vec3) -> UVMode {
        if abs(n.y) > 0.7 { return .planXZ(scale: 1) }
        // Along the face, horizontally.
        return .vertical(axis: vnormalize(Vec3(-n.z, 0, n.x)), scale: 1)
    }
}
