import Foundation
import XCTest

@testable import AtriumScanCore

/// What a photo scan hands the cloud for a photoreal walkthrough: every photo's camera as painted,
/// and points on the painted surfaces in their painted colors.
final class PhotorealExportTests: XCTestCase {
    static func process() throws -> (scan: CaptureScan, result: ProcessedScan) {
        var scan = PhotoTexturingTests.room()
        scan.frames = PhotoTexturingTests.frames()
        let result = try ScanProcessor.process(
            scan, options: ScanProcessorOptions(normalizeFrame: false), photos: PhotoTexturingTests.Raycast(),
            photoOptions: PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.02, depthWidth: 160))
        return (scan, result)
    }

    /// The seeds' positions, normals and colors from the PLY.
    static func seeds(_ data: Data) throws -> [(p: Vec3, n: Vec3, c: (UInt8, UInt8, UInt8))] {
        let marker = Data("end_header\n".utf8)
        let end = try XCTUnwrap(data.range(of: marker)).upperBound
        let header = String(decoding: data[..<end], as: UTF8.self)
        let count = try XCTUnwrap(header.split(separator: "\n").first { $0.hasPrefix("element vertex") }.flatMap { Int($0.split(separator: " ").last ?? "") })
        let bytes = [UInt8](data[end...])
        XCTAssertEqual(bytes.count, count * 27)
        func float(_ o: Int) -> Float { Float(bitPattern: UInt32(bytes[o]) | UInt32(bytes[o + 1]) << 8 | UInt32(bytes[o + 2]) << 16 | UInt32(bytes[o + 3]) << 24) }
        return (0..<count).map { i in
            let o = i * 27
            return (Vec3(float(o), float(o + 4), float(o + 8)), Vec3(float(o + 12), float(o + 16), float(o + 20)), (bytes[o + 24], bytes[o + 25], bytes[o + 26]))
        }
    }

    func testEveryPhotosCameraIsExportedAsPainted() throws {
        let (scan, result) = try Self.process()
        let export = try XCTUnwrap(result.photoreal)
        let doc = try XCTUnwrap(JSONSerialization.jsonObject(with: export.cameras) as? [String: Any])
        XCTAssertEqual(doc["format"] as? String, PhotorealExport.format)
        let frames = try XCTUnwrap(doc["frames"] as? [[String: Any]])
        XCTAssertEqual(frames.count, scan.frames.count)
        let poses = try XCTUnwrap(result.photoPoses)
        for (k, frame) in frames.enumerated() {
            XCTAssertEqual(frame["file"] as? String, scan.frames[k].file)
            // The test photos: 320 × 240 with a 230-pixel focal length.
            XCTAssertEqual(frame["width"] as? Int, 320)
            XCTAssertEqual(try XCTUnwrap(frame["fx"] as? Double), 230, accuracy: 1e-4)
            XCTAssertEqual(try XCTUnwrap(frame["cy"] as? Double), 120, accuracy: 1e-4)
            let pose = try XCTUnwrap(frame["pose"] as? [Double])
            XCTAssertEqual(pose.count, 16)
            for i in 0..<16 { XCTAssertEqual(pose[i], Double(poses[k].m[i]), accuracy: 1e-6, "the pose as painted, after lining up") }
        }
        let bounds = try XCTUnwrap(doc["bounds"] as? [String: [Double]])
        XCTAssertEqual(bounds["min"] ?? [], [0, 0, 0])
        XCTAssertEqual(bounds["max"] ?? [], [4, 2.5, 3])
        XCTAssertEqual((doc["rooms"] as? [Any])?.count, 1)
    }

    func testSeedsLieOnThePaintedSurfacesInTheirColors() throws {
        let (_, result) = try Self.process()
        let export = try XCTUnwrap(result.photoreal)
        let seeds = try Self.seeds(export.seeds)
        XCTAssertEqual(seeds.count, export.seedCount)
        // The insides of the walls, floor, ceiling and the cabinet (about 62 m² at 3 cm), but for
        // what no photo saw (under the camera, behind the cabinet).
        XCTAssertGreaterThan(seeds.count, 35_000)
        XCTAssertLessThan(seeds.count, 69_000)
        let size = PhotoTexturingTests.size, cabinet = PhotoTexturingTests.cabinet
        var errors: [Float] = []
        for s in seeds {
            // On the room's or the cabinet's surface (the walls are painted on their inside faces).
            let onRoom = [s.p.x, size.x - s.p.x, s.p.y, size.y - s.p.y, s.p.z, size.z - s.p.z].contains { abs($0) < 0.005 }
            let inCabinet = (0..<3).allSatisfy { s.p[$0] > cabinet.lo[$0] - 0.005 && s.p[$0] < cabinet.hi[$0] + 0.005 }
            XCTAssertTrue(onRoom || inCabinet, "seed off every surface: \(s.p)")
            XCTAssertEqual(vlength(s.n), 1, accuracy: 1e-3)
            // Only spots well clear of the cabinet's outline, where one color is expected.
            let nearCabinet = (0..<3).allSatisfy { s.p[$0] > cabinet.lo[$0] - 0.05 && s.p[$0] < cabinet.hi[$0] + 0.05 }
            guard !nearCabinet || inCabinet && (0..<3).filter({ s.p[$0] > cabinet.lo[$0] + 0.03 && s.p[$0] < cabinet.hi[$0] - 0.03 }).count == 2 else { continue }
            let want = inCabinet ? PhotoTexturingTests.magenta : PhotoTexturingTests.color(at: s.p)
            errors.append(max(abs(Float(s.c.0) - want.0), abs(Float(s.c.1) - want.1), abs(Float(s.c.2) - want.2)))
        }
        errors.sort()
        XCTAssertLessThan(errors[errors.count / 2], 10, "seeds in their painted colors")
    }

    func testPeopleMasksBecomePNGs() {
        let mask = PhotoMask(width: 3, height: 2, pixels: [true, false, false, false, false, true])
        let png = [UInt8](mask.png())
        XCTAssertEqual(Array(png.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
        // IHDR: width and height, big-endian.
        XCTAssertEqual(Array(png[16..<24]), [0, 0, 0, 3, 0, 0, 0, 2])
    }
}
