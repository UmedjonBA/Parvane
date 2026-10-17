//! Межсерверные запросы и ответы (spec 028, SC-004): сервер-получатель
//! отвергает каждый класс негодного кадра — подпись, адресат, просрочка,
//! повтор, утверждение о чужом домене, метод без `federated`, личность в
//! анонимном канале, тело сверх лимита схемы, чужие получатели записи
//! инбокса; ответ привязан к `nonce` запроса, поток — к порядку кадров.

use ed25519_dalek::SigningKey;
use parvane_protocol::error::ProtoError;
use parvane_protocol::federation::{self, FrameReader, TrustedServer, MAX_SKEW_MS};
use parvane_protocol::pb::parvane::core::v2::{
    s2s_request, s2s_response, DeviceRef, ErrorCode, GroupEnvelope, KeyOwnerRequest, PrivacyOfRequest, Ref, S2sAccountGone,
    S2sForward, S2sInboxPush, S2sRequest, S2sStreamChunk, SealedEnvelope, ServerDescriptor, SignedServerDescriptor, UserRef,
};
use parvane_protocol::pb::parvane::msg::v2::{inbox_record, DeliverSealedRequest, GroupStateNotice, InboxRecord};
use parvane_protocol::sign::{self, ctx, ReplayGuard};
use prost::Message;

const A: &str = "a.example";
const B: &str = "b.example";
const NOW: i64 = 1_790_000_000_000;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn trusted(domain: &str, k: &SigningKey) -> TrustedServer {
    let d = ServerDescriptor {
        domain: domain.into(),
        server_key: k.verifying_key().to_bytes().to_vec(),
        proto_major: parvane_protocol::PROTO_MAJOR,
        proto_minor: parvane_protocol::PROTO_MINOR,
        issued_ms: NOW,
        ..Default::default()
    };
    let bytes = d.encode_to_vec();
    let signed = SignedServerDescriptor { signature: sign::sign_ctx(k, ctx::SERVER_DESCRIPTOR, &[&bytes]), descriptor: bytes };
    federation::verify_descriptor(&signed, domain, None).unwrap()
}

fn request_bytes(k: &SigningKey, origin: &str, dest: &str, issued: i64, req: &S2sRequest) -> Vec<u8> {
    federation::sign_frame(k, origin, dest, issued, federation::REQUEST_TYPE, req.encode_to_vec()).unwrap().encode_to_vec()
}

fn forward(method: &str, body: Vec<u8>, user: &str, device: &str) -> S2sRequest {
    S2sRequest {
        kind: Some(s2s_request::Kind::Forward(S2sForward {
            method: method.into(),
            body,
            user: user.into(),
            device_id: device.into(),
            timeout_ms: 5000,
            ..Default::default()
        })),
    }
}

fn sealed_to(addr: &str) -> Vec<u8> {
    DeliverSealedRequest {
        envelopes: vec![SealedEnvelope {
            recipient: Some(DeviceRef { address: addr.into(), device_id: "d1".into() }),
            hpke_enc: vec![7; 32],
            ciphertext: vec![1, 2, 3],
            ..Default::default()
        }],
    }
    .encode_to_vec()
}

fn verify(bytes: &[u8], a: &TrustedServer) -> Result<S2sRequest, ProtoError> {
    federation::verify_request(bytes, a, B, NOW, None).map(|(_, r)| r)
}

#[test]
fn anonymous_forward_is_accepted_only_without_identity() {
    let k = key(0xA1);
    let a = trusted(A, &k);
    let ok = request_bytes(&k, A, B, NOW, &forward("msg.deliver_sealed", sealed_to("bob@b.example"), "", ""));
    assert!(verify(&ok, &a).is_ok());
    // Личность в анонимном канале — отказ (sealed sender).
    let named = request_bytes(&k, A, B, NOW, &forward("msg.deliver_sealed", sealed_to("bob@b.example"), "anya@a.example", "d1"));
    assert_eq!(verify(&named, &a).unwrap_err(), ProtoError::Forbidden);
}

