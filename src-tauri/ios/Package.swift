// swift-tools-version:5.3

import PackageDescription

// The package name must match the crate name: `swift-rs` links the resulting
// static library under `package.name`.
let package = Package(
  name: "vexil",
  platforms: [
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "vexil",
      type: .static,
      targets: ["vexil"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "vexil",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
