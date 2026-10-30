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
/// Подпись устройства в вопросе боту: клиент задаёт её сам, поэтому длина и знаки ограничены.
const CLIENT_LABEL_MAX: usize = 64;

pub(crate) const KIND_KEY: &str = "key";
pub(crate) const KIND_ASK: &str = "ask";

struct OutMessage {
    id: u64,
    telegram_id: i64,
    kind: &'static str,
    user: String,
    recovery_key: Zeroizing<String>,
    client: String,
    /// Для "ask": запрос устройства, которому адресована просьба.
    request_id: u64,
    code: String,
    created: i64,
    sent_at: i64,
}

/// Запрос ключа с одного нового устройства. На аккаунт их несколько (до `PENDING_MAX`):
/// ответ владельца привязан к номеру запроса, а не к «последнему запросившему» (A0023-1).
struct Pending {
    request_id: u64,
    device_id: String,
    created: i64,
    /// Эфемерный открытый ключ X25519 устройства; пусто — прежний клиент (ответ открытым текстом).
    eph_public: Vec<u8>,
    /// Код сверки: назначает сервер, показывают бот и экран устройства.
    code: String,
    /// Ответ владельца, запечатанный на `eph_public`.
    sealed: Option<Vec<u8>>,
    /// Открытый ключ: прежние клиенты без `eph_public` и аккаунты без копии ключей (см. `peek_reply`).
    recovery_key: Option<Zeroizing<String>>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    next_request: u64,
    out: Vec<OutMessage>,
    /// Пользователь → запросы ключа с новых устройств.
    pending: HashMap<String, Vec<Pending>>,
}

/// Сколько устройств аккаунта могут одновременно ждать ключ. Больше — отказ, а не вытеснение:
/// знающий пароль не должен выдавливать запрос владельца.
const PENDING_MAX: usize = 3;

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
    for list in st.pending.values_mut() {
        list.retain(|p| now - p.created < REQUEST_TTL_SECS);
    }
    st.pending.retain(|_, list| !list.is_empty());
}

#[allow(clippy::too_many_arguments)]
fn enqueue(st: &mut State, telegram_id: i64, kind: &'static str, user: &str, recovery_key: &str, client: &str, request: (u64, &str), now: i64) -> bool {
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
        client: client.chars().filter(|c| !c.is_control()).take(CLIENT_LABEL_MAX).collect(),
        request_id: request.0,
        code: request.1.to_string(),
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
    let queued = enqueue(&mut st, telegram_id, KIND_KEY, user, recovery_key, "", (0, ""), now);
    drop(st);
    wake().notify_waiters();
    queued
}

/// Шесть цифр кода сверки, не совпадающих с кодами других живых запросов аккаунта.
fn fresh_code(taken: &[Pending]) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    loop {
        let code = format!("{:06}", rng.gen_range(0..1_000_000u32));
        if !taken.iter().any(|p| p.code == code) {
            return code;
        }
    }
}

/// Новое устройство просит ключ: бот спросит владельца. Возвращает код сверки (`None` — очередь
/// бота полна либо у аккаунта уже `PENDING_MAX` живых запросов других устройств).
/// Запрос привязан к устройству: чужой запрос ни замещает, ни гасит его (A0023-1).
/// Повтор того же устройства с тем же ключом сообщение не дублирует (клиент повторяет запрос
/// при каждом переподключении); `again` — владелец сам попросил прислать сообщение ещё раз.
/// Другой эфемерный ключ у того же устройства — клиент перезапущен: запрос начинается заново.
pub(crate) fn request_key(telegram_id: i64, user: &str, device_id: &str, client: &str, eph_public: &[u8], again: bool, now: i64) -> Option<String> {
    let mut st = state();
    purge(&mut st, now);
    let list = st.pending.entry(user.to_string()).or_default();
    let mut resend: Option<(u64, String)> = None;
    if let Some(i) = list.iter().position(|p| p.device_id == device_id) {
        if list[i].eph_public == eph_public {
            if !again {
                return Some(list[i].code.clone());
            }
            resend = Some((list[i].request_id, list[i].code.clone()));
        } else {
            let old = list.remove(i).request_id;
            st.out.retain(|m| !(m.kind == KIND_ASK && m.request_id == old));
        }
    }
    let (request_id, code) = match resend {
        Some(r) => r,
        None => {
            let list = st.pending.entry(user.to_string()).or_default();
            if list.len() >= PENDING_MAX {
                if list.is_empty() {
                    st.pending.remove(user);
                }
                return None;
            }
            let code = fresh_code(list);
            st.next_request += 1;
            let request_id = st.next_request;
            st.pending.entry(user.to_string()).or_default().push(Pending {
                request_id,
                device_id: device_id.to_string(),
                created: now,
                eph_public: eph_public.to_vec(),
                code: code.clone(),
                sealed: None,
                recovery_key: None,
            });
            (request_id, code)
        }
    };
    st.out.retain(|m| !(m.kind == KIND_ASK && m.request_id == request_id));
    let queued = enqueue(&mut st, telegram_id, KIND_ASK, user, "", client, (request_id, &code), now);
    drop(st);
    wake().notify_waiters();
    queued.then_some(code)
}

