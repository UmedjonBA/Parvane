//! Векторы режима «усиленная приватность» (L2-1, T079):
//! `proto/parvane/vectors/l2/mode.json`. Один файл на все обвязки — набор
//! `l2/mode` в `parvane_protocol::conformance`: сетка выравнивания личных и
//! групповых конвертов (512/2048/8192/32768, дальше кратно 32768),
//! согласование режима участниками и запрет эфемерных каналов.

mod common;

use common::*;
use parvane_protocol::conformance;
use parvane_protocol::l2::{self, ChatKind, L2Pref, L2State};
use parvane_protocol::pb::parvane::core::v2::{GroupEnvelopeInner, SealedInner};
use prost::Message;
use serde_json::{json, Value};

fn direct_len(olm_len: usize) -> usize {
    let mut inner = SealedInner { olm_message: vec![1; olm_len], ..Default::default() };
    l2::pad_direct(&mut inner);
    inner.encoded_len()
}

fn group_len(session_id_len: usize, message_len: usize) -> usize {
    let mut inner = GroupEnvelopeInner { megolm_session_id: vec![1; session_id_len], megolm_message: vec![7; message_len], padding: vec![] };
    l2::pad_group(&mut inner);
    inner.encoded_len()
}

type Pref = (&'static str, bool, i64);

/// (имя, вид чата, я, участники, предпочтения по порядку, политика группы по порядку)
type Negotiation = (&'static str, ChatKind, &'static str, Vec<&'static str>, Vec<Pref>, Vec<(bool, i64)>);

fn negotiations() -> Vec<Negotiation> {
    use ChatKind::{Direct, Group};
    let ab = || vec!["a@x", "b@x"];
    let abc = || vec!["a@x", "b@x", "c@x"];
    vec![
        ("direct-default-off", Direct, "a@x", ab(), vec![], vec![]),
        ("direct-peer-enabled", Direct, "a@x", ab(), vec![("b@x", true, 10)], vec![]),
        ("direct-self-enabled", Direct, "a@x", ab(), vec![("a@x", true, 10)], vec![]),
        ("direct-stale-disable-ignored", Direct, "a@x", ab(), vec![("b@x", true, 10), ("b@x", false, 5)], vec![]),
        ("direct-newer-disable", Direct, "a@x", ab(), vec![("b@x", true, 10), ("b@x", false, 20)], vec![]),
        ("direct-equal-ts-enable-wins", Direct, "a@x", ab(), vec![("b@x", false, 20), ("b@x", true, 20), ("b@x", false, 20)], vec![]),
        ("direct-one-off-other-on", Direct, "a@x", ab(), vec![("a@x", true, 10), ("b@x", true, 11), ("a@x", false, 12)], vec![]),
        ("direct-both-off", Direct, "a@x", ab(), vec![("a@x", true, 10), ("b@x", true, 11), ("a@x", false, 12), ("b@x", false, 13)], vec![]),
        ("direct-outsider-ignored", Direct, "a@x", ab(), vec![("eve@x", true, 10)], vec![]),
        ("group-default-off", Group, "a@x", abc(), vec![], vec![]),
        ("group-personal-pref-pads-own", Group, "a@x", abc(), vec![("a@x", true, 1)], vec![]),
        ("group-other-member-pref", Group, "b@x", abc(), vec![("a@x", true, 1)], vec![]),
        ("group-policy-on", Group, "b@x", abc(), vec![], vec![(true, 2)]),
        ("group-policy-stale-off-ignored", Group, "b@x", abc(), vec![], vec![(true, 2), (false, 1)]),
        ("group-policy-off-pref-on", Group, "a@x", abc(), vec![("a@x", true, 1)], vec![(true, 2), (false, 3)]),
    ]
}

fn generate() -> Value {
    let mut cases = Vec::new();
    // Границы корзин: ровно в корзину, на байт больше, далеко за последней.
    for n in [0usize, 1, 100, 400, 506, 507, 508, 509, 510, 600, 2000, 2040, 2045, 3000, 8100, 8190, 9000, 20000, 32700, 32768, 40000, 70000, 100000] {
        cases.push(json!({"name": format!("pad-direct-{n}"), "input": {"op": "pad_direct", "olm_len": n}, "expect": {"len": direct_len(n)}}));
    }
    for n in [0usize, 10, 350, 400, 459, 460, 461, 462, 463, 600, 1990, 1998, 3000, 8140, 9000, 32700, 40000, 70000] {
        cases.push(json!({"name": format!("pad-group-{n}"), "input": {"op": "pad_group", "session_id_len": 43, "message_len": n}, "expect": {"len": group_len(43, n)}}));
    }
    for (name, kind, me, parts, prefs, policy) in negotiations() {
        let mut st = L2State::new(kind);
        for (u, enabled, ts_ms) in &prefs {
            st.set_pref(u, L2Pref { enabled: *enabled, ts_ms: *ts_ms });
        }
        for (enabled, ts_ms) in &policy {
            st.set_group_policy(L2Pref { enabled: *enabled, ts_ms: *ts_ms });
        }
        cases.push(json!({
            "name": name,
            "input": {
                "op": "negotiate", "chat": if kind == ChatKind::Direct { "direct" } else { "group" }, "me": me, "participants": parts,
                "prefs": prefs.iter().map(|(u, e, t)| json!({"user": u, "enabled": e, "ts_ms": t})).collect::<Vec<_>>(),
                "group_policy": policy.iter().map(|(e, t)| json!({"enabled": e, "ts_ms": t})).collect::<Vec<_>>(),
            },
            "expect": {"active": st.active(&parts), "pad": st.must_pad(me, &parts), "ephemeral": st.ephemeral_allowed(&parts)},
        }));
    }
    json!({"suite": "l2", "description": "режим «усиленная приватность» (L2-1): сетка выравнивания личных и групповых конвертов, согласование режима участниками, запрет typing/presence", "cases": cases})
}

#[test]
fn l2_vectors() {
    let v = load_or_generate("l2", "mode.json", generate);
    let n = conformance::run("l2/mode", &v.to_string()).unwrap();
    assert!(n >= 50, "случаев: {n}");
}

/// Смысл векторов не зависит от генератора: размеры — точно на сетке,
/// ожидания согласования — по правилам из шапки `l2.rs`.
#[test]
fn vectors_mean_what_the_rule_says() {
    let v = load_or_generate("l2", "mode.json", generate);
    let expect = |name: &str| cases(&v).iter().find(|c| c["name"] == name).map(|c| c["expect"].clone()).unwrap();
    for c in cases(&v) {
        if let Some(len) = c["expect"].get("len").and_then(Value::as_u64) {
            let len = len as usize;
            let on_grid = [512usize, 2048, 8192, 32768].contains(&len) || (len > 32768 && len % 32768 == 0);
            assert!(on_grid, "{}: {len}", c["name"]);
        }
    }
    // Одна корзина — один размер: длину сообщения по конверту не узнать.
    assert_eq!(expect("pad-direct-0"), expect("pad-direct-400"));
    assert_eq!(expect("pad-group-10"), expect("pad-group-400"));
    assert_eq!(expect("pad-direct-600")["len"], 2048);
    assert_eq!(expect("pad-direct-100000")["len"], 131072);
    let flags = |name: &str| {
        let e = expect(name);
        (e["active"] == true, e["pad"] == true, e["ephemeral"] == true)
    };
    assert_eq!(flags("direct-default-off"), (false, false, true));
    assert_eq!(flags("direct-peer-enabled"), (true, true, false));
    assert_eq!(flags("direct-stale-disable-ignored"), (true, true, false));
    assert_eq!(flags("direct-newer-disable"), (false, false, true));
    assert_eq!(flags("direct-equal-ts-enable-wins"), (true, true, false));
    assert_eq!(flags("direct-one-off-other-on"), (true, true, false));
    assert_eq!(flags("direct-both-off"), (false, false, true));
    assert_eq!(flags("direct-outsider-ignored"), (false, false, true));
    assert_eq!(flags("group-personal-pref-pads-own"), (false, true, true));
    assert_eq!(flags("group-other-member-pref"), (false, false, true));
    assert_eq!(flags("group-policy-on"), (true, true, false));
    assert_eq!(flags("group-policy-stale-off-ignored"), (true, true, false));
    assert_eq!(flags("group-policy-off-pref-on"), (false, true, true));
}

/// Файл на диске совпадает с генератором.
#[test]
fn file_matches_generator() {
    let v = load_or_generate("l2", "mode.json", generate);
    assert_eq!(v, generate(), "proto/parvane/vectors/l2/mode.json устарел — PARVANE_REGEN_VECTORS=1");
}
