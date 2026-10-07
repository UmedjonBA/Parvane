//! Протокол v2 в push (spec 007 US6, T101): методы `push.wake.describe/
//! register/unregister` (идентифицированный канал; пользователь и устройство —
//! `req.user`/`req.device_id`, JWT уже проверил gateway) и пробуждения по
//! журналу инбокса `v2.inbox.<token>`.
//!
//! Регистрация хранится в `<PARVANE_DB_PATH>-v2.db` с привязкой к токену
//! журнала устройства. Запись журнала push не разбирает: по одному факту
//! публикации в `v2.inbox.<token>` шлёт пустое пробуждение (см. `push::wake`),
//! не чаще раза в 30 с на устройство. Ограничения v1 сохраняются: только
//! публичный https (netguard, повторная проверка и фиксация адресов при
//! отправке), ≤ 8 регистраций на пользователя. v1-путь (`push.device.*`,
//! `msg.user.>`) не меняется.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use futures::StreamExt;
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, ShardRequest};
use parvane_protocol::pb::parvane::push::v1::{
    DescribeResponse, RegisterRequest, RegisterResponse, UnregisterRequest, UnregisterResponse, WakeKind,
};
use parvane_protocol::registry_gen::INBOX_WILDCARD;
use parvane_protocol::schema::MethodInfo;
use parvane_v2rt::{body, BoxFut, Reply};
use prost::Message;
use push::vapid::VapidKeys;
use push::wake::{self, Collapser, StoredWake};
use sqlx::{Row, SqlitePool};
use tracing::{debug, error, info, warn};

use crate::{handler_concurrency, pinned_push_client};

struct Ctx {
    pool: SqlitePool,
    vapid: Arc<VapidKeys>,
}

pub(crate) async fn open_store(db_path: &str) -> Result<SqlitePool> {
    let path = format!("{db_path}-v2.db");
    let pool = parvane_db::connect(&path).await?;
    sqlx::migrate!("./migrations_v2").run(&pool).await.context("миграции v2")?;
    info!("SQLite v2 готов: {}", path);
    Ok(pool)
}

pub(crate) async fn run(nc: async_nats::Client, pool: SqlitePool, vapid: Arc<VapidKeys>) -> Result<()> {
    let ctx = Arc::new(Ctx { pool, vapid });
    let c2 = ctx.clone();
    let handler: parvane_v2rt::Handler = Arc::new(move |m: &'static MethodInfo, req: ShardRequest| -> BoxFut {
        let ctx = c2.clone();
        Box::pin(async move { dispatch(&ctx, m, req).await })
    });
    parvane_v2rt::serve(nc.clone(), "push", handler_concurrency(), handler).await?;

    let mut inbox = nc.subscribe(INBOX_WILDCARD).await?;
    let collapser = Arc::new(Mutex::new(Collapser::default()));
    let sem = Arc::new(tokio::sync::Semaphore::new(handler_concurrency()));
    tokio::spawn(async move {
        while let Some(msg) = inbox.next().await {
            // Полезная нагрузку журнала не читаем: важен только факт записи.
            let Some(token) = wake::inbox_token(msg.subject.as_str()) else { continue };
            let admitted = collapser.lock().unwrap_or_else(|e| e.into_inner()).admit(token, Instant::now());
            if !admitted {
                continue;
            }
            let Ok(permit) = sem.clone().acquire_owned().await else { break };
            let (ctx, token) = (ctx.clone(), token.to_string());
            tokio::spawn(async move {
                let _p = permit;
                wake_device(&ctx, &token).await;
            });
        }
    });
    info!("push: методы v2 и пробуждения ({}) подключены", INBOX_WILDCARD);
    Ok(())
}

async fn dispatch(ctx: &Ctx, m: &'static MethodInfo, req: ShardRequest) -> Reply {
    match m.name {
        "push.wake.describe" => describe(ctx, &req),
        "push.wake.register" => register(ctx, &req).await,
        "push.wake.unregister" => unregister(ctx, &req).await,
        _ => Err(ErrorCode::Unavailable),
    }
}

/// Пользователь и устройство идентифицированной сессии.
fn me(req: &ShardRequest) -> Result<(&str, &str), ErrorCode> {
    if req.user.is_empty() || req.device_id.is_empty() {
        Err(ErrorCode::Forbidden)
    } else {
        Ok((&req.user, &req.device_id))
    }
}

