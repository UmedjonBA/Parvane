//! spec 035 T010 (FR-031, R5): обнаружение неизвестного по дескриптору схемы по
//! исходным байтам ДО разбора prost — `unknown::scan(type, bytes)`. Векторы
//! `proto/parvane/vectors/unknown/scan.json` написаны руками (FR-053): неизвестное
//! поле на глубине 3, неизвестный вид oneof (обычный и критичный), неизвестное
//! значение enum, известное — пусто.

mod common;

use common::*;
use parvane_protocol::unknown::{self, UnknownKind};
use serde_json::{json, Value};

fn load() -> Value {
    let path = vectors_dir("unknown").join("scan.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn scan_vectors() {
    let v = load();
    let cs = cases(&v);
    assert!(cs.len() >= 10, "набор неполон");
    for c in cs {
        let name = c["name"].as_str().unwrap();
        let ty = c["input"]["type"].as_str().unwrap();
        let bytes = unhex(&c["input"], "hex");
        let got = unknown::scan(ty, &bytes);
        check(name, &got, &c["expect"]);
        let Ok(report) = got else { continue };
        let items: Vec<Value> = report
            .items
            .iter()
            .map(|i| {
                let mut o = json!({
                    "path": i.path,
                    "kind": match i.kind { UnknownKind::Field => "field", UnknownKind::Oneof => "oneof", UnknownKind::Enum => "enum" },
                    "number": i.number,
                    "critical": i.critical,
                });
                if let Some(n) = &i.oneof {
                    o["oneof"] = json!(n);
                }
                o
            })
            .collect();
        assert_eq!(Value::Array(items), c["expect"]["items"], "вектор {name}");
        assert_eq!(report.is_empty(), c["expect"]["items"].as_array().unwrap().is_empty(), "вектор {name}: is_empty");
        let crit = c["expect"]["items"].as_array().unwrap().iter().any(|i| i["critical"] == json!(true));
        assert_eq!(report.has_critical(), crit, "вектор {name}: has_critical");
    }
}

/// Скан смотрит именно байты: prost при перекодировании роняет неизвестное, а скан
/// исходных байтов его видит (то, что `content_disposition` по разобранному не может).
#[test]
fn scan_sees_what_prost_drops() {
    use parvane_protocol::pb::parvane::msg::v2::Content;
    use prost::Message;
    let raw = hex::decode("0a0a0a026869120408014801").unwrap();
    let reencoded = Content::decode(raw.as_slice()).unwrap().encode_to_vec();
    assert_ne!(raw, reencoded, "prost сохранил неизвестное — тест не о том");
    assert!(!unknown::scan("parvane.msg.v2.Content", &raw).unwrap().is_empty());
    assert!(unknown::scan("parvane.msg.v2.Content", &reencoded).unwrap().is_empty());
}
