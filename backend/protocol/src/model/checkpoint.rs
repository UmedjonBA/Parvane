//! Сборка контрольной точки журнала истории моделью (spec 036 T006, пробел E2; HIST-2, S7-4).
//!
//! Раньше точку строил хост (web `v2/history.ts buildCheckpoint`, ядро `history_sync.cpp buildCheckpointLocked`);
//! теперь, когда строки и маркеры у модели (`model_rows()`), — модель, sans-IO: шаги — запросы с целью
//! [`Purpose::HistoryCp`], ход — по `tick`. Порядок шагов (как у web):
//!
//! 1. Срок: журнал прочитан (вход пройден), своей пачки в пути нет, точка не строится; после точки есть записи и
//!    либо их больше порога (первая точка — только так: короткий журнал новое устройство прочтёт целиком), либо
//!    точке больше суток. Срок наступил — случайная задержка 0…60 с (несколько устройств не строят разом).
//! 2. `history.head`: точку сменило другое устройство — её сводка (сверка S7-4), сегменты — основа следующей,
//!    срок пересчитывается от её времени. Курсор отстаёт от головы — сначала синк, сборка позже.
//! 3. Снимок: все состояния строк модели (с надгробиями) → `history::compact` (горизонт 180 суток) → сегменты по
//!    месяцу (≤ 150 КиБ); сегмент с тем же ключом и отпечатком (не `stale`) переходит прежним номером, остальные —
//!    `history.append` (chunk). Сводка чатов — последняя строка, маркер, непрочитанное, число строк.
//! 4. Ещё раз `history.head`; сводка называет свой номер `голова + 1` и id `ожидаемый + 1` (S7-4); номер записи
//!    сводки другой — журнал дописан, точка откладывается.
//! 5. `history.sync(после снимка, без сегментов)`: запись до сводки, которой не было в снимке, — точка
//!    откладывается (иначе обрезка сервера её бы удалила).
//! 6. `history.checkpoint.commit` (CAS по id): принят — учёт точки в `meta`; `DUPLICATE` — точку сменило другое
//!    устройство: она запрашивается (шаг 2 без сборки), повтора нет, пока новая точка не состарится.
//!
//! Здесь же — чтение журнала по точке и его защита (spec 036, перенос из web `v2/history.ts`):
//! - **замена истории точкой** (HIST-2 п. 3): при входе по точке (новое устройство, курсор ниже `upto` точки —
//!   журнал до неё обрезан сервером, откат) строки модели, которых в точке нет и чьё последнее событие старше её
//!   горизонта надгробий, снимаются — так уходят строки, удалённые давно (их надгробия точка уже выбросила). Свои
//!   неотправленные (очередь журнала, исходящее) не трогаются; устройство дольше горизонта без полной синхронизации
//!   (`history::needs_replace`) получает нотис `history_replaced`;
//! - **откат головы** (HIST-2 п. 4, S7-4): голова журнала в ответе меньше виденной (или курсора) — страница не
//!   применяется, нотис `history_rollback`, журнал перечитывается заново от точки сервера; очередь своих операций
//!   остаётся и уходит после перечитывания;
//! - **книга цепочек писателей** (S7-4): синк — `HistorySession::ingest_chained`, пропуск номера — нотис `history_gap`;
//!   вход по точке — отметки сводки (`adopt_summary`); своя точка несёт книгу в сводке (`chains`, `chains_complete`).
//!
//! Пока точка строится, свои пачки журнала ждут (иначе своя запись между снимком и сводкой откладывала бы точку).
//! Состояние сборки — в памяти: перезапуск посреди сборки начинает её заново (недособранные сегменты остаются в
//! журнале и уходят следующей точкой).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use std::collections::BTreeSet;

use super::paging::{self, Id};
use super::{Engine, Purpose, Work};
use crate::client::Chan;
use crate::codec::decode_checked;
use crate::error::Result;
use crate::history::{self, ChainBook, SummaryMeta};
use crate::limits::Origin;
use crate::pb::parvane::engine::v1::{self as epb, model_change::Change, MessageRemove};
use crate::pb::parvane::history::v1::{
    history_op::Op as HOp, AppendResponse, ChatSummary, Checkpoint, CommitResponse, HistoryOp, RowState, SegmentRef, Summary,
    SyncResponse,
};

