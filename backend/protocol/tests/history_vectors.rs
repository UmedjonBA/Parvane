//! Векторы журнала истории аккаунта (spec 033; правила HIST-1, HIST-2, READ-2):
//! `proto/parvane/vectors/history/`.
//!
//! - `merge.json` — события строки в разных порядках и с повторами дают побайтно одинаковый канонический
//!   `RowState` и одинаковый вид (`historyView`); отвергаемые события;
//! - `unread.json` — непрочитанное от маркера, сведение маркеров, права удаления;
//! - `segment.json` — ключи и отпечатки сегментов, горизонт надгробий, режим замены, строка формата привязки;
//! - `aead.json` — ключ истории (HKDF от ключа состояния), запись журнала: чужой адрес/op_id/chunk/ключ.
//!
//! Векторы проверяются прогоном `conformance::run` (тот же код, что зовут клиенты через WASM и C ABI) и
//! свойством: случайные перестановки, повторы и разбиения набора событий → побайтно одинаковый итог
//! (2000 случаев).

mod common;

use common::*;
use parvane_protocol::conformance;
use parvane_protocol::history::{self as h, HistoryKey};
use parvane_protocol::host::history::to_json;
use parvane_protocol::pb::parvane::core::v2::{Ref, UserRef};
use parvane_protocol::pb::parvane::history::v1::{
    history_op::Op, ChatSummary, Edit, Gone, GoneScope, HistoryBatch, HistoryOp, MessageRow, Pin, React, ReadMark, RowState,
    SegmentRef, Stamp,
};
use parvane_protocol::pb::parvane::state::v1::{peer, Peer};
use parvane_protocol::state::StateKey;
use proptest::prelude::*;
use prost::Message;
use serde_json::{json, Value};

const ME: &str = "alice@x";
const PEER: &str = "bob@x";

