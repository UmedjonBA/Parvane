//! Домен облака `cloud.v1` (spec 016): сведение дерева не зависит от порядка
//! применения, снимок ему достаточен, циклов и потерянных узлов нет.

use std::collections::BTreeMap;
use std::time::Instant;

use prost::Message;
use proptest::prelude::*;

use parvane_protocol::domain::cloud::{self, CloudState, NodeId, ViewNode};
use parvane_protocol::domain::cloud_json;
use parvane_protocol::domain::{LamportGuard, Stamp, MAX_SNAPSHOT_PLAINTEXT};
use parvane_protocol::pb::parvane::cloud::v1::{
    cloud_op, CloudBatch, CloudBlobRef, CloudCreate, CloudMeta, CloudMove, CloudNodeKind, CloudOp, CloudPurge, CloudSetBlob, CloudThumb,
    CloudTrash,
};

fn id(n: u8) -> Vec<u8> {
    vec![n; 16]
}

fn nid(n: u8) -> NodeId {
    [n; 16]
}

fn pid(p: Option<u8>) -> Vec<u8> {
    p.map(id).unwrap_or_default()
}

fn stamp(l: u64, dev: &str) -> Option<parvane_protocol::pb::parvane::core::v2::LwwStamp> {
    Some(Stamp::new(l, dev).to_pb())
}

fn blob(file: &str) -> CloudBlobRef {
    CloudBlobRef {
        file_id: file.into(),
        key: vec![1; 32],
        size: 10,
        chunks: 1,
        mime: "text/plain".into(),
        sha256: vec![2; 32],
        nonce: vec![3; 12],
        capability: vec![4; 32],
        uploader: "alice@local".into(),
    }
}

fn wrap(op: cloud_op::Op) -> CloudOp {
    CloudOp { op: Some(op) }
}

fn folder(n: u8, parent: Option<u8>, name: &str, l: u64, dev: &str) -> CloudOp {
    wrap(cloud_op::Op::Create(CloudCreate {
        node_id: id(n),
        kind: CloudNodeKind::Folder as i32,
        parent_id: pid(parent),
        name: name.into(),
        stamp: stamp(l, dev),
        ..Default::default()
    }))
}

fn file(n: u8, parent: Option<u8>, name: &str, l: u64, dev: &str) -> CloudOp {
    wrap(cloud_op::Op::Create(CloudCreate {
        node_id: id(n),
        kind: CloudNodeKind::File as i32,
        parent_id: pid(parent),
        name: name.into(),
        blob: Some(blob(&format!("f{n}"))),
        stamp: stamp(l, dev),
        thumb: None,
        mtime_ms: 1,
        from: String::new(),
    }))
}

fn mv(n: u8, parent: Option<u8>, name: &str, l: u64, dev: &str) -> CloudOp {
    wrap(cloud_op::Op::Move(CloudMove { node_id: id(n), parent_id: pid(parent), name: name.into(), stamp: stamp(l, dev) }))
}

fn trash(n: u8, trashed: bool, l: u64, dev: &str) -> CloudOp {
    wrap(cloud_op::Op::Trash(CloudTrash { node_id: id(n), trashed, at_ms: l * 10, stamp: stamp(l, dev) }))
}

fn purge(n: u8, l: u64, dev: &str) -> CloudOp {
    wrap(cloud_op::Op::Purge(CloudPurge { node_id: id(n), at_ms: l * 10, stamp: stamp(l, dev) }))
}

fn apply_all(ops: &[CloudOp]) -> CloudState {
    let mut st = CloudState::default();
    for op in ops {
        st.apply(op).unwrap();
    }
    st
}

fn by_id(view: &[ViewNode]) -> BTreeMap<NodeId, ViewNode> {
    view.iter().map(|n| (n.id, n.clone())).collect()
}

/// У каждого узла конечный путь до корня, родитель — видимая папка.
fn assert_tree(view: &[ViewNode]) {
    let map = by_id(view);
    for n in view {
        let mut cur = n.parent;
        let mut steps = 0;
        while let Some(p) = cur {
            let parent = map.get(&p).unwrap_or_else(|| panic!("родитель {p:?} узла {:?} не виден", n.id));
            assert_eq!(parent.kind, CloudNodeKind::Folder);
            cur = parent.parent;
            steps += 1;
            assert!(steps <= view.len(), "цикл у узла {:?}", n.id);
        }
    }
}

#[test]
fn mutual_moves_do_not_make_a_cycle_and_lose_nothing() {
    let base = [folder(1, None, "A", 1, "d"), folder(2, None, "B", 2, "d"), file(3, Some(1), "x.txt", 3, "d")];
    // Одновременно: A → внутрь B и B → внутрь A.
    let x = mv(1, Some(2), "A", 4, "d1");
    let y = mv(2, Some(1), "B", 4, "d2");
    let s1 = apply_all(&[&base[..], &[x.clone(), y.clone()]].concat());
    let s2 = apply_all(&[&[y, x][..], &base[..]].concat());
    assert_eq!(s1, s2);
    let view = s1.view();
    assert_tree(&view);
    let map = by_id(&view);
    assert_eq!(view.len(), 3);
    // Метка (4,"d2") больше: B показывается в корне, A остаётся внутри B.
    assert_eq!(map[&nid(2)].parent, None);
    assert_eq!(map[&nid(1)].parent, Some(nid(2)));
    assert_eq!(map[&nid(3)].parent, Some(nid(1)));
}

