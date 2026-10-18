// Parvane fork (spec 029, фаза 4): карточка «задание в чат» — порт web `taskOfferFormat.ts`, `taskOfferPlan.ts`.
#include "parvane/sections/task_offer.h"

#include "planner_util.h"

#include <algorithm>
#include <cstdio>

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

OfferFields OfferFields::fromContent(const nlohmann::json &content) {
    auto result = OfferFields();
    if (!content.is_object()) return result;
    const auto text = [&](const char *key) -> std::optional<std::string> {
        const auto i = content.find(key);
        if (i == content.end() || !i->is_string() || i->get<std::string>().empty()) return std::nullopt;
        return i->get<std::string>();
    };
    result.name = text("name").value_or(std::string());
    result.description = text("description").value_or(std::string());
    if (const auto i = content.find("steps"); i != content.end() && i->is_array()) {
        for (const auto &step : *i) {
            if (step.is_string()) result.steps.push_back(step.get<std::string>());
        }
    }
    result.day = text("day");
    result.start = text("start");
    result.due = text("due");
    if (const auto i = content.find("minutes"); i != content.end() && i->is_number()) {
        const auto value = i->get<double>();
        if (value > 0) result.minutes = int(value); // `content.minutes || undefined`
    }
    return result;
}

namespace {

bool isDayKey(const std::string &day) {
    if (day.size() != 10 || day[4] != '-' || day[7] != '-') return false;
    for (const auto i : {0, 1, 2, 3, 5, 6, 8, 9}) {
        if (day[i] < '0' || day[i] > '9') return false;
    }
    const auto month = std::stoi(day.substr(5, 2));
    const auto date = std::stoi(day.substr(8, 2));
    return month >= 1 && month <= 12 && date >= 1 && date <= 31;
}

bool isClock(const std::string &time) {
    if (time.size() != 5 || time[2] != ':') return false;
    for (const auto i : {0, 1, 3, 4}) {
        if (time[i] < '0' || time[i] > '9') return false;
    }
    return std::stoi(time.substr(0, 2)) <= 23 && std::stoi(time.substr(3, 2)) <= 59;
}

std::string clock(int minutes) {
    char buffer[8];
    std::snprintf(buffer, sizeof(buffer), "%02d:%02d", minutes / 60, minutes % 60);
    return buffer;
}

} // namespace

std::string offerKind(const OfferFields &offer) {
    const auto isTimed = offer.day && offer.start && isDayKey(*offer.day) && isClock(*offer.start);
    return (isTimed && offer.steps.empty() && !offer.due) ? "event" : "task";
}

std::string offerEventEnd(const std::string &start, std::optional<int> minutes) {
    const auto from = std::stoi(start.substr(0, 2)) * 60 + std::stoi(start.substr(3, 2));
    const auto length = (minutes && *minutes > 0) ? *minutes : 60;
    return clock(std::min(from + length, 1439));
}

nlohmann::json offerPlanChange(const std::string &uuid, const std::string &chat, const OfferFields &offer,
                               const std::string &newTaskId) {
    using nlohmann::json;
    if (offerKind(offer) == "event") {
        return json{{"event", {
            {"id", uuid},
            {"name", offer.name},
            {"start", *offer.start},
            {"end", offerEventEnd(*offer.start, offer.minutes)},
            {"weekdays", nullptr},
            {"day", *offer.day},
            {"repeat", nullptr},
            {"occurrences", json::array()},
            {"origin", nullptr},
            {"allDay", false},
            {"isHoliday", false},
            {"color", 0},
        }}};
    }
    auto steps = json::array();
    for (const auto &text : offer.steps) {
        steps.push_back({{"text", text}, {"isDone", false}});
    }
    return json{{"task", {
        {"id", newTaskId},
        {"name", offer.name},
        {"description", offer.description},
        {"steps", steps},
        {"status", "queue"},
        {"listId", ""},
        {"rank", 0},
        {"day", offer.day.value_or(std::string())},
        {"start", offer.start.value_or(std::string())},
        {"due", offer.due.value_or(std::string())},
        {"minutes", offer.minutes ? json(*offer.minutes) : json(nullptr)},
        {"source", {{"chat", chat}, {"opId", withoutDashes(uuid)}}},
    }}};
}

std::string taskResponseText(const std::string &name, bool accepted, const std::string &kind) {
    const auto subject = (kind == "event") ? std::string("событие") : std::string("задание");
    auto text = std::string(accepted ? "✅ Принято" : "❌ Отклонено") + ": " + subject + " «" + name + "»";
    // `.slice(0, 300)` web — по UTF-16; здесь по кодовым точкам UTF-8 (имя длиннее карточкой и так не бывает)
    auto points = std::size_t(0);
    for (std::size_t i = 0; i < text.size(); ++i) {
        if ((std::uint8_t(text[i]) & 0xC0) != 0x80 && ++points > 300) {
            text.resize(i);
            break;
        }
    }
    return text;
}


} // namespace parvane::sections::planner
