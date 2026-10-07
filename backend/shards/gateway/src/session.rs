//! Вход клиента: TCP и WebSocket. С отключением v1 (T110, 7 окт 2026) gateway
//! обслуживает только протокол v2 (`v2/`): TCP-соединение начинается с преамбулы
//! `PVN2`, WS — с двоичного кадра `Hello`. Прежний JSON-кадр v1 (строка по TCP,
//! текстовый кадр по WS) получает один ответ `{"op":"err","error":"upgrade_required"}`
//! — старый клиент показывает «обновите приложение» — и соединение закрывается.

use crate::*;

pub(crate) const V1_UPGRADE_REQUIRED: &str = "upgrade_required";

fn upgrade_required_frame() -> String {
    json!({"op":"err","error":V1_UPGRADE_REQUIRED}).to_string()
}

/// IP клиента для лимитов identity: X-Forwarded-For (первый адрес) доверяем
/// только если сам пир — loopback/приватная сеть (reverse-proxy), иначе — пир.
pub(crate) fn client_ip_from(peer: Option<IpAddr>, forwarded: Option<&str>) -> String {
    let peer_trusted = match peer {
        Some(IpAddr::V4(v4)) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        Some(IpAddr::V6(v6)) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        None => false,
    };
    if peer_trusted {
        if let Some(first) = forwarded
            .and_then(|f| f.split(',').next())
            .map(str::trim)
            .filter(|f| !f.is_empty() && f.parse::<IpAddr>().is_ok())
        {
            return first.to_string();
        }
    }
    peer.map(|p| p.to_string()).unwrap_or_default()
}

pub(crate) async fn handle_tcp(stream: TcpStream, v2: Arc<crate::v2::Shared>) -> Result<()> {
    let client_ip = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let (mut rd, mut wr) = stream.into_split();
    // Первые байты решают протокол: `PVN2` — v2, иначе — v1 (отказ).
    let mut pre: Vec<u8> = Vec::new();
    {
        let mut b = [0u8; 8192];
        let deadline = Instant::now() + Duration::from_secs(AUTH_TIMEOUT_SECS);
        while pre.len() < 4 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, rd.read(&mut b)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(n)) => pre.extend_from_slice(&b[..n]),
            }
            if pre.first().is_some_and(|c| *c != parvane_protocol::codec::TCP_MAGIC[0]) {
                break;
            }
        }
    }
    if pre.starts_with(parvane_protocol::codec::TCP_MAGIC) {
        let rest = pre[4..].to_vec();
        crate::v2::run_tcp(rest, rd, wr, v2, client_ip).await;
        return Ok(());
    }
    if pre.is_empty() {
        return Ok(()); // молчание до таймаута
    }
    let line = upgrade_required_frame() + "\n";
    let _ = tokio::time::timeout(Duration::from_secs(WRITER_FLUSH_SECS), wr.write_all(line.as_bytes())).await;
    Ok(())
}

pub(crate) async fn handle_ws(stream: TcpStream, v2: Arc<crate::v2::Shared>) -> Result<()> {
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(MAX_FRAME_BYTES),
        max_frame_size: Some(MAX_FRAME_BYTES),
        ..Default::default()
    };
    let peer_ip = stream.peer_addr().map(|a| a.ip()).ok();
    let mut forwarded: Option<String> = None;
    let ws = tokio_tungstenite::accept_hdr_async_with_config(
        stream,
        |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
         resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
            forwarded = req
                .headers()
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_string());
            Ok(resp)
        },
        Some(config),
    )
    .await
    .context("WS handshake")?;
    let client_ip = client_ip_from(peer_ip, forwarded.as_deref());
    let (mut write, mut read) = ws.split();
    // Первый кадр решает протокол: двоичный Hello → v2, текст (v1) → отказ.
    let first = match tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECS), read.next()).await {
        Ok(Some(Ok(m))) => m,
        _ => return Ok(()),
    };
    match first {
        WsMessage::Binary(b) => {
            crate::v2::run_ws(b, read, write, v2, client_ip).await;
        }
        WsMessage::Text(_) => {
            let _ = tokio::time::timeout(
                Duration::from_secs(WRITER_FLUSH_SECS),
                write.send(WsMessage::Text(upgrade_required_frame())),
            )
            .await;
            let _ = write.close().await;
        }
        _ => {}
    }
    Ok(())
}

/// Дослать хвост и завершить writer за ограниченное время (GW-02): клиент,
/// не читающий сокет, не должен держать задачу и слот соединения.
pub(crate) async fn finish_writer(mut writer: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(Duration::from_secs(WRITER_FLUSH_SECS), &mut writer).await.is_err() {
        writer.abort();
    }
}
