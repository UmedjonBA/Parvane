use anyhow::{Context, Result};
use async_nats::Client;
use base64::{engine::general_purpose::{STANDARD, STANDARD_NO_PAD}, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures::StreamExt;
use parvane_types::{
    AckPayload, DeletePayload, DeliveredPayload, EditPayload, GroupActionResponse,
    GroupCreateRequest, GroupCreateResponse, GroupInfo, GroupInfoRequest, GroupKind,
    GroupListRequest, GroupListResponse, GroupMember, GroupMemberRequest, GroupSetRoleRequest, GroupMuteRequest, GroupInviteCreateRequest,
    GroupInviteCreateResponse, GroupJoinRequest, GroupJoinResponse,
    MessageContent,
    ParvaneEvent, PinPayload, ReactPayload, ReadPayload, SendPayload, StoredMessage,
    SyncRequestPayload, SyncResponsePayload, VerifyRequest, VerifyResponse,
    topics::{
        GROUP_ADD_MEMBER, GROUP_BAN, GROUP_CREATE, GROUP_INFO, GROUP_INVITE_CREATE, GROUP_JOIN,
        GROUP_LIST, GROUP_MUTE, GROUP_REMOVE_MEMBER, GROUP_SET_ROLE, GROUP_UNBAN,
        IDENTITY_VERIFY, MSG_ACK, MSG_DELETE, MSG_EDIT, MSG_PIN, MSG_READ, MSG_REACT, MSG_SEND,
        MSG_SYNC_REQUEST, msg_inbox,
    },
};
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};
use uuid::Uuid;

// ── main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .pretty()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("PARVANE_LOG_LEVEL")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    dotenvy::dotenv().ok();

    let nats_url = std::env::var("PARVANE_NATS_URL")
        .unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let db_path = std::env::var("PARVANE_DB_PATH")
        .unwrap_or_else(|_| "./messenger.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url)
        .await
        .context("подключение к SQLite")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("миграции")?;

    info!("SQLite готов: {}", db_path);

    let nc = parvane_types::nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;

    info!("NATS подключён: {}", nats_url);

    let mut send_sub = nc.subscribe(MSG_SEND).await?;
    let mut ack_sub = nc.subscribe(MSG_ACK).await?;
    let mut read_sub = nc.subscribe(MSG_READ).await?;
    let mut edit_sub = nc.subscribe(MSG_EDIT).await?;
    let mut delete_sub = nc.subscribe(MSG_DELETE).await?;
    let mut react_sub = nc.subscribe(MSG_REACT).await?;
    let mut pin_sub = nc.subscribe(MSG_PIN).await?;
    let mut gcreate_sub = nc.subscribe(GROUP_CREATE).await?;
    let mut gadd_sub = nc.subscribe(GROUP_ADD_MEMBER).await?;
    let mut gremove_sub = nc.subscribe(GROUP_REMOVE_MEMBER).await?;
    let mut gsetrole_sub = nc.subscribe(GROUP_SET_ROLE).await?;
    let mut gban_sub = nc.subscribe(GROUP_BAN).await?;
    let mut gunban_sub = nc.subscribe(GROUP_UNBAN).await?;
    let mut gmute_sub = nc.subscribe(GROUP_MUTE).await?;
    let mut ginvite_sub = nc.subscribe(GROUP_INVITE_CREATE).await?;
    let mut gjoin_sub = nc.subscribe(GROUP_JOIN).await?;
    let mut glist_sub = nc.subscribe(GROUP_LIST).await?;
    let mut ginfo_sub = nc.subscribe(GROUP_INFO).await?;
    let mut sync_sub = nc.subscribe(MSG_SYNC_REQUEST).await?;

    info!(
        "Messenger шард запущен. Слушаю: {}, {}, {}, {}, {}, {}",
        MSG_SEND, MSG_ACK, MSG_READ, MSG_EDIT, MSG_DELETE, MSG_SYNC_REQUEST
    );

    loop {
        tokio::select! {
            Some(msg) = send_sub.next() => {
                handle_send(&nc, &pool, msg).await;
            }
            Some(msg) = ack_sub.next() => {
                handle_ack(&nc, &pool, msg).await;
            }
            Some(msg) = read_sub.next() => {
                handle_read(&nc, &pool, msg).await;
            }
            Some(msg) = edit_sub.next() => {
                handle_edit(&nc, &pool, msg).await;
            }
            Some(msg) = delete_sub.next() => {
                handle_delete(&nc, &pool, msg).await;
            }
            Some(msg) = react_sub.next() => {
                handle_react(&nc, &pool, msg).await;
            }
            Some(msg) = pin_sub.next() => {
                handle_pin(&nc, &pool, msg).await;
            }
            Some(msg) = gcreate_sub.next() => {
                handle_group_create(&nc, &pool, msg).await;
            }
            Some(msg) = gadd_sub.next() => {
                handle_group_add(&nc, &pool, msg).await;
            }
            Some(msg) = gremove_sub.next() => {
                handle_group_remove(&nc, &pool, msg).await;
            }
            Some(msg) = gsetrole_sub.next() => {
                handle_group_setrole(&nc, &pool, msg).await;
            }
            Some(msg) = gban_sub.next() => {
                handle_group_ban(&nc, &pool, msg, true).await;
            }
            Some(msg) = gunban_sub.next() => {
                handle_group_ban(&nc, &pool, msg, false).await;
            }
            Some(msg) = gmute_sub.next() => {
                handle_group_mute(&nc, &pool, msg).await;
            }
            Some(msg) = ginvite_sub.next() => {
                handle_group_invite_create(&nc, &pool, msg).await;
            }
            Some(msg) = gjoin_sub.next() => {
                handle_group_join(&nc, &pool, msg).await;
            }
            Some(msg) = glist_sub.next() => {
                handle_group_list(&nc, &pool, msg).await;
            }
            Some(msg) = ginfo_sub.next() => {
                handle_group_info(&nc, &pool, msg).await;
            }
            Some(msg) = sync_sub.next() => {
                handle_sync(&nc, &pool, msg).await;
            }
        }
    }
}

// ── auth helper ───────────────────────────────────────────────────────────────

async fn verify_token(nc: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = nc
        .request(IDENTITY_VERIFY, req.into())
        .await
        .context("запрос к identity")?;
    let resp: VerifyResponse =
        serde_json::from_slice(&reply.payload).context("ответ identity: неверный JSON")?;
    if resp.ok {
        resp.user.ok_or_else(|| anyhow::anyhow!("identity вернул ok без user"))
    } else {
        anyhow::bail!(resp.error.unwrap_or_else(|| "неизвестная ошибка".into()))
    }
}

// ── доменная логика (тестируемая, без NATS) ───────────────────────────────────

/// Проверка от подмены: subject JWT должен совпадать с заявленным `from`.
fn validate_sender(jwt_sub: &str, claimed_from: &str) -> Result<()> {
    if jwt_sub != claimed_from {
        anyhow::bail!("JWT sub '{}' не совпадает с from '{}'", jwt_sub, claimed_from);
    }
    Ok(())
}

/// Сохранить сообщение. Идемпотентно по `id` (INSERT OR IGNORE).
/// `content` хранится как JSON `MessageContent`, `kind` — для фильтрации.
async fn store_message(pool: &SqlitePool, ev: &ParvaneEvent<SendPayload>, now: i64) -> Result<()> {
    let content_json = serde_json::to_string(&ev.payload.content).context("сериализация content")?;
    // legacy-колонка `text` объявлена NOT NULL: для Text кладём сам текст, для
    // медиа — пустую строку (источник истины — `content`).
    let legacy_text = match &ev.payload.content {
        MessageContent::Text { text, .. } => text.as_str(),
        _ => "",
    };
    let reply_to = ev.payload.reply_to.map(|u| u.to_string());
    sqlx::query(
        "INSERT OR IGNORE INTO messages
           (id, from_user, to_user, text, kind, content, ts, created_at, reply_to, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ev.id.to_string())
    .bind(&ev.from)
    .bind(&ev.payload.to)
    .bind(legacy_text)
    .bind(ev.payload.content.kind())
    .bind(&content_json)
    .bind(ev.ts)
    .bind(now)
    .bind(reply_to)
    .bind(now)
    .execute(pool)
    .await
    .context("сохранение сообщения")?;
    Ok(())
}

/// Отредактировать текст своего сообщения. Возвращает `true`, если строка
/// действительно принадлежит автору и была обновлена. Бампает `updated_at`.
async fn edit_message(pool: &SqlitePool, message_id: &str, author: &str, text: &str, now: i64) -> Result<bool> {
    let content_json = serde_json::to_string(&MessageContent::Text { text: text.to_string(), entities: vec![], webpage: None })?;
    let res = sqlx::query(
        "UPDATE messages
            SET text = ?, kind = 'text', content = ?, edited = 1, updated_at = ?
          WHERE id = ? AND from_user = ? AND deleted = 0",
    )
    .bind(text)
    .bind(&content_json)
    .bind(now)
    .bind(message_id)
    .bind(author)
    .execute(pool)
    .await
    .context("правка сообщения")?;
    Ok(res.rows_affected() > 0)
}

fn encrypted_mutation_metadata(content: &MessageContent) -> Option<(&str, &str)> {
    match content {
        MessageContent::Encrypted { ciphertext, sender_signing_key, .. }
        | MessageContent::GroupEncrypted { ciphertext, sender_signing_key, .. }
            if !sender_signing_key.is_empty() => Some((ciphertext, sender_signing_key)),
        _ => None,
    }
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    STANDARD_NO_PAD.decode(value).or_else(|_| STANDARD.decode(value)).ok()
}

fn verify_mutation_signature(signing_key: &str, payload: &str, signature: &str) -> bool {
    let Some(key_bytes) = decode_base64(signing_key).and_then(|bytes| bytes.try_into().ok()) else {
        return false;
    };
    let Some(signature_bytes) = decode_base64(signature) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&signature_bytes) else {
        return false;
    };
    key.verify(payload.as_bytes(), &signature).is_ok()
}

