// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesModel.test.ts`.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <memory>
#include <optional>
#include <regex>
#include <string>
#include <vector>

#include "parvane/sections/notes_model.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
// Имя проверки одной строкой: переводы строк видны как `\n`, как у JSON.stringify в именах web
static std::string escapeName(const std::string &name) {
    std::string out;
    for (char c : name) {
        if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out.push_back(c);
    }
    return out;
}
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", escapeName(name).c_str());
}

using Strings = std::vector<std::string>;

static PropertyValue S(const std::string &value) { return PropertyValue::text(value); }
static PropertyValue L(Strings values) { return PropertyValue::items(std::move(values)); }
static NoteProperties props(std::vector<std::pair<std::string, PropertyValue>> entries) {
    NoteProperties properties;
    for (auto &[key, value] : entries) properties.set(key, value);
    return properties;
}

static MakeId makeIds(Strings ids) {
    auto next = std::make_shared<size_t>(0);
    return [ids, next]() { return ids[std::min((*next)++, ids.size() - 1)]; };
}

static NoteTask task(int line, bool isDone, const std::string &text, std::optional<std::string> marker = {}) {
    return NoteTask{line, isDone, text, std::move(marker)};
}

static std::string repeat(const std::string &value, int times) {
    std::string out;
    for (int i = 0; i < times; ++i) out += value;
    return out;
}

static size_t codePoints(const std::string &value) {
    size_t count = 0;
    for (unsigned char c : value) count += (c & 0xC0) != 0x80;
    return count;
}

// Первые `count` кодовых точек (как `text.slice(0, 40)` web, не разрезая знак UTF-8)
static std::string head(const std::string &value, size_t count) {
    size_t seen = 0;
    for (size_t i = 0; i < value.size(); ++i) {
        if ((static_cast<unsigned char>(value[i]) & 0xC0) != 0x80 && seen++ == count) return value.substr(0, i);
    }
    return value;
}

static Strings ids(const std::vector<const IndexedNote *> &notes) {
    Strings out;
    for (const auto *note : notes) out.push_back(note->id);
    return out;
}

static void testLinks() {
    std::printf("-- заметки: ссылки\n");
    const std::vector<std::pair<std::string, Strings>> rows = {
        {"Шпаргалка — [[Python: основы]]", {"Python: основы"}},
        {"[[Курс ОГЭ|курс]] и [[Сервер X99]]", {"Курс ОГЭ", "Сервер X99"}},
        {"[[Parvane]] [[parvane]] [[ PARVANE |ещё раз]]", {"Parvane"}},
        {"Код `[[не ссылка]]`, дальше [[Ссылка]]", {"Ссылка"}},
        {"``код с ` и [[внутри]]`` [[снаружи]]", {"снаружи"}},
        {"```\n[[в блоке]]\n```\n[[после блока]]", {"после блока"}},
        {"~~~md\n[[в блоке]]\n```\n[[всё ещё в блоке]]\n~~~\n[[после]]", {"после"}},
        {"[[]] [[ |пусто]] [[Одна]", {}},
        {"- [ ] Ответить по серверу [[Сервер X99]] ^t7f3a", {"Сервер X99"}},
        {"Без ссылок", {}},
    };
    for (const auto &[text, links] : rows) check(parseNote(text).links == links, text);
}

static void testTags() {
    std::printf("-- заметки: теги\n");
    const std::vector<std::pair<std::string, Strings>> rows = {
        {"Собрать банк задач #огэ", {"огэ"}},
        {"#проект/parvane и #идея_1, #в-работе.", {"проект/parvane", "идея_1", "в-работе"}},
        {"# Заголовок\n## Второй\n#тег-в-начале", {"тег-в-начале"}},
        {"#Огэ #огэ #ОГЭ", {"Огэ"}},
        {"Сайт https://example.ru/page#раздел и C#шарп", {}},
        {"Задача №1 #1 и #2026, но #2026год", {"2026год"}},
        {"Код `#нетег` и\n```\n#тоже-нет\n```\n#да", {"да"}},
        {"[[Заметка #черновик]] #настоящий", {"настоящий"}},
        {"##не-тег и цвет #fff", {"fff"}},
        {"Тег в конце #курс/", {"курс"}},
    };
    for (const auto &[text, tags] : rows) check(parseNote(text).tags == tags, text);
}

