//! Строки истории хоста в модели (spec 035 T114, режим `host_driven`, contracts/engine-api.md): хост, который
//! пока сам ведёт журнал истории аккаунта (web: `v2/history.ts`), отдаёт модели все операции над строками —
//! своё, входящее, записи журнала, квитанции «прочитано» на своё исходящее, локальное удаление. Сведение строк
//! (`history::apply`, HIST-1), место в ленте (ORDER-1), маркеры «прочитано до» (READ-2), хранение (`history-row`,
//! `history-mark`) и показ (`MessageView`, `historyPage`, `chatList`) — модель; у хоста своей копии строк нет.
//!
//! Пачка `rowsApply` — только строки и маркеры: изменённое раньше (клиент, личное состояние) уходит своим итогом.
//! Так вызов из обработчика изменений другого итога (событие записи инбокса → строка) фиксирует строку раньше,
//! чем курсор инбокса этого итога (SYNC-1), и не перезаписывает его более старой копией клиента.

use serde_json::{json, Value};

use super::paging::{self, Id, Row};
use super::{Engine, Work};
use crate::error::{ProtoError, Result};
use crate::history;
use crate::host::history::{from_json, to_json};
use crate::pb::parvane::engine::v1::{self as epb, model_change::Change, MessageRemove, Outcome};
use crate::pb::parvane::history::v1::{HistoryOp, ReadMark, RowState};
use crate::pb::parvane::state::v1::Peer;

fn json_list(text: &str) -> Result<Vec<Value>> {
    if text.trim().is_empty() {
        return Ok(vec![]);
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(a)) => Ok(a),
        _ => Err(ProtoError::Malformed),
    }
}

/// `{chat: Peer, target: uuid}` → ключ чата, собеседник, id.
fn target_of(v: &Value) -> Result<(String, Peer, Id)> {
    let peer: Peer = from_json(v.get("chat").ok_or(ProtoError::InvalidField("chat"))?).map_err(|_| ProtoError::InvalidField("chat"))?;
    let chat = history::history_chat_key(&peer)?;
    let raw = history::parse_id(v.get("target").and_then(Value::as_str).ok_or(ProtoError::InvalidField("target"))?)?;
    let id = paging::id16(&raw).ok_or(ProtoError::InvalidField("target"))?;
    Ok((chat, peer, id))
}

impl Engine {
    /// `rowsApply`: операции, квитанции, удаление у себя, замена; итог — пачка строк и изменения показа.
    pub(crate) fn rows_apply(&mut self, a: epb::RowsApply) -> Result<Outcome> {
        if !self.cfg.host_driven {
            return Err(ProtoError::NotFound);
        }
        self.writable()?;
        if a.now_ms > 0 {
            self.now_ms = self.now_ms.max(a.now_ms);
        }
        let ops: Vec<HistoryOp> =
            json_list(&a.ops_json)?.iter().map(|v| from_json(v).map_err(|_| ProtoError::Malformed)).collect::<Result<_>>()?;
        let receipts = json_list(&a.receipts_json)?.iter().map(target_of).collect::<Result<Vec<_>>>()?;
        let forget = json_list(&a.forget_json)?.iter().map(target_of).collect::<Result<Vec<_>>>()?;
        let mut legacy = vec![];
        for v in json_list(&a.rows_json)? {
            let hs: RowState = from_json(v.get("hs").ok_or(ProtoError::InvalidField("hs"))?).map_err(|_| ProtoError::Malformed)?;
            legacy.push((hs, v.get("order").and_then(Value::as_i64)));
        }
        // Своё изменённое прежних вызовов — в сторону: пачка этого вызова только со строками и маркерами
        let held = std::mem::take(&mut self.dirty);
        let mut w = Work::default();
        if a.wipe {
            self.rows_wipe(&mut w);
        }
        for (chat, peer, id) in forget {
            if self.chats.get_mut(&chat).and_then(|c| c.remove(&id)).is_some() {
                self.dirty.rows_gone.insert((chat.clone(), id));
                self.dirty.chats.insert(chat);
                w.delta.push(Change::MessageRemove(MessageRemove { chat: Some(peer), id: id.to_vec() }));
            }
        }
        for (hs, order) in legacy {
            self.row_put_legacy(hs, order, &mut w);
        }
        for op in &ops {
            let at = history::op_target(op).and_then(|(t, c)| Some((history::history_chat_key(c.as_ref()?).ok()?, paging::id16(t)?)));
            let before = at.as_ref().and_then(|(c, id)| self.chats.get(c).and_then(|r| r.get(id)).map(|r| r.state.clone()));
            self.apply_history_op(op, false, &mut w.delta);
            if let Some((chat, id)) = at {
                let after = self.chats.get(&chat).and_then(|r| r.get(&id)).map(|r| &r.state);
                if after.is_some() && after != before.as_ref() {
                    self.emit_row(&chat, &id, &mut w);
                }
            }
        }
        for (chat, _, id) in receipts {
            let Some(r) = self.chats.get_mut(&chat).and_then(|c| c.get_mut(&id)) else { continue };
            if r.delivery == epb::Delivery::Read as i32 {
                continue;
            }
            r.delivery = epb::Delivery::Read as i32;
            self.dirty.rows.insert((chat.clone(), id));
            self.emit_row(&chat, &id, &mut w);
        }
        let out = self.finish(w);
        let left = std::mem::replace(&mut self.dirty, held);
        self.dirty.chats.extend(left.chats);
        out
    }

