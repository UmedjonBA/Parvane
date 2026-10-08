//! Домен планировщика `parvane.planner.v1` (spec 010, R2/R3): сведённое
//! состояние контейнера и применение операций.
//!
//! Объекты — задачи, события, списки, дни питания; у каждого поля своя метка
//! `LwwStamp`, побеждает большая метка `(lamport, device_id)`, при равных —
//! большие байты значения (полный порядок → сведение коммутативно, ассоциативно
//! и идемпотентно, любой порядок применения даёт один снимок). Удаление —
//! метка `deleted`: объект виден, пока самая свежая правка его полей новее
//! надгробия (старая правка после удаления ничего не воскрешает, новая —
//! воскрешает). Запись питания сливается целиком по `stamp`. Настройки и цели —
//! регистры под одной меткой.
//!
//! Инварианты значений проверяются при применении; негодное изменение
//! пропускается, остальные изменения операции применяются (FR-004). Метки
//! операции обязаны нести устройство автора (подпись `SignedOp`), иначе отказ
//! на всю операцию (D-16); `LamportGuard` проверяется в порядке `seq`.

use std::collections::BTreeMap;

use prost::Message;

use super::{LamportGuard, Stamp};
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::LwwStamp;
use crate::pb::parvane::planner::v1::{
    change, Bool, Change, Event, FoodEntry, Goal, GoalPeriod, GoalSet, List, NutritionDay, Occurrence, Origin as TaskOrigin,
    PlannerOp, PlannerSnapshot, Repeat, RepeatKind, Settings, Source, Steps, Str, Task, Weekdays, I32, U32,
};

pub const DOMAIN_NAME: &str = "parvane.planner.v1";
/// Снимок пишется после операции с `seq`, кратным этому числу (R5).
pub const SNAPSHOT_EVERY: u64 = 200;
/// Потолок открытого текста снимка — как у каркаса; предупреждение с 75 % (R5).
pub const SNAPSHOT_WARN_BYTES: usize = super::MAX_SNAPSHOT_PLAINTEXT / 4 * 3;

pub const MIN_TASK_MINUTES: u32 = 5;
pub const MINUTES_IN_DAY: u32 = 1440;
pub const MIN_BUDGET: u32 = 60;
pub const MAX_MARGIN: u32 = 180;
pub const STATUSES: [&str; 5] = ["queue", "active", "later", "waiting", "done"];
pub const MEALS: [&str; 5] = ["breakfast", "lunch", "dinner", "snack", "other"];
const MAX_ID: usize = 64;
const MAX_NAME: usize = 200;
const MAX_DESCRIPTION: usize = 4000;
const MAX_LIST_NAME: usize = 60;
const MAX_FOOD_NAME: usize = 120;
/// spec 011: повторы и цели по датам.
pub const MAX_OCCURRENCES: usize = 2000;
pub const MAX_REPEAT_INTERVAL: u32 = 99;
pub const MAX_REPEAT_COUNT: u32 = 999;
const MAX_CHAT: usize = 128;

pub fn decode_op(bytes: &[u8]) -> Result<PlannerOp> {
    decode_checked(bytes, Origin::Client)
}

pub fn decode_snapshot(bytes: &[u8]) -> Result<PlannerSnapshot> {
    decode_checked(bytes, Origin::Client)
}

// ── порядок меток ───────────────────────────────────────────────────────────

/// Полный порядок правок: метка, затем байты значения.
fn is_newer(incoming: Option<&LwwStamp>, incoming_bytes: &[u8], current: Option<&LwwStamp>, current_bytes: &[u8]) -> bool {
    let Some(i) = incoming else { return false };
    let Some(c) = current else { return true };
    (i.lamport, i.device_id.as_str(), incoming_bytes) > (c.lamport, c.device_id.as_str(), current_bytes)
}

fn stamp_key(s: Option<&LwwStamp>) -> (u64, &str) {
    s.map(|s| (s.lamport, s.device_id.as_str())).unwrap_or((0, ""))
}

