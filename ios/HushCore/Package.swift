// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "HushCore",
    // macOS only so `swift test` can run on the Mac; the app itself is iOS.
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [.library(name: "HushCore", targets: ["HushCore"])],
    dependencies: [.package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1")],
    targets: [
        .target(
            name: "HushCore",
            dependencies: [.product(name: "GRDB", package: "GRDB.swift")],
            // A symlink to src/main/db/migrations: both apps run the same migrations (D-072).
            resources: [.copy("migrations")]
        ),
        .testTarget(name: "HushCoreTests", dependencies: ["HushCore"]),
    ]
)
