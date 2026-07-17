// Parvane fork: клиент групп/каналов поверх Transport (request/reply к messenger).
// Токен — JWT текущей сессии. Все методы БЛОКИРУЮЩИЕ (звать из worker-потока).
#pragma once

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
    // Создать инвайт-токен (owner/admin). Пустая строка при ошибке.
    std::string inviteCreate(const std::string &token, const std::string &groupId,
                             int timeoutMs = 3000);
    // Вступить по инвайт-токену. Возвращает {ok,group_id,name,error} JSON-ом.
    json join(const std::string &token, const std::string &invite,
              int timeoutMs = 3000);

private:
    ITransport &_t;
};

} // namespace parvane
