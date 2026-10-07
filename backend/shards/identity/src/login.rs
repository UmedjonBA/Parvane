//! Вход: identity.token.issue, смена пароля, 2FA (P-07/P-15/P-43).

use crate::*;

pub(crate) async fn handle_issue(
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
        Ok(IssueOutcome::Token { token, trust_secret }) => IssueResponse {
            ok: true, token: Some(token), error: None, twofa_required: false, login_token: None, telegram_bot: None,
            trust_secret,
        },
        Ok(IssueOutcome::TwoFactor { login_token }) => IssueResponse {
            ok: false,
            token: None,
            error: Some("нужно подтверждение входа в Telegram".into()),
            twofa_required: true,
            login_token: Some(login_token),
            telegram_bot: telegram_bot(),
            trust_secret: None,
        },
        Err(e) => {
            error!("issue error: {}", e);
            IssueResponse {
                ok: false, token: None, error: Some(parvane_db::public_error(&e)), twofa_required: false, login_token: None, telegram_bot: None,
                trust_secret: None,
            }
        }
    };

    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("issue: ошибка отправки ответа: {}", e);
    }
}

/// Срок действия токена подтверждения входа (deep link боту).
pub(crate) const LOGIN_LINK_TTL_SECS: i64 = 600;

pub(crate) async fn do_issue(pool: &SqlitePool, encoding: &EncodingKey, payload: &[u8]) -> Result<IssueOutcome> {
    let mut req: IssueRequest = serde_json::from_slice(payload)
        .context("неверный JSON в IssueRequest")?;
    req.user = canonical_user(&req.user, &server_domain());

    // ID-02: логин длиннее любого допустимого адреса отбрасывается ДО любого
    // учёта — v1-кадр до 4 МиБ не должен оставлять след в памяти лимитеров.
    // Текст тот же, что у неверного пароля (анти-энумерация).
    if req.user.len() > LIMITER_KEY_MAX {
        anyhow::bail!("неверный логин или пароль");
    }
    // v1 не проверял device_id вовсе (v2 — проверяет): произвольная строка
    // уходила в JWT и таблицы устройств.
    if let Some(d) = req.device_id.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        if !parvane_protocol::address::is_valid_device_id(d) {
            anyhow::bail!("неверный логин или пароль");
        }
        // ID-01: по v1 доказательство устройства передать нельзя — при включённом
        // требовании привязанное к журналу v2 устройство входит только через
        // `identity.session.issue` (мост v2; v1 отключается, E6).
        if crate::v2::device_proof_required() && crate::v2::log_has_active_device(&req.user, d).await {
            anyhow::bail!("неверный логин или пароль");
        }
    }
    // Брутфорс-защита: частотный лимит по IP (gateway подмешивает client_ip;
    // пусто при прямом NATS в dev) идёт ПЕРВЫМ — отклонённая по IP попытка не
    // заводит корзину логина; затем частотный лимит + экспоненциальный лок-аут
    // по логину. Всё — до обращения к БД.
    if !req.client_ip.is_empty()
        && !window_rate_ok("login-ip", &req.client_ip, env_u64("PARVANE_LOGIN_RATE_IP", 120) as usize)
    {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }
    login_gate_check(&req.user)?;

    // Логин: пользователь ОБЯЗАН существовать. Создание аккаунтов — только через
    // identity.user.register (раньше issue молча создавал юзера с любым паролем —
    // это позволяло занять любой адрес первым запросом).
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT password_hash, email_verified FROM users WHERE username = ?")
            .bind(&req.user)
            .fetch_optional(pool)
            .await?;
    // Анти-энумерация + анти-timing: несуществующий юзер и неверный пароль дают
    // ОДНУ ошибку, а argon2-verify выполняется всегда (по dummy-хэшу постоянного
    // времени, когда юзера нет), чтобы по задержке нельзя было отличить случаи.
    let Some((hash, email_verified)) = row else {
        let _ = verify_password(&req.password, dummy_password_hash());
        login_record_failure(&req.user);
        anyhow::bail!("неверный логин или пароль");
    };
    if !verify_password(&req.password, &hash) {
        login_record_failure(&req.user);
        anyhow::bail!("неверный логин или пароль");
    }
    // Пароль верен — сбрасываем счётчик неудач (в т.ч. до проверки почты, чтобы
    // неподтверждённый аккаунт с верным паролем не копил лок-аут и мог получать
    // перевысылку кода).
    login_record_success(&req.user);
    // Сообщаем о неподтверждённой почте только после проверки пароля, чтобы
    // посторонний не мог зондировать статус чужого аккаунта.
    if email_verified == 0 {
        anyhow::bail!("почта не подтверждена");
    }

    // Двухфакторный вход: пароль верен, но нужен Start в привязанном Telegram.
    // С подтверждённым login_token выдаём JWT (токен одноразовый).
    let (tg_2fa, telegram_id): (i64, Option<i64>) =
        sqlx::query_as("SELECT tg_2fa, telegram_id FROM users WHERE username = ?")
            .bind(&req.user)
            .fetch_one(pool)
            .await?;
    let device_id = req.device_id.as_deref().map(str::trim).unwrap_or("");
    // Доверие — по СЕКРЕТУ, а не по device_id: device_id публичен (каталог
    // прекеев отдаёт его любому), и раньше второй фактор обходился при
    // известном пароле. Строки без хэша (до миграции 0014) не доверяем.
    let presented_secret = req.trust_secret.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let trusted = if tg_2fa != 0 && telegram_id.is_some() && !device_id.is_empty() {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT secret_hash FROM trusted_devices WHERE username = ? AND device_id = ?")
                .bind(&req.user)
                .bind(device_id)
                .fetch_optional(pool)
                .await?;
        match (row, presented_secret) {
            (Some((hash,)), Some(secret)) if !hash.is_empty() => trust_secret_hash(secret) == hash,
            _ => false,
        }
    } else {
        false
    };
    let mut issued_trust_secret: Option<String> = None;
    // P-14: секрет доверия одноразовый — при каждом доверенном входе выдаём
    // новый (украденный из хранилища секрет протухает после первого же входа
    // владельца, а повторное использование старого — сигнал компрометации).
    if trusted {
        let (secret, hash) = new_trust_secret();
        sqlx::query("UPDATE trusted_devices SET secret_hash = ?, confirmed_at = ? WHERE username = ? AND device_id = ?")
            .bind(&hash)
            .bind(now_unix())
            .bind(&req.user)
            .bind(device_id)
            .execute(pool)
            .await?;
        issued_trust_secret = Some(secret);
    }
    if tg_2fa != 0 && telegram_id.is_some() && !trusted {
        let now = now_unix();
        let _ = sqlx::query("DELETE FROM login_links WHERE expires_at < ?").bind(now).execute(pool).await;
        let presented = req.login_token.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let confirmed = match presented {
            Some(token) => {
                let row: Option<(i64,)> = sqlx::query_as(
                    "SELECT confirmed FROM login_links WHERE token = ? AND username = ? AND expires_at >= ?",
                )
                .bind(token)
                .bind(&req.user)
                .bind(now)
                .fetch_optional(pool)
                .await?;
                match row {
                    Some((1,)) => {
                        sqlx::query("DELETE FROM login_links WHERE token = ?").bind(token).execute(pool).await?;
                        if !device_id.is_empty() {
                            let (secret, hash) = new_trust_secret();
                            sqlx::query(
                                "INSERT OR REPLACE INTO trusted_devices (username, device_id, confirmed_at, secret_hash) VALUES (?, ?, ?, ?)",
                            )
                            .bind(&req.user)
                            .bind(device_id)
                            .bind(now)
                            .bind(&hash)
                            .execute(pool)
                            .await?;
                            issued_trust_secret = Some(secret);
                        }
                        true
                    }
                    _ => false,
                }
            }
            None => false,
        };
        if !confirmed {
            let login_token = issue_login_token(pool, &req.user, device_id).await?;
            info!("Двухфакторный вход: {} ждёт подтверждения в Telegram", req.user);
            return Ok(IssueOutcome::TwoFactor { login_token });
        }
    }

    let now = now_unix() as usize;
    let claims = Claims {
        sub: req.user.clone(),
        iat: now,
        exp: now + 86400,
        dev: req.device_id.clone().filter(|d| !d.is_empty()),
    };
    let token = jwt_encode(encoding, &claims)?;
    if let (Some(device_id), Some(label)) = (claims.dev.as_deref(), req.client.as_deref()) {
        crate::devices::remember_device_label(pool, &req.user, device_id, label).await;
    }

    info!("JWT выдан для: {}", req.user);
    Ok(IssueOutcome::Token { token, trust_secret: issued_trust_secret })
}

