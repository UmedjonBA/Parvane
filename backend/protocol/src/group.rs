//! Группы (T026, T116, T125; R8; D-02, D-03, D-04, D-07; класс 19).
//!
//! Журнал состояния группы — хэш-цепочка `GroupStateEntry`; каждая запись —
//! SignedOp (domain "group", op_type "state") с payload `GroupStateChange`, где
//! позиция записи (group, version, prev_hash) подписана и обязана совпасть с
//! внешними полями (D-02). Право подписанта проверяется по состоянию
//! `version-1`. Генезис задаёт id группы:
//! `id = trunc16(SHA-256("parvane/v2/group-genesis\0" ‖ body))`, поэтому
//! в генезисе `GroupStateChange.group` несёт только домен.
//!
//! Эпохи: смена состава/прав/мьюта помечает эпоху устаревшей; новая эпоха —
//! запись `NewEpoch` с публичным ключом отправки, не чаще 1 раза в 10 с.
//! Сервер проверяет подпись конверта ключом текущей эпохи, не зная автора;
//! клиенты дополнительно проверяют автора (подпись устройства внутри +
//! его право по журналу) — fail-closed.

use std::collections::{BTreeMap, BTreeSet};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use prost::Message;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{
    GroupContext, GroupEnvelope, GroupEnvelopeInner, GroupInviteKeyAnnounce, GroupStateEntry, OpHeader, Ref, SignedOp,
};
use crate::pb::parvane::group::v2::{
    group_change::Change, AdminRights, GroupChange, GroupKind, GroupStateChange, Permissions, Role,
};
use crate::pb::parvane::msg::v2::{content, Content, MediaKind};
use crate::sign::{self, ctx, OpSigner};

pub const GROUP_DOMAIN: &str = "group";
pub const GROUP_OP: &str = "state";
/// Смена эпохи не чаще раза в 10 с на группу.
pub const EPOCH_MIN_INTERVAL_MS: i64 = 10_000;
pub const ZERO_HASH: [u8; 32] = [0u8; 32];
/// C1-07 (D-17, как P-34 в v1): жёсткий потолок участников группы — рассылка
/// множит каждое сообщение на участников × устройства. Сервер может держать
/// потолок ниже (`PARVANE_GROUP_MAX_MEMBERS`).
pub const MAX_MEMBERS: usize = 1000;

/// Кто подписал запись (по ключу устройства из проверенного сертификата).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerInfo {
    pub user: String,
    pub root_key: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    pub role: Role,
    pub rights: AdminRights,
    pub muted_until_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InviteLink {
    pub announce: GroupInviteKeyAnnounce,
    pub creator: String,
    pub uses: u32,
    /// Время записи объявления (подписанное время записи журнала): по нему у всех
    /// ведущих приглашения один порядок ссылок — значит, и одна основная.
    pub created_ms: i64,
    /// Кто вступил по ссылке и когда (время записи журнала; spec 024), последние `MAX_LINK_JOINS`.
    pub joins: Vec<(String, i64)>,
}

impl InviteLink {
    fn note_join(&mut self, user: String, ts_ms: i64) {
        self.uses += 1;
        if self.joins.len() >= MAX_LINK_JOINS {
            self.joins.remove(0);
        }
        self.joins.push((user, ts_ms));
    }
}

impl GroupState {
    /// Действующие ссылки-приглашения для хоста (JSON-массив): метаданные из
    /// журнала; секрет ссылки хост хранит сам.
    pub fn invites_json(&self) -> serde_json::Value {
        serde_json::Value::Array(
            self.invite_links
                .iter()
                .map(|(id, l)| {
                    serde_json::json!({
                        "id": hex::encode(id), "creator": l.creator, "createdMs": l.created_ms, "title": l.announce.title,
                        "expiresMs": l.announce.expires_ms, "usageLimit": l.announce.usage_limit,
                        "requiresApproval": l.announce.requires_approval, "uses": l.uses,
                        "joins": l.joins.iter().map(|(user, ts)| serde_json::json!({ "user": user, "tsMs": ts })).collect::<Vec<_>>(),
                    })
                })
                .collect(),
        )
    }
}

/// Состояние группы после проверки журнала.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupState {
    pub group: Ref,
    pub version: u64,
    /// Хэши всех записей (индекс = version - 1) — для обнаружения форка.
    pub hashes: Vec<[u8; 32]>,
    pub kind: GroupKind,
    pub name: String,
    pub about: String,
    pub avatar_file_id: String,
    /// Прежний `group_id` группы v1, из которой эта переведена (T180); иначе пусто.
    pub migrated_from: String,
    pub default_permissions: Permissions,
    pub owner: String,
    pub members: BTreeMap<String, Member>,
    pub banned: BTreeSet<String>,
    pub epoch: u64,
    pub send_public_key: Option<[u8; 32]>,
    pub last_epoch_ms: i64,
    /// Смена состава/прав требует новой эпохи.
    pub epoch_stale: bool,
    pub invite_links: BTreeMap<[u8; 32], InviteLink>,
    /// Отозванные ссылки (последние `MAX_REVOKED_LINKS`): по ним нельзя вступить, но
    /// вступающему говорят «ссылка отозвана», а админ видит их отдельным списком.
    pub revoked_links: BTreeMap<[u8; 32], InviteLink>,
    pub deleted: bool,
    /// Политика «усиленная приватность» (L2) группы и кто её задал последним.
    pub l2: bool,
    pub l2_by: String,
    /// Публичная группа (spec 023); `None` — частная.
    pub public: Option<PublicInfo>,
    /// Комплекты эпох публичной группы (эпоха → комплект), последние `MAX_PUBLIC_BUNDLES`.
    pub public_bundles: BTreeMap<u64, Vec<u8>>,
    /// ENG-08: наибольшая версия журнала устройств, на которую сослалась запись пользователя; его следующие
    /// записи не ссылаются на меньшую.
    pub signer_versions: BTreeMap<String, u64>,
}

/// Сколько комплектов эпох помнит состояние: столько эпох назад читается история публичной группы.
pub const MAX_PUBLIC_BUNDLES: usize = 256;

/// Публичная группа: имя, открытый секрет и выведенный из него ключ публичной ссылки.
#[derive(Debug, Clone, PartialEq)]
pub struct PublicInfo {
    pub name: String,
    pub secret: [u8; 32],
    pub preview: bool,
    pub history: bool,
    pub link_public_key: [u8; 32],
}

/// Сколько отозванных ссылок группа помнит (остальные неотличимы от несуществующих).
pub const MAX_REVOKED_LINKS: usize = 200;

/// Сколько вступивших по одной ссылке хранит состояние группы (spec 024).
pub const MAX_LINK_JOINS: usize = 1000;

fn full_rights() -> AdminRights {
    AdminRights { change_info: true, delete_messages: true, ban_users: true, invite_users: true, pin_messages: true, add_admins: true }
}

fn rights_subset(a: &AdminRights, of: &AdminRights) -> bool {
    (!a.change_info || of.change_info)
        && (!a.delete_messages || of.delete_messages)
        && (!a.ban_users || of.ban_users)
        && (!a.invite_users || of.invite_users)
        && (!a.pin_messages || of.pin_messages)
        && (!a.add_admins || of.add_admins)
}

/// Хэш записи: SHA-256("parvane/v2/group-entry\0" ‖ body ‖ signature).
pub fn entry_hash(op: &SignedOp) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(ctx::GROUP_ENTRY_HASH);
    h.update(&op.body);
    h.update(&op.signature);
    h.finalize().into()
}

/// id группы из тела генезиса.
pub fn genesis_group_id(genesis_body: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(ctx::GROUP_GENESIS);
    h.update(genesis_body);
    h.finalize()[..16].to_vec()
}

/// link_id ссылки-приглашения.
pub fn link_id(link_public_key: &[u8]) -> [u8; 32] {
    Sha256::digest(link_public_key).into()
}

fn user_of(u: &Option<crate::pb::parvane::core::v2::UserRef>) -> Result<String> {
    let a = u.as_ref().map(|u| u.address.clone()).ok_or(ProtoError::InvalidField("member"))?;
    if !address::is_valid_address(&a) {
        return Err(ProtoError::BadAddress);
    }
    Ok(a)
}

