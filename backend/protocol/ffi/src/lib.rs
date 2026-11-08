//! C ABI движка `parvane-protocol` (desktop parvane-core, android jni).
//! Единственное место с `unsafe`: граница памяти C.
//!
//! Правила владения:
//! - строки, которые возвращает движок (`char*`), освобождаются
//!   `parvane_protocol_string_free`;
//! - байтовые буферы (`PvBytes`) — `parvane_protocol_bytes_free`;
//! - модель движка — `pv_engine_free` (клиентское ядро живёт в модели: `pv_engine_call("clientCall", …)`, spec 035);
//! - ошибка возвращается через `char** err` (JSON `{"need":…}`/`{"error":…}`),
//!   её тоже освобождает `parvane_protocol_string_free`.
//! Паника через границу невозможна: движок без паник (clippy deny), а каждая
//! функция (кроме `*_free` и версий) дополнительно обёрнута в `catch_unwind`.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![allow(clippy::missing_safety_doc)]

use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use parvane_protocol::host;

// spec 035 T048: хранилище движка (`pv_store_*`) — отдельным модулем.
mod store;

static VERSION: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();

/// Байтовый буфер движка.
#[repr(C)]
pub struct PvBytes {
    pub data: *mut u8,
    pub len: usize,
}

impl PvBytes {
    fn from_vec(v: Vec<u8>) -> Self {
        let mut b = v.into_boxed_slice();
        let out = PvBytes { data: b.as_mut_ptr(), len: b.len() };
        std::mem::forget(b);
        out
    }
    fn empty() -> Self {
        PvBytes { data: ptr::null_mut(), len: 0 }
    }
}

fn cstring(s: String) -> *mut c_char {
    CString::new(s.replace('\0', "")).map(CString::into_raw).unwrap_or(ptr::null_mut())
}

unsafe fn str_arg<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok()
}

unsafe fn bytes_arg<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if p.is_null() || len == 0 {
        return &[];
    }
    std::slice::from_raw_parts(p, len)
}

unsafe fn set_err(err: *mut *mut c_char, e: String) {
    if !err.is_null() {
        *err = cstring(e);
    }
}

fn bad_arg() -> String {
    r#"{"error":"InvalidField"}"#.to_string()
}

/// Выполнить с перехватом паники; ошибка → err, результат по умолчанию.
unsafe fn guard<T>(err: *mut *mut c_char, default: T, f: impl FnOnce() -> Result<T, String>) -> T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            set_err(err, e);
            default
        }
        Err(_) => {
            set_err(err, r#"{"error":"Panic"}"#.to_string());
            default
        }
    }
}

/// Версия движка (статическая строка, освобождать не нужно).
#[no_mangle]
pub extern "C" fn parvane_protocol_version() -> *const c_char {
    VERSION.as_ptr().cast()
}

/// Мажорная версия протокола.
#[no_mangle]
pub extern "C" fn parvane_protocol_major() -> u32 {
    parvane_protocol::PROTO_MAJOR
}

#[no_mangle]
pub unsafe extern "C" fn parvane_protocol_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

#[no_mangle]
pub unsafe extern "C" fn parvane_protocol_bytes_free(b: PvBytes) {
    if !b.data.is_null() {
        drop(Box::from_raw(std::slice::from_raw_parts_mut(b.data, b.len)));
    }
}

/// spec 035 (FR-046, contracts/versioning.md): `engineInfo()` этой сборки движка — JSON-строка;
/// освобождать `pv_free_string`.
#[no_mangle]
pub extern "C" fn pv_engine_info() -> *mut c_char {
    cstring(parvane_protocol::engine_info_json())
}

/// spec 035 (T070, contracts/engine-api.md): модель движка. Владеет хост; освобождать `pv_engine_free`.
pub struct PvEngine {
    inner: parvane_protocol::model::Engine,
}

const MALFORMED: &str = r#"{"error":"Malformed"}"#;

