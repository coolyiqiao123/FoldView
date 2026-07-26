import Foundation
import Network

/// A parsed HTTP/1.1 request. Parsing is deliberately minimal: request line,
/// case-insensitive headers, and a Content-Length-bounded body.
struct BridgeHTTPRequest: Sendable, Equatable {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data

    /// Parses the header block (everything up to `\r\n\r\n`). Returns the
    /// request-line/headers plus the total byte count of the header block so
    /// the caller can slice the body out of its buffer. Returns nil when the
    /// block is malformed.
    static func parseHeaders(_ headerData: Data) -> (method: String, path: String, headers: [String: String], headerLength: Int)? {
        guard let headerString = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerString.components(separatedBy: "\r\n")
        guard let requestLine = lines.first, !requestLine.isEmpty else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0]).uppercased()
        let rawPath = String(parts[1])
        let path = rawPath.split(separator: "?", maxSplits: 1).first.map(String.init) ?? rawPath

        var headers: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        return (method, path, headers, headerData.count + 4)
    }

    var contentLength: Int {
        headers["content-length"].flatMap(Int.init) ?? 0
    }
}

/// Builds the short human-readable summary shown on approval cards and in the
/// activity feed. Bash shows the command (trimmed to 120 characters),
/// Edit/Write-style tools show the file path, everything else shows the tool
/// or event name.
enum BridgeSummary {
    static let maxCommandLength = 120

    static func approvalSummary(toolName: String, toolInput: [String: Any]?) -> String {
        switch toolName {
        case "Bash":
            if let command = toolInput?["command"] as? String {
                let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.count > maxCommandLength {
                    return String(trimmed.prefix(maxCommandLength)) + "…"
                }
                return trimmed
            }
            return toolName
        case "Edit", "Write", "MultiEdit", "Read", "NotebookEdit":
            if let path = toolInput?["file_path"] as? String ?? toolInput?["notebook_path"] as? String {
                return path
            }
            return toolName
        default:
            return toolName
        }
    }

    static func eventSummary(event: String, payload: [String: Any]?) -> String {
        if let toolName = payload?["tool_name"] as? String {
            return approvalSummary(toolName: toolName, toolInput: payload?["tool_input"] as? [String: Any])
        }
        return event
    }
}

/// The localhost HTTP bridge between agent CLI hooks and the notch panel.
/// Bound to the loopback interface only with an ephemeral port and a
/// per-launch bearer token; after the listener is ready it publishes
/// `{schemaVersion, port, token, pid, launchedAt}` to the state file
/// (`~/Library/Application Support/Foldview/notch-bridge-v1.json`, 0600,
/// atomic tmp+rename) so the Node shims can find it, and removes that file
/// on terminate. No TLS — loopback plus the token is the trust boundary.
final class NotchBridgeServer: @unchecked Sendable {
    enum ServerError: Error, LocalizedError {
        case listenerFailed(String)

        var errorDescription: String? {
            switch self {
            case .listenerFailed(let message): return "The approval bridge failed to start: \(message)"
            }
        }
    }

    static let defaultApprovalTimeout: TimeInterval = 240
    static let maxBodyBytes = 1_048_576
    static let maxHeaderBytes = 65_536

    let token: String
    private let approvalTimeout: TimeInterval
    private let store: AgentActivityStore
    private let stateFileURL: URL
    private let queue = DispatchQueue(label: "foldview.notch-bridge")
    private let lock = NSLock()
    private var listener: NWListener?
    private var started = false

    /// Actual bound port, set once the listener reports ready.
    private(set) var port: Int?

    init(
        store: AgentActivityStore,
        token: String = UUID().uuidString,
        approvalTimeout: TimeInterval = NotchBridgeServer.defaultApprovalTimeout,
        stateFileURL: URL? = nil
    ) {
        self.store = store
        self.token = token
        self.approvalTimeout = approvalTimeout
        self.stateFileURL = stateFileURL ?? NotchBridgeServer.defaultStateFileURL
    }

    static var defaultStateFileURL: URL {
        FoldviewCLI.appSupportDirectoryURL.appendingPathComponent("notch-bridge-v1.json")
    }

