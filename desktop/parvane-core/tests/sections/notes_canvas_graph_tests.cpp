// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesCanvasGraph.test.ts`. «Тот же объект» (`toBe`)
// проверяется равенством значений и флагом `changed` сверки.
#include <algorithm>
#include <memory>
#include <set>

#include "notes_test_util.h"
#include "parvane/sections/notes_canvas_graph.h"

using namespace parvane::sections::notes;

struct NoteOpts {
    std::string id;
    std::string folder;
    bool isDaily = false;
};

static GraphNoteInput note(const std::string &title, std::vector<std::string> links = {}, NoteOpts opts = {}) {
    GraphNoteInput n;
    n.id = opts.id.empty() ? "id-" + title : opts.id;
    n.title = title;
    n.folder = opts.folder;
    n.links = std::move(links);
    n.isDaily = opts.isDaily;
    return n;
}

static NoteOpts byId(const std::string &id) {
    NoteOpts opts;
    opts.id = id;
    return opts;
}

static CanvasMakeId counter() {
    auto n = std::make_shared<int>(0);
    return [n] {
        char buf[32];
        std::snprintf(buf, sizeof buf, "%016x", ++*n);
        return std::string(buf);
    };
}

static GraphCanvasOptions withIds(GraphCanvasOptions o = {}) {
    o.makeId = counter();
    return o;
}

static CanvasNode node(const std::string &id, const std::string &type, double x, double y, double w, double h,
                       const CanvasJson &fields = CanvasJson::object()) {
    CanvasNode n;
    n.id = id;
    n.type = type;
    n.x = x;
    n.y = y;
    n.width = w;
    n.height = h;
    for (auto it = fields.begin(); it != fields.end(); ++it) n.set(it.key(), it.value());
    return n;
}

static CanvasEdge edge(const std::string &id, const std::string &from, const std::string &to,
                       const CanvasJson &fields = CanvasJson::object()) {
    CanvasEdge e;
    e.id = id;
    e.fromNode = from;
    e.toNode = to;
    for (auto it = fields.begin(); it != fields.end(); ++it) e.set(it.key(), it.value());
    return e;
}

static int overlaps(const std::vector<CanvasNode> &nodes, double gap = 0) {
    int count = 0;
    for (size_t i = 0; i < nodes.size(); ++i) {
        for (size_t j = i + 1; j < nodes.size(); ++j) {
            const auto &a = nodes[i];
            const auto &b = nodes[j];
            const bool apartX = a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x;
            const bool apartY = a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y;
            if (!apartX && !apartY) ++count;
        }
    }
    return count;
}

static std::vector<CanvasNode> groupsOf(const CanvasDoc &doc) {
    std::vector<CanvasNode> out;
    for (const auto &n : doc.nodes) {
        if (n.type == "group") out.push_back(n);
    }
    return out;
}

static std::vector<CanvasNode> cardsOf(const CanvasDoc &doc) {
    std::vector<CanvasNode> out;
    for (const auto &n : doc.nodes) {
        if (n.type == "file") out.push_back(n);
    }
    return out;
}

static bool contains(const CanvasNode &outer, const CanvasNode &inner) {
    return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height;
}

static std::string fileOf(const CanvasNode &n) { return n.str("file").value_or("<нет>"); }

static std::vector<std::string> filesIn(const CanvasDoc &doc, const CanvasNode &group) {
    std::vector<std::string> out;
    for (const auto &n : cardsOf(doc)) {
        if (contains(group, n)) out.push_back(fileOf(n));
    }
    std::sort(out.begin(), out.end());
    return out;
}

static std::string fileById(const CanvasDoc &doc, const std::string &id) {
    for (const auto &n : doc.nodes) {
        if (n.id == id) return fileOf(n);
    }
    return "<нет>";
}

static std::vector<std::string> filesOf(const CanvasDoc &doc, const std::vector<std::string> &ids) {
    std::vector<std::string> out;
    for (const auto &id : ids) out.push_back(fileById(doc, id));
    return out;
}

static std::vector<std::string> edgeTitles(const CanvasDoc &doc) {
    std::vector<std::string> out;
    for (const auto &e : doc.edges) out.push_back(fileById(doc, e.fromNode) + " → " + fileById(doc, e.toNode));
    return out;
}

static std::vector<std::string> sorted(std::vector<std::string> v) {
    std::sort(v.begin(), v.end());
    return v;
}

static bool has(const std::vector<std::string> &v, const std::string &s) { return std::find(v.begin(), v.end(), s) != v.end(); }

static std::vector<CanvasNode> withHead(const std::vector<CanvasNode> &groups) {
    auto out = groups;
    for (auto &g : out) {
        g.y -= kGraphGroupHead;
        g.height += kGraphGroupHead;
    }
    return out;
}

static double minOf(const std::vector<CanvasNode> &nodes, bool isX) {
    double m = 1e18;
    for (const auto &n : nodes) m = std::min(m, isX ? n.x : n.y);
    return m;
}

static GraphCanvasScope scopeOf(std::optional<std::vector<std::string>> folders, std::optional<bool> days = std::nullopt) {
    return GraphCanvasScope{std::move(folders), days};
}

