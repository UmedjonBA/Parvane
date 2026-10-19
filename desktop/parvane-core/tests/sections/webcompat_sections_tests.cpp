// Parvane fork (spec 029, T037): векторы разделов web → desktop. Файлы `proto/parvane/vectors/clients/sections-*-web.json`
// пишет web (`src/api/parvane/sectionsVectors.test.ts`) из своих настоящих моделей; здесь те же входы проходят через
// модели parvane-core и обязаны дать те же значения: «План» (состояние движка → состояние экранов, разница состояний →
// изменения, перенос этапа 1, склейка правок), «Облако» (дерево узлов, сортировка, корзина, план ссылки и её список),
// заметки (разбор и запись, указатель, правки пунктов, папки), холст (разбор и запись файла байт в байт, правки,
// геометрия). Без стека.
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/cloud_files.h"
#include "parvane/sections/cloud_model.h"
#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_folders.h"
#include "parvane/sections/notes_model.h"
#include "parvane/sections/planner_engine.h"
#include "parvane/sections/planner_model.h"
#include "parvane/sections/planner_sync.h"
#include "parvane/sections/planner_types.h"

using nlohmann::json;

static int g_total = 0, g_fail = 0;

static std::string escapeName(const std::string &name) {
    std::string out;
    for (char c : name) {
        if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out.push_back(c);
    }
    return out;
}

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", escapeName(name).c_str(),
                info.empty() ? "" : (" — " + escapeName(info)).c_str());
}

static std::string vectorPath(const std::string &name) {
    return std::string(PARVANE_VECTORS_DIR) + "/clients/" + name;
}

