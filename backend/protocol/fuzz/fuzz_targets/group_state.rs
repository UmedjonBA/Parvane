//! Применение недоверенной записи журнала группы: без паник.
#![no_main]
use libfuzzer_sys::fuzz_target;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::group::{self, SignerInfo};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::GroupStateEntry;

fuzz_target!(|data: &[u8]| {
    if let Ok(e) = decode_checked::<GroupStateEntry>(data, Origin::Client) {
        let resolve = |_: &[u8; 32]| Some(SignerInfo { user: "alice@x".into(), root_key: [1; 32] });
        let _ = group::apply(None, &e, &resolve);
    }
});
