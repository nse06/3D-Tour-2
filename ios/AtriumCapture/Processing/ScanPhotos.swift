import AtriumScanCore
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The scan's photos (frames/*.jpg) for ScanCore's photo texturing, decoded
/// with ImageIO one at a time.
struct ScanPhotos: PhotoSource {
    let directory: URL

    func image(for frame: CameraFrame) -> RGBImage? {
        let url = directory.appendingPathComponent(frame.file)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
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

    /// Photo atlases go into the .glb as JPEG (a fraction of PNG's size for photos).
    static let encodeJPEG: ImageEncoder = { image in
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let provider = CGDataProvider(data: Data(image.pixels) as CFData),
              let cg = CGImage(
                width: image.width, height: image.height, bitsPerComponent: 8, bitsPerPixel: 24, bytesPerRow: image.width * 3, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil, shouldInterpolate: false,
                intent: .defaultIntent)
        else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (data as Data, "image/jpeg")
    }
}
