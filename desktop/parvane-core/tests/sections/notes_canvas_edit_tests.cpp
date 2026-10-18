// Parvane fork (spec 029, фаза 4): правки холста «Знаний» — перенос 1:1 web `notes/notesCanvasEdit.test.ts`
// (+ проверки `findFreeSpot`, у которого в web своих тестов нет). Без стека.
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>

#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_canvas_edit.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total; if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

using Ids = std::vector<std::string>;

static CanvasNode node(const std::string &id, double x, double y, double width = 100, double height = 60,
                       const std::string &type = "text") {
    CanvasNode n;
    n.id = id; n.type = type; n.x = x; n.y = y; n.width = width; n.height = height;
    return n;
}

static CanvasEdge edge(const std::string &id, const std::string &from, const std::string &to,
                       CanvasJson fields = CanvasJson::object()) {
    CanvasEdge e;
    e.id = id; e.fromNode = from; e.toNode = to; e.fields = std::move(fields);
    return e;
}

// Группа `g` (0,0 400×300) с карточками `a` и `b` внутри, карточка `c` снаружи; стрелки a→b и b→c
static CanvasDoc sample() {
    CanvasDoc doc;
    doc.nodes = {node("g", 0, 0, 400, 300, "group"), node("a", 20, 20), node("b", 200, 100), node("c", 600, 100)};
    doc.edges = {edge("ab", "a", "b"), edge("bc", "b", "c", {{"label", "дальше"}})};
    return doc;
}

static CanvasRect rectOf(const CanvasDoc &doc, const std::string &id) {
    return findNode(doc, id)->rect();
}

// Узел после того, как его ручку протащили на (dx, dy), — так размер меняет редактор
static CanvasDoc resizeNode(const CanvasDoc &doc, const std::string &id, CanvasHandle handle, double dx, double dy) {
    const auto *target = findNode(doc, id);
    return placeNode(doc, id, resizeRect(target->rect(), handle, dx, dy, minSizeOf(target->type)));
}

static CanvasMakeId counter(const std::string &prefix = "n") {
    auto count = std::make_shared<int>(0);
    return [prefix, count] { return prefix + std::to_string(++*count); };
}

static Ids idsOf(const std::vector<CanvasNode> &nodes) {
    Ids ids;
    for (const auto &n : nodes) ids.push_back(n.id);
    return ids;
}
static Ids idsOf(const std::vector<CanvasEdge> &edges) {
    Ids ids;
    for (const auto &e : edges) ids.push_back(e.id);
    return ids;
}

static CanvasKey key(const std::string &code, bool ctrl = false, bool meta = false, bool shift = false,
                     bool alt = false) {
    CanvasKey k;
    k.key = code; k.code = code; k.ctrlKey = ctrl; k.metaKey = meta; k.shiftKey = shift; k.altKey = alt;
    return k;
}

static void grid() {
    std::printf("--- сетка\n");
    check(snapTo(14) == 10 && snapTo(15) == 20 && snapTo(-14) == -10 && snapTo(14.4, 1) == 14 && snapTo(33, 22) == 44,
          "значение встаёт на ближайшую линию; сетка 1 — целое");
    check(snapDelta({13, 27}, 4, 4) == CanvasDelta{7, 3} && snapDelta({10, 20}, 26, -4) == CanvasDelta{30, 0}
              && snapDelta({13, 27}, 4.4, 4.6, 1) == CanvasDelta{4, 5},
          "сдвиг ставит угол на сетку, даже если узел стоял не на ней");
}

