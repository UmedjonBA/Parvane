// Parvane fork (spec 029, фаза 4): тесты палитры — порт web `palette/paletteSearch.test.ts` и
// `palette/paletteKeys.test.ts`.
// не перенесено: блок «палитра: записи „Плана“» (recordDay, collectPlannerRecords из paletteRecords.ts) — это
// разворот повторов «Плана», его переносит модуль planner; здесь проверен только поиск по готовым записям.
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include "parvane/sections/palette_search.h"

using namespace parvane::sections::palette;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static PaletteItem item(PaletteGroup group, const std::string &title, std::optional<std::string> text = {}) {
    PaletteItem it;
    it.key = std::string(groupName(group)) + ":" + title;
    it.group = group;
    it.title = title;
    it.text = std::move(text);
    return it;
}

using Titles = std::vector<std::pair<std::string, std::vector<std::string>>>;

static Titles titles(const std::vector<PaletteItem> &items, const std::string &query, int limit = kPaletteGroupLimit) {
    Titles out;
    for (const auto &section : searchPalette(items, query, limit)) {
        std::vector<std::string> list;
        for (const auto &r : section.results) list.push_back(items[r.index].title);
        out.emplace_back(groupName(section.group), list);
    }
    return out;
}

static std::vector<std::string> flat(const std::vector<PaletteItem> &items, const std::string &query) {
    std::vector<std::string> out;
    for (const auto &section : searchPalette(items, query)) {
        for (const auto &r : section.results) out.push_back(items[r.index].title);
    }
    return out;
}

static size_t cpLen(const std::string &s) {
    size_t n = 0;
    for (const unsigned char c : s) n += (c & 0xC0) != 0x80;
    return n;
}

using V = std::vector<std::string>;
using G = PaletteGroup;

