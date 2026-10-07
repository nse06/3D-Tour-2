import Foundation

// Multi-room scans arrive in one coordinate frame per room.
//
// When a RoomPlan room capture starts, RoomCaptureView moves the AR world origin
// to the phone's position at that moment (ARSession.setWorldOrigin, a pure
// shift). Each room — and the path and photos recorded from its start until the
// next room starts, its "segment" — is therefore expressed relative to where
// that room's scan began. RoomPlan's StructureBuilder puts rooms back together
// from tracking data apps can't read. This file recovers the same placement:
//
// 1. Structure fit. The merged structure keeps the identifiers of walls, doors,
//    windows, openings and objects. For each room, the motion (a turn about +Y,
//    then a shift) that best maps its elements onto the merged ones places it.
// 2. Path links. At each origin reset the recorded camera path jumps back to
//    (0, 0, 0). The jump measures the shift between consecutive frames, which
//    places rooms and photos that the structure doesn't cover.
// 3. Doorway snapping. Both rooms of a doorway saw it; the leftover offset
//    between the two views is removed.

/// A rigid motion that keeps "up" up: a turn about +Y by `yaw` radians (the
/// same sense as `Transform.rotationY`), then a shift by `t`.
public struct Motion: Codable, Sendable, Equatable {
    public var yaw: Double
    public var t: Vec3

    public static let identity = Motion(yaw: 0, t: Vec3(0, 0, 0))

    public init(yaw: Double, t: Vec3) {
        self.yaw = wrapAngle(yaw)
        self.t = t
    }

    public var transform: Transform { Transform.translating(t) * Transform.rotationY(Float(yaw)) }

    func rotate(_ v: Vec3) -> Vec3 {
        let c = Float(cos(yaw)), s = Float(sin(yaw))
        return Vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z)
    }

    public func apply(_ p: Vec3) -> Vec3 { rotate(p) + t }

    /// This motion applied after `first`.
    public func after(_ first: Motion) -> Motion { Motion(yaw: yaw + first.yaw, t: rotate(first.t) + t) }

    public var inverse: Motion {
        let back = Motion(yaw: -yaw, t: Vec3(0, 0, 0))
        return Motion(yaw: -yaw, t: -back.rotate(t))
    }
}

/// One room as RoomPlan delivered it, in the frame of its capture segment.
public struct RoomPart: Sendable {
    public var room: ScanRoom
    public var walls: [ScanWall]
    public var openings: [ScanOpening]
    public var objects: [ScanObject]
    /// The RoomPlan run (0, 1, …) that scanned the room; nil if unknown (scans
    /// from app builds that didn't record it).
    public var segment: Int?

    public init(room: ScanRoom, walls: [ScanWall] = [], openings: [ScanOpening] = [], objects: [ScanObject] = [], segment: Int? = nil) {
        self.room = room
        self.walls = walls
        self.openings = openings
        self.objects = objects
        self.segment = segment
    }

    func moved(by m: Motion) -> RoomPart {
        let t = m.transform
        var copy = self
        copy.room.floorPolygon = room.floorPolygon.map(m.apply)
        copy.room.floorY = room.floorY + m.t.y
        copy.room.ceilingY = room.ceilingY + m.t.y
        copy.walls = walls.map { var w = $0; w.transform = t * $0.transform; return w }
        copy.openings = openings.map { var o = $0; o.transform = t * $0.transform; return o }
        copy.objects = objects.map { var o = $0; o.transform = t * $0.transform; return o }
        return copy
    }
}

/// How the rooms of a scan were put into one frame (saved with the scan, shown in the app).
public struct AlignmentReport: Codable, Sendable, Equatable {
    public enum Method: String, Codable, Sendable {
        /// Placed on RoomPlan's merged structure.
        case structure
        /// Placed by following the recorded path from a neighbouring room.
        case path
        /// Kept as recorded (a single room, or rooms already sharing one frame).
        case asRecorded
        /// No way to place it was found; kept where RoomPlan reported it.
        case unplaced
    }

    public struct Room: Codable, Sendable, Equatable {
        public var id: String
        public var name: String
        public var segment: Int?
        public var method: Method
        /// Elements matched with the merged structure.
        public var matchedElements: Int
        /// RMS distance of those elements from the merged structure's, meters.
        public var residual: Double?
        /// How far doorway snapping moved the room, meters.
        public var doorwayShift: Double
    }

