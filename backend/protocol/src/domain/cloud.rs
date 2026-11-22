//! Домен облака `cloud.v1` (spec 016): дерево файлов и папок одного контейнера
//! (личный диск либо совместная папка).
//!
//! Сведение зависит только от итоговых регистров узлов, поэтому не зависит от
//! порядка применения и снимок ему достаточен:
//!   - создание: вид узла и метка создания (при двух созданиях одного id
//!     побеждает меньшая метка);
//!   - «родитель + имя», «содержимое», «корзина» — LWW-регистры по метке
//!     `(lamport, device_id)`, при равных метках — по содержимому;
//!   - purge — необратимое надгробие, стирает узел со всеми потомками;
//!   - история версий (CLOUD-3): все известные содержимые узла, не больше
//!     `VERSIONS_KEEP` (текущее — наибольшее по метке); вытесненные и заменённые
//!     черновики — надгробия `gone` (их блобы стирает устройство загрузившего).
//! Узел существует только после создания: регистры узла без создания хранятся,
//! но в дереве его нет. Видимое дерево (`view`) строится из регистров: узел,
//! чей родитель неизвестен или не папка, показывается в корне; в цикле
//! перемещений в корне показывается узел с наибольшей меткой перемещения.

use std::collections::{BTreeMap, BTreeSet};

use prost::Message;

use super::{Author, LamportGuard, Stamp, StateCache};
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::cloud::v1::{
    cloud_op, CloudBatch, CloudBlobRef, CloudCreate, CloudEntry, CloudGone, CloudMeta, CloudNodeKind, CloudOp, CloudSnapshot,
    CloudThumb, CloudVersion,
};

pub const DOMAIN_NAME: &str = "cloud.v1";
/// Порог операций журнала между снимками.
pub const SNAPSHOT_EVERY: u64 = 200;
/// Предел существующих узлов контейнера (проверяется при локальной правке).
pub const MAX_NODES: usize = 8000;
/// Сколько живёт в снимке надгробие стёртого узла.
pub const PURGED_KEEP_MS: u64 = 90 * 24 * 3600 * 1000;
pub const MAX_NAME_BYTES: usize = 255;
/// Сколько версий файла хранится (с текущей, CLOUD-3); старше — надгробия, блобы стираются.
pub const VERSIONS_KEEP: usize = 10;
/// Сколько надгробий версий хранит узел (новейшие по метке).
pub const GONE_KEEP: usize = 32;
/// Окно черновика: правки одного устройства подряд в эти минуты от начала окна — одна версия.
pub const DRAFT_WINDOW_MS: u64 = 10 * 60 * 1000;

pub type NodeId = [u8; 16];

pub fn decode_batch(bytes: &[u8]) -> Result<CloudBatch> {
    decode_checked(bytes, Origin::Client)
}

pub fn decode_snapshot(bytes: &[u8]) -> Result<CloudSnapshot> {
    decode_checked(bytes, Origin::Client)
}

fn node_id(b: &[u8]) -> Result<NodeId> {
    b.try_into().map_err(|_| ProtoError::InvalidField("node_id"))
}

fn parent_id(b: &[u8]) -> Result<Option<NodeId>> {
    if b.is_empty() {
        Ok(None)
    } else {
        node_id(b).map(Some)
    }
}

pub fn check_name(n: &str) -> Result<()> {
    let bad = n.is_empty()
        || n.len() > MAX_NAME_BYTES
        || n.trim() != n
        || n == "."
        || n == ".."
        || n.chars().any(|c| c == '/' || c == '\\' || c.is_control());
    if bad {
        return Err(ProtoError::InvalidField("name"));
    }
    Ok(())
}

fn check_blob(b: &CloudBlobRef) -> Result<()> {
    if b.file_id.is_empty() || b.key.len() != 32 || b.nonce.len() != 12 || b.capability.len() != 32 {
        return Err(ProtoError::InvalidField("blob"));
    }
    if !b.sha256.is_empty() && b.sha256.len() != 32 {
        return Err(ProtoError::InvalidField("blob"));
    }
    Ok(())
}

fn check_thumb(t: &CloudThumb) -> Result<()> {
    if t.file_id.is_empty() || t.nonce.len() != 12 || t.capability.len() != 32 {
        return Err(ProtoError::InvalidField("thumb"));
    }
    Ok(())
}

/// Регистр «родитель + имя».
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Place {
    stamp: Stamp,
    parent: Option<NodeId>,
    name: String,
}

/// Одна версия содержимого файла; `bytes` — каноничная запись для порядка при
/// равных метках. `draft_since_ms` — начало окна черновика (0 — не черновик).
#[derive(Debug, Clone, PartialEq)]
struct Body {
    stamp: Stamp,
    bytes: Vec<u8>,
    blob: CloudBlobRef,
    thumb: Option<CloudThumb>,
    mtime_ms: u64,
    draft_since_ms: u64,
}

impl Body {
    fn key(&self) -> (&Stamp, &Vec<u8>) {
        (&self.stamp, &self.bytes)
    }

