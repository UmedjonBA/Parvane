//! Тесты шарда (вынесены из main.rs, п. 4.7).

use crate::*;
use argon2::password_hash::rand_core::OsRng;

fn make_keys() -> (EncodingKey, DecodingKey) {
    let signing = ed25519_dalek::SigningKey::generate(&mut OsRng);
    let (enc, dec, _kid) = keys_from_signing(&signing).unwrap();
    (enc, dec)
}

#[test]
fn jwt_roundtrip() {
    let (enc, dec) = make_keys();
    let now = now_unix() as usize;
    let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600, dev: None };
    let token = jwt_encode(&enc, &claims).unwrap();

    let req = serde_json::to_vec(&VerifyRequest { token }).unwrap();
    let user = do_verify(&dec, &req).unwrap().sub;
    assert_eq!(user, "alice@local");
}

#[test]
fn window_rate_limits_per_scope_and_key() {
    assert!(window_rate_ok("t-scope", "1.2.3.4", 2));
    assert!(window_rate_ok("t-scope", "1.2.3.4", 2));
    assert!(!window_rate_ok("t-scope", "1.2.3.4", 2), "третья за минуту — отказ");
    assert!(window_rate_ok("t-scope", "5.6.7.8", 2), "другой ключ — свой бюджет");
    assert!(window_rate_ok("t-other", "1.2.3.4", 2), "другой scope — свой бюджет");
}

#[test]
fn jwt_wrong_secret_rejected() {
    let (enc, _) = make_keys();
    let now = now_unix() as usize;
    let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600, dev: None };
    let token = jwt_encode(&enc, &claims).unwrap();

    let (_other_enc, other_dec) = make_keys(); // другой Ed25519-ключ
    let req = serde_json::to_vec(&VerifyRequest { token }).unwrap();
    assert!(do_verify(&other_dec, &req).is_err());
}

#[test]
fn legacy_hs256_accepted_only_inside_migration_window() {
    let (_enc, dec) = make_keys();
    let now = now_unix() as usize;
    let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600, dev: None };
    let secret = b"legacy-hs256-secret-32-bytes!!!!";
    let hs = encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(secret)).unwrap();
    // Без legacy-ключа HS256 отклоняется (P-11: alg-confusion невозможен).
    set_legacy_hs256(None);
    assert!(jwt_decode(&dec, &hs).is_err());
    // В окне миграции — принимается.
    set_legacy_hs256(Some((DecodingKey::from_secret(secret), now_unix() + 60)));
    assert_eq!(jwt_decode(&dec, &hs).unwrap().claims.sub, "alice@local");
    // После окна — снова отказ.
    set_legacy_hs256(Some((DecodingKey::from_secret(secret), now_unix() - 1)));
    assert!(jwt_decode(&dec, &hs).is_err());
    set_legacy_hs256(None);
    // EdDSA-токен с kid проходит основным ключом.
    let (enc2, dec2) = make_keys();
    let ed = jwt_encode(&enc2, &claims).unwrap();
    assert_eq!(jwt_decode(&dec2, &ed).unwrap().claims.sub, "alice@local");
    assert!(jwt_decode(&dec, &ed).is_err(), "чужой ключ не проходит");
}

