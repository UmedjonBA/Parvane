//! Проверка ответов WebAuthn на сервере (правило SECKEY-1): регистрация ключа безопасности (attestation «none» —
//! ключ и credential id из `authenticatorData`) и вход (assertion). Алгоритмы — ES256 (P-256) и EdDSA (Ed25519).
//! Без разбора аттестации: ключ — второй фактор входа, а не доказательство модели устройства.
//!
//! Проверяется: тип и вызов в `clientDataJSON`, источник (https на rpId либо его поддомене; http — только для
//! `localhost`; `PARVANE_WEBAUTHN_ORIGINS` — явный список), хэш rpId в `authenticatorData`, флаг присутствия
//! пользователя, подпись над `authenticatorData ‖ SHA-256(clientDataJSON)`, рост счётчика подписей (клон ключа).

use base64::Engine as _;
use sha2::{Digest, Sha256};

/// COSE-алгоритмы.
pub(crate) const ALG_ES256: i32 = -7;
pub(crate) const ALG_EDDSA: i32 = -8;

const FLAG_UP: u8 = 0x01;
const FLAG_AT: u8 = 0x40;

/// Ключ из ответа регистрации.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewKey {
    pub credential_id: Vec<u8>,
    pub alg: i32,
    /// ES256 — SEC1 без сжатия (65 байт), EdDSA — 32 байта.
    pub public_key: Vec<u8>,
    pub sign_count: u32,
}

/// rpId сервера: `PARVANE_WEBAUTHN_RP_ID`, иначе домен сервера.
pub(crate) fn rp_id() -> String {
    std::env::var("PARVANE_WEBAUTHN_RP_ID")
        .ok()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(crate::server_domain)
}

/// Источник страницы допустим для rpId.
pub(crate) fn origin_allowed(origin: &str, rp_id: &str) -> bool {
    if let Ok(list) = std::env::var("PARVANE_WEBAUTHN_ORIGINS") {
        let list: Vec<&str> = list.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if !list.is_empty() {
            return list.contains(&origin);
        }
    }
    let Some((scheme, rest)) = origin.split_once("://") else { return false };
    if rest.contains('/') || rest.contains('@') {
        return false;
    }
    let host = match rest.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => h,
        Some(_) => return false,
        None => rest,
    };
    let host = host.to_lowercase();
    let host_ok = !rp_id.is_empty() && (host == rp_id || host.ends_with(&format!(".{rp_id}")));
    match scheme {
        "https" => host_ok,
        "http" => host_ok && host == "localhost",
        _ => false,
    }
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn check_client_data(client_data: &[u8], kind: &str, challenge: &[u8], rp_id: &str) -> Result<(), &'static str> {
    let v: serde_json::Value = serde_json::from_slice(client_data).map_err(|_| "clientDataJSON не JSON")?;
    if v["type"].as_str() != Some(kind) {
        return Err("тип clientDataJSON");
    }
    // Вызов сравнивается в записи base64url без дополнения (так его кодирует браузер)
    let got = v["challenge"].as_str().unwrap_or("").trim_end_matches('=');
    if challenge.is_empty() || got != b64url(challenge) {
        return Err("вызов не тот");
    }
    if v["crossOrigin"].as_bool() == Some(true) {
        return Err("вызов из чужого фрейма");
    }
    if !origin_allowed(v["origin"].as_str().unwrap_or(""), rp_id) {
        return Err("источник не допущен");
    }
    Ok(())
}

/// Начало `authenticatorData`: хэш rpId, флаги, счётчик.
fn check_auth_head(auth_data: &[u8], rp_id: &str) -> Result<(u8, u32), &'static str> {
    if auth_data.len() < 37 {
        return Err("authenticatorData короче 37 байт");
    }
    if auth_data[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return Err("хэш rpId не тот");
    }
    let flags = auth_data[32];
    if flags & FLAG_UP == 0 {
        return Err("нет присутствия пользователя");
    }
    let count = u32::from_be_bytes([auth_data[33], auth_data[34], auth_data[35], auth_data[36]]);
    Ok((flags, count))
}

