//! Чужой сервер → свой (spec 028, R4, R7): `POST /_parvane/s2s` — проверка
//! кадра движком, лимит на домен, публикация в свою шину только методов с
//! `federated`; ответ — подписанные кадры `u32 BE длина ‖ S2SFrame`.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use parvane_protocol::codec::decode_checked;
use parvane_protocol::federation::{self, MAX_FRAME_BYTES};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    s2s_request, shard_response, Error as PbError, ErrorCode, S2sFrame, S2sRequest, S2sStreamChunk, ShardRequest, ShardResponse,
    ShardStreamChunk,
};
use parvane_protocol::registry_gen::{
    INTERNAL_ACCOUNT_GONE, INTERNAL_EPH_IN, INTERNAL_INBOX_PUSH, INTERNAL_KEY_OWNER, INTERNAL_PRIVACY_OF,
};
use prost::Message;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::peers::{err, now_ms, Fed};
use crate::store;

type Body = http_body_util::combinators::BoxBody<Bytes, Infallible>;

fn full(status: StatusCode, refusal: Option<&str>, retry_after: Option<u32>) -> Response<Body> {
    let mut b = Response::builder().status(status);
    if let Some(r) = refusal {
        b = b.header("Parvane-Refusal", r);
    }
    if let Some(s) = retry_after {
        b = b.header("Retry-After", s.to_string());
    }
    b.body(Full::new(Bytes::new()).boxed()).unwrap_or_else(|_| Response::new(Full::new(Bytes::new()).boxed()))
}

pub async fn run(fed: Arc<Fed>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(&fed.cfg.bind).await?;
    info!("федерация: входящие запросы на {}", fed.cfg.bind);
    tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    error!("федерация: accept: {}", e);
                    continue;
                }
            };
            let fed = fed.clone();
            tokio::spawn(async move {
                let io = hyper_util::rt::TokioIo::new(stream);
                let svc = hyper::service::service_fn(move |req| {
                    let fed = fed.clone();
                    async move { Ok::<_, Infallible>(serve(&fed, req).await) }
                });
                if let Err(e) = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await {
                    tracing::debug!("федерация: соединение: {}", e);
                }
            });
        }
    });
    Ok(())
}

async fn serve(fed: &Arc<Fed>, req: Request<Incoming>) -> Response<Body> {
    match (req.method().as_str(), req.uri().path()) {
        ("GET", "/.well-known/parvane") => well_known(fed).await,
        ("POST", "/_parvane/s2s") => s2s(fed, req).await,
        _ => full(StatusCode::NOT_FOUND, None, None),
    }
}

/// Описатель сервера (на проде его отдаёт Caddy статикой, здесь — для тестового режима).
async fn well_known(fed: &Fed) -> Response<Body> {
    let Some(path) = fed.cfg.well_known_file.as_ref() else { return full(StatusCode::NOT_FOUND, None, None) };
    match tokio::fs::read(path).await {
        Ok(b) => Response::builder()
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(b)).boxed())
            .unwrap_or_else(|_| full(StatusCode::INTERNAL_SERVER_ERROR, None, None)),
        Err(_) => full(StatusCode::NOT_FOUND, None, None),
    }
}

