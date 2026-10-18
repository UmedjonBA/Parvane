// Parvane fork (spec 029, фаза 4): правки повторяющихся записей «Плана» — порт web `plannerSeriesEdit.ts`
// (описание ряда: всех повторов или одного дня; правка отделённых дней «для всех») и `plannerSeriesRule.ts`
// (смена правила повтора из карточки экземпляра). Поведение — как в web.
#pragma once

#include <optional>
#include <string>

#include "parvane/sections/planner_model.h"

namespace parvane::sections::planner {

// ── plannerSeriesEdit.ts ─────────────────────────────────────────────────────

// Чьё описание: всех повторов ряда либо только этого дня (web `'all' | 'one'`)
enum class DescriptionScope { All, One };

// Первый экземпляр еженедельного ряда может отстоять от начала на полный шаг недель
inline constexpr int kFirstDayHorizon = kMaxRepeatInterval * 7 + 7;

std::optional<SeriesItem> findSeriesItem(const State &state, SeriesKind kind, const std::string &id);
// Первый день, в который правило даёт экземпляр; у ряда без даты начала отсчёт — от `fallbackDay`
std::optional<std::string> firstSeriesDay(const Repeat &repeat, const std::string &fallbackDay);
// Новая запись. У ряда с описанием «только этого дня» первый день отделяется копией с описанием;
// возвращает отделённую копию, если она появилась
std::optional<SeriesItem> addEntry(State &state, SeriesKind kind, const SeriesItem &item, DescriptionScope scope,
                                   const std::string &fallbackDay, const IdGen &newId);
// Галочка «Описание для всех повторов» у открытой записи; `nullopt` — галочки нет
std::optional<DescriptionScope> getDescriptionScope(const State &state, SeriesKind kind, const SeriesItem &item);
// Правка описания открытой записи; возвращает запись, которая теперь стоит в этом дне
std::optional<SeriesItem> setDescription(State &state, SeriesKind kind, const SeriesItem &item,
                                         const std::string &description, DescriptionScope scope,
                                         const IdGen &newId);
// Описание отделённого дня становится описанием всего ряда; сам день остаётся отделённым
bool shareDescription(State &state, SeriesKind kind, const SeriesItem &item);
// Отделить день ряда копией со своим описанием — если ряд даёт в этот день экземпляр
std::optional<SeriesItem> detachWithDescription(State &state, SeriesKind kind, const std::string &id,
                                                const std::string &day, const std::string &description,
                                                const IdGen &newId);
// Поля правки, которые действительно меняют запись (без своих полей дня: day, due, status, repeat, source)
ItemPatch changedFields(const Task &before, const ItemPatch &patch);
ItemPatch changedFields(const Event &before, const ItemPatch &patch);
// Правка «для всех» — уже отделённым дням ряда (с `fromDay` — только дням с этого дня); число затронутых
int patchCopies(State &state, SeriesKind kind, const std::string &seriesId, const ItemPatch &fields,
                const std::optional<std::string> &fromDay = std::nullopt,
                const std::optional<std::string> &exceptId = std::nullopt);
// Ряд, от которого отделён день, — если он ещё есть и повторяется
std::optional<SeriesItem> seriesOfCopy(const State &state, SeriesKind kind, const SeriesItem &item);
// Правка отделённого дня «для всех»: сам день, его ряд и остальные отделённые дни ряда
bool updateFromCopy(State &state, SeriesKind kind, const SeriesItem &copy, const ItemPatch &fields);

// ── plannerSeriesRule.ts ─────────────────────────────────────────────────────

// «С этого дня», «весь ряд», «не повторять с этого дня», «только этот день без повтора»
enum class RuleScope { Following, All, Stop, One };

// Одно и то же правило повтора (порядок дней недели не важен)
bool sameRepeat(const std::optional<Repeat> &a, const std::optional<Repeat> &b);
// Смена правила повтора у экземпляра дня `day` (см. web `changeSeriesRule`); `repeat` — `nullopt` у «не повторять»
std::optional<SeriesItem> changeSeriesRule(State &state, SeriesKind kind, const std::string &id,
                                           const std::string &day, const std::optional<Repeat> &repeat,
                                           RuleScope scope, const ItemPatch &patch, const IdGen &newId);
// День, на котором открыть карточку после смены правила: тот же, если ряд его даёт, иначе ближайший следующий
std::optional<std::string> nearestSeriesDay(const SeriesItem &item, const std::string &day);

} // namespace parvane::sections::planner
