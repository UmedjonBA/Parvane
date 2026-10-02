//! v1-совместимые примитивы Olm/Megolm для web (T056/T057, P-36): то, что
//! раньше давал libolm (`@matrix-org/olm`), — поверх `parvane_protocol::olm`
//! (vodozemac). Формат провода v1 не меняется: ключи, подписи и шифртексты —
//! base64 без дополнения, сессии Olm/Megolm версии 1 — как у `parvane-e2e`
//! (desktop/android) и прежнего web.
//!
//! Pickle: новый формат — `vz1:` + зашифрованный pickle vodozemac (ключ —
//! `olm::pickle_key` от строкового ключа хранилища); строка без префикса
//! читается как libolm-pickle (состояния прежних версий web и копии ключей).

use js_sys::Object;
use parvane_protocol::olm::{self, MegolmInbound, MegolmOutbound, OlmAccount, OlmSession};
use parvane_protocol::ProtoError;
use wasm_bindgen::prelude::*;

use crate::{err_proto, set};

const PICKLE_PREFIX: &str = "vz1:";

fn crypto_err() -> JsValue {
    err_proto(ProtoError::Crypto)
}

fn unb64(text: &str) -> Result<Vec<u8>, JsValue> {
    olm::b64_decode(text).map_err(err_proto)
}

