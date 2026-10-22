// Parvane fork (spec 029, T034): хранилище «Знаний» — порт web `notes/notesStore.test.ts` 1:1 поверх облака-заглушки:
// дерево личного диска в памяти, запись текста создаёт либо заменяет узел. Проверяется запись с карточки холста,
// когда заметку за время правки удалили, и скупая работа с деревом облака. Плюс проверки файла-отметки справки,
// папок заметок и кэша текстов устройства (своё, не из web).
#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "parvane/sections/notes_store.h"

using nlohmann::json;
using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

namespace {

const std::string DRIVE = "drive";
const std::string VAULT = "Знания";

json folder(const std::string &id, const std::string &name, const std::string &parent = {}) {
    json n{{"id", id}, {"kind", "folder"}, {"name", name}, {"size", 0}, {"mime", ""}, {"mtime", 1},
           {"trashed", false}, {"trashTop", false}, {"trashedAt", 0}};
    if (!parent.empty()) n["parent"] = parent;
    return n;
}

json file(const std::string &id, const std::string &name, const std::string &parent = {}) {
    auto n = folder(id, name, parent);
    n["kind"] = "file";
    n["size"] = 10;
    n["blob"] = json{{"fileId", id + "-v0"}};
    return n;
}

json stateWith(const json &nodes) {
    return json{{"status", "ready"}, {"rootId", DRIVE}, {"containers", json::array()},
                {"trees", {{DRIVE, {{"name", ""}, {"count", nodes.size()}, {"nodes", nodes}}}}}};
}

json trashed(json n) {
    n["trashed"] = true;
    n["trashTop"] = true;
    n["trashedAt"] = 5;
    return n;
}

// Облако-заглушка: то, что в web мок `callApi` + мок `cloudStore`
class Fake : public NotesHost {
public:
    json data;
    std::map<std::string, std::string> texts;
    std::vector<json> writes;
    int count = 0;
    int reads = 0;
    parvane::sections::domain::MemoryRecords records;
    bool withCache = false;

    json &treeNodes() { return data["trees"][DRIVE]["nodes"]; }
    std::string drive = "synced";
    std::vector<json> applied;

    // Правки дерева (create / move / trash) — как их применил бы движок
    json applyOps(const json &args) {
        applied.push_back(args);
        json nodes = treeNodes();
        for (const auto &op : args["ops"]) {
            const auto kind = op["op"].get<std::string>();
            if (kind == "create") {
                nodes.push_back(folder(op["id"], op["name"], op.value("parent", std::string())));
                continue;
            }
            for (auto &n : nodes) {
                if (n["id"] != op["id"]) continue;
                if (kind == "trash") n = trashed(n);
                if (kind == "move") {
                    n["name"] = op["name"];
                    if (op.contains("parent")) n["parent"] = op["parent"];
                    else n.erase("parent");
                }
            }
        }
        data = stateWith(nodes);
        return json{{"ok", true}, {"container", DRIVE}};
    }

    std::string blobOf(const std::string &id) {
        for (const auto &n : treeNodes()) {
            if (n["id"] == id && n.contains("blob")) return n["blob"].value("fileId", std::string());
        }
        return {};
    }

