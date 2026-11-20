//! Жалобы (spec 041, доски `XdChat`, `RpChat`, `XpChat`; правило REPORT-2): кому может уйти жалоба и список
//! поступивших жалоб у админа группы. Жалоба админам — по-прежнему видимое личное сообщение `mod_report` каждому
//! админу (REPORT-1, шифруется как вся переписка), администратору сервера — `identity.report.submit` под его ключом.
//! Нового серверного хранилища нет: список у админа собирается из полученных `mod_report`, «закрыта» — объект-признак
//! `OBJECT_KIND_REPORT_CLOSED` личного состояния (ключ — [`closed_key`]), общий для устройств админа.
//! Общий образец — `conformance/reports/cases.json`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

/// Причины жалобы по макету: «Спам», «Мошенничество», «Оскорбления», «Незаконное», «Другое».
pub const REASONS: [&str; 5] = ["spam", "fraud", "insult", "illegal", "other"];

/// Кому уходит жалоба.
pub const TARGET_ADMINS: &str = "admins";
pub const TARGET_SERVER: &str = "server";

/// Текст сообщения в списке — не длиннее (как `text` карточки `mod_report`).
const TEXT_MAX: usize = 600;
/// Комментариев на одно сообщение в списке.
const COMMENTS_MAX: usize = 5;

/// Причина к одному из [`REASONS`]: прежние коды окна Telegram сводятся к ближайшей, неизвестное — «другое».
pub fn normalize_reason(reason: &str) -> &'static str {
    match reason {
        "spam" => "spam",
        "fraud" | "fake" => "fraud",
        "insult" | "violence" | "personal" => "insult",
        "illegal" | "porn" | "child" | "copyright" => "illegal",
        _ => "other",
    }
}

/// Ключ объекта «жалоба закрыта»: `<ключ группы g:домен:hex>/<op_id сообщения, 32 hex>`; `None` — негодный вход.
pub fn closed_key(group_key: &str, op_id: &str) -> Option<String> {
    let op = op_id.replace('-', "").to_ascii_lowercase();
    if !group_key.starts_with("g:") || op.len() != 32 || !op.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("{group_key}/{op}"))
}

/// Годен ли ключ объекта «жалоба закрыта» (проверка `state2::check_key`).
pub fn is_closed_key(key: &str) -> bool {
    key.rsplit_once('/').is_some_and(|(group, op)| closed_key(group, op).as_deref() == Some(key))
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn n(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64))).unwrap_or(0)
}

