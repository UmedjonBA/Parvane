//! Резервная копия корня личности под ключом восстановления (C1-06; инв. 18,
//! 32; R4; D-12).
//!
//! Корень нужен только для смены SSK/корня — на устройстве его держать не
//! нужно. Копия шифруется ключом восстановления из ≥ 128 бит случайности
//! (здесь 184 бита), который движок генерирует сам: режима парольной фразы
//! нет, поэтому копия, попавшая на сервер или в облако, перебором не
//! вскрывается. После подтверждения копии хост удаляет корень с устройства.
//!
//! Ключ восстановления (для человека): 25 байт = 23 байта случайности ‖
//! 2 байта контрольной суммы (SHA-256), Crockford base32, 10 групп по 4
//! символа через «-». При вводе регистр, пробелы и «-» не важны, O→0, I/L→1.
//!
//! Формат копии (байты):
//! `"PVRB"` ‖ версия (1) ‖ root_pub (32) ‖ nonce (12) ‖ ChaCha20-Poly1305(root_secret),
//! ключ = HKDF-SHA256(salt = ctx::ROOT_BACKUP, ikm = случайность ключа, info = адрес),
//! AAD = ctx::ROOT_BACKUP ‖ адрес ‖ "\0" ‖ заголовок (magic ‖ версия ‖ root_pub).

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::address;
use crate::error::{ProtoError, Result};
use crate::sign::ctx;

const MAGIC: &[u8; 4] = b"PVRB";
const VERSION: u8 = 1;
/// Случайность ключа восстановления (бит: 184 ≥ 128).
pub const RECOVERY_ENTROPY_BYTES: usize = 23;
const CHECKSUM_BYTES: usize = 2;
const KEY_BYTES: usize = RECOVERY_ENTROPY_BYTES + CHECKSUM_BYTES;
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const HEADER_LEN: usize = 4 + 1 + 32;
const BLOB_LEN: usize = HEADER_LEN + 12 + 32 + 16;

/// Ключ восстановления (случайность; строка — [`RecoveryKey::to_display`]).
pub struct RecoveryKey(Zeroizing<[u8; RECOVERY_ENTROPY_BYTES]>);

fn checksum(e: &[u8]) -> [u8; CHECKSUM_BYTES] {
    let h = Sha256::digest([b"parvane/v2/recovery-key\0".as_slice(), e].concat());
    [h[0], h[1]]
}

impl RecoveryKey {
    /// Новый случайный ключ восстановления.
    pub fn generate() -> Self {
        let mut e = Zeroizing::new([0u8; RECOVERY_ENTROPY_BYTES]);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, e.as_mut());
        Self(e)
    }

    /// Строка для показа пользователю: `XXXX-XXXX-…` (10 групп).
    pub fn to_display(&self) -> Zeroizing<String> {
        let mut raw = Zeroizing::new([0u8; KEY_BYTES]);
        raw[..RECOVERY_ENTROPY_BYTES].copy_from_slice(self.0.as_ref());
        raw[RECOVERY_ENTROPY_BYTES..].copy_from_slice(&checksum(self.0.as_ref()));
        let mut out = Zeroizing::new(String::with_capacity(50));
        let (mut acc, mut bits, mut n) = (0u32, 0u32, 0usize);
        for b in raw.iter() {
            acc = (acc << 8) | u32::from(*b);
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                if n > 0 && n % 4 == 0 {
                    out.push('-');
                }
                out.push(char::from(ALPHABET[((acc >> bits) & 31) as usize]));
                n += 1;
            }
        }
        out
    }

    /// Разобрать введённый ключ (опечатки ловит контрольная сумма).
    pub fn parse(s: &str) -> Result<Self> {
        let mut raw = Zeroizing::new(Vec::with_capacity(KEY_BYTES));
        let (mut acc, mut bits) = (0u32, 0u32);
        let mut chars = 0usize;
        for c in s.chars() {
            let c = c.to_ascii_uppercase();
            if c == '-' || c.is_whitespace() {
                continue;
            }
            let c = match c {
                'O' => '0',
                'I' | 'L' => '1',
                other => other,
            };
            let v = ALPHABET.iter().position(|a| char::from(*a) == c).ok_or(ProtoError::InvalidField("recovery_key"))?;
            chars += 1;
            if chars > KEY_BYTES * 8 / 5 {
                return Err(ProtoError::InvalidField("recovery_key"));
            }
            acc = ((acc << 5) | v as u32) & 0xFFFF;
            bits += 5;
            if bits >= 8 {
                bits -= 8;
                raw.push(((acc >> bits) & 0xFF) as u8);
            }
        }
        if raw.len() != KEY_BYTES || bits != 0 {
            return Err(ProtoError::InvalidField("recovery_key"));
        }
        let (e, sum) = raw.split_at(RECOVERY_ENTROPY_BYTES);
        if sum != checksum(e) {
            return Err(ProtoError::InvalidField("recovery_key"));
        }
        let mut out = Zeroizing::new([0u8; RECOVERY_ENTROPY_BYTES]);
        out.copy_from_slice(e);
        Ok(Self(out))
    }

    fn wrap_key(&self, user: &str) -> Result<Zeroizing<[u8; 32]>> {
        let hk = Hkdf::<Sha256>::new(Some(ctx::ROOT_BACKUP), self.0.as_ref());
        let mut k = Zeroizing::new([0u8; 32]);
        hk.expand(user.as_bytes(), k.as_mut()).map_err(|_| ProtoError::Crypto)?;
        Ok(k)
    }
}

