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

    let dest = Path::new(&std::env::var("OUT_DIR").unwrap()).join("vexil_public.key");

    if let Ok(b64) = std::env::var("VEXIL_PUBLIC_KEY") {
        let b64 = b64.trim().to_string();
        if !b64.is_empty() {
            std::fs::write(&dest, b64).expect("failed to write embedded public key");
            println!("cargo:warning=vexil: embedding license public key from VEXIL_PUBLIC_KEY env");
            return;
        }
    }

    let default = Path::new("licenses/vexil_public.key");
    if default.exists() {
        std::fs::copy(default, &dest).expect("failed to copy default license public key");
        println!("cargo:warning=vexil: embedding dev license public key (not production)");
        return;
    }

    panic!(
        "No license public key available: set VEXIL_PUBLIC_KEY (base64) or provide \
         licenses/vexil_public.key"
    );
}

// creates a cfg alias if `has_feature` is true.
// `alias` must be a snake case string.
fn alias(alias: &str, has_feature: bool) {
    println!("cargo:rustc-check-cfg=cfg({alias})");
    if has_feature {
        println!("cargo:rustc-cfg={alias}");
    }
}
