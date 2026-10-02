//! Разбор v1-истории из недоверенных байт: без паник.
#![no_main]
use libfuzzer_sys::fuzz_target;
use parvane_protocol::legacy_v1;

fuzz_target!(|data: &[u8]| {
    let _ = legacy_v1::parse_stored(data);
    let _ = legacy_v1::parse_olm_plaintext(data);
    let _ = legacy_v1::parse_megolm_plaintext(data);
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = legacy_v1::normalize_ice(s);
    }
});