fn authenticated_sync_signing_key(payload: &SyncRequestPayload) -> Option<&str> {
    let signing_key = payload.sender_signing_key.as_deref()?;
    let signature = payload.signature.as_deref()?;
    let signed_payload = format!("sync:{}:{}", payload.last_seen_id, payload.since_updated);
    verify_mutation_signature(signing_key, &signed_payload, signature).then_some(signing_key)
}

async fn replace_message_content(
    pool: &SqlitePool,
    message_id: &str,
    author: &str,
    content: &MessageContent,
    signature: Option<&str>,
    now: i64,
) -> Result<bool> {
    let current: Option<(String, String)> = sqlx::query_as(
        "SELECT from_user, content FROM messages WHERE id = ? AND deleted = 0",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    let Some((stored_author, stored_json)) = current else {
        return Ok(false);
    };

    if stored_author.is_empty() {
        let stored_content: MessageContent = serde_json::from_str(&stored_json)?;
        let Some((_, stored_signing_key)) = encrypted_mutation_metadata(&stored_content) else {
            return Ok(false);
        };
        let Some((ciphertext, new_signing_key)) = encrypted_mutation_metadata(content) else {
            return Ok(false);
        };
        let Some(signature) = signature else {
            return Ok(false);
        };
        let signed_payload = format!("edit:{message_id}:{ciphertext}");
        if new_signing_key != stored_signing_key
            || !verify_mutation_signature(stored_signing_key, &signed_payload, signature)
        {
            return Ok(false);
        }
    } else if stored_author != author {
        return Ok(false);
    }

    let content_json = serde_json::to_string(content)?;
    let res = sqlx::query(
        "UPDATE messages SET text = '', kind = ?, content = ?, edited = 1, updated_at = ?
         WHERE id = ? AND deleted = 0",
    )
    .bind(content.kind())
    .bind(content_json)
    .bind(now)
    .bind(message_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

async fn delete_sealed_message(
    pool: &SqlitePool,
    message_id: &str,
    signature: Option<&str>,
    now: i64,
) -> Result<bool> {
    let content_json: Option<String> = sqlx::query_scalar(
        "SELECT content FROM messages WHERE id = ? AND from_user = ''",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    let Some(content_json) = content_json else {
        return Ok(false);
    };
    let content: MessageContent = serde_json::from_str(&content_json)?;
    let Some((_, signing_key)) = encrypted_mutation_metadata(&content) else {
        return Ok(false);
    };
    let Some(signature) = signature else {
        return Ok(false);
    };
    if !verify_mutation_signature(signing_key, &format!("delete:{message_id}"), signature) {
        return Ok(false);
    }

    let tombstone = match content {
        MessageContent::Encrypted {
            ctype,
            sender_identity,
            sender_signing_key,
            ..
        } => MessageContent::Encrypted {
            ciphertext: String::new(),
            ctype,
            sender_identity,
            sender_signing_key,
        },
        MessageContent::GroupEncrypted {
            group,
            sender_identity,
            sender_signing_key,
            ..
        } => MessageContent::GroupEncrypted {
            ciphertext: String::new(),
            group,
            sender_identity,
            sender_signing_key,
        },
        _ => return Ok(false),
    };
    let tombstone_kind = tombstone.kind();
    let empty = serde_json::to_string(&tombstone)?;
    let res = sqlx::query(
        "UPDATE messages SET deleted = 1, text = '', kind = ?, content = ?, updated_at = ?
         WHERE id = ? AND from_user = ''",
    )
    .bind(tombstone_kind)
    .bind(empty)
    .bind(now)
    .bind(message_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Удалить своё сообщение «у всех» (tombstone). Содержимое затирается.
async fn delete_message(pool: &SqlitePool, message_id: &str, author: &str, now: i64) -> Result<bool> {
    let empty = serde_json::to_string(&MessageContent::Text { text: String::new(), entities: vec![], webpage: None })?;
    let res = sqlx::query(
        "UPDATE messages
            SET deleted = 1, text = '', kind = 'text', content = ?, updated_at = ?
          WHERE id = ? AND from_user = ?",
    )
    .bind(&empty)
    .bind(now)
    .bind(message_id)
    .bind(author)
    .execute(pool)
    .await
    .context("удаление сообщения")?;
    Ok(res.rows_affected() > 0)
}

/// Проверяет, что действие выполняет участник диалога. Для sealed-сообщения
/// публичный `from_user` пуст, поэтому его исходный автор доказывает владение
/// ключом подписью конкретного действия.
async fn can_mutate_message(
    pool: &SqlitePool,
    message_id: &str,
    actor: &str,
    signature: Option<&str>,
    signed_payload: &str,
    requires_group_admin: bool,
) -> Result<bool> {
    let row: Option<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT m.from_user, m.to_user, m.content, m.deleted,
                EXISTS(SELECT 1 FROM groups g WHERE g.id = m.to_user)
           FROM messages m WHERE m.id = ?",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    let Some((from, to, content_json, deleted, is_group)) = row else {
        return Ok(false);
    };
    if deleted != 0 {
        return Ok(false);
    }

    if is_group != 0 {
        let role = member_role(pool, &to, actor).await?;
        return Ok(if requires_group_admin {
            matches!(role.as_deref(), Some("owner") | Some("admin"))
        } else {
            matches!(role.as_deref(), Some("owner") | Some("admin") | Some("member"))
        });
    }

    if actor == to || (!from.is_empty() && actor == from) {
        return Ok(true);
    }
    if !from.is_empty() {
        return Ok(false);
    }

    let content: MessageContent = serde_json::from_str(&content_json)?;
    let Some((_, signing_key)) = encrypted_mutation_metadata(&content) else {
        return Ok(false);
    };
    Ok(signature
        .map(|value| verify_mutation_signature(signing_key, signed_payload, value))
        .unwrap_or(false))
}

/// Поставить/снять реакцию (одна на пару message_id+reactor). Пустой `emoji` —
/// снять свою. Бампает `updated_at` сообщения, чтобы sync отдал новое состояние.
async fn set_reaction(
    pool: &SqlitePool,
    message_id: &str,
    reactor: &str,
    emoji: &str,
    now: i64,
) -> Result<()> {
    if emoji.is_empty() {
        sqlx::query("DELETE FROM reactions WHERE message_id = ? AND reactor = ?")
            .bind(message_id)
            .bind(reactor)
            .execute(pool)
            .await
            .context("снятие реакции")?;
    } else {
        sqlx::query(
            "INSERT INTO reactions (message_id, reactor, emoji, ts) VALUES (?, ?, ?, ?)
             ON CONFLICT(message_id, reactor)
             DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts",
        )
        .bind(message_id)
        .bind(reactor)
        .bind(emoji)
        .bind(now)
        .execute(pool)
        .await
        .context("установка реакции")?;
    }
    sqlx::query("UPDATE messages SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(message_id)
        .execute(pool)
        .await
        .context("бамп updated_at при реакции")?;
    Ok(())
}

/// Закрепить/открепить сообщение. Бампает `updated_at` (курсор синка).
async fn set_pinned(pool: &SqlitePool, message_id: &str, pin: bool, now: i64) -> Result<()> {
    sqlx::query("UPDATE messages SET pinned = ?, updated_at = ? WHERE id = ?")
        .bind(if pin { 1 } else { 0 })
        .bind(now)
        .bind(message_id)
        .execute(pool)
        .await
        .context("закрепление сообщения")?;
    Ok(())
}

// ── группы и каналы ───────────────────────────────────────────────────────────

/// Создать группу/канал: создатель — owner, плюс начальные участники. Возвращает
/// group_id (адрес переписки: сообщения шлют с to_user = group_id).
async fn create_group(
    pool: &SqlitePool,
    name: &str,
    kind: GroupKind,
    creator: &str,
    members: &[String],
    now: i64,
) -> Result<String> {
    let gid = Uuid::now_v7().to_string();
    let kind_str = match kind {
        GroupKind::Channel => "channel",
        GroupKind::Group => "group",
    };
    sqlx::query("INSERT INTO groups (id, name, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&gid)
        .bind(name)
        .bind(kind_str)
        .bind(creator)
        .bind(now)
        .execute(pool)
        .await
        .context("создание группы")?;
    sqlx::query(
        "INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'owner')",
    )
    .bind(&gid)
    .bind(creator)
    .execute(pool)
    .await?;
    for m in members {
        if m == creator {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'member')",
        )
        .bind(&gid)
        .bind(m)
        .execute(pool)
        .await?;
    }
    Ok(gid)
}

/// Роль пользователя в группе (`owner`/`admin`/`member`), None — не участник.
async fn member_role(pool: &SqlitePool, group_id: &str, member: &str) -> Result<Option<String>> {
    let r: Option<(String,)> =
        sqlx::query_as("SELECT role FROM group_members WHERE group_id = ? AND member = ?")
            .bind(group_id)
            .bind(member)
            .fetch_optional(pool)
            .await?;
    Ok(r.map(|(role,)| role))
}

/// Добавить участника (только owner/admin). true — добавлено.
async fn add_group_member(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
) -> Result<bool> {
    let role = member_role(pool, group_id, actor).await?;
    if matches!(
        member_role(pool, group_id, member).await?.as_deref(),
        Some("banned")
    ) {
        return Ok(false); // забанен — сначала разбанить
    }
    if !matches!(role.as_deref(), Some("owner") | Some("admin")) {
        return Ok(false);
    }
    sqlx::query(
        "INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'member')",
    )
    .bind(group_id)
    .bind(member)
    .execute(pool)
    .await?;
    Ok(true)
}

/// Удалить участника (owner/admin, либо сам себя = выйти). owner удалить нельзя.
async fn remove_group_member(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
) -> Result<bool> {
    let actor_role = member_role(pool, group_id, actor).await?;
    let is_self = actor == member;
    let can = is_self || matches!(actor_role.as_deref(), Some("owner") | Some("admin"));
    if !can {
        return Ok(false);
    }
    let res = sqlx::query(
        "DELETE FROM group_members WHERE group_id = ? AND member = ? AND role != 'owner'",
    )
    .bind(group_id)
    .bind(member)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Сменить роль участника на admin/member (только owner; owner-роль не трогаем).
async fn set_group_role(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
    role: &str,
) -> Result<bool> {
    let actor_role = member_role(pool, group_id, actor).await?;
    if !matches!(actor_role.as_deref(), Some("owner")) {
        return Ok(false); // только владелец назначает/снимает админов
    }
    if !matches!(role, "admin" | "member") {
        return Ok(false);
    }
    let res = sqlx::query(
        "UPDATE group_members SET role = ?
         WHERE group_id = ? AND member = ? AND role NOT IN ('owner', 'banned')",
    )
    .bind(role)
    .bind(group_id)
    .bind(member)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Сведения о группе + участники. None — группы нет.
async fn group_info(pool: &SqlitePool, group_id: &str) -> Result<Option<GroupInfo>> {
    let g: Option<(String, String, String)> =
        sqlx::query_as("SELECT name, kind, created_by FROM groups WHERE id = ?")
            .bind(group_id)
            .fetch_optional(pool)
            .await?;
    let Some((name, kind, created_by)) = g else {
        return Ok(None);
    };
    let members: Vec<(String, String)> =
        sqlx::query_as("SELECT member, role FROM group_members WHERE group_id = ? ORDER BY role, member")
            .bind(group_id)
            .fetch_all(pool)
            .await?;
    Ok(Some(GroupInfo {
        group_id: group_id.to_string(),
        name,
        kind: if kind == "channel" { GroupKind::Channel } else { GroupKind::Group },
        created_by,
        members: members
            .into_iter()
            .map(|(address, role)| GroupMember { address, role })
            .collect(),
    }))
}

/// Сведения о группе доступны только её активным участникам. Banned-запись
/// нужна для запрета повторного join, но не даёт читать состав группы.
async fn group_info_for_member(
    pool: &SqlitePool,
    group_id: &str,
    user: &str,
) -> Result<Option<GroupInfo>> {
    if !matches!(
        member_role(pool, group_id, user).await?.as_deref(),
        Some("owner") | Some("admin") | Some("member")
    ) {
        return Ok(None);
    }
    group_info(pool, group_id).await
}

/// Все группы пользователя (со сведениями и участниками).
async fn list_groups(pool: &SqlitePool, user: &str) -> Result<Vec<GroupInfo>> {
    let gids: Vec<(String,)> =
        sqlx::query_as("SELECT group_id FROM group_members WHERE member = ? AND role != 'banned'")
            .bind(user)
            .fetch_all(pool)
            .await?;
    let mut out = Vec::new();
    for (gid,) in gids {
        if let Some(info) = group_info(pool, &gid).await? {
            out.push(info);
        }
    }
    Ok(out)
}

/// Может ли `sender` писать в получателя `to`. Для 1-на-1 — всегда. Для группы —
/// только участник; для канала — только owner/admin. Возвращает Ok(true/false).
async fn can_post(pool: &SqlitePool, to: &str, sender: &str) -> Result<bool> {
    let kind: Option<(String,)> = sqlx::query_as("SELECT kind FROM groups WHERE id = ?")
        .bind(to)
        .fetch_optional(pool)
        .await?;
    let Some((kind,)) = kind else {
        return Ok(true); // не группа → обычный 1-на-1
    };
    let role = member_role(pool, to, sender).await?;
    if matches!(role.as_deref(), Some("banned")) {
        return Ok(false); // забанен — не пишет
    }
    if kind == "channel" {
        return Ok(matches!(role.as_deref(), Some("owner") | Some("admin")));
    }
    if role.is_none() {
        return Ok(false);
    }
    // Мьют: до muted_until писать нельзя (owner немьютим по построению).
    let muted: Option<(i64,)> = sqlx::query_as(
        "SELECT muted_until FROM group_members WHERE group_id = ? AND member = ?",
    )
    .bind(to)
    .bind(sender)
    .fetch_optional(pool)
    .await?;
    Ok(muted.map(|(m,)| m <= now_unix()).unwrap_or(false))
}

/// Зафиксировать прочтение. Идемпотентно по паре (message_id, reader).
async fn store_read_receipt(
    pool: &SqlitePool,
    message_id: &str,
    reader: &str,
    now: i64,
) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO read_receipts (message_id, reader, ts) VALUES (?, ?, ?)")
        .bind(message_id)
        .bind(reader)
        .bind(now)
        .execute(pool)
        .await
        .context("сохранение read receipt")?;
    // Бампаем updated_at сообщения, чтобы отправитель увидел прочтение через
    // курсор синка по мутациям (read-галочка ✓✓).
    sqlx::query("UPDATE messages SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(message_id)
        .execute(pool)
        .await
        .context("бамп updated_at при прочтении")?;
    Ok(())
}

/// Сообщения переписки `user` (как входящие `to_user = user`, так и его
/// собственные исходящие `from_user = user`) с `id` строго больше
/// `last_seen_id`. Без исходящих клиент после перезахода терял свои
/// отправленные сообщения.
/// UUID v7 лексикографически упорядочен по времени, поэтому сравнение строк
/// эквивалентно сравнению по времени создания.
async fn fetch_missed_for_signing_key(
    pool: &SqlitePool,
    user: &str,
    last_seen_id: &str,
    since_updated: i64,
    sender_signing_key: &str,
) -> Result<Vec<StoredMessage>> {
    // Два курсора: новые сообщения (`id > last_seen_id`) И мутации старых
    // (`updated_at > since_updated`: правки, удаления, отметки о прочтении).
    // `read` считается подзапросом: есть ли receipt от получателя (to_user).
    type Row = (
        String,         // id
        String,         // from_user
        String,         // to_user
        Option<String>, // content
        i64,            // ts
        Option<String>, // reply_to
        i64,            // edited
        i64,            // deleted
        i64,            // updated_at
        i64,            // read (0/1)
        i64,            // pinned (0/1)
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT m.id, m.from_user, m.to_user, m.content, m.ts,
                m.reply_to, m.edited, m.deleted, m.updated_at,
                EXISTS(SELECT 1 FROM read_receipts r
                        WHERE r.message_id = m.id AND r.reader = m.to_user) AS read,
                m.pinned
         FROM messages m
         WHERE (m.to_user = ? OR m.from_user = ?
                OR m.to_user IN (SELECT group_id FROM group_members
                                 WHERE member = ? AND role != 'banned')
                OR (? != '' AND COALESCE(json_extract(m.content, '$.sender_signing_key'), '') = ?))
           AND (m.id > ? OR m.updated_at > ?)
         ORDER BY m.updated_at, m.id
         LIMIT 100",
    )
    .bind(user)
    .bind(user)
    .bind(user)
    .bind(sender_signing_key)
    .bind(sender_signing_key)
    .bind(last_seen_id)
    .bind(since_updated)
    .fetch_all(pool)
    .await?;

    let mut messages = Vec::with_capacity(rows.len());
    for (id, from, to, content_json, ts, reply_to, edited, deleted, updated_at, read, pinned) in rows {
        // content может быть NULL только для legacy-строк без миграции данных;
        // в норме всегда заполнен.
        let content = match content_json {
            Some(json) => serde_json::from_str(&json).context("разбор content")?,
            None => MessageContent::Text { text: String::new(), entities: vec![], webpage: None },
        };
        // Агрегат реакций: эмодзи → count, mine = реагировал ли запросивший.
        let reactions = reactions_for(pool, &id, user).await;
        messages.push(StoredMessage {
            id: id.parse().unwrap_or(Uuid::nil()),
            from,
            to,
            content,
            ts,
            reply_to: reply_to.and_then(|s| s.parse().ok()),
            edited: edited != 0,
            deleted: deleted != 0,
            read: read != 0,
            updated_at,
            reactions,
            pinned: pinned != 0,
        });
    }
    Ok(messages)
}

#[cfg(test)]
async fn fetch_missed(
    pool: &SqlitePool,
    user: &str,
    last_seen_id: &str,
    since_updated: i64,
) -> Result<Vec<StoredMessage>> {
    fetch_missed_for_signing_key(pool, user, last_seen_id, since_updated, "").await
}

/// Агрегат реакций сообщения для конкретного зрителя (`mine` — реагировал ли он).
async fn reactions_for(
    pool: &SqlitePool,
    message_id: &str,
    viewer: &str,
) -> Vec<parvane_types::ReactionCount> {
    let react_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT emoji, COUNT(*) FROM reactions WHERE message_id = ? GROUP BY emoji",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let mut out = Vec::new();
    for (emoji, count) in react_rows {
        let mine: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM reactions
                 WHERE message_id = ? AND reactor = ? AND emoji = ?)",
        )
        .bind(message_id)
        .bind(viewer)
        .bind(&emoji)
        .fetch_one(pool)
        .await
        .unwrap_or(0);
        out.push(parvane_types::ReactionCount { emoji, count, mine: mine != 0 });
    }
    out
}

/// Одно сообщение по id с точки зрения `viewer` (для догона из очереди). None —
/// нет такого сообщения.
async fn fetch_one_message(
    pool: &SqlitePool,
    viewer: &str,
    id: &str,
) -> Result<Option<StoredMessage>> {
    let row: Option<(
        String,
        String,
        String,
        Option<String>,
        i64,
        Option<String>,
        i64,
        i64,
        i64,
        i64,
        i64,
    )> = sqlx::query_as(
        "SELECT m.id, m.from_user, m.to_user, m.content, m.ts, m.reply_to,
                m.edited, m.deleted, m.updated_at,
                EXISTS(SELECT 1 FROM read_receipts r
                        WHERE r.message_id = m.id AND r.reader = m.to_user) AS read,
                m.pinned
         FROM messages m WHERE m.id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let Some((id, from, to, content_json, ts, reply_to, edited, deleted, updated_at, read, pinned)) =
        row
    else {
        return Ok(None);
    };
    let content = match content_json {
        Some(json) => serde_json::from_str(&json).context("разбор content")?,
        None => MessageContent::Text { text: String::new(), entities: vec![], webpage: None },
    };
    let reactions = reactions_for(pool, &id, viewer).await;
    Ok(Some(StoredMessage {
        id: id.parse().unwrap_or(Uuid::nil()),
        from,
        to,
        content,
        ts,
        reply_to: reply_to.and_then(|s| s.parse().ok()),
        edited: edited != 0,
        deleted: deleted != 0,
        read: read != 0,
        updated_at,
        reactions,
        pinned: pinned != 0,
    }))
}

/// Получатели сообщения: 1-на-1 → [to]; группа → участники минус отправитель.
async fn resolve_recipients(pool: &SqlitePool, to: &str, from: &str) -> Result<Vec<String>> {
    let is_group: Option<(String,)> = sqlx::query_as("SELECT id FROM groups WHERE id = ?")
        .bind(to)
        .fetch_optional(pool)
        .await?;
    if is_group.is_some() {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT member FROM group_members
             WHERE group_id = ? AND member != ? AND role != 'banned'",
        )
        .bind(to)
        .bind(from)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(|(m,)| m).collect())
    } else {
        Ok(vec![to.to_string()])
    }
}

/// Поставить сообщение в очередь получателя (идемпотентно по паре).
async fn enqueue(pool: &SqlitePool, recipient: &str, message_id: &str, now: i64) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO inbox_queue (recipient, message_id, delivered, queued_at)
         VALUES (?, ?, 0, ?)",
    )
    .bind(recipient)
    .bind(message_id)
    .bind(now)
    .execute(pool)
    .await
    .context("enqueue")?;
    Ok(())
}

/// Снять доставленное по ack получателя (идемпотентно). true — строка была и снята.
async fn ack_delivered(pool: &SqlitePool, recipient: &str, message_id: &str) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE inbox_queue SET delivered = 1
         WHERE recipient = ? AND message_id = ? AND delivered = 0",
    )
    .bind(recipient)
    .bind(message_id)
    .execute(pool)
    .await
    .context("ack")?;
    Ok(res.rows_affected() > 0)
}

/// Неотданные сообщения получателя (по времени постановки).
async fn pending_for(
    pool: &SqlitePool,
    recipient: &str,
    limit: i64,
) -> Result<Vec<StoredMessage>> {
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT message_id FROM inbox_queue
         WHERE recipient = ? AND delivered = 0 ORDER BY queued_at LIMIT ?",
    )
    .bind(recipient)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::new();
    for (id,) in ids {
        if let Some(m) = fetch_one_message(pool, recipient, &id).await? {
            out.push(m);
        }
    }
    Ok(out)
}

