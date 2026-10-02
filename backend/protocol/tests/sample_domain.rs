//! Тестовый домен `sample.v1` (T093, SC-005) и сведение перемещений облака
//! (T094) — только движок, без сервера, UI и клиентов.
//!
//! Сценарий: контейнер → правки на двух устройствах офлайн → сведение в любом
//! порядке → грант write → отзыв (новая эпоха, отозванный не читает новые
//! операции) → снимок для нового устройства. Плюс property-тесты порядка.

use std::collections::HashMap;

use ed25519_dalek::SigningKey;
use parvane_protocol::domain::{
    self, cloud, no_groups, sample, Author, ContainerAccess, Grantee, KeyRing, LamportGuard, LwwMap, Stamp,
};
use parvane_protocol::pb::parvane::cloud::v1::{cloud_op, CloudCreate, CloudMove, CloudNodeKind, CloudOp};
use parvane_protocol::pb::parvane::core::v2::{Container, ContainerOp, GrantLevel};
use parvane_protocol::pb::parvane::sample::v1::{SampleEntry, SampleOp};
use parvane_protocol::sign;
use parvane_protocol::ProtoError;
use proptest::prelude::*;
use prost::Message;

/// Устройства и их ключи (у клиента — из проверенных сертификатов).
#[derive(Default)]
struct Directory {
    keys: HashMap<[u8; 32], Author>,
}

impl Directory {
    fn device(&mut self, user: &str, device_id: &str) -> Device {
        let key = sign::generate_signing_key();
        self.keys.insert(key.verifying_key().to_bytes(), Author { user: user.into(), device_id: device_id.into() });
        Device { id: device_id.into(), key, keys: KeyRing::default(), clock: LamportGuard::default() }
    }
    fn resolve(&self) -> impl Fn(&[u8; 32]) -> Option<Author> + '_ {
        move |k| self.keys.get(k).cloned()
    }
}

struct Device {
    id: String,
    key: SigningKey,
    keys: KeyRing,
    clock: LamportGuard,
}

impl Device {
    fn stamp(&mut self) -> Stamp {
        Stamp::new(self.clock.tick(), &self.id)
    }

    /// Локальная правка: пакет записей → зашифрованная подписанная операция.
    fn edit(&mut self, c: &Container, entries: Vec<SampleEntry>) -> ContainerOp {
        let (epoch, key) = self.keys.latest().expect("ключ эпохи");
        let key = *key;
        let pt = SampleOp { entries }.encode_to_vec();
        domain::seal_op(&self.key, c, epoch, &key, &pt, 1).expect("seal")
    }

    fn set(&mut self, c: &Container, k: &str, v: &str) -> ContainerOp {
        let s = self.stamp();
        self.edit(c, vec![sample::set(k, v.as_bytes(), &s)])
    }

    fn remove(&mut self, c: &Container, k: &str) -> ContainerOp {
        let s = self.stamp();
        self.edit(c, vec![sample::remove(k, &s)])
    }

    /// Получить ключ эпохи «по E2E»: сериализованный ContainerKeyShare.
    fn receive_share(&mut self, access: &ContainerAccess, wire: &[u8], sender: &str) -> Result<(), ProtoError> {
        let share = domain::decode_key_share(wire)?;
        let (epoch, key) = access.accept_key_share(&share, sender, &no_groups)?;
        self.keys.insert(epoch, key);
        Ok(())
    }
}

/// Открыть и применить операцию: проверка автора по грантам → AEAD → LWW.
fn apply(map: &mut LwwMap, access: &ContainerAccess, dir: &Directory, reader: &Device, op: &ContainerOp) -> Result<(), ProtoError> {
    let res = dir.resolve();
    let author = access.check_op_author(op, &res, &no_groups)?;
    let key = reader.keys.get(op.key_epoch).ok_or(ProtoError::Crypto)?;
    let pt = domain::open_op(op, &access.container, key)?;
    let sop = sample::decode_op(&pt)?;
    sample::apply_op(map, &sop, &author.device_id)
}

fn share(access: &ContainerAccess, epoch: u64, key: &[u8; 32]) -> Vec<u8> {
    access.key_share(epoch, key).expect("share").encode_to_vec()
}

