// Parvane fork: реализация GroupClient (см. group_client.h).
#include "parvane/group_client.h"

#include "parvane/topics.h"

namespace parvane {

GroupCreateResponse GroupClient::create(const std::string &token, const std::string &name,
                                        const std::string &kind,
                                        const std::vector<std::string> &members,
                                        int timeoutMs) {
    const json req{ { "token", token }, { "name", name }, { "kind", kind },
                    { "members", members } };
    const std::string raw = _t.request(topics::GroupCreate, req.dump(), timeoutMs);
    return GroupCreateResponse::fromJson(json::parse(raw));
}

std::vector<GroupInfo> GroupClient::list(const std::string &token, int timeoutMs) {
    const json req{ { "token", token } };
    const std::string raw = _t.request(topics::GroupList, req.dump(), timeoutMs);
    return GroupListResponse::fromJson(json::parse(raw)).groups;
}

GroupInfo GroupClient::info(const std::string &token, const std::string &groupId,
                            int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId } };
    const std::string raw = _t.request(topics::GroupInfo, req.dump(), timeoutMs);
    auto groups = GroupListResponse::fromJson(json::parse(raw)).groups;
    return groups.empty() ? GroupInfo{} : groups.front();
}

GroupActionResponse GroupClient::addMember(const std::string &token, const std::string &groupId,
                                           const std::string &member, int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId }, { "member", member } };
    const std::string raw = _t.request(topics::GroupAddMember, req.dump(), timeoutMs);
    return GroupActionResponse::fromJson(json::parse(raw));
}

GroupActionResponse GroupClient::removeMember(const std::string &token, const std::string &groupId,
                                              const std::string &member, int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId }, { "member", member } };
    const std::string raw = _t.request(topics::GroupRemoveMember, req.dump(), timeoutMs);
    return GroupActionResponse::fromJson(json::parse(raw));
}

GroupActionResponse GroupClient::setRole(const std::string &token, const std::string &groupId,
                                         const std::string &member, const std::string &role,
                                         int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId },
                    { "member", member }, { "role", role } };
    const std::string raw = _t.request(topics::GroupSetRole, req.dump(), timeoutMs);
    return GroupActionResponse::fromJson(json::parse(raw));
}

} // namespace parvane
