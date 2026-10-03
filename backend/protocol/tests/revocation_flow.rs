//! Отзыв устройства и право доставки (T124, T075, T121, T074) на мини-сервере
//! в памяти: те же проверки, что делают шарды (ключ доступа по хэшу, жетоны,
//! журналы устройств и групп), упрощённо.
//!
//! Часы движка подменены (`time::set_clock`): смена эпохи группы не чаще
//! раза в 10 с — тест двигает время вперёд.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};

use parvane_protocol::client::{Chan, Client, ClientError, Event, Need, OutRequest, RevocationOutcome};
use parvane_protocol::codec::decode_checked;
use parvane_protocol::group::{self, SignerInfo};
use parvane_protocol::identity::{DeviceLog, RootIdentity};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{sealed_envelope::Access, GroupStateEntry, Ref, SignedOp};
use parvane_protocol::pb::parvane::group::v2::{self as gpb, GroupKind, Permissions};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, inbox_record, Content, InboxRecord, ReceiptKind, Text};
use parvane_protocol::state::StateKey;
use parvane_protocol::tokens::{self, Issuer};
use prost::Message;
use sha2::{Digest, Sha256};

static NOW: AtomicI64 = AtomicI64::new(0);

fn clock() -> i64 {
    NOW.load(Ordering::SeqCst)
}

fn init_clock() {
    if NOW.load(Ordering::SeqCst) == 0 {
        NOW.store(1_900_000_000_000, Ordering::SeqCst);
    }
    parvane_protocol::time::set_clock(clock);
}

fn advance(ms: i64) {
    NOW.fetch_add(ms, Ordering::SeqCst);
}

#[derive(Default)]
struct Server {
    logs: HashMap<String, Vec<SignedOp>>,
    otks: HashMap<(String, String), Vec<ipb::OneTimeKey>>,
    fallback: HashMap<(String, String), ipb::OneTimeKey>,
    dk: HashMap<String, [u8; 32]>,
    spent: HashSet<[u8; 32]>,
    inbox: HashMap<(String, String), Vec<InboxRecord>>,
    groups: HashMap<Vec<u8>, Vec<GroupStateEntry>>,
    /// Прочитано устройством (курсор теста).
    read_upto: HashMap<(String, String), usize>,
}

#[derive(Debug, PartialEq)]
enum SrvErr {
    Forbidden,
    Duplicate,
}

impl Server {
    fn log(&self, user: &str) -> DeviceLog {
        let mut l = DeviceLog::new(user).unwrap();
        for e in self.logs.get(user).into_iter().flatten() {
            l.apply(e).unwrap();
        }
        l
    }

    fn push(&mut self, user: &str, device: &str, item: inbox_record::Item) {
        let q = self.inbox.entry((user.into(), device.into())).or_default();
        let seq = q.len() as u64 + 1;
        q.push(InboxRecord { seq, received_ms: 0, item: Some(item) });
    }

    fn resolve_group(&self, gid: &[u8]) -> Option<group::GroupState> {
        let resolve = |k: &[u8; 32]| {
            self.logs.keys().find_map(|u| {
                let l = self.log(u);
                // Подписант — любое когда-либо сертифицированное устройство (упрощённо).
                l.devices.values().any(|d| d.cert.olm_ed25519.as_slice() == k).then(|| SignerInfo { user: u.clone(), root_key: l.root_key })
            })
        };
        let mut st = None;
        for e in self.groups.get(gid).into_iter().flatten() {
            st = Some(group::apply(st.as_ref(), e, &resolve).unwrap());
        }
        st
    }

    fn append_log(&mut self, user: &str, op: SignedOp) {
        let before = self.log(user);
        let mut l = before.clone();
        l.apply(&op).expect("журнал устройств");
        self.logs.entry(user.into()).or_default().push(op);
        // Отзыв: уведомление в журналы инбокса устройств пользователя.
        for id in l.revoked.difference(&before.revoked) {
            let all: Vec<String> = before.devices.keys().cloned().collect();
            for d in all {
                self.push(user, &d, inbox_record::Item::DeviceRevoked(mpb::DeviceRevokedNotice { device_id: id.clone() }));
            }
        }
    }

    fn handle(&mut self, user: &str, device: &str, r: &OutRequest) -> Result<(), SrvErr> {
        match r.method {
            "identity.device.log_append" => {
                let q: ipb::DeviceLogAppendRequest = decode_checked(&r.body, Origin::Client).unwrap();
                self.append_log(user, q.entry.unwrap());
            }
            // Сброс личности: журнал пользователя начинается заново с нового генезиса.
            "identity.root.rotate" => {
                let q: ipb::RootRotateRequest = decode_checked(&r.body, Origin::Client).unwrap();
                self.logs.insert(user.into(), vec![q.genesis.unwrap()]);
            }
            "identity.device.publish_certificate" => {
                let q: ipb::DevicePublishCertificateRequest = decode_checked(&r.body, Origin::Client).unwrap();
                if let Some(op) = q.log_entry.filter(|e| !e.body.is_empty()) {
                    self.append_log(user, op);
                }
                self.otks.entry((user.into(), device.into())).or_default().extend(q.one_time_keys);
                if let Some(f) = q.fallback_key {
                    self.fallback.insert((user.into(), device.into()), f);
                }
            }
            "identity.delivery_key.set" => {
                let q: ipb::DeliveryKeySetRequest = decode_checked(&r.body, Origin::Client).unwrap();
                self.dk.insert(user.into(), Sha256::digest(&q.delivery_key).into());
            }
            "msg.deliver_sealed" => {
                assert_eq!(r.chan, Chan::Anon);
                let q: mpb::DeliverSealedRequest = decode_checked(&r.body, Origin::Client).unwrap();
                let first = q.envelopes.first().unwrap();
                let to = first.recipient.clone().unwrap().address;
                // D-05: один получатель на запрос.
                assert!(q.envelopes.iter().all(|e| e.recipient.as_ref().unwrap().address == to), "один получатель");
                match first.access.as_ref().unwrap() {
                    Access::DeliveryKey(k) => {
                        let h: [u8; 32] = Sha256::digest(k).into();
                        if Some(&h) != self.dk.get(&to) {
                            return Err(SrvErr::Forbidden);
                        }
                    }
                    Access::AnonToken(t) => {
                        if !self.spent.insert(tokens::spent_id(t)) {
                            return Err(SrvErr::Duplicate);
                        }
                    }
                }
                let active = self.log(&to);
                for e in q.envelopes {
                    let rc = e.recipient.clone().unwrap();
                    if active.active(&rc.device_id).is_some() {
                        self.push(&rc.address, &rc.device_id, inbox_record::Item::Sealed(e));
                    }
                }
            }
            "group.state.append" | "group.epoch.publish_send_key" => {
                let entry = if r.method == "group.state.append" {
                    decode_checked::<gpb::StateAppendRequest>(&r.body, Origin::Client).unwrap().entry.unwrap()
                } else {
                    decode_checked::<gpb::EpochPublishSendKeyRequest>(&r.body, Origin::Client).unwrap().entry.unwrap()
                };
                let gid = entry.group.clone().unwrap().id;
                self.groups.entry(gid.clone()).or_default().push(entry);
                assert!(self.resolve_group(&gid).is_some(), "запись группы");
            }
            "msg.deliver_group" => {
                let q: mpb::DeliverGroupRequest = decode_checked(&r.body, Origin::Client).unwrap();
                let env = q.envelope.unwrap();
                let gid = env.group.clone().unwrap().id;
                let st = self.resolve_group(&gid).unwrap();
                if group::verify_envelope(&env, st.epoch, &st.send_public_key.unwrap()).is_err() {
                    return Err(SrvErr::Forbidden);
                }
                for m in st.members.keys() {
                    for d in self.log(m).devices.keys() {
                        self.push(m, d, inbox_record::Item::Group(env.clone()));
                    }
                }
            }
            other => panic!("мини-сервер: {other}"),
        }
        Ok(())
    }

