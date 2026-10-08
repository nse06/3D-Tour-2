import AtriumScanCore
import Foundation
import RoomPlan
import simd

/// The state of a multi-room scan, shared by the capture screen's SwiftUI
/// overlay and the UIKit controller that drives RoomPlan.
@MainActor
final class CaptureModel: ObservableObject {
    enum Phase: Equatable {
        /// RoomPlan is scanning room number `rooms.count + 1`.
        case scanning
        /// "Done with this room" was tapped; waiting for RoomPlan to hand over the room.
        case endingRoom
        /// Asking for the room's name.
        case naming
        /// Between rooms: the AR session keeps tracking while the realtor walks.
        case betweenRooms
        case failed(String)
    }

    struct RoomCapture {
        var name: String
        let data: CapturedRoomData
        /// The RoomPlan run that scanned it (its coordinate frame).
        let segment: Int
    }

    @Published var phase: Phase = .scanning
    @Published private(set) var rooms: [RoomCapture] = []
    /// RoomPlan's coaching hint, if any ("Move closer to the wall").
    @Published var instruction: String?
    /// What RoomPlan thinks the current room is ("Kitchen").
    @Published var detectedName: String?
    /// Name field of the naming sheet.
    @Published var draftName = ""
    /// Photos taken so far, and whether the phone is moving too fast for sharp ones.
    @Published private(set) var photoCount = 0
    @Published private(set) var movingFast = false
    /// What the photos of the room being scanned cover so far (nil until RoomPlan sees a room), and
    /// the phone on that map: where it is and which way it looks (plan x, z).
    @Published private(set) var coverage: CaptureCoverage?
    @Published private(set) var mapPosition: SIMD2<Double>?
    @Published private(set) var mapForward: SIMD2<Double>?

    /// Names the scan's folder (Documents/Scans/<scanId>) and its record.
    let scanId: UUID
    let directory: URL
    let recorder: MotionRecorder
    let meshes: MeshRecorder
    let startedAt = Date()
    weak var controller: CaptureViewController?

    /// Called when the realtor finishes (rooms, path) or cancels (nil).
    var onFinish: ((CaptureModel) -> Void)?
    var onCancel: (() -> Void)?

    private var pendingData: CapturedRoomData?
    private var pendingSegment = 0
    /// RoomPlan's latest idea of the room being scanned, and the coverage map's bookkeeping.
    private var livePart: RoomPart?
    private var coverageRunning = false
    private var coverageDirty = false
    private var lastCoverage = Date.distantPast
    private var lastPose: TimeInterval = 0
    /// Finished or cancelled: ignore late RoomPlan callbacks.
    private var closed = false

    static let quickNames = ["Living Room", "Kitchen", "Dining Room", "Bedroom", "Primary Bedroom", "Bathroom", "Office", "Hallway", "Entry", "Laundry"]

    init(scanId: UUID, directory: URL) {
        self.scanId = scanId
        self.directory = directory
        recorder = MotionRecorder(framesDirectory: directory.appendingPathComponent("frames", isDirectory: true))
        meshes = MeshRecorder(directory: directory.appendingPathComponent("roomplan", isDirectory: true))
    }

    var roomNumber: Int { rooms.count + 1 }

    // MARK: Actions (from the overlay)

    func finishRoom() {
        guard phase == .scanning else { return }
        phase = .endingRoom
        controller?.endRoom()
    }

    /// Keeps the room under `draftName` and moves on.
    func saveRoom(thenScanAnother another: Bool) {
        guard let data = pendingData else { return }
        let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        rooms.append(RoomCapture(name: trimmed.isEmpty ? "Room \(roomNumber)" : trimmed, data: data, segment: pendingSegment))
        pendingData = nil
        if another {
            phase = .betweenRooms
        } else {
            close()
            onFinish?(self)
        }
    }

    /// Throws the room just scanned away and scans it again.
    func rescanRoom() {
        pendingData = nil
        startNextRoom()
    }

    func startNextRoom() {
        detectedName = nil
        instruction = nil
        livePart = nil
        coverage = nil
        phase = .scanning
        controller?.startRoom()
    }

    /// Finish without scanning another room (from the between-rooms banner).
    func finish() {
        close()
        if rooms.isEmpty { onCancel?() } else { onFinish?(self) }
    }

    func cancel() {
        close()
        onCancel?()
    }

    private func close() {
        closed = true
        controller?.stopTracking()
    }

