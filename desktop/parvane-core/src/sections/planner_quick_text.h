// Parvane fork (spec 029, фаза 4): внутренний помощник ввода текстом «Плана» — строки и регулярные выражения
// с поведением JavaScript. Web режет строки по единицам UTF-16 (позиции участков, `length`, `slice`), поэтому
// разбор идёт по std::u16string: позиции совпадают с web и с QString десктопа. std::regex с кириллицей в UTF-8
// ненадёжен — здесь свой небольшой движок с откатом (подмножество синтаксиса JS, которое нужно разбору):
// альтернатива, группы (?:) (?=) (?!), классы с диапазонами, \d \s \S \w \p{L} \p{N} \p{P}, квантификаторы
// ? * + {n,m} (жадные и ленивые), ^ $, флаги i (регистр), u (кодовые точки), m (^ $ по строкам).
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace parvane::sections::planner::text {

using S = std::u16string;

// UTF-8 ↔ UTF-16. Одиночные суррогаты переживают оборот (кодируются WTF-8), неверные байты — U+FFFD
S fromUtf8(const std::string &utf8);
std::string toUtf8(const S &text);

// String.prototype.toLowerCase для латиницы, кириллицы, греческого и др. (простые соответствия);
// «İ» → «i̇» (две единицы), как в JS
S jsLower(const S &text);
char16_t lowerUnit(char16_t c);
// «ё» → «е» после нижнего регистра
S foldYo(S text);
// Пробельный символ JS (`\s`, `trim`)
bool isJsSpace(char32_t c);
// Буква и цифра Юникода (`\p{L}`, `\p{N}`), знак препинания (`\p{P}`) — приближение по основным блокам
bool isLetter(char32_t c);
bool isNumber(char32_t c);
bool isPunct(char32_t c);

S trim(const S &text);
S trimEnd(const S &text);
S trimStart(const S &text);
S repeat(const S &text, size_t count);
inline constexpr long kToEnd = -0x7fffffffL;
S slice(const S &text, long from, long to = kToEnd); // как String.prototype.slice (отрицательные — от конца)
long indexOf(const S &text, const S &needle, size_t from = 0);
std::vector<S> splitStr(const S &text, const S &sep);
// Number(text) для строк из цифр с необязательной точкой; иное — NaN
double jsNumber(const S &text);

struct Match {
    std::vector<int> slots; // 2 на группу: начало и конец; -1 — группа не участвовала
    int index() const { return slots[0]; }
    int end() const { return slots[1]; }
    bool has(int group) const { return group * 2 + 1 < int(slots.size()) && slots[group * 2] >= 0; }
    int start(int group) const { return slots[group * 2]; }
    int stop(int group) const { return slots[group * 2 + 1]; }
    S str(const S &text, int group) const {
        return has(group) ? text.substr(size_t(start(group)), size_t(stop(group) - start(group))) : S();
    }
    int groups() const { return int(slots.size()) / 2; }
};

class Regex {
public:
    Regex(const S &pattern, const std::string &flags);
    ~Regex();
    // Первое совпадение не раньше `from` (как exec с lastIndex у выражения с флагом g)
    bool exec(const S &text, int from, Match &out) const;
    bool test(const S &text) const;
    int groupCount() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Выражение из UTF-8 тела; компилируется один раз (общий кэш процесса, ссылка живёт до выхода)
#if defined(__GNUC__) && !defined(__clang__) && __GNUC__ >= 14
#define PV_NO_DANGLING [[gnu::no_dangling]]
#else
#define PV_NO_DANGLING
#endif
PV_NO_DANGLING const Regex &rx(const std::string &pattern, const std::string &flags = "");

// Все совпадения подряд (как цикл exec с флагом g; пустое совпадение сдвигает на единицу)
std::vector<Match> matchAll(const Regex &re, const S &text);
// String.prototype.replace с флагом g
template <typename F>
S replaceAll(const Regex &re, const S &text, F &&replacer) {
    S out;
    int copied = 0;
    for (const auto &m : matchAll(re, text)) {
        out += text.substr(size_t(copied), size_t(m.index() - copied));
        out += replacer(m);
        copied = m.end();
    }
    out += text.substr(size_t(copied));
    return out;
}
// String.prototype.replace без флага g: только первое совпадение
template <typename F>
S replaceFirst(const Regex &re, const S &text, F &&replacer) {
    Match m;
    if (!re.exec(text, 0, m)) return text;
    return text.substr(0, size_t(m.index())) + replacer(m) + text.substr(size_t(m.end()));
}
// String.prototype.split по выражению без групп
std::vector<S> splitRe(const Regex &re, const S &text);
// String.prototype.search: позиция первого совпадения либо -1
int search(const Regex &re, const S &text);

} // namespace parvane::sections::planner::text
