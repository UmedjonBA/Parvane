//! Генерация движка из схемы `proto/parvane/**` (единственный источник истины):
//!
//! 1. Rust-типы (prost) и proto3-JSON (pbjson) — `OUT_DIR/_pb.rs`.
//! 2. Линтер схемы (T012): у каждого string/bytes есть `(max_len)`, у каждого
//!    repeated — `(max_items)`, map-полей нет, лимиты не мягче v1. Нарушение —
//!    ошибка сборки.
//! 3. Таблица схемы для проверки недоверенных байт ДО разбора
//!    (`OUT_DIR/schema_table.rs`, используется `limits.rs`) и реестр методов
//!    (`METHODS`) с проверкой правил реестра.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use prost_reflect::{DescriptorPool, DynamicMessage, Kind, Value};

/// Кадр целиком — потолок любого лимита.
const FRAME_MAX: u32 = 4_194_304;

/// Лимиты «не мягче v1» (FR-023, класс 12): поле → максимум, который схема не
/// вправе превысить. Проверяются, если поле есть в схеме.
const CEILINGS_LEN: &[(&str, u32)] = &[
    ("parvane.core.v2.Request.body", FRAME_MAX),
    ("parvane.core.v2.Response.ok", FRAME_MAX),
    ("parvane.core.v2.Event.body", FRAME_MAX),
    ("parvane.core.v2.StreamChunk.data", 716_800),
    ("parvane.cloud.v1.UploadChunkRequest.data", 716_800),
    ("parvane.core.v2.OpBody.payload", 262_144),
    ("parvane.call.v2.Offer.sdp", 65_536),
    ("parvane.call.v2.Answer.sdp", 65_536),
    ("parvane.call.v2.IceCandidate.candidate", 4_096),
];
const CEILINGS_ITEMS: &[(&str, u32)] = &[
    ("parvane.msg.v2.DeliverSealedRequest.envelopes", 64),
    ("parvane.call.v2.SignalSealedRequest.envelopes", 64),
    ("parvane.core.v2.OpHeader.audience", 64),
    ("parvane.identity.v2.TokensIssueBlindedRequest.blinded", 50),
];

/// spec 035 (FR-041, contracts/versioning.md): oneof журналов и содержимого, чьи виды делятся по
/// номеру — 1–999 обычные, 1000–1999 критичные. Известный вид вне диапазона — ошибка сборки; критичных
/// известных видов в выпуске нет (диапазон зарезервирован), кроме тестового пакета `SAMPLE_PACKAGE`.
const COVERED_KIND_ONEOFS: &[&str] = &[
    "parvane.msg.v2.Content.kind",
    "parvane.msg.v2.InboxRecord.item",
    "parvane.history.v1.HistoryOp.op",
    "parvane.planner.v1.Change.change",
    "parvane.cloud.v1.CloudOp.op",
    "parvane.group.v2.GroupChange.change",
    "parvane.state.v1.StateOp.op",
];
/// Схема «движка будущего» (T025): виды ≥ 1000 разрешены только здесь.
const SAMPLE_PACKAGE: &str = "parvane.sample.v1";
const NORMAL_KINDS: std::ops::RangeInclusive<u32> = 1..=999;
const CRITICAL_KINDS: std::ops::RangeInclusive<u32> = 1000..=1999;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let proto_root = manifest.join("../../proto");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));

    let mut files = Vec::new();
    collect_protos(&proto_root.join("parvane"), &mut files);
    files.sort();
    println!("cargo:rerun-if-changed={}", proto_root.display());
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
    }
    // spec 035 (contracts/versioning.md): хеши сборки — по исходникам движка и обвязок.
    for d in ["src", "wasm/src", "ffi/src", "build.rs", "Cargo.toml"] {
        println!("cargo:rerun-if-changed={}", manifest.join(d).display());
    }
    println!("cargo:rerun-if-env-changed=PARVANE_BUILD_ID");

    let descriptor_path = out.join("descriptor.bin");
    let mut cfg = prost_build::Config::new();
    cfg.file_descriptor_set_path(&descriptor_path);
    cfg.enable_type_names();
    cfg.compile_protos(&files, &[&proto_root]).expect("protoc: схема не собирается");

    let descriptor = std::fs::read(&descriptor_path).expect("descriptor.bin");
    pbjson_build::Builder::new()
        .register_descriptors(&descriptor)
        .expect("pbjson: дескрипторы")
        .preserve_proto_field_names()
        .build(&[".parvane"])
        .expect("pbjson: генерация");

    let pool = DescriptorPool::decode(descriptor.as_slice()).expect("prost-reflect: дескрипторы");
    let mut errors = Vec::new();
    let table = build_schema_table(&pool, &mut errors);
    let mut codec = Vec::new();
    let methods = build_methods(&pool, &table.index, &mut errors, &mut codec);
    if !errors.is_empty() {
        for e in &errors {
            println!("cargo:warning=схема: {e}");
        }
        panic!("линтер схемы proto/parvane: {} ошибок:\n{}", errors.len(), errors.join("\n"));
    }

    let kinds = build_kind_oneofs(&pool, &mut errors);
    let bindings = build_bindings(&pool, &mut errors);
    if !errors.is_empty() {
        panic!("линтер схемы proto/parvane: {} ошибок:\n{}", errors.len(), errors.join("\n"));
    }
    std::fs::write(out.join("schema_table.rs"), format!("{}\n{}\n{}", table.code, methods, kinds))
        .expect("schema_table.rs");
    std::fs::write(out.join("type_codec.rs"), build_type_codec(&pool)).expect("type_codec.rs");
    std::fs::write(out.join("build_info.rs"), build_info(&manifest)).expect("build_info.rs");
    std::fs::write(out.join("bindings_gen.rs"), bindings).expect("bindings_gen.rs");
    std::fs::write(out.join("method_codec.rs"), build_method_codec(&codec)).expect("method_codec.rs");
    std::fs::write(out.join("_pb.rs"), module_tree(&pool, &out)).expect("_pb.rs");
}

fn collect_protos(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n == "vectors") {
                continue;
            }
            collect_protos(&p, out);
        } else if p.extension().is_some_and(|x| x == "proto") {
            out.push(p);
        }
    }
}

/// Дерево модулей `pb::parvane::<domain>::<ver>` с prost- и pbjson-кодом.
fn module_tree(pool: &DescriptorPool, out: &Path) -> String {
    let mut pkgs: Vec<String> = pool
        .files()
        .map(|f| f.package_name().to_string())
        .filter(|p| p.starts_with("parvane."))
        .collect();
    pkgs.sort();
    pkgs.dedup();
    // parvane -> domain -> ver
    let mut tree: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for p in &pkgs {
        let parts: Vec<&str> = p.split('.').collect();
        assert!(parts.len() == 3, "пакет должен быть parvane.<домен>.<версия>: {p}");
        tree.entry(parts[1].to_string()).or_default().insert(parts[2].to_string(), p.clone());
    }
    let mut s = String::from("pub mod parvane {\n");
    for (domain, vers) in tree {
        let _ = writeln!(s, "  pub mod {domain} {{");
        for (ver, pkg) in vers {
            let _ = writeln!(s, "    pub mod {ver} {{");
            let prost = out.join(format!("{pkg}.rs"));
            if prost.exists() {
                let _ = writeln!(s, "      include!(concat!(env!(\"OUT_DIR\"), \"/{pkg}.rs\"));");
            }
            let serde = out.join(format!("{pkg}.serde.rs"));
            if serde.exists() {
                let _ = writeln!(s, "      include!(concat!(env!(\"OUT_DIR\"), \"/{pkg}.serde.rs\"));");
            }
            s.push_str("    }\n");
        }
        s.push_str("  }\n");
    }
    s.push_str("}\n");
    s
}

