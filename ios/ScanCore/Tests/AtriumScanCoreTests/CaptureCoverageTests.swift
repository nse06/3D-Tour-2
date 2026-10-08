import Foundation
import XCTest

@testable import AtriumScanCore

/// The capture screen's coverage map: which walls, floor and furniture the photos taken so far cover.
final class CaptureCoverageTests: XCTestCase {
    static func part() -> RoomPart {
        let scan = PhotoTexturingTests.room()
        return RoomPart(room: scan.rooms[0], walls: scan.walls, objects: scan.objects)
    }

    /// A photo from `position`, turned `yaw` about the vertical (0: looking along −z) and tilted down by `pitch`.
    static func photo(_ position: Vec3, yaw: Float, pitch: Float = 0) -> CameraFrame {
        let c = cos(-pitch), s = sin(-pitch)
        let tilt = Transform(columnMajor: [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1])
        let pose = Transform.translating(position) * Transform.rotationY(yaw) * tilt
        return CameraFrame(
            file: "f.jpg", t: 0, transform: pose, intrinsics: [230, 0, 0, 0, 230, 0, 160, 120, 1], width: 320, height: 240, imageWidth: 320, imageHeight: 240)
    }

    /// The wall whose stretches lie along z ≈ `z`.
    static func wall(_ coverage: CaptureCoverage, atZ z: Double) -> CaptureCoverage.Wall? {
        coverage.walls.first { abs($0.a.y - z) < 0.05 && abs($0.b.y - z) < 0.05 }
    }

    func testNothingIsCoveredBeforeAnyPhoto() {
        let coverage = CaptureCoverage.compute(Self.part(), photos: [])
        XCTAssertEqual(coverage.walls.count, 4)
        XCTAssertFalse(coverage.floor.isEmpty)
        XCTAssertEqual(coverage.items.count, 1)
        XCTAssertEqual(coverage.wallShare, 0)
        XCTAssertEqual(coverage.floorShare, 0)
        XCTAssertTrue(coverage.walls.allSatisfy { $0.levels.compactMap { $0 }.allSatisfy { $0 == .missing } })
    }

    func testAPhotoCoversTheWallItFacesNotTheOneBehind() throws {
        // From the middle of the room, looking at the z = 0 wall, tilted down a little.
        let coverage = CaptureCoverage.compute(Self.part(), photos: [Self.photo(Vec3(1.8, 1.4, 2.2), yaw: 0, pitch: 0.25)])
        let front = try XCTUnwrap(Self.wall(coverage, atZ: 0)), back = try XCTUnwrap(Self.wall(coverage, atZ: 3))
        let good = front.levels.filter { $0 == .good }.count
        XCTAssertGreaterThan(Double(good) / Double(front.levels.count), 0.5, "most of the wall it faces: \(front.levels)")
        XCTAssertTrue(back.levels.compactMap { $0 }.allSatisfy { $0 == .missing }, "nothing behind the phone")
        // The floor in front of the phone, not behind it.
        let seen = coverage.floor.filter { $0.level != .missing }
        XCTAssertFalse(seen.isEmpty)
        XCTAssertTrue(seen.allSatisfy { $0.center.y < 2.2 }, "only floor ahead of the phone")
    }

    func testWallsHideWhatIsBehindThem() throws {
        // Outside the room, behind the z = 3 wall, looking in: the wall is in the way of everything.
        let coverage = CaptureCoverage.compute(Self.part(), photos: [Self.photo(Vec3(2, 1.4, 4.5), yaw: 0)])
        let front = try XCTUnwrap(Self.wall(coverage, atZ: 0))
        XCTAssertTrue(front.levels.compactMap { $0 }.allSatisfy { $0 == .missing }, "\(front.levels)")
        XCTAssertTrue(coverage.floor.allSatisfy { $0.level == .missing })
    }

    func testTurningAroundTheRoomCoversItsWalls() {
        let part = Self.part()
        let few = CaptureCoverage.compute(part, photos: Array(PhotoTexturingTests.frames().prefix(3)))
        let all = CaptureCoverage.compute(part, photos: PhotoTexturingTests.frames())
        XCTAssertGreaterThan(all.wallShare ?? 0, 0.75)
        XCTAssertGreaterThan(all.wallShare ?? 0, few.wallShare ?? 0)
        XCTAssertGreaterThan(all.floorShare ?? 0, few.floorShare ?? 0)
        // The cabinet is seen, though only from above its top's height and off to the side: weakly.
        XCTAssertEqual(all.items.first?.level, .weak)
        XCTAssertEqual(few.items.first?.level, CaptureCoverage.Level.missing, "not by the first photos")
    }

    func testTheWallBehindAWardrobeNeedsNoPhoto() throws {
        // A wardrobe against the z = 3 wall: 1.2 m wide (x 1–2.2), 2 m tall.
        var part = Self.part()
        part.objects.append(
            ScanObject(id: "O2", roomId: part.room.id, category: "storage", transform: .translating(Vec3(1.6, 1, 2.675)), size: Vec3(1.2, 2, 0.55)))
        let coverage = CaptureCoverage.compute(part, photos: PhotoTexturingTests.frames())
        let back = try XCTUnwrap(Self.wall(coverage, atZ: 3))
        let hidden = back.levels.indices.filter { back.levels[$0] == nil }
        let xs = hidden.map { back.a.x + (back.b.x - back.a.x) * (Double($0) + 0.5) / Double(back.levels.count) }
        XCTAssertEqual(hidden.count, 5, "the stretches behind it: \(back.levels)")
        XCTAssertTrue(xs.allSatisfy { $0 > 1 && $0 < 2.2 }, "and only those: \(xs)")
        XCTAssertEqual(coverage.items.count, 2)
    }

    func testSidesAgainstOtherFurnitureNeedNoPhoto() {
        // Three kitchen cabinets in a row along the z = 0 wall, photographed from in front of the middle one.
        var part = Self.part()
        part.objects = (0..<3).map { k in
            ScanObject(
                id: "C\(k)", roomId: part.room.id, category: "storage", transform: .translating(Vec3(1.3 + 0.6 * Float(k), 0.45, 0.35)), size: Vec3(0.6, 0.9, 0.6))
        }
        let photos = [Self.photo(Vec3(1.9, 1.45, 1.6), yaw: 0, pitch: 0.7)]
        let row = CaptureCoverage.compute(part, photos: photos)
        XCTAssertEqual(row.items.count, 3)
        XCTAssertEqual(row.items[1].level, .good, "judged by its front and top: its sides touch its neighbours")
        // On its own, its bare sides show, and no photo has seen them.
        part.objects = [part.objects[1]]
        let alone = CaptureCoverage.compute(part, photos: photos)
        XCTAssertEqual(alone.items.first?.level, CaptureCoverage.Level.missing)
    }
}
