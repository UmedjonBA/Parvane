//! Векторы журналов (T115, T116; D-01, D-02, D-03, D-11):
//! `proto/parvane/vectors/device_log/`, `proto/parvane/vectors/group_log/`.
//! Каждый вектор — последовательность записей (байты) и ожидаемый исход
//! применения каждой; подписанты — таблица «ключ → пользователь, корень».

mod common;

use std::collections::HashMap;

use common::*;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::group::{self, SignerInfo};
use parvane_protocol::identity::{self, DeviceLog, RootIdentity};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    user_device_log_entry::Change as DevChange, DeviceCertificate, GroupStateEntry, LegacyDevice, LegacyDeviceSet, Ref,
    SignedOp, UserRef,
};
use parvane_protocol::pb::parvane::group::v2::{group_change::Change, AddMember, Ban, Create, GroupKind, Permissions};
use parvane_protocol::sign;
use prost::Message;
use serde_json::{json, Value};

/// Сертификат с доказательством владения (C1-01): ключ устройства — по id.
fn cert(root: &RootIdentity, user: &str, id: &str, serial: u64) -> DeviceCertificate {
    let mut seed = [7u8; 32];
    for (i, b) in id.bytes().enumerate().take(32) {
        seed[i] = b;
    }
    let k = ed25519_dalek::SigningKey::from_bytes(&seed);
    let mut c = DeviceCertificate {
        user: Some(UserRef { address: user.into() }),
        device_id: id.into(),
        olm_curve25519: vec![1; 32],
        olm_ed25519: k.verifying_key().to_bytes().to_vec(),
        hpke_x25519: vec![3; 32],
        serial,
        ..Default::default()
    };
    identity::prove_possession(&k, &mut c, &root.root_pub()).unwrap();
    c
}

fn step(op: &SignedOp, expect: Value) -> Value {
    json!({"entry_hex": hexs(&op.encode_to_vec()), "expect": expect})
}

fn gen_device_log() -> Value {
    let a = RootIdentity::generate("alice@x").unwrap();
    let evil = RootIdentity::generate("alice@x").unwrap();
    let mut log = DeviceLog::new("alice@x").unwrap();
    let mut steps = vec![];
    let g = a.genesis_entry().unwrap();
    log.apply(&g).unwrap();
    steps.push(step(&g, ok()));
    let add = a.add_device_entry(2, log.head_hash, &cert(&a, "alice@x", "d1", 1)).unwrap();
    log.apply(&add).unwrap();
    steps.push(step(&add, ok()));
    // Повтор записи.
    steps.push(step(&add, err("BrokenChain")));
    // Сервер со своим корнем/SSK добавляет устройство.
    let forged = evil.add_device_entry(3, log.head_hash, &cert(&evil, "alice@x", "evil", 1)).unwrap();
    steps.push(step(&forged, err("BadSignature")));
    // Откат serial того же устройства.
    let rollback = a.add_device_entry(3, log.head_hash, &cert(&a, "alice@x", "d1", 1)).unwrap();
    steps.push(step(&rollback, err("BrokenChain")));
    // LegacyDeviceSet.
    let old = LegacyDevice { device_id: "old".into(), olm_curve25519: vec![5; 32], olm_ed25519: vec![6; 32] };
    let e = identity::device_log_entry("alice@x", 3, log.head_hash, DevChange::LegacyDevices(LegacyDeviceSet { devices: vec![old.clone()] }), None);
    let legacy = identity::sign_device_log_entry(&a.self_signing, &e).unwrap();
    log.apply(&legacy).unwrap();
    steps.push(step(&legacy, ok()));
    // Расширение списка легаси-устройств запрещено.
    let more = LegacyDevice { device_id: "srv".into(), olm_curve25519: vec![7; 32], olm_ed25519: vec![8; 32] };
    let e = identity::device_log_entry("alice@x", 4, log.head_hash, DevChange::LegacyDevices(LegacyDeviceSet { devices: vec![old, more] }), None);
    steps.push(step(&identity::sign_device_log_entry(&a.self_signing, &e).unwrap(), err("Forbidden")));
    // Отзыв и попытка вернуть.
    let e = identity::device_log_entry("alice@x", 4, log.head_hash, DevChange::RevokeDeviceId("d1".into()), None);
    let revoke = identity::sign_device_log_entry(&a.self_signing, &e).unwrap();
    log.apply(&revoke).unwrap();
    steps.push(step(&revoke, ok()));
    let back = a.add_device_entry(5, log.head_hash, &cert(&a, "alice@x", "d1", 7)).unwrap();
    steps.push(step(&back, err("Forbidden")));
    json!({
        "suite": "device_log",
        "description": "журнал устройств alice@x: генезис, добавление, повтор, подделка сервером, откат serial, LegacyDeviceSet только сокращается, отзыв",
        "user": "alice@x",
        "final": {"version": log.version, "active": ["—"], "revoked": ["d1"], "legacy": ["old"]},
        "cases": [{"name": "sequence", "input": {"steps": steps}, "expect": ok()}]
    })
}