/// Записей после точки, после которых она строится сразу (HIST-2 п. 1; web `CHECKPOINT_RECORDS`).
pub const CHECKPOINT_RECORDS: u64 = 5000;
/// Возраст точки, после которого строится следующая (web `CHECKPOINT_AGE_MS`).
pub const CHECKPOINT_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// Случайная задержка сборки после наступления срока (web `CHECKPOINT_JITTER_MS`).
pub const CHECKPOINT_JITTER_MS: i64 = 60_000;
/// Размер части сегмента (web `SEGMENT_PART_BYTES`): запись сегмента — одна запись журнала.
const SEGMENT_PART_BYTES: usize = 150 * 1024;
/// Отложенная (журнал дописан, отказ сервера) сборка — не раньше чем через это время.
const RETRY_MS: i64 = 60_000;
/// Сборка без ответа дольше этого — брошена (ответ потерян), следующая — по сроку.
const BUILD_TIMEOUT_MS: i64 = 10 * 60_000;
/// Код `ERROR_CODE_DUPLICATE` (CAS точки проигран).
const ERR_DUPLICATE: i32 = crate::pb::parvane::core::v2::ErrorCode::Duplicate as i32;

/// Сегмент точки в учёте устройства (как web `state.segments`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct SegMeta {
    pub key: String,
    #[serde(with = "super::hexser")]
    pub digest: Vec<u8>,
    pub seq: u64,
    #[serde(default, with = "super::hexser")]
    pub op_id: Vec<u8>,
}

impl SegMeta {
    fn of(r: &SegmentRef) -> Self {
        SegMeta { key: r.key.clone(), digest: r.digest.clone(), seq: r.seq, op_id: r.op_id.clone() }
    }
}

/// Учёт точки в `engine-core/meta` (id точки — `Meta.history_checkpoint`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct CpMeta {
    /// Наибольшая виденная голова журнала.
    #[serde(default)]
    pub head: u64,
    /// `upto_seq` текущей точки.
    #[serde(default)]
    pub upto: u64,
    /// Время создания текущей точки (мс): срок следующей.
    #[serde(default)]
    pub created_ms: i64,
    /// Сегменты текущей точки — неизменившиеся переходят в следующую.
    #[serde(default)]
    pub segments: Vec<SegMeta>,
    /// Сегменты, запечатанные не текущим ключом/адресом: следующая точка их перезаливает.
    #[serde(default)]
    pub stale: Vec<u64>,
    /// Следующая точка перезаливает все сегменты (ключ истории сменён этим устройством).
    #[serde(default)]
    pub force_reupload: bool,
    /// CAS проигран при этом id точки — не повторять, пока id не сменится.
    #[serde(default)]
    pub cas_failed_for: Option<u64>,
}

/// Шаг сборки (цель запроса).
#[derive(Debug, Clone)]
pub(crate) enum CpStep {
    /// `history.head`; `build` — дальше сборка, иначе только узнать точку (после проигранного CAS).
    Head { build: bool },
    /// Сводка чужой точки (`history.get [summary_seq]`).
    PeerSummary { cp: Checkpoint, build: bool },
    /// Запись сегмента: место в `refs`.
    Chunk { index: usize },
    /// Голова перед сводкой.
    HeadNow,
    /// Запись сводки.
    Summary,
    /// Сверка «журнал не дописан» (`history.sync` без сегментов).
    Check,
    /// `history.checkpoint.commit`.
    Commit,
}

/// Идущая сборка.
#[derive(Debug, Clone, Default)]
pub(crate) struct Build {
    started_ms: i64,
    /// Время снимка (горизонт и время точки).
    now_ms: i64,
    expected: u64,
    snapshot_cursor: u64,
    chats: Vec<ChatSummary>,
    refs: Vec<SegmentRef>,
    pending: usize,
    uploaded: usize,
    head_now: u64,
    summary_seq: u64,
    /// Книга цепочек на момент снимка.
    chains: ChainBook,
}

/// Сборка точки в памяти модели.
#[derive(Debug, Default)]
pub(crate) struct CpRuntime {
    /// Срок наступил — сборка не раньше этого времени (случайная задержка/повтор).
    due_at: Option<i64>,
    build: Option<Build>,
    /// Вход по точке: её сегменты и номера `stale` — в учёт, когда точка применена.
    pub seen: Option<(u64, Vec<SegmentRef>)>,
    pub seen_stale: Vec<u64>,
    /// Вход по точке: книга цепочек после сводки, строки точки (чат, id), горизонт сводки, курсор до входа.
    entry_chains: Option<ChainBook>,
    entry_targets: BTreeSet<(String, Id)>,
    entry_since: i64,
    entry_cursor: u64,
}

