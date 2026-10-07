//! Клиентское ядро: полный поток двух пользователей через мини-сервер в
//! памяти (журналы устройств, бандлы, ключи доставки, журналы инбокса,
//! группы) — те же проверки, что делают шарды, упрощённо.

use std::collections::HashMap;

use parvane_protocol::client::{Chan, Client, ClientError, Event, Need, OutRequest};
use parvane_protocol::codec::decode_checked;
use parvane_protocol::group::{self, SignerInfo};
use parvane_protocol::identity::DeviceLog;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{sealed_envelope::Access, GroupStateEntry, Ref, SignedOp};
use parvane_protocol::pb::parvane::group::v2::{self as gpb, GroupKind, Permissions};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, inbox_record, Content, InboxRecord, Text};
use prost::Message;
use sha2::{Digest, Sha256};

#[derive(Default)]
struct Server {
    logs: HashMap<String, Vec<SignedOp>>,
    otks: HashMap<(String, String), Vec<ipb::OneTimeKey>>,
    fallback: HashMap<(String, String), ipb::OneTimeKey>,
    dk: HashMap<String, [u8; 32]>,
    inbox: HashMap<(String, String), Vec<InboxRecord>>,
    groups: HashMap<Vec<u8>, Vec<GroupStateEntry>>,
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

    /// Выполнить запрос клиента `user`/`device` (для ID-методов).
    fn handle(&mut self, user: &str, device: &str, r: &OutRequest) {
        match r.method {
            "identity.device.log_append" => {
                let q: ipb::DeviceLogAppendRequest = decode_checked(&r.body, Origin::Client).unwrap();
                let op = q.entry.unwrap();
                let mut l = self.log(user);
                l.apply(&op).expect("журнал");
                self.logs.entry(user.into()).or_default().push(op);
            }
            "identity.device.publish_certificate" => {
                let q: ipb::DevicePublishCertificateRequest = decode_checked(&r.body, Origin::Client).unwrap();
                if let Some(op) = q.log_entry.filter(|e| !e.body.is_empty()) {
                    let mut l = self.log(user);
                    l.apply(&op).expect("сертификат");
                    self.logs.entry(user.into()).or_default().push(op);
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
            // Сигналы звонка: анонимный канал, в журнал не пишутся (D-08)
            "call.ring_sealed" | "call.signal_sealed" => assert_eq!(r.chan, Chan::Anon),
            "msg.deliver_sealed" => {
                assert_eq!(r.chan, Chan::Anon);
                let q: mpb::DeliverSealedRequest = decode_checked(&r.body, Origin::Client).unwrap();
                for e in q.envelopes {
                    let rc = e.recipient.clone().unwrap();
                    match e.access.as_ref().unwrap() {
                        Access::DeliveryKey(k) => {
                            let h: [u8; 32] = Sha256::digest(k).into();
                            assert_eq!(Some(&h), self.dk.get(&rc.address), "ключ доступа");
                        }
                        Access::AnonToken(_) => {}
                    }
                    self.push(&rc.address, &rc.device_id, inbox_record::Item::Sealed(e));
                }
            }
            // Отказ по заявке: записи журнала нет, шард только снимает заявку.
            "group.request.decide" if decode_checked::<gpb::RequestDecideRequest>(&r.body, Origin::Client).unwrap().entry.is_none() => {}
            "group.state.append" | "group.epoch.publish_send_key" | "group.invite.create" | "group.invite.revoke" | "group.join" | "group.request.decide" => {
                let entry = match r.method {
                    "group.request.decide" => {
                        let q = decode_checked::<gpb::RequestDecideRequest>(&r.body, Origin::Client).unwrap();
                        assert!(q.approve, "запись журнала — только при одобрении");
                        q.entry.unwrap()
                    }
                    "group.state.append" => decode_checked::<gpb::StateAppendRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    "group.invite.create" => decode_checked::<gpb::InviteCreateRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    "group.invite.revoke" => decode_checked::<gpb::InviteRevokeRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    "group.join" => decode_checked::<gpb::JoinRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    _ => decode_checked::<gpb::EpochPublishSendKeyRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                };
                let gid = entry.group.clone().unwrap().id;
                let resolve = |k: &[u8; 32]| {
                    self.logs.keys().find_map(|u| {
                        let l = self.log(u);
                        l.devices.values().any(|d| d.cert.olm_ed25519.as_slice() == k).then(|| SignerInfo { user: u.clone(), root_key: l.root_key })
                    })
                };
                let mut st = None;
                for e in self.groups.get(&gid).into_iter().flatten() {
                    st = Some(group::apply(st.as_ref(), e, &resolve).unwrap());
                }
                let next = group::apply(st.as_ref(), &entry, &resolve).expect("запись группы");
                let before: Vec<String> = st.map(|s| s.members.keys().cloned().collect()).unwrap_or_default();
                self.groups.entry(gid.clone()).or_default().push(entry);
                // Нотис всем участникам (и исключённым этой записью), как шард.
                let mut notify: Vec<String> = next.members.keys().cloned().collect();
                notify.extend(before);
                notify.sort();
                notify.dedup();
                let notice = mpb::GroupStateNotice { group: next.group.clone().into(), version: next.version };
                for m in notify {
                    for d in self.log(&m).devices.keys().cloned().collect::<Vec<_>>() {
                        self.push(&m, &d, inbox_record::Item::GroupState(notice.clone()));
                    }
                }
            }
            "msg.deliver_group" => {
                let q: mpb::DeliverGroupRequest = decode_checked(&r.body, Origin::Client).unwrap();
                let env = q.envelope.unwrap();
                let gid = env.group.clone().unwrap().id;
                // Всем участникам последнего состояния — всем устройствам.
                let resolve = |k: &[u8; 32]| {
                    self.logs.keys().find_map(|u| {
                        let l = self.log(u);
                        l.devices.values().any(|d| d.cert.olm_ed25519.as_slice() == k).then(|| SignerInfo { user: u.clone(), root_key: l.root_key })
                    })
                };
                let mut st = None;
                for e in self.groups.get(&gid).into_iter().flatten() {
                    st = Some(group::apply(st.as_ref(), e, &resolve).unwrap());
                }
                let st = st.unwrap();
                group::verify_envelope(&env, st.epoch, &st.send_public_key.unwrap()).expect("подпись эпохи");
                for m in st.members.keys() {
                    for d in self.log(m).devices.keys() {
                        self.push(m, d, inbox_record::Item::Group(env.clone()));
                    }
                }
            }
            other => panic!("мини-сервер: {other}"),
        }
    }

    /// Подсказки подписантов записей группы (как `signer_hints` шарда).
    fn hints(&self, gid: &[u8], after: usize) -> (Vec<GroupStateEntry>, Vec<String>) {
        let entries: Vec<GroupStateEntry> = self.groups.get(gid).map(|v| v[after.min(v.len())..].to_vec()).unwrap_or_default();
        let hints = entries
            .iter()
            .map(|e| {
                let k = e.change.as_ref().unwrap().signer_key.clone();
                self.logs.keys().find(|u| self.log(u).devices.values().any(|d| d.cert.olm_ed25519 == k)).cloned().unwrap_or_default()
            })
            .collect();
        (entries, hints)
    }

    fn bundle(&mut self, user: &str) -> Vec<ipb::DeviceBundle> {
        let log = self.log(user);
        let certs: HashMap<String, _> = self
            .logs
            .get(user)
            .into_iter()
            .flatten()
            .filter_map(|op| {
                let b = parvane_protocol::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()).ok()?;
                let e = parvane_protocol::pb::parvane::core::v2::UserDeviceLogEntry::decode(b.payload.as_slice()).ok()?;
                match e.change? {
                    parvane_protocol::pb::parvane::core::v2::user_device_log_entry::Change::AddDevice(c) => {
                        let v = parvane_protocol::identity::verify_certificate(&c, Some(user)).ok()?;
                        Some((v.cert.device_id, c))
                    }
                    _ => None,
                }
            })
            .collect();
        log.devices
            .keys()
            .map(|d| ipb::DeviceBundle {
                certificate: certs.get(d).cloned(),
                one_time_key: self.otks.get_mut(&(user.into(), d.clone())).and_then(|v| v.pop()),
                fallback_key: self.fallback.get(&(user.into(), d.clone())).cloned(),
            })
            .collect()
    }
}

/// Выполнять запросы; при `Need` — добирать данные и повторять.
fn run(srv: &mut Server, c: &mut Client, op: &mut dyn FnMut(&mut Client) -> Result<Vec<OutRequest>, ClientError>) {
    for _ in 0..8 {
        match op(c) {
            Ok(reqs) => {
                for r in reqs {
                    srv.handle(&c.user.clone(), &c.device_id.clone(), &r);
                }
                return;
            }
            Err(ClientError::Need(n)) => satisfy(srv, c, n),
            Err(e) => panic!("{e:?}"),
        }
    }
    panic!("не сошлось");
}

fn satisfy(srv: &mut Server, c: &mut Client, n: Need) {
    match n {
        Need::PeerLog { user, .. } => {
            let after = c.log_version(&user) as usize;
            let entries = srv.logs.get(&user).map(|v| v[after.min(v.len())..].to_vec()).unwrap_or_default();
            c.ingest_log(&user, entries).unwrap();
        }
        Need::Bundle { user } => {
            let b = srv.bundle(&user);
            c.ingest_bundle(&user, b).unwrap();
        }
        Need::GroupLog { group, after } => {
            for _ in 0..4 {
                let (entries, hints) = srv.hints(&group, after as usize);
                match c.group_ingest_hinted(&Ref { domain: "local".into(), id: group.clone() }, entries, &hints) {
                    Ok(_) => break,
                    Err(ClientError::Need(n)) => satisfy(srv, c, n),
                    Err(e) => panic!("{e:?}"),
                }
            }
        }
        other => panic!("не умеем добрать: {other:?}"),
    }
}

/// Прочитать новые записи журнала устройства.
fn drain(srv: &mut Server, c: &mut Client) -> Vec<Event> {
    let key = (c.user.clone(), c.device_id.clone());
    let recs = srv.inbox.get(&key).cloned().unwrap_or_default();
    let mut out = vec![];
    for r in recs {
        let bytes = r.encode_to_vec();
        for _ in 0..8 {
            c.last_error = None;
            match c.open_record(&bytes) {
                Ok(ev) => {
                    // Хост: изменение группы → догнать журнал и применить отложенное.
                    for e in &ev {
                        if let Event::GroupChanged { group, .. } = e {
                            for _ in 0..4 {
                                let after = c.group_version(&group.id) as usize;
                                let (entries, hints) = srv.hints(&group.id, after);
                                match c.group_ingest_hinted(group, entries, &hints) {
                                    Ok(_) => break,
                                    Err(ClientError::Need(n)) => satisfy(srv, c, n),
                                    Err(e) => panic!("{e:?}"),
                                }
                            }
                            out.extend(c.drain_ready());
                        }
                    }
                    if let Some(e) = &c.last_error {
                        eprintln!("{} seq {} kind {:?}: {:?}", c.user, r.seq, r.item.as_ref().map(|i| match i { inbox_record::Item::Sealed(_) => "sealed", inbox_record::Item::Group(_) => "group", _ => "other" }), e);
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

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
}

fn texts(ev: &[Event]) -> Vec<(String, String, String)> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Direct { chat, from, content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some((chat.clone(), from.clone(), t.text.clone())),
            Event::Group { from, content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some(("group".into(), from.clone(), t.text.clone())),
            _ => None,
        })
        .collect()
}

fn setup(srv: &mut Server, user: &str) -> Client {
    let mut c = Client::new(user, "d1", "local").unwrap();
    let (reqs, _root) = c.create_identity(10).unwrap();
    for r in &reqs {
        srv.handle(user, "d1", r);
    }
    c
}

#[test]
fn direct_group_multidevice_and_restore() {
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");

    // Второе устройство Алисы (линковка: SSK + журнал + ключ доставки).
    let mut alice2 = Client::new("alice@local", "d2", "local").unwrap();
    let (ssk, entries, dk, gen) = alice.link_grant_material().unwrap();
    for r in alice2.join_with_ssk(ssk, entries, dk, gen, 10).unwrap() {
        srv.handle("alice@local", "d2", &r);
    }
    alice.ingest_log("alice@local", srv.logs["alice@local"][alice.log_version("alice@local") as usize..].to_vec()).unwrap();

    // Первый контакт: у Алисы нет ключа доступа Боба → нужен жетон.
    let a = |c: &mut Client| c.prepare_direct("bob@local", &text("привет"));
    match a(&mut alice) {
        Err(ClientError::Need(_)) => {}
        other => panic!("{other:?}"),
    }
    // Жетонов нет — выдаём Бобов ключ доступа Алисе «вне полосы» (как профиль).
    let bob_dk = *bob.delivery_key();
    let mut bob_share = Client::new("bob@local", "tmp", "local").unwrap();
    let _ = &mut bob_share;
    alice_set_peer_key(&mut alice, &mut srv, &mut bob, bob_dk);

    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("привет")));
    let ev = drain(&mut srv, &mut bob);
    assert_eq!(texts(&ev), vec![("alice@local".into(), "alice@local".into(), "привет".into())]);
    // Своё второе устройство получило копию (чат = Боб).
    let ev2 = drain(&mut srv, &mut alice2);
    assert!(texts(&ev2).contains(&("bob@local".into(), "alice@local".into(), "привет".into())), "{ev2:?}");

    // Боб отвечает по ключу доступа Алисы, полученному в первом сообщении.
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("и тебе")));
    let ev = drain(&mut srv, &mut alice);
    assert!(texts(&ev).contains(&("bob@local".into(), "bob@local".into(), "и тебе".into())));
    let ev = drain(&mut srv, &mut alice2);
    assert!(texts(&ev).contains(&("bob@local".into(), "bob@local".into(), "и тебе".into())));

    // Группа: Алиса создаёт, эпоха 1, сообщения в обе стороны.
    let perms = Permissions { send_messages: true, send_media: true, send_stickers_gifs: true, send_polls: true, embed_links: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "Семья", &["bob@local".to_string()], perms).unwrap();
    srv.handle("alice@local", "d1", &req);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("всем привет")));
    let ev = drain(&mut srv, &mut bob);
    assert!(texts(&ev).contains(&("group".into(), "alice@local".into(), "всем привет".into())), "{ev:?} {:?}", bob.last_error);
    run(&mut srv, &mut bob, &mut |c| c.prepare_group(&g.id, &text("ответ в группу")));
    let ev = drain(&mut srv, &mut alice);
    assert!(texts(&ev).contains(&("group".into(), "bob@local".into(), "ответ в группу".into())), "{ev:?}");
    let ev = drain(&mut srv, &mut alice2);
    assert!(texts(&ev).contains(&("group".into(), "bob@local".into(), "ответ в группу".into())), "{ev:?}");

    // Экспорт/импорт состояния Боба и продолжение переписки.
    let key = [7u8; 32];
    let blob = bob.export(&key).unwrap();
    assert!(Client::import(&blob, &[8u8; 32]).is_err());
    let mut bob = Client::import(&blob, &key).unwrap();
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("после восстановления")));
    let ev = drain(&mut srv, &mut bob);
    assert!(texts(&ev).contains(&("alice@local".into(), "alice@local".into(), "после восстановления".into())), "{ev:?}");
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("группа после восстановления")));
    let ev = drain(&mut srv, &mut bob);
    assert!(texts(&ev).contains(&("group".into(), "alice@local".into(), "группа после восстановления".into())), "{ev:?}");
}