/// Открыть модель по конфигурации (`EngineConfig`, JSON). NULL — ошибка; тогда `*err` (если не NULL) —
/// JSON `{"error": "<вид>"}`, освобождать `pv_free_string`.
#[no_mangle]
pub unsafe extern "C" fn pv_engine_open(config_json: *const c_char, err: *mut *mut c_char) -> *mut PvEngine {
    let r = catch_unwind(AssertUnwindSafe(|| match str_arg(config_json) {
        Some(cfg) => parvane_protocol::model::Engine::open_json(cfg),
        None => Err(MALFORMED.to_string()),
    }));
    let e = match r {
        Ok(Ok(inner)) => return Box::into_raw(Box::new(PvEngine { inner })),
        Ok(Err(e)) => e,
        Err(_) => MALFORMED.to_string(),
    };
    if !err.is_null() {
        *err = cstring(e);
    }
    ptr::null_mut()
}

/// Вызов модели по имени → JSON результата (ошибка — `{"error": "<вид>"}`, незнакомое имя —
/// `{"error": "UnknownCall"}`); освобождать `pv_free_string`. `args_json` NULL — `{}`.
#[no_mangle]
pub unsafe extern "C" fn pv_engine_call(e: *mut PvEngine, name: *const c_char, args_json: *const c_char) -> *mut c_char {
    if e.is_null() {
        return cstring(MALFORMED.to_string());
    }
    let r = catch_unwind(AssertUnwindSafe(|| match str_arg(name) {
        Some(name) => (*e).inner.call(name, str_arg(args_json).unwrap_or("{}")),
        None => MALFORMED.to_string(),
    }));
    cstring(r.unwrap_or_else(|_| MALFORMED.to_string()))
}

/// Закрыть модель.
#[no_mangle]
pub unsafe extern "C" fn pv_engine_free(e: *mut PvEngine) {
    if !e.is_null() {
        drop(Box::from_raw(e));
    }
}

/// Освободить строку движка (то же, что `parvane_protocol_string_free`; имя из contracts/versioning.md).
#[no_mangle]
pub unsafe extern "C" fn pv_free_string(s: *mut c_char) {
    parvane_protocol_string_free(s)
}

/// Полные имена всех сообщений схемы — JSON-массив строк (тесты кодеков во всех обвязках, spec 035 T012);
/// освобождать `pv_free_string`.
#[no_mangle]
pub extern "C" fn pv_schema_message_names() -> *mut c_char {
    cstring(serde_json::to_string(&parvane_protocol::schema::MESSAGES.iter().map(|m| m.name).collect::<Vec<_>>()).unwrap_or_default())
}

// ── единая точка входа (spec 029): функции движка по именам WASM-обвязки ───

fn parse_args(args: *const c_char) -> Result<serde_json::Value, String> {
    // SAFETY: строка C или null — проверяет str_arg
    let s = unsafe { str_arg(args) }.unwrap_or("{}");
    let s = if s.trim().is_empty() { "{}" } else { s };
    serde_json::from_str(s).map_err(|_| r#"{"error":"Malformed"}"#.to_string())
}

/// Функции без клиента по имени WASM (действия клиента — `clientCall` модели, `pv_engine_call`).
#[no_mangle]
pub unsafe extern "C" fn pv_call(name: *const c_char, args: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let name = str_arg(name).ok_or_else(bad_arg)?;
        host::call::call_static(name, &parse_args(args)?).map(|v| cstring(v.to_string()))
    })
}

// ── клиент ──────────────────────────────────────────────────────────────────

// ── отзыв своего устройства (T128; D-11, D-12, D-16) ────────────────────────

// ── эфемерные каналы: «печатает» и присутствие (T127) ───────────────────────

// ── группы v2: журнал, ссылки (T056/T080/T084/T125) ─────────────────────────

/// Разобрать ссылку-приглашение → `{"kind":"v2","domain","linkId"}` |
/// `{"kind":"legacy","token"}`; ошибка (в err) — не ссылка-приглашение.
#[no_mangle]
pub unsafe extern "C" fn pv_parse_invite(url: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || host::parse_invite(str_arg(url).ok_or_else(bad_arg)?).map(cstring))
}

// ── режим «усиленная приватность» (L2, T079) ────────────────────────────────

