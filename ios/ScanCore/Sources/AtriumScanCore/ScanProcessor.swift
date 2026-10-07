import Foundation

public struct ScanProcessorOptions: Sendable {
    /// Camera height above the floor for room viewpoints, meters.
    public var eyeHeight: Double
    /// Thickness of walls that don't share a partition with another scanned room.
    public var wallThickness: Double
    public var includeCeilings: Bool
    /// One warm point light per room.
    public var includeLights: Bool
    /// Rotate the scan so its walls line up with the axes and move it near the
    /// origin with the lowest floor at y = 0 (keeps floor plans tidy).
    public var normalizeFrame: Bool
    /// Edge length of the procedural floor textures, pixels.
    public var textureSize: Int

    public init(
        eyeHeight: Double = 1.6, wallThickness: Double = 0.12, includeCeilings: Bool = true, includeLights: Bool = true, normalizeFrame: Bool = true,
        textureSize: Int = 1024
    ) {
        self.eyeHeight = eyeHeight
        self.wallThickness = wallThickness
        self.includeCeilings = includeCeilings
        self.includeLights = includeLights
        self.normalizeFrame = normalizeFrame
        self.textureSize = textureSize
    }
}

public struct ScanStats: Codable, Sendable, Equatable {
    public var rooms: Int
    public var floors: Int
    public var walls: Int
    public var doors: Int
    public var windows: Int
    public var openings: Int
    public var objects: Int
    public var links: Int
    public var triangles: Int
    /// Sum of the rooms' floor areas, square meters.
    public var floorArea: Double
    public var glbBytes: Int
    /// Photo-textured models: share of the surfaces the photos covered (0–1), and photos used.
    public var photoCoverage: Double? = nil
    public var photosUsed: Int? = nil
}

public struct ProcessedScan: Sendable {
    /// The walkthrough model, glTF binary, with the manifest embedded at scenes[0].extras.atrium.
    public let glb: Data
    public let manifest: ScanManifest
    public let stats: ScanStats
    /// The rigid transform applied to the scan's world coordinates (identity if not normalized).
    public let frame: Transform
}

public enum ScanProcessingError: Error, LocalizedError, Equatable {
    case unsupportedFormat(String)
    case noRooms
    case invalidScan(String)

    public var errorDescription: String? {
        switch self {
        case let .unsupportedFormat(format): return "This scan uses an unsupported format (\(format))."
        case .noRooms: return "The scan has no usable rooms. Scan at least one room completely."
        case let .invalidScan(message): return message
        }
    }
}

public enum ScanProcessor {
    public static let generator = "Atrium ScanCore 1.0"

    /// - Parameters:
    ///   - photos: decoded photos for `input.frames`; with them, surfaces are painted with the
    ///     photos (falling back to the styled model if the photos cover too little).
    ///   - encodeImage: how photo atlases are stored in the .glb (default PNG; the app uses JPEG).
    public static func process(
        _ input: CaptureScan, options: ScanProcessorOptions = .init(), photos: PhotoSource? = nil, encodeImage: ImageEncoder? = nil,
        photoOptions: PhotoTexturingOptions = .init()
    ) throws -> ProcessedScan {
        guard input.format == CaptureScan.formatIdentifier else { throw ScanProcessingError.unsupportedFormat(input.format) }
        var scan = input.sanitized()
        var frame = Transform.identity
        if options.normalizeFrame {
            frame = normalizingFrame(for: scan)
            scan = scan.transformed(by: frame)
        }

        let rooms = Layout.rooms(from: scan)
        guard !rooms.isEmpty else { throw ScanProcessingError.noRooms }
        var walls = Layout.walls(from: scan, rooms: rooms, defaultThickness: options.wallThickness)
        Layout.cutOpenings(scan.openings, into: &walls)

        if let photos, !scan.frames.isEmpty,
            let textured = try photoTextured(
                scan, rooms: rooms, walls: walls, frame: frame, options: options, photos: photos, encodeImage: encodeImage, photoOptions: photoOptions)
        {
            return textured
        }

        var mesh = MeshBuilder()
        for w in walls { WallGeometry.build(w, into: &mesh) }
        for (i, r) in rooms.enumerated() {
            // A hair of height per room so overlapping floors of open-plan rooms never z-fight.
            let lift = Double(i % 8) * 0.0007
            mesh.addPlanPolygon(r.poly, y: r.floorY + lift, facingUp: true, material: r.isWet ? Mat.tile : Mat.oak, uvScale: r.isWet ? 1.2 : 2.4)
            if options.includeCeilings {
                mesh.addPlanPolygon(r.poly, y: r.ceilingY, facingUp: false, material: Mat.ceiling, uvScale: 1)
            }
        }
        addThresholds(scan.openings, walls: walls, rooms: rooms, into: &mesh)
        for o in scan.objects { Furniture.build(o, walls: walls, into: &mesh) }

        let lights = options.includeLights ? rooms.map(roomLight) : []
        let manifest = ManifestBuilder(
            rooms: rooms, walls: walls, openings: scan.openings, objects: scan.objects, trajectory: scan.trajectory, eyeHeight: options.eyeHeight
        ).build(generator: generator)

        let manifestObject = try JSONSerialization.jsonObject(with: try manifest.jsonData())
        var capture: [String: Any] = ["format": CaptureScan.formatIdentifier, "generator": generator, "frame": frame.m.map(Double.init)]
        if let capturedAt = scan.capturedAt { capture["capturedAt"] = capturedAt }
        let glb = try GLBWriter.write(
            mesh: mesh, lights: lights, textureSize: max(16, options.textureSize), sceneExtras: ["atrium": manifestObject, "atriumCapture": capture],
            generator: generator)

        let stats = ScanStats(
            rooms: rooms.count, floors: manifest.floors.count, walls: walls.count,
            doors: scan.openings.filter { $0.kind == .door }.count, windows: scan.openings.filter { $0.kind == .window }.count,
            openings: scan.openings.filter { $0.kind == .opening }.count, objects: scan.objects.count, links: manifest.links.count,
            triangles: mesh.triangleCount, floorArea: rounded(rooms.reduce(0) { $0 + $1.area }, 2), glbBytes: glb.count)
        return ProcessedScan(glb: glb, manifest: manifest, stats: stats, frame: frame)
    }

