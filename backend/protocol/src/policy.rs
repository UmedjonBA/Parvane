//! «Липкая» политика гарантий (T118, D-13). Формат отправки устройству
//! решается по подписанным данным собеседника (журнал устройств, сертификаты)
//! и локальной памяти «видел у него v2», а НЕ по `Welcome.features` сервера:
//! сервер не может понизить формат, убрав флаг возможности.

use std::collections::BTreeSet;

use crate::identity::DeviceLog;

/// Как слать конкретному устройству собеседника.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendFormat {
    /// v2: sealed-конверт (HPKE поверх Olm).
    SealedV2,
    /// Не слать: устройство не подтверждено владельцем либо журнала нет (легаси-копий v1 нет с T096).
    Refuse,
}

/// Память «у пользователя видели v2» — хранится в состоянии движка на диске.
#[derive(Debug, Clone, Default)]
pub struct StickyV2 {
    users: BTreeSet<String>,
}

impl StickyV2 {
    pub fn mark(&mut self, user: &str) {
        self.users.insert(user.to_string());
    }

    pub fn seen(&self, user: &str) -> bool {
        self.users.contains(user)
    }

    pub fn users(&self) -> impl Iterator<Item = &String> {
        self.users.iter()
    }
}

/// Решить формат для устройства `device_id` пользователя `user`.
/// `log` — проверенный журнал устройств (None — сервер журнала не отдал).
/// `server_features` намеренно не участвует в решении.
pub fn choose(sticky: &mut StickyV2, user: &str, log: Option<&DeviceLog>, device_id: &str, _server_features: &[String]) -> SendFormat {
    if let Some(l) = log.filter(|l| l.version > 0) {
        sticky.mark(user);
        if l.active(device_id).is_some() {
            return SendFormat::SealedV2;
        }
    }
    // Не из журнала (подсунуто сервером) или журнал «пропал» (откат сервером) — не шлём.
    SendFormat::Refuse
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::RootIdentity;
    use crate::pb::parvane::core::v2::{DeviceCertificate, UserRef};

    fn log_with_device() -> DeviceLog {
        let a = RootIdentity::generate("alice@x").unwrap();
        let mut log = DeviceLog::new("alice@x").unwrap();
        log.apply(&a.genesis_entry().unwrap()).unwrap();
        let dk = crate::sign::generate_signing_key();
        let mut cert = DeviceCertificate {
            user: Some(UserRef { address: "alice@x".into() }),
            device_id: "v2dev".into(),
            olm_curve25519: vec![1; 32],
            olm_ed25519: dk.verifying_key().to_bytes().to_vec(),
            hpke_x25519: vec![3; 32],
            serial: 1,
            ..Default::default()
        };
        crate::identity::prove_possession(&dk, &mut cert, &a.root_pub()).unwrap();
        log.apply(&a.add_device_entry(2, log.head_hash, &cert).unwrap()).unwrap();
        log
    }

    #[test]
    fn formats() {
        let log = log_with_device();
        let mut st = StickyV2::default();
        assert_eq!(choose(&mut st, "alice@x", Some(&log), "v2dev", &[]), SendFormat::SealedV2);
        // Подсунутое сервером устройство.
        assert_eq!(choose(&mut st, "alice@x", Some(&log), "evil", &[]), SendFormat::Refuse);
    }

    #[test]
    fn server_cannot_downgrade() {
        let log = log_with_device();
        let mut st = StickyV2::default();
        let features = vec!["sealed".to_string()];
        assert_eq!(choose(&mut st, "alice@x", Some(&log), "v2dev", &features), SendFormat::SealedV2);
        // Сервер убрал feature и перестал отдавать журнал — формат не понижается.
        assert_eq!(choose(&mut st, "alice@x", None, "v2dev", &[]), SendFormat::Refuse);
        assert!(st.seen("alice@x"));
        // Пользователь без журнала — v1 больше нет, слать нечем.
        assert_eq!(choose(&mut st, "bob@x", None, "d", &[]), SendFormat::Refuse);
    }
}
