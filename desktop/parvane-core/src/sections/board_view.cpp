// Parvane fork (spec 029, фаза 4): поле графа и холста — порт web `notes/boardView.ts`.
#include "parvane/sections/board_view.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "parvane/sections/notes_canvas.h"

namespace parvane::sections::notes {

namespace {

constexpr double kWheelRate = 0.0015;
constexpr double kMinPinchDistance = 4;

} // namespace

double clampBoardScale(double scale) {
    return std::min(kBoardMaxScale, std::max(kBoardMinScale, scale));
}

BoardView zoomAround(const BoardView &view, double scale, double cx, double cy) {
    const double next = clampBoardScale(scale);
    const double k = next / view.scale;
    return {next, cx - (cx - view.x) * k, cy - (cy - view.y) * k};
}

BoardView zoomByWheel(const BoardView &view, double deltaY, double cx, double cy) {
    return zoomAround(view, view.scale * std::exp(-deltaY * kWheelRate), cx, cy);
}

BoardView fitRects(const std::vector<BoardRect> &rects, double width, double height, double top, double bottom,
                   double side) {
    if (rects.empty() || !width || !height) return {1, width / 2, height / 2};
    double x0 = std::numeric_limits<double>::infinity();
    double y0 = x0;
    double x1 = -x0;
    double y1 = -x0;
    for (const auto &r : rects) {
        x0 = std::min(x0, r.x);
        y0 = std::min(y0, r.y);
        x1 = std::max(x1, r.x + r.width);
        y1 = std::max(y1, r.y + r.height);
    }
    const double roomY = std::max(1.0, height - top - bottom);
    const double scale = clampBoardScale(std::min({
        std::max(1.0, width - side * 2) / std::max(1.0, x1 - x0),
        roomY / std::max(1.0, y1 - y0),
        kBoardFitMaxScale,
    }));
    return {
        scale,
        (width - (x1 - x0) * scale) / 2 - x0 * scale,
        top + (roomY - (y1 - y0) * scale) / 2 - y0 * scale,
    };
}

BoardView revealRects(const BoardView &view, const std::vector<BoardRect> &rects, double width, double height,
                      double top, double bottom, double side) {
    if (rects.empty() || !width || !height) return view;
    const BoardRect shown{
        (side - view.x) / view.scale,
        (top - view.y) / view.scale,
        std::max(1.0, width - side * 2) / view.scale,
        std::max(1.0, height - top - bottom) / view.scale,
    };
    const bool isShown = std::all_of(rects.begin(), rects.end(), [&](const BoardRect &rect) {
        return rect.x >= shown.x && rect.y >= shown.y
            && rect.x + rect.width <= shown.x + shown.width && rect.y + rect.height <= shown.y + shown.height;
    });
    if (isShown) return view;
    std::vector<BoardRect> all{shown};
    all.insert(all.end(), rects.begin(), rects.end());
    return fitRects(all, width, height, top, bottom, side);
}

std::string boardBackgroundStyle(const BoardView &view) {
    using canvasjs::numberToString;
    const std::string cell = numberToString(kBoardGrid * view.scale);
    return "background-position: " + numberToString(view.x) + "px " + numberToString(view.y)
        + "px; background-size: " + cell + "px " + cell + "px";
}

// ── щипок ────────────────────────────────────────────────────────────────────

BoardPinch::Point *BoardPinch::find(int pointerId) {
    for (auto &[id, point] : points_) {
        if (id == pointerId) return &point;
    }
    return nullptr;
}

void BoardPinch::set(int pointerId, double x, double y) {
    if (auto *point = find(pointerId)) {
        *point = {x, y};
    } else {
        points_.emplace_back(pointerId, Point{x, y});
    }
}

std::pair<double, BoardPinch::Point> BoardPinch::pair() const {
    const Point &a = points_[0].second;
    const Point &b = points_[1].second;
    return {std::hypot(a.x - b.x, a.y - b.y), Point{(a.x + b.x) / 2, (a.y + b.y) / 2}};
}

bool BoardPinch::down(int pointerId, double x, double y, const BoardView &view) {
    set(pointerId, x, y);
    if (points_.size() != 2) return false;
    const auto [distance, center] = pair();
    start_ = Start{std::max(kMinPinchDistance, distance), view, center};
    return true;
}

std::optional<BoardView> BoardPinch::move(int pointerId, double x, double y, double boxLeft, double boxTop) {
    if (!find(pointerId)) return std::nullopt;
    set(pointerId, x, y);
    if (!start_ || points_.size() != 2) return std::nullopt;
    const double distance = pair().first;
    return zoomAround(start_->view, start_->view.scale * (distance / start_->distance),
                      start_->center.x - boxLeft, start_->center.y - boxTop);
}

void BoardPinch::up(int pointerId) {
    points_.erase(std::remove_if(points_.begin(), points_.end(),
                                 [&](const auto &entry) { return entry.first == pointerId; }),
                  points_.end());
    if (points_.size() < 2) start_.reset();
}

bool BoardPinch::isActive() const { return start_.has_value(); }

} // namespace parvane::sections::notes