#[tokio::test]
async fn jwt_key_file_is_created_0600_and_legacy_secret_moved_out_of_db() {
    let dir = std::env::temp_dir().join(format!("parvane-jwt-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("identity.db");
    let pool = test_pool().await;
    // legacy-секрет в БД, как на старых инсталляциях
    sqlx::query("INSERT INTO secret (id, bytes) VALUES (1, ?)").bind(&b"old-secret"[..]).execute(&pool).await.unwrap();
    std::env::remove_var("PARVANE_JWT_KEY_FILE");
    let (enc, dec) = load_or_create_jwt_keys(&pool, db_path.to_str().unwrap()).await.unwrap();
    let key_path = dir.join("identity-jwt-ed25519.pem");
    assert!(key_path.exists(), "ключ создан рядом с БД");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM secret").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0, "legacy-секрет вынесен из SQLite");
    assert!(dir.join("identity-jwt-ed25519.legacy-hs256").exists());
    // повторная загрузка читает тот же ключ (roundtrip подписи)
    let (enc2, dec2) = load_or_create_jwt_keys(&pool, db_path.to_str().unwrap()).await.unwrap();
    let now = now_unix() as usize;
    let claims = Claims { sub: "k@local".into(), iat: now, exp: now + 60, dev: None };
    let t = jwt_encode(&enc, &claims).unwrap();
    assert!(jwt_decode(&dec2, &t).is_ok());
    let t2 = jwt_encode(&enc2, &claims).unwrap();
    assert!(jwt_decode(&dec, &t2).is_ok());
    set_legacy_hs256(None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn password_verifies_correct_and_rejects_wrong() {
    let h = hash_password("secret").unwrap();
    assert!(verify_password("secret", &h));
    assert!(!verify_password("other", &h));
}

#[test]
fn password_salted_each_hash_differs() {
    // argon2 со случайной солью: один пароль → разные хэши (но оба проходят).
    let a = hash_password("secret").unwrap();
    let b = hash_password("secret").unwrap();
    assert_ne!(a, b);
    assert!(verify_password("secret", &a) && verify_password("secret", &b));
}

// ── публичные ключи (для аутентификации сигналинга звонков) ──

use sqlx::sqlite::SqlitePoolOptions;

async fn test_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    pool
}

async fn insert_user(pool: &SqlitePool, username: &str) {
    sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, '', 0)")
        .bind(username)
        .bind(username)
        .execute(pool)
        .await
        .unwrap();
}



// ── регистрация отделена от логина ──

fn issue_bytes_with_device(user: &str, password: &str, device: &str) -> Vec<u8> {
    serde_json::to_vec(&IssueRequest {
        user: user.into(), password: password.into(), device_id: Some(device.into()), login_token: None, trust_secret: None, client: None,
        client_ip: String::new(),
    })
    .unwrap()
}

fn issue_bytes_with_device_secret(user: &str, password: &str, device: &str, secret: &str) -> Vec<u8> {
    serde_json::to_vec(&IssueRequest {
        user: user.into(), password: password.into(), device_id: Some(device.into()), login_token: None,
        trust_secret: Some(secret.into()), client: None, client_ip: String::new(),
    })
    .unwrap()
}

fn issue_bytes(user: &str, password: &str) -> Vec<u8> {
    serde_json::to_vec(&IssueRequest {
        user: user.into(), password: password.into(), device_id: None, login_token: None, trust_secret: None, client: None,
        client_ip: String::new(),
    })
    .unwrap()
}
fn register_bytes(user: &str, password: &str) -> Vec<u8> {
    register_bytes_email(user, password, "")
}
fn register_bytes_email(user: &str, password: &str, email: &str) -> Vec<u8> {
    serde_json::to_vec(&RegisterRequest {
        user: user.into(),
        password: password.into(),
        invite: String::new(),
        email: email.into(),
        client_ip: String::new(),
    })
    .unwrap()
}
fn confirm_bytes(user: &str, code: &str) -> Vec<u8> {
    serde_json::to_vec(&EmailConfirmRequest { user: user.into(), code: code.into(), client_ip: String::new(), }).unwrap()
}

#[tokio::test]
async fn issue_does_not_create_user() {
    // Регрессия безопасности: логин несуществующего юзера НЕ создаёт аккаунт.
    let pool = test_pool().await;
    let (enc, _) = make_keys();
    let err = do_issue(&pool, &enc, &issue_bytes("ghost@local", "pw-secret-1")).await.unwrap_err();
    // Единая ошибка (анти-энумерация): не раскрываем, существует ли логин.
    assert!(err.to_string().contains("неверный логин или пароль"));
    let cnt: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE username = ?")
        .bind("ghost@local").fetch_one(&pool).await.unwrap();
    assert_eq!(cnt.0, 0, "аккаунт не должен быть создан логином");
}

#[tokio::test]
async fn register_then_login() {
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    // регистрация создаёт аккаунт
    do_register(&pool, &register_bytes("newbie@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
    // теперь логин проходит и выдаёт валидный JWT
    let token = do_issue(&pool, &enc, &issue_bytes("newbie@local", "pw-secret-1")).await.unwrap().token().unwrap().to_string();
    let user = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap().sub;
    assert_eq!(user, "newbie@local");
    // неверный пароль — отказ
    assert!(do_issue(&pool, &enc, &issue_bytes("newbie@local", "wrong")).await.is_err());
}

#[tokio::test]
async fn issue_indistinguishable_unknown_vs_wrong_password() {
    // Анти-энумерация: несуществующий юзер и неверный пароль — одна ошибка.
    let pool = test_pool().await;
    let (enc, _) = make_keys();
    do_register(&pool, &register_bytes("real@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
    let e_unknown = do_issue(&pool, &enc, &issue_bytes("nouser@local", "pw-secret-1"))
        .await
        .unwrap_err()
        .to_string();
    let e_wrong = do_issue(&pool, &enc, &issue_bytes("real@local", "bad"))
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(e_unknown, e_wrong, "ошибки должны быть неотличимы");
    assert!(e_unknown.contains("неверный логин или пароль"));
}

#[tokio::test]
async fn issue_locks_out_after_repeated_failures() {
    // После порога подряд идущих неудач логин временно блокируется даже с
    // верным паролем; PARVANE_LOGIN_LOCK_THRESHOLD берётся из env (по умолч. 5).
    let pool = test_pool().await;
    let (enc, _) = make_keys();
    do_register(&pool, &register_bytes("lock@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
    for _ in 0..5 {
        assert!(do_issue(&pool, &enc, &issue_bytes("lock@local", "bad")).await.is_err());
    }
    // теперь даже верный пароль отклонён (лок-аут активен)
    let err = do_issue(&pool, &enc, &issue_bytes("lock@local", "pw-secret-1"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("много"), "ожидался лок-аут: {err}");
}


// ── адреса: ник без домена, правила ников, чужой домен ──

#[test]
fn canonical_user_appends_domain_only_without_at() {
    assert_eq!(canonical_user("alice", "local"), "alice@local");
    assert_eq!(canonical_user("  alice  ", "example.org"), "alice@example.org");
    assert_eq!(canonical_user("bob@other", "local"), "bob@other");
}

#[test]
fn nick_rules() {
    for ok in ["ab", "alice", "a1", "1a", "rl_victim", "content-alice-1725000000000-123", "u.v"] {
        assert!(valid_nick(ok), "{ok} должен быть валидным");
    }
    for bad in ["", "a", "Alice", "al ice", "_alice", "-a", "тест", "a@b", &"x".repeat(65)] {
        assert!(!valid_nick(bad), "{bad:?} должен быть отклонён");
    }
}

#[test]
fn new_user_must_be_on_own_domain() {
    assert!(validate_new_user("alice@local", "local").is_ok());
    assert!(validate_new_user("alice@other", "local").is_err());
    assert!(validate_new_user("Alice@local", "local").is_err());
    assert!(validate_new_user("alice", "local").is_err());
}

#[tokio::test]
async fn register_and_issue_accept_bare_nick() {
    // Клиент шлёт голый ник — сервер сам дополняет до nick@PARVANE_DOMAIN
    // (в тестах домен по умолчанию — local).
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    do_register(&pool, &register_bytes("barenick", "pw-secret-1"), ConfirmMode::None).await.unwrap();
    let (stored,): (String,) = sqlx::query_as("SELECT username FROM users WHERE username = ?")
        .bind("barenick@local").fetch_one(&pool).await.unwrap();
    assert_eq!(stored, "barenick@local");
    let token = do_issue(&pool, &enc, &issue_bytes("barenick", "pw-secret-1")).await.unwrap().token().unwrap().to_string();
    let sub = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap().sub;
    assert_eq!(sub, "barenick@local");
    // и полный адрес по-прежнему работает
    assert!(do_issue(&pool, &enc, &issue_bytes("barenick@local", "pw-secret-1")).await.is_ok());
}

#[tokio::test]
async fn register_rejects_foreign_domain_and_bad_nick() {
    let pool = test_pool().await;
    let err = do_register(&pool, &register_bytes("alice@evil.example", "pw-secret-1"), ConfirmMode::None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("чужой домен"), "{err}");
    let err = do_register(&pool, &register_bytes("Alice", "pw-secret-1"), ConfirmMode::None).await.unwrap_err();
    assert!(err.to_string().contains("некорректный ник"), "{err}");
    let cnt: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(&pool).await.unwrap();
    assert_eq!(cnt.0, 0);
}

// ── подтверждение через Telegram-бота ──

fn tg_confirm_bytes(secret: &str, token: &str, telegram_id: i64) -> Vec<u8> {
    serde_json::to_vec(&TelegramConfirmRequest {
        secret: secret.into(),
        token: token.into(),
        telegram_id,
        telegram_name: "tester".into(), client_ip: String::new(), })
    .unwrap()
}

fn status_bytes(user: &str, token: &str) -> Vec<u8> {
    serde_json::to_vec(&RegisterStatusRequest { user: user.into(), token: token.into() }).unwrap()
}

#[tokio::test]
async fn telegram_flow_register_confirm_login() {
    let pool = test_pool().await;
    let (enc, _) = make_keys();
    let out = do_register(&pool, &register_bytes("tg", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
    assert!(out.confirm_required);
    let token = out.telegram_token.clone().expect("токен deep link");
    assert!(token.len() >= 20);
    // до Start в боте: не подтверждён, логин отклонён, статус false
    assert!(!do_register_status(&pool, &status_bytes("tg", &token)).await.unwrap());
    let err = do_issue(&pool, &enc, &issue_bytes("tg", "pw-secret-1")).await.unwrap_err();
    assert!(err.to_string().contains("не подтверждена"), "{err}");
    // чужой секрет / чужой токен — отказ
    assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("wrong", &token, 42), Some("s3cret")).await.is_err());
    assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", "nope", 42), Some("s3cret")).await.is_err());
    // без включённого режима — отказ даже с верным токеном
    assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &token, 42), None).await.is_err());
    // Start в боте подтверждает
    let (user, kind) = do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &token, 42), Some("s3cret")).await.unwrap();
    assert_eq!(user, "tg@local");
    assert_eq!(kind, "register");
    assert!(do_register_status(&pool, &status_bytes("tg", &token)).await.unwrap());
    // статус без верного токена — false (не зондируется)
    assert!(!do_register_status(&pool, &status_bytes("tg", "other")).await.unwrap());
    assert!(do_issue(&pool, &enc, &issue_bytes("tg", "pw-secret-1")).await.is_ok());
    // повторный Start тем же Telegram — идемпотентен
    assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &token, 42), Some("s3cret")).await.is_ok());
}

#[tokio::test]
async fn telegram_one_account_per_telegram_and_token_refresh() {
    let pool = test_pool().await;
    let out_a = do_register(&pool, &register_bytes("tga", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
    do_telegram_confirm(&pool, &tg_confirm_bytes("s", &out_a.telegram_token.unwrap(), 7), Some("s"))
        .await
        .unwrap();
    // второй аккаунт тем же Telegram — отказ
    let out_b = do_register(&pool, &register_bytes("tgb", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
    let token_b = out_b.telegram_token.unwrap();
    let err = do_telegram_confirm(&pool, &tg_confirm_bytes("s", &token_b, 7), Some("s")).await.unwrap_err();
    assert!(err.to_string().contains("уже привязан"), "{err}");
    // повторный register pending-аккаунта с тем же паролем — новый токен, старый гаснет
    let out_b2 = do_register(&pool, &register_bytes("tgb", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
    let token_b2 = out_b2.telegram_token.unwrap();
    assert_ne!(token_b, token_b2);
    assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s", &token_b, 8), Some("s")).await.is_err());
    assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s", &token_b2, 8), Some("s")).await.is_ok());
    // чужой пароль на pending — «логин занят»
    let err = do_register(&pool, &register_bytes("tgb", "other-secret-1"), ConfirmMode::Telegram).await.unwrap_err();
    assert!(err.to_string().contains("логин занят"), "{err}");
}

// ── регистрация через почту (PARVANE_EMAIL_REQUIRED) ──

#[tokio::test]
async fn email_flow_register_confirm_login() {
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    let out = do_register(
        &pool,
        &register_bytes_email("mail@local", "pw-secret-1", "user@example.com"),
        ConfirmMode::Email,
    )
    .await
    .unwrap();
    assert!(out.confirm_required);
    let (email, code) = out.send.unwrap();
    assert_eq!(email, "user@example.com");
    assert_eq!(code.len(), 6);

    // логин до подтверждения — отказ с различимой ошибкой
    let err = do_issue(&pool, &enc, &issue_bytes("mail@local", "pw-secret-1")).await.unwrap_err();
    assert!(err.to_string().contains("почта не подтверждена"));

    // неверный код — отказ
    let wrong = if code == "000000" { "000001" } else { "000000" };
    assert!(do_email_confirm(&pool, &confirm_bytes("mail@local", wrong)).await.is_err());

    // верный код подтверждает, повторно не работает (одноразовый)
    do_email_confirm(&pool, &confirm_bytes("mail@local", &code)).await.unwrap();
    assert!(do_email_confirm(&pool, &confirm_bytes("mail@local", &code)).await.is_err());

    let token = do_issue(&pool, &enc, &issue_bytes("mail@local", "pw-secret-1")).await.unwrap().token().unwrap().to_string();
    let user = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap().sub;
    assert_eq!(user, "mail@local");
}

#[tokio::test]
async fn email_flow_requires_valid_email() {
    let pool = test_pool().await;
    for bad in ["", "no-at", "a@b", "a @b.com", "@x.com"] {
        let err = do_register(
            &pool,
            &register_bytes_email(&format!("u{}@local", bad.len()), "pw-secret-1", bad),
            ConfirmMode::Email,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("email"), "'{bad}': {err}");
    }
}

#[tokio::test]
async fn email_flow_reregister_resends_and_fixes_email() {
    let pool = test_pool().await;
    let out1 = do_register(
        &pool,
        &register_bytes_email("re@local", "pw-secret-1", "typo@example.com"),
        ConfirmMode::Email,
    )
    .await
    .unwrap();
    let (_, code1) = out1.send.unwrap();
    // повтор с тем же паролем — новый код и исправленный email
    let out2 = do_register(
        &pool,
        &register_bytes_email("re@local", "pw-secret-1", "fixed@example.com"),
        ConfirmMode::Email,
    )
    .await
    .unwrap();
    assert!(out2.confirm_required);
    let (email2, code2) = out2.send.unwrap();
    assert_eq!(email2, "fixed@example.com");
    if code1 != code2 {
        assert!(
            do_email_confirm(&pool, &confirm_bytes("re@local", &code1)).await.is_err(),
            "старый код должен быть отозван"
        );
    }
    // пустой email при повторе — перевысылка на сохранённую почту
    let out3 = do_register(&pool, &register_bytes_email("re@local", "pw-secret-1", ""), ConfirmMode::Email)
        .await
        .unwrap();
    let (email3, code3) = out3.send.unwrap();
    assert_eq!(email3, "fixed@example.com");
    do_email_confirm(&pool, &confirm_bytes("re@local", &code3)).await.unwrap();
    // подтверждённый логин чужим register больше не перехватить
    let err = do_register(
        &pool,
        &register_bytes_email("re@local", "other-secret-1", "x@example.com"),
        ConfirmMode::Email,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("занят"));
}

#[tokio::test]
async fn email_flow_pending_login_protected_until_ttl() {
    let pool = test_pool().await;
    do_register(&pool, &register_bytes_email("pend@local", "pw-secret-1", "p@example.com"), ConfirmMode::Email)
        .await
        .unwrap();
    // чужой пароль на свежем pending — занят
    let err = do_register(
        &pool,
        &register_bytes_email("pend@local", "other-secret-1", "x@example.com"),
        ConfirmMode::Email,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("занят"));
    // просроченный pending освобождает логин
    sqlx::query("UPDATE users SET created_at = created_at - 200000 WHERE username = 'pend@local'")
        .execute(&pool)
        .await
        .unwrap();
    let out = do_register(
        &pool,
        &register_bytes_email("pend@local", "other-secret-1", "x@example.com"),
        ConfirmMode::Email,
    )
    .await
    .unwrap();
    assert!(out.confirm_required);
}

#[tokio::test]
async fn email_code_attempts_limited() {
    let pool = test_pool().await;
    let out = do_register(
        &pool,
        &register_bytes_email("brute@local", "pw-secret-1", "b@example.com"),
        ConfirmMode::Email,
    )
    .await
    .unwrap();
    let (_, code) = out.send.unwrap();
    let wrong = if code == "999999" { "999998" } else { "999999" };
    for _ in 0..CODE_MAX_ATTEMPTS {
        assert!(do_email_confirm(&pool, &confirm_bytes("brute@local", wrong)).await.is_err());
    }
    // лимит исчерпан — даже верный код отклонён
    let err = do_email_confirm(&pool, &confirm_bytes("brute@local", &code)).await.unwrap_err();
    assert!(err.to_string().contains("много попыток"));
}

#[tokio::test]
async fn register_without_email_flag_stays_verified() {
    // Флаг выключен (desktop и существующие e2e): аккаунт сразу активен.
    let pool = test_pool().await;
    let (enc, _) = make_keys();
    let out = do_register(&pool, &register_bytes("plain@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
    assert!(!out.confirm_required);
    assert!(out.send.is_none());
    do_issue(&pool, &enc, &issue_bytes("plain@local", "pw-secret-1")).await.unwrap();
}

#[tokio::test]
async fn register_rejects_duplicate() {
    let pool = test_pool().await;
    do_register(&pool, &register_bytes("dup@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
    let err = do_register(&pool, &register_bytes("dup@local", "other-secret-1"), ConfirmMode::None).await.unwrap_err();
    assert!(err.to_string().contains("занят"));
}

// ── E2E prekey-каталог (Фаза 2) ──






// ── мультидевайс: бандлы на устройство ──




// ── мультидевайс: листинг и отзыв устройств ──


#[tokio::test]
async fn revoked_device_token_fails_verify() {
    let pool = test_pool().await;
    assert!(!is_device_revoked(&pool, "bob@local", Some("dev-x")).await.unwrap());
    assert!(!is_device_revoked(&pool, "bob@local", None).await.unwrap());
    // Отзыв несуществующего бандла тоже оставляет тумбстоун
    let _ = revoke_device(&pool, "bob@local", "dev-x").await.unwrap();
    assert!(is_device_revoked(&pool, "bob@local", Some("dev-x")).await.unwrap());
    assert!(!is_device_revoked(&pool, "bob@local", Some("dev-y")).await.unwrap());
    assert!(!is_device_revoked(&pool, "alice@local", Some("dev-x")).await.unwrap());
}

#[test]
fn password_policy_enforces_length() {
    assert!(password_policy_ok("1").is_err(), "короткий пароль отклонён (P-43)");
    assert!(password_policy_ok("1234567").is_err());
    assert!(password_policy_ok("12345678").is_ok());
    assert!(password_policy_ok(&"x".repeat(1025)).is_err(), "слишком длинный отклонён");
}

#[tokio::test]
async fn require_password_checks_current_hash() {
    let pool = test_pool().await;
    let hash = hash_password("correct-horse").unwrap();
    sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, 0)")
        .bind("pw@local").bind("pw@local").bind(&hash).execute(&pool).await.unwrap();
    assert!(require_password(&pool, "pw@local", Some("correct-horse")).await.is_ok());
    assert!(require_password(&pool, "pw@local", Some("wrong")).await.is_err());
    assert!(require_password(&pool, "pw@local", None).await.is_err(), "без пароля — отказ (P-07)");
    assert!(require_password(&pool, "pw@local", Some("")).await.is_err());
    assert!(require_password(&pool, "ghost@local", Some("x")).await.is_err(), "нет юзера — отказ без утечки");
}

#[tokio::test]
async fn password_change_requires_old_password_and_resets_trust() {
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    let hash = hash_password("old-password-1").unwrap();
    sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, 0)")
        .bind("chg@local").bind("chg@local").bind(&hash).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO trusted_devices (username, device_id, confirmed_at, secret_hash) VALUES (?, ?, 0, ?)")
        .bind("chg@local").bind("dev-1").bind("h").execute(&pool).await.unwrap();
    let now = now_unix() as usize;
    let claims = Claims { sub: "chg@local".into(), iat: now, exp: now + 3600, dev: Some("dev-1".into()) };
    let token = jwt_encode(&enc, &claims).unwrap();
    let body = |old: &str, new: &str| serde_json::to_vec(&PasswordChangeRequest {
        token: token.clone(), old_password: old.into(), new_password: new.into(),
    }).unwrap();
    // Неверный старый пароль — отказ; слабый новый — отказ.
    assert!(do_password_change(&pool, &dec, &body("nope", "new-password-9")).await.is_err());
    assert!(do_password_change(&pool, &dec, &body("old-password-1", "short")).await.is_err());
    // Верная смена: новый хэш действует, доверие 2FA сброшено.
    do_password_change(&pool, &dec, &body("old-password-1", "new-password-9")).await.unwrap();
    assert!(require_password(&pool, "chg@local", Some("new-password-9")).await.is_ok());
    assert!(require_password(&pool, "chg@local", Some("old-password-1")).await.is_err());
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM trusted_devices WHERE username = ?")
        .bind("chg@local").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0, "смена пароля сбрасывает доверенные устройства");
}


#[tokio::test]
async fn verify_active_rejects_revoked_and_binds_device() {
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    let now = now_unix() as usize;
    let tok = |dev: Option<&str>| {
        let claims = Claims {
            sub: "bob@local".into(),
            iat: now,
            exp: now + 3600,
            dev: dev.map(str::to_string),
        };
        jwt_encode(&enc, &claims).unwrap()
    };

    // Активный токен устройства dev-1 проходит и привязан к своему device_id.
    let t1 = tok(Some("dev-1"));
    assert_eq!(verify_active_user(&pool, &dec, &t1).await.unwrap(), "bob@local");
    assert!(verify_active_device(&pool, &dec, &t1, "dev-1").await.is_ok());
    // P-06: тем же токеном нельзя писать за ЧУЖОЕ устройство.
    assert!(verify_active_device(&pool, &dec, &t1, "dev-2").await.is_err());
    // Токен без dev — только для пустого device_id.
    let t0 = tok(None);
    assert!(verify_active_device(&pool, &dec, &t0, "").await.is_ok());
    assert!(verify_active_device(&pool, &dec, &t0, "dev-1").await.is_err());
    // После отзыва dev-1 любой его токен отклоняется во всех обработчиках.
    let _ = revoke_device(&pool, "bob@local", "dev-1").await.unwrap();
    assert!(verify_active_user(&pool, &dec, &t1).await.is_err());
    assert!(verify_active_device(&pool, &dec, &t1, "dev-1").await.is_err());
}



// ── линковка: офферы и одноразовые гранты ──

#[tokio::test]
async fn link_offer_poll_grant_roundtrip() {
    let pool = test_pool().await;
    insert_user(&pool, "alice@local").await;

    // Новое устройство публикует оффер; старое видит его в poll
    store_link_offer(&pool, "alice@local", "dev-new", "EPH-NEW==", "", "", false).await.unwrap();
    let (offers, grant, _) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0].device_id, "dev-new");
    assert_eq!(offers[0].eph_pub, "EPH-NEW==");
    assert!(grant.is_none());
    // Своего оффера устройство в poll не видит
    let (own_offers, _, _) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
    assert!(own_offers.is_empty());

    // Старое выдаёт грант — оффер гасится, целевое устройство получает
    // грант РОВНО один раз
    store_link_grant(&pool, "alice@local", "dev-new", "BOX==", "EPH-OLD==").await.unwrap();
    let (offers_after, _, _) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
    assert!(offers_after.is_empty(), "оффер погашен грантом");
    let (_, g1, _) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
    let g1 = g1.expect("грант выдан");
    assert_eq!(g1.box_payload, "BOX==");
    assert_eq!(g1.eph_pub, "EPH-OLD==");
    let (_, g2, _) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
    assert!(g2.is_none(), "грант одноразовый");
}

#[tokio::test]
async fn link_grant_requires_live_offer_and_reoffer_voids_grant() {
    let pool = test_pool().await;
    insert_user(&pool, "bob@local").await;

    // Грант без оффера — отказ
    let err = store_link_grant(&pool, "bob@local", "dev-x", "BOX==", "EPH==")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("оффер"));

    // Повторный оффер заменяет прежний и гасит уже выданный грант
    // (он зашифрован на потерянный эфемерный ключ)
    store_link_offer(&pool, "bob@local", "dev-x", "EPH-1==", "", "", false).await.unwrap();
    store_link_grant(&pool, "bob@local", "dev-x", "BOX-1==", "EPH-OLD==").await.unwrap();
    store_link_offer(&pool, "bob@local", "dev-x", "EPH-2==", "", "", false).await.unwrap();
    let (_, grant, _) = poll_link(&pool, "bob@local", "dev-x").await.unwrap();
    assert!(grant.is_none(), "грант под старый эфемерный ключ погашен");
}

#[tokio::test]
async fn link_v2_commitment_challenge_reveal() {
    let pool = test_pool().await;
    insert_user(&pool, "dave@local").await;
    let n_pub_raw = [7u8; 65];
    let n_pub = B64.encode(n_pub_raw);
    let commitment = B64.encode(Sha256::digest(n_pub_raw));
    // 1. Новое устройство публикует ТОЛЬКО обязательство (ключ скрыт).
    store_link_offer(&pool, "dave@local", "dev-new", "", &commitment, "SIGN-NEW==", false).await.unwrap();
    let (offers, _, _) = poll_link(&pool, "dave@local", "dev-old").await.unwrap();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0].eph_pub, "", "ключ не раскрыт до challenge");
    assert_eq!(offers[0].commitment, commitment);
    assert_eq!(offers[0].signing_key, "SIGN-NEW==");
    // Новое устройство ещё не видит challenge.
    let (_, _, ch) = poll_link(&pool, "dave@local", "dev-new").await.unwrap();
    assert!(ch.is_none());
    // 2. Старое прикладывает свой эфемерный ключ; второй challenge другим
    //    ключом (подмена стороны) — отказ.
    store_link_challenge(&pool, "dave@local", "dev-new", "O-PUB==").await.unwrap();
    assert!(store_link_challenge(&pool, "dave@local", "dev-new", "MALLORY==").await.is_err());
    assert!(store_link_challenge(&pool, "dave@local", "dev-new", "O-PUB==").await.is_ok(), "повтор того же — идемпотентен");
    let (_, _, ch) = poll_link(&pool, "dave@local", "dev-new").await.unwrap();
    assert_eq!(ch.as_deref(), Some("O-PUB=="));
    // 3. Раскрытие: ключ, не соответствующий обязательству, — отказ.
    let wrong = B64.encode([8u8; 65]);
    assert!(store_link_offer(&pool, "dave@local", "dev-new", &wrong, &commitment, "", false).await.is_err());
    store_link_offer(&pool, "dave@local", "dev-new", &n_pub, &commitment, "", false).await.unwrap();
    let (offers, _, _) = poll_link(&pool, "dave@local", "dev-old").await.unwrap();
    assert_eq!(offers[0].eph_pub, n_pub, "ключ раскрыт");
    assert_eq!(offers[0].challenge_pub, "O-PUB==", "challenge сохранён при раскрытии");
    assert_eq!(offers[0].signing_key, "SIGN-NEW==", "signing_key не затёрт пустым");
    // 4. Грант как раньше — одноразовый.
    store_link_grant(&pool, "dave@local", "dev-new", "BOX==", "O-PUB==").await.unwrap();
    let (_, g, _) = poll_link(&pool, "dave@local", "dev-new").await.unwrap();
    assert!(g.is_some());
    // 5. Отзыв явным флагом.
    store_link_offer(&pool, "dave@local", "dev-new", "", "", "", true).await.unwrap();
    let (offers, _, _) = poll_link(&pool, "dave@local", "dev-old").await.unwrap();
    assert!(offers.is_empty());
}

#[tokio::test]
async fn link_offer_retraction_clears_offer_and_grant() {
    let pool = test_pool().await;
    insert_user(&pool, "carol@local").await;
    store_link_offer(&pool, "carol@local", "dev-n", "EPH==", "", "", false).await.unwrap();
    // Отзыв (пустой eph) гасит оффер
    store_link_offer(&pool, "carol@local", "dev-n", "", "", "", false).await.unwrap();
    let (offers, _, _) = poll_link(&pool, "carol@local", "dev-other").await.unwrap();
    assert!(offers.is_empty(), "отозванный оффер не виден");

    // Отзыв гасит и уже выданный грант
    store_link_offer(&pool, "carol@local", "dev-n", "EPH-2==", "", "", false).await.unwrap();
    store_link_grant(&pool, "carol@local", "dev-n", "BOX==", "EPH-O==").await.unwrap();
    store_link_offer(&pool, "carol@local", "dev-n", "", "", "", false).await.unwrap();
    let (_, grant, _) = poll_link(&pool, "carol@local", "dev-n").await.unwrap();
    assert!(grant.is_none(), "отзыв гасит невостребованный грант");
}

#[tokio::test]
async fn link_is_scoped_per_user_and_expires() {
    let pool = test_pool().await;
    insert_user(&pool, "alice@local").await;
    insert_user(&pool, "eve@local").await;

    store_link_offer(&pool, "alice@local", "dev-new", "EPH==", "", "", false).await.unwrap();
    // Чужой аккаунт офферов не видит и грант выдать не может
    let (offers, _, _) = poll_link(&pool, "eve@local", "dev-eve").await.unwrap();
    assert!(offers.is_empty());
    assert!(store_link_grant(&pool, "eve@local", "dev-new", "BOX==", "EPH==").await.is_err());

    // Просроченный оффер исчезает
    sqlx::query("UPDATE link_offers SET created_at = created_at - 100000")
        .execute(&pool)
        .await
        .unwrap();
    let (stale, _, _) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
    assert!(stale.is_empty(), "просроченный оффер вычищен");
}



// P-37: длинные ключи лимитеров сворачиваются в хэш, выселение работает
#[test]
fn limiter_keys_are_bounded_and_buckets_evicted() {
    let long = "x".repeat(10_000);
    let k = limiter_key(&long);
    assert!(k.len() < 80 && k.starts_with("h:"));
    assert_eq!(limiter_key("short"), "short");
    let mut map: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
    for i in 0..LIMITER_MAX_ENTRIES + 10 {
        map.insert(format!("k{i}"), vec![0]);
    }
    evict_stale_buckets(&mut map, 1_000_000);
    assert!(map.is_empty(), "устаревшие корзины выселены");
    // Уникальные длинные логины не растят карту на их размер
    for i in 0..5 {
        assert!(window_rate_ok("p37", &format!("{}{}", "y".repeat(5_000), i), 3));
    }
}

// P-21: повторный фетч той же парой в окне отдаёт ту же one-time

// P-21 + одноразовость: one-time, выданную одному Olm-аккаунту запросившего,
// другой его аккаунт (второе устройство или то же после смены ключей) в окне
// не получает — цель могла её уже израсходовать, и первое сообщение нового
// аккаунта не расшифровалось бы. Свежая при этом тоже не сжигается.

// P-19: LIKE-экранирование и минимальная длина запроса
#[test]
fn like_escape_neutralizes_wildcards() {
    assert_eq!(like_escape("a%b_c\\d"), "a\\%b\\_c\\\\d");
    assert_eq!(like_escape("plain"), "plain");
    assert!(SEARCH_MIN_CHARS >= 2);
}

// P-19: телефон — только владельцу, публичная карточка без PII
#[test]
fn public_card_has_no_pii() {
    let card = public_card("u@local", "U", "a".into(), "k".into(), 3, "".into());
    assert!(card.phone.is_none() && card.bio.is_none() && card.birthday.is_none());
    assert_eq!(card.username, "u@local");
    assert_eq!(card.avatar.as_deref(), Some("a"));
}

// P-14: секрет доверия ротируется при каждом доверенном входе; старый
// после этого не принимается (вход снова требует Telegram)
#[tokio::test]
async fn trust_secret_rotates_on_each_trusted_login() {
    let pool = test_pool().await;
    let (enc, _dec) = make_keys();
    do_register(&pool, &register_bytes("rot", "pw-secret-1"), ConfirmMode::None).await.unwrap();
    let user = format!("rot@{}", server_domain());
    sqlx::query("UPDATE users SET tg_2fa = 1, telegram_id = 42 WHERE username = ?").bind(&user).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO trusted_devices (username, device_id, confirmed_at, secret_hash) VALUES (?, 'dev-1', 1, ?)")
        .bind(&user).bind(trust_secret_hash("s1")).execute(&pool).await.unwrap();
    let out = do_issue(&pool, &enc, &issue_bytes_with_device_secret("rot", "pw-secret-1", "dev-1", "s1")).await.unwrap();
    let s2 = out.trust_secret().expect("доверенный вход выдаёт новый секрет").to_string();
    assert!(out.token().is_some() && s2 != "s1");
    let (hash,): (String,) = sqlx::query_as("SELECT secret_hash FROM trusted_devices WHERE username = ? AND device_id = 'dev-1'")
        .bind(&user).fetch_one(&pool).await.unwrap();
    assert_eq!(hash, trust_secret_hash(&s2));
    // Старый секрет больше не доверен → второй фактор
    let again = do_issue(&pool, &enc, &issue_bytes_with_device_secret("rot", "pw-secret-1", "dev-1", "s1")).await.unwrap();
    assert!(again.token().is_none(), "старый секрет не должен давать вход");
    // Новый — работает и ротируется дальше
    let out3 = do_issue(&pool, &enc, &issue_bytes_with_device_secret("rot", "pw-secret-1", "dev-1", &s2)).await.unwrap();
    assert!(out3.token().is_some() && out3.trust_secret().is_some_and(|s| s != s2));
}

fn issue_bytes_with_login_token(user: &str, password: &str, login_token: &str) -> Vec<u8> {
    serde_json::to_vec(&IssueRequest {
        user: user.into(),
        password: password.into(),
        device_id: Some("dev-1".into()),
        login_token: Some(login_token.into()), trust_secret: None, client: None,
        client_ip: String::new(),
    })
    .unwrap()
}

fn twofa_bytes(token: &str, enabled: Option<bool>) -> Vec<u8> {
    serde_json::to_vec(&TwoFactorRequest { token: token.into(), enabled, password: None, }).unwrap()
}

fn twofa_bytes_pw(token: &str, enabled: Option<bool>, password: &str) -> Vec<u8> {
    serde_json::to_vec(&TwoFactorRequest { token: token.into(), enabled, password: Some(password.into()) }).unwrap()
}

#[tokio::test]
async fn twofa_login_requires_linked_telegram_confirmation() {
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    // Регистрация с подтверждением в Telegram (привязка tg 42)
    let out = do_register(&pool, &register_bytes("two", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
    let reg_token = out.telegram_token.unwrap();
    do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &reg_token, 42), Some("s3cret")).await.unwrap();
    let jwt = do_issue(&pool, &enc, &issue_bytes("two", "pw-secret-1")).await.unwrap().token().unwrap().to_string();

    // По умолчанию выключено; включение — с паролем (ID-05)
    assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes(&jwt, None)).await.unwrap(); (e, l) }, (false, true));
    assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes_pw(&jwt, Some(true), "pw-secret-1")).await.unwrap(); (e, l) }, (true, true));
    // Устройство, включившее 2FA (JWT с dev), — доверенное: входит без Telegram
    let dev_jwt = do_issue(&pool, &enc, &issue_bytes_with_device("two", "pw-secret-1", "dev-enabler")).await;
    assert!(dev_jwt.is_ok(), "пока 2FA включено JWT без dev-устройства: {:?}", dev_jwt.as_ref().err());
    // P-07: выключить 2FA одним JWT нельзя — нужен пароль (и верный).
    assert!(do_twofa(&pool, &dec, &twofa_bytes(&jwt, Some(false))).await.is_err(), "без пароля 2FA не выключается");
    assert!(do_twofa(&pool, &dec, &twofa_bytes_pw(&jwt, Some(false), "wrong-pass-1")).await.is_err(), "с неверным паролем — отказ");
    assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes_pw(&jwt, Some(false), "pw-secret-1")).await.unwrap(); (e, l) }, (false, true));
    let dev_jwt = do_issue(&pool, &enc, &issue_bytes_with_device("two", "pw-secret-1", "dev-enabler")).await.unwrap().token().unwrap().to_string();
    let (e, l, secret) = do_twofa(&pool, &dec, &twofa_bytes_pw(&dev_jwt, Some(true), "pw-secret-1")).await.unwrap();
    assert_eq!((e, l), (true, true));
    let secret = secret.expect("устройство, включившее 2FA, получает секрет доверия");
    // device_id публичен (identity.prekeys.fetch отдаёт его любому): без
    // секрета доверия НЕТ — иначе второй фактор обходился при известном пароле
    assert!(do_issue(&pool, &enc, &issue_bytes_with_device("two", "pw-secret-1", "dev-enabler")).await.unwrap().token().is_none(),
        "голый device_id больше не доверенный");
    assert!(do_issue(&pool, &enc, &issue_bytes_with_device_secret("two", "pw-secret-1", "dev-enabler", &secret)).await.unwrap().token().is_some(),
        "устройство, включившее 2FA, входит с секретом без Telegram");
    assert!(do_issue(&pool, &enc, &issue_bytes_with_device("two", "pw-secret-1", "dev-other")).await.unwrap().token().is_none(),
        "другое устройство подтверждает вход");
    assert!(do_twofa(&pool, &dec, &twofa_bytes("bad.jwt", Some(false))).await.is_err());

    // Логин: пароль верен → не JWT, а токен входа
    let outcome = do_issue(&pool, &enc, &issue_bytes("two", "pw-secret-1")).await.unwrap();
    let IssueOutcome::TwoFactor { login_token } = outcome else { panic!("ожидался двухфакторный вход") };
    assert!(!do_register_status(&pool, &status_bytes("two", &login_token)).await.unwrap());
    // Неподтверждённый токен JWT не даёт (выдаётся новый токен)
    let again = do_issue(&pool, &enc, &issue_bytes_with_login_token("two", "pw-secret-1", &login_token)).await.unwrap();
    let IssueOutcome::TwoFactor { login_token: login_token2 } = again else { panic!("токен без подтверждения") };
    assert!(!do_register_status(&pool, &status_bytes("two", &login_token)).await.unwrap(), "старый токен погашен");
    // Чужой Telegram — отказ; неверный пароль по-прежнему отказ
    let wrong = do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &login_token2, 43), Some("s3cret")).await;
    assert!(wrong.unwrap_err().to_string().contains("привязанный"));
    assert!(do_issue(&pool, &enc, &issue_bytes("two", "nope")).await.is_err());
    // Привязанный Telegram подтверждает → статус true → JWT с login_token
    let (user, kind) = do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &login_token2, 42), Some("s3cret")).await.unwrap();
    assert_eq!((user.as_str(), kind), ("two@local", "login"));
    assert!(do_register_status(&pool, &status_bytes("two", &login_token2)).await.unwrap());
    let jwt2 = do_issue(&pool, &enc, &issue_bytes_with_login_token("two", "pw-secret-1", &login_token2)).await.unwrap();
    assert!(jwt2.token().is_some());
    let secret2 = jwt2.trust_secret().expect("после подтверждения в Telegram выдан секрет доверия").to_string();
    // dev-1 доверенное: по паролю + секрету без Telegram; без секрета — подтверждение
    assert!(do_issue(&pool, &enc, &issue_bytes_with_login_token("two", "pw-secret-1", "")).await.unwrap().token().is_none(),
        "dev-1 без секрета — снова подтверждение");
    assert!(do_issue(&pool, &enc, &issue_bytes_with_device_secret("two", "pw-secret-1", "dev-1", &secret2)).await.unwrap().token().is_some());
    // Другое устройство — снова подтверждение (токен одноразовый и погашен)
    assert!(do_issue(&pool, &enc, &issue_bytes("two", "pw-secret-1")).await.unwrap().token().is_none());
    // Отзыв устройства снимает доверие
    revoke_device(&pool, "two@local", "dev-1").await.unwrap();
    assert!(do_issue(&pool, &enc, &issue_bytes_with_device_secret("two", "pw-secret-1", "dev-1", &secret2)).await.unwrap().token().is_none(),
        "отзыв снимает доверие даже с секретом");
    // Выключение (с паролем, P-07) — обычный логин без Telegram
    assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes_pw(&jwt, Some(false), "pw-secret-1")).await.unwrap(); (e, l) }, (false, true));
    assert!(do_issue(&pool, &enc, &issue_bytes("two", "pw-secret-1")).await.unwrap().token().is_some());
}

