import Foundation
import IOKit

/// Typed errors surfaced by the SMC wrapper. Missing hardware support and
/// missing keys are ordinary failures, never crashes — callers (FanStore,
/// the write helper) degrade to read-only or unavailable instead.
enum SMCError: Error, LocalizedError, Equatable {
    case serviceUnavailable
    case openFailed(kern_return_t)
    case callFailed(kern_return_t)
    case keyNotFound(String)
    case readFailed(String)
    case invalidKey(String)
    case unsupportedDataType(String)
    /// The key read succeeded but returned zero bytes. On recent hardware
    /// (verified on MacBook Pro M5 / macOS 26) unprivileged value reads are
    /// neutered this way — success result, dataSize 0, empty bytes.
    case noData(String)

    var errorDescription: String? {
        switch self {
        case .serviceUnavailable:
            return "The SMC is not available on this Mac."
        case .openFailed(let code):
            return "Could not open the SMC (IOReturn \(code))."
        case .callFailed(let code):
            return "An SMC call failed (IOReturn \(code))."
        case .keyNotFound(let key):
            return "The SMC key \(key) does not exist on this Mac."
        case .readFailed(let key):
            return "The SMC could not read the key \(key)."
        case .invalidKey(let key):
            return "\(key) is not a valid four-character SMC key."
        case .unsupportedDataType(let type):
            return "The SMC data type \(type) is not supported."
        case .noData(let key):
            return "The SMC returned no data for \(key) (value reads may require elevated privileges on this Mac)."
        }
    }
}

/// Pure encode/decode helpers for SMC wire values, separated from the IOKit
/// calls so they can be unit-tested against recorded byte fixtures without
/// touching hardware.
enum SMCValueCodec {
    /// Packs a four-character SMC key (e.g. `F0Ac`, `FS! `) into the big-endian
    /// UInt32 the kernel interface expects. Returns nil for anything that is
    /// not exactly four ASCII characters.
    static func keyCode(for key: String) -> UInt32? {
        let scalars = key.utf8
        guard scalars.count == 4 else { return nil }
        var code: UInt32 = 0
        for byte in scalars {
            code = (code << 8) | UInt32(byte)
        }
        return code
    }

    /// Unpacks a big-endian UInt32 back into its four-character key string.
    static func keyString(for code: UInt32) -> String {
        let bytes: [UInt8] = [
            UInt8((code >> 24) & 0xFF),
            UInt8((code >> 16) & 0xFF),
            UInt8((code >> 8) & 0xFF),
            UInt8(code & 0xFF)
        ]
        return String(bytes: bytes, encoding: .ascii) ?? ""
    }

    /// `fpe2`: unsigned 16-bit big-endian fixed-point with 2 fraction bits
    /// (value = raw × 2^-2). This is the encoding fan RPM keys use on Intel
    /// and most Apple Silicon models.
    static func fpe2(_ bytes: [UInt8]) -> Double {
        guard bytes.count >= 2 else { return 0 }
        let raw = (UInt16(bytes[0]) << 8) | UInt16(bytes[1])
        return Double(raw) / 4.0
    }

    /// Encodes a value as `fpe2` big-endian bytes for a write.
    static func encodeFPE2(_ value: Double) -> [UInt8] {
        let raw = UInt16(min(max(value * 4.0, 0), Double(UInt16.max)))
        return [UInt8((raw >> 8) & 0xFF), UInt8(raw & 0xFF)]
    }

    /// `flt `: a 32-bit little-endian IEEE-754 float (Apple Silicon fan keys).
    static func float32(_ bytes: [UInt8]) -> Double {
        guard bytes.count >= 4 else { return 0 }
        let raw = UInt32(bytes[0])
            | (UInt32(bytes[1]) << 8)
            | (UInt32(bytes[2]) << 16)
            | (UInt32(bytes[3]) << 24)
        return Double(Float(bitPattern: raw))
    }

    /// Big-endian variant of `flt ` — some firmware revisions report float
    /// keys most-significant-byte first. Callers sanity-check the decoded
    /// value and switch endianness when little-endian yields nonsense.
    static func float32BigEndian(_ bytes: [UInt8]) -> Double {
        guard bytes.count >= 4 else { return 0 }
        let raw = (UInt32(bytes[0]) << 24)
            | (UInt32(bytes[1]) << 16)
            | (UInt32(bytes[2]) << 8)
            | UInt32(bytes[3])
        return Double(Float(bitPattern: raw))
    }

