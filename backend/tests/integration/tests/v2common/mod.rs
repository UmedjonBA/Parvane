//! Общие помощники для #[ignore]-тестов v2 (T041 инжектор, T109 бенч):
//! v2-соединение по TCP (преамбула `PVN2`) со счётчиком байтов на проводе и
//! «хост» клиентского ядра `parvane_protocol::client::Client` (выполнение
//! `OutRequest` и добор `Need`). Скопировано и расширено из v2_live.rs.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use parvane_protocol::client::{Chan, Client, ClientError, Need, OutRequest};
use parvane_protocol::codec::{self, TcpDecoder, TCP_MAGIC};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{frame, response, Auth, Channel, ErrorCode, Frame, Hello, Request, UserRef};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use prost::Message;

pub const PASSWORD: &str = "e2e-Test-pass-2026";

/// v2-соединение со счётчиками байтов (TCP-полезная нагрузка, обе стороны).
pub struct Conn {
    pub s: TcpStream,
    dec: TcpDecoder,
    next_id: u64,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    /// События, пришедшие во время ожидания ответа.
    pub events: Vec<frame::Kind>,
}

impl Conn {
    pub fn connect(addr: &str, channel: Channel) -> (Conn, Frame) {
        let s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.set_nodelay(true).unwrap();
        let mut c = Conn { s, dec: TcpDecoder::new(), next_id: 0, tx_bytes: 0, rx_bytes: 0, events: vec![] };
        c.write(TCP_MAGIC);
        c.send(frame::Kind::Hello(Hello { proto_minor: 0, channel: channel as i32, ..Default::default() }));
        let w = c.recv().expect("welcome");
        (c, w)
    }
    fn write(&mut self, b: &[u8]) {
        self.s.write_all(b).unwrap();
        self.tx_bytes += b.len() as u64;
    }
    pub fn send(&mut self, k: frame::Kind) {
        let b = codec::tcp_encode(&codec::encode_frame(k));
        self.write(&b);
    }
    pub fn recv(&mut self) -> Option<Frame> {
        let mut buf = [0u8; 65536];
        loop {
            if let Ok(Some(f)) = self.dec.next_frame() {
                return codec::decode_frame(&f, Origin::Server).ok();
            }
            match self.s.read(&mut buf) {
                Ok(0) | Err(_) => return None,
                Ok(n) => {
                    self.rx_bytes += n as u64;
                    self.dec.push(&buf[..n]).ok()?
                }
            }
        }
    }
    /// Запрос → Ok(тело) | Err(код); события по дороге копятся в `events`.
    pub fn call(&mut self, method: &str, body: Vec<u8>) -> Result<Vec<u8>, ErrorCode> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(frame::Kind::Request(Request { id, method: method.into(), body, timeout_ms: 5000 }));
        loop {
            let f = self.recv().ok_or(ErrorCode::Unavailable)?;
            match f.kind {
                Some(frame::Kind::Response(r)) if r.id == id => {
                    return match r.result {
                        Some(response::Result::Ok(b)) => Ok(b),
                        Some(response::Result::Error(e)) => Err(ErrorCode::try_from(e.code).unwrap_or(ErrorCode::Unspecified)),
                        None => Err(ErrorCode::Unspecified),
                    };
                }
                Some(k @ frame::Kind::Event(_)) => self.events.push(k),
                _ => {}
            }
        }
    }
    /// Следующее событие (из накопленных или из сокета).
    pub fn next_event(&mut self) -> Option<parvane_protocol::pb::parvane::core::v2::Event> {
        loop {
            if !self.events.is_empty() {
                if let frame::Kind::Event(e) = self.events.remove(0) {
                    return Some(e);
                }
                continue;
            }
            match self.recv()?.kind {
                Some(frame::Kind::Event(e)) => return Some(e),
                _ => continue,
            }
        }
    }
}

/// Устройство v2: ядро + идентифицированная и анонимная сессии.
pub struct Device {
    pub client: Client,
    pub id: Conn,
    pub anon: Conn,
    pub server_key: [u8; 32],
    pub domain: String,
}

