// Parvane E2E (Фаза 2): тонкая обёртка над vodozemac (Olm) для клиента.
// Внутренний Rust-API тестируется юнит-тестами; extern "C" слой линкуется в
// C++ (parvane-core). Приватные ключи живут ТОЛЬКО здесь/на устройстве.
//
// Olm = X3DH (create_outbound/inbound по бандлу) + Double Ratchet. Групповые
// ключи (Megolm) — Фаза 3. Sealed sender делается слоем выше (настоящий
// отправитель + подпись внутри шифртекста), сервер роутит по получателю.

use vodozemac::olm::{Account, OlmMessage, Session, SessionConfig};
use vodozemac::{base64_decode, base64_encode, Curve25519PublicKey};

// ── внутренний API (тестируемый) ──────────────────────────────────────────────

pub struct E2EAccount(Account);
pub struct E2ESession(Session);

/// Публичная prekey: (наш порядковый id для сервера, base64 ключа).
pub type Otk = (i64, String);

impl E2EAccount {
    pub fn new() -> Self {
        E2EAccount(Account::new())
    }

    /// Сериализация для персиста на устройстве (JSON pickle). НЕ раздавать.
    pub fn pickle_json(&self) -> String {
        serde_json::to_string(&self.0.pickle()).unwrap_or_default()
    }

    pub fn from_pickle_json(s: &str) -> Option<Self> {
        let p: vodozemac::olm::AccountPickle = serde_json::from_str(s).ok()?;
        Some(E2EAccount(Account::from_pickle(p)))
    }

    /// Публичный identity-ключ (Curve25519, base64) — для публикации/бандла.
    pub fn identity_b64(&self) -> String {
        self.0.curve25519_key().to_base64()
    }

    /// Сгенерировать `n` одноразовых, вернуть (id, base64) НОВЫХ неопубликованных
    /// и пометить опубликованными. `start_id` — с какого номера нумеровать (id
    /// нужен только серверу для учёта; получателю он не важен — vodozemac сам
    /// находит нужный приватный OTK по pre-key сообщению).
    pub fn generate_otks(&mut self, n: usize, start_id: i64) -> Vec<Otk> {
        self.0.generate_one_time_keys(n);
        let mut out = Vec::new();
        let mut id = start_id;
        for key in self.0.one_time_keys().values() {
            out.push((id, key.to_base64()));
            id += 1;
        }
        self.0.mark_keys_as_published();
        out
    }

    /// Исходящая сессия по бандлу собеседника (X3DH). None — битые ключи.
    pub fn outbound(&self, identity_b64: &str, otk_b64: &str) -> Option<E2ESession> {
        let id = Curve25519PublicKey::from_base64(identity_b64).ok()?;
        let otk = Curve25519PublicKey::from_base64(otk_b64).ok()?;
        let sess = self
            .0
            .create_outbound_session(SessionConfig::version_1(), id, otk)
            .ok()?;
        Some(E2ESession(sess))
    }

    /// Входящая сессия из pre-key сообщения (type=0). Возвращает (сессия, plaintext).
    pub fn inbound(
        &mut self,
        sender_identity_b64: &str,
        prekey_type: u32,
        prekey_ct_b64: &str,
    ) -> Option<(E2ESession, Vec<u8>)> {
        let id = Curve25519PublicKey::from_base64(sender_identity_b64).ok()?;
        let ct = base64_decode(prekey_ct_b64).ok()?;
        let msg = OlmMessage::from_parts(prekey_type as usize, &ct).ok()?;
        let pre = match msg {
            OlmMessage::PreKey(m) => m,
            _ => return None,
        };
        let res = self
            .0
            .create_inbound_session(SessionConfig::version_1(), id, &pre)
            .ok()?;
        Some((E2ESession(res.session), res.plaintext))
    }
}

impl Default for E2EAccount {
    fn default() -> Self {
        Self::new()
    }
}

impl E2ESession {
    /// Зашифровать. Возвращает (тип сообщения Olm: 0=prekey/1=normal, base64 шифртекста).
    pub fn encrypt(&mut self, plaintext: &[u8]) -> (u32, String) {
        // encrypt даёт ошибку лишь при внутреннем сбое — это баг, не рантайм-путь.
        let msg = self.0.encrypt(plaintext).expect("olm encrypt");
        let (t, ct) = msg.to_parts();
        (t as u32, base64_encode(ct))
    }

