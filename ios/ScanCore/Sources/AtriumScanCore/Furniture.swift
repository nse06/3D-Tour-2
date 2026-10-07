import Foundation

/// Furniture and appliances built from boxes, styled by RoomPlan category
/// (docs/iphone-capture.md §3.4). Each object is an oriented box: centered on
/// its transform's origin, Y up, full extents `size`.
enum Furniture {
    static func build(_ object: ScanObject, walls: [WallInfo], into mesh: inout MeshBuilder) {
        let size = object.size
        guard size.x > 0.02, size.y > 0.02, size.z > 0.02, size.x < 12, size.y < 6, size.z < 12, object.transform.isFinite else { return }
        let frame = rigid(object.transform)
        let hx = size.x / 2, hy = size.y / 2, hz = size.z / 2
        // Local helpers: x/z fractions of the footprint, y from the floor up (meters).
        func box(_ x0: Float, _ x1: Float, _ y0: Float, _ y1: Float, _ z0: Float, _ z1: Float, _ material: String, skipBottom: Bool = true) {
            mesh.addBox(frame, min: Vec3(x0, y0 - hy, z0), max: Vec3(x1, y1 - hy, z1), material: material, skipBottom: skipBottom)
        }

        switch object.category {
        case "sofa":
            // Back along the side nearest a wall; arms on the two short ends.
            let (axisX, sign) = backSide(object, frame: frame, walls: walls)
            let seatH = min(0.45, size.y * 0.55)
            if axisX {
                let back = 0.22 * min(1, size.x / 0.9)
                let bx0: Float = sign > 0 ? hx - back : -hx, bx1: Float = sign > 0 ? hx : -hx + back
                box(-hx, hx, 0, seatH, -hz, hz, Mat.fabric)
                box(bx0, bx1, seatH, size.y, -hz, hz, Mat.fabric)
                let arm: Float = min(0.18, size.z * 0.12)
                box(-hx, hx, seatH, min(size.y, seatH + 0.2), -hz, -hz + arm, Mat.fabric)
                box(-hx, hx, seatH, min(size.y, seatH + 0.2), hz - arm, hz, Mat.fabric)
            } else {
                let back = 0.22 * min(1, size.z / 0.9)
                let bz0: Float = sign > 0 ? hz - back : -hz, bz1: Float = sign > 0 ? hz : -hz + back
                box(-hx, hx, 0, seatH, -hz, hz, Mat.fabric)
                box(-hx, hx, seatH, size.y, bz0, bz1, Mat.fabric)
                let arm: Float = min(0.18, size.x * 0.12)
                box(-hx, -hx + arm, seatH, min(size.y, seatH + 0.2), -hz, hz, Mat.fabric)
                box(hx - arm, hx, seatH, min(size.y, seatH + 0.2), -hz, hz, Mat.fabric)
            }

        case "bed":
            let (axisX, sign) = backSide(object, frame: frame, walls: walls)
            let base = min(0.32, size.y * 0.5), mattress = min(base + 0.22, size.y)
            box(-hx, hx, 0, base, -hz, hz, Mat.fabricDark)
            box(-hx + 0.02, hx - 0.02, base, mattress, -hz + 0.02, hz - 0.02, Mat.duvet)
            let head: Float = 0.07, headTop: Float = max(size.y, 1.0)
            let pillowLen: Float = 0.38
            if axisX {
                let x0: Float = sign > 0 ? hx - head : -hx, x1: Float = sign > 0 ? hx : -hx + head
                box(x0, x1, 0, headTop, -hz, hz, Mat.fabricDark)
                let px0: Float = sign > 0 ? hx - head - pillowLen : -hx + head, px1 = px0 + pillowLen
                box(px0, px1, mattress, mattress + 0.12, -hz + 0.08, -0.03, Mat.duvet)
                box(px0, px1, mattress, mattress + 0.12, 0.03, hz - 0.08, Mat.duvet)
            } else {
                let z0: Float = sign > 0 ? hz - head : -hz, z1: Float = sign > 0 ? hz : -hz + head
                box(-hx, hx, 0, headTop, z0, z1, Mat.fabricDark)
                let pz0: Float = sign > 0 ? hz - head - pillowLen : -hz + head, pz1 = pz0 + pillowLen
                box(-hx + 0.08, -0.03, mattress, mattress + 0.12, pz0, pz1, Mat.duvet)
                box(0.03, hx - 0.08, mattress, mattress + 0.12, pz0, pz1, Mat.duvet)
            }

        case "chair":
            let (axisX, sign) = backSide(object, frame: frame, walls: walls, maxDistance: 0)
            let seat = min(0.46, size.y * 0.55)
            box(-hx, hx, seat - 0.05, seat, -hz, hz, Mat.woodDark)
            let leg: Float = 0.035
            for (lx, lz) in [(-hx, -hz), (hx - leg, -hz), (-hx, hz - leg), (hx - leg, hz - leg)] {
                box(lx, lx + leg, 0, seat - 0.05, lz, lz + leg, Mat.woodDark)
            }
            if axisX {
                let x0: Float = sign > 0 ? hx - 0.05 : -hx
                box(x0, x0 + 0.05, seat, size.y, -hz, hz, Mat.woodDark)
            } else {
                let z0: Float = sign > 0 ? hz - 0.05 : -hz
                box(-hx, hx, seat, size.y, z0, z0 + 0.05, Mat.woodDark)
            }

        case "table":
            let top: Float = min(0.04, size.y * 0.2)
            box(-hx, hx, size.y - top, size.y, -hz, hz, Mat.woodDark, skipBottom: false)
            let leg: Float = 0.06, inset: Float = 0.05
            for (lx, lz) in [(-hx + inset, -hz + inset), (hx - inset - leg, -hz + inset), (-hx + inset, hz - inset - leg), (hx - inset - leg, hz - inset - leg)] {
                box(lx, lx + leg, 0, size.y - top, lz, lz + leg, Mat.woodDark)
            }

        case "storage":
            if size.y < 1.2 && min(size.x, size.z) > 0.45 {
                // Base cabinets / counter.
                box(-hx, hx, 0, size.y - 0.03, -hz, hz, Mat.lacquer)
                box(-hx - 0.01, hx + 0.01, size.y - 0.03, size.y, -hz - 0.01, hz + 0.01, Mat.stone, skipBottom: false)
            } else {
                box(-hx, hx, 0, size.y, -hz, hz, size.y > 1.6 ? Mat.lacquer : Mat.woodDark)
            }

        case "refrigerator":
            box(-hx, hx, 0, size.y, -hz, hz, Mat.steel)
            if size.y > 1.3 { box(-hx - 0.003, hx + 0.003, size.y * 0.62, size.y * 0.62 + 0.012, -hz - 0.003, hz + 0.003, Mat.shadowGap) }

        case "stove", "oven":
            box(-hx, hx, 0, size.y - 0.02, -hz, hz, Mat.steel)
            box(-hx, hx, size.y - 0.02, size.y, -hz, hz, Mat.black, skipBottom: false)

        case "dishwasher":
            box(-hx, hx, 0, size.y, -hz, hz, Mat.steel)

        case "sink":
            box(-hx, hx, 0, size.y - 0.03, -hz, hz, Mat.lacquer)
            box(-hx, hx, size.y - 0.03, size.y, -hz, hz, Mat.stone, skipBottom: false)
            box(-hx * 0.55, hx * 0.55, size.y, size.y + 0.002, -hz * 0.55, hz * 0.55, Mat.steel)

        case "washerDryer":
            box(-hx, hx, 0, size.y, -hz, hz, Mat.ceramic)

        case "toilet":
            let (axisX, sign) = backSide(object, frame: frame, walls: walls)
            let seat = min(0.42, size.y)
            box(-hx * 0.8, hx * 0.8, 0, seat, -hz * 0.8, hz * 0.8, Mat.ceramic)
            if axisX {
                let x0: Float = sign > 0 ? hx - 0.2 : -hx
                box(x0, x0 + 0.2, seat, size.y, -hz, hz, Mat.ceramic)
            } else {
                let z0: Float = sign > 0 ? hz - 0.2 : -hz
                box(-hx, hx, seat, size.y, z0, z0 + 0.2, Mat.ceramic)
            }

        case "bathtub":
            let rim: Float = 0.07
            box(-hx, hx, 0, size.y, -hz, -hz + rim, Mat.ceramic)
            box(-hx, hx, 0, size.y, hz - rim, hz, Mat.ceramic)
            box(-hx, -hx + rim, 0, size.y, -hz + rim, hz - rim, Mat.ceramic)
            box(hx - rim, hx, 0, size.y, -hz + rim, hz - rim, Mat.ceramic)
            box(-hx + rim, hx - rim, 0, size.y * 0.55, -hz + rim, hz - rim, Mat.water)

        case "fireplace":
            box(-hx, hx, 0, size.y, -hz, hz, Mat.fireplace)

        case "television":
            box(-hx, hx, 0, size.y, -hz, hz, Mat.black, skipBottom: false)

        case "stairs":
            buildStairs(size, frame: frame, into: &mesh)

        default:
            box(-hx, hx, 0, size.y, -hz, hz, Mat.neutral)
        }
    }

