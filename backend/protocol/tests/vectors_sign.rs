//! Векторы каноничных подписей (T020, T114; класс 6, D-10):
//! `proto/parvane/vectors/sign/`. Ключи — из фиксированных seed (тестовые).

mod common;

use common::*;
use ed25519_dalek::{Signer, SigningKey};
use parvane_protocol::pb::parvane::core::v2::{DeviceRef, OpBody, OpHeader, Ref, SignedOp};
use parvane_protocol::sign::{self, op_signing_bytes};
use prost::Message;
use serde_json::{json, Value};

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

/// Фиксированный UUIDv7.
const OP_ID: [u8; 16] = [0x01, 0x92, 0x3f, 0x4e, 0x9a, 0x00, 0x7c, 0x11, 0x8a, 0x22, 0x3b, 0x4c, 0x5d, 0x6e, 0x7f, 0x80];

fn header(domain: &str, op: &str) -> OpHeader {
    OpHeader { domain: domain.into(), op_type: op.into(), op_id: OP_ID.to_vec(), ts_ms: 1_727_500_000_000, ..Default::default() }
}

fn op_json(op: &SignedOp) -> Value {
    json!({"body_hex": hexs(&op.body), "signature_hex": hexs(&op.signature), "signer_hex": hexs(&op.signer_key)})
}

fn case(name: &str, op: &SignedOp, domain: &str, op_type: &str, extra: Value, expect: Value) -> Value {
    let mut input = json!({"op": op_json(op), "expect_domain": domain, "expect_op_type": op_type});
    if let Value::Object(m) = extra {
        for (k, v) in m {
            input[k] = v;
        }
    }
    json!({"name": name, "input": input, "expect": expect})
}

/// Подписать тело «вручную» (для векторов с несогласованным заголовком).
fn raw_sign(k: &SigningKey, domain: &str, op: &str, body: Vec<u8>) -> SignedOp {
    let msg = op_signing_bytes(domain, op, &body).unwrap();
    SignedOp { signature: k.sign(&msg).to_bytes().to_vec(), signer_key: k.verifying_key().to_bytes().to_vec(), body }
}

