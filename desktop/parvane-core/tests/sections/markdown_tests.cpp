// Parvane fork (spec 029, фаза 4): перенос 1:1 web `markdown/markdown.test.ts`.
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "parvane/sections/markdown.h"

using namespace parvane::sections::markdown;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

using Strings = std::vector<std::string>;

static std::string lines(const Strings &parts) {
    std::string out;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i) out.push_back('\n');
        out += parts[i];
    }
    return out;
}

static MdBlock heading(int level, const std::string &text, int line) {
    MdBlock block;
    block.type = MdBlockType::Heading;
    block.level = level;
    block.text = text;
    block.line = line;
    return block;
}

static MdBlock textBlock(MdBlockType type, const std::string &text, int line) {
    MdBlock block;
    block.type = type;
    block.text = text;
    block.line = line;
    return block;
}

static MdBlock list(bool isOrdered, int line, std::vector<MdListItem> items) {
    MdBlock block;
    block.type = MdBlockType::List;
    block.isOrdered = isOrdered;
    block.line = line;
    block.items = std::move(items);
    return block;
}

static MdBlock rule(int line) {
    MdBlock block;
    block.type = MdBlockType::Rule;
    block.line = line;
    return block;
}

static MdBlock embed(const std::string &name, int line, std::optional<std::string> alt = {},
    std::optional<std::string> url = {}) {
    MdBlock block;
    block.type = MdBlockType::Embed;
    block.name = name;
    block.line = line;
    block.alt = std::move(alt);
    block.url = std::move(url);
    return block;
}

static MdInline part(MdInlineType type, const std::string &text, const std::string &target = "",
    const std::string &url = "") {
    return MdInline{type, text, target, url};
}

static void dump(const std::vector<MdBlock> &blocks) {
    for (const auto &block : blocks) {
        std::printf("       блок %d строка %d текст «%s» имя «%s» пунктов %zu\n", static_cast<int>(block.type), block.line,
            block.text.c_str(), block.name.c_str(), block.items.size());
    }
}

int main() {
    std::printf("=== parvane-core markdown tests ===\n");
    std::printf("-- markdown\n");
    {
        const std::string text = lines({"---", "tags: [a]", "---", "# Поход", "", "## Вещи", "- палатка", "  - колышки",
            "- [x] спальник", "1. выйти", "2. дойти", "> мысль", "> дальше", "", "```", "code # не заголовок", "```",
            "---", "![[карта.png]]", "строка", "вторая"});
        const std::vector<MdBlock> expected{
            heading(2, "Вещи", 5),
            list(false, 6, {{"палатка", 0, std::nullopt, 6}, {"колышки", 1, std::nullopt, 7}, {"спальник", 0, true, 8}}),
            list(true, 9, {{"выйти", 0, std::nullopt, 9}, {"дойти", 0, std::nullopt, 10}}),
            textBlock(MdBlockType::Quote, "мысль\nдальше", 11),
            textBlock(MdBlockType::Code, "code # не заголовок", 14),
            rule(17),
            embed("карта.png", 18),
            textBlock(MdBlockType::Paragraph, "строка\nвторая", 19),
        };
        const auto blocks = parseMarkdown(text, "Поход");
        if (blocks != expected) dump(blocks);
        check(blocks == expected,
            "блоки: заголовок-название пропускается, списки, цитата, код, встроенный файл; номера строк — исходные");
    }
    {
        const std::string text = lines({"| Имя | Кол-во |", "|:---|---:|", "| a \\| b | 2 |", "| c |", "", "после"});
        MdBlock table;
        table.type = MdBlockType::Table;
        table.header = {"Имя", "Кол-во"};
        table.align = {MdAlign::Left, MdAlign::Right};
        table.rows = {{"a | b", "2"}, {"c", ""}};
        table.line = 0;
        const std::vector<MdBlock> expected{table, textBlock(MdBlockType::Paragraph, "после", 5)};
        const auto blocks = parseMarkdown(text);
        if (blocks != expected) dump(blocks);
        check(blocks == expected, "таблица: заголовок, выравнивание, `\\|` внутри ячейки, недостающие ячейки — пустые");
    }
    {
        const std::string text = lines(
            {"![[фото.jpg|подпись]]", "![карта](папка/карта%201.png)", "![x](https://site/a.png)", "![[фото.jpg]]"});
        const std::vector<MdBlock> expected{
            embed("фото.jpg", 0, "подпись"),
            embed("папка/карта 1.png", 1, "карта"),
            embed("https://site/a.png", 2, "x", "https://site/a.png"),
            embed("фото.jpg", 3),
        };
        const auto blocks = parseMarkdown(text);
        if (blocks != expected) dump(blocks);
        const std::map<std::string, std::string> rename{{"фото.jpg", "фото (2).jpg"}, {"папка/карта 1.png", "карта 1.png"}};
        const std::string renamed = renameEmbeds(text, rename);
        const std::string expectedRenamed = lines({"![[фото (2).jpg|подпись]]",
            "![карта](%D0%BA%D0%B0%D1%80%D1%82%D0%B0%201.png)", "![x](https://site/a.png)", "![[фото (2).jpg]]"});
        if (renamed != expectedRenamed) std::printf("       %s\n", renamed.c_str());
        check(blocks == expected && embedNames(text) == Strings{"фото.jpg", "папка/карта 1.png"} && renamed == expectedRenamed,
            "встроенные файлы: облако по имени и пути, внешний адрес не загружается");
    }
    {
        const std::vector<MdInline> expected{
            part(MdInlineType::Bold, "a"),
            part(MdInlineType::Text, " "),
            part(MdInlineType::Italic, "b"),
            part(MdInlineType::Text, " "),
            part(MdInlineType::Strike, "s"),
            part(MdInlineType::Text, " "),
            part(MdInlineType::Code, "c"),
            part(MdInlineType::Text, " "),
            part(MdInlineType::Link, "d", "", "https://x.y"),
            part(MdInlineType::Text, " "),
            part(MdInlineType::Note, "е", "E"),
            part(MdInlineType::Text, " "),
            part(MdInlineType::Tag, "#tag"),
            part(MdInlineType::Text, " f"),
        };
        const auto parts = parseInline("**a** _b_ ~~s~~ `c` [d](https://x.y) [[E|е]] #tag [f](javascript:1)");
        if (parts != expected) {
            for (const auto &item : parts) std::printf("       %d «%s»\n", static_cast<int>(item.type), item.text.c_str());
        }
        check(parts == expected, "строка: жирный, курсив, зачёркнутый, код, ссылки, заметки, теги; опасная ссылка — текстом");
    }
    check(parseInline("2*3*4") == std::vector<MdInline>{part(MdInlineType::Text, "2*3*4")}, "звёздочки внутри слова — не курсив");

    // Не из web-набора: последняя часть пути встроенного файла
    check(embedBaseName("папка/карта 1.png") == "карта 1.png" && embedBaseName("фото.jpg") == "фото.jpg"
            && embedBaseName("a//b/") == "b" && embedBaseName("/") == "/",
        "embedBaseName: последняя непустая часть пути");

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
