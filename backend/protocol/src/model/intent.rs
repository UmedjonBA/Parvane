//! Намерения хоста (`Intent`) и входящее содержимое (spec 035 T066–T069): каждое действие клиента — намерение;
//! движок меняет модель, пишет хранилище, ставит исходящее в очередь и отдаёт изменения модели.

use prost::Message;
use serde_json::Value;

use super::{group_peer, paging, user_peer, views, Engine, OutboxItem, Purpose, Work};

use crate::client::ClientError;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::history;
use crate::limits::Origin;
use crate::pb::parvane::core::v2::Ref;
use crate::pb::parvane::engine::v1::{self as epb, intent::Kind as IK, model_change::Change, DeleteScope, Delivery, Outcome};
use crate::pb::parvane::group::v2 as gpb;
use crate::pb::parvane::history::v1::{history_op::Op as HOp, Edit as HEdit, Gone, GoneScope, HistoryOp, MessageRow, Pin as HPin, React, ReadMark};
use crate::pb::parvane::msg::v2::{self as mpb, content, Content, MessageRef};
use crate::pb::parvane::state::v1::{peer, Peer};
use crate::pb::parvane::state::v2::{self as s2, state_op::Op as SOp, ObjectKey, ObjectKind, StateOp};
use crate::unknown::Disposition;

/// Объект, который меняет операция личного состояния.
pub fn op_object(op: &StateOp) -> Option<&ObjectKey> {
    match op.op.as_ref()? {
        SOp::Create(c) => c.object.as_ref(),
        SOp::Patch(p) => p.object.as_ref(),
        SOp::Delete(d) => d.object.as_ref(),
        SOp::SetAdd(a) => a.object.as_ref(),
        SOp::SetRemove(r) => r.object.as_ref(),
        SOp::Mark(m) => m.object.as_ref(),
        SOp::Migrated(_) => None,
    }
}

fn chat_key(p: &Peer) -> Result<String> {
    history::history_chat_key(p)
}

fn stamp(e: &Engine) -> crate::pb::parvane::history::v1::Stamp {
    history::new_stamp(e.now_ms)
}

/// Байты одного поля (тег + значение) — `FieldValue.value` для `state.v2`.
fn field_bytes(m: &impl Message, field: u32) -> Option<s2::FieldValue> {
    super::split_fields(&m.encode_to_vec()).into_iter().find(|f| f.field == field)
}

/// Потолок избранных стикеров (FR-075, T089).
pub const MAX_FAVED_STICKERS: usize = 200;

impl Engine {
    /// Намерение хоста.
    pub fn submit(&mut self, i: epb::Intent) -> Result<Outcome> {
        let mut w = Work::default();
        let kind = i.kind.ok_or(ProtoError::InvalidField("kind"))?;
        // Только показ: слишком новое хранилище или заблокированное — запись закрыта
        if !matches!(kind, IK::Typing(_)) {
            self.writable()?;
        }
        match kind {
            IK::Send(s) => self.intent_send(s, &mut w)?,
            IK::Edit(e) => self.intent_edit(e, &mut w)?,
            IK::DeleteMessages(d) => self.intent_delete(d, &mut w)?,
            IK::React(r) => self.intent_react(r, &mut w)?,
            IK::Pin(p) => self.intent_pin(p, &mut w)?,
            IK::Read(r) => self.intent_read(r, &mut w)?,
            IK::Typing(t) => self.intent_typing(t, &mut w)?,
            IK::StatePatch(p) => {
                let op = SOp::Patch(s2::Patch { object: p.object, set: p.set, clear: p.clear });
                self.state_op(op, &mut w)?
            }
            IK::StateCreate(c) => self.state_op(SOp::Create(s2::Create { object: c.object, set: c.set }), &mut w)?,
            IK::StateDelete(d) => self.state_op(SOp::Delete(s2::Delete { object: d.object }), &mut w)?,
            IK::StateSetAdd(a) => self.state_op(SOp::SetAdd(s2::SetAdd { object: a.object, field: a.field, element: a.element }), &mut w)?,
            IK::StateSetRemove(r) => {
                self.state_op(SOp::SetRemove(s2::SetRemove { object: r.object, field: r.field, element: r.element }), &mut w)?
            }
            IK::FaveSticker(f) => self.intent_fave(f, &mut w)?,
            IK::GroupCreate(g) => self.intent_group_create(g, &mut w)?,
            IK::GroupChange(g) => self.intent_group_change(g, &mut w)?,
            IK::GroupJoinByLink(j) => self.intent_join(j, &mut w)?,
            IK::DomainOp(d) => self.intent_domain(d, &mut w)?,
            IK::RotateSsk(r) => {
                let secret: [u8; 32] = r.root_secret.as_slice().try_into().map_err(|_| ProtoError::InvalidField("root_secret"))?;
                let c = self.client.as_mut().ok_or(ProtoError::NotFound)?;
                let reqs = c.rotate_ssk_with_secret(&secret)?;
                self.dirty.client = true;
                for r in reqs {
                    self.push_req(&mut w, r, Purpose::Other);
                }
            }
            IK::Revoke(r) => {
                let c = self.client.as_mut().ok_or(ProtoError::NotFound)?;
                let out = if r.stolen { c.report_device_stolen(&r.device_id) } else { c.revoke_device(&r.device_id) };
                let out = out.map_err(|e| match e {
                    ClientError::Proto(p) => p,
                    ClientError::Need(_) => ProtoError::NotFound,
                })?;
                self.dirty.client = true;
                for r in out.requests {
                    self.push_req(&mut w, r, Purpose::Other);
                }
            }
        }
        self.finish(w)
    }

