import AtriumScanCore
import Foundation
import RoomPlan
import UIKit

/// Turns finished room captures into a saved scan: RoomPlan's final room
/// models, a merged structure (USDZ preview and room placement), the rooms put
/// into one frame, and the walkthrough model + manifest from ScanCore.
///
/// Everything raw is kept (roomplan/, frames/, roomplan/capture.json), so a
/// scan can be rebuilt with a newer pipeline without scanning again.
enum ScanBuilder {
    /// Bumped whenever rebuilding gives a meaningfully better walkthrough.
    /// 1–2: rooms taken as RoomPlan reported them. 3: rooms aligned into one frame.
    /// 4: the scan's photos painted onto the model. 5: one sharp photo per patch, furniture in parts.
    static let pipelineVersion = 5

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
        case nothingToRebuild
        var errorDescription: String? {
            switch self {
            case .noRooms: return "RoomPlan couldn't finish any of the rooms. Try scanning again, moving slowly along the walls."
            case .nothingToRebuild: return "This scan has no saved RoomPlan data to rebuild from."
            }
        }
    }

    struct Input: Sendable {
        var scanId: UUID
        var directory: URL
        var rooms: [(name: String, data: CapturedRoomData, segment: Int)]
        var path: [PoseSample]
        var frames: [CameraFrame]
        var startedAt: Date
        var device: DeviceInfo
    }

    /// roomplan/capture.json: what a rebuild needs besides RoomPlan's own files.
    struct CaptureRecord: Codable {
        struct Room: Codable {
            var name: String
            /// roomplan/room-N.json
            var file: String
            /// The RoomPlan run that scanned it; nil for scans from builds before 3.
            var segment: Int?
        }

        var startedAt: Date
        var device: DeviceInfo?
        var rooms: [Room]
        /// The path as recorded: each sample in its run's frame.
        var path: [PoseSample]
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
        var entries: [CaptureRecord.Room] = []
        for (index, capture) in input.rooms.enumerated() {
            try? encoder.encode(capture.data).write(to: raw.appendingPathComponent("room-\(index + 1)-data.json"))
            guard let room = try? await roomBuilder.capturedRoom(from: capture.data) else { continue }
            let file = "room-\(index + 1).json"
            try? encoder.encode(room).write(to: raw.appendingPathComponent(file))
            rooms.append(NamedRoom(name: capture.name, room: room, segment: capture.segment))
            entries.append(CaptureRecord.Room(name: capture.name, file: file, segment: capture.segment))
        }
        guard !rooms.isEmpty else { throw Failure.noRooms }
        let record = CaptureRecord(startedAt: input.startedAt, device: input.device, rooms: entries, path: input.path)
        try save(record, in: dir)

        let merged = await mergedStructure(rooms.map(\.room), into: raw)
        return try await assemble(
            scanId: input.scanId, directory: dir, rooms: rooms, structure: merged.structure, structureNote: merged.note, path: input.path,
            frames: input.frames, startedAt: input.startedAt, device: input.device, roomsDropped: input.rooms.count - rooms.count, progress: progress)
    }

    /// Re-processes a saved scan with the current pipeline: same rooms and path, no rescanning.
    static func rebuild(_ record: ScanRecord, directory dir: URL, progress: @escaping @MainActor (Step) -> Void) async throws -> ScanRecord {
        await progress(.combining)
        let raw = dir.appendingPathComponent("roomplan", isDirectory: true)
        let decoder = JSONDecoder()
        let capture = try loadCaptureRecord(in: dir, record: record)
        var rooms: [NamedRoom] = []
        for entry in capture.rooms {
            guard let data = try? Data(contentsOf: raw.appendingPathComponent(entry.file)),
                  let room = try? decoder.decode(CapturedRoom.self, from: data)
            else { continue }
            rooms.append(NamedRoom(name: entry.name, room: room, segment: entry.segment))
        }
        guard !rooms.isEmpty else { throw Failure.nothingToRebuild }

        var structure: CapturedStructure?
        var note = "none saved"
        if let data = try? Data(contentsOf: raw.appendingPathComponent("structure.json")) {
            do {
                structure = try decoder.decode(CapturedStructure.self, from: data)
                note = "saved"
            } catch {
                note = "saved, unreadable: \(error.localizedDescription)"
            }
        }
        if structure == nil {
            let merged = await mergedStructure(rooms.map(\.room), into: raw)
            structure = merged.structure
            note = merged.structure != nil ? "built" : "\(note); \(merged.note)"
        }

        let framesURL = dir.appendingPathComponent("frames/frames.json")
        let frames = (try? Data(contentsOf: framesURL)).flatMap { try? decoder.decode([CameraFrame].self, from: $0) } ?? []
        var rebuilt = try await assemble(
            scanId: record.id, directory: dir, rooms: rooms, structure: structure, structureNote: note, path: capture.path, frames: frames,
            startedAt: capture.startedAt, device: capture.device ?? DeviceInfo(), roomsDropped: capture.rooms.count - rooms.count, progress: progress)
        rebuilt.createdAt = record.createdAt
        rebuilt.roomNames = rooms.map(\.name)
        return rebuilt
    }

    /// Whether a saved scan has what `rebuild` needs.
    static func canRebuild(_ record: ScanRecord, directory dir: URL) -> Bool {
        guard !record.isDemo else { return false }
        let raw = dir.appendingPathComponent("roomplan", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: raw.path)) ?? []
        return files.contains { roomNumber(of: $0) != nil }
    }

    // MARK: Steps

    /// RoomPlan's merge of the rooms, saved as raw data and as the AR preview,
    /// with a note on how it went (for info.json).
    private static func mergedStructure(_ rooms: [CapturedRoom], into raw: URL) async -> (structure: CapturedStructure?, note: String) {
        let usdz = raw.appendingPathComponent("structure.usdz")
        do {
            let structure = try await StructureBuilder(options: [.beautifyObjects]).capturedStructure(from: rooms)
            try? JSONEncoder().encode(structure).write(to: raw.appendingPathComponent("structure.json"))
            try? structure.export(to: usdz)
            return (structure, "built")
        } catch {
            if rooms.count == 1 { try? rooms[0].export(to: usdz) }
            return (nil, "merge failed: \(error.localizedDescription)")
        }
    }

    /// Rooms into one frame, then the walkthrough model, manifest and info files.
    private static func assemble(
        scanId: UUID, directory dir: URL, rooms: [NamedRoom], structure: CapturedStructure?, structureNote: String, path: [PoseSample],
        frames: [CameraFrame], startedAt: Date, device: DeviceInfo, roomsDropped: Int, progress: @escaping @MainActor (Step) -> Void
    ) async throws -> ScanRecord {
        await progress(.modeling)
        let parts = rooms.enumerated().compactMap { index, entry in
            RoomPlanAdapter.part(from: entry.room, name: entry.name, index: index, segment: entry.segment)
        }
        guard !parts.isEmpty else { throw Failure.noRooms }
        let poses = structure.map(RoomPlanAdapter.structurePoses)
        let capturedAt = ISO8601DateFormatter().string(from: startedAt)
        let photos = ScanPhotos(directory: dir)
        let (aligned, processed) = try await Task.detached(priority: .userInitiated) {
            let aligned = RoomAlignment.align(parts: parts, structure: poses, path: path, frames: frames, capturedAt: capturedAt, device: device)
            // The photos are painted onto the model; with too few of them it falls back to the styled model.
            return (aligned, try ScanProcessor.process(aligned.scan, photos: photos, encodeImage: ScanPhotos.encodeJPEG))
        }.value

        await progress(.packaging)
        try aligned.scan.jsonData(prettyPrinted: false).write(to: dir.appendingPathComponent("scan.json"))
        try processed.glb.write(to: dir.appendingPathComponent("scan.glb"))
        try processed.manifest.jsonData(prettyPrinted: true).write(to: dir.appendingPathComponent("manifest.json"))
        let reportEncoder = JSONEncoder()
        reportEncoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try reportEncoder.encode(aligned.report).write(to: dir.appendingPathComponent("alignment.json"))
        let info: [String: Any] = [
            "app": device.app ?? "",
            "device": device.model ?? "",
            "system": device.system ?? "",
            "builtBy": ScanBuilder.deviceAppVersion(),
            "pipeline": pipelineVersion,
            "startedAt": capturedAt,
            "rooms": rooms.map(\.name),
            "roomsDropped": roomsDropped,
            "trajectorySamples": path.count,
            "alignment": aligned.report.summary,
            "structure": structureNote,
            "photos": frames.count,
            "photoCoverage": processed.stats.photoCoverage ?? 0,
        ]
        try JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys]).write(to: dir.appendingPathComponent("info.json"))
        // The package zips these files; an old one would be stale.
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("package.zip"))

        return ScanRecord(
            id: scanId, createdAt: startedAt, roomNames: rooms.map(\.name), stats: processed.stats, delivery: nil, pipeline: pipelineVersion,
            alignment: aligned.report.summary)
    }

    // MARK: Saved capture data

    private static func save(_ record: CaptureRecord, in dir: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(record).write(to: dir.appendingPathComponent("roomplan/capture.json"))
    }

    /// capture.json, or for scans from builds 1–2 the same facts from their files: room
    /// names from the record, the raw path from scan.json (those builds didn't change it).
    /// The result is saved, so later rebuilds don't depend on scan.json.
    private static func loadCaptureRecord(in dir: URL, record: ScanRecord) throws -> CaptureRecord {
        let url = dir.appendingPathComponent("roomplan/capture.json")
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: url), let saved = try? decoder.decode(CaptureRecord.self, from: data) { return saved }

        let raw = dir.appendingPathComponent("roomplan", isDirectory: true)
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: raw.path)) ?? [])
            .compactMap { name in roomNumber(of: name).map { (name, $0) } }
            .sorted { $0.1 < $1.1 }
        guard !files.isEmpty else { throw Failure.nothingToRebuild }
        let names = files.count == record.roomNames.count ? record.roomNames : files.map { "Room \($0.1)" }
        let old = (try? Data(contentsOf: dir.appendingPathComponent("scan.json"))).flatMap { try? CaptureScan.decode(from: $0) }
        let capture = CaptureRecord(
            startedAt: record.createdAt, device: old?.device,
            rooms: zip(files, names).map { CaptureRecord.Room(name: $1, file: $0.0, segment: nil) }, path: old?.trajectory ?? [])
        try save(capture, in: dir)
        return capture
    }

    /// N for "room-N.json" (not the raw "room-N-data.json").
    static func roomNumber(of file: String) -> Int? {
        guard file.hasPrefix("room-"), file.hasSuffix(".json"), !file.hasSuffix("-data.json") else { return nil }
        return Int(file.dropFirst(5).dropLast(5))
    }

    // MARK: Demo

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
            id: scanId, createdAt: Date(), roomNames: processed.manifest.rooms.map(\.name), stats: processed.stats, delivery: nil, isDemo: true,
            pipeline: pipelineVersion)
    }

    @MainActor
    static func deviceInfo() -> DeviceInfo {
        var system = utsname()
        uname(&system)
        let model = withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return DeviceInfo(model: model, system: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)", app: deviceAppVersion())
    }

    /// "1.0 (3)"
    static func deviceAppVersion() -> String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
