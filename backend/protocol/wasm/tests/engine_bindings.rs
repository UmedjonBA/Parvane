//! spec 035 T012/T014: WASM-обвязка движка (wasm-bindgen-test, node):
//! `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner \
//!  cargo test -p parvane-protocol-wasm --target wasm32-unknown-unknown --test engine_bindings`.
//! - `encodeMessage`/`decodeMessage` — кругооборот пустого и «максимально заполненного» образца КАЖДОГО
//!   сообщения схемы (T012);
//! - `engineInfo` — та же `engineInfo()` движка этой сборки, цель — wasm32 (T014).
#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn every_schema_message_has_a_codec() {
    let names: Vec<String> = serde_json::from_str(&parvane_protocol_wasm::schema_message_names()).unwrap();
    assert_eq!(names.len(), parvane_protocol::schema::MESSAGES.len());
    for n in &names {
        assert!(parvane_protocol_wasm::encode_message(n, "{}").is_ok(), "{n}: пустое не кодируется");
        assert_eq!(parvane_protocol_wasm::decode_message(n, &[]).ok().as_deref(), Some("{}"), "{n}: пустое не разбирается");
        let full = parvane_protocol::schema::sample_bytes(n).unwrap();
        let json = parvane_protocol_wasm::decode_message(n, &full).unwrap_or_else(|_| panic!("{n}: образец не разбирается"));
        let again = parvane_protocol_wasm::encode_message(n, &json).unwrap_or_else(|_| panic!("{n}: JSON образца не кодируется"));
        assert_eq!(parvane_protocol_wasm::decode_message(n, &again).ok().as_deref(), Some(json.as_str()), "{n}: кругооборот");
    }
    assert!(parvane_protocol_wasm::encode_message("parvane.nope.v1.Nope", "{}").is_err());
}

#[wasm_bindgen_test]
fn engine_info_matches_engine() {
    let w: serde_json::Value = serde_json::from_str(&parvane_protocol_wasm::engine_info()).unwrap();
    let e: serde_json::Value = serde_json::from_str(&parvane_protocol::engine_info_json()).unwrap();
    assert_eq!(w, e);
    assert_eq!(w["target"], "wasm32-unknown-unknown");
    assert_eq!(w["protoMinor"], parvane_protocol::limits::PROTO_MINOR_035);
    assert_eq!(w["schemaHash"].as_str().map(str::len), Some(64));
}