    fn bundle(&mut self, user: &str) -> Vec<ipb::DeviceBundle> {
        let log = self.log(user);
        log.devices
            .iter()
            .map(|(d, v)| {
                // Сертификат из журнала (последняя запись AddDevice этого устройства).
                let cert = self.logs[user].iter().rev().find_map(|op| {
                    let b = parvane_protocol::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()).ok()?;
                    let e = parvane_protocol::pb::parvane::core::v2::UserDeviceLogEntry::decode(b.payload.as_slice()).ok()?;
                    match e.change? {
                        parvane_protocol::pb::parvane::core::v2::user_device_log_entry::Change::AddDevice(c) => {
                            let x = parvane_protocol::identity::verify_certificate(&c, Some(user)).ok()?;
                            (x.cert == v.cert).then_some(c)
                        }
                        _ => None,
                    }
                });
                ipb::DeviceBundle {
                    certificate: cert,
                    one_time_key: self.otks.get_mut(&(user.into(), d.clone())).and_then(|v| v.pop()),
                    fallback_key: self.fallback.get(&(user.into(), d.clone())).cloned(),
                }
            })
            .collect()
    }
}

fn satisfy(srv: &mut Server, c: &mut Client, n: Need) {
    match n {
        Need::PeerLog { user, .. } => {
            let after = c.log_version(&user) as usize;
            let entries = srv.logs.get(&user).map(|v| v[after.min(v.len())..].to_vec()).unwrap_or_default();
            c.ingest_log(&user, entries).unwrap();
        }
        Need::Bundle { user } => {
            // Свой журнал мог устареть — догнать перед бандлом.
            let after = c.log_version(&user) as usize;
            let entries = srv.logs.get(&user).map(|v| v[after.min(v.len())..].to_vec()).unwrap_or_default();
            c.ingest_log(&user, entries).unwrap();
            let b = srv.bundle(&user);
            c.ingest_bundle(&user, b).unwrap();
        }
        Need::GroupLog { group, after } => {
            let entries = srv.groups.get(&group).map(|v| v[after as usize..].to_vec()).unwrap_or_default();
            c.group_ingest(&Ref { domain: "local".into(), id: group }, entries).unwrap();
        }
        other => panic!("не умеем добрать: {other:?}"),
    }
}

fn exec(srv: &mut Server, c: &Client, reqs: &[OutRequest]) {
    for r in reqs {
        srv.handle(&c.user, &c.device_id, r).unwrap_or_else(|e| panic!("{} {}: {e:?}", c.user, r.method));
    }
}

fn run(srv: &mut Server, c: &mut Client, op: &mut dyn FnMut(&mut Client) -> Result<Vec<OutRequest>, ClientError>) {
    for _ in 0..10 {
        match op(c) {
            Ok(reqs) => return exec(srv, c, &reqs),
            Err(ClientError::Need(n)) => satisfy(srv, c, n),
            Err(e) => panic!("{e:?}"),
        }
    }
    panic!("не сошлось");
}

fn revoke(srv: &mut Server, c: &mut Client, device: &str) -> RevocationOutcome {
    for _ in 0..10 {
        match c.revoke_device(device) {
            Ok(o) => {
                exec(srv, c, &o.requests);
                return o;
            }
            Err(ClientError::Need(n)) => satisfy(srv, c, n),
            Err(e) => panic!("{e:?}"),
        }
    }
    panic!("не сошлось");
}

/// Прочитать новые записи журнала устройства.
fn drain(srv: &mut Server, c: &mut Client) -> Vec<Event> {
    let key = (c.user.clone(), c.device_id.clone());
    let recs = srv.inbox.get(&key).cloned().unwrap_or_default();
    let from = srv.read_upto.get(&key).copied().unwrap_or(0);
    srv.read_upto.insert(key, recs.len());
    let mut out = vec![];
    for r in &recs[from.min(recs.len())..] {
        let bytes = r.encode_to_vec();
        for _ in 0..10 {
            match c.open_record(&bytes) {
                Ok(ev) => {
                    for e in &ev {
                        if let Event::GroupChanged { group, .. } = e {
                            sync_group(srv, c, &group.id);
                            out.extend(c.drain_ready());
                        }
                    }
                    out.extend(ev);
                    break;
                }
                Err(ClientError::Need(n)) => satisfy(srv, c, n),
                Err(e) => panic!("{e:?}"),
            }
        }
    }
    out
}

fn sync_group(srv: &mut Server, c: &mut Client, gid: &[u8]) {
    for _ in 0..10 {
        let after = c.group_version(gid) as usize;
        let entries = srv.groups.get(gid).map(|v| v[after.min(v.len())..].to_vec()).unwrap_or_default();
        match c.group_ingest(&Ref { domain: "local".into(), id: gid.to_vec() }, entries) {
            Ok(_) => return,
            Err(ClientError::Need(n)) => satisfy(srv, c, n),
            Err(e) => panic!("{e:?}"),
        }
    }
}

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
}