struct Table {
    code: String,
    index: HashMap<String, usize>,
}

fn ext_u32(pool: &DescriptorPool, opts: &DynamicMessage, name: &str) -> Option<u32> {
    let ext = pool.get_extension_by_name(name)?;
    if !opts.has_extension(&ext) {
        return None;
    }
    match opts.get_extension(&ext).as_ref() {
        Value::U32(v) => Some(*v),
        _ => None,
    }
}

fn ext_enum(pool: &DescriptorPool, opts: &DynamicMessage, name: &str) -> Option<i32> {
    let ext = pool.get_extension_by_name(name)?;
    if !opts.has_extension(&ext) {
        return None;
    }
    match opts.get_extension(&ext).as_ref() {
        Value::EnumNumber(v) => Some(*v),
        _ => None,
    }
}

fn build_schema_table(pool: &DescriptorPool, errors: &mut Vec<String>) -> Table {
    let mut msgs: Vec<_> = pool.all_messages().filter(|m| m.full_name().starts_with("parvane.")).collect();
    msgs.sort_by(|a, b| a.full_name().cmp(b.full_name()));
    let index: HashMap<String, usize> =
        msgs.iter().enumerate().map(|(i, m)| (m.full_name().to_string(), i)).collect();

    let ceil_len: HashMap<&str, u32> = CEILINGS_LEN.iter().copied().collect();
    let ceil_items: HashMap<&str, u32> = CEILINGS_ITEMS.iter().copied().collect();

    let mut code = String::new();
    code.push_str("/// Сгенерировано build.rs из proto/parvane/**. Сообщения — по имени.\n");
    let _ = writeln!(code, "pub static MESSAGES: &[MsgSpec] = &[");
    for m in &msgs {
        let mut fields: Vec<_> = m.fields().collect();
        fields.sort_by_key(|f| f.number());
        let _ = writeln!(code, "  MsgSpec {{ name: {:?}, fields: &[", m.full_name());
        for f in fields {
            let fname = f.full_name().to_string();
            if f.is_map() {
                errors.push(format!("{fname}: map-поля запрещены (нет лимитов)"));
                continue;
            }
            let opts = f.options();
            let max_len = ext_u32(pool, &opts, "parvane.core.v2.max_len").unwrap_or(0);
            let max_items = ext_u32(pool, &opts, "parvane.core.v2.max_items").unwrap_or(0);
            let actor = ext_enum(pool, &opts, "parvane.core.v2.actor").unwrap_or(0);
            let ty = match f.kind() {
                Kind::String => "FieldTy::Str".to_string(),
                Kind::Bytes => "FieldTy::Bytes".to_string(),
                Kind::Message(md) => match index.get(md.full_name()) {
                    Some(i) => format!("FieldTy::Message({i})"),
                    None => {
                        errors.push(format!("{fname}: тип {} вне схемы parvane", md.full_name()));
                        continue;
                    }
                },
                Kind::Double | Kind::Fixed64 | Kind::Sfixed64 => "FieldTy::Fixed64".to_string(),
                Kind::Float | Kind::Fixed32 | Kind::Sfixed32 => "FieldTy::Fixed32".to_string(),
                _ => "FieldTy::Varint".to_string(),
            };
            let enum_values = match f.kind() {
                Kind::Enum(ed) => {
                    let mut v: Vec<i32> = ed.values().map(|x| x.number()).collect();
                    v.sort();
                    v.dedup();
                    format!("&{v:?}")
                }
                _ => "&[]".to_string(),
            };
            let is_lenbytes = matches!(f.kind(), Kind::String | Kind::Bytes);
            if is_lenbytes && max_len == 0 {
                errors.push(format!("{fname}: у string/bytes нет (max_len)"));
            }
            if !is_lenbytes && max_len != 0 {
                errors.push(format!("{fname}: (max_len) только для string/bytes"));
            }
            if f.is_list() && max_items == 0 {
                errors.push(format!("{fname}: у repeated нет (max_items)"));
            }
            if !f.is_list() && max_items != 0 {
                errors.push(format!("{fname}: (max_items) только для repeated"));
            }
            if max_len > FRAME_MAX {
                errors.push(format!("{fname}: max_len {max_len} больше кадра {FRAME_MAX}"));
            }
            if let Some(c) = ceil_len.get(fname.as_str()) {
                if max_len > *c {
                    errors.push(format!("{fname}: max_len {max_len} мягче v1 ({c})"));
                }
            }
            if let Some(c) = ceil_items.get(fname.as_str()) {
                if max_items > *c {
                    errors.push(format!("{fname}: max_items {max_items} мягче v1 ({c})"));
                }
            }
            let _ = writeln!(
                code,
                "    FieldSpec {{ number: {}, name: {:?}, ty: {ty}, repeated: {}, max_len: {max_len}, max_items: {max_items}, server_set: {}, enum_values: {enum_values} }},",
                f.number(),
                f.name(),
                f.is_list(),
                actor == 2
            );
        }
        let _ = write!(code, "  ], oneofs: &[");
        for o in m.oneofs().filter(|o| !o.is_synthetic()) {
            let mut members: Vec<u32> = o.fields().map(|f| f.number()).collect();
            members.sort();
            let covered = COVERED_KIND_ONEOFS.contains(&format!("{}.{}", m.full_name(), o.name()).as_str())
                || m.package_name() == SAMPLE_PACKAGE;
            let _ = write!(code, "OneofSpec {{ name: {:?}, members: &{members:?}, kinds: {covered} }}, ", o.name());
        }
        let _ = writeln!(code, "] }},");
    }
    code.push_str("];\n");
    Table { code, index }
}

fn valid_method_name(n: &str) -> bool {
    (3..=96).contains(&n.len())
        && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
        && !n.starts_with('.')
        && !n.ends_with('.')
        && !n.contains("..")
}

