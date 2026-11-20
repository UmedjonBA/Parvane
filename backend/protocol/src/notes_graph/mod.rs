//! Граф заметок и «холст из графа» (spec 040, правило NOTES-1): раскладка считается здесь один раз для всех
//! клиентов — клиент передаёт заметки и область, получает готовые координаты и только рисует.
//!
//! Вызовы без состояния (`host::call::call_static`): `notesGraphLayout` и `notesGraphCanvas`; вход и выход — JSON.
//! Результат зависит только от входа: одно зерно (`seed`) даёт одну раскладку на всех устройствах, поэтому в
//! расчёте только `+ − × ÷ √` и округления (без синусов и степеней, чьи последние биты у платформ расходятся),
//! порядок обхода — порядок входа, координаты на выходе — целые.
//!
//! Модули: `build` — узлы, связи и область; `force` — силовая раскладка связной группы; `labels` — сторона
//! подписи; `separate` — снятие наложений; `pack` — упаковка групп и одиночек; `edges` — форма связей;
//! `layout` — сборка графа; `canvas` — холст уровнями. Общий образец — `conformance/notes-graph/cases.json`.

mod build;
mod canvas;
mod edges;
mod force;
mod labels;
mod layout;
mod pack;
mod rng;
mod separate;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Заметка на входе: ссылки — названия заметок (`[[…]]`), метки — как в заметке (с `#` либо без).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteIn {
    pub id: String,
    pub title: String,
    /// Путь папки через `/`; корень — пустая строка.
    pub folder: String,
    pub links: Vec<String>,
    pub tags: Vec<String>,
    /// Заметка дня: показ включает `withDays`, выбор папки и метки её не касается.
    pub is_daily: bool,
}

/// Запись «Плана», ссылающаяся на заметки (узел `record`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordIn {
    pub id: String,
    pub title: String,
    pub links: Vec<String>,
    /// Тип записи — попадает в `group` узла.
    #[serde(rename = "type")]
    pub kind: String,
}

/// Закреплённый узел: id и место центра.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct PinIn {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

/// Область графа.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    /// Все заметки.
    #[default]
    All,
    /// Папка вместе с подпапками.
    Folder {
        #[serde(default)]
        folder: String,
    },
    /// Заметка и её соседи до глубины 1–3 (иное приводится к границам).
    Around {
        #[serde(default)]
        note: String,
        #[serde(default)]
        depth: u32,
    },
    /// Заметки с меткой (и вложенными `метка/…`).
    Tag {
        #[serde(default)]
        tag: String,
    },
}

/// Вход обоих вызовов. Размеры — в единицах поля графа (пиксели при масштабе 1); не заданы — значения движка.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Input {
    pub notes: Vec<NoteIn>,
    pub records: Vec<RecordIn>,
    pub scope: Scope,
    /// Не показывать узлы без связей.
    pub hide_orphans: bool,
    /// Не показывать заметки, которых ещё нет (ссылка есть, заметки нет).
    pub hide_missing: bool,
    pub with_days: bool,
    pub with_records: bool,
    /// Зерно раскладки (целое до 2^53).
    pub seed: f64,
    /// Отношение ширины поля к высоте, к которому стремится упаковка.
    pub aspect: Option<f64>,
    /// Граф: ширина знака подписи, наибольшая ширина и высота подписи.
    pub char_width: Option<f64>,
    pub label_max_width: Option<f64>,
    pub label_height: Option<f64>,
    /// Закреплённые узлы (spec 040 T10): точки, переставленные руками, стоят ровно здесь (центр узла в
    /// координатах прошлого ответа); их связная группа раскладывается вокруг них и в упаковке не двигается.
    pub pinned: Vec<PinIn>,
    /// Холст: размер карточки, просвет и шаг сетки.
    pub card_width: Option<f64>,
    pub card_height: Option<f64>,
    pub gap: Option<f64>,
    pub grid: Option<f64>,
}

