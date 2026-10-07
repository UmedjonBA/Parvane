//! Группы и каналы: членство, роли, баны; лимиты P-34. Управление (права,
//! инвайт-ссылки, заявки) — `group_mgmt` (spec 003).

use crate::*;

/// Создать группу/канал: создатель — owner, плюс начальные участники. Возвращает
/// group_id (адрес переписки: сообщения шлют с to_user = group_id).
/// P-34: потолок участников группы (PARVANE_GROUP_MAX_MEMBERS, по умолчанию 200).
pub(crate) fn max_group_members() -> i64 {
    std::env::var("PARVANE_GROUP_MAX_MEMBERS").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(200)
}

/// P-34: пользователь может запретить добавлять себя в группы без согласия.
/// Источник — явная настройка v2 `identity.privacy.set` (FR-040), если он её
/// выставлял; иначе (v1-клиенты, до E6) — поле `group_add: "nobody"` в блобе
/// настроек `msg.chat.setnotify`. Тогда попасть в группу он может только сам,
/// по инвайт-ссылке.
pub(crate) async fn allows_group_add(pool: &SqlitePool, member: &str) -> Result<bool> {
    if let Some(v2) = crate::v2_state::privacy_group_add(member).await? {
        return Ok(v2);
    }
    let blob: Option<String> = sqlx::query_scalar("SELECT notify_json FROM user_settings WHERE user = ?")
        .bind(member)
        .fetch_optional(pool)
        .await?;
    let Some(blob) = blob else { return Ok(true) };
    let v: serde_json::Value = serde_json::from_str(&blob).unwrap_or(serde_json::Value::Null);
    Ok(v.get("group_add").and_then(|g| g.as_str()) != Some("nobody"))
}

/// P-34: частота групповых действий на актора (в памяти): создание групп и
/// добавление участников — против спам-групп на N адресов.
/// В тестах лимит снят: счётчик общий на процесс, а тесты параллельно создают
/// группы от одних и тех же адресов. Сам лимитер проверяет отдельный тест.
pub(crate) fn group_action_limit(limit: usize) -> usize {
    if cfg!(test) { usize::MAX } else { limit }
}

pub(crate) fn group_action_rate_ok(scope: &str, actor: &str, limit: usize) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static L: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    let now = now_unix();
    let map = L.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() > 50_000 {
        guard.retain(|_, hits| {
            hits.retain(|&t| now - t < 60);
            !hits.is_empty()
        });
    }
    let key = format!("{scope}:{}", actor.chars().take(128).collect::<String>());
    let hits = guard.entry(key).or_default();
    hits.retain(|&t| now - t < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    true
}

/// MSG-05: потолок названия группы v1 (как у ссылок/описания — ограниченная строка).
pub(crate) const MAX_GROUP_NAME_CHARS: usize = 128;

pub(crate) async fn member_count(pool: &SqlitePool, group_id: &str) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM group_members WHERE group_id = ? AND role != 'banned'")
        .bind(group_id)
        .fetch_one(pool)
        .await?)
}

pub(crate) async fn create_group(
    pool: &SqlitePool,
    name: &str,
    kind: GroupKind,
    creator: &str,
    members: &[String],
    now: i64,
) -> Result<String> {
    if members.len() as i64 >= max_group_members() {
        anyhow::bail!("слишком много участников (максимум {})", max_group_members());
    }
    // MSG-05: имя и адреса участников — ограниченные строки; иначе `group.list`
    // жертвы раздувался за max_payload и переставал отвечать.
    if name.chars().count() > MAX_GROUP_NAME_CHARS {
        anyhow::bail!("слишком длинное название группы");
    }
    if let Some(bad) = members.iter().find(|m| !parvane_types::address::is_valid_address(m)) {
        anyhow::bail!("некорректный адрес участника: {}", bad.chars().take(32).collect::<String>());
    }
    if !group_action_rate_ok("create", creator, group_action_limit(10)) {
        anyhow::bail!("слишком много созданных групп, попробуйте позже");
    }
    let gid = Uuid::now_v7().to_string();
    let kind_str = match kind {
        GroupKind::Channel => "channel",
        GroupKind::Group => "group",
    };
    sqlx::query("INSERT INTO groups (id, name, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&gid)
        .bind(name)
        .bind(kind_str)
        .bind(creator)
        .bind(now)
        .execute(pool)
        .await
        .context("создание группы")?;
    sqlx::query(
        "INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'owner')",
    )
    .bind(&gid)
    .bind(creator)
    .execute(pool)
    .await?;
    for m in members {
        if m == creator {
            continue;
        }
        // P-34: согласие — кто запретил добавление, в группу не попадает
        if !allows_group_add(pool, m).await? {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'member')",
        )
        .bind(&gid)
        .bind(m)
        .execute(pool)
        .await?;
    }
    Ok(gid)
}

