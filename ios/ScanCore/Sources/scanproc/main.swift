// scanproc — run ScanCore from the command line (the same code the iPhone app runs).
//
//   scanproc process <scan.json> <out.glb> [--manifest <manifest.json>] [--texture-size <px>]
//   scanproc <scan.json> <out.glb> [--manifest <manifest.json>]
//   scanproc demo-scan <scan.json>        write the synthetic two-bedroom apartment scan

import AtriumScanCore
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let usage = """
    usage: scanproc process <scan.json> <out.glb> [--manifest <manifest.json>] [--texture-size <px>]
           scanproc demo-scan <scan.json>
    """

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail(usage) }

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let value = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return value
}

switch command {
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