/// Грант линковки несёт ключи доступа собеседников (поле `pk`): привязанное
/// устройство пишет и звонит знакомым по ключу сразу — звонок по слепому жетону
/// сервер не принимает, а жетонов всего 50 в сутки.
#[test]
fn link_grant_carries_peer_delivery_keys() {
    use parvane_protocol::host::{apply_grant_peer_keys, grant_peer_keys};
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let bob = setup(&mut srv, "bob@local");
    alice.set_peer_delivery_key("bob@local", bob.delivery_key().to_vec(), 3);
    let material = serde_json::json!({ "pk": grant_peer_keys(&alice) });
    assert_eq!(material["pk"][0]["u"], "bob@local");
    assert_eq!(material["pk"][0]["g"], 3);

    let mut alice2 = Client::new("alice@local", "d2", "local").unwrap();
    assert!(!alice2.has_peer_delivery_key("bob@local"));
    apply_grant_peer_keys(&mut alice2, &material);
    assert!(alice2.has_peer_delivery_key("bob@local"));
    // Грант прежней версии (без поля) и мусор в поле принимаются без ошибки.
    apply_grant_peer_keys(&mut alice2, &serde_json::json!({}));
    apply_grant_peer_keys(&mut alice2, &serde_json::json!({ "pk": [{ "u": "не адрес", "k": "zz" }, 7] }));
    assert_eq!(alice2.peer_delivery_keys().len(), 1);
}

