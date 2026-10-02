//! Заголовок C ABI `include/parvane_protocol.h` генерируется cbindgen.
fn main() {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=cbindgen.toml");
    let cfg = cbindgen::Config::from_file(format!("{dir}/cbindgen.toml")).unwrap_or_default();
    match cbindgen::Builder::new().with_crate(&dir).with_config(cfg).generate() {
        Ok(b) => {
            b.write_to_file(format!("{dir}/include/parvane_protocol.h"));
        }
        Err(e) => println!("cargo:warning=cbindgen: {e}"),
    }
}
