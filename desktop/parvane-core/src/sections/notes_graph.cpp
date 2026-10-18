// Parvane fork (spec 029, фаза 4): порт web `notes/notesGraph.ts`. Порядок арифметики раскладки повторяет web
// (ГПСЧ mulberry32 даёт те же числа); побитовое совпадение координат с web не обещано: `Math.hypot`, `cos`/`sin`
// и `**` движка JS могут отличаться от libm в последнем знаке.
#include "parvane/sections/notes_graph.h"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <utility>

#include "notes_text.h"

namespace parvane::sections::notes {

namespace {

constexpr double kStartTemperature = 40;
constexpr double kCooling = 0.99;
constexpr double kStartSpread = 300;
constexpr double kMinDistance = 4;
constexpr double kPlaceTemperature = 24;
constexpr double kPlaceCooling = 0.97;

std::string titleKey(const std::string &title) {
    return text::encode(text::toLower(text::trimU(text::decode(title))));
}

std::string edgeKey(const std::string &a, const std::string &b) {
    return a < b ? a + std::string(1, '\0') + b : b + std::string(1, '\0') + a;
}

// `ToUint32` JS
uint32_t toUint32(double value) {
    if (!std::isfinite(value)) return 0;
    const double truncated = std::trunc(value);
    double wrapped = std::fmod(truncated, 4294967296.0);
    if (wrapped < 0) wrapped += 4294967296.0;
    return static_cast<uint32_t>(wrapped);
}

long long floorToCount(double value) { return static_cast<long long>(std::floor(value)); }

} // namespace

// --- Папки --------------------------------------------------------------------------------------------------

bool isNoteInGraph(const std::string &folder, bool isDaily, const GraphOptions &options) {
    if (isDaily) return options.withDays;
    return !options.folders
        || std::find(options.folders->begin(), options.folders->end(), folder) != options.folders->end();
}

std::vector<GraphFolder> listGraphFolders(const std::vector<GraphNoteInput> &notes) {
    // Строки сравниваются побайтно — для UTF-8 это порядок кодовых точек, как `<` строк JS для BMP
    std::map<std::string, int> counts;
    for (const auto &note : notes) {
        if (!note.isDaily) ++counts[note.folder];
    }
    std::vector<GraphFolder> folders;
    for (const auto &[path, count] : counts) folders.push_back({path, count});
    return folders;
}

std::optional<std::vector<std::string>> resolveGraphFolders(
    const std::optional<std::vector<std::string>> &saved, const std::vector<GraphFolder> &known) {
    if (!saved) return std::nullopt;
    std::vector<std::string> kept;
    for (const auto &folder : known) {
        if (std::find(saved->begin(), saved->end(), folder.path) != saved->end()) kept.push_back(folder.path);
    }
    if (!kept.empty() && kept.size() < known.size()) return kept;
    return std::nullopt;
}

// --- Сборка -------------------------------------------------------------------------------------------------

Graph buildGraph(const GraphInput &input, const GraphOptions &options) {
    Graph graph;
    std::map<std::string, size_t> nodeById;
    std::map<std::string, std::string> noteIdByTitle;
    std::set<std::string> hiddenTitles;
    std::map<std::string, size_t> edgeByKey;

    const auto addNode = [&](const std::string &id, const std::string &title, GraphNodeKind kind,
                             const std::optional<std::string> &group) {
        GraphNode node;
        node.id = id;
        node.title = title;
        node.kind = kind;
        node.group = group;
        nodeById[id] = graph.nodes.size();
        graph.nodes.push_back(std::move(node));
    };

    const auto resolveTarget = [&](const std::string &link) -> std::optional<std::string> {
        const std::string key = titleKey(link);
        if (key.empty() || hiddenTitles.count(key)) return std::nullopt;
        const auto noteId = noteIdByTitle.find(key);
        if (noteId != noteIdByTitle.end()) return noteId->second;
        const std::string id = kMissingNodePrefix + key;
        if (!nodeById.count(id)) addNode(id, text::trim(link), GraphNodeKind::Missing, std::nullopt);
        return id;
    };

    const auto connect = [&](const std::string &from, const std::vector<std::string> &links) {
        for (const auto &link : links) {
            const auto to = resolveTarget(link);
            if (!to || *to == from) continue;
            const std::string key = edgeKey(from, *to);
            const auto known = edgeByKey.find(key);
            if (known != edgeByKey.end()) {
                if (graph.edges[known->second].from == *to) graph.edges[known->second].isMutual = true;
                continue;
            }
            edgeByKey[key] = graph.edges.size();
            graph.edges.push_back({from, *to, false});
        }
    };

    std::vector<const GraphNoteInput *> shownNotes;
    for (const auto &note : input.notes) {
        if (!isNoteInGraph(note.folder, note.isDaily, options) || nodeById.count(note.id)) continue;
        addNode(note.id, note.title, note.isDaily ? GraphNodeKind::Day : GraphNodeKind::Note, note.folder);
        shownNotes.push_back(&note);
        // Заметки с одним названием: ссылка ведёт на первую
        const std::string key = titleKey(note.title);
        if (!key.empty() && !noteIdByTitle.count(key)) noteIdByTitle[key] = note.id;
    }
    for (const auto &note : input.notes) {
        const std::string key = titleKey(note.title);
        if (!isNoteInGraph(note.folder, note.isDaily, options) && !key.empty() && !noteIdByTitle.count(key)) {
            hiddenTitles.insert(key);
        }
    }
    for (const auto *note : shownNotes) connect(note->id, note->links);

    if (options.withRecords) {
        std::map<std::string, std::string> recordIdByTitle;
        for (const auto &record : input.records) {
            const bool hasVisibleLink = std::any_of(record.links.begin(), record.links.end(), [&](const auto &link) {
                const std::string key = titleKey(link);
                return !key.empty() && !hiddenTitles.count(key);
            });
            if (!hasVisibleLink) continue;
            const std::string key = titleKey(record.title);
            std::string id;
            const auto known = recordIdByTitle.find(key);
            if (known == recordIdByTitle.end()) {
                // Запись с id уже занятого узла пропускается: два узла с одним id различить нельзя
                if (nodeById.count(record.id)) continue;
                id = record.id;
                recordIdByTitle[key] = id;
                addNode(id, record.title, GraphNodeKind::Record, record.type);
            } else {
                id = known->second;
            }
            connect(id, record.links);
        }
    }

    for (const auto &edge : graph.edges) {
        ++graph.nodes[nodeById[edge.from]].degree;
        ++graph.nodes[nodeById[edge.to]].degree;
    }
    return graph;
}

// --- Генератор и потолки ------------------------------------------------------------------------------------

SeededRandom::SeededRandom(double seed) : state_(toUint32(seed)) {}

double SeededRandom::next() {
    state_ += 0x6D2B79F5u;
    uint32_t t = state_;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
}

long long getLayoutIterations(long long nodeCount, std::optional<double> requested, bool isByGrid) {
    const double value = requested && std::isfinite(*requested) ? *requested : kGraphIterations;
    const long long wanted = std::max(0LL, floorToCount(value));
    const double pairs = (static_cast<double>(nodeCount) * static_cast<double>(nodeCount - 1)) / 2;
    if (pairs <= 0 || wanted == 0 || isByGrid) return wanted;
    return std::min(wanted, std::max(1LL, floorToCount(kGraphWorkBudget / pairs)));
}

long long getPlaceIterations(long long freeCount, long long nodeCount, std::optional<double> requested, bool isByGrid) {
    const double value = requested && std::isfinite(*requested) ? *requested : kGraphPlaceIterations;
    const long long wanted = std::max(0LL, floorToCount(value));
    const double pairs = static_cast<double>(freeCount) * static_cast<double>(nodeCount - 1);
    if (pairs <= 0 || wanted == 0 || isByGrid) return wanted;
    return std::min(wanted, std::max(1LL, floorToCount(kGraphPlaceWorkBudget / pairs)));
}

// --- Раскладка ----------------------------------------------------------------------------------------------

struct GraphLayoutRun::State {
    std::vector<GraphNode> nodes;
    size_t count = 0;
    double width = 0;
    double height = 0;
    double margin = kGraphMargin;
    bool isLoose = false;
    std::vector<double> px;
    std::vector<double> py;
    std::vector<int> movers;
    std::vector<uint8_t> isMover;
    std::vector<std::pair<int, int>> links;
    std::vector<double> fx;
    std::vector<double> fy;
    bool isFull = true;
    bool useGrid = false;
    double centerX = 0;
    double centerY = 0;
    long long iterations = 0;
    double temperature = 0;
    double cooling = 0;
    double budget = 0;
    long long done = 0;
    double work = 0;

