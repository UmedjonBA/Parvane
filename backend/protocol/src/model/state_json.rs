//! Личное состояние для клиентов по видам (spec 036 E5, ENGINE-1): показ объектов `state.v2` значением в
//! proto3-JSON сообщения вида (`viewStateJson`) и запись одним намерением (`stateSet` / `stateMark`). Клиент не
//! кодирует поля и не сравнивает метки: движок сам разбирает схему вида, считает разницу с показанным и выпускает
//! `Create` / `Patch` (изменившиеся поля, `clear` пропавших) / `Delete`. Поле верхнего уровня — регистр целиком,
//! списки тоже. Прежний мост снимка `state.v1` (`stateApplyV1`/`stateViewV1`) удалён (spec 036 T038).

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{json, Value};

use super::{split_fields, Engine, Outcome, Work};
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::state::v2::{self as s2, state_op::Op as SOp, ObjectKey, ObjectKind};
use crate::state2;

fn kind_of(name: &str) -> Result<i32> {
    let k = ObjectKind::from_str_name(name)
        .or_else(|| ObjectKind::from_str_name(&format!("OBJECT_KIND_{}", name.to_ascii_uppercase())))
        .ok_or(ProtoError::InvalidField("kind"))?;
    if k == ObjectKind::Unspecified {
        return Err(ProtoError::InvalidField("kind"));
    }
    Ok(k as i32)
}

fn kind_name(kind: i32) -> String {
    ObjectKind::try_from(kind).map(|k| k.as_str_name().to_string()).unwrap_or_else(|_| kind.to_string())
}

/// Аргументы `viewStateJson`.
#[derive(Debug, Default, Deserialize)]
pub struct ViewArgs {
    #[serde(default)]
    pub kinds: Vec<String>,
}

/// Аргументы `stateSet`: создать/заменить объект значением (`value` — proto3-JSON сообщения вида; признак без
/// значения — `{}`) либо удалить (`delete`). `base` (spec 036, desktop) — значение, которое хост показывал, когда
/// строил `value`: меняются только поля, где `value` отличается от `base` (правка другого устройства, сведённая
/// моделью после показа, не откатывается устаревшей копией хоста); без `base` — разница с текущим объектом модели.
#[derive(Debug, Default, Deserialize)]
pub struct SetArgs {
    pub kind: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub delete: bool,
    #[serde(default)]
    pub base: Value,
    /// Переписать объект целиком (`Create` всеми полями `value`, даже если модель уже держит то же): новый ключ
    /// личного состояния — прежние записи новым ключом не читаются (spec 036 T019 web, T038 desktop/android).
    #[serde(default)]
    pub rewrite: bool,
}

/// Аргументы `stateMark`: отметка поля (только растёт; `value` — base64 байтов отметки).
#[derive(Debug, Default, Deserialize)]
pub struct MarkArgs {
    pub kind: String,
    #[serde(default)]
    pub key: String,
    pub field: u32,
    pub value: String,
}

fn value_json(kind: i32, bytes: &[u8]) -> Value {
    let Some(t) = state2::value_type(kind) else { return json!({}) };
    match crate::type_codec::decode_by_type(t, bytes, Origin::Server) {
        Some(Ok(s)) => serde_json::from_str(&s).unwrap_or(json!({})),
        _ => json!({}),
    }
}

impl Engine {
    /// Объекты видов `kinds` (пусто — все видимые): `{objects: [{kind, key, value, marks: [{field, value}]}],
    /// write_blocked}` — `write_blocked`: журнал закрыт для записи более новой версией (T117; spec 036 T019, web).
    pub fn view_state_json(&self, a: &ViewArgs) -> Result<Value> {
        let kinds: Vec<i32> = a.kinds.iter().map(|k| kind_of(k)).collect::<Result<_>>()?;
        let objects: Vec<Value> = self
            .state
            .view()
            .into_iter()
            .filter(|v| kinds.is_empty() || kinds.contains(&v.kind))
            .map(|v| {
                let marks: Vec<Value> = v
                    .marks
                    .iter()
                    .map(|(f, m)| json!({"field": f, "value": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, m)}))
                    .collect();
                json!({"kind": kind_name(v.kind), "key": v.key, "value": value_json(v.kind, &v.value), "marks": marks})
            })
            .collect();
        Ok(json!({ "objects": objects, "write_blocked": self.state.write_blocked() }))
    }

    /// Создать/заменить/удалить объект: разница с показанным считается здесь, наружу — только изменившиеся поля.
    pub fn state_set(&mut self, a: SetArgs) -> Result<Outcome> {
        let kind = kind_of(&a.kind)?;
        let object = Some(ObjectKey { kind, key: a.key.clone() });
        let cur = self.state.view_object(kind, &a.key);
        let mut w = Work::default();
        if a.delete {
            if cur.is_some() {
                self.state_op(SOp::Delete(s2::Delete { object }), &mut w)?;
            }
            return self.finish(w);
        }
        let encode = |v: &Value| -> Result<Vec<u8>> {
            Ok(match state2::value_type(kind) {
                Some(t) => {
                    let text = if v.is_null() { "{}".to_string() } else { v.to_string() };
                    crate::type_codec::encode_by_type(t, &text).ok_or(ProtoError::InvalidField("kind"))??
                }
                // Признак (архив, «непрочитано») — без значения
                None => vec![],
            })
        };
        let fields_of = |b: &[u8]| -> BTreeMap<u32, Vec<u8>> { split_fields(b).into_iter().map(|f| (f.field, f.value)).collect() };
        let want = fields_of(&encode(&a.value)?);
        // Показанное хостом: поля, которых хост не менял, остаются как у модели
        let base = if a.base.is_null() { None } else { Some(fields_of(&encode(&a.base)?)) };
        match cur {
            Some(_) if a.rewrite => {
                let set = want.into_iter().map(|(field, value)| s2::FieldValue { field, value }).collect();
                self.state_op(SOp::Create(s2::Create { object, set }), &mut w)?;
            }
            None => {
                let set = want.into_iter().map(|(field, value)| s2::FieldValue { field, value }).collect();
                self.state_op(SOp::Create(s2::Create { object, set }), &mut w)?;
            }
            Some(c) => {
                let have = fields_of(&c.value);
                let touched = |f: &u32| base.as_ref().is_none_or(|b| b.get(f) != want.get(f));
                let set: Vec<s2::FieldValue> = want
                    .iter()
                    .filter(|(f, v)| touched(f) && have.get(f) != Some(v))
                    .map(|(f, v)| s2::FieldValue { field: *f, value: v.clone() })
                    .collect();
                let clear: Vec<u32> = have.keys().filter(|f| !want.contains_key(f) && touched(f)).copied().collect();
                if !set.is_empty() || !clear.is_empty() {
                    self.state_op(SOp::Patch(s2::Patch { object, set, clear }), &mut w)?;
                }
            }
        }
        self.finish(w)
    }

    pub fn state_mark(&mut self, a: MarkArgs) -> Result<Outcome> {
        let kind = kind_of(&a.kind)?;
        let value = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, a.value.as_bytes()).map_err(|_| ProtoError::InvalidField("value"))?;
        let mut w = Work::default();
        self.state_op(SOp::Mark(s2::Mark { object: Some(ObjectKey { kind, key: a.key }), field: a.field, value }), &mut w)?;
        self.finish(w)
    }
}
