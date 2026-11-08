//! spec 035 T011: хранилище движка (`store.rs`, contracts/storage.md) по векторам
//! `proto/parvane/vectors/storage/{aad,wrap,generation,too_new}.json` (ожидания —
//! руками, FR-053):
//! - запись под чужим `name`/`kind`/`format`/`generation`/`store_id` не открывается;
//! - смена обёртки (установка/смена/снятие PIN) — пачка только с корнем, записи не трогаются;
//! - прерывание переноса поколения в P1–P6 оставляет одно активное поколение со всеми записями;
//! - `TOO_NEW` не выпускает `store_batch`.
//!
//! Хост — словарь в памяти: пачка применяется целиком (удаления, затем записи), чтение — по ключам
//! или по префиксу в порядке байтов ключа после `after`, не больше `limit`.

mod common;

use std::collections::BTreeMap;

use common::*;
use parvane_protocol::pb::parvane::engine::v1::{KindFormat, Root, StoreBatch, StoreLoaded, StorePut, StoreReads, Stored};
use parvane_protocol::store::{self, OpenState, RotationAction, Store};
use parvane_protocol::ProtoError;
use prost::Message;
use serde_json::Value;

const DEVICE_KEY: [u8; 32] = [0x5a; 32];
const TEST_ITER: u32 = 1000;

fn load(file: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(vectors_dir("storage").join(file)).unwrap()).unwrap()
}

#[derive(Default, Clone)]
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
        for k in &r.keys {
            if let Some(v) = self.kv.get(k) {
                entries.push(StorePut { key: k.clone(), value: v.clone() });
            }
        }
        if !r.prefix.is_empty() {
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
        }
        StoreLoaded { read_id: r.read_id, entries }
    }

    fn root(&self) -> Root {
        Root::decode(self.kv.get(store::ROOT_KEY).expect("корня нет").as_slice()).unwrap()
    }

    fn gen_keys(&self, g: u32) -> Vec<String> {
        let p = format!("g{g}/");
        self.kv.keys().filter(|k| k.starts_with(&p)).cloned().collect()
    }
}

/// Новый профиль с обёрткой устройства; корень записан.
fn fresh(host: &mut Host) -> Store {
    let mut s = Store::create();
    let b = s.wrap_device(&DEVICE_KEY).unwrap();
    host.apply(&b);
    s.committed(b.batch_id).unwrap();
    s
}

fn write(s: &mut Store, host: &mut Host, kind: &str, name: &str, plain: &[u8]) {
    let b = s.write(&[(kind, name, plain)], &[]).unwrap();
    host.apply(&b);
    s.committed(b.batch_id).unwrap();
}

/// Все записи активного поколения открываются; вернуть (kind/name → открытый текст). Служебная запись
/// хода переноса (`migration-progress`) — не данные, в сравнение не входит.
fn read_all(s: &Store, host: &Host) -> BTreeMap<String, Vec<u8>> {
    let g = s.root().active_generation;
    let mut out = BTreeMap::new();
    for k in host.gen_keys(g) {
        let plain = s.open(&k, &host.kv[&k]).unwrap_or_else(|e| panic!("{k} не открывается: {e:?}"));
        let (_, kind, name) = store::parse_key(&k).unwrap();
        if kind == "migration-progress" {
            continue;
        }
        out.insert(format!("{kind}/{name}"), plain);
    }
    out
}

#[test]
fn aad_vectors() {
    let v = load("aad.json");
    for c in cases(&v) {
        let i = &c["input"];
        let sid = unhex(i, "store_id_hex");
        let (fmt, kind, generation, name) =
            (i["format"].as_u64().unwrap() as u32, i["kind"].as_str().unwrap(), i["generation"].as_u64().unwrap() as u32, i["name"].as_str().unwrap());
        assert_eq!(store::record_aad(&sid, fmt, kind, generation, name), unhex(&c["expect"], "aad_hex"), "{}", c["name"]);
        let key = store::record_key(generation, kind, name);
        assert_eq!(key, c["expect"]["key"].as_str().unwrap());
        assert_eq!(store::parse_key(&key), Some((generation, kind, name)));
    }
}