    fn file_ids(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.blob.file_id.as_str()).chain(self.thumb.as_ref().map(|t| t.file_id.as_str()))
    }

    fn gone(&self) -> Vec<Gone> {
        self.file_ids().map(|f| Gone { stamp: self.stamp.clone(), file_id: f.to_string(), uploader: self.blob.uploader.clone() }).collect()
    }
}

fn body(stamp: Stamp, blob: &CloudBlobRef, thumb: Option<&CloudThumb>, mtime_ms: u64) -> Body {
    let mut bytes = blob.encode_to_vec();
    bytes.extend(thumb.map(Message::encode_to_vec).unwrap_or_default());
    bytes.extend(mtime_ms.to_be_bytes());
    Body { stamp, bytes, blob: blob.clone(), thumb: thumb.cloned(), mtime_ms, draft_since_ms: 0 }
}

/// Надгробие версии: блоб `file_id` больше не версия узла.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Gone {
    stamp: Stamp,
    file_id: String,
    uploader: String,
}

/// Создание узла: метка, вид и от кого файл прислан (пусто — свой). `at_ms` — время создания папки (дата
/// «Изменён» пустой папки); у файла 0 — его время живёт в содержимом.
#[derive(Debug, Clone, PartialEq)]
struct Created {
    stamp: Stamp,
    kind: CloudNodeKind,
    from: String,
    at_ms: u64,
}

/// Регистр корзины.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Trash {
    stamp: Stamp,
    trashed: bool,
    at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Node {
    /// Создание; `None` — узел ещё не создан.
    created: Option<Created>,
    place: Option<Place>,
    /// Версии содержимого от новой к старой (первая — текущая), не больше `VERSIONS_KEEP`.
    bodies: Vec<Body>,
    /// Надгробия версий от новых к старым, не больше `GONE_KEEP`, по одному на блоб.
    gone: Vec<Gone>,
    trash: Option<Trash>,
    /// Время окончательного удаления (наименьшее из пришедших).
    purged_at: Option<u64>,
}

impl Node {
    fn body(&self) -> Option<&Body> {
        self.bodies.first()
    }

    fn add_gone(&mut self, g: Gone) {
        match self.gone.iter_mut().find(|x| x.file_id == g.file_id) {
            Some(cur) if *cur >= g => {}
            Some(cur) => *cur = g,
            None => self.gone.push(g),
        }
    }

    /// Новая версия; `supersedes` — блобы черновика, который она заменяет. Итог не зависит от порядка:
    /// версии — множество, из него убираются надгробные блобы и повторы, остаются новейшие.
    fn put_body(&mut self, value: Body, supersedes: &[String]) {
        for f in supersedes.iter().filter(|f| **f != value.blob.file_id) {
            self.add_gone(Gone { stamp: value.stamp.clone(), file_id: f.clone(), uploader: value.blob.uploader.clone() });
        }
        self.bodies.push(value);
        self.normalize();
    }

    fn normalize(&mut self) {
        self.bodies.sort_by(|a, b| b.key().cmp(&a.key()));
        // Один блоб — одна версия (новейшая запись: дописанная миниатюра, возврат прежней версии)
        let mut seen = BTreeSet::new();
        self.bodies.retain(|b| seen.insert(b.blob.file_id.clone()));
        let mut evicted: Vec<Body> = Vec::new();
        let gone: BTreeSet<String> = self.gone.iter().map(|g| g.file_id.clone()).collect();
        self.bodies.retain(|b| !gone.contains(&b.blob.file_id));
        if self.bodies.len() > VERSIONS_KEEP {
            evicted.extend(self.bodies.split_off(VERSIONS_KEEP));
        }
        for b in evicted {
            for g in b.gone() {
                self.add_gone(g);
            }
        }
        self.gone.sort_by(|a, b| b.cmp(a));
        self.gone.truncate(GONE_KEEP);
    }

    /// Надгробные блобы, на которые не ссылается ни одна версия узла.
    fn gone_blobs(&self) -> impl Iterator<Item = &Gone> {
        let live: BTreeSet<&str> = self.bodies.iter().flat_map(Body::file_ids).collect();
        self.gone.iter().filter(move |g| !live.contains(g.file_id.as_str()))
    }
}

fn put_max<T: PartialOrd>(slot: &mut Option<T>, value: T) {
    match slot {
        Some(cur) if *cur >= value => {}
        _ => *slot = Some(value),
    }
}

/// Создание: побеждает меньшая метка (при равных — меньший вид, затем меньший `from`).
fn put_created(slot: &mut Option<Created>, value: Created) {
    match slot {
        Some(c) if (&c.stamp, c.kind as i32, &c.from, c.at_ms) <= (&value.stamp, value.kind as i32, &value.from, value.at_ms) => {}
        _ => *slot = Some(value),
    }
}