#[tokio::test]
async fn twofa_cannot_be_enabled_without_telegram() {
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    do_register(&pool, &register_bytes("plain", "pw-secret-1"), ConfirmMode::None).await.unwrap();
    let jwt = do_issue(&pool, &enc, &issue_bytes("plain", "pw-secret-1")).await.unwrap().token().unwrap().to_string();
    let err = do_twofa(&pool, &dec, &twofa_bytes(&jwt, Some(true))).await.unwrap_err();
    assert!(err.to_string().contains("привяжите Telegram"), "{err}");
    assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes(&jwt, None)).await.unwrap(); (e, l) }, (false, false));
}

// ── протокол v2: ключ и описатель сервера (T036) ─────────────────────────────

#[test]
fn v2_server_descriptor_is_signed_and_key_file_private() {
    use parvane_protocol::pb::parvane::core::v2::ServerDescriptor;
    use prost::Message;
    let dir = std::env::temp_dir().join(format!("pv-srvkey-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("identity.db");
    let key = crate::server_key::load_or_create_server_key(db.to_str().unwrap()).unwrap();
    let again = crate::server_key::load_or_create_server_key(db.to_str().unwrap()).unwrap();
    assert_eq!(key.to_bytes(), again.to_bytes(), "ключ переживает перезапуск");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("identity-server-ed25519.pem")).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "файл ключа сервера 0600");
    }
    let signed = crate::server_key::signed_descriptor(&key);
    let d = ServerDescriptor::decode(signed.descriptor.as_slice()).unwrap();
    parvane_protocol::sign::verify_ctx(&d.server_key, &signed.signature, parvane_protocol::sign::ctx::SERVER_DESCRIPTOR, &[&signed.descriptor]).unwrap();
    assert_eq!(d.proto_major, 2);
    std::fs::remove_dir_all(&dir).ok();
}

