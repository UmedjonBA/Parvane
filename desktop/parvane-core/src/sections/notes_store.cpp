// Parvane fork (spec 029, T034): хранилище «Знаний» — порт web `notes/notesStore.ts`, см. notes_store.h.
#include "parvane/sections/notes_store.h"

#include <algorithm>
#include <cstdio>
#include <random>

#include "notes_text.h"
#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_canvas_graph.h"
#include "parvane/sections/notes_merge.h"
#include "parvane/sections/notes_tasks.h"

namespace parvane::sections::notes {

namespace {

using text::decode;
using text::encode;

constexpr int kLoadParallel = 4; // в web — сколько запросов разом; здесь только размер шага

const std::vector<CloudNode> kNoNodes;

std::string parentOf(const CloudNode &node) {
    return node.parent.value_or(std::string());
}

bool contains(const std::vector<std::string> &list, const std::string &value) {
    return std::find(list.begin(), list.end(), value) != list.end();
}

bool endsWith(const std::string &s, const std::string &suffix) {
    return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

// Сравнение по кодовым единицам UTF-16 (`<` строк JS)
std::u16string utf16Of(const std::string &s) {
    std::u16string out;
    for (const char32_t c : decode(s)) {
        if (c > 0xFFFF) {
            const char32_t v = c - 0x10000;
            out.push_back(static_cast<char16_t>(0xD800 + (v >> 10)));
            out.push_back(static_cast<char16_t>(0xDC00 + (v & 0x3FF)));
        } else {
            out.push_back(static_cast<char16_t>(c));
        }
    }
    return out;
}

bool jsLess(const std::string &a, const std::string &b) {
    return utf16Of(a) < utf16Of(b);
}

// /^\d{4}-\d{2}-\d{2}$/
bool isDayKey(const std::string &s) {
    if (s.size() != 10) return false;
    for (size_t i = 0; i < s.size(); ++i) {
        const bool dash = i == 4 || i == 7;
        if (dash ? s[i] != '-' : !(s[i] >= '0' && s[i] <= '9')) return false;
    }
    return true;
}

std::optional<std::string> blobFileId(const CloudNode &node) {
    if (!node.blob || !node.blob->is_object()) return std::nullopt;
    const auto it = node.blob->find("fileId");
    if (it == node.blob->end() || !it->is_string() || it->get<std::string>().empty()) return std::nullopt;
    return it->get<std::string>();
}

json blobJson(const CloudNode &node) {
    return node.blob ? *node.blob : json();
}

const CloudNode *findById(const std::vector<CloudNode> &nodes, const std::string &id) {
    for (const auto &n : nodes) {
        if (n.id == id) return &n;
    }
    return nullptr;
}

std::optional<CloudNode> findVault(const std::vector<CloudNode> &nodes) {
    for (const auto &n : nodes) {
        if (n.isFolder() && parentOf(n).empty() && !n.trashed && contains(kVaultNames, n.name)) return n;
    }
    return std::nullopt;
}

// Пути папок от хранилища по id папки (`""` — само хранилище, nullopt — вне хранилища либо в корзине)
class FolderPaths {
public:
    FolderPaths(const std::vector<CloudNode> &nodes, const std::string &vaultId) : count_(nodes.size()) {
        for (const auto &n : nodes) byId_.emplace(n.id, &n);
        paths_[vaultId] = std::string();
    }
    std::optional<std::string> pathOf(const std::string &id, size_t depth = 0) {
        if (const auto it = paths_.find(id); it != paths_.end()) return it->second;
        const auto it = byId_.find(id);
        const CloudNode *node = it == byId_.end() ? nullptr : it->second;
        std::optional<std::string> result;
        // Предел глубины — защита от цикла в повреждённом дереве; заметки папки в корзине в хранилище не входят
        if (node && !parentOf(*node).empty() && !node->trashed && depth <= count_) {
            const auto parent = pathOf(parentOf(*node), depth + 1);
            if (parent) result = parent->empty() ? node->name : *parent + "/" + node->name;
        }
        paths_[id] = result;
        return result;
    }

private:
    size_t count_;
    std::map<std::string, const CloudNode *> byId_;
    std::map<std::string, std::optional<std::string>> paths_;
};

std::string titleOf(const CloudNode &node, bool isNote) {
    const size_t cut = std::string(isNote ? kNoteExtension : kCanvasExtension).size();
    return node.name.substr(0, node.name.size() - cut);
}

// Название как имя файла: без знаков, запрещённых в именах, и без лишних пробелов
std::string cleanTitle(const std::string &title) {
    std::u32string out;
    bool space = false;
    for (char32_t c : decode(title)) {
        if (c == U'\\' || c == U'/' || c == U':' || c == U'*' || c == U'?' || c == U'"' || c == U'<' || c == U'>'
            || c == U'|') {
            c = U' ';
        }
        if (text::isSpace(c)) {
            if (!space) out.push_back(U' ');
            space = true;
            continue;
        }
        space = false;
        out.push_back(c);
    }
    return encode(text::trimU(out));
}

GuideDrive driveOf(const std::string &check) {
    if (check == "synced") return GuideDrive::Synced;
    if (check == "none") return GuideDrive::None;
    return GuideDrive::Unknown;
}

std::optional<std::string> guideOverviewId(const std::vector<NoteRef> &notes) {
    std::vector<GuideNoteRef> refs;
    refs.reserve(notes.size());
    for (const auto &n : notes) refs.push_back({n->id, n->title});
    const auto index = findGuideOverview(refs);
    if (!index) return std::nullopt;
    return refs[*index].id;
}

// Холст с правкой `rename` (карточки заметки либо папки): новый текст; менять нечего либо файл повреждён — nullopt
template <typename F> std::optional<std::string> renamedCanvas(const std::string &text, F &&rename) {
    const auto parsed = parseCanvas(text);
    if (parsed.error) return std::nullopt;
    const auto doc = rename(parsed.doc);
    if (doc == parsed.doc) return std::nullopt;
    return serializeCanvas(doc);
}

bool sameNotes(const std::vector<NoteRef> &a, const std::vector<NoteRef> &b) {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin());
}

bool sameCanvases(const std::vector<CanvasRef> &a, const std::vector<CanvasRef> &b) {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin());
}

void putOpt(json &j, const char *key, const std::optional<std::string> &v) {
    if (v) j[key] = *v;
}

int64_t civilFromDays(int64_t z, int &m, int &d) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t y = yoe + era * 400;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    d = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
    m = static_cast<int>(mp < 10 ? mp + 3 : mp - 9);
    return y + (m <= 2);
}

} // namespace

