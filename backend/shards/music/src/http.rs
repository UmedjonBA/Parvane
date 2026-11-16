//! HTTP-ссылки «Музыки» (spec 039) за Caddy: `GET /_parvane/music/s/<жетон>` — поток трека (Range),
//! `GET /_parvane/music/c/<жетон>/<id обложки>[?size=N]` — обложка. Право — подписанный жетон в адресе; тело
//! музыкального сервера пересылается потоком, без буферизации. Жетон в журнал не пишется.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::TryStreamExt as _;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use tracing::{debug, error};

use crate::subsonic::valid_id;
use crate::token::{self, Grant};
use crate::{now_ms, Ctx};

type Body = http_body_util::combinators::BoxBody<Bytes, std::io::Error>;

const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
/// Одновременных потоков и обложек на шард: сверх — 503 (плеер повторит).
const STREAMS_MAX: usize = 128;
const COVER_SIZE_DEFAULT: u32 = 300;
const COVER_SIZE_MAX: u32 = 1200;

static STREAMS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(STREAMS_MAX);

fn plain(status: StatusCode) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r
}

pub(crate) async fn serve_listener(ctx: Arc<Ctx>, listener: tokio::net::TcpListener) {
    loop {
        let stream = match listener.accept().await {
            Ok((s, _)) => s,
            Err(e) => {
                error!("музыка: accept: {e}");
                continue;
            }
        };
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let io = hyper_util::rt::TokioIo::new(stream);
            let svc = hyper::service::service_fn(move |req| {
                let ctx = ctx.clone();
                async move { Ok::<_, Infallible>(serve(&ctx, req).await) }
            });
            let conn = hyper::server::conn::http1::Builder::new().timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(HEADER_TIMEOUT).serve_connection(io, svc);
            if let Err(e) = conn.await {
                debug!("музыка: соединение: {e}");
            }
        });
    }
}

async fn serve(ctx: &Ctx, req: Request<Incoming>) -> Response<Body> {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return plain(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(sub) = ctx.sub.as_ref() else { return plain(StatusCode::SERVICE_UNAVAILABLE) };
    let path = req.uri().path();
    let range = req.headers().get(hyper::header::RANGE).and_then(|v| v.to_str().ok()).filter(|r| r.len() <= 128);
    let (endpoint, user, params, cache): (&str, String, Vec<(&str, String)>, &str) = if let Some(tok) = path.strip_prefix("/_parvane/music/s/") {
        match token::verify(&ctx.key, tok, now_ms()) {
            Some(token::Claims { user, grant: Grant::Stream { track, opus }, .. }) => {
                let mut p = vec![("id", track)];
                if opus {
                    p.push(("format", "opus".into()));
                    p.push(("maxBitRate", "128".into()));
                } else {
                    p.push(("format", "raw".into()));
                }
                ("stream", user, p, "private, max-age=3600")
            }
            _ => return plain(StatusCode::FORBIDDEN),
        }
    } else if let Some(rest) = path.strip_prefix("/_parvane/music/c/") {
        let Some((tok, cover)) = rest.split_once('/') else { return plain(StatusCode::NOT_FOUND) };
        match token::verify(&ctx.key, tok, now_ms()) {
            Some(token::Claims { user, grant: Grant::Covers, .. }) if valid_id(cover, 96) => {
                let size = req
                    .uri()
                    .query()
                    .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("size=")))
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(COVER_SIZE_DEFAULT)
                    .clamp(32, COVER_SIZE_MAX);
                ("getCoverArt", user, vec![("id", cover.to_string()), ("size", size.to_string())], "private, max-age=86400")
            }
            Some(token::Claims { grant: Grant::Covers, .. }) => return plain(StatusCode::NOT_FOUND),
            _ => return plain(StatusCode::FORBIDDEN),
        }
    } else {
        return plain(StatusCode::NOT_FOUND);
    };
    let Ok(permit) = STREAMS.try_acquire() else { return plain(StatusCode::SERVICE_UNAVAILABLE) };
    let up = match sub.raw(&user, endpoint, &params, range).await {
        Ok(r) => r,
        Err(_) => return plain(StatusCode::BAD_GATEWAY),
    };
    let status = up.status();
    // Отказ музыкального сервера приходит JSON/XML с кодом 200 — это не звук и не картинка
    let ctype = up.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let media = ctype.starts_with("audio/") || ctype.starts_with("image/") || ctype.starts_with("video/") || ctype == "application/ogg" || ctype == "application/octet-stream";
    if !(status == reqwest::StatusCode::OK || status == reqwest::StatusCode::PARTIAL_CONTENT) || !media {
        return plain(if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE { StatusCode::RANGE_NOT_SATISFIABLE } else { StatusCode::NOT_FOUND });
    }
    let mut b = Response::builder()
        .status(if status == reqwest::StatusCode::PARTIAL_CONTENT { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header("content-type", ctype)
        .header("cache-control", cache)
        .header("x-content-type-options", "nosniff");
    for name in ["content-length", "content-range", "accept-ranges"] {
        if let Some(v) = up.headers().get(name).and_then(|v| v.to_str().ok()) {
            b = b.header(name, v);
        }
    }
    if req.method() == Method::HEAD {
        return b.body(Full::new(Bytes::new()).map_err(|never| match never {}).boxed()).unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR));
    }
    // Разрешение живёт, пока идёт тело: поток освобождает место по завершении или обрыве
    let stream = up.bytes_stream().map_ok(Frame::data).map_err(std::io::Error::other).inspect_ok(move |_| {
        let _ = &permit;
    });
    b.body(BodyExt::boxed(StreamBody::new(stream))).unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR))
}
