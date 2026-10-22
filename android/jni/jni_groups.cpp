// Parvane Android (spec 031): группы v2 (GROUP-1/2/3) — журнал группы, права, админы, ссылки-приглашения
// (правка, вступившие, отозванные, общие у админов), заявки, публичные группы и каналы (PUBLIC-1), жалобы
// (REPORT-1). Ответы — JSON вида {ok, error_code, …}: текст по коду подставляет Kotlin (EN+RU).
#include "jni_internal.h"

#include <parvane/messenger.h>

#include <algorithm>
#include <fstream>
#include <functional>

namespace pvjni {

namespace {

// Изменение группы записью журнала → {ok, error_code}.
json change(const std::string &gid, const std::function<json(const json &info)> &build) {
    const auto s = v2ReadyForSend();
    if (!s) return jfail("failed", "сессия v2 не готова");
    try {
        const auto c = build(s->groupInfo(gid));
        if (c.is_null()) return jfail("bad_request", "изменение не собрано");
        std::string code = "failed";
        const bool ok = s->changeGroup(gid, c, &code);
        LOGI("группа %s: %s → %s", gid.c_str(), c.begin().key().c_str(), ok ? "ok" : code.c_str());
        return ok ? json{{"ok", true}} : jfail(code);
    } catch (const std::exception &e) {
        LOGE("группа %s: %s", gid.c_str(), e.what());
        return jfail(errorCodeOf(e), e.what());
    }
}

json memberRef(const std::string &member) { return json{{"member", {{"address", member}}}}; }

json adminRights(const json &r) {
    const auto flag = [&](const char *k) { return r.is_object() && r.value(k, false); };
    return json{{"change_info", flag("change_info")}, {"delete_messages", flag("delete_messages")},
                {"ban_users", flag("ban_users")}, {"invite_users", flag("invite_users")},
                {"pin_messages", flag("pin_messages")}, {"add_admins", flag("add_admins")}};
}

json permissions(const json &p) {
    json out = json::object();
    for (const char *k : {"send_messages", "send_media", "send_stickers_gifs", "send_polls", "embed_links", "invite_users",
                          "pin_messages", "change_info"})
        out[k] = p.is_object() && p.value(k, false);
    return out;
}

// Запись ссылки v2 (хранится на устройстве, секрет — в url) → ссылка для шва (token = url).
json inviteJson(const json &r, const std::string &me, bool revoked) {
    const auto title = r.value("title", std::string());
    const auto expires = r.value("expiresAt", std::int64_t(0));
    const auto limit = r.value("usageLimit", 0);
    const auto approval = r.value("isRequestNeeded", false);
    return json{{"token", r.value("url", std::string())}, {"link_id", r.value("linkId", std::string())},
                {"created_by", r.value("creator", me)}, {"title", title}, {"state", revoked ? "revoked" : "active"},
                {"created_at", r.value("date", std::int64_t(0))}, {"expires_at", expires}, {"max_uses", limit},
                {"uses", r.value("usage", 0)}, {"pending_requests", r.value("pendingRequests", 0)},
                {"request_needed", approval}, {"revoked", revoked},
                {"is_primary", !revoked && title.empty() && !expires && !limit && !approval}};
}

std::vector<std::string> stringList(const json &arr) {
    std::vector<std::string> out;
    if (arr.is_array()) for (const auto &m : arr) if (m.is_string()) out.push_back(m.get<std::string>());
    return out;
}

} // namespace

} // namespace pvjni

using namespace pvjni;