// ── состояние облака ────────────────────────────────────────────────────────────

const std::vector<CloudNode> &CloudData::nodesOf(const std::optional<std::string> &id) const {
    if (!id) return kNoNodes;
    const auto it = trees.find(*id);
    return it == trees.end() ? kNoNodes : it->second;
}

CloudDataRef parseCloudData(const json &state) {
    auto data = std::make_shared<CloudData>();
    data->raw = state;
    if (!state.is_object()) return data;
    data->status = state.value("status", std::string());
    if (state.contains("rootId") && state["rootId"].is_string() && !state["rootId"].get<std::string>().empty()) {
        data->rootId = state["rootId"].get<std::string>();
    }
    if (state.contains("trees") && state["trees"].is_object()) {
        for (const auto &[id, tree] : state["trees"].items()) {
            std::vector<CloudNode> nodes;
            if (tree.is_object() && tree.contains("nodes") && tree["nodes"].is_array()) {
                for (const auto &n : tree["nodes"]) nodes.push_back(n.get<CloudNode>());
            }
            data->trees.emplace(id, std::move(nodes));
        }
    }
    return data;
}

// ── хост: умолчания ─────────────────────────────────────────────────────────────

std::string NotesHost::newNodeId() {
    static thread_local std::mt19937_64 rng{std::random_device{}()};
    std::string out;
    char buf[4];
    for (int i = 0; i < 16; ++i) {
        std::snprintf(buf, sizeof buf, "%02x", static_cast<unsigned>(rng() & 0xFF));
        out += buf;
    }
    return out;
}

std::string NotesHost::today() {
    int m = 0, d = 0;
    const int64_t days = nowMs() / 86400000;
    const auto y = civilFromDays(days, m, d);
    char buf[16];
    std::snprintf(buf, sizeof buf, "%04lld-%02d-%02d", static_cast<long long>(y), m, d);
    return buf;
}

double NotesHost::nowMinutes() {
    return static_cast<double>((nowMs() % 86400000) / 60000);
}

std::string NotesHost::localTimeLabel(int64_t ms) {
    int m = 0, d = 0;
    const auto y = civilFromDays(ms / 86400000, m, d);
    const int64_t sec = (ms % 86400000) / 1000;
    char buf[32];
    std::snprintf(buf, sizeof buf, "%04lld-%02d-%02d %02d:%02d:%02d", static_cast<long long>(y), m, d,
                  static_cast<int>(sec / 3600), static_cast<int>(sec / 60 % 60), static_cast<int>(sec % 60));
    return buf;
}

// ── хранилище ───────────────────────────────────────────────────────────────────

NotesStore::NotesStore(NotesHost &host) : host_(host) {}

void NotesStore::changed() {
    ++revision_;
    if (onChanged) onChanged();
}

void NotesStore::setNotes(std::vector<NoteRef> next) {
    notes_ = std::move(next);
    ++notesRevision_;
    changed();
}

void NotesStore::setCanvases(std::vector<CanvasRef> next) {
    canvases_ = std::move(next);
    ++canvasesRevision_;
    changed();
}

void NotesStore::setFolders(std::vector<NoteFolder> next) {
    folders_ = std::move(next);
    ++foldersRevision_;
    changed();
}

void NotesStore::setStatus(NotesStatus next) {
    if (status_ == next) return;
    status_ = next;
    changed();
}

void NotesStore::notify(const std::string &code, const std::string &title) {
    notice_ = NotesNotice{code, title, host_.nowMs()};
    changed();
}

std::optional<std::string> NotesStore::rootId() const {
    return data_ ? data_->rootId : std::nullopt;
}

std::vector<CloudNode> NotesStore::rootNodes() const {
    return data_ ? data_->nodesOf(data_->rootId) : std::vector<CloudNode>();
}

// Новое состояние облака: `keepIfEqual` — то же содержимое оставляет прежний объект (сигнал web не срабатывает)
void NotesStore::adoptData(const json &state, bool keepIfEqual) {
    if (keepIfEqual && data_ && data_->raw == state) return;
    data_ = parseCloudData(state);
    handleCloudChange();
}

void NotesStore::setCloudData(const json &state) {
    adoptData(state, false);
}

CloudDataRef NotesStore::refreshCloud() {
    const auto result = host_.callParvane("parvaneCloudState", json::object());
    if (!result || !result->is_object()) return nullptr;
    const auto status = result->value("status", std::string());
    if (status != "needs-linking" && status != "loading") {
        adoptData(*result, true);
        return data_;
    }
    return parseCloudData(*result);
}

// Изменилось облако: пока заметки кому-то нужны, проход идёт сразу, иначе откладывается до открытия
void NotesStore::handleCloudChange() {
    if (!isListening_) return;
    if (consumers_ > 0 && !suspendDepth_) queueSync();
    else isDirty_ = true;
}

// Проход по дереву: не больше одного в работе; просьбы за это время сливаются в один следующий. Дерево, по
// которому уже прошли, второй раз не разбирается
void NotesStore::queueSync() {
    isDirty_ = true;
    if (isSyncing_) return;
    isSyncing_ = true;
    try {
        while (isDirty_) {
            isDirty_ = false;
            const auto data = data_;
            if (data && data == lastSyncedData_) continue;
            syncFromCloud(data);
            lastSyncedData_ = data;
        }
    } catch (...) {
        // Проход не удался — следующее изменение облака повторит его
    }
    isSyncing_ = false;
}

template <typename F> void NotesStore::withSyncSuspended(F &&run) {
    ++suspendDepth_;
    try {
        run();
    } catch (...) {
        --suspendDepth_;
        if (!suspendDepth_) queueSync();
        throw;
    }
    --suspendDepth_;
    if (!suspendDepth_) queueSync();
}

std::function<void()> NotesStore::retainNotes() {
    ++consumers_;
    if (isDirty_ && isListening_) queueSync();
    auto released = std::make_shared<bool>(false);
    return [this, released] {
        if (*released) return;
        *released = true;
        consumers_ = std::max(0, consumers_ - 1);
    };
}

void NotesStore::resetForUser() {
    texts_.clear();
    knownMarkers_.clear();
    lastSyncedData_.reset();
    textCache_.reset();
    appliedPlanner_.reset();
    isGuideSettled_ = false;
    guideAttempts_ = 0;
    guideOpenId_.reset();
    setNotes({});
    setCanvases({});
    setFolders({});
    setStatus(NotesStatus::Loading);
}