/// Разложить сообщение по инбоксам получателей + офлайн-очередь. Для 1-на-1 —
/// один получатель; для группы — все участники. Потеря невозможна: пока нет ack,
/// строка в очереди и заберётся при синке/переотдаче.
async fn deliver_message(
    nc: &Client,
    pool: &SqlitePool,
    stored: &StoredMessage,
    now: i64,
) -> Result<()> {
    let recipients = resolve_recipients(pool, &stored.to, &stored.from).await?;
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from: "messenger".to_string(),
        ts: now,
        token: String::new(),
        payload: parvane_types::InboxPush { message: stored.clone() },
    };
    let bytes = serde_json::to_vec(&ev)?;
    for r in &recipients {
        enqueue(pool, r, &stored.id.to_string(), now).await?;
        nc.publish(msg_inbox(r), bytes.clone().into()).await?;
    }
    Ok(())
}

// ── msg.chat.send ─────────────────────────────────────────────────────────────

async fn handle_send(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<SendPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.send")?;

        // Sealed sender (Фаза 2): пустой `from` — отправитель скрыт от сервера.
        // Аутентификацию уже сделал gateway (только он публикует msg.chat.send),
        // подлинность отправителя получатель проверяет криптографически (Olm).
        // Иначе — обычный путь: верификация токена + антиспуф + право постинга.
        let sealed = event.from.is_empty();
        if !sealed {
            let sender = verify_token(nc, &event.token).await?;
            validate_sender(&sender, &event.from)?;
            if !can_post(pool, &event.payload.to, &sender).await? {
                warn!("Отклонено: {} не может писать в {}", sender, event.payload.to);
                return anyhow::Ok(());
            }
        }

        let now = now_unix();
        store_message(pool, &event, now).await?;
        info!("Сообщение сохранено: {} → {} ({})", event.from, event.payload.to, event.id);

        // Раскладываем по инбоксам получателей + офлайн-очередь (Фаза 1).
        // delivered-статус отправителю придёт, когда получатель подтвердит (ack),
        // а не в момент сохранения — это честная семантика «доставлено».
        let stored = StoredMessage {
            id: event.id,
            from: event.from.clone(),
            to: event.payload.to.clone(),
            content: event.payload.content.clone(),
            ts: event.ts,
            reply_to: event.payload.reply_to,
            edited: false,
            deleted: false,
            read: false,
            updated_at: now,
            reactions: vec![],
            pinned: false,
        };
        deliver_message(nc, pool, &stored, now).await?;
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_send: {}", e);
    }
}