/// Подписанные байты вступления по ссылке (D-04).
pub fn join_signing_parts(group: &Ref, version: u64, prev_hash: &[u8], joiner_root: &[u8]) -> Vec<u8> {
    let mut v = group.domain.as_bytes().to_vec();
    v.push(0);
    v.extend_from_slice(&group.id);
    v.extend_from_slice(&version.to_be_bytes());
    v.extend_from_slice(prev_hash);
    v.extend_from_slice(joiner_root);
    v
}

impl GroupState {
    pub fn head_hash(&self) -> [u8; 32] {
        self.hashes.last().copied().unwrap_or(ZERO_HASH)
    }

    fn member(&self, u: &str) -> Option<&Member> {
        self.members.get(u)
    }

    fn is_owner(&self, u: &str) -> bool {
        self.owner == u && self.members.contains_key(u)
    }

    /// Админ (или владелец) с правом `f`.
    fn admin_can(&self, u: &str, f: impl Fn(&AdminRights) -> bool) -> bool {
        if self.is_owner(u) {
            return true;
        }
        matches!(self.member(u), Some(m) if m.role == Role::Admin && f(&m.rights))
    }

    fn is_admin(&self, u: &str) -> bool {
        self.is_owner(u) || matches!(self.member(u), Some(m) if m.role == Role::Admin)
    }

    /// Участник вправе писать сейчас (держит ключ отправки эпохи).
    pub fn can_write(&self, u: &str, now_ms: i64) -> bool {
        let Some(m) = self.member(u) else { return false };
        if self.banned.contains(u) || m.muted_until_ms > now_ms || self.deleted {
            return false;
        }
        if self.is_admin(u) {
            return true;
        }
        self.kind == GroupKind::Group && self.default_permissions.send_messages
    }

    /// Кому раздавать приватный ключ отправки эпохи.
    pub fn writers(&self, now_ms: i64) -> Vec<String> {
        self.members.keys().filter(|u| self.can_write(u, now_ms)).cloned().collect()
    }

    /// Права по типу содержимого (GROUP-2) — у получателя и в композере.
    pub fn content_allowed(&self, u: &str, c: &Content, now_ms: i64) -> bool {
        if !self.can_write(u, now_ms) {
            return false;
        }
        if self.is_admin(u) {
            return true;
        }
        let p = &self.default_permissions;
        match &c.kind {
            Some(content::Kind::Media(m)) if m.kind == MediaKind::Animation as i32 => p.send_stickers_gifs,
            Some(content::Kind::Media(_)) => p.send_media,
            Some(content::Kind::Sticker(_)) => p.send_stickers_gifs,
            Some(content::Kind::Poll(_)) => p.send_polls,
            Some(content::Kind::Text(t)) => p.embed_links || t.preview.is_none(),
            Some(content::Kind::Pin(_)) => p.pin_messages,
            _ => true,
        }
    }

    /// D-03: сверка головы журнала из сообщения/раздачи ключей.
    pub fn check_context(&self, c: &GroupContext) -> ContextVerdict {
        if c.group.as_ref() != Some(&self.group) {
            return ContextVerdict::WrongGroup;
        }
        if c.state_version > self.version {
            return ContextVerdict::Behind;
        }
        let Some(idx) = usize::try_from(c.state_version).ok().and_then(|v| v.checked_sub(1)) else {
            return ContextVerdict::Fork;
        };
        match self.hashes.get(idx) {
            Some(h) if h.as_slice() == c.state_head_hash => ContextVerdict::Ok,
            _ => ContextVerdict::Fork,
        }
    }

