//! spec 035 T048: хранилище движка через C ABI (desktop parvane-core, android jni) — `parvane_protocol::store`
//! (contracts/storage.md). Граница — proto3-JSON типов `parvane.engine.v1` (пачка `StoreBatch` идёт прямо в
//! `store_fs::Store::commitJson`, прочитанное — `StoreLoaded` из `readJson`). DEK живёт только здесь.

use std::ffi::c_char;
use std::ptr;

use base64::Engine as _;
use parvane_protocol::pb::parvane::engine::v1::{wrap, StoreBatch, StoreLoaded};
use parvane_protocol::store::{OpenState, RotationAction, Store};
use prost::Message;
use serde_json::{json, Value};

use super::{bad_arg, bytes_arg, cstring, guard, str_arg, PvBytes};

/// Хранилище движка профиля (непрозрачный указатель, освобождать `pv_store_free`).
pub struct PvStoreHandle {
    inner: Store,
}

fn perr(e: parvane_protocol::ProtoError) -> String {
    json!({"error": e.kind()}).to_string()
}

fn batch_json(b: &StoreBatch) -> Result<*mut c_char, String> {
    serde_json::to_string(b).map(cstring).map_err(|_| perr(parvane_protocol::ProtoError::Malformed))
}

fn key32(p: *const u8, len: usize) -> Result<[u8; 32], String> {
    // SAFETY: вызывающий передаёт буфер длиной `len`.
    unsafe { bytes_arg(p, len) }.try_into().map_err(|_| bad_arg())
}

fn state_str(s: OpenState) -> &'static str {
    match s {
        OpenState::Ready => "ready",
        OpenState::Locked => "locked",
        OpenState::TooNew => "too_new",
    }
}

unsafe fn handle<'a>(h: *mut PvStoreHandle) -> Result<&'a mut Store, String> {
    h.as_mut().map(|x| &mut x.inner).ok_or_else(bad_arg)
}

/// Открыть хранилище: байты корня (`root`) либо пусто (`len = 0`) — новый профиль (поколение 1, новый DEK;
/// обёртку даёт `pv_store_wrap_device`). Существующее — заблокировано до `pv_store_unlock_*`.
#[no_mangle]
pub unsafe extern "C" fn pv_store_open(root: *const u8, len: usize, err: *mut *mut c_char) -> *mut PvStoreHandle {
    guard(err, ptr::null_mut(), || {
        let bytes = bytes_arg(root, len);
        let inner = if bytes.is_empty() { Store::create() } else { Store::load(bytes).map_err(perr)? };
        Ok(Box::into_raw(Box::new(PvStoreHandle { inner })))
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_store_free(h: *mut PvStoreHandle) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

/// Состояние и сводка корня (JSON: `state`, `activeGeneration`, `pendingGeneration`, `retiringGeneration`,
/// `wraps`); освобождать `pv_free_string`.
#[no_mangle]
pub unsafe extern "C" fn pv_store_info(h: *mut PvStoreHandle) -> *mut c_char {
    let Some(s) = h.as_ref().map(|x| &x.inner) else { return ptr::null_mut() };
    let r = s.root();
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
    cstring(
        json!({
            "state": state_str(s.state()),
            "activeGeneration": r.active_generation,
            "pendingGeneration": r.pending_generation,
            "retiringGeneration": r.retiring_generation,
            "wraps": wraps,
        })
        .to_string(),
    )
}

/// Байты корня (сверка корня на носителе).
#[no_mangle]
pub unsafe extern "C" fn pv_store_root(h: *mut PvStoreHandle) -> PvBytes {
    match h.as_ref() {
        Some(x) => PvBytes::from_vec(x.inner.root().encode_to_vec()),
        None => PvBytes::empty(),
    }
}

/// Разблокировать ключом устройства (32 байта: desktop — производная локального ключа tdata, android —
/// ключ под Android Keystore; тот же, что у `storecrypt::setKey`).
#[no_mangle]
pub unsafe extern "C" fn pv_store_unlock_device(h: *mut PvStoreHandle, key: *const u8, len: usize, err: *mut *mut c_char) -> bool {
    guard(err, false, || {
        let k = key32(key, len)?;
        handle(h)?.unlock_device(&k).map_err(perr)?;
        Ok(true)
    })
}

/// Разблокировать PIN (обёртка `pin`). Неверный PIN — ошибка `Crypto`.
#[no_mangle]
pub unsafe extern "C" fn pv_store_unlock_pin(h: *mut PvStoreHandle, pin: *const c_char, err: *mut *mut c_char) -> bool {
    guard(err, false, || {
        let pin = str_arg(pin).ok_or_else(bad_arg)?;
        handle(h)?.unlock_pin(pin).map_err(perr)?;
        Ok(true)
    })
}

/// Обернуть DEK ключом устройства (новый профиль, снятие PIN) — пачка только с корнем (JSON `StoreBatch`).
#[no_mangle]
pub unsafe extern "C" fn pv_store_wrap_device(h: *mut PvStoreHandle, key: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let k = key32(key, len)?;
        batch_json(&handle(h)?.wrap_device(&k).map_err(perr)?)
    })
}

/// Установить/сменить PIN — пачка только с корнем; записи данных не трогаются (FR-021).
#[no_mangle]
pub unsafe extern "C" fn pv_store_set_pin(h: *mut PvStoreHandle, pin: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let pin = str_arg(pin).ok_or_else(bad_arg)?;
        batch_json(&handle(h)?.set_pin(pin).map_err(perr)?)
    })
}

