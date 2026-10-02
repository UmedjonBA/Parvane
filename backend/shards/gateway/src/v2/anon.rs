//! Анонимный канал доставки (T070, T120; D-05, класс 11, инвариант 25).
//!
//! Гигиена на стороне gateway:
//! - в шину из ANON-метода не уходит ни токен, ни адрес/устройство сессии, ни
//!   IP (`shard_request` — единственное место сборки `ShardRequest`);
//! - ANON-методы — только в анонимном соединении и наоборот (`limits::admit`);
//! - один пользователь-получатель на запрос sealed-доставки и сигнала звонка
//!   (`check_single_recipient`), иначе состав пакета выдаёт отправителя;
//! - cooldown вызова (`call.ring_sealed`) — на соединение (`is_ring`);
//! - в анонимное соединение сервер не шлёт событий (`events_allowed`: нет
//!   подписок, нет уведомлений об отзыве — соединение не сопоставляется с
//!   устройством);
//! - IP, порт и id анонимного соединения не журналируются выше debug и не
//!   хранятся (`serve` обнуляет `client_ip` для анонимного канала).

use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::call::v2::{RingSealedRequest, SignalSealedRequest};
use parvane_protocol::pb::parvane::core::v2::{Channel, DeviceRef, ErrorCode, SealedEnvelope, ShardRequest};
use parvane_protocol::pb::parvane::msg::v2::DeliverSealedRequest;
use parvane_protocol::schema::MethodInfo;

/// Канал метода в реестре (MethodChannel).
pub(crate) const CH_PRE: i32 = 1;
pub(crate) const CH_ID: i32 = 2;
#[cfg(test)]
pub(crate) const CH_ANON: i32 = 3;
/// Вид метода «подписка» (MethodKind::SUBSCRIBE).
#[cfg(test)]
pub(crate) const KIND_SUBSCRIBE: i32 = 2;

/// Что сессия знает о себе (для сборки запроса шарду).
pub(crate) struct SessionIdentity<'a> {
    pub user: &'a str,
    pub device: &'a str,
    pub token: &'a str,
    pub client_ip: &'a str,
    pub reauth_fresh: bool,
    pub operator: bool,
}

/// Собрать `ShardRequest`: личность — только для ID-методов, IP — только для
/// PRE (лимиты входа/регистрации); ANON — пусто по всем полям личности.
pub(crate) fn shard_request(m: &MethodInfo, s: &SessionIdentity<'_>, body: Vec<u8>) -> ShardRequest {
    let id = m.channel == CH_ID;
    ShardRequest {
        method: m.name.to_string(),
        user: if id { s.user.to_string() } else { String::new() },
        device_id: if id { s.device.to_string() } else { String::new() },
        token: if id { s.token.to_string() } else { String::new() },
        client_ip: if m.channel == CH_PRE { s.client_ip.to_string() } else { String::new() },
        body,
        reauth_fresh: id && s.reauth_fresh,
        operator: id && s.operator,
    }
}

/// Все конверты — устройствам ОДНОГО пользователя, одно доказательство права.
fn same_recipient(envs: &[SealedEnvelope]) -> Result<(), ErrorCode> {
    let first = envs.first().ok_or(ErrorCode::Invalid)?;
    let user = first.recipient.as_ref().map(|r| r.address.as_str()).ok_or(ErrorCode::Invalid)?;
    let mut seen: Vec<&DeviceRef> = Vec::with_capacity(envs.len());
    for e in envs {
        let r = e.recipient.as_ref().ok_or(ErrorCode::Invalid)?;
        parvane_protocol::address::check_device(r).map_err(|_| ErrorCode::Invalid)?;
        if r.address != user || e.access != first.access || e.access.is_none() {
            return Err(ErrorCode::Invalid);
        }
        // Две копии одному устройству — тоже признак склейки пакетов.
        if seen.contains(&r) {
            return Err(ErrorCode::Invalid);
        }
        seen.push(r);
    }
    Ok(())
}

/// D-05: один получатель на запрос (`msg.deliver_sealed`, `call.signal_sealed`,
/// `call.ring_sealed`).
/// Проверяется до шарда (шард проверяет повторно).
pub(crate) fn check_single_recipient(m: &MethodInfo, body: &[u8]) -> Result<(), ErrorCode> {
    match m.name {
        "msg.deliver_sealed" => {
            let r: DeliverSealedRequest = decode_checked(body, Origin::Client).map_err(|e| e.code())?;
            same_recipient(&r.envelopes)
        }
        "call.signal_sealed" => {
            let r: SignalSealedRequest = decode_checked(body, Origin::Client).map_err(|e| e.code())?;
            same_recipient(&r.envelopes)
        }
        "call.ring_sealed" => {
            let r: RingSealedRequest = decode_checked(body, Origin::Client).map_err(|e| e.code())?;
            same_recipient(&r.envelopes)
        }
        _ => Ok(()),
    }
}

/// Первый сигнал звонка (для cooldown на соединение).
pub(crate) fn is_ring(m: &MethodInfo) -> bool {
    m.name == "call.ring_sealed"
}

/// События (подписки) — только в идентифицированной сессии.
pub(crate) fn events_allowed(channel: Channel) -> bool {
    channel == Channel::Identified
}