macro_rules! merge_reg {
    ($cur:expr, $inc:expr, $ty:ty) => {{
        if let Some(inc) = $inc.as_ref() {
            let inc_bytes = <$ty as Message>::encode_to_vec(inc);
            let cur_bytes = $cur.as_ref().map(<$ty as Message>::encode_to_vec).unwrap_or_default();
            let cur_stamp = $cur.as_ref().and_then(|c| c.stamp.as_ref());
            if is_newer(inc.stamp.as_ref(), &inc_bytes, cur_stamp, &cur_bytes) {
                $cur = Some(inc.clone());
            }
        }
    }};
}

fn merge_deleted(cur: &mut Option<LwwStamp>, inc: Option<&LwwStamp>) {
    if let Some(i) = inc {
        if stamp_key(Some(i)) > stamp_key(cur.as_ref()) {
            *cur = Some(i.clone());
        }
    }
}

// ── проверки значений ───────────────────────────────────────────────────────

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
        && (1..=12).contains(&s[5..7].parse::<u32>().unwrap_or(0))
        && (1..=31).contains(&s[8..10].parse::<u32>().unwrap_or(0))
}

fn is_time(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit())
        && s[0..2].parse::<u32>().unwrap_or(99) < 24
        && s[3..5].parse::<u32>().unwrap_or(99) < 60
}

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ID && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn check_str(v: &Option<Str>, max: usize, ok: impl Fn(&str) -> bool) -> Result<()> {
    match v {
        Some(s) if s.value.len() > max || !ok(&s.value) => Err(ProtoError::InvalidField("value")),
        _ => Ok(()),
    }
}

fn check_task(t: &Task) -> Result<()> {
    if !is_id(&t.id) {
        return Err(ProtoError::InvalidField("id"));
    }
    check_str(&t.name, MAX_NAME, |s| !s.trim().is_empty())?;
    check_str(&t.description, MAX_DESCRIPTION, |_| true)?;
    check_str(&t.status, 16, |s| STATUSES.contains(&s))?;
    check_str(&t.list_id, MAX_ID, |s| s.is_empty() || is_id(s))?;
    check_str(&t.day, 10, |s| s.is_empty() || is_day(s))?;
    check_str(&t.due, 10, |s| s.is_empty() || is_day(s))?;
    check_str(&t.start, 5, |s| s.is_empty() || is_time(s))?;
    if let Some(m) = &t.minutes {
        if !m.unset && !(MIN_TASK_MINUTES..=MINUTES_IN_DAY).contains(&m.value) {
            return Err(ProtoError::InvalidField("minutes"));
        }
    }
    if let Some(steps) = &t.steps {
        if steps.items.len() > 100 || steps.items.iter().any(|s| s.text.is_empty() || s.text.len() > 160) {
            return Err(ProtoError::InvalidField("steps"));
        }
    }
    if let Some(r) = &t.repeat {
        check_repeat(r)?;
    }
    check_occurrences(&t.occurrences)?;
    if let Some(o) = &t.origin {
        check_origin(o)?;
    }
    if let Some(src) = &t.source {
        if src.chat.len() > MAX_CHAT || src.op_id.len() > 32 || (!src.op_id.is_empty() && !src.op_id.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err(ProtoError::InvalidField("source"));
        }
    }
    Ok(())
}

