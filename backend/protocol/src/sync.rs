//! Журналы и курсоры (T027, R9). Всё синхронизируемое — журнал с серверным
//! монотонным `seq`; курсор клиента = `seq` на журнал. Правила conformance
//! реализованы здесь один раз для всех клиентов:
//! - SYNC-1: дисковый курсор двигается только по ПРИМЕНЁННЫМ записям, и только
//!   непрерывно (дыра — курсор стоит);
//! - SYNC-2: запись, которая не применилась, пробуется 3 раза, потом
//!   пропускается (курсор идёт дальше, запись — в «не удалось»);
//! - READ-1: квитанция о прочтении повторяется до подтверждения;
//! - страница синхронизации ограничена байтовым бюджетом ≤ 716800.

use std::collections::{BTreeMap, BTreeSet};

use prost::Message;

use crate::pb::parvane::msg::v2::{InboxRecord, InboxSyncRequest};

/// Бюджет страницы синхронизации (как v1).
pub const PAGE_BUDGET: usize = 716_800;
/// SYNC-2: попыток применить запись.
pub const MAX_ATTEMPTS: u32 = 3;

/// Состояние курсора одного журнала на клиенте.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cursor {
    /// Всё ≤ applied применено (или окончательно пропущено) — это пишется на диск.
    applied: u64,
    /// Применённые с дырой перед ними.
    done_ahead: BTreeSet<u64>,
    /// Попытки по записям, которые не применились.
    attempts: BTreeMap<u64, u32>,
    /// Окончательно пропущенные (SYNC-2) — для диагностики.
    pub skipped: Vec<u64>,
}

/// Результат неудачной попытки применить запись.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailOutcome {
    /// Повторить при следующей синхронизации.
    Retry,
    /// Попытки исчерпаны — запись пропущена, курсор может идти дальше.
    Skipped,
}

impl Cursor {
    /// Курсор, восстановленный с диска.
    pub fn from_disk(applied: u64) -> Self {
        Self { applied, ..Default::default() }
    }

    /// Значение для записи на диск (SYNC-1).
    pub fn disk_value(&self) -> u64 {
        self.applied
    }

    /// Запрос следующей страницы.
    pub fn next_request(&self) -> InboxSyncRequest {
        InboxSyncRequest { after_seq: self.applied, max_bytes: PAGE_BUDGET as u32 }
    }

    /// Уже применено?
    pub fn is_done(&self, seq: u64) -> bool {
        seq <= self.applied || self.done_ahead.contains(&seq)
    }

    fn settle(&mut self) {
        while self.done_ahead.remove(&(self.applied + 1)) {
            self.applied += 1;
            self.attempts.remove(&self.applied);
        }
    }

    /// Запись применена.
    pub fn mark_applied(&mut self, seq: u64) {
        if seq <= self.applied {
            return;
        }
        self.done_ahead.insert(seq);
        self.attempts.remove(&seq);
        self.settle();
    }

    /// Запись не применилась (SYNC-2).
    pub fn mark_failed(&mut self, seq: u64) -> FailOutcome {
        if self.is_done(seq) {
            return FailOutcome::Skipped;
        }
        let n = self.attempts.entry(seq).or_insert(0);
        *n += 1;
        if *n >= MAX_ATTEMPTS {
            self.attempts.remove(&seq);
            self.skipped.push(seq);
            self.done_ahead.insert(seq);
            self.settle();
            FailOutcome::Skipped
        } else {
            FailOutcome::Retry
        }
    }

    /// Сервер сообщил о пропуске номеров (скрытые/истёкшие записи):
    /// номера ≤ `upto`, которых нет в странице, считаются пройденными.
    pub fn mark_gap_until(&mut self, page_seqs: &[u64], upto: u64) {
        let present: BTreeSet<u64> = page_seqs.iter().copied().collect();
        let mut s = self.applied + 1;
        while s <= upto {
            if !present.contains(&s) {
                self.done_ahead.insert(s);
            }
            s += 1;
        }
        self.settle();
    }
}