// ── журнал истории аккаунта (spec 033, HIST-1/HIST-2/READ-2) ────────────────

// ── журнал личного состояния (T098, STATE-1) ────────────────────────────────

// ── кадры и помощники ───────────────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn pv_encode_hello(channel: i32, kind: *const c_char, version: *const c_char) -> PvBytes {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    PvBytes::from_vec(host::encode_hello(channel, str_arg(kind).unwrap_or(""), str_arg(version).unwrap_or("")))
})).unwrap_or_else(|_| PvBytes::empty())
}

#[no_mangle]
pub unsafe extern "C" fn pv_encode_auth(token: *const c_char) -> PvBytes {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    PvBytes::from_vec(host::encode_auth(str_arg(token).unwrap_or("")))
})).unwrap_or_else(|_| PvBytes::empty())
}

#[no_mangle]
pub unsafe extern "C" fn pv_encode_request(id: u64, method: *const c_char, body: *const u8, len: usize, timeout_ms: u32) -> PvBytes {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    PvBytes::from_vec(host::encode_request(id, str_arg(method).unwrap_or(""), bytes_arg(body, len), timeout_ms))
})).unwrap_or_else(|_| PvBytes::empty())
}

/// Запрос объекту сервера `dest` (spec 028, FED-1; пусто — свой сервер), с дополнением кадра до кратного
/// `pad_to` (spec 025, режим L2; 0 — без дополнения).
#[no_mangle]
pub unsafe extern "C" fn pv_encode_request_to(
    id: u64,
    method: *const c_char,
    body: *const u8,
    len: usize,
    timeout_ms: u32,
    dest: *const c_char,
    pad_to: u32,
) -> PvBytes {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    let req = parvane_protocol::pb::parvane::core::v2::Request {
        id,
        method: str_arg(method).unwrap_or("").into(),
        body: bytes_arg(body, len).to_vec(),
        timeout_ms,
        padding: vec![],
        dest_domain: str_arg(dest).unwrap_or("").into(),
    };
    PvBytes::from_vec(if pad_to > 0 {
        parvane_protocol::codec::encode_request_padded(req, pad_to as usize)
    } else {
        parvane_protocol::codec::encode_frame(parvane_protocol::pb::parvane::core::v2::frame::Kind::Request(req))
    })
})).unwrap_or_else(|_| PvBytes::empty())
}

#[no_mangle]
pub unsafe extern "C" fn pv_decode_frame(bytes: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || host::decode_frame(bytes_arg(bytes, len)).map(cstring))
}

#[no_mangle]
pub unsafe extern "C" fn pv_verify_server_descriptor(bytes: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || host::verify_server_descriptor(bytes_arg(bytes, len)).map(cstring))
}

#[no_mangle]
pub unsafe extern "C" fn pv_split_sync_response(bytes: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || host::split_sync_response(bytes_arg(bytes, len)).map(cstring))
}

#[no_mangle]
pub unsafe extern "C" fn pv_encode_message(type_name: *const c_char, json: *const c_char, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || {
        host::encode_message(str_arg(type_name).ok_or_else(bad_arg)?, str_arg(json).ok_or_else(bad_arg)?).map(PvBytes::from_vec)
    })
}

/// Байты ответа → proto3-JSON по полному имени типа.
#[no_mangle]
pub unsafe extern "C" fn pv_decode_message(type_name: *const c_char, bytes: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || host::decode_message(str_arg(type_name).ok_or_else(bad_arg)?, bytes_arg(bytes, len)).map(cstring))
}

/// Тело запроса любого метода реестра из proto3-JSON (T161).
#[no_mangle]
pub unsafe extern "C" fn pv_encode_method_request(method: *const c_char, json: *const c_char, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || {
        host::encode_method_request(str_arg(method).ok_or_else(bad_arg)?, str_arg(json).ok_or_else(bad_arg)?).map(PvBytes::from_vec)
    })
}