/// Узел видимого дерева.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewNode {
    pub id: NodeId,
    pub kind: CloudNodeKind,
    /// `None` — корень контейнера.
    pub parent: Option<NodeId>,
    /// Показное имя: при совпадении с соседом — с номером.
    pub name: String,
    pub blob: Option<CloudBlobRef>,
    pub thumb: Option<CloudThumb>,
    pub mtime_ms: u64,
    /// В корзине сам либо вместе с предком.
    pub trashed: bool,
    /// В корзину положен именно этот узел.
    pub trash_top: bool,
    pub trashed_at_ms: u64,
    /// Прежние версии файла, от новой к старой (CLOUD-3).
    pub versions: Vec<ViewVersion>,
    /// Файл прислан собеседником (адрес); пусто — свой.
    pub from: String,
    /// Устройство, записавшее текущее содержимое файла; у папки пусто.
    pub device: String,
}

/// Прежняя версия файла в видимом дереве.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewVersion {
    pub blob: CloudBlobRef,
    pub thumb: Option<CloudThumb>,
    pub mtime_ms: u64,
    /// Устройство, записавшее версию.
    pub device: String,
}

/// Блоб стёртого узла: стирает его устройство владельца блоба.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PurgedBlob {
    pub file_id: String,
    pub uploader: String,
}

/// Сведённое состояние контейнера облака.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CloudState {
    nodes: BTreeMap<NodeId, Node>,
    meta: Option<(Stamp, String)>,
    /// Ревизия состояния (C1, кэш JSON у клиента); в сравнении не участвует.
    cache: StateCache,
}

