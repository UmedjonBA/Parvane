//! spec 035 T063 (FR-005): 20 000 строк чата, страницы по 50 в обе стороны, между страницами — вставки новых
//! строк (живые и старые) и удаления. Каждая строка, жившая всё время обхода, приходит ровно один раз; повторов
//! нет; удалённая до обхода её места — не приходит.

mod model_common;

use std::collections::{BTreeSet, HashMap};

use model_common::{call, Host};
use serde_json::{json, Value};

const N: u32 = 20_000;
const NOW: i64 = 1_800_000_000_000;

fn id(n: u32) -> String {
    let mut b = [0u8; 16];
    b[12..].copy_from_slice(&n.to_be_bytes());
    hex::encode(b)
}

fn b64id(n: u32) -> String {
    model_common::b64e(&hex::decode(id(n)).unwrap())
}

fn row(n: u32, ts: i64) -> Value {
    json!({"row": {"chat": "bob@local", "id": id(n), "from": "bob@local", "ts_ms": ts, "content": {"kind": "text", "text": format!("{n}")}}})
}

fn gone(n: u32) -> Value {
    json!({"gone": {"chat": "bob@local", "target": id(n), "ts_ms": NOW, "op_id": id(1_000_000 + n), "by": "bob@local"}})
}

fn setup() -> (parvane_protocol::model::Engine, Host) {
    let mut host = Host::default();
    let cfg = json!({"user": "alice@local", "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "vectors": true});
    let (mut e, _) = host.open(&cfg);
    // Старые строки — по времени отправителя (ORDER-1 п. 3), шаг 1000 мс
    let ops: Vec<Value> = (1..=N).map(|n| row(n, n as i64 * 1000)).collect();
    let out = call(&mut e, "vectorInput", &json!({"history": ops})).unwrap();
    host.drive(&mut e, out, true);
    (e, host)
}

fn walk(dir: &str) {
    let (mut e, mut host) = setup();
    let bob = json!({"user": {"address": "bob@local"}});
    let mut seen: HashMap<String, u32> = HashMap::new();
    let mut deleted: BTreeSet<String> = BTreeSet::new();
    let mut anchor = Value::Null;
    let mut page_no = 0u32;
    let mut extra = N;
    loop {
        let mut req = json!({"chat": bob, "direction": dir, "limit": 50});
        if !anchor.is_null() {
            req["anchor"] = anchor.clone();
        }
        let page = call(&mut e, "historyPage", &req).unwrap();
        let rows = page["rows"].as_array().cloned().unwrap_or_default();
        assert!(rows.len() <= 50);
        for r in &rows {
            let id = r["id"].as_str().unwrap().to_string();
            *seen.entry(id).or_default() += 1;
        }
        let more = if dir == "PAGE_DIRECTION_OLDER" { page["has_older"].as_bool().unwrap_or(false) } else { page["has_newer"].as_bool().unwrap_or(false) };
        if rows.is_empty() || !more {
            break;
        }
        anchor = if dir == "PAGE_DIRECTION_OLDER" { page["older"].clone() } else { page["newer"].clone() };
        page_no += 1;
        // Между страницами: живое сообщение, старая вставка в середину и удаления впереди и позади обхода
        extra += 1;
        let live = json!({"incoming": {"chat": bob, "from": "bob@local", "id": id(extra), "ts_ms": NOW, "content": {"text": {"text": "живое"}}}});
        let out = call(&mut e, "vectorInput", &live).unwrap();
        host.drive(&mut e, out, true);
        extra += 1;
        let old = row(extra, (page_no as i64 * 7919 % N as i64) * 1000 + 500);
        let out = call(&mut e, "vectorInput", &json!({"history": [old]})).unwrap();
        host.drive(&mut e, out, true);
        let victims = [(page_no * 131) % N + 1, (page_no * 977 + 5) % N + 1];
        let ops: Vec<Value> = victims.iter().map(|v| gone(*v)).collect();
        for v in victims {
            deleted.insert(b64id(v));
        }
        let out = call(&mut e, "vectorInput", &json!({"history": ops})).unwrap();
        host.drive(&mut e, out, true);
    }
    assert!(page_no > 300, "страниц {page_no}");
    let dups: Vec<_> = seen.iter().filter(|(_, c)| **c > 1).collect();
    assert!(dups.is_empty(), "повторы: {dups:?}");
    // Каждая исходная строка, не удалённая за обход, пришла
    let mut missing = vec![];
    for n in 1..=N {
        let k = b64id(n);
        if !deleted.contains(&k) && !seen.contains_key(&k) {
            missing.push(n);
        }
    }
    assert!(missing.is_empty(), "пропущено {} строк, первые {:?}", missing.len(), &missing[..missing.len().min(10)]);
}

#[test]
fn paging_older_without_gaps_or_repeats() {
    walk("PAGE_DIRECTION_OLDER");
}

#[test]
fn paging_newer_without_gaps_or_repeats() {
    walk("PAGE_DIRECTION_NEWER");
}