/// Забыть DEK.
#[no_mangle]
pub unsafe extern "C" fn pv_store_lock(h: *mut PvStoreHandle) {
    if let Some(x) = h.as_mut() {
        x.inner.lock();
    }
}

/// Корень сменил другой процесс того же профиля: принять (JSON состояния как `pv_store_info`).
#[no_mangle]
pub unsafe extern "C" fn pv_store_refresh_root(h: *mut PvStoreHandle, root: *const u8, len: usize, err: *mut *mut c_char) -> bool {
    guard(err, false, || {
        handle(h)?.refresh_root(bytes_arg(root, len)).map_err(perr)?;
        Ok(true)
    })
}

/// Пачка записей и удалений: `{"puts": [{"kind", "name", "value"(base64)}], "deletes": [{"kind", "name"}]}` →
/// JSON `StoreBatch` (во время переноса — в оба поколения).
#[no_mangle]
pub unsafe extern "C" fn pv_store_write(h: *mut PvStoreHandle, ops_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let ops: Value = serde_json::from_str(str_arg(ops_json).ok_or_else(bad_arg)?).map_err(|_| bad_arg())?;
        let b64 = base64::engine::general_purpose::STANDARD;
        let field = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(bad_arg);
        let mut puts = Vec::new();
        for p in ops.get("puts").and_then(Value::as_array).into_iter().flatten() {
            let value = b64.decode(field(p, "value").unwrap_or_default()).map_err(|_| bad_arg())?;
            puts.push((field(p, "kind")?, field(p, "name")?, value));
        }
        let mut dels = Vec::new();
        for d in ops.get("deletes").and_then(Value::as_array).into_iter().flatten() {
            dels.push((field(d, "kind")?, field(d, "name")?));
        }
        let p: Vec<(&str, &str, &[u8])> = puts.iter().map(|(k, n, v)| (k.as_str(), n.as_str(), v.as_slice())).collect();
        let d: Vec<(&str, &str)> = dels.iter().map(|(k, n)| (k.as_str(), n.as_str())).collect();
        batch_json(&handle(h)?.write(&p, &d).map_err(perr)?)
    })
}

/// Открыть запись по ключу носителя и значению; освобождать `parvane_protocol_bytes_free`.
#[no_mangle]
pub unsafe extern "C" fn pv_store_open_record(h: *mut PvStoreHandle, key: *const c_char, value: *const u8, len: usize, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || {
        let key = str_arg(key).ok_or_else(bad_arg)?;
        let plain = handle(h)?.open(key, bytes_arg(value, len)).map_err(perr)?;
        Ok(PvBytes::from_vec(plain))
    })
}

/// Хост зафиксировал пачку.
#[no_mangle]
pub unsafe extern "C" fn pv_store_committed(h: *mut PvStoreHandle, batch_id: u64) {
    if let Some(x) = h.as_mut() {
        let _ = x.inner.committed(batch_id);
    }
}

/// Хост не смог зафиксировать пачку (нет места, ошибка записи).
#[no_mangle]
pub unsafe extern "C" fn pv_store_failed(h: *mut PvStoreHandle, batch_id: u64, reason: *const c_char) {
    if let Some(x) = h.as_mut() {
        x.inner.failed(batch_id, str_arg(reason).unwrap_or(""));
    }
}

/// P1 переноса поколения — JSON `StoreBatch`.
#[no_mangle]
pub unsafe extern "C" fn pv_store_begin_rotation(h: *mut PvStoreHandle, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || batch_json(&handle(h)?.begin_rotation().map_err(perr)?))
}

/// Следующее действие переноса (JSON): `{"type":"read","reads":StoreReads}` | `{"type":"write","batch":StoreBatch}`
/// | `{"type":"continue"}` | `{"type":"done"}` | `{"type":"aborted","errors":[…]}`.
#[no_mangle]
pub unsafe extern "C" fn pv_store_rotation_next(h: *mut PvStoreHandle, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let v = match handle(h)?.rotation_next().map_err(perr)? {
            RotationAction::Read(r) => json!({"type": "read", "reads": serde_json::to_value(&r).map_err(|_| bad_arg())?}),
            RotationAction::Write(b) => json!({"type": "write", "batch": serde_json::to_value(&b).map_err(|_| bad_arg())?}),
            RotationAction::Continue => json!({"type": "continue"}),
            RotationAction::Done => json!({"type": "done"}),
            RotationAction::Aborted(errors) => json!({"type": "aborted", "errors": errors}),
        };
        Ok(cstring(v.to_string()))
    })
}

/// Прочитанное по `read` переноса — JSON `StoreLoaded` (как отдаёт `store_fs::Store::readJson`).
#[no_mangle]
pub unsafe extern "C" fn pv_store_rotation_loaded(h: *mut PvStoreHandle, loaded_json: *const c_char, err: *mut *mut c_char) -> bool {
    guard(err, false, || {
        let loaded: StoreLoaded = serde_json::from_str(str_arg(loaded_json).ok_or_else(bad_arg)?).map_err(|_| bad_arg())?;
        handle(h)?.rotation_loaded(loaded).map_err(perr)?;
        Ok(true)
    })
}
