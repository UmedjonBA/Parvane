//! Общие плейлисты «Музыки» (spec 041, MUSIC-3): методы `music.shared.*`. Плейлист хранится в базе шарда открытым
//! текстом — музыка не E2E (сервер и так видит треки и прослушивания). Права проверяет сервер:
//! - владелец (OWNER) — название, доступ, участники, ключ вступления, удаление; правит треки;
//! - «добавляет» (EDITOR) — добавляет, убирает, переставляет треки; может выйти;
//! - «слушает» (LISTENER) — только читает; может выйти;
//! - не участник читает плейлист «все на сервере» (SERVER), а плейлист чата — вступив ключом `join_key` из карточки
//!   (становится EDITOR). Позванный (`invited`) видит плейлист в списке; первое чтение снимает отметку.
//! Личные плейлисты — контейнер `music.v1` на устройствах (MUSIC-2); «сделать общим / личным» — переносом треков
//! клиентом (создать общий с треками и удалить личный, либо наоборот).

use std::sync::OnceLock;

use parvane_protocol::pb::parvane::core::v2::{ErrorCode, ShardRequest};
use parvane_v2rt::body;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message;
use sqlx::{Sqlite, SqlitePool, Transaction};
use tracing::{error, warn};

use crate::now_ms;

type Reply = Result<Vec<u8>, ErrorCode>;

/// Общих плейлистов у одного владельца.
const OWNED_MAX: i64 = 200;
const ITEMS_MAX: i64 = 2000;
const MEMBERS_MAX: i64 = 500;
const NAME_MAX: usize = 240;
const LIST_MAX: i64 = 500;
/// Места ближе этого — перенумеровать по порядку.
const RANK_EPS: f64 = 1e-6;

static POOL: OnceLock<SqlitePool> = OnceLock::new();

/// База общих плейлистов — та же, что у учёта добавленного (`fetch::store::open` применяет миграции).
pub(crate) async fn open(db_path: &str) {
    match crate::fetch::store::open(db_path).await {
        Ok(pool) => {
            let _ = POOL.set(pool);
        }
        Err(e) => warn!("музыка: база общих плейлистов не открыта — общие плейлисты недоступны: {e:#}"),
    }
}

fn db_err(e: sqlx::Error) -> ErrorCode {
    error!("музыка: общие плейлисты: {e}");
    ErrorCode::Unavailable
}

fn role_of(n: i64) -> pb::SharedRole {
    match n {
        1 => pb::SharedRole::Owner,
        2 => pb::SharedRole::Editor,
        3 => pb::SharedRole::Listener,
        _ => pb::SharedRole::Unspecified,
    }
}

fn access_of(n: i64) -> pb::SharedAccess {
    if n == 2 { pb::SharedAccess::Server } else { pb::SharedAccess::Members }
}

fn new_key(bytes: usize) -> String {
    let mut k = vec![0u8; bytes];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut k);
    k.iter().map(|b| format!("{b:02x}")).collect()
}

fn clean_name(name: &str) -> Result<String, ErrorCode> {
    let t: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if t.is_empty() || t.len() > NAME_MAX {
        return Err(ErrorCode::Invalid);
    }
    Ok(t)
}

fn domain_of(address: &str) -> &str {
    address.rsplit_once('@').map_or("", |(_, d)| d)
}

/// Адрес пользователя `ник@домен` того же сервера, что и вызывающий.
fn valid_member(address: &str, caller: &str) -> bool {
    let Some((nick, domain)) = address.split_once('@') else { return false };
    let nick_ok = (2..=64).contains(&nick.len()) && nick.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-'));
    nick_ok && !domain.is_empty() && domain == domain_of(caller)
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    owner: String,
    name: String,
    access: i64,
    join_key: String,
    created_ms: i64,
    updated_ms: i64,
    version: i64,
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: String,
    track_id: String,
    server: String,
    title: String,
    artist: String,
    duration_secs: i64,
    adder: String,
    added_ms: i64,
}

