import Foundation

// The portable scan model — `scan.json`, format "atrium.capture-scan/v1"
// (docs/iphone-capture.md §1). The iPhone app converts RoomPlan's output into
// this; ScanCore never sees an Apple framework type.

public struct DeviceInfo: Codable, Sendable, Equatable {
    public var model: String?
    public var system: String?
    public var app: String?

    public init(model: String? = nil, system: String? = nil, app: String? = nil) {
        self.model = model
        self.system = system
        self.app = app
    }
}

/// One scanned room.
public struct ScanRoom: Codable, Sendable, Equatable {
    /// Stable identifier (a UUID string).
    public var id: String
    /// What the realtor called the room ("Living Room").
    public var name: String
    /// RoomPlan's detected section label, if any ("livingRoom").
    public var label: String?
    /// Order in which rooms were scanned, from 0.
    public var captureIndex: Int
    /// World-space floor outline: at least 3 points, any winding, not closed.
    public var floorPolygon: [Vec3]
    /// Height of the floor surface.
    public var floorY: Float
    /// Height of the ceiling (top of the room's walls).
    public var ceilingY: Float

    public init(id: String, name: String, label: String? = nil, captureIndex: Int, floorPolygon: [Vec3], floorY: Float, ceilingY: Float) {
        self.id = id
        self.name = name
        self.label = label
        self.captureIndex = captureIndex
        self.floorPolygon = floorPolygon
        self.floorY = floorY
        self.ceilingY = ceilingY
    }
}

/// A wall: a vertical rectangle centered on `transform`'s origin. Column 0 runs
/// along the width, column 1 is up, column 2 is the normal (either direction).
public struct ScanWall: Codable, Sendable, Equatable {
    public var id: String
    /// The room this wall was scanned from, when known (helps find its inside face).
    public var roomId: String?
    public var transform: Transform
    public var width: Float
    public var height: Float

    public init(id: String, roomId: String? = nil, transform: Transform, width: Float, height: Float) {
        self.id = id
        self.roomId = roomId
        self.transform = transform
        self.width = width
        self.height = height
    }
}

/// A door, window or wall-less opening, with the same conventions as a wall.
public struct ScanOpening: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case door, window, opening
    }

    public var id: String
    public var kind: Kind
    /// Doors only: whether RoomPlan saw the door open.
    public var isOpen: Bool?
    /// The wall it sits in (RoomPlan's `parentIdentifier`), when known.
    public var wallId: String?
    public var roomId: String?
    public var transform: Transform
    public var width: Float
    public var height: Float

    public init(id: String, kind: Kind, isOpen: Bool? = nil, wallId: String? = nil, roomId: String? = nil, transform: Transform, width: Float, height: Float) {
        self.id = id
        self.kind = kind
        self.isOpen = isOpen
        self.wallId = wallId
        self.roomId = roomId
        self.transform = transform
        self.width = width
        self.height = height
    }
}

/// A piece of furniture or an appliance: an oriented box centered on
/// `transform`'s origin (column 1 up) with full extents `size`.
public struct ScanObject: Codable, Sendable, Equatable {
    public var id: String
    public var roomId: String?
    /// RoomPlan `CapturedRoom.Object.Category` case name: "sofa", "bed", "storage", …
    public var category: String
    public var transform: Transform
    public var size: Vec3

    public init(id: String, roomId: String? = nil, category: String, transform: Transform, size: Vec3) {
        self.id = id
        self.roomId = roomId
        self.category = category
        self.transform = transform
        self.size = size
    }
}

/// One sample of the phone's path: where it was and where it pointed.
public struct PoseSample: Codable, Sendable, Equatable {
    /// Seconds since the scan started.
    public var t: Double
    /// Camera position.
    public var p: Vec3
    /// Camera forward direction (the camera's −Z axis) in world space.
    public var f: Vec3
    /// Raw captures only: the RoomPlan run (0, 1, …) the sample was recorded in or
    /// after. Each run starts a new coordinate frame (see RoomAlignment).
    public var segment: Int?

    public init(t: Double, p: Vec3, f: Vec3, segment: Int? = nil) {
        self.t = t
        self.p = p
        self.f = f
        self.segment = segment
    }
}

/// A photo taken during the scan (frames/frames.json): a JPEG in the
/// camera sensor's orientation, with the pose and intrinsics to project it.
public struct CameraFrame: Codable, Sendable, Equatable {
    /// Path of the JPEG inside the scan folder ("frames/000012.jpg").
    public var file: String
    /// Seconds since the scan started (matches the path sample taken with it).
    public var t: Double
    /// Camera-to-world (ARKit camera convention: −Z forward, +Y up in the sensor image).
    public var transform: Transform
    /// Pinhole intrinsics, 9 numbers column-major, for the full sensor resolution.
    public var intrinsics: [Float]
    /// Full sensor resolution the intrinsics refer to.
    public var width: Int
    public var height: Int
    /// Size of the saved JPEG.
    public var imageWidth: Int
    public var imageHeight: Int
    /// Raw captures only: the RoomPlan run the photo was taken in (see `PoseSample.segment`).
    public var segment: Int?
    /// How fast the phone was turning when the photo was taken, radians per second (motion blur).
    public var angularSpeed: Float?
    /// The photo's exposure time, seconds.
    public var exposureDuration: Double?