    /// Строка изменилась: показ целиком (видна; и служебная строка ленты — голос, закрытие опроса: хост ведёт по ним
    /// опросы) либо снятие (надгробие, сирота) — и когда показ не изменился.
    fn emit_row(&mut self, chat: &str, id: &Id, w: &mut Work) {
        let Some(row) = self.chats.get(chat).and_then(|c| c.get(id)) else { return };
        let peer = row.state.chat.clone().or_else(|| self.peers.get(chat).cloned());
        let view = self.message_view_as(row, true);
        let fp = view.as_ref().map(super::fingerprint);
        match view {
            Some(v) => w.delta.push(Change::MessageUpsert(v)),
            None => w.delta.push(Change::MessageRemove(MessageRemove { chat: peer, id: id.to_vec() })),
        }
        if let Some(r) = self.chats.get_mut(chat).and_then(|c| c.get_mut(id)) {
            r.shown = fp;
        }
        self.dirty.chats.insert(chat.to_string());
    }

    /// Строка прежнего кэша хоста: сведение с известной (место известной), новая — на прежнее место либо по времени.
    fn row_put_legacy(&mut self, hs: RowState, order: Option<i64>, w: &mut Work) {
        let Some(id) = paging::id16(&hs.target) else { return };
        let Some(peer) = hs.chat.clone() else { return };
        let Ok(chat) = history::history_chat_key(&peer) else { return };
        let selves = self.selves();
        let sv: Vec<&str> = selves.iter().map(String::as_str).collect();
        let prev = self.chats.get(&chat).and_then(|c| c.get(&id)).cloned();
        let state = match &prev {
            Some(p) => match history::merge(&p.state, &hs) {
                Ok(m) => m,
                Err(_) => return,
            },
            None => hs,
        };
        if prev.as_ref().is_some_and(|p| p.state == state) {
            return;
        }
        let ts = state.row.as_ref().map(|r| r.ts_ms).unwrap_or(0);
        let mut row = prev.unwrap_or_else(|| Row { order: order.unwrap_or(ts), ..Default::default() });
        row.counted = history::is_unread(&state, None, &sv).unwrap_or(false);
        row.state = state;
        self.chats.entry(chat.clone()).or_default().put(id, row);
        self.peers.entry(chat.clone()).or_insert(peer);
        self.dirty.rows.insert((chat.clone(), id));
        self.emit_row(&chat, &id, w);
    }

    /// Замена истории точкой журнала (HIST-2): все строки и маркеры — прочь, показанное — снять.
    fn rows_wipe(&mut self, w: &mut Work) {
        let chats = std::mem::take(&mut self.chats);
        for (chat, rows) in chats {
            let ids: Vec<(Option<Peer>, Id, bool)> = rows
                .rows()
                .filter_map(|r| paging::id16(&r.state.target).map(|id| (r.state.chat.clone(), id, r.shown.is_some() || r.visible())))
                .collect();
            for (peer, id, shown) in ids {
                self.dirty.rows_gone.insert((chat.clone(), id));
                if shown {
                    let peer = peer.or_else(|| self.peers.get(&chat).cloned());
                    w.delta.push(Change::MessageRemove(MessageRemove { chat: peer, id: id.to_vec() }));
                }
            }
            self.dirty.chats.insert(chat);
        }
        for chat in std::mem::take(&mut self.marks).into_keys() {
            self.dirty.marks_gone.insert(chat);
        }
    }

