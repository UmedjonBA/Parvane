//! Прогон векторов conformance внутри движка (T081/T088): клиенты зовут его
//! через свою обвязку (WASM, C ABI) на файлах `proto/parvane/vectors/**`,
//! и тест клиента проверяет именно ту сборку движка, что работает в клиенте.
//! Наборы: `seal/sealed` (SEAL-1), `seal/group` (GSEAL-1), `invite/links`,
//! `state/merge` (STATE-1: каждый порядок записей — тот же снимок),
//! `content/kinds` (T085: все виды `Content` — лимиты, каноничный JSON,
//! обратное кодирование, показ/заглушка), `l2/mode` (L2-1: сетка
//! выравнивания личных и групповых конвертов, согласование режима чата,
//! запрет эфемерных каналов).

use serde_json::Value;

use crate::codec::decode_checked;
use crate::error::ProtoError;
use crate::group;
use crate::invite::{self, ParsedInvite};
use crate::limits::Origin;
use crate::l2::{self, ChatKind, L2Pref, L2State};
use crate::pb::parvane::core::v2::{DeviceRef, GroupEnvelope, GroupEnvelopeInner, SealedEnvelope, SealedInner};
use crate::pb::parvane::msg::v2::Content;
use crate::pb::parvane::state::v1::StateOp;
use crate::seal;
use crate::state::PersonalState;
use crate::unknown::{self, Disposition};

/// Прогнать набор; `Ok(n)` — все `n` случаев сошлись, иначе описание первого расхождения.
pub fn run(suite: &str, json: &str) -> Result<usize, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("JSON набора: {e}"))?;
    let cases = v.get("cases").and_then(Value::as_array).ok_or("нет cases")?;
    for case in cases {
        let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
        let r = match suite {
            "seal/sealed" => sealed_case(&v, case),
            "seal/group" => group_case(&v, case),
            "invite/links" => invite_case(case),
            "state/merge" => state_merge_case(case),
            "content/kinds" => content_case(case),
            "l2/mode" => l2_case(case),
            _ => return Err(format!("неизвестный набор {suite}")),
        };
        r.map_err(|e| format!("{suite}/{name}: {e}"))?;
    }
    Ok(cases.len())
}

fn hex_field(v: &Value, key: &str) -> Result<Vec<u8>, String> {
    hex::decode(v.get(key).and_then(Value::as_str).unwrap_or("")).map_err(|_| format!("поле {key} не hex"))
}

fn key32(v: &Value, key: &str) -> Result<[u8; 32], String> {
    hex_field(v, key)?.try_into().map_err(|_| format!("{key}: не 32 байта"))
}

fn expect_outcome<T>(got: &Result<T, ProtoError>, expect: &Value) -> Result<(), String> {
    match (got, expect.get("error").and_then(Value::as_str)) {
        (Ok(_), None) => Ok(()),
        (Err(e), Some(k)) if e.kind() == k => Ok(()),
        (Err(e), Some(k)) => Err(format!("ошибка {} вместо {k}", e.kind())),
        (Ok(_), Some(k)) => Err(format!("успех вместо ошибки {k}")),
        (Err(e), None) => Err(format!("ошибка {} вместо успеха", e.kind())),
    }
}

fn eq_hex(got: &[u8], expect: &Value, key: &str) -> Result<(), String> {
    match expect.get(key).and_then(Value::as_str) {
        Some(h) if hex::encode(got) == h => Ok(()),
        Some(h) => Err(format!("{key}: {} вместо {h}", hex::encode(got))),
        None => Ok(()),
    }
}

fn sealed_case(v: &Value, case: &Value) -> Result<(), String> {
    let sk = key32(v, "hpke_sk_hex")?;
    let me = DeviceRef {
        address: v["me"]["address"].as_str().unwrap_or("").into(),
        device_id: v["me"]["device_id"].as_str().unwrap_or("").into(),
    };
    let env: SealedEnvelope = decode_checked(&hex_field(&case["input"], "envelope_hex")?, Origin::Client).map_err(|e| e.kind().to_string())?;
    let got = seal::open(&env, &me, &sk);
    expect_outcome(&got, &case["expect"])?;
    if let (Ok(inner), Some(r)) = (&got, case["expect"].get("result")) {
        eq_hex(&inner.olm_message, r, "olm_message_hex")?;
        if r.get("olm_type").and_then(Value::as_u64) != Some(u64::from(inner.olm_type)) {
            return Err("olm_type".into());
        }
    }
    Ok(())
}

