//! Поведение на неизвестное (T016, FR-004):
//! - неизвестный вид содержимого (oneof `Content.kind` не распознан) или
//!   неизвестный номер из `OpHeader.critical_fields` → нативная заглушка
//!   «сообщение не поддерживается вашей версией», курсор идёт дальше;
//! - неизвестная запись журнала/служебное событие → пропуск (курсор идёт);
//! - неизвестный метод запроса → отказ `INVALID`.

use crate::pb::parvane::msg::v2::{inbox_record, Content, InboxRecord};
use crate::pb::parvane::core::v2::Event;
use crate::schema;

/// Что делать клиенту с полученной записью/содержимым.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Показать как обычно.
    Show,
    /// Показать нативную заглушку «не поддерживается»; ответ и пересылка разрешены.
    Stub,
    /// spec 035 (FR-041): неизвестный критичный вид (1000–1999) — та же заглушка, ответ, правка и пересылка
    /// запрещены. Обвязки нынешних клиентов получают её как `stub` (заглушка), запреты — в модели движка.
    StubCritical,
    /// Пропустить без показа (служебное), курсор двигается.
    Skip,
}

/// Известен ли номер поля верхнего уровня `Content`.
fn content_field_known(number: u32) -> bool {
    schema::message("parvane.msg.v2.Content").is_some_and(|m| m.field(number).is_some())
}

/// Решение по расшифрованному содержимому.
pub fn content_disposition(content: &Content, critical_fields: &[u32]) -> Disposition {
    if content.kind.is_none() {
        return Disposition::Stub;
    }
    if critical_fields.iter().any(|n| !content_field_known(*n)) {
        return Disposition::Stub;
    }
    Disposition::Show
}

/// Что разрешено над сообщением с этим показом (contracts/versioning.md «Критичность»).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Actions {
    pub reply: bool,
    pub edit: bool,
    pub forward: bool,
}

/// Действия по показу: известное — всё; заглушка — ответ и пересылка (править непонятное нельзя — правка
/// пересобрала бы его без неизвестного); критичная заглушка и служебное — ничего.
pub fn actions(d: Disposition) -> Actions {
    match d {
        Disposition::Show => Actions { reply: true, edit: true, forward: true },
        Disposition::Stub => Actions { reply: true, edit: false, forward: true },
        Disposition::StubCritical | Disposition::Skip => Actions { reply: false, edit: false, forward: false },
    }
}

/// spec 035 (FR-031/FR-041): решение по ИСХОДНЫМ байтам содержимого — `unknown::scan` до разбора: неизвестный
/// критичный вид — `StubCritical`, неизвестный обычный вид — `Stub`, неизвестное поле внутри известного вида —
/// показ известного; затем правило `critical_fields` ([`content_disposition`]).
pub fn content_disposition_bytes(bytes: &[u8], critical_fields: &[u32]) -> crate::Result<Disposition> {
    let report = scan("parvane.msg.v2.Content", bytes)?;
    if report.has_critical() {
        return Ok(Disposition::StubCritical);
    }
    let content: Content = crate::codec::decode_checked(bytes, crate::limits::Origin::Client)?;
    Ok(content_disposition(&content, critical_fields))
}

/// Решение по записи журнала инбокса.
pub fn record_disposition(rec: &InboxRecord) -> Disposition {
    match rec.item {
        None => Disposition::Skip,
        Some(inbox_record::Item::Sealed(_)) | Some(inbox_record::Item::Group(_)) => Disposition::Show,
        Some(inbox_record::Item::GroupState(_))
        | Some(inbox_record::Item::DeviceRevoked(_))
        | Some(inbox_record::Item::DeviceAdded(_))
        | Some(inbox_record::Item::Journal(_)) => Disposition::Skip,
    }
}

// ── spec 035 (FR-031, R5): обнаружение неизвестного по дескриптору ─────────────

/// Что найдено.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownKind {
    /// Номер поля, которого нет в схеме сообщения.
    Field,
    /// Вид oneof, которого нет в схеме (ни одного известного вида этого oneof в сообщении нет).
    Oneof,
    /// Значение enum вне объявленных.
    Enum,
}

