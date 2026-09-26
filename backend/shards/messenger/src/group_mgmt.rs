//! Управление группой (spec 003): права по умолчанию и права админов,
//! ревизия сведений, уведомления участникам, фото/описание, инвайт-ссылки
//! с параметрами, заявки на вступление.
//!
//! Все хендлеры — request/reply с `token` в корне JSON (gateway подставляет
//! токен сессии). Ошибки — через `tracing`, паник нет.

use anyhow::{Context, Result};
use async_nats::Client;
use parvane_types::{
    topics::msg_inbox, AdminRights, DefaultPermissions, GroupActionResponse,
    GroupInviteCheckRequest, GroupInviteCheckResponse, GroupInviteCreateRequest,
    GroupInviteCreateResponse, GroupInviteListRequest, GroupInviteListResponse,
    GroupInviteTokenRequest, GroupJoinRequest, GroupJoinResponse, GroupKind, GroupNotice,
    GroupNoticePayload, GroupRequestDecideRequest, GroupRequestListRequest,
    GroupRequestListResponse, GroupSetAdminRequest, GroupSetInfoRequest, GroupSetPermsRequest,
    GroupVersionResponse, InviteLink, JoinRequestInfo, ParvaneEvent,
};
use sqlx::SqlitePool;
use tracing::{info, warn};
use uuid::Uuid;

use super::{group_info, member_role, now_unix, verify_token};

/// Лимиты (data-model.md).
pub const MAX_ABOUT_CHARS: usize = 255;
pub const MAX_INVITE_TITLE_CHARS: usize = 32;
pub const MAX_ACTIVE_INVITES: i64 = 50;
/// Повторная заявка после отказа — не раньше чем через сутки.
pub const DECLINED_RETRY_SECS: i64 = 86_400;

// ── права ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupRight {
    ChangeInfo,
    DeleteMessages,
    BanUsers,
    InviteUsers,
    PinMessages,
    AddAdmins,
}

pub async fn load_default_perms(pool: &SqlitePool, group_id: &str) -> Result<DefaultPermissions> {
    let raw: Option<(String,)> =
        sqlx::query_as("SELECT default_perms_json FROM groups WHERE id = ?")
            .bind(group_id)
            .fetch_optional(pool)
            .await?;
    Ok(parse_default_perms(raw.map(|(s,)| s).as_deref()))
}

pub fn parse_default_perms(raw: Option<&str>) -> DefaultPermissions {
    match raw {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(s).unwrap_or_default(),
        _ => DefaultPermissions::default(),
    }
}

/// Права админа: NULL у role=admin — полный набор (админ до spec 003).
pub fn parse_admin_rights(role: &str, raw: Option<&str>) -> Option<AdminRights> {
    if role != "admin" {
        return None;
    }
    Some(match raw {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(s).unwrap_or_else(|_| AdminRights::full()),
        _ => AdminRights::full(),
    })
}

pub async fn load_admin_rights(
    pool: &SqlitePool,
    group_id: &str,
    member: &str,
) -> Result<Option<AdminRights>> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT role, admin_rights_json FROM group_members WHERE group_id = ? AND member = ?",
    )
    .bind(group_id)
    .bind(member)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(role, raw)| parse_admin_rights(&role, raw.as_deref())))
}

fn admin_has(rights: &AdminRights, right: GroupRight) -> bool {
    match right {
        GroupRight::ChangeInfo => rights.change_info,
        GroupRight::DeleteMessages => rights.delete_messages,
        GroupRight::BanUsers => rights.ban_users,
        GroupRight::InviteUsers => rights.invite_users,
        GroupRight::PinMessages => rights.pin_messages,
        GroupRight::AddAdmins => rights.add_admins,
    }
}

fn member_default_has(perms: &DefaultPermissions, right: GroupRight) -> bool {
    match right {
        GroupRight::ChangeInfo => perms.change_info,
        GroupRight::InviteUsers => perms.invite_users,
        GroupRight::PinMessages => perms.pin_messages,
        _ => false,
    }
}

/// Владелец — всегда; админ — по своим правам; участник — только если
/// `allow_member_default` и право включено в правах по умолчанию;
/// забаненный и не участник — никогда.
pub async fn has_group_right(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    right: GroupRight,
    allow_member_default: bool,
) -> Result<bool> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT role, admin_rights_json FROM group_members WHERE group_id = ? AND member = ?",
    )
    .bind(group_id)
    .bind(actor)
    .fetch_optional(pool)
    .await?;
    let Some((role, raw)) = row else {
        return Ok(false);
    };
    Ok(match role.as_str() {
        "owner" => true,
        "admin" => admin_has(&parse_admin_rights("admin", raw.as_deref()).unwrap_or_default(), right),
        "member" => {
            allow_member_default
                && member_default_has(&load_default_perms(pool, group_id).await?, right)
        }
        _ => false,
    })
}

/// Владелец или админ с `invite_users` — видит ссылки и заявки.
pub async fn is_invite_manager(pool: &SqlitePool, group_id: &str, actor: &str) -> Result<bool> {
    has_group_right(pool, group_id, actor, GroupRight::InviteUsers, false).await
}

// ── ревизия и уведомления ────────────────────────────────────────────────────

/// +1 к ревизии группы. Вызывать внутри транзакции мутации.
pub async fn bump_group_version<'e, E>(ex: E, group_id: &str) -> Result<u64>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let v: Option<(i64,)> =
        sqlx::query_as("UPDATE groups SET version = version + 1 WHERE id = ? RETURNING version")
            .bind(group_id)
            .fetch_optional(ex)
            .await?;
    Ok(v.map(|(v,)| v.max(0) as u64).unwrap_or(0))
}

pub async fn current_version<'e, E>(ex: E, group_id: &str) -> Result<u64>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let v: Option<(i64,)> = sqlx::query_as("SELECT version FROM groups WHERE id = ?")
        .bind(group_id)
        .fetch_optional(ex)
        .await?;
    Ok(v.map(|(v,)| v.max(0) as u64).unwrap_or(0))
}

#[derive(Debug, Clone)]
pub enum GroupRecipients {
    /// Все участники с ролью owner|admin|member.
    AllMembers,
    /// Владелец и админы с `invite_users`.
    InviteManagers,
    /// Один адрес (удалённый/забаненный).
    Only(String),
}

async fn active_members(pool: &SqlitePool, group_id: &str) -> Result<Vec<(String, String, Option<String>)>> {
    Ok(sqlx::query_as(
        "SELECT member, role, admin_rights_json FROM group_members
          WHERE group_id = ? AND role IN ('owner', 'admin', 'member')",
    )
    .bind(group_id)
    .fetch_all(pool)
    .await?)
}

/// Адресаты уведомления (без NATS — для тестов).
pub async fn notice_recipients(
    pool: &SqlitePool,
    group_id: &str,
    target: &GroupRecipients,
) -> Result<Vec<String>> {
    Ok(match target {
        GroupRecipients::Only(addr) => vec![addr.clone()],
        GroupRecipients::AllMembers => active_members(pool, group_id)
            .await?
            .into_iter()
            .map(|(m, _, _)| m)
            .collect(),
        GroupRecipients::InviteManagers => active_members(pool, group_id)
            .await?
            .into_iter()
            .filter(|(_, role, raw)| match role.as_str() {
                "owner" => true,
                "admin" => parse_admin_rights("admin", raw.as_deref())
                    .map(|r| r.invite_users)
                    .unwrap_or(false),
                _ => false,
            })
            .map(|(m, _, _)| m)
            .collect(),
    })
}

