// Parvane fork (spec 029, фаза 4): листание дней жестом — порт чистой части web
// `components/parvane/planner/plannerSwipe.ts` (`getSwipeDelta`). `isSwipeBlocked` не перенесён: он ходит по DOM
// (поля ввода, прокручиваемые вбок предки, `getComputedStyle`) — в Qt то же решает виджет по своим детям.
#pragma once

namespace parvane::sections::planner {

struct SwipePoint {
    double x = 0;
    double y = 0;
};

inline constexpr double kSwipeMinDistance = 60;
inline constexpr double kSwipeMaxSlope = 0.7;

// Сдвиг периода по жесту: 1 — вперёд (палец ушёл влево), -1 — назад, 0 — не листание
int getSwipeDelta(const SwipePoint &start, const SwipePoint &end);

} // namespace parvane::sections::planner
