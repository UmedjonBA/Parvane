// Parvane fork (spec 029, фаза 4): числительные словами для ввода текстом «Плана» — тесты 1:1 с web
// `components/parvane/planner/plannerNumerals.test.ts`. Позиции — в единицах UTF-16, как в web.
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/sections/planner_numerals.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// UTF-8 → UTF-16 без зависимостей (строки тестов — корректный UTF-8)
static std::u16string W(const std::string &s) {
    std::u16string out;
    for (size_t i = 0; i < s.size();) {
        const unsigned char c = s[i];
        char32_t cp;
        int len;
        if (c < 0x80) { cp = c; len = 1; }
        else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; len = 2; }
        else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; len = 3; }
        else { cp = c & 0x07; len = 4; }
        for (int k = 1; k < len; ++k) cp = (cp << 6) | (s[i + k] & 0x3F);
        i += len;
        if (cp >= 0x10000) {
            cp -= 0x10000;
            out += char16_t(0xD800 + (cp >> 10));
            out += char16_t(0xDC00 + (cp & 0x3FF));
        } else {
            out += char16_t(cp);
        }
    }
    return out;
}

struct Row {
    NumeralLang lang;
    const char *input;
    const char *rewritten;
};

static const std::vector<Row> kRows = {
    {NumeralLang::Ru, "в пять", "в 5"},
    {NumeralLang::Ru, "в семь вечера", "в 7 вечера"},
    {NumeralLang::Ru, "В Семь", "В 7"},
    {NumeralLang::Ru, "в десять тридцать", "в 10:30"},
    {NumeralLang::Ru, "в двадцать тридцать", "в 20:30"},
    {NumeralLang::Ru, "в двадцать один тридцать", "в 21:30"},
    {NumeralLang::Ru, "в семь ноль пять", "в 7:05"},
    {NumeralLang::Ru, "в девять ноль ноль", "в 9:00"},
    {NumeralLang::Ru, "в двадцать пять", "в 25"},
    {NumeralLang::Ru, "десять тридцать", "10 30"},
    {NumeralLang::Ru, "через два дня", "через 2 дня"},
    {NumeralLang::Ru, "три раза", "3 раза"},
    {NumeralLang::Ru, "каждые две недели", "каждые 2 недели"},
    {NumeralLang::Ru, "сорок пять минут", "45 минут"},
    {NumeralLang::Ru, "девяносто девять", "99"},
    {NumeralLang::Ru, "с десяти до двенадцати", "с 10 до 12"},
    {NumeralLang::Ru, "до трёх", "до 3"},
    {NumeralLang::Ru, "около трёх", "около трёх"},
    {NumeralLang::Ru, "на час", "1 ч"},
    {NumeralLang::Ru, "на час дня", "на час дня"},
    {NumeralLang::Ru, "в час", "в 1"},
    {NumeralLang::Ru, "в час дня", "в 1 дня"},
    {NumeralLang::Ru, "в час пик", "в час пик"},
    {NumeralLang::Ru, "классный час", "классный час"},
    {NumeralLang::Ru, "два с половиной часа", "2.5 часа"},
    {NumeralLang::Ru, "два с половиной литра", "2 с половиной литра"},
    {NumeralLang::Ru, "полтретьего", "2:30"},
    {NumeralLang::Ru, "пол третьего", "2:30"},
    {NumeralLang::Ru, "пол-третьего", "2:30"},
    {NumeralLang::Ru, "половина третьего", "2:30"},
    {NumeralLang::Ru, "в половине первого", "в 12:30"},
    {NumeralLang::Ru, "полдвенадцатого", "11:30"},
    {NumeralLang::Ru, "без пятнадцати пять", "4:45"},
    {NumeralLang::Ru, "без четверти пять", "4:45"},
    {NumeralLang::Ru, "без четверти час", "12:45"},
    {NumeralLang::Ru, "без пяти минут шесть", "5:55"},
    {NumeralLang::Ru, "без двадцати пяти десять", "9:35"},
    {NumeralLang::Ru, "без пяти минут инженер", "без пяти минут инженер"},
    {NumeralLang::Ru, "четверть шестого", "5:15"},
    {NumeralLang::Ru, "четверть первого", "12:15"},
    {NumeralLang::Ru, "пять минут шестого", "5:05"},
    {NumeralLang::Ru, "двадцать минут первого", "12:20"},
    {NumeralLang::Ru, "пять минут назад", "5 минут назад"},
    {NumeralLang::Ru, "пара", "пара"},
    {NumeralLang::Ru, "полчаса", "полчаса"},
    {NumeralLang::Ru, "полдень", "полдень"},
    {NumeralLang::Ru, "пол", "пол"},
    {NumeralLang::Ru, "тридцатый", "тридцатый"},
    {NumeralLang::Ru, "v2два", "v2два"},
    {NumeralLang::Ru, "", ""},
    {NumeralLang::En, "at five", "at 5"},
    {NumeralLang::En, "at seven pm", "at 7 pm"},
    {NumeralLang::En, "At Seven", "At 7"},
    {NumeralLang::En, "at ten thirty", "at 10:30"},
    {NumeralLang::En, "at seven oh five", "at 7:05"},
    {NumeralLang::En, "at twenty-one thirty", "at 21:30"},
    {NumeralLang::En, "ten thirty", "10 30"},
    {NumeralLang::En, "five o'clock", "5"},
    {NumeralLang::En, "five o’clock", "5"},
    {NumeralLang::En, "in two days", "in 2 days"},
    {NumeralLang::En, "three times", "3 times"},
    {NumeralLang::En, "every two weeks", "every 2 weeks"},
    {NumeralLang::En, "twenty five minutes", "25 minutes"},
    {NumeralLang::En, "twenty-five minutes", "25 minutes"},
    {NumeralLang::En, "half past two", "2:30"},
    {NumeralLang::En, "half past twelve", "12:30"},
    {NumeralLang::En, "quarter to five", "4:45"},
    {NumeralLang::En, "a quarter to five", "4:45"},
    {NumeralLang::En, "quarter to one", "12:45"},
    {NumeralLang::En, "quarter past five", "5:15"},
    {NumeralLang::En, "quarter after five", "5:15"},
    {NumeralLang::En, "ten past five", "5:10"},
    {NumeralLang::En, "ten minutes past five", "5:10"},
    {NumeralLang::En, "ten minutes to five", "4:50"},
    {NumeralLang::En, "ten to five", "10 to 5"},
    {NumeralLang::En, "two and a half hours", "2.5 hours"},
    {NumeralLang::En, "two and a half men", "2 and a half men"},
    {NumeralLang::En, "for an hour", "1 hr"},
    {NumeralLang::En, "for an hour and a half", "for an hour and a half"},
    {NumeralLang::En, "a week", "a week"},
    {NumeralLang::En, "half an hour", "half an hour"},
    {NumeralLang::En, "noon", "noon"},
    {NumeralLang::En, "second", "second"},
    {NumeralLang::En, "someone", "someone"},
    {NumeralLang::En, "v2two", "v2two"},
};