    /// Расшифровать. None — не наша сессия / порча.
    pub fn decrypt(&mut self, msg_type: u32, ct_b64: &str) -> Option<Vec<u8>> {
        let ct = base64_decode(ct_b64).ok()?;
        let msg = OlmMessage::from_parts(msg_type as usize, &ct).ok()?;
        self.0.decrypt(&msg).ok()
    }

    pub fn pickle_json(&self) -> String {
        serde_json::to_string(&self.0.pickle()).unwrap_or_default()
    }

    pub fn from_pickle_json(s: &str) -> Option<Self> {
        let p: vodozemac::olm::SessionPickle = serde_json::from_str(s).ok()?;
        Some(E2ESession(Session::from_pickle(p)))
    }
}

// ── extern "C" (для C++/parvane-core) ─────────────────────────────────────────
// Строки, возвращаемые наружу — освобождать parvane_e2e_string_free. Указатели
// аккаунта/сессии — parvane_e2e_*_free.

use std::ffi::{c_char, CStr, CString};

unsafe fn cstr(p: *const c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok().map(|s| s.to_string())
}

fn to_cstring(s: String) -> *mut c_char {
    CString::new(s).map(|c| c.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn parvane_e2e_string_free(p: *mut c_char) {
    if !p.is_null() {
        unsafe { drop(CString::from_raw(p)) };
    }
}

#[no_mangle]
pub extern "C" fn parvane_e2e_account_new() -> *mut E2EAccount {
    Box::into_raw(Box::new(E2EAccount::new()))
}

#[no_mangle]
pub extern "C" fn parvane_e2e_account_free(p: *mut E2EAccount) {
    if !p.is_null() {
        unsafe { drop(Box::from_raw(p)) };
    }
}

#[no_mangle]
pub extern "C" fn parvane_e2e_account_pickle(p: *const E2EAccount) -> *mut c_char {
    let acc = unsafe { p.as_ref() };
    acc.map(|a| to_cstring(a.pickle_json())).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn parvane_e2e_account_from_pickle(s: *const c_char) -> *mut E2EAccount {
    let Some(js) = (unsafe { cstr(s) }) else { return std::ptr::null_mut() };
    match E2EAccount::from_pickle_json(&js) {
        Some(a) => Box::into_raw(Box::new(a)),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn parvane_e2e_account_identity(p: *const E2EAccount) -> *mut c_char {
    let acc = unsafe { p.as_ref() };
    acc.map(|a| to_cstring(a.identity_b64())).unwrap_or(std::ptr::null_mut())
}

/// Генерирует n one-time и возвращает JSON-массив [{"key_id":i,"public_key":b64},…].
#[no_mangle]
pub extern "C" fn parvane_e2e_account_gen_otks(
    p: *mut E2EAccount,
    n: u32,
    start_id: i64,
) -> *mut c_char {
    let Some(acc) = (unsafe { p.as_mut() }) else { return std::ptr::null_mut() };
    let otks = acc.generate_otks(n as usize, start_id);
    let arr: Vec<_> = otks
        .into_iter()
        .map(|(id, k)| serde_json::json!({ "key_id": id, "public_key": k }))
        .collect();
    to_cstring(serde_json::Value::Array(arr).to_string())
}

/// Исходящая сессия по бандлу. NULL — ошибка.
#[no_mangle]
pub extern "C" fn parvane_e2e_outbound(
    p: *const E2EAccount,
    identity_b64: *const c_char,
    otk_b64: *const c_char,
) -> *mut E2ESession {
    let acc = unsafe { p.as_ref() };
    let (Some(acc), Some(id), Some(otk)) =
        (acc, unsafe { cstr(identity_b64) }, unsafe { cstr(otk_b64) })
    else {
        return std::ptr::null_mut();
    };
    match acc.outbound(&id, &otk) {
        Some(s) => Box::into_raw(Box::new(s)),
        None => std::ptr::null_mut(),
    }
}

/// Входящая сессия из pre-key. Пишет plaintext (base64) в out_plaintext_b64
/// (освобождать string_free). Возвращает сессию или NULL.
#[no_mangle]
pub extern "C" fn parvane_e2e_inbound(
    p: *mut E2EAccount,
    sender_identity_b64: *const c_char,
    prekey_type: u32,
    prekey_ct_b64: *const c_char,
    out_plaintext_b64: *mut *mut c_char,
) -> *mut E2ESession {
    let Some(acc) = (unsafe { p.as_mut() }) else { return std::ptr::null_mut() };
    let (Some(id), Some(ct)) =
        (unsafe { cstr(sender_identity_b64) }, unsafe { cstr(prekey_ct_b64) })
    else {
        return std::ptr::null_mut();
    };
    match acc.inbound(&id, prekey_type, &ct) {
        Some((sess, pt)) => {
            if !out_plaintext_b64.is_null() {
                unsafe { *out_plaintext_b64 = to_cstring(base64_encode(pt)) };
            }
            Box::into_raw(Box::new(sess))
        }
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn parvane_e2e_session_free(p: *mut E2ESession) {
    if !p.is_null() {
        unsafe { drop(Box::from_raw(p)) };
    }
}

/// Шифрует plaintext (base64). Пишет тип в out_type, возвращает шифртекст base64.
#[no_mangle]
pub extern "C" fn parvane_e2e_encrypt(
    p: *mut E2ESession,
    plaintext_b64: *const c_char,
    out_type: *mut u32,
) -> *mut c_char {
    let Some(sess) = (unsafe { p.as_mut() }) else { return std::ptr::null_mut() };
    let Some(pt_b64) = (unsafe { cstr(plaintext_b64) }) else { return std::ptr::null_mut() };
    let Ok(pt) = base64_decode(&pt_b64) else { return std::ptr::null_mut() };
    let (t, ct) = sess.encrypt(&pt);
    if !out_type.is_null() {
        unsafe { *out_type = t };
    }
    to_cstring(ct)
}

/// Расшифровывает. Возвращает plaintext (base64) или NULL.
#[no_mangle]
pub extern "C" fn parvane_e2e_decrypt(
    p: *mut E2ESession,
    msg_type: u32,
    ct_b64: *const c_char,
) -> *mut c_char {
    let Some(sess) = (unsafe { p.as_mut() }) else { return std::ptr::null_mut() };
    let Some(ct) = (unsafe { cstr(ct_b64) }) else { return std::ptr::null_mut() };
    match sess.decrypt(msg_type, &ct) {
        Some(pt) => to_cstring(base64_encode(pt)),
        None => std::ptr::null_mut(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x3dh_olm_round_trip_and_ratchet() {
        // Bob публикует бандл.
        let mut bob = E2EAccount::new();
        let otks = bob.generate_otks(2, 1);
        assert_eq!(otks.len(), 2);
        let bob_id = bob.identity_b64();
        let (_id, otk_b64) = otks[0].clone();

        // Alice: исходящая сессия по бандлу + шифр.
        let alice = E2EAccount::new();
        let mut a = alice.outbound(&bob_id, &otk_b64).expect("outbound");
        let (t, ct) = a.encrypt(b"secret-1");
        assert_eq!(t, 0, "первое — pre-key");

        // Bob: входящая сессия + расшифровка.
        let (mut b, pt) = bob.inbound(&alice.identity_b64(), t, &ct).expect("inbound");
        assert_eq!(pt, b"secret-1");

        // Ratchet: второе сообщение.
        let (t2, ct2) = a.encrypt(b"secret-2");
        assert_eq!(b.decrypt(t2, &ct2).unwrap(), b"secret-2");
    }

    #[test]
    fn account_pickle_round_trip() {
        let mut acc = E2EAccount::new();
        let id = acc.identity_b64();
        acc.generate_otks(1, 1);
        let pickle = acc.pickle_json();
        let restored = E2EAccount::from_pickle_json(&pickle).expect("unpickle");
        assert_eq!(restored.identity_b64(), id, "identity сохранён после pickle");
    }

    #[test]
    fn wrong_bundle_no_session() {
        let alice = E2EAccount::new();
        assert!(alice.outbound("не-base64!!!", "тоже-мусор").is_none());
    }
}
