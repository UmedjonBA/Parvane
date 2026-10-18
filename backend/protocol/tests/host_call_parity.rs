//! Сторож паритета нативных хостов с web (spec 029, FR-003): каждая функция, которую WASM-обвязка отдаёт
//! web, доступна desktop/android через единую точку входа (`HostClient::call`, `HostState::call`,
//! `call_static`) под тем же именем — либо записана в `NOT_ROUTED` с причиной.

use parvane_protocol::host::call::{call_static, NOT_ROUTED};
use parvane_protocol::host::HostClient;
use serde_json::json;

/// Экспортируемые имена WASM-обвязки: `pub fn` с атрибутом `#[wasm_bindgen…]` либо внутри блока
/// `#[wasm_bindgen] impl`; имя — `js_name`, иначе имя функции; конструктор — `new`, `(start)` — `start`.
fn wasm_exports() -> Vec<String> {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/wasm/src/lib.rs")).expect("wasm/src/lib.rs");
    let ident = |s: &str| -> String { s.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect() };
    let mut out = Vec::new();
    let (mut depth, mut impl_depth): (i32, Option<i32>) = (0, None);
    let mut pending_attr: Option<String> = None;
    let mut bindgen_next_impl = false;
    for l in src.lines() {
        let t = l.trim();
        if t.starts_with("#[cfg(test)]") {
            break;
        }
        if t.starts_with("#[wasm_bindgen") {
            pending_attr = Some(t.to_string());
        } else if t.starts_with("impl ") && pending_attr.take().is_some() {
            bindgen_next_impl = true;
        } else if let Some(rest) = t.strip_prefix("pub fn ") {
            let attr = pending_attr.take();
            if attr.is_some() || impl_depth.is_some_and(|d| d == depth - 1) {
                let a = attr.unwrap_or_default();
                let name = if a.contains("constructor") {
                    "new".to_string()
                } else if a.contains("(start)") {
                    "start".to_string()
                } else if let Some(p) = a.find("js_name = ") {
                    ident(&a[p + "js_name = ".len()..])
                } else {
                    ident(rest)
                };
                out.push(name);
            }
        } else if !t.starts_with("///") && !t.starts_with("//") && !t.is_empty() && !t.starts_with("#[") {
            pending_attr = None;
        }
        for ch in l.chars() {
            match ch {
                '{' => {
                    if bindgen_next_impl {
                        impl_depth = Some(depth);
                        bindgen_next_impl = false;
                    }
                    depth += 1;
                }
                '}' => {
                    depth -= 1;
                    if impl_depth == Some(depth) {
                        impl_depth = None;
                    }
                }
                _ => {}
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[test]
fn every_wasm_export_is_reachable_from_native_hosts() {
    let names = wasm_exports();
    assert!(names.len() > 150, "разбор wasm/src/lib.rs сломан: {} имён", names.len());
    let mut client = HostClient::new("alice@local", "d1", "local").unwrap();
    assert!(client.ensure_state_key());
    let mut state = client.state_session().unwrap();
    let unknown = |r: &Result<serde_json::Value, String>| matches!(r, Err(e) if e.contains("UnknownCall"));
    let mut missing = Vec::new();
    for n in &names {
        if NOT_ROUTED.iter().any(|(x, _)| x == n) {
            continue;
        }
        // Вызов с пустыми аргументами: ошибка аргументов — значит, имя известно
        if !unknown(&client.call(n, &json!({}))) || !unknown(&state.call(n, &json!({}))) {
            continue;
        }
        missing.push(n.clone());
    }
    assert!(missing.is_empty(), "нет в единой точке входа ({}): {missing:?}", missing.len());
    // Исключения — только реальные имена WASM
    for (n, why) in NOT_ROUTED {
        assert!(names.iter().any(|x| x == n), "исключение {n} ({why}) — нет в WASM");
    }
}

#[test]
fn static_calls_roundtrip() {
    let v = call_static("protoMajor", &json!({})).unwrap();
    assert_eq!(v, json!(parvane_protocol::PROTO_MAJOR));
    // Запрос с доменом адресата (FED-1) — кадр с dest_domain
    let f = call_static("encodeRequest", &json!({"id": 7, "method": "msg.deliver_sealed", "body": "", "timeoutMs": 5000, "destDomain": "b.example"})).unwrap();
    let bytes = parvane_protocol::host::from_b64(f.as_str().unwrap()).unwrap();
    let frame = parvane_protocol::codec::decode_frame(&bytes, parvane_protocol::limits::Origin::Client).unwrap();
    match frame.kind {
        Some(parvane_protocol::pb::parvane::core::v2::frame::Kind::Request(r)) => {
            assert_eq!((r.id, r.method.as_str(), r.dest_domain.as_str()), (7, "msg.deliver_sealed", "b.example"));
        }
        other => panic!("{other:?}"),
    }
    assert!(call_static("nope", &json!({})).unwrap_err().contains("UnknownCall"));
}

#[test]
fn client_calls_match_wasm_semantics() {
    let mut c = HostClient::new("alice@local", "d1", "local").unwrap();
    // Корень остаётся в памяти после createIdentity — как у WASM
    let out = c.call("createIdentity", &json!({"otkCount": 2})).unwrap();
    assert!(out["requests"].as_array().is_some_and(|r| !r.is_empty()));
    assert_eq!(c.call("hasRoot", &json!({})).unwrap(), json!(true));
    let key = call_static("generateRecoveryKey", &json!({})).unwrap();
    let backup = c.call("exportRootBackup", &json!({"recoveryKey": key})).unwrap();
    assert!(backup.as_str().is_some_and(|s| !s.is_empty()));
    c.call("forgetRoot", &json!({})).unwrap();
    assert_eq!(c.call("hasRoot", &json!({})).unwrap(), json!(false));
    assert!(c.call("exportRootBackup", &json!({"recoveryKey": key})).is_err(), "без корня копии нет");
    // Доказательство сессии — 64 байта
    let p = c.call("sessionProof", &json!({"tsMs": 1_700_000_000_000_i64})).unwrap();
    assert_eq!(parvane_protocol::host::from_b64(p.as_str().unwrap()).unwrap().len(), 64);
    // Ошибка аргумента — не UnknownCall
    let e = c.call("groupInfo", &json!({})).unwrap_err();
    assert!(!e.contains("UnknownCall"), "{e}");
    assert_eq!(c.call("selfAddress", &json!({})).unwrap(), json!("alice@local"));
    // JSON-текст аргументом — строкой или объектом
    let chats = c.call("ephSubscribe", &json!({"chatsJson": {"peers": [], "groups": []}})).unwrap();
    assert_eq!(chats, json!([]));
}

/// Таблицы типов `encodeMessage`/`decodeMessage` нативных хостов — те же, что у WASM (иначе desktop не
/// разбирал ответ смены ника, найдено живым тестом 18 окт 2026).
#[test]
fn message_type_tables_match_wasm() {
    fn tables(src: &str) -> (Vec<String>, Vec<String>) {
        let grab = |from: &str| -> Vec<String> {
            let start = src.find(from).expect(from);
            let body = &src[start..];
            let body = &body[..body.find("\n}\n").expect("конец функции")];
            let mut out: Vec<String> = body
                .split('"')
                .filter(|t| t.starts_with("parvane.") && !t.contains(' '))
                .map(str::to_string)
                .collect();
            out.sort();
            out.dedup();
            out
        };
        (grab("pub fn encode_message"), grab("pub fn decode_message"))
    }
    let wasm = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/wasm/src/lib.rs")).unwrap();
    let host = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/host.rs")).unwrap();
    let (we, wd) = tables(&wasm);
    let (he, hd) = tables(&host);
    let missing = |a: &[String], b: &[String]| a.iter().filter(|x| !b.contains(x)).cloned().collect::<Vec<_>>();
    assert!(missing(&we, &he).is_empty(), "encodeMessage: нет у хоста {:?}", missing(&we, &he));
    assert!(missing(&wd, &hd).is_empty(), "decodeMessage: нет у хоста {:?}", missing(&wd, &hd));
}