/// «Избранное» (чат с собой, T147): сообщение самому себе уходит копиями своим
/// другим устройствам журнала; у единственного устройства запросов нет вовсе.
#[test]
fn saved_messages_reach_own_devices() {
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");

    // Одно устройство: слать некому — запись остаётся только у себя.
    let alone = run_collect(&mut srv, &mut alice, &mut |c| c.prepare_direct("alice@local", &text("заметка")));
    assert!(alone.is_empty(), "единственное устройство не шлёт «Избранное» на сервер: {}", alone.len());

    let mut alice2 = Client::new("alice@local", "d2", "local").unwrap();
    let (ssk, entries, dk, gen) = alice.link_grant_material().unwrap();
    for r in alice2.join_with_ssk(ssk, entries, dk, gen, 10).unwrap() {
        srv.handle("alice@local", "d2", &r);
    }
    alice.ingest_log("alice@local", srv.logs["alice@local"][alice.log_version("alice@local") as usize..].to_vec()).unwrap();

    let reqs = run_collect(&mut srv, &mut alice, &mut |c| c.prepare_direct("alice@local", &text("в избранное")));
    assert!(!reqs.is_empty() && reqs.iter().all(|r| r.method == "msg.deliver_sealed" && r.chan == Chan::Anon), "{:?}", reqs.iter().map(|r| r.method).collect::<Vec<_>>());
    let ev = drain(&mut srv, &mut alice2);
    assert!(texts(&ev).contains(&("alice@local".into(), "alice@local".into(), "в избранное".into())), "{ev:?} {:?}", alice2.last_error);
    // И обратно: со второго устройства — на первое.
    run(&mut srv, &mut alice2, &mut |c| c.prepare_direct("alice@local", &text("с телефона")));
    let ev = drain(&mut srv, &mut alice);
    assert!(texts(&ev).contains(&("alice@local".into(), "alice@local".into(), "с телефона".into())), "{ev:?} {:?}", alice.last_error);
}

/// T142: устройство, привязанное ПОСЛЕ создания группы, узнаёт о группе и
/// получает ключи текущей эпохи и сессии Megolm участников от своего старого
/// устройства — читает новые сообщения участников и пишет само.
#[test]
fn linked_device_gets_groups_from_own_device() {
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    let bob_dk = *bob.delivery_key();
    alice_set_peer_key(&mut alice, &mut srv, &mut bob, bob_dk);
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("привет")));
    drain(&mut srv, &mut bob);

    let perms = Permissions { send_messages: true, send_media: true, send_stickers_gifs: true, send_polls: true, embed_links: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "До линковки", &["bob@local".to_string()], perms).unwrap();
    srv.handle("alice@local", "d1", &req);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("от алисы")));
    drain(&mut srv, &mut bob);
    run(&mut srv, &mut bob, &mut |c| c.prepare_group(&g.id, &text("от боба")));
    drain(&mut srv, &mut alice);

    // Второе устройство Алисы — после группы и первых сообщений.
    let mut alice2 = Client::new("alice@local", "d2", "local").unwrap();
    let (ssk, entries, dk, gen) = alice.link_grant_material().unwrap();
    for r in alice2.join_with_ssk(ssk, entries, dk, gen, 10).unwrap() {
        srv.handle("alice@local", "d2", &r);
    }
    alice.ingest_log("alice@local", srv.logs["alice@local"][alice.log_version("alice@local") as usize..].to_vec()).unwrap();
    assert!(alice2.group_ids().is_empty(), "грант групп не несёт");

    // Чужому и своему же устройству пересылать нечего.
    assert!(alice.share_groups_with_own_devices(&["d1".into(), "нет-такого".into()]).unwrap().is_empty());
    let shared = run_collect(&mut srv, &mut alice, &mut |c| c.share_groups_with_own_devices(&["d2".into()]));
    // ключи эпохи + по сессии Megolm на каждого писавшего (alice, bob)
    assert_eq!(shared.len(), 3, "пересылок: {}", shared.len());
    let ev = drain(&mut srv, &mut alice2);
    assert!(ev.iter().any(|e| matches!(e, Event::GroupChanged { .. })), "{ev:?} {:?}", alice2.last_error);
    assert_eq!(alice2.group_ids(), vec![g.id.clone()], "{:?}", alice2.last_error);

    // Сообщения участников в текущей эпохе читаются (сессии Megolm пересланы).
    run(&mut srv, &mut bob, &mut |c| c.prepare_group(&g.id, &text("боб после линковки")));
    let ev = drain(&mut srv, &mut alice2);
    assert!(texts(&ev).contains(&("group".into(), "bob@local".into(), "боб после линковки".into())), "{ev:?} {:?}", alice2.last_error);
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("алиса-1 после линковки")));
    let ev = drain(&mut srv, &mut alice2);
    assert!(texts(&ev).contains(&("group".into(), "alice@local".into(), "алиса-1 после линковки".into())), "{ev:?} {:?}", alice2.last_error);

    // Новое устройство пишет в группу само (ключ отправки эпохи переслан).
    // Ключ доступа Боба новому устройству грант не несёт — в жизни тут жетон.
    bob_learn(&mut alice2, "bob@local", bob_dk);
    run(&mut srv, &mut alice2, &mut |c| c.prepare_group(&g.id, &text("со второго устройства")));
    let ev = drain(&mut srv, &mut bob);
    assert!(texts(&ev).contains(&("group".into(), "alice@local".into(), "со второго устройства".into())), "{ev:?} {:?}", bob.last_error);
    let ev = drain(&mut srv, &mut alice);
    assert!(texts(&ev).contains(&("group".into(), "alice@local".into(), "со второго устройства".into())), "{ev:?} {:?}", alice.last_error);

    // Пересылку чужой сессии Megolm от НЕ своего устройства движок не принимает:
    // у Боба нет способа выдать её за сессию Алисы (проверка в accept_group_key).
}

/// Передать Алисе ключ доступа Боба сообщением Боба (как в жизни: первый
/// ответ несёт DeliveryKeyShare). Для первого контакта — через своё
/// устройство Боба: Боб пишет Алисе по её ключу, полученному из профиля.
fn alice_set_peer_key(alice: &mut Client, srv: &mut Server, bob: &mut Client, _bob_dk: [u8; 32]) {
    // Боб знает ключ Алисы «из профиля» — эмулируем передачей через жетон-free
    // путь: Алиса пишет себе нельзя, поэтому Боб пишет первым по ключу Алисы.
    let alice_dk = *alice.delivery_key();
    bob_learn(bob, "alice@local", alice_dk);
    run(srv, bob, &mut |c| c.prepare_direct("alice@local", &text("я Боб")));
    let ev = drain(srv, alice);
    assert!(texts(&ev).contains(&("bob@local".into(), "bob@local".into(), "я Боб".into())));
}

fn bob_learn(c: &mut Client, user: &str, key: [u8; 32]) {
    c.set_peer_delivery_key(user, key.to_vec(), 1);
}

/// C1-06: резервная копия корня под ключом восстановления через клиентское
/// ядро — только для корня своего журнала.
#[test]
fn root_backup_roundtrip() {
    use parvane_protocol::recovery::RecoveryKey;
    let mut srv = Server::default();
    let mut c = Client::new("alice@local", "d1", "local").unwrap();
    let (reqs, root) = c.create_identity(2).unwrap();
    for r in &reqs {
        srv.handle("alice@local", "d1", r);
    }
    let k = RecoveryKey::generate();
    let blob = c.export_root_backup(&root.root.to_bytes(), &k).unwrap();
    let back = c.import_root_backup(&blob, &RecoveryKey::parse(&k.to_display()).unwrap()).unwrap();
    assert_eq!(*back, root.root.to_bytes());
    let other = parvane_protocol::sign::generate_signing_key();
    assert_eq!(c.export_root_backup(&other.to_bytes(), &k), Err(parvane_protocol::ProtoError::RootMismatch));
    // Копия чужого корня (другого журнала) не принимается.
    let mut bob = Client::new("alice@local", "d9", "local").unwrap();
    let (_, root2) = bob.create_identity(1).unwrap();
    let blob2 = bob.export_root_backup(&root2.root.to_bytes(), &k).unwrap();
    assert_eq!(c.import_root_backup(&blob2, &k).err(), Some(parvane_protocol::ProtoError::RootMismatch));
}

static CLOCK_SHIFT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn shifted_now() -> i64 {
    let sys = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    sys + CLOCK_SHIFT.load(std::sync::atomic::Ordering::SeqCst)
}

/// Часы движка вперёд (общие для процесса: другим тестам время только
/// «идёт быстрее», что им не мешает).
fn advance_clock(ms: i64) {
    parvane_protocol::time::set_clock(shifted_now);
    CLOCK_SHIFT.fetch_add(ms, std::sync::atomic::Ordering::SeqCst);
}

