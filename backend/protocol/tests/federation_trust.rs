//! Доверие между серверами (T104, US7, R12/FR-051): S2S-кадр проверяется по
//! опубликованному описателю сервера-отправителя, и доверие ограничено его
//! доменом.

use ed25519_dalek::SigningKey;
use parvane_protocol::error::ProtoError;
use parvane_protocol::federation::{self, TrustedServer, MAX_SKEW_MS};
use parvane_protocol::pb::parvane::core::v2::{DeviceRef, Ref, S2sFrame, SealedEnvelope, ServerDescriptor, SignedServerDescriptor, UserRef};
use parvane_protocol::pb::parvane::msg::v2::DeliverSealedRequest;
use parvane_protocol::sign::{self, ctx, ReplayGuard};
use prost::{Message, Name};

const A: &str = "a.example";
const B: &str = "b.example";
const NOW: i64 = 1_790_000_000_000;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn descriptor_of(domain: &str, server_key: &SigningKey, signer: &SigningKey) -> SignedServerDescriptor {
    let d = ServerDescriptor {
        domain: domain.into(),
        server_key: server_key.verifying_key().to_bytes().to_vec(),
        proto_major: parvane_protocol::PROTO_MAJOR,
        proto_minor: parvane_protocol::PROTO_MINOR,
        features: vec!["sealed".into()],
        endpoints: vec![format!("https://{domain}/ws")],
        issued_ms: NOW,
    };
    let bytes = d.encode_to_vec();
    SignedServerDescriptor { signature: sign::sign_ctx(signer, ctx::SERVER_DESCRIPTOR, &[&bytes]), descriptor: bytes }
}