async fn playlist_row(db: &mut sqlx::SqliteConnection, id: &str) -> Result<Row, ErrorCode> {
    sqlx::query_as("SELECT id, owner, name, access, join_key, created_ms, updated_ms, version FROM shared_playlists WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(db_err)?
        .ok_or(ErrorCode::NotFound)
}

/// Роль и отметка «позван» вызывающего; не участник — `None`.
async fn member_of(db: &mut sqlx::SqliteConnection, id: &str, address: &str) -> Result<Option<(pb::SharedRole, bool)>, ErrorCode> {
    let r: Option<(i64, i64)> = sqlx::query_as("SELECT role, invited FROM shared_members WHERE playlist_id = ? AND address = ?").bind(id).bind(address).fetch_optional(db).await.map_err(db_err)?;
    Ok(r.map(|(role, invited)| (role_of(role), invited != 0)))
}

/// Сводка плейлиста для вызывающего.
async fn summary(db: &mut sqlx::SqliteConnection, row: &Row, me: Option<(pb::SharedRole, bool)>) -> Result<pb::SharedPlaylist, ErrorCode> {
    let (members,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM shared_members WHERE playlist_id = ?").bind(&row.id).fetch_one(&mut *db).await.map_err(db_err)?;
    let (tracks, secs): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(duration_secs), 0) FROM shared_items WHERE playlist_id = ?").bind(&row.id).fetch_one(&mut *db).await.map_err(db_err)?;
    let (role, invited) = me.unwrap_or((pb::SharedRole::Unspecified, false));
    Ok(pb::SharedPlaylist {
        id: row.id.clone(),
        name: row.name.clone(),
        owner: row.owner.clone(),
        access: access_of(row.access) as i32,
        my_role: role as i32,
        member_count: u32::try_from(members).unwrap_or(0),
        track_count: u32::try_from(tracks).unwrap_or(0),
        duration_secs: u32::try_from(secs).unwrap_or(u32::MAX),
        created_ms: row.created_ms,
        updated_ms: row.updated_ms,
        version: u64::try_from(row.version).unwrap_or(0),
        join_key: if role == pb::SharedRole::Owner { row.join_key.clone() } else { String::new() },
        invited,
    })
}

async fn touch(tx: &mut Transaction<'static, Sqlite>, id: &str) -> Result<(), ErrorCode> {
    sqlx::query("UPDATE shared_playlists SET version = version + 1, updated_ms = ? WHERE id = ?").bind(now_ms()).bind(id).execute(&mut **tx).await.map_err(db_err)?;
    Ok(())
}

/// Сводка после правки — в той же транзакции.
async fn reply_summary(tx: &mut Transaction<'static, Sqlite>, id: &str, address: &str) -> Result<pb::SharedPlaylist, ErrorCode> {
    let row = playlist_row(&mut **tx, id).await?;
    let me = member_of(&mut **tx, id, address).await?;
    summary(&mut **tx, &row, me).await
}

fn need(me: Option<(pb::SharedRole, bool)>, allowed: &[pb::SharedRole]) -> Result<pb::SharedRole, ErrorCode> {
    match me {
        Some((r, _)) if allowed.contains(&r) => Ok(r),
        _ => Err(ErrorCode::Forbidden),
    }
}

pub(crate) async fn dispatch(method: &str, req: &ShardRequest) -> Reply {
    let pool = POOL.get().ok_or(ErrorCode::Unavailable)?;
    let address = req.user.as_str();
    match method {
        "music.shared.list" => list(pool, address, body(req)?).await,
        "music.shared.get" => get(pool, address, body(req)?).await,
        "music.shared.create" => create(pool, address, body(req)?).await,
        "music.shared.edit" => edit(pool, address, body(req)?).await,
        "music.shared.delete" => delete(pool, address, body(req)?).await,
        "music.shared.items" => items(pool, address, body(req)?).await,
        "music.shared.member" => member(pool, address, body(req)?).await,
        "music.shared.leave" => leave(pool, address, body(req)?).await,
        "music.shared.join" => join(pool, address, body(req)?).await,
        _ => Err(ErrorCode::Unavailable),
    }
}

async fn list(pool: &SqlitePool, address: &str, r: pb::SharedListRequest) -> Reply {
    let mut db = pool.acquire().await.map_err(db_err)?;
    let base = "SELECT p.id, p.owner, p.name, p.access, p.join_key, p.created_ms, p.updated_ms, p.version FROM shared_playlists p";
    let mut rows: Vec<Row> = sqlx::query_as(&format!("{base} JOIN shared_members m ON m.playlist_id = p.id WHERE m.address = ? ORDER BY p.updated_ms DESC LIMIT ?"))
        .bind(address)
        .bind(LIST_MAX)
        .fetch_all(&mut *db)
        .await
        .map_err(db_err)?;
    if r.server_wide {
        let open: Vec<Row> = sqlx::query_as(&format!(
            "{base} WHERE p.access = 2 AND NOT EXISTS (SELECT 1 FROM shared_members m WHERE m.playlist_id = p.id AND m.address = ?) ORDER BY p.updated_ms DESC LIMIT ?"
        ))
        .bind(address)
        .bind(LIST_MAX)
        .fetch_all(&mut *db)
        .await
        .map_err(db_err)?;
        rows.extend(open);
    }
    let mut playlists = Vec::with_capacity(rows.len());
    for row in rows.iter().take(LIST_MAX as usize) {
        let me = member_of(&mut db, &row.id, address).await?;
        playlists.push(summary(&mut db, row, me).await?);
    }
    Ok(pb::SharedListResponse { playlists }.encode_to_vec())
}

async fn get(pool: &SqlitePool, address: &str, r: pb::SharedGetRequest) -> Reply {
    let mut tx = parvane_db::begin_write(pool).await.map_err(db_err)?;
    let row = playlist_row(&mut tx, &r.playlist_id).await?;
    let mut me = member_of(&mut tx, &row.id, address).await?;
    if me.is_none() && access_of(row.access) != pb::SharedAccess::Server {
        // Не участнику частный плейлист неотличим от несуществующего
        return Err(ErrorCode::NotFound);
    }
    // Позванный открыл плейлист — «приглашён, ещё не открыл» снимается
    if let Some((role, true)) = me {
        sqlx::query("UPDATE shared_members SET invited = 0, joined_ms = ? WHERE playlist_id = ? AND address = ?").bind(now_ms()).bind(&row.id).bind(address).execute(&mut *tx).await.map_err(db_err)?;
        touch(&mut tx, &row.id).await?;
        me = Some((role, false));
    }
    let row = playlist_row(&mut tx, &row.id).await?;
    let playlist = summary(&mut tx, &row, me).await?;
    if r.if_version != 0 && r.if_version == playlist.version {
        tx.commit().await.map_err(db_err)?;
        return Ok(pb::SharedGetResponse { unchanged: true, ..Default::default() }.encode_to_vec());
    }
    let items: Vec<ItemRow> =
        sqlx::query_as("SELECT id, track_id, server, title, artist, duration_secs, adder, added_ms FROM shared_items WHERE playlist_id = ? ORDER BY rank, id LIMIT ?")
            .bind(&row.id)
            .bind(ITEMS_MAX)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_err)?;
    let members: Vec<(String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT m.address, m.role, m.invited, m.joined_ms, (SELECT COUNT(*) FROM shared_items i WHERE i.playlist_id = m.playlist_id AND i.adder = m.address)
         FROM shared_members m WHERE m.playlist_id = ? ORDER BY m.role = 1 DESC, m.joined_ms, m.address LIMIT ?",
    )
    .bind(&row.id)
    .bind(MEMBERS_MAX)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::SharedGetResponse {
        playlist: Some(playlist),
        items: items
            .into_iter()
            .map(|i| pb::SharedItem {
                id: i.id,
                track_id: i.track_id,
                server: i.server,
                title: i.title,
                artist: i.artist,
                duration_secs: u32::try_from(i.duration_secs).unwrap_or(0),
                adder: i.adder,
                added_ms: i.added_ms,
            })
            .collect(),
        members: members
            .into_iter()
            .map(|(address, role, invited, joined_ms, added)| pb::SharedMember { address, role: role_of(role) as i32, invited: invited != 0, added_count: u32::try_from(added).unwrap_or(0), joined_ms })
            .collect(),
        unchanged: false,
    }
    .encode_to_vec())
}

