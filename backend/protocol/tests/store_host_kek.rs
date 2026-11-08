//! spec 035 T043/T045: хранилище движка — KEK обёртки PIN выводит хост (web — WebCrypto PBKDF2, тот же
//! результат, что `store::pin_kek`), и корень, сменённый другой вкладкой (`refresh_root`, FR-027).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use parvane_protocol::pb::parvane::engine::v1::{StoreBatch, StoreLoaded, StorePut, StoreReads};
use parvane_protocol::store::{self, OpenState, RotationAction, Store};
use parvane_protocol::ProtoError;

const DEVICE_KEY: [u8; 32] = [0x5a; 32];
const ITER: u32 = 1000;
const SALT: [u8; 16] = [7; 16];

#[derive(Default)]
struct Host {
    kv: BTreeMap<String, Vec<u8>>,
}

impl Host {
    fn apply(&mut self, b: &StoreBatch) {
        for k in &b.deletes {
            self.kv.remove(k);
        }
        for p in &b.puts {
            self.kv.insert(p.key.clone(), p.value.clone());
        }
    }
    fn read(&self, r: &StoreReads) -> StoreLoaded {
        let mut entries = Vec::new();
        for (k, v) in self.kv.range(r.prefix.clone()..) {
            if !k.starts_with(&r.prefix) {
                break;
            }
            if !r.after.is_empty() && k.as_str() <= r.after.as_str() {
                continue;
            }
            if r.limit != 0 && entries.len() >= r.limit as usize {
                break;
            }
            entries.push(StorePut { key: k.clone(), value: v.clone() });
        }
        StoreLoaded { read_id: r.read_id, entries }
    }
    fn root(&self) -> &[u8] {
        &self.kv[store::ROOT_KEY]
    }
}

fn commit(s: &mut Store, h: &mut Host, b: StoreBatch) {
    h.apply(&b);
    s.committed(b.batch_id).unwrap();
}

fn fresh(h: &mut Host) -> Store {
    let mut s = Store::create();
    let b = s.wrap_device(&DEVICE_KEY).unwrap();
    commit(&mut s, h, b);
    s
}

fn run_rotation(s: &mut Store, h: &mut Host) {
    loop {
        match s.rotation_next().unwrap() {
            RotationAction::Read(r) => {
                let l = h.read(&r);
                s.rotation_loaded(l).unwrap();
            }
            RotationAction::Write(b) => commit(s, h, b),
            RotationAction::Continue => {}
            RotationAction::Done => return,
            RotationAction::Aborted(e) => panic!("перенос остановлен: {e:?}"),
        }
    }
}

#[test]
fn host_kek_equals_engine_pbkdf2() {
    let mut h = Host::default();
    let mut s = fresh(&mut h);
    let b = s.write(&[("state-object", "a", b"one")], &[]).unwrap();
    commit(&mut s, &mut h, b);
    let kek = store::pin_kek("выдуманный-пин", &SALT, ITER);
    let b = s.set_pin_kek(&SALT, ITER, &kek).unwrap();
    assert_eq!(b.puts.len(), 1, "смена обёртки — только корень");
    assert_eq!(b.puts[0].key, store::ROOT_KEY);
    commit(&mut s, &mut h, b);
    assert_eq!(s.pin_params(), Some((SALT.to_vec(), ITER)));

    // Открыть PIN-строкой (вывод движка) и KEK хоста — одно и то же
    let mut by_pin = Store::load(h.root()).unwrap();
    assert_eq!(by_pin.state(), OpenState::Locked);
    by_pin.unlock_pin("выдуманный-пин").unwrap();
    let k = store::record_key(1, "state-object", "a");
    assert_eq!(by_pin.open(&k, &h.kv[&k]).unwrap(), b"one");
    let mut by_kek = Store::load(h.root()).unwrap();
    assert!(matches!(by_kek.unlock_pin_kek(&[1; 32]), Err(ProtoError::Crypto)));
    by_kek.unlock_pin_kek(&kek).unwrap();
    assert_eq!(by_kek.open(&k, &h.kv[&k]).unwrap(), b"one");
    // Ключом устройства — уже нет
    let mut by_dev = Store::load(h.root()).unwrap();
    assert!(by_dev.unlock_device(&DEVICE_KEY).is_err());
    assert!(s.set_pin_kek(&[1; 3], ITER, &kek).is_err());
}

#[test]
fn rotation_after_host_kek_pin() {
    let mut h = Host::default();
    let mut s = fresh(&mut h);
    for i in 0..10 {
        let name = format!("n{i}");
        let b = s.write(&[("history-row", name.as_str(), name.as_bytes())], &[]).unwrap();
        commit(&mut s, &mut h, b);
    }
    let kek = store::pin_kek("пин-два", &SALT, ITER);
    let b = s.set_pin_kek(&SALT, ITER, &kek).unwrap();
    commit(&mut s, &mut h, b);
    let b = s.begin_rotation().unwrap();
    commit(&mut s, &mut h, b);
    run_rotation(&mut s, &mut h);
    let mut again = Store::load(h.root()).unwrap();
    again.unlock_pin_kek(&kek).unwrap();
    assert_eq!(again.root().active_generation, 2);
    let k = store::record_key(2, "history-row", "n3");
    assert_eq!(again.open(&k, &h.kv[&k]).unwrap(), b"n3");
    assert!(h.kv.keys().all(|k| !k.starts_with("g1/")), "прежнее поколение удалено");
}

#[test]
fn refresh_root_keeps_dek_on_wrap_change_and_locks_on_rotation() {
    let mut h = Host::default();
    let mut a = fresh(&mut h);
    let mut b = Store::load(h.root()).unwrap();
    b.unlock_device(&DEVICE_KEY).unwrap();

    // A ставит PIN: обёртка сменилась, DEK тот же — B продолжает писать, запись читается
    let kek = store::pin_kek("пин-три", &SALT, ITER);
    let batch = a.set_pin_kek(&SALT, ITER, &kek).unwrap();
    commit(&mut a, &mut h, batch);
    assert_eq!(b.refresh_root(h.root()).unwrap(), OpenState::Ready);
    let batch = b.write(&[("state-object", "from-b", b"bee")], &[]).unwrap();
    commit(&mut b, &mut h, batch);
    assert!(b.begin_rotation().is_err(), "без KEK перенос эта вкладка не ведёт");
    let k = store::record_key(1, "state-object", "from-b");
    assert_eq!(a.open(&k, &h.kv[&k]).unwrap(), b"bee");

    // A начинает перенос: у B нет DEK нового поколения — B заблокирована, писать не может
    let batch = a.begin_rotation().unwrap();
    commit(&mut a, &mut h, batch);
    assert_eq!(b.refresh_root(h.root()).unwrap(), OpenState::Locked);
    assert!(matches!(b.write(&[("state-object", "x", b"x")], &[]), Err(ProtoError::Locked)));
    run_rotation(&mut a, &mut h);
    assert_eq!(b.refresh_root(h.root()).unwrap(), OpenState::Locked);
    // Ввод PIN во второй вкладке: всё на месте
    let mut b2 = Store::load(h.root()).unwrap();
    b2.unlock_pin("пин-три").unwrap();
    let k = store::record_key(2, "state-object", "from-b");
    assert_eq!(b2.open(&k, &h.kv[&k]).unwrap(), b"bee");

    // Чужой профиль — отказ
    let other = Store::create();
    let mut hh = Host::default();
    let mut o = other;
    let batch = o.wrap_device(&DEVICE_KEY).unwrap();
    commit(&mut o, &mut hh, batch);
    assert!(b.refresh_root(hh.root()).is_err());
}
