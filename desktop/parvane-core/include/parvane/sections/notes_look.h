// Parvane fork (spec 029, фаза 4): вид заметки в списках «Знаний» — порт web `components/parvane/notes/notesLook.ts`.
// Цвет по папке, буква плитки, начало текста для карточки и строка под названием. Даты для показа (`displayTitle`,
// `formatDayShort` — Intl.DateTimeFormat в web) не перенесены: их форматирует интерфейс средствами Qt по языку UI.
#pragma once

#include <optional>
#include <string>
#include <vector>

namespace parvane::sections::notes {

// Строка начала текста заметки: `mark` — чем была строка в разметке: todo | done | bullet | heading
struct NotePreviewLine {
    std::string text;
    std::optional<std::string> mark;
    bool operator==(const NotePreviewLine &) const = default;
};

struct NotePreview {
    std::vector<NotePreviewLine> lines;
    // Текст длиннее показанного
    bool hasMore = false;
    bool operator==(const NotePreview &) const = default;
};

/** Тон папки: один и тот же у папки на всех экранах; заметки дня и без папки — `note`. Иначе — blue | green |
 *  orange | purple | aqua | red (в web — CSS `var(--pv-<тон>)`). */
std::string folderTone(const std::string &folder, bool isDaily = false);
bool isDayTitle(const std::string &title);
/** Знак на плитке списка: первая буква названия прописной, у заметки дня — число месяца. */
std::string avatarText(const std::string &title, bool isDaily);
/** Начало текста заметки для карточки (заметка дня на «Сегодня»): первые `max` содержательных строк без блока
 *  свойств, заголовка с названием, блоков кода и пустых пунктов шаблона. */
NotePreview previewLines(const std::string &title, const std::string &text, int max);
/** Строка под названием в списке: первая содержательная строка текста, не повторяющая само название. */
std::string previewOf(const std::string &title, const std::string &text);

} // namespace parvane::sections::notes
