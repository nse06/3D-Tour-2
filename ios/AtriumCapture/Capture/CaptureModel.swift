import AtriumScanCore
import Foundation
import RoomPlan

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
    }

    @Published var phase: Phase = .scanning
    @Published private(set) var rooms: [RoomCapture] = []
    /// RoomPlan's coaching hint, if any ("Move closer to the wall").
    @Published var instruction: String?
    /// What RoomPlan thinks the current room is ("Kitchen").
    @Published var detectedName: String?
    /// Name field of the naming sheet.
    @Published var draftName = ""

    /// Names the scan's folder (Documents/Scans/<scanId>) and its record.
    let scanId: UUID
    let directory: URL
    let recorder: MotionRecorder
    let startedAt = Date()
    weak var controller: CaptureViewController?

    /// Called when the realtor finishes (rooms, path) or cancels (nil).
    var onFinish: ((CaptureModel) -> Void)?
    var onCancel: (() -> Void)?

    private var pendingData: CapturedRoomData?
    /// Finished or cancelled: ignore late RoomPlan callbacks.
    private var closed = false

    static let quickNames = ["Living Room", "Kitchen", "Dining Room", "Bedroom", "Primary Bedroom", "Bathroom", "Office", "Hallway", "Entry", "Laundry"]

    init(scanId: UUID, directory: URL) {
        self.scanId = scanId
        self.directory = directory
        recorder = MotionRecorder(framesDirectory: directory.appendingPathComponent("frames", isDirectory: true))
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
        rooms.append(RoomCapture(name: trimmed.isEmpty ? "Room \(roomNumber)" : trimmed, data: data))
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

    // MARK: Events (from RoomPlan)

    func roomEnded(_ data: CapturedRoomData, error: Error?) {
        guard !closed else { return }
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
