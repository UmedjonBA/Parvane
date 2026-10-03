// Parvane fork: переходный период протокола v2 (spec 007, FR-054/FR-058) —
// v1-устройства аккаунтов, уже перешедших на v2. Связывает сессию v2
// (подписанный список v1-устройств в журнале) с v1-шифрованием (Olm).
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

namespace parvane {
class ITransport;
class MessengerClient;
}

namespace parvane::v2 {

class Session;

// Опубликовать (первое v2-устройство) или сократить свой подписанный список
// v1-устройств по каталогу identity. Блокирующий (сеть v1 и v2); ошибки — в лог.
void publishLegacySet(Session &session, ITransport &t, const std::string &token);

// После v2-отправки сообщения `id` собеседнику `to`: та же запись (v1
// MessageContent) — v1-устройствам из подписанных списков собеседника и
// своего, методом `msg.deliver_legacy` с тем же id. Устройства вне списков не
// получают ничего. true — копии отправлены; сбой не бросает (по v2 доставлено).
bool sendLegacyCopies(Session &session, ITransport &t, const std::string &token,
                      const std::string &to, const nlohmann::json &content,
                      const std::string &id, const std::optional<std::string> &replyTo);

// Правка v2-сообщения `id` (новое v1-содержимое целиком) — v1-устройствам,
// получившим его легаси-копией: v1 `msg.chat.edit` с копиями по тем же спискам.
bool editLegacyCopies(Session &session, ITransport &t, MessengerClient &m,
                      const std::string &token, const std::string &to,
                      const nlohmann::json &content, const std::string &id);

// Удаление «у всех» v2-сообщения `id` — и у v1-устройств (надгробие v1).
bool deleteLegacyCopies(Session &session, MessengerClient &m, const std::string &token,
                        const std::string &to, const std::string &id);

} // namespace parvane::v2
