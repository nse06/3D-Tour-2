import AtriumScanCore
import SwiftUI
import simd

/// The room being scanned, seen from above and turned so the phone looks up the map: walls, floor
/// and furniture in green where a photo already covers them well, amber where only from the side or
/// far away, red where no photo has yet (a thin gray line: wall hidden behind furniture). Red on the
/// map's left is the wall on your left.
struct CoverageMapView: View {
    let coverage: CaptureCoverage
    /// Where the phone is (plan x, z) and which way it looks (plan direction).
    let position: SIMD2<Double>?
    let forward: SIMD2<Double>?

    static func color(_ level: CaptureCoverage.Level) -> Color {
        switch level {
        case .good: Color(red: 0.30, green: 0.78, blue: 0.42)
        case .weak: Color(red: 0.98, green: 0.70, blue: 0.20)
        case .missing: Color(red: 0.94, green: 0.33, blue: 0.29)
        }
    }

    var body: some View {
        Canvas { context, size in
            guard coverage.outline.count >= 3 else { return }
            // Heading up: the phone's forward direction points to the top of the map.
            var f = SIMD2<Double>(0, -1)
            if let forward, simd_length(forward) > 1e-6 { f = simd_normalize(forward) }
            let angle = -Double.pi / 2 - atan2(f.y, f.x)
            let c = cos(angle), s = sin(angle)
            func turned(_ p: SIMD2<Double>) -> SIMD2<Double> { SIMD2(p.x * c - p.y * s, p.x * s + p.y * c) }
            // Turning the phone turns the map about the room's middle without zooming it: the scale
            // fits the room (and the phone, if it's just outside) at every angle.
            let outline = coverage.outline
            let lo = outline.reduce(outline[0]) { simd_min($0, $1) }, hi = outline.reduce(outline[0]) { simd_max($0, $1) }
            let mid = (lo + hi) / 2
            var radius = outline.map { simd_length($0 - mid) }.max() ?? 1
            if let position { radius = max(radius, min(simd_length(position - mid) + 0.3, 2 * radius)) }
            let pad: Double = 8
            let scale = (min(Double(size.width), Double(size.height)) / 2 - pad) / max(radius, 0.25)
            func screen(_ p: SIMD2<Double>) -> CGPoint {
                let q = turned(p - mid)
                return CGPoint(x: Double(size.width) / 2 + q.x * scale, y: Double(size.height) / 2 + q.y * scale)
            }
            func polygon(_ corners: [SIMD2<Double>]) -> Path {
                var path = Path()
                path.addLines(corners.map(screen))
                path.closeSubpath()
                return path
            }

            // The floor, square by square.
            let h = coverage.cellSize / 2
            for cell in coverage.floor {
                let c = cell.center
                let square = polygon([c + SIMD2(-h, -h), c + SIMD2(h, -h), c + SIMD2(h, h), c + SIMD2(-h, h)])
                context.fill(square, with: .color(Self.color(cell.level).opacity(0.38)))
            }
            // Furniture.
            for item in coverage.items {
                let shape = polygon(item.corners)
                context.fill(shape, with: .color(Self.color(item.level).opacity(0.75)))
                context.stroke(shape, with: .color(.white.opacity(0.7)), lineWidth: 1)
            }
            // Walls, stretch by stretch.
            for wall in coverage.walls where !wall.levels.isEmpty {
                let n = Double(wall.levels.count)
                for (i, level) in wall.levels.enumerated() {
                    var path = Path()
                    path.move(to: screen(wall.a + (wall.b - wall.a) * (Double(i) / n)))
                    path.addLine(to: screen(wall.a + (wall.b - wall.a) * (Double(i + 1) / n)))
                    if let level {
                        context.stroke(path, with: .color(Self.color(level)), style: StrokeStyle(lineWidth: 5, lineCap: .butt))
                    } else {
                        // Behind furniture: nothing to photograph.
                        context.stroke(path, with: .color(.white.opacity(0.4)), style: StrokeStyle(lineWidth: 2.5, lineCap: .butt))
                    }
                }
            }
            // The phone: a dot and its view, pointing up.
            if let position {
                let p = screen(position)
                var cone = Path()
                cone.move(to: p)
                cone.addLine(to: CGPoint(x: p.x - 16, y: p.y - 26))
                cone.addLine(to: CGPoint(x: p.x + 16, y: p.y - 26))
                cone.closeSubpath()
                context.fill(cone, with: .color(.white.opacity(0.35)))
                context.fill(Path(ellipseIn: CGRect(x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9)), with: .color(.white))
            }
        }
        .accessibilityLabel(Self.summary(coverage) ?? "Photo coverage map")
    }

    struct Share: Identifiable {
        let name: String
        let percent: Int
        var id: String { name }
    }

    /// Shares covered well (walls 80%, floor 55%, furniture 60%), for what the room has.
    static func shares(_ coverage: CaptureCoverage) -> [Share] {
        [("Walls", coverage.wallShare), ("Floor", coverage.floorShare), ("Furniture", coverage.itemShare)].compactMap { name, share in
            share.map { Share(name: name, percent: Int(($0 * 100).rounded())) }
        }
    }

    /// "Walls 80% · Floor 55% · Furniture 60%".
    static func summary(_ coverage: CaptureCoverage) -> String? {
        let parts = shares(coverage).map { "\($0.name) \($0.percent)%" }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
