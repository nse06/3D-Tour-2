import ARKit
import AtriumScanCore
import Foundation
import Metal
import simd

/// Saves ARKit's LiDAR scene mesh when each room ends (roomplan/mesh-run-N.bin, in that room's
/// frame), so the walkthrough can show furniture and clutter in their real shapes. The capture
/// screen runs RoomPlan on an AR session that reconstructs the mesh (see CaptureViewController).
@MainActor
final class MeshRecorder {
    /// The scan's roomplan/ folder.
    let directory: URL
    /// Triangles saved per RoomPlan run.
    private(set) var triangles: [Int: Int] = [:]
    /// What the AR session reconstructed when the last room ended: "mesh", "mesh+classes", "off" or "unknown".
    private(set) var mode = "unknown"
    private var writes: [Task<Void, Never>] = []

    /// Turned off in the app's scan card if scanning with the mesh misbehaves.
    nonisolated static let enabledKey = "lidarShapes"
    nonisolated static var isEnabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    init(directory: URL) {
        self.directory = directory
    }

    nonisolated static func fileName(segment: Int) -> String { "mesh-run-\(segment).bin" }

    /// Saves the mesh around the room RoomPlan run `segment` scanned (once per run).
    func snapshot(_ session: ARSession, segment: Int) {
        guard segment >= 0, triangles[segment] == nil else { return }
        if let configuration = session.configuration as? ARWorldTrackingConfiguration {
            let r = configuration.sceneReconstruction
            mode = r == .meshWithClassification ? "mesh+classes" : r == .mesh ? "mesh" : r.isEmpty ? "off" : "other"
        }
        let anchors = session.currentFrame?.anchors.compactMap { $0 as? ARMeshAnchor } ?? []
        triangles[segment] = anchors.reduce(0) { $0 + $1.geometry.faces.count }
        guard !anchors.isEmpty else { return }
        let url = directory.appendingPathComponent(Self.fileName(segment: segment))
        let folder = directory
        writes.append(
            Task.detached(priority: .utility) {
                let mesh = MeshRecorder.mesh(from: anchors)
                try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try? mesh.encoded().write(to: url, options: .atomic)
            })
    }

    /// Waits until every mesh is on disk.
    func finish() async {
        for write in writes { await write.value }
        writes = []
    }

    /// The anchors' triangles in world space, with outward normals and ARKit's classes.
    nonisolated static func mesh(from anchors: [ARMeshAnchor]) -> ScanMesh {
        var vertices: [Vec3] = [], normals: [Vec3] = [], indices: [UInt32] = [], classes: [UInt8] = []
        for anchor in anchors {
            let geometry = anchor.geometry, transform = anchor.transform
            let base = UInt32(vertices.count)
            let source = geometry.vertices, normalSource = geometry.normals
            for i in 0..<source.count {
                let p = source.buffer.contents().advanced(by: source.offset + source.stride * i).assumingMemoryBound(to: (Float, Float, Float).self).pointee
                let w = transform * SIMD4<Float>(p.0, p.1, p.2, 1)
                vertices.append(Vec3(w.x, w.y, w.z))
                if normalSource.count == source.count {
                    let n = normalSource.buffer.contents().advanced(by: normalSource.offset + normalSource.stride * i)
                        .assumingMemoryBound(to: (Float, Float, Float).self).pointee
                    let d = transform * SIMD4<Float>(n.0, n.1, n.2, 0)
                    normals.append(Vec3(d.x, d.y, d.z))
                }
            }
            let faces = geometry.faces
            guard faces.indexCountPerPrimitive == 3 else { continue }
            let pointer = faces.buffer.contents()
            for i in 0..<(faces.count * 3) {
                let index =
                    faces.bytesPerIndex == 2
                    ? UInt32(pointer.advanced(by: i * 2).assumingMemoryBound(to: UInt16.self).pointee)
                    : pointer.advanced(by: i * 4).assumingMemoryBound(to: UInt32.self).pointee
                indices.append(base + index)
            }
            if let source = geometry.classification, source.count == faces.count {
                for i in 0..<faces.count {
                    let raw = source.buffer.contents().advanced(by: source.offset + source.stride * i).assumingMemoryBound(to: UInt8.self).pointee
                    classes.append(surface(ARMeshClassification(rawValue: Int(raw)) ?? .none).rawValue)
                }
            } else {
                classes += [UInt8](repeating: ScanMesh.Surface.none.rawValue, count: faces.count)
            }
        }
        if normals.count != vertices.count { normals = [] }
        return ScanMesh(vertices: vertices, normals: normals, indices: indices, classes: classes)
    }

    nonisolated static func surface(_ c: ARMeshClassification) -> ScanMesh.Surface {
        switch c {
        case .wall: return .wall
        case .floor: return .floor
        case .ceiling: return .ceiling
        case .table: return .table
        case .seat: return .seat
        case .window: return .window
        case .door: return .door
        case .none: return .none
        @unknown default: return .none
        }
    }
}