async fn s2s(fed: &Arc<Fed>, req: Request<Incoming>) -> Response<Body> {
    if !fed.cfg.enabled {
        return full(StatusCode::FORBIDDEN, Some("disabled"), None);
    }
    let Ok(collected) = Limited::new(req.into_body(), MAX_FRAME_BYTES).collect().await else {
        return full(StatusCode::BAD_REQUEST, None, None);
    };
    let bytes = collected.to_bytes();
    let Ok(frame) = decode_checked::<S2sFrame>(&bytes, Origin::Server) else { return full(StatusCode::BAD_REQUEST, None, None) };
    let origin = frame.origin_domain.to_ascii_lowercase();
    if fed.cfg.blocked.contains(&origin) || store::is_blocked(&fed.pool, &origin).await.unwrap_or(true) {
        return full(StatusCode::FORBIDDEN, Some("blocked"), None);
    }
    // Описатель отправителя — его ключ проверяет подпись кадра (закрепление при первом контакте).
    let peer = match fed.trust(&origin).await {
        Ok(p) => p,
        Err(e) => {
            warn!("федерация: входящий от {}: сервер не проверен (код {})", origin, e.code);
            return full(StatusCode::UNAUTHORIZED, None, None);
        }
    };
    let now = now_ms();
    let (v, s2s_req) = match federation::verify_request(&bytes, &peer.trusted, &fed.cfg.domain, now, None) {
        Ok(r) => r,
        Err(e) => {
            warn!("федерация: кадр от {} отвергнут: {:?}", origin, e);
            fed.forget(&origin).await;
            return full(StatusCode::BAD_REQUEST, None, None);
        }
    };
    // Повтор — по базе (переживает перезапуск в окне свежести).
    if !store::nonce_fresh(&fed.pool, &origin, &v.nonce, now).await.unwrap_or(false) {
        return full(StatusCode::BAD_REQUEST, None, None);
    }
    let (tx, rx) = mpsc::channel::<Bytes>(8);
    let fed2 = fed.clone();
    let nonce = v.nonce.clone();
    tokio::spawn(async move {
        let sink = Responder { fed: fed2.clone(), dest: origin.clone(), nonce, tx };
        if !fed2.admit(&origin) {
            sink.head(Err(err(ErrorCode::RateLimited, 1000))).await;
            return;
        }
        dispatch(&fed2, &origin, s2s_req, sink).await;
    });
    let stream = futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|b| (Ok::<_, Infallible>(Frame::data(b)), rx)) });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/vnd.parvane.s2s")
        .body(BodyExt::boxed(StreamBody::new(stream)))
        .unwrap_or_else(|_| full(StatusCode::INTERNAL_SERVER_ERROR, None, None))
}

/// Подписанные кадры ответа в тело HTTP.
struct Responder {
    fed: Arc<Fed>,
    dest: String,
    nonce: Vec<u8>,
    tx: mpsc::Sender<Bytes>,
}

impl Responder {
    async fn frame(&self, payload_type: &str, payload: Vec<u8>) -> bool {
        let Ok(f) = self.fed.sign(&self.dest, federation::new_nonce(), payload_type, payload).await else { return false };
        let mut out = vec![];
        if federation::frame_push(&mut out, &f.encode_to_vec()).is_err() {
            return false;
        }
        self.tx.send(Bytes::from(out)).await.is_ok()
    }

    async fn head(&self, r: Result<Vec<u8>, PbError>) -> bool {
        self.frame(federation::RESPONSE_TYPE, federation::response_payload(&self.nonce, r)).await
    }

    async fn chunk(&self, c: ShardStreamChunk) -> bool {
        let c = S2sStreamChunk { request_nonce: self.nonce.clone(), index: c.index, last: c.last, data: c.data, error: c.error };
        self.frame(federation::STREAM_CHUNK_TYPE, c.encode_to_vec()).await
    }
}

fn shard_result(payload: &[u8]) -> Result<Vec<u8>, PbError> {
    match decode_checked::<ShardResponse>(payload, Origin::Server) {
        Ok(ShardResponse { result: Some(shard_response::Result::Ok(b)) }) => Ok(b),
        Ok(ShardResponse { result: Some(shard_response::Result::Error(e)) }) => Err(e),
        _ => Err(err(ErrorCode::Unavailable, 1000)),
    }
}

async fn request(fed: &Fed, subject: &str, body: Vec<u8>, timeout: Duration) -> Result<Vec<u8>, PbError> {
    let fut = fed.nc.request(subject.to_string(), body.into());
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(m)) => Ok(m.payload.to_vec()),
        _ => Err(err(ErrorCode::Unavailable, 1000)),
    }
}

