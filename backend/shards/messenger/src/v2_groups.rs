//! Группы протокола v2 в messenger (spec 007, T073, T122, T125).
//!
//! Журнал состояния группы проверяется тем же движком, что и у клиентов
//! (`parvane_protocol::group::apply`): подпись записи, позиция в цепочке
//! (D-02), права подписанта по состоянию `version-1`, частота смены эпохи.
//! Подписант определяется по ключу устройства через identity (`key_owner`).
//! Групповое сообщение принимается, если подписано ключом отправки ТЕКУЩЕЙ
//! эпохи (сервер не знает автора), и рассылается всем участникам, включая
//! устройства автора (D-07). Ссылки-приглашения — пары ключей: сервер знает
//! только `link_id` (D-04).

use crate::v2::{device_key, server_domain, V2};
use crate::*;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::group::{self, GroupState, SignerInfo};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, GroupStateEntry, KeyOwnerRequest, KeyOwnerResponse, OpBody, Ref, ShardRequest, UserRef};
use parvane_protocol::pb::parvane::group::v2::{self as gpb, group_change::Change, GroupStateChange};
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, inbox_record, GroupStateNotice};
use parvane_protocol::registry_gen::INTERNAL_KEY_OWNER;
use parvane_protocol::schema::MethodInfo;
use parvane_v2rt::{body, Reply};
use prost::Message as _;
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Кэш состояний групп и владельцев ключей.
#[derive(Default)]
pub(crate) struct GroupCache {
    states: Mutex<HashMap<Vec<u8>, GroupState>>,
    owners: Mutex<HashMap<[u8; 32], (Instant, SignerInfo)>>,
    last_epoch: Mutex<HashMap<Vec<u8>, Instant>>,
}

fn db_err<E: std::fmt::Display>(e: E) -> ErrorCode {
    error!("messenger v2 groups: {}", e);
    ErrorCode::Unavailable
}

fn now_ms() -> i64 {
    now_unix() * 1000
}

async fn key_owner(ctx: &V2, key: &[u8; 32]) -> Result<Option<SignerInfo>, ErrorCode> {
    if let Ok(g) = ctx.groups.owners.lock() {
        if let Some((at, s)) = g.get(key) {
            if at.elapsed() < Duration::from_secs(60) {
                return Ok(Some(s.clone()));
            }
        }
    }
    let req = KeyOwnerRequest { ed25519: key.to_vec() }.encode_to_vec();
    let r = tokio::time::timeout(Duration::from_secs(3), ctx.nc.request(INTERNAL_KEY_OWNER.to_string(), req.into()))
        .await
        .map_err(|_| ErrorCode::Unavailable)?
        .map_err(db_err)?;
    let o = decode_checked::<KeyOwnerResponse>(&r.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)?;
    if !o.found {
        return Ok(None);
    }
    let info = SignerInfo { user: o.user, root_key: o.root_key.as_slice().try_into().unwrap_or([0u8; 32]) };
    if let Ok(mut g) = ctx.groups.owners.lock() {
        g.insert(*key, (Instant::now(), info.clone()));
    }
    Ok(Some(info))
}

fn signer_hint(entry: &GroupStateEntry) -> Result<[u8; 32], ErrorCode> {
    let op = entry.change.as_ref().ok_or(ErrorCode::Invalid)?;
    op.signer_key.as_slice().try_into().map_err(|_| ErrorCode::Invalid)
}

/// Потолок участников группы на сервере (P-34 как в v1; движок держит свой
/// жёсткий потолок `group::MAX_MEMBERS`).
fn max_members() -> usize {
    std::env::var("PARVANE_GROUP_MAX_MEMBERS").ok().and_then(|v| v.parse().ok()).filter(|&n: &usize| n > 0).unwrap_or(200).min(group::MAX_MEMBERS)
}

/// Применить одну запись к состоянию. Подписант — проверенный при приёме
/// (`stored`, C1-04) или, для новой записи, владелец ключа по identity.
async fn apply_one(ctx: &V2, state: Option<&GroupState>, entry: &GroupStateEntry, stored: Option<SignerInfo>) -> Result<(GroupState, SignerInfo), ErrorCode> {
    let hint = signer_hint(entry)?;
    let info = match stored {
        Some(s) => s,
        None => key_owner(ctx, &hint).await?.ok_or(ErrorCode::Forbidden)?,
    };
    let i2 = info.clone();
    let resolve = move |k: &[u8; 32]| (k == &hint).then(|| i2.clone());
    let s = group::apply(state, entry, &resolve).map_err(|e| e.code())?;
    Ok((s, info))
}

