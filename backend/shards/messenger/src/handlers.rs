//! Обработчики msg.chat.* и msg.sync.request.

use crate::*;

/// Список прочитавших сообщение с временем прочтения («seen by» в группах,
/// время прочтения в 1-1). Только участнику переписки; автор не исключается —
/// клиент сам отбрасывает себя.
pub(crate) async fn handle_readers(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let event: ParvaneEvent<ReadersPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.readers")?;
        let requester = verify_token(nc, &event.token).await?;
        let mid = event.payload.message_id.to_string();
        // Sealed-автор в БД не виден (from_user пуст) — принимаем подпись
        // sender_signing_key над `readers:<id>` (тот же путь, что у react)
        let signed_payload = format!("readers:{mid}");
        if !is_conversation_participant(pool, &mid, &requester).await?
            && !can_mutate_message(
                pool,
                &mid,
                &requester,
                event.payload.signature.as_deref(),
                &signed_payload,
                false,
            ).await?
        {
            anyhow::bail!("не участник переписки");
        }
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT reader, ts FROM read_receipts WHERE message_id = ? ORDER BY ts")
                .bind(&mid)
                .fetch_all(pool)
                .await
                .context("чтение read receipts")?;
        anyhow::Ok(ReadersResponse {
            ok: true,
            readers: rows
                .into_iter()
                .map(|(address, ts)| ReaderEntry { address, ts })
                .collect(),
            error: None,
        })
    }
    .await
    .unwrap_or_else(|e| {
        warn!("handle_readers: {}", e);
        ReadersResponse { ok: false, readers: vec![], error: Some(parvane_db::public_error(&e)) }
    });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// P-42: адреса участников и id сообщений — только на уровне debug (граф общения
// не должен оседать в info-логах прода).
pub(crate) async fn handle_send(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<SendPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.send")?;

        // Sealed sender (Фаза 2): пустой `from` — отправитель скрыт от сервера.
        // Аутентификацию уже сделал gateway (только он публикует msg.chat.send),
        // подлинность отправителя получатель проверяет криптографически (Olm).
        // Иначе — обычный путь: верификация токена + антиспуф + право постинга.
        let sealed = event.from.is_empty();
        let sender = if !sealed {
            let sender = verify_token(nc, &event.token).await?;
            validate_sender(&sender, &event.from)?;
            if !can_post(pool, &event.payload.to, &sender).await? {
                warn!("Отклонено: {} не может писать в {}", sender, event.payload.to);
                return anyhow::Ok(());
            }
            sender
        } else {
            // P-40: sealed 1-на-1 тоже обязан пройти verify_token. Отправитель
            // скрыт (from=""), но токен принадлежит живой, не отозванной сессии —
            // иначе отозванное устройство слало бы sealed-сообщения до истечения
            // JWT. Identity отклонит отозванный/протухший токен.
            verify_token(nc, &event.token).await?
        };
        // P-10: владение sender_signing_key доказывается подписью send
        if let Err(e) = authenticate_send(&event.payload, &event.id.to_string()) {
            warn!("Отклонено: {} → {} ({}): {}", sender, event.payload.to, event.id, e);
            return anyhow::Ok(());
        }

        let now = now_unix();
        // MSG-04: id вне окна времени (или не v7) ломал бы курсор получателя
        if !message_id_fresh(&event.id, now) {
            warn!("Отклонено: id сообщения вне допустимого окна времени ({})", event.id);
            return anyhow::Ok(());
        }
        store_message_from(pool, &event, now, &sender).await?;
        debug!("Сообщение сохранено: {} → {} ({})", event.from, event.payload.to, event.id);

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
            copies: event.payload.copies.clone(),
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

pub(crate) async fn handle_ack(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<AckPayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в msg.chat.ack")?;
        let reader = verify_token(nc, &event.token).await?;
        let mid = event.payload.message_id.to_string();
        // Снять из очереди этого получателя; при первом снятии — уведомить
        // отправителя о доставке (delivered-галочка).
        if ack_delivered(pool, &reader, &mid).await? {
            // Отправитель берётся ТОЛЬКО из БД (P-05): from_user, а для sealed —
            // sender_user по токену отправителя. Клиентское `payload.sender`
            // не читается: получатель раскрывал бы серверу расшифрованного
            // отправителя и мог подставить произвольный адрес.
            let sender: Option<String> = sqlx::query_as::<_, (String,)>(
                "SELECT CASE WHEN from_user <> '' THEN from_user ELSE sender_user END
                   FROM messages WHERE id = ?",
            )
            .bind(&mid)
            .fetch_optional(pool)
            .await?
            .map(|(s,)| s)
            .filter(|s| !s.is_empty());
            if let Some(sender) = sender {
                let delivered = ParvaneEvent {
                    id: Uuid::now_v7(),
                    from: "messenger".to_string(),
                    ts: now_unix(),
                    token: String::new(),
                    payload: DeliveredPayload { message_id: event.payload.message_id },
                };
                publish_inbox(nc, &sender, serde_json::to_vec(&delivered)?).await?;
            }
            debug!("Ack: {} получил {}", reader, mid);
        }
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_ack: {}", e);
    }
}

