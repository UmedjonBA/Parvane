//! Протокол v2 в gateway (spec 007, E1: T032–T035). Двойной стек: соединение
//! v1 (JSON-текст) обслуживает `session::serve` без изменений; v2 опознаётся
//! по первому кадру — двоичный `Hello` в WebSocket или преамбула `PVN2` в TCP.
//!
//! v2-сессия: Hello → Welcome (подписанный описатель сервера) → [Auth →
//! AuthOk] → Request/Response/Event/StreamChunk. Каждый запрос проверяется
//! движком по реестру (лимиты тела — до разбора), затем допуском по каналу,
//! роли, свежести пароля и классу частоты, и уходит шарду как `ShardRequest`
//! с личностью из проверенного JWT. Анонимный канал (`CHANNEL_ANONYMOUS_DELIVERY`)
//! не несёт ни токена, ни адреса, ни IP (класс 11, D-05; `anon.rs`).
//! Эфемерные каналы typing/presence/«печатает» группы — `ephemeral.rs`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_nats::Client;
use futures::{SinkExt, StreamExt};
use parvane_protocol::codec::{self, decode_checked, TcpDecoder};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    frame, response, shard_response, AuthOk, Channel, Error, ErrorCode, Event, Pong, Request, Response, RevokedNotice,
    ShardRequest, ShardResponse, ShardStreamChunk, StreamChunk, Welcome,
};
use parvane_protocol::pb::parvane::identity::v2::{ServerDescribeResponse, SessionReauthResponse};
use parvane_protocol::pb::parvane::msg::v2::{
    EphemeralGroupTypingRequest, EphemeralPresenceRequest, EphemeralSubscribeRequest, EphemeralSubscribeResponse,
    EphemeralTypingRequest, GroupEpochInfo, GroupEpochQuery, InboxRecord, InboxSubscribeResponse,
};
use parvane_protocol::pb::parvane::core::v2::{federation_out, FederationOut, S2sEphemeral};
use parvane_protocol::registry_gen::{
    eph_subject, inbox_subject, FEDERATION_OUT, INTERNAL_EPH_IN, INTERNAL_GROUP_EPOCH, REVOKED_SUBJECT,
};
use parvane_protocol::schema::MethodInfo;
use parvane_protocol::ProtoError;
use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, RwLock, Semaphore};
use tracing::{debug, info, warn};

pub(crate) mod anon;
pub(crate) mod ephemeral;
pub(crate) mod inq;
pub(crate) mod limits;
pub(crate) mod outq;
#[cfg(test)]
mod tests;

use outq::OutQueue;

use limits::{Access, AnonIpLimits, RingCooldown, V2Rate, REAUTH_WINDOW_MS};

/// Потолок подписок v2 на сессию (как P-33): инбокс + эфемерные каналы — по
/// два на собеседника (присутствие, «печатает») и один на группу; движок
/// клиента держит не больше 240 каналов.
pub(crate) const MAX_SUBS: usize = 256;
/// Кэш описателя сервера.
const DESCRIPTOR_TTL: Duration = Duration::from_secs(600);

/// Общее состояние v2 для всех сессий.
pub(crate) struct Shared {
    pub nats: Arc<Client>,
    /// S7-13: соединение для ящиков потоков с малой ёмкостью подписки (окно потока ≤ `STREAM_WINDOW`
    /// кусков, так что больше в ящике не бывает; лишнее не копится в памяти).
    pub stream_nats: Arc<Client>,
    descriptor: RwLock<Option<(Instant, Vec<u8>)>>,
    revoked: broadcast::Sender<(String, String)>,
    pub min_minor: u32,
    pub features: Vec<String>,
    pub operators: Vec<String>,
    /// Связи каналов присутствия и повторы «печатает» группы (только память).
    pub eph: ephemeral::EphState,
    /// Лимит ANON-запросов на IP-источник (ключ — хэш, только память; D-08).
    pub anon_ip: AnonIpLimits,
    /// Свой домен (`PARVANE_DOMAIN`): запрос с другим `dest_domain` уходит через шард federation (spec 028).
    pub domain: String,
    /// PV-010: общий бюджет входящих байтов всех сессий (кадры в очередях и запросы в полёте).
    pub in_global: Arc<Semaphore>,
    pub in_global_max: usize,
}

/// Свой домен — как у шардов: обрезка `@`, нижний регистр, по умолчанию `local`.
fn own_domain() -> String {
    let d = std::env::var("PARVANE_DOMAIN").unwrap_or_default().trim().trim_start_matches('@').to_lowercase();
    if d.is_empty() {
        "local".into()
    } else {
        d
    }
}

