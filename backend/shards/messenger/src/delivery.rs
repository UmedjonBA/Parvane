//! Доставка в инбоксы, очередь офлайн-доставки, GC надгробий (P-41).

use crate::*;

/// Публикация в персональный инбокс с валидацией адреса (P-01). Адрес приходит
/// из пользовательского ввода (`to`, `sender`, участники группы) и попадает в
/// NATS-subject; пробел/CRLF/wildcard разорвали бы кадр `PUB` и позволили
/// внедрить публикацию в чужой инбокс. Недопустимый адрес — не публикуем.
pub(crate) async fn publish_inbox(nc: &Client, addr: &str, bytes: Vec<u8>) -> Result<()> {
    if !parvane_types::address::is_valid_route(addr) {
        tracing::warn!("отклонён publish в инбокс: недопустимый адрес");
        return Ok(());
    }
    // Протокол v2 (T046): тот же кадр — в журналы v2-устройств пользователя.
    crate::v2::bridge(addr, &bytes);
    nc.publish(msg_inbox(addr), bytes.into()).await?;
    Ok(())
}

/// Удалить группу с участниками и инвайтами. Только owner.
/// P-41: GC остаточных данных. Tombstone'ы удалённых сообщений нужны для
/// sync других устройств, но не вечно: строки с `deleted = 1` старше
/// `TOMBSTONE_TTL_SECS` удаляются физически (вместе с копиями, receipts,
/// hidden_messages, reactions). Доставленные строки inbox_queue и
/// недоставленные старше TTL вычищаются. Зовётся по расписанию.
pub(crate) const TOMBSTONE_TTL_SECS: i64 = 30 * 86_400;
pub(crate) const QUEUE_TTL_SECS: i64 = 30 * 86_400;

pub(crate) async fn gc_messenger(pool: &SqlitePool, now: i64) -> Result<(u64, u64)> {
    let cutoff = now - TOMBSTONE_TTL_SECS;
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM messages WHERE deleted = 1 AND updated_at < ? LIMIT 5000",
    )
    .bind(cutoff)
    .fetch_all(pool)
    .await?;
    let mut removed = 0u64;
    for (id,) in ids {
        let mut tx = pool.begin().await?;
        for table in ["message_device_copies", "read_receipts", "hidden_messages", "inbox_queue"] {
            let _ = sqlx::query(&format!("DELETE FROM {table} WHERE message_id = ?"))
                .bind(&id)
                .execute(&mut *tx)
                .await;
        }
        let _ = sqlx::query("DELETE FROM reactions WHERE message_id = ?").bind(&id).execute(&mut *tx).await;
        let res = sqlx::query("DELETE FROM messages WHERE id = ? AND deleted = 1")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        removed += res.rows_affected();
    }
    let queue = sqlx::query(
        "DELETE FROM inbox_queue WHERE delivered = 1 OR queued_at < ?",
    )
    .bind(now - QUEUE_TTL_SECS)
    .execute(pool)
    .await?
    .rows_affected();
    Ok((removed, queue))
}

/// Получатели сообщения: 1-на-1 → [to]; группа → участники минус отправитель.
pub(crate) async fn resolve_recipients(pool: &SqlitePool, to: &str, from: &str) -> Result<Vec<String>> {
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
pub(crate) async fn enqueue(pool: &SqlitePool, recipient: &str, message_id: &str, now: i64) -> Result<()> {
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
pub(crate) async fn ack_delivered(pool: &SqlitePool, recipient: &str, message_id: &str) -> Result<bool> {
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
pub(crate) async fn pending_for(
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
pub(crate) async fn deliver_message(
    nc: &Client,
    pool: &SqlitePool,
    stored: &StoredMessage,
    now: i64,
) -> Result<()> {
    let recipients = resolve_recipients(pool, &stored.to, &stored.from).await?;
    for r in &recipients {
        // Sealed sender: у копии «самому себе» адрес пуст — инбокса `msg.user.`
        // не существует (NATS писал Publish Violation), такие цели пропускаем
        if r.is_empty() {
            continue;
        }
        // Мультидевайс: в live-пуш кладём копии ЭТОГО адресата — все его
        // устройства слушают один инбокс и каждое выберет свою по device_id.
        // Self-копии отправителя (recipient='') адресату не отдаются.
        let mut message = stored.clone();
        message.copies = stored
            .copies
            .iter()
            .filter(|copy| copy.recipient == *r)
            .cloned()
            .collect();
        let ev = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now,
            token: String::new(),
            payload: parvane_types::InboxPush { message },
        };
        let bytes = serde_json::to_vec(&ev)?;
        enqueue(pool, r, &stored.id.to_string(), now).await?;
        publish_inbox(nc, r, bytes).await?;
    }
    Ok(())
}

/// Живой пуш мутации (правка/удаление/реакция/пин): всем участникам, включая
/// автора, уезжает актуальная строка сообщения тем же InboxPush, что и при
/// отправке — клиент обрабатывает его как известное сообщение (диф флагов),
/// не дожидаясь delta-синка (до 10 с). Офлайн-очередь не трогаем: кто был
/// офлайн, подтянет мутацию через sync.
pub(crate) async fn push_mutation(nc: &Client, pool: &SqlitePool, message_id: &str, now: i64) -> Result<()> {
    type Row = (String, String, String, Option<String>, i64, Option<String>, i64, i64, i64, i64);
    let Some((id, from, to, content_json, ts, reply_to, edited, deleted, updated_at, pinned)) =
        sqlx::query_as::<_, Row>(
            "SELECT id, from_user, to_user, content, ts, reply_to, edited, deleted, updated_at, pinned
             FROM messages WHERE id = ?",
        )
        .bind(message_id)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(());
    };
    let Some(content_json) = content_json else { return Ok(()) };
    let content: MessageContent = serde_json::from_str(&content_json).context("разбор content")?;
    let copies: Vec<MessageDeviceCopy> = sqlx::query_as::<_, (String, String, String, String, i64)>(
        "SELECT recipient, signing_key, device_id, ciphertext, ctype
         FROM message_device_copies WHERE message_id = ?",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(recipient, signing_key, device_id, ciphertext, ctype)| MessageDeviceCopy {
        recipient,
        signing_key,
        device_id,
        ciphertext,
        ctype: ctype as u32,
    })
    .collect();
    let mut targets = resolve_recipients(pool, &to, &from).await?;
    if !targets.contains(&from) {
        targets.push(from.clone());
    }
    for r in &targets {
        if r.is_empty() {
            continue;
        }
        // Скрывшему «для себя» мутацию не пушим — иначе правка/реакция
        // собеседника воскресила бы очищенное сообщение в его кэше
        if is_hidden_for(pool, &id, r).await? {
            continue;
        }
        let reactions = reactions_for(pool, &id, r).await;
        let stored = StoredMessage {
            id: id.parse().unwrap_or(Uuid::nil()),
            from: from.clone(),
            to: to.clone(),
            content: content.clone(),
            ts,
            reply_to: reply_to.as_deref().and_then(|v| v.parse().ok()),
            edited: edited != 0,
            deleted: deleted != 0,
            read: false,
            updated_at,
            reactions,
            pinned: pinned != 0,
            copies: copies.iter().filter(|copy| copy.recipient == *r).cloned().collect(),
        };
        let ev = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now,
            token: String::new(),
            payload: parvane_types::InboxPush { message: stored },
        };
        publish_inbox(nc, r, serde_json::to_vec(&ev)?).await?;
    }
    Ok(())
}

// ── msg.chat.send ─────────────────────────────────────────────────────────────
