//! Чужие серверы (spec 028): обнаружение и закрепление ключа (R5, R6), подпись
//! кадров у identity (R9) и исходящий вызов с проверкой ответа (R4).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_nats::Client;
use futures::StreamExt;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::error::ProtoError;
use parvane_protocol::federation::{self, FrameReader, TrustedServer};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    s2s_response, Error as PbError, ErrorCode, S2sFrame, S2sRequest, S2sSignRequest, S2sSignResponse, ShardStreamChunk,
    SignedServerDescriptor,
};
use parvane_protocol::registry_gen::INTERNAL_S2S_SIGN;
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::config::Config;
use crate::store;

/// Описатель перечитывается раз в час.
const DESCRIPTOR_TTL: Duration = Duration::from_secs(3600);
/// Предел тела описателя.
const DESCRIPTOR_MAX_BYTES: usize = 64 * 1024;
/// Неудачное обнаружение домена не повторяется столько (поток кадров с произвольным origin_domain
/// иначе превращал бы шард в усилитель исходящих HTTPS-запросов).
const DISCOVERY_FAIL_TTL: Duration = Duration::from_secs(300);
/// Новых обращений за описателем в минуту на весь шард.
const DISCOVERY_PER_MINUTE: u32 = 60;
/// Предел таблиц отрицательного кэша и проверенных соседей.
const PEERS_MAX: usize = 5_000;
/// Кэш соседа сбрасывается неверной подписью не чаще, чем раз в столько (ключ сменился — перечитаем).
const FORGET_MIN_AGE: Duration = Duration::from_secs(60);
/// Таймаут исходящего вызова по умолчанию.
pub const DEFAULT_TIMEOUT_MS: u32 = 10_000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn err(code: ErrorCode, retry_after_ms: u32) -> PbError {
    PbError { code: code as i32, retry_after_ms }
}

/// Элемент потока ответа STREAM-метода: сначала заголовок (первый ответ), затем чанки.
pub enum StreamItem {
    Head(Result<Vec<u8>, PbError>),
    Chunk(ShardStreamChunk),
}

/// Проверенный чужой сервер и его точка входа.
#[derive(Clone)]
pub struct Peer {
    pub trusted: TrustedServer,
    /// База межсерверной точки входа: `https://host[:port]` (без пути).
    pub endpoint: String,
    fetched: Instant,
}

/// Общее состояние шарда.
pub struct Fed {
    pub cfg: Config,
    pub pool: SqlitePool,
    pub nc: Client,
    peers: Mutex<HashMap<String, Peer>>,
    buckets: std::sync::Mutex<HashMap<String, (f64, Instant)>>,
    /// Домены, обнаружение которых не удалось, и общий счётчик обращений за описателем.
    failed: std::sync::Mutex<HashMap<String, Instant>>,
    discovery: std::sync::Mutex<(Instant, u32)>,
}

impl Fed {
    pub fn new(cfg: Config, pool: SqlitePool, nc: Client) -> Arc<Self> {
        Arc::new(Fed {
            cfg,
            pool,
            nc,
            peers: Mutex::new(HashMap::new()),
            buckets: std::sync::Mutex::new(HashMap::new()),
            failed: std::sync::Mutex::new(HashMap::new()),
            discovery: std::sync::Mutex::new((Instant::now(), 0)),
        })
    }

    /// Домен закрыт: выключенная федерация, чёрный список окружения или администратора.
    pub async fn refusal(&self, domain: &str) -> Option<ErrorCode> {
        if !self.cfg.enabled {
            return Some(ErrorCode::FederationUnavailable);
        }
        if self.cfg.blocked.contains(domain) || store::is_blocked(&self.pool, domain).await.unwrap_or(true) {
            return Some(ErrorCode::DomainBlocked);
        }
        None
    }

    /// Корзина запросов домена (FR-012): false — сверх лимита.
    pub fn admit(&self, domain: &str) -> bool {
        let Ok(mut b) = self.buckets.lock() else { return false };
        let now = Instant::now();
        let (burst, rate) = (self.cfg.rate_burst, self.cfg.rate_per_sec);
        let e = b.entry(domain.to_string()).or_insert((burst, now));
        e.0 = (e.0 + now.duration_since(e.1).as_secs_f64() * rate).min(burst);
        e.1 = now;
        if e.0 >= 1.0 {
            e.0 -= 1.0;
            true
        } else {
            false
        }
    }

    // ── обнаружение и закрепление ───────────────────────────────────────────

    fn base_of(&self, domain: &str) -> String {
        self.cfg.endpoints.get(domain).cloned().unwrap_or_else(|| format!("https://{domain}"))
    }

