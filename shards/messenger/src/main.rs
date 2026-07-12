use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use parvane_types::{
    AckPayload, DeletePayload, DeliveredPayload, EditPayload, GroupActionResponse,
    GroupCreateRequest, GroupCreateResponse, GroupInfo, GroupInfoRequest, GroupKind,
    GroupListRequest, GroupListResponse, GroupMember, GroupMemberRequest, GroupSetRoleRequest,
    MessageContent,
    ParvaneEvent, PinPayload, ReactPayload, ReadPayload, SendPayload, StoredMessage,
    SyncRequestPayload, SyncResponsePayload, VerifyRequest, VerifyResponse,
    topics::{
        GROUP_ADD_MEMBER, GROUP_CREATE, GROUP_INFO, GROUP_LIST, GROUP_REMOVE_MEMBER, GROUP_SET_ROLE,
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
        "UPDATE group_members SET role = ? WHERE group_id = ? AND member = ? AND role != 'owner'",
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

/// Все группы пользователя (со сведениями и участниками).
async fn list_groups(pool: &SqlitePool, user: &str) -> Result<Vec<GroupInfo>> {
    let gids: Vec<(String,)> =
        sqlx::query_as("SELECT group_id FROM group_members WHERE member = ?")
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
    if kind == "channel" {
        Ok(matches!(role.as_deref(), Some("owner") | Some("admin")))
    } else {
        Ok(role.is_some())
    }
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
async fn fetch_missed(
    pool: &SqlitePool,
    user: &str,
    last_seen_id: &str,
    since_updated: i64,
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
                OR m.to_user IN (SELECT group_id FROM group_members WHERE member = ?))
           AND (m.id > ? OR m.updated_at > ?)
         ORDER BY m.updated_at, m.id
         LIMIT 100",
    )
    .bind(user)
    .bind(user)
    .bind(user)
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
            "SELECT member FROM group_members WHERE group_id = ? AND member != ?",
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

        let ok = edit_message(pool, &event.payload.message_id.to_string(), &author, &event.payload.text, now_unix()).await?;
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

        let ok = delete_message(pool, &event.payload.message_id.to_string(), &author, now_unix()).await?;
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
        let mid = event.payload.message_id.to_string();
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
        let mid = event.payload.message_id.to_string();
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
        let _user = verify_token(nc, &req.token).await?;
        let groups = match group_info(pool, &req.group_id).await? {
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
        let messages = fetch_missed(pool, &user, last_id, event.payload.since_updated).await?;

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
