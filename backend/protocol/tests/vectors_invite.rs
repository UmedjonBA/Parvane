//! Векторы ссылок-приглашений (T084): `proto/parvane/vectors/invite/links.json`.
//! Клиенты сверяют по ним сборку и разбор ссылки (один формат во всех).

use parvane_protocol::invite::{self, ParsedInvite};
use serde_json::{json, Value};

mod common;

fn generate() -> Value {
    let mut cases = Vec::new();
    for (i, domain) in ["parvane.example", "local", "chat.example.org"].iter().enumerate() {
        let seed = [i as u8 + 1; 32];
        let parts = invite::from_seed(domain, &seed).expect("части");
        let url = invite::format(&parts).expect("url");
        cases.push(json!({
            "name": format!("v2-{domain}"),
            "input": { "url": url, "seed_hex": common::hexs(&seed), "domain": domain },
            "expect": { "ok": true, "result": { "kind": "v2", "domain": domain, "link_id_hex": common::hexs(&parts.link_id) } },
        }));
    }
    for (name, url, token) in [
        ("legacy-web-hash", "https://parvane.example/#+AbC-12_x", "AbC-12_x"),
        ("legacy-desktop", "https://parvane.invite/tok123", "tok123"),
    ] {
        cases.push(json!({ "name": name, "input": { "url": url }, "expect": { "ok": true, "result": { "kind": "legacy_v1", "token": token } } }));
    }
    for (name, url) in [
        ("no-secret", "https://parvane.example/join/AAAA"),
        ("http", "http://parvane.example/join/AAAA#BBBB"),
        ("bad-legacy", "https://x/#+bad token"),
    ] {
        cases.push(json!({ "name": name, "input": { "url": url }, "expect": { "error": "InvalidField" } }));
    }
    json!({ "cases": cases })
}

#[test]
fn invite_links() {
    let v = common::load_or_generate("invite", "links.json", generate);
    for case in common::cases(&v) {
        let name = case["name"].as_str().unwrap_or("?");
        let url = case["input"]["url"].as_str().unwrap_or("");
        let got = invite::parse(url);
        match (&got, case["expect"]["ok"].as_bool()) {
            (Ok(ParsedInvite::V2(p)), Some(true)) => {
                assert_eq!(case["expect"]["result"]["kind"], "v2", "{name}");
                assert_eq!(p.domain, case["expect"]["result"]["domain"].as_str().unwrap_or(""), "{name}");
                assert_eq!(common::hexs(&p.link_id), case["expect"]["result"]["link_id_hex"].as_str().unwrap_or(""), "{name}");
                assert_eq!(common::hexs(&p.seed), case["input"]["seed_hex"].as_str().unwrap_or(""), "{name}");
                assert_eq!(invite::format(p).ok().as_deref(), Some(url), "{name}: сборка");
            }
            (Ok(ParsedInvite::LegacyV1 { token }), Some(true)) => {
                assert_eq!(case["expect"]["result"]["kind"], "legacy_v1", "{name}");
                assert_eq!(token, case["expect"]["result"]["token"].as_str().unwrap_or(""), "{name}");
            }
            (Err(e), None) => assert_eq!(e.kind(), case["expect"]["error"].as_str().unwrap_or(""), "{name}"),
            other => panic!("{name}: {other:?}"),
        }
    }
}
