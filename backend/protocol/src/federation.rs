//! Проверка межсерверных кадров (T104, R12, FR-051). Транспорта S2S нет —
//! здесь только то, что понадобится серверу-получателю, когда он появится:
//!
//! 1. Описатель чужого сервера (`SignedServerDescriptor`, получен по
//!    `https://<домен>/.well-known/parvane`) подписан его же `server_key`,
//!    домен описателя совпадает с ожидаемым; если ключ уже известен
//!    (закреплён при первом контакте) — смена ключа отвергается.
//! 2. Кадр (`S2SFrame`): `origin_domain` == домен описателя, `dest_domain` ==
//!    свой домен, подпись ключом описателя над каноничными байтами (контекст
//!    [`ctx::S2S_FRAME`]), свежесть по `issued_ms`, повтор `nonce` отвергается.
//! 3. Доверие ограничено доменом: всё, что кадр утверждает о пользователях,
//!    устройствах и объектах, принимается, только если они принадлежат
//!    `origin_domain` ([`VerifiedS2S::require_origin_address`] и соседи).
//!
//! Подпись проверяется над полями присланного кадра; кадр не пересобирается.

use prost::Message;
use sha2::{Digest, Sha256};

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{
    s2s_request, s2s_response, DeviceRef, Error as PbError, ErrorCode, Ref, Request, S2sFrame, S2sRequest, S2sResponse,
    S2sStreamChunk, ServerDescriptor, SignedServerDescriptor, UserRef,
};
use crate::pb::parvane::msg::v2::{inbox_record, InboxRecord};
use crate::sign::{self, ctx, OpSigner, ReplayGuard};
use crate::PROTO_MAJOR;

/// Допустимое расхождение часов серверов (в обе стороны).
pub const MAX_SKEW_MS: i64 = 5 * 60 * 1000;
/// Длина `nonce` кадра.
pub const NONCE_LEN: usize = 16;
/// Максимальная длина имени типа полезной нагрузки.
pub const MAX_PAYLOAD_TYPE: usize = 128;

/// Проверенный описатель чужого сервера: ему можно верить в пределах домена.
#[derive(Debug, Clone)]
pub struct TrustedServer {
    pub domain: String,
    pub server_key: [u8; 32],
    pub descriptor: ServerDescriptor,
}

/// Проверенный кадр.
#[derive(Debug, Clone)]
pub struct VerifiedS2S {
    pub origin_domain: String,
    pub dest_domain: String,
    pub issued_ms: i64,
    pub nonce: Vec<u8>,
    pub payload_type: String,
    pub payload: Vec<u8>,
}

