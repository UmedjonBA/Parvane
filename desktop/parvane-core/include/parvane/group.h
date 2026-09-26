// Parvane fork: C++-зеркало типов групп/каналов из backend/shared/parvane-types.
// Группа/канал — адресуемая переписка (group_id); сообщения в неё идут обычным
// msg.chat.send с to = group_id, а участник получает их через sync.
// spec 003: фото/описание, права по умолчанию, гранулярные права админов,
// ревизия сведений (GROUP-1) и уведомление об изменении группы в инбоксе.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane {

using nlohmann::json;

// Права участников по умолчанию (позитивные флаги «разрешено»). Значения по
// умолчанию — как в Telegram: всё включено, кроме закрепа и смены информации.
struct DefaultPermissions {
    bool send_messages = true;
    bool send_media = true;
    bool send_stickers_gifs = true;
    bool send_polls = true;
    bool embed_links = true;
    bool invite_users = true;
    bool pin_messages = false;
    bool change_info = false;

    static DefaultPermissions fromJson(const json &j) {
        DefaultPermissions p;
        if (!j.is_object()) return p;
        p.send_messages = j.value("send_messages", true);
        p.send_media = j.value("send_media", true);
        p.send_stickers_gifs = j.value("send_stickers_gifs", true);
        p.send_polls = j.value("send_polls", true);
        p.embed_links = j.value("embed_links", true);
        p.invite_users = j.value("invite_users", true);
        p.pin_messages = j.value("pin_messages", false);
        p.change_info = j.value("change_info", false);
        return p;
    }
    json toJson() const {
        return json{{"send_messages", send_messages}, {"send_media", send_media},
                    {"send_stickers_gifs", send_stickers_gifs}, {"send_polls", send_polls},
                    {"embed_links", embed_links}, {"invite_users", invite_users},
                    {"pin_messages", pin_messages}, {"change_info", change_info}};
    }
};

// Гранулярные права админа. У legacy-админа сервер отдаёт полный набор.
struct AdminRights {
    bool change_info = true;
    bool delete_messages = true;
    bool ban_users = true;
    bool invite_users = true;
    bool pin_messages = true;
    bool add_admins = true;

    static AdminRights fromJson(const json &j) {
        AdminRights r;
        if (!j.is_object()) return r;
        r.change_info = j.value("change_info", true);
        r.delete_messages = j.value("delete_messages", true);
        r.ban_users = j.value("ban_users", true);
        r.invite_users = j.value("invite_users", true);
        r.pin_messages = j.value("pin_messages", true);
        r.add_admins = j.value("add_admins", true);
        return r;
    }
    json toJson() const {
        return json{{"change_info", change_info}, {"delete_messages", delete_messages},
                    {"ban_users", ban_users}, {"invite_users", invite_users},
                    {"pin_messages", pin_messages}, {"add_admins", add_admins}};
    }
    // Пустой набор — для нового админа с экрана «Edit admin» (дефолт конструктора
    // остаётся полным набором ради legacy-админов без admin_rights на проводе).
    static AdminRights none() {
        AdminRights r;
        r.change_info = r.delete_messages = r.ban_users = false;
        r.invite_users = r.pin_messages = r.add_admins = false;
        return r;
    }
};

struct GroupMember {
    std::string address;
    std::string role; // owner | admin | member | banned
    // Права админа: пусто у role=admin — полный набор (админ до spec 003)
    std::optional<AdminRights> admin_rights;
    std::string promoted_by;

    static GroupMember fromJson(const json &j) {
        GroupMember m;
        m.address = j.value("address", std::string());
        m.role = j.value("role", std::string());
        if (auto it = j.find("admin_rights"); it != j.end() && it->is_object()) {
            m.admin_rights = AdminRights::fromJson(*it);
        }
        if (auto it = j.find("promoted_by"); it != j.end() && it->is_string()) {
            m.promoted_by = it->get<std::string>();
        }
        return m;
    }

    // Права админа с учётом legacy (нет набора = полный)
    AdminRights effectiveRights() const {
        return admin_rights.value_or(AdminRights{});
    }
};

struct GroupInfo {
    std::string group_id;
    std::string name;
    std::string kind; // group | channel
    std::string created_by;
    std::vector<GroupMember> members;
    // spec 003 — все поля необязательны на проводе
    std::string avatar; // file_id фото в cloud (открытый объект), пусто — нет фото
    std::string about;  // описание, ≤255 символов
    DefaultPermissions default_permissions;
    std::uint64_t version = 0; // ревизия сведений: применять при version >= локальной (GROUP-1)
    int pending_requests = -1; // число ожидающих заявок (только менеджерам приглашений), -1 — не отдано

