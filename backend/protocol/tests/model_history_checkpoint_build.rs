//! spec 036 T006 (пробел E2; HIST-2, S7-4): контрольную точку журнала истории строит модель движка. Мини-журнал
//! `mini_server::HistoryJournal` (CAS по id точки, обрезка до `upto_seq`). Устройство A читает журнал, по сроку
//! собирает точку (сегменты по месяцам, сводка с позицией и id), новое устройство B входит по ней и видит строки,
//! маркер и надгробие; вторая точка переносит неизменившийся сегмент прежним номером; проигранный CAS не
//! повторяется до новой точки; журнал, дописанный во время сборки, откладывает точку. Без сборки в модели ни одна
//! точка не появлялась — все тесты падали на первой проверке «точка есть».
//!
//! Перенос из прежнего журнала web (`v2/history.ts`): замена истории точкой у устройства, отставшего дальше обрезки
//! журнала и горизонта надгробий; откат головы журнала сервером; книга цепочек писателей (пропуск записи при синке и
//! после входа по точке своей сборки).

mod mini_server;
mod model_common;

use mini_server::HistoryJournal;
use model_common::{b64d, b64e, call, Host};
use parvane_protocol::history;
use parvane_protocol::model::Engine;
use parvane_protocol::pb::parvane::core::v2::UserRef;
use parvane_protocol::pb::parvane::history::v1::{
    history_op, AppendRequest, CommitRequest, Gone, GoneScope, HistoryOp, MessageRow, ReadMark, Stamp,
};
use parvane_protocol::pb::parvane::state::v1::{peer, Peer};
use prost::Message;
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000; // 2027-01-15
const DAY: i64 = 86_400_000;
const HOUR: i64 = 3_600_000;
const ME: &str = "alice@local";

fn cfg() -> Value {
    json!({
        "user": ME, "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "vectors": true,
        "device_key": b64e(&[3u8; 32]),
        "history_checkpoint_records": 3,
        "history_checkpoint_age_ms": HOUR.to_string(),
        "history_checkpoint_jitter_ms": 1,
    })
}

