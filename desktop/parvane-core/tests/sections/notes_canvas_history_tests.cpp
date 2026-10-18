// Parvane fork (spec 029, фаза 4): история правок холста — перенос 1:1 web `notes/notesCanvasHistory.test.ts`.
// `toBe` в web — тот же объект; здесь — тот же указатель.
#include <cstdio>
#include <string>

#include "parvane/sections/notes_canvas_history.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total; if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static CanvasDocPtr docOf(int count) {
    CanvasDoc doc;
    for (int i = 0; i < count; ++i) {
        CanvasNode n;
        n.id = "n" + std::to_string(i); n.type = "text"; n.x = i; n.y = 0; n.width = 100; n.height = 60;
        doc.nodes.push_back(n);
    }
    return std::make_shared<const CanvasDoc>(std::move(doc));
}

static bool sameHistory(const CanvasHistory &a, const CanvasHistory &b) {
    return a.past == b.past && a.future == b.future;
}

static bool equalDocs(const std::vector<CanvasDocPtr> &a, const std::vector<CanvasDocPtr> &b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (!(*a[i] == *b[i])) return false;
    }
    return true;
}

int main() {
    std::printf("=== parvane-core notes canvas history tests (без стека) ===\n");
    const auto a = docOf(1);
    const auto b = docOf(2);
    const auto c = docOf(3);

    {
        const auto history = createHistory();
        check(!undoStep(history, a) && !redoStep(history, a) && !dropStep(history),
              "пустая история ничего не отменяет и не возвращает");
    }
    {
        // a → b → c
        const auto history = recordStep(recordStep(createHistory(), a), b);
        const auto first = *undoStep(history, c);
        bool ok = first.doc == b;
        const auto second = *undoStep(first.history, first.doc);
        ok = ok && second.doc == a;
        ok = ok && !undoStep(second.history, second.doc);
        const auto forward = *redoStep(second.history, second.doc);
        ok = ok && forward.doc == b;
        const auto last = *redoStep(forward.history, forward.doc);
        ok = ok && last.doc == c;
        ok = ok && !redoStep(last.history, last.doc);
        ok = ok && sameHistory(last.history, history);
        check(ok, "отмена возвращает прежний документ, возврат — отменённый");
    }
    {
        const auto undone = *undoStep(recordStep(createHistory(), a), b);
        const auto next = recordStep(undone.history, undone.doc);
        check(next.future.empty() && !redoStep(next, c) && undoStep(next, c)->doc == a,
              "новая правка после отмены стирает «вернуть»");
    }
    {
        auto history = createHistory();
        for (std::size_t i = 0; i < kCanvasHistoryLimit + 5; ++i) history = recordStep(history, docOf(static_cast<int>(i)));
        bool ok = history.past.size() == kCanvasHistoryLimit && history.past[0]->nodes.size() == 5;
        ok = ok && recordStep(recordStep(createHistory(), a, 1), b, 1).past == std::vector<CanvasDocPtr>{b};
        check(ok, "шагов не больше предела: старые забываются");
    }
    {
        const auto history = recordStep(recordStep(createHistory(), a), b);
        const auto dropped = *dropStep(history);
        check(dropped.doc == b && dropped.history.past == std::vector<CanvasDocPtr>{a} && dropped.history.future.empty(),
              "забытый шаг не попадает в «вернуть»");
    }
    {
        // a → b → c, затем одна отмена: в прошлом a, в «вернуть» c
        const auto history = undoStep(recordStep(recordStep(createHistory(), a), b), c)->history;
        auto shift = [](const CanvasDocPtr &doc) {
            CanvasDoc next = *doc;
            for (auto &n : next.nodes) n.y = 10;
            return std::make_shared<const CanvasDoc>(std::move(next));
        };
        const auto mapped = mapHistory(history, shift);
        bool ok = equalDocs(mapped.past, {shift(a)}) && equalDocs(mapped.future, {shift(c)});
        ok = ok && undoStep(mapped, b)->doc->nodes[0].y == 10;
        check(ok, "поправка проходит по всем шагам, отмена возвращает уже поправленный документ");
    }
    {
        const auto history = recordStep(createHistory(), a);
        bool changed = true;
        const auto mapped = mapHistory(history, [](const CanvasDocPtr &doc) { return doc; }, &changed);
        check(!changed && sameHistory(mapped, history), "поправка, ничего не изменившая, оставляет прежнюю историю");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