/// Вставить номер перед расширением: «отчёт.pdf» → «отчёт (2).pdf».
pub fn numbered_name(name: &str, n: usize) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => format!("{} ({}){}", &name[..dot], n, &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

impl CloudState {
    fn node(&mut self, id: NodeId) -> &mut Node {
        self.nodes.entry(id).or_default()
    }

    fn apply_create(&mut self, c: &CloudCreate) -> Result<()> {
        let id = node_id(&c.node_id)?;
        let parent = parent_id(&c.parent_id)?;
        let stamp = Stamp::from_pb(c.stamp.as_ref())?;
        check_name(&c.name)?;
        let kind = CloudNodeKind::try_from(c.kind).map_err(|_| ProtoError::InvalidField("kind"))?;
        match kind {
            CloudNodeKind::Folder if c.blob.is_none() && c.thumb.is_none() => {}
            CloudNodeKind::File => {
                check_blob(c.blob.as_ref().ok_or(ProtoError::InvalidField("blob"))?)?;
                c.thumb.as_ref().map(check_thumb).transpose()?;
            }
            _ => return Err(ProtoError::InvalidField("kind")),
        }
        if c.from.len() > MAX_NAME_BYTES {
            return Err(ProtoError::InvalidField("from"));
        }
        let node = self.node(id);
        let at_ms = if kind == CloudNodeKind::Folder { c.mtime_ms } else { 0 };
        put_created(&mut node.created, Created { stamp: stamp.clone(), kind, from: c.from.clone(), at_ms });
        put_max(&mut node.place, Place { stamp: stamp.clone(), parent, name: c.name.clone() });
        if let Some(blob) = &c.blob {
            node.put_body(body(stamp, blob, c.thumb.as_ref(), c.mtime_ms), &[]);
        }
        Ok(())
    }

    /// Применить одну операцию (идемпотентно и независимо от порядка).
    pub fn apply(&mut self, op: &CloudOp) -> Result<()> {
        self.cache.touch();
        match op.op.as_ref().ok_or(ProtoError::InvalidField("op"))? {
            cloud_op::Op::Create(c) => self.apply_create(c)?,
            cloud_op::Op::Move(m) => {
                let id = node_id(&m.node_id)?;
                let parent = parent_id(&m.parent_id)?;
                let stamp = Stamp::from_pb(m.stamp.as_ref())?;
                check_name(&m.name)?;
                put_max(&mut self.node(id).place, Place { stamp, parent, name: m.name.clone() });
            }
            cloud_op::Op::SetBlob(s) => {
                let id = node_id(&s.node_id)?;
                let stamp = Stamp::from_pb(s.stamp.as_ref())?;
                let blob = s.blob.as_ref().ok_or(ProtoError::InvalidField("blob"))?;
                check_blob(blob)?;
                s.thumb.as_ref().map(check_thumb).transpose()?;
                if s.supersedes.len() > 2 || s.supersedes.iter().any(|f| f.is_empty() || f.len() > 64) {
                    return Err(ProtoError::InvalidField("supersedes"));
                }
                let value = Body { draft_since_ms: s.draft_since_ms, ..body(stamp, blob, s.thumb.as_ref(), s.mtime_ms) };
                self.node(id).put_body(value, &s.supersedes);
            }
            cloud_op::Op::Trash(t) => {
                let id = node_id(&t.node_id)?;
                let stamp = Stamp::from_pb(t.stamp.as_ref())?;
                put_max(&mut self.node(id).trash, Trash { stamp, trashed: t.trashed, at_ms: t.at_ms });
            }
            cloud_op::Op::Purge(p) => {
                let id = node_id(&p.node_id)?;
                Stamp::from_pb(p.stamp.as_ref())?;
                let node = self.node(id);
                node.purged_at = Some(node.purged_at.map_or(p.at_ms, |cur| cur.min(p.at_ms)));
            }
            cloud_op::Op::Meta(m) => {
                let stamp = Stamp::from_pb(m.stamp.as_ref())?;
                check_name(&m.name)?;
                put_max(&mut self.meta, (stamp, m.name.clone()));
            }
            // Черновик T094: не используется.
            cloud_op::Op::Delete(_) => return Err(ProtoError::InvalidField("op")),
        }
        Ok(())
    }

    /// Применить пакет автора `author_device`: метки обязаны нести его
    /// устройство (D-16), иначе отказ на весь пакет. Негодные операции
    /// пропускаются; возвращается число применённых.
    pub fn apply_batch(&mut self, batch: &CloudBatch, author_device: &str) -> Result<usize> {
        let stamps = batch_stamps(batch)?;
        if stamps.iter().any(|s| s.device_id != author_device) {
            return Err(ProtoError::ContextMismatch);
        }
        Ok(batch.ops.iter().filter(|op| self.apply(op).is_ok()).count())
    }

    /// Пакет чужой операции: то же, что `apply_batch`, но блоб файла обязан быть загружен самим автором
    /// (`uploader` — один из его адресов). Иначе участник папки записал бы чужой `uploader`, и устройство
    /// жертвы при сборке мусора стёрло бы свой блоб (облачный файл другой папки, медиа чата).
    pub fn apply_batch_from(&mut self, batch: &CloudBatch, author: &Author) -> Result<usize> {
        for op in &batch.ops {
            let blob = match op.op.as_ref() {
                Some(cloud_op::Op::Create(c)) => c.blob.as_ref(),
                Some(cloud_op::Op::SetBlob(s)) => s.blob.as_ref(),
                _ => None,
            };
            if blob.is_some_and(|b| !author.names().any(|n| n == b.uploader)) {
                return Err(ProtoError::ContextMismatch);
            }
        }
        self.apply_batch(batch, &author.device_id)
    }

    /// Название контейнера (совместной папки).
    pub fn name(&self) -> &str {
        self.meta.as_ref().map_or("", |(_, n)| n.as_str())
    }

    fn exists(&self, id: &NodeId) -> bool {
        self.nodes.get(id).is_some_and(|n| n.created.is_some())
    }

    fn is_folder(&self, id: &NodeId) -> bool {
        self.nodes.get(id).and_then(|n| n.created.as_ref()).is_some_and(|c| c.kind == CloudNodeKind::Folder)
    }

    /// Локальная правка содержимого — версия истории (CLOUD-3): правка того же устройства в окне черновика
    /// заменяет черновик (`supersedes`), иначе остаётся отдельной версией. `keep` — версия не черновая
    /// (возврат прежней версии): её следующая правка не заменит. Вызывается до меток (`stamp_batch`).
    pub fn coalesce_local(&self, batch: &mut CloudBatch, device_id: &str, keep: &BTreeSet<usize>) {
        for (i, op) in batch.ops.iter_mut().enumerate() {
            let Some(cloud_op::Op::SetBlob(s)) = op.op.as_mut() else { continue };
            s.supersedes.clear();
            s.draft_since_ms = 0;
            if keep.contains(&i) {
                continue;
            }
            let mtime = s.mtime_ms.max(1);
            let cur = s.node_id.as_slice().try_into().ok().and_then(|id: NodeId| self.nodes.get(&id)).and_then(Node::body);
            let new_file = s.blob.as_ref().map_or("", |b| b.file_id.as_str());
            s.draft_since_ms = match cur {
                // Та же запись (дописанная миниатюра): окно прежнее
                Some(c) if c.blob.file_id == new_file => c.draft_since_ms,
                Some(c) if c.draft_since_ms > 0
                    && c.stamp.device_id == device_id
                    && mtime >= c.draft_since_ms
                    && mtime - c.draft_since_ms < DRAFT_WINDOW_MS =>
                {
                    s.supersedes = c.file_ids().map(str::to_string).collect();
                    c.draft_since_ms
                }
                _ => mtime,
            };
        }
    }

    /// Родители узлов после разбора оторванных и циклов (`None` — корень).
    fn parents(&self) -> BTreeMap<NodeId, Option<NodeId>> {
        let mut parents: BTreeMap<NodeId, Option<NodeId>> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.created.is_some())
            .map(|(id, n)| {
                let p = n.place.as_ref().and_then(|p| p.parent).filter(|p| p != id && self.is_folder(p));
                (*id, p)
            })
            .collect();
        // Обход функционального графа: 1 — на текущем пути, 2 — разобран.
        let mut color: BTreeMap<NodeId, u8> = BTreeMap::new();
        let ids: Vec<NodeId> = parents.keys().copied().collect();
        for start in ids {
            let mut path = Vec::new();
            let mut cur = Some(start);
            while let Some(id) = cur {
                match color.get(&id) {
                    Some(2) => break,
                    Some(_) => {
                        // Цикл: от первого вхождения id до конца пути.
                        let from = path.iter().position(|p| *p == id).unwrap_or(0);
                        let top = path[from..]
                            .iter()
                            .max_by_key(|n| (self.nodes.get(*n).and_then(|x| x.place.as_ref()).map(|p| p.stamp.clone()), **n))
                            .copied();
                        if let Some(top) = top {
                            parents.insert(top, None);
                        }
                        break;
                    }
                    None => {
                        color.insert(id, 1);
                        path.push(id);
                        cur = parents.get(&id).copied().flatten();
                    }
                }
            }
            for id in path {
                color.insert(id, 2);
            }
        }
        parents
    }

    /// Для каждого существующего узла: стёрт ли он (сам или с предком) и
    /// состояние корзины (сам, с предком, время).
    fn fates(&self, parents: &BTreeMap<NodeId, Option<NodeId>>) -> BTreeMap<NodeId, (bool, bool, bool, u64)> {
        // (purged, trashed, trash_top, trashed_at)
        let mut out: BTreeMap<NodeId, (bool, bool, bool, u64)> = BTreeMap::new();
        for start in parents.keys() {
            let mut chain = Vec::new();
            let mut cur = Some(*start);
            let mut inherited = (false, false, 0u64);
            while let Some(id) = cur {
                if let Some((purged, trashed, _, at)) = out.get(&id) {
                    inherited = (*purged, *trashed, *at);
                    break;
                }
                chain.push(id);
                cur = parents.get(&id).copied().flatten();
            }
            for id in chain.into_iter().rev() {
                let node = &self.nodes[&id];
                let own_trash = node.trash.as_ref().filter(|t| t.trashed);
                let purged = inherited.0 || node.purged_at.is_some();
                let trash_top = own_trash.is_some() && !inherited.1;
                let trashed = inherited.1 || own_trash.is_some();
                let at = if inherited.1 { inherited.2 } else { own_trash.map_or(0, |t| t.at_ms) };
                out.insert(id, (purged, trashed, trash_top, at));
                inherited = (purged, trashed, at);
            }
        }
        out
    }

    /// Видимое дерево: существующие нестёртые узлы с показными именами.
    pub fn view(&self) -> Vec<ViewNode> {
        let parents = self.parents();
        let fates = self.fates(&parents);
        let mut out: Vec<ViewNode> = Vec::new();
        for (id, parent) in &parents {
            let (purged, trashed, trash_top, trashed_at_ms) = fates[id];
            if purged {
                continue;
            }
            let node = &self.nodes[id];
            let Some(created) = node.created.as_ref() else { continue };
            let kind = created.kind;
            let file = kind == CloudNodeKind::File;
            let versions = if file {
                node.bodies
                    .iter()
                    .skip(1)
                    .map(|b| ViewVersion { blob: b.blob.clone(), thumb: b.thumb.clone(), mtime_ms: b.mtime_ms, device: b.stamp.device_id.clone() })
                    .collect()
            } else {
                Vec::new()
            };
            out.push(ViewNode {
                id: *id,
                kind,
                parent: *parent,
                name: node.place.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
                blob: node.body().filter(|_| file).map(|b| b.blob.clone()),
                thumb: node.body().filter(|_| file).and_then(|b| b.thumb.clone()),
                mtime_ms: node.body().filter(|_| file).map_or(created.at_ms, |b| b.mtime_ms),
                trashed,
                trash_top,
                trashed_at_ms,
                versions,
                from: created.from.clone(),
                device: node.body().filter(|_| file).map(|b| b.stamp.device_id.clone()).unwrap_or_default(),
            });
        }
        // Совпавшие имена соседей вне корзины: старший по созданию хранит
        // имя, остальные получают номер.
        let mut by_parent: BTreeMap<Option<NodeId>, Vec<usize>> = BTreeMap::new();
        for (i, n) in out.iter().enumerate() {
            if !n.trashed {
                by_parent.entry(n.parent).or_default().push(i);
            }
        }
        for mut idx in by_parent.into_values() {
            let raw: BTreeSet<String> = idx.iter().map(|i| out[*i].name.clone()).collect();
            idx.sort_by_key(|i| (self.nodes[&out[*i].id].created.as_ref().map(|c| c.stamp.clone()), out[*i].id));
            let mut taken: BTreeSet<String> = BTreeSet::new();
            for i in idx {
                let name = out[i].name.clone();
                if taken.insert(name.clone()) {
                    continue;
                }
                let mut n = 2;
                let shown = loop {
                    let candidate = numbered_name(&name, n);
                    if !raw.contains(&candidate) && !taken.contains(&candidate) {
                        break candidate;
                    }
                    n += 1;
                };
                taken.insert(shown.clone());
                out[i].name = shown;
            }
        }
        out
    }

    /// Число существующих нестёртых узлов.
    pub fn live_count(&self) -> usize {
        let parents = self.parents();
        self.fates(&parents).values().filter(|f| !f.0).count()
    }

    /// Блобы, которые пора стереть: все версии стёртых узлов (сами и потомки стёртых папок) и вытесненные
    /// либо заменённые версии живых (CLOUD-3).
    pub fn purged_blobs(&self) -> Vec<PurgedBlob> {
        let parents = self.parents();
        let fates = self.fates(&parents);
        let mut out = BTreeSet::new();
        for (id, fate) in &fates {
            let node = &self.nodes[id];
            if fate.0 {
                for b in &node.bodies {
                    for f in b.file_ids() {
                        out.insert(PurgedBlob { file_id: f.to_string(), uploader: b.blob.uploader.clone() });
                    }
                }
                for g in &node.gone {
                    out.insert(PurgedBlob { file_id: g.file_id.clone(), uploader: g.uploader.clone() });
                }
            } else {
                for g in node.gone_blobs() {
                    out.insert(PurgedBlob { file_id: g.file_id.clone(), uploader: g.uploader.clone() });
                }
            }
        }
        out.into_iter().collect()
    }

    /// spec 035 (FR-035, T054): заменяющий снимок журнала контейнера до `upto_seq` — только если отметки
    /// `range-hold` не накрывают диапазон; иначе `RangeHeld` (FR-034). Показ — `view()`.
    pub fn replacement_snapshot(&self, holds: &[crate::pb::parvane::engine::v1::RangeHold], container: &crate::pb::parvane::core::v2::Container, upto_seq: u64, now_ms: u64) -> Result<CloudSnapshot> {
        super::replacement_allowed(holds, container, upto_seq)?;
        Ok(self.to_snapshot(now_ms))
    }

    /// Снимок: узлы с регистрами. Стёртые давнее
    /// `PURGED_KEEP_MS` (сами и их потомки) в снимок не попадают.
    pub fn to_snapshot(&self, now_ms: u64) -> CloudSnapshot {
        let parents = self.parents();
        // Узел уходит из снимка, если у него или у предка надгробие старше срока.
        let old = |id: &NodeId| {
            let mut cur = Some(*id);
            while let Some(i) = cur {
                if self.nodes[&i].purged_at.is_some_and(|at| at.saturating_add(PURGED_KEEP_MS) < now_ms) {
                    return true;
                }
                cur = parents.get(&i).copied().flatten();
            }
            false
        };
        let mut devices: Vec<String> = Vec::new();
        let mut dev = |s: &Stamp| -> u32 {
            match devices.iter().position(|d| *d == s.device_id) {
                Some(i) => i as u32,
                None => {
                    devices.push(s.device_id.clone());
                    (devices.len() - 1) as u32
                }
            }
        };
        let mut entries = Vec::new();
        for (id, node) in &self.nodes {
            if old(id) {
                continue;
            }
            // Узел без создания (регистры пришли раньше) — вид не задан, метка создания 0.
            let mut e = CloudEntry {
                node_id: id.to_vec(),
                kind: node.created.as_ref().map_or(CloudNodeKind::Unspecified, |c| c.kind) as i32,
                create_lamport: node.created.as_ref().map_or(0, |c| c.stamp.lamport),
                create_dev: node.created.as_ref().map_or(0, |c| dev(&c.stamp)),
                from: node.created.as_ref().map(|c| c.from.clone()).unwrap_or_default(),
                created_ms: node.created.as_ref().map_or(0, |c| c.at_ms),
                purged: node.purged_at.is_some(),
                purged_at_ms: node.purged_at.unwrap_or(0),
                ..Default::default()
            };
            if let Some(p) = &node.place {
                e.parent_id = p.parent.map(|p| p.to_vec()).unwrap_or_default();
                e.name = p.name.clone();
                e.move_lamport = p.stamp.lamport;
                e.move_dev = dev(&p.stamp);
            }
            if let Some(b) = node.body() {
                e.blob = Some(b.blob.clone());
                e.thumb = b.thumb.clone();
                e.mtime_ms = b.mtime_ms;
                e.blob_lamport = b.stamp.lamport;
                e.blob_dev = dev(&b.stamp);
                e.draft_since_ms = b.draft_since_ms;
            }
            for b in node.bodies.iter().skip(1) {
                e.versions.push(CloudVersion {
                    blob: Some(b.blob.clone()),
                    thumb: b.thumb.clone(),
                    mtime_ms: b.mtime_ms,
                    lamport: b.stamp.lamport,
                    dev: dev(&b.stamp),
                    draft_since_ms: b.draft_since_ms,
                });
            }
            for g in &node.gone {
                e.gone.push(CloudGone { file_id: g.file_id.clone(), uploader: g.uploader.clone(), lamport: g.stamp.lamport, dev: dev(&g.stamp) });
            }
            if let Some(t) = &node.trash {
                e.trashed = t.trashed;
                e.trashed_at_ms = t.at_ms;
                e.trash_lamport = t.stamp.lamport;
                e.trash_dev = dev(&t.stamp);
            }
            entries.push(e);
        }
        let meta = self.meta.as_ref().map(|(s, n)| CloudMeta { name: n.clone(), stamp: Some(s.to_pb()) });
        CloudSnapshot { nodes: Vec::new(), devices, meta, entries }
    }

    /// Слить снимок (идемпотентно, как применение тех же регистров).
    pub fn merge_snapshot(&mut self, s: &CloudSnapshot) -> Result<()> {
        self.cache.touch();
        let stamp = |lamport: u64, dev: u32| -> Result<Stamp> {
            let device = s.devices.get(dev as usize).ok_or(ProtoError::InvalidField("devices"))?;
            if lamport == 0 || !crate::address::is_valid_device_id(device) {
                return Err(ProtoError::InvalidField("stamp"));
            }
            Ok(Stamp::new(lamport, device))
        };
        if let Some(m) = &s.meta {
            check_name(&m.name)?;
            put_max(&mut self.meta, (Stamp::from_pb(m.stamp.as_ref())?, m.name.clone()));
        }
        for e in &s.entries {
            let id = node_id(&e.node_id)?;
            let kind = CloudNodeKind::try_from(e.kind).map_err(|_| ProtoError::InvalidField("kind"))?;
            let created = match (kind, e.create_lamport) {
                (CloudNodeKind::Unspecified, 0) => None,
                (CloudNodeKind::Unspecified, _) | (_, 0) => return Err(ProtoError::InvalidField("kind")),
                _ => Some((stamp(e.create_lamport, e.create_dev)?, kind)),
            };
            let place = if e.move_lamport > 0 {
                check_name(&e.name)?;
                Some(Place { stamp: stamp(e.move_lamport, e.move_dev)?, parent: parent_id(&e.parent_id)?, name: e.name.clone() })
            } else {
                None
            };
            let mut bodies = Vec::new();
            if let (Some(blob), true) = (&e.blob, e.blob_lamport > 0) {
                check_blob(blob)?;
                e.thumb.as_ref().map(check_thumb).transpose()?;
                let b = body(stamp(e.blob_lamport, e.blob_dev)?, blob, e.thumb.as_ref(), e.mtime_ms);
                bodies.push(Body { draft_since_ms: e.draft_since_ms, ..b });
            }
            for v in &e.versions {
                let blob = v.blob.as_ref().ok_or(ProtoError::InvalidField("versions"))?;
                check_blob(blob)?;
                v.thumb.as_ref().map(check_thumb).transpose()?;
                let b = body(stamp(v.lamport, v.dev)?, blob, v.thumb.as_ref(), v.mtime_ms);
                bodies.push(Body { draft_since_ms: v.draft_since_ms, ..b });
            }
            let mut gone = Vec::new();
            for g in &e.gone {
                if g.file_id.is_empty() || g.file_id.len() > 64 || g.uploader.len() > MAX_NAME_BYTES {
                    return Err(ProtoError::InvalidField("gone"));
                }
                gone.push(Gone { stamp: stamp(g.lamport, g.dev)?, file_id: g.file_id.clone(), uploader: g.uploader.clone() });
            }
            if e.from.len() > MAX_NAME_BYTES {
                return Err(ProtoError::InvalidField("from"));
            }
            let trash = if e.trash_lamport > 0 {
                Some(Trash { stamp: stamp(e.trash_lamport, e.trash_dev)?, trashed: e.trashed, at_ms: e.trashed_at_ms })
            } else {
                None
            };
            let node = self.node(id);
            if let Some((stamp, kind)) = created {
                put_created(&mut node.created, Created { stamp, kind, from: e.from.clone(), at_ms: e.created_ms });
            }
            if let Some(p) = place {
                put_max(&mut node.place, p);
            }
            if !bodies.is_empty() || !gone.is_empty() {
                for g in gone {
                    node.add_gone(g);
                }
                node.bodies.extend(bodies);
                node.normalize();
            }
            if let Some(t) = trash {
                put_max(&mut node.trash, t);
            }
            if e.purged {
                node.purged_at = Some(node.purged_at.map_or(e.purged_at_ms, |cur| cur.min(e.purged_at_ms)));
            }
        }
        Ok(())
    }

    pub fn from_snapshot(s: &CloudSnapshot) -> Result<Self> {
        let mut st = Self::default();
        st.merge_snapshot(s)?;
        Ok(st)
    }

    /// Наибольшая метка состояния (для часов устройства после снимка).
    pub fn max_lamport(&self) -> u64 {
        let node_max = self.nodes.values().flat_map(|n| {
            [
                n.created.as_ref().map(|c| c.stamp.lamport),
                n.place.as_ref().map(|p| p.stamp.lamport),
                n.bodies.iter().map(|b| b.stamp.lamport).max(),
                n.gone.iter().map(|g| g.stamp.lamport).max(),
                n.trash.as_ref().map(|t| t.stamp.lamport),
            ]
        });
        node_max.flatten().chain(self.meta.as_ref().map(|m| m.0.lamport)).max().unwrap_or(0)
    }

    /// Размер открытого текста снимка.
    pub fn size_estimate(&self, now_ms: u64) -> usize {
        self.to_snapshot(now_ms).encoded_len()
    }

    /// Ревизия состояния: растёт при каждой правке и слиянии снимка.
    pub fn rev(&self) -> u64 {
        self.cache.rev()
    }

    /// Проверка локальной правки перед отправкой: предел узлов, родитель —
    /// существующая папка, перемещение не в себя и не в потомка.
    pub fn check_local(&self, batch: &CloudBatch) -> Result<()> {
        let mut next = self.clone();
        for op in &batch.ops {
            next.apply(op)?;
        }
        let parents = next.parents();
        // Последнее запрошенное место каждого узла пакета.
        let mut asked: BTreeMap<NodeId, Option<NodeId>> = BTreeMap::new();
        for op in &batch.ops {
            match op.op.as_ref() {
                Some(cloud_op::Op::Create(c)) => asked.insert(node_id(&c.node_id)?, parent_id(&c.parent_id)?),
                Some(cloud_op::Op::Move(m)) => asked.insert(node_id(&m.node_id)?, parent_id(&m.parent_id)?),
                _ => None,
            };
        }
        for (id, parent) in asked {
            if !next.exists(&id) {
                return Err(ProtoError::InvalidField("node_id"));
            }
            // Родитель обязан остаться тем, что просили: иначе он не папка,
            // неизвестен либо перемещение замкнуло цикл.
            if parents.get(&id).copied().flatten() != parent {
                return Err(ProtoError::InvalidField("parent_id"));
            }
        }
        if next.live_count() > MAX_NODES {
            return Err(ProtoError::FieldLimit("nodes"));
        }
        Ok(())
    }
}

