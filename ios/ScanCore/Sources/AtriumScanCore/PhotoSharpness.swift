import Foundation

/// How sharp a photo comes out while the phone moves. A photo taken while the phone turns is
/// smeared by about turn rate × exposure time × focal length pixels; one taken while walking, by
/// about speed × exposure time × focal length ÷ distance. Indoors the camera runs at its longest
/// exposure (1/60 s at 60 frames a second), so even a slow 0.2 rad/s turn smears a 1920 px photo by
/// 5 px. Smeared photos paint soft walls and make photoreal walkthroughs blurry.
///
/// The app takes a photo when the smear it predicts is at most `sharp` pixels. While it waits, it
/// accepts a little more, up to `soft` pixels after `patience` seconds, so photos keep coming about
/// once or twice a second while the phone moves (build 11 waited 4 s before settling: a living room
/// got 57 photos instead of 171, too few angles for the photoreal walkthrough). The coverage map
/// counts a photo over `sharp` as weak (the spot still wants a sharp one). Pixels on the 1920 px
/// photos the app saves.
public enum PhotoSharpness {
    public static let sharp: Float = 3
    public static let soft: Float = 6
    public static let patience: TimeInterval = 1.5
    /// How far away what's in view is assumed to be, for the smear of walking: across a room, the
    /// walls and furniture a photo is mostly of.
    public static let assumedDistance: Float = 2
    /// PhotoTexturing's guess when a photo has no exposure time.
    public static let defaultExposure: Float = 0.02

    public enum Take: Sendable, Equatable {
        case sharp, soft
    }

    /// Predicted smear in pixels: `turnRate` rad/s, `speed` m/s, `exposure` s, `fx` the focal length in
    /// pixels at the photo's size.
    public static func smear(turnRate: Float, speed: Float?, exposure: Double?, fx: Float) -> Float {
        let t = exposure.flatMap { $0.isFinite && $0 > 0 && $0 < 1 ? Float($0) : nil } ?? defaultExposure
        let turn = (turnRate.isFinite ? max(0, turnRate) : 0) * t * fx
        let walk = (speed.flatMap { $0.isFinite ? max(0, $0) : nil } ?? 0) * t * fx / assumedDistance
        return (turn * turn + walk * walk).squareRoot()
    }

    /// The most smear a photo may have `waited` seconds after it could first have been taken: `sharp`
    /// at once, rising evenly to `soft` at `patience`, and no more after that.
    public static func limit(waited: TimeInterval) -> Float {
        let t = Float(max(0, min(1, waited / patience)))
        return sharp + (soft - sharp) * t
    }

    /// Whether to take a photo with this much smear, `waited` seconds after one could first have been
    /// taken: nil while the phone is still moving too much.
    public static func decide(smear: Float, waited: TimeInterval) -> Take? {
        if smear <= sharp { return .sharp }
        if smear <= limit(waited: waited) { return .soft }
        return nil
    }
}

extension CameraFrame {
    /// How smeared the saved photo is, in pixels (nil when the phone didn't record its turn rate).
    public var smearPixels: Float? {
        guard let rate = angularSpeed, rate.isFinite, intrinsics.count == 9, width > 0, imageWidth > 0 else { return nil }
        let fx = intrinsics[0] * Float(imageWidth) / Float(width)
        return PhotoSharpness.smear(turnRate: rate, speed: linearSpeed, exposure: exposureDuration, fx: fx)
    }
}