/// Правило повтора (spec 011, data-model «Инварианты правила»).
fn check_repeat(r: &Repeat) -> Result<()> {
    let kind = RepeatKind::try_from(r.kind).map_err(|_| ProtoError::InvalidField("repeat"))?;
    if kind == RepeatKind::Unspecified {
        return Ok(());
    }
    if !(1..=MAX_REPEAT_INTERVAL).contains(&r.interval) {
        return Err(ProtoError::InvalidField("interval"));
    }
    if r.weekdays.len() > 7 || r.weekdays.iter().any(|d| *d > 6) || r.weekdays.iter().enumerate().any(|(i, d)| r.weekdays[..i].contains(d)) {
        return Err(ProtoError::InvalidField("weekdays"));
    }
    if kind == RepeatKind::Weekly && r.weekdays.is_empty() {
        return Err(ProtoError::InvalidField("weekdays"));
    }
    if r.month_day > 31 || r.count > MAX_REPEAT_COUNT {
        return Err(ProtoError::InvalidField("repeat"));
    }
    if !(r.start_day.is_empty() || is_day(&r.start_day)) || !(r.end_day.is_empty() || is_day(&r.end_day)) {
        return Err(ProtoError::InvalidField("repeat_day"));
    }
    if !r.start_day.is_empty() && !r.end_day.is_empty() && r.end_day < r.start_day {
        return Err(ProtoError::InvalidField("end_day"));
    }
    Ok(())
}

fn check_occurrences(items: &[Occurrence]) -> Result<()> {
    if items.len() > MAX_OCCURRENCES {
        return Err(ProtoError::InvalidField("occurrences"));
    }
    for o in items {
        if !is_day(&o.day) || o.done_steps.len() > 100 || o.done_steps.iter().any(|i| *i >= 100) {
            return Err(ProtoError::InvalidField("occurrence"));
        }
    }
    Ok(())
}

fn check_origin(o: &TaskOrigin) -> Result<()> {
    if o.series_id.len() > MAX_ID || !(o.day.is_empty() || is_day(&o.day)) {
        return Err(ProtoError::InvalidField("origin"));
    }
    Ok(())
}

fn check_goal(g: &Goal) -> Result<()> {
    if g.target == 0 || g.tolerance > g.target {
        return Err(ProtoError::InvalidField("goal"));
    }
    Ok(())
}

/// Запись цели с датами: заданные показатели (`set`) — как в GoalSet.
fn check_goal_period(p: &GoalPeriod) -> Result<()> {
    if !is_id(&p.id) {
        return Err(ProtoError::InvalidField("id"));
    }
    if p.stamp.is_none() && p.deleted.is_some() {
        return Ok(());
    }
    if !(p.start_day.is_empty() || is_day(&p.start_day)) || !(p.end_day.is_empty() || is_day(&p.end_day)) {
        return Err(ProtoError::InvalidField("period_day"));
    }
    if !p.start_day.is_empty() && !p.end_day.is_empty() && p.end_day < p.start_day {
        return Err(ProtoError::InvalidField("end_day"));
    }
    for g in [&p.kcal, &p.protein, &p.fat, &p.carbs, &p.fiber, &p.water].into_iter().flatten().filter(|g| g.set) {
        check_goal(g)?;
    }
    Ok(())
}

fn check_event(e: &Event) -> Result<()> {
    if !is_id(&e.id) {
        return Err(ProtoError::InvalidField("id"));
    }
    check_str(&e.name, MAX_NAME, |s| !s.trim().is_empty())?;
    check_str(&e.start, 5, is_time)?;
    check_str(&e.end, 5, is_time)?;
    check_str(&e.day, 10, |s| s.is_empty() || is_day(s))?;
    if let Some(w) = &e.weekdays {
        if w.days.len() > 7 || w.days.iter().any(|d| *d > 6) {
            return Err(ProtoError::InvalidField("weekdays"));
        }
    }
    if let Some(r) = &e.repeat {
        check_repeat(r)?;
    }
    check_occurrences(&e.occurrences)?;
    if let Some(o) = &e.origin {
        check_origin(o)?;
    }
    Ok(())
}

fn check_list(l: &List) -> Result<()> {
    if !is_id(&l.id) {
        return Err(ProtoError::InvalidField("id"));
    }
    check_str(&l.name, MAX_LIST_NAME, |s| !s.trim().is_empty())
}