    public var rooms: [Room]
    /// Coordinate frames found (RoomPlan runs).
    public var segments: Int
    /// Origin resets found in the recorded path.
    public var pathResets: Int
    /// Doorways seen from both of their rooms and lined up.
    public var doorwayPairs: Int
    public var pathSamples: Int
    public var pathSamplesDropped: Int
    public var frames: Int
    public var framesDropped: Int

    /// One sentence for the app: how the rooms were placed.
    public var summary: String {
        let n = rooms.count
        let unplaced = rooms.filter { $0.method == .unplaced }.count
        let fromStructure = rooms.filter { $0.method == .structure }.count
        var parts: [String] = []
        if n <= 1 {
            parts.append("Single room")
        } else if unplaced == n {
            parts.append("Rooms kept as recorded (no layout data)")
        } else if fromStructure == n {
            parts.append("\(n) rooms placed with RoomPlan's merged layout")
        } else if fromStructure > 0 {
            parts.append("\(n - unplaced) of \(n) rooms placed with RoomPlan's merged layout and your path")
        } else {
            parts.append("\(n - unplaced) of \(n) rooms placed by following your path")
        }
        if doorwayPairs > 0 { parts.append("\(doorwayPairs) doorway\(doorwayPairs == 1 ? "" : "s") lined up") }
        return parts.joined(separator: " · ")
    }
}

public struct AlignedCapture: Sendable {
    /// Everything in one frame, ready for `ScanProcessor.process`.
    public var scan: CaptureScan
    public var report: AlignmentReport
}

public enum RoomAlignment {
    /// Puts rooms scanned in separate RoomPlan runs into one frame.
    ///
    /// - Parameters:
    ///   - parts: the rooms, each in its own segment's frame, in capture order.
    ///   - structure: element poses in RoomPlan's merged structure, by element identifier (nil if unavailable).
    ///   - path: the raw camera path (each sample in its segment's frame).
    ///   - frames: the raw photos (each in its segment's frame).
    public static func align(
        parts: [RoomPart], structure: [String: Transform]?, path: [PoseSample], frames: [CameraFrame], capturedAt: String? = nil,
        device: DeviceInfo? = nil
    ) -> AlignedCapture {
        let cleanPath = path.filter { $0.t.isFinite && isFinite($0.p) && isFinite($0.f) }.sorted { $0.t < $1.t }
        let seg = segmentPath(cleanPath)

        // 1. Structure fits.
        let fits: [Fit?] = parts.map { part in structure.flatMap { fitToStructure(part, $0) }.flatMap { $0.residual < 0.3 ? $0 : nil } }
        let fitted = fits.contains { $0 != nil }
        // Rooms that already share a frame: a single room, or an old capture with no resets to undo.
        let oneFrame = !fitted && (parts.count <= 1 || (seg.resets == 0 && parts.allSatisfy { $0.segment == nil }))
        let partSegments: [Int?] = oneFrame ? parts.map { _ in 0 } : segmentsOfParts(parts, fits: fits, path: cleanPath, segmentation: seg)

        // 2. One motion per segment: from a fitted room, else chained along the path's links.
        var segMotion: [Int: Motion] = [:]
        var bestResidual: [Int: Double] = [:]
        for (k, fit) in fits.enumerated() {
            guard let fit, let s = partSegments[k], fit.residual < bestResidual[s] ?? .infinity else { continue }
            segMotion[s] = fit.motion
            bestResidual[s] = fit.residual
        }
        if segMotion.isEmpty { segMotion[partSegments.compactMap { $0 }.min() ?? 0] = .identity }
        let parent = propagate(&segMotion, links: seg.links)

        var motions: [Motion?] = []
        var methods: [AlignmentReport.Method] = []
        for k in parts.indices {
            if let fit = fits[k] {
                motions.append(fit.motion)
                methods.append(.structure)
            } else if oneFrame {
                motions.append(.identity)
                methods.append(.asRecorded)
            } else if let s = partSegments[k], let m = segMotion[s] {
                motions.append(m)
                methods.append(.path)
            } else {
                motions.append(nil)
                methods.append(.unplaced)
            }
        }

        // 3. Doorway snapping (a plan shift per room).
        let snap = doorwayCorrections(parts: parts, motions: motions)
        func shift(_ c: P2) -> Motion { Motion(yaw: 0, t: Vec3(Float(c.x), 0, Float(c.y))) }
        // A segment placed by following the path from another inherits that one's doorway shift,
        // unless a room of its own was lined up at a doorway (or placed on the structure).
        var inherited: [Int: P2] = [:]
        func correction(ofSegment s: Int, depth: Int = 0) -> P2 {
            if let c = inherited[s] { return c }
            var c = P2(0, 0)
            if let own = parts.indices.first(where: { partSegments[$0] == s && (snap.snapped.contains($0) || methods[$0] == .structure) }) {
                c = snap.corrections[own]
            } else if let p = parent[s], depth < 64 {
                c = correction(ofSegment: p, depth: depth + 1)
            }
            inherited[s] = c
            return c
        }
        let corrections = parts.indices.map { k -> P2 in
            if snap.snapped.contains(k) || methods[k] == .structure { return snap.corrections[k] }
            if methods[k] == .path, let s = partSegments[k] { return correction(ofSegment: s) }
            return snap.corrections[k]
        }
        let finalMotions = parts.indices.map { shift(corrections[$0]).after(motions[$0] ?? .identity) }

        // Path and photos follow the room scanned in their segment.
        var segFinal: [Int: Motion] = [:]
        for s in 0..<max(seg.count, 1) {
            if let owner = parts.indices.first(where: { partSegments[$0] == s && motions[$0] != nil }) {
                segFinal[s] = finalMotions[owner]
            } else if let m = segMotion[s] {
                segFinal[s] = shift(correction(ofSegment: s)).after(m)
            }
        }

        var scan = CaptureScan(rooms: [], capturedAt: capturedAt, device: device)
        for (k, part) in parts.enumerated() {
            let moved = part.moved(by: finalMotions[k])
            scan.rooms.append(moved.room)
            scan.walls += moved.walls
            scan.openings += moved.openings
            scan.objects += moved.objects
        }
        var dropped = 0
        for (i, sample) in cleanPath.enumerated() {
            guard let m = segFinal[seg.segmentOfSample[i]] else {
                dropped += 1
                continue
            }
            scan.trajectory.append(PoseSample(t: sample.t, p: m.apply(sample.p), f: m.rotate(sample.f)))
        }
        var framesDropped = 0
        for frame in frames {
            guard frame.transform.isFinite, frame.t.isFinite, let s = segmentOfFrame(frame, path: cleanPath, segmentation: seg), let m = segFinal[s] else {
                framesDropped += 1
                continue
            }
            var f = frame
            f.transform = m.transform * frame.transform
            f.segment = nil
            scan.frames.append(f)
        }

        let report = AlignmentReport(
            rooms: parts.indices.map { k in
                AlignmentReport.Room(
                    id: parts[k].room.id, name: parts[k].room.name, segment: partSegments[k], method: methods[k],
                    matchedElements: fits[k]?.matched ?? 0, residual: fits[k].map { rounded($0.residual, 3) },
                    doorwayShift: rounded(plength(corrections[k]), 3))
            },
            segments: seg.count, pathResets: seg.resets, doorwayPairs: snap.pairs, pathSamples: scan.trajectory.count, pathSamplesDropped: dropped,
            frames: scan.frames.count, framesDropped: framesDropped)
        return AlignedCapture(scan: scan, report: report)
    }

