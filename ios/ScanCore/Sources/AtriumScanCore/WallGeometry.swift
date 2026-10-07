import Foundation

/// Meshes walls: slabs with door/window holes, reveals, casings, baseboards and windows.
enum WallGeometry {
    static let casingWidth = 0.07
    static let casingDepth = 0.016
    static let baseboardHeight = 0.09
    static let baseboardDepth = 0.012

    static func build(_ w: WallInfo, into mesh: inout MeshBuilder) {
        let t = w.thickness
        let along = UVMode.vertical(axis: world(w.u, y: 0), scale: 1)

        // Column decomposition: break the wall at every hole edge; in each
        // column the solid parts are the wall height minus the holes there.
        var cuts = [0.0, w.length]
        for h in w.holes { cuts += [h.s0, h.s1] }
        cuts = uniqueSorted(cuts.map { clamp($0, 0, w.length) })

        func holes(at s: Double) -> [WallHole] { w.holes.filter { $0.s0 <= s && s <= $0.s1 } }
        func solids(at s: Double) -> [(Double, Double)] { subtract(holes(at: s).map { ($0.y0, $0.y1) }, from: (w.y0, w.y1)) }

        for k in 0..<(cuts.count - 1) {
            let s0 = cuts[k], s1 = cuts[k + 1]
            guard s1 - s0 > 1e-4 else { continue }
            for (ya, yb) in solids(at: (s0 + s1) / 2) where yb - ya > 1e-4 {
                // Inside face (toward the room) and outside face.
                mesh.addFace(
                    [w.point(s: s0, y: ya, depth: 0), w.point(s: s1, y: ya, depth: 0), w.point(s: s1, y: yb, depth: 0), w.point(s: s0, y: yb, depth: 0)],
                    normal: world(w.nIn, y: 0), material: Mat.wall, uv: along)
                mesh.addFace(
                    [w.point(s: s0, y: ya, depth: t), w.point(s: s1, y: ya, depth: t), w.point(s: s1, y: yb, depth: t), w.point(s: s0, y: yb, depth: t)],
                    normal: world(-w.nIn, y: 0), material: Mat.wall, uv: along)
            }
            // Top of the wall (seen from above in the dollhouse view).
            if !holes(at: (s0 + s1) / 2).contains(where: { $0.y1 >= w.y1 - 1e-4 }) {
                mesh.addFace(
                    [w.point(s: s0, y: w.y1, depth: 0), w.point(s: s1, y: w.y1, depth: 0), w.point(s: s1, y: w.y1, depth: t), w.point(s: s0, y: w.y1, depth: t)],
                    normal: Vec3(0, 1, 0), material: Mat.wall)
            }
        }

        // End caps.
        for (s, dir) in [(0.0, -1.0), (w.length, 1.0)] {
            for (ya, yb) in solids(at: s) where yb - ya > 1e-4 {
                mesh.addFace(
                    [w.point(s: s, y: ya, depth: 0), w.point(s: s, y: ya, depth: t), w.point(s: s, y: yb, depth: t), w.point(s: s, y: yb, depth: 0)],
                    normal: world(w.u * dir, y: 0), material: Mat.wall)
            }
        }

        // Hole reveals: jambs, head and sill, through the wall's thickness.
        for h in w.holes {
            let lining = h.kind == .window ? Mat.wall : Mat.trim
            if h.s0 > 1e-4 {
                mesh.addFace(
                    [w.point(s: h.s0, y: h.y0, depth: 0), w.point(s: h.s0, y: h.y0, depth: t), w.point(s: h.s0, y: h.y1, depth: t), w.point(s: h.s0, y: h.y1, depth: 0)],
                    normal: world(w.u, y: 0), material: lining)
            }
            if h.s1 < w.length - 1e-4 {
                mesh.addFace(
                    [w.point(s: h.s1, y: h.y0, depth: 0), w.point(s: h.s1, y: h.y0, depth: t), w.point(s: h.s1, y: h.y1, depth: t), w.point(s: h.s1, y: h.y1, depth: 0)],
                    normal: world(-w.u, y: 0), material: lining)
            }
            if h.y1 < w.y1 - 1e-4 {
                mesh.addFace(
                    [w.point(s: h.s0, y: h.y1, depth: 0), w.point(s: h.s1, y: h.y1, depth: 0), w.point(s: h.s1, y: h.y1, depth: t), w.point(s: h.s0, y: h.y1, depth: t)],
                    normal: Vec3(0, -1, 0), material: lining)
            }
            if h.y0 > w.y0 + 1e-4 {
                mesh.addFace(
                    [w.point(s: h.s0, y: h.y0, depth: 0), w.point(s: h.s1, y: h.y0, depth: 0), w.point(s: h.s1, y: h.y0, depth: t), w.point(s: h.s0, y: h.y0, depth: t)],
                    normal: Vec3(0, 1, 0), material: lining)
            }
            switch h.kind {
            case .door: addCasing(h, w, into: &mesh)
            case .window where h.primary: addWindow(h, w, into: &mesh)
            default: break
            }
        }

        addBaseboard(w, into: &mesh)
    }