/// Роль пользователя в группе (`owner`/`admin`/`member`), None — не участник.
pub(crate) async fn member_role(pool: &SqlitePool, group_id: &str, member: &str) -> Result<Option<String>> {
    let r: Option<(String,)> =
        sqlx::query_as("SELECT role FROM group_members WHERE group_id = ? AND member = ?")
            .bind(group_id)
            .bind(member)
            .fetch_optional(pool)
            .await?;
    Ok(r.map(|(role,)| role))
}

/// Добавить участника (только owner/admin). true — добавлено.
pub(crate) async fn add_group_member(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
) -> Result<bool> {
    let role = member_role(pool, group_id, actor).await?;
    if matches!(
        member_role(pool, group_id, member).await?.as_deref(),
        Some("banned")
    ) {
        return Ok(false); // забанен — сначала разбанить
    }
    if !matches!(role.as_deref(), Some("owner") | Some("admin") | Some("member")) {
        return Ok(false);
    }
    // Владелец; админ с invite_users; участник — если invite_users в правах по умолчанию.
    if !group_mgmt::has_group_right(pool, group_id, actor, group_mgmt::GroupRight::InviteUsers, true).await? {
        return Ok(false);
    }
    // P-34: потолок размера, согласие участника, частота добавлений
    if member_count(pool, group_id).await? >= max_group_members() {
        anyhow::bail!("группа переполнена (максимум {})", max_group_members());
    }
    if !allows_group_add(pool, member).await? {
        anyhow::bail!("пользователь запретил добавлять себя в группы");
    }
    if !group_action_rate_ok("add", actor, group_action_limit(60)) {
        anyhow::bail!("слишком много добавлений, попробуйте позже");
    }
    sqlx::query(
        "INSERT OR IGNORE INTO group_members (group_id, member, role) VALUES (?, ?, 'member')",
    )
    .bind(group_id)
    .bind(member)
    .execute(pool)
    .await?;
    Ok(true)
}

