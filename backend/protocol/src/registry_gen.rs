//! Реестр → шина (T031, R14). Из реестра методов выводятся: subject'ы v2,
//! права NATS каждой роли (блоки в `infra/nats/server.conf` и
//! `server.prod.conf` между маркерами) и subject'ы журналов/событий.
//! Тест «сгенерированное == закоммиченное» — в `parvane-types`
//! (`topic_acl_contract`), перегенерация — `cargo run -p parvane-protocol --bin gen_registry`.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::address;
use crate::error::{ProtoError, Result};
use crate::schema::METHODS;

/// Журнал инбокса устройства: `v2.inbox.<token>`.
pub const INBOX_PREFIX: &str = "v2.inbox.";
pub const INBOX_WILDCARD: &str = "v2.inbox.>";
/// Эфемерные каналы (typing/presence): `v2.eph.<hex id>`.
pub const EPH_PREFIX: &str = "v2.eph.";
pub const EPH_WILDCARD: &str = "v2.eph.>";
/// Отзыв устройства → gateway закрывает сессии (класс 5).
pub const REVOKED_SUBJECT: &str = "v2.revoked";
pub const REQUEST_INBOX: &str = "_INBOX.>";
/// Внутренние запросы шардов к identity (не клиентские).
pub const INTERNAL_IDENTITY_WILDCARD: &str = "v2.internal.identity.>";
pub const INTERNAL_DEVICES_OF: &str = "v2.internal.identity.devices_of";
pub const INTERNAL_DELIVERY_KEY_CHECK: &str = "v2.internal.identity.delivery_key_check";
pub const INTERNAL_KEY_OWNER: &str = "v2.internal.identity.key_owner";
pub const INTERNAL_TOKEN_CHECK: &str = "v2.internal.identity.token_check";
/// Настройки приватности пользователя (messenger: согласие на добавление в группы).
pub const INTERNAL_PRIVACY_OF: &str = "v2.internal.identity.privacy_of";
/// Внутренний запрос gateway → messenger: текущая эпоха группы и её ключ
/// отправки (проверка `ephemeral.group_typing`, D-07).
pub const INTERNAL_GROUP_EPOCH: &str = "v2.internal.messenger.group_epoch";

/// Роли NATS, у которых есть v2-права.
pub const ROLES: &[&str] = &["identity", "messenger", "cloud", "call", "preview", "push", "gateway", "domains"];

/// Токен subject'а журнала устройства: без `.`/`*`/`>` — hex SHA-256 от
/// проверенного адреса и device_id (не раскрывает адрес в имени subject'а).
pub fn inbox_subject(address: &str, device_id: &str) -> Result<String> {
    if !address::is_valid_address(address) || !address::is_valid_device_id(device_id) {
        return Err(ProtoError::BadAddress);
    }
    let mut h = Sha256::new();
    h.update(b"parvane/v2/inbox\0");
    h.update(address.as_bytes());
    h.update(b"\0");
    h.update(device_id.as_bytes());
    let d = h.finalize();
    Ok(format!("{INBOX_PREFIX}{}", hex(&d[..16])))
}

/// Subject эфемерного канала по секретному 128-битному id.
pub fn eph_subject(channel_id: &[u8]) -> Result<String> {
    if channel_id.len() != 16 {
        return Err(ProtoError::InvalidField("channel_id"));
    }
    Ok(format!("{EPH_PREFIX}{}", hex(channel_id)))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Права роли: (subscribe, publish), отсортированы.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoleAcl {
    pub subscribe: Vec<String>,
    pub publish: Vec<String>,
}

/// v2-права всех ролей из реестра.
pub fn acl() -> BTreeMap<&'static str, RoleAcl> {
    let mut m: BTreeMap<&'static str, RoleAcl> = ROLES.iter().map(|r| (*r, RoleAcl::default())).collect();
    for meth in METHODS.iter().filter(|x| x.shard != "gateway") {
        if let Some(r) = m.get_mut(meth.shard) {
            r.subscribe.push(meth.subject.to_string());
        }
        if let Some(g) = m.get_mut("gateway") {
            g.publish.push(meth.subject.to_string());
        }
    }
    let add = |m: &mut BTreeMap<&'static str, RoleAcl>, role: &str, sub: &[&str], publ: &[&str]| {
        if let Some(r) = m.get_mut(role) {
            r.subscribe.extend(sub.iter().map(|s| s.to_string()));
            r.publish.extend(publ.iter().map(|s| s.to_string()));
        }
    };
    add(&mut m, "identity", &[INTERNAL_IDENTITY_WILDCARD, REQUEST_INBOX], &[REVOKED_SUBJECT, INBOX_WILDCARD]);
    add(&mut m, "messenger", &[INTERNAL_GROUP_EPOCH], &[INBOX_WILDCARD, INTERNAL_IDENTITY_WILDCARD]);
    // call.signal_sealed: право доставки (ключ доступа) и устройства адресата —
    // через identity; сигналы — живыми событиями в журналы устройств.
    add(&mut m, "call", &[], &[INBOX_WILDCARD, INTERNAL_IDENTITY_WILDCARD]);
    add(&mut m, "push", &[INBOX_WILDCARD], &[]);
    // domains: владелец ключа подписи — через identity (key_owner).
    add(&mut m, "domains", &[], &[INTERNAL_IDENTITY_WILDCARD]);
    add(&mut m, "gateway", &[INBOX_WILDCARD, EPH_WILDCARD, REVOKED_SUBJECT], &[EPH_WILDCARD, INTERNAL_GROUP_EPOCH]);
    for r in m.values_mut() {
        r.subscribe.sort();
        r.subscribe.dedup();
        r.publish.sort();
        r.publish.dedup();
    }
    m
}

