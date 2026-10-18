// Parvane fork (spec 029, фаза 4): нажатие на поле холста — перенос 1:1 web `notes/notesCanvasPress.test.ts`.
#include <cstdio>
#include <string>

#include "parvane/sections/notes_canvas_press.h"

using namespace parvane::sections::notes;
using Kind = CanvasPressAction::Kind;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total; if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

struct P {
    bool pan = false;
    bool additive = false;
    bool linking = false;
    std::optional<std::string> node;
    std::optional<CanvasSide> port;
    std::optional<CanvasHandle> handle;
    std::optional<std::string> edge;
};

static CanvasPressAction act(const P &p) {
    CanvasPress press;
    press.isPanForced = p.pan;
    press.isAdditive = p.additive;
    press.isLinking = p.linking;
    press.nodeId = p.node;
    press.port = p.port;
    press.handle = p.handle;
    press.edgeId = p.edge;
    return pressAction(press);
}

static CanvasPressAction expect(Kind kind, std::optional<std::string> id = std::nullopt,
                                std::optional<CanvasSide> side = std::nullopt,
                                std::optional<CanvasHandle> handle = std::nullopt) {
    CanvasPressAction a;
    a.kind = kind;
    a.id = std::move(id);
    a.side = side;
    a.handle = handle;
    return a;
}

static P node(const std::string &id) {
    P p;
    p.node = id;
    return p;
}

int main() {
    std::printf("=== parvane-core notes canvas press tests (без стека) ===\n");
    check(act({}) == expect(Kind::Board), "пустое место вне групп двигает поле");
    check(act({}) == expect(Kind::Board) && act(node("g")) == expect(Kind::Node, "g"),
          "пустое место внутри группы двигает поле: группу берут за шапку и границу (это её узел)");
    {
        P p;
        p.additive = true;
        check(act(p) == expect(Kind::Marquee), "с Shift и в режиме выбора рисуется рамка выделения");
    }
    {
        P pan;
        pan.pan = true;
        P panOver = node("n");
        panOver.pan = true;
        panOver.handle = CanvasHandle::SE;
        check(act(pan) == expect(Kind::Pan) && act(panOver) == expect(Kind::Pan),
              "средняя кнопка и пробел двигают поле и над группой, и над карточкой");
    }
    {
        P additive = node("card");
        additive.additive = true;
        check(act(node("card")) == expect(Kind::Node, "card") && act(additive) == expect(Kind::Node, "card"),
              "карточка внутри группы берётся сама");
    }
    {
        P resize = node("g");
        resize.handle = CanvasHandle::SE;
        P arrow = node("n");
        arrow.port = CanvasSide::Right;
        P both = arrow;
        both.handle = CanvasHandle::E;
        check(act(resize) == expect(Kind::Resize, "g", std::nullopt, CanvasHandle::SE)
                  && act(arrow) == expect(Kind::Arrow, "n", CanvasSide::Right)
                  && act(both) == expect(Kind::Arrow, "n", CanvasSide::Right),
              "ручка размера и точка стрелки старше сдвига узла");
    }
    {
        P edge;
        edge.edge = "e";
        P additive = edge;
        additive.additive = true;
        check(act(edge) == expect(Kind::Edge, "e") && act(additive) == expect(Kind::Edge, "e"),
              "стрелка внутри группы выбирается, а не двигает группу");
    }
    {
        P link = node("n");
        link.linking = true;
        P cancel;
        cancel.linking = true;
        P port = link;
        port.port = CanvasSide::Top;
        check(act(link) == expect(Kind::Link, "n") && act(cancel) == expect(Kind::Link)
                  && act(port) == expect(Kind::Arrow, "n", CanvasSide::Top),
              "в режиме «Связать» нажатие выбирает вторую карточку либо отменяет режим");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