fn user(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

fn row(n: u8, chat: &str, ts_ms: i64) -> MessageRow {
    MessageRow { id: vec![n; 16], chat: Some(user(chat)), from: chat.into(), ts_ms, body: format!(r#"{{"content":{{"kind":"text","text":"запись {n}"}}}}"#).into_bytes() }
}

fn bob_ts(n: u8) -> i64 {
    NOW - 1_000_000 + i64::from(n) * 1000
}

fn gone(n: u8, ts_ms: i64) -> HistoryOp {
    gone_in("bob@local", n, ts_ms)
}

fn gone_in(chat: &str, n: u8, ts_ms: i64) -> HistoryOp {
    history::gone_op(Gone {
        target: vec![n; 16],
        chat: Some(user(chat)),
        stamp: Some(Stamp { ts_ms, op_id: vec![0x40 + n; 16] }),
        scope: GoneScope::Everyone as i32,
        by: chat.into(),
        by_admin: false,
    })
}

/// Запечатать записи событий, не кладя в журнал (сервер «спрячет» часть).
fn sealed(e: &mut Engine, ops: Vec<HistoryOp>) -> AppendRequest {
    let s = e.debug_history_session().expect("сессия истории");
    let (_, body) = s.seal(ops, false, NOW).unwrap().remove(0);
    AppendRequest::decode(body.as_slice()).unwrap()
}

/// Запись «другого устройства» под ключом движка — сразу в журнал.
fn put(e: &mut Engine, j: &mut HistoryJournal, ops: Vec<HistoryOp>) -> u64 {
    let s = e.debug_history_session().expect("сессия истории");
    let sealed = s.seal(ops, false, NOW).unwrap();
    let mut seq = 0;
    for (_, body) in sealed {
        seq = j.append(&AppendRequest::decode(body.as_slice()).unwrap());
    }
    seq
}

/// Журнал: bob — строки 1–4 (2 удалена), строка 5 удалена 200 дней назад (за горизонтом), маркер bob до строки 1;
/// carol — строка 10 месяцем раньше. Четыре записи — больше порога 3.
fn seed(e: &mut Engine, j: &mut HistoryJournal) {
    let old = NOW - 200 * DAY;
    put(
        e,
        j,
        vec![
            history::row_op(row(1, "bob@local", bob_ts(1))),
            history::row_op(row(2, "bob@local", bob_ts(2))),
            history::row_op(row(3, "bob@local", bob_ts(3))),
            history::row_op(row(5, "bob@local", old)),
            history::row_op(row(10, "carol@local", NOW - 40 * DAY)),
        ],
    );
    put(e, j, vec![gone(2, bob_ts(2) + 10), gone(5, old + 1000)]);
    let mark = ReadMark { chat: Some(user("bob@local")), up_to_ts_ms: bob_ts(1), up_to_id: vec![1; 16] };
    put(e, j, vec![HistoryOp { op: Some(history_op::Op::Read(mark)) }]);
    put(e, j, vec![history::row_op(row(4, "bob@local", bob_ts(4)))]);
}

fn num(v: &Value) -> u64 {
    v.as_str().map(|s| s.parse().unwrap()).or(v.as_u64()).unwrap_or(0)
}

#[derive(Default)]
struct Served {
    /// Методы журнала по порядку; запись сегмента/сводки — `history.append:chunk`.
    methods: Vec<String>,
    notices: Vec<String>,
    commits: Vec<CommitRequest>,
}

type Hook<'a> = &'a mut dyn FnMut(&str, &[u8], &mut HistoryJournal) -> Option<Result<Vec<u8>, i32>>;

/// Отвечать журналом на запросы истории, пока движок их шлёт. `hook` видит запрос первым и может изменить журнал
/// или ответить сам.
fn serve(host: &mut Host, e: &mut Engine, j: &mut HistoryJournal, first: Value, hook: Hook<'_>) -> Served {
    let mut out = Served::default();
    let mut queue = vec![first];
    for _ in 0..400 {
        let Some(o) = queue.pop() else { break };
        let step = host.drive(e, o, true);
        for c in &step.changes {
            if let Some(k) = c.pointer("/notice/kind").and_then(Value::as_str) {
                out.notices.push(format!("{k}:{}", c.pointer("/notice/detail").and_then(Value::as_str).unwrap_or("")));
            }
        }
        for r in step.requests {
            let m = r["method"].as_str().unwrap().to_string();
            if !m.starts_with("history.") {
                continue;
            }
            let body = b64d(r["body"].as_str().unwrap_or(""));
            let label = if m == "history.append" && AppendRequest::decode(body.as_slice()).unwrap().chunk { format!("{m}:chunk") } else { m.clone() };
            out.methods.push(label);
            if m == "history.checkpoint.commit" {
                out.commits.push(CommitRequest::decode(body.as_slice()).unwrap());
            }
            let res = hook(&m, &body, j).unwrap_or_else(|| j.handle(&m, &body));
            let (error, body) = match res {
                Ok(b) => (0, b),
                Err(code) => (code, vec![]),
            };
            let si = json!({"kind": "SERVER_INPUT_KIND_RESPONSE", "req_id": num(&r["req_id"]).to_string(), "error": error, "body": b64e(&body)});
            queue.push(call(e, "ingest", &si).unwrap());
        }
    }
    out
}

fn no_hook() -> impl FnMut(&str, &[u8], &mut HistoryJournal) -> Option<Result<Vec<u8>, i32>> {
    |_: &str, _: &[u8], _: &mut HistoryJournal| None
}

fn pull(host: &mut Host, e: &mut Engine, j: &mut HistoryJournal) -> Served {
    let out = call(e, "vectorInput", &json!({"history_pull": true})).unwrap();
    serve(host, e, j, out, &mut no_hook())
}

fn tick(host: &mut Host, e: &mut Engine, j: &mut HistoryJournal, at: i64, hook: Hook<'_>) -> Served {
    let out = call(e, "tick", &json!({"now_ms": at.to_string()})).unwrap();
    serve(host, e, j, out, hook)
}

/// Два тика (срок наступил → случайная задержка ≤ 1 мс → сборка), всё по порядку.
fn tick_build(host: &mut Host, e: &mut Engine, j: &mut HistoryJournal, at: i64, hook: Hook<'_>) -> Served {
    let mut a = tick(host, e, j, at, &mut *hook);
    let b = tick(host, e, j, at + 10, &mut *hook);
    a.methods.extend(b.methods);
    a.notices.extend(b.notices);
    a.commits.extend(b.commits);
    a
}

/// Устройство A с прочитанным журналом.
fn device_a(j: &mut HistoryJournal) -> (Host, Engine) {
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg());
    seed(&mut e, j);
    let s = pull(&mut host, &mut e, j);
    assert_eq!(s.methods, vec!["history.head", "history.sync"], "журнал без точки читается с начала");
    assert_eq!(e.debug_rows(&user("bob@local")), 5);
    (host, e)
}

/// Новое устройство того же аккаунта: хранилище A без строк, маркеров и учёта журнала (ключи — те же).
fn device_b(a: &Host, j: &mut HistoryJournal) -> (Host, Engine, Served) {
    let mut store = a.store.clone();
    store.retain(|k, _| {
        let mut it = k.split('/').skip(1);
        let (kind, name) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
        !(kind == "history-row" || kind == "history-mark" || (kind == "engine-core" && name == "meta"))
    });
    let mut host = Host { store, ..Default::default() };
    let (mut e, _) = host.open(&cfg());
    assert_eq!(e.debug_rows(&user("bob@local")), 0, "у нового устройства строк нет");
    let s = pull(&mut host, &mut e, j);
    (host, e, s)
}

fn visible(e: &mut Engine, chat: &str) -> usize {
    let page = call(e, "historyPage", &json!({"chat": {"user": {"address": chat}}, "direction": "PAGE_DIRECTION_OLDER", "limit": 50})).unwrap();
    page["rows"].as_array().map_or(0, Vec::len)
}

fn unread(e: &mut Engine, chat: &str) -> u64 {
    let list = call(e, "chatList", &json!({"limit": 50})).unwrap();
    let c = list["chats"].as_array().into_iter().flatten().find(|c| c.to_string().contains(chat)).cloned().unwrap_or_default();
    num(&c["unread"])
}

#[test]
fn device_builds_checkpoint_and_new_device_enters_by_it() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    let s = tick_build(&mut ha, &mut a, &mut j, NOW + 1000, &mut no_hook());
    let cp = j.checkpoint.clone().expect("A собрал точку");
    assert_eq!(cp.id, 1);
    assert_eq!(s.methods.iter().filter(|m| *m == "history.append:chunk").count(), 3, "два месяца и сводка: {:?}", s.methods);
    assert_eq!(s.commits.len(), 1);
    assert_eq!(s.commits[0].expected_checkpoint_id, 0);
    assert!(s.notices.iter().any(|n| n.starts_with("history_checkpoint_built:1")), "{:?}", s.notices);
    assert_eq!(cp.upto_seq, cp.summary_seq, "S7-4: сводка — последняя запись точки");
    assert_eq!(j.records.len(), 3, "записи до точки обрезаны, остались сегменты и сводка");

    // Новое устройство: сводка, сегменты, курсор на точке
    let (_, mut b, s) = device_b(&ha, &mut j);
    assert_eq!(s.methods.first().map(String::as_str), Some("history.head"));
    assert_eq!(s.methods.iter().filter(|m| *m == "history.get").count(), 2, "сводка и сегменты: {:?}", s.methods);
    assert!(!s.notices.iter().any(|n| n.starts_with("history_checkpoint_rejected")), "сводка сходится с точкой (S7-4)");
    assert_eq!(b.debug_rows(&user("bob@local")), 4, "строки 1–4 с надгробием 2; строка 5 за горизонтом выброшена");
    assert_eq!(visible(&mut b, "bob@local"), 3, "удалённая строка не видна");
    assert_eq!(b.debug_rows(&user("carol@local")), 1);
    assert_eq!(unread(&mut b, "bob@local"), 2, "маркер «прочитано до» строки 1 пришёл с точкой");
    assert_eq!(unread(&mut a, "bob@local"), 2);
}

#[test]
fn second_checkpoint_after_age_reuses_unchanged_segments() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    tick_build(&mut ha, &mut a, &mut j, NOW + 1000, &mut no_hook());
    let cp1 = j.checkpoint.clone().expect("первая точка");

    // Новая запись в месяце bob; carol не меняется
    put(&mut a, &mut j, vec![history::row_op(row(6, "bob@local", bob_ts(6)))]);
    pull(&mut ha, &mut a, &mut j);
    assert_eq!(a.debug_rows(&user("bob@local")), 6);

    // Точке полчаса — рано (запись одна, порог 3)
    let s = tick_build(&mut ha, &mut a, &mut j, NOW + 1000 + HOUR / 2, &mut no_hook());
    assert!(s.commits.is_empty() && !s.methods.iter().any(|m| m == "history.head"), "до срока точка не строится: {:?}", s.methods);
    assert_eq!(j.checkpoint.as_ref().map(|c| c.id), Some(1));

    // Точке больше часа — вторая
    let s = tick_build(&mut ha, &mut a, &mut j, NOW + 2000 + HOUR, &mut no_hook());
    let cp2 = j.checkpoint.clone().expect("вторая точка");
    assert_eq!(cp2.id, 2);
    assert_eq!(s.commits[0].expected_checkpoint_id, 1);
    assert_eq!(s.methods.iter().filter(|m| *m == "history.append:chunk").count(), 2, "перезалит только месяц bob и сводка: {:?}", s.methods);
    let kept: Vec<u64> = cp2.chunk_seqs.iter().filter(|q| cp1.chunk_seqs.contains(q)).copied().collect();
    assert_eq!(kept.len(), 1, "сегмент carol перешёл прежним номером: {cp1:?} → {cp2:?}");
    assert!(s.notices.iter().any(|n| n.starts_with("history_checkpoint_built:2") && n.ends_with("uploaded=1")), "{:?}", s.notices);

    // Новое устройство по второй точке видит всё
    let (_, mut b, _) = device_b(&ha, &mut j);
    assert_eq!(b.debug_rows(&user("bob@local")), 5);
    assert_eq!(b.debug_rows(&user("carol@local")), 1);
    assert_eq!(visible(&mut b, "bob@local"), 4);
}

