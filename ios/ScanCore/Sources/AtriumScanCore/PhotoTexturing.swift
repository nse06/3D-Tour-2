import Foundation

// Photo texturing: paints the photos taken while scanning onto the model's
// walls, floors, ceilings and furniture, so the walkthrough shows the real home.
//
// Every textured surface is a flat "chart" with its own patch of a texture
// atlas. Baking runs in two passes so only one photo is decoded at a time:
//   1. geometry only — each chart is split into cells of a few texels, and
//      every cell picks the one photo that shows it best: facing it, close,
//      near the image center, taken with the phone steady, not blocked by
//      other surfaces (a small depth image per photo, rasterized from the
//      model) — leaning toward its neighbours' photo, so a surface becomes a
//      few large patches, each from a single photo (sharp, no double images).
//      Texels blend the photos of the cells around them, which only mixes
//      photos in a narrow band along the seams between patches;
//   2. photo by photo — each photo's pixels are sampled into the texels that
//      chose it. The photos' auto-exposure is evened out where they overlap,
//      and texels no photo saw are filled from their neighbours.

/// Decoded photos for texturing. The iPhone app decodes the scan's JPEGs; tests synthesize images.
public protocol PhotoSource: Sendable {
    /// The photo as 8-bit RGB, rows top to bottom, in the camera sensor's
    /// orientation (the one its intrinsics refer to). Any size; it is matched
    /// to the frame's intrinsics by scaling.
    func image(for frame: CameraFrame) -> RGBImage?
}

/// Encodes an atlas for the .glb: the bytes and their MIME type (PNG by default; the app uses JPEG).
public typealias ImageEncoder = @Sendable (RGBImage) -> (data: Data, mimeType: String)?

public struct PhotoTexturingOptions: Sendable {
    /// Atlas edge length, pixels.
    public var atlasSize: Int
    public var maxAtlases: Int
    /// Wanted texel size, meters; coarsened when the surfaces don't fit in `maxAtlases`.
    public var texelSize: Double
    /// Depth images used for visibility, pixels across.
    public var depthWidth: Int

    public init(atlasSize: Int = 2048, maxAtlases: Int = 4, texelSize: Double = 0.008, depthWidth: Int = 192) {
        self.atlasSize = atlasSize
        self.maxAtlases = maxAtlases
        self.texelSize = texelSize
        self.depthWidth = depthWidth
    }
}

/// A flat textured surface: a rectangle of texels on a plane.
struct PhotoChart {
    enum Kind: Equatable {
        case wall, floor, ceiling, object
        /// One flat color: the typical color of chart `of` (a wall's back, top and ends take its paint color).
        case solid(of: Int)
    }

    let origin: Vec3
    let u: Vec3
    let v: Vec3
    /// Facing the side the surface is seen from.
    let normal: Vec3
    let kind: Kind
    /// Color when no photo saw the surface (sRGB bytes).
    let fallback: (UInt8, UInt8, UInt8)
    var minU = Double.infinity, maxU = -Double.infinity, minV = Double.infinity, maxV = -Double.infinity
    // Placement in the atlas (texels), including padding.
    var atlas = 0, x = 0, y = 0, w = 0, h = 0
    var texel = 0.01

    static let pad = 4
    /// A solid chart's square in the atlas, texels (big enough to stay one color in the mipmaps).
    static let solidSize = 16

    var isSolid: Bool {
        if case .solid = kind { return true }
        return false
    }

    /// World position at texel coordinates (texel i's center is at i + 0.5).
    func point(x: Double, y: Double) -> Vec3 {
        let s = minU + (x - Double(Self.pad)) * texel
        let t = minV + (y - Double(Self.pad)) * texel
        return origin + u * Float(s) + v * Float(t)
    }

    /// World position of texel (i, j) of this chart's rectangle.
    func point(_ i: Int, _ j: Int) -> Vec3 { point(x: Double(i) + 0.5, y: Double(j) + 0.5) }

    /// Atlas UV of a point given in chart meters (a solid chart's center, whatever the point).
    func atlasUV(_ m: SIMD2<Float>, size: Int) -> SIMD2<Float> {
        if isSolid { return SIMD2(Float((Double(x) + Double(w) / 2) / Double(size)), Float((Double(y) + Double(h) / 2) / Double(size))) }
        let col = Double(x + Self.pad) + (Double(m.x) - minU) / texel
        let row = Double(y + Self.pad) + (Double(m.y) - minV) / texel
        return SIMD2(Float(col / Double(size)), Float(row / Double(size)))
    }
}

/// The photo-mode model: every face lies on a chart (material "chart:<index>", UVs in chart meters until baked).
struct PhotoModel {
    var mesh = MeshBuilder()
    var charts: [PhotoChart] = []
    /// Each room's floor chart, by room index (thresholds extend it).
    var floorChart: [Int: Int] = [:]

    static let wallColor: (UInt8, UInt8, UInt8) = (233, 229, 222)
    static let floorColor: (UInt8, UInt8, UInt8) = (176, 150, 118)
    static let ceilingColor: (UInt8, UInt8, UInt8) = (242, 240, 236)
    static let objectColor: (UInt8, UInt8, UInt8) = (150, 140, 128)

    static func chartMaterial(_ index: Int) -> String { "chart:\(index)" }

    /// Each chart's extent, from the faces drawn on it (UVs are chart meters until baked).
    mutating func measureCharts() {
        for i in charts.indices where !charts[i].isSolid {
            guard let buffer = mesh.buffers[Self.chartMaterial(i)] else { continue }
            for k in stride(from: 0, to: buffer.uvs.count, by: 2) {
                let s = Double(buffer.uvs[k]), t = Double(buffer.uvs[k + 1])
                charts[i].minU = min(charts[i].minU, s)
                charts[i].maxU = max(charts[i].maxU, s)
                charts[i].minV = min(charts[i].minV, t)
                charts[i].maxV = max(charts[i].maxV, t)
            }
        }
        // Charts nothing was drawn on take no space.
        for i in charts.indices where !charts[i].minU.isFinite {
            charts[i].minU = 0
            charts[i].maxU = 0
            charts[i].minV = 0
            charts[i].maxV = 0
        }
    }

    mutating func addChart(origin: Vec3, u: Vec3, v: Vec3, normal: Vec3, kind: PhotoChart.Kind) -> Int {
        let fallback: (UInt8, UInt8, UInt8)
        switch kind {
        case .wall: fallback = Self.wallColor
        case .floor: fallback = Self.floorColor
        case .ceiling: fallback = Self.ceilingColor
        case .object: fallback = Self.objectColor
        case let .solid(of): fallback = charts[of].fallback
        }
        charts.append(PhotoChart(origin: origin, u: vnormalize(u), v: vnormalize(v), normal: vnormalize(normal), kind: kind, fallback: fallback))
        return charts.count - 1
    }

    /// A face on a chart, facing `normal` (by default the chart's).
    mutating func addFace(_ points: [Vec3], chart: Int, normal: Vec3? = nil) {
        let c = charts[chart]
        mesh.addFace(points, normal: normal ?? c.normal, material: Self.chartMaterial(chart), uv: .chart(origin: c.origin, u: c.u, v: c.v))
    }

    // MARK: Building

