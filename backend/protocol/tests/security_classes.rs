//! Тесты классов уязвимостей (T028): по группе тестов на каждую строку
//! `specs/007-protocol-v2/contracts/security-invariants.md` — часть, которую
//! закрывает движок. Серверная/клиентская часть каждого класса — в тестах
//! gateway/шардов/обвязок (задачи E1–E4); здесь это отмечено в комментариях.

use std::collections::HashMap;

use parvane_protocol::codec;
use parvane_protocol::content_guard;
use parvane_protocol::group::{self, ContextVerdict, SignerInfo};
use parvane_protocol::identity::{self, DeviceLog, LogPin, RootIdentity, RootTrust, TrustVerdict};
use parvane_protocol::limits::{self, Origin};
use parvane_protocol::msg;
use parvane_protocol::olm::{MegolmInbound, MegolmOutbound, OlmAccount};
use parvane_protocol::pb::parvane::core::v2::{
    frame, sealed_envelope::Access, user_device_log_entry::Change as DevChange, AuthOk, DeviceCertificate, DeviceRef,
    GroupEnvelopeInner, LegacyDevice, LegacyDeviceSet, Request, SealedInner, UserRef,
};
use parvane_protocol::pb::parvane::group::v2::{group_change::Change, AddMember, Ban, Create, GroupKind, NewEpoch, Permissions};
use parvane_protocol::pb::parvane::msg::v2::{content, Content, Media, Text};
use parvane_protocol::policy::{self, SendFormat, StickyV2};
use parvane_protocol::schema::{self, METHODS};
use parvane_protocol::sign::{self, ReplayGuard};
use parvane_protocol::{legacy_v1, seal, sync, tokens, ProtoError};
use prost::Message;

// ── общие помощники ─────────────────────────────────────────────────────────

struct Dev {
    dev: DeviceRef,
    acc: OlmAccount,
    cert: parvane_protocol::pb::parvane::core::v2::SignedDeviceCertificate,
    root: RootIdentity,
}

fn device(user: &str, id: &str) -> Dev {
    let root = RootIdentity::generate(user).unwrap();
    let acc = OlmAccount::new();
    let c = DeviceCertificate {
        user: Some(UserRef { address: user.into() }),
        device_id: id.into(),
        olm_curve25519: acc.curve25519().to_vec(),
        olm_ed25519: acc.ed25519().to_vec(),
        hpke_x25519: vec![9; 32],
        serial: 1,
        ..Default::default()
    };
    Dev { dev: DeviceRef { address: user.into(), device_id: id.into() }, cert: root.certify_device(&acc, &c).unwrap(), acc, root }
}

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
}

fn direct(from: &Dev, to: &mut Dev, peer: &str, c: &Content) -> SealedInner {
    let otk = to.acc.generate_one_time_keys(1).remove(0).1;
    let mut s = from.acc.outbound(&to.acc.curve25519(), &otk).unwrap();
    let op = msg::sign_direct(&from.acc, c, peer, vec![to.dev.clone()], 1).unwrap();
    msg::seal_inner(&from.cert, &mut s, &op).unwrap()
}

fn receive(to: &mut Dev, inner: &SealedInner, active: bool, seen: &mut ReplayGuard) -> Result<msg::Opened, ProtoError> {
    let me = to.dev.clone();
    let acc = &mut to.acc;
    let mut dec = |id: &[u8; 32], _t: u32, b: &[u8]| acc.inbound(id, b).map(|(_, pt)| pt);
    msg::open_direct(inner, &me, &move |_| active, &mut dec, seen)
}

// ── 1. Широковещательный ответ ──────────────────────────────────────────────
// Сервер: gateway отвечает только в Response своей сессии (T033).
#[test]
fn c01_registry_has_no_broadcast_reply() {
    for m in METHODS {
        assert!(!m.shard.is_empty(), "{}", m.name);
        assert!(m.subject.starts_with("v2."), "{}: subject вне пространства v2", m.name);
        // Ни один subject не является подстановочным.
        assert!(!m.subject.contains('*') && !m.subject.contains('>'), "{}", m.name);
    }
}