/// Вид узла.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Note,
    Missing,
    Day,
    Record,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Note => "note",
            Kind::Missing => "missing",
            Kind::Day => "day",
            Kind::Record => "record",
        }
    }
}

/// Подпись узла: прямоугольник и сторона; `show: false` — места без наложений не нашлось, клиент показывает
/// её только по наведению.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LabelOut {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub side: &'static str,
    pub show: bool,
}

/// Узел: центр, радиус, подпись и номер блока (`blocks`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NodeOut {
    pub id: String,
    pub title: String,
    pub kind: &'static str,
    /// Папка заметки либо тип записи.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Число разных соседей.
    pub degree: usize,
    pub x: i64,
    pub y: i64,
    pub r: i64,
    pub label: LabelOut,
    pub block: usize,
}

/// Связь `from → to` (ссылка); `mutual` — есть и обратная. Линия — квадратичная кривая от `(x1, y1)` до
/// `(x2, y2)` (края кружков) с опорной точкой `(cx, cy)`; `curved: false` — прямая.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EdgeOut {
    pub from: String,
    pub to: String,
    pub mutual: bool,
    pub x1: i64,
    pub y1: i64,
    pub cx: i64,
    pub cy: i64,
    pub x2: i64,
    pub y2: i64,
    pub curved: bool,
}

/// Блок упаковки: связная группа (`group`) либо ряд одиночек (`singles`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BlockOut {
    pub kind: &'static str,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub nodes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BoundsOut {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// Папка для выбора области: путь и число обычных заметок в ней самой.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FolderOut {
    pub path: String,
    pub count: usize,
}

/// Метка для выбора области.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TagOut {
    pub tag: String,
    pub count: usize,
}

/// Ответ `notesGraphLayout`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GraphOut {
    pub nodes: Vec<NodeOut>,
    pub edges: Vec<EdgeOut>,
    pub blocks: Vec<BlockOut>,
    pub bounds: BoundsOut,
    pub folders: Vec<FolderOut>,
    pub tags: Vec<TagOut>,
}

/// Карточка холста: левый верхний угол и размер; `level` — уровень от главной заметки группы.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CardOut {
    pub id: String,
    pub title: String,
    pub kind: &'static str,
    pub folder: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub level: usize,
    pub block: usize,
}

/// Стрелка холста со сторонами карточек (`top`, `bottom`, `left`, `right`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdgeOut {
    pub from: String,
    pub to: String,
    pub mutual: bool,
    pub from_side: &'static str,
    pub to_side: &'static str,
}

/// Ответ `notesGraphCanvas`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CanvasOut {
    pub cards: Vec<CardOut>,
    pub edges: Vec<CanvasEdgeOut>,
    pub blocks: Vec<BlockOut>,
    pub bounds: BoundsOut,
    pub folders: Vec<FolderOut>,
    pub tags: Vec<TagOut>,
}

/// Раскладка графа.
pub fn layout(input: &Input) -> GraphOut {
    layout::layout(input)
}

/// Раскладка «холста из графа».
pub fn canvas(input: &Input) -> CanvasOut {
    canvas::canvas(input)
}

/// `notesGraphLayout`: JSON входа → JSON раскладки; `None` — вход не разобран.
pub fn layout_json(args: &Value) -> Option<Value> {
    let input = Input::deserialize(args).ok()?;
    serde_json::to_value(layout(&input)).ok()
}

/// `notesGraphCanvas`: JSON входа → JSON холста; `None` — вход не разобран.
pub fn canvas_json(args: &Value) -> Option<Value> {
    let input = Input::deserialize(args).ok()?;
    serde_json::to_value(canvas(&input)).ok()
}

/// Число из входа в границах; не задано либо не число — значение движка.
fn setting(value: Option<f64>, default: f64, min: f64, max: f64) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.clamp(min, max),
        _ => default,
    }
}

/// Округление координаты к целому (не число — ноль).
fn int(v: f64) -> i64 {
    if v.is_finite() {
        v.round() as i64
    } else {
        0
    }
}
