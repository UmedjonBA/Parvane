// Parvane fork (spec 029, фаза 4): группы «Плана» — порт web `plannerGroups.ts`.
#include "parvane/sections/planner_groups.h"

#include <algorithm>
#include <set>

#include "planner_util.h"

namespace parvane::sections::planner {

std::string normalizeGroupName(const std::string &name) {
    // web режет по UTF-16 (`slice(0, 60)`), здесь — по кодовым точкам
    return util::takeCodepoints(util::trim(name), kGroupNameMaxLength);
}

std::optional<std::string> createGroup(State &state, const std::string &rawName, int color, const IdGen &newId) {
    const auto name = normalizeGroupName(rawName);
    if (name.empty()) return "name";
    if (std::any_of(state.lists.begin(), state.lists.end(), [&](const List &l) { return l.name == name; })) {
        return "duplicate";
    }
    List *list = ensureList(state, name, newId);
    if (color) list->color = color;
    return std::nullopt;
}

std::optional<std::string> renameGroup(State &state, const std::string &from, const std::string &rawName) {
    const auto name = normalizeGroupName(rawName);
    if (name.empty()) return "name";
    if (name == from) return std::nullopt;
    if (std::any_of(state.lists.begin(), state.lists.end(), [&](const List &l) { return l.name == name; })) {
        return "duplicate";
    }
    auto it = std::find_if(state.lists.begin(), state.lists.end(), [&](const List &l) { return l.name == from; });
    if (it == state.lists.end()) return std::nullopt;
    it->name = name;
    for (auto &project : state.projects) {
        if (project == from) project = name;
    }
    for (auto &task : state.tasks) {
        if (task.project == from) task.project = name;
    }
    for (auto &event : state.events) {
        if (event.project == from) event.project = name;
    }
    return std::nullopt;
}

void setGroupColor(State &state, const std::string &name, int color) {
    for (auto &list : state.lists) {
        if (list.name == name) {
            list.color = color ? std::optional<int>(color) : std::nullopt;
            return;
        }
    }
}

void deleteGroup(State &state, const std::string &name) {
    std::erase_if(state.lists, [&](const List &l) { return l.name == name; });
    std::erase_if(state.projects, [&](const std::string &p) { return p == name; });
    for (auto &task : state.tasks) {
        if (task.project == name) task.project = "";
    }
    for (auto &event : state.events) {
        if (event.project == name) event.project.reset();
    }
}

void assignToGroup(State &state, const std::vector<GroupPick> &picks, const std::string &name, bool withRepeats,
                   const IdGen &newId) {
    std::set<std::string> seriesDone;
    const std::optional<std::string> eventProject = name.empty() ? std::nullopt : std::optional<std::string>(name);
    for (const auto &pick : picks) {
        const bool isSeriesPick = pick.isRepeat && withRepeats;
        if (pick.isRepeat && !withRepeats && pick.day && !pick.day->empty()) {
            ItemPatch patch;
            patch.project = pick.kind == SeriesKind::Event ? eventProject : std::optional<std::string>(name);
            detachInstance(state, pick.kind, pick.id, *pick.day, patch, newId);
            continue;
        }
        const auto key = std::string(pick.kind == SeriesKind::Task ? "task:" : "event:") + pick.id;
        if (isSeriesPick && seriesDone.count(key)) continue;
        seriesDone.insert(key);
        if (pick.kind == SeriesKind::Task) {
            for (auto &task : state.tasks) {
                if (task.id == pick.id || (isSeriesPick && task.origin && task.origin->seriesId == pick.id)) {
                    task.project = name;
                }
            }
            continue;
        }
        for (auto &event : state.events) {
            if (event.id == pick.id || (isSeriesPick && event.origin && event.origin->seriesId == pick.id)) {
                event.project = eventProject;
            }
        }
    }
}

} // namespace parvane::sections::planner
