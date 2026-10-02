//! Проверка недоверенных байт по таблице схемы ДО разбора (T014, класс 12).
//!
//! Обход wire-формата protobuf без выделения памяти: каждая длина
//! string/bytes ≤ `(max_len)`, число элементов repeated ≤ `(max_items)`,
//! строки — валидный UTF-8, вложенность ≤ `MAX_DEPTH`, группы (wire 3/4)
//! запрещены, неповторяемое поле не встречается дважды (иначе слияние
//! вложенных сообщений обошло бы лимиты repeated), поля с
//! `(actor) = ACTOR_SERVER_SET` от клиента отвергаются (класс 3).
//!
//! Неизвестные номера полей пропускаются (совместимость вперёд, FR-003):
//! их длина всё равно ограничена длиной объемлющего сообщения.

use crate::error::{ProtoError, Result};
use crate::schema::{self, FieldTy, MsgSpec, MESSAGES};

/// Максимальная вложенность сообщений.
pub const MAX_DEPTH: u32 = 32;

/// Откуда пришли байты: от клиента серверные поля запрещены.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Client,
    Server,
}

/// Проверить байты сообщения `spec`.
pub fn check(spec: &'static MsgSpec, bytes: &[u8], origin: Origin) -> Result<()> {
    walk(spec, bytes, origin, 0)
}

/// Проверить байты сообщения по полному имени типа.
pub fn check_named(full_name: &str, bytes: &[u8], origin: Origin) -> Result<()> {
    let spec = schema::message(full_name).ok_or(ProtoError::Malformed)?;
    check(spec, bytes, origin)
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn varint(&mut self) -> Result<u64> {
        let mut v: u64 = 0;
        for i in 0..10 {
            let b = *self.buf.get(self.pos).ok_or(ProtoError::Malformed)?;
            self.pos += 1;
            if i == 9 && b > 1 {
                return Err(ProtoError::Malformed);
            }
            v |= u64::from(b & 0x7f) << (7 * i);
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(ProtoError::Malformed)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or(ProtoError::Malformed)?;
        let s = self.buf.get(self.pos..end).ok_or(ProtoError::Malformed)?;
        self.pos = end;
        Ok(s)
    }

    fn len_delimited(&mut self) -> Result<&'a [u8]> {
        let n = self.varint()?;
        let n = usize::try_from(n).map_err(|_| ProtoError::Malformed)?;
        self.take(n)
    }
}

/// Число varint'ов в упакованном поле.
fn count_packed_varints(data: &[u8]) -> Result<u64> {
    if data.last().is_some_and(|b| b & 0x80 != 0) {
        return Err(ProtoError::Malformed);
    }
    Ok(data.iter().filter(|b| *b & 0x80 == 0).count() as u64)
}

fn walk(spec: &'static MsgSpec, bytes: &[u8], origin: Origin, depth: u32) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(ProtoError::TooDeep);
    }
    let mut r = Reader { buf: bytes, pos: 0 };
    // Счётчики по индексу поля в spec.fields (полей в сообщении немного).
    let mut counts = [0u64; 64];
    let mut overflow: Vec<(u32, u64)> = Vec::new();
    while !r.done() {
        let key = r.varint()?;
        let number = u32::try_from(key >> 3).map_err(|_| ProtoError::Malformed)?;
        let wire = (key & 7) as u8;
        if number == 0 {
            return Err(ProtoError::Malformed);
        }
        let Some(idx) = spec.fields.binary_search_by_key(&number, |f| f.number).ok() else {
            skip_unknown(&mut r, wire)?;
            continue;
        };
        let field = &spec.fields[idx];
        if origin == Origin::Client && field.server_set {
            return Err(ProtoError::ServerSetField(field.name));
        }
        let mut add = |n: u64| -> Result<u64> {
            let slot = if idx < counts.len() {
                &mut counts[idx]
            } else {
                match overflow.iter_mut().find(|(k, _)| *k == number) {
                    Some((_, c)) => c,
                    None => {
                        overflow.push((number, 0));
                        let last = overflow.len() - 1;
                        &mut overflow[last].1
                    }
                }
            };
            *slot = slot.saturating_add(n);
            Ok(*slot)
        };
        let seen = match (field.ty, wire) {
            (FieldTy::Varint, 0) => {
                r.varint()?;
                add(1)?
            }
            (FieldTy::Fixed64, 1) => {
                r.take(8)?;
                add(1)?
            }
            (FieldTy::Fixed32, 5) => {
                r.take(4)?;
                add(1)?
            }
            // Упакованные repeated-скаляры.
            (FieldTy::Varint | FieldTy::Fixed64 | FieldTy::Fixed32, 2) if field.repeated => {
                let data = r.len_delimited()?;
                let n = match field.ty {
                    FieldTy::Varint => count_packed_varints(data)?,
                    FieldTy::Fixed64 if data.len() % 8 == 0 => (data.len() / 8) as u64,
                    FieldTy::Fixed32 if data.len() % 4 == 0 => (data.len() / 4) as u64,
                    _ => return Err(ProtoError::Malformed),
                };
                add(n)?
            }
            (FieldTy::Str, 2) => {
                let data = r.len_delimited()?;
                if data.len() as u64 > u64::from(field.max_len) {
                    return Err(ProtoError::FieldLimit(field.name));
                }
                std::str::from_utf8(data).map_err(|_| ProtoError::InvalidField(field.name))?;
                add(1)?
            }
            (FieldTy::Bytes, 2) => {
                let data = r.len_delimited()?;
                if data.len() as u64 > u64::from(field.max_len) {
                    return Err(ProtoError::FieldLimit(field.name));
                }
                add(1)?
            }
            (FieldTy::Message(i), 2) => {
                let data = r.len_delimited()?;
                let nested = MESSAGES.get(i).ok_or(ProtoError::Malformed)?;
                walk(nested, data, origin, depth + 1)?;
                add(1)?
            }
            _ => return Err(ProtoError::Malformed),
        };
        if field.repeated {
            if seen > u64::from(field.max_items) {
                return Err(ProtoError::FieldLimit(field.name));
            }
        } else if seen > 1 {
            return Err(ProtoError::DuplicateField(field.name));
        }
    }
    Ok(())
}

