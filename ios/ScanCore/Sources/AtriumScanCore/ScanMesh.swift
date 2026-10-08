import Foundation

/// The LiDAR surface mesh ARKit reconstructed while a room was scanned, in that room's frame:
/// triangles, vertex normals pointing out of the surface (toward where it was seen from), and
/// ARKit's guess of what each face is. Saved next to the room's RoomPlan data
/// (roomplan/mesh-run-N.bin), never in scan.json.
public struct ScanMesh: Sendable, Equatable {
    /// ARMeshClassification raw values.
    public enum Surface: UInt8, Sendable {
        case none = 0, wall, floor, ceiling, table, seat, window, door
    }

    public var vertices: [Vec3]
    /// One per vertex, or empty.
    public var normals: [Vec3]
    /// Three vertex indices per triangle.
    public var indices: [UInt32]
    /// One `Surface` raw value per triangle, or empty.
    public var classes: [UInt8]
    /// The room it was captured with (`ScanRoom.id`), once attached to one.
    public var roomId: String?

    public init(vertices: [Vec3], normals: [Vec3] = [], indices: [UInt32], classes: [UInt8] = [], roomId: String? = nil) {
        self.vertices = vertices
        self.normals = normals
        self.indices = indices
        self.classes = classes
        self.roomId = roomId
    }

    public var triangleCount: Int { indices.count / 3 }

    /// The same mesh after a rigid motion.
    public func transformed(by t: Transform) -> ScanMesh {
        var copy = self
        copy.vertices = vertices.map(t.apply)
        copy.normals = normals.map { vnormalize(t.applyDirection($0)) }
        return copy
    }

    /// Without triangles that use missing or non-finite vertices; normals and classes kept only if complete.
    func sanitized() -> ScanMesh {
        var copy = self
        if normals.count != vertices.count { copy.normals = [] }
        let hasClasses = classes.count == triangleCount
        var kept: [UInt32] = [], keptClasses: [UInt8] = []
        kept.reserveCapacity(indices.count)
        for t in 0..<triangleCount {
            let a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2]
            guard Int(a) < vertices.count, Int(b) < vertices.count, Int(c) < vertices.count,
                isFinite(vertices[Int(a)]), isFinite(vertices[Int(b)]), isFinite(vertices[Int(c)])
            else { continue }
            kept += [a, b, c]
            if hasClasses { keptClasses.append(classes[t]) }
        }
        copy.indices = kept
        copy.classes = hasClasses ? keptClasses : []
        return copy
    }

    // MARK: File

    static let magic = Array("ATMESH01".utf8)

    /// The mesh file: "ATMESH01", then little-endian UInt32 vertex count, triangle count and flags
    /// (1: normals, 2: classes), Float32 x, y, z per vertex, the same per normal, three UInt32
    /// per triangle, one UInt8 per triangle.
    public func encoded() -> Data {
        let hasNormals = normals.count == vertices.count && !vertices.isEmpty
        let hasClasses = classes.count == triangleCount && triangleCount > 0
        var words: [UInt32] = [UInt32(vertices.count), UInt32(triangleCount), (hasNormals ? 1 : 0) | (hasClasses ? 2 : 0)]
        words.reserveCapacity(3 + vertices.count * (hasNormals ? 6 : 3) + indices.count)
        for v in vertices { words += [v.x.bitPattern, v.y.bitPattern, v.z.bitPattern] }
        if hasNormals { for n in normals { words += [n.x.bitPattern, n.y.bitPattern, n.z.bitPattern] } }
        words += indices.prefix(triangleCount * 3)
        var data = Data(Self.magic)
        words.withUnsafeBufferPointer { buffer in
            let little = buffer.map(\.littleEndian)
            little.withUnsafeBytes { data.append(contentsOf: $0) }
        }
        if hasClasses { data.append(contentsOf: classes) }
        return data
    }

    public struct FileError: Error, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    public init(decoding data: Data, roomId: String? = nil) throws {
        let bytes = [UInt8](data)
        guard bytes.count >= 20, Array(bytes[0..<8]) == Self.magic else { throw FileError(message: "Not an Atrium mesh file") }
        func word(_ k: Int) -> UInt32 {
            let i = 8 + k * 4
            return UInt32(bytes[i]) | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2]) << 16 | UInt32(bytes[i + 3]) << 24
        }
        let nv = Int(word(0)), nt = Int(word(1)), flags = word(2)
        let hasNormals = flags & 1 != 0, hasClasses = flags & 2 != 0
        let wordCount = 3 + nv * 3 * (hasNormals ? 2 : 1) + nt * 3
        guard nv < 50_000_000, nt < 50_000_000, bytes.count == 8 + wordCount * 4 + (hasClasses ? nt : 0) else {
            throw FileError(message: "Mesh file is truncated or damaged")
        }
        var k = 3
        func vectors(_ n: Int) -> [Vec3] {
            var out = [Vec3](repeating: .zero, count: n)
            for i in 0..<n {
                out[i] = Vec3(Float(bitPattern: word(k)), Float(bitPattern: word(k + 1)), Float(bitPattern: word(k + 2)))
                k += 3
            }
            return out
        }
        let vertices = vectors(nv)
        let normals = hasNormals ? vectors(nv) : []
        var indices = [UInt32](repeating: 0, count: nt * 3)
        for i in indices.indices {
            indices[i] = word(k)
            k += 1
        }
        let classes = hasClasses ? Array(bytes[(8 + wordCount * 4)...]) : []
        self.init(vertices: vertices, normals: normals, indices: indices, classes: classes, roomId: roomId)
    }
}
