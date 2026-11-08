//! Типы границы движка для клиентов (spec 035 T022, contracts/codegen.md): TS
//! (`web/telegram-tt/src/api/parvane/v2/gen/model.ts`), C++ (`desktop/parvane-core/include/parvane/gen/model.h`
//! + `src/gen/model.cpp`), Kotlin (`android/libtd/src/main/java/org/parvane/gen/Model.kt`) из
//! `proto/parvane/engine/v1/**` и сообщений, которые модель встраивает. Тексты порождает build.rs движка.
//!
//! `cd backend && cargo run -p parvane-protocol --bin gen_bindings` — записать;
//! `--check` — только сверить с закоммиченным (код выхода 1 при расхождении; то же — тест `bindings_are_fresh`).

use std::process::ExitCode;

fn main() -> ExitCode {
    let check = std::env::args().any(|a| a == "--check");
    let root = parvane_protocol::bindings::repo_root();
    let stale = parvane_protocol::bindings::stale(&root);
    if stale.is_empty() {
        println!("gen_bindings: актуально ({} файла)", parvane_protocol::bindings::FILES.len());
        return ExitCode::SUCCESS;
    }
    if check {
        for p in &stale {
            eprintln!("{p}: устарел — запустите cargo run -p parvane-protocol --bin gen_bindings");
        }
        return ExitCode::FAILURE;
    }
    if let Err(e) = parvane_protocol::bindings::write_all(&root) {
        eprintln!("gen_bindings: {e}");
        return ExitCode::FAILURE;
    }
    for p in &stale {
        println!("{p}: обновлено");
    }
    ExitCode::SUCCESS
}