fn same_domain(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn is_valid_payload_type(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_PAYLOAD_TYPE
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
}

/// Проверить описатель чужого сервера.
///
/// `expected_domain` — домен, для которого описатель запрошен (из адреса
/// собеседника или `origin_domain` кадра). `pinned_key` — ранее закреплённый
/// ключ этого домена, если есть: другой ключ → `RootMismatch` (подмена
/// описателя или смена ключа без процедуры ротации).
pub fn verify_descriptor(
    signed: &SignedServerDescriptor,
    expected_domain: &str,
    pinned_key: Option<&[u8; 32]>,
) -> Result<TrustedServer> {
    if !address::is_valid_domain(expected_domain) {
        return Err(ProtoError::BadAddress);
    }
    let d: ServerDescriptor = decode_checked(&signed.descriptor, Origin::Server)?;
    let key: [u8; 32] = d.server_key.as_slice().try_into().map_err(|_| ProtoError::InvalidField("server_key"))?;
    // Подпись над присланными байтами описателя его же ключом.
    sign::verify_ctx(&key, &signed.signature, ctx::SERVER_DESCRIPTOR, &[&signed.descriptor])?;
    if !address::is_valid_domain(&d.domain) || !same_domain(&d.domain, expected_domain) {
        return Err(ProtoError::ContextMismatch);
    }
    if d.proto_major != PROTO_MAJOR {
        return Err(ProtoError::UnsupportedMajor(d.proto_major));
    }
    if let Some(pin) = pinned_key {
        if pin != &key {
            return Err(ProtoError::RootMismatch);
        }
    }
    Ok(TrustedServer { domain: d.domain.clone(), server_key: key, descriptor: d })
}

/// Поля кадра в каноничном виде (без контекста подписи).
fn frame_fields(
    origin_domain: &str,
    dest_domain: &str,
    issued_ms: i64,
    nonce: &[u8],
    payload_type: &str,
    payload: &[u8],
) -> Result<Vec<u8>> {
    if !address::is_valid_domain(origin_domain) || !address::is_valid_domain(dest_domain) {
        return Err(ProtoError::BadAddress);
    }
    if nonce.len() != NONCE_LEN {
        return Err(ProtoError::InvalidField("nonce"));
    }
    if !is_valid_payload_type(payload_type) {
        return Err(ProtoError::InvalidField("payload_type"));
    }
    let digest = Sha256::digest(payload);
    let mut v = Vec::with_capacity(origin_domain.len() + dest_domain.len() + payload_type.len() + 64);
    // Домены ≤ 128 и имя типа ≤ 128 (проверено выше) — умещаются в u8.
    v.push(origin_domain.len() as u8);
    v.extend_from_slice(origin_domain.as_bytes());
    v.push(dest_domain.len() as u8);
    v.extend_from_slice(dest_domain.as_bytes());
    v.extend_from_slice(&issued_ms.to_be_bytes());
    v.extend_from_slice(nonce);
    v.push(payload_type.len() as u8);
    v.extend_from_slice(payload_type.as_bytes());
    v.extend_from_slice(&digest);
    Ok(v)
}

/// Каноничные подписываемые байты кадра: `ctx::S2S_FRAME ‖ поля`.
pub fn frame_signing_bytes(
    origin_domain: &str,
    dest_domain: &str,
    issued_ms: i64,
    nonce: &[u8],
    payload_type: &str,
    payload: &[u8],
) -> Result<Vec<u8>> {
    let mut v = ctx::S2S_FRAME.to_vec();
    v.extend_from_slice(&frame_fields(origin_domain, dest_domain, issued_ms, nonce, payload_type, payload)?);
    Ok(v)
}

/// Подписать кадр ключом своего сервера (для тестов и будущего транспорта).
pub fn sign_frame(
    key: &dyn OpSigner,
    origin_domain: &str,
    dest_domain: &str,
    issued_ms: i64,
    payload_type: &str,
    payload: Vec<u8>,
) -> Result<S2sFrame> {
    let mut nonce = vec![0u8; NONCE_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let fields = frame_fields(origin_domain, dest_domain, issued_ms, &nonce, payload_type, &payload)?;
    let signature = sign::sign_ctx(key, ctx::S2S_FRAME, &[&fields]);
    Ok(S2sFrame {
        origin_domain: origin_domain.to_string(),
        dest_domain: dest_domain.to_string(),
        issued_ms,
        nonce,
        payload_type: payload_type.to_string(),
        payload,
        signature,
    })
}

/// Проверить присланные байты кадра от сервера `sender` (описатель уже
/// проверен [`verify_descriptor`]). `local_domain` — свой домен, `now_ms` —
/// свои часы, `replay` — память о виденных `nonce` (сервер держит её не
/// меньше окна свежести).
pub fn verify_frame(
    bytes: &[u8],
    sender: &TrustedServer,
    local_domain: &str,
    now_ms: i64,
    replay: Option<&mut ReplayGuard>,
) -> Result<VerifiedS2S> {
    let f: S2sFrame = decode_checked(bytes, Origin::Server)?;
    let fields = frame_fields(&f.origin_domain, &f.dest_domain, f.issued_ms, &f.nonce, &f.payload_type, &f.payload)?;
    sign::verify_ctx(&sender.server_key, &f.signature, ctx::S2S_FRAME, &[&fields])?;
    // Кадр — от того сервера, чей описатель проверен, и адресован нам.
    if !same_domain(&f.origin_domain, &sender.domain) {
        return Err(ProtoError::ContextMismatch);
    }
    if !same_domain(&f.dest_domain, local_domain) {
        return Err(ProtoError::ContextMismatch);
    }
    if (i128::from(now_ms) - i128::from(f.issued_ms)).abs() > i128::from(MAX_SKEW_MS) {
        return Err(ProtoError::Expired);
    }
    if let Some(g) = replay {
        let mut key = f.origin_domain.to_ascii_lowercase().into_bytes();
        key.push(0);
        key.extend_from_slice(&f.nonce);
        g.check_and_insert(&key)?;
    }
    Ok(VerifiedS2S {
        origin_domain: f.origin_domain,
        dest_domain: f.dest_domain,
        issued_ms: f.issued_ms,
        nonce: f.nonce,
        payload_type: f.payload_type,
        payload: f.payload,
    })
}

impl VerifiedS2S {
    /// Разобрать полезную нагрузку ожидаемого типа (тип связан подписью).
    pub fn payload_as<M: Message + prost::Name + Default>(&self) -> Result<M> {
        if self.payload_type != M::full_name() {
            return Err(ProtoError::ContextMismatch);
        }
        decode_checked(&self.payload, Origin::Server)
    }

    /// Адрес пользователя `user@domain` принадлежит серверу-отправителю.
    /// Утверждения о чужих (в т.ч. наших) пользователях — `Forbidden`.
    pub fn require_origin_address(&self, addr: &str) -> Result<()> {
        let d = address::address_domain(addr).ok_or(ProtoError::BadAddress)?;
        if same_domain(d, &self.origin_domain) {
            Ok(())
        } else {
            Err(ProtoError::Forbidden)
        }
    }

    /// Все адреса полезной нагрузки принадлежат серверу-отправителю.
    pub fn require_origin_addresses<'a>(&self, addrs: impl IntoIterator<Item = &'a str>) -> Result<()> {
        addrs.into_iter().try_for_each(|a| self.require_origin_address(a))
    }

    pub fn require_origin_user(&self, u: &UserRef) -> Result<()> {
        address::check_user(u)?;
        self.require_origin_address(&u.address)
    }

    pub fn require_origin_device(&self, d: &DeviceRef) -> Result<()> {
        address::check_device(d)?;
        self.require_origin_address(&d.address)
    }

    /// Объект (группа, звонок, контейнер) живёт на сервере-отправителе.
    pub fn require_origin_ref(&self, r: &Ref) -> Result<()> {
        address::check_ref(r)?;
        if same_domain(&r.domain, &self.origin_domain) {
            Ok(())
        } else {
            Err(ProtoError::Forbidden)
        }
    }
}

// ── Транспорт S2S (spec 028) ────────────────────────────────────────────────

/// Тип полезной нагрузки запроса.
pub const REQUEST_TYPE: &str = "parvane.core.v2.S2SRequest";
/// Тип первого кадра ответа.
pub const RESPONSE_TYPE: &str = "parvane.core.v2.S2SResponse";
/// Тип следующих кадров ответа STREAM-метода.
pub const STREAM_CHUNK_TYPE: &str = "parvane.core.v2.S2SStreamChunk";
/// Предел одного кадра в рамке `u32 BE` (полезная нагрузка ≤ 4 000 000 + поля кадра).
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024 + 64 * 1024;
/// Получателей одной записи инбокса.
pub const MAX_PUSH_RECIPIENTS: usize = 200;
/// Канал метода реестра.
const CH_PRE: i32 = 1;
const CH_ID: i32 = 2;

/// Случайный `nonce` кадра.
pub fn new_nonce() -> Vec<u8> {
    let mut nonce = vec![0u8; NONCE_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    nonce
}

/// Подписываемые байты по готовому SHA-256 полезной нагрузки — для подписи по
/// запросу (identity подписывает кадр, не видя тела): та же раскладка, что у
/// [`frame_signing_bytes`].
pub fn frame_signing_bytes_digest(
    origin_domain: &str,
    dest_domain: &str,
    issued_ms: i64,
    nonce: &[u8],
    payload_type: &str,
    payload_sha256: &[u8],
) -> Result<Vec<u8>> {
    if !address::is_valid_domain(origin_domain) || !address::is_valid_domain(dest_domain) {
        return Err(ProtoError::BadAddress);
    }
    if nonce.len() != NONCE_LEN {
        return Err(ProtoError::InvalidField("nonce"));
    }
    if !is_valid_payload_type(payload_type) {
        return Err(ProtoError::InvalidField("payload_type"));
    }
    if payload_sha256.len() != 32 {
        return Err(ProtoError::InvalidField("payload_sha256"));
    }
    let mut v = ctx::S2S_FRAME.to_vec();
    v.push(origin_domain.len() as u8);
    v.extend_from_slice(origin_domain.as_bytes());
    v.push(dest_domain.len() as u8);
    v.extend_from_slice(dest_domain.as_bytes());
    v.extend_from_slice(&issued_ms.to_be_bytes());
    v.extend_from_slice(nonce);
    v.push(payload_type.len() as u8);
    v.extend_from_slice(payload_type.as_bytes());
    v.extend_from_slice(payload_sha256);
    Ok(v)
}

/// Подписать кадр с заданным `nonce` (ответы и тесты).
pub fn sign_frame_with_nonce(
    key: &dyn OpSigner,
    origin_domain: &str,
    dest_domain: &str,
    issued_ms: i64,
    nonce: Vec<u8>,
    payload_type: &str,
    payload: Vec<u8>,
) -> Result<S2sFrame> {
    let fields = frame_fields(origin_domain, dest_domain, issued_ms, &nonce, payload_type, &payload)?;
    let signature = sign::sign_ctx(key, ctx::S2S_FRAME, &[&fields]);
    Ok(S2sFrame {
        origin_domain: origin_domain.to_string(),
        dest_domain: dest_domain.to_string(),
        issued_ms,
        nonce,
        payload_type: payload_type.to_string(),
        payload,
        signature,
    })
}

/// Рамка потока ответа: `u32 BE длина ‖ кадр`.
pub fn frame_push(out: &mut Vec<u8>, frame: &[u8]) -> Result<()> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(ProtoError::FieldLimit("s2s_frame"));
    }
    out.extend_from_slice(&(frame.len() as u32).to_be_bytes());
    out.extend_from_slice(frame);
    Ok(())
}