fn op_stamp(op: &CloudOp) -> Option<&crate::pb::parvane::core::v2::LwwStamp> {
    match op.op.as_ref()? {
        cloud_op::Op::Create(c) => c.stamp.as_ref(),
        cloud_op::Op::Move(m) => m.stamp.as_ref(),
        cloud_op::Op::SetBlob(s) => s.stamp.as_ref(),
        cloud_op::Op::Trash(t) => t.stamp.as_ref(),
        cloud_op::Op::Purge(p) => p.stamp.as_ref(),
        cloud_op::Op::Meta(m) => m.stamp.as_ref(),
        cloud_op::Op::Delete(d) => d.stamp.as_ref(),
    }
}

/// Все метки пакета (для проверки автора и LamportGuard).
pub fn batch_stamps(batch: &CloudBatch) -> Result<Vec<Stamp>> {
    if batch.ops.is_empty() {
        return Err(ProtoError::InvalidField("ops"));
    }
    batch.ops.iter().map(|op| Stamp::from_pb(op_stamp(op))).collect()
}

/// Проверить метки пакета в порядке журнала (D-16).
pub fn guard_batch(guard: &mut LamportGuard, batch: &CloudBatch) -> Result<()> {
    for s in batch_stamps(batch)? {
        guard.check(&s)?;
    }
    Ok(())
}