static void sizes() {
    std::printf("--- размер\n");
    const CanvasRect rect{0, 0, 200, 100};
    check(resizeRect(rect, CanvasHandle::SE, 33, 48) == CanvasRect{0, 0, 230, 150}
              && resizeRect(rect, CanvasHandle::NW, -33, -48) == CanvasRect{-30, -50, 230, 150},
          "угловая ручка двигает две стороны, противоположный угол стоит");
    check(resizeRect(rect, CanvasHandle::E, 51, 500) == CanvasRect{0, 0, 250, 100}
              && resizeRect(rect, CanvasHandle::N, 500, 21) == CanvasRect{0, 20, 200, 80},
          "боковая ручка двигает одну сторону");
    check(resizeRect(rect, CanvasHandle::SE, -500, -500) == CanvasRect{0, 0, kCanvasCardMin.width, kCanvasCardMin.height}
              && resizeRect(rect, CanvasHandle::NW, 500, 500)
                  == CanvasRect{200 - kCanvasCardMin.width, 100 - kCanvasCardMin.height, kCanvasCardMin.width,
                                kCanvasCardMin.height},
          "меньше наименьшего размера не становится, противоположная сторона не едет");
    check(resizeRect(rect, CanvasHandle::SE, 3.4, 7.6, kCanvasCardMin, 1) == CanvasRect{0, 0, 203, 108},
          "без сетки размер меняется по пикселю");
    {
        const auto doc = sample();
        const auto next = resizeNode(doc, "g", CanvasHandle::SE, 200, 100);
        bool ok = rectOf(next, "g") == CanvasRect{0, 0, 600, 400};
        ok = ok && rectOf(next, "a") == rectOf(doc, "a") && rectOf(next, "b") == rectOf(doc, "b");
        // Наименьший размер группы больше, чем у карточки
        ok = ok && rectOf(resizeNode(doc, "g", CanvasHandle::SE, -900, -900), "g")
            == CanvasRect{0, 0, kCanvasGroupMin.width, kCanvasGroupMin.height};
        check(ok, "у группы меняется рамка, содержимое остаётся на месте");
    }
    {
        const auto doc = sample();
        bool ok = placeNode(doc, "a", rectOf(doc, "a")) == doc;
        ok = ok && rectOf(placeNode(doc, "a", {1, 2, 3, 4}), "a") == CanvasRect{1, 2, 3, 4};
        ok = ok && placeNode(doc, "нет", rectOf(doc, "a")) == doc;
        ok = ok && resizeNode(doc, "a", CanvasHandle::SE, 2, 2) == doc;
        check(ok, "нет узла или размер тот же — документ прежний");
    }
}

static void moving() {
    std::printf("--- сдвиг нескольких узлов\n");
    {
        const auto next = moveNodes(sample(), {"g", "a", "c"}, 10, 20);
        bool ok = rectOf(next, "g").x == 10 && rectOf(next, "g").y == 20;
        ok = ok && rectOf(next, "a").x == 30 && rectOf(next, "a").y == 40;
        ok = ok && rectOf(next, "b").x == 210 && rectOf(next, "b").y == 120;
        ok = ok && rectOf(next, "c").x == 610 && rectOf(next, "c").y == 120;
        check(ok, "группа тянет содержимое; узел, выбранный вместе с группой, сдвигается один раз");
    }
    {
        const auto doc = sample();
        check(moveNodes(doc, {"a"}, 0, 0) == doc && moveNodes(doc, {"нет"}, 5, 5) == doc,
              "нулевой сдвиг и незнакомые id — документ прежний");
    }
}