fn check_entry(e: &FoodEntry) -> Result<()> {
    if !is_id(&e.id) {
        return Err(ProtoError::InvalidField("id"));
    }
    // Надгробие без содержимого — только id и метка удаления.
    if e.stamp.is_none() && e.deleted.is_some() {
        return Ok(());
    }
    if e.name.len() > MAX_FOOD_NAME || !MEALS.contains(&e.meal.as_str()) {
        return Err(ProtoError::InvalidField("entry"));
    }
    if [e.kcal, e.protein, e.fat, e.carbs, e.fiber, e.grams].iter().any(|v| !v.is_finite() || *v < 0.0) {
        return Err(ProtoError::InvalidField("nutrient"));
    }
    Ok(())
}

fn check_day(d: &NutritionDay) -> Result<()> {
    if !is_day(&d.day) {
        return Err(ProtoError::InvalidField("day"));
    }
    if d.entries.len() > 200 {
        return Err(ProtoError::InvalidField("entries"));
    }
    d.entries.iter().try_for_each(check_entry)?;
    if let Some(g) = &d.fixed_goals {
        check_goals(g)?;
    }
    Ok(())
}

fn check_goals(g: &GoalSet) -> Result<()> {
    for goal in [&g.kcal, &g.protein, &g.fat, &g.carbs, &g.fiber, &g.water].into_iter().flatten() {
        check_goal(goal)?;
    }
    Ok(())
}

pub fn check_settings(s: &Settings) -> Result<()> {
    let m = |v: u32| v <= MINUTES_IN_DAY;
    if !m(s.day_start) || !m(s.day_end) || s.day_start >= s.day_end {
        return Err(ProtoError::InvalidField("day_window"));
    }
    if !m(s.lunch_start) || !m(s.lunch_end) {
        return Err(ProtoError::InvalidField("lunch"));
    }
    if s.lunch_end > s.lunch_start && (s.lunch_start < s.day_start || s.lunch_end > s.day_end) {
        return Err(ProtoError::InvalidField("lunch"));
    }
    if s.margin > MAX_MARGIN || !(MIN_BUDGET..=MINUTES_IN_DAY).contains(&s.budget) {
        return Err(ProtoError::InvalidField("margin"));
    }
    Ok(())
}

// ── состояние ───────────────────────────────────────────────────────────────

/// Сведённое состояние контейнера планировщика (ключи — id объектов).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlannerState {
    pub tasks: BTreeMap<String, Task>,
    pub events: BTreeMap<String, Event>,
    pub lists: BTreeMap<String, List>,
    pub nutrition: BTreeMap<String, NutritionDay>,
    pub settings: Option<Settings>,
    pub goals: Option<GoalSet>,
    /// spec 011: записи целей с датами (ключ — id).
    pub goal_periods: BTreeMap<String, GoalPeriod>,
}

/// Самая свежая метка среди полей объекта.
fn task_edit_stamp(t: &Task) -> (u64, String) {
    let mut best = (0u64, String::new());
    let mut see = |s: Option<&LwwStamp>| {
        let k = stamp_key(s);
        if (k.0, k.1) > (best.0, best.1.as_str()) {
            best = (k.0, k.1.to_string());
        }
    };
    see(t.name.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.description.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.steps.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.status.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.list_id.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.rank.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.day.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.start.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.due.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.minutes.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.repeat.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.origin.as_ref().and_then(|f| f.stamp.as_ref()));
    see(t.source.as_ref().and_then(|f| f.stamp.as_ref()));
    for o in &t.occurrences {
        see(o.stamp.as_ref());
    }
    best
}

/// Слить состояния экземпляров по дню: регистр дня целиком по метке (R2).
fn merge_occurrences(cur: &mut Vec<Occurrence>, inc: &[Occurrence]) {
    for o in inc {
        match cur.iter_mut().find(|c| c.day == o.day) {
            Some(c) => {
                let inc_bytes = o.encode_to_vec();
                let cur_bytes = c.encode_to_vec();
                if is_newer(o.stamp.as_ref(), &inc_bytes, c.stamp.as_ref(), &cur_bytes) {
                    *c = o.clone();
                }
            }
            None => cur.push(o.clone()),
        }
    }
    cur.sort_by(|a, b| a.day.cmp(&b.day));
}