static std::string readText(const std::string &path) {
    std::ifstream f(path, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static json loadVector(const std::string &name) {
    const auto parsed = json::parse(readText(vectorPath(name)), nullptr, false);
    check(parsed.is_object(), name + ": вектор web есть (сгенерировать: vitest sectionsVectors)");
    return parsed.is_object() ? parsed : json::object();
}

// `JSON.stringify` web не пишет `undefined`; в JSON движка и у моделей C++ «не задано» — null либо нет ключа. Для
// сравнения значений null-поля убираются с обеих сторон
static json stripNulls(const json &value) {
    if (value.is_object()) {
        json out = json::object();
        for (const auto &[k, v] : value.items()) {
            if (!v.is_null()) out[k] = stripNulls(v);
        }
        return out;
    }
    if (value.is_array()) {
        json out = json::array();
        for (const auto &v : value) out.push_back(stripNulls(v));
        return out;
    }
    return value;
}

static std::string brief(const json &value) {
    const auto text = value.dump();
    return text.size() > 300 ? text.substr(0, 300) + "…" : text;
}

static void checkJson(const json &got, const json &want, const std::string &name) {
    const bool ok = stripNulls(got) == stripNulls(want);
    check(ok, name, ok ? "" : "получено " + brief(got) + " | ожидалось " + brief(want));
}

// Поле объекта либо null: у const json `operator[]` по отсутствующему ключу — неопределённое поведение, а web
// не пишет `undefined`-поля вовсе
static const json &at(const json &j, const char *key) {
    static const json kNull;
    const auto it = j.is_object() ? j.find(key) : j.end();
    return it == j.end() ? kNull : *it;
}

static std::string str(const json &j, const char *key) {
    const auto it = j.find(key);
    return it != j.end() && it->is_string() ? it->get<std::string>() : std::string();
}

static std::optional<std::string> optStr(const json &j, const char *key) {
    const auto it = j.find(key);
    if (it == j.end() || !it->is_string()) return std::nullopt;
    return it->get<std::string>();
}

// ── «План» ───────────────────────────────────────────────────────────────────

static void plannerVector() {
    namespace planner = parvane::sections::planner;
    const auto v = loadVector("sections-planner-web.json");
    if (v.empty()) return;

    const auto state = planner::fromEngineState(v["engine"]);
    checkJson(json(state), v["state"], "план: состояние движка → состояние экранов (как web fromEngineState)");
    check(planner::hasEngineQuickLines(v["engine"]) == v.value("hasQuickLines", false), "план: движок понимает историю ввода");

    const auto full = planner::diffChanges(planner::createEmptyState(), state);
    checkJson(json(full), v["fullChanges"], "план: состояние целиком → изменения (как web diffChanges от пустого)");

    const planner::State edited = v["edited"].get<planner::State>();
    checkJson(json(edited), v["edited"], "план: состояние web читается в State без потерь");
    const auto editChanges = planner::diffChanges(state, edited);
    checkJson(json(editChanges), v["editChanges"], "план: правка состояния → изменения по полям (как web diffChanges)");

    const planner::State legacy = v["legacy"].get<planner::State>();
    const auto legacyChanges = planner::legacyToChanges(legacy, "desk-01:Linux");
    checkJson(json(legacyChanges), v["legacyChanges"], "план: перенос записи этапа 1 (префикс устройства, отметка переноса)");
    for (const auto &c : v["legacyRecordCases"]) {
        check(planner::isLegacyPlannerRecord(c["raw"]) == c.value("isLegacy", false),
              "план: запись этапа 1 узнаётся: " + brief(c["raw"]));
    }

    checkJson(planner::coalesceChanges(v["coalesceInput"]), v["coalesced"], "план: склейка правок одной операции (как web coalesceChanges)");
}

// ── «Облако» ─────────────────────────────────────────────────────────────────

namespace cloud = parvane::sections::cloud;

static std::vector<std::string> idsOf(const std::vector<cloud::CloudNode> &nodes) {
    std::vector<std::string> out;
    for (const auto &n : nodes) out.push_back(n.id);
    return out;
}

static cloud::Sort sortOf(const json &j) {
    cloud::Sort sort;
    const auto key = str(j, "key");
    sort.key = key == "date" ? cloud::SortKey::Date : key == "size" ? cloud::SortKey::Size : cloud::SortKey::Name;
    sort.isDescending = j.value("isDescending", false);
    return sort;
}

static json linkPlanJson(const cloud::LinkPlan &plan) {
    if (!plan.error.empty()) return json{{"error", plan.error}};
    auto files = json::array();
    for (const auto &f : plan.files) files.push_back(json{{"path", f.path}, {"node", f.node}});
    return json{{"name", plan.name}, {"kind", plan.kind}, {"dirs", plan.dirs}, {"files", files}, {"bytes", plan.bytes}};
}

static void cloudVector() {
    const auto v = loadVector("sections-cloud-web.json");
    if (v.empty()) return;
    const auto nodes = v["nodes"].get<std::vector<cloud::CloudNode>>();
    const auto now = v.value("now", std::int64_t(0));
    checkJson(json(nodes), v["nodes"], "облако: узлы web читаются и пишутся теми же полями");

    checkJson(json(idsOf(cloud::listedNodes(nodes))), v["listed"], "облако: служебные файлы не показываются");
    checkJson(json(idsOf(cloud::childrenOf(nodes))), v["children"]["root"], "облако: содержимое корня");
    checkJson(json(idsOf(cloud::childrenOf(nodes, std::string("f-docs")))), v["children"]["docs"], "облако: содержимое папки");
    checkJson(json(idsOf(cloud::childrenOf(cloud::listedNodes(nodes)))), v["children"]["listedRoot"], "облако: корень без служебных");
    checkJson(json(cloud::namesIn(nodes)), v["names"]["root"], "облако: занятые имена корня");
    checkJson(json(cloud::namesIn(nodes, std::string("f-docs"), std::string("r2"))), v["names"]["docs"],
              "облако: занятые имена папки без одного узла");
    checkJson(json(idsOf(cloud::pathOf(nodes, std::string("cat")))), v["path"], "облако: путь до узла");
    checkJson(json(idsOf(cloud::pathOf(nodes))), v["pathRoot"], "облако: путь корня пуст");
    checkJson(json(idsOf(cloud::subtreeOf(nodes, "f-docs"))), v["subtree"], "облако: поддерево в ширину");
    for (const auto &c : v["canMove"]) {
        const auto moved = c["moved"].get<std::vector<std::string>>();
        const auto target = optStr(c, "target");
        check(cloud::canMoveInto(nodes, moved, target) == c.value("ok", false),
              "облако: перенос " + brief(c["moved"]) + " в " + (target ? *target : "корень"));
    }
    for (const auto &c : v["sorted"]) {
        const auto sorted = cloud::sortNodes(cloud::childrenOf(cloud::listedNodes(nodes), std::string("f-docs")), sortOf(c["sort"]));
        checkJson(json(idsOf(sorted)), c["ids"], "облако: сортировка папки " + brief(c["sort"]));
    }
    for (const auto &c : v["sortedAll"]) {
        checkJson(json(idsOf(cloud::sortNodes(nodes, sortOf(c["sort"])))), c["ids"], "облако: сортировка всех узлов " + brief(c["sort"]));
    }
    for (const auto &c : v["search"]) {
        checkJson(json(idsOf(cloud::searchNodes(nodes, str(c, "query")))), c["ids"], "облако: поиск «" + str(c, "query") + "»");
    }
    checkJson(json(idsOf(cloud::trashOf(nodes))), v["trash"], "облако: корзина, свежие первыми");
    checkJson(json(idsOf(cloud::expiredTrashOf(nodes, now))), v["expiredTrash"], "облако: просроченное в корзине (30 дней)");
    checkJson(json(idsOf(cloud::expiredTrashOf(nodes, now, 7 * cloud::kDayMs))), v["expiredTrashWeek"],
              "облако: просроченное в корзине (7 дней)");
    {
        json days = json::object();
        for (const auto &n : cloud::trashOf(nodes)) days[n.id] = cloud::trashDaysLeft(n, now);
        checkJson(days, v["trashDaysLeft"], "облако: сколько дней осталось в корзине");
    }
    {
        const auto usage = cloud::usageOf(nodes);
        checkJson(json{{"total", usage.total}, {"trash", usage.trash}}, v["usage"], "облако: занятое место");
        checkJson(json{{"docs", cloud::sizeOf(nodes, "f-docs")}, {"photo", cloud::sizeOf(nodes, "f-photo")},
                       {"old", cloud::sizeOf(nodes, "f-old")}},
                  v["sizeOf"], "облако: размер папок");
        json stats = json::object();
        for (const auto &[id, s] : cloud::folderStats(nodes)) stats[id] = json{{"count", s.count}, {"size", s.size}};
        checkJson(stats, v["folderStats"], "облако: счётчики папок");
    }
    for (const auto &c : v["kinds"]) {
        const auto kind = cloud::fileKindName(cloud::kindOfFile(str(c, "mime"), str(c, "name")));
        check(kind == str(c, "kind"), "облако: вид файла " + str(c, "mime") + " / " + str(c, "name"), kind);
    }
    for (const auto &c : v["typeLabels"]) {
        const auto label = cloud::fileTypeLabel(str(c, "name"));
        check(label == str(c, "label"), "облако: подпись типа " + str(c, "name"), label);
    }
    for (const auto &c : v["extensions"]) {
        const auto ext = cloud::getExtension(str(c, "name"));
        check(ext == str(c, "extension"), "облако: расширение " + str(c, "name"), ext);
    }
    for (const auto &c : v["freeNames"]) {
        const auto free = cloud::freeName(c["taken"].get<std::vector<std::string>>(), str(c, "name"));
        check(free == str(c, "free"), "облако: свободное имя для " + str(c, "name") + " среди " + brief(c["taken"]), free);
    }
    for (const auto &c : v["validation"]) {
        const auto error = cloud::validateName(str(c, "name"));
        const std::string got = error ? cloud::nameErrorName(*error) : "";
        const auto want = at(c, "error").is_string() ? c["error"].get<std::string>() : std::string();
        check(got == want, "облако: проверка имени " + brief(c["name"]), got);
    }

    // Ссылки для людей без аккаунта: план и список
    const auto &planCases = v["linkPlan"];
    checkJson(linkPlanJson(cloud::buildLinkPlan(v["nodes"], std::string("f-docs"))), planCases["folder"], "ссылка: план папки");
    checkJson(linkPlanJson(cloud::buildLinkPlan(v["nodes"], std::string("cat"))), planCases["file"], "ссылка: план файла");
    checkJson(linkPlanJson(cloud::buildLinkPlan(v["nodes"], std::nullopt, "Общая папка")), planCases["root"],
              "ссылка: план всего контейнера");
    checkJson(linkPlanJson(cloud::buildLinkPlan(v["nodes"], std::string("f-old"))), planCases["trashed"], "ссылка: узел в корзине");
    checkJson(linkPlanJson(cloud::buildLinkPlan(v["nodes"], std::string("nope"))), planCases["missing"], "ссылка: узла нет");
    checkJson(linkPlanJson(cloud::buildLinkPlan(v["nodes"], std::string("svc"))), planCases["noBlob"], "ссылка: файл без блоба");
    {
        std::map<std::string, cloud::LinkCopy> copies;
        copies["r2"] = cloud::LinkCopy{"copy-r2", 20520, 1, std::nullopt};
        copies["r10"] = cloud::LinkCopy{"copy-r10", 10280, 1, std::nullopt};
        copies["cat"] = cloud::LinkCopy{"copy-cat", 350056, 2,
                                        json{{"fileId", "copy-thumb-cat"}, {"nonce", "bm9uY2UtdGh1bWI="}, {"blobSize", 9000}}};
        const auto plan = cloud::buildLinkPlan(v["nodes"], std::string("f-docs"));
        const auto manifest = cloud::buildManifest(plan, copies, 1762000123);
        checkJson(manifest, v["manifest"], "ссылка: список (manifest v1) — как web buildManifest");
    }
    for (const auto &c : v["urls"]) {
        const auto url = cloud::buildLinkUrl(str(c, "origin"), str(c, "id"), str(c, "key"));
        check(url == str(c, "url"), "ссылка: адрес " + str(c, "origin"), url);
    }
}

// ── Заметки ──────────────────────────────────────────────────────────────────

namespace notes = parvane::sections::notes;

static json propertiesJson(const notes::NoteProperties &properties) {
    json out = json::object();
    for (const auto &[key, value] : properties.entries) {
        if (value.isList) out[key] = value.list;
        else out[key] = value.scalar;
    }
    return out;
}

// Свойства — в порядке ключей объекта web (nlohmann::json сортирует ключи — сюда приходит упорядоченный разбор)
static notes::NoteProperties propertiesOf(const nlohmann::ordered_json &j) {
    notes::NoteProperties properties;
    for (const auto &[key, value] : j.items()) {
        if (value.is_array()) properties.set(key, notes::PropertyValue::items(value.get<std::vector<std::string>>()));
        else properties.set(key, notes::PropertyValue::text(value.get<std::string>()));
    }
    return properties;
}

static json parsedJson(const notes::ParsedNote &parsed) {
    auto tasks = json::array();
    for (const auto &t : parsed.tasks) {
        json task{{"line", t.line}, {"isDone", t.isDone}, {"text", t.text}};
        if (t.marker) task["marker"] = *t.marker;
        tasks.push_back(task);
    }
    return json{{"properties", propertiesJson(parsed.properties)}, {"body", parsed.body}, {"links", parsed.links},
                {"tags", parsed.tags}, {"tasks", tasks}, {"preview", parsed.preview}};
}

static notes::MakeId idSequence() {
    static const std::vector<std::string> ids = {"aaaaa", "7f3a1", "bbbbb", "ccccc", "ddddd", "eeeee"};
    auto i = std::make_shared<size_t>(0);
    return [i] { return ids[(*i)++ % ids.size()]; };
}

static std::vector<cloud::CloudNode> folderNodes(const json &tree) {
    std::vector<cloud::CloudNode> out;
    for (const auto &n : tree) {
        cloud::CloudNode node;
        node.id = str(n, "id");
        node.kind = str(n, "kind");
        node.name = str(n, "name");
        node.parent = optStr(n, "parent");
        node.trashed = n.value("trashed", false);
        out.push_back(node);
    }
    return out;
}

static json groupsJson(const std::vector<notes::NoteGroup> &groups) {
    auto out = json::array();
    for (const auto &g : groups) {
        auto items = json::array();
        for (const auto &i : g.items) items.push_back(json{{"title", i.title}, {"folder", i.folder}, {"isDaily", i.isDaily}});
        json group{{"key", g.key}, {"folder", g.folder}, {"isDaily", g.isDaily}, {"items", items}, {"hidden", g.hidden}};
        if (g.folderId) group["folderId"] = *g.folderId;
        out.push_back(group);
    }
    return out;
}

static void notesVector() {
    const auto v = loadVector("sections-notes-web.json");
    if (v.empty()) return;

    for (const auto &c : v["notes"]) {
        checkJson(parsedJson(notes::parseNote(str(c, "text"))), c["parsed"], "заметки: разбор " + brief(c["text"]));
    }
    // Порядок ключей свойств важен для записи — этот блок читается из файла упорядоченным разбором
    const auto orderedVector = nlohmann::ordered_json::parse(readText(vectorPath("sections-notes-web.json")));
    for (const auto &c : orderedVector["serialize"]) {
        const auto text = notes::serializeNote(propertiesOf(c["properties"]), str(c, "body"));
        check(text == str(c, "text"), "заметки: запись свойств " + brief(c["properties"]), text);
        checkJson(propertiesJson(notes::parseNote(text).properties), c["reparsed"], "заметки: записанные свойства читаются обратно");
    }

    std::vector<notes::NoteSource> sources;
    for (const auto &s : v["sources"]) {
        sources.push_back(notes::NoteSource{str(s, "id"), str(s, "title"), str(s, "folder"), str(s, "text"), s.value("updatedAt", 0.0)});
    }
    const notes::NotesIndex index(sources);
    const auto &idx = v["index"];
    {
        auto got = json::array();
        for (const auto &n : index.notes()) {
            got.push_back(json{{"id", n.id}, {"linkedIds", n.linkedIds}, {"unresolved", n.unresolved}, {"links", n.parsed.links}});
        }
        checkJson(got, idx["notes"], "указатель: связи заметок");
    }
    for (const auto &c : idx["byTitle"]) {
        const auto *note = index.byTitle(str(c, "title"));
        const auto got = note ? json(note->id) : json(nullptr);
        checkJson(got, c["id"], "указатель: по названию «" + str(c, "title") + "»");
    }
    for (const auto &c : idx["backlinks"]) {
        auto got = json::array();
        for (const auto *n : index.backlinks(str(c, "id"))) got.push_back(n->id);
        checkJson(got, c["ids"], "указатель: обратные ссылки " + str(c, "id"));
    }
    {
        auto unresolved = json::array();
        for (const auto &u : index.unresolved()) unresolved.push_back(json{{"title", u.title}, {"fromIds", u.fromIds}});
        checkJson(unresolved, idx["unresolved"], "указатель: несуществующие заметки");
        auto tags = json::array();
        for (const auto &t : index.tags()) tags.push_back(json{{"tag", t.tag}, {"count", t.count}});
        checkJson(tags, idx["tags"], "указатель: теги");
    }
    for (const auto &c : idx["search"]) {
        auto got = json::array();
        for (const auto *n : index.search(str(c, "query"))) got.push_back(n->id);
        checkJson(got, c["ids"], "указатель: поиск «" + str(c, "query") + "»");
    }

    const auto &edits = v["edits"];
    for (const auto &c : edits["setTaskDone"]) {
        const auto got = notes::setTaskDone(str(c, "text"), c.value("line", 0), c.value("isDone", false));
        check(got == str(c, "result"), "правки: отметка пункта в строке " + std::to_string(c.value("line", 0)));
    }
    for (const auto &c : edits["ensureTaskMarker"]) {
        const auto got = notes::ensureTaskMarker(str(c, "text"), c.value("line", 0), idSequence());
        json gotJson{{"text", got.text}};
        if (got.marker) gotJson["marker"] = *got.marker;
        checkJson(gotJson, c["result"], "правки: метка пункта в строке " + std::to_string(c.value("line", 0)));
    }
    for (const auto &c : edits["findTaskLine"]) {
        const auto got = notes::findTaskLine(str(c, "text"), str(c, "marker"));
        checkJson(got ? json(*got) : json(nullptr), c["line"], "правки: строка пункта по метке " + str(c, "marker"));
    }
    {
        const auto &c = edits["findInSecond"];
        const auto got = notes::findTaskLine(str(c, "text"), str(c, "marker"));
        checkJson(got ? json(*got) : json(nullptr), c["line"], "правки: метка с возвратом каретки в конце строки");
    }
    for (const auto &c : edits["removeTaskLine"]) {
        const auto got = notes::removeTaskLine(str(c, "text"), str(c, "marker"));
        check(got == str(c, "result"), "правки: удаление пункта по метке " + str(c, "marker"));
    }
    for (const char *name : {"dedupe", "dedupeClean"}) {
        const auto &c = edits[name];
        const auto got = notes::dedupeTaskMarkers(str(c, "text"), idSequence());
        auto changes = json::array();
        for (const auto &ch : got.changes) {
            changes.push_back(json{{"line", ch.line}, {"oldMarker", ch.oldMarker}, {"newMarker", ch.newMarker}});
        }
        checkJson(json{{"text", got.text}, {"changes", changes}}, c["result"], std::string("правки: повторные метки — ") + name);
    }
    for (const auto &c : edits["rename"]) {
        const auto got = notes::renameLinks(str(c, "text"), str(c, "from"), str(c, "to"));
        check(got == str(c, "result"), "правки: переименование ссылок " + str(c, "from") + " → " + str(c, "to"));
    }
    {
        const auto &c = edits["daily"];
        check(notes::dailyNoteTitle(str(c, "day")) == str(c, "title") && notes::dailyNoteTemplate(str(c, "day")) == str(c, "template"),
              "правки: заметка дня — название и шаблон");
    }

    const auto &folders = v["folders"];
    const auto tree = folderNodes(folders["tree"]);
    const auto vaultId = str(folders, "vaultId");
    {
        auto list = json::array();
        for (const auto &f : notes::listNoteFolders(tree, vaultId)) list.push_back(json{{"id", f.id}, {"path", f.path}, {"name", f.name}});
        checkJson(list, folders["list"], "папки: перечень папок хранилища");
        auto other = json::array();
        for (const auto &f : notes::listNoteFolders(tree, "outside")) other.push_back(json{{"id", f.id}, {"path", f.path}, {"name", f.name}});
        checkJson(other, folders["listOther"], "папки: перечень другого корня");
    }
    for (const auto &c : folders["captions"]) {
        check(notes::folderCaption(str(c, "path")) == str(c, "caption"), "папки: подпись «" + str(c, "path") + "»");
    }
    for (const auto &c : folders["isIn"]) {
        check(notes::isInFolder(str(c, "noteFolder"), str(c, "path")) == c.value("result", false),
              "папки: «" + str(c, "noteFolder") + "» внутри «" + str(c, "path") + "»");
    }
    for (const auto &c : folders["names"]) {
        const auto error = notes::checkFolderName(str(c, "name"), c["siblings"].get<std::vector<std::string>>());
        const std::string got = !error ? "" : *error == notes::FolderNameError::BadName ? "bad-name" : "taken";
        const auto want = at(c, "error").is_string() ? c["error"].get<std::string>() : std::string();
        check(got == want, "папки: проверка названия " + brief(c["name"]), got);
    }
    for (const auto &c : folders["contents"]) {
        const auto got = notes::folderContents(tree, str(c, "id"));
        checkJson(json{{"notes", idsOf(got.notes)}, {"others", idsOf(got.others)}},
                  json{{"notes", c["notes"]}, {"others", c["others"]}}, "папки: содержимое " + str(c, "id"));
    }
    for (const auto &c : folders["groups"]) {
        notes::NoteGroupsInput input;
        for (const auto &n : {std::pair{"Огород", "Дом"}, std::pair{"Теплица", "Дом/Участок"}, std::pair{"рассада", ""}}) {
            input.notes.push_back(notes::GroupedNote{n.first, n.first, n.second, false});
        }
        input.notes.push_back(notes::GroupedNote{"2026-11-03", "2026-11-03", "Дневник", true});
        input.notes.push_back(notes::GroupedNote{"2026-11-01", "2026-11-01", "Дневник", true});
        input.notes.push_back(notes::GroupedNote{"не день", "не день", "Дневник", true});
        input.notes.push_back(notes::GroupedNote{"Потерянная", "Потерянная", "Старое", false});
        input.folders = notes::listNoteFolders(tree, vaultId);
        input.dailyFolders = {"Дневник"};
        input.isSearch = c.value("isSearch", false);
        if (at(c, "dailyShown").is_number()) input.dailyShown = c["dailyShown"].get<int>();
        checkJson(groupsJson(notes::buildNoteGroups(input)), c["result"],
                  std::string("папки: группы списка (поиск: ") + (input.isSearch ? "да" : "нет") + ")");
    }
}

// ── Холст ────────────────────────────────────────────────────────────────────

static notes::CanvasJson toOrdered(const json &value) {
    return notes::CanvasJson::parse(value.dump());
}

static notes::CanvasPatch patchOf(const json &j) {
    notes::CanvasPatch patch;
    for (const auto &[key, value] : j.items()) {
        if (value.is_null()) patch.emplace_back(key, std::nullopt);
        else patch.emplace_back(key, toOrdered(value));
    }
    return patch;
}

static json rectJson(const notes::CanvasRect &r) {
    return json{{"x", r.x}, {"y", r.y}, {"width", r.width}, {"height", r.height}};
}

static notes::CanvasRect rectOf(const json &j) {
    return notes::CanvasRect{j.value("x", 0.0), j.value("y", 0.0), j.value("width", 0.0), j.value("height", 0.0)};
}

static json viewJson(const notes::CanvasView &view) {
    return json{{"scale", view.scale}, {"x", view.x}, {"y", view.y}};
}

static json anchorJson(const notes::CanvasAnchor &a) {
    return json{{"x", a.x}, {"y", a.y}, {"side", notes::canvasSideName(a.side)}};
}

static void canvasVector() {
    const auto v = loadVector("sections-canvas-web.json");
    if (v.empty()) return;

    for (const auto &c : v["files"]) {
        const auto parsed = notes::parseCanvas(str(c, "text"));
        const std::string error = !parsed.error ? "" : *parsed.error == notes::CanvasParseError::Json ? "json" : "shape";
        const auto wantError = at(c, "error").is_string() ? c["error"].get<std::string>() : std::string();
        check(error == wantError, "холст: исход разбора " + brief(c["text"]), error);
        checkJson(json{{"nodes", parsed.dropped.nodes}, {"edges", parsed.dropped.edges}}, c["dropped"],
                  "холст: сколько выброшено " + brief(c["text"]));
        const auto serialized = notes::serializeCanvas(parsed.doc);
        check(serialized == str(c, "serialized"), "холст: файл web пишется байт в байт " + brief(c["text"]),
              serialized == str(c, "serialized") ? "" : serialized.substr(0, 400));
        check(notes::serializeCanvas(notes::parseCanvas(serialized).doc) == serialized, "холст: повторная запись та же");
    }

    const auto base = notes::parseCanvas(str(v["files"][0], "text")).doc;
    const auto makeId = [] { return std::string("edge-new-0001"); };
    std::map<std::string, std::function<notes::CanvasDoc(const notes::CanvasDoc &)>> ops;
    ops["addNode"] = [](const notes::CanvasDoc &d) {
        notes::CanvasNode node;
        node.id = "new";
        node.type = "text";
        node.x = 10.4;
        node.y = -3;
        node.width = 100;
        node.height = 50;
        node.set("text", "новый");
        return notes::addNode(d, node);
    };
    ops["addNode-duplicate"] = [](const notes::CanvasDoc &d) {
        notes::CanvasNode node;
        node.id = "txt";
        node.type = "text";
        node.width = 1;
        node.height = 1;
        return notes::addNode(d, node);
    };
    ops["updateNode"] = [](const notes::CanvasDoc &d) {
        return notes::updateNode(d, "txt", patchOf(json{{"text", "Грядки осенью"}, {"color", nullptr}, {"x", 25}, {"pvExtra", "да"}}));
    };
    ops["updateNode-missing"] = [](const notes::CanvasDoc &d) { return notes::updateNode(d, "nope", patchOf(json{{"text", "x"}})); };
    ops["addEdge"] = [&](const notes::CanvasDoc &d) { return notes::addEdge(d, "new", "txt", std::string("связь"), makeId); };
    ops["addEdge-loop"] = [&](const notes::CanvasDoc &d) { return notes::addEdge(d, "new", "new", std::nullopt, makeId); };
    ops["addEdge-duplicate"] = [&](const notes::CanvasDoc &d) { return notes::addEdge(d, "txt", "note", std::nullopt, makeId); };
    ops["updateEdge"] = [](const notes::CanvasDoc &d) {
        return notes::updateEdge(d, "e1", patchOf(json{{"label", ""}, {"toEnd", nullptr}, {"color", "5"}}));
    };
    ops["removeEdge"] = [](const notes::CanvasDoc &d) { return notes::removeEdge(d, "e2"); };
    ops["moveNode-group"] = [](const notes::CanvasDoc &d) { return notes::moveNode(d, "grp", 10.6, -20.5); };
    ops["moveNode-single"] = [](const notes::CanvasDoc &d) { return notes::moveNode(d, "web", -0.4, 0.5); };
    ops["removeNode"] = [](const notes::CanvasDoc &d) { return notes::removeNode(d, "note"); };
    auto doc = base;
    for (const auto &step : v["ops"]) {
        const auto name = str(step, "name");
        const auto it = ops.find(name);
        check(it != ops.end(), "холст: правка известна — " + name);
        if (it == ops.end()) continue;
        doc = it->second(doc);
        const auto serialized = notes::serializeCanvas(doc);
        check(serialized == str(step, "serialized"), "холст: после правки " + name + " — тот же файл, что у web",
              serialized == str(step, "serialized") ? "" : serialized.substr(0, 400));
    }
    {
        const auto &c = v["inGroup"];
        auto ids = json::array();
        for (const auto &n : notes::nodesInGroup(base, str(c, "group"))) ids.push_back(n.id);
        checkJson(ids, c["ids"], "холст: содержимое группы");
        auto none = json::array();
        for (const auto &n : notes::nodesInGroup(base, "txt")) none.push_back(n.id);
        checkJson(none, c["notGroup"], "холст: не группа — пусто");
    }

    const auto &g = v["geometry"];
    {
        const auto bounds = notes::boundsOf(base);
        checkJson(bounds ? rectJson(*bounds) : json(nullptr), g["bounds"], "геометрия: границы холста");
        check(!notes::boundsOf(notes::CanvasDoc{}), "геометрия: границы пустого холста — нет");
    }
    for (const auto &c : g["fit"]) {
        const auto bounds = at(c, "bounds").is_object() ? std::optional<notes::CanvasRect>(rectOf(c["bounds"])) : std::nullopt;
        const notes::CanvasViewport viewport{c["viewport"].value("width", 0.0), c["viewport"].value("height", 0.0)};
        const auto view = at(c, "padding").is_number() ? notes::fitView(bounds, viewport, c["padding"].get<double>())
                                                   : notes::fitView(bounds, viewport);
        checkJson(viewJson(view), c["view"], "геометрия: вписать " + brief(at(c, "bounds")));
    }
    for (const auto &c : g["firstGroup"]) {
        const auto d = notes::parseCanvas(str(c, "serialized")).doc;
        const notes::CanvasViewport viewport{c["viewport"].value("width", 0.0), c["viewport"].value("height", 0.0)};
        checkJson(viewJson(notes::firstGroupView(d, viewport)), c["view"], "геометрия: вид первой группы");
    }
    for (const auto &c : g["clamp"]) {
        check(notes::clampCanvasScale(c.value("scale", 0.0)) == c.value("clamped", 0.0), "геометрия: предел масштаба " + brief(c["scale"]));
    }
    for (const auto &c : g["sidePoints"]) {
        const auto side = notes::canvasSideFromName(str(c, "side"));
        const auto point = notes::sidePoint(notes::CanvasRect{0, 0, 100, 50}, side.value_or(notes::CanvasSide::Top));
        checkJson(json{{"x", point.x}, {"y", point.y}}, c["point"], "геометрия: середина стороны " + str(c, "side"));
    }
    for (const auto &c : g["anchors"]) {
        notes::CanvasSides sides;
        if (at(c, "sides").is_object()) {
            sides.fromSide = optStr(c["sides"], "fromSide");
            sides.toSide = optStr(c["sides"], "toSide");
        }
        const auto anchors = notes::edgeAnchors(rectOf(c["from"]), rectOf(c["to"]), sides);
        checkJson(json{{"from", anchorJson(anchors.from)}, {"to", anchorJson(anchors.to)}}, c["anchors"],
                  "геометрия: концы стрелки " + brief(at(c, "sides")));
    }
    for (const auto &c : g["ids"]) {
        const auto values = c["values"].get<std::vector<double>>();
        auto i = std::make_shared<size_t>(0);
        const auto id = notes::newCanvasId([values, i] { return values[(*i)++ % values.size()]; });
        check(id == str(c, "id"), "геометрия: id из последовательности " + brief(c["values"]), id);
    }
}

int main() {
    std::printf("=== parvane-core webcompat sections tests (векторы web → desktop, без стека) ===\n");
    plannerVector();
    cloudVector();
    notesVector();
    canvasVector();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
