//! Публичные группы v2 (spec 023): каталог, имена, история.
//!
//! Публичность — запись журнала `SetPublic` (имя, открытый секрет `S`, настройки админа); сервер воспроизводит
//! журнал тем же движком и держит каталог `public_groups` по состоянию. Имя занимается в identity
//! (`v2.internal.identity.name_claim`) — общее пространство с никами пользователей. Конверты публичной группы
//! хранятся (`public_group_messages`, до `MAX_KEPT` на группу и `KEEP_DAYS` дней) и отдаются `group.public.history`:
//! участнику — после вступления (с настройкой «История» — и прежние), постороннему — последние `PREVIEW_LIMIT`
//! при настройке «Читать без вступления». Секрет открыт, поэтому это граница сервиса, а не криптографии.

use crate::v2::V2;
use crate::*;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::group::{self, GroupState};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, GroupEnvelope, NameClaimRequest, NameClaimResponse, Ref, ShardRequest};
use parvane_protocol::pb::parvane::group::v2 as gpb;
use parvane_protocol::registry_gen::INTERNAL_NAME_CLAIM;
use parvane_v2rt::{body, Reply};
use prost::Message as _;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_KEPT: i64 = 5000;
const KEEP_DAYS: i64 = 90;
const PREVIEW_LIMIT: u32 = 50;
const HISTORY_LIMIT: u32 = 100;
const SEARCH_LIMIT: u32 = 20;
const SEARCH_MIN: usize = 2;
/// Запросов в минуту на пользователя: поиск / открытие имени / проверка имени.
const SEARCH_PER_MIN: u32 = 30;
const RESOLVE_PER_MIN: u32 = 60;