static void groupFrames() {
    std::printf("--- рамка группы при сдвиге\n");
    {
        const auto doc = sample();
        // `b` (200…300 по x) уезжает к 340…440: за рамкой 40 из 100
        const auto next = growGroups(doc, moveNodes(doc, {"b"}, 140, 0));
        bool ok = rectOf(next, "g") == CanvasRect{0, 0, 440 + kCanvasGroupPadding, 300};
        ok = ok && idsOf(nodesInGroup(next, "g")) == Ids{"a", "b"};
        check(ok, "карточка выступила меньше чем наполовину — рамка растёт до неё с полем");
    }
    {
        const auto doc = sample();
        const auto next = growGroups(doc, moveNodes(doc, {"a"}, -30, -20));
        check(rectOf(next, "g") == CanvasRect{-10 - kCanvasGroupPadding, -kCanvasGroupPadding, 430, 320},
              "рамка растёт и влево, и вверх");
    }
    {
        const auto doc = sample();
        const auto next = growGroups(doc, moveNodes(doc, {"b"}, 260, 0));
        check(rectOf(next, "g") == rectOf(doc, "g") && idsOf(nodesInGroup(next, "g")) == Ids{"a"},
              "карточка выступила больше чем наполовину — вышла из группы, рамка прежняя");
    }
    {
        const auto doc = sample();
        // `c` заезжает на рамку, но в группе не была
        const auto next = growGroups(doc, moveNodes(doc, {"c"}, -250, 0));
        check(rectOf(next, "g") == rectOf(doc, "g"), "карточка, не лежавшая в группе, рамку не растягивает");
    }
    {
        const auto doc = sample();
        const auto moved = moveNodes(doc, {"g"}, 500, 500);
        const auto inside = moveNodes(doc, {"a"}, 10, 10);
        check(growGroups(doc, moved) == moved && growGroups(doc, inside) == inside,
              "сдвиг самой группы и сдвиг внутри рамки ничего не растягивают");
    }
    {
        CanvasDoc doc;
        doc.nodes = {node("outer", 0, 0, 400, 400, "group"), node("inner", 50, 50, 300, 200, "group"),
                     node("card", 220, 100)};
        // Карточка наполовину выезжает за внутреннюю рамку (350), оставаясь во внешней (400)
        const auto next = growGroups(doc, moveNodes(doc, {"card"}, 80, 0));
        check(rectOf(next, "inner") == CanvasRect{50, 50, 370, 200} && rectOf(next, "outer") == CanvasRect{0, 0, 440, 400},
              "выросшая вложенная группа растягивает внешнюю");
    }
    {
        const auto doc = sample();
        const auto next = growGroups(doc, resizeNode(doc, "b", CanvasHandle::SE, 150, 0));
        check(rectOf(next, "b").width == 250 && rectOf(next, "g").width == 450 + kCanvasGroupPadding,
              "увеличенная карточка внутри группы тоже растягивает рамку");
    }
}

static void fitAndWrap() {
    std::printf("--- «по содержимому» и «обернуть в группу»\n");
    {
        const auto doc = sample();
        check(rectOf(fitGroupToContent(doc, "g"), "g") == CanvasRect{0, 0, 320, 180}
                  && rectOf(fitGroupToContent(doc, "g", 5), "g") == CanvasRect{15, 15, 290, 150},
              "рамка — границы содержимого плюс поле");
    }
    {
        CanvasDoc doc;
        doc.nodes = {node("g", 0, 0, 400, 300, "group"), node("c", 600, 0)};
        check(fitGroupToContent(doc, "g") == doc && fitGroupToContent(doc, "c") == doc,
              "пустая группа и не-группа не меняются");
    }
    {
        const auto doc = sample();
        const auto result = wrapInGroup(doc, {"b", "c"}, counter("w"));
        bool ok = result.id == "w1";
        ok = ok && idsOf(result.doc.nodes) == Ids{"g", "a", "w1", "b", "c"};
        ok = ok && *findNode(result.doc, "w1") == node("w1", 180, 80, 540, 100, "group");
        ok = ok && idsOf(nodesInGroup(result.doc, "w1")) == Ids{"b", "c"};
        check(ok, "новая группа охватывает узлы с полем и лежит в списке перед первым из них");
    }
    {
        const auto doc = sample();
        const auto none = wrapInGroup(doc, {});
        const auto missing = wrapInGroup(doc, {"нет"});
        check(none.doc == doc && !none.id && missing.doc == doc && !missing.id, "нечего оборачивать — документ прежний");
    }
}