fn env_list(name: &str) -> Vec<String> {
    std::env::var(name).unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

impl Shared {
    /// Создать и подписаться на события отзыва устройств (класс 5).
    pub(crate) async fn start(nats: Arc<Client>, stream_nats: Arc<Client>) -> anyhow::Result<Arc<Self>> {
        let (tx, _) = broadcast::channel(1024);
        let sh = Arc::new(Self {
            nats: nats.clone(),
            stream_nats,
            descriptor: RwLock::new(None),
            revoked: tx.clone(),
            min_minor: std::env::var("PARVANE_V2_MIN_MINOR").ok().and_then(|v| v.parse().ok()).unwrap_or(0),
            features: env_list("PARVANE_V2_FEATURES"),
            operators: env_list("PARVANE_OPERATORS"),
            eph: ephemeral::EphState::default(),
            anon_ip: AnonIpLimits::from_env(),
            domain: own_domain(),
            in_global: inq::global_budget(inq::in_global_bytes()),
            in_global_max: inq::in_global_bytes(),
        });
        fed_ephemeral_serve(&sh).await?;
        let mut sub = nats.subscribe(REVOKED_SUBJECT.to_string()).await?;
        let shared = sh.clone();
        tokio::spawn(async move {
            while let Some(m) = sub.next().await {
                if let Ok(n) = decode_checked::<RevokedNotice>(&m.payload, Origin::Server) {
                    // Пустое устройство — адрес выведен из обращения (смена ника): его каналы присутствия
                    // освобождаются — канал тот же (ключ доступа прежний), занимает его новый адрес
                    if n.device_id.is_empty() {
                        shared.eph.release_presence(&n.user);
                        continue;
                    }
                    let _ = tx.send((n.user, n.device_id));
                }
            }
        });
        Ok(sh)
    }

    /// Подписанный описатель сервера (кэш; при недоступности identity — пусто).
    async fn descriptor(&self) -> Vec<u8> {
        if let Some((at, d)) = self.descriptor.read().await.as_ref() {
            if at.elapsed() < DESCRIPTOR_TTL {
                return d.clone();
            }
        }
        let req = ShardRequest { method: "server.describe".into(), deadline_ms: deadline_after(3000), ..Default::default() };
        let got = match parvane_protocol::schema::method("server.describe") {
            Some(m) => shard_call(&self.nats, m.subject, req.encode_to_vec(), 3000).await,
            None => Err(ErrorCode::Unavailable),
        };
        let d = got
            .ok()
            .and_then(|b| decode_checked::<ServerDescribeResponse>(&b, Origin::Server).ok())
            .and_then(|r| r.descriptor)
            .map(|d| d.encode_to_vec())
            .unwrap_or_default();
        if !d.is_empty() {
            *self.descriptor.write().await = Some((Instant::now(), d.clone()));
        }
        d
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// OPT-003: срок ответа для `ShardRequest.deadline_ms` — шард не начинает работу, которую gateway уже бросил.
fn deadline_after(timeout_ms: u64) -> u64 {
    (now_ms().max(0) as u64).saturating_add(timeout_ms)
}

fn err(code: ErrorCode, retry_after_ms: u32) -> Error {
    Error { code: code as i32, retry_after_ms }
}

/// GW-01: сколько ждём места в выходной очереди. Клиент, переставший читать сокет, иначе
/// останавливал бы цикл `serve` вместе с его таймаутами и держал слот соединения.
const SEND_TIMEOUT_SECS: u64 = 10;

async fn send(tx: &OutQueue, kind: frame::Kind) -> bool {
    tx.send(codec::encode_frame(kind)).await
}

async fn respond(tx: &OutQueue, id: u64, r: Result<Vec<u8>, Error>) {
    let result = match r {
        Ok(b) => response::Result::Ok(b),
        Err(e) => response::Result::Error(e),
    };
    send(tx, frame::Kind::Response(Response { id, result: Some(result) })).await;
}

/// Запрос к шарду: ShardRequest → ShardResponse.
async fn shard_call(nats: &Client, subject: &str, req: Vec<u8>, timeout_ms: u64) -> Result<Vec<u8>, ErrorCode> {
    let fut = nats.request(subject.to_string(), req.into());
    let reply = match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(Ok(r)) => r,
        _ => return Err(ErrorCode::Unavailable),
    };
    match decode_checked::<ShardResponse>(&reply.payload, Origin::Server) {
        Ok(ShardResponse { result: Some(shard_response::Result::Ok(b)) }) => Ok(b),
        Ok(ShardResponse { result: Some(shard_response::Result::Error(e)) }) => {
            Err(ErrorCode::try_from(e.code).unwrap_or(ErrorCode::Unavailable))
        }
        _ => Err(ErrorCode::Unavailable),
    }
}

/// Проверить JWT через identity (v1-проверка): (user, device). Устройство
/// обязательно — токен без `dev` в v2 не принимается (класс 5).
async fn verify(nats: &Client, token: &str) -> Result<(String, String), ErrorCode> {
    let req = serde_json::to_vec(&parvane_types::VerifyRequest { token: token.to_string() }).map_err(|_| ErrorCode::Invalid)?;
    let fut = nats.request(parvane_types::topics::IDENTITY_VERIFY, req.into());
    let reply = match tokio::time::timeout(Duration::from_secs(3), fut).await {
        Ok(Ok(r)) => r,
        _ => return Err(ErrorCode::Unavailable),
    };
    let resp: parvane_types::VerifyResponse = serde_json::from_slice(&reply.payload).map_err(|_| ErrorCode::Unavailable)?;
    match (resp.ok, resp.user, resp.device) {
        (true, Some(u), Some(d)) if !d.is_empty() => Ok((u, d)),
        (true, _, _) => Err(ErrorCode::Forbidden),
        _ => Err(ErrorCode::Revoked),
    }
}

/// Состояние одной v2-сессии.
struct Session {
    sh: Arc<Shared>,
    tx: OutQueue,
    /// S7-13: кусков потоков в полёте на сессию (сумма окон всех её потоков).
    stream_credits: Arc<Semaphore>,
    channel: Channel,
    user: String,
    device: String,
    token: String,
    client_ip: String,
    /// Анонимный канал: ключ IP-источника для `Shared::anon_ip` (сам IP не хранится).
    anon_source: Option<u64>,
    /// S7-18: последний запрос прошёл лимиты (продлевает простой анонимного канала).
    admitted: bool,
    reauth_until_ms: i64,
    rate: V2Rate,
    ring: RingCooldown,
    subs: HashMap<u64, Vec<tokio::task::JoinHandle<()>>>,
    sub_count: usize,
    next_sub: u64,
    inbox_sub: Option<u64>,
}

impl Session {
    fn authed(&self) -> bool {
        !self.user.is_empty()
    }

    fn access(&self) -> Access {
        Access {
            channel: self.channel,
            authed: self.authed(),
            operator: self.authed() && self.sh.operators.iter().any(|o| o == &self.user),
            reauth_until_ms: self.reauth_until_ms,
        }
    }

    fn shard_request(&self, m: &MethodInfo, body: Vec<u8>) -> ShardRequest {
        let who = anon::SessionIdentity {
            user: &self.user,
            device: &self.device,
            token: &self.token,
            client_ip: &self.client_ip,
            reauth_fresh: now_ms() <= self.reauth_until_ms,
            operator: self.access().operator,
        };
        let mut sr = anon::shard_request(m, &who, body);
        // S7-23: метка источника — только сигналам звонка, шард call делит по ней бюджет адресата
        if let Some(src) = self.anon_source.filter(|_| anon::is_call_signal(m)) {
            sr.source_tag = src;
        }
        sr
    }

    /// `permit` — байты кадра во входящем бюджете (PV-010): держится, пока запрос не отвечен.
    async fn handle_request(&mut self, req: Request, permit: inq::InPermit) {
        let id = req.id;
        let m = match codec::check_request(&req, Origin::Client) {
            Ok(m) => m,
            Err(e) => return respond(&self.tx, id, Err(err(e.code(), 0))).await,
        };
        if let Err(code) = limits::admit(m, &self.access(), now_ms()) {
            return respond(&self.tx, id, Err(err(code, 0))).await;
        }
        if let Err(wait) = self.rate.allow(m.rate) {
            debug!("v2 rate limit: {}", m.name);
            return respond(&self.tx, id, Err(err(ErrorCode::RateLimited, wait))).await;
        }
        // D-08/D-17: анонимные соединения одноразовые — лимит на IP-источник.
        if let Some(src) = self.anon_source {
            if let Err(wait) = self.sh.anon_ip.allow(src, m.name, Instant::now()) {
                debug!("v2 anon rate limit: {}", m.name);
                return respond(&self.tx, id, Err(err(ErrorCode::RateLimited, wait))).await;
            }
        }
        // S7-18: простой анонимного канала продлевает только допущенный запрос (отвергнутые лимитами — нет)
        self.admitted = true;
        // D-05: один получатель на запрос sealed-доставки/сигнала звонка.
        if let Err(code) = anon::check_single_recipient(m, &req.body) {
            return respond(&self.tx, id, Err(err(code, 0))).await;
        }
        // P-35: cooldown вызова на соединение (адресатный лимит — в шарде call).
        if anon::is_ring(m) {
            if let Err(wait) = self.ring.allow(Instant::now()) {
                return respond(&self.tx, id, Err(err(ErrorCode::RateLimited, wait))).await;
            }
        }
        // Федерация (spec 028): объект на чужом сервере — через шард federation, клиент
        // к чужому серверу не подключается. Только методы с `federated`; IP и JWT дальше не идут.
        let dest = req.dest_domain.trim().to_ascii_lowercase();
        if !dest.is_empty() && dest != self.sh.domain {
            if !m.federated || !parvane_protocol::address::is_valid_domain(&dest) {
                return respond(&self.tx, id, Err(err(ErrorCode::Invalid, 0))).await;
            }
            // «Печатает» собеседнику с другого сервера (R14): канал и запечатанный сигнал — его gateway.
            if m.name == "ephemeral.typing" {
                let r = self.typing_remote(dest, &req.body).await;
                return respond(&self.tx, id, r.map_err(|c| err(c, 0))).await;
            }
            // Остальное своё gateway не пересылает; «печатает» группы проверяет gateway дома группы.
            if m.shard == "gateway" && m.name != "ephemeral.group_typing" {
                return respond(&self.tx, id, Err(err(ErrorCode::Invalid, 0))).await;
            }
            let timeout = u64::from(if req.timeout_ms == 0 { 10_000 } else { req.timeout_ms }).clamp(100, 30_000);
            let mut sr = self.shard_request(m, req.body);
            sr.client_ip.clear();
            sr.token.clear();
            sr.source_tag = 0;
            let out = FederationOut { dest_domain: dest.clone(), timeout_ms: timeout as u32, kind: Some(federation_out::Kind::Forward(sr.clone())) }.encode_to_vec();
            let (nats, tx) = (self.sh.nats.clone(), self.tx.clone());
            // Запас на путь между серверами сверх таймаута самого метода.
            let wait = timeout + 5_000;
            if m.kind == 3 {
                // Окно потока переписывает тело запроса; конверт federation строится на каждое окно заново
                let (snats, credits) = (self.sh.stream_nats.clone(), self.stream_credits.clone());
                let body = sr.body.clone();
                let wrap = move |b: Vec<u8>| {
                    let mut sr = sr.clone();
                    sr.body = b;
                    FederationOut { dest_domain: dest.clone(), timeout_ms: timeout as u32, kind: Some(federation_out::Kind::Forward(sr)) }.encode_to_vec()
                };
                let _ = out;
                tokio::spawn(async move {
                    let _permit = permit;
                    stream(&snats, &tx, id, m, FEDERATION_OUT, body, Box::new(wrap), wait, credits).await
                });
            } else {
                tokio::spawn(async move {
                    let _permit = permit;
                    let r = shard_call(&nats, FEDERATION_OUT, out, wait).await;
                    respond(&tx, id, r.map_err(|c| err(c, 0))).await;
                });
            }
            return;
        }
        if m.shard == "gateway" {
            let r = self.local(m, &req.body).await;
            return respond(&self.tx, id, r.map_err(|c| err(c, 0))).await;
        }
        let timeout = u64::from(if req.timeout_ms == 0 { 3000 } else { req.timeout_ms }).clamp(100, 30_000);
        if m.kind == 3 {
            let base = self.shard_request(m, Vec::new());
            let (snats, tx, credits) = (self.sh.stream_nats.clone(), self.tx.clone(), self.stream_credits.clone());
            // Срок — на каждое окно потока: окно ждёт ответа шарда не дольше `timeout`
            let wrap = move |b: Vec<u8>| ShardRequest { body: b, deadline_ms: deadline_after(timeout), ..base.clone() }.encode_to_vec();
            tokio::spawn(async move {
                let _permit = permit;
                stream(&snats, &tx, id, m, m.subject, req.body, Box::new(wrap), timeout, credits).await
            });
            return;
        }
        let mut sr = self.shard_request(m, req.body);
        sr.deadline_ms = deadline_after(timeout);
        let sreq = sr.encode_to_vec();
        if m.name == "identity.session.reauth" {
            // Ответ меняет состояние сессии — ждём здесь.
            let r = shard_call(&self.sh.nats, m.subject, sreq, timeout).await;
            if let Ok(b) = &r {
                if let Ok(ok) = decode_checked::<SessionReauthResponse>(b, Origin::Server) {
                    self.reauth_until_ms = ok.valid_until_ms.min(now_ms() + REAUTH_WINDOW_MS);
                }
            }
            return respond(&self.tx, id, r.map_err(|c| err(c, 0))).await;
        }
        let (nats, tx) = (self.sh.nats.clone(), self.tx.clone());
        tokio::spawn(async move {
            let _permit = permit;
            let r = shard_call(&nats, m.subject, sreq, timeout).await;
            respond(&tx, id, r.map_err(|c| err(c, 0))).await;
        });
    }

    /// Методы, которые обслуживает сам gateway (подписки, эфемерные).
    async fn local(&mut self, m: &MethodInfo, body: &[u8]) -> Result<Vec<u8>, ErrorCode> {
        match m.name {
            "msg.inbox.subscribe" => {
                if let Some(id) = self.inbox_sub {
                    return Ok(InboxSubscribeResponse { subscription: id }.encode_to_vec());
                }
                let subject = inbox_subject(&self.user, &self.device).map_err(|_| ErrorCode::Invalid)?;
                let id = self.subscribe(vec![subject], "inbox.record").await?;
                self.inbox_sub = Some(id);
                Ok(InboxSubscribeResponse { subscription: id }.encode_to_vec())
            }
            "ephemeral.subscribe" => {
                let r: EphemeralSubscribeRequest = decode_checked(body, Origin::Client).map_err(|e| e.code())?;
                let subjects = r.channel_ids.iter().map(|c| eph_subject(c)).collect::<Result<Vec<_>, _>>().map_err(|_| ErrorCode::Invalid)?;
                let id = self.subscribe(subjects, "ephemeral").await?;
                Ok(EphemeralSubscribeResponse { subscription: id }.encode_to_vec())
            }
            "ephemeral.typing" => {
                let r: EphemeralTypingRequest = decode_checked(body, Origin::Client).map_err(|e| e.code())?;
                self.sh.eph.typing_publish(&r.channel_id, Instant::now())?;
                self.publish_eph(&r.channel_id, body).await
            }
            "ephemeral.presence" => {
                let r: EphemeralPresenceRequest = decode_checked(body, Origin::Client).map_err(|e| e.code())?;
                // Только в свой канал: первая публикация связывает канал с пользователем.
                self.sh.eph.presence_publish(&r.channel_id, &self.user, Instant::now())?;
                self.publish_eph(&r.channel_id, body).await
            }
            "ephemeral.group_typing" => {
                let r: EphemeralGroupTypingRequest = decode_checked(body, Origin::Client).map_err(|e| e.code())?;
                self.group_typing(r).await
            }
            _ => Err(ErrorCode::Unavailable),
        }
    }

    /// T122 (D-07): «печатает» в группе через анонимный канал. Право — подпись
    /// ключом отправки текущей эпохи; автор серверу неизвестен.
    async fn group_typing(&self, r: EphemeralGroupTypingRequest) -> Result<Vec<u8>, ErrorCode> {
        group_typing(&self.sh, r).await.map(|()| vec![])
    }

    /// «Печатает» собеседнику с другого сервера: тот же отказ, что у своего канала, — и в шард federation.
    async fn typing_remote(&self, dest: String, body: &[u8]) -> Result<Vec<u8>, ErrorCode> {
        let r: EphemeralTypingRequest = decode_checked(body, Origin::Client).map_err(|e| e.code())?;
        if r.channel_id.len() != 16 || r.payload.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let out = FederationOut {
            dest_domain: dest,
            timeout_ms: FED_EPH_TIMEOUT_MS,
            kind: Some(federation_out::Kind::Ephemeral(S2sEphemeral { channel_id: r.channel_id, payload: r.payload })),
        };
        shard_call(&self.sh.nats, FEDERATION_OUT, out.encode_to_vec(), u64::from(FED_EPH_TIMEOUT_MS) + 2_000).await
    }

    async fn publish_eph(&self, channel_id: &[u8], body: &[u8]) -> Result<Vec<u8>, ErrorCode> {
        let subject = eph_subject(channel_id).map_err(|_| ErrorCode::Invalid)?;
        self.sh.nats.publish(subject, body.to_vec().into()).await.map_err(|_| ErrorCode::Unavailable)?;
        Ok(vec![])
    }

    async fn subscribe(&mut self, subjects: Vec<String>, kind: &'static str) -> Result<u64, ErrorCode> {
        // D-05: в анонимное соединение событий нет (вторая линия после реестра).
        if !anon::events_allowed(self.channel) {
            return Err(ErrorCode::Forbidden);
        }
        if subjects.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        if self.sub_count + subjects.len() > MAX_SUBS {
            return Err(ErrorCode::Limit);
        }
        self.next_sub += 1;
        let id = self.next_sub;
        let mut handles = Vec::new();
        for s in subjects {
            let mut sub = self.sh.nats.subscribe(s).await.map_err(|_| ErrorCode::Unavailable)?;
            let tx = self.tx.clone();
            handles.push(tokio::spawn(async move {
                while let Some(msg) = sub.next().await {
                    let seq = if kind == "inbox.record" {
                        decode_checked::<InboxRecord>(&msg.payload, Origin::Server).map(|r| r.seq).unwrap_or(0)
                    } else {
                        0
                    };
                    let ev = Event { subscription: id, kind: kind.to_string(), seq, body: msg.payload.to_vec() };
                    if !send(&tx, frame::Kind::Event(ev)).await {
                        break;
                    }
                }
            }));
            self.sub_count += 1;
        }
        self.subs.insert(id, handles);
        Ok(id)
    }

    fn close(&mut self) {
        for (_, hs) in self.subs.drain() {
            for h in hs {
                h.abort();
            }
        }
    }
}

/// Текущая эпоха группы у messenger (внутренний subject, без личности).
async fn group_epoch(nats: &Client, g: &parvane_protocol::pb::parvane::core::v2::Ref) -> Result<GroupEpochInfo, ErrorCode> {
    let q = GroupEpochQuery { group: Some(g.clone()) }.encode_to_vec();
    let fut = nats.request(INTERNAL_GROUP_EPOCH.to_string(), q.into());
    let reply = match tokio::time::timeout(Duration::from_secs(3), fut).await {
        Ok(Ok(r)) => r,
        _ => return Err(ErrorCode::Unavailable),
    };
    decode_checked::<GroupEpochInfo>(&reply.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)
}

/// Таймаут доставки «печатает» на другой сервер: сигнал живёт секунды, повторов нет.
const FED_EPH_TIMEOUT_MS: u32 = 5_000;

/// «Печатает» группы (D-07): проверка подписи ключом текущей эпохи, публикация у себя и рассылка
/// серверам участников с других доменов (R14). Группа — своя: чужие проверяет gateway их дома.
async fn group_typing(sh: &Shared, r: EphemeralGroupTypingRequest) -> Result<(), ErrorCode> {
    let g = r.group.clone().ok_or(ErrorCode::Invalid)?;
    parvane_protocol::address::check_ref(&g).map_err(|_| ErrorCode::Invalid)?;
    if !g.domain.eq_ignore_ascii_case(&sh.domain) {
        return Err(ErrorCode::NotFound);
    }
    if r.nonce.len() != 16 || r.channel_id.len() != 16 || r.epoch_signature.len() != 64 || r.payload.is_empty() {
        return Err(ErrorCode::Invalid);
    }
    let info = group_epoch(&sh.nats, &g).await?;
    if !info.found || info.deleted {
        return Err(ErrorCode::NotFound);
    }
    // После смены состава/прав до новой эпохи ключ мог остаться у исключённого.
    if r.epoch != info.epoch || info.stale {
        return Err(ErrorCode::Expired);
    }
    let pk: [u8; 32] = info.send_public_key.as_slice().try_into().map_err(|_| ErrorCode::Forbidden)?;
    check_group_typing_signature(&pk, &g, &r)?;
    // Публикация в канал присутствия запрещена независимо от подписи.
    sh.eph.typing_publish(&r.channel_id, Instant::now())?;
    sh.eph.group_nonce_fresh(&g.id, &r.nonce, Instant::now())?;
    // Подписчики получают тот же вид, что и личный typing: (channel_id, payload).
    let out = EphemeralTypingRequest { channel_id: r.channel_id.clone(), payload: r.payload.clone() }.encode_to_vec();
    let subject = eph_subject(&r.channel_id).map_err(|_| ErrorCode::Invalid)?;
    sh.nats.publish(subject, out.into()).await.map_err(|_| ErrorCode::Unavailable)?;
    for d in info.remote_domains {
        let out = FederationOut {
            dest_domain: d,
            timeout_ms: FED_EPH_TIMEOUT_MS,
            kind: Some(federation_out::Kind::Ephemeral(S2sEphemeral { channel_id: r.channel_id.clone(), payload: r.payload.clone() })),
        }
        .encode_to_vec();
        let nats = sh.nats.clone();
        // Без ожидания: недоступный сервер участника не задерживает остальных.
        tokio::spawn(async move {
            let _ = shard_call(&nats, FEDERATION_OUT, out, u64::from(FED_EPH_TIMEOUT_MS) + 2_000).await;
        });
    }
    Ok(())
}

/// Подпись «печатает» группы покрывает channel_id (A0015-2). Прежняя подпись без канала больше не принимается
/// (решение пользователя 8 ноя 2026): по ней подписанный сигнал можно было переложить в чужой канал.
pub(crate) fn check_group_typing_signature(pk: &[u8; 32], g: &parvane_protocol::pb::parvane::core::v2::Ref, r: &EphemeralGroupTypingRequest) -> Result<(), ErrorCode> {
    parvane_protocol::group::verify_group_typing(pk, g, r.epoch, &r.channel_id, &r.nonce, &r.payload, &r.epoch_signature).map_err(|_| ErrorCode::Forbidden)
}

/// Федерация (R14): «печатает» с другого сервера. `INTERNAL_EPH_IN` — сигнал в свой канал (собеседник
/// или участник группы здесь), `ephemeral.group_typing` — «печатает» своей группы от участника с другого
/// сервера. Публикует их только шард federation (ACL), кадр уже проверен им; оба — без ответа.
async fn fed_ephemeral_serve(sh: &Arc<Shared>) -> anyhow::Result<()> {
    let mut eph_in = sh.nats.subscribe(INTERNAL_EPH_IN.to_string()).await?;
    let shared = sh.clone();
    tokio::spawn(async move {
        while let Some(m) = eph_in.next().await {
            let Ok(e) = decode_checked::<S2sEphemeral>(&m.payload, Origin::Server) else { continue };
            if e.payload.is_empty() || shared.eph.typing_publish(&e.channel_id, Instant::now()).is_err() {
                continue;
            }
            let Ok(subject) = eph_subject(&e.channel_id) else { continue };
            let out = EphemeralTypingRequest { channel_id: e.channel_id, payload: e.payload }.encode_to_vec();
            let _ = shared.nats.publish(subject, out.into()).await;
        }
    });
    // Ответа нет: у gateway нет права публиковать в ящики других ролей (GW-05).
    let subject = parvane_protocol::schema::method("ephemeral.group_typing").map(|m| m.subject).unwrap_or_default();
    let mut gt = sh.nats.subscribe(subject.to_string()).await?;
    let shared = sh.clone();
    tokio::spawn(async move {
        while let Some(m) = gt.next().await {
            let shared = shared.clone();
            tokio::spawn(async move {
                let Ok(sr) = decode_checked::<ShardRequest>(&m.payload, Origin::Server) else { return };
                if sr.origin_domain.is_empty() {
                    return;
                }
                let Ok(r) = decode_checked::<EphemeralGroupTypingRequest>(&sr.body, Origin::Client) else { return };
                if let Err(c) = group_typing(&shared, r).await {
                    debug!("федерация: «печатает» группы от {} отвергнуто ({:?})", sr.origin_domain, c);
                }
            });
        }
    });
    Ok(())
}

/// S7-13: не больше стольких кусков одного потока в полёте (шард шлёт куски без обратной связи, поэтому
/// gateway делит запрос клиента на окна и просит следующее окно, когда предыдущее ушло в очередь клиента).
pub(crate) const STREAM_WINDOW: u32 = 16;
/// Кусков в полёте на сессию по всем её потокам (два потока полным окном).
pub(crate) const SESSION_STREAM_CREDITS: usize = 32;
/// Сколько кусков отдаёт шард облака на запрос по умолчанию (`chunk_count = 0`) и не больше.
const STREAM_MAX_CHUNKS: u32 = 256;

/// Окно `(first_chunk, chunk_count)` тела потокового метода; `None` — метод без окон.
pub(crate) fn stream_window(method: &str, body: &[u8]) -> Option<(u32, u32)> {
    use parvane_protocol::pb::parvane::cloud::v1 as cl;
    match method {
        "cloud.blob.download" => cl::DownloadRequest::decode(body).ok().map(|r| (r.first_chunk, r.chunk_count)),
        "cloud.blob.download_cap" => cl::DownloadCapRequest::decode(body).ok().map(|r| (r.first_chunk, r.chunk_count)),
        "cloud.link.download" => cl::LinkDownloadRequest::decode(body).ok().map(|r| (r.first_chunk, r.chunk_count)),
        _ => None,
    }
}

/// Тело того же запроса с другим окном.
pub(crate) fn with_stream_window(method: &str, body: &[u8], first: u32, count: u32) -> Option<Vec<u8>> {
    use parvane_protocol::pb::parvane::cloud::v1 as cl;
    match method {
        "cloud.blob.download" => cl::DownloadRequest::decode(body).ok().map(|r| cl::DownloadRequest { first_chunk: first, chunk_count: count, ..r }.encode_to_vec()),
        "cloud.blob.download_cap" => {
            cl::DownloadCapRequest::decode(body).ok().map(|r| cl::DownloadCapRequest { first_chunk: first, chunk_count: count, ..r }.encode_to_vec())
        }
        "cloud.link.download" => {
            cl::LinkDownloadRequest::decode(body).ok().map(|r| cl::LinkDownloadRequest { first_chunk: first, chunk_count: count, ..r }.encode_to_vec())
        }
        _ => None,
    }
}

/// Всего кусков блоба из метаданных потока (у всех потоковых методов — поле 2 `chunks`).
fn stream_total(meta: &[u8]) -> Option<u32> {
    parvane_protocol::pb::parvane::cloud::v1::DownloadResponse::decode(meta).ok().map(|r| r.chunks).filter(|c| *c > 0)
}

type StreamWrap = Box<dyn Fn(Vec<u8>) -> Vec<u8> + Send>;

fn chunk_error(id: u64, index: u32, e: Error) -> frame::Kind {
    frame::Kind::StreamChunk(StreamChunk { id, index, last: true, data: vec![], error: Some(e) })
}

/// Поток ответа шарда: ShardResponse (метаданные), затем ShardStreamChunk до `last`. Запрос клиента
/// делится на окна по `STREAM_WINDOW` кусков (S7-13): следующее окно запрашивается, когда куски предыдущего
/// ушли в исходящую очередь сессии, поэтому в ящике потока и в очереди лежит не больше окна и бюджета.
/// Метаданные клиент получает один раз (от первого окна), `last` — у последнего куска всего запроса.
#[allow(clippy::too_many_arguments)]
async fn stream(nats: &Client, tx: &OutQueue, id: u64, m: &MethodInfo, subject: &str, body: Vec<u8>, wrap: StreamWrap, timeout_ms: u64, credits: Arc<Semaphore>) {
    let per = Duration::from_millis(timeout_ms);
    let window = stream_window(m.name, &body);
    let (first, want) = match window {
        Some((first, count)) => (first, if count == 0 { STREAM_MAX_CHUNKS } else { count.min(STREAM_MAX_CHUNKS) }),
        // Метод без окон (новый в реестре) — одним запросом, как прежде
        None => (0, u32::MAX),
    };
    let mut end = first.saturating_add(want);
    let mut next = first;
    let mut meta_sent = false;
    loop {
        if tx.is_closed() {
            return;
        }
        let n = if window.is_some() { end.saturating_sub(next).min(STREAM_WINDOW) } else { STREAM_WINDOW };
        if n == 0 {
            // Окно клиента пусто (переполнение номера) — `chunk_count = 0` шард понял бы как «до предела»
            return respond(tx, id, Err(err(ErrorCode::Invalid, 0))).await;
        }
        let Ok(Ok(_permits)) = tokio::time::timeout(per, credits.clone().acquire_many_owned(n)).await else {
            if meta_sent {
                send(tx, chunk_error(id, next, err(ErrorCode::Unavailable, 0))).await;
            } else {
                respond(tx, id, Err(err(ErrorCode::RateLimited, 1000))).await;
            }
            return;
        };
        let part = match window {
            Some(_) => match with_stream_window(m.name, &body, next, n) {
                Some(b) => b,
                None => return respond(tx, id, Err(err(ErrorCode::Invalid, 0))).await,
            },
            None => body.clone(),
        };
        let inbox = nats.new_inbox();
        let Ok(mut sub) = nats.subscribe(inbox.clone()).await else {
            return respond(tx, id, Err(err(ErrorCode::Unavailable, 0))).await;
        };
        if nats.publish_with_reply(subject.to_string(), inbox, wrap(part).into()).await.is_err() {
            return respond(tx, id, Err(err(ErrorCode::Unavailable, 0))).await;
        }
        let head = match tokio::time::timeout(per, sub.next()).await {
            Ok(Some(m)) => m,
            _ => {
                if meta_sent {
                    send(tx, chunk_error(id, next, err(ErrorCode::Unavailable, 0))).await;
                } else {
                    respond(tx, id, Err(err(ErrorCode::Unavailable, 0))).await;
                }
                return;
            }
        };
        match decode_checked::<ShardResponse>(&head.payload, Origin::Server) {
            Ok(ShardResponse { result: Some(shard_response::Result::Ok(b)) }) => {
                if !meta_sent {
                    if window.is_some() {
                        if let Some(total) = stream_total(&b) {
                            end = end.min(total);
                        }
                    }
                    respond(tx, id, Ok(b)).await;
                    meta_sent = true;
                }
            }
            Ok(ShardResponse { result: Some(shard_response::Result::Error(e)) }) => {
                if meta_sent {
                    send(tx, chunk_error(id, next, e)).await;
                } else {
                    respond(tx, id, Err(e)).await;
                }
                return;
            }
            _ => {
                if meta_sent {
                    send(tx, chunk_error(id, next, err(ErrorCode::Unavailable, 0))).await;
                } else {
                    respond(tx, id, Err(err(ErrorCode::Unavailable, 0))).await;
                }
                return;
            }
        }
        let window_end = next.saturating_add(n);
        loop {
            let Ok(Some(msg)) = tokio::time::timeout(per, sub.next()).await else {
                send(tx, chunk_error(id, next, err(ErrorCode::Unavailable, 0))).await;
                return;
            };
            let Ok(c) = decode_checked::<ShardStreamChunk>(&msg.payload, Origin::Server) else {
                send(tx, chunk_error(id, next, err(ErrorCode::Unavailable, 0))).await;
                return;
            };
            if let Some(e) = c.error {
                send(tx, chunk_error(id, c.index, e)).await;
                return;
            }
            // Окно идёт подряд с `first_chunk` (PV-015: прежняя федерация нумеровала каждое окно с 0 и
            // второе окно молча кончалось на «последнем» 15-м куске) — иначе ошибка, а не чужие номера клиенту.
            if window.is_some() && c.index != next {
                warn!("v2 поток {}: кусок {} вместо {}", m.name, c.index, next);
                send(tx, chunk_error(id, next, err(ErrorCode::Unavailable, 0))).await;
                return;
            }
            // Конец всего запроса: последний кусок блоба или окна клиента; шард закончил окно раньше
            // запрошенного — тоже конец (у него свой предел кусков на запрос)
            let done = window.is_none() && c.last || c.index.saturating_add(1) >= end || (c.last && c.index.saturating_add(1) < window_end);
            let index = c.index;
            if !send(tx, frame::Kind::StreamChunk(StreamChunk { id, index, last: done, data: c.data, error: None })).await || done {
                return;
            }
            next = index.saturating_add(1);
            if c.last {
                break;
            }
        }
    }
}

/// Обслужить v2-сессию. `in_rx` — кадры (байты), `tx` — кадры наружу.
pub(crate) async fn serve(in_rx: mpsc::Receiver<inq::InFrame>, budget: inq::InBudget, tx: OutQueue, sh: Arc<Shared>, client_ip: String) {
    serve_session(in_rx, &budget, tx, sh, client_ip).await;
    // Ждущий места читатель просыпается и заканчивается
    budget.close();
}

async fn serve_session(mut in_rx: mpsc::Receiver<inq::InFrame>, budget: &inq::InBudget, tx: OutQueue, sh: Arc<Shared>, client_ip: String) {
    let deadline = Instant::now() + Duration::from_secs(crate::AUTH_TIMEOUT_SECS);
    // 1) Hello
    let first = match tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), in_rx.recv()).await {
        Ok(Some(b)) => b,
        _ => return,
    };
    let hello = match codec::decode_frame(&first.bytes, Origin::Client) {
        Ok(f) => match f.kind {
            Some(frame::Kind::Hello(h)) => h,
            _ => return respond(&tx, 0, Err(err(ErrorCode::Invalid, 0))).await,
        },
        Err(ProtoError::UnsupportedMajor(_)) => return respond(&tx, 0, Err(err(ErrorCode::UpgradeRequired, 0))).await,
        Err(e) => return respond(&tx, 0, Err(err(e.code(), 0))).await,
    };
    if hello.proto_minor < sh.min_minor {
        return respond(&tx, 0, Err(err(ErrorCode::UpgradeRequired, 0))).await;
    }
    let channel = match Channel::try_from(hello.channel) {
        Ok(Channel::AnonymousDelivery) => Channel::AnonymousDelivery,
        _ => Channel::Identified,
    };
    drop(first);
    // PV-010: у анонимного канала входа нет, а запросы крупные (запечатанная доставка) — полный бюджет сразу
    if channel == Channel::AnonymousDelivery {
        budget.open();
    }
    let welcome = Welcome {
        proto_minor: parvane_protocol::PROTO_MINOR,
        min_supported_major: parvane_protocol::PROTO_MAJOR,
        min_supported_minor: sh.min_minor,
        features: sh.features.clone(),
        server_descriptor: sh.descriptor().await,
    };
    if !send(&tx, frame::Kind::Welcome(welcome)).await {
        return;
    }
    let anon_source = (channel == Channel::AnonymousDelivery).then(|| sh.anon_ip.source_key(&client_ip));
    let mut s = Session {
        sh: sh.clone(),
        tx: tx.clone(),
        stream_credits: Arc::new(Semaphore::new(SESSION_STREAM_CREDITS)),
        channel,
        user: String::new(),
        device: String::new(),
        token: String::new(),
        // Анонимный канал не хранит IP (D-05).
        client_ip: if channel == Channel::Identified { client_ip } else { String::new() },
        anon_source,
        admitted: false,
        reauth_until_ms: 0,
        rate: V2Rate::from_env(),
        ring: RingCooldown::default(),
        subs: HashMap::new(),
        sub_count: 0,
        next_sub: 0,
        inbox_sub: None,
    };
    let mut revoked = sh.revoked.subscribe();
    let mut reverify = tokio::time::interval(Duration::from_secs(crate::reverify_secs()));
    reverify.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reverify.tick().await;
    // GW-01: простой анонимной сессии считается от последнего Request; Ping/Pong его не продлевают.
    let mut last_request = Instant::now();
    loop {
        let need_auth = channel == Channel::Identified && !s.authed();
        // GW-02: анонимный канал без входа не держит слот сутками — только
        // короткий простой между запросами.
        let wait = if need_auth {
            deadline.saturating_duration_since(Instant::now())
        } else if channel == Channel::AnonymousDelivery {
            Duration::from_secs(crate::limits::anon_idle_secs()).saturating_sub(last_request.elapsed())
        } else {
            Duration::from_secs(86_400)
        };
        tokio::select! {
            got = tokio::time::timeout(wait, in_rx.recv()) => {
                let inq::InFrame { bytes, permit } = match got {
                    Ok(Some(b)) => b,
                    Ok(None) => break,
                    Err(_) => {
                        respond(&tx, 0, Err(err(ErrorCode::Expired, 0))).await;
                        break;
                    }
                };
                let f = match codec::decode_frame(&bytes, Origin::Client) {
                    Ok(f) => f,
                    Err(e) => {
                        respond(&tx, 0, Err(err(e.code(), 0))).await;
                        continue;
                    }
                };
                match f.kind {
                    Some(frame::Kind::Auth(a)) if channel == Channel::Identified && !s.authed() => {
                        match verify(&sh.nats, &a.token).await {
                            Ok((u, d)) => {
                                s.user = u;
                                s.device = d;
                                s.token = a.token;
                                budget.open();
                                if !send(&tx, frame::Kind::AuthOk(AuthOk { user: s.user.clone(), device_id: s.device.clone() })).await {
                                    break;
                                }
                                info!("v2: клиент авторизован: {}", s.user);
                            }
                            Err(code) => {
                                respond(&tx, 0, Err(err(code, 0))).await;
                                break;
                            }
                        }
                    }
                    Some(frame::Kind::Request(r)) => {
                        s.admitted = false;
                        s.handle_request(r, permit).await;
                        if s.admitted {
                            last_request = Instant::now();
                        }
                        // Выходная очередь не освободилась за SEND_TIMEOUT — клиент не читает: закрываем.
                        if tx.is_closed() {
                            break;
                        }
                    }
                    Some(frame::Kind::Ping(p)) => {
                        if !send(&tx, frame::Kind::Pong(Pong { nonce: p.nonce })).await {
                            break;
                        }
                    }
                    Some(frame::Kind::Pong(_)) => {}
                    _ => respond(&tx, 0, Err(err(ErrorCode::Invalid, 0))).await,
                }
            }
            // S7-13: очередь закрыта (клиент не читает, бюджет байтов исчерпан дольше SEND_TIMEOUT, сокет закрыт)
            _ = tx.wait_closed() => break,
            _ = reverify.tick(), if s.authed() => {
                if verify(&sh.nats, &s.token).await.is_err() {
                    send(&tx, frame::Kind::Event(Event { kind: "session.revoked".into(), ..Default::default() })).await;
                    break;
                }
            }
            r = revoked.recv(), if s.authed() => {
                match r {
                    Ok((u, d)) => {
                        if u == s.user && d == s.device {
                            send(&tx, frame::Kind::Event(Event { kind: "session.revoked".into(), ..Default::default() })).await;
                            break;
                        }
                    }
                    // GW-04: уведомления пропущены (переполнение канала) — своё могло потеряться; сверяем токен сразу.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if verify(&sh.nats, &s.token).await.is_err() {
                            send(&tx, frame::Kind::Event(Event { kind: "session.revoked".into(), ..Default::default() })).await;
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {}
                }
            }
        }
    }
    s.close();
    if s.authed() {
        info!("v2: клиент отключился: {}", s.user);
    }
}

