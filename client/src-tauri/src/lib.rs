// Мост между фронтендом и бэкендом Parvane.
// Rust-сторона подключается к NATS (как шарды) и отдаёт фронтенду Tauri-команды.

use std::{collections::HashMap, sync::Arc};

use parvane_types::{
    content_checksum, event_checksum, CalDeletePayload, CalEventSnapshot, CalSetPayload,
    CallHistoryRequest,
    CallHistoryResponse, FileListPayload, FileListResponse, IssueRequest, IssueResponse,
    MessageContent, NoteCreatePayload, NoteDeletePayload, NoteOp, NoteSnapshot,
    NoteSyncRequestPayload, NoteSyncResponsePayload, NoteUpdatePayload, ParvaneEvent, SendPayload,
    Stamp, StoredMessage, SyncRequestPayload, SyncResponsePayload,
    topics::{
        CAL_CREATE, CAL_DELETE, CAL_SYNC_REQUEST, CAL_UPDATE, CALL_HISTORY_REQUEST,
        FILE_LIST_REQUEST, IDENTITY_ISSUE, MSG_SEND, MSG_SYNC_REQUEST, NOTE_CREATE, NOTE_DELETE,
        NOTE_SYNC_REQUEST, NOTE_UPDATE,
    },
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

// ── состояние приложения ──────────────────────────────────────────────────────

#[derive(Default)]
struct AppState {
    nats: Option<async_nats::Client>,
    token: Option<String>,
    user: Option<String>,
    // notes: локальный кеш (local-first), переживает рестарт через диск
    notes: HashMap<Uuid, NoteSnapshot>,
    // calendar: локальный кеш событий (local-first)
    events: HashMap<Uuid, CalEventSnapshot>,
    // messenger: локальный кеш сообщений (append-only, курсор = max id)
    messages: Vec<StoredMessage>,
    // каталог для персистентного кеша (app_data_dir)
    cache_dir: Option<std::path::PathBuf>,
}

type Shared = Arc<Mutex<AppState>>;

fn e2s<E: std::fmt::Display>(e: E) -> String { e.to_string() }

// ── локальный кеш заметок на диске (local-first) ───────────────────────────────

/// Имя файла безопасное из user (alice@host → alice_host).
fn sanitize_user(user: &str) -> String {
    user.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
}

fn notes_cache_path(s: &AppState) -> Option<std::path::PathBuf> {
    let dir = s.cache_dir.as_ref()?;
    let user = s.user.as_ref()?;
    Some(dir.join(format!("notes-{}.json", sanitize_user(user))))
}

/// Записать текущий кеш заметок на диск. Тихо игнорирует ошибки IO.
fn persist_notes(s: &AppState) {
    if let Some(path) = notes_cache_path(s) {
        let all: Vec<&NoteSnapshot> = s.notes.values().collect();
        if let Ok(json) = serde_json::to_vec(&all) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, json);
        }
    }
}

/// Загрузить кеш заметок с диска в state (новое устройство → файла нет → пусто).
fn load_notes(s: &mut AppState) {
    if let Some(path) = notes_cache_path(s) {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(v) = serde_json::from_slice::<Vec<NoteSnapshot>>(&bytes) {
                s.notes.clear();
                for mut n in v {
                    if n.checksum == 0 {
                        n.checksum = content_checksum(&n.title, &n.text);
                    }
                    s.notes.insert(n.note_id, n);
                }
            }
        }
    }
}

// ── локальный кеш событий календаря ────────────────────────────────────────────

fn cache_path(s: &AppState, prefix: &str) -> Option<std::path::PathBuf> {
    let dir = s.cache_dir.as_ref()?;
    let user = s.user.as_ref()?;
    Some(dir.join(format!("{}-{}.json", prefix, sanitize_user(user))))
}

fn persist_events(s: &AppState) {
    if let Some(path) = cache_path(s, "events") {
        let all: Vec<&CalEventSnapshot> = s.events.values().collect();
        if let Ok(json) = serde_json::to_vec(&all) {
            if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
            let _ = std::fs::write(path, json);
        }
    }
}

fn load_events(s: &mut AppState) {
    if let Some(path) = cache_path(s, "events") {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(v) = serde_json::from_slice::<Vec<CalEventSnapshot>>(&bytes) {
                s.events.clear();
                for mut e in v {
                    if e.checksum == 0 { e.checksum = event_checksum(&e); }
                    s.events.insert(e.event_id, e);
                }
            }
        }
    }
}