/// Собрать кадры уведомления: (адрес инбокса, конверт). Для info/perms/members/
/// admin вкладывается `GroupInfo` (участнику — без pending_requests, менеджеру —
/// с ним). Для группы, которой уже нет (`deleted`), info отсутствует.
pub async fn build_group_notices(
    pool: &SqlitePool,
    group_id: &str,
    change: &str,
    version: u64,
    target: &GroupRecipients,
) -> Result<Vec<(String, ParvaneEvent<GroupNotice>)>> {
    let with_info = matches!(change, "info" | "perms" | "members" | "admin");
    let mut out = Vec::new();
    for addr in notice_recipients(pool, group_id, target).await? {
        let info = if with_info {
            group_info(pool, group_id, Some(&addr)).await?
        } else {
            None
        };
        out.push((
            addr,
            ParvaneEvent {
                id: Uuid::now_v7(),
                from: "messenger".to_string(),
                ts: now_unix(),
                token: String::new(),
                payload: GroupNotice {
                    group: GroupNoticePayload {
                        group_id: group_id.to_string(),
                        version,
                        change: change.to_string(),
                        info,
                    },
                },
            },
        ));
    }
    Ok(out)
}

/// Разослать уведомление об изменении группы. Ошибки публикации — warn, не ошибка запроса.
pub async fn notify_group(
    nc: &Client,
    pool: &SqlitePool,
    group_id: &str,
    change: &str,
    version: u64,
    target: GroupRecipients,
) {
    match build_group_notices(pool, group_id, change, version, &target).await {
        Ok(frames) => {
            for (addr, ev) in frames {
                match serde_json::to_vec(&ev) {
                    Ok(bytes) => {
                        if let Err(e) = nc.publish(msg_inbox(&addr), bytes.into()).await {
                            warn!("нотис группы {} ({}) для {}: {}", group_id, change, addr, e);
                        }
                    }
                    Err(e) => warn!("нотис группы {}: сериализация: {}", group_id, e),
                }
            }
        }
        Err(e) => warn!("нотис группы {} ({}): {}", group_id, change, e),
    }
}

// ── ответы ───────────────────────────────────────────────────────────────────

fn fail(code: &str, msg: &str) -> GroupActionResponse {
    GroupActionResponse { ok: false, error: Some(msg.to_string()), error_code: Some(code.to_string()) }
}

fn ok_action() -> GroupActionResponse {
    GroupActionResponse { ok: true, error: None, error_code: None }
}

fn vfail(code: &str, msg: &str) -> GroupVersionResponse {
    GroupVersionResponse { ok: false, version: 0, error: Some(msg.to_string()), error_code: Some(code.to_string()) }
}

async fn reply<T: serde::Serialize>(nc: &Client, msg: &async_nats::Message, resp: &T) {
    let Some(reply) = msg.reply.clone() else { return };
    let _ = nc.publish(reply, serde_json::to_vec(resp).unwrap_or_default().into()).await;
}

async fn group_exists(pool: &SqlitePool, group_id: &str) -> Result<Option<String>> {
    let k: Option<(String,)> = sqlx::query_as("SELECT kind FROM groups WHERE id = ?")
        .bind(group_id)
        .fetch_optional(pool)
        .await?;
    Ok(k.map(|(k,)| k))
}

// ── group.setinfo ────────────────────────────────────────────────────────────

/// Описание и/или фото. Владелец, админ с change_info, участник с default change_info.
pub async fn set_info(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    about: Option<&str>,
    avatar_file_id: Option<&str>,
    clear_avatar: bool,
) -> Result<GroupVersionResponse> {
    if group_exists(pool, group_id).await?.is_none() {
        return Ok(vfail("not_found", "группы нет"));
    }
    if !has_group_right(pool, group_id, actor, GroupRight::ChangeInfo, true).await? {
        return Ok(vfail("forbidden", "нет права менять информацию"));
    }
    if let Some(a) = about {
        if a.chars().count() > MAX_ABOUT_CHARS {
            return Ok(vfail("bad_request", "описание длиннее 255 символов"));
        }
    }
    if let Some(f) = avatar_file_id {
        if !clear_avatar && Uuid::parse_str(f).is_err() {
            return Ok(vfail("bad_request", "avatar_file_id не UUID"));
        }
    }
    let mut tx = pool.begin().await?;
    if let Some(a) = about {
        sqlx::query("UPDATE groups SET about = ? WHERE id = ?")
            .bind(a.trim())
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
    }
    if clear_avatar {
        sqlx::query("UPDATE groups SET avatar_file_id = NULL WHERE id = ?")
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
    } else if let Some(f) = avatar_file_id {
        sqlx::query("UPDATE groups SET avatar_file_id = ? WHERE id = ?")
            .bind(f)
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
    }
    let version = bump_group_version(&mut *tx, group_id).await?;
    tx.commit().await?;
    Ok(GroupVersionResponse { ok: true, version, error: None, error_code: None })
}

pub async fn handle_group_setinfo(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupSetInfoRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.setinfo")?;
        let actor = verify_token(nc, &req.token).await?;
        let r = set_info(
            pool,
            &req.group_id,
            &actor,
            req.about.as_deref(),
            req.avatar_file_id.as_deref(),
            req.clear_avatar,
        )
        .await?;
        if r.ok {
            info!("Группа {}: сведения обновлены (v{}) {}", req.group_id, r.version, actor);
            notify_group(nc, pool, &req.group_id, "info", r.version, GroupRecipients::AllMembers).await;
        }
        anyhow::Ok(r)
    }
    .await
    .unwrap_or_else(|e| vfail("bad_request", &e.to_string()));
    reply(nc, &msg, &resp).await;
}

// ── group.setperms ───────────────────────────────────────────────────────────

pub async fn set_perms(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    perms: &DefaultPermissions,
) -> Result<GroupVersionResponse> {
    let Some(kind) = group_exists(pool, group_id).await? else {
        return Ok(vfail("not_found", "группы нет"));
    };
    if kind == "channel" {
        return Ok(vfail("bad_request", "у канала нет прав участников"));
    }
    if !has_group_right(pool, group_id, actor, GroupRight::ChangeInfo, false).await? {
        return Ok(vfail("forbidden", "нет права менять информацию"));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE groups SET default_perms_json = ? WHERE id = ?")
        .bind(serde_json::to_string(perms)?)
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
    let version = bump_group_version(&mut *tx, group_id).await?;
    tx.commit().await?;
    Ok(GroupVersionResponse { ok: true, version, error: None, error_code: None })
}

pub async fn handle_group_setperms(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupSetPermsRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.setperms")?;
        let actor = verify_token(nc, &req.token).await?;
        let r = set_perms(pool, &req.group_id, &actor, &req.default_permissions).await?;
        if r.ok {
            info!("Группа {}: права по умолчанию обновлены (v{}) {}", req.group_id, r.version, actor);
            notify_group(nc, pool, &req.group_id, "perms", r.version, GroupRecipients::AllMembers).await;
        }
        anyhow::Ok(r)
    }
    .await
    .unwrap_or_else(|e| vfail("bad_request", &e.to_string()));
    reply(nc, &msg, &resp).await;
}

// ── group.setadmin ───────────────────────────────────────────────────────────