/// Состояние группы: кэш или перестройка из журнала.
async fn load(ctx: &V2, group_id: &[u8]) -> Result<Option<GroupState>, ErrorCode> {
    if let Ok(g) = ctx.groups.states.lock() {
        if let Some(s) = g.get(group_id) {
            return Ok(Some(s.clone()));
        }
    }
    let rows: Vec<(i64, Vec<u8>, Option<String>, Option<Vec<u8>>)> =
        sqlx::query_as("SELECT version, entry, signer_user, signer_root FROM group_state_log WHERE group_id = ? ORDER BY version")
            .bind(group_id)
            .fetch_all(&ctx.v2)
            .await
            .map_err(db_err)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut state: Option<GroupState> = None;
    let mut heal = vec![];
    for (version, e, su, sr) in rows {
        let entry = GroupStateEntry::decode(e.as_slice()).map_err(db_err)?;
        // C1-04: подписант — тот, что был проверен при приёме записи (его
        // устройство могло быть позже отозвано, корень — сменён).
        let stored = match (su, sr) {
            (Some(user), Some(root)) => Some(SignerInfo { user, root_key: root.as_slice().try_into().map_err(|_| db_err("signer_root"))? }),
            _ => None,
        };
        let had = stored.is_some();
        match apply_one(ctx, state.as_ref(), &entry, stored).await {
            Ok((s, signer)) => {
                if !had {
                    heal.push((version, signer));
                }
                state = Some(s);
            }
            Err(code) => {
                // Не обслуживать группу по усечённому состоянию (откат бана,
                // вечный DUPLICATE на append) — отказ до разбора оператором.
                error!("группа: журнал не перестраивается на версии {}: {:?}", version, code);
                return Err(ErrorCode::Unavailable);
            }
        }
    }
    // Записи до миграции 0003 — проверенный подписант сохраняется сейчас.
    for (version, signer) in heal {
        if let Err(e) = sqlx::query("UPDATE group_state_log SET signer_user = ?, signer_root = ? WHERE group_id = ? AND version = ?")
            .bind(&signer.user)
            .bind(signer.root_key.to_vec())
            .bind(group_id)
            .bind(version)
            .execute(&ctx.v2)
            .await
        {
            warn!("группа: подписант записи не сохранён: {}", e);
        }
    }
    if let (Some(s), Ok(mut g)) = (state.as_ref(), ctx.groups.states.lock()) {
        g.insert(group_id.to_vec(), s.clone());
    }
    Ok(state)
}