fn build_methods(pool: &DescriptorPool, index: &HashMap<String, usize>, errors: &mut Vec<String>, codec: &mut Vec<(String, String, String)>) -> String {
    let Some(ext) = pool.get_extension_by_name("parvane.core.v2.method") else {
        errors.push("нет расширения parvane.core.v2.method".into());
        return String::new();
    };
    let mut rows: Vec<(String, String)> = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut subjects: HashMap<String, String> = HashMap::new();
    for svc in pool.services() {
        if !svc.full_name().starts_with("parvane.") {
            continue;
        }
        for m in svc.methods() {
            let full = m.full_name().to_string();
            let opts = m.options();
            if !opts.has_extension(&ext) {
                errors.push(format!("{full}: нет опции (method)"));
                continue;
            }
            let spec = match opts.get_extension(&ext).as_ref() {
                Value::Message(d) => d.clone(),
                _ => {
                    errors.push(format!("{full}: опция method не сообщение"));
                    continue;
                }
            };
            let get_str = |n: &str| match spec.get_field_by_name(n).as_deref() {
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            let get_enum = |n: &str| match spec.get_field_by_name(n).as_deref() {
                Some(Value::EnumNumber(v)) => *v,
                _ => 0,
            };
            let get_bool = |n: &str| matches!(spec.get_field_by_name(n).as_deref(), Some(Value::Bool(true)));
            let name = get_str("name");
            let channel = get_enum("channel");
            let rate = get_enum("rate");
            let kind = get_enum("kind");
            let reauth = get_bool("reauth");
            let operator_only = get_bool("operator_only");
            let federated = get_bool("federated");
            let shard = get_str("shard");
            let mut subject = get_str("subject");
            if subject.is_empty() {
                subject = format!("v2.{name}");
            }
            if !valid_method_name(&name) {
                errors.push(format!("{full}: недопустимое имя метода {name:?}"));
            }
            if let Some(prev) = seen.insert(name.clone(), full.clone()) {
                errors.push(format!("{full}: имя {name} уже занято {prev}"));
            }
            if let Some(prev) = subjects.insert(subject.clone(), full.clone()) {
                errors.push(format!("{full}: subject {subject} уже занят {prev}"));
            }
            if channel == 0 || rate == 0 || kind == 0 {
                errors.push(format!("{full}: не заданы channel/rate/kind"));
            }
            if shard.is_empty() {
                errors.push(format!("{full}: не задан shard"));
            }
            // ANON: только класс ANON, без reauth и операторских прав.
            if channel == 3 && (rate != 4 || reauth || operator_only) {
                errors.push(format!("{full}: метод канала ANON — только rate ANON, без reauth"));
            }
            // Федерация (spec 028): пересылается чужому серверу только обычный запрос пользователя.
            if federated && (reauth || operator_only || kind == 2) {
                errors.push(format!("{full}: federated несовместим с reauth/operator_only/SUBSCRIBE"));
            }
            if federated && channel == 1 && name != "server.describe" {
                errors.push(format!("{full}: из канала PRE пересылается только server.describe"));
            }
            if channel == 1 && rate != 5 {
                errors.push(format!("{full}: метод канала PRE — только rate PRE"));
            }
            if channel != 1 && rate == 5 {
                errors.push(format!("{full}: rate PRE только для канала PRE"));
            }
            if channel != 3 && rate == 4 {
                errors.push(format!("{full}: rate ANON только для канала ANON"));
            }
            let req = index.get(m.input().full_name());
            let resp = index.get(m.output().full_name());
            let (Some(req), Some(resp)) = (req, resp) else {
                errors.push(format!("{full}: тип запроса/ответа вне схемы"));
                continue;
            };
            codec.push((name.clone(), m.input().full_name().to_string(), m.output().full_name().to_string()));
            rows.push((
                name.clone(),
                format!(
                    "  MethodInfo {{ name: {name:?}, channel: {channel}, reauth: {reauth}, rate: {rate}, kind: {kind}, shard: {shard:?}, subject: {subject:?}, operator_only: {operator_only}, federated: {federated}, request: {req}, response: {resp} }},"
                ),
            ));
        }
    }
    rows.sort();
    let mut s = String::from("/// Реестр методов (из опций rpc), отсортирован по имени.\npub static METHODS: &[MethodInfo] = &[\n");
    for (_, r) in rows {
        s.push_str(&r);
        s.push('\n');
    }
    s.push_str("];\n");
    s
}

/// Rust-путь типа по полному имени proto (`parvane.identity.v2.X` →
/// `crate::pb::parvane::identity::v2::X`). Запросы и ответы методов — типы
/// верхнего уровня, вложенных среди них нет.
fn rust_path(full: &str) -> String {
    format!("crate::pb::{}", full.replace('.', "::"))
}

/// Кодек методов реестра для хостов (T161): proto3-JSON запроса → байты и
/// байты ответа → proto3-JSON по имени метода, для КАЖДОГО метода реестра.
fn build_method_codec(codec: &[(String, String, String)]) -> String {
    let mut rows = codec.to_vec();
    rows.sort();
    let mut s = String::from(
        "/// proto3-JSON запроса метода → байты тела. `None` — метода нет в реестре.\n\
         pub fn encode_request(method: &str, json: &str) -> Option<crate::error::Result<Vec<u8>>> {\n\
         \x20   use prost::Message as _;\n\
         \x20   Some(match method {\n",
    );
    for (name, req, _) in &rows {
        s.push_str(&format!(
            "        {name:?} => serde_json::from_str::<{}>(json).map(|m| m.encode_to_vec()).map_err(|_| crate::error::ProtoError::Malformed),\n",
            rust_path(req)
        ));
    }
    s.push_str("        _ => return None,\n    })\n}\n\n");
    s.push_str(
        "/// Байты ответа метода (проверенные лимитами схемы) → proto3-JSON. `None` — метода нет в реестре.\n\
         pub fn decode_response(method: &str, bytes: &[u8]) -> Option<crate::error::Result<String>> {\n\
         \x20   use crate::codec::decode_checked;\n\
         \x20   use crate::limits::Origin;\n\
         \x20   Some(match method {\n",
    );
    for (name, _, resp) in &rows {
        s.push_str(&format!(
            "        {name:?} => decode_checked::<{}>(bytes, Origin::Server).and_then(|m| serde_json::to_string(&m).map_err(|_| crate::error::ProtoError::Malformed)),\n",
            rust_path(resp)
        ));
    }
    s.push_str("        _ => return None,\n    })\n}\n");
    s
}

/// Таблица oneof с видами по диапазонам + проверка диапазонов (T013, T018).
fn build_kind_oneofs(pool: &DescriptorPool, errors: &mut Vec<String>) -> String {
    let mut rows = Vec::new();
    let mut found = Vec::new();
    let mut msgs: Vec<_> = pool.all_messages().filter(|m| m.full_name().starts_with("parvane.")).collect();
    msgs.sort_by(|a, b| a.full_name().cmp(b.full_name()));
    for m in &msgs {
        for o in m.oneofs().filter(|o| !o.is_synthetic()) {
            let full = format!("{}.{}", m.full_name(), o.name());
            let sample = m.package_name() == SAMPLE_PACKAGE;
            if !sample && !COVERED_KIND_ONEOFS.contains(&full.as_str()) {
                continue;
            }
            found.push(full.clone());
            let mut members: Vec<u32> = o.fields().map(|f| f.number()).collect();
            members.sort();
            for n in &members {
                let ok = NORMAL_KINDS.contains(n) || (sample && CRITICAL_KINDS.contains(n));
                if !ok {
                    if CRITICAL_KINDS.contains(n) {
                        errors.push(format!(
                            "{full}: вид #{n} в критичном диапазоне 1000–1999 — в выпуске он зарезервирован (разрешён только {SAMPLE_PACKAGE})"
                        ));
                    } else {
                        errors.push(format!("{full}: вид #{n} вне диапазонов видов 1–999 / 1000–1999"));
                    }
                }
            }
            rows.push(format!("  KindOneof {{ message: {:?}, oneof: {:?}, members: &{members:?} }},", m.full_name(), o.name()));
        }
    }
    for c in COVERED_KIND_ONEOFS {
        if !found.iter().any(|f| f == c) {
            errors.push(format!("{c}: охваченный диапазонами oneof не найден в схеме"));
        }
    }
    format!(
        "/// spec 035: oneof, виды которых делятся по номеру (1–999 обычные, 1000–1999 критичные).\npub static KIND_ONEOFS: &[KindOneof] = &[\n{}\n];\n",
        rows.join("\n")
    )
}

/// Кодек по имени типа (spec 035, FR-050): proto3-JSON ⇄ байты для КАЖДОГО сообщения схемы.
fn build_type_codec(pool: &DescriptorPool) -> String {
    let mut msgs: Vec<_> = pool.all_messages().filter(|m| m.full_name().starts_with("parvane.")).collect();
    msgs.sort_by(|a, b| a.full_name().cmp(b.full_name()));
    let mut s = String::from(
        "// Сгенерировано build.rs по всем сообщениям proto/parvane/** (spec 035, FR-050).\n\n\
         fn enc<M: prost::Message + serde::de::DeserializeOwned>(json: &str) -> crate::error::Result<Vec<u8>> {\n\
         \x20   serde_json::from_str::<M>(json).map(|m| m.encode_to_vec()).map_err(|_| crate::error::ProtoError::Malformed)\n\
         }\n\n\
         fn dec<M: prost::Message + prost::Name + Default + serde::Serialize>(bytes: &[u8], origin: crate::limits::Origin) -> crate::error::Result<String> {\n\
         \x20   crate::codec::decode_checked::<M>(bytes, origin).and_then(|m| serde_json::to_string(&m).map_err(|_| crate::error::ProtoError::Malformed))\n\
         }\n\n\
         /// proto3-JSON → байты по полному имени типа. `None` — типа нет в схеме.\n\
         pub fn encode_by_type(type_name: &str, json: &str) -> Option<crate::error::Result<Vec<u8>>> {\n\
         \x20   Some(match type_name {\n",
    );
    for m in &msgs {
        s.push_str(&format!("        {:?} => enc::<{}>(json),\n", m.full_name(), message_rust_path(m)));
    }
    s.push_str("        _ => return None,\n    })\n}\n\n");
    s.push_str(
        "/// Байты (лимиты схемы проверяются до разбора, `decode_checked`) → proto3-JSON по полному имени типа.\n\
         /// `None` — типа нет в схеме.\n\
         pub fn decode_by_type(type_name: &str, bytes: &[u8], origin: crate::limits::Origin) -> Option<crate::error::Result<String>> {\n\
         \x20   Some(match type_name {\n",
    );
    for m in &msgs {
        s.push_str(&format!("        {:?} => dec::<{}>(bytes, origin),\n", m.full_name(), message_rust_path(m)));
    }
    s.push_str("        _ => return None,\n    })\n}\n");
    s
}

/// Rust-путь сообщения (вложенные — в модуле родителя в snake_case, как у prost).
fn message_rust_path(m: &prost_reflect::MessageDescriptor) -> String {
    use heck::{ToSnakeCase, ToUpperCamelCase};
    let mut chain = vec![m.name().to_upper_camel_case()];
    let mut cur = m.parent_message();
    while let Some(p) = cur {
        chain.push(p.name().to_snake_case());
        cur = p.parent_message();
    }
    chain.reverse();
    format!("crate::pb::{}::{}", m.package_name().replace('.', "::"), chain.join("::"))
}

fn hex_lower(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn walk_files(dir: &Path, ext: Option<&str>, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_files(&p, ext, out);
        } else if ext.is_none_or(|x| p.extension().is_some_and(|y| y == x)) {
            out.push(p);
        }
    }
}