fn skip_unknown(r: &mut Reader<'_>, wire: u8) -> Result<()> {
    match wire {
        0 => {
            r.varint()?;
        }
        1 => {
            r.take(8)?;
        }
        2 => {
            r.len_delimited()?;
        }
        5 => {
            r.take(4)?;
        }
        _ => return Err(ProtoError::Malformed),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::core::v2::{frame, AuthOk, Frame, Hello, Request};
    use prost::Message;

    fn frame_spec() -> &'static MsgSpec {
        schema::message("parvane.core.v2.Frame").unwrap()
    }

    #[test]
    fn accepts_valid_frame() {
        let f = Frame {
            proto_major: 2,
            kind: Some(frame::Kind::Hello(Hello { proto_minor: 0, features: vec!["x".into()], ..Default::default() })),
        };
        assert!(check(frame_spec(), &f.encode_to_vec(), Origin::Client).is_ok());
    }

    #[test]
    fn rejects_long_method() {
        let f = Frame {
            proto_major: 2,
            kind: Some(frame::Kind::Request(Request { id: 1, method: "m".repeat(97), ..Default::default() })),
        };
        assert_eq!(check(frame_spec(), &f.encode_to_vec(), Origin::Client), Err(ProtoError::FieldLimit("method")));
    }

    #[test]
    fn rejects_too_many_items() {
        let f = Frame {
            proto_major: 2,
            kind: Some(frame::Kind::Hello(Hello { features: vec!["a".into(); 65], ..Default::default() })),
        };
        assert_eq!(check(frame_spec(), &f.encode_to_vec(), Origin::Client), Err(ProtoError::FieldLimit("features")));
    }

    #[test]
    fn rejects_server_set_from_client() {
        let f = Frame {
            proto_major: 2,
            kind: Some(frame::Kind::AuthOk(AuthOk { user: "a@b".into(), device_id: String::new() })),
        };
        let b = f.encode_to_vec();
        assert_eq!(check(frame_spec(), &b, Origin::Client), Err(ProtoError::ServerSetField("user")));
        assert!(check(frame_spec(), &b, Origin::Server).is_ok());
    }

    #[test]
    fn rejects_duplicate_singular_and_groups_and_truncation() {
        // proto_major дважды.
        assert_eq!(check(frame_spec(), &[0x08, 0x02, 0x08, 0x02], Origin::Client), Err(ProtoError::DuplicateField("proto_major")));
        // wire type 3 (группа).
        assert_eq!(check(frame_spec(), &[0x0b], Origin::Client), Err(ProtoError::Malformed));
        // Обрезанная длина.
        assert_eq!(check(frame_spec(), &[0x52, 0x05, 0x01], Origin::Client), Err(ProtoError::Malformed));
        // Неизвестное поле пропускается.
        assert!(check(frame_spec(), &[0xf8, 0x3e, 0x01], Origin::Client).is_ok());
    }

    #[test]
    fn rejects_bad_utf8() {
        // Request (поле 20) { method (2) = [0xff] }
        let req = [0x12, 0x01, 0xff];
        let mut b = vec![0xa2, 0x01, req.len() as u8];
        b.extend_from_slice(&req);
        assert_eq!(check(frame_spec(), &b, Origin::Client), Err(ProtoError::InvalidField("method")));
    }
}