    fn group_facts(&self, p: &Peer) -> Option<&super::capabilities::GroupFacts> {
        match &p.kind {
            Some(peer::Kind::Group(g)) => self.groups.get(&g.id),
            _ => None,
        }
    }

    /// GROUP-2 в композере: запрещённый вид — `Forbidden`.
    fn check_compose(&self, p: &Peer, c: &Content) -> Result<()> {
        if let Some(peer::Kind::Group(_)) = &p.kind {
            match self.group_facts(p) {
                Some(f) if !f.content_allowed(&self.cfg.user, c, self.now_ms) => return Err(ProtoError::Forbidden),
                Some(_) => {}
                None => return Err(ProtoError::NotFound),
            }
        }
        Ok(())
    }

    fn enqueue(&mut self, p: &Peer, op_id: Vec<u8>, content: Option<&Content>, receipt: Vec<String>, row: bool, w: &mut Work) {
        let Some(id) = paging::id16(&op_id) else { return };
        let item = OutboxItem {
            op_id,
            chat: p.encode_to_vec(),
            content: content.map(|c| c.encode_to_vec()).unwrap_or_default(),
            receipt,
            row,
            inflight: 0,
            waiting: false,
        };
        self.outbox.insert(id, item);
        self.dirty.outbox.insert(id);
        self.flush_outbox(&id, w);
    }

    /// Своё сообщение двигает маркер прочтения (READ-2 п. 1).
    fn advance_mark(&mut self, p: &Peer, ts_ms: i64, id: &[u8], w: &mut Work) {
        let m = ReadMark { chat: Some(p.clone()), up_to_ts_ms: ts_ms, up_to_id: id.to_vec() };
        self.apply_history_op(&HistoryOp { op: Some(HOp::Read(m)) }, true, &mut w.delta);
    }

    fn intent_send(&mut self, s: epb::IntentSend, w: &mut Work) -> Result<()> {
        let p = s.chat.ok_or(ProtoError::InvalidField("chat"))?;
        let chat = chat_key(&p)?;
        let cc = s.content.ok_or(ProtoError::InvalidField("content"))?;
        // Ответ на критичную заглушку запрещён (FR-041)
        if cc.reply_to.len() == 16 {
            if let Some(t) = paging::id16(&cc.reply_to).and_then(|id| self.chats.get(&chat).and_then(|c| c.get(&id))) {
                if let Some(v) = self.message_view(&chat, t) {
                    if v.disposition == epb::Disposition::StubCritical as i32 {
                        return Err(ProtoError::Forbidden);
                    }
                }
            }
        }
        let content = views::compose_to_content(&cc, None).ok_or(ProtoError::InvalidField("content"))?;
        self.check_compose(&p, &content)?;
        if s.schedule_at_ms > self.now_ms {
            // Отложенное — объект состояния `SCHEDULED` (STATE-2); отправит устройство, чей срок наступил
            let id = crate::state::new_op_id();
            let msg = crate::pb::parvane::state::v1::ScheduledMessage {
                op_id: id.to_vec(),
                peer: Some(p.clone()),
                send_at_ms: s.schedule_at_ms,
                content: content.encode_to_vec(),
            };
            let set = super::split_fields(&msg.encode_to_vec());
            let key = ObjectKey { kind: ObjectKind::Scheduled as i32, key: hex::encode(id) };
            return self.state_op(SOp::Create(s2::Create { object: Some(key), set }), w);
        }
        let id = crate::state::new_op_id();
        let body = match views::content_to_wire(&content) {
            Some(wire) => views::row_body(wire, content.reply_to.as_ref().map(|r| r.op_id.as_slice())),
            None => views::stub_body(false),
        };
        let row = MessageRow { id: id.to_vec(), chat: Some(p.clone()), from: self.cfg.user.clone(), ts_ms: self.now_ms, body };
        self.apply_history_op(&history::row_op(row), true, &mut w.delta);
        if let Some(r) = self.chats.get_mut(&chat).and_then(|c| c.get_mut(&id)) {
            r.delivery = Delivery::Pending as i32;
        }
        self.refresh_row(&chat, &id, &mut w.delta);
        self.advance_mark(&p, self.now_ms, &id, w);
        self.enqueue(&p, id.to_vec(), Some(&content), vec![], true, w);
        Ok(())
    }

