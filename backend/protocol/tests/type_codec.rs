//! spec 035 T012 (FR-050, contracts/codegen.md): кодек proto3-JSON ⇄ байты по имени типа есть у КАЖДОГО
//! сообщения схемы `proto/parvane/**` — кругооборот пустого и «максимально заполненного» сообщения
//! (`schema::sample_bytes`: каждое поле задано, repeated — двумя элементами, вложенные — до глубины 3,
//! enum — известным ненулевым значением) через `host::encode_message`/`decode_message`. Те же проверки в
//! обвязках: WASM (wasm-bindgen-test `protocol/wasm/tests/type_codec.rs`), C ABI (тест `protocol/ffi` и
//! ctest ядра `type_codec_tests.cpp`).

use parvane_protocol::{host, schema};

#[test]
fn every_schema_message_has_a_codec() {
    assert!(schema::MESSAGES.len() >= 300, "схема подозрительно мала: {}", schema::MESSAGES.len());
    let mut missing = Vec::new();
    for m in schema::MESSAGES {
        let enc = host::encode_message(m.name, "{}");
        let dec = host::decode_message(m.name, &[]);
        match (&enc, &dec) {
            (Ok(b), Ok(j)) => {
                assert!(b.is_empty(), "{}: пустое сообщение не пусто", m.name);
                assert_eq!(j, "{}", "{}: пустое сообщение → {j}", m.name);
            }
            _ => {
                missing.push(m.name);
                continue;
            }
        }
        let full = schema::sample_bytes(m.name).unwrap_or_else(|| panic!("{}: нет образца", m.name));
        let json = host::decode_message(m.name, &full).unwrap_or_else(|e| panic!("{}: образец не разбирается: {e}", m.name));
        let again = host::encode_message(m.name, &json).unwrap_or_else(|e| panic!("{}: JSON образца не кодируется: {e}\n{json}", m.name));
        assert_eq!(host::decode_message(m.name, &again).unwrap(), json, "{}: кругооборот меняет сообщение", m.name);
        if !full.is_empty() {
            assert_ne!(json, "{}", "{}: образец потерялся", m.name);
        }
    }
    assert!(missing.is_empty(), "нет кодека по имени типа у {} сообщений: {missing:?}", missing.len());
    assert!(host::encode_message("parvane.nope.v1.Nope", "{}").is_err());
    assert!(host::decode_message("parvane.nope.v1.Nope", &[]).is_err());
    assert!(host::encode_message("parvane.msg.v2.Text", "не json").is_err());
}

/// Сгенерированный кодек — тот же, что `type_codec` напрямую (обвязки — тонкие вызовы).
#[test]
fn host_calls_are_thin_wrappers_over_type_codec() {
    use parvane_protocol::limits::Origin;
    use parvane_protocol::type_codec;
    for name in ["parvane.planner.v1.Task", "parvane.msg.v2.Content", "parvane.engine.v1.Stored", "parvane.state.v1.StateOp"] {
        let full = schema::sample_bytes(name).unwrap();
        let a = host::decode_message(name, &full).unwrap();
        let b = type_codec::decode_by_type(name, &full, Origin::Server).unwrap().unwrap();
        assert_eq!(a, b, "{name}");
        assert_eq!(host::encode_message(name, &a).unwrap(), type_codec::encode_by_type(name, &a).unwrap().unwrap(), "{name}");
    }
    assert!(type_codec::encode_by_type("parvane.nope.v1.Nope", "{}").is_none());
}

/// spec 035 T059: кругооборот временного сообщения `parvane.engine.v1.CodegenProbe`, которое добавляет
/// `scripts/check_codegen_roundtrip.sh` (без него — пропуск): кодек по имени типа порождён build.rs сам.
#[test]
fn codegen_probe_roundtrip() {
    let Ok(json) = std::env::var("PARVANE_CODEGEN_PROBE") else { return };
    let ty = "parvane.engine.v1.CodegenProbe";
    let bytes = parvane_protocol::type_codec::encode_by_type(ty, &json).expect("тип порождён").expect("кодирование");
    let back = parvane_protocol::type_codec::decode_by_type(ty, &bytes, parvane_protocol::limits::Origin::Server).expect("тип").expect("разбор");
    let a: serde_json::Value = serde_json::from_str(&json).unwrap();
    let b: serde_json::Value = serde_json::from_str(&back).unwrap();
    assert_eq!(a, b);
}