/// SHA-256 отсортированного списка строк `путь\0sha256-hex\n` (пути — от корня репозитория).
fn tree_hash(repo: &Path, files: Vec<PathBuf>) -> String {
    use sha2::{Digest, Sha256};
    let mut rows: Vec<(String, String)> = files
        .into_iter()
        .map(|p| {
            let rel = p.strip_prefix(repo).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            let data = std::fs::read(&p).unwrap_or_default();
            (rel, hex_lower(&Sha256::digest(&data)))
        })
        .collect();
    rows.sort();
    let mut h = Sha256::new();
    for (p, d) in rows {
        h.update(p.as_bytes());
        h.update([0u8]);
        h.update(d.as_bytes());
        h.update(b"\n");
    }
    hex_lower(&h.finalize())
}

/// Ось «Сборка» `engineInfo()` (contracts/versioning.md): хеши схемы и исходников, id сборки, цель.
fn build_info(manifest: &Path) -> String {
    let repo = manifest.join("../..").canonicalize().unwrap_or_else(|_| manifest.join("../.."));
    let mut protos = Vec::new();
    walk_files(&repo.join("proto/parvane"), Some("proto"), &mut protos);
    let schema_hash = tree_hash(&repo, protos);
    let mut src = Vec::new();
    let p = repo.join("backend/protocol");
    for d in ["src", "wasm/src", "ffi/src"] {
        walk_files(&p.join(d), None, &mut src);
    }
    src.push(p.join("build.rs"));
    src.push(p.join("Cargo.toml"));
    let source_hash = tree_hash(&repo, src);
    let target = std::env::var("TARGET").unwrap_or_default();
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    let build_id = std::env::var("PARVANE_BUILD_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{version}+{}.{profile}", &source_hash[..12]));
    format!(
        "pub const SCHEMA_HASH: &str = {schema_hash:?};\npub const SOURCE_HASH: &str = {source_hash:?};\npub const BUILD_ID: &str = {build_id:?};\npub const BUILD_TARGET: &str = {target:?};\n"
    )
}

// ── spec 035 T022 (FR-051, FR-052, contracts/codegen.md): типы границы движка для клиентов ─────────────

/// Пакеты модели движка: из них (и сообщений, которые они встраивают) генерируются TS/C++/Kotlin.
const BINDINGS_PACKAGES: &[&str] = &["parvane.engine.v1"];
const BINDINGS_TS: &str = "web/telegram-tt/src/api/parvane/v2/gen/model.ts";
const BINDINGS_H: &str = "desktop/parvane-core/include/parvane/gen/model.h";
const BINDINGS_CPP: &str = "desktop/parvane-core/src/gen/model.cpp";
const BINDINGS_KT: &str = "android/libtd/src/main/java/org/parvane/gen/Model.kt";

#[derive(Clone)]
enum BTy {
    Str,
    Bytes,
    Bool,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
    Enum(String),
    Msg(String),
}

struct BField {
    proto: String,
    camel: String,
    ty: BTy,
    repeated: bool,
}

struct BOneof {
    proto: String,
    camel: String,
    members: Vec<BField>,
}

struct BMsg {
    name: String,
    fields: Vec<BField>,
    oneofs: Vec<BOneof>,
}

struct BEnum {
    name: String,
    values: Vec<(String, i32)>,
}

fn upper_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn bty(f: &prost_reflect::FieldDescriptor) -> BTy {
    match f.kind() {
        Kind::String => BTy::Str,
        Kind::Bytes => BTy::Bytes,
        Kind::Bool => BTy::Bool,
        Kind::Int32 | Kind::Sint32 | Kind::Sfixed32 => BTy::I32,
        Kind::Uint32 | Kind::Fixed32 => BTy::U32,
        Kind::Int64 | Kind::Sint64 | Kind::Sfixed64 => BTy::I64,
        Kind::Uint64 | Kind::Fixed64 => BTy::U64,
        Kind::Float => BTy::F32,
        Kind::Double => BTy::F64,
        Kind::Enum(e) => BTy::Enum(e.name().to_string()),
        Kind::Message(m) => BTy::Msg(m.name().to_string()),
    }
}

/// Сообщения пакетов модели и всё, что они встраивают (по имени), плюс enum'ы.
fn bindings_model(pool: &DescriptorPool, errors: &mut Vec<String>) -> (Vec<BMsg>, Vec<BEnum>) {
    use heck::ToLowerCamelCase;
    let mut todo: Vec<prost_reflect::MessageDescriptor> =
        pool.all_messages().filter(|m| BINDINGS_PACKAGES.contains(&m.package_name())).collect();
    todo.sort_by(|a, b| a.full_name().cmp(b.full_name()));
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    let mut enums: BTreeMap<String, BEnum> = BTreeMap::new();
    let mut msgs = Vec::new();
    let mut i = 0;
    while i < todo.len() {
        let m = todo[i].clone();
        i += 1;
        if let Some(prev) = seen.get(m.name()) {
            if prev != m.full_name() {
                errors.push(format!("gen_bindings: имя {} у {} и {prev}", m.name(), m.full_name()));
            }
            continue;
        }
        seen.insert(m.name().to_string(), m.full_name().to_string());
        let mut fields = Vec::new();
        let mut oneofs: Vec<BOneof> = Vec::new();
        let mut fs: Vec<_> = m.fields().collect();
        fs.sort_by_key(|f| f.number());
        for f in fs {
            if let Kind::Message(sub) = f.kind() {
                if !todo.iter().any(|t| t.full_name() == sub.full_name()) {
                    todo.push(sub.clone());
                }
            }
            if let Kind::Enum(e) = f.kind() {
                enums.entry(e.name().to_string()).or_insert_with(|| BEnum {
                    name: e.name().to_string(),
                    values: e.values().map(|v| (v.name().to_string(), v.number())).collect(),
                });
            }
            let bf = BField { proto: f.name().to_string(), camel: f.name().to_lower_camel_case(), ty: bty(&f), repeated: f.is_list() };
            match f.containing_oneof().filter(|o| !o.is_synthetic()) {
                Some(o) => {
                    if let Some(x) = oneofs.iter_mut().find(|x| x.proto == o.name()) {
                        x.members.push(bf);
                    } else {
                        oneofs.push(BOneof { proto: o.name().to_string(), camel: o.name().to_lower_camel_case(), members: vec![bf] });
                    }
                }
                None => fields.push(bf),
            }
        }
        msgs.push(BMsg { name: m.name().to_string(), fields, oneofs });
    }
    msgs.sort_by(|a, b| a.name.cmp(&b.name));
    (msgs, enums.into_values().collect())
}

