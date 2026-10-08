//! Векторы личного состояния (T099, правило STATE-1):
//! `proto/parvane/vectors/state/`.
//!
//! - `merge.json` — последовательности операций в разных порядках дают
//!   одинаковый итог (каноничный снимок в proto3-JSON) и одинаковый набор
//!   отвергнутых операций;
//! - `aead.json` — шифрование записей: чужой user/op_id/ключ, порча, подмена
//!   op_id внутри; обёртка ключа StateKeyShare;
//! - `scheduled.json` — «кто отправляет» отложенные и защита от дубля по op_id;
//! - `migration.json` — начальные операции из локального снимка.
//!
//! Плюс property-тесты (proptest): произвольные операции в произвольном
//! порядке, с повторами и порциями → одинаковый снимок.

mod common;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use common::*;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::call::v2::HangupReason;
use parvane_protocol::pb::parvane::core::v2::{Ref, UserRef};
use parvane_protocol::pb::parvane::state::v1::{
    peer, state_op::Op, BlockEntry, CallRecord, CallRef, ChatCleared, Draft, Folder, FolderOrder, FolderRef, NotifyDefaults,
    NotifySettings, Peer, PeerKey, PeerNotify, PinList, PinnedOrder, ScheduledMessage, ScheduledRef, StateKeyShare,
    StateOp, StateSnapshot,
};
use parvane_protocol::state::{self, LamportClock, PersonalState, SendGuard, StateKey};
use proptest::prelude::*;
use prost::Message;
use serde_json::{json, Value};

const USER: &str = "alice@x";