static void testProperties() {
    std::printf("-- заметки: свойства\n");
    struct Row {
        std::string name;
        std::string text;
        NoteProperties properties;
        std::string body;
    };
    const std::vector<Row> rows = {
        {"ключ и значение", "---\nстатус: идёт\nurl: https://example.ru/a\n---\nТекст",
            props({{"статус", S("идёт")}, {"url", S("https://example.ru/a")}}), "Текст"},
        {"список в скобках", "---\nтеги: [огэ, \"a, b\", 'it''s']\nпусто: []\n---\n",
            props({{"теги", L({"огэ", "a, b", "it's"})}, {"пусто", L({})}}), ""},
        {"список строками", "---\nтеги:\n  - огэ\n  - \"python: основы\"\nстатус: пауза\n---\n# План",
            props({{"теги", L({"огэ", "python: основы"})}, {"статус", S("пауза")}}), "# План"},
        {"пустое значение и кавычки", "---\nавтор:\nназвание: \"Строка: с двоеточием\"\nвремя: 10:30\n---\nА",
            props({{"автор", S("")}, {"название", S("Строка: с двоеточием")}, {"время", S("10:30")}}), "А"},
        {"ссылка в свойстве — строка", "---\nсвязано: [[Сервер X99]]\n---\n", props({{"связано", S("[[Сервер X99]]")}}),
            ""},
        {"переводы строк CRLF", "---\r\nстатус: идёт\r\n---\r\nТекст\r\n", props({{"статус", S("идёт")}}),
            "Текст\r\n"},
        {"без свойств", "Просто текст\n---\nне свойства: да\n---", {}, "Просто текст\n---\nне свойства: да\n---"},
        {"блок без конца", "---\nстатус: идёт\nТекст дальше", {}, "---\nстатус: идёт\nТекст дальше"},
        {"неразобранная строка", "---\nстатус: идёт\nпросто строка\n---\nТекст", {},
            "---\nстатус: идёт\nпросто строка\n---\nТекст"},
        {"пункт без ключа", "---\n- огэ\n---\nТекст", {}, "---\n- огэ\n---\nТекст"},
        {"вложенные свойства", "---\nа:\n  б: 1\n---\nТекст", {}, "---\nа:\n  б: 1\n---\nТекст"},
        {"черта в начале текста", "---\n10:30 встреча\n---\nТекст", {}, "---\n10:30 встреча\n---\nТекст"},
    };
    for (const auto &row : rows) {
        const auto note = parseNote(row.text);
        check(note.properties == row.properties && note.body == row.body, row.name);
    }

    const auto note = parseNote("---\nстатус: идёт\nтеги: [#нетег]\n---\n# План\n- [ ] Позвонить [[Маме]] #семья");
    check(note.links == Strings{"Маме"} && note.tags == Strings{"семья"}
            && note.tasks == std::vector<NoteTask>{task(5, false, "Позвонить [[Маме]] #семья")},
        "ссылки, теги и пункты берутся из текста, номера строк — от начала файла");
}

static void testSerialize() {
    std::printf("-- заметки: запись свойств\n");
    struct Row {
        std::string name;
        NoteProperties properties;
        std::string body;
        std::optional<std::string> text;
    };
    const std::vector<Row> rows = {
        {"без свойств", {}, "# План\n- [ ] Пункт\n", std::string("# План\n- [ ] Пункт\n")},
        {"строки и список", props({{"статус", S("идёт")}, {"теги", L({"огэ", "курс"})}}), "Текст",
            std::string("---\nстатус: идёт\nтеги: [огэ, курс]\n---\nТекст")},
        {"пустой текст", props({{"статус", S("пауза")}}), "", std::string("---\nстатус: пауза\n---\n")},
        {"значения, которым нужны кавычки",
            props({{"пусто", S("")}, {"пробелы", S("  по краям ")}, {"скобка", S("[не список]")},
                {"ссылка", S("[[Сервер X99]]")}, {"решётка", S("#тег")}, {"кавычки", S("\"в кавычках\"")},
                {"апостроф", S("'так'")}, {"черта", S("- пункт")}, {"строки", S("первая\nвторая")},
                {"двоеточие", S("время: 10:30")}, {"путь", S("C:\\папка")}}),
            "Текст\n", std::nullopt},
        {"списки с трудными значениями",
            props({{"теги", L({"a, b", "c]", "", " пробел", "\"цитата\"", "ё-моё", "строка\nвторая"})},
                {"пустой", L({})}, {"один", L({"один"})}}),
            "\n\nТекст с пустыми строками в начале", std::nullopt},
        {"текст похож на свойства", props({{"статус", S("идёт")}}), "---\nне свойства\n---\n", std::nullopt},
    };
    for (const auto &row : rows) {
        const std::string serialized = serializeNote(row.properties, row.body);
        const auto note = parseNote(serialized);
        const bool isTextOk = !row.text || serialized == *row.text;
        check(isTextOk && note.properties == row.properties && note.body == row.body, row.name);
    }
}