/// Ответ любого метода реестра → proto3-JSON (T161).
#[no_mangle]
pub unsafe extern "C" fn pv_decode_method_response(method: *const c_char, bytes: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || host::decode_method_response(str_arg(method).ok_or_else(bad_arg)?, bytes_arg(bytes, len)).map(cstring))
}

/// Число записей в ответе `identity.device.log_sync_anon` (есть ли у
/// пользователя журнал устройств v2). -1 — ответ не разобран (подробности в err).
#[no_mangle]
pub unsafe extern "C" fn pv_device_log_entries(bytes: *const u8, len: usize, err: *mut *mut c_char) -> i64 {
    guard(err, -1, || host::device_log_entries(bytes_arg(bytes, len)).map(|n| i64::try_from(n).unwrap_or(i64::MAX)))
}

/// Прогнать набор векторов conformance движком: число сошедшихся случаев
/// или −1 (описание расхождения — в `err`).
#[no_mangle]
pub unsafe extern "C" fn pv_run_conformance_vectors(suite: *const c_char, json: *const c_char, err: *mut *mut c_char) -> i64 {
    guard(err, -1, || {
        let (Some(s), Some(j)) = (str_arg(suite), str_arg(json)) else { return Err(bad_arg()) };
        parvane_protocol::conformance::run(s, j).map(|n| n as i64)
    })
}

/// base64 → байты (для тел запросов/записей из JSON-ответов движка).
#[no_mangle]
pub unsafe extern "C" fn pv_from_base64(s: *const c_char, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || host::from_b64(str_arg(s).ok_or_else(bad_arg)?).map(PvBytes::from_vec))
}

// ── C1-06: резервная копия корня под ключом восстановления ────────────────────

/// Материал гранта линковки (строка JSON) + копия корня под ключом
/// восстановления (поле `rb`) → новая строка материала. NULL — ошибка.
#[no_mangle]
pub unsafe extern "C" fn pv_grant_with_root_backup(material: *const c_char, backup: *const u8, len: usize) -> *mut c_char {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    let Some(m) = str_arg(material) else { return ptr::null_mut() };
    match host::grant_with_root_backup(m.as_bytes(), bytes_arg(backup, len)) {
        Ok(v) => cstring(String::from_utf8_lossy(&v).into_owned()),
        Err(_) => ptr::null_mut(),
    }
})).unwrap_or_else(|_| ptr::null_mut())
}

/// Копия корня из материала гранта (пустой буфер — гранта без копии).
#[no_mangle]
pub unsafe extern "C" fn pv_grant_root_backup(material: *const c_char) -> PvBytes {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    match str_arg(material).and_then(|m| host::grant_root_backup(m.as_bytes())) {
        Some(v) => PvBytes::from_vec(v),
        None => PvBytes::empty(),
    }
})).unwrap_or_else(|_| PvBytes::empty())
}

/// T130: корень (32 байта) из копии под ключом восстановления на устройстве
/// без журнала. Пустой буфер — ошибка (в `err`: неверный ключ/копия).
#[no_mangle]
pub unsafe extern "C" fn pv_import_root_backup_for(user: *const c_char, blob: *const u8, len: usize, recovery_key: *const c_char, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || {
        let user = str_arg(user).ok_or_else(bad_arg)?;
        let key = str_arg(recovery_key).ok_or_else(bad_arg)?;
        host::import_root_backup_for(user, bytes_arg(blob, len), key).map(|r| PvBytes::from_vec(r.to_vec()))
    })
}

/// Новый ключ восстановления (≥ 128 бит) — строка для показа пользователю
/// (освобождать `parvane_protocol_string_free`).
#[no_mangle]
pub extern "C" fn pv_generate_recovery_key() -> *mut c_char {
    catch_unwind(|| cstring(host::generate_recovery_key().to_string())).unwrap_or(ptr::null_mut())
}

// ── C2-01: планировщик соединений анонимного канала ─────────────────────────

/// Планировщик анонимных соединений (sans-IO; непрозрачный указатель,
/// освобождать `pv_anon_planner_free`). Правила: соединение — одному
/// получателю (пользователю или группе) и в серии ≤ 60 с с открытия;
/// публичные запросы (журналы, бандлы, ключи жетонов) — всегда новое
/// одноразовое соединение.
pub struct PvAnonPlanner {
    inner: parvane_protocol::access::AnonPlanner,
}

