import Foundation

// Photo texturing: paints the photos taken while scanning onto the model's
// walls, floors, ceilings and furniture, so the walkthrough shows the real home.
//
// Every textured surface is a flat "chart" with its own patch of a texture
// atlas. Baking runs in two passes so only one photo is decoded at a time:
//   1. geometry only — for every texel, the (up to) three photos that see it
//      best: facing it, close, near the image center, not blocked by other
//      surfaces (a small depth image per photo, rasterized from the model);
//   2. photo by photo — each photo's pixels are blended into the texels that
//      chose it. Texels no photo saw are filled from their neighbours.

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

    public init(atlasSize: Int = 2048, maxAtlases: Int = 3, texelSize: Double = 0.012, depthWidth: Int = 192) {
        self.atlasSize = atlasSize
        self.maxAtlases = maxAtlases
        self.texelSize = texelSize
        self.depthWidth = depthWidth
    }
}

/// A flat textured surface: a rectangle of texels on a plane.
struct PhotoChart {
    let origin: Vec3
    let u: Vec3
    let v: Vec3
    /// Facing the side the surface is seen from.
    let normal: Vec3
    /// Color when no photo saw the surface (sRGB bytes).
    let fallback: (UInt8, UInt8, UInt8)
    var minU = Double.infinity, maxU = -Double.infinity, minV = Double.infinity, maxV = -Double.infinity
    // Placement in the atlas (texels), including padding.
    var atlas = 0, x = 0, y = 0, w = 0, h = 0
    var texel = 0.01

    static let pad = 4

    /// World position of texel (i, j) of this chart's rectangle.
    func point(_ i: Int, _ j: Int) -> Vec3 {
        let s = minU + (Double(i - Self.pad) + 0.5) * texel
        let t = minV + (Double(j - Self.pad) + 0.5) * texel
        return origin + u * Float(s) + v * Float(t)
    }

    /// Atlas UV of a point given in chart meters.
    func atlasUV(_ m: SIMD2<Float>, size: Int) -> SIMD2<Float> {
        let col = Double(x + Self.pad) + (Double(m.x) - minU) / texel
        let row = Double(y + Self.pad) + (Double(m.y) - minV) / texel
        return SIMD2(Float(col / Double(size)), Float(row / Double(size)))
    }
}

/// The photo-mode model: chart faces (material "chart:<index>", UVs in chart meters) plus plain faces.
struct PhotoModel {
    var mesh = MeshBuilder()
    var charts: [PhotoChart] = []

    static let wallColor: (UInt8, UInt8, UInt8) = (233, 229, 222)
    static let floorColor: (UInt8, UInt8, UInt8) = (176, 150, 118)
    static let ceilingColor: (UInt8, UInt8, UInt8) = (242, 240, 236)
    static let objectColor: (UInt8, UInt8, UInt8) = (150, 140, 128)
    /// Faces photos never see (outsides and tops of walls, door reveals).
    static let plainMaterial = "Plain_Wall"

    static func chartMaterial(_ index: Int) -> String { "chart:\(index)" }

