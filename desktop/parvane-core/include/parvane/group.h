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
