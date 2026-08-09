// Push шард: web-push (VAPID) для офлайн-устройств. Подписан на инбоксы
// msg.user.> — по факту доставки будит зарегистрированные подписки браузеров.
// Контента он не видит и не разбирает (sealed sender): payload пуша —
// генерический «New message». SW клиента сам гасит пуш, если приложение открыто.

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use async_nats::Client;
use base64::Engine;
use futures::StreamExt;
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use parvane_types::{
    GroupActionResponse, PushRegisterRequest, PushSubscriptionInfo, PushUnregisterRequest,
    PushVapidResponse, VerifyRequest, VerifyResponse,
    topics::{IDENTITY_VERIFY, MSG_USER_WILDCARD, PUSH_REGISTER, PUSH_UNREGISTER, PUSH_VAPID_GET},
};
use sqlx::{Row, SqlitePool};
use tracing::{info, warn};
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushMessageBuilder,
};

/// Не дребезжим: не чаще одного пуша на пользователя за интервал.
const PUSH_COOLDOWN_SECS: u64 = 30;
// Формат tt-SW (pushNotification.ts): custom обязателен, текст — description
const PUSH_PAYLOAD: &str = r#"{"title":"Parvane","description":"New message","custom":{}}"#;

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
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./push.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url).await.context("подключение к SQLite")?;
    sqlx::migrate!("./migrations").run(&pool).await.context("миграции")?;
    info!("SQLite готов: {}", db_path);

    let vapid = ensure_vapid_keys(&pool).await?;
    info!("VAPID готов, public key: {}…", &vapid.public_b64url[..16.min(vapid.public_b64url.len())]);

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    let mut vapid_sub = nc.subscribe(PUSH_VAPID_GET).await?;
    let mut register_sub = nc.subscribe(PUSH_REGISTER).await?;
    let mut unregister_sub = nc.subscribe(PUSH_UNREGISTER).await?;
    let mut inbox_sub = nc.subscribe(MSG_USER_WILDCARD).await?;
    info!("Push шард запущен. Слушаю: {}/{}/{} + {}", PUSH_VAPID_GET, PUSH_REGISTER, PUSH_UNREGISTER, MSG_USER_WILDCARD);

    let push_client = IsahcWebPushClient::new().context("web-push клиент")?;
    let mut last_push_at: HashMap<String, Instant> = HashMap::new();

    loop {
        tokio::select! {
            Some(msg) = vapid_sub.next() => handle_vapid_get(&nc, &vapid, msg).await,
            Some(msg) = register_sub.next() => handle_register(&nc, &pool, msg).await,
            Some(msg) = unregister_sub.next() => handle_unregister(&nc, &pool, msg).await,
            Some(msg) = inbox_sub.next() => {
                handle_inbox(&pool, &push_client, &vapid, &mut last_push_at, msg).await;
            }
        }
    }
}

struct VapidKeys {
    private_pem: String,
    public_b64url: String,
}

async fn ensure_vapid_keys(pool: &SqlitePool) -> Result<VapidKeys> {
    if let Some(row) = sqlx::query("SELECT private_pem, public_b64url FROM vapid_keys WHERE id = 1")
        .fetch_optional(pool)
        .await?
    {
        return Ok(VapidKeys {
            private_pem: row.get::<String, _>("private_pem"),
            public_b64url: row.get::<String, _>("public_b64url"),
        });
    }

    let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let private_pem = secret
        .to_pkcs8_pem(LineEnding::LF)
        .context("экспорт VAPID-ключа в PEM")?
        .to_string();
    let public_point = secret.public_key().to_sec1_bytes();
    let public_b64url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&public_point);

    sqlx::query("INSERT INTO vapid_keys (id, private_pem, public_b64url) VALUES (1, ?, ?)")
        .bind(&private_pem)
        .bind(&public_b64url)
        .execute(pool)
        .await?;
    info!("Сгенерирована новая пара VAPID-ключей");
    Ok(VapidKeys { private_pem, public_b64url })
}

async fn verify_token(nc: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = nc.request(IDENTITY_VERIFY, req.into()).await.context("запрос к identity")?;
    let resp: VerifyResponse =
        serde_json::from_slice(&reply.payload).context("ответ identity: неверный JSON")?;
    if resp.ok {
        resp.user.ok_or_else(|| anyhow::anyhow!("identity вернул ok без user"))
    } else {
        anyhow::bail!(resp.error.unwrap_or_else(|| "неизвестная ошибка".into()))
    }
}

async fn handle_vapid_get(nc: &Client, vapid: &VapidKeys, msg: async_nats::Message) {
    let Some(reply) = msg.reply else { return };
    let resp = PushVapidResponse {
        ok: true,
        public_key: Some(vapid.public_b64url.clone()),
        error: None,
    };
    if let Ok(body) = serde_json::to_vec(&resp) {
        let _ = nc.publish(reply, body.into()).await;
    }
}

