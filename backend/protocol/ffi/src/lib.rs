//! C ABI движка `parvane-protocol` (desktop parvane-core, android jni).
//! Единственное место с `unsafe`: граница памяти C.
//!
//! Правила владения:
//! - строки, которые возвращает движок (`char*`), освобождаются
//!   `parvane_protocol_string_free`;
//! - байтовые буферы (`PvBytes`) — `parvane_protocol_bytes_free`;
//! - клиент — `pv_client_free`;
//! - ошибка возвращается через `char** err` (JSON `{"need":…}`/`{"error":…}`),
//!   её тоже освобождает `parvane_protocol_string_free`.
//! Паника через границу невозможна: движок без паник (clippy deny), а каждая
//! функция дополнительно обёрнута в `catch_unwind`.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![allow(clippy::missing_safety_doc)]

use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use parvane_protocol::host::{self, HostClient};

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

/// Клиентское ядро устройства (непрозрачный указатель).
pub struct PvClient {
    inner: HostClient,
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

// ── клиент ──────────────────────────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn pv_client_new(user: *const c_char, device: *const c_char, domain: *const c_char, err: *mut *mut c_char) -> *mut PvClient {
    guard(err, ptr::null_mut(), || {
        let (Some(u), Some(d), Some(dm)) = (str_arg(user), str_arg(device), str_arg(domain)) else { return Err(bad_arg()) };
        HostClient::new(u, d, dm).map(|inner| Box::into_raw(Box::new(PvClient { inner })))
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_import(blob: *const u8, len: usize, key: *const u8, key_len: usize, err: *mut *mut c_char) -> *mut PvClient {
    guard(err, ptr::null_mut(), || {
        HostClient::import(bytes_arg(blob, len), bytes_arg(key, key_len)).map(|inner| Box::into_raw(Box::new(PvClient { inner })))
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_free(c: *mut PvClient) {
    if !c.is_null() {
        drop(Box::from_raw(c));
    }
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_export(c: *mut PvClient, key: *const u8, key_len: usize, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || {
        let c = c.as_ref().ok_or_else(bad_arg)?;
        c.inner.export(bytes_arg(key, key_len)).map(PvBytes::from_vec)
    })
}

/// Импорт Olm-аккаунта v1 (JSON-pickle parvane-e2e).
#[no_mangle]
pub unsafe extern "C" fn pv_client_import_v1_account(c: *mut PvClient, pickle_json: *const c_char, err: *mut *mut c_char) -> bool {
    guard(err, false, || {
        let c = c.as_mut().ok_or_else(bad_arg)?;
        c.inner.import_v1_account_json(str_arg(pickle_json).ok_or_else(bad_arg)?).map(|_| true)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_create_identity(c: *mut PvClient, otk: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.create_identity(otk);
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_link_grant_material(c: *mut PvClient, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.link_grant_material();
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_join_with_grant(c: *mut PvClient, material: *const c_char, otk: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.join_with_grant(str_arg(material).ok_or_else(bad_arg)?, otk);
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_otk_request(c: *mut PvClient, n: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = Ok(c.otk_request(n));
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_sync_request(c: *mut PvClient, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = Ok(c.sync_request());
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_ack_request(c: *mut PvClient, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = Ok(c.ack_request());
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_ingest_log(c: *mut PvClient, user: *const c_char, resp: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.ingest_log(str_arg(user).ok_or_else(bad_arg)?, bytes_arg(resp, len));
        r.map(cstring)
    })
}

/// KEY-1 v2: принять смену корня собеседника (после предупреждения).
/// true — ожидавшая смена принята.
#[no_mangle]
pub unsafe extern "C" fn pv_client_accept_root_change(c: *mut PvClient, user: *const c_char, err: *mut *mut c_char) -> bool {
    guard(err, false, || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        c.accept_root_change(str_arg(user).ok_or_else(bad_arg)?)
    })
}

/// T130: восстановление на новом устройстве по корню (32 байта) и ответу
/// `identity.device.log_sync` с версии 0 → JSON-массив запросов.
#[no_mangle]
pub unsafe extern "C" fn pv_client_recover_with_root(
    c: *mut PvClient,
    root: *const u8,
    root_len: usize,
    log_resp: *const u8,
    log_len: usize,
    otk: usize,
    err: *mut *mut c_char,
) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.recover_with_root(bytes_arg(root, root_len), bytes_arg(log_resp, log_len), otk);
        r.map(cstring)
    })
}

/// T130: сброс личности — как `pv_client_create_identity`; первый запрос —
/// `identity.root.rotate`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_reset_identity(c: *mut PvClient, otk: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.reset_identity(otk);
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_ingest_bundle(c: *mut PvClient, user: *const c_char, resp: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.ingest_bundle(str_arg(user).ok_or_else(bad_arg)?, bytes_arg(resp, len)).map(|n| n.to_string());
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_token_request(c: *mut PvClient, list: *const u8, list_len: usize, server_key: *const u8, key_len: usize, count: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.token_request(bytes_arg(list, list_len), bytes_arg(server_key, key_len), count);
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_token_response(c: *mut PvClient, resp: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.token_response(bytes_arg(resp, len)).map(|n| n.to_string());
        r.map(cstring)
    })
}

/// Сигнал звонка собеседнику (D-08): `signal_json` — proto3-JSON
/// `parvane.call.v2.CallSignal`. Запросы — как у `pv_client_prepare_direct`:
/// оффер — `call.ring_sealed`, остальное — `call.signal_sealed` (анонимный канал).
#[no_mangle]
pub unsafe extern "C" fn pv_client_prepare_call(c: *mut PvClient, peer: *const c_char, signal_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.prepare_call(str_arg(peer).ok_or_else(bad_arg)?, str_arg(signal_json).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Сервер отверг ключ доступа собеседника (FORBIDDEN на доставке): он сменил
/// ключ — дальше слепым жетоном. true — ключ был и сброшен (отправку стоит
/// повторить).
#[no_mangle]
pub unsafe extern "C" fn pv_client_delivery_key_rejected(c: *mut PvClient, peer: *const c_char) -> bool {
    match (c.as_mut(), str_arg(peer)) {
        (Some(c), Some(p)) => c.inner.delivery_key_rejected(p),
        _ => false,
    }
}

/// Кто прочитал своё сообщение (по E2E-квитанциям) — JSON-массив
/// `[{"user","tsMs"}]` («Просмотрено» в чате v2, T151).
#[no_mangle]
pub unsafe extern "C" fn pv_client_readers(c: *const PvClient, id: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &c.as_ref().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.readers(str_arg(id).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Известен ли ключ доступа собеседника: сигнал звонка сервер принимает только
/// с ним (слепой жетон для звонков не годится).
#[no_mangle]
pub unsafe extern "C" fn pv_client_has_peer_delivery_key(c: *const PvClient, peer: *const c_char) -> bool {
    match (c.as_ref(), str_arg(peer)) {
        (Some(c), Some(p)) => c.inner.has_peer_delivery_key(p),
        _ => false,
    }
}

// ── отзыв своего устройства (T128; D-11, D-12, D-16) ────────────────────────

/// Отозвать своё другое устройство и выполнить последствия → JSON
/// `{"requests":[…],"pendingKeyShares":[…],"pendingEpochs":[hex…],
/// "epochsNeedAdmin":[hex…],"sskRotationRequired":bool,"stateKeyVersion":n|null}`.
/// Первый запрос — запись журнала (обязателен), остальные — ротации ключей.
#[no_mangle]
pub unsafe extern "C" fn pv_client_revoke_device(c: *mut PvClient, device_id: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.revoke_device(str_arg(device_id).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Выход: JSON запросов с записью журнала, которой устройство убирает само
/// себя (подписана ключом устройства — оставшимся смена SSK не нужна).
#[no_mangle]
pub unsafe extern "C" fn pv_client_leave(c: *mut PvClient, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.leave();
        r.map(cstring)
    })
}

/// Отозвать ключ доступа у собеседника (FR-033; блокировка) → JSON итога как у
/// `pv_client_revoke_device` (заполнены `requests` и `pendingKeyShares`).
#[no_mangle]
pub unsafe extern "C" fn pv_client_revoke_contact_access(c: *mut PvClient, peer: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.revoke_contact_access(str_arg(peer).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Группы v2 — своим новым устройствам (T142): `devices_json` — JSON-массив id
/// устройств. JSON-массив запросов (пустой — пересылать нечего).
#[no_mangle]
pub unsafe extern "C" fn pv_client_share_groups_with_own_devices(c: *mut PvClient, devices_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.share_groups_with_own_devices(str_arg(devices_json).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Раздать текущий ключ доступа собеседнику (отложенное после отзыва).
#[no_mangle]
pub unsafe extern "C" fn pv_client_share_delivery_key(c: *mut PvClient, peer: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.share_delivery_key(str_arg(peer).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Сменить SSK корнем (D-12): `root` — 32 байта секрета корня (из резервной
/// копии под ключом восстановления). JSON-массив запросов.
#[no_mangle]
pub unsafe extern "C" fn pv_client_rotate_ssk(c: *mut PvClient, root: *const u8, root_len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.rotate_ssk(bytes_arg(root, root_len));
        r.map(cstring)
    })
}

/// Свой SSK раскрыт (отозвано державшее его устройство) и ещё не сменён.
#[no_mangle]
pub unsafe extern "C" fn pv_client_own_ssk_exposed(c: *const PvClient) -> bool {
    c.as_ref().map(|c| c.inner.own_ssk_exposed()).unwrap_or(false)
}

// ── эфемерные каналы: «печатает» и присутствие (T127) ───────────────────────

/// Подписаться на каналы чатов `{"peers":[адрес…],"groups":[hex…]}` →
/// JSON-массив запросов `ephemeral.subscribe` (только новые каналы).
#[no_mangle]
pub unsafe extern "C" fn pv_client_eph_subscribe(c: *mut PvClient, chats_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.eph_subscribe(str_arg(chats_json).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Соединение пересоздано — подписок на эфемерные каналы больше нет.
#[no_mangle]
pub unsafe extern "C" fn pv_client_eph_reset(c: *mut PvClient) {
    if let Some(c) = c.as_mut() {
        c.inner.eph_reset();
    }
}

/// «Печатает»: `chat` — адрес собеседника либо hex группы, `action` — номер
/// `TypingAction`. JSON-массив запросов (пустой — канала нет или чат в L2).
#[no_mangle]
pub unsafe extern "C" fn pv_client_eph_typing(c: *const PvClient, chat: *const c_char, action: i32, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &c.as_ref().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.eph_typing(str_arg(chat).ok_or_else(bad_arg)?, action);
        r.map(cstring)
    })
}

/// Своё присутствие → JSON-массив запросов (пустой — L2 активен в каком-то чате).
#[no_mangle]
pub unsafe extern "C" fn pv_client_eph_presence(c: *const PvClient, online: bool, last_seen_ms: i64, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &c.as_ref().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.eph_presence(online, last_seen_ms);
        r.map(cstring)
    })
}

/// Событие подписки `ephemeral` → JSON-массив событий `typing`/`presence`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_eph_open(c: *const PvClient, body: *const u8, len: usize) -> *mut c_char {
    let Some(c) = c.as_ref() else { return ptr::null_mut() };
    let body = if body.is_null() { &[][..] } else { std::slice::from_raw_parts(body, len) };
    // ENG-02/ENG-14: паника через границу C ABI завершает процесс клиента — здесь
    // ввод от собеседника, поэтому перехватываем (null = не разобрано).
    match catch_unwind(AssertUnwindSafe(|| c.inner.eph_open(body))) {
        Ok(s) => cstring(s),
        Err(_) => ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_prepare_direct(c: *mut PvClient, peer: *const c_char, content_json: *const c_char, op_id: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.prepare_direct(
    str_arg(peer).ok_or_else(bad_arg)?,
    str_arg(content_json).ok_or_else(bad_arg)?,
    str_arg(op_id).unwrap_or("")
);
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_open_record(c: *mut PvClient, rec: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.open_record(bytes_arg(rec, len));
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_drain_ready(c: *mut PvClient, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = Ok(c.drain_ready());
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_last_error(c: *mut PvClient, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = Ok(c.last_error().unwrap_or("").to_string());
        r.map(cstring)
    })
}

/// Группа, переводимая из v1 (T180): `migrated_from` — прежний `group_id`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_create_from(c: *mut PvClient, kind: i32, name: *const c_char, members_json: *const c_char, perms_json: *const c_char, migrated_from: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.group_create_from(
            kind,
            str_arg(name).ok_or_else(bad_arg)?,
            str_arg(members_json).ok_or_else(bad_arg)?,
            str_arg(perms_json).ok_or_else(bad_arg)?,
            str_arg(migrated_from).ok_or_else(bad_arg)?,
        );
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_group_create(c: *mut PvClient, kind: i32, name: *const c_char, members_json: *const c_char, perms_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.group_create(
    kind,
    str_arg(name).ok_or_else(bad_arg)?,
    str_arg(members_json).ok_or_else(bad_arg)?,
    str_arg(perms_json).ok_or_else(bad_arg)?
);
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_group_ingest(c: *mut PvClient, domain: *const c_char, group: *const c_char, resp: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c
    .group_ingest(str_arg(domain).ok_or_else(bad_arg)?, str_arg(group).ok_or_else(bad_arg)?, bytes_arg(resp, len))
    .map(|v| v.to_string());
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_group_change(c: *mut PvClient, group: *const c_char, change_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.group_change(str_arg(group).ok_or_else(bad_arg)?, str_arg(change_json).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Решение по заявке на вступление в группу: JSON запроса `group.request.decide`
/// (одобрение — запись `AddMember`, локальный журнал уже продвинут).
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_request_decide(c: *mut PvClient, group: *const c_char, user: *const c_char, approve: bool, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.group_request_decide(str_arg(group).ok_or_else(bad_arg)?, str_arg(user).ok_or_else(bad_arg)?, approve);
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_group_rotate_epoch(c: *mut PvClient, group: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.group_rotate_epoch(str_arg(group).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_prepare_group(c: *mut PvClient, group: *const c_char, content_json: *const c_char, op_id: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.prepare_group(
    str_arg(group).ok_or_else(bad_arg)?,
    str_arg(content_json).ok_or_else(bad_arg)?,
    str_arg(op_id).unwrap_or("")
);
        r.map(cstring)
    })
}

// ── группы v2: журнал, ссылки (T056/T080/T084/T125) ─────────────────────────

/// Версия журнала группы на устройстве (0 — журнала нет или id битый).
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_version(c: *const PvClient, group: *const c_char) -> u64 {
    match (c.as_ref(), str_arg(group)) {
        (Some(c), Some(g)) => c.inner.group_version(g).unwrap_or(0),
        _ => 0,
    }
}

/// D-03: версия журнала группы, от которой отстаём; −1 — не отстаём.
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_behind(c: *const PvClient, group: *const c_char) -> i64 {
    match (c.as_ref(), str_arg(group)) {
        (Some(c), Some(g)) => match c.inner.group_behind(g) {
            Ok(Some(v)) => i64::try_from(v).unwrap_or(i64::MAX),
            _ => -1,
        },
        _ => -1,
    }
}

/// Забыть журнал группы (запись отвергнута сервером — перечитать с начала).
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_forget(c: *mut PvClient, group: *const c_char) {
    if let (Some(c), Some(g)) = (c.as_mut(), str_arg(group)) {
        let _ = c.inner.group_forget(g);
    }
}

/// Группы, журнал которых известен устройству — JSON-массив hex id.
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_list(c: *const PvClient) -> *mut c_char {
    match c.as_ref() {
        Some(c) => cstring(c.inner.group_list()),
        None => cstring("[]".into()),
    }
}

/// Сведения группы по журналу (JSON: участники, роли, права, эпоха, ссылки).
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_info(c: *const PvClient, group: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = c.as_ref().ok_or_else(bad_arg)?;
        c.inner.group_info(str_arg(group).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// FR-028 (T080): участники без подтверждённой записи журнала.
/// `claimed_json` — адреса по данным сервера (JSON-массив, можно пустой).
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_unconfirmed(c: *const PvClient, group: *const c_char, claimed_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = c.as_ref().ok_or_else(bad_arg)?;
        c.inner.group_unconfirmed(str_arg(group).ok_or_else(bad_arg)?, str_arg(claimed_json).unwrap_or("[]")).map(cstring)
    })
}

/// Новая ссылка-приглашение → JSON `{"request","url","linkId"}`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_invite_create(
    c: *mut PvClient,
    group: *const c_char,
    title: *const c_char,
    expires_ms: i64,
    usage_limit: u32,
    requires_approval: bool,
    err: *mut *mut c_char,
) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        c.group_invite_create(str_arg(group).ok_or_else(bad_arg)?, str_arg(title).unwrap_or(""), expires_ms, usage_limit, requires_approval)
            .map(cstring)
    })
}

/// Вступить по ссылке v2 (журнал группы уже принят) → запрос `group.join` (JSON).
#[no_mangle]
pub unsafe extern "C" fn pv_client_group_join(c: *mut PvClient, url: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        c.group_join(str_arg(url).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Разобрать ссылку-приглашение → `{"kind":"v2","domain","linkId"}` |
/// `{"kind":"legacy","token"}`; ошибка (в err) — не ссылка-приглашение.
#[no_mangle]
pub unsafe extern "C" fn pv_parse_invite(url: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || host::parse_invite(str_arg(url).ok_or_else(bad_arg)?).map(cstring))
}

/// Устройства пользователя по журналу → JSON `{"v2":[…],"legacy":[…]}`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_log_devices(c: *const PvClient, user: *const c_char) -> *mut c_char {
    match (c.as_ref(), str_arg(user)) {
        (Some(c), Some(u)) => cstring(c.inner.log_devices(u)),
        _ => cstring(r#"{"v2":[],"legacy":[]}"#.into()),
    }
}

/// Опубликовать/сократить свой список v1-устройств (FR-058): JSON
/// `[{"deviceId","identity","signing"}]` → запрос `identity.device.log_append`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_legacy_devices_request(c: *mut PvClient, devices_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> = c.legacy_devices_request(str_arg(devices_json).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Запрос `msg.deliver_legacy` (FR-054): v1 `SendPayload` (JSON) с копиями
/// для v1-устройств из подписанных списков.
#[no_mangle]
pub unsafe extern "C" fn pv_client_legacy_deliver_request(
    c: *const PvClient,
    message_id: *const c_char,
    send_payload_json: *const c_char,
    err: *mut *mut c_char,
) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &c.as_ref().ok_or_else(bad_arg)?.inner;
        let r: Result<String, String> =
            c.legacy_deliver_request(str_arg(message_id).ok_or_else(bad_arg)?, str_arg(send_payload_json).ok_or_else(bad_arg)?);
        r.map(cstring)
    })
}

/// Запас слепых жетонов.
#[no_mangle]
pub unsafe extern "C" fn pv_client_token_count(c: *const PvClient) -> usize {
    c.as_ref().map(|c| c.inner.token_count()).unwrap_or(0)
}

/// Пора получать суточную партию жетонов (FR-063: по расписанию, не перед тратой).
#[no_mangle]
pub unsafe extern "C" fn pv_client_token_refill_due(c: *const PvClient) -> bool {
    c.as_ref().map(|c| c.inner.token_refill_due()).unwrap_or(false)
}

/// Размер партии жетонов — вся суточная квота.
#[no_mangle]
pub unsafe extern "C" fn pv_client_token_batch_size(c: *const PvClient) -> usize {
    c.as_ref().map(|c| c.inner.token_batch_size()).unwrap_or(0)
}

// ── режим «усиленная приватность» (L2, T079) ────────────────────────────────

/// Включить/выключить L2 в личном чате: запросы как у `pv_client_prepare_direct`
/// (операция `ChatMode` собеседнику и своим устройствам). `op_id` — id
/// служебного сообщения в UI (NULL — новый).
#[no_mangle]
pub unsafe extern "C" fn pv_client_l2_set_direct(c: *mut PvClient, peer: *const c_char, enabled: bool, op_id: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = &mut c.as_mut().ok_or_else(bad_arg)?.inner;
        c.l2_set_direct(str_arg(peer).ok_or_else(bad_arg)?, enabled, str_arg(op_id).unwrap_or("")).map(cstring)
    })
}

/// Состояние L2 личного чата:
/// `{"active","mine","enabledBy":[адреса],"pad","ephemeralAllowed"}`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_l2_direct(c: *const PvClient, peer: *const c_char) -> *mut c_char {
    match (c.as_ref(), str_arg(peer)) {
        (Some(c), Some(p)) => cstring(c.inner.l2_direct(p)),
        _ => ptr::null_mut(),
    }
}

/// Состояние L2 группы (тот же JSON): политика журнала группы + личное
/// предпочтение устройства. Политику меняет `pv_client_group_change` с
/// `{"set_privacy_mode":{"l2":true}}`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_l2_group(c: *const PvClient, group: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let c = c.as_ref().ok_or_else(bad_arg)?;
        c.inner.l2_group(str_arg(group).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Личное предпочтение L2 в группе (свои исходящие выравниваются).
#[no_mangle]
pub unsafe extern "C" fn pv_client_l2_set_group_pref(c: *mut PvClient, group: *const c_char, enabled: bool) -> bool {
    match (c.as_mut(), str_arg(group)) {
        (Some(c), Some(g)) => c.inner.l2_set_group_pref(g, enabled).is_ok(),
        _ => false,
    }
}

/// Чаты с активным L2: `{"direct":[адреса собеседников],"groups":[hex id]}`.
#[no_mangle]
pub unsafe extern "C" fn pv_client_l2_active_chats(c: *const PvClient) -> *mut c_char {
    match c.as_ref() {
        Some(c) => cstring(c.inner.l2_active_chats()),
        None => cstring(r#"{"direct":[],"groups":[]}"#.into()),
    }
}

/// Публиковать ли своё присутствие: false, пока L2 активен хотя бы в одном чате.
#[no_mangle]
pub unsafe extern "C" fn pv_client_presence_allowed(c: *const PvClient) -> bool {
    c.as_ref().map(|c| c.inner.presence_allowed()).unwrap_or(true)
}

// ── журнал личного состояния (T098, STATE-1) ────────────────────────────────

/// Сессия журнала личного состояния (непрозрачный указатель,
/// освобождать `pv_state_free`).
pub struct PvStateSession {
    inner: host::HostState,
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_has_state_key(c: *const PvClient) -> bool {
    c.as_ref().map(|c| c.inner.has_state_key()).unwrap_or(false)
}

/// Создать ключ личного состояния, если его нет. true — создан сейчас
/// (состояние клиента нужно сохранить).
#[no_mangle]
pub unsafe extern "C" fn pv_client_ensure_state_key(c: *mut PvClient) -> bool {
    c.as_mut().map(|c| c.inner.ensure_state_key()).unwrap_or(false)
}

/// Сессия журнала на текущем ключе; null — ключа нет.
#[no_mangle]
pub unsafe extern "C" fn pv_client_state_session(c: *const PvClient) -> *mut PvStateSession {
    match c.as_ref().and_then(|c| c.inner.state_session()) {
        Some(inner) => Box::into_raw(Box::new(PvStateSession { inner })),
        None => ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn pv_state_free(s: *mut PvStateSession) {
    if !s.is_null() {
        drop(Box::from_raw(s));
    }
}

/// Тело `state.sync` от курсора сессии.
#[no_mangle]
pub unsafe extern "C" fn pv_state_sync_request(s: *const PvStateSession) -> PvBytes {
    match s.as_ref() {
        Some(s) => PvBytes::from_vec(s.inner.sync_request()),
        None => PvBytes::empty(),
    }
}

/// Ответ `state.sync` → `{"more","applied","rejected"}`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_ingest(s: *mut PvStateSession, resp: *const u8, len: usize, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let s = s.as_mut().ok_or_else(bad_arg)?;
        s.inner.ingest(bytes_arg(resp, len)).map(cstring)
    })
}

/// Сведённое состояние — proto3-JSON `state.v1.StateSnapshot`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_snapshot(s: *const PvStateSession) -> *mut c_char {
    match s.as_ref() {
        Some(s) => cstring(s.inner.snapshot()),
        None => cstring("{}".into()),
    }
}

/// Желаемое хостом состояние по видам (`kinds_json` — JSON-массив имён) →
/// JSON-массив base64 тел `state.append`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_diff(s: *mut PvStateSession, desired_json: *const c_char, kinds_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let s = s.as_mut().ok_or_else(bad_arg)?;
        s.inner.diff(str_arg(desired_json).ok_or_else(bad_arg)?, str_arg(kinds_json).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Первый запуск: локальный снимок → JSON-массив base64 тел `state.append`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_migrate(s: *mut PvStateSession, local_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let s = s.as_mut().ok_or_else(bad_arg)?;
        s.inner.migrate(str_arg(local_json).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Отложенные, которые отправляет это устройство (JSON `ScheduledMessage[]`).
#[no_mangle]
pub unsafe extern "C" fn pv_state_claim_due(s: *mut PvStateSession, now_ms: i64) -> *mut c_char {
    match s.as_mut() {
        Some(s) => cstring(s.inner.claim_due(now_ms)),
        None => cstring("[]".into()),
    }
}

/// Отметка «отложенное отправлено» → JSON-массив base64 тел `state.append`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_mark_sent(s: *mut PvStateSession, op_id_b64: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let s = s.as_mut().ok_or_else(bad_arg)?;
        s.inner.mark_sent(str_arg(op_id_b64).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Запись истории звонков (D-08: сервер её не ведёт): proto3-JSON
/// `parvane.state.v1.CallRecord` → JSON-массив base64 тел `state.append`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_call_set(s: *mut PvStateSession, record_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let s = s.as_mut().ok_or_else(bad_arg)?;
        s.inner.call_set(str_arg(record_json).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Ссылка-приглашение группы v2 (T160): proto3-JSON
/// `parvane.state.v1.GroupInvite` → JSON-массив base64 тел `state.append`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_group_invite_set(s: *mut PvStateSession, invite_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let s = s.as_mut().ok_or_else(bad_arg)?;
        s.inner.group_invite_set(str_arg(invite_json).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Ссылка-приглашение снята: `link_id` — base64 → JSON-массив base64 тел `state.append`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_group_invite_remove(s: *mut PvStateSession, link_id_b64: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let s = s.as_mut().ok_or_else(bad_arg)?;
        s.inner.group_invite_remove(str_arg(link_id_b64).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Чат очищен «у себя» до момента (T145): proto3-JSON
/// `parvane.state.v1.ChatCleared` → JSON-массив base64 тел `state.append`.
#[no_mangle]
pub unsafe extern "C" fn pv_state_chat_cleared(s: *mut PvStateSession, cleared_json: *const c_char, err: *mut *mut c_char) -> *mut c_char {
    guard(err, ptr::null_mut(), || {
        let s = s.as_mut().ok_or_else(bad_arg)?;
        s.inner.chat_cleared(str_arg(cleared_json).ok_or_else(bad_arg)?).map(cstring)
    })
}

/// Уже отправленные этим устройством отложенные (JSON-массив hex; хранит хост).
#[no_mangle]
pub unsafe extern "C" fn pv_state_sent_guard(s: *const PvStateSession) -> *mut c_char {
    match s.as_ref() {
        Some(s) => cstring(s.inner.sent_guard()),
        None => cstring("[]".into()),
    }
}

#[no_mangle]
pub unsafe extern "C" fn pv_state_load_sent_guard(s: *mut PvStateSession, ids_json: *const c_char) {
    if let (Some(s), Some(j)) = (s.as_mut(), str_arg(ids_json)) {
        s.inner.load_sent_guard(j);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_log_version(c: *const PvClient, user: *const c_char) -> u64 {
    match (c.as_ref(), str_arg(user)) {
        (Some(c), Some(u)) => c.inner.log_version(u),
        _ => 0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn pv_client_set_peer_delivery_key(c: *mut PvClient, user: *const c_char, key: *const u8, len: usize, generation: u64) {
    if let (Some(c), Some(u)) = (c.as_mut(), str_arg(user)) {
        c.inner.set_peer_delivery_key(u, bytes_arg(key, len), generation);
    }
}

// ── кадры и помощники ───────────────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn pv_encode_hello(channel: i32, kind: *const c_char, version: *const c_char) -> PvBytes {
    PvBytes::from_vec(host::encode_hello(channel, str_arg(kind).unwrap_or(""), str_arg(version).unwrap_or("")))
}

#[no_mangle]
pub unsafe extern "C" fn pv_encode_auth(token: *const c_char) -> PvBytes {
    PvBytes::from_vec(host::encode_auth(str_arg(token).unwrap_or("")))
}

#[no_mangle]
pub unsafe extern "C" fn pv_encode_request(id: u64, method: *const c_char, body: *const u8, len: usize, timeout_ms: u32) -> PvBytes {
    PvBytes::from_vec(host::encode_request(id, str_arg(method).unwrap_or(""), bytes_arg(body, len), timeout_ms))
}

#[no_mangle]
pub extern "C" fn pv_encode_ping(nonce: u64) -> PvBytes {
    PvBytes::from_vec(host::encode_ping(nonce))
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
    let Some(m) = str_arg(material) else { return ptr::null_mut() };
    match host::grant_with_root_backup(m.as_bytes(), bytes_arg(backup, len)) {
        Ok(v) => cstring(String::from_utf8_lossy(&v).into_owned()),
        Err(_) => ptr::null_mut(),
    }
}

/// Копия корня из материала гранта (пустой буфер — гранта без копии).
#[no_mangle]
pub unsafe extern "C" fn pv_grant_root_backup(material: *const c_char) -> PvBytes {
    match str_arg(material).and_then(|m| host::grant_root_backup(m.as_bytes())) {
        Some(v) => PvBytes::from_vec(v),
        None => PvBytes::empty(),
    }
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

/// Копия корня (`root` — 32 байта `rootSecret` из create_identity) под ключом
/// восстановления. Пустой буфер — ошибка (в `err`).
#[no_mangle]
pub unsafe extern "C" fn pv_client_export_root_backup(c: *const PvClient, root: *const u8, root_len: usize, recovery_key: *const c_char, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || {
        let c = c.as_ref().ok_or_else(bad_arg)?;
        c.inner.export_root_backup(bytes_arg(root, root_len), str_arg(recovery_key).ok_or_else(bad_arg)?).map(PvBytes::from_vec)
    })
}

/// Копия корня для администратора сервера (`escrow_public` — 32 байта из
/// `server.describe`): страховка на случай потери устройств и ключа
/// восстановления. Пустой буфер — ошибка (в `err`).
#[no_mangle]
pub unsafe extern "C" fn pv_client_export_root_escrow(c: *const PvClient, root: *const u8, root_len: usize, escrow_public: *const u8, escrow_public_len: usize, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || {
        let c = c.as_ref().ok_or_else(bad_arg)?;
        c.inner.export_root_escrow(bytes_arg(root, root_len), bytes_arg(escrow_public, escrow_public_len)).map(PvBytes::from_vec)
    })
}

/// Корень (32 байта) из копии, сверенный с журналом устройств. Буфер
/// освобождать `parvane_protocol_bytes_free` (движок не обнуляет копию —
/// вызывающий обнуляет её сам до освобождения).
#[no_mangle]
pub unsafe extern "C" fn pv_client_import_root_backup(c: *const PvClient, blob: *const u8, len: usize, recovery_key: *const c_char, err: *mut *mut c_char) -> PvBytes {
    guard(err, PvBytes::empty(), || {
        let c = c.as_ref().ok_or_else(bad_arg)?;
        c.inner.import_root_backup(bytes_arg(blob, len), str_arg(recovery_key).ok_or_else(bad_arg)?).map(|r| PvBytes::from_vec(r.to_vec()))
    })
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
    Box::into_raw(Box::new(PvAnonPlanner { inner: parvane_protocol::access::AnonPlanner::new() }))
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
    let Some(p) = p.as_mut() else { return cstring("[]".into()) };
    let ids: Vec<String> = p.inner.expired(now_ms).into_iter().map(|c| c.to_string()).collect();
    cstring(format!("[{}]", ids.join(",")))
}

/// Соединение закрылось (обрыв/таймаут) — больше не выдавать.
#[no_mangle]
pub unsafe extern "C" fn pv_anon_planner_closed(p: *mut PvAnonPlanner, conn: u64) {
    if let Some(p) = p.as_mut() {
        p.inner.closed(conn);
    }
}

/// Открытых соединений с получателем (для тестов/диагностики).
#[no_mangle]
pub unsafe extern "C" fn pv_anon_planner_open_count(p: *const PvAnonPlanner) -> usize {
    p.as_ref().map(|p| p.inner.open_count()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_c_string() {
        let s = unsafe { std::ffi::CStr::from_ptr(parvane_protocol_version()) };
        assert_eq!(s.to_str().ok(), Some(parvane_protocol::version()));
        assert_eq!(parvane_protocol_major(), 2);
    }

    #[test]
    fn client_roundtrip_over_c_abi() {
        unsafe {
            let mut err: *mut c_char = ptr::null_mut();
            let u = CString::new("alice@local").unwrap();
            let d = CString::new("d1").unwrap();
            let dm = CString::new("local").unwrap();
            let c = pv_client_new(u.as_ptr(), d.as_ptr(), dm.as_ptr(), &mut err);
            assert!(!c.is_null() && err.is_null());
            let r = pv_client_create_identity(c, 5, &mut err);
            assert!(!r.is_null());
            let text = CStr::from_ptr(r).to_str().unwrap().to_string();
            parvane_protocol_string_free(r);
            assert!(text.contains("identity.device.log_append"));
            let key = [7u8; 32];
            let blob = pv_client_export(c, key.as_ptr(), 32, &mut err);
            assert!(blob.len > 0);
            let c2 = pv_client_import(blob.data, blob.len, key.as_ptr(), 32, &mut err);
            assert!(!c2.is_null());
            parvane_protocol_bytes_free(blob);
            // Ошибка «нужен журнал» — JSON в err.
            let peer = CString::new("bob@local").unwrap();
            let content = CString::new(r#"{"text":{"text":"hi"}}"#).unwrap();
            let out = pv_client_prepare_direct(c2, peer.as_ptr(), content.as_ptr(), ptr::null(), &mut err);
            assert!(out.is_null());
            assert!(CStr::from_ptr(err).to_str().unwrap().contains("peerLog"));
            parvane_protocol_string_free(err);
            pv_client_free(c);
            pv_client_free(c2);
        }
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

    #[test]
    fn root_backup_over_c_abi() {
        unsafe {
            let mut err: *mut c_char = ptr::null_mut();
            let u = CString::new("alice@local").unwrap();
            let d = CString::new("d1").unwrap();
            let dm = CString::new("local").unwrap();
            let c = pv_client_new(u.as_ptr(), d.as_ptr(), dm.as_ptr(), &mut err);
            let r = pv_client_create_identity(c, 1, &mut err);
            let created: String = CStr::from_ptr(r).to_str().unwrap().into();
            parvane_protocol_string_free(r);
            let b64 = created.split("\"rootSecret\":\"").nth(1).unwrap().split('"').next().unwrap();
            let b64c = CString::new(b64).unwrap();
            let root = pv_from_base64(b64c.as_ptr(), &mut err);
            assert_eq!(root.len, 32);
            let key = pv_generate_recovery_key();
            assert!(!key.is_null());
            let backup = pv_client_export_root_backup(c, root.data, root.len, key, &mut err);
            assert!(err.is_null() && backup.len > 0);
            let back = pv_client_import_root_backup(c, backup.data, backup.len, key, &mut err);
            assert!(err.is_null());
            assert_eq!(std::slice::from_raw_parts(back.data, back.len), std::slice::from_raw_parts(root.data, root.len));
            // Чужой ключ — ошибка, не паника.
            let other = pv_generate_recovery_key();
            let bad = pv_client_import_root_backup(c, backup.data, backup.len, other, &mut err);
            assert!(bad.data.is_null() && !err.is_null());
            parvane_protocol_string_free(err);
            parvane_protocol_string_free(key);
            parvane_protocol_string_free(other);
            parvane_protocol_bytes_free(back);
            parvane_protocol_bytes_free(backup);
            parvane_protocol_bytes_free(root);
            pv_client_free(c);
        }
    }

    fn take(p: *mut c_char) -> String {
        assert!(!p.is_null());
        let s = unsafe { CStr::from_ptr(p) }.to_str().unwrap().to_string();
        unsafe { parvane_protocol_string_free(p) };
        s
    }

    #[test]
    fn groups_and_invites_over_c_abi() {
        unsafe {
            let mut err: *mut c_char = ptr::null_mut();
            let u = CString::new("alice@local").unwrap();
            let d = CString::new("d1").unwrap();
            let dm = CString::new("local").unwrap();
            let c = pv_client_new(u.as_ptr(), d.as_ptr(), dm.as_ptr(), &mut err);
            let _ = take(pv_client_create_identity(c, 1, &mut err));
            assert_eq!(take(pv_client_group_list(c)), "[]");
            let name = CString::new("Команда").unwrap();
            let members = CString::new("[]").unwrap();
            let perms = CString::new(r#"{"send_messages":true}"#).unwrap();
            let created = take(pv_client_group_create(c, 1, name.as_ptr(), members.as_ptr(), perms.as_ptr(), &mut err));
            assert!(err.is_null(), "{created}");
            assert!(created.contains("group.state.append") || created.contains("group."), "{created}");
            let list = take(pv_client_group_list(c));
            let hex: Vec<String> = serde_json_ids(&list);
            assert_eq!(hex.len(), 1);
            let g = CString::new(hex[0].clone()).unwrap();
            let info = take(pv_client_group_info(c, g.as_ptr(), &mut err));
            assert!(info.contains("Команда") && info.contains("alice@local"), "{info}");
            assert_eq!(pv_client_group_version(c, g.as_ptr()), 1);
            let claimed = CString::new(r#"["alice@local","mallory@local"]"#).unwrap();
            let unconfirmed = take(pv_client_group_unconfirmed(c, g.as_ptr(), claimed.as_ptr(), &mut err));
            assert_eq!(unconfirmed, r#"["mallory@local"]"#);
            let title = CString::new("").unwrap();
            let inv = take(pv_client_group_invite_create(c, g.as_ptr(), title.as_ptr(), 0, 0, false, &mut err));
            assert!(err.is_null(), "{inv}");
            let url = inv.split("\"url\":\"").nth(1).unwrap().split('"').next().unwrap().to_string();
            assert!(url.starts_with("https://local/join/"), "{url}");
            let urlc = CString::new(url).unwrap();
            let parsed = take(pv_parse_invite(urlc.as_ptr(), &mut err));
            assert!(parsed.contains("\"kind\":\"v2\""), "{parsed}");
            let legacy = CString::new("https://parvane.invite/0123456789abcdef0123456789abcdef").unwrap();
            let parsed = take(pv_parse_invite(legacy.as_ptr(), &mut err));
            assert!(parsed.contains("legacy"), "{parsed}");
            let junk = CString::new("hello").unwrap();
            assert!(pv_parse_invite(junk.as_ptr(), &mut err).is_null() && !err.is_null());
            parvane_protocol_string_free(err);
            let _ = err;
            let devices = take(pv_client_log_devices(c, u.as_ptr()));
            assert!(devices.contains("d1"), "{devices}");
            pv_client_group_forget(c, g.as_ptr());
            assert_eq!(take(pv_client_group_list(c)), "[]");
            pv_client_free(c);
        }
    }

    /// T079: L2 через C ABI — политика группы записью журнала, личное
    /// предпочтение, состояние личного чата и запрет присутствия.
    #[test]
    fn l2_over_c_abi() {
        unsafe {
            let mut err: *mut c_char = ptr::null_mut();
            let u = CString::new("alice@local").unwrap();
            let d = CString::new("d1").unwrap();
            let dm = CString::new("local").unwrap();
            let c = pv_client_new(u.as_ptr(), d.as_ptr(), dm.as_ptr(), &mut err);
            let _ = take(pv_client_create_identity(c, 1, &mut err));
            assert!(pv_client_presence_allowed(c));
            let peer = CString::new("bob@local").unwrap();
            let idle = take(pv_client_l2_direct(c, peer.as_ptr()));
            assert_eq!(idle, r#"{"active":false,"enabledBy":[],"ephemeralAllowed":true,"mine":false,"pad":false}"#);
            // Собеседник без журнала — «нужен журнал», состояние не меняется.
            let out = pv_client_l2_set_direct(c, peer.as_ptr(), true, ptr::null(), &mut err);
            assert!(out.is_null() && CStr::from_ptr(err).to_str().unwrap().contains("peerLog"));
            parvane_protocol_string_free(err);
            err = ptr::null_mut();
            assert_eq!(take(pv_client_l2_direct(c, peer.as_ptr())), idle);

            let name = CString::new("Команда").unwrap();
            let members = CString::new("[]").unwrap();
            let perms = CString::new(r#"{"send_messages":true}"#).unwrap();
            let _ = take(pv_client_group_create(c, 1, name.as_ptr(), members.as_ptr(), perms.as_ptr(), &mut err));
            let hex = serde_json_ids(&take(pv_client_group_list(c)));
            let g = CString::new(hex[0].clone()).unwrap();
            assert!(take(pv_client_l2_group(c, g.as_ptr(), &mut err)).contains(r#""active":false"#));
            assert!(pv_client_l2_set_group_pref(c, g.as_ptr(), true));
            let own = take(pv_client_l2_group(c, g.as_ptr(), &mut err));
            assert!(own.contains(r#""active":false"#) && own.contains(r#""pad":true"#) && own.contains(r#""ephemeralAllowed":true"#), "{own}");
            assert!(pv_client_presence_allowed(c), "личное предпочтение в группе присутствие не гасит");
            let change = CString::new(r#"{"set_privacy_mode":{"l2":true}}"#).unwrap();
            let req = take(pv_client_group_change(c, g.as_ptr(), change.as_ptr(), &mut err));
            assert!(err.is_null() && req.contains("group.state.append"), "{req}");
            let on = take(pv_client_l2_group(c, g.as_ptr(), &mut err));
            assert!(on.contains(r#""active":true"#) && on.contains(r#""enabledBy":["alice@local"]"#) && on.contains(r#""ephemeralAllowed":false"#), "{on}");
            let info = take(pv_client_group_info(c, g.as_ptr(), &mut err));
            assert!(info.contains(r#""l2":true"#) && info.contains(r#""l2By":"alice@local""#), "{info}");
            assert!(!pv_client_presence_allowed(c));
            assert_eq!(take(pv_client_l2_active_chats(c)), format!(r#"{{"direct":[],"groups":["{}"]}}"#, hex[0]));
            pv_client_free(c);
        }
    }

    fn serde_json_ids(list: &str) -> Vec<String> {
        list.trim_matches(|ch| ch == '[' || ch == ']')
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_matches('"').to_string())
            .collect()
    }

    /// Линковка второго устройства (LINK-1 v2): грант несёт SSK, журнал, ключ
    /// доставки и ключ личного состояния — новое устройство читает журнал состояния.
    #[test]
    fn link_grant_carries_state_key() {
        unsafe {
            let mut err: *mut c_char = ptr::null_mut();
            let u = CString::new("alice@local").unwrap();
            let dm = CString::new("local").unwrap();
            let d1 = CString::new("d1").unwrap();
            let d2 = CString::new("d2").unwrap();
            let old = pv_client_new(u.as_ptr(), d1.as_ptr(), dm.as_ptr(), &mut err);
            take(pv_client_create_identity(old, 2, &mut err));
            assert!(err.is_null());
            assert!(pv_client_ensure_state_key(old));
            let material = take(pv_client_link_grant_material(old, &mut err));
            assert!(err.is_null() && material.contains(r#""sk":""#) && material.contains(r#""skv":1"#), "{material}");

            let new = pv_client_new(u.as_ptr(), d2.as_ptr(), dm.as_ptr(), &mut err);
            assert!(!pv_client_has_state_key(new));
            let m = CString::new(material.clone()).unwrap();
            let reqs = take(pv_client_join_with_grant(new, m.as_ptr(), 2, &mut err));
            assert!(err.is_null() && reqs.contains("identity.device.publish_certificate"), "{reqs}");
            assert!(pv_client_has_state_key(new));
            assert!(!pv_client_ensure_state_key(new), "ключ состояния пришёл грантом, новый не создаётся");

            // Грант старого формата (без ключа состояния) принимается, ключа нет
            let (from, to) = (material.find(r#""sk":"#).unwrap(), material.find(r#""ssk":"#).unwrap());
            let legacy = format!("{}{}", &material[..from], &material[to..]);
            assert!(!legacy.contains(r#""skv""#), "{legacy}");
            let d3 = CString::new("d3").unwrap();
            let third = pv_client_new(u.as_ptr(), d3.as_ptr(), dm.as_ptr(), &mut err);
            let m = CString::new(legacy).unwrap();
            take(pv_client_join_with_grant(third, m.as_ptr(), 2, &mut err));
            assert!(err.is_null());
            assert!(!pv_client_has_state_key(third));
            pv_client_free(old);
            pv_client_free(new);
            pv_client_free(third);
        }
    }

    #[test]
    fn state_session_over_c_abi() {
        unsafe {
            let mut err: *mut c_char = ptr::null_mut();
            let u = CString::new("alice@local").unwrap();
            let d = CString::new("d1").unwrap();
            let dm = CString::new("local").unwrap();
            let c = pv_client_new(u.as_ptr(), d.as_ptr(), dm.as_ptr(), &mut err);
            assert!(pv_client_state_session(c).is_null());
            assert!(!pv_client_has_state_key(c));
            assert!(pv_client_ensure_state_key(c));
            assert!(!pv_client_ensure_state_key(c));
            let s = pv_client_state_session(c);
            assert!(!s.is_null());
            let req = pv_state_sync_request(s);
            parvane_protocol_bytes_free(req);
            let local = CString::new(r#"{"folders":[{"id":2,"title":"Работа"}],"archived":[{"user":{"address":"bob@local"}}]}"#).unwrap();
            let bodies = take(pv_state_migrate(s, local.as_ptr(), &mut err));
            assert!(err.is_null(), "{bodies}");
            assert_eq!(bodies.matches(',').count() + 1, 2, "{bodies}");
            let snap = take(pv_state_snapshot(s));
            assert!(snap.contains("Работа") && snap.contains("bob@local"), "{snap}");
            // Желаемое без архива — одна запись-надгробие по виду archived.
            let want = CString::new(r#"{"folders":[{"id":2,"title":"Работа"}]}"#).unwrap();
            let kinds = CString::new(r#"["archived"]"#).unwrap();
            let diff = take(pv_state_diff(s, want.as_ptr(), kinds.as_ptr(), &mut err));
            assert!(err.is_null() && diff.starts_with("[\"") && !diff.contains(','), "{diff}");
            assert!(!take(pv_state_snapshot(s)).contains("bob@local"));
            assert_eq!(take(pv_state_claim_due(s, 0)), "[]");
            assert_eq!(take(pv_state_sent_guard(s)), "[]");
            pv_state_free(s);
            pv_client_free(c);
        }
    }

    #[test]
    fn anon_planner_over_c_abi() {
        unsafe {
            let mut err: *mut c_char = ptr::null_mut();
            let p = pv_anon_planner_new();
            let m = CString::new("identity.device.fetch_bundle_anon").unwrap();
            let a = pv_anon_planner_assign(p, m.as_ptr(), ptr::null(), 0, 1000, &mut err);
            let s = CStr::from_ptr(a).to_str().unwrap().to_string();
            parvane_protocol_string_free(a);
            assert_eq!(s, r#"{"conn":1,"open":true,"closeAfter":true}"#);
            // Публичный запрос не держит соединение.
            assert_eq!(pv_anon_planner_open_count(p), 0);
            // Битое тело sealed-доставки — ошибка в err.
            let ds = CString::new("msg.deliver_sealed").unwrap();
            let junk = [0xffu8, 0xff, 0xff];
            let bad = pv_anon_planner_assign(p, ds.as_ptr(), junk.as_ptr(), junk.len(), 1000, &mut err);
            assert!(bad.is_null() && !err.is_null());
            parvane_protocol_string_free(err);
            let e = pv_anon_planner_expired(p, 100_000);
            assert_eq!(CStr::from_ptr(e).to_str().unwrap(), "[]");
            parvane_protocol_string_free(e);
            pv_anon_planner_closed(p, 1);
            pv_anon_planner_free(p);
        }
    }
}