    // Отталкивание всех пар точно: при `isMutual` сила прикладывается к обеим точкам пары, пара считается один раз
    double repelExact(bool isMutual) {
        const double k2 = kGraphSpringLength * kGraphSpringLength;
        const int n = static_cast<int>(count);
        double pairs = 0;
        for (int i : movers) {
            for (int j = isMutual ? i + 1 : 0; j < n; ++j) {
                if (j == i) continue;
                double dx = px[i] - px[j];
                double dy = py[i] - py[j];
                if (dx == 0 && dy == 0) {
                    // Совпавшие точки расталкиваются в направлении, заданном их номерами
                    dx = 0.01 * (i - j);
                    dy = 0.01;
                }
                const double distance = std::max(kMinDistance, std::sqrt(dx * dx + dy * dy));
                const double force = k2 / (distance * distance);
                fx[i] += dx * force;
                fy[i] += dy * force;
                if (isMutual) {
                    fx[j] -= dx * force;
                    fy[j] -= dy * force;
                }
            }
            pairs += isMutual ? n - 1 - i : n - 1;
        }
        return pairs;
    }

    // Отталкивание по сетке: соседи из своей и восьми смежных клеток — точно, дальняя клетка — одной силой из
    // центра масс с весом по числу узлов. Порядок обхода задан номерами узлов — результат повторяем
    double repelByGrid() {
        const double k2 = kGraphSpringLength * kGraphSpringLength;
        const double range = kGraphRepulsionRange;
        const int n = static_cast<int>(count);
        double minX = std::numeric_limits<double>::infinity();
        double minY = std::numeric_limits<double>::infinity();
        double maxX = -std::numeric_limits<double>::infinity();
        double maxY = -std::numeric_limits<double>::infinity();
        for (int i = 0; i < n; ++i) {
            if (px[i] < minX) minX = px[i];
            if (px[i] > maxX) maxX = px[i];
            if (py[i] < minY) minY = py[i];
            if (py[i] > maxY) maxY = py[i];
        }
        const long long cols = std::max(1LL, floorToCount((maxX - minX) / range) + 1);
        const long long rows = std::max(1LL, floorToCount((maxY - minY) / range) + 1);
        const long long cells = cols * rows;
        std::vector<int> head(static_cast<size_t>(cells), -1);
        std::vector<int> next(count);
        std::vector<long long> cellOf(count);
        std::vector<int> cellCount(static_cast<size_t>(cells), 0);
        std::vector<double> cellX(static_cast<size_t>(cells), 0);
        std::vector<double> cellY(static_cast<size_t>(cells), 0);
        // Узлы входят в списки клеток с конца, чтобы обход шёл по возрастанию номеров
        for (int i = n - 1; i >= 0; --i) {
            const long long cell = floorToCount((px[i] - minX) / range) + floorToCount((py[i] - minY) / range) * cols;
            cellOf[i] = cell;
            next[i] = head[cell];
            head[cell] = i;
            ++cellCount[cell];
            cellX[cell] += px[i];
            cellY[cell] += py[i];
        }
        for (long long cell = 0; cell < cells; ++cell) {
            if (cellCount[cell]) {
                cellX[cell] /= cellCount[cell];
                cellY[cell] /= cellCount[cell];
            }
        }
        double pairs = 0;
        for (int i : movers) {
            const long long col = cellOf[i] % cols;
            const long long row = (cellOf[i] - col) / cols;
            for (long long cell = 0; cell < cells; ++cell) {
                if (!cellCount[cell]) continue;
                const long long c = cell % cols;
                const long long r = (cell - c) / cols;
                ++pairs;
                if (std::llabs(c - col) > 1 || std::llabs(r - row) > 1) {
                    const double dx = px[i] - cellX[cell];
                    const double dy = py[i] - cellY[cell];
                    const double distance = std::max(kMinDistance, std::sqrt(dx * dx + dy * dy));
                    const double force = (k2 * cellCount[cell]) / (distance * distance);
                    fx[i] += dx * force;
                    fy[i] += dy * force;
                    continue;
                }
                for (int j = head[cell]; j != -1; j = next[j]) {
                    if (j == i) continue;
                    ++pairs;
                    double dx = px[i] - px[j];
                    double dy = py[i] - py[j];
                    if (dx == 0 && dy == 0) {
                        dx = 0.01 * (i - j);
                        dy = 0.01;
                    }
                    const double distance = std::max(kMinDistance, std::sqrt(dx * dx + dy * dy));
                    const double force = k2 / (distance * distance);
                    fx[i] += dx * force;
                    fy[i] += dy * force;
                }
            }
        }
        return pairs;
    }