fn valid_add(a: &pb::SharedItemAdd) -> bool {
    !a.track_id.is_empty() && crate::subsonic::valid_id(&a.track_id, 128)
}

/// Добавить треки в конец (повтор пропускается). Возвращает число пропущенных.
async fn add_items(tx: &mut Transaction<'static, Sqlite>, id: &str, adder: &str, add: &[pb::SharedItemAdd]) -> Result<u32, ErrorCode> {
    if add.iter().any(|a| !valid_add(a)) {
        return Err(ErrorCode::Invalid);
    }
    let (count, last): (i64, f64) = sqlx::query_as("SELECT COUNT(*), COALESCE(MAX(rank), 0.0) FROM shared_items WHERE playlist_id = ?").bind(id).fetch_one(&mut **tx).await.map_err(db_err)?;
    let mut rank = last;
    let mut added = 0i64;
    let mut skipped = 0u32;
    let now = now_ms();
    for a in add {
        let (dupe,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM shared_items WHERE playlist_id = ? AND track_id = ? AND server = ?")
            .bind(id)
            .bind(&a.track_id)
            .bind(&a.server)
            .fetch_one(&mut **tx)
            .await
            .map_err(db_err)?;
        if dupe > 0 {
            skipped += 1;
            continue;
        }
        if count + added >= ITEMS_MAX {
            return Err(ErrorCode::Limit);
        }
        rank += 1.0;
        sqlx::query("INSERT INTO shared_items (playlist_id, id, track_id, server, rank, title, artist, duration_secs, adder, added_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(id)
            .bind(new_key(8))
            .bind(&a.track_id)
            .bind(&a.server)
            .bind(rank)
            .bind(&a.title)
            .bind(&a.artist)
            .bind(i64::from(a.duration_secs))
            .bind(adder)
            .bind(now)
            .execute(&mut **tx)
            .await
            .map_err(db_err)?;
        added += 1;
    }
    Ok(skipped)
}

async fn create(pool: &SqlitePool, address: &str, r: pb::SharedCreateRequest) -> Reply {
    let name = clean_name(&r.name)?;
    let access = match pb::SharedAccess::try_from(r.access) {
        Ok(pb::SharedAccess::Server) => 2,
        Ok(pb::SharedAccess::Members | pb::SharedAccess::Unspecified) => 1,
        Err(_) => return Err(ErrorCode::Invalid),
    };
    let mut tx = parvane_db::begin_write(pool).await.map_err(db_err)?;
    let (owned,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM shared_playlists WHERE owner = ?").bind(address).fetch_one(&mut *tx).await.map_err(db_err)?;
    if owned >= OWNED_MAX {
        return Err(ErrorCode::Limit);
    }
    let id = new_key(8);
    let now = now_ms();
    sqlx::query("INSERT INTO shared_playlists (id, owner, name, access, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(address)
        .bind(&name)
        .bind(access)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("INSERT INTO shared_members (playlist_id, address, role, invited, joined_ms) VALUES (?, ?, 1, 0, ?)").bind(&id).bind(address).bind(now).execute(&mut *tx).await.map_err(db_err)?;
    add_items(&mut tx, &id, address, &r.items).await?;
    let playlist = reply_summary(&mut tx, &id, address).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::SharedCreateResponse { playlist: Some(playlist) }.encode_to_vec())
}

async fn edit(pool: &SqlitePool, address: &str, r: pb::SharedEditRequest) -> Reply {
    let mut tx = parvane_db::begin_write(pool).await.map_err(db_err)?;
    let row = playlist_row(&mut tx, &r.playlist_id).await?;
    let me = member_of(&mut tx, &row.id, address).await?;
    if me.is_none() && access_of(row.access) != pb::SharedAccess::Server {
        return Err(ErrorCode::NotFound);
    }
    need(me, &[pb::SharedRole::Owner])?;
    if !r.name.trim().is_empty() {
        let name = clean_name(&r.name)?;
        sqlx::query("UPDATE shared_playlists SET name = ? WHERE id = ?").bind(name).bind(&row.id).execute(&mut *tx).await.map_err(db_err)?;
    }
    match pb::SharedAccess::try_from(r.access) {
        Ok(pb::SharedAccess::Unspecified) => {}
        Ok(a) => {
            sqlx::query("UPDATE shared_playlists SET access = ? WHERE id = ?").bind(if a == pb::SharedAccess::Server { 2 } else { 1 }).bind(&row.id).execute(&mut *tx).await.map_err(db_err)?;
        }
        Err(_) => return Err(ErrorCode::Invalid),
    }
    if r.rotate_join_key || (r.issue_join_key && row.join_key.is_empty()) {
        sqlx::query("UPDATE shared_playlists SET join_key = ? WHERE id = ?").bind(new_key(16)).bind(&row.id).execute(&mut *tx).await.map_err(db_err)?;
    }
    touch(&mut tx, &row.id).await?;
    let playlist = reply_summary(&mut tx, &row.id, address).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::SharedEditResponse { playlist: Some(playlist) }.encode_to_vec())
}

async fn delete(pool: &SqlitePool, address: &str, r: pb::SharedDeleteRequest) -> Reply {
    let mut tx = parvane_db::begin_write(pool).await.map_err(db_err)?;
    let row = playlist_row(&mut tx, &r.playlist_id).await?;
    let me = member_of(&mut tx, &row.id, address).await?;
    if me.is_none() && access_of(row.access) != pb::SharedAccess::Server {
        return Err(ErrorCode::NotFound);
    }
    need(me, &[pb::SharedRole::Owner])?;
    for table in ["shared_items", "shared_members"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE playlist_id = ?")).bind(&row.id).execute(&mut *tx).await.map_err(db_err)?;
    }
    sqlx::query("DELETE FROM shared_playlists WHERE id = ?").bind(&row.id).execute(&mut *tx).await.map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::SharedDeleteResponse {}.encode_to_vec())
}

/// Место для записи перед `before` (пусто — в конец); тесно — перенумеровать всё по порядку.
async fn rank_before(tx: &mut Transaction<'static, Sqlite>, id: &str, moving: &str, before: &str) -> Result<f64, ErrorCode> {
    let mut order: Vec<(String, f64)> = sqlx::query_as("SELECT id, rank FROM shared_items WHERE playlist_id = ? AND id != ? ORDER BY rank, id").bind(id).bind(moving).fetch_all(&mut **tx).await.map_err(db_err)?;
    let at = if before.is_empty() { order.len() } else { order.iter().position(|(i, _)| i == before).ok_or(ErrorCode::NotFound)? };
    let prev = if at == 0 { None } else { order.get(at - 1).map(|x| x.1) };
    let next = order.get(at).map(|x| x.1);
    let rank = match (prev, next) {
        (None, None) => 1.0,
        (Some(p), None) => p + 1.0,
        (None, Some(n)) => n - 1.0,
        (Some(p), Some(n)) => (p + n) / 2.0,
    };
    let tight = matches!((prev, next), (Some(p), Some(n)) if n - p < RANK_EPS);
    if !tight {
        return Ok(rank);
    }
    order.insert(at, (moving.to_string(), 0.0));
    for (i, (item, _)) in order.iter().enumerate() {
        sqlx::query("UPDATE shared_items SET rank = ? WHERE playlist_id = ? AND id = ?").bind((i + 1) as f64).bind(id).bind(item).execute(&mut **tx).await.map_err(db_err)?;
    }
    Ok((at + 1) as f64)
}

async fn items(pool: &SqlitePool, address: &str, r: pb::SharedItemsRequest) -> Reply {
    let mut tx = parvane_db::begin_write(pool).await.map_err(db_err)?;
    let row = playlist_row(&mut tx, &r.playlist_id).await?;
    let me = member_of(&mut tx, &row.id, address).await?;
    if me.is_none() && access_of(row.access) != pb::SharedAccess::Server {
        return Err(ErrorCode::NotFound);
    }
    need(me, &[pb::SharedRole::Owner, pb::SharedRole::Editor])?;
    for item in &r.remove {
        sqlx::query("DELETE FROM shared_items WHERE playlist_id = ? AND id = ?").bind(&row.id).bind(item).execute(&mut *tx).await.map_err(db_err)?;
    }
    if !r.move_id.is_empty() {
        let (exists,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM shared_items WHERE playlist_id = ? AND id = ?").bind(&row.id).bind(&r.move_id).fetch_one(&mut *tx).await.map_err(db_err)?;
        if exists == 0 {
            return Err(ErrorCode::NotFound);
        }
        let rank = rank_before(&mut tx, &row.id, &r.move_id, &r.move_before_id).await?;
        sqlx::query("UPDATE shared_items SET rank = ? WHERE playlist_id = ? AND id = ?").bind(rank).bind(&row.id).bind(&r.move_id).execute(&mut *tx).await.map_err(db_err)?;
    }
    let skipped = add_items(&mut tx, &row.id, address, &r.add).await?;
    touch(&mut tx, &row.id).await?;
    let playlist = reply_summary(&mut tx, &row.id, address).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::SharedItemsResponse { playlist: Some(playlist), skipped }.encode_to_vec())
}

async fn member(pool: &SqlitePool, address: &str, r: pb::SharedMemberRequest) -> Reply {
    let mut tx = parvane_db::begin_write(pool).await.map_err(db_err)?;
    let row = playlist_row(&mut tx, &r.playlist_id).await?;
    let me = member_of(&mut tx, &row.id, address).await?;
    if me.is_none() && access_of(row.access) != pb::SharedAccess::Server {
        return Err(ErrorCode::NotFound);
    }
    need(me, &[pb::SharedRole::Owner])?;
    if r.address == row.owner {
        // Владелец себя не убирает и роль не меняет: плейлист удаляется либо становится личным
        return Err(ErrorCode::Invalid);
    }
    if r.remove {
        sqlx::query("DELETE FROM shared_members WHERE playlist_id = ? AND address = ?").bind(&row.id).bind(&r.address).execute(&mut *tx).await.map_err(db_err)?;
    } else {
        if !valid_member(&r.address, address) {
            return Err(ErrorCode::Invalid);
        }
        let role = match pb::SharedRole::try_from(r.role) {
            Ok(pb::SharedRole::Editor | pb::SharedRole::Unspecified) => 2,
            Ok(pb::SharedRole::Listener) => 3,
            _ => return Err(ErrorCode::Invalid),
        };
        let known = member_of(&mut tx, &row.id, &r.address).await?;
        if known.is_some() {
            sqlx::query("UPDATE shared_members SET role = ? WHERE playlist_id = ? AND address = ?").bind(role).bind(&row.id).bind(&r.address).execute(&mut *tx).await.map_err(db_err)?;
        } else {
            let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM shared_members WHERE playlist_id = ?").bind(&row.id).fetch_one(&mut *tx).await.map_err(db_err)?;
            if n >= MEMBERS_MAX {
                return Err(ErrorCode::Limit);
            }
            sqlx::query("INSERT INTO shared_members (playlist_id, address, role, invited, joined_ms) VALUES (?, ?, ?, 1, ?)")
                .bind(&row.id)
                .bind(&r.address)
                .bind(role)
                .bind(now_ms())
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
        }
    }
    touch(&mut tx, &row.id).await?;
    let playlist = reply_summary(&mut tx, &row.id, address).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::SharedMemberResponse { playlist: Some(playlist) }.encode_to_vec())
}