#[test]
fn orphan_and_non_folder_parent_show_in_root() {
    let st = apply_all(&[
        file(1, None, "a.txt", 1, "d"),
        // Родитель — файл, неизвестный узел, сам узел.
        file(2, Some(1), "b.txt", 2, "d"),
        folder(3, Some(9), "C", 3, "d"),
        folder(4, None, "D", 4, "d"),
        mv(4, Some(4), "D", 5, "d"),
    ]);
    let view = st.view();
    assert_tree(&view);
    assert!(view.iter().all(|n| n.parent.is_none()));
    assert_eq!(view.len(), 4);
}

#[test]
fn trash_restore_and_purge() {
    let mut st = apply_all(&[
        folder(1, None, "A", 1, "d"),
        folder(2, Some(1), "B", 2, "d"),
        file(3, Some(2), "x.txt", 3, "d"),
        file(4, None, "y.txt", 4, "d"),
        trash(1, true, 5, "d"),
    ]);
    let map = by_id(&st.view());
    // В корзине папка со всем содержимым; положена именно она.
    assert!(map[&nid(1)].trashed && map[&nid(1)].trash_top);
    assert!(map[&nid(3)].trashed && !map[&nid(3)].trash_top);
    assert_eq!(map[&nid(3)].trashed_at_ms, 50);
    assert!(!map[&nid(4)].trashed);
    // Восстановление более новой меткой; старая метка корзины не возвращает.
    st.apply(&trash(1, false, 6, "d")).unwrap();
    st.apply(&trash(1, true, 5, "e")).unwrap();
    assert!(st.view().iter().all(|n| !n.trashed));
    // Окончательное удаление папки стирает потомков и необратимо.
    st.apply(&purge(2, 7, "d")).unwrap();
    st.apply(&trash(2, false, 9, "d")).unwrap();
    st.apply(&mv(3, None, "x.txt", 9, "d")).unwrap();
    let view = st.view();
    let ids: Vec<NodeId> = view.iter().map(|n| n.id).collect();
    // Файл, вынесенный из стёртой папки более новой меткой, жив: стёрта папка, а не он.
    assert_eq!(ids, vec![nid(1), nid(3), nid(4)]);
    assert!(st.purged_blobs().is_empty());
    st.apply(&purge(3, 10, "d")).unwrap();
    assert_eq!(st.purged_blobs().iter().map(|b| b.file_id.as_str()).collect::<Vec<_>>(), vec!["f3"]);
    assert_eq!(st.live_count(), 2);
}

#[test]
fn purged_folder_takes_descendants_and_reports_their_blobs() {
    let st = apply_all(&[
        folder(1, None, "A", 1, "d"),
        wrap(cloud_op::Op::Create(CloudCreate {
            node_id: id(2),
            kind: CloudNodeKind::File as i32,
            parent_id: id(1),
            name: "p.jpg".into(),
            blob: Some(blob("f2")),
            stamp: stamp(2, "d"),
            thumb: Some(CloudThumb { file_id: "t2".into(), nonce: vec![5; 12], capability: vec![6; 32], width: 10, height: 10 }),
            mtime_ms: 3,
            from: String::new(),
        })),
        purge(1, 3, "d"),
    ]);
    assert!(st.view().is_empty());
    assert_eq!(st.purged_blobs().iter().map(|b| b.file_id.as_str()).collect::<Vec<_>>(), vec!["f2", "t2"]);
}

#[test]
fn equal_names_get_a_number_by_creation_order() {
    let st = apply_all(&[
        file(1, None, "отчёт.pdf", 2, "d"),
        file(2, None, "отчёт.pdf", 1, "d"),
        file(3, None, "отчёт (2).pdf", 3, "d"),
        folder(4, None, "папка", 4, "d"),
        folder(5, None, "папка", 5, "d"),
        file(6, None, ".profile", 6, "d"),
        file(7, None, ".profile", 7, "d"),
    ]);
    let map = by_id(&st.view());
    // Старший по созданию (метка 1) хранит имя; номер не совпадает с занятым.
    assert_eq!(map[&nid(2)].name, "отчёт.pdf");
    assert_eq!(map[&nid(1)].name, "отчёт (3).pdf");
    assert_eq!(map[&nid(3)].name, "отчёт (2).pdf");
    assert_eq!(map[&nid(5)].name, "папка (2)");
    assert_eq!(map[&nid(7)].name, ".profile (2)");
}

