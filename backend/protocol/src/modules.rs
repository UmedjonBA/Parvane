//! Модули приложения (spec 041, правило MODULES-1): один плоский список — Чаты, План, Здоровье, Заметки,
//! Файлы, Музыка, Профиль. Состав, порядок и блоки «Здоровья» у каждого устройства свои (не синхронизируются);
//! здесь — единственная реализация правил списка для всех клиентов: приведение сохранённого, что заперто,
//! что выключил администратор сервера, чего в клиенте ещё нет. Клиент хранит настройки как JSON и только
//! показывает результат. Общий образец — `conformance/modules/cases.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Модули в исходном порядке.
pub const MODULES: [&str; 7] = ["chats", "plan", "health", "notes", "files", "music", "profile"];
/// Блоки «Здоровья» в порядке показа.
pub const HEALTH_BLOCKS: [&str; 5] = ["sleep", "body", "food", "water", "workouts"];
/// Не выключаются: без них не открыть ни переписку, ни сам список модулей.
const LOCKED: [&str; 2] = ["chats", "profile"];
const DEFAULT_HEALTH_BLOCKS: [&str; 2] = ["sleep", "body"];
/// Словарь сервера (`ServerDescribeResponse.disabled_modules`) → модуль клиента.
const SERVER_IDS: [(&str, &str); 5] = [("planner", "plan"), ("health", "health"), ("notes", "notes"), ("files", "files"), ("music", "music")];

/// Настройки устройства.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub order: Vec<String>,
    pub off: Vec<String>,
    pub health_blocks: Vec<String>,
}

/// Модуль в списке экрана «Модули».
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleState {
    pub id: &'static str,
    pub is_on: bool,
    pub is_locked: bool,
    /// Выключен администратором сервера: выключатель не действует.
    pub is_server_off: bool,
    /// Экранов модуля в этом клиенте ещё нет: выключатель не действует.
    pub is_unavailable: bool,
}

/// Готовое для показа: приведённые настройки, список и включённые модули в порядке навигации.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub prefs: Prefs,
    pub modules: Vec<ModuleState>,
    pub enabled: Vec<&'static str>,
}

fn known(id: &str, set: &'static [&'static str]) -> Option<&'static str> {
    set.iter().copied().find(|k| *k == id)
}

/// Строки массива JSON, известные набору, без повторов, в порядке массива.
fn pick(raw: Option<&Value>, set: &'static [&'static str]) -> Option<Vec<&'static str>> {
    let list = raw?.as_array()?;
    let mut out: Vec<&'static str> = Vec::new();
    for id in list.iter().filter_map(Value::as_str).filter_map(|id| known(id, set)) {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Some(out)
}

/// Приведение сохранённого: неизвестное отброшено, новый модуль встаёт после того, за кем он стоит в исходном
/// порядке, запертые из выключенных убраны, блоки — в порядке показа. Негодный JSON — настройки по умолчанию.
pub fn normalize(raw: &Value) -> Prefs {
    let mut order = pick(raw.get("order"), &MODULES).unwrap_or_default();
    for (i, id) in MODULES.iter().enumerate() {
        if order.contains(id) {
            continue;
        }
        let at = MODULES[..i].iter().rev().find_map(|prev| order.iter().position(|o| o == prev)).map_or(0, |p| p + 1);
        order.insert(at, id);
    }
    let off = pick(raw.get("off"), &MODULES).unwrap_or_default().into_iter().filter(|id| !LOCKED.contains(id)).collect::<Vec<_>>();
    let picked = pick(raw.get("healthBlocks"), &HEALTH_BLOCKS).unwrap_or_else(|| DEFAULT_HEALTH_BLOCKS.to_vec());
    let blocks = HEALTH_BLOCKS.iter().copied().filter(|b| picked.contains(b));
    Prefs { order: strings(order), off: strings(off), health_blocks: strings(blocks) }
}

fn strings(ids: impl IntoIterator<Item = &'static str>) -> Vec<String> {
    ids.into_iter().map(str::to_string).collect()
}

