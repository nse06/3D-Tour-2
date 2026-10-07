// scanproc — run ScanCore from the command line (the same code the iPhone app runs).
//
//   scanproc process <scan.json> <out.glb> [--manifest <manifest.json>] [--texture-size <px>]
//   scanproc <scan.json> <out.glb> [--manifest <manifest.json>]
//   scanproc demo-scan <scan.json>        write the synthetic two-bedroom apartment scan
//   scanproc align <room.json|structure.json>... --out <scan.json> [--glb <out.glb>] [--report <alignment.json>]
//            [--structure <structure.json> [--top-level-only]] [--scramble [--walk] [--no-structure]]
//        RoomPlan JSON → one aligned scan (RoomAlignment). --scramble re-creates RoomPlan's
//        per-room origins from rooms that already share a frame, to check the alignment.

import AtriumScanCore
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let usage = """
    usage: scanproc process <scan.json> <out.glb> [--manifest <manifest.json>] [--texture-size <px>]
           scanproc demo-scan <scan.json>
           scanproc align <room.json|structure.json>... --out <scan.json> [--glb <out.glb>] [--report <alignment.json>]
                [--structure <structure.json> [--top-level-only]] [--scramble [--walk] [--no-structure]]
    """

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail(usage) }

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let value = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return value
}

func flag(_ name: String) -> Bool {
    guard let i = args.firstIndex(of: name) else { return false }
    args.remove(at: i)
    return true
}