fn texts(ev: &[Event]) -> Vec<(String, String)> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Direct { from, content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some((from.clone(), t.text.clone())),
            Event::Group { from, content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some((format!("group:{from}"), t.text.clone())),
            _ => None,
        })
        .collect()
}

fn sync_own_log(srv: &Server, c: &mut Client) {
    let u = c.user.clone();
    let after = c.log_version(&u) as usize;
    let entries = srv.logs[&u][after..].to_vec();
    c.ingest_log(&u, entries).unwrap();
}

fn sync_peer_log(srv: &Server, c: &mut Client, user: &str) {
    let after = c.log_version(user) as usize;
    let entries = srv.logs[user][after..].to_vec();
    c.ingest_log(user, entries).unwrap();
}

fn setup(srv: &mut Server, user: &str) -> (Client, RootIdentity) {
    let mut c = Client::new(user, "d1", "local").unwrap();
    let (reqs, root) = c.create_identity(20).unwrap();
    exec(srv, &c, &reqs);
    (c, root)
}

fn link(srv: &mut Server, primary: &mut Client, device: &str) -> Client {
    let mut c = Client::new(&primary.user, device, "local").unwrap();
    let (ssk, entries, dk, gen) = primary.link_grant_material().unwrap();
    let reqs = c.join_with_ssk(ssk, entries, dk, gen, 20).unwrap();
    exec(srv, &c, &reqs);
    sync_own_log(srv, primary);
    c
}

#[test]
fn revocation_rotates_keys_epochs_and_ssk() {
    init_clock();
    let mut srv = Server::default();
    let (mut alice, root) = setup(&mut srv, "alice@local");
    let (mut bob, _) = setup(&mut srv, "bob@local");
    let mut alice2 = link(&mut srv, &mut alice, "d2");
    let mut alice3 = link(&mut srv, &mut alice, "d3");
    sync_own_log(&srv, &mut alice2);
    // Ключ личного состояния — общий для устройств Алисы.
    let sk = StateKey::generate();
    alice.set_state_key(sk.clone(), 1);
    alice3.set_state_key(sk.clone(), 1);
    alice2.set_state_key(sk, 1);

    // Знакомство: Боб знает ключ Алисы «из профиля», дальше — раздача по E2E.
    bob.set_peer_delivery_key("alice@local", alice.delivery_key().to_vec(), 1);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("привет")));
    for c in [&mut alice, &mut alice2, &mut alice3] {
        assert!(texts(&drain(&mut srv, c)).contains(&("bob@local".into(), "привет".into())));
    }
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("и тебе")));
    assert!(texts(&drain(&mut srv, &mut bob)).contains(&("alice@local".into(), "и тебе".into())));
    for c in [&mut alice2, &mut alice3] {
        drain(&mut srv, c);
    }

    // Группа Алисы с Бобом, эпоха 1.
    let perms = Permissions { send_messages: true, send_media: true, send_stickers_gifs: true, send_polls: true, embed_links: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "Семья", &["bob@local".to_string()], perms).unwrap();
    exec(&mut srv, &alice, &[req]);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("эпоха 1")));
    assert!(texts(&drain(&mut srv, &mut bob)).contains(&("group:alice@local".into(), "эпоха 1".into())));
    for c in [&mut alice2, &mut alice3] {
        assert!(texts(&drain(&mut srv, c)).contains(&("group:alice@local".into(), "эпоха 1".into())));
    }
    let old_dk = *alice.delivery_key();
    let gen0 = alice.delivery_key_generation();

    // ── отзыв d2 с d1 ──
    advance(11_000);
    let o = revoke(&mut srv, &mut alice, "d2");
    assert!(o.ssk_rotation_required, "d2 держало SSK");
    assert_eq!(o.state_key_version, Some(2));
    assert!(o.pending_key_shares.is_empty() && o.pending_epochs.is_empty() && o.epochs_need_admin.is_empty(), "{o:?}");
    assert_eq!(o.requests[0].method, "identity.device.log_append");
    assert!(o.requests.iter().any(|r| r.method == "identity.delivery_key.set"));
    assert!(o.requests.iter().any(|r| r.method == "group.epoch.publish_send_key"));
    assert_ne!(*alice.delivery_key(), old_dk);
    assert_eq!(alice.delivery_key_generation(), gen0 + 1);
    assert_eq!(alice.group_state(&g.id).unwrap().epoch, 2);
    // Повторный вызов ничего не делает.
    assert_eq!(alice.on_own_device_revoked("d2").unwrap(), RevocationOutcome::default());
    assert!(alice.ssk_pending("alice@local"));

    // Своё оставшееся устройство: новый ключ доступа и ключ состояния по E2E.
    let ev3 = drain(&mut srv, &mut alice3);
    assert!(ev3.contains(&Event::DeviceRevoked { seq: ev3.iter().find_map(|e| if let Event::DeviceRevoked { seq, .. } = e { Some(*seq) } else { None }).unwrap(), device_id: "d2".into() }));
    assert!(ev3.iter().any(|e| matches!(e, Event::StateKeyRotated { key_version: 2, .. })), "{ev3:?}");
    assert_eq!(alice3.state_key().unwrap().0.as_bytes(), alice.state_key().unwrap().0.as_bytes());
    assert_eq!(alice3.delivery_key(), alice.delivery_key());

    // Боб: получил новый ключ доступа и ключи новой эпохи; видит KEY-1 до смены SSK.
    drain(&mut srv, &mut bob);
    sync_peer_log(&srv, &mut bob, "alice@local");
    assert!(bob.ssk_pending("alice@local"));
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("после отзыва")));
    assert!(texts(&drain(&mut srv, &mut alice)).contains(&("bob@local".into(), "после отзыва".into())));

    // Отозванное устройство: старый ключ доступа сервер отвергает…
    let mut own_copy = None;
    for _ in 0..10 {
        match alice2.prepare_direct("bob@local", &text("я украденное")) {
            Ok(r) => {
                own_copy = Some(r);
                break;
            }
            Err(ClientError::Need(n)) => satisfy(&mut srv, &mut alice2, n),
            Err(e) => panic!("{e:?}"),
        }
    }
    let reqs = own_copy.unwrap();
    for r in &reqs {
        // К Бобу доставка проходит (его ключ не менялся), но Боб отвергает
        // сообщение отозванного устройства по журналу Алисы.
        let _ = srv.handle("alice@local", "d2", r);
    }
    assert!(!texts(&drain(&mut srv, &mut bob)).iter().any(|(_, t)| t == "я украденное"));
    // …и новую эпоху группы отозванное устройство не читает.
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("эпоха 2")));
    let bob_ev = drain(&mut srv, &mut bob);
    assert!(texts(&bob_ev).contains(&("group:alice@local".into(), "эпоха 2".into())), "{bob_ev:?}");
    let env = srv.inbox[&("bob@local".to_string(), "d1".to_string())]
        .iter()
        .rev()
        .find_map(|r| match &r.item {
            Some(inbox_record::Item::Group(e)) => Some(e.clone()),
            _ => None,
        })
        .unwrap();
    sync_group(&mut srv, &mut alice2, &g.id);
    let rec = InboxRecord { seq: 10_000, received_ms: 0, item: Some(inbox_record::Item::Group(env)) }.encode_to_vec();
    let got = alice2.open_record(&rec).unwrap();
    assert!(texts(&got).is_empty() && texts(&alice2.drain_ready()).is_empty(), "отозванное устройство прочитало эпоху 2");

    // ── смена SSK корнем ──
    // Хост даёт секрет корня из резервной копии под ключом восстановления (T128).
    assert!(alice.own_ssk_exposed(), "отозван держатель SSK — нужна смена");
    assert!(alice.rotate_ssk_with_secret(&[9u8; 32]).is_err(), "чужой корень принят");
    let reqs = alice.rotate_ssk_with_secret(&root.root.to_bytes()).unwrap();
    exec(&mut srv, &alice, &reqs);
    assert!(!alice.own_ssk_exposed());
    assert!(!alice.ssk_pending("alice@local"));
    sync_peer_log(&srv, &mut bob, "alice@local");
    assert!(!bob.ssk_pending("alice@local"), "после смены SSK предупреждения нет");
    // Пересертифицированные устройства продолжают переписку.
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("новый SSK")));
    assert!(texts(&drain(&mut srv, &mut bob)).contains(&("alice@local".into(), "новый SSK".into())));
    sync_own_log(&srv, &mut alice3);
    assert!(alice3.link_grant_material().is_err(), "SSK остался только на d1");
    drain(&mut srv, &mut alice3);
    run(&mut srv, &mut alice3, &mut |c| c.prepare_direct("bob@local", &text("с d3")));
    assert!(texts(&drain(&mut srv, &mut bob)).contains(&("alice@local".into(), "с d3".into())));
    // Отзыв d3 (без SSK) смену SSK не требует.
    advance(11_000);
    drain(&mut srv, &mut alice);
    let o = revoke(&mut srv, &mut alice, "d3");
    assert!(!o.ssk_rotation_required);
    assert_eq!(o.state_key_version, Some(3));
}

