// Parvane fork (spec 029, фаза 4): записи «Плана», связанные с заметками — порт web `notes/notesPlanned.ts`.
#include "parvane/sections/notes_planned.h"

#include <algorithm>
#include <set>

#include "notes_text.h"
#include "parvane/sections/notes_model.h"
#include "parvane/sections/planner_links.h"
#include "parvane/sections/planner_model.h"

namespace parvane::sections::notes {

namespace {

constexpr int kSeriesLookaheadDays = 120;
const std::string kNoDay = "9999";
const std::string kNoteSourcePrefix = "note:";

std::optional<std::string> nextSeriesDay(const planner::Repeat &repeat, const std::string &today) {
    for (int i = 0; i < kSeriesLookaheadDays; ++i) {
        const auto day = planner::addDays(today, i);
        if (planner::occursOn(repeat, day)) return day;
    }
    if (repeat.startDay.empty()) return std::nullopt;
    return repeat.startDay;
}

// `.replace(/\s+/g, ' ').trim()`
std::string collapseSpaces(const std::string &value) {
    const auto chars = text::decode(value);
    text::U32 out;
    bool inSpace = false;
    for (char32_t c : chars) {
        if (text::isSpace(c)) {
            if (!inSpace) out.push_back(U' ');
            inSpace = true;
        } else {
            out.push_back(c);
            inSpace = false;
        }
    }
    return text::encode(text::trimU(out));
}

std::string plainName(const std::string &name) {
    const auto parts = planner::splitNameLinks(name);
    std::string plain;
    std::string all;
    for (const auto &part : parts) {
        if (!part.note) plain += part.text;
        all += part.text;
    }
    const auto collapsed = collapseSpaces(plain);
    return collapsed.empty() ? all : collapsed;
}

std::vector<std::string> linkedTitles(const std::string &name) {
    std::vector<std::string> out;
    std::set<std::string> seen;
    for (const auto &part : planner::splitNameLinks(name)) {
        if (!part.note) continue;
        const auto title = normalizeNoteTitle(*part.note);
        if (seen.insert(title).second) out.push_back(title);
    }
    return out;
}

std::string sortKey(const PlannedItem &item) { return item.day.value_or(kNoDay) + item.time.value_or(""); }

} // namespace

std::string notePlanLine(const std::string &title) { return "[[" + text::trim(title) + "]] "; }

PlannedIndex buildPlannedIndex(const planner::State &planner, const std::string &today) {
    PlannedIndex index;
    for (const auto &task : planner.tasks) {
        PlannedItem item;
        item.key = "t" + task.id;
        item.kind = "task";
        item.name = plainName(task.name);
        item.day = task.repeat ? nextSeriesDay(*task.repeat, today) : task.day;
        item.time = task.start;
        item.due = task.due;
        item.repeat = task.repeat;
        item.isDone = task.status == "done";
        item.isActive = task.status == "active";
        if (task.source && task.source->chat.rfind(kNoteSourcePrefix, 0) == 0) {
            index.byNote[task.source->chat.substr(kNoteSourcePrefix.size())].push_back(item);
        }
        for (const auto &title : linkedTitles(task.name)) index.byTitle[title].push_back(item);
    }
    for (const auto &event : planner.events) {
        PlannedItem item;
        item.key = "e" + event.id;
        item.kind = "event";
        item.name = plainName(event.name);
        item.day = event.repeat ? nextSeriesDay(*event.repeat, today) : event.day;
        if (!event.isAllDay.value_or(false)) item.time = event.start;
        item.repeat = event.repeat;
        for (const auto &title : linkedTitles(event.name)) index.byTitle[title].push_back(item);
    }
    return index;
}

std::vector<PlannedItem> plannedOf(const PlannedIndex &index, const std::string &noteId,
                                   const std::string &noteTitle) {
    std::vector<PlannedItem> all;
    if (const auto it = index.byNote.find(noteId); it != index.byNote.end()) {
        all.insert(all.end(), it->second.begin(), it->second.end());
    }
    if (const auto it = index.byTitle.find(normalizeNoteTitle(noteTitle)); it != index.byTitle.end()) {
        all.insert(all.end(), it->second.begin(), it->second.end());
    }
    std::set<std::string> seen;
    std::vector<PlannedItem> out;
    for (auto &item : all) {
        if (seen.insert(item.key).second) out.push_back(std::move(item));
    }
    // Сравнение строк — по кодовым единицам, как `<` в JS; ключи — цифры и знаки ASCII
    std::stable_sort(out.begin(), out.end(),
                     [](const PlannedItem &a, const PlannedItem &b) { return sortKey(a) < sortKey(b); });
    return out;
}

std::optional<size_t> nearestPlanned(const std::vector<PlannedItem> &items, const std::string &today) {
    for (size_t i = 0; i < items.size(); ++i) {
        const auto &item = items[i];
        if (item.day && !item.day->empty() && *item.day >= today && !item.isDone.value_or(false)) return i;
    }
    return std::nullopt;
}

} // namespace parvane::sections::notes
