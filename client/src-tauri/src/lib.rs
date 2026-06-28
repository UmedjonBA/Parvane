// Мост между фронтендом и бэкендом Parvane.
// Rust-сторона подключается к NATS (как шарды) и отдаёт фронтенду Tauri-команды.

use std::{collections::HashMap, sync::Arc};

use parvane_types::{
    content_checksum, event_checksum, CalDeletePayload, CalEventSnapshot, CalSetPayload,
    CallHistoryRequest,
    CallHistoryResponse, DeletePayload, DownloadRequest, DownloadResponse, EditPayload,
    FileListPayload, FileListResponse,
    IssueRequest, IssueResponse,
    MessageContent, NoteCreatePayload, NoteDeletePayload, NoteOp, NoteSnapshot,
    NoteSyncRequestPayload, NoteSyncResponsePayload, NoteUpdatePayload, ParvaneEvent, ReadPayload,
    SendPayload,
    Stamp, StoredMessage, SyncRequestPayload, SyncResponsePayload,
    UploadChunkPayload, UploadCompletePayload, UploadCompleteResponse,
    topics::{
        CAL_CREATE, CAL_DELETE, CAL_SYNC_REQUEST, CAL_UPDATE, CALL_HISTORY_REQUEST,
        FILE_DOWNLOAD_REQUEST, FILE_LIST_REQUEST, FILE_UPLOAD_CHUNK, FILE_UPLOAD_COMPLETE,
        IDENTITY_ISSUE, MSG_DELETE, MSG_EDIT, MSG_READ, MSG_SEND,
        MSG_SYNC_REQUEST, NOTE_CREATE, NOTE_DELETE, NOTE_SYNC_REQUEST, NOTE_UPDATE,
    },
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::StreamExt;
use serde::{Deserialize, Serialize};

// ── WebKitGTK runtime feature flags (FFI к уже слинкованной libwebkit2gtk) ────
// MediaRecorder в WebKitGTK — выключенная по умолчанию runtime-фича. Крейт
// webkit2gtk-sys 2.0.2 её не биндит, поэтому объявляем символы вручную и
// включаем все *MediaRecorder*-фичи на settings вебвью.
#[cfg(target_os = "linux")]
mod webkit_ffi {
    use std::os::raw::c_char;
    #[repr(C)] pub struct FeatureList { _p: [u8; 0] }
    #[repr(C)] pub struct Feature { _p: [u8; 0] }
    #[repr(C)] pub struct WkSettings { _p: [u8; 0] }
    extern "C" {
        pub fn webkit_settings_get_all_features() -> *mut FeatureList;
        pub fn webkit_feature_list_get_length(list: *mut FeatureList) -> usize;
        pub fn webkit_feature_list_get(list: *mut FeatureList, index: usize) -> *mut Feature;
        pub fn webkit_feature_get_identifier(feature: *mut Feature) -> *const c_char;
        pub fn webkit_settings_set_feature_enabled(
            settings: *mut WkSettings, feature: *mut Feature, enabled: i32,
        );
    }
}
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

/// Диагностика из фронтенда в лог моста (для проверки поддержки медиа в вебвью).
#[tauri::command]
fn diag(text: String) {
    eprintln!("[diag] {text}");
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

/// Отправить текстовое сообщение. `reply` — `id` сообщения, на которое отвечаем
/// (или `null`). Имя параметра однословное — Tauri глотает многословные.
#[tauri::command]
async fn send_text(
    to: String,
    text: String,
    reply: Option<String>,
    state: State<'_, Shared>,
) -> Result<String, String> {
    eprintln!("[bridge] send_text(to={to})");
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let reply_to = reply.and_then(|r| Uuid::parse_str(&r).ok());
    let id = Uuid::now_v7();
    let ev = ParvaneEvent {
        id,
        from,
        ts: now_ts(),
        token,
        payload: SendPayload { to, content: MessageContent::Text { text }, reply_to },
    };
    client.publish(MSG_SEND, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    Ok(id.to_string())
}

/// Редактировать своё текстовое сообщение.
#[tauri::command]
async fn edit_message(id: String, text: String, state: State<'_, Shared>) -> Result<(), String> {
    eprintln!("[bridge] edit_message({id})");
    let mid = Uuid::parse_str(&id).map_err(e2s)?;
    let (client, token, from) = creds(&state).await?;
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: EditPayload { message_id: mid, text: text.clone() },
    };
    client.publish(MSG_EDIT, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    // Оптимистично правим кеш, чтобы UI обновился сразу.
    let mut s = state.lock().await;
    if let Some(m) = s.messages.iter_mut().find(|m| m.id == mid) {
        m.content = MessageContent::Text { text };
        m.edited = true;
    }
    persist_messages(&s);
    Ok(())
}

/// Удалить своё сообщение «у всех».
#[tauri::command]
async fn delete_message(id: String, state: State<'_, Shared>) -> Result<(), String> {
    eprintln!("[bridge] delete_message({id})");
    let mid = Uuid::parse_str(&id).map_err(e2s)?;
    let (client, token, from) = creds(&state).await?;
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: DeletePayload { message_id: mid },
    };
    client.publish(MSG_DELETE, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    let mut s = state.lock().await;
    if let Some(m) = s.messages.iter_mut().find(|m| m.id == mid) {
        m.deleted = true;
        m.content = MessageContent::Text { text: String::new() };
    }
    persist_messages(&s);
    Ok(())
}

/// Отметить сообщение прочитанным (отправляет read-receipt → автор увидит ✓✓).
#[tauri::command]
async fn mark_read(id: String, state: State<'_, Shared>) -> Result<(), String> {
    let mid = Uuid::parse_str(&id).map_err(e2s)?;
    let (client, token, from) = creds(&state).await?;
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: ReadPayload { message_id: mid },
    };
    client.publish(MSG_READ, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    Ok(())
}

/// (client, token, user) либо ошибка «не залогинен».
async fn creds(state: &State<'_, Shared>) -> Result<(async_nats::Client, String, String), String> {
    let s = state.lock().await;
    Ok((
        s.nats.clone().ok_or("NATS не подключён")?,
        s.token.clone().ok_or("не залогинен")?,
        s.user.clone().ok_or("не залогинен")?,
    ))
}

/// Слить дельту синка в кеш: upsert по id (правки/удаления/прочтения заменяют
/// существующую запись), сортировка по id, запись на диск.
fn merge_messages(s: &mut AppState, delta: Vec<StoredMessage>) {
    if delta.is_empty() {
        return;
    }
    for m in delta {
        if let Some(existing) = s.messages.iter_mut().find(|x| x.id == m.id) {
            *existing = m;
        } else {
            s.messages.push(m);
        }
    }
    s.messages.sort_by(|a, b| a.id.cmp(&b.id));
    persist_messages(s);
}

/// Два курсора кеша: (max id, max updated_at). Основа синка мутаций.
fn cursors(s: &AppState) -> (String, i64) {
    let id = s
        .messages
        .iter()
        .map(|m| m.id)
        .max()
        .map(|u| u.to_string())
        .unwrap_or_else(|| "00000000-0000-0000-0000-000000000000".to_string());
    let upd = s.messages.iter().map(|m| m.updated_at).max().unwrap_or(0);
    (id, upd)
}

/// Внутренняя: local-first синхронизация сообщений. Держит кеш на диске, у
/// сервера запрашивает новое (`id > cursor`) И мутации старого
/// (`updated_at > since`): правки, удаления, отметки о прочтении.
async fn do_sync_all(state: State<'_, Shared>) -> Result<Vec<StoredMessage>, String> {
    let (client, token, from, last_seen_id, since_updated) = {
        let mut s = state.lock().await;
        if s.messages.is_empty() {
            load_messages(&mut s);
        }
        let (id, upd) = cursors(&s);
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
            id,
            upd,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: SyncRequestPayload { last_seen_id, since_updated },
    };
    let reply = client
        .request(MSG_SYNC_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: ParvaneEvent<SyncResponsePayload> =
        serde_json::from_slice(&reply.payload).map_err(e2s)?;

    let mut s = state.lock().await;
    merge_messages(&mut s, resp.payload.messages);
    Ok(s.messages.clone())
}

/// Sync для поллинга live-чата. `since` от фронта — это max id, но курсор
/// мутаций берём из кеша (max updated_at), сливаем дельту в кеш и возвращаем
/// весь свежий снимок (фронт сам делает upsert по id).
#[tauri::command]
async fn sync_messages(since: String, state: State<'_, Shared>) -> Result<Vec<StoredMessage>, String> {
    eprintln!("[bridge] sync_messages(since={since})");
    let (client, token, from, since_updated) = {
        let s = state.lock().await;
        let (_, upd) = cursors(&s);
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
            upd,
        )
    };
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: SyncRequestPayload { last_seen_id: since, since_updated },
    };
    let reply = client
        .request(MSG_SYNC_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: ParvaneEvent<SyncResponsePayload> =
        serde_json::from_slice(&reply.payload).map_err(e2s)?;
    let delta = resp.payload.messages.clone();
    let mut s = state.lock().await;
    merge_messages(&mut s, resp.payload.messages);
    Ok(delta)
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

// ── медиа: загрузка/скачивание блобов через cloud-шард ────────────────────────

/// Размер сырого чанка. base64 раздувает ×4/3 → ~700КБ, плюс JSON-обвязка —
/// остаёмся под дефолтным лимитом NATS в 1МБ.
const CHUNK_RAW: usize = 512 * 1024;

#[derive(Serialize)]
struct UploadResult {
    file_id: String,
    size: u64,
}

#[derive(Serialize)]
struct BlobData {
    file_id: String,
    filename: String,
    mime: String,
    /// base64 содержимого файла
    data: String,
}

/// Метаданные медиа от фронтенда для `send_media`. Поле команды — одно слово `meta`.
#[derive(Deserialize)]
struct MediaMeta {
    to: String,
    #[serde(default)]
    reply: Option<String>,
    /// photo | video | voice | video_note | file
    kind: String,
    /// file_id уже загруженного блоба (результат upload_blob)
    file: String,
    filename: String,
    mime: String,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    duration: u32,
    size: u64,
    #[serde(default)]
    caption: Option<String>,
}

/// Каталог дискового кеша блобов (cache_dir/blobs).
fn blobs_dir(s: &AppState) -> Option<std::path::PathBuf> {
    let dir = s.cache_dir.as_ref()?.join("blobs");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// Залить файл в облако: чанкуем, шлём `file.upload.chunk` ×N, затем
/// `file.upload.complete` (request/reply). Возвращает file_id.
#[tauri::command]
async fn upload_blob(
    name: String,
    mime: String,
    data: String, // base64 всего файла
    state: State<'_, Shared>,
) -> Result<UploadResult, String> {
    eprintln!("[bridge] upload_blob(name={name}, mime={mime})");
    let bytes = B64.decode(&data).map_err(e2s)?;
    let (client, token, from) = creds(&state).await?;
    let file_id = Uuid::now_v7();
    let chunks: Vec<&[u8]> = bytes.chunks(CHUNK_RAW).collect();
    let total = chunks.len().max(1) as u32;

    for (i, chunk) in chunks.iter().enumerate() {
        let ev = ParvaneEvent {
            id: Uuid::now_v7(),
            from: from.clone(),
            ts: now_ts(),
            token: token.clone(),
            payload: UploadChunkPayload {
                file_id,
                chunk_index: i as u32,
                total_chunks: total,
                data: B64.encode(chunk),
                filename: name.clone(),
                mime_type: mime.clone(),
            },
        };
        // request/reply: ждём подтверждения сохранения чанка шардом, чтобы
        // complete не обогнал запись чанка (гонка chunk/complete в select! шарда).
        let ack = client
            .request(FILE_UPLOAD_CHUNK, serde_json::to_vec(&ev).map_err(e2s)?.into())
            .await
            .map_err(e2s)?;
        let av: serde_json::Value = serde_json::from_slice(&ack.payload).map_err(e2s)?;
        if !av.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Err(av.get("error").and_then(|v| v.as_str()).unwrap_or("chunk store failed").into());
        }
    }
    client.flush().await.map_err(e2s)?;

    let complete = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: UploadCompletePayload {
            file_id,
            filename: name,
            total_chunks: total,
            size_bytes: bytes.len() as u64,
            mime_type: mime,
        },
    };
    let reply = client
        .request(FILE_UPLOAD_COMPLETE, serde_json::to_vec(&complete).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: UploadCompleteResponse = serde_json::from_slice(&reply.payload).map_err(e2s)?;
    if !resp.ok {
        return Err(resp.error.unwrap_or_else(|| "upload failed".into()));
    }
    // Кладём в дисковый кеш, чтобы не качать собственный файл обратно.
    if let Some(dir) = blobs_dir(&*state.lock().await) {
        let _ = std::fs::write(dir.join(file_id.to_string()), &bytes);
    }
    Ok(UploadResult { file_id: file_id.to_string(), size: bytes.len() as u64 })
}

/// Скачать блоб из облака. Кеш на диске; иначе — подписка на inbox, запрос
/// `file.download.request`, сбор чанков (шард шлёт их в reply-топик).
#[tauri::command]
async fn download_blob(id: String, state: State<'_, Shared>) -> Result<BlobData, String> {
    eprintln!("[bridge] download_blob({id})");
    let fid = Uuid::parse_str(&id).map_err(e2s)?;
    let (client, token, from) = creds(&state).await?;

    // Дисковый кеш: <blobs>/<id> + сайдкар <id>.meta (filename\nmime).
    let cache = blobs_dir(&*state.lock().await);
    if let Some(dir) = &cache {
        if let Ok(bytes) = std::fs::read(dir.join(&id)) {
            let (filename, mime) = std::fs::read_to_string(dir.join(format!("{id}.meta")))
                .ok()
                .and_then(|s| {
                    let mut it = s.splitn(2, '\n');
                    Some((it.next()?.to_string(), it.next().unwrap_or("application/octet-stream").to_string()))
                })
                .unwrap_or_else(|| (id.clone(), "application/octet-stream".into()));
            return Ok(BlobData { file_id: id, filename, mime, data: B64.encode(&bytes) });
        }
    }

    let inbox = client.new_inbox();
    let mut sub = client.subscribe(inbox.clone()).await.map_err(e2s)?;
    let ev = ParvaneEvent {
        id: Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: DownloadRequest { file_id: fid },
    };
    client
        .publish_with_reply(FILE_DOWNLOAD_REQUEST, inbox, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    client.flush().await.map_err(e2s)?;

    let mut parts: Vec<Option<Vec<u8>>> = Vec::new();
    let mut total: Option<u32> = None;
    let mut got = 0u32;
    let mut filename = id.clone();
    let mut mime = "application/octet-stream".to_string();

    loop {
        let next = tokio::time::timeout(std::time::Duration::from_secs(30), sub.next()).await;
        let msg = match next {
            Ok(Some(m)) => m,
            _ => return Err("download timeout".into()),
        };
        let resp: DownloadResponse = match serde_json::from_slice(&msg.payload) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "download failed".into()));
        }
        if let Some(n) = resp.total_chunks {
            if total.is_none() {
                total = Some(n);
                parts = (0..n).map(|_| None).collect();
            }
        }
        if let Some(fname) = resp.filename { filename = fname; }
        if let Some(mt) = resp.mime_type { mime = mt; }
        match (resp.chunk_index, resp.data) {
            (Some(idx), Some(b64)) => {
                let bytes = B64.decode(&b64).map_err(e2s)?;
                if (idx as usize) < parts.len() {
                    if parts[idx as usize].is_none() { got += 1; }
                    parts[idx as usize] = Some(bytes);
                }
            }
            _ => {}
        }
        if let Some(n) = total {
            if got >= n { break; }
        }
    }

    let mut bytes = Vec::new();
    for p in parts {
        bytes.extend_from_slice(&p.ok_or("пропущен чанк")?);
    }
    if let Some(dir) = &cache {
        let _ = std::fs::write(dir.join(&id), &bytes);
        let _ = std::fs::write(dir.join(format!("{id}.meta")), format!("{filename}\n{mime}"));
    }
    Ok(BlobData { file_id: id, filename, mime, data: B64.encode(&bytes) })
}

/// Отправить медиа-сообщение: собрать MessageContent по `kind` и опубликовать
/// в messenger (как send_text, но с медиа-контентом).
#[tauri::command]
async fn send_media(meta: MediaMeta, state: State<'_, Shared>) -> Result<String, String> {
    eprintln!("[bridge] send_media(kind={}, to={})", meta.kind, meta.to);
    let file_id = Uuid::parse_str(&meta.file).map_err(e2s)?;
    let caption = meta.caption.clone();
    let content = match meta.kind.as_str() {
        "photo" => MessageContent::Photo {
            file_id, width: meta.width, height: meta.height,
            mime: meta.mime, size_bytes: meta.size, caption,
        },
        "video" => MessageContent::Video {
            file_id, duration_secs: meta.duration, width: meta.width, height: meta.height,
            mime: meta.mime, size_bytes: meta.size, caption,
        },
        "voice" => MessageContent::Voice {
            file_id, duration_secs: meta.duration, mime: meta.mime, size_bytes: meta.size,
        },
        "video_note" => MessageContent::VideoNote {
            file_id, duration_secs: meta.duration, mime: meta.mime, size_bytes: meta.size,
        },
        _ => MessageContent::File {
            file_id, filename: meta.filename, mime: meta.mime, size_bytes: meta.size, caption,
        },
    };
    let (client, token, from) = creds(&state).await?;
    let reply_to = meta.reply.and_then(|r| Uuid::parse_str(&r).ok());
    let id = Uuid::now_v7();
    let ev = ParvaneEvent {
        id,
        from,
        ts: now_ts(),
        token,
        payload: SendPayload { to: meta.to, content, reply_to },
    };
    client.publish(MSG_SEND, serde_json::to_vec(&ev).map_err(e2s)?.into()).await.map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    Ok(id.to_string())
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
    // Linux: добавить пользовательский каталог GStreamer-плагинов
    // (~/.local/lib/gstreamer-1.0) в GST_PLUGIN_PATH — там лежат vp8/webm/matroska
    // энкодеры для MediaRecorder, если системный gst-plugins-good не установлен.
    // Должно выполниться до создания вебвью (WebKit инициализирует GStreamer).
    #[cfg(target_os = "linux")]
    if let Some(home) = std::env::var_os("HOME") {
        let dir = std::path::PathBuf::from(home).join(".local/lib/gstreamer-1.0");
        if dir.is_dir() {
            let mut paths: Vec<std::path::PathBuf> = std::env::var_os("GST_PLUGIN_PATH")
                .map(|v| std::env::split_paths(&v).collect())
                .unwrap_or_default();
            if !paths.iter().any(|p| p == &dir) {
                paths.push(dir);
                if let Ok(joined) = std::env::join_paths(paths) {
                    std::env::set_var("GST_PLUGIN_PATH", joined);
                }
            }
        }
    }

    let state: Shared = Arc::new(Mutex::new(AppState::default()));

    tauri::Builder::default()
        .manage(state.clone())
        .setup(move |app| {
            use tauri::Manager;

            // Linux/WebKitGTK: включить media-stream и авто-разрешать запросы
            // доступа к микрофону/камере — иначе getUserMedia сразу падает.
            #[cfg(target_os = "linux")]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.with_webview(|webview| {
                    use webkit2gtk::glib::object::ObjectType;
                    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                    let wv = webview.inner();
                    if let Some(settings) = WebViewExt::settings(&wv) {
                        settings.set_enable_media_stream(true);
                        settings.set_enable_webrtc(true);
                        // Включаем runtime-фичу MediaRecorder (по умолчанию off).
                        unsafe {
                            let sptr = settings.as_ptr() as *mut webkit_ffi::WkSettings;
                            let list = webkit_ffi::webkit_settings_get_all_features();
                            if !list.is_null() {
                                let n = webkit_ffi::webkit_feature_list_get_length(list);
                                for i in 0..n {
                                    let f = webkit_ffi::webkit_feature_list_get(list, i);
                                    if f.is_null() { continue; }
                                    let idc = webkit_ffi::webkit_feature_get_identifier(f);
                                    if idc.is_null() { continue; }
                                    let id = std::ffi::CStr::from_ptr(idc).to_string_lossy();
                                    if id.contains("MediaRecorder") {
                                        webkit_ffi::webkit_settings_set_feature_enabled(sptr, f, 1);
                                        eprintln!("[bridge] webkit feature ON: {id}");
                                    }
                                }
                            }
                        }
                    }
                    wv.connect_permission_request(|_wv, req| {
                        req.allow();
                        true
                    });
                });
            }

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
            diag,
            // auth
            login,
            logout,
            // messenger
            sync_messages,
            get_conversations,
            get_messages,
            send_text,
            edit_message,
            delete_message,
            mark_read,
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
            upload_blob,
            download_blob,
            send_media,
            // calls
            call_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MONOLITH desktop shell");
}