    /// Encodes a value as `flt ` little-endian bytes for a write.
    static func encodeFloat32(_ value: Double) -> [UInt8] {
        let raw = Float(value).bitPattern
        return [
            UInt8(raw & 0xFF),
            UInt8((raw >> 8) & 0xFF),
            UInt8((raw >> 16) & 0xFF),
            UInt8((raw >> 24) & 0xFF)
        ]
    }

    /// `ui16`: unsigned 16-bit big-endian integer (e.g. the `FS! ` force mask).
    static func ui16(_ bytes: [UInt8]) -> Int {
        guard bytes.count >= 2 else { return 0 }
        return Int((UInt16(bytes[0]) << 8) | UInt16(bytes[1]))
    }

    /// Encodes an integer as `ui16` big-endian bytes for a write.
    static func encodeUI16(_ value: Int) -> [UInt8] {
        let raw = UInt16(min(max(value, 0), Int(UInt16.max)))
        return [UInt8((raw >> 8) & 0xFF), UInt8(raw & 0xFF)]
    }

    /// `ui8 `: unsigned 8-bit integer (e.g. `FNum`).
    static func ui8(_ bytes: [UInt8]) -> Int {
        Int(bytes.first ?? 0)
    }

    /// Decodes an SMC key value according to its reported data type.
    /// Returns nil for unrecognized types — never throws — so one oddly-typed
    /// key cannot take down a whole fan read. `preferBigEndianFloat` switches
    /// the `flt ` decode for firmware that reports floats big-endian.
    static func decode(type: String, bytes: [UInt8], preferBigEndianFloat: Bool = false) -> Double? {
        switch type {
        case "fpe2": return fpe2(bytes)
        case "flt ": return preferBigEndianFloat ? float32BigEndian(bytes) : float32(bytes)
        case "ui16": return Double(ui16(bytes))
        case "ui8 ": return Double(ui8(bytes))
        default: return nil
        }
    }
}

// MARK: - Kernel struct layout

/// The classic 80-byte SMCParamStruct. Tuples stand in for C fixed-size
/// arrays so Swift lays the struct out exactly like the kernel interface:
/// key(4) vers(6) pLimitData(16) keyInfo(12) result(1) status(1) data8(1)
/// pad(1) data32(4) bytes(32) = 80 bytes. A unit test pins the size.
struct SMCParamStruct {
    struct Vers {
        var major: UInt8 = 0
        var minor: UInt8 = 0
        var build: UInt8 = 0
        var reserved: UInt8 = 0
        var release: UInt16 = 0
    }

    struct KeyInfo {
        var dataSize: UInt32 = 0
        var dataType: UInt32 = 0
        var dataAttributes: UInt32 = 0
    }

    typealias PLimitData = (
        UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
        UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8
    )
    typealias Bytes32 = (
        UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
        UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
        UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
        UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8
    )

    var key: UInt32 = 0
    var vers = Vers()
    var pLimitData: PLimitData = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    var keyInfo = KeyInfo()
    var result: UInt8 = 0
    var status: UInt8 = 0
    var data8: UInt8 = 0
    var data32: UInt32 = 0
    var bytes: Bytes32 = (
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    )
}

// MARK: - SMC connection

/// Minimal IOKit `AppleSMC` client: open once, then read/write keys through
/// `IOConnectCallStructMethod` with the classic param-struct layout. Reads
/// need no privileges; writes require root (see `FanWriteHelper`).
/// `@unchecked Sendable` because the raw `io_connect_t` is only ever used
/// from the owner's serial queue (or the single-threaded helper process).
final class SMC: @unchecked Sendable {
    /// A decoded key read: the reported data type and the raw value bytes.
    struct KeyValue {
        let type: String
        let bytes: [UInt8]
    }

    private enum Command {
        static let handleYPCEvent: UInt32 = 2
        static let readKey: UInt8 = 5
        static let writeKey: UInt8 = 6
        static let getKeyInfo: UInt8 = 9
    }

    private enum Result {
        static let success: UInt8 = 0
        static let keyNotFound: UInt8 = 0x84
    }

    private var connection: io_connect_t = 0

    init() throws {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"))
        guard service != IO_OBJECT_NULL else { throw SMCError.serviceUnavailable }
        defer { IOObjectRelease(service) }
        var conn: io_connect_t = 0
        let openResult = IOServiceOpen(service, mach_task_self_, 0, &conn)
        guard openResult == kIOReturnSuccess else { throw SMCError.openFailed(openResult) }
        connection = conn
    }