/// Новый токен подтверждения входа (deep link боту). Прежние токены этого
/// пользователя гасятся — действует только последний.
pub(crate) async fn issue_login_token(pool: &SqlitePool, user: &str, device_id: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    sqlx::query("DELETE FROM login_links WHERE username = ?").bind(user).execute(pool).await?;
    sqlx::query("INSERT INTO login_links (token, username, device_id, expires_at, confirmed) VALUES (?, ?, ?, ?, 0)")
        .bind(&token)
        .bind(user)
        .bind(device_id)
        .bind(now_unix() + LOGIN_LINK_TTL_SECS)
        .execute(pool)
        .await?;
    Ok(token)
}

// ── двухфакторный вход: чтение/переключение ──────────────────────────────────

/// P-07: смена пароля (identity.password.change). Требует JWT живой сессии И
/// старый пароль; новый — по политике. Сбрасывает доверие устройств 2FA и
/// незавершённые входы: после компрометации владелец возвращает контроль.
pub(crate) async fn handle_password_change(nc: &Client, pool: &SqlitePool, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match do_password_change(pool, decoding, &msg.payload).await {
        Ok(user) => {
            info!("{} сменил пароль", user);
            PasswordChangeResponse { ok: true, error: None }
        }
        Err(e) => PasswordChangeResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn do_password_change(pool: &SqlitePool, decoding: &DecodingKey, payload: &[u8]) -> Result<String> {
    let req: PasswordChangeRequest =
        serde_json::from_slice(payload).context("неверный JSON в PasswordChangeRequest")?;
    let claims = verify_active(pool, decoding, &req.token).await?;
    let username = claims.sub;
    // Корзина попыток — внутри require_password (ID-05).
    require_password(pool, &username, Some(&req.old_password)).await?;
    password_policy_ok(&req.new_password)?;
    if req.new_password == req.old_password {
        anyhow::bail!("новый пароль совпадает со старым");
    }
    let hash = hash_password(&req.new_password)?;
    let mut tx = pool.begin().await?;
    // ID-06: прежние JWT (iat < now) гаснут, кроме токенов этого устройства —
    // владелец, сменивший пароль после компрометации, выкидывает чужие сессии.
    sqlx::query("UPDATE users SET password_hash = ?, password_changed_at = ?, password_changed_dev = ? WHERE username = ?")
        .bind(&hash)
        .bind(now_unix())
        .bind(claims.dev.as_deref().unwrap_or(""))
        .bind(&username)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM trusted_devices WHERE username = ?").bind(&username).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM login_links WHERE username = ?").bind(&username).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(username)
}

pub(crate) async fn handle_twofa(nc: &Client, pool: &SqlitePool, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match do_twofa(pool, decoding, &msg.payload).await {
        Ok((enabled, telegram_linked, trust_secret)) => TwoFactorResponse { ok: true, error: None, enabled, telegram_linked, trust_secret },
        Err(e) => TwoFactorResponse { ok: false, error: Some(parvane_db::public_error(&e)), enabled: false, telegram_linked: false, trust_secret: None },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

/// (enabled, telegram_linked, trust_secret). Включить можно только при
/// привязанном Telegram; устройство, включившее 2FA, получает секрет доверия.
pub(crate) async fn do_twofa(pool: &SqlitePool, decoding: &DecodingKey, payload: &[u8]) -> Result<(bool, bool, Option<String>)> {
    let req: TwoFactorRequest = serde_json::from_slice(payload).context("неверный JSON в TwoFactorRequest")?;
    // ID-05: отозванное устройство (и токен до смены пароля) 2FA не трогает.
    let claims = verify_active(pool, decoding, &req.token).await?;
    let username = claims.sub;
    let row: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT tg_2fa, telegram_id FROM users WHERE username = ?")
            .bind(&username)
            .fetch_optional(pool)
            .await?;
    let Some((current, telegram_id)) = row else {
        anyhow::bail!("аккаунт не найден");
    };
    let telegram_linked = telegram_id.is_some();
    let Some(enabled) = req.enabled else {
        return Ok((current != 0, telegram_linked, None));
    };
    if enabled && !telegram_linked {
        anyhow::bail!("сначала привяжите Telegram (подтверждение через бота)");
    }
    // P-07: переключить 2FA можно только с паролем. Чтение (без `enabled`) —
    // по одному JWT; повторное «включить» при уже включённой выдавало секрет
    // доверия любому держателю токена (ID-05) — теперь тоже только с паролем.
    require_password(pool, &username, req.password.as_deref()).await?;
    sqlx::query("UPDATE users SET tg_2fa = ? WHERE username = ?")
        .bind(enabled as i64)
        .bind(&username)
        .execute(pool)
        .await?;
    if !enabled {
        let _ = sqlx::query("DELETE FROM login_links WHERE username = ?").bind(&username).execute(pool).await;
        // При повторном включении все устройства подтверждают вход заново
        let _ = sqlx::query("DELETE FROM trusted_devices WHERE username = ?").bind(&username).execute(pool).await;
    }
    let mut trust_secret = None;
    if enabled {
        if let Some(dev) = claims.dev.as_deref().filter(|d| !d.is_empty()) {
            // Устройство, с которого включили 2FA, уже вошло по паролю — даём ему
            // секрет доверия сразу (иначе десктоп, который переизвлекает JWT при
            // каждом старте, тут же попросил бы подтверждение на том же устройстве)
            let (secret, hash) = new_trust_secret();
            let _ = sqlx::query(
                "INSERT OR REPLACE INTO trusted_devices (username, device_id, confirmed_at, secret_hash) VALUES (?, ?, ?, ?)",
            )
            .bind(&username)
            .bind(dev)
            .bind(now_unix())
            .bind(&hash)
            .execute(pool)
            .await;
            trust_secret = Some(secret);
        }
    }
    info!("Двухфакторный вход {} для {}", if enabled { "включён" } else { "выключен" }, username);
    Ok((enabled, telegram_linked, trust_secret))
}

// ── регистрация (отдельно от логина) ──────────────────────────────────────────