// ── ревью безопасности 7 окт 2026: ID-02, ID-05, ID-06 ───────────────────────

#[test]
fn login_limiter_does_not_grow_on_unique_logins() {
    // ID-02: уникальные логины не должны накапливаться в карте навсегда.
    for i in 0..LIMITER_MAX_ENTRIES + 100 {
        let _ = login_gate_check(&format!("id02-{i}@local"));
    }
    let n = login_limiter().lock().unwrap_or_else(|e| e.into_inner()).len();
    assert!(n < LIMITER_MAX_ENTRIES, "карта лимитера выселяется: {n}");
}

#[tokio::test]
async fn issue_rejects_overlong_login_before_any_accounting() {
    let pool = test_pool().await;
    let (enc, _) = make_keys();
    let long = format!("{}@local", "a".repeat(4000));
    let err = do_issue(&pool, &enc, &issue_bytes(&long, "whatever-1")).await.unwrap_err().to_string();
    assert!(err.contains("неверный логин или пароль"), "{err}");
    let key = limiter_key(&canonical_user(&long, &server_domain()));
    assert!(!login_limiter().lock().unwrap_or_else(|e| e.into_inner()).contains_key(&key), "следа в лимитере нет");
    // Негодный device_id в v1 тоже отклоняется до БД
    let err = do_issue(&pool, &enc, &issue_bytes_with_device("x@local", "whatever-1", "dev id/with spaces"))
        .await.unwrap_err().to_string();
    assert!(err.contains("неверный логин или пароль"), "{err}");
}