pub async fn set_admin(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
    rights: Option<&AdminRights>,
) -> Result<GroupVersionResponse> {
    if group_exists(pool, group_id).await?.is_none() {
        return Ok(vfail("not_found", "группы нет"));
    }
    let actor_role = member_role(pool, group_id, actor).await?;
    let target: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT role, promoted_by FROM group_members WHERE group_id = ? AND member = ?",
    )
    .bind(group_id)
    .bind(member)
    .fetch_optional(pool)
    .await?;
    let Some((target_role, promoted_by)) = target else {
        return Ok(vfail("not_member", "не участник"));
    };
    if matches!(target_role.as_str(), "owner" | "banned") {
        return Ok(vfail("forbidden", "владельца и забаненного менять нельзя"));
    }
    match actor_role.as_deref() {
        Some("owner") => {}
        Some("admin") => {
            let own = load_admin_rights(pool, group_id, actor).await?.unwrap_or_default();
            if !admin_has(&own, GroupRight::AddAdmins) {
                return Ok(vfail("forbidden", "нет права добавлять админов"));
            }
            match rights {
                Some(r) => {
                    if !r.is_subset_of(&own) {
                        return Ok(vfail("forbidden", "можно выдать только свои права"));
                    }
                }
                None => {
                    if promoted_by.as_deref() != Some(actor) {
                        return Ok(vfail("forbidden", "снять можно только назначенного собой"));
                    }
                }
            }
        }
        _ => return Ok(vfail("forbidden", "нет прав")),
    }
    let mut tx = pool.begin().await?;
    match rights {
        Some(r) if r.any() => {
            sqlx::query(
                "UPDATE group_members SET role = 'admin', admin_rights_json = ?, promoted_by = ?
                  WHERE group_id = ? AND member = ?",
            )
            .bind(serde_json::to_string(r)?)
            .bind(actor)
            .bind(group_id)
            .bind(member)
            .execute(&mut *tx)
            .await?;
        }
        _ => {
            sqlx::query(
                "UPDATE group_members SET role = 'member', admin_rights_json = NULL, promoted_by = NULL
                  WHERE group_id = ? AND member = ?",
            )
            .bind(group_id)
            .bind(member)
            .execute(&mut *tx)
            .await?;
        }
    }
    let version = bump_group_version(&mut *tx, group_id).await?;
    tx.commit().await?;
    Ok(GroupVersionResponse { ok: true, version, error: None, error_code: None })
}

pub async fn handle_group_setadmin(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupSetAdminRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.setadmin")?;
        let actor = verify_token(nc, &req.token).await?;
        let r = set_admin(pool, &req.group_id, &actor, &req.member, req.rights.as_ref()).await?;
        if r.ok {
            info!("Группа {}: админ {} → {:?} (v{}) {}", req.group_id, req.member, req.rights.is_some(), r.version, actor);
            notify_group(nc, pool, &req.group_id, "admin", r.version, GroupRecipients::AllMembers).await;
        }
        anyhow::Ok(r)
    }
    .await
    .unwrap_or_else(|e| vfail("bad_request", &e.to_string()));
    reply(nc, &msg, &resp).await;
}

// ── инвайт-ссылки ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct InviteRow {
    pub token: String,
    pub group_id: String,
    pub created_by: String,
    pub created_at: i64,
    pub revoked: i64,
    pub title: String,
    pub expires_at: i64,
    pub max_uses: i64,
    pub uses: i64,
    pub request_needed: i64,
    pub revoked_at: i64,
}

const INVITE_COLUMNS: &str = "token, group_id, created_by, created_at, revoked, title, expires_at, max_uses, uses, request_needed, revoked_at";

pub fn invite_state(row: &InviteRow, now: i64) -> &'static str {
    if row.revoked != 0 {
        "revoked"
    } else if row.expires_at > 0 && row.expires_at <= now {
        "expired"
    } else if row.max_uses > 0 && row.uses >= row.max_uses {
        "exhausted"
    } else {
        "active"
    }
}

fn is_plain(row: &InviteRow) -> bool {
    row.title.is_empty() && row.expires_at == 0 && row.max_uses == 0 && row.request_needed == 0
}

/// Основная ссылка — самая ранняя активная ссылка владельца без параметров.
pub fn primary_token(rows: &[InviteRow], owner: &str, now: i64) -> Option<String> {
    rows.iter()
        .filter(|r| r.created_by == owner && is_plain(r) && invite_state(r, now) == "active")
        .min_by_key(|r| (r.created_at, r.token.clone()))
        .map(|r| r.token.clone())
}

async fn load_invite(pool: &SqlitePool, token: &str) -> Result<Option<InviteRow>> {
    Ok(sqlx::query_as::<_, InviteRow>(&format!(
        "SELECT {INVITE_COLUMNS} FROM group_invites WHERE token = ?"
    ))
    .bind(token)
    .fetch_optional(pool)
    .await?)
}

async fn group_owner(pool: &SqlitePool, group_id: &str) -> Result<Option<String>> {
    let o: Option<(String,)> = sqlx::query_as("SELECT created_by FROM groups WHERE id = ?")
        .bind(group_id)
        .fetch_optional(pool)
        .await?;
    Ok(o.map(|(o,)| o))
}

async fn pending_for_invite(pool: &SqlitePool, token: &str) -> Result<u32> {
    let n: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM group_join_requests WHERE invite_token = ? AND status = 'pending'",
    )
    .bind(token)
    .fetch_one(pool)
    .await?;
    Ok(n.0.max(0) as u32)
}

async fn build_invite_link(pool: &SqlitePool, row: &InviteRow, primary: Option<&str>, now: i64) -> Result<InviteLink> {
    Ok(InviteLink {
        token: row.token.clone(),
        created_by: row.created_by.clone(),
        created_at: row.created_at,
        title: row.title.clone(),
        expires_at: row.expires_at,
        max_uses: row.max_uses.max(0) as u32,
        uses: row.uses.max(0) as u32,
        request_needed: row.request_needed != 0,
        revoked: row.revoked != 0,
        revoked_at: row.revoked_at,
        state: invite_state(row, now).to_string(),
        is_primary: primary == Some(row.token.as_str()),
        pending_requests: pending_for_invite(pool, &row.token).await?,
    })
}

pub async fn list_invites(pool: &SqlitePool, group_id: &str, revoked: bool, now: i64) -> Result<Vec<InviteLink>> {
    let rows: Vec<InviteRow> = sqlx::query_as::<_, InviteRow>(&format!(
        "SELECT {INVITE_COLUMNS} FROM group_invites WHERE group_id = ? AND revoked = ? ORDER BY created_at, token"
    ))
    .bind(group_id)
    .bind(if revoked { 1 } else { 0 })
    .fetch_all(pool)
    .await?;
    let owner = group_owner(pool, group_id).await?.unwrap_or_default();
    let primary = primary_token(&rows, &owner, now);
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(build_invite_link(pool, r, primary.as_deref(), now).await?);
    }
    Ok(out)
}

async fn active_invite_count(pool: &SqlitePool, group_id: &str, now: i64) -> Result<i64> {
    let n: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM group_invites
          WHERE group_id = ? AND revoked = 0
            AND (expires_at = 0 OR expires_at > ?)
            AND (max_uses = 0 OR uses < max_uses)",
    )
    .bind(group_id)
    .bind(now)
    .fetch_one(pool)
    .await?;
    Ok(n.0)
}

