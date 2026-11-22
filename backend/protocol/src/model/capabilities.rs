//! Что разрешено композеру и меню чата (spec 035 T069, GROUP-2, GROUP-3): сведения группы — только из её
//! журнала (`GroupState`); права по типу содержимого и роли считает движок, клиенты только показывают.

use std::collections::BTreeMap;

use crate::group::GroupState;
use crate::pb::parvane::core::v2::Ref;
use crate::pb::parvane::engine::v1::{Capabilities, GroupPerms, GroupRole, GroupView, ViewMedia};
use crate::pb::parvane::group::v2::{AdminRights, GroupKind, Permissions, Role};
use crate::pb::parvane::msg::v2::{content, Content, MediaKind};

/// Сведения группы, нужные модели (из журнала через `GroupState` либо из векторов).
#[derive(Debug, Clone, Default)]
pub struct GroupFacts {
    pub group: Ref,
    pub channel: bool,
    pub title: String,
    pub about: String,
    pub owner: String,
    pub members: BTreeMap<String, (i32, AdminRights, i64)>,
    /// Канал: участники без админских прав, которым разрешено писать (`SetRole.writer`).
    pub writers: std::collections::BTreeSet<String>,
    pub banned: Vec<String>,
    pub perms: Permissions,
    pub deleted: bool,
    pub public: bool,
    pub avatar_file_id: String,
    /// Секрет фото (GPHOTO-1) — у участников из конверта эпохи; пусто у частной группы без ключа — фото нет.
    pub avatar_key: Vec<u8>,
    pub avatar_private: bool,
    pub version: u64,
    pub invite_links: Vec<String>,
}

impl GroupFacts {
    pub fn from_state(s: &GroupState, avatar_key: Option<[u8; 32]>) -> Self {
        GroupFacts {
            group: s.group.clone(),
            channel: s.kind == GroupKind::Channel,
            title: s.name.clone(),
            about: s.about.clone(),
            owner: s.owner.clone(),
            members: s.members.iter().map(|(u, m)| (u.clone(), (m.role as i32, m.rights, m.muted_until_ms))).collect(),
            writers: s.members.iter().filter(|(_, m)| m.writer).map(|(u, _)| u.clone()).collect(),
            banned: s.banned.iter().cloned().collect(),
            perms: s.default_permissions,
            deleted: s.deleted,
            public: s.public.is_some(),
            avatar_file_id: s.avatar_file_id.clone(),
            avatar_key: avatar_key.map(|k| k.to_vec()).unwrap_or_default(),
            avatar_private: !s.avatar_key_id.is_empty(),
            version: s.version,
            invite_links: vec![],
        }
    }

    pub fn is_owner(&self, u: &str) -> bool {
        self.owner == u
    }

    pub fn is_admin(&self, u: &str) -> bool {
        self.is_owner(u) || self.members.get(u).is_some_and(|(r, _, _)| *r == Role::Admin as i32)
    }

    fn rights(&self, u: &str) -> AdminRights {
        if self.is_owner(u) {
            return AdminRights { change_info: true, delete_messages: true, ban_users: true, invite_users: true, pin_messages: true, add_admins: true };
        }
        match self.members.get(u) {
            Some((r, rights, _)) if *r == Role::Admin as i32 => *rights,
            _ => AdminRights::default(),
        }
    }

    pub fn role(&self, u: &str) -> GroupRole {
        if self.banned.iter().any(|b| b == u) {
            return GroupRole::Banned;
        }
        if self.is_owner(u) {
            return GroupRole::Owner;
        }
        match self.members.get(u) {
            Some((r, _, _)) if *r == Role::Admin as i32 => GroupRole::Admin,
            Some(_) => GroupRole::Member,
            None => GroupRole::Left,
        }
    }

    /// Может ли писать сейчас (как `GroupState::can_write`).
    pub fn can_write(&self, u: &str, now_ms: i64) -> bool {
        let muted = match self.members.get(u) {
            Some((_, _, m)) => *m,
            None if self.is_owner(u) => 0,
            None => return false,
        };
        if self.deleted || self.banned.iter().any(|b| b == u) || muted > now_ms {
            return false;
        }
        self.is_admin(u) || if self.channel { self.writers.contains(u) } else { self.perms.send_messages }
    }

    /// Права по типу содержимого (GROUP-2; та же формула, что `GroupState::content_allowed`).
    pub fn content_allowed(&self, u: &str, c: &Content, now_ms: i64) -> bool {
        if !self.can_write(u, now_ms) {
            return false;
        }
        if self.is_admin(u) {
            return true;
        }
        let p = &self.perms;
        match &c.kind {
            Some(content::Kind::Media(m)) if m.kind == MediaKind::Animation as i32 => p.send_stickers_gifs,
            // Ссылка в подписи медиа — тоже ссылка (GROUP-2 `embed_links`, как текст)
            Some(content::Kind::Media(_)) => p.send_media && (p.embed_links || !super::views::has_link(c)),
            Some(content::Kind::Sticker(_)) => p.send_stickers_gifs,
            Some(content::Kind::Poll(_)) => p.send_polls,
            Some(content::Kind::Text(_)) => p.embed_links || !super::views::has_link(c),
            Some(content::Kind::Pin(_)) => p.pin_messages,
            Some(content::Kind::Article(a)) => p.send_media || a.media.is_empty(),
            Some(content::Kind::Edit(e)) => p.embed_links || e.text.as_ref().is_none_or(|t| t.preview.is_none()),
            _ => true,
        }
    }

