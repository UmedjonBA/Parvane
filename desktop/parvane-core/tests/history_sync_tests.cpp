// Parvane fork: журнал истории аккаунта на клиенте (spec 033, HIST-1, HIST-2, READ-2) без стека: хранилище строк в
// файлах, очередь записи, sync, маркеры, сирота, «только у меня», вход нового устройства по контрольной точке,
// повторное использование сегментов, отказ CAS, откат сервера, горизонт (замена), перенос локальной истории, фоновый
// поток. Сервер — поддельный в памяти с той же семантикой, что messenger `v2_history.rs` (тела — protobuf схемы
// `history/v1`, кодек ниже). Шифрование и сведение — настоящий движок через C ABI.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

#include "parvane/history_sync.h"
#include "parvane/storecrypt.h"
#include "parvane/v2_content.h"
#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"

using nlohmann::json;
namespace v2 = parvane::v2;
namespace hs = parvane::history;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(), info.empty() ? "" : (" — " + info).c_str());
}

// ── мини-кодек protobuf (только то, что нужно поддельному серверу) ─────────────────────────────────────────────────
namespace pb {

void varint(std::string &out, std::uint64_t v) {
    while (v >= 0x80) {
        out.push_back(static_cast<char>((v & 0x7f) | 0x80));
        v >>= 7;
    }
    out.push_back(static_cast<char>(v));
}
void tagged(std::string &out, int field, int wire) { varint(out, (std::uint64_t(field) << 3) | wire); }
void u64f(std::string &out, int field, std::uint64_t v) {
    if (!v) return;
    tagged(out, field, 0);
    varint(out, v);
}
void boolf(std::string &out, int field, bool v) {
    if (!v) return;
    tagged(out, field, 0);
    varint(out, 1);
}
void bytesf(std::string &out, int field, const std::string &v) {
    tagged(out, field, 2);
    varint(out, v.size());
    out += v;
}
void packed(std::string &out, int field, const std::vector<std::uint64_t> &v) {
    if (v.empty()) return;
    std::string body;
    for (auto x : v) varint(body, x);
    bytesf(out, field, body);
}

struct Field {
    int num = 0;
    int wire = 0;
    std::uint64_t v = 0;
    std::string bytes;
};
std::uint64_t readVarint(const std::string &s, std::size_t &i) {
    std::uint64_t v = 0;
    int shift = 0;
    while (i < s.size()) {
        const auto b = static_cast<unsigned char>(s[i++]);
        v |= std::uint64_t(b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
    }
    return v;
}
std::vector<Field> parse(const std::string &s) {
    std::vector<Field> out;
    std::size_t i = 0;
    while (i < s.size()) {
        const auto key = readVarint(s, i);
        Field f;
        f.num = int(key >> 3);
        f.wire = int(key & 7);
        if (f.wire == 0) {
            f.v = readVarint(s, i);
        } else if (f.wire == 2) {
            const auto n = readVarint(s, i);
            f.bytes = s.substr(i, n);
            i += n;
        } else {
            break;
        }
        out.push_back(std::move(f));
    }
    return out;
}
std::vector<std::uint64_t> repeatedU64(const std::vector<Field> &fs, int num) {
    std::vector<std::uint64_t> out;
    for (const auto &f : fs) {
        if (f.num != num) continue;
        if (f.wire == 0) {
            out.push_back(f.v);
        } else {
            std::size_t i = 0;
            while (i < f.bytes.size()) out.push_back(readVarint(f.bytes, i));
        }
    }
    return out;
}

} // namespace pb

// ── поддельный сервер журнала (семантика messenger v2_history.rs) ─────────────────────────────────────────────────
struct FakeServer {
    struct Rec {
        std::string opId, ct;
        bool chunk = false;
    };
    struct Cp {
        std::uint64_t id = 0, upto = 0, summary = 0;
        std::vector<std::uint64_t> chunks;
        std::int64_t created = 0;
    };
    std::mutex mu;
    std::map<std::uint64_t, Rec> log;
    std::uint64_t head = 0;
    std::optional<Cp> cp;
    std::size_t appends = 0, chunkAppends = 0, commits = 0;
    std::atomic<std::int64_t> clock{1700000000000};

    static std::string record(std::uint64_t seq, const Rec &r) {
        std::string out;
        pb::u64f(out, 1, seq);
        pb::bytesf(out, 2, r.opId);
        pb::bytesf(out, 3, r.ct);
        pb::boolf(out, 4, r.chunk);
        return out;
    }
    std::string checkpoint() const {
        std::string out;
        pb::u64f(out, 1, cp->id);
        pb::u64f(out, 2, cp->upto);
        pb::u64f(out, 3, cp->summary);
        pb::packed(out, 4, cp->chunks);
        pb::u64f(out, 5, static_cast<std::uint64_t>(cp->created));
        return out;
    }

