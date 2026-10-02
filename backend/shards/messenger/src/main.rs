use anyhow::{Context, Result};
use async_nats::Client;
use base64::{engine::general_purpose::{STANDARD, STANDARD_NO_PAD}, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures::StreamExt;
use parvane_types::{
    AckPayload, ClearPayload, ClearedIds, ClearedNotice, DeletePayload, DeliveredPayload, EditPayload, GroupActionResponse,
    GroupCreateRequest, GroupCreateResponse, GroupInfo, GroupInfoRequest, GroupKind,
    GroupDeleteRequest, GroupListRequest, GroupListResponse, GroupMember, GroupMemberRequest,
    GroupRenameRequest, GroupSetRoleRequest, GroupMuteRequest,
    MessageContent, MessageDeviceCopy,
    ParvaneEvent, PinPayload, ReactPayload, ReadPayload, ReaderEntry, ReadersPayload,
    NotifyPayload, NotifyNotice, ReadNotice, ReadersResponse, SendPayload, StoredMessage,
    SyncRequestPayload, SyncResponsePayload, VerifyRequest, VerifyResponse,
    topics::{
        GROUP_ADD_MEMBER, GROUP_BAN, GROUP_CREATE, GROUP_DELETE, GROUP_INFO,
        GROUP_INVITE_CREATE, GROUP_JOIN, GROUP_LIST, GROUP_MUTE, GROUP_REMOVE_MEMBER,
        GROUP_RENAME, GROUP_SET_ROLE, GROUP_UNBAN,
        GROUP_SETINFO, GROUP_SETPERMS, GROUP_SETADMIN, GROUP_INVITE_LIST, GROUP_INVITE_REVOKE,
        GROUP_INVITE_DELETE, GROUP_INVITE_CHECK, GROUP_REQUEST_LIST, GROUP_REQUEST_DECIDE,
        IDENTITY_VERIFY, MSG_ACK, MSG_CLEAR, MSG_SETNOTIFY, MSG_DELETE, MSG_EDIT, MSG_PIN, MSG_READ, MSG_READERS, MSG_REACT, MSG_SEND,
        MSG_SYNC_REQUEST, msg_inbox,
    },
};
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

// ── main ─────────────────────────────────────────────────────────────────────

mod auth;
mod store;
mod delivery;
mod groups;
mod group_mgmt;
mod handlers;
mod v2;
mod v2_groups;
mod v2_state;
pub(crate) use auth::*;
pub(crate) use store::*;
pub(crate) use delivery::*;
pub(crate) use groups::*;
pub(crate) use handlers::*;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .pretty()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("PARVANE_LOG_LEVEL")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    dotenvy::dotenv().ok();

    let nats_url = std::env::var("PARVANE_NATS_URL")
        .unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let db_path = std::env::var("PARVANE_DB_PATH")
        .unwrap_or_else(|_| "./messenger.db".to_string());

    // P-38: общий коннект (WAL, busy_timeout 30 с) — см. parvane-db
    let pool = parvane_db::connect(&db_path).await?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("миграции")?;

    info!("SQLite готов: {}", db_path);

    let nc = parvane_types::nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;

    info!("NATS подключён: {}", nats_url);

    // Протокол v2 (spec 007, E1): журналы seq, sealed/group-доставка, мост v1.
    let v2_pool = v2::open_store(&db_path).await?;
    v2::run(nc.clone(), pool.clone(), v2_pool).await?;

    let mut send_sub = nc.subscribe(MSG_SEND).await?;
    let mut ack_sub = nc.subscribe(MSG_ACK).await?;
    let mut read_sub = nc.subscribe(MSG_READ).await?;
    let mut readers_sub = nc.subscribe(MSG_READERS).await?;
    let mut edit_sub = nc.subscribe(MSG_EDIT).await?;
    let mut delete_sub = nc.subscribe(MSG_DELETE).await?;
    let mut react_sub = nc.subscribe(MSG_REACT).await?;
    let mut pin_sub = nc.subscribe(MSG_PIN).await?;
    let mut clear_sub = nc.subscribe(MSG_CLEAR).await?;
    let mut setnotify_sub = nc.subscribe(MSG_SETNOTIFY).await?;
    let mut gcreate_sub = nc.subscribe(GROUP_CREATE).await?;
    let mut gadd_sub = nc.subscribe(GROUP_ADD_MEMBER).await?;
    let mut gremove_sub = nc.subscribe(GROUP_REMOVE_MEMBER).await?;
    let mut gsetrole_sub = nc.subscribe(GROUP_SET_ROLE).await?;
    let mut gban_sub = nc.subscribe(GROUP_BAN).await?;
    let mut gunban_sub = nc.subscribe(GROUP_UNBAN).await?;
    let mut gmute_sub = nc.subscribe(GROUP_MUTE).await?;
    let mut ginvite_sub = nc.subscribe(GROUP_INVITE_CREATE).await?;
    let mut gjoin_sub = nc.subscribe(GROUP_JOIN).await?;
    let mut grename_sub = nc.subscribe(GROUP_RENAME).await?;
    let mut gdelete_sub = nc.subscribe(GROUP_DELETE).await?;
    let mut glist_sub = nc.subscribe(GROUP_LIST).await?;
    let mut ginfo_sub = nc.subscribe(GROUP_INFO).await?;
    let mut gsetinfo_sub = nc.subscribe(GROUP_SETINFO).await?;
    let mut gsetperms_sub = nc.subscribe(GROUP_SETPERMS).await?;
    let mut gsetadmin_sub = nc.subscribe(GROUP_SETADMIN).await?;
    let mut ginvlist_sub = nc.subscribe(GROUP_INVITE_LIST).await?;
    let mut ginvrevoke_sub = nc.subscribe(GROUP_INVITE_REVOKE).await?;
    let mut ginvdelete_sub = nc.subscribe(GROUP_INVITE_DELETE).await?;
    let mut ginvcheck_sub = nc.subscribe(GROUP_INVITE_CHECK).await?;
    let mut greqlist_sub = nc.subscribe(GROUP_REQUEST_LIST).await?;
    let mut greqdecide_sub = nc.subscribe(GROUP_REQUEST_DECIDE).await?;
    let mut sync_sub = nc.subscribe(MSG_SYNC_REQUEST).await?;

    info!(
        "Messenger шард запущен. Слушаю: {}, {}, {}, {}, {}, {}",
        MSG_SEND, MSG_ACK, MSG_READ, MSG_EDIT, MSG_DELETE, MSG_SYNC_REQUEST
    );

    // P-41: периодический GC tombstone'ов и очереди доставки
    {
        let gc_pool = pool.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
            loop {
                tick.tick().await;
                match gc_messenger(&gc_pool, now_unix()).await {
                    Ok((m, q)) if m + q > 0 => info!("GC: удалено tombstone'ов {}, строк очереди {}", m, q),
                    Ok(_) => {}
                    Err(e) => warn!("GC: {}", e),
                }
            }
        });
    }

    loop {
        tokio::select! {
            Some(msg) = send_sub.next() => {
                handle_send(&nc, &pool, msg).await;
            }
            Some(msg) = ack_sub.next() => {
                handle_ack(&nc, &pool, msg).await;
            }
            Some(msg) = read_sub.next() => {
                handle_read(&nc, &pool, msg).await;
            }
            Some(msg) = readers_sub.next() => {
                handle_readers(&nc, &pool, msg).await;
            }
            Some(msg) = edit_sub.next() => {
                handle_edit(&nc, &pool, msg).await;
            }
            Some(msg) = delete_sub.next() => {
                handle_delete(&nc, &pool, msg).await;
            }
            Some(msg) = react_sub.next() => {
                handle_react(&nc, &pool, msg).await;
            }
            Some(msg) = pin_sub.next() => {
                handle_pin(&nc, &pool, msg).await;
            }
            Some(msg) = clear_sub.next() => {
                handle_clear(&nc, &pool, msg).await;
            }
            Some(msg) = setnotify_sub.next() => {
                handle_setnotify(&nc, &pool, msg).await;
            }
            Some(msg) = gcreate_sub.next() => {
                handle_group_create(&nc, &pool, msg).await;
            }
            Some(msg) = gadd_sub.next() => {
                handle_group_add(&nc, &pool, msg).await;
            }
            Some(msg) = gremove_sub.next() => {
                handle_group_remove(&nc, &pool, msg).await;
            }
            Some(msg) = gsetrole_sub.next() => {
                handle_group_setrole(&nc, &pool, msg).await;
            }
            Some(msg) = gban_sub.next() => {
                handle_group_ban(&nc, &pool, msg, true).await;
            }
            Some(msg) = gunban_sub.next() => {
                handle_group_ban(&nc, &pool, msg, false).await;
            }
            Some(msg) = gmute_sub.next() => {
                handle_group_mute(&nc, &pool, msg).await;
            }
            Some(msg) = ginvite_sub.next() => {
                group_mgmt::handle_group_invite_create(&nc, &pool, msg).await;
            }
            Some(msg) = gjoin_sub.next() => {
                group_mgmt::handle_group_join(&nc, &pool, msg).await;
            }
            Some(msg) = gsetinfo_sub.next() => {
                group_mgmt::handle_group_setinfo(&nc, &pool, msg).await;
            }
            Some(msg) = gsetperms_sub.next() => {
                group_mgmt::handle_group_setperms(&nc, &pool, msg).await;
            }
            Some(msg) = gsetadmin_sub.next() => {
                group_mgmt::handle_group_setadmin(&nc, &pool, msg).await;
            }
            Some(msg) = ginvlist_sub.next() => {
                group_mgmt::handle_group_invite_list(&nc, &pool, msg).await;
            }
            Some(msg) = ginvrevoke_sub.next() => {
                group_mgmt::handle_group_invite_revoke(&nc, &pool, msg).await;
            }
            Some(msg) = ginvdelete_sub.next() => {
                group_mgmt::handle_group_invite_delete(&nc, &pool, msg).await;
            }
            Some(msg) = ginvcheck_sub.next() => {
                group_mgmt::handle_group_invite_check(&nc, &pool, msg).await;
            }
            Some(msg) = greqlist_sub.next() => {
                group_mgmt::handle_group_request_list(&nc, &pool, msg).await;
            }
            Some(msg) = greqdecide_sub.next() => {
                group_mgmt::handle_group_request_decide(&nc, &pool, msg).await;
            }
            Some(msg) = grename_sub.next() => {
                handle_group_rename(&nc, &pool, msg).await;
            }
            Some(msg) = gdelete_sub.next() => {
                handle_group_delete(&nc, &pool, msg).await;
            }
            Some(msg) = glist_sub.next() => {
                handle_group_list(&nc, &pool, msg).await;
            }
            Some(msg) = ginfo_sub.next() => {
                handle_group_info(&nc, &pool, msg).await;
            }
            Some(msg) = sync_sub.next() => {
                handle_sync(&nc, &pool, msg).await;
            }
        }
    }
}

// ── auth helper ───────────────────────────────────────────────────────────────

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