    /// The photo-textured model, or nil if the photos cover too little of it.
    static func photoTextured(
        _ scan: CaptureScan, rooms: [RoomInfo], walls: [WallInfo], frame: Transform, options: ScanProcessorOptions, photos: PhotoSource,
        encodeImage: ImageEncoder?, photoOptions: PhotoTexturingOptions
    ) throws -> ProcessedScan? {
        var model = PhotoModel.build(scan: scan, rooms: rooms, walls: walls, defaultThickness: options.wallThickness, includeCeilings: options.includeCeilings)
        model.measureCharts()
        guard let atlasCount = PhotoBaker.pack(&model.charts, options: photoOptions) else { return nil }
        let cameras = scan.frames.compactMap { PhotoCamera($0, depthWidth: photoOptions.depthWidth) }
        guard !cameras.isEmpty else { return nil }
        let baked = PhotoBaker.bake(model: model, cameras: cameras, photos: photos, atlasCount: atlasCount, options: photoOptions)
        guard baked.coverage >= 0.15 else { return nil }

        var mesh = MeshBuilder()
        for (i, chart) in model.charts.enumerated() {
            guard let buffer = model.mesh.buffers[PhotoModel.chartMaterial(i)] else { continue }
            let size = photoOptions.atlasSize
            mesh.append(buffer, material: photoMaterial(chart.atlas)) { chart.atlasUV($0, size: size) }
        }
        var textures: [String: (data: Data, mimeType: String)] = [:]
        for (k, atlas) in baked.atlases.enumerated() {
            textures[photoMaterial(k)] = encodeImage?(atlas) ?? (PNG.encode(atlas), "image/png")
        }

        var manifest = ManifestBuilder(
            rooms: rooms, walls: walls, openings: scan.openings, objects: scan.objects, trajectory: scan.trajectory, eyeHeight: options.eyeHeight
        ).build(generator: generator)
        manifest.appearance = "captured"
        let manifestObject = try JSONSerialization.jsonObject(with: try manifest.jsonData())
        var capture: [String: Any] = [
            "format": CaptureScan.formatIdentifier, "generator": generator, "frame": frame.m.map(Double.init), "textured": true,
            "photoCoverage": rounded(baked.coverage, 3),
        ]
        if let capturedAt = scan.capturedAt { capture["capturedAt"] = capturedAt }
        let glb = try GLBWriter.write(
            mesh: mesh, lights: [], textureSize: 16, sceneExtras: ["atrium": manifestObject, "atriumCapture": capture], generator: generator,
            photoTextures: textures, unlit: true)

        let stats = ScanStats(
            rooms: rooms.count, floors: manifest.floors.count, walls: walls.count,
            doors: scan.openings.filter { $0.kind == .door }.count, windows: scan.openings.filter { $0.kind == .window }.count,
            openings: scan.openings.filter { $0.kind == .opening }.count, objects: scan.objects.count, links: manifest.links.count,
            triangles: mesh.triangleCount, floorArea: rounded(rooms.reduce(0) { $0 + $1.area }, 2), glbBytes: glb.count,
            photoCoverage: rounded(baked.coverage, 3), photosUsed: baked.photosUsed)
        return ProcessedScan(glb: glb, manifest: manifest, stats: stats, frame: frame)
    }

