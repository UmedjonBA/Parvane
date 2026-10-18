// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesGraph.test.ts`.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "parvane/sections/notes_graph.h"

using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

using Strings = std::vector<std::string>;

static const GraphOptions ALL{true, true, std::nullopt};
static const GraphOptions NOTES_ONLY{false, false, std::nullopt};

static GraphOptions withFolders(GraphOptions options, std::optional<Strings> folders) {
    options.folders = std::move(folders);
    return options;
}

static const GraphInput INPUT{
    {
        {"n1", "Проект Парванэ", "Работа", {"Протокол v2", "Идеи", "идеи", "Проект Парванэ"}, false},
        {"n2", "Протокол v2", "Работа", {"проект парванэ", "Sealed sender"}, false},
        {"n3", "Идеи", "Личное", {}, false},
        {"n4", "Одиночка", "Личное", {}, false},
        {"d1", "2026-10-12", "Дни", {"Идеи", "SEALED SENDER"}, true},
    },
    {
        {"r1", "Созвон по проекту", {"Проект Парванэ"}, std::string("event")},
        {"r2", "Созвон по проекту", {"Протокол v2", "Проект Парванэ"}, std::string("event")},
        {"r3", "Написать спеку", {"Протокол v2", "Черновик спеки"}, std::string("task")},
        {"r4", "Без ссылок", {}, std::string("task")},
    },
};

static const GraphNode &node(const std::vector<GraphNode> &nodes, const std::string &id) {
    for (const auto &item : nodes) {
        if (item.id == id) return item;
    }
    throw std::runtime_error("нет узла " + id);
}

static bool hasNode(const std::vector<GraphNode> &nodes, const std::string &id) {
    return std::any_of(nodes.begin(), nodes.end(), [&](const GraphNode &item) { return item.id == id; });
}

static Strings nodeIds(const std::vector<GraphNode> &nodes) {
    Strings out;
    for (const auto &item : nodes) out.push_back(item.id);
    return out;
}

static Strings pairs(const std::vector<GraphEdge> &edges) {
    Strings out;
    for (const auto &edge : edges) {
        const auto [a, b] = std::minmax(edge.from, edge.to);
        out.push_back(a + " — " + b);
    }
    std::sort(out.begin(), out.end());
    return out;
}

static GraphNode makeNode(const std::string &id, const std::string &title, GraphNodeKind kind = GraphNodeKind::Note,
    int degree = 0, double x = 0, double y = 0) {
    GraphNode item;
    item.id = id;
    item.title = title;
    item.kind = kind;
    item.degree = degree;
    item.x = x;
    item.y = y;
    return item;
}

struct Built {
    std::vector<GraphNode> nodes;
    std::vector<GraphEdge> edges;
};

// Случайное дерево с лишними связями на `count` узлов — синтетика большого графа
static Built synth(int count, double seed = 3) {
    SeededRandom random(seed);
    Built built;
    for (int i = 0; i < count; ++i) built.nodes.push_back(makeNode("n" + std::to_string(i), "Заметка " + std::to_string(i)));
    for (int i = 1; i < count; ++i) {
        built.edges.push_back({"n" + std::to_string(i), "n" + std::to_string(static_cast<int>(std::floor(random.next() * i))), false});
        if (random.next() < 0.5) {
            built.edges.push_back(
                {"n" + std::to_string(i), "n" + std::to_string(static_cast<int>(std::floor(random.next() * i))), false});
        }
    }
    std::map<std::string, int> degree;
    for (const auto &edge : built.edges) {
        ++degree[edge.from];
        ++degree[edge.to];
    }
    for (auto &item : built.nodes) item.degree = degree[item.id];
    return built;
}

// Доля пар узлов, чьи кружки наложились, — простая метрика качества раскладки
static double overlapShare(const std::vector<GraphNode> &nodes) {
    double bad = 0;
    double total = 0;
    for (size_t i = 0; i < nodes.size(); ++i) {
        for (size_t j = i + 1; j < nodes.size(); ++j) {
            ++total;
            const double distance = std::hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
            if (distance < nodeRadius(nodes[i].degree) + nodeRadius(nodes[j].degree)) ++bad;
        }
    }
    return bad / total;
}

static Built chain(int count) {
    Built built;
    for (int i = 0; i < count; ++i) {
        built.nodes.push_back(makeNode("n" + std::to_string(i), "Заметка " + std::to_string(i)));
        if (i) built.edges.push_back({"n" + std::to_string(i - 1), "n" + std::to_string(i), false});
    }
    return built;
}

static GraphLayoutOptions box(double width, double height, std::optional<double> seed = std::nullopt) {
    GraphLayoutOptions options;
    options.width = width;
    options.height = height;
    options.seed = seed;
    return options;
}

static GraphLayoutOptions loose(GraphLayoutOptions options) {
    options.isLoose = true;
    return options;
}