async fn dispatch(fed: &Fed, origin: &str, req: S2sRequest, out: Responder) {
    let t = Duration::from_secs(10);
    let Some(kind) = req.kind else {
        out.head(Err(err(ErrorCode::Invalid, 0))).await;
        return;
    };
    let r = match kind {
        s2s_request::Kind::Forward(f) => {
            let Some(m) = parvane_protocol::schema::method(&f.method).filter(|m| m.federated) else {
                out.head(Err(err(ErrorCode::Forbidden, 0))).await;
                return;
            };
            let sr = ShardRequest {
                method: f.method.clone(),
                user: f.user,
                device_id: f.device_id,
                body: f.body,
                origin_domain: origin.to_string(),
                ..Default::default()
            };
            let timeout = Duration::from_millis(u64::from(if f.timeout_ms == 0 { 10_000 } else { f.timeout_ms.min(30_000) }));
            if m.kind == 3 {
                return stream(fed, m.subject, sr, timeout, out).await;
            }
            request(fed, m.subject, sr.encode_to_vec(), timeout).await.and_then(|p| shard_result(&p))
        }
        s2s_request::Kind::InboxPush(p) => {
            let sr = ShardRequest { method: "inbox_push".into(), body: p.encode_to_vec(), origin_domain: origin.to_string(), ..Default::default() };
            request(fed, INTERNAL_INBOX_PUSH, sr.encode_to_vec(), t).await.and_then(|p| shard_result(&p))
        }
        s2s_request::Kind::AccountGone(g) => {
            let sr = ShardRequest { method: "account_gone".into(), body: g.encode_to_vec(), origin_domain: origin.to_string(), ..Default::default() };
            request(fed, INTERNAL_ACCOUNT_GONE, sr.encode_to_vec(), t).await.and_then(|p| shard_result(&p))
        }
        // Внутренние ответы identity — тела без обёртки ShardResponse.
        s2s_request::Kind::KeyOwner(k) => request(fed, INTERNAL_KEY_OWNER, k.encode_to_vec(), t).await,
        s2s_request::Kind::PrivacyOf(q) => request(fed, INTERNAL_PRIVACY_OF, q.encode_to_vec(), t).await,
        s2s_request::Kind::Ephemeral(e) => match fed.nc.publish(INTERNAL_EPH_IN.to_string(), e.encode_to_vec().into()).await {
            Ok(()) => Ok(vec![]),
            Err(_) => Err(err(ErrorCode::Unavailable, 1000)),
        },
    };
    out.head(r).await;
}

/// STREAM-метод (скачивание блоба): ответ шарда и чанки → кадры ответа.
async fn stream(fed: &Fed, subject: &str, sr: ShardRequest, per: Duration, out: Responder) {
    let inbox = fed.nc.new_inbox();
    let Ok(mut sub) = fed.nc.subscribe(inbox.clone()).await else {
        out.head(Err(err(ErrorCode::Unavailable, 1000))).await;
        return;
    };
    if fed.nc.publish_with_reply(subject.to_string(), inbox, sr.encode_to_vec().into()).await.is_err() {
        out.head(Err(err(ErrorCode::Unavailable, 1000))).await;
        return;
    }
    let Ok(Some(first)) = tokio::time::timeout(per, sub.next()).await else {
        out.head(Err(err(ErrorCode::Unavailable, 1000))).await;
        return;
    };
    match shard_result(&first.payload) {
        Ok(b) => {
            if !out.head(Ok(b)).await {
                return;
            }
        }
        Err(e) => {
            out.head(Err(e)).await;
            return;
        }
    }
    let mut index = 0u32;
    loop {
        let c = match tokio::time::timeout(per, sub.next()).await {
            Ok(Some(m)) => decode_checked::<ShardStreamChunk>(&m.payload, Origin::Server)
                .unwrap_or(ShardStreamChunk { index, last: true, data: vec![], error: Some(err(ErrorCode::Unavailable, 1000)) }),
            _ => ShardStreamChunk { index, last: true, data: vec![], error: Some(err(ErrorCode::Unavailable, 1000)) },
        };
        // Номера — по порядку отправки (так их сверяет получатель).
        let c = ShardStreamChunk { index, ..c };
        let last = c.last || c.error.is_some();
        if !out.chunk(c).await || last {
            return;
        }
        index += 1;
    }
}
