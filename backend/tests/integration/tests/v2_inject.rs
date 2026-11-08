//! T041: тестовый инжектор v2 для сценария `scripts/e2e_protocol_unknown_kinds.mjs`.
//! v2-отправитель шлёт адресату N sealed-сообщений с НЕИЗВЕСТНЫМ видом
//! `Content` (поле с номером, которого нет в content.proto) и затем одно
//! обычное текстовое. Стек поднимает раннер; инжектор только подключается.
//!
//! Запуск (из backend/):
//!   PARVANE_INJECT_GATEWAY_TCP=127.0.0.1:PORT PARVANE_INJECT_FROM=inj@local \
//!   PARVANE_INJECT_TO=web@local PARVANE_INJECT_TEXT=... \
//!   cargo test -p parvane-integration --test v2_inject -- --ignored --nocapture
//!
//! Необязательно: PARVANE_INJECT_COUNT (по умолчанию 10), PARVANE_INJECT_CRITICAL — ещё столько сообщений вида из
//! критичного диапазона 1000–1999 (spec 035 FR-041: получатель показывает «обновите приложение», по умолчанию 0).

mod v2common;

use parvane_protocol::pb::parvane::msg::v2::{content, Content, Text};
use v2common::Device;

/// Номер поля `Content`, которого нет в content.proto (вид из будущей версии).
const UNKNOWN_FIELD: u32 = 50;

/// Номер вида `Content` из критичного диапазона (spec 035, FR-041), которого нет в схеме.
const CRITICAL_FIELD: u32 = 1500;

/// `Content` с единственным неизвестным полем (length-delimited, полезная нагрузка `payload`).
fn unknown_kind_bytes(payload: &[u8]) -> Vec<u8> {
    field_bytes(UNKNOWN_FIELD, payload)
}

fn field_bytes(field: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    prost::encoding::encode_key(field, prost::encoding::WireType::LengthDelimited, &mut out);
    prost::encoding::encode_varint(payload.len() as u64, &mut out);
    out.extend_from_slice(payload);
    out
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("нет переменной {name}"))
}

#[test]
#[ignore = "инжектор для scripts/e2e_protocol_unknown_kinds.mjs (нужен живой стек)"]
fn inject_unknown_kinds() {
    let addr = env("PARVANE_INJECT_GATEWAY_TCP");
    let from = env("PARVANE_INJECT_FROM");
    let to = env("PARVANE_INJECT_TO");
    let text = env("PARVANE_INJECT_TEXT");
    let count: usize = std::env::var("PARVANE_INJECT_COUNT").ok().and_then(|v| v.parse().ok()).unwrap_or(10);

    // Самопроверка: байты действительно дают «неизвестный вид» в движке.
    let probe = <Content as prost::Message>::decode(unknown_kind_bytes(b"future").as_slice()).unwrap();
    assert!(probe.kind.is_none(), "поле {UNKNOWN_FIELD} известно схеме — выберите другой номер");

    let critical: usize = std::env::var("PARVANE_INJECT_CRITICAL").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let crit_probe = field_bytes(CRITICAL_FIELD, b"future");
    assert!(
        critical == 0 || parvane_protocol::unknown::scan("parvane.msg.v2.Content", &crit_probe).map(|r| r.has_critical()).unwrap_or(false),
        "поле {CRITICAL_FIELD} — не критичный вид"
    );

    let mut d = Device::register(&addr, &from, "inj1");
    // Ключа доступа адресата у инжектора нет — доставка слепыми жетонами.
    d.fetch_tokens(count + critical + 5);
    for i in 0..count {
        let bytes = unknown_kind_bytes(format!("future-kind-{i}").as_bytes());
        d.op(&mut |c| c.prepare_direct_raw(&to, &bytes)).unwrap_or_else(|e| panic!("неизвестный вид #{i}: {e}"));
        eprintln!("INJECT unknown #{i} → {to}");
    }
    for i in 0..critical {
        let bytes = field_bytes(CRITICAL_FIELD, format!("future-critical-{i}").as_bytes());
        d.op(&mut |c| c.prepare_direct_raw(&to, &bytes)).unwrap_or_else(|e| panic!("критичный вид #{i}: {e}"));
        eprintln!("INJECT critical #{i} → {to}");
    }
    let c = Content { kind: Some(content::Kind::Text(Text { text: text.clone(), ..Default::default() })), ..Default::default() };
    d.op(&mut |cl| cl.prepare_direct(&to, &c)).unwrap_or_else(|e| panic!("текст: {e}"));
    eprintln!("INJECT text «{text}» → {to}");
    println!("INJECT OK {count}+{critical}+1 from={from}");
}
