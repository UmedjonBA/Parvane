// Parvane fork: холст «Знаний» (spec 029, T063) — web NotesCanvas и его части (CanvasCard, CanvasEdgeView,
// CanvasSelectionBar, CanvasContextMenu, CanvasFilePicker, CanvasFileBody, CanvasLinkBody, notesCanvasLook).
// Экран «Знаний» (parvane_knowledge*) вставляет вид холста во вкладку; логика — ядро parvane::sections::notes
// (notes_canvas*.h, board_view.h).
#pragma once

#include "ui/rp_widget.h"

#include <string>

namespace Window {
class SessionController;
} // namespace Window

namespace Parvane::NotesUi {

// Вид холста `canvasId` (узел облака `.canvas`); `openNote(noteId)` — карточка-заметка открыта (экран «Знаний»
// покажет её рядом с холстом)
[[nodiscard]] object_ptr<Ui::RpWidget> CreateCanvasView(
	not_null<QWidget*> parent,
	not_null<Window::SessionController*> controller,
	const std::string &canvasId,
	Fn<void(std::string noteId)> openNote);

} // namespace Parvane::NotesUi
