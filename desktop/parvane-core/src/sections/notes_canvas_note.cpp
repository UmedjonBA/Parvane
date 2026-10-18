// Parvane fork (spec 029, фаза 4): карточка заметки на холсте — порт web `notes/notesCanvasNote.ts`.
#include "parvane/sections/notes_canvas_note.h"

#include <set>

#include "notes_preview_text.h"
#include "parvane/sections/notes_canvas_edit.h"
#include "parvane/sections/notes_canvas_files.h"
#include "parvane/sections/notes_canvas_graph.h"

namespace parvane::sections::notes {

NoteCardAction noteCardAction(NoteCardState state, NoteCardPart part, bool isDaily) {
    if (state == NoteCardState::Loading) return NoteCardAction::None;
    if (state == NoteCardState::Missing) return part == NoteCardPart::Command ? NoteCardAction::Create : NoteCardAction::None;
    if (part != NoteCardPart::Title) return NoteCardAction::EditBody;
    return isDaily ? NoteCardAction::None : NoteCardAction::EditTitle;
}

std::optional<std::string> nextNoteTitle(const std::string &value, const std::string &current) {
    const auto next = text::trim(value);
    if (next.empty() || next == current) return std::nullopt;
    return next;
}

std::optional<CanvasInlineAction> inlineKeyAction(CanvasInlineKind kind, const CanvasInlineKey &e) {
    if (e.key == "Escape") return CanvasInlineAction::Cancel;
    if (e.key != "Enter" || e.isComposing) return std::nullopt;
    if (kind == CanvasInlineKind::Note) {
        return e.ctrlKey || e.metaKey ? std::optional(CanvasInlineAction::Save) : std::nullopt;
    }
    return e.shiftKey ? std::nullopt : std::optional(CanvasInlineAction::Save);
}

std::vector<std::string> notePreviewLines(const std::string &body, const std::string &title, int max) {
    const auto ownTitle = text::toLower(text::trim(title));
    std::vector<std::string> out;
    for (const auto &raw : text::split(body, '\n')) {
        if (static_cast<int>(out.size()) >= max) break;
        auto line = text::decode(raw);
        line = line.substr(preview::headingMark(line));
        line = preview::stripTaskMarker(line);
        if (const size_t mark = preview::listMark(line)) line = U"• " + line.substr(mark);
        const auto trimmed = text::encode(text::trimU(line));
        if (trimmed.empty() || text::toLower(trimmed) == ownTitle) continue;
        out.push_back(text::encode(line));
    }
    return out;
}

CanvasPoint droppedCardPlace(CanvasPoint point, CanvasSide side, double width, double height, double grid) {
    const auto normal = canvasSideNormal(side);
    return {snapTo(point.x - width / 2 + (normal.x * width) / 2, grid),
            snapTo(point.y - height / 2 + (normal.y * height) / 2, grid)};
}

CanvasDoc relinkNoteCards(const CanvasDoc &doc, const std::string &fromId, const std::string &fromTitle,
                          const std::string &toId, const std::string &toTitle) {
    const auto fromKey = text::toLower(text::trim(fromTitle));
    std::set<std::string> cards;
    for (const auto &node : doc.nodes) {
        if (node.type != "file") continue;
        const auto title = noteTitleOfPath(node.str("file")).value_or("");
        if (node.str(kGraphNoteField) == std::optional<std::string>(fromId) || text::toLower(text::trim(title)) == fromKey) {
            cards.insert(node.id);
        }
    }
    if (cards.empty()) return doc;
    auto renamed = renameCanvasNote(doc, fromTitle, toTitle);
    for (auto &node : renamed.nodes) {
        if (cards.count(node.id)) node.set(kGraphNoteField, toId);
    }
    return renamed;
}

} // namespace parvane::sections::notes
