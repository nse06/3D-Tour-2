import AtriumScanCore
import Foundation
import RoomPlan
import SwiftUI
import UIKit

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

/// Uploading a scan's photos for a photoreal walkthrough (docs/photoreal.md).
enum PhotorealUploadState: Equatable {
    case preparing
    case uploading(Double)
    case finishing
    case failed(String)

    var isBusy: Bool {
        if case .failed = self { return false }
        return true
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
    @Published private(set) var photorealUploads: [UUID: PhotorealUploadState] = [:]
    /// Each scan's photoreal job as the server last described it.
    @Published private(set) var photorealJobs: [UUID: AtriumAPI.PhotorealJob] = [:]
    @Published var banner: Banner?

    /// The scan in progress (capture screen) and the one being built afterwards.
    @Published var capture: CaptureModel?
    @Published private(set) var building: (id: UUID, step: ScanBuilder.Step)?
    /// Scan to open when it finishes building.
    @Published var openScan: UUID?

    let store = ScanStore()
    private static let pairingKey = "atrium.pairing"
    /// Uploads under way: the screen stays on until they finish (auto-lock would suspend the app).
    private var transfers = 0 {
        didSet { UIApplication.shared.isIdleTimerDisabled = transfers > 0 }
    }

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.pairingKey), let saved = try? JSONDecoder().decode(Pairing.self, from: data) {
            pairing = saved
        }
        store.repairSplitScans()
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
        let model = CaptureModel(scanId: id, directory: directory)
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
            scanId: capture.scanId, directory: capture.directory, rooms: capture.rooms.map { (name: $0.name, data: $0.data, segment: $0.segment) },
            path: capture.recorder.samples, frames: capture.recorder.keyframes, startedAt: capture.startedAt, device: ScanBuilder.deviceInfo(),
            meshMode: capture.meshes.mode)
        try? capture.recorder.writeIndex()
        building = (capture.scanId, .combining)
        Task {
            do {
                // The last room's mesh may still be on its way to disk.
                await capture.meshes.finish()
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

    /// Builds the walkthrough again from the scan's saved RoomPlan data with the current
    /// pipeline (e.g. after an update that places rooms better). Needs sending again.
    func rebuild(_ record: ScanRecord) {
        Task { await performRebuild(record) }
    }

    func performRebuild(_ record: ScanRecord) async {
        guard building == nil, !isSending(record.id) else { return }
        building = (record.id, .combining)
        do {
            var rebuilt = try await ScanBuilder.rebuild(record, directory: store.directory(for: record.id)) { [weak self] step in
                self?.building = (record.id, step)
            }
            rebuilt.isDemo = record.isDemo
            try store.save(rebuilt)
            uploads[record.id] = nil
            reloadScans()
            building = nil
            banner = Banner(message: "Rebuilt. Send it to Atrium again to update the walkthrough.", isError: false)
        } catch {
            building = nil
            banner = Banner(message: error.localizedDescription, isError: true)
        }
    }

    func createDemoScan() {
        Task { await makeDemoScan() }
    }

    @discardableResult
    func makeDemoScan() async -> ScanRecord? {
        let id = UUID()
        building = (id, .modeling)
        do {
            let record = try await ScanBuilder.buildDemo(scanId: id, directory: store.directory(for: id))
            try store.save(record)
            reloadScans()
            building = nil
            openScan = id
            return record
        } catch {
            building = nil
            banner = Banner(message: error.localizedDescription, isError: true)
            return nil
        }
    }

    func delete(_ record: ScanRecord) {
        try? store.delete(record.id)
        uploads[record.id] = nil
        photorealUploads[record.id] = nil
        photorealJobs[record.id] = nil
        reloadScans()
    }

    // MARK: Sending to Atrium

    func send(_ record: ScanRecord) {
        Task { await performSend(record) }
    }

    func performSend(_ record: ScanRecord) async {
        guard let pairing else { return }
        guard !pairing.isExpired else {
            banner = Banner(message: "The pairing code has expired. Scan a new code from the listing in the Atrium dashboard.", isError: true)
            return
        }
        guard !isSending(record.id) else { return }
        uploads[record.id] = .preparing
        transfers += 1
        defer { transfers -= 1 }
        let api = AtriumAPI(server: pairing.server, token: pairing.token)
        let store = self.store
        let id = record.id
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
            // The clean model behind the viewer's "photos off" switch (small; photo-textured scans only).
            var cleanUrl: String?
            let clean = store.cleanModelURL(for: id)
            if FileManager.default.fileExists(atPath: clean.path) {
                let target = try await api.uploadTarget(kind: "capture", filename: ScanStore.cleanModelFile, size: store.fileSize(clean))
                try await api.put(clean, to: target) { _ in }
                cleanUrl = target.assetUrl
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
            let done = try await api.complete(assetUrl: modelTarget.assetUrl, cleanAssetUrl: cleanUrl, packageUrl: packageUrl, manifest: manifest)
            uploads[id] = .done(done)
            var updated = record
            updated.delivery = ScanRecord.Delivery(
                propertyLabel: pairing.propertyLabel, propertyUrl: done.propertyUrl, previewUrl: done.previewUrl, sentAt: Date(), assetUrl: modelTarget.assetUrl)
            // The listing has a new model now; a photoreal walkthrough of the old one is gone with it.
            updated.photoreal = nil
            photorealJobs[id] = nil
            try? store.save(updated)
            reloadScans()
        } catch {
            uploads[id] = .failed(error.localizedDescription)
        }
    }

    /// Whether the scan's files are on their way to Atrium (the scan itself, or its photos for photoreal).
    func isSending(_ id: UUID) -> Bool {
        uploads[id]?.isBusy == true || photorealUploads[id]?.isBusy == true
    }

    // MARK: Photoreal (docs/photoreal.md)

    /// The photos and files a photoreal upload of the scan would send, for the detail screen.
    func photorealSize(_ record: ScanRecord) async -> (photos: Int, bytes: Int64)? {
        let store = self.store, id = record.id
        let files = try? await Task.detached(priority: .utility) {
            try PhotorealFiles.collect(scan: store.directory(for: id), photoreal: store.photorealURL(for: id))
        }.value
        return files.map { ($0.photos, $0.bytes) }
    }

    func makePhotoreal(_ record: ScanRecord) {
        Task { await performPhotoreal(record) }
    }

    /// Uploads the scan's photos and training data to the listing it was sent to, then asks
    /// Atrium to hand them to the cloud GPU.
    func performPhotoreal(_ record: ScanRecord) async {
        guard let pairing else { return }
        guard !pairing.isExpired else {
            banner = Banner(message: "The pairing code has expired. Scan a new code from the listing in the Atrium dashboard.", isError: true)
            return
        }
        let id = record.id
        guard building == nil, !isSending(id) else { return }
        // The splats go on the listing's current model, so they must come from the same scan.
        guard let delivery = record.delivery, delivery.propertyUrl.contains(pairing.propertyId) else {
            photorealUploads[id] = .failed("Send this scan to \(pairing.propertyLabel) first, then make it photoreal.")
            return
        }
        photorealUploads[id] = .preparing
        transfers += 1
        defer { transfers -= 1 }
        let api = AtriumAPI(server: pairing.server, token: pairing.token)
        let store = self.store
        do {
            let files = try await Task.detached(priority: .userInitiated) {
                try PhotorealFiles.collect(scan: store.directory(for: id), photoreal: store.photorealURL(for: id))
            }.value
            let start = try await api.startPhotoreal(files: files.files.map { ($0.name, $0.size) }, assetUrl: delivery.assetUrl)
            photorealUploads[id] = .uploading(0)
            try await api.upload(files, links: start.uploads) { fraction in
                Task { @MainActor [weak self] in
                    if case .uploading? = self?.photorealUploads[id] { self?.photorealUploads[id] = .uploading(fraction) }
                }
            }
            photorealUploads[id] = .finishing
            let job = try await api.completePhotoreal(job: start.jobId)
            var updated = scans.first { $0.id == id } ?? record
            updated.photoreal = ScanRecord.Photoreal(jobId: job.id, propertyId: pairing.propertyId, sentAt: Date())
            try? store.save(updated)
            photorealJobs[id] = job
            photorealUploads[id] = nil
            reloadScans()
        } catch {
            photorealUploads[id] = .failed(error.localizedDescription)
        }
    }

    /// Asks Atrium how the scan's photoreal walkthrough is coming along (while paired with its listing).
    func refreshPhotoreal(_ record: ScanRecord) async {
        guard let job = record.photoreal, let pairing, !pairing.isExpired, pairing.propertyId == job.propertyId else { return }
        if let status = try? await AtriumAPI(server: pairing.server, token: pairing.token).photorealJob(job.jobId) {
            photorealJobs[record.id] = status
        }
    }

    private func setProgress(_ id: UUID, _ value: Double) {
        if case .uploading = uploads[id] { uploads[id] = .uploading(value) } else if uploads[id] == .preparing { uploads[id] = .uploading(value) }
    }
}
