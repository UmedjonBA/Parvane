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
mod conformance_state2;
pub mod content_guard;
pub mod domain;
pub mod ephemeral;
pub mod error;
pub mod federation;
pub mod group;
pub mod history;
/// Разбор свободного ввода «Здоровья» (spec 038).
pub mod health_parse;
pub mod modules;
pub mod health_import;
pub mod music_mix;
pub mod music_queue;
pub mod sqlite_read;
pub mod music_tags;
/// Списки библиотеки «Музыки» на экранах (spec 041): порядок, буквы, отбор, страницы, «Загруженное».
pub mod music_library;
/// Сверка ключей звонка словами (CALL-3, spec 041).
pub mod call_sas;
/// Раскладка графа заметок и холста из графа (spec 040).
pub mod notes_graph;
/// Сведение текста заметки с двух устройств (spec 040 T9).
pub mod notes_canvas_merge;
pub mod notes_merge;
/// Подсказки «Плана» без состояния: свободное время, расписание текстом, поиск, тренировки (spec 041 E1).
pub mod planner_tools;
pub mod hold;
pub mod host;
pub mod identity;
pub mod invite;
pub mod l2;
pub mod limits;
pub mod link;
pub mod msg;
pub mod olm;
pub mod policy;
pub mod recovery;
pub mod recovery_tg;
pub mod registry_gen;
pub mod report;
// Жалобы: кому уходит и список у админа группы (REPORT-2, spec 041)
pub mod report_inbox;
pub mod routing;
pub mod schema;
pub mod seal;
pub mod sign;
pub mod state;
pub mod state2;
pub mod sync;
pub mod time;
pub mod tokens;
pub mod unknown;
pub mod model;
pub mod store;
#[cfg(feature = "future-schema")]
pub mod sample_future;

pub use error::{ProtoError, Result};

/// Сгенерированные из `proto/parvane/**` типы (prost + proto3-JSON pbjson).
#[allow(clippy::all, clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]
pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/_pb.rs"));
}

/// Кодек proto3-JSON ⇄ байты по полному имени типа для КАЖДОГО сообщения схемы (spec 035, FR-050):
/// порождается build.rs; `host::encode_message`/`decode_message`, WASM `encodeMessage`/`decodeMessage`
/// и C ABI `pv_encode_message`/`pv_decode_message` — тонкие вызовы.
#[allow(clippy::all)]
pub mod type_codec {
    include!(concat!(env!("OUT_DIR"), "/type_codec.rs"));
}

/// Типы границы движка для клиентов (spec 035 T022, contracts/codegen.md): TS / C++ / Kotlin из
/// `proto/parvane/engine/v1/**`, порождаются build.rs. Пишет и сверяет `gen_bindings [--check]`.
pub mod bindings {
    include!(concat!(env!("OUT_DIR"), "/bindings_gen.rs"));

    /// Корень репозитория (от `backend/protocol`).
    pub fn repo_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// Устаревшие файлы (нет на диске или отличаются от сгенерированного) — пути от корня.
    pub fn stale(root: &std::path::Path) -> Vec<&'static str> {
        FILES.iter().filter(|(p, text)| std::fs::read_to_string(root.join(p)).ok().as_deref() != Some(*text)).map(|(p, _)| *p).collect()
    }

    /// Записать все выходы.
    pub fn write_all(root: &std::path::Path) -> std::io::Result<()> {
        for (p, text) in FILES {
            let path = root.join(p);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(path, text)?;
        }
        Ok(())
    }
}

/// Мажорная версия протокола этой схемы.
pub const PROTO_MAJOR: u32 = 2;
/// Минорная версия выпуска (spec 035: поднята до `PROTO_MINOR_035`; gateway и federation отказывают ниже).
pub const PROTO_MINOR: u32 = limits::PROTO_MINOR_035;

/// API модели движка (contracts/versioning.md): MAJOR — несовместимая смена модели/вызовов; хост
/// проверяет MAJOR при загрузке движка.
pub const ENGINE_API: &str = "1.0.0";

/// Версия движка (для обвязок).
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// `engineInfo()` — пять осей версий движка этой сборки (spec 035, FR-045/FR-046, contracts/versioning.md).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine_api: &'static str,
    pub proto_major: u32,
    pub proto_minor: u32,
    pub min_supported_minor: u32,
    pub features: Vec<&'static str>,
    pub storage_formats: std::collections::BTreeMap<&'static str, u32>,
    pub critical_ranges: std::collections::BTreeMap<&'static str, [u32; 2]>,
    pub source_hash: &'static str,
    pub schema_hash: &'static str,
    pub build_id: &'static str,
    pub target: &'static str,
}

/// `engineInfo()` этой сборки.
pub fn engine_info() -> EngineInfo {
    use schema::build_info;
    EngineInfo {
        engine_api: ENGINE_API,
        proto_major: PROTO_MAJOR,
        proto_minor: PROTO_MINOR,
        min_supported_minor: limits::PROTO_MINOR_035,
        features: model::features::KNOWN.to_vec(),
        storage_formats: model::store_kinds::KINDS.iter().copied().collect(),
        critical_ranges: [("default", [1000, 1999])].into_iter().collect(),
        source_hash: build_info::SOURCE_HASH,
        schema_hash: build_info::SCHEMA_HASH,
        build_id: build_info::BUILD_ID,
        target: build_info::BUILD_TARGET,
    }
}

/// `engineInfo()` в JSON (так её отдают обвязки и `<шард> --engine-info`).
pub fn engine_info_json() -> String {
    serde_json::to_string(&engine_info()).unwrap_or_else(|_| "{}".to_string())
}
