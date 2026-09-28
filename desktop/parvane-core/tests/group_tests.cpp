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

// Пароль тестовых аккаунтов по политике сервера (P-43: не короче 8 символов).
constexpr auto kTestPassword = "e2e-Test-pass-2026";

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
    IssueRequest req{ user, kTestPassword };
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
    // spec 003: участник с правом invite_users (по умолчанию включено) добавлять МОЖЕТ —
    // отказ проверяется ниже, после снятия права владельцем (блок spec 004)

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

    // ── spec 004: управление группой живьём (сервер spec 003) ────────────────
    {
        auto vi = groups.setInfo(tA, gid, std::string("описание core"), std::nullopt, false);
        check(vi.ok && vi.version > 0, "setInfo владельцем → ok, version растёт", std::to_string(vi.version));
        const auto prev = vi.version;
        check(groups.setInfo(tB, gid, std::string("взлом"), std::nullopt, false).error_code == "forbidden",
              "setInfo участником → forbidden");
        check(groups.info(tA, gid).about == "описание core", "group.info несёт about");
        DefaultPermissions p;
        p.send_polls = false;
        auto vp = groups.setPerms(tA, gid, p);
        check(vp.ok && vp.version == prev + 1, "setPerms владельцем → version+1");
        check(groups.setPerms(tB, gid, p).error_code == "forbidden", "setPerms участником → forbidden");
        check(!groups.info(tB, gid).default_permissions.send_polls, "участник видит новые права");
        p.invite_users = false;
        check(groups.setPerms(tA, gid, p).ok, "владелец снял invite_users");
        check(groups.addMember(tB, gid, "dave@local").error_code == "forbidden", "участник без invite_users НЕ добавляет → forbidden");
        p.invite_users = true;
        check(groups.setPerms(tA, gid, p).ok, "владелец вернул invite_users");
        check(groups.addMember(tB, gid, "dave@local").ok, "участник с invite_users добавляет");
        auto ar = AdminRights::none();
        ar.pin_messages = true;
        check(groups.setAdmin(tA, gid, bob, ar).ok, "setAdmin владельцем (только pin) → ok");
        {
            const auto gi = groups.info(tA, gid);
            bool bobAdmin = false;
            for (const auto &m : gi.members)
                if (m.address == bob) bobAdmin = (m.role == "admin" && m.admin_rights && m.admin_rights->pin_messages && !m.admin_rights->ban_users);
            check(bobAdmin, "info: bob admin с pin_messages, без ban_users");
        }
        check(groups.setAdmin(tB, gid, carol, ar).error_code == "forbidden", "bob без add_admins не назначает → forbidden");
        check(groups.setAdmin(tA, gid, bob, std::nullopt).ok, "setAdmin(nullopt) снимает админа");
        InviteParams ip;
        ip.max_uses = 1;
        auto ic = groups.inviteCreate(tA, gid, ip);
        check(ic.ok && ic.link && ic.link->state == "active" && ic.link->max_uses == 1, "inviteCreate max_uses=1 → active");
        auto il = groups.inviteList(tA, gid, false);
        bool found = false;
        for (const auto &l : il.links) found = found || l.token == ic.invite;
        check(il.ok && found, "inviteList содержит созданную ссылку");
        check(groups.inviteList(tB, gid, false).error_code == "forbidden", "inviteList участником → forbidden");
        auto ck = groups.inviteCheck(tC, ic.invite);
        check(ck.ok && !ck.name.empty() && ck.members_count >= 2 && !ck.request_needed, "inviteCheck: превью без состава");
        const std::string erin = "erin@local", frank = "frank@local";
        const std::string tE = issue(tr, erin), tF = issue(tr, frank);
        check(groups.joinByInvite(tE, ic.invite).ok, "erin вступила по лимитной ссылке");
        check(groups.joinByInvite(tF, ic.invite).error_code == "exhausted", "frank → exhausted");
        check(groups.inviteRevoke(tA, gid, ic.invite).ok, "inviteRevoke → ok");
        auto rl = groups.inviteList(tA, gid, true);
        bool revoked = false;
        for (const auto &l : rl.links) revoked = revoked || (l.token == ic.invite && l.state == "revoked");
        check(revoked, "отозванная в списке revoked");
        check(groups.joinByInvite(tF, ic.invite).error_code == "revoked", "по отозванной → revoked");
        check(groups.inviteDelete(tA, gid, ic.invite).ok, "inviteDelete отозванной → ok");
        InviteParams rp;
        rp.request_needed = true;
        auto rc = groups.inviteCreate(tA, gid, rp);
        check(rc.ok, "ссылка по одобрению создана");
        check(groups.joinByInvite(tF, rc.invite).pending, "frank → pending (заявка)");
        auto rq = groups.requestList(tA, gid);
        bool hasFrank = false;
        for (const auto &r : rq.requests) hasFrank = hasFrank || r.member == frank;
        check(rq.ok && hasFrank, "requestList владельцем содержит frank");
        check(groups.requestList(tB, gid).error_code == "forbidden", "requestList участником → forbidden");
        check(groups.requestDecide(tA, gid, frank, true).ok, "requestDecide approve → ok");
        {
            bool member = false;
            for (const auto &m : groups.info(tA, gid).members) member = member || (m.address == frank && m.role == "member");
            check(member, "frank стал участником");
        }
    }

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