    // MARK: Path segments

    struct Link {
        let from: Int
        let to: Int
        let motion: Motion
        /// First path sample in frame `from`.
        let at: Int
    }

    struct Segmentation {
        /// Segment of each path sample.
        var segmentOfSample: [Int]
        /// Each link maps frame `from` into the frame of the run before it, `to`.
        var links: [Link]
        var count: Int
        /// Origin resets seen in the path.
        var resets: Int
    }

    /// Splits the path at RoomPlan's origin resets. Samples tagged with their
    /// run are trusted, except that a run's first samples may still predate its
    /// reset (the reset lands a few frames after the run starts).
    static func segmentPath(_ s: [PoseSample]) -> Segmentation {
        guard !s.isEmpty else { return Segmentation(segmentOfSample: [], links: [], count: 0, resets: 0) }
        var segment = [Int](repeating: 0, count: s.count)
        var links: [Link] = []
        var resets = 0

        if s.contains(where: { $0.segment != nil }) {
            var current = s.first { $0.segment != nil }?.segment ?? 0
            for i in s.indices {
                if let tag = s[i].segment { current = tag }
                segment[i] = current
            }
            var i = 1
            while i < s.count {
                guard segment[i] != segment[i - 1] else {
                    i += 1
                    continue
                }
                let tag = segment[i], previous = segment[i - 1], start = i
                // The reset: the first jump back to the origin within a few seconds of the run starting.
                var reset: Int?
                var j = start
                while j < s.count, segment[j] == tag, s[j].t - s[start].t < 4 {
                    if isReset(s[j - 1], s[j], sensitive: true) {
                        reset = j
                        break
                    }
                    j += 1
                }
                if let reset {
                    for k in start..<reset { segment[k] = previous }
                    links.append(Link(from: tag, to: previous, motion: link(s, at: reset), at: reset))
                    resets += 1
                    i = reset + 1
                } else {
                    // No visible jump: the phone was (almost) where the previous run's origin was.
                    links.append(Link(from: tag, to: previous, motion: .identity, at: start))
                    i = start + 1
                }
            }
            return Segmentation(segmentOfSample: segment, links: links, count: (segment.max() ?? 0) + 1, resets: resets)
        }

        var current = 0
        for i in s.indices {
            if i > 0, isReset(s[i - 1], s[i], sensitive: false) {
                current += 1
                resets += 1
                links.append(Link(from: current, to: current - 1, motion: link(s, at: i), at: i))
            }
            segment[i] = current
        }
        return Segmentation(segmentOfSample: segment, links: links, count: current + 1, resets: resets)
    }