void NotesStore::loadNotes(const std::string &userId, const std::optional<NotesOptions> &options) {
    if (userId_ != userId) {
        userId_ = userId;
        resetForUser();
    }
    if (options) options_ = options;
    isListening_ = true;
    // web `loadCloud`: облако ещё не прочитано — прочитать
    if (!data_) refreshCloud();
    queueSync();
}

// ── кэш текстов ─────────────────────────────────────────────────────────────────

std::map<std::string, NotesStore::TextContent> &NotesStore::cache() {
    if (!textCache_) {
        textCache_.emplace();
        if (auto *store = host_.textCache()) {
            const auto saved = store->load(kTextCacheRecord);
            if (saved && saved->is_object()) {
                for (const auto &[node, rec] : saved->items()) {
                    if (!rec.is_object()) continue;
                    const auto fileId = rec.value("fileId", std::string());
                    if (fileId.empty() || !rec.contains("text") || !rec["text"].is_string()) continue;
                    (*textCache_)[node] = TextContent{fileId, rec["text"].get<std::string>()};
                }
            }
        }
    }
    return *textCache_;
}

void NotesStore::storeTexts(const std::vector<std::pair<std::string, TextContent>> &items) {
    auto *store = host_.textCache();
    if (!store || items.empty()) return;
    auto &c = cache();
    bool dirty = false;
    for (const auto &[node, content] : items) {
        const auto it = c.find(node);
        if (it != c.end() && it->second.fileId == content.fileId) continue;
        c[node] = content;
        dirty = true;
    }
    if (!dirty) return;
    json all = json::object();
    for (const auto &[node, content] : c) all[node] = json{{"node", node}, {"fileId", content.fileId}, {"text", content.text}};
    store->save(kTextCacheRecord, all);
}

// Записи узлов, которых в хранилище больше нет, уходят из кэша
void NotesStore::pruneTextCache(const std::set<std::string> &alive) {
    auto *store = host_.textCache();
    if (!store) return;
    auto &c = cache();
    bool dirty = false;
    for (auto it = c.begin(); it != c.end();) {
        if (alive.count(it->first)) {
            ++it;
            continue;
        }
        it = c.erase(it);
        dirty = true;
    }
    if (!dirty) return;
    json all = json::object();
    for (const auto &[node, content] : c) all[node] = json{{"node", node}, {"fileId", content.fileId}, {"text", content.text}};
    store->save(kTextCacheRecord, all);
}

void NotesStore::rememberText(const std::string &nodeId, const TextContent &content) {
    texts_[nodeId] = content;
    storeTexts({{nodeId, content}});
}

std::optional<NotesStore::TextContent> NotesStore::readText(const CloudNode &node) {
    const auto fileId = blobFileId(node);
    if (!fileId) return std::nullopt;
    const auto cachedIt = texts_.find(node.id);
    std::optional<TextContent> cached;
    if (cachedIt != texts_.end()) cached = cachedIt->second;
    if (cached && cached->fileId == *fileId) return cached;
    if (host_.textCache()) {
        auto &c = cache();
        const auto it = c.find(node.id);
        if (it != c.end() && it->second.fileId == *fileId) {
            texts_[node.id] = it->second;
            return it->second;
        }
    }
    json args{{"node", node.id}, {"blob", blobJson(node)}};
    args["container"] = rootId() ? json(*rootId()) : json();
    const auto result = host_.callParvane("parvaneCloudReadText", args);
    if (!result || !result->is_object() || !(*result)["text"].is_string()) return cached;
    const TextContent got{result->value("fileId", std::string()), (*result)["text"].get<std::string>()};
    rememberText(node.id, got);
    return got;
}

// Тексты узлов пачкой (`parvaneCloudReadTexts`); провайдер без такого метода отвечает `undefined` — тогда по одному
std::map<std::string, NotesStore::TextContent> NotesStore::readTextsOf(const std::vector<CloudNode> &nodes) {
    std::map<std::string, TextContent> result;
    const json container = rootId() ? json(*rootId()) : json();
    if (!isBatchReadMissing_) {
        json list = json::array();
        for (const auto &n : nodes) list.push_back(json{{"id", n.id}, {"blob", blobJson(n)}});
        const auto batch = host_.callParvane("parvaneCloudReadTexts", json{{"container", container}, {"nodes", list}});
        if (batch && batch->is_array()) {
            for (const auto &item : *batch) {
                if (!item.is_object() || !item.contains("text") || !item["text"].is_string()) continue;
                const auto fileId = item.value("fileId", std::string());
                if (fileId.empty()) continue;
                result[item.value("id", std::string())] = TextContent{fileId, item["text"].get<std::string>()};
            }
            return result;
        }
        // Вызов упал — не значит, что метода нет
        if (batch) isBatchReadMissing_ = true;
    }
    for (const auto &n : nodes) {
        const auto got = host_.callParvane("parvaneCloudReadText",
                                           json{{"container", container}, {"node", n.id}, {"blob", blobJson(n)}});
        if (got && got->is_object() && got->contains("text") && (*got)["text"].is_string()) {
            result[n.id] = TextContent{got->value("fileId", std::string()), (*got)["text"].get<std::string>()};
        }
    }
    return result;
}

// Тексты файлов хранилища в `texts_`: сначала память, потом кэш устройства, остальное — у облака
void NotesStore::readTexts(const std::vector<VaultFile> &files) {
    const bool hasCache = host_.textCache() != nullptr;
    std::vector<CloudNode> needed;
    for (const auto &f : files) {
        const auto fileId = blobFileId(f.node);
        if (!fileId) continue;
        const auto it = texts_.find(f.node.id);
        if (it != texts_.end() && it->second.fileId == *fileId) continue;
        if (hasCache) {
            auto &c = cache();
            const auto st = c.find(f.node.id);
            if (st != c.end() && st->second.fileId == *fileId) {
                texts_[f.node.id] = st->second;
                continue;
            }
        }
        needed.push_back(f.node);
    }
    if (!needed.empty()) {
        const auto got = readTextsOf(needed);
        std::vector<std::pair<std::string, TextContent>> items;
        for (const auto &n : needed) {
            const auto it = got.find(n.id);
            if (it == got.end()) continue;
            texts_[n.id] = it->second;
            items.emplace_back(n.id, it->second);
        }
        storeTexts(items);
    }
    if (hasCache) {
        std::set<std::string> alive;
        for (const auto &f : files) alive.insert(f.node.id);
        pruneTextCache(alive);
    }
}

// ── проход по дереву ────────────────────────────────────────────────────────────

