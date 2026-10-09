//! Ключ восстановления через Telegram-бота (spec 015, решение пользователя
//! 9 окт 2026).
//!
//! Ключ восстановления едет в чат владельца с ботом сразу после создания
//! личности; при входе с нового устройства бот просит ответить этим ключом, а
//! ответ отдаётся новому устройству. Сервер и Telegram при этом видят ключ
//! открытым текстом — поэтому он НЕ пишется в базу (и не попадает в бэкапы):
//! очередь сообщений бота и ответы живут только в памяти процесса с коротким
//! сроком. После перезапуска identity клиент просто повторяет запрос.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use parvane_protocol::pb::parvane::identity::v2 as pb;
use tokio::sync::Notify;
use zeroize::Zeroizing;

/// Сколько сообщение ждёт бота.
const OUT_TTL_SECS: i64 = 600;
/// Бот не подтвердил доставку — отдаём сообщение снова.
const REDELIVER_SECS: i64 = 15;
/// Сколько новое устройство ждёт ответа владельца.
const REQUEST_TTL_SECS: i64 = 900;
/// Очередь бота не растёт без предела (бот выключен, а клиенты шлют).
const OUT_MAX: usize = 2048;

pub(crate) const KIND_KEY: &str = "key";
pub(crate) const KIND_ASK: &str = "ask";

struct OutMessage {
    id: u64,
    telegram_id: i64,
    kind: &'static str,
    user: String,
    recovery_key: Zeroizing<String>,
    client: String,
    created: i64,
    sent_at: i64,
}

struct Pending {
    device_id: String,
    created: i64,
    recovery_key: Option<Zeroizing<String>>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    out: Vec<OutMessage>,
    /// Пользователь → запрос ключа с нового устройства (один на аккаунт).
    pending: HashMap<String, Pending>,
}

fn state() -> MutexGuard<'static, State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default())).lock().unwrap_or_else(|e| e.into_inner())
}

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

fn purge(st: &mut State, now: i64) {
    st.out.retain(|m| now - m.created < OUT_TTL_SECS);
    st.pending.retain(|_, p| now - p.created < REQUEST_TTL_SECS);
}

fn enqueue(st: &mut State, telegram_id: i64, kind: &'static str, user: &str, recovery_key: &str, client: &str, now: i64) -> bool {
    if st.out.len() >= OUT_MAX {
        return false;
    }
    st.next_id += 1;
    st.out.push(OutMessage {
        id: st.next_id,
        telegram_id,
        kind,
        user: user.to_string(),
        recovery_key: Zeroizing::new(recovery_key.to_string()),
        client: client.to_string(),
        created: now,
        sent_at: 0,
    });
    true
}

/// Сообщение с ключом восстановления — в чат владельца. Прежнее недоставленное
/// сообщение с ключом этого аккаунта заменяется (ключ мог смениться).
pub(crate) fn send_key(telegram_id: i64, user: &str, recovery_key: &str, now: i64) -> bool {
    let mut st = state();
    purge(&mut st, now);
    st.out.retain(|m| !(m.kind == KIND_KEY && m.user == user));
    let queued = enqueue(&mut st, telegram_id, KIND_KEY, user, recovery_key, "", now);
    drop(st);
    wake().notify_waiters();
    queued
}

/// Новое устройство просит ключ: бот спросит владельца. Повторный запрос того
/// же устройства, пока прежний ждёт ответа, сообщение не дублирует (клиент
/// повторяет запрос при каждом переподключении); `again` — владелец сам
/// попросил прислать сообщение ещё раз.
pub(crate) fn request_key(telegram_id: i64, user: &str, device_id: &str, client: &str, again: bool, now: i64) -> bool {
    let mut st = state();
    purge(&mut st, now);
    if !again && st.pending.get(user).is_some_and(|p| p.device_id == device_id) {
        return true;
    }
    st.pending.insert(user.to_string(), Pending { device_id: device_id.to_string(), created: now, recovery_key: None });
    st.out.retain(|m| !(m.kind == KIND_ASK && m.user == user));
    let queued = enqueue(&mut st, telegram_id, KIND_ASK, user, "", client, now);
    drop(st);
    wake().notify_waiters();
    queued
}

/// Аккаунт ждёт ответа владельца (есть запрос нового устройства).
pub(crate) fn has_request(user: &str, now: i64) -> bool {
    let mut st = state();
    purge(&mut st, now);
    st.pending.contains_key(user)
}

/// Проверенный ключ из ответа владельца — запросившему устройству.
pub(crate) fn store_reply(user: &str, recovery_key: &str, now: i64) -> bool {
    let mut st = state();
    purge(&mut st, now);
    match st.pending.get_mut(user) {
        Some(p) => {
            p.recovery_key = Some(Zeroizing::new(recovery_key.to_string()));
            true
        }
        None => false,
    }
}