static void selection() {
    std::printf("--- выделение\n");
    {
        const CanvasSelection empty;
        const auto one = toggleSelected(empty, CanvasSelectionKind::Nodes, "a");
        bool ok = one == CanvasSelection{{"a"}, {}};
        const auto two = toggleSelected(toggleSelected(one, CanvasSelectionKind::Nodes, "b"), CanvasSelectionKind::Edges, "ab");
        ok = ok && two == CanvasSelection{{"a", "b"}, {"ab"}};
        ok = ok && toggleSelected(two, CanvasSelectionKind::Nodes, "a") == CanvasSelection{{"b"}, {"ab"}};
        ok = ok && isSelectionEmpty(empty) && !isSelectionEmpty(two);
        check(ok, "добавить и убрать");
    }
    check(selectAll(sample()) == CanvasSelection{{"g", "a", "b", "c"}, {"ab", "bc"}}, "всё");
    {
        const auto doc = sample();
        bool ok = pruneSelection(doc, {{"a", "нет"}, {"ab", "нет"}}) == CanvasSelection{{"a"}, {"ab"}};
        const CanvasSelection same{{"a"}, {}};
        ok = ok && pruneSelection(doc, same) == same;
        check(ok, "исчезнувшее из выделения убирается; ничего не исчезло — тот же объект");
    }
    {
        const auto doc = sample();
        bool ok = rectOfPoints({250, 150}, {10, 10}) == CanvasRect{10, 10, 240, 140};
        // Рамка внутри группы задевает обе карточки, но не выделяет саму группу
        ok = ok && nodesInRect(doc, rectOfPoints({10, 10}, {250, 150})) == Ids{"a", "b"};
        ok = ok && nodesInRect(doc, rectOfPoints({-10, -10}, {410, 310})) == Ids{"g", "a", "b"};
        ok = ok && nodesInRect(doc, rectOfPoints({450, 0}, {500, 50})).empty();
        check(ok, "рамка: карточка — если задета, группа — только целиком");
    }
    check(selectionBounds(sample(), {"a", "c"}) == CanvasRect{20, 20, 680, 140} && !selectionBounds(sample(), {}),
          "границы выделенного");
    {
        const auto doc = sample();
        const auto next = removeSelection(doc, {{"g", "c"}, {"ab"}});
        bool ok = idsOf(next.nodes) == Ids{"a", "b"} && next.edges.empty();
        ok = ok && idsOf(removeSelection(doc, {{"a"}, {}}).edges) == Ids{"bc"};
        ok = ok && removeSelection(doc, {}) == doc;
        check(ok, "удаление: узлы со своими связями, выбранные связи, содержимое группы остаётся");
    }
    {
        const auto doc = sample();
        const CanvasSelection sel{{"a", "b"}, {"ab"}};
        const auto painted = recolorSelection(doc, sel, "4");
        bool ok = findNode(painted, "a")->str("color") == "4";
        ok = ok && !findNode(painted, "c")->has("color");
        ok = ok && painted.edges[0].str("color") == "4";
        ok = ok && colorOfSelection(painted, sel) == "4";
        ok = ok && !colorOfSelection(painted, {{"a", "c"}, {}});
        ok = ok && recolorSelection(painted, sel, "4") == painted;
        const auto cleared = recolorSelection(painted, sel);
        ok = ok && !findNode(cleared, "a")->has("color");
        ok = ok && serializeCanvas(cleared) == serializeCanvas(doc);
        check(ok, "цвет всему выделенному и снятие цвета");
    }
}

static void copies() {
    std::printf("--- копии\n");
    {
        const auto doc = sample();
        const auto clip = copyNodes(doc, {"g"});
        bool ok = idsOf(clip.nodes) == Ids{"g", "a", "b"} && idsOf(clip.edges) == Ids{"ab"};
        ok = ok && copyNodes(doc, {"b"}).edges.empty();
        ok = ok && clipBounds(clip) == CanvasRect{0, 0, 400, 300};
        ok = ok && !clipBounds(copyNodes(doc, {}));
        check(ok, "в снимок идут узлы, содержимое групп и связи между ними");
    }
    {
        const auto doc = sample();
        const auto result = pasteClip(doc, copyNodes(doc, {"a", "b"}), 20, 30, counter());
        bool ok = result.ids == Ids{"n1", "n2"};
        ok = ok && result.doc.nodes.size() == 6;
        ok = ok && rectOf(result.doc, "n1") == CanvasRect{40, 50, 100, 60};
        ok = ok && result.doc.edges[2] == edge("n3", "n1", "n2");
        // Прежние узлы и связи не тронуты
        ok = ok && std::vector<CanvasNode>(result.doc.nodes.begin(), result.doc.nodes.begin() + 4) == doc.nodes;
        ok = ok && std::vector<CanvasEdge>(result.doc.edges.begin(), result.doc.edges.begin() + 2) == doc.edges;
        check(ok, "вставка даёт новые id и переводит концы связей на новые узлы");
    }
    {
        CanvasDoc doc;
        CanvasNode a = node("a", 0, 0);
        a.set("color", "3");
        a.set("text", "текст");
        CanvasNode b = node("b", 200, 0);
        b.set("custom", 1);
        doc.nodes = {a, b};
        doc.edges = {edge("ab", "a", "b", {{"fromSide", "right"}, {"toEnd", "none"}, {"label", "подпись"}})};
        const auto next = pasteClip(doc, copyNodes(doc, {"a", "b"}), 0, 100, counter()).doc;
        bool ok = next.nodes[2].str("color") == "3" && next.nodes[2].str("text") == "текст" && next.nodes[2].y == 100;
        ok = ok && next.nodes[3].get("custom") && *next.nodes[3].get("custom") == 1;
        ok = ok && next.edges[1].str("fromSide") == "right" && next.edges[1].str("toEnd") == "none"
            && next.edges[1].str("label") == "подпись";
        const auto reparsed = parseCanvas(serializeCanvas(next));
        ok = ok && reparsed.dropped == CanvasDropped{0, 0} && reparsed.doc == next;
        check(ok, "вставка сохраняет поля узлов и связей, файл остаётся JSON Canvas");
    }
    {
        const auto doc = sample();
        auto ids = std::make_shared<Ids>(Ids{"a", "x1", "x2"});
        const auto next = pasteClip(doc, copyNodes(doc, {"a"}), 10, 10, [ids] {
            if (ids->empty()) return std::string("z");
            const auto id = ids->front();
            ids->erase(ids->begin());
            return id;
        }).doc;
        bool ok = next.nodes[4].id == "x1";
        const auto empty = pasteClip(doc, {}, 10, 10);
        ok = ok && empty.doc == doc && empty.ids.empty();
        check(ok, "занятый id не выдаётся повторно; пустой снимок — документ прежний");
    }
}

