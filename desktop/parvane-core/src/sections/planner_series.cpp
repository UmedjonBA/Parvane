// Parvane fork (spec 029, фаза 4): правки повторяющихся записей «Плана» — порт web `plannerSeriesEdit.ts` и
// `plannerSeriesRule.ts`.
#include "parvane/sections/planner_series.h"

#include <algorithm>
#include <type_traits>

namespace parvane::sections::planner {

namespace {

template <typename T>
std::vector<T> &listOf(State &state) {
    if constexpr (std::is_same_v<T, Task>) return state.tasks;
    else return state.events;
}

template <typename T>
const std::vector<T> &listOf(const State &state) {
    if constexpr (std::is_same_v<T, Task>) return state.tasks;
    else return state.events;
}

template <typename T>
T *find(State &state, const std::string &id) {
    for (auto &item : listOf<T>(state)) {
        if (item.id == id) return &item;
    }
    return nullptr;
}

template <typename T>
const T *find(const State &state, const std::string &id) {
    for (const auto &item : listOf<T>(state)) {
        if (item.id == id) return &item;
    }
    return nullptr;
}

std::string textOf(const Task &task) { return task.description; }
std::string textOf(const Event &event) { return event.description.value_or(""); }
std::string textOf(const SeriesItem &item) {
    return std::visit([](const auto &value) { return textOf(value); }, item);
}

// У задачи описание — строка (пустая — нет), у события — значение либо отсутствие
void writeDescription(Task &task, const std::string &description) { task.description = description; }
void writeDescription(Event &event, const std::string &description) {
    if (description.empty()) event.description.reset();
    else event.description = description;
}

bool truthy(const std::optional<std::string> &value) { return value && !value->empty(); }

const std::optional<Repeat> &repeatOf(const SeriesItem &item) {
    return std::visit([](const auto &value) -> const std::optional<Repeat> & { return value.repeat; }, item);
}
const std::optional<Origin> &originOf(const SeriesItem &item) {
    return std::visit([](const auto &value) -> const std::optional<Origin> & { return value.origin; }, item);
}
const std::optional<std::string> &instanceDayOf(const SeriesItem &item) {
    return std::visit([](const auto &value) -> const std::optional<std::string> & { return value.instanceDay; },
                      item);
}

ItemPatch descriptionPatch(const std::string &description) {
    ItemPatch patch;
    patch.description = description;
    return patch;
}

template <typename T>
std::optional<SeriesItem> setDescriptionIn(State &state, SeriesKind kind, const SeriesItem &item,
                                           const std::string &description, DescriptionScope scope,
                                           const IdGen &newId) {
    const auto &id = itemId(item);
    if (repeatOf(item) && truthy(instanceDayOf(item))) {
        if (scope == DescriptionScope::One) {
            return detachInstance(state, kind, id, *instanceDayOf(item), descriptionPatch(description), newId);
        }
        T *series = find<T>(state, id);
        if (!series) return std::nullopt;
        writeDescription(*series, description);
        return SeriesItem(*series);
    }
    T *own = find<T>(state, id);
    if (!own) return std::nullopt;
    writeDescription(*own, description);
    if (scope == DescriptionScope::All && own->origin && !own->repeat) {
        T *series = find<T>(state, own->origin->seriesId);
        if (series && series->repeat) writeDescription(*series, description);
    }
    return SeriesItem(*own);
}

// Поля, которые отделённый день не берёт у ряда при правке «для всех» (`id`, `occurrences`, `origin`,
// `instanceDay` в правку не входят вовсе)
template <typename T>
ItemPatch changedIn(const T &before, const ItemPatch &patch) {
    const json beforeJson = before;
    const json patchJson = patch.toJson();
    ItemPatch out;
    auto changed = [&](const char *key) {
        const json &value = patchJson.at(key);
        const json patchValue = value.is_null() ? json("") : value;
        const auto it = beforeJson.find(key);
        const json beforeValue = it == beforeJson.end() || it->is_null() ? json("") : *it;
        return patchValue.dump() != beforeValue.dump();
    };
#define PV_CHANGED(field)                                                                                              \
    if (patch.field && changed(#field)) out.field = patch.field;
    PV_CHANGED(name)
    PV_CHANGED(description)
    PV_CHANGED(start)
    PV_CHANGED(end)
    PV_CHANGED(project)
    PV_CHANGED(minutes)
    PV_CHANGED(color)
    PV_CHANGED(remind)
    PV_CHANGED(rank)
    PV_CHANGED(isAllDay)
    PV_CHANGED(isHoliday)
    PV_CHANGED(steps)
#undef PV_CHANGED
    return out;
}

template <typename T>
int patchCopiesIn(State &state, const std::string &seriesId, const ItemPatch &fields,
                  const std::optional<std::string> &fromDay, const std::optional<std::string> &exceptId) {
    if (fields.empty()) return 0;
    int count = 0;
    for (auto &item : listOf<T>(state)) {
        if ((exceptId && item.id == *exceptId) || item.repeat || !item.origin || item.origin->seriesId != seriesId) {
            continue;
        }
        if (truthy(fromDay) && item.origin->day < *fromDay) continue;
        applyPatch(item, fields);
        ++count;
    }
    return count;
}

template <typename T>
bool updateFromCopyIn(State &state, SeriesKind kind, const SeriesItem &copy, const ItemPatch &fields) {
    if (T *own = find<T>(state, itemId(copy))) applyPatch(*own, fields);
    const auto series = seriesOfCopy(state, kind, copy);
    if (!series) return false;
    const auto seriesId = itemId(*series);
    if (T *target = find<T>(state, seriesId)) applyPatch(*target, fields);
    patchCopiesIn<T>(state, seriesId, fields, std::nullopt, itemId(copy));
    return true;
}

template <typename T>
std::optional<SeriesItem> changeRuleIn(State &state, SeriesKind kind, const std::string &id, const std::string &day,
                                       const std::optional<Repeat> &repeat, RuleScope scope, const ItemPatch &patch,
                                       const IdGen &newId) {
    T *item = find<T>(state, id);
    if (!item || !item->repeat) return std::nullopt;
    ItemPatch fields = patch;
    fields.day.reset();
    fields.repeat.reset();

    if (!repeat || scope == RuleScope::Stop || scope == RuleScope::One) {
        // Разовая копия может встать на другой день — тот, что выбран в карточке
        ItemPatch detachPatch = fields;
        if (patch.day && truthy(*patch.day)) detachPatch.day = patch.day;
        auto detached = detachInstance(state, kind, id, day, detachPatch, newId);
        if (scope == RuleScope::Stop) truncateSeries(state, kind, id, day);
        return detached;
    }

    const Repeat previous = *item->repeat;
    if (scope == RuleScope::Following && !previous.startDay.empty() && day > previous.startDay) {
        auto next = RepeatPatch::of(*repeat);
        next.startDay = std::optional<std::string>(day);
        // Число повторов, оставшееся прежним, делится между рядами — как при любой правке «это и последующие»
        if (repeat->count.value_or(0) == previous.count.value_or(0)) next.count.reset();
        // Конец прежнего ряда, оставшийся раньше нового начала, новому ряду не подходит
        if (next.endDay && truthy(*next.endDay) && **next.endDay < day) next.endDay = undefinedField<std::string>();
        ItemPatch splitPatch = fields;
        splitPatch.repeat = std::optional<RepeatPatch>(next);
        return splitSeries(state, kind, id, day, splitPatch, newId);
    }

    // Весь ряд (и «с этого дня» у первого дня ряда — разделять нечего)
    updateSeries(state, kind, id, day, fields);
    item = find<T>(state, id);
    item->repeat = *repeat;
    if (item->occurrences) {
        std::vector<Occurrence> kept;
        for (const auto &occurrence : *item->occurrences) {
            if (occursOn(*repeat, occurrence.day)) kept.push_back(occurrence);
        }
        item->occurrences = kept;
    }
    return SeriesItem(*item);
}

} // namespace

// ── plannerSeriesEdit.ts ─────────────────────────────────────────────────────

std::optional<SeriesItem> findSeriesItem(const State &state, SeriesKind kind, const std::string &id) {
    if (kind == SeriesKind::Task) {
        if (const Task *task = find<Task>(state, id)) return SeriesItem(*task);
        return std::nullopt;
    }
    if (const Event *event = find<Event>(state, id)) return SeriesItem(*event);
    return std::nullopt;
}

std::optional<std::string> firstSeriesDay(const Repeat &repeat, const std::string &fallbackDay) {
    const auto from = repeat.startDay.empty() ? fallbackDay : repeat.startDay;
    if (from.empty()) return std::nullopt;
    for (int i = 0; i < kFirstDayHorizon; ++i) {
        const auto day = addDays(from, i);
        if (truthy(repeat.endDay) && day > *repeat.endDay) return std::nullopt;
        if (occursOn(repeat, day)) return day;
    }
    return std::nullopt;
}

std::optional<SeriesItem> addEntry(State &state, SeriesKind kind, const SeriesItem &item, DescriptionScope scope,
                                   const std::string &fallbackDay, const IdGen &newId) {
    const auto description = textOf(item);
    const auto &repeat = repeatOf(item);
    std::optional<std::string> firstDay;
    if (repeat && scope == DescriptionScope::One && !description.empty()) firstDay = firstSeriesDay(*repeat, fallbackDay);
    // Первого дня нет (ряд пуст) — описание остаётся у ряда, а не теряется
    std::visit([&](const auto &value) {
        auto record = value;
        if (firstDay) writeDescription(record, "");
        listOf<std::decay_t<decltype(value)>>(state).push_back(record);
    }, item);
    if (!firstDay) return std::nullopt;
    return detachInstance(state, kind, itemId(item), *firstDay, descriptionPatch(description), newId);
}

std::optional<DescriptionScope> getDescriptionScope(const State &state, SeriesKind kind, const SeriesItem &item) {
    if (repeatOf(item)) return truthy(instanceDayOf(item)) ? std::optional(DescriptionScope::All) : std::nullopt;
    if (!originOf(item)) return std::nullopt;
    const auto series = findSeriesItem(state, kind, originOf(item)->seriesId);
    if (!series || !repeatOf(*series)) return std::nullopt;
    return textOf(*series) == textOf(item) ? DescriptionScope::All : DescriptionScope::One;
}

std::optional<SeriesItem> setDescription(State &state, SeriesKind kind, const SeriesItem &item,
                                         const std::string &description, DescriptionScope scope,
                                         const IdGen &newId) {
    return kind == SeriesKind::Task ? setDescriptionIn<Task>(state, kind, item, description, scope, newId)
                                    : setDescriptionIn<Event>(state, kind, item, description, scope, newId);
}

bool shareDescription(State &state, SeriesKind kind, const SeriesItem &item) {
    if (!originOf(item)) return false;
    const auto &seriesId = originOf(item)->seriesId;
    const auto description = textOf(item);
    if (kind == SeriesKind::Task) {
        Task *series = find<Task>(state, seriesId);
        if (!series || !series->repeat) return false;
        writeDescription(*series, description);
        return true;
    }
    Event *series = find<Event>(state, seriesId);
    if (!series || !series->repeat) return false;
    writeDescription(*series, description);
    return true;
}

std::optional<SeriesItem> detachWithDescription(State &state, SeriesKind kind, const std::string &id,
                                                const std::string &day, const std::string &description,
                                                const IdGen &newId) {
    const auto series = findSeriesItem(state, kind, id);
    if (!series) return std::nullopt;
    const bool hasInstance = std::visit([&](const auto &value) { return hasInstanceOn(value, day); }, *series);
    if (!hasInstance) return std::nullopt;
    return detachInstance(state, kind, id, day, descriptionPatch(description), newId);
}

ItemPatch changedFields(const Task &before, const ItemPatch &patch) { return changedIn(before, patch); }
ItemPatch changedFields(const Event &before, const ItemPatch &patch) { return changedIn(before, patch); }

int patchCopies(State &state, SeriesKind kind, const std::string &seriesId, const ItemPatch &fields,
                const std::optional<std::string> &fromDay, const std::optional<std::string> &exceptId) {
    return kind == SeriesKind::Task ? patchCopiesIn<Task>(state, seriesId, fields, fromDay, exceptId)
                                    : patchCopiesIn<Event>(state, seriesId, fields, fromDay, exceptId);
}

std::optional<SeriesItem> seriesOfCopy(const State &state, SeriesKind kind, const SeriesItem &item) {
    if (repeatOf(item) || !originOf(item)) return std::nullopt;
    const auto series = findSeriesItem(state, kind, originOf(item)->seriesId);
    return series && repeatOf(*series) ? series : std::nullopt;
}

bool updateFromCopy(State &state, SeriesKind kind, const SeriesItem &copy, const ItemPatch &fields) {
    return kind == SeriesKind::Task ? updateFromCopyIn<Task>(state, kind, copy, fields)
                                    : updateFromCopyIn<Event>(state, kind, copy, fields);
}

// ── plannerSeriesRule.ts ─────────────────────────────────────────────────────

bool sameRepeat(const std::optional<Repeat> &a, const std::optional<Repeat> &b) {
    if (!a || !b) return !a && !b;
    auto weekdays = [](const Repeat &repeat) {
        if (repeat.kind != "weekly") return std::string();
        auto days = repeat.weekdays.value_or(std::vector<int>());
        std::sort(days.begin(), days.end());
        std::string out;
        for (size_t i = 0; i < days.size(); ++i) {
            if (i) out += ',';
            out += std::to_string(days[i]);
        }
        return out;
    };
    return a->kind == b->kind && a->interval == b->interval && weekdays(*a) == weekdays(*b)
        && (a->kind != "monthly" || a->monthDay.value_or(0) == b->monthDay.value_or(0))
        && a->startDay == b->startDay && a->endDay.value_or("") == b->endDay.value_or("")
        && a->count.value_or(0) == b->count.value_or(0);
}

std::optional<SeriesItem> changeSeriesRule(State &state, SeriesKind kind, const std::string &id,
                                           const std::string &day, const std::optional<Repeat> &repeat,
                                           RuleScope scope, const ItemPatch &patch, const IdGen &newId) {
    return kind == SeriesKind::Task ? changeRuleIn<Task>(state, kind, id, day, repeat, scope, patch, newId)
                                    : changeRuleIn<Event>(state, kind, id, day, repeat, scope, patch, newId);
}

std::optional<std::string> nearestSeriesDay(const SeriesItem &item, const std::string &day) {
    const auto &repeat = repeatOf(item);
    if (!repeat) return std::nullopt;
    auto hasInstance = [&](const std::string &d) {
        return std::visit([&](const auto &value) { return hasInstanceOn(value, d); }, item);
    };
    if (hasInstance(day)) return day;
    const auto from = !repeat->startDay.empty() && repeat->startDay > day ? repeat->startDay : day;
    for (const auto &d : expandRepeat(*repeat, from, addDays(from, kFirstDayHorizon))) {
        if (hasInstance(d)) return d;
    }
    return std::nullopt;
}

} // namespace parvane::sections::planner
