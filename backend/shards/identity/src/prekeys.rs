//! Prekey-бандлы: публикация и выдача с лимитами и низким watermark OTK.

use crate::*;

/// Сохранить/обновить бандл УСТРОЙСТВА пользователя (мультидевайс): долгоживущие
/// ключи (UPSERT по (username, device_id)) + пачка одноразовых (INSERT OR IGNORE).
///
/// Смена identity_key = пере-инициализация ЭТОГО устройства (новый Olm-аккаунт):
/// его прежние one-time невалидны для X3DH с новым ключом (а из-за коллизий
/// key_id новые бы игнорировались) — вычищаем. Другие устройства не трогаем.
pub(crate) async fn store_prekeys(pool: &SqlitePool, username: &str, req: &PublishPrekeysRequest) -> Result<()> {
    let prev: Option<(String,)> =
        sqlx::query_as("SELECT identity_key FROM device_keys WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(&req.device_id)
            .fetch_optional(pool)
            .await
            .context("чтение прежнего identity_key")?;
    let device_changed = prev.as_ref().map(|(k,)| k != &req.identity_key).unwrap_or(false);
    // T048 (spec 007, защита от downgrade): у пользователя с журналом устройств
    // v2 новое v1-устройство без сертификата (или смена ключей v1-устройства)
    // не регистрируется — иначе сервер мог бы «понизить» переписку до v1.
    // Устройство, действующее в журнале v2 (привязано грантом, восстановлено),
    // сертификат имеет: его v1-бандл принимается, иначе v1-собеседники не слали
    // бы копий привязанным устройствам аккаунта (FR-054, T146).
    if (prev.is_none() || device_changed)
        && crate::v2::user_has_v2(username).await
        && !crate::v2::log_has_active_device(username, &req.device_id).await
    {
        anyhow::bail!("устройство без сертификата v2 запрещено для этого аккаунта");
    }
    if device_changed {
        sqlx::query("DELETE FROM one_time_prekeys WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(&req.device_id)
            .execute(pool)
            .await
            .context("очистка one_time старого устройства")?;
    }
    sqlx::query(
        "INSERT INTO device_keys
           (username, device_id, signing_key, registration_id, identity_key, signed_prekey_id,
            signed_prekey, signed_prekey_sig, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username, device_id) DO UPDATE SET
            signing_key = excluded.signing_key,
            registration_id = excluded.registration_id,
            identity_key = excluded.identity_key,
            signed_prekey_id = excluded.signed_prekey_id,
            signed_prekey = excluded.signed_prekey,
            signed_prekey_sig = excluded.signed_prekey_sig,
            updated_at = excluded.updated_at",
    )
    .bind(username)
    .bind(&req.device_id)
    .bind(&req.signing_key)
    .bind(req.registration_id)
    .bind(&req.identity_key)
    .bind(req.signed_prekey_id)
    .bind(&req.signed_prekey)
    .bind(&req.signed_prekey_sig)
    .bind(now_unix())
    .execute(pool)
    .await
    .context("сохранение device_keys")?;
    for otp in &req.one_time {
        sqlx::query(
            "INSERT OR IGNORE INTO one_time_prekeys (username, device_id, key_id, public_key)
             VALUES (?, ?, ?, ?)",
        )
        .bind(username)
        .bind(&req.device_id)
        .bind(otp.key_id)
        .bind(&otp.public_key)
        .execute(pool)
        .await
        .context("сохранение one_time")?;
    }
    Ok(())
}

pub(crate) fn empty_bundle_response(error: Option<String>) -> FetchBundleResponse {
    FetchBundleResponse {
        ok: error.is_none(),
        registration_id: None,
        identity_key: None,
        signed_prekey_id: None,
        signed_prekey: None,
        signed_prekey_sig: None,
        one_time_id: None,
        one_time: None,
        devices: vec![],
        error,
    }
}

/// Бандлы ВСЕХ устройств собеседника для X3DH (мультидевайс). Для устройств не
/// из `known_devices` атомарно снимает по одной one-time (UPDATE … RETURNING —
/// без гонки); для известных (сессия уже есть) one-time не расходуется.
/// Верхнеуровневые legacy-поля — бандл «primary»-устройства ('' приоритетно,
/// иначе самое свежее) для одно-девайсных клиентов. Если ключей нет — ok=false.
#[cfg(test)]
pub(crate) async fn fetch_bundle(
    pool: &SqlitePool,
    username: &str,
    known_devices: &[String],
) -> Result<FetchBundleResponse> {
    fetch_bundle_for(pool, "", "", username, known_devices).await
}

/// Olm-аккаунт запросившего для кэша повторной выдачи one-time (P-21):
/// устройство токена и его текущий identity-ключ из каталога. Смена ключей
/// устройства (выход и вход заново) даёт другой аккаунт.
pub(crate) async fn requester_account(pool: &SqlitePool, requester: &str, device_id: &str) -> String {
    let identity_key: Option<(String,)> =
        sqlx::query_as("SELECT identity_key FROM device_keys WHERE username = ? AND device_id = ?")
            .bind(requester)
            .bind(device_id)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
    format!("{device_id}:{}", identity_key.map(|(key,)| key).unwrap_or_default())
}

/// `requester` — кто запрашивает (для кэша повторной выдачи one-time, P-21);
/// пустой — без кэша (тесты/внутренние вызовы). `account` — его Olm-аккаунт
/// (`requester_account`): выданную one-time повторно получает только он.
pub(crate) async fn fetch_bundle_for(
    pool: &SqlitePool,
    requester: &str,
    account: &str,
    username: &str,
    known_devices: &[String],
) -> Result<FetchBundleResponse> {
    let rows: Vec<(String, String, i64, String, i64, String, String)> = sqlx::query_as(
        "SELECT device_id, signing_key, registration_id, identity_key, signed_prekey_id,
                signed_prekey, signed_prekey_sig
         FROM device_keys WHERE username = ?
         ORDER BY CASE WHEN device_id = '' THEN 0 ELSE 1 END, updated_at DESC",
    )
    .bind(username)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok(empty_bundle_response(Some("нет ключей пользователя".into())));
    }

    let mut devices = Vec::with_capacity(rows.len());
    for (device_id, signing_key, reg, ik, spid, sp, sig) in rows {
        let reuse = if requester.is_empty() || known_devices.contains(&device_id) {
            OtkReuse::Miss
        } else {
            cached_otk(requester, account, username, &device_id)
        };
        let otp: Option<(i64, String)> = if known_devices.contains(&device_id) {
            None
        } else if let OtkReuse::Same(key_id, public_key) = reuse {
            // P-21: та же пара в окне — та же one-time, новую не сжигаем
            Some((key_id, public_key))
        } else if matches!(reuse, OtkReuse::OtherAccount) {
            // Ключ, выданный в окне другому Olm-аккаунту запросившего, цель уже
            // могла израсходовать — сессия строится на signed prekey
            None
        } else {
            let fresh: Option<(i64, String)> = sqlx::query_as(
                "UPDATE one_time_prekeys SET consumed = 1
                 WHERE rowid = (SELECT rowid FROM one_time_prekeys
                                WHERE username = ? AND device_id = ? AND consumed = 0
                                ORDER BY key_id LIMIT 1)
                 RETURNING key_id, public_key",
            )
            .bind(username)
            .bind(&device_id)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
            if let Some((key_id, public_key)) = fresh.as_ref() {
                if !requester.is_empty() {
                    remember_otk(requester, account, username, &device_id, *key_id, public_key);
                }
                // P-21: алерт об исчерпании — иначе деградация до signed-prekey-only
                // происходила бы молча
                let left: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM one_time_prekeys WHERE username = ? AND device_id = ? AND consumed = 0",
                )
                .bind(username)
                .bind(&device_id)
                .fetch_one(pool)
                .await
                .unwrap_or(0);
                if left <= OTK_LOW_WATERMARK {
                    warn!("one-time prekeys устройства '{}' пользователя {} на исходе: {}", device_id, username, left);
                }
            }
            fresh
        };
        devices.push(parvane_types::DeviceBundle {
            device_id,
            signing_key,
            registration_id: reg,
            identity_key: ik,
            signed_prekey_id: spid,
            signed_prekey: sp,
            signed_prekey_sig: sig,
            one_time_id: otp.as_ref().map(|(k, _)| *k),
            one_time: otp.map(|(_, p)| p),
        });
    }

    let primary = devices[0].clone();
    Ok(FetchBundleResponse {
        ok: true,
        registration_id: Some(primary.registration_id),
        identity_key: Some(primary.identity_key),
        signed_prekey_id: Some(primary.signed_prekey_id),
        signed_prekey: Some(primary.signed_prekey),
        signed_prekey_sig: Some(primary.signed_prekey_sig),
        one_time_id: primary.one_time_id,
        one_time: primary.one_time,
        devices,
        error: None,
    })
}

