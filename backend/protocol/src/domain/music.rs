//! Плейлисты «Музыки» `parvane.music.v1` (spec 039, этап C): сведённое состояние контейнера и применение операций.
//!
//! Плейлист (`Playlist`) и трек в плейлисте (`PlaylistItem`) — регистры со своим id; сводятся целиком по `stamp`
//! (`(lamport, device_id)`, при равных — большие байты), удаление — надгробие `deleted`. Порядок сведения полный:
//! любой порядок применения даёт один снимок. Негодное изменение пропускается, остальные изменения операции
//! применяются. Порядок треков — `rank`, при равных — id записи.

use std::collections::BTreeMap;

use prost::Message;

use super::{LamportGuard, Stamp, StateCache};
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::LwwStamp;
use crate::pb::parvane::music::v1::{playlist_change::Change as Kind, MusicOp, MusicSnapshot, Playlist, PlaylistChange, PlaylistItem};

pub const DOMAIN_NAME: &str = "parvane.music.v1";
pub const SNAPSHOT_EVERY: u64 = 200;
const MAX_ID: usize = 64;
pub const MAX_NAME: usize = 240;
const MAX_TRACK_ID: usize = 128;
const MAX_SERVER: usize = 253;
const MAX_LABEL: usize = 600;
pub const MAX_PLAYLISTS_STORED: usize = 2000;
pub const MAX_ITEMS_STORED: usize = 60_000;
const MAX_ABS_RANK: f64 = 1e15;
const MAX_DURATION_SECS: u32 = 48 * 3600;

pub fn decode_op(bytes: &[u8]) -> Result<MusicOp> {
    decode_checked(bytes, Origin::Client)
}

pub fn decode_snapshot(bytes: &[u8]) -> Result<MusicSnapshot> {
    decode_checked(bytes, Origin::Client)
}

fn is_newer(incoming: Option<&LwwStamp>, incoming_bytes: &[u8], current: Option<&LwwStamp>, current_bytes: &[u8]) -> bool {
    let Some(i) = incoming else { return false };
    let Some(c) = current else { return true };
    (i.lamport, i.device_id.as_str(), incoming_bytes) > (c.lamport, c.device_id.as_str(), current_bytes)
}

fn stamp_key(s: Option<&LwwStamp>) -> (u64, &str) {
    s.map(|s| (s.lamport, s.device_id.as_str())).unwrap_or((0, ""))
}

fn merge_deleted(cur: &mut Option<LwwStamp>, inc: Option<&LwwStamp>) {
    if let Some(i) = inc {
        if stamp_key(Some(i)) > stamp_key(cur.as_ref()) {
            *cur = Some(i.clone());
        }
    }
}

pub fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ID && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_label(s: &str, max: usize) -> bool {
    s.len() <= max && !s.chars().any(char::is_control)
}

pub fn check_playlist(p: &Playlist) -> Result<()> {
    if !is_id(&p.id) {
        return Err(ProtoError::InvalidField("id"));
    }
    // Надгробие без правки несёт только id и метку удаления
    if p.stamp.is_none() && p.deleted.is_some() {
        return Ok(());
    }
    if p.name.trim().is_empty() || !is_label(&p.name, MAX_NAME) {
        return Err(ProtoError::InvalidField("playlist_name"));
    }
    if p.created_ms < 0 {
        return Err(ProtoError::InvalidField("playlist_created"));
    }
    Ok(())
}

pub fn check_item(i: &PlaylistItem) -> Result<()> {
    if !is_id(&i.id) {
        return Err(ProtoError::InvalidField("id"));
    }
    if i.stamp.is_none() && i.deleted.is_some() {
        return Ok(());
    }
    if !is_id(&i.playlist_id) {
        return Err(ProtoError::InvalidField("playlist_id"));
    }
    if i.track_id.is_empty() || !is_label(&i.track_id, MAX_TRACK_ID) {
        return Err(ProtoError::InvalidField("track_id"));
    }
    if i.server.len() > MAX_SERVER || !i.server.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':')) {
        return Err(ProtoError::InvalidField("server"));
    }
    if !(i.rank.is_finite() && i.rank.abs() <= MAX_ABS_RANK) {
        return Err(ProtoError::InvalidField("rank"));
    }
    if !is_label(&i.title, MAX_LABEL) || !is_label(&i.artist, MAX_LABEL) || i.duration_secs > MAX_DURATION_SECS || i.added_ms < 0 {
        return Err(ProtoError::InvalidField("item_label"));
    }
    Ok(())
}