static void clipboard() {
    std::printf("--- буфер обмена\n");
    {
        const auto clip = copyNodes(sample(), {"a", "b"});
        const auto pasted = parsePasted(serializeClip(clip));
        check(pasted && pasted->kind == CanvasPasted::Kind::Nodes && pasted->clip == clip,
              "снимок уходит текстом JSON Canvas и возвращается узлами");
    }
    {
        auto isLink = [](std::string_view text, const std::string &url) {
            const auto p = parsePasted(text);
            return p && p->kind == CanvasPasted::Kind::Link && p->url == url;
        };
        auto isText = [](std::string_view text, const std::string &expected) {
            const auto p = parsePasted(text);
            return p && p->kind == CanvasPasted::Kind::Text && p->text == expected;
        };
        bool ok = isLink(" https://jsoncanvas.org/spec \n", "https://jsoncanvas.org/spec");
        ok = ok && isText("example.com", "example.com");
        ok = ok && isText("см. https://example.com", "см. https://example.com");
        ok = ok && isText(R"({"не": "холст"})", R"({"не": "холст"})");
        ok = ok && isText(R"({"nodes": []})", R"({"nodes": []})");
        ok = ok && isText("javascript:alert(1)", "javascript:alert(1)");
        ok = ok && !parsePasted("   ");
        std::string many;
        for (int i = 0; i < 30000; ++i) many += "я";
        const auto longText = parsePasted(many);
        ok = ok && longText && canvasjs::utf16Length(longText->text) == 20000;
        check(ok, "адрес http(s) — ссылка, прочее — текст");
    }
}

static void layers() {
    std::printf("--- слои\n");
    const auto doc = sample();
    bool ok = idsOf(reorderNodes(doc, {"a"}, CanvasLayer::Front).nodes) == Ids{"g", "b", "c", "a"};
    ok = ok && idsOf(reorderNodes(doc, {"c", "b"}, CanvasLayer::Back).nodes) == Ids{"b", "c", "g", "a"};
    ok = ok && reorderNodes(doc, {"c"}, CanvasLayer::Front) == doc;
    ok = ok && reorderNodes(doc, {"нет"}, CanvasLayer::Front) == doc;
    check(ok, "на передний и на задний план");
}

