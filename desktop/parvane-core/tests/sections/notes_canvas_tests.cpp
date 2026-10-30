// Parvane fork (spec 029, фаза 4): холст «Знаний» — перенос 1:1 web `notes/notesCanvas.test.ts` (+ логические
// случаи `NotesCanvas.test.ts`). Без стека.
#include <cmath>
#include <cstdio>
#include <regex>
#include <string>

#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_canvas_edit.h"
#include "parvane/sections/notes_canvas_press.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total; if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}
static bool near(double a, double b, int digits = 2) {
    return std::abs(a - b) < std::pow(10.0, -digits) / 2;
}

// Похоже на файл из Obsidian: группа с двумя карточками внутри, заметка, ссылка, стрелки с подписями
static const std::string SAMPLE = CanvasJson::parse(R"({
  "nodes": [
    {"id": "a1b2c3d4e5f60718", "type": "group", "x": -40, "y": -60, "width": 640, "height": 420, "color": "5", "label": "Спека 016"},
    {"id": "0f1e2d3c4b5a6978", "type": "text", "x": 0, "y": 0, "width": 250, "height": 120, "text": "# Облако\n- папки\n- корзина"},
    {"id": "1122334455667788", "type": "file", "x": 300, "y": 20, "width": 260, "height": 300, "file": "Проект Парванэ.md", "subpath": "#Облако", "color": "3"},
    {"id": "99aabbccddeeff00", "type": "link", "x": 700, "y": 40, "width": 320, "height": 200, "url": "https://jsoncanvas.org"},
    {"id": "deadbeefdeadbeef", "type": "text", "x": 700, "y": 400, "width": 250, "height": 60, "text": "снаружи", "color": "#ff8800"}
  ],
  "edges": [
    {"id": "e000000000000001", "fromNode": "0f1e2d3c4b5a6978", "fromSide": "right", "toNode": "1122334455667788", "toSide": "left", "label": "описано в"},
    {"id": "e000000000000002", "fromNode": "1122334455667788", "toNode": "99aabbccddeeff00", "toEnd": "arrow", "color": "2", "label": "формат"}
  ]
})").dump(1, '\t');

static CanvasDoc sample() { return parseCanvas(SAMPLE).doc; }

static CanvasNode rect(const std::string &id, double x, double y, double width, double height,
                       const std::string &type = "text") {
    CanvasNode node;
    node.id = id; node.type = type; node.x = x; node.y = y; node.width = width; node.height = height;
    return node;
}

static CanvasEdge edge(const std::string &id, const std::string &from, const std::string &to,
                       CanvasJson fields = CanvasJson::object()) {
    CanvasEdge e;
    e.id = id; e.fromNode = from; e.toNode = to; e.fields = std::move(fields);
    return e;
}

// Группа g (0,0 400×300): внутри a и вложенная группа g2 с b; c пересекает границу, d снаружи
static CanvasDoc grouped() {
    CanvasDoc doc;
    doc.nodes = {
        rect("g", 0, 0, 400, 300, "group"), rect("a", 0, 0, 100, 50), rect("g2", 200, 100, 200, 200, "group"),
        rect("b", 220, 120, 100, 50), rect("c", 350, 10, 100, 50), rect("d", 600, 600, 100, 50),
    };
    doc.edges = {edge("e1", "a", "b"), edge("e2", "b", "d", {{"label", "ведёт"}}), edge("e3", "c", "d")};
    return doc;
}

static CanvasMakeId sequence(std::vector<std::string> ids) {
    auto index = std::make_shared<std::size_t>(0);
    return [ids, index] { return ids[std::min((*index)++, ids.size() - 1)]; };
}

static std::vector<std::string> idsOf(const std::vector<CanvasNode> &nodes) {
    std::vector<std::string> ids;
    for (const auto &n : nodes) ids.push_back(n.id);
    return ids;
}
static std::vector<std::string> idsOf(const std::vector<CanvasEdge> &edges) {
    std::vector<std::string> ids;
    for (const auto &e : edges) ids.push_back(e.id);
    return ids;
}
using Ids = std::vector<std::string>;

static bool isHexId(const std::string &id) {
    return std::regex_match(id, std::regex("^[0-9a-f]{16}$"));
}

static CanvasNode withFields(CanvasNode node, CanvasJson fields) {
    for (auto it = fields.begin(); it != fields.end(); ++it) node.set(it.key(), it.value());
    return node;
}

