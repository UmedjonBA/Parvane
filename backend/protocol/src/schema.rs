//! Таблица схемы (лимиты, акторы, типы полей) и реестр методов, сгенерированные
//! build.rs из опций `proto/parvane/**`. Используются кодеком для проверки
//! недоверенных байт ДО разбора (`limits.rs`).

/// Вид поля на проводе.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldTy {
    /// int32/int64/uint32/uint64/sint*/bool/enum.
    Varint,
    /// fixed64/sfixed64/double.
    Fixed64,
    /// fixed32/sfixed32/float.
    Fixed32,
    /// string (UTF-8).
    Str,
    /// bytes.
    Bytes,
    /// Вложенное сообщение (индекс в `MESSAGES`).
    Message(usize),
}

#[derive(Debug)]
pub struct FieldSpec {
    pub number: u32,
    pub name: &'static str,
    pub ty: FieldTy,
    pub repeated: bool,
    /// Байты для string/bytes (у repeated — на элемент).
    pub max_len: u32,
    /// Элементы repeated.
    pub max_items: u32,
    /// `(actor) = ACTOR_SERVER_SET`: клиентское значение — отказ.
    pub server_set: bool,
    /// Поле-enum: объявленные значения по возрастанию (пусто — не enum). spec 035: `unknown::scan`.
    pub enum_values: &'static [i32],
}

/// oneof сообщения (без синтетических `optional`).
#[derive(Debug)]
pub struct OneofSpec {
    pub name: &'static str,
    /// Номера полей-видов по возрастанию.
    pub members: &'static [u32],
    /// Виды делятся по номеру на обычные и критичные (spec 035, `KIND_ONEOFS`).
    pub kinds: bool,
}

/// oneof журнала или содержимого с видами по диапазонам номеров (spec 035, FR-041).
#[derive(Debug)]
pub struct KindOneof {
    pub message: &'static str,
    pub oneof: &'static str,
    pub members: &'static [u32],
}

/// Класс номера вида (contracts/versioning.md «Критичность»).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindClass {
    /// 1–999: неизвестный — хранится, при показе пропускается.
    Normal,
    /// 1000–1999: неизвестный — журнал закрыт для записи, содержимое — `STUB_CRITICAL`.
    Critical,
    OutOfRange,
}

/// Класс номера вида oneof, охваченного диапазонами.
pub fn kind_class(number: u32) -> KindClass {
    match number {
        1..=999 => KindClass::Normal,
        1000..=1999 => KindClass::Critical,
        _ => KindClass::OutOfRange,
    }
}

#[derive(Debug)]
pub struct MsgSpec {
    pub name: &'static str,
    /// Отсортированы по `number`.
    pub fields: &'static [FieldSpec],
    pub oneofs: &'static [OneofSpec],
}

impl MsgSpec {
    pub fn field(&self, number: u32) -> Option<&'static FieldSpec> {
        self.fields.binary_search_by_key(&number, |f| f.number).ok().and_then(|i| self.fields.get(i))
    }

    /// oneof, к которому относится поле.
    pub fn oneof_of(&self, number: u32) -> Option<&'static OneofSpec> {
        self.oneofs.iter().find(|o| o.members.binary_search(&number).is_ok())
    }
}

/// Запись реестра методов. Числовые поля — значения enum'ов registry.proto.
#[derive(Debug)]
pub struct MethodInfo {
    pub name: &'static str,
    /// `MethodChannel`: 1 PRE, 2 ID, 3 ANON.
    pub channel: i32,
    pub reauth: bool,
    /// `RateClass`: 1 MSG, 2 UPLOAD, 3 REQ, 4 ANON, 5 PRE.
    pub rate: i32,
    /// `MethodKind`: 1 CALL, 2 SUBSCRIBE, 3 STREAM.
    pub kind: i32,
    pub shard: &'static str,
    pub subject: &'static str,
    pub operator_only: bool,
    /// Федерация (spec 028): метод можно переслать чужому серверу и принять от него.
    pub federated: bool,
    /// Индексы в `MESSAGES`.
    pub request: usize,
    pub response: usize,
}

include!(concat!(env!("OUT_DIR"), "/schema_table.rs"));

