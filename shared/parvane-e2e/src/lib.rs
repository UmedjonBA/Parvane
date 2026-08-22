// Parvane E2E (Фаза 2): тонкая обёртка над vodozemac (Olm) для клиента.
// Внутренний Rust-API тестируется юнит-тестами; extern "C" слой линкуется в
// C++ (parvane-core). Приватные ключи живут ТОЛЬКО здесь/на устройстве.
//
// Olm = X3DH (create_outbound/inbound по бандлу) + Double Ratchet. Групповые
// ключи (Megolm) — Фаза 3. Sealed sender делается слоем выше (настоящий
// отправитель + подпись внутри шифртекста), сервер роутит по получателю.

use vodozemac::megolm::{
    GroupSession, InboundGroupSession, MegolmMessage, SessionConfig as MegolmConfig, SessionKey,
};
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

impl E2EAccount {
    /// Публичный Ed25519-ключ аккаунта (base64) — «signing_key» устройства в
    /// identity (мультидевайс) и ключ подписи sync/edit/delete в messenger.
    pub fn ed25519_b64(&self) -> String {
        self.0.ed25519_key().to_base64()
    }

    /// Подпись произвольных байт Ed25519-ключом аккаунта (base64 без padding) —
    /// тот же формат, что у libolm `account.sign()` в веб-клиенте.
    pub fn sign_b64(&self, data: &[u8]) -> String {
        self.0.sign(data).to_base64()
    }

    /// Сгенерировать fallback-ключ (signed_prekey бандла), пометить опубликованным
    /// и вернуть его base64. Предыдущий fallback vodozemac хранит — pre-key
    /// сообщения «в пути» продолжают расшифровываться.
    pub fn generate_fallback_b64(&mut self) -> Option<String> {
        // generate_fallback_key возвращает ПРЕДЫДУЩИЙ ключ — новый берём из fallback_key().
        self.0.generate_fallback_key();
        let key = self.0.fallback_key().into_values().next().map(|k| k.to_base64());
        self.0.mark_keys_as_published();
        key
    }

    /// Импорт libolm-pickle (формат @matrix-org/olm веб-клиента). `key` — строка
    /// pickleKey веб-клиента (её UTF-8 байты — ключ шифрования pickle).
    pub fn from_libolm_pickle(pickle: &str, key: &str) -> Option<Self> {
        Account::from_libolm_pickle(pickle, key.as_bytes())
            .ok()
            .map(E2EAccount)
    }