static void parsing() {
    std::printf("--- холст: разбор\n");
    {
        // враждебная глубина незнакомого поля не должна уходить в рекурсию копирования/записи
        const std::string deep = R"({"nodes":[],"edges":[],"x":)" + std::string(5000, '[') + std::string(5000, ']') + "}";
        const auto tooDeep = parseCanvas(deep);
        check(tooDeep.error && *tooDeep.error == CanvasParseError::Json, "слишком глубокий документ отвергается");
        const auto fine = parseCanvas(R"({"nodes":[],"edges":[],"x":[[["a]"]]]})");
        check(!fine.error, "умеренная вложенность и скобка в строке — принимаются");
    }
    {
        const auto result = parseCanvas(SAMPLE);
        const auto &doc = result.doc;
        bool ok = !result.error && result.dropped == CanvasDropped{0, 0};
        std::vector<std::string> types;
        for (const auto &n : doc.nodes) types.push_back(n.type);
        ok = ok && types == Ids{"group", "text", "file", "link", "text"};
        ok = ok && doc.nodes[0] == withFields(rect("a1b2c3d4e5f60718", -40, -60, 640, 420, "group"),
                                              {{"color", "5"}, {"label", "Спека 016"}});
        ok = ok && doc.nodes[1].str("text") == "# Облако\n- папки\n- корзина";
        ok = ok && doc.nodes[2].str("file") == "Проект Парванэ.md" && doc.nodes[2].str("subpath") == "#Облако"
            && doc.nodes[2].str("color") == "3";
        ok = ok && doc.nodes[3].str("url") == "https://jsoncanvas.org";
        ok = ok && doc.nodes[4].str("color") == "#ff8800";
        ok = ok && doc.edges == std::vector<CanvasEdge>{
            edge("e000000000000001", "0f1e2d3c4b5a6978", "1122334455667788",
                 {{"fromSide", "right"}, {"toSide", "left"}, {"label", "описано в"}}),
            edge("e000000000000002", "1122334455667788", "99aabbccddeeff00",
                 {{"toEnd", "arrow"}, {"color", "2"}, {"label", "формат"}}),
        };
        ok = ok && doc.extra.empty();
        check(ok, "настоящий файл: группа, текст, заметка, ссылка, стрелки с подписями");
    }
    {
        const std::string source = R"({"nodes":[{"id":"n1","type":"text","x":0,"y":0,"width":100,"height":50,"text":"т","zIndex":3,"styleAttributes":{"a":1}},{"id":"n2","type":"mindmap","x":10,"y":20,"width":30,"height":40,"branches":["x","y"]}],"edges":[{"id":"e1","fromNode":"n1","toNode":"n2","pathfindingMethod":"square","styleAttributes":{"arrow":"thin"}}],"metadata":{"version":"1.0-1.0","frontmatter":{}}})";
        const auto result = parseCanvas(source);
        const auto &doc = result.doc;
        bool ok = !result.error;
        ok = ok && doc.nodes[0].get("zIndex") && *doc.nodes[0].get("zIndex") == 3;
        ok = ok && doc.nodes[1].type == "mindmap" && *doc.nodes[1].get("branches") == CanvasJson::array({"x", "y"});
        ok = ok && !isCanvasNodeType(doc.nodes[1].type);
        ok = ok && doc.edges[0].str("pathfindingMethod") == "square";
        ok = ok && canvasjs::deepEqual(doc.extra, CanvasJson::parse(R"({"metadata":{"version":"1.0-1.0","frontmatter":{}}})"));
        const auto text = serializeCanvas(doc);
        ok = ok && canvasjs::deepEqual(CanvasJson::parse(text), CanvasJson::parse(source));
        ok = ok && parseCanvas(text).doc == doc;
        check(ok, "незнакомые типы узлов и незнакомые поля сохраняются при записи и повторном разборе");
    }
    {
        // `y: undefined` в web выпадает при JSON.stringify — здесь поля просто нет
        const auto result = parseCanvas(R"({"nodes":[{"id":1,"type":"text","x":"12.5","y":"-7","width":"300","height":80},{"id":"b","type":"text","x":"abc","width":0,"height":-5},{"id":"c","type":"file","file":"Заметка"}],"edges":[{"id":7,"fromNode":1,"toNode":"b"}]})");
        const auto &doc = result.doc;
        bool ok = result.dropped == CanvasDropped{0, 0};
        ok = ok && doc.nodes[0] == rect("1", 12.5, -7, 300, 80);
        ok = ok && doc.nodes[1].x == 0 && doc.nodes[1].y == 0 && doc.nodes[1].width == kCanvasDefaultNodeWidth
            && doc.nodes[1].height == kCanvasDefaultNodeHeight;
        ok = ok && doc.nodes[2].x == 0 && doc.nodes[2].y == 0 && doc.nodes[2].width == kCanvasDefaultNodeWidth
            && doc.nodes[2].height == kCanvasDefaultNodeHeight && doc.nodes[2].str("file") == "Заметка";
        ok = ok && doc.edges == std::vector<CanvasEdge>{edge("7", "1", "b")};
        check(ok, "числа приводятся, нет размера — размер по умолчанию");
    }
    {
        // `undefined` в массиве web превращается в null при JSON.stringify
        const auto result = parseCanvas(R"({"nodes":[{"type":"text","x":0,"y":0},{"id":"x","x":0,"y":0},{"id":"","type":"text"},"строка",null,{"id":"ok","type":"text"},{"id":"ok","type":"group"}],"edges":[{"id":"e1","fromNode":"ok"},{"fromNode":"ok","toNode":"ok"},42,{"id":"e2","fromNode":"ok","toNode":"нет такого"},{"id":"e2","fromNode":"ok","toNode":"ok"}]})");
        bool ok = !result.error && result.dropped == CanvasDropped{6, 4};
        ok = ok && result.doc.nodes.size() == 1 && result.doc.nodes[0].id == "ok" && result.doc.nodes[0].type == "text";
        // связь на отсутствующий узел остаётся в файле: рисовать её нечем, но и терять нельзя
        ok = ok && result.doc.edges == std::vector<CanvasEdge>{edge("e2", "ok", "нет такого")};
        check(ok, "узлы без id или типа и связи без концов выбрасываются и считаются");
    }
    {
        const auto broken = parseCanvas(R"({"nodes":[)");
        bool ok = broken.error == CanvasParseError::Json && broken.doc == createEmptyCanvas()
            && broken.dropped == CanvasDropped{0, 0};
        ok = ok && parseCanvas("не json").error == CanvasParseError::Json;
        for (const char *text : {"[]", "42", "\"текст\"", "null", R"({"nodes":{}})", R"({"nodes":[],"edges":"нет"})"}) {
            const auto result = parseCanvas(text);
            ok = ok && result.error == CanvasParseError::Shape && result.doc == createEmptyCanvas();
        }
        check(ok, "битый JSON и не-объект — пустой документ с ошибкой");
    }
    {
        bool ok = true;
        for (const char *text : {"", "  \n", "{}"}) {
            const auto result = parseCanvas(text);
            ok = ok && !result.error && result.doc == createEmptyCanvas() && result.dropped == CanvasDropped{0, 0};
        }
        const auto result = parseCanvas(R"({"nodes":[{"id":"a","type":"text","x":1,"y":2,"width":3,"height":4}]})");
        ok = ok && !result.error && result.doc.nodes.size() == 1 && result.doc.edges.empty();
        check(ok, "пустой файл и {} — новый пустой холст без ошибки; одного массива достаточно");
    }
}