static void arrows() {
    std::printf("--- стрелки\n");
    const CanvasRect rect{0, 0, 200, 100};
    {
        bool ok = nearestSide(rect, {100, 5}) == CanvasSide::Top;
        ok = ok && nearestSide(rect, {190, 50}) == CanvasSide::Right;
        ok = ok && nearestSide(rect, {100, 95}) == CanvasSide::Bottom;
        ok = ok && nearestSide(rect, {10, 50}) == CanvasSide::Left;
        ok = ok && nearestSide(rect, {-50, 50}) == CanvasSide::Left;
        ok = ok && nearestSide(rect, {100, 300}) == CanvasSide::Bottom;
        ok = ok && oppositeSide(CanvasSide::Left) == CanvasSide::Right && oppositeSide(CanvasSide::Top) == CanvasSide::Bottom;
        check(ok, "ближайшая сторона — внутри и снаружи прямоугольника");
    }
    {
        CanvasDoc doc;
        doc.nodes = {node("g", 0, 0, 400, 300, "group"), node("a", 20, 20), node("b", 60, 40)};
        const auto *top = nodeAtPoint(doc, {70, 50});
        const auto *under = nodeAtPoint(doc, {70, 50}, "b");
        bool ok = top && top->id == "b" && under && under->id == "a" && !nodeAtPoint(doc, {300, 250});
        check(ok, "карточка под точкой: верхняя, группы не считаются");
    }
    {
        const auto doc = sample();
        const auto next = connectNodes(doc, "a", "c", {"bottom", "left"}, counter("e"));
        bool ok = next.edges[2] == edge("e1", "a", "c", {{"fromSide", "bottom"}, {"toSide", "left"}});
        ok = ok && connectNodes(doc, "a", "b", {"top", std::nullopt}) == doc;
        ok = ok && connectNodes(doc, "a", "a", {}) == doc;
        const auto curve = edgeCurve(next, next.edges[2]);
        ok = ok && curve && curve->p == CanvasAnchor{70, 80, CanvasSide::Bottom}
            && curve->q == CanvasAnchor{600, 130, CanvasSide::Left};
        check(ok, "стрелка с выбранными сторонами; повторная и петля не создаются");
    }
    {
        const auto doc = sample();
        const auto curve = *edgeCurve(doc, doc.edges[1]);
        bool ok = curvePoint(curve, 0) == CanvasPoint{curve.p.x, curve.p.y};
        ok = ok && curvePoint(curve, 1) == CanvasPoint{curve.q.x, curve.q.y};
        ok = ok && distanceToCurve(curve, curvePoint(curve, 0.5)) < 0.001;
        ok = ok && !edgeCurve(doc, edge("x", "a", "нет"));
        check(ok, "кривая начинается и кончается на сторонах узлов");
    }
    {
        const auto doc = sample();
        const auto middle = curvePoint(*edgeCurve(doc, doc.edges[1]), 0.5);
        bool ok = edgeAt(doc, {middle.x, middle.y + 5}, 8) == "bc";
        ok = ok && !edgeAt(doc, {middle.x, middle.y + 30}, 8);
        ok = ok && !edgeAt(doc, {1000, 1000}, 8);
        check(ok, "стрелка под точкой: в пределах допуска, иначе ничего");
    }
    {
        const auto both = nextEdgeEnds({});
        bool ok = both == CanvasEnds{"arrow", std::nullopt};
        const auto none = nextEdgeEnds(both);
        ok = ok && none == CanvasEnds{std::nullopt, "none"};
        ok = ok && nextEdgeEnds(none) == CanvasEnds{};
        ok = ok && nextEdgeEnds({std::nullopt, "arrow"}) == both;
        check(ok, "виды концов идут по кругу, значения по умолчанию не пишутся");
    }
}

static void urls() {
    std::printf("--- адрес карточки-ссылки\n");
    check(normalizeCanvasUrl(" https://jsoncanvas.org/spec ") == "https://jsoncanvas.org/spec"
              && normalizeCanvasUrl("example.com/page?a=1") == "https://example.com/page?a=1"
              && normalizeCanvasUrl("http://example.com") == "http://example.com/",
          "только http и https; без схемы — https");
    {
        bool ok = true;
        for (const char *text : {"", "   ", "javascript:alert(1)", "ftp://example.com", "file:///etc/passwd",
                                 "просто текст", "два слова.com x", "data:text/html,hi", "localhost"}) {
            ok = ok && !normalizeCanvasUrl(text);
        }
        check(ok, "иное отвергается");
    }
    {
        // Сверх web: запись как у `URL.toString()` (регистр, порт по умолчанию, точки в пути, кодирование, IDN)
        bool ok = normalizeCanvasUrl("HTTPS://Example.COM:443/a/./b/../c") == "https://example.com/a/c";
        ok = ok && normalizeCanvasUrl("example.com:8080") == std::nullopt; // схема «example.com:» — не http
        ok = ok && normalizeCanvasUrl("http://example.com:8080/x") == "http://example.com:8080/x";
        ok = ok && normalizeCanvasUrl("https://пример.рф/путь") == "https://xn--e1afmkfd.xn--p1ai/%D0%BF%D1%83%D1%82%D1%8C";
        ok = ok && normalizeCanvasUrl("https://example.com/a?q=\"x\"#frag`") == "https://example.com/a?q=%22x%22#frag%60";
        ok = ok && normalizeCanvasUrl("http://127.1") == "http://127.0.0.1/";
        ok = ok && !normalizeCanvasUrl("http://exa<mple.com");
        check(ok, "запись адреса как у URL.toString() (сверх web)");
    }
}

