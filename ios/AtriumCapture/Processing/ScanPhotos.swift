import AtriumScanCore
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// The scan's photos (frames/*.jpg) for ScanCore's photo texturing, decoded
/// with ImageIO one at a time, and where each shows people (Vision).
struct ScanPhotos: PhotoSource {
    let directory: URL

    /// Person masks are computed on photos this small (Vision's segmentation is coarser anyway)...
    static let maskInputSide = 512
    /// ...and kept at most this many cells across.
    static let maskSide = 192

    func image(for frame: CameraFrame) -> RGBImage? {
        let url = directory.appendingPathComponent(frame.file)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        return Self.rgb(image)
    }

    /// Where the photo shows people — the realtor in a mirror, someone walking through — so the
    /// texturing paints those spots from other photos. The photo is turned upright for Vision
    /// (people are found best standing up) and the mask turned back to the photo's orientation.
    func mask(for frame: CameraFrame) -> PhotoMask? {
        let url = directory.appendingPathComponent(frame.file)
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: Self.maskInputSide,
            kCGImageSourceCreateThumbnailWithTransform: false, kCGImageSourceShouldCache: false,
        ]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let photo = Self.rgb(thumbnail)
        else { return nil }
        let turns = PhotoMask.uprightTurns(for: frame)
        guard let upright = Self.cgImage(photo.rotated(clockwiseTurns: turns)) else { return nil }

        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        do {
            try VNImageRequestHandler(cgImage: upright, orientation: .up, options: [:]).perform([request])
        } catch {
            return nil
        }
        guard let buffer = request.results?.first?.pixelBuffer else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let w = CVPixelBufferGetWidth(buffer), h = CVPixelBufferGetHeight(buffer), row = CVPixelBufferGetBytesPerRow(buffer)
        guard w > 0, h > 0, let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var confidence = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w { confidence[y * w + x] = bytes[y * row + x] }
        }
        let mask = PhotoMask(width: w, height: h, confidence: confidence).shrunk(toFit: Self.maskSide).rotated(clockwiseTurns: 4 - turns)
        return mask.isEmpty ? nil : mask
    }

    /// 8-bit RGB pixels of an image.
    static func rgb(_ image: CGImage) -> RGBImage? {
        let w = image.width, h = image.height
        guard w > 1, h > 1, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let drawn = rgba.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        var rgb = [UInt8](repeating: 0, count: w * h * 3)
        for i in 0..<(w * h) {
            rgb[i * 3] = rgba[i * 4]
            rgb[i * 3 + 1] = rgba[i * 4 + 1]
            rgb[i * 3 + 2] = rgba[i * 4 + 2]
        }
        return RGBImage(width: w, height: h, pixels: rgb)
    }

    /// An sRGB image of 8-bit RGB pixels.
    static func cgImage(_ image: RGBImage) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB), let provider = CGDataProvider(data: Data(image.pixels) as CFData) else { return nil }
        return CGImage(
            width: image.width, height: image.height, bitsPerComponent: 8, bitsPerPixel: 24, bytesPerRow: image.width * 3, space: space,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil, shouldInterpolate: false,
            intent: .defaultIntent)
    }

    /// Photo atlases go into the .glb as JPEG (a fraction of PNG's size for photos).
    static let encodeJPEG: ImageEncoder = { image in
        guard let cg = ScanPhotos.cgImage(image) else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (data as Data, "image/jpeg")
    }
}