#[test]
fn lost_cas_is_not_retried_until_newer_checkpoint() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    // Другое устройство фиксирует точку раньше (те же записи) — CAS у A проигран
    let mut raced = false;
    let mut hook = |m: &str, body: &[u8], j: &mut HistoryJournal| {
        if m == "history.checkpoint.commit" && !raced {
            raced = true;
            j.handle(m, body).unwrap();
        }
        None
    };
    let s = tick_build(&mut ha, &mut a, &mut j, NOW + 1000, &mut hook);
    assert_eq!(s.commits.len(), 1, "A пытался зафиксировать точку: {:?}", s.methods);
    assert!(s.notices.iter().any(|n| n == "history_checkpoint_cas_failed:0"), "{:?}", s.notices);
    assert_eq!(s.methods.last().map(String::as_str), Some("history.get"), "после отказа A узнаёт новую точку (сводку): {:?}", s.methods);
    assert_eq!(j.checkpoint.as_ref().map(|c| c.id), Some(1));

    // Повтора нет, пока новая точка не состарится
    for at in [NOW + 2 * 60_000, NOW + 10 * 60_000, NOW + 30 * 60_000] {
        put(&mut a, &mut j, vec![history::row_op(row(at as u8 % 50 + 100, "bob@local", bob_ts(7)))]);
        // Опрос журнала (хост — раз в 60 с): голова известна, курсор догоняет (сначала вход по узнанной точке)
        pull(&mut ha, &mut a, &mut j);
        let s = tick_build(&mut ha, &mut a, &mut j, at, &mut no_hook());
        assert!(s.commits.is_empty(), "проигранный CAS не повторяется: {:?}", s.methods);
    }
    assert_eq!(j.checkpoint.as_ref().map(|c| c.id), Some(1));

    // Новая точка состарилась: A строит следующую поверх неё
    j.now_ms = NOW + 2 * HOUR;
    let mut t = NOW + HOUR + 60_000;
    for _ in 0..4 {
        tick_build(&mut ha, &mut a, &mut j, t, &mut no_hook());
        t += 70_000;
    }
    assert_eq!(j.checkpoint.as_ref().map(|c| c.id), Some(2), "следующая точка — на основе узнанной");
}