    /// Marks the server as starting. Returns the existing bound port when
    /// already running; throws when a start is already in flight. Synchronous
    /// so the lock never crosses an await boundary.
    private func beginStart() throws -> Int? {
        lock.lock()
        defer { lock.unlock() }
        if started {
            if let port { return port }
            throw ServerError.listenerFailed("already starting")
        }
        started = true
        return nil
    }

    private func finishStart(listener: NWListener, port: Int) {
        lock.lock()
        self.listener = listener
        self.port = port
        lock.unlock()
    }

    private func resetStart() {
        lock.lock()
        started = false
        lock.unlock()
    }

    private func takeListenerForStop() -> NWListener? {
        lock.lock()
        let active = listener
        listener = nil
        started = false
        port = nil
        lock.unlock()
        return active
    }

    // MARK: - Lifecycle

    /// Starts the listener and returns the bound port once ready. Writes the
    /// state file after the port is known.
    @discardableResult
    func start() async throws -> Int {
        if let existingPort = try beginStart() { return existingPort }

        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.acceptLocalOnly = true
        let listener: NWListener
        do {
            listener = try NWListener(using: parameters, on: .any)
        } catch {
            resetStart()
            throw ServerError.listenerFailed(String(describing: error))
        }

        let boundPort: Int
        do {
            boundPort = try await withCheckedThrowingContinuation { continuation in
                final class Gate: @unchecked Sendable {
                    private let lock = NSLock()
                    private var continuation: CheckedContinuation<Int, Error>?
                    init(_ continuation: CheckedContinuation<Int, Error>) { self.continuation = continuation }
                    func resume(_ value: Int) { take()?.resume(returning: value) }
                    func fail(_ error: Error) { take()?.resume(throwing: error) }
                    private func take() -> CheckedContinuation<Int, Error>? {
                        lock.lock(); defer { lock.unlock() }
                        let current = continuation
                        continuation = nil
                        return current
                    }
                }
                let gate = Gate(continuation)
                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if let nwPort = listener.port {
                            gate.resume(Int(nwPort.rawValue))
                        } else {
                            gate.fail(ServerError.listenerFailed("listener ready without a port"))
                        }
                    case .failed(let error):
                        gate.fail(ServerError.listenerFailed(error.localizedDescription))
                    default:
                        break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    self?.accept(connection)
                }
                listener.start(queue: queue)
            }
        } catch {
            listener.cancel()
            resetStart()
            throw error
        }

