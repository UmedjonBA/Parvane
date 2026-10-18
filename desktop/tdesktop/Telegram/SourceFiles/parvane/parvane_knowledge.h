// Parvane fork: раздел «Знания» на desktop (spec 029, T063) — порт web `notes/Knowledge.tsx`, `KnowledgeTabs.tsx`,
// `PvHeaderSearch.tsx`, `PvResizer.tsx`: шапка с вкладками «Заметки / Граф / Холст / Файлы» и поиском по текущей
// вкладке, список заметок с папками и заметка, остров «Связи» справа на широком экране, граф связей с панелью
// выбранной точки, холст (вид — parvane_notes_canvas.h) с заметкой рядом, шторки папок и вопросы.
// Экран регистрируется в месте разделов: Parvane::RegisterKnowledge() (parvane_sections_host.h).
#pragma once

#include <QtCore/QString>

#include <string>

namespace Parvane {

// Открыть «Знания» на заметке с этим названием (нет такой — раздел создаст): web `openNote`
void OpenKnowledgeNote(const QString &title);
// Открыть «Знания» на заметке по её id (узел облака) — для палитры Ctrl+K; заметки нет — раздел без выбора
void OpenKnowledgeNoteById(const std::string &noteId);

} // namespace Parvane