int main() {
    std::printf("=== parvane-core planner numerals tests ===\n");
    for (const auto &row : kRows) {
        const auto got = rewriteNumeralsText(row.input, row.lang);
        check(got == row.rewritten, std::string(row.lang == NumeralLang::Ru ? "ru: «" : "en: «") + row.input + "» → «"
              + row.rewritten + "»" + (got == row.rewritten ? "" : " (получено «" + got + "»)"));
    }

    // числительные: исходные слова
    {
        const auto r = rewriteNumerals(W("Встреча Полтретьего и в Пять"), NumeralLang::Ru);
        const bool ok = r.text == W("Встреча 2:30 и в 5") && r.edits.size() == 2
            && r.edits[0].from == 8 && r.edits[0].to == 12 && r.edits[0].value == u"2:30"
            && r.edits[0].source == W("Полтретьего") && r.edits[0].isLoose == true
            && r.edits[1].from == 17 && r.edits[1].to == 18 && r.edits[1].value == u"5"
            && r.edits[1].source == W("Пять") && !r.edits[1].isLoose.has_value();
        check(ok, "замены помнят слова и разговорные часы");
    }
    {
        const auto text = W("купить молоко завтра");
        const auto r = rewriteNumerals(text, NumeralLang::Ru);
        check(r.text == text && r.edits.empty() && restoreNumerals(text, {}) == text,
              "строка без числительных не меняется");
    }
    {
        const auto r = rewriteNumerals(W("купить пять яблок в семь вечера"), NumeralLang::Ru);
        bool ok = r.text == W("купить 5 яблок в 7 вечера");
        ok = ok && restoreNumerals(r.text, r.edits) == W("купить пять яблок в семь вечера");
        // «в 7 вечера» распознано: на его месте пробелы
        const auto marked = r.text.substr(0, 15) + std::u16string(r.text.size() - 15, u' ');
        ok = ok && restoreNumerals(marked, r.edits)
            == W("купить пять яблок ") + std::u16string(W("в семь вечера").size(), u' ');
        check(ok, "нетронутая замена возвращает слова, забранная — пробелы");
    }
    {
        const auto source = W("в десять тридцать завтра");
        const auto r = rewriteNumerals(source, NumeralLang::Ru);
        bool ok = r.text == W("в 10:30 завтра");
        const int from = int(r.text.find(W("завтра")));
        const auto cut = [&](int a, int b) { return source.substr(size_t(a), size_t(b - a)); };
        ok = ok && cut(toSourceOffset(from, r.edits), toSourceOffset(int(r.text.size()), r.edits, true)) == W("завтра");
        ok = ok && cut(toSourceOffset(0, r.edits), toSourceOffset(7, r.edits, true)) == W("в десять тридцать");
        // Позиция внутри замены — её край
        ok = ok && toSourceOffset(4, r.edits) == 2;
        ok = ok && toSourceOffset(4, r.edits, true) == int(W("в десять тридцать").size());
        check(ok, "позиции переписанной строки переводятся в исходные");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
