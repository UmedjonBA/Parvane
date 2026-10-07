//! Сессия клиента: TCP/WS, авторизация, переверификация токена, sub/pub/req к NATS.

use crate::*;

pub(crate) async fn handle_tcp(stream: TcpStream, nats: Arc<Client>, v2: Arc<crate::v2::Shared>) -> Result<()> {
    let client_ip = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let (mut rd, mut wr) = stream.into_split();
    // Двойной стек (spec 007): v2-соединение начинается с преамбулы `PVN2`,
    // v1 — с построчного JSON (`{`). Первые байты читаются до решения.
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
    let (in_tx, in_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    // Построчное чтение с жёстким лимитом длины кадра: кадр без разделителя,
    // превысивший MAX_FRAME_BYTES, рвёт соединение (защита от OOM). Ранее
    // BufReader::lines читал строку неограниченной длины.
    tokio::spawn(async move {
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        let mut first = Some(pre);
        loop {
            let chunk: Vec<u8> = if let Some(p) = first.take() {
                p
            } else {
                match rd.read(&mut buf).await {
                    Ok(0) => break, // EOF
                    Ok(n) => buf[..n].to_vec(),
                    Err(_) => break,
                }
            };
            for &byte in &chunk {
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
    finish_writer(writer).await;
    Ok(())
}

/// Дослать хвост и завершить writer за ограниченное время (GW-02): клиент,
/// не читающий сокет, не должен держать задачу и слот соединения.
pub(crate) async fn finish_writer(mut writer: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(Duration::from_secs(WRITER_FLUSH_SECS), &mut writer).await.is_err() {
        writer.abort();
    }
}

pub(crate) async fn handle_ws(stream: TcpStream, nats: Arc<Client>, v2: Arc<crate::v2::Shared>) -> Result<()> {
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
    // Двойной стек (spec 007): первый кадр решает версию — двоичный Hello → v2,
    // текст `{"op":"auth"…}` → v1 без изменений.
    let first = match tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECS), read.next()).await {
        Ok(Some(Ok(m))) => m,
        _ => return Ok(()),
    };
    let first_text = match first {
        WsMessage::Binary(b) => {
            crate::v2::run_ws(b, read, write, v2, client_ip).await;
            return Ok(());
        }
        WsMessage::Text(t) => t,
        _ => return Ok(()),
    };
    let (in_tx, in_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    if in_tx.send(first_text).await.is_err() {
        return Ok(());
    }
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
    finish_writer(writer).await;
    Ok(())
}

/// Режим v1-пути (E6, T110): `PARVANE_V1_MODE` = `normal` (по умолчанию) |
/// `notice` (после входа — кадр `{"op":"notice","kind":"upgrade_available"}`) |
/// `disabled` (v1-соединение сразу получает `upgrade_required` и закрывается).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum V1Mode {
    Normal,
    Notice,
    Disabled,
}

pub(crate) fn parse_v1_mode(v: Option<&str>) -> V1Mode {
    match v.map(str::trim) {
        Some("notice") => V1Mode::Notice,
        Some("disabled") => V1Mode::Disabled,
        _ => V1Mode::Normal,
    }
}

pub(crate) fn v1_mode() -> V1Mode {
    static MODE: std::sync::OnceLock<V1Mode> = std::sync::OnceLock::new();
    *MODE.get_or_init(|| {
        let m = parse_v1_mode(std::env::var("PARVANE_V1_MODE").ok().as_deref());
        if m != V1Mode::Normal {
            info!("gateway: v1-путь в режиме {:?}", m);
        }
        m
    })
}

pub(crate) const V1_UPGRADE_REQUIRED: &str = "upgrade_required";

pub(crate) async fn serve(
    mut in_rx: mpsc::Receiver<String>,
    tx: mpsc::Sender<String>,
    nats: Arc<Client>,
    client_ip: String,
) {
    // E6: v1 отключён — клиент получает код и показывает «обновите приложение»
    if v1_mode() == V1Mode::Disabled {
        let _ = tx.send(json!({"op":"err","error":V1_UPGRADE_REQUIRED}).to_string()).await;
        return;
    }
    // 1) pre-auth: до авторизации разрешены ТОЛЬКО bootstrap-запросы (логин и
    // регистрация — иначе получить токен через gateway было бы невозможно).
    // Всё остальное — после auth с валидным JWT. На всю фазу — idle-timeout:
    // соединение, не авторизовавшееся за AUTH_TIMEOUT_SECS, закрывается.
    let auth_deadline = Instant::now() + Duration::from_secs(AUTH_TIMEOUT_SECS);
    let mut pre = pre_auth_bucket();
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
                    if v1_mode() == V1Mode::Notice {
                        let _ = tx.send(json!({"op":"notice","kind":"upgrade_available"}).to_string()).await;
                    }
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
                if !pre.try_take() {
                    let _ = tx.send(err_frame(v["id"].as_str(), RATE_LIMITED)).await;
                    continue;
                }
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
    // GW-01: задача подписки, не сумевшая отдать кадр клиенту за SLOW_READER_SECS,
    // будит это уведомление — сессия закрывается, а не копит очередь.
    let slow_reader = Arc::new(tokio::sync::Notify::new());
    // P-06: токен верифицируется не только при auth. Периодически (и по факту
    // истечения) перепроверяем его через identity; отозванное устройство или
    // протухший JWT рвут соединение, а не живут до 24 ч.
    let mut reverify = tokio::time::interval(Duration::from_secs(reverify_secs()));
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
            _ = slow_reader.notified() => {
                warn!("клиент {} не читает кадры подписок — сессия закрыта", user);
                break;
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
                let payload = if subject == IDENTITY_ISSUE
                    || subject == IDENTITY_REGISTER
                    || subject == IDENTITY_TELEGRAM_CONFIRM
                    || subject == IDENTITY_EMAIL_CONFIRM
                {
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
                // GW-08: отклонённая подписка на чужой typing-канал каждый раз
                // стоила запроса `group.list` — лимит частоты как у запросов
                if !rate.allow(&subject) {
                    let _ = tx.send(err_frame(None, RATE_LIMITED)).await;
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
                        let slow = slow_reader.clone();
                        subs.push(tokio::spawn(async move {
                            while let Some(m) = sub.next().await {
                                let p = String::from_utf8_lossy(&m.payload).to_string();
                                let frame =
                                    json!({"op":"msg","subject":m.subject.as_str(),"payload":p})
                                        .to_string();
                                match tokio::time::timeout(Duration::from_secs(SLOW_READER_SECS), tx2.send(frame)).await {
                                    Ok(Ok(())) => {}
                                    Ok(Err(_)) => break,
                                    Err(_) => {
                                        slow.notify_one();
                                        break;
                                    }
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
