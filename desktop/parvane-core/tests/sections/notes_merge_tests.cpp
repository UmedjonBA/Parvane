// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesMerge.test.ts`.
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/sections/notes_merge.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static std::string replaceFirst(std::string value, const std::string &from, const std::string &to) {
    const size_t at = value.find(from);
    if (at != std::string::npos) value.replace(at, from.size(), to);
    return value;
}

static std::string joinLines(const std::vector<std::string> &lines) {
    std::string out;
    for (size_t i = 0; i < lines.size(); ++i) {
        if (i) out.push_back('\n');
        out += lines[i];
    }
    return out;
}

static std::vector<std::string> makeLines(int count, const std::string &prefix) {
    std::vector<std::string> lines;
    for (int i = 0; i < count; ++i) lines.push_back(prefix + " " + std::to_string(i));
    return lines;
}

const std::string BASE = "# План\n- [ ] Блок питания\n- [ ] Забрать платы\n\nСвязано: [[Сервер X99]]\n";

struct Row {
    std::string name, base, mine, theirs, text;
    bool hasConflict = false;
};

static void run(const std::vector<Row> &rows) {
    for (const auto &row : rows) {
        check(mergeNotes(row.base, row.mine, row.theirs) == NotesMergeResult{row.text, row.hasConflict}, row.name);
    }
}

