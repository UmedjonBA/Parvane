// Parvane gateway: единственная точка входа клиентов в шину. Клиент говорит с
// gateway JSON-кадрами, gateway верифицирует JWT и пропускает только в СВОИ
// subject'ы пользователя. Изоляция «людей» держится на gateway, а не на
// NATS-правах (где все клиенты были одним логином `client`).
//
// Два транспорта, одинаковый JSON-протокол кадров:
//  - TCP (построчный JSON, `\n`-разделитель) — для нативного клиента без
//    зависимостей (parvane-core GatewayTransport);
//  - WebSocket — для будущих браузер/мобильных клиентов.
use anyhow::{anyhow, Context, Result};
use async_nats::Client;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

use parvane_types::{
    topic_contract::{
        GATEWAY_ALLOWED_PUBLISH, GATEWAY_ALLOWED_REQUEST, GATEWAY_EVENT_SUBJECTS,
        GATEWAY_TOKEN_REQUEST_SUBJECTS,
    },
    GroupListResponse,
    topics::{
        call_inbox, group_call_route, msg_inbox, FILE_UPLOAD_CHUNK, FILE_UPLOAD_COMPLETE, GROUP_LIST,
        IDENTITY_EMAIL_CONFIRM, IDENTITY_ISSUE, IDENTITY_REGISTER, IDENTITY_REGISTER_STATUS,
        IDENTITY_SERVER_INFO, IDENTITY_TELEGRAM_CONFIRM, IDENTITY_VERIFY, MSG_CHAT_PREFIX, MSG_EDIT,
        MSG_SEND, MSG_TYPING_PREFIX, PRESENCE_PREFIX,
    },
    VerifyRequest, VerifyResponse,
};

mod limits;
mod acl;
mod session;
mod v2;
pub(crate) use limits::*;
pub(crate) use acl::*;
pub(crate) use session::*;

#[cfg(test)]
mod tests;

/// Максимальная длина одного клиентского кадра (защита от кадра без разделителя,
/// раздувающего память). TCP рвёт соединение, WS отвергает по конфигу.
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// Ёмкость каналов кадров: даёт backpressure вместо неограниченного роста памяти.
const CHANNEL_CAP: usize = 512;
/// За сколько секунд соединение обязано пройти auth, иначе сокет закрывается.
const AUTH_TIMEOUT_SECS: u64 = 10;
/// Период переверификации токена уже авторизованной сессии (P-06), по умолчанию
/// 300 с; PARVANE_GATEWAY_REVERIFY_SECS переопределяет (интеграционные тесты).
fn reverify_secs() -> u64 {
    std::env::var("PARVANE_GATEWAY_REVERIFY_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|s| *s > 0)
        .unwrap_or(300)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("PARVANE_LOG_LEVEL")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    dotenvy::dotenv().ok();

    let ws_bind = env("PARVANE_GATEWAY_BIND", "0.0.0.0:9222");
    let tcp_bind = env("PARVANE_GATEWAY_TCP_BIND", "0.0.0.0:9223");
    let nats_url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    let user = env("PARVANE_NATS_USER", "gateway");
    let pass = std::env::var("PARVANE_NATS_PASS").unwrap_or_default();

    // Шина может подняться позже gateway (compose, раннеры тестов) — повторяем
    // первичное подключение вместо немедленного выхода.
    // GW-01: очередь подписки NATS по умолчанию — 65 536 сообщений на подписку;
    // у нечитающего клиента это неограниченная память. Хватает и малой.
    let mut opts = async_nats::ConnectOptions::new()
        .retry_on_initial_connect()
        .subscription_capacity(env("PARVANE_GATEWAY_SUB_CAPACITY", "1024").parse().unwrap_or(1024));
    if !pass.is_empty() {
        opts = opts.user_and_password(user, pass);
    }
    let nats = Arc::new(opts.connect(&nats_url).await.context("подключение к NATS")?);
    info!("NATS подключён: {}", nats_url);
    // Протокол v2 (spec 007): общее состояние (описатель сервера, отзывы).
    let v2 = v2::Shared::start(nats.clone()).await.context("v2: подписка на отзывы")?;

    let max_conns = std::env::var("PARVANE_GATEWAY_MAX_CONNS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2000usize);
    let max_per_ip = std::env::var("PARVANE_GATEWAY_MAX_CONNS_PER_IP")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(64usize);
    let limits = Arc::new(Limits {
        conns: Arc::new(Semaphore::new(max_conns)),
        per_ip: Arc::new(Mutex::new(HashMap::new())),
        max_per_ip,
    });
    info!("Лимиты соединений: всего {}, на IP {}", max_conns, max_per_ip);

    // TCP-листенер (нативный клиент).
    let tcp = TcpListener::bind(&tcp_bind).await.context("bind TCP")?;
    info!("Gateway TCP на {}", tcp_bind);
    {
        let nats = nats.clone();
        let limits = limits.clone();
        let v2 = v2.clone();
        tokio::spawn(async move {
            loop {
                match tcp.accept().await {
                    Ok((stream, peer)) => {
                        let Some(guard) = admit(&limits, peer.ip()) else {
                            warn!("tcp {}: соединение отклонено (лимит)", peer);
                            continue; // stream дропается → сокет закрыт
                        };
                        let nats = nats.clone();
                        let v2 = v2.clone();
                        tokio::spawn(async move {
                            let _guard = guard;
                            if let Err(e) = handle_tcp(stream, nats, v2).await {
                                warn!("tcp {}: {}", peer, e);
                            }
                        });
                    }
                    Err(e) => warn!("tcp accept: {}", e),
                }
            }
        });
    }

    // WebSocket-листенер (будущие браузер/мобилки).
    let ws = TcpListener::bind(&ws_bind).await.context("bind WS")?;
    info!("Gateway WebSocket на {}", ws_bind);
    loop {
        let (stream, peer) = ws.accept().await?;
        let Some(guard) = admit(&limits, peer.ip()) else {
            warn!("ws {}: соединение отклонено (лимит)", peer);
            continue;
        };
        let nats = nats.clone();
        let v2 = v2.clone();
        tokio::spawn(async move {
            let _guard = guard;
            if let Err(e) = handle_ws(stream, nats, v2).await {
                warn!("ws {}: {}", peer, e);
            }
        });
    }
}

// ── адаптеры транспорта: превращают соединение в пару каналов кадров-строк ─────