#[tokio::test]
async fn require_password_locks_out_after_repeated_failures() {
    // ID-05: перебор пароля через операции с JWT упирается в тот же лок-аут, что и вход.
    let pool = test_pool().await;
    let hash = hash_password("right-password-1").unwrap();
    sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, 0)")
        .bind("lockpw@local").bind("lockpw@local").bind(&hash).execute(&pool).await.unwrap();
    for _ in 0..5 {
        assert!(require_password(&pool, "lockpw@local", Some("wrong-0000")).await.is_err());
    }
    let err = require_password(&pool, "lockpw@local", Some("right-password-1")).await.unwrap_err().to_string();
    assert!(err.contains("много"), "ожидался лок-аут: {err}");
}

#[tokio::test]
async fn password_change_invalidates_tokens_of_other_devices() {
    // ID-06: после смены пароля чужие сессии гаснут, устройство владельца — нет.
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    let hash = hash_password("old-password-1").unwrap();
    sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, 0)")
        .bind("epoch@local").bind("epoch@local").bind(&hash).execute(&pool).await.unwrap();
    let before = now_unix() as usize - 10;
    let mk = |dev: Option<&str>, iat: usize| {
        jwt_encode(&enc, &Claims { sub: "epoch@local".into(), iat, exp: iat + 86400, dev: dev.map(Into::into) }).unwrap()
    };
    let owner = mk(Some("dev-owner"), before);
    let thief = mk(Some("dev-thief"), before);
    let no_dev = mk(None, before);
    let body = serde_json::to_vec(&PasswordChangeRequest {
        token: owner.clone(), old_password: "old-password-1".into(), new_password: "new-password-9".into(),
    }).unwrap();
    do_password_change(&pool, &dec, &body).await.unwrap();
    assert!(verify_active(&pool, &dec, &owner).await.is_ok(), "сменившее устройство остаётся в сессии");
    assert!(verify_active(&pool, &dec, &thief).await.is_err(), "чужой токен до смены пароля гаснет");
    assert!(verify_active(&pool, &dec, &no_dev).await.is_err(), "токен без устройства гаснет");
    let fresh = mk(Some("dev-thief"), now_unix() as usize);
    assert!(verify_active(&pool, &dec, &fresh).await.is_ok(), "новый вход после смены действует");
    // То же видит identity.token.verify (шарды и gateway)
    let claims = jwt_decode(&dec, &thief).unwrap().claims;
    assert!(token_rejection(&pool, &claims).await.unwrap().is_some());
}