fn user(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

fn group() -> Peer {
    Peer { kind: Some(peer::Kind::Group(Ref { domain: "x".into(), id: vec![0x42; 16] })) }
}

/// id сообщения: UUIDv7-подобные 16 байт с номером в конце.
fn mid(n: u8) -> Vec<u8> {
    let mut b = vec![0x01, 0x92, 0x3a, 0x4b, 0x5c, 0x6d, 0x70, 0x00, 0x80, 0, 0, 0, 0, 0, 0, n];
    b[7] = n;
    b
}

fn st(ts: i64, n: u8) -> Stamp {
    Stamp { ts_ms: ts, op_id: mid(0xa0 + n) }
}

fn body(v: Value) -> Vec<u8> {
    serde_json::to_vec(&h::sorted_json(v)).unwrap()
}

fn text(t: &str) -> Vec<u8> {
    body(json!({"content": {"kind": "text", "text": t}}))
}

fn row_in(chat: &Peer, id: u8, from: &str, ts: i64, b: Vec<u8>) -> HistoryOp {
    h::row_op(MessageRow { id: mid(id), chat: Some(chat.clone()), from: from.into(), ts_ms: ts, body: b })
}

fn row(id: u8, from: &str, ts: i64, t: &str) -> HistoryOp {
    row_in(&user(PEER), id, from, ts, text(t))
}

fn gone_in(chat: &Peer, id: u8, s: Stamp, scope: GoneScope) -> HistoryOp {
    h::gone_op(Gone { target: mid(id), chat: Some(chat.clone()), stamp: Some(s), scope: scope as i32 })
}

fn gone(id: u8, s: Stamp, scope: GoneScope) -> HistoryOp {
    gone_in(&user(PEER), id, s, scope)
}

fn edit(id: u8, s: Stamp, t: &str) -> HistoryOp {
    h::edit_op(Edit { target: mid(id), chat: Some(user(PEER)), stamp: Some(s), body: body(json!({"content": {"kind": "text", "text": t}})) })
}

fn react_in(chat: &Peer, id: u8, who: &str, s: Stamp, emoji: &str) -> HistoryOp {
    h::react_op(React { target: mid(id), chat: Some(chat.clone()), user: who.into(), stamp: Some(s), emoji: emoji.into() })
}

fn react(id: u8, who: &str, s: Stamp, emoji: &str) -> HistoryOp {
    react_in(&user(PEER), id, who, s, emoji)
}

fn pin(id: u8, s: Stamp, pinned: bool) -> HistoryOp {
    h::pin_op(Pin { target: mid(id), chat: Some(user(PEER)), stamp: Some(s), pinned })
}

fn mark(ts: i64, id: u8) -> ReadMark {
    ReadMark { chat: Some(user(PEER)), up_to_ts_ms: ts, up_to_id: mid(id) }
}

fn fold(ops: &[&HistoryOp]) -> RowState {
    let mut s: Option<RowState> = None;
    for op in ops {
        s = Some(h::apply(s.as_ref(), op).unwrap());
    }
    s.unwrap()
}

/// Порядки применения: прямой, обратный, сдвиги, чередование с повторами.
fn orders(n: usize) -> Vec<Vec<usize>> {
    let mut out = vec![(0..n).collect::<Vec<_>>(), (0..n).rev().collect()];
    for k in 1..n.min(4) {
        out.push((0..n).map(|i| (i + k) % n).collect());
    }
    // каждое событие дважды, вперемешку
    out.push((0..n).flat_map(|i| [n - 1 - i, i]).collect());
    out.dedup();
    out
}

fn merge_case(name: &str, ops: Vec<HistoryOp>) -> Value {
    let refs: Vec<&HistoryOp> = ops.iter().collect();
    let s = fold(&refs);
    json!({
        "name": name,
        "input": {"ops": ops.iter().map(to_json).collect::<Vec<_>>(), "orders": orders(ops.len())},
        "expect": {"state": to_json(&s), "view": h::view(&s).unwrap()},
    })
}

fn gen_merge() -> Value {
    let g = group();
    let mut cases = vec![
        merge_case(
            "сообщение, правки, реакции, закреп",
            vec![
                row(1, PEER, 1_000, "привет"),
                edit(1, st(2_000, 1), "привет!"),
                edit(1, st(3_000, 2), "привет!!"),
                react(1, ME, st(2_500, 3), "👍"),
                react(1, PEER, st(2_600, 4), "❤"),
                react(1, ME, st(4_000, 5), ""),
                pin(1, st(5_000, 6), true),
                pin(1, st(5_500, 7), false),
                pin(1, st(6_000, 8), true),
            ],
        ),
        merge_case(
            "удаление у всех стирает тело, правку, реакции и закреп",
            vec![row(2, PEER, 1_000, "секрет"), edit(2, st(2_000, 1), "ещё"), react(2, ME, st(2_100, 2), "👍"), pin(2, st(2_200, 3), true), gone(2, st(3_000, 4), GoneScope::Everyone)],
        ),
        merge_case("удаление до сообщения: строка не появляется", vec![gone(3, st(5_000, 1), GoneScope::Everyone), row(3, PEER, 1_000, "опоздавшее")]),
        merge_case("правка до сообщения применяется, когда оно придёт", vec![edit(4, st(2_000, 1), "новый текст"), row(4, PEER, 1_000, "старый текст")]),
        merge_case("сирота без сообщения не видна", vec![react(5, PEER, st(1_000, 1), "🔥"), pin(5, st(1_100, 2), true)]),
        merge_case("два тела одного сообщения — меньшее", vec![row(6, PEER, 1_000, "бета"), row(6, PEER, 1_000, "альфа")]),
        merge_case("ничья метки правки — по байтам тела", vec![edit(7, st(2_000, 1), "x"), edit(7, st(2_000, 1), "y"), row(7, PEER, 1_000, "z")]),
        merge_case("удалить только у меня", vec![row(8, ME, 1_000, "своё"), gone(8, st(2_000, 1), GoneScope::Me)]),
        merge_case("удаление позже удаления — побеждает позднее", vec![row(9, PEER, 1_000, "a"), gone(9, st(2_000, 1), GoneScope::Me), gone(9, st(3_000, 2), GoneScope::Everyone)]),
        merge_case(
            "группа: реакции нескольких участников",
            vec![
                row_in(&g, 10, "carol@x", 1_000, text("всем")),
                react_in(&g, 10, PEER, st(1_100, 1), "👍"),
                react_in(&g, 10, ME, st(1_200, 2), "👍"),
                react_in(&g, 10, "carol@x", st(1_300, 3), "😂"),
                react_in(&g, 10, PEER, st(1_400, 4), "😂"),
            ],
        ),
        merge_case("повторы одного события", vec![row(11, PEER, 1_000, "a"), row(11, PEER, 1_000, "a"), react(11, ME, st(2_000, 1), "👍"), react(11, ME, st(2_000, 1), "👍")]),
    ];
    // Полное состояние как событие (миграция, сегмент точки) — сводится с остальными так же.
    let full = fold(&[&row(12, PEER, 1_000, "a"), &react(12, ME, st(2_000, 1), "👍")]);
    cases.push(merge_case("состояние целиком как событие", vec![HistoryOp { op: Some(Op::State(full)) }, edit(12, st(3_000, 2), "b"), react(12, ME, st(2_500, 3), "❤")]));
    // Отвергаемые события
    let base = fold(&[&row(13, PEER, 1_000, "a")]);
    let mut bad_stamp = edit(13, st(2_000, 1), "b");
    if let Some(Op::Edit(e)) = bad_stamp.op.as_mut() {
        e.stamp = Some(Stamp { ts_ms: 1, op_id: vec![1, 2, 3] });
    }
    let mut bad_body = edit(13, st(2_000, 1), "b");
    if let Some(Op::Edit(e)) = bad_body.op.as_mut() {
        e.body = b"[1,2]".to_vec();
    }
    for (name, state, op, err) in [
        ("чужая цель", Some(base.clone()), row(14, PEER, 1, "x"), "ContextMismatch"),
        ("чужой чат", Some(base.clone()), gone_in(&g, 13, st(1, 1), GoneScope::Me), "ContextMismatch"),
        ("удаление без области", None, gone(13, st(1, 1), GoneScope::Unspecified), "InvalidField"),
        ("маркер — не событие строки", None, HistoryOp { op: Some(Op::Read(mark(1, 1))) }, "InvalidField"),
        ("метка не 16 байт", None, bad_stamp, "InvalidField"),
        ("правка — не JSON-объект", None, bad_body, "InvalidField"),
        ("неверный адрес автора", None, row(15, "не адрес", 1, "x"), "BadAddress"),
    ] {
        let mut input = json!({"kind": "apply", "op": to_json(&op)});
        if let Some(s) = state {
            input["state"] = to_json(&s);
        }
        cases.push(json!({"name": name, "input": input, "expect": err_v(err)}));
    }
    let a = fold(&[&row(16, PEER, 1, "a")]);
    let b = fold(&[&react(16, ME, st(5, 1), "👍")]);
    cases.push(json!({"name": "свести два состояния", "input": {"kind": "merge", "a": to_json(&a), "b": to_json(&b)}, "expect": {"ok": true, "state": to_json(&h::merge(&a, &b).unwrap())}}));
    let c = fold(&[&row_in(&g, 16, PEER, 1, text("a"))]);
    cases.push(json!({"name": "свести состояния разных чатов", "input": {"kind": "merge", "a": to_json(&a), "b": to_json(&c)}, "expect": err_v("ContextMismatch")}));
    json!({"suite": "history/merge", "description": "HIST-1: сведение строки сообщения не зависит от порядка и повторов; удалённое не воскресает", "cases": cases})
}

fn err_v(kind: &str) -> Value {
    json!({"error": kind})
}

fn gen_unread() -> Value {
    let incoming = fold(&[&row(1, PEER, 2_000, "hi")]);
    let own = fold(&[&row(2, ME, 2_000, "моё")]);
    let mode = fold(&[&row_in(&user(PEER), 3, PEER, 2_000, body(json!({"content": {"kind": "chat_mode", "l2": true}})))]);
    let deleted = fold(&[&row(4, PEER, 2_000, "x"), &gone(4, st(3_000, 1), GoneScope::Everyone)]);
    let orphan = fold(&[&react(5, PEER, st(1_000, 1), "👍")]);
    let edited_mode = fold(&[&row(6, PEER, 2_000, "текст"), &edit(6, st(2_500, 1), "правка")]);
    let mut cases = Vec::new();
    for (name, s, m, unread) in [
        ("входящее без маркера", &incoming, None, true),
        ("входящее до маркера", &incoming, Some(mark(3_000, 0)), false),
        ("входящее равно маркеру", &incoming, Some(mark(2_000, 1)), false),
        ("тот же миг, id больше маркера", &incoming, Some(mark(2_000, 0)), true),
        ("входящее после маркера", &incoming, Some(mark(1_999, 9)), true),
        ("своё", &own, None, false),
        ("служебное chat_mode", &mode, None, false),
        ("удалённое", &deleted, None, false),
        ("сирота", &orphan, None, false),
        ("правленое входящее", &edited_mode, Some(mark(1_000, 0)), true),
    ] {
        let mut input = json!({"kind": "unread", "state": to_json(s), "self": ME});
        if let Some(m) = m {
            input["mark"] = to_json(&m);
        }
        cases.push(json!({"name": name, "input": input, "expect": {"ok": true, "unread": unread}}));
    }
    let wrong = ReadMark { chat: Some(group()), up_to_ts_ms: 0, up_to_id: mid(0) };
    cases.push(json!({"name": "маркер другого чата", "input": {"kind": "unread", "state": to_json(&incoming), "mark": to_json(&wrong), "self": ME}, "expect": err_v("ContextMismatch")}));
    for (name, a, b, out) in [
        ("больший по времени", Some(mark(5, 1)), Some(mark(7, 0)), Some(mark(7, 0))),
        ("то же время — больший id", Some(mark(5, 2)), Some(mark(5, 1)), Some(mark(5, 2))),
        ("один маркер", None, Some(mark(5, 1)), Some(mark(5, 1))),
        ("нет маркеров", None, None, None),
    ] {
        let mut input = json!({"kind": "mark_merge"});
        if let Some(a) = a {
            input["a"] = to_json(&a);
        }
        if let Some(b) = b {
            input["b"] = to_json(&b);
        }
        cases.push(json!({"name": format!("сведение маркеров: {name}"), "input": input, "expect": {"ok": true, "mark": out.as_ref().map_or(Value::Null, to_json)}}));
    }
    cases.push(json!({"name": "сведение маркеров разных чатов", "input": {"kind": "mark_merge", "a": to_json(&mark(1, 1)), "b": to_json(&wrong)}, "expect": err_v("ContextMismatch")}));
    for (name, m, ts, id, after) in [
        ("без маркера", None, 1, 1, true),
        ("позже", Some(mark(5, 1)), 6, 0, true),
        ("равно", Some(mark(5, 1)), 5, 1, false),
        ("раньше", Some(mark(5, 1)), 4, 9, false),
    ] {
        let mut input = json!({"kind": "mark_after", "ts_ms": ts, "id": h::uuid_string(&mid(id))});
        if let Some(m) = m {
            input["mark"] = to_json(&m);
        }
        cases.push(json!({"name": format!("сдвиг маркера: {name}"), "input": input, "expect": {"ok": true, "after": after}}));
    }
    for (name, kind, author, deleter, admin, allowed) in [
        ("личный чат: своё", "user", ME, ME, false, true),
        ("личный чат: чужое у всех", "user", PEER, ME, false, true),
        ("группа: своё", "group", ME, ME, false, true),
        ("группа: чужое без права", "group", PEER, ME, false, false),
        ("группа: чужое админом с правом", "group", PEER, ME, true, true),
    ] {
        cases.push(json!({"name": format!("право удаления: {name}"), "input": {"kind": "can_delete", "chat_kind": kind, "author": author, "deleter": deleter, "deleter_is_admin": admin}, "expect": {"allowed": allowed}}));
    }
    json!({"suite": "history/unread", "description": "READ-2: непрочитанное считается от маркера; маркер только растёт; права удаления у всех", "cases": cases})
}

const FEB29_2024: i64 = 1_709_164_800_000; // 2024-02-29T00:00:00Z

fn gen_segment() -> Value {
    let mut cases = Vec::new();
    let in_user = fold(&[&row(1, PEER, FEB29_2024, "a")]);
    let in_group = fold(&[&row_in(&group(), 2, PEER, FEB29_2024 - 1, text("b"))]);
    let orphan = fold(&[&react(3, PEER, st(FEB29_2024 + 40 * 86_400_000, 1), "👍"), &pin(3, st(FEB29_2024 + 10 * 86_400_000, 2), true)]);
    for (name, s) in [("личный чат", &in_user), ("группа, последняя миллисекунда января", &in_group), ("сирота — по самой ранней метке", &orphan)] {
        cases.push(json!({"name": format!("ключ: {name}"), "input": {"kind": "key", "state": to_json(s)}, "expect": {"ok": true, "key": h::segment_key(s).unwrap()}}));
    }
    let deleted = fold(&[&row(4, PEER, FEB29_2024, "x"), &gone(4, st(FEB29_2024 + 5, 1), GoneScope::Everyone)]);
    let d = hexs(&h::segment_digest(&[in_user.clone(), deleted.clone()]).unwrap());
    cases.push(json!({"name": "отпечаток", "input": {"kind": "digest", "states": [to_json(&in_user), to_json(&deleted)]}, "expect": {"digest_hex": d}}));
    cases.push(json!({"name": "отпечаток не зависит от порядка и повторов", "input": {"kind": "digest", "states": [to_json(&deleted), to_json(&in_user), to_json(&in_user)]}, "expect": {"digest_hex": d}}));
    let now = FEB29_2024 + 200 * 86_400_000;
    let live = fold(&[&row(5, PEER, 1_000, "древнее, но живое")]);
    let fresh_gone = fold(&[&gone(6, st(now - 1_000, 1), GoneScope::Me)]);
    // удалённое 200 суток назад — выброшено; сирота с последним событием 160 суток назад — остаётся
    cases.push(json!({"name": "свёртка за горизонтом 180 суток", "input": {"kind": "compact", "now_ms": now, "states": [to_json(&deleted), to_json(&live), to_json(&orphan), to_json(&fresh_gone)]}, "expect": {"states": [to_json(&live), to_json(&orphan), to_json(&fresh_gone)]}}));
    let wire = json!({"id": "0192a3b4-c5d6-7e8f-9012-3456789abcde", "from": PEER, "to": ME, "ts": 1_709_164_800.25, "content": {"text": "hi", "kind": "text"},
        "reply_to": "0192a3b4-c5d6-7e8f-9012-3456789abcd0", "read": true, "edited": false, "reactions": [], "pinned": false, "origin": "v2", "order": 7, "updated_at": 5});
    let op = h::row_from_wire(&wire, &user(PEER)).unwrap();
    cases.push(json!({"name": "строка формата привязки", "input": {"kind": "row_from_wire", "row": wire, "chat": to_json(&user(PEER))}, "expect": {"ok": true, "op": to_json(&op)}}));
    for (name, row, err) in [
        ("без содержимого", json!({"id": "0192a3b4-c5d6-7e8f-9012-3456789abcde", "from": PEER, "ts": 1}), "InvalidField"),
        ("неверный id", json!({"id": "x", "from": PEER, "ts": 1, "content": {"kind": "text"}}), "InvalidField"),
        ("неверный автор", json!({"id": "0192a3b4-c5d6-7e8f-9012-3456789abcde", "from": "bob", "ts": 1, "content": {"kind": "text"}}), "BadAddress"),
    ] {
        cases.push(json!({"name": format!("строка формата привязки: {name}"), "input": {"kind": "row_from_wire", "row": row, "chat": to_json(&user(PEER))}, "expect": err_v(err)}));
    }
    for (name, l, t, c, u, r) in [
        ("надгробия свёрнуты после полной синхронизации, курсор до точки", 10, 20, 5, 6, true),
        ("свёрнуты до полной синхронизации", 30, 20, 5, 6, false),
        ("курсор уже за точкой", 10, 20, 6, 6, false),
    ] {
        cases.push(json!({"name": format!("замена: {name}"), "input": {"kind": "needs_replace", "last_full_sync_ms": l, "tombstones_since_ms": t, "cursor": c, "upto_seq": u}, "expect": {"replace": r}}));
    }
    json!({"suite": "history/segment", "description": "HIST-2: сегменты контрольной точки, горизонт надгробий, режим замены; строка формата привязки", "cases": cases})
}

const RECORD_OP_ID: [u8; 16] = [0x01, 0x92, 0x3a, 0x4b, 0x5c, 0x6d, 0x70, 0x01, 0x80, 0, 0, 0, 0, 0, 0, 0x01];

fn gen_aead() -> Value {
    let skh = "11".repeat(32);
    let sk = StateKey::from_bytes(&[0x11; 32]).unwrap();
    let batch = HistoryBatch { device_id: "d1".into(), ts_ms: 1_700_000_000_000, ops: vec![row(1, PEER, 1_000, "привет"), gone(2, st(2_000, 1), GoneScope::Me)] };
    let nonce = [7u8; 12];
    let seal = |addr: &str, chunk: bool| h::seal_with_nonce(&HistoryKey::derive(&sk, addr), addr, &RECORD_OP_ID, chunk, &batch, nonce).unwrap().aead_ciphertext;
    let ct = seal(ME, false);
    let ct_chunk = seal(ME, true);
    let ct_former = seal("al@x", false);
    let mut other_op = RECORD_OP_ID;
    other_op[15] = 2;
    let mut torn = ct.clone();
    let last = torn.len() - 1;
    torn[last] ^= 1;
    let mut cases = vec![
        json!({"name": "ключ истории", "input": {"kind": "derive", "state_key_hex": skh, "address": ME}, "expect": {"key_hex": hexs(HistoryKey::derive(&sk, ME).as_bytes())}}),
        json!({"name": "ключ истории под прежним адресом другой", "input": {"kind": "derive", "state_key_hex": skh, "address": "al@x"}, "expect": {"key_hex": hexs(HistoryKey::derive(&sk, "al@x").as_bytes())}}),
        json!({"name": "запечатать", "input": {"kind": "seal", "state_key_hex": skh, "address": ME, "op_id_hex": hexs(&RECORD_OP_ID), "chunk": false, "nonce_hex": hexs(&nonce), "batch": to_json(&batch)}, "expect": {"ok": true, "aead_hex": hexs(&ct)}}),
        json!({"name": "запечатать сегмент", "input": {"kind": "seal", "state_key_hex": skh, "address": ME, "op_id_hex": hexs(&RECORD_OP_ID), "chunk": true, "nonce_hex": hexs(&nonce), "batch": to_json(&batch)}, "expect": {"ok": true, "aead_hex": hexs(&ct_chunk)}}),
        json!({"name": "op_id записи не UUIDv7", "input": {"kind": "seal", "state_key_hex": skh, "address": ME, "op_id_hex": "00".repeat(16), "chunk": false, "nonce_hex": hexs(&nonce), "batch": to_json(&batch)}, "expect": err_v("InvalidField")}),
        json!({"name": "открыть", "input": {"kind": "open", "state_key_hex": skh, "address": ME, "op_id_hex": hexs(&RECORD_OP_ID), "chunk": false, "aead_hex": hexs(&ct)}, "expect": {"ok": true, "batch": to_json(&batch)}}),
        json!({"name": "открыть под прежним адресом", "input": {"kind": "open", "state_key_hex": skh, "address": "al@x", "op_id_hex": hexs(&RECORD_OP_ID), "chunk": false, "aead_hex": hexs(&ct_former)}, "expect": {"ok": true, "batch": to_json(&batch)}}),
    ];
    for (name, addr, key_addr, op, chunk, aead, skey) in [
        ("чужой журнал (другой адрес в AAD)", "eve@x", ME, RECORD_OP_ID, false, &ct, skh.clone()),
        ("перенос под другой op_id", ME, ME, other_op, false, &ct, skh.clone()),
        ("подмена флага chunk", ME, ME, RECORD_OP_ID, true, &ct, skh.clone()),
        ("ключ под другим адресом", "al@x", ME, RECORD_OP_ID, false, &ct_former, skh.clone()),
        ("чужой ключ состояния", ME, ME, RECORD_OP_ID, false, &ct, "22".repeat(32)),
        ("порча тега", ME, ME, RECORD_OP_ID, false, &torn, skh.clone()),
    ] {
        cases.push(json!({"name": name, "input": {"kind": "open", "state_key_hex": skey, "address": addr, "key_address": key_addr, "op_id_hex": hexs(&op), "chunk": chunk, "aead_hex": hexs(aead)}, "expect": err_v("Crypto")}));
    }
    json!({"suite": "history/aead", "description": "ключ истории = HKDF-SHA256(ключ состояния, \"parvane/history/v1\", адрес); AES-256-GCM, AAD = \"parvane/v2/history\\0\" ‖ адрес ‖ op_id ‖ chunk", "cases": cases})
}

fn run_suite(suite: &str, file: &str, generate: fn() -> Value) {
    let v = load_or_generate("history", file, generate);
    let n = conformance::run(suite, &v.to_string()).unwrap_or_else(|e| panic!("{e}"));
    assert!(n >= 6, "{suite}: {n}");
    // Файл совпадает с тем, что даёт текущий движок (иначе векторы устарели)
    assert_eq!(v, generate(), "{file}: векторы устарели — PARVANE_REGEN_VECTORS=1");
}

#[test]
fn history_merge_vectors() {
    run_suite("history/merge", "merge.json", gen_merge);
}

#[test]
fn history_unread_vectors() {
    run_suite("history/unread", "unread.json", gen_unread);
}

#[test]
fn history_segment_vectors() {
    run_suite("history/segment", "segment.json", gen_segment);
}

#[test]
fn history_aead_vectors() {
    run_suite("history/aead", "aead.json", gen_aead);
}

/// Сводка: самые старые чаты теряют `last`, если сводка не помещается в запись.
#[test]
fn summary_trims_oldest_last() {
    let big = |i: u8, ts: i64| ChatSummary {
        chat: Some(user(&format!("u{i}@x"))),
        last: Some(fold(&[&row_in(&user(&format!("u{i}@x")), i, PEER, ts, body(json!({"content": {"kind": "text", "text": "x".repeat(40_000)}})))])),
        mark: None,
        unread: 1,
        rows: 1,
    };
    let chats: Vec<ChatSummary> = (0..8).map(|i| big(i, 1_000 + i64::from(i))).collect();
    let seg = SegmentRef { key: "u:bob@x|2024-02".into(), digest: vec![1; 32], seq: 3 };
    let Some(Op::Summary(s)) = h::summary(chats, vec![seg], 5).unwrap().op else { panic!() };
    assert!(s.chats[0].last.is_none() && s.chats[7].last.is_some(), "выброшены старые");
    assert!(HistoryOp { op: Some(Op::Summary(s)) }.encoded_len() <= h::BATCH_BUDGET);
}

/// Сессия: запечатать пачками и открыть своим ключом; ключ другого аккаунта — отказ.
#[test]
fn session_roundtrip_through_host_json() {
    use parvane_protocol::host::HostClient;
    let mut c = HostClient::new("alice@local", "d1", "local").unwrap();
    assert!(c.history_session().is_none(), "без ключа состояния сессии нет");
    c.ensure_state_key();
    let mut s = c.history_session().unwrap();
    let ops = json!([to_json(&row_in(&user("bob@local"), 1, "bob@local", 1_000, text("a"))), to_json(&gone_in(&user("bob@local"), 2, st(5, 1), GoneScope::Me))]);
    let sealed = s.call("seal", &json!({"ops": ops, "chunk": false})).unwrap();
    let rec = sealed[0].clone();
    let req = parvane_protocol::pb::parvane::history::v1::AppendRequest::decode(parvane_protocol::host::from_b64(rec["body"].as_str().unwrap()).unwrap().as_slice()).unwrap();
    assert_eq!(h::uuid_string(&req.op_id), rec["opId"].as_str().unwrap());
    let resp = parvane_protocol::pb::parvane::history::v1::SyncResponse {
        records: vec![parvane_protocol::pb::parvane::history::v1::HistoryRecord { seq: 1, op_id: req.op_id.clone(), aead_ciphertext: req.aead_ciphertext.clone(), chunk: false }],
        more: false,
        head_seq: 1,
        compacted: None,
    };
    let b64 = |b: &[u8]| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(b)
    };
    let got = s.call("ingest", &json!({"resp": b64(&resp.encode_to_vec())})).unwrap();
    assert_eq!(got["ops"], ops, "те же операции, id — UUID-строки");
    assert_eq!(got["records"][0]["count"], 2);
    let mut other = HostClient::new("alice@local", "d2", "local").unwrap();
    other.ensure_state_key();
    let mut o = other.history_session().unwrap();
    let got = o.call("ingest", &json!({"resp": b64(&resp.encode_to_vec())})).unwrap();
    assert_eq!((got["rejected"].as_u64(), got["ops"].as_array().map(Vec::len)), (Some(1), Some(0)));
    // Статические функции — через ту же сессию и через call_static
    let st0 = s.call("historyApply", &json!({"op": ops[0]})).unwrap();
    assert_eq!(parvane_protocol::host::call::call_static("historyApply", &json!({"op": ops[0]})).unwrap(), st0);
    let v = s.call("historyView", &json!({"state": st0})).unwrap();
    assert_eq!((v["visible"].as_bool(), v["id"].as_str()), (Some(true), Some(h::uuid_string(&mid(1)).as_str())));
    assert!(s.call("nope", &json!({})).unwrap_err().contains("UnknownCall"));
}