/// Сборка, при которой журнал дописывает другое устройство в момент `when` (номер запроса истории с начала тика).
fn moved_during_build(inject_on: &'static str, nth: usize, foreign_chunk: bool) {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    let foreign = {
        let s = a.debug_history_session().unwrap();
        let op = history::row_op(row(9, "bob@local", bob_ts(9)));
        // Сегмент чужой недособранной точки — сверка синком (`skip_chunks`) его не видит
        let op = if foreign_chunk { HistoryOp { op: Some(history_op::Op::State(history::apply(None, &op).unwrap())) } } else { op };
        let (_, body) = s.seal(vec![op], foreign_chunk, NOW).unwrap().remove(0);
        AppendRequest::decode(body.as_slice()).unwrap()
    };
    let mut seen = 0;
    let mut hook = |m: &str, body: &[u8], j: &mut HistoryJournal| {
        let label = if m == "history.append" && AppendRequest::decode(body).unwrap().chunk { "chunk" } else { m };
        if label == inject_on {
            seen += 1;
            if seen == nth {
                j.append(&foreign);
            }
        }
        None
    };
    let s = tick_build(&mut ha, &mut a, &mut j, NOW + 1000, &mut hook);
    assert!(s.commits.is_empty(), "журнал дописан во время сборки — точка не фиксируется: {:?}", s.methods);
    assert!(s.notices.iter().any(|n| n == "history_checkpoint_postponed:journal_moved"), "{:?}", s.notices);
    assert!(j.checkpoint.is_none());

    // Позже: дочитать журнал и собрать заново — чужая запись в точке
    let mut t = NOW + 1000 + 70_000;
    for _ in 0..3 {
        tick_build(&mut ha, &mut a, &mut j, t, &mut no_hook());
        t += 70_000;
    }
    assert_eq!(j.checkpoint.as_ref().map(|c| c.id), Some(1), "отложенная точка собрана позже");
    let (_, b, _) = device_b(&ha, &mut j);
    assert_eq!(b.debug_rows(&user("bob@local")), 5, "запись, появившаяся во время сборки, не потеряна обрезкой");
}