// ── 2. Wildcard/чужие подписки ──────────────────────────────────────────────
// Сервер: подписка только на журнал своего устройства (T033, T077).
#[test]
fn c02_subscriptions_have_no_target_field() {
    // Подписка на инбокс не принимает адрес — устройство берётся из сессии.
    let spec = schema::message("parvane.msg.v2.InboxSubscribeRequest").unwrap();
    assert!(spec.fields.is_empty());
    // Каналы эфемерных — 128-битные секреты.
    let e = schema::message("parvane.msg.v2.EphemeralSubscribeRequest").unwrap();
    assert_eq!(e.field(1).unwrap().max_len, 16);
}

// ── 3. Доверие самозаявленным полям ─────────────────────────────────────────
#[test]
fn c03_server_set_fields_and_forged_author() {
    let f = codec::encode_frame(frame::Kind::AuthOk(AuthOk { user: "mallory@x".into(), device_id: "d".into() }));
    assert_eq!(codec::decode_frame(&f, Origin::Client).err(), Some(ProtoError::ServerSetField("user")));
    // Подменённый автор: сертификат Алисы, шифрует Mallory.
    let alice = device("alice@x", "a1");
    let mallory = device("mallory@x", "m1");
    let mut bob = device("bob@x", "b1");
    let otk = bob.acc.generate_one_time_keys(1).remove(0).1;
    let mut s = mallory.acc.outbound(&bob.acc.curve25519(), &otk).unwrap();
    let op = msg::sign_direct(&mallory.acc, &text("x"), "bob@x", vec![bob.dev.clone()], 1).unwrap();
    let inner = msg::seal_inner(&alice.cert, &mut s, &op).unwrap();
    assert!(receive(&mut bob, &inner, true, &mut ReplayGuard::new(10)).is_err());
}

// ── 4. Инъекция в маршрут ───────────────────────────────────────────────────
#[test]
fn c04_route_injection() {
    use parvane_protocol::address::*;
    for bad in ["a@b.>", "a@*", "a b@c", "a@b\r\nPUB x", "a@b.c.", "@b", "a@"] {
        assert!(!is_valid_address(bad), "{bad:?}");
    }
    assert!(ref_subject_token(&parvane_protocol::pb::parvane::core::v2::Ref { domain: "x".into(), id: vec![0x2e; 16] })
        .unwrap()
        .bytes()
        .all(|b| b.is_ascii_hexdigit()));
}

// ── 5. Отзыв устройства ─────────────────────────────────────────────────────
// Сервер: REVOKED и закрытие WS ≤ 1 с (T047). Движок: подписи отозванного не принимаются.
#[test]
fn c05_revoked_device_signatures_rejected() {
    let alice = device("alice@x", "a1");
    let mut bob = device("bob@x", "b1");
    let inner = direct(&alice, &mut bob, "bob@x", &text("x"));
    assert_eq!(receive(&mut bob, &inner, false, &mut ReplayGuard::new(10)).err(), Some(ProtoError::Forbidden));
}

// ── 6. Неподписанные мутации / склейка ──────────────────────────────────────
#[test]
fn c06_cross_operation_and_sdp_redirect() {
    let k = sign::generate_signing_key();
    let h = |d: &str, o: &str| parvane_protocol::pb::parvane::core::v2::OpHeader {
        domain: d.into(),
        op_type: o.into(),
        op_id: sign::new_op_id(),
        audience: vec![DeviceRef { address: "bob@x".into(), device_id: "d1".into() }],
        ..Default::default()
    };
    let op = sign::sign_op(&k, h("call", "signal"), b"sdp".to_vec()).unwrap();
    assert!(sign::verify_op(&op, "call", "hangup", None).is_err());
    let v = sign::verify_op(&op, "call", "signal", None).unwrap();
    assert!(v.require_audience(&DeviceRef { address: "carol@x".into(), device_id: "c1".into() }).is_err());
}