    /// Whether the path jumps from `a` to `b` because the world origin moved to
    /// the phone: `b` sits at the new origin, far from where `a` was.
    static func isReset(_ a: PoseSample, _ b: PoseSample, sensitive: Bool) -> Bool {
        let dt = max(0.005, min(b.t - a.t, 2))
        let reach = Float(0.08 + 1.6 * dt)  // how far a hand-held phone moves in dt
        let jump = vlength(b.p - a.p)
        if sensitive {
            return jump > reach + 0.1 && vlength(b.p) < reach + 0.06 && vlength(a.p) > 0.15
        }
        return jump > max(0.3, reach + 0.05) && vlength(b.p) < reach + 0.1 && vlength(a.p) > 0.3
    }

    /// The shift from the new frame (sample `i` on) into the old one, assuming
    /// the phone kept its speed across the gap.
    static func link(_ s: [PoseSample], at i: Int) -> Motion {
        var v = Vec3(0, 0, 0)
        var n: Float = 0
        if i >= 2 {
            let dt = s[i - 1].t - s[i - 2].t
            if dt > 0.001, dt < 1 {
                v += (s[i - 1].p - s[i - 2].p) / Float(dt)
                n += 1
            }
        }
        if i + 1 < s.count, !isReset(s[i], s[i + 1], sensitive: false) {
            let dt = s[i + 1].t - s[i].t
            if dt > 0.001, dt < 1 {
                v += (s[i + 1].p - s[i].p) / Float(dt)
                n += 1
            }
        }
        if n > 0 { v /= n }
        let speed = vlength(v)
        if speed > 1.5 { v *= 1.5 / speed }
        let dt = Float(clamp(s[i].t - s[i - 1].t, 0, 1))
        let oldPositionThen = s[i - 1].p + v * dt
        return Motion(yaw: 0, t: oldPositionThen - s[i].p)
    }

    /// Fills in segments reachable through links. Returns, for each filled-in
    /// segment, the segment it was derived from.
    @discardableResult
    static func propagate(_ motion: inout [Int: Motion], links: [Link]) -> [Int: Int] {
        var parent: [Int: Int] = [:]
        var changed = true
        while changed {
            changed = false
            for l in links {
                if motion[l.from] == nil, let to = motion[l.to] {
                    motion[l.from] = to.after(l.motion)
                    parent[l.from] = l.to
                    changed = true
                } else if motion[l.to] == nil, let from = motion[l.from] {
                    motion[l.to] = from.after(l.motion.inverse)
                    parent[l.to] = l.from
                    changed = true
                }
            }
        }
        return parent
    }

    /// Segment of each room: its recorded run; for older captures, the runs in
    /// order. A rescanned room leaves an extra run behind; then every way of
    /// skipping the extra runs is tried, keeping the one where rooms don't
    /// overlap and the path stays continuous.
    static func segmentsOfParts(_ parts: [RoomPart], fits: [Fit?], path: [PoseSample], segmentation seg: Segmentation) -> [Int?] {
        if parts.contains(where: { $0.segment != nil }) { return parts.map(\.segment) }
        guard seg.count > 0, !parts.isEmpty else { return parts.map { _ in nil } }
        guard seg.count > parts.count else { return parts.indices.map { $0 < seg.count ? $0 : nil } }
        let extra = seg.count - parts.count
        guard extra <= 3 else { return Array(parts.indices) }

        var best: (assignment: [Int], penalty: Double)?
        func visit(_ skipped: [Int], from: Int) {
            if skipped.count == extra {
                let assignment = (0..<seg.count).filter { !skipped.contains($0) }
                let penalty = inconsistency(parts, fits: fits, assignment: assignment, path: path, segmentation: seg)
                if penalty < best?.penalty ?? .infinity { best = (assignment, penalty) }
                return
            }
            guard from < seg.count else { return }
            for s in from..<seg.count { visit(skipped + [s], from: s + 1) }
        }
        visit([], from: 0)
        return best?.assignment.map { Optional($0) } ?? Array(parts.indices)
    }