/// Разборщик потока кадров ответа; длина проверяется до буферизации тела.
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, bytes: &[u8]) -> Result<()> {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() >= 4 {
            let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if len > MAX_FRAME_BYTES {
                return Err(ProtoError::FieldLimit("s2s_frame"));
            }
        }
        Ok(())
    }

    /// Следующий целый кадр, если он уже пришёл.
    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if len > MAX_FRAME_BYTES {
            return Err(ProtoError::FieldLimit("s2s_frame"));
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let frame = self.buf[4..4 + len].to_vec();
        self.buf.drain(..4 + len);
        Ok(Some(frame))
    }

    /// Хвост без целого кадра (обрыв потока).
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

/// Проверить межсерверный запрос: кадр (подпись, адресат, свежесть, повтор) и
/// вид полезной нагрузки. Тело пересылаемого метода проверяется лимитами схемы
/// как вход от клиента — чужой сервер не доверен больше, чем клиент.
pub fn verify_request(
    bytes: &[u8],
    sender: &TrustedServer,
    local_domain: &str,
    now_ms: i64,
    replay: Option<&mut ReplayGuard>,
) -> Result<(VerifiedS2S, S2sRequest)> {
    let v = verify_frame(bytes, sender, local_domain, now_ms, replay)?;
    let req: S2sRequest = v.payload_as()?;
    match req.kind.as_ref().ok_or(ProtoError::Malformed)? {
        s2s_request::Kind::Forward(f) => {
            let m = crate::schema::method(&f.method).ok_or(ProtoError::UnknownMethod)?;
            if !m.federated {
                return Err(ProtoError::Forbidden);
            }
            let probe = Request {
                id: 0,
                method: f.method.clone(),
                body: f.body.clone(),
                timeout_ms: f.timeout_ms.min(30_000),
                padding: vec![],
                dest_domain: String::new(),
            };
            crate::codec::check_request(&probe, Origin::Client)?;
            if m.channel == CH_ID {
                v.require_origin_address(&f.user)?;
                if !address::is_valid_device_id(&f.device_id) {
                    return Err(ProtoError::BadAddress);
                }
            } else if !f.user.is_empty() || !f.device_id.is_empty() {
                // ANON/PRE не несут личности (sealed sender).
                return Err(ProtoError::Forbidden);
            }
            if m.channel == CH_PRE && f.method != "server.describe" {
                return Err(ProtoError::Forbidden);
            }
        }
        s2s_request::Kind::InboxPush(p) => {
            let group = p.group.as_ref().ok_or(ProtoError::InvalidField("group"))?;
            v.require_origin_ref(group)?;
            if p.recipients.is_empty() || p.recipients.len() > MAX_PUSH_RECIPIENTS {
                return Err(ProtoError::InvalidField("recipients"));
            }
            for r in &p.recipients {
                address::check_user(r)?;
                let d = address::address_domain(&r.address).ok_or(ProtoError::BadAddress)?;
                if !same_domain(d, local_domain) {
                    return Err(ProtoError::Forbidden);
                }
            }
            push_record(&p.record, group)?;
        }
        s2s_request::Kind::KeyOwner(k) => {
            if k.ed25519.len() != 32 {
                return Err(ProtoError::InvalidField("ed25519"));
            }
        }
        s2s_request::Kind::PrivacyOf(q) => {
            let d = address::address_domain(&q.user).ok_or(ProtoError::BadAddress)?;
            if !same_domain(d, local_domain) {
                return Err(ProtoError::Forbidden);
            }
        }
        s2s_request::Kind::Ephemeral(e) => {
            if e.channel_id.len() != 16 || e.payload.is_empty() {
                return Err(ProtoError::InvalidField("ephemeral"));
            }
        }
        s2s_request::Kind::AccountGone(g) => {
            v.require_origin_user(g.user.as_ref().ok_or(ProtoError::InvalidField("user"))?)?;
        }
    }
    Ok((v, req))
}