/// Удалить участника (owner/admin, либо сам себя = выйти). owner удалить нельзя.
pub(crate) async fn remove_group_member(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
) -> Result<bool> {
    let actor_role = member_role(pool, group_id, actor).await?;
    let is_self = actor == member;
    let can = is_self
        || group_mgmt::has_group_right(pool, group_id, actor, group_mgmt::GroupRight::BanUsers, false).await?;
    if !can {
        return Ok(false);
    }
    // Админа удаляет только владелец.
    if !is_self
        && matches!(member_role(pool, group_id, member).await?.as_deref(), Some("admin"))
        && !matches!(actor_role.as_deref(), Some("owner"))
    {
        return Ok(false);
    }
    let res = sqlx::query(
        "DELETE FROM group_members WHERE group_id = ? AND member = ? AND role != 'owner'",
    )
    .bind(group_id)
    .bind(member)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Сменить роль участника на admin/member (только owner; owner-роль не трогаем).
pub(crate) async fn set_group_role(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
    role: &str,
) -> Result<bool> {
    let actor_role = member_role(pool, group_id, actor).await?;
    if !matches!(actor_role.as_deref(), Some("owner")) {
        return Ok(false); // только владелец назначает/снимает админов
    }
    if !matches!(role, "admin" | "member") {
        return Ok(false);
    }
    let res = sqlx::query(
        "UPDATE group_members SET role = ?
         WHERE group_id = ? AND member = ? AND role NOT IN ('owner', 'banned')",
    )
    .bind(role)
    .bind(group_id)
    .bind(member)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Переименовать группу. Только owner/admin.
pub(crate) async fn rename_group(pool: &SqlitePool, group_id: &str, actor: &str, name: &str) -> Result<bool> {
    if name.chars().count() > MAX_GROUP_NAME_CHARS {
        anyhow::bail!("слишком длинное название группы");
    }
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Ok(false);
    }
    if !group_mgmt::has_group_right(pool, group_id, actor, group_mgmt::GroupRight::ChangeInfo, true).await? {
        return Ok(false);
    }
    let res = sqlx::query("UPDATE groups SET name = ? WHERE id = ?")
        .bind(trimmed)
        .bind(group_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

pub(crate) async fn delete_group(pool: &SqlitePool, group_id: &str, actor: &str) -> Result<bool> {
    let actor_role = member_role(pool, group_id, actor).await?;
    if !matches!(actor_role.as_deref(), Some("owner")) {
        return Ok(false);
    }
    // P-41: сообщения удалённой группы — в tombstone (sync участников узнаёт об
    // удалении), физически их уберёт gc_messenger по TTL
    let empty = serde_json::to_string(&MessageContent::Text { text: String::new(), entities: vec![], webpage: None })?;
    let now = now_unix();
    sqlx::query(
        "UPDATE messages SET deleted = 1, text = '', kind = 'text', content = ?, updated_at = ?
          WHERE to_user = ? AND deleted = 0",
    )
    .bind(&empty)
    .bind(now)
    .bind(group_id)
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM message_device_copies WHERE message_id IN (SELECT id FROM messages WHERE to_user = ?)",
    )
    .bind(group_id)
    .execute(pool)
    .await?;
    sqlx::query("DELETE FROM group_invites WHERE group_id = ?")
        .bind(group_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM group_join_requests WHERE group_id = ?")
        .bind(group_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM group_members WHERE group_id = ?")
        .bind(group_id)
        .execute(pool)
        .await?;
    let res = sqlx::query("DELETE FROM groups WHERE id = ?")
        .bind(group_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Сведения о группе + участники. None — группы нет. `viewer` — кто
/// спрашивает: владельцу и админам с invite_users добавляется число
/// ожидающих заявок (`pending_requests`), остальным поле не отдаётся.
pub(crate) async fn group_info(pool: &SqlitePool, group_id: &str, viewer: Option<&str>) -> Result<Option<GroupInfo>> {
    let g: Option<(String, String, String, Option<String>, String, String, i64)> = sqlx::query_as(
        "SELECT name, kind, created_by, avatar_file_id, about, default_perms_json, version
           FROM groups WHERE id = ?",
    )
    .bind(group_id)
    .fetch_optional(pool)
    .await?;
    let Some((name, kind, created_by, avatar, about, perms_raw, version)) = g else {
        return Ok(None);
    };
    let members: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT member, role, admin_rights_json, promoted_by FROM group_members
          WHERE group_id = ? ORDER BY role, member",
    )
    .bind(group_id)
    .fetch_all(pool)
    .await?;
    let pending_requests = match viewer {
        Some(v) if group_mgmt::is_invite_manager(pool, group_id, v).await? => {
            let n: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM group_join_requests WHERE group_id = ? AND status = 'pending'",
            )
            .bind(group_id)
            .fetch_one(pool)
            .await?;
            Some(n.0.max(0) as u32)
        }
        _ => None,
    };
    Ok(Some(GroupInfo {
        group_id: group_id.to_string(),
        name,
        kind: if kind == "channel" { GroupKind::Channel } else { GroupKind::Group },
        created_by,
        members: members
            .into_iter()
            .map(|(address, role, rights_raw, promoted_by)| GroupMember {
                admin_rights: group_mgmt::parse_admin_rights(&role, rights_raw.as_deref()),
                promoted_by: if role == "admin" { promoted_by } else { None },
                address,
                role,
            })
            .collect(),
        avatar,
        about,
        default_permissions: group_mgmt::parse_default_perms(Some(&perms_raw)),
        version: version.max(0) as u64,
        pending_requests,
    }))
}

/// Сведения о группе доступны только её активным участникам. Banned-запись
/// нужна для запрета повторного join, но не даёт читать состав группы.
pub(crate) async fn group_info_for_member(
    pool: &SqlitePool,
    group_id: &str,
    user: &str,
) -> Result<Option<GroupInfo>> {
    if !matches!(
        member_role(pool, group_id, user).await?.as_deref(),
        Some("owner") | Some("admin") | Some("member")
    ) {
        return Ok(None);
    }
    group_info(pool, group_id, Some(user)).await
}

/// Все группы пользователя (со сведениями и участниками).
pub(crate) async fn list_groups(pool: &SqlitePool, user: &str) -> Result<Vec<GroupInfo>> {
    let gids: Vec<(String,)> =
        sqlx::query_as("SELECT group_id FROM group_members WHERE member = ? AND role != 'banned'")
            .bind(user)
            .fetch_all(pool)
            .await?;
    let mut out = Vec::new();
    for (gid,) in gids {
        if let Some(info) = group_info(pool, &gid, Some(user)).await? {
            out.push(info);
        }
    }
    Ok(out)
}

pub(crate) async fn handle_group_create(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupCreateRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.create")?;
        let creator = verify_token(nc, &req.token).await?;
        let gid = create_group(pool, &req.name, req.kind, &creator, &req.members, now_unix()).await?;
        debug!("Группа '{}' создана: {} ({})", req.name, gid, creator);
        anyhow::Ok(GroupCreateResponse { ok: true, group_id: Some(gid), error: None })
    }
    .await
    .unwrap_or_else(|e| GroupCreateResponse {
        ok: false,
        group_id: None,
        error: Some(parvane_db::public_error(&e)),
    });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_group_add(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupMemberRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.addmember")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = add_group_member(pool, &req.group_id, &actor, &req.member).await?;
        if ok {
            let version = group_mgmt::bump_group_version(pool, &req.group_id).await.unwrap_or(0);
            group_mgmt::notify_group(nc, pool, &req.group_id, "members", version, group_mgmt::GroupRecipients::AllMembers).await;
        }
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("нет прав или группы".into()) },
            error_code: if ok { None } else { Some("forbidden".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(parvane_db::public_error(&e)), error_code: None });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_group_remove(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupMemberRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.removemember")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = remove_group_member(pool, &req.group_id, &actor, &req.member).await?;
        if ok {
            let version = group_mgmt::bump_group_version(pool, &req.group_id).await.unwrap_or(0);
            group_mgmt::notify_group(nc, pool, &req.group_id, "removed", version, group_mgmt::GroupRecipients::Only(req.member.clone())).await;
            group_mgmt::notify_group(nc, pool, &req.group_id, "members", version, group_mgmt::GroupRecipients::AllMembers).await;
        }
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("нет прав или owner".into()) },
            error_code: if ok { None } else { Some("forbidden".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(parvane_db::public_error(&e)), error_code: None });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_group_setrole(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupSetRoleRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.setrole")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = set_group_role(pool, &req.group_id, &actor, &req.member, &req.role).await?;
        if ok {
            let version = group_mgmt::bump_group_version(pool, &req.group_id).await.unwrap_or(0);
            group_mgmt::notify_group(nc, pool, &req.group_id, "admin", version, group_mgmt::GroupRecipients::AllMembers).await;
        }
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("не owner / нельзя".into()) },
            error_code: if ok { None } else { Some("forbidden".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(parvane_db::public_error(&e)), error_code: None });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_group_rename(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupRenameRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.rename")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = rename_group(pool, &req.group_id, &actor, &req.name).await?;
        if ok {
            let version = group_mgmt::bump_group_version(pool, &req.group_id).await.unwrap_or(0);
            group_mgmt::notify_group(nc, pool, &req.group_id, "info", version, group_mgmt::GroupRecipients::AllMembers).await;
        }
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("не owner/admin или пустое имя".into()) },
            error_code: if ok { None } else { Some("forbidden".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(parvane_db::public_error(&e)), error_code: None });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_group_delete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupDeleteRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.delete")?;
        let actor = verify_token(nc, &req.token).await?;
        let recipients = group_mgmt::notice_recipients(pool, &req.group_id, &group_mgmt::GroupRecipients::AllMembers)
            .await
            .unwrap_or_default();
        let version = group_mgmt::current_version(pool, &req.group_id).await.unwrap_or(0);
        let ok = delete_group(pool, &req.group_id, &actor).await?;
        if ok {
            for addr in recipients {
                group_mgmt::notify_group(nc, pool, &req.group_id, "deleted", version + 1, group_mgmt::GroupRecipients::Only(addr)).await;
            }
        }
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("удалить может только владелец".into()) },
            error_code: if ok { None } else { Some("forbidden".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(parvane_db::public_error(&e)), error_code: None });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

/// Бан/разбан. Только owner/admin; owner небаним. Бан не-участника создаёт
/// banned-запись (не вступит по инвайту). Разбан удаляет banned-запись.
pub(crate) async fn ban_group_member(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
    ban: bool,
) -> Result<bool> {
    // MSG-05: бан не-участника заводит строку с произвольной строкой вместо адреса
    if !parvane_types::address::is_valid_address(member) {
        return Ok(false);
    }
    let actor_role = member_role(pool, group_id, actor).await?;
    if !group_mgmt::has_group_right(pool, group_id, actor, group_mgmt::GroupRight::BanUsers, false).await? {
        return Ok(false);
    }
    let target = member_role(pool, group_id, member).await?;
    if matches!(target.as_deref(), Some("owner")) {
        return Ok(false);
    }
    if matches!(target.as_deref(), Some("admin")) && !matches!(actor_role.as_deref(), Some("owner")) {
        return Ok(false);
    }
    if ban {
        group_mgmt::drop_join_request(pool, group_id, member).await?;
        sqlx::query(
            "INSERT INTO group_members (group_id, member, role) VALUES (?, ?, 'banned')
             ON CONFLICT(group_id, member) DO UPDATE SET role = 'banned', muted_until = 0",
        )
        .bind(group_id)
        .bind(member)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            "DELETE FROM group_members WHERE group_id = ? AND member = ? AND role = 'banned'",
        )
        .bind(group_id)
        .bind(member)
        .execute(pool)
        .await?;
    }
    Ok(true)
}

/// Мьют до unix-времени (0 — снять). Только owner/admin; owner немьютим.
pub(crate) async fn mute_group_member(
    pool: &SqlitePool,
    group_id: &str,
    actor: &str,
    member: &str,
    until: i64,
) -> Result<bool> {
    let actor_role = member_role(pool, group_id, actor).await?;
    if !group_mgmt::has_group_right(pool, group_id, actor, group_mgmt::GroupRight::BanUsers, false).await? {
        return Ok(false);
    }
    if matches!(member_role(pool, group_id, member).await?.as_deref(), Some("admin"))
        && !matches!(actor_role.as_deref(), Some("owner"))
    {
        return Ok(false);
    }
    let n = sqlx::query(
        "UPDATE group_members SET muted_until = ?
         WHERE group_id = ? AND member = ? AND role NOT IN ('owner', 'banned')",
    )
    .bind(until)
    .bind(group_id)
    .bind(member)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n > 0)
}

pub(crate) async fn handle_group_ban(nc: &Client, pool: &SqlitePool, msg: async_nats::Message, ban: bool) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupMemberRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.ban")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = ban_group_member(pool, &req.group_id, &actor, &req.member, ban).await?;
        if ok {
            let version = group_mgmt::bump_group_version(pool, &req.group_id).await.unwrap_or(0);
            group_mgmt::notify_group(nc, pool, &req.group_id, "members", version, group_mgmt::GroupRecipients::AllMembers).await;
            if ban {
                group_mgmt::notify_group(nc, pool, &req.group_id, "removed", version, group_mgmt::GroupRecipients::Only(req.member.clone())).await;
            }
        }
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("нет прав / нельзя".into()) },
            error_code: if ok { None } else { Some("forbidden".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(parvane_db::public_error(&e)), error_code: None });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_group_mute(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupMuteRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.mute")?;
        let actor = verify_token(nc, &req.token).await?;
        let ok = mute_group_member(pool, &req.group_id, &actor, &req.member, req.until).await?;
        if ok {
            let version = group_mgmt::bump_group_version(pool, &req.group_id).await.unwrap_or(0);
            group_mgmt::notify_group(nc, pool, &req.group_id, "members", version, group_mgmt::GroupRecipients::AllMembers).await;
        }
        anyhow::Ok(GroupActionResponse {
            ok,
            error: if ok { None } else { Some("нет прав / нельзя".into()) },
            error_code: if ok { None } else { Some("forbidden".into()) },
        })
    }
    .await
    .unwrap_or_else(|e| GroupActionResponse { ok: false, error: Some(parvane_db::public_error(&e)), error_code: None });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_group_list(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupListRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.list")?;
        let user = verify_token(nc, &req.token).await?;
        anyhow::Ok(GroupListResponse { groups: list_groups(pool, &user).await? })
    }
    .await
    .unwrap_or_else(|_| GroupListResponse { groups: vec![] });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

pub(crate) async fn handle_group_info(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = async {
        let req: GroupInfoRequest =
            serde_json::from_slice(&msg.payload).context("JSON group.info")?;
        let user = verify_token(nc, &req.token).await?;
        let groups = match group_info_for_member(pool, &req.group_id, &user).await? {
            Some(info) => vec![info],
            None => vec![],
        };
        anyhow::Ok(GroupListResponse { groups })
    }
    .await
    .unwrap_or_else(|_| GroupListResponse { groups: vec![] });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// ── msg.sync.request ──────────────────────────────────────────────────────────