#[test]
fn receipts_and_read_tracking() {
    init_clock();
    let mut srv = Server::default();
    let (mut alice, _) = setup(&mut srv, "alice@local");
    let (mut bob, _) = setup(&mut srv, "bob@local");
    let (mut carol, _) = setup(&mut srv, "carol@local");
    for p in [&mut bob, &mut carol] {
        p.set_peer_delivery_key("alice@local", alice.delivery_key().to_vec(), 1);
        run(&mut srv, p, &mut |c| c.prepare_direct("alice@local", &text("привет")));
    }
    drain(&mut srv, &mut alice);
    // Боб и Кэрол знакомы (ключи Megolm в группе раздаются по E2E).
    bob.set_peer_delivery_key("carol@local", carol.delivery_key().to_vec(), 1);
    carol.set_peer_delivery_key("bob@local", bob.delivery_key().to_vec(), 1);
    // Личный чат: квитанция прочтения.
    let id = parvane_protocol::sign::new_op_id();
    let id2 = id.clone();
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct_id("bob@local", &text("читай"), id2.clone()));
    drain(&mut srv, &mut bob);
    let id3 = id.clone();
    run(&mut srv, &mut bob, &mut |c| c.prepare_receipt("alice@local", ReceiptKind::Read, std::slice::from_ref(&id3)));
    let ev = drain(&mut srv, &mut alice);
    assert!(ev.iter().any(|e| matches!(e, Event::Direct { content: Content { kind: Some(content::Kind::Receipt(_)), .. }, .. })));
    assert_eq!(alice.readers(&id).iter().map(|(u, _)| u.as_str()).collect::<Vec<_>>(), vec!["bob@local"]);

    // Группа: «кто прочитал» из E2E-квитанций, реакция и правка — события с этими видами.
    let perms = Permissions { send_messages: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "Клуб", &["bob@local".to_string(), "carol@local".to_string()], perms).unwrap();
    exec(&mut srv, &alice, &[req]);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    let gid = parvane_protocol::sign::new_op_id();
    let gid2 = gid.clone();
    run(&mut srv, &mut alice, &mut |c| c.prepare_group_id(&g.id, &text("всем"), gid2.clone()));
    for p in [&mut bob, &mut carol] {
        assert!(texts(&drain(&mut srv, p)).contains(&("group:alice@local".into(), "всем".into())));
        let r = gid.clone();
        run(&mut srv, p, &mut |c| c.prepare_group_receipt(&g.id, ReceiptKind::Read, std::slice::from_ref(&r)));
    }
    let r = gid.clone();
    run(&mut srv, &mut bob, &mut |c| c.prepare_group(&g.id, &parvane_protocol::msg::reaction(&r, "👍", false)));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &parvane_protocol::msg::edit_text(&r, Text { text: "всем!".into(), ..Default::default() })));
    drain(&mut srv, &mut alice);
    let mut readers: Vec<String> = alice.readers(&gid).into_iter().map(|(u, _)| u).collect();
    readers.sort();
    assert_eq!(readers, vec!["bob@local".to_string(), "carol@local".to_string()]);
    let ev = drain(&mut srv, &mut carol);
    assert!(ev.iter().any(|e| matches!(e, Event::Group { content: Content { kind: Some(content::Kind::Reaction(_)), .. }, .. })), "{ev:?}");
    let edit = ev.iter().find_map(|e| match e {
        Event::Group { from, content: c @ Content { kind: Some(content::Kind::Edit(_)), .. }, .. } => Some((from.clone(), c.clone())),
        _ => None,
    });
    let (from, c) = edit.expect("правка");
    assert!(parvane_protocol::msg::mutation_authorized(&c, &from, "alice@local", false));

    // D-15: квитанция незнакомцу (нет его ключа доступа) не уходит и не тратит жетонов.
    let (mut dave, _) = setup(&mut srv, "dave@local");
    let x = parvane_protocol::sign::new_op_id();
    let reqs = dave.prepare_receipt("alice@local", ReceiptKind::Read, &[x]).unwrap();
    assert!(reqs.is_empty());
}

