import Foundation
import XCTest

@testable import AtriumScanCore

/// Photos are taken when the phone moves slowly enough for them to come out sharp, and smeared ones
/// count for less on the coverage map.
final class PhotoSharpnessTests: XCTestCase {
    func testSmearIsTurnRateTimesExposureTimesFocalLength() {
        // ARKit's 1920 px photos have a focal length of about 1450 px; 1/60 s indoors.
        XCTAssertEqual(PhotoSharpness.smear(turnRate: 0.2, speed: nil, exposure: 1.0 / 60, fx: 1450), 0.2 / 60 * 1450, accuracy: 1e-4)
        // Walking at 0.3 m/s past things 1.5 m away smears as much as turning at 0.2 rad/s.
        XCTAssertEqual(
            PhotoSharpness.smear(turnRate: 0, speed: 0.3, exposure: 1.0 / 60, fx: 1450),
            PhotoSharpness.smear(turnRate: 0.2, speed: nil, exposure: 1.0 / 60, fx: 1450), accuracy: 1e-4)
        // Both at once add up like a vector's sides.
        XCTAssertEqual(PhotoSharpness.smear(turnRate: 0.2, speed: 0.3, exposure: 1.0 / 60, fx: 1450), 0.2 / 60 * 1450 * Float(2).squareRoot(), accuracy: 1e-3)
        // Without an exposure time: PhotoTexturing's 1/50 s.
        XCTAssertEqual(PhotoSharpness.smear(turnRate: 0.1, speed: nil, exposure: nil, fx: 1000), 0.1 * 0.02 * 1000, accuracy: 1e-4)
        XCTAssertEqual(PhotoSharpness.smear(turnRate: .nan, speed: .infinity, exposure: 1.0 / 60, fx: 1450), 0)
    }

    func testThePhoneWaitsForASteadyMomentThenSettlesForASoftPhoto() {
        XCTAssertEqual(PhotoSharpness.decide(smear: 2.5, waited: 0), .sharp)
        XCTAssertNil(PhotoSharpness.decide(smear: 4.8, waited: 1), "a slow turn indoors: wait for a steadier moment")
        XCTAssertEqual(PhotoSharpness.decide(smear: 4.8, waited: PhotoSharpness.patience), .soft)
        XCTAssertNil(PhotoSharpness.decide(smear: 20, waited: 60), "never a smeared photo, however long it waits")
    }

    func testAFramesSmearUsesItsSavedSize() {
        // Sensor intrinsics at 3840 px, photo saved at 1920: half the focal length in pixels.
        let frame = CameraFrame(
            file: "f.jpg", t: 0, transform: .identity, intrinsics: [2900, 0, 0, 0, 2900, 0, 1920, 1440, 1], width: 3840, height: 2880, imageWidth: 1920,
            imageHeight: 1440, angularSpeed: 0.2, exposureDuration: 1.0 / 60, linearSpeed: 0)
        XCTAssertEqual(frame.smearPixels ?? -1, 0.2 / 60 * 1450, accuracy: 1e-3)
        var old = frame
        old.angularSpeed = nil
        XCTAssertNil(old.smearPixels, "scans from before the turn rate was recorded")
    }

    func testLinearSpeedRoundTripsAndOldFramesStillDecode() throws {
        let frame = CameraFrame(
            file: "f.jpg", t: 1, transform: .identity, intrinsics: [1450, 0, 0, 0, 1450, 0, 960, 720, 1], width: 1920, height: 1440, imageWidth: 1920,
            imageHeight: 1440, angularSpeed: 0.1, exposureDuration: 1.0 / 60, linearSpeed: 0.25)
        let back = try JSONDecoder().decode(CameraFrame.self, from: JSONEncoder().encode(frame))
        XCTAssertEqual(back, frame)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(frame)) as? [String: Any])
        json.removeValue(forKey: "linearSpeed")
        let old = try JSONDecoder().decode(CameraFrame.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(old.linearSpeed)
    }

    func testSmearedPhotosCoverWeaklyOrNotAtAll() throws {
        func photo(turning rate: Float?) -> CameraFrame {
            var p = CaptureCoverageTests.photo(Vec3(1.8, 1.4, 2.2), yaw: 0, pitch: 0.25)
            p.angularSpeed = rate
            p.exposureDuration = 1.0 / 60
            return p
        }
        // The test photos are 320 px across with a 230 px focal length: 3 px is about 0.78 rad/s at 1/60 s.
        func front(_ p: CameraFrame) throws -> [CaptureCoverage.Level] {
            let coverage = CaptureCoverage.compute(CaptureCoverageTests.part(), photos: [p])
            return try XCTUnwrap(CaptureCoverageTests.wall(coverage, atZ: 0)).levels.compactMap { $0 }
        }
        let sharp = try front(photo(turning: 0.2)), soft = try front(photo(turning: 1.2)), smeared = try front(photo(turning: 3))
        let unknown = try front(photo(turning: nil))
        XCTAssertTrue(sharp.contains(.good))
        XCTAssertEqual(unknown, sharp, "photos from before turn rates were recorded count as before")
        XCTAssertFalse(soft.contains(.good), "a soft photo covers weakly: \(soft)")
        XCTAssertTrue(soft.contains(.weak))
        XCTAssertTrue(smeared.allSatisfy { $0 == .missing }, "a smeared photo doesn't cover: \(smeared)")
    }
}
