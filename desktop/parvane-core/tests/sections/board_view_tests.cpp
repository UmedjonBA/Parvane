// Parvane fork (spec 029, фаза 4): поле графа и холста — перенос 1:1 web `notes/boardView.test.ts`
// (+ проверки щипка и фона сверх web).
#include <cmath>
#include <cstdio>
#include <string>

#include "parvane/sections/board_view.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total; if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

constexpr double WIDTH = 1000;
constexpr double HEIGHT = 700;
constexpr double TOP = 60;
constexpr double BOTTOM = 20;
constexpr double SIDE = 20;

static bool isOnField(const BoardView &view, const BoardRect &rect) {
    const double left = rect.x * view.scale + view.x;
    const double top = rect.y * view.scale + view.y;
    const double right = (rect.x + rect.width) * view.scale + view.x;
    const double bottom = (rect.y + rect.height) * view.scale + view.y;
    const double slack = 0.001;
    return left >= SIDE - slack && right <= WIDTH - SIDE + slack && top >= TOP - slack
        && bottom <= HEIGHT - BOTTOM + slack;
}

int main() {
    std::printf("=== parvane-core board view tests (без стека) ===\n");
    std::printf("--- revealRects\n");
    const BoardView view{1, 100, 100};
    {
        const std::vector<BoardRect> rects{{0, 0, 250, 140}, {500, 300, 250, 140}};
        check(revealRects(view, rects, WIDTH, HEIGHT, TOP, BOTTOM) == view
                  && revealRects(view, {}, WIDTH, HEIGHT, TOP, BOTTOM) == view,
              "прямоугольники уже на поле — вид тот же");
    }
    {
        const BoardRect rect{0, -80, 250, 140};
        const auto next = revealRects(view, {rect}, WIDTH, HEIGHT, TOP, BOTTOM);
        check(!(next == view) && isOnField(next, rect), "прямоугольник под панелью инструментов считается скрытым");
    }
    {
        const BoardRect far{2400, 1500, 250, 140};
        const BoardRect before{0, 0, 250, 140};
        const auto next = revealRects(view, {far}, WIDTH, HEIGHT, TOP, BOTTOM);
        check(next.scale < 1 && isOnField(next, far) && isOnField(next, before),
              "прямоугольник за краем — вид отъезжает так, что видно и его, и прежнее поле");
    }
    {
        const BoardView zoomed{2, 0, 0};
        const auto next = revealRects(zoomed, {{900, 0, 250, 140}}, WIDTH, HEIGHT, TOP, BOTTOM);
        check(next.scale <= 2, "приближенный вид после показа не приближается сильнее");
    }

    std::printf("--- сверх web: масштаб, фон, щипок\n");
    {
        const auto zoomed = zoomAround({1, 10, 20}, 2, 110, 120);
        // Точка поля (110, 120) остаётся на месте: (110 − 10) / 1 = (110 − x′) / 2
        check(zoomed == BoardView{2, -90, -80} && zoomAround({1, 0, 0}, 100, 0, 0).scale == kBoardMaxScale,
              "масштаб вокруг точки и предел масштаба");
    }
    check(boardBackgroundStyle({1.5, 10.25, -3}) == "background-position: 10.25px -3px; background-size: 33px 33px",
          "точечный фон — строка CSS, числа как в JS");
    {
        BoardPinch pinch;
        bool ok = !pinch.down(1, 0, 0, {1, 0, 0}) && !pinch.isActive();
        ok = ok && pinch.down(2, 100, 0, {1, 0, 0}) && pinch.isActive();
        // Второй палец отъехал: расстояние 100 → 200, масштаб вдвое вокруг начальной середины (50, 0)
        const auto next = pinch.move(2, 200, 0, 0, 0);
        ok = ok && next && *next == BoardView{2, -50, 0};
        // Сдвиг поля в окне вычитается из середины
        const auto boxed = pinch.move(2, 200, 0, 10, 0);
        ok = ok && boxed && *boxed == BoardView{2, -40, 0};
        pinch.up(1);
        ok = ok && !pinch.isActive() && !pinch.move(3, 0, 0, 0, 0);
        check(ok, "щипок двумя пальцами");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
