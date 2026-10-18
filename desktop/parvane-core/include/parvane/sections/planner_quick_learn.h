// Parvane fork (spec 029, T061): ввод текстом «Плана» — личный словарь правок. Порт web
// `components/parvane/planner/plannerQuickLearn.ts`: правка угаданного типа записи либо длительности события
// запоминается за первым словом названия (`QuickDraft::head`); одна и та же правка `kLearnThreshold` раз
// становится значением по умолчанию — разбор получает его через `QuickContext::learned`.
//
// Отличия от web:
// - запасной путь web (словарь в localStorage, пока «План» недоступен: parse/serialize/read/save/reset и
//   `mergeLearnStores`) не перенесён: на desktop ввод текстом работает только с загруженным «Планом», словарь —
//   всегда `State::learned`;
// - «прежний объект» web (`toBe`) — признак `changed` в результате.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_quick.h"
#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

inline constexpr int kLearnThreshold = 3;
inline constexpr int kLearnMaxCount = 5;
inline constexpr size_t kLearnMaxHeads = 200;

template <typename T>
struct LearnCounted {
    T value{};
    int count = 0;
    bool operator==(const LearnCounted &) const = default;
};

struct LearnHead {
    std::optional<LearnCounted<std::string>> kind; // task | event
    std::optional<LearnCounted<double>> minutes;
    double at = 0;
    bool operator==(const LearnHead &) const = default;
};

struct LearnStore {
    double tick = 0;
    std::map<std::string, LearnHead> heads;
    bool operator==(const LearnStore &) const = default;
};

// Учесть добавленную запись: `autoDraft` — разбор той же строки без участия пользователя, `final` — добавленный
// черновик. `changed` — словарь изменился (в web — новый объект)
struct LearnResult {
    LearnStore store;
    bool changed = false;
};
LearnResult recordCorrection(const LearnStore &store, const QuickDraft &autoDraft, const QuickDraft &final);

// Значения по умолчанию для разбора: только правки, набравшие порог
QuickLearned learnedDefaults(const LearnStore &store);

// Слова из данных «Плана» ↔ рабочий словарь (слова — по алфавиту; непригодное движку пропускается)
LearnStore learnStoreFromWords(const std::vector<LearnedWord> &words);
std::vector<LearnedWord> learnStoreToWords(const LearnStore &store);
bool hasLearned(const LearnStore &store);

// Правка добавленной записи для данных «Плана»: новый список слов либо `nullopt`, если писать нечего
std::optional<std::vector<LearnedWord>> correctWords(const std::vector<LearnedWord> &words,
                                                     const QuickDraft &autoDraft, const QuickDraft &final);

} // namespace parvane::sections::planner