// ── msg.chat.read ─────────────────────────────────────────────────────────────

pub(crate) async fn handle_read(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<ReadPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.read")?;

        let reader = verify_token(nc, &event.token).await?;
        let mid = event.payload.message_id.to_string();
        // Только участник переписки может ставить read-receipt на сообщение.
        if !is_conversation_participant(pool, &mid, &reader).await? {
            warn!("Read receipt отклонён: {} не участник переписки {}", reader, mid);
            return anyhow::Ok(());
        }
        store_read_receipt(pool, &mid, &reader, now_unix()).await?;

        // Кросс-девайс: сообщаем ДРУГИМ своим устройствам, что я это прочитал
        // (мгновенно снимут непрочитанное). Офлайн-устройства догонят через sync.
        let notice = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: ReadNotice { read: vec![event.payload.message_id] },
        };
        publish_inbox(nc, &reader, serde_json::to_vec(&notice)?).await?;

        debug!("Read receipt: {} прочитал {}", reader, event.payload.message_id);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_read: {}", e);
    }
}

// ── msg.chat.edit ─────────────────────────────────────────────────────────────

pub(crate) async fn handle_edit(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<EditPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.edit")?;
        let author = verify_token(nc, &event.token).await?;
        validate_sender(&author, &event.from)?;

        let message_id = event.payload.message_id.to_string();
        // MSG-08: правка — тоже публикация в чат: забаненный, замьюченный или
        // лишённый права писать участник не может «переписать» своё старое
        // сообщение группы (получатели расшифруют его прежней Megolm-сессией).
        let chat: Option<(String,)> = sqlx::query_as("SELECT to_user FROM messages WHERE id = ?")
            .bind(&message_id)
            .fetch_optional(pool)
            .await?;
        if let Some((to,)) = chat {
            if !can_post(pool, &to, &author).await? {
                warn!("Правка {} отклонена: {} не может писать в {}", message_id, author, to);
                return anyhow::Ok(());
            }
        }
        let ok = if let Some(content) = event.payload.content.as_ref() {
            replace_message_content(
                pool,
                &message_id,
                &author,
                content,
                event.payload.signature.as_deref(),
                &event.payload.copies,
                now_unix(),
            ).await?
        } else if let Some(text) = event.payload.text.as_deref() {
            edit_message(pool, &message_id, &author, text, now_unix()).await?
        } else {
            false
        };
        if ok {
            debug!("Сообщение {} отредактировано автором {}", event.payload.message_id, author);
            if let Err(e) = push_mutation(nc, pool, &event.payload.message_id.to_string(), now_unix()).await {
                warn!("live-пуш правки {}: {}", event.payload.message_id, e);
            }
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

pub(crate) async fn handle_delete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
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
            ).await?
            || delete_message_as_group_admin(pool, &message_id, &author, now_unix()).await?;
        if ok {
            debug!("Сообщение {} удалено у всех автором {}", event.payload.message_id, author);
            if let Err(e) = push_mutation(nc, pool, &event.payload.message_id.to_string(), now_unix()).await {
                warn!("live-пуш удаления {}: {}", event.payload.message_id, e);
            }
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

pub(crate) async fn handle_react(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<ReactPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.react")?;
        let reactor = verify_token(nc, &event.token).await?;
        validate_sender(&reactor, &event.from)?;
        // MSG-03: реакция — короткая строка
        if event.payload.emoji.len() > MAX_REACTION_BYTES {
            warn!("Реакция отклонена для {}: слишком длинная", reactor);
            return anyhow::Ok(());
        }
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
        debug!("Реакция '{}' на {} от {}", event.payload.emoji, mid, reactor);
        if let Err(e) = push_mutation(nc, pool, &mid, now_unix()).await {
            warn!("live-пуш реакции {}: {}", mid, e);
        }
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_react: {}", e);
    }
}

// ── msg.chat.pin ──────────────────────────────────────────────────────────────

pub(crate) async fn handle_pin(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
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
        debug!("Pin={} для {} ({})", event.payload.pin, mid, who);
        if let Err(e) = push_mutation(nc, pool, &mid, now_unix()).await {
            warn!("live-пуш пина {}: {}", mid, e);
        }
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_pin: {}", e);
    }
}