    /// Each chart's extent, from the faces drawn on it (UVs are chart meters until baked).
    mutating func measureCharts() {
        for i in charts.indices {
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

    mutating func addChart(origin: Vec3, u: Vec3, v: Vec3, normal: Vec3, fallback: (UInt8, UInt8, UInt8)) -> Int {
        charts.append(PhotoChart(origin: origin, u: vnormalize(u), v: vnormalize(v), normal: vnormalize(normal), fallback: fallback))
        return charts.count - 1
    }

    mutating func addFace(_ points: [Vec3], chart: Int) {
        let c = charts[chart]
        mesh.addFace(points, normal: c.normal, material: Self.chartMaterial(chart), uv: .chart(origin: c.origin, u: c.u, v: c.v))
    }

    // MARK: Building

    /// Walls (passages between rooms cut, windows left to the photos), floors,
    /// ceilings, thresholds and furniture boxes.
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
            let floor = model.addChart(origin: floorOrigin, u: Vec3(1, 0, 0), v: Vec3(0, 0, 1), normal: Vec3(0, 1, 0), fallback: floorColor)
            model.mesh.addPlanPolygon(
                r.poly, y: r.floorY + lift, facingUp: true, material: chartMaterial(floor), uvScale: 1,
                uv: .chart(origin: floorOrigin, u: Vec3(1, 0, 0), v: Vec3(0, 0, 1)))
            model.floorChart[r.index] = floor
            if includeCeilings {
                let ceilingOrigin = world(P2(xs.min() ?? 0, zs.min() ?? 0), y: r.ceilingY)
                let ceiling = model.addChart(
                    origin: ceilingOrigin, u: Vec3(1, 0, 0), v: Vec3(0, 0, 1), normal: Vec3(0, -1, 0), fallback: ceilingColor)
                model.mesh.addPlanPolygon(
                    r.poly, y: r.ceilingY, facingUp: false, material: chartMaterial(ceiling), uvScale: 1,
                    uv: .chart(origin: ceilingOrigin, u: Vec3(1, 0, 0), v: Vec3(0, 0, 1)))
            }
        }
        model.addThresholds(passages, walls: walls, rooms: rooms)
        for o in scan.objects { model.addObject(o) }
        return model
    }

    var floorChart: [Int: Int] = [:]

    static func isPassage(_ o: ScanOpening, rooms: [RoomInfo]) -> Bool {
        guard o.kind != .window, o.transform.isFinite, o.width > 0.3 else { return false }
        let u = pnormalize(plan(o.transform.xAxis))
        guard plength(u) > 0.5 else { return false }
        let n = perp(u), mid = plan(o.transform.translation)
        let bottom = Double(o.transform.translation.y - o.height / 2)
        let sides = [mid + n * 0.4, mid - n * 0.4].map { p in rooms.contains { pointInPolygon(p, $0.poly) && abs($0.floorY - bottom) < 0.3 } }
        return sides[0] && sides[1]
    }

