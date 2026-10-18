// Parvane fork (spec 029, фаза 4): выбор кандидатов ввода текстом — порт web plannerQuickPick.ts.
#include "parvane/sections/planner_quick_pick.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <unordered_map>

namespace parvane::sections::planner {

long long candidateScore(int rank, int from, int to) {
    return (long long)rank * kRankStep + std::min(std::max(to - from, 0), kRankStep - 1);
}

namespace {

long long rankOf(const PickItem &item) {
    // Math.floor(score / RANK_STEP)
    const long long q = item.score / kRankStep;
    return (item.score % kRankStep != 0 && item.score < 0) ? q - 1 : q;
}

long long restOf(const PickItem &item) {
    // score % RANK_STEP в JS сохраняет знак делимого
    return item.score % kRankStep;
}

bool isAbove(const std::vector<long long> &a, const std::vector<long long> &b) {
    for (size_t i = 0; i < a.size(); ++i) {
        if (a[i] != b[i]) return a[i] > b[i];
    }
    return false;
}

// Лучший набор без пересечений; слоты не учитываются. На входе и выходе — номера в `items`
std::vector<size_t> schedule(const std::vector<PickItem> &items, const std::vector<size_t> &pool) {
    std::vector<size_t> sorted = pool;
    std::stable_sort(sorted.begin(), sorted.end(), [&](size_t a, size_t b) {
        if (items[a].to != items[b].to) return items[a].to < items[b].to;
        return items[a].from < items[b].from;
    });
    std::set<long long, std::greater<>> rankSet;
    for (const size_t i : sorted) rankSet.insert(rankOf(items[i]));
    std::unordered_map<long long, size_t> place;
    {
        size_t index = 0;
        for (const long long rank : rankSet) place[rank] = index++;
    }
    const std::vector<long long> empty(rankSet.size(), 0);
    // totals[i] — лучшая сумма среди первых i кандидатов
    std::vector<std::vector<long long>> totals{empty};
    std::vector<bool> isTaken{false};
    std::vector<size_t> before{0};
    for (size_t index = 0; index < sorted.size(); ++index) {
        const PickItem &item = items[sorted[index]];
        size_t free = index;
        while (free > 0 && items[sorted[free - 1]].to > item.from) --free;
        std::vector<long long> withItem = totals[free];
        withItem[place[rankOf(item)]] += kRankStep + restOf(item);
        // При равенстве остаётся набор без этого кандидата: он стоит левее
        const bool isBetter = isAbove(withItem, totals[index]);
        totals.push_back(isBetter ? std::move(withItem) : totals[index]);
        isTaken.push_back(isBetter);
        before.push_back(free);
    }
    std::vector<size_t> chosen;
    size_t index = sorted.size();
    while (index > 0) {
        if (isTaken[index]) {
            chosen.push_back(sorted[index - 1]);
            index = before[index];
        } else {
            index -= 1;
        }
    }
    std::reverse(chosen.begin(), chosen.end());
    return chosen;
}

} // namespace

std::vector<size_t> pickCandidateIndices(const std::vector<PickItem> &items) {
    std::vector<size_t> pool;
    for (size_t i = 0; i < items.size(); ++i) {
        if (items[i].to > items[i].from) pool.push_back(i);
    }
    for (;;) {
        const auto chosen = schedule(items, pool);
        std::map<std::string, size_t> winners;
        std::set<size_t> losers;
        for (const size_t i : chosen) {
            const PickItem &item = items[i];
            if (item.slot.empty()) continue;
            const auto found = winners.find(item.slot);
            // Набор идёт слева направо: при равном ранге остаётся первый
            if (found == winners.end() || rankOf(item) > rankOf(items[found->second])) {
                if (found != winners.end()) losers.insert(found->second);
                winners[item.slot] = i;
            } else {
                losers.insert(i);
            }
        }
        if (losers.empty()) return chosen;
        std::vector<size_t> next;
        for (const size_t i : pool) {
            if (!losers.count(i)) next.push_back(i);
        }
        pool = std::move(next);
    }
}

} // namespace parvane::sections::planner