    /// Steps rising along the longer horizontal axis.
    static func buildStairs(_ size: Vec3, frame: Transform, into mesh: inout MeshBuilder) {
        let steps = max(2, Int((size.y / 0.18).rounded()))
        let alongX = size.x >= size.z
        let run = alongX ? size.x : size.z
        let hx = size.x / 2, hy = size.y / 2, hz = size.z / 2
        for i in 0..<steps {
            let a = -run / 2 + run * Float(i) / Float(steps)
            let top = size.y * Float(i + 1) / Float(steps)
            let lo = alongX ? Vec3(a, -hy, -hz) : Vec3(-hx, -hy, a)
            let hi = alongX ? Vec3(run / 2, top - hy, hz) : Vec3(hx, top - hy, run / 2)
            mesh.addBox(frame, min: lo, max: hi, material: Mat.woodDark, skipBottom: true)
        }
    }

    /// Which local side (±X or ±Z) of an object faces the nearest wall — where
    /// a sofa's back or a bed's headboard goes. Defaults to −Z.
    static func backSide(_ object: ScanObject, frame: Transform, walls: [WallInfo], maxDistance: Double = 0.9) -> (axisX: Bool, sign: Float) {
        let c = frame.translation
        let ex = frame.xAxis * (object.size.x / 2), ez = frame.zAxis * (object.size.z / 2)
        let sides: [(Bool, Float, Vec3)] = [(true, 1, c + ex), (true, -1, c - ex), (false, 1, c + ez), (false, -1, c - ez)]
        var best: (Bool, Float)? = nil
        var bestD = maxDistance
        for (axisX, sign, p) in sides {
            let q = plan(p)
            for w in walls where Double(p.y) > w.y0 - 0.5 && Double(p.y) < w.y1 {
                let d = distanceToSegment(q, w.a, w.b)
                if d < bestD {
                    bestD = d
                    best = (axisX, sign)
                }
            }
        }
        if let best { return best }
        // Chairs (maxDistance 0) and free-standing pieces: the longer side's back is −Z.
        return (false, -1)
    }

    /// The transform with its rotation re-orthonormalized and any scale removed.
    static func rigid(_ t: Transform) -> Transform {
        let y = vnormalize(t.yAxis)
        var x = t.xAxis - y * vdot(t.xAxis, y)
        x = vnormalize(x)
        let z = vcross(x, y)
        let p = t.translation
        return Transform(columnMajor: [x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, p.x, p.y, p.z, 1])
    }
}
