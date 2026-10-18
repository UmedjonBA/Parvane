// Parvane fork (spec 029, фаза 4): листание дней жестом — порт web `plannerSwipe.ts` (`getSwipeDelta`).
#include "parvane/sections/planner_swipe.h"

#include <cmath>

namespace parvane::sections::planner {

int getSwipeDelta(const SwipePoint &start, const SwipePoint &end) {
    const double dx = end.x - start.x;
    const double dy = end.y - start.y;
    if (std::abs(dx) < kSwipeMinDistance || std::abs(dy) > std::abs(dx) * kSwipeMaxSlope) return 0;
    return dx < 0 ? 1 : -1;
}

} // namespace parvane::sections::planner