static void keys() {
    std::printf("--- клавиши\n");
    {
        CanvasKey ru;
        ru.key = "я"; ru.code = "KeyZ"; ru.ctrlKey = true;
        bool ok = canvasShortcut(ru) == CanvasShortcut::Undo;
        ok = ok && canvasShortcut(key("KeyZ", false, true)) == CanvasShortcut::Undo;
        ok = ok && canvasShortcut(key("KeyZ", true, false, true)) == CanvasShortcut::Redo;
        ok = ok && canvasShortcut(key("KeyY", true)) == CanvasShortcut::Redo;
        ok = ok && canvasShortcut(key("KeyA", true)) == CanvasShortcut::SelectAll;
        ok = ok && canvasShortcut(key("KeyD", false, true)) == CanvasShortcut::Duplicate;
        check(ok, "с Ctrl или Cmd — по положению клавиши");
    }
    {
        bool ok = canvasShortcut(key("Delete")) == CanvasShortcut::Remove;
        ok = ok && canvasShortcut(key("Backspace")) == CanvasShortcut::Remove;
        ok = ok && canvasShortcut(key("Enter")) == CanvasShortcut::Edit;
        ok = ok && canvasShortcut(key("F2")) == CanvasShortcut::Edit;
        ok = ok && canvasShortcut(key("ArrowLeft")) == CanvasShortcut::Left;
        ok = ok && canvasShortcut(key("ArrowDown", false, false, true)) == CanvasShortcut::Down;
        check(ok, "без модификаторов");
    }
    {
        bool ok = !canvasShortcut(key("KeyZ")) && !canvasShortcut(key("KeyA"));
        // Копирование и вставка — события буфера обмена, клавиши не перехватываются
        ok = ok && !canvasShortcut(key("KeyC", true)) && !canvasShortcut(key("KeyV", true));
        ok = ok && !canvasShortcut(key("KeyA", true, false, true));
        ok = ok && !canvasShortcut(key("KeyD", true, false, false, true));
        ok = ok && !canvasShortcut(key("KeyS", true));
        ok = ok && !canvasShortcut(key("Enter", false, false, true));
        ok = ok && !canvasShortcut(key("Delete", true));
        check(ok, "чужие сочетания не перехватываются");
    }
}

// Сверх web (там у `findFreeSpot` своих тестов нет): поведение по описанию функции
static void freeSpot() {
    std::printf("--- свободное место для карточки (сверх web)\n");
    {
        CanvasDoc doc;
        const auto spot = findFreeSpot(doc, {125, 30}, 250, 60);
        check(spot == CanvasPoint{0, 0}, "пустой холст — карточка серединой в точке, угол на сетке");
    }
    {
        CanvasDoc doc;
        doc.nodes = {node("a", 0, 0, 250, 60), node("g", -500, -500, 2000, 2000, "group")};
        const auto spot = findFreeSpot(doc, {125, 30}, 250, 60);
        // Шаг клетки 150 × 50; кольцо 1 целиком задевает `a` с просветом 20, в кольце 2 ближайшая — (0, +2): ниже
        check(spot == CanvasPoint{0, 100},
              "занятое место обходится с просветом, группы местом не считаются");
    }
}

int main() {
    std::printf("=== parvane-core notes canvas edit tests (без стека) ===\n");
    grid();
    sizes();
    moving();
    groupFrames();
    fitAndWrap();
    selection();
    copies();
    clipboard();
    layers();
    arrows();
    urls();
    keys();
    freeSpot();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
