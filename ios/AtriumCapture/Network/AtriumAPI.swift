import Foundation

/// A link from the Atrium dashboard: atriumcapture://pair?server=<base URL>&token=<token>.
struct PairingLink: Equatable {
    let server: URL
    let token: String

    init?(url: URL) {
        guard url.scheme?.lowercased() == "atriumcapture", url.host?.lowercased() == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let serverString = items.first(where: { $0.name == "server" })?.value,
              let token = items.first(where: { $0.name == "token" })?.value
        else { return nil }
        self.init(serverString: serverString, token: token)
    }

    init?(serverString: String, token: String) {
        guard var components = URLComponents(string: serverString.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https", components.host?.isEmpty == false,
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { return nil }
        // Base URL only: no trailing slash, query or fragment.
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let server = components.url else { return nil }
        self.server = server
        self.token = token
    }
}

/// The phone's side of the pairing API (docs/iphone-capture.md §3.2). The
/// token in the path is the only credential.
struct AtriumAPI {
    let server: URL
    let token: String

    struct Property: Decodable, Equatable {
        let id: String
        let addressLine: String
        let city: String
        let state: String
    }

    struct SessionInfo: Decodable {
        let property: Property
        let expiresAt: String
    }

    struct UploadTarget: Decodable {
        let method: String
        let url: String
        let headers: [String: String]
        let assetUrl: String
    }

    struct Completion: Decodable, Equatable {
        let ok: Bool
        let rooms: Int
        let floors: Int
        let propertyUrl: String
        let previewUrl: String
    }

    enum Failure: LocalizedError {
        case server(String)
        case unreachable(String)

        var errorDescription: String? {
            switch self {
            case let .server(message), let .unreachable(message): return message
            }
        }
    }

    private struct ErrorBody: Decodable { let error: String }

    private func endpoint(_ suffix: String = "") -> URL {
        server.appendingPathComponent("api/capture/sessions/\(token)\(suffix)")
    }

    func session() async throws -> SessionInfo {
        try await send(URLRequest(url: endpoint()))
    }

    func uploadTarget(kind: String, filename: String, size: Int64) async throws -> UploadTarget {
        var request = URLRequest(url: endpoint("/uploads"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["kind": kind, "filename": filename, "size": size])
        return try await send(request)
    }

    /// Streams a file to the signed upload URL, reporting progress 0…1.
    func put(_ file: URL, to target: UploadTarget, progress: @escaping @Sendable (Double) -> Void) async throws {
        guard let url = URL(string: target.url, relativeTo: server)?.absoluteURL else { throw Failure.server("The server sent an invalid upload address.") }
        var request = URLRequest(url: url, timeoutInterval: 900)
        request.httpMethod = target.method
        for (name, value) in target.headers { request.setValue(value, forHTTPHeaderField: name) }
        let delegate = UploadProgressDelegate(onProgress: progress)
        let (data, response) = try await perform { try await URLSession.shared.upload(for: request, fromFile: file, delegate: delegate) }
        try check(data, response)
        progress(1)
    }

    func complete(assetUrl: String, packageUrl: String?, manifest: Data) async throws -> Completion {
        var request = URLRequest(url: endpoint("/complete"), timeoutInterval: 120)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "assetUrl": assetUrl,
            "packageUrl": packageUrl.map { $0 as Any } ?? NSNull(),
            "manifest": try JSONSerialization.jsonObject(with: manifest),
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    // MARK: Plumbing

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        var request = request
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await perform { try await URLSession.shared.data(for: request) }
        try check(data, response)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw Failure.server("Unexpected reply from \(server.host ?? "the server"). Is this an Atrium server?")
        }
    }

    private func perform(_ call: () async throws -> (Data, URLResponse)) async throws -> (Data, URLResponse) {
        do {
            return try await call()
        } catch let error as URLError {
            let host = server.host ?? "the server"
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost:
                throw Failure.unreachable("You're offline. Connect to Wi-Fi and try again.")
            case .cannotConnectToHost, .cannotFindHost, .timedOut:
                throw Failure.unreachable("Can't reach \(host). If the dashboard runs on a computer, put the iPhone on the same Wi-Fi.")
            case .appTransportSecurityRequiresSecureConnection:
                throw Failure.unreachable("\(host) needs a secure (https) address.")
            default:
                throw Failure.unreachable("Couldn't reach \(host): \(error.localizedDescription)")
            }
        }
    }

    private func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw Failure.server("No reply from the server.") }
        guard (200..<300).contains(http.statusCode) else {
            if let body = try? JSONDecoder().decode(ErrorBody.self, from: data) { throw Failure.server(body.error) }
            switch http.statusCode {
            case 404: throw Failure.server("This pairing code has expired. Open the listing in the Atrium dashboard and scan the code again.")
            case 413: throw Failure.server("The file is too large for the server.")
            default: throw Failure.server("The server answered with an error (\(http.statusCode)).")
            }
        }
    }
}

/// Forwards upload progress from URLSession to a closure.
final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let onProgress: @Sendable (Double) -> Void

    init(onProgress: @escaping @Sendable (Double) -> Void) { self.onProgress = onProgress }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }
}

extension ISO8601DateFormatter {
    /// Parses the server's timestamps ("2026-10-08T19:20:54.852Z", with or without fractions).
    static func parseFlexible(_ string: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: string) { return date }
        return ISO8601DateFormatter().date(from: string)
    }
}
