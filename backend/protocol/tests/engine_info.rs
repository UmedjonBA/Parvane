//! spec 035 T014 (FR-045, FR-046, contracts/versioning.md): `engine_info()` движка — пять осей версий.
//! Поля и их смысл — по контракту; `schemaHash`/`sourceHash` пересчитываются здесь независимо от
//! `build.rs` (SHA-256 отсортированного списка `путь\0sha256-hex\n`, пути — от корня репозитория).
//! Те же поля во всех обвязках: WASM `engineInfo` (wasm-bindgen-test в `protocol/wasm`), C ABI
//! `pv_engine_info` (тест `protocol/ffi` и ctest ядра), шард `messenger --engine-info`
//! (`backend/tests/integration/tests/engine_info_live.rs`).

use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn walk(dir: &Path, ext: Option<&str>, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, ext, out);
        } else if ext.is_none_or(|x| p.extension().is_some_and(|y| y == x)) {
            out.push(p);
        }
    }
}

fn tree_hash(files: Vec<PathBuf>) -> String {
    let root = repo();
    let mut rows: Vec<(String, String)> = files
        .into_iter()
        .map(|p| {
            let rel = p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            (rel, hex::encode(Sha256::digest(std::fs::read(&p).unwrap())))
        })
        .collect();
    rows.sort();
    let mut h = Sha256::new();
    for (p, d) in rows {
        h.update(p.as_bytes());
        h.update([0u8]);
        h.update(d.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

fn info() -> Value {
    serde_json::from_str(&parvane_protocol::engine_info_json()).unwrap()
}

#[test]
fn engine_info_fields() {
    let i = info();
    let api = i["engineApi"].as_str().unwrap();
    let parts: Vec<u32> = api.split('.').map(|x| x.parse().unwrap()).collect();
    assert_eq!(parts.len(), 3, "engineApi — MAJOR.MINOR.PATCH");
    assert_eq!(api, parvane_protocol::ENGINE_API);
    assert_eq!(i["protoMajor"], 2);
    assert_eq!(i["protoMinor"], parvane_protocol::limits::PROTO_MINOR_035);
    assert_eq!(i["protoMinor"], parvane_protocol::PROTO_MINOR);
    assert_eq!(i["minSupportedMinor"], parvane_protocol::limits::PROTO_MINOR_035);
    assert!(i["features"].as_array().unwrap().iter().all(|f| {
        let s = f.as_str().unwrap();
        (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
    }));
    let formats = i["storageFormats"].as_object().unwrap();
    for (kind, fmt) in parvane_protocol::model::store_kinds::KINDS {
        assert_eq!(formats.get(*kind).and_then(Value::as_u64), Some(u64::from(*fmt)), "storageFormats.{kind}");
    }
    assert_eq!(formats.len(), parvane_protocol::model::store_kinds::KINDS.len());
    // host-file — файлы хоста desktop/android в хранилище движка (spec 036 T031)
    for k in ["engine-core", "state-object", "history-row", "range-hold", "migration-progress", "host-file"] {
        assert!(formats.contains_key(k), "storageFormats без {k}");
    }
    assert_eq!(i["criticalRanges"]["default"], serde_json::json!([1000, 1999]));
    for h in ["sourceHash", "schemaHash"] {
        let s = i[h].as_str().unwrap();
        assert!(s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()), "{h}: {s}");
    }
    assert!(!i["buildId"].as_str().unwrap().is_empty());
    assert!(!i["target"].as_str().unwrap().is_empty());
}

/// Хеши — по contracts/versioning.md, пересчитаны независимо от build.rs.
#[test]
fn engine_info_hashes_match_tree() {
    let i = info();
    let root = repo();
    let mut protos = Vec::new();
    walk(&root.join("proto/parvane"), Some("proto"), &mut protos);
    assert_eq!(i["schemaHash"].as_str().unwrap(), tree_hash(protos), "schemaHash");
    let mut src = Vec::new();
    let p = root.join("backend/protocol");
    for d in ["src", "wasm/src", "ffi/src"] {
        walk(&p.join(d), None, &mut src);
    }
    src.push(p.join("build.rs"));
    src.push(p.join("Cargo.toml"));
    assert_eq!(i["sourceHash"].as_str().unwrap(), tree_hash(src), "sourceHash");
}
