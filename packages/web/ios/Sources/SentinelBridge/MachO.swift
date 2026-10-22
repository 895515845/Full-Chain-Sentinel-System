/**
 * Just enough Mach-O parsing to answer the two questions the app tools ask:
 * which architecture is this binary, and is it still FairPlay-encrypted?
 *
 * `cryptid` is what decides whether a pulled IPA is useful for static analysis
 * or needs the M4 decryption step, so the daemon reports it instead of guessing
 * from the bundle.
 *
 * iOS arm binaries are little-endian, so thin64 starts with `cf fa ed fe`, not
 * the big-endian magic constant. Both orders are accepted; load commands are
 * read with the slice's own order.
 */

import Foundation

struct MachOInfo {
	var arch: String
	var cryptid: Int
	var is64: Bool
	var pie: Bool
}

enum MachO {
	static func read(path: String) -> MachOInfo? {
		guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
		defer { try? handle.close() }
		guard let header = try? handle.read(upToCount: 32), header.count >= 28 else { return nil }
		let big = beU32(header, 0)
		let little = leU32(header, 0)
		if big == 0xCAFE_BABE || big == 0xCAFE_BABF {
			return readFat(handle: handle, header: header, fat64: big == 0xCAFE_BABF)
		}
		if big == 0xFEED_FACF { return readThin(handle: handle, is64: true, littleEndian: false, offset: 0) }
		if big == 0xFEED_FACE { return readThin(handle: handle, is64: false, littleEndian: false, offset: 0) }
		if little == 0xFEED_FACF { return readThin(handle: handle, is64: true, littleEndian: true, offset: 0) }
		if little == 0xFEED_FACE { return readThin(handle: handle, is64: false, littleEndian: true, offset: 0) }
		return nil
	}

	private static func readFat(handle: FileHandle, header: Data, fat64: Bool) -> MachOInfo? {
		// arch 0: cputype, cpusubtype, offset (fat) or offset + size (fat64).
		let entrySize = fat64 ? 32 : 20
		guard header.count >= 8 + entrySize else { return nil }
		let offset = fat64 ? beU64(header, 8 + 8) : UInt64(beU32(header, 8 + 8))
		guard offset > 0, offset < UInt64(Int32.max) else { return nil }
		try? handle.seek(toOffset: offset)
		guard let slice = try? handle.read(upToCount: 32), slice.count >= 28 else { return nil }
		let big = beU32(slice, 0)
		let little = leU32(slice, 0)
		if big == 0xFEED_FACF { return readThin(handle: handle, is64: true, littleEndian: false, offset: offset) }
		if big == 0xFEED_FACE { return readThin(handle: handle, is64: false, littleEndian: false, offset: offset) }
		if little == 0xFEED_FACF { return readThin(handle: handle, is64: true, littleEndian: true, offset: offset) }
		if little == 0xFEED_FACE { return readThin(handle: handle, is64: false, littleEndian: true, offset: offset) }
		return nil
	}

	private static func readThin(
		handle: FileHandle,
		is64: Bool,
		littleEndian: Bool,
		offset: UInt64
	) -> MachOInfo? {
		try? handle.seek(toOffset: offset)
		let headerSize = is64 ? 32 : 28
		guard let header = try? handle.read(upToCount: headerSize), header.count >= headerSize else { return nil }
		let cpu = u32(header, 4, littleEndian)
		let flags = u32(header, 24, littleEndian)
		let commandCount = Int(u32(header, 16, littleEndian))
		let commandBytes = Int(u32(header, 20, littleEndian))
		guard commandCount >= 0, commandCount < 4096, commandBytes >= 0, commandBytes < 1_048_576 else { return nil }
		let commands: Data
		if commandBytes == 0 {
			commands = Data()
		} else {
			guard let data = try? handle.read(upToCount: commandBytes), data.count >= commandBytes else { return nil }
			commands = data
		}

		var cryptid = 0
		var cursor = 0
		for _ in 0 ..< commandCount {
			guard cursor + 8 <= commands.count else { break }
			let command = u32(commands, cursor, littleEndian)
			let size = Int(u32(commands, cursor + 4, littleEndian))
			if command == 0x21 || command == 0x2C, cursor + 20 <= commands.count {
				cryptid = Int(u32(commands, cursor + 16, littleEndian))
			}
			if size < 8 { break }
			cursor += size
		}
		return MachOInfo(arch: archName(cpu), cryptid: cryptid, is64: is64, pie: (flags & 0x20_0000) != 0)
	}

	private static func archName(_ cpu: UInt32) -> String {
		switch cpu {
		case 0x0100_000C: return "arm64"
		case 0x0000_000C: return "armv7"
		case 0x0100_0007: return "x86_64"
		case 0x0000_0007: return "i386"
		default: return String(format: "cpu-%08x", cpu)
		}
	}

	private static func u32(_ data: Data, _ offset: Int, _ littleEndian: Bool) -> UInt32 {
		littleEndian ? leU32(data, offset) : beU32(data, offset)
	}

	private static func beU32(_ data: Data, _ offset: Int) -> UInt32 {
		guard offset + 4 <= data.count else { return 0 }
		let base = data.startIndex + offset
		return UInt32(data[base]) << 24 | UInt32(data[base + 1]) << 16 | UInt32(data[base + 2]) << 8 | UInt32(data[base + 3])
	}

	private static func beU64(_ data: Data, _ offset: Int) -> UInt64 {
		guard offset + 8 <= data.count else { return 0 }
		return UInt64(beU32(data, offset)) << 32 | UInt64(beU32(data, offset + 4))
	}

	private static func leU32(_ data: Data, _ offset: Int) -> UInt32 {
		guard offset + 4 <= data.count else { return 0 }
		let base = data.startIndex + offset
		return UInt32(data[base]) | UInt32(data[base + 1]) << 8 | UInt32(data[base + 2]) << 16 | UInt32(data[base + 3]) << 24
	}
}
