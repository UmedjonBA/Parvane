// Parvane fork: e2e-тест групп/каналов против ЖИВОГО бэкенда (NATS + identity +
// messenger). Проверяет создание, членство, фан-аут сообщений в группу и права
// постинга в канал.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

#include "parvane/events.h"
#include "parvane/group_client.h"
#include "parvane/messenger_client.h"
#include "parvane/topics.h"
#include "parvane/transport.h"

using namespace parvane;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}
static void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
static std::string env(const char *n, const std::string &d) {
    const char *v = std::getenv(n);
    return (v && *v) ? std::string(v) : d;
}
static std::string issue(Transport &tr, const std::string &user) {
    IssueRequest req{ user, "test" };
    tr.request(topics::IdentityRegister, req.toJson().dump()); // регистрируем (идемпотентно)
    auto resp = IssueResponse::fromJson(
        json::parse(tr.request(topics::IdentityIssue, req.toJson().dump())));
    return resp.token.value_or("");
}
static bool hasMsg(const std::vector<StoredMessage> &v, const std::string &id) {
    for (const auto &m : v) if (m.id == id) return true;
    return false;
}

int main() {
    const std::string url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    std::printf("=== parvane-core group tests (NATS %s) ===\n", url.c_str());

    Transport tr;
    try {
        tr.connect(url);
    } catch (const std::exception &e) {
        check(false, "connect к live NATS", e.what());
        std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
        return 1;
    }

    const std::string alice = "alice@local", bob = "bob@local", carol = "carol@local";
    const std::string tA = issue(tr, alice), tB = issue(tr, bob), tC = issue(tr, carol);
    check(!tA.empty() && !tB.empty() && !tC.empty(), "issue токенов");

    GroupClient groups(tr);
    MessengerClient mc(tr);

    // Создать группу с участником bob.
    auto created = groups.create(tA, "Тест-группа", "group", { bob });
    check(created.ok && !created.group_id.empty(), "create → ok + group_id",
          "id=" + created.group_id.substr(0, 8));
    const std::string gid = created.group_id;

    // list у alice и bob содержит группу; у carol — нет.
    auto la = groups.list(tA);
    bool aliceHas = false;
    for (const auto &g : la) if (g.group_id == gid) aliceHas = true;
    check(aliceHas, "alice видит группу в своём списке");
    auto lb = groups.list(tB);
    bool bobHas = false;
    for (const auto &g : lb) if (g.group_id == gid) bobHas = true;
    check(bobHas, "bob (участник) видит группу");
    auto lc = groups.list(tC);
    bool carolHas = false;
    for (const auto &g : lc) if (g.group_id == gid) carolHas = true;
    check(!carolHas, "carol (не участник) НЕ видит группу");

    // Участники + роли.
    auto info = groups.info(tA, gid);
    check(info.members.size() == 2, "у группы 2 участника (owner + bob)",
          "n=" + std::to_string(info.members.size()));
    bool ownerOk = false;
    for (const auto &m : info.members)
        if (m.address == alice && m.role == "owner") ownerOk = true;
    check(ownerOk, "alice — owner");

    // Сообщение в группу: bob (участник) получает, carol — нет.
    const std::string mid = mc.sendText(alice, gid, "привет группе", tA);
    sleepMs(400);
    check(hasMsg(mc.sync(bob, tB, MessengerClient::zeroCursor()), mid),
          "групповое сообщение дошло участнику bob");
    check(!hasMsg(mc.sync(carol, tC, MessengerClient::zeroCursor()), mid),
          "постороннему carol групповое сообщение НЕ дошло");

    // Добавить carol → теперь видит группу и следующие сообщения.
    check(groups.addMember(tA, gid, carol).ok, "owner добавил carol");
    const std::string mid2 = mc.sendText(bob, gid, "второе", tB);
    sleepMs(400);
    check(hasMsg(mc.sync(carol, tC, MessengerClient::zeroCursor()), mid2),
          "после добавления carol видит новое сообщение");
    // обычный участник не может добавлять.
    check(!groups.addMember(tB, gid, "eve@evil").ok, "обычный участник НЕ добавляет");

    // Канал: подписчик не может писать, owner может.
    auto ch = groups.create(tA, "Тест-канал", "channel", { bob });
    check(ch.ok, "create channel → ok");
    const std::string cid = ch.group_id;
    const std::string ownerMsg = mc.sendText(alice, cid, "пост владельца", tA);
    const std::string subMsg = mc.sendText(bob, cid, "спам подписчика", tB);
    sleepMs(400);
    auto chSync = mc.sync(bob, tB, MessengerClient::zeroCursor());
    check(hasMsg(chSync, ownerMsg), "пост owner канала доставлен");
    check(!hasMsg(chSync, subMsg), "пост подписчика в канал ОТКЛОНЁН");

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