static void testCanvasFromGraph() {
    std::printf("canvasFromGraph\n");
    check(canvasFromGraph({}) == CanvasDoc{}, "пустой список заметок — пустой холст");
    {
        const auto doc = canvasFromGraph({note("Сервер", {"Курс", "Блок питания"}), note("Курс", {"Сервер"}),
                                          note("Блок питания"), note("Одна")},
                                         withIds());
        std::vector<std::string> files;
        bool allFiles = true;
        for (const auto &n : doc.nodes) {
            files.push_back(fileOf(n));
            allFiles = allFiles && n.type == "file";
        }
        check(allFiles && files == std::vector<std::string>{"Сервер.md", "Курс.md", "Блок питания.md", "Одна.md"},
              "карточка на каждую заметку в порядке входа");
        check(edgeTitles(doc) == std::vector<std::string>{"Сервер.md → Курс.md", "Сервер.md → Блок питания.md"},
              "стрелка на каждую ссылку, взаимная — одна");
        check(doc.edges[0].str("fromEnd") == std::optional<std::string>("arrow") && !doc.edges[1].has("fromEnd"),
              "взаимная ссылка — наконечники с обеих сторон");
    }
    {
        const auto doc = canvasFromGraph({note("A", {"b", "B", " b ", "A", "Нет такой"}), note("B")}, withIds());
        check(doc.nodes.size() == 2 && edgeTitles(doc) == std::vector<std::string>{"A.md → B.md"},
              "ссылки на несуществующую заметку, на себя и повторные стрелок не дают; регистр названия не важен");
    }
    {
        const auto doc = canvasFromGraph({note("2026-10-12", {"План"}, {"", "", true}), note("План", {}, byId("first")),
                                          note("План", {}, {"second", "Архив"}), note("План", {}, byId("first"))},
                                         withIds());
        const auto cards = cardsOf(doc);
        check(cards.size() == 3 && doc.edges.size() == 1 && doc.edges[0].toNode == cards[1].id,
              "ежедневные заметки тоже получают карточки, одноимённые — по карточке, ссылка ведёт к первой");
    }
    {
        std::vector<std::string> titles;
        for (int i = 0; i < 40; ++i) titles.push_back("Заметка " + std::to_string(i));
        std::vector<GraphNoteInput> notes;
        for (int i = 0; i < 40; ++i) {
            std::vector<std::string> links;
            if (i < 12) links.push_back("Заметка 0");
            if (i >= 12 && i < 24) links.push_back(titles[i - 1]);
            if (i >= 24 && i < 32) links.insert(links.end(), titles.begin() + 24, titles.begin() + 32);
            notes.push_back(note(titles[i], links));
        }
        const auto doc = canvasFromGraph(notes, withIds());
        bool sizes = doc.nodes.size() == 40;
        for (const auto &n : doc.nodes) sizes = sizes && n.width == 250 && n.height == kGraphCanvasCardHeight;
        check(sizes, "карточки настоящего размера");
        check(overlaps(doc.nodes) == 0, "карточки не накладываются");
        check(overlaps(doc.nodes, kGraphCanvasGap - 2) == 0, "карточки стоят с просветом");
        check(minOf(doc.nodes, true) == 0 && minOf(doc.nodes, false) == 0, "левый верхний угол холста — в начале координат");
    }
    {
        std::vector<GraphNoteInput> notes;
        for (int i = 0; i < 9; ++i) notes.push_back(note("N" + std::to_string(i)));
        check(overlaps(canvasFromGraph(notes, withIds()).nodes) == 0, "заметки без единой ссылки тоже расходятся");
    }
    {
        GraphCanvasOptions o = withIds();
        o.cardWidth = 400;
        o.cardHeight = 300;
        o.gap = 100;
        const auto doc = canvasFromGraph({note("A", {"B"}), note("B", {"C"}), note("C")}, o);
        bool sizes = true;
        for (const auto &n : doc.nodes) sizes = sizes && n.width == 400 && n.height == 300;
        check(sizes && overlaps(doc.nodes, 98) == 0, "свой размер карточки и просвет учитываются");
    }
    {
        const std::vector<GraphNoteInput> notes = {note("A", {"B", "C"}), note("B", {"C"}), note("C", {"A"})};
        const auto first = canvasFromGraph(notes, withIds());
        check(canvasFromGraph(notes, withIds()) == first, "один вход и одно зерно — один результат");
        std::set<std::string> ids;
        for (const auto &n : first.nodes) ids.insert(n.id);
        for (const auto &e : first.edges) ids.insert(e.id);
        check(ids.size() == first.nodes.size() + first.edges.size(), "идентификаторы не повторяются");
        GraphCanvasOptions stuckOptions;
        stuckOptions.makeId = [] { return std::string("same"); };
        const auto stuck = canvasFromGraph(notes, stuckOptions);
        std::set<std::string> stuckIds;
        for (const auto &n : stuck.nodes) stuckIds.insert(n.id);
        for (const auto &e : stuck.edges) stuckIds.insert(e.id);
        check(stuckIds.size() == stuck.nodes.size() + stuck.edges.size(), "генератор, выдающий одно и то же, не ломает холст");
    }
    {
        const auto doc = canvasFromGraph({note("Корень", {"Сервер"}), note("Сервер", {"Диск"}, {"", "Железо"}),
                                          note("Диск", {}, {"", "Железо"}), note("Рецепт", {"Корень"}, {"", "Дом/Кухня"})},
                                         withIds());
        const auto groups = groupsOf(doc);
        check(groups.size() == 2 && groups[0].str("label") == std::optional<std::string>("Дом / Кухня")
                  && groups[1].str("label") == std::optional<std::string>("Железо"),
              "заметки папки обведены группой с её названием");
        check(groups[0].str(kGraphFolderField) == std::optional<std::string>("Дом/Кухня")
                  && groups[1].str(kGraphFolderField) == std::optional<std::string>("Железо"),
              "группа помнит путь папки");
        check(filesIn(doc, groups[0]) == std::vector<std::string>{"Рецепт.md"}
                  && filesIn(doc, groups[1]) == std::vector<std::string>{"Диск.md", "Сервер.md"},
              "в группе — заметки своей папки");
        std::vector<std::string> types;
        for (const auto &n : doc.nodes) types.push_back(n.type);
        check(types == std::vector<std::string>{"group", "group", "file", "file", "file", "file"},
              "группы лежат под карточками");
        std::vector<std::string> cardFiles;
        for (const auto &n : cardsOf(doc)) cardFiles.push_back(fileOf(n));
        check(cardFiles == std::vector<std::string>{"Корень.md", "Сервер.md", "Диск.md", "Рецепт.md"},
              "карточки идут в порядке входа");
        check(sorted(edgeTitles(doc))
                  == sorted({"Корень.md → Сервер.md", "Рецепт.md → Корень.md", "Сервер.md → Диск.md"}),
              "ссылки между папками остаются стрелками");
        GraphCanvasOptions named;
        named.folderLabel = [](const std::string &path) { return "[" + path + "]"; };
        check(groupsOf(canvasFromGraph({note("A", {}, {"", "x/y"})}, named))[0].str("label")
                  == std::optional<std::string>("[x/y]"),
              "своя подпись группы");
    }
    {
        const std::vector<std::string> folders = {"", "Работа", "Дом", "Учёба", "Архив"};
        std::vector<GraphNoteInput> notes;
        for (int i = 0; i < 45; ++i) {
            notes.push_back(note("Заметка " + std::to_string(i),
                                 {"Заметка " + std::to_string((i + 5) % 45), "Заметка " + std::to_string((i * 7) % 45)},
                                 {"", folders[i % folders.size()]}));
        }
        const auto doc = canvasFromGraph(notes, withIds());
        const auto groups = groupsOf(doc);
        const auto cards = cardsOf(doc);
        check(groups.size() == 4 && cards.size() == 45, "группы папок: четыре группы и все карточки");
        check(overlaps(cards, kGraphCanvasGap - 2) == 0, "карточки с просветом");
        const auto heads = withHead(groups);
        check(overlaps(heads, kGraphCanvasGap - 2) == 0, "группы с шапкой не наезжают друг на друга");
        bool ok = true;
        for (const auto &card : cards) {
            std::string folder;
            for (const auto &n : notes) {
                if (n.id == card.str(kGraphNoteField)) folder = n.folder;
            }
            for (const auto &group : heads) {
                if (group.str(kGraphFolderField) == std::optional<std::string>(folder)) ok = ok && contains(group, card);
                else ok = ok && overlaps({group, card}) == 0;
            }
        }
        check(ok, "группы не наезжают на чужие карточки, свои — внутри");
        check(minOf(doc.nodes, true) == 0 && minOf(doc.nodes, false) == 0, "холст с группами начинается в нуле");
        check(canvasFromGraph(notes, withIds()) == doc, "холст с группами — один результат");
    }
    {
        const std::vector<GraphNoteInput> notes = {
            note("Корень", {"Сервер", "Чужая"}), note("Сервер", {"Чужая"}, {"", "Железо"}),
            note("Чужая", {"Корень"}, {"", "Архив"}), note("2026-10-12", {"Корень"}, {"", "Ежедневные", true})};
        GraphCanvasOptions o = withIds();
        o.scope = scopeOf(std::vector<std::string>{"Железо", "", "Железо"}, false);
        const auto doc = canvasFromGraph(notes, o);
        std::vector<std::string> files;
        for (const auto &n : cardsOf(doc)) files.push_back(fileOf(n));
        check(files == std::vector<std::string>{"Корень.md", "Сервер.md"}, "набор заметок: только выбранные папки и без дней");
        check(groupsOf(doc).size() == 1 && groupsOf(doc)[0].str("label") == std::optional<std::string>("Железо"),
              "набор заметок: группа выбранной папки");
        check(edgeTitles(doc) == std::vector<std::string>{"Корень.md → Сервер.md"}, "ссылки на заметки вне набора стрелок не дают");
        const CanvasJson want = {{kGraphScopeField, {{"folders", {"", "Железо"}}, {"days", false}}}};
        check(canvasjs::deepEqual(doc.extra, want), "набор записан в холст");
        const auto clean = scopeOf(std::vector<std::string>{"", "Железо"}, false);
        check(scopeOfCanvas(doc) == clean, "набор читается из холста");
        check(scopeOfCanvas(parseCanvas(serializeCanvas(doc)).doc) == clean, "набор переживает запись и разбор файла");

        GraphCanvasOptions days = withIds();
        days.scope = scopeOf(std::vector<std::string>{"Железо"});
        std::vector<std::string> withDays;
        for (const auto &n : cardsOf(canvasFromGraph(notes, days))) withDays.push_back(fileOf(n));
        check(withDays == std::vector<std::string>{"Сервер.md", "2026-10-12.md"}, "заметок дней выбор папок не касается");
        GraphCanvasOptions none;
        none.scope = GraphCanvasScope{};
        check(canvasFromGraph(notes, none).extra.empty(), "набор без ограничений в холст не пишется");
        none.scope = scopeOf(std::nullopt, true);
        check(canvasFromGraph(notes, none).extra.empty(), "дни включены — набор не пишется");
        none.scope = scopeOf(std::vector<std::string>{"Нет такой"}, false);
        const auto empty = canvasFromGraph(notes, none);
        const CanvasJson wantEmpty = {{kGraphScopeField, {{"folders", {"Нет такой"}}, {"days", false}}}};
        check(empty.nodes.empty() && empty.edges.empty() && canvasjs::deepEqual(empty.extra, wantEmpty),
              "пустой итог набор помнит");
    }
    {
        const auto doc = [](const CanvasJson &value) {
            CanvasDoc d;
            d.extra[kGraphScopeField] = value;
            return d;
        };
        check(!scopeOfCanvas(CanvasDoc{}), "набора нет у обычного холста");
        check(!scopeOfCanvas(doc("все")), "негодная запись в файле — набора нет");
        check(!scopeOfCanvas(doc({{"folders", "Железо"}, {"days", 1}})), "поля не того вида — набора нет");
        check(scopeOfCanvas(doc({{"folders", {"б", 5, "а"}}})) == scopeOf(std::vector<std::string>{"а", "б"}),
              "строки папок выбираются и сортируются");
        check(isInCanvasScope("Архив", false, std::nullopt), "без набора — всё входит");
        check(!isInCanvasScope("Архив", false, scopeOf(std::vector<std::string>{})), "пустой выбор папок — не входит");
        check(isInCanvasScope("Архив", true, scopeOf(std::vector<std::string>{})), "заметка дня входит при пустом выборе папок");
        check(!isInCanvasScope("Архив", true, scopeOf(std::nullopt, false)), "заметка дня без дней — не входит");
    }
    {
        const auto doc = canvasFromGraph({note("A", {"B"}), note("B")}, withIds());
        const auto parsed = parseCanvas(serializeCanvas(doc));
        check(!parsed.error && parsed.dropped == CanvasDropped{} && parsed.doc == doc,
              "результат — обычный файл JSON Canvas: запись и разбор ничего не теряют");
    }
}

