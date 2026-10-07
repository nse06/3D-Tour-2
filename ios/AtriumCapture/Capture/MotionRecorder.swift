import ARKit
import AtriumScanCore
import CoreImage
import ImageIO
import Foundation
import simd

/// Records the phone's path and full-resolution photos while the AR session
/// runs — between rooms too, so the path links the rooms. A photo is taken as
/// soon as the phone is steady (at most every 0.8 s); the longer it keeps
/// moving, the less steady it needs to be, so a fast walk still gets photos.
/// Each photo records how fast the phone was turning and its exposure time, so
/// texturing can prefer the sharp ones.
///
/// RoomPlan moves the AR world origin to the phone each time a room capture
/// starts, so every sample and photo is tagged with the run ("segment") it was
/// recorded in, and the path is sampled densely for a few seconds after each
/// run starts: the jump back to the origin there measures how the new frame
/// relates to the previous one (see ScanCore's RoomAlignment).
@MainActor
final class MotionRecorder {
    private(set) var samples: [PoseSample] = []
    private(set) var keyframes: [CameraFrame] = []
    /// The RoomPlan run in progress: 0 for the first room, +1 for every run after (rescans included).
    private(set) var segment = -1
    /// Moving too fast for sharp photos (smoothed: on after half a second, off after a second).
    private(set) var movingFast = false
    let framesDirectory: URL

    private var startTime: TimeInterval?
    private var lastKeyframe: TimeInterval = -.infinity
    private var encoding = false
    /// Dense sampling until this ARFrame time (set on the first frame after a run starts).
    private var denseUntil: TimeInterval = -.infinity
    private var denseRequested = false
    // The phone's motion between polled frames: smoothed turn rate (rad/s) and speed (m/s).
    private var lastPose: (t: TimeInterval, transform: simd_float4x4)?
    private var turnRate: Float = 0
    private var speed: Float = 0
    private var fastSince: TimeInterval?
    private var slowSince: TimeInterval?
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let queue = DispatchQueue(label: "atrium.keyframes", qos: .utility)

    /// Photos are at least this far apart...
    static let keyframeInterval: TimeInterval = 0.8
    /// ...and taken while the phone turns and moves slower than this. The limits grow by
    /// their own size for every second spent waiting.
    static let steadyTurnRate: Float = 0.2
    static let steadySpeed: Float = 0.3
    /// "Slow down" above these.
    static let fastTurnRate: Float = 0.7
    static let fastSpeed: Float = 0.8
    static let maxKeyframes = 600
    /// The camera's full video resolution (1920×1440) on current iPhones.
    static let maxImageSide: CGFloat = 1920
    static let jpegQuality = 0.8
    static let sampleInterval: TimeInterval = 0.2
    static let denseInterval: TimeInterval = 1.0 / 30
    static let denseWindow: TimeInterval = 3

    init(framesDirectory: URL) {
        self.framesDirectory = framesDirectory
        try? FileManager.default.createDirectory(at: framesDirectory, withIntermediateDirectories: true)
    }

    /// Call right before each RoomPlan run starts.
    func beginSegment() {
        segment += 1
        denseRequested = true
    }

    /// Call for every AR frame (or as often as possible); samples are thinned out here.
    func record(_ frame: ARFrame) {
        let t = frame.timestamp
        if denseRequested {
            denseRequested = false
            denseUntil = t + Self.denseWindow
        }
        guard case .normal = frame.camera.trackingState else {
            lastPose = nil
            return
        }
        updateMotion(frame)
        if startTime == nil { startTime = t }
        let elapsed = t - (startTime ?? t)

        if !encoding, keyframes.count < Self.maxKeyframes, elapsed - lastKeyframe >= Self.keyframeInterval {
            let relax = 1 + Float(min(10, elapsed - lastKeyframe - Self.keyframeInterval))
            if turnRate <= Self.steadyTurnRate * relax && speed <= Self.steadySpeed * relax {
                lastKeyframe = elapsed
                saveKeyframe(frame, elapsed: elapsed)
            }
        }

        let interval = t < denseUntil ? Self.denseInterval : Self.sampleInterval
        if let last = samples.last, elapsed - last.t < interval * 0.95 { return }
        let m = frame.camera.transform
        let position = Vec3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        let forward = -Vec3(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        samples.append(PoseSample(t: elapsed, p: position, f: forward, segment: max(segment, 0)))
    }

    /// Turn rate and speed since the last polled frame, smoothed.
    private func updateMotion(_ frame: ARFrame) {
        let t = frame.timestamp, m = frame.camera.transform
        defer { lastPose = (t, m) }
        guard let last = lastPose else { return }
        let dt = Float(t - last.t)
        guard dt > 0.005, dt < 0.5 else { return }  // the same frame again, or a gap
        let turn = simd_quatf(last.transform).inverse * simd_quatf(m)
        let angle = 2 * atan2(simd_length(turn.imag), abs(turn.real))
        let distance = simd_distance(simd_make_float3(m.columns.3), simd_make_float3(last.transform.columns.3))
        // Faster than anyone moves a phone: RoomPlan just moved the world origin.
        guard distance / dt < 3 else { return }
        turnRate += 0.5 * (angle / dt - turnRate)
        speed += 0.5 * (distance / dt - speed)
        if turnRate > Self.fastTurnRate || speed > Self.fastSpeed {
            slowSince = nil
            if fastSince == nil { fastSince = t }
        } else {
            fastSince = nil
            if slowSince == nil { slowSince = t }
        }
        if !movingFast, let since = fastSince, t - since > 0.5 { movingFast = true }
        if movingFast, let since = slowSince, t - since > 1 { movingFast = false }
    }

    private func saveKeyframe(_ frame: ARFrame, elapsed: Double) {
        let index = keyframes.count
        let name = String(format: "%06d.jpg", index)
        let url = framesDirectory.appendingPathComponent(name)
        let resolution = frame.camera.imageResolution
        let m = frame.camera.transform
        let k = frame.camera.intrinsics
        var info = CameraFrame(
            file: "frames/\(name)", t: elapsed, transform: Transform(m),
            intrinsics: [k.columns.0, k.columns.1, k.columns.2].flatMap { [$0.x, $0.y, $0.z] },
            width: Int(resolution.width), height: Int(resolution.height), imageWidth: 0, imageHeight: 0, segment: max(segment, 0),
            angularSpeed: turnRate, exposureDuration: frame.camera.exposureDuration)

        // Encode off the main thread; one frame at a time so ARKit's buffers are released quickly.
        let image = CIImage(cvPixelBuffer: frame.capturedImage)
        let scale = min(1, Self.maxImageSide / max(image.extent.width, image.extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        info.imageWidth = Int((image.extent.width * scale).rounded())
        info.imageHeight = Int((image.extent.height * scale).rounded())
        encoding = true
        let context = self.context, quality = Self.jpegQuality
        queue.async {
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
            let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
            let saved = (try? context.writeJPEGRepresentation(of: scaled, to: url, colorSpace: colorSpace, options: options)) != nil
            Task { @MainActor in
                self.encoding = false
                if saved { self.keyframes.append(info) }
            }
        }
    }

    /// Writes frames/frames.json next to the JPEGs (raw: each photo in its run's frame).
    func writeIndex() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        try encoder.encode(keyframes).write(to: framesDirectory.appendingPathComponent("frames.json"))
    }
}
