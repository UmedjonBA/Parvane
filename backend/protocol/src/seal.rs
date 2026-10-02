//! Внешний слой скрытого отправителя (T024, R6, класс 11): HPKE RFC 9180,
//! режим base, DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305,
//! `info = "parvane/v2/sealed\0" ‖ address ‖ "\0" ‖ device_id`. Снаружи сервер
//! видит только устройство-адресата, доказательство права доставки и размер.
//! В L2 внутренний слой выравнивается по сетке 512/2048/8192/32768 (дальше —
//! кратно 32768).

use hpke::aead::ChaCha20Poly1305;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as _, OpModeR, OpModeS, Serializable};
use prost::Message;
use zeroize::Zeroizing;

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{sealed_envelope::Access, DeviceRef, SealedEnvelope, SealedInner};

type Kem = X25519HkdfSha256;
type Kdf = HkdfSha256;
type Aead = ChaCha20Poly1305;

pub const SEALED_INFO: &[u8] = b"parvane/v2/sealed\0";
/// Сетка выравнивания L2.
pub const L2_BUCKETS: [usize; 4] = [512, 2048, 8192, 32768];

/// Пара ключей HPKE устройства: (приватный, публичный), по 32 байта.
pub fn generate_keypair() -> (Zeroizing<[u8; 32]>, [u8; 32]) {
    let (sk, pk) = Kem::gen_keypair();
    let mut s = Zeroizing::new([0u8; 32]);
    s.copy_from_slice(&sk.to_bytes());
    let mut p = [0u8; 32];
    p.copy_from_slice(&pk.to_bytes());
    (s, p)
}

fn info(recipient: &DeviceRef) -> Result<Vec<u8>> {
    address::check_device(recipient)?;
    let mut v = SEALED_INFO.to_vec();
    v.extend_from_slice(recipient.address.as_bytes());
    v.push(0);
    v.extend_from_slice(recipient.device_id.as_bytes());
    Ok(v)
}

/// Размер цели L2 для внутреннего слоя длины `len`.
pub fn l2_target(len: usize) -> usize {
    for b in L2_BUCKETS {
        if len <= b {
            return b;
        }
    }
    len.div_ceil(32768) * 32768
}

fn varint_len(mut v: usize) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

/// Длина заполнения `p ≥ 1`, при которой поле `padding` (тег, varint длины и
/// `p` байт) доводит сериализацию длины `base` ТОЧНО до сетки L2. Корзина,
/// в которую точно попасть нельзя, пропускается — берётся следующая: остаток
/// 2 байта (пустое поле proto3 не пишется, а `p = 1` даёт уже 3) и границы
/// varint длины (остаток 130 или 16387). Из двух соседних корзин подходит
/// хотя бы одна, поэтому размер всегда лежит на сетке и не выдаёт длину.
pub fn l2_padding_len(base: usize) -> usize {
    let mut target = l2_target(base.saturating_add(3));
    for _ in 0..4 {
        let room = target.saturating_sub(base);
        // room = 1 (тег) + varint_len(p) + p
        for vl in 1..=5usize {
            if let Some(p) = room.checked_sub(1 + vl) {
                if p >= 1 && varint_len(p) == vl {
                    return p;
                }
            }
        }
        target = l2_target(target.saturating_add(1));
    }
    // Недостижимо (см. выше); на всякий случай — ближайшее не меньше сетки.
    target.saturating_sub(base).saturating_sub(2).max(1)
}

/// Дополнить `inner.padding` так, чтобы сериализация попала точно в сетку.
pub fn pad_l2(inner: &mut SealedInner) {
    inner.padding.clear();
    inner.padding = vec![0u8; l2_padding_len(inner.encoded_len())];
}

/// Запечатать внутренний слой для устройства-адресата.
pub fn seal(recipient: &DeviceRef, recipient_hpke: &[u8; 32], access: Access, mut inner: SealedInner, l2: bool) -> Result<SealedEnvelope> {
    if l2 {
        pad_l2(&mut inner);
    }
    let pk = <Kem as hpke::Kem>::PublicKey::from_bytes(recipient_hpke).map_err(|_| ProtoError::Crypto)?;
    let info = info(recipient)?;
    let pt = Zeroizing::new(inner.encode_to_vec());
    let (enc, ct) = hpke::single_shot_seal::<Aead, Kdf, Kem>(&OpModeS::Base, &pk, &info, &pt, b"")
        .map_err(|_| ProtoError::Crypto)?;
    Ok(SealedEnvelope {
        recipient: Some(recipient.clone()),
        access: Some(access),
        hpke_enc: enc.to_bytes().to_vec(),
        ciphertext: ct,
    })
}