const GEN_NOTE: &str = "Сгенерировано gen_bindings (cargo run -p parvane-protocol --bin gen_bindings) из proto/parvane/engine/v1/** — не править руками; проверка — gen_bindings --check (тест bindings_are_fresh).";

fn ts_ty(t: &BTy) -> String {
    match t {
        BTy::Str | BTy::I64 | BTy::U64 => "string".into(),
        BTy::Bytes => "Uint8Array".into(),
        BTy::Bool => "boolean".into(),
        BTy::I32 | BTy::U32 | BTy::F32 | BTy::F64 => "number".into(),
        BTy::Enum(n) | BTy::Msg(n) => n.clone(),
    }
}

fn ts_default(t: &BTy) -> String {
    match t {
        BTy::Str | BTy::I64 | BTy::U64 => "''".into(),
        BTy::Bytes => "new Uint8Array(0)".into(),
        BTy::Bool => "false".into(),
        BTy::I32 | BTy::U32 | BTy::F32 | BTy::F64 => "0".into(),
        BTy::Enum(n) => format!("{n}Values[0]"),
        BTy::Msg(_) => "undefined".into(),
    }
}

fn ts_from(t: &BTy, v: &str) -> String {
    match t {
        BTy::Str => format!("String({v})"),
        BTy::I64 | BTy::U64 => format!("String({v})"),
        BTy::Bytes => format!("fromBase64(String({v}))"),
        BTy::Bool => format!("Boolean({v})"),
        BTy::I32 | BTy::U32 | BTy::F32 | BTy::F64 => format!("Number({v})"),
        BTy::Enum(n) => format!("{}FromJson({v})", lower_first(n)),
        BTy::Msg(n) => format!("{}FromJson({v})", lower_first(n)),
    }
}

fn ts_to(t: &BTy, v: &str) -> String {
    match t {
        BTy::Bytes => format!("toBase64({v})"),
        BTy::Msg(n) => format!("{}ToJson({v})", lower_first(n)),
        _ => v.to_string(),
    }
}

fn ts_is_default(t: &BTy, v: &str) -> String {
    match t {
        BTy::Str => format!("{v} === ''"),
        BTy::I64 | BTy::U64 => format!("({v} === '' || {v} === '0')"),
        BTy::Bytes => format!("{v}.length === 0"),
        BTy::Bool => format!("!{v}"),
        BTy::I32 | BTy::U32 | BTy::F32 | BTy::F64 => format!("{v} === 0"),
        BTy::Enum(n) => format!("{v} === {n}Values[0]"),
        BTy::Msg(_) => format!("{v} === undefined"),
    }
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn gen_ts(msgs: &[BMsg], enums: &[BEnum]) -> String {
    let mut s = format!("// {GEN_NOTE}\n// Граница движка — proto3-JSON (имена полей схемы; int64 — строка, bytes — base64, enum — имя).\n/* eslint-disable */\n\n");
    s.push_str(
        "const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\n\n\
         export function toBase64(b: Uint8Array): string {\n  let out = '';\n  for (let i = 0; i < b.length; i += 3) {\n    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);\n    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];\n    out += i + 1 < b.length ? B64[(n >> 6) & 63] : '=';\n    out += i + 2 < b.length ? B64[n & 63] : '=';\n  }\n  return out;\n}\n\n\
         export function fromBase64(s: string): Uint8Array {\n  const clean = s.replace(/[\\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');\n  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));\n  let bits = 0;\n  let acc = 0;\n  let j = 0;\n  for (const ch of clean) {\n    const v = B64.indexOf(ch);\n    if (v < 0) throw new Error('base64');\n    acc = (acc << 6) | v;\n    bits += 6;\n    if (bits >= 8) {\n      bits -= 8;\n      out[j++] = (acc >> bits) & 0xff;\n    }\n  }\n  return out.subarray(0, j);\n}\n\n\
         function pick(j: Record<string, unknown>, proto: string, camel: string): unknown {\n  return j[proto] !== undefined ? j[proto] : j[camel];\n}\n\n",
    );
    for e in enums {
        let names: Vec<String> = e.values.iter().map(|(n, _)| format!("'{n}'")).collect();
        s.push_str(&format!("export const {}Values = [{}] as const;\nexport type {} = typeof {}Values[number];\n", e.name, names.join(", "), e.name, e.name));
        s.push_str(&format!(
            "export function {}FromJson(v: unknown): {} {{\n  const all = {}Values as readonly string[];\n  if (typeof v === 'string' && all.includes(v)) return v as {};\n  const n = Number(v);\n  const byNum: Record<number, {}> = {{ {} }};\n  return byNum[n] ?? {}Values[0];\n}}\n\n",
            lower_first(&e.name),
            e.name,
            e.name,
            e.name,
            e.name,
            e.values.iter().map(|(n, v)| format!("{v}: '{n}'")).collect::<Vec<_>>().join(", "),
            e.name
        ));
    }
    for m in msgs {
        s.push_str(&format!("export interface {} {{\n", m.name));
        for f in &m.fields {
            let t = ts_ty(&f.ty);
            if f.repeated {
                s.push_str(&format!("  {}: {}[];\n", f.camel, t));
            } else if matches!(f.ty, BTy::Msg(_)) {
                s.push_str(&format!("  {}?: {};\n", f.camel, t));
            } else {
                s.push_str(&format!("  {}: {};\n", f.camel, t));
            }
        }
        for o in &m.oneofs {
            let alts: Vec<String> = o.members.iter().map(|f| format!("{{ case: '{}'; value: {} }}", f.camel, ts_ty(&f.ty))).collect();
            s.push_str(&format!("  {}?: {};\n", o.camel, alts.join(" | ")));
        }
        s.push_str("}\n\n");
        let lf = lower_first(&m.name);
        s.push_str(&format!("export function {lf}FromJson(v: unknown): {} {{\n  const j = (v ?? {{}}) as Record<string, unknown>;\n", m.name));
        for f in &m.fields {
            let get = format!("pick(j, '{}', '{}')", f.proto, f.camel);
            if f.repeated {
                s.push_str(&format!("  const {} = {get};\n", f.camel));
            } else {
                s.push_str(&format!("  const {} = {get};\n", f.camel));
            }
        }
        s.push_str(&format!("  const out: {} = {{\n", m.name));
        for f in &m.fields {
            if f.repeated {
                s.push_str(&format!("    {}: Array.isArray({}) ? {}.map((x) => {}) : [],\n", f.camel, f.camel, f.camel, ts_from(&f.ty, "x")));
            } else {
                s.push_str(&format!("    {}: {} === undefined || {} === null ? {} : {},\n", f.camel, f.camel, f.camel, ts_default(&f.ty), ts_from(&f.ty, &f.camel)));
            }
        }
        s.push_str("  };\n");
        for o in &m.oneofs {
            for f in &o.members {
                s.push_str(&format!(
                    "  {{\n    const x = pick(j, '{}', '{}');\n    if (x !== undefined && x !== null) out.{} = {{ case: '{}', value: {} }};\n  }}\n",
                    f.proto,
                    f.camel,
                    o.camel,
                    f.camel,
                    ts_from(&f.ty, "x")
                ));
            }
        }
        s.push_str("  return out;\n}\n\n");
        s.push_str(&format!("export function {lf}ToJson(m: {}): Record<string, unknown> {{\n  const j: Record<string, unknown> = {{}};\n", m.name));
        for f in &m.fields {
            let v = format!("m.{}", f.camel);
            if f.repeated {
                s.push_str(&format!("  if ({v}.length) j.{} = {v}.map((x) => {});\n", f.proto, ts_to(&f.ty, "x")));
            } else {
                s.push_str(&format!("  if (!({})) j.{} = {};\n", ts_is_default(&f.ty, &v), f.proto, ts_to(&f.ty, &format!("{v}{}", if matches!(f.ty, BTy::Msg(_)) { "!" } else { "" }))));
            }
        }
        for o in &m.oneofs {
            for f in &o.members {
                s.push_str(&format!(
                    "  if (m.{}?.case === '{}') j.{} = {};\n",
                    o.camel,
                    f.camel,
                    f.proto,
                    ts_to(&f.ty, &format!("m.{}.value", o.camel))
                ));
            }
        }
        s.push_str("  return j;\n}\n\n");
    }
    s
}

fn cpp_ty(t: &BTy) -> String {
    match t {
        BTy::Str | BTy::Bytes => "std::string".into(),
        BTy::Bool => "bool".into(),
        BTy::I32 => "int32_t".into(),
        BTy::U32 => "uint32_t".into(),
        BTy::I64 => "int64_t".into(),
        BTy::U64 => "uint64_t".into(),
        BTy::F32 => "float".into(),
        BTy::F64 => "double".into(),
        BTy::Enum(n) | BTy::Msg(n) => n.clone(),
    }
}

fn cpp_init(t: &BTy) -> &'static str {
    match t {
        BTy::Bool => " = false",
        BTy::I32 | BTy::U32 | BTy::I64 | BTy::U64 | BTy::F32 | BTy::F64 => " = 0",
        BTy::Enum(_) => " = {}",
        _ => "",
    }
}