/// Время последнего события состояния строки (строка, удаление, правка, закреп, реакции, кандидаты).
fn last_event_ms(s: &RowState) -> i64 {
    let mut t = s.row.as_ref().map_or(i64::MIN, |r| r.ts_ms);
    let stamps = s
        .gone
        .iter()
        .chain(s.pending_gones.iter())
        .filter_map(|g| g.stamp.as_ref())
        .chain(s.edit_stamp.iter())
        .chain(s.pending_edits.iter().filter_map(|e| e.stamp.as_ref()))
        .chain(s.pin_stamp.iter())
        .chain(s.reacts.iter().filter_map(|r| r.stamp.as_ref()));
    for st in stamps {
        t = t.max(st.ts_ms);
    }
    t
}

impl Engine {
    fn cp_age_ms(&self) -> i64 {
        match self.cfg.history_checkpoint_age_ms {
            0 => CHECKPOINT_AGE_MS,
            v => v.min(i64::MAX as u64) as i64,
        }
    }

    fn cp_records(&self) -> u64 {
        match self.cfg.history_checkpoint_records {
            0 => CHECKPOINT_RECORDS,
            v => u64::from(v),
        }
    }

    fn cp_jitter_ms(&self) -> i64 {
        match self.cfg.history_checkpoint_jitter_ms {
            0 => CHECKPOINT_JITTER_MS,
            v => i64::from(v),
        }
    }

    /// Точка строится: свои пачки журнала ждут.
    pub(crate) fn cp_building(&self) -> bool {
        self.cp.build.is_some()
    }

    /// Голова журнала из ответа сервера.
    pub(crate) fn cp_note_head(&mut self, head: u64) {
        if head > self.meta.history_cp.head {
            self.meta.history_cp.head = head;
            self.dirty.meta = true;
        }
    }

    /// Точка применена при входе (сводка и сегменты): её учёт — основа следующей.
    pub(crate) fn cp_adopt_entered(&mut self, cp: &Checkpoint) {
        let seen = self.cp.seen.take().filter(|(id, _)| *id == cp.id).map(|(_, refs)| refs).unwrap_or_default();
        let m = &mut self.meta.history_cp;
        m.upto = cp.upto_seq;
        m.created_ms = cp.created_ms;
        m.segments = seen.iter().map(SegMeta::of).collect();
        m.stale = std::mem::take(&mut self.cp.seen_stale);
        m.cas_failed_for = None;
        m.head = m.head.max(cp.upto_seq);
        self.dirty.meta = true;
    }

    /// Срок точки (без случайной задержки).
    fn cp_due(&self) -> bool {
        // Журнал прочитан хотя бы раз (как у пачек: курсор либо пройденный вход)
        let read_once = self.meta.history_cursor > 0 || self.meta.history_bootstrapped;
        if !self.model_rows() || !read_once || self.cp.build.is_some() {
            return false;
        }
        let m = &self.meta.history_cp;
        let id = self.meta.history_checkpoint;
        if m.cas_failed_for == Some(id) {
            return false;
        }
        // Своя пачка в пути: её запись легла бы между снимком и сводкой
        if self.inflight.values().any(|p| matches!(p, Purpose::HistoryAppend)) {
            return false;
        }
        let after = m.head.saturating_sub(m.upto);
        if after == 0 {
            return false;
        }
        if m.force_reupload || after > self.cp_records() {
            return true;
        }
        // Первой точки нет: короткий журнал новое устройство прочтёт целиком — первая только по числу записей
        id != 0 && self.now_ms.saturating_sub(m.created_ms) >= self.cp_age_ms()
    }

