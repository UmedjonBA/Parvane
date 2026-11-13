// Parvane Android (spec 033): журнал истории аккаунта поверх общего ядра `parvane::history::HistorySync`
// (desktop/parvane-core/include/parvane/history_sync.h; правила HIST-1, HIST-2, READ-2). Как desktop
// parvane_client_history.cpp: строки, их сведение, маркер «прочитано до» и непрочитанное — модель движка профиля
// (spec 035 T125, ENGINE-1: `ModelRows` ядра над моделью сессии v2; без сети — по прошлому открытию), права
// удаления — движок; здесь — события в шов (message/edited/meta/deleted/read_state) и разовый перенос в модель
// прежних файлов строк (spec 033) и журнала `journal.jsonl` (события шва до spec 033).
//
// Файлы каталога хранилища (storecrypt):
//   history-<адрес>.jsonl            — прежние строки RowState (spec 033): читаются один раз при переносе в модель,
//                                      не удаляются (D2);
//   history-marks-<адрес>.json       — прежние маркеры «прочитано до» (так же);
//   history-sync-<адрес>-meta.json / -pending.json / -imported.json — курсор, голова, точка, флаг переноса, очередь
//                                      своих, отметка переноса строк в модель — записями хранилища движка
//                                      (PathFiles, spec 036 T036; прежний файл переносится один раз);
//   history-local-<адрес>.json       — границы очистки чатов «у себя», ✓✓ своих (время по чату), неотправленные
//                                      квитанции READ собеседникам (повтор до успеха, READ-1 п. 3) — записью хранилища
//                                      движка (PathFiles, spec 036 T036; прежний файл переносится один раз).
// spec 036 (ENGINE-1, `engine_rows`): журнал истории аккаунта ведёт модель сессии; файлы history-sync-* остаются
// только чтением прежней очереди (передаётся модели один раз, HistorySync::start).
#include "jni_internal.h"

#include <parvane/history_sync.h>
#include <parvane/local_files.h>
#include <parvane/messenger.h>
#include <parvane/storecrypt.h>
#include <parvane/v2_engine.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <limits>
#include <thread>

namespace pvjni {

namespace ph = parvane::history;

namespace {

constexpr int kReceiptRetryMax = 40;          // попыток квитанции (≈ 10 мин при паузе 15 с)
constexpr std::int64_t kReceiptRetryMs = 15000;

std::string historyRowsPath(const std::string &self) { return storeDir() + "/history-" + safePart(self) + ".jsonl"; }
std::string historyMarksPath(const std::string &self) { return storeDir() + "/history-marks-" + safePart(self) + ".json"; }
std::string historyAuxPrefix(const std::string &self) { return storeDir() + "/history-sync-" + safePart(self) + "-"; }
std::string historyLocalPath(const std::string &self) { return storeDir() + "/history-local-" + safePart(self) + ".json"; }
std::string legacyJournalPath() { return storeDir() + "/journal.jsonl"; }

std::int64_t i64Of(const json &v) {
    if (v.is_number_integer()) return v.get<std::int64_t>();
    if (v.is_number()) return static_cast<std::int64_t>(v.get<double>());
    if (v.is_string()) {
        try { return std::stoll(v.get<std::string>()); } catch (...) {}
    }
    return 0;
}

// Строка, которую можно хранить в журнале: расшифрована, не служебный шифртекст, не исчезающая (как desktop
// JournaledContent; TTL — правило spec 005).
bool journaledContent(const json &content) {
    if (!content.is_object()) return false;
    const auto kind = parvane::contentKind(content);
    if (kind.empty() || kind == "encrypted" || kind == "group_encrypted" || kind == "skdm" || kind == "unsupported") return false;
    return content.value("ttl_secs", 0) <= 0;
}

json contentForJournal(json content) {
    if (content.is_object()) content.erase("local_path"); // путь рабочей копии — только этого устройства
    return content;
}

// Журнал истории одного аккаунта: строки модели, синхронизатор ядра и локальные отметки. Удаляется последним
// держателем; рабочий поток журнала и поток ожидания модели держателями не бывают (берут сырой указатель), поэтому
// stop() не ждёт сам себя.
struct Hist {
    std::string owner;
    std::unique_ptr<ph::ModelRows> store;
    std::unique_ptr<ph::HistorySync> sync;
    bool started = false;
    // Модель открыта и прежние строки перенесены в неё; показ с диска (historyReplay) — после этого
    std::atomic<bool> ready{false};
    std::atomic<bool> replayWanted{false};
    std::thread waiter;

    std::mutex localMu; // ниже
    std::map<std::string, std::int64_t> clearedUntil; // адрес чата → граница очистки «у себя» (мс)
    std::set<std::string> clearedIds;
    std::map<std::string, std::int64_t> outboxRead; // адрес чата → время последнего своего, прочитанного собеседником
    json receipts = json::array();                  // [{chat, ids, attempts}] — неотправленные до spec 036 (дослать)

    std::mutex loopMu;
    std::condition_variable loopCv;
    bool stopLoop = false;
    std::thread receiptLoop;

    ~Hist() {
        {
            std::lock_guard<std::mutex> lk(loopMu);
            stopLoop = true;
        }
        loopCv.notify_all();
        if (receiptLoop.joinable()) receiptLoop.join();
        if (waiter.joinable()) {
            if (waiter.get_id() == std::this_thread::get_id()) waiter.detach(); // последний держатель — сам поток ожидания
            else waiter.join();
        }
        if (sync) sync->stop();
        sync.reset();
        store.reset();
    }

    void saveLocalLocked() const {
        json cleared = json::object();
        for (const auto &[a, t] : clearedUntil) cleared[a] = t;
        json outbox = json::object();
        for (const auto &[a, t] : outboxRead) outbox[a] = t;
        hostWrite(historyLocalPath(owner),
            json{{"cleared", cleared}, {"cleared_ids", clearedIds}, {"outbox_read", outbox}, {"receipts", receipts}}.dump());
    }

