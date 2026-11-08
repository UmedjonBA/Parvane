//! spec 035 T022 (FR-052, contracts/codegen.md): сгенерированные типы границы движка (TS/C++/Kotlin)
//! совпадают с закоммиченными — схема `proto/parvane/engine/v1/**` не меняется без
//! `cargo run -p parvane-protocol --bin gen_bindings`. Сгенерированное не правится руками.

#[test]
fn bindings_are_fresh() {
    let root = parvane_protocol::bindings::repo_root();
    let stale = parvane_protocol::bindings::stale(&root);
    assert!(stale.is_empty(), "устарели (запустите gen_bindings): {stale:?}");
    for (p, text) in parvane_protocol::bindings::FILES {
        assert!(text.contains("Сгенерировано gen_bindings"), "{p}: нет шапки");
    }
    // Охват: типы хранилища движка есть во всех трёх языках.
    for (p, text) in parvane_protocol::bindings::FILES {
        for t in ["Stored", "Root", "StoreBatch", "StoreReads", "StoreLoaded", "Wrap"] {
            assert!(text.contains(t), "{p}: нет типа {t}");
        }
    }
}