    std::string handle(const std::string &method, const std::string &body) {
        std::lock_guard<std::mutex> lk(mu);
        const auto f = pb::parse(body);
        const auto u = [&](int n) {
            for (const auto &x : f) if (x.num == n && x.wire == 0) return x.v;
            return std::uint64_t(0);
        };
        const auto b = [&](int n) {
            for (const auto &x : f) if (x.num == n && x.wire == 2) return x.bytes;
            return std::string();
        };
        std::string out;
        if (method == "history.append") {
            const Rec r{b(1), b(2), u(3) != 0};
            for (const auto &[seq, x] : log) {
                if (x.opId != r.opId) continue;
                if (x.ct == r.ct && x.chunk == r.chunk) {
                    pb::u64f(out, 1, seq);
                    return out;
                }
                throw v2::V2Error("ERROR_CODE_DUPLICATE");
            }
            log[++head] = r;
            ++appends;
            if (r.chunk) ++chunkAppends;
            pb::u64f(out, 1, head);
            return out;
        }
        if (method == "history.sync") {
            auto after = u(1);
            const bool skip = u(3) != 0;
            if (cp && after < cp->upto) {
                after = cp->upto;
                pb::bytesf(out, 4, checkpoint());
            }
            std::size_t n = 0;
            bool more = false;
            for (auto it = log.upper_bound(after); it != log.end(); ++it) {
                if (skip && it->second.chunk) continue;
                if (n == 3) { // маленькая страница — проверить листание
                    more = true;
                    break;
                }
                pb::bytesf(out, 1, record(it->first, it->second));
                ++n;
            }
            pb::boolf(out, 2, more);
            pb::u64f(out, 3, head);
            return out;
        }
        if (method == "history.head") {
            pb::u64f(out, 1, head);
            if (cp) pb::bytesf(out, 2, checkpoint());
            return out;
        }
        if (method == "history.get") {
            for (const auto s : pb::repeatedU64(f, 1)) {
                if (const auto it = log.find(s); it != log.end()) pb::bytesf(out, 1, record(s, it->second));
            }
            return out;
        }
        if (method == "history.checkpoint.commit") {
            const auto expected = u(1), upto = u(2), summary = u(3);
            const auto chunks = pb::repeatedU64(f, 4);
            if ((cp ? cp->id : 0) != expected) throw v2::V2Error("ERROR_CODE_DUPLICATE");
            if (!summary || summary > upto || upto > head || (cp && upto < cp->upto)) throw v2::V2Error("ERROR_CODE_INVALID");
            std::set<std::uint64_t> keep(chunks.begin(), chunks.end());
            keep.insert(summary);
            for (const auto s : keep) {
                const auto it = log.find(s);
                if (s > upto || it == log.end() || !it->second.chunk) throw v2::V2Error("ERROR_CODE_INVALID");
            }
            for (auto it = log.begin(); it != log.end();) {
                if (it->first <= upto && !keep.count(it->first)) it = log.erase(it);
                else ++it;
            }
            Cp c;
            c.id = (cp ? cp->id : 0) + 1;
            c.upto = upto;
            c.summary = summary;
            c.chunks = chunks;
            c.created = clock.load();
            cp = c;
            ++commits;
            pb::u64f(out, 1, c.id);
            return out;
        }
        throw v2::V2Error("ERROR_CODE_NOT_FOUND");
    }
    // Откат: сервер «забыл» записи после seq (восстановлен из старой копии).
    void rollbackTo(std::uint64_t seq) {
        std::lock_guard<std::mutex> lk(mu);
        for (auto it = log.upper_bound(seq); it != log.end();) it = log.erase(it);
        head = seq;
    }
    std::uint64_t headSeq() {
        std::lock_guard<std::mutex> lk(mu);
        return head;
    }
};

// ── устройство аккаунта ──────────────────────────────────────────────────────────────────────────────────────────
static const std::string kSelf = "alice@local";
static const std::string kBob = "bob@local";
// Свой адрес хоста для новых устройств теста (пусто — kSelf). Иной адрес при сессии движка под kSelf — модель смены
// ника: хост знает новый адрес, движок — прежний (свои строки до смены — под прежним).
static std::string g_deviceSelf;

struct Device {
    std::string dir;
    std::unique_ptr<v2::Client> client;
    std::unique_ptr<hs::FileRowStore> store;
    std::unique_ptr<hs::HistorySync> sync;
    std::vector<json> rows;
    std::map<std::string, json> marks;
    int replaced = 0;
    std::vector<json> legacy;
    std::mutex mu;
    std::atomic<std::int64_t> *clock = nullptr;
    std::vector<std::string> logs;