static RATES: Mutex<Option<HashMap<(String, &'static str), (Instant, u32)>>> = Mutex::new(None);

fn rate_ok(user: &str, what: &'static str, per_min: u32) -> bool {
    let Ok(mut guard) = RATES.lock() else { return true };
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() > 50_000 {
        map.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
    }
    let slot = map.entry((user.to_string(), what)).or_insert((Instant::now(), 0));
    if slot.0.elapsed() >= Duration::from_secs(60) {
        *slot = (Instant::now(), 0);
    }
    slot.1 += 1;
    slot.1 <= per_min
}

fn db_err<E: std::fmt::Display>(e: E) -> ErrorCode {
    error!("публичные группы: {}", e);
    ErrorCode::Unavailable
}

fn norm(text: &str) -> String {
    text.to_lowercase().replace('ё', "е")
}

/// Ссылка публичной группы: `link_id` ключа, выведенного из секрета.
pub(crate) fn public_link_id(s: &GroupState) -> Option<[u8; 32]> {
    s.public.as_ref().map(|p| group::link_id(&p.link_public_key))
}

async fn claim(ctx: &V2, name: &str, owner: &[u8], release: bool) -> Result<NameClaimResponse, ErrorCode> {
    let req = NameClaimRequest { name: name.to_string(), owner: owner.to_vec(), release }.encode_to_vec();
    let r = tokio::time::timeout(Duration::from_secs(3), ctx.nc.request(INTERNAL_NAME_CLAIM.to_string(), req.into()))
        .await
        .map_err(|_| ErrorCode::Unavailable)?
        .map_err(db_err)?;
    decode_checked::<NameClaimResponse>(&r.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)
}

/// До записи журнала: публичное имя меняется — занять новое (отказ — запись не принимается).
pub(crate) async fn before_append(ctx: &V2, prev: Option<&GroupState>, next: &GroupState) -> Result<(), ErrorCode> {
    let old = prev.and_then(|p| p.public.as_ref()).map(|p| p.name.as_str());
    let Some(p) = next.public.as_ref().filter(|_| !next.deleted) else { return Ok(()) };
    if old == Some(p.name.as_str()) {
        return Ok(());
    }
    let r = claim(ctx, &p.name, &next.group.id, false).await?;
    if r.ok {
        Ok(())
    } else if r.reason == "taken" {
        Err(ErrorCode::Duplicate)
    } else {
        Err(ErrorCode::Invalid)
    }
}

/// После записи журнала: каталог по состоянию; группа стала частной либо удалена — имя освобождается.
pub(crate) async fn after_append(ctx: &V2, prev: Option<&GroupState>, next: &GroupState, actor: &str) {
    let was_public = prev.is_some_and(|p| p.public.is_some());
    let result = match next.public.as_ref().filter(|_| !next.deleted) {
        Some(p) => {
            let joined = prev.is_some_and(|p| !p.members.contains_key(actor)) && next.members.contains_key(actor);
            upsert(ctx, next, p, if joined { Some(actor) } else { None }).await
        }
        None if was_public => {
            let _ = claim(ctx, "", &next.group.id, true).await;
            sqlx::query("DELETE FROM public_groups WHERE group_id = ?").bind(&next.group.id).execute(&ctx.v2).await.map(|_| ())
        }
        None => Ok(()),
    };
    if let Err(e) = result {
        error!("публичные группы: каталог не обновлён: {}", e);
    }
}

async fn upsert(ctx: &V2, s: &GroupState, p: &group::PublicInfo, joined: Option<&str>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO public_groups (group_id, name, kind, title, title_norm, about, avatar_file_id, members, preview, history, secret, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, title = excluded.title,
           title_norm = excluded.title_norm, about = excluded.about, avatar_file_id = excluded.avatar_file_id,
           members = excluded.members, preview = excluded.preview, history = excluded.history, secret = excluded.secret,
           updated_at = excluded.updated_at",
    )
    .bind(&s.group.id)
    .bind(&p.name)
    .bind(s.kind as i64)
    .bind(&s.name)
    .bind(norm(&s.name))
    .bind(&s.about)
    .bind(&s.avatar_file_id)
    .bind(s.members.len() as i64)
    .bind(p.preview as i64)
    .bind(p.history as i64)
    .bind(p.secret.to_vec())
    .bind(now_unix())
    .execute(&ctx.v2)
    .await?;
    if let Some(user) = joined {
        let last: (Option<i64>,) = sqlx::query_as("SELECT MAX(seq) FROM public_group_messages WHERE group_id = ?").bind(&s.group.id).fetch_one(&ctx.v2).await?;
        sqlx::query("INSERT OR REPLACE INTO public_join_points (group_id, user, seq) VALUES (?, ?, ?)")
            .bind(&s.group.id)
            .bind(user)
            .bind(last.0.unwrap_or(0))
            .execute(&ctx.v2)
            .await?;
    }
    Ok(())
}

/// Принятый конверт публичной группы — в историю (обрезка по числу и сроку).
pub(crate) async fn keep_envelope(ctx: &V2, s: &GroupState, env: &GroupEnvelope) {
    if s.public.is_none() {
        return;
    }
    let result: Result<(), sqlx::Error> = async {
        sqlx::query("INSERT INTO public_group_messages (group_id, envelope, at) VALUES (?, ?, ?)")
            .bind(&s.group.id)
            .bind(env.encode_to_vec())
            .bind(now_unix())
            .execute(&ctx.v2)
            .await?;
        sqlx::query(
            "DELETE FROM public_group_messages WHERE group_id = ? AND (at < ? OR seq <= (SELECT seq FROM public_group_messages
               WHERE group_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?))",
        )
        .bind(&s.group.id)
        .bind(now_unix() - KEEP_DAYS * 86_400)
        .bind(&s.group.id)
        .bind(MAX_KEPT)
        .execute(&ctx.v2)
        .await?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("публичные группы: конверт не сохранён: {}", e);
    }
}

type CardRow = (Vec<u8>, String, i64, String, String, String, i64, i64, i64);

const CARD_COLUMNS: &str = "group_id, name, kind, title, about, avatar_file_id, members, preview, history";

fn card(row: CardRow) -> gpb::PublicGroupCard {
    let (group_id, name, kind, title, about, avatar_file_id, members, preview, history) = row;
    gpb::PublicGroupCard {
        name,
        kind: kind as i32,
        title,
        about,
        avatar_file_id,
        members: members as u32,
        preview: preview != 0,
        history: history != 0,
        group: Some(Ref { domain: crate::v2::server_domain(), id: group_id }),
    }
}

