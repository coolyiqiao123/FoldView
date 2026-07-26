import Foundation
import Testing
@testable import FoldviewMenuBar

/// Round-trip tests for the localhost approval bridge: health, event feed,
/// the held-open approve flow (allow/deny → 200 decision JSON, timeout →
/// 204), auth, 404s, and the state file lifecycle.
@MainActor
struct NotchBridgeServerTests {
    private func makeServer(
        approvalTimeout: TimeInterval = 0.5
    ) -> (server: NotchBridgeServer, store: AgentActivityStore, stateURL: URL) {
        let store = AgentActivityStore()
        let stateURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("foldview-test-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("notch-bridge-v1.json")
        let server = NotchBridgeServer(
            store: store,
            token: "test-token",
            approvalTimeout: approvalTimeout,
            stateFileURL: stateURL
        )
        return (server, store, stateURL)
    }

    private func request(
        _ method: String,
        _ path: String,
        port: Int,
        token: String? = nil,
        body: String? = nil
    ) async throws -> (status: Int, data: Data) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = Data(body.utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        return (status, data)
    }

    /// Waits (with a bounded poll) until `condition` holds, so tests can sync
    /// on the async store updates the bridge performs.
    private func waitUntil(
        timeout: TimeInterval = 5,
        _ condition: @MainActor () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    @Test func healthEndpointRespondsOK() async throws {
        let (server, _, stateURL) = makeServer()
        let port = try await server.start()
        defer { server.stop() }

        let (status, data) = try await request("GET", "/health", port: port)
        #expect(status == 200)
        #expect(String(data: data, encoding: .utf8) == "{\"ok\":true}")
        _ = stateURL
    }

    @Test func stateFileWrittenOnStartAndRemovedOnStop() async throws {
        let (server, _, stateURL) = makeServer()
        let port = try await server.start()

        let data = try Data(contentsOf: stateURL)
        let state = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(state["schemaVersion"] as? Int == 1)
        #expect(state["port"] as? Int == port)
        #expect(state["token"] as? String == "test-token")
        #expect(state["pid"] as? Int == Int(ProcessInfo.processInfo.processIdentifier))
        #expect(state["launchedAt"] is String)
        // 0600 permissions.
        let attributes = try FileManager.default.attributesOfItem(atPath: stateURL.path)
        #expect(attributes[.posixPermissions] as? Int == 0o600)

        server.stop()
        #expect(!FileManager.default.fileExists(atPath: stateURL.path))
    }

    @Test func eventFeedsActivityStore() async throws {
        let (server, store, _) = makeServer()
        let port = try await server.start()
        defer { server.stop() }

        let body = """
        {"cli":"claude","event":"PostToolUse","payload":{"tool_name":"Bash","tool_input":{"command":"swift build"}}}
        """
        let (status, data) = try await request("POST", "/event", port: port, token: "test-token", body: body)
        #expect(status == 200)
        #expect(String(data: data, encoding: .utf8) == "{\"ok\":true}")

        let recorded = await waitUntil { store.events.count == 1 }
        #expect(recorded)
        #expect(store.events.first?.cli == "claude")
        #expect(store.events.first?.event == "PostToolUse")
        #expect(store.events.first?.summary == "swift build")
    }

    @Test func kimiPermissionRequestPinsAndResultClears() async throws {
        let (server, store, _) = makeServer()
        let port = try await server.start()
        defer { server.stop() }

        let requestBody = """
        {"cli":"kimi","event":"PermissionRequest","payload":{"session_id":"k1","tool_name":"Write","tool_input":{"file_path":"/tmp/a.swift"},"cwd":"/tmp/proj"}}
        """
        let (s1, _) = try await request("POST", "/event", port: port, token: "test-token", body: requestBody)
        #expect(s1 == 200)
        let pinned = await waitUntil { store.pendingApprovals.count == 1 }
        #expect(pinned)
        #expect(store.pendingApprovals.first?.hasResponder == false)
        #expect(store.pendingApprovals.first?.summary == "/tmp/a.swift")
        #expect(store.pendingApprovals.first?.project == "proj")

        let resultBody = """
        {"cli":"kimi","event":"PermissionResult","payload":{"session_id":"k1"}}
        """
        let (s2, _) = try await request("POST", "/event", port: port, token: "test-token", body: resultBody)
        #expect(s2 == 200)
        let cleared = await waitUntil { store.pendingApprovals.isEmpty }
        #expect(cleared)
    }

    @Test func approveResolvesWithAllowDecision() async throws {
        let (server, store, _) = makeServer(approvalTimeout: 5)
        let port = try await server.start()
        defer { server.stop() }

        let body = """
        {"cli":"claude","event":"PreToolUse","payload":{"session_id":"s1","cwd":"/Users/example/foldview","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/example"}}}
        """
        async let response = request("POST", "/approve", port: port, token: "test-token", body: body)

        let appeared = await waitUntil { store.pendingApprovals.count == 1 }
        #expect(appeared)
        let approval = try #require(store.pendingApprovals.first)
        #expect(approval.cli == "claude")
        #expect(approval.toolName == "Bash")
        #expect(approval.summary == "rm -rf /tmp/example")
        #expect(approval.project == "foldview")
        #expect(approval.sessionID == "s1")
        #expect(approval.hasResponder == true)

        store.resolve(id: approval.id, decision: .allow)
        let (status, data) = try await response
        #expect(status == 200)
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains("\"hookEventName\":\"PreToolUse\""))
        #expect(json.contains("\"permissionDecision\":\"allow\""))
        #expect(store.pendingApprovals.isEmpty)
    }

    @Test func approveResolvesWithDenyReason() async throws {
        let (server, store, _) = makeServer(approvalTimeout: 5)
        let port = try await server.start()
        defer { server.stop() }

        let body = """
        {"cli":"claude","event":"PreToolUse","payload":{"session_id":"s2","cwd":"/tmp","tool_name":"Edit","tool_input":{"file_path":"/tmp/b.swift"}}}
        """
        async let response = request("POST", "/approve", port: port, token: "test-token", body: body)

        let appeared = await waitUntil { store.pendingApprovals.count == 1 }
        #expect(appeared)
        let approval = try #require(store.pendingApprovals.first)
        #expect(approval.summary == "/tmp/b.swift")

        store.resolve(id: approval.id, decision: .deny(reason: "not now"))
        let (status, data) = try await response
        #expect(status == 200)
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains("\"permissionDecision\":\"deny\""))
        #expect(json.contains("\"permissionDecisionReason\":\"not now\""))
    }

