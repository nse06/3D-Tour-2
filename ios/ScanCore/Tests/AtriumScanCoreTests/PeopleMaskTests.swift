import Foundation
import XCTest

@testable import AtriumScanCore

/// People in the photos: the realtor's reflection, someone walking ahead. Their masks keep them
/// off the model; a spot every photo flags (a poster) is still painted.
final class PeopleMaskTests: XCTestCase {
    /// Raycast photos of the plain test room with someone standing 1.1 m in front of the camera in
    /// every photo — always somewhere else, like a reflection that moves with the phone. Optionally
    /// a poster on the wall at z = 0 that the person detector flags in every photo.
    struct Crowd: PhotoSource {
        var poses = Dictionary(uniqueKeysWithValues: PeopleMaskTests.frames.map { ($0.file, $0.transform) })
        var people = true
        var poster = false
        var masks = true
        static let green: (Float, Float, Float) = (40, 220, 60)
        static let cyan: (Float, Float, Float) = (30, 190, 215)
        /// On the wall at z = 0: x from 0.6 to 1.4 m, y from 1.0 to 1.8 m.
        static let posterArea = (x0: Float(0.6), x1: Float(1.4), y0: Float(1.0), y1: Float(1.8))
        static let radius: Float = 0.22, height: Float = 1.75

        /// Where the person stands in a photo taken from `pose`.
        static func person(_ pose: Transform) -> SIMD2<Float> {
            let f = -pose.zAxis
            let flat = SIMD2<Float>(f.x, f.z) / max(1e-6, (f.x * f.x + f.z * f.z).squareRoot())
            return SIMD2(pose.translation.x, pose.translation.z) + flat * 1.1
        }

        static func onPoster(_ p: Vec3) -> Bool {
            p.z < 0.001 && p.x > posterArea.x0 && p.x < posterArea.x1 && p.y > posterArea.y0 && p.y < posterArea.y1
        }

        /// The color a ray sees, and whether the person detector flags it.
        func trace(_ pose: Transform, _ d: Vec3) -> (color: (Float, Float, Float), flagged: Bool) {
            let o = pose.translation
            let hit = PhotoTexturingTests.hit(from: o, d)
            if people {
                // The person: a vertical cylinder on the floor (no caps: the camera is below its top).
                let c = Self.person(pose)
                let ox = o.x - c.x, oz = o.z - c.y
                let a = d.x * d.x + d.z * d.z, b = 2 * (ox * d.x + oz * d.z), cc = ox * ox + oz * oz - Self.radius * Self.radius
                let disc = b * b - 4 * a * cc
                if a > 1e-9, disc >= 0 {
                    let s = (-b - disc.squareRoot()) / (2 * a)
                    let y = o.y + s * d.y
                    if s > 0, y >= 0, y <= Self.height, s < vlength(hit.point - o) { return (Self.green, true) }
                }
            }
            if hit.cabinet { return (PhotoTexturingTests.magenta, false) }
            if poster && Self.onPoster(hit.point) { return (Self.cyan, true) }
            return (PhotoTexturingTests.Raycast.paint, false)
        }

        func ray(_ frame: CameraFrame, _ pose: Transform, _ u: Float, _ v: Float) -> Vec3 {
            let k = frame.intrinsics
            return vnormalize(pose.applyDirection(Vec3((u - k[6]) / k[0], -(v - k[7]) / k[4], -1)))
        }

        func image(for frame: CameraFrame) -> RGBImage? {
            guard let pose = poses[frame.file] else { return nil }
            let w = frame.imageWidth, h = frame.imageHeight
            var pixels = [UInt8](repeating: 0, count: w * h * 3)
            for v in 0..<h {
                for u in 0..<w {
                    let (r, g, b) = trace(pose, ray(frame, pose, Float(u) + 0.5, Float(v) + 0.5)).color
                    let i = (v * w + u) * 3
                    pixels[i] = UInt8(r)
                    pixels[i + 1] = UInt8(g)
                    pixels[i + 2] = UInt8(b)
                }
            }
            return RGBImage(width: w, height: h, pixels: pixels)
        }

        /// A quarter of the photo's resolution, like a segmentation model's output.
        func mask(for frame: CameraFrame) -> PhotoMask? {
            guard masks, let pose = poses[frame.file] else { return nil }
            let w = frame.imageWidth / 4, h = frame.imageHeight / 4
            var cells = [Bool](repeating: false, count: w * h)
            for y in 0..<h {
                for x in 0..<w {
                    cells[y * w + x] = trace(pose, ray(frame, pose, (Float(x) + 0.5) * 4, (Float(y) + 0.5) * 4)).flagged
                }
            }
            return PhotoMask(width: w, height: h, pixels: cells)
        }
    }

