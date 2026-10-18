// Parvane fork (spec 029, фаза 4): ввод текстом «Плана» — выбор лучшего набора кандидатов. Порт web
// `components/parvane/planner/plannerQuickPick.ts`.
//
// Каждый распознаватель предлагает участки строки с оценкой; кандидаты могут пересекаться. Набор без
// пересечений с наибольшей суммой оценок ищется взвешенным расписанием интервалов. Оценка:
// `rank * RANK_STEP + длина совпадения`; суммы сравниваются по рангам сверху вниз. Слот — значение, которое в
// записи одно: из выбранных кандидатов слота остаётся старший по рангу, при равенстве — стоящий левее.
#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace parvane::sections::planner {

inline constexpr int kRankStep = 1000;

// Слот: пустая строка — без слота
struct PickItem {
    int from = 0;
    int to = 0;
    long long score = 0;
    std::string slot;
};

long long candidateScore(int rank, int from, int to);

/** Номера кандидатов лучшего набора без пересечений, не больше одного на слот; порядок — по месту в строке. */
std::vector<size_t> pickCandidateIndices(const std::vector<PickItem> &items);

/** То же для своего типа кандидата (наследник PickItem): копии выбранных. */
template <typename T>
std::vector<T> pickCandidates(const std::vector<T> &items) {
    std::vector<PickItem> plain(items.begin(), items.end());
    std::vector<T> out;
    for (const size_t index : pickCandidateIndices(plain)) out.push_back(items[index]);
    return out;
}

} // namespace parvane::sections::planner
