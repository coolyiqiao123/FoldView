import Foundation
import Testing
@testable import FoldviewMenuBar

/// Pure-function tests for the SMC wire codec and the kernel struct layout.
/// No hardware calls: every case works from recorded byte fixtures.
struct SMCTests {
    // MARK: Key encoding

    @Test func encodesFourCharacterKeys() {
        // "F0Ac" = 0x46 0x30 0x41 0x63
        #expect(SMCValueCodec.keyCode(for: "F0Ac") == 0x4630_4163)
        // "FS! " = 0x46 0x53 0x21 0x20 (note the trailing space)
        #expect(SMCValueCodec.keyCode(for: "FS! ") == 0x4653_2120)
        // "fpe2"
        #expect(SMCValueCodec.keyCode(for: "fpe2") == 0x6670_6532)
    }

    @Test func rejectsMalformedKeys() {
        #expect(SMCValueCodec.keyCode(for: "F0A") == nil)
        #expect(SMCValueCodec.keyCode(for: "F0Acc") == nil)
        #expect(SMCValueCodec.keyCode(for: "") == nil)
    }

    @Test func keyStringRoundTrips() {
        for key in ["F0Ac", "FNum", "FS! ", "fpe2", "flt ", "ui16", "ui8 "] {
            let code = SMCValueCodec.keyCode(for: key)
            #expect(code != nil)
            if let code {
                #expect(SMCValueCodec.keyString(for: code) == key)
            }
        }
    }

    // MARK: fpe2 decode/encode

    @Test(arguments: [
        // (recorded big-endian bytes, expected RPM)
        ([0x17, 0x70] as [UInt8], 1500.0),  // 0x1770 = 6000 raw → 1500 rpm
        ([0x00, 0x01] as [UInt8], 0.25),
        ([0xFF, 0xFC] as [UInt8], 16383.0),
        ([0x00, 0x00] as [UInt8], 0.0)
    ])
    func decodesFPE2(bytes: [UInt8], expected: Double) {
        #expect(SMCValueCodec.fpe2(bytes) == expected)
    }

    @Test func fpe2EncodeRoundTrips() {
        for rpm in [0.0, 0.25, 1200.0, 3499.5, 6500.0] {
            let encoded = SMCValueCodec.encodeFPE2(rpm)
            #expect(encoded.count == 2)
            #expect(SMCValueCodec.fpe2(encoded) == rpm)
        }
    }

    @Test func fpe2EncodeClamps() {
        #expect(SMCValueCodec.fpe2(SMCValueCodec.encodeFPE2(-5)) == 0)
        #expect(SMCValueCodec.encodeFPE2(100000) == [0xFF, 0xFF])
    }

    // MARK: flt decode/encode

    @Test func decodesFloat32LittleEndian() {
        // 2160.0f little-endian = 00 00 07 45
        #expect(SMCValueCodec.float32([0x00, 0x00, 0x07, 0x45]) == 2160.0)
        // 0.0f
        #expect(SMCValueCodec.float32([0x00, 0x00, 0x00, 0x00]) == 0.0)
    }

    @Test func decodesFloat32BigEndian() {
        // 2160.0f big-endian = 45 07 00 00 (the same bytes that decode to
        // ~1.5e-41 as little-endian — the nonsense the daemon sanity-checks).
        #expect(SMCValueCodec.float32BigEndian([0x45, 0x07, 0x00, 0x00]) == 2160.0)
        #expect(SMCValueCodec.float32BigEndian([0x00, 0x00, 0x00, 0x00]) == 0.0)
        // And the little-endian reading of those bytes really is nonsense,
        // which is what triggers the daemon's endianness retry.
        #expect(SMCValueCodec.float32([0x45, 0x07, 0x00, 0x00]) < 1.0)
    }

    @Test func decodeHonorsFloatEndiannessPreference() {
        let bigEndianBytes: [UInt8] = [0x45, 0x07, 0x00, 0x00]
        #expect(SMCValueCodec.decode(type: "flt ", bytes: bigEndianBytes) == SMCValueCodec.float32(bigEndianBytes))
        #expect(SMCValueCodec.decode(type: "flt ", bytes: bigEndianBytes, preferBigEndianFloat: true) == 2160.0)
    }

    @Test func float32EncodeRoundTrips() {
        for rpm in [0.0, 1200.0, 3499.5] {
            let encoded = SMCValueCodec.encodeFloat32(rpm)
            #expect(encoded.count == 4)
            #expect(abs(SMCValueCodec.float32(encoded) - rpm) < 0.01)
        }
    }

    // MARK: ui8/ui16 decode

    @Test func decodesUnsignedIntegers() {
        #expect(SMCValueCodec.ui8([0x02]) == 2)
        #expect(SMCValueCodec.ui8([]) == 0)
        #expect(SMCValueCodec.ui16([0x00, 0x03]) == 3)
        #expect(SMCValueCodec.ui16([0x12, 0x34]) == 0x1234)
        #expect(SMCValueCodec.ui16([]) == 0)
        #expect(SMCValueCodec.ui16(SMCValueCodec.encodeUI16(0x0003)) == 3)
    }

    // MARK: Typed decode dispatch

    @Test func decodeDispatchesOnDataType() {
        #expect(SMCValueCodec.decode(type: "fpe2", bytes: [0x17, 0x70]) == 1500.0)
        #expect(SMCValueCodec.decode(type: "flt ", bytes: [0x00, 0x00, 0x07, 0x45]) == 2160.0)
        #expect(SMCValueCodec.decode(type: "ui16", bytes: [0x00, 0x03]) == 3.0)
        #expect(SMCValueCodec.decode(type: "ui8 ", bytes: [0x02]) == 2.0)
        // Unknown types decode to nil rather than throwing — a renamed key on
        // new hardware must degrade to "unavailable", never crash.
        #expect(SMCValueCodec.decode(type: "sp78", bytes: [0x00]) == nil)
    }

    // MARK: Kernel struct layout

    @Test func paramStructIs80Bytes() {
        // The classic SMCParamStruct must match the kernel layout exactly:
        // key(4) vers(6) pLimitData(16) keyInfo(12) result(1) status(1)
        // data8(1) pad(1) data32(4) bytes(32).
        #expect(MemoryLayout<SMCParamStruct>.size == 80)
        #expect(MemoryLayout<SMCParamStruct>.stride == 80)
    }
}