    /// The inside face is one chart (pieces between holes share it, so no seams); everything else is plain.
    mutating func addWall(_ w: WallInfo) {
        let t = w.thickness
        let inside = addChart(
            origin: w.point(s: 0, y: w.y0, depth: 0), u: world(w.u, y: 0), v: Vec3(0, 1, 0), normal: world(w.nIn, y: 0), fallback: Self.wallColor)
        var cuts = [0.0, w.length]
        for h in w.holes { cuts += [h.s0, h.s1] }
        cuts = WallGeometry.uniqueSorted(cuts.map { clamp($0, 0, w.length) })
        func holes(at s: Double) -> [WallHole] { w.holes.filter { $0.s0 <= s && s <= $0.s1 } }
        func solids(at s: Double) -> [(Double, Double)] { WallGeometry.subtract(holes(at: s).map { ($0.y0, $0.y1) }, from: (w.y0, w.y1)) }
        let plain = Self.plainMaterial
        for k in 0..<(cuts.count - 1) {
            let s0 = cuts[k], s1 = cuts[k + 1]
            guard s1 - s0 > 1e-4 else { continue }
            for (ya, yb) in solids(at: (s0 + s1) / 2) where yb - ya > 1e-4 {
                addFace(
                    [w.point(s: s0, y: ya, depth: 0), w.point(s: s1, y: ya, depth: 0), w.point(s: s1, y: yb, depth: 0), w.point(s: s0, y: yb, depth: 0)],
                    chart: inside)
                mesh.addFace(
                    [w.point(s: s0, y: ya, depth: t), w.point(s: s1, y: ya, depth: t), w.point(s: s1, y: yb, depth: t), w.point(s: s0, y: yb, depth: t)],
                    normal: world(-w.nIn, y: 0), material: plain)
            }
            if !holes(at: (s0 + s1) / 2).contains(where: { $0.y1 >= w.y1 - 1e-4 }) {
                mesh.addFace(
                    [w.point(s: s0, y: w.y1, depth: 0), w.point(s: s1, y: w.y1, depth: 0), w.point(s: s1, y: w.y1, depth: t), w.point(s: s0, y: w.y1, depth: t)],
                    normal: Vec3(0, 1, 0), material: plain)
            }
        }
        for (s, dir) in [(0.0, -1.0), (w.length, 1.0)] {
            for (ya, yb) in solids(at: s) where yb - ya > 1e-4 {
                mesh.addFace(
                    [w.point(s: s, y: ya, depth: 0), w.point(s: s, y: ya, depth: t), w.point(s: s, y: yb, depth: t), w.point(s: s, y: yb, depth: 0)],
                    normal: world(w.u * dir, y: 0), material: plain)
            }
        }
        for h in w.holes {
            if h.s0 > 1e-4 {
                mesh.addFace(
                    [w.point(s: h.s0, y: h.y0, depth: 0), w.point(s: h.s0, y: h.y0, depth: t), w.point(s: h.s0, y: h.y1, depth: t), w.point(s: h.s0, y: h.y1, depth: 0)],
                    normal: world(w.u, y: 0), material: plain)
            }
            if h.s1 < w.length - 1e-4 {
                mesh.addFace(
                    [w.point(s: h.s1, y: h.y0, depth: 0), w.point(s: h.s1, y: h.y0, depth: t), w.point(s: h.s1, y: h.y1, depth: t), w.point(s: h.s1, y: h.y1, depth: 0)],
                    normal: world(-w.u, y: 0), material: plain)
            }
            if h.y1 < w.y1 - 1e-4 {
                mesh.addFace(
                    [w.point(s: h.s0, y: h.y1, depth: 0), w.point(s: h.s1, y: h.y1, depth: 0), w.point(s: h.s1, y: h.y1, depth: t), w.point(s: h.s0, y: h.y1, depth: t)],
                    normal: Vec3(0, -1, 0), material: plain)
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

    /// Furniture as a box with a chart on each visible face (top and four sides).
    mutating func addObject(_ o: ScanObject) {
        let size = o.size
        guard size.x > 0.12, size.y > 0.08, size.z > 0.12, size.x < 12, size.y < 6, size.z < 12, o.transform.isFinite else { return }
        let f = Furniture.rigid(o.transform)
        let hx = size.x / 2, hy = size.y / 2, hz = size.z / 2
        func p(_ x: Float, _ y: Float, _ z: Float) -> Vec3 { f.apply(Vec3(x, y, z)) }
        let X = f.xAxis, Y = f.yAxis, Z = f.zAxis
        let faces: [(corners: [Vec3], normal: Vec3, u: Vec3, v: Vec3)] = [
            ([p(-hx, hy, -hz), p(hx, hy, -hz), p(hx, hy, hz), p(-hx, hy, hz)], Y, X, Z),
            ([p(hx, -hy, -hz), p(hx, -hy, hz), p(hx, hy, hz), p(hx, hy, -hz)], X, Z, Y),
            ([p(-hx, -hy, hz), p(-hx, -hy, -hz), p(-hx, hy, -hz), p(-hx, hy, hz)], -X, -Z, Y),
            ([p(hx, -hy, hz), p(-hx, -hy, hz), p(-hx, hy, hz), p(hx, hy, hz)], Z, -X, Y),
            ([p(-hx, -hy, -hz), p(hx, -hy, -hz), p(hx, hy, -hz), p(-hx, hy, -hz)], -Z, X, Y),
        ]
        for face in faces {
            let chart = addChart(origin: face.corners[0], u: face.u, v: face.v, normal: face.normal, fallback: Self.objectColor)
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

/// Bakes photo atlases for a `PhotoModel`.
struct PhotoBaker {
    struct Result {
        var atlases: [RGBImage]
        /// Share of chart texels that at least one photo saw.
        var coverage: Double
        var photosUsed: Int
        /// Per chart, per texel: whether a photo saw it (the rest was filled in).
        var seen: [[Bool]] = []
    }

    static let slots = 3

    /// Sizes and places every chart; false if it can't fit.
    static func pack(_ charts: inout [PhotoChart], options: PhotoTexturingOptions) -> Int? {
        let size = options.atlasSize, pad = PhotoChart.pad
        var texel = options.texelSize
        for _ in 0..<12 {
            for i in charts.indices {
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

    static func bake(model: PhotoModel, cameras inputCameras: [PhotoCamera], photos: PhotoSource, atlasCount: Int, options: PhotoTexturingOptions) -> Result {
        let charts = model.charts
        let size = options.atlasSize
        var cameras = inputCameras

        // Depth images, one per photo, from every triangle of the model.
        let buffers = model.mesh.order.compactMap { model.mesh.buffers[$0] }
        cameras.withUnsafeMutableBufferPointer { cams in
            let base = cams.baseAddress!
            DispatchQueue.concurrentPerform(iterations: cams.count) { i in
                for b in buffers { base[i].rasterize(b.positions, b.indices) }
            }
        }

        // Texel bookkeeping: each chart's texels are a contiguous range.
        var offsets: [Int] = []
        var total = 0
        for c in charts {
            offsets.append(total)
            total += c.w * c.h
        }
        var slotFrame = [UInt16](repeating: .max, count: total * slots)
        var slotWeight = [Float](repeating: 0, count: total * slots)

        // Pass 1: which photos each texel takes its color from.
        let cams = cameras
        let candidates: [[Int]] = charts.map { chart in candidateCameras(for: chart, cameras: cams) }
        slotFrame.withUnsafeMutableBufferPointer { frames in
            slotWeight.withUnsafeMutableBufferPointer { weights in
                let fBase = frames.baseAddress!, wBase = weights.baseAddress!
                DispatchQueue.concurrentPerform(iterations: charts.count) { ci in
                    let chart = charts[ci]
                    let cands = candidates[ci]
                    guard !cands.isEmpty else { return }
                    for j in 0..<chart.h {
                        for i in 0..<chart.w {
                            let p = chart.point(i, j)
                            // The three best views, best first.
                            var s0: Float = 0, s1: Float = 0, s2: Float = 0
                            var k0 = -1, k1 = -1, k2 = -1
                            for k in cands {
                                let cam = cams[k]
                                let toCam = cam.position - p
                                let dist = vlength(toCam)
                                guard dist > 0.15 else { continue }
                                let facing = vdot(chart.normal, toCam) / dist
                                guard facing > 0.12, let q = cam.project(p) else { continue }
                                guard q.u > 1, q.v > 1, q.u < Float(cam.width - 2), q.v < Float(cam.height - 2) else { continue }
                                let du = (q.u - cam.cx) / (Float(cam.width) / 2), dv = (q.v - cam.cy) / (Float(cam.height) / 2)
                                let score = facing / max(dist, 0.4) * max(0.25, 1 - 0.55 * (du * du + dv * dv))
                                guard score > s2, cam.isVisible(z: q.depth, u: q.u, v: q.v) else { continue }
                                if score > s0 {
                                    (s2, k2) = (s1, k1)
                                    (s1, k1) = (s0, k0)
                                    (s0, k0) = (score, k)
                                } else if score > s1 {
                                    (s2, k2) = (s1, k1)
                                    (s1, k1) = (score, k)
                                } else {
                                    (s2, k2) = (score, k)
                                }
                            }
                            guard k0 >= 0 else { continue }
                            // Blend the best views; sharpen so the best one dominates, drop clearly worse ones.
                            let w0: Float = 1
                            let w1: Float = k1 >= 0 && s1 >= s0 * 0.6 ? pow(s1 / s0, 4) : 0
                            let w2: Float = k2 >= 0 && s2 >= s0 * 0.6 ? pow(s2 / s0, 4) : 0
                            let sum = w0 + w1 + w2
                            let t = (offsets[ci] + j * chart.w + i) * slots
                            fBase[t] = UInt16(k0)
                            wBase[t] = w0 / sum
                            if w1 > 0 {
                                fBase[t + 1] = UInt16(k1)
                                wBase[t + 1] = w1 / sum
                            }
                            if w2 > 0 {
                                fBase[t + 2] = UInt16(k2)
                                wBase[t + 2] = w2 / sum
                            }
                        }
                    }
                }
            }
        }

        // Which charts each photo paints.
        var chartsOfCamera = [[Int]](repeating: [], count: cameras.count)
        for (ci, c) in charts.enumerated() {
            var used = Set<Int>()
            let start = offsets[ci] * slots, end = (offsets[ci] + c.w * c.h) * slots
            for t in start..<end where slotFrame[t] != .max { used.insert(Int(slotFrame[t])) }
            for k in used { chartsOfCamera[k].append(ci) }
        }

        // Pass 2: photo by photo, blend colors into the texels that chose it.
        let frameOfSlot = slotFrame, weightOfSlot = slotWeight
        var accumulated = [Float](repeating: 0, count: total * 4)
        var photosUsed = 0
        for (k, cam) in cams.enumerated() where !chartsOfCamera[k].isEmpty {
            guard let image = photos.image(for: cam.frame), image.width > 1, image.height > 1 else { continue }
            photosUsed += 1
            let scaleX = Float(image.width) / Float(cam.width), scaleY = Float(image.height) / Float(cam.height)
            let list = chartsOfCamera[k]
            accumulated.withUnsafeMutableBufferPointer { acc in
                let aBase = acc.baseAddress!
                image.pixels.withUnsafeBufferPointer { px in
                    DispatchQueue.concurrentPerform(iterations: list.count) { n in
                        let ci = list[n]
                        let chart = charts[ci]
                        for j in 0..<chart.h {
                            for i in 0..<chart.w {
                                let texel = offsets[ci] + j * chart.w + i
                                var weight: Float = 0
                                for s in 0..<slots where frameOfSlot[texel * slots + s] == UInt16(k) { weight = weightOfSlot[texel * slots + s] }
                                guard weight > 0, let q = cam.project(chart.point(i, j)) else { continue }
                                let (r, g, b) = bilinear(px, image.width, image.height, q.u * scaleX - 0.5, q.v * scaleY - 0.5)
                                aBase[texel * 4] += r * weight
                                aBase[texel * 4 + 1] += g * weight
                                aBase[texel * 4 + 2] += b * weight
                                aBase[texel * 4 + 3] += weight
                            }
                        }
                    }
                }
            }
        }

        // Finish each chart: normalize, fill unseen texels, write into its atlas.
        var atlases = (0..<atlasCount).map { _ in RGBImage(width: size, height: size, pixels: [UInt8](repeating: 128, count: size * size * 3)) }
        var seen = 0
        var seenMasks: [[Bool]] = []
        for (ci, c) in charts.enumerated() {
            var rgb = [Float](repeating: 0, count: c.w * c.h * 3)
            var mask = [Float](repeating: 0, count: c.w * c.h)
            for t in 0..<(c.w * c.h) {
                let a = (offsets[ci] + t) * 4
                let w = accumulated[a + 3]
                guard w > 0.25 else { continue }
                rgb[t * 3] = accumulated[a] / w
                rgb[t * 3 + 1] = accumulated[a + 1] / w
                rgb[t * 3 + 2] = accumulated[a + 2] / w
                mask[t] = 1
                seen += 1
            }
            seenMasks.append(mask.map { $0 > 0 })
            if mask.contains(where: { $0 > 0 }) {
                pullPush(&rgb, mask, c.w, c.h)
            } else {
                for t in 0..<(c.w * c.h) {
                    rgb[t * 3] = Float(c.fallback.0)
                    rgb[t * 3 + 1] = Float(c.fallback.1)
                    rgb[t * 3 + 2] = Float(c.fallback.2)
                }
            }
            for j in 0..<c.h {
                for i in 0..<c.w {
                    let t = j * c.w + i, a = ((c.y + j) * size + c.x + i) * 3
                    atlases[c.atlas].pixels[a] = UInt8(clamp(rgb[t * 3].rounded(), 0, 255))
                    atlases[c.atlas].pixels[a + 1] = UInt8(clamp(rgb[t * 3 + 1].rounded(), 0, 255))
                    atlases[c.atlas].pixels[a + 2] = UInt8(clamp(rgb[t * 3 + 2].rounded(), 0, 255))
                }
            }
        }
        return Result(atlases: atlases, coverage: total > 0 ? Double(seen) / Double(total) : 0, photosUsed: photosUsed, seen: seenMasks)
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