    fn own_row(&self, chat: &str, target: &[u8]) -> Option<&paging::Row> {
        let id = paging::id16(target)?;
        self.chats.get(chat)?.get(&id)
    }

    fn intent_edit(&mut self, e: epb::IntentEdit, w: &mut Work) -> Result<()> {
        let p = e.chat.ok_or(ProtoError::InvalidField("chat"))?;
        let chat = chat_key(&p)?;
        let row = self.own_row(&chat, &e.target).ok_or(ProtoError::NotFound)?;
        let author = row.state.row.as_ref().map(|r| r.from.clone()).unwrap_or_default();
        if !self.selves().contains(&author) {
            return Err(ProtoError::Forbidden);
        }
        if self.message_view(&chat, row).is_none_or(|v| v.disposition != epb::Disposition::Show as i32) {
            return Err(ProtoError::Forbidden);
        }
        let cc = e.content.ok_or(ProtoError::InvalidField("content"))?;
        let new = views::compose_to_content(&cc, None).ok_or(ProtoError::InvalidField("content"))?;
        let edit = match new.kind {
            Some(content::Kind::Text(t)) => mpb::Edit { target: Some(MessageRef { op_id: e.target.clone() }), text: Some(t), location: None },
            Some(content::Kind::Location(l)) => mpb::Edit { target: Some(MessageRef { op_id: e.target.clone() }), text: None, location: Some(l) },
            _ => return Err(ProtoError::InvalidField("content")),
        };
        let c = Content { kind: Some(content::Kind::Edit(edit.clone())), ..Default::default() };
        self.check_compose(&p, &c)?;
        let st = stamp(self);
        let op = history::edit_op(HEdit { target: e.target.clone(), chat: Some(p.clone()), stamp: Some(st.clone()), body: views::edit_body(&edit), by: String::new() });
        self.apply_history_op(&op, true, &mut w.delta);
        self.enqueue(&p, st.op_id, Some(&c), vec![], false, w);
        Ok(())
    }

    fn intent_delete(&mut self, d: epb::IntentDelete, w: &mut Work) -> Result<()> {
        let p = d.chat.ok_or(ProtoError::InvalidField("chat"))?;
        let chat = chat_key(&p)?;
        let everyone = d.scope == DeleteScope::Everyone as i32;
        let selves = self.selves();
        let sv: Vec<&str> = selves.iter().map(String::as_str).collect();
        let admin_del = self.group_facts(&p).is_some_and(|f| f.capabilities(&self.cfg.user, self.now_ms).delete_everyone);
        let kind = if matches!(p.kind, Some(peer::Kind::Group(_))) { history::ChatKind::Group } else { history::ChatKind::User };
        for t in &d.targets {
            if everyone {
                let author = self.own_row(&chat, t).and_then(|r| r.state.row.as_ref()).map(|r| r.from.clone()).unwrap_or_default();
                if !history::can_delete(kind, &author, &sv, admin_del) {
                    return Err(ProtoError::Forbidden);
                }
            }
        }
        let st = stamp(self);
        let scope = if everyone { GoneScope::Everyone } else { GoneScope::Me };
        for t in &d.targets {
            let op = history::gone_op(Gone {
                target: t.clone(),
                chat: Some(p.clone()),
                stamp: Some(history::new_stamp(self.now_ms)),
                scope: scope as i32,
                by: String::new(),
                by_admin: false,
            });
            self.apply_history_op(&op, true, &mut w.delta);
        }
        // «Только у меня» — только журнал (HIST-1 п. 4); «у всех» — мутация собеседнику и своим
        if everyone {
            let del = mpb::Delete { targets: d.targets.iter().map(|t| MessageRef { op_id: t.clone() }).collect(), for_everyone: true };
            let c = Content { kind: Some(content::Kind::Delete(del)), ..Default::default() };
            self.enqueue(&p, st.op_id, Some(&c), vec![], false, w);
        }
        Ok(())
    }

    fn intent_react(&mut self, r: epb::IntentReact, w: &mut Work) -> Result<()> {
        let p = r.chat.ok_or(ProtoError::InvalidField("chat"))?;
        let st = stamp(self);
        let op = history::react_op(React { target: r.target.clone(), chat: Some(p.clone()), user: self.cfg.user.clone(), stamp: Some(st.clone()), emoji: r.emoji.clone() });
        self.apply_history_op(&op, true, &mut w.delta);
        let m = mpb::Reaction { target: Some(MessageRef { op_id: r.target }), remove: r.emoji.is_empty(), emoji: r.emoji };
        let c = Content { kind: Some(content::Kind::Reaction(m)), ..Default::default() };
        self.enqueue(&p, st.op_id, Some(&c), vec![], false, w);
        Ok(())
    }