// ── msg.chat.clear ────────────────────────────────────────────────────────────

pub(crate) async fn handle_setnotify(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<NotifyPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.setnotify")?;
        let user = verify_token(nc, &event.token).await?;
        validate_sender(&user, &event.from)?;
        let json = &event.payload.settings;
        if json.len() > 200_000 {
            anyhow::bail!("настройки уведомлений слишком большие");
        }
        sqlx::query(
            "INSERT INTO user_settings (user, notify_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(user) DO UPDATE SET notify_json = excluded.notify_json,              updated_at = excluded.updated_at",
        )
        .bind(&user)
        .bind(json)
        .bind(now_unix())
        .execute(pool)
        .await?;
        // Другим устройствам этого пользователя — применить те же настройки.
        let notice = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: NotifyNotice { notify: json.clone() },
        };
        publish_inbox(nc, &user, serde_json::to_vec(&notice)?).await?;
        debug!("Настройки уведомлений обновлены: {}", user);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_setnotify: {}", e);
    }
}

pub(crate) async fn handle_clear(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<ClearPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.clear")?;
        let who = verify_token(nc, &event.token).await?;
        validate_sender(&who, &event.from)?;
        let hidden = hide_messages(pool, &who, &event.payload.message_ids, now_unix()).await?;
        debug!("Очистка истории: {} скрыл(а) {} сообщений", who, hidden.len());
        if hidden.is_empty() {
            return anyhow::Ok(());
        }
        // Остальные устройства этого же пользователя: пусть тоже уберут
        // сообщения из локального кэша. В инбокс — ТОЛЬКО автору очистки.
        let ev = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: ClearedNotice { cleared: ClearedIds { message_ids: hidden } },
        };
        publish_inbox(nc, &who, serde_json::to_vec(&ev)?).await?;
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_clear: {}", e);
    }
}

// ── группы и каналы (request/reply) ───────────────────────────────────────────

pub(crate) async fn handle_sync(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
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
        let mut extra_keys = authenticated_extra_signing_keys(&event.payload);
        extra_keys.extend(authenticated_transfer_keys(&event.payload, &user, sender_signing_key));
        let messages = fetch_missed_with_keys(
            pool,
            &user,
            last_id,
            event.payload.since_updated,
            sender_signing_key,
            &event.payload.device_id,
            &extra_keys,
        ).await?;

        let count = messages.len();
        // Кросс-девайс прочитанное: id, которые ЭТОТ пользователь уже прочитал
        // (в т.ч. на другом устройстве) с момента курсора мутаций — офлайн-
        // догон непрочитанного между своими устройствами.
        let read_rows: Vec<(String,)> = sqlx::query_as(
            "SELECT message_id FROM read_receipts WHERE reader = ? AND ts > ?",
        )
        .bind(&user)
        .bind(event.payload.since_updated)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        let read_message_ids: Vec<Uuid> = read_rows
            .iter()
            .filter_map(|(m,)| Uuid::parse_str(m).ok())
            .collect();
        let notify_row: Option<(String,)> = sqlx::query_as(
            "SELECT notify_json FROM user_settings WHERE user = ?",
        )
        .bind(&user)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        let notify_settings = notify_row
            .map(|(j,)| j)
            .filter(|j| !j.is_empty());
        let resp = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: SyncResponsePayload { messages, read_message_ids, notify_settings },
        };

        // Ответ ТОЛЬКО в reply-inbox запросившего. Раньше был ещё broadcast в
        // MSG_SYNC_RESPONSE — это утечка: любой на шине читал чужую переписку.
        // reply клонируется: тот же субъект нужен error-ветке ниже.
        let json = serde_json::to_vec(&resp)?;
        nc.publish(reply.clone(), json.into()).await?;

        debug!("Sync для {}: {} сообщений после '{}'", user, count, last_id);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_sync: {}", e);
        // Ошибку отдаём явно (не пустой страницей): клиент должен отличать
        // «нет новых сообщений» от отказа (отозванное устройство, битый токен).
        let body = serde_json::json!({ "error": parvane_db::public_error(&e) }).to_string();
        let _ = nc.publish(reply, body.into()).await;
    }
}
