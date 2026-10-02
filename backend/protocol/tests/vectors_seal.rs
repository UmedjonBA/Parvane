//! Векторы SEAL-1 и GSEAL-1 (T081): вскрытие sealed-конверта (HPKE) и
//! группового конверта эпохи (ChaCha20-Poly1305 + подпись ключом отправки)
//! фиксированными ключами. Конверты сгенерированы один раз (HPKE и nonce
//! случайны) и лежат в `proto/parvane/vectors/seal/`; клиенты обязаны вскрыть
//! их той же обвязкой движка и получить те же внутренние байты или ту же ошибку.

use ed25519_dalek::SigningKey;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as _, Serializable};
use parvane_protocol::codec::decode_checked;
use parvane_protocol::group;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    sealed_envelope::Access, DeviceRef, GroupEnvelope, GroupEnvelopeInner, Ref, SealedEnvelope, SealedInner,
};
use parvane_protocol::seal;
use prost::Message;
use serde_json::{json, Value};

mod common;

const HPKE_SK: [u8; 32] = [0x11; 32];
const ENVELOPE_KEY: [u8; 32] = [0x22; 32];
const SEND_SEED: [u8; 32] = [0x33; 32];

fn hpke_pk() -> [u8; 32] {
    let sk = <X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(&HPKE_SK).expect("sk");
    let pk = X25519HkdfSha256::sk_to_pk(&sk);
    let mut out = [0u8; 32];
    out.copy_from_slice(&pk.to_bytes());
    out
}

fn bob() -> DeviceRef {
    DeviceRef { address: "bob@x".into(), device_id: "d1".into() }
}

fn group_ref() -> Ref {
    Ref { domain: "x".into(), id: vec![7; 16] }
}

fn generate_seal() -> Value {
    let inner = SealedInner { olm_message: b"olm-bytes".to_vec(), olm_type: 1, ..Default::default() };
    let env = seal::seal(&bob(), &hpke_pk(), Access::DeliveryKey(vec![5; 32]), inner.clone(), false).expect("seal");
    let l2 = seal::seal(&bob(), &hpke_pk(), Access::DeliveryKey(vec![5; 32]), inner.clone(), true).expect("seal l2");
    let mut tampered = env.clone();
    tampered.ciphertext[0] ^= 1;
    let mut other = env.clone();
    other.recipient = Some(DeviceRef { address: "bob@x".into(), device_id: "d2".into() });
    let ok_inner = common::hexs(&inner.encode_to_vec());
    json!({ "hpke_sk_hex": common::hexs(&HPKE_SK), "me": { "address": "bob@x", "device_id": "d1" }, "cases": [
        { "name": "open", "input": { "envelope_hex": common::hexs(&env.encode_to_vec()) }, "expect": { "ok": true, "result": { "olm_message_hex": common::hexs(b"olm-bytes"), "olm_type": 1, "inner_hex": ok_inner } } },
        { "name": "open-l2-padded", "input": { "envelope_hex": common::hexs(&l2.encode_to_vec()) }, "expect": { "ok": true, "result": { "olm_message_hex": common::hexs(b"olm-bytes"), "olm_type": 1 } } },
        { "name": "tampered", "input": { "envelope_hex": common::hexs(&tampered.encode_to_vec()) }, "expect": { "error": "Crypto" } },
        { "name": "other-device", "input": { "envelope_hex": common::hexs(&other.encode_to_vec()) }, "expect": { "error": "ContextMismatch" } },
    ]})
}

fn generate_gseal() -> Value {
    let send = SigningKey::from_bytes(&SEND_SEED);
    let inner = GroupEnvelopeInner { megolm_session_id: b"sess".to_vec(), megolm_message: b"megolm-bytes".to_vec(), ..Default::default() };
    let env = group::seal_envelope(&send, &ENVELOPE_KEY, &group_ref(), 3, &inner).expect("seal");
    let mut tampered = env.clone();
    tampered.epoch_aead_ciphertext[0] ^= 1;
    let mut resigned_epoch = env.clone();
    resigned_epoch.epoch = 4;
    json!({
        "envelope_key_hex": common::hexs(&ENVELOPE_KEY),
        "send_public_key_hex": common::hexs(send.verifying_key().as_bytes()),
        "state_epoch": 3,
        "cases": [
            { "name": "verify-and-open", "input": { "envelope_hex": common::hexs(&env.encode_to_vec()) }, "expect": { "ok": true, "result": { "megolm_session_id_hex": common::hexs(b"sess"), "megolm_message_hex": common::hexs(b"megolm-bytes") } } },
            { "name": "tampered-ciphertext", "input": { "envelope_hex": common::hexs(&tampered.encode_to_vec()) }, "expect": { "error": "BadSignature" } },
            { "name": "stale-epoch", "input": { "envelope_hex": common::hexs(&resigned_epoch.encode_to_vec()) }, "expect": { "error": "Expired" } },
        ]
    })
}

#[test]
fn seal_1_vectors() {
    let v = common::load_or_generate("seal", "sealed.json", generate_seal);
    let sk: [u8; 32] = common::unhex(&v, "hpke_sk_hex").try_into().expect("sk");
    let me = DeviceRef { address: v["me"]["address"].as_str().unwrap_or("").into(), device_id: v["me"]["device_id"].as_str().unwrap_or("").into() };
    for case in common::cases(&v) {
        let name = case["name"].as_str().unwrap_or("?");
        let env: SealedEnvelope = decode_checked(&common::unhex(&case["input"], "envelope_hex"), Origin::Client).expect("конверт");
        let got = seal::open(&env, &me, &sk);
        common::check(name, &got, &case["expect"]);
        if let (Ok(inner), Some(r)) = (&got, case["expect"].get("result")) {
            assert_eq!(common::hexs(&inner.olm_message), r["olm_message_hex"].as_str().unwrap_or(""), "{name}");
            assert_eq!(u64::from(inner.olm_type), r["olm_type"].as_u64().unwrap_or(99), "{name}");
        }
    }
}

#[test]
fn gseal_1_vectors() {
    let v = common::load_or_generate("seal", "group.json", generate_gseal);
    let key: [u8; 32] = common::unhex(&v, "envelope_key_hex").try_into().expect("key");
    let pk: [u8; 32] = common::unhex(&v, "send_public_key_hex").try_into().expect("pk");
    let epoch = v["state_epoch"].as_u64().unwrap_or(0);
    for case in common::cases(&v) {
        let name = case["name"].as_str().unwrap_or("?");
        let env: GroupEnvelope = decode_checked(&common::unhex(&case["input"], "envelope_hex"), Origin::Client).expect("конверт");
        let got = group::verify_envelope(&env, epoch, &pk).and_then(|_| group::open_envelope(&env, &key));
        common::check(name, &got, &case["expect"]);
        if let (Ok(inner), Some(r)) = (&got, case["expect"].get("result")) {
            assert_eq!(common::hexs(&inner.megolm_session_id), r["megolm_session_id_hex"].as_str().unwrap_or(""), "{name}");
            assert_eq!(common::hexs(&inner.megolm_message), r["megolm_message_hex"].as_str().unwrap_or(""), "{name}");
        }
    }
}