pub async fn create_invite(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    title: &str,
    expires_at: i64,
    max_uses: u32,
    request_needed: bool,
    now: i64,
) -> Result<GroupInviteCreateResponse> {
    let fail = |code: &str, msg: &str| GroupInviteCreateResponse {
        ok: false,
        invite: None,
        error: Some(msg.to_string()),
        error_code: Some(code.to_string()),
        link: None,
    };
    if group_exists(pool, group_id).await?.is_none() {
        return Ok(fail("not_found", "группы нет"));
    }
    if !has_group_right(pool, group_id, actor, GroupRight::InviteUsers, false).await? {
        return Ok(fail("forbidden", "нет прав"));
    }
    if title.chars().count() > MAX_INVITE_TITLE_CHARS {
        return Ok(fail("bad_request", "название ссылки длиннее 32 символов"));
    }
    if active_invite_count(pool, group_id, now).await? >= MAX_ACTIVE_INVITES {
        return Ok(fail("limit", "слишком много активных ссылок"));
    }
    let token = Uuid::now_v7().simple().to_string();
    sqlx::query(
        "INSERT INTO group_invites (token, group_id, created_by, created_at, title, expires_at, max_uses, request_needed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&token)
    .bind(group_id)
    .bind(actor)
    .bind(now)
    .bind(title.trim())
    .bind(expires_at.max(0))
    .bind(max_uses as i64)
    .bind(if request_needed { 1 } else { 0 })
    .execute(pool)
    .await?;
    let row = load_invite(pool, &token).await?.context("ссылка не сохранилась")?;
    let owner = group_owner(pool, group_id).await?.unwrap_or_default();
    let all: Vec<InviteRow> = sqlx::query_as::<_, InviteRow>(&format!(
        "SELECT {INVITE_COLUMNS} FROM group_invites WHERE group_id = ? AND revoked = 0"
    ))
    .bind(group_id)
    .fetch_all(pool)
    .await?;
    let primary = primary_token(&all, &owner, now);
    let link = build_invite_link(pool, &row, primary.as_deref(), now).await?;
    Ok(GroupInviteCreateResponse { ok: true, invite: Some(token), error: None, error_code: None, link: Some(link) })
}

pub async fn handle_group_invite_create(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupInviteCreateRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.invite.create")?;
        let actor = verify_token(nc, &req.token).await?;
        let r = create_invite(
            pool,
            &req.group_id,
            &actor,
            &req.title,
            req.expires_at,
            req.max_uses,
            req.request_needed,
            now_unix(),
        )
        .await?;
        if r.ok {
            info!("Инвайт для {} создан ({})", req.group_id, actor);
            let v = current_version(pool, &req.group_id).await.unwrap_or(0);
            notify_group(nc, pool, &req.group_id, "invites", v, GroupRecipients::InviteManagers).await;
        }
        anyhow::Ok(r)
    }
    .await
    .unwrap_or_else(|e| GroupInviteCreateResponse {
        ok: false,
        invite: None,
        error: Some(e.to_string()),
        error_code: Some("bad_request".into()),
        link: None,
    });
    reply(nc, &msg, &resp).await;
}

pub async fn handle_group_invite_list(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupInviteListRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.invite.list")?;
        let actor = verify_token(nc, &req.token).await?;
        if !is_invite_manager(pool, &req.group_id, &actor).await? {
            return anyhow::Ok(GroupInviteListResponse {
                ok: false,
                links: vec![],
                error: Some("нет прав".into()),
                error_code: Some("forbidden".into()),
            });
        }
        let links = list_invites(pool, &req.group_id, req.revoked, now_unix()).await?;
        anyhow::Ok(GroupInviteListResponse { ok: true, links, error: None, error_code: None })
    }
    .await
    .unwrap_or_else(|e| GroupInviteListResponse {
        ok: false,
        links: vec![],
        error: Some(e.to_string()),
        error_code: Some("bad_request".into()),
    });
    reply(nc, &msg, &resp).await;
}

pub async fn revoke_invite(pool: &SqlitePool, group_id: &str, actor: &str, token: &str, now: i64) -> Result<GroupActionResponse> {
    if !is_invite_manager(pool, group_id, actor).await? {
        return Ok(fail("forbidden", "нет прав"));
    }
    let n = sqlx::query(
        "UPDATE group_invites SET revoked = 1, revoked_at = ? WHERE token = ? AND group_id = ? AND revoked = 0",
    )
    .bind(now)
    .bind(token)
    .bind(group_id)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(if n > 0 { ok_action() } else { fail("not_found", "ссылки нет или уже отозвана") })
}

pub async fn delete_invite(pool: &SqlitePool, group_id: &str, actor: &str, token: &str) -> Result<GroupActionResponse> {
    if !is_invite_manager(pool, group_id, actor).await? {
        return Ok(fail("forbidden", "нет прав"));
    }
    let Some(row) = load_invite(pool, token).await? else {
        return Ok(fail("not_found", "ссылки нет"));
    };
    if row.group_id != group_id {
        return Ok(fail("not_found", "ссылки нет"));
    }
    if row.revoked == 0 {
        return Ok(fail("bad_request", "удалить можно только отозванную ссылку"));
    }
    sqlx::query("DELETE FROM group_invites WHERE token = ?")
        .bind(token)
        .execute(pool)
        .await?;
    Ok(ok_action())
}

pub async fn handle_group_invite_revoke(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupInviteTokenRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.invite.revoke")?;
        let actor = verify_token(nc, &req.token).await?;
        let r = revoke_invite(pool, &req.group_id, &actor, &req.invite, now_unix()).await?;
        if r.ok {
            info!("Инвайт {} группы {} отозван ({})", req.invite, req.group_id, actor);
            let v = current_version(pool, &req.group_id).await.unwrap_or(0);
            notify_group(nc, pool, &req.group_id, "invites", v, GroupRecipients::InviteManagers).await;
        }
        anyhow::Ok(r)
    }
    .await
    .unwrap_or_else(|e| fail("bad_request", &e.to_string()));
    reply(nc, &msg, &resp).await;
}

pub async fn handle_group_invite_delete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupInviteTokenRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.invite.delete")?;
        let actor = verify_token(nc, &req.token).await?;
        let r = delete_invite(pool, &req.group_id, &actor, &req.invite).await?;
        if r.ok {
            let v = current_version(pool, &req.group_id).await.unwrap_or(0);
            notify_group(nc, pool, &req.group_id, "invites", v, GroupRecipients::InviteManagers).await;
        }
        anyhow::Ok(r)
    }
    .await
    .unwrap_or_else(|e| fail("bad_request", &e.to_string()));
    reply(nc, &msg, &resp).await;
}

/// Превью ссылки: имя, фото, описание, число участников, режим одобрения.
pub async fn check_invite(pool: &SqlitePool, token: &str, actor: &str, now: i64) -> Result<GroupInviteCheckResponse> {
    let fail = |code: &str, msg: &str| GroupInviteCheckResponse {
        ok: false,
        error: Some(msg.to_string()),
        error_code: Some(code.to_string()),
        ..Default::default()
    };
    let Some(row) = load_invite(pool, token).await? else {
        return Ok(fail("invalid", "ссылка недействительна"));
    };
    let role = member_role(pool, &row.group_id, actor).await?;
    if matches!(role.as_deref(), Some("banned")) {
        return Ok(fail("banned", "вы забанены в этой группе"));
    }
    let state = invite_state(&row, now);
    if state != "active" {
        return Ok(fail(state, &format!("ссылка: {state}")));
    }
    let g: Option<(String, String, Option<String>, String)> =
        sqlx::query_as("SELECT name, kind, avatar_file_id, about FROM groups WHERE id = ?")
            .bind(&row.group_id)
            .fetch_optional(pool)
            .await?;
    let Some((name, kind, avatar, about)) = g else {
        return Ok(fail("invalid", "ссылка недействительна"));
    };
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM group_members WHERE group_id = ? AND role IN ('owner','admin','member')",
    )
    .bind(&row.group_id)
    .fetch_one(pool)
    .await?;
    let pending: Option<(String,)> = sqlx::query_as(
        "SELECT status FROM group_join_requests WHERE group_id = ? AND member = ?",
    )
    .bind(&row.group_id)
    .bind(actor)
    .fetch_optional(pool)
    .await?;
    Ok(GroupInviteCheckResponse {
        ok: true,
        group_id: Some(row.group_id.clone()),
        name: Some(name),
        kind: Some(if kind == "channel" { GroupKind::Channel } else { GroupKind::Group }),
        avatar,
        about,
        members_count: count.0.max(0) as u32,
        request_needed: row.request_needed != 0,
        already_member: matches!(role.as_deref(), Some("owner") | Some("admin") | Some("member")),
        pending: matches!(pending.as_ref().map(|(s,)| s.as_str()), Some("pending")),
        error: None,
        error_code: None,
    })
}

