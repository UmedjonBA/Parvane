//! Домен «Здоровье» `parvane.health.v1` (spec 038): сведённое состояние контейнера и применение операций.
//!
//! Запись (`Entry`) — измерение либо отрезок со своим случайным id; сводится целиком по `stamp`
//! (`(lamport, device_id)`, при равных — большие байты), удаление — надгробие `deleted`: запись видна, пока её
//! правка новее надгробия. Цель (`Goal`) — такой же регистр на имя цели. Порядок сведения полный, поэтому оно
//! коммутативно, ассоциативно и идемпотентно: любой порядок применения даёт один снимок.
//!
//! Проверяется только форма значений (вид, время, конечность чисел, длины): допустимые диапазоны показателей —
//! дело разбора ввода и форм, иначе два выпуска движка с разными диапазонами разошлись бы в сведении. Негодное
//! изменение пропускается, остальные изменения операции применяются.

use std::collections::BTreeMap;

use prost::Message;

use super::{LamportGuard, Stamp, StateCache};
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::LwwStamp;
use crate::pb::parvane::health::v1::{change, Change, Entry, Goal, HealthOp, HealthSnapshot};

pub const DOMAIN_NAME: &str = "parvane.health.v1";
/// Снимок — раз в столько операций (как у планировщика).
pub const SNAPSHOT_EVERY: u64 = 200;
const MAX_ID: usize = 64;
const MAX_KIND: usize = 24;
const MAX_UNIT: usize = 12;
const MAX_SOURCE: usize = 32;
const MAX_NOTE: usize = 500;
const MAX_NAME: usize = 120;
const MAX_TAG: usize = 16;
const MAX_PART_KEY: usize = 16;
const MAX_PARTS: usize = 12;
/// Отрезок не длиннее двух суток.
pub const MAX_SPAN_MS: i64 = 48 * 3_600_000;
/// Смещение местного времени: от UTC−12 до UTC+14.
pub const TZ_MIN: i32 = -12 * 60;
pub const TZ_MAX: i32 = 14 * 60;
/// Записей в снимке вместе с надгробиями (`HealthSnapshot.entries`).
pub const MAX_ENTRIES_STORED: usize = 60_000;
pub const MAX_GOALS_STORED: usize = 200;
const MAX_ABS_VALUE: f64 = 1e9;
/// 1 января 2000 — раньше записей не бывает (защита от секунд вместо миллисекунд).
const MIN_AT_MS: i64 = 946_684_800_000;
/// 1 января 2200.
const MAX_AT_MS: i64 = 7_258_118_400_000;

pub fn decode_op(bytes: &[u8]) -> Result<HealthOp> {
    decode_checked(bytes, Origin::Client)
}

pub fn decode_snapshot(bytes: &[u8]) -> Result<HealthSnapshot> {
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

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ID && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Имя вида, цели, единицы: строчная латинская буква, дальше буквы, цифры и `_`.
pub fn is_name(s: &str, max: usize) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= max && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn is_source(s: &str) -> bool {
    s.len() <= MAX_SOURCE && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'.' | b'-'))
}

fn is_number(v: f64) -> bool {
    v.is_finite() && v.abs() <= MAX_ABS_VALUE
}

pub fn check_entry(e: &Entry) -> Result<()> {
    if !is_id(&e.id) {
        return Err(ProtoError::InvalidField("id"));
    }
    // Надгробие без правки несёт только id и метку удаления
    if e.stamp.is_none() && e.deleted.is_some() {
        return Ok(());
    }
    if !is_name(&e.kind, MAX_KIND) {
        return Err(ProtoError::InvalidField("health_kind"));
    }
    if !(MIN_AT_MS..=MAX_AT_MS).contains(&e.at_ms) {
        return Err(ProtoError::InvalidField("health_at"));
    }
    if e.end_ms != 0 && !(e.end_ms > e.at_ms && e.end_ms - e.at_ms <= MAX_SPAN_MS) {
        return Err(ProtoError::InvalidField("health_end"));
    }
    if !(TZ_MIN..=TZ_MAX).contains(&e.tz_min) {
        return Err(ProtoError::InvalidField("health_tz"));
    }
    if !is_number(e.value) || !is_number(e.value2) {
        return Err(ProtoError::InvalidField("health_value"));
    }
    if !(e.unit.is_empty() || is_name(&e.unit, MAX_UNIT)) {
        return Err(ProtoError::InvalidField("health_unit"));
    }
    if !is_source(&e.source) {
        return Err(ProtoError::InvalidField("health_source"));
    }
    if e.note.len() > MAX_NOTE || e.note.chars().any(|c| c.is_control() && c != '\n') {
        return Err(ProtoError::InvalidField("health_note"));
    }
    if e.name.len() > MAX_NAME || e.name.chars().any(char::is_control) {
        return Err(ProtoError::InvalidField("health_name"));
    }
    if !(e.tag.is_empty() || is_name(&e.tag, MAX_TAG)) {
        return Err(ProtoError::InvalidField("health_tag"));
    }
    // Имена чисел не повторяются: иначе значение зависело бы от того, какое из двух прочёл клиент
    let unique = e.parts.iter().enumerate().all(|(i, p)| e.parts.iter().take(i).all(|q| q.key != p.key));
    if e.parts.len() > MAX_PARTS || !unique || e.parts.iter().any(|p| !is_name(&p.key, MAX_PART_KEY) || !is_number(p.value)) {
        return Err(ProtoError::InvalidField("health_parts"));
    }
    Ok(())
}