#[test]
fn device_log_vectors() {
    let v = load_or_generate("device_log", "alice.json", gen_device_log);
    let user = v["user"].as_str().unwrap();
    for case in cases(&v) {
        let mut log = DeviceLog::new(user).unwrap();
        for (i, s) in case["input"]["steps"].as_array().unwrap().iter().enumerate() {
            let op: SignedOp = decode_checked(&unhex(s, "entry_hex"), Origin::Client).unwrap();
            check(&format!("device_log шаг {i}"), &log.apply(&op), &s["expect"]);
        }
        assert_eq!(log.version, v["final"]["version"].as_u64().unwrap());
        assert!(log.revoked.contains("d1") && log.active("d1").is_none());
        assert_eq!(log.legacy.as_ref().unwrap().len(), 1);
    }
}

fn gen_group_log() -> Value {
    let alice = sign::generate_signing_key();
    let bob = sign::generate_signing_key();
    let srv = sign::generate_signing_key();
    let signers = json!({
        hexs(alice.verifying_key().as_bytes()): {"user": "alice@x", "root_hex": hexs(&[1; 32])},
        hexs(bob.verifying_key().as_bytes()): {"user": "bob@x", "root_hex": hexs(&[2; 32])},
        hexs(srv.verifying_key().as_bytes()): {"user": "srv@x", "root_hex": hexs(&[3; 32])}
    });
    let resolve = resolver(&signers);
    let perms = Permissions { send_messages: true, invite_users: false, ..Default::default() };
    let g = group::build_entry(&alice, None, "x", Change::Create(Create { kind: GroupKind::Group as i32, name: "G".into(), default_permissions: Some(perms), members: vec![UserRef { address: "bob@x".into() }], ..Default::default() }), 1).unwrap();
    let s1 = group::apply(None, &g, &resolve).unwrap();
    let e = |v: Value, entry: &GroupStateEntry| json!({"entry_hex": hexs(&entry.encode_to_vec()), "expect": v});
    let mut steps = vec![e(ok(), &g)];
    // Сервер вставляет участника.
    let inject = group::build_entry(&srv, Some(&s1), "x", Change::AddMember(AddMember { member: Some(UserRef { address: "eve@x".into() }) }), 2).unwrap();
    steps.push(e(err("Forbidden"), &inject));
    // Боб без права приглашать.
    let bob_add = group::build_entry(&bob, Some(&s1), "x", Change::AddMember(AddMember { member: Some(UserRef { address: "eve@x".into() }) }), 2).unwrap();
    steps.push(e(err("Forbidden"), &bob_add));
    // Алиса банит Боба.
    let ban = group::build_entry(&alice, Some(&s1), "x", Change::Ban(Ban { member: Some(UserRef { address: "bob@x".into() }) }), 3).unwrap();
    let s2 = group::apply(Some(&s1), &ban, &resolve).unwrap();
    steps.push(e(ok(), &ban));
    // Повтор записи бана на следующей позиции.
    let mut moved = ban.clone();
    moved.version = 3;
    moved.prev_hash = s2.head_hash().to_vec();
    steps.push(e(err("ContextMismatch"), &moved));
    // Перенос в другую группу.
    let mut foreign = ban.clone();
    foreign.group = Some(Ref { domain: "x".into(), id: vec![9; 16] });
    foreign.version = 3;
    foreign.prev_hash = s2.head_hash().to_vec();
    steps.push(e(err("ContextMismatch"), &foreign));
    json!({
        "suite": "group_log",
        "description": "журнал группы: генезис, вставка участника сервером, право приглашать, бан, перестановка/повтор, перенос в другую группу",
        "signers": signers,
        "cases": [{"name": "sequence", "input": {"steps": steps}, "expect": ok()}],
        "fork": {"version": s2.version, "head_hex": hexs(&s2.head_hash()), "other_head_hex": hexs(&[0xee; 32])}
    })
}

fn resolver(signers: &Value) -> impl Fn(&[u8; 32]) -> Option<SignerInfo> {
    let map: HashMap<String, SignerInfo> = signers
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), SignerInfo { user: v["user"].as_str().unwrap().into(), root_key: unhex(v, "root_hex").try_into().unwrap() }))
        .collect();
    move |k: &[u8; 32]| map.get(&hexs(k)).cloned()
}

#[test]
fn group_log_vectors() {
    let v = load_or_generate("group_log", "group.json", gen_group_log);
    let resolve = resolver(&v["signers"]);
    for case in cases(&v) {
        let mut state: Option<group::GroupState> = None;
        for (i, s) in case["input"]["steps"].as_array().unwrap().iter().enumerate() {
            let entry: GroupStateEntry = decode_checked(&unhex(s, "entry_hex"), Origin::Client).unwrap();
            let r = group::apply(state.as_ref(), &entry, &resolve);
            check(&format!("group_log шаг {i}"), &r, &s["expect"]);
            if let Ok(ns) = r {
                state = Some(ns);
            }
        }
        let st = state.unwrap();
        assert!(st.banned.contains("bob@x"));
        // Форк: та же версия, другой hash.
        let mut ctx = st.context();
        assert_eq!(hexs(&ctx.state_head_hash), v["fork"]["head_hex"].as_str().unwrap());
        ctx.state_head_hash = unhex(&v["fork"], "other_head_hex");
        assert_eq!(st.check_context(&ctx), group::ContextVerdict::Fork);
    }
}