    /// Ход по `tick`: срок → задержка → `history.head`.
    pub(crate) fn checkpoint_tick(&mut self, w: &mut Work) {
        if let Some(b) = &self.cp.build {
            if self.now_ms - b.started_ms > BUILD_TIMEOUT_MS {
                self.cp_postpone("timeout", w);
            }
            return;
        }
        if !self.cp_due() {
            if self.cp.due_at.is_some_and(|t| self.now_ms >= t) {
                self.cp.due_at = None;
            }
            return;
        }
        let at = match self.cp.due_at {
            Some(t) => t,
            None => {
                let span = self.cp_jitter_ms().max(0) as u64;
                let t = self.now_ms + (rand::random::<u64>() % (span + 1)) as i64;
                self.cp.due_at = Some(t);
                t
            }
        };
        if self.now_ms < at || self.history_session().is_none() {
            return;
        }
        self.cp.due_at = None;
        self.cp.build = Some(Build { started_ms: self.now_ms, ..Default::default() });
        self.cp_head(true, w);
    }

    fn cp_req(&mut self, method: &'static str, body: Vec<u8>, step: CpStep, w: &mut Work) {
        let r = crate::client::OutRequest { chan: Chan::Id, method, body, dest: None };
        self.push_req(w, r, Purpose::HistoryCp(step));
    }

    fn cp_head(&mut self, build: bool, w: &mut Work) {
        let Some(body) = self.history_session().map(|s| s.head_request()) else { return };
        self.cp_req("history.head", body, CpStep::Head { build }, w);
    }

