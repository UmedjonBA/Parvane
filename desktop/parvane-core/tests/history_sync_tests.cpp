// Parvane fork: строки истории хоста в модели движка (spec 033, HIST-1, READ-2; spec 035 T125, spec 036 ENGINE-1) без
// стека: чистые функции ядра, разовый перенос прежних файлов строк в модель (`ModelRows` над моделью в памяти — та же,
// что у клиента устройства), `HistorySync` при журнале у модели (`engine_rows`): очередь прежнего журнала — модели,
// показ — MessageView модели в прежней форме хоста, прочтение — намерением. Журнал истории (очередь, догон, точки,
// замена) ведёт модель — его проверяют тесты движка (`cargo test -p parvane-protocol`).
#include <algorithm>
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

#include "parvane/engine_host.h"
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

// ── устройство аккаунта ──────────────────────────────────────────────────────────────────────────────────────────
static const std::string kSelf = "alice@local";
static const std::string kBob = "bob@local";

// Модель профиля в памяти (режим хоста, как у сессии): пользователь — kSelf (свои строки не входящие).
static std::shared_ptr<parvane::engine::Host> memoryModel(const std::string &device) {
    const json cfg{{"user", kSelf}, {"device_id", device}, {"domain", "local"}, {"now_ms", "1700000000000"},
                   {"device_key", v2::toBase64(std::string(32, '\x05'))}, {"host_driven", true}};
    std::string err;
    auto h = parvane::engine::Host::openMemory(cfg, &err);
    if (!h) std::printf("  FAIL  модель в памяти не открылась: %s\n", err.c_str());
    return std::shared_ptr<parvane::engine::Host>(std::move(h));
}

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

    // ── прежние файлы строк хоста → модель движка (разовый перенос, spec 035 T125) ───────────────────────────────
    {
        const auto dir = (std::filesystem::temp_directory_path() / ("pv-history-store-" + std::to_string(::getpid()))).string();
        std::filesystem::remove_all(dir);
        std::filesystem::create_directories(dir);
        const auto rows = dir + "/rows.jsonl";
        const auto marks = dir + "/marks.json";
        // Файл прежнего хранилища (бывший FileRowStore): журнал до spec 033 (StoredMessage), RowState дозаписью —
        // надгробие поверх строки (последнее состояние побеждает), строка очищенного «у себя» чата, маркер
        parvane::storecrypt::appendLine(rows, wire(uid(5), kBob, kSelf, 10, "старое").dump());
        auto st = hs::call("historyApply", json{{"op", hs::rowOpFromWire(wire(uid(6), kSelf, kBob, 11, "a"), bobChat())}});
        parvane::storecrypt::appendLine(rows, st.dump());
        st = hs::call("historyApply", json{{"state", st}, {"op", hs::goneOp(uid(6), bobChat(), hs::stampOf(12000, uid(60)), false)}});
        parvane::storecrypt::appendLine(rows, st.dump());
        const auto st8 = hs::call("historyApply", json{{"op", hs::rowOpFromWire(wire(uid(8), kBob, kSelf, 13, "b"), bobChat())}});
        parvane::storecrypt::appendLine(rows, st8.dump());
        const auto st9 = hs::call("historyApply", json{{"op", hs::rowOpFromWire(wire(uid(9), kBob, kSelf, 14, "очищено"), bobChat())}});
        parvane::storecrypt::appendLine(rows, st9.dump());
        parvane::storecrypt::writeFile(marks, json{{"u:" + kBob, hs::markAt(st8)}}.dump());
        const auto files = hs::readLegacyRowFiles(rows, marks);
        check(files.states.size() == 3 && files.storedMessages.size() == 1 && files.marks.size() == 1,
              "прежние файлы: RowState (последнее состояние строки), StoredMessage, маркеры");
        hs::ModelRows closed([] { return std::shared_ptr<parvane::engine::Host>(); }, dir + "/closed-");
        check(!closed.ready() && !hs::importLegacyRows(closed, rows, marks, nullptr, nullptr, nullptr),
              "модель не открыта — перенос позже (отметки нет)");
        const auto host = memoryModel("import");
        hs::ModelRows model([host] { return host; }, dir + "/aux-");
        int converted = 0;
        const auto convert = [&](const std::vector<json> &stored) {
            std::vector<json> ops;
            for (const auto &s : stored) {
                ++converted;
                ops.push_back(hs::rowOpFromWire(s, bobChat()));
            }
            return ops;
        };
        const auto dropped = [](const json &s) { return s.value("target", std::string()) == uid(9); };
        check(hs::importLegacyRows(model, rows, marks, convert, dropped, nullptr), "перенос в модель");
        const auto gone = model.get(uid(6));
        check(gone && gone->contains("gone"), "в модели — последнее состояние (надгробие сохранено)");
        check(model.get(uid(5)).has_value() && converted == 1, "журнал до spec 033 — строкой модели (операциями хоста)");
        check(!model.get(uid(9)).has_value(), "строка очищенного «у себя» не перенесена");
        const auto read = model.read("u:" + kBob);
        check(model.mark("u:" + kBob).has_value() && read.unread == 0 && read.lastReadId == uid(8),
              "маркер — в модели, счётчик от него (rowsRead)", std::to_string(read.unread) + " " + read.lastReadId);
        check(model.chat("u:" + kBob).size() == 3 && model.all().size() == 3, "строки чата и все строки — из модели");
        check(hs::importLegacyRows(model, rows, marks, convert, dropped, nullptr) && converted == 1,
              "повторного переноса нет (отметка imported)");
        check(model.aux("imported").value("rows", false), "отметка переноса — служебный документ");
        model.setAux("meta", json{{"cursor", 7}});
        hs::ModelRows again([host] { return host; }, dir + "/aux-");
        check(again.aux("meta").value("cursor", 0) == 7, "служебный документ пережил перезапуск");
        const auto applied = model.apply(json::array({hs::rowOpFromWire(wire(uid(10), kBob, kSelf, 15, "новое"), bobChat())}));
        check(applied.ok && applied.changed == std::vector<std::string>{uid(10)}, "rowsApply: изменённая строка — по id");
        model.forget({uid(5)});
        check(!model.get(uid(5)).has_value(), "убрать у себя (forget_json) — строки нет");
        model.apply(json::array(), json::array(), json::array(), true);
        check(model.all().empty() && model.marks().empty(), "замена: строки и маркеры модели стёрты");
        std::filesystem::remove_all(dir);
    }

    // spec 036 (ENGINE-1, `engine_rows`): журнал ведёт модель — у HistorySync нет потока и сети; показ — MessageView
    // модели (`wire_rows`) в прежней форме хоста; прочтение — намерением модели
    {
        const json cfg{{"user", kSelf}, {"device_id", "rows"}, {"domain", "local"}, {"now_ms", "1700000000000"},
                       {"device_key", v2::toBase64(std::string(32, '\x06'))}, {"host_driven", true},
                       {"engine_rows", true}, {"features", json::array({"wire_rows"})}};
        std::string err;
        std::shared_ptr<parvane::engine::Host> host(parvane::engine::Host::openMemory(cfg, &err));
        check(host != nullptr, "модель engine_rows открыта", err);
        const auto dir = (std::filesystem::temp_directory_path() / ("pv-history-er-" + std::to_string(::getpid()))).string();
        std::filesystem::remove_all(dir);
        std::filesystem::create_directories(dir);
        hs::ModelRows rows([host] { return host; }, dir + "/aux-");
        // Очередь прежнего журнала на диске (не записанное до обновления) — модели в журнал при запуске
        rows.setAux("pending", json{{"ops", json::array({hs::rowOpFromWire(wire(uid(300), kSelf, kBob, 1000, "до обновления"), bobChat())})},
                                    {"bodies", json::array({"AAAA"})}});
        std::vector<json> intents;
        hs::HistorySyncConfig hc;
        hc.self = kSelf;
        hc.rows = &rows;
        hc.readIntent = [&](const json &m) { intents.push_back(m); return true; };
        hs::HistorySync sync(std::move(hc));
        sync.start();
        check(rows.get(uid(300)).has_value(), "очередь прежнего журнала передана модели");
        const auto pend = rows.aux("pending");
        check(pend.value("ops", json::array()).empty() && pend.value("bodies", json::array()).empty(),
              "очередь прежнего журнала на диске очищена");
        auto in = wire(uid(301), kBob, kSelf, 1001, "привет");
        in["content"] = json{{"kind", "text"}, {"text", "привет"}};
        const auto st = sync.record(hs::rowOpFromWire(in, bobChat()), false);
        check(st.is_object() && st.contains("row"), "входящее вне итога модели — строкой модели");
        const auto views = rows.views({uid(301)});
        check(views.size() == 1 && !views[0].value("wire", std::string()).empty(), "показ — MessageView с wire (wire_rows)");
        const auto v = views.empty() ? json() : hs::viewOfModel(views[0]);
        check(v.value("id", std::string()) == uid(301) && v.value("from", std::string()) == kBob
                  && v.value("tsMs", std::int64_t(0)) == 1001000 && v.value("chatKey", std::string()) == "u:" + kBob
                  && v["body"]["content"].value("text", std::string()) == "привет" && v.value("unread", false)
                  && v.value("order", std::int64_t(0)) > 0,
              "MessageView → прежняя форма показа (id, автор, время, тело, непрочитано, место)", v.dump());
        sync.record(hs::reactOp(uid(301), bobChat(), kSelf, hs::stampOf(1002000, uid(302)), "👍"), true);
        const auto rv = hs::viewOfModel(rows.views({uid(301)}).at(0));
        check(rv["reactions"].size() == 1 && rv["reactions"][0].value("mine", false)
                  && rv["reactions"][0]["users"] == json::array({kSelf}),
              "реакция: число и «моя» — модель, кто — reactors тела", rv["reactions"].dump());
        // Порядок показа — место модели (ORDER-1), без своей расстановки хоста
        auto late = wire(uid(303), kBob, kSelf, 900, "старое пришло позже");
        sync.record(hs::rowOpFromWire(late, bobChat()), false);
        const auto chatViews = rows.chatViews("u:" + kBob);
        std::vector<std::int64_t> order;
        for (const auto &x : chatViews) order.push_back(hs::viewOfModel(x).value("order", std::int64_t(0)));
        check(order.size() == 3 && std::is_sorted(order.begin(), order.end()),
              "строки чата — по месту модели (ORDER-1), без своей расстановки", std::to_string(order.size()));
        const auto mark = hs::markAt(st);
        check(sync.advanceMark(mark, true).empty() && intents.size() == 1 && intents[0] == mark,
              "своё прочтение — намерением модели (квитанции шлёт она)");
        sync.advanceMark(mark, false);
        check(rows.read("u:" + kBob).lastReadId == uid(301), "чужой маркер — операцией модели");
        const auto gone = rows.apply(json::array({hs::goneOp(uid(303), bobChat(), hs::stampOf(1003000, uid(304)), true)}));
        check(gone.ok && rows.views({uid(303)}).empty(), "надгробие — без показа");
        const auto rm = hs::removedOfModel(json{{"chat", bobChat()}, {"id", hs::b64OfUuid(uid(303))}});
        check(rm.value("id", std::string()) == uid(303) && rm.value("chatKey", std::string()) == "u:" + kBob,
              "message_remove → id и чат");
        const auto un = hs::unreadOfModel(json{{"chat", bobChat()}, {"count", 2}, {"last_read_id", hs::b64OfUuid(uid(301))}});
        check(un.value("unread", 0) == 2 && un.value("lastReadId", std::string()) == uid(301), "unread_changed → счётчик");
        check(hs::uuidOfB64(hs::b64OfUuid(uid(7))) == uid(7) && hs::b64OfUuid("nope").empty(), "UUID ↔ base64");
        // spec 036 T030/T035: список чатов и страницы истории — готовыми из модели (desktop: список диалогов tdesktop,
        // android: TdApi.Chat и GetChatHistory страницами)
        for (int i = 0; i < 5; ++i) {
            sync.record(hs::rowOpFromWire(wire(uid(400 + i), kBob, kSelf, 1010 + i, "строка " + std::to_string(i)), bobChat()), false);
        }
        const auto chats = rows.chatList();
        const auto bob = std::find_if(chats.begin(), chats.end(), [](const json &c) { return c.value("chatKey", std::string()) == "u:" + kBob; });
        check(bob != chats.end() && bob->value("order", std::int64_t(0)) > 0 && (*bob)["last"].is_object()
                  && (*bob)["last"].value("id", std::string()) == uid(404) && bob->value("unread", 0) > 0,
              "chatList → чат с местом, последней строкой и непрочитанным", bob != chats.end() ? bob->dump() : "нет чата");
        const auto newest = rows.page(bobChat(), "", "older", 3);
        std::vector<std::string> ids;
        for (const auto &r : newest.rows) ids.push_back(r.value("id", std::string()));
        check(newest.ok && ids == std::vector<std::string>{uid(402), uid(403), uid(404)} && newest.hasOlder && !newest.hasNewer,
              "страница с конца: три последние строки, старше — есть");
        const auto older = rows.page(bobChat(), uid(402), "older", 2);
        check(older.ok && older.rows.size() == 2 && older.rows.back().value("id", std::string()) == uid(401),
              "страница старше якоря (строго)", older.rows.empty() ? "" : older.rows.back().dump());
        const auto newer = rows.page(bobChat(), uid(402), "newer", 10);
        check(newer.ok && newer.rows.size() == 2 && newer.rows.front().value("id", std::string()) == uid(403) && !newer.hasNewer,
              "страница новее якоря (строго)");
        const auto rc = hs::removedChatOfModel(bobChat());
        check(rc.value("chatKey", std::string()) == "u:" + kBob && hs::chatViewOfModel(json::object()).is_null(),
              "chat_remove → ключ чата; не ChatView → null");
        sync.stop();
        std::filesystem::remove_all(dir);
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