pub(crate) async fn dispatch(ctx: &V2, name: &str, req: ShardRequest) -> Reply {
    let user = req.user.clone();
    match name {
        "group.public.check_name" => {
            let r: gpb::PublicCheckNameRequest = body(&req)?;
            if !rate_ok(&user, "check", RESOLVE_PER_MIN) {
                return Err(ErrorCode::RateLimited);
            }
            let Some(n) = group::normalize_public_name(&r.name) else {
                return Ok(gpb::PublicCheckNameResponse { available: false, reason: "format".into() }.encode_to_vec());
            };
            // Проверка без занятия: владелец пуст
            let c = claim(ctx, &n, &[], false).await?;
            Ok(gpb::PublicCheckNameResponse { available: c.ok, reason: c.reason }.encode_to_vec())
        }
        "group.public.search" => {
            let r: gpb::PublicSearchRequest = body(&req)?;
            if !rate_ok(&user, "search", SEARCH_PER_MIN) {
                return Err(ErrorCode::RateLimited);
            }
            let q = norm(r.query.trim().trim_start_matches('@'));
            if q.chars().count() < SEARCH_MIN {
                return Ok(gpb::PublicSearchResponse::default().encode_to_vec());
            }
            let like = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            let limit = r.limit.clamp(1, SEARCH_LIMIT) as i64;
            let rows: Vec<CardRow> = sqlx::query_as(&format!(
                "SELECT {CARD_COLUMNS} FROM public_groups WHERE name LIKE ? ESCAPE '\\' OR title_norm LIKE ? ESCAPE '\\'
                 ORDER BY (name LIKE ? ESCAPE '\\') DESC, members DESC LIMIT ?"
            ))
            .bind(format!("{like}%"))
            .bind(format!("%{like}%"))
            .bind(format!("{like}%"))
            .bind(limit)
            .fetch_all(&ctx.v2)
            .await
            .map_err(db_err)?;
            Ok(gpb::PublicSearchResponse { groups: rows.into_iter().map(card).collect() }.encode_to_vec())
        }
        "group.public.resolve" => {
            let r: gpb::PublicResolveRequest = body(&req)?;
            if !rate_ok(&user, "resolve", RESOLVE_PER_MIN) {
                return Err(ErrorCode::RateLimited);
            }
            let n = group::normalize_public_name(&r.name).ok_or(ErrorCode::NotFound)?;
            let row: Option<(Vec<u8>, String, i64, String, String, String, i64, i64, i64, Vec<u8>)> =
                sqlx::query_as(&format!("SELECT {CARD_COLUMNS}, secret FROM public_groups WHERE name = ?"))
                    .bind(&n)
                    .fetch_optional(&ctx.v2)
                    .await
                    .map_err(db_err)?;
            let (g, nm, k, t, a, av, m, p, h, secret) = row.ok_or(ErrorCode::NotFound)?;
            Ok(gpb::PublicResolveResponse { card: Some(card((g, nm, k, t, a, av, m, p, h))), secret }.encode_to_vec())
        }
        "group.public.history" => {
            let r: gpb::PublicHistoryRequest = body(&req)?;
            let g = r.group.ok_or(ErrorCode::Invalid)?;
            let s = crate::v2_groups::load_public(ctx, &g.id).await?;
            let p = s.public.as_ref().ok_or(ErrorCode::NotFound)?;
            if s.banned.contains(&user) {
                return Err(ErrorCode::Banned);
            }
            let is_member = s.members.contains_key(&user);
            let (floor, limit) = if is_member {
                let from = if p.history {
                    0
                } else {
                    let row: Option<(i64,)> = sqlx::query_as("SELECT seq FROM public_join_points WHERE group_id = ? AND user = ?")
                        .bind(&g.id)
                        .bind(&user)
                        .fetch_optional(&ctx.v2)
                        .await
                        .map_err(db_err)?;
                    row.map(|(seq,)| seq).unwrap_or(0)
                };
                (from, r.limit.clamp(1, HISTORY_LIMIT))
            } else if p.preview {
                (0, r.limit.clamp(1, PREVIEW_LIMIT))
            } else {
                return Err(ErrorCode::Forbidden);
            };
            let before = if r.before_seq == 0 { i64::MAX } else { r.before_seq as i64 };
            let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
                "SELECT seq, envelope FROM public_group_messages WHERE group_id = ? AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT ?",
            )
            .bind(&g.id)
            .bind(floor)
            .bind(before)
            .bind(limit as i64 + 1)
            .fetch_all(&ctx.v2)
            .await
            .map_err(db_err)?;
            // Постороннему — только последние сообщения: дальше превью не листается
            let more = is_member && rows.len() > limit as usize;
            let items = rows
                .into_iter()
                .take(limit as usize)
                .filter_map(|(seq, e)| GroupEnvelope::decode(e.as_slice()).ok().map(|env| gpb::PublicHistoryItem { seq: seq as u64, envelope: Some(env) }))
                .collect();
            Ok(gpb::PublicHistoryResponse { items, more }.encode_to_vec())
        }
        _ => Err(ErrorCode::Unavailable),
    }
}