pub(crate) async fn handle_prekeys_publish(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<PublishPrekeysRequest>(&msg.payload) {
        Ok(req) => match verify_active_device(pool, decoding, &req.token, &req.device_id).await {
            Ok(username) => match store_prekeys(pool, &username, &req).await {
                Ok(()) => {
                    info!(
                        "{} опубликовал prekeys (устройство '{}', {} one-time)",
                        username, req.device_id, req.one_time.len(),
                    );
                    PublishPrekeysResponse { ok: true, error: None }
                }
                Err(e) => PublishPrekeysResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
            },
            Err(e) => PublishPrekeysResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => PublishPrekeysResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_prekeys_fetch(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<FetchBundleRequest>(&msg.payload) {
        Ok(req) => match verify_active(pool, decoding, &req.token).await {
            Ok(claims) => {
                let requester = claims.sub;
                if !prekey_fetch_rate_ok(&requester, &req.user) {
                    empty_bundle_response(Some(
                        "слишком много запросов ключей, попробуйте позже".into(),
                    ))
                } else {
                    let account =
                        requester_account(pool, &requester, claims.dev.as_deref().unwrap_or("")).await;
                    fetch_bundle_for(pool, &requester, &account, &req.user, &req.known_devices)
                        .await
                        .unwrap_or_else(|e| empty_bundle_response(Some(e.to_string())))
                }
            }
            Err(e) => empty_bundle_response(Some(e.to_string())),
        },
        Err(e) => empty_bundle_response(Some(e.to_string())),
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// ── secret management ─────────────────────────────────────────────────────────


// ── handlers ─────────────────────────────────────────────────────────────────

/// P-21: предупреждение об исчерпании one-time у устройства (алерт оператору).
pub(crate) const OTK_LOW_WATERMARK: i64 = 5;
