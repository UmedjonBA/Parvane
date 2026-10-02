//! `parvane-protocol` — единственная реализация протокола Parvane v2 для
//! сервера и всех клиентов (web — WASM, desktop/android — C ABI).
//!
//! Недоверенные байты разбираются только здесь: без паник (clippy deny),
//! лимиты схемы проверяются до разбора, подписи — над присланными байтами.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod access;
pub mod address;
pub mod client;
pub mod codec;
pub mod conformance;
pub mod content_guard;
pub mod domain;
pub mod ephemeral;
pub mod error;
pub mod federation;
pub mod group;
pub mod host;
pub mod identity;
pub mod invite;
pub mod l2;
pub mod legacy_v1;
pub mod limits;
pub mod msg;
pub mod olm;
pub mod policy;
pub mod recovery;
pub mod registry_gen;
pub mod schema;
pub mod seal;
pub mod sign;
pub mod state;
pub mod sync;
pub mod time;
pub mod tokens;
pub mod unknown;

pub use error::{ProtoError, Result};

/// Сгенерированные из `proto/parvane/**` типы (prost + proto3-JSON pbjson).
#[allow(clippy::all, clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]
pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/_pb.rs"));
}

/// Мажорная версия протокола этой схемы.
pub const PROTO_MAJOR: u32 = 2;
/// Минорная версия (добавление полей/видов).
pub const PROTO_MINOR: u32 = 0;

/// Версия движка (для обвязок).
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
