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

    std::fs::write(out.join("schema_table.rs"), format!("{}\n{}", table.code, methods))
        .expect("schema_table.rs");
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
                "    FieldSpec {{ number: {}, name: {:?}, ty: {ty}, repeated: {}, max_len: {max_len}, max_items: {max_items}, server_set: {} }},",
                f.number(),
                f.name(),
                f.is_list(),
                actor == 2
            );
        }
        let _ = writeln!(code, "  ] }},");
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
                    "  MethodInfo {{ name: {name:?}, channel: {channel}, reauth: {reauth}, rate: {rate}, kind: {kind}, shard: {shard:?}, subject: {subject:?}, operator_only: {operator_only}, request: {req}, response: {resp} }},"
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
