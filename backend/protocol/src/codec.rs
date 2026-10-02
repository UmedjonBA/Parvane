//! Кодек кадров (T013): WebSocket — один двоичный кадр на сообщение; TCP —
//! кадры с varint-префиксом длины. Размер проверяется ДО разбора, затем
//! лимиты схемы (`limits`), затем prost, затем `proto_major` и направление.

use prost::{Message, Name};

use crate::error::{ProtoError, Result};
use crate::limits::{self, Origin};
use crate::pb::parvane::core::v2::{frame, Frame, Request};
use crate::schema::{self, MethodInfo};
use crate::PROTO_MAJOR;

/// Кадр целиком (как лимит кадра gateway v1).
pub const MAX_FRAME: usize = 4_194_304;
/// Преамбула TCP-соединения v2: отличает его от построчного JSON v1 (`{`).
pub const TCP_MAGIC: &[u8; 4] = b"PVN2";
/// Длина varint-префикса TCP-кадра (≤ 4 МиБ умещается в 4 байта).
const MAX_PREFIX: usize = 5;

/// Разобрать недоверенные байты сообщения типа `M` с проверкой лимитов.
pub fn decode_checked<M: Message + Name + Default>(bytes: &[u8], origin: Origin) -> Result<M> {
    if bytes.len() > MAX_FRAME {
        return Err(ProtoError::FrameTooLarge);
    }
    limits::check_named(&M::full_name(), bytes, origin)?;
    M::decode(bytes).map_err(|_| ProtoError::Malformed)
}

/// Разобрать кадр. `origin` — кто его прислал.
pub fn decode_frame(bytes: &[u8], origin: Origin) -> Result<Frame> {
    let f: Frame = decode_checked(bytes, origin)?;
    if f.proto_major != PROTO_MAJOR {
        return Err(ProtoError::UnsupportedMajor(f.proto_major));
    }
    let Some(kind) = &f.kind else {
        // Неизвестный вид кадра: сервер — отказ, клиент — пропуск (unknown.rs).
        return Err(ProtoError::Malformed);
    };
    let ok = match origin {
        Origin::Client => matches!(
            kind,
            frame::Kind::Hello(_) | frame::Kind::Auth(_) | frame::Kind::Request(_) | frame::Kind::Ping(_) | frame::Kind::Pong(_)
        ),
        Origin::Server => matches!(
            kind,
            frame::Kind::Welcome(_)
                | frame::Kind::AuthOk(_)
                | frame::Kind::Response(_)
                | frame::Kind::Event(_)
                | frame::Kind::StreamChunk(_)
                | frame::Kind::Ping(_)
                | frame::Kind::Pong(_)
        ),
    };
    if !ok {
        return Err(ProtoError::WrongDirection);
    }
    Ok(f)
}

/// Собрать кадр.
pub fn encode_frame(kind: frame::Kind) -> Vec<u8> {
    Frame { proto_major: PROTO_MAJOR, kind: Some(kind) }.encode_to_vec()
}

/// Проверить запрос по реестру: метод известен, тело — в лимитах своего типа.
/// Права канала/reauth/частоты проверяет gateway по возвращённой записи.
pub fn check_request(req: &Request, origin: Origin) -> Result<&'static MethodInfo> {
    let m = schema::method(&req.method).ok_or(ProtoError::UnknownMethod)?;
    let spec = schema::MESSAGES.get(m.request).ok_or(ProtoError::Malformed)?;
    limits::check(spec, &req.body, origin)?;
    if req.timeout_ms > 30_000 {
        return Err(ProtoError::InvalidField("timeout_ms"));
    }
    Ok(m)
}

/// TCP: префикс длины + кадр.
pub fn tcp_encode(frame_bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame_bytes.len() + MAX_PREFIX);
    prost::encoding::encode_varint(frame_bytes.len() as u64, &mut out);
    out.extend_from_slice(frame_bytes);
    out
}

/// Потоковый разборщик TCP-кадров: длина проверяется до буферизации тела.
#[derive(Default)]
pub struct TcpDecoder {
    buf: Vec<u8>,
}

