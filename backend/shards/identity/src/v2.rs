//! Методы протокола v2 в identity (spec 007, E1/US1: T047–T051, T119, T071,
//! T121). Хранилище — отдельный файл `<PARVANE_DB_PATH>-v2.db`.
//!
//! Методы аккаунта/профиля/линковки (T049, T050) идут через те же v1-обработчики
//! («петля» через NATS-инбокс identity, с JWT сессии и IP клиента от gateway):
//! правила argon2id, политики пароля, IP-лимитов, 2FA, карточки без телефона и
//! поиска без wildcard не дублируются и не меняются. Новое v2 — журнал
//! устройств, бандлы, ключи доставки, жетоны, приватность, статистика.

use crate::*;

use parvane_protocol::codec::decode_checked;
use parvane_protocol::identity::{DeviceLog, VerifiedDevice};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    user_device_log_entry::Change, DeliveryKeyCheckRequest, DeliveryKeyCheckResponse, DevicesOfRequest,
    DevicesOfResponse, ErrorCode, KeyOwnerRequest, KeyOwnerResponse, PrivacyOfRequest, PrivacyOfResponse, RevokedNotice,
    ShardRequest, SignedOp, TokenCheckRequest, TokenCheckResponse, UserDeviceLogEntry, UserRef,
};
use parvane_protocol::pb::parvane::identity::v2 as pb;
use parvane_protocol::registry_gen::{
    INTERNAL_DELIVERY_KEY_CHECK, INTERNAL_DEVICES_OF, INTERNAL_KEY_OWNER, INTERNAL_PRIVACY_OF, INTERNAL_TOKEN_CHECK,
    REVOKED_SUBJECT,
};
use parvane_protocol::schema::MethodInfo;
use parvane_protocol::tokens::Issuer;
use parvane_v2rt::{body, BoxFut, Reply};
use prost::Message as _;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Окно свежего подтверждения паролем (FR-025).
pub(crate) const REAUTH_WINDOW_MS: i64 = 5 * 60 * 1000;
/// Жетонов в сутки на аккаунт (R7).
pub(crate) const TOKENS_PER_DAY: i64 = 50;
/// Лимит выдачи бандлов одного пользователя в минуту (против выкачивания OTK).
fn bundle_rate() -> usize {
    env_u64("PARVANE_V2_BUNDLE_RATE", 60) as usize
}

pub(crate) struct V2Ctx {
    pub pool: SqlitePool,
    pub v2: SqlitePool,
    pub server_key: ed25519_dalek::SigningKey,
    pub encoding: EncodingKey,
    pub decoding: DecodingKey,
    pub nc: Client,
    pub token_dir: std::path::PathBuf,
    pub issuers: RwLock<Vec<Arc<Issuer>>>,
}

/// v2-пул для проверок из v1-кода (T048).
static V2_POOL: std::sync::OnceLock<SqlitePool> = std::sync::OnceLock::new();

/// Открыть v2-хранилище рядом с v1-БД и применить его миграции.
pub(crate) async fn open_store(db_path: &str) -> Result<SqlitePool> {
    let path = format!("{db_path}-v2.db");
    let pool = parvane_db::connect(&path).await?;
    sqlx::migrate!("./migrations_v2").run(&pool).await.context("миграции v2")?;
    let _ = V2_POOL.set(pool.clone());
    info!("SQLite v2 готов: {}", path);
    Ok(pool)
}

/// У пользователя есть журнал устройств v2 (T048: защита от downgrade).
pub(crate) async fn user_has_v2(user: &str) -> bool {
    let Some(pool) = V2_POOL.get() else { return false };
    sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM device_log WHERE user = ?")
        .bind(user)
        .fetch_one(pool)
        .await
        .map(|(n,)| n > 0)
        .unwrap_or(false)
}

/// Устройство числится в журнале устройств v2 пользователя (в т.ч. уже
/// отозванным): у аккаунта на v2 новые устройства в каталог v1 не попадают
/// (T048), и v1-отзыв такого устройства каталог не меняет.
pub(crate) async fn log_has_device(user: &str, device_id: &str) -> bool {
    let Some(pool) = V2_POOL.get() else { return false };
    sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM device_state WHERE user = ? AND device_id = ?")
        .bind(user)
        .bind(device_id)
        .fetch_one(pool)
        .await
        .map(|(n,)| n > 0)
        .unwrap_or(false)
}

/// Устройство действует в журнале устройств v2 пользователя (есть сертификат,
/// не отозвано) — ему разрешён и v1-бандл в каталоге устройств (T146).
pub(crate) async fn log_has_active_device(user: &str, device_id: &str) -> bool {
    let Some(pool) = V2_POOL.get() else { return false };
    sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM device_state WHERE user = ? AND device_id = ? AND revoked = 0")
        .bind(user)
        .bind(device_id)
        .fetch_one(pool)
        .await
        .map(|(n,)| n > 0)
        .unwrap_or(false)
}

pub(crate) async fn run(nc: Client, ctx: Arc<V2Ctx>) -> Result<()> {
    ctx.rotate_token_keys().await;
    let c2 = ctx.clone();
    let handler: parvane_v2rt::Handler = Arc::new(move |m: &'static MethodInfo, req: ShardRequest| -> BoxFut {
        let ctx = c2.clone();
        Box::pin(async move { dispatch(&ctx, m, req).await })
    });
    parvane_v2rt::serve(nc.clone(), "identity", handler_concurrency(), handler).await?;
    internal(nc.clone(), ctx.clone()).await?;
    // Суточная ротация ключей выпуска жетонов.
    let c3 = ctx.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            t.tick().await;
            c3.rotate_token_keys().await;
        }
    });
    info!("identity: методы v2 подключены");
    Ok(())
}