    /// Walls (passages between rooms cut, windows left to the photos), floors,
    /// ceilings, thresholds and furniture.
    static func build(scan: CaptureScan, rooms: [RoomInfo], walls inputWalls: [WallInfo], defaultThickness: Double, includeCeilings: Bool) -> PhotoModel {
        var model = PhotoModel()
        // Only doorways with a room on both sides are holes; other doors and
        // windows stay on the wall, where the photos show them.
        let passages = scan.openings.filter { isPassage($0, rooms: rooms) }
        var walls = inputWalls.map { w -> WallInfo in
            var copy = w
            copy.holes = []
            return copy
        }
        Layout.cutOpenings(passages, into: &walls)
        for w in walls { model.addWall(w) }

        for (i, r) in rooms.enumerated() {
            let lift = Double(i % 8) * 0.0007
            let xs = r.poly.map(\.x), zs = r.poly.map(\.y)
            let floorOrigin = world(P2(xs.min() ?? 0, zs.min() ?? 0), y: r.floorY + lift)
            let floor = model.addChart(origin: floorOrigin, u: Vec3(1, 0, 0), v: Vec3(0, 0, 1), normal: Vec3(0, 1, 0), kind: .floor)
            model.mesh.addPlanPolygon(
                r.poly, y: r.floorY + lift, facingUp: true, material: chartMaterial(floor), uvScale: 1,
                uv: .chart(origin: floorOrigin, u: Vec3(1, 0, 0), v: Vec3(0, 0, 1)))
            model.floorChart[r.index] = floor
            if includeCeilings {
                let ceilingOrigin = world(P2(xs.min() ?? 0, zs.min() ?? 0), y: r.ceilingY)
                let ceiling = model.addChart(origin: ceilingOrigin, u: Vec3(1, 0, 0), v: Vec3(0, 0, 1), normal: Vec3(0, -1, 0), kind: .ceiling)
                model.mesh.addPlanPolygon(
                    r.poly, y: r.ceilingY, facingUp: false, material: chartMaterial(ceiling), uvScale: 1,
                    uv: .chart(origin: ceilingOrigin, u: Vec3(1, 0, 0), v: Vec3(0, 0, 1)))
            }
        }
        model.addThresholds(passages, walls: walls, rooms: rooms)
        // Furniture in parts (a bed's mattress and headboard, a sofa's seat and back), so each
        // photo lands on the surface it shows rather than on the top of one big box.
        for o in scan.objects { Furniture.build(o, walls: walls, into: &model, decor: false) }
        return model
    }

    static func isPassage(_ o: ScanOpening, rooms: [RoomInfo]) -> Bool {
        guard o.kind != .window, o.transform.isFinite, o.width > 0.3 else { return false }
        let u = pnormalize(plan(o.transform.xAxis))
        guard plength(u) > 0.5 else { return false }
        let n = perp(u), mid = plan(o.transform.translation)
        let bottom = Double(o.transform.translation.y - o.height / 2)
        let sides = [mid + n * 0.4, mid - n * 0.4].map { p in rooms.contains { pointInPolygon(p, $0.poly) && abs($0.floorY - bottom) < 0.3 } }
        return sides[0] && sides[1]
    }

    /// The inside face is one chart (pieces between holes share it, so no seams). The faces
    /// photos rarely show well — the back, the top, the ends and the sides of doorways — take
    /// the wall's own color, so they don't stand out as bright strips.
    mutating func addWall(_ w: WallInfo) {
        let t = w.thickness
        let inside = addChart(origin: w.point(s: 0, y: w.y0, depth: 0), u: world(w.u, y: 0), v: Vec3(0, 1, 0), normal: world(w.nIn, y: 0), kind: .wall)
        let edges = addChart(
            origin: w.point(s: 0, y: w.y0, depth: t), u: world(w.u, y: 0), v: Vec3(0, 1, 0), normal: world(-w.nIn, y: 0), kind: .solid(of: inside))
        var cuts = [0.0, w.length]
        for h in w.holes { cuts += [h.s0, h.s1] }
        cuts = WallGeometry.uniqueSorted(cuts.map { clamp($0, 0, w.length) })
        func holes(at s: Double) -> [WallHole] { w.holes.filter { $0.s0 <= s && s <= $0.s1 } }
        func solids(at s: Double) -> [(Double, Double)] { WallGeometry.subtract(holes(at: s).map { ($0.y0, $0.y1) }, from: (w.y0, w.y1)) }
        for k in 0..<(cuts.count - 1) {
            let s0 = cuts[k], s1 = cuts[k + 1]
            guard s1 - s0 > 1e-4 else { continue }
            for (ya, yb) in solids(at: (s0 + s1) / 2) where yb - ya > 1e-4 {
                addFace(
                    [w.point(s: s0, y: ya, depth: 0), w.point(s: s1, y: ya, depth: 0), w.point(s: s1, y: yb, depth: 0), w.point(s: s0, y: yb, depth: 0)],
                    chart: inside)
                addFace(
                    [w.point(s: s0, y: ya, depth: t), w.point(s: s1, y: ya, depth: t), w.point(s: s1, y: yb, depth: t), w.point(s: s0, y: yb, depth: t)],
                    chart: edges)
            }
            if !holes(at: (s0 + s1) / 2).contains(where: { $0.y1 >= w.y1 - 1e-4 }) {
                addFace(
                    [w.point(s: s0, y: w.y1, depth: 0), w.point(s: s1, y: w.y1, depth: 0), w.point(s: s1, y: w.y1, depth: t), w.point(s: s0, y: w.y1, depth: t)],
                    chart: edges, normal: Vec3(0, 1, 0))
            }
        }
        for (s, dir) in [(0.0, -1.0), (w.length, 1.0)] {
            for (ya, yb) in solids(at: s) where yb - ya > 1e-4 {
                addFace(
                    [w.point(s: s, y: ya, depth: 0), w.point(s: s, y: ya, depth: t), w.point(s: s, y: yb, depth: t), w.point(s: s, y: yb, depth: 0)],
                    chart: edges, normal: world(w.u * dir, y: 0))
            }
        }
        for h in w.holes {
            if h.s0 > 1e-4 {
                addFace(
                    [w.point(s: h.s0, y: h.y0, depth: 0), w.point(s: h.s0, y: h.y0, depth: t), w.point(s: h.s0, y: h.y1, depth: t), w.point(s: h.s0, y: h.y1, depth: 0)],
                    chart: edges, normal: world(w.u, y: 0))
            }
            if h.s1 < w.length - 1e-4 {
                addFace(
                    [w.point(s: h.s1, y: h.y0, depth: 0), w.point(s: h.s1, y: h.y0, depth: t), w.point(s: h.s1, y: h.y1, depth: t), w.point(s: h.s1, y: h.y1, depth: 0)],
                    chart: edges, normal: world(-w.u, y: 0))
            }
            if h.y1 < w.y1 - 1e-4 {
                addFace(
                    [w.point(s: h.s0, y: h.y1, depth: 0), w.point(s: h.s1, y: h.y1, depth: 0), w.point(s: h.s1, y: h.y1, depth: t), w.point(s: h.s0, y: h.y1, depth: t)],
                    chart: edges, normal: Vec3(0, -1, 0))
            }
        }
    }

    /// A floor patch through each passage, on the first room's floor chart.
    mutating func addThresholds(_ passages: [ScanOpening], walls: [WallInfo], rooms: [RoomInfo]) {
        for o in passages {
            let u = pnormalize(plan(o.transform.xAxis))
            let n = perp(u), mid = plan(o.transform.translation)
            let bottom = Double(o.transform.translation.y - o.height / 2)
            guard let room = rooms.first(where: { pointInPolygon(mid + n * 0.4, $0.poly) && abs($0.floorY - bottom) < 0.3 })
                ?? rooms.first(where: { pointInPolygon(mid - n * 0.4, $0.poly) && abs($0.floorY - bottom) < 0.3 }),
                let chart = floorChart[room.index]
            else { continue }
            let y = room.floorY + 0.0015
            let along: P2 = u * (Double(o.width) / 2), across: P2 = n * 0.32
            let corners: [P2] = [mid - along - across, mid + along - across, mid + along + across, mid - along + across]
            addFace(corners.map { world($0, y: y) }, chart: chart)
        }
    }
}