/// Ответ `navigator.credentials.create` с вызовом `challenge` → ключ.
pub(crate) fn verify_registration(client_data: &[u8], auth_data: &[u8], challenge: &[u8], rp_id: &str) -> Result<NewKey, &'static str> {
    check_client_data(client_data, "webauthn.create", challenge, rp_id)?;
    let (flags, sign_count) = check_auth_head(auth_data, rp_id)?;
    if flags & FLAG_AT == 0 {
        return Err("нет данных ключа (флаг AT)");
    }
    // aaguid (16) ‖ длина id (2) ‖ id ‖ ключ COSE
    let rest = auth_data.get(37 + 16..).ok_or("обрезаны данные ключа")?;
    if rest.len() < 2 {
        return Err("обрезаны данные ключа");
    }
    let id_len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
    if id_len == 0 || id_len > 1023 {
        return Err("длина credential id");
    }
    let credential_id = rest.get(2..2 + id_len).ok_or("обрезан credential id")?.to_vec();
    let cose = rest.get(2 + id_len..).ok_or("нет ключа COSE")?;
    let (alg, public_key) = parse_cose_key(cose)?;
    Ok(NewKey { credential_id, alg, public_key, sign_count })
}

/// Ответ `navigator.credentials.get` ключом (`alg`, `public_key`, прежний счётчик) → новый счётчик.
#[allow(clippy::too_many_arguments)]
pub(crate) fn verify_assertion(
    client_data: &[u8],
    auth_data: &[u8],
    signature: &[u8],
    challenge: &[u8],
    rp_id: &str,
    alg: i32,
    public_key: &[u8],
    stored_count: u32,
) -> Result<u32, &'static str> {
    check_client_data(client_data, "webauthn.get", challenge, rp_id)?;
    let (_, count) = check_auth_head(auth_data, rp_id)?;
    let mut msg = auth_data.to_vec();
    msg.extend_from_slice(&Sha256::digest(client_data));
    match alg {
        ALG_ES256 => {
            use p256::ecdsa::signature::Verifier as _;
            let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(public_key).map_err(|_| "ключ P-256")?;
            let sig = p256::ecdsa::Signature::from_der(signature).map_err(|_| "подпись не DER")?;
            key.verify(&msg, &sig).map_err(|_| "подпись не сошлась")?;
        }
        ALG_EDDSA => {
            let pk: [u8; 32] = public_key.try_into().map_err(|_| "ключ Ed25519")?;
            let key = ed25519_dalek::VerifyingKey::from_bytes(&pk).map_err(|_| "ключ Ed25519")?;
            let sig = ed25519_dalek::Signature::from_slice(signature).map_err(|_| "подпись Ed25519")?;
            key.verify_strict(&msg, &sig).map_err(|_| "подпись не сошлась")?;
        }
        _ => return Err("алгоритм"),
    }
    // Счётчик 0 у обоих — аутентификатор без счётчика; иначе только рост
    if (count != 0 || stored_count != 0) && count <= stored_count {
        return Err("счётчик подписей не вырос (клон ключа?)");
    }
    Ok(count)
}

// ── минимальный CBOR для ключа COSE ─────────────────────────────────────────

