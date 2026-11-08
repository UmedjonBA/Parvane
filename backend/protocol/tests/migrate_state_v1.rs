//! spec 035 T097 (US1, FR-063, research.md R9): разовый перенос журнала личного состояния `state.v1` → `state.v2`.
//!
//! - векторы `proto/parvane/vectors/state/merge.json`: операции нового журнала детерминированы (два прогона, в том
//!   числе по старым операциям в другом порядке, — те же байты операций и шифртекста), `Migrated{from_seq}` —
//!   последней, показ нового журнала (`project_v1(State2)`) = снимок старого (`PersonalState::snapshot`) по каждому
//!   объекту;
//! - профиль «всё понемногу» (как у T006: папки с чатами, контакты с заметками, блок-лист, уведомления, черновики,
//!   отложенные и отправленные, архив, закреп, звонки, приглашения, «План», «Облако», «непрочитано», быстрая
//!   реакция, наборы стикеров и свои GIF, очистка чата) — то же;
//! - неотправленные операции старой версии — новыми операциями после `Migrated` (случайный op_id, лампорт выше).
//!
//! Данные выдуманные.

use parvane_protocol::migrate::{audit, state_v1};
use parvane_protocol::pb::parvane::call::v2::HangupReason;
use parvane_protocol::pb::parvane::core::v2::{Ref, UserRef};
use parvane_protocol::pb::parvane::state::v1::{
    self as v1, peer, state_op::Op, BlockEntry, CallRecord, ChatCleared, CloudContainer, Contact, Draft, Folder, FolderOrder, GroupInvite,
    NotifyDefaults, NotifySettings, PackArchive, Peer, PeerKey, PeerNotify, PinnedOrder, PlannerContainer, QuickReaction, ScheduledMessage,
    ScheduledRef, StateOp, StickerPack,
};
use parvane_protocol::pb::parvane::state::v2::{state_op::Op as V2Op, ObjectKind};
use parvane_protocol::state::{PersonalState, StateKey};
use parvane_protocol::state2;
use prost::Message;
use serde_json::Value;

const USER: &str = "alice@local";

fn user(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

fn group(b: u8) -> Peer {
    Peer { kind: Some(peer::Kind::Group(Ref { domain: "local".into(), id: vec![b; 16] })) }
}

fn op(n: u16, lamport: u64, dev: &str, kind: Op) -> StateOp {
    let mut id = vec![0x11u8; 16];
    id[14..].copy_from_slice(&n.to_be_bytes());
    StateOp { op_id: id, lamport, device_id: dev.into(), ts_ms: 1_762_000_000_000 + i64::from(n), op: Some(kind) }
}

fn snap_json(s: &v1::StateSnapshot) -> Value {
    serde_json::to_value(s).unwrap()
}

/// Сводка старых операций и перенос: байты операций, байты шифртекста, снимок старого, показ нового.
fn run(ops: &[StateOp], from_seq: u64, key: &StateKey) -> (Vec<Vec<u8>>, Vec<Vec<u8>>, Value, Value, state2::State2) {
    let c = state_v1::convert(USER, ops, from_seq).expect("перенос");
    let bytes: Vec<Vec<u8>> = c.ops.iter().chain(std::iter::once(&c.migrated)).map(|o| o.encode_to_vec()).collect();
    let sealed: Vec<Vec<u8>> = state_v1::seal_all(key, USER, &c).unwrap().into_iter().map(|a| a.encode_to_vec()).collect();
    let mut all = c.ops.clone();
    all.push(c.migrated.clone());
    let st = state_v1::apply_v2(&all);
    let mut ps = PersonalState::new();
    ps.apply_all(ops);
    (bytes, sealed, snap_json(&ps.snapshot()), snap_json(&state_v1::project_v1(&st)), st)
}

#[test]
fn merge_vectors_migrate_deterministically() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../proto/parvane/vectors/state/merge.json")).unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    let key = StateKey::from_bytes(&[5u8; 32]).unwrap();
    let mut n = 0;
    for case in v["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap_or("?");
        let ops: Vec<StateOp> = case["input"]["ops"].as_array().unwrap().iter().map(|o| serde_json::from_value(o.clone()).unwrap()).collect();
        let (b1, s1, old, new, st) = run(&ops, 17, &key);
        let mut rev = ops.clone();
        rev.reverse();
        let (b2, s2, _, _, _) = run(&rev, 17, &key);
        assert_eq!(b1, b2, "{name}: операции переноса зависят от порядка старых записей");
        assert_eq!(s1, s2, "{name}: шифртекст переноса не детерминирован");
        let last = StateOpV2::decode(b1.last().unwrap().as_slice()).unwrap();
        assert!(matches!(last.op, Some(V2Op::Migrated(ref m)) if m.from_seq == 17), "{name}: последняя — не Migrated");
        assert_eq!(st.migrated_from(), Some(17), "{name}");
        assert_eq!(new, old, "{name}: показ нового журнала ≠ снимку старого");
        if case["expect"]["snapshot"].is_object() {
            assert_eq!(new, case["expect"]["snapshot"], "{name}: снимок вектора");
        }
        n += 1;
    }
    assert!(n >= 10, "векторов мало: {n}");
}

