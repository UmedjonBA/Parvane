//! Прогон векторов conformance внутри движка (T081/T088): клиенты зовут его
//! через свою обвязку (WASM, C ABI) на файлах `proto/parvane/vectors/**`,
//! и тест клиента проверяет именно ту сборку движка, что работает в клиенте.
//! Наборы: `seal/sealed` (SEAL-1), `seal/group` (GSEAL-1), `invite/links`,
//! `state/merge` (STATE-1: каждый порядок записей — тот же снимок),
//! `content/kinds` (T085: все виды `Content` — лимиты, каноничный JSON,
//! обратное кодирование, показ/заглушка), `l2/mode` (L2-1: сетка
//! выравнивания личных и групповых конвертов, согласование режима чата,
//! запрет эфемерных каналов), а с T136 — и наборы, которые раньше гонял
//! только движок: `codec/frames` (кадры и тела запросов: размер, лимиты,
//! акторы, направление, реестр), `sign/ops` (OP-SIG), `device_log/alice` и
//! `group_log/group` (журналы устройств и группы по шагам), `content_guard/content`
//! (чистка содержимого), `legacy_v1/messages` (разбор v1-диалектов клиентов),
//! `call/signals` (сигнал звонка v1 ↔ v2: перекладку делают клиенты, движок
//! сверяет, что их proto3-JSON — допустимый `CallSignal`), `link/sas` (LINK-1:
//! обязательство и код сверки считают клиенты, движок сверяет формулу).

use serde_json::Value;

use prost::Message;

use crate::codec::{self, decode_checked};
use crate::content_guard;
use crate::error::ProtoError;
use crate::group::{self, SignerInfo};
use crate::identity::DeviceLog;
use crate::legacy_v1::{self, LegacyBody, LegacyInner};
use crate::invite::{self, ParsedInvite};
use crate::limits::Origin;
use crate::l2::{self, ChatKind, L2Pref, L2State};
use crate::pb::parvane::core::v2::{
    frame, DeviceRef, Frame, GroupEnvelope, GroupEnvelopeInner, GroupStateEntry, Ref, Request, SealedEnvelope, SealedInner,
    SignedOp, StreamChunk,
};
use crate::pb::parvane::msg::v2::Content;
use crate::pb::parvane::state::v1::StateOp;
use crate::seal;
use crate::sign;
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
            "codec/frames" => codec_case(case),
            "sign/ops" => sign_case(case),
            "device_log/alice" => device_log_case(&v, case),
            "group_log/group" => group_log_case(&v, case),
            "content_guard/content" => content_guard_case(case),
            "legacy_v1/messages" => legacy_case(case),
            "call/signals" => call_case(case),
            "link/sas" => link_case(case),
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

// ── наборы, которые до T136 гонял только движок ─────────────────────────────

fn str_field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key).and_then(Value::as_str).ok_or_else(|| format!("нет поля {key}"))
}

fn origin_of(input: &Value) -> Origin {
    if input.get("origin").and_then(Value::as_str) == Some("server") {
        Origin::Server
    } else {
        Origin::Client
    }
}

fn codec_case(case: &Value) -> Result<(), String> {
    let input = &case["input"];
    match str_field(input, "kind")? {
        "frame" => expect_outcome(&codec::decode_frame(&hex_field(input, "frame_hex")?, origin_of(input)), &case["expect"]),
        // Большие кадры в файле не лежат — обвязка собирает их сама
        "synthetic" => {
            let len = input.get("len").and_then(Value::as_u64).ok_or("нет len")? as usize;
            let bytes = match str_field(input, "what")? {
                "stream_chunk" => Frame {
                    proto_major: 2,
                    kind: Some(frame::Kind::StreamChunk(StreamChunk { id: 1, index: 0, last: true, data: vec![0; len], error: None })),
                }
                .encode_to_vec(),
                "raw_zeros" => vec![0; len],
                w => return Err(format!("неизвестная синтетика {w}")),
            };
            expect_outcome(&codec::decode_frame(&bytes, origin_of(input)), &case["expect"])
        }
        "request" => {
            let req = Request { id: 1, method: str_field(input, "method")?.into(), body: hex_field(input, "body_hex")?, timeout_ms: 1000 };
            expect_outcome(&codec::check_request(&req, Origin::Client), &case["expect"])
        }
        k => Err(format!("неизвестный вид {k}")),
    }
}