fn user(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

fn group(b: u8) -> Peer {
    Peer { kind: Some(peer::Kind::Group(Ref { domain: "x".into(), id: vec![b; 16] })) }
}

fn pk(p: Peer) -> PeerKey {
    PeerKey { peer: Some(p) }
}

/// Операция с фиксированным op_id (байт `n`, повторённый 16 раз).
fn op(n: u8, lamport: u64, dev: &str, kind: Op) -> StateOp {
    StateOp { op_id: vec![n; 16], lamport, device_id: dev.into(), ts_ms: 1_700_000_000_000, op: Some(kind) }
}

fn folder(id: u32, title: &str, include: Vec<Peer>) -> Folder {
    Folder { id, title: title.into(), emoticon: "💼".into(), include_peers: include, groups: true, color: -1, ..Default::default() }
}

fn sched(n: u8, to: Peer, at: i64) -> ScheduledMessage {
    ScheduledMessage { op_id: vec![0xa0 + n; 16], peer: Some(to), send_at_ms: at, content: vec![0x0a, 0x02, 0x0a, n] }
}

fn snap_json(s: &StateSnapshot) -> Value {
    serde_json::to_value(s).unwrap()
}

fn ops_json(ops: &[StateOp]) -> (Vec<Value>, Vec<String>) {
    (ops.iter().map(|o| serde_json::to_value(o).unwrap()).collect(), ops.iter().map(|o| hexs(&o.encode_to_vec())).collect())
}

/// Порядки применения: все перестановки для n ≤ 5, иначе набор
/// детерминированных перемешиваний.
fn orders(n: usize) -> Vec<Vec<usize>> {
    fn perms(items: Vec<usize>) -> Vec<Vec<usize>> {
        if items.len() <= 1 {
            return vec![items];
        }
        let mut out = vec![];
        for i in 0..items.len() {
            let mut rest = items.clone();
            let x = rest.remove(i);
            for mut p in perms(rest) {
                p.insert(0, x);
                out.push(p);
            }
        }
        out
    }
    let idx: Vec<usize> = (0..n).collect();
    if n <= 5 {
        return perms(idx);
    }
    let mut out = vec![idx.clone(), idx.iter().rev().copied().collect()];
    for r in 1..n {
        let mut v = idx.clone();
        v.rotate_left(r);
        out.push(v);
    }
    out.push(idx.iter().copied().filter(|i| i % 2 == 1).chain(idx.iter().copied().filter(|i| i % 2 == 0)).collect());
    // Повторы: всё дважды, второй раз в обратном порядке.
    out.push(idx.iter().copied().chain(idx.iter().rev().copied()).collect());
    out
}

fn merge_case(name: &str, ops: Vec<StateOp>) -> Value {
    let mut s = PersonalState::new();
    let rejected = s.apply_all(&ops);
    let (ops_j, ops_hex) = ops_json(&ops);
    json!({
        "name": name,
        "input": {"ops": ops_j, "ops_hex": ops_hex, "orders": orders(ops.len())},
        "expect": {"ok": true, "rejected": rejected, "max_lamport": s.max_lamport(), "snapshot": snap_json(&s.snapshot())}
    })
}

fn gen_merge() -> Value {
    let mut cases = vec![];
    cases.push(merge_case(
        "папка: конкурентная правка, ничья лампорта → больший device_id",
        vec![
            op(1, 3, "dev-a", Op::FolderSet(folder(2, "Работа", vec![user("bob@x")]))),
            op(2, 3, "dev-b", Op::FolderSet(folder(2, "Work", vec![user("carol@x")]))),
            op(3, 2, "dev-a", Op::FolderSet(folder(2, "Старое", vec![]))),
        ],
    ));
    cases.push(merge_case(
        "папка: удаление против правки, порядок папок",
        vec![
            op(1, 2, "dev-a", Op::FolderSet(folder(3, "Семья", vec![user("mom@x")]))),
            op(2, 4, "dev-a", Op::FolderRemove(FolderRef { id: 3 })),
            op(3, 3, "dev-b", Op::FolderSet(folder(3, "Семья+", vec![]))),
            op(4, 1, "dev-b", Op::FolderRemove(FolderRef { id: 5 })),
            op(5, 2, "dev-a", Op::FolderSet(folder(5, "Каналы", vec![group(7)]))),
            op(6, 6, "dev-b", Op::FolderOrder(FolderOrder { ids: vec![5, 3] })),
            op(7, 5, "dev-a", Op::FolderOrder(FolderOrder { ids: vec![3, 5] })),
        ],
    ));
    cases.push(merge_case(
        "блок-лист: объединение, снятие, повторная блокировка",
        vec![
            op(1, 1, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("bob@x")), blocked_at_ms: 10 })),
            op(2, 1, "dev-b", Op::BlockSet(BlockEntry { peer: Some(user("carol@x")), blocked_at_ms: 11 })),
            op(3, 2, "dev-b", Op::BlockRemove(pk(user("bob@x")))),
            op(4, 2, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("bob@x")), blocked_at_ms: 12 })),
            op(5, 3, "dev-c", Op::BlockSet(BlockEntry { peer: Some(group(1)), blocked_at_ms: 13 })),
        ],
    ));
    let mute = |until: i64| NotifySettings { mute_until_ms: Some(until), ..Default::default() };
    cases.push(merge_case(
        "уведомления: по собеседнику и умолчания",
        vec![
            op(1, 1, "dev-a", Op::NotifySet(PeerNotify { peer: Some(user("bob@x")), settings: Some(mute(i64::MAX)) })),
            op(2, 3, "dev-b", Op::NotifyRemove(pk(user("bob@x")))),
            op(3, 4, "dev-a", Op::NotifySet(PeerNotify { peer: Some(user("bob@x")), settings: Some(NotifySettings { sound: Some("bell".into()), show_previews: Some(false), ..Default::default() }) })),
            op(4, 2, "dev-a", Op::NotifyDefaults(NotifyDefaults { users: Some(mute(0)), groups: Some(mute(5)), channels: None })),
            op(5, 2, "dev-b", Op::NotifyDefaults(NotifyDefaults { users: None, groups: Some(NotifySettings { silent: Some(true), ..Default::default() }), channels: None })),
            op(6, 1, "dev-c", Op::NotifySet(PeerNotify { peer: Some(group(2)), settings: None })),
        ],
    ));
    cases.push(merge_case(
        "черновики, архив, закреп",
        vec![
            op(1, 1, "dev-a", Op::DraftSet(Draft { peer: Some(user("bob@x")), text: vec![0x0a, 0x03, b'h', b'e', b'y'], reply_to_op_id: vec![9; 16], date_ms: 100 })),
            op(2, 2, "dev-b", Op::DraftRemove(pk(user("bob@x")))),
            op(3, 1, "dev-b", Op::DraftSet(Draft { peer: Some(group(3)), text: vec![0x0a, 0x01, b'x'], reply_to_op_id: vec![], date_ms: 101 })),
            op(4, 1, "dev-a", Op::ArchiveSet(pk(group(3)))),
            op(5, 2, "dev-a", Op::ArchiveRemove(pk(group(3)))),
            op(6, 1, "dev-b", Op::ArchiveSet(pk(user("spam@x")))),
            op(7, 3, "dev-a", Op::PinnedOrder(PinnedOrder { list: PinList::Main as i32, peers: vec![user("bob@x"), group(3)] })),
            op(8, 3, "dev-b", Op::PinnedOrder(PinnedOrder { list: PinList::Main as i32, peers: vec![group(3)] })),
            op(9, 1, "dev-a", Op::PinnedOrder(PinnedOrder { list: PinList::Archive as i32, peers: vec![user("spam@x")] })),
        ],
    ));
    cases.push(merge_case(
        "отложенные: перенос, отмена, отметка отправки необратима",
        vec![
            op(1, 1, "dev-a", Op::ScheduledSet(sched(1, user("bob@x"), 1000))),
            op(2, 2, "dev-b", Op::ScheduledSet(sched(1, user("bob@x"), 2000))),
            op(3, 1, "dev-b", Op::ScheduledSent(ScheduledRef { op_id: vec![0xa1; 16] })),
            op(4, 1, "dev-a", Op::ScheduledSet(sched(2, group(4), 3000))),
            op(5, 3, "dev-a", Op::ScheduledRemove(ScheduledRef { op_id: vec![0xa2; 16] })),
            op(6, 4, "dev-b", Op::ScheduledSet(sched(3, user("carol@x"), 4000))),
        ],
    ));
    let call = |n: u8, p: Peer, reason: HangupReason| CallRecord { call_id: vec![0xc0 + n; 16], peer: Some(p), outgoing: n.is_multiple_of(2), video: n == 2, reason: reason as i32, started_ms: 5000 + i64::from(n), duration_s: u32::from(n) * 10 };
    cases.push(merge_case(
        "история звонков (D-08)",
        vec![
            op(1, 2, "dev-a", Op::CallSet(call(1, user("bob@x"), HangupReason::Normal))),
            op(2, 1, "dev-b", Op::CallRemove(CallRef { call_id: vec![0xc1; 16] })),
            op(3, 1, "dev-b", Op::CallSet(call(2, user("carol@x"), HangupReason::Missed))),
            op(4, 5, "dev-a", Op::CallRemove(CallRef { call_id: vec![0xc2; 16] })),
            op(5, 3, "dev-a", Op::CallSet(call(3, group(5), HangupReason::Declined))),
        ],
    ));
    cases.push(merge_case(
        "повторы записей и одинаковый op_id с разным содержимым",
        vec![
            op(1, 1, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("bob@x")), blocked_at_ms: 1 })),
            op(1, 1, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("bob@x")), blocked_at_ms: 1 })),
            op(2, 5, "dev-a", Op::FolderSet(folder(9, "A", vec![]))),
            op(2, 5, "dev-a", Op::FolderSet(folder(9, "B", vec![]))),
            op(3, 7, "dev-b", Op::ScheduledSent(ScheduledRef { op_id: vec![0xa9; 16] })),
            op(3, 7, "dev-b", Op::ScheduledSent(ScheduledRef { op_id: vec![0xa9; 16] })),
        ],
    ));
    cases.push(merge_case(
        "ничья (lamport, device_id) → больший op_id; надгробие в ничьей; больший device_id не спасает меньший лампорт",
        vec![
            op(1, 4, "dev-a", Op::DraftSet(Draft { peer: Some(user("bob@x")), text: vec![0x0a, 0x01, b'a'], reply_to_op_id: vec![], date_ms: 1 })),
            op(2, 4, "dev-a", Op::DraftSet(Draft { peer: Some(user("bob@x")), text: vec![0x0a, 0x01, b'b'], reply_to_op_id: vec![], date_ms: 2 })),
            op(3, 4, "dev-a", Op::DraftRemove(pk(group(6)))),
            op(4, 4, "dev-a", Op::DraftSet(Draft { peer: Some(group(6)), text: vec![0x0a, 0x01, b'c'], reply_to_op_id: vec![], date_ms: 3 })),
            op(5, 3, "dev-z", Op::DraftRemove(pk(user("bob@x")))),
        ],
    ));
    cases.push(merge_case(
        "надгробие раньше записи, воскрешение большей меткой; ничья регистра → больший op_id",
        vec![
            op(1, 5, "dev-b", Op::BlockRemove(pk(user("carol@x")))),
            op(2, 4, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("carol@x")), blocked_at_ms: 20 })),
            op(3, 6, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("carol@x")), blocked_at_ms: 21 })),
            op(4, 2, "dev-a", Op::FolderOrder(FolderOrder { ids: vec![7] })),
            op(5, 2, "dev-a", Op::FolderOrder(FolderOrder { ids: vec![8] })),
        ],
    ));
    let mut unknown = op(5, 9, "dev-c", Op::FolderRemove(FolderRef { id: 4 }));
    unknown.op = None;
    cases.push(merge_case(
        "некорректные операции отвергаются одинаково; неизвестный вид — пропуск",
        vec![
            op(1, 1, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("not an address")), blocked_at_ms: 1 })),
            op(2, 0, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("bob@x")), blocked_at_ms: 1 })),
            op(3, 1, "dev-a", Op::FolderSet(folder(1, "Архив", vec![]))),
            op(4, 1, "dev-a", Op::PinnedOrder(PinnedOrder { list: PinList::Unspecified as i32, peers: vec![] })),
            unknown,
            op(6, 2, "dev a", Op::ArchiveSet(pk(user("bob@x")))),
            op(7, 1 << 53, "dev-a", Op::ArchiveSet(pk(user("bob@x")))),
            op(8, 2, "dev-b", Op::ArchiveSet(pk(user("bob@x")))),
        ],
    ));
    cases.push(merge_case(
        "чат очищен «у себя»: граница по собеседнику только растёт, поздняя метка с меньшей границей её не откатывает",
        vec![
            op(1, 1, "dev-a", Op::ChatCleared(ChatCleared { peer: Some(user("bob@x")), cleared_until_ms: 5_000 })),
            op(2, 9, "dev-b", Op::ChatCleared(ChatCleared { peer: Some(user("bob@x")), cleared_until_ms: 3_000 })),
            op(3, 2, "dev-a", Op::ChatCleared(ChatCleared { peer: Some(group(7)), cleared_until_ms: 1 })),
            op(4, 3, "dev-a", Op::ChatCleared(ChatCleared { peer: Some(user("bob@x")), cleared_until_ms: 0 })),
            op(5, 4, "dev-b", Op::ChatCleared(ChatCleared { peer: None, cleared_until_ms: 9 })),
        ],
    ));
    json!({
        "suite": "state",
        "description": "STATE-1: сведение личного состояния LWW (lamport, device_id, op_id, sha256(операции)); каждый порядок из orders (индексы в ops_hex, возможны повторы) даёт тот же snapshot и тот же набор отвергнутых индексов",
        "cases": cases
    })
}

