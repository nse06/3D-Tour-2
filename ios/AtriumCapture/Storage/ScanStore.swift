import AtriumScanCore
import Foundation

/// What the app remembers about a saved scan (record.json in its folder).
struct ScanRecord: Codable, Identifiable, Equatable {
    struct Delivery: Codable, Equatable {
        var propertyLabel: String
        var propertyUrl: String
        var previewUrl: String
        var sentAt: Date
    }

    var id: UUID
    var createdAt: Date
    var roomNames: [String]
    var stats: ScanStats
    /// Set once the scan was sent to an Atrium listing.
    var delivery: Delivery?
    var isDemo: Bool = false
    /// ScanBuilder.pipelineVersion that built the walkthrough (nil: builds 1–2).
    var pipeline: Int?
    /// How the rooms were put together ("4 rooms placed with RoomPlan's merged layout").
    var alignment: String?

    var title: String {
        if isDemo { return "Demo apartment" }
        let names = roomNames.prefix(3).joined(separator: ", ")
        return roomNames.count > 3 ? "\(names) +\(roomNames.count - 3)" : (names.isEmpty ? "Scan" : names)
    }
}

/// Scans live in Documents/Scans/<id>/ (visible in the Files app):
/// scan.json, scan.glb, manifest.json, roomplan/…, frames/…, info.json, record.json.
final class ScanStore: @unchecked Sendable {
    let root: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("Scans", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func directory(for id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }
    func modelURL(for id: UUID) -> URL { directory(for: id).appendingPathComponent("scan.glb") }
    /// The clean model for the viewer's "photos off" view (photo-textured scans built by pipeline 6 on).
    static let cleanModelFile = "scan-clean.glb"
    func cleanModelURL(for id: UUID) -> URL { directory(for: id).appendingPathComponent(Self.cleanModelFile) }
    func manifestURL(for id: UUID) -> URL { directory(for: id).appendingPathComponent("manifest.json") }
    func packageURL(for id: UUID) -> URL { directory(for: id).appendingPathComponent("package.zip") }
    func previewURL(for id: UUID) -> URL { directory(for: id).appendingPathComponent("roomplan/structure.usdz") }

    func loadAll() -> [ScanRecord] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return folders
            .compactMap { folder in
                guard let data = try? Data(contentsOf: folder.appendingPathComponent("record.json")) else { return nil }
                return try? decoder.decode(ScanRecord.self, from: data)
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// Version 1.0 (1) saved a real scan's files under one id and its record.json
    /// under another, so the scan couldn't be sent. Move each such record into
    /// the folder with its files (matched by start time; info.json has it).
    func repairSplitScans() {
        let fm = FileManager.default
        let folders = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        func has(_ folder: URL, _ file: String) -> Bool { fm.fileExists(atPath: folder.appendingPathComponent(file).path) }
        var orphans = folders.filter { has($0, "scan.glb") && !has($0, "record.json") && UUID(uuidString: $0.lastPathComponent) != nil }
        let lonely: [(URL, ScanRecord)] = folders.compactMap { folder in
            guard has(folder, "record.json"), !has(folder, "scan.glb"),
                  let data = try? Data(contentsOf: folder.appendingPathComponent("record.json")),
                  let record = try? decoder.decode(ScanRecord.self, from: data)
            else { return nil }
            return (folder, record)
        }
        for (folder, record) in lonely {
            let started = { (orphan: URL) -> Date? in
                guard let data = try? Data(contentsOf: orphan.appendingPathComponent("info.json")),
                      let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let text = info["startedAt"] as? String
                else { return nil }
                return ISO8601DateFormatter().date(from: text)
            }
            let match =
                orphans.first { started($0).map { abs($0.timeIntervalSince(record.createdAt)) < 2 } ?? false }
                ?? (orphans.count == 1 && lonely.count == 1 ? orphans.first : nil)
            guard let match, let id = UUID(uuidString: match.lastPathComponent) else { continue }
            var fixed = record
            fixed.id = id
            guard (try? save(fixed)) != nil else { continue }
            try? fm.removeItem(at: folder)
            orphans.removeAll { $0 == match }
        }
    }

    func save(_ record: ScanRecord) throws {
        let folder = directory(for: record.id)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try encoder.encode(record).write(to: folder.appendingPathComponent("record.json"), options: .atomic)
    }

    func delete(_ id: UUID) throws {
        try FileManager.default.removeItem(at: directory(for: id))
    }

    /// The scan package (docs/iphone-capture.md §3.3), zipped on first use. The photos and LiDAR
    /// meshes stay on the phone (hundreds of MB; the walkthrough already carries them).
    func ensurePackage(for id: UUID) throws -> URL {
        let zip = packageURL(for: id)
        if FileManager.default.fileExists(atPath: zip.path) { return zip }
        let folder = directory(for: id)
        let skip: Set<String> = ["package.zip", "package.zip.partial", "record.json", "scan.glb", Self.cleanModelFile]
        var files: [(path: String, url: URL)] = []
        if let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) {
            for case let url as URL in walker {
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                let relative = String(url.standardizedFileURL.path.dropFirst(folder.standardizedFileURL.path.count + 1))
                if skip.contains(relative) || (relative.hasPrefix("frames/") && relative.hasSuffix(".jpg"))
                    || (relative.hasPrefix("roomplan/mesh-") && relative.hasSuffix(".bin"))
                {
                    continue
                }
                files.append((relative, url))
            }
        }
        files.sort { $0.path < $1.path }
        let partial = folder.appendingPathComponent("package.zip.partial")
        try ZipWriter.write(files: files, to: partial)
        try? FileManager.default.removeItem(at: zip)
        try FileManager.default.moveItem(at: partial, to: zip)
        return zip
    }

    func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
    }
}
