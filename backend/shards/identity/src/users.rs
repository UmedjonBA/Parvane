//! Профиль пользователя: server.info, поиск (P-19), имя/аватар/ключ, resolve.

use crate::*;

/// Полный адрес по вводу пользователя: `ник` → `ник@домен`, `ник@сервер`
/// остаётся как есть (десктоп и старые аккаунты вводят адрес целиком).
pub(crate) fn canonical_user(raw: &str, domain: &str) -> String {
    let raw = raw.trim();
    if raw.contains('@') {
        raw.to_string()
    } else {
        format!("{}@{}", raw, domain)
    }
}

pub(crate) const NICK_MIN_LEN: usize = 2;
pub(crate) const NICK_MAX_LEN: usize = 64;

/// Ник нового аккаунта: строчные латинские буквы, цифры, `_ . -`; первый
/// символ — буква или цифра; 2..=64 символа. Регистр приводится клиентом;
/// здесь только проверка, чтобы адрес был однозначным.
pub(crate) fn valid_nick(nick: &str) -> bool {
    let len = nick.chars().count();
    if !(NICK_MIN_LEN..=NICK_MAX_LEN).contains(&len) {
        return false;
    }
    let first = nick.chars().next().unwrap_or(' ');
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && nick
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'))
}

/// Адрес нового аккаунта: ник проверен, домен — только свой (чужие домены
/// регистрировать нельзя, иначе любой мог бы занять адрес чужого сервера).
pub(crate) fn validate_new_user(user: &str, domain: &str) -> Result<()> {
    let Some((nick, user_domain)) = user.split_once('@') else {
        anyhow::bail!("некорректный адрес");
    };
    if !valid_nick(nick) {
        anyhow::bail!("некорректный ник: 2–64 символа, латиница в нижнем регистре, цифры, _ . -");
    }
    if user_domain != domain {
        anyhow::bail!("чужой домен: на этом сервере адреса @{}", domain);
    }
    Ok(())
}

// Публичные параметры сервера для экрана входа (pre-auth).
pub(crate) async fn handle_server_info(nc: &Client, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("server.info: нет reply-топика, игнорирую");
        return;
    };
    let mode = confirm_mode();
    let resp = ServerInfoResponse {
        domain: server_domain(),
        email_required: mode == ConfirmMode::Email,
        confirm: mode.as_str().to_string(),
        telegram_bot: if mode == ConfirmMode::Telegram { telegram_bot().unwrap_or_default() } else { String::new() },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("server.info: ошибка отправки ответа: {}", e);
    }
}

// display_name с фолбэком на локальную часть адреса (для старых записей с '').
pub(crate) fn name_or_default(username: &str, display_name: &str) -> String {
    if display_name.is_empty() {
        username.split('@').next().unwrap_or(username).to_string()
    } else {
        display_name.to_string()
    }
}