extension PhotoModel: BoxSink {
    /// A furniture part: every face is its own chart.
    mutating func addBox(_ frame: Transform, min lo: Vec3, max hi: Vec3, material: String, skipBottom: Bool) {
        guard hi.x > lo.x, hi.y > lo.y, hi.z > lo.z else { return }
        func p(_ x: Float, _ y: Float, _ z: Float) -> Vec3 { frame.apply(Vec3(x, y, z)) }
        let X = frame.xAxis, Y = frame.yAxis, Z = frame.zAxis
        // Corners from the chart origin: the second along u, the fourth along v.
        var faces: [(corners: [Vec3], normal: Vec3, u: Vec3, v: Vec3)] = [
            ([p(lo.x, hi.y, lo.z), p(hi.x, hi.y, lo.z), p(hi.x, hi.y, hi.z), p(lo.x, hi.y, hi.z)], Y, X, Z),
            ([p(hi.x, lo.y, lo.z), p(hi.x, lo.y, hi.z), p(hi.x, hi.y, hi.z), p(hi.x, hi.y, lo.z)], X, Z, Y),
            ([p(lo.x, lo.y, hi.z), p(lo.x, lo.y, lo.z), p(lo.x, hi.y, lo.z), p(lo.x, hi.y, hi.z)], -X, -Z, Y),
            ([p(hi.x, lo.y, hi.z), p(lo.x, lo.y, hi.z), p(lo.x, hi.y, hi.z), p(hi.x, hi.y, hi.z)], Z, -X, Y),
            ([p(lo.x, lo.y, lo.z), p(hi.x, lo.y, lo.z), p(hi.x, hi.y, lo.z), p(lo.x, hi.y, lo.z)], -Z, X, Y),
        ]
        if !skipBottom { faces.append(([p(lo.x, lo.y, lo.z), p(lo.x, lo.y, hi.z), p(hi.x, lo.y, hi.z), p(hi.x, lo.y, lo.z)], -Y, Z, X)) }
        for face in faces {
            // A sliver isn't worth a chart.
            guard min(vlength(face.corners[1] - face.corners[0]), vlength(face.corners[3] - face.corners[0])) >= 0.01 else { continue }
            let chart = addChart(origin: face.corners[0], u: face.u, v: face.v, normal: face.normal, kind: .object)
            addFace(face.corners, chart: chart)
        }
    }
}

/// One photo, ready for projection.
struct PhotoCamera {
    let frame: CameraFrame
    let position: Vec3
    /// Camera axes in world space (ARKit: x right, y up, looking along −z).
    let right: Vec3, up: Vec3, back: Vec3
    /// Intrinsics at the saved image's size.
    let fx: Float, fy: Float, cx: Float, cy: Float
    let width: Int, height: Int
    /// How far the phone turned while the shutter was open, radians (0 if unknown). Times the
    /// distance, it is how far the photo is smeared across a surface.
    let smear: Float
    // Depth image (camera distance along the view axis; +∞ where nothing was drawn).
    let depthWidth: Int, depthHeight: Int
    var depth: [Float]

    init?(_ frame: CameraFrame, depthWidth: Int) {
        let k = frame.intrinsics
        guard k.count == 9, frame.width > 0, frame.height > 0, frame.imageWidth > 0, frame.imageHeight > 0, frame.transform.isFinite else { return nil }
        let sx = Float(frame.imageWidth) / Float(frame.width), sy = Float(frame.imageHeight) / Float(frame.height)
        self.frame = frame
        position = frame.transform.translation
        right = vnormalize(frame.transform.xAxis)
        up = vnormalize(frame.transform.yAxis)
        back = vnormalize(frame.transform.zAxis)
        fx = k[0] * sx
        fy = k[4] * sy
        cx = k[6] * sx
        cy = k[7] * sy
        width = frame.imageWidth
        height = frame.imageHeight
        guard fx > 1, fy > 1 else { return nil }
        let rate = frame.angularSpeed.map { $0.isFinite ? max(0, $0) : 0 } ?? 0
        let exposure = frame.exposureDuration.flatMap { $0.isFinite && $0 > 0 && $0 < 1 ? Float($0) : nil } ?? 0.02
        smear = rate * exposure
        self.depthWidth = depthWidth
        depthHeight = max(1, Int((Double(depthWidth) * Double(frame.imageHeight) / Double(frame.imageWidth)).rounded()))
        depth = [Float](repeating: .infinity, count: depthWidth * depthHeight)
    }

    /// Camera-space depth and image pixel of a world point (nil if behind the camera).
    @inline(__always) func project(_ p: Vec3) -> (depth: Float, u: Float, v: Float)? {
        let d = p - position
        let z = -vdot(d, back)
        guard z > 0.05 else { return nil }
        return (z, fx * vdot(d, right) / z + cx, -fy * vdot(d, up) / z + cy)
    }

    /// Draws triangles into the depth image.
    mutating func rasterize(_ positions: [Float], _ indices: [UInt32]) {
        let sx = Float(depthWidth) / Float(width), sy = Float(depthHeight) / Float(height)
        let near: Float = 0.08
        var poly: [(Float, Float, Float)] = []  // camera x, y, depth
        for t in stride(from: 0, to: indices.count - 2, by: 3) {
            var cam: [(Float, Float, Float)] = []
            cam.reserveCapacity(3)
            for k in 0..<3 {
                let i = Int(indices[t + k]) * 3
                let d = Vec3(positions[i], positions[i + 1], positions[i + 2]) - position
                cam.append((vdot(d, right), vdot(d, up), -vdot(d, back)))
            }
            if cam.allSatisfy({ $0.2 < near }) { continue }
            // Clip against the near plane.
            poly.removeAll(keepingCapacity: true)
            for k in 0..<3 {
                let a = cam[k], b = cam[(k + 1) % 3]
                if a.2 >= near { poly.append(a) }
                if (a.2 >= near) != (b.2 >= near) {
                    let f = (near - a.2) / (b.2 - a.2)
                    poly.append((a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, near))
                }
            }
            guard poly.count >= 3 else { continue }
            let screen = poly.map { c -> (Float, Float, Float) in
                ((fx * c.0 / c.2 + cx) * sx, (-fy * c.1 / c.2 + cy) * sy, 1 / c.2)
            }
            for k in 1..<(screen.count - 1) { fill(screen[0], screen[k], screen[k + 1]) }
        }
    }