static bool inside(const std::vector<GraphNode> &nodes, double width, double height, double margin = kGraphMargin) {
    return std::all_of(nodes.begin(), nodes.end(), [&](const GraphNode &item) {
        return std::isfinite(item.x) && std::isfinite(item.y) && item.x >= margin - 1e-6
            && item.x <= width - margin + 1e-6 && item.y >= margin - 1e-6 && item.y <= height - margin + 1e-6;
    });
}

static std::vector<std::pair<double, double>> coords(const std::vector<GraphNode> &nodes) {
    std::vector<std::pair<double, double>> out;
    for (const auto &item : nodes) out.emplace_back(item.x, item.y);
    return out;
}

static GraphPlaces positions(const std::vector<GraphNode> &nodes) {
    GraphPlaces out;
    for (const auto &item : nodes) out[item.id] = {item.x, item.y};
    return out;
}

static void testBuild() {
    std::printf("-- граф заметок: сборка\n");
    {
        const auto graph = buildGraph(INPUT, NOTES_ONLY);
        GraphNode expected = makeNode("n1", "Проект Парванэ", GraphNodeKind::Note, 2);
        expected.group = "Работа";
        check(nodeIds(graph.nodes) == Strings{"n1", "n2", "n3", "n4", "missing:sealed sender"}
                && pairs(graph.edges) == Strings{"missing:sealed sender — n2", "n1 — n2", "n1 — n3"}
                && node(graph.nodes, "n1") == expected,
            "только заметки: узлы, недостающие заметки, связи без дублей и петель");
    }
    {
        const auto graph = buildGraph(INPUT, ALL);
        Strings missing;
        for (const auto &item : graph.nodes) {
            if (item.kind == GraphNodeKind::Missing) missing.push_back(item.title);
        }
        check(missing == Strings{"Sealed sender", "Черновик спеки"} && node(graph.nodes, "missing:sealed sender").degree == 2
                && !node(graph.nodes, "missing:sealed sender").group,
            "недостающая заметка — один узел на название без учёта регистра, название как в первой ссылке");
    }
    {
        const auto graph = buildGraph(INPUT, GraphOptions{true, false, std::nullopt});
        const GraphNode day = node(graph.nodes, "d1");
        const auto edgePairs = pairs(graph.edges);
        const auto notesOnly = buildGraph(INPUT, NOTES_ONLY);
        check(day.kind == GraphNodeKind::Day && day.group == std::optional<std::string>("Дни") && day.degree == 2
                && std::find(edgePairs.begin(), edgePairs.end(), "d1 — n3") != edgePairs.end()
                && std::none_of(notesOnly.nodes.begin(), notesOnly.nodes.end(),
                    [](const GraphNode &item) { return item.kind == GraphNodeKind::Day; }),
            "ежедневные заметки — только с фильтром «Дни»");
    }
    {
        const GraphInput input{
            {
                {"a", "Итоги", "Работа", {"2026-10-12", "Планы"}, false},
                {"d", "2026-10-12", "Дни", {}, true},
            },
            {{"r", "Ретро", {"2026-10-12"}, std::nullopt}},
        };
        const auto hidden = buildGraph(input, GraphOptions{false, true, std::nullopt});
        const auto shown = buildGraph(input, ALL);
        check(nodeIds(hidden.nodes) == Strings{"a", "missing:планы"} && pairs(hidden.edges) == Strings{"a — missing:планы"}
                && pairs(shown.edges) == Strings{"a — d", "a — missing:планы", "d — r"},
            "ссылка на скрытую ежедневную заметку не рисуется и не считается недостающей");
    }
    {
        const auto graph = buildGraph(INPUT, GraphOptions{false, true, std::nullopt});
        std::vector<Strings> records;
        for (const auto &item : graph.nodes) {
            if (item.kind == GraphNodeKind::Record) records.push_back({item.id, item.title, item.group.value_or("")});
        }
        const auto notesOnly = buildGraph(INPUT, NOTES_ONLY);
        // ссылки обоих экземпляров сложились, общая — без дубля
        check(records == std::vector<Strings>{{"r1", "Созвон по проекту", "event"}, {"r3", "Написать спеку", "task"}}
                && neighboursOf("r1", graph.edges) == std::set<std::string>{"n1", "n2"}
                && node(graph.nodes, "r1").degree == 2 && node(graph.nodes, "missing:черновик спеки").degree == 1
                && std::none_of(notesOnly.nodes.begin(), notesOnly.nodes.end(),
                    [](const GraphNode &item) { return item.kind == GraphNodeKind::Record; }),
            "записи планировщика — только с фильтром; одноимённые схлопнуты в один узел");
    }
    check(!hasNode(buildGraph(INPUT, ALL).nodes, "r4"), "запись без ссылок в граф не попадает");
    {
        const auto graph = buildGraph(INPUT, ALL);
        const bool isEachOk = std::all_of(graph.nodes.begin(), graph.nodes.end(), [&](const GraphNode &item) {
            return item.degree == static_cast<int>(neighboursOf(item.id, graph.edges).size());
        });
        // n2: n1, недостающая, обе записи
        check(isEachOk && node(graph.nodes, "n4").degree == 0 && node(graph.nodes, "n2").degree == 4,
            "степень — число разных соседей");
    }
    {
        const GraphInput input{{
            {"a", "А", "", {"Б", "а", " А "}, false},
            {"b", "Б", "", {"А", "А"}, false},
        }, {}};
        const auto graph = buildGraph(input, ALL);
        const std::vector<GraphEdge> expected{{"a", "b", true}};
        check(graph.edges == expected && graph.nodes[0].degree == 1
                && graph.nodes[1].degree == 1,
            "взаимные ссылки дают одну связь, ссылка на себя — ни одной");
    }
    {
        const GraphInput input{{
            {"a", "А", "", {}, false},
            {"b", "Б", "", {"А", "В"}, false},
            {"c", "В", "", {"Б"}, false},
        }, {}};
        const auto graph = buildGraph(input, ALL);
        const std::vector<GraphEdge> expected{{"b", "a", false}, {"b", "c", true}};
        check(graph.edges == expected,
            "связь направлена от ссылающейся заметки, встречная ссылка её не переворачивает");
    }
    {
        const GraphInput input{{
            {"a", "Дубль", "x", {}, false},
            {"b", "дубль", "y", {}, false},
            {"c", "Ссылается", "y", {"", "   ", "ДУБЛЬ"}, false},
            {"a", "Повтор id", "z", {"Ссылается"}, false},
        }, {}};
        const auto graph = buildGraph(input, ALL);
        const std::vector<GraphEdge> expected{{"c", "a", false}};
        check(nodeIds(graph.nodes) == Strings{"a", "b", "c"} && graph.edges == expected,
            "пустые ссылки пропускаются, одноимённые заметки — ссылка ведёт на первую");
    }
    check(buildGraph({}, ALL) == Graph{}, "пустой вход — пустой граф");
}