    static GroupInfo fromJson(const json &j) {
        GroupInfo g;
        g.group_id = j.value("group_id", std::string());
        g.name = j.value("name", std::string());
        g.kind = j.value("kind", std::string("group"));
        g.created_by = j.value("created_by", std::string());
        if (auto it = j.find("members"); it != j.end() && it->is_array()) {
            for (const auto &m : *it) g.members.push_back(GroupMember::fromJson(m));
        }
        if (auto it = j.find("avatar"); it != j.end() && it->is_string()) g.avatar = it->get<std::string>();
        if (auto it = j.find("about"); it != j.end() && it->is_string()) g.about = it->get<std::string>();
        if (auto it = j.find("default_permissions"); it != j.end() && it->is_object()) {
            g.default_permissions = DefaultPermissions::fromJson(*it);
        }
        if (auto it = j.find("version"); it != j.end() && it->is_number_unsigned()) {
            g.version = it->get<std::uint64_t>();
        } else if (auto it2 = j.find("version"); it2 != j.end() && it2->is_number_integer()) {
            const auto v = it2->get<std::int64_t>();
            g.version = v > 0 ? std::uint64_t(v) : 0;
        }
        if (auto it = j.find("pending_requests"); it != j.end() && it->is_number_integer()) {
            g.pending_requests = it->get<int>();
        }
        return g;
    }
};

// Уведомление об изменении группы в инбоксе msg.user.<self> (поле `group`
// вместо `message`, как notify/read/cleared). change: info | perms | members |
// admin | invites | requests | removed | deleted; info — полные сведения для
// первых четырёх.
struct GroupNotice {
    std::string group_id;
    std::uint64_t version = 0;
    std::string change;
    std::optional<GroupInfo> info;

    static GroupNotice fromJson(const json &j) {
        GroupNotice n;
        n.group_id = j.value("group_id", std::string());
        n.change = j.value("change", std::string());
        if (auto it = j.find("version"); it != j.end() && it->is_number()) {
            const auto v = it->get<std::int64_t>();
            n.version = v > 0 ? std::uint64_t(v) : 0;
        }
        if (auto it = j.find("info"); it != j.end() && it->is_object()) n.info = GroupInfo::fromJson(*it);
        return n;
    }
};

// Ответ group.list / group.info (последний — 0 или 1 группа).
struct GroupListResponse {
    std::vector<GroupInfo> groups;

    static GroupListResponse fromJson(const json &j) {
        GroupListResponse r;
        if (auto it = j.find("groups"); it != j.end() && it->is_array()) {
            for (const auto &g : *it) r.groups.push_back(GroupInfo::fromJson(g));
        }
        return r;
    }
};

// Ответ group.create.
struct GroupCreateResponse {
    bool ok = false;
    std::string group_id;
    std::string error;

    static GroupCreateResponse fromJson(const json &j) {
        GroupCreateResponse r;
        r.ok = j.value("ok", false);
        if (auto it = j.find("group_id"); it != j.end() && !it->is_null())
            r.group_id = it->get<std::string>();
        if (auto it = j.find("error"); it != j.end() && !it->is_null())
            r.error = it->get<std::string>();
        return r;
    }
};

// Ответ add/remove member (и остальных действий): ok/error + стабильный код.
struct GroupActionResponse {
    bool ok = false;
    std::string error;
    std::string error_code;

    static GroupActionResponse fromJson(const json &j) {
        GroupActionResponse r;
        r.ok = j.value("ok", false);
        if (auto it = j.find("error"); it != j.end() && !it->is_null())
            r.error = it->get<std::string>();
        if (auto it = j.find("error_code"); it != j.end() && it->is_string())
            r.error_code = it->get<std::string>();
        return r;
    }
    json toJson() const {
        return json{{"ok", ok}, {"error", error}, {"error_code", error_code}};
    }
};

// ── spec 004: управление группой с клиентов ──────────────────────────────────

namespace detail {
inline std::string optString(const json &j, const char *key) {
    if (auto it = j.find(key); it != j.end() && it->is_string()) return it->get<std::string>();
    return {};
}
inline std::int64_t optInt(const json &j, const char *key) {
    if (auto it = j.find(key); it != j.end() && it->is_number()) return it->get<std::int64_t>();
    return 0;
}
inline bool optBool(const json &j, const char *key) {
    if (auto it = j.find(key); it != j.end() && it->is_boolean()) return it->get<bool>();
    return false;
}
} // namespace detail

// Ответ мутаций setinfo / setperms / setadmin / request.decide: ревизия после.
struct GroupVersionResponse {
    bool ok = false;
    std::uint64_t version = 0;
    std::string error;
    std::string error_code;