static void writing() {
    std::printf("--- холст: запись\n");
    {
        CanvasDoc doc;
        doc.extra = CanvasJson::object();
        doc.extra["zeta"] = 1;
        doc.extra["alpha"] = 2;
        CanvasEdge e = edge("e", "a", "b");
        e.set("label", "подпись");
        e.set("zzz", 1);
        e.set("color", "1");
        e.set("toSide", "left");
        e.set("fromSide", "right");
        doc.edges = {e};
        CanvasNode n = rect("a", 1, 2, 3, 4);
        n.set("label", "л");
        n.set("zeta", true);
        n.set("text", "т");
        n.set("color", "2");
        n.set("alpha", "x");
        doc.nodes = {n};
        const std::string expected = std::string("{\n")
            + "\t\"nodes\": [\n"
            + "\t\t{\n"
            + "\t\t\t\"id\": \"a\",\n"
            + "\t\t\t\"type\": \"text\",\n"
            + "\t\t\t\"x\": 1,\n"
            + "\t\t\t\"y\": 2,\n"
            + "\t\t\t\"width\": 3,\n"
            + "\t\t\t\"height\": 4,\n"
            + "\t\t\t\"color\": \"2\",\n"
            + "\t\t\t\"text\": \"т\",\n"
            + "\t\t\t\"label\": \"л\",\n"
            + "\t\t\t\"alpha\": \"x\",\n"
            + "\t\t\t\"zeta\": true\n"
            + "\t\t}\n"
            + "\t],\n"
            + "\t\"edges\": [\n"
            + "\t\t{\n"
            + "\t\t\t\"id\": \"e\",\n"
            + "\t\t\t\"fromNode\": \"a\",\n"
            + "\t\t\t\"fromSide\": \"right\",\n"
            + "\t\t\t\"toNode\": \"b\",\n"
            + "\t\t\t\"toSide\": \"left\",\n"
            + "\t\t\t\"color\": \"1\",\n"
            + "\t\t\t\"label\": \"подпись\",\n"
            + "\t\t\t\"zzz\": 1\n"
            + "\t\t}\n"
            + "\t],\n"
            + "\t\"alpha\": 2,\n"
            + "\t\"zeta\": 1\n"
            + "}";
        check(serializeCanvas(doc) == expected, "порядок ключей постоянный и не зависит от порядка полей в объекте");
    }
    {
        const auto first = serializeCanvas(sample());
        const auto second = serializeCanvas(parseCanvas(first).doc);
        bool ok = second == first;
        ok = ok && canvasjs::deepEqual(CanvasJson::parse(first), CanvasJson::parse(SAMPLE));
        // правка и её отмена возвращают тот же текст
        const auto moved = moveNode(moveNode(sample(), "deadbeefdeadbeef", 15, -5), "deadbeefdeadbeef", -15, 5);
        ok = ok && serializeCanvas(moved) == first;
        check(ok, "повторная запись не меняет текст");
    }
    {
        bool ok = serializeCanvas(createEmptyCanvas()) == "{\n\t\"nodes\": [],\n\t\"edges\": []\n}";
        // поле `color: undefined` в C++ не выразить — его просто нет; чужое `nodes` в extra не пишется
        CanvasDoc doc;
        doc.nodes = {rect("a", 0, 0, 1, 1)};
        doc.extra["nodes"] = "чужое";
        ok = ok && canvasjs::deepEqual(CanvasJson::parse(serializeCanvas(doc)),
                                       CanvasJson::parse(R"({"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1}],"edges":[]})"));
        check(ok, "пустой холст и поля со значением undefined");
    }
    {
        // Сверх web: запись чисел и строк как у JSON.stringify (дробные, большие, управляющие знаки, ключи-индексы)
        CanvasDoc doc;
        CanvasNode n = rect("a", 0.1 + 0.2, -0.5, 1e21, 1.5e-7);
        n.set("pvNote", "строка с \"кавычками\", \\, \x01 и\tтабом");
        n.set("10", 1);
        n.set("2", 2);
        doc.nodes = {n};
        const auto text = serializeCanvas(doc);
        bool ok = text.find("\"x\": 0.30000000000000004") != std::string::npos
            && text.find("\"y\": -0.5") != std::string::npos
            && text.find("\"width\": 1e+21") != std::string::npos
            && text.find("\"height\": 1.5e-7") != std::string::npos
            && text.find(R"("pvNote": "строка с \"кавычками\", \\, \u0001 и\tтабом")") != std::string::npos;
        // JS ставит ключи-индексы первыми по возрастанию
        ok = ok && text.find("\t\t\t\"2\": 2,\n\t\t\t\"10\": 1,\n\t\t\t\"id\": \"a\"") != std::string::npos;
        check(ok, "запись чисел, строк и ключей-индексов как у JSON.stringify (сверх web)");
    }
}