    void iterate() {
        for (int i : movers) {
            fx[i] = (centerX - px[i]) * kGraphGravity;
            fy[i] = (centerY - py[i]) * kGraphGravity;
        }
        work += useGrid ? repelByGrid() : repelExact(isFull);
        for (const auto &[a, b] : links) {
            const double dx = px[a] - px[b];
            const double dy = py[a] - py[b];
            const double distance = std::max(kMinDistance, std::sqrt(dx * dx + dy * dy));
            const double force = (distance / kGraphSpringLength) * kGraphAttraction;
            if (isMover[a]) {
                fx[a] -= dx * force;
                fy[a] -= dy * force;
            }
            if (isMover[b]) {
                fx[b] += dx * force;
                fy[b] += dy * force;
            }
        }
        for (int i : movers) {
            const double length = std::max(1.0, std::sqrt(fx[i] * fx[i] + fy[i] * fy[i]));
            const double limited = std::min(length, temperature) / length;
            px[i] += fx[i] * limited;
            py[i] += fy[i] * limited;
        }
        temperature *= cooling;
        ++done;
        // По сетке работа шага известна только после первого: потолок итераций — по ней, а не по числу пар
        if (done == 1 && useGrid && work) {
            iterations = std::min(iterations, std::max(1LL, floorToCount(budget / work)));
            cooling = isFull ? std::pow(kCooling, kGraphIterations / static_cast<double>(std::max(iterations, 1LL)))
                             : cooling;
        }
    }
};

GraphLayoutRun::GraphLayoutRun(const std::vector<GraphNode> &nodes, const std::vector<GraphEdge> &edges,
    const GraphPlaces *previous, const GraphLayoutOptions &options)
    : state_(std::make_unique<State>()) {
    State &s = *state_;
    s.nodes = nodes;
    s.count = nodes.size();
    s.width = std::max(0.0, std::isnan(options.width) ? 0.0 : options.width);
    s.height = std::max(0.0, std::isnan(options.height) ? 0.0 : options.height);
    s.margin = std::max(0.0, options.margin.value_or(kGraphMargin));
    s.isLoose = options.isLoose;
    s.px.assign(s.count, 0);
    s.py.assign(s.count, 0);

    std::vector<int> freeList;
    double sumX = 0;
    double sumY = 0;
    for (size_t i = 0; i < s.count; ++i) {
        const GraphNode &node = nodes[i];
        const GraphPoint *at = nullptr;
        if (previous) {
            auto found = previous->find(node.id);
            if (found == previous->end() && (node.kind == GraphNodeKind::Note || node.kind == GraphNodeKind::Day)) {
                found = previous->find(kMissingNodePrefix + titleKey(node.title));
            }
            if (found != previous->end()) at = &found->second;
        }
        if (!at) {
            freeList.push_back(static_cast<int>(i));
            continue;
        }
        s.px[i] = at->x;
        s.py[i] = at->y;
        sumX += at->x;
        sumY += at->y;
    }
    const size_t known = s.count - freeList.size();
    s.isFull = known == 0;
    s.movers = freeList;
    SeededRandom random(options.seed.value_or(kGraphDefaultSeed));

    std::map<std::string, int> indexById;
    for (size_t i = 0; i < s.count; ++i) indexById.emplace(nodes[i].id, static_cast<int>(i));
    for (const auto &edge : edges) {
        const auto a = indexById.find(edge.from);
        const auto b = indexById.find(edge.to);
        if (a != indexById.end() && b != indexById.end() && a->second != b->second) {
            s.links.emplace_back(a->second, b->second);
        }
    }

    s.useGrid = s.count >= static_cast<size_t>(kGraphGridFrom);
    if (s.isFull) {
        for (size_t i = 0; i < s.count; ++i) {
            s.px[i] = (random.next() * 2 - 1) * kStartSpread;
            s.py[i] = (random.next() * 2 - 1) * kStartSpread;
        }
        s.iterations = s.count > 1
            ? getLayoutIterations(static_cast<long long>(s.count), options.iterations, s.useGrid)
            : 0;
        s.temperature = kStartTemperature;
        // При урезанном числе итераций остывание идёт быстрее и заканчивается на той же температуре
        s.cooling = s.iterations
            ? std::pow(kCooling, kGraphIterations / static_cast<double>(std::max(s.iterations, 1LL)))
            : kCooling;
    } else {
        s.centerX = sumX / static_cast<double>(known);
        s.centerY = sumY / static_cast<double>(known);
        std::vector<uint8_t> isPlaced(s.count, 1);
        for (int i : freeList) isPlaced[i] = 0;
        double reach = 0;
        for (size_t i = 0; i < s.count; ++i) {
            if (isPlaced[i]) reach = std::max(reach, std::hypot(s.px[i] - s.centerX, s.py[i] - s.centerY));
        }
        std::vector<std::vector<int>> linked(s.count);
        for (const auto &[a, b] : s.links) {
            linked[a].push_back(b);
            linked[b].push_back(a);
        }
        // Начальное место: на длину связи от середины стоящих соседей, в сторону от центра графа
        for (int i : freeList) {
            std::vector<int> around;
            for (int j : linked[i]) {
                if (isPlaced[j]) around.push_back(j);
            }
            const double angle = random.next() * std::numbers::pi * 2;
            double baseX = s.centerX;
            double baseY = s.centerY;
            double distance = reach + kGraphSpringLength;
            double dirX = std::cos(angle);
            double dirY = std::sin(angle);
            if (!around.empty()) {
                double totalX = 0;
                double totalY = 0;
                for (int j : around) totalX += s.px[j];
                for (int j : around) totalY += s.py[j];
                baseX = totalX / static_cast<double>(around.size());
                baseY = totalY / static_cast<double>(around.size());
                distance = kGraphSpringLength;
                const double away = std::hypot(baseX - s.centerX, baseY - s.centerY);
                if (away > kMinDistance) {
                    dirX = (baseX - s.centerX) / away;
                    dirY = (baseY - s.centerY) / away;
                }
            }
            s.px[i] = baseX + dirX * distance;
            s.py[i] = baseY + dirY * distance;
            isPlaced[i] = 1;
        }
        s.iterations = freeList.empty() ? 0
            : getPlaceIterations(static_cast<long long>(freeList.size()), static_cast<long long>(s.count),
                options.iterations, s.useGrid);
        s.temperature = kPlaceTemperature;
        s.cooling = kPlaceCooling;
    }

    s.isMover.assign(s.count, 0);
    for (int i : s.movers) s.isMover[i] = 1;
    s.fx.assign(s.count, 0);
    s.fy.assign(s.count, 0);
    s.budget = s.isFull ? kGraphWorkBudget : kGraphPlaceWorkBudget;
}

GraphLayoutRun::~GraphLayoutRun() = default;
GraphLayoutRun::GraphLayoutRun(GraphLayoutRun &&) noexcept = default;
GraphLayoutRun &GraphLayoutRun::operator=(GraphLayoutRun &&) noexcept = default;

bool GraphLayoutRun::isDone() const { return state_->done >= state_->iterations; }

double GraphLayoutRun::work() const { return state_->work; }

bool GraphLayoutRun::step(double maxWork) {
    State &s = *state_;
    const double until = s.work + std::max(0.0, maxWork);
    while (s.done < s.iterations && s.work < until) s.iterate();
    return s.done >= s.iterations;
}

std::vector<GraphNode> GraphLayoutRun::nodes() const {
    const State &s = *state_;
    std::vector<GraphNode> out = s.nodes;
    if (!s.count) return out;
    if (!s.isFull) {
        for (size_t i = 0; i < s.count; ++i) {
            out[i].x = s.px[i];
            out[i].y = s.py[i];
        }
        return out;
    }
    const double boxCenterX = s.width / 2;
    const double boxCenterY = s.height / 2;
    if (s.count == 1) {
        out[0].x = boxCenterX;
        out[0].y = boxCenterY;
        return out;
    }
    double minX = std::numeric_limits<double>::infinity();
    double minY = std::numeric_limits<double>::infinity();
    double maxX = -std::numeric_limits<double>::infinity();
    double maxY = -std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < s.count; ++i) {
        minX = std::min(minX, s.px[i]);
        maxX = std::max(maxX, s.px[i]);
        minY = std::min(minY, s.py[i]);
        maxY = std::max(maxY, s.py[i]);
    }
    const double roomX = std::max(0.0, s.width - s.margin * 2);
    const double roomY = std::max(0.0, s.height - s.margin * 2);
    const double spanX = maxX - minX;
    const double spanY = maxY - minY;
    const double scale = s.isLoose
        ? 1
        : std::min({1.0, spanX > 0 ? roomX / spanX : 1.0, spanY > 0 ? roomY / spanY : 1.0});
    const double midX = (minX + maxX) / 2;
    const double midY = (minY + maxY) / 2;
    for (size_t i = 0; i < s.count; ++i) {
        out[i].x = boxCenterX + (s.px[i] - midX) * scale;
        out[i].y = boxCenterY + (s.py[i] - midY) * scale;
    }
    return out;
}