    /// `rowsAll`: все строки (показ — и служебные строки ленты; состояния — и надгробия) и маркеры; `chat_key` —
    /// только этого чата, `ids` — только строки с этими id (desktop/android, T125: строка по id без копии у хоста).
    pub(crate) fn rows_all(&self, a: &epb::RowsAllRequest) -> Value {
        let ids: Option<Vec<Id>> = (!a.ids.is_empty())
            .then(|| a.ids.iter().filter_map(|s| history::parse_id(s).ok().and_then(|b| paging::id16(&b))).collect());
        let mut picked: Vec<&Row> = vec![];
        for (key, rows) in &self.chats {
            if !a.chat_key.is_empty() && *key != a.chat_key {
                continue;
            }
            match &ids {
                Some(ids) => picked.extend(ids.iter().filter_map(|id| rows.get(id))),
                None => picked.extend(rows.rows()),
            }
        }
        let mut out = serde_json::Map::new();
        if a.views {
            let views: Vec<Value> = picked
                .iter()
                .filter_map(|r| self.message_view_as(r, true))
                .map(|v| serde_json::to_value(&v).unwrap_or(Value::Null))
                .collect();
            out.insert("views".into(), Value::Array(views));
        }
        if a.states {
            out.insert("states".into(), Value::Array(picked.iter().map(|r| to_json(&r.state)).collect()));
        }
        if a.marks {
            let marks = self.marks.iter().filter(|(k, _)| a.chat_key.is_empty() || **k == a.chat_key).map(|(_, m)| to_json(m));
            out.insert("marks".into(), Value::Array(marks.collect()));
        }
        json!(out)
    }

    /// `rowsRead`: непрочитанное чата от маркера (READ-2; то же решение «считается», что у списка чатов), последняя
    /// прочитанная видимая строка и входящие, которые маркер после `since` сделал прочитанными (квитанции собеседнику).
    pub(crate) fn rows_read(&self, a: &epb::RowsReadRequest) -> Result<Value> {
        let since: Option<ReadMark> = match a.since_json.trim() {
            "" | "null" => None,
            text => {
                let v: Value = serde_json::from_str(text).map_err(|_| ProtoError::Malformed)?;
                Some(from_json(&v).map_err(|_| ProtoError::InvalidField("since_json"))?)
            }
        };
        let mark = self.marks.get(&a.chat_key);
        let not_after = |ts: i64, id: &[u8], m: &ReadMark| (ts, id) <= (m.up_to_ts_ms, m.up_to_id.as_slice());
        let mut last: Option<(i64, Vec<u8>, String)> = None;
        let mut newly = vec![];
        if let (Some(rows), Some(m)) = (self.chats.get(&a.chat_key), mark) {
            for r in rows.rows().filter(|r| r.visible()) {
                let Some(x) = r.state.row.as_ref() else { continue };
                if !not_after(x.ts_ms, &x.id, m) {
                    continue;
                }
                if last.as_ref().is_none_or(|l| (x.ts_ms, x.id.as_slice()) > (l.0, l.1.as_slice())) {
                    last = Some((x.ts_ms, x.id.clone(), history::uuid_string(&r.state.target)));
                }
                if r.counted && since.as_ref().is_none_or(|s| !not_after(x.ts_ms, &x.id, s)) {
                    newly.push(Value::String(history::uuid_string(&r.state.target)));
                }
            }
        }
        let mut out = serde_json::Map::new();
        out.insert("unread".into(), json!(self.unread_of(&a.chat_key)));
        out.insert("last_read_id".into(), json!(last.map(|l| l.2).unwrap_or_default()));
        if let Some(m) = mark {
            out.insert("mark".into(), to_json(m));
        }
        out.insert("newly_read".into(), Value::Array(newly));
        Ok(Value::Object(out))
    }
}
