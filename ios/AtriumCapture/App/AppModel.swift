import AtriumScanCore
import Foundation
import RoomPlan
import SwiftUI

/// Paired listing: where scans go (docs/iphone-capture.md §4.2).
struct Pairing: Codable, Equatable {
    var server: URL
    var token: String
    var propertyId: String
    var propertyLabel: String
    var expiresAt: Date

    var isExpired: Bool { expiresAt <= Date() }
    var host: String { server.host.map { h in server.port.map { "\(h):\($0)" } ?? h } ?? server.absoluteString }
}

enum UploadState: Equatable {
    case preparing
    case uploading(Double)
    case finishing
    case done(AtriumAPI.Completion)
    case failed(String)

    var isBusy: Bool {
        switch self {
        case .preparing, .uploading, .finishing: return true
        default: return false
        }
    }
}

struct Banner: Identifiable, Equatable {
    let id = UUID()
    var message: String
    var isError: Bool
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var pairing: Pairing?
    @Published private(set) var isPairing = false
    @Published private(set) var scans: [ScanRecord] = []
    @Published private(set) var uploads: [UUID: UploadState] = [:]
    @Published var banner: Banner?

    /// The scan in progress (capture screen) and the one being built afterwards.
    @Published var capture: CaptureModel?
    @Published private(set) var building: (id: UUID, step: ScanBuilder.Step)?
    /// Scan to open when it finishes building.
    @Published var openScan: UUID?

    let store = ScanStore()
    private static let pairingKey = "atrium.pairing"

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.pairingKey), let saved = try? JSONDecoder().decode(Pairing.self, from: data) {
            pairing = saved
        }
        reloadScans()
    }

    var canScan: Bool { RoomCaptureSession.isSupported }

    func reloadScans() { scans = store.loadAll() }

    // MARK: Pairing

    func handleOpenURL(_ url: URL) {
        guard let link = PairingLink(url: url) else {
            banner = Banner(message: "That link isn't an Atrium pairing link.", isError: true)
            return
        }
        Task { await pair(with: link) }
    }

    /// Text from the QR scanner or the clipboard.
    func pair(withText text: String) {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), let link = PairingLink(url: url) else {
            banner = Banner(message: "That code isn't an Atrium pairing code. Open a listing in the dashboard and choose Connect an iPhone.", isError: true)
            return
        }
        Task { await pair(with: link) }
    }

    func pair(with link: PairingLink) async {
        isPairing = true
        defer { isPairing = false }
        do {
            let info = try await AtriumAPI(server: link.server, token: link.token).session()
            let p = info.property
            let label = [p.addressLine, p.city].filter { !$0.isEmpty }.joined(separator: ", ")
            let paired = Pairing(
                server: link.server, token: link.token, propertyId: p.id, propertyLabel: label.isEmpty ? "your listing" : label,
                expiresAt: ISO8601DateFormatter.parseFlexible(info.expiresAt) ?? Date().addingTimeInterval(3600))
            pairing = paired
            UserDefaults.standard.set(try? JSONEncoder().encode(paired), forKey: Self.pairingKey)
            banner = Banner(message: "Connected — scans will go to \(paired.propertyLabel).", isError: false)
        } catch {
            banner = Banner(message: error.localizedDescription, isError: true)
        }
    }

    func unpair() {
        pairing = nil
        UserDefaults.standard.removeObject(forKey: Self.pairingKey)
    }

    // MARK: Scanning

    func startScan() {
        let id = UUID()
        let directory = store.directory(for: id)
        let model = CaptureModel(directory: directory)
        model.onCancel = { [weak self] in
            self?.capture = nil
            try? FileManager.default.removeItem(at: directory)
        }
        model.onFinish = { [weak self] finished in
            self?.capture = nil
            self?.buildScan(from: finished)
        }
        capture = model
    }

    private func buildScan(from capture: CaptureModel) {
        let input = ScanBuilder.Input(
            scanId: capture.scanId, directory: capture.directory, rooms: capture.rooms.map { (name: $0.name, data: $0.data) },
            trajectory: capture.recorder.samples, startedAt: capture.startedAt, device: ScanBuilder.deviceInfo())
        try? capture.recorder.writeIndex()
        building = (capture.scanId, .combining)
        Task {
            do {
                let record = try await ScanBuilder.build(input) { [weak self] step in self?.building = (input.scanId, step) }
                try store.save(record)
                reloadScans()
                building = nil
                openScan = record.id
            } catch {
                building = nil
                banner = Banner(message: error.localizedDescription, isError: true)
                reloadScans()
            }
        }
    }

    func createDemoScan() {
        let id = UUID()
        building = (id, .modeling)
        Task {
            do {
                let record = try await ScanBuilder.buildDemo(scanId: id, directory: store.directory(for: id))
                try store.save(record)
                reloadScans()
                building = nil
                openScan = id
            } catch {
                building = nil
                banner = Banner(message: error.localizedDescription, isError: true)
            }
        }
    }

    func delete(_ record: ScanRecord) {
        try? store.delete(record.id)
        uploads[record.id] = nil
        reloadScans()
    }

    // MARK: Sending to Atrium

    func send(_ record: ScanRecord) {
        guard let pairing else { return }
        guard !pairing.isExpired else {
            banner = Banner(message: "The pairing code has expired. Scan a new code from the listing in the Atrium dashboard.", isError: true)
            return
        }
        guard uploads[record.id]?.isBusy != true else { return }
        uploads[record.id] = .preparing
        let api = AtriumAPI(server: pairing.server, token: pairing.token)
        let store = self.store
        let id = record.id
        Task {
            do {
                _ = try await api.session()  // still valid?
                let model = store.modelURL(for: id)
                let manifest = try Data(contentsOf: store.manifestURL(for: id))
                // The raw package is optional for the walkthrough; demo scans have none.
                var package: URL?
                if !record.isDemo {
                    package = try await Task.detached(priority: .userInitiated) { try store.ensurePackage(for: id) }.value
                }

                let modelTarget = try await api.uploadTarget(kind: "capture", filename: "scan.glb", size: store.fileSize(model))
                let modelShare = package == nil ? 0.9 : 0.35
                try await api.put(model, to: modelTarget) { fraction in
                    Task { @MainActor [weak self] in self?.setProgress(id, modelShare * fraction) }
                }
                var packageUrl: String?
                if let package {
                    do {
                        let target = try await api.uploadTarget(kind: "package", filename: "package.zip", size: store.fileSize(package))
                        try await api.put(package, to: target) { fraction in
                            Task { @MainActor [weak self] in self?.setProgress(id, 0.35 + 0.55 * fraction) }
                        }
                        packageUrl = target.assetUrl
                    } catch {
                        // The walkthrough doesn't need the raw data; send the scan without it.
                        packageUrl = nil
                    }
                }
                uploads[id] = .finishing
                let done = try await api.complete(assetUrl: modelTarget.assetUrl, packageUrl: packageUrl, manifest: manifest)
                uploads[id] = .done(done)
                var updated = record
                updated.delivery = ScanRecord.Delivery(propertyLabel: pairing.propertyLabel, propertyUrl: done.propertyUrl, previewUrl: done.previewUrl, sentAt: Date())
                try? store.save(updated)
                reloadScans()
            } catch {
                uploads[id] = .failed(error.localizedDescription)
            }
        }
    }

    private func setProgress(_ id: UUID, _ value: Double) {
        if case .uploading = uploads[id] { uploads[id] = .uploading(value) } else if uploads[id] == .preparing { uploads[id] = .uploading(value) }
    }
}
