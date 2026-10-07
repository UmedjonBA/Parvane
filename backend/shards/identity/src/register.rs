//! Регистрация и подтверждение: e-mail код, Telegram deep link, статус, инвайты.

use crate::*;

pub(crate) async fn handle_register(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("register: нет reply-топика, игнорирую");
        return;
    };
    let resp = match do_register(pool, &msg.payload, confirm_mode()).await {
        Ok(out) => {
            if let Some((email, code)) = out.send {
                send_confirmation_email(email, code);
            }
            RegisterResponse {
                ok: true,
                error: None,
                confirm_required: out.confirm_required,
                telegram_token: out.telegram_token,
            }
        }
        Err(e) => RegisterResponse {
            ok: false,
            error: Some(parvane_db::public_error(&e)),
            confirm_required: false,
            telegram_token: None,
        },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("register: ошибка отправки ответа: {}", e);
    }
}

/// Итог регистрации: ждать ли код и какое письмо отправить.
#[derive(Debug)]
pub(crate) struct RegisterOutcome {
    pub(crate) confirm_required: bool,
    /// (email, код) для письма. None — подтверждение не требуется.
    pub(crate) send: Option<(String, String)>,
    /// Режим Telegram: токен deep link для бота.
    pub(crate) telegram_token: Option<String>,
}

/// Сколько живёт неподтверждённый аккаунт: после — логин можно занять заново
/// (иначе регистрация без подтверждения сквотила бы адреса навсегда).
pub(crate) const PENDING_TTL_SECS: i64 = 86_400;
/// Срок действия кода подтверждения.
pub(crate) const CODE_TTL_SECS: i64 = 900;
/// Срок действия токена Telegram deep link.
pub(crate) const TELEGRAM_LINK_TTL_SECS: i64 = 900;
/// Попыток ввода кода до принудительного перезапроса.
pub(crate) const CODE_MAX_ATTEMPTS: i64 = 5;