/// Аккаунт ждёт ответа владельца (есть запрос нового устройства).
#[cfg(test)]
pub(crate) fn has_request(user: &str, now: i64) -> bool {
    let mut st = state();
    purge(&mut st, now);
    st.pending.contains_key(user)
}

/// Устройство, на запрос которого отвечает владелец.
pub(crate) struct Target {
    pub request_id: u64,
    pub device_id: String,
    pub eph_public: Vec<u8>,
}

/// Запрос, который закрывает ответ владельца: по номеру из сообщения бота; без номера (старый бот) —
/// единственный живой запрос аккаунта, при нескольких — никакой.
pub(crate) fn target(user: &str, request_id: u64, now: i64) -> Option<Target> {
    let mut st = state();
    purge(&mut st, now);
    let list = st.pending.get(user)?;
    let p = if request_id == 0 {
        if list.len() != 1 {
            return None;
        }
        &list[0]
    } else {
        list.iter().find(|p| p.request_id == request_id)?
    };
    Some(Target { request_id: p.request_id, device_id: p.device_id.clone(), eph_public: p.eph_public.clone() })
}

/// Проверенный ключ из ответа владельца — запросившему устройству: запечатанный на его ключ либо
/// (прежний клиент, аккаунт без копии ключей) открытым текстом.
pub(crate) fn store_reply(user: &str, request_id: u64, sealed: Option<Vec<u8>>, plain: Option<&str>, now: i64) -> bool {
    let mut st = state();
    purge(&mut st, now);
    let Some(p) = st.pending.get_mut(user).and_then(|l| l.iter_mut().find(|p| p.request_id == request_id)) else { return false };
    p.sealed = sealed;
    p.recovery_key = plain.map(|k| Zeroizing::new(k.to_string()));
    true
}

/// Действующее устройство аккаунта без копии ключей (аккаунт создан до spec 015) забирает ключ
/// из ответа владельца, чтобы завести копию: тогда новое устройство войдёт по ней, и прежние
/// устройства не придётся отзывать. Открытый ключ хранится только в этом случае и у прежних клиентов.
pub(crate) fn peek_reply(user: &str, now: i64) -> String {
    let mut st = state();
    purge(&mut st, now);
    st.pending.get(user).and_then(|l| l.iter().find_map(|p| p.recovery_key.as_ref())).map(|k| k.to_string()).unwrap_or_default()
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

/// Ответ на опрос нового устройства.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PollView {
    /// Открытый ключ (только запрос без эфемерного ключа).
    pub recovery_key: String,
    pub sealed: Vec<u8>,
    pub pending: bool,
    pub code: String,
}

