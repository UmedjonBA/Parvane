//! Вскрытие sealed-конверта и групповой AEAD из недоверенных байт: без паник.
#![no_main]
use libfuzzer_sys::fuzz_target;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{DeviceRef, GroupEnvelope, SealedEnvelope};
use parvane_protocol::{group, seal};

fuzz_target!(|data: &[u8]| {
    let me = DeviceRef { address: "bob@x".into(), device_id: "d1".into() };
    if let Ok(env) = decode_checked::<SealedEnvelope>(data, Origin::Client) {
        let _ = seal::open(&env, &me, &[7u8; 32]);
    }
    if let Ok(env) = decode_checked::<GroupEnvelope>(data, Origin::Client) {
        let _ = group::verify_envelope(&env, env.epoch, &[9u8; 32]);
        let _ = group::open_envelope(&env, &[1u8; 32]);
    }
});