#[test]
fn identified_forward_names_only_users_of_origin() {
    let k = key(0xA1);
    let a = trusted(A, &k);
    let body = parvane_protocol::pb::parvane::core::v2::DomainOpSyncRequest::default().encode_to_vec();
    let ok = request_bytes(&k, A, B, NOW, &forward("domain.op.sync", body.clone(), "anya@a.example", "d1"));
    assert!(verify(&ok, &a).is_ok());
    // Сервер A не может говорить от имени пользователя B или третьего домена.
    for user in ["bob@b.example", "eve@c.example"] {
        let bad = request_bytes(&k, A, B, NOW, &forward("domain.op.sync", body.clone(), user, "d1"));
        assert_eq!(verify(&bad, &a).unwrap_err(), ProtoError::Forbidden, "{user}");
    }
    // Без устройства — отказ.
    let bad = request_bytes(&k, A, B, NOW, &forward("domain.op.sync", body, "anya@a.example", ""));
    assert!(verify(&bad, &a).is_err());
}

#[test]
fn only_federated_methods_pass() {
    let k = key(0xA1);
    let a = trusted(A, &k);
    // Свои аккаунт и инбокс чужому серверу не доступны.
    let body = parvane_protocol::pb::parvane::msg::v2::InboxSyncRequest::default().encode_to_vec();
    let bad = request_bytes(&k, A, B, NOW, &forward("msg.inbox.sync", body, "anya@a.example", "d1"));
    assert_eq!(verify(&bad, &a).unwrap_err(), ProtoError::Forbidden);
    let bad = request_bytes(&k, A, B, NOW, &forward("no.such.method", vec![], "", ""));
    assert_eq!(verify(&bad, &a).unwrap_err(), ProtoError::UnknownMethod);
}

#[test]
fn forwarded_body_obeys_schema_limits() {
    let k = key(0xA1);
    let a = trusted(A, &k);
    let huge = DeliverSealedRequest {
        envelopes: (0..300)
            .map(|_| SealedEnvelope { recipient: Some(DeviceRef { address: "bob@b.example".into(), device_id: "d1".into() }), ..Default::default() })
            .collect(),
    }
    .encode_to_vec();
    let bad = request_bytes(&k, A, B, NOW, &forward("msg.deliver_sealed", huge, "", ""));
    assert!(matches!(verify(&bad, &a).unwrap_err(), ProtoError::FieldLimit(_) | ProtoError::Malformed));
}

#[test]
fn frame_classes_are_refused() {
    let k = key(0xA1);
    let a = trusted(A, &k);
    let req = forward("msg.deliver_sealed", sealed_to("bob@b.example"), "", "");
    // Чужая подпись.
    let forged = request_bytes(&key(0xEE), A, B, NOW, &req);
    assert!(verify(&forged, &a).is_err());
    // Адресован другому серверу.
    let other = request_bytes(&k, A, "c.example", NOW, &req);
    assert_eq!(verify(&other, &a).unwrap_err(), ProtoError::ContextMismatch);
    // Просрочен и из будущего.
    for t in [NOW - MAX_SKEW_MS - 1, NOW + MAX_SKEW_MS + 1] {
        assert_eq!(verify(&request_bytes(&k, A, B, t, &req), &a).unwrap_err(), ProtoError::Expired);
    }
    // Повтор того же кадра.
    let once = request_bytes(&k, A, B, NOW, &req);
    let mut guard = ReplayGuard::new(16);
    assert!(federation::verify_request(&once, &a, B, NOW, Some(&mut guard)).is_ok());
    assert!(federation::verify_request(&once, &a, B, NOW, Some(&mut guard)).is_err());
    // Не тот тип полезной нагрузки.
    let wrong = federation::sign_frame(&k, A, B, NOW, "parvane.core.v2.S2SResponse", req.encode_to_vec()).unwrap().encode_to_vec();
    assert_eq!(verify(&wrong, &a).unwrap_err(), ProtoError::ContextMismatch);
}

fn group_ref(domain: &str) -> Ref {
    Ref { domain: domain.into(), id: vec![5; 16] }
}

fn push(group: Ref, recipients: &[&str], record: InboxRecord) -> S2sRequest {
    S2sRequest {
        kind: Some(s2s_request::Kind::InboxPush(S2sInboxPush {
            group: Some(group),
            recipients: recipients.iter().map(|a| UserRef { address: (*a).into() }).collect(),
            record: record.encode_to_vec(),
        })),
    }
}