    static func photoMaterial(_ atlas: Int) -> String { "Photo_\(atlas + 1)" }

    /// Rotation about Y that lines the dominant wall direction up with the X
    /// axis, then a translation putting the plan's center at the origin and the
    /// lowest floor at y = 0.
    static func normalizingFrame(for scan: CaptureScan) -> Transform {
        // Wall directions modulo 90°, weighted by length (doubled angle trick on 4θ).
        var sx = 0.0, sy = 0.0
        for w in scan.walls where w.transform.isFinite {
            let u = plan(w.transform.xAxis)
            guard plength(u) > 0.5 else { continue }
            let theta = atan2(u.y, u.x)
            sx += Double(w.width) * cos(4 * theta)
            sy += Double(w.width) * sin(4 * theta)
        }
        if sx == 0 && sy == 0 {
            for room in scan.rooms {
                let poly = room.floorPolygon.map(plan)
                for i in poly.indices {
                    let e = poly[(i + 1) % poly.count] - poly[i]
                    let theta = atan2(e.y, e.x)
                    sx += plength(e) * cos(4 * theta)
                    sy += plength(e) * sin(4 * theta)
                }
            }
        }
        let dominant = (sx == 0 && sy == 0) ? 0 : atan2(sy, sx) / 4
        // Rotating by +dominant maps a direction at angle `dominant` (atan2(z, x)) onto +X.
        let rotation = Transform.rotationY(Float(dominant))
        var lo = P2(Double.infinity, Double.infinity), hi = P2(-Double.infinity, -Double.infinity)
        var minFloor = Double.infinity
        for room in scan.rooms where room.floorY.isFinite {
            minFloor = min(minFloor, Double(room.floorY))
            for p in room.floorPolygon where isFinite(p) {
                let q = plan(rotation.apply(p))
                lo = P2(min(lo.x, q.x), min(lo.y, q.y))
                hi = P2(max(hi.x, q.x), max(hi.y, q.y))
            }
        }
        guard lo.x.isFinite, minFloor.isFinite else { return rotation }
        let center = (lo + hi) / 2
        return Transform.translating(Vec3(Float(-center.x), Float(-minFloor), Float(-center.y))) * rotation
    }

    /// A floor patch through each doorway so the gap under the partition never shows.
    static func addThresholds(_ openings: [ScanOpening], walls: [WallInfo], rooms: [RoomInfo], into mesh: inout MeshBuilder) {
        for o in openings where o.kind != .window && o.transform.isFinite {
            let u = pnormalize(plan(o.transform.xAxis))
            guard plength(u) > 0.5, o.width > 0.2 else { continue }
            let n = perp(u)
            let c = o.transform.translation
            let mid = plan(c)
            let bottom = Double(c.y - o.height / 2)
            // Only when a floor is right there (doors to the outside get no patch).
            let neighbours = [mid + n * 0.4, mid - n * 0.4].compactMap { p in
                rooms.first { pointInPolygon(p, $0.poly) && abs($0.floorY - bottom) < 0.25 }
            }
            guard neighbours.count == 2 else { continue }
            let y = neighbours.map(\.floorY).max()! + 0.0015
            let along: P2 = u * (Double(o.width) / 2)
            let across: P2 = n * 0.32
            let corners: [P2] = [mid - along - across, mid + along - across, mid + along + across, mid - along + across]
            let wet = neighbours.allSatisfy(\.isWet)
            mesh.addFace(corners.map { world($0, y: y) }, normal: Vec3(0, 1, 0), material: wet ? Mat.tile : Mat.oak, uv: .planXZ(scale: wet ? 1.2 : 2.4))
        }
    }

    static func roomLight(_ r: RoomInfo) -> PointLight {
        let xs = r.poly.map(\.x), zs = r.poly.map(\.y)
        let span = max((xs.max() ?? 0) - (xs.min() ?? 0), (zs.max() ?? 0) - (zs.min() ?? 0))
        let height = min(0.6, (r.ceilingY - r.floorY) * 0.25)
        return PointLight(
            name: "Light_\(r.index + 1)", position: world(r.center, y: r.ceilingY - height), color: "#ffe2c2",
            intensity: rounded(clamp(7 + r.area * 0.8, 8, 24), 2), range: rounded(max(6, span + 2.5), 2))
    }
}