/// Ссылка-приглашение v2 (D-04): вступивший по ссылке без общего прошлого с
/// участниками догоняет журнал по подсказкам сервера, вступает подписью ключа
/// ссылки, получает ключи новой эпохи; бан → новая эпоха, забаненный не читает.
#[test]
fn invite_join_and_ban() {
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    let mut carol = setup(&mut srv, "carol@local");
    alice_set_peer_key(&mut alice, &mut srv, &mut bob, [0; 32]);
    bob_learn(&mut alice, "bob@local", *bob.delivery_key());
    bob_learn(&mut alice, "carol@local", *carol.delivery_key());
    bob_learn(&mut carol, "alice@local", *alice.delivery_key());
    bob_learn(&mut carol, "bob@local", *bob.delivery_key());
    bob_learn(&mut bob, "carol@local", *carol.delivery_key());

    let perms = Permissions { send_messages: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "Клуб", &["bob@local".to_string()], perms).unwrap();
    srv.handle("alice@local", "d1", &req);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    drain(&mut srv, &mut bob);

    let (req, parts) = alice.group_invite_create(&g.id, "", 0, 0, false).unwrap();
    srv.handle("alice@local", "d1", &req);
    let url = parvane_protocol::invite::format(&parts).unwrap();
    let parvane_protocol::invite::ParsedInvite::V2(back) = parvane_protocol::invite::parse(&url).unwrap() else { panic!("не v2") };

    // Кэрол не участник и не знает журналов Алисы: подсказка подписанта.
    satisfy(&mut srv, &mut carol, Need::GroupLog { group: g.id.clone(), after: 0 });
    assert_eq!(carol.group_version(&g.id), alice.group_version(&g.id));
    let join = carol.group_join(&back).unwrap();
    srv.handle("carol@local", "d1", &join);
    drain(&mut srv, &mut alice);
    assert!(alice.group_state(&g.id).unwrap().members.contains_key("carol@local"));
    assert!(alice.group_state(&g.id).unwrap().epoch_stale);
    // Новая эпоха не чаще раза в 10 с — сдвигаем часы движка.
    advance_clock(11_000);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("добро пожаловать")));
    let ev = drain(&mut srv, &mut carol);
    assert!(texts(&ev).contains(&("group".into(), "alice@local".into(), "добро пожаловать".into())), "{ev:?} {:?}", carol.last_error);
    drain(&mut srv, &mut bob);

    // Бан Кэрол: новая эпоха без неё, новое сообщение она не читает.
    let ban = alice.group_change(&g.id, gpb::group_change::Change::Ban(gpb::Ban { member: Some(parvane_protocol::pb::parvane::core::v2::UserRef { address: "carol@local".into() }) })).unwrap();
    srv.handle("alice@local", "d1", &ban);
    advance_clock(11_000);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("после бана")));
    let ev = drain(&mut srv, &mut carol);
    assert!(!texts(&ev).iter().any(|t| t.2 == "после бана"), "{ev:?}");
    let ev = drain(&mut srv, &mut bob);
    assert!(texts(&ev).iter().any(|t| t.2 == "после бана"), "{ev:?}");
    assert!(carol.group_state(&g.id).unwrap().banned.contains("carol@local"));
    assert!(carol.group_unconfirmed(&g.id, &["mallory@local".to_string()]) == vec!["mallory@local".to_string()]);
}

/// Общий список ссылок у ведущих приглашения: секрет ссылки владельца доходит
/// до админа с правом приглашать служебной раздачей и принимается по совпадению
/// с объявленной в журнале ссылкой; участнику без права он не уходит, чужой
/// секрет отбрасывается. Отозванная ссылка остаётся в состоянии как отозванная.
#[test]
fn invite_links_are_shared_with_invite_admins_and_revoked_are_kept() {
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    let mut carol = setup(&mut srv, "carol@local");
    alice_set_peer_key(&mut alice, &mut srv, &mut bob, [0; 32]);
    bob_learn(&mut alice, "bob@local", *bob.delivery_key());
    bob_learn(&mut alice, "carol@local", *carol.delivery_key());
    bob_learn(&mut carol, "alice@local", *alice.delivery_key());
    bob_learn(&mut carol, "bob@local", *bob.delivery_key());
    bob_learn(&mut bob, "carol@local", *carol.delivery_key());
    bob_learn(&mut bob, "alice@local", *alice.delivery_key());

    let perms = Permissions { send_messages: true, ..Default::default() };
    let members = ["bob@local".to_string(), "carol@local".to_string()];
    let (g, req) = alice.group_create(GroupKind::Group, "Клуб", &members, perms).unwrap();
    srv.handle("alice@local", "d1", &req);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    drain(&mut srv, &mut bob);
    drain(&mut srv, &mut carol);
    // bob — админ с правом приглашать; carol — обычный участник
    let user = |a: &str| Some(parvane_protocol::pb::parvane::core::v2::UserRef { address: a.into() });
    let promote = alice
        .group_change(&g.id, gpb::group_change::Change::SetRole(gpb::SetRole {
            member: user("bob@local"),
            role: gpb::Role::Admin as i32,
            rights: Some(gpb::AdminRights { invite_users: true, ..Default::default() }),
        }))
        .unwrap();
    srv.handle("alice@local", "d1", &promote);
    let (req, parts) = alice.group_invite_create(&g.id, "", 0, 0, false).unwrap();
    srv.handle("alice@local", "d1", &req);
    let url = parvane_protocol::invite::format(&parts).unwrap();
    drain(&mut srv, &mut bob);
    drain(&mut srv, &mut carol);

    // Раздача: адресат без права отсеивается движком, чужой группе секрет — тоже
    let (_, stray) = parvane_protocol::invite::generate("local").unwrap();
    let stray_url = parvane_protocol::invite::format(&stray).unwrap();
    let to = ["bob@local".to_string(), "carol@local".to_string()];
    let links = [url.clone(), stray_url.clone()];
    run(&mut srv, &mut alice, &mut |c| c.share_invite_links(&g.id, &links, &to));
    drain(&mut srv, &mut bob);
    drain(&mut srv, &mut carol);
    assert_eq!(bob.take_shared_invites(), vec![(g.id.clone(), url.clone())], "админ с правом приглашать получил секрет ссылки");
    assert!(bob.take_shared_invites().is_empty(), "секреты забираются один раз");
    assert!(carol.take_shared_invites().is_empty(), "участнику без права секрет не уходит");
    // Только чужой секрет — слать нечего
    let stray_only = [stray_url];
    assert!(alice.share_invite_links(&g.id, &stray_only, &to).unwrap().is_empty());

    // Отзыв: ссылка уходит из действующих в отозванные у всех, кто читает журнал
    let id: [u8; 32] = parts.link_id.as_slice().try_into().unwrap();
    let revoke = alice.group_change(&g.id, gpb::group_change::Change::InviteKeyRevoke(gpb::InviteKeyRevoke { link_id: id.to_vec() })).unwrap();
    srv.handle("alice@local", "d1", &revoke);
    drain(&mut srv, &mut bob);
    for c in [&alice, &bob] {
        let st = c.group_state(&g.id).unwrap();
        assert!(!st.invite_links.contains_key(&id), "отозванная ссылка осталась действующей");
        assert!(st.revoked_links.contains_key(&id), "отозванная ссылка не запомнена");
    }
    // Секрет отозванной ссылки больше не раздаётся
    let revoked_only = [url];
    assert!(alice.share_invite_links(&g.id, &revoked_only, &to).unwrap().is_empty());
}