GraphLayoutRun startGraphLayout(const std::vector<GraphNode> &nodes, const std::vector<GraphEdge> &edges,
    const GraphPlaces *previous, const GraphLayoutOptions &options) {
    return GraphLayoutRun(nodes, edges, previous, options);
}

std::vector<GraphNode> layoutGraph(
    const std::vector<GraphNode> &nodes, const std::vector<GraphEdge> &edges, const GraphLayoutOptions &options) {
    GraphLayoutRun run(nodes, edges, nullptr, options);
    run.step();
    return run.nodes();
}

std::vector<GraphNode> placeGraph(const std::vector<GraphNode> &nodes, const std::vector<GraphEdge> &edges,
    const GraphPlaces &previous, const GraphLayoutOptions &options) {
    GraphLayoutRun run(nodes, edges, &previous, options);
    run.step();
    return run.nodes();
}

// --- Соседи, размер, попадание, стрелка ---------------------------------------------------------------------

std::set<std::string> neighboursOf(const std::string &nodeId, const std::vector<GraphEdge> &edges) {
    std::set<std::string> result;
    for (const auto &edge : edges) {
        if (edge.from == nodeId && edge.to != nodeId) result.insert(edge.to);
        if (edge.to == nodeId && edge.from != nodeId) result.insert(edge.from);
    }
    return result;
}

