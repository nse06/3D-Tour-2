import ARKit
import RoomPlan
import UIKit

/// Hosts RoomPlan's RoomCaptureView. Rooms are scanned one after another in a
/// single AR session (`stop(pauseARSession: false)` between rooms). RoomPlan
/// still moves the world origin to the phone when each room starts, so the
/// recorder tags everything with its run and samples densely around each start.
///
/// The AR session is the app's own, set to reconstruct the LiDAR mesh as well
/// (RoomPlan keeps a session's settings); the mesh around each room is saved
/// when the room ends.
final class CaptureViewController: UIViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {
    private let model: CaptureModel
    private var captureView: RoomCaptureView!
    private let configuration = RoomCaptureSession.Configuration()
    private var sampler: CADisplayLink?
    /// AR tracking is on (from the first room until the scan ends).
    private var isTracking = false
    /// A RoomPlan room capture is in progress.
    private var roomActive = false

    init(model: CaptureModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        if MeshRecorder.isEnabled, let session = Self.meshSession() {
            captureView = RoomCaptureView(frame: view.bounds, arSession: session)
        } else {
            captureView = RoomCaptureView(frame: view.bounds)
        }
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        captureView.captureSession.delegate = self
        view.addSubview(captureView)
        model.controller = self
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        if !isTracking, model.phase == .scanning { startRoom() }
        if sampler == nil {
            // 30 Hz polling of the latest AR frame; the recorder keeps what it needs.
            let link = CADisplayLink(target: self, selector: #selector(sample))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
            link.add(to: .main, forMode: .common)
            sampler = link
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        sampler?.invalidate()
        sampler = nil
        stopTracking()
    }

    /// A running world-tracking session that also reconstructs the LiDAR mesh (with ARKit's
    /// classes where supported), for RoomPlan to scan with; nil if the device can't.
    private static func meshSession() -> ARSession? {
        let configuration = ARWorldTrackingConfiguration()
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
            configuration.sceneReconstruction = .meshWithClassification
        } else if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            configuration.sceneReconstruction = .mesh
        } else {
            return nil
        }
        let session = ARSession()
        session.run(configuration)
        return session
    }

    // MARK: Control

    func startRoom() {
        isTracking = true
        roomActive = true
        model.recorder.beginSegment()
        captureView.captureSession.run(configuration: configuration)
    }

    /// Ends the current room but keeps AR tracking running for the next one.
    func endRoom() {
        guard roomActive else { return }
        roomActive = false
        // The mesh is in this room's frame until the next room starts.
        model.meshes.snapshot(captureView.captureSession.arSession, segment: model.recorder.segment)
        captureView.captureSession.stop(pauseARSession: false)
    }

    func stopTracking() {
        guard isTracking else { return }
        isTracking = false
        if roomActive {
            roomActive = false
            captureView.captureSession.stop()
        }
        captureView.captureSession.arSession.pause()
    }

    @objc private func sample() {
        guard isTracking, let frame = captureView.captureSession.arSession.currentFrame else { return }
        model.recorder.record(frame)
        model.updatePhotoStatus()
    }

    // MARK: RoomCaptureSessionDelegate

    nonisolated func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        let name = RoomPlanAdapter.suggestedName(for: RoomPlanAdapter.dominantLabel(of: room))
        Task { @MainActor in
            if let name { self.model.detectedName = name }
        }
    }

    nonisolated func captureSession(_ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction) {
        let text = CaptureModel.describe(instruction)
        Task { @MainActor in self.model.instruction = text }
    }

    nonisolated func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        Task { @MainActor in
            // RoomPlan stopped on its own: keep the mesh too (no-op if the room was ended by hand).
            self.model.meshes.snapshot(self.captureView.captureSession.arSession, segment: self.model.recorder.segment)
            self.model.roomEnded(data, error: error)
        }
    }

    // MARK: RoomCaptureViewDelegate

    /// No per-room result animation: rooms are processed together at the end.
    nonisolated func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool { false }

    nonisolated func captureView(didPresent processedResult: CapturedRoom, error: Error?) {}
}