    /// Сборка отложена: следующая попытка не раньше `RETRY_MS`.
    fn cp_postpone(&mut self, why: &str, w: &mut Work) {
        self.cp.build = None;
        self.cp.due_at = Some(self.now_ms + RETRY_MS);
        w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "history_checkpoint_postponed".into(), detail: why.into() }));
        // Пачки, ждавшие сборку, — по своему сроку
    }

    /// Ответ на шаг сборки.
    pub(crate) fn checkpoint_response(&mut self, step: CpStep, error: i32, body: &[u8], w: &mut Work) -> Result<()> {
        let building = matches!(step, CpStep::Head { build: true } | CpStep::PeerSummary { build: true, .. }) || !matches!(step, CpStep::Head { .. } | CpStep::PeerSummary { .. });
        if building && self.cp.build.is_none() {
            return Ok(()); // сборка брошена (тайм-аут), запоздалый ответ
        }
        if error != 0 && !matches!(step, CpStep::Commit) {
            if building {
                self.cp_postpone("server_error", w);
            }
            return Ok(());
        }
        match step {
            CpStep::Head { build } => {
                let Some(s) = self.history_session() else { return Ok(()) };
                let h = s.ingest_head(body)?;
                if h.head_seq < self.meta.history_cursor {
                    // Голова меньше курсора — откат сервера: сборку отложить, чтение журнала его заметит
                    if build {
                        self.cp_postpone("rollback", w);
                    }
                    self.history_pull(w);
                    return Ok(());
                }
                self.cp_note_head(h.head_seq);
                match h.checkpoint.filter(|c| c.upto_seq > 0) {
                    Some(cp) if cp.id != self.meta.history_checkpoint => {
                        // Точку сменило другое устройство: её сводка — сегменты основы следующей
                        let Some(body) = self.history_session().and_then(|s| s.get_request(vec![cp.summary_seq]).ok()) else { return Ok(()) };
                        self.cp_req("history.get", body, CpStep::PeerSummary { cp, build }, w);
                    }
                    _ if build => self.cp_snapshot(h.head_seq, w),
                    _ => {}
                }
            }
            CpStep::PeerSummary { cp, build } => {
                let Some(s) = self.history_session() else { return Ok(()) };
                let ing = s.ingest(body)?;
                let summary = ing.ops.iter().find_map(|o| match &o.op {
                    Some(HOp::Summary(x)) => Some(x.clone()),
                    _ => None,
                });
                // Сводка не сходится с точкой (S7-4) или не прочитана — её сегменты не берём: следующая точка
                // перезальёт всё
                let segs = summary.filter(|x| history::verify_checkpoint(&cp, x).is_ok()).map(|x| x.segments).unwrap_or_default();
                self.meta.history_checkpoint = cp.id;
                let m = &mut self.meta.history_cp;
                m.upto = cp.upto_seq;
                m.created_ms = cp.created_ms;
                m.segments = segs.iter().map(SegMeta::of).collect();
                m.stale.clear();
                m.cas_failed_for = None;
                m.head = m.head.max(cp.upto_seq);
                self.dirty.meta = true;
                if build {
                    // Срок — от новой точки
                    self.cp.build = None;
                    if self.cp_due() {
                        self.cp.build = Some(Build { started_ms: self.now_ms, ..Default::default() });
                        self.cp_head(true, w);
                    }
                }
            }
            CpStep::Chunk { index } => {
                let r: AppendResponse = decode_checked(body, Origin::Server)?;
                let Some(b) = self.cp.build.as_mut() else { return Ok(()) };
                if let Some(x) = b.refs.get_mut(index) {
                    x.seq = r.seq;
                }
                b.pending = b.pending.saturating_sub(1);
                if b.pending == 0 {
                    let Some(body) = self.history_session().map(|s| s.head_request()) else { return Ok(()) };
                    self.cp_req("history.head", body, CpStep::HeadNow, w);
                }
            }
            CpStep::HeadNow => {
                let Some(s) = self.history_session() else { return Ok(()) };
                let h = s.ingest_head(body)?;
                self.cp_note_head(h.head_seq);
                self.cp_seal_summary(h.head_seq, w);
            }
            CpStep::Summary => {
                let r: AppendResponse = decode_checked(body, Origin::Server)?;
                let Some(b) = self.cp.build.as_mut() else { return Ok(()) };
                if r.seq != b.head_now + 1 {
                    // S7-4: сводка названа другим номером — журнал дописан во время сборки
                    self.cp_postpone("journal_moved", w);
                    return Ok(());
                }
                b.summary_seq = r.seq;
                let after = b.snapshot_cursor;
                let Some(body) = self.history_session().map(|s| s.sync_request(after, true, 0)) else { return Ok(()) };
                self.cp_req("history.sync", body, CpStep::Check, w);
            }
            CpStep::Check => {
                // Все записи (и нечитаемые): любая до сводки, которой не было в снимке, ушла бы под обрезку
                let r: SyncResponse = decode_checked(body, Origin::Server)?;
                let Some(b) = self.cp.build.clone() else { return Ok(()) };
                if r.records.iter().any(|x| !x.chunk && x.seq <= b.summary_seq) {
                    self.cp_postpone("journal_moved", w);
                    return Ok(());
                }
                let chunk_seqs: Vec<u64> = b.refs.iter().map(|x| x.seq).collect();
                let Some(body) = self.history_session().and_then(|s| s.commit_request(b.expected, b.summary_seq, b.summary_seq, chunk_seqs).ok()) else {
                    self.cp_postpone("commit_request", w);
                    return Ok(());
                };
                self.cp_req("history.checkpoint.commit", body, CpStep::Commit, w);
            }
            CpStep::Commit => {
                let Some(b) = self.cp.build.take() else { return Ok(()) };
                if error == ERR_DUPLICATE {
                    // Точку уже сменило другое устройство: не повторять, пока не придёт новая — узнать её
                    self.meta.history_cp.cas_failed_for = Some(b.expected);
                    self.dirty.meta = true;
                    w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "history_checkpoint_cas_failed".into(), detail: b.expected.to_string() }));
                    self.cp_head(false, w);
                    return Ok(());
                }
                if error != 0 {
                    self.cp.build = Some(b);
                    self.cp_postpone("server_error", w);
                    return Ok(());
                }
                let r: CommitResponse = decode_checked(body, Origin::Server)?;
                self.meta.history_checkpoint = r.checkpoint_id;
                self.meta.history_cursor = self.meta.history_cursor.max(b.summary_seq);
                let m = &mut self.meta.history_cp;
                m.upto = b.summary_seq;
                m.created_ms = b.now_ms;
                m.segments = b.refs.iter().map(SegMeta::of).collect();
                m.stale.clear();
                m.force_reupload = false;
                m.cas_failed_for = None;
                m.head = m.head.max(b.summary_seq);
                self.dirty.meta = true;
                w.delta.push(Change::Notice(epb::Notice {
                    chat: None,
                    kind: "history_checkpoint_built".into(),
                    detail: format!("{} segments={} uploaded={}", r.checkpoint_id, b.refs.len(), b.uploaded),
                }));
            }
        }
        Ok(())
    }

    /// Снимок строк и маркеров → сегменты (неизменившиеся — прежним номером, остальные — запись).
    fn cp_snapshot(&mut self, head: u64, w: &mut Work) {
        if self.meta.history_cursor < head {
            // Журнал прочитан не до головы: сначала синк, сборка — позже
            self.cp_postpone("behind_head", w);
            self.history_pull(w);
            return;
        }
        let now = self.now_ms;
        let all: Vec<RowState> = self.chats.values().flat_map(|c| c.rows().map(|r| r.state.clone())).collect();
        let states = match history::compact(&all, now) {
            Ok(s) => s,
            Err(_) => return self.cp_postpone("compact", w),
        };
        let chats = self.cp_summarize(&states);
        let parts = match split_segments(&states) {
            Ok(p) => p,
            Err(_) => return self.cp_postpone("segments", w),
        };
        let m = &self.meta.history_cp;
        let force = m.force_reupload;
        let prev: BTreeMap<(String, Vec<u8>), SegMeta> =
            m.segments.iter().filter(|s| !m.stale.contains(&s.seq)).map(|s| ((s.key.clone(), s.digest.clone()), s.clone())).collect();
        let mut refs = vec![];
        let mut uploads: Vec<(usize, Vec<u8>)> = vec![];
        for (key, part) in parts {
            let Ok(digest) = history::segment_digest(&part) else { return self.cp_postpone("segments", w) };
            if let Some(p) = prev.get(&(key.clone(), digest.to_vec())).filter(|_| !force) {
                refs.push(SegmentRef { key, digest: digest.to_vec(), seq: p.seq, op_id: p.op_id.clone() });
                continue;
            }
            let ops: Vec<HistoryOp> = part.into_iter().map(|s| HistoryOp { op: Some(HOp::State(s)) }).collect();
            let Some(Ok(sealed)) = self.history_session().map(|s| s.seal(ops, true, now)) else { return self.cp_postpone("seal", w) };
            let many = sealed.len() > 1;
            for (i, (op_id, body)) in sealed.into_iter().enumerate() {
                // Не уместилось в одну запись: части с ключом `~i` и пустым отпечатком (32 нуля) — не переиспользуются
                let (k, d) = if many { (format!("{key}~{i}"), vec![0u8; 32]) } else { (key.clone(), digest.to_vec()) };
                uploads.push((refs.len(), body));
                refs.push(SegmentRef { key: k, digest: d, seq: 0, op_id: op_id.to_vec() });
            }
        }
        let expected = self.meta.history_checkpoint;
        let chains_now = self.chain_book();
        let Some(b) = self.cp.build.as_mut() else { return };
        b.now_ms = now;
        b.expected = expected;
        b.chains = chains_now;
        b.snapshot_cursor = self.meta.history_cursor;
        b.chats = chats;
        b.pending = uploads.len();
        b.uploaded = uploads.len();
        b.refs = refs;
        if uploads.is_empty() {
            let Some(body) = self.history_session().map(|s| s.head_request()) else { return };
            self.cp_req("history.head", body, CpStep::HeadNow, w);
            return;
        }
        for (index, body) in uploads {
            let r = crate::client::OutRequest { chan: Chan::Id, method: "history.append", body, dest: None };
            self.push_req(w, r, Purpose::HistoryCp(CpStep::Chunk { index }));
        }
    }

    /// Сводка: позиция `голова + 1`, id `ожидаемый + 1` (S7-4) → запись сводки.
    fn cp_seal_summary(&mut self, head_now: u64, w: &mut Work) {
        let Some(b) = self.cp.build.as_mut() else { return };
        b.head_now = head_now;
        let chains = b.chains.clone();
        // Книга цепочек автора (S7-4): читатели точки проверяют по ней пропуски записей после точки
        let meta = SummaryMeta { upto_seq: head_now + 1, checkpoint_id: b.expected + 1, chains };
        let since = b.now_ms.saturating_sub(history::HORIZON_MS);
        let (chats, refs, now) = (b.chats.clone(), b.refs.clone(), b.now_ms);
        let Ok(op) = history::summary(chats, refs, since, &meta) else { return self.cp_postpone("summary", w) };
        let Some(Ok(sealed)) = self.history_session().map(|s| s.seal(vec![op], true, now)) else { return self.cp_postpone("seal", w) };
        let [(_, body)] = <[_; 1]>::try_from(sealed).unwrap_or_else(|_| [([0u8; 16], vec![])]);
        if body.is_empty() {
            return self.cp_postpone("summary", w);
        }
        self.cp_req("history.append", body, CpStep::Summary, w);
    }

    /// Сводка чатов (web `summarizeChats`): по чату — последняя видимая строка, маркер, непрочитанное, число
    /// состояний в точке; чаты только с маркером — тоже.
    fn cp_summarize(&self, states: &[RowState]) -> Vec<ChatSummary> {
        let mut by_chat: BTreeMap<String, ChatSummary> = BTreeMap::new();
        for s in states {
            let Some(p) = s.chat.as_ref() else { continue };
            let Ok(key) = history::history_chat_key(p) else { continue };
            let e = by_chat.entry(key).or_insert_with(|| ChatSummary { chat: Some(p.clone()), ..Default::default() });
            e.rows += 1;
            let Some(row) = s.row.as_ref().filter(|r| s.gone.is_none() && !r.body.is_empty()) else { continue };
            let newer = match e.last.as_ref().and_then(|l| l.row.as_ref()) {
                None => true,
                Some(l) => (row.ts_ms, &row.id) > (l.ts_ms, &l.id),
            };
            if newer {
                e.last = Some(s.clone());
            }
        }
        for (key, m) in &self.marks {
            let e = by_chat.entry(key.clone()).or_insert_with(|| ChatSummary { chat: m.chat.clone(), ..Default::default() });
            e.mark = Some(m.clone());
        }
        for (key, e) in by_chat.iter_mut() {
            e.unread = self.unread_of(key).0;
        }
        by_chat.into_values().filter(|c| c.chat.is_some()).collect()
    }
}

