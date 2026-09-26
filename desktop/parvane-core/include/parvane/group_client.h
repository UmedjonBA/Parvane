// Parvane fork: клиент групп/каналов поверх Transport (request/reply к messenger).
// Токен — JWT текущей сессии. Все методы БЛОКИРУЮЩИЕ (звать из worker-потока).
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/group.h"
#include "parvane/transport.h"

namespace parvane {

class GroupClient {
public:
    explicit GroupClient(ITransport &transport) : _t(transport) {}

    // Создать группу/канал. kind: "group"|"channel". Возвращает ответ (group_id).
    GroupCreateResponse create(const std::string &token, const std::string &name,
                               const std::string &kind,
                               const std::vector<std::string> &members,
                               int timeoutMs = 3000);

    // Список групп/каналов текущего пользователя.
    std::vector<GroupInfo> list(const std::string &token, int timeoutMs = 3000);

    // Сведения об одной группе (участники).
    GroupInfo info(const std::string &token, const std::string &groupId,
                   int timeoutMs = 3000);

    GroupActionResponse addMember(const std::string &token, const std::string &groupId,
                                  const std::string &member, int timeoutMs = 3000);
    GroupActionResponse removeMember(const std::string &token, const std::string &groupId,
                                     const std::string &member, int timeoutMs = 3000);
    // Сменить роль участника (только owner): role = "admin" | "member".
    GroupActionResponse setRole(const std::string &token, const std::string &groupId,
                                const std::string &member, const std::string &role,
                                int timeoutMs = 3000);

    // Бан/разбан участника (owner/admin; owner небаним).
    GroupActionResponse ban(const std::string &token, const std::string &groupId,
                            const std::string &member, bool banned,
                            int timeoutMs = 3000);
    // Мьют до unix-времени until (0 — снять). owner/admin; owner немьютим.
    GroupActionResponse mute(const std::string &token, const std::string &groupId,
                             const std::string &member, long long until,
                             int timeoutMs = 3000);
    // Переименовать (owner/admin) / удалить группу (только owner).
    GroupActionResponse rename(const std::string &token, const std::string &groupId,
                               const std::string &name, int timeoutMs = 3000);
    GroupActionResponse remove(const std::string &token, const std::string &groupId,
                               int timeoutMs = 3000);
    // Создать инвайт-токен без параметров (owner/admin). Пустая строка при ошибке.
    std::string inviteCreate(const std::string &token, const std::string &groupId,
                             int timeoutMs = 3000);
    // Вступить по инвайт-токену. Возвращает {ok,group_id,name,error} JSON-ом.
    json join(const std::string &token, const std::string &invite,
              int timeoutMs = 3000);

    // ── spec 004: управление группой (сервер и провод — spec 003) ────────────
    // Описание/фото: заданные поля меняются, отсутствующие — нет; clear_avatar
    // приоритетнее avatar_file_id. Право: владелец или change_info.
    GroupVersionResponse setInfo(const std::string &token, const std::string &groupId,
                                 const std::optional<std::string> &about,
                                 const std::optional<std::string> &avatarFileId,
                                 bool clearAvatar, int timeoutMs = 3000);
    // Права участников по умолчанию (полный набор 8 ключей). У канала — bad_request.
    GroupVersionResponse setPerms(const std::string &token, const std::string &groupId,
                                  const DefaultPermissions &perms, int timeoutMs = 3000);
    // Гранулярные права админа; nullopt — снять админа (rights: null).
    GroupVersionResponse setAdmin(const std::string &token, const std::string &groupId,
                                  const std::string &member,
                                  const std::optional<AdminRights> &rights,
                                  int timeoutMs = 3000);
    // Ссылка с названием/сроком/лимитом/«по одобрению»; ответ несёт саму ссылку.
    GroupInviteCreateResponse inviteCreate(const std::string &token, const std::string &groupId,
                                           const InviteParams &params, int timeoutMs = 3000);
    // revoked=false — активные/истёкшие/исчерпанные, true — отозванные.
    GroupInviteListResponse inviteList(const std::string &token, const std::string &groupId,
                                       bool revoked, int timeoutMs = 3000);
    GroupActionResponse inviteRevoke(const std::string &token, const std::string &groupId,
                                     const std::string &invite, int timeoutMs = 3000);
    // Удалить можно только отозванную.
    GroupActionResponse inviteDelete(const std::string &token, const std::string &groupId,
                                     const std::string &invite, int timeoutMs = 3000);
    // Превью до вступления (любой авторизованный).
    GroupInviteCheckResponse inviteCheck(const std::string &token, const std::string &invite,
                                         int timeoutMs = 3000);
    // Типизированный join: ok / pending (заявка) / error_code.
    GroupJoinResponse joinByInvite(const std::string &token, const std::string &invite,
                                   int timeoutMs = 3000);
    GroupRequestListResponse requestList(const std::string &token, const std::string &groupId,
                                         int timeoutMs = 3000);
    GroupVersionResponse requestDecide(const std::string &token, const std::string &groupId,
                                       const std::string &member, bool approve,
                                       int timeoutMs = 3000);

private:
    ITransport &_t;
};

} // namespace parvane