fn marker_open(role: &str, kind: &str) -> String {
    format!("# >>> v2 {role} {kind} (gen_registry — не править руками)")
}

const MARKER_CLOSE: &str = "# <<< v2";

/// Содержимое блока: subject'ы по 4 в строке, с запятой в конце.
fn render(subjects: &[String], indent: &str) -> String {
    let mut out = String::new();
    for chunk in subjects.chunks(4) {
        out.push_str(indent);
        out.push_str(&chunk.iter().map(|s| format!("\"{s}\",")).collect::<Vec<_>>().join(" "));
        out.push('\n');
    }
    out
}

/// Заменить содержимое всех v2-блоков в тексте конфига NATS на сгенерированное.
/// Каждой роли из `ROLES`, присутствующей в конфиге, нужны оба блока.
pub fn apply_conf(text: &str) -> Result<String> {
    let acl = acl();
    let mut out = text.to_string();
    for role in ROLES {
        let Some(r) = acl.get(role) else { continue };
        if !out.contains(&format!("user: {role}\n")) {
            continue;
        }
        for (kind, list) in [("subscribe", &r.subscribe), ("publish", &r.publish)] {
            let open = marker_open(role, kind);
            let start = out.find(&open).ok_or(ProtoError::InvalidField("nats-conf-marker"))?;
            let line_start = out[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let indent: String = out[line_start..start].chars().take_while(|c| c.is_whitespace()).collect();
            let body_start = start + open.len() + 1;
            let close_rel = out[body_start..].find(MARKER_CLOSE).ok_or(ProtoError::InvalidField("nats-conf-marker"))?;
            let close_line = out[..body_start + close_rel].rfind('\n').map(|i| i + 1).unwrap_or(body_start);
            out.replace_range(body_start..close_line, &render(list, &indent));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subjects_are_safe() {
        let s = inbox_subject("alice@x", "d1").unwrap();
        assert!(s.starts_with(INBOX_PREFIX) && s.len() == INBOX_PREFIX.len() + 32);
        assert_ne!(s, inbox_subject("alice@x", "d2").unwrap());
        assert!(inbox_subject("a.*@x", "d").is_err());
        assert!(eph_subject(&[1; 15]).is_err());
        for (_, r) in acl() {
            for s in r.subscribe.iter().chain(r.publish.iter()) {
                assert!(s.starts_with("v2.") || s == REQUEST_INBOX, "{s}");
            }
        }
    }

    #[test]
    fn gateway_publishes_every_shard_method() {
        let a = acl();
        let g = &a["gateway"];
        for m in METHODS.iter().filter(|m| m.shard != "gateway") {
            assert!(g.publish.iter().any(|s| s == m.subject), "{}", m.name);
            assert!(a[m.shard].subscribe.iter().any(|s| s == m.subject), "{}", m.name);
        }
    }

    #[test]
    fn apply_replaces_blocks() {
        let conf = "user: identity\n  subscribe: [\n    # >>> v2 identity subscribe (gen_registry — не править руками)\n    \"old\",\n    # <<< v2\n    \"x\"\n  ]\n  publish: [\n    # >>> v2 identity publish (gen_registry — не править руками)\n    # <<< v2\n    \"_INBOX.>\"\n  ]\n";
        let out = apply_conf(conf).unwrap();
        assert!(out.contains("\"v2.identity.session.issue\","));
        assert!(!out.contains("\"old\""));
        assert!(out.contains("\"v2.revoked\","));
        assert_eq!(apply_conf(&out).unwrap(), out);
    }
}
