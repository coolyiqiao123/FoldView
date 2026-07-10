// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FoldviewMenuBar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "FoldviewMenuBar", targets: ["FoldviewMenuBar"])
    ],
    targets: [
        .executableTarget(
            name: "FoldviewMenuBar",
            path: "Sources/FoldviewMenuBar"
        ),
        .testTarget(
            name: "FoldviewMenuBarTests",
            dependencies: ["FoldviewMenuBar"],
            path: "Tests/FoldviewMenuBarTests",
            // On a bare Xcode Command Line Tools install (no full Xcode), the
            // `Testing` module ships as a framework outside SwiftPM's default
            // search paths, and the built test bundle can't resolve its
            // runtime dylib without an explicit rpath. These flags point at
            // where Command Line Tools happens to keep them. On a machine with
            // full Xcode installed, `Testing` resolves through the normal
            // toolchain paths and these extra search paths are simply unused
            // (a missing -F/-rpath target is not an error). See mac/README.md.
            swiftSettings: [
                .unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/usr/lib"
                ])
            ]
        )
    ]
)