int main() {
    std::printf("=== parvane-core notes_merge tests ===\n");
    const auto R = [](const std::string &from, const std::string &to) { return replaceFirst(BASE, from, to); };

    std::printf("-- слияние заметки: без конфликта\n");
    run({
        {"никто не менял", BASE, BASE, BASE, BASE},
        {"менял только я", BASE, R("[ ] Блок", "[x] Блок"), BASE, R("[ ] Блок", "[x] Блок")},
        {"меняли только они", BASE, BASE, R("Забрать платы", "Забрать платы до пт"),
            R("Забрать платы", "Забрать платы до пт")},
        {"разные места", BASE, R("[ ] Блок", "[x] Блок"), R("Связано:", "См. также:"),
            "# План\n- [x] Блок питания\n- [ ] Забрать платы\n\nСм. также: [[Сервер X99]]\n"},
        {"я дописал в начало, они в конец", BASE, "Вступление\n" + BASE, BASE + "- [ ] Проверить GPU\n",
            "Вступление\n" + BASE + "- [ ] Проверить GPU\n"},
        {"я удалил строку, они дописали в конец", BASE, R("- [ ] Блок питания\n", ""), BASE + "Итог\n",
            "# План\n- [ ] Забрать платы\n\nСвязано: [[Сервер X99]]\nИтог\n"},
        {"одна и та же правка", BASE, R("[ ] Блок", "[x] Блок"), R("[ ] Блок", "[x] Блок"), R("[ ] Блок", "[x] Блок")},
        {"одинаковая вставка в одно место", "а\nб", "а\nновая\nб", "а\nновая\nб", "а\nновая\nб"},
        {"одинаковое удаление", "а\nб\nв", "а\nв", "а\nв", "а\nв"},
        {"вставки в разные места", "а\nб\nв", "а\nмоя\nб\nв", "а\nб\nих\nв", "а\nмоя\nб\nих\nв"},
        {"повторяющиеся строки", "- [ ] \n- [ ] \n- [ ] \nконец", "- [x] \n- [ ] \n- [ ] \nконец",
            "- [ ] \n- [ ] \n- [ ] \nконец\nещё", "- [x] \n- [ ] \n- [ ] \nконец\nещё"},
        {"пустая основа, пишу только я", "", "Мой текст\n", "", "Мой текст\n"},
        {"пустая основа, пишут только они", "", "", "Их текст", "Их текст"},
        {"пустая основа, написали одно и то же", "", "Текст\n", "Текст\n", "Текст\n"},
        {"я стёр всё, они не трогали", BASE, "", BASE, ""},
        {"они стёрли всё, я не трогал", BASE, BASE, "", ""},
    });

    std::printf("-- слияние заметки: конфликт\n");
    run({
        {"одна строка изменена по-разному", BASE, R("Забрать платы", "Забрать платы до пт"),
            R("Забрать платы", "Забрать платы завтра"), R("Забрать платы", "Забрать платы до пт"), true},
        {"соседние строки", "а\nб\nв", "А\nб\nв", "а\nБ\nв", "А\nб\nв", true},
        {"вставка в одно место с разным текстом", "а\nб", "а\nмоя\nб", "а\nих\nб", "а\nмоя\nб", true},
        {"я удалил, они правили", BASE, R("- [ ] Забрать платы\n", ""), R("Забрать платы", "Забрать платы до пт"),
            R("- [ ] Забрать платы\n", ""), true},
        {"я правил, они удалили", BASE, R("Забрать платы", "Забрать платы до пт"), R("- [ ] Забрать платы\n", ""),
            R("Забрать платы", "Забрать платы до пт"), true},
        {"пустая основа, написали разное", "", "Моя заметка\n", "Их заметка\n", "Моя заметка\n", true},
        {"правка рядом с общей вставкой", "а\nб\nв\nг\nд", "а\nновая\nб\nв\nг\nД", "А\nновая\nб\nв\nг\nд",
            "а\nновая\nб\nв\nг\nД", true},
        {"я стёр всё, они правили", BASE, "", R("[ ] Блок", "[x] Блок"), "", true},
    });

    std::printf("-- слияние заметки: переводы строк\n");
    run({
        {"CRLF у них, правки в разных местах", "а\nб\nв\n", "А\nб\nв\n", "а\r\nб\r\nВ\r\n", "А\nб\nВ\n"},
        {"CRLF у всех, менял только я", "а\r\nб\r\n", "а\r\nБ\r\n", "а\r\nб\r\n", "а\nБ\n"},
        {"разница только в CRLF — не правка", "а\nб", "а\r\nб", "а\nб", "а\nб"},
        {"у меня есть последний перевод строки, у них нет", "а\nб\nв", "А\nб\nв\n", "а\nб\nВ", "А\nб\nВ\n"},
        {"у меня нет последнего перевода строки, у них есть", "а\nб\nв\n", "А\nб\nв", "а\nб\nВ\n", "А\nб\nВ"},
        {"они только добавили последний перевод строки", "а\nб", "а\nб", "а\nб\n", "а\nб\n"},
        {"я только убрал последний перевод строки", "а\nб\n", "а\nб", "а\nб\n", "а\nб"},
        {"пустые строки в конце сохраняются", "а\n\n\n", "а\n\n\n", "А\n\n\n", "А\n\n\n"},
        {"конфликт: текст мой, переводы строк приведены", "а\r\n", "моя\r\n", "их\r\n", "моя\n", true},
    });

    std::printf("-- слияние заметки: большие тексты\n");
    {
        const auto base = makeLines(3000, "строка");
        auto mine = base;
        mine[5] = "моя правка";
        mine.insert(mine.begin() + 100, "моя вставка");
        auto theirs = base;
        theirs[2990] = "их правка";
        theirs.erase(theirs.begin() + 2500, theirs.begin() + 2502);
        auto expected = mine;
        expected[2991] = "их правка";
        expected.erase(expected.begin() + 2501, expected.begin() + 2503);
        check(mergeNotes(joinLines(base), joinLines(mine), joinLines(theirs))
                == NotesMergeResult{joinLines(expected), false},
            "несколько тысяч строк, правки в разных концах");
    }
    {
        const std::string base = joinLines(makeLines(2100, "основа"));
        const std::string mine = joinLines(makeLines(2100, "моя"));
        const std::string theirs = base + "\nих строка";
        check(mergeNotes(base, mine, theirs) == NotesMergeResult{mine, true}
                && mergeNotes(base, mine, mine) == NotesMergeResult{mine, false}
                && mergeNotes(base, base, theirs) == NotesMergeResult{theirs, false}
                && mergeNotes(base, mine, base) == NotesMergeResult{mine, false},
            "слишком большое сравнение — конфликт без построчного разбора");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