    deinit {
        if connection != 0 { IOServiceClose(connection) }
    }

    // MARK: Reads

    /// Key info without a value read: the key's data type and size. Works
    /// unprivileged even where value reads are neutered, so it doubles as a
    /// key-existence probe (throws `keyNotFound` for unknown keys).
    func keyInfo(for key: String) throws -> (type: String, size: Int) {
        guard let keyCode = SMCValueCodec.keyCode(for: key) else {
            throw SMCError.invalidKey(key)
        }
        var input = SMCParamStruct()
        input.key = keyCode
        input.data8 = Command.getKeyInfo
        let info = try call(&input, key: key)
        return (SMCValueCodec.keyString(for: info.keyInfo.dataType), Int(info.keyInfo.dataSize))
    }

    /// True when the key exists (GetKeyInfo succeeds). Never throws.
    func keyExists(_ key: String) -> Bool {
        (try? keyInfo(for: key)) != nil
    }

    /// Reads one key and returns its data type plus raw bytes. Throws
    /// `SMCError.keyNotFound` when the firmware reports an unknown key. A
    /// successful-but-empty read (neutered unprivileged reads on recent
    /// hardware) returns empty bytes rather than throwing — callers use
    /// `readNumeric`, which maps that to `SMCError.noData`.
    func readKey(_ key: String) throws -> KeyValue {
        let info = try keyInfo(for: key)
        guard info.size <= 32 else { throw SMCError.readFailed(key) }
        guard info.size > 0 else {
            return KeyValue(type: info.type, bytes: [])
        }
        guard let keyCode = SMCValueCodec.keyCode(for: key) else {
            throw SMCError.invalidKey(key)
        }

        var readInput = SMCParamStruct()
        readInput.key = keyCode
        readInput.keyInfo.dataSize = UInt32(info.size)
        readInput.data8 = Command.readKey
        let output = try call(&readInput, key: key)

        // The read call can still report a zero size even when GetKeyInfo
        // advertised one (the neutered-read behavior) — honor the smaller of
        // the two so we never read past what the firmware returned.
        let reportedSize = min(Int(output.keyInfo.dataSize), info.size)
        var valueBytes: [UInt8] = []
        valueBytes.reserveCapacity(reportedSize)
        withUnsafeBytes(of: output.bytes) { raw in
            valueBytes.append(contentsOf: raw.prefix(reportedSize))
        }
        return KeyValue(type: info.type, bytes: valueBytes)
    }

    /// Reads a key and decodes it to a numeric value. Empty successful reads
    /// throw `noData`; unrecognized data types throw `unsupportedDataType`.
    func readNumeric(_ key: String, preferBigEndianFloat: Bool = false) throws -> Double {
        let value = try readKey(key)
        guard !value.bytes.isEmpty else { throw SMCError.noData(key) }
        guard let decoded = SMCValueCodec.decode(type: value.type, bytes: value.bytes, preferBigEndianFloat: preferBigEndianFloat) else {
            throw SMCError.unsupportedDataType(value.type)
        }
        return decoded
    }

    // MARK: Writes (require root — see FanWriteHelper / FanDaemon)

    /// Writes raw bytes to a key, reporting the value's data type.
    func writeKey(_ key: String, type: String, bytes: [UInt8]) throws {
        guard let keyCode = SMCValueCodec.keyCode(for: key) else {
            throw SMCError.invalidKey(key)
        }
        guard let typeCode = SMCValueCodec.keyCode(for: type), bytes.count <= 32 else {
            throw SMCError.invalidKey(key)
        }
        var input = SMCParamStruct()
        input.key = keyCode
        input.keyInfo.dataSize = UInt32(bytes.count)
        input.keyInfo.dataType = typeCode
        input.data8 = Command.writeKey
        withUnsafeMutableBytes(of: &input.bytes) { raw in
            for (index, byte) in bytes.enumerated() { raw[index] = byte }
        }
        _ = try call(&input, key: key)
    }