static void testFolders() {
    std::printf("-- граф заметок: выбор папок\n");
    {
        const auto graph = buildGraph(INPUT, withFolders(NOTES_ONLY, Strings{"Работа"}));
        // «Идеи» лежит в «Личном»: ссылка на неё не рисуется; заметки «Sealed sender» нет вовсе — она «ещё нет»
        const auto notes = std::count_if(graph.nodes.begin(), graph.nodes.end(),
            [](const GraphNode &item) { return item.kind == GraphNodeKind::Note; });
        check(nodeIds(graph.nodes) == Strings{"n1", "n2", "missing:sealed sender"}
                && pairs(graph.edges) == Strings{"missing:sealed sender — n2", "n1 — n2"}
                && node(graph.nodes, "n1").degree == 1 && notes == 2,
            "в графе только заметки выбранных папок; соседей из других папок нет — ни точкой, ни «ещё нет»");
    }
    {
        const GraphInput input{{
            {"a", "А", "", {"Б", "В"}, false},
            {"b", "Б", "Работа", {"В"}, false},
            {"c", "В", "Работа/Вложенная", {}, false},
        }, {}};
        // Путь совпадает точно: вложенная папка — отдельная
        check(nodeIds(buildGraph(input, withFolders(NOTES_ONLY, Strings{"", "Работа"})).nodes) == Strings{"a", "b"}
                && nodeIds(buildGraph(input, withFolders(NOTES_ONLY, Strings{"Работа/Вложенная"})).nodes)
                    == Strings{"c"}
                && buildGraph(input, withFolders(NOTES_ONLY, Strings{})) == Graph{}
                && buildGraph(input, withFolders(NOTES_ONLY, std::nullopt)).nodes.size() == 3,
            "несколько папок, корень — пустая строка, пустой выбор — заметок нет");
    }
    {
        const auto graph = buildGraph(INPUT, withFolders(ALL, Strings{"Личное"}));
        check(nodeIds(graph.nodes) == Strings{"n3", "n4", "d1", "missing:sealed sender", "r3", "missing:черновик спеки"}
                && pairs(graph.edges) == Strings{"d1 — missing:sealed sender", "d1 — n3", "missing:черновик спеки — r3"}
                && isNoteInGraph("Дни", true, GraphOptions{true, false, Strings{}})
                && !isNoteInGraph("Дни", true, GraphOptions{false, false, std::nullopt})
                && !isNoteInGraph("Личное", false, GraphOptions{false, false, Strings{"Работа"}}),
            "заметки дней выбор папок не трогает; записи «Плана» — только со ссылкой на видимую заметку");
    }
    {
        const auto all = buildGraph(INPUT, NOTES_ONLY);
        const auto placed = layoutGraph(all.nodes, all.edges, loose(box(900, 620)));
        const auto places = positions(placed);
        const auto narrow = buildGraph(INPUT, withFolders(NOTES_ONLY, Strings{"Работа"}));
        const auto next = placeGraph(narrow.nodes, narrow.edges, places, loose(box(900, 620)));
        const bool isSame = std::all_of(next.begin(), next.end(), [&](const GraphNode &item) {
            return GraphPoint{item.x, item.y} == places.at(item.id);
        });
        check(isSame, "смена выбора папок не двигает уже разложенные точки");
    }
    {
        auto notes = INPUT.notes;
        notes.push_back({"", "", "", {}, false});
        notes.push_back({"", "", "Архив", {}, false});
        notes.push_back({"", "", "", {}, false});
        const auto folders = listGraphFolders(notes);
        const std::vector<GraphFolder> expected{{"", 2}, {"Архив", 1}, {"Личное", 2}, {"Работа", 2}};
        const std::vector<GraphNoteInput> daysOnly{{"", "", "Дни", {}, true}};
        check(folders == expected && listGraphFolders(daysOnly).empty()
                && !resolveGraphFolders(std::nullopt, folders)
                && resolveGraphFolders(Strings{"Работа", "Удалённая", ""}, folders) == std::optional<Strings>(Strings{"", "Работа"})
                && !resolveGraphFolders(Strings{"Удалённая"}, folders)
                && !resolveGraphFolders(Strings{"", "Архив", "Личное", "Работа"}, folders)
                && !resolveGraphFolders(Strings{}, folders),
            "папки для выбора: с обычными заметками, корень первым; сохранённый выбор приводится к существующим");
    }
}