// ── свойство: порядок, повторы и разбиение не влияют на итог ────────────────

#[derive(Debug, Clone)]
enum Spec {
    Row { from: u8, t: u8 },
    Gone { ts: u8, n: u8, me: bool },
    Edit { ts: u8, n: u8, t: u8 },
    React { who: u8, ts: u8, n: u8, e: u8 },
    Pin { ts: u8, n: u8, on: bool },
}

fn arb_spec() -> impl Strategy<Value = Spec> {
    // Малые пространства значений — чтобы чаще совпадали метки (ничьи).
    prop_oneof![
        (0u8..2, 0u8..3).prop_map(|(from, t)| Spec::Row { from, t }),
        (0u8..4, 0u8..2, any::<bool>()).prop_map(|(ts, n, me)| Spec::Gone { ts, n, me }),
        (0u8..4, 0u8..2, 0u8..3).prop_map(|(ts, n, t)| Spec::Edit { ts, n, t }),
        (0u8..3, 0u8..4, 0u8..2, 0u8..3).prop_map(|(who, ts, n, e)| Spec::React { who, ts, n, e }),
        (0u8..4, 0u8..2, any::<bool>()).prop_map(|(ts, n, on)| Spec::Pin { ts, n, on }),
    ]
}

fn build(s: &Spec) -> HistoryOp {
    let users = [ME, PEER, "carol@x"];
    let texts = ["a", "bb", "ccc"];
    let emojis = ["", "👍", "❤"];
    match *s {
        Spec::Row { from, t } => row(1, users[from as usize], 1_000, texts[t as usize]),
        Spec::Gone { ts, n, me } => gone(1, st(i64::from(ts) * 10, n), if me { GoneScope::Me } else { GoneScope::Everyone }),
        Spec::Edit { ts, n, t } => edit(1, st(i64::from(ts) * 10, n), texts[t as usize]),
        Spec::React { who, ts, n, e } => react(1, users[who as usize], st(i64::from(ts) * 10, n), emojis[e as usize]),
        Spec::Pin { ts, n, on } => pin(1, st(i64::from(ts) * 10, n), on),
    }
}