/// Запись под чужим name/kind/format/generation/store_id не открывается (AAD).
#[test]
fn record_bound_to_its_context() {
    let dek = [7u8; 32];
    let sid = [1u8; 16];
    let st = store::seal_record(&dek, &sid, 1, "state-object", 3, "FOLDER/2", b"plain").unwrap();
    assert_eq!(st.kind, "state-object");
    assert_eq!((st.format, st.generation), (1, 3));
    assert_eq!(store::open_record(&dek, &sid, 3, "state-object", "FOLDER/2", &st).unwrap(), b"plain");
    let bad = |r: parvane_protocol::Result<Vec<u8>>, what: &str| {
        assert!(matches!(r, Err(ProtoError::Crypto) | Err(ProtoError::ContextMismatch)), "{what}: открылось: {r:?}")
    };
    bad(store::open_record(&dek, &sid, 3, "state-object", "FOLDER/3", &st), "чужое имя");
    let mut other_kind = st.clone();
    other_kind.kind = "history-row".into();
    bad(store::open_record(&dek, &sid, 3, "history-row", "FOLDER/2", &other_kind), "чужой вид");
    let mut other_fmt = st.clone();
    other_fmt.format = 2;
    bad(store::open_record(&dek, &sid, 3, "state-object", "FOLDER/2", &other_fmt), "чужой формат");
    let mut other_gen = st.clone();
    other_gen.generation = 4;
    bad(store::open_record(&dek, &sid, 4, "state-object", "FOLDER/2", &other_gen), "чужое поколение");
    bad(store::open_record(&dek, &[2u8; 16], 3, "state-object", "FOLDER/2", &st), "чужой профиль");
    bad(store::open_record(&[8u8; 32], &sid, 3, "state-object", "FOLDER/2", &st), "чужой DEK");
    // Заголовок записи не совпадает с ключом носителя.
    bad(store::open_record(&dek, &sid, 3, "history-row", "FOLDER/2", &st), "вид ключа ≠ вид записи");
    // Тот же путь через Store: запись, переложенная под другой ключ, не открывается.
    let mut host = Host::default();
    let mut s = fresh(&mut host);
    write(&mut s, &mut host, "state-object", "A", b"a");
    let k = store::record_key(1, "state-object", "A");
    let moved = store::record_key(1, "state-object", "B");
    assert!(s.open(&k, &host.kv[&k]).is_ok());
    assert!(s.open(&moved, &host.kv[&k]).is_err(), "переложенная запись открылась");
}

#[test]
fn pin_kek_vectors() {
    let v = load("wrap.json");
    for c in cases(&v) {
        let i = &c["input"];
        let kek = store::pin_kek(i["pin"].as_str().unwrap(), &unhex(i, "salt_hex"), i["iterations"].as_u64().unwrap() as u32);
        assert_eq!(kek.to_vec(), unhex(&c["expect"], "kek_hex"), "{}", c["name"]);
        assert_eq!(store::pin_check(&kek).to_vec(), unhex(&c["expect"], "check_hex"), "{}", c["name"]);
    }
}

/// Установка/смена/снятие PIN — одна пачка, в ней только корень; записи данных не трогаются (FR-021).
#[test]
fn wrap_flows_touch_only_root() {
    let v = load("wrap.json");
    for c in v["cases_flow"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let mut host = Host::default();
        let mut s: Option<Store> = None;
        let mut last_wrap_batch: Option<StoreBatch> = None;
        for step in c["steps"].as_array().unwrap() {
            let step = step.as_str().unwrap();
            let st = s.get_or_insert_with(Store::create);
            let b = if step == "device" {
                st.wrap_device(&DEVICE_KEY).unwrap()
            } else if step == "put" {
                st.write(&[("state-object", "FOLDER/2", b"work"), ("state-object", "CONTACT/bob@x", b"note")], &[]).unwrap()
            } else if let Some(pin) = step.strip_prefix("set_pin:") {
                let b = st.set_pin_with_iterations(pin, TEST_ITER).unwrap();
                last_wrap_batch = Some(b.clone());
                b
            } else if step == "remove_pin" {
                let b = st.remove_pin(&DEVICE_KEY).unwrap();
                last_wrap_batch = Some(b.clone());
                b
            } else {
                panic!("{name}: шаг {step}")
            };
            host.apply(&b);
            st.committed(b.batch_id).unwrap();
        }
        let before = read_all(s.as_ref().unwrap(), &host);
        assert_eq!(before.len(), 2, "{name}");
        let wb = last_wrap_batch.unwrap();
        if c["expect"]["batch_touches_only_root"].as_bool().unwrap() {
            assert!(wb.deletes.is_empty(), "{name}: смена обёртки удаляет записи");
            assert_eq!(wb.puts.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), vec![store::ROOT_KEY], "{name}: смена обёртки пишет не только корень");
        }
        let kinds: Vec<&str> = host
            .root()
            .wraps
            .iter()
            .map(|w| match &w.kind {
                Some(parvane_protocol::pb::parvane::engine::v1::wrap::Kind::Device(_)) => "device",
                Some(parvane_protocol::pb::parvane::engine::v1::wrap::Kind::Pin(_)) => "pin",
                None => "none",
            })
            .collect();
        let want: Vec<&str> = c["expect"]["wraps"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        assert_eq!(kinds, want, "{name}: обёртки");
        // Повторное открытие (перезапуск): тем, чем можно, — открывается и читает ВСЕ записи; прочим — нет.
        for (how, want) in c["expect"]["reopen"].as_object().unwrap() {
            let mut r = Store::load(&host.kv[store::ROOT_KEY]).unwrap();
            assert_eq!(r.state(), OpenState::Locked, "{name}: после загрузки — заблокировано");
            let res = if how == "device" { r.unlock_device(&DEVICE_KEY) } else { r.unlock_pin(how.strip_prefix("pin:").unwrap()) };
            match want.as_str().unwrap() {
                "ok" => {
                    res.unwrap_or_else(|e| panic!("{name}: {how}: {e:?}"));
                    assert_eq!(read_all(&r, &host), before, "{name}: {how}: записи");
                }
                k => assert_eq!(res.unwrap_err().kind(), k, "{name}: {how}"),
            }
        }
    }
}