static void testTasks() {
    std::printf("-- заметки: пункты\n");
    const std::vector<std::pair<std::string, std::vector<NoteTask>>> rows = {
        {"- [ ] Блок питания 1000 Вт", {task(0, false, "Блок питания 1000 Вт")}},
        {"- [x] Пересечения в дорожках\n- [X] Большая буква",
            {task(0, true, "Пересечения в дорожках"), task(1, true, "Большая буква")}},
        {"- [ ] сдать отчёт до пт ^t7f3a", {task(0, false, "сдать отчёт до пт", "t7f3a")}},
        {"# План\n- Список\n  - [ ] Вложенный ^tabc123  \n    * [x] Глубже\n\t+ [ ] С табом",
            {task(2, false, "Вложенный", "tabc123"), task(3, true, "Глубже"), task(4, false, "С табом")}},
        {"- [ ] ^t0000\n- [ ]\n- [ ] ", {task(0, false, "", "t0000"), task(1, false, ""), task(2, false, "")}},
        {"- [ ] не метка ^t12\n- [ ] в середине ^tabcd текста\n- [ ] чужая метка ^abcd",
            {task(0, false, "не метка ^t12"), task(1, false, "в середине ^tabcd текста"),
                task(2, false, "чужая метка ^abcd")}},
        {"-[ ] без пробела\n- [] пусто\n- [ ]слитно\n[ ] без черты\n- [y] не галочка", {}},
        {"```\n- [ ] в коде\n```\n- [ ] настоящий\r\n- [x] и этот ^tzz99\r",
            {task(3, false, "настоящий"), task(4, true, "и этот", "tzz99")}},
    };
    for (const auto &[text, tasks] : rows) check(parseNote(text).tasks == tasks, text);
}

static void testPreview() {
    std::printf("-- заметки: превью\n");
    const std::vector<std::pair<std::string, std::string>> rows = {
        {"", ""},
        {"\n\n# План\nТекст", "План"},
        {"#\n##\n\nФедеративное **self-hosted** супер-приложение на `Rust`.",
            "Федеративное self-hosted супер-приложение на Rust."},
        {"---\nстатус: идёт\n---\n\n- [ ] Забрать платы до пт ^t7f3a", "Забрать платы до пт"},
        {"> См. [[Parvane — календарь|календарь]] и [[Сервер X99]]", "См. календарь и Сервер X99"},
        {"---\n***\n1. Первый [пункт](https://example.ru) _важно_", "Первый пункт важно"},
        {"```js\nconst a = 1;\n```\nПосле кода", "После кода"},
        {"имя_с_подчёркиваниями и 2*3*4", "имя_с_подчёркиваниями и 2*3*4"},
        {repeat("слово ", 40), repeat("слово ", 23) + "с…"},
    };
    for (const auto &[text, preview] : rows) {
        const std::string result = parseNote(text).preview;
        check(result == preview && codePoints(result) <= 140, "превью: " + head(text, 40));
    }
}