async fn leave(pool: &SqlitePool, address: &str, r: pb::SharedLeaveRequest) -> Reply {
    let mut tx = parvane_db::begin_write(pool).await.map_err(db_err)?;
    let row = playlist_row(&mut tx, &r.playlist_id).await?;
    let me = member_of(&mut tx, &row.id, address).await?.ok_or(ErrorCode::NotFound)?;
    if me.0 == pb::SharedRole::Owner {
        return Err(ErrorCode::Forbidden);
    }
    sqlx::query("DELETE FROM shared_members WHERE playlist_id = ? AND address = ?").bind(&row.id).bind(address).execute(&mut *tx).await.map_err(db_err)?;
    touch(&mut tx, &row.id).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::SharedLeaveResponse {}.encode_to_vec())
}

async fn join(pool: &SqlitePool, address: &str, r: pb::SharedJoinRequest) -> Reply {
    let mut tx = parvane_db::begin_write(pool).await.map_err(db_err)?;
    let row = playlist_row(&mut tx, &r.playlist_id).await?;
    // Неверный ключ неотличим от несуществующего плейлиста
    let key_ok = !row.join_key.is_empty() && row.join_key.len() == r.join_key.len() && row.join_key.bytes().zip(r.join_key.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0;
    if !key_ok || domain_of(&row.owner) != domain_of(address) {
        return Err(ErrorCode::NotFound);
    }
    if member_of(&mut tx, &row.id, address).await?.is_none() {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM shared_members WHERE playlist_id = ?").bind(&row.id).fetch_one(&mut *tx).await.map_err(db_err)?;
        if n >= MEMBERS_MAX {
            return Err(ErrorCode::Limit);
        }
        sqlx::query("INSERT INTO shared_members (playlist_id, address, role, invited, joined_ms) VALUES (?, ?, 2, 0, ?)").bind(&row.id).bind(address).bind(now_ms()).execute(&mut *tx).await.map_err(db_err)?;
        touch(&mut tx, &row.id).await?;
    }
    let playlist = reply_summary(&mut tx, &row.id, address).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(pb::SharedJoinResponse { playlist: Some(playlist) }.encode_to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_address_is_same_server_nick() {
        assert!(valid_member("bob@local", "alice@local"));
        assert!(!valid_member("bob@other.example", "alice@local"), "только свой сервер");
        assert!(!valid_member("Bob@local", "alice@local"));
        assert!(!valid_member("b@local", "alice@local"));
        assert!(!valid_member("bob", "alice@local"));
        assert_eq!(clean_name("  Дорога  ").unwrap(), "Дорога");
        assert!(clean_name("   ").is_err());
        assert!(clean_name(&"я".repeat(200)).is_err());
    }
}
