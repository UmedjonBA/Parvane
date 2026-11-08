//! Разовый перенос в модели движка (spec 035, US1, contracts/migration.md «Порядок разового переноса», точки M1–M6).
//!
//! Хост открывает движок с `legacy_present`; нет корня нового хранилища (или перенос прерван до переключения) —
//! `open` → `MIGRATION_NEEDED`. Дальше:
//! 1. `migrateStep{layer, records, last}` — записи старых хранилищ частями (`migrate::collect`); после `last` —
//!    точка **M1** (старое прочитано, на диск — корень нового хранилища и отметка хода);
//! 2. `migrateStep{}` — следующая часть поколения 1: экспорт движка прежней версии (`Client::import`), строки
//!    истории частями по `chunk`, маркеры, старое исходящее, карантин — **M2** после первой части;
//! 3. сеть: `state.ops.sync` нового журнала (есть `Migrated` — перенос сделало другое устройство, свой не пишется),
//!    `state.sync` замороженного журнала до головы → операции `state.v2` (`migrate::state_v1`, детерминированные op_id и
//!    шифртекст) в `state-raw` и `state.ops.append` — **M3**; когда все приняты — `Migrated{from_seq}` — **M4**;
//!    неотправленные операции старой версии — новыми операциями после неё; подписки на группы чужих серверов
//!    (`group.remote.subscribe`, T078); группы, где пользователь — админ и фото частной группы лежит со старым
//!    открытым секретом, — `needs{group_avatar_reupload}` хосту (перезалить с новым секретом под эпохой, FR-071);
//! 4. сверка выгрузок «до» (из старых записей) и «после» (из нового состояния) — **M5**, расхождение — перенос
//!    останавливается до переключения (старое не трогается), причины в `migrateStatus`;
//! 5. переключение — **M6**: `open` → `READY` с шагом `mark-legacy`; хост помечает старые хранилища «перенесено»
//!    и вызывает `migrateFinish` (точка 7). Удаляет старое только пользователь (D2).
//!
//! Прерывание в любой точке: следующий запуск снова `MIGRATION_NEEDED`, перенос идёт с начала — он идемпотентен
//! (записи поколения 1 те же, операции журнала те же байты — сервер отдаёт прежний seq), неподтверждённые операции
//! из `state-raw` уходят повторно.

use std::collections::BTreeSet;

use prost::Message;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Engine, Purpose, Work};
use crate::client::Client;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::migrate::{self, audit, quarantine, state_v1, Layer, Legacy, LegacyRecord as MRecord, Report};
use crate::pb::parvane::engine::v1::{self as epb, model_change::Change, MigrateStep, MigrationPlan, OpenResult, OpenState, Outcome};
use crate::pb::parvane::state::v1 as v1;
use crate::pb::parvane::state::v2 as s2;
use crate::store::Store;

/// Имя записи хода переноса (вид `migration-progress`; ход переноса поколения — `rotation`).
pub const PROGRESS_NAME: &str = "legacy";
/// Имя записи старого исходящего (вид `outbox`).
pub const LEGACY_OUTBOX: &str = "legacy";
/// Строк истории в части поколения 1 по умолчанию.
pub const CHUNK_DEFAULT: usize = 1000;

/// Точки переноса (contracts/migration.md).
pub const M1: u32 = 1;
pub const M2: u32 = 2;
pub const M3: u32 = 3;
pub const M4: u32 = 4;
pub const M5: u32 = 5;
pub const M6: u32 = 6;
/// Старые хранилища помечены «перенесено» (`migrateFinish`).
pub const DONE: u32 = 7;

/// Ход переноса на диске.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Progress {
    pub point: u32,
    #[serde(default)]
    pub layer: String,
    #[serde(default)]
    pub report: Report,
}

impl Progress {
    pub fn from_bytes(b: &[u8]) -> Option<Progress> {
        serde_json::from_slice(b).ok()
    }
}

