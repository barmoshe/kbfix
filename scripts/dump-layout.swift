// dump-layout - derive a layout pair's key table from the machine itself.
//
// macOS only, development only. Nothing at runtime depends on this file; it
// exists so the table in layouts/<pair>/layout.json can be REGENERATED rather
// than hand-edited, on whatever input sources you actually have installed.
//
//   swift scripts/dump-layout.swift "ABC" "Hebrew"
//   swift scripts/dump-layout.swift "ABC" "Hebrew" --json > layouts/en-he/table.json
//
// It asks the two named input sources what every physical key produces, using
// UCKeyTranslate against their real keyboard data, and prints the keys where
// they disagree. That is the whole table. Digits and most symbols agree between
// layouts and so are absent by construction: they carry no directional signal.
//
// The name is the localized one shown in the Input Sources list, so on a
// non-English system pass what you see there. `--list` prints what is installed.

import Carbon
import Foundation

func inputSources() -> [TISInputSource] {
    guard let list = TISCreateInputSourceList(nil, true)?.takeRetainedValue() as? [TISInputSource] else { return [] }
    return list
}

func name(of source: TISInputSource) -> String? {
    guard let ptr = TISGetInputSourceProperty(source, kTISPropertyLocalizedName) else { return nil }
    return (Unmanaged<CFString>.fromOpaque(ptr).takeUnretainedValue() as String)
}

func keyboardData(of source: TISInputSource) -> Data? {
    guard let ptr = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    return (Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data)
}

func findLayout(named wanted: String) -> Data? {
    for source in inputSources() where name(of: source) == wanted {
        if let data = keyboardData(of: source) { return data }
    }
    return nil
}

/// What one physical key emits on one layout. Empty string means it emits nothing.
func emit(_ layout: Data, keycode: UInt16, shift: Bool) -> String {
    var deadKeyState: UInt32 = 0
    var length = 0
    var chars = [UniChar](repeating: 0, count: 8)
    let modifiers: UInt32 = shift ? UInt32(shiftKey >> 8) : 0

    let status = layout.withUnsafeBytes { raw -> OSStatus in
        let header = raw.baseAddress!.assumingMemoryBound(to: UCKeyboardLayout.self)
        return UCKeyTranslate(header,
                              keycode,
                              UInt16(kUCKeyActionDown),
                              modifiers,
                              UInt32(LMGetKbdType()),
                              OptionBits(kUCKeyTranslateNoDeadKeysBit),
                              &deadKeyState,
                              chars.count,
                              &length,
                              &chars)
    }
    guard status == noErr else { return "" }
    return String(utf16CodeUnits: chars, count: length)
}

let args = Array(CommandLine.arguments.dropFirst())

if args.contains("--list") || args.isEmpty {
    print("Installed input sources with keyboard data:")
    for source in inputSources() {
        guard let n = name(of: source), keyboardData(of: source) != nil else { continue }
        print("  \(n)")
    }
    if args.isEmpty {
        print("\nusage: swift dump-layout.swift \"<side a source>\" \"<side b source>\" [--json]")
    }
    exit(0)
}

guard args.count >= 2 else {
    FileHandle.standardError.write("usage: swift dump-layout.swift \"<side a>\" \"<side b>\" [--json]\n".data(using: .utf8)!)
    exit(1)
}

let aName = args[0]
let bName = args[1]
let asJSON = args.contains("--json")

guard let aLayout = findLayout(named: aName) else {
    FileHandle.standardError.write("no input source named \"\(aName)\" (try --list)\n".data(using: .utf8)!)
    exit(1)
}
guard let bLayout = findLayout(named: bName) else {
    FileHandle.standardError.write("no input source named \"\(bName)\" (try --list)\n".data(using: .utf8)!)
    exit(1)
}

var base: [(String, String)] = []
var shifted: [(String, String)] = []
var dropped: [String] = []

for keycode in UInt16(0)...UInt16(127) {
    for shift in [false, true] {
        let a = emit(aLayout, keycode: keycode, shift: shift)
        let b = emit(bLayout, keycode: keycode, shift: shift)
        if a.isEmpty { continue }                       // no key on side a, nothing to map from
        if a.count != 1 { continue }                    // ignore multi-character side-a output
        if let scalar = a.unicodeScalars.first, scalar.value < 0x20 { continue }  // control keys
        if b.isEmpty {
            // The key exists on side a but emits nothing on side b: struck on the
            // side-b layout it is silently swallowed, and its case is lost.
            dropped.append(a)
            continue
        }
        if a == b { continue }                          // identical, carries no direction
        if shift { shifted.append((a, b)) } else { base.append((a, b)) }
    }
}

func jsonPairs(_ pairs: [(String, String)]) -> String {
    pairs.map { pair in
        let a = String(data: try! JSONEncoder().encode(pair.0), encoding: .utf8)!
        let b = String(data: try! JSONEncoder().encode(pair.1), encoding: .utf8)!
        return "    [\(a), \(b)]"
    }.joined(separator: ",\n")
}

if asJSON {
    let droppedString = String(data: try! JSONEncoder().encode(dropped.joined()), encoding: .utf8)!
    print("{")
    print("  \"_\": \"Generated by scripts/dump-layout.swift from \\\"\(aName)\\\" and \\\"\(bName)\\\". Paste base/shift/droppedOnB into layouts/<pair>/layout.json.\",")
    print("  \"base\": [\n\(jsonPairs(base))\n  ],")
    print("  \"shift\": [\n\(jsonPairs(shifted))\n  ],")
    print("  \"droppedOnB\": \(droppedString)")
    print("}")
} else {
    print("base (\(base.count) keys)")
    for (a, b) in base { print("  \(a) -> \(b)") }
    print("shift (\(shifted.count) keys)")
    for (a, b) in shifted { print("  \(a) -> \(b)") }
    print("dropped on \"\(bName)\" (\(dropped.count) keys): \(dropped.joined())")
}
