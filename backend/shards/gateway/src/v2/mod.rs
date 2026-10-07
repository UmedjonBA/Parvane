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
use parvane_protocol::registry_gen::{eph_subject, inbox_subject, INTERNAL_GROUP_EPOCH, REVOKED_SUBJECT};
use parvane_protocol::schema::MethodInfo;
use parvane_protocol::ProtoError;
use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};

pub(crate) mod anon;
pub(crate) mod ephemeral;
pub(crate) mod limits;
#[cfg(test)]
mod tests;

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
    descriptor: RwLock<Option<(Instant, Vec<u8>)>>,
    revoked: broadcast::Sender<(String, String)>,
    pub min_minor: u32,
    pub features: Vec<String>,
    pub operators: Vec<String>,
    /// Связи каналов присутствия и повторы «печатает» группы (только память).
    pub eph: ephemeral::EphState,
    /// Лимит ANON-запросов на IP-источник (ключ — хэш, только память; D-08).
    pub anon_ip: AnonIpLimits,
}

fn env_list(name: &str) -> Vec<String> {
    std::env::var(name).unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

impl Shared {
    /// Создать и подписаться на события отзыва устройств (класс 5).
    pub(crate) async fn start(nats: Arc<Client>) -> anyhow::Result<Arc<Self>> {
        let (tx, _) = broadcast::channel(1024);
        let sh = Arc::new(Self {
            nats: nats.clone(),
            descriptor: RwLock::new(None),
            revoked: tx.clone(),
            min_minor: std::env::var("PARVANE_V2_MIN_MINOR").ok().and_then(|v| v.parse().ok()).unwrap_or(0),
            features: env_list("PARVANE_V2_FEATURES"),
            operators: env_list("PARVANE_OPERATORS"),
            eph: ephemeral::EphState::default(),
            anon_ip: AnonIpLimits::from_env(),
        });
        let mut sub = nats.subscribe(REVOKED_SUBJECT.to_string()).await?;
        tokio::spawn(async move {
            while let Some(m) = sub.next().await {
                if let Ok(n) = decode_checked::<RevokedNotice>(&m.payload, Origin::Server) {
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
        let req = ShardRequest { method: "server.describe".into(), ..Default::default() };
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

fn err(code: ErrorCode, retry_after_ms: u32) -> Error {
    Error { code: code as i32, retry_after_ms }
}

async fn send(tx: &mpsc::Sender<Vec<u8>>, kind: frame::Kind) -> bool {
    tx.send(codec::encode_frame(kind)).await.is_ok()
}

async fn respond(tx: &mpsc::Sender<Vec<u8>>, id: u64, r: Result<Vec<u8>, Error>) {
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
    tx: mpsc::Sender<Vec<u8>>,
    channel: Channel,
    user: String,
    device: String,
    token: String,
    client_ip: String,
    /// Анонимный канал: ключ IP-источника для `Shared::anon_ip` (сам IP не хранится).
    anon_source: Option<u64>,
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
        anon::shard_request(m, &who, body)
    }

    async fn handle_request(&mut self, req: Request) {
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
        if m.shard == "gateway" {
            let r = self.local(m, &req.body).await;
            return respond(&self.tx, id, r.map_err(|c| err(c, 0))).await;
        }
        let timeout = u64::from(if req.timeout_ms == 0 { 3000 } else { req.timeout_ms }).clamp(100, 30_000);
        let sreq = self.shard_request(m, req.body).encode_to_vec();
        if m.kind == 3 {
            let (nats, tx) = (self.sh.nats.clone(), self.tx.clone());
            tokio::spawn(async move { stream(&nats, &tx, id, m.subject, sreq, timeout).await });
            return;
        }
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
        let g = r.group.clone().ok_or(ErrorCode::Invalid)?;
        parvane_protocol::address::check_ref(&g).map_err(|_| ErrorCode::Invalid)?;
        if r.nonce.len() != 16 || r.channel_id.len() != 16 || r.epoch_signature.len() != 64 || r.payload.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let info = group_epoch(&self.sh.nats, &g).await?;
        if !info.found || info.deleted {
            return Err(ErrorCode::NotFound);
        }
        // После смены состава/прав до новой эпохи ключ мог остаться у исключённого.
        if r.epoch != info.epoch || info.stale {
            return Err(ErrorCode::Expired);
        }
        let pk: [u8; 32] = info.send_public_key.as_slice().try_into().map_err(|_| ErrorCode::Forbidden)?;
        parvane_protocol::group::verify_group_typing(&pk, &g, r.epoch, &r.nonce, &r.payload, &r.epoch_signature)
            .map_err(|_| ErrorCode::Forbidden)?;
        self.sh.eph.group_nonce_fresh(&g.id, &r.nonce, Instant::now())?;
        // Подписчики получают тот же вид, что и личный typing: (channel_id, payload).
        let out = EphemeralTypingRequest { channel_id: r.channel_id.clone(), payload: r.payload }.encode_to_vec();
        self.publish_eph(&r.channel_id, &out).await
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

/// Поток ответа шарда: ShardResponse (метаданные), затем ShardStreamChunk до `last`.
async fn stream(nats: &Client, tx: &mpsc::Sender<Vec<u8>>, id: u64, subject: &str, req: Vec<u8>, timeout_ms: u64) {
    let inbox = nats.new_inbox();
    let Ok(mut sub) = nats.subscribe(inbox.clone()).await else {
        return respond(tx, id, Err(err(ErrorCode::Unavailable, 0))).await;
    };
    if nats.publish_with_reply(subject.to_string(), inbox, req.into()).await.is_err() {
        return respond(tx, id, Err(err(ErrorCode::Unavailable, 0))).await;
    }
    let per = Duration::from_millis(timeout_ms);
    let first = match tokio::time::timeout(per, sub.next()).await {
        Ok(Some(m)) => m,
        _ => return respond(tx, id, Err(err(ErrorCode::Unavailable, 0))).await,
    };
    match decode_checked::<ShardResponse>(&first.payload, Origin::Server) {
        Ok(ShardResponse { result: Some(shard_response::Result::Ok(b)) }) => respond(tx, id, Ok(b)).await,
        Ok(ShardResponse { result: Some(shard_response::Result::Error(e)) }) => return respond(tx, id, Err(e)).await,
        _ => return respond(tx, id, Err(err(ErrorCode::Unavailable, 0))).await,
    }
    loop {
        let Ok(Some(m)) = tokio::time::timeout(per, sub.next()).await else {
            send(tx, frame::Kind::StreamChunk(StreamChunk { id, last: true, error: Some(err(ErrorCode::Unavailable, 0)), ..Default::default() })).await;
            return;
        };
        let Ok(c) = decode_checked::<ShardStreamChunk>(&m.payload, Origin::Server) else {
            send(tx, frame::Kind::StreamChunk(StreamChunk { id, last: true, error: Some(err(ErrorCode::Unavailable, 0)), ..Default::default() })).await;
            return;
        };
        if let Some(e) = c.error {
            send(tx, frame::Kind::StreamChunk(StreamChunk { id, index: c.index, last: true, data: vec![], error: Some(e) })).await;
            return;
        }
        let last = c.last;
        if !send(tx, frame::Kind::StreamChunk(StreamChunk { id, index: c.index, last, data: c.data, error: None })).await || last {
            return;
        }
    }
}

/// Обслужить v2-сессию. `in_rx` — кадры (байты), `tx` — кадры наружу.
pub(crate) async fn serve(mut in_rx: mpsc::Receiver<Vec<u8>>, tx: mpsc::Sender<Vec<u8>>, sh: Arc<Shared>, client_ip: String) {
    let deadline = Instant::now() + Duration::from_secs(crate::AUTH_TIMEOUT_SECS);
    // 1) Hello
    let first = match tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), in_rx.recv()).await {
        Ok(Some(b)) => b,
        _ => return,
    };
    let hello = match codec::decode_frame(&first, Origin::Client) {
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
        channel,
        user: String::new(),
        device: String::new(),
        token: String::new(),
        // Анонимный канал не хранит IP (D-05).
        client_ip: if channel == Channel::Identified { client_ip } else { String::new() },
        anon_source,
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
    loop {
        let need_auth = channel == Channel::Identified && !s.authed();
        // GW-02: анонимный канал без входа не держит слот сутками — только
        // короткий простой между запросами.
        let wait = if need_auth {
            deadline.saturating_duration_since(Instant::now())
        } else if channel == Channel::AnonymousDelivery {
            Duration::from_secs(crate::limits::anon_idle_secs())
        } else {
            Duration::from_secs(86_400)
        };
        tokio::select! {
            got = tokio::time::timeout(wait, in_rx.recv()) => {
                let bytes = match got {
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
                    Some(frame::Kind::Request(r)) => s.handle_request(r).await,
                    Some(frame::Kind::Ping(p)) => {
                        send(&tx, frame::Kind::Pong(Pong { nonce: p.nonce })).await;
                    }
                    Some(frame::Kind::Pong(_)) => {}
                    _ => respond(&tx, 0, Err(err(ErrorCode::Invalid, 0))).await,
                }
            }
            _ = reverify.tick(), if s.authed() => {
                if verify(&sh.nats, &s.token).await.is_err() {
                    send(&tx, frame::Kind::Event(Event { kind: "session.revoked".into(), ..Default::default() })).await;
                    break;
                }
            }
            r = revoked.recv(), if s.authed() => {
                if let Ok((u, d)) = r {
                    if u == s.user && d == s.device {
                        send(&tx, frame::Kind::Event(Event { kind: "session.revoked".into(), ..Default::default() })).await;
                        break;
                    }
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
    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>(crate::CHANNEL_CAP);
    if in_tx.send(first).await.is_err() {
        return;
    }
    tokio::spawn(async move {
        while let Some(m) = read.next().await {
            match m {
                Ok(crate::WsMessage::Binary(b)) => {
                    if in_tx.send(b).await.is_err() {
                        break;
                    }
                }
                // Текст в v2-сессии — нарушение протокола.
                Ok(crate::WsMessage::Text(_)) | Ok(crate::WsMessage::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(crate::CHANNEL_CAP);
    let writer = tokio::spawn(async move {
        while let Some(b) = out_rx.recv().await {
            if write.send(crate::WsMessage::Binary(b)).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });
    serve(in_rx, out_tx, sh, client_ip).await;
    crate::session::finish_writer(writer).await;
}

/// TCP: преамбула `PVN2` уже прочитана; `rest` — байты после неё.
pub(crate) async fn run_tcp(rest: Vec<u8>, mut rd: tokio::net::tcp::OwnedReadHalf, mut wr: tokio::net::tcp::OwnedWriteHalf, sh: Arc<Shared>, client_ip: String) {
    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>(crate::CHANNEL_CAP);
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
                        if in_tx.send(f).await.is_err() {
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
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(crate::CHANNEL_CAP);
    let writer = tokio::spawn(async move {
        while let Some(b) = out_rx.recv().await {
            if wr.write_all(&codec::tcp_encode(&b)).await.is_err() {
                break;
            }
        }
    });
    serve(in_rx, out_tx, sh, client_ip).await;
    crate::session::finish_writer(writer).await;
}