fn is_alive(edit: (u64, String), deleted: Option<&LwwStamp>) -> bool {
    let d = stamp_key(deleted);
    (edit.0, edit.1.as_str()) > d
}

impl PlannerState {
    pub fn is_task_alive(t: &Task) -> bool {
        is_alive(task_edit_stamp(t), t.deleted.as_ref())
    }

    pub fn is_event_alive(e: &Event) -> bool {
        let mut best = (0u64, String::new());
        for s in [&e.name, &e.start, &e.end, &e.day]
            .into_iter()
            .flatten()
            .filter_map(|f| f.stamp.as_ref())
            .chain(e.weekdays.as_ref().and_then(|w| w.stamp.as_ref()))
            .chain(e.repeat.as_ref().and_then(|r| r.stamp.as_ref()))
            .chain(e.origin.as_ref().and_then(|o| o.stamp.as_ref()))
            .chain(e.occurrences.iter().filter_map(|o| o.stamp.as_ref()))
        {
            if (s.lamport, s.device_id.as_str()) > (best.0, best.1.as_str()) {
                best = (s.lamport, s.device_id.clone());
            }
        }
        is_alive(best, e.deleted.as_ref())
    }

    pub fn is_goal_period_alive(p: &GoalPeriod) -> bool {
        stamp_key(p.stamp.as_ref()) > stamp_key(p.deleted.as_ref())
    }

    pub fn is_list_alive(l: &List) -> bool {
        let mut best = (0u64, String::new());
        for s in l.name.as_ref().and_then(|f| f.stamp.as_ref()).into_iter().chain(l.order.as_ref().and_then(|f| f.stamp.as_ref())) {
            if (s.lamport, s.device_id.as_str()) > (best.0, best.1.as_str()) {
                best = (s.lamport, s.device_id.clone());
            }
        }
        is_alive(best, l.deleted.as_ref())
    }

    pub fn is_entry_alive(e: &FoodEntry) -> bool {
        stamp_key(e.stamp.as_ref()) > stamp_key(e.deleted.as_ref())
    }

    fn merge_task(&mut self, inc: &Task) {
        let cur = self.tasks.entry(inc.id.clone()).or_insert_with(|| Task { id: inc.id.clone(), ..Default::default() });
        merge_reg!(cur.name, inc.name, Str);
        merge_reg!(cur.description, inc.description, Str);
        merge_reg!(cur.steps, inc.steps, Steps);
        merge_reg!(cur.status, inc.status, Str);
        merge_reg!(cur.list_id, inc.list_id, Str);
        merge_reg!(cur.rank, inc.rank, I32);
        merge_reg!(cur.day, inc.day, Str);
        merge_reg!(cur.start, inc.start, Str);
        merge_reg!(cur.due, inc.due, Str);
        merge_reg!(cur.minutes, inc.minutes, U32);
        merge_reg!(cur.repeat, inc.repeat, Repeat);
        merge_reg!(cur.origin, inc.origin, TaskOrigin);
        merge_reg!(cur.source, inc.source, Source);
        merge_occurrences(&mut cur.occurrences, &inc.occurrences);
        merge_deleted(&mut cur.deleted, inc.deleted.as_ref());
    }

    fn merge_event(&mut self, inc: &Event) {
        let cur = self.events.entry(inc.id.clone()).or_insert_with(|| Event { id: inc.id.clone(), ..Default::default() });
        merge_reg!(cur.name, inc.name, Str);
        merge_reg!(cur.start, inc.start, Str);
        merge_reg!(cur.end, inc.end, Str);
        merge_reg!(cur.weekdays, inc.weekdays, Weekdays);
        merge_reg!(cur.day, inc.day, Str);
        merge_reg!(cur.repeat, inc.repeat, Repeat);
        merge_reg!(cur.origin, inc.origin, TaskOrigin);
        merge_occurrences(&mut cur.occurrences, &inc.occurrences);
        merge_deleted(&mut cur.deleted, inc.deleted.as_ref());
    }