    fn intent_pin(&mut self, pi: epb::IntentPin, w: &mut Work) -> Result<()> {
        let p = pi.chat.ok_or(ProtoError::InvalidField("chat"))?;
        if !self.capabilities(Some(&p))?.pin {
            return Err(ProtoError::Forbidden);
        }
        let st = stamp(self);
        let op = history::pin_op(HPin { target: pi.target.clone(), chat: Some(p.clone()), stamp: Some(st.clone()), pinned: pi.on });
        self.apply_history_op(&op, true, &mut w.delta);
        let m = mpb::Pin { target: Some(MessageRef { op_id: pi.target }), unpin: !pi.on, silent: false };
        let c = Content { kind: Some(content::Kind::Pin(m)), ..Default::default() };
        self.enqueue(&p, st.op_id, Some(&c), vec![], false, w);
        Ok(())
    }

    fn intent_read(&mut self, r: epb::IntentRead, w: &mut Work) -> Result<()> {
        let p = r.chat.ok_or(ProtoError::InvalidField("chat"))?;
        let chat = chat_key(&p)?;
        let a = r.up_to.ok_or(ProtoError::InvalidField("up_to"))?;
        let id = paging::id16(&a.id).ok_or(ProtoError::InvalidField("up_to"))?;
        let row = self.chats.get(&chat).and_then(|c| c.get(&id)).ok_or(ProtoError::NotFound)?;
        let ts = row.state.row.as_ref().map(|r| r.ts_ms).ok_or(ProtoError::NotFound)?;
        // Квитанция — о ставших прочитанными входящих (READ-1 п. 3)
        let selves = self.selves();
        let sv: Vec<&str> = selves.iter().map(String::as_str).collect();
        let mark = self.marks.get(&chat).cloned();
        let newly: Vec<String> = self
            .chats
            .get(&chat)
            .map(|c| {
                c.rows()
                    .filter(|x| x.visible() && history::is_unread(&x.state, mark.as_ref(), &sv).unwrap_or(false))
                    .filter(|x| x.state.row.as_ref().is_some_and(|m| (m.ts_ms, m.id.as_slice()) <= (ts, id.as_slice())))
                    .map(|x| hex::encode(&x.state.target))
                    .collect()
            })
            .unwrap_or_default();
        self.advance_mark(&p, ts, &id, w);
        if !newly.is_empty() {
            let op_id = crate::state::new_op_id();
            self.enqueue(&p, op_id.to_vec(), None, newly, false, w);
        }
        Ok(())
    }

    fn intent_typing(&mut self, t: epb::IntentTyping, w: &mut Work) -> Result<()> {
        let p = t.chat.ok_or(ProtoError::InvalidField("chat"))?;
        let action = match t.action.as_str() {
            "cancel" => mpb::TypingAction::Cancel,
            "record_voice" => mpb::TypingAction::RecordingVoice,
            "record_video" => mpb::TypingAction::RecordingVideo,
            "upload_media" => mpb::TypingAction::UploadingMedia,
            "choose_sticker" => mpb::TypingAction::ChoosingSticker,
            _ => mpb::TypingAction::Typing,
        };
        let c = self.client.as_ref().ok_or(ProtoError::NotFound)?;
        let r = match &p.kind {
            Some(peer::Kind::User(u)) => c.typing_request(&u.address, action)?,
            Some(peer::Kind::Group(g)) => c.group_typing_request(&g.id, action)?,
            None => return Err(ProtoError::InvalidField("chat")),
        };
        if let Some(r) = r {
            self.push_req(w, r, Purpose::Other);
        }
        Ok(())
    }

    /// Своя операция личного состояния (STATE-1/2, `state2`): применить, сохранить, отправить.
    pub(crate) fn state_op(&mut self, op: SOp, w: &mut Work) -> Result<()> {
        self.state.check_writable()?;
        let op = StateOp {
            op_id: crate::state::new_op_id().to_vec(),
            lamport: self.state.max_lamport() + 1,
            device_id: self.cfg.device_id.clone(),
            ts_ms: self.now_ms,
            op: Some(op),
        };
        let obj = op_object(&op).cloned().ok_or(ProtoError::InvalidField("object"))?;
        if !crate::state2::kind_known(obj.kind) {
            return Err(ProtoError::InvalidField("object"));
        }
        self.state.apply(&op)?;
        self.dirty.state = true;
        let pt = op.encode_to_vec();
        let op_hex = hex::encode(&op.op_id);
        self.state_unsent.insert(op_hex.clone(), pt.clone());
        self.dirty.state_raw.insert(op_hex.clone(), Some(pt.clone()));
        self.send_state_raw(&op_hex, &pt, w);
        self.emit_state(obj.kind, &obj.key, &mut w.delta);
        Ok(())
    }

