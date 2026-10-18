// Parvane fork (spec 029, фаза 4): ссылки на заметки в названии записи «Плана» — тесты 1:1 с web
// `components/parvane/planner/plannerLinks.test.ts`.
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/sections/planner_links.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

using Parts = std::vector<NamePart>;
static NamePart T(const char *text) { return {text, std::nullopt}; }
static NamePart L(const char *text, const char *note) { return {text, std::string(note)}; }

// Длина в единицах UTF-16
static size_t u16len(const std::string &s) {
    size_t n = 0;
    for (size_t i = 0; i < s.size();) {
        const unsigned char c = s[i];
        const int len = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : 4;
        n += len == 4 ? 2 : 1;
        i += len;
    }
    return n;
}

// Подстрока по единицам UTF-16 (тексты тестов — только BMP)
static std::string u16slice(const std::string &s, size_t from, size_t to) {
    std::string out;
    size_t n = 0;
    for (size_t i = 0; i < s.size();) {
        const unsigned char c = s[i];
        const int len = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : 4;
        if (n >= from && n < to) out += s.substr(i, len);
        ++n;
        i += len;
    }
    return out;
}

int main() {
    std::printf("=== parvane-core planner links tests ===\n");
    check(splitNameLinks("Созвон команды") == Parts{T("Созвон команды")} && splitNameLinks("").empty(),
          "название без ссылок — одна часть текста");
    check(splitNameLinks("созвон [[Сервер X99]] в четверг")
              == Parts{T("созвон "), L("Сервер X99", "Сервер X99"), T(" в четверг")},
          "ссылка показывает название заметки, остальное остаётся текстом");
    check(splitNameLinks("[[Сервер X99|сервер]]") == Parts{L("сервер", "Сервер X99")}
              && splitNameLinks("[[Parvane|]]") == Parts{L("Parvane", "Parvane")}
              && splitNameLinks("[[ Parvane | проект ]]") == Parts{L("проект", "Parvane")},
          "ссылка с подписью показывает подпись, а ведёт на заметку");
    check(splitNameLinks("[[А]][[Б|вторая]] и текст") == Parts{L("А", "А"), L("вторая", "Б"), T(" и текст")},
          "несколько ссылок подряд и в начале строки");
    check(splitNameLinks("план [[без конца") == Parts{T("план [[без конца")}
              && splitNameLinks("пусто [[]] и [[ ]]") == Parts{T("пусто [[]] и [[ ]]")}
              && splitNameLinks("массив [1] и [2]") == Parts{T("массив [1] и [2]")}
              && splitNameLinks("[[[Заметка]]]") == Parts{T("["), L("Заметка", "Заметка"), T("]")},
          "незакрытые, пустые и одинарные скобки остаются текстом");
    check(formatPlainName("созвон [[Сервер X99|сервер]] и [[Parvane]]") == "созвон сервер и Parvane"
              && formatPlainName("Зарядка") == "Зарядка",
          "название без разметки: подпись либо название заметки на месте ссылки");
    check(formatDescriptionLine(std::string("будет тест\nвзять тетрадь")) == "будет тест"
              && formatDescriptionLine(std::string("\n  см. [[Конспект|конспект]] \nещё")) == "см. конспект"
              && formatDescriptionLine(std::string("")) == "" && formatDescriptionLine(std::nullopt) == "",
          "строка описания для расписания: первая непустая, без разметки ссылок");
    {
        const std::string source = "[[Встреча завтра]] сб [[А|б]][[В]] 15:00";
        const auto masked = maskNameLinks(source);
        bool ok = masked.links == std::vector<std::string>{"[[Встреча завтра]]", "[[А|б]]", "[[В]]"};
        ok = ok && u16len(masked.text) == u16len(source);
        ok = ok && masked.text.find('[') == std::string::npos && masked.text.find(']') == std::string::npos
            && masked.text.find('|') == std::string::npos && masked.text.find("завтра") == std::string::npos;
        ok = ok && u16slice(masked.text, 18, 22) == " сб ";
        ok = ok && unmaskNameLinks(masked.text, masked.links) == source;
        // Часть строки (название без описания) возвращает только свои ссылки
        ok = ok && unmaskNameLinks(u16slice(masked.text, 0, 18), masked.links) == "[[Встреча завтра]]";
        // Скобки без названия ссылкой не считаются
        const auto empty = maskNameLinks("[[]] и [[ ]]");
        ok = ok && empty.text == "[[]] и [[ ]]" && empty.links.empty();
        ok = ok && unmaskNameLinks("без ссылок", {}) == "без ссылок";
        check(ok, "заглушки закрывают ссылки, не сдвигая остальной текст, и снимаются обратно");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