pub fn check_goal(g: &Goal) -> Result<()> {
    if !is_name(&g.id, MAX_KIND) {
        return Err(ProtoError::InvalidField("id"));
    }
    if g.stamp.is_none() && g.deleted.is_some() {
        return Ok(());
    }
    if !is_number(g.target) || g.target < 0.0 {
        return Err(ProtoError::InvalidField("health_goal"));
    }
    Ok(())
}

/// Именованное число записи; `None` — не задано («неизвестно», а не ноль).
pub fn part(e: &Entry, key: &str) -> Option<f64> {
    e.parts.iter().find(|p| p.key == key).map(|p| p.value)
}

/// День записи `ГГГГ-ММ-ДД` по местному времени записи: у отрезка — день его конца (сон — день пробуждения).
pub fn entry_day(e: &Entry) -> String {
    let moment = if e.end_ms != 0 { e.end_ms } else { e.at_ms };
    day_of(moment, e.tz_min)
}

/// Календарный день момента со смещением (алгоритм дней от эпохи, без часовых поясов системы).
pub fn day_of(ms: i64, tz_min: i32) -> String {
    let days = (ms + i64::from(tz_min) * 60_000).div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Минуты от местной полуночи.
pub fn minute_of_day(ms: i64, tz_min: i32) -> u32 {
    ((ms + i64::from(tz_min) * 60_000).rem_euclid(86_400_000) / 60_000) as u32
}

/// Дни от 1970-01-01 → (год, месяц, день) григорианского календаря.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// (год, месяц, день) → дни от 1970-01-01.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Сведённое состояние контейнера.
#[derive(Debug, Clone, Default)]
pub struct HealthState {
    pub entries: BTreeMap<String, Entry>,
    pub goals: BTreeMap<String, Goal>,
    cache: StateCache,
}

impl PartialEq for HealthState {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries && self.goals == other.goals
    }
}

impl HealthState {
    pub fn is_entry_alive(e: &Entry) -> bool {
        stamp_key(e.stamp.as_ref()) > stamp_key(e.deleted.as_ref())
    }

    pub fn is_goal_alive(g: &Goal) -> bool {
        stamp_key(g.stamp.as_ref()) > stamp_key(g.deleted.as_ref())
    }

    fn merge_entry(&mut self, inc: &Entry) {
        match self.entries.get_mut(&inc.id) {
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
                let fresh = if inc.stamp.is_none() { Entry { id: inc.id.clone(), deleted: inc.deleted.clone(), ..Default::default() } } else { inc.clone() };
                self.entries.insert(inc.id.clone(), fresh);
            }
        }
    }

    fn merge_goal(&mut self, inc: &Goal) {
        match self.goals.get_mut(&inc.id) {
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
                let fresh = if inc.stamp.is_none() { Goal { id: inc.id.clone(), deleted: inc.deleted.clone(), ..Default::default() } } else { inc.clone() };
                self.goals.insert(inc.id.clone(), fresh);
            }
        }
    }

    fn apply_change(&mut self, c: &Change) -> Result<()> {
        match &c.change {
            Some(change::Change::Entry(e)) => {
                check_entry(e)?;
                self.merge_entry(e);
            }
            Some(change::Change::Goal(g)) => {
                check_goal(g)?;
                self.merge_goal(g);
            }
            // Вид будущего движка: критичность решает слой журнала (диапазон номеров), здесь — пропуск
            None => {}
        }
        Ok(())
    }

    /// Применить операцию устройства `author_device`: число применённых изменений. Метки операции обязаны нести
    /// устройство автора (подпись `SignedOp`), иначе отказ на всю операцию (D-16).
    pub fn apply_op(&mut self, op: &HealthOp, author_device: &str) -> Result<usize> {
        let stamps = op_stamps(op)?;
        if stamps.iter().any(|s| s.device_id != author_device) {
            return Err(ProtoError::ContextMismatch);
        }
        self.cache.touch();
        let mut applied = 0;
        for c in &op.changes {
            if self.apply_change(c).is_ok() {
                applied += 1;
            }
        }
        Ok(applied)
    }

    /// Слить снимок (идемпотентно; те же правила, что у операций).
    pub fn merge_snapshot(&mut self, s: &HealthSnapshot) -> Result<()> {
        snapshot_stamps(s)?;
        self.cache.touch();
        for e in &s.entries {
            check_entry(e)?;
            self.merge_entry(e);
        }
        for g in &s.goals {
            check_goal(g)?;
            self.merge_goal(g);
        }
        Ok(())
    }

    /// Снимок: всё состояние с надгробиями. Сверх потолка первыми уходят самые старые надгробия записей.
    pub fn to_snapshot(&self) -> HealthSnapshot {
        let mut entries: Vec<Entry> = self.entries.values().cloned().collect();
        if entries.len() > MAX_ENTRIES_STORED {
            let mut dead: Vec<(u64, String, String)> = entries
                .iter()
                .filter(|e| !Self::is_entry_alive(e))
                .map(|e| (e.deleted.as_ref().map(|d| d.lamport).unwrap_or(0), e.deleted.as_ref().map(|d| d.device_id.clone()).unwrap_or_default(), e.id.clone()))
                .collect();
            dead.sort();
            let drop: std::collections::BTreeSet<String> = dead.into_iter().take(entries.len() - MAX_ENTRIES_STORED).map(|(_, _, id)| id).collect();
            entries.retain(|e| !drop.contains(&e.id));
        }
        HealthSnapshot { entries, goals: self.goals.values().cloned().collect() }
    }

    pub fn live_entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values().filter(|e| Self::is_entry_alive(e))
    }

    pub fn live_goals(&self) -> impl Iterator<Item = &Goal> {
        self.goals.values().filter(|g| Self::is_goal_alive(g))
    }

    pub fn rev(&self) -> u64 {
        self.cache.rev()
    }

    pub fn snapshot_size(&self) -> usize {
        self.cache.size_or(|| self.to_snapshot().encoded_len())
    }
}

