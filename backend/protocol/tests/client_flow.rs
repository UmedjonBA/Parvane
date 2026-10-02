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
            "group.state.append" | "group.epoch.publish_send_key" | "group.invite.create" | "group.join" => {
                let entry = match r.method {
                    "group.state.append" => decode_checked::<gpb::StateAppendRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    "group.invite.create" => decode_checked::<gpb::InviteCreateRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
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