pub async fn handle_group_invite_check(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupInviteCheckRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.invite.check")?;
        let actor = verify_token(nc, &req.token).await?;
        check_invite(pool, &req.invite, &actor, now_unix()).await
    }
    .await
    .unwrap_or_else(|e| GroupInviteCheckResponse {
        ok: false,
        error: Some(e.to_string()),
        error_code: Some("bad_request".into()),
        ..Default::default()
    });
    reply(nc, &msg, &resp).await;
}

// ── group.join ───────────────────────────────────────────────────────────────

/// Результат вступления для рассылки нотисов.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinOutcome {
    /// Стал участником (или уже был): версия группы после вступления.
    Joined { version: u64, was_member: bool },
    /// Заявка создана или уже ожидает.
    Pending,
    /// Отказ — ответ уже сформирован.
    Rejected,
}

fn join_fail(code: &str, msg: &str) -> GroupJoinResponse {
    GroupJoinResponse {
        ok: false,
        group_id: None,
        name: None,
        error: Some(msg.to_string()),
        error_code: Some(code.to_string()),
        pending: false,
    }
}

/// Атомарное вступление: одна транзакция, `UPDATE … uses+1 WHERE …` решает
/// лимит/срок/отзыв; при `request_needed` — заявка вместо членства.
pub async fn join_by_invite(
    pool: &SqlitePool,
    token: &str,
    user: &str,
    now: i64,
) -> Result<(GroupJoinResponse, JoinOutcome)> {
    let Some(row) = load_invite(pool, token).await? else {
        return Ok((join_fail("invalid", "ссылка недействительна"), JoinOutcome::Rejected));
    };
    let group_id = row.group_id.clone();
    let name: Option<(String,)> = sqlx::query_as("SELECT name FROM groups WHERE id = ?")
        .bind(&group_id)
        .fetch_optional(pool)
        .await?;
    let Some((name,)) = name else {
        return Ok((join_fail("invalid", "ссылка недействительна"), JoinOutcome::Rejected));
    };
    let role = member_role(pool, &group_id, user).await?;
    if matches!(role.as_deref(), Some("banned")) {
        return Ok((join_fail("banned", "вы забанены в этой группе"), JoinOutcome::Rejected));
    }
    let ok_resp = |pending: bool| GroupJoinResponse {
        ok: true,
        group_id: Some(group_id.clone()),
        name: Some(name.clone()),
        error: None,
        error_code: None,
        pending,
    };
    if role.is_some() {
        // Уже участник: ссылка просто открывает группу, счётчик не трогаем.
        let v = current_version(pool, &group_id).await?;
        return Ok((ok_resp(false), JoinOutcome::Joined { version: v, was_member: true }));
    }
    let state = invite_state(&row, now);
    if state != "active" {
        return Ok((join_fail(state, &format!("ссылка: {state}")), JoinOutcome::Rejected));
    }
    if row.request_needed != 0 {
        let prev: Option<(String, i64)> = sqlx::query_as(
            "SELECT status, decided_at FROM group_join_requests WHERE group_id = ? AND member = ?",
        )
        .bind(&group_id)
        .bind(user)
        .fetch_optional(pool)
        .await?;
        match prev {
            Some((s, _)) if s == "pending" => return Ok((ok_resp(true), JoinOutcome::Pending)),
            Some((s, decided_at)) if s == "declined" && now - decided_at < DECLINED_RETRY_SECS => {
                return Ok((join_fail("declined", "заявка отклонена"), JoinOutcome::Rejected));
            }
            _ => {}
        }
        sqlx::query(
            "INSERT INTO group_join_requests (group_id, member, invite_token, created_at, status, decided_by, decided_at)
             VALUES (?, ?, ?, ?, 'pending', NULL, 0)
             ON CONFLICT(group_id, member) DO UPDATE SET invite_token = excluded.invite_token,
                 created_at = excluded.created_at, status = 'pending', decided_by = NULL, decided_at = 0",
        )
        .bind(&group_id)
        .bind(user)
        .bind(token)
        .bind(now)
        .execute(pool)
        .await?;
        return Ok((ok_resp(true), JoinOutcome::Pending));
    }
    let mut tx = pool.begin().await?;
    let n = sqlx::query(
        "UPDATE group_invites SET uses = uses + 1
          WHERE token = ? AND revoked = 0
            AND (expires_at = 0 OR expires_at > ?)
            AND (max_uses = 0 OR uses < max_uses)",
    )
    .bind(token)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        tx.rollback().await?;
        let fresh = load_invite(pool, token).await?;
        let state = fresh.as_ref().map(|r| invite_state(r, now)).unwrap_or("invalid");
        let state = if state == "active" { "invalid" } else { state };
        return Ok((join_fail(state, &format!("ссылка: {state}")), JoinOutcome::Rejected));
    }
    sqlx::query("INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'member')")
        .bind(&group_id)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    let version = bump_group_version(&mut *tx, &group_id).await?;
    tx.commit().await?;
    Ok((ok_resp(false), JoinOutcome::Joined { version, was_member: false }))
}

pub async fn handle_group_join(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupJoinRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.join")?;
        let user = verify_token(nc, &req.token).await?;
        let (resp, outcome) = join_by_invite(pool, &req.invite, &user, now_unix()).await?;
        if let Some(gid) = resp.group_id.as_deref() {
            match outcome {
                JoinOutcome::Joined { version, was_member: false } => {
                    info!("{} вступил в {} по инвайту", user, gid);
                    notify_group(nc, pool, gid, "members", version, GroupRecipients::AllMembers).await;
                    notify_group(nc, pool, gid, "invites", version, GroupRecipients::InviteManagers).await;
                }
                JoinOutcome::Pending => {
                    info!("{} подал заявку в {}", user, gid);
                    let v = current_version(pool, gid).await.unwrap_or(0);
                    notify_group(nc, pool, gid, "requests", v, GroupRecipients::InviteManagers).await;
                }
                _ => {}
            }
        }
        anyhow::Ok(resp)
    }
    .await
    .unwrap_or_else(|e| join_fail("bad_request", &e.to_string()));
    reply(nc, &msg, &resp).await;
}

// ── заявки ───────────────────────────────────────────────────────────────────

pub async fn list_requests(pool: &SqlitePool, group_id: &str) -> Result<Vec<JoinRequestInfo>> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT member, invite_token, created_at FROM group_join_requests
          WHERE group_id = ? AND status = 'pending' ORDER BY created_at, member",
    )
    .bind(group_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(member, invite, created_at)| JoinRequestInfo { member, invite, created_at })
        .collect())
}

pub async fn handle_group_request_list(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupRequestListRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.request.list")?;
        let actor = verify_token(nc, &req.token).await?;
        if !is_invite_manager(pool, &req.group_id, &actor).await? {
            return anyhow::Ok(GroupRequestListResponse {
                ok: false,
                requests: vec![],
                error: Some("нет прав".into()),
                error_code: Some("forbidden".into()),
            });
        }
        anyhow::Ok(GroupRequestListResponse {
            ok: true,
            requests: list_requests(pool, &req.group_id).await?,
            error: None,
            error_code: None,
        })
    }
    .await
    .unwrap_or_else(|e| GroupRequestListResponse {
        ok: false,
        requests: vec![],
        error: Some(e.to_string()),
        error_code: Some("bad_request".into()),
    });
    reply(nc, &msg, &resp).await;
}