fn sign_case(case: &Value) -> Result<(), String> {
    let input = &case["input"];
    let op = SignedOp {
        body: hex_field(&input["op"], "body_hex")?,
        signature: hex_field(&input["op"], "signature_hex")?,
        signer_key: hex_field(&input["op"], "signer_hex")?,
    };
    let expect_signer = match input.get("expect_signer_hex") {
        Some(_) => Some(key32(input, "expect_signer_hex")?),
        None => None,
    };
    let audience = match input.get("audience") {
        Some(a) => Some(DeviceRef { address: str_field(a, "address")?.into(), device_id: str_field(a, "device_id")?.into() }),
        None => None,
    };
    let target = match input.get("target") {
        Some(t) => Some(Ref { domain: str_field(t, "domain")?.into(), id: hex_field(t, "id_hex")? }),
        None => None,
    };
    let got = sign::verify_op(&op, str_field(input, "expect_domain")?, str_field(input, "expect_op_type")?, expect_signer.as_ref())
        .and_then(|verified| {
            if let Some(a) = &audience {
                verified.require_audience(a)?;
            }
            if let Some(t) = &target {
                verified.require_target(t)?;
            }
            Ok(verified)
        });
    expect_outcome(&got, &case["expect"])?;
    if let (Ok(verified), Some(_)) = (&got, case["expect"].get("payload_hex")) {
        eq_hex(&verified.payload, &case["expect"], "payload_hex")?;
    }
    Ok(())
}

fn steps_of(case: &Value) -> Result<&Vec<Value>, String> {
    case["input"].get("steps").and_then(Value::as_array).ok_or_else(|| "нет steps".to_string())
}

fn device_log_case(v: &Value, case: &Value) -> Result<(), String> {
    let mut log = DeviceLog::new(str_field(v, "user")?).map_err(|e| format!("журнал: {}", e.kind()))?;
    for (i, step) in steps_of(case)?.iter().enumerate() {
        let op: SignedOp =
            decode_checked(&hex_field(step, "entry_hex")?, Origin::Client).map_err(|e| format!("шаг {i}: запись: {}", e.kind()))?;
        expect_outcome(&log.apply(&op), &step["expect"]).map_err(|e| format!("шаг {i}: {e}"))?;
    }
    if Some(log.version) != v["final"].get("version").and_then(Value::as_u64) {
        return Err(format!("версия журнала {}", log.version));
    }
    if !log.revoked.contains("d1") || log.active("d1").is_some() {
        return Err("устройство d1 не отозвано".into());
    }
    if log.legacy.as_ref().map(Vec::len) != Some(1) {
        return Err("список v1-устройств не из одной записи".into());
    }
    Ok(())
}