int main() {
    std::printf("=== parvane-core sections: palette ===\n");

    const std::vector<PaletteItem> ITEMS = {
        item(G::Command, "Календарь"),
        item(G::Command, "Здоровье"),
        item(G::Command, "Новая запись"),
        item(G::Chat, "Алёна Ёлкина"),
        item(G::Chat, "Семья"),
        item(G::Note, "Сервер X99", "Стоит в шкафу.\nЗаменить вентилятор до зимы"),
        item(G::Note, "Подсервер", "Запасной"),
        item(G::Note, "Ёлка и подарки", "Купить календарь на стену"),
        item(G::Record, "Созвон по серверу", "обсудить вентилятор"),
        item(G::Record, "Проверить работы"),
    };

    // палитра: сравнение строк
    {
        bool lengths = true;
        for (const char *value : {"Ёлка", "İstanbul", "Straße", "Заметка 😀 дня"}) {
            if (cpLen(normalizePaletteText(value)) != cpLen(value)) lengths = false;
        }
        check(normalizePaletteText("Ёлка И ЕЛЬ") == "елка и ель" && lengths,
            "регистр и «ё/е» не различаются, длина строки сохраняется");
    }
    const std::vector<std::pair<std::string, V>> rows = {
        {"елк", {"Алёна Ёлкина", "Ёлка и подарки"}},
        {"ЁЛК", {"Алёна Ёлкина", "Ёлка и подарки"}},
        {"алена", {"Алёна Ёлкина"}},
        {"СЕМЬЯ", {"Семья"}},
        {"x99", {"Сервер X99"}},
        {"нет такого", {}},
    };
    for (const auto &[query, found] : rows) check(flat(ITEMS, query) == found, "«" + query + "»");

    // палитра: заранее приведённые строки
    {
        std::vector<PaletteItem> prepared;
        for (const auto &it : ITEMS) prepared.push_back(withNormalized(it));
        const auto note = withNormalized(ITEMS[5]);
        check(flat(prepared, "сервер вентилятор") == flat(ITEMS, "сервер вентилятор")
                && note.normTitle == normalizePaletteText(note.title)
                && note.normText == normalizePaletteText(*note.text),
            "поиск по normTitle/normText даёт то же, что по исходным строкам");
    }
    {
        const std::vector<PaletteItem> notes = {item(G::Note, "Заметка", "про вентилятор 9"), item(G::Note, "В поле")};
        check(titles(notes, "в") == Titles{{"note", {"В поле"}}} && titles(notes, "ве") == Titles{{"note", {"Заметка"}}}
                && titles(notes, "9 вентилятор") == Titles{{"note", {"Заметка"}}},
            "по тексту запрос ищется с двух букв, по названию — с одной");
    }

    // палитра: порядок и группы
    {
        std::vector<PaletteItem> many;
        for (int i = 0; i < kPaletteGroupLimit + 4; ++i) many.push_back(item(G::Command, "Команда " + std::to_string(i)));
        check(titles(ITEMS, "   ") == Titles{{"command", {"Календарь", "Здоровье", "Новая запись"}}}
                && searchPalette(many, "")[0].results.size() == many.size(),
            "пустой запрос — только команды, все и в исходном порядке");
    }
    {
        std::vector<std::string> groups;
        for (const auto &s : searchPalette(ITEMS, "сервер")) groups.push_back(groupName(s.group));
        check(titles(ITEMS, "календарь") == Titles{{"command", {"Календарь"}}, {"note", {"Ёлка и подарки"}}}
                && groups == V{"note", "record"},
            "группы идут в постоянном порядке: команды, чаты, заметки, записи");
    }
    {
        const std::vector<PaletteItem> notes = {
            item(G::Note, "Подсервер"),
            item(G::Note, "Заметка", "про сервер"),
            item(G::Note, "Мой сервер"),
            item(G::Note, "Сервер X99"),
        };
        check(titles(notes, "сервер") == Titles{{"note", {"Сервер X99", "Мой сервер", "Подсервер", "Заметка"}}},
            "начало названия выше начала слова, начало слова выше середины слова, текст — ниже названия");
    }
    {
        const std::vector<PaletteItem> notes = {item(G::Note, "План Б"), item(G::Note, "План А"), item(G::Note, "План В")};
        check(titles(notes, "план") == Titles{{"note", {"План Б", "План А", "План В"}}},
            "при равном совпадении сохраняется порядок источника");
    }
    check(titles(ITEMS, "сервер вентилятор") == Titles{{"note", {"Сервер X99"}}, {"record", {"Созвон по серверу"}}}
            && titles(ITEMS, "сервер подарки").empty(),
        "каждое слово запроса должно найтись — в названии либо в тексте");
    {
        std::vector<PaletteItem> notes;
        for (int i = 0; i < 10; ++i) notes.push_back(item(G::Note, "Подзаметка " + std::to_string(i)));
        notes.push_back(item(G::Note, "Заметка главная"));
        const auto section = searchPalette(notes, "заметка")[0];
        std::vector<PaletteItem> commands;
        for (int i = 0; i < 10; ++i) commands.push_back(item(G::Command, "Команда " + std::to_string(i)));
        check(section.results.size() == static_cast<size_t>(kPaletteGroupLimit)
                && notes[section.results[0].index].title == "Заметка главная"
                && searchPalette(notes, "заметка", 2)[0].results.size() == 2
                && searchPalette(commands, "команда")[0].results.size() == static_cast<size_t>(kPaletteGroupLimit),
            "группа обрезается до предела, лучшие совпадения остаются");
    }

    // палитра: подсветка
    {
        const auto section = searchPalette({item(G::Chat, "Алёна Ёлкина")}, "але елк")[0];
        const auto merged = searchPalette({item(G::Note, "Сервер")}, "сер серв")[0];
        const std::vector<PalettePart> expectedParts = {{"Алё", true}, {"на ", false}, {"Ёлк", true}, {"ина", false}};
        check(section.results[0].ranges == std::vector<PaletteRange>{{0, 3}, {6, 9}}
                && splitByRanges("Алёна Ёлкина", section.results[0].ranges)
                    == expectedParts
                && merged.results[0].ranges == std::vector<PaletteRange>{{0, 4}},
            "участки совпадения — по исходной строке, соседние сливаются");
    }
    {
        const auto section = searchPalette({item(G::Note, "Подсервер и сервер")}, "сервер")[0];
        check(section.results[0].ranges == std::vector<PaletteRange>{{12, 18}},
            "в названии подсвечивается вхождение с начала слова, если оно есть");
    }
    {
        std::vector<PaletteItem> notes;
        for (const auto &it : ITEMS) {
            if (it.group == G::Note) notes.push_back(it);
        }
        const auto section = searchPalette(notes, "вентилятор")[0];
        const auto &r = section.results[0];
        std::string matched;
        if (r.snippet) {
            for (const auto &part : splitByRanges(r.snippet->text, r.snippet->ranges)) {
                if (part.isMatch) {
                    matched = part.text;
                    break;
                }
            }
        }
        check(r.ranges.empty() && r.snippet && r.snippet->text == "Заменить вентилятор до зимы"
                && matched == "вентилятор" && !searchPalette(ITEMS, "семья")[0].results[0].snippet,
            "совпадение в тексте даёт отрывок строки с подсветкой, совпадение в названии — нет");
    }
    {
        std::string text;
        for (int i = 0; i < 20; ++i) text += "начало ";
        text += "ключ ";
        for (int i = 0; i < 40; ++i) text += "конец ";
        const auto section = searchPalette({item(G::Note, "Заметка", text)}, "ключ")[0];
        const auto &snippet = *section.results[0].snippet;
        const std::string ell = "…";
        const auto parts = splitByRanges(snippet.text, {snippet.ranges[0]});
        std::string matched;
        for (const auto &p : parts) {
            if (p.isMatch) matched = p.text;
        }
        check(snippet.text.rfind(ell, 0) == 0 && snippet.text.size() >= ell.size()
                && snippet.text.compare(snippet.text.size() - ell.size(), ell.size(), ell) == 0
                && cpLen(snippet.text) < 100 && matched == "ключ",
            "длинная строка текста обрезается вокруг совпадения");
    }

    // палитра: стрелки
    check(movePaletteIndex(0, 1, 3) == 1 && movePaletteIndex(2, 1, 3) == 0 && movePaletteIndex(0, -1, 3) == 2
            && movePaletteIndex(5, 1, 0) == 0,
        "список замкнут в кольцо");

    // --- клавиши (paletteKeys.test.ts). DOM нет: цель события описана полями ---
    auto el = [](const std::string &tag, bool editable = false, bool inside = false) {
        PaletteKeyTarget t;
        t.isElement = true;
        t.tagName = tag;
        t.isContentEditable = editable;
        t.insideEditable = inside || editable;
        return t;
    };
    const PaletteKeyTarget body = el("BODY");
    const PaletteKeyTarget document{}; // не элемент
    check(isEditableTarget(el("INPUT")) && isEditableTarget(el("TEXTAREA")) && isEditableTarget(el("SELECT"))
            && isEditableTarget(el("SPAN", false, true))  // span внутри contenteditable="true"
            && isEditableTarget(el("B", false, true))     // b внутри role="textbox"
            && !isEditableTarget(el("SPAN"))              // span внутри contenteditable="false"
            && !isEditableTarget(el("BUTTON")) && !isEditableTarget(document),
        "поля ввода, списки и редактируемый текст — да; кнопка и документ — нет");

    auto key = [&](const std::string &k, const std::string &code = "", bool ctrl = false, bool meta = false,
                   bool alt = false, bool shift = false, bool composing = false,
                   std::optional<PaletteKeyTarget> target = {}) {
        PaletteKeyEvent e;
        e.key = k;
        e.code = code;
        e.ctrlKey = ctrl;
        e.metaKey = meta;
        e.altKey = alt;
        e.shiftKey = shift;
        e.isComposing = composing;
        e.target = target.value_or(body);
        return e;
    };
    check(isPaletteSlashKey(key("/")) && isPaletteSlashKey(key("/", "", false, false, false, true)),
        "«/» вне поля открывает палитру, в том числе с Shift");
    check(!isPaletteSlashKey(key("/", "", false, false, false, false, false, el("INPUT")))
            && !isPaletteSlashKey(key("/", "", false, false, false, false, false, el("P", false, true))),
        "в поле ввода и в редактируемом тексте «/» печатается");
    check(!isPaletteSlashKey(key("/", "", true)) && !isPaletteSlashKey(key("/", "", false, true))
            && !isPaletteSlashKey(key("/", "", false, false, true))
            && !isPaletteSlashKey(key("/", "", false, false, false, false, true)) && !isPaletteSlashKey(key(".")),
        "с Ctrl/Cmd/Alt, при наборе через IME и для других клавиш — нет");
    check(isPaletteHotkey(key("k", "KeyK", true)) && isPaletteHotkey(key("K", "KeyK", false, true))
            && isPaletteHotkey(key("л", "KeyK", true)),
        "Ctrl+K и Cmd+K, в том числе в русской раскладке по коду клавиши");
    check(!isPaletteHotkey(key("k", "KeyK")) && !isPaletteHotkey(key("K", "KeyK", true, false, false, true))
            && !isPaletteHotkey(key("k", "KeyK", true, false, true)) && !isPaletteHotkey(key("j", "KeyJ", true)),
        "без модификатора, с Shift или Alt и другие буквы — нет");

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