    public init(
        file: String, t: Double, transform: Transform, intrinsics: [Float], width: Int, height: Int, imageWidth: Int, imageHeight: Int,
        segment: Int? = nil, angularSpeed: Float? = nil, exposureDuration: Double? = nil
    ) {
        self.file = file
        self.t = t
        self.transform = transform
        self.intrinsics = intrinsics
        self.width = width
        self.height = height
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.segment = segment
        self.angularSpeed = angularSpeed
        self.exposureDuration = exposureDuration
    }
}

public struct CaptureScan: Codable, Sendable, Equatable {
    public static let formatIdentifier = "atrium.capture-scan/v1"

    public var format: String
    public var capturedAt: String?
    public var device: DeviceInfo?
    public var rooms: [ScanRoom]
    public var walls: [ScanWall]
    public var openings: [ScanOpening]
    public var objects: [ScanObject]
    public var trajectory: [PoseSample]
    /// Photos taken while scanning, in the same frame as everything else.
    public var frames: [CameraFrame]

    public init(
        rooms: [ScanRoom],
        walls: [ScanWall] = [],
        openings: [ScanOpening] = [],
        objects: [ScanObject] = [],
        trajectory: [PoseSample] = [],
        frames: [CameraFrame] = [],
        capturedAt: String? = nil,
        device: DeviceInfo? = nil
    ) {
        format = CaptureScan.formatIdentifier
        self.rooms = rooms
        self.walls = walls
        self.openings = openings
        self.objects = objects
        self.trajectory = trajectory
        self.frames = frames
        self.capturedAt = capturedAt
        self.device = device
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        format = try c.decode(String.self, forKey: .format)
        capturedAt = try c.decodeIfPresent(String.self, forKey: .capturedAt)
        device = try c.decodeIfPresent(DeviceInfo.self, forKey: .device)
        rooms = try c.decode([ScanRoom].self, forKey: .rooms)
        // Everything but rooms is optional, so a minimal scan is easy to write by hand.
        walls = try c.decodeIfPresent([ScanWall].self, forKey: .walls) ?? []
        openings = try c.decodeIfPresent([ScanOpening].self, forKey: .openings) ?? []
        objects = try c.decodeIfPresent([ScanObject].self, forKey: .objects) ?? []
        trajectory = try c.decodeIfPresent([PoseSample].self, forKey: .trajectory) ?? []
        frames = try c.decodeIfPresent([CameraFrame].self, forKey: .frames) ?? []
    }

    /// Reads scan.json.
    public static func decode(from data: Data) throws -> CaptureScan {
        do {
            return try JSONDecoder().decode(CaptureScan.self, from: data)
        } catch {
            throw ScanProcessingError.invalidScan("scan.json could not be read: \(error)")
        }
    }

    /// scan.json bytes. Non-finite numbers can't be written as JSON, so they are dropped first.
    public func jsonData(prettyPrinted: Bool = false) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = prettyPrinted ? [.prettyPrinted, .sortedKeys] : [.sortedKeys]
        return try encoder.encode(sanitized())
    }

    /// A copy without elements that contain NaN or infinite values.
    public func sanitized() -> CaptureScan {
        var copy = self
        copy.rooms = rooms.compactMap { room in
            guard room.floorY.isFinite, room.ceilingY.isFinite else { return nil }
            var r = room
            r.floorPolygon = room.floorPolygon.filter(isFinite)
            return r
        }
        copy.walls = walls.filter { $0.transform.isFinite && $0.width.isFinite && $0.height.isFinite }
        copy.openings = openings.filter { $0.transform.isFinite && $0.width.isFinite && $0.height.isFinite }
        copy.objects = objects.filter { $0.transform.isFinite && isFinite($0.size) }
        copy.trajectory = trajectory.filter { $0.t.isFinite && isFinite($0.p) && isFinite($0.f) }
        copy.frames = frames.filter { $0.t.isFinite && $0.transform.isFinite && $0.intrinsics.count == 9 && $0.intrinsics.allSatisfy(\.isFinite) }
        return copy
    }

    /// The same scan in another coordinate frame (`transform` must be rigid).
    public func transformed(by transform: Transform) -> CaptureScan {
        var copy = self
        let dy = transform.translation.y
        copy.rooms = rooms.map { room in
            var r = room
            r.floorPolygon = room.floorPolygon.map(transform.apply)
            r.floorY = room.floorY + dy
            r.ceilingY = room.ceilingY + dy
            return r
        }
        copy.walls = walls.map { var w = $0; w.transform = transform * $0.transform; return w }
        copy.openings = openings.map { var o = $0; o.transform = transform * $0.transform; return o }
        copy.objects = objects.map { var o = $0; o.transform = transform * $0.transform; return o }
        copy.trajectory = trajectory.map { PoseSample(t: $0.t, p: transform.apply($0.p), f: transform.applyDirection($0.f), segment: $0.segment) }
        copy.frames = frames.map { var f = $0; f.transform = transform * $0.transform; return f }
        return copy
    }
}