/// Заявка на вступление (ссылка с одобрением, D-04): админ одобряет записью
/// `AddMember` в запросе `group.request.decide`; отказ журнал не меняет.
#[test]
fn join_request_is_approved_by_add_member() {
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    let mut carol = setup(&mut srv, "carol@local");
    alice_set_peer_key(&mut alice, &mut srv, &mut bob, [0; 32]);
    bob_learn(&mut alice, "bob@local", *bob.delivery_key());
    bob_learn(&mut alice, "carol@local", *carol.delivery_key());
    bob_learn(&mut carol, "alice@local", *alice.delivery_key());
    bob_learn(&mut carol, "bob@local", *bob.delivery_key());
    bob_learn(&mut bob, "carol@local", *carol.delivery_key());

    let perms = Permissions { send_messages: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "Клуб", &["bob@local".to_string()], perms).unwrap();
    srv.handle("alice@local", "d1", &req);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    drain(&mut srv, &mut bob);

    // Кэрол просит вступить по ссылке «с одобрением»: запрос уходит, но её
    // журнал группы не меняется — участником она станет только записью админа.
    let (req, parts) = alice.group_invite_create(&g.id, "по одобрению", 0, 0, true).unwrap();
    srv.handle("alice@local", "d1", &req);
    let url = parvane_protocol::invite::format(&parts).unwrap();
    let parvane_protocol::invite::ParsedInvite::V2(back) = parvane_protocol::invite::parse(&url).unwrap() else { panic!("не v2") };
    satisfy(&mut srv, &mut carol, Need::GroupLog { group: g.id.clone(), after: 0 });
    let before = carol.group_version(&g.id);
    let ask = carol.group_join(&back).unwrap();
    assert_eq!(ask.method, "group.join");
    let q: gpb::JoinRequest = decode_checked(&ask.body, Origin::Client).unwrap();
    assert_eq!(q.entry.unwrap().version, before + 1, "заявка — запись вступления на следующую версию журнала");
    assert_eq!(carol.group_version(&g.id), before, "заявка не меняет журнал у заявителя");
    assert!(!carol.group_state(&g.id).unwrap().members.contains_key("carol@local"));
    // (мини-сервер заявку не проводит — как шард: она ждёт решения админа)

    // Отказ: запрос без записи, журнал на месте.
    let version = alice.group_version(&g.id);
    let no = alice.group_request_decide(&g.id, "carol@local", false).unwrap();
    assert_eq!(no.method, "group.request.decide");
    let q: gpb::RequestDecideRequest = decode_checked(&no.body, Origin::Client).unwrap();
    assert!(!q.approve && q.entry.is_none() && q.user.unwrap().address == "carol@local");
    srv.handle("alice@local", "d1", &no);
    assert_eq!(alice.group_version(&g.id), version);

    // Одобрение: запись AddMember внутри того же запроса; не-админ его собрать не может.
    assert!(bob.group_request_decide(&g.id, "carol@local", true).is_err(), "участник без права приглашать");
    let yes = alice.group_request_decide(&g.id, "carol@local", true).unwrap();
    let q: gpb::RequestDecideRequest = decode_checked(&yes.body, Origin::Client).unwrap();
    assert!(q.approve && q.entry.is_some() && q.group.unwrap().id == g.id);
    srv.handle("alice@local", "d1", &yes);
    assert_eq!(alice.group_version(&g.id), version + 1);
    assert!(alice.group_state(&g.id).unwrap().members.contains_key("carol@local"));
    assert!(alice.group_state(&g.id).unwrap().epoch_stale);

    advance_clock(11_000);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("заявка одобрена")));
    let ev = drain(&mut srv, &mut carol);
    assert!(texts(&ev).contains(&("group".into(), "alice@local".into(), "заявка одобрена".into())), "{ev:?} {:?}", carol.last_error);
    let ev = drain(&mut srv, &mut bob);
    assert!(texts(&ev).iter().any(|t| t.2 == "заявка одобрена"), "{ev:?}");
}

/// Встречное начало переписки: оба пишут первыми до того, как получили
/// сообщение собеседника, — у каждой стороны по две Olm-сессии. После
/// перезапуска обеих (экспорт/импорт) обычные сообщения обязаны
/// расшифровываться: вытесненная сессия хранится и становится основной
/// (раньше — «ошибка записи: Crypto» у desktop verify_protocol_v2.sh).
#[test]
fn simultaneous_first_contact_survives_restart() {
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    let (adk, bdk) = (*alice.delivery_key(), *bob.delivery_key());
    bob_learn(&mut alice, "bob@local", bdk);
    bob_learn(&mut bob, "alice@local", adk);

    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("a1")));
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("b1")));
    assert!(texts(&drain(&mut srv, &mut bob)).iter().any(|t| t.2 == "a1"));
    assert!(texts(&drain(&mut srv, &mut alice)).iter().any(|t| t.2 == "b1"));

    let key = [9u8; 32];
    let mut alice = Client::import(&alice.export(&key).unwrap(), &key).unwrap();
    let mut bob = Client::import(&bob.export(&key).unwrap(), &key).unwrap();

    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("a2")));
    let ev = drain(&mut srv, &mut bob);
    assert!(texts(&ev).iter().any(|t| t.2 == "a2"), "{ev:?} {:?}", bob.last_error);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("b2")));
    let ev = drain(&mut srv, &mut alice);
    assert!(texts(&ev).iter().any(|t| t.2 == "b2"), "{ev:?} {:?}", alice.last_error);
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("a3")));
    let ev = drain(&mut srv, &mut bob);
    assert!(texts(&ev).iter().any(|t| t.2 == "a3"), "{ev:?} {:?}", bob.last_error);
}

/// Как `run`, но возвращает выполненные запросы (для проверки размеров).
fn run_collect(srv: &mut Server, c: &mut Client, op: &mut dyn FnMut(&mut Client) -> Result<Vec<OutRequest>, ClientError>) -> Vec<OutRequest> {
    for _ in 0..8 {
        match op(c) {
            Ok(reqs) => {
                for r in &reqs {
                    srv.handle(&c.user.clone(), &c.device_id.clone(), r);
                }
                return reqs;
            }
            Err(ClientError::Need(n)) => satisfy(srv, c, n),
            Err(e) => panic!("{e:?}"),
        }
    }
    panic!("не сошлось");
}

/// Размеры внутренних слоёв (без тега AEAD) всех конвертов запросов.
fn inner_sizes(reqs: &[OutRequest]) -> Vec<usize> {
    const TAG: usize = 16;
    let mut out = vec![];
    for r in reqs {
        match r.method {
            "msg.deliver_sealed" => {
                let q: mpb::DeliverSealedRequest = decode_checked(&r.body, Origin::Client).unwrap();
                out.extend(q.envelopes.iter().map(|e| e.ciphertext.len() - TAG));
            }
            "msg.deliver_group" => {
                let q: mpb::DeliverGroupRequest = decode_checked(&r.body, Origin::Client).unwrap();
                out.push(q.envelope.unwrap().epoch_aead_ciphertext.len() - TAG);
            }
            _ => {}
        }
    }
    out
}

/// Размер лежит точно на сетке L2.
fn on_grid(n: usize) -> bool {
    parvane_protocol::seal::L2_BUCKETS.contains(&n) || (n > 32768 && n % 32768 == 0)
}

fn chat_modes(ev: &[Event]) -> Vec<(String, String, bool)> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Direct { chat, from, content: Content { kind: Some(content::Kind::ChatMode(m)), .. }, .. } => Some((chat.clone(), from.clone(), m.l2)),
            _ => None,
        })
        .collect()
}

