//! Линковка устройств v2: оффер с commitment, challenge, poll, grant (P-03/P-48).

use crate::*;

/// Время жизни оффера/гранта; просроченные чистятся при каждом обращении.
pub(crate) const LINK_TTL_SECS: i64 = 900;
/// Кап полей против злоупотребления хранилищем (base64-строки).
pub(crate) const LINK_EPH_PUB_MAX: usize = 512;
pub(crate) const LINK_BOX_MAX: usize = 8192;

pub(crate) async fn purge_stale_links(pool: &SqlitePool) -> Result<()> {
    let cutoff = now_unix() - LINK_TTL_SECS;
    sqlx::query("DELETE FROM link_offers WHERE created_at < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM link_grants WHERE created_at < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(())
}

/// Оффер линковки. v2 (P-03): сначала публикуется ТОЛЬКО commitment
/// (SHA-256 эфемерного ключа), ключ раскрывается тем же обработчиком после
/// challenge старого устройства; сервер сверяет раскрытие с обязательством.
/// Legacy-клиент шлёт eph_pub без commitment — принимаем как раньше.
pub(crate) async fn store_link_offer(
    pool: &SqlitePool,
    username: &str,
    device_id: &str,
    eph_pub: &str,
    commitment: &str,
    signing_key: &str,
    revoke: bool,
) -> Result<()> {
    // Отзыв собственного оффера (история получена другим путём): чужие
    // устройства перестают видеть запрос. Legacy: пустой eph_pub без commitment.
    if revoke || (eph_pub.is_empty() && commitment.is_empty()) {
        sqlx::query("DELETE FROM link_offers WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(device_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM link_grants WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(device_id)
            .execute(pool)
            .await?;
        return Ok(());
    }
    if eph_pub.len() > LINK_EPH_PUB_MAX || commitment.len() > LINK_EPH_PUB_MAX || signing_key.len() > LINK_EPH_PUB_MAX {
        anyhow::bail!("некорректный эфемерный ключ");
    }
    purge_stale_links(pool).await?;
    if !commitment.is_empty() {
        // Раскрытие: ключ обязан соответствовать обязательству.
        if !eph_pub.is_empty() && !link_commitment_matches(eph_pub, commitment) {
            anyhow::bail!("раскрытый ключ не соответствует обязательству");
        }
        // Тот же оффер (то же обязательство) — обновляем ключ, сохраняя challenge.
        let updated = sqlx::query(
            "UPDATE link_offers SET eph_pub = ?, signing_key = CASE WHEN ? = '' THEN signing_key ELSE ? END
              WHERE username = ? AND device_id = ? AND commitment = ?",
        )
        .bind(eph_pub)
        .bind(signing_key)
        .bind(signing_key)
        .bind(username)
        .bind(device_id)
        .bind(commitment)
        .execute(pool)
        .await?
        .rows_affected();
        if updated > 0 {
            return Ok(());
        }
    }
    // Новый оффер устройства заменяет прежний (и гасит старый грант — он
    // зашифрован на уже потерянный эфемерный ключ).
    sqlx::query(
        "INSERT OR REPLACE INTO link_offers (username, device_id, eph_pub, created_at, commitment, challenge_pub, signing_key)
         VALUES (?, ?, ?, ?, ?, '', ?)",
    )
    .bind(username)
    .bind(device_id)
    .bind(eph_pub)
    .bind(now_unix())
    .bind(commitment)
    .bind(signing_key)
    .execute(pool)
    .await?;
    sqlx::query("DELETE FROM link_grants WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// SHA-256(raw eph_pub) == commitment (обе строки base64).
pub(crate) fn link_commitment_matches(eph_pub_b64: &str, commitment_b64: &str) -> bool {
    let Some(raw) = B64.decode(eph_pub_b64).ok() else { return false };
    let Some(want) = B64.decode(commitment_b64).ok() else { return false };
    Sha256::digest(&raw).as_slice() == want.as_slice()
}

/// v2: challenge старого устройства к офферу целевого. Первый challenge
/// фиксируется; замена другим ключом невозможна (иначе сервер/третий подменил
/// бы сторону, с которой считается SAS).
pub(crate) async fn store_link_challenge(
    pool: &SqlitePool,
    username: &str,
    target_device: &str,
    eph_pub: &str,
) -> Result<()> {
    if eph_pub.is_empty() || eph_pub.len() > LINK_EPH_PUB_MAX {
        anyhow::bail!("некорректный эфемерный ключ");
    }
    purge_stale_links(pool).await?;
    let updated = sqlx::query(
        "UPDATE link_offers SET challenge_pub = ?
          WHERE username = ? AND device_id = ? AND (challenge_pub = '' OR challenge_pub = ?)",
    )
    .bind(eph_pub)
    .bind(username)
    .bind(target_device)
    .bind(eph_pub)
    .execute(pool)
    .await?
    .rows_affected();
    if updated == 0 {
        anyhow::bail!("оффер линковки не найден, истёк или уже имеет challenge");
    }
    Ok(())
}

/// Офферы ДРУГИХ устройств аккаунта + одноразовый грант для запрашивающего
/// (удаляется при выдаче: клиент, упавший до импорта, просто переофферит).
pub(crate) async fn poll_link(
    pool: &SqlitePool,
    username: &str,
    device_id: &str,
) -> Result<(Vec<LinkOfferInfo>, Option<LinkGrantInfo>, Option<String>)> {
    purge_stale_links(pool).await?;
    let offers: Vec<(String, String, i64, String, String, String)> = sqlx::query_as(
        "SELECT device_id, eph_pub, created_at, commitment, signing_key, challenge_pub FROM link_offers
          WHERE username = ? AND device_id != ? ORDER BY created_at",
    )
    .bind(username)
    .bind(device_id)
    .fetch_all(pool)
    .await?;
    // v2: challenge к СОБСТВЕННОМУ офферу запрашивающего (сигнал раскрыть ключ).
    let challenge: Option<(String,)> = sqlx::query_as(
        "SELECT challenge_pub FROM link_offers WHERE username = ? AND device_id = ? AND challenge_pub != ''",
    )
    .bind(username)
    .bind(device_id)
    .fetch_optional(pool)
    .await?;
    let grant: Option<(String, String)> = sqlx::query_as(
        "DELETE FROM link_grants WHERE username = ? AND device_id = ?
         RETURNING box, eph_pub",
    )
    .bind(username)
    .bind(device_id)
    .fetch_optional(pool)
    .await?;
    Ok((
        offers
            .into_iter()
            .map(|(device_id, eph_pub, created_at, commitment, signing_key, challenge_pub)| LinkOfferInfo {
                device_id, eph_pub, created_at, commitment, signing_key, challenge_pub,
            })
            .collect(),
        grant.map(|(box_payload, eph_pub)| LinkGrantInfo { box_payload, eph_pub }),
        challenge.map(|(c,)| c),
    ))
}

/// Грант принимается только под живой оффер целевого устройства (иначе это
/// мусор в пустоту); оффер при этом гасится — линковка одноразовая.
pub(crate) async fn store_link_grant(
    pool: &SqlitePool,
    username: &str,
    target_device: &str,
    box_payload: &str,
    eph_pub: &str,
) -> Result<()> {
    if box_payload.is_empty() || box_payload.len() > LINK_BOX_MAX {
        anyhow::bail!("некорректный бокс");
    }
    if eph_pub.is_empty() || eph_pub.len() > LINK_EPH_PUB_MAX {
        anyhow::bail!("некорректный эфемерный ключ");
    }
    purge_stale_links(pool).await?;
    let removed = sqlx::query("DELETE FROM link_offers WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(target_device)
        .execute(pool)
        .await?
        .rows_affected();
    if removed == 0 {
        anyhow::bail!("оффер линковки не найден или истёк");
    }
    sqlx::query("INSERT OR REPLACE INTO link_grants (username, device_id, box, eph_pub, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(username)
        .bind(target_device)
        .bind(box_payload)
        .bind(eph_pub)
        .bind(now_unix())
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) async fn handle_link_offer(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<LinkOfferRequest>(&msg.payload) {
        Ok(req) => match verify_active_device(pool, decoding, &req.token, &req.device_id).await {
            Ok(username) => match store_link_offer(pool, &username, &req.device_id, &req.eph_pub, &req.commitment, &req.signing_key, req.revoke).await {
                Ok(()) => {
                    info!("{} опубликовал оффер линковки (устройство '{}')", username, req.device_id);
                    LinkOfferResponse { ok: true, error: None }
                }
                Err(e) => LinkOfferResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
            },
            Err(e) => LinkOfferResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => LinkOfferResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_link_poll(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<LinkPollRequest>(&msg.payload) {
        Ok(req) => match verify_active_device(pool, decoding, &req.token, &req.device_id).await {
            Ok(username) => match poll_link(pool, &username, &req.device_id).await {
                Ok((offers, grant, challenge)) => LinkPollResponse { ok: true, offers, grant, challenge, error: None },
                Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, challenge: None, error: Some(parvane_db::public_error(&e)) },
            },
            Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, challenge: None, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, challenge: None, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

/// v2: старое устройство прикладывает свой эфемерный ключ к офферу целевого.
/// Владелец — из JWT; device_id здесь ЦЕЛЕВОЕ устройство.
pub(crate) async fn handle_link_challenge(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<LinkChallengeRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => match store_link_challenge(pool, &username, &req.device_id, &req.eph_pub).await {
                Ok(()) => LinkChallengeResponse { ok: true, error: None },
                Err(e) => LinkChallengeResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
            },
            Err(e) => LinkChallengeResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => LinkChallengeResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_link_grant(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<LinkGrantRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => {
                match store_link_grant(pool, &username, &req.device_id, &req.box_payload, &req.eph_pub).await {
                    Ok(()) => {
                        info!("{} выдал грант линковки устройству '{}'", username, req.device_id);
                        LinkGrantResponse { ok: true, error: None }
                    }
                    Err(e) => LinkGrantResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
                }
            }
            Err(e) => LinkGrantResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => LinkGrantResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}
