//! Наборы `state2/*` (spec 035, T030/T036): личное состояние v2. Операции в векторе — краткая запись
//! (`proto/parvane/vectors/state2/*.json`, поле `description`): движок собирает из неё байты `StateOp`, прогоняет
//! случай во всех перестановках (до 5 операций; больше — прямой, обратный и сдвинутые порядки), с повтором
//! всего журнала и с разбиением «половина → снимок → загрузка → остальное»; снимок обязан совпасть побайтно,
//! отказы — одни и те же; затем сверяются показ, лампорт, непонятное, закрытие журнала и сохранность
//! неизвестных полей. Ожидания в файлах написаны руками (FR-053).

use std::collections::BTreeSet;

use prost::Message;
use serde_json::{json, Value};

use crate::limits::Origin;
use crate::pb::parvane::state::v2::{
    Create, Delete, FieldValue, Mark, Migrated, ObjectKey, ObjectKind, Patch, SetAdd, SetRemove, StateOp,
};
use crate::schema::{self, FieldTy};
use crate::state2::{self, State2};

fn hexv(v: &Value, key: &str) -> Result<Vec<u8>, String> {
    hex::decode(v.get(key).and_then(Value::as_str).unwrap_or("")).map_err(|_| format!("{key}: не hex"))
}

fn kind_of(v: &Value) -> Result<i32, String> {
    match v {
        Value::Number(n) => n.as_i64().and_then(|n| i32::try_from(n).ok()).ok_or_else(|| "kind".to_string()),
        Value::String(s) => ObjectKind::from_str_name(&format!("OBJECT_KIND_{s}")).map(|k| k as i32).ok_or_else(|| format!("вид {s}")),
        _ => Err("нет kind".into()),
    }
}

fn object(v: &Value) -> Result<ObjectKey, String> {
    Ok(ObjectKey { kind: kind_of(&v["kind"])?, key: v.get("key").and_then(Value::as_str).unwrap_or("").to_string() })
}

/// Байты поля `field` вида `kind`: `{hex}` либо proto3-JSON сообщения-значения с одним этим полем.
fn field_value(kind: i32, field: u32, v: &Value) -> Result<Vec<u8>, String> {
    if v.get("hex").is_some() {
        return hexv(v, "hex");
    }
    let t = state2::value_type(kind).ok_or("значение поля без типа — нужен hex")?;
    let b = crate::type_codec::encode_by_type(t, &v.to_string()).ok_or("тип")?.map_err(|e| format!("значение поля: {}", e.kind()))?;
    // В векторе — ровно одно поле.
    let mut probe = b.as_slice();
    while !probe.is_empty() {
        let (key, wire) = prost::encoding::decode_key(&mut probe).map_err(|e| e.to_string())?;
        if key != field {
            return Err(format!("значение поля {field} содержит поле {key}"));
        }
        prost::encoding::skip_field(wire, key, &mut probe, Default::default()).map_err(|e| e.to_string())?;
    }
    Ok(b)
}

/// Байты элемента множества: `{hex}` либо proto3-JSON элемента (тип — по схеме поля).
fn element(kind: i32, field: u32, v: &Value) -> Result<Vec<u8>, String> {
    if v.get("hex").is_some() {
        return hexv(v, "hex");
    }
    let spec = state2::value_type(kind).and_then(schema::message).ok_or("элемент без типа — нужен hex")?;
    let f = spec.field(field).ok_or("поле элемента не в схеме — нужен hex")?;
    let FieldTy::Message(i) = f.ty else { return Err("элемент не сообщение — нужен hex".into()) };
    let t = schema::MESSAGES.get(i).ok_or("схема")?.name;
    crate::type_codec::encode_by_type(t, &v.to_string()).ok_or("тип")?.map_err(|e| format!("элемент: {}", e.kind()))
}

fn fields(kind: i32, v: &Value) -> Result<Vec<FieldValue>, String> {
    let mut out = Vec::new();
    if let Some(m) = v.get("set").and_then(Value::as_object) {
        for (k, val) in m {
            let f: u32 = k.parse().map_err(|_| format!("номер поля {k}"))?;
            out.push(FieldValue { field: f, value: field_value(kind, f, val)? });
        }
    }
    if let Some(list) = v.get("set_list").and_then(Value::as_array) {
        for it in list {
            let f = it[0].as_u64().and_then(|n| u32::try_from(n).ok()).ok_or("set_list")?;
            out.push(FieldValue { field: f, value: field_value(kind, f, &it[1])? });
        }
    }
    Ok(out)
}

fn clear(v: &Value) -> Vec<u32> {
    v.get("clear").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).filter_map(|n| u32::try_from(n).ok()).collect()).unwrap_or_default()
}