        finishStart(listener: listener, port: boundPort)
        writeStateFile(port: boundPort)
        return boundPort
    }

    /// Stops the listener, dismisses held approvals (fail-open), and removes
    /// the state file. Safe to call more than once and from any context —
    /// including `applicationWillTerminate`.
    func stop() {
        let active = takeListenerForStop()
        active?.stateUpdateHandler = nil
        active?.newConnectionHandler = nil
        active?.cancel()
        Task { @MainActor [store] in
            store.dismissAllPending()
        }
        try? FileManager.default.removeItem(at: stateFileURL)
    }

    // MARK: - State file

    /// Atomic 0600 tmp-file + rename write of the bridge state, matching the
    /// convention used for the CLI path record.
    private func writeStateFile(port: Int) {
        struct State: Encodable {
            let schemaVersion: Int
            let port: Int
            let token: String
            let pid: Int
            let launchedAt: String
        }
        let state = State(
            schemaVersion: 1,
            port: port,
            token: token,
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            launchedAt: ISO8601DateFormatter().string(from: Date())
        )
        guard let data = try? JSONEncoder().encode(state) else { return }
        let directory = stateFileURL.deletingLastPathComponent()
        let temp = directory.appendingPathComponent(".\(stateFileURL.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            guard FileManager.default.createFile(
                atPath: temp.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            ) else { return }
            let handle = try FileHandle(forWritingTo: temp)
            do {
                try handle.write(contentsOf: data)
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            guard Darwin.rename(temp.path, stateFileURL.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        } catch {
            try? FileManager.default.removeItem(at: temp)
        }
    }

    // MARK: - Connection handling

    private func accept(_ connection: NWConnection) {
        // Belt and braces on top of the loopback-bound listener: drop any peer
        // that is not a loopback address.
        if case .hostPort(let host, _) = connection.endpoint {
            let isLoopback: Bool
            switch host {
            case .ipv4(let address): isLoopback = address == .loopback
            case .ipv6(let address): isLoopback = address == .loopback
            case .name(let name, _): isLoopback = name == "localhost"
            @unknown default: isLoopback = false
            }
            guard isLoopback else {
                connection.cancel()
                return
            }
        }
        connection.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.receiveHeaders(on: connection, buffer: Data())
            }
            if case .failed = state { connection.cancel() }
        }
        connection.start(queue: queue)
    }

    /// Accumulates bytes until the `\r\n\r\n` header terminator arrives.
    private func receiveHeaders(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: Self.maxHeaderBytes) { [weak self] content, _, isComplete, error in
            guard let self else { connection.cancel(); return }
            var buffer = buffer
            if let content { buffer.append(content) }
            if let range = buffer.range(of: Data([0x0D, 0x0A, 0x0D, 0x0A])) {
                let headerData = buffer.subdata(in: 0..<range.lowerBound)
                guard let parsed = BridgeHTTPRequest.parseHeaders(headerData) else {
                    self.send(.text(status: 400, body: "{\"ok\":false}"), on: connection)
                    return
                }
                let offset = range.lowerBound + 4
                let already = buffer.count - offset
                let contentLength = parsed.headers["content-length"].flatMap(Int.init) ?? 0
                guard contentLength <= Self.maxBodyBytes else {
                    self.send(.text(status: 400, body: "{\"ok\":false}"), on: connection)
                    return
                }
                if already >= contentLength {
                    let body = buffer.subdata(in: offset..<(offset + contentLength))
                    self.dispatch(BridgeHTTPRequest(method: parsed.method, path: parsed.path, headers: parsed.headers, body: body), on: connection)
                } else {
                    self.receiveBody(on: connection, prefix: buffer, headerOffset: offset, contentLength: contentLength, parsed: parsed)
                }
                return
            }
            if error != nil || isComplete || buffer.count > Self.maxHeaderBytes {
                connection.cancel()
                return
            }
            self.receiveHeaders(on: connection, buffer: buffer)
        }
    }

    /// Continues accumulating until the full Content-Length body is present.
    private func receiveBody(
        on connection: NWConnection,
        prefix: Data,
        headerOffset: Int,
        contentLength: Int,
        parsed: (method: String, path: String, headers: [String: String], headerLength: Int)
    ) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: Self.maxBodyBytes + 1) { [weak self] content, _, isComplete, error in
            guard let self else { connection.cancel(); return }
            var buffer = prefix
            if let content { buffer.append(content) }
            let available = buffer.count - headerOffset
            if available >= contentLength {
                let body = buffer.subdata(in: headerOffset..<(headerOffset + contentLength))
                self.dispatch(BridgeHTTPRequest(method: parsed.method, path: parsed.path, headers: parsed.headers, body: body), on: connection)
                return
            }
            if error != nil || isComplete {
                connection.cancel()
                return
            }
            self.receiveBody(on: connection, prefix: buffer, headerOffset: headerOffset, contentLength: contentLength, parsed: parsed)
        }
    }

    // MARK: - Routing

    private func dispatch(_ request: BridgeHTTPRequest, on connection: NWConnection) {
        Task { [weak self] in
            guard let self else { connection.cancel(); return }
            let response = await self.respond(to: request)
            self.send(response, on: connection)
        }
    }

    private struct Response {
        let status: Int
        let body: Data?

        static func json(status: Int, body: String) -> Response {
            Response(status: status, body: Data(body.utf8))
        }

        static func text(status: Int, body: String) -> Response {
            Response(status: status, body: Data(body.utf8))
        }

        static func empty(status: Int) -> Response {
            Response(status: status, body: nil)
        }
    }

    private func authorized(_ request: BridgeHTTPRequest) -> Bool {
        request.headers["authorization"] == "Bearer \(token)"
    }

    private func respond(to request: BridgeHTTPRequest) async -> Response {
        switch (request.method, request.path) {
        case ("GET", "/health"):
            return .json(status: 200, body: "{\"ok\":true}")
        case ("POST", "/event"):
            guard authorized(request) else { return .json(status: 401, body: "{\"ok\":false}") }
            return await handleEvent(request)
        case ("POST", "/approve"):
            guard authorized(request) else { return .json(status: 401, body: "{\"ok\":false}") }
            return await handleApprove(request)
        default:
            return .json(status: 404, body: "{\"ok\":false}")
        }
    }

    /// `POST /event`: records the event in the activity feed. Kimi
    /// `PermissionRequest` additionally pins a display-only pending approval,
    /// removed when the matching `PermissionResult` arrives.
    private func handleEvent(_ request: BridgeHTTPRequest) async -> Response {
        guard let object = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any],
              let cli = object["cli"] as? String,
              let event = object["event"] as? String else {
            return .json(status: 400, body: "{\"ok\":false}")
        }
        let payload = object["payload"] as? [String: Any]
        let summary = BridgeSummary.eventSummary(event: event, payload: payload)
        await store.recordEvent(cli: cli, event: event, summary: summary)

        if event == "PermissionRequest" {
            let toolName = payload?["tool_name"] as? String ?? "PermissionRequest"
            await store.registerPendingApproval(
                cli: cli,
                toolName: toolName,
                summary: summary,
                project: (payload?["cwd"] as? String).map(Self.projectName(for:)),
                sessionID: payload?["session_id"] as? String,
                hasResponder: false
            )
        } else if event == "PermissionResult" {
            await store.resolveDisplayApproval(cli: cli, sessionID: payload?["session_id"] as? String)
        }
        return .json(status: 200, body: "{\"ok\":true}")
    }

    /// `POST /approve`: registers a pending approval and holds the response
    /// open until the user decides (200 with the hook decision JSON) or the
    /// timeout elapses / the panel dismisses it (204 — the shim then prints
    /// nothing and the CLI shows its normal prompt: fail-open).
    private func handleApprove(_ request: BridgeHTTPRequest) async -> Response {
        guard let object = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any],
              let cli = object["cli"] as? String else {
            return .json(status: 400, body: "{\"ok\":false}")
        }
        let payload = object["payload"] as? [String: Any]
        let toolName = payload?["tool_name"] as? String ?? "unknown"
        let summary = BridgeSummary.approvalSummary(
            toolName: toolName,
            toolInput: payload?["tool_input"] as? [String: Any]
        )
        let approval = await store.registerPendingApproval(
            cli: cli,
            toolName: toolName,
            summary: summary,
            project: (payload?["cwd"] as? String).map(Self.projectName(for:)),
            sessionID: payload?["session_id"] as? String,
            hasResponder: true
        )

        let decision = await waitForDecision(id: approval.id)
        switch decision {
        case .allow:
            return .json(status: 200, body: Self.decisionBody(decision: "allow", reason: nil))
        case .deny(let reason):
            return .json(status: 200, body: Self.decisionBody(decision: "deny", reason: reason))
        case .dismissed, .none:
            return .empty(status: 204)
        }
    }

    /// Races the store's decision continuation against the approval timeout.
    /// On timeout the approval is resolved as dismissed (which also resumes
    /// and cleans up the losing continuation) and the caller answers 204.
    private func waitForDecision(id: UUID) async -> ApprovalDecision? {
        await withTaskGroup(of: ApprovalDecision?.self) { group in
            group.addTask { [store] in
                await store.awaitDecision(id: id)
            }
            group.addTask { [approvalTimeout] in
                try? await Task.sleep(for: .seconds(approvalTimeout))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            if first == nil {
                await store.resolve(id: id, decision: .dismissed)
            }
            return first
        }
    }

    private static func decisionBody(decision: String, reason: String?) -> String {
        var fields = "\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"\(decision)\""
        if let reason, !reason.isEmpty {
            let escaped = reason
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            fields += ",\"permissionDecisionReason\":\"\(escaped)\""
        }
        return "{\"hookSpecificOutput\":{\(fields)}}"
    }

    /// Display name for a project directory: the last path component.
    private static func projectName(for cwd: String) -> String {
        let trimmed = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
        return URL(fileURLWithPath: trimmed).lastPathComponent
    }

    // MARK: - Response writing

    private func send(_ response: Response, on connection: NWConnection) {
        var header = "HTTP/1.1 \(response.status) \(Self.statusText(response.status))\r\n"
        header += "Content-Type: application/json\r\n"
        header += "Content-Length: \(response.body?.count ?? 0)\r\n"
        header += "Connection: close\r\n\r\n"
        var data = Data(header.utf8)
        if let body = response.body { data.append(body) }
        connection.send(content: data, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func statusText(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        default: return "OK"
        }
    }
}