#[test]
fn journal_moved_before_summary_postpones() {
    // Чужая запись после сегментов, до головы перед сводкой: номер сводки сходится, но сверка синком её находит
    moved_during_build("history.head", 2, false);
}

#[test]
fn journal_moved_under_summary_postpones() {
    // Чужой сегмент между головой и записью сводки: сверка синком без сегментов его не видит, но сводка легла не
    // под названным номером (S7-4) — читатели такую точку отвергли бы
    moved_during_build("chunk", 3, true);
}

#[test]
fn device_behind_trimmed_journal_replaces_history_by_checkpoint() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    // У carol ещё строка 7 (за 10 дней до NOW); A её видит
    put(&mut a, &mut j, vec![history::row_op(row(7, "carol@local", NOW - 10 * DAY))]);
    pull(&mut ha, &mut a, &mut j);
    assert_eq!(visible(&mut a, "carol@local"), 2);
    // A не в сети. Другое устройство удаляет строку 7 на следующий день
    put(&mut a, &mut j, vec![gone_in("carol@local", 7, NOW + DAY)]);
    // Устройство D читает журнал и через 200 дней строит точку: надгробие строки 7 старше горизонта — его в точке нет
    let (mut hd, mut d, _) = device_b(&ha, &mut j);
    tick_build(&mut hd, &mut d, &mut j, NOW + 200 * DAY, &mut no_hook());
    let cp = j.checkpoint.clone().expect("точка D");
    assert!(j.records.iter().all(|r| r.chunk), "журнал до точки обрезан");

    // A вернулся: своё неотправленное (входящее, ещё в очереди журнала) — старое, но не снимается
    let queued = json!({"incoming": {"chat": {"user": {"address": "carol@local"}}, "from": "carol@local", "id": "33".repeat(16),
        "ts_ms": NOW - 300 * DAY, "content": {"text": {"text": "старое, ещё не в журнале"}}}});
    call(&mut a, "vectorInput", &queued).unwrap();
    let s = pull(&mut ha, &mut a, &mut j);
    assert!(s.methods.iter().filter(|m| *m == "history.get").count() >= 2, "курсор ниже обрезки — вход по точке: {:?}", s.methods);
    assert!(s.notices.iter().any(|n| n.starts_with("history_replaced:")), "{:?}", s.notices);
    assert_eq!(visible(&mut a, "carol@local"), 2, "строка 7 снята (удалена давно), своё неотправленное осталось");
    assert_eq!(a.debug_rows(&user("carol@local")), 2, "строки 10 и 33; строки 7 нет");
    assert_eq!(visible(&mut a, "bob@local"), 3, "строки точки на месте");
    let _ = cp;
}

