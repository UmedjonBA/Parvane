// Parvane fork (spec 029, фаза 4): записи «Плана», связанные с заметками, — порт web
// `components/parvane/notes/notesPlanned.ts`. Для списка заметок (ближайшая дата), блока «Запланировано» и малого
// графа заметки. Связь — ссылка `[[Заметка]]` в названии записи либо задача, выросшая из пункта заметки.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_types.h"

namespace parvane::sections::notes {

struct PlannedItem {
    std::string key;
    std::string kind; // task | event
    // Название без разметки ссылок
    std::string name;
    // День, по которому запись стоит в списке: дата, ближайший день ряда либо срок
    std::optional<std::string> day;
    std::optional<std::string> time;
    std::optional<std::string> due;
    std::optional<planner::Repeat> repeat;
    std::optional<bool> isDone;
    std::optional<bool> isActive;
};

struct PlannedIndex {
    std::map<std::string, std::vector<PlannedItem>> byTitle;
    std::map<std::string, std::vector<PlannedItem>> byNote;
};

/** Заготовка строки ввода текстом для «Запланировать»: ссылка на заметку и пробел. */
std::string notePlanLine(const std::string &title);
/** Все записи «Плана» по заметкам: по названию из ссылки и по id заметки-источника. */
PlannedIndex buildPlannedIndex(const planner::State &planner, const std::string &today);
/** Записи одной заметки: сначала по дням, записи без дня — в конце. */
std::vector<PlannedItem> plannedOf(const PlannedIndex &index, const std::string &noteId, const std::string &noteTitle);
/** Ближайшая запись с днём не раньше сегодняшнего (индекс в `items`); нет — nullopt. */
std::optional<size_t> nearestPlanned(const std::vector<PlannedItem> &items, const std::string &today);

} // namespace parvane::sections::notes