/// Сведённое состояние контейнера.
#[derive(Debug, Clone, Default)]
pub struct MusicState {
    pub playlists: BTreeMap<String, Playlist>,
    pub items: BTreeMap<String, PlaylistItem>,
    cache: StateCache,
}

impl PartialEq for MusicState {
    fn eq(&self, other: &Self) -> bool {
        self.playlists == other.playlists && self.items == other.items
    }
}

/// Слить регистр с надгробием: правка новее — заменяет, надгробие — наибольшее.
macro_rules! merge_register {
    ($map:expr, $inc:expr, $ty:ident) => {{
        let inc = $inc;
        match $map.get_mut(&inc.id) {
            Some(c) => {
                let (inc_bytes, cur_bytes) = (inc.encode_to_vec(), c.encode_to_vec());
                let deleted = c.deleted.clone();
                if is_newer(inc.stamp.as_ref(), &inc_bytes, c.stamp.as_ref(), &cur_bytes) {
                    *c = inc.clone();
                    c.deleted = deleted;
                }
                merge_deleted(&mut c.deleted, inc.deleted.as_ref());
            }
            None => {
                // Надгробие без метки — только id и `deleted`: «попутные» поля зависели бы от порядка применения
                let fresh = if inc.stamp.is_none() { $ty { id: inc.id.clone(), deleted: inc.deleted.clone(), ..Default::default() } } else { inc.clone() };
                $map.insert(inc.id.clone(), fresh);
            }
        }
    }};
}

impl MusicState {
    pub fn is_playlist_alive(p: &Playlist) -> bool {
        stamp_key(p.stamp.as_ref()) > stamp_key(p.deleted.as_ref())
    }

    pub fn is_item_alive(i: &PlaylistItem) -> bool {
        stamp_key(i.stamp.as_ref()) > stamp_key(i.deleted.as_ref())
    }

    fn apply_change(&mut self, c: &PlaylistChange) -> Result<()> {
        match &c.change {
            Some(Kind::Playlist(p)) => {
                check_playlist(p)?;
                merge_register!(self.playlists, p, Playlist);
            }
            Some(Kind::Item(i)) => {
                check_item(i)?;
                merge_register!(self.items, i, PlaylistItem);
            }
            // Вид будущего движка: критичность решает слой журнала (диапазон номеров), здесь — пропуск
            None => {}
        }
        Ok(())
    }

    /// Применить операцию устройства `author_device`: число применённых изменений. Метки операции обязаны нести
    /// устройство автора (подпись `SignedOp`), иначе отказ на всю операцию (D-16).
    pub fn apply_op(&mut self, op: &MusicOp, author_device: &str) -> Result<usize> {
        let stamps = op_stamps(op)?;
        if stamps.iter().any(|s| s.device_id != author_device) {
            return Err(ProtoError::ContextMismatch);
        }
        self.cache.touch();
        Ok(op.changes.iter().filter(|c| self.apply_change(c).is_ok()).count())
    }

    /// Слить снимок (идемпотентно; те же правила, что у операций).
    pub fn merge_snapshot(&mut self, s: &MusicSnapshot) -> Result<()> {
        snapshot_stamps(s)?;
        self.cache.touch();
        for p in &s.playlists {
            check_playlist(p)?;
            merge_register!(self.playlists, p, Playlist);
        }
        for i in &s.items {
            check_item(i)?;
            merge_register!(self.items, i, PlaylistItem);
        }
        Ok(())
    }

    /// Снимок: всё состояние с надгробиями. Сверх потолка первыми уходят самые старые надгробия записей.
    pub fn to_snapshot(&self) -> MusicSnapshot {
        let mut items: Vec<PlaylistItem> = self.items.values().cloned().collect();
        if items.len() > MAX_ITEMS_STORED {
            let mut dead: Vec<(u64, String, String)> = items
                .iter()
                .filter(|i| !Self::is_item_alive(i))
                .map(|i| (i.deleted.as_ref().map(|d| d.lamport).unwrap_or(0), i.deleted.as_ref().map(|d| d.device_id.clone()).unwrap_or_default(), i.id.clone()))
                .collect();
            dead.sort();
            let drop: std::collections::BTreeSet<String> = dead.into_iter().take(items.len() - MAX_ITEMS_STORED).map(|(_, _, id)| id).collect();
            items.retain(|i| !drop.contains(&i.id));
        }
        MusicSnapshot { playlists: self.playlists.values().cloned().collect(), items }
    }