impl Engine {
    /// Книга цепочек журнала (из `meta`). Её ещё нет: журнал виден с начала (курсор 0, точки не было) — полная.
    pub(crate) fn chain_book(&self) -> ChainBook {
        if self.meta.history_chains.is_object() {
            if let Ok(b) = ChainBook::from_value(&self.meta.history_chains) {
                return b;
            }
        }
        ChainBook { complete: self.meta.history_cursor == 0 && self.meta.history_checkpoint == 0, ..Default::default() }
    }

    /// Голова журнала из ответа чтения: меньше виденной (или курсора) — откат сервера (HIST-2 п. 4, S7-4).
    pub(crate) fn history_head_ok(&mut self, head: u64, w: &mut Work) -> bool {
        let known = self.meta.history_cp.head.max(self.meta.history_cursor);
        if head_seq_rolled_back(head, known) {
            self.history_rollback(head, known, w);
            return false;
        }
        true
    }

    /// Откат: страница не применяется; журнал перечитывается заново (голова → точка → синк), учёт точки и книга
    /// цепочек — с нуля. Очередь своих операций и строки модели остаются: своё уйдёт после перечитывания, строки,
    /// которых нет в точке сервера и которые старше её горизонта, снимет вход по точке.
    fn history_rollback(&mut self, head: u64, known: u64, w: &mut Work) {
        w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "history_rollback".into(), detail: format!("{head} < {known}") }));
        let force = self.meta.history_cp.force_reupload;
        self.meta.history_cp = CpMeta { force_reupload: force, ..Default::default() };
        self.meta.history_cursor = 0;
        self.meta.history_checkpoint = 0;
        self.meta.history_bootstrapped = false;
        self.meta.history_chains = serde_json::Value::Null;
        self.dirty.meta = true;
        self.cp.build = None;
        self.cp.due_at = None;
        self.cp.seen = None;
        self.cp.entry_chains = None;
        self.history_pull(w);
    }

    /// Сводка точки принята (сверка S7-4 пройдена): сегменты и книга цепочек — в учёт по окончании входа, строки
    /// сводки — цели точки.
    pub(crate) fn cp_entry_begin(&mut self, cp: &Checkpoint, summary: &Summary) {
        self.cp.seen = Some((cp.id, summary.segments.clone()));
        self.cp.seen_stale.clear();
        let mut book = self.chain_book();
        book.adopt_summary(summary);
        self.cp.entry_chains = Some(book);
        self.cp.entry_targets.clear();
        self.cp.entry_since = summary.tombstones_since_ms;
        self.cp.entry_cursor = self.meta.history_cursor;
        let lasts: Vec<HistoryOp> = summary.chats.iter().filter_map(|c| c.last.clone()).map(|l| HistoryOp { op: Some(HOp::State(l)) }).collect();
        self.cp_entry_note(&lasts);
    }

    /// Строки точки (сводка, сегменты).
    pub(crate) fn cp_entry_note(&mut self, ops: &[HistoryOp]) {
        for op in ops {
            let Some((target, chat)) = history::op_target(op) else { continue };
            let Some(key) = chat.as_ref().and_then(|p| history::history_chat_key(p).ok()) else { continue };
            if let Some(id) = paging::id16(target) {
                self.cp.entry_targets.insert((key, id));
            }
        }
    }

    /// Точка применена целиком: книга цепочек — от сводки; замена истории точкой (HIST-2 п. 3).
    pub(crate) fn cp_entry_done(&mut self, w: &mut Work) {
        if let Some(b) = self.cp.entry_chains.take() {
            self.meta.history_chains = b.to_value();
        }
        let targets = std::mem::take(&mut self.cp.entry_targets);
        let since = self.cp.entry_since;
        let replace = history::needs_replace(self.meta.history_last_full_ms, since, self.cp.entry_cursor, self.meta.history_cp.upto);
        let removed = self.cp_sweep(&targets, since, w);
        if removed > 0 || (replace && self.cp.entry_cursor > 0) {
            w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "history_replaced".into(), detail: removed.to_string() }));
        }
        if replace {
            // Точка принята как полная история: следующая замена — только после новой разлуки дольше горизонта
            self.meta.history_last_full_ms = self.now_ms;
        }
    }

    /// Снять строки, которых в точке нет и чьё последнее событие старше горизонта `since` (кроме своих
    /// неотправленных). Возвращает число снятых.
    fn cp_sweep(&mut self, targets: &BTreeSet<(String, Id)>, since: i64, w: &mut Work) -> usize {
        if since <= 0 {
            return 0; // сводка прежнего вида без горизонта
        }
        let queued: BTreeSet<Id> = self.history_queue.iter().filter_map(|op| history::op_target(op).and_then(|(t, _)| paging::id16(t))).collect();
        let mut gone: Vec<(String, Id)> = vec![];
        for (chat, rows) in &self.chats {
            for (id, r) in rows.iter_ids() {
                let key = (chat.clone(), *id);
                if targets.contains(&key) || queued.contains(id) || self.outbox.contains_key(id) {
                    continue;
                }
                if last_event_ms(&r.state) < since {
                    gone.push(key);
                }
            }
        }
        for (chat, id) in &gone {
            let Some(row) = self.chats.get_mut(chat).and_then(|c| c.remove(id)) else { continue };
            self.dirty.rows_gone.insert((chat.clone(), *id));
            self.dirty.chats.insert(chat.clone());
            if row.shown.is_some() || row.visible() {
                let peer = row.state.chat.clone().or_else(|| self.peers.get(chat).cloned());
                w.delta.push(Change::MessageRemove(MessageRemove { chat: peer, id: id.to_vec() }));
            }
        }
        gone.len()
    }
}