    static GroupVersionResponse fromJson(const json &j) {
        GroupVersionResponse r;
        if (!j.is_object()) return r;
        r.ok = detail::optBool(j, "ok");
        const auto v = detail::optInt(j, "version");
        r.version = v > 0 ? std::uint64_t(v) : 0;
        r.error = detail::optString(j, "error");
        r.error_code = detail::optString(j, "error_code");
        return r;
    }
    json toJson() const {
        return json{{"ok", ok}, {"version", version}, {"error", error}, {"error_code", error_code}};
    }
};

// Параметры создания ссылки; «не задано» = ""/0/false (как web).
struct InviteParams {
    std::string title;
    std::int64_t expires_at = 0;
    int max_uses = 0;
    bool request_needed = false;
};

// Инвайт-ссылка из group.invite.list / group.invite.create.
struct InviteLink {
    std::string token;
    std::string created_by;
    std::int64_t created_at = 0;
    std::string title;
    std::int64_t expires_at = 0;
    int max_uses = 0;
    int uses = 0;
    bool request_needed = false;
    bool revoked = false;
    std::int64_t revoked_at = 0;
    std::string state; // active | revoked | expired | exhausted (вычислен сервером)
    bool is_primary = false;
    int pending_requests = 0;

    static InviteLink fromJson(const json &j) {
        InviteLink l;
        if (!j.is_object()) return l;
        l.token = detail::optString(j, "token");
        l.created_by = detail::optString(j, "created_by");
        l.created_at = detail::optInt(j, "created_at");
        l.title = detail::optString(j, "title");
        l.expires_at = detail::optInt(j, "expires_at");
        l.max_uses = int(detail::optInt(j, "max_uses"));
        l.uses = int(detail::optInt(j, "uses"));
        l.request_needed = detail::optBool(j, "request_needed");
        l.revoked = detail::optBool(j, "revoked");
        l.revoked_at = detail::optInt(j, "revoked_at");
        l.state = detail::optString(j, "state");
        if (l.state.empty()) l.state = l.revoked ? "revoked" : "active";
        l.is_primary = detail::optBool(j, "is_primary");
        l.pending_requests = int(detail::optInt(j, "pending_requests"));
        return l;
    }
    json toJson() const {
        return json{{"token", token}, {"created_by", created_by}, {"created_at", created_at},
                    {"title", title}, {"expires_at", expires_at}, {"max_uses", max_uses}, {"uses", uses},
                    {"request_needed", request_needed}, {"revoked", revoked}, {"revoked_at", revoked_at},
                    {"state", state}, {"is_primary", is_primary}, {"pending_requests", pending_requests}};
    }
};

struct GroupInviteCreateResponse {
    bool ok = false;
    std::string invite;
    std::optional<InviteLink> link;
    std::string error;
    std::string error_code;

    static GroupInviteCreateResponse fromJson(const json &j) {
        GroupInviteCreateResponse r;
        if (!j.is_object()) return r;
        r.ok = detail::optBool(j, "ok");
        r.invite = detail::optString(j, "invite");
        if (auto it = j.find("link"); it != j.end() && it->is_object()) r.link = InviteLink::fromJson(*it);
        r.error = detail::optString(j, "error");
        r.error_code = detail::optString(j, "error_code");
        return r;
    }
};

struct GroupInviteListResponse {
    bool ok = false;
    std::vector<InviteLink> links;
    std::string error;
    std::string error_code;

    static GroupInviteListResponse fromJson(const json &j) {
        GroupInviteListResponse r;
        if (!j.is_object()) return r;
        r.ok = detail::optBool(j, "ok");
        if (auto it = j.find("links"); it != j.end() && it->is_array()) {
            for (const auto &l : *it) r.links.push_back(InviteLink::fromJson(l));
        }
        r.error = detail::optString(j, "error");
        r.error_code = detail::optString(j, "error_code");
        return r;
    }
};

// Превью группы по ссылке до вступления (group.invite.check).
struct GroupInviteCheckResponse {
    bool ok = false;
    std::string group_id;
    std::string name;
    std::string kind; // group | channel
    std::string avatar;
    std::string about;
    int members_count = 0;
    bool request_needed = false;
    bool already_member = false;
    bool pending = false;
    std::string error;
    std::string error_code; // invalid | revoked | expired | exhausted | banned

