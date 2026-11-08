//! spec 035 T043: хранилище движка для web (`parvane_protocol::store`, contracts/storage.md). Движок sans-IO:
//! выпускает пачки (одна транзакция IndexedDB у `v2/storeIdb.ts`) и чтения; DEK живёт только здесь, в памяти
//! WASM. KEK обёртки PIN выводит хост (WebCrypto PBKDF2-SHA256 — тот же результат, что `store::pin_kek`),
//! ключ устройства — 32 байта, которые хост держит под non-extractable ключом WebCrypto (решение T043 в
//! отчёте фазы 4: так движок может обернуть DEK нового поколения тем же ключом).
//!
//! Пачка в JS — `{batchId, puts: [{key, value: Uint8Array}], deletes: string[]}`.

use js_sys::{Array, Object, Reflect, Uint8Array};
use parvane_protocol::pb::parvane::engine::v1::{wrap, StoreBatch, StoreLoaded, StorePut};
use parvane_protocol::store::{OpenState, RotationAction, Store};
use parvane_protocol::ProtoError;
use prost::Message;
use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::err_proto;

fn set(o: &Object, k: &str, v: &JsValue) {
    let _ = Reflect::set(o, &JsValue::from_str(k), v);
}

fn batch_js(b: &StoreBatch) -> JsValue {
    let o = Object::new();
    set(&o, "batchId", &JsValue::from_f64(b.batch_id as f64));
    let puts = Array::new();
    for p in &b.puts {
        let e = Object::new();
        set(&e, "key", &JsValue::from_str(&p.key));
        set(&e, "value", &Uint8Array::from(p.value.as_slice()).into());
        puts.push(&e);
    }
    set(&o, "puts", &puts);
    let dels = Array::new();
    for d in &b.deletes {
        dels.push(&JsValue::from_str(d));
    }
    set(&o, "deletes", &dels);
    o.into()
}

fn key32(k: &[u8]) -> Result<[u8; 32], JsValue> {
    k.try_into().map_err(|_| err_proto(ProtoError::InvalidField("key")))
}

fn strings(a: &Array) -> Vec<String> {
    a.iter().map(|v| v.as_string().unwrap_or_default()).collect()
}

fn state_str(s: OpenState) -> &'static str {
    match s {
        OpenState::Ready => "ready",
        OpenState::Locked => "locked",
        OpenState::TooNew => "too_new",
    }
}

/// Открытое хранилище профиля (одна вкладка).
#[wasm_bindgen]
pub struct PvStore {
    inner: Store,
}

/// Открыть хранилище: байты корня (`root`) с носителя либо пусто — новый профиль (поколение 1, новый DEK;
/// обёртку даёт `storeWrapDevice`). Существующее — заблокировано до `storeUnlock`.
#[wasm_bindgen(js_name = storeOpen)]
pub fn store_open(root: &[u8]) -> Result<PvStore, JsValue> {
    let inner = if root.is_empty() { Store::create() } else { Store::load(root).map_err(err_proto)? };
    Ok(PvStore { inner })
}

#[wasm_bindgen]
impl PvStore {
    /// `ready` | `locked` | `too_new`.
    pub fn state(&self) -> String {
        state_str(self.inner.state()).to_string()
    }

    /// Сводка корня (JSON): поколения, чем обёрнуто, соль и итерации PIN.
    #[wasm_bindgen(js_name = rootInfo)]
    pub fn root_info(&self) -> String {
        let r = self.inner.root();
        let wraps: Vec<&str> = r
            .wraps
            .iter()
            .filter(|w| w.generation == r.active_generation)
            .map(|w| match &w.kind {
                Some(wrap::Kind::Device(_)) => "device",
                Some(wrap::Kind::Pin(_)) => "pin",
                None => "none",
            })
            .collect();
        let pin = self.inner.pin_params();
        json!({
            "activeGeneration": r.active_generation,
            "pendingGeneration": r.pending_generation,
            "retiringGeneration": r.retiring_generation,
            "wraps": wraps,
            "pinSalt": pin.as_ref().map(|(s, _)| hex::encode(s)),
            "pinIterations": pin.as_ref().map(|(_, i)| *i),
            "storeId": hex::encode(&r.store_id),
        })
        .to_string()
    }

