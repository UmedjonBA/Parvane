//! Векторы кодека и лимитов (T019, класс 12): `proto/parvane/vectors/codec/`.

mod common;

use common::*;
use parvane_protocol::codec::{self, MAX_FRAME};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    frame, sealed_envelope, AuthOk, DeviceRef, Frame, Hello, Request, SealedEnvelope, StreamChunk, Welcome,
};
use parvane_protocol::pb::parvane::msg::v2::{DeliverSealedRequest, InboxHideRequest};
use prost::Message;
use serde_json::{json, Value};

fn fr(kind: frame::Kind) -> Vec<u8> {
    Frame { proto_major: 2, kind: Some(kind) }.encode_to_vec()
}

fn frame_case(name: &str, origin: &str, bytes: &[u8], expect: Value) -> Value {
    json!({"name": name, "input": {"kind": "frame", "origin": origin, "frame_hex": hexs(bytes)}, "expect": expect})
}

/// Синтетический кадр: `stream_chunk` — StreamChunk{id:1,index:0,last:true,data:нули(len)};
/// `raw_zeros` — len нулевых байт.
fn synthetic_case(name: &str, origin: &str, what: &str, len: usize, expect: Value) -> Value {
    json!({"name": name, "input": {"kind": "synthetic", "origin": origin, "what": what, "len": len}, "expect": expect})
}

fn synthetic(what: &str, len: usize) -> Vec<u8> {
    match what {
        "stream_chunk" => fr(frame::Kind::StreamChunk(StreamChunk { id: 1, index: 0, last: true, data: vec![0; len], error: None })),
        "raw_zeros" => vec![0; len],
        w => panic!("синтетика {w}"),
    }
}

fn request_case(name: &str, method: &str, body: &[u8], expect: Value) -> Value {
    json!({"name": name, "input": {"kind": "request", "method": method, "body_hex": hexs(body)}, "expect": expect})
}

fn generate() -> Value {
    let mut c = vec![
        frame_case("hello", "client", &fr(frame::Kind::Hello(Hello { proto_minor: 0, features: vec!["x".into()], ..Default::default() })), ok()),
        frame_case("welcome-from-client", "client", &fr(frame::Kind::Welcome(Welcome::default())), err("WrongDirection")),
        frame_case("hello-from-server", "server", &fr(frame::Kind::Hello(Hello::default())), err("WrongDirection")),
        frame_case(
            "major-3",
            "client",
            &Frame { proto_major: 3, kind: Some(frame::Kind::Hello(Hello::default())) }.encode_to_vec(),
            err("UnsupportedMajor"),
        ),
        frame_case(
            "method-97",
            "client",
            &fr(frame::Kind::Request(Request { id: 1, method: "m".repeat(97), ..Default::default() })),
            err("FieldLimit"),
        ),
        frame_case(
            "features-65",
            "client",
            &fr(frame::Kind::Hello(Hello { features: vec!["a".into(); 65], ..Default::default() })),
            err("FieldLimit"),
        ),
        frame_case(
            "feature-65-bytes",
            "client",
            &fr(frame::Kind::Hello(Hello { features: vec!["a".repeat(65)], ..Default::default() })),
            err("FieldLimit"),
        ),
        frame_case(
            "authok-from-client",
            "client",
            &fr(frame::Kind::AuthOk(AuthOk { user: "a@b".into(), device_id: String::new() })),
            err("ServerSetField"),
        ),
        frame_case("authok-from-server", "server", &fr(frame::Kind::AuthOk(AuthOk { user: "a@b".into(), device_id: "d".into() })), ok()),
        frame_case("duplicate-singular", "client", &[0x08, 0x02, 0x08, 0x02], err("DuplicateField")),
        frame_case("group-wire-type", "client", &[0x0b], err("Malformed")),
        frame_case("truncated", "client", &[0x52, 0x05, 0x01], err("Malformed")),
        frame_case("bad-utf8", "client", &[0xa2, 0x01, 0x03, 0x12, 0x01, 0xff], err("InvalidField")),
        frame_case("unknown-field-skipped", "client", &[0x08, 0x02, 0x62, 0x00, 0xf8, 0x3e, 0x01], ok()),
        // Большие кадры — синтетически (обвязки собирают их сами).
        synthetic_case("stream-chunk-716801", "server", "stream_chunk", 716_801, err("FieldLimit")),
        synthetic_case("stream-chunk-716800", "server", "stream_chunk", 716_800, ok()),
        synthetic_case("frame-over-4mib", "client", "raw_zeros", MAX_FRAME + 1, err("FrameTooLarge")),
    ];

    c.push(request_case("sync-empty", "msg.inbox.sync", &[], ok()));
    c.push(request_case("v1-topic-rejected", "msg.chat.send", &[], err("UnknownMethod")));
    c.push(request_case(
        "hide-501",
        "msg.inbox.hide",
        &InboxHideRequest { seqs: (0..501).collect() }.encode_to_vec(),
        err("FieldLimit"),
    ));
    let env = |i: u32| SealedEnvelope {
        recipient: Some(DeviceRef { address: "bob@x".into(), device_id: format!("d{i}") }),
        access: Some(sealed_envelope::Access::DeliveryKey(vec![1; 32])),
        hpke_enc: vec![2; 32],
        ciphertext: vec![3; 16],
    };
    c.push(request_case(
        "deliver-64-copies",
        "msg.deliver_sealed",
        &DeliverSealedRequest { envelopes: (0..64).map(env).collect() }.encode_to_vec(),
        ok(),
    ));
    c.push(request_case(
        "deliver-65-copies",
        "msg.deliver_sealed",
        &DeliverSealedRequest { envelopes: (0..65).map(env).collect() }.encode_to_vec(),
        err("FieldLimit"),
    ));
    // Класс 17: v1-JSON в теле v2-метода доставки — не конверт.
    c.push(request_case(
        "v1-plaintext-in-v2",
        "msg.deliver_sealed",
        br#"{"kind":"text","text":"hi"}"#,
        err("Malformed"),
    ));
    json!({"suite": "codec", "description": "кадры и тела запросов: размер, лимиты схемы, акторы, направление, версия, реестр", "cases": c})
}

#[test]
fn codec_vectors() {
    let v = load_or_generate("codec", "frames.json", generate);
    assert!(cases(&v).len() >= 20);
    for case in cases(&v) {
        let name = case["name"].as_str().unwrap();
        let input = &case["input"];
        match input["kind"].as_str().unwrap() {
            "frame" => {
                let origin = if input["origin"] == "client" { Origin::Client } else { Origin::Server };
                let got = codec::decode_frame(&unhex(input, "frame_hex"), origin);
                check(name, &got, &case["expect"]);
            }
            "synthetic" => {
                let origin = if input["origin"] == "client" { Origin::Client } else { Origin::Server };
                let bytes = synthetic(input["what"].as_str().unwrap(), input["len"].as_u64().unwrap() as usize);
                check(name, &codec::decode_frame(&bytes, origin), &case["expect"]);
            }
            "request" => {
                let req = Request { id: 1, method: input["method"].as_str().unwrap().into(), body: unhex(input, "body_hex"), timeout_ms: 1000 };
                check(name, &codec::check_request(&req, Origin::Client), &case["expect"]);
            }
            k => panic!("неизвестный вид {k}"),
        }
    }
}