#[no_mangle]
pub extern "C" fn pv_anon_planner_new() -> *mut PvAnonPlanner {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    Box::into_raw(Box::new(PvAnonPlanner { inner: parvane_protocol::access::AnonPlanner::new() }))
})).unwrap_or_else(|_| ptr::null_mut())
}

#[no_mangle]
pub unsafe extern "C" fn pv_anon_planner_free(p: *mut PvAnonPlanner) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

/// Запрос анонимного канала (метод + тело) → JSON `{"conn":N,"open":bool,
/// "closeAfter":bool}`: `open` — открыть новое соединение ANONYMOUS_DELIVERY
/// под номером `conn`, `closeAfter` — закрыть сразу после ответа.
#[no_mangle]
pub unsafe extern "C" fn pv_anon_planner_assign(p: *mut PvAnonPlanner, method: *const c_char, body: *const u8, len: usize, now_ms: i64, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let p = p.as_mut().ok_or_else(bad_arg)?;
        let t = parvane_protocol::access::anon_target(str_arg(method).ok_or_else(bad_arg)?, bytes_arg(body, len)).map_err(host::err)?;
        let a = p.inner.assign(t, now_ms);
        Ok(cstring(format!(r#"{{"conn":{},"open":{},"closeAfter":{}}}"#, a.conn, a.open, a.close_after)))
    })
}

/// Соединения, серия которых истекла, — JSON-массив номеров (закрыть).
#[no_mangle]
pub unsafe extern "C" fn pv_anon_planner_expired(p: *mut PvAnonPlanner, now_ms: i64) -> *mut c_char {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    let Some(p) = p.as_mut() else { return cstring("[]".into()) };
    let ids: Vec<String> = p.inner.expired(now_ms).into_iter().map(|c| c.to_string()).collect();
    cstring(format!("[{}]", ids.join(",")))
})).unwrap_or_else(|_| ptr::null_mut())
}

/// Соединение закрылось (обрыв/таймаут) — больше не выдавать.
#[no_mangle]
pub unsafe extern "C" fn pv_anon_planner_closed(p: *mut PvAnonPlanner, conn: u64) {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    if let Some(p) = p.as_mut() {
        p.inner.closed(conn);
    }
})).unwrap_or_else(|_| ())
}