    /// Контекст для исходящих сообщений.
    pub fn context(&self) -> GroupContext {
        GroupContext {
            group: Some(self.group.clone()),
            epoch: self.epoch,
            state_version: self.version,
            state_head_hash: self.head_hash().to_vec(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextVerdict {
    Ok,
    /// Отправитель видит более новый журнал — догнать до раздачи ключей.
    Behind,
    /// Та же версия с другим hash — форк журнала сервером: предупреждение,
    /// ключи не раздавать.
    Fork,
    WrongGroup,
}

/// Применить запись журнала. `state` — None для генезиса. `resolve` —
/// пользователь и корень по ключу подписи устройства и версии журнала устройств
/// подписанта, на которую ссылается запись (ENG-08: ключ действовал в этой версии);
/// неизвестный ключ — отказ.
pub fn apply(state: Option<&GroupState>, entry: &GroupStateEntry, resolve: &dyn Fn(&[u8; 32], u64) -> Option<SignerInfo>) -> Result<GroupState> {
    apply_with(state, entry, resolve, None)
}

/// Сведения о журналах устройств для записей после смены ника (spec 026).
pub struct Lookup<'a> {
    /// Подписант по ключу, версии журнала и подсказке адреса: ключ устройства после смены ника есть в двух
    /// журналах (прежнего и нового адреса).
    pub signer_as: &'a dyn Fn(&[u8; 32], u64, &str) -> Option<SignerInfo>,
    /// Корень журнала адреса (для прежнего адреса — закрытого сменой ника).
    pub root_of: &'a dyn Fn(&str) -> Option<[u8; 32]>,
}

/// `apply` со сведениями о журналах (записи после смены ника). Без них подсказка адреса не учитывается, а
/// `RenameMember` не принимается.
pub fn apply_with(
    state: Option<&GroupState>,
    entry: &GroupStateEntry,
    resolve: &dyn Fn(&[u8; 32], u64) -> Option<SignerInfo>,
    lookup: Option<&Lookup<'_>>,
) -> Result<GroupState> {
    let group = entry.group.as_ref().ok_or(ProtoError::InvalidField("group"))?;
    address::check_ref(group)?;
    let op = entry.change.as_ref().ok_or(ProtoError::InvalidField("change"))?;
    let hint = sign::verifying_key(&op.signer_key)?.to_bytes();
    let v = sign::verify_op(op, GROUP_DOMAIN, GROUP_OP, Some(&hint))?;
    let sc: GroupStateChange = decode_checked(&v.payload, Origin::Client)?;
    let signer = match lookup {
        Some(l) if !sc.signer_address.is_empty() => (l.signer_as)(&hint, sc.signer_log_version, &sc.signer_address),
        _ => resolve(&hint, sc.signer_log_version),
    }
    .ok_or(ProtoError::Forbidden)?;
    if !sc.signer_address.is_empty() && lookup.is_some() && signer.user != sc.signer_address {
        return Err(ProtoError::Forbidden);
    }
    if sc.version != entry.version || sc.prev_hash != entry.prev_hash {
        return Err(ProtoError::ContextMismatch);
    }
    // ENG-08: версии журнала устройств у пользователя не убывают
    if state.and_then(|s| s.signer_versions.get(&signer.user)).is_some_and(|&max| sc.signer_log_version < max) {
        return Err(ProtoError::Forbidden);
    }
    let change = sc.change.as_ref().and_then(|c| c.change.as_ref()).ok_or(ProtoError::InvalidField("change"))?;
    let now = v.header.ts_ms;

    let mut s = match state {
        None => {
            // Генезис.
            let Change::Create(cr) = change else { return Err(ProtoError::BrokenChain) };
            if entry.version != 1 || entry.prev_hash != ZERO_HASH {
                return Err(ProtoError::BrokenChain);
            }
            let sg = sc.group.as_ref().ok_or(ProtoError::InvalidField("group"))?;
            if !sg.id.is_empty() || sg.domain != group.domain || v.header.target.is_some() {
                return Err(ProtoError::ContextMismatch);
            }
            if group.id != genesis_group_id(&op.body) {
                return Err(ProtoError::ContextMismatch);
            }
            let kind = GroupKind::try_from(cr.kind).unwrap_or(GroupKind::Unspecified);
            if kind == GroupKind::Unspecified {
                return Err(ProtoError::InvalidField("kind"));
            }
            let mut members = BTreeMap::new();
            members.insert(signer.user.clone(), Member { role: Role::Owner, rights: full_rights(), muted_until_ms: 0 });
            for m in &cr.members {
                let a = user_of(&Some(m.clone()))?;
                members.entry(a).or_insert(Member { role: Role::Member, rights: AdminRights::default(), muted_until_ms: 0 });
            }
            if members.len() > MAX_MEMBERS {
                return Err(ProtoError::FieldLimit("members"));
            }
            let s = GroupState {
                group: group.clone(),
                version: 1,
                hashes: vec![entry_hash(op)],
                kind,
                name: cr.name.clone(),
                about: cr.about.clone(),
                avatar_file_id: String::new(),
                migrated_from: cr.migrated_from.clone(),
                default_permissions: cr.default_permissions.unwrap_or_default(),
                owner: signer.user.clone(),
                members,
                banned: BTreeSet::new(),
                epoch: 0,
                send_public_key: None,
                last_epoch_ms: 0,
                epoch_stale: true,
                invite_links: BTreeMap::new(),
                revoked_links: BTreeMap::new(),
                deleted: false,
                l2: false,
                l2_by: String::new(),
                public: None,
                public_bundles: BTreeMap::new(),
                signer_versions: if sc.signer_log_version > 0 {
                    BTreeMap::from([(signer.user.clone(), sc.signer_log_version)])
                } else {
                    BTreeMap::new()
                },
            };
            return Ok(s);
        }
        Some(st) => st.clone(),
    };

    // Последующие записи: позиция, группа, цель.
    if s.deleted {
        return Err(ProtoError::Forbidden);
    }
    if entry.version != s.version + 1 || entry.prev_hash.as_slice() != s.head_hash() {
        return Err(ProtoError::BrokenChain);
    }
    if group != &s.group || sc.group.as_ref() != Some(&s.group) {
        return Err(ProtoError::ContextMismatch);
    }
    v.require_target(&s.group)?;
    let actor = signer.user.clone();
    let is_member = s.members.contains_key(&actor);
    let forbid = || Err(ProtoError::Forbidden);

    match change {
        Change::Create(_) => return Err(ProtoError::BrokenChain),
        Change::AddMember(a) => {
            let m = user_of(&a.member)?;
            let ok = s.admin_can(&actor, |r| r.invite_users)
                || (is_member && s.kind == GroupKind::Group && s.default_permissions.invite_users);
            if !ok || s.members.contains_key(&m) || s.banned.contains(&m) {
                return forbid();
            }
            if s.members.len() >= MAX_MEMBERS {
                return Err(ProtoError::FieldLimit("members"));
            }
            // Одобренная заявка по ссылке «по заявке» считается в ссылке (spec 024); ссылку, отозванную
            // между заявкой и одобрением, не считаем — участник при этом добавляется
            if !a.via_link_id.is_empty() {
                let id: [u8; 32] = a.via_link_id.as_slice().try_into().map_err(|_| ProtoError::InvalidField("via_link_id"))?;
                if let Some(l) = s.invite_links.get_mut(&id) {
                    l.note_join(m.clone(), now);
                }
            }
            s.members.insert(m, Member { role: Role::Member, rights: AdminRights::default(), muted_until_ms: 0 });
            // Новому участнику нужны ключи новой эпохи (не читает прошлое).
            s.epoch_stale = true;
        }
        Change::RemoveMember(r) => {
            let m = user_of(&r.member)?;
            let target = s.member(&m).cloned().ok_or(ProtoError::Forbidden)?;
            let ok = s.is_owner(&actor) || (s.admin_can(&actor, |r| r.ban_users) && target.role == Role::Member);
            if !ok || m == s.owner {
                return forbid();
            }
            s.members.remove(&m);
            s.epoch_stale = true;
        }
        Change::SetRole(r) => {
            let m = user_of(&r.member)?;
            let target = s.member(&m).cloned().ok_or(ProtoError::Forbidden)?;
            let role = Role::try_from(r.role).unwrap_or(Role::Unspecified);
            let rights = r.rights.unwrap_or_default();
            match role {
                Role::Owner => {
                    if !s.is_owner(&actor) || m == actor {
                        return forbid();
                    }
                    if let Some(prev) = s.members.get_mut(&actor) {
                        prev.role = Role::Admin;
                        prev.rights = full_rights();
                    }
                    if let Some(t) = s.members.get_mut(&m) {
                        t.role = Role::Owner;
                        t.rights = full_rights();
                    }
                    s.owner = m;
                }
                Role::Admin | Role::Member => {
                    if m == s.owner {
                        return forbid();
                    }
                    let owner = s.is_owner(&actor);
                    if !owner {
                        let own = s.member(&actor).map(|x| x.rights).unwrap_or_default();
                        // Админ с add_admins: только повышает участников и в пределах своих прав.
                        let ok = s.admin_can(&actor, |x| x.add_admins)
                            && target.role == Role::Member
                            && role == Role::Admin
                            && rights_subset(&rights, &own);
                        if !ok {
                            return forbid();
                        }
                    }
                    let demote = target.role == Role::Admin && role == Role::Member;
                    if let Some(t) = s.members.get_mut(&m) {
                        t.role = role;
                        t.rights = if role == Role::Admin { rights } else { AdminRights::default() };
                    }
                    if demote {
                        s.epoch_stale = true;
                    }
                }
                Role::Unspecified => return Err(ProtoError::InvalidField("role")),
            }
        }
        Change::Ban(b) => {
            let m = user_of(&b.member)?;
            let target_role = s.member(&m).map(|x| x.role);
            let ok = s.is_owner(&actor) || (s.admin_can(&actor, |r| r.ban_users) && matches!(target_role, None | Some(Role::Member)));
            if !ok || m == s.owner {
                return forbid();
            }
            s.members.remove(&m);
            s.banned.insert(m);
            s.epoch_stale = true;
        }
        Change::Unban(b) => {
            let m = user_of(&b.member)?;
            if !s.admin_can(&actor, |r| r.ban_users) {
                return forbid();
            }
            s.banned.remove(&m);
        }
        Change::Mute(mu) => {
            let m = user_of(&mu.member)?;
            let target = s.member(&m).cloned().ok_or(ProtoError::Forbidden)?;
            let ok = s.is_owner(&actor) || (s.admin_can(&actor, |r| r.ban_users) && target.role == Role::Member);
            if !ok || m == s.owner {
                return forbid();
            }
            if let Some(t) = s.members.get_mut(&m) {
                t.muted_until_ms = mu.until_ms.max(0);
            }
            s.epoch_stale = true;
        }
        Change::SetInfo(i) => {
            let ok = s.admin_can(&actor, |r| r.change_info)
                || (is_member && s.kind == GroupKind::Group && s.default_permissions.change_info);
            if !ok {
                return forbid();
            }
            s.name = i.name.clone();
            s.about = i.about.clone();
            s.avatar_file_id = i.avatar_file_id.clone();
        }
        Change::SetPrivacyMode(m) => {
            // Право — как у изменения сведений группы; новой эпохи не требует
            // (состав и ключи те же, меняется только форма конвертов).
            let ok = s.admin_can(&actor, |r| r.change_info)
                || (is_member && s.kind == GroupKind::Group && s.default_permissions.change_info);
            if !ok {
                return forbid();
            }
            s.l2 = m.l2;
            s.l2_by = actor.clone();
        }
        Change::SetPublic(p) => {
            if !s.admin_can(&actor, |r| r.change_info) {
                return forbid();
            }
            if p.public {
                let name = normalize_public_name(&p.name).ok_or(ProtoError::InvalidField("name"))?;
                let secret: [u8; 32] = p.secret.as_slice().try_into().map_err(|_| ProtoError::InvalidField("secret"))?;
                let link_public_key = public_link_key(&secret).verifying_key().to_bytes();
                // Новый секрет — новая эпоха с комплектом; смена имени или настроек ключей не трогает
                if s.public.as_ref().is_none_or(|old| old.secret != secret) {
                    s.epoch_stale = true;
                }
                s.public = Some(PublicInfo { name, secret, preview: p.preview, history: p.history, link_public_key });
            } else {
                if s.public.is_none() {
                    return Err(ProtoError::InvalidField("public"));
                }
                // Снова частная: прежний секрет к новым сообщениям подходить не должен
                s.public = None;
                s.epoch_stale = true;
            }
        }
        Change::SetPermissions(p) => {
            if !s.admin_can(&actor, |r| r.ban_users) {
                return forbid();
            }
            s.default_permissions = p.default_permissions.unwrap_or_default();
            s.epoch_stale = true;
        }
        Change::NewEpoch(e) => {
            if !s.is_admin(&actor) {
                return forbid();
            }
            if e.epoch != s.epoch + 1 {
                return Err(ProtoError::BrokenChain);
            }
            // ENG-09: `now` — метка клиента; крайнее значение переполняло вычитание
            // (паника в debug-сборке клиента) и замораживало смену эпох навсегда.
            // Интервал считается только вперёд по времени.
            if s.epoch > 0 && now >= s.last_epoch_ms && now.saturating_sub(s.last_epoch_ms) < EPOCH_MIN_INTERVAL_MS {
                return Err(ProtoError::RateLimited);
            }
            let k: [u8; 32] = e.send_public_key.as_slice().try_into().map_err(|_| ProtoError::InvalidField("send_public_key"))?;
            s.epoch = e.epoch;
            s.send_public_key = Some(k);
            if s.public.is_some() && !e.public_bundle.is_empty() {
                s.public_bundles.insert(e.epoch, e.public_bundle.clone());
                while s.public_bundles.len() > MAX_PUBLIC_BUNDLES {
                    s.public_bundles.pop_first();
                }
            }
            s.last_epoch_ms = now;
            s.epoch_stale = false;
        }
        Change::InviteKey(a) => {
            let ok = s.admin_can(&actor, |r| r.invite_users)
                || (is_member && s.kind == GroupKind::Group && s.default_permissions.invite_users);
            if !ok || a.link_public_key.len() != 32 {
                return forbid();
            }
            s.invite_links.insert(link_id(&a.link_public_key), InviteLink { announce: a.clone(), creator: actor, uses: 0, created_ms: now, joins: Vec::new() });
        }
        Change::InviteKeyRevoke(r) => {
            let id: [u8; 32] = r.link_id.as_slice().try_into().map_err(|_| ProtoError::InvalidField("link_id"))?;
            let creator = s.invite_links.get(&id).map(|l| l.creator.clone()).ok_or(ProtoError::Forbidden)?;
            if !(s.admin_can(&actor, |r| r.invite_users) || creator == actor) {
                return forbid();
            }
            if let Some(link) = s.invite_links.remove(&id) {
                if s.revoked_links.len() < MAX_REVOKED_LINKS {
                    s.revoked_links.insert(id, link);
                }
            }
        }
        Change::RenameMember(r) => {
            // spec 026: участник сменил ник — пишет он сам новым адресом; доказательство — запись `Rename`
            // журнала устройств прежнего адреса, подписанная тем же корнем, что у подписанта
            let op = r.rename.as_ref().ok_or(ProtoError::InvalidField("rename"))?;
            let (old, root) = crate::identity::verify_rename_op(op, &actor)?;
            // Корень записи — корень журнала прежнего адреса (иначе чужим корнем «переименовали» бы любого)
            let old_root = lookup.and_then(|l| (l.root_of)(&old)).ok_or(ProtoError::Forbidden)?;
            if root != signer.root_key || root != old_root {
                return Err(ProtoError::BadSignature);
            }
            if s.members.contains_key(&actor) || s.banned.contains(&actor) {
                return forbid();
            }
            let member = s.members.remove(&old).ok_or(ProtoError::Forbidden)?;
            s.members.insert(actor.clone(), member);
            if s.owner == old {
                s.owner = actor.clone();
            }
            for link in s.invite_links.values_mut() {
                if link.creator == old {
                    link.creator = actor.clone();
                }
            }
        }
        Change::InviteEdit(e) => {
            let id: [u8; 32] = e.link_id.as_slice().try_into().map_err(|_| ProtoError::InvalidField("link_id"))?;
            // Только действующая ссылка: отозванную вернуть правкой нельзя
            let creator = s.invite_links.get(&id).map(|l| l.creator.clone()).ok_or(ProtoError::Forbidden)?;
            if !(s.admin_can(&actor, |r| r.invite_users) || creator == actor) {
                return forbid();
            }
            if e.expires_ms < 0 {
                return Err(ProtoError::InvalidField("expires_ms"));
            }
            if let Some(l) = s.invite_links.get_mut(&id) {
                l.announce.title = e.title.clone();
                l.announce.expires_ms = e.expires_ms;
                l.announce.usage_limit = e.usage_limit;
            }
        }
        Change::JoinByInvite(j) if s.public.as_ref().is_some_and(|p| p.link_public_key.as_slice() == j.link_public_key.as_slice()) => {
            // Публичная ссылка (spec 023): без лимитов; секрет открыт, поэтому новая эпоха на каждого вступившего
            // ничего не защищает — эпоха остаётся, ключи вступивший берёт из комплекта
            if j.joiner_root_key.as_slice() != signer.root_key || s.members.contains_key(&actor) || s.banned.contains(&actor) {
                return forbid();
            }
            if s.members.len() >= MAX_MEMBERS {
                return Err(ProtoError::FieldLimit("members"));
            }
            let parts = join_signing_parts(&s.group, entry.version, &entry.prev_hash, &j.joiner_root_key);
            sign::verify_ctx(&j.link_public_key, &j.link_signature, ctx::GROUP_JOIN, &[&parts])?;
            s.members.insert(actor, Member { role: Role::Member, rights: AdminRights::default(), muted_until_ms: 0 });
        }
        Change::JoinByInvite(j) => {
            let id = link_id(&j.link_public_key);
            let link = s.invite_links.get(&id).cloned().ok_or(ProtoError::Forbidden)?;
            if link.announce.requires_approval
                || (link.announce.expires_ms > 0 && now > link.announce.expires_ms)
                || (link.announce.usage_limit > 0 && link.uses >= link.announce.usage_limit)
            {
                return forbid();
            }
            if j.joiner_root_key.as_slice() != signer.root_key || s.members.contains_key(&actor) || s.banned.contains(&actor) {
                return forbid();
            }
            if s.members.len() >= MAX_MEMBERS {
                return Err(ProtoError::FieldLimit("members"));
            }
            let parts = join_signing_parts(&s.group, entry.version, &entry.prev_hash, &j.joiner_root_key);
            sign::verify_ctx(&j.link_public_key, &j.link_signature, ctx::GROUP_JOIN, &[&parts])?;
            if let Some(l) = s.invite_links.get_mut(&id) {
                l.note_join(actor.clone(), now);
            }
            s.members.insert(actor, Member { role: Role::Member, rights: AdminRights::default(), muted_until_ms: 0 });
            s.epoch_stale = true;
        }
        Change::Leave(_) => {
            if !is_member || actor == s.owner {
                return forbid();
            }
            s.members.remove(&actor);
            s.epoch_stale = true;
        }
        Change::DeleteGroup(_) => {
            if !s.is_owner(&actor) {
                return forbid();
            }
            s.deleted = true;
        }
    }
    s.version = entry.version;
    s.hashes.push(entry_hash(op));
    if sc.signer_log_version > 0 {
        let max = s.signer_versions.entry(signer.user.clone()).or_default();
        *max = (*max).max(sc.signer_log_version);
    }
    Ok(s)
}

/// Собрать и подписать запись журнала. Для генезиса `state = None`, а `group`
/// несёт только домен — id вычисляется из тела.
pub fn build_entry(signer: &dyn OpSigner, state: Option<&GroupState>, domain: &str, change: Change, ts_ms: i64) -> Result<GroupStateEntry> {
    build_entry_at(signer, state, domain, change, ts_ms, 0)
}

/// То же со ссылкой на версию журнала устройств подписанта (ENG-08).
pub fn build_entry_at(
    signer: &dyn OpSigner,
    state: Option<&GroupState>,
    domain: &str,
    change: Change,
    ts_ms: i64,
    signer_log_version: u64,
) -> Result<GroupStateEntry> {
    build_entry_as(signer, state, domain, change, ts_ms, signer_log_version, "")
}

/// То же с подсказкой адреса подписанта (spec 026: после смены ника).
pub fn build_entry_as(
    signer: &dyn OpSigner,
    state: Option<&GroupState>,
    domain: &str,
    change: Change,
    ts_ms: i64,
    signer_log_version: u64,
    signer_address: &str,
) -> Result<GroupStateEntry> {
    if !address::is_valid_domain(domain) {
        return Err(ProtoError::BadAddress);
    }
    let (version, prev_hash, sc_group, target) = match state {
        None => (1, ZERO_HASH, Ref { domain: domain.to_string(), id: vec![] }, None),
        Some(s) => (s.version + 1, s.head_hash(), s.group.clone(), Some(s.group.clone())),
    };
    let sc = GroupStateChange {
        group: Some(sc_group),
        version,
        prev_hash: prev_hash.to_vec(),
        change: Some(GroupChange { change: Some(change) }),
        signer_log_version,
        signer_address: signer_address.to_string(),
    };
    let header = OpHeader {
        domain: GROUP_DOMAIN.into(),
        op_type: GROUP_OP.into(),
        op_id: sign::new_op_id(),
        target,
        ts_ms,
        ..Default::default()
    };
    let op = sign::sign_op(signer, header, sc.encode_to_vec())?;
    let group = match state {
        None => Ref { domain: domain.to_string(), id: genesis_group_id(&op.body) },
        Some(s) => s.group.clone(),
    };
    Ok(GroupStateEntry { group: Some(group), version, prev_hash: prev_hash.to_vec(), change: Some(op) })
}

/// Подпись ссылкой-приглашением для вступления (у вступающего есть секрет ссылки).
pub fn sign_join(link_secret: &ed25519_dalek::SigningKey, state: &GroupState, joiner_root: &[u8; 32]) -> Vec<u8> {
    let parts = join_signing_parts(&state.group, state.version + 1, &state.head_hash(), joiner_root);
    sign::sign_ctx(link_secret, ctx::GROUP_JOIN, &[&parts])
}

// ── публичные группы (spec 023) ─────────────────────────────────────────────

const PUBLIC_NAME_MIN: usize = 5;
const PUBLIC_NAME_MAX: usize = 32;

/// Публичное имя: 5–32 знака, латиница/цифры/`_`, с буквы; хранится в нижнем регистре.
pub fn normalize_public_name(name: &str) -> Option<String> {
    let n = name.trim().trim_start_matches('@').to_ascii_lowercase();
    let ok = (PUBLIC_NAME_MIN..=PUBLIC_NAME_MAX).contains(&n.len())
        && n.starts_with(|c: char| c.is_ascii_lowercase())
        && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    ok.then_some(n)
}

fn public_derive(secret: &[u8; 32], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let hk = hkdf::Hkdf::<Sha256>::new(None, secret);
    let mut out = Zeroizing::new([0u8; 32]);
    // Длина 32 у HKDF-SHA256 допустима всегда
    let _ = hk.expand(info, out.as_mut());
    out
}

/// Ключ публичной ссылки: вступление по ней подписывается им (тот же `JoinByInvite`).
pub fn public_link_key(secret: &[u8; 32]) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&public_derive(secret, b"parvane/v2/public-link"))
}

fn bundle_key(secret: &[u8; 32], group: &Ref, epoch: u64) -> Zeroizing<[u8; 32]> {
    let mut info = b"parvane/v2/public-epoch\0".to_vec();
    info.extend_from_slice(&group.id);
    info.extend_from_slice(&epoch.to_be_bytes());
    public_derive(secret, &info)
}

/// Комплект эпохи публичной группы: ключ конверта ‖ закрытый ключ отправки под ключом от секрета и эпохи.
pub fn seal_public_bundle(secret: &[u8; 32], group: &Ref, epoch: u64, envelope_key: &[u8; 32], send_sk: &[u8; 32]) -> Result<Vec<u8>> {
    let key = bundle_key(secret, group, epoch);
    let mut nonce = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let mut plain = Zeroizing::new(envelope_key.to_vec());
    plain.extend_from_slice(send_sk);
    let ct = ChaCha20Poly1305::new(Key::from_slice(key.as_ref()))
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: &group.id })
        .map_err(|_| ProtoError::Crypto)?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Открыть комплект эпохи: (ключ конверта, закрытый ключ отправки).