/// Создать аккаунт. Отвергает занятый логин, пустые поля, превышение лимита
/// попыток и (при PARVANE_INVITE_REQUIRED=1) отсутствие валидного инвайта.
/// В режимах Email/Telegram аккаунт создаётся неподтверждённым и ждёт кода с
/// почты либо Start в боте; повторный register с тем же паролем до
/// подтверждения — перевысылка кода / новый токен deep link.
pub(crate) async fn do_register(
    pool: &SqlitePool,
    payload: &[u8],
    mode: ConfirmMode,
) -> Result<RegisterOutcome> {
    let req: RegisterRequest = serde_json::from_slice(payload)
        .context("неверный JSON в RegisterRequest")?;

    let domain = server_domain();
    let user = canonical_user(&req.user, &domain);
    if req.user.trim().is_empty() || req.password.is_empty() {
        anyhow::bail!("пустой логин или пароль");
    }
    password_policy_ok(&req.password)?;
    if user.len() > 128 {
        anyhow::bail!("слишком длинный логин");
    }
    validate_new_user(&user, &domain)?;
    // По источнику (IP от gateway): пер-логин лимит не мешает спаму разными
    // логинами с одного адреса. Пусто — прямой NATS (dev), лимита по IP нет.
    // Дефолты с запасом на NAT (много людей за одним адресом). Идёт ПЕРЕД
    // глобальным счётчиком (ID-09): иначе один адрес 30 запросами в минуту
    // выедал общий потолок и закрывал регистрацию всем.
    if !req.client_ip.is_empty()
        && !window_rate_ok("register-ip", &req.client_ip, env_u64("PARVANE_REGISTER_RATE_IP", 30) as usize)
    {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }
    if !rate_ok(&user) {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }

    // Пустой email валиден только для перевысылки кода pending-аккаунту
    // (ниже), для новой регистрации проверяется перед INSERT.
    let email = req.email.trim().to_lowercase();

    // Неподтверждённый аккаунт: тот же пароль — перевысылаем код (пустой email
    // = на сохранённую почту, непустой — обновляем, вдруг была опечатка);
    // чужой просроченный — освобождаем логин.
    let existing: Option<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT password_hash, email_verified, created_at, email FROM users WHERE username = ?",
    )
    .bind(&user)
    .fetch_optional(pool)
    .await?;
    if let Some((hash, verified, created_at, stored_email)) = existing {
        if verified != 0 {
            anyhow::bail!("логин занят");
        }
        if verify_password(&req.password, &hash) {
            if mode == ConfirmMode::Telegram {
                let token = issue_telegram_token(pool, &user).await?;
                info!("Новый Telegram-токен для pending-аккаунта: {}", user);
                return Ok(RegisterOutcome {
                    confirm_required: true,
                    send: None,
                    telegram_token: Some(token),
                });
            }
            let email = if email.is_empty() { stored_email } else { email };
            if !valid_email(&email) {
                anyhow::bail!("нужен корректный email");
            }
            sqlx::query("UPDATE users SET email = ? WHERE username = ?")
                .bind(&email)
                .bind(&user)
                .execute(pool)
                .await?;
            let code = issue_email_code(pool, &user).await?;
            info!("Перевысылка кода подтверждения: {}", user);
            return Ok(RegisterOutcome {
                confirm_required: true,
                send: Some((email, code)),
                telegram_token: None,
            });
        }
        if now_unix() - created_at <= PENDING_TTL_SECS {
            anyhow::bail!("логин занят");
        }
        sqlx::query("DELETE FROM users WHERE username = ?")
            .bind(&user)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM email_codes WHERE username = ?")
            .bind(&user)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM telegram_links WHERE username = ?")
            .bind(&user)
            .execute(pool)
            .await?;
    }

    if mode == ConfirmMode::Email && !valid_email(&email) {
        anyhow::bail!("нужен корректный email");
    }

    // Инвайт-режим за флагом окружения (закрытый пузырь).
    if std::env::var("PARVANE_INVITE_REQUIRED").as_deref() == Ok("1")
        && !consume_invite(pool, &req.invite).await?
    {
        anyhow::bail!("нужен валидный инвайт-код");
    }

    let hash = hash_password(&req.password)?;
    let id = Uuid::now_v7().to_string();
    let now = now_unix();
    // Отображаемое имя по умолчанию — локальная часть адреса (до '@').
    let default_name = user.split('@').next().unwrap_or(&user).to_string();
    sqlx::query(
        "INSERT INTO users (id, username, password_hash, created_at, display_name, email, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user)
    .bind(&hash)
    .bind(now)
    .bind(&default_name)
    .bind(&email)
    .bind(if mode == ConfirmMode::None { 1 } else { 0 })
    .execute(pool)
    .await?;

    match mode {
        ConfirmMode::Email => {
            let code = issue_email_code(pool, &user).await?;
            info!("Пользователь зарегистрирован, ждёт подтверждения почты: {}", user);
            Ok(RegisterOutcome { confirm_required: true, send: Some((email, code)), telegram_token: None })
        }
        ConfirmMode::Telegram => {
            let token = issue_telegram_token(pool, &user).await?;
            info!("Пользователь зарегистрирован, ждёт подтверждения в Telegram: {}", user);
            Ok(RegisterOutcome { confirm_required: true, send: None, telegram_token: Some(token) })
        }
        ConfirmMode::None => {
            info!("Пользователь зарегистрирован: {} (имя: {})", user, default_name);
            Ok(RegisterOutcome { confirm_required: false, send: None, telegram_token: None })
        }
    }
}

// ── подтверждение через Telegram-бота ────────────────────────────────────────

/// Новый токен deep link для pending-аккаунта (прежний перестаёт действовать).
pub(crate) async fn issue_telegram_token(pool: &SqlitePool, user: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    sqlx::query(
        "INSERT INTO telegram_links (username, token, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at",
    )
    .bind(user)
    .bind(&token)
    .bind(now_unix() + TELEGRAM_LINK_TTL_SECS)
    .execute(pool)
    .await?;
    Ok(token)
}

/// Сравнение секретов без ранней остановки (по длине и по байтам).
pub(crate) fn secret_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

pub(crate) async fn handle_telegram_confirm(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("telegram.confirm: нет reply-топика, игнорирую");
        return;
    };
    let resp = match do_telegram_confirm(pool, &msg.payload, telegram_secret().as_deref()).await {
        Ok((user, kind)) => TelegramConfirmResponse {
            ok: true, error: None, user: Some(user), kind: Some(kind.to_string()),
        },
        Err(e) => TelegramConfirmResponse { ok: false, error: Some(parvane_db::public_error(&e)), user: None, kind: None },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("telegram.confirm: ошибка отправки ответа: {}", e);
    }
}

