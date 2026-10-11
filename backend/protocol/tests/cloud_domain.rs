//! Домен облака `cloud.v1` (spec 016): сведение дерева не зависит от порядка
//! применения, снимок ему достаточен, циклов и потерянных узлов нет.

use std::collections::BTreeMap;
use std::time::Instant;

use prost::Message;
use proptest::prelude::*;

use parvane_protocol::domain::cloud::{self, CloudState, NodeId, ViewNode};
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
        (node, lamport, dev, 0u8..3).prop_map(|(n, l, d, f)| wrap(cloud_op::Op::SetBlob(CloudSetBlob {
            node_id: id(n),
            blob: Some(blob(&format!("s{f}"))),
            stamp: stamp(l, d),
            thumb: None,
            mtime_ms: u64::from(f),
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
