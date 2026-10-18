// Parvane fork (spec 029, фаза 4): числительные словами для ввода текстом «Плана» (spec 017). Порт web
// `components/parvane/planner/plannerNumerals.ts`: проход перед распознавателями — слова-числа и разговорные
// обозначения времени заменяются цифрами («в пять» → «в 5», «полтретьего» → «2:30», «half past two» → «2:30»).
// Каждая замена помнит исходные слова: если её цифры никто не забрал, в название возвращается то, что набрал
// пользователь. Позиции — в единицах UTF-16, как в web.
#pragma once

#include <optional>
#include <string>
#include <vector>

namespace parvane::sections::planner {

enum class NumeralLang { Ru, En };

// Замена: участок `from…to` переписанной строки (текст `value`) стоит на месте слов `source`
struct NumeralEdit {
    int from = 0;
    int to = 0;
    std::u16string value;
    std::u16string source;
    std::optional<bool> isLoose; // разговорные часы: половину суток выбирает разбор по окну дня
};

struct NumeralRewrite {
    std::u16string text;
    std::vector<NumeralEdit> edits;
};

/** Переписать числительные строки цифрами; `edits` — что на что заменено (позиции в переписанной строке). */
NumeralRewrite rewriteNumerals(const std::u16string &text, NumeralLang lang);
/** То же для UTF-8: только переписанный текст. */
std::string rewriteNumeralsText(const std::string &text, NumeralLang lang);

/**
 * Строка в исходных словах. `marked` — переписанная строка, в которой распознанное заменено пробелами:
 * нетронутая замена возвращает слова пользователя, забранная — пробелы той же длины.
 */
std::u16string restoreNumerals(const std::u16string &marked, const std::vector<NumeralEdit> &edits);

/** Позиция переписанной строки в исходной; позиция внутри замены — её край (начало либо конец). */
int toSourceOffset(int position, const std::vector<NumeralEdit> &edits, bool isEnd = false);

} // namespace parvane::sections::planner
