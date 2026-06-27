// Мост между фронтендом и бэкендом Parvane.
// Rust-сторона подключается к NATS (как шарды) и отдаёт фронтенду Tauri-команды.

use std::sync::Arc;

use parvane_types::{
    IssueRequest, IssueResponse, MessageContent, ParvaneEvent, SendPayload, StoredMessage,
    SyncRequestPayload, SyncResponsePayload,
    topics::{IDENTITY_ISSUE, MSG_SEND, MSG_SYNC_REQUEST},
};
use tauri::State;
use tokio::sync::Mutex;

#[derive(Default)]
struct AppState {
    nats: Option<async_nats::Client>,
    token: Option<String>,
    user: Option<String>,
}

type Shared = Arc<Mutex<AppState>>;

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Подключён ли мост к NATS.
#[tauri::command]
async fn nats_status(state: State<'_, Shared>) -> Result<bool, String> {
    Ok(state.lock().await.nats.is_some())
}

/// Логин через identity-шард: возвращает JWT, запоминает токен и пользователя.
#[tauri::command]
async fn login(user: String, password: String, state: State<'_, Shared>) -> Result<String, String> {
    let client = state.lock().await.nats.clone().ok_or("NATS не подключён")?;
    let req = serde_json::to_vec(&IssueRequest { user: user.clone(), password }).map_err(e2s)?;
    let reply = client.request(IDENTITY_ISSUE, req.into()).await.map_err(e2s)?;
    let resp: IssueResponse = serde_json::from_slice(&reply.payload).map_err(e2s)?;
    if resp.ok {
        let token = resp.token.ok_or("identity вернул ok без токена")?;
        let mut s = state.lock().await;
        s.token = Some(token.clone());
        s.user = Some(user);
        Ok(token)
    } else {
        Err(resp.error.unwrap_or_else(|| "ошибка логина".into()))
    }
}

/// Текущий залогиненный пользователь (или null).
#[tauri::command]
async fn current_user(state: State<'_, Shared>) -> Result<Option<String>, String> {
    Ok(state.lock().await.user.clone())
}

/// Отправить текстовое сообщение через messenger-шард. Возвращает id сообщения.
#[tauri::command]
async fn send_text(to: String, text: String, state: State<'_, Shared>) -> Result<String, String> {
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let id = uuid::Uuid::now_v7();
    let ev = ParvaneEvent {
        id,
        from,
        ts: now_ts(),
        token,
        payload: SendPayload { to, content: MessageContent::Text { text } },
    };
    client
        .publish(MSG_SEND, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    client.flush().await.map_err(e2s)?;
    Ok(id.to_string())
}

/// Забрать пропущенные сообщения (адресованные текущему пользователю) после id.
#[tauri::command]
async fn sync_messages(
    last_seen_id: String,
    state: State<'_, Shared>,
) -> Result<Vec<StoredMessage>, String> {
    let (client, token, from) = {
        let s = state.lock().await;
        (
            s.nats.clone().ok_or("NATS не подключён")?,
            s.token.clone().ok_or("не залогинен")?,
            s.user.clone().ok_or("не залогинен")?,
        )
    };
    let ev = ParvaneEvent {
        id: uuid::Uuid::now_v7(),
        from,
        ts: now_ts(),
        token,
        payload: SyncRequestPayload { last_seen_id },
    };
    let reply = client
        .request(MSG_SYNC_REQUEST, serde_json::to_vec(&ev).map_err(e2s)?.into())
        .await
        .map_err(e2s)?;
    let resp: ParvaneEvent<SyncResponsePayload> =
        serde_json::from_slice(&reply.payload).map_err(e2s)?;
    Ok(resp.payload.messages)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state: Shared = Arc::new(Mutex::new(AppState::default()));
    tauri::Builder::default()
        .manage(state.clone())
        .setup(move |_app| {
            let st = state.clone();
            tauri::async_runtime::spawn(async move {
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
            nats_status,
            login,
            current_user,
            send_text,
            sync_messages
        ])
        .run(tauri::generate_context!())
        .expect("error while running MONOLITH desktop shell");
}
