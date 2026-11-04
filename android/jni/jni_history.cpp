// Parvane Android (spec 033): журнал истории аккаунта поверх общего ядра `parvane::history::HistorySync`
// (desktop/parvane-core/include/parvane/history_sync.h; правила HIST-1, HIST-2, READ-2). Как desktop
// parvane_client_history.cpp: сведение строк, маркер «прочитано до», непрочитанное и права удаления — только движок;
// здесь — хранилище строк устройства, события в шов (message/edited/meta/deleted/read_state) и перенос прежнего
// журнала `journal.jsonl` (события шва до spec 033) один раз.
//
// Файлы каталога хранилища (storecrypt):
//   history-<адрес>.jsonl            — строки RowState (FileRowStore ядра: дозапись + свёртка; надгробия и сироты
//                                      остаются строками и не теряются при свёртке);
//   history-marks-<адрес>.json       — маркеры «прочитано до» по чатам;
//   history-sync-<адрес>-meta.json / -pending.json — курсор, голова, точка, флаг переноса, очередь своих;
//   history-local-<адрес>.json       — границы очистки чатов «у себя», ✓✓ своих (время по чату), неотправленные
//                                      квитанции READ собеседникам (повтор до успеха, READ-1 п. 3).
#include "jni_internal.h"

#include <parvane/history_sync.h>
#include <parvane/local_files.h>
#include <parvane/messenger.h>
#include <parvane/storecrypt.h>
#include <parvane/v2_engine.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <limits>

namespace pvjni {

namespace ph = parvane::history;

namespace {

constexpr std::int64_t kLiveWindowSecs = 300; // ORDER-1: окно «живого» сообщения
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

// Журнал истории одного аккаунта: хранилище, синхронизатор ядра и локальные отметки. Удаляется последним держателем;
// рабочий поток журнала держателем не бывает (колбэки берут сырой указатель), поэтому stop() не ждёт сам себя.
struct Hist {
    std::string owner;
    std::unique_ptr<ph::FileRowStore> store;
    std::unique_ptr<ph::HistorySync> sync;
    bool started = false;

    std::mutex localMu; // ниже
    std::map<std::string, std::int64_t> clearedUntil; // адрес чата → граница очистки «у себя» (мс)
    std::set<std::string> clearedIds;
    std::map<std::string, std::int64_t> outboxRead; // адрес чата → время последнего своего, прочитанного собеседником
    json receipts = json::array();                  // [{chat, ids, attempts}]

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
        if (sync) sync->stop();
        sync.reset();
        store.reset();
    }

    void saveLocalLocked() const {
        json cleared = json::object();
        for (const auto &[a, t] : clearedUntil) cleared[a] = t;
        json outbox = json::object();
        for (const auto &[a, t] : outboxRead) outbox[a] = t;
        parvane::storecrypt::writeFile(historyLocalPath(owner),
            json{{"cleared", cleared}, {"cleared_ids", clearedIds}, {"outbox_read", outbox}, {"receipts", receipts}}.dump());
    }