    static GroupInviteCheckResponse fromJson(const json &j) {
        GroupInviteCheckResponse r;
        if (!j.is_object()) return r;
        r.ok = detail::optBool(j, "ok");
        r.group_id = detail::optString(j, "group_id");
        r.name = detail::optString(j, "name");
        r.kind = detail::optString(j, "kind");
        if (r.kind.empty()) r.kind = "group";
        r.avatar = detail::optString(j, "avatar");
        r.about = detail::optString(j, "about");
        r.members_count = int(detail::optInt(j, "members_count"));
        r.request_needed = detail::optBool(j, "request_needed");
        r.already_member = detail::optBool(j, "already_member");
        r.pending = detail::optBool(j, "pending");
        r.error = detail::optString(j, "error");
        r.error_code = detail::optString(j, "error_code");
        return r;
    }
    json toJson() const {
        return json{{"ok", ok}, {"group_id", group_id}, {"name", name}, {"kind", kind}, {"avatar", avatar},
                    {"about", about}, {"members_count", members_count}, {"request_needed", request_needed},
                    {"already_member", already_member}, {"pending", pending}, {"error", error},
                    {"error_code", error_code}};
    }
};

// Ответ group.join: вступил / заявка создана / отказ с кодом.
struct GroupJoinResponse {
    bool ok = false;
    std::string group_id;
    std::string name;
    bool pending = false;
    std::string error;
    std::string error_code; // invalid | revoked | expired | exhausted | banned | declined

    static GroupJoinResponse fromJson(const json &j) {
        GroupJoinResponse r;
        if (!j.is_object()) return r;
        r.ok = detail::optBool(j, "ok");
        r.group_id = detail::optString(j, "group_id");
        r.name = detail::optString(j, "name");
        r.pending = detail::optBool(j, "pending");
        r.error = detail::optString(j, "error");
        r.error_code = detail::optString(j, "error_code");
        return r;
    }
    json toJson() const {
        return json{{"ok", ok}, {"group_id", group_id}, {"name", name}, {"pending", pending},
                    {"error", error}, {"error_code", error_code}};
    }
};

struct JoinRequestInfo {
    std::string member;
    std::string invite;
    std::int64_t created_at = 0;

    static JoinRequestInfo fromJson(const json &j) {
        JoinRequestInfo r;
        if (!j.is_object()) return r;
        r.member = detail::optString(j, "member");
        r.invite = detail::optString(j, "invite");
        r.created_at = detail::optInt(j, "created_at");
        return r;
    }
    json toJson() const {
        return json{{"member", member}, {"invite", invite}, {"created_at", created_at}};
    }
};

struct GroupRequestListResponse {
    bool ok = false;
    std::vector<JoinRequestInfo> requests;
    std::string error;
    std::string error_code;

    static GroupRequestListResponse fromJson(const json &j) {
        GroupRequestListResponse r;
        if (!j.is_object()) return r;
        r.ok = detail::optBool(j, "ok");
        if (auto it = j.find("requests"); it != j.end() && it->is_array()) {
            for (const auto &q : *it) r.requests.push_back(JoinRequestInfo::fromJson(q));
        }
        r.error = detail::optString(j, "error");
        r.error_code = detail::optString(j, "error_code");
        return r;
    }
};

// ── conformance GROUP-2: права по типу содержимого на клиенте ────────────────
// Единая формула для web/desktop/android: участник БЕЗ роли и БЕЗ права не
// может ни отправить, ни показать получателям содержимое запрещённого вида.
// Владелец, админ и сам отправитель под фильтр не подпадают — это решает
// вызывающий (роль автора известна из GroupInfo). Оценка — при приёме.
inline bool isContentAllowedForMember(const DefaultPermissions &p, const std::string &kind,
                                      bool hasLink) {
    if (!p.send_messages) return false;
    if (!p.send_media && (kind == "photo" || kind == "video" || kind == "file"
                          || kind == "voice" || kind == "video_note" || kind == "audio")) {
        return false;
    }
    if (!p.send_stickers_gifs && (kind == "sticker" || kind == "gif")) return false;
    if (!p.send_polls && kind == "poll") return false;
    if (!p.embed_links && kind == "text" && hasLink) return false;
    return true;
}

// Есть ли в текстовом содержимом ссылка: превью `webpage` или сущность
// url/text_url (имена tt `MessageEntityUrl`/`MessageEntityTextUrl` и короткие).
inline bool contentHasLink(const json &content) {
    if (!content.is_object()) return false;
    if (auto it = content.find("webpage"); it != content.end() && it->is_object() && !it->empty()) {
        return true;
    }
    if (auto it = content.find("entities"); it != content.end() && it->is_array()) {
        for (const auto &e : *it) {
            const auto t = e.is_object() ? e.value("type", std::string()) : std::string();
            if (t == "MessageEntityUrl" || t == "MessageEntityTextUrl" || t == "url" || t == "text_url") {
                return true;
            }
        }
    }
    return false;
}

inline bool isContentAllowedForMember(const DefaultPermissions &p, const json &content) {
    return isContentAllowedForMember(p, content.is_object() ? content.value("kind", std::string("text")) : "text",
                                     contentHasLink(content));
}

} // namespace parvane