    @Test func approveTimesOutWith204() async throws {
        let (server, store, _) = makeServer(approvalTimeout: 0.5)
        let port = try await server.start()
        defer { server.stop() }

        let body = """
        {"cli":"claude","event":"PreToolUse","payload":{"session_id":"s3","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"sleep 1"}}}
        """
        let (status, data) = try await request("POST", "/approve", port: port, token: "test-token", body: body)
        #expect(status == 204)
        #expect(data.isEmpty)
        // The timeout also dismisses the pending card in the store.
        #expect(store.pendingApprovals.isEmpty)
    }

    @Test func missingOrWrongTokenGets401() async throws {
        let (server, _, _) = makeServer()
        let port = try await server.start()
        defer { server.stop() }

        let noToken = try await request("POST", "/event", port: port, body: "{\"cli\":\"claude\",\"event\":\"x\"}")
        #expect(noToken.status == 401)

        let wrongToken = try await request(
            "POST", "/event", port: port, token: "nope",
            body: "{\"cli\":\"claude\",\"event\":\"x\"}"
        )
        #expect(wrongToken.status == 401)
    }

    @Test func unknownPathGets404() async throws {
        let (server, _, _) = makeServer()
        let port = try await server.start()
        defer { server.stop() }

        let (status, _) = try await request("GET", "/nope", port: port)
        #expect(status == 404)
        let (postStatus, _) = try await request("POST", "/health", port: port, token: "test-token")
        #expect(postStatus == 404)
    }

    @Test func malformedEventBodyGets400() async throws {
        let (server, _, _) = makeServer()
        let port = try await server.start()
        defer { server.stop() }

        let (status, _) = try await request("POST", "/event", port: port, token: "test-token", body: "{\"cli\":42}")
        #expect(status == 400)
    }

    // MARK: - Summary builder (pure)

    @Test func approvalSummaryTrimsBashCommandTo120() {
        let longCommand = String(repeating: "x", count: 200)
        let summary = BridgeSummary.approvalSummary(toolName: "Bash", toolInput: ["command": longCommand])
        #expect(summary.count == 121) // 120 chars + ellipsis
        #expect(summary.hasSuffix("…"))
    }

    @Test func approvalSummaryPrefersFilePathForFileTools() {
        #expect(BridgeSummary.approvalSummary(toolName: "Write", toolInput: ["file_path": "/tmp/x"]) == "/tmp/x")
        #expect(BridgeSummary.approvalSummary(toolName: "Edit", toolInput: ["file_path": "/tmp/y"]) == "/tmp/y")
        #expect(BridgeSummary.approvalSummary(toolName: "MultiEdit", toolInput: nil) == "MultiEdit")
        #expect(BridgeSummary.approvalSummary(toolName: "WebFetch", toolInput: ["url": "https://x"]) == "WebFetch")
    }
}