fn envelope_of(group: Ref) -> InboxRecord {
    InboxRecord {
        item: Some(inbox_record::Item::Group(GroupEnvelope { group: Some(group), ..Default::default() })),
        ..Default::default()
    }
}

#[test]
fn inbox_push_is_bound_to_origin_group_and_local_recipients() {
    let k = key(0xA1);
    let a = trusted(A, &k);
    let g = group_ref(A);
    let ok = request_bytes(&k, A, B, NOW, &push(g.clone(), &["bob@b.example"], envelope_of(g.clone())));
    assert!(verify(&ok, &a).is_ok());
    // Уведомление о записи журнала той же группы — тоже можно.
    let notice = InboxRecord {
        item: Some(inbox_record::Item::GroupState(GroupStateNotice { group: Some(g.clone()), ..Default::default() })),
        ..Default::default()
    };
    assert!(verify(&request_bytes(&k, A, B, NOW, &push(g.clone(), &["bob@b.example"], notice)), &a).is_ok());
    // Группа не сервера A.
    let foreign = group_ref("c.example");
    let bad = request_bytes(&k, A, B, NOW, &push(foreign.clone(), &["bob@b.example"], envelope_of(foreign)));
    assert_eq!(verify(&bad, &a).unwrap_err(), ProtoError::Forbidden);
    // Получатель не на B.
    let bad = request_bytes(&k, A, B, NOW, &push(g.clone(), &["eve@c.example"], envelope_of(g.clone())));
    assert_eq!(verify(&bad, &a).unwrap_err(), ProtoError::Forbidden);
    // Конверт другой группы под видом этой.
    let bad = request_bytes(&k, A, B, NOW, &push(g.clone(), &["bob@b.example"], envelope_of(group_ref(A).tap_id())));
    assert_eq!(verify(&bad, &a).unwrap_err(), ProtoError::Forbidden);
    // Серверные поля записи ставит получатель.
    let mut seq = envelope_of(g.clone());
    seq.seq = 9;
    assert!(verify(&request_bytes(&k, A, B, NOW, &push(g.clone(), &["bob@b.example"], seq)), &a).is_err());
    // Личное sealed-письмо этим путём не проходит.
    let sealed = InboxRecord { item: Some(inbox_record::Item::Sealed(SealedEnvelope::default())), ..Default::default() };
    assert_eq!(verify(&request_bytes(&k, A, B, NOW, &push(g, &["bob@b.example"], sealed)), &a).unwrap_err(), ProtoError::Forbidden);
}

trait TapId {
    fn tap_id(self) -> Ref;
}
impl TapId for Ref {
    fn tap_id(mut self) -> Ref {
        self.id = vec![6; 16];
        self
    }
}

#[test]
fn server_queries_are_scoped_by_domain() {
    let k = key(0xA1);
    let a = trusted(A, &k);
    let q = |kind| S2sRequest { kind: Some(kind) };
    assert!(verify(&request_bytes(&k, A, B, NOW, &q(s2s_request::Kind::KeyOwner(KeyOwnerRequest { ed25519: vec![1; 32] }))), &a).is_ok());
    assert!(verify(&request_bytes(&k, A, B, NOW, &q(s2s_request::Kind::KeyOwner(KeyOwnerRequest { ed25519: vec![1; 3] }))), &a).is_err());
    // Приватность спрашивают только о пользователях получателя.
    assert!(verify(&request_bytes(&k, A, B, NOW, &q(s2s_request::Kind::PrivacyOf(PrivacyOfRequest { user: "bob@b.example".into() }))), &a).is_ok());
    assert_eq!(
        verify(&request_bytes(&k, A, B, NOW, &q(s2s_request::Kind::PrivacyOf(PrivacyOfRequest { user: "eve@c.example".into() }))), &a).unwrap_err(),
        ProtoError::Forbidden
    );
    // Удалённым сервер A объявляет только своих.
    let gone = |u: &str| q(s2s_request::Kind::AccountGone(S2sAccountGone { user: Some(UserRef { address: u.into() }) }));
    assert!(verify(&request_bytes(&k, A, B, NOW, &gone("anya@a.example")), &a).is_ok());
    assert_eq!(verify(&request_bytes(&k, A, B, NOW, &gone("bob@b.example")), &a).unwrap_err(), ProtoError::Forbidden);
}