fn gen_cpp(msgs: &[BMsg], enums: &[BEnum]) -> (String, String) {
    let mut h = format!(
        "// {GEN_NOTE}\n// Граница движка — proto3-JSON: имена полей схемы, int64 — строка, bytes — base64 (здесь — сырые байты в std::string), enum — имя.\n#pragma once\n\n#include <cstdint>\n#include <optional>\n#include <string>\n#include <variant>\n#include <vector>\n\n#include <nlohmann/json.hpp>\n\nnamespace parvane::gen {{\n\nstd::string toBase64(const std::string &bytes);\nstd::string fromBase64(const std::string &text);\n\n"
    );
    let mut c = format!("// {GEN_NOTE}\n#include \"parvane/gen/model.h\"\n\n#include <stdexcept>\n\nnamespace parvane::gen {{\n\nnamespace {{\nconst char kB64[] = \"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\";\n\ntemplate <typename T> T numFrom(const nlohmann::json &v) {{\n    if (v.is_string()) {{\n        const auto &s = v.get_ref<const std::string &>();\n        if constexpr (std::is_signed_v<T>) return static_cast<T>(std::stoll(s));\n        else return static_cast<T>(std::stoull(s));\n    }}\n    return v.get<T>();\n}}\n\nconst nlohmann::json *pick(const nlohmann::json &j, const char *proto, const char *camel) {{\n    if (!j.is_object()) return nullptr;\n    auto it = j.find(proto);\n    if (it != j.end() && !it->is_null()) return &*it;\n    it = j.find(camel);\n    if (it != j.end() && !it->is_null()) return &*it;\n    return nullptr;\n}}\n}} // namespace\n\nstd::string toBase64(const std::string &b) {{\n    std::string out;\n    for (size_t i = 0; i < b.size(); i += 3) {{\n        const uint32_t n = (uint32_t(uint8_t(b[i])) << 16) | (i + 1 < b.size() ? uint32_t(uint8_t(b[i + 1])) << 8 : 0) | (i + 2 < b.size() ? uint32_t(uint8_t(b[i + 2])) : 0);\n        out += kB64[(n >> 18) & 63];\n        out += kB64[(n >> 12) & 63];\n        out += i + 1 < b.size() ? kB64[(n >> 6) & 63] : '=';\n        out += i + 2 < b.size() ? kB64[n & 63] : '=';\n    }}\n    return out;\n}}\n\nstd::string fromBase64(const std::string &t) {{\n    std::string out;\n    uint32_t acc = 0;\n    int bits = 0;\n    for (char ch : t) {{\n        if (ch == '=' || ch == '\\n' || ch == '\\r' || ch == ' ') continue;\n        if (ch == '-') ch = '+';\n        if (ch == '_') ch = '/';\n        const char *p = std::char_traits<char>::find(kB64, 64, ch);\n        if (!p) throw std::invalid_argument(\"base64\");\n        acc = (acc << 6) | uint32_t(p - kB64);\n        bits += 6;\n        if (bits >= 8) {{\n            bits -= 8;\n            out += char((acc >> bits) & 0xff);\n        }}\n    }}\n    return out;\n}}\n\n");
    for e in enums {
        h.push_str(&format!("enum class {} : int32_t {{\n", e.name));
        for (n, v) in &e.values {
            h.push_str(&format!("    {n} = {v},\n"));
        }
        h.push_str("};\n");
        h.push_str(&format!("void to_json(nlohmann::json &j, const {} &v);\nvoid from_json(const nlohmann::json &j, {} &v);\n\n", e.name, e.name));
        c.push_str(&format!("void to_json(nlohmann::json &j, const {} &v) {{\n    switch (v) {{\n", e.name));
        for (n, _) in &e.values {
            c.push_str(&format!("    case {}::{n}: j = \"{n}\"; return;\n", e.name));
        }
        c.push_str(&format!("    }}\n    j = static_cast<int32_t>(v);\n}}\n\nvoid from_json(const nlohmann::json &j, {} &v) {{\n    if (j.is_string()) {{\n        const auto &s = j.get_ref<const std::string &>();\n", e.name));
        for (n, _) in &e.values {
            c.push_str(&format!("        if (s == \"{n}\") {{ v = {}::{n}; return; }}\n", e.name));
        }
        c.push_str(&format!("        v = {{}};\n        return;\n    }}\n    v = static_cast<{}>(j.get<int32_t>());\n}}\n\n", e.name));
    }
    // Объявления наперёд — сообщения ссылаются друг на друга в любом порядке.
    for m in msgs {
        h.push_str(&format!("struct {};\n", m.name));
    }
    h.push('\n');
    // Порядок определения: зависимости раньше (std::optional/std::vector/std::variant требуют полного типа).
    let mut order: Vec<&BMsg> = Vec::new();
    let mut guard = 0;
    while order.len() < msgs.len() && guard < 10_000 {
        guard += 1;
        for m in msgs {
            if order.iter().any(|o| o.name == m.name) {
                continue;
            }
            let deps_ready = m.fields.iter().chain(m.oneofs.iter().flat_map(|o| o.members.iter())).all(|f| match &f.ty {
                BTy::Msg(n) => n == &m.name || order.iter().any(|o| &o.name == n),
                _ => true,
            });
            if deps_ready {
                order.push(m);
            }
        }
    }
    for m in order {
        h.push_str(&format!("struct {} {{\n", m.name));
        for f in &m.fields {
            let t = cpp_ty(&f.ty);
            if f.repeated {
                h.push_str(&format!("    std::vector<{t}> {};\n", f.proto));
            } else if matches!(f.ty, BTy::Msg(_)) {
                h.push_str(&format!("    std::optional<{t}> {};\n", f.proto));
            } else {
                h.push_str(&format!("    {t} {}{};\n", f.proto, cpp_init(&f.ty)));
            }
        }
        for o in &m.oneofs {
            let alts: Vec<String> = o.members.iter().map(|f| cpp_ty(&f.ty)).collect();
            h.push_str(&format!("    // oneof {}: {}\n", o.proto, o.members.iter().map(|f| f.proto.as_str()).collect::<Vec<_>>().join(", ")));
            h.push_str(&format!("    std::variant<std::monostate, {}> {};\n", alts.join(", "), o.proto));
        }
        h.push_str("};\n");
        h.push_str(&format!("void to_json(nlohmann::json &j, const {} &m);\nvoid from_json(const nlohmann::json &j, {} &m);\n\n", m.name, m.name));

        // to_json
        c.push_str(&format!("void to_json(nlohmann::json &j, const {} &m) {{\n    j = nlohmann::json::object();\n", m.name));
        for f in &m.fields {
            let enc = |v: &str| -> String {
                match f.ty {
                    BTy::Bytes => format!("toBase64({v})"),
                    BTy::I64 | BTy::U64 => format!("std::to_string({v})"),
                    _ => v.to_string(),
                }
            };
            if f.repeated {
                c.push_str(&format!(
                    "    if (!m.{p}.empty()) {{\n        auto a = nlohmann::json::array();\n        for (const auto &x : m.{p}) a.push_back({});\n        j[\"{p}\"] = a;\n    }}\n",
                    enc("x"),
                    p = f.proto
                ));
            } else {
                let cond = match f.ty {
                    BTy::Str | BTy::Bytes => format!("!m.{}.empty()", f.proto),
                    BTy::Bool => format!("m.{}", f.proto),
                    BTy::Msg(_) => format!("m.{}.has_value()", f.proto),
                    BTy::Enum(ref n) => format!("m.{} != {n}{{}}", f.proto),
                    _ => format!("m.{} != 0", f.proto),
                };
                let val = if matches!(f.ty, BTy::Msg(_)) { format!("*m.{}", f.proto) } else { enc(&format!("m.{}", f.proto)) };
                c.push_str(&format!("    if ({cond}) j[\"{}\"] = {val};\n", f.proto));
            }
        }
        for o in &m.oneofs {
            for (i, f) in o.members.iter().enumerate() {
                let enc = match f.ty {
                    BTy::Bytes => "toBase64(*p)".to_string(),
                    BTy::I64 | BTy::U64 => "std::to_string(*p)".to_string(),
                    _ => "*p".to_string(),
                };
                c.push_str(&format!(
                    "    if (const auto *p = std::get_if<{}>(&m.{})) j[\"{}\"] = {enc};\n",
                    i + 1,
                    o.proto,
                    f.proto
                ));
            }
        }
        c.push_str("}\n\n");

        // from_json
        c.push_str(&format!("void from_json(const nlohmann::json &j, {} &m) {{\n    m = {}{{}};\n", m.name, m.name));
        for f in &m.fields {
            let dec = |v: &str| -> String {
                match &f.ty {
                    BTy::Bytes => format!("fromBase64({v}.get<std::string>())"),
                    BTy::I64 | BTy::U64 | BTy::I32 | BTy::U32 | BTy::F32 | BTy::F64 => format!("numFrom<{}>({v})", cpp_ty(&f.ty)),
                    other => format!("{v}.get<{}>()", cpp_ty(other)),
                }
            };
            let camel = &f.camel;
            if f.repeated {
                c.push_str(&format!(
                    "    if (const auto *v = pick(j, \"{p}\", \"{camel}\"); v && v->is_array())\n        for (const auto &x : *v) m.{p}.push_back({});\n",
                    dec("x"),
                    p = f.proto
                ));
            } else {
                c.push_str(&format!("    if (const auto *v = pick(j, \"{p}\", \"{camel}\")) m.{p} = {};\n", dec("(*v)"), p = f.proto));
            }
        }
        for o in &m.oneofs {
            for (i, f) in o.members.iter().enumerate() {
                let dec = match &f.ty {
                    BTy::Bytes => "fromBase64(v->get<std::string>())".to_string(),
                    BTy::I64 | BTy::U64 | BTy::I32 | BTy::U32 | BTy::F32 | BTy::F64 => format!("numFrom<{}>(*v)", cpp_ty(&f.ty)),
                    other => format!("v->get<{}>()", cpp_ty(other)),
                };
                c.push_str(&format!(
                    "    if (const auto *v = pick(j, \"{}\", \"{}\")) m.{}.emplace<{}>({dec});\n",
                    f.proto,
                    f.camel,
                    o.proto,
                    i + 1
                ));
            }
        }
        c.push_str("}\n\n");
    }
    h.push_str("} // namespace parvane::gen\n");
    c.push_str("} // namespace parvane::gen\n");
    (h, c)
}