/// Принять запись журнала от участника `actor` (подписант обязан совпасть с сессией).
async fn append(ctx: &V2, actor: &str, entry: GroupStateEntry) -> Result<GroupState, ErrorCode> {
    let g = entry.group.clone().ok_or(ErrorCode::Invalid)?;
    parvane_protocol::address::check_ref(&g).map_err(|_| ErrorCode::Invalid)?;
    if g.domain != server_domain() {
        return Err(ErrorCode::FederationUnavailable);
    }
    let prev = load(ctx, &g.id).await?;
    let (next, signer) = apply_one(ctx, prev.as_ref(), &entry, None).await?;
    if signer.user != actor {
        return Err(ErrorCode::Forbidden);
    }
    // C1-07 (D-17): потолок участников — рассылка множит запись на участников.
    let grew = next.members.len() > prev.as_ref().map(|p| p.members.len()).unwrap_or(0);
    if grew && next.members.len() > max_members() {
        return Err(ErrorCode::Limit);
    }
    // Частота смены эпохи по часам сервера (не только по ts_ms клиента).
    let is_epoch = next.epoch != prev.as_ref().map(|p| p.epoch).unwrap_or(0);
    if is_epoch {
        if let Ok(mut le) = ctx.groups.last_epoch.lock() {
            if le.get(&g.id).is_some_and(|t| t.elapsed() < Duration::from_millis(group::EPOCH_MIN_INTERVAL_MS as u64)) {
                return Err(ErrorCode::RateLimited);
            }
            le.insert(g.id.clone(), Instant::now());
        }
    }
    let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    sqlx::query("INSERT INTO group_state_log (group_id, version, entry, at, signer_user, signer_root) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&g.id)
        .bind(next.version as i64)
        .bind(entry.encode_to_vec())
        .bind(now_unix())
        .bind(&signer.user)
        .bind(signer.root_key.to_vec())
        .execute(&mut *tx)
        .await
        .map_err(|_| ErrorCode::Duplicate)?;
    // C1-14: индекс ссылок-приглашений.
    let before: BTreeSet<[u8; 32]> = prev.as_ref().map(|p| p.invite_links.keys().copied().collect()).unwrap_or_default();
    let after: BTreeSet<[u8; 32]> = next.invite_links.keys().copied().collect();
    for id in after.difference(&before) {
        sqlx::query("INSERT OR REPLACE INTO group_links_v2 (link_id, group_id) VALUES (?, ?)").bind(id.to_vec()).bind(&g.id).execute(&mut *tx).await.map_err(db_err)?;
    }
    for id in before.difference(&after) {
        sqlx::query("DELETE FROM group_links_v2 WHERE link_id = ?").bind(id.to_vec()).execute(&mut *tx).await.map_err(db_err)?;
    }
    sqlx::query("DELETE FROM group_members_v2 WHERE group_id = ?").bind(&g.id).execute(&mut *tx).await.map_err(db_err)?;
    for m in next.members.keys() {
        sqlx::query("INSERT INTO group_members_v2 (group_id, member) VALUES (?, ?)").bind(&g.id).bind(m).execute(&mut *tx).await.map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    if let Ok(mut c) = ctx.groups.states.lock() {
        c.insert(g.id.clone(), next.clone());
    }
    // Уведомление всем участникам (и исключённым этой записью).
    let mut notify: BTreeSet<String> = next.members.keys().cloned().collect();
    if let Some(p) = &prev {
        notify.extend(p.members.keys().cloned());
    }
    let notice = GroupStateNotice { group: Some(g.clone()), version: next.version };
    for u in notify {
        if let Ok(devs) = ctx.devices_of(&u).await {
            for d in &devs.v2_device_ids {
                let _ = ctx.append(&u, d, inbox_record::Item::GroupState(notice.clone())).await;
            }
        }
    }
    Ok(next)
}

/// Заявка на вступление появилась или снята: админам с правом приглашать —
/// уведомление о группе БЕЗ смены версии (клиент перечитывает список заявок;
/// отдельного вида записи в инбоксе для заявок нет).
async fn notify_invite_admins(ctx: &V2, s: &GroupState) {
    let notice = GroupStateNotice { group: Some(s.group.clone()), version: s.version };
    for u in s.members.keys().filter(|u| invite_admin(s, u)) {
        if let Ok(devs) = ctx.devices_of(u).await {
            for d in &devs.v2_device_ids {
                let _ = ctx.append(u, d, inbox_record::Item::GroupState(notice.clone())).await;
            }
        }
    }
}

fn is_member(s: &GroupState, u: &str) -> bool {
    s.members.contains_key(u)
}

fn invite_admin(s: &GroupState, u: &str) -> bool {
    s.owner == u
        || s.members.get(u).is_some_and(|m| m.role == gpb::Role::Admin && m.rights.invite_users)
}

/// Ссылка группы действует: объявлена, не истекла, не исчерпана.
fn invite_link_valid(s: &GroupState, link_id: &[u8]) -> bool {
    let Ok(id) = <[u8; 32]>::try_from(link_id) else { return false };
    s.invite_links.get(&id).is_some_and(|l| {
        (l.announce.expires_ms == 0 || now_ms() <= l.announce.expires_ms)
            && (l.announce.usage_limit == 0 || l.uses < l.announce.usage_limit)
    })
}

fn change_of(entry: &GroupStateEntry) -> Option<Change> {
    let op = entry.change.as_ref()?;
    let b = OpBody::decode(op.body.as_slice()).ok()?;
    GroupStateChange::decode(b.payload.as_slice()).ok()?.change?.change
}

fn invite_info(link_id: &[u8; 32], l: &group::InviteLink) -> gpb::Invite {
    gpb::Invite {
        link_id: link_id.to_vec(),
        creator: Some(UserRef { address: l.creator.clone() }),
        expires_ms: l.announce.expires_ms,
        usage_limit: l.announce.usage_limit,
        usage_count: l.uses,
        requires_approval: l.announce.requires_approval,
        revoked: false,
        title: l.announce.title.clone(),
    }
}

async fn find_link(ctx: &V2, link_id: &[u8]) -> Result<Option<(GroupState, [u8; 32])>, ErrorCode> {
    let id: [u8; 32] = link_id.try_into().map_err(|_| ErrorCode::Invalid)?;
    // C1-14: по индексу, без перебора всех групп.
    let gid: Option<(Vec<u8>,)> = sqlx::query_as("SELECT group_id FROM group_links_v2 WHERE link_id = ?").bind(id.to_vec()).fetch_optional(&ctx.v2).await.map_err(db_err)?;
    let Some((gid,)) = gid else { return Ok(None) };
    Ok(load(ctx, &gid).await?.filter(|s| s.invite_links.contains_key(&id)).map(|s| (s, id)))
}

/// C1-14: индекс ссылок для журналов, принятых до миграции 0003 (один раз
/// при старте, если индекс пуст).
pub(crate) async fn rebuild_link_index(ctx: &V2) {
    let empty: Result<(i64,), _> = sqlx::query_as("SELECT COUNT(*) FROM group_links_v2").fetch_one(&ctx.v2).await;
    if !matches!(empty, Ok((0,))) {
        return;
    }
    let groups: Vec<(Vec<u8>,)> = match sqlx::query_as("SELECT DISTINCT group_id FROM group_state_log").fetch_all(&ctx.v2).await {
        Ok(g) => g,
        Err(e) => {
            error!("группы v2: индекс ссылок: {}", e);
            return;
        }
    };
    let mut n = 0usize;
    for (gid,) in groups {
        let Ok(Some(s)) = load(ctx, &gid).await else { continue };
        for id in s.invite_links.keys() {
            if sqlx::query("INSERT OR REPLACE INTO group_links_v2 (link_id, group_id) VALUES (?, ?)").bind(id.to_vec()).bind(&gid).execute(&ctx.v2).await.is_ok() {
                n += 1;
            }
        }
    }
    if n > 0 {
        info!("группы v2: индекс ссылок перестроен ({})", n);
    }
}

pub(crate) async fn dispatch(ctx: &V2, m: &'static MethodInfo, req: ShardRequest) -> Reply {
    if req.user.is_empty() {
        return Err(ErrorCode::Forbidden);
    }
    let user = req.user.clone();
    match m.name {
        "group.state.append" => {
            let r: gpb::StateAppendRequest = body(&req)?;
            let s = append(ctx, &user, r.entry.ok_or(ErrorCode::Invalid)?).await?;
            Ok(gpb::StateAppendResponse { version: s.version }.encode_to_vec())
        }
        "group.epoch.publish_send_key" => {
            let r: gpb::EpochPublishSendKeyRequest = body(&req)?;
            let e = r.entry.ok_or(ErrorCode::Invalid)?;
            if !matches!(change_of(&e), Some(Change::NewEpoch(_))) {
                return Err(ErrorCode::Invalid);
            }
            let s = append(ctx, &user, e).await?;
            Ok(gpb::EpochPublishSendKeyResponse { epoch: s.epoch }.encode_to_vec())
        }
        "group.state.sync" => {
            let r: gpb::StateSyncRequest = body(&req)?;
            let g: Ref = r.group.ok_or(ErrorCode::Invalid)?;
            let s = load(ctx, &g.id).await?.ok_or(ErrorCode::NotFound)?;
            // Журнал видят участники; бывший участник — до записи своего исключения
            // (клиент должен увидеть, что его исключили).
            let was: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM group_members_v2 WHERE group_id = ? AND member = ?")
                .bind(&g.id)
                .bind(&user)
                .fetch_optional(&ctx.v2)
                .await
                .map_err(db_err)?;
            // Вступающий по ссылке (D-04): журнал нужен до вступления, чтобы
            // подписать JoinByInvite над головой. link_id — только у держателя
            // ссылки; забаненному и по недействительной ссылке — отказ.
            let by_link = !r.invite_link_id.is_empty() && !s.banned.contains(&user) && invite_link_valid(&s, &r.invite_link_id);
            if !is_member(&s, &user) && was.is_none() && !s.banned.contains(&user) && !by_link {
                return Err(ErrorCode::Forbidden);
            }
            let rows: Vec<(Vec<u8>, Option<String>)> =
                sqlx::query_as("SELECT entry, signer_user FROM group_state_log WHERE group_id = ? AND version > ? ORDER BY version LIMIT 1025")
                    .bind(&g.id)
                    .bind(r.after_version as i64)
                    .fetch_all(&ctx.v2)
                    .await
                    .map_err(db_err)?;
            let more = rows.len() > 1024;
            let mut entries = Vec::with_capacity(rows.len().min(1024));
            let mut signer_hints = Vec::with_capacity(rows.len().min(1024));
            for (e, signer) in rows.into_iter().take(1024) {
                if let Ok(entry) = GroupStateEntry::decode(e.as_slice()) {
                    entries.push(entry);
                    // Подсказка, чей журнал устройств добрать (клиент проверяет сам).
                    signer_hints.push(signer.unwrap_or_default());
                }
            }
            Ok(gpb::StateSyncResponse { entries, more, signer_hints }.encode_to_vec())
        }
        "group.invite.create" => {
            let r: gpb::InviteCreateRequest = body(&req)?;
            let e = r.entry.ok_or(ErrorCode::Invalid)?;
            let Some(Change::InviteKey(a)) = change_of(&e) else { return Err(ErrorCode::Invalid) };
            let s = append(ctx, &user, e).await?;
            let id = group::link_id(&a.link_public_key);
            let l = s.invite_links.get(&id).ok_or(ErrorCode::Unavailable)?;
            Ok(gpb::InviteCreateResponse { invite: Some(invite_info(&id, l)) }.encode_to_vec())
        }
        "group.invite.revoke" => {
            let r: gpb::InviteRevokeRequest = body(&req)?;
            let e = r.entry.ok_or(ErrorCode::Invalid)?;
            if !matches!(change_of(&e), Some(Change::InviteKeyRevoke(_))) {
                return Err(ErrorCode::Invalid);
            }
            append(ctx, &user, e).await?;
            Ok(gpb::InviteRevokeResponse {}.encode_to_vec())
        }
        "group.invite.delete" => {
            // Отозванная ссылка уже удалена из состояния записью отзыва.
            let r: gpb::InviteDeleteRequest = body(&req)?;
            let g = r.group.ok_or(ErrorCode::Invalid)?;
            let s = load(ctx, &g.id).await?.ok_or(ErrorCode::NotFound)?;
            if !invite_admin(&s, &user) {
                return Err(ErrorCode::Forbidden);
            }
            Ok(gpb::InviteDeleteResponse {}.encode_to_vec())
        }
        "group.invite.list" => {
            let r: gpb::InviteListRequest = body(&req)?;
            let g = r.group.ok_or(ErrorCode::Invalid)?;
            let s = load(ctx, &g.id).await?.ok_or(ErrorCode::NotFound)?;
            if !is_member(&s, &user) {
                return Err(ErrorCode::Forbidden);
            }
            let admin = invite_admin(&s, &user);
            let invites = s
                .invite_links
                .iter()
                .filter(|(_, l)| admin || l.creator == user)
                .take(500)
                .map(|(id, l)| invite_info(id, l))
                .collect();
            Ok(gpb::InviteListResponse { invites }.encode_to_vec())
        }
        "group.invite.check" => {
            let r: gpb::InviteCheckRequest = body(&req)?;
            let (s, id) = find_link(ctx, &r.link_id).await?.ok_or(ErrorCode::NotFound)?;
            let l = s.invite_links.get(&id).ok_or(ErrorCode::NotFound)?;
            if l.announce.expires_ms > 0 && now_ms() > l.announce.expires_ms {
                return Err(ErrorCode::Expired);
            }
            if s.banned.contains(&user) {
                return Err(ErrorCode::Banned);
            }
            Ok(gpb::InviteCheckResponse {
                group: Some(s.group.clone()),
                name: s.name.clone(),
                members: s.members.len() as u32,
                requires_approval: l.announce.requires_approval,
                kind: s.kind as i32,
            }
            .encode_to_vec())
        }
        "group.join" => {
            let r: gpb::JoinRequest = body(&req)?;
            let e = r.entry.ok_or(ErrorCode::Invalid)?;
            let Some(Change::JoinByInvite(j)) = change_of(&e) else { return Err(ErrorCode::Invalid) };
            let g = e.group.clone().ok_or(ErrorCode::Invalid)?;
            let s = load(ctx, &g.id).await?.ok_or(ErrorCode::NotFound)?;
            let id = group::link_id(&j.link_public_key);
            let l = s.invite_links.get(&id).ok_or(ErrorCode::NotFound)?;
            if s.banned.contains(&user) {
                return Err(ErrorCode::Banned);
            }
            if l.announce.requires_approval {
                // Заявка: админ одобрит записью AddMember. Секрет ссылки
                // подтверждается подписью вступления (сервер без секрета её не сделает).
                let parts = group::join_signing_parts(&s.group, s.version + 1, &s.head_hash(), &j.joiner_root_key);
                parvane_protocol::sign::verify_ctx(&j.link_public_key, &j.link_signature, parvane_protocol::sign::ctx::GROUP_JOIN, &[&parts])
                    .map_err(|_| ErrorCode::Forbidden)?;
                sqlx::query("INSERT OR REPLACE INTO group_join_requests_v2 (group_id, user, link_id, requested_at) VALUES (?, ?, ?, ?)")
                    .bind(&g.id)
                    .bind(&user)
                    .bind(id.to_vec())
                    .bind(now_unix())
                    .execute(&ctx.v2)
                    .await
                    .map_err(db_err)?;
                notify_invite_admins(ctx, &s).await;
                return Ok(gpb::JoinResponse { pending: true, version: s.version }.encode_to_vec());
            }
            let s2 = append(ctx, &user, e).await?;
            Ok(gpb::JoinResponse { pending: false, version: s2.version }.encode_to_vec())
        }
        "group.request.list" => {
            let r: gpb::RequestListRequest = body(&req)?;
            let g = r.group.ok_or(ErrorCode::Invalid)?;
            let s = load(ctx, &g.id).await?.ok_or(ErrorCode::NotFound)?;
            if !invite_admin(&s, &user) {
                return Err(ErrorCode::Forbidden);
            }
            let rows: Vec<(String, i64)> = sqlx::query_as("SELECT user, requested_at FROM group_join_requests_v2 WHERE group_id = ? ORDER BY requested_at LIMIT 500")
                .bind(&g.id)
                .fetch_all(&ctx.v2)
                .await
                .map_err(db_err)?;
            let requests = rows.into_iter().map(|(u, at)| gpb::JoinRequestInfo { user: Some(UserRef { address: u }), requested_ms: at * 1000 }).collect();
            Ok(gpb::RequestListResponse { requests }.encode_to_vec())
        }
        "group.request.decide" => {
            let r: gpb::RequestDecideRequest = body(&req)?;
            let g = r.group.ok_or(ErrorCode::Invalid)?;
            let who = r.user.map(|u| u.address).ok_or(ErrorCode::Invalid)?;
            let s = load(ctx, &g.id).await?.ok_or(ErrorCode::NotFound)?;
            if !invite_admin(&s, &user) {
                return Err(ErrorCode::Forbidden);
            }
            if r.approve {
                let e = r.entry.ok_or(ErrorCode::Invalid)?;
                match change_of(&e) {
                    Some(Change::AddMember(a)) if a.member.as_ref().map(|m| m.address.as_str()) == Some(who.as_str()) => {}
                    _ => return Err(ErrorCode::Invalid),
                }
                append(ctx, &user, e).await?;
            }
            sqlx::query("DELETE FROM group_join_requests_v2 WHERE group_id = ? AND user = ?").bind(&g.id).bind(&who).execute(&ctx.v2).await.map_err(db_err)?;
            if !r.approve {
                // Одобрение уведомляет всех записью журнала; отказ — только админов
                notify_invite_admins(ctx, &s).await;
            }
            Ok(gpb::RequestDecideResponse {}.encode_to_vec())
        }
        _ => Err(ErrorCode::Unavailable),
    }
}

/// Групповое сообщение (анонимный канал): подпись ключом текущей эпохи,
/// одноразовый nonce, рассылка всем участникам (включая автора).
pub(crate) async fn deliver_group(ctx: &V2, r: mpb::DeliverGroupRequest) -> Reply {
    let env = r.envelope.ok_or(ErrorCode::Invalid)?;
    let g = env.group.clone().ok_or(ErrorCode::Invalid)?;
    parvane_protocol::address::check_ref(&g).map_err(|_| ErrorCode::Invalid)?;
    let s = load(ctx, &g.id).await?.ok_or(ErrorCode::NotFound)?;
    if s.deleted {
        return Err(ErrorCode::NotFound);
    }
    // SC-003a: после бана/мьюта/исключения старый ключ отправки не принимается
    // до публикации новой эпохи — иначе окно, в котором исключённый ещё пишет.
    if s.epoch_stale {
        return Err(ErrorCode::Expired);
    }
    let pk = s.send_public_key.ok_or(ErrorCode::Forbidden)?;
    group::verify_envelope(&env, s.epoch, &pk).map_err(|e| match e {
        parvane_protocol::ProtoError::Expired => ErrorCode::Expired,
        _ => ErrorCode::Forbidden,
    })?;
    sqlx::query("INSERT INTO group_envelope_nonce (group_id, epoch, nonce, at) VALUES (?, ?, ?, ?)")
        .bind(&g.id)
        .bind(env.epoch as i64)
        .bind(&env.envelope_nonce)
        .bind(now_unix())
        .execute(&ctx.v2)
        .await
        .map_err(|_| ErrorCode::Duplicate)?;
    for u in s.members.keys() {
        let Ok(devs) = ctx.devices_of(u).await else { continue };
        for d in &devs.v2_device_ids {
            if device_key(u, d).is_ok() {
                let _ = ctx.append(u, d, inbox_record::Item::Group(env.clone())).await;
            }
        }
    }
    Ok(mpb::DeliverGroupResponse {}.encode_to_vec())
}

/// `v2.internal.messenger.group_epoch` (T122, D-07): текущая эпоха группы и
/// её публичный ключ отправки — для проверки анонимного «печатает» в gateway.
/// Внутренний subject (ACL: подписан только messenger, публикует только
/// gateway); ответ не содержит состава группы и авторов.
pub(crate) async fn serve_group_epoch(ctx: std::sync::Arc<V2>) {
    use futures::StreamExt as _;
    use parvane_protocol::registry_gen::INTERNAL_GROUP_EPOCH;
    let mut sub = match ctx.nc.subscribe(INTERNAL_GROUP_EPOCH.to_string()).await {
        Ok(s) => s,
        Err(e) => {
            error!("messenger v2: подписка {} не удалась: {}", INTERNAL_GROUP_EPOCH, e);
            return;
        }
    };
    while let Some(msg) = sub.next().await {
        let Some(reply) = msg.reply.clone() else { continue };
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let info = match decode_checked::<mpb::GroupEpochQuery>(&msg.payload, Origin::Server) {
                Ok(q) => match q.group {
                    Some(g) if parvane_protocol::address::check_ref(&g).is_ok() => match load(&ctx, &g.id).await {
                        Ok(Some(s)) => mpb::GroupEpochInfo {
                            found: true,
                            epoch: s.epoch,
                            send_public_key: s.send_public_key.map(|k| k.to_vec()).unwrap_or_default(),
                            stale: s.epoch_stale,
                            deleted: s.deleted,
                        },
                        _ => mpb::GroupEpochInfo::default(),
                    },
                    _ => mpb::GroupEpochInfo::default(),
                },
                Err(_) => mpb::GroupEpochInfo::default(),
            };
            if let Err(e) = ctx.nc.publish(reply, info.encode_to_vec().into()).await {
                warn!("messenger v2: ответ group_epoch не отправлен: {}", e);
            }
        });
    }
}
