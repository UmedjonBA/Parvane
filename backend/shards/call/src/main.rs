mod v2;

use anyhow::{Context, Result};
use parvane_types::{
    IceServer,
    IceServersResponse,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::info;

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
    // T110: v1-релей `call.signal`, история и `call.ice.request` удалены; у шарда
    // больше нет своей БД (история звонков v2 — в журнале личного состояния).
    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    let ice_config = std::sync::Arc::new(IceConfig::from_env());

    // Протокол v2 (spec 007, T078): call.ring_sealed / call.signal_sealed (ANON) и call.ice_config.
    v2::run(nc.clone(), ice_config.clone()).await.context("v2: подписки")?;
    info!("Call шард запущен (протокол v2)");
    std::future::pending::<()>().await;
    Ok(())
}

// ── auth ─────────────────────────────────────────────────────────────────────


// ── работа с БД (тестируемая) ─────────────────────────────────────────────────










// ── call.signal ───────────────────────────────────────────────────────────────



// ── call.history.request ──────────────────────────────────────────────────────


// ── call.ice.request ─────────────────────────────────────────────────────────

/// Конфигурация выдачи ICE-серверов. STUN отдаётся всем как есть; для TURN
/// генерируются краткоживущие креды (TURN REST): username = `<expiry>:<user>`,
/// credential = base64(HMAC-SHA1(secret, username)).
struct IceConfig {
    stun_urls: Vec<String>,
    /// Один или несколько URL одного TURN (udp/tcp через запятую) — общие креды
    turn_urls: Vec<String>,
    turn_secret: Option<String>,
    ttl_secs: u64,
}

impl IceConfig {
    fn from_env() -> Self {
        let stun_urls = std::env::var("PARVANE_STUN_URLS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .collect();
        let turn_urls = std::env::var("PARVANE_TURN_URL")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .collect();
        let turn_secret = std::env::var("PARVANE_TURN_SECRET").ok().filter(|v| !v.is_empty());
        let ttl_secs = std::env::var("PARVANE_TURN_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3600);
        Self { stun_urls, turn_urls, turn_secret, ttl_secs }
    }

    fn build_response(&self, user: &str, now: i64) -> IceServersResponse {
        let mut ice_servers = Vec::new();
        if !self.stun_urls.is_empty() {
            ice_servers.push(IceServer {
                urls: self.stun_urls.clone(),
                username: None,
                credential: None,
            });
        }
        if let Some(secret) = self.turn_secret.as_ref().filter(|_| !self.turn_urls.is_empty()) {
            let username = format!("{}:{}", now + self.ttl_secs as i64, user);
            let credential = turn_rest_credential(secret, &username);
            ice_servers.push(IceServer {
                urls: self.turn_urls.clone(),
                username: Some(username),
                credential: Some(credential),
            });
        }
        IceServersResponse { ice_servers, ttl_secs: self.ttl_secs }
    }
}

fn turn_rest_credential(secret: &str, username: &str) -> String {
    use base64::Engine as _;
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes())
        .expect("HMAC принимает ключ любой длины");
    mac.update(username.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}


fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    
    

    #[test]
    fn turn_rest_credential_is_stable_hmac_sha1() {
        // Референс посчитан независимо: python hmac/sha1/base64
        assert_eq!(
            turn_rest_credential("north", "1700000000:alice@local"),
            "ng6stooO+WmFmwZcKnSQqroGfRc=",
        );
    }

    #[test]
    fn ice_response_contains_stun_and_ephemeral_turn() {
        let config = IceConfig {
            stun_urls: vec!["stun:stun.example:3478".into()],
            turn_urls: vec!["turn:turn.example:3478".into()],
            turn_secret: Some("secret".into()),
            ttl_secs: 600,
        };
        let resp = config.build_response("bob@local", 1_700_000_000);
        assert_eq!(resp.ttl_secs, 600);
        assert_eq!(resp.ice_servers.len(), 2);
        let turn = &resp.ice_servers[1];
        assert_eq!(turn.username.as_deref(), Some("1700000600:bob@local"));
        assert_eq!(
            turn.credential.as_deref().unwrap(),
            turn_rest_credential("secret", "1700000600:bob@local"),
        );
    }

    #[test]
    fn ice_response_without_turn_env_is_stun_only() {
        let config = IceConfig {
            stun_urls: vec!["stun:s".into()],
            turn_urls: vec![],
            turn_secret: None,
            ttl_secs: 3600,
        };
        let resp = config.build_response("bob@local", 0);
        assert_eq!(resp.ice_servers.len(), 1);
        assert!(resp.ice_servers[0].username.is_none());
    }












}
