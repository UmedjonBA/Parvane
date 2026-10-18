// Parvane fork (spec 029, фаза 4): история правок холста — порт web `notes/notesCanvasHistory.ts`.
#include "parvane/sections/notes_canvas_history.h"

namespace parvane::sections::notes {

CanvasHistory createHistory() { return {}; }

CanvasHistory recordStep(const CanvasHistory &history, CanvasDocPtr before, std::size_t limit) {
    CanvasHistory next;
    next.past = history.past;
    next.past.push_back(std::move(before));
    // `.slice(-limit)`; предел 0 в JS — `slice(-0)`, то есть весь список
    if (limit && next.past.size() > limit) {
        next.past.erase(next.past.begin(), next.past.end() - static_cast<std::ptrdiff_t>(limit));
    }
    return next;
}

std::optional<CanvasHistoryMove> undoStep(const CanvasHistory &history, CanvasDocPtr current) {
    if (history.past.empty()) return std::nullopt;
    CanvasHistoryMove move;
    move.doc = history.past.back();
    move.history.past.assign(history.past.begin(), history.past.end() - 1);
    move.history.future.push_back(std::move(current));
    move.history.future.insert(move.history.future.end(), history.future.begin(), history.future.end());
    return move;
}

std::optional<CanvasHistoryMove> redoStep(const CanvasHistory &history, CanvasDocPtr current) {
    if (history.future.empty()) return std::nullopt;
    CanvasHistoryMove move;
    move.doc = history.future.front();
    move.history.past = history.past;
    move.history.past.push_back(std::move(current));
    move.history.future.assign(history.future.begin() + 1, history.future.end());
    return move;
}

std::optional<CanvasHistoryMove> dropStep(const CanvasHistory &history) {
    if (history.past.empty()) return std::nullopt;
    CanvasHistoryMove move;
    move.doc = history.past.back();
    move.history.past.assign(history.past.begin(), history.past.end() - 1);
    move.history.future = history.future;
    return move;
}

CanvasHistory mapHistory(const CanvasHistory &history, const std::function<CanvasDocPtr(const CanvasDocPtr &)> &change,
                         bool *changed) {
    CanvasHistory next;
    bool isSame = true;
    for (const auto &doc : history.past) {
        next.past.push_back(change(doc));
        isSame = isSame && next.past.back() == doc;
    }
    for (const auto &doc : history.future) {
        next.future.push_back(change(doc));
        isSame = isSame && next.future.back() == doc;
    }
    if (changed) *changed = !isSame;
    return isSame ? history : next;
}

} // namespace parvane::sections::notes
