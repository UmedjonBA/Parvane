// Parvane fork (spec 029, фаза 4): общий разбор Markdown заметок «Знаний» и статьи в чате (ARTICLE-1) — порт web
// `components/parvane/markdown/markdown.ts` (без отрисовки). Блоки: заголовки, абзацы, списки (с галочками и
// нумерованные, вложенные), цитаты, код, черта, таблицы, встроенные файлы `![[файл]]` / `![подпись](файл)`; в строке —
// жирный, курсив, зачёркнутый, код, ссылки http(s)/mailto, [[заметки]], #теги. У блоков и пунктов — номер строки
// исходного текста (с нуля): заметка по нему отмечает пункт выполненным.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace parvane::sections::markdown {

enum class MdInlineType { Text, Bold, Italic, Strike, Code, Tag, Note, Link };

struct MdInline {
    MdInlineType type = MdInlineType::Text;
    std::string text;
    // Только `Note`
    std::string target;
    // Только `Link`
    std::string url;
    bool operator==(const MdInline &) const = default;
};

struct MdListItem {
    std::string text;
    int depth = 0;
    std::optional<bool> isChecked;
    int line = 0;
    bool operator==(const MdListItem &) const = default;
};

enum class MdAlign { None, Left, Center, Right };

enum class MdBlockType { Heading, Paragraph, List, Quote, Code, Rule, Table, Embed };

// Блок — объединение видов web: заполнены только поля своего вида
struct MdBlock {
    MdBlockType type = MdBlockType::Paragraph;
    int line = 0;
    // Heading: 1…3
    int level = 0;
    // Heading, Paragraph, Quote, Code
    std::string text;
    // List
    bool isOrdered = false;
    std::vector<MdListItem> items;
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
/** Строка → куски с разметкой. Ссылка только http(s)/mailto, иначе остаётся текстом */
std::vector<MdInline> parseInline(const std::string &text);
/** Имена встроенных файлов облака (без внешних адресов), по порядку и без повторов */
std::vector<std::string> embedNames(const std::string &markdown);
/** Последняя часть пути встроенного файла: под ней файл лежит в статье и в облаке получателя */
std::string embedBaseName(const std::string &name);
/** Переписать цели встроенных файлов (`![[старое]]` → `![[новое]]`); прочий текст не меняется */
std::string renameEmbeds(const std::string &markdown, const std::map<std::string, std::string> &rename);

} // namespace parvane::sections::markdown