#[test]
fn invalid_ops_are_rejected_and_batch_skips_them() {
    let mut st = CloudState::default();
    for bad in [
        folder(1, None, "", 1, "d"),
        folder(1, None, "a/b", 1, "d"),
        folder(1, None, " a", 1, "d"),
        folder(1, None, "..", 1, "d"),
        folder(1, None, &"я".repeat(200), 1, "d"),
        folder(1, None, "A", 0, "d"),
        wrap(cloud_op::Op::Create(CloudCreate { node_id: vec![1; 8], kind: 1, name: "A".into(), stamp: stamp(1, "d"), ..Default::default() })),
        // Файл без содержимого, папка с содержимым, ключ не той длины.
        wrap(cloud_op::Op::Create(CloudCreate { node_id: id(1), kind: 2, name: "A".into(), stamp: stamp(1, "d"), ..Default::default() })),
        wrap(cloud_op::Op::Create(CloudCreate { node_id: id(1), kind: 1, name: "A".into(), blob: Some(blob("f")), stamp: stamp(1, "d"), ..Default::default() })),
        wrap(cloud_op::Op::SetBlob(CloudSetBlob { node_id: id(1), blob: Some(CloudBlobRef { key: vec![1; 8], ..blob("f") }), stamp: stamp(1, "d"), ..Default::default() })),
    ] {
        assert!(st.apply(&bad).is_err(), "{bad:?}");
    }
    assert_eq!(st, CloudState::default());
    // Пакет: чужая метка — отказ целиком; негодная операция пропускается.
    let batch = CloudBatch { ops: vec![folder(1, None, "A", 1, "d1"), folder(2, None, "a/b", 2, "d1"), file(3, Some(1), "x", 3, "d1")] };
    assert!(st.apply_batch(&batch, "d2").is_err());
    assert_eq!(st.apply_batch(&batch, "d1").unwrap(), 2);
    assert_eq!(st.view().len(), 2);
    assert!(st.apply_batch(&CloudBatch::default(), "d1").is_err());
    // Правка узла без создания хранится, но узла в дереве нет.
    st.apply(&mv(9, None, "ghost", 9, "d1")).unwrap();
    assert_eq!(st.view().len(), 2);
}

#[test]
fn local_check_refuses_cycles_bad_parents_and_overflow() {
    let st = apply_all(&[folder(1, None, "A", 1, "d"), folder(2, Some(1), "B", 2, "d"), file(3, None, "x", 3, "d")]);
    let one = |op: CloudOp| CloudBatch { ops: vec![op] };
    // В себя, в потомка, в файл, в неизвестную папку.
    assert!(st.check_local(&one(mv(1, Some(1), "A", 4, "d"))).is_err());
    assert!(st.check_local(&one(mv(1, Some(2), "A", 4, "d"))).is_err());
    assert!(st.check_local(&one(mv(2, Some(3), "B", 4, "d"))).is_err());
    assert!(st.check_local(&one(folder(4, Some(9), "C", 4, "d"))).is_err());
    assert!(st.check_local(&one(mv(8, None, "ghost", 4, "d"))).is_err());
    assert!(st.check_local(&one(mv(2, None, "B", 4, "d"))).is_ok());
    // Создание и перенос в одном пакете проверяются по итоговому месту.
    assert!(st.check_local(&CloudBatch { ops: vec![folder(4, None, "C", 4, "d"), mv(4, Some(2), "C", 5, "d")] }).is_ok());
    // Локальные метки: каждой операции пакета — своя.
    let mut batch = CloudBatch { ops: vec![folder(5, None, "E", 0, "x"), mv(5, Some(1), "E", 0, "x")] };
    let mut guard = LamportGuard::default();
    cloud::stamp_batch(&mut batch, "d7", &mut guard);
    let stamps = cloud::batch_stamps(&batch).unwrap();
    assert_eq!(stamps, vec![Stamp::new(1, "d7"), Stamp::new(2, "d7")]);
    let mut next = st.clone();
    assert_eq!(next.apply_batch(&batch, "d7").unwrap(), 2);
    assert_eq!(by_id(&next.view())[&nid(5)].parent, Some(nid(1)));
}

#[test]
fn snapshot_roundtrips_and_drops_old_tombstones() {
    let mut st = apply_all(&[
        wrap(cloud_op::Op::Meta(CloudMeta { name: "Общая".into(), stamp: stamp(1, "d") })),
        folder(1, None, "A", 2, "d"),
        file(2, Some(1), "x.txt", 3, "e"),
        folder(3, None, "B", 4, "d"),
        file(4, Some(3), "y.txt", 5, "d"),
        trash(2, true, 6, "e"),
        purge(3, 7, "d"),
    ]);
    let now = 70 + 1000;
    let snap = st.to_snapshot(now);
    assert_eq!(snap.devices, vec!["d".to_string(), "e".to_string()]);
    let back = CloudState::from_snapshot(&cloud::decode_snapshot(&snap.encode_to_vec()).unwrap()).unwrap();
    assert_eq!(back, st);
    assert_eq!(back.name(), "Общая");
    // Слияние своего снимка ничего не меняет.
    st.merge_snapshot(&snap).unwrap();
    assert_eq!(back, st);
    // Через 90 дней надгробие и потомки стёртого уходят из снимка; правка
    // стёртого от давно не выходившего устройства узел не возвращает.
    let late = st.to_snapshot(70 + cloud::PURGED_KEEP_MS + 1);
    assert_eq!(late.entries.len(), 2);
    let mut fresh = CloudState::from_snapshot(&late).unwrap();
    fresh.apply(&mv(4, None, "y.txt", 99, "old")).unwrap();
    assert_eq!(fresh.view().len(), 2);
    assert_eq!(fresh.view(), st.view());
    // Битый снимок: индекс устройства вне таблицы.
    let mut broken = snap.clone();
    broken.devices.clear();
    assert!(CloudState::from_snapshot(&broken).is_err());
}

