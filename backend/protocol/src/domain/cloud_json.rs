//! JSON облака для хостов (spec 016): видимое дерево контейнера и разбор
//! правок от хоста. Метки хост не ставит — их проставляет движок
//! (`cloud::stamp_batch`). Байтовые поля — base64, идентификаторы узлов — hex.
//!
//! Состояние:
//! `{name, count, nodes:[{id, kind:"folder"|"file", parent|null, name, size, mime, mtime,
//!   trashed, trashTop, trashedAt, blob|null, thumb|null, from, versions:[{blob, thumb|null, mtime, size, device}]}],
//!   purgedBlobs:[{fileId, uploader}]}` (`versions` — прежние версии от новой к старой, CLOUD-3; `from` — адрес
//!   приславшего файл копией, пусто — свой; `purgedBlobs` — блобы стёртых узлов и вытесненных версий),
//! где `blob = {fileId, key, nonce, capability, size, chunks, mime, sha256, uploader}`,
//! `thumb = {fileId, nonce, capability, width, height}`.
//! Правки: `{ops:[{op:"create", id, kind, parent|null, name, blob?, thumb?, mtime?, from?, versions?} |
//! {op:"move", id, parent|null, name} | {op:"setBlob", id, blob, thumb?, mtime?, keep?} |
//! {op:"trash", id, trashed, at} | {op:"purge", id, at} | {op:"meta", name}]}`; `versions` создания —
//! `[{blob, thumb?, mtime}]` от новой к старой (перенос файла с историей, `push_op`).

use std::collections::BTreeSet;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};

use super::cloud::{CloudState, NodeId, VERSIONS_KEEP};
use crate::error::{ProtoError, Result};
use crate::pb::parvane::cloud::v1::{
    cloud_op, CloudBatch, CloudBlobRef, CloudCreate, CloudMeta, CloudMove, CloudNodeKind, CloudOp, CloudPurge, CloudSetBlob, CloudThumb,
    CloudTrash,
};

// ── состояние → JSON ────────────────────────────────────────────────────────

fn blob_json(b: &CloudBlobRef) -> Value {
    json!({
        "fileId": b.file_id, "key": B64.encode(&b.key), "nonce": B64.encode(&b.nonce), "capability": B64.encode(&b.capability),
        "size": b.size, "chunks": b.chunks, "mime": b.mime, "sha256": B64.encode(&b.sha256), "uploader": b.uploader,
    })
}

fn thumb_json(t: &CloudThumb) -> Value {
    json!({
        "fileId": t.file_id, "nonce": B64.encode(&t.nonce), "capability": B64.encode(&t.capability),
        "width": t.width, "height": t.height,
    })
}

