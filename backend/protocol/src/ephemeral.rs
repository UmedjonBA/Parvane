//! Эфемерные каналы v2 (T077, FR-013, R12; класс 2): «печатает» и
//! присутствие на секретных 128-битных id каналов вместо коротких FNV-id v1.
//!
//! Канал = (id 16 байт, ключ 32 байта). Знание id — право подписки; ключ —
//! расшифровка payload (ChaCha20-Poly1305, AAD = контекст ‖ вид ‖ id), поэтому
//! сервер, пересылающий байты, не видит ни кто печатает, ни статус. Открытый
//! текст (`EphemeralInner`) дополняется до фиксированного размера — длина
//! шифртекста не выдаёт адрес/действие.
//!
//! Откуда клиенты берут каналы (все — без участия сервера):
//! - присутствие пользователя — из его ключа доставки (R7), который он и так
//!   раздаёт собеседникам по E2E: `presence(delivery_key, generation)`.
//!   Ротация ключа доставки при отзыве устройства (D-11) меняет канал;
//!   `generation` — ротация без смены ключа (например, канал «занят» чужим
//!   после рестарта gateway);
//! - «печатает» в личном чате — из ключей доставки обоих собеседников
//!   (порядок не важен): знают только двое;
//! - «печатает» в группе — из ключа конверта ТЕКУЩЕЙ эпохи (его получают все
//!   читающие участники эпохи), публикация — анонимно с подписью ключом
//!   отправки эпохи (D-07, `ephemeral.group_typing`);
//! - произвольный канал — `generate` + раздача `EphemeralChannelSecret` по E2E.
//!
//! В L2-режиме каналы не используются вовсе (`allowed`): ни публикации, ни
//! подписки — иначе тайминги «печатает» раскрывают переписку.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use prost::Message;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{Ref, UserRef};
use crate::pb::parvane::msg::v2::{ephemeral_inner, EphemeralChannelSecret, EphemeralInner, PresenceSignal, TypingAction, TypingSignal};

/// Длина id канала (R12: 128 бит).
pub const CHANNEL_ID_LEN: usize = 16;
pub const CHANNEL_KEY_LEN: usize = 32;
/// Потолок payload в схеме (`EphemeralTypingRequest.payload`).
pub const MAX_PAYLOAD: usize = 256;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Сетка размеров открытого текста: адрес ≤ 255 байт в схеме, типичный — до
/// ~100; две корзины, всё больше — отказ (не влезет в 256 байт payload).
const INNER_BUCKETS: [usize; 2] = [160, MAX_PAYLOAD - NONCE_LEN - TAG_LEN];

const AEAD_CTX: &[u8] = b"parvane/v2/eph\0";
const HKDF_PRESENCE: &[u8] = b"parvane/v2/eph-presence\0";
const HKDF_DIRECT_TYPING: &[u8] = b"parvane/v2/eph-direct-typing\0";
const HKDF_GROUP_TYPING: &[u8] = b"parvane/v2/eph-group-typing\0";

/// Вид канала (входит в AAD: payload одного вида не принимается как другой).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Presence,
    DirectTyping,
    GroupTyping,
}

impl ChannelKind {
    fn tag(self) -> u8 {
        match self {
            ChannelKind::Presence => 1,
            ChannelKind::DirectTyping => 2,
            ChannelKind::GroupTyping => 3,
        }
    }
}

/// Секрет эфемерного канала.
#[derive(Clone)]
pub struct EphChannel {
    pub id: [u8; CHANNEL_ID_LEN],
    key: Zeroizing<[u8; CHANNEL_KEY_LEN]>,
    pub kind: ChannelKind,
    pub generation: u32,
}

impl std::fmt::Debug for EphChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Ключ не печатается.
        f.debug_struct("EphChannel").field("kind", &self.kind).field("generation", &self.generation).finish_non_exhaustive()
    }
}

/// Эфемерные каналы разрешены только вне L2 (T076/T077).
pub fn allowed(l2_active: bool) -> bool {
    !l2_active
}

fn derive(ikm: &[u8], salt: &[u8], info_parts: &[&[u8]]) -> Result<([u8; CHANNEL_ID_LEN], Zeroizing<[u8; CHANNEL_KEY_LEN]>)> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut info = Vec::new();
    for p in info_parts {
        info.extend_from_slice(&(p.len() as u32).to_be_bytes());
        info.extend_from_slice(p);
    }
    let mut okm = Zeroizing::new([0u8; CHANNEL_ID_LEN + CHANNEL_KEY_LEN]);
    hk.expand(&info, okm.as_mut()).map_err(|_| ProtoError::Crypto)?;
    let mut id = [0u8; CHANNEL_ID_LEN];
    id.copy_from_slice(&okm[..CHANNEL_ID_LEN]);
    let mut key = Zeroizing::new([0u8; CHANNEL_KEY_LEN]);
    key.copy_from_slice(&okm[CHANNEL_ID_LEN..]);
    Ok((id, key))
}