fn u32f(v: &Value, key: &str) -> u32 {
    v.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(0)
}

/// Байты `StateOp` из краткой записи.
pub(crate) fn build_op(o: &Value) -> Result<Vec<u8>, String> {
    let op_id = if o.get("id_exact").is_some() {
        hexv(o, "id_exact")?
    } else {
        let id = hexv(o, "id")?;
        if id.len() > 16 {
            return Err("id длиннее 16 байт".into());
        }
        let mut b = vec![0u8; 16 - id.len()];
        b.extend_from_slice(&id);
        b
    };
    let header = StateOp {
        op_id,
        lamport: o.get("lamport").and_then(Value::as_u64).unwrap_or(0),
        device_id: o.get("device").and_then(Value::as_str).unwrap_or("").to_string(),
        ts_ms: 0,
        op: None,
    };
    let mut kind_found = None;
    for name in ["create", "patch", "delete", "set_add", "set_remove", "mark", "migrated"] {
        if let Some(v) = o.get(name) {
            kind_found = Some((name, v));
        }
    }
    let mut bytes = header.encode_to_vec();
    if let Some((name, v)) = kind_found {
        let (number, mut inner) = match name {
            "create" => {
                let obj = object(v)?;
                (10, Create { set: fields(obj.kind, v)?, object: Some(obj) }.encode_to_vec())
            }
            "patch" => {
                let obj = object(v)?;
                (11, Patch { set: fields(obj.kind, v)?, clear: clear(v), object: Some(obj) }.encode_to_vec())
            }
            "delete" => (12, Delete { object: Some(object(v)?) }.encode_to_vec()),
            "set_add" | "set_remove" => {
                let obj = object(v)?;
                let field = u32f(v, "field");
                let el = element(obj.kind, field, &v["element"])?;
                if name == "set_add" {
                    (13, SetAdd { object: Some(obj), field, element: el }.encode_to_vec())
                } else {
                    (14, SetRemove { object: Some(obj), field, element: el }.encode_to_vec())
                }
            }
            "mark" => (15, Mark { object: Some(object(v)?), field: u32f(v, "field"), value: hexv(v, "value_hex")? }.encode_to_vec()),
            _ => (16, Migrated { from_seq: v.get("from_seq").and_then(Value::as_u64).unwrap_or(0) }.encode_to_vec()),
        };
        inner.extend_from_slice(&hexv(o, "op_extra_hex")?);
        prost::encoding::encode_key(number, prost::encoding::WireType::LengthDelimited, &mut bytes);
        prost::encoding::encode_varint(inner.len() as u64, &mut bytes);
        bytes.extend_from_slice(&inner);
    }
    bytes.extend_from_slice(&hexv(o, "extra_hex")?);
    Ok(bytes)
}

fn permutations(n: usize) -> Vec<Vec<usize>> {
    if n > 5 {
        let id: Vec<usize> = (0..n).collect();
        let mut rev = id.clone();
        rev.reverse();
        let mut out = vec![id.clone(), rev];
        for k in [1, n / 2, n - 1] {
            let mut r = id.clone();
            r.rotate_left(k);
            out.push(r);
        }
        return out;
    }
    let mut out = vec![];
    let mut cur: Vec<usize> = (0..n).collect();
    fn heap(k: usize, a: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if k <= 1 {
            out.push(a.clone());
            return;
        }
        for i in 0..k {
            heap(k - 1, a, out);
            if k % 2 == 0 {
                a.swap(i, k - 1);
            } else {
                a.swap(0, k - 1);
            }
        }
    }
    heap(n, &mut cur, &mut out);
    out
}

fn apply_order(st: &mut State2, ops: &[Vec<u8>], order: &[usize]) -> Result<BTreeSet<usize>, String> {
    let mut rej = BTreeSet::new();
    for &i in order {
        if st.apply_bytes(ops.get(i).ok_or("индекс вне ops")?).is_err() {
            rej.insert(i);
        }
    }
    Ok(rej)
}

/// Показ в JSON векторов.
pub(crate) fn view_json(st: &State2, with_present: &BTreeSet<(i32, String)>) -> Result<Value, String> {
    let mut out = vec![];
    for o in st.view() {
        let value: Value = match state2::value_type(o.kind) {
            Some(t) => serde_json::from_str(
                &crate::type_codec::decode_by_type(t, &o.value, Origin::Client).ok_or("тип")?.map_err(|e| format!("показ: {}", e.kind()))?,
            )
            .map_err(|e| e.to_string())?,
            None => json!({}),
        };
        let kind = ObjectKind::try_from(o.kind).map(|k| k.as_str_name().to_string()).unwrap_or_default();
        let mut j = json!({"kind": kind, "key": o.key, "value": value});
        if !o.marks.is_empty() {
            j["marks"] = o.marks.iter().map(|(f, v)| (f.to_string(), Value::String(hex::encode(v)))).collect::<serde_json::Map<_, _>>().into();
        }
        if with_present.contains(&(o.kind, o.key.clone())) {
            j["present"] = json!(o.present);
        }
        out.push(j);
    }
    Ok(Value::Array(out))
}