void NotesStore::syncFromCloud(const CloudDataRef &data) {
    // Облако ещё не прочитано — ждём; прочитано, но личного диска нет (создастся первой заметкой) — пусто
    if (!data) return;
    const auto &nodes = data->nodesOf(data->rootId);
    const auto vault = findVault(nodes);
    std::vector<VaultFile> files;
    if (vault) {
        FolderPaths paths(nodes, vault->id);
        for (const auto &node : nodes) {
            if (node.isFolder() || node.trashed || parentOf(node).empty()) continue;
            const bool isNote = endsWith(node.name, kNoteExtension);
            if (!isNote && !endsWith(node.name, kCanvasExtension)) continue;
            const auto folder = paths.pathOf(parentOf(node));
            if (folder) files.push_back({node, *folder, isNote});
        }
    }
    readTexts(files);
    // Заметка, у которой не изменились ни версия, ни папка, ни название, ни время, остаётся прежним объектом
    std::map<std::string, NoteRef> previousNotes;
    for (const auto &n : notes_) previousNotes[n->id] = n;
    std::map<std::string, CanvasRef> previousCanvases;
    for (const auto &c : canvases_) previousCanvases[c->id] = c;
    std::vector<NoteRef> notes;
    std::vector<CanvasRef> canvases;
    for (const auto &f : files) {
        const auto it = texts_.find(f.node.id);
        if (it == texts_.end()) continue;
        const auto &content = it->second;
        const auto title = titleOf(f.node, f.isNote);
        if (!f.isNote) {
            const auto prev = previousCanvases.find(f.node.id);
            if (prev != previousCanvases.end() && prev->second->fileId == content.fileId
                && prev->second->text == content.text && prev->second->title == title) {
                canvases.push_back(prev->second);
            } else {
                canvases.push_back(std::make_shared<const CanvasEntry>(
                    CanvasEntry{f.node.id, title, content.text, content.fileId}));
            }
            continue;
        }
        const auto prev = previousNotes.find(f.node.id);
        const double updatedAt = static_cast<double>(f.node.mtime);
        if (prev != previousNotes.end() && prev->second->fileId == content.fileId && prev->second->text == content.text
            && prev->second->title == title && prev->second->folder == f.folder && prev->second->updatedAt == updatedAt) {
            notes.push_back(prev->second);
            continue;
        }
        auto entry = std::make_shared<NoteEntry>();
        entry->id = f.node.id;
        entry->title = title;
        entry->folder = f.folder;
        entry->text = content.text;
        entry->updatedAt = updatedAt;
        entry->fileId = content.fileId;
        entry->isDaily = isDayKey(title);
        notes.push_back(std::move(entry));
    }
    std::stable_sort(notes.begin(), notes.end(), [](const NoteRef &a, const NoteRef &b) {
        if (a->updatedAt != b->updatedAt) return a->updatedAt > b->updatedAt;
        return jsLess(a->title, b->title);
    });
    std::stable_sort(canvases.begin(), canvases.end(),
                     [](const CanvasRef &a, const CanvasRef &b) { return jsLess(a->title, b->title); });
    const auto tasksBySource = noteTasksBySource(host_.plannerState());
    for (const auto &note : notes) {
        const auto planned = tasksBySource.find(note->id);
        if (planned == tasksBySource.end() || planned->second.empty()) continue;
        std::set<std::string> markers;
        for (const auto &task : planned->second) markers.insert(markerOfTask(task));
        for (const auto &task : parseNote(note->text).tasks) {
            if (task.marker && markers.count(*task.marker)) knownMarkers_.insert(*task.marker);
        }
    }
    if (!sameNotes(notes, notes_)) setNotes(std::move(notes));
    if (!sameCanvases(canvases, canvases_)) setCanvases(std::move(canvases));
    auto folders = vault ? listNoteFolders(nodes, vault->id) : std::vector<NoteFolder>();
    if (folders != folders_) setFolders(std::move(folders));
    setStatus(NotesStatus::Ready);
    if (hasGuideMarker(nodes, kVaultNames)) isGuideSettled_ = true;
    else startGuide();
}

// ── справка ─────────────────────────────────────────────────────────────────────

// Справка — один раз на аккаунт: нет отметки, дерево сверено с сервером, узлы с постоянными идентификаторами
// (подробно — notesStore.ts `startGuide`)
void NotesStore::startGuide() {
    if (!options_ || isGuideRunning_ || isGuideSettled_ || guideAttempts_ >= kGuideAttemptsMax) {
        return;
    }
    const auto options = *options_;
    const auto userId = userId_;
    isGuideRunning_ = true;
    try {
        const auto check = host_.callParvane("parvaneCloudCheckDrive", json::object());
        // Судить рано: попытка повторится со следующим изменением облака
        if (check && check->is_string() && check->get<std::string>() != "unknown" && userId == userId_) {
            ++guideAttempts_;
            const auto result = writeGuide(GuideMode::Auto, driveOf(check->get<std::string>()), options);
            if (result.status != "retry" && userId == userId_) {
                isGuideSettled_ = true;
                if (result.status == "done" && result.isFreshVault) {
                    guideOpenId_ = result.overviewId;
                    changed();
                }
            }
        }
    } catch (...) {
    }
    isGuideRunning_ = false;
}

NotesStore::GuideResult NotesStore::writeGuide(GuideMode mode, GuideDrive check, const NotesOptions &options) {
    const auto data = refreshCloud();
    const auto root = data ? data->rootId : std::nullopt;
    if (!data || root.has_value() != (check == GuideDrive::Synced)) return GuideResult{"retry", false, std::nullopt};
    GuidePlanInput input;
    input.drive = check;
    input.nodes = root ? data->nodesOf(root) : std::vector<CloudNode>();
    input.lang = options.guideLang;
    input.vaultName = options.vaultName;
    input.vaultNames = kVaultNames;
    input.mode = mode;
    input.makeId = [this] { return host_.newNodeId(); };
    const auto plan = planGuide(input);
    if (!plan.isWrite) return GuideResult{"skipped", false, std::nullopt};
    if (!plan.folders.empty()) {
        // Папки — одной правкой: либо появятся все, либо ни одной
        json ops = json::array();
        for (const auto &f : plan.folders) {
            json op{{"op", "create"}, {"id", f.id}, {"kind", "folder"}, {"name", f.name}};
            putOpt(op, "parent", f.parent);
            ops.push_back(op);
        }
        const auto result = host_.callParvane("parvaneCloudApply", json{{"container", kRootContainer}, {"ops", ops}});
        if (!result || !result->is_object() || !result->value("ok", false)) return GuideResult{"retry", false, std::nullopt};
        const auto fresh = refreshCloud();
        const auto nodes = fresh ? fresh->nodesOf(fresh->rootId) : std::vector<CloudNode>();
        const auto *folder = findById(nodes, plan.folderId);
        // Стёртая из корзины папка с постоянным идентификатором заново не появляется: остаётся поставить отметку
        if (!folder || folder->trashed) {
            if (!findVault(nodes)) return GuideResult{"skipped", false, std::nullopt};
            return writeGuideMarker(options) ? GuideResult{"done", false, std::nullopt} : GuideResult{"retry", false, std::nullopt};
        }
    }
    std::optional<std::string> overviewId;
    for (const auto &note : plan.notes) {
        json args{{"container", kRootContainer}, {"parent", plan.folderId}, {"name", note.title + kNoteExtension},
                  {"text", note.text}};
        putOpt(args, "newNodeId", note.nodeId);
        const auto result = writeText(args);
        if (!result || !result->ok || !result->node) return GuideResult{"retry", false, std::nullopt};
        rememberText(*result->node, TextContent{result->fileId.value_or(std::string()), note.text});
        if (note.key == "overview") overviewId = result->node;
    }
    if (plan.hasMarkerWrite && !writeGuideMarker(options)) return GuideResult{"retry", false, std::nullopt};
    refreshCloud();
    return {"done", plan.isFreshVault, overviewId};
}

