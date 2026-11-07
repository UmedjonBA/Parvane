// Parvane fork (spec 029, фаза 4; доработка 6 ноя 2026): разбор Markdown ядра. Главное — сверка с web по общему
// образцу `conformance/markdown/all-constructs.md`: ответ пишет web (`markdown.test.ts`), ядро обязано совпасть
// блоками и кусками каждой строки. Остальное — перенос проверок web и защиты ядра (скорость, ссылки).
#include <chrono>
#include <cstdio>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/markdown.h"

using namespace parvane::sections::markdown;
using nlohmann::json;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static std::string readFile(const std::string &path) {
    std::ifstream in(path, std::ios::binary);
    std::stringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

static json expectedOf(const std::string &markdown, const std::string &title) {
    const auto blocks = parseMarkdown(markdown, title);
    auto inlines = json::array();
    for (const auto &text : collectTexts(blocks)) inlines.push_back({{"text", text}, {"parts", toJson(parseInline(text))}});
    return {{"blocks", toJson(blocks)}, {"inlines", inlines}};
}

static void printDiff(const json &actual, const json &expected) {
    int shown = 0;
    for (const auto &op : json::diff(expected, actual)) {
        if (++shown > 12) break;
        const auto path = op.value("path", std::string());
        std::printf("       %s %s\n", op.value("op", std::string()).c_str(), path.c_str());
        try {
            std::printf("         web:  %s\n", expected.at(json::json_pointer(path)).dump().substr(0, 300).c_str());
        } catch (...) {
        }
        try {
            std::printf("         ядро: %s\n", actual.at(json::json_pointer(path)).dump().substr(0, 300).c_str());
        } catch (...) {
        }
    }
}

static bool sameJson(const json &actual, const char *expected) {
    const auto parsed = json::parse(expected);
    if (actual == parsed) return true;
    std::printf("       ядро: %s\n       ждём: %s\n", actual.dump().c_str(), parsed.dump().c_str());
    return false;
}

static double timed(const std::string &text) {
    const auto started = std::chrono::steady_clock::now();
    (void)parseMarkdown(text);
    (void)parseInline(text);
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
}

int main() {
    // Общий образец web ↔ ядро
    {
        const std::string dir = std::string(PARVANE_CONFORMANCE_DIR) + "/markdown/";
        const auto markdown = readFile(dir + "all-constructs.md");
        const auto expectedText = readFile(dir + "all-constructs.expected.json");
        const auto expected = json::parse(expectedText, nullptr, false);
        check(!markdown.empty() && !expected.is_discarded(), "образец conformance/markdown прочитан");
        if (!expected.is_discarded()) {
            const auto actual = expectedOf(markdown, "Тест");
            const bool same = actual == expected;
            if (!same) printDiff(actual, expected);
            check(same, "разбор образца совпадает с web (блоки и куски каждой строки)");
        }
    }
    // Перенос проверок web `markdown.test.ts`
    {
        const std::string text = "---\ntags: [a]\n---\n# Поход\n\n## Вещи\n- палатка\n  - колышки\n- [x] спальник\n1. выйти\n"
                                 "2. дойти\n> мысль\n> дальше\n\n```\ncode # не заголовок\n```\n---\n![[карта.png]]\nстрока\nвторая";
        check(sameJson(toJson(parseMarkdown(text, "Поход")), R"([
            {"type":"heading","level":2,"text":"Вещи","id":"вещи","line":5},
            {"type":"list","isOrdered":false,"line":6,"items":[
                {"text":"палатка","depth":0,"line":6},{"text":"колышки","depth":1,"line":7},
                {"text":"спальник","depth":0,"isChecked":true,"line":8},
                {"text":"выйти","depth":0,"number":1,"line":9},{"text":"дойти","depth":0,"number":2,"line":10}]},
            {"type":"quote","blocks":[{"type":"paragraph","text":"мысль\nдальше","line":11}],"line":11},
            {"type":"code","text":"code # не заголовок","line":14},
            {"type":"rule","line":17},
            {"type":"embed","name":"карта.png","line":18},
            {"type":"paragraph","text":"строка\nвторая","line":19}])"),
            "блоки: заголовок-название пропускается, списки, цитата, код, встроенный файл; номера строк — исходные");
        check(sameJson(toJson(parseMarkdown("| Имя | Кол-во |\n|:---|---:|\n| a \\| b | 2 |\n| c |\n\nпосле")), R"([
            {"type":"table","header":["Имя","Кол-во"],"align":["left","right"],"rows":[["a | b","2"],["c",""]],"line":0},
            {"type":"paragraph","text":"после","line":5}])"),
            "таблица: заголовок, выравнивание, `\\|` внутри ячейки, недостающие ячейки — пустые");
        const std::string embeds = "![[фото.jpg|подпись]]\n![карта](папка/карта%201.png)\n![x](https://site/a.png)\n![[фото.jpg]]";
        const auto renamed = renameEmbeds(embeds, {{"фото.jpg", "фото (2).jpg"}, {"папка/карта 1.png", "карта 1.png"}});
        {
            // Строка, начатая табуляцией, — код (до 4 колонок, как CommonMark); в списке табуляция — уровень
            const auto blocks = parseMarkdown("абзац\n\n\tкод с табуляцией\n\n- пункт\n\t- вложенный");
            check(blocks.size() == 3 && blocks[1].type == MdBlockType::Code && blocks[1].text == "код с табуляцией"
                && blocks[2].items.size() == 2 && blocks[2].items[1].depth == 1, "табуляция: код и уровень списка");
        }
        check(embedNames(embeds) == std::vector<std::string>{"фото.jpg", "папка/карта 1.png"}
                && renamed == "![[фото (2).jpg|подпись]]\n![карта](%D0%BA%D0%B0%D1%80%D1%82%D0%B0%201.png)\n"
                              "![x](https://site/a.png)\n![[фото (2).jpg]]",
            "встроенные файлы: имена и переименование");
        check(sameJson(toJson(parseInline("**a *b*** _c_ ~~s~~ ==m== <u>u</u> `c` [d](https://x.y) [[E|е]] #tag [f](javascript:1)")),
                  R"([{"type":"text","text":"a ","style":1},{"type":"text","text":"b","style":3},{"type":"text","text":" "},
                      {"type":"text","text":"c","style":2},{"type":"text","text":" "},{"type":"text","text":"s","style":4},
                      {"type":"text","text":" "},{"type":"text","text":"m","style":16},{"type":"text","text":" "},
                      {"type":"text","text":"u","style":8},{"type":"text","text":" "},{"type":"text","text":"c","style":128},
                      {"type":"text","text":" "},{"type":"link","text":"d","url":"https://x.y"},{"type":"text","text":" "},
                      {"type":"note","text":"е","target":"E"},{"type":"text","text":" "},{"type":"tag","text":"#tag"},
                      {"type":"text","text":" f"}])"),
            "строка: начертания, вложенность, ссылки, заметки, теги; опасная ссылка — текстом");
        check(sameJson(toJson(parseInline("2 * 3 * 4 snake_case_x \\*x\\*")),
                  R"([{"type":"text","text":"2 * 3 * 4 snake_case_x *x*"}])")
                && sameJson(toJson(parseInline("#123 #тег")), R"([{"type":"text","text":"#123 "},{"type":"tag","text":"#тег"}])"),
            "звёздочки между пробелами и подчёркивания внутри слова — не курсив; экранирование");
        check(embedBaseName("папка/карта 1.png") == "карта 1.png" && embedBaseName("фото.jpg") == "фото.jpg",
            "embedBaseName: последняя часть пути");
    }
    // Злонамеренная разметка разбирается быстро (не квадратично)
    {
        double worst = 0;
        for (const char *unit : {"[", "[[", "**", "~~", "`", "[a](", " _", " #a", "*a ", "* a ", "`` ` ", "<!--", "[a](<",
                 "[a](x \"", "<u>", "&#", "> ", "- x\n  ", "%%a"}) {
            std::string text;
            while (text.size() < 65536) text += unit;
            worst = std::max(worst, timed(text));
            worst = std::max(worst, timed(text + "\n" + text));
        }
        std::string many;
        while (many.size() < 65536) many += "**a** ";
        worst = std::max(worst, timed(many));
        std::printf("       худший разбор 64 КБ: %.3f с\n", worst);
        check(worst < 1.0, "64 КБ злонамеренной разметки — меньше 1 с");
        std::string big;
        while (big.size() < 1024 * 1024) big += "[";
        check(timed(big) < 4.0, "1 МБ `[` — меньше 4 с (линейно)");
        check(parseInline(many).size() > 10000, "много кусков — все разобраны");
        std::string deep;
        for (int i = 0; i < 5000; ++i) deep += "> ";
        (void)parseMarkdown(deep + "x");
        check(true, "5000 уровней цитаты — без переполнения стека");
    }
    // Ссылки статьи: подпись ≠ адрес — открывать только после подтверждения; схемы — только http(s)/mailto
    {
        check(linkNeedsConfirmation("https://bank.example", "https://evil.example"), "подпись-адрес другого сайта — подтверждение");
        check(linkNeedsConfirmation("https://bank.example", "https://bank.example.evil.example/"), "подпись — префикс адреса — подтверждение");
        check(linkNeedsConfirmation("тут", "https://example.com"), "словесная подпись — подтверждение");
        check(!linkNeedsConfirmation("https://Example.com/", "https://example.com") && !linkNeedsConfirmation("example.com", "https://www.example.com/")
                  && !linkNeedsConfirmation("", "https://example.com") && !linkNeedsConfirmation("a@b.c", "mailto:a@b.c"),
              "подпись совпадает с адресом (регистр, схема, www, /) — без подтверждения");
        check(isSafeUrl("https://x") && isSafeUrl("HTTP://x") && isSafeUrl("mailto:a@b") && !isSafeUrl("tg://resolve?domain=x")
                  && !isSafeUrl("file:///etc/passwd") && !isSafeUrl("javascript:alert(1)") && !isSafeUrl(" https://x"),
              "isSafeUrl: только http(s) и mailto");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