    /// Экспорт в libolm-pickle под ключом `key` — чтобы веб-клиент мог принять
    /// аккаунт desktop как legacy-подписанта при линковке истории.
    pub fn to_libolm_pickle(&self, key: &str) -> Option<String> {
        self.0.to_libolm_pickle(key.as_bytes()).ok()
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

    /// Импорт libolm-pickle сессии веб-клиента (ручной импорт бэкапа ключей).
    pub fn from_libolm_pickle(pickle: &str, key: &str) -> Option<Self> {
        Session::from_libolm_pickle(pickle, key.as_bytes()).ok().map(E2ESession)
    }
}

// ── Megolm (групповые ключи, Фаза 3) ─────────────────────────────────────────
// У каждого отправителя в группе — своя ИСХОДЯЩАЯ group session. Её session_key
// раздаётся участникам по 1-на-1 E2E (SKDM). Участник создаёт ВХОДЯЩУЮ group
// session из session_key и расшифровывает сообщения этого отправителя. Сам
// групповой шифртекст фанится сервером, не читая содержимого.

pub struct E2EGroupSession(GroupSession);
pub struct E2EInboundGroup(InboundGroupSession);

impl E2EGroupSession {
    pub fn new() -> Self {
        E2EGroupSession(GroupSession::new(MegolmConfig::version_1()))
    }
    /// Ключ для раздачи участникам (base64). По нему они создают inbound.
    pub fn session_key_b64(&self) -> String {
        self.0.session_key().to_base64()
    }
    /// Зашифровать сообщение группы. Возвращает base64 MegolmMessage.
    pub fn encrypt(&mut self, plaintext: &[u8]) -> String {
        base64_encode(self.0.encrypt(plaintext).to_bytes())
    }
    pub fn pickle_json(&self) -> String {
        serde_json::to_string(&self.0.pickle()).unwrap_or_default()
    }
    pub fn from_pickle_json(s: &str) -> Option<Self> {
        let p: vodozemac::megolm::GroupSessionPickle = serde_json::from_str(s).ok()?;
        Some(E2EGroupSession(GroupSession::from_pickle(p)))
    }
}

impl Default for E2EGroupSession {
    fn default() -> Self {
        Self::new()
    }
}

impl E2EInboundGroup {
    /// Создать входящую сессию из session_key (base64), полученного по 1-на-1 E2E.
    pub fn from_session_key(key_b64: &str) -> Option<Self> {
        let key = SessionKey::from_base64(key_b64).ok()?;
        Some(E2EInboundGroup(InboundGroupSession::new(&key, MegolmConfig::version_1())))
    }
    /// Расшифровать групповое сообщение (base64 MegolmMessage). None — не наша/порча.
    pub fn decrypt(&mut self, ct_b64: &str) -> Option<Vec<u8>> {
        let bytes = base64_decode(ct_b64).ok()?;
        let msg = MegolmMessage::from_bytes(&bytes).ok()?;
        self.0.decrypt(&msg).ok().map(|d| d.plaintext)
    }
    pub fn pickle_json(&self) -> String {
        serde_json::to_string(&self.0.pickle()).unwrap_or_default()
    }
    pub fn from_pickle_json(s: &str) -> Option<Self> {
        let p: vodozemac::megolm::InboundGroupSessionPickle = serde_json::from_str(s).ok()?;
        Some(E2EInboundGroup(InboundGroupSession::from_pickle(p)))
    }

    /// Экспорт ключа сессии с первого известного индекса (формат libolm
    /// `export_session` — его принимает и веб `import_session`, и `from_exported`).
    pub fn export_b64(&self) -> String {
        self.0.export_at_first_known_index().to_base64()
    }

    /// Импорт экспортированного ключа (см. export_b64).
    pub fn from_exported(key_b64: &str) -> Option<Self> {
        let key = vodozemac::megolm::ExportedSessionKey::from_base64(key_b64).ok()?;
        Some(E2EInboundGroup(InboundGroupSession::import(&key, MegolmConfig::version_1())))
    }