    /// After each recorded AR frame: publishes the photo count and the "slow down" hint when they change.
    func updatePhotoStatus() {
        let count = recorder.keyframes.count, fast = recorder.movingFast
        if photoCount != count {
            photoCount = count
            refreshCoverage()
        }
        if movingFast != fast { movingFast = fast }
    }

    /// The phone on the coverage map (a few times a second is plenty).
    func updatePose(_ m: simd_float4x4, at time: TimeInterval) {
        guard phase == .scanning, time - lastPose > 0.15 else { return }
        lastPose = time
        mapPosition = SIMD2(Double(m.columns.3.x), Double(m.columns.3.z))
        // The camera looks along its −z; pointing almost straight down keeps the last heading.
        let forward = SIMD2(-Double(m.columns.2.x), -Double(m.columns.2.z))
        if simd_length(forward) > 0.25 { mapForward = forward }
    }

    /// RoomPlan's latest idea of the room being scanned (in this run's frame).
    func roomUpdated(_ part: RoomPart) {
        guard phase == .scanning else { return }
        livePart = part
        refreshCoverage()
    }

    /// Too little of the room has a good photo to finish without asking.
    var coverageIsLow: Bool {
        guard let coverage else { return false }
        return (coverage.wallShare ?? 1) < 0.6 || (coverage.floorShare ?? 1) < 0.35
    }

    /// Recomputes the coverage map off the main thread: one at a time, at most twice a second, and
    /// once more if the room or the photos changed meanwhile.
    private func refreshCoverage() {
        guard let part = livePart, phase == .scanning else { return }
        let wait = 0.5 - Date().timeIntervalSince(lastCoverage)
        guard !coverageRunning, wait <= 0 else {
            if !coverageDirty {
                coverageDirty = true
                if !coverageRunning {
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: UInt64(max(wait, 0.05) * 1e9))
                        self.coverageDirty = false
                        self.refreshCoverage()
                    }
                }
            }
            return
        }
        coverageRunning = true
        lastCoverage = Date()
        let segment = recorder.segment
        let photos = recorder.keyframes.filter { $0.segment == segment }
        Task.detached(priority: .utility) {
            let result = CaptureCoverage.compute(part, photos: photos)
            await MainActor.run {
                self.coverageRunning = false
                if self.phase == .scanning, self.livePart != nil { self.coverage = result }
                if self.coverageDirty {
                    self.coverageDirty = false
                    self.refreshCoverage()
                }
            }
        }
    }

    // MARK: Events (from RoomPlan)

    func roomEnded(_ data: CapturedRoomData, error: Error?) {
        guard !closed else { return }
        pendingSegment = max(recorder.segment, 0)
        if let error, phase != .endingRoom {
            // RoomPlan stopped on its own (tracking lost, too hot, …).
            phase = .failed(Self.describe(error))
            pendingData = data
            return
        }
        pendingData = data
        draftName = detectedName ?? ""
        phase = .naming
    }

    /// After a RoomPlan failure: keep what was scanned of the room.
    func keepPartialRoom() {
        draftName = detectedName ?? ""
        phase = pendingData == nil ? .betweenRooms : .naming
    }

    func sessionFailed(_ error: Error) {
        phase = .failed(Self.describe(error))
    }

    nonisolated static func describe(_ error: Error) -> String {
        if let capture = error as? RoomCaptureSession.CaptureError {
            switch capture {
            case .worldTrackingFailure: return "The iPhone lost track of where it is. Move slowly, keep the camera uncovered, and make sure the room is lit."
            case .exceedSceneSizeLimit: return "This space is too large for one scan. Finish this room and scan the next part as another room."
            case .deviceTooHot: return "The iPhone is too warm to keep scanning. Let it cool down for a few minutes."
            case .deviceNotSupported: return "This iPhone can't scan rooms — it needs a LiDAR scanner."
            default: return capture.localizedDescription
            }
        }
        return error.localizedDescription
    }

    nonisolated static func describe(_ instruction: RoomCaptureSession.Instruction) -> String? {
        switch instruction {
        case .moveCloseToWall: return "Move closer to the wall"
        case .moveAwayFromWall: return "Move away from the wall"
        case .slowDown: return "Slow down"
        case .turnOnLight: return "Turn on more lights"
        case .lowTexture: return "Point at walls with more detail"
        case .normal: return nil
        @unknown default: return nil
        }
    }
}