static void testFreeTitle() {
    std::printf("freeCanvasTitle\n");
    check(freeCanvasTitle("Граф связей", {"Холст 1"}) == "Граф связей", "свободное название остаётся как есть");
    check(freeCanvasTitle("Граф связей", {"граф связей"}) == "Граф связей 2", "занятое получает номер, регистр не важен");
    check(freeCanvasTitle("Граф связей", {"Граф связей", "Граф связей 2", "Граф связей 4"}) == "Граф связей 3",
          "занятое получает следующий свободный номер");
}

static CanvasNode card(const std::string &title, double x, double y, const CanvasJson &extra = CanvasJson::object(),
                       const std::string &id = "") {
    auto n = node(id.empty() ? "card-" + title : id, "file", x, y, 250, kGraphCanvasCardHeight, {{"file", title + ".md"}});
    for (auto it = extra.begin(); it != extra.end(); ++it) {
        if (it.key() == "width") n.width = it.value().get<double>();
        else if (it.key() == "height") n.height = it.value().get<double>();
        else n.set(it.key(), it.value());
    }
    return n;
}

static CanvasDoc docOf(std::vector<CanvasNode> nodes, std::vector<CanvasEdge> edges = {}) {
    CanvasDoc d;
    d.nodes = std::move(nodes);
    d.edges = std::move(edges);
    return d;
}