/// Внутренние запросы messenger → identity.
async fn internal(nc: Client, ctx: Arc<V2Ctx>) -> Result<()> {
    let mut devs = nc.subscribe(INTERNAL_DEVICES_OF.to_string()).await?;
    let mut dk = nc.subscribe(INTERNAL_DELIVERY_KEY_CHECK.to_string()).await?;
    let mut ko = nc.subscribe(INTERNAL_KEY_OWNER.to_string()).await?;
    let mut tc = nc.subscribe(INTERNAL_TOKEN_CHECK.to_string()).await?;
    let mut pv = nc.subscribe(INTERNAL_PRIVACY_OF.to_string()).await?;
    tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(m) = devs.next() => {
                    let (ctx, nc) = (ctx.clone(), nc.clone());
                    tokio::spawn(async move {
                        let Some(reply) = m.reply.clone() else { return };
                        let out = match decode_checked::<DevicesOfRequest>(&m.payload, Origin::Server) {
                            Ok(r) => devices_of(&ctx, &r.user).await.unwrap_or_default(),
                            Err(_) => DevicesOfResponse::default(),
                        };
                        let _ = nc.publish(reply, out.encode_to_vec().into()).await;
                    });
                }
                Some(m) = dk.next() => {
                    let (ctx, nc) = (ctx.clone(), nc.clone());
                    tokio::spawn(async move {
                        let Some(reply) = m.reply.clone() else { return };
                        let out = match decode_checked::<DeliveryKeyCheckRequest>(&m.payload, Origin::Server) {
                            Ok(r) => delivery_key_check(&ctx, &r).await,
                            Err(_) => DeliveryKeyCheckResponse::default(),
                        };
                        let _ = nc.publish(reply, out.encode_to_vec().into()).await;
                    });
                }
                Some(m) = ko.next() => {
                    let (ctx, nc) = (ctx.clone(), nc.clone());
                    tokio::spawn(async move {
                        let Some(reply) = m.reply.clone() else { return };
                        let out = match decode_checked::<KeyOwnerRequest>(&m.payload, Origin::Server) {
                            Ok(r) => key_owner(&ctx, &r.ed25519).await,
                            Err(_) => KeyOwnerResponse::default(),
                        };
                        let _ = nc.publish(reply, out.encode_to_vec().into()).await;
                    });
                }
                Some(m) = tc.next() => {
                    let (ctx, nc) = (ctx.clone(), nc.clone());
                    tokio::spawn(async move {
                        let Some(reply) = m.reply.clone() else { return };
                        let code = match decode_checked::<TokenCheckRequest>(&m.payload, Origin::Server) {
                            Ok(TokenCheckRequest { token: Some(t) }) => {
                                let issuers = ctx.issuers.read().await.clone();
                                let refs: Vec<&Issuer> = issuers.iter().map(|i| i.as_ref()).collect();
                                match parvane_protocol::tokens::verify_token(&t, &refs, now_unix() * 1000) {
                                    Ok(()) => ErrorCode::Unspecified,
                                    Err(e) => e.code(),
                                }
                            }
                            _ => ErrorCode::Invalid,
                        };
                        let _ = nc.publish(reply, TokenCheckResponse { code: code as i32 }.encode_to_vec().into()).await;
                    });
                }
                Some(m) = pv.next() => {
                    let (ctx, nc) = (ctx.clone(), nc.clone());
                    tokio::spawn(async move {
                        let Some(reply) = m.reply.clone() else { return };
                        // Ошибка чтения — без ответа: messenger получит таймаут
                        // и откажет (не «разрешено по умолчанию»).
                        let out = match decode_checked::<PrivacyOfRequest>(&m.payload, Origin::Server) {
                            Ok(r) => match privacy_of(&ctx, &r.user).await {
                                Some(p) => p,
                                None => return,
                            },
                            Err(_) => PrivacyOfResponse::default(),
                        };
                        let _ = nc.publish(reply, out.encode_to_vec().into()).await;
                    });
                }
                else => break,
            }
        }
    });
    Ok(())
}

/// Настройки приватности, выставленные через `identity.privacy.set`
/// (None — ошибка БД).
async fn privacy_of(ctx: &V2Ctx, user: &str) -> Option<PrivacyOfResponse> {
    let row: Option<(i64, i64, i64, i64)> = match sqlx::query_as(
        "SELECT group_add, messages_from_strangers, calls_from, presence_visibility FROM privacy WHERE user = ?",
    )
    .bind(user)
    .fetch_optional(&ctx.v2)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            error!("identity v2: privacy_of: {}", e);
            return None;
        }
    };
    let aud = |v: i64| u32::try_from(v).unwrap_or(1);
    Some(match row {
        Some((g, s, c, p)) => PrivacyOfResponse {
            found: true,
            group_add: aud(g),
            messages_from_strangers: s != 0,
            calls_from: aud(c),
            presence_visibility: aud(p),
        },
        None => PrivacyOfResponse::default(),
    })
}

/// Владелец ключа подписи устройства (активного по журналу). C1-01: ответ
/// однозначен — ключ закреплён за одним устройством (`device_key_claims`),
/// а два совпадения — это ошибка данных, и владельца нет.
async fn key_owner(ctx: &V2Ctx, ed25519: &[u8]) -> KeyOwnerResponse {
    let rows: Vec<(String, String)> =
        match sqlx::query_as("SELECT user, device_id FROM device_state WHERE ed25519 = ? AND revoked = 0 LIMIT 2").bind(ed25519).fetch_all(&ctx.v2).await {
            Ok(r) => r,
            Err(e) => {
                error!("identity v2: key_owner: {}", e);
                return KeyOwnerResponse::default();
            }
        };
    match rows.as_slice() {
        [(user, device_id)] => KeyOwnerResponse { found: true, root_key: root_key_of(ctx, user).await, user: user.clone(), device_id: device_id.clone() },
        [] => KeyOwnerResponse::default(),
        _ => {
            error!("identity v2: ключ устройства у нескольких устройств — владелец не выдаётся");
            KeyOwnerResponse::default()
        }
    }
}

/// C1-01: закрепить ключи подписи устройств журнала за (user, device_id).
/// Ключ, уже закреплённый за другим устройством (в том числе отозванным или
/// чужим пользователем), — отказ. Olm/HPKE-ключи не закрепляются: владение
/// ими подписью не доказано, и чужой их «захват» блокировал бы жертву.
async fn claim_device_keys(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, user: &str, log: &DeviceLog) -> Result<(), ErrorCode> {
    for (id, d) in &log.devices {
        let owner: Option<(String, String)> = sqlx::query_as("SELECT user, device_id FROM device_key_claims WHERE key = ?")
            .bind(&d.cert.olm_ed25519)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db_err)?;
        match owner {
            Some((u, dv)) if u == user && &dv == id => {}
            Some(_) => {
                warn!("identity v2: сертификат с ключом другого устройства отвергнут");
                return Err(ErrorCode::Duplicate);
            }
            None => {
                sqlx::query("INSERT INTO device_key_claims (key, user, device_id) VALUES (?, ?, ?)")
                    .bind(&d.cert.olm_ed25519)
                    .bind(user)
                    .bind(id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|_| ErrorCode::Duplicate)?;
            }
        }
    }
    Ok(())
}

fn db_err<E: std::fmt::Display>(e: E) -> ErrorCode {
    error!("identity v2: {}", e);
    ErrorCode::Unavailable
}

/// Код ошибки по тексту ошибки v1 (клиенту текст не уходит — инвариант 18).
fn v1_code(err: &str) -> ErrorCode {
    let e = err.to_lowercase();
    if e.contains("слишком много") || e.contains("попробуйте позже") || e.contains("часто") {
        ErrorCode::RateLimited
    } else if e.contains("отозван") {
        ErrorCode::Revoked
    } else if e.contains("не найден") || e.contains("нет такого") {
        ErrorCode::NotFound
    } else if e.contains("существует") || e.contains("занят") {
        ErrorCode::Duplicate
    } else if e.contains("истёк") || e.contains("истек") || e.contains("просроч") {
        ErrorCode::Expired
    } else if e.contains("лимит") {
        ErrorCode::Limit
    } else if e.contains("json") || e.contains("некоррект") || e.contains("недопустим") || e.contains("пуст") || e.contains("длин") || e.contains("пароль должен") {
        ErrorCode::Invalid
    } else {
        ErrorCode::Forbidden
    }
}

/// «Петля»: вызвать v1-обработчик с JSON-запросом и получить его JSON-ответ.
async fn v1_call<F, Fut>(nc: &Client, payload: Value, handler: F) -> Result<Value, ErrorCode>
where
    F: FnOnce(async_nats::Message) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let inbox = nc.new_inbox();
    let mut sub = nc.subscribe(inbox.clone()).await.map_err(db_err)?;
    let bytes = payload.to_string().into_bytes();
    let msg = async_nats::Message {
        subject: "v2.loopback".into(),
        reply: Some(inbox.into()),
        length: bytes.len(),
        payload: bytes.into(),
        headers: None,
        status: None,
        description: None,
    };
    handler(msg).await;
    match tokio::time::timeout(std::time::Duration::from_secs(20), sub.next()).await {
        Ok(Some(m)) => serde_json::from_slice(&m.payload).map_err(|_| ErrorCode::Unavailable),
        _ => Err(ErrorCode::Unavailable),
    }
}

/// Успех v1-ответа (`ok: true`) или код ошибки.
fn v1_ok(v: &Value) -> Result<(), ErrorCode> {
    if v["ok"].as_bool() == Some(true) {
        Ok(())
    } else {
        Err(v1_code(v["error"].as_str().unwrap_or("")))
    }
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}

