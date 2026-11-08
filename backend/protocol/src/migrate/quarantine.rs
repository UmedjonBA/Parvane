//! Карантин разового переноса (spec 035, FR-065): старая запись, которую перенос не смог прочитать (не
//! расшифровалась, испорчена, отвергнута старым правилом), не теряется молча — она кладётся как есть в запись
//! хранилища вида `quarantine` (имя — начало SHA-256 ключа записи) и попадает в отчёт переноса. Удаляется только
//! вручную вместе со старыми хранилищами (D2).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Вид записи хранилища карантина.
pub const KIND: &str = "quarantine";

/// Запись в карантине.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quarantined {
    /// Откуда: ключ старой записи по перечню (`record:m:<uuid>`, `file:…`) либо `state.v1/<seq>`.
    pub key: String,
    /// Почему: `crypto` (не расшифровалась), `malformed` (не разбирается), `rejected` (старое правило её отвергло),
    /// `no-row-state` (строка истории без сводимого состояния) и т. п.
    pub reason: String,
    /// Исходные байты как есть.
    #[serde(with = "super::b64ser")]
    pub bytes: Vec<u8>,
}

impl Quarantined {
    pub fn new(key: impl Into<String>, reason: impl Into<String>, bytes: &[u8]) -> Self {
        Quarantined { key: key.into(), reason: reason.into(), bytes: bytes.to_vec() }
    }

    /// Имя записи хранилища: 32 знака hex SHA-256 ключа (ключ может быть длинным и содержать `/`).
    pub fn record_name(&self) -> String {
        hex::encode(&Sha256::digest(self.key.as_bytes())[..16])
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        serde_json::from_slice(b).ok()
    }
}