    /// Fills a screen-space triangle (x, y, 1/depth), keeping the nearest depth.
    private mutating func fill(_ a: (Float, Float, Float), _ b: (Float, Float, Float), _ c: (Float, Float, Float)) {
        let area = (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
        guard abs(area) > 1e-9 else { return }
        let x0 = max(0, Int(floor(min(a.0, b.0, c.0)))), x1 = min(depthWidth - 1, Int(ceil(max(a.0, b.0, c.0))))
        let y0 = max(0, Int(floor(min(a.1, b.1, c.1)))), y1 = min(depthHeight - 1, Int(ceil(max(a.1, b.1, c.1))))
        guard x0 <= x1, y0 <= y1 else { return }
        for py in y0...y1 {
            let fy = Float(py) + 0.5
            for px in x0...x1 {
                let fx = Float(px) + 0.5
                let w0 = ((b.0 - fx) * (c.1 - fy) - (b.1 - fy) * (c.0 - fx)) / area
                let w1 = ((c.0 - fx) * (a.1 - fy) - (c.1 - fy) * (a.0 - fx)) / area
                let w2 = 1 - w0 - w1
                guard w0 >= -1e-4, w1 >= -1e-4, w2 >= -1e-4 else { continue }
                let inv = w0 * a.2 + w1 * b.2 + w2 * c.2
                guard inv > 0 else { continue }
                let z = 1 / inv
                let i = py * depthWidth + px
                if z < depth[i] { depth[i] = z }
            }
        }
    }

    /// Whether a point at `z` projecting to pixel (u, v) is the nearest surface there.
    @inline(__always) func isVisible(z: Float, u: Float, v: Float) -> Bool {
        let dx = u * Float(depthWidth) / Float(width) - 0.5, dy = v * Float(depthHeight) / Float(height) - 0.5
        let x0 = clamp(Int(floor(dx)), 0, depthWidth - 1), y0 = clamp(Int(floor(dy)), 0, depthHeight - 1)
        let x1 = min(x0 + 1, depthWidth - 1), y1 = min(y0 + 1, depthHeight - 1)
        // The nearest of the four neighbours, so texels right next to an occluder's edge are left to other photos.
        let nearest = min(depth[y0 * depthWidth + x0], depth[y0 * depthWidth + x1], depth[y1 * depthWidth + x0], depth[y1 * depthWidth + x1])
        return z <= nearest * 1.03 + 0.04
    }
}

/// A fixed-size buffer that concurrent loops fill in disjoint parts.
final class SharedArray<Element> {
    let buffer: UnsafeMutableBufferPointer<Element>

    init(repeating value: Element, count: Int) {
        buffer = .allocate(capacity: max(count, 1))
        buffer.initialize(repeating: value)
    }

    deinit {
        buffer.deinitialize()
        buffer.deallocate()
    }

    func array(_ range: Range<Int>) -> [Element] { Array(buffer[range]) }
}

/// Up to four photos and their weights for one texel (no allocation in the texel loop).
struct PhotoBlend {
    var cams = SIMD4<UInt16>(repeating: .max)
    var weights = SIMD4<Float>(repeating: 0)
    var count = 0

    @inline(__always) mutating func add(_ cam: UInt16, _ weight: Float) {
        guard cam != .max, weight > 0 else { return }
        for n in 0..<count where cams[n] == cam {
            weights[n] += weight
            return
        }
        guard count < 4 else { return }
        cams[count] = cam
        weights[count] = weight
        count += 1
    }

    /// The `n` heaviest, heaviest first.
    mutating func keepHeaviest(_ n: Int) {
        for a in 0..<count {
            for b in (a + 1)..<count where weights[b] > weights[a] {
                (cams[a], cams[b]) = (cams[b], cams[a])
                (weights[a], weights[b]) = (weights[b], weights[a])
            }
        }
        count = min(count, n)
    }
}

/// Bakes photo atlases for a `PhotoModel`.
struct PhotoBaker {
    struct Result {
        var atlases: [RGBImage]
        /// Share of the photo charts' face texels that at least one photo saw.
        var coverage: Double
        var photosUsed: Int
        /// Per chart, per texel: whether a photo saw it (the rest was filled in). Empty for solid charts.
        var seen: [[Bool]]
        /// Per photo: how many texels took their color mostly from it.
        var texelsPerPhoto: [Int]
        /// Share of the seen texels that mix more than one photo (the seams).
        var blended: Double
    }

    /// Photos are chosen per cell of this many texels across (about 3 cm).
    static let cell = 4
    /// Candidate photos kept per cell.
    static let perCell = 6
    /// Photos a texel can blend (along seams).
    static let slots = 3
    /// A cell whose eight neighbours all chose one photo counts that photo this much more (×1.5).
    static let smoothing: Float = 0.5
    /// Motion smear across a surface (meters) at which a photo counts half.
    static let smearScale: Float = 0.012

    /// Sizes and places every chart; nil if they can't fit.
    static func pack(_ charts: inout [PhotoChart], options: PhotoTexturingOptions) -> Int? {
        let size = options.atlasSize, pad = PhotoChart.pad
        var texel = options.texelSize
        for _ in 0..<12 {
            for i in charts.indices {
                if charts[i].isSolid {
                    charts[i].w = PhotoChart.solidSize
                    charts[i].h = PhotoChart.solidSize
                    continue
                }
                let extent = max(charts[i].maxU - charts[i].minU, charts[i].maxV - charts[i].minV, 0.01)
                charts[i].texel = max(texel, extent / Double(size - 2 * pad - 2))
                charts[i].w = Int(ceil((charts[i].maxU - charts[i].minU) / charts[i].texel)) + 2 * pad
                charts[i].h = Int(ceil((charts[i].maxV - charts[i].minV) / charts[i].texel)) + 2 * pad
            }
            // Shelf packing, tallest first.
            let order = charts.indices.sorted { charts[$0].h > charts[$1].h }
            var atlas = 0, x = 0, y = 0, shelf = 0
            for i in order {
                if x + charts[i].w > size {
                    x = 0
                    y += shelf
                    shelf = 0
                }
                if y + charts[i].h > size {
                    atlas += 1
                    x = 0
                    y = 0
                    shelf = 0
                }
                charts[i].atlas = atlas
                charts[i].x = x
                charts[i].y = y
                x += charts[i].w
                shelf = max(shelf, charts[i].h)
            }
            if atlas < options.maxAtlases { return atlas + 1 }
            texel *= 1.25
        }
        return nil
    }

    /// Which photos may paint a chart. Furniture shapes are only approximate, so on furniture
    /// the photos taken square on win (a shape error shifts their pixels least).
    struct Rule {
        let minFacing: Float
        let squareOn: Bool

        init(_ kind: PhotoChart.Kind) {
            squareOn = kind == .object
            minFacing = squareOn ? 0.2 : 0.12
        }
    }

    /// How well a photo shows point `p` of a chart: facing it, close, near the image center and
    /// not smeared by the phone's motion. 0 if the photo doesn't see the point, or if it does no
    /// better than `threshold`.
    @inline(__always) static func score(_ cam: PhotoCamera, at p: Vec3, normal: Vec3, rule: Rule, above threshold: Float) -> Float {
        let toCam = cam.position - p
        let dist = vlength(toCam)
        guard dist > 0.15 else { return 0 }
        let facing = vdot(normal, toCam) / dist
        guard facing > rule.minFacing, let q = cam.project(p) else { return 0 }
        guard q.u > 1, q.v > 1, q.u < Float(cam.width - 2), q.v < Float(cam.height - 2) else { return 0 }
        let du = (q.u - cam.cx) / (Float(cam.width) / 2), dv = (q.v - cam.cy) / (Float(cam.height) / 2)
        var score = facing / max(dist, 0.4) * max(0.25, 1 - 0.55 * (du * du + dv * dv))
        if rule.squareOn { score *= facing * facing }
        let smear = cam.smear * dist / smearScale
        score /= 1 + smear * smear
        guard score > threshold, cam.isVisible(z: q.depth, u: q.u, v: q.v) else { return 0 }
        return score
    }

