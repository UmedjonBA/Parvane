// Parvane fork (spec 029, T063): чистая часть экранов «Знаний» на desktop — то, что в web живёт прямо в компонентах
// `Knowledge.tsx`, `NoteView.tsx`, `NoteLinks.tsx` и `NotesGraph.tsx`: «Запланировано» с последними прошедшими,
// служебная метка пункта, записи «Плана» для графа и их подписи, поиск по графу, выбор папок графа, места точек
// малого графа заметки и папка новой заметки. Без UI, сети и хранилища.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/notes_graph.h"
#include "parvane/sections/notes_planned.h"
#include "parvane/sections/planner_types.h"

namespace parvane::sections::notes {

// Сколько прошедших записей остаётся в «Запланировано» перед будущими (web `PLANNED_PAST_MAX`)
inline constexpr int kPlannedPastMax = 3;

// Малый граф «Связей» (web NoteLinks): поле 320×240, точки по эллипсу, не больше 8, подписи до 16 знаков
inline constexpr double kMiniGraphWidth = 320;
inline constexpr double kMiniGraphHeight = 240;
inline constexpr double kMiniGraphRadiusX = 92;
inline constexpr double kMiniGraphRadiusY = 80;
inline constexpr int kMiniGraphMaxPoints = 8;
inline constexpr int kMiniGraphLabelMax = 16;

// Подписи точек большого графа — до 22 знаков (web `LABEL_MAX`)
inline constexpr int kGraphLabelMax = 22;

/** «Запланировано» заметки: прошедшие (день раньше сегодняшнего) — только последние `pastMax`, затем записи без дня и
 *  с днём не раньше сегодняшнего, в прежнем порядке. */
std::vector<PlannedItem> shownPlanned(const std::vector<PlannedItem> &items, const std::string &today,
                                      int pastMax = kPlannedPastMax);

struct TaskMarkerSplit {
    // Текст пункта без служебной метки ` ^t…` в конце
    std::string text;
    // Метка без `^`; нет — nullopt
    std::optional<std::string> marker;
    bool operator==(const TaskMarkerSplit &) const = default;
};

/** Пункт, ставший задачей «Плана»: метка ` ^t<4…12 знаков [a-z0-9]>` в конце строки (web `MARKER`) не показывается. */
TaskMarkerSplit splitTaskMarker(const std::string &text);

/** Названия из ссылок `[[…]]` в строке, без подписи после `|` и без крайних пробелов (web `linksIn` графа). */
std::vector<std::string> titleLinks(const std::string &text);

/** Записи «Плана» для графа: события (`e<id>`) и задачи (`t<id>`) с их ссылками (web `recordsOf`). */
std::vector<GraphRecordInput> graphRecordsOf(const planner::State &state);

/** Подпись точки записи «Плана»: название без разметки ссылок; ничего не осталось — само название. */
std::string recordLabel(const std::string &title);

/** Подпись не длиннее `max` знаков: длиннее — первые `max - 1` и «…». */
std::string shortenLabel(const std::string &text, int max);

/** Строка поиска по графу: без крайних пробелов, без регистра, «ё» = «е» (web `normalizeQuery`). */
std::string graphQueryText(const std::string &value);

/** Точка найдена поиском графа: строка — в подписи либо в названии. Пустой запрос — не найдена. */
bool isGraphFound(const std::string &query, const std::string &label, const std::string &title);

/** Enter в поиске графа: следующая находка после выбранной, по кругу; находок нет — nullopt. */
std::optional<size_t> nextFoundIndex(const std::vector<std::string> &hitIds, const std::optional<std::string> &pickedId);

/** Нажатие на папку в списке папок графа: из «всех папок» остаётся одна, дальше папки добавляются и убираются.
 *  Итог не приведён к существующим папкам — это делает `resolveGraphFolders`. */
std::vector<std::string> toggleGraphFolder(const std::optional<std::vector<std::string>> &folders,
                                           const std::string &path);

/** Места `count` точек малого графа (не больше `kMiniGraphMaxPoints`): по эллипсу от верхней точки по часовой. */
std::vector<GraphPoint> miniGraphPlaces(size_t count);

struct NewNoteContext {
    // Открытая заметка: её папка и признак заметки дня (название — дата)
    std::optional<std::string> openFolder;
    bool openIsDay = false;
    // Папка справки Parvane, если справка есть
    std::optional<std::string> guideFolder;
};

/** Папка новой заметки («Новая заметка» в шапке и под списком): папка открытой заметки; из справки, из заметки дня
 *  и без открытой заметки — «Без папки» (nullopt). */
std::optional<std::string> newNoteFolder(const NewNoteContext &context);

} // namespace parvane::sections::notes