/// План переноса для `OpenResult`.
pub fn plan(p: Option<&Progress>) -> MigrationPlan {
    let point = p.map(|p| p.point).unwrap_or(0);
    let mut steps = vec![];
    if point < M6 {
        steps.extend(["read-legacy", "write-generation", "state-journal", "remote-groups", "audit", "switch"].map(String::from));
    }
    steps.push("mark-legacy".into());
    MigrationPlan { steps, legacy_records: p.map(|p| p.report.counts.values().sum()).unwrap_or(0) }
}

/// После открытия существующего профиля: (нужен ли перенос, план) либо `None` — переноса не было или он закончен.
pub fn plan_after_open(p: Option<&Progress>, legacy_present: bool) -> Option<(bool, MigrationPlan)> {
    let p = p?;
    if p.point >= DONE {
        return None;
    }
    if p.point >= M6 {
        return Some((false, plan(Some(p))));
    }
    legacy_present.then(|| (true, plan(Some(p))))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Хост отдаёт записи.
    Collect,
    /// Пишется поколение 1 частями.
    Local,
    /// Ждём `state.ops.sync` нового журнала.
    V2Sync,
    /// Ждём `state.sync` замороженного журнала.
    V1Sync,
    /// Операции переноса отправлены — ждём приёма всех.
    Appending,
    /// `Migrated` отправлена.
    Migrated,
    /// M4 записана — следующий шаг: сверка.
    Journaled,
    /// M5 записана — следующий шаг: переключение.
    Audited,
    /// Переключено (или остановлено ошибкой сверки).
    Done,
}

/// Идущий перенос.
pub struct MigrationRun {
    layer: Layer,
    records: Vec<MRecord>,
    legacy: Legacy,
    phase: Phase,
    point: u32,
    chunk: usize,
    /// Строки, ещё не записанные в поколение 1.
    rows_left: Vec<(String, Vec<u8>)>,
    v1_records: Vec<v1::StateRecord>,
    v1_cursor: u64,
    /// Операции старого журнала (открытые) и голова.
    v1_ops: Vec<v1::StateOp>,
    v1_head: u64,
    /// Перенос журнала уже сделан (в новом журнале есть `Migrated`).
    already: bool,
    /// hex op_id операций переноса, ещё не принятых сервером.
    pending: BTreeSet<String>,
    migrated: Option<(String, Vec<u8>)>,
    /// Снимок личного состояния «до» (старое правило; с неотправленным) для сверки.
    before_state: Option<v1::StateSnapshot>,
    report: Report,
}

impl Engine {
    fn progress_put(&mut self, point: u32, report: &Report, layer: &str) {
        let p = Progress { point, layer: layer.to_string(), report: report.clone() };
        self.dirty.extra.push(("migration-progress".into(), PROGRESS_NAME.into(), serde_json::to_vec(&p).unwrap_or_default()));
        self.migration_progress = Some(p);
    }

