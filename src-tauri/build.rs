use std::path::Path;

#[path = "build_key.rs"]
mod build_key;

/// Committed development public key. Its private half is public, so a release
/// build must never embed it; `build_key` refuses to without an explicit opt-in.
const COMMITTED_DEV_KEY_PATH: &str = "licenses/vexil_public.key";

/// Production public key staged by CI. `tauri ios build` shells out to
/// xcodebuild, whose Run Build Tool phase runs with a sanitized environment, so
/// step-level env vars never reach this script. CI writes the key to this file
/// instead, which `build_key` treats as an explicit production-key opt-in.
const STAGED_PRODUCTION_KEY_PATH: &str = "licenses/vexil_public.prod.key";

/// Native iOS plugin sources (see `ios/Package.swift`) are discovered by this
/// build script: `tauri ios init` / `tauri ios build` read the emitted
/// metadata and link the Swift package into the generated Xcode project.
const PLUGIN_COMMANDS: &[&str] = &[];

fn main() {
    tauri_build::build();

    tauri_plugin::Builder::new(PLUGIN_COMMANDS)
        .ios_path("ios")
        .build();

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let mobile = target_os == "ios" || target_os == "android";
    alias("desktop", !mobile);
    alias("mobile", mobile);

    println!("cargo:rerun-if-changed={COMMITTED_DEV_KEY_PATH}");
    println!("cargo:rerun-if-changed={STAGED_PRODUCTION_KEY_PATH}");
    println!("cargo:rerun-if-env-changed=VEXIL_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=VEXIL_ALLOW_DEV_KEY");

    let dest = Path::new(&std::env::var("OUT_DIR").unwrap()).join("vexil_public.key");

    let chosen = build_key::select(
        std::env::var("VEXIL_PUBLIC_KEY").ok().as_deref(),
        read_key_file(STAGED_PRODUCTION_KEY_PATH).as_deref(),
        read_key_file(COMMITTED_DEV_KEY_PATH).as_deref(),
        is_release(),
        dev_key_allowed(),
    )
    .unwrap_or_else(|e| panic!("{e}"));

    build_key::validate_32_bytes(chosen.source, &chosen.base64).unwrap_or_else(|e| panic!("{e}"));

    std::fs::write(&dest, chosen.base64).expect("failed to write embedded public key");
    println!(
        "cargo:warning=vexil: {}",
        build_key::source_note(chosen.source)
    );
}

/// Reads a key file, treating a missing or whitespace-only file as absent so
/// selection falls through to the next source.
fn read_key_file(path: &str) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// True when this build script runs for a release profile rather than dev/debug.
fn is_release() -> bool {
    match std::env::var("PROFILE").ok().as_deref() {
        Some("release") | Some("appstore") => true,
        // Treat anything we do not recognise as release. Defaulting open avoids
        // adding a new profile name that quietly ships a dev key.
        Some(other) if other.ends_with("release") => true,
        Some("debug") | Some("dev") | Some("test") => false,
        _ => true,
    }
}

fn dev_key_allowed() -> bool {
    std::env::var("VEXIL_ALLOW_DEV_KEY")
        .map(|v| matches!(v.trim(), "1" | "true" | "TRUE" | "yes"))
        .unwrap_or(false)
}

// creates a cfg alias if `has_feature` is true.
// `alias` must be a snake case string.
fn alias(alias: &str, has_feature: bool) {
    println!("cargo:rustc-check-cfg=cfg({alias})");
    if has_feature {
        println!("cargo:rustc-cfg={alias}");
    }
}
