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
}

#[derive(Debug)]
pub struct MsgSpec {
    pub name: &'static str,
    /// Отсортированы по `number`.
    pub fields: &'static [FieldSpec],
}

impl MsgSpec {
    pub fn field(&self, number: u32) -> Option<&'static FieldSpec> {
        self.fields.binary_search_by_key(&number, |f| f.number).ok().and_then(|i| self.fields.get(i))
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
    /// Индексы в `MESSAGES`.
    pub request: usize,
    pub response: usize,
}

include!(concat!(env!("OUT_DIR"), "/schema_table.rs"));

/// Кодек тел запросов и ответов по имени метода — для хостов (T161).
pub mod method_codec {
    include!(concat!(env!("OUT_DIR"), "/method_codec.rs"));
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