// ── msg.chat.ack ──────────────────────────────────────────────────────────────

async fn handle_ack(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<AckPayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в msg.chat.ack")?;
        let reader = verify_token(nc, &event.token).await?;
        let mid = event.payload.message_id.to_string();
        // Снять из очереди этого получателя; при первом снятии — уведомить
        // отправителя о доставке (delivered-галочка).
        if ack_delivered(pool, &reader, &mid).await? {
            // Sealed sender: у сообщения нет открытого from — получатель, расшифровав,
            // сам указал отправителя. Иначе берём из БД (обычный путь).
            let sender: Option<String> = if !event.payload.sender.is_empty() {
                Some(event.payload.sender.clone())
            } else {
                sqlx::query_as::<_, (String,)>("SELECT from_user FROM messages WHERE id = ?")
                    .bind(&mid)
                    .fetch_optional(pool)
                    .await?
                    .map(|(s,)| s)
                    .filter(|s| !s.is_empty())
            };
            if let Some(sender) = sender {
                let delivered = ParvaneEvent {
                    id: Uuid::now_v7(),
                    from: "messenger".to_string(),
                    ts: now_unix(),
                    token: String::new(),
                    payload: DeliveredPayload { message_id: event.payload.message_id },
                };
                nc.publish(msg_inbox(&sender), serde_json::to_vec(&delivered)?.into())
                    .await?;
            }
            info!("Ack: {} получил {}", reader, mid);
        }
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_ack: {}", e);
    }
}

// ── msg.chat.read ─────────────────────────────────────────────────────────────

async fn handle_read(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<ReadPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.read")?;

        let reader = verify_token(nc, &event.token).await?;
        store_read_receipt(pool, &event.payload.message_id.to_string(), &reader, now_unix()).await?;

        info!("Read receipt: {} прочитал {}", reader, event.payload.message_id);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_read: {}", e);
    }
}

// ── msg.chat.edit ─────────────────────────────────────────────────────────────

async fn handle_edit(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<EditPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.edit")?;
        let author = verify_token(nc, &event.token).await?;
        validate_sender(&author, &event.from)?;

        let message_id = event.payload.message_id.to_string();
        let ok = if let Some(content) = event.payload.content.as_ref() {
            replace_message_content(
                pool,
                &message_id,
                &author,
                content,
                event.payload.signature.as_deref(),
                now_unix(),
            ).await?
        } else if let Some(text) = event.payload.text.as_deref() {
            edit_message(pool, &message_id, &author, text, now_unix()).await?
        } else {
            false
        };
        if ok {
            info!("Сообщение {} отредактировано автором {}", event.payload.message_id, author);
        } else {
            warn!("Правка {} отклонена (не автор или удалено)", event.payload.message_id);
        }
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_edit: {}", e);
    }
}

// ── msg.chat.delete ───────────────────────────────────────────────────────────

