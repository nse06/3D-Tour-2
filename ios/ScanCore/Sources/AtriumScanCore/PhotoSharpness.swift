import Foundation

/// How sharp a photo comes out while the phone moves. A photo taken while the phone turns is
/// smeared by about turn rate × exposure time × focal length pixels; one taken while walking, by
/// about speed × exposure time × focal length ÷ distance. Indoors the camera runs at its longest
/// exposure (1/60 s at 60 frames a second), so even a slow 0.2 rad/s turn smears a 1920 px photo by
/// 5 px. Smeared photos paint soft walls and make photoreal walkthroughs blurry.
///
/// The app takes a photo when the smear it predicts is at most `sharp` pixels. If the phone hasn't
/// been that steady for `patience` seconds, it settles for up to `soft` pixels, and the coverage map
/// counts such a photo as weak (the spot still wants a sharp one). Pixels on the 1920 px photos the
/// app saves.
public enum PhotoSharpness {
    public static let sharp: Float = 3
    public static let soft: Float = 6
    public static let patience: TimeInterval = 4
    /// How far away what's in view is assumed to be, for the smear of walking: about arm's length to
    /// across a small room, where walking blur shows most.
    public static let assumedDistance: Float = 1.5
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

    /// Whether to take a photo with this much smear, `waited` seconds after one could first have been
    /// taken: nil while the phone is still moving too much.
    public static func decide(smear: Float, waited: TimeInterval) -> Take? {
        if smear <= sharp { return .sharp }
        if waited >= patience, smear <= soft { return .soft }
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