/// Откат журнала: голова сервера меньше уже виденной (или курсора устройства).
fn head_seq_rolled_back(head_seq: u64, known: u64) -> bool {
    head_seq < known
}

/// Части сегментов: ключ месяца (`history::segment_key`), состояния по `target`, часть ≤ 150 КиБ (`key#i`).
fn split_segments(states: &[RowState]) -> Result<Vec<(String, Vec<RowState>)>> {
    use prost::Message as _;
    let mut by_key: BTreeMap<String, Vec<RowState>> = BTreeMap::new();
    for s in states {
        by_key.entry(history::segment_key(s)?).or_default().push(s.clone());
    }
    let mut parts = vec![];
    for (key, mut list) in by_key {
        list.sort_by(|a, b| a.target.cmp(&b.target));
        let (mut cur, mut size, mut index) = (vec![], 0usize, 0usize);
        for s in list {
            let len = s.encoded_len();
            if !cur.is_empty() && size + len > SEGMENT_PART_BYTES {
                parts.push((if index == 0 { key.clone() } else { format!("{key}#{index}") }, std::mem::take(&mut cur)));
                index += 1;
                size = 0;
            }
            cur.push(s);
            size += len;
        }
        if !cur.is_empty() {
            parts.push((if index == 0 { key.clone() } else { format!("{key}#{index}") }, cur));
        }
    }
    Ok(parts)
}