static void edits() {
    std::printf("--- холст: правки\n");
    {
        const auto doc = grouped();
        const auto snapshot = serializeCanvas(doc);
        addNode(doc, rect("new", 1, 1, 1, 1));
        updateNode(doc, "a", {{"color", CanvasJson("1")}});
        removeNode(doc, "b");
        addEdge(doc, "a", "d", "x");
        updateEdge(doc, "e1", {{"label", CanvasJson("y")}});
        removeEdge(doc, "e1");
        moveNode(doc, "g", 10, 10);
        check(serializeCanvas(doc) == snapshot, "ни одна правка не меняет исходный документ");
    }
    {
        const auto doc = grouped();
        const auto next = addNode(doc, withFields(rect("new", 5, 6, 7, 8), {{"text", "привет"}}));
        bool ok = next.nodes.size() == 7;
        ok = ok && next.nodes[6] == withFields(rect("new", 5, 6, 7, 8), {{"text", "привет"}});
        ok = ok && !next.nodes[6].has("color");
        ok = ok && next.edges == doc.edges;
        ok = ok && addNode(doc, rect("a", 0, 0, 1, 1)) == doc;
        ok = ok && addNode(doc, rect("", 0, 0, 1, 1)) == doc;
        check(ok, "addNode: в конец списка; занятый или пустой id — документ прежний");
    }
    {
        const auto doc = updateNode(grouped(), "a",
                                    {{"text", CanvasJson("новый")}, {"color", CanvasJson("4")}, {"custom", CanvasJson(1)}});
        bool ok = *findNode(doc, "a") == withFields(rect("a", 0, 0, 100, 50), {{"text", "новый"}, {"color", "4"}, {"custom", 1}});
        const auto cleared = updateNode(doc, "a", {{"color", std::nullopt}, {"id", CanvasJson("другой")}});
        ok = ok && *findNode(cleared, "a") == withFields(rect("a", 0, 0, 100, 50), {{"text", "новый"}, {"custom", 1}});
        ok = ok && !findNode(cleared, "другой");
        const auto same = grouped();
        ok = ok && updateNode(same, "нет", {{"text", CanvasJson("x")}}) == same;
        check(ok, "updateNode: правит поля, undefined убирает поле, id не меняется");
    }
    {
        const auto doc = removeNode(grouped(), "b");
        bool ok = idsOf(doc.nodes) == Ids{"g", "a", "g2", "c", "d"};
        ok = ok && idsOf(doc.edges) == Ids{"e3"};
        // удаление группы не трогает содержимое
        ok = ok && idsOf(removeNode(grouped(), "g").nodes) == Ids{"a", "g2", "b", "c", "d"};
        const auto same = grouped();
        ok = ok && removeNode(same, "нет") == same;
        check(ok, "removeNode: убирает узел и все его связи");
    }
    {
        const auto doc = grouped();
        const auto next = addEdge(doc, "a", "d", "зависит", [] { return std::string("new-edge"); });
        bool ok = next.edges[3] == edge("new-edge", "a", "d", {{"label", "зависит"}});
        ok = ok && addEdge(doc, "a", "c", std::nullopt, [] { return std::string("x"); }).edges[3] == edge("x", "a", "c");
        ok = ok && addEdge(doc, "a", "c", "", [] { return std::string("x"); }).edges[3] == edge("x", "a", "c");
        ok = ok && addEdge(doc, "a", "b", "дубль") == doc;
        ok = ok && addEdge(doc, "a", "a") == doc;
        ok = ok && addEdge(doc, "a", "нет") == doc;
        ok = ok && addEdge(doc, "нет", "a") == doc;
        // обратная стрелка — другая связь
        ok = ok && addEdge(doc, "b", "a", std::nullopt, [] { return std::string("back"); }).edges.size() == 4;
        check(ok, "addEdge: новая стрелка с подписью; без дублей, петель и несуществующих узлов");
    }
    {
        const auto doc = grouped();
        bool ok = isHexId(addEdge(doc, "a", "d").edges[3].id);
        ok = ok && addEdge(doc, "a", "d", std::nullopt, sequence({"e1", "e2", "free"})).edges[3].id == "free";
        ok = ok && addEdge(doc, "a", "d", std::nullopt, [] { return std::string("e1"); }) == doc;
        check(ok, "addEdge: id по умолчанию — 16 знаков; занятый id перевыбирается");
    }
    {
        const auto doc = updateEdge(grouped(), "e1",
                                    {{"label", CanvasJson("подпись")}, {"color", CanvasJson("3")}, {"fromNode", CanvasJson("d")}});
        bool ok = doc.edges[0] == edge("e1", "a", "b", {{"label", "подпись"}, {"color", "3"}});
        ok = ok && updateEdge(doc, "e1", {{"label", CanvasJson("")}}).edges[0] == edge("e1", "a", "b", {{"color", "3"}});
        ok = ok && updateEdge(doc, "e2", {{"label", std::nullopt}}).edges[1] == edge("e2", "b", "d");
        ok = ok && updateEdge(doc, "нет", {{"label", CanvasJson("x")}}) == doc;
        ok = ok && idsOf(removeEdge(doc, "e2").edges) == Ids{"e1", "e3"};
        ok = ok && removeEdge(doc, "e2").nodes == doc.nodes;
        ok = ok && removeEdge(doc, "нет") == doc;
        check(ok, "updateEdge и removeEdge");
    }
    {
        const auto doc = grouped();
        bool ok = idsOf(nodesInGroup(doc, "g")) == Ids{"a", "g2", "b"};
        ok = ok && idsOf(nodesInGroup(doc, "g2")) == Ids{"b"};
        ok = ok && nodesInGroup(doc, "a").empty();
        ok = ok && nodesInGroup(doc, "нет").empty();
        check(ok, "nodesInGroup: только то, что целиком внутри, включая вложенные группы");
    }
    {
        const auto doc = moveNode(grouped(), "a", 10.4, -20.6);
        bool ok = findNode(doc, "a")->x == 10 && findNode(doc, "a")->y == -21;
        auto others = [](const CanvasDoc &d) {
            std::vector<CanvasNode> rest;
            for (const auto &n : d.nodes) if (n.id != "a") rest.push_back(n);
            return rest;
        };
        ok = ok && others(doc) == others(grouped());
        const auto same = grouped();
        ok = ok && moveNode(same, "a", 0, 0) == same;
        ok = ok && moveNode(same, "нет", 5, 5) == same;
        check(ok, "moveNode: обычный узел едет один, координаты целые");
    }
    {
        const auto doc = moveNode(grouped(), "g", 100, 50);
        auto at = [&](const char *id) { return std::pair{findNode(doc, id)->x, findNode(doc, id)->y}; };
        bool ok = at("g") == std::pair{100.0, 50.0} && at("a") == std::pair{100.0, 50.0}
            && at("g2") == std::pair{300.0, 150.0} && at("b") == std::pair{320.0, 170.0}
            && at("c") == std::pair{350.0, 10.0} && at("d") == std::pair{600.0, 600.0};
        ok = ok && doc.edges == grouped().edges;
        // состав группы после сдвига прежний
        ok = ok && idsOf(nodesInGroup(doc, "g")) == Ids{"a", "g2", "b"};
        check(ok, "moveNode: группа тянет за собой всё, что внутри; пересекающее границу и внешнее остаётся");
    }
    {
        // группа наезжает на d — следующим сдвигом d всё ещё не внутри; после переноса d внутрь — едет
        const auto step = moveNode(grouped(), "g", 300, 400);
        bool ok = idsOf(nodesInGroup(step, "g")) == Ids{"a", "g2", "b", "d"};
        const auto next = moveNode(step, "g", -300, -400);
        ok = ok && findNode(next, "d")->x == 300 && findNode(next, "d")->y == 200;
        // вложенная группа двигает только своё
        const auto inner = moveNode(grouped(), "g2", -50, 0);
        ok = ok && findNode(inner, "b")->x == 170 && findNode(inner, "b")->y == 120;
        ok = ok && findNode(inner, "a")->x == 0 && findNode(inner, "a")->y == 0;
        ok = ok && findNode(inner, "g")->x == 0 && findNode(inner, "g")->y == 0;
        check(ok, "moveNode: состав группы определяется на момент сдвига");
    }
}

