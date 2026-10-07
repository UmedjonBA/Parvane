//! Хранилище сообщений: запись, копии на устройства, правка/удаление, sync-выборки.

use crate::*;

/// Сохранить сообщение. Идемпотентно по `id` (INSERT OR IGNORE).
/// `content` хранится как JSON `MessageContent`, `kind` — для фильтрации.
#[cfg(test)]
pub(crate) async fn store_message(pool: &SqlitePool, ev: &ParvaneEvent<SendPayload>, now: i64) -> Result<()> {
    store_message_from(pool, ev, now, &ev.from).await
}

/// `sender_user` — владелец по токену сессии (P-10/P-05): для sealed-сообщений
/// `from` пуст, но выборка по signing-ключам в sync и delivered-квитанция
/// опираются на реального владельца, а не на самозаявленные поля.
pub(crate) async fn store_message_from(
    pool: &SqlitePool,
    ev: &ParvaneEvent<SendPayload>,
    now: i64,
    sender_user: &str,
) -> Result<()> {
    let content_json = serde_json::to_string(&ev.payload.content).context("сериализация content")?;
    // legacy-колонка `text` объявлена NOT NULL: для Text кладём сам текст, для
    // медиа — пустую строку (источник истины — `content`).
    let legacy_text = match &ev.payload.content {
        MessageContent::Text { text, .. } => text.as_str(),
        _ => "",
    };
    // P-09: лимит размера шифртекста. Клиентский кадр — до 4 МиБ (gateway),
    // но одно сообщение такого размера раздувает страницу sync выше NATS
    // max_payload и ломает синк получателя навсегда.
    if content_json.len() > MAX_CONTENT_BYTES {
        anyhow::bail!("сообщение больше лимита {} байт", MAX_CONTENT_BYTES);
    }
    // MSG-01: раньше копия сверх лимита пропускалась только при записи в БД, а в
    // доставку (и в журнал v2-устройств получателя) кадр уходил целиком — одно
    // такое сообщение заклинивало синк адресата навсегда. Отказ — всему сообщению.
    if ev.payload.copies.len() > MAX_DEVICE_COPIES {
        anyhow::bail!("слишком много device-копий (максимум {})", MAX_DEVICE_COPIES);
    }
    if ev.payload.copies.iter().any(|c| c.ciphertext.len() > MAX_COPY_BYTES) {
        anyhow::bail!("device-копия больше лимита {} байт", MAX_COPY_BYTES);
    }
    let reply_to = ev.payload.reply_to.map(|u| u.to_string());
    // P-09: повтор чужого/существующего id отклоняем ЦЕЛИКОМ. Раньше
    // INSERT OR IGNORE молча игнорировал вставку, но копии и доставка
    // выполнялись с контентом атакующего под легитимным id.
    let res = sqlx::query(
        "INSERT OR IGNORE INTO messages
           (id, from_user, to_user, text, kind, content, ts, created_at, reply_to, updated_at, sender_user)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(sender_user)
    .execute(pool)
    .await
    .context("сохранение сообщения")?;
    if res.rows_affected() == 0 {
        anyhow::bail!("сообщение с этим id уже существует");
    }
    store_device_copies(pool, &ev.id.to_string(), &ev.payload.copies).await?;
    Ok(())
}

/// Лимит размера сериализованного `content` (шифртекст + метаданные) одного
/// сообщения. Держим существенно ниже NATS max_payload, чтобы страница sync
/// из 100 таких не превысила лимит шины (P-09).
pub(crate) const MAX_CONTENT_BYTES: usize = 256 * 1024;
/// Лимит размера одной per-device копии.
pub(crate) const MAX_COPY_BYTES: usize = 256 * 1024;
/// Байтовый бюджет одной страницы sync: набираем сообщения, пока ответ не
/// приблизился к этому размеру, даже если строк меньше LIMIT (P-09).
pub(crate) const SYNC_PAGE_BYTE_BUDGET: usize = 700 * 1024;

/// Лимит per-device копий на сообщение: устройства одного получателя + свои —
/// десятков достаточно, а мусорный fan-out отсечёт.
pub(crate) const MAX_DEVICE_COPIES: usize = 64;
/// MSG-03: реакция — эмодзи, не произвольная строка (раньше до 4 МиБ попадало
/// в каждую страницу синка участников).
pub(crate) const MAX_REACTION_BYTES: usize = 64;
/// MSG-04: id сообщения задаёт клиент (UUID v7), а курсор синка получателя —
/// максимум увиденных id: id «из будущего» замораживал курсор навсегда.
/// Допустимое окно метки времени в id относительно часов сервера.
pub(crate) const MSG_ID_MAX_PAST_SECS: i64 = 30 * 86_400;
pub(crate) const MSG_ID_MAX_FUTURE_SECS: i64 = 300;

/// MSG-04: id сообщения — UUID v7 с меткой времени в допустимом окне.
pub(crate) fn message_id_fresh(id: &Uuid, now: i64) -> bool {
    if id.get_version_num() != 7 {
        return false;
    }
    let Some(ts) = id.get_timestamp() else { return false };
    let (secs, _) = ts.to_unix();
    let secs = secs as i64;
    secs >= now - MSG_ID_MAX_PAST_SECS && secs <= now + MSG_ID_MAX_FUTURE_SECS
}

/// Сохранить per-device sealed-копии (мультидевайс). Идемпотентно.
pub(crate) async fn store_device_copies(
    pool: &SqlitePool,
    message_id: &str,
    copies: &[MessageDeviceCopy],
) -> Result<()> {
    for copy in copies.iter().take(MAX_DEVICE_COPIES) {
        // P-09: копия сверх лимита размера пропускается (не роняем всё сообщение).
        if copy.ciphertext.len() > MAX_COPY_BYTES {
            warn!("device-копия для {} превышает лимит — пропущена", message_id);
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO message_device_copies
               (message_id, recipient, signing_key, device_id, ciphertext, ctype)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(message_id)
        .bind(&copy.recipient)
        .bind(&copy.signing_key)
        .bind(&copy.device_id)
        .bind(&copy.ciphertext)
        .bind(copy.ctype as i64)
        .execute(pool)
        .await
        .context("сохранение device-копии")?;
    }
    Ok(())
}

/// Снести все per-device копии сообщения (правка заменяет, удаление затирает).
pub(crate) async fn clear_device_copies(pool: &SqlitePool, message_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM message_device_copies WHERE message_id = ?")
        .bind(message_id)
        .execute(pool)
        .await
        .context("очистка device-копий")?;
    Ok(())
}

/// Копия сообщения для устройства запросившего: либо адресована ему как
/// получателю, либо это его собственная self-копия (по signing_key — sealed
/// sender не раскрывает адрес). Возвращает (ciphertext, ctype).
pub(crate) async fn device_copy_for(
    pool: &SqlitePool,
    message_id: &str,
    user: &str,
    signing_key: &str,
    device_id: &str,
) -> Option<(String, i64)> {
    sqlx::query_as(
        "SELECT ciphertext, ctype FROM message_device_copies
         WHERE message_id = ? AND device_id = ?
           AND (recipient = ? OR (? != '' AND signing_key = ?))
         LIMIT 1",
    )
    .bind(message_id)
    .bind(device_id)
    .bind(user)
    .bind(signing_key)
    .bind(signing_key)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

/// Подменить шифртекст sealed-контента копией конкретного устройства.
/// Только Olm-вариант (Encrypted): Megolm-группы шифруются одним блобом на всех.
pub(crate) fn substitute_device_copy(content: &mut MessageContent, copy_ciphertext: String, copy_ctype: i64) {
    if let MessageContent::Encrypted { ciphertext, ctype, .. } = content {
        *ciphertext = copy_ciphertext;
        *ctype = copy_ctype as u32;
    }
}

/// Отредактировать текст своего сообщения. Возвращает `true`, если строка
/// действительно принадлежит автору и была обновлена. Бампает `updated_at`.
pub(crate) async fn edit_message(pool: &SqlitePool, message_id: &str, author: &str, text: &str, now: i64) -> Result<bool> {
    let content_json = serde_json::to_string(&MessageContent::Text { text: text.to_string(), entities: vec![], webpage: None })?;
    let res = sqlx::query(
        "UPDATE messages
            SET text = ?, kind = 'text', content = ?, edited = 1, updated_at = ?
          WHERE id = ? AND from_user = ? AND deleted = 0
            AND kind NOT IN ('encrypted', 'group_encrypted')",
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

pub(crate) async fn replace_message_content(
    pool: &SqlitePool,
    message_id: &str,
    author: &str,
    content: &MessageContent,
    signature: Option<&str>,
    copies: &[MessageDeviceCopy],
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
    let stored_content: MessageContent = serde_json::from_str(&stored_json)?;
    // P-22: E2E-сообщение правится только тем же E2E-видом. Понижение до
    // plaintext (или смена encrypted ↔ group_encrypted) отклоняется — иначе
    // автор/скомпрометированный клиент переводил бы историю в открытый текст
    // на сервере.
    if !matches!(content.kind(), "encrypted" | "group_encrypted")
        || content.kind() != stored_content.kind()
    {
        return Ok(false);
    }

    if stored_author.is_empty() {
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
    if res.rows_affected() > 0 {
        // Мультидевайс: правка заменяет per-device копии целиком — старые
        // шифртексты относятся к прежнему контенту.
        clear_device_copies(pool, message_id).await?;
        store_device_copies(pool, message_id, copies).await?;
    }
    Ok(res.rows_affected() > 0)
}

pub(crate) async fn delete_sealed_message(
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
    if res.rows_affected() > 0 {
        clear_device_copies(pool, message_id).await?;
    }
    Ok(res.rows_affected() > 0)
}

/// Админ группы с правом delete_messages удаляет чужое сообщение группы «у всех»
/// (spec 003). Автор-путь и подпись не нужны: право проверяется по составу.
pub(crate) async fn delete_message_as_group_admin(
    pool: &SqlitePool,
    message_id: &str,
    actor: &str,
    now: i64,
) -> Result<bool> {
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT m.to_user, m.content, m.deleted FROM messages m
          WHERE m.id = ? AND EXISTS(SELECT 1 FROM groups g WHERE g.id = m.to_user)",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    let Some((group_id, content_json, deleted)) = row else {
        return Ok(false);
    };
    if deleted != 0 {
        return Ok(false);
    }
    if !group_mgmt::has_group_right(pool, &group_id, actor, group_mgmt::GroupRight::DeleteMessages, false).await? {
        return Ok(false);
    }
    let content: MessageContent = serde_json::from_str(&content_json)?;
    let tombstone = match content {
        MessageContent::GroupEncrypted { group, sender_identity, sender_signing_key, .. } => {
            MessageContent::GroupEncrypted { ciphertext: String::new(), group, sender_identity, sender_signing_key }
        }
        MessageContent::Encrypted { ctype, sender_identity, sender_signing_key, .. } => {
            MessageContent::Encrypted { ciphertext: String::new(), ctype, sender_identity, sender_signing_key }
        }
        _ => MessageContent::Text { text: String::new(), entities: vec![], webpage: None },
    };
    let kind = tombstone.kind();
    let empty = serde_json::to_string(&tombstone)?;
    let res = sqlx::query(
        "UPDATE messages SET deleted = 1, text = '', kind = ?, content = ?, updated_at = ? WHERE id = ?",
    )
    .bind(kind)
    .bind(empty)
    .bind(now)
    .bind(message_id)
    .execute(pool)
    .await?;
    if res.rows_affected() > 0 {
        clear_device_copies(pool, message_id).await?;
    }
    Ok(res.rows_affected() > 0)
}

/// Удалить своё сообщение «у всех» (tombstone). Содержимое затирается.
pub(crate) async fn delete_message(pool: &SqlitePool, message_id: &str, author: &str, now: i64) -> Result<bool> {
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
    if res.rows_affected() > 0 {
        clear_device_copies(pool, message_id).await?;
    }
    Ok(res.rows_affected() > 0)
}

/// Проверяет, что действие выполняет участник диалога. Для sealed-сообщения
/// публичный `from_user` пуст, поэтому его исходный автор доказывает владение
/// ключом подписью конкретного действия.
pub(crate) async fn can_mutate_message(
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
        // requires_group_admin = закреп: владелец, админ с pin_messages,
        // участник — если pin_messages включён в правах по умолчанию (spec 003).
        if requires_group_admin {
            return group_mgmt::has_group_right(pool, &to, actor, group_mgmt::GroupRight::PinMessages, true).await;
        }
        let role = member_role(pool, &to, actor).await?;
        return Ok(matches!(role.as_deref(), Some("owner") | Some("admin") | Some("member")));
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
pub(crate) async fn set_reaction(
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
pub(crate) async fn set_pinned(pool: &SqlitePool, message_id: &str, pin: bool, now: i64) -> Result<()> {
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

/// Может ли `sender` писать в получателя `to`. Для 1-на-1 — всегда. Для группы —
/// только участник; для канала — только owner/admin. Возвращает Ok(true/false).
pub(crate) async fn can_post(pool: &SqlitePool, to: &str, sender: &str) -> Result<bool> {
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
    // Права по умолчанию (spec 003): участник без send_messages не пишет;
    // владелец и админы им не подчиняются.
    if matches!(role.as_deref(), Some("member"))
        && !group_mgmt::load_default_perms(pool, to).await?.send_messages
    {
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

/// Участвует ли `reader` в переписке сообщения `message_id`: для 1-1 — один из
/// двух собеседников (для sealed из БД известен только получатель `to_user`);
/// для группы — активный (не забаненный) участник. По аналогии с
/// `can_mutate_message`. Используется, чтобы посторонний не мог ставить
/// read-receipt на чужое сообщение (утечка факта существования + ложная галочка).
pub(crate) async fn is_conversation_participant(
    pool: &SqlitePool,
    message_id: &str,
    reader: &str,
) -> Result<bool> {
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT m.from_user, m.to_user,
                EXISTS(SELECT 1 FROM groups g WHERE g.id = m.to_user)
           FROM messages m WHERE m.id = ?",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    let Some((from, to, is_group)) = row else {
        return Ok(false);
    };
    if is_group != 0 {
        let role = member_role(pool, &to, reader).await?;
        return Ok(matches!(role.as_deref(), Some(r) if r != "banned"));
    }
    // 1-1: получатель (`to_user`) или явный отправитель. Sealed-отправитель в БД
    // пуст и через этот путь read-receipt не ставит (он и так автор).
    Ok(reader == to || (!from.is_empty() && reader == from))
}

// ── msg.chat.readers ──────────────────────────────────────────────────────────

pub(crate) async fn store_read_receipt(
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
pub(crate) async fn fetch_missed_for_signing_key(
    pool: &SqlitePool,
    user: &str,
    last_seen_id: &str,
    since_updated: i64,
    sender_signing_key: &str,
    device_id: &str,
) -> Result<Vec<StoredMessage>> {
    fetch_missed_with_keys(pool, user, last_seen_id, since_updated, sender_signing_key, device_id, &[])
        .await
}

/// Как `fetch_missed_for_signing_key`, но с дополнительными ДОКАЗАННЫМИ
/// signing-ключами (авто-линковка: sealed-исходящие прежних устройств,
/// чьё состояние перенесено на запрашивающее).
pub(crate) async fn fetch_missed_with_keys(
    pool: &SqlitePool,
    user: &str,
    last_seen_id: &str,
    since_updated: i64,
    sender_signing_key: &str,
    device_id: &str,
    extra_signing_keys: &[String],
) -> Result<Vec<StoredMessage>> {
    // Все доказанные ключи одним JSON-массивом для IN (json_each): '' не кладём,
    // чтобы сообщения без sender_signing_key не совпали с пустым значением
    let mut proven_keys: Vec<&str> = Vec::with_capacity(1 + extra_signing_keys.len());
    if !sender_signing_key.is_empty() {
        proven_keys.push(sender_signing_key);
    }
    proven_keys.extend(extra_signing_keys.iter().map(String::as_str).filter(|key| !key.is_empty()));
    let keys_json = serde_json::to_string(&proven_keys).unwrap_or_else(|_| "[]".into());
    // Два курсора: новые сообщения (по `rowid` — монотонному порядку ВСТАВКИ,
    // а не по строковому id) И мутации старых (`updated_at > since_updated`:
    // правки, удаления, отметки о прочтении). rowid берём по last_seen_id:
    // строковое сравнение id ломалось на всплеске (два id в одну мс различаются
    // только рандом-битами → курсор перепрыгивал сообщение с меньшим id).
    // last_seen_id клиента = максимальный УВИДЕННЫЙ id; при v7-id он совпадает
    // с максимальным rowid, так что маппинг id→rowid корректен без правки клиента.
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
    // `read` контекстно-зависим от запрашивающего: в группе to_user = group_id,
    // receipt же пишется от адреса участника — старое сравнение с to_user
    // делало групповые сообщения вечно непрочитанными. Для входящих групповых
    // read = мой собственный receipt; для своих исходящих (✓✓) — receipt
    // любого другого участника; 1-1 — как раньше (receipt получателя).
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT m.id, m.from_user, m.to_user, m.content, m.ts,
                m.reply_to, m.edited, m.deleted, m.updated_at,
                CASE
                  WHEN m.to_user IN (SELECT id FROM groups) THEN
                    CASE WHEN m.from_user = ? THEN
                      EXISTS(SELECT 1 FROM read_receipts r
                              WHERE r.message_id = m.id AND r.reader <> ?)
                    ELSE
                      EXISTS(SELECT 1 FROM read_receipts r
                              WHERE r.message_id = m.id AND r.reader = ?)
                    END
                  ELSE
                    EXISTS(SELECT 1 FROM read_receipts r
                            WHERE r.message_id = m.id AND r.reader = m.to_user)
                END AS read,
                m.pinned
         FROM messages m
         WHERE (m.to_user = ? OR m.from_user = ?
                OR m.to_user IN (SELECT group_id FROM group_members
                                 WHERE member = ? AND role != 'banned')
                OR ((m.sender_user = ? OR m.sender_user = '')
                    AND COALESCE(json_extract(m.content, '$.sender_signing_key'), '')
                        IN (SELECT value FROM json_each(?)))
                OR ((m.sender_user = ? OR m.sender_user = '')
                    AND EXISTS(SELECT 1 FROM message_device_copies c
                                WHERE c.message_id = m.id
                                  AND c.signing_key IN (SELECT value FROM json_each(?)))))
           AND (m.rowid > COALESCE((SELECT rowid FROM messages WHERE id = ?), 0)
                OR m.updated_at > ?)
           AND NOT EXISTS(SELECT 1 FROM hidden_messages h
                           WHERE h.message_id = m.id AND h.user = ?)
         ORDER BY m.rowid
         LIMIT 100",
    )
    .bind(user)
    .bind(user)
    .bind(user)
    .bind(user)
    .bind(user)
    .bind(user)
    // P-10: выборка по ключам только среди сообщений этого же владельца
    // (sender_user по токену); '' — строки до миграции 0012
    .bind(user)
    .bind(&keys_json)
    .bind(user)
    .bind(&keys_json)
    .bind(last_seen_id)
    .bind(since_updated)
    .bind(user)
    .fetch_all(pool)
    .await?;

    let mut messages = Vec::with_capacity(rows.len());
    let mut budget_used: usize = 0;
    for (id, from, to, content_json, ts, reply_to, edited, deleted, updated_at, read, pinned) in rows {
        // P-09: байтовый бюджет страницы. Даже при LIMIT 100 суммарный размер
        // ответа не должен превысить NATS max_payload; лишнее уедет следующим
        // sync (курсор по rowid, порядок сохранён). Хотя бы одно сообщение
        // отдаём всегда (иначе крупное сообщение заклинит синк).
        // content может быть NULL только для legacy-строк без миграции данных;
        // в норме всегда заполнен.
        let mut content = match content_json {
            Some(json) => serde_json::from_str(&json).context("разбор content")?,
            None => MessageContent::Text { text: String::new(), entities: vec![], webpage: None },
        };
        // Мультидевайс: у sealed-сообщения основной шифртекст адресован
        // «primary»-устройству; для остальных подменяем копией запросившего.
        if matches!(content, MessageContent::Encrypted { .. }) && deleted == 0 {
            if let Some((copy_ciphertext, copy_ctype)) =
                device_copy_for(pool, &id, user, sender_signing_key, device_id).await
            {
                substitute_device_copy(&mut content, copy_ciphertext, copy_ctype);
            }
        }
        // Агрегат реакций: эмодзи → count, mine = реагировал ли запросивший.
        let reactions = reactions_for(pool, &id, user).await;
        // MSG-02/MSG-03: бюджет считается по ИТОГОВОЙ строке — после подмены
        // копией устройства (до 256 КиБ вместо сотен байт основного шифртекста)
        // и с реакциями; иначе страница вылезала за max_payload NATS и синк
        // получателя не двигался.
        let row_bytes = serde_json::to_vec(&content).map(|v| v.len()).unwrap_or(0)
            + reactions.iter().map(|r| r.emoji.len() + 24).sum::<usize>();
        if !messages.is_empty() && budget_used + row_bytes > SYNC_PAGE_BYTE_BUDGET {
            break;
        }
        budget_used += row_bytes;
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
            copies: vec![],
        });
    }
    Ok(messages)
}

#[cfg(test)]
pub(crate) async fn fetch_missed(
    pool: &SqlitePool,
    user: &str,
    last_seen_id: &str,
    since_updated: i64,
) -> Result<Vec<StoredMessage>> {
    fetch_missed_for_signing_key(pool, user, last_seen_id, since_updated, "", "").await
}

/// Агрегат реакций сообщения для конкретного зрителя (`mine` — реагировал ли он).
pub(crate) async fn reactions_for(
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
pub(crate) async fn fetch_one_message(
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
                CASE
                  WHEN m.to_user IN (SELECT id FROM groups) THEN
                    CASE WHEN m.from_user = ? THEN
                      EXISTS(SELECT 1 FROM read_receipts r
                              WHERE r.message_id = m.id AND r.reader <> ?)
                    ELSE
                      EXISTS(SELECT 1 FROM read_receipts r
                              WHERE r.message_id = m.id AND r.reader = ?)
                    END
                  ELSE
                    EXISTS(SELECT 1 FROM read_receipts r
                            WHERE r.message_id = m.id AND r.reader = m.to_user)
                END AS read,
                m.pinned
         FROM messages m WHERE m.id = ?",
    )
    .bind(viewer)
    .bind(viewer)
    .bind(viewer)
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
        copies: vec![],
    }))
}

/// Скрыть сообщения «для меня»: строка (user, message_id) исключает сообщение
/// из выдачи sync запросившему. Права не проверяются: скрыть от себя можно
/// что угодно (чужое/несуществующее id — безвредно), остальные участники
/// продолжают видеть сообщение. Возвращает число реально скрытых id.
pub(crate) async fn hide_messages(pool: &SqlitePool, user: &str, ids: &[Uuid], now: i64) -> Result<Vec<Uuid>> {
    let mut hidden = Vec::with_capacity(ids.len());
    for id in ids.iter().take(parvane_types::CLEAR_MAX_IDS) {
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO hidden_messages (user, message_id, hidden_at) VALUES (?, ?, ?)",
        )
        .bind(user)
        .bind(id.to_string())
        .bind(now)
        .execute(pool)
        .await?
        .rows_affected();
        if inserted > 0 {
            hidden.push(*id);
        }
    }
    Ok(hidden)
}

pub(crate) async fn is_hidden_for(pool: &SqlitePool, message_id: &str, user: &str) -> Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM hidden_messages WHERE message_id = ? AND user = ?",
    )
    .bind(message_id)
    .bind(user)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}