    void loadLocal() {
        const auto j = json::parse(hostRead(historyLocalPath(owner)), nullptr, false);
        if (!j.is_object()) return;
        std::lock_guard<std::mutex> lk(localMu);
        if (j.contains("cleared") && j["cleared"].is_object())
            for (auto it = j["cleared"].begin(); it != j["cleared"].end(); ++it) clearedUntil[it.key()] = i64Of(it.value());
        if (j.contains("cleared_ids") && j["cleared_ids"].is_array())
            for (const auto &id : j["cleared_ids"]) if (id.is_string()) clearedIds.insert(id.get<std::string>());
        if (j.contains("outbox_read") && j["outbox_read"].is_object())
            for (auto it = j["outbox_read"].begin(); it != j["outbox_read"].end(); ++it) outboxRead[it.key()] = i64Of(it.value());
        if (j.contains("receipts") && j["receipts"].is_array()) receipts = j["receipts"];
    }
};

std::mutex g_histMu;          // g_hist
std::shared_ptr<Hist> g_hist; // журнал текущего аккаунта
std::mutex g_histOpenMu;      // открытие и перенос — по одному

std::mutex g_domainMu;
std::map<std::string, std::string> g_groupDomains; // "v2g:<hex>" → домен сервера группы
std::map<std::string, std::set<std::string>> g_groupDeleters; // группа → кто удаляет чужое (владелец, админ с правом)

std::shared_ptr<Hist> hist() {
    std::lock_guard<std::mutex> lk(g_histMu);
    return g_hist;
}

// Свои адреса (текущий и прежние после смены ника) — аргумент `self`/`deleter` функций движка истории.
json selvesOf(Hist &h) {
    json out = json::array();
    for (const auto &a : h.sync->selfAddresses()) out.push_back(a);
    return out;
}

std::string chatOfRow(const std::string &from, const std::string &to, const std::string &me) {
    if (isGroupAddress(to)) return to;
    return from == me ? to : from;
}

bool isClearedState(Hist &h, const json &state) {
    const auto address = parvane::v2::Session::historyAddress(state.value("chat", json()));
    const auto target = state.value("target", std::string());
    const auto pos = ph::rowPos(state);
    std::lock_guard<std::mutex> lk(h.localMu);
    if (h.clearedIds.count(target)) return true;
    const auto it = h.clearedUntil.find(address);
    return pos && it != h.clearedUntil.end() && it->second > 0 && pos->tsMs <= it->second;
}

// Строка показа очищенного «у себя» чата (граница ChatCleared или id из очистки).
bool isClearedView(Hist &h, const json &view) {
    const auto address = parvane::v2::Session::historyAddress(view.value("chat", json()));
    const auto id = view.value("id", std::string());
    const auto tsMs = view.value("tsMs", std::int64_t(0));
    std::lock_guard<std::mutex> lk(h.localMu);
    if (h.clearedIds.count(id)) return true;
    const auto it = h.clearedUntil.find(address);
    return it != h.clearedUntil.end() && it->second > 0 && tsMs > 0 && tsMs <= it->second;
}

// Счётчики чатов модели (`unread_changed`, spec 036 E4) — готовыми; до первого изменения чата — `rowsRead` модели.
std::mutex g_unreadMu;
std::map<std::string, std::pair<int, std::string>> g_modelUnread; // адрес → (непрочитано, последняя прочитанная)

json reactionsOfView(const json &view, const std::string &me, json *by) {
    auto arr = json::array();
    if (by) *by = json::object();
    for (const auto &r : view.value("reactions", json::array())) {
        bool mine = false;
        const auto emoji = r.value("emoji", std::string());
        for (const auto &u : r.value("users", json::array())) {
            if (!u.is_string()) continue;
            mine = mine || u.get<std::string>() == me;
            if (by) (*by)[u.get<std::string>()] = emoji;
        }
        arr.push_back(json{{"emoji", emoji}, {"count", r.value("count", 0)}, {"mine", mine}});
    }
    return arr;
}

// Показ строки — готовый вид модели (MessageView `wire_rows` в прежней форме ядра, `viewOfModel`, spec 036 ENGINE-1):
// надгробие — {visible: false}, сирота — {orphan: true}. Своего сведения и `historyView` у шва нет.
json viewOf(Hist &h, const json &state) {
    const auto target = state.value("target", std::string());
    if (target.empty() || !state.contains("row")) return json{{"orphan", true}, {"id", target}};
    const auto views = h.store->views({target});
    if (!views.empty()) {
        auto v = ph::viewOfModel(views.front());
        if (v.is_object()) return v;
    }
    const auto chat = state.value("chat", json());
    return json{{"id", target}, {"chat", chat}, {"chatKey", ph::chatKeyOf(chat)}, {"visible", false}, {"orphan", false}};
}

json contentOfView(const json &view) {
    const auto it = view.find("body");
    if (it == view.end() || !it->is_object()) return json::object();
    const auto c = it->find("content");
    return (c != it->end() && c->is_object()) ? *c : json::object();
}

// Прочитано ли (показ модели): входящее — не после маркера (`MessageView.unread`, READ-2), своё — доставка
// «прочитано» (квитанция собеседника, ✓✓).
bool rowRead(Hist &h, const json &view) {
    // Своё — и под прежним адресом (смена ника): свои адреса из сессии журнала движка
    if (view.value("outgoing", false) || h.sync->isSelf(strOf(view, "from"))) return view.value("read", false);
    return !view.value("unread", false);
}

// Видимая строка → событие "message" шва (тот же вид, что живое).
json messageEventOf(Hist &h, const json &view, const std::string &me) {
    const auto from = strOf(view, "from");
    const auto chat = parvane::v2::Session::historyAddress(view.value("chat", json()));
    const bool group = isGroupAddress(chat);
    const bool out = from == me || h.sync->isSelf(from);
    const auto bodyIt = view.find("body");
    const auto body = (bodyIt != view.end() && bodyIt->is_object()) ? *bodyIt : json::object();
    const auto content = contentOfView(view);
    json by;
    auto reactions = reactionsOfView(view, me, &by);
    auto ev = json{{"type", "message"}, {"id", strOf(view, "id")}, {"from", from},
                   {"to", group ? chat : (out ? chat : me)}, {"ts", view.value("tsMs", std::int64_t(0)) / 1000},
                   {"text", textOrCaption(content)}, {"out", out},
                   {"kind", parvane::contentKind(content)}, {"read", rowRead(h, view)}, {"content", content},
                   {"reply_to", body.contains("reply_to") && body["reply_to"].is_string() ? body["reply_to"] : json()},
                   {"edited", view.value("edited", false)}, {"pinned", view.value("pinned", false)},
                   {"reactions", reactions}, {"by", by}, {"group", group}, {"proto", 2},
                   {"chat_key", strOf(view, "chatKey")}};
    if (!out && body.contains("proof") && body["proof"].is_string()) ev["proof"] = body["proof"];
    return ev;
}

json metaEventOf(const json &view, const std::string &me) {
    json by;
    auto reactions = reactionsOfView(view, me, &by);
    const auto id = strOf(view, "id");
    replaceMeta(id, by, view.value("pinned", false));
    return json{{"type", "meta"}, {"id", id}, {"reactions", reactions}, {"by", by}, {"pinned", view.value("pinned", false)}};
}

// Счётчик чата для шва (READ-2): непрочитанные от маркера и последняя прочитанная строка — модель (`unread_changed`;
// до первого изменения чата — её `rowsRead`).
json readStateEvent(Hist &h, const std::string &chat, const std::string &chatKey = std::string()) {
    // «Прочитано до» — последняя ВИДИМАЯ прочитанная строка (`rowsRead`): маркер модели может стоять на снятой строке
    const auto rs = h.sync->readState(chatKey.empty() ? ph::chatKeyOf(historyPeerOf(chat)) : chatKey);
    auto unread = rs.unread;
    auto last = rs.lastReadId;
    {
        std::lock_guard<std::mutex> lk(g_unreadMu);
        if (const auto it = g_modelUnread.find(chat); it != g_modelUnread.end()) {
            unread = it->second.first;
            if (last.empty()) last = it->second.second;
        }
    }
    // Место прочитанной строки (ORDER-1): шов строит id сообщения X из места, не загружая строку (лента — страницами)
    std::int64_t lastOrder = 0;
    if (!last.empty()) {
        const auto vs = h.store->views({last});
        if (!vs.empty()) lastOrder = ph::viewOfModel(vs.front()).value("order", std::int64_t(0));
    }
    return json{{"type", "read_state"}, {"chat", chat}, {"unread", unread}, {"last_read_id", last}, {"last_read_order", lastOrder}};
}

// spec 036 T035: вид чата модели (`chatViewOfModel`) → строка списка шва: адрес, место (мс), закреп, архив, отметка,
// мут, черновик, папки, счётчик и последняя строка событием "message" (показ модели; очищенное «у себя» — без неё).
json chatEntryOf(Hist &h, const json &cv, const std::string &me) {
    const auto address = parvane::v2::Session::historyAddress(cv.value("chat", json()));
    if (address.empty()) return nullptr;
    auto out = json{{"address", address}, {"group", isGroupAddress(address)},
                    {"order", cv.value("order", std::int64_t(0))}, {"pinned_rank", cv.value("pinnedRank", std::int64_t(0))},
                    {"archived", cv.value("archived", false)}, {"unread_mark", cv.value("unreadMark", false)},
                    {"muted_until_ms", cv.value("mutedUntilMs", std::int64_t(0))}, {"draft", cv.value("draft", std::string())},
                    {"folder_ids", cv.value("folderIds", json::array())}, {"unread", cv.value("unread", std::int64_t(0))},
                    {"mention", cv.value("mention", false)}};
    const auto &last = cv.contains("last") ? cv["last"] : json();
    if (last.is_object() && !isClearedView(h, last)) {
        auto ev = messageEventOf(h, last, me);
        ev["order"] = last.value("order", std::int64_t(0));
        out["last"] = std::move(ev);
    }
    return out;
}

// Строки страницы стали показанными: правка, реакции и снятие дальше идут событиями этих строк (не "message")
void notePaged(const json &ev) {
    const auto id = ev.value("id", std::string());
    (void)markSeen(id);
    const auto from = ev.value("from", std::string());
    const auto to = ev.value("to", std::string());
    const auto chat = ev.value("group", false) ? to : (from == self() ? to : from);
    noteMessage(id, from, chat, ev.value("content", json::object()), ev.value("proof", std::string()));
    replaceMeta(id, ev.value("by", json::object()), ev.value("pinned", false));
}

// Строки, изменившиеся в модели (входящее, журнал истории, мутации, квитанции — `message_upsert/remove`), → события
// шва: новые — "message", правка — "edited", реакции и закреп — "meta", снятие — "deleted"; затем счётчики
// затронутых чатов (READ-2: пачка счётчик не раздувает — он выставляется заново от маркера). Место новых строк —
// модели (ORDER-1, `order` показа): своей расстановки у шва нет.
void showViews(Hist &h, const std::vector<json> &views) {
    const auto me = self();
    std::map<std::string, std::string> chats; // адрес → ключ чата
    // Строка, менявшаяся в пачке несколько раз, показывается последним видом
    std::map<std::string, std::size_t> lastAt;
    for (std::size_t i = 0; i < views.size(); ++i) lastAt[strOf(views[i], "id")] = i;
    std::vector<json> fresh;
    for (std::size_t i = 0; i < views.size(); ++i) try {
        const auto &view = views[i];
        if (view.empty() || view.value("orphan", true)) continue; // сирота ждёт сообщение
        const auto id = strOf(view, "id");
        const auto chat = parvane::v2::Session::historyAddress(view.value("chat", json()));
        if (id.empty() || chat.empty()) continue;
        if (lastAt[id] != i) continue;
        chats[chat] = strOf(view, "chatKey");
        if (!view.value("visible", false)) {
            forgetMessage(id);
            unmarkSeen(id); // замена точкой (HIST-2): та же строка может вернуться — показать её заново
            emit(json{{"type", "deleted"}, {"id", id}});
            continue;
        }
        if (isClearedView(h, view)) continue;
        if (markSeen(id)) {
            auto ev = messageEventOf(h, view, me);
            ev["history"] = true; // догрузка журналом — без уведомления
            ev["order"] = view.value("order", std::int64_t(0));
            noteMessage(id, ev.value("from", std::string()), chat, ev["content"], ev.value("proof", std::string()));
            replaceMeta(id, ev["by"], ev.value("pinned", false));
            if (isGroupAddress(chat) && !groupKnown(chat)) {
                deferLinkedGroupRow(chat, std::move(ev));
                continue;
            }
            fresh.push_back(std::move(ev));
            continue;
        }
        const auto content = contentOfView(view);
        const auto row = messageRow(id);
        if (row && contentForJournal(row->content) != content) {
            auto shown = content;
            if (row->content.contains("local_path") && strOf(row->content, "file_id") == strOf(content, "file_id"))
                shown["local_path"] = row->content["local_path"];
            updateMessageContent(id, shown);
            emit(json{{"type", "edited"}, {"id", id}, {"content", shown},
                      {"edit_date", view.value("editTsMs", std::int64_t(0)) / 1000}});
        }
        emit(metaEventOf(view, me));
        // ✓✓ своего — доставка строки в модели (квитанция собеседника)
        if (view.value("read", false) && h.sync->isSelf(strOf(view, "from"))) {
            emit(json{{"type", "outbox_read"}, {"id", id}, {"at", nowSec()}});
        }
    } catch (const std::exception &e) {
        // Одна непонятная строка не обрывает пачку: остальные чаты догрузки показываются
        LOGI("журнал истории: строка пропущена (%s)", e.what());
    }
    std::stable_sort(fresh.begin(), fresh.end(),
                     [](const json &a, const json &b) { return a.value("order", std::int64_t(0)) < b.value("order", std::int64_t(0)); });
    for (auto &ev : fresh) emit(ev);
    for (const auto &[chat, key] : chats) emit(readStateEvent(h, chat, key));
}

void showStates(Hist &h, const std::vector<json> &states) {
    std::vector<json> views;
    views.reserve(states.size());
    for (const auto &st : states) views.push_back(viewOf(h, st));
    showViews(h, views);
}

// ── перенос прежнего журнала (journal.jsonl: события шва до spec 033) ─────────
// Свёртка — как прежняя journalFold: message/edited/deleted/meta/outbox_read/read по uuid (удалённые прежде
// стирались — надгробий в нём нет).
std::vector<json> foldLegacyJournal() {
    std::vector<std::string> order;
    std::map<std::string, json> msgs;
    for (const auto &line : parvane::storecrypt::readLines(legacyJournalPath())) {
        auto e = json::parse(line, nullptr, false);
        if (!e.is_object()) continue;
        const auto t = e.value("type", "");
        const auto id = e.value("id", "");
        if (t == "message") {
            if (id.empty()) continue;
            if (!msgs.count(id)) order.push_back(id);
            auto &m = msgs[id];
            if (m.is_object()) {
                e["by"] = m.value("by", json::object());
                e["pinned"] = m.value("pinned", false);
                if (m.value("read", false)) e["read"] = true;
            }
            m = e;
        } else if (t == "edited") {
            if (auto it = msgs.find(id); it != msgs.end()) { it->second["content"] = e["content"]; it->second["edited"] = true; }
        } else if (t == "deleted") {
            msgs.erase(id);
        } else if (t == "meta") {
            if (auto it = msgs.find(id); it != msgs.end()) {
                it->second["by"] = e.value("by", json::object());
                it->second["pinned"] = e.value("pinned", false);
            }
        } else if (t == "outbox_read") {
            if (auto it = msgs.find(id); it != msgs.end()) it->second["read"] = true;
        } else if (t == "read") {
            for (const auto &x : e.value("ids", json::array()))
                if (x.is_string()) if (auto it = msgs.find(x.get<std::string>()); it != msgs.end()) it->second["read"] = true;
        }
    }
    std::vector<json> out;
    out.reserve(order.size());
    for (const auto &id : order) if (msgs.count(id)) out.push_back(std::move(msgs[id]));
    return out;
}

// Маркер «прочитано до» строки операции row (её место — время и id).
json markOfRowOp(const json &op, const json &peer) {
    const auto &r = op.contains("row") && op["row"].is_object() ? op["row"] : json::object();
    return json{{"read", {{"chat", peer}, {"up_to_ts_ms", r.value("ts_ms", std::string("0"))}, {"up_to_id", r.value("id", std::string())}}}};
}

// Прежний журнал шва (до spec 033) → операции для модели: строка, реакции, закреп, маркер прочитанного (сведение —
// модель). Один раз: после переноса файл удаляется (его события уже строки модели).
void convertLegacyJournal(Hist &h, const std::string &me) {
    std::error_code ec;
    if (!std::filesystem::exists(legacyJournalPath(), ec)) return;
    const auto msgs = foldLegacyJournal();
    std::vector<json> ops;
    int converted = 0;
    for (const auto &m : msgs) {
        try {
            const auto id = m.value("id", std::string());
            const auto from = m.value("from", std::string());
            const auto to = m.value("to", std::string());
            const auto content = m.value("content", json::object());
            if (id.empty() || from.empty() || to.empty() || !journaledContent(content)) continue;
            const auto chat = m.value("group", false) ? to : chatOfRow(from, to, me);
            const auto peer = historyPeerOf(chat);
            if (peer.is_null()) continue;
            auto wire = json{{"id", id}, {"from", from}, {"to", to}, {"ts", m.value("ts", std::int64_t(0))},
                             {"content", contentForJournal(content)}};
            if (m.contains("reply_to") && m["reply_to"].is_string() && !m["reply_to"].get<std::string>().empty())
                wire["reply_to"] = m["reply_to"];
            if (m.contains("proof") && m["proof"].is_string()) wire["proof"] = m["proof"];
            const auto row = ph::rowOpFromWire(wire, peer);
            ops.push_back(row);
            const auto tsMs = m.value("ts", std::int64_t(0)) * 1000;
            if (m.contains("by") && m["by"].is_object())
                for (auto it = m["by"].begin(); it != m["by"].end(); ++it)
                    if (it.value().is_string() && !it.value().get<std::string>().empty())
                        ops.push_back(ph::reactOp(id, peer, it.key(), ph::stampOf(tsMs, std::string()), it.value().get<std::string>()));
            if (m.value("pinned", false)) ops.push_back(ph::pinOp(id, peer, ph::stampOf(tsMs, std::string()), true));
            ++converted;
            const bool read = m.value("read", false);
            if (from == me && read) {
                std::lock_guard<std::mutex> lk(h.localMu);
                auto &until = h.outboxRead[chat];
                until = std::max(until, tsMs);
            }
            if (from == me || read) ops.push_back(markOfRowOp(row, peer));
        } catch (const std::exception &e) {
            LOGE("журнал истории: строка прежнего журнала не перенесена: %s", e.what());
        }
    }
    constexpr std::size_t kChunk = 200;
    for (std::size_t i = 0; i < ops.size(); i += kChunk) {
        const auto r = h.store->apply(json(std::vector<json>(ops.begin() + i, ops.begin() + std::min(ops.size(), i + kChunk))));
        if (!r.ok) {
            LOGE("журнал истории: прежний журнал не перенесён в модель (%s) — повтор при следующем запуске", r.error.c_str());
            return;
        }
    }
    {
        std::lock_guard<std::mutex> lk(h.localMu);
        h.saveLocalLocked();
    }
    std::remove(legacyJournalPath().c_str());
    LOGI("журнал истории: прежний журнал — в модели (%d строк, операций %zu)", converted, ops.size());
}

// ── квитанции READ собеседникам (READ-1 п. 3: повтор до успеха) ───────────────

bool sendReceiptNow(const std::string &chat, const json &ids) {
    const auto s = v2Ready();
    if (!s || !ids.is_array() || ids.empty()) return false;
    auto refs = json::array();
    for (const auto &id : ids) if (id.is_string()) refs.push_back(parvane::v2::ref(id.get<std::string>()));
    try {
        s->sendContent(chat, json{{"receipt", {{"kind", "RECEIPT_KIND_READ"}, {"messages", refs}}}}, parvane::v2::newUuidV7());
        LOGI("v2 → квитанция READ в чат (%zu сообщений)", refs.size());
        return true;
    } catch (const std::exception &e) {
        LOGE("v2: квитанция не отправлена: %s", e.what());
        return false;
    }
}

void flushReceipts(Hist &h) {
    json pending;
    {
        std::lock_guard<std::mutex> lk(h.localMu);
        pending = std::exchange(h.receipts, json::array());
    }
    if (pending.empty()) return;
    auto left = json::array();
    for (auto &r : pending) {
        if (sendReceiptNow(r.value("chat", std::string()), r.value("ids", json::array()))) continue;
        r["attempts"] = r.value("attempts", 0) + 1;
        if (r["attempts"].get<int>() < kReceiptRetryMax) left.push_back(r);
        else LOGE("v2: квитанция READ оставлена после %d попыток", kReceiptRetryMax);
    }
    std::lock_guard<std::mutex> lk(h.localMu);
    for (auto &r : left) h.receipts.push_back(std::move(r));
    h.saveLocalLocked();
}

void receiptLoop(Hist *h) {
    for (;;) {
        {
            std::unique_lock<std::mutex> lk(h->loopMu);
            h->loopCv.wait_for(lk, std::chrono::milliseconds(kReceiptRetryMs), [h] { return h->stopLoop; });
            if (h->stopLoop) return;
        }
        try {
            flushReceipts(*h);
        } catch (const std::exception &e) {
            LOGE("квитанции: %s", e.what());
        }
    }
}

// Открыть журнал текущего аккаунта (перенос прежнего — один раз); nullptr — аккаунта нет.
std::shared_ptr<Hist> ensureHist() {
    const auto me = self();
    if (!parvane::accountfiles::isValidAddress(me)) return nullptr;
    if (auto h = hist(); h && h->owner == me) return h;
    std::lock_guard<std::mutex> open(g_histOpenMu);
    if (auto h = hist(); h && h->owner == me) return h;
    {
        std::shared_ptr<Hist> prev; // журнал прежнего аккаунта — остановить вне замка
        {
            std::lock_guard<std::mutex> lk(g_histMu);
            prev = std::move(g_hist);
        }
    }
    auto h = std::make_shared<Hist>();
    h->owner = me;
    // Строки — в модели профиля сессии v2 (её открывает сессия; без сети — по прошлому открытию)
    h->store = std::make_unique<ph::ModelRows>(
        [owner = me]() -> std::shared_ptr<parvane::engine::Host> {
            if (self() != owner) return nullptr;
            const auto s = v2Any();
            return s ? s->rowsModel() : nullptr;
        },
        historyAuxPrefix(me),
        // Служебные документы журнала (отметка переноса, очередь прежнего журнала) — файлы хоста (spec 036 T036)
        ph::ModelRows::AuxIo{[](const std::string &p) { return hostRead(p); },
                             [](const std::string &p, const std::string &d) { return hostWrite(p, d); }});
    h->loadLocal();
    Hist *raw = h.get();
    ph::HistorySyncConfig cfg;
    cfg.self = me;
    cfg.rows = h->store.get();
    cfg.openEngine = [owner = me]() -> std::unique_ptr<parvane::v2::HistorySession> {
        const auto s = self() == owner ? v2Ready() : nullptr;
        return s ? s->openHistorySession() : nullptr;
    };
    cfg.log = [](const std::string &m) { LOGI("%s", m.c_str()); };
    // spec 036 (ENGINE-1, `engine_rows`): журнал истории аккаунта (пачка S7-3, догон, вход по точке, контрольные
    // точки, замена дальше горизонта) ведёт модель сессии (окно пачки — jni_session.cpp); здесь — строки модели и
    // прочтение её намерением (квитанции о ставших прочитанными шлёт модель)
    cfg.readIntent = [owner = me](const json &mark) {
        // Намерение ходит в сеть (квитанции) — не на потоке вызова; без сессии — маркер операцией журнала
        if (self() != owner || !v2Ready()) return false;
        runDetached([owner, mark] {
            if (const auto s = self() == owner ? v2Ready() : nullptr) s->readTo(mark);
        });
        return true;
    };
    h->sync = std::make_unique<ph::HistorySync>(std::move(cfg));
    h->receiptLoop = std::thread(receiptLoop, raw);
    // Модель открывает сессия v2 (подключение) либо открытие без сети по прошлому разу; дождаться и перенести в неё
    // прежние строки (spec 033) и журнал шва (до spec 033) один раз — своим потоком, показ с диска — по готовности
    h->waiter = std::thread([raw, me] {
        bool tried = false;
        for (;;) {
            if (raw->store->ready()) break;
            if (!tried) {
                const auto s = self() == me ? v2Any() : nullptr;
                tried = s && s->openModelOffline();
            }
            std::unique_lock<std::mutex> lk(raw->loopMu);
            raw->loopCv.wait_for(lk, std::chrono::milliseconds(300), [raw] { return raw->stopLoop; });
            if (raw->stopLoop) return;
        }
        try {
            const auto rowsDone = ph::importLegacyRows(
                *raw->store, historyRowsPath(me), historyMarksPath(me), nullptr,
                [raw](const json &state) { return isClearedState(*raw, state); },
                [](const std::string &m) { LOGI("%s", m.c_str()); });
            if (!rowsDone) LOGE("журнал истории: прежние строки не перенесены в модель — повтор при следующем запуске");
            convertLegacyJournal(*raw, me);
        } catch (const std::exception &e) {
            LOGE("журнал истории: перенос прежнего: %s", e.what());
        }
        raw->ready = true;
        LOGI("журнал истории: строки — в модели");
        if (raw->replayWanted.exchange(false)) runDetached([] { historyReplay(); });
    });
    {
        std::lock_guard<std::mutex> lk(g_histMu);
        g_hist = h;
    }
    LOGI("журнал истории аккаунта открыт");
    return h;
}

} // namespace

// ── публичные ────────────────────────────────────────────────────────────────

void historyNoteGroupDomain(const std::string &address, const std::string &domain, bool authoritative) {
    if (address.empty() || domain.empty()) return;
    std::lock_guard<std::mutex> lk(g_domainMu);
    // Из строк журнала истории — только если домен ещё не известен (домен строки выбран сведением)
    if (!authoritative && g_groupDomains.count(address)) return;
    g_groupDomains[address] = domain;
}

void historyNoteGroupInfo(const std::string &address, const json &info) {
    if (!info.is_object()) return;
    std::set<std::string> deleters;
    for (const auto &m : (info.contains("members") && info["members"].is_array() ? info["members"] : json::array())) {
        if (!m.is_object() || !m.contains("user") || !m["user"].is_string()) continue;
        const auto role = m.contains("role") && m["role"].is_number() ? m["role"].get<int>() : 1;
        const auto &r = m.contains("rights") && m["rights"].is_object() ? m["rights"] : json::object();
        const bool del = r.contains("delete_messages") && r["delete_messages"].is_boolean() && r["delete_messages"].get<bool>();
        if (role == 3 || (role == 2 && del)) deleters.insert(m["user"].get<std::string>());
    }
    std::lock_guard<std::mutex> lk(g_domainMu);
    g_groupDeleters[address] = std::move(deleters);
}

bool historyGroupCanDelete(const std::string &group, const std::string &user) {
    std::lock_guard<std::mutex> lk(g_domainMu);
    const auto it = g_groupDeleters.find(group);
    return it != g_groupDeleters.end() && it->second.count(user) > 0;
}

json historyPeerOf(const std::string &chatAddress) {
    if (chatAddress.empty()) return nullptr;
    if (isGroupAddress(chatAddress)) {
        const auto hex = parvane::v2::groupHex(chatAddress);
        if (hex.size() != 32) return nullptr;
        std::string domain;
        {
            std::lock_guard<std::mutex> lk(g_domainMu);
            if (const auto it = g_groupDomains.find(chatAddress); it != g_groupDomains.end()) domain = it->second;
        }
        if (domain.empty()) {
            const auto me = self();
            domain = me.substr(me.find('@') + 1);
        }
        return json{{"group", {{"domain", domain}, {"id", parvane::v2::hexToB64(hex)}}}};
    }
    if (chatAddress.find('@') == std::string::npos) return nullptr;
    return json{{"user", {{"address", chatAddress}}}};
}

void historyStart() {
    runDetached([] {
        const auto h = ensureHist();
        if (!h) return;
        {
            std::lock_guard<std::mutex> lk(g_histMu);
            if (h->started || g_hist != h) return;
            h->started = true;
        }
        h->sync->start();
        LOGI("журнал истории аккаунта запущен");
    });
}

void historyReset() {
    std::shared_ptr<Hist> h;
    {
        std::lock_guard<std::mutex> lk(g_histMu);
        h = std::move(g_hist);
    }
    h.reset(); // последний держатель останавливает поток журнала
    {
        std::lock_guard<std::mutex> ulk(g_unreadMu);
        g_modelUnread.clear();
    }
    std::lock_guard<std::mutex> lk(g_domainMu);
    g_groupDomains.clear();
    g_groupDeleters.clear();
}

bool historyRecordMessageEvent(json &event, bool own, std::int64_t tsMs, bool inModel) {
    const auto content = event.value("content", json::object());
    if (!journaledContent(content)) return true; // не хранится (TTL, шифртекст, незнакомый вид) — показать как есть
    const auto h = ensureHist();
    if (!h) return true;
    const auto me = self();
    const auto id = event.value("id", std::string());
    const auto from = event.value("from", std::string());
    const auto to = event.value("to", std::string());
    const auto chat = event.value("group", false) ? to : chatOfRow(from, to, me);
    const auto peer = historyPeerOf(chat);
    if (id.empty() || peer.is_null()) return true;
    if (tsMs <= 0) tsMs = event.value("ts", std::int64_t(0)) * 1000;
    auto wire = json{{"id", id}, {"from", from}, {"to", to}, {"ts", static_cast<double>(tsMs) / 1000.0},
                     {"content", contentForJournal(content)}};
    if (event.contains("reply_to") && event["reply_to"].is_string() && !event["reply_to"].get<std::string>().empty())
        wire["reply_to"] = event["reply_to"];
    if (event.contains("proof") && event["proof"].is_string()) wire["proof"] = event["proof"];
    json st;
    if (inModel) {
        // spec 036 (`engine_rows`): строку события итога модели уже применила и поставила в журнал модель
        const auto got = h->store->get(id);
        if (!got) return true;
        st = *got;
    } else {
        try {
            st = h->sync->record(ph::rowOpFromWire(wire, peer), own);
        } catch (const std::exception &e) {
            LOGE("журнал истории: сообщение %s не записано: %s", id.c_str(), e.what());
            return true;
        }
    }
    if (!st.is_object()) return true;
    const auto view = viewOf(*h, st);
    if (view.empty()) return true;
    if (!view.value("visible", false)) {
        LOGI("журнал истории: %s удалено раньше прихода — не показывается", id.c_str());
        return false;
    }
    // Мутации, пришедшие раньше сообщения (правка, реакции, закреп), — уже в строке
    auto shown = contentOfView(view);
    if (content.contains("local_path")) shown["local_path"] = content["local_path"];
    json by;
    event["content"] = shown;
    event["text"] = textOrCaption(shown);
    event["edited"] = view.value("edited", false);
    event["pinned"] = view.value("pinned", false);
    event["reactions"] = reactionsOfView(view, me, &by);
    event["by"] = by;
    event["read"] = rowRead(*h, view);
    event["order"] = view.value("order", std::int64_t(0));
    replaceMeta(id, by, view.value("pinned", false));
    // Своё сообщение (с любого своего устройства) сдвинуло маркер чата — счётчик заново (READ-2, FR-011)
    if (h->sync->isSelf(from)) emit(readStateEvent(*h, chat, strOf(view, "chatKey")));
    return true;
}

json historyRecordOwnOp(const json &op) {
    const auto h = ensureHist();
    return h ? h->sync->record(op, /*own=*/true) : json();
}

std::optional<json> historyState(const std::string &id) {
    const auto h = ensureHist();
    return h ? h->store->get(id) : std::nullopt;
}

void historyApplyIncomingMutation(const parvane::v2::Incoming &in) {
    using Kind = parvane::v2::Incoming::Kind;
    const auto h = ensureHist();
    if (!h) return;
    const auto me = self();
    const auto peer = historyPeerOf(in.chat);
    if (peer.is_null()) return;
    const bool isGroup = isGroupAddress(in.chat);
    const auto stamp = ph::stampOf(in.tsMs > 0 ? in.tsMs : nowMs(), in.id);
    // Чат строки — ключом истории: домен группы в строке может отличаться (выбран сведением движка)
    const auto chatKey = ph::chatKeyOf(peer);
    const auto sameChat = [&](const json &state) { return ph::chatKeyOfState(state) == chatKey; };
    if (in.kind == Kind::Read) {
        if (in.from != me) {
            // Квитанция собеседника о МОИХ сообщениях → ✓✓ (переживает перезапуск: время по чату)
            std::int64_t until = 0;
            for (const auto &target : in.targets) {
                const auto st = h->store->get(target);
                const auto pos = st ? ph::rowPos(*st) : std::nullopt;
                if (!pos || !sameChat(*st) || !h->sync->isSelf((*st)["row"].value("from", std::string()))) continue;
                until = std::max(until, pos->tsMs);
                emit(json{{"type", "outbox_read"}, {"id", target}, {"by", in.from}, {"at", in.ts ? in.ts : nowSec()}});
            }
            if (until > 0) {
                std::lock_guard<std::mutex> lk(h->localMu);
                auto &cur = h->outboxRead[in.chat];
                if (until > cur) {
                    cur = until;
                    h->saveLocalLocked();
                }
            }
            return;
        }
        // Копия СВОЕЙ квитанции с другого своего устройства — маркер «прочитано до» (READ-2, быстрая дорога): маркеры
        // сводит модель (максимум), в журнал пишет устройство, где прочитали
        bool any = false;
        for (const auto &st : h->store->states(in.targets)) {
            if (!sameChat(st)) continue;
            const auto m = ph::markAt(st);
            if (!m.is_object()) continue;
            (void)h->sync->advanceMark(m, /*own=*/false);
            any = true;
        }
        if (any) emit(readStateEvent(*h, in.chat, chatKey));
        return;
    }
    std::vector<json> changed;
    for (const auto &target : in.targets) {
        const auto st = h->store->get(target);
        // Цель должна лежать в чате события: мутация из другого чата не трогает чужое сообщение (WEB-08)
        if (st && !sameChat(*st)) {
            LOGI("v2: мутация для %s пришла из другого чата — пропуск", target.c_str());
            continue;
        }
        json op;
        switch (in.kind) {
        case Kind::Edit: {
            if (!in.content.is_object()) continue;
            // Новое содержимое целиком: текст, подпись медиа, геопозиция поверх прежнего содержимого
            auto content = in.content;
            if (st) {
                const auto view = viewOf(*h, *st);
                if (view.value("visible", false)) {
                    content = contentOfView(view);
                    if (parvane::contentKind(in.content) == "location") {
                        for (auto f = in.content.begin(); f != in.content.end(); ++f) content[f.key()] = f.value();
                    } else if (parvane::contentKind(content) == "text") {
                        content["text"] = strOf(in.content, "text");
                        content["entities"] = in.content.contains("entities") ? in.content["entities"] : json::array();
                    } else {
                        content["caption"] = strOf(in.content, "text");
                        content["entities"] = in.content.contains("entities") ? in.content["entities"] : json::array();
                    }
                }
            }
            // Автор правки — в операции: движок сверяет его с автором строки (и у сироты — когда строка придёт)
            op = ph::editOp(target, peer, stamp, json{{"content", content}}, in.from);
        } break;
        case Kind::Delete: {
            if (!in.forEveryone && in.from != me) continue; // «только у себя» чужого устройства сюда не приходит
            // Права (личный чат — любой участник, группа — автор или админ с правом) проверяет движок по by/by_admin
            const bool isAdmin = in.forEveryone && isGroup && historyGroupCanDelete(in.chat, in.from);
            op = ph::goneOp(target, peer, stamp, in.forEveryone, in.from, isAdmin);
        } break;
        case Kind::Reaction:
            op = ph::reactOp(target, peer, in.from, stamp, in.remove ? std::string() : in.emoji);
            break;
        case Kind::Pin:
            op = ph::pinOp(target, peer, stamp, !in.unpin);
            break;
        default:
            continue;
        }
        const auto next = h->sync->record(op, /*own=*/false);
        if (next.is_object()) changed.push_back(next);
        else if (!st) LOGI("v2: мутация для неизвестного %s — ждёт сообщение", target.c_str());
    }
    if (!changed.empty()) showStates(*h, changed);
}

bool historyDelete(const std::string &id, bool forEveryone, std::string *chatOut, bool *everyoneOut) {
    const auto h = ensureHist();
    if (!h) return false;
    const auto me = self();
    const auto st = h->store->get(id);
    std::string chat;
    if (st) chat = parvane::v2::Session::historyAddress(st->value("chat", json()));
    if (chat.empty()) if (const auto row = messageRow(id)) chat = row->chat;
    const auto peer = historyPeerOf(chat);
    if (peer.is_null()) return false;
    bool everyone = forEveryone;
    const bool isGroup = isGroupAddress(chat);
    if (everyone && st && st->contains("row")) {
        try {
            everyone = ph::call("historyCanDelete", json{{"chatKind", isGroup ? "group" : "user"},
                                                         {"author", (*st)["row"].value("from", std::string())},
                                                         {"deleter", selvesOf(*h)},
                                                         {"deleterIsAdmin", isGroup && historyGroupCanDelete(chat, me)}}).get<bool>();
        } catch (const std::exception &) {
            everyone = false;
        }
        if (!everyone) LOGI("удаление у всех %s не разрешено — только у себя", id.c_str());
    }
    if (chatOut) *chatOut = chat;
    if (everyoneOut) *everyoneOut = everyone;
    return true;
}

void historyRecordDelete(const std::string &id, const std::string &chat, bool everyone, const std::string &opId) {
    const auto h = ensureHist();
    const auto peer = historyPeerOf(chat);
    if (!h || peer.is_null()) return;
    // «только у меня» — только запись журнала (GONE_SCOPE_ME, by = свой адрес): собеседнику ничего
    (void)h->sync->record(ph::goneOp(id, peer, ph::stampOf(nowMs(), opId), everyone, self(), false), /*own=*/true);
    emit(readStateEvent(*h, chat));
}

void historyMarkRead(const std::vector<std::string> &ids) {
    const auto h = ensureHist();
    if (!h) return;
    // Самая поздняя видимая строка среди показанных (место (время, id)) — маркер «прочитано до» каждого чата;
    // сводит его с прежним модель
    std::map<std::string, json> best;
    std::map<std::string, ph::RowPos> bestAt;
    for (const auto &st : h->store->states(ids)) {
        if (st.contains("gone")) continue;
        const auto m = ph::markAt(st);
        const auto pos = ph::rowPos(st);
        if (!m.is_object() || !pos) continue;
        const auto key = ph::chatKeyOfState(st);
        const auto it = bestAt.find(key);
        if (it == bestAt.end() || pos->tsMs > it->second.tsMs || (pos->tsMs == it->second.tsMs && pos->id > it->second.id)) {
            bestAt[key] = *pos;
            best[key] = m;
        }
    }
    for (const auto &[key, mark] : best) {
        const auto chat = parvane::v2::Session::historyAddress(mark.value("chat", json()));
        // Прочтение — намерением модели (spec 036 E4): маркер в журнал пачкой модели, квитанции о ставших
        // прочитанными шлёт она (READ-1 п. 3); счётчик придёт `unread_changed`
        (void)h->sync->advanceMark(mark, /*own=*/true);
        emit(readStateEvent(*h, chat, key));
    }
}

void historyModelChanges(const json &changes) {
    const auto h = hist();
    if (!h || !h->ready) return;
    std::vector<json> views;
    std::vector<json> chatEntries;
    for (const auto &ch : changes) {
        if (!ch.is_object()) continue;
        if (ch.contains("message_upsert")) {
            if (auto v = ph::viewOfModel(ch["message_upsert"]); v.is_object()) views.push_back(std::move(v));
        } else if (ch.contains("message_remove")) {
            if (auto r = ph::removedOfModel(ch["message_remove"]); r.is_object()) {
                // Замена истории точкой (HIST-2): модель снимает все строки и тут же кладёт строки точки — строка,
                // которая к показу снова видна, не снимается
                if (!h->store->views({strOf(r, "id")}).empty()) continue;
                r["visible"] = false;
                r["orphan"] = false;
                views.push_back(std::move(r));
            }
        } else if (ch.contains("unread_changed")) {
            const auto u = ph::unreadOfModel(ch["unread_changed"]);
            const auto chat = u.is_object() ? parvane::v2::Session::historyAddress(u.value("chat", json())) : std::string();
            if (chat.empty()) continue;
            std::lock_guard<std::mutex> lk(g_unreadMu);
            g_modelUnread[chat] = {u.value("unread", 0), u.value("lastReadId", std::string())};
        } else if (ch.contains("chat_upsert")) {
            // spec 036 T035: строка списка чатов — готовым видом модели (место, закреп, архив, отметка, мут)
            if (auto e = chatEntryOf(*h, ph::chatViewOfModel(ch["chat_upsert"]), self()); e.is_object()) {
                chatEntries.push_back(std::move(e));
            }
        } else if (ch.contains("chat_remove")) {
            const auto r = ph::removedChatOfModel(ch["chat_remove"]);
            const auto address = r.is_object() ? parvane::v2::Session::historyAddress(r.value("chat", json())) : std::string();
            if (!address.empty()) chatEntries.push_back(json{{"address", address}, {"removed", true}});
        }
    }
    // Строки — раньше строк списка (последняя строка чата уже показана, когда приходит его вид)
    struct EmitChats {
        std::vector<json> &list;
        ~EmitChats() {
            if (list.empty()) return;
            for (const auto &e : list) {
                if (e.contains("last")) notePaged(e["last"]); // последняя строка показана видом списка
            }
            emit(json{{"type", "chat_views"}, {"chats", list}});
        }
    } emitChats{chatEntries};
    if (views.empty()) return;
    const auto removed = std::count_if(views.begin(), views.end(), [](const json &v) { return !v.value("visible", false); });
    LOGI("журнал истории: применено строк %zu моделью, снято %zu", views.size() - std::size_t(removed), std::size_t(removed));
    showViews(*h, views);
}

void historyEmitReadState(const std::string &chat) {
    if (const auto h = ensureHist()) emit(readStateEvent(*h, chat));
}

std::vector<json> historyRows() {
    std::vector<json> out;
    const auto h = ensureHist();
    if (!h) return out;
    const auto me = self();
    // Готовый показ модели по порядку ленты (ORDER-1 — место модели): надгробий и сирот в нём нет
    for (const auto &mv : h->store->allViews()) {
        const auto view = ph::viewOfModel(mv);
        if (!view.is_object() || isClearedView(*h, view)) continue;
        try {
            auto ev = messageEventOf(*h, view, me);
            ev["order"] = view.value("order", std::int64_t(0));
            out.push_back(std::move(ev));
        } catch (const std::exception &e) {
            // Реплей с диска при запуске: сбойная строка не роняет приложение
            LOGI("журнал истории: строка с диска пропущена (%s)", e.what());
        }
    }
    return out;
}

json historyChatList() {
    const auto h = ensureHist();
    if (!h || !h->ready) return json{{"chats", json::array()}, {"ready", false}};
    const auto me = self();
    auto chats = json::array();
    for (const auto &cv : h->store->chatList()) {
        try {
            if (auto e = chatEntryOf(*h, cv, me); e.is_object()) {
                if (e.contains("last")) notePaged(e["last"]);
                chats.push_back(std::move(e));
            }
        } catch (const std::exception &e) {
            LOGI("список чатов: чат пропущен (%s)", e.what());
        }
    }
    return json{{"chats", chats}, {"ready", true}};
}

json historyPageEvents(const json &args) {
    const auto h = ensureHist();
    const auto address = args.value("chat", std::string());
    const auto peer = historyPeerOf(address);
    if (!h || !h->ready || peer.is_null()) return json{{"ok", false}};
    const auto me = self();
    const auto p = h->store->page(peer, args.value("anchor", std::string()), args.value("direction", std::string("older")),
                                  args.value("limit", 50));
    if (!p.ok) return json{{"ok", false}};
    auto rows = json::array();
    for (const auto &view : p.rows) {
        try {
            if (isClearedView(*h, view)) continue;
            auto ev = messageEventOf(*h, view, me);
            ev["order"] = view.value("order", std::int64_t(0));
            ev["replay"] = true; // показ страницы: без уведомления
            notePaged(ev);
            rows.push_back(std::move(ev));
        } catch (const std::exception &e) {
            LOGI("страница истории: строка пропущена (%s)", e.what());
        }
    }
    return json{{"ok", true}, {"rows", rows}, {"has_older", p.hasOlder}, {"has_newer", p.hasNewer}};
}

void historyReplay() {
    const auto h = ensureHist();
    if (!h) return;
    if (!h->ready) {
        // Модель ещё не открыта (без сети до первого подключения) — показ с диска по её готовности
        h->replayWanted = true;
        if (!h->ready || !h->replayWanted.exchange(false)) return;
    }
    // spec 036 T035 (ENGINE-1): при запуске — только список чатов модели (последняя строка каждого чата); ленту X
    // берёт страницами модели (GetChatHistory → historyPage), а не из памяти шва
    auto list = historyChatList();
    const auto n = list["chats"].size();
    // Голоса и закрытия опросов — служебные строки ленты, сводятся швом (PollStore в памяти): по порядку ленты, раньше
    // списка; ленту листают страницами в любом порядке — старый голос не должен затирать новый
    const auto me = self();
    std::size_t polls = 0;
    for (const auto &mv : h->store->allViews()) {
        const auto view = ph::viewOfModel(mv);
        if (!view.is_object() || isClearedView(*h, view)) continue;
        const auto kind = parvane::contentKind(contentOfView(view));
        if (kind != "poll_vote" && kind != "poll_close") continue;
        try {
            auto ev = messageEventOf(*h, view, me);
            ev["replay"] = true;
            (void)markSeen(ev.value("id", std::string()));
            emitNow(ev);
            ++polls;
        } catch (const std::exception &e) {
            LOGI("журнал: служебная строка опроса пропущена (%s)", e.what());
        }
    }
    emitNow(json{{"type", "chat_list"}, {"chats", list["chats"]}});
    std::map<std::string, std::string> chats; // адрес → ключ чата
    for (const auto &c : list["chats"]) chats[c.value("address", std::string())] = std::string();
    // Счётчики — от маркера (READ-2), не от потока вставок
    for (const auto &mark : h->store->marks()) {
        chats[parvane::v2::Session::historyAddress(mark.value("chat", json()))] = ph::chatKeyOf(mark.value("chat", json()));
    }
    for (const auto &[chat, key] : chats) if (!chat.empty()) emitNow(readStateEvent(*h, chat, key));
    LOGI("журнал: список чатов модели — %zu чатов, служебных строк опросов %zu", n, polls);
}

void historyClearChat(const std::string &chat, std::int64_t untilMs, const std::set<std::string> &ids) {
    const auto h = ensureHist();
    if (!h || chat.empty()) return;
    {
        std::lock_guard<std::mutex> lk(h->localMu);
        if (untilMs > 0) {
            auto &cur = h->clearedUntil[chat];
            cur = std::max(cur, untilMs);
        }
        for (const auto &id : ids) h->clearedIds.insert(id);
        h->saveLocalLocked();
    }
    // Строки очищенного «у себя» — прочь локально (в журнале они остаются; граница — журналом состояния, STATE-1)
    std::vector<std::string> drop(ids.begin(), ids.end());
    for (const auto &s : h->store->chat(ph::chatKeyOf(historyPeerOf(chat)))) {
        if (isClearedState(*h, s)) drop.push_back(s.value("target", std::string()));
    }
    h->store->forget(drop); // у себя без надгробия (модель)
    emit(readStateEvent(*h, chat));
}

void historyForget(const std::string &id) {
    if (const auto h = hist()) h->store->forget({id});
}

void historyMoveFiles(const std::string &oldAddress, const std::string &newAddress) {
    historyReset();
    const auto move = [](const std::string &from, const std::string &to) {
        std::error_code ec;
        if (std::filesystem::exists(from, ec) && !std::filesystem::exists(to, ec)) std::filesystem::rename(from, to, ec);
    };
    // Строки не переписываются (автор своих — прежний адрес, как у остальных устройств)
    move(historyRowsPath(oldAddress), historyRowsPath(newAddress));
    move(historyMarksPath(oldAddress), historyMarksPath(newAddress));
    // Границы очистки и ✓✓ — запись хранилища движка (PathFiles): под новым именем, прежняя снимается
    if (hostExists(historyLocalPath(oldAddress)) && !hostExists(historyLocalPath(newAddress))) {
        if (hostWrite(historyLocalPath(newAddress), hostRead(historyLocalPath(oldAddress)))) hostRemove(historyLocalPath(oldAddress));
    }
    // Служебные документы — файлы хоста (PathFiles): запись под новым именем, прежняя снимается
    for (const auto *name : {"meta.json", "pending.json", "imported.json"}) {
        const auto from = historyAuxPrefix(oldAddress) + name;
        const auto to = historyAuxPrefix(newAddress) + name;
        if (hostExists(from) && !hostExists(to) && hostWrite(to, hostRead(from))) hostRemove(from);
    }
}

} // namespace pvjni