static bool isEmptyResult(const GraphRefreshResult &r) {
    return r.addedCards.empty() && r.addedEdges.empty() && r.removedEdges.empty() && r.renamedCards.empty()
        && r.missingCards.empty();
}

static void testRefresh() {
    std::printf("refreshCanvasFromGraph\n");
    {
        const std::vector<GraphNoteInput> notes = {note("A", {"B"}), note("B", {"C"}), note("C"),
                                                   note("2026-10-12", {"A"}, {"", "", true})};
        const auto doc = canvasFromGraph(notes, withIds());
        const auto r = refreshCanvasFromGraph(doc, notes, withIds());
        check(!r.changed && r.doc == doc && isEmptyResult(r), "холст из графа и те же заметки — менять нечего");
    }
    {
        const std::vector<GraphNoteInput> notes = {note("Корень", {"Сервер"}), note("Сервер", {"Диск"}, {"", "Железо"}),
                                                   note("Диск", {}, {"", "Железо"}), note("Рецепт", {}, {"", "Кухня"})};
        const auto doc = canvasFromGraph(notes, withIds());
        auto more = notes;
        more.push_back(note("Сеть", {"Сервер"}, {"", "Железо"}));
        more.push_back(note("Питание", {}, {"", "Железо"}));
        more.push_back(note("Суп", {}, {"", "Кухня"}));
        const auto r = refreshCanvasFromGraph(doc, more, withIds());
        check(sorted(filesOf(r.doc, r.addedCards)) == sorted({"Питание.md", "Сеть.md", "Суп.md"}),
              "новые заметки получают карточки");
        const auto groups = groupsOf(r.doc);
        check(filesIn(r.doc, groups[0]) == sorted({"Диск.md", "Питание.md", "Сервер.md", "Сеть.md"})
                  && filesIn(r.doc, groups[1]) == sorted({"Рецепт.md", "Суп.md"}),
              "новая заметка папки встаёт в группу этой папки, рамка растёт за ней");
        bool same = r.doc.nodes[0].id == doc.nodes[0].id && r.doc.nodes[1].id == doc.nodes[1].id;
        for (size_t i = 2; i < doc.nodes.size(); ++i) same = same && r.doc.nodes[i] == doc.nodes[i];
        check(same, "группы на своих слоях, прежние карточки не тронуты");
        check(groups[0].str("label") == std::optional<std::string>("Железо")
                  && groups[1].str("label") == std::optional<std::string>("Кухня"),
              "подписи групп прежние");
        const auto cards = cardsOf(r.doc);
        check(overlaps(cards) == 0, "карточки не наложились");
        const auto heads = withHead(groups);
        check(overlaps(heads) == 0, "группы с шапкой не наложились");
        CanvasNode root;
        for (const auto &c : cards) {
            if (fileOf(c) == "Корень.md") root = c;
        }
        check(overlaps({heads[0], root}) == 0, "группа не наехала на чужую карточку");
        check(has(edgeTitles(r.doc), "Сеть.md → Сервер.md"), "стрелка новой заметки");
        const auto again = refreshCanvasFromGraph(r.doc, more);
        check(!again.changed && again.doc == r.doc, "повторное обновление менять нечего");
    }
    {
        const std::vector<GraphNoteInput> notes = {note("Сервер", {}, {"", "Железо"}), note("Диск", {}, {"", "Железо"})};
        const auto built = canvasFromGraph(notes, withIds());
        const auto doc = docOf(cardsOf(built));
        auto more = notes;
        more.push_back(note("Сеть", {"Диск"}, {"", "Железо"}));
        const auto r = refreshCanvasFromGraph(doc, more, withIds());
        bool same = true;
        for (size_t i = 0; i < doc.nodes.size(); ++i) same = same && r.doc.nodes[i] == doc.nodes[i];
        check(groupsOf(r.doc).empty() && filesOf(r.doc, r.addedCards) == std::vector<std::string>{"Сеть.md"} && same
                  && overlaps(r.doc.nodes) == 0,
              "группу папки удалили — её новая заметка встаёт как любая другая, новой группы нет");
    }
    {
        const auto doc = docOf({node("own", "group", -20, -20, 290, 180, {{"label", "Железо"}}), card("Сервер", 0, 0),
                                node("other", "group", 480, -20, 290, 180, {{kGraphFolderField, "Кухня"}})});
        const auto r = refreshCanvasFromGraph(doc, {note("Сервер", {}, {"", "Железо"}), note("Диск", {}, {"", "Железо"})},
                                              withIds());
        bool same = true;
        for (size_t i = 0; i < doc.nodes.size(); ++i) same = same && r.doc.nodes[i] == doc.nodes[i];
        const auto &added = r.doc.nodes[3];
        check(same && fileOf(added) == "Диск.md" && overlaps({doc.nodes[2], added}) == 0,
              "группа без пути папки (своя) и группа другой папки новую заметку не забирают");
    }
    {
        const std::vector<GraphNoteInput> notes = {note("Сервер", {}, {"", "Железо"}), note("Чужая", {}, {"", "Архив"})};
        GraphCanvasOptions o = withIds();
        o.scope = scopeOf(std::vector<std::string>{"Железо"}, false);
        const auto doc = canvasFromGraph(notes, o);
        check(cardsOf(doc).size() == 1 && fileOf(cardsOf(doc)[0]) == "Сервер.md", "холст с набором: только набор");
        check(!refreshCanvasFromGraph(doc, notes).changed, "холст с набором: те же заметки — менять нечего");
        auto more = notes;
        more.push_back(note("Диск", {"Чужая", "Сервер"}, {"", "Железо"}));
        more.push_back(note("Новая чужая", {"Сервер"}, {"", "Архив"}));
        more.push_back(note("Без папки", {"Сервер"}));
        more.push_back(note("2026-10-12", {"Сервер"}, {"", "Ежедневные", true}));
        const auto r = refreshCanvasFromGraph(doc, more, withIds());
        check(filesOf(r.doc, r.addedCards) == std::vector<std::string>{"Диск.md"}
                  && edgeTitles(r.doc) == std::vector<std::string>{"Диск.md → Сервер.md"} && r.missingCards.empty()
                  && scopeOfCanvas(r.doc) == scopeOf(std::vector<std::string>{"Железо"}, false),
              "холст с набором заметок: обновление берёт новые заметки только из набора");
        auto manual = r.doc;
        manual.nodes.push_back(card("Чужая", 2000, 2000));
        const auto again = refreshCanvasFromGraph(manual, more, withIds());
        check(again.addedCards.empty() && again.missingCards.empty() && has(edgeTitles(again.doc), "Диск.md → Чужая.md"),
              "карточка заметки вне набора, положенная руками, — своя: стрелки к ней идут");
        CanvasDoc empty;
        empty.extra = doc.extra;
        const auto filled = refreshCanvasFromGraph(empty, more, withIds());
        std::vector<std::string> files;
        for (const auto &n : cardsOf(filled.doc)) files.push_back(fileOf(n));
        check(files == std::vector<std::string>{"Сервер.md", "Диск.md"} && filled.addedCards.size() == 2
                  && scopeOfCanvas(filled.doc) == scopeOf(std::vector<std::string>{"Железо"}, false),
              "совсем пустой холст с набором заполняется только набором");
    }
    {
        const auto doc = canvasFromGraph({note("A", {"B"}), note("B")}, withIds());
        bool allGraph = true;
        for (const auto &e : doc.edges) allGraph = allGraph && isGraphEdge(e);
        bool noPrefixedNodes = true;
        for (const auto &n : doc.nodes) noPrefixedNodes = noPrefixedNodes && n.id.rfind(kGraphEdgePrefix, 0) != 0;
        check(allGraph && doc.edges[0].id.rfind(kGraphEdgePrefix, 0) == 0 && noPrefixedNodes,
              "стрелки холста из графа узнаются по началу идентификатора");
        check(doc.nodes[0].str(kGraphNoteField) == std::optional<std::string>("id-A")
                  && doc.nodes[1].str(kGraphNoteField) == std::optional<std::string>("id-B"),
              "карточки несут идентификатор заметки");
    }
    {
        CanvasDoc doc = docOf({node("g", "group", -40, -60, 700, 400, {{"label", "Железо"}, {"color", "4"}}),
                               card("A", 0, 0, {{"color", "2"}, {"width", 320}, {"height", 200}}),
                               node("t", "text", 360, 0, 250, 60, {{"text", "Своя пометка"}}),
                               node("l", "link", 0, 500, 300, 160, {{"url", "https://example.org"}}),
                               node("f", "file", 400, 500, 250, kGraphCanvasCardHeight, {{"file", "Фото/схема.png"}}),
                               node("x", "future", 900, 0, 100, 100, {{"custom", {{"a", 1}}}})},
                              {edge("mine", "t", "card-A", {{"label", "см."}})});
        doc.extra["version"] = 2;
        const auto r = refreshCanvasFromGraph(doc, {note("A", {"B"}), note("B")}, withIds());
        bool same = true;
        for (size_t i = 0; i < doc.nodes.size(); ++i) same = same && r.doc.nodes[i] == doc.nodes[i];
        check(same && r.doc.edges[0] == doc.edges[0], "сделанное руками не трогается: узлы и свои стрелки на месте");
        check(canvasjs::deepEqual(r.doc.extra, CanvasJson{{"version", 2}}), "поля файла сохраняются");
        check(filesOf(r.doc, r.addedCards) == std::vector<std::string>{"B.md"} && r.addedEdges.size() == 1
                  && r.doc.nodes.size() == doc.nodes.size() + 1,
              "добавлены карточка и стрелка");
        const std::vector<CanvasNode> rest(r.doc.nodes.begin() + 1, r.doc.nodes.end());
        check(overlaps(rest) == 0, "новая карточка не накладывается");
        const auto &added = r.doc.nodes.back();
        check(added.width == 250 && added.height == kGraphCanvasCardHeight
                  && added.str(kGraphNoteField) == std::optional<std::string>("id-B"),
              "новая карточка — обычного размера холста из графа и поверх остальных");
        const auto &group = doc.nodes[0];
        check(added.x >= group.x + group.width || added.x + added.width <= group.x || added.y >= group.y + group.height
                  || added.y + added.height <= group.y,
              "и не внутри группы");
    }
    {
        const auto doc = docOf({card("A", 0, 0), node("t", "text", 0, 200, 250, 60, {{"text", "занято"}}),
                                node("g", "group", 300, -100, 400, 400), card("C", 0, -200)});
        const std::vector<GraphNoteInput> notes = {note("A", {"B"}), note("B"), note("C")};
        const auto r = refreshCanvasFromGraph(doc, notes, withIds());
        check(filesOf(r.doc, r.addedCards) == std::vector<std::string>{"B.md"} && overlaps(r.doc.nodes) == 0
                  && overlaps(r.doc.nodes, kGraphCanvasGap / 2 - 1) == 0,
              "новая карточка не задевает ни одного узла, включая группы, с просветом");
        const auto &added = r.doc.nodes.back();
        check(added.x == -320 && added.y == 0, "свободно только слева: там она и стоит");
        const auto again = refreshCanvasFromGraph(doc, notes, withIds());
        check(again.doc == r.doc && again.addedCards == r.addedCards && again.addedEdges == r.addedEdges,
              "сверка повторяется тем же результатом");
    }
    {
        const auto alone = refreshCanvasFromGraph(docOf({card("A", 0, 0)}), {note("A"), note("B", {"A"})}, withIds());
        check(alone.doc.nodes[1].x == 0 && alone.doc.nodes[1].y == 200, "свободное место ищется сначала под связанной карточкой");
        std::vector<GraphNoteInput> notes = {note("A")};
        for (int i = 0; i < 12; ++i) notes.push_back(note("N" + std::to_string(i), {"A"}));
        const auto many = refreshCanvasFromGraph(docOf({card("A", 0, 0)}), notes, withIds());
        check(many.addedCards.size() == 12 && many.addedEdges.size() == 12 && overlaps(many.doc.nodes, kGraphCanvasGap / 2 - 1) == 0
                  && many.doc.nodes[0] == card("A", 0, 0),
              "несколько новых у одной карточки не накладываются друг на друга");
    }
    {
        const auto r = refreshCanvasFromGraph(docOf({card("A", 0, 0), card("C", 800, 0)}),
                                              {note("A", {"B"}), note("B", {"C"}), note("C")}, withIds());
        check(r.doc.nodes[2].x == 400 && r.doc.nodes[2].y == 0
                  && edgeTitles(r.doc) == std::vector<std::string>{"A.md → B.md", "B.md → C.md"},
              "заметка между двумя связанными встаёт у середины их рамки");
    }
    {
        const auto r = refreshCanvasFromGraph(docOf({card("A", 0, 0)}),
                                              {note("Дальняя", {"Ближняя"}), note("A"), note("Ближняя", {"A"})}, withIds());
        const auto &near = r.doc.nodes[1];
        const auto &far = r.doc.nodes[2];
        check(filesOf(r.doc, r.addedCards) == std::vector<std::string>{"Ближняя.md", "Дальняя.md"}
                  && std::abs(far.x - near.x) + std::abs(far.y - near.y) <= 520
                  && overlaps(r.doc.nodes, kGraphCanvasGap / 2 - 1) == 0,
              "новая заметка, связанная только с другой новой, встаёт рядом с ней");
    }
    {
        std::vector<GraphNoteInput> lonely;
        for (int i = 0; i < 5; ++i) lonely.push_back(note("Одна " + std::to_string(i)));
        const auto tall = docOf({card("A", 0, 0), node("g", "group", -100, -100, 500, 900)});
        std::vector<GraphNoteInput> notes = {note("A")};
        notes.insert(notes.end(), lonely.begin(), lonely.end());
        const auto right = refreshCanvasFromGraph(tall, notes, withIds());
        std::vector<std::pair<double, double>> places;
        for (size_t i = 2; i < right.doc.nodes.size(); ++i) places.emplace_back(right.doc.nodes[i].x, right.doc.nodes[i].y);
        check(places == std::vector<std::pair<double, double>>{{520, -100}, {520, 100}, {520, 300}, {520, 500}, {830, -100}},
              "несвязанные заметки — столбцом справа от холста");
        check(right.addedEdges.empty() && overlaps(right.doc.nodes) == 1, "только карточка A внутри своей группы");
        const auto wide = docOf({card("A", 0, 0), card("C", 1500, 0)});
        std::vector<GraphNoteInput> notes2 = {note("A"), note("C")};
        notes2.insert(notes2.end(), lonely.begin(), lonely.end());
        const auto below = refreshCanvasFromGraph(wide, notes2, withIds());
        places.clear();
        for (size_t i = 2; i < below.doc.nodes.size(); ++i) places.emplace_back(below.doc.nodes[i].x, below.doc.nodes[i].y);
        check(places == std::vector<std::pair<double, double>>{{0, 260}, {310, 260}, {620, 260}, {930, 260}, {1240, 260}}
                  && overlaps(below.doc.nodes) == 0,
              "у широкого холста — рядом под ним");
    }
    {
        const auto r = refreshCanvasFromGraph(docOf({card("A", 0, 0)}), {note("A"), note("2026-10-12", {"A"}, {"", "", true})},
                                              withIds());
        check(filesOf(r.doc, r.addedCards) == std::vector<std::string>{"2026-10-12.md"}
                  && edgeTitles(r.doc) == std::vector<std::string>{"2026-10-12.md → A.md"},
              "ежедневные заметки получают карточки, как на холсте из графа");
    }
    {
        const auto doc = docOf({card("A", 0, 0), card("B", 400, 0), card("C", 800, 0)},
                               {edge("mine", "card-A", "card-B"), edge("back", "card-C", "card-A")});
        const auto r = refreshCanvasFromGraph(doc, {note("A", {"B", "C", "a", "Нет такой"}), note("B"), note("C")}, withIds());
        check(r.addedCards.empty() && edgeTitles(r.doc) == std::vector<std::string>{"A.md → B.md", "C.md → A.md", "A.md → C.md"}
                  && r.addedEdges.size() == 1 && isGraphEdge(r.doc.edges[2]) && r.doc.nodes == doc.nodes,
              "стрелка на ссылку ставится, только если между карточками её ещё нет в эту сторону");
        const auto again = refreshCanvasFromGraph(r.doc, {note("A", {"B", "C"}), note("B"), note("C")});
        check(!again.changed && again.doc == r.doc, "повтор ничего не добавляет");
    }
    {
        const auto doc = docOf({card("A", 0, 0, {{"file", "Знания/Проекты/a.MD"}}), card("B", 400, 0),
                                card("B", 400, 300, CanvasJson::object(), "copy")},
                               {edge("mine", "card-A", "copy")});
        const auto r = refreshCanvasFromGraph(doc, {note("A", {"B"}), note("B")}, withIds());
        check(!r.changed && r.doc == doc,
              "путь карточки с папками и другим регистром — та же заметка; копия карточки второй не требует");
    }
    {
        const std::vector<GraphNoteInput> notes = {note("A", {"B", "C"}), note("B"), note("C")};
        const auto doc = canvasFromGraph(notes, withIds());
        const auto r = refreshCanvasFromGraph(doc, {note("A", {"C"}), note("B"), note("C")}, withIds());
        check(r.removedEdges == std::vector<std::string>{doc.edges[0].id}
                  && edgeTitles(r.doc) == std::vector<std::string>{"A.md → C.md"} && r.doc.nodes == doc.nodes
                  && r.addedCards.empty() && r.addedEdges.empty(),
              "своя стрелка исчезнувшей ссылки убирается, карточки остаются");
    }
    {
        const auto base = canvasFromGraph({note("A", {"B"}), note("B")}, withIds());
        const auto &a = base.nodes[0];
        const auto &b = base.nodes[1];
        auto doc = base;
        doc.edges.push_back(edge(kGraphEdgePrefix + "back", b.id, a.id));
        const auto r = refreshCanvasFromGraph(doc, {note("A", {"B"}), note("B", {"A"})}, withIds());
        auto mutual = base.edges[0];
        mutual.set("fromEnd", "arrow");
        check(r.removedEdges == std::vector<std::string>{kGraphEdgePrefix + "back"}
                  && r.doc.edges == std::vector<CanvasEdge>{mutual},
              "встречные свои стрелки сливаются в одну двустороннюю");
        const auto answered = refreshCanvasFromGraph(base, {note("A", {"B"}), note("B", {"A"})}, withIds());
        check(answered.addedEdges.empty() && answered.doc.edges == std::vector<CanvasEdge>{mutual},
              "ответная ссылка делает стрелку двусторонней");
        const auto oneWay = refreshCanvasFromGraph(r.doc, {note("A", {"B"}), note("B")}, withIds());
        check(oneWay.doc.edges == std::vector<CanvasEdge>{base.edges[0]}, "обратную ссылку убрали — наконечник в начале снимается");
        const auto reversed = refreshCanvasFromGraph(r.doc, {note("A"), note("B", {"A"})}, withIds());
        check(edgeTitles(reversed.doc) == std::vector<std::string>{"B.md → A.md"} && !reversed.doc.edges[0].has("fromEnd"),
              "убрали прямую — стрелка разворачивается");
    }
    {
        const auto base = canvasFromGraph({note("A", {"B"}), note("B")}, withIds());
        const auto &a = base.nodes[0];
        const auto &b = base.nodes[1];
        const auto &autoEdge = base.edges[0];
        const auto variant = [&](const std::string &id, const CanvasJson &fields) {
            auto e = autoEdge;
            e.id = kGraphEdgePrefix + id;
            for (auto it = fields.begin(); it != fields.end(); ++it) e.set(it.key(), it.value());
            return e;
        };
        const std::vector<CanvasEdge> kept = {
            variant("label", {{"label", "ведёт"}}), variant("color", {{"color", "3"}}), variant("side", {{"fromSide", "top"}}),
            variant("to-side", {{"toSide", "left"}}), variant("no-ends", {{"toEnd", "none"}}), variant("extra", {{"weight", 2}}),
            edge("drawn", a.id, b.id), edge("00000000000000aa", b.id, a.id)};
        CanvasEdge plain = variant("plain", {{"toEnd", "arrow"}, {"fromEnd", "none"}, {"label", ""}});
        CanvasEdge mutual = variant("mutual", {{"fromEnd", "arrow"}});
        auto doc = base;
        doc.edges = kept;
        doc.edges.push_back(plain);
        doc.edges.push_back(mutual);
        const auto r = refreshCanvasFromGraph(doc, {note("A"), note("B")}, withIds());
        bool customized = true;
        for (const auto &e : kept) {
            if (isGraphEdge(e)) customized = customized && isCustomizedEdge(e);
        }
        check(customized, "правленые свои стрелки считаются правкой");
        check(!isCustomizedEdge(plain) && !isCustomizedEdge(autoEdge) && !isCustomizedEdge(mutual),
              "значения по умолчанию и наконечник взаимности правкой не считаются");
        check(r.removedEdges == std::vector<std::string>{plain.id, mutual.id} && r.doc.edges == kept,
              "правленая своя стрелка и нарисованная руками не убираются");
    }
    {
        const auto doc = canvasFromGraph({note("A", {"B"}), note("B", {"A", "C"}), note("C")}, withIds());
        const auto cardB = doc.nodes[1];
        const auto r = refreshCanvasFromGraph(doc, {note("A", {"B"}), note("C")}, withIds());
        check(r.missingCards == std::vector<std::string>{cardB.id} && !r.changed && r.doc == doc,
              "карточка удалённой заметки остаётся вместе со своими стрелками и числится пропавшей");
        const auto cleaned = refreshCanvasFromGraph(doc, {note("A"), note("C")}, withIds());
        check(cleaned.missingCards == std::vector<std::string>{cardB.id}
                  && edgeTitles(cleaned.doc) == std::vector<std::string>{"B.md → A.md", "B.md → C.md"}
                  && cleaned.doc.nodes == doc.nodes,
              "ссылку на удалённую заметку убрали — стрелка к её карточке уходит, от неё — остаются");
    }
    {
        const auto doc = canvasFromGraph({note("A", {"Старое"}), note("Старое")}, withIds());
        auto moved = doc;
        for (auto &n : moved.nodes) n.set("file", "Папка/" + fileOf(n));
        const auto r = refreshCanvasFromGraph(moved, {note("A", {"Новое"}), note("Новое", {}, byId("id-Старое"))}, withIds());
        auto want = moved.nodes[1];
        want.set("file", "Папка/Новое.md");
        check(r.renamedCards == std::vector<std::string>{doc.nodes[1].id} && r.doc.nodes[1] == want
                  && r.doc.nodes[0] == moved.nodes[0] && r.addedCards.empty() && r.addedEdges.empty()
                  && r.removedEdges.empty() && r.missingCards.empty() && r.doc.edges == doc.edges,
              "переименованная заметка: карточка с её идентификатором идёт за новым названием");
    }
    {
        const auto doc = docOf({card("A", 0, 0), card("Старое", 400, 0)}, {edge(kGraphEdgePrefix + "1", "card-A", "card-Старое")});
        const auto r = refreshCanvasFromGraph(doc, {note("A", {"Новое"}), note("Новое")}, withIds());
        check(r.renamedCards.empty() && r.missingCards == std::vector<std::string>{"card-Старое"}
                  && filesOf(r.doc, r.addedCards) == std::vector<std::string>{"Новое.md"}
                  && r.removedEdges == std::vector<std::string>{kGraphEdgePrefix + "1"}
                  && edgeTitles(r.doc) == std::vector<std::string>{"A.md → Новое.md"} && r.doc.nodes[0] == doc.nodes[0]
                  && r.doc.nodes[1] == doc.nodes[1],
              "карточка без идентификатора заметки после переименования остаётся пропавшей, новая получает свою");
    }
    {
        const auto doc = docOf({card("План", 0, 0, {{kGraphNoteField, "old"}})});
        const auto r = refreshCanvasFromGraph(doc, {note("План"), note("Иное", {}, byId("old"))}, withIds());
        check(r.renamedCards.empty() && r.doc.nodes[0] == doc.nodes[0]
                  && filesOf(r.doc, r.addedCards) == std::vector<std::string>{"Иное.md"},
              "заметка с тем же названием, что у карточки с чужим идентификатором, карточку не уводит");
    }
    {
        const std::vector<GraphNoteInput> notes = {note("План", {}, byId("first")), note("План", {}, {"second", "Архив"}),
                                                   note(" ", {}, byId("blank"))};
        const auto r = refreshCanvasFromGraph(docOf({card("План", 0, 0)}), notes, withIds());
        check(filesOf(r.doc, r.addedCards) == std::vector<std::string>{"План.md"}
                  && r.doc.nodes[1].str(kGraphNoteField) == std::optional<std::string>("second")
                  && !refreshCanvasFromGraph(r.doc, notes).changed,
              "одноимённые заметки получают по карточке; заметка без названия пропускается");
    }
    {
        const std::vector<GraphNoteInput> notes = {note("A", {"B"}), note("B")};
        CanvasDoc empty;
        empty.extra["version"] = 1;
        const auto r = refreshCanvasFromGraph(empty, notes, withIds());
        auto built = canvasFromGraph(notes, withIds());
        built.extra["version"] = 1;
        std::vector<std::string> cardIds, edgeIds;
        for (const auto &n : built.nodes) cardIds.push_back(n.id);
        for (const auto &e : built.edges) edgeIds.push_back(e.id);
        check(r.doc == built && r.addedCards == cardIds && r.addedEdges == edgeIds,
              "совсем пустой холст заполняется раскладкой графа");
        const auto none = refreshCanvasFromGraph(empty, {});
        check(!none.changed && none.doc == empty, "без заметок остаётся пустым");
    }
    {
        const auto text = node("t", "text", 0, 0, 250, 60, {{"text", "Заголовок"}});
        const auto r = refreshCanvasFromGraph(docOf({text}), {note("A", {"B"}), note("B")}, withIds());
        check(r.doc.nodes[0] == text && r.addedCards.size() == 2 && overlaps(r.doc.nodes) == 0
                  && edgeTitles(r.doc) == std::vector<std::string>{"A.md → B.md"},
              "холст только с текстом: заметки встают блоком рядом, текст на месте");
    }
    {
        const auto doc = docOf({card("A", 0, 0, CanvasJson::object(), "same")},
                               {edge(kGraphEdgePrefix + "same", "same", "same", {{"label", "петля"}})});
        GraphCanvasOptions o;
        o.makeId = [] { return std::string("same"); };
        const auto r = refreshCanvasFromGraph(doc, {note("A", {"B", "C"}), note("B", {"A"}), note("C")}, o);
        std::set<std::string> ids;
        for (const auto &n : r.doc.nodes) ids.insert(n.id);
        for (const auto &e : r.doc.edges) ids.insert(e.id);
        bool prefixed = true;
        for (const auto &id : r.addedEdges) prefixed = prefixed && id.rfind(kGraphEdgePrefix, 0) == 0;
        check(r.doc.nodes.size() + r.doc.edges.size() == 6 && ids.size() == 6 && prefixed,
              "идентификаторы не повторяются даже у залипшего генератора");
        const auto parsed = parseCanvas(serializeCanvas(r.doc));
        check(!parsed.error && parsed.dropped == CanvasDropped{} && parsed.doc == r.doc, "файл остаётся обычным JSON Canvas");
    }
}