bool NotesStore::writeGuideMarker(const NotesOptions &options) {
    const auto write = [&](const std::optional<std::string> &nodeId) {
        const auto vault = findVault(rootNodes());
        if (!vault) return false;
        json args{{"container", kRootContainer}, {"parent", vault->id}, {"name", kGuideMarkerName},
                  {"text", buildGuideMarker(options.guideLang, host_.nowMs())}, {"mime", kGuideMarkerMime}};
        putOpt(args, "newNodeId", nodeId);
        const auto result = writeText(args);
        if (!result || !result->ok) return false;
        const auto data = refreshCloud();
        return hasGuideMarker(data ? data->nodesOf(data->rootId) : std::vector<CloudNode>(), kVaultNames);
    };
    return write(guideMarkerNodeId()) || write(std::nullopt);
}

std::optional<std::string> NotesStore::restoreGuide() {
    if (!options_) return std::nullopt;
    if (const auto existing = guideOverviewId(notes_)) return existing;
    std::optional<GuideResult> result;
    isGuideRunning_ = true;
    try {
        const auto check = host_.callParvane("parvaneCloudCheckDrive", json::object());
        if (check && check->is_string() && check->get<std::string>() != "unknown") {
            result = writeGuide(GuideMode::Restore, driveOf(check->get<std::string>()), *options_);
        }
    } catch (...) {
    }
    isGuideRunning_ = false;
    queueSync();
    const auto overview = guideOverviewId(notes_);
    if (!result || result->status == "retry" || !overview) {
        notify("guide-failed", "");
        return std::nullopt;
    }
    return overview;
}

void NotesStore::consumeGuideOpen() {
    if (!guideOpenId_) return;
    guideOpenId_.reset();
    changed();
}

// ── поиск ───────────────────────────────────────────────────────────────────────

NotesIndex NotesStore::notesIndex() const {
    std::vector<NoteSource> sources;
    sources.reserve(notes_.size());
    for (const auto &n : notes_) sources.push_back(*n);
    return NotesIndex(sources);
}

NoteRef NotesStore::findNoteByTitle(const std::string &title) const {
    const auto key = normalizeNoteTitle(title);
    for (const auto &n : notes_) {
        if (normalizeNoteTitle(n->title) == key) return n;
    }
    return nullptr;
}

std::string NotesStore::uniqueTitle(const std::string &title, const std::vector<NoteRef> &notes) const {
    auto clean = cleanTitle(title);
    if (clean.empty()) clean = "Без названия";
    const auto taken = [&](const std::string &t) {
        const auto key = normalizeNoteTitle(t);
        return std::any_of(notes.begin(), notes.end(), [&](const NoteRef &n) { return normalizeNoteTitle(n->title) == key; });
    };
    if (!taken(clean)) return clean;
    for (int n = 2;; ++n) {
        const auto candidate = clean + " " + std::to_string(n);
        if (!taken(candidate)) return candidate;
    }
}

std::string NotesStore::freeNoteTitle(const std::string &noteId, const std::string &title) const {
    std::vector<NoteRef> others;
    for (const auto &n : notes_) {
        if (n->id != noteId) others.push_back(n);
    }
    return uniqueTitle(title, others);
}

// ── правки облака (cloudStore web) ──────────────────────────────────────────────

bool NotesStore::applyOps(const std::string &container, const json &ops) {
    if (ops.empty()) return true;
    const auto result = host_.callParvane("parvaneCloudApply",
                                          json{{"container", container.empty() ? kRootContainer : container}, {"ops", ops}});
    if (!result || !result->is_object() || !result->value("ok", false)) return false;
    refreshCloud();
    return true;
}

bool NotesStore::renameCloudNode(const std::string &container, const CloudNode &node, const std::string &name) {
    if (name == node.name) return true;
    const auto nodes = data_ ? data_->nodesOf(container) : std::vector<CloudNode>();
    const auto parent = parentOf(node).empty() ? std::nullopt : node.parent;
    const auto taken = cloud::namesIn(nodes, parent, node.id);
    json op{{"op", "move"}, {"id", node.id}, {"name", cloud::freeName(taken, name)}};
    putOpt(op, "parent", parent);
    return applyOps(container, json::array({op}));
}

bool NotesStore::moveCloudNodes(const std::string &container, const std::vector<CloudNode> &nodes,
                                const std::optional<std::string> &target) {
    const auto all = data_ ? data_->nodesOf(container) : std::vector<CloudNode>();
    auto taken = cloud::namesIn(all, target);
    json ops = json::array();
    for (const auto &n : nodes) {
        const auto parent = parentOf(n).empty() ? std::nullopt : n.parent;
        if (parent == target) continue;
        const auto name = cloud::freeName(taken, n.name);
        taken.push_back(name);
        json op{{"op", "move"}, {"id", n.id}, {"name", name}};
        putOpt(op, "parent", target);
        ops.push_back(op);
    }
    return applyOps(container, ops);
}

bool NotesStore::trashCloudNodes(const std::string &container, const std::vector<CloudNode> &nodes) {
    const auto at = host_.nowMs();
    json ops = json::array();
    for (const auto &n : nodes) ops.push_back(json{{"op", "trash"}, {"id", n.id}, {"trashed", true}, {"at", at}});
    return applyOps(container, ops);
}

// ── записи ──────────────────────────────────────────────────────────────────────