#[test]
fn token_issue_with_foreign_key_rejected_and_batched() {
    init_clock();
    let mut srv = Server::default();
    let (mut alice, _) = setup(&mut srv, "alice@local");
    let server = parvane_protocol::sign::generate_signing_key();
    let now = clock();
    let good = Issuer::generate(now - 1000, now + 2 * 86_400_000).unwrap();
    let rogue = Issuer::generate(now - 1000, now + 2 * 86_400_000).unwrap();
    // Список ключей получен анонимно: в нём только «честный» ключ.
    let list = tokens::sign_key_list(&server, vec![good.token_key()], now);
    let spk = server.verifying_key().to_bytes();

    // Выдача чужим (помеченным) ключом — клиент отвергает.
    assert!(alice.token_refill_due(now), "первая партия — сразу");
    let req = alice.token_request(&list, &spk, 5).unwrap();
    assert_eq!(req.chan, Chan::Id);
    assert!(!alice.token_refill_due(now), "следующая партия — не раньше следующих суток");
    let next = alice.next_token_refill_ms().unwrap();
    assert!(next >= (now / 86_400_000 + 1) * 86_400_000 && next < (now / 86_400_000 + 1) * 86_400_000 + parvane_protocol::access::REFILL_JITTER_MAX_MS);
    let q: ipb::TokensIssueBlindedRequest = decode_checked(&req.body, Origin::Client).unwrap();
    let resp = ipb::TokensIssueBlindedResponse { key_id: rogue.key_id().to_vec(), public_key: rogue.spki().to_vec(), blind_signatures: rogue.issue(&q.blinded).unwrap_or_default() };
    assert_eq!(alice.token_response(&resp), Err(parvane_protocol::ProtoError::Forbidden));
    assert_eq!(alice.token_count(), 0);

    // Подмена под «честный» key_id с подписью чужим ключом — не сходится подпись.
    let req = alice.token_request(&list, &spk, 5).unwrap();
    let q: ipb::TokensIssueBlindedRequest = decode_checked(&req.body, Origin::Client).unwrap();
    // (ослеплённое под чужой модуль сообщение может не подписаться вовсе — тоже отказ)
    if let Ok(sigs) = rogue.issue(&q.blinded) {
        let resp = ipb::TokensIssueBlindedResponse { key_id: good.key_id().to_vec(), public_key: good.spki().to_vec(), blind_signatures: sigs };
        assert!(alice.token_response(&resp).is_err());
    }

    // Честная выдача — в запас; трата у мини-сервера одноразова.
    let req = alice.token_request(&list, &spk, 5).unwrap();
    let q: ipb::TokensIssueBlindedRequest = decode_checked(&req.body, Origin::Client).unwrap();
    let resp = ipb::TokensIssueBlindedResponse { key_id: good.key_id().to_vec(), public_key: good.spki().to_vec(), blind_signatures: good.issue(&q.blinded).unwrap() };
    assert_eq!(alice.token_response(&resp), Ok(5));
    assert_eq!(alice.token_count(), 5);
    assert!(alice.tokens_low());
    let (mut bob, _) = setup(&mut srv, "bob@local");
    // Первое сообщение незнакомцу: жетон на ключ доставки и жетон на сообщение.
    let mut sent = vec![];
    for _ in 0..10 {
        match alice.prepare_direct("bob@local", &text("незнакомцу")) {
            Ok(r) => {
                sent = r;
                break;
            }
            Err(ClientError::Need(n)) => satisfy(&mut srv, &mut alice, n),
            Err(e) => panic!("{e:?}"),
        }
    }
    assert_eq!(alice.token_count(), 3);
    for r in &sent {
        srv.handle("alice@local", "d1", r).unwrap();
    }
    // Повтор того же жетона — DUPLICATE (мини-сервер как messenger).
    assert_eq!(srv.handle("alice@local", "d1", &sent[0]), Err(SrvErr::Duplicate));
    assert!(texts(&drain(&mut srv, &mut bob)).contains(&("alice@local".into(), "незнакомцу".into())));
    // Жетон, чей ключ вышел из срока, не тратится.
    advance(3 * 86_400_000);
    assert_eq!(alice.token_count(), 0);
    assert!(alice.token_refill_due(clock()));
}

// ── security-code-review-us1: C1-02, C1-03 ──────────────────────────────────

/// Прочитать журнал инбокса, когда сервер ПРЯЧЕТ записи журнала группы
/// (D-03): `Need::GroupLog` не удовлетворяется, прочее добирается.
fn drain_hiding_group_log(srv: &mut Server, c: &mut Client) -> (Vec<Event>, usize) {
    let key = (c.user.clone(), c.device_id.clone());
    let recs = srv.inbox.get(&key).cloned().unwrap_or_default();
    let from = srv.read_upto.get(&key).copied().unwrap_or(0);
    srv.read_upto.insert(key, recs.len());
    let (mut out, mut group_needs) = (vec![], 0);
    for r in &recs[from.min(recs.len())..] {
        let bytes = r.encode_to_vec();
        for _ in 0..10 {
            match c.open_record(&bytes) {
                Ok(ev) => {
                    out.extend(ev);
                    break;
                }
                Err(ClientError::Need(Need::GroupLog { .. })) => {
                    group_needs += 1;
                    break;
                }
                Err(ClientError::Need(n)) => satisfy(srv, c, n),
                Err(e) => panic!("{e:?}"),
            }
        }
    }
    (out, group_needs)
}