/// Запись инбокса из межсерверного кадра: только конверт или уведомление той же
/// группы, без серверных полей (их ставит получатель).
pub fn push_record(bytes: &[u8], group: &Ref) -> Result<InboxRecord> {
    let rec: InboxRecord = decode_checked(bytes, Origin::Client)?;
    if rec.seq != 0 || rec.received_ms != 0 {
        return Err(ProtoError::InvalidField("record"));
    }
    let same = |r: Option<&Ref>| r.is_some_and(|r| same_domain(&r.domain, &group.domain) && r.id == group.id);
    match rec.item.as_ref() {
        Some(inbox_record::Item::Group(g)) if same(g.group.as_ref()) => Ok(rec),
        Some(inbox_record::Item::GroupState(n)) if same(n.group.as_ref()) => Ok(rec),
        _ => Err(ProtoError::Forbidden),
    }
}

/// Байты полезной нагрузки ответа (подписывает отвечающий сервер).
pub fn response_payload(request_nonce: &[u8], result: std::result::Result<Vec<u8>, PbError>) -> Vec<u8> {
    S2sResponse {
        request_nonce: request_nonce.to_vec(),
        result: Some(match result {
            Ok(b) => s2s_response::Result::Ok(b),
            Err(e) => s2s_response::Result::Error(e),
        }),
    }
    .encode_to_vec()
}

