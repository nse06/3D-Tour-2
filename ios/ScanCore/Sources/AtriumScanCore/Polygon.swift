import Foundation

// Plan-view (x, z) polygon helpers. Polygons are open (last point ≠ first).

/// Shoelace area: positive when the points run counter-clockwise in (x, z).
func signedArea(_ poly: [P2]) -> Double {
    guard poly.count >= 3 else { return 0 }
    var sum = 0.0
    for i in poly.indices {
        let a = poly[i], b = poly[(i + 1) % poly.count]
        sum += a.x * b.y - b.x * a.y
    }
    return sum / 2
}

func area(_ poly: [P2]) -> Double { abs(signedArea(poly)) }

/// Area centroid (falls back to the vertex average for degenerate polygons).
func centroid(_ poly: [P2]) -> P2 {
    let a = signedArea(poly)
    guard abs(a) > 1e-9 else {
        return poly.isEmpty ? P2(0, 0) : poly.reduce(P2(0, 0), +) / Double(poly.count)
    }
    var c = P2(0, 0)
    for i in poly.indices {
        let p = poly[i], q = poly[(i + 1) % poly.count]
        let k = p.x * q.y - q.x * p.y
        c += (p + q) * k
    }
    return c / (6 * a)
}

func pointInPolygon(_ p: P2, _ poly: [P2]) -> Bool {
    var inside = false
    var j = poly.count - 1
    for i in poly.indices {
        let a = poly[i], b = poly[j]
        if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside.toggle()
        }
        j = i
    }
    return inside
}

func distanceToSegment(_ p: P2, _ a: P2, _ b: P2) -> Double {
    let ab = b - a
    let len2 = pdot(ab, ab)
    let t = len2 > 1e-12 ? clamp(pdot(p - a, ab) / len2, 0, 1) : 0
    return plength(p - (a + ab * t))
}

func distanceToBoundary(_ p: P2, _ poly: [P2]) -> Double {
    var best = Double.infinity
    for i in poly.indices {
        best = min(best, distanceToSegment(p, poly[i], poly[(i + 1) % poly.count]))
    }
    return best
}

/// Removes repeated and collinear points; nil if fewer than 3 remain or the area is negligible.
func cleanPolygon(_ input: [P2], minEdge: Double = 0.01) -> [P2]? {
    var pts: [P2] = []
    for p in input where p.x.isFinite && p.y.isFinite {
        if let last = pts.last, plength(p - last) < minEdge { continue }
        pts.append(p)
    }
    while pts.count > 1, plength(pts[0] - pts[pts.count - 1]) < minEdge { pts.removeLast() }
    var changed = true
    while changed && pts.count >= 3 {
        changed = false
        for i in pts.indices {
            let prev = pts[(i + pts.count - 1) % pts.count], cur = pts[i], next = pts[(i + 1) % pts.count]
            let e1 = cur - prev, e2 = next - cur
            // Collinear (or a spike that doubles back) → drop the middle point.
            if abs(pcross(e1, e2)) < 1e-4 * max(plength(e1) * plength(e2), 1e-9) {
                pts.remove(at: i)
                changed = true
                break
            }
        }
    }
    guard pts.count >= 3, area(pts) > 0.05 else { return nil }
    return pts
}

/// Ear-clipping triangulation of a simple polygon (convex or concave). Returns
/// index triples in counter-clockwise (x, z) order.
func triangulate(_ poly: [P2]) -> [(Int, Int, Int)] {
    let n = poly.count
    guard n >= 3 else { return [] }
    var idx = Array(0..<n)
    if signedArea(poly) < 0 { idx.reverse() }
    var tris: [(Int, Int, Int)] = []

    func isEar(_ i: Int) -> Bool {
        let a = poly[idx[(i + idx.count - 1) % idx.count]], b = poly[idx[i]], c = poly[idx[(i + 1) % idx.count]]
        guard pcross(b - a, c - b) > 1e-12 else { return false }  // reflex or degenerate
        for k in idx.indices where k != i && k != (i + 1) % idx.count && k != (i + idx.count - 1) % idx.count {
            let p = poly[idx[k]]
            if p == a || p == b || p == c { continue }
            if pcross(b - a, p - a) >= 0, pcross(c - b, p - b) >= 0, pcross(a - c, p - c) >= 0 { return false }
        }
        return true
    }

    var guardCount = 0
    while idx.count > 3 && guardCount < n * n {
        guardCount += 1
        var clipped = false
        for i in idx.indices where isEar(i) {
            tris.append((idx[(i + idx.count - 1) % idx.count], idx[i], idx[(i + 1) % idx.count]))
            idx.remove(at: i)
            clipped = true
            break
        }
        if !clipped { break }
    }
    if idx.count == 3 {
        tris.append((idx[0], idx[1], idx[2]))
    } else if idx.count > 3 {
        // Self-intersecting leftovers: fan them so the floor still has no hole.
        for k in 1..<(idx.count - 1) { tris.append((idx[0], idx[k], idx[k + 1])) }
    }
    return tris
}

/// The interior point farthest from the boundary (searched on a grid) — a
/// stand-in for the centroid that is always inside, even for L-shaped rooms.
func interiorCenter(_ poly: [P2], step: Double = 0.1) -> P2 {
    let c = centroid(poly)
    var best = c
    var bestD = pointInPolygon(c, poly) ? distanceToBoundary(c, poly) : -1
    let xs = poly.map(\.x), zs = poly.map(\.y)
    guard let minX = xs.min(), let maxX = xs.max(), let minZ = zs.min(), let maxZ = zs.max() else { return c }
    let s = max(step, max(maxX - minX, maxZ - minZ) / 120)
    var x = minX + s / 2
    while x < maxX {
        var z = minZ + s / 2
        while z < maxZ {
            let p = P2(x, z)
            if pointInPolygon(p, poly) {
                let d = distanceToBoundary(p, poly)
                if d > bestD + 1e-9 {
                    bestD = d
                    best = p
                }
            }
            z += s
        }
        x += s
    }
    return best
}