type StateOpV2 = parvane_protocol::pb::parvane::state::v2::StateOp;

/// Профиль «всё понемногу».
fn everything() -> Vec<StateOp> {
    let pack = |set: &str| StickerPack {
        set_id: set.into(),
        r#ref: Some(PackArchive { file_id: "f0".into(), name: "Выдуманный".into(), count: 3, key: vec![1; 32], nonce: vec![2; 24], ..Default::default() }),
        emoji: false,
        added_ms: 1_762_000_000_000,
    };
    vec![
        op(1, 3, "d1", Op::FolderSet(Folder { id: 2, title: "Работа".into(), emoticon: "💼".into(), include_peers: vec![user("zed@local"), user("bob@local"), group(3)], exclude_peers: vec![user("eve@local")], pinned_peers: vec![user("bob@local")], groups: true, color: 4, ..Default::default() })),
        op(2, 4, "d2", Op::FolderSet(Folder { id: 3, title: "Учёба".into(), contacts: true, color: -1, ..Default::default() })),
        op(3, 5, "d1", Op::FolderRemove(v1::FolderRef { id: 3 })),
        op(4, 6, "d1", Op::FolderOrder(FolderOrder { ids: vec![2, 0] })),
        op(5, 2, "d1", Op::BlockSet(BlockEntry { peer: Some(user("mallory@local")), blocked_at_ms: 1_762_000_000_000 })),
        op(6, 2, "d1", Op::NotifySet(PeerNotify { peer: Some(group(3)), settings: Some(NotifySettings { mute_until_ms: Some(i64::MAX), ..Default::default() }) })),
        op(7, 2, "d2", Op::NotifyDefaults(NotifyDefaults { users: Some(NotifySettings { show_previews: Some(false), ..Default::default() }), ..Default::default() })),
        op(8, 7, "d2", Op::DraftSet(Draft { peer: Some(user("bob@local")), text: "черновик".as_bytes().to_vec(), date_ms: 1_762_000_000_500, ..Default::default() })),
        op(9, 8, "d1", Op::ScheduledSet(ScheduledMessage { op_id: vec![0xa1; 16], peer: Some(user("bob@local")), send_at_ms: 1_800_000_000_000, content: vec![0x0a, 0x02, 0x0a, 0x01] })),
        op(10, 8, "d1", Op::ScheduledSet(ScheduledMessage { op_id: vec![0xa2; 16], peer: Some(user("bob@local")), send_at_ms: 1_700_000_000_000, content: vec![0x0a, 0x02, 0x0a, 0x02] })),
        op(11, 9, "d2", Op::ScheduledSent(ScheduledRef { op_id: vec![0xa2; 16] })),
        op(12, 9, "d2", Op::ScheduledSent(ScheduledRef { op_id: vec![0xa3; 16] })),
        op(13, 3, "d1", Op::ArchiveSet(PeerKey { peer: Some(group(4)) })),
        op(14, 3, "d1", Op::PinnedOrder(PinnedOrder { list: 1, peers: vec![user("bob@local"), group(3)] })),
        op(15, 3, "d1", Op::CallSet(CallRecord { call_id: vec![0xc1; 16], peer: Some(user("bob@local")), outgoing: true, video: false, reason: HangupReason::Normal as i32, started_ms: 1_762_000_000_000, duration_s: 61 })),
        op(16, 3, "d1", Op::ChatCleared(ChatCleared { peer: Some(user("carol@local")), cleared_until_ms: 1_762_000_000_123 })),
        op(17, 3, "d1", Op::GroupInviteSet(GroupInvite { group_id: vec![3; 16], link_id: vec![0x1d; 32], url: "https://local/j/x#y".into(), created_ms: 1, title: "Ссылка".into(), ..Default::default() })),
        op(18, 3, "d1", Op::PlannerContainerSet(PlannerContainer { r#ref: Some(Ref { domain: "local".into(), id: vec![0xbb; 16] }) })),
        op(19, 3, "d1", Op::CloudContainerSet(CloudContainer { r#ref: Some(Ref { domain: "local".into(), id: vec![0xcc; 16] }), role: 1, status: 0, removed: false, owner: USER.into() })),
        op(20, 3, "d1", Op::UnreadMarkSet(PeerKey { peer: Some(user("dave@local")) })),
        op(21, 3, "d1", Op::QuickReaction(QuickReaction { emoji: "❤".into(), ..Default::default() })),
        op(22, 3, "d1", Op::StickerPackSet(pack("p:1234"))),
        op(23, 3, "d1", Op::StickerPackSet(pack("g:00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff"))),
        op(24, 3, "d1", Op::ContactSet(Contact { user: Some(UserRef { address: "bob@local".into() }), first_name: "Боб".into(), last_name: "Выдуманный".into(), note: "заметка".into() })),
        op(25, 4, "d2", Op::ContactSet(Contact { user: Some(UserRef { address: "bob@local".into() }), first_name: "Борис".into(), ..Default::default() })),
        op(26, 2, "d2", Op::BlockSet(BlockEntry { peer: Some(user("old@local")), blocked_at_ms: 1 })),
        op(27, 5, "d1", Op::BlockRemove(PeerKey { peer: Some(user("old@local")) })),
    ]
}

#[test]
fn everything_profile_migrates_without_loss() {
    let key = StateKey::from_bytes(&[6u8; 32]).unwrap();
    let ops = everything();
    let (b1, s1, old, new, st) = run(&ops, 27, &key);
    let (b2, s2, _, _, _) = run(&ops, 27, &key);
    assert_eq!((b1, s1), (b2, s2), "два прогона — те же байты");
    assert_eq!(new, old, "показ нового = снимок старого");
    // Выгрузка сверки: строки личного состояния одинаковы «до» и «после»
    let dump = |s: Value| audit::build_values(&audit::ValueSources { state_snapshot: Some(s), account_keys: Value::Object(Default::default()), ..Default::default() });
    let (before, after) = (dump(old.clone()), dump(new));
    let d = audit::diff(&before, &after);
    assert!(d.clean() && d.added.is_empty(), "сверка: {d:?}");
    assert!(before.len() >= 20, "строк мало: {}", before.len());
    // Виды нового журнала: GIF — свой вид, отправленное отложенное — отметкой, очистка — отметкой
    let view = st.view();
    let has = |k: ObjectKind, key: &str| view.iter().any(|o| o.kind == k as i32 && o.key == key);
    assert!(has(ObjectKind::SavedGif, "g:00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff"));
    assert!(has(ObjectKind::StickerPack, "p:1234"));
    assert!(st.is_scheduled_sent(&hex::encode([0xa2u8; 16])) && st.is_scheduled_sent(&hex::encode([0xa3u8; 16])));
    assert!(has(ObjectKind::ChatCleared, "u:carol@local"));
    assert!(!has(ObjectKind::Folder, "3"), "удалённая папка не переносится");
    assert!(!has(ObjectKind::Block, "u:old@local"), "надгробие не переносится");
    assert!(has(ObjectKind::Contact, "bob@local") && has(ObjectKind::GroupInvite, &hex::encode([0x1du8; 32])));
    // Перенос не зависит от устройства: op_id и метка — из ключа объекта
    let c = state_v1::convert(USER, &ops, 27).unwrap();
    assert!(c.ops.iter().all(|o| o.device_id == state_v1::MIGRATE_DEVICE && o.lamport == c.lamport));
    assert_eq!(c.migrated.op_id, state_v1::migrated_op_id(USER).to_vec());
    let other = state_v1::convert("bob@local", &ops, 27).unwrap();
    assert!(c.ops.iter().zip(other.ops.iter()).all(|(a, b)| a.op_id != b.op_id), "op_id привязан к пользователю");
}

#[test]
fn unsent_local_ops_go_after_migrated() {
    let ops = everything();
    let c = state_v1::convert(USER, &ops, 27).unwrap();
    let unsent = vec![
        op(100, 1, "d1", Op::FolderSet(Folder { id: 7, title: "Новая".into(), color: -1, ..Default::default() })),
        op(101, 1, "d1", Op::ArchiveRemove(PeerKey { peer: Some(group(4)) })),
        op(102, 99, "d1", Op::ScheduledSent(ScheduledRef { op_id: vec![0xa1; 16] })),
    ];
    let after = state_v1::unsent_ops(&ops, &unsent, "d1", c.lamport, 0).unwrap();
    assert!(!after.is_empty());
    let migration_ids: Vec<Vec<u8>> = c.ops.iter().map(|o| o.op_id.clone()).collect();
    for o in &after {
        assert!(o.lamport > c.lamport, "лампорт неотправленного выше переноса");
        assert_eq!(o.device_id, "d1");
        assert!(!migration_ids.contains(&o.op_id) && o.op_id != c.migrated.op_id, "op_id неотправленного — свой");
    }
    let mut all = c.ops.clone();
    all.push(c.migrated.clone());
    all.extend(after);
    let st = state_v1::apply_v2(&all);
    let mut ps = PersonalState::new();
    ps.apply_all(&ops);
    // Старое правило: ArchiveRemove с лампортом 1 проигрывает ArchiveSet с лампортом 3 — архив остаётся
    ps.apply_all(&unsent);
    assert_eq!(snap_json(&state_v1::project_v1(&st)), snap_json(&ps.snapshot()));
}