pub fn state_json(state: &CloudState) -> String {
    let view = state.view();
    let nodes: Vec<Value> = view
        .iter()
        .map(|n| {
            json!({
                "id": hex::encode(n.id),
                "kind": if n.kind == CloudNodeKind::Folder { "folder" } else { "file" },
                "parent": n.parent.map(hex::encode),
                "name": n.name,
                "size": n.blob.as_ref().map_or(0, |b| b.size),
                "mime": n.blob.as_ref().map_or("", |b| b.mime.as_str()),
                "mtime": n.mtime_ms,
                "trashed": n.trashed,
                "trashTop": n.trash_top,
                "trashedAt": n.trashed_at_ms,
                "blob": n.blob.as_ref().map(blob_json),
                "thumb": n.thumb.as_ref().map(thumb_json),
                "from": n.from,
                "versions": n.versions.iter().map(|v| json!({
                    "blob": blob_json(&v.blob), "thumb": v.thumb.as_ref().map(thumb_json), "mtime": v.mtime_ms,
                    "size": v.blob.size, "device": v.device,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let purged: Vec<Value> = state.purged_blobs().iter().map(|b| json!({"fileId": b.file_id, "uploader": b.uploader})).collect();
    json!({"name": state.name(), "count": view.len(), "nodes": nodes, "purgedBlobs": purged}).to_string()
}

// ── JSON → правки ───────────────────────────────────────────────────────────

fn bad(field: &'static str) -> ProtoError {
    ProtoError::InvalidField(field)
}

fn str_of<'a>(o: &'a Map<String, Value>, key: &'static str) -> Result<&'a str> {
    o.get(key).and_then(Value::as_str).ok_or(bad(key))
}

fn opt_str(o: &Map<String, Value>, key: &'static str) -> Result<String> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(bad(key)),
    }
}

fn u64_of(o: &Map<String, Value>, key: &'static str) -> Result<u64> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(0),
        Some(v) => v.as_u64().ok_or(bad(key)),
    }
}

fn b64_of(o: &Map<String, Value>, key: &'static str) -> Result<Vec<u8>> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(s)) => B64.decode(s).map_err(|_| bad(key)),
        Some(_) => Err(bad(key)),
    }
}

fn id_of(o: &Map<String, Value>, key: &'static str) -> Result<Vec<u8>> {
    let id: NodeId = hex::decode(str_of(o, key)?).map_err(|_| bad(key))?.try_into().map_err(|_| bad(key))?;
    Ok(id.to_vec())
}

fn parent_of(o: &Map<String, Value>) -> Result<Vec<u8>> {
    match o.get("parent") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(_) => id_of(o, "parent"),
    }
}

fn blob_of(v: &Value) -> Result<CloudBlobRef> {
    let o = v.as_object().ok_or(bad("blob"))?;
    Ok(CloudBlobRef {
        file_id: str_of(o, "fileId")?.to_string(),
        key: b64_of(o, "key")?,
        size: u64_of(o, "size")?,
        chunks: u32::try_from(u64_of(o, "chunks")?).map_err(|_| bad("chunks"))?,
        mime: opt_str(o, "mime")?,
        sha256: b64_of(o, "sha256")?,
        nonce: b64_of(o, "nonce")?,
        capability: b64_of(o, "capability")?,
        uploader: opt_str(o, "uploader")?,
    })
}

fn thumb_of(o: &Map<String, Value>) -> Result<Option<CloudThumb>> {
    let Some(t) = o.get("thumb").filter(|v| !v.is_null()) else { return Ok(None) };
    let t = t.as_object().ok_or(bad("thumb"))?;
    Ok(Some(CloudThumb {
        file_id: str_of(t, "fileId")?.to_string(),
        nonce: b64_of(t, "nonce")?,
        capability: b64_of(t, "capability")?,
        width: u32::try_from(u64_of(t, "width")?).map_err(|_| bad("width"))?,
        height: u32::try_from(u64_of(t, "height")?).map_err(|_| bad("height"))?,
    }))
}

fn op_of(v: &Value) -> Result<cloud_op::Op> {
    let o = v.as_object().ok_or(bad("ops"))?;
    Ok(match str_of(o, "op")? {
        "create" => {
            let kind = match str_of(o, "kind")? {
                "folder" => CloudNodeKind::Folder,
                "file" => CloudNodeKind::File,
                _ => return Err(bad("kind")),
            };
            cloud_op::Op::Create(CloudCreate {
                node_id: id_of(o, "id")?,
                kind: kind as i32,
                parent_id: parent_of(o)?,
                name: str_of(o, "name")?.to_string(),
                blob: o.get("blob").filter(|v| !v.is_null()).map(blob_of).transpose()?,
                stamp: None,
                thumb: thumb_of(o)?,
                mtime_ms: u64_of(o, "mtime")?,
                from: opt_str(o, "from")?,
            })
        }
        "move" => cloud_op::Op::Move(CloudMove {
            node_id: id_of(o, "id")?,
            parent_id: parent_of(o)?,
            name: str_of(o, "name")?.to_string(),
            stamp: None,
        }),
        "setBlob" => cloud_op::Op::SetBlob(CloudSetBlob {
            node_id: id_of(o, "id")?,
            blob: Some(blob_of(o.get("blob").ok_or(bad("blob"))?)?),
            stamp: None,
            thumb: thumb_of(o)?,
            mtime_ms: u64_of(o, "mtime")?,
            supersedes: Vec::new(),
            draft_since_ms: 0,
        }),
        "trash" => cloud_op::Op::Trash(CloudTrash {
            node_id: id_of(o, "id")?,
            trashed: o.get("trashed").and_then(Value::as_bool).ok_or(bad("trashed"))?,
            at_ms: u64_of(o, "at")?,
            stamp: None,
        }),
        "purge" => cloud_op::Op::Purge(CloudPurge { node_id: id_of(o, "id")?, at_ms: u64_of(o, "at")?, stamp: None }),
        "meta" => cloud_op::Op::Meta(CloudMeta { name: str_of(o, "name")?.to_string(), stamp: None }),
        _ => return Err(bad("op")),
    })
}

/// Разобрать правки хоста в пакет без меток.
pub fn batch_from_json(json: &str) -> Result<CloudBatch> {
    batch_with_keep(json).map(|(batch, _)| batch)
}

/// То же и номера правок `setBlob` с `keep: true` (версия не черновая — возврат прежней, CLOUD-3).
pub fn batch_with_keep(json: &str) -> Result<(CloudBatch, BTreeSet<usize>)> {
    let v: Value = serde_json::from_str(json).map_err(|_| ProtoError::Malformed)?;
    let ops = v.get("ops").and_then(Value::as_array).ok_or(bad("ops"))?;
    if ops.is_empty() || ops.len() > 500 {
        return Err(bad("ops"));
    }
    let mut out = Vec::with_capacity(ops.len());
    let mut keep = BTreeSet::new();
    for o in ops {
        push_op(o, &mut out, &mut keep)?;
    }
    if out.len() > 500 {
        return Err(bad("ops"));
    }
    Ok((CloudBatch { ops: out }, keep))
}

/// Одна правка хоста. Создание файла с `versions` (прежние версии от новой к старой, как в состоянии, CLOUD-3) —
/// перенос файла с историей в другой контейнер: разворачивается в создание старейшей версией и `setBlob` с `keep`
/// для каждой следующей, последней — текущей. Метки идут по порядку пакета, поэтому порядок версий сохраняется,
/// а окно черновика (`coalesce_local`) их не сливает.
fn push_op(v: &Value, out: &mut Vec<CloudOp>, keep: &mut BTreeSet<usize>) -> Result<()> {
    let op = op_of(v)?;
    if v.get("keep").and_then(Value::as_bool) == Some(true) {
        keep.insert(out.len());
    }
    let versions = match v.get("versions") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(a)) => a.as_slice(),
        Some(_) => return Err(bad("versions")),
    };
    if versions.is_empty() {
        out.push(CloudOp { op: Some(op) });
        return Ok(());
    }
    let cloud_op::Op::Create(mut create) = op else { return Err(bad("versions")) };
    if versions.len() >= VERSIONS_KEEP {
        return Err(bad("versions"));
    }
    let current = (create.blob.take().ok_or(bad("versions"))?, create.thumb.take(), create.mtime_ms);
    let mut chain = Vec::with_capacity(versions.len() + 1);
    for ver in versions.iter().rev() {
        let vo = ver.as_object().ok_or(bad("versions"))?;
        chain.push((blob_of(vo.get("blob").ok_or(bad("blob"))?)?, thumb_of(vo)?, u64_of(vo, "mtime")?));
    }
    chain.push(current);
    let node_id = create.node_id.clone();
    for (i, (blob, thumb, mtime_ms)) in chain.into_iter().enumerate() {
        if i == 0 {
            create.blob = Some(blob);
            create.thumb = thumb;
            create.mtime_ms = mtime_ms;
            out.push(CloudOp { op: Some(cloud_op::Op::Create(create.clone())) });
            continue;
        }
        keep.insert(out.len());
        out.push(CloudOp {
            op: Some(cloud_op::Op::SetBlob(CloudSetBlob {
                node_id: node_id.clone(),
                blob: Some(blob),
                stamp: None,
                thumb,
                mtime_ms,
                supersedes: Vec::new(),
                draft_since_ms: 0,
            })),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::cloud::stamp_batch;
    use super::super::LamportGuard;
    use super::*;

    #[test]
    fn ops_roundtrip_to_state() {
        let key = B64.encode([1u8; 32]);
        let nonce = B64.encode([2u8; 12]);
        let cap = B64.encode([3u8; 32]);
        let a = "0a".repeat(16);
        let b = "0b".repeat(16);
        let ops = json!({"ops": [
            {"op": "meta", "name": "Общая"},
            {"op": "create", "id": a, "kind": "folder", "parent": null, "name": "Документы"},
            {"op": "create", "id": b, "kind": "file", "parent": a, "name": "отчёт.pdf", "mtime": 77,
             "blob": {"fileId": "f1", "key": key, "nonce": nonce, "capability": cap, "size": 10, "chunks": 1,
                      "mime": "application/pdf", "uploader": "alice@local"},
             "thumb": {"fileId": "t1", "nonce": nonce, "capability": cap, "width": 32, "height": 20}},
            {"op": "trash", "id": b, "trashed": true, "at": 5},
        ]});
        let mut batch = batch_from_json(&ops.to_string()).unwrap();
        let mut guard = LamportGuard::default();
        stamp_batch(&mut batch, "d1", &mut guard);
        let mut st = CloudState::default();
        st.check_local(&batch).unwrap();
        assert_eq!(st.apply_batch(&batch, "d1").unwrap(), 4);
        let v: Value = serde_json::from_str(&state_json(&st)).unwrap();
        assert_eq!(v["name"], "Общая");
        assert_eq!(v["count"], 2);
        let file = v["nodes"].as_array().unwrap().iter().find(|n| n["kind"] == "file").unwrap();
        assert_eq!(file["parent"], a);
        assert_eq!(file["name"], "отчёт.pdf");
        assert_eq!((file["size"].as_u64(), file["mtime"].as_u64()), (Some(10), Some(77)));
        assert_eq!((file["trashed"].as_bool(), file["trashTop"].as_bool()), (Some(true), Some(true)));
        assert_eq!(file["blob"]["key"], key);
        assert_eq!(file["thumb"]["width"], 32);
        // Негодные правки.
        for bad in [
            json!({"ops": []}),
            json!({"ops": [{"op": "create", "id": "zz", "kind": "folder", "name": "x"}]}),
            json!({"ops": [{"op": "create", "id": a, "kind": "disk", "name": "x"}]}),
            json!({"ops": [{"op": "unknown", "id": a}]}),
            json!({"ops": [{"op": "trash", "id": a}]}),
        ] {
            assert!(batch_from_json(&bad.to_string()).is_err(), "{bad}");
        }
    }

    /// Чужой `uploader` в блобе операции отвергается: иначе устройство жертвы сотрёт свой блоб (сборка мусора).
    #[test]
    fn batch_from_other_uploader_is_rejected() {
        let key = B64.encode([1u8; 32]);
        let nonce = B64.encode([2u8; 12]);
        let cap = B64.encode([3u8; 32]);
        let id = "0b".repeat(16);
        let file = |uploader: &str| {
            json!({"ops": [{"op": "create", "id": id, "kind": "file", "parent": null, "name": "a.pdf",
                "blob": {"fileId": "f1", "key": key, "nonce": nonce, "capability": cap, "size": 10, "chunks": 1,
                         "mime": "application/pdf", "uploader": uploader}}]})
        };
        let author = super::super::Author::new("mallory@local", "d1");
        for (uploader, ok) in [("victim@local", false), ("mallory@local", true)] {
            let mut batch = batch_from_json(&file(uploader).to_string()).unwrap();
            stamp_batch(&mut batch, "d1", &mut LamportGuard::default());
            let mut st = CloudState::default();
            assert_eq!(st.apply_batch_from(&batch, &author).is_ok(), ok, "{uploader}");
        }
    }
}