pub(crate) fn case(c: &Value) -> Result<(), String> {
    let ops: Vec<Vec<u8>> = c["input"]["ops"].as_array().ok_or("нет ops")?.iter().map(build_op).collect::<Result<_, _>>()?;
    let expect = &c["expect"];
    let rejected: BTreeSet<usize> = expect["rejected"].as_array().ok_or("нет rejected")?.iter().filter_map(Value::as_u64).map(|n| n as usize).collect();
    let orders: Vec<Vec<usize>> = match c["input"].get("orders").and_then(Value::as_array) {
        Some(a) => a.iter().map(|o| o.as_array().map(|x| x.iter().filter_map(Value::as_u64).map(|n| n as usize).collect()).unwrap_or_default()).collect(),
        None => permutations(ops.len()),
    };
    let mut reference: Option<(State2, Vec<u8>)> = None;
    for order in &orders {
        let mut st = State2::new();
        let got = apply_order(&mut st, &ops, order)?;
        if got != rejected {
            return Err(format!("отвергнутые {got:?} при порядке {order:?}"));
        }
        // Повтор всего журнала ничего не меняет.
        let snap = st.snapshot_bytes();
        apply_order(&mut st, &ops, order)?;
        if st.snapshot_bytes() != snap {
            return Err(format!("повтор изменил снимок при порядке {order:?}"));
        }
        // Разбиение через снимок.
        let cut = order.len() / 2;
        let mut first = State2::new();
        apply_order(&mut first, &ops, &order[..cut])?;
        let mut resumed = State2::from_snapshot_bytes(&first.snapshot_bytes()).map_err(|e| format!("снимок: {}", e.kind()))?;
        apply_order(&mut resumed, &ops, &order[cut..])?;
        if resumed.snapshot_bytes() != snap {
            return Err(format!("разбиение изменило снимок при порядке {order:?}"));
        }
        match &reference {
            Some((_, b)) if *b != snap => return Err(format!("снимок при порядке {order:?} отличается")),
            Some(_) => {}
            None => reference = Some((st, snap)),
        }
    }
    let (st, _) = reference.ok_or("нет порядков")?;
    if let Some(m) = expect.get("max_lamport").and_then(Value::as_u64) {
        if st.max_lamport() != m {
            return Err(format!("max_lamport {} вместо {m}", st.max_lamport()));
        }
    }
    if let Some(h) = expect.get("held").and_then(Value::as_u64) {
        if st.held_count() as u64 != h {
            return Err(format!("held {} вместо {h}", st.held_count()));
        }
        if (h == 0) != st.replacement_snapshot().is_ok() {
            return Err("заменяющий снимок не по held".into());
        }
    }
    if let Some(w) = expect.get("write_blocked").and_then(Value::as_bool) {
        if st.write_blocked() != w {
            return Err(format!("write_blocked {}", st.write_blocked()));
        }
    }
    for k in expect.get("kept_fields").and_then(Value::as_array).into_iter().flatten() {
        let (kind, key, field) = (kind_of(&k[0])?, k[1].as_str().unwrap_or(""), u32f(&json!({"f": k[2]}), "f"));
        if st.raw_field(kind, key, field).flatten().is_none() {
            return Err(format!("поле {field} объекта {kind}/{key} потеряно"));
        }
    }
    for k in expect.get("kept_values").and_then(Value::as_array).into_iter().flatten() {
        let (kind, key, field) = (kind_of(&k[0])?, k[1].as_str().unwrap_or(""), u32f(&json!({"f": k[2]}), "f"));
        let got = st.raw_field(kind, key, field).flatten().map(hex::encode);
        if got.as_deref() != k[3].as_str() {
            return Err(format!("поле {field} объекта {kind}/{key}: {got:?}"));
        }
    }
    let objects = expect["objects"].as_array().ok_or("нет objects")?;
    let with_present: BTreeSet<(i32, String)> = objects
        .iter()
        .filter(|o| o.get("present").is_some())
        .map(|o| Ok((kind_of(&Value::String(o["kind"].as_str().unwrap_or("").trim_start_matches("OBJECT_KIND_").to_string()))?, o["key"].as_str().unwrap_or("").to_string())))
        .collect::<Result<_, String>>()?;
    let got = view_json(&st, &with_present)?;
    if got != Value::Array(objects.clone()) {
        return Err(format!("показ {got} вместо {}", Value::Array(objects.clone())));
    }
    Ok(())
}