#[test]
fn state_merge_vectors() {
    let v = load_or_generate("state", "merge.json", gen_merge);
    for case in cases(&v) {
        let name = case["name"].as_str().unwrap();
        let ops: Vec<StateOp> = case["input"]["ops_hex"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| decode_checked(&hex::decode(h.as_str().unwrap()).unwrap(), Origin::Client).unwrap())
            .collect();
        let (ops_j, _) = ops_json(&ops);
        assert_eq!(Value::from(ops_j), case["input"]["ops"], "{name}: ops ↔ ops_hex");
        let expect_rejected: Vec<usize> =
            case["expect"]["rejected"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect();
        for order in case["input"]["orders"].as_array().unwrap() {
            let order: Vec<usize> = order.as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect();
            let mut s = PersonalState::new();
            let mut rejected = std::collections::BTreeSet::new();
            for &i in &order {
                if s.apply(&ops[i]).is_err() {
                    rejected.insert(i);
                }
            }
            assert_eq!(rejected.into_iter().collect::<Vec<_>>(), expect_rejected, "{name}: отвергнутые при порядке {order:?}");
            assert_eq!(snap_json(&s.snapshot()), case["expect"]["snapshot"], "{name}: снимок при порядке {order:?}");
            assert_eq!(s.max_lamport(), case["expect"]["max_lamport"].as_u64().unwrap(), "{name}: max_lamport");
        }
    }
}

// ---------------------------------------------------------------------------

const KEY: [u8; 32] = [0x42; 32];

fn raw_seal(user: &str, record_op_id: &[u8], plaintext: &[u8], nonce: [u8; 12]) -> Vec<u8> {
    let aad = state::record_aad(user, record_op_id);
    let ct = ChaCha20Poly1305::new(Key::from_slice(&KEY))
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
        .unwrap();
    [nonce.to_vec(), ct].concat()
}

fn gen_aead() -> Value {
    let o = op(1, 7, "dev-a", Op::BlockSet(BlockEntry { peer: Some(user("bob@x")), blocked_at_ms: 42 }));
    let good = raw_seal(USER, &o.op_id, &o.encode_to_vec(), [7; 12]);
    let mut flipped = good.clone();
    let last = flipped.len() - 1;
    flipped[last] ^= 1;
    let other_id = vec![2u8; 16];
    // Внутри op_id = 1…, запись (и AAD) — под op_id 2…: ключ верный, тег сходится.
    let swapped = raw_seal(USER, &other_id, &o.encode_to_vec(), [8; 12]);
    let mut zero_lamport = o.clone();
    zero_lamport.lamport = 0;
    let bad_header = raw_seal(USER, &o.op_id, &zero_lamport.encode_to_vec(), [9; 12]);
    let rec = |name: &str, user: &str, op_id: &[u8], ct: &[u8], expect: Value| {
        json!({"name": name, "input": {"user": user, "op_id_hex": hexs(op_id), "aead_hex": hexs(ct)}, "expect": expect})
    };
    let mut ok_op = ok();
    ok_op["op_hex"] = json!(hexs(&o.encode_to_vec()));
    let share = StateKeyShare { user: Some(UserRef { address: USER.into() }), state_key: KEY.to_vec(), key_version: 3 };
    let short = StateKeyShare { state_key: vec![0x42; 31], ..share.clone() };
    json!({
        "suite": "state",
        "description": "записи журнала состояния: aead = nonce(12) ‖ ChaCha20-Poly1305(StateOp), AAD = \"parvane/v2/state\\0\" ‖ user ‖ op_id; обёртка ключа StateKeyShare",
        "key_hex": hexs(&KEY),
        "cases": [
            rec("верная запись", USER, &o.op_id, &good, ok_op),
            rec("чужой журнал (другой user в AAD)", "eve@x", &o.op_id, &good, err("Crypto")),
            rec("перенос под другой op_id", USER, &other_id, &good, err("Crypto")),
            rec("порча тега", USER, &o.op_id, &flipped, err("Crypto")),
            rec("короче nonce+тега", USER, &o.op_id, &good[..20], err("Crypto")),
            rec("op_id внутри не совпадает с записью", USER, &other_id, &swapped, err("ContextMismatch")),
            rec("lamport = 0", USER, &o.op_id, &bad_header, err("InvalidField")),
            rec("op_id записи не 16 байт", USER, &o.op_id[..8], &good, err("InvalidField")),
        ],
        "key_share_cases": [
            {"name": "своя обёртка", "input": {"expected_user": USER, "share_hex": hexs(&share.encode_to_vec())}, "expect": {"ok": true, "key_version": 3}},
            {"name": "обёртка чужого аккаунта", "input": {"expected_user": "bob@x", "share_hex": hexs(&share.encode_to_vec())}, "expect": err("ContextMismatch")},
            {"name": "ключ 31 байт", "input": {"expected_user": USER, "share_hex": hexs(&short.encode_to_vec())}, "expect": err("InvalidField")}
        ]
    })
}

#[test]
fn state_aead_vectors() {
    let v = load_or_generate("state", "aead.json", gen_aead);
    let key = StateKey::from_bytes(&unhex(&v, "key_hex")).unwrap();
    for case in cases(&v) {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let r = state::open_record(&key, i["user"].as_str().unwrap(), &unhex(i, "op_id_hex"), &unhex(i, "aead_hex"));
        check(name, &r, &case["expect"]);
        if let Ok(op) = r {
            assert_eq!(hexs(&op.encode_to_vec()), case["expect"]["op_hex"].as_str().unwrap(), "{name}");
        }
    }
    for case in v["key_share_cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let share: StateKeyShare = decode_checked(&unhex(&case["input"], "share_hex"), Origin::Client).unwrap();
        let r = StateKey::from_share(&share, case["input"]["expected_user"].as_str().unwrap());
        check(name, &r, &case["expect"]);
        if let Ok((k, ver)) = r {
            assert_eq!(k.as_bytes(), &KEY);
            assert_eq!(u64::from(ver), case["expect"]["key_version"].as_u64().unwrap());
        }
    }
    // Свежая запись движка открывается (nonce случайный — только круговая проверка).
    let o = op(4, 9, "dev-z", Op::ArchiveSet(pk(group(8))));
    let rec = state::seal_op(&key, USER, &o).unwrap();
    assert_eq!(rec.aead_ciphertext.len(), state::NONCE_LEN + o.encoded_len() + state::TAG_LEN);
    assert_eq!(state::open_record(&key, USER, &rec.op_id, &rec.aead_ciphertext).unwrap(), o);
}

#[test]
fn state_seal_rejects_oversized() {
    let key = StateKey::from_bytes(&KEY).unwrap();
    let mut s = sched(1, user("bob@x"), 1);
    s.content = vec![1; 262_144];
    let o = op(1, 1, "dev-a", Op::ScheduledSet(s));
    assert_eq!(state::seal_op(&key, USER, &o).unwrap_err().kind(), "FieldLimit");
}

// ---------------------------------------------------------------------------

fn gen_scheduled() -> Value {
    let ops = vec![
        op(1, 1, "dev-a", Op::ScheduledSet(sched(1, user("bob@x"), 1000))),
        op(2, 1, "dev-a", Op::ScheduledSet(sched(2, user("bob@x"), 500))),
        op(3, 2, "dev-b", Op::ScheduledSet(sched(3, group(1), 5000))),
        op(4, 3, "dev-b", Op::ScheduledSent(ScheduledRef { op_id: vec![0xa2; 16] })),
        op(5, 1, "dev-a", Op::ScheduledSet(sched(4, user("carol@x"), 900))),
        op(6, 4, "dev-a", Op::ScheduledRemove(ScheduledRef { op_id: vec![0xa4; 16] })),
    ];
    let (_, ops_hex) = ops_json(&ops);
    let ids = |v: &[u8]| v.iter().map(|b| hexs(&[*b; 16])).collect::<Vec<_>>();
    json!({
        "suite": "state",
        "description": "отложенные: отправляет устройство, заметившее срок; отмеченные scheduled_sent и уже отправленные этим устройством (guard) не отправляются; порядок — (send_at_ms, op_id)",
        "ops_hex": ops_hex,
        "cases": [
            {"name": "срок ещё не наступил", "input": {"now_ms": 499, "guard_hex": []}, "expect": {"ok": true, "send": [], "second_call": []}},
            {"name": "одно к отправке (второе отмечено отправленным, третье отменено)", "input": {"now_ms": 1000, "guard_hex": []}, "expect": {"ok": true, "send": ids(&[0xa1]), "second_call": []}},
            {"name": "устройство уже отправляло этот op_id", "input": {"now_ms": 1000, "guard_hex": ids(&[0xa1])}, "expect": {"ok": true, "send": [], "second_call": []}},
            {"name": "все сроки", "input": {"now_ms": 10000, "guard_hex": []}, "expect": {"ok": true, "send": ids(&[0xa1, 0xa3]), "second_call": []}}
        ]
    })
}

#[test]
fn state_scheduled_vectors() {
    let v = load_or_generate("state", "scheduled.json", gen_scheduled);
    let mut s = PersonalState::new();
    for h in v["ops_hex"].as_array().unwrap() {
        let o: StateOp = decode_checked(&hex::decode(h.as_str().unwrap()).unwrap(), Origin::Client).unwrap();
        s.apply(&o).unwrap();
    }
    for case in cases(&v) {
        let name = case["name"].as_str().unwrap();
        let guard_ids: Vec<Vec<u8>> =
            case["input"]["guard_hex"].as_array().unwrap().iter().map(|h| hex::decode(h.as_str().unwrap()).unwrap()).collect();
        let mut guard = SendGuard::from_list(guard_ids.iter().map(Vec::as_slice));
        let now = case["input"]["now_ms"].as_i64().unwrap();
        let send: Vec<String> = s.claim_due(now, &mut guard).iter().map(|m| hexs(&m.op_id)).collect();
        assert_eq!(json!(send), case["expect"]["send"], "{name}");
        let again: Vec<String> = s.claim_due(now, &mut guard).iter().map(|m| hexs(&m.op_id)).collect();
        assert_eq!(json!(again), case["expect"]["second_call"], "{name}: повтор");
    }
    // Два устройства с разными guard оба могут заметить срок — сообщение
    // уходит с одним op_id, дубль отсекается получателем; после scheduled_sent
    // ни одно больше не отправляет.
    let (mut ga, mut gb) = (SendGuard::new(), SendGuard::new());
    let a = s.claim_due(10_000, &mut ga);
    let b = s.claim_due(10_000, &mut gb);
    assert_eq!(a.iter().map(|m| &m.op_id).collect::<Vec<_>>(), b.iter().map(|m| &m.op_id).collect::<Vec<_>>());
    let mut clock = LamportClock::new(s.max_lamport());
    for m in &a {
        let sent = state::make_op(&mut clock, "dev-a", 0, Op::ScheduledSent(ScheduledRef { op_id: m.op_id.clone() })).unwrap();
        s.apply(&sent).unwrap();
        assert!(s.is_scheduled_sent(&m.op_id));
    }
    assert!(s.claim_due(10_000, &mut SendGuard::new()).is_empty());
}

// ---------------------------------------------------------------------------

fn counter_ids() -> impl FnMut() -> [u8; 16] {
    let mut n: u128 = 0;
    move || {
        n += 1;
        n.to_be_bytes()
    }
}

fn gen_migration() -> Value {
    let local = StateSnapshot {
        folders: vec![folder(4, "Работа", vec![user("boss@x")]), folder(1, "зарезервирован — пропуск", vec![])],
        folder_order: Some(FolderOrder { ids: vec![4] }),
        blocked: vec![
            BlockEntry { peer: Some(user("spam@x")), blocked_at_ms: 1 },
            BlockEntry { peer: Some(user("испорченный")), blocked_at_ms: 2 },
        ],
        notify: vec![PeerNotify { peer: Some(group(2)), settings: Some(NotifySettings { mute_until_ms: Some(i64::MAX), ..Default::default() }) }],
        notify_defaults: Some(NotifyDefaults { users: Some(NotifySettings { show_previews: Some(true), ..Default::default() }), ..Default::default() }),
        drafts: vec![Draft { peer: Some(user("bob@x")), text: vec![0x0a, 0x02, b'h', b'i'], reply_to_op_id: vec![], date_ms: 5 }],
        scheduled: vec![sched(1, user("bob@x"), 777)],
        scheduled_sent: vec![],
        archived: vec![user("old@x")],
        pinned: vec![PinnedOrder { list: PinList::Main as i32, peers: vec![user("bob@x")] }],
        calls: vec![CallRecord { call_id: vec![0xc1; 16], peer: Some(user("bob@x")), outgoing: true, video: false, reason: HangupReason::Normal as i32, started_ms: 1, duration_s: 60 }],
        cleared: vec![],
        invites: vec![],
            planner_container: None,
    };
    let mut clock = LamportClock::new(10);
    let ops = state::migrate_snapshot_with(&local, "dev-m", &mut clock, 0, counter_ids()).unwrap();
    let mut s = PersonalState::new();
    assert!(s.apply_all(&ops).is_empty());
    let (_, ops_hex) = ops_json(&ops);
    json!({
        "suite": "state",
        "description": "миграция: локальный снимок v1 (proto3-JSON StateSnapshot) → начальные операции устройства dev-m с часов 10 и op_id = счётчик 1,2,… (u128 big-endian); испорченные записи пропускаются",
        "cases": [{
            "name": "локальные папки/блок-лист/уведомления/черновики/отложенные/архив/закреп/звонки",
            "input": {"device_id": "dev-m", "clock": 10, "local": snap_json(&local)},
            "expect": {"ok": true, "ops_hex": ops_hex, "clock": clock.last(), "snapshot": snap_json(&s.snapshot())}
        }]
    })
}

#[test]
fn state_migration_vectors() {
    let v = load_or_generate("state", "migration.json", gen_migration);
    for case in cases(&v) {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let local: StateSnapshot = serde_json::from_value(i["local"].clone()).unwrap();
        let mut clock = LamportClock::new(i["clock"].as_u64().unwrap());
        let ops = state::migrate_snapshot_with(&local, i["device_id"].as_str().unwrap(), &mut clock, 0, counter_ids()).unwrap();
        let (_, ops_hex) = ops_json(&ops);
        assert_eq!(json!(ops_hex), case["expect"]["ops_hex"], "{name}: операции");
        assert_eq!(clock.last(), case["expect"]["clock"].as_u64().unwrap(), "{name}: часы");
        let mut s = PersonalState::new();
        assert!(s.apply_all(&ops).is_empty());
        assert_eq!(snap_json(&s.snapshot()), case["expect"]["snapshot"], "{name}: снимок");
        // Повторная миграция на другом устройстве сходится с первой.
        let mut clock2 = LamportClock::default();
        let ops2 = state::migrate_snapshot(&local, "dev-n", &mut clock2, 0).unwrap();
        let mut s2 = PersonalState::new();
        s2.apply_all(&ops2);
        s2.apply_all(&ops);
        assert_eq!(snap_json(&s2.snapshot()), case["expect"]["snapshot"], "{name}: две миграции");
    }
}

// ---------------------------------------------------------------------------
// Property-тесты STATE-1.

fn arb_peer() -> impl Strategy<Value = Peer> {
    prop_oneof![
        prop::sample::select(vec!["bob@x", "carol@x", "dave@y"]).prop_map(user),
        (1u8..4).prop_map(group),
    ]
}

fn arb_kind() -> impl Strategy<Value = Op> {
    let id16 = (1u8..5).prop_map(|b| vec![b; 16]);
    prop_oneof![
        (2u32..5, "[a-c]{0,3}", prop::collection::vec(arb_peer(), 0..3))
            .prop_map(|(id, t, inc)| Op::FolderSet(folder(id, &t, inc))),
        (0u32..5).prop_map(|id| Op::FolderRemove(FolderRef { id })),
        prop::collection::vec(0u32..6, 0..4).prop_map(|ids| Op::FolderOrder(FolderOrder { ids })),
        (arb_peer(), 0i64..3).prop_map(|(p, t)| Op::BlockSet(BlockEntry { peer: Some(p), blocked_at_ms: t })),
        arb_peer().prop_map(|p| Op::BlockRemove(pk(p))),
        (arb_peer(), prop::option::of(0i64..3)).prop_map(|(p, m)| Op::NotifySet(PeerNotify {
            peer: Some(p),
            settings: Some(NotifySettings { mute_until_ms: m, ..Default::default() })
        })),
        arb_peer().prop_map(|p| Op::NotifyRemove(pk(p))),
        (0i64..3).prop_map(|m| Op::NotifyDefaults(NotifyDefaults {
            users: Some(NotifySettings { mute_until_ms: Some(m), ..Default::default() }),
            ..Default::default()
        })),
        (arb_peer(), prop::collection::vec(any::<u8>(), 0..4)).prop_map(|(p, t)| Op::DraftSet(Draft { peer: Some(p), text: t, reply_to_op_id: vec![], date_ms: 0 })),
        arb_peer().prop_map(|p| Op::DraftRemove(pk(p))),
        (1u8..5, arb_peer(), 1i64..4).prop_map(|(n, p, at)| Op::ScheduledSet(sched(n, p, at))),
        id16.clone().prop_map(|b| Op::ScheduledRemove(ScheduledRef { op_id: b.iter().map(|x| x + 0xa0).collect() })),
        id16.clone().prop_map(|b| Op::ScheduledSent(ScheduledRef { op_id: b.iter().map(|x| x + 0xa0).collect() })),
        arb_peer().prop_map(|p| Op::ArchiveSet(pk(p))),
        arb_peer().prop_map(|p| Op::ArchiveRemove(pk(p))),
        (0i32..3, prop::collection::vec(arb_peer(), 0..3)).prop_map(|(l, peers)| Op::PinnedOrder(PinnedOrder { list: l, peers })),
        (id16.clone(), arb_peer()).prop_map(|(c, p)| Op::CallSet(CallRecord { call_id: c, peer: Some(p), ..Default::default() })),
        id16.prop_map(|c| Op::CallRemove(CallRef { call_id: c })),
        (arb_peer(), 0i64..4).prop_map(|(p, t)| Op::ChatCleared(ChatCleared { peer: Some(p), cleared_until_ms: t })),
    ]
}

fn arb_op() -> impl Strategy<Value = StateOp> {
    // Малые алфавиты меток — чтобы ничьи лампорта и совпадения op_id
    // встречались часто.
    (0u8..6, 0u64..5, prop::sample::select(vec!["dev-a", "dev-b", "dev-c"]), arb_kind())
        .prop_map(|(n, l, d, k)| op(n, l, d, k))
}

fn snapshot_of(ops: &[&StateOp]) -> (Vec<u8>, u64) {
    let mut s = PersonalState::new();
    for o in ops {
        let _ = s.apply(o);
    }
    (s.snapshot().encode_to_vec(), s.max_lamport())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Любая перестановка, повторы и разбиение на порции дают тот же снимок.
    #[test]
    fn merge_is_order_independent(
        ops in prop::collection::vec(arb_op(), 0..24),
        perm in any::<prop::sample::Index>(),
        dups in prop::collection::vec(any::<prop::sample::Index>(), 0..8),
        split in any::<prop::sample::Index>(),
    ) {
        let base: Vec<&StateOp> = ops.iter().collect();
        let expect = snapshot_of(&base);

        // Перестановка: детерминированное перемешивание по индексу.
        let mut shuffled = base.clone();
        if !shuffled.is_empty() {
            let mut seed = perm.index(usize::MAX / 2) as u64 | 1;
            for i in (1..shuffled.len()).rev() {
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                shuffled.swap(i, (seed % (i as u64 + 1)) as usize);
            }
        }
        prop_assert_eq!(&snapshot_of(&shuffled), &expect);

        // Повторы произвольных записей в произвольных местах.
        let mut with_dups = shuffled.clone();
        if !base.is_empty() {
            for d in &dups {
                let o = base[d.index(base.len())];
                let at = d.index(with_dups.len() + 1);
                with_dups.insert(at, o);
            }
        }
        prop_assert_eq!(&snapshot_of(&with_dups), &expect);

        // Два устройства получают разные половины, затем обмениваются.
        let cut = split.index(base.len() + 1);
        let mut a = PersonalState::new();
        let mut b = PersonalState::new();
        for o in &base[..cut] { let _ = a.apply(o); }
        for o in &base[cut..] { let _ = b.apply(o); }
        for o in &base[cut..] { let _ = a.apply(o); }
        for o in base[..cut].iter().rev() { let _ = b.apply(o); }
        prop_assert_eq!(a.snapshot().encode_to_vec(), expect.0.clone());
        prop_assert_eq!(b.snapshot().encode_to_vec(), expect.0);
    }

    /// Миграция снимка сведённого состояния воспроизводит его же.
    #[test]
    fn migration_roundtrip(ops in prop::collection::vec(arb_op(), 0..24)) {
        let mut s = PersonalState::new();
        s.apply_all(&ops);
        let snap = s.snapshot();
        let mut clock = LamportClock::new(s.max_lamport());
        let migrated = state::migrate_snapshot_with(&snap, "dev-m", &mut clock, 0, counter_ids()).unwrap();
        let mut t = PersonalState::new();
        prop_assert!(t.apply_all(&migrated).is_empty());
        prop_assert_eq!(t.snapshot(), snap);
    }

    /// Шифрование записи обратимо и привязано к user/op_id.
    #[test]
    fn seal_open_roundtrip(o in arb_op()) {
        let key = StateKey::from_bytes(&KEY).unwrap();
        let mut o = o;
        o.lamport = o.lamport.max(1);
        let rec = state::seal_op(&key, USER, &o).unwrap();
        prop_assert_eq!(state::open_record(&key, USER, &rec.op_id, &rec.aead_ciphertext).unwrap(), o);
        prop_assert!(state::open_record(&key, "bob@x", &rec.op_id, &rec.aead_ciphertext).is_err());
    }
}