    /// A box in wall-local coordinates.
    static func addBox(_ w: WallInfo, s: (Double, Double), y: (Double, Double), depth: (Double, Double), material: String, into mesh: inout MeshBuilder) {
        guard s.1 - s.0 > 1e-4, y.1 - y.0 > 1e-4, depth.1 - depth.0 > 1e-5 else { return }
        mesh.addBox(material: material) { i, j, k in
            w.point(s: i == 0 ? s.0 : s.1, y: j == 0 ? y.0 : y.1, depth: k == 0 ? depth.0 : depth.1)
        }
    }

    /// Door casing on the room side: two legs and a head.
    static func addCasing(_ h: WallHole, _ w: WallInfo, into mesh: inout MeshBuilder) {
        let cw = casingWidth, d = (-casingDepth, 0.0)
        let top = min(h.y1 + cw, w.y1)
        addBox(w, s: (max(0, h.s0 - cw), h.s0), y: (h.y0, top), depth: d, material: Mat.trim, into: &mesh)
        addBox(w, s: (h.s1, min(w.length, h.s1 + cw)), y: (h.y0, top), depth: d, material: Mat.trim, into: &mesh)
        if h.y1 + 1e-3 < w.y1 {
            addBox(w, s: (max(0, h.s0 - cw), min(w.length, h.s1 + cw)), y: (h.y1, top), depth: d, material: Mat.trim, into: &mesh)
        }
    }

    /// Frame, mullion, sill and a softly glowing "daylight" pane.
    static func addWindow(_ h: WallHole, _ w: WallInfo, into mesh: inout MeshBuilder) {
        let t = w.thickness
        let fw = 0.045
        let band = (t * 0.38, t * 0.62)
        addBox(w, s: (h.s0, h.s0 + fw), y: (h.y0, h.y1), depth: band, material: Mat.windowFrame, into: &mesh)
        addBox(w, s: (h.s1 - fw, h.s1), y: (h.y0, h.y1), depth: band, material: Mat.windowFrame, into: &mesh)
        addBox(w, s: (h.s0 + fw, h.s1 - fw), y: (h.y1 - fw, h.y1), depth: band, material: Mat.windowFrame, into: &mesh)
        addBox(w, s: (h.s0 + fw, h.s1 - fw), y: (h.y0, h.y0 + fw), depth: band, material: Mat.windowFrame, into: &mesh)
        if h.s1 - h.s0 > 0.8 {
            let c = (h.s0 + h.s1) / 2
            addBox(w, s: (c - fw / 2, c + fw / 2), y: (h.y0 + fw, h.y1 - fw), depth: band, material: Mat.windowFrame, into: &mesh)
        }
        let paneDepth = t * 0.56
        mesh.addFace(
            [
                w.point(s: h.s0, y: h.y0, depth: paneDepth), w.point(s: h.s1, y: h.y0, depth: paneDepth),
                w.point(s: h.s1, y: h.y1, depth: paneDepth), w.point(s: h.s0, y: h.y1, depth: paneDepth),
            ], normal: world(w.nIn, y: 0), material: Mat.daylight, uv: UVMode.vertical(axis: world(w.u, y: 0), scale: Float(max(h.s1 - h.s0, 0.1))))
        if h.y0 > w.y0 + 0.15 {
            addBox(w, s: (max(0, h.s0 - 0.04), min(w.length, h.s1 + 0.04)), y: (h.y0 - 0.035, h.y0), depth: (-0.05, band.0), material: Mat.trim, into: &mesh)
        }
    }

    /// Baseboard along the inside face, interrupted by doors and openings.
    static func addBaseboard(_ w: WallInfo, into mesh: inout MeshBuilder) {
        let top = w.y0 + baseboardHeight
        let blockers = w.holes.filter { $0.y0 < top }.map { ($0.s0, $0.s1) }
        for (s0, s1) in subtract(blockers, from: (0, w.length)) where s1 - s0 > 0.05 {
            addBox(w, s: (s0, s1), y: (w.y0, top), depth: (-baseboardDepth, 0), material: Mat.trim, into: &mesh)
        }
    }

    // MARK: Interval helpers

    static func uniqueSorted(_ values: [Double]) -> [Double] {
        var out: [Double] = []
        for v in values.sorted() where out.last.map({ v - $0 > 1e-4 }) ?? true { out.append(v) }
        return out
    }

    /// `range` minus the union of `cuts`, as sorted disjoint intervals.
    static func subtract(_ cuts: [(Double, Double)], from range: (Double, Double)) -> [(Double, Double)] {
        var out: [(Double, Double)] = []
        var cursor = range.0
        for (c0, c1) in cuts.sorted(by: { $0.0 < $1.0 }) {
            if c1 <= cursor { continue }
            if c0 > cursor { out.append((cursor, min(c0, range.1))) }
            cursor = max(cursor, c1)
            if cursor >= range.1 { break }
        }
        if cursor < range.1 { out.append((cursor, range.1)) }
        return out.filter { $0.1 - $0.0 > 1e-6 }
    }
}
