//! Разбор недоверенного кадра (обе стороны) и тела запроса по реестру: без паник.
#![no_main]
use libfuzzer_sys::fuzz_target;
use parvane_protocol::codec;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::frame::Kind;

fuzz_target!(|data: &[u8]| {
    for origin in [Origin::Client, Origin::Server] {
        if let Ok(f) = codec::decode_frame(data, origin) {
            if let Some(Kind::Request(r)) = f.kind {
                let _ = codec::check_request(&r, origin);
            }
        }
    }
    let mut d = codec::TcpDecoder::new();
    if d.push(data).is_ok() {
        while let Ok(Some(_)) = d.next_frame() {}
    }
});