    /// Скрыть ли полученное сообщение (GROUP-2): автор — участник без роли и вид запрещён; неизвестная роль
    /// автора (его нет в составе) — показывать; владельца и админов — всегда показывать.
    pub fn hides(&self, author: &str, c: &Content, now_ms: i64) -> bool {
        if self.is_admin(author) || !self.members.contains_key(author) {
            return false;
        }
        // Писать вправе (немой/не участник уже отсечены): проверяется только тип
        let p = &self.perms;
        if !p.send_messages && !self.channel {
            return true;
        }
        let _ = now_ms;
        !match &c.kind {
            Some(content::Kind::Media(m)) if m.kind == MediaKind::Animation as i32 => p.send_stickers_gifs,
            // Ссылка в подписи медиа — тоже ссылка (GROUP-2 `embed_links`, как текст)
            Some(content::Kind::Media(_)) => p.send_media && (p.embed_links || !super::views::has_link(c)),
            Some(content::Kind::Sticker(_)) => p.send_stickers_gifs,
            Some(content::Kind::Poll(_)) => p.send_polls,
            Some(content::Kind::Text(_)) => p.embed_links || !super::views::has_link(c),
            Some(content::Kind::Article(a)) => p.send_media || a.media.is_empty(),
            _ => true,
        }
    }

    /// Сверка conformance GROUP-2: скрыл бы приёмный фильтр содержимое автора с ролью `role` (`member`, `admin`,
    /// `owner`, иное — не в составе) при правах по умолчанию `perms`.
    pub fn hidden_for_role(perms: Permissions, role: &str, c: &Content) -> bool {
        let author = "author@conformance";
        let mut g = GroupFacts { owner: "owner@conformance".into(), perms, ..Default::default() };
        match role {
            "owner" => g.owner = author.into(),
            "admin" => {
                g.members.insert(author.into(), (Role::Admin as i32, AdminRights::default(), 0));
            }
            "member" => {
                g.members.insert(author.into(), (Role::Member as i32, AdminRights::default(), 0));
            }
            _ => {}
        }
        g.hides(author, c, 0)
    }

    pub fn view(&self, me: &str) -> GroupView {
        let role = self.role(me);
        let admin = self.is_admin(me);
        let r = self.rights(me);
        let p = &self.perms;
        let photo = (!self.avatar_file_id.is_empty() && (!self.avatar_private || !self.avatar_key.is_empty())).then(|| ViewMedia {
            kind: "photo".into(),
            file_id: self.avatar_file_id.clone(),
            blob_domain: self.group.domain.clone(),
            key: self.avatar_key.clone(),
            ..Default::default()
        });
        GroupView {
            group: Some(self.group.clone()),
            kind: if self.channel { "channel".into() } else { "group".into() },
            title: self.title.clone(),
            about: self.about.clone(),
            photo,
            members_count: self.members.len() as u32 + u32::from(!self.owner.is_empty() && !self.members.contains_key(&self.owner)),
            my_role: role as i32,
            perms: Some(GroupPerms {
                send_media: admin || p.send_media,
                send_stickers: admin || p.send_stickers_gifs,
                send_polls: admin || p.send_polls,
                send_links: admin || p.embed_links,
                invite: if admin { r.invite_users } else { p.invite_users },
                pin: if admin { r.pin_messages } else { p.pin_messages },
                change_info: if admin { r.change_info } else { p.change_info },
            }),
            is_public: self.public,
            invite_links: if admin { self.invite_links.clone() } else { vec![] },
            info_json: String::new(),
            version: self.version,
            deleted: self.deleted,
            can_manage_invites: admin && r.invite_users,
            can_decide_requests: admin && r.invite_users,
            can_rotate: admin,
            can_ban: admin && r.ban_users,
            can_add_admins: admin && r.add_admins,
            can_delete_messages: admin && r.delete_messages,
        }
    }

    /// Права композера в группе.
    pub fn capabilities(&self, me: &str, now_ms: i64) -> Capabilities {
        let write = self.can_write(me, now_ms);
        let admin = self.is_admin(me);
        let r = self.rights(me);
        let p = &self.perms;
        let member = matches!(self.role(me), GroupRole::Owner | GroupRole::Admin | GroupRole::Member);
        Capabilities {
            send_text: write,
            send_media: write && (admin || p.send_media),
            send_stickers: write && (admin || p.send_stickers_gifs),
            send_polls: write && (admin || p.send_polls),
            send_links: write && (admin || p.embed_links),
            // «Удалить у всех» чужое — админ с правом удалять; своё сообщение — всегда (решает меню по автору)
            delete_everyone: admin && r.delete_messages,
            pin: if admin { r.pin_messages } else { write && p.pin_messages },
            edit: write,
            react: member,
            forward: true,
            reply: write,
        }
    }
}

/// Личный чат: всё разрешено (HIST-1 п. 4 — «удалить у всех» любое сообщение личного чата).
pub fn direct() -> Capabilities {
    Capabilities {
        send_text: true,
        send_media: true,
        send_stickers: true,
        send_polls: true,
        send_links: true,
        delete_everyone: true,
        pin: true,
        edit: true,
        react: true,
        forward: true,
        reply: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_without_media_right() {
        let mut g = GroupFacts { owner: "o@x".into(), perms: Permissions { send_messages: true, send_stickers_gifs: true, ..Default::default() }, ..Default::default() };
        g.members.insert("m@x".into(), (Role::Member as i32, AdminRights::default(), 0));
        let c = g.capabilities("m@x", 0);
        assert!(c.send_text && !c.send_media && c.send_stickers && !c.delete_everyone);
        let c = g.capabilities("o@x", 0);
        assert!(c.send_media && c.delete_everyone && c.pin);
        let media = Content { kind: Some(content::Kind::Media(Default::default())), ..Default::default() };
        assert!(g.hides("m@x", &media, 0) && !g.hides("o@x", &media, 0) && !g.hides("stranger@x", &media, 0));
    }
}
