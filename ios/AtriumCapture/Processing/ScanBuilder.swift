import AtriumScanCore
import Foundation
import RoomPlan
import UIKit

/// Turns finished room captures into a saved scan: RoomPlan's final room
/// models, a merged structure (USDZ preview), the CaptureScan, and the
/// walkthrough model + manifest from ScanCore.
enum ScanBuilder {
    enum Step: Int, CaseIterable {
        case combining, modeling, packaging

        var title: String {
            switch self {
            case .combining: return "Combining rooms"
            case .modeling: return "Building the 3D walkthrough"
            case .packaging: return "Saving the scan"
            }
        }
    }

    enum Failure: LocalizedError {
        case noRooms
        var errorDescription: String? { "RoomPlan couldn't finish any of the rooms. Try scanning again, moving slowly along the walls." }
    }

    struct Input: Sendable {
        var scanId: UUID
        var directory: URL
        var rooms: [(name: String, data: CapturedRoomData)]
        var trajectory: [PoseSample]
        var startedAt: Date
        var device: DeviceInfo
    }

    static func build(_ input: Input, progress: @escaping @MainActor (Step) -> Void) async throws -> ScanRecord {
        let fm = FileManager.default
        let dir = input.directory
        let raw = dir.appendingPathComponent("roomplan", isDirectory: true)
        try fm.createDirectory(at: raw, withIntermediateDirectories: true)
        let encoder = JSONEncoder()

        await progress(.combining)
        let roomBuilder = RoomBuilder(options: [.beautifyObjects])
        var rooms: [NamedRoom] = []
        for (index, capture) in input.rooms.enumerated() {
            try? encoder.encode(capture.data).write(to: raw.appendingPathComponent("room-\(index + 1)-data.json"))
            guard let room = try? await roomBuilder.capturedRoom(from: capture.data) else { continue }
            rooms.append(NamedRoom(name: capture.name, room: room))
            try? encoder.encode(room).write(to: raw.appendingPathComponent("room-\(index + 1).json"))
        }
        guard !rooms.isEmpty else { throw Failure.noRooms }

        // RoomPlan's merged structure: kept as raw data and exported for the AR preview.
        let usdz = raw.appendingPathComponent("structure.usdz")
        if let structure = try? await StructureBuilder(options: [.beautifyObjects]).capturedStructure(from: rooms.map(\.room)) {
            try? encoder.encode(structure).write(to: raw.appendingPathComponent("structure.json"))
            try? structure.export(to: usdz)
        } else if rooms.count == 1 {
            try? rooms[0].room.export(to: usdz)
        }

        await progress(.modeling)
        let scan = RoomPlanAdapter.makeScan(rooms: rooms, trajectory: input.trajectory, device: input.device, capturedAt: input.startedAt)
        let processed = try await Task.detached(priority: .userInitiated) { try ScanProcessor.process(scan) }.value

        await progress(.packaging)
        try scan.jsonData(prettyPrinted: false).write(to: dir.appendingPathComponent("scan.json"))
        try processed.glb.write(to: dir.appendingPathComponent("scan.glb"))
        try processed.manifest.jsonData(prettyPrinted: true).write(to: dir.appendingPathComponent("manifest.json"))
        let info: [String: Any] = [
            "app": input.device.app ?? "",
            "device": input.device.model ?? "",
            "system": input.device.system ?? "",
            "startedAt": ISO8601DateFormatter().string(from: input.startedAt),
            "durationSeconds": Int(Date().timeIntervalSince(input.startedAt)),
            "rooms": rooms.map(\.name),
            "roomsDropped": input.rooms.count - rooms.count,
            "trajectorySamples": input.trajectory.count,
        ]
        try JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys]).write(to: dir.appendingPathComponent("info.json"))

        return ScanRecord(id: input.scanId, createdAt: input.startedAt, roomNames: rooms.map(\.name), stats: processed.stats, delivery: nil)
    }

    /// The synthetic two-bedroom apartment, processed like a real scan — lets
    /// you try pairing and uploading on any iPhone, LiDAR or not.
    static func buildDemo(scanId: UUID, directory: URL) async throws -> ScanRecord {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let scan = SyntheticApartment.make()
        let processed = try await Task.detached(priority: .userInitiated) { try ScanProcessor.process(scan) }.value
        try scan.jsonData().write(to: directory.appendingPathComponent("scan.json"))
        try processed.glb.write(to: directory.appendingPathComponent("scan.glb"))
        try processed.manifest.jsonData(prettyPrinted: true).write(to: directory.appendingPathComponent("manifest.json"))
        return ScanRecord(
            id: scanId, createdAt: Date(), roomNames: processed.manifest.rooms.map(\.name), stats: processed.stats, delivery: nil, isDemo: true)
    }

    @MainActor
    static func deviceInfo() -> DeviceInfo {
        var system = utsname()
        uname(&system)
        let model = withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return DeviceInfo(model: model, system: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)", app: "\(version) (\(build))")
    }
}