async fn handle_delete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<DeletePayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.delete")?;
        let author = verify_token(nc, &event.token).await?;
        validate_sender(&author, &event.from)?;

        let message_id = event.payload.message_id.to_string();
        let ok = delete_message(pool, &message_id, &author, now_unix()).await?
            || delete_sealed_message(
                pool,
                &message_id,
                event.payload.signature.as_deref(),
                now_unix(),
            ).await?;
        if ok {
            info!("Сообщение {} удалено у всех автором {}", event.payload.message_id, author);
        } else {
            warn!("Удаление {} отклонено (не автор)", event.payload.message_id);
        }
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_delete: {}", e);
    }
}

// ── msg.chat.react ────────────────────────────────────────────────────────────

async fn handle_react(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<ReactPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.react")?;
        let reactor = verify_token(nc, &event.token).await?;
        validate_sender(&reactor, &event.from)?;
        let mid = event.payload.message_id.to_string();
        let signed_payload = format!("react:{mid}:{}", event.payload.emoji);
        if !can_mutate_message(
            pool,
            &mid,
            &reactor,
            event.payload.signature.as_deref(),
            &signed_payload,
            false,
        ).await? {
            warn!("Реакция на {} отклонена для {}", mid, reactor);
            return anyhow::Ok(());
        }
        set_reaction(pool, &mid, &reactor, &event.payload.emoji, now_unix()).await?;
        info!("Реакция '{}' на {} от {}", event.payload.emoji, mid, reactor);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_react: {}", e);
    }
}

// ── msg.chat.pin ──────────────────────────────────────────────────────────────

async fn handle_pin(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<PinPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.pin")?;
        let who = verify_token(nc, &event.token).await?;
        validate_sender(&who, &event.from)?;
        let mid = event.payload.message_id.to_string();
        let signed_payload = format!("pin:{mid}:{}", event.payload.pin);
        if !can_mutate_message(
            pool,
            &mid,
            &who,
            event.payload.signature.as_deref(),
            &signed_payload,
            true,
        ).await? {
            warn!("Pin для {} отклонён для {}", mid, who);
            return anyhow::Ok(());
        }
        set_pinned(pool, &mid, event.payload.pin, now_unix()).await?;
        info!("Pin={} для {} ({})", event.payload.pin, mid, who);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_pin: {}", e);
    }
}

// ── группы и каналы (request/reply) ───────────────────────────────────────────

async fn handle_group_create(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupCreateRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.create")?;
        let creator = verify_token(nc, &req.token).await?;
        let gid = create_group(pool, &req.name, req.kind, &creator, &req.members, now_unix()).await?;
        info!("Группа '{}' создана: {} ({})", req.name, gid, creator);
        anyhow::Ok(GroupCreateResponse { ok: true, group_id: Some(gid), error: None })
    }
    .await
    .unwrap_or_else(|e| GroupCreateResponse {
        ok: false,
        group_id: None,
        error: Some(e.to_string()),
    });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_group_add(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupMemberRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.addmember")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = add_group_member(pool, &req.group_id, &actor, &req.member).await?;
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("нет прав или группы".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(e.to_string()) });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_group_remove(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupMemberRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.removemember")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = remove_group_member(pool, &req.group_id, &actor, &req.member).await?;
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("нет прав или owner".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(e.to_string()) });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_group_setrole(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupSetRoleRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.setrole")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = set_group_role(pool, &req.group_id, &actor, &req.member, &req.role).await?;
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("не owner / нельзя".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(e.to_string()) });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

/// Бан/разбан. Только owner/admin; owner небаним. Бан не-участника создаёт
/// banned-запись (не вступит по инвайту). Разбан удаляет banned-запись.
async fn ban_group_member(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
    ban: bool,
) -> Result<bool> {
    let actor_role = member_role(pool, group_id, actor).await?;
    if !matches!(actor_role.as_deref(), Some("owner") | Some("admin")) {
        return Ok(false);
    }
    let target = member_role(pool, group_id, member).await?;
    if matches!(target.as_deref(), Some("owner")) {
        return Ok(false);
    }
    if ban {
        sqlx::query(
            "INSERT INTO group_members (group_id, member, role) VALUES (?, ?, 'banned')
             ON CONFLICT(group_id, member) DO UPDATE SET role = 'banned', muted_until = 0",
        )
        .bind(group_id)
        .bind(member)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            "DELETE FROM group_members WHERE group_id = ? AND member = ? AND role = 'banned'",
        )
        .bind(group_id)
        .bind(member)
        .execute(pool)
        .await?;
    }
    Ok(true)
}

/// Мьют до unix-времени (0 — снять). Только owner/admin; owner немьютим.
async fn mute_group_member(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
    until: i64,
) -> Result<bool> {
    let actor_role = member_role(pool, group_id, actor).await?;
    if !matches!(actor_role.as_deref(), Some("owner") | Some("admin")) {
        return Ok(false);
    }
    let n = sqlx::query(
        "UPDATE group_members SET muted_until = ?
         WHERE group_id = ? AND member = ? AND role NOT IN ('owner', 'banned')",
    )
    .bind(until)
    .bind(group_id)
    .bind(member)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n > 0)
}

async fn handle_group_ban(nc: &Client, pool: &SqlitePool, msg: async_nats::Message, ban: bool) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupMemberRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.ban")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = ban_group_member(pool, &req.group_id, &actor, &req.member, ban).await?;
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("нет прав / нельзя".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(e.to_string()) });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_group_mute(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupMuteRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.mute")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = mute_group_member(pool, &req.group_id, &actor, &req.member, req.until).await?;
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("нет прав / нельзя".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(e.to_string()) });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_group_invite_create(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupInviteCreateRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.invite.create")?;
        let actor = verify_token(nc, &req.token).await?;
        let role = member_role(pool, &req.group_id, &actor).await?;
        if !matches!(role.as_deref(), Some("owner") | Some("admin")) {
            return anyhow::Ok(GroupInviteCreateResponse {
                ok: false,
                invite: None,
                error: Some("нет прав".into()),
            });
        }
        let token = Uuid::now_v7().simple().to_string();
        sqlx::query(
            "INSERT INTO group_invites (token, group_id, created_by, created_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(&token)
        .bind(&req.group_id)
        .bind(&actor)
        .bind(now_unix())
        .execute(pool)
        .await?;
        info!("Инвайт для {} создан ({})", req.group_id, actor);
        anyhow::Ok(GroupInviteCreateResponse { ok: true, invite: Some(token), error: None })
    }
    .await
    .unwrap_or_else(|e| GroupInviteCreateResponse {
        ok: false,
        invite: None,
        error: Some(e.to_string()),
    });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_group_join(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupJoinRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.join")?;
        let user = verify_token(nc, &req.token).await?;
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT group_id FROM group_invites WHERE token = ? AND revoked = 0",
        )
        .bind(&req.invite)
        .fetch_optional(pool)
        .await?;
        let Some((group_id,)) = row else {
            return anyhow::Ok(GroupJoinResponse {
                ok: false,
                group_id: None,
                name: None,
                error: Some("ссылка недействительна".into()),
            });
        };
        if matches!(
            member_role(pool, &group_id, &user).await?.as_deref(),
            Some("banned")
        ) {
            return anyhow::Ok(GroupJoinResponse {
                ok: false,
                group_id: None,
                name: None,
                error: Some("вы забанены в этой группе".into()),
            });
        }
        sqlx::query(
            "INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'member')",
        )
        .bind(&group_id)
        .bind(&user)
        .execute(pool)
        .await?;
        let name: Option<(String,)> = sqlx::query_as("SELECT name FROM groups WHERE id = ?")
            .bind(&group_id)
            .fetch_optional(pool)
            .await?;
        info!("{} вступил в {} по инвайту", user, group_id);
        anyhow::Ok(GroupJoinResponse {
            ok: true,
            group_id: Some(group_id),
            name: name.map(|(n,)| n),
            error: None,
        })
    }
    .await
    .unwrap_or_else(|e| GroupJoinResponse {
        ok: false,
        group_id: None,
        name: None,
        error: Some(e.to_string()),
    });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_group_list(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupListRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.list")?;
        let user = verify_token(nc, &req.token).await?;
        anyhow::Ok(GroupListResponse { groups: list_groups(pool, &user).await? })
    }
    .await
    .unwrap_or_else(|_| GroupListResponse { groups: vec![] });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_group_info(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupInfoRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.info")?;
        let user = verify_token(nc, &req.token).await?;
        let groups = match group_info_for_member(pool, &req.group_id, &user).await? {
            Some(info) => vec![info],
            None => vec![],
        };
        anyhow::Ok(GroupListResponse { groups })
    }
    .await
    .unwrap_or_else(|_| GroupListResponse { groups: vec![] });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// ── msg.sync.request ──────────────────────────────────────────────────────────

