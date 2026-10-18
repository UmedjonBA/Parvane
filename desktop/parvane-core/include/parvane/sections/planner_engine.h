// Parvane fork (spec 029, T029): «План» ↔ движок — порт web `components/parvane/planner/plannerSync.ts`.
// Состояние для экранов (`State`) строится из JSON движка (`plannerStateJson`: только живые объекты, без меток);
// правки уходят движку списком изменений (`plannerPrepareLocal`, поле `changes`): присутствующее поле — правка
// регистра, `null` у числа — «не задано», `deleted: true` — надгробие. Метки ставит движок. Формат JSON —
// `backend/protocol/src/domain/planner_json.rs`.
//
// Отличия от web по устройству (поведение то же):
// - записи сравниваются по JSON (`to_json`, без учёта порядка ключей), а не по `JSON.stringify` с кэшем на объект;
//   переиспользования объектов (C1, `reuseById`) в C++ нет — значения и так копии, разбор с прежним
//   состоянием даёт то же, что без него, поэтому параметра `previous` у `fromEngineState` нет;
// - `details` записей здоровья (упражнения, цели здоровья) читаются в типы planner_types.h: незнакомые поля и
//   нечисловые значения отбрасываются (в web объект берётся как есть); пишутся в порядке полей типа, целые
//   числа — без дробной части (как `JSON.stringify`);
// - дни питания перебираются по возрастанию ключа (std::map), в web — в порядке вставки ключей объекта.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

// Изменение для движка (`{ "<вид>": { … } }`)
using PlannerChange = json;

// Цели здоровья — одна запись здоровья с известным id; день у неё условный (движок требует дату)
inline constexpr const char *kHealthGoalsId = "health-goals";
inline constexpr const char *kHealthGoalsKind = "goals";
inline constexpr const char *kHealthGoalsDay = "2000-01-01";

// JSON движка → состояние для экранов. Движок прежней сборки может не отдавать новых полей — они читаются как
// отсутствующие. Негодный тип корня — исключение nlohmann (как исключение разбора в web).
State fromEngineState(const json &engine);

// Движок понимает историю ввода текстом (отдаёт `quickLines`); без этого признака история в «План» не пишется
bool hasEngineQuickLines(const json &engine);

// Разница состояний → изменения для движка. Правка существующего задания/события/списка несёт только
// изменившиеся поля (у события правило — всегда парой `weekdays: null` + `repeat`); новые — целиком; пропавшие —
// надгробием. Порядок: списки, задачи, события, питание, настройки, цели, периоды целей, здоровье, цели здоровья,
// словарь правок, история ввода, отметки «напомнено».
std::vector<PlannerChange> diffChanges(const State &previous, const State &next);

// Данные этапа 1 (запись устройства) → изменения целиком; числовые id получают префикс устройства, последним —
// отметка переноса `{migration: {sourceDevice, count}}`
std::vector<PlannerChange> legacyToChanges(const State &legacy, const std::string &devicePrefix);

// Запись устройства — ещё данные этапа 1 (`version === 1` и массив `tasks`), а не маркер переноса
bool isLegacyPlannerRecord(const json &raw);

// Число как `JSON.stringify`: целое значение — без дробной части
json jsonNumber(double value);

} // namespace parvane::sections::planner
