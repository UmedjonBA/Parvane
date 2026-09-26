// Parvane fork: тесты GroupClient БЕЗ стека (spec 004) — форма запросов к
// операциям управления группой, разбор ответов и правило GROUP-2
// (isContentAllowedForMember). Транспорт — FakeTransport.
#include <cstdio>
#include <string>

#include "fake_transport.h"
#include "parvane/group_client.h"
#include "parvane/topics.h"

using namespace parvane;
using nlohmann::json;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}

static bool hasKeys(const json &j, std::initializer_list<const char *> keys) {
    if (!j.is_object()) return false;
    for (const auto *k : keys) if (!j.contains(k)) return false;
    return true;
}

int main() {
    std::printf("=== parvane-core group client tests (без стека) ===\n");
    test::FakeTransport tr;
    GroupClient gc(tr);
    const std::string tok = "jwt", gid = "01a0-gid";

    // ── setInfo ──
    tr.nextReply = R"({"ok":true,"version":5})";
    auto v = gc.setInfo(tok, gid, std::string("описание"), std::nullopt, false);
    check(tr.lastSubject == topics::GroupSetInfo, "setInfo → group.setinfo");
    check(hasKeys(tr.lastPayload, {"token", "group_id", "about", "clear_avatar"}) && !tr.lastPayload.contains("avatar_file_id")
          && tr.lastPayload["about"] == "описание" && tr.lastPayload["clear_avatar"] == false,
          "setInfo: about есть, avatar_file_id отсутствует, clear_avatar=false");
    check(v.ok && v.version == 5, "setInfo: ok/version разобраны");
    gc.setInfo(tok, gid, std::nullopt, std::string("f-1"), false);
    check(!tr.lastPayload.contains("about") && tr.lastPayload["avatar_file_id"] == "f-1",
          "setInfo: без about, с avatar_file_id");
    gc.setInfo(tok, gid, std::nullopt, std::nullopt, true);
    check(tr.lastPayload["clear_avatar"] == true && !tr.lastPayload.contains("avatar_file_id"),
          "setInfo: clear_avatar");
    tr.nextReply = R"({"ok":false,"error":"нет прав","error_code":"forbidden"})";
    v = gc.setInfo(tok, gid, std::string("x"), std::nullopt, false);
    check(!v.ok && v.error_code == "forbidden" && v.error == "нет прав", "setInfo: отказ с error_code");

    // ── setPerms ──
    tr.nextReply = R"({"ok":true,"version":6})";
    DefaultPermissions perms;
    perms.send_media = false;
    perms.send_polls = false;
    v = gc.setPerms(tok, gid, perms);
    check(tr.lastSubject == topics::GroupSetPerms, "setPerms → group.setperms");
    const auto &dp = tr.lastPayload["default_permissions"];
    check(hasKeys(dp, {"send_messages", "send_media", "send_stickers_gifs", "send_polls",
                       "embed_links", "invite_users", "pin_messages", "change_info"})
          && dp["send_media"] == false && dp["send_polls"] == false && dp["send_messages"] == true,
          "setPerms: все 8 ключей, значения переданы");
    check(v.ok && v.version == 6, "setPerms: version");

    // ── setAdmin ──
    tr.nextReply = R"({"ok":true,"version":7})";
    auto rights = AdminRights::none();
    rights.pin_messages = true;
    v = gc.setAdmin(tok, gid, "bob@local", rights);
    check(tr.lastSubject == topics::GroupSetAdmin, "setAdmin → group.setadmin");
    check(tr.lastPayload["member"] == "bob@local" && tr.lastPayload["rights"].is_object()
          && tr.lastPayload["rights"]["pin_messages"] == true && tr.lastPayload["rights"]["ban_users"] == false
          && tr.lastPayload["rights"]["add_admins"] == false,
          "setAdmin: гранулярные права (только pin)");
    gc.setAdmin(tok, gid, "bob@local", std::nullopt);
    check(tr.lastPayload.contains("rights") && tr.lastPayload["rights"].is_null(),
          "setAdmin: nullopt → rights: null (снять админа)");
    check(!AdminRights::none().change_info && AdminRights{}.add_admins, "AdminRights: none() пуст, дефолт полный");

    // ── inviteCreate с параметрами ──
    tr.nextReply = R"({"ok":true,"invite":"aa11","link":{"token":"aa11","created_by":"alice@local","created_at":100,
        "title":"Weekend","expires_at":200,"max_uses":5,"uses":0,"request_needed":true,"revoked":false,
        "revoked_at":0,"state":"active","is_primary":false,"pending_requests":0}})";
    InviteParams ip;
    ip.title = "Weekend";
    ip.expires_at = 200;
    ip.max_uses = 5;
    ip.request_needed = true;
    auto ic = gc.inviteCreate(tok, gid, ip);
    check(tr.lastSubject == topics::GroupInviteCreate, "inviteCreate → group.invite.create");
    check(hasKeys(tr.lastPayload, {"token", "group_id", "title", "expires_at", "max_uses", "request_needed"})
          && tr.lastPayload["title"] == "Weekend" && tr.lastPayload["expires_at"] == 200
          && tr.lastPayload["max_uses"] == 5 && tr.lastPayload["request_needed"] == true,
          "inviteCreate: все 4 параметра всегда в запросе");
    check(ic.ok && ic.invite == "aa11" && ic.link && ic.link->title == "Weekend" && ic.link->max_uses == 5
          && ic.link->request_needed && ic.link->state == "active" && !ic.link->is_primary,
          "inviteCreate: link разобрана");
    gc.inviteCreate(tok, gid, InviteParams{});
    check(tr.lastPayload["title"] == "" && tr.lastPayload["expires_at"] == 0 && tr.lastPayload["max_uses"] == 0
          && tr.lastPayload["request_needed"] == false, "inviteCreate: «не задано» = \"\"/0/false");
    tr.nextReply = R"({"ok":true,"invite":"bb22"})";
    check(gc.inviteCreate(tok, gid) == "bb22", "inviteCreate (старая сигнатура) → токен");
    tr.nextReply = R"({"ok":false,"error_code":"limit"})";
    check(gc.inviteCreate(tok, gid, InviteParams{}).error_code == "limit", "inviteCreate: limit");

    // ── inviteList ──
    tr.nextReply = R"({"ok":true,"links":[
        {"token":"p1","created_by":"alice@local","created_at":1,"state":"active","is_primary":true},
        {"token":"e1","created_by":"alice@local","created_at":2,"expires_at":3,"state":"expired"},
        {"token":"x1","created_by":"carol@local","created_at":3,"max_uses":1,"uses":1,"state":"exhausted","pending_requests":2}]})";
    auto il = gc.inviteList(tok, gid, false);
    check(tr.lastSubject == topics::GroupInviteList && tr.lastPayload["revoked"] == false, "inviteList → group.invite.list revoked=false");
    check(il.ok && il.links.size() == 3 && il.links[0].is_primary && il.links[1].state == "expired"
          && il.links[2].state == "exhausted" && il.links[2].pending_requests == 2 && il.links[2].created_by == "carol@local",
          "inviteList: состояния и поля");
    tr.nextReply = R"({"ok":true,"links":[{"token":"r1","revoked":true,"revoked_at":9}]})";
    il = gc.inviteList(tok, gid, true);
    check(tr.lastPayload["revoked"] == true && il.links.size() == 1 && il.links[0].revoked && il.links[0].state == "revoked",
          "inviteList: revoked=true; state по умолчанию из revoked");

    // ── inviteRevoke / inviteDelete ──
    tr.nextReply = R"({"ok":true})";
    check(gc.inviteRevoke(tok, gid, "p1").ok && tr.lastSubject == topics::GroupInviteRevoke && tr.lastPayload["invite"] == "p1",
          "inviteRevoke → group.invite.revoke {invite}");
    tr.nextReply = R"({"ok":false,"error_code":"bad_request"})";
    check(gc.inviteDelete(tok, gid, "p1").error_code == "bad_request" && tr.lastSubject == topics::GroupInviteDelete,
          "inviteDelete → group.invite.delete; активную нельзя");

    // ── inviteCheck ──
    tr.nextReply = R"({"ok":true,"group_id":"g","name":"Team","kind":"group","avatar":"f-1","about":"о нас",
        "members_count":4,"request_needed":true,"already_member":false,"pending":false})";
    auto chk = gc.inviteCheck(tok, "aa11");
    check(tr.lastSubject == topics::GroupInviteCheck && hasKeys(tr.lastPayload, {"token", "invite"}) && !tr.lastPayload.contains("group_id"),
          "inviteCheck → group.invite.check {token, invite}");
    check(chk.ok && chk.name == "Team" && chk.members_count == 4 && chk.request_needed && chk.avatar == "f-1" && chk.about == "о нас",
          "inviteCheck: превью разобрано");
    tr.nextReply = R"({"ok":false,"error_code":"expired"})";
    check(gc.inviteCheck(tok, "e1").error_code == "expired", "inviteCheck: expired");

    // ── joinByInvite ──
    tr.nextReply = R"({"ok":true,"group_id":"g","name":"Team"})";
    auto jn = gc.joinByInvite(tok, "aa11");
    check(tr.lastSubject == topics::GroupJoin && jn.ok && jn.group_id == "g" && !jn.pending, "joinByInvite: ok");
    tr.nextReply = R"({"ok":true,"group_id":"g","name":"Team","pending":true})";
    check(gc.joinByInvite(tok, "aa11").pending, "joinByInvite: pending (заявка)");
    for (const char *code : {"invalid", "revoked", "expired", "exhausted", "banned", "declined"}) {
        tr.nextReply = std::string(R"({"ok":false,"error":"ссылка","error_code":")") + code + "\"}";
        const auto r = gc.joinByInvite(tok, "zz");
        check(!r.ok && r.error_code == code, std::string("joinByInvite: отказ ") + code);
    }

    // ── requestList / requestDecide ──
    tr.nextReply = R"({"ok":true,"requests":[{"member":"carol@local","invite":"aa11","created_at":7},{"member":"dave@local","invite":"aa11","created_at":8}]})";
    auto rl = gc.requestList(tok, gid);
    check(tr.lastSubject == topics::GroupRequestList && rl.ok && rl.requests.size() == 2 && rl.requests[1].member == "dave@local"
          && rl.requests[0].created_at == 7, "requestList: заявки разобраны");
    tr.nextReply = R"({"ok":true,"version":9})";
    auto rd = gc.requestDecide(tok, gid, "carol@local", true);
    check(tr.lastSubject == topics::GroupRequestDecide && tr.lastPayload["approve"] == true && tr.lastPayload["member"] == "carol@local"
          && rd.ok && rd.version == 9, "requestDecide: approve");
    gc.requestDecide(tok, gid, "dave@local", false);
    check(tr.lastPayload["approve"] == false, "requestDecide: decline");

    // ── мусорный ответ не бросает ──
    tr.nextReply = "not json";
    check(!gc.setInfo(tok, gid, std::string("x"), std::nullopt, false).ok, "мусорный ответ → ok=false без исключения");

    // ── GROUP-2: isContentAllowedForMember ──
    DefaultPermissions all;
    check(isContentAllowedForMember(all, "photo", false) && isContentAllowedForMember(all, "poll", false)
          && isContentAllowedForMember(all, "text", true), "GROUP-2: полные права — всё разрешено");
    DefaultPermissions noMedia; noMedia.send_media = false;
    for (const char *k : {"photo", "video", "file", "voice", "video_note", "audio"}) {
        check(!isContentAllowedForMember(noMedia, k, false), std::string("GROUP-2: send_media=false скрывает ") + k);
    }
    check(isContentAllowedForMember(noMedia, "sticker", false) && isContentAllowedForMember(noMedia, "text", false),
          "GROUP-2: send_media=false не трогает стикер и текст");
    DefaultPermissions noSt; noSt.send_stickers_gifs = false;
    check(!isContentAllowedForMember(noSt, "sticker", false) && !isContentAllowedForMember(noSt, "gif", false)
          && isContentAllowedForMember(noSt, "photo", false), "GROUP-2: send_stickers_gifs=false → sticker/gif");
    DefaultPermissions noPoll; noPoll.send_polls = false;
    check(!isContentAllowedForMember(noPoll, "poll", false) && isContentAllowedForMember(noPoll, "text", false),
          "GROUP-2: send_polls=false → poll");
    DefaultPermissions noLinks; noLinks.embed_links = false;
    check(!isContentAllowedForMember(noLinks, "text", true) && isContentAllowedForMember(noLinks, "text", false),
          "GROUP-2: embed_links=false → только текст со ссылкой");
    DefaultPermissions noMsg; noMsg.send_messages = false;
    check(!isContentAllowedForMember(noMsg, "text", false) && !isContentAllowedForMember(noMsg, "photo", false),
          "GROUP-2: send_messages=false → всё скрыто");
    check(isContentAllowedForMember(noMedia, "location", false), "GROUP-2: location не фильтруется");
    check(contentHasLink(json{{"kind", "text"}, {"text", "x"}, {"webpage", {{"url", "https://x"}}}}), "contentHasLink: webpage");
    check(contentHasLink(json{{"kind", "text"}, {"entities", json::array({{{"type", "MessageEntityUrl"}, {"offset", 0}, {"length", 3}}})}}),
          "contentHasLink: MessageEntityUrl");
    check(!contentHasLink(json{{"kind", "text"}, {"text", "x"}, {"entities", json::array({{{"type", "MessageEntityBold"}}})}}),
          "contentHasLink: без ссылки");
    check(!isContentAllowedForMember(noLinks, json{{"kind", "text"}, {"webpage", {{"url", "u"}}}})
          && isContentAllowedForMember(noLinks, json{{"kind", "text"}, {"text", "plain"}}),
          "GROUP-2: перегрузка по json-контенту");

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
