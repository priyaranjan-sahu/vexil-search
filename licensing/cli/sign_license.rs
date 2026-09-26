use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::path::Path;

const USAGE: &str = "\
vexil license tool

USAGE:
  sign_license gen-key <dir>
  sign_license sign --key <private_key_file> --payload <payload.json> --out <license.lic> [--device <device_id>]
  sign_license verify --public <public_key_file> --lic <license.lic>
";

const CURRENT_PAYLOAD_VERSION: u32 = 2;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LicensePayload {
    #[serde(default = "default_version")]
    version: u32,
    user_id: String,
    plan: String,
    features: Vec<String>,
    issued_at: u64,
    expires_at: Option<u64>,
    #[serde(default)]
    device_id: Option<String>,
}

fn default_version() -> u32 {
    CURRENT_PAYLOAD_VERSION
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_signing_key(path: &Path) -> Result<SigningKey, String> {
    let b64 = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read key file: {e}"))?
        .trim()
        .to_string();
    let bytes = B64
        .decode(b64)
        .map_err(|e| format!("Key is not valid base64: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Private key must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&arr))
}

fn read_verifying_key(path: &Path) -> Result<VerifyingKey, String> {
    let b64 = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read public key: {e}"))?
        .trim()
        .to_string();
    let bytes = B64
        .decode(b64)
        .map_err(|e| format!("Public key is not valid base64: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Public key must be 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("Invalid public key: {e}"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    let result = match cmd {
        "gen-key" => {
            let dir = args.get(2).map(String::as_str).unwrap_or("licenses");
            gen_key(dir)
        }
        "sign" => sign(&args[2..]),
        "verify" => verify(&args[2..]),
        _ => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn gen_key(dir: &str) -> Result<(), String> {
    let dir_path = Path::new(dir);
    std::fs::create_dir_all(dir_path).map_err(|e| format!("Failed to create directory: {e}"))?;
    let public_path = dir_path.join("vexil_public.key");
    let private_path = dir_path.join("vexil_private.key");
    if public_path.exists() || private_path.exists() {
        return Err("Keys already exist; refusing to overwrite".to_string());
    }
    let signing_key = SigningKey::generate(&mut OsRng);
    std::fs::write(&private_path, B64.encode(signing_key.to_bytes()))
        .map_err(|e| format!("Failed to write private key: {e}"))?;
    std::fs::write(
        &public_path,
        B64.encode(signing_key.verifying_key().to_bytes()),
    )
    .map_err(|e| format!("Failed to write public key: {e}"))?;
    println!("Wrote {}", private_path.display());
    println!("Wrote {}", public_path.display());
    println!("Keep the private key secret and never commit it.");
    Ok(())
}

fn flag_value(args: &[String], name: &str) -> Result<String, String> {
    let idx = args
        .iter()
        .position(|a| a == name)
        .ok_or_else(|| format!("missing {name}"))?;
    args.get(idx + 1)
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}

fn sign(args: &[String]) -> Result<(), String> {
    let key_path = flag_value(args, "--key")?;
    let payload_path = flag_value(args, "--payload")?;
    let out_path = flag_value(args, "--out")?;
    let signing_key = read_signing_key(Path::new(&key_path))?;
    let raw = std::fs::read_to_string(&payload_path)
        .map_err(|e| format!("Failed to read payload: {e}"))?;
    let mut payload: LicensePayload = serde_json::from_str(&raw)
        .map_err(|e| format!("Payload is not valid license JSON: {e}"))?;
    if let Some(idx) = args.iter().position(|a| a == "--device") {
        let device = args
            .get(idx + 1)
            .ok_or_else(|| "missing value for --device".to_string())?;
        payload.device_id = Some(device.trim().to_string());
    }
    let body =
        serde_json::to_vec(&payload).map_err(|e| format!("Failed to serialize payload: {e}"))?;
    let signature = signing_key.sign(&body);
    let token = format!("{}.{}", B64.encode(&body), B64.encode(signature.to_bytes()));
    std::fs::write(&out_path, token).map_err(|e| format!("Failed to write license: {e}"))?;
    println!("Wrote {}", out_path);
    Ok(())
}

fn verify(args: &[String]) -> Result<(), String> {
    let public_path = flag_value(args, "--public")?;
    let lic_path = flag_value(args, "--lic")?;
    let key = read_verifying_key(Path::new(&public_path))?;
    let raw =
        std::fs::read_to_string(&lic_path).map_err(|e| format!("Failed to read license: {e}"))?;
    let (payload_b64, sig_b64) = raw
        .trim()
        .split_once('.')
        .ok_or_else(|| "Malformed license file".to_string())?;
    let body = B64
        .decode(payload_b64)
        .map_err(|e| format!("Invalid license payload encoding: {e}"))?;
    let sig = B64
        .decode(sig_b64)
        .map_err(|e| format!("Invalid signature encoding: {e}"))?;
    let signature =
        Signature::from_slice(&sig).map_err(|e| format!("Invalid signature data: {e}"))?;
    key.verify(&body, &signature)
        .map_err(|_| "License signature verification failed".to_string())?;
    let payload: LicensePayload =
        serde_json::from_slice(&body).map_err(|e| format!("Invalid license payload JSON: {e}"))?;
    if payload
        .expires_at
        .map(|exp| now_secs() > exp)
        .unwrap_or(false)
    {
        return Err("License has expired".to_string());
    }
    println!(
        "OK: valid license for '{}' (plan: {})",
        payload.user_id, payload.plan
    );
    Ok(())
}
