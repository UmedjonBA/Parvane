// Parvane fork (spec 029, фаза 4): пункты заметки с датой ↔ задачи «Плана» — порт web `notes/notesTasks.ts`.
#include "parvane/sections/notes_tasks.h"

#include <algorithm>
#include <cstdio>

namespace parvane::sections::notes {

namespace {

using planner::State;
using planner::Task;

std::string markerToOpId(const std::string &marker) {
    // В web — коды символов UTF-16 по два шестнадцатеричных знака; метка — латиница и цифры
    std::string out;
    char buf[8];
    for (const unsigned char c : marker) {
        std::snprintf(buf, sizeof buf, "%02x", c);
        out += buf;
    }
    return out;
}

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool isDone(const Task &task) { return task.status == "done"; }

bool sameFields(const Task &task, const NoteTaskPlan &plan) {
    return task.name == plan.name && task.day == plan.day && task.start == plan.start && task.minutes == plan.minutes
        && task.due == plan.due;
}

void putFields(Task &task, const NoteTaskPlan &plan) {
    task.name = plan.name;
    task.day = plan.day;
    task.start = plan.start;
    task.minutes = plan.minutes;
    task.due = plan.due;
}

std::optional<std::string> sourceChat(const Task &task) {
    if (!task.source) return std::nullopt;
    return task.source->chat;
}

} // namespace

std::string noteSourceOf(const std::string &noteId) { return kNoteSourcePrefix + noteId; }

std::string markerOfTask(const Task &task) {
    const std::string opId = task.source ? task.source->opId : std::string();
    // `opId.match(/../g)` — пары знаков, хвост из одного знака отбрасывается; `parseInt` негодной пары — NaN → «\0»
    std::string out;
    for (size_t i = 0; i + 1 < opId.size(); i += 2) {
        const int hi = hexValue(opId[i]);
        if (hi < 0) {
            out.push_back('\0');
            continue;
        }
        const int lo = hexValue(opId[i + 1]);
        const int code = lo < 0 ? hi : hi * 16 + lo;
        if (code < 0x80) {
            out.push_back(static_cast<char>(code));
        } else {
            out.push_back(static_cast<char>(0xC0 | (code >> 6)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
        }
    }
    return out;
}

std::string noteTaskId(const std::string &marker) { return "note-" + marker; }

std::map<std::string, std::vector<Task>> noteTasksBySource(const State &state) {
    std::map<std::string, std::vector<Task>> built;
    const std::string prefix = kNoteSourcePrefix;
    for (const auto &task : state.tasks) {
        const auto chat = sourceChat(task);
        if (!chat || chat->rfind(prefix, 0) != 0) continue;
        built[chat->substr(prefix.size())].push_back(task);
    }
    return built;
}

std::vector<Task> getNoteTasks(const State &state, const std::string &noteId) {
    auto bySource = noteTasksBySource(state);
    const auto it = bySource.find(noteId);
    return it == bySource.end() ? std::vector<Task>{} : it->second;
}

std::string noteTasksStatusSignature(const State &state) {
    std::string out;
    bool isFirst = true;
    for (const auto &task : state.tasks) {
        const auto chat = sourceChat(task);
        if (!chat || chat->rfind(kNoteSourcePrefix, 0) != 0) continue;
        if (!isFirst) out += '\n';
        isFirst = false;
        out += task.id + ":" + task.status;
    }
    return out;
}

NoteTasksPlanResult planNoteTasks(const std::string &text, const planner::QuickContext &ctx, const MakeId &makeId) {
    const MakeId ids = makeId ? makeId : MakeId(makeRandomMarkerId);
    NoteTasksPlanResult result;
    result.text = dedupeTaskMarkers(text, ids).text;
    planner::QuickContext taskCtx = ctx;
    taskCtx.kind = "task";
    for (const auto &task : parseNote(result.text).tasks) {
        const auto draft = planner::parseQuickInput(task.text, taskCtx);
        // Пункт без даты и срока остаётся просто пунктом
        if (draft.error || (!draft.day && !draft.due) || draft.isDayAssumed.value_or(false)) continue;
        const auto ensured = ensureTaskMarker(result.text, task.line, ids);
        if (!ensured.marker) continue;
        result.text = ensured.text;
        NoteTaskPlan plan;
        plan.marker = *ensured.marker;
        plan.name = draft.name;
        plan.isDone = task.isDone;
        plan.day = draft.day;
        plan.start = draft.start;
        if (draft.minutes) plan.minutes = static_cast<int>(*draft.minutes);
        plan.due = draft.due;
        result.tasks.push_back(std::move(plan));
    }
    return result;
}

bool hasNoteTaskChanges(const State &state, const std::string &noteId, const std::vector<NoteTaskPlan> &tasks) {
    std::set<std::string> markers;
    for (const auto &plan : tasks) markers.insert(plan.marker);
    for (const auto &task : getNoteTasks(state, noteId)) {
        if (!markers.count(markerOfTask(task))) return true;
    }
    std::map<std::string, const Task *> byId;
    for (const auto &task : state.tasks) byId.emplace(task.id, &task);
    return std::any_of(tasks.begin(), tasks.end(), [&](const NoteTaskPlan &plan) {
        const auto it = byId.find(noteTaskId(plan.marker));
        if (it == byId.end()) return true;
        return !sameFields(*it->second, plan) || isDone(*it->second) != plan.isDone;
    });
}

bool applyNoteTasks(State &state, const std::string &noteId, const std::vector<NoteTaskPlan> &tasks) {
    const std::string source = noteSourceOf(noteId);
    std::set<std::string> markers;
    for (const auto &plan : tasks) markers.insert(plan.marker);
    std::vector<Task> kept;
    for (const auto &task : state.tasks) {
        if (sourceChat(task) != source || markers.count(markerOfTask(task))) kept.push_back(task);
    }
    bool hasChanges = kept.size() != state.tasks.size();
    state.tasks = std::move(kept);
    double minRank = 0;
    for (const auto &task : state.tasks) minRank = std::min(minRank, task.rank);
    for (const auto &plan : tasks) {
        const std::string id = noteTaskId(plan.marker);
        // Индекс по id — заново на каждом шаге: `push_back` двигает задачи
        auto existing = std::find_if(state.tasks.begin(), state.tasks.end(),
                                     [&](const Task &task) { return task.id == id; });
        if (existing != state.tasks.end()) {
            if (!sameFields(*existing, plan)) {
                putFields(*existing, plan);
                hasChanges = true;
            }
            if (isDone(*existing) != plan.isDone) {
                existing->status = plan.isDone ? "done" : "queue";
                hasChanges = true;
            }
            continue;
        }
        minRank -= 1;
        Task created;
        created.id = id;
        created.description = "";
        created.status = plan.isDone ? "done" : "queue";
        created.project = "";
        created.rank = minRank;
        created.source = planner::Source{source, markerToOpId(plan.marker)};
        putFields(created, plan);
        state.tasks.push_back(std::move(created));
        hasChanges = true;
    }
    return hasChanges;
}

std::string applyPlannerToNote(const std::string &text, const std::vector<Task> &tasks,
                               const std::set<std::string> &known) {
    std::string next = text;
    // `new Map(…)` — при повторной метке побеждает последняя задача
    std::map<std::string, const Task *> byMarker;
    for (const auto &task : tasks) byMarker[markerOfTask(task)] = &task;
    for (const auto &item : parseNote(text).tasks) {
        if (!item.marker) continue;
        const auto it = byMarker.find(*item.marker);
        if (it == byMarker.end()) {
            if (known.count(*item.marker)) next = removeTaskLine(next, *item.marker);
            continue;
        }
        const auto line = findTaskLine(next, *item.marker);
        const bool done = isDone(*it->second);
        if (line && done != item.isDone) next = setTaskDone(next, *line, done);
    }
    return next;
}

} // namespace parvane::sections::notes
