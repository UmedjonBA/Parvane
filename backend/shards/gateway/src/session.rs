//! Сессия клиента: TCP/WS, авторизация, переверификация токена, sub/pub/req к NATS.

use crate::*;

pub(crate) async fn handle_tcp(stream: TcpStream, nats: Arc<Client>) -> Result<()> {
    let client_ip = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let (mut rd, mut wr) = stream.into_split();
    let (in_tx, in_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    // Построчное чтение с жёстким лимитом длины кадра: кадр без разделителя,
    // превысивший MAX_FRAME_BYTES, рвёт соединение (защита от OOM). Ранее
    // BufReader::lines читал строку неограниченной длины.
    tokio::spawn(async move {
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = match rd.read(&mut buf).await {
                Ok(0) => break, // EOF
                Ok(n) => n,
                Err(_) => break,
            };
            for &byte in &buf[..n] {
                if byte == b'\n' {
                    let line = String::from_utf8_lossy(&acc).trim().to_string();
                    acc.clear();
                    if !line.is_empty() && in_tx.send(line).await.is_err() {
                        return;
                    }
                } else {
                    if acc.len() >= MAX_FRAME_BYTES {
                        return; // кадр слишком длинный — закрываем сокет
                    }
                    acc.push(byte);
                }
            }
        }
    });
    let (out_tx, mut out_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    let writer = tokio::spawn(async move {
        while let Some(mut s) = out_rx.recv().await {
            s.push('\n');
            if wr.write_all(s.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    serve(in_rx, out_tx, nats, client_ip).await;
    let _ = writer.await;
    Ok(())
}

pub(crate) async fn handle_ws(stream: TcpStream, nats: Arc<Client>) -> Result<()> {
    // Ограничиваем размер сообщения/кадра WS на уровне протокола (симметрично TCP).
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(MAX_FRAME_BYTES);
    config.max_frame_size = Some(MAX_FRAME_BYTES);
    // Адрес клиента: за reverse-proxy (Caddy в проде) реальный IP приходит в
    // X-Forwarded-For — берём его только от приватного/loopback пира (сам прокси),
    // иначе клиент мог бы подставить любой IP и обойти лимиты identity.
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
    let (in_tx, in_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    tokio::spawn(async move {
        while let Some(m) = read.next().await {
            match m {
                Ok(WsMessage::Text(t)) => {
                    if in_tx.send(t).await.is_err() {
                        break;
                    }
                }
                Ok(WsMessage::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });
    let (out_tx, mut out_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    let writer = tokio::spawn(async move {
        while let Some(s) = out_rx.recv().await {
            if write.send(WsMessage::Text(s)).await.is_err() {
                break;
            }
        }
    });
    serve(in_rx, out_tx, nats, client_ip).await;
    let _ = writer.await;
    Ok(())
}

pub(crate) async fn serve(
    mut in_rx: mpsc::Receiver<String>,
    tx: mpsc::Sender<String>,
    nats: Arc<Client>,
    client_ip: String,
) {
    // 1) pre-auth: до авторизации разрешены ТОЛЬКО bootstrap-запросы (логин и
    // регистрация — иначе получить токен через gateway было бы невозможно).
    // Всё остальное — после auth с валидным JWT. На всю фазу — idle-timeout:
    // соединение, не авторизовавшееся за AUTH_TIMEOUT_SECS, закрывается.
    let auth_deadline = Instant::now() + Duration::from_secs(AUTH_TIMEOUT_SECS);
    let (user, auth_token) = loop {
        let remaining = auth_deadline.saturating_duration_since(Instant::now());
        let text = match tokio::time::timeout(remaining, in_rx.recv()).await {
            Ok(Some(text)) => text,
            Ok(None) => return, // закрыто до auth
            Err(_) => {
                let _ = tx.send(err_frame(None, "таймаут авторизации")).await;
                return; // не авторизовался вовремя — рвём соединение
            }
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        match v["op"].as_str().unwrap_or("") {
            "auth" => match verify_token(&nats, v["token"].as_str().unwrap_or("")).await {
                Ok(u) => {
                    let token = v["token"].as_str().unwrap_or("").to_string();
                    let _ = tx.send(json!({"op":"auth_ok","user":u}).to_string()).await;
                    break (u, token);
                }
                Err(e) => {
                    let _ = tx
                        .send(json!({"op":"auth_err","error":e.to_string()}).to_string())
                        .await;
                    return;
                }
            },
            "req" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                if subject == IDENTITY_ISSUE
                    || subject == IDENTITY_REGISTER
                    || subject == IDENTITY_EMAIL_CONFIRM
                    || subject == IDENTITY_SERVER_INFO
                    || subject == IDENTITY_TELEGRAM_CONFIRM
                    || subject == IDENTITY_REGISTER_STATUS
                {
                    let payload = v["payload"].as_str().unwrap_or("");
                    // P-43: IP клиента подмешиваем во ВСЕ pre-auth bootstrap-запросы с
                    // лимитами в identity (перебор секрета бота / сжигание попыток кода).
                    let payload = if subject == IDENTITY_ISSUE
                        || subject == IDENTITY_REGISTER
                        || subject == IDENTITY_TELEGRAM_CONFIRM
                        || subject == IDENTITY_EMAIL_CONFIRM
                    {
                        inject_client_ip(payload, &client_ip)
                    } else {
                        payload.to_string()
                    };
                    spawn_req(
                        nats.clone(),
                        tx.clone(),
                        v["id"].as_str().unwrap_or("").to_string(),
                        subject,
                        payload,
                        clamp_timeout(v["timeout_ms"].as_u64().unwrap_or(3000)),
                    );
                } else {
                    let _ = tx.send(err_frame(v["id"].as_str(), "нужна авторизация")).await;
                }
            }
            _ => {
                let _ = tx.send(err_frame(None, "нужна авторизация")).await;
            }
        }
    };
    info!("Клиент авторизован: {}", user);

    let mut subs: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    let mut sub_subjects: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 2) основной цикл
    let mut rate = SessionRate::from_env();
    // P-06: токен верифицируется не только при auth. Периодически (и по факту
    // истечения) перепроверяем его через identity; отозванное устройство или
    // протухший JWT рвут соединение, а не живут до 24 ч.
    let mut reverify = tokio::time::interval(Duration::from_secs(REVERIFY_SECS));
    reverify.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reverify.tick().await; // первый тик — немедленный, пропускаем
    loop {
        let text = tokio::select! {
            maybe = in_rx.recv() => match maybe {
                Some(text) => text,
                None => break,
            },
            _ = reverify.tick() => {
                if verify_token(&nats, &auth_token).await.is_err() {
                    let _ = tx
                        .send(json!({"op":"auth_err","error":"сессия недействительна (устройство отозвано или токен истёк)"}).to_string())
                        .await;
                    break;
                }
                continue;
            }
        };
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                let _ = tx.send(err_frame(None, "битый json")).await;
                continue;
            }
        };
        match v["op"].as_str().unwrap_or("") {
            "pub" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                if !rate.allow(&subject) {
                    warn!("rate limit: {} pub {}", user, subject);
                    let _ = tx.send(json!({"op":"err","error":RATE_LIMITED,"subject":subject}).to_string()).await;
                    continue;
                }
                if allowed_pub(&user, &subject) {
                    match bind_client_payload(
                        &user,
                        &auth_token,
                        &subject,
                        v["payload"].as_str().unwrap_or(""),
                    ) {
                        Ok(payload) => {
                            let _ = nats.publish(subject, payload.into()).await;
                        }
                        Err(e) => {
                            let _ = tx.send(err_frame(None, &e.to_string())).await;
                        }
                    }
                } else {
                    let _ = tx.send(err_frame(None, "publish в этот subject запрещён")).await;
                }
            }
            "req" => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let timeout = clamp_timeout(v["timeout_ms"].as_u64().unwrap_or(3000));
                if !allowed_req(&user, &subject) {
                    let _ = tx.send(err_frame(Some(&id), "request запрещён")).await;
                    continue;
                }
                if !rate.allow(&subject) {
                    warn!("rate limit: {} req {}", user, subject);
                    let _ = tx.send(err_frame(Some(&id), RATE_LIMITED)).await;
                    continue;
                }
                let payload = match bind_client_payload(
                    &user,
                    &auth_token,
                    &subject,
                    v["payload"].as_str().unwrap_or(""),
                ) {
                    Ok(payload) => payload,
                    Err(e) => {
                        let _ = tx.send(err_frame(Some(&id), &e.to_string())).await;
                        continue;
                    }
                };
                // P-20: issue/register доступны и после auth — без client_ip identity
                // считал их «прямым NATS» и не применял IP-лимит (password spraying
                // из любого аккаунта). Подмешиваем IP и здесь.
                let payload = if subject == IDENTITY_ISSUE || subject == IDENTITY_REGISTER {
                    inject_client_ip(&payload, &client_ip)
                } else {
                    payload
                };
                spawn_req(nats.clone(), tx.clone(), id, subject, payload, timeout);
            }
            // Множественные ответы на один запрос (chunked download): собираем
            // все ответы на приватный inbox до тишины (timeout между ответами)
            // и завершаем reply_end.
            "reqmany" => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let timeout = clamp_timeout(v["timeout_ms"].as_u64().unwrap_or(5000));
                if !allowed_req(&user, &subject) {
                    let _ = tx.send(err_frame(Some(&id), "request запрещён")).await;
                    continue;
                }
                if !rate.allow(&subject) {
                    warn!("rate limit: {} reqmany {}", user, subject);
                    let _ = tx.send(err_frame(Some(&id), RATE_LIMITED)).await;
                    continue;
                }
                let payload = match bind_client_payload(
                    &user,
                    &auth_token,
                    &subject,
                    v["payload"].as_str().unwrap_or(""),
                ) {
                    Ok(payload) => payload,
                    Err(e) => {
                        let _ = tx.send(err_frame(Some(&id), &e.to_string())).await;
                        continue;
                    }
                };
                let nats2 = nats.clone();
                let tx2 = tx.clone();
                tokio::spawn(async move {
                    if let Err(e) = reqmany(&nats2, &tx2, &id, subject, payload, timeout).await {
                        let _ = tx2.send(err_frame(Some(&id), &e.to_string())).await;
                    }
                    let _ = tx2.send(json!({"op":"reply_end","id":id}).to_string()).await;
                });
            }
            "sub" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                // P-33: дедуп и кап подписок на сессию — тысячи sub'ов
                // раздували память gateway/NATS
                if sub_subjects.contains(&subject) {
                    continue;
                }
                if sub_subjects.len() >= MAX_SUBS_PER_SESSION {
                    let _ = tx.send(err_frame(None, "слишком много подписок на сессию")).await;
                    continue;
                }
                let allowed = allowed_sub(&user, &subject)
                    || (subject.starts_with(MSG_TYPING_PREFIX)
                        && group_typing_allowed(&nats, &auth_token, &subject).await);
                if !allowed {
                    let _ = tx.send(err_frame(None, "подписка на чужой/запрещённый subject")).await;
                    continue;
                }
                match nats.subscribe(subject.clone()).await {
                    Ok(mut sub) => {
                        sub_subjects.insert(subject);
                        let tx2 = tx.clone();
                        subs.push(tokio::spawn(async move {
                            while let Some(m) = sub.next().await {
                                let p = String::from_utf8_lossy(&m.payload).to_string();
                                let frame =
                                    json!({"op":"msg","subject":m.subject.as_str(),"payload":p})
                                        .to_string();
                                if tx2.send(frame).await.is_err() {
                                    break;
                                }
                            }
                        }));
                    }
                    Err(_) => {
                        let _ = tx.send(err_frame(None, "не удалось подписаться")).await;
                    }
                }
            }
            _ => {
                let _ = tx.send(err_frame(None, "неизвестный op")).await;
            }
        }
    }

    for h in subs {
        h.abort();
    }
    info!("Клиент отключился: {}", user);
}

pub(crate) async fn reqmany(
    nats: &Client,
    tx: &mpsc::Sender<String>,
    id: &str,
    subject: String,
    payload: String,
    timeout_ms: u64,
) -> Result<()> {
    let inbox = nats.new_inbox();
    let mut sub = nats.subscribe(inbox.clone()).await?;
    nats.publish_with_reply(subject, inbox, payload.into()).await?;
    let per = Duration::from_millis(timeout_ms);
    // тишина/конец — завершаем (reply_end шлёт вызывающий)
    while let Ok(Some(m)) = tokio::time::timeout(per, sub.next()).await {
        let p = String::from_utf8_lossy(&m.payload).to_string();
        let _ = tx.send(json!({"op":"reply","id":id,"payload":p}).to_string()).await;
    }
    Ok(())
}

pub(crate) async fn verify_token(nats: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = tokio::time::timeout(
        Duration::from_secs(3),
        nats.request(IDENTITY_VERIFY, req.into()),
    )
    .await
    .map_err(|_| anyhow!("таймаут верификации токена"))?
    .context("запрос к identity")?;
    let resp: VerifyResponse =
        serde_json::from_slice(&reply.payload).context("ответ identity: неверный JSON")?;
    if resp.ok {
        resp.user.ok_or_else(|| anyhow!("identity вернул ok без user"))
    } else {
        Err(anyhow!(resp.error.unwrap_or_else(|| "невалидный токен".into())))
    }
}

/// Одиночный request/reply → отдельным таском (не блокирует цикл чтения).
pub(crate) fn spawn_req(
    nats: Arc<Client>,
    tx: mpsc::Sender<String>,
    id: String,
    subject: String,
    payload: String,
    timeout_ms: u64,
) {
    tokio::spawn(async move {
        let fut = nats.request(subject, payload.into());
        match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
            Ok(Ok(reply)) => {
                let p = String::from_utf8_lossy(&reply.payload).to_string();
                let _ = tx.send(json!({"op":"reply","id":id,"payload":p}).to_string()).await;
            }
            _ => {
                let _ = tx.send(err_frame(Some(&id), "нет ответа / таймаут")).await;
            }
        }
    });
}

pub(crate) fn err_frame(id: Option<&str>, msg: &str) -> String {
    match id {
        Some(i) => json!({"op":"err","id":i,"error":msg}).to_string(),
        None => json!({"op":"err","error":msg}).to_string(),
    }
}

// ── права (изоляция «людей») — чистые функции, покрыты тестами ────────────────