/// Опрос нового устройства. `done` — ключ применён, стереть.
pub(crate) fn poll(user: &str, device_id: &str, done: bool, now: i64) -> PollView {
    let mut st = state();
    purge(&mut st, now);
    let Some(list) = st.pending.get_mut(user) else { return PollView::default() };
    let Some(i) = list.iter().position(|p| p.device_id == device_id) else { return PollView::default() };
    if done {
        let gone = list.remove(i).request_id;
        st.out.retain(|m| !(m.kind == KIND_ASK && m.request_id == gone));
        return PollView::default();
    }
    let p = &list[i];
    PollView {
        // Запрос с эфемерным ключом открытым текстом не отдаётся никогда
        recovery_key: if p.eph_public.is_empty() { p.recovery_key.as_ref().map(|k| k.to_string()).unwrap_or_default() } else { String::new() },
        sealed: p.sealed.clone().unwrap_or_default(),
        pending: true,
        code: p.code.clone(),
    }
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
                request_id: m.request_id,
                code: m.code.clone(),
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

    #[test]
    fn client_label_is_bounded() {
        let mut st = State::default();
        let long = format!("Chrome\n{}", "я".repeat(5000));
        assert!(enqueue(&mut st, 1, KIND_ASK, "a@x", "", &long, (1, "000001"), 0));
        let label = &st.out[0].client;
        assert!(label.chars().count() <= CLIENT_LABEL_MAX && !label.contains('\n'));
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
        let k1 = [1u8; 32];
        let k2 = [2u8; 32];
        assert!(!has_request("b@x", now));
        let code = request_key(22, "b@x", "dev-1", "Chrome, Android", &k1, false, now).expect("код");
        assert_eq!(code.len(), 6);
        let asks = pull(&[], 0, now + 1).await;
        assert_eq!(asks.len(), 1);
        assert_eq!((asks[0].code.as_str(), asks[0].request_id > 0), (code.as_str(), true));
        // Бот доставил вопрос; переподключение клиента новый вопрос не шлёт и код не меняет
        assert!(pull(&[asks[0].id], 0, now + 1).await.is_empty());
        assert_eq!(request_key(22, "b@x", "dev-1", "Chrome, Android", &k1, false, now + 2), Some(code.clone()));
        assert!(pull(&[], 0, now + 2).await.is_empty());
        // «Прислать ещё раз» — шлёт тот же запрос
        assert_eq!(request_key(22, "b@x", "dev-1", "Chrome, Android", &k1, true, now + 2), Some(code.clone()));
        let again = pull(&[], 0, now + 2).await;
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].request_id, asks[0].request_id);
        pull(&[again[0].id], 0, now + 2).await;
        assert_eq!((asks[0].kind.as_str(), asks[0].client.as_str()), ("ask", "Chrome, Android"));
        assert!(asks[0].recovery_key.is_empty());
        assert!(has_request("b@x", now + 1));
        let rid_b = asks[0].request_id;

        // A0023-1: запрос другого устройства не замещает и не гасит первый, у него свой код и номер;
        // ответ владельца достаётся тому, на чей запрос он отвечает
        let code2 = request_key(22, "b@x", "dev-evil", "Chrome, Android", &k2, false, now + 2).expect("второй запрос");
        assert_ne!(code2, code);
        let evil_ask = pull(&[], 0, now + 2).await;
        assert_eq!(evil_ask.len(), 1);
        let rid_evil = evil_ask[0].request_id;
        assert_ne!(rid_evil, rid_b);
        pull(&[evil_ask[0].id], 0, now + 2).await;
        // Без номера при двух живых запросах ответ не принимается
        assert!(target("b@x", 0, now + 3).is_none());
        let t = target("b@x", rid_b, now + 3).expect("цель");
        assert_eq!((t.device_id.as_str(), t.eph_public.as_slice()), ("dev-1", &k1[..]));
        assert!(target("b@x", rid_b + 1000, now + 3).is_none());
        assert!(store_reply("b@x", rid_b, Some(vec![9; 40]), None, now + 3));
        // Чужое устройство ничего не получает; тому, чей запрос, — запечатанный ответ, но не открытый
        assert!(poll("b@x", "dev-evil", false, now + 3).sealed.is_empty());
        let mine = poll("b@x", "dev-1", false, now + 3);
        assert_eq!((mine.sealed.as_slice(), mine.recovery_key.as_str(), mine.pending, mine.code.as_str()), (&[9u8; 40][..], "", true, code.as_str()));
        assert_eq!(peek_reply("b@x", now + 3), "", "открытого ключа сервер не держит");
        // Повторный опрос (обрыв связи у клиента) отдаёт ответ снова — до `done`
        assert_eq!(poll("b@x", "dev-1", false, now + 4).sealed.len(), 40);
        assert_eq!(poll("b@x", "dev-1", true, now + 5), PollView::default());
        // Чужой запрос остался жив
        assert!(poll("b@x", "dev-evil", false, now + 5).pending);
        assert!(has_request("b@x", now + 5));
        // Новый эфемерный ключ того же устройства начинает запрос заново
        assert!(request_key(22, "b@x", "dev-evil", "x", &k1, false, now + 6).is_some());
        assert_eq!(target("b@x", rid_evil, now + 6).map(|t| t.request_id), None, "прежний номер сгорел");

        // Лимит одновременных запросов аккаунта: больше — отказ, прежние не вытесняются
        assert!(request_key(22, "l@x", "d1", "", &k1, false, now).is_some());
        assert!(request_key(22, "l@x", "d2", "", &k1, false, now).is_some());
        assert!(request_key(22, "l@x", "d3", "", &k1, false, now).is_some());
        assert!(request_key(22, "l@x", "d4", "", &k1, false, now).is_none());
        assert!(poll("l@x", "d1", false, now).pending);

        // Прежний клиент без эфемерного ключа: ответ открытым текстом, единственный запрос — без номера
        assert!(request_key(66, "o@x", "dev-old", "", &[], false, now).is_some());
        let old = target("o@x", 0, now).expect("единственный запрос");
        assert!(store_reply("o@x", old.request_id, None, Some("KEY-O"), now));
        assert_eq!(poll("o@x", "dev-old", false, now).recovery_key, "KEY-O");
        assert_eq!(poll("o@x", "dev-x", false, now), PollView::default());
        // Запрос с эфемерным ключом открытым текстом не отдаётся, даже если он сохранён для копии ключей
        assert!(request_key(67, "p@x", "dev-p", "", &k1, false, now).is_some());
        let tp = target("p@x", 0, now).expect("цель");
        assert!(store_reply("p@x", tp.request_id, Some(vec![1; 40]), Some("KEY-P"), now));
        let pv = poll("p@x", "dev-p", false, now);
        assert_eq!((pv.recovery_key.as_str(), pv.sealed.len()), ("", 40));
        assert_eq!(peek_reply("p@x", now), "KEY-P");

        // Ответ без запроса не принимается; запрос истекает
        assert!(!store_reply("c@x", 1, None, Some("KEY-C"), now));
        assert!(request_key(33, "c@x", "dev-9", "", &[], false, now).is_some());
        assert!(!has_request("c@x", now + REQUEST_TTL_SECS));
        assert!(target("c@x", 0, now + REQUEST_TTL_SECS).is_none());

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