/// Одобрить (членство + uses+1 у ссылки + ревизия) или отклонить.
pub async fn decide_request(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
    approve: bool,
    now: i64,
) -> Result<GroupVersionResponse> {
    if !is_invite_manager(pool, group_id, actor).await? {
        return Ok(vfail("forbidden", "нет прав"));
    }
    let prev: Option<(String, String)> = sqlx::query_as(
        "SELECT status, invite_token FROM group_join_requests WHERE group_id = ? AND member = ?",
    )
    .bind(group_id)
    .bind(member)
    .fetch_optional(pool)
    .await?;
    let Some((status, invite_token)) = prev else {
        return Ok(vfail("not_found", "заявки нет"));
    };
    if status != "pending" {
        return Ok(vfail("bad_request", "заявка уже решена"));
    }
    let mut tx = pool.begin().await?;
    let version = if approve {
        sqlx::query("INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'member')")
            .bind(group_id)
            .bind(member)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE group_invites SET uses = uses + 1 WHERE token = ?")
            .bind(&invite_token)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE group_join_requests SET status = 'approved', decided_by = ?, decided_at = ?
              WHERE group_id = ? AND member = ?",
        )
        .bind(actor)
        .bind(now)
        .bind(group_id)
        .bind(member)
        .execute(&mut *tx)
        .await?;
        bump_group_version(&mut *tx, group_id).await?
    } else {
        sqlx::query(
            "UPDATE group_join_requests SET status = 'declined', decided_by = ?, decided_at = ?
              WHERE group_id = ? AND member = ?",
        )
        .bind(actor)
        .bind(now)
        .bind(group_id)
        .bind(member)
        .execute(&mut *tx)
        .await?;
        current_version(&mut *tx, group_id).await?
    };
    tx.commit().await?;
    Ok(GroupVersionResponse { ok: true, version, error: None, error_code: None })
}

pub async fn handle_group_request_decide(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let resp = async {
        let req: GroupRequestDecideRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.request.decide")?;
        let actor = verify_token(nc, &req.token).await?;
        let r = decide_request(pool, &req.group_id, &actor, &req.member, req.approve, now_unix()).await?;
        if r.ok {
            info!("Заявка {} в {}: {} ({})", req.member, req.group_id, if req.approve { "одобрена" } else { "отклонена" }, actor);
            if req.approve {
                notify_group(nc, pool, &req.group_id, "members", r.version, GroupRecipients::AllMembers).await;
                notify_group(nc, pool, &req.group_id, "invites", r.version, GroupRecipients::InviteManagers).await;
            }
            notify_group(nc, pool, &req.group_id, "requests", r.version, GroupRecipients::InviteManagers).await;
        }
        anyhow::Ok(r)
    }
    .await
    .unwrap_or_else(|e| vfail("bad_request", &e.to_string()));
    reply(nc, &msg, &resp).await;
}