/// Детерминированный ГПСЧ (xorshift64*) для перестановок внутри случая proptest.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn merge_is_order_repeat_and_split_independent(specs in prop::collection::vec(arb_spec(), 1..14), seed in 1u64..u64::MAX) {
        let ops: Vec<HistoryOp> = specs.iter().map(build).collect();
        let base = fold(&ops.iter().collect::<Vec<_>>()).encode_to_vec();
        let mut rng = Rng(seed);
        for _ in 0..4 {
            // Перестановка с повторами
            let mut idx: Vec<usize> = (0..ops.len()).collect();
            for _ in 0..rng.below(ops.len() + 1) {
                idx.push(rng.below(ops.len()));
            }
            for i in (1..idx.len()).rev() {
                let j = rng.below(i + 1);
                idx.swap(i, j);
            }
            let got = fold(&idx.iter().map(|&i| &ops[i]).collect::<Vec<_>>());
            prop_assert_eq!(&got.encode_to_vec(), &base);
            // Разбиение: две части сводятся отдельно, затем merge в обе стороны
            let cut = 1 + rng.below(idx.len());
            if cut < idx.len() {
                let a = fold(&idx[..cut].iter().map(|&i| &ops[i]).collect::<Vec<_>>());
                let b = fold(&idx[cut..].iter().map(|&i| &ops[i]).collect::<Vec<_>>());
                prop_assert_eq!(&h::merge(&a, &b).unwrap().encode_to_vec(), &base);
                prop_assert_eq!(&h::merge(&b, &a).unwrap().encode_to_vec(), &base);
                // Состояние части как событие (миграция)
                let via_state = h::apply(Some(&b), &HistoryOp { op: Some(Op::State(a)) }).unwrap();
                prop_assert_eq!(&via_state.encode_to_vec(), &base);
            }
        }
        // Идемпотентность и канонизация
        let s = RowState::decode(base.as_slice()).unwrap();
        prop_assert_eq!(&h::merge(&s, &s).unwrap().encode_to_vec(), &base);
        if s.gone.is_some() {
            prop_assert!(s.row.as_ref().is_none_or(|r| r.body.is_empty()) && s.reacts.is_empty() && s.edit_stamp.is_none() && !s.pinned);
        }
    }
}
