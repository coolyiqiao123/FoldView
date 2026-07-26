import Foundation

/// A snapshot of one fan: current speed, the allowed target range, whether a
/// forced (manual) target is currently applied, and that target when known.
/// `id` is the SMC fan index (`F<id>Ac` etc.). `targetRPM` and the range can
/// be unknown when the powermetrics fallback supplies the reading.
struct FanReading: Sendable, Equatable, Identifiable {
    let id: Int
    let name: String
    let actualRPM: Double
    let minRPM: Double
    let maxRPM: Double
    let isForced: Bool
    let targetRPM: Double?

    init(id: Int, name: String, actualRPM: Double, minRPM: Double, maxRPM: Double, isForced: Bool, targetRPM: Double? = nil) {
        self.id = id
        self.name = name
        self.actualRPM = actualRPM
        self.minRPM = minRPM
        self.maxRPM = maxRPM
        self.isForced = isForced
        self.targetRPM = targetRPM
    }
}

/// Typed errors surfaced by the fan write path (the escalated helper run via
/// AppleScript). `cancelled` means the user dismissed the password prompt.
enum FanWriteError: Error, LocalizedError, Equatable {
    case cancelled
    case helperFailed(String)
    case launchFailed(String)

    var errorDescription: String? {
        switch self {
        case .cancelled:
            return "Fan change cancelled — no password was entered."
        case .helperFailed(let message):
            return message.isEmpty ? "The fan change failed." : message
        case .launchFailed(let message):
            return "Could not start the fan helper: \(message)"
        }
    }
}