#[test]
fn server_rollback_is_detected_and_journal_reread_keeping_own_unsent() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    // Своё неотправленное в очереди журнала
    let own = json!({"incoming": {"chat": {"user": {"address": "bob@local"}}, "from": "bob@local", "id": "20".repeat(16), "ts_ms": NOW,
        "content": {"text": {"text": "живое"}}}});
    call(&mut a, "vectorInput", &own).unwrap();
    // Сервер «откатился»: записей 3 и 4 нет, голова 2
    j.records.retain(|r| r.seq <= 2);
    j.head = 2;
    let s = pull(&mut ha, &mut a, &mut j);
    assert!(s.notices.iter().any(|n| n == "history_rollback:2 < 4"), "откат не принимается молча: {:?}", s.notices);
    assert_eq!(s.methods, vec!["history.sync", "history.head", "history.sync"], "журнал перечитывается заново: {:?}", s.methods);
    assert_eq!(visible(&mut a, "bob@local"), 4, "строки модели не потеряны");
    // Повтор опроса — уже без отката
    let s = pull(&mut ha, &mut a, &mut j);
    assert!(!s.notices.iter().any(|n| n.starts_with("history_rollback")), "{:?}", s.notices);
    // Своё неотправленное уходит после перечитывания
    let s = tick(&mut ha, &mut a, &mut j, NOW + 200_000, &mut no_hook());
    assert!(s.methods.iter().any(|m| m == "history.append"), "очередь своих операций сохранилась: {:?}", s.methods);
    assert_eq!(j.head, 3);
}

#[test]
fn hidden_record_is_a_gap_in_writer_chain() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    // Цепочка писателя: следующая запись сервер прячет, за ней — ещё одна
    let _hidden = sealed(&mut a, vec![history::row_op(row(11, "bob@local", bob_ts(11)))]);
    let shown = sealed(&mut a, vec![history::row_op(row(12, "bob@local", bob_ts(12)))]);
    j.append(&shown);
    let s = pull(&mut ha, &mut a, &mut j);
    assert!(s.notices.iter().any(|n| n == "history_gap:1"), "спрятанная запись видна по цепочке: {:?}", s.notices);
    // Книга переживает перезапуск: повтор той же записи — не пропуск
    let s = pull(&mut ha, &mut a, &mut j);
    assert!(!s.notices.iter().any(|n| n.starts_with("history_gap")), "{:?}", s.notices);
}

#[test]
fn checkpoint_carries_writer_chains_for_new_device() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    tick_build(&mut ha, &mut a, &mut j, NOW + 1000, &mut no_hook());
    assert!(j.checkpoint.is_some());
    // После точки сервер прячет запись цепочки
    let _hidden = sealed(&mut a, vec![history::row_op(row(11, "bob@local", bob_ts(11)))]);
    let shown = sealed(&mut a, vec![history::row_op(row(12, "bob@local", bob_ts(12)))]);
    j.append(&shown);
    // Новое устройство входит по точке: книга — из сводки (полная, с отметкой цепочки) — пропуск виден
    let (_, _, s) = device_b(&ha, &mut j);
    assert!(s.notices.iter().any(|n| n == "history_gap:1"), "сводка несёт цепочки писателей: {:?}", s.notices);
}