    fn merge_goal_period(&mut self, inc: &GoalPeriod) {
        match self.goal_periods.get_mut(&inc.id) {
            Some(c) => {
                let inc_bytes = inc.encode_to_vec();
                let cur_bytes = c.encode_to_vec();
                let deleted = c.deleted.clone();
                if is_newer(inc.stamp.as_ref(), &inc_bytes, c.stamp.as_ref(), &cur_bytes) {
                    *c = inc.clone();
                    c.deleted = deleted;
                }
                merge_deleted(&mut c.deleted, inc.deleted.as_ref());
            }
            None => {
                // Надгробие без метки — только id и `deleted`, иначе его
                // «попутные» поля зависели бы от порядка применения.
                let fresh = if inc.stamp.is_none() { GoalPeriod { id: inc.id.clone(), deleted: inc.deleted.clone(), ..Default::default() } } else { inc.clone() };
                self.goal_periods.insert(inc.id.clone(), fresh);
            }
        }
    }

    fn merge_list(&mut self, inc: &List) {
        let cur = self.lists.entry(inc.id.clone()).or_insert_with(|| List { id: inc.id.clone(), ..Default::default() });
        merge_reg!(cur.name, inc.name, Str);
        merge_reg!(cur.order, inc.order, I32);
        merge_deleted(&mut cur.deleted, inc.deleted.as_ref());
    }

    fn merge_day(&mut self, inc: &NutritionDay) {
        let cur = self.nutrition.entry(inc.day.clone()).or_insert_with(|| NutritionDay { day: inc.day.clone(), ..Default::default() });
        merge_reg!(cur.is_complete, inc.is_complete, Bool);
        merge_reg!(cur.fixed_goals, inc.fixed_goals, GoalSet);
        merge_reg!(cur.water_ml, inc.water_ml, U32);
        for e in &inc.entries {
            match cur.entries.iter_mut().find(|c| c.id == e.id) {
                Some(c) => {
                    let inc_bytes = e.encode_to_vec();
                    let cur_bytes = c.encode_to_vec();
                    let deleted = c.deleted.clone();
                    if is_newer(e.stamp.as_ref(), &inc_bytes, c.stamp.as_ref(), &cur_bytes) {
                        *c = e.clone();
                        c.deleted = deleted;
                    }
                    merge_deleted(&mut c.deleted, e.deleted.as_ref());
                }
                None => cur.entries.push(if e.stamp.is_none() { FoodEntry { id: e.id.clone(), deleted: e.deleted.clone(), ..Default::default() } } else { e.clone() }),
            }
        }
        cur.entries.sort_by(|a, b| a.id.cmp(&b.id));
    }

    /// Применить одно изменение (проверка значений внутри).
    pub fn apply_change(&mut self, c: &Change) -> Result<()> {
        match &c.change {
            Some(change::Change::Task(t)) => {
                check_task(t)?;
                self.merge_task(t);
            }
            Some(change::Change::Event(e)) => {
                check_event(e)?;
                self.merge_event(e);
            }
            Some(change::Change::List(l)) => {
                check_list(l)?;
                self.merge_list(l);
            }
            Some(change::Change::NutritionDay(d)) => {
                check_day(d)?;
                self.merge_day(d);
            }
            Some(change::Change::Settings(s)) => {
                check_settings(s)?;
                merge_reg!(self.settings, Some(s.clone()), Settings);
            }
            Some(change::Change::Goals(g)) => {
                check_goals(g)?;
                merge_reg!(self.goals, Some(g.clone()), GoalSet);
            }
            Some(change::Change::GoalPeriod(p)) => {
                check_goal_period(p)?;
                self.merge_goal_period(p);
            }
            Some(change::Change::Migration(_)) | None => {}
        }
        Ok(())
    }

