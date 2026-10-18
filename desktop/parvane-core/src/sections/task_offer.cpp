// Parvane fork (spec 029, фаза 4): карточка «задание в чат» — порт web `taskOfferFormat.ts`, `taskOfferPlan.ts`.
#include "parvane/sections/task_offer.h"

#include "planner_util.h"

namespace parvane::sections::planner {

namespace {

const std::string kSeparator = "\x01";

std::string withoutDashes(const std::string &uuid) {
    std::string out;
    for (const char c : uuid) {
        if (c != '-') out += c;
    }
    return out;
}

const Task *taskByOpId(const State &state, const std::string &opId) {
    for (const auto &task : state.tasks) {
        if (task.source && task.source->opId == opId) return &task;
    }
    return nullptr;
}

const Event *eventById(const State &state, const std::string &id) {
    for (const auto &event : state.events) {
        if (event.id == id) return &event;
    }
    return nullptr;
}

std::optional<std::string> nonEmpty(const std::optional<std::string> &value) {
    return value && !value->empty() ? value : std::nullopt;
}

} // namespace

DurationParts durationParts(int minutes) {
    if (minutes < 60) return {std::nullopt, minutes};
    return {static_cast<int>(util::floorDiv(minutes, 60)), minutes % 60 ? std::optional<int>(minutes % 60)
                                                                         : std::nullopt};
}

std::vector<OfferWhenPart> offerWhenParts(const OfferWhen &offer, const std::string &today) {
    std::vector<OfferWhenPart> parts;
    const auto day = nonEmpty(offer.day);
    if (day) {
        OfferWhenPart part;
        part.kind = OfferWhenPart::Kind::Day;
        part.day = *day;
        part.isToday = *day == today;
        parts.push_back(part);
        if (const auto start = nonEmpty(offer.start)) {
            OfferWhenPart s;
            s.kind = OfferWhenPart::Kind::Start;
            s.start = *start;
            parts.push_back(s);
        }
    }
    if (offer.minutes && *offer.minutes) {
        OfferWhenPart part;
        part.kind = OfferWhenPart::Kind::Duration;
        part.duration = durationParts(*offer.minutes);
        parts.push_back(part);
    }
    if (const auto due = nonEmpty(offer.due)) {
        OfferWhenPart part;
        part.kind = OfferWhenPart::Kind::Due;
        part.day = *due;
        part.isToday = *due == today;
        parts.push_back(part);
    }
    return parts;
}

std::optional<OfferInPlan> findOfferInPlan(const State *state, const std::string &uuid) {
    if (!state) return std::nullopt;
    if (const auto *task = taskByOpId(*state, withoutDashes(uuid))) {
        return OfferInPlan{"task", task->id, nonEmpty(task->day)};
    }
    if (const auto *event = eventById(*state, uuid)) return OfferInPlan{"event", uuid, nonEmpty(event->day)};
    return std::nullopt;
}

std::optional<std::string> offerInPlanKey(const State *state, const std::string &uuid) {
    if (!state) return std::nullopt;
    if (const auto *task = taskByOpId(*state, withoutDashes(uuid))) {
        return "task" + kSeparator + task->id + kSeparator + task->day.value_or("");
    }
    if (const auto *event = eventById(*state, uuid)) {
        return "event" + kSeparator + uuid + kSeparator + event->day.value_or("");
    }
    return std::nullopt;
}

std::optional<OfferInPlan> parseOfferInPlanKey(const std::optional<std::string> &key) {
    if (!key || key->empty()) return std::nullopt;
    const auto parts = util::split(*key, '\x01');
    OfferInPlan out;
    out.kind = parts[0];
    out.id = parts.size() > 1 ? parts[1] : "";
    if (parts.size() > 2 && !parts[2].empty()) out.day = parts[2];
    return out;
}

std::string offerPlannerView(const std::string &kind) { return kind == "event" ? "calendar" : "today"; }

} // namespace parvane::sections::planner
