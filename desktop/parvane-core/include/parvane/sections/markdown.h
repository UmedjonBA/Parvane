// Parvane fork (spec 029, фаза 4; доработка 6 ноя 2026): общий разбор Markdown заметок «Знаний» и статьи в чате
// (ARTICLE-1) — порт web `components/parvane/markdown/markdown.ts` (без отрисовки). Сверка с web — общий образец
// `conformance/markdown/all-constructs.md` (+ `.expected.json`, пишет web, читает `tests/sections/markdown_tests.cpp`).
//
// Блоки: заголовки H1–H6 (свой id `{#id}`, якорь как у GitHub), абзацы, списки (галочки, нумерация с первого номера,
// вложенность по отступу, блоки внутри пункта), цитаты с блоками внутри и вложенные, callouts (`> [!NOTE]`,
// `> [!info]-`), код ``` / ~~~ / отступом 4 (язык из info string), черта, таблицы, встроенные файлы; комментарии
// `<!-- -->` и `%% %%` скрыты. В строке — куски с набором начертаний (MdStyle), ссылки http(s)/mailto и якоря
// `#раздел`, голые адреса, `<адрес>`, [[заметки]], #теги, экранирование `\*`, HTML-сущности, разрешённые теги.
// У блоков и пунктов — номер строки исходного текста (с нуля): заметка по нему отмечает пункт выполненным.
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::sections::markdown {

// Начертания куска строки — набор битов (как MD_* web)
enum MdStyle : uint32_t {
    kMdBold = 1,
    kMdItalic = 2,
    kMdStrike = 4,
    kMdUnderline = 8,
    kMdMark = 16,
    kMdSub = 32,
    kMdSup = 64,
    kMdCode = 128,
};

enum class MdInlineType { Text, Tag, Note, Link };

struct MdInline {
    MdInlineType type = MdInlineType::Text;
    std::string text;
    // Только `Note`
    std::string target;
    // Только `Link`: http(s)/mailto либо `#якорь`
    std::string url;
    uint32_t style = 0;
    bool operator==(const MdInline &) const = default;
};

struct MdBlock;

struct MdListItem {
    std::string text;
    int depth = 0;
    std::optional<bool> isChecked;
    // Номер пункта нумерованного списка; пусто — маркер-точка
    std::optional<int> number;
    // Блоки внутри пункта (второй абзац, код, цитата — строки с отступом пункта)
    std::vector<MdBlock> blocks;
    int line = 0;
    bool operator==(const MdListItem &) const;
};

enum class MdAlign { None, Left, Center, Right };

enum class MdBlockType { Heading, Paragraph, List, Quote, Code, Rule, Table, Embed };

struct MdCallout {
    std::string kind;
    std::string title;
    // "" — не сворачивается, "open" / "closed"
    std::string fold;
    bool operator==(const MdCallout &) const = default;
};

// Блок — объединение видов web: заполнены только поля своего вида
struct MdBlock {
    MdBlockType type = MdBlockType::Paragraph;
    int line = 0;
    // Heading: 1…6 и якорь
    int level = 0;
    std::string id;
    // Heading, Paragraph, Code
    std::string text;
    // Code: язык из info string (пусто — нет)
    std::string lang;
    // List
    bool isOrdered = false;
    std::vector<MdListItem> items;
    // Quote: блоки внутри и callout
    std::vector<MdBlock> children;
    std::optional<MdCallout> callout;
    // Table
    std::vector<std::string> header;
    std::vector<MdAlign> align;
    std::vector<std::vector<std::string>> rows;
    // Embed: `name` — имя (путь) файла облака; внешний адрес (`url`) не загружается — показывается ссылкой
    std::string name;
    std::optional<std::string> alt;
    std::optional<std::string> url;
    bool operator==(const MdBlock &) const = default;
};

/** Блоки текста. Первый заголовок, повторяющий название, пропускается: название стоит над текстом */
std::vector<MdBlock> parseMarkdown(const std::string &markdown, const std::string &title = "");
/** Строка → куски с начертаниями. Ссылка только http(s)/mailto/`#якорь`, иначе остаётся текстом */
std::vector<MdInline> parseInline(const std::string &text);
/** Текст строки без разметки */
std::string inlineText(const std::string &text);
/** Якорь заголовка как у GitHub: нижний регистр, без знаков препинания, пробел → `-` */
std::string slugOf(const std::string &text);
/** Все строки с разметкой по порядку обхода (сверка разбора web ↔ ядро) */
std::vector<std::string> collectTexts(const std::vector<MdBlock> &blocks);
/** Блоки в JSON вида web (`MdBlock` TS; поля без значения опущены) — для Android и сверки */
nlohmann::json toJson(const std::vector<MdBlock> &blocks);
nlohmann::json toJson(const std::vector<MdInline> &parts);
/** Имена встроенных файлов облака (без внешних адресов), по порядку и без повторов */
std::vector<std::string> embedNames(const std::string &markdown);
/** Последняя часть пути встроенного файла: под ней файл лежит в статье и в облаке получателя */
std::string embedBaseName(const std::string &name);
/** Адрес, который можно отдать системе: только http(s) и mailto (web SAFE_URL) */
bool isSafeUrl(const std::string &url);
/**
 * Ревью безопасности 21 окт 2026 (2.3): ссылку, подпись которой не совпадает с адресом, открывать только после
 * подтверждения с показом адреса (как скрытые ссылки в сообщениях tdesktop): `[https://bank.example](https://evil…)`.
 * Совпадение — без учёта регистра, схемы http(s)/mailto, `www.` и завершающей `/`. Пустая подпись — совпадает.
 */
bool linkNeedsConfirmation(const std::string &text, const std::string &url);
/** Переписать цели встроенных файлов (`![[старое]]` → `![[новое]]`); прочий текст не меняется */
std::string renameEmbeds(const std::string &markdown, const std::map<std::string, std::string> &rename);

} // namespace parvane::sections::markdown
