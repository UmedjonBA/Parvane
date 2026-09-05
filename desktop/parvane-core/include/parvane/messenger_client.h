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
    explicit MessengerClient(ITransport &transport) : _t(transport) {}

    // Публикует ПОЛНЫЙ ParvaneEvent<SendPayload> на msg.chat.send.
    // Возвращает сгенерированный id события (= id сообщения для последующего
    // сопоставления с msg.chat.delivered). reply_to — id родителя или nullopt.
    std::string sendText(
        const std::string &from,
        const std::string &to,
        const std::string &text,
        const std::string &token,
        const std::optional<std::string> &replyTo = std::nullopt,
        // Если задан — используется как id сообщения (корреляция с локальным эхом
        // на клиенте для delete/edit/read своих). Иначе генерируется uuid7.
        const std::optional<std::string> &id = std::nullopt,
        // Форматирование (жирный/курсив/код/…) — массив entities (offset/length/
        // type в UTF-16, как в Telegram). Пустой = обычный текст.
        const json &entities = json::array(),
        // Превью ссылки (OG-метаданные) — объект {url,site_name,title,description}
        // или null. Кладётся в content.webpage.
        const json &webpage = json());

    // Как sendText, но content — произвольный MessageContent (медиа, Фаза 4).
    // contentJson должен быть валидным вариантом MessageContent (tag "kind":
    // photo/voice/video/video_note/file), иначе messenger-шард отвергнет send.
    // Возвращает id события/сообщения. Медиа-блоб грузится в cloud ОТДЕЛЬНО
    // (CloudClient), сюда идёт только file_id + метаданные.
    std::string sendContent(
        const std::string &from,
        const std::string &to,
        const json &contentJson,
        const std::string &token,
        const std::optional<std::string> &replyTo = std::nullopt,
        // Если задан — используется как id сообщения (корреляция с локальным эхом,
        // как в sendText). Иначе генерируется uuid7.
        const std::optional<std::string> &id = std::nullopt,
        // Мультидевайс: per-device копии шифртекста (MessageDeviceCopy[]).
        const json &copies = json::array());

    // Подписанный sync (мультидевайс): device_id, signing_key + подпись строки
    // SyncRequestPayload::signedPayload(), доказанные ключи прежних устройств.
    struct SyncAuth {
        std::string device_id;
        std::string signing_key;
        // signer(data) → подпись base64; extra(data) → [(key, sig)] legacy.
        std::function<std::string(const std::string &)> signer;
        std::function<std::vector<std::pair<std::string, std::string>>(const std::string &)> extra;
    };

    // Опрашивает msg.sync.request (request/reply, полный конверт) и возвращает
    // сообщения после курсоров. lastSeenId — id-курсор (нулевой uuid = с начала),
    // sinceUpdated — курсор мутаций. Бросает TransportError при таймауте/ошибке.
    std::vector<StoredMessage> sync(
        const std::string &from,
        const std::string &token,
        const std::string &lastSeenId,
        std::int64_t sinceUpdated = 0,
        int timeoutMs = 3000,
        const SyncAuth *auth = nullptr);

    // Правка текста уже отправленного сообщения (только автор — проверяет шард).
    // Публикует ParvaneEvent<EditPayload> на msg.chat.edit.
    void editText(const std::string &from, const std::string &messageId,
                  const std::string &text, const std::string &token);

    // E2E-правка: новый зашифрованный content + подпись `edit:<id>:<ciphertext>`
    // ключом устройства (sealed-сообщения) + per-device копии.
    void editContent(const std::string &from, const std::string &messageId,
                     const json &content, const std::string &signature,
                     const json &copies, const std::string &token);

    // Удаление «у всех» (tombstone, только автор). msg.chat.delete. Для sealed —
    // signature над `delete:<id>`.
    void deleteMessage(const std::string &from, const std::string &messageId,
                       const std::string &token, const std::string &signature = {});

    // Отметка о прочтении (получателем). msg.chat.read → read-галочка ✓✓.
    void markRead(const std::string &from, const std::string &messageId,
                  const std::string &token);

    // Реакция на сообщение (msg.chat.react). Пустой emoji — снять свою.
    // signature над `react:<id>:<emoji>` — для своих sealed-сообщений.
    void react(const std::string &from, const std::string &messageId,
               const std::string &emoji, const std::string &token,
               const std::string &signature = {});

    // Закрепить/открепить сообщение (msg.chat.pin). signature над
    // `pin:<id>:<true|false>` — для своих sealed-сообщений.
    void pin(const std::string &from, const std::string &messageId,
             bool pinned, const std::string &token, const std::string &signature = {});
    // Кто прочитал сообщение (msg.chat.readers): (адрес, unix ts). Только
    // участнику переписки; пусто при ошибке. signature над `readers:<id>` —
    // для своих sealed-сообщений (автора сервер иначе не знает).
    std::vector<std::pair<std::string, std::int64_t>> readers(
        const std::string &from, const std::string &messageId,
        const std::string &token, const std::string &signature = {},
        int timeoutMs = 3000);

    // Подписка на СВОЙ инбокс msg.user.<self> — delivered-подтверждения (Фаза 1:
    // приходят, когда получатель подтвердил приём). handler(message_id).
    void onDelivered(const std::string &self, std::function<void(std::string)> handler);

    // Подписка на СВОЙ инбокс — входящие сообщения (InboxPush, Фаза 1). handler
    // получает готовый StoredMessage; вставку/дедуп и ack делает вызывающий.
    void onInbox(const std::string &self, std::function<void(StoredMessage)> handler);

    // Подтвердить приём сообщения (msg.chat.ack): снимает из очереди на сервере
    // и триггерит delivered отправителю. `sender` — адрес отправителя (для
    // sealed sender, где у сообщения нет открытого from; пусто — обычный путь).
    void ack(const std::string &from, const std::string &messageId,
             const std::string &token, const std::string &sender = std::string());

    // Нулевой uuid — курсор "с самого начала" для sync.
    static const char *zeroCursor() {
        return "00000000-0000-0000-0000-000000000000";
    }

private:
    ITransport &_t;
};

} // namespace parvane
