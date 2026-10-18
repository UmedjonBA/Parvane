// Parvane fork (spec 029, фаза 4): выбор кандидатов ввода текстом «Плана» — тесты 1:1 с web
// `components/parvane/planner/plannerQuickPick.test.ts`.
#include <algorithm>
#include <cmath>
#include <chrono>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "parvane/sections/planner_quick_pick.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

struct Item : PickItem {
    std::string name;
};

static Item item(const std::string &name, int rank, int from, int to, const std::string &slot = "") {
    Item out;
    out.name = name;
    out.from = from;
    out.to = to;
    out.slot = slot;
    out.score = candidateScore(rank, from, to);
    return out;
}

static std::vector<std::string> names(const std::vector<Item> &items) {
    std::vector<std::string> out;
    for (const auto &picked : pickCandidates(items)) out.push_back(picked.name);
    return out;
}

using V = std::vector<std::string>;

// Сумма оценок набора: по рангам сверху вниз — число кандидатов и длина совпадений
static std::map<long long, long long> total(const std::vector<Item> &items) {
    std::map<long long, long long> ranks;
    for (const auto &it : items) ranks[it.score / kRankStep] += kRankStep + it.score % kRankStep;
    return ranks;
}

static bool isAbove(const std::map<long long, long long> &a, const std::map<long long, long long> &b) {
    std::set<long long, std::greater<>> ranks;
    for (const auto &[r, _] : a) ranks.insert(r);
    for (const auto &[r, _] : b) ranks.insert(r);
    for (const long long rank : ranks) {
        const long long x = a.count(rank) ? a.at(rank) : 0;
        const long long y = b.count(rank) ? b.at(rank) : 0;
        if (x != y) return x > y;
    }
    return false;
}

static bool clash(const std::vector<Item> &set) {
    for (size_t i = 0; i < set.size(); ++i) {
        for (size_t j = i + 1; j < set.size(); ++j) {
            if (set[i].from < set[j].to && set[j].from < set[i].to) return true;
        }
    }
    return false;
}

// Полный перебор: лучший набор без пересечений (слоты не учитываются)
static std::vector<Item> bruteForce(const std::vector<Item> &items) {
    std::vector<Item> best;
    for (unsigned mask = 0; mask < (1u << items.size()); ++mask) {
        std::vector<Item> subset;
        for (size_t i = 0; i < items.size(); ++i) {
            if (mask & (1u << i)) subset.push_back(items[i]);
        }
        if (!clash(subset) && isAbove(total(subset), total(best))) best = subset;
    }
    return best;
}

// Генератор с зерном, как в web (числа double, остаток по 2^32)
struct Seeded {
    double state;
    double operator()() {
        state = std::fmod(state * 1664525 + 1013904223, 4294967296.0);
        return state / 4294967296.0;
    }
};

int main() {
    std::printf("=== parvane-core planner quick pick tests ===\n");
    check(names({}).empty() && names({item("b", 1, 6, 9), item("a", 1, 0, 5)}) == V{"a", "b"}
              && names({item("a", 1, 0, 5), item("b", 1, 5, 9), item("empty", 9, 3, 3)}) == V{"a", "b"},
          "пустой набор и кандидаты без пересечений");
    {
        const auto range = item("range", 30, 0, 16);
        bool ok = names({item("from", 29, 2, 7), item("to", 29, 11, 16), range}) == V{"range"};
        std::vector<Item> inner;
        for (int i = 0; i < 12; ++i) inner.push_back(item("inner" + std::to_string(i), 29, i, i + 1));
        inner.push_back(range);
        ok = ok && names(inner) == V{"range"};
        check(ok, "составное старше своих частей: диапазон сильнее двух времён");
    }
    check(names({item("day", 10, 3, 5), item("due", 12, 0, 5)}) == V{"due"}
              && names({item("minutes", 32, 4, 10), item("hours", 33, 0, 10)}) == V{"hours"},
          "срок «до пт» сильнее дня «пт», длительность «1 ч 30 мин» — «30 мин»");
    check(names({item("short", 28, 0, 3), item("long", 28, 0, 10)}) == V{"long"}
              && names({item("long", 28, 0, 10), item("short", 28, 0, 3)}) == V{"long"}
              && names({item("right", 28, 2, 6), item("left", 28, 0, 4)}) == V{"left"},
          "при равном ранге сильнее длинное совпадение: «в 7 вечера» против «в 7»");
    {
        const auto a = item("a", 5, 0, 4);
        const auto b = item("b", 9, 3, 7);
        const auto c = item("c", 5, 6, 10);
        check(names({a, c}) == V{"a", "c"} && names({a, b, c}) == V{"b"}
                  && names({a, b, c, item("d", 12, 4, 6)}) == V{"a", "d", "c"},
              "старший кандидат освобождает место, которое занял бы младший");
    }
    check(names({item("second", 29, 10, 15, "time"), item("first", 29, 0, 5, "time")}) == V{"first"}
              && names({item("clock", 29, 0, 5, "time"), item("range", 30, 10, 21, "time")}) == V{"range"}
              && names({item("time", 29, 0, 5, "time"), item("day", 10, 6, 9, "day")}) == V{"time", "day"}
              && names({item("first", 29, 0, 5, "time"), item("second", 29, 10, 15, "time"),
                        item("day", 10, 9, 14, "day")}) == V{"first", "day"}
              && names({item("first", 29, 0, 5, "time"), item("second", 29, 10, 15, "time"),
                        item("third", 28, 12, 18, "time"), item("day", 10, 16, 20, "day")}) == V{"first", "day"},
          "слот: одно значение — старшее по рангу, при равенстве левое");
    check(candidateScore(30, 0, 16) == 30016 && candidateScore(30, 5, 5) == 30000
              && candidateScore(30, 0, 50000) == 30999,
          "оценка: ранг и длина совпадения");
    {
        Seeded random{20261012};
        bool ok = true;
        for (int round = 0; round < 400 && ok; ++round) {
            const int count = 1 + int(random() * 11);
            std::vector<Item> items;
            for (int index = 0; index < count; ++index) {
                const int from = int(random() * 30);
                const int rank = 1 + int(random() * 5);
                const int to = from + 1 + int(random() * 10);
                items.push_back(item("c" + std::to_string(index), rank, from, to));
            }
            const auto picked = pickCandidates(items);
            ok = !clash(picked) && total(picked) == total(bruteForce(items));
            for (size_t i = 1; i < picked.size(); ++i) ok = ok && picked[i - 1].from <= picked[i].from;
        }
        check(ok, "набор лучший из возможных: сверка с полным перебором");
    }
    {
        Seeded random{3};
        std::vector<Item> items;
        for (int index = 0; index < 2000; ++index) {
            const int from = int(random() * 20000);
            const int to = from + 1 + int(random() * 12);
            const int rank = 1 + int(random() * 30);
            items.push_back(item("c" + std::to_string(index), rank, from, to, "s" + std::to_string(index % 400)));
        }
        const auto started = std::chrono::steady_clock::now();
        const auto picked = pickCandidates(items);
        const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        std::set<std::string> slots;
        for (const auto &p : picked) slots.insert(p.slot);
        check(!picked.empty() && slots.size() == picked.size() && ms < 5000, "много кандидатов выбираются быстро");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