fn server_a() -> (SigningKey, TrustedServer) {
    let k = key(0xA1);
    let t = federation::verify_descriptor(&descriptor_of(A, &k, &k), A, None).unwrap();
    (k, t)
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

fn frame(k: &SigningKey, origin: &str, dest: &str, issued: i64) -> S2sFrame {
    federation::sign_frame(k, origin, dest, issued, &DeliverSealedRequest::full_name(), sealed_to("bob@b.example")).unwrap()
}

#[test]
fn descriptor_is_checked_by_own_key_and_domain() {
    let k = key(0xA1);
    let t = federation::verify_descriptor(&descriptor_of(A, &k, &k), A, None).unwrap();
    assert_eq!(t.domain, A);
    assert_eq!(t.server_key, k.verifying_key().to_bytes());

    // Подпись не тем ключом, что в описателе.
    let other = key(0xEE);
    assert_eq!(federation::verify_descriptor(&descriptor_of(A, &k, &other), A, None).err(), Some(ProtoError::BadSignature));
    // Описатель другого домена под видом A.
    assert_eq!(federation::verify_descriptor(&descriptor_of(B, &k, &k), A, None).err(), Some(ProtoError::ContextMismatch));
    // Испорченные байты описателя.
    let mut bad = descriptor_of(A, &k, &k);
    let last = bad.descriptor.len() - 1;
    bad.descriptor[last] ^= 1;
    assert!(federation::verify_descriptor(&bad, A, None).is_err());
    // Закреплённый ключ домена: подмена описателя с новым ключом замечается.
    let pin = key(0x55).verifying_key().to_bytes();
    assert_eq!(federation::verify_descriptor(&descriptor_of(A, &k, &k), A, Some(&pin)).err(), Some(ProtoError::RootMismatch));
    let pin = k.verifying_key().to_bytes();
    assert!(federation::verify_descriptor(&descriptor_of(A, &k, &k), A, Some(&pin)).is_ok());
    // Невалидный ожидаемый домен.
    assert_eq!(federation::verify_descriptor(&descriptor_of(A, &k, &k), "a*", None).err(), Some(ProtoError::BadAddress));
}

#[test]
fn valid_frame_is_accepted_and_payload_stays_opaque() {
    let (k, a) = server_a();
    let f = frame(&k, A, B, NOW);
    let v = federation::verify_frame(&f.encode_to_vec(), &a, B, NOW + 1000, None).unwrap();
    assert_eq!(v.origin_domain, A);
    assert_eq!(v.dest_domain, B);
    let r: DeliverSealedRequest = v.payload_as().unwrap();
    assert_eq!(r.envelopes[0].ciphertext, vec![1, 2, 3], "содержимое — тот же шифртекст");
    // Тип полезной нагрузки связан подписью: другой тип не разбирается.
    assert_eq!(v.payload_as::<ServerDescriptor>().err(), Some(ProtoError::ContextMismatch));
}

#[test]
fn frame_signed_by_other_server_is_rejected() {
    let (_, a) = server_a();
    // Сервер C подписывает кадр, выдавая себя за A.
    let c = key(0xC3);
    let f = frame(&c, A, B, NOW);
    assert_eq!(federation::verify_frame(&f.encode_to_vec(), &a, B, NOW, None).err(), Some(ProtoError::BadSignature));
}

#[test]
fn origin_must_match_descriptor_domain() {
    let (k, a) = server_a();
    // Ключ A, но кадр объявлен от имени другого домена.
    let f = frame(&k, "c.example", B, NOW);
    assert_eq!(federation::verify_frame(&f.encode_to_vec(), &a, B, NOW, None).err(), Some(ProtoError::ContextMismatch));
}

#[test]
fn frame_for_other_destination_is_rejected() {
    let (k, a) = server_a();
    let f = frame(&k, A, "c.example", NOW);
    assert_eq!(federation::verify_frame(&f.encode_to_vec(), &a, B, NOW, None).err(), Some(ProtoError::ContextMismatch));
}

#[test]
fn tampered_fields_break_signature() {
    let (k, a) = server_a();
    let base = frame(&k, A, B, NOW);
    let mut cases: Vec<S2sFrame> = Vec::new();
    let mut f = base.clone();
    f.payload.push(0);
    cases.push(f);
    let mut f = base.clone();
    f.issued_ms += 1;
    cases.push(f);
    let mut f = base.clone();
    f.nonce[0] ^= 1;
    cases.push(f);
    let mut f = base.clone();
    f.payload_type = "parvane.msg.v2.DeliverGroupRequest".into();
    cases.push(f);
    let mut f = base.clone();
    f.dest_domain = "B.example".into();
    cases.push(f);
    for (i, f) in cases.iter().enumerate() {
        assert_eq!(federation::verify_frame(&f.encode_to_vec(), &a, B, NOW, None).err(), Some(ProtoError::BadSignature), "случай {i}");
    }
    // Подпись под контекстом описателя не проходит как подпись кадра.
    let mut f = base.clone();
    let fields = federation::frame_signing_bytes(A, B, f.issued_ms, &f.nonce, &f.payload_type, &f.payload).unwrap();
    f.signature = sign::sign_ctx(&k, ctx::SERVER_DESCRIPTOR, &[&fields[ctx::S2S_FRAME.len()..]]);
    assert_eq!(federation::verify_frame(&f.encode_to_vec(), &a, B, NOW, None).err(), Some(ProtoError::BadSignature));
}

#[test]
fn stale_or_future_frame_is_rejected() {
    let (k, a) = server_a();
    let f = frame(&k, A, B, NOW - MAX_SKEW_MS - 1).encode_to_vec();
    assert_eq!(federation::verify_frame(&f, &a, B, NOW, None).err(), Some(ProtoError::Expired));
    let f = frame(&k, A, B, NOW + MAX_SKEW_MS + 1).encode_to_vec();
    assert_eq!(federation::verify_frame(&f, &a, B, NOW, None).err(), Some(ProtoError::Expired));
    let f = frame(&k, A, B, i64::MIN).encode_to_vec();
    assert_eq!(federation::verify_frame(&f, &a, B, i64::MAX, None).err(), Some(ProtoError::Expired));
    let f = frame(&k, A, B, NOW - MAX_SKEW_MS).encode_to_vec();
    assert!(federation::verify_frame(&f, &a, B, NOW, None).is_ok());
}

#[test]
fn replayed_frame_is_rejected() {
    let (k, a) = server_a();
    let f = frame(&k, A, B, NOW).encode_to_vec();
    let mut g = ReplayGuard::new(1024);
    assert!(federation::verify_frame(&f, &a, B, NOW, Some(&mut g)).is_ok());
    assert_eq!(federation::verify_frame(&f, &a, B, NOW, Some(&mut g)).err(), Some(ProtoError::Duplicate));
}

#[test]
fn malformed_frames_are_rejected_without_panic() {
    let (k, a) = server_a();
    for bytes in [vec![0xff; 10], vec![], vec![0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]] {
        assert!(federation::verify_frame(&bytes, &a, B, NOW, None).is_err());
    }
    let mut f = frame(&k, A, B, NOW);
    f.nonce.truncate(8);
    assert!(federation::verify_frame(&f.encode_to_vec(), &a, B, NOW, None).is_err());
    let mut f = frame(&k, A, B, NOW);
    f.signature.truncate(10);
    assert_eq!(federation::verify_frame(&f.encode_to_vec(), &a, B, NOW, None).err(), Some(ProtoError::BadSignature));
    // Лимит схемы: слишком длинный домен отвергается до разбора.
    let mut f = frame(&k, A, B, NOW);
    f.origin_domain = "a".repeat(200);
    assert!(federation::verify_frame(&f.encode_to_vec(), &a, B, NOW, None).is_err());
}

#[test]
fn trust_is_limited_to_origin_domain() {
    let (k, a) = server_a();
    let v = federation::verify_frame(&frame(&k, A, B, NOW).encode_to_vec(), &a, B, NOW, None).unwrap();
    // Свои пользователи/устройства/объекты A — принимаются.
    assert!(v.require_origin_address("alice@a.example").is_ok());
    assert!(v.require_origin_address("alice@A.example").is_ok());
    assert!(v.require_origin_user(&UserRef { address: "alice@a.example".into() }).is_ok());
    assert!(v.require_origin_device(&DeviceRef { address: "alice@a.example".into(), device_id: "d1".into() }).is_ok());
    assert!(v.require_origin_ref(&Ref { domain: A.into(), id: vec![9; 16] }).is_ok());
    assert!(v.require_origin_addresses(["alice@a.example", "carol@a.example"]).is_ok());
    // A не вправе говорить за пользователей B (получателя) и третьих доменов.
    assert_eq!(v.require_origin_address("bob@b.example").err(), Some(ProtoError::Forbidden));
    assert_eq!(v.require_origin_address("eve@c.example").err(), Some(ProtoError::Forbidden));
    assert_eq!(v.require_origin_address("alice@a.example.evil").err(), Some(ProtoError::Forbidden));
    assert_eq!(v.require_origin_addresses(["alice@a.example", "bob@b.example"]).err(), Some(ProtoError::Forbidden));
    assert_eq!(v.require_origin_user(&UserRef { address: "bob@b.example".into() }).err(), Some(ProtoError::Forbidden));
    assert_eq!(
        v.require_origin_device(&DeviceRef { address: "bob@b.example".into(), device_id: "d1".into() }).err(),
        Some(ProtoError::Forbidden)
    );
    assert_eq!(v.require_origin_ref(&Ref { domain: B.into(), id: vec![9; 16] }).err(), Some(ProtoError::Forbidden));
    // Кривые адреса — BadAddress, а не «чужой домен».
    assert_eq!(v.require_origin_address("alice").err(), Some(ProtoError::BadAddress));
    assert_eq!(v.require_origin_ref(&Ref { domain: A.into(), id: vec![9; 15] }).err(), Some(ProtoError::BadAddress));
}