    /// Байты корня (для записи `root` вне пачки движка не нужны — тесты, сверка).
    #[wasm_bindgen(js_name = rootBytes)]
    pub fn root_bytes(&self) -> Vec<u8> {
        self.inner.root().encode_to_vec()
    }

    /// Разблокировать: ключом устройства (32 байта) либо KEK из PIN (32 байта, `pin = true`).
    #[wasm_bindgen(js_name = storeUnlock)]
    pub fn store_unlock(&mut self, key: &[u8], pin: bool) -> Result<(), JsValue> {
        let k = key32(key)?;
        if pin { self.inner.unlock_pin_kek(&k) } else { self.inner.unlock_device(&k) }.map_err(err_proto)
    }

    /// Разблокировать PIN-строкой (вывод PBKDF2 в движке — медленнее WebCrypto; тесты и запасной путь).
    #[wasm_bindgen(js_name = storeUnlockPin)]
    pub fn store_unlock_pin(&mut self, pin: &str) -> Result<(), JsValue> {
        self.inner.unlock_pin(pin).map_err(err_proto)
    }

    /// Обернуть DEK ключом устройства (новый профиль) — пачка только с корнем.
    #[wasm_bindgen(js_name = storeWrapDevice)]
    pub fn store_wrap_device(&mut self, device_key: &[u8]) -> Result<JsValue, JsValue> {
        let k = key32(device_key)?;
        self.inner.wrap_device(&k).map(|b| batch_js(&b)).map_err(err_proto)
    }

    /// Установить/сменить PIN: обёртка `pin` (соль 16 байт, итерации, KEK хоста) вместо прежней — пачка только
    /// с корнем; записи данных не трогаются (FR-021).
    #[wasm_bindgen(js_name = storeSetPin)]
    pub fn store_set_pin(&mut self, salt: &[u8], iterations: u32, kek: &[u8]) -> Result<JsValue, JsValue> {
        let k = key32(kek)?;
        self.inner.set_pin_kek(salt, iterations, &k).map(|b| batch_js(&b)).map_err(err_proto)
    }

    /// Снять PIN: обёртка ключом устройства — пачка только с корнем.
    #[wasm_bindgen(js_name = storeRemovePin)]
    pub fn store_remove_pin(&mut self, device_key: &[u8]) -> Result<JsValue, JsValue> {
        let k = key32(device_key)?;
        self.inner.remove_pin(&k).map(|b| batch_js(&b)).map_err(err_proto)
    }

    /// Забыть DEK.
    #[wasm_bindgen(js_name = storeLock)]
    pub fn store_lock(&mut self) {
        self.inner.lock();
    }

    /// Корень сменила другая вкладка: принять его (`ready` | `locked` | `too_new`).
    #[wasm_bindgen(js_name = refreshRoot)]
    pub fn refresh_root(&mut self, root: &[u8]) -> Result<String, JsValue> {
        self.inner.refresh_root(root).map(|s| state_str(s).to_string()).map_err(err_proto)
    }

    /// Пачка записей (`kinds[i]`, `names[i]`, `values[i]`: Uint8Array) и удалений (`delKinds[i]`, `delNames[i]`).
    pub fn write(&mut self, kinds: Array, names: Array, values: Array, del_kinds: Array, del_names: Array) -> Result<JsValue, JsValue> {
        let (k, n) = (strings(&kinds), strings(&names));
        let v: Vec<Vec<u8>> = values.iter().map(|x| Uint8Array::new(&x).to_vec()).collect();
        let (dk, dn) = (strings(&del_kinds), strings(&del_names));
        if k.len() != n.len() || k.len() != v.len() || dk.len() != dn.len() {
            return Err(err_proto(ProtoError::InvalidField("write")));
        }
        let puts: Vec<(&str, &str, &[u8])> = (0..k.len()).map(|i| (k[i].as_str(), n[i].as_str(), v[i].as_slice())).collect();
        let dels: Vec<(&str, &str)> = (0..dk.len()).map(|i| (dk[i].as_str(), dn[i].as_str())).collect();
        self.inner.write(&puts, &dels).map(|b| batch_js(&b)).map_err(err_proto)
    }