fn check_delivery_key(k: &[u8]) -> Result<()> {
    if k.len() != 32 {
        return Err(ProtoError::InvalidField("delivery_key"));
    }
    Ok(())
}

impl EphChannel {
    /// Случайный канал (раздаётся по E2E как `EphemeralChannelSecret`).
    pub fn generate(kind: ChannelKind) -> Self {
        let mut id = [0u8; CHANNEL_ID_LEN];
        let mut key = Zeroizing::new([0u8; CHANNEL_KEY_LEN]);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, key.as_mut());
        Self { id, key, kind, generation: 0 }
    }

    /// Новый случайный канал того же вида, поколение +1 (ротация).
    pub fn rotate(&self) -> Self {
        let mut c = Self::generate(self.kind);
        c.generation = self.generation.wrapping_add(1);
        c
    }

    /// Канал присутствия пользователя из его ключа доставки.
    pub fn presence(delivery_key: &[u8], generation: u32) -> Result<Self> {
        check_delivery_key(delivery_key)?;
        let (id, key) = derive(delivery_key, HKDF_PRESENCE, &[&generation.to_be_bytes()])?;
        Ok(Self { id, key, kind: ChannelKind::Presence, generation })
    }

    /// «Печатает» в личном чате из ключей доставки обоих (порядок не важен).
    pub fn direct_typing(dk_a: &[u8], dk_b: &[u8], generation: u32) -> Result<Self> {
        check_delivery_key(dk_a)?;
        check_delivery_key(dk_b)?;
        let (lo, hi) = if dk_a <= dk_b { (dk_a, dk_b) } else { (dk_b, dk_a) };
        let mut ikm = Zeroizing::new(Vec::with_capacity(64));
        ikm.extend_from_slice(lo);
        ikm.extend_from_slice(hi);
        let (id, key) = derive(&ikm, HKDF_DIRECT_TYPING, &[&generation.to_be_bytes()])?;
        Ok(Self { id, key, kind: ChannelKind::DirectTyping, generation })
    }

    /// «Печатает» в группе из ключа конверта эпохи.
    pub fn group_typing(envelope_key: &[u8; 32], group: &Ref, epoch: u64) -> Result<Self> {
        address::check_ref(group)?;
        let (id, key) = derive(envelope_key, HKDF_GROUP_TYPING, &[group.domain.as_bytes(), &group.id, &epoch.to_be_bytes()])?;
        Ok(Self { id, key, kind: ChannelKind::GroupTyping, generation: 0 })
    }

    /// Из секрета, полученного по E2E (проверка длин).
    pub fn from_secret(kind: ChannelKind, s: &EphemeralChannelSecret) -> Result<Self> {
        let id: [u8; CHANNEL_ID_LEN] = s.channel_id.as_slice().try_into().map_err(|_| ProtoError::InvalidField("channel_id"))?;
        let k: [u8; CHANNEL_KEY_LEN] = s.key.as_slice().try_into().map_err(|_| ProtoError::InvalidField("key"))?;
        Ok(Self { id, key: Zeroizing::new(k), kind, generation: s.generation })
    }

    /// Секрет для раздачи по E2E.
    pub fn to_secret(&self) -> EphemeralChannelSecret {
        EphemeralChannelSecret { channel_id: self.id.to_vec(), key: self.key.to_vec(), generation: self.generation }
    }

    /// NATS-subject канала (для обвязок/тестов; строится только генератором реестра).
    pub fn subject(&self) -> Result<String> {
        crate::registry_gen::eph_subject(&self.id)
    }

    fn aad(&self) -> Vec<u8> {
        let mut a = AEAD_CTX.to_vec();
        a.push(self.kind.tag());
        a.extend_from_slice(&self.id);
        a
    }

    /// Запечатать сигнал: nonce(12) ‖ ChaCha20-Poly1305(inner, дополненный до корзины).
    pub fn seal(&self, inner: &EphemeralInner) -> Result<Vec<u8>> {
        let mut inner = inner.clone();
        if let Some(u) = &inner.from {
            address::check_user(u)?;
        }
        pad_inner(&mut inner)?;
        let pt = Zeroizing::new(inner.encode_to_vec());
        let mut nonce = [0u8; NONCE_LEN];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
        let cipher = ChaCha20Poly1305::new(Key::from_slice(self.key.as_ref()));
        let ct = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &pt, aad: &self.aad() }).map_err(|_| ProtoError::Crypto)?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        if out.len() > MAX_PAYLOAD {
            return Err(ProtoError::FieldLimit("payload"));
        }
        Ok(out)
    }

    /// Открыть payload канала. Чужой ключ/вид/канал, изменённый байт — отказ.
    pub fn open(&self, payload: &[u8]) -> Result<EphemeralInner> {
        if payload.len() > MAX_PAYLOAD || payload.len() < NONCE_LEN + TAG_LEN {
            return Err(ProtoError::InvalidField("payload"));
        }
        let cipher = ChaCha20Poly1305::new(Key::from_slice(self.key.as_ref()));
        let pt = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&payload[..NONCE_LEN]), Payload { msg: &payload[NONCE_LEN..], aad: &self.aad() })
                .map_err(|_| ProtoError::Crypto)?,
        );
        let inner: EphemeralInner = decode_checked(&pt, Origin::Client)?;
        if let Some(u) = &inner.from {
            address::check_user(u)?;
        }
        Ok(inner)
    }
}