#[test]
fn snapshot_stamps_pass_the_lamport_guard() {
    // A0005-7: метка снимка около u64::MAX отвергается, обычная — проходит и возвращает максимум.
    let st = apply_all(&[folder(1, None, "A", 2, "d"), file(2, Some(1), "x.txt", 9, "d")]);
    let snap = st.to_snapshot(0);
    let guard = LamportGuard::default();
    assert_eq!(cloud::guard_snapshot(&guard, &snap, 2).unwrap(), 9);
    let evil = apply_all(&[folder(1, None, "A", u64::MAX - 1, "d")]).to_snapshot(0);
    assert!(cloud::guard_snapshot(&guard, &evil, 1).is_err());
}

#[test]
fn eight_thousand_nodes_fit_the_snapshot_and_view_is_fast() {
    let mut st = CloudState::default();
    let mut guard = LamportGuard::default();
    let dev = "0123456789abcdef0123456789abcdef";
    let node = |i: u32| {
        let mut b = [0u8; 16];
        b[..4].copy_from_slice(&i.to_be_bytes());
        b.to_vec()
    };
    for i in 0..cloud::MAX_NODES as u32 {
        let folder = i % 20 == 0;
        let mut batch = CloudBatch {
            ops: vec![wrap(cloud_op::Op::Create(CloudCreate {
                node_id: node(i),
                kind: (if folder { CloudNodeKind::Folder } else { CloudNodeKind::File }) as i32,
                parent_id: if folder { vec![] } else { node(i - i % 20) },
                name: format!("Документ с обычным именем {i}.docx"),
                blob: (!folder).then(|| CloudBlobRef {
                    file_id: format!("0199d2c4-7b1e-7{i:03x}-8000-00000000{i:04x}"),
                    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into(),
                    ..blob("")
                }),
                thumb: (!folder && i % 3 == 0).then(|| CloudThumb {
                    file_id: format!("0199d2c4-7b1e-7{i:03x}-8000-10000000{i:04x}"),
                    nonce: vec![5; 12],
                    capability: vec![6; 32],
                    width: 320,
                    height: 240,
                }),
                mtime_ms: 1_791_000_000_000,
                stamp: None,
                from: String::new(),
            }))],
        };
        cloud::stamp_batch(&mut batch, dev, &mut guard);
        st.apply_batch(&batch, dev).unwrap();
    }
    assert_eq!(st.live_count(), cloud::MAX_NODES);
    let size = st.size_estimate(0);
    assert!(size < MAX_SNAPSHOT_PLAINTEXT, "снимок {size} байт");
    let started = Instant::now();
    let view = st.view();
    let elapsed = started.elapsed();
    assert_eq!(view.len(), cloud::MAX_NODES);
    assert!(elapsed.as_millis() < 500, "view() {elapsed:?}");
    // Ещё один узел сверх предела локально не проходит.
    let mut extra = CloudBatch { ops: vec![folder(255, None, "ещё", 0, "x")] };
    cloud::stamp_batch(&mut extra, dev, &mut guard);
    assert!(st.check_local(&extra).is_err());
}

