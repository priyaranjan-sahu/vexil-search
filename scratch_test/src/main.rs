use std::path::PathBuf;

fn main() {
    let raw = PathBuf::from("D:\\");
    let canon = raw.canonicalize().unwrap();
    let canon_str = canon.to_string_lossy().to_string();
    println!("Canon string: {}", canon_str);
    match opener::reveal(&canon_str) {
        Ok(_) => println!("opener::reveal succeeded on {}", canon_str),
        Err(e) => println!("opener::reveal failed: {}", e),
    }
}
