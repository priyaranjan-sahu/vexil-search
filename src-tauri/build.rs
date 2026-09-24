use std::path::Path;

fn main() {
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