    /// Можно ли сейчас обратиться за описателем: не в отрицательном кэше и не сверх общего счётчика.
    pub(crate) fn discovery_allowed(&self, domain: &str) -> Result<(), PbError> {
        if let Ok(f) = self.failed.lock() {
            if f.get(domain).is_some_and(|at| at.elapsed() < DISCOVERY_FAIL_TTL) {
                return Err(err(ErrorCode::DomainUnreachable, 30_000));
            }
        }
        let Ok(mut d) = self.discovery.lock() else { return Err(err(ErrorCode::Unavailable, 1000)) };
        if d.0.elapsed() >= Duration::from_secs(60) {
            *d = (Instant::now(), 0);
        }
        if d.1 >= DISCOVERY_PER_MINUTE {
            return Err(err(ErrorCode::RateLimited, 10_000));
        }
        d.1 += 1;
        Ok(())
    }

    pub(crate) fn discovery_failed(&self, domain: &str) {
        if let Ok(mut f) = self.failed.lock() {
            if f.len() >= PEERS_MAX {
                f.retain(|_, at| at.elapsed() < DISCOVERY_FAIL_TTL);
                if f.len() >= PEERS_MAX {
                    f.clear();
                }
            }
            f.insert(domain.to_string(), Instant::now());
        }
    }

    /// Проверенный сервер домена: из кэша либо по описателю с закреплением ключа.
    pub async fn trust(&self, domain: &str) -> Result<Peer, PbError> {
        self.trust_with(domain, true).await
    }

    /// То же, но `persist = false` ключ не закрепляет: входящий кадр закрепляет сервер только после
    /// проверки подписи (`confirm_pin`), иначе любой домен с описателем попадал бы в `servers` и рассылки.
    pub async fn trust_with(&self, domain: &str, persist: bool) -> Result<Peer, PbError> {
        if !parvane_protocol::address::is_valid_domain(domain) || self.cfg.is_own(domain) {
            return Err(err(ErrorCode::Invalid, 0));
        }
        if let Some(p) = self.peers.lock().await.get(domain).filter(|p| p.fetched.elapsed() < DESCRIPTOR_TTL).cloned() {
            return Ok(p);
        }
        let pinned = store::pinned(&self.pool, domain).await.map_err(|_| err(ErrorCode::Unavailable, 1000))?;
        if pinned.as_ref().is_some_and(|p| p.state == "key_changed") {
            return Err(err(ErrorCode::ServerKeyChanged, 0));
        }
        self.discovery_allowed(domain)?;
        let base = self.base_of(domain);
        let body = match self.http_get(&format!("{base}/.well-known/parvane")).await {
            Ok(b) => b,
            Err(()) => {
                self.discovery_failed(domain);
                return Err(err(ErrorCode::DomainUnreachable, 30_000));
            }
        };
        let Ok(signed) = serde_json::from_slice::<SignedServerDescriptor>(&body) else {
            self.discovery_failed(domain);
            return Err(err(ErrorCode::DomainUnreachable, 30_000));
        };
        let pin = pinned.as_ref().map(|p| p.key);
        let trusted = match federation::verify_descriptor(&signed, domain, pin.as_ref()) {
            Ok(t) => t,
            Err(ProtoError::RootMismatch) => {
                warn!("федерация: {} сменил ключ сервера — запросы закрыты до сброса администратором", domain);
                let _ = store::set_state(&self.pool, domain, "key_changed").await;
                return Err(err(ErrorCode::ServerKeyChanged, 0));
            }
            Err(_) => {
                self.discovery_failed(domain);
                return Err(err(ErrorCode::DomainUnreachable, 30_000));
            }
        };
        if pin.is_none() && persist {
            info!("федерация: закреплён ключ сервера {}", domain);
            store::pin(&self.pool, domain, &trusted.server_key, now_ms()).await.map_err(|_| err(ErrorCode::Unavailable, 1000))?;
        }
        let endpoint = endpoint_of(&trusted, &base);
        let peer = Peer { trusted, endpoint, fetched: Instant::now() };
        let mut peers = self.peers.lock().await;
        if peers.len() >= PEERS_MAX {
            peers.retain(|_, p| p.fetched.elapsed() < DESCRIPTOR_TTL);
        }
        if peers.len() < PEERS_MAX {
            peers.insert(domain.to_string(), peer.clone());
        }
        Ok(peer)
    }

    /// Закрепить ключ сервера, чей кадр прошёл проверку подписи (первый контакт по входящему).
    pub async fn confirm_pin(&self, domain: &str, peer: &Peer) {
        if matches!(store::pinned(&self.pool, domain).await, Ok(None)) {
            info!("федерация: закреплён ключ сервера {}", domain);
            let _ = store::pin(&self.pool, domain, &peer.trusted.server_key, now_ms()).await;
        }
    }