// ── локальный кеш сообщений (append-only) ──────────────────────────────────────

fn persist_messages(s: &AppState) {
    if let Some(path) = cache_path(s, "messages") {
        if let Ok(json) = serde_json::to_vec(&s.messages) {
            if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
            let _ = std::fs::write(path, json);
        }
    }
}

fn load_messages(s: &mut AppState) {
    if let Some(path) = cache_path(s, "messages") {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(v) = serde_json::from_slice::<Vec<StoredMessage>>(&bytes) {
                s.messages = v;
            }
        }
    }
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

// ── утилиты ───────────────────────────────────────────────────────────────────

/// Подключён ли мост к NATS.
#[tauri::command]
async fn nats_status(state: State<'_, Shared>) -> Result<bool, String> {
    Ok(state.lock().await.nats.is_some())
}

/// Текущий залогиненный пользователь (null если нет).
#[tauri::command]
async fn current_user(state: State<'_, Shared>) -> Result<Option<String>, String> {
    Ok(state.lock().await.user.clone())
}

// ── identity ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn login(user: String, password: String, state: State<'_, Shared>) -> Result<String, String> {
    eprintln!("[bridge] login({user})");
    let client = state.lock().await.nats.clone().ok_or("NATS не подключён")?;
    let req = serde_json::to_vec(&IssueRequest { user: user.clone(), password }).map_err(e2s)?;
    let reply = client.request(IDENTITY_ISSUE, req.into()).await.map_err(e2s)?;
    let resp: IssueResponse = serde_json::from_slice(&reply.payload).map_err(e2s)?;
    if resp.ok {
        let token = resp.token.ok_or("identity вернул ok без токена")?;
        let mut s = state.lock().await;
        s.token = Some(token.clone());
        s.user = Some(user);
        // Поднимаем локальные кеши этого пользователя с диска (local-first).
        load_notes(&mut s);
        load_events(&mut s);
        load_messages(&mut s);
        Ok(token)
    } else {
        Err(resp.error.unwrap_or_else(|| "ошибка логина".into()))
    }
}

#[tauri::command]
async fn logout(state: State<'_, Shared>) -> Result<(), String> {
    let mut s = state.lock().await;
    s.token = None;
    s.user = None;
    s.notes.clear();
    s.events.clear();
    s.messages.clear();
    Ok(())
}

// ── messenger ─────────────────────────────────────────────────────────────────

/// Загружает все сообщения (адресованные мне) и группирует по собеседнику.
/// Возвращает список бесед, отсортированных по времени последнего сообщения.
#[derive(Serialize)]
pub struct ConversationInfo {
    peer: String,
    last_text: String,
    last_ts: i64,
    unread: usize,
}

#[tauri::command]
async fn get_conversations(state: State<'_, Shared>) -> Result<Vec<ConversationInfo>, String> {
    let all2 = do_sync_all(state.clone()).await?;
    let me = state.lock().await.user.clone().unwrap_or_default();

    let mut peer_map: HashMap<String, (String, i64)> = HashMap::new();
    let mut unread_map: HashMap<String, usize> = HashMap::new();

    for msg in &all2 {
        let peer = if msg.from == me { msg.to.clone() } else { msg.from.clone() };
        let text = match &msg.content {
            MessageContent::Text { text } => text.clone(),
            MessageContent::Voice { .. } => "🎤 Голосовое".to_string(),
            MessageContent::VideoNote { .. } => "🎥 Кружочек".to_string(),
            MessageContent::Photo { .. } => "🖼 Фото".to_string(),
            MessageContent::Video { .. } => "📹 Видео".to_string(),
            MessageContent::File { filename, .. } => format!("📎 {}", filename),
        };
        let entry = peer_map.entry(peer.clone()).or_insert(("".to_string(), 0));
        if msg.ts > entry.1 {
            *entry = (text, msg.ts);
        }
        if msg.from != me {
            *unread_map.entry(peer).or_insert(0) += 1;
        }
    }

    let mut convs: Vec<ConversationInfo> = peer_map
        .into_iter()
        .map(|(peer, (last_text, last_ts))| ConversationInfo {
            unread: *unread_map.get(&peer).unwrap_or(&0),
            peer,
            last_text,
            last_ts,
        })
        .collect();
    convs.sort_by(|a, b| b.last_ts.cmp(&a.last_ts));
    Ok(convs)
}