/// Одна находка.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownItem {
    /// Путь до сообщения (имена полей через точку, элемент repeated — `[i]`); у enum — до самого поля.
    pub path: String,
    pub kind: UnknownKind,
    /// Номер поля / вида либо значение enum.
    pub number: i64,
    /// Имя oneof для `UnknownKind::Oneof`.
    pub oneof: Option<&'static str>,
    /// Вид из критичного диапазона 1000–1999 у oneof, охваченного диапазонами (`schema::KIND_ONEOFS`).
    pub critical: bool,
}

/// Итог сканирования — находки в порядке байтов.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnknownReport {
    pub items: Vec<UnknownItem>,
}

impl UnknownReport {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    /// Есть критичный неизвестный вид — журнал закрыт для записи, содержимое — `STUB_CRITICAL`.
    pub fn has_critical(&self) -> bool {
        self.items.iter().any(|i| i.critical)
    }
    /// Пути находок (для отметки `range-hold`).
    pub fn paths(&self) -> Vec<String> {
        self.items.iter().map(|i| i.path.clone()).collect()
    }
}

/// Просканировать исходные байты сообщения типа `type_name` по таблице схемы ДО разбора prost:
/// неизвестный номер поля на любой глубине, неизвестный вид oneof, значение enum вне объявленных.
/// Повреждённые байты и незнакомый тип — `Malformed`, слишком глубокая вложенность — `TooDeep`.
pub fn scan(type_name: &str, bytes: &[u8]) -> crate::Result<UnknownReport> {
    let spec = schema::message(type_name).ok_or(crate::ProtoError::Malformed)?;
    let mut report = UnknownReport::default();
    scan_msg(spec, bytes, "", 0, &mut report)?;
    Ok(report)
}

struct Wire<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Wire<'a> {
    fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }
    fn varint(&mut self) -> crate::Result<u64> {
        let mut v: u64 = 0;
        for i in 0..10 {
            let b = *self.buf.get(self.pos).ok_or(crate::ProtoError::Malformed)?;
            self.pos += 1;
            if i == 9 && b > 1 {
                return Err(crate::ProtoError::Malformed);
            }
            v |= u64::from(b & 0x7f) << (7 * i);
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(crate::ProtoError::Malformed)
    }
    fn take(&mut self, n: usize) -> crate::Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or(crate::ProtoError::Malformed)?;
        let s = self.buf.get(self.pos..end).ok_or(crate::ProtoError::Malformed)?;
        self.pos = end;
        Ok(s)
    }
    fn len_delimited(&mut self) -> crate::Result<&'a [u8]> {
        let n = usize::try_from(self.varint()?).map_err(|_| crate::ProtoError::Malformed)?;
        self.take(n)
    }
    /// Следующее поле: (номер, тип провода, полезные байты для LEN, значение для VARINT).
    fn field(&mut self) -> crate::Result<(u32, u8, &'a [u8], u64)> {
        let key = self.varint()?;
        let number = u32::try_from(key >> 3).map_err(|_| crate::ProtoError::Malformed)?;
        let wire = (key & 7) as u8;
        if number == 0 {
            return Err(crate::ProtoError::Malformed);
        }
        match wire {
            0 => Ok((number, 0, &[], self.varint()?)),
            1 => Ok((number, 1, self.take(8)?, 0)),
            2 => Ok((number, 2, self.len_delimited()?, 0)),
            5 => Ok((number, 5, self.take(4)?, 0)),
            _ => Err(crate::ProtoError::Malformed),
        }
    }
}

fn join(path: &str, seg: &str) -> String {
    if path.is_empty() {
        seg.to_string()
    } else {
        format!("{path}.{seg}")
    }
}