/// Модули, выключенные сервером: неизвестный идентификатор пропускается, пустой список — выключенных нет.
pub fn server_off(raw: &Value) -> Vec<&'static str> {
    let mut out = Vec::new();
    for id in raw.as_array().into_iter().flatten().filter_map(Value::as_str) {
        if let Some((_, module)) = SERVER_IDS.iter().find(|(server, _)| *server == id) {
            if !out.contains(module) {
                out.push(*module);
            }
        }
    }
    out
}

/// Список для показа. `available` — модули, экраны которых есть в клиенте (`null` — все).
pub fn view(raw_prefs: &Value, raw_server_off: &Value, available: &Value) -> View {
    let prefs = normalize(raw_prefs);
    let off_by_server = server_off(raw_server_off);
    let has_screens = pick(Some(available), &MODULES);
    let modules: Vec<ModuleState> = prefs
        .order
        .iter()
        .filter_map(|id| known(id, &MODULES))
        .map(|id| {
            let is_locked = LOCKED.contains(&id);
            let is_server_off = off_by_server.contains(&id);
            let is_unavailable = !is_locked && has_screens.as_ref().is_some_and(|a| !a.contains(&id));
            let is_on = is_locked || (!is_server_off && !is_unavailable && !prefs.off.iter().any(|o| o == id));
            ModuleState { id, is_on, is_locked, is_server_off, is_unavailable }
        })
        .collect();
    let enabled = modules.iter().filter(|m| m.is_on).map(|m| m.id).collect();
    View { prefs, modules, enabled }
}

/// Включить либо выключить модуль; запертый и неизвестный — без изменений.
pub fn set_on(raw: &Value, id: &str, on: bool) -> Prefs {
    let mut prefs = normalize(raw);
    let Some(id) = known(id, &MODULES).filter(|id| !LOCKED.contains(id)) else { return prefs };
    prefs.off.retain(|o| o != id);
    if !on {
        prefs.off.push(id.to_string());
    }
    prefs
}

/// Переставить модуль на место `to` (индекс в списке после изъятия модуля; за пределами — в край).
pub fn move_to(raw: &Value, id: &str, to: i64) -> Prefs {
    let mut prefs = normalize(raw);
    let Some(from) = prefs.order.iter().position(|o| o == id) else { return prefs };
    let moved = prefs.order.remove(from);
    let at = usize::try_from(to.max(0)).unwrap_or(0).min(prefs.order.len());
    prefs.order.insert(at, moved);
    prefs
}

/// Включить либо выключить блок «Здоровья»; неизвестный — без изменений.
pub fn set_block(raw: &Value, block: &str, on: bool) -> Prefs {
    let mut prefs = normalize(raw);
    let Some(block) = known(block, &HEALTH_BLOCKS) else { return prefs };
    let mut picked: Vec<&str> = prefs.health_blocks.iter().map(String::as_str).filter(|b| *b != block).collect();
    if on {
        picked.push(block);
    }
    prefs.health_blocks = HEALTH_BLOCKS.iter().filter(|b| picked.contains(b)).map(|b| b.to_string()).collect();
    prefs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_and_locked_modules() {
        let v = view(&Value::Null, &Value::Null, &Value::Null);
        assert_eq!(v.enabled, MODULES);
        assert_eq!(v.prefs.health_blocks, ["sleep", "body"]);
        let p = set_on(&set_to_value(&set_on(&Value::Null, "chats", false)), "profile", false);
        assert!(p.off.is_empty(), "Чаты и Профиль не выключаются");
    }

    fn set_to_value(p: &Prefs) -> Value {
        serde_json::to_value(p).unwrap()
    }

    #[test]
    fn mutations_keep_prefs_normalized() {
        let p = move_to(&json!({"order": ["notes", "chats", "wiki", "profile"]}), "health", 0);
        assert_eq!(p.order, ["health", "notes", "files", "music", "chats", "plan", "profile"]);
        assert_eq!(move_to(&set_to_value(&p), "health", 99).order.last().map(String::as_str), Some("health"));
        assert_eq!(move_to(&set_to_value(&p), "wiki", 1), p, "неизвестный модуль порядок не меняет");
        let b = set_block(&set_to_value(&set_block(&Value::Null, "water", true)), "sleep", false);
        assert_eq!(b.health_blocks, ["body", "water"]);
        assert_eq!(set_block(&set_to_value(&b), "nope", true), b);
    }
}