fn varint_len(mut v: usize) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

/// Дополнить `padding` так, чтобы сериализация точно попала в корзину.
fn pad_inner(inner: &mut EphemeralInner) -> Result<()> {
    inner.padding.clear();
    let base = inner.encoded_len();
    let target = INNER_BUCKETS.iter().copied().find(|b| base + 2 <= *b).ok_or(ProtoError::FieldLimit("ephemeral"))?;
    // Поле padding: тег (1) + varint длины + p байт == target - base.
    let room = target - base;
    let mut p = room.saturating_sub(2);
    while p > 0 && 1 + varint_len(p) + p > room {
        p -= 1;
    }
    inner.padding = vec![0u8; p];
    Ok(())
}

/// Сигнал «печатает».
pub fn typing(from: &str, action: TypingAction, ts_ms: i64) -> EphemeralInner {
    EphemeralInner {
        from: Some(UserRef { address: from.to_string() }),
        signal: Some(ephemeral_inner::Signal::Typing(TypingSignal { action: action as i32 })),
        ts_ms,
        padding: vec![],
    }
}

/// Сигнал присутствия.
pub fn presence(from: &str, online: bool, last_seen_ms: i64, ts_ms: i64) -> EphemeralInner {
    EphemeralInner {
        from: Some(UserRef { address: from.to_string() }),
        signal: Some(ephemeral_inner::Signal::Presence(PresenceSignal { online, last_seen_ms })),
        ts_ms,
        padding: vec![],
    }
}

