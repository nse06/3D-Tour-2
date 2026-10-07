// swift-tools-version:5.9
// ScanCore turns an iPhone room scan (docs/iphone-capture.md §1) into a glTF
// walkthrough model plus the scan manifest the Atrium web viewer reads.
// Foundation only, so it builds and tests on Linux as well as Apple platforms.

import PackageDescription

let package = Package(
    name: "ScanCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "AtriumScanCore", targets: ["AtriumScanCore"]),
        .executable(name: "scanproc", targets: ["scanproc"]),
    ],
    targets: [
        .target(name: "AtriumScanCore"),
        .executableTarget(name: "scanproc", dependencies: ["AtriumScanCore"]),
        .testTarget(name: "AtriumScanCoreTests", dependencies: ["AtriumScanCore"]),
    ]
)
