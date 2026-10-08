import Foundation

/// Where a photo shows people — the realtor reflected in a mirror, someone walking through — as a
/// coarse grid over the photo, in the photo's own (sensor) orientation. Texturing paints those
/// spots from other photos. Where every photo of a spot shows a person, the spot is painted from
/// them only if they saw it from different sides (it stays put, so it is on the surface: a poster
/// of a person); otherwise it is filled in from around it.
public struct PhotoMask: Sendable, Equatable {
    public let width: Int
    public let height: Int
    /// Row-major, rows top to bottom: true where the photo shows a person.
    public var pixels: [Bool]

    public init(width: Int, height: Int, pixels: [Bool]) {
        precondition(width > 0 && height > 0 && pixels.count == width * height, "PhotoMask needs width × height values")
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    /// From 8-bit confidences (Vision's person segmentation): masked from `threshold` up.
    public init(width: Int, height: Int, confidence: [UInt8], threshold: UInt8 = 128) {
        self.init(width: width, height: height, pixels: confidence.map { $0 >= threshold })
    }

    public var isEmpty: Bool { !pixels.contains(true) }

    /// Share of the photo that is masked.
    public var coveredShare: Double { Double(pixels.lazy.filter { $0 }.count) / Double(pixels.count) }

    /// Clockwise quarter turns that make a frame's photo upright — the room's up pointing up —
    /// from the pose it was taken at: 1 for a phone held in portrait (the sensor is landscape).
    /// Person detectors work best on upright photos.
    public static func uprightTurns(for frame: CameraFrame) -> Int {
        // The room's up direction in the photo: camera x is the photo's right, camera y its up.
        let worldUp = Vec3(0, 1, 0)
        let a = vdot(worldUp, vnormalize(frame.transform.xAxis)), b = vdot(worldUp, vnormalize(frame.transform.yAxis))
        // Looking straight up or down: as the phone is usually held.
        guard (a * a + b * b).squareRoot() > 0.2 else { return 1 }
        if abs(a) > abs(b) { return a < 0 ? 1 : 3 }
        return b > 0 ? 0 : 2
    }

    /// The mask turned by `turns` clockwise quarter turns.
    public func rotated(clockwiseTurns turns: Int) -> PhotoMask {
        let (values, w, h) = rotateGrid(pixels, width: width, height: height, channels: 1, clockwiseTurns: turns)
        return PhotoMask(width: w, height: h, pixels: values)
    }

    /// At most `maxSide` cells across, a cell masked if any part of it was.
    public func shrunk(toFit maxSide: Int) -> PhotoMask {
        let scale = max(1, Int((Double(max(width, height)) / Double(max(1, maxSide))).rounded(.up)))
        guard scale > 1 else { return self }
        let w = (width + scale - 1) / scale, h = (height + scale - 1) / scale
        var out = [Bool](repeating: false, count: w * h)
        for y in 0..<height {
            for x in 0..<width where pixels[y * width + x] { out[(y / scale) * w + x / scale] = true }
        }
        return PhotoMask(width: w, height: h, pixels: out)
    }

    /// Masked cells grown by `radius` cells in every direction, to cover the soft edges of hair,
    /// hands and motion.
    func dilated(by radius: Int) -> PhotoMask {
        guard radius > 0, !isEmpty else { return self }
        // Separable: rows, then columns.
        var rows = [Bool](repeating: false, count: pixels.count)
        for y in 0..<height {
            var last = -Int.max / 2
            for x in 0..<width {
                if pixels[y * width + x] { last = x }
                if x - last <= radius { rows[y * width + x] = true }
            }
            last = Int.max / 2
            for x in stride(from: width - 1, through: 0, by: -1) {
                if pixels[y * width + x] { last = x }
                if last - x <= radius { rows[y * width + x] = true }
            }
        }
        var out = [Bool](repeating: false, count: pixels.count)
        for x in 0..<width {
            var last = -Int.max / 2
            for y in 0..<height {
                if rows[y * width + x] { last = y }
                if y - last <= radius { out[y * width + x] = true }
            }
            last = Int.max / 2
            for y in stride(from: height - 1, through: 0, by: -1) {
                if rows[y * width + x] { last = y }
                if last - y <= radius { out[y * width + x] = true }
            }
        }
        return PhotoMask(width: width, height: height, pixels: out)
    }

    /// Whether pixel (u, v) of a `w` × `h` photo (the whole photo, at any resolution) is masked.
    @inline(__always) func covers(u: Float, v: Float, width w: Int, height h: Int) -> Bool {
        let x = clamp(Int(u * Float(width) / Float(w)), 0, width - 1), y = clamp(Int(v * Float(height) / Float(h)), 0, height - 1)
        return pixels[y * width + x]
    }
}

extension RGBImage {
    /// The image turned by `turns` clockwise quarter turns.
    public func rotated(clockwiseTurns turns: Int) -> RGBImage {
        let (values, w, h) = rotateGrid(pixels, width: width, height: height, channels: 3, clockwiseTurns: turns)
        return RGBImage(width: w, height: h, pixels: values)
    }
}

/// A row-major grid of `channels` values per cell, turned clockwise by quarter turns.
func rotateGrid<T>(_ values: [T], width: Int, height: Int, channels: Int, clockwiseTurns turns: Int) -> ([T], Int, Int) {
    let k = ((turns % 4) + 4) % 4
    guard k != 0, let first = values.first else { return (values, width, height) }
    let (w, h) = k % 2 == 0 ? (width, height) : (height, width)
    var out = [T](repeating: first, count: values.count)
    for y in 0..<h {
        for x in 0..<w {
            // The source cell that lands on (x, y).
            let (sx, sy): (Int, Int)
            switch k {
            case 1: (sx, sy) = (y, height - 1 - x)
            case 2: (sx, sy) = (width - 1 - x, height - 1 - y)
            default: (sx, sy) = (width - 1 - y, x)
            }
            let s = (sy * width + sx) * channels, d = (y * w + x) * channels
            for c in 0..<channels { out[d + c] = values[s + c] }
        }
    }
    return (out, w, h)
}