fn group_case(v: &Value, case: &Value) -> Result<(), String> {
    let key = key32(v, "envelope_key_hex")?;
    let pk = key32(v, "send_public_key_hex")?;
    let epoch = v.get("state_epoch").and_then(Value::as_u64).unwrap_or(0);
    let env: GroupEnvelope = decode_checked(&hex_field(&case["input"], "envelope_hex")?, Origin::Client).map_err(|e| e.kind().to_string())?;
    let got = group::verify_envelope(&env, epoch, &pk).and_then(|_| group::open_envelope(&env, &key));
    expect_outcome(&got, &case["expect"])?;
    if let (Ok(inner), Some(r)) = (&got, case["expect"].get("result")) {
        eq_hex(&inner.megolm_session_id, r, "megolm_session_id_hex")?;
        eq_hex(&inner.megolm_message, r, "megolm_message_hex")?;
    }
    Ok(())
}

fn invite_case(case: &Value) -> Result<(), String> {
    let url = case["input"]["url"].as_str().unwrap_or("");
    let got = invite::parse(url);
    expect_outcome(&got, &case["expect"])?;
    let Some(r) = case["expect"].get("result") else { return Ok(()) };
    match (got, r["kind"].as_str()) {
        (Ok(ParsedInvite::V2(p)), Some("v2")) => {
            if r["domain"].as_str() != Some(p.domain.as_str()) {
                return Err("domain".into());
            }
            eq_hex(&p.link_id, r, "link_id_hex")?;
            eq_hex(&p.seed, &case["input"], "seed_hex")?;
            if invite::format(&p).ok().as_deref() != Some(url) {
                return Err("обратная сборка ссылки".into());
            }
            Ok(())
        }
        (Ok(ParsedInvite::LegacyV1 { token }), Some("legacy_v1")) if r["token"].as_str() == Some(token.as_str()) => Ok(()),
        _ => Err("вид ссылки".into()),
    }
}

/// T085: байты `content_hex` проходят лимиты до разбора, дают каноничный
/// proto3-JSON `expect.content`, из него собираются те же байты (кроме
/// `reencode: false` — содержимое из будущей версии), а решение «показать /
/// заглушка» совпадает с `expect.disposition`.
fn content_case(case: &Value) -> Result<(), String> {
    use prost::Message;
    let bytes = hex_field(&case["input"], "content_hex")?;
    let got = decode_checked::<Content>(&bytes, Origin::Client);
    let expect = &case["expect"];
    expect_outcome(&got, expect)?;
    let Ok(content) = got else { return Ok(()) };
    let json = serde_json::to_value(&content).map_err(|e| format!("JSON содержимого: {e}"))?;
    if json != expect["content"] {
        return Err(format!("content: {json} вместо {}", expect["content"]));
    }
    if expect.get("reencode").and_then(Value::as_bool).unwrap_or(true) {
        let back: Content = serde_json::from_value(expect["content"].clone()).map_err(|e| format!("разбор JSON: {e}"))?;
        if back.encode_to_vec() != bytes {
            return Err("обратное кодирование даёт другие байты".into());
        }
    }
    let critical: Vec<u32> = case["input"]
        .get("critical_fields")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_u64).filter_map(|n| u32::try_from(n).ok()).collect())
        .unwrap_or_default();
    let disposition = match unknown::content_disposition(&content, &critical) {
        Disposition::Show => "show",
        Disposition::Stub => "stub",
        Disposition::Skip => "skip",
    };
    if expect.get("disposition").and_then(Value::as_str) != Some(disposition) {
        return Err(format!("disposition: {disposition}"));
    }
    Ok(())
}