/// Бот прислал `/start <token>`: привязать Telegram к pending-аккаунту и
/// подтвердить его. Один Telegram — один аккаунт; повторный Start тем же
/// Telegram по своей же ссылке идемпотентен.
pub(crate) async fn do_telegram_confirm(pool: &SqlitePool, payload: &[u8], secret: Option<&str>) -> Result<(String, &'static str)> {
    let req: TelegramConfirmRequest = serde_json::from_slice(payload)
        .context("неверный JSON в TelegramConfirmRequest")?;
    let Some(secret) = secret else {
        anyhow::bail!("подтверждение через Telegram не включено");
    };
    // P-43: pre-auth subject без лимита позволял онлайн-перебор секрета бота.
    if !req.client_ip.is_empty()
        && !window_rate_ok("tg-confirm-ip", &req.client_ip, env_u64("PARVANE_TG_CONFIRM_RATE_IP", 10) as usize)
    {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }
    if !secret_matches(&req.secret, secret) {
        anyhow::bail!("неверный секрет бота");
    }
    let token = req.token.trim();
    if token.is_empty() || req.telegram_id <= 0 {
        anyhow::bail!("пустой токен или telegram_id");
    }
    let link: Option<(String, i64)> =
        sqlx::query_as("SELECT username, expires_at FROM telegram_links WHERE token = ?")
            .bind(token)
            .fetch_optional(pool)
            .await?;
    let Some((user, expires_at)) = link else {
        // Не регистрация — может быть токен двухфакторного входа
        return confirm_login_link(pool, token, req.telegram_id).await.map(|user| (user, "login"));
    };
    if now_unix() > expires_at {
        anyhow::bail!("ссылка устарела, начните регистрацию заново");
    }
    let bound: Option<(String,)> =
        sqlx::query_as("SELECT username FROM users WHERE telegram_id = ? AND username != ?")
            .bind(req.telegram_id)
            .bind(&user)
            .fetch_optional(pool)
            .await?;
    if bound.is_some() {
        anyhow::bail!("этот Telegram уже привязан к другому аккаунту");
    }
    let current: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT email_verified, telegram_id FROM users WHERE username = ?")
            .bind(&user)
            .fetch_optional(pool)
            .await?;
    let Some((verified, telegram_id)) = current else {
        anyhow::bail!("аккаунт не найден");
    };
    if verified != 0 && telegram_id.is_some_and(|id| id != req.telegram_id) {
        anyhow::bail!("аккаунт уже подтверждён другим Telegram");
    }
    sqlx::query("UPDATE users SET email_verified = 1, telegram_id = ? WHERE username = ?")
        .bind(req.telegram_id)
        .bind(&user)
        .execute(pool)
        .await?;
    info!("Аккаунт {} подтверждён через Telegram ({} {})", user, req.telegram_id, req.telegram_name);
    Ok((user, "register"))
}

/// Токен двухфакторного входа: подтвердить может ТОЛЬКО привязанный Telegram
/// (иначе пароль + любой Telegram обходили бы второй фактор).
pub(crate) async fn confirm_login_link(pool: &SqlitePool, token: &str, telegram_id: i64) -> Result<String> {
    let row: Option<(String, i64, i64)> =
        sqlx::query_as("SELECT username, expires_at, confirmed FROM login_links WHERE token = ?")
            .bind(token)
            .fetch_optional(pool)
            .await?;
    let Some((user, expires_at, confirmed)) = row else {
        anyhow::bail!("ссылка не найдена или уже использована");
    };
    if now_unix() > expires_at {
        anyhow::bail!("ссылка входа устарела, войдите заново");
    }
    let linked: Option<(Option<i64>,)> = sqlx::query_as("SELECT telegram_id FROM users WHERE username = ?")
        .bind(&user)
        .fetch_optional(pool)
        .await?;
    let Some((Some(linked_id),)) = linked else {
        anyhow::bail!("к аккаунту не привязан Telegram");
    };
    if linked_id != telegram_id {
        anyhow::bail!("подтвердить вход может только Telegram, привязанный к аккаунту");
    }
    if confirmed == 0 {
        sqlx::query("UPDATE login_links SET confirmed = 1 WHERE token = ?").bind(token).execute(pool).await?;
        info!("Вход {} подтверждён в Telegram ({})", user, telegram_id);
    }
    Ok(user)
}