extern "C" {

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeListGroups(JNIEnv *env, jclass) {
    try {
        return jreply(env, groupListJson());
    } catch (const std::exception &e) {
        LOGE("listGroups: %s", e.what());
        return jreply(env, json::array());
    }
}

// Создать группу (kind group|channel) → адрес "v2g:<hex>" ("" — ошибка).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeCreateGroup(
        JNIEnv *env, jclass, jstring name, jstring kind, jstring membersJson) {
    try {
        const auto members = stringList(json::parse(jstr(env, membersJson), nullptr, false));
        const auto s = v2ReadyForSend();
        if (!s) throw std::runtime_error("сессия v2 не готова");
        const auto address = s->createGroup(jstr(env, name), members, jstr(env, kind) == "channel");
        if (address.empty()) throw std::runtime_error("группа не создана");
        const auto info = s->groupInfo(address);
        cacheGroupInfo(address, &info);
        auto mem = members;
        mem.push_back(self());
        noteGroupMembers(address, mem);
        LOGI("группа создана %s", address.c_str());
        return jout(env, address);
    } catch (const std::exception &e) {
        LOGE("createGroup: %s", e.what());
        return jout(env, "");
    }
}

// Действие: add|remove|leave|rename|remove_group|admin|member|ban|unban (участник/имя в arg) → {ok, error_code}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupAction(
        JNIEnv *env, jclass, jstring groupId, jstring action, jstring arg) {
    const auto gid = jstr(env, groupId), act = jstr(env, action), a = jstr(env, arg);
    const auto me = self();
    return jreply(env, change(gid, [&](const json &) -> json {
        if (act == "add") return json{{"add_member", memberRef(a)}};
        if (act == "remove") return a == me ? json{{"leave", json::object()}} : json{{"remove_member", memberRef(a)}};
        if (act == "leave") return json{{"leave", json::object()}};
        if (act == "rename") return json{{"set_info_patch", {{"name", a}}}};
        if (act == "remove_group") return json{{"delete_group", json::object()}};
        if (act == "admin") return json{{"set_role", {{"member", {{"address", a}}}, {"role", "ROLE_ADMIN"}, {"rights", adminRights(json{{"change_info", true}, {"delete_messages", true}, {"ban_users", true}, {"invite_users", true}, {"pin_messages", true}})}}}};
        if (act == "member") return json{{"set_role", {{"member", {{"address", a}}}, {"role", "ROLE_MEMBER"}, {"rights", json::object()}}}};
        if (act == "ban") return json{{"ban", memberRef(a)}};
        if (act == "unban") return json{{"unban", memberRef(a)}};
        return nullptr;
    }));
}

