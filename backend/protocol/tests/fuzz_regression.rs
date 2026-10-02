//! Fuzz-регрессия на стабильном тулчейне (spec 007, T108): те же четыре цели,
//! что в `fuzz/` (`frame_decode`, `envelope_open`, `group_state`, `legacy_v1`),
//! на детерминированных мутациях байтов из векторов `proto/parvane/vectors/`.
//! Инвариант один: никаких паник на недоверенном вводе. Бюджет времени на
//! цель — `PARVANE_FUZZ_SECS` (по умолчанию 3 с); настоящий libFuzzer
//! (`cargo +nightly fuzz run`) гоняет `scripts/run_all_tests.sh`, если он есть.

use std::time::{Duration, Instant};

use parvane_protocol::codec::{self, decode_checked};
use parvane_protocol::group::{self, SignerInfo};
use parvane_protocol::legacy_v1;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::frame::Kind;
use parvane_protocol::pb::parvane::core::v2::{DeviceRef, GroupEnvelope, GroupStateEntry, SealedEnvelope};
use parvane_protocol::seal;
use serde_json::Value;

mod common;

fn frame_decode(data: &[u8]) {
    for origin in [Origin::Client, Origin::Server] {
        if let Ok(f) = codec::decode_frame(data, origin) {
            if let Some(Kind::Request(r)) = f.kind {
                let _ = codec::check_request(&r, origin);
            }
        }
    }
    let mut d = codec::TcpDecoder::new();
    if d.push(data).is_ok() {
        while let Ok(Some(_)) = d.next_frame() {}
    }
}

fn envelope_open(data: &[u8]) {
    let me = DeviceRef { address: "bob@x".into(), device_id: "d1".into() };
    if let Ok(env) = decode_checked::<SealedEnvelope>(data, Origin::Client) {
        let _ = seal::open(&env, &me, &[7u8; 32]);
    }
    if let Ok(env) = decode_checked::<GroupEnvelope>(data, Origin::Client) {
        let _ = group::verify_envelope(&env, env.epoch, &[9u8; 32]);
        let _ = group::open_envelope(&env, &[1u8; 32]);
    }
}

fn group_state(data: &[u8]) {
    if let Ok(e) = decode_checked::<GroupStateEntry>(data, Origin::Client) {
        let resolve = |_: &[u8; 32]| Some(SignerInfo { user: "alice@x".into(), root_key: [1; 32] });
        let _ = group::apply(None, &e, &resolve);
    }
}

fn legacy(data: &[u8]) {
    let _ = legacy_v1::parse_stored(data);
    let _ = legacy_v1::parse_olm_plaintext(data);
    let _ = legacy_v1::parse_megolm_plaintext(data);
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = legacy_v1::normalize_ice(s);
    }
}

/// Все байтовые образцы из векторов: поля `*_hex` и строковые JSON-входы.
fn seeds() -> Vec<Vec<u8>> {
    fn walk(v: &Value, out: &mut Vec<Vec<u8>>) {
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    if let (true, Value::String(s)) = (k.ends_with("_hex"), x) {
                        if let Ok(b) = hex::decode(s) {
                            out.push(b);
                        }
                    }
                    if let (true, Value::String(s)) = (k == "stored" || k == "plaintext" || k == "json", x) {
                        out.push(s.as_bytes().to_vec());
                    }
                    walk(x, out);
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let mut out = vec![Vec::new(), vec![0u8], b"PVN2".to_vec(), b"{}".to_vec()];
    let root = common::vectors_dir("");
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "json") {
                if let Ok(v) = std::fs::read(&p).map(|b| serde_json::from_slice::<Value>(&b)) {
                    if let Ok(v) = v {
                        walk(&v, &mut out);
                    }
                }
            }
        }
    }
    out
}

/// xorshift64* — детерминированный генератор мутаций.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

fn mutate(rng: &mut Rng, seed: &[u8]) -> Vec<u8> {
    let mut d = seed.to_vec();
    for _ in 0..=rng.below(8) {
        match rng.below(6) {
            0 if !d.is_empty() => {
                let i = rng.below(d.len());
                d[i] ^= 1 << rng.below(8);
            }
            1 if !d.is_empty() => {
                let i = rng.below(d.len());
                d[i] = rng.next() as u8;
            }
            2 => {
                let i = rng.below(d.len() + 1);
                d.insert(i, rng.next() as u8);
            }
            3 if !d.is_empty() => {
                let i = rng.below(d.len());
                d.remove(i);
            }
            4 if !d.is_empty() => {
                let cut = rng.below(d.len());
                d.truncate(cut);
            }
            _ => {
                // Большие varint-длины и повторы — классика protobuf-парсеров.
                let i = rng.below(d.len() + 1);
                let chunk = [0xff, 0xff, 0xff, 0xff, 0x0f];
                d.splice(i..i, chunk);
            }
        }
    }
    d
}

fn budget() -> Duration {
    let secs = std::env::var("PARVANE_FUZZ_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(3u64);
    Duration::from_secs(secs)
}

fn run(target: fn(&[u8]), salt: u64) {
    let seeds = seeds();
    assert!(seeds.len() > 10, "векторы не найдены");
    for s in &seeds {
        target(s);
    }
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ salt);
    let deadline = Instant::now() + budget();
    let mut n = 0u64;
    while Instant::now() < deadline {
        let seed = &seeds[rng.below(seeds.len())];
        target(&mutate(&mut rng, seed));
        n += 1;
    }
    assert!(n > 0);
}

#[test]
fn fuzz_frame_decode() {
    run(frame_decode, 1);
}

#[test]
fn fuzz_envelope_open() {
    run(envelope_open, 2);
}

#[test]
fn fuzz_group_state() {
    run(group_state, 3);
}

#[test]
fn fuzz_legacy_v1() {
    run(legacy, 4);
}