/// T079 (FR-036): режим «усиленная приватность» в личном чате и группе —
/// включил → оба видят → конверты на сетке → выключил.
#[test]
fn l2_mode_direct_and_group() {
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    bob_learn(&mut alice, "bob@local", *bob.delivery_key());
    bob_learn(&mut bob, "alice@local", *alice.delivery_key());
    // Второе устройство Алисы: режим виден и ему.
    let mut alice2 = Client::new("alice@local", "d2", "local").unwrap();
    let (ssk, entries, dk, gen) = alice.link_grant_material().unwrap();
    for r in alice2.join_with_ssk(ssk, entries, dk, gen, 10).unwrap() {
        srv.handle("alice@local", "d2", &r);
    }
    alice.ingest_log("alice@local", srv.logs["alice@local"][alice.log_version("alice@local") as usize..].to_vec()).unwrap();

    let short = "п".repeat(5);
    let long = "д".repeat(400);
    // Прогрев: сессии в обе стороны, ключи доступа розданы.
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("a0")));
    drain(&mut srv, &mut bob);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("b0")));
    drain(&mut srv, &mut alice);
    drain(&mut srv, &mut alice2);

    // Обычный режим: размер конверта выдаёт длину сообщения.
    let a = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text(&short))));
    let b = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text(&long))));
    assert!(a.iter().max() < b.iter().min(), "{a:?} {b:?}");
    assert!(alice.l2_direct("bob@local").ephemeral_allowed && alice.presence_allowed());
    assert!(!alice.l2_direct("bob@local").active && !alice.l2_any_active());

    // Алиса включает: операция ChatMode Бобу и своему второму устройству, сама — на сетке.
    let sizes = inner_sizes(&run_collect(&mut srv, &mut alice, &mut |c| c.l2_set_direct("bob@local", true)));
    assert!(sizes.len() >= 2 && sizes.iter().all(|n| on_grid(*n)), "{sizes:?}");
    let v = alice.l2_direct("bob@local");
    assert!(v.active && v.mine && v.pad && !v.ephemeral_allowed, "{v:?}");
    assert_eq!(v.enabled_by, vec!["alice@local".to_string()]);
    assert!(!alice.presence_allowed() && alice.l2_any_active());
    assert_eq!(alice.l2_active_chats(), (vec!["bob@local".to_string()], vec![]));

    // Оба видят: Боб и второе устройство Алисы получают служебное событие чата.
    let ev = drain(&mut srv, &mut bob);
    assert_eq!(chat_modes(&ev), vec![("alice@local".into(), "alice@local".into(), true)], "{ev:?}");
    let v = bob.l2_direct("alice@local");
    assert!(v.active && !v.mine && v.pad && !v.ephemeral_allowed, "{v:?}");
    assert_eq!(v.enabled_by, vec!["alice@local".to_string()]);
    assert!(!bob.presence_allowed());
    let ev = drain(&mut srv, &mut alice2);
    assert_eq!(chat_modes(&ev), vec![("bob@local".into(), "alice@local".into(), true)], "{ev:?}");
    assert!(alice2.l2_direct("bob@local").mine && alice2.l2_direct("bob@local").active);

    // Размеры на сетке в обе стороны (Боб выравнивает по просьбе Алисы);
    // короткое и длинное сообщение неразличимы.
    let a = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text(&short))));
    let b = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text(&long))));
    assert!(a.iter().chain(b.iter()).all(|n| on_grid(*n)), "{a:?} {b:?}");
    assert_eq!(a, b);
    let a = inner_sizes(&run_collect(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text(&short))));
    assert!(a.len() == 2 && a.iter().all(|n| on_grid(*n)), "копии собеседнику и своему устройству: {a:?}");
    // Квитанции — тоже.
    let r = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_receipt("alice@local", mpb::ReceiptKind::Read, &[vec![1; 16]])));
    assert!(!r.is_empty() && r.iter().all(|n| on_grid(*n)), "{r:?}");
    // Сообщения по-прежнему читаются.
    let ev = drain(&mut srv, &mut alice);
    assert!(texts(&ev).iter().any(|t| t.2 == long), "{:?}", alice.last_error);
    assert!(texts(&drain(&mut srv, &mut bob)).iter().any(|t| t.2 == short));

    // Состояние переживает экспорт/импорт.
    let key = [5u8; 32];
    let mut bob = Client::import(&bob.export(&key).unwrap(), &key).unwrap();
    let v = bob.l2_direct("alice@local");
    assert!(v.active && !v.mine && v.pad, "{v:?}");

    // Боб включает у себя; Алиса выключает — режим остаётся (включён у Боба).
    run(&mut srv, &mut bob, &mut |c| c.l2_set_direct("alice@local", true));
    drain(&mut srv, &mut alice);
    assert_eq!(alice.l2_direct("bob@local").enabled_by, vec!["alice@local".to_string(), "bob@local".to_string()]);
    let sizes = inner_sizes(&run_collect(&mut srv, &mut alice, &mut |c| c.l2_set_direct("bob@local", false)));
    assert!(sizes.iter().all(|n| on_grid(*n)), "{sizes:?}");
    let v = alice.l2_direct("bob@local");
    assert!(v.active && !v.mine && v.pad && !v.ephemeral_allowed, "{v:?}");
    let ev = drain(&mut srv, &mut bob);
    assert_eq!(chat_modes(&ev), vec![("alice@local".into(), "alice@local".into(), false)]);
    assert!(bob.l2_direct("alice@local").active);

    // Боб выключает — режим снят у обоих, размеры снова обычные, эфемерные разрешены.
    run(&mut srv, &mut bob, &mut |c| c.l2_set_direct("alice@local", false));
    let ev = drain(&mut srv, &mut alice);
    assert_eq!(chat_modes(&ev), vec![("bob@local".into(), "bob@local".into(), false)]);
    for c in [&alice, &bob] {
        let peer = if c.user == "alice@local" { "bob@local" } else { "alice@local" };
        let v = c.l2_direct(peer);
        assert!(!v.active && !v.pad && v.ephemeral_allowed && v.enabled_by.is_empty(), "{v:?}");
        assert!(c.presence_allowed());
    }
    let a = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text(&short))));
    let b = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text(&long))));
    assert!(a.iter().max() < b.iter().min(), "{a:?} {b:?}");
    drain(&mut srv, &mut alice);
    drain(&mut srv, &mut alice2);

    // ── группа: политика в журнале, право как у изменения сведений ──
    let perms = Permissions { send_messages: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "Тихая", &["bob@local".to_string()], perms).unwrap();
    srv.handle("alice@local", "d1", &req);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    drain(&mut srv, &mut bob);
    let policy = |on: bool| gpb::group_change::Change::SetPrivacyMode(gpb::SetPrivacyMode { l2: on });
    // Участник без права менять сведения — отказ (состояние не меняется).
    assert_eq!(bob.group_change(&g.id, policy(true)).err(), Some(parvane_protocol::ProtoError::Forbidden));
    assert!(!bob.l2_group(&g.id).active && bob.l2_group(&g.id).ephemeral_allowed);
    // ChatMode в группе не отправляется — режим задаёт журнал.
    let cm = Content { kind: Some(content::Kind::ChatMode(mpb::ChatMode { l2: true })), ..Default::default() };
    assert!(matches!(alice.prepare_group(&g.id, &cm), Err(ClientError::Proto(_))));

    let plain = inner_sizes(&run_collect(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text(&short))));
    assert!(!plain.iter().all(|n| on_grid(*n)), "{plain:?}");
    drain(&mut srv, &mut bob);

    let req = alice.group_change(&g.id, policy(true)).unwrap();
    srv.handle("alice@local", "d1", &req);
    let v = alice.l2_group(&g.id);
    assert!(v.active && v.pad && !v.ephemeral_allowed && v.enabled_by == vec!["alice@local".to_string()], "{v:?}");
    assert!(!alice.presence_allowed());
    assert!(!alice.group_state(&g.id).unwrap().epoch_stale, "смена режима не требует новой эпохи");
    assert_eq!(alice.l2_active_chats(), (vec![], vec![g.id.clone()]));
    drain(&mut srv, &mut bob);
    let v = bob.l2_group(&g.id);
    assert!(v.active && !v.mine && v.pad && !v.ephemeral_allowed && v.enabled_by == vec!["alice@local".to_string()], "{v:?}");
    // Групповые конверты обоих — на сетке, одинаковые для разных длин.
    let a = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_group(&g.id, &text(&short))));
    let b = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_group(&g.id, &text(&long))));
    assert!(a.iter().chain(b.iter()).all(|n| on_grid(*n)), "{a:?} {b:?}");
    assert_eq!(a.last(), b.last());
    let ev = drain(&mut srv, &mut alice);
    assert!(texts(&ev).iter().any(|t| t.2 == long), "{ev:?} {:?}", alice.last_error);

    // Политика снята; личное предпочтение Боба выравнивает только его исходящие
    // и не выключает typing в группе.
    let req = alice.group_change(&g.id, policy(false)).unwrap();
    srv.handle("alice@local", "d1", &req);
    drain(&mut srv, &mut bob);
    assert!(!bob.l2_group(&g.id).active && alice.presence_allowed());
    bob.l2_set_group_pref(&g.id, true);
    let mut bob = Client::import(&bob.export(&key).unwrap(), &key).unwrap();
    let v = bob.l2_group(&g.id);
    assert!(!v.active && v.mine && v.pad && v.ephemeral_allowed && bob.presence_allowed(), "{v:?}");
    let b = inner_sizes(&run_collect(&mut srv, &mut bob, &mut |c| c.prepare_group(&g.id, &text(&short))));
    assert!(b.iter().all(|n| on_grid(*n)), "{b:?}");
    let a = inner_sizes(&run_collect(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text(&short))));
    assert!(!a.iter().all(|n| on_grid(*n)), "{a:?}");
    bob.l2_set_group_pref(&g.id, false);
    assert!(!bob.l2_group(&g.id).pad);
}

// ── звонки (D-08): сигнал в sealed-конверте мимо журнала ─────────────────────

fn call_offer(call_id: &[u8], sdp: &str) -> parvane_protocol::pb::parvane::call::v2::CallSignal {
    use parvane_protocol::pb::parvane::call::v2::{call_signal::Signal, CallSignal, Offer};
    CallSignal { call_id: call_id.to_vec(), signal: Some(Signal::Offer(Offer { sdp: sdp.into(), video: false, group: None })), group_call_id: vec![] }
}

/// Конверты запроса звонка как живые записи без места в журнале (seq = 0).
fn live_records(req: &OutRequest) -> Vec<Vec<u8>> {
    use parvane_protocol::pb::parvane::call::v2::SignalSealedRequest;
    let q: SignalSealedRequest = decode_checked(&req.body, Origin::Client).unwrap();
    q.envelopes
        .into_iter()
        .map(|e| InboxRecord { seq: 0, received_ms: 0, item: Some(inbox_record::Item::Sealed(e)) }.encode_to_vec())
        .collect()
}

