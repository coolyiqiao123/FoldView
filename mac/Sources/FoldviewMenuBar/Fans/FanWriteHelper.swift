import Foundation

/// Helper modes for privileged fan work. The app binary is re-executed as
/// root via AppleScript in two shapes:
///
/// - `--fan-daemon <appPid>`: the long-lived root daemon (one password prompt
///   per app session) that probes fan state and executes command files. See
///   `Fans/FanDaemon.swift`.
/// - `--fan-write <fan> <rpm>` / `--fan-auto <fan>`: legacy one-shot writes,
///   kept for diagnostics; the UI path now goes through the daemon.
///
/// This entry point detects those arguments before any SwiftUI scene exists
/// and never starts the UI in helper mode.
enum FanWriteHelper {
    /// A parsed helper invocation. Kept pure (no side effects) so argument
    /// parsing is unit-testable.
    enum Mode: Equatable {
        case fanWrite(fan: Int, rpm: Int)
        case fanAuto(fan: Int)
        case fanDaemon(appPID: Int32)
    }

    /// Parses `CommandLine.arguments` into a helper mode. Returns nil for
    /// normal launches and for malformed arguments (the caller treats a
    /// malformed `--fan-*` invocation as a usage error, never as a launch).
    static func mode(for arguments: [String]) -> Mode? {
        let args = Array(arguments.dropFirst())
        guard let first = args.first else { return nil }
        switch first {
        case "--fan-write":
            guard args.count >= 3, let fan = Int(args[1]), let rpm = Int(args[2]) else { return nil }
            return .fanWrite(fan: fan, rpm: rpm)
        case "--fan-auto":
            guard args.count >= 2, let fan = Int(args[1]) else { return nil }
            return .fanAuto(fan: fan)
        case "--fan-daemon":
            guard args.count >= 2, let pid = Int32(args[1]) else { return nil }
            return .fanDaemon(appPID: pid)
        default:
            return nil
        }
    }

    /// Checks `arguments` (pass `CommandLine.arguments`) for a helper-mode
    /// invocation. Returns immediately for normal launches; for helper
    /// invocations this function never returns — it terminates the process.
    static func exitIfHelperInvocation(_ arguments: [String]) {
        switch mode(for: arguments) {
        case .fanWrite(let fan, let rpm):
            run { smc in
                try smc.setFanTarget(fan: fan, rpm: rpm)
                return "ok fan \(fan) target \(rpm)"
            }
        case .fanAuto(let fan):
            run { smc in
                try smc.setFanAuto(fan: fan)
                return "ok fan \(fan) auto"
            }
        case .fanDaemon(let appPID):
            FanDaemon(appPid: appPID).run()
        case nil:
            let args = Array(arguments.dropFirst())
            if let first = args.first, first.hasPrefix("--fan") {
                fail("unrecognized fan helper arguments: \(args.joined(separator: " "))")
            }
            return
        }
    }

    /// Prints an error line and exits 1.
    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data(("error: \(message)\n").utf8))
        exit(1)
    }

    private static func run(_ body: (SMC) throws -> String) -> Never {
        do {
            let smc = try SMC()
            let message = try body(smc)
            print(message)
            fflush(stdout)
            exit(0)
        } catch {
            let description = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            fail(description)
        }
    }
}