fn scan_msg(spec: &'static schema::MsgSpec, bytes: &[u8], path: &str, depth: u32, out: &mut UnknownReport) -> crate::Result<()> {
    use schema::FieldTy;
    if depth > crate::limits::MAX_DEPTH {
        return Err(crate::ProtoError::TooDeep);
    }
    // Проход 1: какие известные виды oneof присутствуют (неизвестный номер — вид, только если ни одного нет).
    let mut present: Vec<&'static str> = Vec::new();
    let mut r = Wire { buf: bytes, pos: 0 };
    while !r.done() {
        let (number, ..) = r.field()?;
        if let Some(o) = spec.oneof_of(number) {
            if !present.contains(&o.name) {
                present.push(o.name);
            }
        }
    }
    // oneof, к которому относится неизвестный номер: первый охваченный диапазонами, иначе первый.
    let target = spec.oneofs.iter().find(|o| o.kinds).or_else(|| spec.oneofs.first()).filter(|o| !present.contains(&o.name));
    // Проход 2: находки в порядке байтов.
    let mut seen: Vec<(u32, usize)> = Vec::new();
    let mut r = Wire { buf: bytes, pos: 0 };
    while !r.done() {
        let (number, wire, data, value) = r.field()?;
        let Some(f) = spec.field(number) else {
            let item = match target {
                Some(o) => UnknownItem {
                    path: path.to_string(),
                    kind: UnknownKind::Oneof,
                    number: i64::from(number),
                    oneof: Some(o.name),
                    critical: o.kinds && schema::kind_class(number) == schema::KindClass::Critical,
                },
                None => UnknownItem { path: path.to_string(), kind: UnknownKind::Field, number: i64::from(number), oneof: None, critical: false },
            };
            out.items.push(item);
            continue;
        };
        let index = match seen.iter_mut().find(|(n, _)| *n == number) {
            Some((_, c)) => {
                *c += 1;
                *c - 1
            }
            None => {
                seen.push((number, 1));
                0
            }
        };
        let seg = if f.repeated { format!("{}[{index}]", f.name) } else { f.name.to_string() };
        match (f.ty, wire) {
            (FieldTy::Message(i), 2) => {
                let nested = schema::MESSAGES.get(i).ok_or(crate::ProtoError::Malformed)?;
                scan_msg(nested, data, &join(path, &seg), depth + 1, out)?;
            }
            (FieldTy::Message(_), _) => return Err(crate::ProtoError::Malformed),
            (FieldTy::Varint, 0) if !f.enum_values.is_empty() => {
                let v = i64::from(value as i32);
                if f.enum_values.binary_search(&(v as i32)).is_err() {
                    out.items.push(UnknownItem { path: join(path, &seg), kind: UnknownKind::Enum, number: v, oneof: None, critical: false });
                }
            }
            // Упакованный repeated enum.
            (FieldTy::Varint, 2) if f.repeated && !f.enum_values.is_empty() => {
                let mut p = Wire { buf: data, pos: 0 };
                let mut k = index;
                while !p.done() {
                    let v = i64::from(p.varint()? as i32);
                    if f.enum_values.binary_search(&(v as i32)).is_err() {
                        out.items.push(UnknownItem {
                            path: join(path, &format!("{}[{k}]", f.name)),
                            kind: UnknownKind::Enum,
                            number: v,
                            oneof: None,
                            critical: false,
                        });
                    }
                    k += 1;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Известные виды событий подписки.
pub const KNOWN_EVENT_KINDS: &[&str] = &["inbox.record", "ephemeral.typing", "ephemeral.presence", "session.revoked"];

/// Неизвестный вид события → пропуск.
pub fn event_disposition(ev: &Event) -> Disposition {
    if KNOWN_EVENT_KINDS.contains(&ev.kind.as_str()) {
        Disposition::Show
    } else {
        Disposition::Skip
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::msg::v2::{content, Text};
    use prost::Message;

    #[test]
    fn unknown_kind_is_stub() {
        // Content с неизвестным полем 50 (новый вид из будущей версии).
        let bytes = [0x92, 0x03, 0x00];
        let c = Content::decode(&bytes[..]).unwrap();
        assert_eq!(content_disposition(&c, &[]), Disposition::Stub);
    }

    #[test]
    fn critical_unknown_is_stub() {
        let c = Content { kind: Some(content::Kind::Text(Text::default())), ..Default::default() };
        assert_eq!(content_disposition(&c, &[]), Disposition::Show);
        assert_eq!(content_disposition(&c, &[1]), Disposition::Show);
        assert_eq!(content_disposition(&c, &[77]), Disposition::Stub);
    }

    #[test]
    fn unknown_record_skipped() {
        let r = InboxRecord::decode(&[0x08, 0x05, 0xf2, 0x03, 0x00][..]).unwrap();
        assert_eq!(record_disposition(&r), Disposition::Skip);
        assert_eq!(event_disposition(&Event { kind: "future.kind".into(), ..Default::default() }), Disposition::Skip);
    }
}
