import Foundation
import Testing
@testable import FoldviewMenuBar

/// Exercises the real `Process`-based adapter end to end against small stand-in
/// executables written to a scratch temp directory — never the real `pm`, and
/// never `/bin/sh -c` with a built string. This is what proves the adapter
/// launches a literal executable with a literal argv array.
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
}