    /// Избранный стикер (FR-075): объект `FAVED_STICKER` с ключом `set_id/sticker_id`.
    fn intent_fave(&mut self, f: epb::IntentFaveSticker, w: &mut Work) -> Result<()> {
        // PACK-1 (spec 036): id набора — ключ STICKER_PACK (`h:` + отпечаток base64 может содержать «/»), id стикера —
        // имя файла манифеста без «/»: ключ объекта `set_id/sticker_id` делится последним «/» однозначно
        if f.set_id.is_empty() || f.sticker_id.is_empty() || f.sticker_id.contains('/') {
            return Err(ProtoError::InvalidField("sticker"));
        }
        let key = ObjectKey { kind: ObjectKind::FavedSticker as i32, key: format!("{}/{}", f.set_id, f.sticker_id) };
        if f.on && self.state.view_object(key.kind, &key.key).is_none() {
            // Потолок избранного (FR-075, как в Telegram): 200 стикеров; сверх — отказ, клиент предлагает убрать старые
            let faved = self.state.view().iter().filter(|o| o.kind == key.kind).count();
            if faved >= MAX_FAVED_STICKERS {
                return Err(ProtoError::FieldLimit("faved_stickers"));
            }
        }
        if f.on {
            let v = s2::FavedSticker { set_id: f.set_id, sticker_id: f.sticker_id, media: None, added_ms: self.now_ms };
            let set: Vec<s2::FieldValue> = [1, 2, 4].iter().filter_map(|n| field_bytes(&v, *n)).collect();
            self.state_op(SOp::Create(s2::Create { object: Some(key), set }), w)
        } else {
            self.state_op(SOp::Delete(s2::Delete { object: Some(key) }), w)
        }
    }

    fn intent_group_create(&mut self, g: epb::IntentGroupCreate, w: &mut Work) -> Result<()> {
        let kind = if g.kind == "channel" { gpb::GroupKind::Channel } else { gpb::GroupKind::Group };
        let perms = gpb::Permissions {
            send_messages: true,
            send_media: true,
            send_stickers_gifs: true,
            send_polls: true,
            embed_links: true,
            invite_users: true,
            pin_messages: false,
            change_info: false,
        };
        let c = self.client.as_mut().ok_or(ProtoError::NotFound)?;
        let (_, req) = c.group_create(kind, &g.title, &g.members, perms)?;
        self.dirty.client = true;
        self.push_req(w, req, Purpose::Other);
        self.refresh_groups(w, false);
        Ok(())
    }

    fn intent_group_change(&mut self, g: epb::IntentGroupChange, w: &mut Work) -> Result<()> {
        let group = g.group.ok_or(ProtoError::InvalidField("group"))?;
        let ch: gpb::GroupChange = decode_checked(&g.change, Origin::Client)?;
        let change = ch.change.ok_or(ProtoError::InvalidField("change"))?;
        let c = self.client.as_mut().ok_or(ProtoError::NotFound)?;
        let req = c.group_change(&group.id, change)?;
        self.dirty.client = true;
        self.push_req(w, req, Purpose::Other);
        Ok(())
    }

    /// Вступление по ссылке: `group.invite.check` → журнал по ссылке → `group.join`.
    fn intent_join(&mut self, j: epb::IntentGroupJoinByLink, w: &mut Work) -> Result<()> {
        let crate::invite::ParsedInvite::V2(parts) = crate::invite::parse(&j.url)? else {
            return Err(ProtoError::InvalidField("invite"));
        };
        let mut r = Self::id_req_pub("group.invite.check", &gpb::InviteCheckRequest { link_id: parts.link_id.clone() });
        if !parts.domain.eq_ignore_ascii_case(&self.cfg.domain) {
            r.dest = Some(parts.domain.clone());
        }
        self.push_req(w, r, Purpose::InviteCheck(parts));
        Ok(())
    }

    fn id_req_pub(method: &'static str, m: &impl Message) -> crate::client::OutRequest {
        crate::client::OutRequest { chan: crate::client::Chan::Id, method, body: m.encode_to_vec(), dest: None }
    }

    /// Операция домена (`planner.v1` / `cloud.v1`): применить локально и отправить запечатанной.
    fn intent_domain(&mut self, d: epb::IntentDomainOp, w: &mut Work) -> Result<()> {
        let container = d.container.ok_or(ProtoError::InvalidField("container"))?;
        let c = self.client.as_mut().ok_or(ProtoError::NotFound)?;
        let op_id = crate::state::new_op_id().to_vec();
        let now = self.now_ms;
        let cerr = |e: ClientError| match e {
            ClientError::Proto(p) => p,
            ClientError::Need(_) => ProtoError::NotFound,
        };
        let req = if c.planner_container().is_some_and(|p| p.id == container.id) {
            c.planner_apply_local(&d.op).map_err(cerr)?;
            c.planner_seal(&d.op, &op_id, now).map_err(cerr)?
        } else if c.health_container().is_some_and(|p| p.id == container.id) {
            c.health_apply_local(&d.op).map_err(cerr)?;
            c.health_seal(&d.op, &op_id, now).map_err(cerr)?
        } else {
            c.cloud_apply_local(&container.id, &d.op).map_err(cerr)?;
            c.cloud_seal(&container.id, &d.op, &op_id, now).map_err(cerr)?
        };
        self.dirty.client = true;
        self.push_req(w, req, Purpose::Other);
        w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "domain_changed".into(), detail: hex::encode(&container.id) }));
        Ok(())
    }
}