// ── spec 035 T052: критичность номером вида ──────────────────────────────────────────────────────────────

fn disposition_name(d: crate::unknown::Disposition) -> &'static str {
    use crate::unknown::Disposition as D;
    match d {
        D::Show => "show",
        D::Stub => "stub",
        D::StubCritical => "stub_critical",
        D::Skip => "skip",
    }
}

/// `content/critical`: показ по исходным байтам и разрешённые действия.
pub(crate) fn content_critical_case(c: &Value) -> Result<(), String> {
    let bytes = hexv(&c["input"], "content_hex")?;
    let critical: Vec<u32> = c["input"]
        .get("critical_fields")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_u64).filter_map(|n| u32::try_from(n).ok()).collect())
        .unwrap_or_default();
    let d = crate::unknown::content_disposition_bytes(&bytes, &critical).map_err(|e| format!("показ: {}", e.kind()))?;
    let a = crate::unknown::actions(d);
    let got = json!({"disposition": disposition_name(d), "actions": {"reply": a.reply, "edit": a.edit, "forward": a.forward}});
    if got != c["expect"] {
        return Err(format!("{got} вместо {}", c["expect"]));
    }
    Ok(())
}

fn write_name(w: crate::pb::parvane::engine::v1::JournalWrite) -> &'static str {
    w.as_str_name()
}

/// `model/critical_journal`: критичный вид закрывает журнал для записи, показ известного работает.
pub(crate) fn critical_journal_case(c: &Value) -> Result<(), String> {
    let expect = &c["expect"];
    let (journal, type_name, records): (&str, &str, Vec<Vec<u8>>) = match c["input"]["journal"].as_str() {
        Some("state") => (crate::hold::STATE, state2::OP_TYPE, c["input"]["ops"].as_array().ok_or("нет ops")?.iter().map(build_op).collect::<Result<_, _>>()?),
        Some("history") => (
            crate::hold::HISTORY,
            crate::hold::HISTORY_TYPE,
            c["input"]["records_hex"].as_array().ok_or("нет records_hex")?.iter().map(|h| hex::decode(h.as_str().unwrap_or("")).map_err(|_| "hex".to_string())).collect::<Result<_, _>>()?,
        ),
        j => return Err(format!("журнал {j:?}")),
    };
    let recs: Vec<(u64, &[u8])> = records.iter().enumerate().map(|(i, b)| (i as u64 + 1, b.as_slice())).collect();
    let write = crate::hold::write_state(type_name, &recs).map_err(|e| e.kind().to_string())?;
    if Some(write_name(write)) != expect["write"].as_str() {
        return Err(format!("write {}", write_name(write)));
    }
    let holds = crate::hold::scan(journal, type_name, &recs).map_err(|e| e.kind().to_string())?;
    let spans: Vec<Value> = holds.iter().map(|h| json!([h.from_seq, h.to_seq])).collect();
    if Value::Array(spans.clone()) != expect["holds"] {
        return Err(format!("holds {spans:?}"));
    }
    if journal == crate::hold::STATE {
        let mut st = State2::new();
        for r in &records {
            st.apply_bytes(r).map_err(|e| format!("запись: {}", e.kind()))?;
        }
        // Свою новую операцию — только если журнал открыт.
        let mine = StateOp {
            op_id: vec![0xee; 16],
            lamport: st.max_lamport() + 1,
            device_id: "d1".into(),
            ts_ms: 0,
            op: Some(crate::pb::parvane::state::v2::state_op::Op::Delete(Delete { object: Some(ObjectKey { kind: ObjectKind::Folder as i32, key: "9".into() }) })),
        };
        let key = crate::state::StateKey::from_bytes(&[1u8; 32]).map_err(|e| e.kind().to_string())?;
        let submit = match st.seal_local(&key, "alice@x", &mine) {
            Ok(_) => "ok".to_string(),
            Err(e) => e.kind().to_string(),
        };
        if Some(submit.as_str()) != expect["submit"].as_str() {
            return Err(format!("submit {submit}"));
        }
        if (write == crate::pb::parvane::engine::v1::JournalWrite::BlockedCriticalUnknown) != st.write_blocked() {
            return Err("write_blocked состояния не совпало с журналом".into());
        }
        let got = view_json(&st, &BTreeSet::new())?;
        if got != expect["objects"] {
            return Err(format!("показ {got}"));
        }
    }
    Ok(())
}