#[test]
fn call_signal_sealed_roundtrip() {
    use parvane_protocol::pb::parvane::call::v2::{call_signal::Signal, Answer, CallSignal};
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    // Переписка до звонка: журналы, сессии и ключи доступа известны обеим сторонам.
    let bob_dk = *bob.delivery_key();
    alice_set_peer_key(&mut alice, &mut srv, &mut bob, bob_dk);
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("привет")));
    drain(&mut srv, &mut bob);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("и тебе")));
    drain(&mut srv, &mut alice);

    // Оффер: анонимный канал, метод «звонок будит устройства», SDP серверу не виден.
    let call_id = [7u8; 16];
    let offer = call_offer(&call_id, "v=0 SDP-OFFER");
    let reqs = run_collect(&mut srv, &mut alice, &mut |c| c.prepare_call("bob@local", &offer));
    assert_eq!(reqs.len(), 1);
    assert_eq!((reqs[0].chan, reqs[0].method), (Chan::Anon, "call.ring_sealed"));
    assert!(!reqs[0].body.windows(13).any(|w| w == b"v=0 SDP-OFFER"), "SDP виден серверу");
    assert!(!reqs[0].body.windows(11).any(|w| w == b"alice@local"), "отправитель виден серверу");

    // Боб открывает живую запись: событие звонка с отправителем и тем же сигналом.
    let records = live_records(&reqs[0]);
    assert_eq!(records.len(), 1);
    let ev = bob.open_record(&records[0]).unwrap();
    match ev.as_slice() {
        [Event::Call { from, device, call_id: id, signal, .. }] => {
            assert_eq!((from.as_str(), device.as_str(), id.as_slice()), ("alice@local", "d1", &call_id[..]));
            assert_eq!(signal, &offer);
        }
        other => panic!("{other:?}"),
    }
    // Повтор того же конверта не даёт второго события.
    assert!(!matches!(bob.open_record(&records[0]), Ok(ev) if !ev.is_empty()), "повтор сигнала принят");

    // Ответ и прочие сигналы — без пробуждения устройств.
    let answer = CallSignal { call_id: call_id.to_vec(), signal: Some(Signal::Answer(Answer { sdp: "v=0 SDP-ANSWER".into() })), group_call_id: vec![] };
    let reqs = run_collect(&mut srv, &mut bob, &mut |c| c.prepare_call("alice@local", &answer));
    assert_eq!(reqs[0].method, "call.signal_sealed");
    let ev = alice.open_record(&live_records(&reqs[0])[0]).unwrap();
    assert!(matches!(ev.as_slice(), [Event::Call { from, signal, .. }] if from == "bob@local" && signal == &answer), "{ev:?}");

    // Обычное сообщение без места в журнале (seq = 0) не принимается.
    let msg_reqs = run_collect(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("мимо журнала")));
    let q: mpb::DeliverSealedRequest = decode_checked(&msg_reqs[0].body, Origin::Client).unwrap();
    let rec = InboxRecord { seq: 0, received_ms: 0, item: Some(inbox_record::Item::Sealed(q.envelopes[0].clone())) }.encode_to_vec();
    assert!(bob.open_record(&rec).map(|e| e.is_empty()).unwrap_or(true), "сообщение мимо журнала принято");

    // Негодные вызовы: звонок себе, id звонка не 16 байт.
    assert!(alice.prepare_call("alice@local", &offer).is_err());
    assert!(alice.prepare_call("bob@local", &call_offer(&[1u8; 8], "x")).is_err());

    // Групповой звонок (FR-062, T141): приглашение будит устройства, оффер пары
    // внутри группового звонка — обычный сигнал; оба несут состав/id звонка
    // только внутри конверта.
    use parvane_protocol::pb::parvane::call::v2::GroupRing;
    use parvane_protocol::pb::parvane::core::v2::UserRef;
    let group_call = [9u8; 16];
    let ring = CallSignal {
        call_id: group_call.to_vec(),
        signal: Some(Signal::GroupRing(GroupRing {
            participants: ["alice@local", "bob@local", "carol@local"].iter().map(|a| UserRef { address: a.to_string() }).collect(),
            video: true,
            group: None,
        })),
        group_call_id: vec![],
    };
    let reqs = run_collect(&mut srv, &mut alice, &mut |c| c.prepare_call("bob@local", &ring));
    assert_eq!((reqs[0].chan, reqs[0].method), (Chan::Anon, "call.ring_sealed"));
    assert!(!reqs[0].body.windows(11).any(|w| w == b"carol@local"), "состав звонка виден серверу");
    let ev = bob.open_record(&live_records(&reqs[0])[0]).unwrap();
    assert!(matches!(ev.as_slice(), [Event::Call { from, call_id: id, signal, .. }] if from == "alice@local" && id.as_slice() == group_call && signal == &ring), "{ev:?}");

    let mut mesh = call_offer(&[3u8; 16], "v=0 MESH-OFFER");
    mesh.group_call_id = group_call.to_vec();
    let reqs = run_collect(&mut srv, &mut alice, &mut |c| c.prepare_call("bob@local", &mesh));
    assert_eq!(reqs[0].method, "call.signal_sealed", "оффер пары mesh не тратит лимит вызовов");
    let ev = bob.open_record(&live_records(&reqs[0])[0]).unwrap();
    assert!(matches!(ev.as_slice(), [Event::Call { signal, .. }] if signal.group_call_id == group_call), "{ev:?}");
    let mut bad = call_offer(&[4u8; 16], "x");
    bad.group_call_id = vec![1u8; 5];
    assert!(alice.prepare_call("bob@local", &bad).is_err(), "id группового звонка не 16 байт");
}

/// Звонок тому, кто нам писал, а мы ему — нет: вызов сначала раздаёт адресату
/// наш ключ доступа (иначе он принял бы звонок, но не смог бы ответить —
/// сигналы звонка по слепому жетону сервер не принимает).
#[test]
fn call_ring_shares_delivery_key_first() {
    use parvane_protocol::pb::parvane::call::v2::{call_signal::Signal, Answer, CallSignal};
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    // Боб написал Алисе (она знает его ключ доступа), Алиса не отвечала.
    alice_set_peer_key(&mut alice, &mut srv, &mut bob, [0; 32]);
    assert!(alice.has_peer_delivery_key("bob@local"));

    let call_id = [5u8; 16];
    let offer = call_offer(&call_id, "v=0 OFFER");
    let reqs = run_collect(&mut srv, &mut alice, &mut |c| c.prepare_call("bob@local", &offer));
    let methods: Vec<&str> = reqs.iter().map(|r| r.method).collect();
    assert_eq!(methods, ["msg.deliver_sealed", "call.ring_sealed"], "сначала свой ключ доступа, затем вызов");
    // Повторный вызов ключ заново не раздаёт.
    let again = run_collect(&mut srv, &mut alice, &mut |c| c.prepare_call("bob@local", &call_offer(&[6u8; 16], "v=0")));
    assert_eq!(again.iter().map(|r| r.method).collect::<Vec<_>>(), ["call.ring_sealed"]);

    // Боб получил ключ (запись журнала) и вызов — и может ответить.
    drain(&mut srv, &mut bob);
    let ring = reqs.iter().find(|r| r.method == "call.ring_sealed").unwrap();
    assert!(matches!(bob.open_record(&live_records(ring)[0]).unwrap().as_slice(), [Event::Call { .. }]));
    let answer = CallSignal { call_id: call_id.to_vec(), signal: Some(Signal::Answer(Answer { sdp: "v=0 ANSWER".into() })), group_call_id: vec![] };
    let back = run_collect(&mut srv, &mut bob, &mut |c| c.prepare_call("alice@local", &answer));
    assert_eq!(back.iter().map(|r| r.method).collect::<Vec<_>>(), ["call.signal_sealed"]);
}

// ── переходный период (FR-058): подписанный список v1-устройств ──────────────

