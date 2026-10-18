// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesLook.test.ts` и `notes/notesPrefs.test.ts`
// (настройки — на разборе строк вместо подменённого localStorage), плюс проверки перенесённых без тестов web
// функций вида (`folderTone`, `avatarText`, `previewOf`).
#include "notes_test_util.h"
#include "parvane/sections/notes_look.h"
#include "parvane/sections/notes_model.h"
#include "parvane/sections/notes_prefs.h"

using namespace parvane::sections::notes;

static const std::string DAY = "2026-10-13";

static std::string joinLines(const std::vector<std::string> &lines) {
    std::string out;
    for (size_t i = 0; i < lines.size(); ++i) out += (i ? "\n" : "") + lines[i];
    return out;
}

static NotePreviewLine line(const std::string &text, const std::optional<std::string> &mark = std::nullopt) {
    return {text, mark};
}

static void testLook() {
    std::printf("заметки: начало текста для карточки\n");
    check(previewLines(DAY, dailyNoteTemplate(DAY), 4) == NotePreview{} && previewLines(DAY, "", 4) == NotePreview{},
          "шаблон заметки дня — пусто: заголовок с датой и пустой пункт не показываются");
    {
        const auto text = joinLines({"# " + DAY, "", "Выспался, **бодро**.", "", "- [ ] позвонить в банк до пт ^tab12c",
                                     "- [x] зарядка", "* купить `кофе`", "## Итоги", "Всё по плану"});
        const NotePreview want{{line("Выспался, бодро."), line("позвонить в банк до пт", "todo"), line("зарядка", "done"),
                                line("купить кофе", "bullet"), line("Итоги", "heading"), line("Всё по плану")},
                               false};
        check(previewLines(DAY, text, 10) == want, "строки идут по порядку: текст, пункты с галочками, списки, заголовки");
    }
    check(previewLines(DAY, "Созвон по [[Сервер X99|серверу]] и [[Курс ОГЭ]]", 4).lines
              == std::vector<NotePreviewLine>{line("Созвон по серверу и Курс ОГЭ")},
          "ссылка показывается подписью либо названием заметки");
    {
        const auto text = joinLines({"один", "два", "три", "четыре"});
        check(previewLines(DAY, text, 3) == NotePreview{{line("один"), line("два"), line("три")}, true},
              "лишние строки отрезаются, о продолжении сообщается");
        check(!previewLines(DAY, text, 4).hasMore, "всё поместилось — продолжения нет");
    }
    {
        const auto text = joinLines({"---", "настроение: 4", "---", "# " + DAY, "", "```", "let a = 1", "```", "", "- [ ] ", "Мысль"});
        check(previewLines(DAY, text, 4).lines == std::vector<NotePreviewLine>{line("Мысль")},
              "блок свойств, код и пустые строки в начало текста не входят");
    }
    {
        std::string ya;
        for (int i = 0; i < 500; ++i) ya += "я";
        const auto lines = previewLines(DAY, ya, 4).lines;
        check(lines.size() == 1 && lines[0].text.size() == 280, "длинная строка обрезается до 140 знаков");
    }

    std::printf("заметки: вид в списке (сверх web)\n");
    check(folderTone("", false) == "note" && folderTone("Работа", true) == "note", "заметки дня и без папки — тон заметок");
    check(folderTone("Работа/Сервер") == folderTone("Работа"), "тон — по папке верхнего уровня");
    check(folderTone("Работа") == "blue", "тон папки — хеш названия, как в web (35646 % 6 = 0)");
    check(isDayTitle("2026-10-13") && !isDayTitle("2026-1-13"), "название-дата");
    check(avatarText("2026-10-03", true) == "3" && avatarText("  сервер", false) == "С" && avatarText("", false).empty(),
          "знак плитки: число дня либо первая буква прописной");
    check(previewOf("Сервер", "# Сервер\n\n- [ ] купить [[Блок питания|БП]] ^tab12c\n") == "купить Блок питания",
          "строка под названием: пропуск названия, ссылка — названием заметки");
    check(previewOf("A", "# A\n").empty(), "строка под названием: текста нет — пусто");
}

static void testPrefs() {
    std::printf("настройки «Знаний»: картинки на холсте\n");
    check(parseCanvasImageQuality(std::nullopt) == CanvasImageQuality::Full, "по умолчанию картинки в полном качестве");
    check(parseCanvasImageQuality(canvasImageQualityValue(CanvasImageQuality::Thumb)) == CanvasImageQuality::Thumb
              && parseCanvasImageQuality(canvasImageQualityValue(CanvasImageQuality::Full)) == CanvasImageQuality::Full,
          "выбор «миниатюрами» запоминается на устройстве и снимается обратно");
    check(parseCanvasImageQuality(std::string("tiny")) == CanvasImageQuality::Full,
          "незнакомое значение и недоступное хранилище — полное качество");
    std::printf("настройки «Знаний»: папки (сверх web)\n");
    check(parseCollapsedFolders(std::string("[\"a\",5,\"b\"]")) == std::vector<std::string>{"a", "b"}
              && parseCollapsedFolders(std::string("{")).empty() && parseCollapsedFolders(std::nullopt).empty(),
          "свёрнутые папки: строки из массива, негодное — пусто");
    std::vector<std::string> many(250, "x");
    check(parseCollapsedFolders(serializeCollapsedFolders(many)).size() == kCollapsedFoldersMax, "свёрнутых — не больше 200");
    check(!parseGraphFolders(std::nullopt) && !parseGraphFolders(std::string("5"))
              && parseGraphFolders(std::string("[\"\",\"Работа\"]")) == std::optional<std::vector<std::string>>({"", "Работа"}),
          "папки графа: нет — все папки");
    check(!serializeGraphFolders(std::nullopt) && serializeGraphFolders(std::vector<std::string>{"Дом"}) == std::optional<std::string>("[\"Дом\"]"),
          "папки графа: запись");
    check(guideSeenKey(std::string("42")) == "parvane:knowledge-guide-seen:42" && guideSeenKey(std::nullopt) == "parvane:knowledge-guide-seen:"
              && isGuideSeenValue(std::string("1")) && !isGuideSeenValue(std::nullopt),
          "отметка справки — по пользователю");
}

int main() {
    testLook();
    testPrefs();
    return finish();
}