    static func bake(model: PhotoModel, cameras inputCameras: [PhotoCamera], photos: PhotoSource, atlasCount: Int, options: PhotoTexturingOptions) -> Result {
        let charts = model.charts
        let size = options.atlasSize
        var cameras = inputCameras

        // Depth images, one per photo, from every triangle of the model.
        let buffers = model.mesh.order.compactMap { model.mesh.buffers[$0] }
        cameras.withUnsafeMutableBufferPointer { cams in
            guard let base = cams.baseAddress else { return }
            DispatchQueue.concurrentPerform(iterations: cams.count) { i in
                for b in buffers { base[i].rasterize(b.positions, b.indices) }
            }
        }
        let cams = cameras

        // Texels and cells: each photo chart's are a contiguous range (solid charts have none).
        var offsets: [Int] = [], cellOffsets: [Int] = [], grids: [(w: Int, h: Int)] = []
        var total = 0, cellTotal = 0
        for c in charts {
            offsets.append(total)
            cellOffsets.append(cellTotal)
            let grid = c.isSolid ? (w: 0, h: 0) : (w: (c.w + cell - 1) / cell, h: (c.h + cell - 1) / cell)
            grids.append(grid)
            total += c.isSolid ? 0 : c.w * c.h
            cellTotal += grid.w * grid.h
        }
        // Only texels on the chart's faces take photos; padding and holes are filled from them
        // (sampled, they would show whatever lies beyond the face's edge).
        let inside = SharedArray<Bool>(repeating: false, count: total)
        DispatchQueue.concurrentPerform(iterations: charts.count) { ci in
            guard !charts[ci].isSolid else { return }
            let mask = coverage(of: charts[ci], faces: model.mesh.buffers[PhotoModel.chartMaterial(ci)])
            for t in mask.indices where mask[t] { inside.buffer[offsets[ci] + t] = true }
        }
        let insideTotal = inside.buffer.prefix(total).filter { $0 }.count
        // Each cell is judged at its face texel nearest the cell's center (texel index in the chart; −1: none).
        let cellSpot = SharedArray<Int32>(repeating: -1, count: cellTotal)

        // Pass 1: the photos each cell and texel take their color from.
        let cellCam = SharedArray<UInt16>(repeating: .max, count: cellTotal * perCell)
        let cellScore = SharedArray<Float>(repeating: 0, count: cellTotal * perCell)
        let texelCam = SharedArray<UInt16>(repeating: .max, count: total * slots)
        let texelWeight = SharedArray<Float>(repeating: 0, count: total * slots)
        let candidates: [[Int]] = charts.map { $0.isSolid ? [] : candidateCameras(for: $0, cameras: cams) }
        DispatchQueue.concurrentPerform(iterations: charts.count) { ci in
            let chart = charts[ci]
            let cands = candidates[ci]
            guard !chart.isSolid, !cands.isEmpty else { return }
            let rule = Rule(chart.kind)
            let (gw, gh) = grids[ci]
            let cc = cellCam.buffer, cs = cellScore.buffer, tc = texelCam.buffer, tw = texelWeight.buffer
            let cellBase = cellOffsets[ci]

            // The best few photos of each cell, best first.
            for cy in 0..<gh {
                for cx in 0..<gw {
                    var spot = -1, nearest = Int.max
                    for j in (cy * cell)..<min(chart.h, (cy + 1) * cell) {
                        for i in (cx * cell)..<min(chart.w, (cx + 1) * cell) where inside.buffer[offsets[ci] + j * chart.w + i] {
                            let d = abs(2 * i + 1 - (2 * cx + 1) * cell) + abs(2 * j + 1 - (2 * cy + 1) * cell)
                            if d < nearest {
                                nearest = d
                                spot = j * chart.w + i
                            }
                        }
                    }
                    guard spot >= 0 else { continue }
                    cellSpot.buffer[cellBase + cy * gw + cx] = Int32(spot)
                    let p = chart.point(spot % chart.w, spot / chart.w)
                    let base = (cellBase + cy * gw + cx) * perCell
                    var kept = 0
                    for k in cands {
                        let s = score(cams[k], at: p, normal: chart.normal, rule: rule, above: kept < perCell ? 0 : cs[base + perCell - 1])
                        guard s > 0 else { continue }
                        var pos = min(kept, perCell - 1)
                        while pos > 0 && cs[base + pos - 1] < s {
                            cs[base + pos] = cs[base + pos - 1]
                            cc[base + pos] = cc[base + pos - 1]
                            pos -= 1
                        }
                        cs[base + pos] = s
                        cc[base + pos] = UInt16(k)
                        kept = min(kept + 1, perCell)
                    }
                }
            }

            // One photo per cell, leaning toward the neighbours' choice.
            let range = (cellBase * perCell)..<((cellBase + gw * gh) * perCell)
            let labels = smoothLabels(width: gw, height: gh, cameras: cellCam.array(range), scores: cellScore.array(range), perCell: perCell)

            // Texels blend the photos of the four cells around them by distance: a single photo
            // inside a patch, a short ramp across a seam. Photos that can't see the texel drop out.
            let fc = Float(cell)
            for j in 0..<chart.h {
                let y = (Float(j) + 0.5) / fc - 0.5
                let y0 = clamp(Int(y.rounded(.down)), 0, gh - 1), y1 = min(y0 + 1, gh - 1)
                let ay = clamp(y - Float(y0), 0, 1)
                for i in 0..<chart.w where inside.buffer[offsets[ci] + j * chart.w + i] {
                    let x = (Float(i) + 0.5) / fc - 0.5
                    let x0 = clamp(Int(x.rounded(.down)), 0, gw - 1), x1 = min(x0 + 1, gw - 1)
                    let ax = clamp(x - Float(x0), 0, 1)
                    var around = PhotoBlend()
                    around.add(labels[y0 * gw + x0], (1 - ax) * (1 - ay))
                    around.add(labels[y0 * gw + x1], ax * (1 - ay))
                    around.add(labels[y1 * gw + x0], (1 - ax) * ay)
                    around.add(labels[y1 * gw + x1], ax * ay)
                    let p = chart.point(i, j)
                    var blend = PhotoBlend()
                    for n in 0..<around.count where score(cams[Int(around.cams[n])], at: p, normal: chart.normal, rule: rule, above: 0) > 0 {
                        blend.add(around.cams[n], around.weights[n])
                    }
                    if blend.count == 0 {
                        // Hidden from the patch's photo (behind furniture, say): the nearest cell's
                        // next best photo that sees it, so neighbouring texels agree; else any photo.
                        let nearest = clamp(Int(y.rounded()), 0, gh - 1) * gw + clamp(Int(x.rounded()), 0, gw - 1)
                        let base = (cellBase + nearest) * perCell
                        for s in 0..<perCell where cs[base + s] > 0 {
                            if score(cams[Int(cc[base + s])], at: p, normal: chart.normal, rule: rule, above: 0) > 0 {
                                blend.add(cc[base + s], 1)
                                break
                            }
                        }
                    }
                    if blend.count == 0 {
                        var best: Float = 0, bestCam = -1
                        for k in cands {
                            let s = score(cams[k], at: p, normal: chart.normal, rule: rule, above: best)
                            if s > 0 {
                                best = s
                                bestCam = k
                            }
                        }
                        if bestCam >= 0 { blend.add(UInt16(bestCam), 1) }
                    }
                    guard blend.count > 0 else { continue }
                    blend.keepHeaviest(slots)
                    var sum: Float = 0
                    for n in 0..<blend.count { sum += blend.weights[n] }
                    let t = (offsets[ci] + j * chart.w + i) * slots
                    for n in 0..<blend.count {
                        tc[t + n] = blend.cams[n]
                        tw[t + n] = blend.weights[n] / sum
                    }
                }
            }
        }

        // Which charts each photo paints, or is compared on.
        var chartsOfCamera = [[Int]](repeating: [], count: cams.count)
        for (ci, c) in charts.enumerated() where !c.isSolid {
            var used = Set<UInt16>()
            for t in (offsets[ci] * slots)..<((offsets[ci] + c.w * c.h) * slots) where texelCam.buffer[t] != .max { used.insert(texelCam.buffer[t]) }
            for t in (cellOffsets[ci] * perCell)..<((cellOffsets[ci] + grids[ci].w * grids[ci].h) * perCell) where cellCam.buffer[t] != .max {
                used.insert(cellCam.buffer[t])
            }
            for k in used { chartsOfCamera[Int(k)].append(ci) }
        }

        // Pass 2: photo by photo, sample the texels that chose it, and every cell that listed it
        // (those samples compare the photos' exposure).
        let texelRGB = SharedArray<UInt8>(repeating: 0, count: total * slots * 3)
        let texelSampled = SharedArray<Bool>(repeating: false, count: total * slots)
        let cellRGB = SharedArray<UInt8>(repeating: 0, count: cellTotal * perCell * 3)
        let cellSampled = SharedArray<Bool>(repeating: false, count: cellTotal * perCell)
        var photosUsed = 0
        for (k, cam) in cams.enumerated() where !chartsOfCamera[k].isEmpty {
            guard let image = photos.image(for: cam.frame), image.width > 1, image.height > 1 else { continue }
            photosUsed += 1
            let scaleX = Float(image.width) / Float(cam.width), scaleY = Float(image.height) / Float(cam.height)
            let list = chartsOfCamera[k]
            let id = UInt16(k)
            image.pixels.withUnsafeBufferPointer { px in
                DispatchQueue.concurrentPerform(iterations: list.count) { n in
                    let ci = list[n]
                    let chart = charts[ci]
                    let tc = texelCam.buffer, trgb = texelRGB.buffer, ts = texelSampled.buffer
                    let cc = cellCam.buffer, crgb = cellRGB.buffer, cs = cellSampled.buffer
                    func sample(_ p: Vec3, into slot: Int, _ rgb: UnsafeMutableBufferPointer<UInt8>, _ sampled: UnsafeMutableBufferPointer<Bool>) {
                        guard let q = cam.project(p) else { return }
                        let (r, g, b) = bilinear(px, image.width, image.height, q.u * scaleX - 0.5, q.v * scaleY - 0.5)
                        rgb[slot * 3] = UInt8(clamp(r.rounded(), 0, 255))
                        rgb[slot * 3 + 1] = UInt8(clamp(g.rounded(), 0, 255))
                        rgb[slot * 3 + 2] = UInt8(clamp(b.rounded(), 0, 255))
                        sampled[slot] = true
                    }
                    for j in 0..<chart.h {
                        for i in 0..<chart.w {
                            let texel = offsets[ci] + j * chart.w + i
                            for s in 0..<slots where tc[texel * slots + s] == id { sample(chart.point(i, j), into: texel * slots + s, trgb, ts) }
                        }
                    }
                    let (gw, gh) = grids[ci]
                    for c in cellOffsets[ci]..<(cellOffsets[ci] + gw * gh) {
                        let spot = Int(cellSpot.buffer[c])
                        guard spot >= 0 else { continue }
                        for s in 0..<perCell where cc[c * perCell + s] == id { sample(chart.point(spot % chart.w, spot / chart.w), into: c * perCell + s, crgb, cs) }
                    }
                }
            }
        }

        // The phone's auto-exposure makes one photo darker than the next; match them where they overlap.
        let gains = exposureGains(
            cameras: UnsafeBufferPointer(cellCam.buffer), scores: UnsafeBufferPointer(cellScore.buffer), rgb: UnsafeBufferPointer(cellRGB.buffer),
            sampled: UnsafeBufferPointer(cellSampled.buffer), count: cellTotal, perCell: perCell, photos: cams.count)

        // Finish each photo chart: blend, fill unseen texels, write into its atlas.
        let pixels = SharedArray<UInt8>(repeating: 128, count: atlasCount * size * size * 3)
        let seen = SharedArray<Bool>(repeating: false, count: total)
        let medians = SharedArray<SIMD3<Float>>(repeating: .zero, count: charts.count)
        let seenCounts = SharedArray<Int>(repeating: 0, count: charts.count)
        func write(_ c: PhotoChart, _ color: (Int, Int) -> SIMD3<Float>) {
            let px = pixels.buffer
            for j in 0..<c.h {
                for i in 0..<c.w {
                    let rgb = color(i, j), a = ((c.atlas * size + c.y + j) * size + c.x + i) * 3
                    px[a] = UInt8(clamp(rgb.x.rounded(), 0, 255))
                    px[a + 1] = UInt8(clamp(rgb.y.rounded(), 0, 255))
                    px[a + 2] = UInt8(clamp(rgb.z.rounded(), 0, 255))
                }
            }
        }
        DispatchQueue.concurrentPerform(iterations: charts.count) { ci in
            let c = charts[ci]
            guard !c.isSolid else { return }
            let tc = texelCam.buffer, tw = texelWeight.buffer, trgb = texelRGB.buffer, ts = texelSampled.buffer
            let n = c.w * c.h
            var rgb = [Float](repeating: 0, count: n * 3)
            var mask = [Float](repeating: 0, count: n)
            var histogram = [Int](repeating: 0, count: 768)
            var count = 0
            for t in 0..<n {
                let texel = offsets[ci] + t
                var sum = SIMD3<Float>(0, 0, 0), weight: Float = 0
                for s in 0..<slots {
                    let slot = texel * slots + s
                    guard ts[slot] else { continue }
                    let g = gains[Int(tc[slot])], w = tw[slot]
                    let color = SIMD3<Float>(Float(trgb[slot * 3]), Float(trgb[slot * 3 + 1]), Float(trgb[slot * 3 + 2])) * g
                    sum += SIMD3<Float>(min(255, color.x), min(255, color.y), min(255, color.z)) * w
                    weight += w
                }
                guard weight > 0 else { continue }
                let color = sum / weight
                rgb[t * 3] = color.x
                rgb[t * 3 + 1] = color.y
                rgb[t * 3 + 2] = color.z
                mask[t] = 1
                seen.buffer[texel] = true
                count += 1
                for k in 0..<3 { histogram[k * 256 + Int(clamp(color[k].rounded(), 0, 255))] += 1 }
            }
            guard count > 0 else { return }
            // The chart's typical color: per-channel median of what the photos saw.
            var median = SIMD3<Float>(0, 0, 0)
            for k in 0..<3 {
                var acc = 0
                for b in 0..<256 {
                    acc += histogram[k * 256 + b]
                    if acc * 2 >= count {
                        median[k] = Float(b)
                        break
                    }
                }
            }
            medians.buffer[ci] = median
            seenCounts.buffer[ci] = count
            pullPush(&rgb, mask, c.w, c.h)
            write(c) { i, j in
                let t = (j * c.w + i) * 3
                return SIMD3(rgb[t], rgb[t + 1], rgb[t + 2])
            }
        }

        // Charts no photo saw take the typical color of their kind of surface; solid charts their wall's.
        var byKind: [String: [(SIMD3<Float>, Int)]] = [:]
        func kindKey(_ kind: PhotoChart.Kind) -> String { "\(kind)" }
        for (ci, c) in charts.enumerated() where seenCounts.buffer[ci] > 0 { byKind[kindKey(c.kind), default: []].append((medians.buffer[ci], seenCounts.buffer[ci])) }
        let kindColor = byKind.mapValues(weightedMedian)
        func typical(_ ci: Int) -> SIMD3<Float> {
            let c = charts[ci]
            if seenCounts.buffer[ci] > 0 { return medians.buffer[ci] }
            if let color = kindColor[kindKey(c.kind)] ?? nil { return color }
            return SIMD3(Float(c.fallback.0), Float(c.fallback.1), Float(c.fallback.2))
        }
        for (ci, c) in charts.enumerated() where seenCounts.buffer[ci] == 0 {
            let color: SIMD3<Float>
            if case let .solid(of) = c.kind { color = typical(of) } else { color = typical(ci) }
            write(c) { _, _ in color }
        }

        // Statistics.
        var texelsPerPhoto = [Int](repeating: 0, count: cams.count)
        var seenTotal = 0, blendedTotal = 0
        for texel in 0..<total where seen.buffer[texel] {
            seenTotal += 1
            var best = -1, mixed = 0
            for s in 0..<slots where texelSampled.buffer[texel * slots + s] && texelWeight.buffer[texel * slots + s] > 0.01 {
                mixed += 1
                if best < 0 || texelWeight.buffer[texel * slots + s] > texelWeight.buffer[texel * slots + best] { best = s }
            }
            if best >= 0 { texelsPerPhoto[Int(texelCam.buffer[texel * slots + best])] += 1 }
            if mixed > 1 { blendedTotal += 1 }
        }
        let atlases = (0..<atlasCount).map { a in
            RGBImage(width: size, height: size, pixels: pixels.array((a * size * size * 3)..<((a + 1) * size * size * 3)))
        }
        let masks = charts.indices.map { ci in charts[ci].isSolid ? [] : seen.array(offsets[ci]..<(offsets[ci] + charts[ci].w * charts[ci].h)) }
        return Result(
            atlases: atlases, coverage: insideTotal > 0 ? Double(seenTotal) / Double(insideTotal) : 0, photosUsed: photosUsed, seen: masks,
            texelsPerPhoto: texelsPerPhoto, blended: seenTotal > 0 ? Double(blendedTotal) / Double(seenTotal) : 0)
    }

