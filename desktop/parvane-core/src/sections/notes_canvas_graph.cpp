// Parvane fork (spec 029, фаза 4): холст из графа связей «Знаний» — порт web `notes/notesCanvasGraph.ts`.
#include "parvane/sections/notes_canvas_graph.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <set>

#include "notes_text.h"
#include "parvane/sections/notes_canvas_edit.h"
#include "parvane/sections/notes_canvas_files.h"
#include "parvane/sections/notes_folders.h"

namespace parvane::sections::notes {

namespace {

const std::string kFileSuffix = ".md";
const std::string kPairSeparator = std::string("\0", 1);
// Раскладка считается в своих единицах (длина связи 70) на заведомо большом поле — без сжатия
constexpr double kLayoutField = 1'000'000;
// Растяжение раскладки до размера карточек: не больше этого, остаток наложений снимает раздвижка
constexpr double kMaxSpread = 6;
constexpr double kMinOffset = 0.5;
constexpr int kSeparationPasses = 200;
// Новая карточка ищет место вокруг связанных с ней: шаг — половина клетки, не дальше стольких колец
constexpr int kSpotMaxRings = 240;
// Блок несвязанных заметок встаёт под холстом, если холст заметно шире своей высоты, иначе — справа
constexpr double kBlockWideRatio = 2;
// Ряд кластеров папок не шире стольких сторон квадрата той же площади
constexpr double kPackAspect = 1.5;

std::string titleKey(const std::string &title) { return text::toLower(text::trim(title)); }

std::string hex(size_t value) {
    static const char *kDigits = "0123456789abcdef";
    if (value == 0) return "0";
    std::string out;
    while (value) {
        out.insert(out.begin(), kDigits[value % 16]);
        value /= 16;
    }
    return out;
}

std::string uniqueId(std::set<std::string> &used, const CanvasMakeId &makeId, const std::string &prefix = "") {
    std::string id = prefix + makeId();
    for (int attempt = 0; (id == prefix || used.count(id)) && attempt < 16; ++attempt) id = prefix + makeId();
    // Генератор повторяется: номер делает идентификатор своим
    while (id == prefix || used.count(id)) id += hex(used.size());
    used.insert(id);
    return id;
}

std::vector<GraphNoteInput> uniqueNotes(const std::vector<GraphNoteInput> &notes) {
    std::set<std::string> seen;
    std::vector<GraphNoteInput> out;
    for (const auto &note : notes) {
        if (seen.insert(note.id).second) out.push_back(note);
    }
    return out;
}

CanvasNode noteCard(const GraphNoteInput &note, const std::string &id, CanvasPoint at, double width, double height) {
    CanvasNode node;
    node.id = id;
    node.type = "file";
    node.x = at.x;
    node.y = at.y;
    node.width = width;
    node.height = height;
    node.set("file", note.title + kFileSuffix);
    node.set(kGraphNoteField, note.id);
    return node;
}

// Во сколько раз растянуть точки, чтобы прямоугольники с центрами в них не накладывались
double spreadOf(const std::vector<CanvasPoint> &points, double width, double height) {
    double spread = 1;
    for (size_t i = 0; i < points.size(); ++i) {
        for (size_t j = i + 1; j < points.size(); ++j) {
            const double dx = std::max(kMinOffset, std::abs(points[i].x - points[j].x));
            const double dy = std::max(kMinOffset, std::abs(points[i].y - points[j].y));
            spread = std::max(spread, std::min(width / dx, height / dy));
        }
    }
    return std::min(kMaxSpread, spread);
}

// Раздвижка оставшихся наложений: пара расходится по оси, где перекрытие меньше, поровну в обе стороны
void separate(std::vector<CanvasPoint> &points, double width, double height) {
    for (int pass = 0; pass < kSeparationPasses; ++pass) {
        bool hasMoved = false;
        for (size_t i = 0; i < points.size(); ++i) {
            for (size_t j = i + 1; j < points.size(); ++j) {
                auto &a = points[i];
                auto &b = points[j];
                const double overlapX = width - std::abs(a.x - b.x);
                const double overlapY = height - std::abs(a.y - b.y);
                if (overlapX <= 0 || overlapY <= 0) continue;
                hasMoved = true;
                if (overlapX < overlapY) {
                    const double shift = (overlapX / 2) * (a.x <= b.x ? 1 : -1);
                    a.x -= shift;
                    b.x += shift;
                } else {
                    const double shift = (overlapY / 2) * (a.y <= b.y ? 1 : -1);
                    a.y -= shift;
                    b.y += shift;
                }
            }
        }
        if (!hasMoved) return;
    }
}

// Набор без ограничений не хранится
std::optional<GraphCanvasScope> cleanScope(const std::optional<GraphCanvasScope> &scope) {
    if (!scope) return std::nullopt;
    GraphCanvasScope result;
    if (scope->folders) {
        std::vector<std::string> folders;
        for (const auto &folder : *scope->folders) {
            if (std::find(folders.begin(), folders.end(), folder) == folders.end()) folders.push_back(folder);
        }
        std::stable_sort(folders.begin(), folders.end(),
                         [](const std::string &a, const std::string &b) { return canvasjs::utf16Less(a, b); });
        result.folders = folders;
    }
    if (scope->days == false) result.days = false;
    if (!result.folders && !result.days) return std::nullopt;
    return result;
}

CanvasJson scopeJson(const GraphCanvasScope &scope) {
    CanvasJson j = CanvasJson::object();
    if (scope.folders) j["folders"] = *scope.folders;
    if (scope.days) j["days"] = *scope.days;
    return j;
}

CanvasDoc withScope(CanvasDoc doc, const std::optional<GraphCanvasScope> &scope) {
    if (scope) doc.extra[kGraphScopeField] = scopeJson(*scope);
    return doc;
}

bool isInside(const CanvasRect &inner, const CanvasRect &outer) {
    return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height;
}

CanvasRect inflate(const CanvasRect &rect, double byX, double byY) {
    return {rect.x - byX, rect.y - byY, rect.width + byX * 2, rect.height + byY * 2};
}

std::optional<CanvasRect> boundsOfRects(const std::vector<CanvasRect> &rects) {
    if (rects.empty()) return std::nullopt;
    double x = std::numeric_limits<double>::infinity();
    double y = x;
    double right = -x;
    double bottom = -x;
    for (const auto &r : rects) {
        x = std::min(x, r.x);
        y = std::min(y, r.y);
        right = std::max(right, r.x + r.width);
        bottom = std::max(bottom, r.y + r.height);
    }
    return CanvasRect{x, y, right - x, bottom - y};
}

struct Layout {
    std::vector<CanvasPoint> spots;
    double width = 0;
    double height = 0;
};

// Места карточек одного кластера (заметки одной папки): раскладка графа ссылок между ними, растянутая до размера
// карточек. Левый верхний угол кластера — в начале координат
Layout layoutCluster(const std::vector<GraphNoteInput> &notes, double width, double height, double gap, double seed) {
    GraphOptions graphOptions;
    graphOptions.withDays = true;
    graphOptions.withRecords = false;
    const auto graph = buildGraph(GraphInput{notes, {}}, graphOptions);
    GraphLayoutOptions layoutOptions;
    layoutOptions.width = kLayoutField;
    layoutOptions.height = kLayoutField;
    layoutOptions.margin = 0;
    layoutOptions.seed = seed;
    std::vector<CanvasPoint> points;
    for (const auto &node : layoutGraph(graph.nodes, graph.edges, layoutOptions)) points.push_back({node.x, node.y});
    const double spread = spreadOf(points, width + gap, height + gap);
    for (auto &point : points) {
        point.x *= spread;
        point.y *= spread;
    }
    separate(points, width + gap, height + gap);
    double minX = std::numeric_limits<double>::infinity();
    double minY = minX;
    for (const auto &point : points) {
        minX = std::min(minX, point.x);
        minY = std::min(minY, point.y);
    }
    Layout layout;
    double maxX = -std::numeric_limits<double>::infinity();
    double maxY = maxX;
    for (const auto &point : points) {
        const CanvasPoint spot{canvasjs::round(point.x - minX), canvasjs::round(point.y - minY)};
        maxX = std::max(maxX, spot.x);
        maxY = std::max(maxY, spot.y);
        layout.spots.push_back(spot);
    }
    layout.width = maxX + width;
    layout.height = maxY + height;
    return layout;
}

// Места прямоугольников рядами слева направо: ряд не шире `kPackAspect` сторон квадрата общей площади (и не уже
// самого широкого прямоугольника), между соседями — `gap`
std::vector<CanvasPoint> packBoxes(const std::vector<std::pair<double, double>> &boxes, double gap) {
    double area = 0;
    double widest = -std::numeric_limits<double>::infinity();
    for (const auto &[w, h] : boxes) {
        area += (w + gap) * (h + gap);
        widest = std::max(widest, w);
    }
    const double limit = std::max(widest, std::sqrt(area) * kPackAspect);
    double x = 0;
    double y = 0;
    double rowHeight = 0;
    std::vector<CanvasPoint> out;
    for (const auto &[w, h] : boxes) {
        if (x > 0 && x + w > limit) {
            x = 0;
            y += rowHeight + gap;
            rowHeight = 0;
        }
        out.push_back({x, y});
        x += w + gap;
        rowHeight = std::max(rowHeight, h);
    }
    return out;
}

std::string withTitle(const std::string &path, const std::string &title) {
    const auto slash = path.rfind('/');
    return (slash == std::string::npos ? std::string() : path.substr(0, slash + 1)) + title + kFileSuffix;
}

// Ключ названия заметки у карточки файла `.md`; у прочих узлов его нет
std::optional<std::string> cardKey(const CanvasNode &node) {
    if (node.type != "file") return std::nullopt;
    const auto title = noteTitleOfPath(node.str("file"));
    if (!title) return std::nullopt;
    const auto key = titleKey(*title);
    if (key.empty()) return std::nullopt;
    return key;
}

double snapUp(double value) { return std::ceil(value / kCanvasGrid) * kCanvasGrid; }

bool isApart(const CanvasRect &a, const CanvasRect &b, double clearance) {
    return a.x + a.width + clearance <= b.x || b.x + b.width + clearance <= a.x || a.y + a.height + clearance <= b.y
        || b.y + b.height + clearance <= a.y;
}

// Свободное место для карточки рядом с `around`: клетки сетки перебираются кольцами от середины рамки наружу, в
// кольце — от ближних к дальним, при равенстве сначала ниже и правее. Место свободно, если карточка с просветом в
// половину `gap` не задевает ни одного узла, включая группы
// `budget` — общий запас проверок «задевает узел» на весь пересчёт: исчерпан — места нет (карточка уйдёт в блок),
// иначе большой холст считается O(n²·240²) на вызывающем потоке
std::optional<CanvasPoint> findSpot(const CanvasRect &around, const std::vector<CanvasRect> &taken, double width,
                                    double height, double gap, long &budget) {
    const double stepX = snapUp((width + gap) / 2);
    const double stepY = snapUp((height + gap) / 2);
    const double baseX = canvasjs::round((around.x + around.width / 2 - width / 2) / kCanvasGrid) * kCanvasGrid;
    const double baseY = canvasjs::round((around.y + around.height / 2 - height / 2) / kCanvasGrid) * kCanvasGrid;
    const double clearance = gap / 2;
    struct Cell {
        int i;
        int j;
        double distance;
    };
    for (int ring = 0; ring <= kSpotMaxRings; ++ring) {
        std::vector<Cell> cells;
        for (int i = -ring; i <= ring; ++i) {
            for (int j = -ring; j <= ring; ++j) {
                if (std::max(std::abs(i), std::abs(j)) != ring) continue;
                cells.push_back({i, j, std::pow(i * stepX, 2) + std::pow(j * stepY, 2)});
            }
        }
        std::stable_sort(cells.begin(), cells.end(), [](const Cell &a, const Cell &b) {
            if (a.distance != b.distance) return a.distance < b.distance;
            if (a.j != b.j) return a.j > b.j;
            return a.i > b.i;
        });
        for (const auto &cell : cells) {
            const CanvasRect rect{baseX + cell.i * stepX, baseY + cell.j * stepY, width, height};
            budget -= static_cast<long>(taken.size()) + 1;
            if (budget < 0) return std::nullopt;
            const bool isFree = std::all_of(taken.begin(), taken.end(),
                                            [&](const CanvasRect &other) { return isApart(rect, other, clearance); });
            if (isFree) return CanvasPoint{rect.x, rect.y};
        }
    }
    return std::nullopt;
}

// Места блока из `count` карточек вне рамки холста: справа от неё (столбцами в высоту холста) либо, если холст
// заметно шире своей высоты, под ней (рядами в ширину холста)
std::vector<CanvasPoint> blockSpots(size_t count, const CanvasRect &bounds, double width, double height, double gap) {
    std::vector<CanvasPoint> out;
    if (!count) return out;
    const bool isBelow = bounds.width > bounds.height * kBlockWideRatio;
    const double room = isBelow ? std::floor((bounds.width + gap) / (width + gap))
                                : std::floor((bounds.height + gap) / (height + gap));
    const double line = std::min(static_cast<double>(count),
                                 std::max(std::ceil(std::sqrt(static_cast<double>(count))), room));
    const double x0 = isBelow ? snapUp(bounds.x) : snapUp(bounds.x + bounds.width + gap * 2);
    const double y0 = isBelow ? snapUp(bounds.y + bounds.height + gap * 2) : snapUp(bounds.y);
    for (size_t index = 0; index < count; ++index) {
        const double along = std::fmod(static_cast<double>(index), line);
        const double across = std::floor(static_cast<double>(index) / line);
        out.push_back({x0 + (isBelow ? along : across) * (width + gap), y0 + (isBelow ? across : along) * (height + gap)});
    }
    return out;
}

void setOrErase(CanvasEdge &edge, const std::string &key, const CanvasJson *value) {
    if (value) edge.set(key, *value);
    else edge.erase(key);
}

bool isArrowFrom(const CanvasEdge &edge) { return edge.str("fromEnd") == std::optional<std::string>("arrow"); }

} // namespace

std::optional<GraphCanvasScope> scopeOfCanvas(const CanvasDoc &doc) {
    const auto it = doc.extra.find(kGraphScopeField);
    if (it == doc.extra.end() || !it->is_object()) return std::nullopt;
    GraphCanvasScope raw;
    if (const auto folders = it->find("folders"); folders != it->end() && folders->is_array()) {
        std::vector<std::string> list;
        for (const auto &item : *folders) {
            if (item.is_string()) list.push_back(item.get<std::string>());
        }
        raw.folders = list;
    }
    if (const auto days = it->find("days"); days != it->end() && days->is_boolean() && !days->get<bool>()) {
        raw.days = false;
    }
    return cleanScope(raw);
}

bool isInCanvasScope(const std::string &folder, bool isDaily, const std::optional<GraphCanvasScope> &scope) {
    if (!scope) return true;
    if (isDaily) return scope->days != false;
    return !scope->folders || std::find(scope->folders->begin(), scope->folders->end(), folder) != scope->folders->end();
}

CanvasDoc canvasFromGraph(const std::vector<GraphNoteInput> &notes, const GraphCanvasOptions &options) {
    const double width = options.cardWidth.value_or(kCanvasDefaultNodeWidth);
    const double height = options.cardHeight.value_or(kGraphCanvasCardHeight);
    const double gap = options.gap.value_or(kGraphCanvasGap);
    const CanvasMakeId makeId = options.makeId ? options.makeId : CanvasMakeId([] { return newCanvasId(); });
    const auto scope = cleanScope(options.scope);
    const auto labelOf = options.folderLabel ? options.folderLabel : std::function<std::string(const std::string &)>(folderCaption);
    const double seed = options.seed.value_or(kGraphDefaultSeed);

    std::vector<GraphNoteInput> shown;
    for (auto &note : uniqueNotes(notes)) {
        if (isInCanvasScope(note.folder, note.isDaily, scope)) shown.push_back(std::move(note));
    }
    if (shown.empty()) return withScope(CanvasDoc{}, scope);

    std::map<std::string, std::string> noteIdByTitle;
    for (const auto &note : shown) {
        const auto key = titleKey(note.title);
        if (!key.empty()) noteIdByTitle.emplace(key, note.id);
    }
    // Только ссылки на существующие заметки: узлов «ещё нет» на холсте не бывает
    std::vector<GraphNoteInput> linked;
    for (const auto &note : shown) {
        GraphNoteInput copy = note;
        copy.isDaily = false;
        copy.links.clear();
        for (const auto &link : note.links) {
            if (noteIdByTitle.count(titleKey(link))) copy.links.push_back(link);
        }
        linked.push_back(std::move(copy));
    }

    // Кластеры: заметки без папки, затем папки по пути
    std::map<std::string, std::vector<size_t>> byFolder;
    std::vector<std::string> folders;
    for (size_t i = 0; i < linked.size(); ++i) {
        if (!byFolder.count(linked[i].folder)) folders.push_back(linked[i].folder);
        byFolder[linked[i].folder].push_back(i);
    }
    std::stable_sort(folders.begin(), folders.end(),
                     [](const std::string &a, const std::string &b) { return canvasjs::utf16Less(a, b); });
    struct Cluster {
        std::string folder;
        std::vector<size_t> indexes;
        Layout layout;
        double pad = 0;
        double head = 0;
        double width = 0;
        double height = 0;
    };
    std::vector<Cluster> clusters;
    for (const auto &folder : folders) {
        Cluster cluster;
        cluster.folder = folder;
        cluster.indexes = byFolder[folder];
        std::set<std::string> ids;
        for (size_t i : cluster.indexes) ids.insert(linked[i].id);
        // Внутри кластера раскладку тянут только ссылки между его заметками
        std::vector<GraphNoteInput> inner;
        for (size_t i : cluster.indexes) {
            GraphNoteInput copy = linked[i];
            copy.links.clear();
            for (const auto &link : linked[i].links) {
                if (ids.count(noteIdByTitle.at(titleKey(link)))) copy.links.push_back(link);
            }
            inner.push_back(std::move(copy));
        }
        cluster.layout = layoutCluster(inner, width, height, gap, seed);
        cluster.pad = folder == kRootFolder ? 0 : kCanvasGroupPadding;
        cluster.head = folder == kRootFolder ? 0 : kGraphGroupHead;
        cluster.width = cluster.layout.width + cluster.pad * 2;
        cluster.height = cluster.layout.height + cluster.pad * 2 + cluster.head;
        clusters.push_back(std::move(cluster));
    }
    std::vector<std::pair<double, double>> boxes;
    for (const auto &cluster : clusters) boxes.emplace_back(cluster.width, cluster.height);
    const auto places = packBoxes(boxes, gap);
    // Верх холста — верх карточек и рамок: шапка первой группы в счёт не идёт
    double top = std::numeric_limits<double>::infinity();
    for (size_t c = 0; c < clusters.size(); ++c) top = std::min(top, places[c].y + clusters[c].head);

    std::vector<CanvasPoint> spots(shown.size());
    for (size_t c = 0; c < clusters.size(); ++c) {
        const auto &cluster = clusters[c];
        for (size_t k = 0; k < cluster.indexes.size(); ++k) {
            spots[cluster.indexes[k]] = {places[c].x + cluster.pad + cluster.layout.spots[k].x,
                                         places[c].y + cluster.head + cluster.pad + cluster.layout.spots[k].y - top};
        }
    }

    std::set<std::string> usedIds;
    std::map<std::string, std::string> cardIdByNote;
    std::vector<CanvasNode> cards;
    for (size_t i = 0; i < shown.size(); ++i) {
        const auto id = uniqueId(usedIds, makeId);
        cardIdByNote[shown[i].id] = id;
        cards.push_back(noteCard(shown[i], id, spots[i], width, height));
    }

    // Взаимные ссылки — одна стрелка с наконечниками с обеих сторон, а не две встречные поверх друг друга
    std::vector<CanvasEdge> edges;
    std::map<std::string, size_t> edgeByKey;
    for (const auto &note : linked) {
        for (const auto &link : note.links) {
            const auto &targetId = noteIdByTitle.at(titleKey(link));
            const auto key = note.id + kPairSeparator + targetId;
            if (targetId == note.id || edgeByKey.count(key)) continue;
            if (const auto reverse = edgeByKey.find(targetId + kPairSeparator + note.id); reverse != edgeByKey.end()) {
                edges[reverse->second].set("fromEnd", "arrow");
                edgeByKey[key] = reverse->second;
                continue;
            }
            CanvasEdge edge;
            edge.id = uniqueId(usedIds, makeId, kGraphEdgePrefix);
            edge.fromNode = cardIdByNote.at(note.id);
            edge.toNode = cardIdByNote.at(targetId);
            edgeByKey[key] = edges.size();
            edges.push_back(std::move(edge));
        }
    }

    std::vector<CanvasNode> nodes;
    for (size_t c = 0; c < clusters.size(); ++c) {
        const auto &cluster = clusters[c];
        if (cluster.folder == kRootFolder) continue;
        CanvasNode group;
        group.id = uniqueId(usedIds, makeId);
        group.type = "group";
        group.x = places[c].x;
        group.y = places[c].y + cluster.head - top;
        group.width = cluster.width;
        group.height = cluster.height - cluster.head;
        group.set("label", labelOf(cluster.folder));
        group.set(kGraphFolderField, cluster.folder);
        nodes.push_back(std::move(group));
    }
    nodes.insert(nodes.end(), cards.begin(), cards.end());
    CanvasDoc doc;
    doc.nodes = std::move(nodes);
    doc.edges = std::move(edges);
    return withScope(std::move(doc), scope);
}

bool isGraphEdge(const CanvasEdge &edge) { return text::startsWith(edge.id, kGraphEdgePrefix); }

bool isCustomizedEdge(const CanvasEdge &edge) {
    for (auto it = edge.fields.begin(); it != edge.fields.end(); ++it) {
        const auto &key = it.key();
        const auto &value = it.value();
        if (key == "id" || key == "fromNode" || key == "toNode") continue;
        if (key == "label") {
            if (!(value.is_string() && value.get<std::string>().empty())) return true;
            continue;
        }
        if (key == "toEnd") {
            if (!(value.is_string() && value.get<std::string>() == "arrow")) return true;
            continue;
        }
        // Наконечник в начале у своей стрелки — знак взаимной ссылки, а не правка
        if (key == "fromEnd") {
            const bool isPlain = value.is_string() && (value.get<std::string>() == "none" || value.get<std::string>() == "arrow");
            if (!isPlain) return true;
            continue;
        }
        return true;
    }
    return false;
}

CanvasDoc renameCanvasNote(const CanvasDoc &doc, const std::string &oldTitle, const std::string &newTitle) {
    const auto oldKey = titleKey(oldTitle);
    if (oldKey.empty() || text::trim(newTitle).empty()) return doc;
    const bool hasCard = std::any_of(doc.nodes.begin(), doc.nodes.end(),
                                     [&](const CanvasNode &node) { return cardKey(node) == oldKey; });
    if (!hasCard) return doc;
    CanvasDoc next = doc;
    for (auto &node : next.nodes) {
        if (cardKey(node) == oldKey) node.set("file", withTitle(*node.str("file"), newTitle));
    }
    return next;
}

CanvasDoc renameCanvasFolder(const CanvasDoc &doc, const std::string &oldPath, const std::string &newPath) {
    if (oldPath.empty() || newPath.empty() || oldPath == newPath) return doc;
    const auto moved = [&](const std::string &path) {
        return isInFolder(path, oldPath) ? newPath + path.substr(oldPath.size()) : path;
    };
    bool isChanged = false;
    CanvasDoc next = doc;
    for (auto &node : next.nodes) {
        const auto folder = node.str(kGraphFolderField);
        if (node.type != "group" || !folder || moved(*folder) == *folder) continue;
        isChanged = true;
        const auto target = moved(*folder);
        node.set(kGraphFolderField, target);
        if (node.str("label") == std::optional<std::string>(folderCaption(*folder))) node.set("label", folderCaption(target));
    }
    const auto scope = scopeOfCanvas(doc);
    std::optional<std::vector<std::string>> folders;
    bool isScopeChanged = false;
    if (scope && scope->folders) {
        folders.emplace();
        for (const auto &path : *scope->folders) {
            folders->push_back(moved(path));
            if (folders->back() != path) isScopeChanged = true;
        }
    }
    if (!isChanged && !isScopeChanged) return doc;
    if (!isScopeChanged) return next;
    GraphCanvasScope updated = *scope;
    updated.folders = folders;
    return withScope(std::move(next), cleanScope(updated));
}

GraphRefreshResult refreshCanvasFromGraph(const CanvasDoc &doc, const std::vector<GraphNoteInput> &notes,
                                          const GraphCanvasOptions &options) {
    const double width = options.cardWidth.value_or(kCanvasDefaultNodeWidth);
    const double height = options.cardHeight.value_or(kGraphCanvasCardHeight);
    const double gap = options.gap.value_or(kGraphCanvasGap);
    const CanvasMakeId makeId = options.makeId ? options.makeId : CanvasMakeId([] { return newCanvasId(); });
    GraphRefreshResult result;
    result.doc = doc;
    // Заметка без названия карточкой не находится — она бы добавлялась при каждом обновлении
    std::vector<GraphNoteInput> shown;
    for (auto &note : uniqueNotes(notes)) {
        if (!titleKey(note.title).empty()) shown.push_back(std::move(note));
    }
    const auto scope = scopeOfCanvas(doc);

    if (doc.nodes.empty() && doc.edges.empty()) {
        GraphCanvasOptions built = options;
        built.scope = scope;
        const auto filled = canvasFromGraph(shown, built);
        if (filled.nodes.empty()) return result;
        result.doc.nodes = filled.nodes;
        result.doc.edges = filled.edges;
        result.changed = true;
        for (const auto &node : filled.nodes) {
            if (node.type != "group") result.addedCards.push_back(node.id);
        }
        for (const auto &edge : filled.edges) result.addedEdges.push_back(edge.id);
        return result;
    }

    std::map<std::string, const GraphNoteInput *> noteById;
    std::map<std::string, std::vector<const GraphNoteInput *>> notesByKey;
    for (const auto &note : shown) {
        noteById.emplace(note.id, &note);
        notesByKey[titleKey(note.title)].push_back(&note);
    }

    // Карточка пропавшей заметки, знающая её идентификатор, идёт за переименованной заметкой
    std::vector<CanvasNode> nodes;
    for (const auto &node : doc.nodes) {
        const auto key = cardKey(node);
        const auto noteId = node.str(kGraphNoteField);
        const GraphNoteInput *renamedNote = nullptr;
        if (key && !notesByKey.count(*key) && noteId) {
            const auto it = noteById.find(*noteId);
            if (it != noteById.end()) renamedNote = it->second;
        }
        if (!renamedNote) {
            nodes.push_back(node);
            continue;
        }
        result.renamedCards.push_back(node.id);
        CanvasNode copy = node;
        copy.set("file", withTitle(*node.str("file"), renamedNote->title));
        nodes.push_back(std::move(copy));
    }

    // Карточки по названию заметки, в порядке слоёв: k-я карточка названия — k-я заметка с этим названием, лишние
    // карточки (копии) относятся к последней
    std::map<std::string, size_t> cardCounts;
    std::map<std::string, const GraphNoteInput *> noteOfCard;
    std::map<std::string, CanvasRect> cardOfNote;
    std::map<std::string, std::string> cardIdOfNote;
    for (const auto &node : nodes) {
        const auto key = cardKey(node);
        if (!key) continue;
        const auto sameTitle = notesByKey.find(*key);
        if (sameTitle == notesByKey.end()) {
            result.missingCards.push_back(node.id);
            continue;
        }
        const size_t index = cardCounts[*key]++;
        const auto *note = sameTitle->second[std::min(index, sameTitle->second.size() - 1)];
        noteOfCard[node.id] = note;
        if (!cardOfNote.count(note->id)) {
            cardOfNote[note->id] = node.rect();
            cardIdOfNote[note->id] = node.id;
        }
    }

    long spotBudget = 20000000; // запас проверок на все findSpot этого пересчёта

    // Ссылки между существующими заметками: название ведёт к первой заметке с ним
    std::map<std::string, std::vector<std::string>> links;
    std::map<std::string, std::set<std::string>> neighbours;
    for (const auto &note : shown) {
        std::vector<std::string> targets;
        for (const auto &link : note.links) {
            const auto it = notesByKey.find(titleKey(link));
            if (it == notesByKey.end()) continue;
            const auto *target = it->second[0];
            if (target->id == note.id || std::find(targets.begin(), targets.end(), target->id) != targets.end()) continue;
            targets.push_back(target->id);
            neighbours[note.id].insert(target->id);
            neighbours[target->id].insert(note.id);
        }
        links[note.id] = targets;
    }

    // ── недостающие карточки ──
    std::set<std::string> usedIds;
    for (const auto &node : doc.nodes) usedIds.insert(node.id);
    for (const auto &edge : doc.edges) usedIds.insert(edge.id);
    std::vector<CanvasNode> taken = nodes;
    std::vector<std::string> addedCardIds;
    const auto place = [&](const GraphNoteInput *note, CanvasPoint at) {
        auto card = noteCard(*note, uniqueId(usedIds, makeId), at, width, height);
        addedCardIds.push_back(card.id);
        cardOfNote[note->id] = card.rect();
        cardIdOfNote[note->id] = card.id;
        noteOfCard[card.id] = note;
        taken.push_back(std::move(card));
    };
    std::vector<const GraphNoteInput *> pending;
    for (const auto &note : shown) {
        if (!cardOfNote.count(note.id) && isInCanvasScope(note.folder, note.isDaily, scope)) pending.push_back(&note);
    }
    const auto nearRects = [&](const GraphNoteInput *note, const std::set<std::string> *onlyIds) {
        std::vector<CanvasRect> near;
        const auto it = neighbours.find(note->id);
        if (it == neighbours.end()) return near;
        for (const auto &id : it->second) {
            const auto card = cardOfNote.find(id);
            if (card == cardOfNote.end()) continue;
            if (onlyIds && !onlyIds->count(cardIdOfNote.at(id))) continue;
            near.push_back(card->second);
        }
        return near;
    };

    // Сначала заметки папок, у которых на холсте есть группа: карточка встаёт в группу, рамка растёт за ней
    std::map<std::string, std::string> groupOfFolder;
    for (const auto &node : nodes) {
        const auto folder = node.str(kGraphFolderField);
        if (node.type == "group" && folder && !groupOfFolder.count(*folder)) groupOfFolder[*folder] = node.id;
    }
    const double apart = kCanvasGroupPadding + kGraphGroupHead;
    {
        std::vector<const GraphNoteInput *> rest;
        for (const auto *note : pending) {
            const auto group = groupOfFolder.find(note->folder);
            std::optional<size_t> at;
            if (group != groupOfFolder.end()) {
                for (size_t i = 0; i < taken.size(); ++i) {
                    if (taken[i].id == group->second) {
                        at = i;
                        break;
                    }
                }
            }
            if (!at) {
                rest.push_back(note);
                continue;
            }
            const CanvasRect frame = taken[*at].rect();
            std::set<std::string> inside;
            for (size_t i = 0; i < taken.size(); ++i) {
                if (i != *at && isInside(taken[i].rect(), frame)) inside.insert(taken[i].id);
            }
            const auto near = nearRects(note, &inside);
            // Чужое вокруг отодвинуто на поле и шапку группы: выросшая рамка его не заденет
            std::vector<CanvasRect> others;
            for (size_t i = 0; i < taken.size(); ++i) {
                if (i == *at || isInside(frame, taken[i].rect())) continue;
                others.push_back(inside.count(taken[i].id) ? taken[i].rect()
                                                           : inflate(taken[i].rect(), kCanvasGroupPadding, apart));
            }
            const auto spot = findSpot(boundsOfRects(near).value_or(frame), others, width, height, gap, spotBudget);
            if (!spot) {
                rest.push_back(note);
                continue;
            }
            place(note, *spot);
            const auto room = inflate({spot->x, spot->y, width, height}, kCanvasGroupPadding, kCanvasGroupPadding);
            if (!isInside(room, frame)) {
                auto &grown = taken[*at];
                const double x = std::min(frame.x, room.x);
                const double y = std::min(frame.y, room.y);
                grown.x = x;
                grown.y = y;
                grown.width = std::max(frame.x + frame.width, room.x + room.width) - x;
                grown.height = std::max(frame.y + frame.height, room.y + room.height) - y;
            }
        }
        pending = rest;
    }
    // Сначала те, у кого на холсте уже есть связанная карточка; поставленная карточка сама становится опорой
    for (bool hasPlaced = true; hasPlaced && !pending.empty();) {
        hasPlaced = false;
        std::vector<const GraphNoteInput *> rest;
        for (const auto *note : pending) {
            const auto around = boundsOfRects(nearRects(note, nullptr));
            std::optional<CanvasPoint> spot;
            if (around) {
                std::vector<CanvasRect> rects;
                for (const auto &node : taken) rects.push_back(node.rect());
                spot = findSpot(*around, rects, width, height, gap, spotBudget);
            }
            if (!spot) {
                rest.push_back(note);
                continue;
            }
            place(note, *spot);
            hasPlaced = true;
        }
        pending = rest;
    }
    std::vector<CanvasRect> takenRects;
    for (const auto &node : taken) takenRects.push_back(node.rect());
    const auto bounds = boundsOfRects(takenRects).value_or(CanvasRect{0, 0, -gap * 2, 0});
    const auto block = blockSpots(pending.size(), bounds, width, height, gap);
    for (size_t i = 0; i < block.size(); ++i) place(pending[i], block[i]);
    result.addedCards = addedCardIds;

    // ── стрелки ──
    std::map<std::string, const CanvasNode *> nodeById;
    for (const auto &node : taken) nodeById.emplace(node.id, &node);
    const auto noteOf = [&](const std::string &cardId) -> const GraphNoteInput * {
        const auto it = noteOfCard.find(cardId);
        return it == noteOfCard.end() ? nullptr : it->second;
    };
    const auto linksTo = [&](const std::string &sourceCard, const std::string &targetCard) {
        const auto *source = noteOf(sourceCard);
        const auto target = nodeById.find(targetCard);
        if (!source || target == nodeById.end()) return false;
        const auto targetKey = cardKey(*target->second);
        if (!targetKey) return false;
        return std::any_of(source->links.begin(), source->links.end(),
                           [&](const std::string &link) { return titleKey(link) == *targetKey; });
    };
    const auto isOwnEdge = [](const CanvasEdge &edge) { return isGraphEdge(edge) && !isCustomizedEdge(edge); };
    bool hasEdgeChanges = false;
    std::vector<CanvasEdge> edges;
    for (const auto &edge : doc.edges) {
        if (!isOwnEdge(edge) || !noteOf(edge.fromNode) || !nodeById.count(edge.toNode)) {
            edges.push_back(edge);
            continue;
        }
        const bool isForward = linksTo(edge.fromNode, edge.toNode);
        // Ссылки пропавшей заметки неизвестны — её сторона двусторонней стрелки остаётся
        const bool isTargetKnown = noteOf(edge.toNode) != nullptr;
        const bool isBackward = isArrowFrom(edge) && (!isTargetKnown || linksTo(edge.toNode, edge.fromNode));
        if (isForward && (isBackward || !isArrowFrom(edge))) {
            edges.push_back(edge);
        } else if (isForward) {
            // Обратной ссылки больше нет — наконечник в начале снимается
            CanvasEdge copy = edge;
            copy.erase("fromEnd");
            edges.push_back(std::move(copy));
            hasEdgeChanges = true;
        } else if (isBackward) {
            CanvasEdge copy = edge;
            copy.fromNode = edge.toNode;
            copy.toNode = edge.fromNode;
            setOrErase(copy, "fromSide", edge.get("toSide"));
            setOrErase(copy, "toSide", edge.get("fromSide"));
            copy.erase("fromEnd");
            edges.push_back(std::move(copy));
            hasEdgeChanges = true;
        } else {
            result.removedEdges.push_back(edge.id);
        }
    }
    // Встречные свои стрелки прежних холстов сливаются в одну двустороннюю. Пара — по заметкам, а не по карточкам
    const auto notePair = [&](const std::string &from, const std::string &to) -> std::optional<std::string> {
        const auto *source = noteOf(from);
        const auto *target = noteOf(to);
        if (!source || !target) return std::nullopt;
        return source->id + kPairSeparator + target->id;
    };
    std::map<std::string, size_t> ownByPair;
    std::vector<CanvasEdge> merged;
    for (const auto &edge : edges) {
        const auto pair = notePair(edge.fromNode, edge.toNode);
        const auto reversePair = notePair(edge.toNode, edge.fromNode);
        if (!isOwnEdge(edge) || !pair || !reversePair) {
            merged.push_back(edge);
            continue;
        }
        if (const auto reverseAt = ownByPair.find(*reversePair); reverseAt != ownByPair.end()) {
            if (!isArrowFrom(merged[reverseAt->second])) merged[reverseAt->second].set("fromEnd", "arrow");
            result.removedEdges.push_back(edge.id);
            continue;
        }
        ownByPair[*pair] = merged.size();
        merged.push_back(edge);
    }
    std::set<std::string> pairs;
    for (const auto &edge : merged) {
        if (const auto pair = notePair(edge.fromNode, edge.toNode)) pairs.insert(*pair);
        const auto reversePair = notePair(edge.toNode, edge.fromNode);
        if (reversePair && isArrowFrom(edge)) pairs.insert(*reversePair);
    }
    std::vector<CanvasEdge> addedEdges;
    for (const auto &note : shown) {
        for (const auto &targetId : links.at(note.id)) {
            const auto pair = note.id + kPairSeparator + targetId;
            const auto from = cardIdOfNote.find(note.id);
            const auto to = cardIdOfNote.find(targetId);
            if (from == cardIdOfNote.end() || to == cardIdOfNote.end() || pairs.count(pair)) continue;
            pairs.insert(pair);
            // Есть своя встречная стрелка — она становится двусторонней
            if (const auto reverseAt = ownByPair.find(targetId + kPairSeparator + note.id); reverseAt != ownByPair.end()) {
                merged[reverseAt->second].set("fromEnd", "arrow");
                hasEdgeChanges = true;
                continue;
            }
            const auto reverseAdded = std::find_if(addedEdges.begin(), addedEdges.end(), [&](const CanvasEdge &edge) {
                return edge.fromNode == to->second && edge.toNode == from->second;
            });
            if (reverseAdded != addedEdges.end()) {
                reverseAdded->set("fromEnd", "arrow");
                continue;
            }
            CanvasEdge edge;
            edge.id = uniqueId(usedIds, makeId, kGraphEdgePrefix);
            edge.fromNode = from->second;
            edge.toNode = to->second;
            addedEdges.push_back(std::move(edge));
        }
    }
    for (const auto &edge : addedEdges) result.addedEdges.push_back(edge.id);

    const bool hasChanged = !result.renamedCards.empty() || !addedCardIds.empty() || !addedEdges.empty()
        || !result.removedEdges.empty() || hasEdgeChanges;
    if (hasChanged) {
        result.changed = true;
        result.doc.nodes = taken;
        result.doc.edges = merged;
        result.doc.edges.insert(result.doc.edges.end(), addedEdges.begin(), addedEdges.end());
    }
    return result;
}

std::string freeCanvasTitle(const std::string &base, const std::vector<std::string> &taken) {
    std::set<std::string> used;
    for (const auto &title : taken) used.insert(titleKey(title));
    if (!used.count(titleKey(base))) return base;
    for (int n = 2;; ++n) {
        const auto candidate = base + " " + std::to_string(n);
        if (!used.count(titleKey(candidate))) return candidate;
    }
}

} // namespace parvane::sections::notes