    /// Живые плейлисты: по времени создания, при равных — по id.
    pub fn live_playlists(&self) -> Vec<&Playlist> {
        let mut out: Vec<&Playlist> = self.playlists.values().filter(|p| Self::is_playlist_alive(p)).collect();
        out.sort_by(|a, b| (a.created_ms, &a.id).cmp(&(b.created_ms, &b.id)));
        out
    }

    /// Живые треки плейлиста в порядке показа: по `rank`, при равных — по id записи.
    pub fn items_of(&self, playlist_id: &str) -> Vec<&PlaylistItem> {
        let mut out: Vec<&PlaylistItem> = self.items.values().filter(|i| i.playlist_id == playlist_id && Self::is_item_alive(i)).collect();
        out.sort_by(|a, b| a.rank.total_cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
        out
    }

    pub fn rev(&self) -> u64 {
        self.cache.rev()
    }

    pub fn snapshot_size(&self) -> usize {
        self.cache.size_or(|| self.to_snapshot().encoded_len())
    }
}

/// Все метки операции (для проверки автора и `LamportGuard`).
pub fn op_stamps(op: &MusicOp) -> Result<Vec<Stamp>> {
    let mut out = Vec::new();
    for c in &op.changes {
        let (stamp, deleted) = match &c.change {
            Some(Kind::Playlist(p)) => (p.stamp.as_ref(), p.deleted.as_ref()),
            Some(Kind::Item(i)) => (i.stamp.as_ref(), i.deleted.as_ref()),
            None => (None, None),
        };
        for s in [stamp, deleted].into_iter().flatten() {
            out.push(Stamp::from_pb(Some(s))?);
        }
    }
    if out.is_empty() {
        return Err(ProtoError::InvalidField("changes"));
    }
    Ok(out)
}

pub fn snapshot_stamps(s: &MusicSnapshot) -> Result<Vec<Stamp>> {
    let mut changes: Vec<PlaylistChange> = s.playlists.iter().map(|p| PlaylistChange { change: Some(Kind::Playlist(p.clone())) }).collect();
    changes.extend(s.items.iter().map(|i| PlaylistChange { change: Some(Kind::Item(i.clone())) }));
    if changes.is_empty() {
        return Ok(vec![]);
    }
    op_stamps(&MusicOp { changes })
}

/// Метки снимка в часы (D-16): наибольший lamport не выше накопленного `upto_seq` операциями.
pub fn guard_snapshot(guard: &mut LamportGuard, s: &MusicSnapshot, upto_seq: u64) -> Result<()> {
    let max = snapshot_stamps(s)?.iter().map(|x| x.lamport).max().unwrap_or(0);
    let limit = guard.max_seen().saturating_add(super::LAMPORT_MAX_JUMP.saturating_mul(upto_seq.max(1)));
    if max > limit {
        return Err(ProtoError::InvalidField("lamport"));
    }
    guard.raise(max);
    Ok(())
}

/// Проверить метки операции в порядке журнала (D-16).
pub fn guard_op(guard: &mut LamportGuard, op: &MusicOp) -> Result<()> {
    for s in op_stamps(op)? {
        guard.check(&s)?;
    }
    Ok(())
}

/// Проставить одну метку всем изменениям операции (локальная правка: хост присылает изменения без меток).
/// У изменения-удаления (`deleted` задан) метка идёт в надгробие, правка не трогается.
pub fn stamp_op(op: &mut MusicOp, stamp: &Stamp) {
    let pb = stamp.to_pb();
    for c in &mut op.changes {
        let (own, deleted) = match &mut c.change {
            Some(Kind::Playlist(p)) => (&mut p.stamp, &mut p.deleted),
            Some(Kind::Item(i)) => (&mut i.stamp, &mut i.deleted),
            None => continue,
        };
        if deleted.is_some() {
            *deleted = Some(pb.clone());
        } else {
            *own = Some(pb.clone());
        }
    }
}