// ── 7. Повторы ──────────────────────────────────────────────────────────────
#[test]
fn c07_replay() {
    let mut g = ReplayGuard::new(100);
    let id = sign::new_op_id();
    g.check_and_insert(&id).unwrap();
    assert_eq!(g.check_and_insert(&id), Err(ProtoError::Duplicate));
    // Megolm: повтор индекса.
    let mut out = MegolmOutbound::new();
    let mut inb = MegolmInbound::from_session_key(&out.session_key()).unwrap();
    let ct = out.encrypt(b"x");
    let (_, idx) = inb.decrypt(&ct).unwrap();
    let mut seen = ReplayGuard::new(10);
    let mut key = b"megolm".to_vec();
    key.extend(idx.to_be_bytes());
    seen.check_and_insert(&key).unwrap();
    assert!(seen.check_and_insert(&key).is_err());
}

// ── 8. Ключ не привязан к личности, TOFU ────────────────────────────────────
#[test]
fn c08_certificate_root_and_tofu() {
    let a = device("alice@x", "a1");
    let evil = RootIdentity::generate("alice@x").unwrap();
    let mut forged = a.cert.clone();
    forged.root_key = evil.root_pub().to_vec();
    assert!(identity::verify_certificate(&forged, Some("alice@x")).is_err());
    let mut t = RootTrust::default();
    assert_eq!(t.observe("alice@x", &a.root.root_pub()), TrustVerdict::New);
    assert_eq!(t.observe("alice@x", &evil.root_pub()), TrustVerdict::Changed);
}

// ── 9. Неаутентифицированные данные ─────────────────────────────────────────
#[test]
fn c09_any_modified_byte_rejected_before_output() {
    let (sk, pk) = seal::generate_keypair();
    let me = DeviceRef { address: "bob@x".into(), device_id: "d".into() };
    let env = seal::seal(&me, &pk, Access::DeliveryKey(vec![1; 32]), SealedInner { olm_message: vec![5; 50], ..Default::default() }, false).unwrap();
    for i in 0..env.ciphertext.len() {
        let mut e = env.clone();
        e.ciphertext[i] ^= 0x40;
        assert!(seal::open(&e, &me, &sk).is_err());
    }
    let key = [3u8; 32];
    let send = sign::generate_signing_key();
    let g = parvane_protocol::pb::parvane::core::v2::Ref { domain: "x".into(), id: vec![1; 16] };
    let mut genv = group::seal_envelope(&send, &key, &g, 1, &GroupEnvelopeInner::default()).unwrap();
    genv.epoch_aead_ciphertext[0] ^= 1;
    assert!(group::open_envelope(&genv, &key).is_err());
}

