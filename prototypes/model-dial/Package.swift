// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ModelDial",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "ModelDial", targets: ["ModelDial"])
    ],
    targets: [
        .executableTarget(name: "ModelDial"),
        .testTarget(name: "ModelDialTests", dependencies: ["ModelDial"])
    ]
)
