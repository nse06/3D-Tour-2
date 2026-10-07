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

    func save(_ record: ScanRecord) throws {
        let folder = directory(for: record.id)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try encoder.encode(record).write(to: folder.appendingPathComponent("record.json"), options: .atomic)
    }

    func delete(_ id: UUID) throws {
        try FileManager.default.removeItem(at: directory(for: id))
    }

    /// The scan package (docs/iphone-capture.md §3.3), zipped on first use.
    func ensurePackage(for id: UUID) throws -> URL {
        let zip = packageURL(for: id)
        if FileManager.default.fileExists(atPath: zip.path) { return zip }
        let folder = directory(for: id)
        let skip: Set<String> = ["package.zip", "record.json", "scan.glb"]
        var files: [(path: String, url: URL)] = []
        if let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) {
            for case let url as URL in walker {
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                let relative = String(url.standardizedFileURL.path.dropFirst(folder.standardizedFileURL.path.count + 1))
                if skip.contains(relative) { continue }
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
