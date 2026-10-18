// Parvane fork (spec 029, фаза 4): поле графа и холста «Знаний» — вид (сдвиг и масштаб), масштаб вокруг точки,
// щипок двумя пальцами, вписывание. Зеркало web `notes/boardView.ts`. Без UI.
#pragma once

#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace parvane::sections::notes {

struct BoardView {
    double scale = 1;
    double x = 0;
    double y = 0;
    bool operator==(const BoardView &) const = default;
};

struct BoardRect {
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
};

inline constexpr double kBoardMinScale = 0.15;
inline constexpr double kBoardMaxScale = 2.5;
inline constexpr double kBoardZoomStep = 1.25;
inline constexpr double kBoardFitMaxScale = 1.2;
// Клетка точечного фона при масштабе 1
inline constexpr double kBoardGrid = 22;

double clampBoardScale(double scale);
// Тот же вид в другом масштабе: точка `(cx, cy)` поля остаётся на месте
BoardView zoomAround(const BoardView &view, double scale, double cx, double cy);
BoardView zoomByWheel(const BoardView &view, double deltaY, double cx, double cy);
// Вид, в котором прямоугольники целиком видны под панелью инструментов (`top`) и над низом (`bottom`)
BoardView fitRects(const std::vector<BoardRect> &rects, double width, double height, double top, double bottom,
                   double side = 20);
// Вид, в котором видны и `rects`, и то, что было на экране. Уже видны — прежний вид
BoardView revealRects(const BoardView &view, const std::vector<BoardRect> &rects, double width, double height,
                      double top, double bottom, double side = 20);
// Точечный фон, который едет и растёт вместе с полем (строка CSS, как в web)
std::string boardBackgroundStyle(const BoardView &view);

// Щипок: следит за пальцами на поле и отдаёт вид, пока их два
class BoardPinch {
public:
    // Палец коснулся поля. `true` — начался щипок, обычное перетаскивание надо прекратить
    bool down(int pointerId, double x, double y, const BoardView &view);
    // Палец сдвинулся. Вид — пока идёт щипок; `boxLeft/boxTop` — положение поля в окне
    std::optional<BoardView> move(int pointerId, double x, double y, double boxLeft, double boxTop);
    void up(int pointerId);
    bool isActive() const;

private:
    struct Point {
        double x = 0;
        double y = 0;
    };
    struct Start {
        double distance = 0;
        BoardView view;
        Point center;
    };
    // Пальцы в порядке касания (как Map в JS)
    std::vector<std::pair<int, Point>> points_;
    std::optional<Start> start_;

    Point *find(int pointerId);
    void set(int pointerId, double x, double y);
    std::pair<double, Point> pair() const;
};

} // namespace parvane::sections::notes