/// Метки снимка против часов (D-16 для снимка): наибольший lamport не выше того, что могли накопить
/// `upto_seq` операций, каждая из которых проходила `LamportGuard` (скачок не больше
/// `LAMPORT_MAX_JUMP`). Иначе метка ~u64::MAX навсегда выигрывала бы любую правку узла, а подъём
/// часов шагами по 2^20 зависал бы. Возвращает наибольшую метку (поднять часы — после слияния).
pub fn guard_snapshot(guard: &LamportGuard, s: &CloudSnapshot, upto_seq: u64) -> Result<u64> {
    let mut max = s.meta.as_ref().and_then(|m| m.stamp.as_ref()).map_or(0, |x| x.lamport);
    for e in &s.entries {
        max = max.max(e.create_lamport).max(e.move_lamport).max(e.blob_lamport).max(e.trash_lamport);
        max = e.versions.iter().map(|v| v.lamport).chain(e.gone.iter().map(|g| g.lamport)).fold(max, u64::max);
    }
    let limit = guard.max_seen().saturating_add(super::LAMPORT_MAX_JUMP.saturating_mul(upto_seq.max(1)));
    if max > limit {
        return Err(ProtoError::InvalidField("lamport"));
    }
    Ok(max)
}

/// Проставить метки операциям локального пакета: каждой — следующую метку
/// устройства (операции одного пакета над одним узлом упорядочены).
pub fn stamp_batch(batch: &mut CloudBatch, device_id: &str, guard: &mut LamportGuard) {
    for op in &mut batch.ops {
        let pb = Some(Stamp::new(guard.tick(), device_id).to_pb());
        match &mut op.op {
            Some(cloud_op::Op::Create(c)) => c.stamp = pb,
            Some(cloud_op::Op::Move(m)) => m.stamp = pb,
            Some(cloud_op::Op::SetBlob(s)) => s.stamp = pb,
            Some(cloud_op::Op::Trash(t)) => t.stamp = pb,
            Some(cloud_op::Op::Purge(p)) => p.stamp = pb,
            Some(cloud_op::Op::Meta(m)) => m.stamp = pb,
            Some(cloud_op::Op::Delete(_)) | None => {}
        }
    }
}
