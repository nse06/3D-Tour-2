import ARKit
import AtriumScanCore
import CoreImage
import ImageIO
import Foundation

/// Records the phone's path and an RGB keyframe every ~1.5 s while the AR
/// session runs — between rooms too, so the path links the rooms.
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
    let framesDirectory: URL

    private var startTime: TimeInterval?
    private var lastKeyframe: TimeInterval = -.infinity
    private var encoding = false
    /// Dense sampling until this ARFrame time (set on the first frame after a run starts).
    private var denseUntil: TimeInterval = -.infinity
    private var denseRequested = false
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let queue = DispatchQueue(label: "atrium.keyframes", qos: .utility)

    static let keyframeInterval: TimeInterval = 1.5
    static let maxKeyframes = 400
    static let maxImageSide: CGFloat = 1280
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
        guard case .normal = frame.camera.trackingState else { return }
        if startTime == nil { startTime = t }
        let elapsed = t - (startTime ?? t)
        let interval = t < denseUntil ? Self.denseInterval : Self.sampleInterval
        if let last = samples.last, elapsed - last.t < interval * 0.95 { return }

        let m = frame.camera.transform
        let position = Vec3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        let forward = -Vec3(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        samples.append(PoseSample(t: elapsed, p: position, f: forward, segment: max(segment, 0)))

        if elapsed - lastKeyframe >= Self.keyframeInterval, !encoding, keyframes.count < Self.maxKeyframes {
            lastKeyframe = elapsed
            saveKeyframe(frame, elapsed: elapsed)
        }
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
            width: Int(resolution.width), height: Int(resolution.height), imageWidth: 0, imageHeight: 0, segment: max(segment, 0))

        // Downscale and encode off the main thread; one frame at a time so ARKit's buffers are released quickly.
        let image = CIImage(cvPixelBuffer: frame.capturedImage)
        let scale = min(1, Self.maxImageSide / max(image.extent.width, image.extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        info.imageWidth = Int((image.extent.width * scale).rounded())
        info.imageHeight = Int((image.extent.height * scale).rounded())
        encoding = true
        let context = self.context
        queue.async {
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
            let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.72]
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