/// Снять заявку пользователя (бан) — FR-024.
pub async fn drop_join_request(pool: &SqlitePool, group_id: &str, member: &str) -> Result<()> {
    sqlx::query("DELETE FROM group_join_requests WHERE group_id = ? AND member = ?")
        .bind(group_id)
        .bind(member)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn seed_group(pool: &SqlitePool, kind: &str) -> String {
        let gid = "g1@local".to_string();
        sqlx::query("INSERT INTO groups (id, name, kind, created_by, created_at) VALUES (?, 'G', ?, 'owner@local', 1)")
            .bind(&gid)
            .bind(kind)
            .execute(pool)
            .await
            .unwrap();
        for (m, role) in [("owner@local", "owner"), ("legacy@local", "admin"), ("member@local", "member"), ("banned@local", "banned")] {
            sqlx::query("INSERT INTO group_members (group_id, member, role) VALUES (?, ?, ?)")
                .bind(&gid)
                .bind(m)
                .bind(role)
                .execute(pool)
                .await
                .unwrap();
        }
        // частичный админ: только закреп
        sqlx::query(
            "INSERT INTO group_members (group_id, member, role, admin_rights_json, promoted_by) VALUES (?, 'pinner@local', 'admin', ?, 'owner@local')",
        )
        .bind(&gid)
        .bind(serde_json::to_string(&AdminRights { change_info: false, delete_messages: false, ban_users: false, invite_users: false, pin_messages: true, add_admins: false }).unwrap())
        .execute(pool)
        .await
        .unwrap();
        gid
    }

    const ALL: [GroupRight; 6] = [
        GroupRight::ChangeInfo,
        GroupRight::DeleteMessages,
        GroupRight::BanUsers,
        GroupRight::InviteUsers,
        GroupRight::PinMessages,
        GroupRight::AddAdmins,
    ];

    #[tokio::test]
    async fn group_rights_matrix() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        for r in ALL {
            assert!(has_group_right(&pool, &gid, "owner@local", r, false).await.unwrap(), "owner {:?}", r);
            assert!(has_group_right(&pool, &gid, "legacy@local", r, false).await.unwrap(), "legacy admin {:?}", r);
            assert_eq!(
                has_group_right(&pool, &gid, "pinner@local", r, false).await.unwrap(),
                r == GroupRight::PinMessages,
                "partial admin {:?}",
                r
            );
            assert!(!has_group_right(&pool, &gid, "banned@local", r, true).await.unwrap(), "banned {:?}", r);
            assert!(!has_group_right(&pool, &gid, "stranger@local", r, true).await.unwrap(), "stranger {:?}", r);
            assert!(!has_group_right(&pool, &gid, "member@local", r, false).await.unwrap(), "member no default {:?}", r);
        }
        // участник по правам по умолчанию: invite_users включён, change_info/pin — нет
        assert!(has_group_right(&pool, &gid, "member@local", GroupRight::InviteUsers, true).await.unwrap());
        assert!(!has_group_right(&pool, &gid, "member@local", GroupRight::ChangeInfo, true).await.unwrap());
        assert!(!has_group_right(&pool, &gid, "member@local", GroupRight::PinMessages, true).await.unwrap());
        assert!(!has_group_right(&pool, &gid, "member@local", GroupRight::BanUsers, true).await.unwrap());
        // владелец включил change_info и pin по умолчанию
        let perms = DefaultPermissions { change_info: true, pin_messages: true, invite_users: false, ..Default::default() };
        assert!(set_perms(&pool, &gid, "owner@local", &perms).await.unwrap().ok);
        assert!(has_group_right(&pool, &gid, "member@local", GroupRight::ChangeInfo, true).await.unwrap());
        assert!(has_group_right(&pool, &gid, "member@local", GroupRight::PinMessages, true).await.unwrap());
        assert!(!has_group_right(&pool, &gid, "member@local", GroupRight::InviteUsers, true).await.unwrap());
    }

    #[tokio::test]
    async fn legacy_admin_has_full_rights() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        let info = group_info(&pool, &gid, Some("owner@local")).await.unwrap().unwrap();
        let legacy = info.members.iter().find(|m| m.address == "legacy@local").unwrap();
        assert_eq!(legacy.admin_rights, Some(AdminRights::full()));
        let pinner = info.members.iter().find(|m| m.address == "pinner@local").unwrap();
        let r = pinner.admin_rights.clone().unwrap();
        assert!(r.pin_messages && !r.ban_users && !r.add_admins);
        assert_eq!(pinner.promoted_by.as_deref(), Some("owner@local"));
        let member = info.members.iter().find(|m| m.address == "member@local").unwrap();
        assert!(member.admin_rights.is_none());
        assert_eq!(info.pending_requests, Some(0));
        let as_member = group_info(&pool, &gid, Some("member@local")).await.unwrap().unwrap();
        assert!(as_member.pending_requests.is_none());
        assert_eq!(as_member.default_permissions, DefaultPermissions::default());
        assert_eq!(as_member.version, 0);
    }

    #[tokio::test]
    async fn group_notice_recipients() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        let mut all = notice_recipients(&pool, &gid, &GroupRecipients::AllMembers).await.unwrap();
        all.sort();
        assert_eq!(all, vec!["legacy@local", "member@local", "owner@local", "pinner@local"]);
        let mut mgr = notice_recipients(&pool, &gid, &GroupRecipients::InviteManagers).await.unwrap();
        mgr.sort();
        assert_eq!(mgr, vec!["legacy@local", "owner@local"]);
        let only = notice_recipients(&pool, &gid, &GroupRecipients::Only("x@local".into())).await.unwrap();
        assert_eq!(only, vec!["x@local"]);
        let frames = build_group_notices(&pool, &gid, "info", 7, &GroupRecipients::AllMembers).await.unwrap();
        assert_eq!(frames.len(), 4);
        for (addr, ev) in &frames {
            assert_eq!(ev.from, "messenger");
            assert_eq!(ev.payload.group.version, 7);
            assert_eq!(ev.payload.group.change, "info");
            let info = ev.payload.group.info.as_ref().unwrap();
            assert_eq!(info.group_id, gid);
            // pending_requests только менеджерам
            assert_eq!(info.pending_requests.is_some(), addr == "owner@local" || addr == "legacy@local");
        }
        let frames = build_group_notices(&pool, &gid, "invites", 7, &GroupRecipients::InviteManagers).await.unwrap();
        assert!(frames.iter().all(|(_, ev)| ev.payload.group.info.is_none()));
        // JSON-кадр несёт поле `group`, а не `message`
        let json = serde_json::to_value(&frames[0].1).unwrap();
        assert!(json["payload"]["group"].is_object());
        assert!(json["payload"].get("message").is_none());
    }

    #[tokio::test]
    async fn group_setinfo_rights_and_limits() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        let long = "я".repeat(255);
        let r = set_info(&pool, &gid, "owner@local", Some(&long), None, false).await.unwrap();
        assert!(r.ok && r.version == 1);
        let r = set_info(&pool, &gid, "owner@local", Some(&"я".repeat(256)), None, false).await.unwrap();
        assert_eq!(r.error_code.as_deref(), Some("bad_request"));
        let r = set_info(&pool, &gid, "member@local", Some("x"), None, false).await.unwrap();
        assert_eq!(r.error_code.as_deref(), Some("forbidden"));
        let r = set_info(&pool, &gid, "pinner@local", Some("x"), None, false).await.unwrap();
        assert_eq!(r.error_code.as_deref(), Some("forbidden"));
        let r = set_info(&pool, &gid, "legacy@local", None, Some("not-a-uuid"), false).await.unwrap();
        assert_eq!(r.error_code.as_deref(), Some("bad_request"));
        let fid = Uuid::now_v7().to_string();
        let r = set_info(&pool, &gid, "legacy@local", None, Some(&fid), false).await.unwrap();
        assert!(r.ok && r.version == 2);
        let info = group_info(&pool, &gid, None).await.unwrap().unwrap();
        assert_eq!(info.avatar.as_deref(), Some(fid.as_str()));
        assert_eq!(info.about, long);
        let r = set_info(&pool, &gid, "owner@local", None, None, true).await.unwrap();
        assert!(r.ok && r.version == 3);
        assert!(group_info(&pool, &gid, None).await.unwrap().unwrap().avatar.is_none());
        // участник с default change_info
        set_perms(&pool, &gid, "owner@local", &DefaultPermissions { change_info: true, ..Default::default() }).await.unwrap();
        let r = set_info(&pool, &gid, "member@local", Some("от участника"), None, false).await.unwrap();
        assert!(r.ok);
    }

    #[tokio::test]
    async fn setperms_rules() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        let perms = DefaultPermissions { send_messages: false, ..Default::default() };
        assert_eq!(set_perms(&pool, &gid, "member@local", &perms).await.unwrap().error_code.as_deref(), Some("forbidden"));
        assert_eq!(set_perms(&pool, &gid, "pinner@local", &perms).await.unwrap().error_code.as_deref(), Some("forbidden"));
        assert!(set_perms(&pool, &gid, "legacy@local", &perms).await.unwrap().ok);
        assert!(!load_default_perms(&pool, &gid).await.unwrap().send_messages);
        // канал
        sqlx::query("UPDATE groups SET kind = 'channel' WHERE id = ?").bind(&gid).execute(&pool).await.unwrap();
        assert_eq!(set_perms(&pool, &gid, "owner@local", &perms).await.unwrap().error_code.as_deref(), Some("bad_request"));
    }

    #[tokio::test]
    async fn setadmin_subset_rule() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        // владелец даёт pinner право add_admins + invite
        let rights = AdminRights { add_admins: true, invite_users: true, pin_messages: true, change_info: false, delete_messages: false, ban_users: false };
        assert!(set_admin(&pool, &gid, "owner@local", "pinner@local", Some(&rights)).await.unwrap().ok);
        // pinner назначает member: только ⊆ своих
        let too_much = AdminRights { ban_users: true, ..rights.clone() };
        assert_eq!(set_admin(&pool, &gid, "pinner@local", "member@local", Some(&too_much)).await.unwrap().error_code.as_deref(), Some("forbidden"));
        let sub = AdminRights { add_admins: false, invite_users: true, pin_messages: false, change_info: false, delete_messages: false, ban_users: false };
        assert!(set_admin(&pool, &gid, "pinner@local", "member@local", Some(&sub)).await.unwrap().ok);
        let m = load_admin_rights(&pool, &gid, "member@local").await.unwrap().unwrap();
        assert!(m.invite_users && !m.pin_messages);
        // legacy-админ (полный набор, promoted_by NULL) не может снять чужого назначенца? — может, у него add_admins, но promoted_by != legacy
        assert_eq!(set_admin(&pool, &gid, "legacy@local", "member@local", None).await.unwrap().error_code.as_deref(), Some("forbidden"));
        // pinner снимает своего назначенца
        assert!(set_admin(&pool, &gid, "pinner@local", "member@local", None).await.unwrap().ok);
        assert_eq!(member_role(&pool, &gid, "member@local").await.unwrap().as_deref(), Some("member"));
        // владелец снимает любого
        assert!(set_admin(&pool, &gid, "owner@local", "legacy@local", None).await.unwrap().ok);
        // цель — владелец / забаненный / не участник
        assert_eq!(set_admin(&pool, &gid, "owner@local", "owner@local", Some(&rights)).await.unwrap().error_code.as_deref(), Some("forbidden"));
        assert_eq!(set_admin(&pool, &gid, "owner@local", "banned@local", Some(&rights)).await.unwrap().error_code.as_deref(), Some("forbidden"));
        assert_eq!(set_admin(&pool, &gid, "owner@local", "nobody@local", Some(&rights)).await.unwrap().error_code.as_deref(), Some("not_member"));
        // участник без прав
        assert_eq!(set_admin(&pool, &gid, "member@local", "pinner@local", None).await.unwrap().error_code.as_deref(), Some("forbidden"));
        // версия росла на каждую удачную операцию: 4 удачных
        assert_eq!(current_version(&pool, &gid).await.unwrap(), 4);
    }

    #[tokio::test]
    async fn invite_states_list_and_limits() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        let now = 1_000_000;
        // legacy-строка без новых колонок — как до миграции
        sqlx::query("INSERT INTO group_invites (token, group_id, created_by, created_at) VALUES ('legacy', ?, 'owner@local', 10)")
            .bind(&gid).execute(&pool).await.unwrap();
        let r = create_invite(&pool, &gid, "owner@local", "temp", now + 100, 1, false, now).await.unwrap();
        assert!(r.ok);
        let temp = r.invite.clone().unwrap();
        assert!(!r.link.as_ref().unwrap().is_primary);
        assert_eq!(create_invite(&pool, &gid, "member@local", "", 0, 0, false, now).await.unwrap().error_code.as_deref(), Some("forbidden"));
        assert_eq!(create_invite(&pool, &gid, "pinner@local", "", 0, 0, false, now).await.unwrap().error_code.as_deref(), Some("forbidden"));
        assert_eq!(create_invite(&pool, &gid, "owner@local", &"x".repeat(33), 0, 0, false, now).await.unwrap().error_code.as_deref(), Some("bad_request"));
        let list = list_invites(&pool, &gid, false, now).await.unwrap();
        assert_eq!(list.len(), 2);
        let legacy = list.iter().find(|l| l.token == "legacy").unwrap();
        assert!(legacy.is_primary && legacy.state == "active");
        // истечение и исчерпание
        assert_eq!(list.iter().find(|l| l.token == temp).unwrap().state, "active");
        assert_eq!(list_invites(&pool, &gid, false, now + 101).await.unwrap().iter().find(|l| l.token == temp).unwrap().state, "expired");
        // join по temp: лимит 1
        let (r1, o1) = join_by_invite(&pool, &temp, "carol@local", now).await.unwrap();
        assert!(r1.ok && matches!(o1, JoinOutcome::Joined { was_member: false, .. }));
        let (r2, _) = join_by_invite(&pool, &temp, "dave@local", now).await.unwrap();
        assert_eq!(r2.error_code.as_deref(), Some("exhausted"));
        assert_eq!(list_invites(&pool, &gid, false, now).await.unwrap().iter().find(|l| l.token == temp).unwrap().uses, 1);
        // повторное открытие участником — ok без инкремента
        let (r3, o3) = join_by_invite(&pool, &temp, "carol@local", now).await.unwrap();
        assert!(r3.ok && matches!(o3, JoinOutcome::Joined { was_member: true, .. }));
        // отзыв: только менеджер; delete только отозванной
        assert_eq!(revoke_invite(&pool, &gid, "member@local", "legacy", now).await.unwrap().error_code.as_deref(), Some("forbidden"));
        assert_eq!(delete_invite(&pool, &gid, "owner@local", "legacy").await.unwrap().error_code.as_deref(), Some("bad_request"));
        assert!(revoke_invite(&pool, &gid, "legacy@local", "legacy", now).await.unwrap().ok);
        assert_eq!(join_by_invite(&pool, "legacy", "eve@local", now).await.unwrap().0.error_code.as_deref(), Some("revoked"));
        assert_eq!(check_invite(&pool, "legacy", "eve@local", now).await.unwrap().error_code.as_deref(), Some("revoked"));
        assert_eq!(list_invites(&pool, &gid, true, now).await.unwrap().len(), 1);
        assert!(delete_invite(&pool, &gid, "owner@local", "legacy").await.unwrap().ok);
        assert!(list_invites(&pool, &gid, true, now).await.unwrap().is_empty());
        assert_eq!(join_by_invite(&pool, "legacy", "eve@local", now).await.unwrap().0.error_code.as_deref(), Some("invalid"));
        // забаненный
        assert_eq!(join_by_invite(&pool, &temp, "banned@local", now).await.unwrap().0.error_code.as_deref(), Some("banned"));
        // лимит 50 активных (temp исчерпана, legacy удалена — активных сейчас 0)
        for _ in 0..50 {
            assert!(create_invite(&pool, &gid, "owner@local", "", 0, 0, false, now).await.unwrap().ok);
        }
        assert_eq!(create_invite(&pool, &gid, "owner@local", "", 0, 0, false, now).await.unwrap().error_code.as_deref(), Some("limit"));
    }

    #[tokio::test]
    async fn invite_check_hides_members_and_shows_preview() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        let now = 5;
        set_info(&pool, &gid, "owner@local", Some("о группе"), None, false).await.unwrap();
        let r = create_invite(&pool, &gid, "owner@local", "", 0, 0, true, now).await.unwrap();
        let tok = r.invite.unwrap();
        let c = check_invite(&pool, &tok, "eve@local", now).await.unwrap();
        assert!(c.ok && c.request_needed && !c.already_member && !c.pending);
        assert_eq!(c.members_count, 4);
        assert_eq!(c.about, "о группе");
        assert_eq!(c.name.as_deref(), Some("G"));
        let json = serde_json::to_value(&c).unwrap();
        assert!(json.get("members").is_none());
        let c = check_invite(&pool, &tok, "member@local", now).await.unwrap();
        assert!(c.already_member);
        assert_eq!(check_invite(&pool, "nope", "eve@local", now).await.unwrap().error_code.as_deref(), Some("invalid"));
    }

    #[tokio::test]
    async fn join_request_lifecycle_and_declined_blocks_24h() {
        let pool = test_pool().await;
        let gid = seed_group(&pool, "group").await;
        let now = 10_000;
        let tok = create_invite(&pool, &gid, "owner@local", "", 0, 0, true, now).await.unwrap().invite.unwrap();
        let (r, o) = join_by_invite(&pool, &tok, "carol@local", now).await.unwrap();
        assert!(r.ok && r.pending && o == JoinOutcome::Pending);
        assert!(member_role(&pool, &gid, "carol@local").await.unwrap().is_none());
        // повтор — та же заявка
        let (r, o) = join_by_invite(&pool, &tok, "carol@local", now + 1).await.unwrap();
        assert!(r.pending && o == JoinOutcome::Pending);
        assert_eq!(list_requests(&pool, &gid).await.unwrap().len(), 1);
        assert!(check_invite(&pool, &tok, "carol@local", now).await.unwrap().pending);
        assert_eq!(group_info(&pool, &gid, Some("owner@local")).await.unwrap().unwrap().pending_requests, Some(1));
        // решать может только менеджер
        assert_eq!(decide_request(&pool, &gid, "member@local", "carol@local", true, now).await.unwrap().error_code.as_deref(), Some("forbidden"));
        assert_eq!(decide_request(&pool, &gid, "pinner@local", "carol@local", true, now).await.unwrap().error_code.as_deref(), Some("forbidden"));
        let r = decide_request(&pool, &gid, "legacy@local", "carol@local", true, now).await.unwrap();
        assert!(r.ok && r.version == 1);
        assert_eq!(member_role(&pool, &gid, "carol@local").await.unwrap().as_deref(), Some("member"));
        assert_eq!(list_invites(&pool, &gid, false, now).await.unwrap()[0].uses, 1);
        assert!(list_requests(&pool, &gid).await.unwrap().is_empty());
        assert_eq!(decide_request(&pool, &gid, "owner@local", "carol@local", true, now).await.unwrap().error_code.as_deref(), Some("bad_request"));
        // отказ и повтор через сутки
        join_by_invite(&pool, &tok, "dave@local", now).await.unwrap();
        assert!(decide_request(&pool, &gid, "owner@local", "dave@local", false, now).await.unwrap().ok);
        assert_eq!(join_by_invite(&pool, &tok, "dave@local", now + 100).await.unwrap().0.error_code.as_deref(), Some("declined"));
        let (r, _) = join_by_invite(&pool, &tok, "dave@local", now + DECLINED_RETRY_SECS + 1).await.unwrap();
        assert!(r.ok && r.pending);
        // бан снимает заявку; забаненный не подаёт
        drop_join_request(&pool, &gid, "dave@local").await.unwrap();
        assert!(list_requests(&pool, &gid).await.unwrap().is_empty());
        assert_eq!(decide_request(&pool, &gid, "owner@local", "dave@local", true, now).await.unwrap().error_code.as_deref(), Some("not_found"));
        assert_eq!(join_by_invite(&pool, &tok, "banned@local", now).await.unwrap().0.error_code.as_deref(), Some("banned"));
    }

    #[test]
    fn admin_rights_subset_and_defaults() {
        let full = AdminRights::full();
        let d = AdminRights::default();
        assert!(d.is_subset_of(&full));
        assert!(!full.is_subset_of(&d));
        assert!(!d.add_admins && full.add_admins);
        assert_eq!(parse_admin_rights("admin", None), Some(AdminRights::full()));
        assert_eq!(parse_admin_rights("member", None), None);
        assert_eq!(parse_admin_rights("admin", Some("{}")), Some(AdminRights::default()));
        let p = parse_default_perms(Some(r#"{"send_messages":false}"#));
        assert!(!p.send_messages && p.send_media && !p.pin_messages);
        assert_eq!(parse_default_perms(Some("")), DefaultPermissions::default());
    }
}