/// L2-1: `op = "pad_direct"` — внутренний слой sealed с Olm-сообщением
/// длины `olm_len` после выравнивания имеет длину `expect.len`;
/// `"pad_group"` — то же для группового конверта (`session_id_len`,
/// `message_len`); `"negotiate"` — предпочтения участников (`prefs`, по
/// порядку) и политика группы (`group_policy`) дают `expect.active`
/// (режим чата), `expect.pad` (выравнивать исходящие `me`),
/// `expect.ephemeral` (typing/presence разрешены).
fn l2_case(case: &Value) -> Result<(), String> {
    use prost::Message;
    let input = &case["input"];
    let expect = &case["expect"];
    let num = |v: &Value, k: &str| -> Result<usize, String> {
        v.get(k).and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).ok_or(format!("нет {k}"))
    };
    let pref = |v: &Value| L2Pref { enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(false), ts_ms: v.get("ts_ms").and_then(Value::as_i64).unwrap_or(0) };
    match input.get("op").and_then(Value::as_str) {
        Some("pad_direct") => {
            let mut inner = SealedInner { olm_message: vec![1; num(input, "olm_len")?], ..Default::default() };
            l2::pad_direct(&mut inner);
            let (got, want) = (inner.encoded_len(), num(expect, "len")?);
            if got != want {
                return Err(format!("длина {got} вместо {want}"));
            }
            Ok(())
        }
        Some("pad_group") => {
            let mut inner = GroupEnvelopeInner { megolm_session_id: vec![1; num(input, "session_id_len")?], megolm_message: vec![7; num(input, "message_len")?], padding: vec![] };
            l2::pad_group(&mut inner);
            let (got, want) = (inner.encoded_len(), num(expect, "len")?);
            if got != want {
                return Err(format!("длина {got} вместо {want}"));
            }
            Ok(())
        }
        Some("negotiate") => {
            let kind = match input.get("chat").and_then(Value::as_str) {
                Some("direct") => ChatKind::Direct,
                Some("group") => ChatKind::Group,
                _ => return Err("chat".into()),
            };
            let mut st = L2State::new(kind);
            for p in input.get("prefs").and_then(Value::as_array).into_iter().flatten() {
                st.set_pref(p.get("user").and_then(Value::as_str).unwrap_or(""), pref(p));
            }
            for p in input.get("group_policy").and_then(Value::as_array).into_iter().flatten() {
                st.set_group_policy(pref(p));
            }
            let me = input.get("me").and_then(Value::as_str).unwrap_or("");
            let parts: Vec<&str> = input.get("participants").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            let got = (st.active(&parts), st.must_pad(me, &parts), st.ephemeral_allowed(&parts));
            let flag = |k: &str| expect.get(k).and_then(Value::as_bool).ok_or(format!("нет {k}"));
            let want = (flag("active")?, flag("pad")?, flag("ephemeral")?);
            if got != want {
                return Err(format!("(active, pad, ephemeral) = {got:?} вместо {want:?}"));
            }
            Ok(())
        }
        _ => Err("op".into()),
    }
}

/// STATE-1: операции `ops_hex` в каждом порядке из `orders` (возможны
/// повторы) дают тот же каноничный снимок, тот же набор отвергнутых индексов
/// и ту же наибольшую метку.
fn state_merge_case(case: &Value) -> Result<(), String> {
    let ops: Vec<StateOp> = case["input"]["ops_hex"]
        .as_array()
        .ok_or("нет ops_hex")?
        .iter()
        .map(|h| {
            let b = hex::decode(h.as_str().unwrap_or("")).map_err(|_| "ops_hex не hex".to_string())?;
            decode_checked::<StateOp>(&b, Origin::Client).map_err(|e| format!("операция: {}", e.kind()))
        })
        .collect::<Result<_, _>>()?;
    let expect = &case["expect"];
    let rejected: Vec<u64> = expect["rejected"].as_array().ok_or("нет rejected")?.iter().filter_map(Value::as_u64).collect();
    let max_lamport = expect["max_lamport"].as_u64().ok_or("нет max_lamport")?;
    for order in case["input"]["orders"].as_array().ok_or("нет orders")? {
        let order: Vec<usize> = order.as_array().ok_or("порядок")?.iter().filter_map(Value::as_u64).map(|i| i as usize).collect();
        let mut st = PersonalState::new();
        let mut got = std::collections::BTreeSet::new();
        for &i in &order {
            let op = ops.get(i).ok_or("индекс вне ops")?;
            if st.apply(op).is_err() {
                got.insert(i as u64);
            }
        }
        if got.into_iter().collect::<Vec<_>>() != rejected {
            return Err(format!("отвергнутые при порядке {order:?}"));
        }
        let snap = serde_json::to_value(st.snapshot()).map_err(|e| e.to_string())?;
        if snap != expect["snapshot"] {
            return Err(format!("снимок при порядке {order:?}"));
        }
        if st.max_lamport() != max_lamport {
            return Err("max_lamport".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(rel: &str) -> String {
        let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../proto/parvane/vectors").join(rel);
        std::fs::read_to_string(p).unwrap_or_default()
    }

    #[test]
    fn engine_runs_its_own_vectors() {
        for (suite, file) in [
            ("seal/sealed", "seal/sealed.json"),
            ("seal/group", "seal/group.json"),
            ("invite/links", "invite/links.json"),
            ("state/merge", "state/merge.json"),
            ("content/kinds", "content/kinds.json"),
            ("l2/mode", "l2/mode.json"),
        ] {
            let n = run(suite, &read(file)).unwrap();
            assert!(n >= 3, "{suite}: {n}");
        }
        assert!(run("nope", "{\"cases\":[{\"name\":\"x\"}]}").is_err());
    }
}