/// Действующее устройство аккаунта без копии ключей (аккаунт создан до spec 015)
/// забирает ключ из ответа владельца, чтобы завести копию: тогда новое устройство
/// войдёт по ней, и прежние устройства не придётся отзывать.
pub(crate) fn peek_reply(user: &str, now: i64) -> String {
    let mut st = state();
    purge(&mut st, now);
    st.pending.get(user).and_then(|p| p.recovery_key.as_ref()).map(|k| k.to_string()).unwrap_or_default()
}

const GROUPS: usize = 10;
const GROUP_CHARS: usize = 4;
/// Сколько посторонних знаков допустимо между группами ключа (« - », «—», перенос).
const MAX_GAP: usize = 3;

/// Места в тексте, похожие на ключ восстановления: десять групп по четыре знака
/// (между группами — до трёх любых знаков) либо сорок знаков подряд. Владелец
/// часто присылает ключ вместе с куском окружающего текста или с длинным тире
/// вместо дефиса; настоящий ключ из кандидатов выбирает контрольная сумма.
pub(crate) fn key_candidates(text: &str) -> Vec<String> {
    // Отрезки латиницы и цифр и число знаков перед каждым
    let mut runs: Vec<(usize, String)> = Vec::new();
    let (mut gap, mut current) = (0usize, String::new());
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            current.push(c.to_ascii_uppercase());
        } else {
            if !current.is_empty() {
                runs.push((gap, std::mem::take(&mut current)));
                gap = 0;
            }
            gap += 1;
        }
    }
    if !current.is_empty() {
        runs.push((gap, current));
    }
    let mut out = Vec::new();
    let mut chain: Vec<&str> = Vec::new();
    for (gap, run) in &runs {
        if run.len() == GROUPS * GROUP_CHARS {
            out.push(run.as_bytes().chunks(GROUP_CHARS).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-"));
        }
        if run.len() != GROUP_CHARS {
            chain.clear();
            continue;
        }
        if !chain.is_empty() && *gap > MAX_GAP {
            chain.clear();
        }
        chain.push(run);
        if chain.len() > GROUPS {
            chain.remove(0);
        }
        if chain.len() == GROUPS {
            out.push(chain.join("-"));
        }
    }
    out
}

/// Опрос нового устройства: (ключ или пусто, запрос ещё жив). `done` — ключ
/// применён, стереть.
pub(crate) fn poll(user: &str, device_id: &str, done: bool, now: i64) -> (String, bool) {
    let mut st = state();
    purge(&mut st, now);
    let mine = st.pending.get(user).is_some_and(|p| p.device_id == device_id);
    if !mine {
        return (String::new(), false);
    }
    if done {
        st.pending.remove(user);
        return (String::new(), false);
    }
    let key = st.pending.get(user).and_then(|p| p.recovery_key.as_ref()).map(|k| k.to_string()).unwrap_or_default();
    (key, true)
}

fn take_out(acks: &[u64], now: i64) -> Vec<pb::TelegramOutMessage> {
    let mut st = state();
    purge(&mut st, now);
    st.out.retain(|m| !acks.contains(&m.id));
    st.out
        .iter_mut()
        .filter(|m| m.sent_at == 0 || now - m.sent_at >= REDELIVER_SECS)
        .map(|m| {
            m.sent_at = now;
            pb::TelegramOutMessage {
                id: m.id,
                telegram_id: m.telegram_id,
                kind: m.kind.to_string(),
                user: m.user.clone(),
                recovery_key: m.recovery_key.to_string(),
                client: m.client.clone(),
            }
        })
        .collect()
}

