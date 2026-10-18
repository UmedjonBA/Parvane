// Parvane fork (spec 029, фаза 4): ввод текстом «Плана» (spec 017) — одна строка → черновик записи. Порт web
// `components/parvane/planner/plannerQuick.ts`, поведение 1:1 (сторож — таблица строк plannerQuick.test.ts,
// перенесённая целиком в tests/sections/planner_quick_tests.cpp). Чистая функция без сети и часов: «сейчас» и
// «сегодня» приходят только в QuickContext.
//
// Шаги: опечатки и числительные словами (planner_numerals.h) → распознаватели предлагают кандидатов →
// лучший набор без пересечений (planner_quick_pick.h), остальные чтения — варианты → тип записи, название и
// описание из того, что никто не забрал. Словари — русский и английский, язык выбирается по буквам строки.
//
// Строки — UTF-8; позиции участков (`spans`) — в единицах UTF-16, как в web и в QString десктопа.
// Виды, поля и коды ошибок — строки web (`task`, `event`, `food`…; `name`, `time`, `pastMidnight`…): тексты
// подставляет интерфейс.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

// Виды черновика: task | event | food | water | sleep | workout | metric | goal (sleep, workout, metric —
// записи здоровья spec 020; goal — правка целей и настроек, записи не создаёт)
inline const std::vector<std::string> kQuickKinds = {"task", "event", "food", "water", "sleep", "workout", "metric",
                                                     "goal"};
inline constexpr int kQuickTaskMinutes = 30;
inline constexpr const char *kQuickRepeatOpen = "open";
inline constexpr const char *kQuickRepeatEnd = "end";

// Участок строки, распознанный как значение поля. Поля: kind, day, time, minutes, due, repeat, meal, grams,
// water, health, description, list, place, important, remind, kcal, protein, fat, carbs, fiber, sugar, salt
struct QuickSpan {
    std::string field;
    int from = 0;
    int to = 0;
};

// Другое чтение строки: значение поля, на которое пользователь может переключиться. `pick` — ключ значения:
// время `HH:MM` либо `HH:MM-HH:MM`, день и срок `YYYY-MM-DD`, тип записи, для повтора — `open` («до <дата>» не
// конец ряда, слова остаются в названии) либо `end` (обратно; `day` — конец ряда)
struct QuickAlt {
    std::string field; // kind | time | day | due | repeat
    std::string pick;
    std::optional<std::string> day;
};

// Чтение, закреплённое пользователем; тип закрепляется выбором типа (`QuickContext::kind`)
struct QuickPick {
    std::optional<std::string> time;
    std::optional<std::string> day;
    std::optional<std::string> due;
    std::optional<std::string> repeat;
};

// Выученное по правкам пользователя: первое слово названия → значения по умолчанию
struct QuickLearnedEntry {
    std::optional<std::string> kind; // task | event
    std::optional<double> minutes;
};
using QuickLearned = std::map<std::string, QuickLearnedEntry>;

struct QuickGoalChanges {
    std::map<std::string, double> goals; // kcal | protein | fat | carbs | fiber | water (мл)
    HealthGoals health;
    std::optional<double> dayStart;
    std::optional<double> dayEnd;
    std::optional<double> budget;
};

struct QuickDraft {
    std::string kind = "task";
    std::string name;
    // Описание задачи либо события: часть строки после названия
    std::optional<std::string> description;
    // Явные метки: `#список`, `@место`, `!` — важное (только у задачи)
    std::optional<std::string> list;
    std::optional<std::string> place;
    std::optional<bool> isImportant;
    // Напомнить за столько минут до начала (0 — в момент начала)
    std::optional<double> remind;
    std::optional<std::string> day;
    // День не назван: взят сегодняшний либо завтрашний (время уже прошло)
    std::optional<bool> isDayAssumed;
    std::optional<std::string> start;
    std::optional<std::string> end;
    std::optional<bool> isAllDay;
    std::optional<double> minutes;
    std::optional<std::string> due;
    std::optional<Repeat> repeat;
    std::optional<std::string> meal;
    std::optional<double> grams;
    std::optional<std::map<std::string, double>> nutrients; // kcal | protein | fat | carbs | fiber | sugar | salt
    std::optional<double> waterMl;
    // Здоровье: показатель (weight | pressure | pulse | steps | mood) и значения; у тренировки — км и упражнения
    std::optional<std::string> metric;
    std::optional<double> value;
    std::optional<double> value2;
    std::optional<double> distanceKm;
    std::optional<std::vector<Exercise>> exercises;
    std::optional<QuickGoalChanges> goalChanges;
    // Первое слово названия (нижний регистр, «ё» → «е», без служебных и однобуквенных) — ключ словаря правок
    std::optional<std::string> head;
    // Событие со временем: обычная длительность для этого слова без словаря правок
    std::optional<double> usualMinutes;
    // Что подставлено из словаря правок: kind | minutes
    std::optional<std::vector<std::string>> learned;
    std::optional<std::vector<QuickAlt>> alternatives;
    std::vector<QuickSpan> spans;
    std::optional<std::string> error;
};

struct QuickContext {
    std::string today;      // YYYY-MM-DD
    double nowMinutes = 0;  // минуты от полуночи: «время уже прошло» и приём пищи по времени суток
    double dayStart = 540;
    double dayEnd = 1260;
    // Тип выбран пользователем — сильнее слов строки
    std::optional<std::string> kind;
    // Типы, которые разбор вправе выбрать сам (по умолчанию все)
    std::optional<std::vector<std::string>> kinds;
    // Значения, снятые пользователем: их слова остаются в названии
    std::optional<std::vector<std::string>> skip;
    std::optional<QuickLearned> learned;
    std::optional<QuickPick> pick;
    // Язык интерфейса: ru (по умолчанию) | en
    std::optional<std::string> lang;
};

/** Разобрать строку в черновик. */
QuickDraft parseQuickInput(const std::string &typed, const QuickContext &ctx);
/** Язык словаря по коду языка интерфейса: «ru…» → ru, иначе en. */
std::string getQuickLang(const std::optional<std::string> &code);
/** Обычная длительность события по первому слову названия (минуты). */
double quickUsualMinutes(const std::string &name, const std::string &lang);
/** Описание записи из черновика: место (`@…`) — первой строкой, за ним описание из строки. */
std::optional<std::string> quickDescription(const QuickDraft &draft);

// JSON в виде web (отсутствующие поля не пишутся) — для отладки, тестов и передачи в UI
nlohmann::json toJson(const QuickDraft &draft);
QuickContext quickContextFromJson(const nlohmann::json &j);

} // namespace parvane::sections::planner