    /// Применить операцию автора `author_device`: метки обязаны нести его
    /// устройство (D-16), иначе отказ на всю операцию. Негодные изменения
    /// пропускаются; возвращается число применённых.
    pub fn apply_op(&mut self, op: &PlannerOp, author_device: &str) -> Result<usize> {
        let stamps = op_stamps(op)?;
        if stamps.iter().any(|s| s.device_id != author_device) {
            return Err(ProtoError::ContextMismatch);
        }
        let mut applied = 0;
        for c in &op.changes {
            if self.apply_change(c).is_ok() {
                applied += 1;
            }
        }
        Ok(applied)
    }

    /// Слить снимок (идемпотентно).
    pub fn merge_snapshot(&mut self, s: &PlannerSnapshot) -> Result<()> {
        for t in &s.tasks {
            check_task(t)?;
            self.merge_task(t);
        }
        for e in &s.events {
            check_event(e)?;
            self.merge_event(e);
        }
        for l in &s.lists {
            check_list(l)?;
            self.merge_list(l);
        }
        for d in &s.nutrition {
            check_day(d)?;
            self.merge_day(d);
        }
        if let Some(st) = &s.settings {
            check_settings(st)?;
            merge_reg!(self.settings, Some(st.clone()), Settings);
        }
        if let Some(g) = &s.goals {
            check_goals(g)?;
            merge_reg!(self.goals, Some(g.clone()), GoalSet);
        }
        for p in &s.goal_periods {
            check_goal_period(p)?;
            self.merge_goal_period(p);
        }
        Ok(())
    }

    /// Снимок: все объекты с метками, включая надгробия.
    pub fn to_snapshot(&self) -> PlannerSnapshot {
        PlannerSnapshot {
            tasks: self.tasks.values().cloned().collect(),
            events: self.events.values().cloned().collect(),
            lists: self.lists.values().cloned().collect(),
            nutrition: self.nutrition.values().cloned().collect(),
            settings: self.settings.clone(),
            goals: self.goals.clone(),
            goal_periods: self.goal_periods.values().cloned().collect(),
        }
    }

    pub fn from_snapshot(s: &PlannerSnapshot) -> Result<Self> {
        let mut st = Self::default();
        st.merge_snapshot(s)?;
        Ok(st)
    }

    /// Размер открытого текста снимка (для предупреждения о потолке).
    pub fn size_estimate(&self) -> usize {
        self.to_snapshot().encoded_len()
    }
}