    void loadLocal() {
        const auto j = json::parse(parvane::storecrypt::readFile(historyLocalPath(owner)), nullptr, false);
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

// Время своего сообщения, прочитанного собеседником (✓✓ переживает перезапуск).
bool ownRowRead(Hist &h, const std::string &chat, std::int64_t tsMs) {
    std::lock_guard<std::mutex> lk(h.localMu);
    const auto it = h.outboxRead.find(chat);
    return it != h.outboxRead.end() && tsMs <= it->second;
}

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

json viewOf(const json &state) {
    try {
        return ph::call("historyView", json{{"state", state}});
    } catch (const std::exception &e) {
        LOGE("журнал истории: строка не показана: %s", e.what());
        return json::object();
    }
}

json contentOfView(const json &view) {
    const auto &body = view.value("body", json::object());
    return body.is_object() ? body.value("content", json::object()) : json::object();
}

// Прочитано ли входящее (маркер чата и historyIsUnread движка) либо своё (✓✓).
bool rowRead(Hist &h, const json &state, const json &view, const std::string &me) {
    const auto chat = parvane::v2::Session::historyAddress(view.value("chat", json()));
    const auto tsMs = view.value("tsMs", std::int64_t(0));
    // Своё — и под прежним адресом (смена ника): свои адреса из сессии журнала движка
    if (h.sync->isSelf(view.value("from", std::string()))) return ownRowRead(h, chat, tsMs);
    try {
        json args{{"state", state}, {"self", selvesOf(h)}};
        const auto mark = h.sync->mark(view.value("chatKey", std::string()));
        if (mark.is_object()) args["mark"] = mark;
        return !ph::call("historyIsUnread", args).get<bool>();
    } catch (const std::exception &) {
        return false;
    }
}

// Видимая строка → событие "message" шва (тот же вид, что живое).
json messageEventOf(Hist &h, const json &state, const json &view, const std::string &me) {
    const auto from = view.value("from", std::string());
    const auto chat = parvane::v2::Session::historyAddress(view.value("chat", json()));
    const bool group = isGroupAddress(chat);
    const bool out = from == me || h.sync->isSelf(from);
    const auto &body = view.value("body", json::object());
    const auto content = contentOfView(view);
    json by;
    auto reactions = reactionsOfView(view, me, &by);
    auto ev = json{{"type", "message"}, {"id", view.value("id", std::string())}, {"from", from},
                   {"to", group ? chat : (out ? chat : me)}, {"ts", view.value("tsMs", std::int64_t(0)) / 1000},
                   {"text", content.value("text", content.value("caption", std::string()))}, {"out", out},
                   {"kind", parvane::contentKind(content)}, {"read", rowRead(h, state, view, me)}, {"content", content},
                   {"reply_to", body.contains("reply_to") && body["reply_to"].is_string() ? body["reply_to"] : json()},
                   {"edited", view.value("edited", false)}, {"pinned", view.value("pinned", false)},
                   {"reactions", reactions}, {"by", by}, {"group", group}, {"proto", 2},
                   {"chat_key", view.value("chatKey", std::string())}};
    if (!out && body.contains("proof") && body["proof"].is_string()) ev["proof"] = body["proof"];
    return ev;
}

json metaEventOf(const json &view, const std::string &me) {
    json by;
    auto reactions = reactionsOfView(view, me, &by);
    const auto id = view.value("id", std::string());
    replaceMeta(id, by, view.value("pinned", false));
    return json{{"type", "meta"}, {"id", id}, {"reactions", reactions}, {"by", by}, {"pinned", view.value("pinned", false)}};
}

// Счётчик чата для шва (READ-2): непрочитанные от маркера (historyIsUnread) и последняя прочитанная строка.
json readStateEvent(Hist &h, const std::string &chat, const std::string &chatKey = std::string()) {
    const auto rs = h.sync->readState(chatKey.empty() ? ph::chatKeyOf(historyPeerOf(chat)) : chatKey);
    return json{{"type", "read_state"}, {"chat", chat}, {"unread", rs.unread}, {"last_read_id", rs.lastReadId}};
}

// Строки, изменившиеся от журнала или чужой мутации, → события шва: новые — "message", правка — "edited", реакции и
// закреп — "meta", надгробие — "deleted"; затем счётчики затронутых чатов (READ-2: пачка счётчик не раздувает —
// он выставляется заново от маркера).
void placeByTime(std::vector<json> &msgs);

void showStates(Hist &h, const std::vector<json> &states) {
    const auto me = self();
    std::map<std::string, std::string> chats; // адрес → ключ чата
    // Строка, менявшаяся в пачке несколько раз, показывается последним состоянием
    std::map<std::string, std::size_t> lastAt;
    for (std::size_t i = 0; i < states.size(); ++i) {
        const auto view = viewOf(states[i]);
        if (!view.empty()) lastAt[view.value("id", std::string())] = i;
    }
    // Новые строки догрузки встают как при реплее с диска (по id — UUIDv7, затем placeByTime), а не порядком операций
    // журнала: на новом устройстве близкие по времени сообщения иначе шли вперемешку (ORDER-1)
    std::vector<json> fresh;
    for (std::size_t i = 0; i < states.size(); ++i) {
        const auto &st = states[i];
        const auto view = viewOf(st);
        if (view.empty() || view.value("orphan", true)) continue; // сирота ждёт сообщение
        const auto id = view.value("id", std::string());
        const auto chat = parvane::v2::Session::historyAddress(view.value("chat", json()));
        if (id.empty() || chat.empty()) continue;
        if (lastAt[id] != i) continue;
        chats[chat] = view.value("chatKey", std::string());
        if (!view.value("visible", false)) {
            forgetMessage(id);
            emit(json{{"type", "deleted"}, {"id", id}});
            continue;
        }
        if (isClearedState(h, st)) continue;
        if (markSeen(id)) {
            auto ev = messageEventOf(h, st, view, me);
            ev["history"] = true; // догрузка журналом — без уведомления
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
            if (row->content.contains("local_path") && row->content.value("file_id", std::string()) == content.value("file_id", std::string()))
                shown["local_path"] = row->content["local_path"];
            updateMessageContent(id, shown);
            emit(json{{"type", "edited"}, {"id", id}, {"content", shown},
                      {"edit_date", view.value("editTsMs", std::int64_t(0)) / 1000}});
        }
        emit(metaEventOf(view, me));
    }
    std::stable_sort(fresh.begin(), fresh.end(),
                     [](const json &a, const json &b) { return a.value("id", std::string()) < b.value("id", std::string()); });
    placeByTime(fresh);
    for (auto &ev : fresh) emit(ev);
    for (const auto &[chat, key] : chats) emit(readStateEvent(h, chat, key));
}

// Порядок показа (ORDER-1): строка, которая старше уже показанных больше чем на окно «живого», встаёт по времени;
// близкие по времени — порядком прихода. Сортировки нет и быть не должно (как desktop ReplayHistory).
void placeByTime(std::vector<json> &msgs) {
    bool misplaced = false;
    auto latest = std::numeric_limits<std::int64_t>::min();
    for (const auto &m : msgs) {
        const auto ts = m.value("ts", std::int64_t(0));
        misplaced = misplaced || (ts + kLiveWindowSecs < latest);
        latest = std::max(latest, ts);
    }
    if (!misplaced) return;
    std::vector<json> ordered;
    ordered.reserve(msgs.size());
    for (auto &m : msgs) {
        const auto ts = m.value("ts", std::int64_t(0));
        auto at = ordered.size();
        while (at > 0 && ordered[at - 1].value("ts", std::int64_t(0)) > ts + kLiveWindowSecs) --at;
        ordered.insert(ordered.begin() + std::ptrdiff_t(at), std::move(m));
    }
    msgs = std::move(ordered);
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

json applyToStore(ph::FileRowStore &store, const json &op, const std::string &target) {
    json args{{"op", op}};
    if (const auto prev = store.get(target)) args["state"] = *prev;
    auto next = ph::call("historyApply", args);
    store.put(next);
    return next;
}

void convertLegacyJournal(Hist &h, const std::string &me) {
    std::error_code ec;
    if (!std::filesystem::exists(legacyJournalPath(), ec)) return;
    const auto msgs = foldLegacyJournal();
    std::map<std::string, json> marks;
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
            auto state = applyToStore(*h.store, ph::rowOpFromWire(wire, peer), id);
            const auto tsMs = m.value("ts", std::int64_t(0)) * 1000;
            if (m.contains("by") && m["by"].is_object())
                for (auto it = m["by"].begin(); it != m["by"].end(); ++it)
                    if (it.value().is_string() && !it.value().get<std::string>().empty())
                        state = applyToStore(*h.store, ph::reactOp(id, peer, it.key(), ph::stampOf(tsMs, std::string()),
                                                                   it.value().get<std::string>()), id);
            if (m.value("pinned", false))
                state = applyToStore(*h.store, ph::pinOp(id, peer, ph::stampOf(tsMs, std::string()), true), id);
            ++converted;
            const bool read = m.value("read", false);
            if (from == me && read) {
                std::lock_guard<std::mutex> lk(h.localMu);
                auto &until = h.outboxRead[chat];
                until = std::max(until, tsMs);
            }
            if (from == me || read) {
                const auto mark = ph::markAt(state);
                const auto key = ph::chatKeyOfState(state);
                auto &cur = marks[key];
                cur = ph::call("historyMarkMerge", cur.is_null() ? json{{"b", mark}} : json{{"a", cur}, {"b", mark}});
            }
        } catch (const std::exception &e) {
            LOGE("журнал истории: строка прежнего журнала не перенесена: %s", e.what());
        }
    }
    for (const auto &[key, mark] : marks) {
        if (!mark.is_object()) continue;
        const auto prev = h.store->mark(key);
        h.store->setMark(key, prev ? ph::call("historyMarkMerge", json{{"a", *prev}, {"b", mark}}) : mark);
    }
    h.store->compact();
    {
        std::lock_guard<std::mutex> lk(h.localMu);
        h.saveLocalLocked();
    }
    std::remove(legacyJournalPath().c_str());
    LOGI("журнал истории: прежний журнал переведён в строки RowState (%d строк, маркеров %zu)", converted, marks.size());
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

void queueReceipts(Hist &h, const std::map<std::string, json> &byChat) {
    if (byChat.empty()) return;
    {
        std::lock_guard<std::mutex> lk(h.localMu);
        for (const auto &[chat, ids] : byChat) h.receipts.push_back(json{{"chat", chat}, {"ids", ids}, {"attempts", 0}});
        h.saveLocalLocked();
    }
    std::lock_guard<std::mutex> lk(h.loopMu);
    h.loopCv.notify_all();
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
    h->store = std::make_unique<ph::FileRowStore>(historyRowsPath(me), historyMarksPath(me), historyAuxPrefix(me));
    h->loadLocal();
    Hist *raw = h.get();
    ph::HistorySyncConfig cfg;
    cfg.self = me;
    cfg.store = h->store.get();
    cfg.request = [owner = me](const std::string &method, const std::string &body) {
        const auto s = self() == owner ? v2Ready() : nullptr;
        if (!s) throw parvane::v2::V2Error("ERROR_CODE_UNAVAILABLE");
        return s->busRequest(false, method, body, std::string());
    };
    cfg.openEngine = [owner = me]() -> std::unique_ptr<parvane::v2::HistorySession> {
        const auto s = self() == owner ? v2Ready() : nullptr;
        return s ? s->openHistorySession() : nullptr;
    };
    cfg.onRows = [raw](const std::vector<json> &states) {
        for (const auto &s : states) {
            const auto &chat = s.value("chat", json());
            if (chat.contains("group") && chat["group"].is_object())
                historyNoteGroupDomain(parvane::v2::Session::historyAddress(chat), chat["group"].value("domain", std::string()),
                                       /*authoritative=*/false);
        }
        showStates(*raw, states);
    };
    cfg.onMark = [raw](const std::string &chatKey, const json &mark) {
        emit(readStateEvent(*raw, parvane::v2::Session::historyAddress(mark.value("chat", json())), chatKey));
    };
    cfg.onReplaced = [raw] {
        // HIST-2: хранилище заменено точкой — шов убирает показанное, чего в ней нет; остальное показывается заново
        std::vector<json> states;
        auto keep = json::array();
        raw->store->forEach([&](const json &s) {
            states.push_back(s);
            const auto view = viewOf(s);
            if (view.value("visible", false)) keep.push_back(view.value("id", std::string()));
        });
        LOGI("журнал истории: история заменена контрольной точкой (%zu строк)", states.size());
        emit(json{{"type", "history_replaced"}, {"keep", keep}});
        resetMessages();
        showStates(*raw, states);
    };
    cfg.legacyOps = [raw] {
        std::vector<json> ops;
        raw->store->forEach([&](const json &s) {
            if (!isClearedState(*raw, s)) ops.push_back(json{{"state", s}});
        });
        raw->store->forEachMark([&](const std::string &, const json &m) { ops.push_back(json{{"read", m}}); });
        return ops;
    };
    cfg.dropRow = [raw](const json &state) { return isClearedState(*raw, state); };
    cfg.log = [](const std::string &m) { LOGI("%s", m.c_str()); };
    h->sync = std::make_unique<ph::HistorySync>(std::move(cfg));
    convertLegacyJournal(*h, me);
    h->receiptLoop = std::thread(receiptLoop, raw);
    {
        std::lock_guard<std::mutex> lk(g_histMu);
        g_hist = h;
    }
    LOGI("журнал истории аккаунта открыт (%zu строк)", h->store->size());
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
    std::lock_guard<std::mutex> lk(g_domainMu);
    g_groupDomains.clear();
    g_groupDeleters.clear();
}

void historySessionEvent(const json &ev) {
    if (const auto h = hist()) h->sync->onSessionEvent(ev);
}

bool historyRecordMessageEvent(json &event, bool own, std::int64_t tsMs) {
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
    try {
        st = h->sync->record(ph::rowOpFromWire(wire, peer), own);
    } catch (const std::exception &e) {
        LOGE("журнал истории: сообщение %s не записано: %s", id.c_str(), e.what());
        return true;
    }
    if (!st.is_object()) return true;
    const auto view = viewOf(st);
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
    event["text"] = shown.value("text", shown.value("caption", std::string()));
    event["edited"] = view.value("edited", false);
    event["pinned"] = view.value("pinned", false);
    event["reactions"] = reactionsOfView(view, me, &by);
    event["by"] = by;
    event["read"] = rowRead(*h, st, view, me);
    replaceMeta(id, by, view.value("pinned", false));
    // Своё сообщение (с любого своего устройства) сдвинуло маркер чата — счётчик заново (READ-2, FR-011)
    if (h->sync->isSelf(from)) emit(readStateEvent(*h, chat, view.value("chatKey", std::string())));
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
        // Копия СВОЕЙ квитанции с другого своего устройства — маркер «прочитано до» (READ-2, быстрая дорога)
        json best;
        for (const auto &target : in.targets) {
            const auto st = h->store->get(target);
            if (!st || !sameChat(*st)) continue;
            const auto m = ph::markAt(*st);
            if (!m.is_object()) continue;
            best = best.is_null() ? m : ph::call("historyMarkMerge", json{{"a", best}, {"b", m}});
        }
        if (best.is_object()) {
            (void)h->sync->advanceMark(best, /*own=*/false); // в журнал пишет устройство, где прочитали
            emit(readStateEvent(*h, in.chat, ph::chatKeyOf(best.value("chat", json()))));
        }
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
                const auto view = viewOf(*st);
                if (view.value("visible", false)) {
                    content = contentOfView(view);
                    if (parvane::contentKind(in.content) == "location") {
                        for (auto f = in.content.begin(); f != in.content.end(); ++f) content[f.key()] = f.value();
                    } else if (parvane::contentKind(content) == "text") {
                        content["text"] = in.content.value("text", std::string());
                        content["entities"] = in.content.contains("entities") ? in.content["entities"] : json::array();
                    } else {
                        content["caption"] = in.content.value("text", std::string());
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
    // Самая поздняя видимая строка среди показанных — маркер «прочитано до» каждого чата
    std::map<std::string, json> best;
    for (const auto &id : ids) {
        const auto st = h->store->get(id);
        if (!st || st->contains("gone")) continue;
        const auto m = ph::markAt(*st);
        if (!m.is_object()) continue;
        const auto key = ph::chatKeyOfState(*st);
        auto &cur = best[key];
        cur = cur.is_null() ? m : ph::call("historyMarkMerge", json{{"a", cur}, {"b", m}});
    }
    std::map<std::string, json> receipts;
    for (const auto &[key, mark] : best) {
        const auto chat = parvane::v2::Session::historyAddress(mark.value("chat", json()));
        const auto read = h->sync->advanceMark(mark, /*own=*/true); // маркер в журнал ≤ 1 с (READ-2)
        emit(readStateEvent(*h, chat, key));
        // Квитанции — только о сообщениях, которые этот сдвиг сделал прочитанными
        for (const auto &s : read) {
            const auto target = s.value("target", std::string());
            if (target.empty()) continue;
            auto &list = receipts[chat];
            if (list.is_null()) list = json::array();
            list.push_back(target);
        }
    }
    queueReceipts(*h, receipts);
}

void historyEmitReadState(const std::string &chat) {
    if (const auto h = ensureHist()) emit(readStateEvent(*h, chat));
}

std::vector<json> historyRows() {
    std::vector<json> out;
    const auto h = ensureHist();
    if (!h) return out;
    const auto me = self();
    std::vector<json> states;
    h->store->forEach([&](const json &s) { states.push_back(s); });
    for (const auto &st : states) {
        if (isClearedState(*h, st)) continue;
        const auto view = viewOf(st);
        if (view.empty() || !view.value("visible", false)) continue;
        out.push_back(messageEventOf(*h, st, view, me));
    }
    // Хранилище отдаёт строки по id (UUIDv7 — по времени отправителя); далеко отставшие — на своё место по времени
    placeByTime(out);
    return out;
}

void historyReplay() {
    const auto h = ensureHist();
    if (!h) return;
    const auto msgs = historyRows();
    std::map<std::string, std::string> chats; // адрес → ключ чата
    for (const auto &m : msgs) {
        const auto id = m.value("id", "");
        (void)markSeen(id);
        const auto from = m.value("from", "");
        const auto to = m.value("to", "");
        const auto chat = m.value("group", false) ? to : chatOfRow(from, to, self());
        chats[chat] = m.value("chat_key", std::string());
        noteMessage(id, from, chat, m.value("content", json::object()), m.value("proof", std::string()));
        replaceMeta(id, m.value("by", json::object()), m.value("pinned", false));
        auto ev = m;
        ev["replay"] = true; // история с диска: шов не уведомляет
        emitNow(ev);
    }
    // Счётчики — от маркера (READ-2), не от потока вставок
    h->store->forEachMark([&](const std::string &key, const json &mark) {
        chats[parvane::v2::Session::historyAddress(mark.value("chat", json()))] = key;
    });
    for (const auto &[chat, key] : chats) if (!chat.empty()) emitNow(readStateEvent(*h, chat, key));
    LOGI("журнал: восстановлено %zu сообщений", msgs.size());
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
    h->store->forEachInChat(ph::chatKeyOf(historyPeerOf(chat)), [&](const json &s) {
        if (isClearedState(*h, s)) drop.push_back(s.value("target", std::string()));
    });
    h->store->erase(drop);
    emit(readStateEvent(*h, chat));
}

void historyForget(const std::string &id) {
    if (const auto h = hist()) h->store->erase({id});
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
    move(historyLocalPath(oldAddress), historyLocalPath(newAddress));
    for (const auto *name : {"meta.json", "pending.json"})
        move(historyAuxPrefix(oldAddress) + name, historyAuxPrefix(newAddress) + name);
}

} // namespace pvjni