fn sealed(pickle: String) -> String {
    format!("{PICKLE_PREFIX}{pickle}")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Olm-аккаунт устройства (identity-ключи, подпись, прекеи, сессии).
#[wasm_bindgen]
pub struct PvOlmAccount {
    inner: OlmAccount,
}

impl Default for PvOlmAccount {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl PvOlmAccount {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PvOlmAccount {
        PvOlmAccount { inner: OlmAccount::new() }
    }

    /// Восстановить из pickle (`vz1:` — vodozemac, иначе libolm).
    pub fn unpickle(pickle: &str, key: &str) -> Result<PvOlmAccount, JsValue> {
        let inner = match pickle.strip_prefix(PICKLE_PREFIX) {
            Some(p) => OlmAccount::from_pickle(p, &olm::pickle_key(key)),
            None => OlmAccount::from_libolm_pickle(pickle, key.as_bytes()),
        };
        inner.map(|inner| PvOlmAccount { inner }).map_err(err_proto)
    }

    pub fn pickle(&self, key: &str) -> String {
        sealed(self.inner.pickle(&olm::pickle_key(key)))
    }

    /// libolm-pickle для переносимой копии ключей (её читают desktop/android).
    #[wasm_bindgen(js_name = toLibolmPickle)]
    pub fn to_libolm_pickle(&self, key: &str) -> Result<String, JsValue> {
        self.inner.to_libolm_pickle(key.as_bytes()).map_err(err_proto)
    }

    /// Curve25519 identity-ключ (base64).
    #[wasm_bindgen(js_name = identityKey)]
    pub fn identity_key(&self) -> String {
        olm::b64_encode(&self.inner.curve25519())
    }

    /// Ed25519-ключ подписи устройства (base64).
    #[wasm_bindgen(js_name = signingKey)]
    pub fn signing_key(&self) -> String {
        olm::b64_encode(&self.inner.ed25519())
    }

    /// Подпись UTF-8 строки ключом устройства (base64).
    pub fn sign(&self, message: &str) -> String {
        olm::b64_encode(&self.inner.sign(message.as_bytes()))
    }

    /// Сгенерировать `count` одноразовых ключей: возвращает неопубликованные
    /// (base64) и помечает их опубликованными.
    #[wasm_bindgen(js_name = generateOneTimeKeys)]
    pub fn generate_one_time_keys(&mut self, count: usize) -> Vec<String> {
        self.inner.generate_one_time_keys(count).iter().map(|(_, key)| olm::b64_encode(key)).collect()
    }

    /// Новый резервный ключ (signed_prekey бандла), помечается опубликованным;
    /// предыдущий остаётся для pre-key сообщений в пути.
    #[wasm_bindgen(js_name = generateFallbackKey)]
    pub fn generate_fallback_key(&mut self) -> Option<String> {
        self.inner.generate_fallback_key().map(|key| olm::b64_encode(&key))
    }

    /// Исходящая сессия по бандлу собеседника (identity + one-time/fallback).
    #[wasm_bindgen(js_name = createOutboundSession)]
    pub fn create_outbound_session(&self, identity_key: &str, one_time_key: &str) -> Result<PvOlmSession, JsValue> {
        self.inner
            .outbound(&unb64(identity_key)?, &unb64(one_time_key)?)
            .map(|inner| PvOlmSession { inner })
            .map_err(err_proto)
    }

    /// Входящая сессия из pre-key сообщения: `{session, plaintext}`.
    /// Использованный одноразовый ключ удаляется из аккаунта.
    #[wasm_bindgen(js_name = createInboundSession)]
    pub fn create_inbound_session(&mut self, sender_identity: &str, body: &str) -> Result<JsValue, JsValue> {
        let (inner, plaintext) = self.inner.inbound(&unb64(sender_identity)?, &unb64(body)?).map_err(err_proto)?;
        let out = Object::new();
        set(&out, "session", &JsValue::from(PvOlmSession { inner }));
        set(&out, "plaintext", &JsValue::from_str(&text(&plaintext)));
        Ok(out.into())
    }
}

/// Olm-сессия с одним устройством собеседника.
#[wasm_bindgen]
pub struct PvOlmSession {
    inner: OlmSession,
}

#[wasm_bindgen]
impl PvOlmSession {
    pub fn unpickle(pickle: &str, key: &str) -> Result<PvOlmSession, JsValue> {
        let inner = match pickle.strip_prefix(PICKLE_PREFIX) {
            Some(p) => OlmSession::from_pickle(p, &olm::pickle_key(key)),
            None => OlmSession::from_libolm_pickle(pickle, key.as_bytes()),
        };
        inner.map(|inner| PvOlmSession { inner }).map_err(err_proto)
    }

    pub fn pickle(&self, key: &str) -> String {
        sealed(self.inner.pickle(&olm::pickle_key(key)))
    }

    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    /// Зашифровать UTF-8 строку: `{type, body}` (type 0 — pre-key, 1 — обычное).
    pub fn encrypt(&mut self, plaintext: &str) -> Result<JsValue, JsValue> {
        let (message_type, body) = self.inner.encrypt(plaintext.as_bytes()).map_err(err_proto)?;
        let out = Object::new();
        set(&out, "type", &JsValue::from(message_type));
        set(&out, "body", &JsValue::from_str(&olm::b64_encode(&body)));
        Ok(out.into())
    }

    pub fn decrypt(&mut self, message_type: u32, body: &str) -> Result<String, JsValue> {
        self.inner.decrypt(message_type, &unb64(body)?).map(|plain| text(&plain)).map_err(err_proto)
    }

    /// Относится ли pre-key сообщение к этой сессии.
    #[wasm_bindgen(js_name = matchesInbound)]
    pub fn matches_inbound(&self, body: &str) -> bool {
        olm::b64_decode(body).map(|bytes| self.inner.matches_prekey(&bytes)).unwrap_or(false)
    }
}

/// Исходящая Megolm-сессия (своя на группу).
#[wasm_bindgen]
pub struct PvMegolmOutbound {
    inner: MegolmOutbound,
}

impl Default for PvMegolmOutbound {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl PvMegolmOutbound {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PvMegolmOutbound {
        PvMegolmOutbound { inner: MegolmOutbound::new() }
    }

    pub fn unpickle(pickle: &str, key: &str) -> Result<PvMegolmOutbound, JsValue> {
        let inner = match pickle.strip_prefix(PICKLE_PREFIX) {
            Some(p) => MegolmOutbound::from_pickle(p, &olm::pickle_key(key)),
            None => MegolmOutbound::from_libolm_pickle(pickle, key.as_bytes()),
        };
        inner.map(|inner| PvMegolmOutbound { inner }).map_err(err_proto)
    }

    pub fn pickle(&self, key: &str) -> String {
        sealed(self.inner.pickle(&olm::pickle_key(key)))
    }

    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    /// Ключ сессии на текущем индексе для раздачи участникам (base64).
    #[wasm_bindgen(js_name = sessionKey)]
    pub fn session_key(&self) -> String {
        olm::b64_encode(&self.inner.session_key())
    }

    /// Индекс следующего сообщения.
    #[wasm_bindgen(js_name = messageIndex)]
    pub fn message_index(&self) -> u32 {
        self.inner.message_index()
    }

    /// Зашифровать UTF-8 строку → base64 Megolm-сообщения.
    pub fn encrypt(&mut self, plaintext: &str) -> String {
        olm::b64_encode(&self.inner.encrypt(plaintext.as_bytes()))
    }
}

/// Входящая Megolm-сессия участника группы.
#[wasm_bindgen]
pub struct PvMegolmInbound {
    inner: MegolmInbound,
}

#[wasm_bindgen]
impl PvMegolmInbound {
    /// Из ключа сессии (SKDM, base64).
    pub fn create(session_key: &str) -> Result<PvMegolmInbound, JsValue> {
        MegolmInbound::from_session_key(&unb64(session_key)?).map(|inner| PvMegolmInbound { inner }).map_err(err_proto)
    }

    /// Из экспортированного ключа (формат libolm `export_session`, base64).
    #[wasm_bindgen(js_name = importSession)]
    pub fn import_session(exported: &str) -> Result<PvMegolmInbound, JsValue> {
        MegolmInbound::import(&unb64(exported)?).map(|inner| PvMegolmInbound { inner }).map_err(err_proto)
    }

    pub fn unpickle(pickle: &str, key: &str) -> Result<PvMegolmInbound, JsValue> {
        let inner = match pickle.strip_prefix(PICKLE_PREFIX) {
            Some(p) => MegolmInbound::from_pickle(p, &olm::pickle_key(key)),
            None => MegolmInbound::from_libolm_pickle(pickle, key.as_bytes()),
        };
        inner.map(|inner| PvMegolmInbound { inner }).map_err(err_proto)
    }

    pub fn pickle(&self, key: &str) -> String {
        sealed(self.inner.pickle(&olm::pickle_key(key)))
    }

    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    #[wasm_bindgen(js_name = firstKnownIndex)]
    pub fn first_known_index(&self) -> u32 {
        self.inner.first_known_index()
    }

    /// Экспорт ключа с индекса `index` (не раньше первого известного), base64.
    #[wasm_bindgen(js_name = exportSession)]
    pub fn export_session(&mut self, index: u32) -> Result<String, JsValue> {
        self.inner.export_at(index).map(|key| olm::b64_encode(&key)).ok_or_else(crypto_err)
    }

    /// Расшифровать base64 Megolm-сообщения: `{plaintext, messageIndex}`.
    pub fn decrypt(&mut self, ciphertext: &str) -> Result<JsValue, JsValue> {
        let (plaintext, index) = self.inner.decrypt(&unb64(ciphertext)?).map_err(err_proto)?;
        let out = Object::new();
        set(&out, "plaintext", &JsValue::from_str(&text(&plaintext)));
        set(&out, "messageIndex", &JsValue::from(index));
        Ok(out.into())
    }
}

/// Проверка подписи Ed25519 над UTF-8 строкой (ключ и подпись — base64).
#[wasm_bindgen(js_name = ed25519Verify)]
pub fn ed25519_verify(public_key: &str, message: &str, signature: &str) -> bool {
    match (olm::b64_decode(public_key), olm::b64_decode(signature)) {
        (Ok(key), Ok(sig)) => olm::ed25519_verify(&key, message.as_bytes(), &sig),
        _ => false,
    }
}