#[tokio::test]
async fn twofa_toggle_requires_password_in_both_directions() {
    let pool = test_pool().await;
    let (enc, dec) = make_keys();
    let hash = hash_password("pass-word-1").unwrap();
    sqlx::query("INSERT INTO users (id, username, password_hash, created_at, telegram_id) VALUES (?, ?, ?, 0, 4242)")
        .bind("tfa@local").bind("tfa@local").bind(&hash).execute(&pool).await.unwrap();
    let now = now_unix() as usize;
    let token = jwt_encode(&enc, &Claims { sub: "tfa@local".into(), iat: now, exp: now + 3600, dev: Some("dev-1".into()) }).unwrap();
    let body = |enabled: Option<bool>, password: Option<&str>| serde_json::to_vec(&TwoFactorRequest {
        token: token.clone(), enabled, password: password.map(Into::into),
    }).unwrap();
    // Чтение — по одному JWT
    assert_eq!(do_twofa(&pool, &dec, &body(None, None)).await.unwrap().0, false);
    // Включение без пароля — отказ; с паролем — секрет доверия
    assert!(do_twofa(&pool, &dec, &body(Some(true), None)).await.is_err());
    let (on, _, secret) = do_twofa(&pool, &dec, &body(Some(true), Some("pass-word-1"))).await.unwrap();
    assert!(on && secret.is_some());
    // Выключение — тоже только с паролем
    assert!(do_twofa(&pool, &dec, &body(Some(false), Some("nope-nope-1"))).await.is_err());
    assert!(!do_twofa(&pool, &dec, &body(Some(false), Some("pass-word-1"))).await.unwrap().0);
}

#[test]
fn session_proof_freshness_window() {
    // ID-01: доказательство устройства действует ±5 минут; нулевое время — нет
    let now = 1_760_000_000_000;
    use crate::v2::session_proof_fresh;
    assert!(session_proof_fresh(now, now));
    assert!(session_proof_fresh(now - 4 * 60 * 1000, now));
    assert!(!session_proof_fresh(now - 6 * 60 * 1000, now));
    assert!(!session_proof_fresh(now + 6 * 60 * 1000, now));
    assert!(!session_proof_fresh(0, now));
}