pub(crate) async fn handle_register_status(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("register.status: нет reply-топика, игнорирую");
        return;
    };
    let confirmed = do_register_status(pool, &msg.payload).await.unwrap_or(false);
    let json = serde_json::to_vec(&RegisterStatusResponse { confirmed }).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("register.status: ошибка отправки ответа: {}", e);
    }
}

/// Подтверждён ли pending-аккаунт. Токен обязателен: без него любой мог бы
/// зондировать статус чужого ника.
pub(crate) async fn do_register_status(pool: &SqlitePool, payload: &[u8]) -> Result<bool> {
    let req: RegisterStatusRequest = serde_json::from_slice(payload)
        .context("неверный JSON в RegisterStatusRequest")?;
    let user = canonical_user(&req.user, &server_domain());
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT u.email_verified FROM users u
         JOIN telegram_links l ON l.username = u.username
         WHERE u.username = ? AND l.token = ?",
    )
    .bind(&user)
    .bind(req.token.trim())
    .fetch_optional(pool)
    .await?;
    if let Some((verified,)) = row {
        return Ok(verified != 0);
    }
    // Токен двухфакторного входа: подтверждён ли Start в привязанном Telegram
    let login: Option<(i64,)> = sqlx::query_as(
        "SELECT confirmed FROM login_links WHERE username = ? AND token = ? AND expires_at >= ?",
    )
    .bind(&user)
    .bind(req.token.trim())
    .bind(now_unix())
    .fetch_optional(pool)
    .await?;
    Ok(login.is_some_and(|(confirmed,)| confirmed != 0))
}

/// Минимальная проверка адреса почты (полная валидация — задача SMTP-сервера).
pub(crate) fn valid_email(email: &str) -> bool {
    if email.len() < 5 || email.len() > 254 || email.contains(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
}

/// Сгенерировать 6-значный код, сохранить его argon2-хэш (upsert) и вернуть
/// открытый код для письма. Прежний код перестаёт действовать.
pub(crate) async fn issue_email_code(pool: &SqlitePool, user: &str) -> Result<String> {
    use rand::Rng;
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
    let hash = hash_password(&code)?;
    let now = now_unix();
    sqlx::query(
        "INSERT INTO email_codes (username, code_hash, expires_at, attempts, sent_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(username) DO UPDATE SET
            code_hash = excluded.code_hash,
            expires_at = excluded.expires_at,
            attempts = 0,
            sent_at = excluded.sent_at",
    )
    .bind(user)
    .bind(&hash)
    .bind(now + CODE_TTL_SECS)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(code)
}

/// Отправить письмо с кодом. Без PARVANE_SMTP_HOST — dev-режим: код в лог
/// (локальная разработка и e2e). Отправка — в отдельной таске, чтобы медленный
/// SMTP не блокировал цикл обработки шины.
pub(crate) fn send_confirmation_email(email: String, code: String) {
    let Some(host) = std::env::var("PARVANE_SMTP_HOST").ok().filter(|h| !h.is_empty()) else {
        // P-42: код в лог — только в dev-режиме (PARVANE_DEV=1, локальный стенд/e2e)
        if std::env::var("PARVANE_DEV").ok().as_deref() == Some("1") {
            info!("dev-режим SMTP: код подтверждения для {}: {}", email, code);
        } else {
            warn!("SMTP не настроен (PARVANE_SMTP_HOST): код подтверждения для {} не отправлен", email);
        }
        return;
    };
    tokio::spawn(async move {
        match smtp_send(&host, &email, &code).await {
            Ok(()) => info!("Код подтверждения отправлен на {}", email),
            Err(e) => error!("не удалось отправить письмо на {}: {}", email, e),
        }
    });
}

pub(crate) async fn smtp_send(host: &str, email: &str, code: &str) -> Result<()> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    let port: u16 = std::env::var("PARVANE_SMTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(587);
    let smtp_user = std::env::var("PARVANE_SMTP_USER").unwrap_or_default();
    let smtp_pass = std::env::var("PARVANE_SMTP_PASS").unwrap_or_default();
    let from = std::env::var("PARVANE_SMTP_FROM").unwrap_or_else(|_| smtp_user.clone());

    let message = Message::builder()
        .from(from.parse().context("PARVANE_SMTP_FROM: неверный адрес")?)
        .to(email.parse().context("неверный адрес получателя")?)
        .subject("Parvane: код подтверждения")
        .body(format!(
            "Ваш код подтверждения: {code}\n\nКод действует {} минут. Если вы не \
             регистрировались в Parvane — просто проигнорируйте это письмо.",
            CODE_TTL_SECS / 60
        ))
        .context("сборка письма")?;

    // 465 — implicit TLS, иначе STARTTLS (587 и т.п.).
    let mut builder = if port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host).context("SMTP relay")?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host).context("SMTP starttls")?
    };
    builder = builder.port(port);
    if !smtp_user.is_empty() {
        builder = builder.credentials(Credentials::new(smtp_user, smtp_pass));
    }
    builder.build().send(message).await.context("отправка SMTP")?;
    Ok(())
}