    /// Texels of a chart whose centers lie on one of its faces (`faces`: the chart's triangles, UVs in
    /// chart meters). A chart narrower than a texel gets its faces' whole footprint instead.
    static func coverage(of chart: PhotoChart, faces buffer: MeshBuffer?) -> [Bool] {
        var mask = [Bool](repeating: false, count: chart.w * chart.h)
        guard let buffer, chart.w > 0, chart.h > 0 else { return mask }
        let pad = Double(PhotoChart.pad)
        func texelCoords(_ v: UInt32) -> (Double, Double) {
            let i = Int(v) * 2
            return (pad + (Double(buffer.uvs[i]) - chart.minU) / chart.texel, pad + (Double(buffer.uvs[i + 1]) - chart.minV) / chart.texel)
        }
        for t in stride(from: 0, to: buffer.indices.count - 2, by: 3) {
            let a = texelCoords(buffer.indices[t]), b = texelCoords(buffer.indices[t + 1]), c = texelCoords(buffer.indices[t + 2])
            let area = (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
            guard abs(area) > 1e-12 else { continue }
            let x0 = max(0, Int(floor(min(a.0, b.0, c.0)))), x1 = min(chart.w - 1, Int(floor(max(a.0, b.0, c.0))))
            let y0 = max(0, Int(floor(min(a.1, b.1, c.1)))), y1 = min(chart.h - 1, Int(floor(max(a.1, b.1, c.1))))
            guard x0 <= x1, y0 <= y1 else { continue }
            for j in y0...y1 {
                let py = Double(j) + 0.5
                for i in x0...x1 {
                    let px = Double(i) + 0.5
                    let w0 = ((b.0 - px) * (c.1 - py) - (b.1 - py) * (c.0 - px)) / area
                    let w1 = ((c.0 - px) * (a.1 - py) - (c.1 - py) * (a.0 - px)) / area
                    if w0 >= -1e-9, w1 >= -1e-9, 1 - w0 - w1 >= -1e-9 { mask[j * chart.w + i] = true }
                }
            }
        }
        if !mask.contains(true) {
            let p = PhotoChart.pad
            for j in p..<max(p, chart.h - p) {
                for i in p..<max(p, chart.w - p) { mask[j * chart.w + i] = true }
            }
        }
        return mask
    }

    /// One photo per cell of a w×h grid (`.max` where none sees it): each cell's best-scoring
    /// photo, nudged toward the one its neighbours took, so patches grow large and seams few.
    /// `cameras` and `scores` hold `perCell` candidates per cell, best first.
    static func smoothLabels(width w: Int, height h: Int, cameras: [UInt16], scores: [Float], perCell: Int, iterations: Int = 4) -> [UInt16] {
        var label = [UInt16](repeating: .max, count: w * h)
        for c in 0..<(w * h) where scores[c * perCell] > 0 { label[c] = cameras[c * perCell] }
        for _ in 0..<iterations {
            var changed = false
            for y in 0..<h {
                for x in 0..<w {
                    let c = y * w + x
                    guard label[c] != .max else { continue }
                    var best = label[c], bestValue: Float = 0
                    for s in 0..<perCell {
                        let cam = cameras[c * perCell + s], score = scores[c * perCell + s]
                        guard score > 0 else { break }
                        var agree = 0
                        for ny in max(0, y - 1)...min(h - 1, y + 1) {
                            for nx in max(0, x - 1)...min(w - 1, x + 1) where (nx != x || ny != y) && label[ny * w + nx] == cam { agree += 1 }
                        }
                        let value = score * (1 + smoothing * Float(agree) / 8)
                        if value > bestValue {
                            bestValue = value
                            best = cam
                        }
                    }
                    if best != label[c] {
                        label[c] = best
                        changed = true
                    }
                }
            }
            if !changed { break }
        }
        return label
    }

    /// A brightness factor per photo, so overlapping photos agree: wherever two photos are both
    /// candidates for a cell, their brightness ratio is one observation (weighted by the weaker
    /// photo's score); the log-gains are solved by least squares (lightly pulled to 1) and
    /// centered so the typical photo keeps its exposure.
    static func exposureGains(
        cameras: UnsafeBufferPointer<UInt16>, scores: UnsafeBufferPointer<Float>, rgb: UnsafeBufferPointer<UInt8>, sampled: UnsafeBufferPointer<Bool>,
        count: Int, perCell: Int, photos n: Int
    ) -> [Float] {
        guard n > 1 else { return [Float](repeating: 1, count: max(n, 0)) }
        var weight = [Double](repeating: 0, count: n * n), delta = [Double](repeating: 0, count: n * n)
        func luminance(_ slot: Int) -> Double {
            0.299 * Double(rgb[slot * 3]) + 0.587 * Double(rgb[slot * 3 + 1]) + 0.114 * Double(rgb[slot * 3 + 2])
        }
        for c in 0..<count {
            let base = c * perCell
            let top = Double(scores[base])
            guard top > 0 else { continue }
            for a in 0..<perCell {
                let sa = base + a
                guard sampled[sa] else { continue }
                let la = luminance(sa)
                guard la > 12, la < 243 else { continue }
                for b in (a + 1)..<perCell {
                    let sb = base + b
                    guard sampled[sb] else { continue }
                    let lb = luminance(sb)
                    guard lb > 12, lb < 243 else { continue }
                    var ca = Int(cameras[sa]), cb = Int(cameras[sb])
                    var d = log(lb) - log(la)  // wanted: g[ca] − g[cb]
                    // Far apart is a different surface showing (misplaced or moved), not exposure.
                    guard abs(d) < 1 else { continue }
                    if ca > cb {
                        swap(&ca, &cb)
                        d = -d
                    }
                    let w = Double(min(scores[sa], scores[sb])) / top
                    weight[ca * n + cb] += w
                    delta[ca * n + cb] += w * d
                }
            }
        }
        var pairs: [(a: Int, b: Int, w: Double, d: Double)] = []
        for a in 0..<n {
            for b in (a + 1)..<n where weight[a * n + b] > 3 { pairs.append((a, b, weight[a * n + b], delta[a * n + b] / weight[a * n + b])) }
        }
        guard !pairs.isEmpty else { return [Float](repeating: 1, count: n) }
        var g = [Double](repeating: 0, count: n)
        var linked = [Bool](repeating: false, count: n)
        for p in pairs {
            linked[p.a] = true
            linked[p.b] = true
        }
        let pull = 0.5
        for _ in 0..<200 {
            var sum = [Double](repeating: 0, count: n), total = [Double](repeating: pull, count: n)
            for p in pairs {
                sum[p.a] += p.w * (g[p.b] + p.d)
                total[p.a] += p.w
                sum[p.b] += p.w * (g[p.a] - p.d)
                total[p.b] += p.w
            }
            for k in 0..<n { g[k] = sum[k] / total[k] }
        }
        let center = g.enumerated().filter { linked[$0.offset] }.map(\.element).sorted()
        let median = center.isEmpty ? 0 : center[center.count / 2]
        return g.map { Float(exp(clamp($0 - median, -0.8, 0.8))) }
    }

    /// The per-channel median of colors, each counted `weight` times.
    static func weightedMedian(_ items: [(SIMD3<Float>, Int)]) -> SIMD3<Float>? {
        let total = items.reduce(0) { $0 + $1.1 }
        guard total > 0 else { return nil }
        var out = SIMD3<Float>(0, 0, 0)
        for k in 0..<3 {
            var acc = 0
            for item in items.sorted(by: { $0.0[k] < $1.0[k] }) {
                acc += item.1
                if acc * 2 >= total {
                    out[k] = item.0[k]
                    break
                }
            }
        }
        return out
    }

    /// Photos that can see part of the chart: in front of it, close enough, and pointed at it.
    static func candidateCameras(for chart: PhotoChart, cameras: [PhotoCamera]) -> [Int] {
        let corners = [(chart.minU, chart.minV), (chart.maxU, chart.minV), (chart.maxU, chart.maxV), (chart.minU, chart.maxV)].map { s, t in
            chart.origin + chart.u * Float(s) + chart.v * Float(t)
        }
        let center = corners.reduce(Vec3(0, 0, 0), +) / 4
        let radius = corners.map { vlength($0 - center) }.max() ?? 0
        return cameras.indices.filter { k in
            let cam = cameras[k]
            guard vdot(cam.position - center, chart.normal) > 0.05 else { return false }
            guard vlength(cam.position - center) - radius < 7 else { return false }
            // Some corner (or the center) lands in the image, or the chart surrounds the camera's view.
            var left = true, right = true, above = true, below = true
            for p in corners + [center] {
                guard let q = cam.project(p) else {
                    left = false; right = false; above = false; below = false
                    break
                }
                if q.u >= 0 { left = false }
                if q.u <= Float(cam.width) { right = false }
                if q.v >= 0 { above = false }
                if q.v <= Float(cam.height) { below = false }
            }
            return !(left || right || above || below)
        }
    }

    @inline(__always) static func bilinear(_ px: UnsafeBufferPointer<UInt8>, _ w: Int, _ h: Int, _ x: Float, _ y: Float) -> (Float, Float, Float) {
        let xf = clamp(x, 0, Float(w - 1)), yf = clamp(y, 0, Float(h - 1))
        let x0 = min(Int(xf), w - 2), y0 = min(Int(yf), h - 2)
        let ax = xf - Float(x0), ay = yf - Float(y0)
        func at(_ x: Int, _ y: Int, _ c: Int) -> Float { Float(px[(y * w + x) * 3 + c]) }
        var out: (Float, Float, Float) = (0, 0, 0)
        for c in 0..<3 {
            let top = at(x0, y0, c) * (1 - ax) + at(x0 + 1, y0, c) * ax
            let bottom = at(x0, y0 + 1, c) * (1 - ax) + at(x0 + 1, y0 + 1, c) * ax
            let v = top * (1 - ay) + bottom * ay
            if c == 0 { out.0 = v } else if c == 1 { out.1 = v } else { out.2 = v }
        }
        return out
    }

    /// Fills unseen texels (mask 0) smoothly from seen ones: average down to a
    /// coarse grid, then blend back up where texels have no data of their own.
    static func pullPush(_ rgb: inout [Float], _ mask: [Float], _ w: Int, _ h: Int) {
        var levels: [(rgb: [Float], weight: [Float], w: Int, h: Int)] = [(rgb, mask, w, h)]
        while let last = levels.last, last.w > 1 || last.h > 1 {
            let nw = (last.w + 1) / 2, nh = (last.h + 1) / 2
            var c = [Float](repeating: 0, count: nw * nh * 3)
            var m = [Float](repeating: 0, count: nw * nh)
            for y in 0..<nh {
                for x in 0..<nw {
                    var sum: (Float, Float, Float, Float) = (0, 0, 0, 0)
                    for dy in 0..<2 {
                        for dx in 0..<2 {
                            let sx = 2 * x + dx, sy = 2 * y + dy
                            guard sx < last.w, sy < last.h else { continue }
                            let i = sy * last.w + sx
                            let wt = last.weight[i]
                            sum.0 += last.rgb[i * 3] * wt
                            sum.1 += last.rgb[i * 3 + 1] * wt
                            sum.2 += last.rgb[i * 3 + 2] * wt
                            sum.3 += wt
                        }
                    }
                    let o = y * nw + x
                    if sum.3 > 0 {
                        c[o * 3] = sum.0 / sum.3
                        c[o * 3 + 1] = sum.1 / sum.3
                        c[o * 3 + 2] = sum.2 / sum.3
                    }
                    m[o] = min(1, sum.3)
                }
            }
            levels.append((c, m, nw, nh))
        }
        for k in stride(from: levels.count - 2, through: 0, by: -1) {
            let coarse = levels[k + 1]
            var fine = levels[k]
            for y in 0..<fine.h {
                for x in 0..<fine.w {
                    let i = y * fine.w + x
                    let wt = fine.weight[i]
                    guard wt < 1 else { continue }
                    // Bilinear from the coarser level (its texel centers sit at 2x + 0.5 here).
                    let cx = clamp((Float(x) - 0.5) / 2, 0, Float(coarse.w - 1)), cy = clamp((Float(y) - 0.5) / 2, 0, Float(coarse.h - 1))
                    let x0 = Int(cx), y0 = Int(cy), x1 = min(x0 + 1, coarse.w - 1), y1 = min(y0 + 1, coarse.h - 1)
                    let ax = cx - Float(x0), ay = cy - Float(y0)
                    for c in 0..<3 {
                        let top = coarse.rgb[(y0 * coarse.w + x0) * 3 + c] * (1 - ax) + coarse.rgb[(y0 * coarse.w + x1) * 3 + c] * ax
                        let bottom = coarse.rgb[(y1 * coarse.w + x0) * 3 + c] * (1 - ax) + coarse.rgb[(y1 * coarse.w + x1) * 3 + c] * ax
                        fine.rgb[i * 3 + c] = fine.rgb[i * 3 + c] * wt + (top * (1 - ay) + bottom * ay) * (1 - wt)
                    }
                    fine.weight[i] = 1
                }
            }
            levels[k] = fine
        }
        rgb = levels[0].rgb
    }
}