/// Все сообщения с конкретным собеседником (отправленные мне от него + мои ему).
/// Возвращает только сообщения, где from=peer и to=me ИЛИ from=me и to=peer.
#[tauri::command]
async fn get_messages(peer: String, state: State<'_, Shared>) -> Result<Vec<StoredMessage>, String> {
    let all = do_sync_all(state.clone()).await?;
    let me = state.lock().await.user.clone().unwrap_or_default();
    let filtered: Vec<StoredMessage> = all
        .into_iter()
        .filter(|m| (m.from == peer && m.to == me) || (m.from == me && m.to == peer))
        .collect();
    Ok(filtered)
}

/// Отправить текстовое сообщение.
#[tauri::command]
async fn send_text(to: String, text: String, state: State<'_, Shared>) -> Result<String, String> {
    eprintln!("[bridge] send_text(to={to})");
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let id = Uuid::now_v7();
    let ev = ParvaneEvent {
        id,
        from,
        ts: now_ts(),
        token,
        payload: SendPayload { to, content: MessageContent::Text { text } },
    };
    client.publish(MSG_SEND, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    Ok(id.to_string())
}

/// Внутренняя: local-first инкрементальная синхронизация сообщений.
/// Держит кеш на диске, у сервера запрашивает только то, что новее курсора
/// (max id в кеше) — append-only лог, поэтому контрольные суммы не нужны.
async fn do_sync_all(state: State<'_, Shared>) -> Result<Vec<StoredMessage>, String> {
    // Поднимаем кеш с диска, если ещё не подняли, и вычисляем курсор.
    let (client, token, from, cursor) = {
        let mut s = state.lock().await;
        if s.messages.is_empty() {
            load_messages(&mut s);
        }
        let cursor = s
            .messages
            .iter()
            .map(|m| m.id)
            .max()
            .map(|u| u.to_string())
            .unwrap_or_else(|| "00000000-0000-0000-0000-000000000000".to_string());
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
            cursor,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: SyncRequestPayload { last_seen_id: cursor },
    };
    let reply = client
        .request(MSG_SYNC_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: ParvaneEvent<SyncResponsePayload> =
        serde_json::from_slice(&reply.payload).map_err(e2s)?;

    // Дописываем только новое (дедуп по id), сортируем по id, сохраняем на диск.
    let mut s = state.lock().await;
    if !resp.payload.messages.is_empty() {
        let existing: std::collections::HashSet<Uuid> = s.messages.iter().map(|m| m.id).collect();
        for m in resp.payload.messages {
            if !existing.contains(&m.id) {
                s.messages.push(m);
            }
        }
        s.messages.sort_by(|a, b| a.id.cmp(&b.id));
        persist_messages(&s);
    }
    Ok(s.messages.clone())
}

/// Sync новых сообщений с момента last_seen (для поллинга live-чата).
#[tauri::command]
async fn sync_messages(since: String, state: State<'_, Shared>) -> Result<Vec<StoredMessage>, String> {
    eprintln!("[bridge] sync_messages(since={since})");
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: SyncRequestPayload { last_seen_id: since },
    };
    let reply = client
        .request(MSG_SYNC_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: ParvaneEvent<SyncResponsePayload> =
        serde_json::from_slice(&reply.payload).map_err(e2s)?;
    Ok(resp.payload.messages)
}

// ── notes ─────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn list_notes(state: State<'_, Shared>) -> Result<Vec<NoteSnapshot>, String> {
    eprintln!("[bridge] list_notes");
    // Манифест того, что уже есть локально: note_id → checksum. Шард вернёт
    // только разошедшееся (diff-синхронизация), а не весь список целиком.
    let (client, token, from, known) = {
        let mut s = state.lock().await;
        if s.notes.is_empty() {
            load_notes(&mut s);
        }
        let known: std::collections::BTreeMap<String, u64> = s
            .notes
            .iter()
            .map(|(id, n)| {
                let cs = if n.checksum == 0 { content_checksum(&n.title, &n.text) } else { n.checksum };
                (id.to_string(), cs)
            })
            .collect();
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
            known,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: NoteSyncRequestPayload { known },
    };
    let reply = client
        .request(NOTE_SYNC_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: ParvaneEvent<NoteSyncResponsePayload> =
        serde_json::from_slice(&reply.payload).map_err(e2s)?;
    // Сливаем дельту в локальный кеш: tombstone'ы удаляем, изменённые
    // апдейтим. Неизменившиеся шард не прислал — они остаются как были.
    let mut s = state.lock().await;
    for note in resp.payload.notes {
        if note.deleted {
            s.notes.remove(&note.note_id);
        } else {
            let mut n = note;
            if n.checksum == 0 {
                n.checksum = content_checksum(&n.title, &n.text);
            }
            s.notes.insert(n.note_id, n);
        }
    }
    persist_notes(&s);
    Ok(s.notes.values().filter(|n| !n.deleted).cloned().collect())
}

#[tauri::command]
async fn create_note(title: String, state: State<'_, Shared>) -> Result<String, String> {
    eprintln!("[bridge] create_note({title})");
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let note_id = Uuid::now_v7();
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: NoteCreatePayload { note_id, title: title.clone() },
    };
    client.publish(NOTE_CREATE, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    // Добавляем пустой снапшот в кеш и сохраняем на диск.
    let cs = content_checksum(&title, "");
    let mut s = state.lock().await;
    s.notes.insert(note_id, NoteSnapshot {
        note_id,
        title,
        text: String::new(),
        elements: vec![],
        deleted: false,
        checksum: cs,
    });
    persist_notes(&s);
    Ok(note_id.to_string())
}

/// Сохраняет заметку. Local-first: клиент — источник истины для тела, шлёт
/// весь текст одной операцией `Replace`, шард атомарно пересобирает заметку.
/// Никакого отслеживания RGA-узлов на клиенте → задвоение текста исключено.
#[tauri::command]
async fn save_note(
    id: String,
    title: String,
    body: String,
    state: State<'_, Shared>,
) -> Result<(), String> {
    eprintln!("[bridge] save_note({id})");
    let nid = Uuid::parse_str(&id).map_err(e2s)?;

    // Если относительно кеша ничего не изменилось — не шлём ничего (это и есть
    // «синхронизация по расхождению, а не перезаливка»: открытие заметки или
    // тик автосейва без правок не порождает трафика).
    let (client, token, from) = {
        let s = state.lock().await;
        if let Some(n) = s.notes.get(&nid) {
            if n.text == body && n.title == title {
                return Ok(());
            }
        }
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };

    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: NoteUpdatePayload {
            note_id: nid,
            ops: vec![NoteOp::Replace { text: body.clone() }],
            title: Some(title.clone()),
        },
    };
    client.publish(NOTE_UPDATE, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;

    // Обновляем локальный кеш и пишем на диск.
    let cs = content_checksum(&title, &body);
    let mut s = state.lock().await;
    s.notes
        .entry(nid)
        .and_modify(|n| {
            n.title = title.clone();
            n.text = body.clone();
            n.checksum = cs;
            n.elements = vec![];
        })
        .or_insert(NoteSnapshot {
            note_id: nid,
            title,
            text: body,
            elements: vec![],
            deleted: false,
            checksum: cs,
        });
    persist_notes(&s);
    Ok(())
}

#[tauri::command]
async fn delete_note(id: String, state: State<'_, Shared>) -> Result<(), String> {
    eprintln!("[bridge] delete_note({id})");
    let nid = Uuid::parse_str(&id).map_err(e2s)?;
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: NoteDeletePayload { note_id: nid },
    };
    client.publish(NOTE_DELETE, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    let mut s = state.lock().await;
    s.notes.remove(&nid);
    persist_notes(&s);
    Ok(())
}

// ── calendar ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn list_events(state: State<'_, Shared>) -> Result<Vec<CalEventSnapshot>, String> {
    eprintln!("[bridge] list_events");
    use parvane_types::{CalSyncRequestPayload, CalSyncResponsePayload};
    // Манифест {event_id → checksum}: шард вернёт только расхождения и tombstone'ы.
    let (client, token, from, known) = {
        let mut s = state.lock().await;
        if s.events.is_empty() {
            load_events(&mut s);
        }
        let known: std::collections::BTreeMap<String, u64> = s
            .events
            .iter()
            .map(|(id, e)| {
                let cs = if e.checksum == 0 { event_checksum(e) } else { e.checksum };
                (id.to_string(), cs)
            })
            .collect();
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
            known,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: CalSyncRequestPayload { known },
    };
    let reply = client
        .request(CAL_SYNC_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: ParvaneEvent<CalSyncResponsePayload> =
        serde_json::from_slice(&reply.payload).map_err(e2s)?;
    let mut s = state.lock().await;
    for mut ev in resp.payload.events {
        if ev.deleted {
            s.events.remove(&ev.event_id);
        } else {
            if ev.checksum == 0 {
                ev.checksum = event_checksum(&ev);
            }
            s.events.insert(ev.event_id, ev);
        }
    }
    persist_events(&s);
    Ok(s.events.values().filter(|e| !e.deleted).cloned().collect())
}

/// Создать событие. Принимает простые поля — мост сам собирает CalSetPayload.
#[derive(Deserialize)]
pub struct EventFields {
    pub title: String,
    pub start: String,
    pub end: String,
    pub location: Option<String>,
}

#[tauri::command]
async fn create_event(fields: EventFields, state: State<'_, Shared>) -> Result<String, String> {
    eprintln!("[bridge] create_event");
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let event_id = Uuid::now_v7();
    let ts = now_ts();
    let mut map = std::collections::BTreeMap::new();
    map.insert("title".to_string(), fields.title);
    map.insert("start".to_string(), fields.start);
    map.insert("end".to_string(), fields.end);
    if let Some(loc) = fields.location {
        map.insert("location".to_string(), loc);
    }
    let payload = CalSetPayload {
        event_id,
        fields: map,
        stamp: Stamp { ts, site: from.clone() },
    };
    let ev = ParvaneEvent { id: Uuid::now_v7(), from, ts, token, payload };
    client.publish(CAL_CREATE, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    Ok(event_id.to_string())
}

#[tauri::command]
async fn update_event_field(
    id: String,
    field: String,
    value: String,
    state: State<'_, Shared>,
) -> Result<(), String> {
    let eid = Uuid::parse_str(&id).map_err(e2s)?;
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let ts = now_ts();
    let mut fields = std::collections::BTreeMap::new();
    fields.insert(field, value);
    let payload = CalSetPayload {
        event_id: eid,
        fields,
        stamp: Stamp { ts, site: from.clone() },
    };
    let ev = ParvaneEvent { id: Uuid::now_v7(), from, ts, token, payload };
    client.publish(CAL_UPDATE, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    Ok(())
}

#[tauri::command]
async fn delete_event(id: String, state: State<'_, Shared>) -> Result<(), String> {
    let eid = Uuid::parse_str(&id).map_err(e2s)?;
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let ts = now_ts();
    let payload = CalDeletePayload { event_id: eid, stamp: Stamp { ts, site: from.clone() } };
    let ev = ParvaneEvent { id: Uuid::now_v7(), from, ts, token, payload };
    client.publish(CAL_DELETE, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    let mut s = state.lock().await;
    s.events.remove(&eid);
    persist_events(&s);
    Ok(())
}

// ── cloud ─────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn list_files(state: State<'_, Shared>) -> Result<FileListResponse, String> {
    eprintln!("[bridge] list_files");
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: FileListPayload {},
    };
    let reply = client
        .request(FILE_LIST_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: FileListResponse = serde_json::from_slice(&reply.payload).map_err(e2s)?;
    Ok(resp)
}

// ── звонки ────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn call_history(state: State<'_, Shared>) -> Result<CallHistoryResponse, String> {
    eprintln!("[bridge] call_history");
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: CallHistoryRequest {},
    };
    let reply = client
        .request(CALL_HISTORY_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: ParvaneEvent<CallHistoryResponse> =
        serde_json::from_slice(&reply.payload).map_err(e2s)?;
    Ok(resp.payload)
}

// ── инициализация ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state: Shared = Arc::new(Mutex::new(AppState::default()));

    tauri::Builder::default()
        .manage(state.clone())
        .setup(move |app| {
            use tauri::Manager;
            let cache_dir = app.path().app_data_dir().ok();
            let st = state.clone();
            tauri::async_runtime::spawn(async move {
                {
                    let mut s = st.lock().await;
                    s.cache_dir = cache_dir;
                }
                let url = std::env::var("PARVANE_NATS_URL")
                    .unwrap_or_else(|_| "nats://localhost:4222".to_string());
                match async_nats::connect(&url).await {
                    Ok(c) => {
                        st.lock().await.nats = Some(c);
                        eprintln!("[bridge] NATS подключён: {url}");
                    }
                    Err(e) => eprintln!("[bridge] NATS connect failed: {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // system
            nats_status,
            current_user,
            // auth
            login,
            logout,
            // messenger
            sync_messages,
            get_conversations,
            get_messages,
            send_text,
            // notes
            list_notes,
            create_note,
            save_note,
            delete_note,
            // calendar
            list_events,
            create_event,
            update_event_field,
            delete_event,
            // cloud
            list_files,
            // calls
            call_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MONOLITH desktop shell");
}