/// Входящее содержимое → строки истории (HIST-1): сообщение — строка, мутация — операция над строкой
/// (сирота, если строки ещё нет), квитанция — доставка/маркер, служебное — ничего.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_incoming(e: &mut Engine, p: Peer, from: &str, op_id: &[u8], ts_ms: i64, mut c: Content, disposition: Disposition, proof: &[u8], w: &mut Work) {
    let Ok(chat) = chat_key(&p) else { return };
    note_blob_domain(&mut c, from, &e.cfg.domain);
    let own = e.selves().iter().any(|s| s == from);
    let by = if own { String::new() } else { from.to_string() };
    let st = crate::pb::parvane::history::v1::Stamp { ts_ms, op_id: op_id.to_vec() };
    let by_admin = e.group_facts(&p).is_some_and(|f| f.is_admin(from));
    let mut ops: Vec<HistoryOp> = vec![];
    match disposition {
        Disposition::Skip => return,
        Disposition::Stub | Disposition::StubCritical => {
            ops.push(history::row_op(MessageRow {
                id: op_id.to_vec(),
                chat: Some(p.clone()),
                from: from.to_string(),
                ts_ms,
                body: views::stub_body(disposition == Disposition::StubCritical),
            }));
        }
        Disposition::Show => match views::class_of(&c) {
            views::Class::Service => return,
            views::Class::Stub => ops.push(history::row_op(MessageRow { id: op_id.to_vec(), chat: Some(p.clone()), from: from.to_string(), ts_ms, body: views::stub_body(false) })),
            views::Class::Message => {
                // Самоуничтожающееся — не строка модели и не журнал (показ в памяти хоста, HIST-1 п. 6)
                if c.ttl_secs > 0 && e.cfg.host_driven {
                    return;
                }
                let Some(wire) = views::content_to_wire(&c) else { return };
                // Доказательство автора (A0008-2, REPORT-1) — в теле строки: жалоба прикладывает его к сообщению
                let body = views::row_body_proof(wire, c.reply_to.as_ref().map(|r| r.op_id.as_slice()), proof);
                ops.push(history::row_op(MessageRow { id: op_id.to_vec(), chat: Some(p.clone()), from: from.to_string(), ts_ms, body }));
            }
            views::Class::Mutation => match &c.kind {
                Some(content::Kind::Edit(ed)) => {
                    if let Some(t) = ed.target.as_ref() {
                        ops.push(history::edit_op(HEdit { target: t.op_id.clone(), chat: Some(p.clone()), stamp: Some(st.clone()), body: views::edit_body(ed), by: by.clone() }));
                    }
                }
                Some(content::Kind::Delete(d)) => {
                    let scope = if d.for_everyone || !own { GoneScope::Everyone } else { GoneScope::Me };
                    for t in &d.targets {
                        ops.push(history::gone_op(Gone {
                            target: t.op_id.clone(),
                            chat: Some(p.clone()),
                            stamp: Some(st.clone()),
                            scope: scope as i32,
                            by: by.clone(),
                            by_admin: by_admin && !own,
                        }));
                    }
                }
                Some(content::Kind::Reaction(r)) => {
                    if let Some(t) = r.target.as_ref() {
                        let emoji = if r.remove { String::new() } else { r.emoji.clone() };
                        ops.push(history::react_op(React { target: t.op_id.clone(), chat: Some(p.clone()), user: from.to_string(), stamp: Some(st.clone()), emoji }));
                    }
                }
                Some(content::Kind::Pin(pn)) => {
                    if let Some(t) = pn.target.as_ref() {
                        ops.push(history::pin_op(HPin { target: t.op_id.clone(), chat: Some(p.clone()), stamp: Some(st.clone()), pinned: !pn.unpin }));
                    }
                }
                Some(content::Kind::Receipt(r)) if r.kind == mpb::ReceiptKind::Read as i32 => {
                    if own {
                        // Копия своей квитанции с другого своего устройства — маркер (READ-2 п. 1)
                        let best = r
                            .messages
                            .iter()
                            .filter_map(|m| paging::id16(&m.op_id))
                            .filter_map(|id| e.chats.get(&chat).and_then(|c| c.get(&id)).and_then(|row| row.state.row.as_ref().map(|x| (x.ts_ms, id))))
                            .max();
                        if let Some((ts, id)) = best {
                            ops.push(HistoryOp { op: Some(HOp::Read(ReadMark { chat: Some(p.clone()), up_to_ts_ms: ts, up_to_id: id.to_vec() })) });
                        }
                    } else {
                        for m in &r.messages {
                            let Some(id) = paging::id16(&m.op_id) else { continue };
                            if let Some(row) = e.chats.get_mut(&chat).and_then(|c| c.get_mut(&id)) {
                                row.delivery = Delivery::Read as i32;
                                e.dirty.rows.insert((chat.clone(), id));
                            }
                            e.refresh_row(&chat, &id, &mut w.delta);
                        }
                    }
                }
                _ => {}
            },
        },
    }
    // GROUP-2: запрещённый вид от участника без роли — не показывать и не считать непрочитанным
    let hidden = disposition == Disposition::Show
        && views::class_of(&c) == views::Class::Message
        && e.group_facts(&p).is_some_and(|f| f.hides(from, &c, e.now_ms));
    for op in ops {
        let is_row = matches!(op.op, Some(HOp::Row(_)));
        if is_row && hidden {
            if let (Some(id), Some(HOp::Row(r))) = (paging::id16(op_id), &op.op) {
                let rows = e.chats.entry(chat.clone()).or_default();
                if rows.get(&id).is_none() {
                    let order = rows.place(r.ts_ms, e.now_ms);
                    if let Ok(state) = history::apply(None, &op) {
                        rows.put(id, paging::Row { order, state, hidden: true, delivery: 0, shown: None, counted: false });
                        e.peers.entry(chat.clone()).or_insert_with(|| p.clone());
                        e.dirty.rows.insert((chat.clone(), id));
                    }
                }
            }
            continue;
        }
        e.apply_history_op(&op, true, &mut w.delta);
    }
    // Своё сообщение с другого своего устройства двигает маркер
    if own && views::class_of(&c) == views::Class::Message {
        let m = ReadMark { chat: Some(p.clone()), up_to_ts_ms: ts_ms, up_to_id: op_id.to_vec() };
        e.apply_history_op(&HistoryOp { op: Some(HOp::Read(m)) }, true, &mut w.delta);
    }
}