/// C1-03 (D-03, инв. 23): сервер прячет от Боба запись журнала группы.
/// Сообщение с новой головой не теряется (Need::GroupLog, после догона
/// открывается), а Боб до догона не отправляет в группу и не раздаёт ключи —
/// исключённая Мэллори не получает ни его Megolm-ключей, ни сообщений.
#[test]
fn hidden_group_log_blocks_sending_until_caught_up() {
    init_clock();
    let mut srv = Server::default();
    let (mut alice, _) = setup(&mut srv, "alice@local");
    let (mut bob, _) = setup(&mut srv, "bob@local");
    let (mut mallory, _) = setup(&mut srv, "mallory@local");
    let all = [&mut alice, &mut bob, &mut mallory];
    let keys: Vec<(String, Vec<u8>)> = all.iter().map(|c| (c.user.clone(), c.delivery_key().to_vec())).collect();
    for c in all {
        for (u, k) in &keys {
            if *u != c.user {
                c.set_peer_delivery_key(u, k.clone(), 1);
            }
        }
    }
    let perms = Permissions { send_messages: true, send_media: true, send_stickers_gifs: true, send_polls: true, embed_links: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "Тайна", &["bob@local".to_string(), "mallory@local".to_string()], perms).unwrap();
    exec(&mut srv, &alice, &[req]);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("эпоха 1")));
    assert!(texts(&drain(&mut srv, &mut bob)).contains(&("group:alice@local".into(), "эпоха 1".into())));
    drain(&mut srv, &mut mallory);

    // 1) Сообщение ссылается на голову, которой у Боба нет: не отбрасывается.
    let r = alice.group_change(&g.id, gpb::group_change::Change::SetInfo(gpb::SetInfo { name: "Новое имя".into(), ..Default::default() })).unwrap();
    exec(&mut srv, &alice, &[r]);
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("после смены имени")));
    let (ev, needs) = drain_hiding_group_log(&mut srv, &mut bob);
    assert_eq!(needs, 1, "сообщение с новой головой требует догона журнала");
    assert!(texts(&ev).is_empty());
    let v = bob.group_version(&g.id);
    assert_eq!(bob.group_behind(&g.id), Some(v + 1));
    match bob.prepare_group(&g.id, &text("пока отстаю")) {
        Err(ClientError::Need(Need::GroupLog { after, .. })) => assert_eq!(after, v),
        other => panic!("отставший отправил: {other:?}"),
    }
    // Догон — отставание снято, то же сообщение открывается (индекс не «съеден»).
    sync_group(&mut srv, &mut bob, &g.id);
    assert_eq!(bob.group_behind(&g.id), None);
    srv.read_upto.remove(&(bob.user.clone(), bob.device_id.clone()));
    assert!(texts(&drain(&mut srv, &mut bob)).contains(&("group:alice@local".into(), "после смены имени".into())));
    drain(&mut srv, &mut mallory);

    // 2) Алиса банит Мэллори и начинает эпоху 2; сервер прячет это от Боба.
    let r = alice.group_change(&g.id, gpb::group_change::Change::Ban(gpb::Ban { member: Some(parvane_protocol::pb::parvane::core::v2::UserRef { address: "mallory@local".into() }) })).unwrap();
    exec(&mut srv, &alice, &[r]);
    // После бана без новой эпохи Алиса не пишет старыми ключами (C1-12).
    assert!(matches!(alice.prepare_group(&g.id, &text("рано")), Err(ClientError::Need(Need::GroupKeys { .. }))));
    advance(11_000);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    let (_, _) = drain_hiding_group_log(&mut srv, &mut bob);
    // Ключи эпохи 2 пришли со ссылкой на новую голову — Боб знает, что отстаёт.
    assert!(bob.group_behind(&g.id).is_some());
    let before = srv.inbox.get(&("mallory@local".to_string(), "d1".to_string())).map(|v| v.len()).unwrap_or(0);
    assert!(matches!(bob.prepare_group(&g.id, &text("секрет")), Err(ClientError::Need(Need::GroupLog { .. }))));
    let after = srv.inbox.get(&("mallory@local".to_string(), "d1".to_string())).map(|v| v.len()).unwrap_or(0);
    assert_eq!(before, after, "Мэллори ничего не получила");

    // После догона Боб пишет в эпохе 2; Мэллори не читает.
    sync_group(&mut srv, &mut bob, &g.id);
    bob.drain_ready();
    assert_eq!(bob.group_behind(&g.id), None);
    assert!(!bob.group_state(&g.id).unwrap().members.contains_key("mallory@local"));
    run(&mut srv, &mut bob, &mut |c| c.prepare_group(&g.id, &text("секрет")));
    assert!(texts(&drain(&mut srv, &mut alice)).contains(&("group:bob@local".into(), "секрет".into())));
    let mev = drain(&mut srv, &mut mallory);
    assert!(!texts(&mev).iter().any(|(_, t)| t == "секрет"), "{mev:?}");
}

/// C1-02 (инв. 31): украденное устройство с SSK отозвано; вор старым SSK
/// добавляет своё устройство — собеседник (и сервер тем же движком) отвергает
/// запись, отправитель новому устройству не шифрует.
#[test]
fn exposed_ssk_cannot_add_device_after_revocation() {
    use parvane_protocol::identity;
    use parvane_protocol::pb::parvane::core::v2::{user_device_log_entry::Change as DevChange, DeviceCertificate, OpBody, UserDeviceLogEntry, UserRef};
    init_clock();
    let mut srv = Server::default();
    let (mut alice, _) = setup(&mut srv, "alice@local");
    let (mut bob, _) = setup(&mut srv, "bob@local");
    let alice2 = link(&mut srv, &mut alice, "d2");
    // Вор забрал SSK вместе с d2.
    let (stolen_ssk, _, _, _) = alice2.link_grant_material().unwrap();
    bob.set_peer_delivery_key("alice@local", alice.delivery_key().to_vec(), 1);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("привет")));
    advance(11_000);
    let o = revoke(&mut srv, &mut alice, "d2");
    assert!(o.ssk_rotation_required);
    sync_peer_log(&srv, &mut bob, "alice@local");
    assert!(bob.ssk_pending("alice@local"));

    // Запись «добавить evil», подписанная старым SSK (с доказательством владения).
    let ssk = ed25519_dalek::SigningKey::from_bytes(&stolen_ssk);
    let log = srv.log("alice@local");
    let genesis = &srv.logs["alice@local"][0];
    let body = OpBody::decode(genesis.body.as_slice()).unwrap();
    let Some(DevChange::RotateSelfSigningKey(r)) = UserDeviceLogEntry::decode(body.payload.as_slice()).unwrap().change else { panic!() };
    let evil_key = parvane_protocol::sign::generate_signing_key();
    let mut cert = DeviceCertificate {
        user: Some(UserRef { address: "alice@local".into() }),
        device_id: "evil".into(),
        olm_curve25519: vec![9; 32],
        olm_ed25519: evil_key.verifying_key().to_bytes().to_vec(),
        hpke_x25519: vec![8; 32],
        proto_major: 2,
        serial: 1,
        ..Default::default()
    };
    identity::prove_possession(&evil_key, &mut cert, &log.root_key).unwrap();
    let signed = identity::sign_certificate(&ssk, &log.root_key, r.root_signature, &cert);
    let e = identity::device_log_entry("alice@local", log.version + 1, log.head_hash, DevChange::AddDevice(signed), None);
    let op = identity::sign_device_log_entry(&ssk, &e).unwrap();
    assert_eq!(bob.ingest_log("alice@local", vec![op.clone()]), Err(parvane_protocol::ProtoError::Forbidden));
    let mut server_view = srv.log("alice@local");
    assert_eq!(server_view.apply(&op), Err(parvane_protocol::ProtoError::Forbidden));
    // Боб по-прежнему пишет только d1.
    let (v2, _) = bob.log_devices("alice@local");
    assert_eq!(v2, vec!["d1".to_string()]);
}