fn aad(user: &str, header: &[u8]) -> Vec<u8> {
    let mut a = ctx::ROOT_BACKUP.to_vec();
    a.extend_from_slice(user.as_bytes());
    a.push(0);
    a.extend_from_slice(header);
    a
}

/// Зашифровать корень пользователя `user` ключом восстановления.
pub fn export_root_backup(root_secret: &[u8; 32], user: &str, key: &RecoveryKey) -> Result<Vec<u8>> {
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    let root_pub = SigningKey::from_bytes(root_secret).verifying_key().to_bytes();
    let mut out = Vec::with_capacity(BLOB_LEN);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&root_pub);
    let mut nonce = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let k = key.wrap_key(user)?;
    let ct = ChaCha20Poly1305::new(Key::from_slice(k.as_ref()))
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: root_secret, aad: &aad(user, &out) })
        .map_err(|_| ProtoError::Crypto)?;
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Публичный корень, для которого сделана копия (без ключа восстановления).
pub fn backup_root_pub(blob: &[u8]) -> Result<[u8; 32]> {
    if blob.len() != BLOB_LEN || &blob[..4] != MAGIC || blob[4] != VERSION {
        return Err(ProtoError::Malformed);
    }
    blob[5..HEADER_LEN].try_into().map_err(|_| ProtoError::Malformed)
}

/// Расшифровать копию: корень пользователя `user` (сверен с root_pub копии).
pub fn import_root_backup(blob: &[u8], user: &str, key: &RecoveryKey) -> Result<Zeroizing<[u8; 32]>> {
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    let root_pub = backup_root_pub(blob)?;
    let (header, rest) = blob.split_at(HEADER_LEN);
    let (nonce, ct) = rest.split_at(12);
    let k = key.wrap_key(user)?;
    let pt = Zeroizing::new(
        ChaCha20Poly1305::new(Key::from_slice(k.as_ref()))
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &aad(user, header) })
            .map_err(|_| ProtoError::Crypto)?,
    );
    let mut secret = Zeroizing::new([0u8; 32]);
    if pt.len() != 32 {
        return Err(ProtoError::Crypto);
    }
    secret.copy_from_slice(&pt);
    if SigningKey::from_bytes(&secret).verifying_key().to_bytes() != root_pub {
        return Err(ProtoError::RootMismatch);
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_display_roundtrip_and_typos() {
        let k = RecoveryKey::generate();
        let s = k.to_display();
        assert_eq!(s.split('-').count(), 10);
        assert!(s.split('-').all(|g| g.len() == 4));
        let back = RecoveryKey::parse(&s.to_lowercase().replace('-', " ")).unwrap();
        assert_eq!(back.0.as_ref(), k.0.as_ref());
        // Опечатка в одном символе ловится контрольной суммой.
        let mut bad: Vec<char> = s.chars().collect();
        bad[0] = if bad[0] == 'A' { 'B' } else { 'A' };
        assert!(RecoveryKey::parse(&bad.into_iter().collect::<String>()).is_err());
        assert!(RecoveryKey::parse("ABCD").is_err());
        assert!(RecoveryKey::parse(&format!("{}Z", s.as_str())).is_err());
    }

    #[test]
    fn backup_roundtrip_binding() {
        let root = crate::sign::generate_signing_key();
        let k = RecoveryKey::generate();
        let blob = export_root_backup(&root.to_bytes(), "alice@x", &k).unwrap();
        assert_eq!(backup_root_pub(&blob).unwrap(), root.verifying_key().to_bytes());
        // Корня в открытом виде в копии нет.
        assert!(!blob.windows(32).any(|w| w == root.to_bytes()));
        let got = import_root_backup(&blob, "alice@x", &k).unwrap();
        assert_eq!(*got, root.to_bytes());
        // Другой ключ, другой адрес, изменённый байт — отказ.
        assert_eq!(import_root_backup(&blob, "alice@x", &RecoveryKey::generate()).err(), Some(ProtoError::Crypto));
        assert_eq!(import_root_backup(&blob, "bob@x", &k).err(), Some(ProtoError::Crypto));
        for i in [0, 5, 40, blob.len() - 1] {
            let mut b = blob.clone();
            b[i] ^= 1;
            assert!(import_root_backup(&b, "alice@x", &k).is_err(), "байт {i}");
        }
    }
}