std::optional<NotesStore::WriteResult> NotesStore::writeText(const json &args) {
    const auto r = host_.callParvane("parvaneCloudWriteText", args);
    if (!r || !r->is_object()) return std::nullopt;
    WriteResult out;
    out.ok = r->value("ok", false);
    if (r->contains("node") && (*r)["node"].is_string()) out.node = (*r)["node"].get<std::string>();
    if (r->contains("fileId") && (*r)["fileId"].is_string()) out.fileId = (*r)["fileId"].get<std::string>();
    if (r->contains("conflict") && (*r)["conflict"].is_string()) out.conflict = (*r)["conflict"].get<std::string>();
    return out;
}

std::optional<std::string> NotesStore::ensureFolder(const std::string &name, const std::optional<std::string> &parent) {
    const auto root = rootId();
    const auto find = [&]() -> std::optional<std::string> {
        for (const auto &n : rootNodes()) {
            if (!n.isFolder() || n.trashed) continue;
            const auto p = parentOf(n).empty() ? std::nullopt : n.parent;
            if (p != parent) continue;
            if (parent ? n.name == name : contains(kVaultNames, n.name)) return n.id;
        }
        return std::nullopt;
    };
    if (const auto existing = find()) return existing;
    const auto id = host_.newNodeId();
    json op{{"op", "create"}, {"id", id}, {"kind", "folder"}, {"name", name}};
    putOpt(op, "parent", parent);
    const auto result = host_.callParvane("parvaneCloudApply",
                                          json{{"container", kRootContainer}, {"ops", json::array({op})}});
    if (!result || !result->is_object() || !result->value("ok", false)) return std::nullopt;
    refreshCloud();
    if (const auto found = find()) return found;
    return id;
}

std::optional<std::string> NotesStore::createNote(const std::string &title, const std::string &vaultName,
                                                  const std::optional<std::string> &textArg,
                                                  const std::optional<std::string> &folderName,
                                                  const std::optional<std::string> &folderIdArg) {
    const auto vault = ensureFolder(vaultName);
    if (!vault) return std::nullopt;
    std::optional<std::string> folderId;
    if (folderIdArg && std::any_of(folders_.begin(), folders_.end(), [&](const NoteFolder &f) { return f.id == *folderIdArg; })) {
        folderId = folderIdArg;
    }
    std::optional<std::string> parent = folderId;
    if (!parent) parent = folderName ? ensureFolder(*folderName, vault) : vault;
    const auto name = uniqueTitle(title, notes_);
    const auto text = textArg.value_or("# " + name + "\n\n");
    json args{{"container", kRootContainer}, {"name", name + kNoteExtension}, {"text", text}};
    putOpt(args, "parent", parent);
    const auto result = writeText(args);
    if (!result || !result->ok || !result->node) {
        notify("failed", name);
        return std::nullopt;
    }
    rememberText(*result->node, TextContent{result->fileId.value_or(std::string()), text});
    refreshCloud();
    queueSync();
    return result->node;
}

std::optional<std::map<std::string, std::string>> NotesStore::saveChatFilesToVault(
    const std::string &vaultName, const std::vector<ChatFile> &files) {
    const auto vault = ensureFolder(vaultName);
    if (!vault) return std::nullopt;
    std::vector<std::string> taken;
    for (const auto &n : rootNodes()) {
        if (!n.trashed && parentOf(n) == *vault) taken.push_back(n.name);
    }
    std::map<std::string, std::string> renamed;
    for (const auto &file : files) {
        const auto name = cloud::freeName(taken, file.name.empty() ? "file" : file.name);
        taken.push_back(name);
        const auto result = host_.callParvane("parvaneCloudSaveFromChat", json{
            {"file", {{"fileId", file.fileId}, {"name", name}, {"mime", file.mime}, {"size", file.size}}},
            {"container", kRootContainer}, {"parent", *vault}});
        if (!result || !result->is_object() || !result->value("ok", false)) return std::nullopt;
        if (name != file.name) renamed[file.name] = name;
    }
    refreshCloud();
    return renamed;
}

std::optional<std::string> NotesStore::openDailyNote(const std::string &day, const std::string &vaultName,
                                                     const std::string &dailyFolderName) {
    const auto title = dailyNoteTitle(day);
    if (const auto existing = findNoteByTitle(title)) return existing->id;
    const auto folderName = contains(kDailyFolderNames, dailyFolderName) ? dailyFolderName : kDailyFolderNames[0];
    return createNote(title, vaultName, dailyNoteTemplate(day), folderName);
}

std::optional<std::optional<std::string>> NotesStore::readDailyNote(const std::string &day) {
    if (!data_) return std::nullopt;
    const auto &nodes = data_->nodesOf(data_->rootId);
    const auto vault = findVault(nodes);
    const auto name = dailyNoteTitle(day) + kNoteExtension;
    std::optional<CloudNode> node;
    if (vault) {
        FolderPaths paths(nodes, vault->id);
        for (const auto &n : nodes) {
            if (n.isFolder() || n.trashed || n.name != name || parentOf(n).empty()) continue;
            if (paths.pathOf(parentOf(n))) {
                node = n;
                break;
            }
        }
    }
    if (!node) return std::optional<std::string>();
    const auto content = readText(*node);
    // Файл есть, а прочитать не вышло (нет связи): не «заметки нет»
    if (!content) return std::nullopt;
    return std::optional<std::string>(content->text);
}

std::optional<NotesStore::WriteResult> NotesStore::writeNote(const NoteEntry &note, const std::string &text,
                                                             const std::optional<std::string> &expectedFileId) {
    json args{{"container", rootId().value_or(kRootContainer)}, {"node", note.id},
              {"name", note.title + kNoteExtension}, {"text", text}};
    putOpt(args, "expectedFileId", expectedFileId);
    return writeText(args);
}

// Правка и чужая версия от общей основы: сводятся построчно; изменено одно и то же место — остаётся своя правка,
// чужая версия сохраняется рядом копией «… (конфликт …)»
std::string NotesStore::reconcileNote(const NoteEntry &note, const std::string &base, const std::string &mine,
                                      const std::string &theirs, const std::string &vaultName) {
    const auto merged = mergeNotes(base, mine, theirs);
    if (merged.hasConflict) {
        createNote(note.title + " (конфликт " + host_.localTimeLabel(host_.nowMs()) + ")", vaultName, theirs);
        notify("conflict", note.title);
        return mine;
    }
    if (merged.text != mine) notify("merged", note.title);
    return merged.text;
}