static void geometry() {
    std::printf("--- холст: геометрия\n");
    {
        bool ok = !boundsOf(createEmptyCanvas());
        ok = ok && boundsOf(grouped()) == CanvasRect{0, 0, 700, 650};
        ok = ok && boundsOf(sample()) == CanvasRect{-40, -60, 1060, 520};
        check(ok, "boundsOf: охватывающий прямоугольник");
    }
    {
        const CanvasRect bounds{100, 200, 1000, 500};
        const auto view = fitView(bounds, {580, 800}, 40);
        bool ok = near(view.scale, 0.5);
        // центр содержимого (600, 450) попадает в центр окна (290, 400)
        ok = ok && near(600 * view.scale + view.x, 290) && near(450 * view.scale + view.y, 400);
        // края содержимого — ровно на полях
        ok = ok && near(100 * view.scale + view.x, 40) && near(1100 * view.scale + view.x, 540);
        const auto tall = fitView(CanvasRect{0, 0, 100, 2000}, {1000, 500}, 50);
        ok = ok && near(tall.scale, 0.2) && near(tall.y, 50) && near(2000 * tall.scale + tall.y, 450);
        check(ok, "fitView: содержимое по центру, масштаб по тесной стороне");
    }
    {
        const CanvasViewport viewport{1000, 800};
        const auto small = fitView(CanvasRect{0, 0, 10, 10}, viewport);
        bool ok = small.scale == kCanvasFitMaxScale && near(5 * small.scale + small.x, 500);
        ok = ok && fitView(CanvasRect{0, 0, 1000000, 10}, viewport).scale == kCanvasMinScale;
        const auto point = fitView(CanvasRect{30, 40, 0, 0}, viewport);
        ok = ok && point == CanvasView{kCanvasFitMaxScale, 500 - 30 * 1.2, 400 - 40 * 1.2};
        ok = ok && fitView(std::nullopt, viewport) == CanvasView{1, 500, 400};
        const auto padded = fitView(CanvasRect{0, 0, 920, 100}, viewport);
        ok = ok && near(padded.scale, 1) && near(padded.x, 40);
        // окно меньше полей — масштаб не уходит в ноль и не становится отрицательным
        ok = ok && fitView(CanvasRect{0, 0, 100, 100}, {20, 20}).scale == kCanvasMinScale;
        ok = ok && clampCanvasScale(10) == kCanvasMaxScale && clampCanvasScale(0) == kCanvasMinScale;
        check(ok, "fitView: пределы масштаба, пустой холст, поля по умолчанию");
    }
    {
        const CanvasViewport phone{390, 700};
        const auto view = firstGroupView(sample(), phone);
        // группа 640×420 от (-40, -60): ширина 310 на 640
        bool ok = near(view.scale, 310.0 / 640);
        ok = ok && near(-40 * view.scale + view.x, 40);
        ok = ok && near((-60 + 210) * view.scale + view.y, 350);
        ok = ok && view.scale > fitView(boundsOf(sample()), phone).scale;
        ok = ok && near(firstGroupView(sample(), phone, 0).scale, 390.0 / 640);
        check(ok, "firstGroupView: телефон открывает первую группу крупно");
    }
    {
        const CanvasViewport viewport{800, 600};
        CanvasDoc doc;
        doc.nodes = {rect("a", 0, 0, 100, 100), rect("b", 900, 0, 100, 100)};
        bool ok = firstGroupView(doc, viewport) == fitView(boundsOf(doc), viewport);
        ok = ok && firstGroupView(createEmptyCanvas(), viewport) == CanvasView{1, 400, 300};
        check(ok, "firstGroupView: без групп — весь холст, пустой холст — вид по умолчанию");
    }
    {
        const auto box = rect("a", 10, 20, 100, 40).rect();
        bool ok = sidePoint(box, CanvasSide::Top) == CanvasPoint{60, 20};
        ok = ok && sidePoint(box, CanvasSide::Bottom) == CanvasPoint{60, 60};
        ok = ok && sidePoint(box, CanvasSide::Left) == CanvasPoint{10, 40};
        ok = ok && sidePoint(box, CanvasSide::Right) == CanvasPoint{110, 40};
        check(ok, "sidePoint: середины сторон");
    }
    {
        const auto a = rect("a", 0, 0, 100, 50).rect();
        bool ok = edgeAnchors(a, rect("b", 300, 0, 100, 50).rect())
            == CanvasAnchors{{100, 25, CanvasSide::Right}, {300, 25, CanvasSide::Left}};
        ok = ok && edgeAnchors(a, rect("b", -300, 10, 100, 50).rect())
            == CanvasAnchors{{0, 25, CanvasSide::Left}, {-200, 35, CanvasSide::Right}};
        ok = ok && edgeAnchors(a, rect("b", 0, 200, 100, 50).rect())
            == CanvasAnchors{{50, 50, CanvasSide::Bottom}, {50, 200, CanvasSide::Top}};
        const auto up = edgeAnchors(a, rect("b", 20, -200, 100, 50).rect());
        ok = ok && up.from.side == CanvasSide::Top && up.to.side == CanvasSide::Bottom;
        // широкая карточка: сосед по диагонали ниже диагонали прямоугольника — выход вниз
        const auto wide = rect("w", 0, 0, 400, 40).rect();
        ok = ok && edgeAnchors(wide, rect("b", 250, 300, 100, 40).rect()).from.side == CanvasSide::Bottom;
        ok = ok && edgeAnchors(wide, rect("b", 900, 60, 100, 40).rect()).from.side == CanvasSide::Right;
        check(ok, "edgeAnchors: стороны по взаимному положению");
    }
    {
        const auto a = rect("a", 0, 0, 100, 50).rect();
        const auto b = rect("b", 300, 0, 100, 50).rect();
        bool ok = edgeAnchors(a, b, {"top", "bottom"})
            == CanvasAnchors{{50, 0, CanvasSide::Top}, {350, 50, CanvasSide::Bottom}};
        const auto onlyTo = edgeAnchors(a, b, {std::nullopt, "top"});
        ok = ok && onlyTo.from.side == CanvasSide::Right && onlyTo.to.side == CanvasSide::Top;
        const auto fromSample = edgeAnchors(a, b, sidesOf(sample().edges[0]));
        ok = ok && fromSample.from.side == CanvasSide::Right && fromSample.to.side == CanvasSide::Left;
        ok = ok && edgeAnchors(a, b, {"вбок", std::nullopt}).from.side == CanvasSide::Right;
        const auto same = edgeAnchors(a, a);
        ok = ok && std::isfinite(same.from.x + same.from.y + same.to.x + same.to.y);
        check(ok, "edgeAnchors: стороны из связи важнее положения; совпавшие узлы не ломают расчёт");
    }
}

