//! Устройства: список и отзыв (P-06/P-07).

use crate::*;

/// Устройства аккаунта БЕЗ расхода one-time (в отличие от fetch_bundle):
/// каталог + остаток несожжённых one-time на устройство (для пополнения).
pub(crate) async fn list_devices(pool: &SqlitePool, username: &str) -> Result<Vec<DeviceInfo>> {
    let rows: Vec<(String, String, String, i64, i64, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT d.device_id, d.signing_key, d.identity_key, d.updated_at,
                (SELECT COUNT(*) FROM one_time_prekeys o
                  WHERE o.username = d.username AND o.device_id = d.device_id
                    AND o.consumed = 0),
                l.label, l.login_at
         FROM device_keys d
         LEFT JOIN device_labels l ON l.username = d.username AND l.device_id = d.device_id
         WHERE d.username = ?
         ORDER BY CASE WHEN d.device_id = '' THEN 0 ELSE 1 END, d.updated_at DESC",
    )
    .bind(username)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(device_id, signing_key, identity_key, updated_at, one_time_available, label, login_at)| DeviceInfo {
            device_id,
            signing_key,
            identity_key,
            updated_at,
            one_time_available,
            label,
            login_at,
        })
        .collect())
}

/// Наибольшая длина подписи устройства (символов).
const DEVICE_LABEL_MAX: usize = 32;

/// Запомнить, как устройство назвало себя при входе, и время входа. Подпись —
/// только печатные символы, обрезается; сбой записи входу не мешает.
pub(crate) async fn remember_device_label(pool: &SqlitePool, username: &str, device_id: &str, label: &str) {
    let label: String = label.chars().filter(|c| !c.is_control()).take(DEVICE_LABEL_MAX).collect();
    let label = label.trim();
    if label.is_empty() || device_id.is_empty() {
        return;
    }
    if let Err(e) = sqlx::query("INSERT OR REPLACE INTO device_labels (username, device_id, label, login_at) VALUES (?, ?, ?, ?)")
        .bind(username)
        .bind(device_id)
        .bind(label)
        .bind(now_unix())
        .execute(pool)
        .await
    {
        error!("подпись устройства {} / {}: {}", username, device_id, e);
    }
}

/// Подписи и время входа устройств пользователя: device_id → (подпись, вход).
pub(crate) async fn device_labels(pool: &SqlitePool, username: &str) -> std::collections::HashMap<String, (String, i64)> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as("SELECT device_id, label, login_at FROM device_labels WHERE username = ?")
        .bind(username)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    rows.into_iter().map(|(id, label, at)| (id, (label, at))).collect()
}

/// Отзыв устройства: бандл и one-time удаляются, fan-out его больше не увидит.
/// Ok(false) — такого устройства нет. Уже выданные JWT отзыв не гасит (24ч);
/// чтение НОВЫХ сообщений закрывает исчезновение из fan-out + клиентская
/// ротация групповых ключей.
pub(crate) async fn revoke_device(pool: &SqlitePool, username: &str, device_id: &str) -> Result<bool> {
    // Отозванное устройство перестаёт быть доверенным для двухфакторного входа
    let _ = sqlx::query("DELETE FROM trusted_devices WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM device_labels WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await;
    // Тумбстоун: JWT этого устройства перестают проходить verify сразу
    sqlx::query("INSERT OR REPLACE INTO revoked_devices (username, device_id, revoked_at) VALUES (?, ?, ?)")
        .bind(username)
        .bind(device_id)
        .bind(now_unix())
        .execute(pool)
        .await
        .context("тумбстоун отозванного устройства")?;
    let deleted = sqlx::query("DELETE FROM device_keys WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM one_time_prekeys WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(deleted > 0)
}

pub(crate) async fn handle_device_list(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<DeviceListRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => match list_devices(pool, &username).await {
                Ok(devices) => DeviceListResponse { ok: true, devices, error: None },
                Err(e) => DeviceListResponse { ok: false, devices: vec![], error: Some(parvane_db::public_error(&e)) },
            },
            Err(e) => DeviceListResponse { ok: false, devices: vec![], error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => DeviceListResponse { ok: false, devices: vec![], error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_device_revoke(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<DeviceRevokeRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => match async {
                // P-07: отзыв устройства — только с паролем.
                require_password(pool, &username, req.password.as_deref()).await?;
                revoke_device(pool, &username, &req.device_id).await
            }
            .await
            {
                Ok(true) => {
                    info!("{} отозвал устройство '{}'", username, req.device_id);
                    DeviceRevokeResponse { ok: true, error: None }
                }
                // Устройство только в журнале v2 (в каталог v1 оно не попадало,
                // T048): пароль проверен, тумбстоун JWT поставлен — отзыв принят;
                // запись в журнал устройств клиент вносит методом v2.
                Ok(false) if crate::v2::log_has_device(&username, &req.device_id).await => {
                    info!("{} отозвал v2-устройство '{}' (сессии v1)", username, req.device_id);
                    DeviceRevokeResponse { ok: true, error: None }
                }
                Ok(false) => DeviceRevokeResponse {
                    ok: false,
                    error: Some("устройство не найдено".into()),
                },
                Err(e) => DeviceRevokeResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
            },
            Err(e) => DeviceRevokeResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => DeviceRevokeResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// ── линковка: передача E2E-состояния на новое устройство ────────────────────
// Сервер — слепой релей: видит эфемерные ПУБЛИЧНЫЕ ключи и ECDH-бокс
// (внутри — координаты шифртекста экспорта в cloud), прочитать не может.
