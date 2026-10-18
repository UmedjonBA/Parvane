// Parvane fork (spec 029, фаза 4): группы «Плана» — порт web `plannerGroups.ts`. Группа — запись `lists` (имя,
// цвет); задача и событие ссылаются на неё именем (`project`), цвет записи — цвет группы.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_model.h"

namespace parvane::sections::planner {

// Запись, отмеченная для добавления в группу: экземпляр ряда несёт `day`
struct GroupPick {
    SeriesKind kind = SeriesKind::Task;
    std::string id;
    std::optional<std::string> day;
    bool isRepeat = false;
};

inline constexpr size_t kGroupNameMaxLength = 60;

std::string normalizeGroupName(const std::string &name);
// Ошибка: name | duplicate
std::optional<std::string> createGroup(State &state, const std::string &rawName, int color, const IdGen &newId);
// Новое имя группы — и у всех её задач и событий
std::optional<std::string> renameGroup(State &state, const std::string &from, const std::string &rawName);
void setGroupColor(State &state, const std::string &name, int color);
// Группа удаляется, её записи остаются без группы
void deleteGroup(State &state, const std::string &name);
// Отмеченные записи — в группу; ряд с `withRepeats` — целиком, без него — только отмеченный день
void assignToGroup(State &state, const std::vector<GroupPick> &picks, const std::string &name, bool withRepeats,
                   const IdGen &newId);

} // namespace parvane::sections::planner
