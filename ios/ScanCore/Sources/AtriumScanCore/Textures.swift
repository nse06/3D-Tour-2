import Foundation

// Procedural textures (seamlessly tiling) and a dependency-free PNG encoder.

/// Deterministic pseudo-random numbers (mulberry32).
struct SeededRandom {
    private var state: UInt32

    init(seed: UInt32) { state = seed }

    mutating func next() -> Double {
        state = state &+ 0x6d2b_79f5
        var t = state
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double(t ^ (t >> 14)) / 4_294_967_296
    }
}

private func hash2(_ x: Int, _ y: Int, _ seed: Int) -> Double {
    var h = UInt32(truncatingIfNeeded: Int64(x) &* 374_761_393 &+ Int64(y) &* 668_265_263 &+ Int64(seed) &* 1_442_695_041)
    h = (h ^ (h >> 13)) &* 1_274_126_177
    h ^= h >> 16
    return Double(h) / 4_294_967_296
}

@inline(__always) private func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }
@inline(__always) private func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

/// Value noise that tiles with period (px, py) lattice cells.
private func valueNoise(_ x: Double, _ y: Double, _ px: Int, _ py: Int, _ seed: Int) -> Double {
    let xi = Int(x.rounded(.down)), yi = Int(y.rounded(.down))
    let xf = x - Double(xi), yf = y - Double(yi)
    let x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py
    let x1 = (x0 + 1) % px, y1 = (y0 + 1) % py
    let u = smooth(xf), v = smooth(yf)
    return lerp(lerp(hash2(x0, y0, seed), hash2(x1, y0, seed), u), lerp(hash2(x0, y1, seed), hash2(x1, y1, seed), u), v)
}

/// Tileable fractal noise in [0, 1]; u, v in [0, 1), base frequencies fx, fy.
func fbm(_ u: Double, _ v: Double, _ fx: Int, _ fy: Int, octaves: Int = 4, seed: Int = 7) -> Double {
    var amp = 0.5, sum = 0.0, norm = 0.0
    var mx = fx, my = fy
    for o in 0..<octaves {
        sum += amp * valueNoise(u * Double(mx), v * Double(my), mx, my, seed + o * 31)
        norm += amp
        amp *= 0.5
        mx *= 2
        my *= 2
    }
    return sum / norm
}

/// An 8-bit RGB image.
struct RGBImage {
    let width: Int
    let height: Int
    var pixels: [UInt8]

    init(width: Int, height: Int, fill: (_ u: Double, _ v: Double) -> (Double, Double, Double)) {
        self.width = width
        self.height = height
        pixels = [UInt8](repeating: 0, count: width * height * 3)
        for y in 0..<height {
            for x in 0..<width {
                let (r, g, b) = fill((Double(x) + 0.5) / Double(width), (Double(y) + 0.5) / Double(height))
                let i = (y * width + x) * 3
                pixels[i] = UInt8(clamp(r.rounded(), 0, 255))
                pixels[i + 1] = UInt8(clamp(g.rounded(), 0, 255))
                pixels[i + 2] = UInt8(clamp(b.rounded(), 0, 255))
            }
        }
    }
}

enum ProceduralTexture {
    /// Wide-plank white oak; planks run along v. The texture spans `planks` planks.
    static func oak(size: Int, planks: Int = 8) -> RGBImage {
        var rng = SeededRandom(seed: 11)
        struct Column { var breaks: (Double, Double); var tints: (Double, Double) }
        let columns: [Column] = (0..<planks).map { _ in
            let offset = rng.next()
            let b0 = offset.truncatingRemainder(dividingBy: 1)
            let b1 = (offset + 0.42 + rng.next() * 0.2).truncatingRemainder(dividingBy: 1)
            return Column(breaks: (b0, b1), tints: (0.9 + rng.next() * 0.17, 0.9 + rng.next() * 0.17))
        }
        let plankW = 1 / Double(planks)
        let px = Double(size)
        return RGBImage(width: size, height: size) { u, v in
            let ci = min(planks - 1, Int(u / plankW))
            let col = columns[ci]
            let lu = (u - Double(ci) * plankW) / plankW
            let (b0, b1) = col.breaks
            let inSegment = b0 < b1 ? (v >= b0 && v < b1) : (v >= b0 || v < b1)
            let tint = inSegment ? col.tints.0 : col.tints.1
            let grain = fbm(u, v, planks * 2, 3, octaves: 5, seed: 3 + ci)
            let streak = fbm(u, v, planks * 12, 2, octaves: 3, seed: 91 + ci)
            let knot = pow(fbm(u, v, planks * 3, 6, octaves: 3, seed: 17), 6) * 1.4
            var k = 0.82 + grain * 0.22 + (streak - 0.5) * 0.16 - knot * 0.25
            // Seams between planks and at plank ends.
            let edge = min(lu, 1 - lu) * px * plankW
            func seamDistance(_ a: Double) -> Double { min(abs(v - a), 1 - abs(v - a)) * px }
            let endSeam = min(seamDistance(b0), seamDistance(b1))
            if edge < 1.3 { k *= 0.62 } else if edge < 2.5 { k *= 0.86 }
            if endSeam < 1.2 { k *= 0.66 }
            k *= tint
            return (205 * k, 168 * k, 126 * k)
        }
    }