fn arb_op() -> impl Strategy<Value = CloudOp> {
    let node = 0u8..7;
    let parent = prop::option::of(0u8..7);
    let lamport = 1u64..12;
    let dev = prop::sample::select(vec!["x", "y", "z"]);
    let name = prop::sample::select(vec!["a", "b", "c.txt"]);
    prop_oneof![
        (node.clone(), parent.clone(), name.clone(), lamport.clone(), dev.clone(), any::<bool>()).prop_map(|(n, p, name, l, d, is_file)| {
            if is_file {
                file(n, p, name, l, d)
            } else {
                folder(n, p, name, l, d)
            }
        }),
        (node.clone(), parent, name, lamport.clone(), dev.clone()).prop_map(|(n, p, name, l, d)| mv(n, p, name, l, d)),
        (node.clone(), any::<bool>(), lamport.clone(), dev.clone()).prop_map(|(n, t, l, d)| trash(n, t, l, d)),
        (node.clone(), lamport.clone(), dev.clone()).prop_map(|(n, l, d)| purge(n, l, d)),
        (node, lamport, dev, 0u8..14, prop::option::of(0u8..14)).prop_map(|(n, l, d, f, sup)| wrap(cloud_op::Op::SetBlob(CloudSetBlob {
            node_id: id(n),
            blob: Some(blob(&format!("s{f}"))),
            stamp: stamp(l, d),
            thumb: None,
            mtime_ms: u64::from(f),
            // Замена черновика (CLOUD-3): ссылка на блоб другой правки
            supersedes: sup.map(|g| vec![format!("s{g}")]).unwrap_or_default(),
            draft_since_ms: 1,
        }))),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    /// Состояние и видимое дерево не зависят от порядка и повторов операций;
    /// дерево без циклов; снимок посреди истории + хвост == вся история.
    #[test]
    fn merge_is_order_independent_and_snapshot_is_enough(
        (ops, perm, cut) in prop::collection::vec(arb_op(), 0..40).prop_flat_map(|v| {
            let n = v.len();
            (Just(v), Just((0..n).collect::<Vec<_>>()).prop_shuffle(), 0..=n)
        })
    ) {
        let s1 = apply_all(&ops);
        let mut s2 = CloudState::default();
        for i in &perm {
            s2.apply(&ops[*i]).unwrap();
        }
        // Повтор части операций ничего не меняет.
        for i in perm.iter().take(5) {
            s2.apply(&ops[*i]).unwrap();
        }
        prop_assert_eq!(&s1, &s2);
        let view = s1.view();
        prop_assert_eq!(&view, &s2.view());
        assert_tree(&view);
        // Имена соседей вне корзины различны.
        let mut names = std::collections::BTreeSet::new();
        for n in view.iter().filter(|n| !n.trashed) {
            prop_assert!(names.insert((n.parent, n.name.clone())), "повтор имени {:?}", n.name);
        }
        // Устройство со снимком первых `cut` операций и хвостом видит то же дерево.
        let head = apply_all(&ops[..cut]);
        let mut from_snapshot = CloudState::from_snapshot(&head.to_snapshot(0)).unwrap();
        for op in &ops[cut..] {
            from_snapshot.apply(op).unwrap();
        }
        prop_assert_eq!(&from_snapshot.view(), &view);
        prop_assert_eq!(from_snapshot.purged_blobs(), s1.purged_blobs());
    }
}

/// A0006-1: граница эпохи в записи отзыва/смены эпохи. Операция и снимок прежней эпохи позже границы
/// отвергаются клиентом, до границы остаются в силе; запись без границы (старый клиент) проверки не вводит.
#[test]
fn epoch_boundary_rejects_old_epoch_after_cut() {
    use parvane_protocol::domain::{
        new_container, new_epoch_key, no_groups, seal_op, seal_snapshot, sign_grant, sign_revoke, sign_revoke_at, sign_rotate_at, Author, ContainerAccess,
        Grantee,
    };
    use parvane_protocol::pb::parvane::core::v2::GrantLevel;
    use parvane_protocol::sign::generate_signing_key;
    let (a, b) = (generate_signing_key(), generate_signing_key());
    let (ka, kb) = (a.verifying_key().to_bytes(), b.verifying_key().to_bytes());
    let res = move |k: &[u8; 32]| -> Option<Author> {
        if *k == ka {
            Some(Author::new("alice@local", "a1"))
        } else if *k == kb {
            Some(Author::new("bob@local", "b1"))
        } else {
            None
        }
    };
    let (container, genesis) = new_container(&a, "local", parvane_protocol::domain::cloud::DOMAIN_NAME, "alice@local", 1).unwrap();
    let mut acc = ContainerAccess::from_genesis(&genesis, &res).unwrap();
    let bob = Grantee::User("bob@local".into());
    acc.apply(&sign_grant(&a, &acc, &bob, GrantLevel::Write, 2).unwrap(), &res, &no_groups).unwrap();
    let key1 = new_epoch_key();
    let with_seq = |seq: u64| {
        let mut op = seal_op(&b, &acc.container, 1, &key1, b"x", 3).unwrap();
        op.seq = seq;
        op
    };
    assert!(acc.check_op_author(&with_seq(9), &res, &no_groups).is_ok(), "до отзыва граница не задана");

    // Граница 5: операции эпохи 1 с seq <= 5 в силе, позже - нет; снимок - по upto_seq.
    let mut bounded = acc.clone();
    bounded.apply(&sign_revoke_at(&a, &bounded, &bob, 4, Some(5)).unwrap(), &res, &no_groups).unwrap();
    assert_eq!(bounded.epoch, 2);
    assert!(bounded.check_op_author(&with_seq(5), &res, &no_groups).is_ok());
    assert_eq!(bounded.check_op_author(&with_seq(6), &res, &no_groups).err(), Some(parvane_protocol::ProtoError::Forbidden));
    let snap = |upto: u64| seal_snapshot(&b, &container, 1, &key1, upto, b"s", 5).unwrap();
    assert!(bounded.check_snapshot_author(&snap(5), &res, &no_groups).is_ok());
    assert_eq!(bounded.check_snapshot_author(&snap(6), &res, &no_groups).err(), Some(parvane_protocol::ProtoError::Forbidden));

    // Смена эпохи с границей действует так же; граница переживает следующую смену.
    let mut rotated = acc.clone();
    rotated.apply(&sign_rotate_at(&a, &rotated, 4, Some(7)).unwrap(), &res, &no_groups).unwrap();
    rotated.apply(&sign_rotate_at(&a, &rotated, 5, Some(20)).unwrap(), &res, &no_groups).unwrap();
    assert!(rotated.check_op_author(&with_seq(7), &res, &no_groups).is_ok());
    assert_eq!(rotated.check_op_author(&with_seq(8), &res, &no_groups).err(), Some(parvane_protocol::ProtoError::Forbidden));

    // Запись старого образца без границы: как раньше.
    let mut legacy = acc.clone();
    legacy.apply(&sign_revoke(&a, &legacy, &bob, 4).unwrap(), &res, &no_groups).unwrap();
    assert!(legacy.check_op_author(&with_seq(99), &res, &no_groups).is_ok());
}

// ── история версий (CLOUD-3) ────────────────────────────────────────────────

fn set_blob(n: u8, file: &str, l: u64, dev: &str, mtime: u64) -> CloudOp {
    wrap(cloud_op::Op::SetBlob(CloudSetBlob { node_id: id(n), blob: Some(blob(file)), stamp: stamp(l, dev), mtime_ms: mtime, ..Default::default() }))
}

fn node_of(st: &CloudState, n: u8) -> ViewNode {
    st.view().into_iter().find(|v| v.id == nid(n)).unwrap()
}

fn purged_ids(st: &CloudState) -> Vec<String> {
    st.purged_blobs().into_iter().map(|b| b.file_id).collect()
}

/// Версий не больше `VERSIONS_KEEP`: старшие уходят в сборку блобов, текущая — новейшая, прежние — от новой к старой.
#[test]
fn versions_keep_latest_and_collect_evicted() {
    let mut st = apply_all(&[file(1, None, "план.md", 1, "x")]);
    for i in 0..12u64 {
        st.apply(&set_blob(1, &format!("v{i}"), 10 + i, "x", 100 + i)).unwrap();
    }
    let v = node_of(&st, 1);
    assert_eq!(v.blob.as_ref().unwrap().file_id, "v11");
    let files: Vec<String> = v.versions.iter().map(|x| x.blob.file_id.clone()).collect();
    assert_eq!(files.len(), cloud::VERSIONS_KEEP - 1);
    assert_eq!(files[0], "v10");
    assert_eq!(files.last().unwrap(), "v2");
    // Вытеснены создание и две первые правки
    assert_eq!(purged_ids(&st), vec!["f1".to_string(), "v0".into(), "v1".into()]);
    // Снимок несёт историю и надгробия
    let again = CloudState::from_snapshot(&st.to_snapshot(0)).unwrap();
    assert_eq!(again.view(), st.view());
    assert_eq!(again.purged_blobs(), st.purged_blobs());
    // Стёртый узел отдаёт все свои версии
    st.apply(&purge(1, 40, "x")).unwrap();
    assert_eq!(purged_ids(&st).len(), 13);
}

/// Правки одного устройства в окне черновика — одна версия; другое устройство, «оставить» и правка после окна —
/// отдельные версии. Решение принимает движок до меток.
#[test]
fn coalesce_local_replaces_drafts_of_same_device() {
    let keep = std::collections::BTreeSet::new();
    let mut st = apply_all(&[file(1, None, "заметка.md", 1, "x")]);
    let mut guard = LamportGuard::default();
    guard.raise(1);
    let mut write = |st: &mut CloudState, file: &str, dev: &str, mtime: u64, keep: &std::collections::BTreeSet<usize>| {
        let mut batch = CloudBatch { ops: vec![set_blob(1, file, 0, dev, mtime)] };
        st.coalesce_local(&mut batch, dev, keep);
        cloud::stamp_batch(&mut batch, dev, &mut guard);
        st.apply_batch(&batch, dev).unwrap();
    };
    let minute = 60_000;
    // Первая правка после создания — версия (создание черновиком не бывает)
    write(&mut st, "a", "x", 10 * minute, &keep);
    write(&mut st, "b", "x", 12 * minute, &keep);
    write(&mut st, "c", "x", 15 * minute, &keep);
    let v = node_of(&st, 1);
    assert_eq!(v.blob.as_ref().unwrap().file_id, "c");
    assert_eq!(v.versions.iter().map(|x| x.blob.file_id.as_str()).collect::<Vec<_>>(), vec!["f1"]);
    assert_eq!(purged_ids(&st), vec!["a".to_string(), "b".into()]);
    // Окно считается от начала черновика: через 10 минут — новая версия
    write(&mut st, "d", "x", 21 * minute, &keep);
    // Другое устройство — своя версия
    write(&mut st, "e", "y", 22 * minute, &keep);
    // «Оставить» (возврат прежней) — не черновик: следующая правка её не заменит
    write(&mut st, "f", "x", 23 * minute, &[0].into_iter().collect());
    write(&mut st, "g", "x", 24 * minute, &keep);
    let v = node_of(&st, 1);
    assert_eq!(v.versions.iter().map(|x| x.blob.file_id.as_str()).collect::<Vec<_>>(), vec!["f", "e", "d", "c", "f1"]);
    assert_eq!(v.versions[0].device, "x");
    // Текущее содержимое записало устройство «x»: экран расхождения заметки называет его
    assert_eq!(v.device, "x");
    assert_eq!(json_node(&st, 1)["device"], "x");
    write(&mut st, "h", "y", 40 * minute, &keep);
    assert_eq!(json_node(&st, 1)["device"], "y");
}

/// Чужой автор не может заменить блоб другого загрузившего: надгробие получает загрузившего новой версии,
/// и сборка чужого блоба не стирает.
#[test]
fn supersedes_uses_uploader_of_new_version() {
    let mut st = apply_all(&[file(1, None, "a.txt", 1, "x")]);
    let evil = CloudBlobRef { uploader: "mallory@local".into(), ..blob("m1") };
    st.apply(&wrap(cloud_op::Op::SetBlob(CloudSetBlob {
        node_id: id(1),
        blob: Some(evil),
        stamp: stamp(5, "m"),
        supersedes: vec!["f1".into()],
        ..Default::default()
    })))
    .unwrap();
    let gone = st.purged_blobs();
    assert_eq!(gone.len(), 1);
    assert_eq!((gone[0].file_id.as_str(), gone[0].uploader.as_str()), ("f1", "mallory@local"));
}

/// Создание с `from` (файл прислан копией) переживает снимок.
#[test]
fn received_file_keeps_from() {
    let op = wrap(cloud_op::Op::Create(CloudCreate {
        node_id: id(3),
        kind: CloudNodeKind::File as i32,
        name: "регламент.md".into(),
        blob: Some(blob("c1")),
        stamp: stamp(3, "x"),
        mtime_ms: 5,
        from: "aliya@local".into(),
        ..Default::default()
    }));
    let st = apply_all(&[op]);
    assert_eq!(node_of(&st, 3).from, "aliya@local");
    let again = CloudState::from_snapshot(&st.to_snapshot(0)).unwrap();
    assert_eq!(node_of(&again, 3).from, "aliya@local");
}

/// Возврат прежней версии тем же блобом: она снова текущая, прежняя текущая — в истории, повтора нет.
#[test]
fn restore_moves_version_to_top() {
    let mut st = apply_all(&[file(1, None, "a.txt", 1, "x"), set_blob(1, "v2", 2, "x", 2), set_blob(1, "v3", 3, "x", 3)]);
    let old = node_of(&st, 1).versions[1].blob.clone();
    assert_eq!(old.file_id, "f1");
    st.apply(&wrap(cloud_op::Op::SetBlob(CloudSetBlob { node_id: id(1), blob: Some(old), stamp: stamp(4, "x"), mtime_ms: 4, ..Default::default() }))).unwrap();
    let v = node_of(&st, 1);
    assert_eq!(v.blob.as_ref().unwrap().file_id, "f1");
    assert_eq!(v.versions.iter().map(|x| x.blob.file_id.as_str()).collect::<Vec<_>>(), vec!["v3", "v2"]);
    assert!(st.purged_blobs().is_empty());
}

// ── перенос файла с историей между контейнерами (CLOUD-3) ──────────────────

/// Узел состояния `cloud_json::state_json` по id.
fn json_node(st: &CloudState, n: u8) -> serde_json::Value {
    let v: serde_json::Value = serde_json::from_str(&cloud_json::state_json(st)).unwrap();
    v["nodes"].as_array().unwrap().iter().find(|x| x["id"] == hex::encode(id(n))).unwrap().clone()
}

/// Правка переноса так, как её строит хост: блобы версий — копии (`c-<прежний>`), загрузивший — переносящий.
fn transfer_json(src: &serde_json::Value, new_id: u8, with_history: bool) -> String {
    let copy = |b: &serde_json::Value| {
        let mut b = b.clone();
        b["fileId"] = format!("c-{}", b["fileId"].as_str().unwrap()).into();
        b["uploader"] = "bob@local".into();
        b
    };
    let versions: Vec<serde_json::Value> = if with_history {
        src["versions"].as_array().unwrap().iter().map(|v| serde_json::json!({"blob": copy(&v["blob"]), "mtime": v["mtime"]})).collect()
    } else {
        Vec::new()
    };
    serde_json::json!({"ops": [{
        "op": "create", "id": hex::encode(id(new_id)), "kind": "file", "parent": null, "name": src["name"],
        "mtime": src["mtime"], "blob": copy(&src["blob"]), "versions": versions,
    }]})
    .to_string()
}

/// Локальная правка целиком: разбор, окно черновика, метки, проверка, применение.
fn apply_local(st: &mut CloudState, json: &str, dev: &str, guard: &mut LamportGuard) -> CloudBatch {
    let (mut batch, keep) = cloud_json::batch_with_keep(json).unwrap();
    st.coalesce_local(&mut batch, dev, &keep);
    cloud::stamp_batch(&mut batch, dev, guard);
    st.check_local(&batch).unwrap();
    st.apply_batch(&batch, dev).unwrap();
    batch
}

fn version_ids(v: &ViewNode) -> Vec<String> {
    v.versions.iter().map(|x| x.blob.file_id.clone()).collect()
}

/// Перенос уносит историю: те же версии в том же порядке и с теми же временами — копиями блобов; в назначении
/// ничего не собирается, источник после стирания отдаёт в сборку все свои версии. Без `versions` (копия
/// файла, «Сделать копию») — новый файл с чистой историей.
#[test]
fn transfer_carries_history_and_copy_starts_clean() {
    let src = apply_all(&[file(1, None, "план.md", 1, "x"), set_blob(1, "v2", 2, "x", 200), set_blob(1, "v3", 3, "y", 300)]);
    let node = json_node(&src, 1);
    let mut dst = CloudState::default();
    let mut guard = LamportGuard::default();
    apply_local(&mut dst, &transfer_json(&node, 9, true), "z", &mut guard);
    let moved = node_of(&dst, 9);
    assert_eq!(moved.blob.as_ref().unwrap().file_id, "c-v3");
    assert_eq!(moved.mtime_ms, 300);
    assert_eq!(version_ids(&moved), vec!["c-v2", "c-f1"]);
    assert_eq!(moved.versions.iter().map(|v| v.mtime_ms).collect::<Vec<_>>(), vec![200, 1]);
    assert!(dst.purged_blobs().is_empty());
    // Перенесённые версии не черновик: правка сразу после переноса — отдельная версия
    let edit = serde_json::json!({"ops": [{"op": "setBlob", "id": hex::encode(id(9)), "mtime": 301,
        "blob": json_node(&dst, 9)["blob"].clone()}]});
    let mut fresh = edit.clone();
    fresh["ops"][0]["blob"]["fileId"] = "e1".into();
    apply_local(&mut dst, &fresh.to_string(), "z", &mut guard);
    assert_eq!(version_ids(&node_of(&dst, 9)), vec!["c-v3", "c-v2", "c-f1"]);
    assert!(dst.purged_blobs().is_empty());
    // Снимок назначения несёт перенесённую историю
    assert_eq!(CloudState::from_snapshot(&dst.to_snapshot(0)).unwrap().view(), dst.view());
    // Источник: стирание узла — все версии в сборку
    let mut src = src;
    src.apply(&purge(1, 10, "x")).unwrap();
    assert_eq!(purged_ids(&src), vec!["f1".to_string(), "v2".into(), "v3".into()]);
    // Копия — только текущая версия
    apply_local(&mut dst, &transfer_json(&node, 8, false), "z", &mut guard);
    let copy = node_of(&dst, 8);
    assert_eq!(copy.blob.as_ref().unwrap().file_id, "c-v3");
    assert!(copy.versions.is_empty());
}

/// Негодный перенос: история у папки и у перемещения, больше `VERSIONS_KEEP - 1` прежних версий.
#[test]
fn transfer_rejects_bad_versions() {
    let st = apply_all(&[file(1, None, "a.txt", 1, "x"), set_blob(1, "v2", 2, "x", 2)]);
    let node = json_node(&st, 1);
    let mut too_many: serde_json::Value = serde_json::from_str(&transfer_json(&node, 9, true)).unwrap();
    let one = too_many["ops"][0]["versions"][0].clone();
    too_many["ops"][0]["versions"] = vec![one; cloud::VERSIONS_KEEP].into();
    let a = hex::encode(id(2));
    let v = serde_json::json!([{"blob": node["blob"], "mtime": 1}]);
    for bad in [
        too_many,
        serde_json::json!({"ops": [{"op": "create", "id": a, "kind": "folder", "parent": null, "name": "x", "versions": v}]}),
        serde_json::json!({"ops": [{"op": "move", "id": a, "parent": null, "name": "x", "versions": v}]}),
        serde_json::json!({"ops": [{"op": "create", "id": a, "kind": "file", "parent": null, "name": "x", "blob": node["blob"], "versions": 5}]}),
    ] {
        assert!(cloud_json::batch_with_keep(&bad.to_string()).is_err(), "{bad}");
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Перенос с любым числом версий: в назначении та же история (порядок, времена), применение операций пакета в
    /// любом порядке и снимок дают то же состояние, сборка в назначении пуста.
    #[test]
    fn transfer_history_is_order_independent(
        (edits, perm) in (0usize..cloud::VERSIONS_KEEP + 3).prop_flat_map(|n| {
            let ops = n.min(cloud::VERSIONS_KEEP - 1) + 1;
            (Just(n), Just((0..ops).collect::<Vec<_>>()).prop_shuffle())
        })
    ) {
        let mut src = apply_all(&[file(1, None, "a.md", 1, "x")]);
        for i in 0..edits as u64 {
            src.apply(&set_blob(1, &format!("v{i}"), 10 + i, if i % 2 == 0 { "x" } else { "y" }, 100 + i)).unwrap();
        }
        let before = node_of(&src, 1);
        let mut dst = CloudState::default();
        let batch = apply_local(&mut dst, &transfer_json(&json_node(&src, 1), 9, true), "z", &mut LamportGuard::default());
        prop_assert_eq!(batch.ops.len(), perm.len());
        let moved = node_of(&dst, 9);
        let want: Vec<String> = version_ids(&before).iter().map(|f| format!("c-{f}")).collect();
        prop_assert_eq!(version_ids(&moved), want);
        prop_assert_eq!(moved.versions.iter().map(|v| v.mtime_ms).collect::<Vec<_>>(), before.versions.iter().map(|v| v.mtime_ms).collect::<Vec<_>>());
        prop_assert!(dst.purged_blobs().is_empty());
        let mut shuffled = CloudState::default();
        for i in &perm {
            shuffled.apply(&batch.ops[*i]).unwrap();
        }
        prop_assert_eq!(&shuffled.view(), &dst.view());
        prop_assert_eq!(CloudState::from_snapshot(&dst.to_snapshot(0)).unwrap().view(), dst.view());
    }
}
