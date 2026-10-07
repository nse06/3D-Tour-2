import ARKit
import AtriumScanCore
import CoreImage
import ImageIO
import Foundation

/// One RGB keyframe saved during the scan (frames/frames.json).
struct KeyframeInfo: Codable {
    var file: String
    var t: Double
    /// Camera-to-world, 16 floats column-major.
    var transform: [Float]
    /// Camera intrinsics, 9 floats column-major, for the full sensor resolution.
    var intrinsics: [Float]
    /// Full sensor resolution the intrinsics refer to.
    var width: Int
    var height: Int
    /// Size of the saved JPEG (downscaled, sensor orientation).
    var imageWidth: Int
    var imageHeight: Int
}

/// Records the phone's path (4 Hz) and an RGB keyframe every ~1.5 s while the
/// AR session runs — between rooms too, so the path links the rooms.
@MainActor
final class MotionRecorder {
    private(set) var samples: [PoseSample] = []
    private(set) var keyframes: [KeyframeInfo] = []
    let framesDirectory: URL

    private var startTime: TimeInterval?
    private var lastKeyframe: TimeInterval = -.infinity
    private var encoding = false
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let queue = DispatchQueue(label: "atrium.keyframes", qos: .utility)

    static let keyframeInterval: TimeInterval = 1.5
    static let maxKeyframes = 400
    static let maxImageSide: CGFloat = 1280

    init(framesDirectory: URL) {
        self.framesDirectory = framesDirectory
        try? FileManager.default.createDirectory(at: framesDirectory, withIntermediateDirectories: true)
    }

    func record(_ frame: ARFrame) {
        guard case .normal = frame.camera.trackingState else { return }
        let t = frame.timestamp
        if startTime == nil { startTime = t }
        let elapsed = t - (startTime ?? t)
        if let last = samples.last, elapsed - last.t < 0.2 { return }

        let m = frame.camera.transform
        let position = Vec3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        let forward = -Vec3(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        samples.append(PoseSample(t: elapsed, p: position, f: forward))

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
        var info = KeyframeInfo(
            file: "frames/\(name)", t: elapsed,
            transform: [m.columns.0, m.columns.1, m.columns.2, m.columns.3].flatMap { [$0.x, $0.y, $0.z, $0.w] },
            intrinsics: [k.columns.0, k.columns.1, k.columns.2].flatMap { [$0.x, $0.y, $0.z] },
            width: Int(resolution.width), height: Int(resolution.height), imageWidth: 0, imageHeight: 0)

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

    /// Writes frames/frames.json next to the JPEGs.
    func writeIndex() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        try encoder.encode(keyframes).write(to: framesDirectory.appendingPathComponent("frames.json"))
    }
}