switch command {
case "align":
    args.removeFirst()
    guard let out = option("--out") else { fail(usage) }
    let glbPath = option("--glb")
    let reportPath = option("--report")
    let structurePath = option("--structure")
    let topLevelOnly = flag("--top-level-only")
    let scramble = flag("--scramble"), walk = flag("--walk"), noStructure = flag("--no-structure")
    guard !args.isEmpty else { fail(usage) }
    do {
        var truth: [RoomPlanJSON.Room] = []
        for path in args {
            let url = URL(fileURLWithPath: path)
            let name = url.deletingPathExtension().lastPathComponent == "capturedRoom" ? url.deletingLastPathComponent().lastPathComponent : nil
            truth += try RoomPlanJSON.rooms(in: url, firstIndex: truth.count, name: name)
        }
        var structure: [String: Transform]? = try structurePath.map { try RoomPlanJSON.structurePoses(in: URL(fileURLWithPath: $0), topLevelOnly: topLevelOnly) }
        var parts = truth.map(\.part)
        var path: [PoseSample] = []
        var origins: [Vec3] = []
        if scramble {
            // Where the phone might stand when each room's scan starts: just inside the room, at hand height.
            origins = parts.map { part in
                let xs = part.room.floorPolygon.map(\.x), zs = part.room.floorPolygon.map(\.z)
                let c = Vec3((xs.min()! + xs.max()!) / 2, part.room.floorY + 1.4, (zs.min()! + zs.max()!) / 2)
                return c + Vec3(0.35, 0, -0.25)
            }
            if structure == nil && !noStructure {
                structure = [:]
                for room in truth { for (id, t) in room.poses { structure![id] = t } }
            }
            if walk {
                // Straight from each room's start to the next one's, 0.5 m/s, sampled at 4 Hz.
                var t = 0.0
                for k in parts.indices {
                    let a = origins[k], b = k + 1 < origins.count ? origins[k + 1] : origins[k] + Vec3(0.5, 0, 0)
                    let steps = max(2, Int((Double(vlengthCLI(b - a)) / 0.125).rounded()))
                    for i in 0..<steps {
                        let p = a + (b - a) * (Float(i) / Float(steps))
                        path.append(PoseSample(t: t, p: p - origins[k], f: Vec3(0, 0, -1)))
                        t += 0.25
                    }
                }
            }
            for k in parts.indices { parts[k] = shifted(parts[k], by: -origins[k]) }
        }
        let result = RoomAlignment.align(parts: parts, structure: structure, path: path, frames: [])
        let r = result.report
        print(r.summary)
        print("segments \(r.segments), path resets \(r.pathResets), doorway pairs \(r.doorwayPairs)")
        for (k, room) in r.rooms.enumerated() {
            var line = String(format: "  %-16@ %-10@ matched %3d", room.name as NSString, room.method.rawValue as NSString, room.matchedElements)
            if let residual = room.residual { line += String(format: "  residual %.3f m", residual) }
            line += String(format: "  doorway shift %.3f m", room.doorwayShift)
            if scramble {
                // Error against the true layout, after removing the frame the result came out in.
                let mine = result.scan.walls.filter { $0.roomId == truth[k].part.room.id }
                let wanted = Dictionary(uniqueKeysWithValues: truth[k].part.walls.map { ($0.id, $0.transform.translation) })
                let errors = mine.compactMap { w in wanted[w.id].map { vlengthCLI(w.transform.translation - $0 - frameOffset(result.scan, truth)) } }
                line += String(format: "  error %.3f m", errors.max() ?? -1)
            }
            print(line)
        }
        try result.scan.jsonData(prettyPrinted: false).write(to: URL(fileURLWithPath: out))
        if let reportPath { try JSONEncoder().encode(result.report).write(to: URL(fileURLWithPath: reportPath)) }
        if let glbPath {
            let processed = try ScanProcessor.process(result.scan, options: ScanProcessorOptions(textureSize: 256))
            try processed.glb.write(to: URL(fileURLWithPath: glbPath))
            print(String(format: "%.1f m² of floor, %d links", processed.stats.floorArea, processed.stats.links))
        }
    } catch {
        fail("scanproc align: \(error)")
    }

case "demo-scan":
    guard args.count == 2 else { fail(usage) }
    do {
        try SyntheticApartment.make().jsonData(prettyPrinted: true).write(to: URL(fileURLWithPath: args[1]))
        print("wrote \(args[1])")
    } catch {
        fail("demo-scan failed: \(error)")
    }

default:
    if command == "process" { args.removeFirst() }
    let manifestPath = option("--manifest")
    let textureSize = option("--texture-size").flatMap(Int.init) ?? 1024
    guard args.count == 2 else { fail(usage) }
    do {
        let scan = try CaptureScan.decode(from: Data(contentsOf: URL(fileURLWithPath: args[0])))
        let started = Date()
        let result = try ScanProcessor.process(scan, options: ScanProcessorOptions(textureSize: textureSize))
        try result.glb.write(to: URL(fileURLWithPath: args[1]))
        if let manifestPath { try result.manifest.jsonData(prettyPrinted: true).write(to: URL(fileURLWithPath: manifestPath)) }
        let s = result.stats
        print(
            "\(s.rooms) rooms on \(s.floors) floor(s), \(s.walls) walls, \(s.doors) doors, \(s.windows) windows, \(s.openings) openings, \(s.objects) objects, \(s.links) links"
        )
        print(String(format: "%.1f m² · %d triangles · %.2f MB · %.2f s", s.floorArea, s.triangles, Double(s.glbBytes) / 1_048_576, Date().timeIntervalSince(started)))
    } catch {
        fail("scanproc: \((error as? LocalizedError)?.errorDescription ?? "\(error)")")
    }
}

func vlengthCLI(_ v: Vec3) -> Float { (v.x * v.x + v.y * v.y + v.z * v.z).squareRoot() }

func shifted(_ part: RoomPart, by d: Vec3) -> RoomPart {
    let t = Transform.translating(d)
    var p = part
    p.room.floorPolygon = part.room.floorPolygon.map(t.apply)
    p.room.floorY += d.y
    p.room.ceilingY += d.y
    p.walls = part.walls.map { var w = $0; w.transform = t * $0.transform; return w }
    p.openings = part.openings.map { var o = $0; o.transform = t * $0.transform; return o }
    p.objects = part.objects.map { var o = $0; o.transform = t * $0.transform; return o }
    return p
}

/// The translation between an aligned scan's frame and the truth (first room's first wall).
func frameOffset(_ scan: CaptureScan, _ truth: [RoomPlanJSON.Room]) -> Vec3 {
    guard let first = truth.first?.part.walls.first, let mine = scan.walls.first(where: { $0.id == first.id }) else { return Vec3(0, 0, 0) }
    return mine.transform.translation - first.transform.translation
}