    /// Marks a fan as forced (manual) or automatic. Prefers the `FS! ` ui16
    /// bitmask; on machines where `FS! ` is absent (key names drift between
    /// generations) falls back to the per-fan `F<fan>md` ui8 mode key.
    func setFanForced(_ fan: Int, forced: Bool) throws {
        if keyExists("FS! ") {
            let maskValue = try readKey("FS! ")
            var mask = maskValue.bytes.isEmpty
                ? 0
                : (SMCValueCodec.decode(type: maskValue.type, bytes: maskValue.bytes).map { Int($0) } ?? 0)
            if forced { mask |= (1 << fan) } else { mask &= ~(1 << fan) }
            try writeKey("FS! ", type: "ui16", bytes: SMCValueCodec.encodeUI16(mask))
        } else {
            try writeKey("F\(fan)md", type: "ui8 ", bytes: [forced ? 1 : 0])
        }
    }

    /// Forces fan mode on and writes the `F<fan>Tg` target RPM key. The wire
    /// encoding follows the key's reported type (`flt ` on Apple Silicon,
    /// `fpe2` on older machines) instead of assuming fpe2.
    func setFanTarget(fan: Int, rpm: Int) throws {
        let key = "F\(fan)Tg"
        let info = try keyInfo(for: key)
        try setFanForced(fan, forced: true)
        let bytes: [UInt8]
        switch info.type {
        case "flt ": bytes = SMCValueCodec.encodeFloat32(Double(rpm))
        case "fpe2": bytes = SMCValueCodec.encodeFPE2(Double(rpm))
        default: throw SMCError.unsupportedDataType(info.type)
        }
        try writeKey(key, type: info.type, bytes: bytes)
    }

    /// Clears the fan's force bit so the SMC resumes automatic control.
    func setFanAuto(fan: Int) throws {
        try setFanForced(fan, forced: false)
    }

    // MARK: Fan enumeration

    /// Best-effort read of every fan the SMC reports, or nil when the SMC
    /// yields no numeric data at all (neutered unprivileged reads) — the
    /// daemon's powermetrics fallback keys off that nil. The fan count comes
    /// from `FNum`; when `FNum` reads empty, fan indices are probed via
    /// GetKeyInfo (which works even when value reads don't).
    func readFansBestEffort(preferBigEndianFloat: Bool = false) -> [FanReading]? {
        let count: Int
        if let fnum = try? readNumeric("FNum", preferBigEndianFloat: preferBigEndianFloat), fnum > 0 {
            count = Int(fnum)
        } else {
            count = (0..<8).prefix { keyExists("F\($0)Ac") }.count
        }
        guard count > 0 else { return nil }

        let forcedMask = (try? readNumeric("FS! ", preferBigEndianFloat: preferBigEndianFloat)).map { Int($0) }
        var readings: [FanReading] = []
        var sawNumericData = false
        for index in 0..<count {
            guard let actual = try? readNumeric("F\(index)Ac", preferBigEndianFloat: preferBigEndianFloat),
                  let minRPM = try? readNumeric("F\(index)Mn", preferBigEndianFloat: preferBigEndianFloat),
                  let maxRPM = try? readNumeric("F\(index)Mx", preferBigEndianFloat: preferBigEndianFloat) else { continue }
            sawNumericData = true
            let forced: Bool
            if let forcedMask {
                forced = (forcedMask & (1 << index)) != 0
            } else {
                forced = ((try? readNumeric("F\(index)md", preferBigEndianFloat: preferBigEndianFloat)) ?? 0) != 0
            }
            readings.append(FanReading(
                id: index,
                name: "Fan \(index)",
                actualRPM: actual,
                minRPM: minRPM,
                maxRPM: maxRPM,
                isForced: forced,
                targetRPM: try? readNumeric("F\(index)Tg", preferBigEndianFloat: preferBigEndianFloat)
            ))
        }
        return sawNumericData ? readings : nil
    }

    // MARK: Kernel call

    private func call(_ input: inout SMCParamStruct, key: String) throws -> SMCParamStruct {
        var output = SMCParamStruct()
        let inputSize = MemoryLayout<SMCParamStruct>.size
        var outputSize = MemoryLayout<SMCParamStruct>.size
        let callResult = IOConnectCallStructMethod(
            connection,
            Command.handleYPCEvent,
            &input,
            inputSize,
            &output,
            &outputSize
        )
        guard callResult == kIOReturnSuccess else { throw SMCError.callFailed(callResult) }
        guard output.result == Result.success else {
            if output.result == Result.keyNotFound { throw SMCError.keyNotFound(key) }
            throw SMCError.readFailed(key)
        }
        return output
    }
}
