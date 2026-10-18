// Parvane fork (spec 029, фаза 4): граф заметок «Знаний» — порт web `notes/notesGraph.ts`. Сборка узлов и связей
// из заметок и записей «Плана», раскладка Fruchterman–Reingold с гравитацией к центру (порциями: startGraphLayout →
// step), место новых узлов рядом с уже разложенными, соседи узла, размер точки, стрелка связи и попадание в узел.
// Генератор с зерном — mulberry32, как в web: те же числа при том же зерне. Без UI, хранилища и сети.
#pragma once

#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace parvane::sections::notes {

enum class GraphNodeKind { Note, Missing, Day, Record };

struct GraphNode {
    // Заметка и ежедневная заметка — id заметки; запись — id первой записи с таким названием;
    // заметка, которой ещё нет, — `missing:<название в нижнем регистре>`
    std::string id;
    std::string title;
    GraphNodeKind kind = GraphNodeKind::Note;
    // Папка заметки или тип записи — по нему выбирается цвет
    std::optional<std::string> group;
    // Число разных соседей
    int degree = 0;
    double x = 0;
    double y = 0;
    bool operator==(const GraphNode &) const = default;
};

// Связь направлена: `from` ссылается на `to`. `isMutual` — есть и обратная ссылка (связь на пару одна)
struct GraphEdge {
    std::string from;
    std::string to;
    bool isMutual = false;
    bool operator==(const GraphEdge &) const = default;
};

struct GraphPoint {
    double x = 0;
    double y = 0;
    bool operator==(const GraphPoint &) const = default;
};

struct GraphNoteInput {
    std::string id;
    std::string title;
    std::string folder;
    // Названия заметок, на которые ссылается эта (`[[ссылки]]`)
    std::vector<std::string> links;
    bool isDaily = false;
};

struct GraphRecordInput {
    std::string id;
    std::string title;
    std::vector<std::string> links;
    // Тип записи (событие, задача…) — попадает в `group` узла
    std::optional<std::string> type;
};

struct GraphInput {
    std::vector<GraphNoteInput> notes;
    std::vector<GraphRecordInput> records;
};

struct GraphOptions {
    bool withDays = false;
    bool withRecords = false;
    // Папки, заметки которых показаны (точное совпадение пути, корень — пустая строка); не задано — все папки.
    // Заметок дней выбор папок не касается: их включает `withDays`
    std::optional<std::vector<std::string>> folders;
};

// Папка в выборе графа: путь и число обычных заметок в ней
struct GraphFolder {
    std::string path;
    int count = 0;
    bool operator==(const GraphFolder &) const = default;
};

struct Graph {
    std::vector<GraphNode> nodes;
    std::vector<GraphEdge> edges;
    bool operator==(const Graph &) const = default;
};

struct GraphLayoutOptions {
    double width = 0;
    double height = 0;
    std::optional<double> iterations;
    std::optional<double> seed;
    // Отступ от краёв области
    std::optional<double> margin;
    // Не сжимать раскладку в область: длина связи остаётся своей, область задаёт только центр
    bool isLoose = false;
};

using GraphPlaces = std::map<std::string, GraphPoint>;

inline const std::string kMissingNodePrefix = "missing:";

// Константы раскладки — из прототипа; при более слабой гравитации граф разлетается
inline constexpr double kGraphSpringLength = 70;
inline constexpr double kGraphGravity = 0.8;
inline constexpr double kGraphAttraction = 0.6;
inline constexpr int kGraphIterations = 400;
inline constexpr double kGraphDefaultSeed = 1;
inline constexpr double kGraphMargin = 24;
// Потолок работы раскладки: число пар узлов × число итераций
inline constexpr double kGraphWorkBudget = 50'000'000;
// Потолок работы расстановки новых узлов: число новых × число остальных × число шагов
inline constexpr double kGraphPlaceWorkBudget = 25'000'000;
// С этого числа узлов отталкивание считается по сетке ячеек
inline constexpr int kGraphGridFrom = 250;
inline constexpr double kGraphRepulsionRange = kGraphSpringLength * 3;
inline constexpr double kGraphMinRadius = 6;
inline constexpr double kGraphMaxRadius = 28;
// Столько шагов новый узел ищет место среди уже разложенных (те стоят на месте)
inline constexpr int kGraphPlaceIterations = 120;
// Сколько пар за один шаг успевает за кадр (~16 мс) и за первый, синхронный, кусок
inline constexpr double kGraphFrameWork = 400'000;
inline constexpr double kGraphSyncWork = 1'500'000;
// Длина наконечника стрелки и зазор между связью и кружком
inline constexpr double kGraphArrow = 7;
inline constexpr double kGraphEdgeGap = 3;

