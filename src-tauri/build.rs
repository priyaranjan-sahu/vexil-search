use std::path::Path;

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

    println!("cargo:rerun-if-changed=licenses/vexil_public.key");
    println!("cargo:rerun-if-env-changed=VEXIL_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=VEXIL_ALLOW_DEV_KEY");

    let dest = Path::new(&std::env::var("OUT_DIR").unwrap()).join("vexil_public.key");

    if let Ok(b64) = std::env::var("VEXIL_PUBLIC_KEY") {
        let b64 = b64.trim().to_string();
        if !b64.is_empty() {
            assert_key_is_32_bytes(&b64);
            std::fs::write(&dest, b64).expect("failed to write embedded public key");
            println!("cargo:warning=vexil: embedding license public key from VEXIL_PUBLIC_KEY env");
            return;
        }
    }

    let default = Path::new("licenses/vexil_public.key");
    if default.exists() {
        // The committed key is a development key whose private half is public,
        // so anything signed by it can be forged. Shipping it in a release
        // build would let anyone mint their own Pro license, so release builds
        // have to opt out explicitly rather than inherit it by default.
        if is_release() && !dev_key_allowed() {
            panic!(
                "Refusing to build a release with the development license public key. \
                 Set VEXIL_PUBLIC_KEY to the base64 production key. If this build is \
                 intentionally an unsigned test artifact, re-run with \
                 VEXIL_ALLOW_DEV_KEY=1 so the choice is recorded in the build log."
            );
        }
        std::fs::copy(default, &dest).expect("failed to copy default license public key");
        println!("cargo:warning=vexil: embedding dev license public key (not production)");
        return;
    }

    panic!(
        "No license public key available: set VEXIL_PUBLIC_KEY (base64) or provide \
         licenses/vexil_public.key"
    );
}

/// An Ed25519 public key is exactly 32 bytes, so a base64 string that decodes to
/// any other length would fail at runtime with a confusing error. Catching it
/// here turns a broken secret into a build failure naming the real problem.
fn assert_key_is_32_bytes(b64: &str) {
    use base64::Engine as _;

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap_or_else(|e| panic!("VEXIL_PUBLIC_KEY is not valid base64: {e}"));

    assert_eq!(
        decoded.len(),
        32,
        "VEXIL_PUBLIC_KEY must decode to 32 bytes (an Ed25519 public key), got {}",
        decoded.len()
    );
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