    /// Забыть кэш (подпись ответа не сошлась — перечитать описатель). Не чаще раза в минуту на домен:
    /// иначе поддельные кадры от имени соседа заставляли бы перечитывать его описатель каждый раз.
    pub async fn forget(&self, domain: &str) {
        let mut peers = self.peers.lock().await;
        if peers.get(domain).is_some_and(|p| p.fetched.elapsed() >= FORGET_MIN_AGE) {
            peers.remove(domain);
        }
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    /// HTTP-клиент к адресу: прод — https с SSRF-фильтром и фиксацией IP; тестовый
    /// режим — http только к loopback из настроек администратора.
    async fn client_for(&self, url: &str) -> Result<(reqwest::Client, String), ()> {
        if self.cfg.insecure_http && url.starts_with("http://") {
            let u = parvane_netguard::Url::parse(url).map_err(|_| ())?;
            let loopback = matches!(u.host_str(), Some("127.0.0.1") | Some("[::1]") | Some("::1"));
            let listed = self.cfg.endpoints.values().any(|b| url.starts_with(b.as_str()));
            if !loopback || !listed {
                return Err(());
            }
            let c = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().map_err(|_| ())?;
            return Ok((c, url.to_string()));
        }
        let u = parvane_netguard::check_url(url, &parvane_netguard::UrlPolicy::HTTPS).map_err(|_| ())?;
        let (host, addrs) = parvane_netguard::resolve_url(&u).await.map_err(|_| ())?;
        let c = parvane_netguard::pinned_client_builder(&host, &addrs).build().map_err(|_| ())?;
        Ok((c, u.to_string()))
    }

    async fn http_get(&self, url: &str) -> Result<Vec<u8>, ()> {
        let (c, url) = self.client_for(url).await?;
        let r = c.get(url).timeout(Duration::from_secs(10)).send().await.map_err(|_| ())?;
        if !r.status().is_success() {
            return Err(());
        }
        let mut out = vec![];
        let mut s = r.bytes_stream();
        while let Some(chunk) = s.next().await {
            out.extend_from_slice(&chunk.map_err(|_| ())?);
            if out.len() > DESCRIPTOR_MAX_BYTES {
                return Err(());
            }
        }
        Ok(out)
    }

    // ── подпись ─────────────────────────────────────────────────────────────

    /// Кадр от своего сервера к `dest`, подписанный identity.
    pub async fn sign(&self, dest: &str, nonce: Vec<u8>, payload_type: &str, payload: Vec<u8>) -> Result<S2sFrame, PbError> {
        let issued_ms = now_ms();
        let req = S2sSignRequest {
            origin_domain: self.cfg.domain.clone(),
            dest_domain: dest.to_string(),
            issued_ms,
            nonce: nonce.clone(),
            payload_type: payload_type.to_string(),
            payload_sha256: Sha256::digest(&payload).to_vec(),
        };
        let fut = self.nc.request(INTERNAL_S2S_SIGN.to_string(), req.encode_to_vec().into());
        let reply = tokio::time::timeout(Duration::from_secs(3), fut).await.map_err(|_| err(ErrorCode::Unavailable, 1000))?.map_err(|_| err(ErrorCode::Unavailable, 1000))?;
        let r: S2sSignResponse = decode_checked(&reply.payload, Origin::Server).map_err(|_| err(ErrorCode::Unavailable, 1000))?;
        if r.signature.len() != 64 {
            return Err(err(ErrorCode::Unavailable, 1000));
        }
        Ok(S2sFrame {
            origin_domain: self.cfg.domain.clone(),
            dest_domain: dest.to_string(),
            issued_ms,
            nonce,
            payload_type: payload_type.to_string(),
            payload,
            signature: r.signature,
        })
    }

    // ── исходящий вызов ─────────────────────────────────────────────────────

    /// Запрос чужому серверу. Ответ — тело (`ok`) либо ошибка с кодом; для
    /// потоков кадры чанков уходят в `chunks` по мере прихода (уже проверенные).
    pub async fn call(
        &self,
        dest: &str,
        req: &S2sRequest,
        timeout_ms: u32,
        chunks: Option<mpsc::Sender<StreamItem>>,
    ) -> Result<Vec<u8>, PbError> {
        let dest = dest.to_ascii_lowercase();
        if let Some(code) = self.refusal(&dest).await {
            return Err(err(code, 0));
        }
        let peer = self.trust(&dest).await?;
        let nonce = federation::new_nonce();
        let frame = self.sign(&dest, nonce.clone(), federation::REQUEST_TYPE, req.encode_to_vec()).await.inspect_err(|_| {
            warn!("федерация: identity не подписал кадр для {}", dest);
        })?;
        let url = format!("{}/_parvane/s2s", peer.endpoint);
        let (client, url) = self.client_for(&url).await.map_err(|_| {
            warn!("федерация: точка входа {} не прошла фильтр адресов", dest);
            err(ErrorCode::DomainUnreachable, 30_000)
        })?;
        let timeout = Duration::from_millis(u64::from(if timeout_ms == 0 { DEFAULT_TIMEOUT_MS } else { timeout_ms.min(30_000) }));
        let resp = client
            .post(url)
            .header("content-type", "application/vnd.parvane.s2s")
            .timeout(if chunks.is_some() { timeout * 20 } else { timeout + Duration::from_secs(2) })
            .body(frame.encode_to_vec())
            .send()
            .await
            .map_err(|e| {
                warn!("федерация: {} не ответил: {}", dest, e);
                err(ErrorCode::DomainUnreachable, 10_000)
            })?;
        let status = resp.status().as_u16();
        if status == 403 {
            return Err(err(ErrorCode::DomainRefused, 0));
        }
        if status == 429 {
            let after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u32>().ok()).unwrap_or(1);
            return Err(err(ErrorCode::RateLimited, after.saturating_mul(1000)));
        }
        if status != 200 {
            return Err(err(ErrorCode::DomainUnreachable, 10_000));
        }
        let mut reader = FrameReader::default();
        let mut stream = resp.bytes_stream();
        let mut first: Option<Vec<u8>> = None;
        let mut index = 0u32;
        loop {
            // Целые кадры из уже пришедшего.
            loop {
                let next = reader.next_frame().map_err(|_| err(ErrorCode::DomainUnreachable, 10_000))?;
                let Some(bytes) = next else { break };
                let now = now_ms();
                if first.is_none() {
                    let r = match federation::verify_response(&bytes, &peer.trusted, &self.cfg.domain, now, &nonce) {
                        Ok(r) => r,
                        Err(_) => {
                            self.forget(&dest).await;
                            return Err(err(ErrorCode::DomainUnreachable, 10_000));
                        }
                    };
                    match r.result {
                        Some(s2s_response::Result::Ok(b)) => first = Some(b),
                        Some(s2s_response::Result::Error(e)) => return Err(e),
                        None => return Err(err(ErrorCode::DomainUnreachable, 10_000)),
                    }
                    match chunks.as_ref() {
                        None => return Ok(first.unwrap_or_default()),
                        Some(tx) => {
                            let _ = tx.send(StreamItem::Head(Ok(first.clone().unwrap_or_default()))).await;
                        }
                    }
                    continue;
                }
                let Some(tx) = chunks.as_ref() else { break };
                let c = federation::verify_stream_chunk(&bytes, &peer.trusted, &self.cfg.domain, now, &nonce, index)
                    .map_err(|_| err(ErrorCode::DomainUnreachable, 10_000))?;
                index += 1;
                let last = c.last || c.error.is_some();
                let _ = tx.send(StreamItem::Chunk(ShardStreamChunk { index: c.index, last: c.last, data: c.data, error: c.error })).await;
                if last {
                    return Ok(first.unwrap_or_default());
                }
            }
            match stream.next().await {
                Some(Ok(b)) => reader.push(&b).map_err(|_| err(ErrorCode::DomainUnreachable, 10_000))?,
                Some(Err(_)) | None => {
                    // Поток оборвался до последнего кадра.
                    if let (Some(tx), Some(_)) = (chunks.as_ref(), first.as_ref()) {
                        let chunk = ShardStreamChunk { index, last: true, data: vec![], error: Some(err(ErrorCode::DomainUnreachable, 10_000)) };
                        let _ = tx.send(StreamItem::Chunk(chunk)).await;
                    }
                    return match first {
                        Some(b) if chunks.is_some() => Ok(b),
                        _ => Err(err(ErrorCode::DomainUnreachable, 10_000)),
                    };
                }
            }
        }
    }
}

/// Точка входа из описателя — только если её хост равен домену и схема https (R5);
/// иначе база обнаружения.
pub(crate) fn endpoint_of(t: &TrustedServer, base: &str) -> String {
    let e = t.descriptor.s2s_endpoint.trim().trim_end_matches('/');
    if let Ok(u) = parvane_netguard::Url::parse(e) {
        let host_ok = u.host_str().is_some_and(|h| h.eq_ignore_ascii_case(&t.domain));
        if u.scheme() == "https" && host_ok && u.path() == "/" && u.query().is_none() {
            return e.to_string();
        }
    }
    base.to_string()
}