fn val_str<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn parse_id(s: &str) -> Result<Vec<u8>> {
    if let Ok(b) = hex::decode(s) {
        if b.len() == 16 {
            return Ok(b);
        }
    }
    history::parse_id(s)
}

/// Ввод векторов `vectors/model/*` (только `config.vectors`): входящее без шифрования, операции журнала
/// истории, сведения группы.
pub(crate) fn vector_input(e: &mut Engine, args: &str) -> Result<Outcome> {
    let v: Value = serde_json::from_str(args).map_err(|_| ProtoError::Malformed)?;
    let mut w = Work::default();
    if let Some(inc) = v.get("incoming") {
        let peer: Peer = serde_json::from_value(inc.get("chat").cloned().unwrap_or(Value::Null)).map_err(|_| ProtoError::Malformed)?;
        let from = val_str(inc, "from").to_string();
        let id = parse_id(val_str(inc, "id"))?;
        let ts = inc.get("ts_ms").and_then(Value::as_i64).unwrap_or(e.now_ms);
        let (content, disposition) = match inc.get("content_hex").and_then(Value::as_str) {
            Some(h) => {
                let b = hex::decode(h).map_err(|_| ProtoError::Malformed)?;
                let d = crate::unknown::content_disposition_bytes(&b, &[])?;
                let c = if d == Disposition::StubCritical { Content::default() } else { decode_checked(&b, Origin::Client)? };
                (c, d)
            }
            None => {
                let c: Content = serde_json::from_value(inc.get("content").cloned().unwrap_or(Value::Null)).map_err(|_| ProtoError::Malformed)?;
                let d = crate::unknown::content_disposition(&c, &[]);
                (c, d)
            }
        };
        e.incoming(peer, &from, &id, ts, content, disposition, &[], &mut w);
    }
    if let Some(Value::Array(ops)) = v.get("history") {
        for op in ops {
            let op = history_op_from_short(op)?;
            e.apply_history_op(&op, false, &mut w.delta);
        }
    }
    if let Some(g) = v.get("group") {
        let id = hex::decode(val_str(g, "id")).map_err(|_| ProtoError::Malformed)?;
        let perms: gpb::Permissions = serde_json::from_value(g.get("perms").cloned().unwrap_or(Value::Null)).map_err(|_| ProtoError::Malformed)?;
        let mut f = super::capabilities::GroupFacts {
            group: Ref { domain: val_str(g, "domain").to_string(), id: id.clone() },
            channel: val_str(g, "kind") == "channel",
            title: val_str(g, "title").to_string(),
            owner: val_str(g, "owner").to_string(),
            perms,
            version: g.get("version").and_then(Value::as_u64).unwrap_or(1),
            ..Default::default()
        };
        if let Some(Value::Object(m)) = g.get("members") {
            for (u, role) in m {
                let r = if role.as_str() == Some("admin") { gpb::Role::Admin } else { gpb::Role::Member };
                let rights = if r == gpb::Role::Admin {
                    gpb::AdminRights { delete_messages: true, pin_messages: true, ..Default::default() }
                } else {
                    Default::default()
                };
                f.members.insert(u.clone(), (r as i32, rights, 0));
            }
        }
        w.delta.push(Change::GroupChanged(f.view(&e.cfg.user)));
        let key = format!("g:{}", hex::encode(&id));
        e.peers.entry(key.clone()).or_insert_with(|| group_peer(&f.group));
        e.dirty.chats.insert(key);
        e.groups.insert(id, f);
    }
    if let Some(n) = v.get("now_ms").and_then(Value::as_i64) {
        e.now_ms = n;
    }
    // spec 035 (T068): чтение журнала истории сейчас (опрос без ожидания срока)
    if v.get("history_pull").and_then(Value::as_bool) == Some(true) {
        e.history_pull(&mut w);
    }
    e.finish(w)
}