// Заметка видна на графе: заметка дня — при включённых днях, обычная — если её папка выбрана
bool isNoteInGraph(const std::string &folder, bool isDaily, const GraphOptions &options);
// Папки для выбора на графе: те, где есть обычные заметки, корень первым, дальше по пути
std::vector<GraphFolder> listGraphFolders(const std::vector<GraphNoteInput> &notes);
// Сохранённый выбор папок, приведённый к существующим: исчезнувшие выпадают; не осталось ни одной либо выбраны
// все — это «все папки» (std::nullopt)
std::optional<std::vector<std::string>> resolveGraphFolders(
    const std::optional<std::vector<std::string>> &saved, const std::vector<GraphFolder> &known);

// Узлы и связи графа (подробности правил — в web `buildGraph`)
Graph buildGraph(const GraphInput &input, const GraphOptions &options);

// Генератор псевдослучайных чисел с зерном (mulberry32) — те же числа, что у web `createSeededRandom`
class SeededRandom {
public:
    explicit SeededRandom(double seed);
    double next();

private:
    uint32_t state_;
};

// Сколько итераций реально пройдёт раскладка для графа из `nodeCount` узлов
long long getLayoutIterations(long long nodeCount, std::optional<double> requested = std::nullopt, bool isByGrid = false);
// Сколько шагов ищут место `freeCount` новых узлов на графе из `nodeCount`
long long getPlaceIterations(
    long long freeCount, long long nodeCount, std::optional<double> requested = std::nullopt, bool isByGrid = false);

// Раскладка по шагам: `step` считает целые шаги, пока не кончится работа `maxWork` (в парах узлов) или раскладка;
// `nodes()` — копии узлов с текущими местами; `work` — сколько пар пройдено всего
class GraphLayoutRun {
public:
    GraphLayoutRun(const std::vector<GraphNode> &nodes, const std::vector<GraphEdge> &edges,
        const GraphPlaces *previous, const GraphLayoutOptions &options);
    ~GraphLayoutRun();
    GraphLayoutRun(GraphLayoutRun &&) noexcept;
    GraphLayoutRun &operator=(GraphLayoutRun &&) noexcept;

    bool isDone() const;
    double work() const;
    bool step(double maxWork = std::numeric_limits<double>::infinity());
    std::vector<GraphNode> nodes() const;

private:
    struct State;
    std::unique_ptr<State> state_;
};

// Общий движок раскладки. `previous` пуст (nullptr) — полная раскладка; иначе известные узлы стоят, новые ищут место
GraphLayoutRun startGraphLayout(const std::vector<GraphNode> &nodes, const std::vector<GraphEdge> &edges,
    const GraphPlaces *previous, const GraphLayoutOptions &options);
std::vector<GraphNode> layoutGraph(
    const std::vector<GraphNode> &nodes, const std::vector<GraphEdge> &edges, const GraphLayoutOptions &options);
std::vector<GraphNode> placeGraph(const std::vector<GraphNode> &nodes, const std::vector<GraphEdge> &edges,
    const GraphPlaces &previous, const GraphLayoutOptions &options);

// Соседи узла (сам узел не входит) — для подсветки по тапу
std::set<std::string> neighboursOf(const std::string &nodeId, const std::vector<GraphEdge> &edges);
// Радиус точки по числу связей: 6 у одиночки, растёт как корень, не больше 28
double nodeRadius(double degree);
// Узел под точкой поля (ближайший из тех, в чей кружок с запасом `slop` она попала); нет — nullptr
const GraphNode *nodeAt(const std::vector<GraphNode> &nodes, double x, double y, double slop = 0);
// Связь проводят от заметки к заметке — существующей либо той, которой ещё нет
bool canLinkFrom(const GraphNode *node);
bool canLinkTo(const GraphNode *node);

struct EdgeShape {
    double x1 = 0;
    double y1 = 0;
    double x2 = 0;
    double y2 = 0;
    // Путь SVG наконечников: у `to`, при взаимной ссылке — и у `from`
    std::vector<std::string> heads;
    GraphPoint middle;
};

// Линия связи от края кружка до края кружка и наконечники; кружки вплотную — от центра к центру без наконечников
EdgeShape edgeShape(const GraphPoint &from, const GraphPoint &to, double fromRadius, double toRadius,
    bool isMutual = false);

} // namespace parvane::sections::notes