    /// The test room's photos from the middle, and from a second spot near the cabinet.
    static let frames = PhotoTexturingTests.frames() + PhotoTexturingTests.frames(at: Vec3(3.2, 1.45, 1.2), prefix: "b")

    struct Bake {
        let model: PhotoModel
        let baked: PhotoBaker.Result
        let options: PhotoTexturingOptions

        func pixel(_ c: PhotoChart, _ i: Int, _ j: Int) -> SIMD3<Float> {
            let a = ((c.y + j) * options.atlasSize + c.x + i) * 3, px = baked.atlases[c.atlas].pixels
            return SIMD3(Float(px[a]), Float(px[a + 1]), Float(px[a + 2]))
        }
    }

    func bake(_ source: Crowd, frames: [CameraFrame] = PhotoTexturingTests.frames()) throws -> Bake {
        var scan = PhotoTexturingTests.room()
        scan.frames = frames
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        model.measureCharts()
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.02, depthWidth: 160)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        return Bake(model: model, baked: PhotoBaker.bake(model: model, cameras: cameras, photos: source, atlasCount: atlases, options: options), options: options)
    }

    /// Texels of the room's walls and floor that show the person (green).
    func personTexels(_ b: Bake) -> Int {
        var count = 0
        for (ci, chart) in b.model.charts.enumerated() where !chart.isSolid && chart.kind != .object {
            for j in 0..<chart.h {
                for i in 0..<chart.w where b.baked.seen[ci][j * chart.w + i] {
                    let c = b.pixel(chart, i, j)
                    if c.y - c.x > 25 && c.y - c.z > 25 { count += 1 }
                }
            }
        }
        return count
    }

    func testPeopleArePaintedFromOtherPhotos() throws {
        let unmasked = try bake(Crowd(masks: false))
        let masked = try bake(Crowd())
        let before = personTexels(unmasked), after = personTexels(masked)
        // Without masks the person lands on the walls and floor behind them in every photo.
        XCTAssertGreaterThan(before, 300, "the person should show up without masks")
        // With them, none: what's behind the person comes from the photos next to it, and the floor only
        // one photo saw (right behind the person) is filled in from around it.
        XCTAssertLessThan(after, 20, "person texels: \(before) unmasked → \(after) masked")
        XCTAssertEqual(masked.baked.photosWithPeople, 24)
        XCTAssertEqual(unmasked.baked.photosWithPeople, 0)
        // The spots behind the person come from the neighbouring photos: coverage stays.
        XCTAssertGreaterThan(masked.baked.coverage, unmasked.baked.coverage - 0.05, "coverage \(unmasked.baked.coverage) → \(masked.baked.coverage)")
    }

    func testASpotFlaggedInEveryPhotoIsStillPainted() throws {
        // A poster the person detector flags in every photo is part of the home: photos from two spots
        // show it in the same place, and none shows what's behind it, so the flagged photos paint it.
        let b = try bake(Crowd(people: false, poster: true), frames: Self.frames)
        let area = Crowd.posterArea
        var inside = 0, cyan = 0
        for (ci, chart) in b.model.charts.enumerated() where chart.kind == .wall {
            for j in 0..<chart.h {
                for i in 0..<chart.w where b.baked.seen[ci][j * chart.w + i] {
                    let p = chart.point(i, j)
                    guard p.z < 0.01, p.x > area.x0 + 0.05, p.x < area.x1 - 0.05, p.y > area.y0 + 0.05, p.y < area.y1 - 0.05 else { continue }
                    inside += 1
                    let c = b.pixel(chart, i, j)
                    if abs(c.x - Crowd.cyan.0) < 20 && abs(c.y - Crowd.cyan.1) < 20 && abs(c.z - Crowd.cyan.2) < 20 { cyan += 1 }
                }
            }
        }
        XCTAssertGreaterThan(inside, 200)
        XCTAssertGreaterThan(Double(cyan) / Double(inside), 0.95, "\(cyan) of \(inside) poster texels show the poster")
    }

    func testMasksTurnWithThePhoto() {
        // 4 × 3, one cell set at (3, 0): the top-right corner.
        var cells = [Bool](repeating: false, count: 12)
        cells[3] = true
        let mask = PhotoMask(width: 4, height: 3, pixels: cells)
        let turned = mask.rotated(clockwiseTurns: 1)
        XCTAssertEqual(turned.width, 3)
        XCTAssertEqual(turned.height, 4)
        // A clockwise turn takes the top-right corner to the bottom-right.
        XCTAssertEqual(turned.pixels.firstIndex(of: true), 3 * 3 + 2)
        XCTAssertEqual(mask.rotated(clockwiseTurns: 2).pixels.firstIndex(of: true), 2 * 4 + 0)
        XCTAssertEqual(mask.rotated(clockwiseTurns: 3).pixels.firstIndex(of: true), 0)
        XCTAssertEqual(turned.rotated(clockwiseTurns: 3), mask)
        XCTAssertEqual(mask.rotated(clockwiseTurns: 4), mask)

        // Photos turn the same way as masks.
        let image = RGBImage(width: 4, height: 3, pixels: (0..<12).flatMap { [UInt8($0), 0, UInt8(255 - $0)] })
        let turnedImage = image.rotated(clockwiseTurns: 1)
        XCTAssertEqual(turnedImage.width, 3)
        XCTAssertEqual(turnedImage.pixels[(3 * 3 + 2) * 3], 3, "pixel 3 lands where the mask's cell 3 did")
        XCTAssertEqual(turnedImage.rotated(clockwiseTurns: 3).pixels, image.pixels)

        // Upright: how the phone was held.
        func frame(right: Vec3, up: Vec3) -> CameraFrame {
            let back = vcross(right, up)
            let t = Transform(columnMajor: [right.x, right.y, right.z, 0, up.x, up.y, up.z, 0, back.x, back.y, back.z, 0, 0, 1.4, 0, 1])
            return CameraFrame(file: "f.jpg", t: 0, transform: t, intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1], width: 4, height: 3, imageWidth: 4, imageHeight: 3)
        }
        // Landscape with the sensor's top up; portrait (the sensor's right edge points at the floor);
        // and both upside down.
        XCTAssertEqual(PhotoMask.uprightTurns(for: frame(right: Vec3(1, 0, 0), up: Vec3(0, 1, 0))), 0)
        XCTAssertEqual(PhotoMask.uprightTurns(for: frame(right: Vec3(0, -1, 0), up: Vec3(1, 0, 0))), 1)
        XCTAssertEqual(PhotoMask.uprightTurns(for: frame(right: Vec3(-1, 0, 0), up: Vec3(0, -1, 0))), 2)
        XCTAssertEqual(PhotoMask.uprightTurns(for: frame(right: Vec3(0, 1, 0), up: Vec3(-1, 0, 0))), 3)
        // Portrait, tilted down at the floor; and straight down.
        let tilt: Float = 1.2
        XCTAssertEqual(PhotoMask.uprightTurns(for: frame(right: Vec3(0, -cos(tilt), sin(tilt)), up: Vec3(1, 0, 0))), 1)
        XCTAssertEqual(PhotoMask.uprightTurns(for: frame(right: Vec3(0, 0, 1), up: Vec3(1, 0, 0))), 1)

        // Turning a photo upright and its upright mask back lines the mask up with the photo.
        let portrait = frame(right: Vec3(0, -1, 0), up: Vec3(1, 0, 0))
        let k = PhotoMask.uprightTurns(for: portrait)
        let upright = mask.rotated(clockwiseTurns: k)
        XCTAssertEqual(upright.rotated(clockwiseTurns: 4 - k), mask)
    }

    func testMasksGrowAndShrink() {
        var cells = [Bool](repeating: false, count: 10 * 8)
        cells[4 * 10 + 5] = true
        let grown = PhotoMask(width: 10, height: 8, pixels: cells).dilated(by: 2)
        XCTAssertEqual(grown.pixels.filter { $0 }.count, 25)
        XCTAssertTrue(grown.pixels[2 * 10 + 3] && grown.pixels[6 * 10 + 7])
        XCTAssertFalse(grown.pixels[1 * 10 + 5] || grown.pixels[4 * 10 + 8])

        // 512 × 384 → 128 × 96: a cell is masked if any of its pixels was.
        var big = [Bool](repeating: false, count: 512 * 384)
        big[100 * 512 + 203] = true
        let small = PhotoMask(width: 512, height: 384, pixels: big).shrunk(toFit: 128)
        XCTAssertEqual(small.width, 128)
        XCTAssertEqual(small.height, 96)
        XCTAssertEqual(small.pixels.firstIndex(of: true), 25 * 128 + 50)
        // Any photo resolution maps onto the mask.
        XCTAssertTrue(small.covers(u: 203 * 3.75, v: 100 * 3.75, width: 1920, height: 1440))
        XCTAssertFalse(small.covers(u: 10, v: 10, width: 1920, height: 1440))
        XCTAssertEqual(PhotoMask(width: 2, height: 1, confidence: [10, 200]).pixels, [false, true])
    }
}