static void identifiers() {
    std::printf("--- холст: идентификаторы и проверки значений\n");
    {
        bool ok = isHexId(newCanvasId());
        ok = ok && newCanvasId() != newCanvasId();
        ok = ok && newCanvasId([] { return 0.0; }) == "0000000000000000";
        ok = ok && newCanvasId([] { return 0.999999; }) == "ffffffffffffffff";
        ok = ok && newCanvasId([] { return 1.0; }) == "ffffffffffffffff";
        int step = 0;
        ok = ok && newCanvasId([&] { return (step++ % 16) / 16.0; }) == "0123456789abcdef";
        check(ok, "newCanvasId: 16 шестнадцатеричных знаков, генератор подставляется");
    }
    {
        bool ok = isCanvasNodeType("text") && isCanvasNodeType("file") && isCanvasNodeType("group")
            && isCanvasNodeType("link");
        ok = ok && !isCanvasNodeType("mindmap");
        ok = ok && isCanvasPresetColor("1") && isCanvasPresetColor("6");
        ok = ok && !isCanvasPresetColor("7") && !isCanvasPresetColor("#ff0000") && !isCanvasPresetColor(std::nullopt);
        check(ok, "известные типы узлов и цвета палитры");
    }
}

// Логика из `NotesCanvas.test.ts` (компонент на jsdom): что делает нажатие, без отрисовки
static CanvasPress pressOf(std::optional<std::string> nodeId, std::optional<std::string> edgeId = std::nullopt,
                           bool isAdditive = false) {
    CanvasPress press;
    press.nodeId = std::move(nodeId);
    press.edgeId = std::move(edgeId);
    press.isAdditive = isAdditive;
    return press;
}

