import Foundation

/// Writes a ZIP archive with stored (uncompressed) entries — the package is
/// mostly JPEG frames and binary data that wouldn't compress anyway.
enum ZipWriter {
    enum Failure: LocalizedError {
        case tooLarge(String)
        var errorDescription: String? {
            switch self {
            case let .tooLarge(name): return "\(name) is too large to package."
            }
        }
    }

    static func write(files: [(path: String, url: URL)], to destination: URL) throws {
        try? FileManager.default.removeItem(at: destination)
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let out = try FileHandle(forWritingTo: destination)
        defer { try? out.close() }

        let (time, date) = dosTimestamp(Date())
        var central = Data()
        var offset: UInt64 = 0

        for file in files {
            let (crc, size) = try checksum(of: file.url)
            guard size < UInt64(UInt32.max), offset < UInt64(UInt32.max) else { throw Failure.tooLarge(file.path) }
            let name = Data(file.path.utf8)

            var local = Data()
            local.appendLE(UInt32(0x0403_4b50))
            local.appendLE(UInt16(20))  // version needed
            local.appendLE(UInt16(0x0800))  // UTF-8 file names
            local.appendLE(UInt16(0))  // stored
            local.appendLE(time)
            local.appendLE(date)
            local.appendLE(crc)
            local.appendLE(UInt32(size))
            local.appendLE(UInt32(size))
            local.appendLE(UInt16(name.count))
            local.appendLE(UInt16(0))
            local.append(name)
            try out.write(contentsOf: local)

            let input = try FileHandle(forReadingFrom: file.url)
            while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty { try out.write(contentsOf: chunk) }
            try input.close()

            central.appendLE(UInt32(0x0201_4b50))
            central.appendLE(UInt16(20))  // version made by
            central.appendLE(UInt16(20))  // version needed
            central.appendLE(UInt16(0x0800))
            central.appendLE(UInt16(0))
            central.appendLE(time)
            central.appendLE(date)
            central.appendLE(crc)
            central.appendLE(UInt32(size))
            central.appendLE(UInt32(size))
            central.appendLE(UInt16(name.count))
            central.appendLE(UInt16(0))  // extra
            central.appendLE(UInt16(0))  // comment
            central.appendLE(UInt16(0))  // disk
            central.appendLE(UInt16(0))  // internal attributes
            central.appendLE(UInt32(0))  // external attributes
            central.appendLE(UInt32(offset))
            central.append(name)

            offset += UInt64(local.count) + size
        }

        guard offset < UInt64(UInt32.max), files.count < Int(UInt16.max) else { throw Failure.tooLarge("The scan package") }
        var end = Data()
        end.appendLE(UInt32(0x0605_4b50))
        end.appendLE(UInt16(0))
        end.appendLE(UInt16(0))
        end.appendLE(UInt16(files.count))
        end.appendLE(UInt16(files.count))
        end.appendLE(UInt32(central.count))
        end.appendLE(UInt32(offset))
        end.appendLE(UInt16(0))
        try out.write(contentsOf: central)
        try out.write(contentsOf: end)
    }

    private static func checksum(of url: URL) throws -> (UInt32, UInt64) {
        let input = try FileHandle(forReadingFrom: url)
        defer { try? input.close() }
        var crc: UInt32 = 0xffff_ffff
        var size: UInt64 = 0
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
            size += UInt64(chunk.count)
            chunk.withUnsafeBytes { raw in
                for byte in raw { crc = crcTable[Int((crc ^ UInt32(byte)) & 0xff)] ^ (crc >> 8) }
            }
        }
        return (crc ^ 0xffff_ffff, size)
    }

    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xedb8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    private static func dosTimestamp(_ date: Date) -> (UInt16, UInt16) {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let hour: Int = c.hour ?? 0, minute: Int = c.minute ?? 0, second: Int = c.second ?? 0
        let year: Int = max(0, (c.year ?? 1980) - 1980), month: Int = c.month ?? 1, day: Int = c.day ?? 1
        let time: Int = (hour << 11) | (minute << 5) | (second / 2)
        let packedDate: Int = (year << 9) | (month << 5) | day
        return (UInt16(truncatingIfNeeded: time), UInt16(truncatingIfNeeded: packedDate))
    }
}

extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { append(contentsOf: $0) }
    }
}