// ── транспорты ──────────────────────────────────────────────────────────────

/// Исходящая очередь сессии: до `CHANNEL_CAP` кадров и не больше бюджета в байтах (S7-13).
fn new_out_queue() -> (OutQueue, mpsc::Receiver<outq::OutFrame>) {
    outq::out_queue(crate::CHANNEL_CAP, outq::out_budget_bytes(), Duration::from_secs(SEND_TIMEOUT_SECS))
}

/// WebSocket: первый кадр уже прочитан (двоичный Hello).
pub(crate) async fn run_ws<S>(
    first: Vec<u8>,
    mut read: futures::stream::SplitStream<tokio_tungstenite::WebSocketStream<S>>,
    mut write: futures::stream::SplitSink<tokio_tungstenite::WebSocketStream<S>, crate::WsMessage>,
    sh: Arc<Shared>,
    client_ip: String,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (in_tx, in_rx) = mpsc::channel::<inq::InFrame>(inq::IN_FRAMES);
    let budget = new_in_budget(&sh);
    let Some(permit) = budget.admit(first.len()).await else { return };
    if in_tx.send(inq::InFrame { bytes: first, permit }).await.is_err() {
        return;
    }
    let reader_budget = budget.clone();
    tokio::spawn(async move {
        while let Some(m) = read.next().await {
            match m {
                Ok(crate::WsMessage::Binary(b)) => {
                    // PV-010: место в бюджете до постановки в очередь; пока его нет — сокет не читается
                    let Some(permit) = reader_budget.admit(b.len()).await else {
                        warn!("v2 ws: кадр до входа больше {} байт либо сессия закрыта", inq::PRE_AUTH_MAX_FRAME);
                        break;
                    };
                    if in_tx.send(inq::InFrame { bytes: b, permit }).await.is_err() {
                        break;
                    }
                }
                // Текст в v2-сессии — нарушение протокола.
                Ok(crate::WsMessage::Text(_)) | Ok(crate::WsMessage::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });
    let (out_tx, mut out_rx) = new_out_queue();
    let closer = out_tx.closer();
    let writer = tokio::spawn(async move {
        while let Some(f) = out_rx.recv().await {
            let outq::OutFrame { bytes, permit } = f;
            let wrote = tokio::time::timeout(Duration::from_secs(outq::WRITE_TIMEOUT_SECS), write.send(crate::WsMessage::Binary(bytes))).await;
            drop(permit);
            if !matches!(wrote, Ok(Ok(()))) {
                break;
            }
        }
        // Сокет не принимает (запись дольше тайм-аута, закрыт) — сессия заканчивается
        closer.close();
        let _ = tokio::time::timeout(Duration::from_secs(crate::WRITER_FLUSH_SECS), write.close()).await;
    });
    serve(in_rx, budget, out_tx, sh, client_ip).await;
    crate::session::finish_writer(writer).await;
}

/// Крупный кадр до входа ждёт `AuthOk` не дольше проверки токена (`verify` — 3 с): клиент мог прислать запрос
/// сразу за Auth; дольше — это не вход, а попытка занять память, соединение закрывается.
const PRE_AUTH_BIG_FRAME_WAIT: Duration = Duration::from_secs(4);

fn new_in_budget(sh: &Shared) -> inq::InBudget {
    inq::InBudget::new(inq::in_budget_bytes(), sh.in_global.clone(), sh.in_global_max, PRE_AUTH_BIG_FRAME_WAIT)
}

/// TCP: преамбула `PVN2` уже прочитана; `rest` — байты после неё.
pub(crate) async fn run_tcp(rest: Vec<u8>, mut rd: tokio::net::tcp::OwnedReadHalf, mut wr: tokio::net::tcp::OwnedWriteHalf, sh: Arc<Shared>, client_ip: String) {
    let (in_tx, in_rx) = mpsc::channel::<inq::InFrame>(inq::IN_FRAMES);
    let budget = new_in_budget(&sh);
    let reader_budget = budget.clone();
    tokio::spawn(async move {
        let mut dec = TcpDecoder::new();
        if dec.push(&rest).is_err() {
            return;
        }
        let mut buf = vec![0u8; 16384];
        loop {
            loop {
                match dec.next_frame() {
                    Ok(Some(f)) => {
                        // PV-010: место в бюджете до постановки в очередь; пока его нет — сокет не читается
                        let Some(permit) = reader_budget.admit(f.len()).await else {
                            warn!("v2 tcp: кадр до входа больше {} байт либо сессия закрыта", inq::PRE_AUTH_MAX_FRAME);
                            return;
                        };
                        if in_tx.send(inq::InFrame { bytes: f, permit }).await.is_err() {
                            return;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => return,
                }
            }
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if dec.push(&buf[..n]).is_err() {
                        warn!("v2 tcp: кадр больше лимита");
                        return;
                    }
                }
            }
        }
    });
    let (out_tx, mut out_rx) = new_out_queue();
    let closer = out_tx.closer();
    let writer = tokio::spawn(async move {
        while let Some(f) = out_rx.recv().await {
            let outq::OutFrame { bytes, permit } = f;
            let wrote = tokio::time::timeout(Duration::from_secs(outq::WRITE_TIMEOUT_SECS), wr.write_all(&codec::tcp_encode(&bytes))).await;
            drop(permit);
            if !matches!(wrote, Ok(Ok(()))) {
                break;
            }
        }
        closer.close();
    });
    serve(in_rx, budget, out_tx, sh, client_ip).await;
    crate::session::finish_writer(writer).await;
}