/// Все метки операции (для проверки автора и LamportGuard).
pub fn op_stamps(op: &PlannerOp) -> Result<Vec<Stamp>> {
    let mut out = Vec::new();
    let mut push = |s: Option<&LwwStamp>| -> Result<()> {
        if let Some(s) = s {
            out.push(Stamp::from_pb(Some(s))?);
        }
        Ok(())
    };
    for c in &op.changes {
        match &c.change {
            Some(change::Change::Task(t)) => {
                for s in [&t.name, &t.description, &t.status, &t.list_id, &t.day, &t.start, &t.due].into_iter().flatten() {
                    push(s.stamp.as_ref())?;
                }
                push(t.steps.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(t.rank.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(t.minutes.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(t.repeat.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(t.origin.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(t.source.as_ref().and_then(|f| f.stamp.as_ref()))?;
                for o in &t.occurrences {
                    push(o.stamp.as_ref())?;
                }
                push(t.deleted.as_ref())?;
            }
            Some(change::Change::Event(e)) => {
                for s in [&e.name, &e.start, &e.end, &e.day].into_iter().flatten() {
                    push(s.stamp.as_ref())?;
                }
                push(e.weekdays.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(e.repeat.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(e.origin.as_ref().and_then(|f| f.stamp.as_ref()))?;
                for o in &e.occurrences {
                    push(o.stamp.as_ref())?;
                }
                push(e.deleted.as_ref())?;
            }
            Some(change::Change::List(l)) => {
                push(l.name.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(l.order.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(l.deleted.as_ref())?;
            }
            Some(change::Change::NutritionDay(d)) => {
                push(d.is_complete.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(d.fixed_goals.as_ref().and_then(|f| f.stamp.as_ref()))?;
                push(d.water_ml.as_ref().and_then(|f| f.stamp.as_ref()))?;
                for e in &d.entries {
                    push(e.stamp.as_ref())?;
                    push(e.deleted.as_ref())?;
                }
            }
            Some(change::Change::Settings(s)) => push(s.stamp.as_ref())?,
            Some(change::Change::Goals(g)) => push(g.stamp.as_ref())?,
            Some(change::Change::GoalPeriod(p)) => {
                push(p.stamp.as_ref())?;
                push(p.deleted.as_ref())?;
            }
            Some(change::Change::Migration(_)) | None => {}
        }
    }
    if out.is_empty() {
        return Err(ProtoError::InvalidField("changes"));
    }
    Ok(out)
}

/// Проверить метки операции в порядке журнала (D-16).
pub fn guard_op(guard: &mut LamportGuard, op: &PlannerOp) -> Result<()> {
    for s in op_stamps(op)? {
        guard.check(&s)?;
    }
    Ok(())
}

/// Проставить одну метку всем присутствующим регистрам операции (локальная
/// правка: web присылает изменения без меток).
pub fn stamp_op(op: &mut PlannerOp, stamp: &Stamp) {
    let pb = stamp.to_pb();
    let st = |s: &mut Option<Str>| {
        if let Some(f) = s {
            f.stamp = Some(pb.clone());
        }
    };
    for c in &mut op.changes {
        match &mut c.change {
            Some(change::Change::Task(t)) => {
                for f in [&mut t.name, &mut t.description, &mut t.status, &mut t.list_id, &mut t.day, &mut t.start, &mut t.due] {
                    st(f);
                }
                if let Some(f) = &mut t.steps {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut t.rank {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut t.minutes {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut t.repeat {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut t.origin {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut t.source {
                    f.stamp = Some(pb.clone());
                }
                for o in &mut t.occurrences {
                    o.stamp = Some(pb.clone());
                }
                if t.deleted.is_some() {
                    t.deleted = Some(pb.clone());
                }
            }
            Some(change::Change::Event(e)) => {
                for f in [&mut e.name, &mut e.start, &mut e.end, &mut e.day] {
                    st(f);
                }
                if let Some(f) = &mut e.weekdays {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut e.repeat {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut e.origin {
                    f.stamp = Some(pb.clone());
                }
                for o in &mut e.occurrences {
                    o.stamp = Some(pb.clone());
                }
                if e.deleted.is_some() {
                    e.deleted = Some(pb.clone());
                }
            }
            Some(change::Change::List(l)) => {
                st(&mut l.name);
                if let Some(f) = &mut l.order {
                    f.stamp = Some(pb.clone());
                }
                if l.deleted.is_some() {
                    l.deleted = Some(pb.clone());
                }
            }
            Some(change::Change::NutritionDay(d)) => {
                if let Some(f) = &mut d.is_complete {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut d.fixed_goals {
                    f.stamp = Some(pb.clone());
                }
                if let Some(f) = &mut d.water_ml {
                    f.stamp = Some(pb.clone());
                }
                for e in &mut d.entries {
                    if e.deleted.is_some() {
                        e.deleted = Some(pb.clone());
                    } else {
                        e.stamp = Some(pb.clone());
                    }
                }
            }
            Some(change::Change::Settings(s)) => s.stamp = Some(pb.clone()),
            Some(change::Change::Goals(g)) => g.stamp = Some(pb.clone()),
            Some(change::Change::GoalPeriod(p)) => {
                if p.deleted.is_some() {
                    p.deleted = Some(pb.clone());
                } else {
                    p.stamp = Some(pb.clone());
                }
            }
            Some(change::Change::Migration(_)) | None => {}
        }
    }
}