/// Открытых соединений с получателем (для тестов/диагностики).
#[no_mangle]
pub unsafe extern "C" fn pv_anon_planner_open_count(p: *const PvAnonPlanner) -> usize {
    // A0001-1: паника в движке не пересекает границу C
    catch_unwind(AssertUnwindSafe(|| {
    p.as_ref().map(|p| p.inner.open_count()).unwrap_or(0)
})).unwrap_or_else(|_| 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// spec 035 T014: `pv_engine_info` — та же `engineInfo()`, что у движка этой сборки.
    #[test]
    fn engine_info_over_c_abi() {
        unsafe {
            let p = pv_engine_info();
            let s = CStr::from_ptr(p).to_str().unwrap().to_string();
            pv_free_string(p);
            assert_eq!(s, parvane_protocol::engine_info_json());
            let v: serde_json::Value = serde_json::from_str(&s).unwrap();
            assert_eq!(v["protoMinor"], parvane_protocol::limits::PROTO_MINOR_035);
            assert_eq!(v["engineApi"], parvane_protocol::ENGINE_API);
        }
    }

    /// spec 035 T070: модель движка через C ABI — открытие, `start` (чтение корня), незнакомый вызов, ошибка
    /// открытия, освобождение.
    #[test]
    fn engine_model_over_c_abi() {
        unsafe {
            let mut err: *mut c_char = ptr::null_mut();
            let bad = CString::new(r#"{"user":"нет","device_id":"d1"}"#).unwrap();
            assert!(pv_engine_open(bad.as_ptr(), &mut err).is_null());
            let e = CStr::from_ptr(err).to_str().unwrap().to_string();
            pv_free_string(err);
            assert_eq!(e, r#"{"error":"BadAddress"}"#);
            let cfg = CString::new(r#"{"user":"alice@local","device_id":"d1","domain":"local","device_key":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="}"#).unwrap();
            let eng = pv_engine_open(cfg.as_ptr(), ptr::null_mut());
            assert!(!eng.is_null());
            let name = CString::new("start").unwrap();
            let p = pv_engine_call(eng, name.as_ptr(), ptr::null());
            let out: serde_json::Value = serde_json::from_str(CStr::from_ptr(p).to_str().unwrap()).unwrap();
            pv_free_string(p);
            assert_eq!(out["store_reads"][0]["keys"][0], "root");
            let name = CString::new("nope").unwrap();
            let p = pv_engine_call(eng, name.as_ptr(), ptr::null());
            assert_eq!(CStr::from_ptr(p).to_str().unwrap(), r#"{"error":"UnknownCall"}"#);
            pv_free_string(p);
            pv_engine_free(eng);
        }
    }

    /// spec 035 T012: каждое сообщение схемы проходит кругооборот через C ABI `pv_encode_message`/
    /// `pv_decode_message` (пустое и «максимально заполненное»).
    #[test]
    fn every_schema_message_has_a_codec_over_c_abi() {
        unsafe {
            let p = pv_schema_message_names();
            let names: Vec<String> = serde_json::from_str(CStr::from_ptr(p).to_str().unwrap()).unwrap();
            pv_free_string(p);
            assert_eq!(names.len(), parvane_protocol::schema::MESSAGES.len());
            for n in &names {
                let tn = CString::new(n.as_str()).unwrap();
                let full = parvane_protocol::schema::sample_bytes(n).unwrap();
                let mut err: *mut c_char = ptr::null_mut();
                let j = pv_decode_message(tn.as_ptr(), full.as_ptr(), full.len(), &mut err);
                assert!(!j.is_null() && err.is_null(), "{n}: decode");
                let json = CStr::from_ptr(j).to_str().unwrap().to_string();
                parvane_protocol_string_free(j);
                let jc = CString::new(json.clone()).unwrap();
                let b = pv_encode_message(tn.as_ptr(), jc.as_ptr(), &mut err);
                assert!(err.is_null(), "{n}: encode");
                let again = std::slice::from_raw_parts(b.data, b.len).to_vec();
                parvane_protocol_bytes_free(b);
                assert_eq!(parvane_protocol::host::decode_message(n, &again).unwrap(), json, "{n}: кругооборот");
            }
            let mut err: *mut c_char = ptr::null_mut();
            let bad = CString::new("parvane.nope.v1.Nope").unwrap();
            let e = CString::new("{}").unwrap();
            let _ = pv_encode_message(bad.as_ptr(), e.as_ptr(), &mut err);
            assert!(!err.is_null(), "незнакомый тип принят");
            parvane_protocol_string_free(err);
        }
    }

    #[test]
    fn version_is_c_string() {
        let s = unsafe { std::ffi::CStr::from_ptr(parvane_protocol_version()) };
        assert_eq!(s.to_str().ok(), Some(parvane_protocol::version()));
        assert_eq!(parvane_protocol_major(), 2);
    }

    #[test]
    fn grant_carries_root_backup() {
        // T128: копия корня под ключом восстановления едет с грантом линковки (`rb`).
        let material = br#"{"ssk":"00","log":"","dk":"00","gen":1}"#;
        assert!(host::grant_root_backup(material).is_none());
        let with = host::grant_with_root_backup(material, &[1, 2, 3]).unwrap();
        assert_eq!(host::grant_root_backup(&with).unwrap(), vec![1, 2, 3]);
        let text = String::from_utf8(with).unwrap();
        assert!(text.contains(r#""ssk":"00""#) && text.contains(r#""gen":1"#), "прежние поля гранта целы: {text}");
        assert!(host::grant_with_root_backup(b"not json", &[1]).is_err());
        assert!(host::grant_with_root_backup(material, &[]).is_err());
    }
}
