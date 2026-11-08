//! spec 035 (FR-075, R13, PACK-1): `Sticker.sticker_id` — id элемента манифеста архива набора
//! (`proto/parvane/vectors/content/sticker_id.json`, ожидания руками).

use parvane_protocol::msg;
use serde_json::Value;

const VECTORS: &str = include_str!("../../../proto/parvane/vectors/content/sticker_id.json");

#[test]
fn sticker_id_is_pack_manifest_entry() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let mut bad = vec![];
    for c in v["cases"].as_array().unwrap() {
        let id = c["input"]["sticker_id"].as_str().unwrap();
        let ok = msg::is_pack_sticker_id(id);
        let want = c["expect"]["ok"].as_bool() == Some(true);
        if ok != want {
            bad.push(format!("{}: {id:?} → {ok}, ждали {want}", c["name"]));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