// ── 10. Расхождение клиентов ────────────────────────────────────────────────
#[test]
fn c10_single_format_for_dialects() {
    let web = legacy_v1::parse_megolm_plaintext(br#"{"kind":"poll","question":"Q","options":["a"],"is_public":true}"#).unwrap();
    let desk = legacy_v1::parse_megolm_plaintext(br#"{"kind":"poll","question":"Q","answers":["a"],"public":true,"quiz":false}"#).unwrap();
    assert_eq!(web, desk);
}

// ── 11. Метаданные серверу ──────────────────────────────────────────────────
// Полная проверка — SC-003 (`scripts/protocol_sender_leak_check.sh`, T068).
#[test]
fn c11_sealed_envelope_carries_no_sender() {
    let alice = device("alice@x", "a1");
    let mut bob = device("bob@x", "b1");
    let inner = direct(&alice, &mut bob, "bob@x", &text("hi"));
    let (_, pk) = seal::generate_keypair();
    let env = seal::seal(&bob.dev, &pk, Access::DeliveryKey(vec![1; 32]), inner, true).unwrap();
    let bytes = env.encode_to_vec();
    assert!(!bytes.windows(7).any(|w| w == b"alice@x"));
    assert!(!bytes.windows(32).any(|w| w == alice.acc.curve25519()));
    assert!(!bytes.windows(32).any(|w| w == alice.acc.ed25519()));
    // В схеме конверта нет поля отправителя.
    let spec = schema::message("parvane.core.v2.SealedEnvelope").unwrap();
    assert!(spec.fields.iter().all(|f| !f.name.contains("sender") && f.name != "from"));
}

// ── 12. Лимиты ──────────────────────────────────────────────────────────────
#[test]
fn c12_every_field_limited() {
    for m in schema::MESSAGES {
        for f in m.fields {
            if matches!(f.ty, schema::FieldTy::Str | schema::FieldTy::Bytes) {
                assert!(f.max_len > 0, "{}.{}", m.name, f.name);
            }
            if f.repeated {
                assert!(f.max_items > 0, "{}.{}", m.name, f.name);
            }
        }
    }
    assert_eq!(schema::message("parvane.core.v2.OpBody").unwrap().field(2).unwrap().max_len, 262_144);
    assert_eq!(schema::message("parvane.call.v2.IceCandidate").unwrap().field(1).unwrap().max_len, 4_096);
}

// ── 13. DoS/усиление ────────────────────────────────────────────────────────
// Сервер: token-bucket по классам (T035). Движок: у каждого метода есть класс.
#[test]
fn c13_every_method_has_rate_class_and_epoch_limit() {
    for m in METHODS {
        assert!((1..=5).contains(&m.rate), "{}", m.name);
    }
    assert_eq!(group::EPOCH_MIN_INTERVAL_MS, 10_000);
    assert_eq!(tokens::DAILY_LIMIT, 50);
}

// ── 14. SSRF ────────────────────────────────────────────────────────────────
// Закрывается общим фильтром `parvane-netguard` (T106) в preview/push. Движок
// исходящих запросов не делает; здесь — только что превью ссылок не принимает
// опасных схем у получателя.
#[test]
fn c14_receiver_never_follows_non_http() {
    assert!(content_guard::safe_url("file:///etc/passwd").is_none());
    assert!(content_guard::safe_url("gopher://127.0.0.1:25/").is_none());
}

// ── 15. Опасные операции по одному токену ───────────────────────────────────
#[test]
fn c15_reauth_marked() {
    for name in ["identity.device.revoke", "identity.account.set_2fa", "identity.account.change_password", "identity.root.rotate"] {
        assert!(schema::method(name).unwrap().reauth, "{name}");
    }
}

// ── 16. Данные отправителя опасны получателю ────────────────────────────────
#[test]
fn c16_content_guard() {
    assert_eq!(content_guard::safe_mime("text/html"), "application/octet-stream");
    assert!(content_guard::safe_url("javascript:alert(1)").is_none());
    assert!(content_guard::safe_url("tg://x").is_none());
    let mut c = Content { kind: Some(content::Kind::Media(Media { mime: "image/svg+xml".into(), ..Default::default() })), ..Default::default() };
    content_guard::sanitize_content(&mut c);
    let Some(content::Kind::Media(m)) = c.kind else { panic!() };
    assert_eq!(m.mime, "application/octet-stream");
}

// ── 17. Fallback в открытый текст ───────────────────────────────────────────
#[test]
fn c17_delivery_methods_take_only_envelopes() {
    for name in ["msg.deliver_sealed", "msg.deliver_group", "call.signal_sealed", "call.ring_sealed"] {
        let m = schema::method(name).unwrap();
        assert_eq!(m.channel, 3, "{name}: только ANON");
        let req = &schema::MESSAGES[m.request];
        for f in req.fields {
            let schema::FieldTy::Message(i) = f.ty else { panic!("{name}: поле {} не конверт", f.name) };
            assert!(schema::MESSAGES[i].name.ends_with("Envelope"), "{name}");
        }
    }
    let r = Request { id: 1, method: "msg.deliver_sealed".into(), body: br#"{"kind":"text","text":"hi"}"#.to_vec(), timeout_ms: 1 };
    assert!(codec::check_request(&r, Origin::Client).is_err());
}

// ── 18. Секреты на клиенте ──────────────────────────────────────────────────
// Сервер: файлы ключей 0600 (T036, T071). Движок: состояние сохраняется только зашифрованным.
#[test]
fn c18_pickles_are_encrypted() {
    let acc = OlmAccount::new();
    let key = [1u8; 32];
    let p = acc.pickle(&key);
    let ed = acc.ed25519();
    assert!(!p.contains(&base64_std(&ed)));
    assert!(OlmAccount::from_pickle(&p, &[2u8; 32]).is_err());
}

fn base64_std(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(b)
}

// ── 19. Состав группы задаёт сервер ─────────────────────────────────────────
#[test]
fn c19_member_injected_by_server_rejected() {
    let owner = sign::generate_signing_key();
    let server = sign::generate_signing_key();
    let map: HashMap<[u8; 32], SignerInfo> = [
        (owner.verifying_key().to_bytes(), SignerInfo { user: "alice@x".into(), root_key: [1; 32] }),
        (server.verifying_key().to_bytes(), SignerInfo { user: "srv@x".into(), root_key: [2; 32] }),
    ]
    .into();
    let resolve = |k: &[u8; 32]| map.get(k).cloned();
    let g = group::build_entry(&owner, None, "x", Change::Create(Create { kind: GroupKind::Group as i32, default_permissions: Some(Permissions::default()), ..Default::default() }), 1).unwrap();
    let s = group::apply(None, &g, &resolve).unwrap();
    // Сервер (не участник) добавляет участника.
    let e = group::build_entry(&server, Some(&s), "x", Change::AddMember(AddMember { member: Some(UserRef { address: "eve@x".into() }) }), 2).unwrap();
    assert_eq!(group::apply(Some(&s), &e, &resolve).err(), Some(ProtoError::Forbidden));
    // Неизвестный ключ — отказ.
    let unknown = sign::generate_signing_key();
    let e = group::build_entry(&unknown, Some(&s), "x", Change::Ban(Ban { member: Some(UserRef { address: "alice@x".into() }) }), 2).unwrap();
    assert!(group::apply(Some(&s), &e, &resolve).is_err());
}

// ── 20. Легаси-копии только по LegacyDeviceSet ──────────────────────────────
#[test]
fn c20_legacy_copies_only_to_owner_listed() {
    let a = RootIdentity::generate("alice@x").unwrap();
    let mut log = DeviceLog::new("alice@x").unwrap();
    log.apply(&a.genesis_entry().unwrap()).unwrap();
    let mine = LegacyDevice { device_id: "old".into(), olm_curve25519: vec![1; 32], olm_ed25519: vec![2; 32] };
    let e = identity::device_log_entry("alice@x", 2, log.head_hash, DevChange::LegacyDevices(LegacyDeviceSet { devices: vec![mine.clone()] }), None);
    log.apply(&identity::sign_device_log_entry(&a.self_signing, &e).unwrap()).unwrap();
    let fake = LegacyDevice { device_id: "srv".into(), olm_curve25519: vec![3; 32], olm_ed25519: vec![4; 32] };
    let listed = [mine.clone(), fake];
    let (ok, warn) = log.legacy_recipients(&listed);
    assert_eq!(ok.len(), 1);
    assert_eq!(warn.len(), 1);
}

// ── 21. Липкая политика ─────────────────────────────────────────────────────
#[test]
fn c21_no_downgrade_by_features() {
    let a = RootIdentity::generate("alice@x").unwrap();
    let mut log = DeviceLog::new("alice@x").unwrap();
    log.apply(&a.genesis_entry().unwrap()).unwrap();
    let mut st = StickyV2::default();
    assert_eq!(policy::choose(&mut st, "alice@x", Some(&log), "x", None, &[]), SendFormat::Refuse);
    assert_eq!(policy::choose(&mut st, "alice@x", None, "x", None, &[]), SendFormat::Refuse);
}

// ── 22–24. Журнал группы: позиция, форк, ссылки ─────────────────────────────
#[test]
fn c22_c23_group_log_position_and_fork() {
    let owner = sign::generate_signing_key();
    let map: HashMap<[u8; 32], SignerInfo> =
        [(owner.verifying_key().to_bytes(), SignerInfo { user: "alice@x".into(), root_key: [1; 32] })].into();
    let resolve = |k: &[u8; 32]| map.get(k).cloned();
    let g = group::build_entry(&owner, None, "x", Change::Create(Create { kind: GroupKind::Group as i32, ..Default::default() }), 1).unwrap();
    let s = group::apply(None, &g, &resolve).unwrap();
    let send = sign::generate_signing_key();
    let e = group::build_entry(&owner, Some(&s), "x", Change::NewEpoch(NewEpoch { epoch: 1, send_public_key: send.verifying_key().to_bytes().to_vec() }), 100).unwrap();
    let s1 = group::apply(Some(&s), &e, &resolve).unwrap();
    // Та же запись на другой позиции.
    let mut moved = e.clone();
    moved.version = 3;
    moved.prev_hash = s1.head_hash().to_vec();
    assert!(group::apply(Some(&s1), &moved, &resolve).is_err());
    // Форк: два hash на одну version.
    let mut ctx = s1.context();
    ctx.state_head_hash = vec![7; 32];
    assert_eq!(s1.check_context(&ctx), ContextVerdict::Fork);
}

// ── 25. Гигиена анонимного канала ───────────────────────────────────────────
// Сервер: один получатель на запрос, ANON только в ANON-канале (T120).
#[test]
fn c25_anon_methods_are_anon_only() {
    for m in METHODS.iter().filter(|m| m.channel == 3) {
        assert_eq!(m.rate, 4, "{}", m.name);
        assert!(!m.reauth && !m.operator_only, "{}", m.name);
    }
}

// ── 26. Ключ выпуска жетонов ────────────────────────────────────────────────
#[test]
fn c26_token_key_consistency() {
    let issuer = tokens::Issuer::generate(0, i64::MAX).unwrap();
    let server = sign::generate_signing_key();
    let trusted = tokens::verify_key_list(&tokens::sign_key_list(&server, vec![issuer.token_key()], 0), server.verifying_key().as_bytes()).unwrap();
    let rogue = tokens::Issuer::generate(0, i64::MAX).unwrap();
    assert!(tokens::TokenRequest::new(&trusted, &rogue.key_id(), 1).is_err());
    let (req, bl) = tokens::TokenRequest::new(&trusted, &issuer.key_id(), 1).unwrap();
    let t = req.finalize(&issuer.issue(&bl).unwrap()).unwrap().remove(0);
    tokens::verify_token(&t, &[&issuer], 1).unwrap();
    // Двойная трата: одинаковый spent_id — сервер отвергает вставкой (UNIQUE).
    let mut spent = ReplayGuard::new(1000);
    spent.check_and_insert(&tokens::spent_id(&t)).unwrap();
    assert_eq!(spent.check_and_insert(&tokens::spent_id(&t)), Err(ProtoError::Duplicate));
}

// ── 27. Неразличимость автора в группе ──────────────────────────────────────
#[test]
fn c27_group_envelope_hides_session() {
    let send = sign::generate_signing_key();
    let g = parvane_protocol::pb::parvane::core::v2::Ref { domain: "x".into(), id: vec![1; 16] };
    let inner = GroupEnvelopeInner { megolm_session_id: b"SESSION-ID-XYZ".to_vec(), megolm_message: vec![1; 40], padding: vec![] };
    let a = group::seal_envelope(&send, &[1; 32], &g, 1, &inner).unwrap();
    let b = group::seal_envelope(&send, &[1; 32], &g, 1, &inner).unwrap();
    let (ab, bb) = (a.encode_to_vec(), b.encode_to_vec());
    assert!(!ab.windows(14).any(|w| w == b"SESSION-ID-XYZ"));
    assert_ne!(a.envelope_nonce, b.envelope_nonce);
    assert_ne!(ab, bb);
}

// ── 28. Обходные каналы метаданных ──────────────────────────────────────────
#[test]
fn c28_no_server_call_history_and_anon_bundle() {
    assert!(schema::method("call.history").is_none());
    assert_eq!(schema::method("identity.device.fetch_bundle_anon").unwrap().channel, 3);
    assert_eq!(schema::method("cloud.blob.download_cap").unwrap().channel, 3);
}

// ── 29. Привязка внутреннего слоя ───────────────────────────────────────────
#[test]
fn c29_forwarded_signed_message_rejected() {
    let alice = device("alice@x", "a1");
    let mut carol = device("carol@x", "c1");
    let inner = direct(&alice, &mut carol, "bob@x", &text("для Боба"));
    assert_eq!(receive(&mut carol, &inner, true, &mut ReplayGuard::new(10)).err(), Some(ProtoError::ContextMismatch));
    // LegacyV1 не бывает содержимым v2.
    assert!(schema::message("parvane.msg.v2.Content").unwrap().field(99).is_none());
}

// ── 30. Однозначные подписываемые байты ─────────────────────────────────────
#[test]
fn c30_signing_bytes_unambiguous() {
    assert!(sign::op_signing_bytes("a\0b", "x", b"").is_err());
    assert_ne!(sign::op_signing_bytes("ab", "c", b"").unwrap(), sign::op_signing_bytes("a", "bc", b"").unwrap());
}

// ── 31. Журнал устройств, откат ─────────────────────────────────────────────
#[test]
fn c31_device_log_rollback() {
    let mut pin = LogPin::default();
    pin.advance(5, [5; 32], None).unwrap();
    assert!(pin.advance(4, [4; 32], None).is_err());
    assert!(pin.advance(5, [6; 32], None).is_err());
}

// ── 32. Резервная копия корня ───────────────────────────────────────────────
// Формат серверной копии (ключ восстановления ≥ 128 бит) — T119 (identity).
// Движок: корень не входит ни в один сертификат/журнал в приватном виде.
#[test]
fn c32_root_private_never_serialized() {
    let a = RootIdentity::generate("alice@x").unwrap();
    let g = a.genesis_entry().unwrap().encode_to_vec();
    let secret = a.root.to_bytes();
    assert!(!g.windows(32).any(|w| w == secret));
}

// Инварианты синхронизации (SYNC-1/2) — часть класса 10.
#[test]
fn sync_rules() {
    let mut c = sync::Cursor::from_disk(0);
    c.mark_applied(2);
    assert_eq!(c.disk_value(), 0);
    assert_eq!(limits::MAX_DEPTH, 32);
}

// ── security-code-review-us1 ────────────────────────────────────────────────

// C1-01 (классы 3, 8, 19): Мэллори кладёт в свой журнал сертификат с ключом
// подписи устройства Алисы — без приватного ключа доказательства владения
// нет, запись журнала отвергается, авторство записей группы не присвоить.
#[test]
fn c19b_foreign_device_key_in_own_certificate_rejected() {
    let alice = device("alice@x", "a1");
    let mallory_root = RootIdentity::generate("aaa@x").unwrap();
    let mut log = DeviceLog::new("aaa@x").unwrap();
    log.apply(&mallory_root.genesis_entry().unwrap()).unwrap();
    let alice_cert: DeviceCertificate = prost::Message::decode(alice.cert.certificate.as_slice()).unwrap();
    // Копия сертификата Алисы (с её подписью владения) под адресом Мэллори.
    let mut stolen = alice_cert.clone();
    stolen.user = Some(UserRef { address: "aaa@x".into() });
    let e = mallory_root.add_device_entry(2, log.head_hash, &stolen).unwrap();
    assert_eq!(log.apply(&e), Err(ProtoError::BadCertificate));
    // Без подписи владения.
    stolen.possession_signature.clear();
    let e = mallory_root.add_device_entry(2, log.head_hash, &stolen).unwrap();
    assert_eq!(log.apply(&e), Err(ProtoError::BadCertificate));
    // Подписать владение чужим ключом нельзя.
    let mut own = stolen.clone();
    let mk = sign::generate_signing_key();
    assert!(identity::prove_possession(&mk, &mut own, &mallory_root.root_pub()).is_err());
    assert_eq!(log.version, 1);
}

// C1-06 (классы 18, 32): копия корня под ключом восстановления ≥ 128 бит.
#[test]
fn c32b_root_backup_under_recovery_key() {
    use parvane_protocol::recovery::{self, RecoveryKey, RECOVERY_ENTROPY_BYTES};
    assert!(RECOVERY_ENTROPY_BYTES * 8 >= 128);
    let a = RootIdentity::generate("alice@x").unwrap();
    let k = RecoveryKey::generate();
    let shown = k.to_display();
    let blob = recovery::export_root_backup(&a.root.to_bytes(), "alice@x", &k).unwrap();
    assert!(!blob.windows(32).any(|w| w == a.root.to_bytes()));
    let back = recovery::import_root_backup(&blob, "alice@x", &RecoveryKey::parse(&shown).unwrap()).unwrap();
    assert_eq!(*back, a.root.to_bytes());
    assert!(recovery::import_root_backup(&blob, "alice@x", &RecoveryKey::generate()).is_err());
}
