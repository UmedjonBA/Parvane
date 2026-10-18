// Parvane fork (spec 029, фаза 4): ссылки на заметки «Знаний» в названии записи «Плана» — `[[Заметка]]` и
// `[[Заметка|подпись]]`. Порт web `components/parvane/planner/plannerLinks.ts`. Длины и позиции — в единицах
// UTF-16, как в web (заглушка ссылки той же длины, что и ссылка).
#pragma once

#include <optional>
#include <string>
#include <vector>

namespace parvane::sections::planner {

// Часть названия: обычный текст либо ссылка (`note` — название заметки, `text` — что показать)
struct NamePart {
    std::string text;
    std::optional<std::string> note;
    bool operator==(const NamePart &) const = default;
};

/** Название записи по частям: текст и ссылки на заметки. Скобки без названия остаются текстом. */
std::vector<NamePart> splitNameLinks(const std::string &name);
/** Название без разметки ссылок — для подсказок и подписей, где ссылку не нажать. */
std::string formatPlainName(const std::string &name);
/** Первая непустая строка описания без разметки ссылок — вторая строка записи в расписании. */
std::string formatDescriptionLine(const std::optional<std::string> &description);

/**
 * Ссылки строки, закрытые заглушками той же длины (знаки U+E000…U+F8FF, по одному на ссылку): разбор ввода
 * текстом не читает слова внутри ссылки, а позиции остальных символов не сдвигаются.
 */
struct MaskedLinks {
    std::string text;
    std::vector<std::string> links;
};
MaskedLinks maskNameLinks(const std::string &text);
std::string unmaskNameLinks(const std::string &text, const std::vector<std::string> &links);

// То же над UTF-16 (разбор ввода текстом работает в единицах UTF-16)
struct MaskedLinks16 {
    std::u16string text;
    std::vector<std::u16string> links;
};
MaskedLinks16 maskNameLinks16(const std::u16string &text);
std::u16string unmaskNameLinks16(const std::u16string &text, const std::vector<std::u16string> &links);

} // namespace parvane::sections::planner