impl Device {
    /// Зарегистрировать пользователя через v2, войти устройством `device_id`,
    /// создать личность (корень, журнал устройств, прекеи, ключ доставки).
    pub fn register(addr: &str, user: &str, device_id: &str) -> Device {
        let (mut id, w) = Conn::connect(addr, Channel::Identified);
        let Some(frame::Kind::Welcome(w)) = w.kind else { panic!("нет Welcome: {w:?}") };
        let (domain, server_key) = parvane_protocol::client::verify_server_descriptor(&w.server_descriptor).expect("описатель сервера");
        let _ = id.call("identity.account.register", ipb::AccountRegisterRequest { user: user.into(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec());
        let tok = id
            .call("identity.session.issue", ipb::SessionIssueRequest { login: user.into(), password: PASSWORD.into(), device_id: device_id.into(), ..Default::default() }.encode_to_vec())
            .map(|b| ipb::SessionIssueResponse::decode(b.as_slice()).unwrap_or_default().token)
            .expect("session.issue");
        id.send(frame::Kind::Auth(Auth { token: tok }));
        assert!(matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth");
        let (anon, _) = Conn::connect(addr, Channel::AnonymousDelivery);
        let client = Client::new(user, device_id, &domain).expect("Client::new");
        let mut d = Device { client, id, anon, server_key, domain };
        let (reqs, _root) = d.client.create_identity(20).expect("create_identity");
        d.run(&reqs).expect("личность");
        d
    }

    pub fn exec(&mut self, r: &OutRequest) -> Result<Vec<u8>, ErrorCode> {
        match r.chan {
            Chan::Id => self.id.call(r.method, r.body.clone()),
            Chan::Anon => self.anon.call(r.method, r.body.clone()),
        }
    }

    pub fn run(&mut self, reqs: &[OutRequest]) -> Result<(), (String, ErrorCode)> {
        for r in reqs {
            self.exec(r).map_err(|e| (r.method.to_string(), e))?;
        }
        Ok(())
    }

    /// Получить жетоны (ключи выпуска — анонимно, D-06).
    pub fn fetch_tokens(&mut self, n: usize) {
        let kl = self.anon.call("identity.tokens.key_list", self.client.token_key_list_request().body).expect("key_list");
        let list = ipb::TokensKeyListResponse::decode(kl.as_slice()).unwrap().list.expect("список ключей");
        let req = self.client.token_request(&list, &self.server_key, n).expect("token_request");
        let resp = self.exec(&req).expect("issue_blinded");
        self.client.token_response(&ipb::TokensIssueBlindedResponse::decode(resp.as_slice()).unwrap()).expect("token_response");
    }

    /// Добрать то, чего не хватило ядру.
    pub fn satisfy(&mut self, n: &Need) -> bool {
        match n {
            Need::PeerLog { user, .. } => {
                let after = self.client.log_version(user);
                let r = self.anon.call(
                    "identity.device.log_sync_anon",
                    ipb::DeviceLogSyncAnonRequest { user: Some(UserRef { address: user.clone() }), after_version: after }.encode_to_vec(),
                );
                let Ok(b) = r else { return false };
                let entries = ipb::DeviceLogSyncAnonResponse::decode(b.as_slice()).unwrap_or_default().entries;
                self.client.ingest_log(user, entries).is_ok()
            }
            Need::Bundle { user } => {
                let r = self.anon.call("identity.device.fetch_bundle_anon", ipb::DeviceFetchBundleAnonRequest { user: Some(UserRef { address: user.clone() }) }.encode_to_vec());
                let Ok(b) = r else { return false };
                let devices = ipb::DeviceFetchBundleAnonResponse::decode(b.as_slice()).unwrap_or_default().devices;
                self.client.ingest_bundle(user, devices).is_ok()
            }
            Need::Token { .. } => {
                self.fetch_tokens(20);
                true
            }
            _ => false,
        }
    }

    /// Операция ядра с добором `Need` и выполнением запросов.
    pub fn op(&mut self, f: &mut dyn FnMut(&mut Client) -> Result<Vec<OutRequest>, ClientError>) -> Result<(), String> {
        for _ in 0..8 {
            match f(&mut self.client) {
                Ok(reqs) => return self.run(&reqs).map_err(|e| format!("{e:?}")),
                Err(ClientError::Need(n)) => {
                    if !self.satisfy(&n) {
                        return Err(format!("не добрать {n:?}"));
                    }
                }
                Err(e) => return Err(format!("{e:?}")),
            }
        }
        Err("не сошлось".into())
    }

    /// Открыть запись инбокса с добором `Need`.
    pub fn open(&mut self, rec: &[u8]) -> Vec<parvane_protocol::client::Event> {
        for _ in 0..8 {
            match self.client.open_record(rec) {
                Ok(ev) => return ev,
                Err(ClientError::Need(n)) => {
                    if !self.satisfy(&n) {
                        return vec![];
                    }
                }
                Err(_) => return vec![],
            }
        }
        vec![]
    }
}