pub fn open_public_bundle(secret: &[u8; 32], group: &Ref, epoch: u64, bundle: &[u8]) -> Result<(Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>)> {
    if bundle.len() < 12 {
        return Err(ProtoError::Crypto);
    }
    let key = bundle_key(secret, group, epoch);
    let plain = Zeroizing::new(
        ChaCha20Poly1305::new(Key::from_slice(key.as_ref()))
            .decrypt(Nonce::from_slice(&bundle[..12]), Payload { msg: &bundle[12..], aad: &group.id })
            .map_err(|_| ProtoError::Crypto)?,
    );
    if plain.len() != 64 {
        return Err(ProtoError::Crypto);
    }
    let mut envelope = Zeroizing::new([0u8; 32]);
    let mut send = Zeroizing::new([0u8; 32]);
    envelope.copy_from_slice(&plain[..32]);
    send.copy_from_slice(&plain[32..]);
    Ok((envelope, send))
}

// ── конверты групповых сообщений (D-07) ─────────────────────────────────────

fn envelope_aad(group: &Ref, epoch: u64, nonce: &[u8]) -> Vec<u8> {
    let mut a = group.domain.as_bytes().to_vec();
    a.push(0);
    a.extend_from_slice(&group.id);
    a.extend_from_slice(&epoch.to_be_bytes());
    a.extend_from_slice(nonce);
    a
}