    /// Light porcelain tile with soft grout lines; `tiles` tiles per side.
    static func tile(size: Int, tiles: Int = 4) -> RGBImage {
        let px = Double(size)
        return RGBImage(width: size, height: size) { u, v in
            let gx = u * Double(tiles), gy = v * Double(tiles)
            let ex = min(gx - gx.rounded(.down), gx.rounded(.up) - gx) * px / Double(tiles)
            let ey = min(gy - gy.rounded(.down), gy.rounded(.up) - gy) * px / Double(tiles)
            if min(ex, ey) < 1.6 { return (170, 166, 160) }
            let cell = Int(gx.rounded(.down)) * 7 + Int(gy.rounded(.down)) * 13
            let tint = 0.97 + (hash2(cell, 3, 5) - 0.5) * 0.05
            let cloud = fbm(u, v, 6, 6, octaves: 4, seed: 41 + cell % 5)
            let k = (0.93 + (cloud - 0.5) * 0.1) * tint
            return (222 * k, 218 * k, 210 * k)
        }
    }
}

// MARK: - PNG

enum PNG {
    /// Encodes an RGB image. Apple platforms deflate the pixel data; elsewhere
    /// it is stored uncompressed (valid, just larger).
    static func encode(_ image: RGBImage) -> Data {
        var raw = [UInt8]()
        raw.reserveCapacity((image.width * 3 + 1) * image.height)
        let stride = image.width * 3
        var previous = [UInt8](repeating: 0, count: stride)
        for y in 0..<image.height {
            let row = Array(image.pixels[(y * stride)..<((y + 1) * stride)])
            raw.append(4)  // Paeth filter
            for i in 0..<stride {
                let a = i >= 3 ? Int(row[i - 3]) : 0
                let b = Int(previous[i])
                let c = i >= 3 ? Int(previous[i - 3]) : 0
                raw.append(row[i] &- UInt8(paeth(a, b, c)))
            }
            previous = row
        }

        var png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        var ihdr = Data()
        ihdr.appendUInt32BE(UInt32(image.width))
        ihdr.appendUInt32BE(UInt32(image.height))
        ihdr.append(contentsOf: [8, 2, 0, 0, 0])  // 8-bit, truecolor, deflate, adaptive filtering, no interlace
        appendChunk(&png, "IHDR", ihdr)
        appendChunk(&png, "IDAT", zlib(raw))
        appendChunk(&png, "IEND", Data())
        return png
    }

    private static func paeth(_ a: Int, _ b: Int, _ c: Int) -> Int {
        let p = a + b - c
        let pa = abs(p - a), pb = abs(p - b), pc = abs(p - c)
        if pa <= pb && pa <= pc { return a }
        return pb <= pc ? b : c
    }

    private static func appendChunk(_ png: inout Data, _ type: String, _ data: Data) {
        png.appendUInt32BE(UInt32(data.count))
        var body = Data(type.utf8)
        body.append(data)
        png.append(body)
        png.appendUInt32BE(crc32(body))
    }

    /// A zlib stream (RFC 1950) around raw deflate data.
    static func zlib(_ bytes: [UInt8]) -> Data {
        var out = Data([0x78, 0x01])
        out.append(deflate(bytes))
        out.appendUInt32BE(adler32(bytes))
        return out
    }

    private static func deflate(_ bytes: [UInt8]) -> Data {
        #if canImport(Darwin)
            // Foundation's "zlib" algorithm produces raw DEFLATE (RFC 1951).
            if let compressed = try? (Data(bytes) as NSData).compressed(using: .zlib) {
                return compressed as Data
            }
        #endif
        return storedDeflate(bytes)
    }

    /// DEFLATE with uncompressed ("stored") blocks.
    static func storedDeflate(_ bytes: [UInt8]) -> Data {
        var out = Data()
        var offset = 0
        repeat {
            let n = min(65535, bytes.count - offset)
            let final = offset + n >= bytes.count
            out.append(final ? 1 : 0)
            out.append(UInt8(n & 0xff))
            out.append(UInt8(n >> 8))
            out.append(UInt8(~n & 0xff))
            out.append(UInt8((~n >> 8) & 0xff))
            out.append(contentsOf: bytes[offset..<(offset + n)])
            offset += n
        } while offset < bytes.count
        return out
    }

    static func adler32(_ bytes: [UInt8]) -> UInt32 {
        var a: UInt32 = 1, b: UInt32 = 0
        for chunk in stride(from: 0, to: bytes.count, by: 5552) {
            for byte in bytes[chunk..<min(chunk + 5552, bytes.count)] {
                a += UInt32(byte)
                b += a
            }
            a %= 65521
            b %= 65521
        }
        return (b << 16) | a
    }

    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xedb8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xffff_ffff
        for byte in data { c = crcTable[Int((c ^ UInt32(byte)) & 0xff)] ^ (c >> 8) }
        return c ^ 0xffff_ffff
    }
}

extension Data {
    mutating func appendUInt32BE(_ v: UInt32) {
        append(contentsOf: [UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)])
    }

    mutating func appendUInt32LE(_ v: UInt32) {
        append(contentsOf: [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8(v >> 24)])
    }
}