fn group_log_case(v: &Value, case: &Value) -> Result<(), String> {
    let mut signers = std::collections::HashMap::new();
    for (key, info) in v.get("signers").and_then(Value::as_object).ok_or("нет signers")? {
        signers.insert(key.clone(), SignerInfo { user: str_field(info, "user")?.into(), root_key: key32(info, "root_hex")? });
    }
    let resolve = |k: &[u8; 32]| signers.get(&hex::encode(k)).cloned();
    let mut state: Option<group::GroupState> = None;
    for (i, step) in steps_of(case)?.iter().enumerate() {
        let entry: GroupStateEntry =
            decode_checked(&hex_field(step, "entry_hex")?, Origin::Client).map_err(|e| format!("шаг {i}: запись: {}", e.kind()))?;
        let applied = group::apply(state.as_ref(), &entry, &resolve);
        expect_outcome(&applied, &step["expect"]).map_err(|e| format!("шаг {i}: {e}"))?;
        if let Ok(next) = applied {
            state = Some(next);
        }
    }
    let state = state.ok_or("журнал группы пуст")?;
    if !state.banned.contains("bob@x") {
        return Err("bob@x не забанен".into());
    }
    // Форк: та же версия, другой hash
    let mut ctx = state.context();
    eq_hex(&ctx.state_head_hash, &v["fork"], "head_hex")?;
    ctx.state_head_hash = hex_field(&v["fork"], "other_head_hex")?;
    if state.check_context(&ctx) != group::ContextVerdict::Fork {
        return Err("форк журнала не распознан".into());
    }
    Ok(())
}

fn content_guard_case(case: &Value) -> Result<(), String> {
    let mut content: Content =
        serde_json::from_value(case["input"]["content"].clone()).map_err(|e| format!("JSON содержимого: {e}"))?;
    content_guard::sanitize_content(&mut content);
    let got = serde_json::to_value(&content).map_err(|e| e.to_string())?;
    if got != case["expect"]["content"] {
        return Err(format!("после чистки {got}"));
    }
    Ok(())
}

fn legacy_inner_json(inner: &LegacyInner) -> Result<Value, String> {
    Ok(match inner {
        LegacyInner::Content(c) => serde_json::json!({"content": serde_json::to_value(c.as_ref()).map_err(|e| e.to_string())?}),
        LegacyInner::Skdm { group, session_key, sender_identity, epoch } => serde_json::json!({"skdm": {
            "group": group, "session_key": session_key, "sender_identity": sender_identity, "epoch": epoch}}),
        LegacyInner::Unknown(_) => serde_json::json!({"unknown": true}),
    })
}

fn legacy_result(layer: &str, input: &str) -> Result<Result<Value, ProtoError>, String> {
    let json = |v: Result<Value, String>| v.map(Ok);
    Ok(match layer {
        "stored" => match legacy_v1::parse_stored(input.as_bytes()) {
            Err(e) => Err(e),
            Ok(s) => {
                let body = match &s.body {
                    LegacyBody::Tombstone => serde_json::json!({"tombstone": true}),
                    LegacyBody::Plain(c) => {
                        serde_json::json!({"plain": serde_json::to_value(c.as_ref()).map_err(|e| e.to_string())?})
                    }
                    LegacyBody::Olm { ciphertext, ctype, sender_identity, sender_signing_key } => serde_json::json!({"olm": {
                        "ciphertext_hex": hex::encode(ciphertext), "ctype_candidates": legacy_v1::ctype_candidates(*ctype),
                        "sender_identity": sender_identity, "sender_signing_key": sender_signing_key}}),
                    LegacyBody::Megolm { ciphertext, group, sender_identity, .. } => serde_json::json!({"megolm": {
                        "ciphertext_hex": hex::encode(ciphertext), "group": group, "sender_identity": sender_identity}}),
                };
                Ok(serde_json::json!({"id": s.id, "from": s.from, "to": s.to, "ts": s.ts, "reply_to": s.reply_to,
                    "edited": s.edited, "deleted": s.deleted, "pinned": s.pinned, "body": body}))
            }
        },
        "olm" => match legacy_v1::parse_olm_plaintext(input.as_bytes()) {
            Err(e) => Err(e),
            Ok((from, inner)) => return json(legacy_inner_json(&inner).map(|i| serde_json::json!({"author": from, "inner": i}))),
        },
        "megolm" => match legacy_v1::parse_megolm_plaintext(input.as_bytes()) {
            Err(e) => Err(e),
            Ok(inner) => return json(legacy_inner_json(&inner).map(|i| serde_json::json!({"inner": i}))),
        },
        "ice" => match legacy_v1::normalize_ice(input) {
            Err(e) => Err(e),
            Ok(ice) => Ok(serde_json::to_value(ice).map_err(|e| e.to_string())?),
        },
        l => return Err(format!("неизвестный слой {l}")),
    })
}