static void testCheckbox() {
    std::printf("-- заметки: галочка\n");
    const std::string TEXT = "# План\n- [ ] Первый ^taaaa\n  - [x] Второй\r\n- [X] Третий\nТекст";
    struct Row {
        std::string name;
        int line;
        bool isDone;
        std::string expected;
    };
    const std::vector<Row> rows = {
        {"поставить", 1, true, "# План\n- [x] Первый ^taaaa\n  - [x] Второй\r\n- [X] Третий\nТекст"},
        {"снять у вложенного", 2, false, "# План\n- [ ] Первый ^taaaa\n  - [ ] Второй\r\n- [X] Третий\nТекст"},
        {"снять большую букву", 3, false, "# План\n- [ ] Первый ^taaaa\n  - [x] Второй\r\n- [ ] Третий\nТекст"},
        {"уже стоит", 2, true, TEXT},
        {"строка не пункт", 0, true, TEXT},
        {"строки нет", 9, true, TEXT},
        {"отрицательный номер", -1, true, TEXT},
    };
    for (const auto &row : rows) check(setTaskDone(TEXT, row.line, row.isDone) == row.expected, row.name);
}

static void testMarkers() {
    std::printf("-- заметки: метки пунктов\n");
    const std::string TEXT = "# План\n- [ ] сдать отчёт до пт\n- [x] забрать платы ^t7f3a  \n- [ ] позвонить\r\nТекст";

    check(ensureTaskMarker(TEXT, 1, makeIds({"abcd"}))
            == EnsureMarkerResult{
                "# План\n- [ ] сдать отчёт до пт ^tabcd\n- [x] забрать платы ^t7f3a  \n- [ ] позвонить\r\nТекст",
                "tabcd"},
        "ставит метку пункту без метки");

    check(ensureTaskMarker(TEXT, 3, makeIds({"abcd"})).text.find("- [ ] позвонить ^tabcd\r\nТекст")
            != std::string::npos,
        "сохраняет перевод строки CRLF");

    check(ensureTaskMarker(TEXT, 2, makeIds({"abcd"})) == EnsureMarkerResult{TEXT, "t7f3a"}
            && ensureTaskMarker(TEXT, 0, makeIds({"abcd"})) == EnsureMarkerResult{TEXT, std::nullopt}
            && ensureTaskMarker(TEXT, 40, makeIds({"abcd"})) == EnsureMarkerResult{TEXT, std::nullopt},
        "не трогает пункт с меткой и строку без пункта");

    {
        const auto first = ensureTaskMarker(TEXT, 1, makeIds({"7f3a", "7f3a", "bbbb"})).marker;
        const auto stuck = ensureTaskMarker(TEXT, 1, [] { return std::string("7f3a"); }).marker.value_or("");
        check(first == std::optional<std::string>("tbbbb") && stuck != "t7f3a"
                && std::regex_match(stuck, std::regex("^t[a-z0-9]{4,12}$")),
            "не повторяет метку, уже занятую в заметке");
    }

    {
        const auto result = ensureTaskMarker("- [ ] пункт", 0, makeRandomMarkerId);
        const std::string marker = result.marker.value_or("");
        check(std::regex_match(marker, std::regex("^t[a-z0-9]{5}$"))
                && parseNote(result.text).tasks == std::vector<NoteTask>{task(0, false, "пункт", marker)}
                && findTaskLine(result.text, marker) == std::optional<int>(0),
            "метка по умолчанию читается обратно");
    }

    const std::vector<std::pair<std::string, std::optional<int>>> findRows = {
        {"t7f3a", 2}, {"^t7f3a", 2}, {"tzzzz", std::nullopt}, {"", std::nullopt},
    };
    for (const auto &[marker, line] : findRows) {
        check(findTaskLine(TEXT, marker) == line, "строка метки «" + marker + "»");
    }

    check(!findTaskLine("```\n- [ ] в коде ^tcode1\n```\nтекст ^tcode1", "tcode1"),
        "не ищет метку в коде и в обычном тексте");

    check(removeTaskLine(TEXT, "t7f3a") == "# План\n- [ ] сдать отчёт до пт\n- [ ] позвонить\r\nТекст"
            && removeTaskLine("- [ ] один ^tlast1", "tlast1").empty()
            && removeTaskLine("Текст\n- [ ] в конце ^tlast1", "tlast1") == "Текст"
            && removeTaskLine(TEXT, "tzzzz") == TEXT,
        "удаляет строку пункта");

    {
        const std::string copied =
            "- [ ] отчёт ^t7f3a\n- [ ] другой ^tbbbb\n  - [x] отчёт (копия) ^t7f3a\r\n- [ ] отчёт ^t7f3a";
        const DedupeMarkersResult expected{
            "- [ ] отчёт ^t7f3a\n- [ ] другой ^tbbbb\n  - [x] отчёт (копия) ^tcccc\r\n- [ ] отчёт ^tdddd",
            {{2, "t7f3a", "tcccc"}, {3, "t7f3a", "tdddd"}}};
        check(dedupeTaskMarkers(copied, makeIds({"bbbb", "cccc", "dddd"})) == expected,
            "копия пункта получает новую метку, первая строка сохраняет прежнюю");
    }

    check(dedupeTaskMarkers(TEXT, makeRandomMarkerId) == DedupeMarkersResult{TEXT, {}}, "без повторов текст прежний");
}