/// Сервер: набрать страницу по байтовому бюджету. Всегда хотя бы одна
/// запись (она ≤ лимита содержимого, иначе не была бы принята).
pub fn paginate(records: impl IntoIterator<Item = InboxRecord>, max_bytes: u32) -> (Vec<InboxRecord>, bool) {
    let budget = if max_bytes == 0 { PAGE_BUDGET } else { (max_bytes as usize).min(PAGE_BUDGET) };
    let mut out = Vec::new();
    let mut used = 0usize;
    let mut iter = records.into_iter().peekable();
    while let Some(r) = iter.peek() {
        let len = r.encoded_len() + 4;
        if !out.is_empty() && used + len > budget {
            return (out, true);
        }
        used += len;
        if let Some(r) = iter.next() {
            out.push(r);
        }
    }
    (out, false)
}

/// READ-1: очередь квитанций прочтения, повторяемых до подтверждения.
#[derive(Debug, Clone, Default)]
pub struct ReceiptQueue {
    /// id квитанции (op_id) → (следующая попытка, мс; номер попытки).
    pending: BTreeMap<Vec<u8>, (i64, u32)>,
}

impl ReceiptQueue {
    /// Базовая задержка повтора и потолок.
    pub const BASE_MS: i64 = 2_000;
    pub const MAX_MS: i64 = 120_000;

    pub fn enqueue(&mut self, op_id: Vec<u8>, now_ms: i64) {
        self.pending.entry(op_id).or_insert((now_ms, 0));
    }

    /// Квитанции, которые пора (пере)отправить; отмечает попытку.
    pub fn due(&mut self, now_ms: i64) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for (id, (at, n)) in self.pending.iter_mut() {
            if *at <= now_ms {
                out.push(id.clone());
                *n += 1;
                let backoff = (Self::BASE_MS << (*n).min(6)).min(Self::MAX_MS);
                *at = now_ms + backoff;
            }
        }
        out
    }

    /// Доставка подтверждена.
    pub fn ack(&mut self, op_id: &[u8]) {
        self.pending.remove(op_id);
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::msg::v2::{inbox_record, LegacyV1Record};

    #[test]
    fn sync1_cursor_only_contiguous() {
        let mut c = Cursor::from_disk(10);
        c.mark_applied(12);
        assert_eq!(c.disk_value(), 10);
        c.mark_applied(11);
        assert_eq!(c.disk_value(), 12);
        assert_eq!(c.next_request().after_seq, 12);
    }

    #[test]
    fn sync2_three_attempts() {
        let mut c = Cursor::from_disk(0);
        c.mark_applied(2);
        assert_eq!(c.mark_failed(1), FailOutcome::Retry);
        assert_eq!(c.mark_failed(1), FailOutcome::Retry);
        assert_eq!(c.disk_value(), 0);
        assert_eq!(c.mark_failed(1), FailOutcome::Skipped);
        assert_eq!(c.disk_value(), 2);
        assert_eq!(c.skipped, vec![1]);
    }

    #[test]
    fn gaps() {
        let mut c = Cursor::from_disk(0);
        c.mark_applied(3);
        c.mark_gap_until(&[3], 3);
        assert_eq!(c.disk_value(), 3);
    }

    #[test]
    fn page_budget() {
        let rec = |n: u64| InboxRecord {
            seq: n,
            received_ms: 0,
            item: Some(inbox_record::Item::LegacyV1(LegacyV1Record { json: vec![b'x'; 200_000] })),
        };
        let (page, more) = paginate((1..=10).map(rec), 0);
        assert_eq!(page.len(), 3);
        assert!(more);
        let total: usize = page.iter().map(|r| r.encoded_len()).sum();
        assert!(total <= PAGE_BUDGET);
        // Клиентский бюджет больше лимита — всё равно ≤ 716800.
        let (page, _) = paginate((1..=10).map(rec), u32::MAX);
        assert_eq!(page.len(), 3);
    }

    #[test]
    fn read1_repeats_until_ack() {
        let mut q = ReceiptQueue::default();
        q.enqueue(vec![1], 0);
        assert_eq!(q.due(0), vec![vec![1]]);
        assert!(q.due(1).is_empty());
        assert_eq!(q.due(1_000_000), vec![vec![1]]);
        q.ack(&[1]);
        assert!(q.is_empty());
    }
}
