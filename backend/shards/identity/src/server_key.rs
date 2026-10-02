//! Ключ сервера (Ed25519) и подписанный описатель сервера (T036, R12).
//! Ключ — файл PKCS#8 PEM с правами 0600, как ключ JWT
//! (`PARVANE_SERVER_KEY_FILE`, по умолчанию рядом с БД). Описатель отдаётся в
//! `Welcome` (через gateway → `server.describe`) и файлом для
//! `https://<domain>/.well-known/parvane` (`PARVANE_WELL_KNOWN_FILE`, Caddy
//! раздаёт его статикой).

use crate::*;
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use parvane_protocol::pb::parvane::core::v2::{ServerDescriptor, SignedServerDescriptor};
use prost::Message;

pub(crate) fn server_key_path(db_path: &str) -> std::path::PathBuf {
    if let Ok(p) = std::env::var("PARVANE_SERVER_KEY_FILE") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    let dir = std::path::Path::new(db_path).parent().unwrap_or(std::path::Path::new("."));
    dir.join("identity-server-ed25519.pem")
}

/// Загрузить ключ сервера или создать новый (0600).
pub(crate) fn load_or_create_server_key(db_path: &str) -> Result<ed25519_dalek::SigningKey> {
    let path = server_key_path(db_path);
    match std::fs::read_to_string(&path) {
        Ok(pem) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&path) {
                    if meta.permissions().mode() & 0o077 != 0 {
                        warn!("{}: права шире 0600 — ключ сервера доступен другим пользователям", path.display());
                    }
                }
            }
            ed25519_dalek::SigningKey::from_pkcs8_pem(&pem).map_err(|e| anyhow::anyhow!("{}: не Ed25519 PKCS#8 PEM: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
            let pem = key
                .to_pkcs8_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
                .map_err(|e| anyhow::anyhow!("PKCS#8 экспорт: {e}"))?;
            write_secret_file(&path, pem.as_bytes())?;
            warn!("сгенерирован ключ сервера (Ed25519): {} — сохраните его в бэкап отдельно от БД", path.display());
            Ok(key)
        }
        Err(e) => Err(e).with_context(|| format!("чтение {}", path.display())),
    }
}

fn env_list(name: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Подписанный описатель сервера.
pub(crate) fn signed_descriptor(key: &ed25519_dalek::SigningKey) -> SignedServerDescriptor {
    let d = ServerDescriptor {
        domain: server_domain(),
        server_key: key.verifying_key().to_bytes().to_vec(),
        proto_major: parvane_protocol::PROTO_MAJOR,
        proto_minor: parvane_protocol::PROTO_MINOR,
        features: env_list("PARVANE_V2_FEATURES"),
        endpoints: env_list("PARVANE_ENDPOINTS"),
        issued_ms: now_unix() * 1000,
    };
    let bytes = d.encode_to_vec();
    SignedServerDescriptor {
        signature: parvane_protocol::sign::sign_ctx(key, parvane_protocol::sign::ctx::SERVER_DESCRIPTOR, &[&bytes]),
        descriptor: bytes,
    }
}

/// Записать описатель для `.well-known/parvane` (proto3-JSON), если задан путь.
pub(crate) fn write_well_known(key: &ed25519_dalek::SigningKey) {
    let Ok(path) = std::env::var("PARVANE_WELL_KNOWN_FILE") else { return };
    if path.is_empty() {
        return;
    }
    match serde_json::to_vec_pretty(&signed_descriptor(key)) {
        Ok(json) => match std::fs::write(&path, json) {
            Ok(()) => info!("описатель сервера записан в {}", path),
            Err(e) => error!("описатель сервера: {}: {}", path, e),
        },
        Err(e) => error!("описатель сервера: {}", e),
    }
}