async fn reply_action(nc: &Client, reply: async_nats::Subject, ok: bool, error: Option<String>) {
    let resp = GroupActionResponse { ok, error };
    if let Ok(body) = serde_json::to_vec(&resp) {
        let _ = nc.publish(reply, body.into()).await;
    }
}

async fn handle_register(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let result: Result<()> = async {
        let req: PushRegisterRequest =
            serde_json::from_slice(&msg.payload).context("JSON push.device.register")?;
        let user = verify_token(nc, &req.token).await?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let subscription_json = serde_json::to_string(&req.subscription)?;
        sqlx::query(
            "INSERT INTO push_subscriptions (endpoint, user, subscription_json, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET user = excluded.user,
                 subscription_json = excluded.subscription_json, created_at = excluded.created_at",
        )
        .bind(&req.subscription.endpoint)
        .bind(&user)
        .bind(&subscription_json)
        .bind(now)
        .execute(pool)
        .await?;
        info!("подписка зарегистрирована для {}", user);
        Ok(())
    }
    .await;

    match result {
        Ok(()) => reply_action(nc, reply, true, None).await,
        Err(e) => {
            warn!("register отклонён: {}", e);
            reply_action(nc, reply, false, Some(e.to_string())).await;
        }
    }
}

async fn handle_unregister(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let result: Result<()> = async {
        let req: PushUnregisterRequest =
            serde_json::from_slice(&msg.payload).context("JSON push.device.unregister")?;
        let user = verify_token(nc, &req.token).await?;
        match req.endpoint {
            Some(endpoint) => {
                sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ? AND user = ?")
                    .bind(&endpoint)
                    .bind(&user)
                    .execute(pool)
                    .await?;
            }
            None => {
                sqlx::query("DELETE FROM push_subscriptions WHERE user = ?")
                    .bind(&user)
                    .execute(pool)
                    .await?;
            }
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => reply_action(nc, reply, true, None).await,
        Err(e) => {
            warn!("unregister отклонён: {}", e);
            reply_action(nc, reply, false, Some(e.to_string())).await;
        }
    }
}

async fn handle_inbox(
    pool: &SqlitePool,
    push_client: &IsahcWebPushClient,
    vapid: &VapidKeys,
    last_push_at: &mut HashMap<String, Instant>,
    msg: async_nats::Message,
) {
    // Субъект вида msg.user.<адрес>; сам payload — sealed, не разбираем
    let Some(user) = msg.subject.strip_prefix("msg.user.") else { return };
    let user = user.to_string();

    if let Some(last) = last_push_at.get(&user) {
        if last.elapsed() < Duration::from_secs(PUSH_COOLDOWN_SECS) {
            return;
        }
    }

    let rows = match sqlx::query(
        "SELECT endpoint, subscription_json FROM push_subscriptions WHERE user = ?",
    )
    .bind(&user)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            warn!("чтение подписок {} не удалось: {}", user, e);
            return;
        }
    };
    if rows.is_empty() {
        return;
    }
    last_push_at.insert(user.clone(), Instant::now());

    for row in rows {
        let endpoint: String = row.get("endpoint");
        let subscription_json: String = row.get("subscription_json");
        let Ok(info) = serde_json::from_str::<PushSubscriptionInfo>(&subscription_json) else {
            continue;
        };
        let subscription =
            SubscriptionInfo::new(info.endpoint.clone(), info.keys.p256dh, info.keys.auth);

        let message = match build_push_message(vapid, &subscription) {
            Ok(message) => message,
            Err(e) => {
                warn!("сборка пуша для {} не удалась: {}", user, e);
                continue;
            }
        };

        match push_client.send(message).await {
            Ok(()) => info!("push отправлен: {}", user),
            Err(web_push::WebPushError::EndpointNotValid)
            | Err(web_push::WebPushError::EndpointNotFound) => {
                // Подписка мертва (браузер отписался) — вычищаем
                let _ = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?")
                    .bind(&endpoint)
                    .execute(pool)
                    .await;
                info!("мёртвая подписка удалена: {}", user);
            }
            Err(e) => warn!("push для {} не доставлен: {}", user, e),
        }
    }
}

fn build_push_message(
    vapid: &VapidKeys,
    subscription: &SubscriptionInfo,
) -> Result<web_push::WebPushMessage> {
    let signature = VapidSignatureBuilder::from_pem(vapid.private_pem.as_bytes(), subscription)
        .context("VAPID из PEM")?
        .build()
        .context("подпись VAPID")?;
    let mut builder = WebPushMessageBuilder::new(subscription);
    builder.set_payload(ContentEncoding::Aes128Gcm, PUSH_PAYLOAD.as_bytes());
    builder.set_vapid_signature(signature);
    Ok(builder.build()?)
}