fn list<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Админы группы, которым уходит жалоба: владелец и админы с правом удалять сообщения или банить (права не указаны
/// — полный админ), кроме себя и исключённых. Порядок — как в списке участников, без повторов.
pub fn report_admins(self_address: &str, members: &[Value]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    members
        .iter()
        .filter(|m| {
            let rights = m.get("admin_rights").filter(|r| r.is_object());
            let can = |k: &str| rights.and_then(|r| r.get(k)).and_then(Value::as_bool).unwrap_or(false);
            match s(m, "role") {
                "owner" => true,
                "admin" => rights.is_none() || can("delete_messages") || can("ban_users"),
                _ => false,
            }
        })
        .map(|m| s(m, "address").to_string())
        .filter(|a| !a.is_empty() && a != self_address && seen.insert(a.clone()))
        .collect()
}

/// Окно жалобы: `{self, members, isGroupMessage, serverAccepts}` → `{targets, target, admins, reasons}`.
/// Админам — только жалоба на сообщения группы, где есть кому её принять; серверу — если сервер принимает жалобы.
/// `target` — выбранное по умолчанию (первое из `targets`), пусто — жалобу отправить некуда.
pub fn form_json(args: &Value) -> Value {
    let is_group = args.get("isGroupMessage").and_then(Value::as_bool).unwrap_or(false);
    let server = args.get("serverAccepts").and_then(Value::as_bool).unwrap_or(false);
    let admins = if is_group { report_admins(s(args, "self"), list(args, "members")) } else { vec![] };
    let mut targets = vec![];
    if !admins.is_empty() {
        targets.push(TARGET_ADMINS);
    }
    if server {
        targets.push(TARGET_SERVER);
    }
    json!({
        "targets": targets,
        "target": targets.first().copied().unwrap_or(""),
        "admins": admins,
        "reasons": REASONS,
    })
}

/// Список жалоб группы у админа: `{reports: [{id, reporter, ts, reason, comment, messages: [{uuid, author, text,
/// ts}]}], closed: [uuid]}` — полученные карточки `mod_report` этой группы (уже сверенные клиентом со своей
/// историей) и закрытые сообщения. Одно сообщение — одна строка: число жалоб — разных пожаловавшихся, причина — самая
/// частая (при равенстве — по порядку [`REASONS`]), время — последней жалобы. Закрытые в список не входят.
/// Ответ: `{items: [{uuid, author, text, ts, reason, reasons: [{reason, count}], count, lastTs, reporters,
/// comments, reportIds}], open, closed}`; порядок — сначала свежие.
pub fn inbox_json(args: &Value) -> Value {
    let closed: BTreeSet<String> = list(args, "closed").iter().filter_map(Value::as_str).map(op_norm).collect();
    struct Item {
        uuid: String,
        author: String,
        text: String,
        ts: i64,
        last: i64,
        reporters: BTreeSet<String>,
        reasons: BTreeMap<&'static str, BTreeSet<String>>,
        comments: Vec<Value>,
        report_ids: Vec<String>,
    }
    let mut items: BTreeMap<String, Item> = BTreeMap::new();
    let mut closed_seen = BTreeSet::new();
    for report in list(args, "reports") {
        let reporter = s(report, "reporter").to_string();
        let reason = normalize_reason(s(report, "reason"));
        let comment = s(report, "comment").trim().to_string();
        let ts = n(report, "ts");
        let id = s(report, "id").to_string();
        let mut seen_here = BTreeSet::new();
        for m in list(report, "messages") {
            let uuid = op_norm(s(m, "uuid"));
            if uuid.len() != 32 || !seen_here.insert(uuid.clone()) {
                continue;
            }
            if closed.contains(&uuid) {
                closed_seen.insert(uuid);
                continue;
            }
            let item = items.entry(uuid.clone()).or_insert_with(|| Item {
                uuid: s(m, "uuid").to_string(),
                author: s(m, "author").to_string(),
                text: s(m, "text").chars().take(TEXT_MAX).collect(),
                ts: n(m, "ts"),
                last: 0,
                reporters: BTreeSet::new(),
                reasons: BTreeMap::new(),
                comments: vec![],
                report_ids: vec![],
            });
            item.last = item.last.max(ts);
            // Один человек — одна жалоба на сообщение, сколько бы раз он ни отправил
            let is_new_reporter = reporter.is_empty() || item.reporters.insert(reporter.clone());
            item.reasons.entry(reason).or_default().insert(reporter.clone());
            if !comment.is_empty() && is_new_reporter && item.comments.len() < COMMENTS_MAX {
                item.comments.push(json!({"reporter": reporter, "text": comment}));
            }
            if !id.is_empty() && !item.report_ids.contains(&id) {
                item.report_ids.push(id.clone());
            }
        }
    }
    let mut out: Vec<Item> = items.into_values().collect();
    out.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.uuid.cmp(&b.uuid)));
    let open = out.len();
    let rows: Vec<Value> = out
        .into_iter()
        .map(|i| {
            let mut reasons: Vec<(&str, usize)> = i.reasons.iter().map(|(r, who)| (*r, who.len())).collect();
            let rank = |r: &str| REASONS.iter().position(|x| *x == r).unwrap_or(REASONS.len());
            reasons.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| rank(a.0).cmp(&rank(b.0))));
            let mut o = Map::new();
            o.insert("uuid".into(), json!(i.uuid));
            o.insert("author".into(), json!(i.author));
            o.insert("text".into(), json!(i.text));
            o.insert("ts".into(), json!(i.ts));
            o.insert("reason".into(), json!(reasons.first().map(|r| r.0).unwrap_or("other")));
            o.insert("reasons".into(), json!(reasons.iter().map(|(r, c)| json!({"reason": r, "count": c})).collect::<Vec<_>>()));
            o.insert("count".into(), json!(i.reporters.len().max(1)));
            o.insert("lastTs".into(), json!(i.last));
            o.insert("reporters".into(), json!(i.reporters.into_iter().filter(|r| !r.is_empty()).collect::<Vec<_>>()));
            o.insert("comments".into(), Value::Array(i.comments));
            o.insert("reportIds".into(), json!(i.report_ids));
            Value::Object(o)
        })
        .collect();
    json!({"items": rows, "open": open, "closed": closed_seen.len()})
}

fn op_norm(op: &str) -> String {
    op.replace('-', "").to_ascii_lowercase()
}

/// Вызов из обвязок: `reportForm`, `reportInbox`, `reportClosedKey` (`{group, uuid}` → ключ либо `null`).
pub fn call(name: &str, args: &Value) -> Option<Value> {
    Some(match name {
        "reportForm" => form_json(args),
        "reportInbox" => inbox_json(args),
        "reportClosedKey" => closed_key(s(args, "group"), s(args, "uuid")).map_or(Value::Null, Value::from),
        _ => return None,
    })
}

/// Имена вызовов модуля.
pub const NAMES: [&str; 3] = ["reportForm", "reportInbox", "reportClosedKey"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admins_are_owner_and_moderating_admins_without_self() {
        let members = json!([
            {"address": "me@x", "role": "owner"},
            {"address": "ann@x", "role": "admin", "admin_rights": {"pin_messages": true}},
            {"address": "bo@x", "role": "admin", "admin_rights": {"ban_users": true}},
            {"address": "cy@x", "role": "admin"},
            {"address": "dee@x", "role": "member"},
            {"address": "eve@x", "role": "banned"},
        ]);
        assert_eq!(report_admins("me@x", members.as_array().unwrap()), vec!["bo@x", "cy@x"]);
    }

    #[test]
    fn form_offers_admins_only_for_group_messages() {
        let members = json!([{"address": "own@x", "role": "owner"}]);
        let f = form_json(&json!({"self": "me@x", "members": members, "isGroupMessage": true, "serverAccepts": true}));
        assert_eq!(f["targets"], json!(["admins", "server"]));
        assert_eq!(f["target"], "admins");
        let f = form_json(&json!({"self": "me@x", "members": members, "isGroupMessage": false, "serverAccepts": false}));
        assert_eq!(f["targets"], json!([]));
        assert_eq!(f["target"], "");
    }

    #[test]
    fn closed_key_is_group_and_op() {
        let k = closed_key("g:x:0a0b", "0123456789ABCDEF0123456789abcdef").unwrap();
        assert_eq!(k, "g:x:0a0b/0123456789abcdef0123456789abcdef");
        assert!(is_closed_key(&k));
        assert!(closed_key("u:a@x", "0123456789abcdef0123456789abcdef").is_none());
        assert!(!is_closed_key("g:x:0a0b/zz"));
    }
}
