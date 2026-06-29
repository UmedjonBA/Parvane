// Parvane fork: подробные тесты messenger-слоя parvane-core (MessengerClient +
// messenger.h-пейлоады) против ЖИВОГО бэкенда (NATS + identity + messenger,
// поднимает scripts/run_all_tests.sh).
//
// Покрытие:
//   A. Чистые (без бэкенда): contentText/contentKind, StoredMessage::fromJson,
//      устойчивость SyncResponse/Delivered::fromJson к полному конверту и голому
//      payload.
//   B. Живой путь: sendText→sync (поля from/to/kind/text), инкрементальный
//      курсор по id, reply_to round-trip, edit→sync (edited+новый текст),
//      read→sync (read=true, двойной курсор), onDelivered триггерит на отправку.
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

#include "parvane/events.h"
#include "parvane/messenger.h"
#include "parvane/messenger_client.h"
#include "parvane/topics.h"
#include "parvane/transport.h"

using parvane::json;
using parvane::MessengerClient;
using parvane::StoredMessage;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}

static std::string env(const char *n, const std::string &d) {
    const char *v = std::getenv(n);
    return (v && *v) ? std::string(v) : d;
}

static void sleepMs(int ms) {
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

// Найти сообщение по id в векторе sync.
static const StoredMessage *find(const std::vector<StoredMessage> &v,
                                 const std::string &id) {
    for (const auto &m : v)
        if (m.id == id) return &m;
    return nullptr;
}

static std::string issue(parvane::Transport &tr, const std::string &user) {
    parvane::IssueRequest req{user, "test"};
    auto resp = parvane::IssueResponse::fromJson(
        json::parse(tr.request(parvane::topics::IdentityIssue, req.toJson().dump())));
    return resp.token.value_or("");
}

int main() {
    const std::string url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    std::printf("=== parvane-core messenger tests (NATS %s) ===\n", url.c_str());

    // ── A. Чистые тесты (без бэкенда) ─────────────────────────────────────────
    {
        check(parvane::contentText(parvane::textContent("привет")).value_or("") == "привет",
              "contentText(text) → строка");
        json media = {{"kind", "photo"}, {"file_id", "x"}};
        check(!parvane::contentText(media).has_value(),
              "contentText(media) → nullopt");
        check(parvane::contentKind(parvane::textContent("h")) == "text",
              "contentKind(text) == text");
        check(parvane::contentKind(media) == "photo",
              "contentKind(photo) == photo");
    }
    {
        json j = {{"id", "m1"}, {"from", "a@l"}, {"to", "b@l"},
                  {"content", {{"kind", "text"}, {"text", "hi"}}},
                  {"ts", 123}, {"reply_to", "m0"},
                  {"edited", true}, {"deleted", false}, {"read", true},
                  {"updated_at", 999}};
        auto m = StoredMessage::fromJson(j);
        check(m.id == "m1" && m.from == "a@l" && m.to == "b@l" && m.ts == 123
                  && m.reply_to.value_or("") == "m0" && m.edited && !m.deleted
                  && m.read && m.updated_at == 999 && m.text().value_or("") == "hi",
              "StoredMessage::fromJson разбирает все поля");
    }
    {
        // SyncResponse: полный конверт И голый payload.
        json full = {{"id", "e"}, {"from", "messenger"}, {"ts", 1},
                     {"payload", {{"messages", json::array({json{{"id", "x"}}})}}}};
        json bare = {{"messages", json::array({json{{"id", "y"}}})}};
        auto r1 = parvane::SyncResponsePayload::fromJson(full);
        auto r2 = parvane::SyncResponsePayload::fromJson(bare);
        check(r1.messages.size() == 1 && r1.messages[0].id == "x",
              "SyncResponse::fromJson(конверт)");
        check(r2.messages.size() == 1 && r2.messages[0].id == "y",
              "SyncResponse::fromJson(голый payload)");
    }
    {
        json full = {{"from", "messenger"}, {"payload", {{"message_id", "abc"}}}};
        json bare = {{"message_id", "def"}};
        check(parvane::DeliveredPayload::fromJson(full).message_id == "abc",
              "Delivered::fromJson(конверт)");
        check(parvane::DeliveredPayload::fromJson(bare).message_id == "def",
              "Delivered::fromJson(голый payload)");
    }

    // ── B. Живой бэкенд ───────────────────────────────────────────────────────
    parvane::Transport tr;
    try {
        tr.connect(url);
    } catch (const std::exception &e) {
        check(false, "connect к live NATS", e.what());
        std::printf("РЕЗУЛЬТАТ: НЕТ соединения, живые тесты пропущены\n");
        std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
        return 1;
    }

    const std::string alice = "alice@local";
    const std::string bob = "bob@local";
    const std::string jwtAlice = issue(tr, alice);
    const std::string jwtBob = issue(tr, bob);
    check(!jwtAlice.empty() && !jwtBob.empty(), "issue alice+bob токены");

    MessengerClient mc(tr);

    // B1. onDelivered триггерит на отправку (подписка ДО send).
    std::string deliveredId;
    mc.onDelivered([&](std::string id) { deliveredId = id; });
    sleepMs(120); // дать подписке встать

    // B2. sendText alice→bob, sync(bob) от нуля видит сообщение со всеми полями.
    const std::string text1 = "msg-client тест";
    const std::string id1 = mc.sendText(alice, bob, text1, jwtAlice);
    sleepMs(400);
    {
        auto msgs = mc.sync(bob, jwtBob, MessengerClient::zeroCursor());
        auto *m = find(msgs, id1);
        check(m != nullptr, "sendText→sync: сообщение найдено",
              "total=" + std::to_string(msgs.size()) + " id=" + id1.substr(0, 8));
        if (m) {
            check(m->from == alice && m->to == bob
                      && m->text().value_or("") == text1
                      && parvane::contentKind(m->content) == "text",
                  "поля from/to/text/kind верны",
                  m->from + "→" + m->to + " '" + m->text().value_or("?") + "'");
            check(!m->edited && !m->deleted, "новое сообщение: edited=0 deleted=0");
        }
    }

    // B3. onDelivered получил id отправленного (ack от messenger).
    check(deliveredId == id1, "onDelivered сработал на отправленный id",
          "got=" + deliveredId.substr(0, 8) + " want=" + id1.substr(0, 8));

    // B4. Двойной курсор. ВАЖНО про контракт: шард фильтрует
    //     `id > last_seen_id OR updated_at > since_updated`. При since_updated=0
    //     второе условие истинно для ВСЕХ (updated_at>0) → возвращается всё
    //     (полный ресинк; клиент дедупит по id). Инкрементальность требует
    //     продвинуть ОБА курсора.
    const std::string id2 = mc.sendText(alice, bob, "второе", jwtAlice);
    sleepMs(400);
    {
        // (a) с курсором по id, но since_updated=0 — старое ВСЁ РАВНО приходит
        //     (документируем семантику двойного курсора).
        auto all = mc.sync(bob, jwtBob, id1, /*sinceUpdated=*/0);
        check(find(all, id2) != nullptr, "sync(id1, since=0): новое (id2) присутствует");
        check(find(all, id1) != nullptr,
              "sync(id1, since=0): старое тоже приходит (updated_at>0 ловит всё)");

        // (b) снимок: максимальные курсоры по текущей переписке.
        std::string maxId;
        std::int64_t maxUpd = 0;
        for (const auto &m : all) {
            if (m.id > maxId) maxId = m.id;
            if (m.updated_at > maxUpd) maxUpd = m.updated_at;
        }
        // переходим границу секунды, чтобы у нового updated_at был строго больше.
        sleepMs(1100);
        const std::string id4 = mc.sendText(alice, bob, "после курсора", jwtAlice);
        sleepMs(400);
        // оба курсора продвинуты → только новое.
        auto inc = mc.sync(bob, jwtBob, maxId, /*sinceUpdated=*/maxUpd);
        check(find(inc, id4) != nullptr, "двойной курсор: новое (id4) присутствует",
              "inc=" + std::to_string(inc.size()));
        check(find(inc, id1) == nullptr && find(inc, id2) == nullptr,
              "двойной курсор: старые (id1,id2) НЕ возвращаются");
    }

    // B5. reply_to round-trip: ответ на id1.
    const std::string id3 = mc.sendText(alice, bob, "это ответ", jwtAlice, id1);
    sleepMs(400);
    {
        auto msgs = mc.sync(bob, jwtBob, MessengerClient::zeroCursor());
        auto *m = find(msgs, id3);
        check(m && m->reply_to.value_or("") == id1, "reply_to round-trip",
              m ? ("reply_to=" + m->reply_to.value_or("<none>").substr(0, 8)) : "не найдено");
    }

    // B6. edit→sync: правка автором меняет text и ставит edited=true.
    {
        const std::string edited = "ИСПРАВЛЕНО " + id1.substr(0, 4);
        mc.editText(alice, id1, edited, jwtAlice);
        sleepMs(400);
        auto msgs = mc.sync(bob, jwtBob, MessengerClient::zeroCursor());
        auto *m = find(msgs, id1);
        check(m && m->edited && m->text().value_or("") == edited,
              "edit→sync: edited=1 и новый текст",
              m ? (std::string(m->edited ? "edited " : "NOT-edited ") + "'"
                   + m->text().value_or("?") + "'") : "не найдено");
    }

    // B7. read→sync: получатель отмечает прочитанным → read=true (двойной курсор).
    {
        mc.markRead(bob, id2, jwtBob);
        sleepMs(400);
        // since_updated=0 + zero cursor → отдаёт всё, включая мутированное.
        auto msgs = mc.sync(alice, jwtAlice, MessengerClient::zeroCursor());
        auto *m = find(msgs, id2);
        check(m && m->read, "read→sync: read=1 после markRead получателем",
              m ? (m->read ? "read" : "NOT-read") : "не найдено");
    }

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