enum Cbor<'a> {
    Int(i64),
    Bytes(&'a [u8]),
    Other,
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8, &'static str> {
        let v = *self.b.get(self.at).ok_or("CBOR обрезан")?;
        self.at += 1;
        Ok(v)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.at.checked_add(n).ok_or("CBOR обрезан")?;
        let s = self.b.get(self.at..end).ok_or("CBOR обрезан")?;
        self.at = end;
        Ok(s)
    }
    /// Заголовок: (основной тип, аргумент).
    fn head(&mut self) -> Result<(u8, u64), &'static str> {
        let first = self.byte()?;
        let (major, info) = (first >> 5, first & 0x1f);
        let arg = match info {
            0..=23 => info as u64,
            24 => self.byte()? as u64,
            25 => u16::from_be_bytes(self.take(2)?.try_into().map_err(|_| "CBOR")?) as u64,
            26 => u32::from_be_bytes(self.take(4)?.try_into().map_err(|_| "CBOR")?) as u64,
            27 => u64::from_be_bytes(self.take(8)?.try_into().map_err(|_| "CBOR")?),
            _ => return Err("CBOR неопределённой длины не принимается"),
        };
        Ok((major, arg))
    }
    fn item(&mut self, depth: u8) -> Result<Cbor<'a>, &'static str> {
        if depth > 4 {
            return Err("CBOR слишком глубокий");
        }
        let (major, arg) = self.head()?;
        match major {
            0 => Ok(Cbor::Int(i64::try_from(arg).map_err(|_| "CBOR число")?)),
            1 => Ok(Cbor::Int(-1 - i64::try_from(arg).map_err(|_| "CBOR число")?)),
            2 => Ok(Cbor::Bytes(self.take(usize::try_from(arg).map_err(|_| "CBOR длина")?)?)),
            3 => {
                self.take(usize::try_from(arg).map_err(|_| "CBOR длина")?)?;
                Ok(Cbor::Other)
            }
            4 | 5 => {
                let n = if major == 5 { arg.saturating_mul(2) } else { arg };
                if n > 64 {
                    return Err("CBOR слишком длинный");
                }
                for _ in 0..n {
                    self.item(depth + 1)?;
                }
                Ok(Cbor::Other)
            }
            6 => self.item(depth + 1).map(|_| Cbor::Other),
            _ => Ok(Cbor::Other),
        }
    }
}

/// Ключ COSE (EC2 P-256 / OKP Ed25519) → (алгоритм, открытый ключ).
fn parse_cose_key(bytes: &[u8]) -> Result<(i32, Vec<u8>), &'static str> {
    let mut r = Reader { b: bytes, at: 0 };
    let (major, n) = r.head()?;
    if major != 5 || n > 16 {
        return Err("ключ COSE — не карта");
    }
    let (mut kty, mut alg, mut crv) = (0i64, 0i64, 0i64);
    let (mut x, mut y): (Option<&[u8]>, Option<&[u8]>) = (None, None);
    for _ in 0..n {
        let Cbor::Int(key) = r.item(0)? else { return Err("ключ карты COSE") };
        let val = r.item(0)?;
        match (key, val) {
            (1, Cbor::Int(v)) => kty = v,
            (3, Cbor::Int(v)) => alg = v,
            (-1, Cbor::Int(v)) => crv = v,
            (-2, Cbor::Bytes(v)) => x = Some(v),
            (-3, Cbor::Bytes(v)) => y = Some(v),
            _ => {}
        }
    }
    match (kty, alg, crv) {
        (2, -7, 1) => {
            let (Some(x), Some(y)) = (x, y) else { return Err("нет координат P-256") };
            if x.len() != 32 || y.len() != 32 {
                return Err("координаты P-256");
            }
            let mut pk = vec![0x04];
            pk.extend_from_slice(x);
            pk.extend_from_slice(y);
            p256::ecdsa::VerifyingKey::from_sec1_bytes(&pk).map_err(|_| "точка P-256")?;
            Ok((ALG_ES256, pk))
        }
        (1, -8, 6) => {
            let x = x.filter(|x| x.len() == 32).ok_or("ключ Ed25519")?;
            let pk: [u8; 32] = x.try_into().map_err(|_| "ключ Ed25519")?;
            ed25519_dalek::VerifyingKey::from_bytes(&pk).map_err(|_| "ключ Ed25519")?;
            Ok((ALG_EDDSA, x.to_vec()))
        }
        _ => Err("алгоритм ключа не поддерживается (нужен ES256 или EdDSA)"),
    }
}

/// Программный аутентификатор для тестов (P-256 и Ed25519).
#[cfg(test)]
pub(crate) mod soft {
    use super::*;

    pub(crate) fn client_data(kind: &str, challenge: &[u8], origin: &str) -> Vec<u8> {
        serde_json::json!({"type": kind, "challenge": b64url(challenge), "origin": origin, "crossOrigin": false}).to_string().into_bytes()
    }