/// Принимать ли входящий сигнал: не в L2, не старше `max_age_ms` (повтор
/// старого сигнала через канал ничего не даёт), не из будущего > 60 с.
pub fn accept(inner: &EphemeralInner, l2_active: bool, now_ms: i64, max_age_ms: i64) -> bool {
    // ENG-02: `ts_ms` задаёт отправитель — крайнее значение переполняло вычитание
    // и роняло клиентов с debug-движком одним сигналом «печатает»
    allowed(l2_active)
        && inner.ts_ms <= now_ms.saturating_add(60_000)
        && now_ms.saturating_sub(inner.ts_ms) <= max_age_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_fixed_size() {
        let c = EphChannel::generate(ChannelKind::DirectTyping);
        let a = c.seal(&typing("a@x", TypingAction::Typing, 1)).unwrap();
        let b = c.seal(&typing("very.long.address.of.someone@example.org", TypingAction::ChoosingSticker, 1_700_000_000_000)).unwrap();
        assert_eq!(a.len(), b.len(), "длина не выдаёт адрес/действие");
        assert!(a.len() <= MAX_PAYLOAD);
        let got = c.open(&b).unwrap();
        assert_eq!(got.from.unwrap().address, "very.long.address.of.someone@example.org");
        let p = c.seal(&presence("a@x", true, 0, 5)).unwrap();
        assert_eq!(p.len(), a.len());
    }

    #[test]
    fn long_address_goes_to_second_bucket_or_fails() {
        let c = EphChannel::generate(ChannelKind::Presence);
        let long = format!("{}@{}", "a".repeat(128), "d".repeat(40));
        let s = c.seal(&presence(&long, true, 0, 1)).unwrap();
        assert_eq!(s.len(), MAX_PAYLOAD);
        // Предельный адрес схемы (255 байт) в 256 байт payload не помещается.
        let too_long = format!("{}@{}", "a".repeat(128), "d".repeat(126));
        assert!(crate::address::is_valid_address(&too_long));
        assert_eq!(c.seal(&presence(&too_long, true, 0, 1)).unwrap_err(), ProtoError::FieldLimit("ephemeral"));
    }

    #[test]
    fn wrong_key_kind_or_tamper_rejected() {
        let c = EphChannel::generate(ChannelKind::DirectTyping);
        let other = EphChannel::generate(ChannelKind::DirectTyping);
        let mut s = c.seal(&typing("a@x", TypingAction::Typing, 1)).unwrap();
        assert_eq!(other.open(&s).unwrap_err(), ProtoError::Crypto);
        // Тот же ключ и id, другой вид — AAD не сходится.
        let mut as_presence = c.clone();
        as_presence.kind = ChannelKind::Presence;
        assert!(as_presence.open(&s).is_err());
        // Перенос в канал с другим id (сервер переадресовал) — отказ.
        let mut moved = c.clone();
        moved.id[0] ^= 1;
        assert!(moved.open(&s).is_err());
        s[20] ^= 1;
        assert_eq!(c.open(&s).unwrap_err(), ProtoError::Crypto);
        assert!(c.open(&[0u8; 10]).is_err());
    }

    #[test]
    fn derived_channels() {
        let (a, b) = ([1u8; 32], [2u8; 32]);
        let t1 = EphChannel::direct_typing(&a, &b, 0).unwrap();
        let t2 = EphChannel::direct_typing(&b, &a, 0).unwrap();
        assert_eq!(t1.id, t2.id, "оба собеседника выводят один канал");
        let s = t1.seal(&typing("a@x", TypingAction::Typing, 1)).unwrap();
        assert!(t2.open(&s).is_ok());
        // Третий с одним из ключей — другой канал.
        assert_ne!(EphChannel::direct_typing(&a, &[3u8; 32], 0).unwrap().id, t1.id);
        // Ротация поколения и смена ключа доставки меняют канал присутствия.
        let p0 = EphChannel::presence(&a, 0).unwrap();
        assert_ne!(p0.id, EphChannel::presence(&a, 1).unwrap().id);
        assert_ne!(p0.id, EphChannel::presence(&[9u8; 32], 0).unwrap().id);
        assert_eq!(p0.id, EphChannel::presence(&a, 0).unwrap().id);
        // Канал присутствия не совпадает с хэшем ключа доставки у сервера.
        let h = <Sha256 as sha2::Digest>::digest(a);
        assert_ne!(&h[..16], &p0.id[..]);
        assert!(EphChannel::presence(&[1u8; 31], 0).is_err());
        let g = Ref { domain: "local".into(), id: vec![7; 16] };
        let e1 = EphChannel::group_typing(&[5; 32], &g, 1).unwrap();
        assert_ne!(e1.id, EphChannel::group_typing(&[5; 32], &g, 2).unwrap().id, "новая эпоха — новый канал");
        assert_ne!(e1.id, EphChannel::group_typing(&[6; 32], &g, 1).unwrap().id);
        let r = t1.rotate();
        assert_ne!(r.id, t1.id);
        assert_eq!(r.generation, 1);
    }

    #[test]
    fn secret_roundtrip_and_l2() {
        let c = EphChannel::generate(ChannelKind::Presence);
        let s = c.to_secret();
        let c2 = EphChannel::from_secret(ChannelKind::Presence, &s).unwrap();
        assert_eq!(c2.id, c.id);
        assert!(c2.open(&c.seal(&presence("a@x", true, 0, 1)).unwrap()).is_ok());
        assert!(EphChannel::from_secret(ChannelKind::Presence, &EphemeralChannelSecret { channel_id: vec![1; 15], key: vec![0; 32], generation: 0 }).is_err());
        assert!(c.subject().unwrap().starts_with(crate::registry_gen::EPH_PREFIX));
        assert!(!allowed(true) && allowed(false));
        let t = typing("a@x", TypingAction::Typing, 1_000);
        assert!(accept(&t, false, 2_000, 10_000));
        assert!(!accept(&t, true, 2_000, 10_000), "L2: сигналы не принимаются");
        assert!(!accept(&t, false, 100_000, 10_000), "старый сигнал");
        assert!(format!("{c:?}").find("key").is_none());
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;

    #[test]
    fn extreme_timestamps_do_not_overflow() {
        // ENG-02: крайние метки времени от собеседника — отказ, не паника
        let now = 1_700_000_000_000;
        let min = EphemeralInner { ts_ms: i64::MIN, ..Default::default() };
        let max = EphemeralInner { ts_ms: i64::MAX, ..Default::default() };
        assert!(!accept(&min, false, now, 30_000));
        assert!(!accept(&max, false, now, 30_000));
        let fresh = EphemeralInner { ts_ms: now - 1000, ..Default::default() };
        assert!(accept(&fresh, false, now, 30_000));
    }
}