    /// Импорт libolm-pickle входящей сессии веб-клиента.
    pub fn from_libolm_pickle(pickle: &str, key: &str) -> Option<Self> {
        InboundGroupSession::from_libolm_pickle(pickle, key.as_bytes())
            .ok()
            .map(E2EInboundGroup)
    }
}

/// Safety number для верификации контакта: детерминированный отпечаток пары
/// identity-ключей (симметричный — обе стороны получают одинаковый). 6 групп по
/// 5 цифр. SHA-256 (устойчив к подбору короткого совпадения). Для сверки
/// «голосом»/скриншотом против MITM.
pub fn safety_number(id_a: &str, id_b: &str) -> String {
    use sha2::{Digest, Sha256};
    let (x, y) = if id_a <= id_b { (id_a, id_b) } else { (id_b, id_a) };
    let mut h = Sha256::new();
    h.update(x.as_bytes());
    h.update(b"|");
    h.update(y.as_bytes());
    let digest = h.finalize();
    let mut out = String::new();
    for chunk in digest.chunks(5).take(6) {
        let mut v: u64 = 0;
        for &b in chunk {
            v = (v << 8) | b as u64;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&format!("{:05}", v % 100_000));
    }
    out
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

// ── Megolm FFI (группы) ───────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn parvane_e2e_group_new() -> *mut E2EGroupSession {
    Box::into_raw(Box::new(E2EGroupSession::new()))
}
#[no_mangle]
pub extern "C" fn parvane_e2e_group_free(p: *mut E2EGroupSession) {
    if !p.is_null() {
        unsafe { drop(Box::from_raw(p)) };
    }
}
/// session_key для раздачи участникам (base64).
#[no_mangle]
pub extern "C" fn parvane_e2e_group_session_key(p: *const E2EGroupSession) -> *mut c_char {
    unsafe { p.as_ref() }.map(|g| to_cstring(g.session_key_b64())).unwrap_or(std::ptr::null_mut())
}
/// Зашифровать (plaintext base64 → ciphertext base64).
#[no_mangle]
pub extern "C" fn parvane_e2e_group_encrypt(p: *mut E2EGroupSession, pt_b64: *const c_char) -> *mut c_char {
    let Some(g) = (unsafe { p.as_mut() }) else { return std::ptr::null_mut() };
    let Some(b64) = (unsafe { cstr(pt_b64) }) else { return std::ptr::null_mut() };
    let Ok(pt) = base64_decode(&b64) else { return std::ptr::null_mut() };
    to_cstring(g.encrypt(&pt))
}
#[no_mangle]
pub extern "C" fn parvane_e2e_group_pickle(p: *const E2EGroupSession) -> *mut c_char {
    unsafe { p.as_ref() }.map(|g| to_cstring(g.pickle_json())).unwrap_or(std::ptr::null_mut())
}
#[no_mangle]
pub extern "C" fn parvane_e2e_group_from_pickle(s: *const c_char) -> *mut E2EGroupSession {
    let Some(js) = (unsafe { cstr(s) }) else { return std::ptr::null_mut() };
    match E2EGroupSession::from_pickle_json(&js) {
        Some(g) => Box::into_raw(Box::new(g)),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn parvane_e2e_inbound_group_from_key(key_b64: *const c_char) -> *mut E2EInboundGroup {
    let Some(k) = (unsafe { cstr(key_b64) }) else { return std::ptr::null_mut() };
    match E2EInboundGroup::from_session_key(&k) {
        Some(g) => Box::into_raw(Box::new(g)),
        None => std::ptr::null_mut(),
    }
}
#[no_mangle]
pub extern "C" fn parvane_e2e_inbound_group_free(p: *mut E2EInboundGroup) {
    if !p.is_null() {
        unsafe { drop(Box::from_raw(p)) };
    }
}
/// Расшифровать (ciphertext base64 → plaintext base64) или NULL.
#[no_mangle]
pub extern "C" fn parvane_e2e_inbound_group_decrypt(p: *mut E2EInboundGroup, ct_b64: *const c_char) -> *mut c_char {
    let Some(g) = (unsafe { p.as_mut() }) else { return std::ptr::null_mut() };
    let Some(ct) = (unsafe { cstr(ct_b64) }) else { return std::ptr::null_mut() };
    match g.decrypt(&ct) {
        Some(pt) => to_cstring(base64_encode(pt)),
        None => std::ptr::null_mut(),
    }
}
#[no_mangle]
pub extern "C" fn parvane_e2e_inbound_group_pickle(p: *const E2EInboundGroup) -> *mut c_char {
    unsafe { p.as_ref() }.map(|g| to_cstring(g.pickle_json())).unwrap_or(std::ptr::null_mut())
}
#[no_mangle]
pub extern "C" fn parvane_e2e_inbound_group_from_pickle(s: *const c_char) -> *mut E2EInboundGroup {
    let Some(js) = (unsafe { cstr(s) }) else { return std::ptr::null_mut() };
    match E2EInboundGroup::from_pickle_json(&js) {
        Some(g) => Box::into_raw(Box::new(g)),
        None => std::ptr::null_mut(),
    }
}

/// Safety number пары identity-ключей (base64). Освобождать string_free.
#[no_mangle]
pub extern "C" fn parvane_e2e_safety_number(a: *const c_char, b: *const c_char) -> *mut c_char {
    let (Some(a), Some(b)) = (unsafe { cstr(a) }, unsafe { cstr(b) }) else {
        return std::ptr::null_mut();
    };
    to_cstring(safety_number(&a, &b))
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

// Персист сессии (Olm ratchet-состояние) — JSON pickle. Хранить на устройстве.
#[no_mangle]
pub extern "C" fn parvane_e2e_session_pickle(p: *const E2ESession) -> *mut c_char {
    let s = unsafe { p.as_ref() };
    s.map(|x| to_cstring(x.pickle_json())).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn parvane_e2e_session_from_pickle(s: *const c_char) -> *mut E2ESession {
    let Some(js) = (unsafe { cstr(s) }) else { return std::ptr::null_mut() };
    match E2ESession::from_pickle_json(&js) {
        Some(x) => Box::into_raw(Box::new(x)),
        None => std::ptr::null_mut(),
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

// ── extern "C": мультидевайс / линковка (совместимость с веб-клиентом) ────────

#[no_mangle]
pub extern "C" fn parvane_e2e_account_ed25519(p: *const E2EAccount) -> *mut c_char {
    let acc = unsafe { p.as_ref() };
    acc.map(|a| to_cstring(a.ed25519_b64())).unwrap_or(std::ptr::null_mut())
}

/// Подпись data (сырые байты UTF-8 строки) Ed25519-ключом аккаунта → base64.
#[no_mangle]
pub extern "C" fn parvane_e2e_account_sign(p: *const E2EAccount, data: *const c_char) -> *mut c_char {
    let acc = unsafe { p.as_ref() };
    let (Some(acc), Some(d)) = (acc, unsafe { cstr(data) }) else { return std::ptr::null_mut() };
    to_cstring(acc.sign_b64(d.as_bytes()))
}

/// Новый fallback-ключ (signed_prekey) → base64, NULL при ошибке.
#[no_mangle]
pub extern "C" fn parvane_e2e_account_gen_fallback(p: *mut E2EAccount) -> *mut c_char {
    let Some(acc) = (unsafe { p.as_mut() }) else { return std::ptr::null_mut() };
    acc.generate_fallback_b64().map(to_cstring).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn parvane_e2e_account_from_libolm_pickle(
    pickle: *const c_char,
    key: *const c_char,
) -> *mut E2EAccount {
    let (Some(pk), Some(k)) = (unsafe { cstr(pickle) }, unsafe { cstr(key) }) else {
        return std::ptr::null_mut();
    };
    match E2EAccount::from_libolm_pickle(&pk, &k) {
        Some(a) => Box::into_raw(Box::new(a)),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn parvane_e2e_account_to_libolm_pickle(
    p: *const E2EAccount,
    key: *const c_char,
) -> *mut c_char {
    let acc = unsafe { p.as_ref() };
    let (Some(acc), Some(k)) = (acc, unsafe { cstr(key) }) else { return std::ptr::null_mut() };
    acc.to_libolm_pickle(&k).map(to_cstring).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn parvane_e2e_session_from_libolm_pickle(
    pickle: *const c_char,
    key: *const c_char,
) -> *mut E2ESession {
    let (Some(pk), Some(k)) = (unsafe { cstr(pickle) }, unsafe { cstr(key) }) else {
        return std::ptr::null_mut();
    };
    match E2ESession::from_libolm_pickle(&pk, &k) {
        Some(s) => Box::into_raw(Box::new(s)),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn parvane_e2e_inbound_group_export(p: *const E2EInboundGroup) -> *mut c_char {
    let g = unsafe { p.as_ref() };
    g.map(|x| to_cstring(x.export_b64())).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn parvane_e2e_inbound_group_from_exported(key_b64: *const c_char) -> *mut E2EInboundGroup {
    let Some(k) = (unsafe { cstr(key_b64) }) else { return std::ptr::null_mut() };
    match E2EInboundGroup::from_exported(&k) {
        Some(g) => Box::into_raw(Box::new(g)),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn parvane_e2e_inbound_group_from_libolm_pickle(
    pickle: *const c_char,
    key: *const c_char,
) -> *mut E2EInboundGroup {
    let (Some(pk), Some(k)) = (unsafe { cstr(pickle) }, unsafe { cstr(key) }) else {
        return std::ptr::null_mut();
    };
    match E2EInboundGroup::from_libolm_pickle(&pk, &k) {
        Some(g) => Box::into_raw(Box::new(g)),
        None => std::ptr::null_mut(),
    }
}

/// Проверка Ed25519-подписи (base64 ключ/подпись, сырые байты data). 1 = ок.
#[no_mangle]
pub extern "C" fn parvane_e2e_ed25519_verify(
    pub_b64: *const c_char,
    data: *const c_char,
    sig_b64: *const c_char,
) -> i32 {
    let (Some(pk), Some(d), Some(sg)) =
        (unsafe { cstr(pub_b64) }, unsafe { cstr(data) }, unsafe { cstr(sig_b64) })
    else {
        return 0;
    };
    let Ok(key) = vodozemac::Ed25519PublicKey::from_base64(&pk) else { return 0 };
    let Ok(sig) = vodozemac::Ed25519Signature::from_base64(&sg) else { return 0 };
    key.verify(d.as_bytes(), &sig).is_ok() as i32
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
    fn session_pickle_continues_ratchet() {
        // Сессию можно сохранить и восстановить — ratchet продолжается корректно.
        let mut bob = E2EAccount::new();
        let otks = bob.generate_otks(1, 1);
        let bob_id = bob.identity_b64();
        let alice = E2EAccount::new();
        let mut a = alice.outbound(&bob_id, &otks[0].1).unwrap();
        let (t1, c1) = a.encrypt(b"m1");
        let (b, _pt) = bob.inbound(&alice.identity_b64(), t1, &c1).unwrap();

        // Сохраняем сессию B и восстанавливаем.
        let pickle = b.pickle_json();
        let mut b2 = E2ESession::from_pickle_json(&pickle).expect("restore");

        // Второе сообщение расшифровывается ВОССТАНОВЛЕННОЙ сессией.
        let (t2, c2) = a.encrypt(b"m2");
        assert_eq!(b2.decrypt(t2, &c2).unwrap(), b"m2");
    }

    #[test]
    fn repeated_prekey_decrypts_with_existing_session() {
        // Пока получатель не ответил, отправитель шлёт PRE-KEY сообщения (ctype=0).
        // Получатель создаёт inbound на ПЕРВОМ, последующие prekey расшифровывает
        // ТОЙ ЖЕ сессией (без повторного расхода one-time). Это чинит E2E после
        // рестарта (msg2 приходит prekey, one-time уже израсходован).
        let mut bob = E2EAccount::new();
        let otks = bob.generate_otks(1, 1);
        let bob_id = bob.identity_b64();
        let alice = E2EAccount::new();
        let mut a = alice.outbound(&bob_id, &otks[0].1).unwrap();
        let (t1, c1) = a.encrypt(b"m1");
        assert_eq!(t1, 0, "первое — pre-key");
        let (mut b, pt1) = bob.inbound(&alice.identity_b64(), t1, &c1).unwrap();
        assert_eq!(pt1, b"m1");
        // Второе — ТОЖЕ pre-key (bob не ответил).
        let (t2, c2) = a.encrypt(b"m2");
        assert_eq!(t2, 0, "второе тоже pre-key");
        // Расшифровать СУЩЕСТВУЮЩЕЙ сессией (а не новой inbound).
        let pt2 = b.decrypt(t2, &c2).expect("prekey расшифрован существующей сессией");
        assert_eq!(pt2, b"m2");
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
    fn megolm_group_round_trip() {
        // A создаёт исходящую group session, раздаёт session_key, шифрует.
        let mut a = E2EGroupSession::new();
        let key = a.session_key_b64();
        let c1 = a.encrypt("привет группе".as_bytes());
        // Участник B создаёт входящую из session_key и расшифровывает.
        let mut b = E2EInboundGroup::from_session_key(&key).expect("inbound group");
        assert_eq!(b.decrypt(&c1).unwrap(), "привет группе".as_bytes());
        // Следующие сообщения.
        let c2 = a.encrypt("второе".as_bytes());
        assert_eq!(b.decrypt(&c2).unwrap(), "второе".as_bytes());
        // Персист входящей сессии — продолжает расшифровывать.
        let mut b2 = E2EInboundGroup::from_pickle_json(&b.pickle_json()).expect("restore");
        let c3 = a.encrypt("третье".as_bytes());
        assert_eq!(b2.decrypt(&c3).unwrap(), "третье".as_bytes());
        // Исходящая тоже пиклится.
        let mut a2 = E2EGroupSession::from_pickle_json(&a.pickle_json()).expect("restore out");
        let c4 = a2.encrypt("четвёртое".as_bytes());
        assert_eq!(b.decrypt(&c4).unwrap(), "четвёртое".as_bytes());
    }

    #[test]
    fn megolm_rotation_excludes_old_key() {
        // Модель ротации после удаления участника: отправитель заводит НОВУЮ
        // исходящую сессию (новый session_key). Оставшийся участник, получив новый
        // ключ, расшифровывает новые сообщения; СТАРАЯ входящая (у «удалённого») —
        // нет (другая megolm-сессия). Это и есть forward secrecy группы.
        let mut a1 = E2EGroupSession::new();
        let key1 = a1.session_key_b64();
        let mut old = E2EInboundGroup::from_session_key(&key1).expect("old inbound");
        let c1 = a1.encrypt("до удаления".as_bytes());
        assert_eq!(old.decrypt(&c1).unwrap(), "до удаления".as_bytes());

        // Ротация: новая исходящая, новый ключ (раздаётся только оставшимся).
        let mut a2 = E2EGroupSession::new();
        let key2 = a2.session_key_b64();
        assert_ne!(key1, key2, "новый ключ должен отличаться");
        let mut fresh = E2EInboundGroup::from_session_key(&key2).expect("new inbound");
        let c2 = a2.encrypt("после удаления".as_bytes());
        // Оставшийся (новый ключ) — расшифровывает.
        assert_eq!(fresh.decrypt(&c2).unwrap(), "после удаления".as_bytes());
        // «Удалённый» со СТАРЫМ ключом — НЕ расшифровывает новое сообщение.
        assert!(old.decrypt(&c2).is_none(), "старый ключ НЕ должен читать новую сессию");
    }

    #[test]
    fn safety_number_symmetric_and_distinct() {
        let a = "AAAA_id_alice";
        let b = "BBBB_id_bob";
        // симметрично: обе стороны получают одинаковый номер
        assert_eq!(safety_number(a, b), safety_number(b, a));
        // формат: 6 групп по 5 цифр
        let sn = safety_number(a, b);
        let groups: Vec<&str> = sn.split(' ').collect();
        assert_eq!(groups.len(), 6);
        assert!(groups.iter().all(|g| g.len() == 5 && g.chars().all(|c| c.is_ascii_digit())));
        // другой ключ → другой номер
        assert_ne!(safety_number(a, b), safety_number(a, "CCCC_id_carol"));
    }

    #[test]
    fn wrong_bundle_no_session() {
        let alice = E2EAccount::new();
        assert!(alice.outbound("не-base64!!!", "тоже-мусор").is_none());
    }

    #[test]
    fn libolm_account_round_trip_and_sign() {
        let mut acc = E2EAccount::new();
        let pickle = acc.to_libolm_pickle("k3y").expect("to libolm");
        let back = E2EAccount::from_libolm_pickle(&pickle, "k3y").expect("from libolm");
        assert_eq!(acc.identity_b64(), back.identity_b64());
        assert_eq!(acc.ed25519_b64(), back.ed25519_b64());
        let sig = acc.sign_b64(b"sync:0:0");
        assert!(!sig.is_empty());
        assert!(E2EAccount::from_libolm_pickle(&pickle, "wrong").is_none());
        assert!(acc.generate_fallback_b64().is_some());
    }

    #[test]
    fn inbound_group_export_import_decrypts() {
        let mut out = E2EGroupSession::new();
        let mut inb = E2EInboundGroup::from_session_key(&out.session_key_b64()).unwrap();
        let ct = out.encrypt(b"one");
        assert_eq!(inb.decrypt(&ct).unwrap(), b"one");
        let exported = inb.export_b64();
        let mut copy = E2EInboundGroup::from_exported(&exported).unwrap();
        let ct2 = out.encrypt(b"two");
        assert_eq!(copy.decrypt(&ct2).unwrap(), b"two");
    }
}