/// Краткая запись операции истории векторов: `{"row": {"chat": "<адрес>", "id", "from", "ts_ms", "content": <wire>}}`,
/// `{"gone"|"edit"|"react"|"pin"|"read": …}` либо полная форма `HistoryOp` proto3-JSON.
fn history_op_from_short(v: &Value) -> Result<HistoryOp> {
    let peer_of = |x: &Value| -> Peer {
        match x.get("group").and_then(Value::as_str) {
            Some(g) => group_peer(&Ref { domain: "local".into(), id: hex::decode(g).unwrap_or_default() }),
            None => user_peer(val_str(x, "chat")),
        }
    };
    if let Some(r) = v.get("row") {
        let content = r.get("content").cloned().unwrap_or(Value::Null);
        let reply = r.get("reply_to").and_then(Value::as_str).map(parse_id).transpose()?;
        return Ok(history::row_op(MessageRow {
            id: parse_id(val_str(r, "id"))?,
            chat: Some(peer_of(r)),
            from: val_str(r, "from").to_string(),
            ts_ms: r.get("ts_ms").and_then(Value::as_i64).unwrap_or(0),
            body: views::row_body(content, reply.as_deref()),
        }));
    }
    if let Some(g) = v.get("gone") {
        let scope = if val_str(g, "scope") == "me" { GoneScope::Me } else { GoneScope::Everyone };
        return Ok(history::gone_op(Gone {
            target: parse_id(val_str(g, "target"))?,
            chat: Some(peer_of(g)),
            stamp: Some(crate::pb::parvane::history::v1::Stamp { ts_ms: g.get("ts_ms").and_then(Value::as_i64).unwrap_or(0), op_id: parse_id(val_str(g, "op_id"))? }),
            scope: scope as i32,
            by: val_str(g, "by").to_string(),
            by_admin: false,
        }));
    }
    if let Some(r) = v.get("read") {
        return Ok(HistoryOp {
            op: Some(HOp::Read(ReadMark {
                chat: Some(peer_of(r)),
                up_to_ts_ms: r.get("ts_ms").and_then(Value::as_i64).unwrap_or(0),
                up_to_id: parse_id(val_str(r, "id"))?,
            })),
        });
    }
    serde_json::from_value(v.clone()).map_err(|_| ProtoError::Malformed)
}

/// Вложение автора с другого сервера лежит на его сервере (spec 028): прежние клиенты не ставили домен блоба —
/// строка модели несёт его сама (скачивание и пересылка знают сервер блоба; раньше это делал хост web).
pub(crate) fn note_blob_domain(c: &mut Content, from: &str, own_domain: &str) {
    let Some((_, domain)) = from.rsplit_once('@') else { return };
    let domain = domain.to_ascii_lowercase();
    if domain.is_empty() || domain == own_domain.to_ascii_lowercase() {
        return;
    }
    let fill = |d: &mut String| {
        if d.is_empty() {
            *d = domain.clone();
        }
    };
    match c.kind.as_mut() {
        Some(content::Kind::Media(m)) => fill(&mut m.blob_domain),
        Some(content::Kind::Sticker(st)) => {
            if let Some(m) = st.media.as_mut() {
                fill(&mut m.blob_domain);
            }
            if let Some(pr) = st.pack_ref.as_mut() {
                fill(&mut pr.blob_domain);
            }
        }
        Some(content::Kind::Text(t)) => t.emoji_packs.iter_mut().for_each(|pr| fill(&mut pr.blob_domain)),
        _ => {}
    }
}

#[cfg(test)]
mod blob_domain_tests {
    use super::*;
    use crate::pb::parvane::msg::v2::{Media, Text};

    #[test]
    fn foreign_author_media_gets_author_domain() {
        let mut c = Content { kind: Some(content::Kind::Media(Media::default())), ..Default::default() };
        note_blob_domain(&mut c, "bob@b.example", "a.example");
        let Some(content::Kind::Media(m)) = &c.kind else { panic!() };
        assert_eq!(m.blob_domain, "b.example");
        let mut own = Content { kind: Some(content::Kind::Media(Media::default())), ..Default::default() };
        note_blob_domain(&mut own, "alice@a.example", "a.example");
        let Some(content::Kind::Media(m)) = &own.kind else { panic!() };
        assert!(m.blob_domain.is_empty(), "свой сервер — без домена");
        let mut set = Content { kind: Some(content::Kind::Media(Media { blob_domain: "c.example".into(), ..Default::default() })), ..Default::default() };
        note_blob_domain(&mut set, "bob@b.example", "a.example");
        let Some(content::Kind::Media(m)) = &set.kind else { panic!() };
        assert_eq!(m.blob_domain, "c.example", "заданный не меняется");
        let mut t = Content { kind: Some(content::Kind::Text(Text::default())), ..Default::default() };
        note_blob_domain(&mut t, "bob", "a.example");
    }
}
