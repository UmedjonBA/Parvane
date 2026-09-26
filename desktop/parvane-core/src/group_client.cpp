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

GroupActionResponse GroupClient::ban(const std::string &token, const std::string &groupId,
                                     const std::string &member, bool banned,
                                     int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId }, { "member", member } };
    const std::string raw = _t.request(
        banned ? topics::GroupBan : topics::GroupUnban, req.dump(), timeoutMs);
    return GroupActionResponse::fromJson(json::parse(raw));
}

GroupActionResponse GroupClient::mute(const std::string &token, const std::string &groupId,
                                      const std::string &member, long long until,
                                      int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId },
                    { "member", member }, { "until", until } };
    const std::string raw = _t.request(topics::GroupMute, req.dump(), timeoutMs);
    return GroupActionResponse::fromJson(json::parse(raw));
}

GroupActionResponse GroupClient::rename(const std::string &token, const std::string &groupId,
                                        const std::string &name, int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId }, { "name", name } };
    const std::string raw = _t.request(topics::GroupRename, req.dump(), timeoutMs);
    return GroupActionResponse::fromJson(json::parse(raw));
}

GroupActionResponse GroupClient::remove(const std::string &token, const std::string &groupId,
                                        int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId } };
    const std::string raw = _t.request(topics::GroupDelete, req.dump(), timeoutMs);
    return GroupActionResponse::fromJson(json::parse(raw));
}

std::string GroupClient::inviteCreate(const std::string &token, const std::string &groupId,
                                      int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId } };
    const std::string raw = _t.request(topics::GroupInviteCreate, req.dump(), timeoutMs);
    const auto j = json::parse(raw);
    return j.value("ok", false) ? j.value("invite", std::string()) : std::string();
}

json GroupClient::join(const std::string &token, const std::string &invite,
                       int timeoutMs) {
    const json req{ { "token", token }, { "invite", invite } };
    return json::parse(_t.request(topics::GroupJoin, req.dump(), timeoutMs));
}

// ── spec 004 ─────────────────────────────────────────────────────────────────
namespace {
json parseReply(const std::string &raw) {
    auto j = json::parse(raw, nullptr, false);
    return j.is_discarded() ? json::object() : j;
}
} // namespace

GroupVersionResponse GroupClient::setInfo(const std::string &token, const std::string &groupId,
                                          const std::optional<std::string> &about,
                                          const std::optional<std::string> &avatarFileId,
                                          bool clearAvatar, int timeoutMs) {
    json req{ { "token", token }, { "group_id", groupId }, { "clear_avatar", clearAvatar } };
    if (about) req["about"] = *about;
    if (avatarFileId) req["avatar_file_id"] = *avatarFileId;
    return GroupVersionResponse::fromJson(parseReply(_t.request(topics::GroupSetInfo, req.dump(), timeoutMs)));
}

GroupVersionResponse GroupClient::setPerms(const std::string &token, const std::string &groupId,
                                           const DefaultPermissions &perms, int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId },
                    { "default_permissions", perms.toJson() } };
    return GroupVersionResponse::fromJson(parseReply(_t.request(topics::GroupSetPerms, req.dump(), timeoutMs)));
}

GroupVersionResponse GroupClient::setAdmin(const std::string &token, const std::string &groupId,
                                           const std::string &member,
                                           const std::optional<AdminRights> &rights,
                                           int timeoutMs) {
    json req{ { "token", token }, { "group_id", groupId }, { "member", member } };
    req["rights"] = rights ? rights->toJson() : json(nullptr);
    return GroupVersionResponse::fromJson(parseReply(_t.request(topics::GroupSetAdmin, req.dump(), timeoutMs)));
}

GroupInviteCreateResponse GroupClient::inviteCreate(const std::string &token, const std::string &groupId,
                                                    const InviteParams &params, int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId },
                    { "title", params.title }, { "expires_at", params.expires_at },
                    { "max_uses", params.max_uses }, { "request_needed", params.request_needed } };
    return GroupInviteCreateResponse::fromJson(parseReply(_t.request(topics::GroupInviteCreate, req.dump(), timeoutMs)));
}

GroupInviteListResponse GroupClient::inviteList(const std::string &token, const std::string &groupId,
                                                bool revoked, int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId }, { "revoked", revoked } };
    return GroupInviteListResponse::fromJson(parseReply(_t.request(topics::GroupInviteList, req.dump(), timeoutMs)));
}

GroupActionResponse GroupClient::inviteRevoke(const std::string &token, const std::string &groupId,
                                              const std::string &invite, int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId }, { "invite", invite } };
    return GroupActionResponse::fromJson(parseReply(_t.request(topics::GroupInviteRevoke, req.dump(), timeoutMs)));
}

GroupActionResponse GroupClient::inviteDelete(const std::string &token, const std::string &groupId,
                                              const std::string &invite, int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId }, { "invite", invite } };
    return GroupActionResponse::fromJson(parseReply(_t.request(topics::GroupInviteDelete, req.dump(), timeoutMs)));
}

GroupInviteCheckResponse GroupClient::inviteCheck(const std::string &token, const std::string &invite,
                                                  int timeoutMs) {
    const json req{ { "token", token }, { "invite", invite } };
    return GroupInviteCheckResponse::fromJson(parseReply(_t.request(topics::GroupInviteCheck, req.dump(), timeoutMs)));
}

GroupJoinResponse GroupClient::joinByInvite(const std::string &token, const std::string &invite,
                                            int timeoutMs) {
    const json req{ { "token", token }, { "invite", invite } };
    return GroupJoinResponse::fromJson(parseReply(_t.request(topics::GroupJoin, req.dump(), timeoutMs)));
}

GroupRequestListResponse GroupClient::requestList(const std::string &token, const std::string &groupId,
                                                  int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId } };
    return GroupRequestListResponse::fromJson(parseReply(_t.request(topics::GroupRequestList, req.dump(), timeoutMs)));
}

GroupVersionResponse GroupClient::requestDecide(const std::string &token, const std::string &groupId,
                                                const std::string &member, bool approve,
                                                int timeoutMs) {
    const json req{ { "token", token }, { "group_id", groupId }, { "member", member }, { "approve", approve } };
    return GroupVersionResponse::fromJson(parseReply(_t.request(topics::GroupRequestDecide, req.dump(), timeoutMs)));
}

} // namespace parvane