fn generate() -> Value {
    let alice = key(1);
    let bob = key(2);
    let good = sign::sign_op(&alice, header("msg", "content"), b"payload".to_vec()).unwrap();
    let mut tampered = good.clone();
    let n = tampered.body.len() - 1;
    tampered.body[n] ^= 1;
    let mut short_sig = good.clone();
    short_sig.signature.truncate(63);

    // Заголовок говорит "call", подписано в контексте "msg".
    let lying = raw_sign(&alice, "msg", "content", OpBody { header: Some(header("call", "content")), payload: vec![] }.encode_to_vec());
    // Склейка OpBody ‖ OpHeader (D-10): protobuf слил бы поля.
    let mut glued = OpBody { header: Some(header("msg", "content")), payload: vec![] }.encode_to_vec();
    glued.extend(OpBody { header: Some(header("msg", "edit")), payload: vec![] }.encode_to_vec());
    let glued = raw_sign(&alice, "msg", "content", glued);
    // op_id не v7.
    let mut h = header("msg", "content");
    h.op_id = vec![0; 16];
    let bad_id = sign::sign_op(&alice, h, vec![]).unwrap();

    // SDP звонка адресован bob/d1 и call_id — переадресация carol → отказ.
    let mut sdp = header("call", "signal");
    sdp.target = Some(Ref { domain: "x".into(), id: vec![7; 16] });
    sdp.audience = vec![DeviceRef { address: "bob@x".into(), device_id: "d1".into() }];
    let sdp = sign::sign_op(&alice, sdp, b"v=0".to_vec()).unwrap();

    let cases = vec![
        case("valid", &good, "msg", "content", json!({}), json!({"ok": true, "payload_hex": hexs(b"payload")})),
        case("cross-op-type", &good, "msg", "edit", json!({}), err("BadSignature")),
        case("cross-domain", &good, "call", "content", json!({}), err("BadSignature")),
        case("tampered-body", &tampered, "msg", "content", json!({}), err("BadSignature")),
        case("short-signature", &short_sig, "msg", "content", json!({}), err("BadSignature")),
        case("expected-signer-mismatch", &good, "msg", "content", json!({"expect_signer_hex": hexs(bob.verifying_key().as_bytes())}), err("BadSignature")),
        case("header-disagrees-with-context", &lying, "msg", "content", json!({}), err("ContextMismatch")),
        case("glued-bodies", &glued, "msg", "content", json!({}), err("DuplicateField")),
        case("op-id-not-v7", &bad_id, "msg", "content", json!({}), err("InvalidField")),
        case("bad-context-name", &good, "MSG", "content", json!({}), err("InvalidField")),
        case(
            "sdp-right-callee",
            &sdp,
            "call",
            "signal",
            json!({"audience": {"address": "bob@x", "device_id": "d1"}, "target": {"domain": "x", "id_hex": hexs(&[7; 16])}}),
            ok(),
        ),
        case(
            "sdp-forwarded-to-other",
            &sdp,
            "call",
            "signal",
            json!({"audience": {"address": "carol@x", "device_id": "c1"}}),
            err("ContextMismatch"),
        ),
        case(
            "sdp-other-call",
            &sdp,
            "call",
            "signal",
            json!({"target": {"domain": "x", "id_hex": hexs(&[8; 16])}}),
            err("ContextMismatch"),
        ),
    ];
    json!({
        "suite": "sign",
        "description": "подписываемые байты \"parvane/v2/op\" ‖ u8(len) ‖ domain ‖ u8(len) ‖ op_type ‖ body; проверка над присланными байтами",
        "keys": {
            "alice": {"seed_hex": hexs(&[1; 32]), "public_hex": hexs(alice.verifying_key().as_bytes())},
            "bob": {"seed_hex": hexs(&[2; 32]), "public_hex": hexs(bob.verifying_key().as_bytes())}
        },
        "cases": cases
    })
}

#[test]
fn sign_vectors() {
    let v = load_or_generate("sign", "ops.json", generate);
    for case in cases(&v) {
        let name = case["name"].as_str().unwrap();
        let input = &case["input"];
        let op = SignedOp {
            body: unhex(&input["op"], "body_hex"),
            signature: unhex(&input["op"], "signature_hex"),
            signer_key: unhex(&input["op"], "signer_hex"),
        };
        let expect_signer: Option<[u8; 32]> =
            input.get("expect_signer_hex").map(|_| unhex(input, "expect_signer_hex").try_into().unwrap());
        let got = sign::verify_op(&op, input["expect_domain"].as_str().unwrap(), input["expect_op_type"].as_str().unwrap(), expect_signer.as_ref())
            .and_then(|v| {
                if let Some(a) = input.get("audience") {
                    v.require_audience(&DeviceRef { address: a["address"].as_str().unwrap().into(), device_id: a["device_id"].as_str().unwrap().into() })?;
                }
                if let Some(t) = input.get("target") {
                    v.require_target(&Ref { domain: t["domain"].as_str().unwrap().into(), id: unhex(t, "id_hex") })?;
                }
                Ok(v)
            });
        check(name, &got, &case["expect"]);
        if let (Ok(v), Some(p)) = (&got, case["expect"].get("payload_hex")) {
            assert_eq!(hexs(&v.payload), p.as_str().unwrap(), "{name}");
        }
    }
}

/// Детерминированность: подпись вектора «valid» воспроизводится из seed.
#[test]
fn sign_vectors_deterministic() {
    let v = load_or_generate("sign", "ops.json", generate);
    let fresh = generate();
    assert_eq!(cases(&v)[0], cases(&fresh)[0]);
}