/// Довести перенос; `crash_at` — убить процесс сразу после фиксации пачки, на которой перенос дошёл
/// до точки (номер P1–P6). Вернуть true, если «упали».
fn drive(s: &mut Store, host: &mut Host, crash_at: Option<u8>) -> bool {
    for _ in 0..10_000 {
        if crash_at.is_some() && s.rotation_point() == crash_at {
            return true;
        }
        match s.rotation_next().unwrap() {
            RotationAction::Read(r) => {
                let l = host.read(&r);
                s.rotation_loaded(l).unwrap();
            }
            RotationAction::Write(b) => {
                host.apply(&b);
                s.committed(b.batch_id).unwrap();
            }
            RotationAction::Continue => {}
            RotationAction::Done => return false,
            RotationAction::Aborted(errs) => panic!("перенос остановлен: {errs:?}"),
        }
    }
    panic!("перенос не закончился")
}

#[test]
fn generation_rotation_survives_interrupts() {
    let v = load("generation.json");
    let limit = v["batch_limit"].as_u64().unwrap() as u32;
    let recs: Vec<(String, String, Vec<u8>)> = v["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["kind"].as_str().unwrap().to_string(), r["name"].as_str().unwrap().to_string(), unhex(r, "plain_hex")))
        .collect();
    for c in cases(&v) {
        let name = c["name"].as_str().unwrap();
        let crash_at = c["interrupt_at"].as_u64().map(|x| x as u8);
        let mut host = Host::default();
        let mut s = fresh(&mut host);
        s.set_batch_limit(limit);
        for (k, n, p) in &recs {
            write(&mut s, &mut host, k, n, p);
        }
        let original = read_all(&s, &host);
        assert_eq!(original.len(), recs.len());
        let b = s.set_pin_with_iterations("2580", TEST_ITER).unwrap();
        host.apply(&b);
        s.committed(b.batch_id).unwrap();
        let b = s.begin_rotation().unwrap();
        host.apply(&b);
        s.committed(b.batch_id).unwrap();
        let crashed = drive(&mut s, &mut host, crash_at);
        assert_eq!(crashed, crash_at.is_some(), "{name}: точка {crash_at:?} не достигнута");
        drop(s);
        // Перезапуск: одно активное поколение, все записи открываются.
        let mut r = Store::load(&host.kv[store::ROOT_KEY]).unwrap();
        r.unlock_pin("2580").unwrap();
        r.set_batch_limit(limit);
        assert_eq!(r.root().active_generation, c["expect"]["active_after_crash"].as_u64().unwrap() as u32, "{name}: активное после падения");
        assert_eq!(read_all(&r, &host), original, "{name}: после падения");
        // Запись во время незаконченного переноса не теряется.
        write(&mut r, &mut host, "outbox", "during", b"x");
        assert!(!drive(&mut r, &mut host, None), "{name}: продолжение");
        let active = r.root().active_generation;
        assert_eq!(active, c["expect"]["active_after_resume"].as_u64().unwrap() as u32, "{name}");
        assert_eq!(r.root().pending_generation, 0, "{name}: pending остался");
        assert_eq!(r.root().retiring_generation, 0, "{name}: retiring остался");
        assert_eq!(host.gen_keys(1).len(), c["expect"]["old_keys_after_resume"].as_u64().unwrap() as usize, "{name}: g1 не удалено");
        let mut want = original.clone();
        want.insert("outbox/during".into(), b"x".to_vec());
        assert_eq!(read_all(&r, &host), want, "{name}: после продолжения");
        // Копия DEK поколения 1 (снятая до PIN) не открывает записи нового поколения.
        let k = host.gen_keys(active).into_iter().next().unwrap();
        let st = Stored::decode(host.kv[&k].as_slice()).unwrap();
        let (g, kind, nm) = store::parse_key(&k).unwrap();
        assert!(store::open_record(&[0u8; 32], &r.root().store_id, g, kind, nm, &st).is_err());
    }
}

/// Ошибка расшифровки записи g останавливает перенос: g остаётся активным, pending откатывается (FR-024).
#[test]
fn rotation_stops_on_undecryptable_record() {
    let mut host = Host::default();
    let mut s = fresh(&mut host);
    write(&mut s, &mut host, "state-object", "A", b"a");
    let k = store::record_key(1, "state-object", "A");
    let mut st = Stored::decode(host.kv[&k].as_slice()).unwrap();
    if let Some(b) = st.payload.last_mut() {
        *b ^= 1;
    }
    host.kv.insert(k.clone(), st.encode_to_vec());
    let b = s.begin_rotation().unwrap();
    host.apply(&b);
    s.committed(b.batch_id).unwrap();
    let mut aborted = None;
    for _ in 0..100 {
        match s.rotation_next().unwrap() {
            RotationAction::Read(r) => {
                let l = host.read(&r);
                let _ = s.rotation_loaded(l);
            }
            RotationAction::Write(b) => {
                host.apply(&b);
                s.committed(b.batch_id).unwrap();
            }
            RotationAction::Continue => {}
            RotationAction::Done => panic!("перенос прошёл с испорченной записью"),
            RotationAction::Aborted(e) => {
                aborted = Some(e);
                break;
            }
        }
    }
    let errs = aborted.expect("перенос не остановлен");
    assert!(errs.iter().any(|e| e.contains("g1/state-object/A")), "в отчёте нет записи: {errs:?}");
    let root = host.root();
    assert_eq!((root.active_generation, root.pending_generation), (1, 0));
    assert!(host.kv.contains_key(&k), "испорченная запись выброшена");
    assert!(host.gen_keys(2).is_empty(), "остатки g2");
}

#[test]
fn too_new_issues_no_batches() {
    let v = load("too_new.json");
    for c in cases(&v) {
        let name = c["name"].as_str().unwrap();
        let mut host = Host::default();
        let mut s = fresh(&mut host);
        write(&mut s, &mut host, "state-object", "A", b"a");
        let mut root = host.root();
        for kf in c["input"]["kinds_max_format"].as_array().unwrap() {
            let kind = kf["kind"].as_str().unwrap().to_string();
            let format = kf["format"].as_u64().unwrap() as u32;
            root.kinds_max_format.retain(|x| x.kind != kind);
            root.kinds_max_format.push(KindFormat { kind, format });
        }
        host.kv.insert(store::ROOT_KEY.into(), root.encode_to_vec());
        let mut r = Store::load(&host.kv[store::ROOT_KEY]).unwrap();
        r.unlock_device(&DEVICE_KEY).unwrap();
        let e = &c["expect"];
        let want_state = match e["state"].as_str().unwrap() {
            "TOO_NEW" => OpenState::TooNew,
            _ => OpenState::Ready,
        };
        assert_eq!(r.state(), want_state, "{name}");
        let k = store::record_key(1, "state-object", "A");
        assert_eq!(r.open(&k, &host.kv[&k]).unwrap(), b"a", "{name}: чтение известного");
        let res = |x: parvane_protocol::Result<StoreBatch>| match x {
            Ok(_) => "ok".to_string(),
            Err(e) => e.kind().to_string(),
        };
        assert_eq!(res(r.write(&[("state-object", "B", b"b")], &[])), e["write"].as_str().unwrap(), "{name}: запись");
        assert_eq!(res(r.set_pin_with_iterations("1", TEST_ITER)), e["set_pin"].as_str().unwrap(), "{name}: PIN");
        let mut r2 = Store::load(&host.kv[store::ROOT_KEY]).unwrap();
        r2.unlock_device(&DEVICE_KEY).unwrap();
        assert_eq!(res(r2.begin_rotation()), e["rotation"].as_str().unwrap(), "{name}: перенос");
    }
    for c in v["records"].as_array().unwrap() {
        let mut host = Host::default();
        let mut s = fresh(&mut host);
        write(&mut s, &mut host, "state-object", "A", b"a");
        let k = store::record_key(1, "state-object", "A");
        let mut st = Stored::decode(host.kv[&k].as_slice()).unwrap();
        st.format = c["input"]["format"].as_u64().unwrap() as u32;
        let got = s.open(&k, &st.encode_to_vec());
        check(c["name"].as_str().unwrap(), &got, &c["expect"]);
    }
}