/// Ошибка ответа с кодом.
pub fn error_of(code: ErrorCode, retry_after_ms: u32) -> PbError {
    PbError { code: code as i32, retry_after_ms }
}

/// Проверить первый кадр ответа на свой запрос `request_nonce`.
pub fn verify_response(
    bytes: &[u8],
    sender: &TrustedServer,
    local_domain: &str,
    now_ms: i64,
    request_nonce: &[u8],
) -> Result<S2sResponse> {
    let v = verify_frame(bytes, sender, local_domain, now_ms, None)?;
    let r: S2sResponse = v.payload_as()?;
    if r.request_nonce != request_nonce || r.result.is_none() {
        return Err(ProtoError::ContextMismatch);
    }
    Ok(r)
}

/// Проверить очередной кадр потока ответа (номер — строго по порядку).
pub fn verify_stream_chunk(
    bytes: &[u8],
    sender: &TrustedServer,
    local_domain: &str,
    now_ms: i64,
    request_nonce: &[u8],
    expected_index: u32,
) -> Result<S2sStreamChunk> {
    let v = verify_frame(bytes, sender, local_domain, now_ms, None)?;
    let c: S2sStreamChunk = v.payload_as()?;
    if c.request_nonce != request_nonce || c.index != expected_index {
        return Err(ProtoError::ContextMismatch);
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_bytes_are_unambiguous() {
        let n = [0u8; NONCE_LEN];
        let a = frame_signing_bytes("ab.example", "c.example", 1, &n, "T", b"").unwrap();
        let b = frame_signing_bytes("a.example", "bc.example", 1, &n, "T", b"").unwrap();
        assert_ne!(a, b);
        assert!(frame_signing_bytes("a.example", "b.example", 1, &[0; 15], "T", b"").is_err());
        assert!(frame_signing_bytes("a.example", "b.example", 1, &n, "", b"").is_err());
        assert!(frame_signing_bytes("a.example", "b.example", 1, &n, "a/b", b"").is_err());
        assert!(frame_signing_bytes("a*", "b.example", 1, &n, "T", b"").is_err());
    }
}