fn require_user(req: &ShardRequest) -> Result<(), ErrorCode> {
    if req.user.is_empty() || req.device_id.is_empty() {
        Err(ErrorCode::Forbidden)
    } else {
        Ok(())
    }
}

async fn dispatch(ctx: &V2Ctx, m: &'static MethodInfo, req: ShardRequest) -> Reply {
    let (nc, pool, dec) = (&ctx.nc, &ctx.pool, &ctx.decoding);
    match m.name {
        // ── до входа ──
        "server.describe" => {
            let mode = confirm_mode();
            Ok(pb::ServerDescribeResponse {
                descriptor: Some(server_key::signed_descriptor(&ctx.server_key)),
                registration: match mode.as_str() {
                    "none" => vec![],
                    other => vec![other.to_string()],
                },
                domain: server_domain(),
                telegram_bot: if mode == ConfirmMode::Telegram { telegram_bot().unwrap_or_default() } else { String::new() },
                escrow_public_key: escrow_public_key().map(|k| k.to_vec()).unwrap_or_default(),
            }
            .encode_to_vec())
        }
        "identity.session.issue" => {
            let r: pb::SessionIssueRequest = body(&req)?;
            if r.device_id.is_empty() || !parvane_protocol::address::is_valid_device_id(&r.device_id) {
                return Err(ErrorCode::Invalid);
            }
            let mut p = json!({"user": r.login, "password": r.password, "device_id": r.device_id, "client_ip": req.client_ip});
            if !r.login_token.is_empty() {
                p["login_token"] = json!(r.login_token);
            }
            if !r.trust_secret.is_empty() {
                p["trust_secret"] = json!(r.trust_secret);
            }
            if !r.client_kind.is_empty() {
                p["client"] = json!(r.client_kind);
            }
            let v = v1_call(nc, p, |msg| handle_issue(nc, pool, &ctx.encoding, msg)).await?;
            if v["twofa_required"].as_bool() == Some(true) {
                return Ok(pb::SessionIssueResponse {
                    twofa_required: true,
                    login_token: s(&v, "login_token"),
                    telegram_bot: s(&v, "telegram_bot"),
                    ..Default::default()
                }
                .encode_to_vec());
            }
            // Аккаунт ждёт подтверждения — не отказ, а шаг входа (текста ошибок
            // в протоколе нет, кодом это от неверного пароля не отличить).
            if s(&v, "error").contains("не подтвержд") {
                return Ok(pb::SessionIssueResponse { confirm_required: true, ..Default::default() }.encode_to_vec());
            }
            v1_ok(&v)?;
            Ok(pb::SessionIssueResponse { token: s(&v, "token"), trust_secret: s(&v, "trust_secret"), ..Default::default() }.encode_to_vec())
        }
        "identity.account.register" => {
            let r: pb::AccountRegisterRequest = body(&req)?;
            let p = json!({"user": r.user, "password": r.password, "invite": r.invite, "email": r.email, "client_ip": req.client_ip});
            let v = v1_call(nc, p, |msg| handle_register(nc, pool, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::AccountRegisterResponse { confirm_required: v["confirm_required"].as_bool().unwrap_or(false), telegram_token: s(&v, "telegram_token") }.encode_to_vec())
        }
        "identity.account.confirm_email" => {
            let r: pb::AccountConfirmEmailRequest = body(&req)?;
            let v = v1_call(nc, json!({"user": r.user, "code": r.code, "client_ip": req.client_ip}), |msg| handle_email_confirm(nc, pool, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::AccountConfirmEmailResponse {}.encode_to_vec())
        }
        "identity.account.confirm_telegram" => {
            let r: pb::AccountConfirmTelegramRequest = body(&req)?;
            let p = json!({"secret": r.secret, "token": r.token, "telegram_id": r.telegram_id, "telegram_name": r.telegram_name, "client_ip": req.client_ip});
            let v = v1_call(nc, p, |msg| handle_telegram_confirm(nc, pool, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::AccountConfirmTelegramResponse { user: s(&v, "user"), action: s(&v, "kind") }.encode_to_vec())
        }
        "identity.account.register_status" => {
            let r: pb::AccountRegisterStatusRequest = body(&req)?;
            let v = v1_call(nc, json!({"user": r.user, "token": r.token}), |msg| handle_register_status(nc, pool, msg)).await?;
            Ok(pb::AccountRegisterStatusResponse { confirmed: v["confirmed"].as_bool().unwrap_or(false) }.encode_to_vec())
        }
        "identity.session.reauth" => reauth(ctx, &req).await,

        // ── аккаунт ──
        "identity.account.set_2fa" => {
            require_user(&req)?;
            let r: pb::AccountSet2faRequest = body(&req)?;
            let mut p = json!({"token": req.token});
            if let Some(e) = r.enabled {
                p["enabled"] = json!(e);
            }
            if !r.password.is_empty() {
                p["password"] = json!(r.password);
            }
            let v = v1_call(nc, p, |msg| handle_twofa(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::AccountSet2faResponse {
                enabled: v["enabled"].as_bool().unwrap_or(false),
                telegram_linked: v["telegram_linked"].as_bool().unwrap_or(false),
                telegram_bot: telegram_bot().unwrap_or_default(),
                trust_secret: s(&v, "trust_secret"),
            }
            .encode_to_vec())
        }
        // Чтение состояния 2FA — без свежего пароля (тот же v1-обработчик без `enabled`).
        "identity.account.get_2fa" => {
            require_user(&req)?;
            let v = v1_call(nc, json!({"token": req.token}), |msg| handle_twofa(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::AccountSet2faResponse {
                enabled: v["enabled"].as_bool().unwrap_or(false),
                telegram_linked: v["telegram_linked"].as_bool().unwrap_or(false),
                telegram_bot: telegram_bot().unwrap_or_default(),
                trust_secret: String::new(),
            }
            .encode_to_vec())
        }
        "identity.account.change_password" => {
            require_user(&req)?;
            let r: pb::AccountChangePasswordRequest = body(&req)?;
            let p = json!({"token": req.token, "old_password": r.old_password, "new_password": r.new_password});
            let v = v1_call(nc, p, |msg| handle_password_change(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::AccountChangePasswordResponse {}.encode_to_vec())
        }

        // ── профиль и каталог ──
        "identity.profile.resolve" => {
            require_user(&req)?;
            let r: pb::ProfileResolveRequest = body(&req)?;
            let names: Vec<String> = r.users.iter().map(|u| u.address.clone()).collect();
            let v = v1_call(nc, json!({"usernames": names, "token": req.token}), |msg| handle_resolve(nc, pool, dec, msg)).await?;
            let mut out = Vec::new();
            for u in v["users"].as_array().cloned().unwrap_or_default() {
                out.push(profile_from_v1(ctx, &u).await);
            }
            Ok(pb::ProfileResolveResponse { profiles: out }.encode_to_vec())
        }
        "identity.directory.search" => {
            require_user(&req)?;
            let r: pb::DirectorySearchRequest = body(&req)?;
            let v = v1_call(nc, json!({"query": r.query, "token": req.token}), |msg| handle_search(nc, pool, dec, msg)).await?;
            let mut out = Vec::new();
            for u in v["users"].as_array().cloned().unwrap_or_default() {
                out.push(profile_from_v1(ctx, &u).await);
            }
            Ok(pb::DirectorySearchResponse { results: out }.encode_to_vec())
        }
        "identity.profile.set_name" => {
            require_user(&req)?;
            let r: pb::ProfileSetNameRequest = body(&req)?;
            let mut p = json!({"token": req.token, "display_name": r.display_name});
            if let Some(x) = r.bio {
                p["bio"] = json!(x);
            }
            if let Some(x) = r.birthday {
                p["birthday"] = json!(x);
            }
            if let Some(x) = r.name_color {
                p["name_color"] = json!(x);
            }
            if let Some(x) = r.personal_channel {
                p["personal_channel"] = json!(x);
            }
            if let Some(x) = r.phone {
                p["phone"] = json!(x);
            }
            let v = v1_call(nc, p, |msg| handle_setname(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::ProfileSetNameResponse {}.encode_to_vec())
        }
        "identity.profile.set_avatar" => {
            require_user(&req)?;
            let r: pb::ProfileSetAvatarRequest = body(&req)?;
            let v = v1_call(nc, json!({"token": req.token, "file_id": r.avatar_file_id}), |msg| handle_setavatar(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::ProfileSetAvatarResponse {}.encode_to_vec())
        }

        // ── линковка (LINK-1 v2, правила v1) ──
        "identity.link.offer" => {
            require_user(&req)?;
            let r: pb::LinkOfferRequest = body(&req)?;
            let p = json!({"token": req.token, "device_id": req.device_id, "eph_pub": r.eph_pub, "commitment": r.commitment, "signing_key": r.signing_key, "revoke": r.revoke});
            let v = v1_call(nc, p, |msg| handle_link_offer(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::LinkOfferResponse {}.encode_to_vec())
        }
        "identity.link.poll" => {
            require_user(&req)?;
            let v = v1_call(nc, json!({"token": req.token, "device_id": req.device_id}), |msg| handle_link_poll(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            let offers = v["offers"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .take(16)
                .map(|o| pb::LinkOffer {
                    device_id: s(o, "device_id"),
                    eph_pub: s(o, "eph_pub"),
                    commitment: s(o, "commitment"),
                    signing_key: s(o, "signing_key"),
                    created_ms: o["created_at"].as_i64().unwrap_or(0) * 1000,
                    challenge_pub: s(o, "challenge_pub"),
                })
                .collect();
            let grant = v.get("grant").filter(|g| g.is_object()).map(|g| pb::LinkGrant {
                from_device_id: String::new(),
                box_payload: s(g, "box_payload"),
                eph_pub: s(g, "eph_pub"),
            });
            Ok(pb::LinkPollResponse { offers, grant, challenge: s(&v, "challenge") }.encode_to_vec())
        }
        "identity.link.challenge" => {
            require_user(&req)?;
            let r: pb::LinkChallengeRequest = body(&req)?;
            let v = v1_call(nc, json!({"token": req.token, "device_id": r.device_id, "eph_pub": r.eph_pub}), |msg| handle_link_challenge(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::LinkChallengeResponse {}.encode_to_vec())
        }
        "identity.link.grant" => {
            require_user(&req)?;
            let r: pb::LinkGrantRequest = body(&req)?;
            let p = json!({"token": req.token, "device_id": r.device_id, "box_payload": r.box_payload, "eph_pub": r.eph_pub});
            let v = v1_call(nc, p, |msg| handle_link_grant(nc, pool, dec, msg)).await?;
            v1_ok(&v)?;
            Ok(pb::LinkGrantResponse {}.encode_to_vec())
        }

        // ── устройства и корень (журнал устройств) ──
        "identity.device.log_append" => {
            require_user(&req)?;
            let r: pb::DeviceLogAppendRequest = body(&req)?;
            let op = r.entry.ok_or(ErrorCode::Invalid)?;
            let v = log_append(ctx, &req.user, &op).await?;
            Ok(pb::DeviceLogAppendResponse { version: v }.encode_to_vec())
        }
        "identity.device.log_sync" => {
            require_user(&req)?;
            let r: pb::DeviceLogSyncRequest = body(&req)?;
            let user = r.user.map(|u| u.address).unwrap_or_default();
            let (entries, more) = log_sync(ctx, &user, r.after_version).await?;
            let genesis_hash = log_genesis_hash(ctx, &user).await;
            Ok(pb::DeviceLogSyncResponse { entries, more, genesis_hash }.encode_to_vec())
        }
        "identity.device.log_sync_anon" => {
            let r: pb::DeviceLogSyncAnonRequest = body(&req)?;
            let user = r.user.map(|u| u.address).unwrap_or_default();
            let (entries, more) = log_sync(ctx, &user, r.after_version).await?;
            let genesis_hash = log_genesis_hash(ctx, &user).await;
            Ok(pb::DeviceLogSyncAnonResponse { entries, more, genesis_hash }.encode_to_vec())
        }
        "identity.device.publish_certificate" => {
            require_user(&req)?;
            let r: pb::DevicePublishCertificateRequest = body(&req)?;
            publish_certificate(ctx, &req, r).await
        }
        "identity.device.fetch_bundle" => {
            require_user(&req)?;
            let r: pb::DeviceFetchBundleRequest = body(&req)?;
            let user = r.user.map(|u| u.address).unwrap_or_default();
            let (devices, legacy) = fetch_bundle(ctx, &user).await?;
            Ok(pb::DeviceFetchBundleResponse { devices, legacy_device_ids: legacy }.encode_to_vec())
        }
        "identity.device.fetch_bundle_anon" => {
            let r: pb::DeviceFetchBundleAnonRequest = body(&req)?;
            let user = r.user.map(|u| u.address).unwrap_or_default();
            let (devices, _) = fetch_bundle(ctx, &user).await?;
            Ok(pb::DeviceFetchBundleAnonResponse { devices }.encode_to_vec())
        }
        "identity.device.list" => {
            require_user(&req)?;
            device_list(ctx, &req.user).await
        }
        "identity.device.revoke" => {
            require_user(&req)?;
            if !req.reauth_fresh {
                return Err(ErrorCode::ReauthRequired);
            }
            let r: pb::DeviceRevokeRequest = body(&req)?;
            device_revoke(ctx, &req.user, &r.device_id).await
        }
        "identity.root.rotate" => {
            require_user(&req)?;
            if !req.reauth_fresh {
                return Err(ErrorCode::ReauthRequired);
            }
            let r: pb::RootRotateRequest = body(&req)?;
            root_rotate(ctx, &req.user, &req.device_id, &r.genesis.ok_or(ErrorCode::Invalid)?).await
        }
        // FR-066 (T130): копия корня под ключом восстановления — шифртекст.
        "identity.root.backup_set" => {
            require_user(&req)?;
            let r: pb::RootBackupSetRequest = body(&req)?;
            if r.backup.is_empty() && r.escrow.is_empty() {
                return Err(ErrorCode::Invalid);
            }
            // Пишет только активное устройство журнала: сессия без устройства
            // (пароль утёк) не должна затирать копию.
            let log = load_log(ctx, &req.user).await?;
            if log.active(&req.device_id).is_none() {
                return Err(ErrorCode::Forbidden);
            }
            if !r.escrow.is_empty() {
                // Копия для администратора — только для действующего корня журнала
                // и только когда сервер объявил ключ администратора.
                let root_pub = parvane_protocol::recovery::escrow_root_pub(&r.escrow).map_err(|_| ErrorCode::Invalid)?;
                if escrow_public_key().is_none() || root_pub != log.root_key {
                    return Err(ErrorCode::Invalid);
                }
                sqlx::query("INSERT OR REPLACE INTO root_escrow (user, escrow, updated_at) VALUES (?, ?, ?)")
                    .bind(&req.user)
                    .bind(&r.escrow)
                    .bind(now_unix())
                    .execute(&ctx.v2)
                    .await
                    .map_err(db_err)?;
            }
            if !r.backup.is_empty() {
                sqlx::query("INSERT OR REPLACE INTO root_backup (user, backup, updated_at) VALUES (?, ?, ?)")
                    .bind(&req.user)
                    .bind(&r.backup)
                    .bind(now_unix())
                    .execute(&ctx.v2)
                    .await
                    .map_err(db_err)?;
            }
            Ok(pb::RootBackupSetResponse {}.encode_to_vec())
        }
        "identity.root.backup_get" => {
            require_user(&req)?;
            let _: pb::RootBackupGetRequest = body(&req)?;
            let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT backup FROM root_backup WHERE user = ?")
                .bind(&req.user)
                .fetch_optional(&ctx.v2)
                .await
                .map_err(db_err)?;
            let escrow: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM root_escrow WHERE user = ?")
                .bind(&req.user)
                .fetch_optional(&ctx.v2)
                .await
                .map_err(db_err)?;
            Ok(pb::RootBackupGetResponse { backup: row.map(|(b,)| b).unwrap_or_default(), has_escrow: escrow.is_some() }.encode_to_vec())
        }

        // ── доступ к доставке, жетоны, приватность ──
        "identity.delivery_key.set" => {
            require_user(&req)?;
            let r: pb::DeliveryKeySetRequest = body(&req)?;
            if r.delivery_key.len() != 32 {
                return Err(ErrorCode::Invalid);
            }
            let hash: [u8; 32] = Sha256::digest(&r.delivery_key).into();
            sqlx::query("INSERT OR REPLACE INTO delivery_keys (user, key_hash, rotated_at) VALUES (?, ?, ?)")
                .bind(&req.user)
                .bind(hash.to_vec())
                .bind(now_unix())
                .execute(&ctx.v2)
                .await
                .map_err(db_err)?;
            Ok(pb::DeliveryKeySetResponse {}.encode_to_vec())
        }
        "identity.tokens.key_list" => Ok(pb::TokensKeyListResponse { list: Some(ctx.key_list().await) }.encode_to_vec()),
        "identity.tokens.issue_blinded" => {
            require_user(&req)?;
            let r: pb::TokensIssueBlindedRequest = body(&req)?;
            issue_tokens(ctx, &req.user, r).await
        }
        "identity.privacy.set" => {
            require_user(&req)?;
            let r: pb::PrivacySetRequest = body(&req)?;
            let p = r.settings.unwrap_or_default();
            let aud = |a: i32| i64::from(if a == 0 { 1 } else { a });
            sqlx::query(
                "INSERT OR REPLACE INTO privacy (user, group_add, messages_from_strangers, calls_from, presence_visibility) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&req.user)
            .bind(aud(p.group_add))
            .bind(i64::from(p.messages_from_strangers))
            .bind(aud(p.calls_from))
            .bind(aud(p.presence_visibility))
            .execute(&ctx.v2)
            .await
            .map_err(db_err)?;
            Ok(pb::PrivacySetResponse {}.encode_to_vec())
        }
        "identity.privacy.get" => {
            require_user(&req)?;
            let row: Option<(i64, i64, i64, i64)> = sqlx::query_as(
                "SELECT group_add, messages_from_strangers, calls_from, presence_visibility FROM privacy WHERE user = ?",
            )
            .bind(&req.user)
            .fetch_optional(&ctx.v2)
            .await
            .map_err(db_err)?;
            let aud = |v: i64| i32::try_from(v).unwrap_or(1);
            let (settings, is_set) = match row {
                Some((g, s, c, p)) => (
                    pb::PrivacySettings {
                        group_add: aud(g),
                        messages_from_strangers: s != 0,
                        calls_from: aud(c),
                        presence_visibility: aud(p),
                    },
                    true,
                ),
                None => (
                    pb::PrivacySettings { group_add: 1, messages_from_strangers: true, calls_from: 1, presence_visibility: 1 },
                    false,
                ),
            };
            Ok(pb::PrivacyGetResponse { settings: Some(settings), is_set }.encode_to_vec())
        }

        // ── оператор ──
        "server.stats.versions" => {
            if !req.operator {
                return Err(ErrorCode::Forbidden);
            }
            stats_versions(ctx).await
        }
        _ => Err(ErrorCode::Unavailable),
    }
}

// ── reauth ──────────────────────────────────────────────────────────────────

/// Свежее подтверждение паролем: сессия (user из gateway) + пароль.
async fn reauth(ctx: &V2Ctx, req: &ShardRequest) -> Reply {
    if req.user.is_empty() {
        return Err(ErrorCode::Forbidden);
    }
    let r: pb::SessionReauthRequest = body(req)?;
    login_gate_check(&req.user).map_err(|_| ErrorCode::RateLimited)?;
    let row: Option<(String,)> = sqlx::query_as("SELECT password_hash FROM users WHERE username = ?")
        .bind(&req.user)
        .fetch_optional(&ctx.pool)
        .await
        .map_err(db_err)?;
    let ok = match row {
        Some((hash,)) => verify_password(&r.password, &hash),
        None => {
            let _ = verify_password(&r.password, dummy_password_hash());
            false
        }
    };
    if !ok {
        login_record_failure(&req.user);
        return Err(ErrorCode::Forbidden);
    }
    login_record_success(&req.user);
    Ok(pb::SessionReauthResponse { valid_until_ms: now_unix() * 1000 + REAUTH_WINDOW_MS }.encode_to_vec())
}

// ── профиль ─────────────────────────────────────────────────────────────────

async fn root_key_of(ctx: &V2Ctx, user: &str) -> Vec<u8> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT entry FROM device_log WHERE user = ? AND version = 1")
        .bind(user)
        .fetch_optional(&ctx.v2)
        .await
        .unwrap_or(None);
    row.and_then(|(e,)| SignedOp::decode(e.as_slice()).ok())
        .and_then(|op| parvane_protocol::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()).ok())
        .and_then(|b| UserDeviceLogEntry::decode(b.payload.as_slice()).ok())
        .map(|e| e.root_key)
        .unwrap_or_default()
}

async fn profile_from_v1(ctx: &V2Ctx, u: &Value) -> pb::PublicProfile {
    let user = s(u, "username");
    pb::PublicProfile {
        root_key: root_key_of(ctx, &user).await,
        user: Some(UserRef { address: user }),
        display_name: s(u, "display_name"),
        avatar_file_id: s(u, "avatar"),
        bio: s(u, "bio"),
        birthday: s(u, "birthday"),
        name_color: u["name_color"].as_i64(),
        personal_channel: s(u, "personal_channel"),
        phone: s(u, "phone"),
    }
}

// ── журнал устройств ────────────────────────────────────────────────────────

async fn load_log(ctx: &V2Ctx, user: &str) -> Result<DeviceLog, ErrorCode> {
    let mut log = DeviceLog::new(user).map_err(|_| ErrorCode::Invalid)?;
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as("SELECT entry FROM device_log WHERE user = ? ORDER BY version")
        .bind(user)
        .fetch_all(&ctx.v2)
        .await
        .map_err(db_err)?;
    for (e,) in rows {
        let op = SignedOp::decode(e.as_slice()).map_err(db_err)?;
        if let Err(err) = log.apply(&op) {
            error!("журнал устройств {} повреждён: {}", user, err);
            return Err(ErrorCode::Unavailable);
        }
    }
    Ok(log)
}

/// Перестроить производное состояние устройств из журнала.
async fn store_state(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, user: &str, log: &DeviceLog) -> Result<(), ErrorCode> {
    sqlx::query("DELETE FROM device_state WHERE user = ?").bind(user).execute(&mut **tx).await.map_err(db_err)?;
    for (id, d) in &log.devices {
        sqlx::query(
            "INSERT INTO device_state (user, device_id, cert, serial, proto_major, proto_minor, revoked, created_at, ed25519) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .bind(user)
        .bind(id)
        .bind(d.cert.encode_to_vec())
        .bind(d.cert.serial as i64)
        .bind(i64::from(d.cert.proto_major))
        .bind(i64::from(d.cert.proto_minor))
        .bind(d.cert.created_ms / 1000)
        .bind(d.cert.olm_ed25519.clone())
        .execute(&mut **tx)
        .await
        .map_err(db_err)?;
    }
    for id in &log.revoked {
        sqlx::query(
            "INSERT OR REPLACE INTO device_state (user, device_id, cert, serial, proto_major, proto_minor, revoked, created_at) VALUES (?, ?, x'', 0, 0, 0, 1, ?)",
        )
        .bind(user)
        .bind(id)
        .bind(now_unix())
        .execute(&mut **tx)
        .await
        .map_err(db_err)?;
    }
    Ok(())
}

/// Добавить запись в журнал (проверка цепочки движком) и применить последствия.
pub(crate) async fn log_append(ctx: &V2Ctx, user: &str, op: &SignedOp) -> Result<u64, ErrorCode> {
    let mut log = load_log(ctx, user).await?;
    let before_revoked = log.revoked.clone();
    let before_devices: std::collections::BTreeSet<String> = log.devices.keys().cloned().collect();
    log.apply(op).map_err(|e| e.code())?;
    let hash = parvane_protocol::identity::device_log_hash(op);
    let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    sqlx::query("INSERT INTO device_log (user, version, entry, hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(user)
        .bind(log.version as i64)
        .bind(op.encode_to_vec())
        .bind(hash.to_vec())
        .bind(now_unix())
        .execute(&mut *tx)
        .await
        .map_err(|_| ErrorCode::Duplicate)?;
    claim_device_keys(&mut tx, user, &log).await?;
    store_state(&mut tx, user, &log).await?;
    tx.commit().await.map_err(db_err)?;
    // Отзыв: v1-тумбстоун (сессии v1), закрытие v2-сессий ≤ 1 с (класс 5).
    for id in log.revoked.difference(&before_revoked) {
        revoke_effects(ctx, user, id).await;
    }
    // T119: «новое устройство» — живым событием во все прочие устройства.
    let added: Vec<&String> = log.devices.keys().filter(|id| !before_devices.contains(*id)).collect();
    if !added.is_empty() {
        notify_device_added(ctx, user, &log, &added).await;
    }
    Ok(log.version)
}

async fn notify_device_added(ctx: &V2Ctx, user: &str, log: &parvane_protocol::identity::DeviceLog, added: &[&String]) {
    use parvane_protocol::pb::parvane::msg::v2::{inbox_record, DeviceAddedNotice, InboxRecord};
    for new_id in added {
        let rec = InboxRecord {
            seq: 0,
            received_ms: 0,
            item: Some(inbox_record::Item::DeviceAdded(DeviceAddedNotice { device_id: (*new_id).clone(), log_version: log.version })),
        };
        let bytes = rec.encode_to_vec();
        for other in log.devices.keys().filter(|id| id != new_id) {
            let Ok(subject) = parvane_protocol::registry_gen::inbox_subject(user, other) else { continue };
            if let Err(e) = ctx.nc.publish(subject, bytes.clone().into()).await {
                warn!("v2: уведомление о новом устройстве не отправлено: {}", e);
            }
        }
    }
    info!("v2: новое устройство в журнале {}: {}", user, added.len());
}

async fn revoke_effects(ctx: &V2Ctx, user: &str, device_id: &str) {
    if let Err(e) = revoke_device(&ctx.pool, user, device_id).await {
        error!("отзыв {}: {}", device_id, e);
    }
    let _ = sqlx::query("DELETE FROM one_time_keys WHERE user = ? AND device_id = ?").bind(user).bind(device_id).execute(&ctx.v2).await;
    let _ = sqlx::query("DELETE FROM fallback_keys WHERE user = ? AND device_id = ?").bind(user).bind(device_id).execute(&ctx.v2).await;
    let n = RevokedNotice { user: user.to_string(), device_id: device_id.to_string() };
    if let Err(e) = ctx.nc.publish(REVOKED_SUBJECT.to_string(), n.encode_to_vec().into()).await {
        error!("отзыв {}: уведомление gateway: {}", device_id, e);
    }
    info!("v2: устройство отозвано: {} / {}", user, device_id);
}

async fn log_sync(ctx: &V2Ctx, user: &str, after: u64) -> Result<(Vec<SignedOp>, bool), ErrorCode> {
    if !parvane_protocol::address::is_valid_address(user) {
        return Err(ErrorCode::Invalid);
    }
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as("SELECT entry FROM device_log WHERE user = ? AND version > ? ORDER BY version LIMIT 257")
        .bind(user)
        .bind(after as i64)
        .fetch_all(&ctx.v2)
        .await
        .map_err(db_err)?;
    let more = rows.len() > 256;
    let entries = rows.into_iter().take(256).filter_map(|(e,)| SignedOp::decode(e.as_slice()).ok()).collect();
    Ok((entries, more))
}

/// SHA-256 первой записи журнала пользователя (пусто — журнала нет): по нему
/// собеседники замечают, что журнал начат заново (смена корня, T129).
async fn log_genesis_hash(ctx: &V2Ctx, user: &str) -> Vec<u8> {
    sqlx::query_as::<_, (Vec<u8>,)>("SELECT hash FROM device_log WHERE user = ? AND version = 1")
        .bind(user)
        .fetch_optional(&ctx.v2)
        .await
        .ok()
        .flatten()
        .map(|(h,)| h)
        .unwrap_or_default()
}

async fn publish_certificate(ctx: &V2Ctx, req: &ShardRequest, r: pb::DevicePublishCertificateRequest) -> Reply {
    if let Some(entry) = r.log_entry.filter(|e| !e.body.is_empty()) {
        log_append(ctx, &req.user, &entry).await?;
    }
    let log = load_log(ctx, &req.user).await?;
    let dev: &VerifiedDevice = log.active(&req.device_id).ok_or(ErrorCode::Forbidden)?;
    let ed = dev.olm_ed25519().map_err(|_| ErrorCode::Invalid)?;
    let check = |k: &pb::OneTimeKey| {
        k.curve25519.len() == 32
            && parvane_protocol::sign::verify_ctx(&ed, &k.signature, parvane_protocol::sign::ctx::OTK, &[&k.key_id, &k.curve25519]).is_ok()
    };
    let mut stored = 0u32;
    let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    for k in r.one_time_keys.iter() {
        if !check(k) {
            return Err(ErrorCode::Invalid);
        }
        let res = sqlx::query("INSERT OR IGNORE INTO one_time_keys (user, device_id, key_id, curve, signature) VALUES (?, ?, ?, ?, ?)")
            .bind(&req.user)
            .bind(&req.device_id)
            .bind(&k.key_id)
            .bind(&k.curve25519)
            .bind(&k.signature)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        stored += res.rows_affected() as u32;
    }
    if let Some(f) = r.fallback_key.as_ref() {
        if !check(f) {
            return Err(ErrorCode::Invalid);
        }
        sqlx::query("INSERT OR REPLACE INTO fallback_keys (user, device_id, key_id, curve, signature) VALUES (?, ?, ?, ?, ?)")
            .bind(&req.user)
            .bind(&req.device_id)
            .bind(&f.key_id)
            .bind(&f.curve25519)
            .bind(&f.signature)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(pb::DevicePublishCertificateResponse { one_time_keys_stored: stored }.encode_to_vec())
}

async fn fetch_bundle(ctx: &V2Ctx, user: &str) -> Result<(Vec<pb::DeviceBundle>, Vec<String>), ErrorCode> {
    if !parvane_protocol::address::is_valid_address(user) {
        return Err(ErrorCode::Invalid);
    }
    // Сверх лимита на адресата (D-17, выкачивание OTK) — не отказ, а бандл
    // только с fallback-ключом: OTK не расходуются, а первый контакт с
    // адресатом не блокируется чужим флудом. Частоту запросов с одного
    // IP-источника режет gateway (ANON — до шины, IP в шину не уходит).
    let spend_otk = window_rate_ok("v2-bundle", user, bundle_rate());
    let log = load_log(ctx, user).await?;
    let signed_certs = signed_certificates(ctx, user).await?;
    let mut out = Vec::new();
    for id in log.devices.keys() {
        let Some(cert) = signed_certs.get(id) else { continue };
        let fb: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as("SELECT key_id, curve, signature FROM fallback_keys WHERE user = ? AND device_id = ?")
            .bind(user)
            .bind(id)
            .fetch_optional(&ctx.v2)
            .await
            .map_err(db_err)?;
        // Без fallback-ключа устройству иначе не написать — OTK отдаётся и сверх лимита.
        let otk: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = if spend_otk || fb.is_none() {
            sqlx::query_as(
                "DELETE FROM one_time_keys WHERE rowid = (SELECT rowid FROM one_time_keys WHERE user = ? AND device_id = ? LIMIT 1) RETURNING key_id, curve, signature",
            )
            .bind(user)
            .bind(id)
            .fetch_optional(&ctx.v2)
            .await
            .map_err(db_err)?
        } else {
            None
        };
        let mk = |t: (Vec<u8>, Vec<u8>, Vec<u8>)| pb::OneTimeKey { key_id: t.0, curve25519: t.1, signature: t.2 };
        out.push(pb::DeviceBundle { certificate: Some(cert.clone()), one_time_key: otk.map(mk), fallback_key: fb.map(mk) });
    }
    let legacy = legacy_devices(ctx, user, &log).await?;
    Ok((out, legacy))
}

/// Подписанные сертификаты активных устройств (из записей add_device журнала).
async fn signed_certificates(ctx: &V2Ctx, user: &str) -> Result<std::collections::HashMap<String, parvane_protocol::pb::parvane::core::v2::SignedDeviceCertificate>, ErrorCode> {
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as("SELECT entry FROM device_log WHERE user = ? ORDER BY version")
        .bind(user)
        .fetch_all(&ctx.v2)
        .await
        .map_err(db_err)?;
    let mut m = std::collections::HashMap::new();
    for (e,) in rows {
        let Ok(op) = SignedOp::decode(e.as_slice()) else { continue };
        let Ok(b) = parvane_protocol::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()) else { continue };
        let Ok(entry) = UserDeviceLogEntry::decode(b.payload.as_slice()) else { continue };
        match entry.change {
            Some(Change::AddDevice(c)) => {
                if let Ok(v) = parvane_protocol::identity::verify_certificate(&c, Some(user)) {
                    m.insert(v.cert.device_id, c);
                }
            }
            Some(Change::RevokeDeviceId(id)) => {
                m.remove(&id);
            }
            Some(Change::RotateSelfSigningKey(_)) => m.clear(),
            _ => {}
        }
    }
    Ok(m)
}

/// v1-устройства без сертификата v2.
async fn legacy_devices(ctx: &V2Ctx, user: &str, log: &DeviceLog) -> Result<Vec<String>, ErrorCode> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT device_id FROM device_keys WHERE username = ?")
        .bind(user)
        .fetch_all(&ctx.pool)
        .await
        .map_err(db_err)?;
    Ok(rows.into_iter().map(|(d,)| d).filter(|d| !log.devices.contains_key(d) && !log.revoked.contains(d)).take(64).collect())
}

async fn devices_of(ctx: &V2Ctx, user: &str) -> Result<DevicesOfResponse, ErrorCode> {
    let log = load_log(ctx, user).await?;
    Ok(DevicesOfResponse {
        v2_device_ids: log.devices.keys().take(64).cloned().collect(),
        v2_ed25519: log.devices.values().take(64).map(|d| d.cert.olm_ed25519.clone()).collect(),
        legacy_device_ids: legacy_devices(ctx, user, &log).await?,
        has_v2: log.version > 0,
    })
}

async fn delivery_key_check(ctx: &V2Ctx, r: &DeliveryKeyCheckRequest) -> DeliveryKeyCheckResponse {
    let stored: Option<(Vec<u8>,)> = sqlx::query_as("SELECT key_hash FROM delivery_keys WHERE user = ?")
        .bind(&r.user)
        .fetch_optional(&ctx.v2)
        .await
        .unwrap_or(None);
    let key_ok = match stored {
        Some((h,)) if h.len() == 32 && r.key_hash.len() == 32 => h.iter().zip(&r.key_hash).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0,
        _ => false,
    };
    let strangers: Option<(i64,)> = sqlx::query_as("SELECT messages_from_strangers FROM privacy WHERE user = ?")
        .bind(&r.user)
        .fetch_optional(&ctx.v2)
        .await
        .unwrap_or(None);
    DeliveryKeyCheckResponse { key_ok, strangers_allowed: strangers.map(|(v,)| v != 0).unwrap_or(true) }
}

async fn device_list(ctx: &V2Ctx, user: &str) -> Reply {
    let log = load_log(ctx, user).await?;
    let labels = crate::devices::device_labels(&ctx.pool, user).await;
    let label_of = |id: &str| labels.get(id).map(|(label, _)| label.clone()).unwrap_or_default();
    let mut devices: Vec<pb::DeviceInfo> = log
        .devices
        .values()
        .map(|d| pb::DeviceInfo {
            device_id: d.cert.device_id.clone(),
            legacy: false,
            revoked: false,
            // Время входа (если устройство назвало себя), иначе — выпуска сертификата
            created_ms: labels.get(&d.cert.device_id).map(|(_, at)| at * 1000).unwrap_or(d.cert.created_ms),
            last_seen_ms: 0,
            client_kind: label_of(&d.cert.device_id),
            proto_major: d.cert.proto_major,
            proto_minor: d.cert.proto_minor,
        })
        .collect();
    let v1 = list_devices(&ctx.pool, user).await.map_err(db_err)?;
    for d in v1 {
        if let Some(x) = devices.iter_mut().find(|x| x.device_id == d.device_id) {
            x.last_seen_ms = d.updated_at * 1000;
        } else if !log.revoked.contains(&d.device_id) {
            let client_kind = label_of(&d.device_id);
            devices.push(pb::DeviceInfo { device_id: d.device_id, legacy: true, last_seen_ms: d.updated_at * 1000, proto_major: 1, client_kind, ..Default::default() });
        }
    }
    devices.truncate(64);
    Ok(pb::DeviceListResponse { devices }.encode_to_vec())
}

async fn device_revoke(ctx: &V2Ctx, user: &str, device_id: &str) -> Reply {
    if !parvane_protocol::address::is_valid_device_id(device_id) {
        return Err(ErrorCode::Invalid);
    }
    let log = load_log(ctx, user).await?;
    // v2-устройство отзывается подписанной записью журнала (log_append) —
    // сервер не может «отозвать» его сам; здесь — только легаси-устройства.
    if log.devices.contains_key(device_id) {
        return Err(ErrorCode::Invalid);
    }
    revoke_effects(ctx, user, device_id).await;
    Ok(pb::DeviceRevokeResponse {}.encode_to_vec())
}

async fn root_rotate(ctx: &V2Ctx, user: &str, device: &str, genesis: &SignedOp) -> Reply {
    let mut fresh = DeviceLog::new(user).map_err(|_| ErrorCode::Invalid)?;
    fresh.apply(genesis).map_err(|e| e.code())?;
    let old = load_log(ctx, user).await?;
    let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    sqlx::query("INSERT INTO device_log_archive (user, version, entry, archived_at) SELECT user, version, entry, ? FROM device_log WHERE user = ?")
        .bind(now_unix())
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM device_log WHERE user = ?").bind(user).execute(&mut *tx).await.map_err(db_err)?;
    // Копия прежнего корня больше не нужна (новый корень — новая копия).
    sqlx::query("DELETE FROM root_backup WHERE user = ?").bind(user).execute(&mut *tx).await.map_err(db_err)?;
    sqlx::query("DELETE FROM root_escrow WHERE user = ?").bind(user).execute(&mut *tx).await.map_err(db_err)?;
    sqlx::query("INSERT INTO device_log (user, version, entry, hash, created_at) VALUES (?, 1, ?, ?, ?)")
        .bind(user)
        .bind(genesis.encode_to_vec())
        .bind(parvane_protocol::identity::device_log_hash(genesis).to_vec())
        .bind(now_unix())
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    store_state(&mut tx, user, &fresh).await?;
    tx.commit().await.map_err(db_err)?;
    // Устройства прежнего корня в новую личность не входят: их сессии v1 и v2
    // гасятся, а записи каталога v1 удаляются — иначе новое первое устройство
    // внесло бы «потерянные» устройства в подписанный список v1-устройств
    // (LEGACY-1), и им продолжали бы уходить копии сообщений. Вернуться они
    // могут только линковкой. Устройство, выполняющее сброс, не трогаем.
    for id in old.devices.keys().filter(|id| id.as_str() != device) {
        revoke_effects(ctx, user, id).await;
    }
    warn!("v2: смена корня у {} (журнал устройств начат заново)", user);
    Ok(pb::RootRotateResponse {}.encode_to_vec())
}

// ── жетоны ──────────────────────────────────────────────────────────────────

fn day_now() -> i64 {
    now_unix().div_euclid(86_400)
}

impl V2Ctx {
    /// Ключи выпуска: сегодня и вчера (жетон принимается до конца следующих суток).
    async fn rotate_token_keys(&self) {
        let today = day_now();
        let mut keys = Vec::new();
        for day in [today - 1, today] {
            let path = self.token_dir.join(format!("token-{day}.der"));
            let from = day * 86_400_000;
            let until = (day + 2) * 86_400_000;
            let issuer = match std::fs::read(&path) {
                Ok(der) => Issuer::from_der(&der, from, until).ok(),
                Err(_) if day == today => match Issuer::generate(from, until) {
                    Ok(i) => {
                        match i.secret_der() {
                            Ok(der) => {
                                if let Err(e) = std::fs::create_dir_all(&self.token_dir).and_then(|_| write_secret_file(&path, &der).map_err(std::io::Error::other)) {
                                    error!("ключ жетонов {}: {}", path.display(), e);
                                }
                            }
                            Err(e) => error!("ключ жетонов: экспорт: {}", e),
                        }
                        Some(i)
                    }
                    Err(e) => {
                        error!("ключ жетонов: генерация: {}", e);
                        None
                    }
                },
                Err(_) => None,
            };
            if let Some(i) = issuer {
                keys.push(Arc::new(i));
            }
        }
        // Старые файлы ключей удаляются (срок приёма истёк).
        if let Ok(rd) = std::fs::read_dir(&self.token_dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Some(d) = name.strip_prefix("token-").and_then(|x| x.strip_suffix(".der")).and_then(|x| x.parse::<i64>().ok()) {
                    if d < today - 1 {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
        *self.issuers.write().await = keys;
    }

    async fn key_list(&self) -> parvane_protocol::pb::parvane::core::v2::SignedTokenKeyList {
        // Сутки сменились раньше часового таймера — ключ нового дня по требованию
        let today_ms = day_now() * 86_400_000;
        if !self.issuers.read().await.iter().any(|i| i.valid_from_ms == today_ms) {
            self.rotate_token_keys().await;
        }
        let keys = self.issuers.read().await.iter().map(|i| i.token_key()).collect();
        parvane_protocol::tokens::sign_key_list(&self.server_key, keys, now_unix() * 1000)
    }
}

async fn issue_tokens(ctx: &V2Ctx, user: &str, r: pb::TokensIssueBlindedRequest) -> Reply {
    let n = r.blinded.len() as i64;
    if n == 0 || n > TOKENS_PER_DAY {
        return Err(ErrorCode::Invalid);
    }
    let day = day_now();
    let today = |issuers: &[Arc<Issuer>]| issuers.iter().find(|i| i.valid_from_ms == day * 86_400_000).cloned();
    let mut issuer = today(&ctx.issuers.read().await);
    if issuer.is_none() {
        // Сутки сменились, а ключи обновляет часовой таймер: до его срабатывания
        // (до часа после полуночи UTC) жетонов не получал никто, и первое сообщение
        // новому собеседнику не уходило. Ключ нового дня создаётся по требованию.
        ctx.rotate_token_keys().await;
        issuer = today(&ctx.issuers.read().await);
    }
    let issuer = issuer.ok_or(ErrorCode::Unavailable)?;
    let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    let (used,): (i64,) = sqlx::query_as("SELECT COALESCE((SELECT count FROM token_issuance WHERE user = ? AND day = ?), 0)")
        .bind(user)
        .bind(day)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
    if used + n > TOKENS_PER_DAY {
        return Err(ErrorCode::Limit);
    }
    sqlx::query("INSERT OR REPLACE INTO token_issuance (user, day, count) VALUES (?, ?, ?)")
        .bind(user)
        .bind(day)
        .bind(used + n)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    let sigs = issuer.issue(&r.blinded).map_err(|e| e.code())?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::TokensIssueBlindedResponse { key_id: issuer.key_id().to_vec(), public_key: issuer.spki().to_vec(), blind_signatures: sigs }.encode_to_vec())
}

// ── статистика (T051) ───────────────────────────────────────────────────────

async fn stats_versions(ctx: &V2Ctx) -> Reply {
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT proto_major, proto_minor, COUNT(*) FROM device_state WHERE revoked = 0 GROUP BY proto_major, proto_minor ORDER BY proto_major, proto_minor",
    )
    .fetch_all(&ctx.v2)
    .await
    .map_err(db_err)?;
    let versions = rows
        .into_iter()
        .take(256)
        .map(|(ma, mi, n)| pb::VersionCount { proto_major: ma as u32, proto_minor: mi as u32, client_kind: String::new(), devices: n as u64 })
        .collect();
    // Легаси: v1-устройства, у которых нет v2-сертификата.
    let v2_ids: Vec<(String, String)> = sqlx::query_as("SELECT user, device_id FROM device_state").fetch_all(&ctx.v2).await.map_err(db_err)?;
    let v2_set: std::collections::HashSet<(String, String)> = v2_ids.into_iter().collect();
    let v1: Vec<(String, String)> = sqlx::query_as("SELECT username, device_id FROM device_keys").fetch_all(&ctx.pool).await.map_err(db_err)?;
    let legacy = v1.into_iter().filter(|k| !v2_set.contains(k)).count() as u64;
    Ok(pb::ServerStatsVersionsResponse { versions, legacy_devices: legacy }.encode_to_vec())
}