// ── подтверждение почты ───────────────────────────────────────────────────────

pub(crate) async fn handle_email_confirm(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("email.confirm: нет reply-топика, игнорирую");
        return;
    };
    let resp = match do_email_confirm(pool, &msg.payload).await {
        Ok(()) => EmailConfirmResponse { ok: true, error: None },
        Err(e) => EmailConfirmResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("email.confirm: ошибка отправки ответа: {}", e);
    }
}

/// Проверить код из письма и подтвердить аккаунт. Код одноразовый, живёт
/// CODE_TTL_SECS, до CODE_MAX_ATTEMPTS попыток; счётчик атомарный (UPDATE …
/// RETURNING), поэтому перебор параллельными запросами не обходит лимит.
pub(crate) async fn do_email_confirm(pool: &SqlitePool, payload: &[u8]) -> Result<()> {
    let req: EmailConfirmRequest = serde_json::from_slice(payload)
        .context("неверный JSON в EmailConfirmRequest")?;
    let user = canonical_user(&req.user, &server_domain());
    let code = req.code.trim().to_string();
    if req.user.trim().is_empty() || code.is_empty() {
        anyhow::bail!("пустой логин или код");
    }
    // P-43: аноним мог 6 запросами по чужому нику сжечь попытки кода жертвы.
    if !req.client_ip.is_empty()
        && !window_rate_ok("email-confirm-ip", &req.client_ip, env_u64("PARVANE_EMAIL_CONFIRM_RATE_IP", 20) as usize)
    {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }

    let row: Option<(String, i64, i64)> = sqlx::query_as(
        "UPDATE email_codes SET attempts = attempts + 1 WHERE username = ?
         RETURNING code_hash, expires_at, attempts",
    )
    .bind(&user)
    .fetch_optional(pool)
    .await?;
    let Some((hash, expires_at, attempts)) = row else {
        anyhow::bail!("код не запрошен или уже использован");
    };
    if now_unix() > expires_at {
        anyhow::bail!("код истёк, запросите новый");
    }
    if attempts > CODE_MAX_ATTEMPTS {
        anyhow::bail!("слишком много попыток, запросите новый код");
    }
    if !verify_password(&code, &hash) {
        anyhow::bail!("неверный код");
    }

    sqlx::query("UPDATE users SET email_verified = 1 WHERE username = ?")
        .bind(&user)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM email_codes WHERE username = ?")
        .bind(&user)
        .execute(pool)
        .await?;
    info!("Почта подтверждена: {}", user);
    Ok(())
}

/// Использовать инвайт-код (одноразовый). true — код существовал и не был
/// использован (пометили использованным). Только при инвайт-режиме.
pub(crate) async fn consume_invite(pool: &SqlitePool, code: &str) -> Result<bool> {
    if code.is_empty() {
        return Ok(false);
    }
    let res = sqlx::query(
        "UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL",
    )
    .bind(now_unix())
    .bind(code)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}
