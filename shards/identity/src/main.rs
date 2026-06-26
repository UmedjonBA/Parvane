use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use parvane_types::{
    IssueRequest, IssueResponse, VerifyRequest, VerifyResponse,
    topics::{IDENTITY_ISSUE, IDENTITY_VERIFY},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info};
use uuid::Uuid;

// ── JWT claims ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
    iat: usize,
}

// ── password hashing (упрощённый для прототипа) ───────────────────────────────

fn hash_password(password: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    password.hash(&mut h);
    format!("{:016x}", h.finish())
}

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
        .unwrap_or_else(|_| "./identity.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url)
        .await
        .context("подключение к SQLite")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("миграции")?;

    info!("SQLite готов: {}", db_path);

    let secret = load_or_generate_secret(&pool).await?;
    let encoding = EncodingKey::from_secret(&secret);
    let decoding = DecodingKey::from_secret(&secret);

    let nc = async_nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;

    info!("NATS подключён: {}", nats_url);

    let mut issue_sub = nc.subscribe(IDENTITY_ISSUE).await?;
    let mut verify_sub = nc.subscribe(IDENTITY_VERIFY).await?;

    info!(
        "Identity шард запущен. Слушаю: {}, {}",
        IDENTITY_ISSUE, IDENTITY_VERIFY
    );

    loop {
        tokio::select! {
            Some(msg) = issue_sub.next() => {
                handle_issue(&nc, &pool, &encoding, msg).await;
            }
            Some(msg) = verify_sub.next() => {
                handle_verify(&nc, &decoding, msg).await;
            }
        }
    }
}

// ── secret management ─────────────────────────────────────────────────────────

async fn load_or_generate_secret(pool: &SqlitePool) -> Result<Vec<u8>> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT bytes FROM secret WHERE id = 1")
        .fetch_optional(pool)
        .await?;

    if let Some((bytes,)) = row {
        info!("JWT-секрет загружен из БД");
        Ok(bytes)
    } else {
        let mut secret = vec![0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);

        sqlx::query("INSERT INTO secret (id, bytes) VALUES (1, ?)")
            .bind(&secret)
            .execute(pool)
            .await?;

        info!("JWT-секрет сгенерирован и сохранён");
        Ok(secret)
    }
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn handle_issue(
    nc: &Client,
    pool: &SqlitePool,
    encoding: &EncodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else {
        error!("issue: нет reply-топика, игнорирую");
        return;
    };

    let resp = match do_issue(pool, encoding, &msg.payload).await {
        Ok(token) => IssueResponse { ok: true, token: Some(token), error: None },
        Err(e) => {
            error!("issue error: {}", e);
            IssueResponse { ok: false, token: None, error: Some(e.to_string()) }
        }
    };

    let json = serde_json::to_vec(&resp).unwrap();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("issue: ошибка отправки ответа: {}", e);
    }
}

async fn do_issue(pool: &SqlitePool, encoding: &EncodingKey, payload: &[u8]) -> Result<String> {
    let req: IssueRequest = serde_json::from_slice(payload)
        .context("неверный JSON в IssueRequest")?;

    let hash = hash_password(&req.password);

    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE username = ?")
            .bind(&req.user)
            .fetch_optional(pool)
            .await?;

    if existing.is_none() {
        let id = Uuid::now_v7().to_string();
        let now = now_unix();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&req.user)
        .bind(&hash)
        .bind(now)
        .execute(pool)
        .await?;
        info!("Пользователь создан: {}", req.user);
    } else {
        let row: (String,) =
            sqlx::query_as("SELECT password_hash FROM users WHERE username = ?")
                .bind(&req.user)
                .fetch_one(pool)
                .await?;
        if row.0 != hash {
            anyhow::bail!("неверный пароль");
        }
    }

    let now = now_unix() as usize;
    let claims = Claims { sub: req.user.clone(), iat: now, exp: now + 86400 };
    let token = encode(&Header::new(Algorithm::HS256), &claims, encoding)
        .context("подпись JWT")?;

    info!("JWT выдан для: {}", req.user);
    Ok(token)
}

async fn handle_verify(nc: &Client, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("verify: нет reply-топика, игнорирую");
        return;
    };

    let resp = match do_verify(decoding, &msg.payload) {
        Ok(user) => VerifyResponse { ok: true, user: Some(user), error: None },
        Err(e) => VerifyResponse { ok: false, user: None, error: Some(e.to_string()) },
    };

    let json = serde_json::to_vec(&resp).unwrap();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("verify: ошибка отправки ответа: {}", e);
    }
}

fn do_verify(decoding: &DecodingKey, payload: &[u8]) -> Result<String> {
    let req: VerifyRequest = serde_json::from_slice(payload)
        .context("неверный JSON в VerifyRequest")?;

    let validation = Validation::new(Algorithm::HS256);
    let data = decode::<Claims>(&req.token, decoding, &validation)
        .context("неверный или просроченный JWT")?;

    Ok(data.claims.sub)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_keys() -> (EncodingKey, DecodingKey) {
        let secret = b"test-secret-32-bytes-exactly!!!";
        (EncodingKey::from_secret(secret), DecodingKey::from_secret(secret))
    }

    #[test]
    fn jwt_roundtrip() {
        let (enc, dec) = make_keys();
        let now = now_unix() as usize;
        let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600 };
        let token = encode(&Header::new(Algorithm::HS256), &claims, &enc).unwrap();

        let req = serde_json::to_vec(&VerifyRequest { token }).unwrap();
        let user = do_verify(&dec, &req).unwrap();
        assert_eq!(user, "alice@local");
    }

    #[test]
    fn jwt_wrong_secret_rejected() {
        let (enc, _) = make_keys();
        let now = now_unix() as usize;
        let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600 };
        let token = encode(&Header::new(Algorithm::HS256), &claims, &enc).unwrap();

        let other_dec = DecodingKey::from_secret(b"different-secret-32-bytes-exactly");
        let req = serde_json::to_vec(&VerifyRequest { token }).unwrap();
        assert!(do_verify(&other_dec, &req).is_err());
    }

    #[test]
    fn password_same_input_same_hash() {
        assert_eq!(hash_password("secret"), hash_password("secret"));
    }

    #[test]
    fn password_different_input_different_hash() {
        assert_ne!(hash_password("secret"), hash_password("other"));
    }
}
