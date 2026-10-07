import Foundation

/// A point or direction in ARKit world space: right-handed, +Y up, meters.
public typealias Vec3 = SIMD3<Float>

/// A point in plan view: (x, z) of world space, in double precision.
typealias P2 = SIMD2<Double>

// Small vector helpers. Named distinctly so they never collide with `simd`
// functions when this package is built inside an app that imports simd.

@inline(__always) func vdot(_ a: Vec3, _ b: Vec3) -> Float { a.x * b.x + a.y * b.y + a.z * b.z }

@inline(__always) func vcross(_ a: Vec3, _ b: Vec3) -> Vec3 {
    Vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
}

@inline(__always) func vlength(_ a: Vec3) -> Float { vdot(a, a).squareRoot() }

@inline(__always) func vnormalize(_ a: Vec3) -> Vec3 {
    let l = vlength(a)
    return l > 1e-12 ? a / l : Vec3(0, 0, 0)
}

@inline(__always) func isFinite(_ v: Vec3) -> Bool { v.x.isFinite && v.y.isFinite && v.z.isFinite }

@inline(__always) func pdot(_ a: P2, _ b: P2) -> Double { a.x * b.x + a.y * b.y }

/// z-component of the 3D cross product of two plan vectors.
@inline(__always) func pcross(_ a: P2, _ b: P2) -> Double { a.x * b.y - a.y * b.x }

@inline(__always) func plength(_ a: P2) -> Double { pdot(a, a).squareRoot() }

@inline(__always) func pnormalize(_ a: P2) -> P2 {
    let l = plength(a)
    return l > 1e-12 ? a / l : P2(0, 0)
}

/// The plan vector rotated 90° (counter-clockwise in the x/z plane).
@inline(__always) func perp(_ a: P2) -> P2 { P2(-a.y, a.x) }

@inline(__always) func plan(_ v: Vec3) -> P2 { P2(Double(v.x), Double(v.z)) }

@inline(__always) func world(_ p: P2, y: Double) -> Vec3 { Vec3(Float(p.x), Float(y), Float(p.y)) }

@inline(__always) func clamp<T: Comparable>(_ v: T, _ lo: T, _ hi: T) -> T { min(max(v, lo), hi) }

/// Rounds to a fixed number of decimals (keeps manifests compact and stable).
@inline(__always) func rounded(_ v: Double, _ decimals: Double = 4) -> Double {
    let f = pow(10, decimals)
    return (v * f).rounded() / f
}

/// A 4×4 affine transform stored as 16 floats in column-major order — the
/// memory layout of `simd_float4x4` and of glTF's `matrix`. Encodes to JSON as
/// a flat array of 16 numbers.
public struct Transform: Equatable, Sendable {
    public var m: [Float]

    public init(columnMajor m: [Float]) {
        precondition(m.count == 16, "Transform needs 16 values")
        self.m = m
    }

    public static let identity = Transform(columnMajor: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

    /// Column 3: the position of the local origin.
    public var translation: Vec3 { Vec3(m[12], m[13], m[14]) }
    /// Column 0 (for RoomPlan surfaces: along the width).
    public var xAxis: Vec3 { Vec3(m[0], m[1], m[2]) }
    /// Column 1 (for RoomPlan surfaces and objects: up).
    public var yAxis: Vec3 { Vec3(m[4], m[5], m[6]) }
    /// Column 2 (for RoomPlan surfaces: the surface normal).
    public var zAxis: Vec3 { Vec3(m[8], m[9], m[10]) }

    /// Transforms a point.
    public func apply(_ p: Vec3) -> Vec3 { xAxis * p.x + yAxis * p.y + zAxis * p.z + translation }

    /// Transforms a direction (ignores translation).
    public func applyDirection(_ d: Vec3) -> Vec3 { xAxis * d.x + yAxis * d.y + zAxis * d.z }

    public var isFinite: Bool { m.allSatisfy { $0.isFinite } }

    public static func translating(_ t: Vec3) -> Transform {
        Transform(columnMajor: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t.x, t.y, t.z, 1])
    }

    /// Rotation about +Y by `angle` radians (right-handed: +X turns toward −Z).
    public static func rotationY(_ angle: Float) -> Transform {
        let c = cos(angle), s = sin(angle)
        return Transform(columnMajor: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1])
    }

    /// Matrix product `a * b` (apply `b` first, then `a`).
    public static func * (a: Transform, b: Transform) -> Transform {
        var r = [Float](repeating: 0, count: 16)
        for col in 0..<4 {
            for row in 0..<4 {
                var sum: Float = 0
                for k in 0..<4 { sum += a.m[k * 4 + row] * b.m[col * 4 + k] }
                r[col * 4 + row] = sum
            }
        }
        return Transform(columnMajor: r)
    }
}

extension Transform: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let values = try container.decode([Float].self)
        guard values.count == 16 else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "A transform needs 16 numbers, got \(values.count)")
        }
        self.init(columnMajor: values)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(m)
    }
}