#[test]
fn legacy_device_set_is_signed_and_only_shrinks() {
    use parvane_protocol::pb::parvane::core::v2::LegacyDevice;
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    let old = |id: &str, b: u8| LegacyDevice { device_id: id.into(), olm_curve25519: vec![b; 32], olm_ed25519: vec![b + 1; 32] };
    assert!(alice.legacy_devices("alice@local").is_none(), "список до публикации");

    // Алиса публикует свои v1-устройства; Боб видит их по её журналу.
    let req = alice.legacy_devices_request(vec![old("desk", 5), old("phone", 7)]).unwrap();
    assert_eq!(req.method, "identity.device.log_append");
    srv.handle("alice@local", "d1", &req);
    // Свой журнал запись получает синком, а не при подготовке запроса.
    assert!(alice.legacy_devices("alice@local").is_none(), "журнал изменён до подтверждения сервера");
    let sync_own = |c: &mut Client, srv: &Server| {
        let known = c.log_version("alice@local") as usize;
        c.ingest_log("alice@local", srv.logs["alice@local"][known..].to_vec()).unwrap();
    };
    sync_own(&mut alice, &srv);
    let alice_log = srv.logs["alice@local"].clone();
    bob.ingest_log("alice@local", alice_log).unwrap();
    let seen = bob.legacy_devices("alice@local").unwrap();
    assert_eq!(seen.iter().map(|d| d.device_id.as_str()).collect::<Vec<_>>(), vec!["desk", "phone"]);
    assert_eq!(bob.log_devices("alice@local").1, vec!["desk".to_string(), "phone".to_string()]);

    // Сократить можно (устройство перешло на v2 или отозвано), расширить — нет.
    let req = alice.legacy_devices_request(vec![old("desk", 5)]).unwrap();
    srv.handle("alice@local", "d1", &req);
    sync_own(&mut alice, &srv);
    assert!(alice.legacy_devices_request(vec![old("desk", 5), old("late", 9)]).is_err(), "список расширен");
    assert_eq!(alice.legacy_devices("alice@local").unwrap().len(), 1);
    // Чужое устройство без SSK этого пользователя список не публикует.
    let mut stranger = Client::new("alice@local", "d9", "local").unwrap();
    assert!(stranger.legacy_devices_request(vec![]).is_err());
}

/// T127 (FR-013/FR-064): «печатает» и присутствие v2-собеседнику идут
/// эфемерными каналами — секретный id, payload под ключом канала, без `{from, to}`.
#[test]
fn ephemeral_typing_and_presence() {
    use parvane_protocol::group::verify_group_typing;
    use parvane_protocol::pb::parvane::msg::v2::TypingAction;
    let mut srv = Server::default();
    let mut alice = setup(&mut srv, "alice@local");
    let mut bob = setup(&mut srv, "bob@local");
    let carol = setup(&mut srv, "carol@local");
    // До обмена ключами доставки канала нет: сигнал не шлётся никак.
    assert!(alice.typing_request("bob@local", TypingAction::Typing).unwrap().is_none());
    assert!(alice.eph_subscribe(&["bob@local".to_string()], &[]).is_empty());

    let bob_dk = *bob.delivery_key();
    alice_set_peer_key(&mut alice, &mut srv, &mut bob, bob_dk);
    run(&mut srv, &mut alice, &mut |c| c.prepare_direct("bob@local", &text("привет")));
    drain(&mut srv, &mut bob);
    run(&mut srv, &mut bob, &mut |c| c.prepare_direct("alice@local", &text("и тебе")));
    drain(&mut srv, &mut alice);

    // Подписка: присутствие собеседника + «печатает» чата; повтор — без запросов.
    let subs = alice.eph_subscribe(&["bob@local".to_string()], &[]);
    assert_eq!(subs.len(), 1);
    assert_eq!((subs[0].chan, subs[0].method), (Chan::Id, "ephemeral.subscribe"));
    let sub: mpb::EphemeralSubscribeRequest = decode_checked(&subs[0].body, Origin::Client).unwrap();
    assert_eq!(sub.channel_ids.len(), 2);
    assert!(alice.eph_subscribe(&["bob@local".to_string()], &[]).is_empty(), "повторная подписка");
    assert_eq!(bob.eph_subscribe(&["alice@local".to_string()], &[]).len(), 1);

    // «Печатает»: сервер видит только id канала и шифртекст фиксированной длины.
    let typing = alice.typing_request("bob@local", TypingAction::Typing).unwrap().unwrap();
    assert_eq!((typing.chan, typing.method), (Chan::Id, "ephemeral.typing"));
    assert!(!typing.body.windows(11).any(|w| w == b"alice@local"), "автор виден серверу");
    assert!(!typing.body.windows(9).any(|w| w == b"bob@local"), "адресат виден серверу");
    let q: mpb::EphemeralTypingRequest = decode_checked(&typing.body, Origin::Client).unwrap();
    assert!(sub.channel_ids.contains(&q.channel_id), "канал чата не тот, на который подписан собеседник");
    match bob.open_ephemeral(&typing.body) {
        Some(Event::Typing { chat, group: None, from, action, .. }) => {
            assert_eq!((chat.as_str(), from.as_str(), action), ("alice@local", "alice@local", TypingAction::Typing as i32));
        }
        other => panic!("{other:?}"),
    }
    assert!(alice.open_ephemeral(&typing.body).is_none(), "своё эхо принято");
    assert!(carol.open_ephemeral(&typing.body).is_none(), "посторонний открыл канал");

    // Присутствие: свой канал из своего ключа доставки.
    let presence = alice.presence_request(true, 0).unwrap().unwrap();
    assert_eq!(presence.method, "ephemeral.presence");
    assert!(matches!(bob.open_ephemeral(&presence.body), Some(Event::Presence { from, online: true, .. }) if from == "alice@local"));
    // Боб не может выдать себя за Алису в её канале присутствия: автор не тот.
    let forged = bob.presence_request(true, 0).unwrap().unwrap();
    let mut fq: mpb::EphemeralPresenceRequest = decode_checked(&forged.body, Origin::Client).unwrap();
    fq.channel_id = decode_checked::<mpb::EphemeralPresenceRequest>(&presence.body, Origin::Client).unwrap().channel_id;
    assert!(bob.open_ephemeral(&fq.encode_to_vec()).is_none());
    // Старый сигнал (повтор) не принимается.
    advance_clock(60_000);
    assert!(bob.open_ephemeral(&typing.body).is_none(), "устаревший сигнал принят");

    // Группа: анонимно, подпись ключом отправки эпохи, автор — внутри шифртекста.
    let perms = Permissions { send_messages: true, ..Default::default() };
    let (g, req) = alice.group_create(GroupKind::Group, "Семья", &["bob@local".to_string()], perms).unwrap();
    srv.handle("alice@local", "d1", &req);
    run(&mut srv, &mut alice, &mut |c| c.group_rotate_epoch(&g.id));
    run(&mut srv, &mut alice, &mut |c| c.prepare_group(&g.id, &text("всем привет")));
    drain(&mut srv, &mut bob);
    assert_eq!(bob.eph_subscribe(&[], &[g.id.clone()]).len(), 1);
    let gt = alice.group_typing_request(&g.id, TypingAction::RecordingVoice).unwrap().unwrap();
    assert_eq!((gt.chan, gt.method), (Chan::Anon, "ephemeral.group_typing"));
    assert!(!gt.body.windows(11).any(|w| w == b"alice@local"), "автор виден серверу");
    let gq: mpb::EphemeralGroupTypingRequest = decode_checked(&gt.body, Origin::Client).unwrap();
    let send_pk = bob.group_state(&g.id).unwrap().send_public_key.unwrap();
    verify_group_typing(&send_pk, &g, gq.epoch, &gq.nonce, &gq.payload, &gq.epoch_signature).unwrap();
    match bob.open_ephemeral(&gt.body) {
        Some(Event::Typing { group: Some(id), from, action, .. }) => {
            assert_eq!((id, from.as_str(), action), (g.id.clone(), "alice@local", TypingAction::RecordingVoice as i32));
        }
        other => panic!("{other:?}"),
    }
    assert!(carol.open_ephemeral(&gt.body).is_none());

    // L2 в личном чате: ни «печатает», ни присутствия (оно одно на аккаунт).
    run(&mut srv, &mut alice, &mut |c| c.l2_set_direct("bob@local", true));
    drain(&mut srv, &mut bob);
    assert!(alice.typing_request("bob@local", TypingAction::Typing).unwrap().is_none(), "«печатает» в L2");
    assert!(alice.presence_request(true, 0).unwrap().is_none(), "присутствие в L2");
    assert!(bob.typing_request("alice@local", TypingAction::Typing).unwrap().is_none(), "собеседник шлёт «печатает» в L2");
    // После переподключения подписки строятся заново; каналы L2-чата — нет.
    alice.eph_reset();
    let again = alice.eph_subscribe(&["bob@local".to_string()], &[]);
    let ids: Vec<Vec<u8>> = again.iter().flat_map(|r| decode_checked::<mpb::EphemeralSubscribeRequest>(&r.body, Origin::Client).unwrap().channel_ids).collect();
    assert_eq!(ids.len(), 1, "в L2 остаётся только канал присутствия собеседника");
}