fn db_err(e: sqlx::Error) -> ErrorCode {
    error!("v2 push: SQLite: {e}");
    ErrorCode::Unavailable
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn describe(ctx: &Ctx, req: &ShardRequest) -> Reply {
    me(req)?;
    let vapid_public_key = ctx.vapid.public_raw().map_err(|e| {
        error!("v2 push: VAPID-ключ: {e}");
        ErrorCode::Unavailable
    })?;
    Ok(DescribeResponse { vapid_public_key, supported: vec![WakeKind::WebPush as i32, WakeKind::UnifiedPush as i32] }
        .encode_to_vec())
}

async fn register(ctx: &Ctx, req: &ShardRequest) -> Reply {
    let (user, device) = me(req)?;
    let r: RegisterRequest = body(req)?;
    let reg = wake::check_registration(&r.registration.ok_or(ErrorCode::Invalid)?)?;
    let token = wake::device_token(user, device)?;
    // P-17: все адреса хоста — публичные (SSRF во внутреннюю сеть через канал).
    let parsed = url::Url::parse(&reg.endpoint).map_err(|_| ErrorCode::Invalid)?;
    parvane_netguard::resolve_url(&parsed).await.map_err(|e| {
        debug!("v2 push.wake.register: endpoint не резолвится в публичный адрес: {e}");
        ErrorCode::Invalid
    })?;
    let mut tx = ctx.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    // ≤ 8 регистраций на пользователя: при переполнении уходят самые старые.
    sqlx::query(
        "DELETE FROM wake_registrations WHERE user = ? AND endpoint <> ? AND rowid NOT IN (
            SELECT rowid FROM wake_registrations WHERE user = ? AND endpoint <> ?
            ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    )
    .bind(user)
    .bind(&reg.endpoint)
    .bind(user)
    .bind(&reg.endpoint)
    .bind(wake::MAX_REGISTRATIONS_PER_USER - 1)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    // MSG-16: чужой endpoint не перехватывается (см. v1)
    let res = sqlx::query(
        "INSERT INTO wake_registrations (endpoint, user, device_id, inbox_token, kind, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id,
             inbox_token = excluded.inbox_token, kind = excluded.kind, p256dh = excluded.p256dh,
             auth = excluded.auth, created_at = excluded.created_at
         WHERE wake_registrations.user = excluded.user",
    )
    .bind(&reg.endpoint)
    .bind(user)
    .bind(device)
    .bind(&token)
    .bind(reg.kind as i32)
    .bind(&reg.p256dh)
    .bind(&reg.auth)
    .bind(now_unix())
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    if res.rows_affected() == 0 {
        return Err(ErrorCode::Forbidden);
    }
    tx.commit().await.map_err(db_err)?;
    info!("v2: канал пробуждения зарегистрирован для {}", user);
    Ok(RegisterResponse {}.encode_to_vec())
}

async fn unregister(ctx: &Ctx, req: &ShardRequest) -> Reply {
    let (user, device) = me(req)?;
    let r: UnregisterRequest = body(req)?;
    let q = if r.endpoint.is_empty() {
        // Без endpoint — все каналы этого устройства.
        sqlx::query("DELETE FROM wake_registrations WHERE user = ? AND device_id = ?").bind(user).bind(device)
    } else {
        sqlx::query("DELETE FROM wake_registrations WHERE user = ? AND endpoint = ?").bind(user).bind(r.endpoint)
    };
    q.execute(&ctx.pool).await.map_err(db_err)?;
    Ok(UnregisterResponse {}.encode_to_vec())
}

/// Разбудить все каналы устройства `token` (схлопывание уже пройдено).
async fn wake_device(ctx: &Ctx, token: &str) {
    let rows = match sqlx::query("SELECT endpoint, kind, p256dh, auth FROM wake_registrations WHERE inbox_token = ?")
        .bind(token)
        .fetch_all(&ctx.pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            warn!("v2 push: чтение каналов пробуждения: {e}");
            return;
        }
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    for row in rows {
        let endpoint: String = row.get("endpoint");
        let Ok(kind) = WakeKind::try_from(row.get::<i64, _>("kind") as i32) else { continue };
        let reg = StoredWake { kind, endpoint: endpoint.clone(), p256dh: row.get("p256dh"), auth: row.get("auth") };
        let request = match wake::build_wake_request(&ctx.vapid, &reg, now).and_then(|r| Ok(reqwest::Request::try_from(r)?)) {
            Ok(r) => r,
            Err(e) => {
                warn!("v2 push: сборка пробуждения не удалась: {e}");
                continue;
            }
        };
        let client = match pinned_push_client(&endpoint).await {
            Ok(c) => c,
            Err(e) => {
                warn!("v2 push: endpoint отклонён фильтром: {e}");
                continue;
            }
        };
        match tokio::time::timeout(Duration::from_secs(15), client.execute(request)).await {
            Ok(Ok(resp)) if resp.status().is_success() => debug!("v2 push: пробуждение отправлено"),
            Ok(Ok(resp)) if resp.status() == reqwest::StatusCode::NOT_FOUND || resp.status() == reqwest::StatusCode::GONE => {
                // Канал мёртв (подписка отозвана) — вычищаем.
                let _ = sqlx::query("DELETE FROM wake_registrations WHERE endpoint = ?").bind(&endpoint).execute(&ctx.pool).await;
                info!("v2 push: мёртвый канал пробуждения удалён");
            }
            Ok(Ok(resp)) => warn!("v2 push: пробуждение не доставлено: HTTP {}", resp.status()),
            Ok(Err(e)) => warn!("v2 push: пробуждение не доставлено: {e}"),
            Err(_) => warn!("v2 push: пробуждение не доставлено: таймаут"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_ctx() -> Ctx {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations_v2").run(&pool).await.unwrap();
        let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let pem = p256::pkcs8::EncodePrivateKey::to_pkcs8_pem(&secret, p256::pkcs8::LineEnding::LF).unwrap();
        Ctx { pool, vapid: Arc::new(push::vapid::vapid_from_pem(&pem).unwrap()) }
    }

    fn req(user: &str, device: &str, method: &str, body: Vec<u8>) -> ShardRequest {
        ShardRequest { method: method.into(), user: user.into(), device_id: device.into(), body, ..Default::default() }
    }

    fn web_reg(endpoint: &str) -> Vec<u8> {
        let ua = p256::SecretKey::random(&mut rand::rngs::OsRng).public_key().to_sec1_bytes().to_vec();
        RegisterRequest {
            registration: Some(parvane_protocol::pb::parvane::push::v1::WakeRegistration {
                kind: WakeKind::WebPush as i32,
                endpoint: endpoint.into(),
                p256dh: ua,
                auth: vec![3; 16],
            }),
        }
        .encode_to_vec()
    }

    #[tokio::test]
    async fn describe_needs_session_and_returns_raw_vapid_key() {
        let ctx = test_ctx().await;
        assert_eq!(describe(&ctx, &req("", "", "push.wake.describe", vec![])).err(), Some(ErrorCode::Forbidden));
        let r = DescribeResponse::decode(describe(&ctx, &req("alice@local", "d1", "push.wake.describe", vec![])).unwrap().as_slice())
            .unwrap();
        assert_eq!(r.vapid_public_key.len(), 65);
        assert_eq!(r.vapid_public_key[0], 4);
        assert!(r.supported.contains(&(WakeKind::WebPush as i32)));
        assert!(!r.supported.contains(&(WakeKind::Fcm as i32)));
    }

    // Регистрация: IP-литерал публичного адреса — без DNS (тест без сети).
    #[tokio::test]
    async fn register_binds_to_device_journal_and_caps_per_user() {
        let ctx = test_ctx().await;
        for i in 0..10 {
            let r = req("alice@local", &format!("d{i}"), "push.wake.register", web_reg(&format!("https://8.8.8.8/push/{i}")));
            register(&ctx, &r).await.unwrap();
        }
        let rows: Vec<(String, String, String)> =
            sqlx::query_as("SELECT endpoint, device_id, inbox_token FROM wake_registrations WHERE user = 'alice@local' ORDER BY endpoint")
                .fetch_all(&ctx.pool)
                .await
                .unwrap();
        assert_eq!(rows.len() as i64, wake::MAX_REGISTRATIONS_PER_USER, "≤ 8 регистраций на пользователя");
        for (_, dev, token) in &rows {
            assert_eq!(token, &wake::device_token("alice@local", dev).unwrap());
        }
        // Приватный адрес, http и нативные каналы — отказ.
        let bad = req("alice@local", "d1", "push.wake.register", web_reg("https://10.1.2.3/push"));
        assert_eq!(register(&ctx, &bad).await.err(), Some(ErrorCode::Invalid));
        let bad = req("alice@local", "d1", "push.wake.register", web_reg("http://8.8.8.8/push"));
        assert_eq!(register(&ctx, &bad).await.err(), Some(ErrorCode::Invalid));
        let mut fcm = RegisterRequest::decode(web_reg("https://8.8.8.8/fcm").as_slice()).unwrap();
        if let Some(r) = fcm.registration.as_mut() {
            r.kind = WakeKind::Fcm as i32;
        }
        let bad = req("alice@local", "d1", "push.wake.register", fcm.encode_to_vec());
        assert_eq!(register(&ctx, &bad).await.err(), Some(ErrorCode::Unavailable));
        // Без сессии — отказ.
        let anon = req("", "", "push.wake.register", web_reg("https://8.8.8.8/push/x"));
        assert_eq!(register(&ctx, &anon).await.err(), Some(ErrorCode::Forbidden));

        // Отписка: только свой канал; без endpoint — все каналы устройства.
        let other = req("bob@local", "d9", "push.wake.unregister", UnregisterRequest { endpoint: "https://8.8.8.8/push/9".into() }.encode_to_vec());
        unregister(&ctx, &other).await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM wake_registrations").fetch_one(&ctx.pool).await.unwrap();
        assert_eq!(n, 8, "чужой канал не удалён");
        let mine = req("alice@local", "d9", "push.wake.unregister", UnregisterRequest { endpoint: String::new() }.encode_to_vec());
        unregister(&ctx, &mine).await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM wake_registrations").fetch_one(&ctx.pool).await.unwrap();
        assert_eq!(n, 7);
    }
}