#[test]
fn response_is_bound_to_request_nonce_and_stream_order() {
    let kb = key(0xB2);
    let b = trusted(B, &kb);
    let nonce = federation::new_nonce();
    let payload = federation::response_payload(&nonce, Ok(vec![1, 2]));
    let resp = federation::sign_frame(&kb, B, A, NOW, federation::RESPONSE_TYPE, payload.clone()).unwrap().encode_to_vec();
    let r = federation::verify_response(&resp, &b, A, NOW, &nonce).unwrap();
    assert_eq!(r.result, Some(s2s_response::Result::Ok(vec![1, 2])));
    // Ответ на другой запрос не принимается.
    assert_eq!(federation::verify_response(&resp, &b, A, NOW, &federation::new_nonce()).unwrap_err(), ProtoError::ContextMismatch);
    // Подписан не B.
    let forged = federation::sign_frame(&key(0xEE), B, A, NOW, federation::RESPONSE_TYPE, payload).unwrap().encode_to_vec();
    assert!(federation::verify_response(&forged, &b, A, NOW, &nonce).is_err());
    // Ошибка несёт код.
    let err = federation::response_payload(&nonce, Err(federation::error_of(ErrorCode::DomainRefused, 0)));
    let err = federation::sign_frame(&kb, B, A, NOW, federation::RESPONSE_TYPE, err).unwrap().encode_to_vec();
    assert!(matches!(federation::verify_response(&err, &b, A, NOW, &nonce).unwrap().result, Some(s2s_response::Result::Error(e)) if e.code == ErrorCode::DomainRefused as i32));
    // Поток: строго по порядку.
    let chunk = |i: u32| {
        let c = S2sStreamChunk { request_nonce: nonce.clone(), index: i, last: i == 1, data: vec![i as u8; 4], error: None };
        federation::sign_frame(&kb, B, A, NOW, federation::STREAM_CHUNK_TYPE, c.encode_to_vec()).unwrap().encode_to_vec()
    };
    assert!(federation::verify_stream_chunk(&chunk(0), &b, A, NOW, &nonce, 0).is_ok());
    assert_eq!(federation::verify_stream_chunk(&chunk(1), &b, A, NOW, &nonce, 0).unwrap_err(), ProtoError::ContextMismatch);
}

#[test]
fn frame_reader_splits_the_response_stream() {
    let mut out = vec![];
    federation::frame_push(&mut out, b"first").unwrap();
    federation::frame_push(&mut out, b"second!").unwrap();
    let mut r = FrameReader::default();
    // Байты приходят кусками.
    for part in out.chunks(3) {
        r.push(part).unwrap();
    }
    assert_eq!(r.next_frame().unwrap(), Some(b"first".to_vec()));
    assert_eq!(r.next_frame().unwrap(), Some(b"second!".to_vec()));
    assert_eq!(r.next_frame().unwrap(), None);
    assert!(r.is_empty());
    // Заявленная длина сверх предела — отказ до буферизации.
    let mut r = FrameReader::default();
    assert!(r.push(&(u32::MAX).to_be_bytes()).is_err());
}

#[test]
fn digest_signing_matches_full_signing() {
    // identity подписывает по SHA-256 тела — кадр тот же, что при подписи целиком.
    let req = forward("msg.deliver_sealed", sealed_to("bob@b.example"), "", "").encode_to_vec();
    let nonce = federation::new_nonce();
    let digest = <sha2::Sha256 as sha2::Digest>::digest(&req).to_vec();
    let bytes = federation::frame_signing_bytes_digest(A, B, NOW, &nonce, federation::REQUEST_TYPE, &digest).unwrap();
    let full = federation::frame_signing_bytes(A, B, NOW, &nonce, federation::REQUEST_TYPE, &req).unwrap();
    assert_eq!(bytes, full);
}