fn legacy_case(case: &Value) -> Result<(), String> {
    let got = legacy_result(str_field(&case["input"], "layer")?, str_field(&case["input"], "json")?)?;
    expect_outcome(&got, &case["expect"])?;
    if let (Ok(result), Some(expect)) = (&got, case["expect"].get("result")) {
        if result != expect {
            return Err(format!("результат {result}"));
        }
    }
    Ok(())
}

/// Сигнал звонка: перекладку v1 ↔ v2 делает клиент — движок сверяет, что
/// proto3-JSON векторов разбирается как `CallSignal` и проходит лимиты схемы.
fn call_case(case: &Value) -> Result<(), String> {
    use crate::pb::parvane::call::v2::CallSignal;
    let (json, sent) = match str_field(&case["input"], "direction")? {
        "to_v2" => (&case["expect"]["v2"], true),
        "from_v2" => (&case["input"]["v2"], false),
        d => return Err(format!("неизвестное направление {d}")),
    };
    if json.is_null() {
        return Ok(());
    }
    let signal: CallSignal = serde_json::from_value(json.clone()).map_err(|e| format!("не CallSignal: {e}"))?;
    decode_checked::<CallSignal>(&signal.encode_to_vec(), Origin::Client).map_err(|e| format!("лимиты схемы: {}", e.kind()))?;
    // Что клиент отдаёт движку на отправку — всегда с id звонка и ровно одним сигналом
    if sent {
        if signal.call_id.len() != 16 || signal.signal.is_none() {
            return Err("сигнал на отправку без id звонка или без содержимого".into());
        }
        if !signal.group_call_id.is_empty() && signal.group_call_id.len() != 16 {
            return Err("id группового звонка не 16 байт".into());
        }
    }
    Ok(())
}

/// LINK-1: обязательство и код сверки считают клиенты — движок сверяет формулу.
fn link_case(case: &Value) -> Result<(), String> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let raw = |key: &str| -> Result<Vec<u8>, String> {
        base64::engine::general_purpose::STANDARD
            .decode(str_field(&case["input"], key)?)
            .map_err(|_| format!("поле {key} не base64"))
    };
    let (new, old) = (raw("new_pub_b64")?, raw("old_pub_b64")?);
    let commitment = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(&new));
    if commitment != str_field(&case["expect"], "commitment_of_new_b64")? {
        return Err(format!("обязательство {commitment}"));
    }
    let digest = Sha256::new().chain_update(b"parvane-link-sas-v2").chain_update(&new).chain_update(&old).finalize();
    let code = format!("{:012}", u64::from_be_bytes(digest[..8].try_into().map_err(|_| "digest")?) % 1_000_000_000_000);
    let sas = format!("{} {} {}", &code[..4], &code[4..8], &code[8..]);
    if sas != str_field(&case["expect"], "sas")? {
        return Err(format!("код сверки {sas}"));
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
        // T136: журналы — по одному случаю из нескольких шагов
        for (suite, file, least) in [
            ("codec/frames", "codec/frames.json", 20),
            ("sign/ops", "sign/ops.json", 10),
            ("device_log/alice", "device_log/alice.json", 1),
            ("group_log/group", "group_log/group.json", 1),
            ("content_guard/content", "content_guard/content.json", 10),
            ("legacy_v1/messages", "legacy_v1/messages.json", 40),
            ("call/signals", "call/signals.json", 30),
            ("link/sas", "link/sas.json", 5),
        ] {
            let n = run(suite, &read(file)).unwrap();
            assert!(n >= least, "{suite}: {n}");
        }
        assert!(run("nope", "{\"cases\":[{\"name\":\"x\"}]}").is_err());
    }
}