    fn cbor_head(major: u8, n: u64, out: &mut Vec<u8>) {
        if n < 24 {
            out.push((major << 5) | n as u8);
        } else {
            out.push((major << 5) | 24);
            out.push(n as u8);
        }
    }
    fn cbor_int(v: i64, out: &mut Vec<u8>) {
        if v >= 0 {
            cbor_head(0, v as u64, out)
        } else {
            cbor_head(1, (-1 - v) as u64, out)
        }
    }
    fn cbor_bytes(b: &[u8], out: &mut Vec<u8>) {
        cbor_head(2, b.len() as u64, out);
        out.extend_from_slice(b);
    }

    pub(crate) enum Key {
        P256(p256::ecdsa::SigningKey),
        Ed(ed25519_dalek::SigningKey),
    }

    pub(crate) struct Authenticator {
        pub id: Vec<u8>,
        pub key: Key,
        pub count: u32,
    }

    impl Authenticator {
        pub(crate) fn p256(seed: u8) -> Self {
            let sk = p256::ecdsa::SigningKey::from_bytes(&[seed; 32].into()).expect("ключ");
            Authenticator { id: vec![seed; 20], key: Key::P256(sk), count: 0 }
        }
        pub(crate) fn ed25519(seed: u8) -> Self {
            Authenticator { id: vec![seed; 24], key: Key::Ed(ed25519_dalek::SigningKey::from_bytes(&[seed; 32])), count: 0 }
        }
        fn cose(&self) -> Vec<u8> {
            let mut out = vec![];
            match &self.key {
                Key::P256(sk) => {
                    let p = sk.verifying_key().to_encoded_point(false);
                    cbor_head(5, 5, &mut out);
                    for (k, v) in [(1, 2), (3, -7), (-1, 1)] {
                        cbor_int(k, &mut out);
                        cbor_int(v, &mut out);
                    }
                    cbor_int(-2, &mut out);
                    cbor_bytes(p.x().expect("x").as_slice(), &mut out);
                    cbor_int(-3, &mut out);
                    cbor_bytes(p.y().expect("y").as_slice(), &mut out);
                }
                Key::Ed(sk) => {
                    cbor_head(5, 4, &mut out);
                    for (k, v) in [(1, 1), (3, -8), (-1, 6)] {
                        cbor_int(k, &mut out);
                        cbor_int(v, &mut out);
                    }
                    cbor_int(-2, &mut out);
                    cbor_bytes(sk.verifying_key().as_bytes(), &mut out);
                }
            }
            out
        }
        fn head(&self, rp_id: &str, flags: u8) -> Vec<u8> {
            let mut a = Sha256::digest(rp_id.as_bytes()).to_vec();
            a.push(flags);
            a.extend_from_slice(&self.count.to_be_bytes());
            a
        }
        /// (clientDataJSON, authenticatorData) регистрации.
        pub(crate) fn register(&self, challenge: &[u8], rp_id: &str, origin: &str) -> (Vec<u8>, Vec<u8>) {
            let mut a = self.head(rp_id, FLAG_UP | FLAG_AT);
            a.extend_from_slice(&[0u8; 16]);
            a.extend_from_slice(&(self.id.len() as u16).to_be_bytes());
            a.extend_from_slice(&self.id);
            a.extend_from_slice(&self.cose());
            (client_data("webauthn.create", challenge, origin), a)
        }
        /// (clientDataJSON, authenticatorData, подпись) входа; счётчик растёт.
        pub(crate) fn assert(&mut self, challenge: &[u8], rp_id: &str, origin: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
            self.count += 1;
            let cd = client_data("webauthn.get", challenge, origin);
            let a = self.head(rp_id, FLAG_UP);
            let mut msg = a.clone();
            msg.extend_from_slice(&Sha256::digest(&cd));
            let sig = match &self.key {
                Key::P256(sk) => {
                    use p256::ecdsa::signature::Signer as _;
                    let s: p256::ecdsa::Signature = sk.sign(&msg);
                    s.to_der().as_bytes().to_vec()
                }
                Key::Ed(sk) => {
                    use ed25519_dalek::Signer as _;
                    sk.sign(&msg).to_bytes().to_vec()
                }
            };
            (cd, a, sig)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::soft::Authenticator;
    use super::*;

    const RP: &str = "parvane.example";
    const ORIGIN: &str = "https://parvane.example:20443";

    #[test]
    fn origins_follow_rp_id() {
        assert!(origin_allowed("https://parvane.example", RP));
        assert!(origin_allowed(ORIGIN, RP));
        assert!(origin_allowed("https://web.parvane.example", RP));
        assert!(!origin_allowed("http://parvane.example", RP));
        assert!(!origin_allowed("https://evilparvane.example", RP));
        assert!(!origin_allowed("https://parvane.example.evil", RP));
        assert!(!origin_allowed("https://parvane.example/path", RP));
        assert!(origin_allowed("http://localhost:5173", "localhost"));
        assert!(!origin_allowed("http://127.0.0.1:5173", "localhost"));
    }

    #[test]
    fn p256_and_ed25519_register_and_sign_in() {
        for mut a in [Authenticator::p256(3), Authenticator::ed25519(4)] {
            let ch = [9u8; 32];
            let (cd, ad) = a.register(&ch, RP, ORIGIN);
            let key = verify_registration(&cd, &ad, &ch, RP).expect("регистрация");
            assert_eq!(key.credential_id, a.id);
            let ch2 = [5u8; 32];
            let (cd, ad, sig) = a.assert(&ch2, RP, ORIGIN);
            let n = verify_assertion(&cd, &ad, &sig, &ch2, RP, key.alg, &key.public_key, key.sign_count).expect("вход");
            assert_eq!(n, 1);
            // Повтор того же ответа: счётчик не вырос
            assert!(verify_assertion(&cd, &ad, &sig, &ch2, RP, key.alg, &key.public_key, n).is_err());
        }
    }

    #[test]
    fn assertion_rejections() {
        let mut a = Authenticator::p256(7);
        let ch = [1u8; 32];
        let (cd, ad) = a.register(&ch, RP, ORIGIN);
        let key = verify_registration(&cd, &ad, &ch, RP).unwrap();
        // Регистрация чужим вызовом, чужим rpId, ответом входа
        assert!(verify_registration(&cd, &ad, &[2u8; 32], RP).is_err());
        assert!(verify_registration(&cd, &ad, &ch, "other.example").is_err());
        let ch2 = [2u8; 32];
        let (cd, ad, sig) = a.assert(&ch2, RP, ORIGIN);
        let ok = |cd: &[u8], ad: &[u8], sig: &[u8], ch: &[u8]| verify_assertion(cd, ad, sig, ch, RP, key.alg, &key.public_key, 0).is_ok();
        assert!(ok(&cd, &ad, &sig, &ch2));
        assert!(!ok(&cd, &ad, &sig, &[3u8; 32]), "другой вызов");
        let mut bad = sig.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(!ok(&cd, &ad, &bad, &ch2), "испорченная подпись");
        let mut no_up = ad.clone();
        no_up[32] = 0;
        assert!(!ok(&cd, &no_up, &sig, &ch2), "без присутствия");
        let (cd_evil, ad_evil, sig_evil) = a.assert(&ch2, RP, "https://evil.example");
        assert!(!ok(&cd_evil, &ad_evil, &sig_evil, &ch2), "чужой источник");
        let (cd_rp, ad_rp, sig_rp) = a.assert(&ch2, "evil.example", ORIGIN);
        assert!(!ok(&cd_rp, &ad_rp, &sig_rp, &ch2), "чужой rpId");
        // Ключ другого аутентификатора
        let mut b = Authenticator::p256(8);
        let (cd_b, ad_b, sig_b) = b.assert(&ch2, RP, ORIGIN);
        assert!(!ok(&cd_b, &ad_b, &sig_b, &ch2), "чужой ключ");
        // Регистрация с неподдерживаемым алгоритмом / мусором
        assert!(parse_cose_key(&[0xa1, 0x01, 0x03]).is_err());
        assert!(parse_cose_key(&[0xbf]).is_err());
        assert!(parse_cose_key(&[]).is_err());
    }
}