/// T130 (FR-066): новое устройство без других устройств — восстановление по
/// корню (из копии под ключом восстановления). Прежние устройства отзываются,
/// SSK меняется, собеседник продолжает переписку без предупреждения о корне.
#[test]
fn recovery_with_root_replaces_devices() {
    init_clock();
    let mut srv = Server::default();
    let (mut alice, root) = setup(&mut srv, "alice@local");
    let (mut bob, _) = setup(&mut srv, "bob@local");
    let mut alice2 = link(&mut srv, &mut alice, "d2");
    bob.set_peer_delivery_key("alice@local", alice.delivery_key().to_vec(), 1);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("до потери")));
    assert!(texts(&drain(&mut srv, &mut alice)).contains(&("bob@local".into(), "до потери".into())));
    drain(&mut srv, &mut alice2);

    // Оба устройства потеряны; новое устройство d9 с корнем из копии.
    let mut alice9 = Client::new("alice@local", "d9", "local").unwrap();
    let entries = srv.logs["alice@local"].clone();
    assert!(alice9.recover_with_root(&[7u8; 32], entries.clone(), 20).is_err(), "чужой корень принят");
    let mut alice9 = Client::new("alice@local", "d9", "local").unwrap();
    let reqs = alice9.recover_with_root(&root.root.to_bytes(), entries, 20).unwrap();
    assert_eq!(reqs[0].method, "identity.device.log_append", "первой — смена SSK корнем");
    assert!(reqs.iter().any(|r| r.method == "identity.delivery_key.set"), "новый ключ доступа к доставке");
    exec(&mut srv, &alice9, &reqs);
    let (v2, _) = alice9.log_devices("alice@local");
    assert_eq!(v2, vec!["d9".to_string()], "в журнале осталось только новое устройство");
    assert!(!alice9.own_ssk_exposed());

    // Боб догоняет журнал: корень тот же — без KEY-1; пишет новому устройству.
    sync_peer_log(&srv, &mut bob, "alice@local");
    assert!(!bob.ssk_pending("alice@local"));
    // Ключ доступа у Алисы новый (прежний держали потерянные устройства).
    bob.set_peer_delivery_key("alice@local", alice9.delivery_key().to_vec(), 2);
    advance(1_000);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("после восстановления")));
    assert!(texts(&drain(&mut srv, &mut alice9)).contains(&("bob@local".into(), "после восстановления".into())));
    assert!(!texts(&drain(&mut srv, &mut alice)).iter().any(|t| t.1 == "после восстановления"), "прежнее устройство читает");
    // Ключ доступа Боба новое устройство не знает (в жизни — слепой жетон).
    alice9.set_peer_delivery_key("bob@local", bob.delivery_key().to_vec(), 1);
    run(&mut srv, &mut alice9, &mut |c| c.prepare_direct("bob@local", &text("я вернулась")));
    assert!(texts(&drain(&mut srv, &mut bob)).contains(&("alice@local".into(), "я вернулась".into())));
}

