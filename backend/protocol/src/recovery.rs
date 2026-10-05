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

// ── копия корня у администратора сервера ────────────────────────────────────
//
// Страховка на случай, когда потеряны и все устройства, и ключ восстановления:
// корень запечатывается открытым ключом администратора (HPKE RFC 9180, base,
// DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305,
// `info = "parvane/v2/root-escrow\0" ‖ user`). Сервер хранит шифртекст; закрытый
// ключ администратор держит вне сервера. Формат: `PVRE` ‖ версия ‖ root_pub(32)
// ‖ enc(32) ‖ ct(32 + 16).

const ESCROW_MAGIC: &[u8; 4] = b"PVRE";
const ESCROW_VERSION: u8 = 1;
const ESCROW_INFO: &[u8] = b"parvane/v2/root-escrow\0";
const ESCROW_HEADER_LEN: usize = 4 + 1 + 32;
/// Длина копии корня для администратора.
pub const ESCROW_BLOB_LEN: usize = ESCROW_HEADER_LEN + 32 + 32 + 16;

fn escrow_info(user: &str) -> Vec<u8> {
    let mut v = ESCROW_INFO.to_vec();
    v.extend_from_slice(user.as_bytes());
    v
}

/// Пара ключей администратора для копий корня: (закрытый, открытый).
pub fn generate_escrow_keypair() -> (Zeroizing<[u8; 32]>, [u8; 32]) {
    crate::seal::generate_keypair()
}

/// Открытый ключ администратора по закрытому.
pub fn escrow_public_key(escrow_secret: &[u8; 32]) -> Result<[u8; 32]> {
    use hpke::{Deserializable, Kem as _, Serializable};
    let sk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(escrow_secret).map_err(|_| ProtoError::Crypto)?;
    let pk = hpke::kem::X25519HkdfSha256::sk_to_pk(&sk);
    let mut out = [0u8; 32];
    out.copy_from_slice(&pk.to_bytes());
    Ok(out)
}

/// Запечатать корень пользователя `user` открытым ключом администратора.
pub fn seal_root_escrow(root_secret: &[u8; 32], user: &str, escrow_public: &[u8; 32]) -> Result<Vec<u8>> {
    use hpke::{Deserializable, Serializable};
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    let pk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::PublicKey::from_bytes(escrow_public).map_err(|_| ProtoError::Crypto)?;
    let root_pub = SigningKey::from_bytes(root_secret).verifying_key().to_bytes();
    let mut out = Vec::with_capacity(ESCROW_BLOB_LEN);
    out.extend_from_slice(ESCROW_MAGIC);
    out.push(ESCROW_VERSION);
    out.extend_from_slice(&root_pub);
    let (enc, ct) = hpke::single_shot_seal::<hpke::aead::ChaCha20Poly1305, hpke::kdf::HkdfSha256, hpke::kem::X25519HkdfSha256>(
        &hpke::OpModeS::Base,
        &pk,
        &escrow_info(user),
        root_secret,
        &out,
    )
    .map_err(|_| ProtoError::Crypto)?;
    out.extend_from_slice(&enc.to_bytes());
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Публичный корень, для которого сделана копия (без ключа администратора).
pub fn escrow_root_pub(blob: &[u8]) -> Result<[u8; 32]> {
    if blob.len() != ESCROW_BLOB_LEN || &blob[..4] != ESCROW_MAGIC || blob[4] != ESCROW_VERSION {
        return Err(ProtoError::Malformed);
    }
    blob[5..ESCROW_HEADER_LEN].try_into().map_err(|_| ProtoError::Malformed)
}

/// Открыть копию закрытым ключом администратора: корень пользователя `user`
/// (сверен с root_pub копии).
pub fn open_root_escrow(blob: &[u8], user: &str, escrow_secret: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
    use hpke::Deserializable;
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    let root_pub = escrow_root_pub(blob)?;
    let (header, rest) = blob.split_at(ESCROW_HEADER_LEN);
    let (enc, ct) = rest.split_at(32);
    let sk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(escrow_secret).map_err(|_| ProtoError::Crypto)?;
    let enc = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::EncappedKey::from_bytes(enc).map_err(|_| ProtoError::Crypto)?;
    let pt = Zeroizing::new(
        hpke::single_shot_open::<hpke::aead::ChaCha20Poly1305, hpke::kdf::HkdfSha256, hpke::kem::X25519HkdfSha256>(
            &hpke::OpModeR::Base,
            &sk,
            &enc,
            &escrow_info(user),
            ct,
            header,
        )
        .map_err(|_| ProtoError::Crypto)?,
    );
    let mut root = Zeroizing::new([0u8; 32]);
    if pt.len() != 32 {
        return Err(ProtoError::Malformed);
    }
    root.copy_from_slice(&pt);
    if SigningKey::from_bytes(&root).verifying_key().to_bytes() != root_pub {
        return Err(ProtoError::RootMismatch);
    }
    Ok(root)
}

#[cfg(test)]
mod escrow_tests {
    use super::*;

    #[test]
    fn escrow_roundtrip_and_rejections() {
        let (admin_sk, admin_pk) = generate_escrow_keypair();
        assert_eq!(escrow_public_key(&admin_sk).unwrap(), admin_pk);
        let root = [7u8; 32];
        let blob = seal_root_escrow(&root, "alice@local", &admin_pk).unwrap();
        assert_eq!(blob.len(), ESCROW_BLOB_LEN);
        assert_eq!(escrow_root_pub(&blob).unwrap(), SigningKey::from_bytes(&root).verifying_key().to_bytes());
        assert_eq!(*open_root_escrow(&blob, "alice@local", &admin_sk).unwrap(), root);
        // чужой адрес, чужой ключ администратора, порча шифртекста и заголовка — отказ
        assert!(open_root_escrow(&blob, "bob@local", &admin_sk).is_err());
        let (other_sk, _) = generate_escrow_keypair();
        assert!(open_root_escrow(&blob, "alice@local", &other_sk).is_err());
        let mut bad = blob.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(open_root_escrow(&bad, "alice@local", &admin_sk).is_err());
        let mut bad = blob.clone();
        bad[10] ^= 1;
        assert!(open_root_escrow(&bad, "alice@local", &admin_sk).is_err());
        // из открытой копии под ключом админа выписывается новый ключ восстановления
        let key = RecoveryKey::generate();
        let backup = export_root_backup(&open_root_escrow(&blob, "alice@local", &admin_sk).unwrap(), "alice@local", &key).unwrap();
        assert_eq!(*import_root_backup(&backup, "alice@local", &key).unwrap(), root);
    }
}