fn kt_ty(t: &BTy) -> String {
    match t {
        BTy::Str => "String".into(),
        BTy::Bytes => "ByteArray".into(),
        BTy::Bool => "Boolean".into(),
        BTy::I32 => "Int".into(),
        BTy::U32 | BTy::I64 | BTy::U64 => "Long".into(),
        BTy::F32 => "Float".into(),
        BTy::F64 => "Double".into(),
        BTy::Enum(n) | BTy::Msg(n) => n.clone(),
    }
}

fn kt_default(t: &BTy) -> String {
    match t {
        BTy::Str => "\"\"".into(),
        BTy::Bytes => "ByteArray(0)".into(),
        BTy::Bool => "false".into(),
        BTy::I32 => "0".into(),
        BTy::U32 | BTy::I64 | BTy::U64 => "0L".into(),
        BTy::F32 => "0f".into(),
        BTy::F64 => "0.0".into(),
        BTy::Enum(n) => format!("{n}.values()[0]"),
        BTy::Msg(_) => "null".into(),
    }
}

fn kt_from(t: &BTy, v: &str) -> String {
    match t {
        BTy::Str => format!("{v}.toString()"),
        BTy::Bytes => format!("fromBase64({v}.toString())"),
        BTy::Bool => format!("({v} as? Boolean ?: {v}.toString().toBoolean())"),
        BTy::I32 => format!("{v}.toString().toInt()"),
        BTy::U32 | BTy::I64 | BTy::U64 => format!("{v}.toString().toLong()"),
        BTy::F32 => format!("{v}.toString().toFloat()"),
        BTy::F64 => format!("{v}.toString().toDouble()"),
        BTy::Enum(n) => format!("{n}.fromJson({v})"),
        BTy::Msg(n) => format!("{n}.fromJson({v} as JSONObject)"),
    }
}

fn kt_to(t: &BTy, v: &str) -> String {
    match t {
        BTy::Bytes => format!("toBase64({v})"),
        BTy::I64 | BTy::U64 => format!("{v}.toString()"),
        BTy::Enum(_) => format!("{v}.name"),
        BTy::Msg(_) => format!("{v}.toJson()"),
        _ => v.to_string(),
    }
}

fn kt_is_default(t: &BTy, v: &str) -> String {
    match t {
        BTy::Str => format!("{v}.isEmpty()"),
        BTy::Bytes => format!("{v}.isEmpty()"),
        BTy::Bool => format!("!{v}"),
        BTy::I32 => format!("{v} == 0"),
        BTy::U32 | BTy::I64 | BTy::U64 => format!("{v} == 0L"),
        BTy::F32 => format!("{v} == 0f"),
        BTy::F64 => format!("{v} == 0.0"),
        BTy::Enum(n) => format!("{v} == {n}.values()[0]"),
        BTy::Msg(_) => format!("{v} == null"),
    }
}