static CanvasPressAction actionOf(CanvasPressAction::Kind kind, std::optional<std::string> id = std::nullopt) {
    CanvasPressAction action;
    action.kind = kind;
    action.id = std::move(id);
    return action;
}

static void componentLogic() {
    std::printf("--- холст: нажатия мыши (логика из NotesCanvas.test.ts)\n");
    // Группа 610×100 с двумя карточками и стрелкой между ними (от правой стороны первой к верху второй)
    CanvasDoc doc;
    doc.nodes = {
        withFields(rect("pair", -700, 100, 610, 100, "group"), {{"label", "Пара"}}),
        withFields(rect("alpha", -680, 120, 250, 60), {{"text", "Альфа"}}),
        withFields(rect("beta", -360, 120, 250, 60), {{"text", "Бета"}}),
    };
    doc.edges = {edge("edge", "alpha", "beta", {{"fromSide", "right"}, {"toSide", "top"}})};
    const CanvasPoint onEdge{-308, 110};
    const CanvasPoint inCorner{-690, 110};
    {
        // шапка группы — это её узел: нажатие берёт группу, сдвиг везёт карточки
        bool ok = pressAction(pressOf("pair")) == actionOf(CanvasPressAction::Kind::Node, "pair");
        const auto moved = moveNodes(doc, {"pair"}, 120, -80);
        ok = ok && findNode(moved, "pair")->x == -580 && findNode(moved, "pair")->y == 20;
        ok = ok && findNode(moved, "alpha")->x == -560 && findNode(moved, "alpha")->y == 40;
        ok = ok && findNode(moved, "beta")->x == -240 && findNode(moved, "beta")->y == 40;
        check(ok, "шапка группы двигает её вместе с карточками, поле стоит");
    }
    {
        // в узком поле между рамкой и карточкой нет ни карточки, ни стрелки — нажатие двигает поле
        bool ok = !nodeAtPoint(doc, inCorner) && !edgeAt(doc, inCorner, 8);
        ok = ok && pressAction({}) == actionOf(CanvasPressAction::Kind::Board);
        check(ok, "пустое место внутри группы двигает поле, группа и карточки стоят");
    }
    {
        // середина кривой стрелки — около точки (-308, 110): нажатие выбирает стрелку, а не группу
        const auto hit = edgeAt(doc, onEdge, 8);
        bool ok = hit == "edge";
        ok = ok && pressAction(pressOf(std::nullopt, hit)) == actionOf(CanvasPressAction::Kind::Edge, "edge");
        check(ok, "нажатие на самой линии стрелки внутри группы выбирает стрелку, группа стоит");
    }
    {
        bool ok = pressAction(pressOf(std::nullopt, std::nullopt, true)) == actionOf(CanvasPressAction::Kind::Marquee);
        check(ok, "с Shift внутри группы рисуется рамка выделения, группа стоит");
    }
    // не перенесено: прочие случаи NotesCanvas.test.ts (подсветка связей, перерисовки во время жеста, меню
    // брошенной стрелки, создание заметки, правка заметки на карточке, Escape) проверяют отрисовку Teact/DOM и
    // хранилище заметок, а не логику холста
}

int main() {
    std::printf("=== parvane-core notes canvas tests (без стека) ===\n");
    parsing();
    writing();
    edits();
    geometry();
    identifiers();
    componentLogic();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
