// Parvane fork: высокоуровневый messenger-клиент поверх Transport.
// Инкапсулирует сборку конверта ParvaneEvent<T>, генерацию id/ts и (де)сериализацию
// msg.* пейлоадов. Используется glue-слоем tdesktop (Фаза 3b-3d) и тестами.
//
// Потокобезопасность: методы блокирующие (request/publish транспорта). Звать
// sendText/sync из worker-потока. onDelivered ставит подписку, колбэк зовётся
// из NATS-потока cnats — переноси результат на main сам (crl::on_main).
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "parvane/messenger.h"
#include "parvane/transport.h"

namespace parvane {

class MessengerClient {
public:
    explicit MessengerClient(Transport &transport) : _t(transport) {}

    // Публикует ПОЛНЫЙ ParvaneEvent<SendPayload> на msg.chat.send.
    // Возвращает сгенерированный id события (= id сообщения для последующего
    // сопоставления с msg.chat.delivered). reply_to — id родителя или nullopt.
    std::string sendText(
        const std::string &from,
        const std::string &to,
        const std::string &text,
        const std::string &token,
        const std::optional<std::string> &replyTo = std::nullopt);

    // Опрашивает msg.sync.request (request/reply, полный конверт) и возвращает
    // сообщения после курсоров. lastSeenId — id-курсор (нулевой uuid = с начала),
    // sinceUpdated — курсор мутаций. Бросает TransportError при таймауте/ошибке.
    std::vector<StoredMessage> sync(
        const std::string &from,
        const std::string &token,
        const std::string &lastSeenId,
        std::int64_t sinceUpdated = 0,
        int timeoutMs = 3000);

    // Правка текста уже отправленного сообщения (только автор — проверяет шард).
    // Публикует ParvaneEvent<EditPayload> на msg.chat.edit.
    void editText(const std::string &from, const std::string &messageId,
                  const std::string &text, const std::string &token);

    // Удаление «у всех» (tombstone, только автор). msg.chat.delete.
    void deleteMessage(const std::string &from, const std::string &messageId,
                       const std::string &token);

    // Отметка о прочтении (получателем). msg.chat.read → read-галочка ✓✓.
    void markRead(const std::string &from, const std::string &messageId,
                  const std::string &token);

    // Подписка на msg.chat.delivered. handler(message_id) зовётся на каждое
    // событие доставки (для всех сообщений шины — фильтрацию делает вызывающий).
    void onDelivered(std::function<void(std::string)> handler);

    // Нулевой uuid — курсор "с самого начала" для sync.
    static const char *zeroCursor() {
        return "00000000-0000-0000-0000-000000000000";
    }

private:
    Transport &_t;
};

} // namespace parvane
