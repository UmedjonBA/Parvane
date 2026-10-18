// Parvane fork (spec 029, фаза 4): выравнивание на холсте — перенос 1:1 web `notes/notesCanvasAlign.test.ts`.
#include <cstdio>
#include <string>

#include "parvane/sections/notes_canvas_align.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total; if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static CanvasNode node(const std::string &id, double x, double y, double width = 100, double height = 60,
                       const std::string &type = "text") {
    CanvasNode n;
    n.id = id; n.type = type; n.x = x; n.y = y; n.width = width; n.height = height;
    return n;
}

static std::pair<double, double> place(const CanvasDoc &doc, const std::string &id) {
    const auto *n = findNode(doc, id);
    return {n->x, n->y};
}

static std::vector<double> xs(const CanvasDoc &doc) {
    return {place(doc, "a").first, place(doc, "b").first, place(doc, "c").first};
}
static std::vector<double> ys(const CanvasDoc &doc) {
    return {place(doc, "a").second, place(doc, "b").second, place(doc, "c").second};
}

static void moveSnap() {
    std::printf("--- прилипание к соседям при сдвиге\n");
    const CanvasRect neighbour{0, 0, 100, 60};
    {
        const auto snap = snapToNeighbours({4, 200, 80, 40}, {neighbour});
        check(snap.dx == -4 && snap.dy == 0 && snap.guides == std::vector<CanvasGuide>{{CanvasAxis::X, 0, 0, 240}},
              "левый край встаёт на левый край соседа, линия идёт через оба");
    }
    {
        // Середина по x: 50 у соседа, 47 у карточки; верх карточки в 3 точках от низа соседа
        const auto snap = snapToNeighbours({7, 63, 80, 40}, {neighbour});
        check(snap.dx == 3 && snap.dy == -3
                  && snap.guides == std::vector<CanvasGuide>{{CanvasAxis::X, 50, 0, 100}, {CanvasAxis::Y, 60, 0, 100}},
              "середина к середине и край к краю по обеим осям");
    }
    {
        const auto snap = snapToNeighbours({105, 300, 80, 40}, {neighbour, {103, 500, 50, 50}});
        check(snap.dx == -2 && snap.guides[0].axis == CanvasAxis::X && snap.guides[0].at == 103 && snap.guides[0].to == 550,
              "из нескольких совпадений берётся ближайшее");
    }
    check(snapToNeighbours({300, 300, 80, 40}, {neighbour}) == CanvasSnap{0, 0, {}}
              && snapToNeighbours(neighbour, {}) == CanvasSnap{0, 0, {}},
          "дальше допуска — ни сдвига, ни линий");
    {
        const auto snap = snapToNeighbours({0, 200, 100, 40}, {neighbour});
        std::vector<double> at;
        for (const auto &g : snap.guides) at.push_back(g.at);
        check(snap.dx == 0 && at == std::vector<double>{0, 50, 100}, "уже стоящий вровень узел не сдвигается, но линия показана");
    }
}

static void resizeSnap() {
    std::printf("--- прилипание при смене размера\n");
    const CanvasRect neighbour{300, 0, 100, 200};
    const CanvasRect rect{0, 0, 296, 197};
    {
        const auto result = snapResize(rect, CanvasHandle::SE, {neighbour});
        bool ok = result.rect == CanvasRect{0, 0, 300, 200};
        ok = ok && result.guides.size() == 2 && result.guides[0].axis == CanvasAxis::X && result.guides[0].at == 300
            && result.guides[1].axis == CanvasAxis::Y && result.guides[1].at == 200;
        ok = ok && snapResize(rect, CanvasHandle::E, {neighbour}).rect == CanvasRect{0, 0, 300, 197};
        // Ручка слева двигает левый край: он уже стоит вровень с ничем
        ok = ok && snapResize(rect, CanvasHandle::W, {neighbour}).rect == rect;
        check(ok, "прилипают только стороны, которые двигает ручка");
    }
    {
        const CanvasRect small{0, 0, 84, 60};
        check(snapResize(small, CanvasHandle::E, {{78, 300, 50, 50}}).rect == small,
              "прилипание не делает прямоугольник меньше наименьшего");
    }
}

static CanvasDoc sample() {
    CanvasDoc doc;
    doc.nodes = {node("a", 0, 0), node("b", 150, 100, 200, 100), node("c", 500, 40, 100, 20)};
    return doc;
}

static void alignAndDistribute() {
    std::printf("--- выравнивание и распределение\n");
    const std::vector<std::string> ids = {"a", "b", "c"};
    using V = std::vector<double>;
    check(xs(alignNodes(sample(), ids, CanvasAlign::Left)) == V{0, 0, 0}
              && xs(alignNodes(sample(), ids, CanvasAlign::Center)) == V{250, 200, 250}
              && xs(alignNodes(sample(), ids, CanvasAlign::Right)) == V{500, 400, 500},
          "по левому краю, по середине, по правому краю");
    check(ys(alignNodes(sample(), ids, CanvasAlign::Top)) == V{0, 0, 0}
              && ys(alignNodes(sample(), ids, CanvasAlign::Middle)) == V{70, 50, 90}
              && ys(alignNodes(sample(), ids, CanvasAlign::Bottom)) == V{140, 100, 180},
          "по верху, по середине, по низу");
    {
        CanvasDoc doc;
        doc.nodes = {node("g", 100, 0, 300, 200, "group"), node("in", 150, 50), node("out", 0, 300)};
        const auto next = alignNodes(doc, {"g", "in", "out"}, CanvasAlign::Left);
        check(place(next, "g") == std::pair{0.0, 0.0} && place(next, "in") == std::pair{50.0, 50.0}
                  && place(next, "out") == std::pair{0.0, 300.0},
              "группа едет с содержимым, узел внутри выделенной группы сам не выравнивается");
    }
    {
        const auto doc = sample();
        check(alignNodes(doc, {"a"}, CanvasAlign::Left) == doc && distributeNodes(doc, {"a", "b"}, CanvasAxis::X) == doc,
              "один предмет не выравнивается, два не распределяются");
    }
    {
        // Ширины 100, 200, 100 между 0 и 600: свободно 200, промежуток 100
        const auto next = distributeNodes(sample(), {"c", "a", "b"}, CanvasAxis::X);
        check(xs(next) == V{0, 200, 500} && ys(next) == V{0, 100, 40}, "равные промежутки по горизонтали: крайние стоят");
    }
    {
        CanvasDoc doc;
        doc.nodes = {node("a", 0, 0), node("b", 0, 70), node("c", 0, 300)};
        // Высоты по 60 между 0 и 360: свободно 180, промежуток 90
        check(ys(distributeNodes(doc, {"a", "b", "c"}, CanvasAxis::Y)) == V{0, 150, 300}, "равные промежутки по вертикали");
    }
}

int main() {
    std::printf("=== parvane-core notes canvas align tests (без стека) ===\n");
    moveSnap();
    resizeSnap();
    alignAndDistribute();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