#[test]
fn sample_domain_lifecycle() {
    let mut dir = Directory::default();
    let mut a1 = dir.device("alice@local", "a1");
    let mut a2 = dir.device("alice@local", "a2");
    let mut b1 = dir.device("bob@local", "b1");

    // 1. Контейнер: генезис владельца, ключ эпохи 1 раздаётся её устройствам.
    let (container, genesis) = domain::new_container(&a1.key, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
    let mut access = ContainerAccess::from_genesis(&genesis, &dir.resolve()).unwrap();
    let k1 = domain::new_epoch_key();
    a1.keys.insert(1, k1.clone());
    let wire = share(&access, 1, &k1);
    a2.receive_share(&access, &wire, "alice@local").unwrap();

    // 2. Офлайн-правки на двух устройствах (конфликт по "title", удаление "tmp").
    let ops_a1 = [a1.set(&container, "title", "Черновик"), a1.set(&container, "tmp", "x"), a1.set(&container, "title", "План")];
    let ops_a2 = [a2.set(&container, "title", "Итог"), a2.set(&container, "color", "синий"), a2.remove(&container, "tmp")];

    // 3. Сведение: одинаковый результат при любом порядке.
    let all: Vec<ContainerOp> = ops_a1.iter().chain(ops_a2.iter()).cloned().collect();
    let orders: Vec<Vec<usize>> = vec![vec![0, 1, 2, 3, 4, 5], vec![3, 4, 5, 0, 1, 2], vec![5, 2, 4, 1, 3, 0], vec![1, 5, 0, 4, 2, 3]];
    let mut results = Vec::new();
    for ord in &orders {
        let mut m = LwwMap::default();
        for i in ord {
            apply(&mut m, &access, &dir, &a1, &all[*i]).unwrap();
        }
        results.push(m);
    }
    assert!(results.windows(2).all(|w| w[0] == w[1]));
    let merged = results.remove(0);
    // Метки: a1 — lamport 1,2,3; a2 — 1,2,3. "title": (3,"a1") > (1,"a2"); "tmp":
    // удаление (3,"a2") > (2,"a1").
    assert_eq!(merged.get("title"), Some("План".as_bytes()));
    assert_eq!(merged.get("color"), Some("синий".as_bytes()));
    assert_eq!(merged.get("tmp"), None);

    // 4. Поделиться: грант write для bob + ключ эпохи по E2E.
    let bob = Grantee::User("bob@local".into());
    let g = domain::sign_grant(&a1.key, &access, &bob, GrantLevel::Write, 2).unwrap();
    access.apply(&g, &dir.resolve(), &no_groups).unwrap();
    let mut bob_access = ContainerAccess::replay(&genesis, std::slice::from_ref(&g), &dir.resolve(), &no_groups).unwrap();
    assert_eq!(bob_access, access);
    b1.receive_share(&bob_access, &share(&access, 1, &k1), "alice@local").unwrap();
    let mut bob_map = LwwMap::default();
    for op in &all {
        apply(&mut bob_map, &bob_access, &dir, &b1, op).unwrap();
    }
    assert_eq!(bob_map, merged);
    // Bob пишет (его lamport продолжает виденный максимум).
    b1.clock.check(&Stamp::new(3, "a1")).unwrap();
    let op_b = b1.set(&container, "title", "Версия Боба");
    let mut alice_map = merged.clone();
    apply(&mut alice_map, &access, &dir, &a1, &op_b).unwrap();
    assert_eq!(alice_map.get("title"), Some("Версия Боба".as_bytes()));

    // 5. Отзыв: новая эпоха 2, ключ — только устройствам alice.
    let rv = domain::sign_revoke(&a1.key, &access, &bob, 3).unwrap();
    let ev = access.apply(&rv, &dir.resolve(), &no_groups).unwrap();
    assert_eq!((ev.key_epoch, ev.level), (2, None));
    assert!(!access.key_recipients().contains(&bob));
    bob_access.apply(&rv, &dir.resolve(), &no_groups).unwrap();
    let k2 = domain::new_epoch_key();
    a1.keys.insert(2, k2.clone());
    a2.receive_share(&access, &share(&access, 2, &k2), "alice@local").unwrap();
    let op_new = a2.set(&container, "secret", "после отзыва");
    assert_eq!(op_new.key_epoch, 2);
    // Отозванный не читает новые операции: ключа эпохи 2 у него нет, старый не подходит.
    assert_eq!(apply(&mut bob_map, &bob_access, &dir, &b1, &op_new), Err(ProtoError::Crypto));
    assert_eq!(domain::open_op(&op_new, &container, &k1), Err(ProtoError::Crypto));
    // …и не пишет: операция bob в эпоху 2 не проходит проверку автора.
    b1.keys.insert(2, domain::new_epoch_key());
    let op_forged = b1.set(&container, "title", "взлом");
    assert_eq!(access.check_op_author(&op_forged, &dir.resolve(), &no_groups).err(), Some(ProtoError::Forbidden));
    // Его старая операция эпохи 1 остаётся законной историей.
    access.check_op_author(&op_b, &dir.resolve(), &no_groups).unwrap();
    apply(&mut alice_map, &access, &dir, &a1, &op_new).unwrap();
    assert_eq!(alice_map.get("secret"), Some("после отзыва".as_bytes()));

    // 6. Снимок: новое устройство alice догоняет со снимка + хвоста.
    let snap_pt = sample::snapshot(&alice_map).encode_to_vec();
    let (e, k) = a1.keys.latest().map(|(e, k)| (e, *k)).unwrap();
    let snap = domain::seal_snapshot(&a1.key, &container, e, &k, 8, &snap_pt, 4).unwrap();
    access.check_snapshot_author(&snap, &dir.resolve(), &no_groups).unwrap();
    let mut a3 = dir.device("alice@local", "a3");
    a3.receive_share(&access, &share(&access, 2, &k2), "alice@local").unwrap();
    let pt = domain::open_snapshot(&snap, &container, a3.keys.get(2).unwrap()).unwrap();
    let mut a3_map = sample::from_snapshot(&sample::decode_snapshot(&pt).unwrap()).unwrap();
    let tail = a1.set(&container, "color", "зелёный");
    apply(&mut a3_map, &access, &dir, &a3, &tail).unwrap();
    apply(&mut alice_map, &access, &dir, &a1, &tail).unwrap();
    assert_eq!(a3_map, alice_map);
}

#[test]
fn foreign_stamp_rejected() {
    // Метка чужого устройства внутри операции — отказ (D-16).
    let mut dir = Directory::default();
    let mut a1 = dir.device("alice@local", "a1");
    let (container, genesis) = domain::new_container(&a1.key, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
    let access = ContainerAccess::from_genesis(&genesis, &dir.resolve()).unwrap();
    a1.keys.insert(1, domain::new_epoch_key());
    let op = a1.edit(&container, vec![sample::set("k", b"v", &Stamp::new(1, "a2"))]);
    let mut m = LwwMap::default();
    assert_eq!(apply(&mut m, &access, &dir, &a1, &op), Err(ProtoError::ContextMismatch));
    // «Вечный победитель» u64::MAX отсекается охранником в порядке журнала.
    let mut g = LamportGuard::default();
    let bad = SampleOp { entries: vec![sample::set("k", b"v", &Stamp::new(u64::MAX, "a1"))] };
    assert!(sample::guard_op(&mut g, &bad).is_err());
}

fn arb_entry() -> impl Strategy<Value = (String, SampleEntry)> {
    (0u8..4, 1u64..12, 0usize..3, any::<bool>(), 0u8..8).prop_map(|(k, lamport, dev, del, v)| {
        let device = ["d0", "d1", "d2"][dev];
        let key = format!("k{k}");
        let st = Stamp::new(lamport, device);
        let e = if del { sample::remove(&key, &st) } else { sample::set(&key, &[v], &st) };
        (device.to_string(), e)
    })
}

proptest! {
    /// Любая перестановка операций даёт одно и то же состояние LWW-карты.
    #[test]
    fn lww_merge_is_order_independent(ops in prop::collection::vec(arb_entry(), 1..40).prop_flat_map(|v| {
        let n = v.len();
        (Just(v), Just((0..n).collect::<Vec<_>>()).prop_shuffle())
    })) {
        let (ops, perm) = ops;
        let mut m1 = LwwMap::default();
        for (dev, e) in &ops {
            sample::apply_op(&mut m1, &SampleOp { entries: vec![e.clone()] }, dev).unwrap();
        }
        let mut m2 = LwwMap::default();
        for i in &perm {
            let (dev, e) = &ops[*i];
            sample::apply_op(&mut m2, &SampleOp { entries: vec![e.clone()] }, dev).unwrap();
        }
        prop_assert_eq!(&m1, &m2);
        // Снимок сводится в то же состояние.
        let back = sample::from_snapshot(&sample::snapshot(&m1)).unwrap();
        prop_assert_eq!(back, m1);
    }

    /// Дерево облака: состояние не зависит от порядка операций, циклов нет.
    #[test]
    fn cloud_moves_are_order_independent(moves in prop::collection::vec((0u8..6, prop::option::of(0u8..6), 1u64..20, 0usize..3), 0..30).prop_flat_map(|v| {
        let n = v.len() + 6;
        (Just(v), Just((0..n).collect::<Vec<_>>()).prop_shuffle())
    })) {
        let (moves, perm) = moves;
        let mut ops: Vec<CloudOp> = (0u8..6)
            .map(|i| CloudOp { op: Some(cloud_op::Op::Create(CloudCreate {
                node_id: vec![i; 16],
                kind: (if i == 5 { CloudNodeKind::File } else { CloudNodeKind::Folder }) as i32,
                parent_id: vec![],
                name: format!("n{i}"),
                blob: None,
                stamp: Some(Stamp::new(1, "c").to_pb()),
            })) })
            .collect();
        for (node, parent, l, dev) in &moves {
            ops.push(CloudOp { op: Some(cloud_op::Op::Move(CloudMove {
                node_id: vec![*node; 16],
                parent_id: parent.map(|p| vec![p; 16]).unwrap_or_default(),
                name: format!("m{node}"),
                stamp: Some(Stamp::new(*l + 1, ["x", "y", "z"][*dev]).to_pb()),
            })) });
        }
        let mut t1 = cloud::LwwTree::default();
        for o in &ops {
            t1.apply(o).unwrap();
        }
        let mut t2 = cloud::LwwTree::default();
        for i in &perm {
            t2.apply(&ops[*i]).unwrap();
        }
        let s1 = t1.state();
        prop_assert_eq!(&s1, &t2.state());
        for id in s1.keys() {
            // У каждого узла конечный путь от корня (циклов нет).
            prop_assert!(cloud::LwwTree::path(&s1, id).is_some());
            // Родитель — только папка.
            if let Some(p) = s1[id].parent {
                prop_assert_eq!(s1[&p].kind, CloudNodeKind::Folder);
            }
        }
    }
}

#[test]
fn cloud_file_references_blob() {
    use parvane_protocol::pb::parvane::cloud::v1::{CloudBlobRef, CloudSetBlob};
    let blob = |id: &str| CloudBlobRef { file_id: id.into(), key: vec![1; 32], size: 10, chunks: 1, mime: "text/plain".into(), sha256: vec![2; 32] };
    let mut t = cloud::LwwTree::default();
    t.apply(&CloudOp { op: Some(cloud_op::Op::Create(CloudCreate {
        node_id: vec![1; 16], kind: CloudNodeKind::File as i32, parent_id: vec![], name: "a.txt".into(), blob: Some(blob("f1")), stamp: Some(Stamp::new(1, "d").to_pb()),
    })) }).unwrap();
    t.apply(&CloudOp { op: Some(cloud_op::Op::SetBlob(CloudSetBlob { node_id: vec![1; 16], blob: Some(blob("f2")), stamp: Some(Stamp::new(2, "d").to_pb()) })) }).unwrap();
    t.apply(&CloudOp { op: Some(cloud_op::Op::SetBlob(CloudSetBlob { node_id: vec![1; 16], blob: Some(blob("f0")), stamp: Some(Stamp::new(1, "e").to_pb()) })) }).unwrap();
    let s = t.state();
    assert_eq!(s[&[1u8; 16]].blob.as_ref().map(|b| b.file_id.as_str()), Some("f2"));
    // Имя с '/' — отказ.
    let bad = CloudOp { op: Some(cloud_op::Op::Move(CloudMove { node_id: vec![1; 16], parent_id: vec![], name: "a/b".into(), stamp: Some(Stamp::new(3, "d").to_pb()) })) };
    assert!(t.apply(&bad).is_err());
}
