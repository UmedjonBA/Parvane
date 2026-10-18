// Parvane fork (spec 029, фаза 4): карточка «задание в чат» (spec 011, TASK-1) — порт web
// `components/parvane/taskOffer/taskOfferFormat.ts`, `taskOfferPlan.ts`, чистой части `taskOfferOpen.ts` и
// `findOfferInPlan` из `api/parvane/taskOffers.ts`.
//
// Отличия от web:
// - `formatOfferWhen` зовёт `lang` и Intl (`toLocaleDateString`) — здесь `offerWhenParts` отдаёт части строки
//   (день ключом и признак «сегодня», начало, длительность часами/минутами, срок ключом); текст и даты на языке UI
//   собирает UI, части соединяются « · ». Ключи web: WeekdayToday, PlannerHoursValue, PlannerMinutesValue,
//   PlannerDueValue;
// - кэша индекса по объекту состояния (`getStateCache`) нет — поиск каждый раз; ключ тот же;
// - `openOfferInPlan` (сигналы раздела) — UI; здесь только выбор экрана `offerPlannerView`.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

struct OfferWhen {
    std::optional<std::string> day;
    std::optional<std::string> start;
    std::optional<int> minutes;
    std::optional<std::string> due;
};

// Длительность как `formatDuration`: меньше часа — только минуты; иначе часы и (если есть) остаток минут
struct DurationParts {
    std::optional<int> hours;   // PlannerHoursValue
    std::optional<int> minutes; // PlannerMinutesValue
    bool operator==(const DurationParts &) const = default;
};
DurationParts durationParts(int minutes);

struct OfferWhenPart {
    enum class Kind { Day, Start, Duration, Due } kind = Kind::Day;
    std::string day;          // Day, Due: ключ дня
    bool isToday = false;     // Day, Due: день — сегодня (у дня — приставка WeekdayToday)
    std::string start;        // Start: `HH:MM`
    DurationParts duration;   // Duration
};

// Части строки карточки под названием: день · начало · длительность · срок. Начало — только при дне
std::vector<OfferWhenPart> offerWhenParts(const OfferWhen &offer, const std::string &today);

// Запись плана по карточке (вид `task` | `event`, id, день)
struct OfferInPlan {
    std::string kind;
    std::string id;
    std::optional<std::string> day;
    bool operator==(const OfferInPlan &) const = default;
};

// Как web `findOfferInPlan`: задача по `source.opId` (uuid без дефисов), иначе событие с id карточки
std::optional<OfferInPlan> findOfferInPlan(const State *state, const std::string &uuid);
// Ключ записи плана по карточке — строка «вид\x01id\x01день»; `nullopt` — записи нет
std::optional<std::string> offerInPlanKey(const State *state, const std::string &uuid);
std::optional<OfferInPlan> parseOfferInPlanKey(const std::optional<std::string> &key);

// «В плане · открыть»: задание — экран `today`, событие — `calendar`
std::string offerPlannerView(const std::string &kind);

} // namespace parvane::sections::planner