    std::optional<json> callParvane(const std::string &method, const json &args) override {
        if (method == "parvaneCloudState") return data;
        if (method == "parvaneCloudReadText") {
            ++reads;
            const auto node = args.value("node", std::string());
            const auto it = texts.find(node);
            if (it == texts.end()) return json();
            return json{{"text", it->second}, {"fileId", blobOf(node)}};
        }
        if (method == "parvaneCloudCheckDrive") return json(drive);
        if (method == "parvaneCloudApply") return applyOps(args);
        if (method != "parvaneCloudWriteText") return json();
        writes.push_back(args);
        const auto id = args.contains("node") ? args["node"].get<std::string>()
            : args.contains("newNodeId") ? args["newNodeId"].get<std::string>() : "new" + std::to_string(++count);
        texts[id] = args.value("text", std::string());
        json previous;
        json nodes = json::array();
        for (const auto &n : treeNodes()) {
            if (n["id"] == id) previous = n;
            else nodes.push_back(n);
        }
        const auto fileId = id + "-v" + std::to_string(writes.size());
        auto node = file(id, args.value("name", std::string()),
                         previous.is_object() ? previous.value("parent", std::string()) : args.value("parent", std::string()));
        if (previous.is_object()) node.update(previous);
        node["blob"] = json{{"fileId", fileId}};
        nodes.push_back(node);
        data = stateWith(nodes);
        return json{{"ok", true}, {"node", id}, {"fileId", fileId}};
    }
    int64_t nowMs() override { return 1'000'000; }
    std::string today() override { return "2026-10-18"; }
    double nowMinutes() override { return 600; }
    parvane::sections::domain::RecordStore *textCache() override { return withCache ? &records : nullptr; }
    parvane::sections::planner::State plannerState() override {
        parvane::sections::planner::State s;
        s.settings.dayStart = 480;
        s.settings.dayEnd = 1320;
        return s;
    }
};

const json TREE = json::array({folder("v", VAULT), folder("f", "Проекты", "v"), file("n1", "Идея.md", "f"),
                               file("n2", "План.md", "v")});
const std::map<std::string, std::string> TEXTS = {{"n1", "# Идея\n\nстарое\n"}, {"n2", "# План\n"}};
const std::string DRAFT = "# Идея\n\nстарое\nнабрано на карточке\n";

void open(Fake &fake, NotesStore &store, const json &nodes, const std::map<std::string, std::string> &texts) {
    fake.texts = texts;
    fake.writes.clear();
    fake.data = stateWith(nodes);
    store.setCloudData(fake.data);
    store.loadNotes("user");
}

void setCloud(Fake &fake, NotesStore &store, const json &nodes) {
    fake.data = stateWith(nodes);
    store.setCloudData(fake.data);
}

// Заметку удалили: узел в корзине, хранилище это уже увидело
void trash(Fake &fake, NotesStore &store, const std::string &id) {
    json nodes = json::array();
    for (auto n : fake.treeNodes()) nodes.push_back(n["id"] == id ? trashed(n) : n);
    setCloud(fake, store, nodes);
    store.loadNotes("user");
}

NoteRef noteById(const NotesStore &store, const std::string &id) {
    for (const auto &n : store.notes()) {
        if (n->id == id) return n;
    }
    return nullptr;
}

bool matches(const json &actual, const json &expected) {
    for (const auto &[k, v] : expected.items()) {
        if (!actual.contains(k)) return false;
        if (v.is_object()) {
            if (!matches(actual[k], v)) return false;
        } else if (actual[k] != v) {
            return false;
        }
    }
    return true;
}

} // namespace