// Поиск пользователей по подстроке имени/адреса. Возвращает username+display_name.
/// P-19: экранирование `%`/`_`/`\` в шаблоне LIKE (ESCAPE '\').
pub(crate) fn like_escape(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Минимальная длина запроса поиска: одиночный символ (или пустой/`%`)
/// отдавал бы весь каталог.
pub(crate) const SEARCH_MIN_CHARS: usize = 2;

/// Публичная карточка для поиска/резолва: без телефона, даты рождения и bio —
/// их видит только владелец (P-19).
pub(crate) fn public_card(u: &str, d: &str, a: String, k: String, color: i64, chan: String) -> UserInfo {
    UserInfo {
        display_name: name_or_default(u, d),
        username: u.to_string(),
        avatar: opt(a),
        pubkey: opt(k),
        bio: None,
        birthday: None,
        name_color: if color != 0 { Some(color) } else { None },
        personal_channel: opt(chan),
        phone: None,
    }
}

/// Адрес запрашивающего по токену (если gateway подставил валидный).
pub(crate) fn requester_of(decoding: &DecodingKey, token: &str) -> Option<String> {
    if token.is_empty() {
        return None;
    }
    jwt_decode(decoding, token).ok().map(|data| data.claims.sub)
}

pub(crate) async fn handle_search(nc: &Client, pool: &SqlitePool, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("search: нет reply-топика, игнорирую");
        return;
    };
    let req = serde_json::from_slice::<SearchUsersRequest>(&msg.payload).ok();
    let q = req.as_ref().map(|r| r.query.trim().to_string()).unwrap_or_default();
    let _requester = req.as_ref().and_then(|r| requester_of(decoding, &r.token));
    let users: Vec<UserInfo> = if q.chars().count() < SEARCH_MIN_CHARS {
        vec![]
    } else {
        // P-19: `%`/`_` в запросе — литералы, а не wildcard'ы
        let like = format!("%{}%", like_escape(&q));
        // Ограничиваем выдачу доменом этого сервера: аккаунты чужих доменов
        // (в т.ч. e2e-тестовые `@local` на проде) в директорию не попадают.
        let domain_suffix = format!("%@{}", like_escape(&server_domain()));
        sqlx::query_as::<_, (String, String, String, String, i64, String)>(
            "SELECT username, display_name, avatar_file_id, pubkey, name_color, personal_channel FROM users
             WHERE (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
               AND username LIKE ? ESCAPE '\\'
             ORDER BY username LIMIT 20",
        )
        .bind(&like)
        .bind(&like)
        .bind(&domain_suffix)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(u, d, a, k, color, chan)| public_card(&u, &d, a, k, color, chan))
        .collect()
    };
    // P-42: сам запрос в лог не пишем
    debug!("search: {} результатов", users.len());
    let _ = nc
        .publish(reply, serde_json::to_vec(&SearchUsersResponse { users }).unwrap_or_default().into())
        .await;
}