async fn handle_sync(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("sync: нет reply-топика, игнорирую");
        return;
    };

    let result = async {
        let event: ParvaneEvent<SyncRequestPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.sync.request")?;

        let user = verify_token(nc, &event.token).await?;
        let last_id = &event.payload.last_seen_id;
        let sender_signing_key = authenticated_sync_signing_key(&event.payload).unwrap_or_default();
        let messages = fetch_missed_for_signing_key(
            pool,
            &user,
            last_id,
            event.payload.since_updated,
            sender_signing_key,
        ).await?;

        let count = messages.len();
        let resp = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: SyncResponsePayload { messages },
        };

        // Ответ ТОЛЬКО в reply-inbox запросившего. Раньше был ещё broadcast в
        // MSG_SYNC_RESPONSE — это утечка: любой на шине читал чужую переписку.
        // reply клонируется: тот же субъект нужен error-ветке ниже.
        let json = serde_json::to_vec(&resp)?;
        nc.publish(reply.clone(), json.into()).await?;

        info!("Sync для {}: {} сообщений после '{}'", user, count, last_id);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_sync: {}", e);
        let _ = nc.publish(reply, b"{}".as_ref().into()).await;
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use parvane_types::{MessageContent, SendPayload};
    use sqlx::sqlite::SqlitePoolOptions;

    /// Текстовое сообщение.
    fn send_event(id: &str, from: &str, to: &str, text: &str) -> ParvaneEvent<SendPayload> {
        send_content(id, from, to, MessageContent::Text { text: text.into(), entities: vec![], webpage: None })
    }

    /// Сообщение с произвольным контентом (для медиа-тестов).
    fn send_content(
        id: &str,
        from: &str,
        to: &str,
        content: MessageContent,
    ) -> ParvaneEvent<SendPayload> {
        ParvaneEvent {
            id: id.parse().unwrap(),
            from: from.into(),
            ts: 1_000_000,
            token: "tok".into(),
            payload: SendPayload { to: to.into(), content, reply_to: None },
        }
    }

    /// Достаёт текст из текстового сообщения (для ассертов).
    fn text_of(m: &StoredMessage) -> &str {
        match &m.content {
            MessageContent::Text { text, .. } => text,
            other => panic!("ожидался Text, получено {:?}", other),
        }
    }

    #[tokio::test]
    async fn ban_blocks_posting_and_membership() {
        let pool = test_pool().await;
        let g1 = create_group(&pool, "Тест", GroupKind::Group, "owner@l",
            &["bob@l".into()], 0).await.unwrap();
        let g1 = g1.as_str();
        assert!(can_post(&pool, g1, "bob@l").await.unwrap());
        // админ не нужен: owner банит
        assert!(ban_group_member(&pool, g1, "owner@l", "bob@l", true).await.unwrap());
        assert!(!can_post(&pool, g1, "bob@l").await.unwrap());
        assert!(list_groups(&pool, "bob@l").await.unwrap().is_empty());
        assert!(group_info_for_member(&pool, g1, "bob@l").await.unwrap().is_none());
        assert!(group_info_for_member(&pool, g1, "mallory@l").await.unwrap().is_none());
        assert!(group_info_for_member(&pool, g1, "owner@l").await.unwrap().is_some());
        assert!(!resolve_recipients(&pool, g1, "owner@l")
            .await
            .unwrap()
            .contains(&"bob@l".to_string()));
        // банённого нельзя добавить обратно add'ом
        assert!(!add_group_member(&pool, g1, "owner@l", "bob@l").await.unwrap());
        // owner небаним, обычный участник банить не может
        assert!(!ban_group_member(&pool, g1, "bob@l", "owner@l", true).await.unwrap());
        assert!(!ban_group_member(&pool, g1, "owner@l", "owner@l", true).await.unwrap());
        // разбан возвращает возможность добавления
        assert!(ban_group_member(&pool, g1, "owner@l", "bob@l", false).await.unwrap());
        assert!(add_group_member(&pool, g1, "owner@l", "bob@l").await.unwrap());
        assert!(can_post(&pool, g1, "bob@l").await.unwrap());
    }

    #[tokio::test]
    async fn mute_blocks_posting_until_deadline() {
        let pool = test_pool().await;
        let g2 = create_group(&pool, "Тест", GroupKind::Group, "owner@l",
            &["bob@l".into()], 0).await.unwrap();
        let g2 = g2.as_str();
        let future = now_unix() + 3600;
        assert!(mute_group_member(&pool, g2, "owner@l", "bob@l", future).await.unwrap());
        assert!(!can_post(&pool, g2, "bob@l").await.unwrap());
        // снятие мьюта (until=0 в прошлом)
        assert!(mute_group_member(&pool, g2, "owner@l", "bob@l", 0).await.unwrap());
        assert!(can_post(&pool, g2, "bob@l").await.unwrap());
        // owner немьютим
        assert!(!mute_group_member(&pool, g2, "owner@l", "owner@l", future).await.unwrap());
    }

    #[tokio::test]
    async fn invite_join_respects_ban() {
        let pool = test_pool().await;
        let g3 = create_group(&pool, "Тест", GroupKind::Group, "owner@l", &[], 0)
            .await
            .unwrap();
        let g3 = g3.as_str();
        sqlx::query(
            "INSERT INTO group_invites (token, group_id, created_by, created_at)
             VALUES ('inv1', ?, 'owner@l', 0)",
        )
        .bind(g3)
        .execute(&pool)
        .await
        .unwrap();
        // banned не вступит по инвайту (проверка как в handle_group_join)
        assert!(ban_group_member(&pool, g3, "owner@l", "eve@l", true).await.unwrap());
        assert!(matches!(
            member_role(&pool, g3, "eve@l").await.unwrap().as_deref(),
            Some("banned")
        ));
        // обычный юзер вступает: имитируем вставку join'а
        sqlx::query(
            "INSERT OR IGNORE INTO group_members (group_id, member, role)
             VALUES (?, 'carol@l', 'member')",
        )
        .bind(g3)
        .execute(&pool)
        .await
        .unwrap();
        assert!(can_post(&pool, g3, "carol@l").await.unwrap());
    }

    /// In-memory SQLite с одной живой connection (иначе каждый коннект — своя
    /// пустая база) и применёнными миграциями.
    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // ── чистая проверка отправителя ──

    #[test]
    fn validate_sender_accepts_match() {
        assert!(validate_sender("alice@local", "alice@local").is_ok());
    }

    #[test]
    fn validate_sender_rejects_spoof() {
        let err = validate_sender("alice@local", "mallory@evil").unwrap_err();
        assert!(err.to_string().contains("не совпадает"));
    }

    // ── хранение и выборка сообщений ──

    #[tokio::test]
    async fn store_and_fetch_message() {
        let pool = test_pool().await;
        let ev = send_event(
            "00000000-0000-7000-8000-000000000001",
            "alice@local",
            "bob@local",
            "привет",
        );
        store_message(&pool, &ev, 1).await.unwrap();

        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(text_of(&missed[0]), "привет");
        assert_eq!(missed[0].from, "alice@local");
    }

    #[tokio::test]
    async fn fetch_missed_filters_by_recipient() {
        let pool = test_pool().await;
        store_message(
            &pool,
            &send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "для боба"),
            1,
        )
        .await
        .unwrap();

        // получатель carol не должен видеть сообщение для bob
        let missed = fetch_missed(&pool, "carol@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(missed.is_empty());
    }

    #[tokio::test]
    async fn fetch_missed_includes_own_sent_messages() {
        // регрессия: после перезахода отправитель должен видеть свои исходящие
        let pool = test_pool().await;
        store_message(
            &pool,
            &send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "моё исходящее"),
            1,
        )
        .await
        .unwrap();

        // alice — отправитель, должна получить своё же сообщение при ресинке
        let missed = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(text_of(&missed[0]), "моё исходящее");
        assert_eq!(missed[0].from, "alice@local");
        assert_eq!(missed[0].to, "bob@local");
    }

    #[tokio::test]
    async fn fetch_missed_respects_last_seen_id() {
        let pool = test_pool().await;
        let older = "00000000-0000-7000-8000-000000000001";
        let newer = "00000000-0000-7000-8000-000000000002";
        store_message(&pool, &send_event(older, "alice@local", "bob@local", "первое"), 1)
            .await
            .unwrap();
        store_message(&pool, &send_event(newer, "alice@local", "bob@local", "второе"), 2)
            .await
            .unwrap();

        // Клиент, уже видевший older, держит оба курсора: last_seen=older и
        // since_updated=updated_at(older)=1. Тогда отдаётся только newer.
        let missed = fetch_missed(&pool, "bob@local", older, 1).await.unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(text_of(&missed[0]), "второе");
    }

    #[tokio::test]
    async fn fetch_missed_picks_up_mutations_past_id_cursor() {
        // Курсор по мутациям ловит правку старого сообщения, даже когда его id
        // ≤ last_seen_id (инкрементальный синк по id такое пропускал).
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-000000000001";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "до правки"), 1)
            .await
            .unwrap();
        // Клиент уже видел это сообщение (id и updated_at=1).
        let none = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
        assert!(none.is_empty());
        // Автор редактирует — updated_at прыгает на 5.
        assert!(edit_message(&pool, mid, "alice@local", "после правки", 5).await.unwrap());
        let missed = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(text_of(&missed[0]), "после правки");
        assert!(missed[0].edited);
    }

    #[tokio::test]
    async fn read_receipt_surfaces_in_sync() {
        // Отправитель видит read=true после receipt получателя (галочка ✓✓).
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000bb";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "прочти меня"), 1)
            .await
            .unwrap();
        // До прочтения — read=false.
        let before = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(before.len(), 1);
        assert!(!before[0].read);
        // Получатель прочитал.
        store_read_receipt(&pool, mid, "bob@local", 7).await.unwrap();
        let after = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(after[0].read, "read-галочка после receipt");
    }

    #[tokio::test]
    async fn delete_message_only_by_author() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000cc";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "секрет"), 1)
            .await
            .unwrap();
        // Чужак не может удалить.
        assert!(!delete_message(&pool, mid, "bob@local", 3).await.unwrap());
        // Автор может.
        assert!(delete_message(&pool, mid, "alice@local", 4).await.unwrap());
        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        assert!(missed[0].deleted);
    }

    #[tokio::test]
    async fn store_message_is_idempotent() {
        let pool = test_pool().await;
        let ev = send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "раз");
        store_message(&pool, &ev, 1).await.unwrap();
        // повторная доставка того же id (даже с другим текстом) не создаёт дубликат
        let dup = send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "два");
        store_message(&pool, &dup, 2).await.unwrap();

        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1, "дубликата быть не должно");
        assert_eq!(text_of(&missed[0]), "раз", "первая запись сохраняется");
    }

    // ── медиа-сообщения ──

    #[tokio::test]
    async fn store_and_fetch_voice_message() {
        let pool = test_pool().await;
        let file_id = uuid::Uuid::now_v7();
        let ev = send_content(
            "00000000-0000-7000-8000-0000000000f1",
            "alice@local",
            "bob@local",
            MessageContent::Voice {
                file_id,
                duration_secs: 5,
                mime: "audio/ogg".into(),
                size_bytes: 4096,
            },
        );
        store_message(&pool, &ev, 1).await.unwrap();

        // kind пишется отдельной колонкой для фильтрации
        let kind: (String,) = sqlx::query_as("SELECT kind FROM messages WHERE id = ?")
            .bind("00000000-0000-7000-8000-0000000000f1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(kind.0, "voice");

        // content десериализуется обратно в тот же вариант
        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        match &missed[0].content {
            MessageContent::Voice { file_id: f, duration_secs, size_bytes, .. } => {
                assert_eq!(*f, file_id);
                assert_eq!(*duration_secs, 5);
                assert_eq!(*size_bytes, 4096);
            }
            other => panic!("ожидался Voice, получено {:?}", other),
        }
    }

    // ── read receipts ──

    #[tokio::test]
    async fn read_receipt_stored_once() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000aa";
        store_read_receipt(&pool, mid, "bob@local", 5).await.unwrap();
        store_read_receipt(&pool, mid, "bob@local", 6).await.unwrap(); // идемпотентно

        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM read_receipts WHERE message_id = ? AND reader = ?")
                .bind(mid)
                .bind("bob@local")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count.0, 1);
    }

    // ── реакции ──

    #[tokio::test]
    async fn reaction_surfaces_in_sync_with_mine_flag() {
        // Реакция видна в синке как агрегат; mine=true только для реагировавшего.
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000d1";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "лайкни"), 1)
            .await
            .unwrap();
        set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();

        // Для bob (реагировал) mine=true.
        let for_bob = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(for_bob[0].reactions.len(), 1);
        assert_eq!(for_bob[0].reactions[0].emoji, "👍");
        assert_eq!(for_bob[0].reactions[0].count, 1);
        assert!(for_bob[0].reactions[0].mine, "bob реагировал → mine");

        // Для alice (не реагировала) mine=false, но count тот же.
        let for_alice = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(for_alice[0].reactions[0].count, 1);
        assert!(!for_alice[0].reactions[0].mine, "alice не реагировала → не mine");
    }

    #[tokio::test]
    async fn reaction_counts_aggregate_across_reactors() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000d2";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "разные реакции"), 1)
            .await
            .unwrap();
        set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();
        set_reaction(&pool, mid, "carol@local", "👍", 3).await.unwrap();
        set_reaction(&pool, mid, "dave@local", "❤️", 4).await.unwrap();

        let missed = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        let thumbs = missed[0].reactions.iter().find(|r| r.emoji == "👍").unwrap();
        let heart = missed[0].reactions.iter().find(|r| r.emoji == "❤️").unwrap();
        assert_eq!(thumbs.count, 2, "две реакции 👍");
        assert_eq!(heart.count, 1, "одна ❤️");
    }

    #[tokio::test]
    async fn reaction_upsert_one_per_reactor() {
        // Одна реакция на пользователя: повторная заменяет прежнюю, не плюсует.
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000d3";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "передумал"), 1)
            .await
            .unwrap();
        set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();
        set_reaction(&pool, mid, "bob@local", "❤️", 3).await.unwrap();

        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed[0].reactions.len(), 1, "у bob ровно одна реакция");
        assert_eq!(missed[0].reactions[0].emoji, "❤️", "последняя побеждает");
    }

    #[tokio::test]
    async fn reaction_empty_emoji_removes() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000d4";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "снять"), 1)
            .await
            .unwrap();
        set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();
        set_reaction(&pool, mid, "bob@local", "", 3).await.unwrap(); // снятие

        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(missed[0].reactions.is_empty(), "реакция снята");
    }

    #[tokio::test]
    async fn reaction_bumps_mutation_cursor() {
        // Реакция на старое сообщение поднимает его в синке по updated_at-курсору.
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000d5";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "старое"), 1)
            .await
            .unwrap();
        // Клиент уже видел это (id и updated_at=1) — синк пуст.
        let none = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
        assert!(none.is_empty());
        // Реакция бампает updated_at на 9.
        set_reaction(&pool, mid, "bob@local", "🔥", 9).await.unwrap();
        let missed = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
        assert_eq!(missed.len(), 1, "мутация-реакция поднялась по курсору");
        assert_eq!(missed[0].reactions[0].emoji, "🔥");
    }

    // ── закрепление ──

    #[tokio::test]
    async fn pin_and_unpin_surfaces_in_sync() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000e1";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "закрепи"), 1)
            .await
            .unwrap();
        // По умолчанию не закреплено.
        let before = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(!before[0].pinned);
        // Закрепляем.
        set_pinned(&pool, mid, true, 2).await.unwrap();
        let pinned = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(pinned[0].pinned, "закреплено");
        // Открепляем.
        set_pinned(&pool, mid, false, 3).await.unwrap();
        let unpinned = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(!unpinned[0].pinned, "откреплено");
    }

    #[tokio::test]
    async fn pin_bumps_mutation_cursor() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000e2";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "старое"), 1)
            .await
            .unwrap();
        let none = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
        assert!(none.is_empty());
        set_pinned(&pool, mid, true, 8).await.unwrap();
        let missed = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
        assert_eq!(missed.len(), 1, "закрепление поднялось по курсору");
        assert!(missed[0].pinned);
    }

    // ── группы и каналы ──

    #[tokio::test]
    async fn create_group_owner_and_members() {
        let pool = test_pool().await;
        let gid = create_group(
            &pool, "Наша группа", GroupKind::Group, "alice@local",
            &["bob@local".into(), "carol@local".into()], 1,
        )
        .await
        .unwrap();
        let info = group_info(&pool, &gid).await.unwrap().unwrap();
        assert_eq!(info.name, "Наша группа");
        assert_eq!(info.created_by, "alice@local");
        assert_eq!(info.members.len(), 3, "owner + 2 участника");
        let owner = info.members.iter().find(|m| m.address == "alice@local").unwrap();
        assert_eq!(owner.role, "owner");
    }

    #[tokio::test]
    async fn group_message_fans_out_to_members_only() {
        // Сообщение в группу видят участники, но не посторонние.
        let pool = test_pool().await;
        let gid = create_group(
            &pool, "g", GroupKind::Group, "alice@local", &["bob@local".into()], 1,
        )
        .await
        .unwrap();
        let mid = "00000000-0000-7000-8000-0000000000a1";
        // сообщение alice → группе (to_user = gid)
        store_message(&pool, &send_event(mid, "alice@local", &gid, "всем привет"), 2)
            .await
            .unwrap();

        // bob (участник) видит
        let for_bob = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(for_bob.len(), 1);
        assert_eq!(for_bob[0].to, gid);
        assert_eq!(text_of(&for_bob[0]), "всем привет");
        // alice (отправитель+участник) видит своё
        let for_alice = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(for_alice.len(), 1);
        // mallory (не участник) не видит
        let for_mallory = fetch_missed(&pool, "mallory@evil", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(for_mallory.is_empty(), "посторонний не видит групповые сообщения");
    }

    #[tokio::test]
    async fn add_and_remove_members_respect_roles() {
        let pool = test_pool().await;
        let gid = create_group(&pool, "g", GroupKind::Group, "alice@local", &[], 1)
            .await
            .unwrap();
        // owner добавляет bob
        assert!(add_group_member(&pool, &gid, "alice@local", "bob@local").await.unwrap());
        // не-участник добавить не может
        assert!(!add_group_member(&pool, &gid, "mallory@evil", "eve@evil").await.unwrap());
        // обычный участник (bob) добавить не может (не owner/admin)
        assert!(!add_group_member(&pool, &gid, "bob@local", "eve@evil").await.unwrap());
        // bob сам выходит
        assert!(remove_group_member(&pool, &gid, "bob@local", "bob@local").await.unwrap());
        // owner нельзя удалить
        assert!(!remove_group_member(&pool, &gid, "alice@local", "alice@local").await.unwrap());
        let info = group_info(&pool, &gid).await.unwrap().unwrap();
        assert_eq!(info.members.len(), 1, "остался только owner");
    }

    #[tokio::test]
    async fn channel_only_admins_post() {
        let pool = test_pool().await;
        let gid = create_group(
            &pool, "Канал", GroupKind::Channel, "alice@local", &["bob@local".into()], 1,
        )
        .await
        .unwrap();
        // owner может писать в канал
        assert!(can_post(&pool, &gid, "alice@local").await.unwrap());
        // обычный подписчик (bob) — не может
        assert!(!can_post(&pool, &gid, "bob@local").await.unwrap());
        // посторонний — не может
        assert!(!can_post(&pool, &gid, "mallory@evil").await.unwrap());
    }

    #[tokio::test]
    async fn group_any_member_posts_1on1_always() {
        let pool = test_pool().await;
        let gid = create_group(
            &pool, "g", GroupKind::Group, "alice@local", &["bob@local".into()], 1,
        )
        .await
        .unwrap();
        assert!(can_post(&pool, &gid, "bob@local").await.unwrap(), "участник группы пишет");
        assert!(!can_post(&pool, &gid, "mallory@evil").await.unwrap(), "не-участник не пишет");
        // 1-на-1 (to = обычный адрес, не группа) — всегда можно
        assert!(can_post(&pool, "bob@local", "alice@local").await.unwrap());
    }

    #[tokio::test]
    async fn group_message_actions_respect_membership_and_admin_roles() {
        let pool = test_pool().await;
        let gid = create_group(
            &pool, "g", GroupKind::Group, "alice@local", &["bob@local".into()], 1,
        )
        .await
        .unwrap();
        let mid = "00000000-0000-7000-8000-0000000000a4";
        store_message(&pool, &send_event(mid, "alice@local", &gid, "group action"), 1)
            .await
            .unwrap();

        assert!(can_mutate_message(&pool, mid, "bob@local", None, "react", false)
            .await
            .unwrap());
        assert!(!can_mutate_message(&pool, mid, "mallory@evil", None, "react", false)
            .await
            .unwrap());
        assert!(!can_mutate_message(&pool, mid, "bob@local", None, "pin", true)
            .await
            .unwrap());
        assert!(can_mutate_message(&pool, mid, "alice@local", None, "pin", true)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn list_groups_returns_users_groups() {
        let pool = test_pool().await;
        let g1 = create_group(&pool, "G1", GroupKind::Group, "alice@local", &["bob@local".into()], 1)
            .await
            .unwrap();
        let _g2 = create_group(&pool, "G2", GroupKind::Group, "carol@local", &[], 1)
            .await
            .unwrap();
        // bob состоит только в G1
        let bobs = list_groups(&pool, "bob@local").await.unwrap();
        assert_eq!(bobs.len(), 1);
        assert_eq!(bobs[0].group_id, g1);
        // carol — только в своей G2
        let carols = list_groups(&pool, "carol@local").await.unwrap();
        assert_eq!(carols.len(), 1);
        assert_eq!(carols[0].name, "G2");
    }

    // ── Фаза 1: доставка, очередь, ack ──

    #[tokio::test]
    async fn resolve_recipients_direct_and_group() {
        let pool = test_pool().await;
        // 1-на-1 → сам адрес
        let r = resolve_recipients(&pool, "bob@local", "alice@local").await.unwrap();
        assert_eq!(r, vec!["bob@local".to_string()]);
        // группа → участники минус отправитель
        let gid = create_group(
            &pool, "g", GroupKind::Group, "alice@local",
            &["bob@local".into(), "carol@local".into()], 1,
        )
        .await
        .unwrap();
        let mut g = resolve_recipients(&pool, &gid, "alice@local").await.unwrap();
        g.sort();
        assert_eq!(g, vec!["bob@local".to_string(), "carol@local".to_string()]);
    }

    #[tokio::test]
    async fn queue_enqueue_ack_pending() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000f7";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "в очередь"), 1)
            .await
            .unwrap();
        enqueue(&pool, "bob@local", mid, 1).await.unwrap();
        enqueue(&pool, "bob@local", mid, 1).await.unwrap(); // идемпотентно
        let pend = pending_for(&pool, "bob@local", 10).await.unwrap();
        assert_eq!(pend.len(), 1);
        assert_eq!(text_of(&pend[0]), "в очередь");
        // ack снимает; повторный ack — no-op
        assert!(ack_delivered(&pool, "bob@local", mid).await.unwrap());
        assert!(!ack_delivered(&pool, "bob@local", mid).await.unwrap());
        assert!(pending_for(&pool, "bob@local", 10).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sealed_message_hides_sender_but_reaches_recipient() {
        // Sealed sender (Фаза 2): from пустой. Получатель видит сообщение (from=""),
        // посторонний — нет, отправитель по from не находит (скрыт).
        let pool = test_pool().await;
        let ev = send_event("00000000-0000-7000-8000-0000000000e5", "", "bob@local", "sealed-ct");
        store_message(&pool, &ev, 1).await.unwrap();

        // получатель bob видит; from скрыт (пустой)
        let for_bob = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(for_bob.len(), 1);
        assert_eq!(for_bob[0].from, "", "отправитель скрыт");
        assert_eq!(for_bob[0].to, "bob@local");

        // посторонний carol не видит
        let for_carol = fetch_missed(&pool, "carol@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(for_carol.is_empty(), "посторонний не видит sealed-сообщение");

        // resolve_recipients с пустым from → [to]
        let r = resolve_recipients(&pool, "bob@local", "").await.unwrap();
        assert_eq!(r, vec!["bob@local".to_string()]);
    }

    #[tokio::test]
    async fn sealed_mutations_require_the_original_signing_key() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000e6";
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let signing_key = STANDARD_NO_PAD.encode(signing.verifying_key().to_bytes());
        let original = MessageContent::Encrypted {
            ciphertext: "cipher-before".into(),
            ctype: 0,
            sender_identity: "curve-key".into(),
            sender_signing_key: signing_key.clone(),
        };
        store_message(&pool, &send_content(mid, "", "bob@local", original), 1)
            .await
            .unwrap();

        let edited = MessageContent::Encrypted {
            ciphertext: "cipher-after".into(),
            ctype: 1,
            sender_identity: "curve-key".into(),
            sender_signing_key: signing_key.clone(),
        };
        assert!(!replace_message_content(&pool, mid, "alice@local", &edited, Some("bad"), 2)
            .await
            .unwrap());
        let edit_payload = format!("edit:{mid}:cipher-after");
        let edit_signature = STANDARD_NO_PAD.encode(signing.sign(edit_payload.as_bytes()).to_bytes());
        assert!(replace_message_content(
            &pool,
            mid,
            "alice@local",
            &edited,
            Some(&edit_signature),
            3,
        )
        .await
        .unwrap());

        let changed = fetch_missed(&pool, "bob@local", mid, 1).await.unwrap();
        assert_eq!(changed.len(), 1);
        assert!(matches!(
            &changed[0].content,
            MessageContent::Encrypted { ciphertext, .. } if ciphertext == "cipher-after"
        ));

        let react_payload = format!("react:{mid}:👍");
        let react_signature = STANDARD_NO_PAD.encode(signing.sign(react_payload.as_bytes()).to_bytes());
        assert!(can_mutate_message(&pool, mid, "bob@local", None, &react_payload, false)
            .await
            .unwrap(), "получатель может реагировать");
        assert!(!can_mutate_message(&pool, mid, "mallory@evil", None, &react_payload, false)
            .await
            .unwrap(), "посторонний не может реагировать");
        assert!(can_mutate_message(
            &pool,
            mid,
            "alice@local",
            Some(&react_signature),
            &react_payload,
            false,
        )
        .await
        .unwrap(), "sealed-автор подтверждает действие подписью");
        assert!(!can_mutate_message(
            &pool,
            mid,
            "alice@local",
            Some("bad"),
            &react_payload,
            false,
        )
        .await
        .unwrap(), "неверная подпись отклоняется");

        let sync_payload = SyncRequestPayload {
            last_seen_id: "0".into(),
            since_updated: 0,
            sender_signing_key: Some(signing_key.clone()),
            signature: None,
        };
        let sync_signed = format!("sync:{}:{}", sync_payload.last_seen_id, sync_payload.since_updated);
        let sync_signature = STANDARD_NO_PAD.encode(signing.sign(sync_signed.as_bytes()).to_bytes());
        let sync_payload = SyncRequestPayload { signature: Some(sync_signature), ..sync_payload };
        let authenticated_key = authenticated_sync_signing_key(&sync_payload).unwrap();
        let for_sender = fetch_missed_for_signing_key(&pool, "alice@local", "0", 0, authenticated_key)
            .await
            .unwrap();
        assert_eq!(for_sender.len(), 1, "sealed-автор получает собственное сообщение по подписанному sync");

        let delete_payload = format!("delete:{mid}");
        let delete_signature = STANDARD_NO_PAD.encode(signing.sign(delete_payload.as_bytes()).to_bytes());
        assert!(delete_sealed_message(&pool, mid, Some(&delete_signature), 4)
            .await
            .unwrap());
        let deleted = fetch_missed(&pool, "bob@local", mid, 3).await.unwrap();
        assert_eq!(deleted.len(), 1);
        assert!(deleted[0].deleted);
        assert!(matches!(
            &deleted[0].content,
            MessageContent::Encrypted { ciphertext, sender_signing_key, .. }
                if ciphertext.is_empty() && sender_signing_key == &signing_key
        ), "sealed tombstone сохраняет ключ авторизации sync");
        let deleted_for_sender = fetch_missed_for_signing_key(
            &pool,
            "alice@local",
            mid,
            3,
            &signing_key,
        )
        .await
        .unwrap();
        assert_eq!(deleted_for_sender.len(), 1);
        assert!(deleted_for_sender[0].deleted, "sealed-автор получает tombstone по sync");
    }

    #[tokio::test]
    async fn fetch_one_message_carries_reactions() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000f8";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "с реакцией"), 1)
            .await
            .unwrap();
        set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();
        let m = fetch_one_message(&pool, "bob@local", mid).await.unwrap().unwrap();
        assert_eq!(text_of(&m), "с реакцией");
        assert_eq!(m.reactions.len(), 1);
        assert!(m.reactions[0].mine, "bob реагировал");
        // несуществующее сообщение → None
        assert!(fetch_one_message(&pool, "bob@local", "00000000-0000-7000-8000-000000000fff")
            .await
            .unwrap()
            .is_none());
    }
}
