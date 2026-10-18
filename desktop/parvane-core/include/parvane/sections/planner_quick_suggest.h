// Parvane fork (spec 029, T061): ввод текстом «Плана» — подсказки окна «Новая запись». Порт web
// `components/parvane/planner/plannerQuickSuggest.ts`: прежние строки пользователя (история `State::quickLines`),
// строки, собранные из задач и событий «Плана» (разбор наоборот), и встроенные примеры. Список кандидатов
// собирается один раз при открытии окна (`buildCandidates`), набор текста его только фильтрует
// (`filterSuggestions`).
//
// Отличия от web:
// - запасной путь web (история в localStorage, `mergeHistories`, parse/serialize/read/save/reset) не перенесён:
//   на desktop история — всегда `State::quickLines`;
// - кэша разбора на уровне модуля нет (в web — ради сотен разборов на открытие): сборку кандидатов UI ведёт вне
//   главного потока;
// - «прежний объект» web (`toBe`) у `recordHistoryLine` — признак `changed`.
// Строки — UTF-8; длины строк (потолки 300 знаков) — в единицах UTF-16, как в web.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_quick.h"
#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

inline constexpr size_t kMaxSuggestions = 8;
inline constexpr size_t kHistoryMaxLines = 200;
inline constexpr size_t kHistoryMaxHidden = 200;

// Источник: history | data | example
struct QuickCandidate {
    std::string text;
    std::string source;
    // Ключ шаблона: строки, отличающиеся только датой, — один кандидат
    std::string key;
    // Свёрнутая строка, её слова и слова названия — для фильтра
    std::string line;
    std::vector<std::string> words;
    std::vector<std::string> nameWords;
    double count = 0;
    double at = 0;
    // Строки истории, которые кандидат представляет: «Забыть» стирает их все
    std::vector<std::string> texts;
    std::string kind;
    bool operator==(const QuickCandidate &) const = default;
};

struct QuickSuggestion {
    std::string text;
    std::string source;
    bool operator==(const QuickSuggestion &) const = default;
};

struct QuickHistoryLine {
    std::string text;
    double count = 0;
    double at = 0;
    bool operator==(const QuickHistoryLine &) const = default;
};

// `lines` — от новых к старым; `hidden` — ключи шаблонов, которые пользователь попросил забыть
struct QuickHistory {
    double tick = 0;
    std::vector<QuickHistoryLine> lines;
    std::vector<std::string> hidden;
    bool operator==(const QuickHistory &) const = default;
};

struct QuickSuggestSources {
    QuickHistory history;
    std::vector<Task> tasks;
    std::vector<Event> events;
    std::vector<std::string> examples;
};

// Задача либо событие в том виде, в каком его описывает строка
struct QuickLineRepeat {
    std::string kind = "daily";
    int interval = 1;
    std::optional<std::vector<int>> weekdays;
};
struct QuickLineDraft {
    std::string kind = "task"; // task | event
    std::string name;
    std::optional<std::string> start;
    std::optional<std::string> end;
    bool isAllDay = false;
    std::optional<double> minutes;
    std::optional<QuickLineRepeat> repeat;
    std::optional<std::string> list;
};

// Кандидаты всех источников в порядке старшинства: чаще, затем источник (история, данные, примеры), затем новее
std::vector<QuickCandidate> buildCandidates(const QuickSuggestSources &sources, const QuickContext &ctx);
// Подсказки для набранного (`kinds` — только строки этих видов; пусто — все)
std::vector<QuickSuggestion> filterSuggestions(const std::string &input, const std::vector<QuickCandidate> &candidates,
                                               size_t limit = kMaxSuggestions,
                                               const std::optional<std::vector<std::string>> &kinds = std::nullopt);
// Подсказки для набранного со сборкой кандидатов заново
std::vector<QuickSuggestion> buildSuggestions(const std::string &input, const QuickSuggestSources &sources,
                                              const QuickContext &ctx);
// Набранное — начало подсказки, но не вся она: такую подсказку принимает Tab
bool isSuggestionPrefix(const std::string &input, const std::string &suggestion);
// Ключ шаблона добавленной строки: задача и событие — строка без даты, остальное — сама строка
std::string lineKey(const std::string &text, const QuickDraft &draft, const std::string &uiLang);
// Разбор наоборот: строка, которую `parseQuickInput` прочитает как эту задачу либо событие
std::string draftToLine(const QuickLineDraft &draft, const std::string &lang, bool isExplicit = false);

// ── история ──────────────────────────────────────────────────────────────────

struct HistoryResult {
    QuickHistory history;
    bool changed = false;
};
HistoryResult recordHistoryLine(const QuickHistory &history, const std::string &typed, const std::string &key);
QuickHistory forgetSuggestion(const QuickHistory &history, const std::string &key,
                              const std::vector<std::string> &texts);
bool hasHistory(const QuickHistory &history);

// ── история в данных «Плана» ─────────────────────────────────────────────────

std::string quickLineId(const std::string &text, bool isHidden = false);
QuickHistory historyFromLines(const std::vector<QuickLine> &lines);
std::vector<QuickLine> historyToLines(const QuickHistory &history, const std::vector<QuickLine> &previous = {});
// Добавленная строка: новый список записей
std::vector<QuickLine> recordQuickLine(const std::vector<QuickLine> &lines, const std::string &typed,
                                       const std::string &key);
// «Забыть»: строки подсказки уходят, её шаблон становится забытым
std::vector<QuickLine> forgetQuickLine(const std::vector<QuickLine> &lines, const std::string &key,
                                       const std::vector<std::string> &texts);

} // namespace parvane::sections::planner
