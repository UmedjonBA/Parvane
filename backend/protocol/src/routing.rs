//! Адресат-сервер запроса движка (spec 028, правило FED-1): домен объекта
//! запроса — получателя письма или сигнала, группы, контейнера. Хост ставит его
//! в `Request.dest_domain`; свой домен gateway обрабатывает как обычный запрос.
//! Домен берётся из тела, которое движок сам собрал, — отдельного учёта
//! адресатов по каждой операции нет.

use prost::Message;

use crate::client::OutRequest;
use crate::pb::parvane::call::v2 as cpb;
use crate::pb::parvane::core::v2::{
    DomainContainerCreateRequest, DomainGrantLeaveRequest, DomainGrantRevokeRequest, DomainGrantSetRequest,
    DomainKeyRotateRequest, DomainOpAppendRequest, DomainSnapshotPutRequest, GroupStateEntry, OpBody, Ref, SignedOp,
};
use crate::pb::parvane::group::v2 as gpb;
use crate::pb::parvane::msg::v2 as mpb;

/// Домен сервера объекта запроса; `None` — запрос своему серверу (аккаунт,
/// устройства, свой инбокс и прочее, чего у чужого сервера нет).
pub fn dest_of(r: &OutRequest) -> Option<String> {
    if let Some(d) = &r.dest {
        return Some(d.to_ascii_lowercase());
    }
    let d = match r.method {
        "msg.deliver_sealed" => {
            let q = mpb::DeliverSealedRequest::decode(r.body.as_slice()).ok()?;
            recipient_domain(q.envelopes.first()?.recipient.as_ref()?.address.as_str())
        }
        "call.signal_sealed" => {
            let q = cpb::SignalSealedRequest::decode(r.body.as_slice()).ok()?;
            recipient_domain(q.envelopes.first()?.recipient.as_ref()?.address.as_str())
        }
        "call.ring_sealed" => {
            let q = cpb::RingSealedRequest::decode(r.body.as_slice()).ok()?;
            recipient_domain(q.envelopes.first()?.recipient.as_ref()?.address.as_str())
        }
        "msg.deliver_group" => ref_domain(mpb::DeliverGroupRequest::decode(r.body.as_slice()).ok()?.envelope?.group.as_ref()),
        "group.state.append" => entry_domain(gpb::StateAppendRequest::decode(r.body.as_slice()).ok()?.entry.as_ref()),
        "group.join" => entry_domain(gpb::JoinRequest::decode(r.body.as_slice()).ok()?.entry.as_ref()),
        // «Печатает» группы (R14): проверяет gateway дома группы и рассылает серверам участников.
        "ephemeral.group_typing" => ref_domain(mpb::EphemeralGroupTypingRequest::decode(r.body.as_slice()).ok()?.group.as_ref()),
        "group.request.decide" => ref_domain(gpb::RequestDecideRequest::decode(r.body.as_slice()).ok()?.group.as_ref()),
        "domain.op.append" => ref_domain(DomainOpAppendRequest::decode(r.body.as_slice()).ok()?.op?.container.as_ref()),
        "domain.snapshot.put" => ref_domain(DomainSnapshotPutRequest::decode(r.body.as_slice()).ok()?.snapshot?.container.as_ref()),
        "domain.grant.leave" => op_target(DomainGrantLeaveRequest::decode(r.body.as_slice()).ok()?.leave.as_ref()),
        "domain.grant.set" => op_target(DomainGrantSetRequest::decode(r.body.as_slice()).ok()?.grant.as_ref()),
        "domain.grant.revoke" => op_target(DomainGrantRevokeRequest::decode(r.body.as_slice()).ok()?.grant.as_ref()),
        "domain.key.rotate" => op_target(DomainKeyRotateRequest::decode(r.body.as_slice()).ok()?.rotate.as_ref()),
        "domain.container.create" => op_target(DomainContainerCreateRequest::decode(r.body.as_slice()).ok()?.genesis.as_ref()),
        _ => None,
    }?;
    Some(d.to_ascii_lowercase())
}

fn recipient_domain(addr: &str) -> Option<String> {
    crate::address::address_domain(addr).map(str::to_string)
}

fn ref_domain(r: Option<&Ref>) -> Option<String> {
    r.map(|r| r.domain.clone()).filter(|d| crate::address::is_valid_domain(d))
}

fn entry_domain(e: Option<&GroupStateEntry>) -> Option<String> {
    ref_domain(e?.group.as_ref())
}

fn op_target(op: Option<&SignedOp>) -> Option<String> {
    let body = OpBody::decode(op?.body.as_slice()).ok()?;
    ref_domain(body.header?.target.as_ref())
}