static void testRenames() {
    std::printf("renameCanvasFolder\n");
    const auto made = [] {
        GraphCanvasOptions o = withIds();
        o.scope = scopeOf(std::vector<std::string>{"Дом", "Дом/Кухня", "Домики"});
        return canvasFromGraph({note("A", {}, {"", "Дом"}), note("B", {}, {"", "Дом/Кухня"}), note("C", {}, {"", "Домики"})}, o);
    };
    {
        const auto doc = renameCanvasFolder(made(), "Дом", "Квартира");
        check(scopeOfCanvas(doc)->folders == std::optional<std::vector<std::string>>({"Домики", "Квартира", "Квартира/Кухня"}),
              "путь папки и подпапок меняется в наборе заметок");
        std::vector<std::string> paths, labels;
        for (const auto &g : groupsOf(doc)) {
            paths.push_back(g.str(kGraphFolderField).value_or(""));
            labels.push_back(g.str("label").value_or(""));
        }
        check(sorted(paths) == sorted({"Домики", "Квартира", "Квартира/Кухня"}), "путь меняется у групп, соседняя папка — нет");
        check(sorted(labels) == sorted({"Домики", "Квартира", "Квартира / Кухня"}), "подписи групп следуют за папкой");
        check(isInCanvasScope("Квартира", false, scopeOfCanvas(doc)), "новая заметка переименованной папки попадает в набор");
    }
    {
        const auto base = made();
        auto custom = base;
        for (auto &n : custom.nodes) {
            if (n.str(kGraphFolderField) == std::optional<std::string>("Дом")) n.set("label", "Моё");
        }
        const auto doc = renameCanvasFolder(custom, "Дом", "Квартира");
        std::optional<std::string> label;
        for (const auto &n : doc.nodes) {
            if (n.str(kGraphFolderField) == std::optional<std::string>("Квартира")) label = n.str("label");
        }
        check(label == std::optional<std::string>("Моё"), "свою подпись группы человек сохраняет");
        check(renameCanvasFolder(base, "Нет такой", "Другая") == base && renameCanvasFolder(base, "Дом", "Дом") == base,
              "нечего менять — прежний документ");
    }
    std::printf("renameCanvasNote\n");
    {
        const auto doc = docOf({node("a", "file", 0, 0, 250, 140, {{"file", "Старое.md"}, {"color", "2"}}),
                                node("b", "file", 300, 0, 250, 140, {{"file", "Знания/старое.md"}}),
                                node("c", "file", 600, 0, 250, 140, {{"file", "Старое.png"}}),
                                node("d", "text", 900, 0, 250, 60, {{"text", "[[Старое]]"}, {"file", "Старое.md"}})},
                               {edge("e", "a", "b")});
        const auto renamed = renameCanvasNote(doc, " старое ", "Новое");
        std::vector<std::string> files;
        for (const auto &n : renamed.nodes) files.push_back(fileOf(n));
        check(files == std::vector<std::string>{"Новое.md", "Знания/Новое.md", "Старое.png", "Старое.md"},
              "карточки заметки указывают на новое название, папки пути и остальное остаются");
        auto want = doc.nodes[0];
        want.set("file", "Новое.md");
        check(renamed.nodes[0] == want && renamed.nodes[2] == doc.nodes[2] && renamed.edges == doc.edges,
              "прочие поля и стрелки не тронуты");
    }
    {
        const auto doc = docOf({node("a", "file", 0, 0, 250, 140, {{"file", "A.md"}})});
        check(renameCanvasNote(doc, "B", "C") == doc && renameCanvasNote(doc, "A", " ") == doc
                  && renameCanvasNote(doc, "", "C") == doc,
              "нет таких карточек или пустое название — прежний документ");
    }
}

int main() {
    testCanvasFromGraph();
    testFreeTitle();
    testRefresh();
    testRenames();
    return finish();
}
