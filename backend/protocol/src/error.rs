//! Ошибки движка и их отображение на коды протокола (`ErrorCode`). Текст
//! ошибок — только для логов; клиенту уходит код (инвариант 18).

use crate::pb::parvane::core::v2::ErrorCode;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtoError {
    #[error("кадр больше лимита")]
    FrameTooLarge,
    #[error("повреждённые байты protobuf")]
    Malformed,
    #[error("превышен лимит поля {0}")]
    FieldLimit(&'static str),
    #[error("поле {0} задаёт только сервер")]
    ServerSetField(&'static str),
    #[error("поле {0} повторено")]
    DuplicateField(&'static str),
    #[error("слишком глубокая вложенность")]
    TooDeep,
    #[error("неподдерживаемая мажорная версия {0}")]
    UnsupportedMajor(u32),
    #[error("вид кадра недопустим в этом направлении")]
    WrongDirection,
    #[error("неизвестный метод")]
    UnknownMethod,
    #[error("недопустимое значение поля {0}")]
    InvalidField(&'static str),
    #[error("недопустимый адрес")]
    BadAddress,
    #[error("подпись не сходится")]
    BadSignature,
    #[error("контекст операции не совпадает")]
    ContextMismatch,
    #[error("повтор операции")]
    Duplicate,
    #[error("нет права")]
    Forbidden,
    #[error("цепочка сертификатов не сходится")]
    BadCertificate,
    #[error("корневой ключ не совпадает с известным")]
    RootMismatch,
    #[error("ошибка криптографии")]
    Crypto,
    #[error("срок истёк")]
    Expired,
    #[error("слишком часто")]
    RateLimited,
    #[error("журнал: нарушена цепочка")]
    BrokenChain,
    #[error("объект не найден")]
    NotFound,
}

impl ProtoError {
    /// Стабильное имя вида ошибки (векторы сравнивают его во всех обвязках).
    pub fn kind(&self) -> &'static str {
        match self {
            ProtoError::FrameTooLarge => "FrameTooLarge",
            ProtoError::Malformed => "Malformed",
            ProtoError::FieldLimit(_) => "FieldLimit",
            ProtoError::ServerSetField(_) => "ServerSetField",
            ProtoError::DuplicateField(_) => "DuplicateField",
            ProtoError::TooDeep => "TooDeep",
            ProtoError::UnsupportedMajor(_) => "UnsupportedMajor",
            ProtoError::WrongDirection => "WrongDirection",
            ProtoError::UnknownMethod => "UnknownMethod",
            ProtoError::InvalidField(_) => "InvalidField",
            ProtoError::BadAddress => "BadAddress",
            ProtoError::BadSignature => "BadSignature",
            ProtoError::ContextMismatch => "ContextMismatch",
            ProtoError::Duplicate => "Duplicate",
            ProtoError::Forbidden => "Forbidden",
            ProtoError::BadCertificate => "BadCertificate",
            ProtoError::RootMismatch => "RootMismatch",
            ProtoError::Crypto => "Crypto",
            ProtoError::Expired => "Expired",
            ProtoError::RateLimited => "RateLimited",
            ProtoError::BrokenChain => "BrokenChain",
            ProtoError::NotFound => "NotFound",
        }
    }

    /// Код протокола для клиента.
    pub fn code(&self) -> ErrorCode {
        match self {
            ProtoError::UnsupportedMajor(_) => ErrorCode::UpgradeRequired,
            ProtoError::Duplicate => ErrorCode::Duplicate,
            ProtoError::Forbidden | ProtoError::RootMismatch => ErrorCode::Forbidden,
            ProtoError::Expired => ErrorCode::Expired,
            ProtoError::RateLimited => ErrorCode::RateLimited,
            ProtoError::FrameTooLarge => ErrorCode::Limit,
            ProtoError::NotFound => ErrorCode::NotFound,
            _ => ErrorCode::Invalid,
        }
    }
}

pub type Result<T> = std::result::Result<T, ProtoError>;
