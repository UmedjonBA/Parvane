// Parvane fork (spec 029, фаза 4): одна заметка с двух устройств — порт web `notes/notesMerge.ts`. Построчное
// трёхстороннее слияние с общей версией. Правки разных мест складываются, одинаковые берутся один раз. Если одно
// место изменено по-разному — конфликт: текст остаётся «моим» без меток, а «их» версию вызывающий сохраняет
// отдельной копией. Переводы строк приводятся к `\n`.
#pragma once

#include <string>

namespace parvane::sections::notes {

struct NotesMergeResult {
    std::string text;
    bool hasConflict = false;
    bool operator==(const NotesMergeResult &) const = default;
};

// Таблица сравнения растёт как произведение длин; больше — не сравниваем построчно
inline constexpr long long kMaxDiffCells = 4'000'000;

NotesMergeResult mergeNotes(const std::string &base, const std::string &mine, const std::string &theirs);

} // namespace parvane::sections::notes
