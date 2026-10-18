// Parvane fork (spec 029, T063): внешний вид холста — разметка строки карточки, наконечник и концы линии стрелки,
// подпись узла. Ожидания — по web `notesCanvasLook.tsx` (`renderCardInline`, `arrowPath`, `curvePath`) и
// `NotesCanvas.tsx` (`nameOfNode`).
#include "notes_test_util.h"
#include "parvane/sections/notes_canvas_look.h"

using namespace parvane::sections::notes;

using K = CanvasInlinePart::Kind;

static CanvasNode node(const std::string &type, const CanvasJson &fields) {
    CanvasNode n;
    n.id = "n";
    n.type = type;
    for (auto it = fields.begin(); it != fields.end(); ++it) n.set(it.key(), it.value());
    return n;
}

static CanvasEdge edge(const CanvasJson &fields) {
    CanvasEdge e;
    e.id = "e";
    e.fromNode = "a";
    e.toNode = "b";
    for (auto it = fields.begin(); it != fields.end(); ++it) e.set(it.key(), it.value());
    return e;
}

int main() {
    std::printf("canvasInlineParts\n");
    check(canvasInlineParts("просто текст") == std::vector<CanvasInlinePart>{{K::Text, "просто текст"}},
          "строка без разметки — один кусок текста");
    check(canvasInlineParts("") .empty(), "пустая строка — пусто");
    check(canvasInlineParts("см. [[Заметка]] и `код` **важно**") == std::vector<CanvasInlinePart>{
              {K::Text, "см. "}, {K::Link, "Заметка"}, {K::Text, " и "}, {K::Code, "код"}, {K::Text, " "},
              {K::Bold, "важно"}},
          "ссылка, код и жирный по порядку");
    check(canvasInlineParts("[[Цель|подпись]]") == std::vector<CanvasInlinePart>{{K::Link, "подпись"}},
          "ссылка с псевдонимом показывает псевдоним");
    check(canvasInlineParts("[[ Цель |]]") == std::vector<CanvasInlinePart>{{K::Link, "Цель"}},
          "пустой псевдоним — цель без пробелов по краям");
    check(canvasInlineParts("[[a]b]] x") == std::vector<CanvasInlinePart>{{K::Text, "[[a]b]] x"}},
          "закрывающая скобка внутри — не ссылка");
    check(canvasInlineParts("**a*b**") == std::vector<CanvasInlinePart>{{K::Text, "**a*b**"}},
          "звёздочка внутри — не жирный");
    check(canvasInlineParts("``") == std::vector<CanvasInlinePart>{{K::Text, "``"}}, "пустой код — текст");
    check(canvasInlineParts("`a`**b**") == std::vector<CanvasInlinePart>{{K::Code, "a"}, {K::Bold, "b"}},
          "соседние разметки без пустого текста между ними");
    check(canvasInlineParts("[[x]]]") == std::vector<CanvasInlinePart>{{K::Link, "x"}, {K::Text, "]"}},
          "лишняя скобка остаётся текстом");

    std::printf("canvasArrowHead / canvasLineEnd\n");
    {
        const auto head = canvasArrowHead({100, 50, CanvasSide::Top});
        check(head.tip == CanvasPoint{100, 50} && head.left == CanvasPoint{95, 39} && head.right == CanvasPoint{105, 39},
              "наконечник у верхней стороны: основание выше на 11, полуширина 5 (как arrowPath web)");
        const auto right = canvasArrowHead({0, 0, CanvasSide::Right});
        check(right.left == CanvasPoint{11, 5} && right.right == CanvasPoint{11, -5}, "наконечник у правой стороны");
        check(canvasLineEnd({10, 10, CanvasSide::Left}, true) == CanvasPoint{0, 10}, "с наконечником линия короче на 10");
        check(canvasLineEnd({10, 10, CanvasSide::Bottom}, false) == CanvasPoint{10, 10}, "без наконечника — сам конец");
    }

    std::printf("canvasEdgeArrows\n");
    check(canvasEdgeArrows(edge(CanvasJson::object())) == CanvasEdgeArrows{false, true}, "по умолчанию — только в конце");
    check(canvasEdgeArrows(edge({{"fromEnd", "arrow"}, {"toEnd", "none"}})) == CanvasEdgeArrows{true, false},
          "концы из полей");
    check(canvasEdgeArrows(edge({{"toEnd", "arrow"}})) == CanvasEdgeArrows{false, true}, "toEnd arrow — наконечник");

    std::printf("canvasNodeName\n");
    check(canvasNodeName(node("file", {{"file", "Папка/Идея.md"}})) == std::optional<std::string>("Идея"),
          "карточка заметки — название из пути");
    check(canvasNodeName(node("group", {{"label", "Проект"}})) == std::optional<std::string>("Проект"),
          "группа — подпись");
    check(canvasNodeName(node("text", {{"text", "**Жирный** текст карточки, длинный-длинный"}}))
              == std::optional<std::string>("Жирный текст карточки, д"),
          "текст без звёздочек, 24 знака");
    check(!canvasNodeName(node("text", {{"text", "**"}})), "пусто после звёздочек — подпись по типу");
    check(!canvasNodeName(node("group", CanvasJson::object())), "группа без подписи — по типу");
    check(canvasNodeName(node("file", {{"file", "фото.png"}, {"label", "L"}})) == std::optional<std::string>("L"),
          "файл не заметка — дальше по цепочке");

    return finish();
}