bool NotesStore::saveNote(const std::string &noteId, const std::string &draft, const std::string &vaultName,
                          const std::optional<std::string> &baseText) {
    NoteRef found;
    for (const auto &n : notes_) {
        if (n->id == noteId) found = n;
    }
    if (!found) return false;
    const NoteEntry note = *found;
    const auto plannerState = host_.plannerState();
    planner::QuickContext ctx;
    ctx.today = host_.today();
    ctx.nowMinutes = host_.nowMinutes();
    ctx.dayStart = plannerState.settings.dayStart;
    ctx.dayEnd = plannerState.settings.dayEnd;
    // Пункты с датой планируются один раз; заново — только если сведение с чужой версией изменило текст
    auto planned = planNoteTasks(draft, ctx);
    auto text = planned.text;
    if (baseText && *baseText != note.text && text != note.text) {
        text = reconcileNote(note, *baseText, text, note.text, vaultName);
    }
    if (text == note.text) return true;
    auto result = writeNote(note, text, note.fileId);
    if (result && result->ok && result->conflict) {
        // Заметку тем временем изменило другое устройство: сводим построчно от общей версии
        text = reconcileNote(note, note.text, text, *result->conflict, vaultName);
        result = writeNote(note, text, result->fileId);
        // Второе расхождение подряд — пишем свою версию: чужая уже сохранена копией либо сведена
        if (result && result->ok && result->conflict) result = writeNote(note, text, std::nullopt);
    }
    if (!result || !result->ok || !result->fileId) {
        notify("failed", note.title);
        return false;
    }
    const auto fileId = *result->fileId;
    rememberText(note.id, TextContent{fileId, text});
    if (text != planned.text) planned = planNoteTasks(text, ctx);
    for (const auto &t : planned.tasks) knownMarkers_.insert(t.marker);
    if (hasNoteTaskChanges(host_.plannerState(), note.id, planned.tasks)) {
        const auto tasks = planned.tasks;
        host_.updatePlanner([&](planner::State &state) { applyNoteTasks(state, note.id, tasks); });
    }
    std::vector<NoteRef> next;
    next.reserve(notes_.size());
    for (const auto &entry : notes_) {
        if (entry->id != note.id) {
            next.push_back(entry);
            continue;
        }
        auto copy = std::make_shared<NoteEntry>(*entry);
        copy->text = text;
        copy->fileId = fileId;
        copy->updatedAt = static_cast<double>(host_.nowMs());
        next.push_back(std::move(copy));
    }
    setNotes(std::move(next));
    refreshCloud();
    return true;
}

NoteSaveResult NotesStore::saveNoteOrRestore(const std::string &noteId, const std::string &title,
                                             const std::string &draft, const std::string &vaultName,
                                             const std::optional<std::string> &baseText) {
    const auto nodes = rootNodes();
    const auto *node = findById(nodes, noteId);
    const bool isAlive = node && !node->trashed
        && std::any_of(notes_.begin(), notes_.end(), [&](const NoteRef &n) { return n->id == noteId; });
    if (isAlive) return {saveNote(noteId, draft, vaultName, baseText) ? "saved" : "failed", "", ""};
    // Дерево облака ещё не прочитано — судить, удалена ли заметка, рано
    if (!data_ || status_ != NotesStatus::Ready) return {"failed", "", ""};
    std::optional<std::string> folderId;
    if (node && !parentOf(*node).empty()) folderId = node->parent;
    const auto id = createNote(title, vaultName, draft, std::nullopt, folderId);
    if (!id) return {"failed", "", ""};
    std::string createdTitle = title;
    for (const auto &n : notes_) {
        if (n->id == *id) createdTitle = n->title;
    }
    return {"restored", *id, createdTitle};
}

void NotesStore::applyPlannerToNotes(const std::string &vaultName) {
    const auto state = host_.plannerState();
    const auto signature = noteTasksStatusSignature(state);
    if (appliedPlanner_ && appliedPlanner_->first == signature && appliedPlanner_->second == notesRevision_) return;
    appliedPlanner_ = std::make_pair(signature, notesRevision_);
    const auto tasksBySource = noteTasksBySource(state);
    const auto notes = notes_;
    for (const auto &note : notes) {
        const auto tasks = parseNote(note->text).tasks;
        if (std::none_of(tasks.begin(), tasks.end(), [](const NoteTask &t) { return t.marker.has_value(); })) continue;
        const auto it = tasksBySource.find(note->id);
        const auto next = applyPlannerToNote(note->text, it == tasksBySource.end() ? std::vector<planner::Task>() : it->second,
                                             knownMarkers_);
        if (next != note->text) saveNote(note->id, next, vaultName);
    }
}

bool NotesStore::renameNote(const std::string &noteId, const std::string &title, const std::string &vaultName) {
    NoteRef note;
    for (const auto &n : notes_) {
        if (n->id == noteId) note = n;
    }
    const auto root = rootId();
    const auto nodes = rootNodes();
    const auto *node = findById(nodes, noteId);
    const auto next = freeNoteTitle(noteId, title);
    if (!note || !node || !root || next == note->title) return false;
    if (!renameCloudNode(*root, *node, next + kNoteExtension)) return false;
    queueSync();
    const auto oldTitle = note->title;
    const auto oldKey = normalizeNoteTitle(oldTitle);
    // Ссылающиеся заметки и холсты пишутся подряд, дерево облака разбирается один раз в конце
    withSyncSuspended([&] {
        const auto others = notes_;
        for (const auto &other : others) {
            const auto links = parseNote(other->text).links;
            if (std::none_of(links.begin(), links.end(),
                             [&](const std::string &l) { return normalizeNoteTitle(l) == oldKey; })) {
                continue;
            }
            const auto text = renameLinks(other->text, oldTitle, next);
            if (text != other->text) saveNote(other->id, text, vaultName);
        }
        const auto canvases = canvases_;
        for (const auto &canvas : canvases) {
            const auto renamed = renamedCanvas(canvas->text, [&](const CanvasDoc &doc) {
                return renameCanvasNote(doc, oldTitle, next);
            });
            if (renamed) saveCanvas(canvas->title, *renamed, vaultName, canvas->id);
        }
    });
    return true;
}

bool NotesStore::deleteNote(const std::string &noteId) {
    const auto root = rootId();
    const auto nodes = rootNodes();
    const auto *node = findById(nodes, noteId);
    if (!root || !node) return false;
    const bool isDone = trashCloudNodes(*root, {*node});
    queueSync();
    return isDone;
}

