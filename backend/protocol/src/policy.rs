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
    /// Легаси-копия v1 — только устройствам из LegacyDeviceSet владельца или
    /// пользователю, у которого v2 никогда не было.
    LegacyV1,
    /// Не слать: устройство не подтверждено владельцем (предупреждение).
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
pub fn choose(sticky: &mut StickyV2, user: &str, log: Option<&DeviceLog>, device_id: &str, legacy_curve: Option<&[u8]>, _server_features: &[String]) -> SendFormat {
    if let Some(l) = log.filter(|l| l.version > 0) {
        sticky.mark(user);
        if l.active(device_id).is_some() {
            return SendFormat::SealedV2;
        }
        let in_set = l
            .legacy
            .as_ref()
            .is_some_and(|set| set.iter().any(|d| d.device_id == device_id && legacy_curve.is_some_and(|c| c == d.olm_curve25519.as_slice())));
        return if in_set && !l.revoked.contains(device_id) { SendFormat::LegacyV1 } else { SendFormat::Refuse };
    }
    if sticky.seen(user) {
        // Был v2, а журнал «пропал» — откат сервером: не понижаем.
        return SendFormat::Refuse;
    }
    SendFormat::LegacyV1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{device_log_entry, sign_device_log_entry, RootIdentity};
    use crate::pb::parvane::core::v2::{user_device_log_entry::Change, DeviceCertificate, LegacyDevice, LegacyDeviceSet, UserRef};

    fn log_with_device() -> (DeviceLog, LegacyDevice) {
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
        let old = LegacyDevice { device_id: "v1dev".into(), olm_curve25519: vec![5; 32], olm_ed25519: vec![6; 32] };
        let e = device_log_entry("alice@x", 3, log.head_hash, Change::LegacyDevices(LegacyDeviceSet { devices: vec![old.clone()] }), None);
        log.apply(&sign_device_log_entry(&a.self_signing, &e).unwrap()).unwrap();
        (log, old)
    }

    #[test]
    fn formats() {
        let (log, old) = log_with_device();
        let mut st = StickyV2::default();
        assert_eq!(choose(&mut st, "alice@x", Some(&log), "v2dev", None, &[]), SendFormat::SealedV2);
        assert_eq!(choose(&mut st, "alice@x", Some(&log), "v1dev", Some(&old.olm_curve25519), &[]), SendFormat::LegacyV1);
        // Подсунутое сервером v1-устройство.
        assert_eq!(choose(&mut st, "alice@x", Some(&log), "evil", Some(&[9; 32]), &[]), SendFormat::Refuse);
    }

    #[test]
    fn server_cannot_downgrade() {
        let (log, _) = log_with_device();
        let mut st = StickyV2::default();
        let features = vec!["sealed".to_string()];
        assert_eq!(choose(&mut st, "alice@x", Some(&log), "v2dev", None, &features), SendFormat::SealedV2);
        // Сервер убрал feature и перестал отдавать журнал — формат не понижается.
        assert_eq!(choose(&mut st, "alice@x", None, "v2dev", None, &[]), SendFormat::Refuse);
        // Пользователь, у которого v2 никогда не было, — v1.
        assert_eq!(choose(&mut st, "bob@x", None, "d", None, &[]), SendFormat::LegacyV1);
    }
}
