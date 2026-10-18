// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesLinkEdit.test.ts`.
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/sections/notes_link_edit.h"
#include "parvane/sections/notes_model.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static std::string added(const std::string &text, const std::string &title) { return addLinkToText(text, title).text; }
static std::string removed(const std::string &text, const std::string &title) {
    return removeLinkFromText(text, title).text;
}

int main() {
    std::printf("=== parvane-core notes_link_edit tests ===\n");

    std::printf("-- связь на графе: ссылка дописывается в текст\n");
    check(addLinkToText("# Сервер\n\nТекст о сервере.\n", "Курс ОГЭ")
            == AddLinkResult{AddLinkStatus::Added, "# Сервер\n\nТекст о сервере.\n\n[[Курс ОГЭ]]\n"},
        "в конец заметки новой строкой после пустой");
    check(added("Текст", "Б") == "Текст\n\n[[Б]]", "заметка без перевода строки в конце кончается ссылкой");
    check(added("", "Б") == "[[Б]]\n" && added("\n\n", "Б") == "[[Б]]\n", "пустая заметка и заметка из пустых строк");
    check(added("Текст\n\n\n", "Б") == "Текст\n\n[[Б]]\n", "лишние пустые строки в конце не копятся");
    check(added("Текст\n\n[[А]]\n[[В]]\n", "Б") == "Текст\n\n[[А]]\n[[В]]\n[[Б]]\n"
            && added("Текст\n\n- [[А]]\n- [[В]]", "Б") == "Текст\n\n- [[А]]\n- [[В]]\n- [[Б]]"
            && added("[[А]], [[В]]\n", "Б") == "[[А]], [[В]]\n[[Б]]\n",
        "блок ссылок в конце заметки продолжается, пункт списка — пунктом");
    check(added("- [ ] [[А]]\n", "Б") == "- [ ] [[А]]\n\n[[Б]]\n", "пункт с галочкой блоком ссылок не считается");
    check(added("# Т\n\n## См. также\n\n- [[А]]\n\n## Дальше\n\nтекст\n", "Б")
                == "# Т\n\n## См. также\n\n- [[А]]\n- [[Б]]\n\n## Дальше\n\nтекст\n"
            && added("Текст\n\n## Links\n", "B") == "Текст\n\n## Links\n\n[[B]]\n"
            && added("Текст\n\n## Связи", "Б") == "Текст\n\n## Связи\n\n[[Б]]"
            && added("See also:\n[[A]]\n## Next\n", "B") == "See also:\n[[A]]\n[[B]]\n\n## Next\n"
            && added("**Ссылки**\nпояснение\n", "Б") == "**Ссылки**\nпояснение\n[[Б]]\n",
        "раздел «См. также» и его родня принимают ссылку, даже если стоят не в конце");
    check(added("```\n## Links\n```\n", "B") == "```\n## Links\n```\n\n[[B]]\n"
            && added("---\nLinks:\n---\nТекст\n", "B") == "---\nLinks:\n---\nТекст\n\n[[B]]\n",
        "заголовок раздела внутри кода и в свойствах не считается");
    {
        const std::string text = "Смотри [[Курс ОГЭ|курс]] и дальше\n";
        check(addLinkToText(text, " курс огэ ") == AddLinkResult{AddLinkStatus::Exists, text}
                && addLinkToText("[[Б]]\n", "Б").status == AddLinkStatus::Exists,
            "ссылка, которая уже есть, второй раз не пишется");
    }
    check(addLinkToText("`[[Б]]`\n", "Б") == AddLinkResult{AddLinkStatus::Added, "`[[Б]]`\n\n[[Б]]\n"},
        "ссылка в коде не считается существующей");
    {
        bool isOk = true;
        for (const std::string title : {"", "   ", "a]b", "a[b", "a|b", "a\nb"}) {
            isOk = isOk && !canLinkTitle(title)
                && addLinkToText("Текст\n", title) == AddLinkResult{AddLinkStatus::Refused, "Текст\n"};
        }
        check(isOk && canLinkTitle("Сервер X99: план (v2), «кавычки» #1"),
            "название, которое не записать в ссылку, — отказ");
    }
    check(parseNote(added("# А\n\nтекст\n", "Сервер X99: план (v2)")).links
            == std::vector<std::string>{"Сервер X99: план (v2)"},
        "дописанную ссылку видит разбор заметки");
    check(added("a\r\nb\r\n", "Б") == "a\r\nb\r\n\r\n[[Б]]\r\n", "переводы строк CRLF сохраняются");

    std::printf("-- связь на графе: ссылка убирается из текста\n");
    check(removeLinkFromText("# Сервер\n\nТекст.\n\n[[Курс ОГЭ]]\n", "курс огэ")
                == RemoveLinkResult{RemoveLinkStatus::Removed, "# Сервер\n\nТекст.\n", 0, 0}
            && removed("Текст\n\n[[Б]]", "Б") == "Текст" && removed("[[Б]]\n", "Б").empty(),
        "отдельная строка уходит вместе с пустой строкой перед ней");
    {
        bool isOk = true;
        for (const std::string text :
            {"", "Текст", "Текст\n", "# Т\n\n- [ ] дело\n", "Текст\n\n[[А]]\n", "## См. также\n\n- [[А]]\n\n## Дальше\n"}) {
            const auto result = addLinkToText(text, "Б");
            isOk = isOk && result.status == AddLinkStatus::Added
                && removeLinkFromText(result.text, "Б") == RemoveLinkResult{RemoveLinkStatus::Removed, text, 0, 0};
        }
        check(isOk, "добавление и удаление возвращают прежний текст");
    }
    check(removed("а\n[[Б]]\nв\n", "Б") == "а\nв\n" && removed("а\n\n[[Б]]\n\nв\n", "Б") == "а\n\nв\n"
            && removed("- [[А]]\n- [[Б|подпись]]\n- [[В]]\n", "Б") == "- [[А]]\n- [[В]]\n",
        "строка между другими строками уходит, соседние не склеиваются лишним");
    check(removed("[[А]], [[Б]], [[В]]\n", "Б") == "[[А]], [[В]]\n" && removed("- [[А]] [[Б]]\n", "Б") == "- [[А]]\n"
            && removed("[[Б]] · [[А]]\n", "Б") == "[[А]]\n" && removed("[[Б]] [[Б]]\n\nтекст\n", "Б") == "\nтекст\n",
        "из строки с несколькими ссылками уходит только одна");
    {
        const std::string text = "# Т\nСм. [[Курс ОГЭ]] перед экзаменом.\n";
        const auto result = removeLinkFromText(text, "Курс ОГЭ");
        check(result.status == RemoveLinkStatus::Inline && result.text == text
                && text.substr(result.from, result.to - result.from) == "[[Курс ОГЭ]]",
            "ссылка внутри предложения не трогается — возвращается её место");
    }
    check(removeLinkFromText("- [ ] прочитать [[Б]]\n", "Б").status == RemoveLinkStatus::Inline
            && removeLinkFromText("- [ ] [[Б]]\n", "Б").status == RemoveLinkStatus::Inline,
        "пункт с галочкой — тоже проза");
    {
        const std::string text = "Про [[Б]] тут.\r\n\r\n[[Б]]\r\n";
        const auto result = removeLinkFromText(text, "Б");
        check(result.status == RemoveLinkStatus::Inline && result.text == text
                && text.substr(result.from, result.to - result.from) == "[[Б]]",
            "есть и отдельная строка, и ссылка в прозе — текст не меняется вовсе");
    }
    check(removeLinkFromText("Текст [[А]]\n", "Б") == RemoveLinkResult{RemoveLinkStatus::None, "Текст [[А]]\n", 0, 0}
            && removeLinkFromText("```\n[[Б]]\n```\n", "Б").status == RemoveLinkStatus::None,
        "ссылки нет либо она только в коде — ничего не делается");

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