static void testLayout() {
    std::printf("-- граф заметок: раскладка\n");
    const auto BOX = box(800, 600);
    const auto withSeed = [&](double seed) {
        auto options = BOX;
        options.seed = seed;
        return options;
    };
    {
        const auto graph = buildGraph(INPUT, ALL);
        const auto first = layoutGraph(graph.nodes, graph.edges, withSeed(7));
        const auto second = layoutGraph(graph.nodes, graph.edges, withSeed(7));
        const auto other = layoutGraph(graph.nodes, graph.edges, withSeed(8));
        // без зерна — зерно по умолчанию, тоже постоянное
        check(second == first && coords(other) != coords(first)
                && layoutGraph(graph.nodes, graph.edges, BOX) == layoutGraph(graph.nodes, graph.edges, BOX),
            "одно зерно — одинаковый результат, другое зерно — другой");
    }
    {
        const auto graph = buildGraph(INPUT, ALL);
        const Graph snapshot = graph;
        auto placed = layoutGraph(graph.nodes, graph.edges, BOX);
        auto source = graph.nodes;
        for (auto &item : placed) item.x = item.y = 0;
        for (auto &item : source) item.x = item.y = 0;
        check(graph == snapshot && placed == source, "вход не меняется, порядок и поля узлов сохраняются");
    }
    {
        const auto [nodes, edges] = chain(60);
        const bool isSmallOk = inside(layoutGraph(nodes, edges, box(320, 240, 3)), 320, 240);
        const bool isBoxOk = inside(layoutGraph(nodes, edges, box(800, 600, 3)), 800, 600);
        auto margined = box(320, 240, 3);
        margined.margin = 100;
        const auto placed = layoutGraph(nodes, edges, margined);
        const bool isMarginOk = std::all_of(placed.begin(), placed.end(), [](const GraphNode &item) {
            return item.x >= 100 - 1e-6 && item.y <= 140 + 1e-6;
        });
        check(isSmallOk && isBoxOk && isMarginOk, "координаты внутри области с отступом");
    }
    {
        const auto [nodes, edges] = chain(12);
        const auto placed = layoutGraph(nodes, edges, box(2000, 2000));
        const auto distance = [&](size_t a, size_t b) {
            return std::hypot(placed[a].x - placed[b].x, placed[a].y - placed[b].y);
        };
        bool isApart = true;
        for (size_t i = 0; i < placed.size(); ++i) {
            for (size_t j = i + 1; j < placed.size(); ++j) isApart = isApart && distance(i, j) > 10;
        }
        check(isApart && distance(0, 1) < distance(0, 11), "узлы не слипаются, связанные ближе несвязанных");
    }
    {
        const auto single = layoutGraph(chain(1).nodes, {}, BOX);
        const auto loosePlaced = layoutGraph(chain(5).nodes, {}, BOX);
        std::set<std::string> distinct;
        for (const auto &item : loosePlaced) {
            char buf[64];
            std::snprintf(buf, sizeof buf, "%.3f:%.3f", item.x, item.y);
            distinct.insert(buf);
        }
        const bool isInBox = std::all_of(loosePlaced.begin(), loosePlaced.end(), [](const GraphNode &item) {
            return item.x >= kGraphMargin && item.x <= 800 - kGraphMargin;
        });
        check(layoutGraph({}, {}, BOX).empty() && single.size() == 1 && single[0].x == 400 && single[0].y == 300
                && distinct.size() == 5 && isInBox,
            "пустой граф, один узел, узлы без связей");
    }
    {
        const auto a = chain(4);
        const auto b = chain(4);
        auto nodes = a.nodes;
        auto edges = a.edges;
        for (auto item : b.nodes) {
            item.id = "x" + item.id;
            nodes.push_back(item);
        }
        for (const auto &edge : b.edges) edges.push_back({"x" + edge.from, "x" + edge.to, false});
        const auto placed = layoutGraph(nodes, edges, box(4000, 4000));
        // гравитация держит оба куска около центра
        check(std::all_of(placed.begin(), placed.end(), [](const GraphNode &item) {
            return std::hypot(item.x - 2000, item.y - 2000) < 600;
        }), "два отдельных куска графа остаются в области и не разлетаются");
    }
    {
        const auto nodes = chain(3).nodes;
        const std::vector<GraphEdge> edges{{"n0", "нет", false}, {"n1", "n1", false}, {"n0", "n2", false}};
        const auto placed = layoutGraph(nodes, edges, BOX);
        const auto zero = layoutGraph(nodes, edges, box(0, 0));
        check(std::all_of(placed.begin(), placed.end(), [](const GraphNode &item) { return std::isfinite(item.x + item.y); })
                && std::all_of(zero.begin(), zero.end(), [](const GraphNode &item) { return item.x == 0 && item.y == 0; }),
            "связи с неизвестными узлами и петли не мешают; нулевая область — все в одной точке");
    }
    {
        const auto [nodes, edges] = chain(10);
        auto options = withSeed(5);
        options.iterations = 0;
        const auto placed = layoutGraph(nodes, edges, options);
        const bool isInY = std::all_of(placed.begin(), placed.end(), [](const GraphNode &item) {
            return item.y >= kGraphMargin - 1e-6 && item.y <= 600 - kGraphMargin + 1e-6;
        });
        check(placed == layoutGraph(nodes, edges, options) && isInY, "ноль итераций — случайная расстановка по зерну, тоже в области");
    }
    {
        bool isBudgetOk = true;
        for (long long count : {600LL, 1000LL, 3000LL}) {
            const double work = static_cast<double>(getLayoutIterations(count)) * ((count * (count - 1)) / 2.0);
            isBudgetOk = isBudgetOk && work <= kGraphWorkBudget;
        }
        check(getLayoutIterations(0) == kGraphIterations && getLayoutIterations(1) == kGraphIterations
                && getLayoutIterations(500) == kGraphIterations && getLayoutIterations(1000) == 100
                && getLayoutIterations(2000) == 25 && getLayoutIterations(100'000) == 1
                && getLayoutIterations(50, 120) == 120 && getLayoutIterations(50, -5) == 0 && isBudgetOk,
            "потолок работы: до 500 узлов все итерации, дальше меньше");
    }
    {
        bool isBudgetOk = true;
        for (long long free : {365LL, 1000LL, 5000LL}) {
            isBudgetOk = isBudgetOk
                && static_cast<double>(getPlaceIterations(free, 5000)) * free * 4999 <= kGraphPlaceWorkBudget;
        }
        check(getPlaceIterations(0, 10) == kGraphPlaceIterations && getPlaceIterations(5, 1) == kGraphPlaceIterations
                && getPlaceIterations(200, 1000) == kGraphPlaceIterations && getPlaceIterations(365, 1000) == 68
                && getPlaceIterations(500, 1000) == 50 && getPlaceIterations(100'000, 100'000) == 1
                && getPlaceIterations(10, 100, 7) == 7 && getPlaceIterations(10, 100, 0) == 0 && isBudgetOk,
            "потолок работы расстановки: до ~200 новых на 1 000 все шаги, дальше меньше");
    }
    {
        const auto [nodes, edges] = synth(500);
        const auto first = layoutGraph(nodes, edges, withSeed(5));
        const bool isRepeatable = layoutGraph(nodes, edges, withSeed(5)) == first;
        const bool isOther = coords(layoutGraph(nodes, edges, withSeed(6))) != coords(first);
        // Точный счёт всех пар на 500 узлах давал 0 наложений (замер web 13 окт 2026); по сетке — не больше 1 на 10 000
        const auto loosePlaced = layoutGraph(nodes, edges, loose(BOX));
        const double overlap = overlapShare(loosePlaced);
        // Размер графа тот же, что при точном счёте: медиана связи 320 ± 15 %
        std::map<std::string, const GraphNode *> byId;
        for (const auto &item : loosePlaced) byId[item.id] = &item;
        std::vector<double> lengths;
        for (const auto &edge : edges) {
            const auto *a = byId[edge.from];
            const auto *b = byId[edge.to];
            lengths.push_back(std::hypot(a->x - b->x, a->y - b->y));
        }
        std::sort(lengths.begin(), lengths.end());
        const double median = lengths[lengths.size() >> 1];
        std::printf("       (наложений %.6f, медиана связи %.1f)\n", overlap, median);
        check(nodes.size() >= static_cast<size_t>(kGraphGridFrom) && isRepeatable && isOther && inside(first, 800, 600)
                && overlap <= 0.0001 && median > 320 * 0.85 && median < 320 * 1.15,
            "большой граф по сетке: повторяем по зерну, в области, без наложений не хуже точного счёта");
    }
    {
        const auto [nodes, edges] = synth(300);
        const auto whole = layoutGraph(nodes, edges, BOX);
        auto run = startGraphLayout(nodes, edges, nullptr, BOX);
        bool isOk = !run.isDone() && run.work() == 0;
        int steps = 0;
        double lastWork = 0;
        while (!run.step(20'000)) {
            ++steps;
            isOk = isOk && run.work() > lastWork;
            lastWork = run.work();
            // Промежуточные места — тоже внутри области
            const auto current = run.nodes();
            isOk = isOk && std::all_of(current.begin(), current.end(), [](const GraphNode &item) {
                return item.x >= kGraphMargin - 1e-6 && item.x <= 800 - kGraphMargin + 1e-6;
            });
            if (steps > 100'000) {
                isOk = false;
                break;
            }
        }
        isOk = isOk && steps > 1 && run.isDone() && run.nodes() == whole;
        // После конца шаг ничего не делает
        const double work = run.work();
        isOk = isOk && run.step(1000) && run.work() == work;
        check(isOk, "раскладка по шагам: порции дают тот же результат, что разом; работа растёт, конец отмечен");
    }
    {
        auto single = startGraphLayout({chain(1).nodes[0]}, {}, nullptr, BOX);
        auto expected = chain(1).nodes[0];
        expected.x = 400;
        expected.y = 300;
        check(startGraphLayout({}, {}, nullptr, BOX).isDone() && single.isDone()
                && single.nodes() == std::vector<GraphNode>{expected},
            "пустой граф и один узел по шагам — сразу готовы");
    }
    {
        SeededRandom a(42);
        SeededRandom b(42);
        std::vector<double> values;
        std::vector<double> again;
        for (int i = 0; i < 200; ++i) values.push_back(a.next());
        for (int i = 0; i < 200; ++i) again.push_back(b.next());
        const std::set<double> distinct(values.begin(), values.end());
        check(again == values
                && std::all_of(values.begin(), values.end(), [](double value) { return value >= 0 && value < 1; })
                && distinct.size() > 190 && SeededRandom(43).next() != values[0],
            "генератор с зерном повторяем и даёт числа в [0, 1)");
        // Сверка с web: mulberry32 `createSeededRandom(1)` — первые числа те же, что у движка JS
        SeededRandom one(1);
        const double first = one.next();
        const double second = one.next();
        std::printf("       (зерно 1: %.17g, %.17g)\n", first, second);
        check(first == 0.6270739405881613 && second == 0.002735721180215478, "mulberry32 даёт те же числа, что web");
    }
}

// Не из web-набора: сверка координат с web. Числа сняты `node --experimental-strip-types` с исходным
// `notesGraph.ts` (18 окт 2026). Допуск 1e-6: libm и движок JS могут разойтись в последнем знаке `pow`/`cos`/`hypot`
static void testWebParity() {
    std::printf("-- граф заметок: сверка координат с web\n");
    const auto near = [](double a, double b) { return std::fabs(a - b) < 1e-6; };
    const auto c = chain(12);
    const auto placed = layoutGraph(c.nodes, c.edges, box(800, 600, 4));
    std::printf("       (chain12: %.17g %.17g)\n", placed[0].x, placed[0].y);
    check(near(placed[0].x, 353.344235028468) && near(placed[0].y, 129.7916148835986)
            && near(placed[1].x, 287.77715840893967) && near(placed[1].y, 182.68201681470785)
            && near(placed[2].x, 237.50180430733064) && near(placed[2].y, 256.25494225992355),
        "полная раскладка цепочки из 12 — те же места, что в web");
    auto grownNodes = c.nodes;
    grownNodes.push_back(makeNode("new", "Новая", GraphNodeKind::Note, 1));
    auto grownEdges = c.edges;
    grownEdges.push_back({"n3", "new", false});
    const auto next = placeGraph(grownNodes, grownEdges, positions(placed), box(800, 600, 4));
    std::printf("       (новый узел: %.17g %.17g)\n", next[12].x, next[12].y);
    check(near(next[12].x, 145.91490448851576) && near(next[12].y, 355.72465790224874),
        "место нового узла — то же, что в web");
    const auto s = synth(300);
    const auto big = layoutGraph(s.nodes, s.edges, box(800, 600));
    std::printf("       (synth300: %.17g %.17g)\n", big[0].x, big[0].y);
    check(near(big[0].x, 366.0694448314347) && near(big[0].y, 281.98348092488544)
            && near(big[299].x, 183.61156976428302) && near(big[299].y, 124.56913471539073),
        "раскладка по сетке 300 узлов — те же места, что в web");
}

static void testNeighbours() {
    std::printf("-- граф заметок: соседи и размер точки\n");
    const std::vector<GraphEdge> edges{{"a", "b", false}, {"c", "a", false}, {"b", "c", false}, {"d", "d", false}};
    check(neighboursOf("a", edges) == std::set<std::string>{"b", "c"} && neighboursOf("d", edges).empty()
            && neighboursOf("нет", edges).empty(),
        "соседи — в обе стороны, без самого узла");
    check(nodeRadius(0) == kGraphMinRadius && std::fabs(nodeRadius(4) - 12.4) < 0.005 && nodeRadius(9) > nodeRadius(4)
            && nodeRadius(10'000) == kGraphMaxRadius && nodeRadius(-3) == kGraphMinRadius
            && nodeRadius(std::nan("")) == kGraphMinRadius,
        "радиус растёт с числом связей и ограничен");
}

static void testPlace() {
    std::printf("-- граф заметок: место новых узлов\n");
    const auto OPTIONS = box(800, 600, 4);
    {
        const auto [nodes, edges] = chain(60);
        const auto small = box(200, 200, 2);
        const auto tight = layoutGraph(nodes, edges, small);
        const auto loosePlaced = layoutGraph(nodes, edges, loose(small));
        const auto span = [](const std::vector<GraphNode> &placed) {
            double minX = INFINITY, maxX = -INFINITY;
            for (const auto &item : placed) {
                minX = std::min(minX, item.x);
                maxX = std::max(maxX, item.x);
            }
            return std::pair{minX, maxX};
        };
        const auto [tightMin, tightMax] = span(tight);
        const auto [looseMin, looseMax] = span(loosePlaced);
        check(tightMax - tightMin <= 200 && looseMax - looseMin > 400 && std::fabs((looseMax + looseMin) / 2 - 100) < 5e-7,
            "свободная раскладка не сжимается в область и стоит вокруг её центра");
    }
    {
        const auto [nodes, edges] = chain(6);
        check(placeGraph(nodes, edges, {}, OPTIONS) == layoutGraph(nodes, edges, OPTIONS), "без прежних мест — полная раскладка");
    }
    {
        const auto [nodes, edges] = chain(12);
        const auto placed = layoutGraph(nodes, edges, OPTIONS);
        auto more = edges;
        more.push_back({"n0", "n11", false});
        const auto next = placeGraph(nodes, more, positions(placed), OPTIONS);
        check(nodeIds(next) == nodeIds(placed) && coords(next) == coords(placed), "новая связь не двигает ни один узел");
    }
    {
        const auto [nodes, edges] = chain(12);
        const auto placed = layoutGraph(nodes, edges, OPTIONS);
        auto grownNodes = nodes;
        grownNodes.push_back(makeNode("new", "Новая", GraphNodeKind::Note, 1));
        auto grownEdges = edges;
        grownEdges.push_back({"n3", "new", false});
        const auto next = placeGraph(grownNodes, grownEdges, positions(placed), OPTIONS);
        bool isOk = true;
        for (const auto &item : placed) {
            const auto &moved = node(next, item.id);
            isOk = isOk && std::hypot(moved.x - item.x, moved.y - item.y) < 1e-9;
        }
        const GraphNode fresh = node(next, "new");
        const GraphNode anchor = node(next, "n3");
        const double reach = std::hypot(fresh.x - anchor.x, fresh.y - anchor.y);
        isOk = isOk && reach > kGraphSpringLength / 3 && reach < kGraphSpringLength * 3;
        for (const auto &item : placed) {
            isOk = isOk && std::hypot(fresh.x - item.x, fresh.y - item.y) > kGraphSpringLength / 3;
        }
        isOk = isOk && placeGraph(grownNodes, grownEdges, positions(placed), OPTIONS) == next;
        check(isOk, "новый узел встаёт рядом с соседом, остальные стоят на месте");
    }
    {
        const auto [nodes, edges] = chain(8);
        const auto placed = layoutGraph(nodes, edges, OPTIONS);
        auto grownNodes = nodes;
        grownNodes.push_back(makeNode("new", "Одна"));
        const auto fresh = node(placeGraph(grownNodes, edges, positions(placed), OPTIONS), "new");
        bool isOk = std::isfinite(fresh.x) && std::isfinite(fresh.y);
        for (const auto &item : placed) {
            isOk = isOk && std::hypot(fresh.x - item.x, fresh.y - item.y) > kGraphSpringLength / 3;
        }
        check(isOk, "узел без связей встаёт с краю, а не в гущу");
    }
    {
        const auto [nodes, edges] = chain(4);
        const auto placed = layoutGraph(nodes, edges, OPTIONS);
        auto grownNodes = nodes;
        grownNodes.push_back(makeNode("p", "p", GraphNodeKind::Note, 1));
        grownNodes.push_back(makeNode("q", "q", GraphNodeKind::Note, 1));
        auto grownEdges = edges;
        grownEdges.push_back({"n1", "p", false});
        grownEdges.push_back({"n1", "q", false});
        const auto next = placeGraph(grownNodes, grownEdges, positions(placed), OPTIONS);
        const GraphNode p = node(next, "p");
        const GraphNode q = node(next, "q");
        check(std::hypot(p.x - q.x, p.y - q.y) > kGraphSpringLength / 3, "два новых узла у одного соседа не сливаются");
    }
    {
        const auto base = synth(400);
        const auto placed = layoutGraph(base.nodes, base.edges, loose(OPTIONS));
        const auto previous = positions(placed);
        const auto grown = synth(400 + 365, 5);
        const auto next = placeGraph(grown.nodes, grown.edges, previous, loose(OPTIONS));
        bool isOk = next.size() == 765;
        for (const auto &item : placed) {
            const auto &moved = node(next, item.id);
            isOk = isOk && moved.x == item.x && moved.y == item.y;
        }
        isOk = isOk && placeGraph(grown.nodes, grown.edges, previous, loose(OPTIONS)) == next;
        // Точный счёт на тех же данных давал до 1 наложения на 10 000 пар (замер web 13 окт 2026)
        const double overlap = overlapShare(next);
        std::printf("       (наложений %.6f)\n", overlap);
        isOk = isOk && overlap <= 0.0002;
        // Шагами — то же самое
        auto run = startGraphLayout(grown.nodes, grown.edges, &previous, loose(OPTIONS));
        while (!run.step(50'000)) {
        }
        isOk = isOk && run.nodes() == next;
        check(isOk, "большой граф по сетке: стоящие узлы не двигаются, новые встают без наложений и повторяемо");
    }
    {
        const GraphPlaces previous{{"a", {10, 20}}, {"missing:новая тема", {300, -40}}};
        const std::vector<GraphNode> nodes{
            makeNode("a", "А", GraphNodeKind::Note, 1), makeNode("n9", "Новая тема", GraphNodeKind::Note, 1)};
        const auto next = placeGraph(nodes, {{"a", "n9", false}}, previous, OPTIONS);
        check(coords(next) == std::vector<std::pair<double, double>>{{10, 20}, {300, -40}},
            "созданная заметка занимает место «заметки, которой ещё нет»");
    }
}

static void testHit() {
    std::printf("-- граф заметок: попадание в узел, правка связей, стрелка\n");
    const std::vector<GraphNode> NODES{
        makeNode("a", "А", GraphNodeKind::Note, 0, 0, 0), makeNode("b", "Б", GraphNodeKind::Missing, 4, 100, 0)};
    const auto idAt = [&](double x, double y, double slop = 0) {
        const auto *found = nodeAt(NODES, x, y, slop);
        return found ? found->id : std::string();
    };
    check(idAt(3, 3) == "a" && idAt(10, 0).empty() && idAt(10, 0, 6) == "a" && idAt(90, 5) == "b"
            && idAt(50, 50, 10).empty() && !nodeAt({}, 0, 0, 100),
        "узел под точкой — с запасом и без");
    {
        std::vector<bool> from;
        std::vector<bool> to;
        for (auto kind : {GraphNodeKind::Note, GraphNodeKind::Missing, GraphNodeKind::Day, GraphNodeKind::Record}) {
            const auto item = makeNode("x", "x", kind);
            from.push_back(canLinkFrom(&item));
            to.push_back(canLinkTo(&item));
        }
        check(from == std::vector<bool>{true, false, false, false} && to == std::vector<bool>{true, true, false, false}
                && !canLinkFrom(nullptr) && !canLinkTo(nullptr),
            "связь ведут от заметки к заметке, существующей или будущей");
    }
    {
        const auto shape = edgeShape({0, 0}, {100, 0}, 6, 10);
        check(shape.x1 == 6 + kGraphEdgeGap && shape.y1 == 0 && shape.x2 == 90 - kGraphEdgeGap && shape.y2 == 0
                && shape.heads == Strings{"M87 0L80 3.5L80 -3.5Z"} && shape.middle == GraphPoint{50, 0},
            "линия идёт от края до края кружков, наконечник — у цели");
    }
    {
        const auto near = edgeShape({0, 0}, {20, 0}, 6, 6);
        check(edgeShape({0, 0}, {0, 200}, 6, 6, true).heads.size() == 2 && near.heads.empty() && near.x1 == 0
                && near.x2 == 20 && edgeShape({5, 5}, {5, 5}, 6, 6).heads.empty(),
            "взаимная связь — наконечники с обеих сторон, кружки вплотную — без наконечников");
    }
}

int main() {
    std::printf("=== parvane-core notes_graph tests ===\n");
    testBuild();
    testFolders();
    testLayout();
    testWebParity();
    testNeighbours();
    testPlace();
    testHit();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
