//! Тесты шарда (вынесены из main.rs, п. 4.7).

use crate::*;

#[test]
fn client_ip_trusts_forwarded_only_from_proxy() {
    let proxy = Some("172.18.0.2".parse::<IpAddr>().unwrap());
    let public = Some("203.0.113.7".parse::<IpAddr>().unwrap());
    assert_eq!(client_ip_from(proxy, Some("198.51.100.9, 10.0.0.1")), "198.51.100.9");
    assert_eq!(client_ip_from(proxy, Some("garbage")), "172.18.0.2");
    assert_eq!(client_ip_from(public, Some("198.51.100.9")), "203.0.113.7", "XFF от публичного пира — подделка");
    assert_eq!(client_ip_from(None, Some("198.51.100.9")), "");
}

#[test]
fn timeouts_are_clamped_and_sub_cap_is_sane() {
    assert_eq!(clamp_timeout(0), 100);
    assert_eq!(clamp_timeout(3000), 3000);
    assert_eq!(clamp_timeout(u64::MAX), MAX_TIMEOUT_MS);
    assert!(MAX_SUBS_PER_SESSION >= 16 && MAX_SUBS_PER_SESSION <= 256);
}

#[test]
fn inject_client_ip_overrides_client_field() {
    let out = inject_client_ip(r#"{"user":"a","client_ip":"1.1.1.1"}"#, "9.9.9.9");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["client_ip"], "9.9.9.9");
    assert_eq!(v["user"], "a");
    assert_eq!(inject_client_ip("not json", "9.9.9.9"), "not json");
    assert_eq!(inject_client_ip(r#"{"user":"a"}"#, ""), r#"{"user":"a"}"#);
}

#[test]
fn token_bucket_bursts_then_refills() {
    let mut bucket = TokenBucket::new(3.0, 1.0);
    let t0 = Instant::now();
    assert!(bucket.try_take_at(t0));
    assert!(bucket.try_take_at(t0));
    assert!(bucket.try_take_at(t0));
    assert!(!bucket.try_take_at(t0), "всплеск исчерпан");
    assert!(!bucket.try_take_at(t0 + Duration::from_millis(500)));
    assert!(bucket.try_take_at(t0 + Duration::from_millis(1100)), "через секунду — один токен");
    assert!(!bucket.try_take_at(t0 + Duration::from_millis(1100)));
    // Долгая пауза не копит больше capacity
    assert!(bucket.try_take_at(t0 + Duration::from_secs(60)));
    assert!(bucket.try_take_at(t0 + Duration::from_secs(60)));
    assert!(bucket.try_take_at(t0 + Duration::from_secs(60)));
    assert!(!bucket.try_take_at(t0 + Duration::from_secs(60)));
}

#[test]
fn session_rate_classifies_subjects() {
    let mut rate = SessionRate {
        messages: TokenBucket::new(1.0, 0.0),
        uploads: TokenBucket::new(1.0, 0.0),
        requests: TokenBucket::new(1.0, 0.0),
    };
    assert!(rate.allow("msg.chat.send"));
    assert!(!rate.allow("msg.chat.edit"), "сообщения делят одну корзину");
    assert!(rate.allow("file.upload.chunk"));
    assert!(!rate.allow("file.upload.complete"));
    assert!(rate.allow("identity.user.search"));
    assert!(!rate.allow("group.list"));
}

#[test]
fn sub_allows_only_own_inboxes() {
    let web_id = web_user_id("alice@local");
    let desktop_id = desktop_user_id("alice@local");
    assert_eq!(web_id, "1050889428");
    assert_eq!(desktop_id, "84775232636990");
    assert!(allowed_sub("alice@local", "msg.user.alice@local"));
    assert!(allowed_sub("alice@local", "call.user.alice@local"));
    assert!(allowed_sub("alice@local", &format!("msg.typing.{web_id}")));
    assert!(allowed_sub(
        "alice@local",
        &format!("msg.typing.{desktop_id}")
    ));
    // P-18: wildcard presence запрещён, конкретный presence.<id> — можно
    assert!(!allowed_sub("alice@local", "presence.*"));
    assert!(allowed_sub("alice@local", "presence.123"));
    assert!(allowed_sub("alice@local", &format!("presence.{}", web_user_id("bob@local"))));
}

#[test]
fn sub_rejects_mallory_wildcards_and_private_inboxes() {
    for subject in [
        ">",
        "*",
        "_INBOX.>",
        "_INBOX.abc123",
        "msg.user.>",
        "msg.user.*",
        "msg.user.bob@local",
        "call.user.*",
        "call.user.bob@local",
        "msg.>",
        "msg.sync.response",
        "msg.typing.*",
        "msg.typing.>",
        "presence.>",
    ] {
        assert!(!allowed_sub("alice@local", subject), "allowed {subject}");
    }
    // Групповой typing: подписка на КОНКРЕТНЫЙ msg.typing.<id> теперь
    // разрешена всем (эфемерный индикатор набора; см. allowed_sub) —
    // включая чужой 1-на-1 id и групповой "-<digits>". Раньше блокировалось.
    let bob_web_id = web_user_id("bob@local");
    // P-18: чужой 1-на-1 typing раскрывал бы, кто пишет жертве — запрещён;
    // групповой typing статически не разрешается (только по членству)
    assert!(!allowed_sub("alice@local", &format!("msg.typing.{bob_web_id}")));
    assert!(!allowed_sub("alice@local", "msg.typing.-123456"));
}

#[test]
fn group_typing_ids_match_both_client_schemes() {
    let ids = group_typing_ids("grp-1");
    assert_eq!(ids[0], format!("-{}", web_user_id("group:grp-1")));
    assert_eq!(ids[1], desktop_user_id("grp-1"));
    assert!(ids[0].starts_with('-'));
    assert!(ids[1].bytes().all(|b| b.is_ascii_digit()));
    // presence: только конкретный числовой id
    assert!(is_concrete_presence_subject("presence.42"));
    assert!(!is_concrete_presence_subject("presence."));
    assert!(!is_concrete_presence_subject("presence.*"));
    assert!(!is_concrete_presence_subject("presence.4x"));
}

#[test]
fn pub_allows_send_denies_arbitrary() {
    assert!(allowed_pub("alice@local", "msg.chat.send"));
    assert!(allowed_pub("alice@local", "call.signal"));
    assert!(allowed_pub("alice@local", "msg.typing.5"));
    assert!(allowed_pub(
        "alice@local",
        &format!("presence.{}", web_user_id("alice@local"))
    ));
    assert!(allowed_pub(
        "alice@local",
        &format!("presence.{}", desktop_user_id("alice@local"))
    ));
    assert!(!allowed_pub("alice@local", "msg.typing.*"));
    assert!(!allowed_pub("alice@local", "msg.typing.>"));
    assert!(!allowed_pub("alice@local", "presence.*"));
    assert!(!allowed_pub(
        "alice@local",
        &format!("presence.{}", web_user_id("bob@local"))
    ));
    assert!(!allowed_pub("alice@local", "msg.user.bob@local"));
    assert!(!allowed_pub("alice@local", "identity.token.issue"));
    assert!(!allowed_pub("alice@local", "anything.else"));
}

#[test]
fn req_allows_known_denies_unknown() {
    assert!(allowed_req("alice@local", "identity.token.issue"));
    assert!(allowed_req("alice@local", "identity.user.register"));
    assert!(allowed_req("alice@local", "identity.email.confirm"));
    assert!(allowed_req("alice@local", "identity.server.info"));
    assert!(allowed_req("alice@local", "identity.telegram.confirm"));
    assert!(allowed_req("alice@local", "identity.register.status"));
    assert!(allowed_req("alice@local", "identity.user.twofa"));
    assert!(allowed_req("alice@local", "msg.sync.request"));
    assert!(allowed_req("alice@local", "group.create"));
    assert!(!allowed_req("alice@local", "msg.user.bob@local"));
    assert!(!allowed_req("alice@local", "something.random"));
}

#[test]
fn payload_actor_and_token_are_bound_to_authenticated_session() {
    let payload = json!({
        "id": "00000000-0000-7000-8000-000000000001",
        "from": "victim@local",
        "ts": 1,
        "token": "victim-token",
        "payload": {
            "to": "0192f4a0-1c2b-7def-8123-000000000001",
            "content": {
                "kind": "group_encrypted",
                "ciphertext": "ciphertext",
                "group": "0192f4a0-1c2b-7def-8123-000000000001",
                "sender_identity": "curve25519"
            }
        }
    })
    .to_string();
    let bound =
        bind_client_payload("mallory@local", "mallory-token", "msg.chat.send", &payload)
            .unwrap();
    let value: Value = serde_json::from_str(&bound).unwrap();
    assert_eq!(value["from"], "mallory@local");
    assert_eq!(value["token"], "mallory-token");

    let group = bind_client_payload(
        "mallory@local",
        "mallory-token",
        "group.create",
        r#"{"token":"victim-token","name":"x","members":[]}"#,
    )
    .unwrap();
    let group: Value = serde_json::from_str(&group).unwrap();
    assert_eq!(group["token"], "mallory-token");

    let typing = bind_client_payload(
        "mallory@local",
        "mallory-token",
        "msg.typing.123",
        r#"{"from":"victim@local","to":"bob@local"}"#,
    )
    .unwrap();
    let typing: Value = serde_json::from_str(&typing).unwrap();
    assert_eq!(typing["from"], "mallory@local");
}

#[test]
fn sealed_sender_is_preserved_only_for_encrypted_direct_messages() {
    let event = |to: &str, kind: &str| {
        json!({
            "id": "00000000-0000-7000-8000-000000000002",
            "from": "",
            "ts": 1,
            "token": "stale",
            "payload": {"to": to, "content": {"kind": kind, "ciphertext": "x"}}
        })
        .to_string()
    };

    let direct = bind_client_payload(
        "alice@local",
        "fresh",
        "msg.chat.send",
        &event("bob@local", "encrypted"),
    )
    .unwrap();
    let direct: Value = serde_json::from_str(&direct).unwrap();
    assert_eq!(direct["from"], "");
    assert_eq!(direct["token"], "fresh");

    let group_target = event("0192f4a0-1c2b-7def-8123-000000000002", "encrypted");
    let bound =
        bind_client_payload("alice@local", "fresh", "msg.chat.send", &group_target).unwrap();
    let bound: Value = serde_json::from_str(&bound).unwrap();
    assert_eq!(bound["from"], "alice@local");
}

#[test]
fn rejects_subject_injection_in_to_and_recipients() {
    // P-01: `to` с пробелом/CRLF/wildcard разорвал бы кадр PUB в NATS.
    for bad in [
        "bob@s 0\r\n\r\nPUB msg.user.bob@s 3",
        "bob@s\r\nSUB > 99",
        "bob@*",
        "bob@local.>",
        "not-a-uuid-not-an-addr",
    ] {
        let payload = json!({
            "id": "00000000-0000-7000-8000-000000000009",
            "from": "",
            "ts": 1,
            "token": "t",
            "payload": {"to": bad, "content": {"kind": "encrypted", "ciphertext": "x"}}
        })
        .to_string();
        let err = bind_client_payload("alice@local", "fresh", "msg.chat.send", &payload)
            .unwrap_err();
        assert!(
            err.to_string().contains("адрес"),
            "ожидали отказ по адресу для {bad:?}, получили: {err}"
        );
    }

    // recipients в file.upload.complete тоже уходят в грант/маршрут
    let payload = json!({
        "id": "00000000-0000-7000-8000-00000000000a",
        "from": "alice@local",
        "ts": 1,
        "token": "t",
        "payload": {"file_id": "0192f4a0-1c2b-7def-8123-00000000000a",
                    "filename": "f", "total_chunks": 1, "size_bytes": 1,
                    "mime_type": "text/plain",
                    "recipients": ["ok@local", "bad addr\r\nPUB x"]}
    })
    .to_string();
    let err =
        bind_client_payload("alice@local", "fresh", "file.upload.complete", &payload)
            .unwrap_err();
    assert!(err.to_string().contains("recipients"));

    // Валидный адрес и валидный групповой UUID проходят
    for good in ["bob@local", "0192f4a0-1c2b-7def-8123-000000000003"] {
        let payload = json!({
            "id": "00000000-0000-7000-8000-00000000000b",
            "from": "",
            "ts": 1,
            "token": "t",
            "payload": {"to": good, "content": {"kind": "encrypted", "ciphertext": "x"}}
        })
        .to_string();
        assert!(
            bind_client_payload("alice@local", "fresh", "msg.chat.send", &payload).is_ok(),
            "валидный адрес {good:?} должен проходить"
        );
    }
}

// P-22: правка тоже только E2E — plaintext-edit и legacy text-edit отвергаются
#[test]
fn plaintext_edits_are_rejected_fail_closed() {
    let mid = "00000000-0000-7000-8000-000000000e01";
    for payload in [
        serde_json::json!({"message_id": mid, "text": "plain"}),
        serde_json::json!({"message_id": mid, "content": {"kind": "text", "text": "plain"}}),
    ] {
        let raw = serde_json::json!({"id": mid, "from": "alice@local", "ts": 1, "token": "t", "payload": payload});
        let error = bind_client_payload("alice@local", "tok", "msg.chat.edit", &raw.to_string()).unwrap_err();
        assert!(error.to_string().contains("plaintext"), "{error}");
    }
    let raw = serde_json::json!({"id": mid, "from": "alice@local", "ts": 1, "token": "t",
        "payload": {"message_id": mid, "content": {"kind": "encrypted", "ciphertext": "x", "sender_signing_key": "k"}, "signature": "s"}});
    assert!(bind_client_payload("alice@local", "tok", "msg.chat.edit", &raw.to_string()).is_ok());
}

#[test]
fn plaintext_messages_are_rejected_fail_closed() {
    for kind in ["text", "photo", "file", "poll"] {
        let payload = json!({
            "id": "00000000-0000-7000-8000-000000000003",
            "from": "alice@local",
            "ts": 1,
            "token": "fresh",
            "payload": {"to": "bob@local", "content": {"kind": kind, "text": "secret"}}
        })
        .to_string();
        let error = bind_client_payload(
            "alice@local",
            "fresh",
            "msg.chat.send",
            &payload,
        )
        .unwrap_err();
        assert!(error.to_string().contains("plaintext"));
    }
}

#[test]
fn v1_mode_parses_e6_flag() {
    use crate::session::{parse_v1_mode, V1Mode};
    assert_eq!(parse_v1_mode(None), V1Mode::Normal);
    assert_eq!(parse_v1_mode(Some("notice")), V1Mode::Notice);
    assert_eq!(parse_v1_mode(Some(" disabled ")), V1Mode::Disabled);
    assert_eq!(parse_v1_mode(Some("bogus")), V1Mode::Normal);
}

// ── ревью безопасности 7 окт 2026: GW-01, GW-02, GW-04, GW-06 ────────────────

#[test]
fn client_ip_field_is_never_taken_from_client() {
    // GW-04: клиентское client_ip вычищается для любого subject
    let out = bind_client_payload("alice@local", "jwt", IDENTITY_TELEGRAM_CONFIRM,
        r#"{"secret":"x","token":"t","telegram_id":1,"client_ip":"213.155.15.139"}"#).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v.get("client_ip").is_none(), "client_ip клиента не проходит: {out}");
    assert_eq!(v["token"], "t", "бутстрап-запрос не получает токен сессии вместо своего");
    // после очистки gateway подмешивает свой адрес
    let injected = inject_client_ip(&out, "10.0.0.7");
    assert_eq!(serde_json::from_str::<Value>(&injected).unwrap()["client_ip"], "10.0.0.7");
}

#[test]
fn ephemeral_frames_are_size_capped() {
    // GW-01: «печатает»/«в сети» — короткие кадры
    let small = r#"{"to":"bob@local","typing":true}"#;
    let out = bind_client_payload("alice@local", "jwt", "msg.typing.123", small).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["from"], "alice@local");
    let big = format!(r#"{{"to":"bob@local","pad":"{}"}}"#, "x".repeat(EPHEMERAL_MAX_BYTES));
    assert!(bind_client_payload("alice@local", "jwt", "msg.typing.123", &big).is_err());
    assert!(bind_client_payload("alice@local", "jwt", "presence.123", &big).is_err());
}

#[test]
fn pre_auth_requests_are_rate_limited_per_connection() {
    // GW-06: до входа — своя корзина; всплеск конечен
    let mut b = pre_auth_bucket();
    let t0 = Instant::now();
    let mut ok = 0;
    for _ in 0..200 {
        if b.try_take_at(t0) { ok += 1; }
    }
    assert!(ok <= 20, "всплеск до входа ограничен: {ok}");
    assert!(anon_idle_secs() <= 60, "анонимное соединение не живёт сутками");
}

#[test]
fn disabled_v1_lets_only_bot_confirm_through() {
    // E6: при отключённом v1 до входа проходит только identity.telegram.confirm
    let ok: Value = serde_json::from_str(r#"{"op":"req","id":"1","subject":"identity.telegram.confirm","payload":"{}"}"#).unwrap();
    assert!(is_bot_confirm_frame(&ok));
    for bad in [
        r#"{"op":"auth","token":"x"}"#,
        r#"{"op":"req","id":"1","subject":"identity.token.issue","payload":"{}"}"#,
        r#"{"op":"sub","subject":"msg.user.a@local"}"#,
        r#"{"op":"req","id":"1","subject":"identity.server.info"}"#,
    ] {
        assert!(!is_bot_confirm_frame(&serde_json::from_str(bad).unwrap()), "{bad}");
    }
}