NotesStore::FolderCreateResult NotesStore::createNoteFolder(const std::string &name, const std::string &vaultName) {
    const auto clean = text::trim(name);
    if (checkFolderName(clean, {}) == FolderNameError::BadName) return {std::nullopt, FolderSubmitError::BadName};
    const auto key = text::toLower(clean);
    for (const auto &f : folders_) {
        if (text::toLower(f.path) == key) return {f.id, std::nullopt};
    }
    const auto vault = ensureFolder(vaultName);
    const auto id = vault ? ensureFolder(clean, vault) : std::nullopt;
    if (!id) return {std::nullopt, FolderSubmitError::Failed};
    queueSync();
    return {id, std::nullopt};
}

bool NotesStore::moveNote(const std::string &noteId, const std::optional<std::string> &folderId) {
    const auto root = rootId();
    const auto nodes = rootNodes();
    const auto *node = findById(nodes, noteId);
    std::optional<std::string> target;
    if (folderId) {
        for (const auto &f : folders_) {
            if (f.id == *folderId) target = f.id;
        }
    } else if (const auto vault = findVault(nodes)) {
        target = vault->id;
    }
    if (!root || !node || !target) return false;
    if (parentOf(*node) == *target) return true;
    const bool isDone = moveCloudNodes(*root, {*node}, target);
    if (!isDone) notify("failed", node->name.substr(0, node->name.size() - std::string(kNoteExtension).size()));
    queueSync();
    return isDone;
}

std::optional<FolderSubmitError> NotesStore::renameNoteFolder(const std::string &folderId, const std::string &name,
                                                        const std::string &vaultName) {
    const auto root = rootId();
    const auto nodes = rootNodes();
    const auto *node = findById(nodes, folderId);
    const auto clean = text::trim(name);
    const auto folder = std::find_if(folders_.begin(), folders_.end(), [&](const NoteFolder &f) { return f.id == folderId; });
    if (!root || !node || folder == folders_.end()) return FolderSubmitError::Failed;
    if (clean == node->name) return std::nullopt;
    std::vector<std::string> siblings;
    for (const auto &other : nodes) {
        if (other.isFolder() && !other.trashed && other.id != folderId && parentOf(other) == parentOf(*node)) {
            siblings.push_back(other.name);
        }
    }
    if (const auto error = checkFolderName(clean, siblings)) {
        return *error == FolderNameError::Taken ? FolderSubmitError::Taken : FolderSubmitError::BadName;
    }
    const auto oldPath = folder->path;
    auto parts = text::split(oldPath, '/');
    parts.pop_back();
    parts.push_back(clean);
    const auto newPath = text::join(parts, "/");
    if (!renameCloudNode(*root, *node, clean)) return FolderSubmitError::Failed;
    queueSync();
    withSyncSuspended([&] {
        const auto canvases = canvases_;
        for (const auto &canvas : canvases) {
            const auto renamed = renamedCanvas(canvas->text, [&](const CanvasDoc &doc) {
                return renameCanvasFolder(doc, oldPath, newPath);
            });
            if (renamed) saveCanvas(canvas->title, *renamed, vaultName, canvas->id);
        }
    });
    return std::nullopt;
}

std::string NotesStore::deleteNoteFolder(const std::string &folderId, const std::string &notesMode) {
    const auto root = rootId();
    const auto nodes = rootNodes();
    const auto *node = findById(nodes, folderId);
    const auto vault = findVault(nodes);
    const bool known = std::any_of(folders_.begin(), folders_.end(), [&](const NoteFolder &f) { return f.id == folderId; });
    if (!root || !node || !vault || !known) return "failed";
    const auto inside = folderContents(nodes, folderId);
    if (!inside.others.empty() && notesMode != "with-notes") {
        notify("folder-files", node->name);
        return "has-files";
    }
    if (!inside.notes.empty() && notesMode != "with-notes") {
        if (notesMode.empty()) return "has-notes";
        if (!moveCloudNodes(*root, inside.notes, vault->id)) {
            notify("failed", node->name);
            return "failed";
        }
    }
    const bool isDone = trashCloudNodes(*root, {*node});
    queueSync();
    return isDone ? "done" : "failed";
}

std::optional<std::string> NotesStore::saveCanvas(const std::string &title, const std::string &textArg,
                                                  const std::string &vaultName,
                                                  const std::optional<std::string> &canvasId) {
    const auto vault = ensureFolder(vaultName);
    if (!vault) return std::nullopt;
    CanvasRef existing;
    if (canvasId) {
        for (const auto &c : canvases_) {
            if (c->id == *canvasId) existing = c;
        }
    }
    if (existing && existing->text == textArg) return existing->id;
    json args{{"container", rootId().value_or(kRootContainer)}, {"parent", *vault},
              {"name", (existing ? existing->title : title) + kCanvasExtension}, {"text", textArg},
              {"mime", kCanvasMime}};
    if (existing) args["node"] = existing->id;
    const auto result = writeText(args);
    if (!result || !result->ok || !result->node) {
        notify("failed", title);
        return std::nullopt;
    }
    const auto fileId = result->fileId.value_or(std::string());
    rememberText(*result->node, TextContent{fileId, textArg});
    if (existing) {
        std::vector<CanvasRef> next;
        for (const auto &c : canvases_) {
            if (c->id != existing->id) {
                next.push_back(c);
                continue;
            }
            auto copy = std::make_shared<CanvasEntry>(*c);
            copy->text = textArg;
            copy->fileId = fileId;
            next.push_back(std::move(copy));
        }
        setCanvases(std::move(next));
    } else {
        refreshCloud();
        queueSync();
    }
    return result->node;
}

bool NotesStore::renameCanvas(const std::string &canvasId, const std::string &title) {
    const auto root = rootId();
    const auto nodes = rootNodes();
    const auto *node = findById(nodes, canvasId);
    CanvasRef canvas;
    std::vector<std::string> others;
    for (const auto &c : canvases_) {
        if (c->id == canvasId) canvas = c;
        else others.push_back(c->title);
    }
    const auto clean = cleanTitle(title);
    if (!root || !node || !canvas || clean.empty()) return false;
    if (clean == canvas->title) return true;
    const auto next = freeCanvasTitle(clean, others);
    if (!renameCloudNode(*root, *node, next + kCanvasExtension)) return false;
    queueSync();
    return true;
}

bool NotesStore::deleteCanvas(const std::string &canvasId) {
    const auto root = rootId();
    const auto nodes = rootNodes();
    const auto *node = findById(nodes, canvasId);
    if (!root || !node) return false;
    const bool isDone = trashCloudNodes(*root, {*node});
    queueSync();
    return isDone;
}

} // namespace parvane::sections::notes