fn envelope_sig_parts(env: &GroupEnvelope) -> Result<Vec<u8>> {
    let g = env.group.as_ref().ok_or(ProtoError::InvalidField("group"))?;
    let mut p = envelope_aad(g, env.epoch, &env.envelope_nonce);
    p.extend_from_slice(&Sha256::digest(&env.epoch_aead_ciphertext));
    Ok(p)
}

/// Запечатать групповое сообщение: AEAD на ключе конверта эпохи + подпись
/// ключом отправки эпохи.
pub fn seal_envelope(send_key: &dyn OpSigner, envelope_key: &[u8; 32], group: &Ref, epoch: u64, inner: &GroupEnvelopeInner) -> Result<GroupEnvelope> {
    address::check_ref(group)?;
    let mut nonce = vec![0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(envelope_key));
    let pt = Zeroizing::new(inner.encode_to_vec());
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce[..12]), Payload { msg: &pt, aad: &envelope_aad(group, epoch, &nonce) })
        .map_err(|_| ProtoError::Crypto)?;
    let mut env = GroupEnvelope { group: Some(group.clone()), epoch, epoch_aead_ciphertext: ct, envelope_nonce: nonce, epoch_signature: vec![] };
    env.epoch_signature = sign::sign_ctx(send_key, ctx::GROUP_ENVELOPE, &[&envelope_sig_parts(&env)?]);
    Ok(env)
}

/// Проверка сервером: эпоха текущая и подпись ключом отправки этой эпохи.
pub fn verify_envelope(env: &GroupEnvelope, state_epoch: u64, send_public_key: &[u8; 32]) -> Result<()> {
    if env.epoch != state_epoch {
        return Err(ProtoError::Expired);
    }
    if env.envelope_nonce.len() != 16 {
        return Err(ProtoError::InvalidField("envelope_nonce"));
    }
    sign::verify_ctx(send_public_key, &env.epoch_signature, ctx::GROUP_ENVELOPE, &[&envelope_sig_parts(env)?])
}

/// Снять AEAD конверта (участник).
pub fn open_envelope(env: &GroupEnvelope, envelope_key: &[u8; 32]) -> Result<GroupEnvelopeInner> {
    let g = env.group.as_ref().ok_or(ProtoError::InvalidField("group"))?;
    if env.envelope_nonce.len() != 16 {
        return Err(ProtoError::InvalidField("envelope_nonce"));
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(envelope_key));
    let pt = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&env.envelope_nonce[..12]),
                Payload { msg: &env.epoch_aead_ciphertext, aad: &envelope_aad(g, env.epoch, &env.envelope_nonce) },
            )
            .map_err(|_| ProtoError::Crypto)?,
    );
    decode_checked(&pt, Origin::Client)
}