fn gen_kt(msgs: &[BMsg], enums: &[BEnum]) -> String {
    let mut s = format!("// {GEN_NOTE}\n// Граница движка — proto3-JSON: имена полей схемы, int64 — строка, bytes — base64, enum — имя.\n@file:Suppress(\"unused\", \"ArrayInDataClass\")\n\npackage org.parvane.gen\n\nimport org.json.JSONArray\nimport org.json.JSONObject\n\n");
    s.push_str(
        "private const val B64 = \"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\"\n\n\
         fun toBase64(b: ByteArray): String {\n    val out = StringBuilder()\n    var i = 0\n    while (i < b.size) {\n        val n = ((b[i].toInt() and 0xff) shl 16) or ((if (i + 1 < b.size) b[i + 1].toInt() and 0xff else 0) shl 8) or (if (i + 2 < b.size) b[i + 2].toInt() and 0xff else 0)\n        out.append(B64[(n shr 18) and 63]).append(B64[(n shr 12) and 63])\n        out.append(if (i + 1 < b.size) B64[(n shr 6) and 63] else '=')\n        out.append(if (i + 2 < b.size) B64[n and 63] else '=')\n        i += 3\n    }\n    return out.toString()\n}\n\n\
         fun fromBase64(t: String): ByteArray {\n    val out = java.io.ByteArrayOutputStream()\n    var acc = 0\n    var bits = 0\n    for (c0 in t) {\n        if (c0 == '=' || c0.isWhitespace()) continue\n        val c = when (c0) { '-' -> '+'; '_' -> '/'; else -> c0 }\n        val v = B64.indexOf(c)\n        require(v >= 0) { \"base64\" }\n        acc = (acc shl 6) or v\n        bits += 6\n        if (bits >= 8) {\n            bits -= 8\n            out.write((acc shr bits) and 0xff)\n        }\n    }\n    return out.toByteArray()\n}\n\n\
         private fun JSONObject.pick(proto: String, camel: String): Any? {\n    val v = if (has(proto)) opt(proto) else opt(camel)\n    return if (v == null || v == JSONObject.NULL) null else v\n}\n\n",
    );
    for e in enums {
        s.push_str(&format!("enum class {}(val number: Int) {{\n", e.name));
        let items: Vec<String> = e.values.iter().map(|(n, v)| format!("    {n}({v})")).collect();
        s.push_str(&items.join(",\n"));
        s.push_str(&format!(
            ";\n\n    companion object {{\n        fun fromJson(v: Any?): {n} = values().firstOrNull {{ it.name == v?.toString() }}\n            ?: values().firstOrNull {{ it.number == v?.toString()?.toIntOrNull() }} ?: values()[0]\n    }}\n}}\n\n",
            n = e.name
        ));
    }
    for m in msgs {
        for o in &m.oneofs {
            let iname = format!("{}{}", m.name, upper_first(&o.camel));
            s.push_str(&format!("sealed interface {iname} {{\n"));
            for f in &o.members {
                s.push_str(&format!("    data class {}(val value: {}) : {iname}\n", upper_first(&f.camel), kt_ty(&f.ty)));
            }
            s.push_str("}\n\n");
        }
        s.push_str(&format!("data class {}(\n", m.name));
        let mut params = Vec::new();
        for f in &m.fields {
            let t = kt_ty(&f.ty);
            if f.repeated {
                params.push(format!("    val {}: List<{t}> = emptyList()", f.camel));
            } else if matches!(f.ty, BTy::Msg(_)) {
                params.push(format!("    val {}: {t}? = null", f.camel));
            } else {
                params.push(format!("    val {}: {t} = {}", f.camel, kt_default(&f.ty)));
            }
        }
        for o in &m.oneofs {
            params.push(format!("    val {}: {}{}? = null", o.camel, m.name, upper_first(&o.camel)));
        }
        s.push_str(&params.join(",\n"));
        s.push_str("\n) {\n    fun toJson(): JSONObject {\n        val j = JSONObject()\n");
        for f in &m.fields {
            if f.repeated {
                s.push_str(&format!(
                    "        if ({c}.isNotEmpty()) j.put(\"{p}\", JSONArray().apply {{ {c}.forEach {{ put({}) }} }})\n",
                    kt_to(&f.ty, "it"),
                    c = f.camel,
                    p = f.proto
                ));
            } else {
                let v = if matches!(f.ty, BTy::Msg(_)) { format!("{}!!", f.camel) } else { f.camel.clone() };
                s.push_str(&format!("        if (!({})) j.put(\"{}\", {})\n", kt_is_default(&f.ty, &f.camel), f.proto, kt_to(&f.ty, &v)));
            }
        }
        for o in &m.oneofs {
            s.push_str(&format!("        when (val o = {}) {{\n", o.camel));
            for f in &o.members {
                s.push_str(&format!(
                    "            is {}{}.{} -> j.put(\"{}\", {})\n",
                    m.name,
                    upper_first(&o.camel),
                    upper_first(&f.camel),
                    f.proto,
                    kt_to(&f.ty, "o.value")
                ));
            }
            s.push_str("            null -> {}\n        }\n");
        }
        s.push_str("        return j\n    }\n\n    companion object {\n");
        s.push_str(&format!("        fun fromJson(j: JSONObject): {} {{\n", m.name));
        for o in &m.oneofs {
            s.push_str(&format!("            var {}: {}{}? = null\n", o.camel, m.name, upper_first(&o.camel)));
            for f in &o.members {
                s.push_str(&format!(
                    "            j.pick(\"{}\", \"{}\")?.let {{ {} = {}{}.{}({}) }}\n",
                    f.proto,
                    f.camel,
                    o.camel,
                    m.name,
                    upper_first(&o.camel),
                    upper_first(&f.camel),
                    kt_from(&f.ty, "it")
                ));
            }
        }
        s.push_str(&format!("            return {}(\n", m.name));
        let mut args = Vec::new();
        for f in &m.fields {
            let get = format!("j.pick(\"{}\", \"{}\")", f.proto, f.camel);
            if f.repeated {
                args.push(format!(
                    "                {} = ({get} as? JSONArray)?.let {{ a -> (0 until a.length()).map {{ i -> a.get(i).let {{ {} }} }} }} ?: emptyList()",
                    f.camel,
                    kt_from(&f.ty, "it")
                ));
            } else {
                args.push(format!("                {} = {get}?.let {{ {} }} ?: {}", f.camel, kt_from(&f.ty, "it"), kt_default(&f.ty)));
            }
        }
        for o in &m.oneofs {
            args.push(format!("                {} = {}", o.camel, o.camel));
        }
        s.push_str(&args.join(",\n"));
        s.push_str("\n            )\n        }\n    }\n}\n\n");
    }
    s
}

/// Выходы `gen_bindings`: (путь от корня репозитория, содержимое).
fn build_bindings(pool: &DescriptorPool, errors: &mut Vec<String>) -> String {
    let (msgs, enums) = bindings_model(pool, errors);
    let ts = gen_ts(&msgs, &enums);
    let (h, cpp) = gen_cpp(&msgs, &enums);
    let kt = gen_kt(&msgs, &enums);
    format!(
        "/// spec 035 T022: выходы gen_bindings — (путь от корня репозитория, содержимое).\npub const FILES: &[(&str, &str)] = &[\n    ({BINDINGS_TS:?}, {ts:?}),\n    ({BINDINGS_H:?}, {h:?}),\n    ({BINDINGS_CPP:?}, {cpp:?}),\n    ({BINDINGS_KT:?}, {kt:?}),\n];\n"
    )
}