/// Сообщения для бота; пусто — ждём появления до `wait_ms`.
pub(crate) async fn pull(acks: &[u64], wait_ms: u64, now: i64) -> Vec<pb::TelegramOutMessage> {
    // Ожидание регистрируется ДО проверки очереди: иначе сообщение, пришедшее
    // между проверкой и ожиданием, осталось бы без побудки
    let notified = wake().notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    let ready = take_out(acks, now);
    if !ready.is_empty() || wait_ms == 0 {
        return ready;
    }
    let _ = tokio::time::timeout(std::time::Duration::from_millis(wait_ms), notified).await;
    take_out(&[], crate::now_unix())
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    let mut st = state();
    st.out.clear();
    st.pending.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_found_inside_surrounding_text() {
        let key = "0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ-0123-4567";
        assert_eq!(key_candidates(key), vec![key.to_string()]);
        // Строчными, через пробелы, длинное тире, без разделителей
        assert_eq!(key_candidates(&key.to_lowercase().replace('-', " ")), vec![key.to_string()]);
        assert_eq!(key_candidates(&key.replace('-', " — ")), vec![key.to_string()]);
        assert_eq!(key_candidates(&key.replace('-', "")), vec![key.to_string()]);
        // Вместе с текстом сообщения бота или диалога приложения
        let pasted = format!("🔑 Ключ восстановления аккаунта @daria в Parvane:\n\n{key}\n\nНе удаляйте это сообщение.");
        assert_eq!(key_candidates(&pasted), vec![key.to_string()]);
        let dialog = format!("Save your recovery key: {key}\nIt restores your account keys on a new device.");
        assert!(key_candidates(&dialog).contains(&key.to_string()));
        // Не ключ
        assert!(key_candidates("привет, это не ключ").is_empty());
        assert!(key_candidates("0123-4567-89AB").is_empty());
        // Группы, разнесённые по тексту, ключом не считаются
        assert!(key_candidates(&key.replace('-', " слово и ещё ")).is_empty());
    }

    // Состояние общее на процесс — тесты модуля идут одним тестом, по своим адресам
    #[tokio::test]
    async fn queue_and_requests() {
        reset_for_tests();
        let now = 1_000_000;

        // Ключ: доставляется, без подтверждения отдаётся снова, после — нет
        assert!(send_key(11, "a@x", "KEY-1", now));
        let first = pull(&[], 0, now).await;
        assert_eq!(first.len(), 1);
        assert_eq!((first[0].kind.as_str(), first[0].recovery_key.as_str(), first[0].telegram_id), ("key", "KEY-1", 11));
        assert!(pull(&[], 0, now + 1).await.is_empty());
        assert_eq!(pull(&[], 0, now + REDELIVER_SECS).await.len(), 1);
        assert!(pull(&[first[0].id], 0, now + 2 * REDELIVER_SECS).await.is_empty());

        // Новый ключ аккаунта заменяет недоставленный прежний
        assert!(send_key(11, "a@x", "KEY-2", now));
        assert!(send_key(11, "a@x", "KEY-3", now));
        let replaced = pull(&[], 0, now).await;
        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].recovery_key, "KEY-3");
        pull(&[replaced[0].id], 0, now).await;

        // Запрос нового устройства: один вопрос, повтор не дублирует
        assert!(!has_request("b@x", now));
        assert!(request_key(22, "b@x", "dev-1", "Chrome, Android", false, now));
        let asks = pull(&[], 0, now + 1).await;
        assert_eq!(asks.len(), 1);
        // Бот доставил вопрос; переподключение клиента новый вопрос не шлёт
        assert!(pull(&[asks[0].id], 0, now + 1).await.is_empty());
        assert!(request_key(22, "b@x", "dev-1", "Chrome, Android", false, now + 2));
        assert!(pull(&[], 0, now + 2).await.is_empty());
        // «Прислать ещё раз» — шлёт
        assert!(request_key(22, "b@x", "dev-1", "Chrome, Android", true, now + 2));
        let again = pull(&[], 0, now + 2).await;
        assert_eq!(again.len(), 1);
        pull(&[again[0].id], 0, now + 2).await;
        assert_eq!((asks[0].kind.as_str(), asks[0].client.as_str()), ("ask", "Chrome, Android"));
        assert!(asks[0].recovery_key.is_empty());
        assert!(has_request("b@x", now + 1));

        // До ответа ключа нет; ответ виден только запросившему устройству
        assert_eq!(poll("b@x", "dev-1", false, now + 2), (String::new(), true));
        assert!(store_reply("b@x", "KEY-B", now + 3));
        assert_eq!(poll("b@x", "dev-2", false, now + 3), (String::new(), false));
        assert_eq!(poll("b@x", "dev-1", false, now + 3), ("KEY-B".to_string(), true));
        // Повторный опрос (обрыв связи у клиента) отдаёт ключ снова — до `done`
        assert_eq!(poll("b@x", "dev-1", false, now + 4), ("KEY-B".to_string(), true));
        assert_eq!(poll("b@x", "dev-1", true, now + 5), (String::new(), false));
        assert!(!has_request("b@x", now + 5));

        // Ответ без запроса не принимается; запрос истекает
        assert!(!store_reply("c@x", "KEY-C", now));
        assert!(request_key(33, "c@x", "dev-9", "", false, now));
        assert!(!has_request("c@x", now + REQUEST_TTL_SECS));
        assert!(!store_reply("c@x", "KEY-C", now + REQUEST_TTL_SECS));

        // Действующее устройство видит ответ владельца, пока запрос жив
        assert!(request_key(55, "e@x", "dev-new", "", false, now));
        assert_eq!(peek_reply("e@x", now), "");
        assert!(store_reply("e@x", "KEY-E", now));
        assert_eq!(peek_reply("e@x", now), "KEY-E");
        poll("e@x", "dev-new", true, now);
        assert_eq!(peek_reply("e@x", now), "");

        // Ожидание: сообщение, появившееся во время опроса, будит его
        reset_for_tests();
        let waiter = tokio::spawn(async move { pull(&[], 5_000, crate::now_unix()).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(send_key(44, "d@x", "KEY-D", crate::now_unix()));
        let woken = tokio::time::timeout(std::time::Duration::from_secs(2), waiter).await.expect("опрос проснулся").expect("задача");
        assert_eq!(woken.len(), 1);
        assert_eq!(woken[0].user, "d@x");
        reset_for_tests();
    }
}
