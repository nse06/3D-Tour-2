import Foundation

/// What a cloud GPU trains a photoreal walkthrough on (docs/photoreal.md), as the server names the
/// files: photoreal/cameras.json and seeds.ply from the build, the photos cameras.json lists
/// (frames/…) and their people masks (photoreal/masks/ → masks/…).
struct PhotorealFiles: Sendable {
    struct File: Sendable {
        let name: String
        let url: URL
        let size: Int64
    }

    let files: [File]
    var bytes: Int64 { files.reduce(0) { $0 + $1.size } }
    var photos: Int { files.filter { $0.name.hasPrefix("frames/") }.count }

    enum Problem: LocalizedError {
        case notReady
        case tooFewPhotos(Int)

        var errorDescription: String? {
            switch self {
            case .notReady: return "This scan isn't ready for photoreal yet. Rebuild the walkthrough first."
            case let .tooFewPhotos(count): return "Photoreal needs the photos taken while scanning, and this scan has \(count). Scan the home again with photos on."
            }
        }
    }

    /// The scan's photoreal files. `scan` is the scan's folder, `photoreal` its photoreal/ folder.
    static func collect(scan: URL, photoreal: URL) throws -> PhotorealFiles {
        let fm = FileManager.default
        func size(_ url: URL) -> Int64? {
            guard let value = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber, value.int64Value > 0 else { return nil }
            return value.int64Value
        }
        let cameras = photoreal.appendingPathComponent("cameras.json"), seeds = photoreal.appendingPathComponent("seeds.ply")
        guard let camerasSize = size(cameras), let seedsSize = size(seeds), let data = try? Data(contentsOf: cameras),
              let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let frames = doc["frames"] as? [[String: Any]]
        else { throw Problem.notReady }
        var files = [File(name: "cameras.json", url: cameras, size: camerasSize), File(name: "seeds.ply", url: seeds, size: seedsSize)]
        var listed = Set<String>()
        for frame in frames {
            guard let name = frame["file"] as? String, name.range(of: #"^frames/[A-Za-z0-9_-]+\.(jpg|jpeg|png)$"#, options: .regularExpression) != nil,
                  listed.insert(name).inserted, let photoSize = size(scan.appendingPathComponent(name))
            else { continue }
            files.append(File(name: name, url: scan.appendingPathComponent(name), size: photoSize))
            let mask = "masks/" + ((name as NSString).lastPathComponent as NSString).deletingPathExtension + ".png"
            if let maskSize = size(photoreal.appendingPathComponent(mask)) {
                files.append(File(name: mask, url: photoreal.appendingPathComponent(mask), size: maskSize))
            }
        }
        let collected = PhotorealFiles(files: files)
        guard collected.photos >= 10 else { throw Problem.tooFewPhotos(collected.photos) }
        return collected
    }
}