/// Прежних ключей личного состояния почти предел (`FORMER_STATE_KEYS_MAX` = 16): следующая точка строится без
/// ожидания срока и перезапечатывает ВСЕ сегменты текущим ключом — иначе сегмент, оставшийся под вытесненным ключом,
/// перестал бы открываться. После перезапечатки — обычный срок; новое устройство только с текущим ключом входит по
/// точке и видит всё.
#[test]
fn near_former_keys_limit_reseals_checkpoint_with_current_key() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    tick_build(&mut ha, &mut a, &mut j, NOW + 1000, &mut no_hook());
    assert_eq!(j.checkpoint.as_ref().map(|c| c.id), Some(1));

    // Мало прежних ключей — одна запись до срока точку не строит
    a.debug_rotate_state_key(1);
    put(&mut a, &mut j, vec![history::row_op(row(6, "bob@local", bob_ts(6)))]);
    pull(&mut ha, &mut a, &mut j);
    let s = tick_build(&mut ha, &mut a, &mut j, NOW + 2000, &mut no_hook());
    assert!(s.commits.is_empty(), "до срока и предела точка не строится: {:?}", s.methods);

    // Двенадцать прежних ключей — точка сразу, оба сегмента (bob и carol) перезалиты
    a.debug_rotate_state_key(11);
    assert_eq!(a.debug_former_state_keys(), 12);
    put(&mut a, &mut j, vec![history::row_op(row(7, "bob@local", bob_ts(7)))]);
    pull(&mut ha, &mut a, &mut j);
    let s = tick_build(&mut ha, &mut a, &mut j, NOW + 3000, &mut no_hook());
    assert_eq!(j.checkpoint.as_ref().map(|c| c.id), Some(2), "{:?}", s.methods);
    assert_eq!(s.methods.iter().filter(|m| *m == "history.append:chunk").count(), 3, "два сегмента и сводка: {:?}", s.methods);

    // Перезапечатано — дальше снова по сроку
    put(&mut a, &mut j, vec![history::row_op(row(8, "bob@local", bob_ts(8)))]);
    pull(&mut ha, &mut a, &mut j);
    let s = tick_build(&mut ha, &mut a, &mut j, NOW + 4000, &mut no_hook());
    assert!(s.commits.is_empty(), "повторной перезапечатки нет: {:?}", s.methods);

    // Устройство только с текущим ключом (прежние вытеснены) открывает точку целиком
    let mut store = ha.store.clone();
    store.retain(|k, _| {
        let mut it = k.split('/').skip(1);
        let (kind, name) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
        !(kind == "history-row" || kind == "history-mark" || (kind == "engine-core" && name == "meta"))
    });
    let mut hb = Host { store, ..Default::default() };
    let (mut b, _) = hb.open(&cfg());
    b.debug_drop_former_state_keys();
    let s = pull(&mut hb, &mut b, &mut j);
    assert!(!s.notices.iter().any(|n| n.starts_with("history_unreadable")), "{:?}", s.notices);
    assert_eq!(b.debug_rows(&user("carol@local")), 1, "сегмент carol под текущим ключом");
    assert_eq!(b.debug_rows(&user("bob@local")), 7);
}

/// Запись под ключом, которого у устройства нет, не пропадает молча: нотис `history_unreadable` с числом записей.
#[test]
fn unreadable_history_record_is_reported() {
    let mut j = HistoryJournal { now_ms: NOW, ..Default::default() };
    let (mut ha, mut a) = device_a(&mut j);
    a.debug_rotate_state_key(1);
    put(&mut a, &mut j, vec![history::row_op(row(6, "bob@local", bob_ts(6)))]);
    a.debug_drop_former_state_keys();
    a.debug_rotate_state_key(1);
    a.debug_drop_former_state_keys();
    put(&mut a, &mut j, vec![history::row_op(row(9, "bob@local", bob_ts(9)))]);
    let s = pull(&mut ha, &mut a, &mut j);
    assert!(s.notices.iter().any(|n| n == "history_unreadable:1"), "{:?}", s.notices);
    assert_eq!(a.debug_rows(&user("bob@local")), 6, "читаемая запись применена");
}