/// Кодек тел запросов и ответов по имени метода — для хостов (T161).
pub mod method_codec {
    include!(concat!(env!("OUT_DIR"), "/method_codec.rs"));
}

/// Ось «Сборка» (spec 035): хеши схемы и исходников движка, id сборки, цель — из build.rs.
pub mod build_info {
    include!(concat!(env!("OUT_DIR"), "/build_info.rs"));
}

/// spec 035 (FR-050, тесты кодеков во всех обвязках): «максимально заполненное» сообщение типа
/// `full_name` — каждое поле задано (repeated — двумя элементами, если можно), вложенные — до глубины 3,
/// строки и байты — в пределах `(max_len)`, enum — наибольшим объявленным значением. Все виды oneof
/// записаны подряд (разборщик оставит последний). `None` — типа нет в схеме.
#[doc(hidden)]
pub fn sample_bytes(full_name: &str) -> Option<Vec<u8>> {
    let spec = message(full_name)?;
    let mut out = Vec::new();
    sample_into(spec, 0, &mut out);
    Some(out)
}

fn sample_into(spec: &'static MsgSpec, depth: u32, out: &mut Vec<u8>) {
    use prost::encoding::{encode_key, encode_varint, WireType};
    for f in spec.fields {
        let n = if f.repeated { f.max_items.min(2) } else { 1 };
        for _ in 0..n {
            match f.ty {
                FieldTy::Varint => {
                    let v: u64 = match f.enum_values.last() {
                        Some(&e) if e > 0 => e as u64,
                        Some(_) => continue,
                        None => 1,
                    };
                    encode_key(f.number, WireType::Varint, out);
                    encode_varint(v, out);
                }
                FieldTy::Fixed64 => {
                    encode_key(f.number, WireType::SixtyFourBit, out);
                    out.extend_from_slice(&1u64.to_le_bytes());
                }
                FieldTy::Fixed32 => {
                    encode_key(f.number, WireType::ThirtyTwoBit, out);
                    out.extend_from_slice(&1u32.to_le_bytes());
                }
                FieldTy::Str | FieldTy::Bytes => {
                    let len = (f.max_len as usize).min(3);
                    encode_key(f.number, WireType::LengthDelimited, out);
                    encode_varint(len as u64, out);
                    out.extend(std::iter::repeat_n(b'x', len));
                }
                FieldTy::Message(i) => {
                    let Some(nested) = MESSAGES.get(i) else { continue };
                    let mut inner = Vec::new();
                    if depth < 3 {
                        sample_into(nested, depth + 1, &mut inner);
                    }
                    encode_key(f.number, WireType::LengthDelimited, out);
                    encode_varint(inner.len() as u64, out);
                    out.extend_from_slice(&inner);
                }
            }
        }
    }
}

/// Спецификация сообщения по полному имени (`parvane.core.v2.Frame`).
pub fn message(full_name: &str) -> Option<&'static MsgSpec> {
    MESSAGES.binary_search_by(|m| m.name.cmp(full_name)).ok().and_then(|i| MESSAGES.get(i))
}

/// Метод реестра по имени на проводе.
pub fn method(name: &str) -> Option<&'static MethodInfo> {
    METHODS.binary_search_by(|m| m.name.cmp(name)).ok().and_then(|i| METHODS.get(i))
}

#[cfg(test)]
mod method_codec_tests {
    use super::{method_codec, METHODS};

    /// T161: хост может позвать любой метод реестра — пустой запрос кодируется,
    /// пустой ответ разбирается, незнакомое имя даёт `None`.
    #[test]
    fn every_registry_method_has_a_codec() {
        assert!(METHODS.len() >= 80);
        for m in METHODS {
            let body = method_codec::encode_request(m.name, "{}").unwrap_or_else(|| panic!("{}: нет кодека запроса", m.name));
            assert!(body.is_ok(), "{}: пустой запрос не кодируется", m.name);
            let json = method_codec::decode_response(m.name, &[]).unwrap_or_else(|| panic!("{}: нет кодека ответа", m.name));
            assert!(json.is_ok(), "{}: пустой ответ не разбирается", m.name);
        }
        assert!(method_codec::encode_request("nope.method", "{}").is_none());
        assert!(matches!(method_codec::encode_request("identity.session.issue", "не json"), Some(Err(_))));
    }
}
