// Parvane fork (spec 029, фаза 4): пункты заметки с датой ↔ задачи «Плана» — порт web
// `components/parvane/notes/notesTasks.ts`. Пункт `- [ ]`, в котором есть дата либо срок, становится задачей; связь
// держит метка в конце строки (`^t7f3a`) — пункт можно двигать и править. Задача помнит заметку и метку в поле
// источника: `source.chat = note:<id>`, `source.opId` — метка шестнадцатеричными кодами её символов (движок
// принимает в `opId` только такие цифры). Без сети, хранилища и UI.
#pragma once

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "parvane/sections/notes_model.h"
#include "parvane/sections/planner_quick.h"
#include "parvane/sections/planner_types.h"

namespace parvane::sections::notes {

struct NoteTaskPlan {
    std::string marker;
    std::string name;
    bool isDone = false;
    std::optional<std::string> day;
    std::optional<std::string> start;
    std::optional<int> minutes;
    std::optional<std::string> due;
    bool operator==(const NoteTaskPlan &) const = default;
};

struct NoteTasksPlanResult {
    std::string text;
    std::vector<NoteTaskPlan> tasks;
};

inline constexpr const char *kNoteSourcePrefix = "note:";

std::string noteSourceOf(const std::string &noteId);
/** Метка пункта, с которым связана задача. */
std::string markerOfTask(const planner::Task &task);
std::string noteTaskId(const std::string &marker);

/** Задачи «Плана» из заметок, по id заметки-источника (в web — с кэшем по массиву задач; здесь — каждый раз). */
std::map<std::string, std::vector<planner::Task>> noteTasksBySource(const planner::State &state);
/** Задачи «Плана», пришедшие из этой заметки. */
std::vector<planner::Task> getNoteTasks(const planner::State &state, const std::string &noteId);
/** Подпись задач из заметок `id:статус` построчно (web `noteTasksSignature` из notesTasks.ts): та же строка — в
 *  заметках править нечего. Имя другое, чем в web: `planner::noteTasksSignature` (полная подпись «Плана») с тем же
 *  параметром давал бы неоднозначный вызов. */
std::string noteTasksStatusSignature(const planner::State &state);

/** Пункты заметки с датой: текст с проставленными метками и план задач по ним. `makeId` пуст — случайные метки. */
NoteTasksPlanResult planNoteTasks(const std::string &text, const planner::QuickContext &ctx, const MakeId &makeId = {});
/** Есть ли что править в «Плане» по пунктам заметки — тот же ответ, что у `applyNoteTasks`, без правки. */
bool hasNoteTaskChanges(const planner::State &state, const std::string &noteId, const std::vector<NoteTaskPlan> &tasks);
/** Привести задачи «Плана» к пунктам заметки: создать, поправить, убрать исчезнувшие. `true` — были правки. */
bool applyNoteTasks(planner::State &state, const std::string &noteId, const std::vector<NoteTaskPlan> &tasks);
/** Обратная сторона: галочки пунктов по задачам «Плана»; пункт задачи, удалённой в «Плане», убирается.
 *  `known` — метки, которые уже были связаны с задачами (иначе новый пункт сочли бы удалённым). */
std::string applyPlannerToNote(const std::string &text, const std::vector<planner::Task> &tasks,
                               const std::set<std::string> &known);

} // namespace parvane::sections::notes