/// T129/T130 (FR-019, KEY-1 v2): сброс личности — новый корень и журнал взамен
/// прежних. Собеседник по отпечатку журнала видит замену, перечитывает журнал
/// целиком, получает «корень сменился», принимает после предупреждения.
#[test]
fn identity_reset_is_seen_as_root_change() {
    use parvane_protocol::client::LogVerdict;
    use parvane_protocol::identity::device_log_hash;
    init_clock();
    let mut srv = Server::default();
    let (mut alice, _) = setup(&mut srv, "alice@local");
    let (mut bob, _) = setup(&mut srv, "bob@local");
    bob.set_peer_delivery_key("alice@local", alice.delivery_key().to_vec(), 1);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("привет")));
    drain(&mut srv, &mut alice);
    let old_genesis = bob.log_genesis("alice@local").unwrap();
    assert_eq!(old_genesis, device_log_hash(&srv.logs["alice@local"][0]));

    // Отпечаток прежний — обычный синк.
    assert_eq!(bob.ingest_log_sync("alice@local", vec![], &old_genesis).unwrap(), LogVerdict::Known);

    // Новое устройство Алисы сбрасывает личность (ни устройств, ни ключа восстановления).
    let mut alice9 = Client::new("alice@local", "d9", "local").unwrap();
    let (reqs, new_root) = alice9.reset_identity(20).unwrap();
    assert_eq!(reqs[0].method, "identity.root.rotate");
    exec(&mut srv, &alice9, &reqs);
    let new_genesis = device_log_hash(&srv.logs["alice@local"][0]);
    assert_ne!(new_genesis, old_genesis);
    assert_eq!(alice9.log_genesis("alice@local").unwrap(), new_genesis);
    assert!(alice9.export_root_backup(&new_root.root.to_bytes(), &parvane_protocol::recovery::RecoveryKey::generate()).is_ok());

    // Прежнее устройство Алисы: свой журнал заменён — оно вне новой личности.
    assert_eq!(alice.ingest_log_sync("alice@local", vec![], &new_genesis).unwrap(), LogVerdict::Replaced);

    // Боб: по дельте — «заменён»; по полному журналу — «корень сменился».
    let after = bob.log_version("alice@local") as usize;
    let delta = srv.logs["alice@local"].get(after..).map(<[_]>::to_vec).unwrap_or_default();
    assert_eq!(bob.ingest_log_sync("alice@local", delta, &new_genesis).unwrap(), LogVerdict::Replaced);
    let full = srv.logs["alice@local"].clone();
    assert_eq!(bob.ingest_log_sync("alice@local", full, &new_genesis).unwrap(), LogVerdict::RootChanged);
    // До подтверждения отправка стоит.
    assert!(matches!(bob.prepare_direct("alice@local", &text("кто ты")), Err(ClientError::Need(Need::RootChanged { .. }))));
    assert!(bob.accept_pending_root("alice@local").unwrap());
    assert!(!bob.accept_pending_root("alice@local").unwrap(), "повторно принимать нечего");
    assert_eq!(bob.log_genesis("alice@local").unwrap(), new_genesis);
    bob.set_peer_delivery_key("alice@local", alice9.delivery_key().to_vec(), 2);
    advance(1_000);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("после сброса")));
    assert!(texts(&drain(&mut srv, &mut alice9)).contains(&("bob@local".into(), "после сброса".into())));

    // Тот же корень, но другой журнал (откат/форк) — не принимается.
    let (carol, _) = setup(&mut srv, "carol@local");
    sync_peer_log(&srv, &mut bob, "carol@local");
    let carol_genesis = device_log_hash(&srv.logs["carol@local"][0]);
    // Сервер называет другой отпечаток, а отдаёт журнал прежнего корня.
    let fake = [0xAAu8; 32];
    let own_log = srv.logs["carol@local"].clone();
    assert_eq!(bob.ingest_log_sync("carol@local", own_log.clone(), &fake).unwrap(), LogVerdict::Replaced, "журнал не с названного генезиса");
    // Журнал начат заново тем же корнем (форк): записи после генезиса — другие.
    let mut fork = Client::new("carol@local", "d1", "local").unwrap();
    let _ = &carol;
    assert!(fork.reset_identity(1).is_ok());
    assert_eq!(bob.log_genesis("carol@local").unwrap(), carol_genesis, "закреплённый журнал не тронут");
}

/// FR-033 (T133): отзыв ключа доступа у одного собеседника. Блокировка сама
/// ключ не отнимает — нужен новый ключ, розданный всем, кроме заблокированного.
#[test]
fn contact_access_revocation_excludes_one_peer() {
    init_clock();
    let mut srv = Server::default();
    let (mut alice, _) = setup(&mut srv, "alice@local");
    let (mut bob, _) = setup(&mut srv, "bob@local");
    let (mut carol, _) = setup(&mut srv, "carol@local");
    let mut alice2 = link(&mut srv, &mut alice, "d2");
    for (peer, hello) in [(&mut bob, "привет от bob"), (&mut carol, "привет от carol")] {
        peer.set_peer_delivery_key("alice@local", alice.delivery_key().to_vec(), 1);
        run(&mut srv, peer, &mut |c| c.prepare_direct("alice@local", &text(hello)));
    }
    drain(&mut srv, &mut alice);
    drain(&mut srv, &mut alice2);
    // Ответы раздают ключ доступа Алисы обоим собеседникам.
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("bob, привет")));
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("carol@local", &text("carol, привет")));
    drain(&mut srv, &mut bob);
    drain(&mut srv, &mut carol);
    drain(&mut srv, &mut alice2);
    let old_dk = *alice.delivery_key();
    let gen0 = alice.delivery_key_generation();

    // Собеседнику, которому ключ не раздавался, отзывать нечего.
    assert_eq!(alice.revoke_contact_access("nobody@local").unwrap(), RevocationOutcome::default());
    assert_eq!(alice.delivery_key_generation(), gen0);

    let mut outcome = None;
    for _ in 0..10 {
        match alice.revoke_contact_access("bob@local") {
            Ok(o) => {
                exec(&mut srv, &alice, &o.requests);
                outcome = Some(o);
                break;
            }
            Err(ClientError::Need(n)) => satisfy(&mut srv, &mut alice, n),
            Err(e) => panic!("{e:?}"),
        }
    }
    let o = outcome.expect("отзыв доступа");
    assert!(o.requests.iter().any(|r| r.method == "identity.delivery_key.set"));
    assert!(o.pending_key_shares.is_empty() && !o.ssk_rotation_required && o.state_key_version.is_none(), "{o:?}");
    assert_ne!(*alice.delivery_key(), old_dk);
    assert_eq!(alice.delivery_key_generation(), gen0 + 1);
    assert!(!alice.pending_delivery_key_shares().contains(&"bob@local".to_string()));
    // Повтор: ключа у Боба уже нет — ничего не происходит.
    assert_eq!(alice.revoke_contact_access("bob@local").unwrap(), RevocationOutcome::default());

    // Своё второе устройство получило новый ключ по E2E.
    drain(&mut srv, &mut alice2);
    assert_eq!(alice2.delivery_key(), alice.delivery_key());

    // Кэрол получила новый ключ и пишет по нему.
    drain(&mut srv, &mut carol);
    run(&mut srv, &mut carol, &mut |c| c.prepare_direct("alice@local", &text("carol после отзыва")));
    assert!(texts(&drain(&mut srv, &mut alice)).contains(&("carol@local".into(), "carol после отзыва".into())));

    // Боб нового ключа не получил: доставка по прежнему — отказ сервера, дальше
    // только как незнакомый (жетон).
    assert!(drain(&mut srv, &mut bob).is_empty(), "заблокированному новый ключ не раздаётся");
    let reqs = bob.prepare_direct("alice@local", &text("bob после отзыва")).unwrap();
    let refused = reqs.iter().any(|r| srv.handle("bob@local", &bob.device_id, r) == Err(SrvErr::Forbidden));
    assert!(refused, "прежний ключ доступа сервер больше не принимает");
    bob.on_delivery_key_rejected("alice@local");
    assert!(
        matches!(bob.prepare_direct("alice@local", &text("ещё раз")), Err(ClientError::Need(Need::Token { .. }))),
        "без ключа доступа — только анонимный жетон"
    );
}