    /// How implausible a room-to-run assignment is: overlap between the placed
    /// rooms plus jumps in the placed path at origin resets.
    static func inconsistency(_ parts: [RoomPart], fits: [Fit?], assignment: [Int], path: [PoseSample], segmentation seg: Segmentation) -> Double {
        var segMotion: [Int: Motion] = [:]
        for (k, fit) in fits.enumerated() { if let fit { segMotion[assignment[k]] = fit.motion } }
        if segMotion.isEmpty { segMotion[assignment[0]] = .identity }
        propagate(&segMotion, links: seg.links)

        // Overlap of the placed floors, on a 20 cm grid.
        let polys: [[P2]] = parts.indices.compactMap { k in
            guard let m = fits[k]?.motion ?? segMotion[assignment[k]] else { return nil }
            return parts[k].room.floorPolygon.map { plan(m.apply($0)) }
        }
        let all = polys.flatMap { $0 }
        var overlap = 0.0, covered = 0.0
        if let minX = all.map(\.x).min(), let maxX = all.map(\.x).max(), let minZ = all.map(\.y).min(), let maxZ = all.map(\.y).max() {
            let step = max(0.2, max(maxX - minX, maxZ - minZ) / 300)
            var x = minX + step / 2
            while x < maxX {
                var z = minZ + step / 2
                while z < maxZ {
                    let n = polys.filter { pointInPolygon(P2(x, z), $0) }.count
                    if n > 0 { covered += 1 }
                    if n > 1 { overlap += 1 }
                    z += step
                }
                x += step
            }
        }
        // Path continuity across each reset.
        var gaps = 0.0
        for l in seg.links where l.at < path.count {
            guard let new = segMotion[l.from], let old = segMotion[l.to] else { continue }
            let p = path[l.at].p
            gaps += Double(min(3, vlength(new.apply(p) - old.apply(l.motion.apply(p)))))
        }
        return 5 * overlap / max(covered, 1) + gaps / Double(max(seg.links.count, 1))
    }

    /// A photo's segment: that of the path sample it was taken with.
    static func segmentOfFrame(_ frame: CameraFrame, path: [PoseSample], segmentation seg: Segmentation) -> Int? {
        guard !path.isEmpty else { return frame.segment ?? 0 }
        var lo = 0, hi = path.count - 1
        while lo < hi {
            let mid = (lo + hi) / 2
            if path[mid].t < frame.t { lo = mid + 1 } else { hi = mid }
        }
        var best = lo
        if lo > 0, abs(path[lo - 1].t - frame.t) <= abs(path[lo].t - frame.t) { best = lo - 1 }
        if abs(path[best].t - frame.t) < 0.06 { return seg.segmentOfSample[best] }
        // Between samples: the side whose position matches the photo's.
        let p = frame.transform.translation
        let before = path[max(0, lo - 1)], after = path[min(path.count - 1, lo)]
        let i = vlength(p - before.p) <= vlength(p - after.p) ? max(0, lo - 1) : min(path.count - 1, lo)
        return seg.segmentOfSample[i]
    }

    // MARK: Structure fit

    struct Fit {
        var motion: Motion
        var residual: Double
        var matched: Int
    }