static void testIndex() {
    std::printf("-- заметки: индекс\n");
    const std::vector<NoteSource> NOTES = {
        {"oge", "Курс ОГЭ", "Проекты",
            "---\nстатус: идёт\n---\n# План\n- Шпаргалка — [[python: основы]]\n- [ ] Собрать банк задач #огэ #Курс\n"
            "См. [[Банк задач]] и [[курс огэ]]",
            30},
        {"py", "Python: основы", "Курсы", "Переменные, циклы, списки. Ещё раз про ёлку и счёт.\n#курс", 10},
        {"py8", "Python, 8 класс", "Курсы",
            "Курс «Python новичкам».\n- Опора: [[Python: основы|основы]] и [[Python: основы]]\n- [[банк задач]] #огэ",
            20},
        {"x99", "Сервер X99", "", "Бюджетный сервер. `[[Курс ОГЭ]]` #железо", 40},
        {"py-copy", " python: ОСНОВЫ ", "Архив", "Одноимённая копия", 50},
    };
    const NotesIndex index(NOTES);

    const std::vector<std::pair<std::string, std::optional<std::string>>> titleRows = {
        {"Курс ОГЭ", "oge"}, {"  курс огэ ", "oge"}, {"PYTHON: ОСНОВЫ", "py"}, {"Нет такой", std::nullopt},
        {"", std::nullopt},
    };
    for (const auto &[title, id] : titleRows) {
        const auto *found = index.byTitle(title);
        check((found ? std::optional<std::string>(found->id) : std::nullopt) == id, "по названию «" + title + "»");
    }

    {
        Strings all;
        for (const auto &note : index.notes()) all.push_back(note.id);
        check(index.byId("x99") && index.byId("x99")->title == "Сервер X99" && !index.byId("нет")
                && all == Strings{"oge", "py", "py8", "x99", "py-copy"},
            "по идентификатору");
    }

    {
        const auto *oge = index.byId("oge");
        const auto *py8 = index.byId("py8");
        const auto *x99 = index.byId("x99");
        const std::vector<UnresolvedTitle> missing{{"Банк задач", {"oge", "py8"}}};
        check(oge->linkedIds == Strings{"py"} && oge->unresolved == Strings{"Банк задач"}
                && py8->linkedIds == Strings{"py"} && py8->unresolved == Strings{"банк задач"}
                && x99->linkedIds.empty() && x99->unresolved.empty() && index.unresolved() == missing,
            "исходящие ссылки и заметки, которых ещё нет");
    }

    const std::vector<std::pair<std::string, Strings>> backlinkRows = {
        {"py", {"oge", "py8"}}, {"oge", {}}, {"py-copy", {}}, {"нет", {}},
    };
    for (const auto &[id, from] : backlinkRows) check(ids(index.backlinks(id)) == from, "обратные ссылки «" + id + "»");

    check(index.tags() == std::vector<TagCount>{{"курс", 2}, {"огэ", 2}, {"железо", 1}}, "теги со счётчиками");

    const std::vector<std::pair<std::string, Strings>> searchRows = {
        {"python", {"py-copy", "py8", "py", "oge"}},
        {"PYTHON основы", {"py-copy", "py", "oge", "py8"}},
        {"елку", {"py"}},
        {"ещё СЧЕТ", {"py"}},
        {"счёт", {"py"}},
        {"сервер", {"x99"}},
        {"курс 8", {"py8"}},
        {"идёт", {"oge"}},
        {"нет-такого-слова", {}},
        {"python сервер", {}},
        {"   ", {"py-copy", "x99", "oge", "py8", "py"}},
    };
    for (const auto &[query, found] : searchRows) check(ids(index.search(query)) == found, "поиск «" + query + "»");

    const NotesIndex empty({});
    check(empty.notes().empty() && empty.search("а").empty() && empty.backlinks("а").empty() && empty.tags().empty(),
        "пустой набор");
}