    fn layer_name(l: Layer) -> &'static str {
        match l {
            Layer::Web => "web",
            Layer::Core => "core",
            Layer::Android => "android",
        }
    }

    /// `migrateStep`: записи старых хранилищ, затем — следующий шаг переноса.
    pub fn migrate_step(&mut self, a: MigrateStep) -> Result<Outcome> {
        if self.open_state != OpenState::MigrationNeeded {
            return Err(ProtoError::InvalidField("migration"));
        }
        let mut w = Work::default();
        if self.migration.is_none() {
            let layer = Layer::parse(&a.layer).ok_or(ProtoError::InvalidField("layer"))?;
            self.migration = Some(Box::new(MigrationRun {
                layer,
                records: vec![],
                legacy: Legacy::default(),
                phase: Phase::Collect,
                point: 0,
                chunk: CHUNK_DEFAULT,
                rows_left: vec![],
                v1_records: vec![],
                v1_cursor: 0,
                v1_ops: vec![],
                v1_head: 0,
                already: false,
                pending: BTreeSet::new(),
                migrated: None,
                before_state: None,
                report: Report::default(),
            }));
        }
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        if a.chunk > 0 {
            run.chunk = a.chunk as usize;
        }
        if run.phase == Phase::Collect {
            run.records.extend(a.records.into_iter().map(|r| MRecord { key: r.key, value: r.value }));
            if a.last {
                self.migrate_collected(&mut w)?;
            }
        } else {
            self.migrate_advance(&mut w)?;
        }
        self.finish(w)
    }

    /// M1: всё прочитано — разобрать, создать хранилище (если нет), импортировать движок прежней версии.
    fn migrate_collected(&mut self, w: &mut Work) -> Result<()> {
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        let records = std::mem::take(&mut run.records);
        let layer = run.layer;
        let legacy = migrate::collect(layer, &records, &self.cfg.domain);
        drop(records);
        if self.store.is_none() {
            let mut st = Store::create();
            let key: [u8; 32] = self.cfg.device_key.as_slice().try_into().map_err(|_| ProtoError::InvalidField("device_key"))?;
            let batch = st.wrap_device(&key)?;
            self.store = Some(st);
            self.pending_root = Some(batch);
        }
        // Движок прежней версии: ключи, сессии, журналы устройств и групп, «План», «Облако»
        let client = match (&legacy.engine_blob, &legacy.engine_key) {
            (Some(blob), Some(key)) => match Client::import(blob, key) {
                Ok(c) => c,
                Err(_) => {
                    let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
                    run.report.errors.push("engine-state: не открылся ключом экспорта".into());
                    run.legacy = legacy;
                    let rep = self.migration_report();
                    self.progress_put(0, &rep, Self::layer_name(layer));
                    return Err(ProtoError::Crypto);
                }
            },
            (Some(_), None) => {
                let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
                run.report.errors.push("engine-state: нет ключа экспорта".into());
                return Err(ProtoError::NotFound);
            }
            _ => Client::new(&self.cfg.user, &self.cfg.device_id, &self.cfg.domain)?,
        };
        if client.user != self.cfg.user {
            return Err(ProtoError::ContextMismatch);
        }
        self.client = Some(client);
        self.history_session = None;
        self.dirty.client = true;
        self.dirty.meta = true;
        // Новое состояние строится заново (повторный перенос после прерывания — с начала)
        self.chats.clear();
        self.marks.clear();
        self.state = crate::state2::State2::new();
        self.meta = Default::default();
        self.dirty.state = true;
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        run.rows_left = legacy.rows.iter().flat_map(|(chat, rows)| rows.keys().map(move |id| (chat.clone(), id.clone()))).collect();
        run.rows_left.reverse();
        run.legacy = legacy;
        run.phase = Phase::Local;
        run.point = M1;
        let rep = self.migration_report();
        self.progress_put(M1, &rep, Self::layer_name(layer));
        self.refresh_groups(w, true);
        Ok(())
    }

    fn migration_report(&self) -> Report {
        let Some(run) = &self.migration else { return Report::default() };
        let mut r = run.report.clone();
        r.counts = run.legacy.counts.clone();
        r.quarantined = run.legacy.quarantine.iter().map(|q| (q.key.clone(), q.reason.clone())).collect();
        r.unknown = run.legacy.unknown.clone();
        r
    }

    /// Следующий шаг переноса (после `migrateStep{}` и после каждого ответа сервера).
    pub(crate) fn migrate_advance(&mut self, w: &mut Work) -> Result<()> {
        let Some(run) = self.migration.as_ref() else { return Ok(()) };
        match run.phase {
            Phase::Collect | Phase::Done => Ok(()),
            Phase::Local => self.migrate_local_chunk(w),
            Phase::V2Sync | Phase::V1Sync => Ok(()),
            Phase::Appending => {
                let all = run.pending.iter().all(|k| !self.state_unsent.contains_key(k));
                if all {
                    self.migrate_send_migrated(w)?;
                }
                Ok(())
            }
            Phase::Migrated => {
                let done = run.migrated.as_ref().is_none_or(|(k, _)| !self.state_unsent.contains_key(k));
                if done {
                    self.migrate_after_journal(w)?;
                }
                Ok(())
            }
            Phase::Journaled => self.migrate_check(),
            Phase::Audited => self.migrate_switch(w),
        }
    }

    /// M2: часть поколения 1 — строки истории, в последней части — маркеры, исходящее, карантин.
    fn migrate_local_chunk(&mut self, w: &mut Work) -> Result<()> {
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        let n = run.chunk.min(run.rows_left.len());
        let take: Vec<(String, Vec<u8>)> = (0..n).filter_map(|_| run.rows_left.pop()).collect();
        let mut rows = vec![];
        for (chat, id) in take {
            if let Some((st, order)) = run.legacy.rows.get(&chat).and_then(|r| r.get(&id)) {
                rows.push((chat, id, st.clone(), *order));
            }
        }
        let last = run.rows_left.is_empty();
        let layer = Self::layer_name(run.layer);
        for (chat, id, state, order) in rows {
            let Some(id16) = super::paging::id16(&id) else { continue };
            let ts = state.row.as_ref().map(|r| r.ts_ms).unwrap_or(0);
            let row = super::paging::Row { order: order.unwrap_or(ts), state, hidden: false, delivery: 0, shown: None, counted: false };
            if let Some(p) = &row.state.chat {
                self.peers.entry(chat.clone()).or_insert_with(|| p.clone());
            }
            self.chats.entry(chat.clone()).or_default().put(id16, row);
            self.dirty.rows.insert((chat.clone(), id16));
            self.dirty.chats.insert(chat);
        }
        if !last {
            let rep = self.migration_report();
            self.progress_put(M2, &rep, layer);
            if let Some(r) = self.migration.as_mut() {
                r.point = M2;
            }
            return Ok(());
        }
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        let marks: Vec<(String, crate::pb::parvane::history::v1::ReadMark)> = run.legacy.marks.iter().map(|(k, m)| (k.clone(), m.clone())).collect();
        let own: Vec<Value> = run.legacy.own_journal.values().cloned().collect();
        let quarantined = run.legacy.quarantine.clone();
        for (chat, m) in marks {
            if let Some(p) = &m.chat {
                self.peers.entry(chat.clone()).or_insert_with(|| p.clone());
            }
            self.marks.insert(chat.clone(), m);
            self.dirty.marks.insert(chat.clone());
            self.dirty.chats.insert(chat);
        }
        self.legacy_outbox = own;
        if !self.legacy_outbox.is_empty() {
            self.dirty.extra.push(("outbox".into(), LEGACY_OUTBOX.into(), serde_json::to_vec(&self.legacy_outbox).unwrap_or_default()));
        }
        for q in &quarantined {
            self.dirty.extra.push((quarantine::KIND.into(), q.record_name(), q.to_bytes()));
        }
        let rep = self.migration_report();
        self.progress_put(M2, &rep, layer);
        // Сеть: журнал личного состояния (нужен ключ состояния из движка прежней версии)
        let has_key = self.client.as_ref().is_some_and(|c| c.state_key().is_some());
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        run.point = M2;
        if has_key {
            run.phase = Phase::V2Sync;
            let r = Self::id_req("state.ops.sync", &s2::SyncRequest { after_seq: 0, max_bytes: 0 });
            self.push_req(w, r, Purpose::MigrateV2Sync);
            Ok(())
        } else {
            self.migrate_after_journal(w)
        }
    }

    /// Ответ `state.ops.sync` (`v1` = false) или `state.sync` (`v1` = true) переноса.
    pub(crate) fn migrate_response(&mut self, v1: bool, error: i32, body: &[u8], w: &mut Work) -> Result<()> {
        if error != 0 {
            // Сервер не ответил: перенос продолжится со следующего запуска (старое не тронуто)
            if let Some(run) = self.migration.as_mut() {
                run.report.errors.push(format!("{}: ошибка сервера {error}", if v1 { "state.sync" } else { "state.ops.sync" }));
            }
            return Ok(());
        }
        if !v1 {
            let more = self.ingest_state_sync_as(body, w, Purpose::MigrateV2Sync)?;
            if more {
                return Ok(());
            }
            let already = self.state.migrated_from().is_some();
            let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
            run.already = already;
            run.phase = Phase::V1Sync;
            let r = Self::id_req("state.sync", &v1::SyncRequest { after_seq: 0, max_bytes: 0 });
            self.push_req(w, r, Purpose::MigrateV1Sync);
            return Ok(());
        }
        let r: v1::SyncResponse = decode_checked(body, Origin::Server)?;
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        for rec in &r.records {
            run.v1_cursor = run.v1_cursor.max(rec.seq);
        }
        let more = r.more && !r.records.is_empty();
        run.v1_records.extend(r.records);
        if more {
            let after = run.v1_cursor;
            let req = Self::id_req("state.sync", &v1::SyncRequest { after_seq: after, max_bytes: 0 });
            self.push_req(w, req, Purpose::MigrateV1Sync);
            return Ok(());
        }
        self.migrate_convert(w)
    }

    /// M3: старый журнал прочитан — операции нового в `state-raw` и на сервер.
    fn migrate_convert(&mut self, w: &mut Work) -> Result<()> {
        let c = self.client.as_ref().ok_or(ProtoError::NotFound)?;
        let (key, _) = c.state_key().ok_or(ProtoError::NotFound)?;
        let key = key.clone();
        let user = c.user.clone();
        let mut selves = vec![user.clone()];
        selves.extend(c.state_former_addresses());
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        let records = std::mem::take(&mut run.v1_records);
        let opened = state_v1::open_records(&key, &selves, &records);
        for q in &opened.quarantined {
            self.dirty.extra.push((quarantine::KIND.into(), q.record_name(), q.to_bytes()));
        }
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        run.legacy.quarantine.extend(opened.quarantined);
        run.v1_ops = opened.ops;
        run.v1_head = opened.head_seq;
        // Неотправленное старой версии
        let unsent: Vec<v1::StateOp> = run.legacy.state_unsent.iter().filter_map(|b| decode_checked::<v1::StateOp>(b, Origin::Client).ok()).collect();
        let mut all = run.v1_ops.clone();
        all.extend(unsent.iter().cloned());
        let mut ps = crate::state::PersonalState::new();
        ps.apply_all(&all);
        run.before_state = (!run.already).then(|| ps.snapshot());
        let mut pending = BTreeSet::new();
        let mut sends: Vec<(String, Vec<u8>)> = vec![];
        let mut migrated = None;
        let mut lamport = self.state.max_lamport();
        if !run.already && (!run.v1_ops.is_empty() || run.v1_head > 0) {
            let conv = state_v1::convert(&user, &run.v1_ops, run.v1_head)?;
            lamport = lamport.max(conv.lamport);
            for op in &conv.ops {
                let pt = op.encode_to_vec();
                let h = hex::encode(&op.op_id);
                pending.insert(h.clone());
                sends.push((h, pt));
            }
            migrated = Some((hex::encode(&conv.migrated.op_id), conv.migrated.encode_to_vec()));
        }
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        run.pending = pending;
        run.migrated = migrated;
        let layer = Self::layer_name(run.layer);
        let base = run.v1_ops.clone();
        for (h, pt) in &sends {
            let _ = self.state.apply_bytes(pt);
            self.state_unsent.insert(h.clone(), pt.clone());
            self.dirty.state_raw.insert(h.clone(), Some(pt.clone()));
            self.dirty.state = true;
            self.send_state_raw(h, pt, w);
        }
        // Неотправленное старой версии — новыми операциями (после `Migrated` их отправит `migrate_after_journal`)
        if !unsent.is_empty() {
            let ops = state_v1::unsent_ops(&base, &unsent, &self.cfg.device_id, lamport, self.now_ms)?;
            let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
            run.legacy.state_unsent = ops.iter().map(|o| o.encode_to_vec()).collect();
        } else if let Some(run) = self.migration.as_mut() {
            run.legacy.state_unsent.clear();
        }
        let rep = self.migration_report();
        self.progress_put(M3, &rep, layer);
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        run.point = M3;
        run.phase = Phase::Appending;
        if sends.is_empty() {
            self.migrate_send_migrated(w)?;
        }
        Ok(())
    }

    /// Все операции переноса приняты — `Migrated{from_seq}` последней.
    fn migrate_send_migrated(&mut self, w: &mut Work) -> Result<()> {
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        run.phase = Phase::Migrated;
        let Some((h, pt)) = run.migrated.clone() else { return self.migrate_after_journal(w) };
        let _ = self.state.apply_bytes(&pt);
        self.state_unsent.insert(h.clone(), pt.clone());
        self.dirty.state_raw.insert(h.clone(), Some(pt.clone()));
        self.dirty.state = true;
        self.send_state_raw(&h, &pt, w);
        Ok(())
    }

    /// M4 и дальше: неотправленное старой версии, подписки на группы чужих серверов, фото групп, сверка, M6.
    fn migrate_after_journal(&mut self, w: &mut Work) -> Result<()> {
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        if run.phase == Phase::Done {
            return Ok(());
        }
        run.phase = Phase::Done;
        let unsent = std::mem::take(&mut run.legacy.state_unsent);
        let layer = Self::layer_name(run.layer);
        for pt in unsent {
            let Ok(op) = decode_checked::<s2::StateOp>(&pt, Origin::Client) else { continue };
            let h = hex::encode(&op.op_id);
            let _ = self.state.apply_bytes(&pt);
            self.state_unsent.insert(h.clone(), pt.clone());
            self.dirty.state_raw.insert(h.clone(), Some(pt.clone()));
            self.dirty.state = true;
            self.send_state_raw(&h, &pt, w);
        }
        let rep = self.migration_report();
        self.progress_put(M4, &rep, layer);
        self.migrate_network_steps(w);
        if let Some(run) = self.migration.as_mut() {
            run.point = M4;
            run.phase = Phase::Journaled;
        }
        Ok(())
    }

    /// M5: сверка «до» (старые записи) и «после» (новое состояние); расхождение — стоп до переключения.
    fn migrate_check(&mut self) -> Result<()> {
        let diff = self.migrate_audit();
        let run = self.migration.as_mut().ok_or(ProtoError::NotFound)?;
        let layer = Self::layer_name(run.layer);
        run.report.audit = diff.clone();
        if !diff.clean() {
            if !run.report.errors.iter().any(|e| e.starts_with("сверка")) {
                run.report.errors.push(format!("сверка: потеряно {}, изменено {}", diff.lost.len(), diff.changed.len()));
            }
            run.phase = Phase::Done;
            let rep = self.migration_report();
            self.progress_put(M4, &rep, layer);
            return Ok(());
        }
        run.point = M5;
        run.phase = Phase::Audited;
        let rep = self.migration_report();
        self.progress_put(M5, &rep, layer);
        Ok(())
    }

    /// M6: переключение — профиль открыт на новом хранилище.
    fn migrate_switch(&mut self, w: &mut Work) -> Result<()> {
        let run = self.migration.as_ref().ok_or(ProtoError::NotFound)?;
        let layer = Self::layer_name(run.layer);
        let rep = self.migration_report();
        self.progress_put(M6, &rep, layer);
        self.migration = None;
        self.open_state = OpenState::Ready;
        w.open = Some(OpenResult { state: OpenState::Ready as i32, migration: Some(MigrationPlan { steps: vec!["mark-legacy".into()], legacy_records: rep.counts.values().sum() }) });
        let ids: Vec<super::Id> = self.outbox.keys().copied().collect();
        for id in ids {
            self.flush_outbox(&id, w);
        }
        Ok(())
    }

    /// Шаги, зависящие от сети (T103): подписки на группы чужих серверов (T078), фото частных групп со старым
    /// открытым секретом, где пользователь — админ (FR-071; перезаливает хост: блоб и `groupChange`).
    fn migrate_network_steps(&mut self, w: &mut Work) {
        let me = self.cfg.user.clone();
        let mut subs = vec![];
        let mut reupload = vec![];
        for (id, f) in &self.groups {
            let role = f.role(&me);
            let member = matches!(role, epb::GroupRole::Owner | epb::GroupRole::Admin | epb::GroupRole::Member) && !f.deleted;
            if member && !f.group.domain.eq_ignore_ascii_case(&self.cfg.domain) {
                subs.push(f.group.clone());
            }
            if matches!(role, epb::GroupRole::Owner | epb::GroupRole::Admin) && !f.deleted {
                if let Some(s) = self.client.as_ref().and_then(|c| c.group_state(id)) {
                    if s.public.is_none() && !s.avatar_file_id.is_empty() && s.avatar_key_id.is_empty() {
                        reupload.push(hex::encode(id));
                    }
                }
            }
        }
        for g in subs {
            let r = Self::id_req("group.remote.subscribe", &crate::pb::parvane::group::v2::RemoteSubscribeRequest { group: Some(g) });
            self.push_req(w, r, Purpose::Other);
        }
        for hex in reupload {
            w.delta.push(Change::Needs(epb::Need { kind: "group_avatar_reupload".into(), chat: None, detail: hex }));
        }
    }

    /// Сверка выгрузок: «до» — из старых записей и старого журнала, «после» — из нового состояния движка.
    fn migrate_audit(&self) -> audit::Diff {
        let Some(run) = &self.migration else { return audit::Diff::default() };
        let user = self.cfg.user.as_str();
        let rows_before: Vec<&crate::pb::parvane::history::v1::RowState> = run.legacy.rows.values().flat_map(|r| r.values().map(|(s, _)| s)).collect();
        let before = audit::build(&audit::Sources {
            user,
            rows: rows_before,
            marks: run.legacy.marks.values().collect(),
            own_journal: run.legacy.own_journal.values().collect(),
            state: run.before_state.clone(),
            client: self.client.as_ref(),
        });
        let mut after = self.audit_lines();
        if run.before_state.is_none() {
            // Журнал перенесло другое устройство — состояние уже новое, сверяется только локальное
            after.retain(|l| !(l.kind.starts_with("state:") || ["draft", "scheduled", "sticker-pack", "saved-gif"].contains(&l.kind.as_str())));
        }
        audit::diff(&before, &after)
    }

    /// Выгрузка сверки по текущему состоянию движка.
    pub fn audit_lines(&self) -> Vec<audit::AuditLine> {
        let rows: Vec<&crate::pb::parvane::history::v1::RowState> = self.chats.values().flat_map(|c| c.rows().map(|r| &r.state)).collect();
        audit::build(&audit::Sources {
            user: &self.cfg.user,
            rows,
            marks: self.marks.values().collect(),
            own_journal: self.legacy_outbox.iter().collect(),
            state: Some(state_v1::project_v1(&self.state)).filter(|s| *s != Default::default()),
            client: self.client.as_ref(),
        })
    }

    /// `auditDump`: JSONL выгрузки нового движка (`audit-after.jsonl`).
    pub fn audit_dump(&self) -> String {
        audit::jsonl(&self.audit_lines())
    }

    /// `migrateFinish`: хост пометил старые хранилища «перенесено» (точка 7).
    pub fn migrate_finish(&mut self) -> Result<Outcome> {
        let p = self.migration_progress.clone().ok_or(ProtoError::NotFound)?;
        if p.point < M6 {
            return Err(ProtoError::InvalidField("migration"));
        }
        self.progress_put(DONE, &p.report, &p.layer);
        self.finish(Work::default())
    }

    /// `migrateStatus`: точка и отчёт.
    pub fn migrate_status(&self) -> epb::MigrateStatus {
        let (point, report) = match (&self.migration, &self.migration_progress) {
            (Some(r), p) => (r.point.max(p.as_ref().map(|p| p.point).filter(|_| r.point > 0).unwrap_or(0)), self.migration_report()),
            (None, Some(p)) => (p.point, p.report.clone()),
            (None, None) => (0, Report::default()),
        };
        epb::MigrateStatus { point, done: point >= M6, report_json: serde_json::to_string(&report).unwrap_or_default() }
    }

    /// Строк истории в модели (для тестов переноса).
    #[doc(hidden)]
    pub fn debug_row_count(&self) -> usize {
        self.chats.values().map(|c| c.len()).sum()
    }

    /// Неотправленные операции личного состояния (для тестов переноса).
    #[doc(hidden)]
    pub fn debug_state_unsent(&self) -> usize {
        self.state_unsent.len()
    }
}