    /// The motion mapping a room's elements onto the same elements in the
    /// merged structure. Walls only constrain their normal direction, since the
    /// merge may trim or extend them.
    static func fitToStructure(_ part: RoomPart, _ structure: [String: Transform]) -> Fit? {
        var pairs: [FitPair] = []
        for w in part.walls { if let t = structure[w.id], t.isFinite, w.transform.isFinite { pairs.append(FitPair(source: w.transform, target: t, isWall: true)) } }
        for o in part.openings { if let t = structure[o.id], t.isFinite, o.transform.isFinite { pairs.append(FitPair(source: o.transform, target: t, isWall: false)) } }
        for o in part.objects { if let t = structure[o.id], t.isFinite, o.transform.isFinite { pairs.append(FitPair(source: o.transform, target: t, isWall: false)) } }
        guard !pairs.isEmpty else { return nil }

        // Turn: every element with a level x axis votes (doors, windows and furniture count double);
        // the densest cluster of votes wins.
        var votes: [(angle: Double, weight: Double)] = []
        for p in pairs {
            let us = plan(p.source.xAxis), ut = plan(p.target.xAxis)
            guard plength(us) > 0.7, plength(ut) > 0.7 else { continue }
            votes.append((wrapAngle(atan2(us.y, us.x) - atan2(ut.y, ut.x)), p.isWall ? 1 : 2))
        }
        guard !votes.isEmpty else { return nil }
        let tolerance = 5 * Double.pi / 180
        var center = votes[0].angle
        var bestWeight = -1.0
        for v in votes {
            let w = votes.filter { abs(wrapAngle($0.angle - v.angle)) < tolerance }.reduce(0) { $0 + $1.weight }
            if w > bestWeight {
                bestWeight = w
                center = v.angle
            }
        }
        var sx = 0.0, sy = 0.0
        for v in votes where abs(wrapAngle(v.angle - center)) < tolerance {
            sx += v.weight * cos(v.angle)
            sy += v.weight * sin(v.angle)
        }
        let yaw = atan2(sy, sx)
        // A wall reported the other way round would vote 180° off; positions settle it.
        guard let fit = fitShift(pairs, yaw: yaw) else { return nil }
        if fit.residual > 0.1, let flipped = fitShift(pairs, yaw: yaw + Double.pi), flipped.residual < fit.residual * 0.5 { return flipped }
        return fit
    }

    struct FitPair {
        let source: Transform
        let target: Transform
        let isWall: Bool
    }

    /// The shift for a given turn: iteratively reweighted least squares in plan,
    /// then the median height change.
    static func fitShift(_ pairs: [FitPair], yaw: Double) -> Fit? {
        let turn = Motion(yaw: yaw, t: Vec3(0, 0, 0))
        let deltas = pairs.map { plan($0.target.translation) - plan(turn.rotate($0.source.translation)) }
        func residual(_ i: Int, _ t: P2) -> Double {
            let d = deltas[i] - t
            guard pairs[i].isWall else { return plength(d) }
            return abs(pdot(d, pnormalize(perp(plan(pairs[i].target.xAxis)))))
        }
        func alongResidual(_ i: Int, _ t: P2) -> Double { abs(pdot(deltas[i] - t, pnormalize(plan(pairs[i].target.xAxis)))) }
        var shift = P2(0, 0)
        var weights = [Double](repeating: 1, count: pairs.count)
        var alongWeights = [Double](repeating: 0.05, count: pairs.count)
        for iteration in 0..<12 {
            var a11 = 1e-9, a12 = 0.0, a22 = 1e-9, b1 = 0.0, b2 = 0.0
            for (i, p) in pairs.enumerated() {
                let d = deltas[i], w = weights[i]
                if p.isWall {
                    let u = pnormalize(plan(p.target.xAxis)), n = perp(u)
                    // Firm across the wall, weak along it (and not at all if the merge resized it).
                    for (e, k) in [(n, w), (u, w * alongWeights[i])] {
                        a11 += k * e.x * e.x
                        a12 += k * e.x * e.y
                        a22 += k * e.y * e.y
                        b1 += k * e.x * pdot(d, e)
                        b2 += k * e.y * pdot(d, e)
                    }
                } else {
                    a11 += w
                    a22 += w
                    b1 += w * d.x
                    b2 += w * d.y
                }
            }
            let det = a11 * a22 - a12 * a12
            guard abs(det) > 1e-12 else { return nil }
            shift = P2((a22 * b1 - a12 * b2) / det, (a11 * b2 - a12 * b1) / det)
            // The first rounds use a wide kernel so a bad start can't lock in, then it narrows.
            let c = iteration < 4 ? 0.5 : 0.08
            for i in pairs.indices {
                let r = residual(i, shift)
                weights[i] = 1 / (1 + (r / c) * (r / c))
                if pairs[i].isWall {
                    let ra = alongResidual(i, shift)
                    alongWeights[i] = 0.05 / (1 + (ra / c) * (ra / c))
                }
            }
        }
        let residuals = pairs.indices.map { residual($0, shift) }
        let inliers = pairs.indices.filter { residuals[$0] < 0.15 }
        guard !inliers.isEmpty else { return nil }
        let heights = inliers.map { Double(pairs[$0].target.translation.y - pairs[$0].source.translation.y) }.sorted()
        let dy = heights[heights.count / 2]
        let rms = (residuals.map { min($0, 0.5) * min($0, 0.5) }.reduce(0, +) / Double(residuals.count)).squareRoot()
        return Fit(motion: Motion(yaw: yaw, t: Vec3(Float(shift.x), Float(dy), Float(shift.y))), residual: rms, matched: inliers.count)
    }

