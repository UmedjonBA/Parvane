//! Перегенерировать v2-блоки ACL в `infra/nats/server.conf` и
//! `server.prod.conf` из реестра методов (T031):
//! `cd backend && cargo run -p parvane-protocol --bin gen_registry`.
//! С флагом `--check` только сверяет (код выхода 1 при расхождении).

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let check = std::env::args().any(|a| a == "--check");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../infra/nats");
    let mut ok = true;
    for name in ["server.conf", "server.prod.conf"] {
        let path = root.join(name);
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("{}: {e}", path.display());
                return ExitCode::FAILURE;
            }
        };
        let generated = match parvane_protocol::registry_gen::apply_conf(&text) {
            Ok(g) => g,
            Err(e) => {
                eprintln!("{name}: {e}");
                return ExitCode::FAILURE;
            }
        };
        if generated != text {
            if check {
                eprintln!("{name}: v2-блоки ACL устарели — запустите gen_registry");
                ok = false;
            } else if let Err(e) = std::fs::write(&path, generated) {
                eprintln!("{}: {e}", path.display());
                return ExitCode::FAILURE;
            } else {
                println!("{name}: обновлено");
            }
        } else {
            println!("{name}: актуально");
        }
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