static void testRename() {
    std::printf("-- заметки: переименование ссылок\n");
    struct Row {
        std::string text, oldTitle, newTitle, expected;
    };
    const std::vector<Row> rows = {
        {"См. [[Курс ОГЭ]]", "Курс ОГЭ", "ОГЭ 2027", "См. [[ОГЭ 2027]]"},
        {"[[курс огэ|курс]] и [[ КУРС ОГЭ ]]", " Курс ОГЭ", "ОГЭ 2027", "[[ОГЭ 2027|курс]] и [[ОГЭ 2027]]"},
        {"[[Курс ОГЭ|]] [[Курс]] [[Курс ОГЭ 2]]", "Курс ОГЭ", "ОГЭ", "[[ОГЭ|]] [[Курс]] [[Курс ОГЭ 2]]"},
        {"`[[Курс ОГЭ]]` и [[Курс ОГЭ]]", "Курс ОГЭ", "ОГЭ", "`[[Курс ОГЭ]]` и [[ОГЭ]]"},
        {"```\n[[Курс ОГЭ]]\n```\n[[Курс ОГЭ]]\r\nТекст", "курс огэ", "ОГЭ", "```\n[[Курс ОГЭ]]\n```\n[[ОГЭ]]\r\nТекст"},
        {"[[parvane]]", "Parvane", "Parvane", "[[Parvane]]"},
        {"Без ссылок на [[Другое]]", "Курс ОГЭ", "ОГЭ", "Без ссылок на [[Другое]]"},
    };
    for (const auto &row : rows) check(renameLinks(row.text, row.oldTitle, row.newTitle) == row.expected, row.text);
}

static void testDaily() {
    std::printf("-- заметки: название и заметка дня\n");
    check(normalizeNoteTitle("  Курс ОГЭ ") == "курс огэ", "ключ названия");
    const auto note = parseNote(dailyNoteTemplate("2026-10-12"));
    check(dailyNoteTitle("2026-10-12") == "2026-10-12" && note.properties.empty()
            && note.body.rfind("# 2026-10-12\n", 0) == 0
            && note.tasks == std::vector<NoteTask>{task(2, false, "")} && note.preview == "2026-10-12",
        "заметка дня");
}

static void testCache() {
    std::printf("-- заметки: кэш разбора по объекту заметки\n");
    // не перенесено: `parseNoteCached` держит разбор по тождеству объекта JS (WeakMap) — в C++ тождества объекта нет,
    // проверяется только содержимое разбора
    check(parseNote("# А\n\n[[Б]] #тег\n").links == Strings{"Б"} && parseNote("# А\n\n[[Б]] #тег\n").tags == Strings{"тег"}
            && parseNote("# А\n\n[[В]]\n").links == Strings{"В"},
        "тот же объект с тем же текстом — тот же разбор; новый текст — новый (только содержимое)");

    const std::string text = "Ёлка İstanbul";
    const std::string value = noteSearchText(text);
    const NotesIndex index({{"a", "А", "", text, 1}});
    check(codePoints(value) == codePoints(text) && value.rfind("елка ", 0) == 0
            && ids(index.search("ёЛКА")) == Strings{"a"},
        "строка поиска: без регистра, «ё» = «е», длина сохранена");
}

int main() {
    std::printf("=== parvane-core notes_model tests ===\n");
    testLinks();
    testTags();
    testProperties();
    testSerialize();
    testTasks();
    testPreview();
    testCheckbox();
    testMarkers();
    testIndex();
    testRename();
    testDaily();
    testCache();
    {
        // A0077-1: враждебная строка (незакрытые серии кавычек и '[') разбирается за ограниченное время
        std::string hostile;
        for (int i = 0; i < 40000; ++i) hostile += "a``[";
        const auto t0 = std::chrono::steady_clock::now();
        (void)parseNote("# T\n" + hostile + "\n");
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
        check(ms < 3000, "длинная строка с кавычками и скобками разбирается не квадратично");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