    Device(const std::string &name, FakeServer &server, const std::string &clientBlob, const std::string &key,
           bool thread = false, std::atomic<std::int64_t> *clk = nullptr)
    : clock(clk) {
        dir = (std::filesystem::temp_directory_path() / ("pv-history-test-" + std::to_string(::getpid()) + "-" + name)).string();
        std::filesystem::remove_all(dir);
        std::filesystem::create_directories(dir);
        client = v2::Client::import(clientBlob, key);
        open(server, thread);
    }
    void open(FakeServer &server, bool thread) {
        store = std::make_unique<hs::FileRowStore>(dir + "/rows.jsonl", dir + "/marks.json", dir + "/aux-");
        hs::HistorySyncConfig cfg;
        cfg.self = g_deviceSelf.empty() ? kSelf : g_deviceSelf;
        cfg.store = store.get();
        cfg.request = [&server](const std::string &m, const std::string &b) { return server.handle(m, b); };
        cfg.openEngine = [this] { return v2::HistorySession::open(*client); };
        cfg.onRows = [this](const std::vector<json> &r) {
            std::lock_guard<std::mutex> lk(mu);
            rows.insert(rows.end(), r.begin(), r.end());
        };
        cfg.onMark = [this](const std::string &k, const json &m) {
            std::lock_guard<std::mutex> lk(mu);
            marks[k] = m;
        };
        cfg.onReplaced = [this] { ++replaced; };
        cfg.legacyOps = [this] { return legacy; };
        cfg.log = [this](const std::string &m) {
            std::lock_guard<std::mutex> lk(mu);
            logs.push_back(m);
        };
        if (clock) cfg.nowMs = [this] { return clock->load(); };
        cfg.thread = thread;
        cfg.ownDelayMs = 50;
        cfg.markDelayMs = 50;
        cfg.incomingMinMs = 100;
        cfg.incomingMaxMs = 200;
        cfg.pollMs = 60000;
        cfg.retryMs = 200;
        sync = std::make_unique<hs::HistorySync>(std::move(cfg));
    }
    void reopen(FakeServer &server) {
        sync.reset();
        store.reset();
        open(server, false);
    }
    ~Device() {
        sync.reset();
        store.reset();
        std::filesystem::remove_all(dir);
    }
    bool visible(const std::string &id) {
        const auto s = store->get(id);
        return s && sync->view(*s).value("visible", false);
    }
    bool loggedContains(const std::string &needle) {
        std::lock_guard<std::mutex> lk(mu);
        for (const auto &l : logs) if (l.find(needle) != std::string::npos) return true;
        return false;
    }
};

static json bobChat() { return json{{"user", {{"address", kBob}}}}; }

static json wire(const std::string &id, const std::string &from, const std::string &to, double tsSec, const std::string &text) {
    return json{{"id", id}, {"from", from}, {"to", to}, {"ts", tsSec}, {"content", {{"kind", "text"}, {"text", text}}}};
}

static std::string uid(int n) {
    char buf[64];
    std::snprintf(buf, sizeof buf, "0192f1a2-0000-7000-8000-%012x", n);
    return buf;
}

int main() {
    std::printf("=== parvane-core history_sync tests (движок %s) ===\n", v2::engineVersion().c_str());

    // ── чистые функции ───────────────────────────────────────────────────────────────────────────────────────────
    {
        const auto op = hs::rowOpFromWire(wire(uid(1), kBob, kSelf, 1000.5, "привет"), bobChat());
        check(hs::opTarget(op) == uid(1), "строка формата привязки → операция row (id — UUID)");
        check(op["row"].value("ts_ms", std::string()) == "1000500", "время строки — миллисекунды (доли секунды не теряются)");
        const auto st = hs::call("historyApply", json{{"op", op}});
        const auto view = hs::call("historyView", json{{"state", st}});
        check(view.value("chatKey", std::string()) == hs::chatKeyOfState(st) && hs::chatKeyOfState(st) == "u:" + kBob,
              "ключ чата ядра = ключ движка (личный чат)");
        const json group{{"group", {{"domain", "x"}, {"id", "QkJCQkJCQkJCQkJCQkJCQg=="}}}};
        const json groupY{{"group", {{"domain", "y.example"}, {"id", "QkJCQkJCQkJCQkJCQkJCQg=="}}}};
        check(hs::chatKeyOf(group) == "g:42424242424242424242424242424242"
                  && hs::chatKeyOf(group) == hs::call("historyChatKey", json{{"chat", group}}).get<std::string>(),
              "ключ чата ядра = ключ движка (группа, без домена)");
        check(hs::chatKeyOf(groupY) == hs::chatKeyOf(group), "одна группа под двумя доменами — один ключ чата");
        check(hs::chatKeyOf(bobChat()) == hs::call("historyChatKey", json{{"chat", bobChat()}}).get<std::string>(),
              "ключ чата ядра = ключ движка (личный, historyChatKey)");
        const auto m = hs::markAt(st);
        check(m.value("up_to_id", std::string()) == uid(1) && m.value("up_to_ts_ms", std::string()) == "1000500",
              "маркер «прочитано до» строки");
        const auto stamp = hs::stampOf(0, "");
        check(stamp.contains("op_id") && stamp.contains("ts_ms"), "новая метка (historyNewStamp)");
        bool canPeer = hs::call("historyCanDelete", json{{"chatKind", "user"}, {"author", kBob}, {"deleter", kSelf}}).get<bool>();
        bool canGroup = hs::call("historyCanDelete", json{{"chatKind", "group"}, {"author", kBob}, {"deleter", kSelf}}).get<bool>();
        check(canPeer && !canGroup, "права удаления — движком: чужое в личном чате можно, в группе без права нельзя");
    }

    // ── хранилище строк в файлах ─────────────────────────────────────────────────────────────────────────────────
    {
        const auto dir = (std::filesystem::temp_directory_path() / ("pv-history-store-" + std::to_string(::getpid()))).string();
        std::filesystem::remove_all(dir);
        std::filesystem::create_directories(dir);
        const auto rows = dir + "/rows.jsonl";
        {
            // Журнал прежнего формата (StoredMessage) + новая строка
            parvane::storecrypt::appendLine(rows, wire(uid(5), kBob, kSelf, 10, "старое").dump());
        }
        auto st = hs::call("historyApply", json{{"op", hs::rowOpFromWire(wire(uid(6), kSelf, kBob, 11, "a"), bobChat())}});
        {
            hs::FileRowStore store(rows, dir + "/marks.json", dir + "/aux-");
            check(store.size() == 0, "строка прежнего формата не принята за RowState");
            store.put(st);
            st = hs::call("historyApply", json{{"state", st}, {"op", hs::goneOp(uid(6), bobChat(), hs::stampOf(12000, uid(60)), false)}});
            store.put(st);
            store.setMark("u:" + kBob, hs::markAt(*store.get(uid(6))));
            store.setAux("meta", json{{"cursor", 7}});
            check(store.appendedSinceCompact() == 2, "новое состояние дописывается строкой");
        }
        {
            hs::FileRowStore store(rows, dir + "/marks.json", dir + "/aux-");
            const auto got = store.get(uid(6));
            check(got && got->contains("gone"), "после перезапуска — последнее состояние (надгробие сохранено)");
            check(store.mark("u:" + kBob).has_value(), "маркер пережил перезапуск");
            check(store.aux("meta").value("cursor", 0) == 7, "служебный документ пережил перезапуск");
            int n = 0;
            store.forEachInChat("u:" + kBob, [&](const json &) { ++n; });
            check(n == 1, "перебор по чату");
            const auto legacy = store.takeLegacyRows();
            check(legacy.size() == 1 && legacy[0].value("id", std::string()) == uid(5), "строки прежнего формата отданы на перенос");
            store.compact();
        }
        {
            hs::FileRowStore store(rows, dir + "/marks.json", dir + "/aux-");
            check(store.takeLegacyRows().empty() && store.size() == 1, "после переноса и свёртки прежних строк нет");
            store.clear();
        }
        {
            hs::FileRowStore store(rows, dir + "/marks.json", dir + "/aux-");
            check(store.size() == 0 && !store.mark("u:" + kBob), "замена: строки и маркеры стёрты");
        }
        std::filesystem::remove_all(dir);
    }

    // ── два устройства одного аккаунта ───────────────────────────────────────────────────────────────────────────
    const std::string key(32, '\x07');
    std::string blob;
    {
        auto c = v2::Client::create(kSelf, "d1", "local");
        (void)c->ensureStateKey();
        blob = c->exportState(key);
        check(v2::HistorySession::open(*c) != nullptr, "сессия журнала истории открыта (ключ состояния есть)");
        auto bare = v2::Client::create(kSelf, "d9", "local");
        check(v2::HistorySession::open(*bare) == nullptr, "без ключа состояния сессии нет");
    }
    FakeServer server;
    Device a("a", server, blob, key), b("b", server, blob, key);
    check(a.sync->syncNow() && b.sync->syncNow(), "пустой журнал: sync");

    // Сообщение собеседника, затем своё ответом, затем ещё одно входящее
    const auto in1 = hs::rowOpFromWire(wire(uid(1), kBob, kSelf, 1000, "раз"), bobChat());
    const auto out2 = hs::rowOpFromWire(wire(uid(2), kSelf, kBob, 2000, "ответ"), bobChat());
    const auto in3 = hs::rowOpFromWire(wire(uid(3), kBob, kSelf, 3000, "три"), bobChat());
    a.sync->record(in1, false);
    a.sync->record(out2, true);
    a.sync->record(in3, false);
    check(a.sync->unreadCount("u:" + kBob) == 1, "своё сообщение сдвигает маркер: непрочитанное — только после него");
    check(a.sync->flushNow(), "запись очереди (своё + входящее)");
    const auto headAfterA = server.headSeq();
    check(headAfterA >= 1, "журнал на сервере не пуст", std::to_string(headAfterA));
    check(b.sync->syncNow(), "второе устройство: sync");
    check(b.visible(uid(1)) && b.visible(uid(2)) && b.visible(uid(3)), "второе устройство получило все строки");
    check(b.sync->unreadCount("u:" + kBob) == 1, "второе устройство: тот же счётчик (маркер из журнала)");
    check(!b.rows.empty(), "колбэк строк от журнала");

    // Повтор входящего, уже записанного другим своим устройством, не пишется снова (видели в журнале)
    {
        const auto before = server.headSeq();
        b.sync->record(in3, false);
        b.sync->flushNow();
        check(server.headSeq() == before, "входящее, уже бывшее в журнале, не дублируется");
    }

    // Прочтение на A → B: бейдж 0 (READ-2)
    {
        const auto read = a.sync->advanceMark(hs::markAt(*a.store->get(uid(3))), true);
        check(read.size() == 1 && read[0].value("target", std::string()) == uid(3), "прочтение: стали прочитанными — для квитанций");
        check(a.sync->unreadCount("u:" + kBob) == 0, "прочтение: бейдж 0 на этом устройстве");
        a.sync->flushNow();
        b.marks.clear();
        b.sync->syncNow();
        check(b.marks.count("u:" + kBob) == 1 && b.sync->unreadCount("u:" + kBob) == 0, "прочтение дошло до второго устройства (колбэк маркера, бейдж 0)");
        const auto stale = b.sync->advanceMark(hs::markAt(*b.store->get(uid(1))), true);
        check(stale.empty() && b.sync->unreadCount("u:" + kBob) == 0, "маркер не откатывается назад");
    }

    // Удаление «у всех» чужого и «только у меня» своего (HIST-1)
    {
        a.sync->record(hs::goneOp(uid(1), bobChat(), hs::stampOf(4000, uid(41)), true), true);
        a.sync->record(hs::goneOp(uid(2), bobChat(), hs::stampOf(4001, uid(42)), false), true);
        a.sync->flushNow();
        b.sync->syncNow();
        check(!b.visible(uid(1)) && !b.visible(uid(2)) && b.visible(uid(3)), "удалённое (у всех и только у меня) не видно на втором устройстве");
        const auto v = b.sync->view(*b.store->get(uid(2)));
        check(v.value("deletedScope", std::string()) == "me", "область удаления «только у меня» сохранена");
        const auto again = b.sync->record(in1, false);
        check(!b.sync->view(again).value("visible", true), "повторный приход удалённого сообщения его не воскрешает");
    }

    // Сирота: удаление пришло раньше сообщения
    {
        b.sync->record(hs::goneOp(uid(7), bobChat(), hs::stampOf(5000, uid(71)), true), false);
        const auto orphan = b.sync->view(*b.store->get(uid(7)));
        check(orphan.value("orphan", false) && !orphan.value("visible", true), "мутация до цели сохранена сиротой");
        a.sync->record(hs::rowOpFromWire(wire(uid(7), kBob, kSelf, 4500, "поздно"), bobChat()), false);
        a.sync->flushNow();
        b.sync->syncNow();
        check(!b.visible(uid(7)), "сообщение, удалённое до прихода, не появляется");
        b.sync->flushNow();
        a.sync->syncNow();
        check(!a.visible(uid(7)), "удаление-сирота дошло и до устройства, где сообщение было");
    }

    // Правка до сообщения: применяется, только если автор совпал (права — до прихода строки)
    {
        const auto fake = hs::editOp(uid(30), bobChat(), hs::stampOf(7000, uid(31)), json{{"content", {{"kind", "text"}, {"text", "подмена"}}}});
        check(b.sync->record(fake, false, kBob).is_null() && !b.store->get(uid(30)), "правка неизвестного сообщения ждёт его строку");
        b.sync->record(hs::rowOpFromWire(wire(uid(30), kSelf, kBob, 6900, "моё"), bobChat()), false);
        check(!b.sync->view(*b.store->get(uid(30))).value("edited", true), "правка чужого (не автора) отброшена, когда строка пришла");
        const auto real = hs::editOp(uid(32), bobChat(), hs::stampOf(7100, uid(33)), json{{"content", {{"kind", "text"}, {"text", "исправлено"}}}});
        b.sync->record(real, false, kBob);
        const auto st = b.sync->record(hs::rowOpFromWire(wire(uid(32), kBob, kSelf, 7050, "опечатка"), bobChat()), false);
        check(b.sync->view(st).value("edited", false), "правка автора применена, когда строка пришла");
        check(b.sync->record(fake, false, kBob).is_null() || true, "повтор правки — без падения");
        const auto denied = hs::editOp(uid(32), bobChat(), hs::stampOf(7200, uid(34)), json{{"content", {{"kind", "text"}, {"text", "чужая"}}}});
        check(b.sync->record(denied, false, kSelf).is_null(), "правка известного чужого сообщения отвергнута");
    }

    // То же в движке (поле by): чужая правка/удаление сироты — кандидат, автор сверяется, когда строка придёт
    {
        const auto fake = hs::editOp(uid(35), bobChat(), hs::stampOf(7300, uid(36)),
                                     json{{"content", {{"kind", "text"}, {"text", "подмена"}}}}, kBob);
        b.sync->record(fake, false);
        const auto groupChat = json{{"group", {{"domain", "local"}, {"id", "QkJCQkJCQkJCQkJCQkJCQg=="}}}};
        b.sync->record(hs::goneOp(uid(37), groupChat, hs::stampOf(7400, uid(38)), true, kBob, false), false);
        b.sync->record(hs::rowOpFromWire(wire(uid(35), kSelf, kBob, 7250, "моё"), bobChat()), false);
        b.sync->record(hs::rowOpFromWire(wire(uid(37), kSelf, "v2g:42424242424242424242424242424242", 7350, "в группе"), groupChat), false);
        check(!b.sync->view(*b.store->get(uid(35))).value("edited", true), "движок: правка сироты не автором не применяется (by)");
        check(b.visible(uid(37)), "движок: удаление в группе не автором и не админом не применяется (by)");
    }

    // Правка, реакция, закреп — сводятся одинаково
    {
        a.sync->record(hs::editOp(uid(3), bobChat(), hs::stampOf(6000, uid(81)), json{{"content", {{"kind", "text"}, {"text", "три!"}}}}), false);
        a.sync->record(hs::reactOp(uid(3), bobChat(), kSelf, hs::stampOf(6001, uid(82)), "👍"), true);
        a.sync->record(hs::pinOp(uid(3), bobChat(), hs::stampOf(6002, uid(83)), true), true);
        a.sync->flushNow();
        b.sync->syncNow();
        const auto va = a.sync->view(*a.store->get(uid(3)));
        const auto vb = b.sync->view(*b.store->get(uid(3)));
        check(va == vb && vb.value("edited", false) && vb.value("pinned", false) && vb["reactions"].size() == 1,
              "правка, реакция, закреп: одинаково на обоих устройствах");
    }

    // Перезапуск: всё на месте
    {
        const auto unreadBefore = b.sync->unreadCount("u:" + kBob);
        b.reopen(server);
        check(!b.visible(uid(1)) && b.visible(uid(3)) && b.sync->unreadCount("u:" + kBob) == unreadBefore,
              "перезапуск: удалённого нет, бейдж прежний");
        check(b.sync->syncNow(), "перезапуск: sync от сохранённого курсора");
        check(b.sync->status().value("cursor", 0) == server.headSeq(), "курсор = голова журнала");
    }

    // Контрольная точка и вход нового устройства (HIST-2)
    {
        check(a.sync->syncNow() && a.sync->checkpointNow(true), "контрольная точка записана");
        check(server.cp && server.commits == 1, "сервер принял точку (CAS)");
        const auto chunkUploads = server.chunkAppends;
        Device c("c", server, blob, key);
        check(c.sync->syncNow(), "новое устройство: вход по точке");
        check(c.sync->status().value("joined", false) && c.sync->status().value("checkpointId", 0) == 1, "новое устройство знает точку");
        check(!c.visible(uid(1)) && !c.visible(uid(2)) && !c.visible(uid(7)) && c.visible(uid(3)), "новое устройство: удалённого нет");
        check(c.sync->unreadCount("u:" + kBob) == 0, "новое устройство: бейдж 0");
        check(c.sync->view(*c.store->get(uid(3))) == a.sync->view(*a.store->get(uid(3))), "новое устройство: та же строка (правка, реакция, закреп)");
        // Без изменений — сегменты прежние
        a.sync->syncNow();
        check(a.sync->checkpointNow(true), "вторая точка");
        check(server.chunkAppends - chunkUploads == 1, "неизменные сегменты не перезаливаются (только сводка)",
              std::to_string(server.chunkAppends - chunkUploads));
        // Новые записи после точки — дельтой
        a.sync->record(hs::rowOpFromWire(wire(uid(9), kBob, kSelf, 9000, "после точки"), bobChat()), false);
        a.sync->flushNow();
        c.sync->syncNow();
        check(c.visible(uid(9)) && c.sync->unreadCount("u:" + kBob) == 1, "после точки — дельта журнала");
        // Отказ CAS: c знает прежнюю точку, а a уже записал новую
        c.sync->record(hs::rowOpFromWire(wire(uid(10), kSelf, kBob, 9500, "c"), bobChat()), true);
        c.sync->flushNow();
        a.sync->syncNow();
        check(a.sync->checkpointNow(true), "третья точка (a)");
        b.sync->syncNow();
        check(b.sync->status().value("checkpointId", 0) <= 3, "точки идут по порядку");
    }

    // Отказ CAS: две точки на одну прежнюю
    {
        FakeServer s2;
        Device x("x", s2, blob, key), y("y", s2, blob, key);
        x.sync->record(in1, true);
        x.sync->flushNow();
        x.sync->syncNow();
        y.sync->syncNow();
        // y собирает точку на прежней (нет точки), но x успевает раньше: подменим порядок — x коммитит, затем y
        check(x.sync->checkpointNow(true), "x: точка");
        // y думает, что точки нет: ручной commit с expected=0 через сессию движка
        bool dup = false;
        try {
            auto eng = v2::HistorySession::open(*y.client);
            const auto body = eng->call("commitRequest", json{{"expected", 0}, {"uptoSeq", 1}, {"summarySeq", 1}, {"chunkSeqs", json::array()}});
            (void)s2.handle("history.checkpoint.commit", v2::fromBase64(body.get<std::string>()));
        } catch (const v2::V2Error &e) {
            dup = e.code() == "ERROR_CODE_DUPLICATE";
        }
        check(dup, "сервер отвергает точку на устаревшей (CAS → DUPLICATE)");
    }

    // Откат сервера: голова меньше виденной — журнал не применяется
    {
        FakeServer s3;
        Device x("rx", s3, blob, key), y("ry", s3, blob, key);
        x.sync->record(in1, true);
        x.sync->flushNow();
        x.sync->record(in3, true);
        x.sync->flushNow();
        x.sync->record(out2, true);
        x.sync->flushNow();
        y.sync->syncNow();
        const auto head = s3.headSeq();
        s3.rollbackTo(1);
        x.sync->record(hs::rowOpFromWire(wire(uid(11), kBob, kSelf, 11000, "после отката"), bobChat()), true);
        x.sync->flushNow();
        check(!y.sync->syncNow() && y.loggedContains("откат сервера"), "откат сервера замечен, журнал не применён",
              std::to_string(head));
        check(!y.visible(uid(11)), "записи «откатившегося» журнала не применены");
    }

    // Горизонт: устройство, не синхронизировавшееся дольше 180 дней, заменяет историю точкой
    {
        FakeServer s4;
        std::atomic<std::int64_t> clock{1700000000000};
        Device x("hx", s4, blob, key, false, &clock), y("hy", s4, blob, key, false, &clock);
        x.sync->record(in1, true);
        x.sync->flushNow();
        y.sync->syncNow();
        // Только у y и не в журнале (так бывает со строкой, воскрешённой прежним механизмом)
        y.store->put(hs::call("historyApply", json{{"op", hs::rowOpFromWire(wire(uid(12), kBob, kSelf, 1200, "лишнее"), bobChat())}}));
        clock += 200LL * 24 * 3600 * 1000;
        s4.clock = clock.load();
        x.sync->record(hs::goneOp(uid(1), bobChat(), hs::stampOf(clock.load(), uid(13)), true), true);
        x.sync->flushNow();
        x.sync->syncNow();
        check(x.sync->checkpointNow(true), "точка через 200 дней");
        check(y.sync->syncNow(), "давно не синхронизированное устройство: sync");
        check(y.replaced == 1 && !y.visible(uid(12)) && !y.visible(uid(1)), "замена вместо сведения: лишнего и удалённого нет");
    }

    // Перенос локальной истории — один раз
    {
        FakeServer s5;
        Device x("mx", s5, blob, key);
        x.legacy = {hs::rowOpFromWire(wire(uid(20), kBob, kSelf, 100, "до журнала"), bobChat()),
                    hs::goneOp(uid(21), bobChat(), hs::stampOf(200, uid(22)), true),
                    json{{"read", {{"chat", bobChat()}, {"up_to_ts_ms", "100000"}, {"up_to_id", uid(20)}}}}};
        check(x.sync->syncNow() && x.sync->flushNow(), "перенос: sync и запись");
        check(x.sync->status().value("migrated", false) && s5.headSeq() >= 1, "локальная история перенесена в журнал");
        const auto head = s5.headSeq();
        x.reopen(s5);
        x.sync->syncNow();
        x.sync->flushNow();
        check(s5.headSeq() == head, "повторного переноса нет");
        Device y("my", s5, blob, key);
        y.sync->syncNow();
        check(y.visible(uid(20)) && y.store->get(uid(21)) && !y.visible(uid(21)), "перенесённое (со своими надгробиями) — на другом устройстве");
        check(y.sync->unreadCount("u:" + kBob) == 0 && !y.sync->mark("u:" + kBob).is_null(), "перенесённый маркер прочтения — на другом устройстве");
    }

    // Смена ника (spec 026): свои строки под прежним адресом — свои (не входящие, сдвигают маркер)
    {
        FakeServer s7;
        g_deviceSelf = "alice2@local";
        Device r("rn", s7, blob, key);
        g_deviceSelf.clear();
        r.sync->syncNow(); // сессия движка открыта — свои адреса известны
        const auto selves = r.sync->selfAddresses();
        check(selves.size() == 2 && selves[0] == "alice2@local" && selves[1] == kSelf, "свои адреса: текущий и прежний (сессия движка)");
        r.sync->record(in1, false);
        r.sync->record(out2, false); // своё под прежним адресом, пришло журналом/входящим путём
        check(r.sync->unreadCount("u:" + kBob) == 0, "своё под прежним адресом сдвигает маркер и не считается входящим");
        r.sync->record(in3, false);
        check(r.sync->unreadCount("u:" + kBob) == 1, "после своего — только новое входящее");
        const bool can = hs::call("historyCanDelete", json{{"chatKind", "group"}, {"author", kSelf},
                                                           {"deleter", json::array({"alice2@local", kSelf})}}).get<bool>();
        check(can, "право удаления своего под прежним адресом — по набору своих адресов");
    }

    // Федеративная группа: строки одной группы под разными доменами — один чат (сегменты, маркеры, счётчик)
    {
        FakeServer s8;
        Device g1("gd", s8, blob, key);
        g1.sync->syncNow();
        const json gx{{"group", {{"domain", "local"}, {"id", "QkJCQkJCQkJCQkJCQkJCQg=="}}}};
        const json gy{{"group", {{"domain", "fed.example"}, {"id", "QkJCQkJCQkJCQkJCQkJCQg=="}}}};
        const auto key = hs::chatKeyOf(gx);
        g1.sync->record(hs::rowOpFromWire(wire(uid(80), kBob, "", 100, "раз"), gx), false);
        g1.sync->record(hs::rowOpFromWire(wire(uid(81), kBob, "", 200, "два"), gy), false);
        int n = 0;
        g1.store->forEachInChat(key, [&](const json &) { ++n; });
        check(n == 2 && g1.sync->unreadCount(key) == 2, "строки группы под двумя доменами — в одном чате", std::to_string(n));
        // Маркер под другим доменом сводится в тот же чат
        g1.sync->advanceMark(hs::markAt(*g1.store->get(uid(81))), true);
        check(g1.sync->unreadCount(key) == 0, "маркер группы под другим доменом — тот же чат");
        const auto k1 = hs::call("historySegmentKey", json{{"state", *g1.store->get(uid(80))}}).get<std::string>();
        const auto k2 = hs::call("historySegmentKey", json{{"state", *g1.store->get(uid(81))}}).get<std::string>();
        check(k1 == k2, "один сегмент для строк группы под двумя доменами", k1 + " / " + k2);
    }

    // Фоновый поток: своё уходит само ≤ 300 мс, уведомление журнала — sync сразу
    {
        FakeServer s6;
        Device x("tx", s6, blob, key, true), y("ty", s6, blob, key, true);
        x.sync->start();
        y.sync->start();
        x.sync->record(out2, true);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        while (s6.headSeq() == 0 && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds(20));
        check(s6.headSeq() > 0, "фон: своё записано без ручного вызова");
        y.sync->onSessionEvent(json{{"type", "journal"}, {"journal", "history"}, {"seq", s6.headSeq()}});
        while (!y.store->get(uid(2)) && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds(20));
        check(y.store->get(uid(2)).has_value(), "фон: уведомление журнала → sync");
        x.sync->stop();
        y.sync->stop();
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