int main() {
    std::printf("=== notes_store: запись с карточки холста ===\n");
    {
        Fake fake;
        NotesStore store(fake);
        open(fake, store, TREE, TEXTS);
        const auto result = store.saveNoteOrRestore("n1", "Идея", DRAFT, VAULT, TEXTS.at("n1"));
        check(result == NoteSaveResult{"saved", "", ""} && matches(fake.writes.back(), {{"node", "n1"}, {"text", DRAFT}})
                  && noteById(store, "n1") && noteById(store, "n1")->text == DRAFT,
              "живая заметка сохраняется как обычно");
    }
    {
        Fake fake;
        NotesStore store(fake);
        open(fake, store, TREE, TEXTS);
        trash(fake, store, "n1");
        bool ok = !noteById(store, "n1");
        // Прежний путь терял набранное: заметки нет — запись молча не делалась
        ok = ok && !store.saveNote("n1", DRAFT, VAULT, TEXTS.at("n1")) && fake.writes.empty();
        const auto result = store.saveNoteOrRestore("n1", "Идея", DRAFT, VAULT, TEXTS.at("n1"));
        ok = ok && result == NoteSaveResult{"restored", "new1", "Идея"};
        ok = ok && matches(fake.writes.back(), {{"parent", "f"}, {"name", "Идея.md"}, {"text", DRAFT}})
            && !fake.writes.back().contains("node");
        const auto restored = noteById(store, "new1");
        ok = ok && restored && restored->title == "Идея" && restored->folder == "Проекты" && restored->text == DRAFT;
        // Удалённая заметка осталась в корзине нетронутой
        json n1;
        for (const auto &n : fake.treeNodes()) {
            if (n["id"] == "n1") n1 = n;
        }
        ok = ok && matches(n1, {{"trashed", true}, {"blob", {{"fileId", "n1-v0"}}}});
        check(ok, "заметку удалили за время правки: текст ложится в новую заметку с тем же названием и в той же папке");
    }
    {
        Fake fake;
        NotesStore store(fake);
        auto tree = TREE;
        tree.push_back(file("n3", "Идея.md", "v"));
        auto texts = TEXTS;
        texts["n3"] = "# Идея\n\nдругая\n";
        open(fake, store, tree, texts);
        trash(fake, store, "n1");
        const auto result = store.saveNoteOrRestore("n1", "Идея", DRAFT, VAULT, TEXTS.at("n1"));
        check(result.status == "restored" && result.title == "Идея 2"
                  && matches(fake.writes.back(), {{"name", "Идея 2.md"}, {"text", DRAFT}}) && noteById(store, "n3")
                  && noteById(store, "n3")->text == "# Идея\n\nдругая\n",
              "название успела занять другая заметка — восстановленная получает номер");
    }
    {
        Fake fake;
        NotesStore store(fake);
        open(fake, store, TREE, TEXTS);
        const auto before = store.notes();
        bool ok = before.size() == 2 && before[0]->id == "n1" && before[1]->id == "n2";
        const auto rev = store.notesRevision();
        const auto foldersRev = store.foldersRevision();
        // Новый объект дерева с тем же содержимым (эхо облака): проход не меняет список
        setCloud(fake, store, fake.treeNodes());
        store.loadNotes("user");
        ok = ok && store.notes() == before && store.notesRevision() == rev;
        // Тот же объект дерева — проход пропускается вовсе (тексты не перечитываются)
        const auto reads = fake.reads;
        store.loadNotes("user");
        ok = ok && store.notes() == before && fake.reads == reads;
        // Изменилась одна заметка: её объект новый, остальные прежние; тексты читаются только для неё
        fake.texts["n2"] = "# План\n\nновое\n";
        json nodes = json::array();
        for (auto n : fake.treeNodes()) {
            if (n["id"] == "n2") {
                n["mtime"] = 9;
                n["blob"] = json{{"fileId", "n2-v1"}};
            }
            nodes.push_back(n);
        }
        setCloud(fake, store, nodes);
        store.loadNotes("user");
        ok = ok && store.notesRevision() == rev + 1 && fake.reads == reads + 1;
        ok = ok && noteById(store, "n1") == before[0];
        const auto n2 = noteById(store, "n2");
        ok = ok && n2 && n2->text == "# План\n\nновое\n" && n2->fileId == "n2-v1";
        ok = ok && store.foldersRevision() == foldersRev;
        check(ok, "то же дерево заново и дерево с одной правкой: прежние объекты заметок, setNotes лишний раз нет");
    }
    {
        Fake fake;
        NotesStore store(fake);
        open(fake, store, TREE, TEXTS);
        const auto before = store.notes();
        fake.texts["n1"] = "# Идея\n\nправка с другого устройства\n";
        json nodes = json::array();
        for (auto n : fake.treeNodes()) {
            if (n["id"] == "n1") n["blob"] = json{{"fileId", "n1-v1"}};
            nodes.push_back(n);
        }
        setCloud(fake, store, nodes);
        bool ok = store.notes() == before;
        const auto release = store.retainNotes();
        ok = ok && noteById(store, "n1")->text == "# Идея\n\nправка с другого устройства\n";
        release();
        check(ok, "без потребителей изменение облака лишь помечает хранилище; удержание применяет его");
    }
    {
        Fake fake;
        NotesStore store(fake);
        open(fake, store, TREE, TEXTS);
        json nodes = json::array();
        for (auto n : fake.treeNodes()) {
            if (n["id"] == "f") n = trashed(n);
            else if (n["id"] == "n1") n["trashed"] = true;
            nodes.push_back(n);
        }
        setCloud(fake, store, nodes);
        store.loadNotes("user");
        const auto result = store.saveNoteOrRestore("n1", "Идея", DRAFT, VAULT, TEXTS.at("n1"));
        check(result.status == "restored" && result.title == "Идея"
                  && matches(fake.writes.back(), {{"parent", "v"}, {"name", "Идея.md"}}),
              "папки заметки тоже нет — восстановленная заметка ложится в корень хранилища");
    }

    std::printf("=== notes_store: своё (не из web) ===\n");
    {
        check(guideMarkerNodeId() == "70617276616e652d67756964652d6d6b", "постоянный узел отметки справки");
        check(buildGuideMarker("ru", 42) == "{\"version\":1,\"createdAt\":42,\"lang\":\"ru\"}\n",
              "содержимое файла-отметки — как JSON.stringify web");
        std::vector<CloudNode> nodes = {json(folder("v", VAULT)).get<CloudNode>(),
                                        json(file("m", ".parvane-guide.json", "v")).get<CloudNode>()};
        check(hasGuideMarker(nodes, kVaultNames), "отметка по имени файла в корне хранилища");
        nodes[1].parent = "x";
        check(!hasGuideMarker(nodes, kVaultNames), "файл с тем же именем вне хранилища — не отметка");
    }
    {
        std::vector<CloudNode> nodes;
        for (const auto &n : json::array({folder("v", VAULT), folder("b", "Б", "v"), folder("a", "А", "v"),
                                          folder("a2", "Вложенная", "a"), trashed(folder("t", "Корзина", "v")),
                                          folder("o", "Вне"), file("x", "x.md", "a2"), file("y", "y.png", "a")})) {
            nodes.push_back(n.get<CloudNode>());
        }
        const auto folders = listNoteFolders(nodes, "v");
        check(folders.size() == 3 && folders[0].path == "А" && folders[1].path == "А/Вложенная" && folders[2].path == "Б",
              "папки хранилища: вложенные, без корзины и чужих, по пути");
        check(checkFolderName(" А", {}) == FolderNameError::BadName
                  && checkFolderName("б", {"Б"}) == FolderNameError::Taken && !checkFolderName("В", {"Б"}),
              "название папки: пробелы по краям, занятое без учёта регистра");
        const auto inside = folderContents(nodes, "a");
        check(inside.notes.size() == 1 && inside.notes[0].id == "x" && inside.others.size() == 1, "содержимое папки на любой глубине");
    }
    {
        Fake fake;
        fake.withCache = true;
        {
            NotesStore store(fake);
            open(fake, store, TREE, TEXTS);
        }
        const auto reads = fake.reads;
        NotesStore again(fake);
        again.setCloudData(fake.data);
        again.loadNotes("user");
        check(fake.reads == reads && again.notes().size() == 2, "кэш текстов устройства: второй запуск не читает тексты из облака");
    }
    {
        Fake fake;
        NotesStore store(fake);
        open(fake, store, TREE, TEXTS);
        check(store.freeNoteTitle("n2", "идея") == "идея 2" && store.freeNoteTitle("n1", "Идея") == "Идея"
                  && store.freeNoteTitle("n1", " a/b ") == "a b",
              "свободное название заметки: занятое — с номером, запрещённые знаки — пробелами");
    }

    {
        // Новый аккаунт: личный диск пуст — справка создаёт хранилище, папку справки, заметки и отметку
        Fake fake;
        NotesStore store(fake);
        fake.data = stateWith(json::array());
        store.setCloudData(fake.data);
        store.loadNotes("user", NotesOptions{"ru", VAULT});
        const auto guide = buildGuide("ru");
        bool ok = fake.applied.size() == 1 && fake.applied[0]["ops"].size() == 2
            && fake.applied[0]["ops"][0]["id"] == kVaultNodeId && fake.applied[0]["ops"][0]["name"] == VAULT
            && fake.applied[0]["ops"][1]["id"] == guideFolderNodeId();
        ok = ok && fake.writes.size() == guide.notes.size() + 1;
        ok = ok && fake.writes.front()["parent"] == guideFolderNodeId()
            && fake.writes.front()["newNodeId"] == guide.notes.front().nodeId;
        ok = ok && fake.writes.back()["name"] == kGuideMarkerName && fake.writes.back()["newNodeId"] == guideMarkerNodeId()
            && fake.writes.back()["text"] == buildGuideMarker("ru", 1'000'000);
        std::string overviewId;
        for (const auto &n : guide.notes) {
            if (n.key == "overview") overviewId = n.nodeId;
        }
        ok = ok && store.guideOpenId() == std::optional<std::string>(overviewId);
        ok = ok && store.notes().size() == guide.notes.size();
        // Отметка легла — новое изменение облака справку не трогает
        const auto writes = fake.writes.size();
        setCloud(fake, store, fake.treeNodes());
        store.loadNotes("user");
        ok = ok && fake.writes.size() == writes;
        check(ok, "справка при первом запуске: хранилище, папка, заметки с постоянными узлами, отметка; «Обзор» открывается");
        store.consumeGuideOpen();
        check(!store.guideOpenId(), "раздел показал справку — больше её не открывать");
        check(store.restoreGuide() == std::optional<std::string>(overviewId) && fake.writes.size() == writes,
              "справка по кнопке, когда «Обзор» есть, — ничего не пишет");
    }
    {
        Fake fake;
        fake.drive = "unknown";
        NotesStore store(fake);
        fake.texts = TEXTS;
        fake.data = stateWith(TREE);
        store.setCloudData(fake.data);
        store.loadNotes("user", NotesOptions{"ru", VAULT});
        check(fake.writes.empty() && fake.applied.empty(), "диск не сверен с сервером — справку не создаём");
    }
    {
        // В хранилище уже есть заметки пользователя — справка ложится рядом, «Обзор» сам не открывается
        Fake fake;
        NotesStore store(fake);
        fake.texts = TEXTS;
        fake.data = stateWith(TREE);
        store.setCloudData(fake.data);
        store.loadNotes("user", NotesOptions{"ru", VAULT});
        check(!fake.writes.empty() && fake.writes.back()["name"] == kGuideMarkerName && !store.guideOpenId(),
              "справка в существующем хранилище: отметка поставлена, «Обзор» не открывается");
    }
    {
        Fake fake;
        NotesStore store(fake);
        auto texts = TEXTS;
        texts["n2"] = "# План\n\nсм. [[Идея]]\n";
        open(fake, store, TREE, texts);
        check(store.deleteNoteFolder("f") == "has-notes" && fake.applied.empty(), "папка с заметками без режима — отказ");
        const bool renamed = store.renameNote("n1", "Мысль", VAULT);
        bool ok = renamed && fake.applied.size() == 1
            && fake.applied[0]["ops"][0] == json({{"op", "move"}, {"id", "n1"}, {"name", "Мысль.md"}, {"parent", "f"}});
        ok = ok && noteById(store, "n1") && noteById(store, "n1")->title == "Мысль" && noteById(store, "n2")
            && noteById(store, "n2")->text == "# План\n\nсм. [[Мысль]]\n";
        check(ok, "переименование заметки: узел с новым именем, ссылки в других заметках правятся");
        ok = store.deleteNote("n1") && fake.applied.back()["ops"][0]["op"] == "trash"
            && fake.applied.back()["ops"][0]["at"] == 1'000'000 && !noteById(store, "n1");
        check(ok, "удаление заметки — в корзину облака");
        const auto created = store.createNoteFolder("Архив", VAULT);
        ok = created.id && fake.applied.back()["ops"][0]["parent"] == "v" && fake.applied.back()["ops"][0]["name"] == "Архив"
            && std::any_of(store.folders().begin(), store.folders().end(), [](const NoteFolder &f) { return f.path == "Архив"; });
        check(ok, "новая папка в корне хранилища");
        check(store.createNoteFolder("архив", VAULT).id == created.id, "папка с таким названием уже есть — возвращается она");
        check(store.deleteNoteFolder("v") == "failed", "хранилище — не папка заметок");
        check(store.deleteNoteFolder("f") == "done"
                  && std::none_of(store.folders().begin(), store.folders().end(), [](const NoteFolder &f) { return f.id == "f"; }),
              "пустая папка (заметка уже в корзине) уходит в корзину");
    }

    std::printf("=== notes_store: смена аккаунта (ревью 21 окт 2026, вечер) ===\n");
    {
        Fake fake;
        NotesStore store(fake);
        open(fake, store, TREE, TEXTS);
        bool ok = store.notes().size() == 2 && store.cloudData() != nullptr;
        const auto rev = store.revision();
        store.signOut();
        ok = ok && store.notes().empty() && store.canvases().empty() && store.folders().empty()
            && store.cloudData() == nullptr && store.revision() > rev && store.status() == NotesStatus::Loading;
        // Облако прежнего аккаунта, пришедшее после выхода, хранилище не наполняет
        const auto reads = fake.reads;
        store.setCloudData(fake.data);
        ok = ok && store.notes().empty() && fake.reads == reads;
        check(ok, "выход: заметки, облако и тексты прежнего аккаунта сброшены, облако не слушается");
        // Вход другим (хаб снова сбрасывает хранилище при смене сессии): облако — его, заметки прежнего не возвращаются
        store.signOut();
        fake.data = stateWith(json::array({folder("v", VAULT), file("m1", "Другое.md", "v")}));
        fake.texts = {{"m1", "# Другое\n"}};
        store.loadNotes("other");
        ok = store.notes().size() == 1 && store.notes()[0]->id == "m1" && !noteById(store, "n1");
        check(ok, "вход другим аккаунтом: только его заметки");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
