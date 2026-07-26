import Foundation
import Testing
@testable import FoldviewMenuBar

/// Pure tests of `CLIAction.arguments`: every case must produce a literal argv
/// array with the project/CLI path as one untouched element, never joined into a
/// single shell-parsable string. These need no process spawn at all.
struct CLIActionArgumentsTests {
    @Test func openArguments() {
        #expect(CLIAction.open(project: "/a b/c").arguments == ["action", "open", "--project", "/a b/c"])
    }

    @Test func startArgumentsWithOpenFlag() {
        #expect(
            CLIAction.start(project: "/p", open: true).arguments ==
            ["action", "start", "--project", "/p", "--open"]
        )
    }

    @Test func startArgumentsWithoutOpenFlag() {
        #expect(
            CLIAction.start(project: "/p", open: false).arguments ==
            ["action", "start", "--project", "/p"]
        )
    }

    @Test func stopArguments() {
        #expect(CLIAction.stop(project: "/p").arguments == ["action", "stop", "--project", "/p"])
    }

    @Test func editorArguments() {
        #expect(CLIAction.editor(project: "/p").arguments == ["action", "editor", "--project", "/p"])
    }

    @Test func aiArguments() {
        #expect(
            CLIAction.ai(
                project: "/p", cli: "/usr/local/bin/claude", count: 3,
                provider: nil, model: nil, effort: nil
            ).arguments ==
            ["action", "ai", "--project", "/p", "--cli", "/usr/local/bin/claude", "--count", "3", "--json"]
        )
    }

    @Test func aiModelControlArgumentsAreSeparateLiteralTokens() {
        let model = "model '$(touch /tmp/no)'\nnext"
        let effort = "high\"; echo nope"
        #expect(
            CLIAction.ai(
                project: "/a project", cli: "/opt/bin/codex", count: 2,
                provider: "codex", model: model, effort: effort
            ).arguments == [
                "action", "ai", "--project", "/a project", "--cli", "/opt/bin/codex", "--count", "2",
                "--provider", "codex", "--model", model, "--effort", effort, "--json"
            ]
        )
    }

    @Test func dangerousProjectPathStaysAsOneUntouchedArgvElement() {
        let dangerous = "/tmp/proj'; rm -rf ~ && echo $(whoami) #"
        let args = CLIAction.open(project: dangerous).arguments
        #expect(args == ["action", "open", "--project", dangerous])
        #expect(args.count == 4)
        #expect(args.last == dangerous, "the dangerous string must never be split or merged into another token")
    }

    @Test func dangerousCLIPathStaysAsOneUntouchedArgvElement() {
        let dangerousCLI = "/usr/local/bin/claude\" ; touch /tmp/pwned #"
        let args = CLIAction.ai(
            project: "/p", cli: dangerousCLI, count: 9,
            provider: nil, model: nil, effort: nil
        ).arguments
        #expect(args == ["action", "ai", "--project", "/p", "--cli", dangerousCLI, "--count", "9", "--json"])
    }

    // MARK: - Quoting helpers used only for the native "Open Foldview" launch.
    // Verified by round-tripping through the real interpreter rather than by
    // hand-deriving escaped strings, so the test can't silently encode the same
    // mistake as the implementation.

    @Test func posixQuoteRoundTripsSpecialCharactersThroughRealShell() throws {
        let samples = [
            "simple",
            "has space",
            "O'Brien's app",
            "quote\"inside",
            "back\\slash",
            "unicode 🚀 café",
            "semi;colon&pipe|dollar$paren()bang!"
        ]
        for sample in samples {
            let quoted = FoldviewCLI.posixQuote(sample)
            let output = try runShell("printf '%s' \(quoted)")
            #expect(output == sample, "POSIX quoting round-trip failed for: \(sample)")
        }
    }

    @Test func appleScriptQuoteRoundTripsSpecialCharactersThroughOsascript() throws {
        let samples = [
            "simple",
            "has space",
            "quote\"inside",
            "back\\slash",
            "unicode 🚀 café"
        ]
        for sample in samples {
            let quoted = FoldviewCLI.appleScriptQuote(sample)
            let output = try runOsascript("return \(quoted)")
            #expect(output == sample, "AppleScript quoting round-trip failed for: \(sample)")
        }
    }

    // MARK: - Helpers

    private func runShell(_ command: String) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func runOsascript(_ script: String) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}