impl TcpDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Добавить принятые байты.
    pub fn push(&mut self, data: &[u8]) -> Result<()> {
        // Не держим больше одного кадра с префиксом.
        if self.buf.len() + data.len() > MAX_FRAME + MAX_PREFIX && self.peek_len()?.is_none() {
            return Err(ProtoError::FrameTooLarge);
        }
        self.buf.extend_from_slice(data);
        Ok(())
    }

    fn peek_len(&self) -> Result<Option<(usize, usize)>> {
        let mut v: u64 = 0;
        for i in 0..MAX_PREFIX {
            let Some(b) = self.buf.get(i) else { return Ok(None) };
            v |= u64::from(b & 0x7f) << (7 * i);
            if b & 0x80 == 0 {
                let len = usize::try_from(v).map_err(|_| ProtoError::FrameTooLarge)?;
                if len > MAX_FRAME {
                    return Err(ProtoError::FrameTooLarge);
                }
                return Ok(Some((i + 1, len)));
            }
        }
        Err(ProtoError::FrameTooLarge)
    }

    /// Следующий целый кадр (байты без префикса), если накоплен.
    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>> {
        let Some((pre, len)) = self.peek_len()? else { return Ok(None) };
        if self.buf.len() < pre + len {
            return Ok(None);
        }
        let frame = self.buf[pre..pre + len].to_vec();
        self.buf.drain(..pre + len);
        Ok(Some(frame))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::core::v2::{Hello, Ping, Request, Welcome};

    #[test]
    fn roundtrip_and_direction() {
        let b = encode_frame(frame::Kind::Hello(Hello::default()));
        assert!(decode_frame(&b, Origin::Client).is_ok());
        assert_eq!(decode_frame(&b, Origin::Server), Err(ProtoError::WrongDirection));
        let w = encode_frame(frame::Kind::Welcome(Welcome::default()));
        assert_eq!(decode_frame(&w, Origin::Client), Err(ProtoError::WrongDirection));
    }

    #[test]
    fn major_version() {
        let b = Frame { proto_major: 3, kind: Some(frame::Kind::Ping(Ping { nonce: 1 })) }.encode_to_vec();
        assert_eq!(decode_frame(&b, Origin::Client), Err(ProtoError::UnsupportedMajor(3)));
    }

    #[test]
    fn oversize_rejected_before_parse() {
        let b = vec![0u8; MAX_FRAME + 1];
        assert_eq!(decode_frame(&b, Origin::Client), Err(ProtoError::FrameTooLarge));
    }

    #[test]
    fn request_registry() {
        let ok = Request { id: 1, method: "msg.inbox.sync".into(), body: vec![], timeout_ms: 1000 };
        assert_eq!(check_request(&ok, Origin::Client).unwrap().shard, "messenger");
        let bad = Request { method: "msg.chat.send".into(), ..ok.clone() };
        assert_eq!(check_request(&bad, Origin::Client).err(), Some(ProtoError::UnknownMethod));
        let slow = Request { timeout_ms: 30_001, ..ok };
        assert!(check_request(&slow, Origin::Client).is_err());
    }

    #[test]
    fn tcp_framing() {
        let a = encode_frame(frame::Kind::Ping(Ping { nonce: 7 }));
        let b = encode_frame(frame::Kind::Ping(Ping { nonce: 8 }));
        let mut wire = tcp_encode(&a);
        wire.extend(tcp_encode(&b));
        let mut d = TcpDecoder::new();
        for chunk in wire.chunks(3) {
            d.push(chunk).unwrap();
        }
        assert_eq!(d.next_frame().unwrap().unwrap(), a);
        assert_eq!(d.next_frame().unwrap().unwrap(), b);
        assert_eq!(d.next_frame().unwrap(), None);
        // Префикс длины больше 4 МиБ — отказ до чтения тела.
        let mut big = Vec::new();
        prost::encoding::encode_varint((MAX_FRAME + 1) as u64, &mut big);
        let mut d = TcpDecoder::new();
        d.push(&big).unwrap();
        assert_eq!(d.next_frame(), Err(ProtoError::FrameTooLarge));
    }
}