/// Подпись «печатает» в группе ключом отправки эпохи (D-07).
pub fn sign_group_typing(send_key: &dyn OpSigner, group: &Ref, epoch: u64, nonce: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut p = envelope_aad(group, epoch, nonce);
    p.extend_from_slice(payload);
    sign::sign_ctx(send_key, ctx::GROUP_TYPING, &[&p])
}

pub fn verify_group_typing(send_public_key: &[u8; 32], group: &Ref, epoch: u64, nonce: &[u8], payload: &[u8], sig: &[u8]) -> Result<()> {
    let mut p = envelope_aad(group, epoch, nonce);
    p.extend_from_slice(payload);
    sign::verify_ctx(send_public_key, sig, ctx::GROUP_TYPING, &[&p])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::core::v2::UserRef;
    use crate::pb::parvane::group::v2::{AddMember, Ban, Create, Mute, NewEpoch, SetInfo, SetRole};
    use ed25519_dalek::SigningKey;
    use std::collections::HashMap;

    struct World {
        keys: HashMap<String, SigningKey>,
        roots: HashMap<String, [u8; 32]>,
    }

    impl World {
        fn new(users: &[&str]) -> Self {
            let mut keys = HashMap::new();
            let mut roots = HashMap::new();
            for u in users {
                keys.insert(u.to_string(), sign::generate_signing_key());
                roots.insert(u.to_string(), [u.len() as u8; 32]);
            }
            Self { keys, roots }
        }
        fn resolve(&self) -> impl Fn(&[u8; 32], u64) -> Option<SignerInfo> + '_ {
            move |k, _| {
                self.keys
                    .iter()
                    .find(|(_, sk)| &sk.verifying_key().to_bytes() == k)
                    .map(|(u, _)| SignerInfo { user: u.clone(), root_key: self.roots[u] })
            }
        }
        fn k(&self, u: &str) -> &SigningKey {
            &self.keys[u]
        }
    }

    /// ENG-08: запись проверяется по ключу, действовавшему в версии журнала устройств подписанта, и
    /// версии одного пользователя в журнале группы не убывают.
    #[test]
    fn signer_log_version_is_checked_and_monotonic() {
        let w = World::new(&["alice@x", "bob@x"]);
        let alice = w.keys["alice@x"].verifying_key().to_bytes();
        // Ключ Алисы действует в версиях 1..=4 её журнала (в 5-й — отзыв)
        let resolve = |k: &[u8; 32], v: u64| (k == &alice && (v == 0 || v < 5)).then(|| SignerInfo { user: "alice@x".into(), root_key: w.roots["alice@x"] });
        let create = Create { kind: GroupKind::Group as i32, members: vec![UserRef { address: "bob@x".into() }], ..Default::default() };
        let g = build_entry_at(w.k("alice@x"), None, "x", Change::Create(create), 1, 3).unwrap();
        let s = apply(None, &g, &resolve).unwrap();
        assert_eq!(s.signer_versions.get("alice@x"), Some(&3));
        // Ссылка на версию, где ключ уже отозван, — отказ
        let late = build_entry_at(w.k("alice@x"), Some(&s), "x", Change::SetInfo(SetInfo { name: "n".into(), ..Default::default() }), 2, 5).unwrap();
        assert_eq!(apply(Some(&s), &late, &resolve).err(), Some(ProtoError::Forbidden));
        let s2 = apply(Some(&s), &build_entry_at(w.k("alice@x"), Some(&s), "x", Change::SetInfo(SetInfo { name: "n".into(), ..Default::default() }), 2, 4).unwrap(), &resolve).unwrap();
        // Версия меньше уже упомянутой — отказ (отозванное устройство не «откатывается» на старую)
        let back = build_entry_at(w.k("alice@x"), Some(&s2), "x", Change::SetInfo(SetInfo { name: "m".into(), ..Default::default() }), 3, 3).unwrap();
        assert_eq!(apply(Some(&s2), &back, &resolve).err(), Some(ProtoError::Forbidden));
    }

    fn ur(a: &str) -> Option<UserRef> {
        Some(UserRef { address: a.into() })
    }

    fn perms() -> Permissions {
        Permissions { send_messages: true, send_media: true, send_stickers_gifs: true, send_polls: true, embed_links: true, invite_users: true, ..Default::default() }
    }

    #[test]
    fn create_records_migrated_from() {
        // T180: группа, переведённая из v1, несёт прежний group_id в записи генезиса —
        // он входит в идентификатор группы и виден в состоянии
        let w = World::new(&["alice@x"]);
        let make = |from: &str| {
            let create = Create { kind: GroupKind::Group as i32, name: "G".into(), default_permissions: Some(perms()), migrated_from: from.into(), ..Default::default() };
            let e = build_entry(w.k("alice@x"), None, "x", Change::Create(create), 1).unwrap();
            let st = apply(None, &e, &w.resolve()).unwrap();
            (e.group.unwrap().id, st.migrated_from)
        };
        let (plain_id, plain_from) = make("");
        let (moved_id, moved_from) = make("0190a0b0-0000-7000-8000-000000000001");
        assert_eq!(plain_from, "");
        assert_eq!(moved_from, "0190a0b0-0000-7000-8000-000000000001");
        assert_ne!(plain_id, moved_id);
    }

    fn genesis(w: &World) -> GroupState {
        let e = build_entry(
            w.k("alice@x"),
            None,
            "x",
            Change::Create(Create { kind: GroupKind::Group as i32, name: "G".into(), default_permissions: Some(perms()), members: vec![UserRef { address: "bob@x".into() }], ..Default::default() }),
            1,
        )
        .unwrap();
        apply(None, &e, &w.resolve()).unwrap()
    }

    #[test]
    fn chain_and_rights() {
        let w = World::new(&["alice@x", "bob@x", "carol@x"]);
        let s = genesis(&w);
        assert_eq!(s.owner, "alice@x");
        // Боб (участник) не может банить.
        let e = build_entry(w.k("bob@x"), Some(&s), "x", Change::Ban(Ban { member: ur("alice@x") }), 2).unwrap();
        assert_eq!(apply(Some(&s), &e, &w.resolve()), Err(ProtoError::Forbidden));
        // Боб приглашает Кэрол (права по умолчанию разрешают).
        let e = build_entry(w.k("bob@x"), Some(&s), "x", Change::AddMember(AddMember { via_link_id: Vec::new(), member: ur("carol@x") }), 2).unwrap();
        let s2 = apply(Some(&s), &e, &w.resolve()).unwrap();
        assert!(s2.members.contains_key("carol@x"));
        // Алиса банит Кэрол → эпоха устарела.
        let e = build_entry(w.k("alice@x"), Some(&s2), "x", Change::Ban(Ban { member: ur("carol@x") }), 3).unwrap();
        let s3 = apply(Some(&s2), &e, &w.resolve()).unwrap();
        assert!(!s3.members.contains_key("carol@x") && s3.epoch_stale);
    }

    #[test]
    fn position_is_signed() {
        let w = World::new(&["alice@x", "bob@x"]);
        let s = genesis(&w);
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::SetRole(SetRole { member: ur("bob@x"), role: Role::Admin as i32, rights: Some(full_rights()) }), 2).unwrap();
        let s2 = apply(Some(&s), &e, &w.resolve()).unwrap();
        // Повтор той же записи позже (перестановка сервером).
        assert_eq!(apply(Some(&s2), &e, &w.resolve()).err(), Some(ProtoError::BrokenChain));
        // Подмена внешних полей под следующую позицию: подписанные не совпадут.
        let mut moved = e.clone();
        moved.version = 3;
        moved.prev_hash = s2.head_hash().to_vec();
        assert_eq!(apply(Some(&s2), &moved, &w.resolve()).err(), Some(ProtoError::ContextMismatch));
        // Перенос в другую группу.
        let other = genesis(&w);
        let mut foreign = e.clone();
        foreign.group = Some(Ref { domain: "x".into(), id: vec![9; 16] });
        assert!(apply(Some(&other), &foreign, &w.resolve()).is_err());
    }

    #[test]
    fn genesis_id_binding() {
        let w = World::new(&["alice@x", "bob@x"]);
        let mut e = build_entry(w.k("alice@x"), None, "x", Change::Create(Create { kind: GroupKind::Group as i32, ..Default::default() }), 1).unwrap();
        e.group = Some(Ref { domain: "x".into(), id: vec![1; 16] });
        assert_eq!(apply(None, &e, &w.resolve()), Err(ProtoError::ContextMismatch));
    }

    #[test]
    fn epochs_rate_and_envelopes() {
        let w = World::new(&["alice@x", "bob@x"]);
        let s = genesis(&w);
        let send1 = sign::generate_signing_key();
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::NewEpoch(NewEpoch { epoch: 1, send_public_key: send1.verifying_key().to_bytes().to_vec(), ..Default::default() }), 1_000).unwrap();
        let s1 = apply(Some(&s), &e, &w.resolve()).unwrap();
        let send2 = sign::generate_signing_key();
        let fast = build_entry(w.k("alice@x"), Some(&s1), "x", Change::NewEpoch(NewEpoch { epoch: 2, send_public_key: send2.verifying_key().to_bytes().to_vec(), ..Default::default() }), 5_000).unwrap();
        assert_eq!(apply(Some(&s1), &fast, &w.resolve()), Err(ProtoError::RateLimited));

        let ek = [4u8; 32];
        let inner = GroupEnvelopeInner { megolm_session_id: b"sid".to_vec(), megolm_message: b"m".to_vec(), padding: vec![], public_session: vec![] };
        let env = seal_envelope(&send1, &ek, &s1.group, 1, &inner).unwrap();
        verify_envelope(&env, 1, &send1.verifying_key().to_bytes()).unwrap();
        assert_eq!(open_envelope(&env, &ek).unwrap(), inner);
        // Подпись не тем ключом эпохи (исключённый участник с ключом старой эпохи).
        assert!(verify_envelope(&env, 1, &send2.verifying_key().to_bytes()).is_err());
        assert_eq!(verify_envelope(&env, 2, &send1.verifying_key().to_bytes()), Err(ProtoError::Expired));
        // Снаружи нет id Megolm-сессии.
        assert!(!env.epoch_aead_ciphertext.windows(3).any(|w| w == b"sid"));
    }

    #[test]
    fn mute_blocks_writing_and_fork_detection() {
        let w = World::new(&["alice@x", "bob@x"]);
        let s = genesis(&w);
        assert!(s.can_write("bob@x", 10));
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::Mute(Mute { member: ur("bob@x"), until_ms: 1_000_000 }), 2).unwrap();
        let s2 = apply(Some(&s), &e, &w.resolve()).unwrap();
        assert!(!s2.can_write("bob@x", 10));
        assert!(!s2.writers(10).contains(&"bob@x".to_string()));
        let mut c = s2.context();
        assert_eq!(s2.check_context(&c), ContextVerdict::Ok);
        c.state_head_hash = vec![0; 32];
        assert_eq!(s2.check_context(&c), ContextVerdict::Fork);
        c.state_version = 9;
        assert_eq!(s2.check_context(&c), ContextVerdict::Behind);
    }

    #[test]
    fn invite_links() {
        use crate::pb::parvane::group::v2::JoinByInvite;
        let w = World::new(&["alice@x", "bob@x", "dave@x"]);
        let s = genesis(&w);
        let link = sign::generate_signing_key();
        let announce = GroupInviteKeyAnnounce { link_public_key: link.verifying_key().to_bytes().to_vec(), ..Default::default() };
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::InviteKey(announce), 2).unwrap();
        let s2 = apply(Some(&s), &e, &w.resolve()).unwrap();
        let root = w.roots["dave@x"];
        let join = JoinByInvite { link_public_key: link.verifying_key().to_bytes().to_vec(), joiner_root_key: root.to_vec(), link_signature: sign_join(&link, &s2, &root) };
        let e = build_entry(w.k("dave@x"), Some(&s2), "x", Change::JoinByInvite(join.clone()), 3).unwrap();
        let s3 = apply(Some(&s2), &e, &w.resolve()).unwrap();
        assert!(s3.members.contains_key("dave@x"));
        // Сервер без секрета ссылки не может подписать вступление.
        let fake_link = sign::generate_signing_key();
        let forged = JoinByInvite { link_signature: sign_join(&fake_link, &s2, &root), ..join };
        let e = build_entry(w.k("dave@x"), Some(&s2), "x", Change::JoinByInvite(forged), 3).unwrap();
        assert!(apply(Some(&s2), &e, &w.resolve()).is_err());
    }

    /// spec 024: правка ссылки (название, срок, лимит) сохраняет счётчик; вступившие по ссылке и одобренные
    /// заявки по ней считаются и попадают в список; отозванную ссылку править нельзя; участник без права — нет.
    #[test]
    fn invite_edit_and_joins() {
        use crate::pb::parvane::group::v2::{InviteEdit, InviteKeyRevoke, JoinByInvite};
        let w = World::new(&["alice@x", "bob@x", "dave@x", "erin@x"]);
        let s = genesis(&w);
        let link = sign::generate_signing_key();
        let pubkey = link.verifying_key().to_bytes().to_vec();
        let id = link_id(&pubkey).to_vec();
        let announce = GroupInviteKeyAnnounce { link_public_key: pubkey.clone(), title: "до".into(), ..Default::default() };
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::InviteKey(announce), 2).unwrap();
        let s = apply(Some(&s), &e, &w.resolve()).unwrap();
        let root = w.roots["dave@x"];
        let join = JoinByInvite { link_public_key: pubkey.clone(), joiner_root_key: root.to_vec(), link_signature: sign_join(&link, &s, &root) };
        let e = build_entry(w.k("dave@x"), Some(&s), "x", Change::JoinByInvite(join), 3).unwrap();
        let s = apply(Some(&s), &e, &w.resolve()).unwrap();
        // Правка: участник без права не может, владелец — может, счётчик и вступившие остаются
        let edit = |title: &str, limit: u32| InviteEdit { link_id: id.clone(), title: title.into(), expires_ms: 0, usage_limit: limit };
        let e = build_entry(w.k("bob@x"), Some(&s), "x", Change::InviteEdit(edit("чужая", 5)), 4).unwrap();
        assert!(apply(Some(&s), &e, &w.resolve()).is_err(), "участник без invite_users");
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::InviteEdit(edit("после", 5)), 4).unwrap();
        let s = apply(Some(&s), &e, &w.resolve()).unwrap();
        let l = &s.invite_links[&link_id(&pubkey)];
        assert_eq!((l.announce.title.as_str(), l.announce.usage_limit, l.uses), ("после", 5, 1));
        assert_eq!(l.joins.iter().map(|(u, _)| u.as_str()).collect::<Vec<_>>(), ["dave@x"]);
        // Одобренная заявка по ссылке считается в ней
        let add = AddMember { via_link_id: id.clone(), member: ur("erin@x") };
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::AddMember(add), 5).unwrap();
        let s = apply(Some(&s), &e, &w.resolve()).unwrap();
        let l = &s.invite_links[&link_id(&pubkey)];
        assert_eq!(l.uses, 2);
        assert_eq!(l.joins.last().map(|(u, _)| u.as_str()), Some("erin@x"));
        let json = s.invites_json();
        assert_eq!(json[0]["joins"].as_array().map(Vec::len), Some(2));
        // Отозванную — не править
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::InviteKeyRevoke(InviteKeyRevoke { link_id: id.clone() }), 6).unwrap();
        let s = apply(Some(&s), &e, &w.resolve()).unwrap();
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::InviteEdit(edit("снова", 0)), 7).unwrap();
        assert!(apply(Some(&s), &e, &w.resolve()).is_err(), "отозванная ссылка");
    }

    /// spec 023: публичная группа — имя и секрет в журнале, вступление по ключу из секрета без новой эпохи,
    /// ключи эпохи — из комплекта; участник без `change_info` публичной её не сделает; выключение — новая эпоха.
    #[test]
    fn public_groups() {
        use crate::pb::parvane::group::v2::{JoinByInvite, NewEpoch, SetPublic};
        let w = World::new(&["alice@x", "bob@x", "dave@x"]);
        let s = genesis(&w);
        let secret = [7u8; 32];
        let set = |name: &str| SetPublic { public: true, name: name.into(), secret: secret.to_vec(), preview: true, history: false };
        let e = build_entry(w.k("bob@x"), Some(&s), "x", Change::SetPublic(set("Hiking")), 2).unwrap();
        assert!(apply(Some(&s), &e, &w.resolve()).is_err(), "участник без прав");
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::SetPublic(set("1bad")), 2).unwrap();
        assert!(apply(Some(&s), &e, &w.resolve()).is_err(), "имя с цифры");
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::SetPublic(set("@Hiking")), 2).unwrap();
        let s2 = apply(Some(&s), &e, &w.resolve()).unwrap();
        assert_eq!(s2.public.as_ref().unwrap().name, "hiking");
        assert!(s2.epoch_stale);
        // Новая эпоха с комплектом: держатель секрета открывает ключи
        let send = sign::generate_signing_key();
        let bundle = seal_public_bundle(&secret, &s2.group, 1, &[5; 32], &send.to_bytes()).unwrap();
        let e = build_entry(w.k("alice@x"), Some(&s2), "x", Change::NewEpoch(NewEpoch { epoch: 1, send_public_key: send.verifying_key().to_bytes().to_vec(), public_bundle: bundle }), 1_000).unwrap();
        let s3 = apply(Some(&s2), &e, &w.resolve()).unwrap();
        let (env, sk) = open_public_bundle(&secret, &s3.group, 1, &s3.public_bundles[&1]).unwrap();
        assert_eq!(*env, [5; 32]);
        assert_eq!(*sk, send.to_bytes());
        assert!(open_public_bundle(&[8; 32], &s3.group, 1, &s3.public_bundles[&1]).is_err(), "чужой секрет");
        // Вступление по публичной ссылке: эпоха не устаревает
        let link = public_link_key(&secret);
        let root = w.roots["dave@x"];
        let join = JoinByInvite { link_public_key: link.verifying_key().to_bytes().to_vec(), joiner_root_key: root.to_vec(), link_signature: sign_join(&link, &s3, &root) };
        let e = build_entry(w.k("dave@x"), Some(&s3), "x", Change::JoinByInvite(join), 2_000).unwrap();
        let s4 = apply(Some(&s3), &e, &w.resolve()).unwrap();
        assert!(s4.members.contains_key("dave@x") && !s4.epoch_stale);
        // Снова частная — новая эпоха обязательна
        let e = build_entry(w.k("alice@x"), Some(&s4), "x", Change::SetPublic(SetPublic::default()), 3_000).unwrap();
        let s5 = apply(Some(&s4), &e, &w.resolve()).unwrap();
        assert!(s5.public.is_none() && s5.epoch_stale);
    }

    /// T079: политика L2 группы — право как у изменения сведений (`change_info`),
    /// проверяется по состоянию до записи; эпоха не устаревает.
    #[test]
    fn privacy_mode_policy_rights() {
        use crate::pb::parvane::group::v2::SetPrivacyMode;
        let w = World::new(&["alice@x", "bob@x", "carol@x"]);
        let s = genesis(&w);
        let send = sign::generate_signing_key();
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::NewEpoch(NewEpoch { epoch: 1, send_public_key: send.verifying_key().to_bytes().to_vec(), ..Default::default() }), 1_000).unwrap();
        let s = apply(Some(&s), &e, &w.resolve()).unwrap();
        assert!(!s.l2 && !s.epoch_stale);
        // Участник без права менять сведения — отказ.
        let e = build_entry(w.k("bob@x"), Some(&s), "x", Change::SetPrivacyMode(SetPrivacyMode { l2: true }), 2_000).unwrap();
        assert_eq!(apply(Some(&s), &e, &w.resolve()), Err(ProtoError::Forbidden));
        // Посторонний — отказ.
        let e = build_entry(w.k("carol@x"), Some(&s), "x", Change::SetPrivacyMode(SetPrivacyMode { l2: true }), 2_000).unwrap();
        assert_eq!(apply(Some(&s), &e, &w.resolve()), Err(ProtoError::Forbidden));
        // Владелец включает.
        let e = build_entry(w.k("alice@x"), Some(&s), "x", Change::SetPrivacyMode(SetPrivacyMode { l2: true }), 2_000).unwrap();
        let s2 = apply(Some(&s), &e, &w.resolve()).unwrap();
        assert!(s2.l2 && s2.l2_by == "alice@x" && !s2.epoch_stale && s2.version == s.version + 1);
        // Админ с change_info выключает; админ без него — нет.
        let rights = AdminRights { change_info: true, ..Default::default() };
        let e = build_entry(w.k("alice@x"), Some(&s2), "x", Change::SetRole(SetRole { member: ur("bob@x"), role: Role::Admin as i32, rights: Some(rights) }), 3_000).unwrap();
        let s3 = apply(Some(&s2), &e, &w.resolve()).unwrap();
        let e = build_entry(w.k("bob@x"), Some(&s3), "x", Change::SetPrivacyMode(SetPrivacyMode { l2: false }), 4_000).unwrap();
        let s4 = apply(Some(&s3), &e, &w.resolve()).unwrap();
        assert!(!s4.l2 && s4.l2_by == "bob@x");
        let e = build_entry(w.k("alice@x"), Some(&s4), "x", Change::SetRole(SetRole { member: ur("bob@x"), role: Role::Admin as i32, rights: Some(AdminRights { pin_messages: true, ..Default::default() }) }), 5_000).unwrap();
        let s5 = apply(Some(&s4), &e, &w.resolve()).unwrap();
        let e = build_entry(w.k("bob@x"), Some(&s5), "x", Change::SetPrivacyMode(SetPrivacyMode { l2: true }), 6_000).unwrap();
        assert_eq!(apply(Some(&s5), &e, &w.resolve()), Err(ProtoError::Forbidden));
        // Право по умолчанию change_info даёт его и обычному участнику.
        let e = build_entry(
            w.k("alice@x"),
            Some(&s5),
            "x",
            Change::SetPermissions(crate::pb::parvane::group::v2::SetPermissions { default_permissions: Some(Permissions { change_info: true, ..perms() }) }),
            7_000,
        )
        .unwrap();
        let s6 = apply(Some(&s5), &e, &w.resolve()).unwrap();
        let e = build_entry(w.k("alice@x"), Some(&s6), "x", Change::SetRole(SetRole { member: ur("bob@x"), role: Role::Member as i32, rights: None }), 8_000).unwrap();
        let s7 = apply(Some(&s6), &e, &w.resolve()).unwrap();
        let e = build_entry(w.k("bob@x"), Some(&s7), "x", Change::SetPrivacyMode(SetPrivacyMode { l2: true }), 9_000).unwrap();
        assert!(apply(Some(&s7), &e, &w.resolve()).unwrap().l2);
    }

    /// C1-07: потолок участников (добавление; вступление — той же проверкой).
    #[test]
    fn member_ceiling() {
        let w = World::new(&["alice@x"]);
        let first: Vec<UserRef> = (0..199).map(|i| UserRef { address: format!("u{i}@x") }).collect();
        let e = build_entry(w.k("alice@x"), None, "x", Change::Create(Create { kind: GroupKind::Group as i32, members: first, ..Default::default() }), 1).unwrap();
        let mut s = apply(None, &e, &w.resolve()).unwrap();
        let mut i = 1000;
        while s.members.len() < MAX_MEMBERS {
            let add = build_entry(w.k("alice@x"), Some(&s), "x", Change::AddMember(AddMember { via_link_id: Vec::new(), member: ur(&format!("u{i}@x")) }), 2).unwrap();
            s = apply(Some(&s), &add, &w.resolve()).unwrap();
            i += 1;
        }
        let add = build_entry(w.k("alice@x"), Some(&s), "x", Change::AddMember(AddMember { via_link_id: Vec::new(), member: ur("extra@x") }), 2).unwrap();
        assert_eq!(apply(Some(&s), &add, &w.resolve()), Err(ProtoError::FieldLimit("members")));
    }
}
