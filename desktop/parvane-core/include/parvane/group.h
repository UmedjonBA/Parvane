// Parvane fork: C++-зеркало типов групп/каналов из shared/parvane-types.
// Группа/канал — адресуемая переписка (group_id); сообщения в неё идут обычным
// msg.chat.send с to = group_id, а участник получает их через sync.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane {

using nlohmann::json;

struct GroupMember {
    std::string address;
    std::string role; // owner | admin | member

    static GroupMember fromJson(const json &j) {
        GroupMember m;
        m.address = j.value("address", std::string());
        m.role = j.value("role", std::string());
        return m;
    }
};

struct GroupInfo {
    std::string group_id;
    std::string name;
    std::string kind; // group | channel
    std::string created_by;
    std::vector<GroupMember> members;

    static GroupInfo fromJson(const json &j) {
        GroupInfo g;
        g.group_id = j.value("group_id", std::string());
        g.name = j.value("name", std::string());
        g.kind = j.value("kind", std::string("group"));
        g.created_by = j.value("created_by", std::string());
        if (auto it = j.find("members"); it != j.end() && it->is_array()) {
            for (const auto &m : *it) g.members.push_back(GroupMember::fromJson(m));
        }
        return g;
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

// Ответ add/remove member.
struct GroupActionResponse {
    bool ok = false;
    std::string error;

    static GroupActionResponse fromJson(const json &j) {
        GroupActionResponse r;
        r.ok = j.value("ok", false);
        if (auto it = j.find("error"); it != j.end() && !it->is_null())
            r.error = it->get<std::string>();
        return r;
    }
};

} // namespace parvane