    // MARK: Doorway snapping

    /// Plan shifts that line up each doorway seen from both of its rooms. Small
    /// by design: views more than ~0.8 m apart aren't treated as one doorway.
    static func doorwayCorrections(parts: [RoomPart], motions: [Motion?]) -> (corrections: [P2], pairs: Int, snapped: Set<Int>) {
        struct View {
            let part: Int
            let c: P2
            let u: P2
            /// Into the view's own room.
            let n: P2
            let width: Double
            let bottom: Double
        }
        var views: [View] = []
        for (k, part) in parts.enumerated() {
            guard let m = motions[k] else { continue }
            let poly = part.room.floorPolygon.map { plan(m.apply($0)) }
            guard poly.count >= 3 else { continue }
            let mid = centroid(poly)
            for o in part.openings where o.kind != .window && o.width > 0.4 && o.transform.isFinite {
                let t = m.transform * o.transform
                let axis = plan(t.xAxis)
                guard plength(axis) > 0.5 else { continue }
                let u = pnormalize(axis)
                let c = plan(t.translation)
                var n = perp(u)
                let inFront = pointInPolygon(c + n * 0.3, poly), behind = pointInPolygon(c - n * 0.3, poly)
                if behind && !inFront || (inFront == behind && pdot(mid - c, n) < 0) { n = -n }
                views.append(View(part: k, c: c, u: u, n: n, width: Double(o.width), bottom: Double(t.translation.y - o.height / 2)))
            }
        }

        struct Pair {
            let i: Int
            let j: Int
            /// Wanted (shift of j) − (shift of i), and how firmly along each axis.
            let along: P2
            let alongValue: Double
            let alongWeight: Double
            let across: P2
            let acrossValue: Double
            let acrossWeight: Double
            let cost: Double
        }
        var candidates: [(a: Int, b: Int, pair: Pair)] = []
        let cosLimit = cos(12 * Double.pi / 180)
        for a in views.indices {
            for b in views.indices where views[b].part != views[a].part && a < b {
                let va = views[a], vb = views[b]
                guard abs(pdot(va.u, vb.u)) > cosLimit, pdot(va.n, vb.n) < -0.5 else { continue }
                guard abs(va.width - vb.width) < 0.25 + 0.15 * max(va.width, vb.width), abs(va.bottom - vb.bottom) < 0.35 else { continue }
                let d = vb.c - va.c
                let along = pdot(d, va.u), across = pdot(d, va.n)
                // b's face sits behind a's (in the other room), a partition's thickness away.
                guard abs(along) < 0.8, across > -0.9, across < 0.3 else { continue }
                // The partition's thickness isn't known: firmly pull implausible gaps to a typical
                // interior wall, gently pull plausible ones.
                let plausible = across >= -0.35 && across <= -0.04
                let sameWidth = abs(va.width - vb.width) < 0.15
                let pair = Pair(
                    i: va.part, j: vb.part, along: va.u, alongValue: -along, alongWeight: sameWidth ? 1 : 0.1, across: va.n,
                    acrossValue: -0.12 - across, acrossWeight: plausible ? 0.1 : 1, cost: along * along + 0.5 * (across + 0.12) * (across + 0.12))
                candidates.append((a, b, pair))
            }
        }
        // Each doorway view joins at most one pair, best matches first.
        var usedViews = Set<Int>()
        var pairs: [Pair] = []
        for c in candidates.sorted(by: { $0.pair.cost < $1.pair.cost }) where !usedViews.contains(c.a) && !usedViews.contains(c.b) {
            usedViews.insert(c.a)
            usedViews.insert(c.b)
            pairs.append(c.pair)
        }

        // The largest room of each group of doorway-connected rooms stays put; the others move to it.
        let areas = parts.indices.map { k in motions[k] == nil ? 0 : area(parts[k].room.floorPolygon.map(plan)) }
        func anchors(_ pairs: [Pair]) -> Set<Int> {
            var group = Array(parts.indices)
            func root(_ k: Int) -> Int {
                var k = k
                while group[k] != k { k = group[k] }
                return k
            }
            for p in pairs { group[root(p.i)] = root(p.j) }
            var best: [Int: Int] = [:]
            for k in parts.indices where areas[k] > (best[root(k)].map { areas[$0] } ?? -1) { best[root(k)] = k }
            return Set(best.values)
        }

        var corrections = [P2](repeating: P2(0, 0), count: parts.count)
        while !pairs.isEmpty {
            let solved = solveShifts(
                pairs: pairs.map { ($0.i, $0.j, [($0.along, $0.alongValue, $0.alongWeight), ($0.across, $0.acrossValue, $0.acrossWeight)]) }, count: parts.count,
                pinned: anchors(pairs))
            // Drop the worst-fitting pair while some pair disagrees with the rest.
            var worst: (index: Int, error: Double)?
            for (index, p) in pairs.enumerated() {
                let rel = solved[p.j] - solved[p.i]
                let e = max(abs(pdot(rel, p.along) - p.alongValue) * p.alongWeight, abs(pdot(rel, p.across) - p.acrossValue) * p.acrossWeight)
                if e > worst?.error ?? 0.12 { worst = (index, e) }
            }
            if let worst {
                pairs.remove(at: worst.index)
                continue
            }
            if let far = solved.indices.first(where: { plength(solved[$0]) > 0.75 }) {
                pairs.removeAll { $0.i == far || $0.j == far }
                continue
            }
            corrections = solved
            break
        }
        return (corrections, pairs.count, Set(pairs.flatMap { [$0.i, $0.j] }))
    }