/// Все метки операции (для проверки автора и `LamportGuard`).
pub fn op_stamps(op: &HealthOp) -> Result<Vec<Stamp>> {
    let mut out = Vec::new();
    for c in &op.changes {
        let (stamp, deleted) = match &c.change {
            Some(change::Change::Entry(e)) => (e.stamp.as_ref(), e.deleted.as_ref()),
            Some(change::Change::Goal(g)) => (g.stamp.as_ref(), g.deleted.as_ref()),
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

pub fn snapshot_stamps(s: &HealthSnapshot) -> Result<Vec<Stamp>> {
    let mut changes: Vec<Change> = s.entries.iter().map(|e| Change { change: Some(change::Change::Entry(e.clone())) }).collect();
    changes.extend(s.goals.iter().map(|g| Change { change: Some(change::Change::Goal(g.clone())) }));
    if changes.is_empty() {
        return Ok(vec![]);
    }
    op_stamps(&HealthOp { changes })
}

/// Метки снимка в часы (D-16): наибольший lamport не выше накопленного `upto_seq` операциями.
pub fn guard_snapshot(guard: &mut LamportGuard, s: &HealthSnapshot, upto_seq: u64) -> Result<()> {
    let max = snapshot_stamps(s)?.iter().map(|x| x.lamport).max().unwrap_or(0);
    let limit = guard.max_seen().saturating_add(super::LAMPORT_MAX_JUMP.saturating_mul(upto_seq.max(1)));
    if max > limit {
        return Err(ProtoError::InvalidField("lamport"));
    }
    guard.raise(max);
    Ok(())
}

/// Проверить метки операции в порядке журнала (D-16).
pub fn guard_op(guard: &mut LamportGuard, op: &HealthOp) -> Result<()> {
    for s in op_stamps(op)? {
        guard.check(&s)?;
    }
    Ok(())
}

/// Проставить одну метку всем изменениям операции (локальная правка: хост присылает изменения без меток).
/// У изменения-удаления (`deleted` задан) метка идёт в надгробие, правка не трогается.
pub fn stamp_op(op: &mut HealthOp, stamp: &Stamp) {
    let pb = stamp.to_pb();
    for c in &mut op.changes {
        match &mut c.change {
            Some(change::Change::Entry(e)) => {
                if e.deleted.is_some() {
                    e.deleted = Some(pb.clone());
                } else {
                    e.stamp = Some(pb.clone());
                }
            }
            Some(change::Change::Goal(g)) => {
                if g.deleted.is_some() {
                    g.deleted = Some(pb.clone());
                } else {
                    g.stamp = Some(pb.clone());
                }
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_roundtrip_and_local_day() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        for (y, m, d) in [(2000, 2, 29), (2026, 11, 16), (2024, 12, 31), (2100, 3, 1)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
        // 2026-11-16 22:30 UTC: в UTC+3 уже 17-е, 01:30
        let ms = days_from_civil(2026, 11, 16) * 86_400_000 + (22 * 60 + 30) * 60_000;
        assert_eq!(day_of(ms, 0), "2026-11-16");
        assert_eq!(day_of(ms, 180), "2026-11-17");
        assert_eq!(minute_of_day(ms, 180), 90);
        assert_eq!(day_of(ms, -600), "2026-11-16");
    }
}
