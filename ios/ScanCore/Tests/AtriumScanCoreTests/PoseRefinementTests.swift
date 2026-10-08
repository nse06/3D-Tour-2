import Foundation
import XCTest

@testable import AtriumScanCore

/// Photo alignment: the pose gradient against finite differences, and drifted photos of the
/// patterned test room lined up again.
final class PoseRefinementTests: XCTestCase {
    func testGradientMatchesFiniteDifferences() throws {
        let frame = PhotoTexturingTests.frames()[5]
        let camera = try XCTUnwrap(PhotoCamera(frame, depthWidth: 64))
        let pose = PoseRefinement.Pose(position: camera.position, right: camera.right, up: camera.up, back: camera.back)
        // A point the photo shows, off its center.
        let point = camera.position + camera.back * -2.2 + camera.right * 0.6 + camera.up * -0.35
        func pixel(_ p: PoseRefinement.Pose) -> (Float, Float) {
            let d = point - p.position
            let z = -vdot(d, p.back)
            return (camera.fx * vdot(d, p.right) / z + camera.cx, -camera.fy * vdot(d, p.up) / z + camera.cy)
        }
        let alongU = PoseRefinement.gradient(du: 1, dv: 0, camera: camera, pose: pose, point: point)
        let alongV = PoseRefinement.gradient(du: 0, dv: 1, camera: camera, pose: pose, point: point)
        let h: Float = 1e-3
        for axis in 0..<3 {
            var e = Vec3(0, 0, 0)
            e[axis] = h
            var moved = pose
            moved.position = pose.position + e
            let (u0, v0) = pixel(pose), (u1, v1) = pixel(moved), (u2, v2) = pixel(pose.turned(by: e))
            XCTAssertEqual((u1 - u0) / h, alongU.shift[axis], accuracy: 0.02 * max(1, abs(alongU.shift[axis])), "du/dshift \(axis)")
            XCTAssertEqual((v1 - v0) / h, alongV.shift[axis], accuracy: 0.02 * max(1, abs(alongV.shift[axis])), "dv/dshift \(axis)")
            XCTAssertEqual((u2 - u0) / h, alongU.turn[axis], accuracy: 0.02 * max(1, abs(alongU.turn[axis])), "du/dturn \(axis)")
            XCTAssertEqual((v2 - v0) / h, alongV.turn[axis], accuracy: 0.02 * max(1, abs(alongV.turn[axis])), "dv/dturn \(axis)")
        }
    }

    /// How far, on average, points 1.5–4 m in front of each photo land from where they should
    /// (pixels), between true poses and `poses`.
    static func misregistration(_ frames: [CameraFrame], _ poses: [Transform]) -> Float {
        var total: Float = 0, count = 0
        for (f, t) in zip(frames, poses) {
            guard let truth = PhotoCamera(f, depthWidth: 8) else { continue }
            var g = f
            g.transform = t
            guard let guess = PhotoCamera(g, depthWidth: 8) else { continue }
            for depth: Float in [1.5, 2.5, 4] {
                for fu: Float in [0.15, 0.5, 0.85] {
                    for fv: Float in [0.2, 0.5, 0.8] {
                        let u = fu * Float(truth.width), v = fv * Float(truth.height)
                        let p = truth.position + truth.right * ((u - truth.cx) / truth.fx * depth) + truth.up * (-(v - truth.cy) / truth.fy * depth) - truth.back * depth
                        guard let q = guess.project(p) else { continue }
                        total += ((q.u - u) * (q.u - u) + (q.v - v) * (q.v - v)).squareRoot()
                        count += 1
                    }
                }
            }
        }
        return total / Float(max(count, 1))
    }

    func testAlignmentLinesDriftedPhotosUpAgain() throws {
        let scan = PhotoTexturingTests.room()
        // Photos from two spots, so most of the room is seen twice; rendered from their true poses.
        let truth = PhotoTexturingTests.frames() + PhotoTexturingTests.frames(at: Vec3(2.6, 1.4, 1.2), prefix: "b")
        let source = PhotoTexturingTests.Raycast(poses: Dictionary(uniqueKeysWithValues: truth.map { ($0.file, $0.transform) }))
        // The poses the "tracking" reports: up to 2 cm and 0.5° off.
        var drifted = truth
        for (i, f) in truth.enumerated() {
            func r(_ salt: UInt32) -> Float { PhotoTexturingTests.Raycast.hash(f.file, salt) }
            var pose = PoseRefinement.Pose(position: f.transform.translation, right: f.transform.xAxis, up: f.transform.yAxis, back: f.transform.zAxis)
            pose = pose.turned(by: Vec3(r(1), r(2), r(3)) * 0.0087)
            pose.position = pose.position + Vec3(r(4), r(5), r(6)) * 0.02
            drifted[i].transform = Transform(columnMajor: [
                pose.right.x, pose.right.y, pose.right.z, 0, pose.up.x, pose.up.y, pose.up.z, 0, pose.back.x, pose.back.y, pose.back.z, 0,
                pose.position.x, pose.position.y, pose.position.z, 1,
            ])
        }
        let rooms = Layout.rooms(from: scan)
        let walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: 0.12)
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: 0.12, includeCeilings: true)
        model.measureCharts()
        let options = PhotoTexturingOptions(atlasSize: 1024, maxAtlases: 2, texelSize: 0.02, depthWidth: 160)
        let atlases = try XCTUnwrap(PhotoBaker.pack(&model.charts, options: options))
        let cameras = drifted.compactMap { PhotoCamera($0, depthWidth: options.depthWidth) }
        let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: source, atlasCount: atlases, options: options)
        let before = Self.misregistration(truth, drifted.map(\.transform)), after = Self.misregistration(truth, baked.poses)
        print(String(format: "alignment: %d photos, %.2f px → %.2f px off; disagreement %.1f → %.1f levels", baked.alignment.aligned, before, after,
                     baked.alignment.errorBefore, baked.alignment.errorAfter))
        XCTAssertGreaterThan(baked.alignment.aligned, truth.count / 2)
        XCTAssertLessThan(after, before * 0.5)
        XCTAssertLessThan(baked.alignment.errorAfter, baked.alignment.errorBefore)
    }
}