    /// Least-squares plan shifts for rooms given wanted relative shifts along
    /// directions. `pinned` rooms stay put; the rest are lightly pulled towards zero.
    static func solveShifts(pairs: [(i: Int, j: Int, constraints: [(e: P2, value: Double, weight: Double)])], count: Int, pinned: Set<Int> = []) -> [P2] {
        let n = 2 * count
        var a = [Double](repeating: 0, count: n * n)
        var b = [Double](repeating: 0, count: n)
        for k in 0..<n { a[k * n + k] = pinned.contains(k / 2) ? 1e6 : 0.002 }
        for p in pairs {
            for c in p.constraints {
                // Row: e·(T_j − T_i) = value.
                var row: [(Int, Double)] = []
                row.append((2 * p.j, c.e.x))
                row.append((2 * p.j + 1, c.e.y))
                row.append((2 * p.i, -c.e.x))
                row.append((2 * p.i + 1, -c.e.y))
                for (r, vr) in row {
                    b[r] += c.weight * vr * c.value
                    for (s, vs) in row { a[r * n + s] += c.weight * vr * vs }
                }
            }
        }
        guard let x = solveLinear(a, b, n) else { return [P2](repeating: P2(0, 0), count: count) }
        return (0..<count).map { P2(x[2 * $0], x[2 * $0 + 1]) }
    }
}

/// Angle wrapped into (−π, π].
func wrapAngle(_ a: Double) -> Double {
    guard a.isFinite else { return 0 }
    var r = a.truncatingRemainder(dividingBy: 2 * Double.pi)
    if r <= -Double.pi { r += 2 * Double.pi }
    if r > Double.pi { r -= 2 * Double.pi }
    return r
}

/// Solves the dense n×n system a·x = b (row-major) by Gaussian elimination with partial pivoting.
func solveLinear(_ a0: [Double], _ b0: [Double], _ n: Int) -> [Double]? {
    var a = a0, b = b0
    for col in 0..<n {
        var pivot = col
        for r in col..<n where abs(a[r * n + col]) > abs(a[pivot * n + col]) { pivot = r }
        guard abs(a[pivot * n + col]) > 1e-12 else { return nil }
        if pivot != col {
            for k in 0..<n { a.swapAt(col * n + k, pivot * n + k) }
            b.swapAt(col, pivot)
        }
        let d = a[col * n + col]
        for r in (col + 1)..<n {
            let f = a[r * n + col] / d
            guard f != 0 else { continue }
            for k in col..<n { a[r * n + k] -= f * a[col * n + k] }
            b[r] -= f * b[col]
        }
    }
    var x = [Double](repeating: 0, count: n)
    for r in stride(from: n - 1, through: 0, by: -1) {
        var sum = b[r]
        for k in (r + 1)..<n { sum -= a[r * n + k] * x[k] }
        x[r] = sum / a[r * n + r]
    }
    return x
}