    /// Открыть запись по ключу носителя и значению.
    pub fn open(&self, key: &str, value: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner.open(key, value).map_err(err_proto)
    }

    /// Хост зафиксировал пачку.
    pub fn committed(&mut self, batch_id: f64) -> Result<(), JsValue> {
        self.inner.committed(batch_id as u64).map_err(err_proto)
    }

    /// Хост не смог зафиксировать пачку.
    pub fn failed(&mut self, batch_id: f64, reason: &str) {
        self.inner.failed(batch_id as u64, reason);
    }

    /// Записей в пачке переноса (тесты).
    #[wasm_bindgen(js_name = setBatchLimit)]
    pub fn set_batch_limit(&mut self, n: u32) {
        self.inner.set_batch_limit(n);
    }

    /// P1 переноса поколения (смена DEK после установки PIN): пачка с корнем.
    #[wasm_bindgen(js_name = beginRotation)]
    pub fn begin_rotation(&mut self) -> Result<JsValue, JsValue> {
        self.inner.begin_rotation().map(|b| batch_js(&b)).map_err(err_proto)
    }

    /// Номер зафиксированной точки переноса (1–6) или 0.
    #[wasm_bindgen(js_name = rotationPoint)]
    pub fn rotation_point(&self) -> u32 {
        self.inner.rotation_point().map(u32::from).unwrap_or(0)
    }

    /// Следующее действие переноса: `{type: 'read', readId, prefix, after, limit}` | `{type: 'write', batch}` |
    /// `{type: 'continue'}` | `{type: 'done'}` | `{type: 'aborted', errors}`.
    #[wasm_bindgen(js_name = rotationNext)]
    pub fn rotation_next(&mut self) -> Result<JsValue, JsValue> {
        let o = Object::new();
        match self.inner.rotation_next().map_err(err_proto)? {
            RotationAction::Read(r) => {
                set(&o, "type", &JsValue::from_str("read"));
                set(&o, "readId", &JsValue::from_f64(r.read_id as f64));
                set(&o, "prefix", &JsValue::from_str(&r.prefix));
                set(&o, "after", &JsValue::from_str(&r.after));
                set(&o, "limit", &JsValue::from_f64(f64::from(r.limit)));
            }
            RotationAction::Write(b) => {
                set(&o, "type", &JsValue::from_str("write"));
                set(&o, "batch", &batch_js(&b));
            }
            RotationAction::Continue => set(&o, "type", &JsValue::from_str("continue")),
            RotationAction::Done => set(&o, "type", &JsValue::from_str("done")),
            RotationAction::Aborted(errors) => {
                set(&o, "type", &JsValue::from_str("aborted"));
                let a = Array::new();
                for e in errors {
                    a.push(&JsValue::from_str(&e));
                }
                set(&o, "errors", &a);
            }
        }
        Ok(o.into())
    }

    /// Прочитанное по `read` переноса: `keys[i]` → `values[i]` (Uint8Array).
    #[wasm_bindgen(js_name = rotationLoaded)]
    pub fn rotation_loaded(&mut self, read_id: f64, keys: Array, values: Array) -> Result<(), JsValue> {
        let ks = strings(&keys);
        let vs: Vec<Vec<u8>> = values.iter().map(|x| Uint8Array::new(&x).to_vec()).collect();
        if ks.len() != vs.len() {
            return Err(err_proto(ProtoError::InvalidField("loaded")));
        }
        let entries = ks.into_iter().zip(vs).map(|(key, value)| StorePut { key, value }).collect();
        self.inner.rotation_loaded(StoreLoaded { read_id: read_id as u64, entries }).map_err(err_proto)
    }
}