// Сведения: about (null — не менять), clearAvatar. Описание — ≤ 255 символов (как прежний шард).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupSetInfo(
        JNIEnv *env, jclass, jstring groupId, jstring name, jstring about, jboolean clearAvatar) {
    const auto gid = jstr(env, groupId);
    const auto nm = name ? std::optional<std::string>(jstr(env, name)) : std::nullopt;
    const auto ab = about ? std::optional<std::string>(jstr(env, about)) : std::nullopt;
    if (ab && std::count_if(ab->begin(), ab->end(), [](unsigned char c) { return (c & 0xC0) != 0x80; }) > 255)
        return jreply(env, jfail("bad_request", "описание длиннее 255 символов"));
    const auto s = v2ReadyForSend();
    if (!s) return jreply(env, jfail("failed"));
    try {
        const bool ok = s->setGroupInfo(gid, nm, ab, clearAvatar == JNI_TRUE ? std::optional<std::string>(std::string()) : std::nullopt);
        return jreply(env, ok ? json{{"ok", true}} : jfail("forbidden"));
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

// Фото группы: открытый блоб соединения управления → поле set_info записи журнала; копия в кэш.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupSetPhoto(JNIEnv *env, jclass, jstring groupId, jstring path) {
    try {
        std::ifstream f(jstr(env, path), std::ios::binary);
        if (!f) throw std::runtime_error("файл не читается");
        const std::string bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        const auto c = control();
        const auto s = v2ReadyForSend();
        if (!c || !s) throw std::runtime_error("сессия не готова");
        const auto fileId = c->uploadBlob(bytes, /*isPublic=*/true);
        if (fileId.empty()) throw std::runtime_error("блоб не принят");
        const auto gid = jstr(env, groupId);
        if (!s->setGroupInfo(gid, std::nullopt, std::nullopt, fileId)) return jreply(env, jfail("forbidden"));
        writeMediaCache(fileId, bytes);
        return jreply(env, json{{"ok", true}, {"file_id", fileId}, {"path", mediaWorkCopy(fileId, bytes)}});
    } catch (const std::exception &e) {
        LOGE("groupSetPhoto: %s", e.what());
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupSetPerms(JNIEnv *env, jclass, jstring groupId, jstring permsJson) {
    const auto pj = json::parse(jstr(env, permsJson), nullptr, false);
    if (!pj.is_object()) return jreply(env, jfail("bad_request"));
    return jreply(env, change(jstr(env, groupId), [&](const json &) {
        return json{{"set_permissions", {{"default_permissions", permissions(pj)}}}};
    }));
}

// rightsJson == null — снять админа.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupSetAdmin(
        JNIEnv *env, jclass, jstring groupId, jstring member, jstring rightsJson) {
    const auto mem = jstr(env, member);
    const auto rj = rightsJson ? json::parse(jstr(env, rightsJson), nullptr, false) : json();
    return jreply(env, change(jstr(env, groupId), [&](const json &) {
        return json{{"set_role", {{"member", {{"address", mem}}}, {"role", rj.is_object() ? "ROLE_ADMIN" : "ROLE_MEMBER"},
                                  {"rights", rj.is_object() ? adminRights(rj) : json::object()}}}};
    }));
}

// Ссылки группы: действующие (на устройствах админов — общие, T160) или отозванные (помнит сервер).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupInvites(JNIEnv *env, jclass, jstring groupId, jboolean revoked) {
    const auto s = v2ReadyForSend();
    if (!s) return jreply(env, jfail("failed"));
    const auto gid = jstr(env, groupId);
    const auto me = self();
    auto links = json::array();
    try {
        const auto list = revoked == JNI_TRUE ? s->listRevokedInvites(gid) : s->listInvites(gid);
        if (list.is_array()) for (const auto &r : list) links.push_back(inviteJson(r, me, revoked == JNI_TRUE));
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
    return jreply(env, json{{"ok", true}, {"links", links}});
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupInviteCreate(
        JNIEnv *env, jclass, jstring groupId, jstring title, jlong expiresAt, jint maxUses, jboolean requestNeeded) {
    const auto s = v2ReadyForSend();
    if (!s) return jreply(env, jfail("failed"));
    try {
        const auto r = s->createInvite(jstr(env, groupId), title ? jstr(env, title) : std::string(), expiresAt,
                                       static_cast<std::uint32_t>(std::max<jint>(maxUses, 0)), requestNeeded == JNI_TRUE);
        if (!r.is_object()) return jreply(env, jfail("forbidden"));
        const auto link = inviteJson(r, self(), false);
        return jreply(env, json{{"ok", true}, {"invite", link.value("token", std::string())}, {"link", link}});
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

// Правка действующей ссылки (название, срок, лимит); счётчик вступивших прежний (spec 024).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupInviteEdit(
        JNIEnv *env, jclass, jstring groupId, jstring url, jstring title, jlong expiresAt, jint maxUses) {
    const auto s = v2ReadyForSend();
    if (!s) return jreply(env, jfail("failed"));
    try {
        const bool ok = s->editInvite(jstr(env, groupId), jstr(env, url), title ? jstr(env, title) : std::string(), expiresAt,
                                      static_cast<std::uint32_t>(std::max<jint>(maxUses, 0)));
        return jreply(env, ok ? json{{"ok", true}} : jfail("forbidden"));
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

// Кто вступил по ссылке: [{"user","date"}].
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupInviteJoins(JNIEnv *env, jclass, jstring groupId, jstring linkId) {
    const auto s = v2ReadyForSend();
    if (!s) return jreply(env, jfail("failed"));
    try {
        const auto list = s->listInviteJoins(jstr(env, groupId), jstr(env, linkId));
        return jreply(env, json{{"ok", true}, {"joins", list.is_array() ? list : json::array()}});
    } catch (const std::exception &e) {
        return jreply(env, jfail(errorCodeOf(e), e.what()));
    }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupInviteRevoke(JNIEnv *env, jclass, jstring groupId, jstring token) {
    const auto s = v2ReadyForSend();
    const bool ok = s && s->revokeInvite(jstr(env, groupId), jstr(env, token));
    return jreply(env, ok ? json{{"ok", true}} : jfail("failed"));
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupInviteDelete(JNIEnv *env, jclass, jstring groupId, jstring linkId) {
    const auto s = v2ReadyForSend();
    const bool ok = s && s->deleteRevokedInvite(jstr(env, groupId), jstr(env, linkId));
    return jreply(env, ok ? json{{"ok", true}} : jfail("failed"));
}

// Превью ссылки до вступления → {ok, group_id, name, kind, members_count, request_needed, already_member}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupInviteCheck(JNIEnv *env, jclass, jstring token) {
    const auto url = jstr(env, token);
    if (!parvane::v2::Session::isInviteUrl(url)) return jreply(env, jfail("invalid"));
    const auto s = v2ReadyForSend();
    const auto r = s ? s->checkInvite(url) : json();
    if (!r.is_object()) return jreply(env, jfail("failed"));
    if (r.contains("error")) return jreply(env, jfail(r.value("error", std::string("failed"))));
    return jreply(env, json{{"ok", true}, {"group_id", r.value("address", std::string())}, {"name", r.value("name", std::string())},
                            {"kind", r.value("isChannel", false) ? "channel" : "group"}, {"avatar", ""}, {"about", ""},
                            {"members_count", r.value("membersCount", std::int64_t(0))},
                            {"request_needed", r.value("isRequestNeeded", false)}, {"already_member", r.value("isMember", false)}});
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupJoin(JNIEnv *env, jclass, jstring token) {
    const auto url = jstr(env, token);
    if (!parvane::v2::Session::isInviteUrl(url)) return jreply(env, jfail("invalid"));
    const auto s = v2ReadyForSend();
    const auto r = s ? s->joinByInvite(url) : json();
    const auto status = r.is_object() ? r.value("status", std::string()) : std::string();
    if (status == "ok") return jreply(env, json{{"ok", true}, {"group_id", r.value("address", std::string())}, {"pending", false}});
    if (status == "requested") return jreply(env, json{{"ok", true}, {"group_id", ""}, {"pending", true}});
    return jreply(env, jfail(r.is_object() ? r.value("code", std::string("failed")) : "failed"));
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupRequests(JNIEnv *env, jclass, jstring groupId) {
    const auto s = v2ReadyForSend();
    const auto list = s ? s->listJoinRequests(jstr(env, groupId)) : json(nullptr);
    if (!list.is_array()) return jreply(env, jfail("failed"));
    auto reqs = json::array();
    for (const auto &q : list)
        reqs.push_back(json{{"member", q.value("user", std::string())}, {"link_id", q.value("linkId", std::string())},
                            {"created_at", q.value("date", std::int64_t(0))}});
    return jreply(env, json{{"ok", true}, {"requests", reqs}});
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeGroupRequestDecide(
        JNIEnv *env, jclass, jstring groupId, jstring member, jboolean approve, jstring linkId) {
    const auto s = v2ReadyForSend();
    const bool ok = s && s->decideJoinRequest(jstr(env, groupId), jstr(env, member), approve == JNI_TRUE, jstr(env, linkId));
    return jreply(env, ok ? json{{"ok", true}} : jfail("failed"));
}

// ── публичные группы и каналы (spec 023, PUBLIC-1) ───────────────────────────

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePublicCheckName(JNIEnv *env, jclass, jstring name) {
    const auto s = v2ReadyForSend();
    if (!s) return jreply(env, jfail("failed"));
    try { return jreply(env, s->checkPublicName(jstr(env, name))); } catch (const std::exception &e) { return jreply(env, jfail(errorCodeOf(e))); }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePublicSearch(JNIEnv *env, jclass, jstring query) {
    const auto s = v2ReadyForSend();
    if (!s) return jreply(env, json::array());
    try {
        const auto r = s->searchPublic(jstr(env, query));
        return jreply(env, r.is_array() ? r : json::array());
    } catch (const std::exception &) {
        return jreply(env, json::array());
    }
}

// {"card","hex","secretHex"} | null
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePublicResolve(JNIEnv *env, jclass, jstring name) {
    const auto s = v2ReadyForSend();
    if (!s) return jout(env, "null");
    try { return jreply(env, s->resolvePublic(jstr(env, name))); } catch (const std::exception &) { return jout(env, "null"); }
}

// "ok" | "taken" | "invalid" | "failed"
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePublicSet(
        JNIEnv *env, jclass, jstring groupId, jboolean isPublic, jstring name, jboolean preview, jboolean history) {
    const auto s = v2ReadyForSend();
    if (!s) return jout(env, "failed");
    try {
        return jout(env, s->setGroupPublic(jstr(env, groupId), isPublic == JNI_TRUE, jstr(env, name), preview == JNI_TRUE, history == JNI_TRUE));
    } catch (const std::exception &) {
        return jout(env, "failed");
    }
}

// Просмотр без вступления: журнал группы (сведения) по открытому секрету.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePublicLoad(JNIEnv *env, jclass, jstring hex) {
    const auto s = v2ReadyForSend();
    if (!s) return jout(env, "null");
    try { return jreply(env, s->loadPublicGroup(jstr(env, hex))); } catch (const std::exception &) { return jout(env, "null"); }
}

JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePublicJoin(JNIEnv *env, jclass, jstring hex, jstring secretHex) {
    const auto s = v2ReadyForSend();
    if (!s) return jout(env, "null");
    try { return jreply(env, s->joinPublic(jstr(env, hex), jstr(env, secretHex))); } catch (const std::exception &) { return jout(env, "null"); }
}

// История публичной группы порциями (события сообщений — onEvent): {"opened","more","oldest"} | null.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativePublicHistory(JNIEnv *env, jclass, jstring groupId, jlong beforeSeq) {
    const auto s = v2ReadyForSend();
    if (!s) return jout(env, "null");
    try { return jreply(env, s->publicHistory(jstr(env, groupId), static_cast<std::uint64_t>(std::max<jlong>(beforeSeq, 0)))); }
    catch (const std::exception &) { return jout(env, "null"); }
}

// ── жалобы (REPORT-1) ────────────────────────────────────────────────────────

// Жалоба администратору сервера (запечатанная): "sent" | "unavailable" | "failed".
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeSubmitReport(JNIEnv *env, jclass, jstring reportJson) {
    const auto report = json::parse(jstr(env, reportJson), nullptr, false);
    const auto s = v2ReadyForSend();
    if (!s || !report.is_object()) return jout(env, "failed");
    try { return jout(env, s->submitReport(report)); } catch (const std::exception &) { return jout(env, "failed"); }
}

// Карточка жалобы админу группы (mod_report): проверена по своим данным — группа, участник, сообщения из своей
// истории (ревью 21 окт). → {"group","ops":[…],"authors":[…],"text"} | null.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneCore_nativeCheckModReport(JNIEnv *env, jclass, jstring contentJson, jstring reporter) {
    const auto content = json::parse(jstr(env, contentJson), nullptr, false);
    const auto check = parvane::v2::validateModReport(
        content, jstr(env, reporter), [](const std::string &g) { return groupMembers(g); },
        [](const std::string &opId) -> std::optional<parvane::v2::ReportLocalMessage> {
            const auto row = messageRow(opId);
            if (!row) return std::nullopt;
            return parvane::v2::ReportLocalMessage{row->chat, row->from,
                                                    row->content.value("text", row->content.value("caption", std::string()))};
        });
    if (!check) return jout(env, "null");
    return jreply(env, json{{"group", check->group}, {"ops", check->opIds}, {"authors", check->authors}, {"text", check->text}});
}

} // extern "C"