/// Снять внешний слой. `me` — своё устройство (адресат обязан совпасть).
pub fn open(env: &SealedEnvelope, me: &DeviceRef, my_hpke_sk: &[u8; 32]) -> Result<SealedInner> {
    if env.recipient.as_ref() != Some(me) {
        return Err(ProtoError::ContextMismatch);
    }
    let sk = <Kem as hpke::Kem>::PrivateKey::from_bytes(my_hpke_sk).map_err(|_| ProtoError::Crypto)?;
    let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(&env.hpke_enc).map_err(|_| ProtoError::Crypto)?;
    let info = info(me)?;
    let pt = Zeroizing::new(
        hpke::single_shot_open::<Aead, Kdf, Kem>(&OpModeR::Base, &sk, &enc, &info, &env.ciphertext, b"")
            .map_err(|_| ProtoError::Crypto)?,
    );
    decode_checked(&pt, Origin::Client)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(a: &str, d: &str) -> DeviceRef {
        DeviceRef { address: a.into(), device_id: d.into() }
    }

    #[test]
    fn roundtrip() {
        let (sk, pk) = generate_keypair();
        let me = dev("bob@x", "d1");
        let inner = SealedInner { olm_message: b"olm".to_vec(), olm_type: 1, ..Default::default() };
        let env = seal(&me, &pk, Access::DeliveryKey(vec![1; 32]), inner.clone(), false).unwrap();
        assert_eq!(open(&env, &me, &sk).unwrap(), inner);
    }

    #[test]
    fn wrong_recipient_or_tamper() {
        let (sk, pk) = generate_keypair();
        let me = dev("bob@x", "d1");
        let inner = SealedInner { olm_message: b"olm".to_vec(), ..Default::default() };
        let mut env = seal(&me, &pk, Access::DeliveryKey(vec![1; 32]), inner, false).unwrap();
        // Сервер переадресовал другому устройству: info не сходится.
        let other = dev("bob@x", "d2");
        let mut moved = env.clone();
        moved.recipient = Some(other.clone());
        assert!(open(&moved, &other, &sk).is_err());
        // Изменённый байт — отказ до выдачи данных.
        env.ciphertext[0] ^= 1;
        assert_eq!(open(&env, &me, &sk), Err(ProtoError::Crypto));
    }

    #[test]
    fn l2_padding_hits_grid() {
        let on_grid = |len: usize| L2_BUCKETS.contains(&len) || (len > 32768 && len % 32768 == 0);
        // Все длины вокруг границ корзин и границ varint длины заполнения.
        let sizes = (0usize..700).chain(1800..2100).chain(7900..8300).chain(16000..16500).chain(32500..33000).chain([40000, 65400, 65533, 65534, 65535, 65536, 98300, 300000]);
        for n in sizes {
            let mut inner = SealedInner { olm_message: vec![7; n], ..Default::default() };
            let base = inner.encoded_len();
            pad_l2(&mut inner);
            let len = inner.encoded_len();
            assert!(on_grid(len) && len >= base + 3, "{n} → {len}");
            assert!(!inner.padding.is_empty() && inner.padding.len() <= 65536, "{n}: заполнение {}", inner.padding.len());
            // Получатель принимает: лимиты схемы до разбора.
            assert!(decode_checked::<SealedInner>(&inner.encode_to_vec(), Origin::Client).is_ok(), "{n}");
        }
        // Корзина, в которую точно не попасть, пропускается: остаток 2 байта и
        // границы varint (130, 16387).
        assert_eq!(l2_padding_len(510), 2048 - 510 - 3);
        assert_eq!(l2_padding_len(509), 1);
        assert_eq!(l2_padding_len(512 - 130), 2048 - (512 - 130) - 3);
        assert_eq!(l2_padding_len(512 - 129), 127);
        assert_eq!(l2_padding_len(32768 - 16387), 32768 + 16387 - 4);
        // Два разных размера в одной корзине — один размер шифртекста.
        let (_, pk) = generate_keypair();
        let me = dev("bob@x", "d1");
        let a = seal(&me, &pk, Access::DeliveryKey(vec![1; 32]), SealedInner { olm_message: vec![1; 10], ..Default::default() }, true).unwrap();
        let b = seal(&me, &pk, Access::DeliveryKey(vec![1; 32]), SealedInner { olm_message: vec![1; 300], ..Default::default() }, true).unwrap();
        assert_eq!(a.ciphertext.len(), b.ciphertext.len());
    }
}