// Смена своего display_name (username берём из проверенного токена).
pub(crate) async fn handle_setname(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<SetNameRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => {
                let name = req.display_name.trim();
                if name.is_empty() || name.len() > 64 {
                    SetNameResponse { ok: false, error: Some("имя пустое/длинное".into()) }
                } else {
                    let _ = sqlx::query("UPDATE users SET display_name = ? WHERE username = ?")
                        .bind(name)
                        .bind(&username)
                        .execute(pool)
                        .await;
                    // Профильные поля (опциональны): задаём только присланные.
                    if let Some(v) = req.bio.as_ref() {
                        let _ = sqlx::query("UPDATE users SET bio = ? WHERE username = ?")
                            .bind(v.trim()).bind(&username).execute(pool).await;
                    }
                    if let Some(v) = req.birthday.as_ref() {
                        let _ = sqlx::query("UPDATE users SET birthday = ? WHERE username = ?")
                            .bind(v.trim()).bind(&username).execute(pool).await;
                    }
                    if let Some(v) = req.name_color {
                        let _ = sqlx::query("UPDATE users SET name_color = ? WHERE username = ?")
                            .bind(v).bind(&username).execute(pool).await;
                    }
                    if let Some(v) = req.personal_channel.as_ref() {
                        let _ = sqlx::query("UPDATE users SET personal_channel = ? WHERE username = ?")
                            .bind(v.trim()).bind(&username).execute(pool).await;
                    }
                    if let Some(v) = req.phone.as_ref() {
                        let _ = sqlx::query("UPDATE users SET phone = ? WHERE username = ?")
                            .bind(v.trim()).bind(&username).execute(pool).await;
                    }
                    info!("{} обновил профиль (имя '{}')", username, name);
                    SetNameResponse { ok: true, error: None }
                }
            }
            Err(e) => SetNameResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => SetNameResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// Установка своего avatar_file_id (username из проверенного токена).
pub(crate) async fn handle_setavatar(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<SetAvatarRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => {
                let _ = sqlx::query("UPDATE users SET avatar_file_id = ? WHERE username = ?")
                    .bind(&req.file_id)
                    .bind(&username)
                    .execute(pool)
                    .await;
                info!("{} обновил аватар ({})", username, req.file_id);
                SetNameResponse { ok: true, error: None }
            }
            Err(e) => SetNameResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => SetNameResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// Записать публичный ключ пользователя (чистая функция — для тестов).
pub(crate) async fn store_pubkey(pool: &SqlitePool, username: &str, pubkey: &str) -> Result<()> {
    let decoded = B64.decode(pubkey).or_else(|_| B64_NO_PAD.decode(pubkey))
        .context("pubkey должен быть base64")?;
    if decoded.len() != 32 {
        anyhow::bail!("pubkey должен быть Ed25519-ключом длиной 32 байта");
    }
    sqlx::query("UPDATE users SET pubkey = ? WHERE username = ?")
        .bind(pubkey)
        .bind(username)
        .execute(pool)
        .await
        .context("запись pubkey")?;
    Ok(())
}

// Регистрация своего публичного Ed25519-ключа (username из проверенного токена).
pub(crate) async fn handle_setkey(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<SetKeyRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => match async {
                // P-07: ЗАМЕНА уже зарегистрированного публичного ключа — только с
                // паролем (украденный JWT не должен подменять ключ подписи
                // сигналинга звонков). Первая регистрация и повторная публикация
                // того же ключа (клиенты делают её при каждом входе) — по JWT.
                let current: Option<(String,)> =
                    sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
                        .bind(&username)
                        .fetch_optional(pool)
                        .await?;
                let current = current.map(|(k,)| k).unwrap_or_default();
                if !current.is_empty() && current != req.pubkey {
                    require_password(pool, &username, req.password.as_deref()).await?;
                }
                store_pubkey(pool, &username, &req.pubkey).await
            }
            .await
            {
                Ok(()) => {
                    info!("{} зарегистрировал pubkey ({}…)", username, &req.pubkey.chars().take(12).collect::<String>());
                    SetNameResponse { ok: true, error: None }
                }
                Err(e) => SetNameResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
            },
            Err(e) => SetNameResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
        },
        Err(e) => SetNameResponse { ok: false, error: Some(parvane_db::public_error(&e)) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// Резолв display_name по списку адресов (для пиров из sync).
pub(crate) async fn handle_resolve(nc: &Client, pool: &SqlitePool, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let req: ResolveRequest = serde_json::from_slice(&msg.payload).unwrap_or(ResolveRequest {
        usernames: vec![],
        token: String::new(),
    });
    let requester = requester_of(decoding, &req.token);
    let mut users = Vec::new();
    for u in req.usernames.iter().take(50) {
        let row: Option<(String, String, String, String, String, i64, String, String)> = sqlx::query_as(
            "SELECT display_name, avatar_file_id, pubkey, bio, birthday, name_color,              personal_channel, phone FROM users WHERE username = ?",
        )
        .bind(u)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        if let Some((d, a, k, bio, bday, color, chan, phone)) = row {
            // P-19: телефон — только владельцу; bio/дата рождения — публичная
            // часть профиля, заданная самим пользователем.
            let is_self = requester.as_deref() == Some(u.as_str());
            users.push(UserInfo {
                display_name: name_or_default(u, &d),
                username: u.clone(),
                avatar: opt(a),
                pubkey: opt(k),
                bio: opt(bio),
                birthday: opt(bday),
                name_color: if color != 0 { Some(color) } else { None },
                personal_channel: opt(chan),
                phone: if is_self { opt(phone) } else { None },
            });
        }
    }
    let _ = nc
        .publish(reply, serde_json::to_vec(&ResolveResponse { users }).unwrap_or_default().into())
        .await;
}

// ── E2E prekeys (Фаза 2) ──────────────────────────────────────────────────────
