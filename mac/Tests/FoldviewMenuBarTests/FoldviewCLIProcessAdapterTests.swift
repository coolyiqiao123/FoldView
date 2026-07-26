import Foundation
import Testing
@testable import FoldviewMenuBar

private final class BeforeRunGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var entered = false
    private var released = false

    var hasEntered: Bool {
        condition.lock(); defer { condition.unlock() }
        return entered
    }

    func enterAndWait() {
        condition.lock()
        entered = true
        condition.broadcast()
        while !released { condition.wait() }
        condition.unlock()
    }

    func release() {
        condition.lock(); released = true; condition.broadcast(); condition.unlock()
    }
}

/// Exercises the real `Process`-based adapter end to end against small stand-in
/// executables written to a scratch temp directory — never the real `pm`, and
/// never `/bin/sh -c` with a built string. This is what proves the adapter
/// launches a literal executable with a literal argv array.
@Suite(.serialized)
final class FoldviewCLIProcessAdapterTests {
    private let scratchDirectory: URL

    init() throws {
        scratchDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("FoldviewCLITests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratchDirectory, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: scratchDirectory)
    }

    private func writeExecutable(named name: String, body: String) throws -> URL {
        let url = scratchDirectory.appendingPathComponent(name)
        try body.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    @Test func executablePathRecordAtomicallyCreatesAndReplacesWith0600Mode() throws {
        let directory = scratchDirectory.appendingPathComponent("record", isDirectory: true)
        let destination = directory.appendingPathComponent("cli-path-v1")

        #expect(FoldviewCLI.persistExecutablePath("/first/pm", destination: destination))
        #expect(try String(contentsOf: destination, encoding: .utf8) == "/first/pm\n")
        var attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)

        #expect(FoldviewCLI.persistExecutablePath("/second/pm", destination: destination))
        #expect(try String(contentsOf: destination, encoding: .utf8) == "/second/pm\n")
        attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == ["cli-path-v1"])
    }

    @Test func executablePathRecordRefusesToReplaceASymlink() throws {
        let directory = scratchDirectory.appendingPathComponent("symlink-record", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let victim = directory.appendingPathComponent("victim")
        try "unchanged".write(to: victim, atomically: true, encoding: .utf8)
        let destination = directory.appendingPathComponent("cli-path-v1")
        try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: victim)
        #expect(!FoldviewCLI.persistExecutablePath("/new/pm", destination: destination))
        #expect(try String(contentsOf: victim, encoding: .utf8) == "unchanged")
    }

    @Test func statusDecodesOutputFromARealSpawnedProcess() async throws {
        let script = "#!/bin/sh\ncat <<'JSON'\n\(PayloadFixtures.validJSON)\nJSON\n"
        let url = try writeExecutable(named: "pm", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })

        let payload = try await cli.status()
        #expect(payload.schemaVersion == 1)
        #expect(payload.projects.first?.name == "my-app")
    }

    @Test func missingExecutableThrowsExecutableNotFound() async {
        let cli = FoldviewCLI(executableResolver: { nil })
        do {
            _ = try await cli.status()
            Issue.record("expected executableNotFound")
        } catch let error as CLIError {
            #expect(error == .executableNotFound)
        } catch {
            Issue.record("unexpected error type: \(error)")
        }
    }

    @Test func nonZeroExitBecomesTypedErrorWithStderrMessage() async throws {
        let script = "#!/bin/sh\necho 'boom' 1>&2\nexit 3\n"
        let url = try writeExecutable(named: "pm", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })

        do {
            _ = try await cli.status()
            Issue.record("expected nonZeroExit")
        } catch let error as CLIError {
            guard case .nonZeroExit(let code, let message) = error else {
                Issue.record("wrong case: \(error)")
                return
            }
            #expect(code == 3)
            #expect(message == "boom")
        }
    }

    @Test func malformedOutputBecomesDecodingFailedError() async throws {
        let script = "#!/bin/sh\necho 'not json'\n"
        let url = try writeExecutable(named: "pm", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })

        do {
            _ = try await cli.status()
            Issue.record("expected decodingFailed")
        } catch let error as CLIError {
            guard case .decodingFailed = error else {
                Issue.record("wrong case: \(error)")
                return
            }
        }
    }

    /// The core injection-safety assertion: a project path containing shell
    /// metacharacters (`;`, `$()`, `#`, quotes) must arrive at the child process
    /// as one intact argv element. The stand-in script writes its *received*
    /// argv (not stdout, so this works for `perform`, which discards stdout) to
    /// a path passed through the environment, which `Process` inherits from this
    /// test process by default since `FoldviewCLI` never overrides `environment`.
    @Test func performPassesLiteralArgvNeverShellSource() async throws {
        let outputURL = scratchDirectory.appendingPathComponent("argv-capture.json")
        setenv("FOLDVIEW_TEST_ARGV_OUTPUT", outputURL.path, 1)
        defer { unsetenv("FOLDVIEW_TEST_ARGV_OUTPUT") }

        let script = """
        #!/usr/bin/env python3
        import sys, os, json
        out = os.environ["FOLDVIEW_TEST_ARGV_OUTPUT"]
        with open(out, "w") as f:
            json.dump(sys.argv[1:], f)
        """
        let url = try writeExecutable(named: "pm", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })

        let dangerous = "/tmp/proj'; echo INJECTED $(whoami) > /tmp/pwned #\"\\`"
        try await cli.perform(.open(project: dangerous))

        let data = try Data(contentsOf: outputURL)
        let receivedArgs = try JSONDecoder().decode([String].self, from: data)
        #expect(receivedArgs == ["action", "open", "--project", dangerous])
    }

    @Test func rootsListDecodesJSONArray() async throws {
        let script = "#!/bin/sh\necho '[\"/Users/example/one\", \"/Users/example/two\"]'\n"
        let url = try writeExecutable(named: "pm", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })

        let roots = try await cli.rootsList()
        #expect(roots == ["/Users/example/one", "/Users/example/two"])
    }

    @Test func aiCatalogDrainsOutputLargerThanAPipeBufferWithoutDeadlock() async throws {
        let script = """
        #!/usr/bin/env python3
        import json
        print(json.dumps({
          "schemaVersion": 1,
          "generatedAt": "2026-07-19T00:00:00.000Z",
          "padding": "x" * 1000000,
          "providers": [{
            "id": "codex", "name": "Codex", "executable": "/opt/bin/codex",
            "available": True, "error": None, "defaultModel": "deep", "defaultEffort": "medium",
            "models": [{"id":"deep","label":"Deep","detail":"D","efforts":["medium"],"defaultEffort":"medium"}]
          }]
        }))
        """
        let url = try writeExecutable(named: "pm-large", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })
        let result = try await cli.aiCatalog(provider: "codex")
        #expect(result.providers.first?.models.first?.id == "deep")
    }

    @Test func aiBridgeCommandsPassExactLiteralArgvIncludingHostileValues() async throws {
        let outputURL = scratchDirectory.appendingPathComponent("ai-argv.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        let outputPathLiteral = try #require(String(data: encoder.encode(outputURL.path), encoding: .utf8))
        let response = "{\"schemaVersion\":1,\"provider\":\"codex\",\"defaultModel\":\"x\",\"defaultEffort\":null,\"saved\":true}"
        let script = """
        #!/usr/bin/env python3
        import json, sys
        with open(\(outputPathLiteral), "w") as f: json.dump(sys.argv[1:], f)
        print('\(response)')
        """
        let url = try writeExecutable(named: "pm-ai-args", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })
        let model = "x '$(nope)'\nnext"
        let effort = "high\"; nope"
        try await cli.setAIDefault(provider: "codex", model: model, effort: effort)
        let data = try Data(contentsOf: outputURL)
        let args = try JSONDecoder().decode([String].self, from: data)
        #expect(args == ["ai", "defaults", "set", "--provider", "codex", "--model", model, "--effort", effort, "--json"])
    }

    @Test func configurationBridgeUsesOnlyExactLiteralArgv() async throws {
        let outputURL = scratchDirectory.appendingPathComponent("config-argv.jsonl")
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        let outputPathLiteral = try #require(String(data: encoder.encode(outputURL.path), encoding: .utf8))
        let script = """
        #!/usr/bin/env python3
        import json, sys
        with open(\(outputPathLiteral), "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")
        if sys.argv[1:] == ["config", "get", "--json"]:
          print('{"schemaVersion":1,"menubar":{"refreshSeconds":60,"showDiscoveredApps":true},"aiClis":[]}')
        else:
          print("ok")
        """
        let url = try writeExecutable(named: "pm-config-args", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })
        _ = try await cli.configuration()
        try await cli.setRefreshSeconds(45)
        try await cli.setShowDiscoveredApps(false)
        try await cli.addCustomAICLI(name: "Agent '$(safe)'", executable: "/tmp/agent;literal")
        try await cli.removeCustomAICLI(executable: "/tmp/agent;literal")

        let rows = try String(contentsOf: outputURL, encoding: .utf8)
            .split(separator: "\n")
            .map { try JSONDecoder().decode([String].self, from: Data($0.utf8)) }
        #expect(rows == [
            ["config", "get", "--json"],
            ["config", "set", "menubar.refreshSeconds", "45"],
            ["config", "set", "menubar.showDiscoveredApps", "false"],
            ["aiclis", "add", "--name", "Agent '$(safe)'", "--executable", "/tmp/agent;literal"],
            ["aiclis", "remove", "--executable", "/tmp/agent;literal"]
        ])
    }

    @Test func machineErrorEnvelopeBecomesTypedProviderError() async throws {
        let script = """
        #!/bin/sh
        echo '{"schemaVersion":1,"ok":false,"error":{"code":"unsupported_model","message":"Model disappeared.","provider":"codex","model":"old","effort":null,"retryable":false}}'
        exit 2
        """
        let url = try writeExecutable(named: "pm-ai-error", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })
        do {
            try await cli.perform(.ai(
                project: "/tmp/p", cli: "/opt/bin/codex", count: 1,
                provider: "codex", model: "old", effort: nil
            ))
            Issue.record("expected typed provider error")
        } catch let error as AIProviderCommandError {
            #expect(error.code == "unsupported_model")
            #expect(error.invalidatesCatalog)
            #expect(error.message == "Model disappeared.")
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func aiActionRequiresExactSchemaVersion1SuccessDocument() async throws {
        let action = CLIAction.ai(
            project: "/tmp/p", cli: "/opt/bin/codex", count: 2,
            provider: "codex", model: "deep", effort: "high"
        )
        let valid = "{\"schemaVersion\":1,\"ok\":true,\"launched\":2,\"provider\":\"codex\",\"model\":\"deep\",\"effort\":\"high\"}"
        let validURL = try writeExecutable(named: "pm-ai-valid", body: "#!/bin/sh\necho '\(valid)'\n")
        try await FoldviewCLI(executableResolver: { validURL.path }).perform(action)

        let invalidDocuments = [
            "",
            "not-json",
            "{\"schemaVersion\":2,\"ok\":true,\"launched\":2,\"provider\":\"codex\",\"model\":\"deep\",\"effort\":\"high\"}",
            "{\"schemaVersion\":1,\"ok\":false,\"launched\":2,\"provider\":\"codex\",\"model\":\"deep\",\"effort\":\"high\"}",
            "{\"schemaVersion\":1,\"ok\":true,\"launched\":1,\"provider\":\"codex\",\"model\":\"deep\",\"effort\":\"high\"}",
            "{\"schemaVersion\":1,\"ok\":true,\"launched\":2,\"provider\":\"kimi\",\"model\":\"deep\",\"effort\":\"high\"}",
            "{\"schemaVersion\":1,\"ok\":true,\"launched\":2,\"provider\":\"codex\",\"model\":\"other\",\"effort\":\"high\"}",
            "{\"schemaVersion\":1,\"ok\":true,\"launched\":2,\"provider\":\"codex\",\"model\":\"deep\"}"
        ]
        for (index, document) in invalidDocuments.enumerated() {
            let body = document.isEmpty ? "#!/bin/sh\nexit 0\n" : "#!/bin/sh\necho '\(document)'\n"
            let url = try writeExecutable(named: "pm-ai-invalid-\(index)", body: body)
            do {
                try await FoldviewCLI(executableResolver: { url.path }).perform(action)
                Issue.record("invalid AI action document \(index) was accepted")
            } catch is CLIError {
                // Expected safe typed bridge failure.
            } catch {
                Issue.record("unexpected error type: \(error)")
            }
        }
    }

    @Test func preCancelledTaskNeverStartsProcess() async throws {
        let marker = scratchDirectory.appendingPathComponent("pre-cancel-started")
        let script = "#!/bin/sh\ntouch '\(marker.path)'\necho '{}'\n"
        let url = try writeExecutable(named: "pm-pre-cancel", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path })
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await cli.status()
        }
        do {
            _ = try await task.value
            Issue.record("expected cancellation")
        } catch is CancellationError {
            #expect(!FileManager.default.fileExists(atPath: marker.path))
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func foundationProcessGroupIsRecognizedAndVerified() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["5"]
        try process.run()
        let pid = process.processIdentifier
        let group = ProcessGroupVerifier.verifiedChildOwnedGroup(for: pid)
        #expect(group == pid)
        if let group { _ = Darwin.kill(-group, SIGKILL) }
        process.waitUntilExit()
    }

    @Test func cancellationBetweenCheckAndSpawnIsReplayedAfterGroupVerification() async throws {
        let marker = scratchDirectory.appendingPathComponent("cancel-during-start-pid")
        let script = "#!/bin/sh\necho $$ > '\(marker.path)'\ntrap '' TERM\nwhile :; do sleep 1; done\n"
        let url = try writeExecutable(named: "pm-cancel-during-start", body: script)
        let gate = BeforeRunGate()
        let cli = FoldviewCLI(
            executableResolver: { url.path },
            timeoutResolver: { _ in 5 },
            beforeRun: { gate.enterAndWait() }
        )
        let task = Task { try await cli.status() }
        let deadline = Date().addingTimeInterval(2)
        while !gate.hasEntered, Date() < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(gate.hasEntered)
        task.cancel()
        gate.release()
        do {
            _ = try await task.value
            Issue.record("expected cancellation")
        } catch is CancellationError {
            // Pending cancellation was replayed after Process.run/group verify.
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func timeoutEscalatesPastIgnoredSIGTERM() async throws {
        let script = "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n"
        let url = try writeExecutable(named: "pm-ignore-term", body: script)
        let cli = FoldviewCLI(
            executableResolver: { url.path },
            timeoutResolver: { _ in 0.10 }
        )
        let started = Date()
        do {
            _ = try await cli.status()
            Issue.record("expected timeout")
        } catch let error as CLIError {
            #expect(error == .processTimedOut)
            #expect(Date().timeIntervalSince(started) < 2)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func cancellationAfterDescendantHandshakeKillsWholeVerifiedGroup() async throws {
        let marker = scratchDirectory.appendingPathComponent("descendant-writes")
        let pidFile = scratchDirectory.appendingPathComponent("descendant-pid")
        let script = """
        #!/bin/sh
        trap '' TERM
        (
          trap '' TERM
          while :; do
            printf x >> '\(marker.path)'
            sleep 0.02
          done
        ) &
        echo $! > '\(pidFile.path)'
        wait
        """
        let url = try writeExecutable(named: "pm-background-descendant", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path }, timeoutResolver: { _ in 30.0 })
        let task = Task { try await cli.status() }
        let handshakeDeadline = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(atPath: pidFile.path), Date() < handshakeDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(FileManager.default.fileExists(atPath: pidFile.path))
        task.cancel()
        do {
            _ = try await task.value
            Issue.record("expected cancellation")
        } catch is CancellationError {
            // Expected after the verified group reaches EOF.
        } catch {
            Issue.record("unexpected error: \(error)")
        }

        let pidText = try String(contentsOf: pidFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let descendantPID = try #require(pid_t(pidText))
        let deadline = Date().addingTimeInterval(1)
        while Darwin.kill(descendantPID, 0) == 0, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(Darwin.kill(descendantPID, 0) != 0)
        let size = (try? Data(contentsOf: marker).count) ?? 0
        try await Task.sleep(for: .milliseconds(120))
        #expect(((try? Data(contentsOf: marker).count) ?? 0) == size)
    }

    @Test func successfulLeaderWithPipeHoldingDescendantIsBoundedAndCleanedUp() async throws {
        let marker = scratchDirectory.appendingPathComponent("exit-zero-descendant-writes")
        let pidFile = scratchDirectory.appendingPathComponent("exit-zero-descendant-pid")
        let script = """
        #!/bin/sh
        (
          trap '' TERM
          while :; do
            printf x >> '\(marker.path)'
            sleep 0.02
          done
        ) &
        echo $! > '\(pidFile.path)'
        cat <<'JSON'
        \(PayloadFixtures.validJSON)
        JSON
        exit 0
        """
        let url = try writeExecutable(named: "pm-exit-zero-background-descendant", body: script)
        let cli = FoldviewCLI(executableResolver: { url.path }, timeoutResolver: { _ in 5.0 })
        let started = Date()
        do {
            _ = try await cli.status()
            Issue.record("pipe-holding descendant should surface the bounded drain timeout")
        } catch let error as CLIError {
            #expect(error == .processTimedOut)
            #expect(Date().timeIntervalSince(started) < 2)
        } catch {
            Issue.record("unexpected error: \(error)")
        }

        let pidText = try String(contentsOf: pidFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let descendantPID = try #require(pid_t(pidText))
        let deadline = Date().addingTimeInterval(1)
        while Darwin.kill(descendantPID, 0) == 0, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(Darwin.kill(descendantPID, 0) != 0)
        let size = (try? Data(contentsOf: marker).count) ?? 0
        try await Task.sleep(for: .milliseconds(120))
        #expect(((try? Data(contentsOf: marker).count) ?? 0) == size)
    }

    @Test func sharedAccumulatorNeverRetainsBeyondHardCombinedEightMiBCap() throws {
        let cap = 8 * 1024 * 1024
        let accumulator = BoundedOutputAccumulator(byteLimit: cap)
        #expect(!accumulator.append(Data(repeating: 1, count: 6 * 1024 * 1024), to: .stdout))
        #expect(accumulator.append(Data(repeating: 2, count: 4 * 1024 * 1024), to: .stderr))
        #expect(accumulator.retainedByteCount == cap)
        #expect(accumulator.didOverflow)
        #expect(!accumulator.append(Data(repeating: 3, count: 200_000), to: .stdout))
        let snapshot = try accumulator.snapshot()
        #expect(snapshot.stdout.count + snapshot.stderr.count == cap)
    }

    @Test func combinedCaptureOverflowTerminatesWithSafeTypedError() async throws {
        let script = "#!/usr/bin/env python3\nimport sys\nsys.stdout.write('x' * 200000)\nsys.stdout.flush()\n"
        let url = try writeExecutable(named: "pm-overflow", body: script)
        let cli = FoldviewCLI(
            executableResolver: { url.path },
            captureLimitBytes: 32 * 1024,
            timeoutResolver: { _ in 5 }
        )
        do {
            _ = try await cli.status()
            Issue.record("expected output limit")
        } catch let error as CLIError {
            #expect(error == .outputLimitExceeded)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

}