double nodeRadius(double degree) {
    const double safe = std::isfinite(degree) ? std::max(0.0, degree) : 0.0;
    return std::min(kGraphMaxRadius, kGraphMinRadius + std::sqrt(safe) * 3.2);
}

const GraphNode *nodeAt(const std::vector<GraphNode> &nodes, double x, double y, double slop) {
    const GraphNode *found = nullptr;
    double best = std::numeric_limits<double>::infinity();
    for (const auto &node : nodes) {
        const double distance = std::hypot(node.x - x, node.y - y);
        if (distance <= nodeRadius(node.degree) + slop && distance < best) {
            best = distance;
            found = &node;
        }
    }
    return found;
}

bool canLinkFrom(const GraphNode *node) { return node && node->kind == GraphNodeKind::Note; }

bool canLinkTo(const GraphNode *node) {
    return node && (node->kind == GraphNodeKind::Note || node->kind == GraphNodeKind::Missing);
}

namespace {

double round1(double value) { return text::jsRound(value * 10) / 10; }

std::string arrowHead(double tipX, double tipY, double ux, double uy) {
    const double backX = tipX - ux * kGraphArrow;
    const double backY = tipY - uy * kGraphArrow;
    const double wing = kGraphArrow * 0.5;
    using text::formatNumber;
    return "M" + formatNumber(round1(tipX)) + " " + formatNumber(round1(tipY))
        + "L" + formatNumber(round1(backX - uy * wing)) + " " + formatNumber(round1(backY + ux * wing))
        + "L" + formatNumber(round1(backX + uy * wing)) + " " + formatNumber(round1(backY - ux * wing)) + "Z";
}

} // namespace

EdgeShape edgeShape(const GraphPoint &from, const GraphPoint &to, double fromRadius, double toRadius, bool isMutual) {
    const double length = std::hypot(to.x - from.x, to.y - from.y);
    const GraphPoint middle{(from.x + to.x) / 2, (from.y + to.y) / 2};
    if (length <= fromRadius + toRadius + kGraphEdgeGap * 2 + kGraphArrow) {
        return {round1(from.x), round1(from.y), round1(to.x), round1(to.y), {}, middle};
    }
    const double ux = (to.x - from.x) / length;
    const double uy = (to.y - from.y) / length;
    const double x1 = from.x + ux * (fromRadius + kGraphEdgeGap);
    const double y1 = from.y + uy * (fromRadius + kGraphEdgeGap);
    const double x2 = to.x - ux * (toRadius + kGraphEdgeGap);
    const double y2 = to.y - uy * (toRadius + kGraphEdgeGap);
    std::vector<std::string> heads{arrowHead(x2, y2, ux, uy)};
    if (isMutual) heads.push_back(arrowHead(x1, y1, -ux, -uy));
    return {round1(x1), round1(y1), round1(x2), round1(y2), heads, middle};
}

} // namespace parvane::sections::notes
