// Parvane fork: мост «запросы клиента → методы v2» (spec 007, T134/T168).
// Клиенты (tdesktop, Android) исторически говорят с сервером запросами v1:
// subject + JSON. Мост реализует тот же ITransport, но всё, что НЕ переписка,
// уводит в методы протокола v2 (v2_control.h) и возвращает ответ в прежнем
// виде — вызывающий код не меняется, а по проводу v1 для этих запросов не
// используется. С мостом клиент работает при `PARVANE_V1_MODE=disabled`:
// соединение v1 (inner) тогда отсутствует.
//
// Три класса subject'ов:
//   - «по v2»: вход, регистрация и подтверждения, профили, поиск, 2FA, смена
//     пароля, линковка, превью, тайлы карты, ICE, удаление файла — всегда v2;
//   - «v1, если жив»: то, что обслуживает v1-шифрование и каталог v1-устройств
//     (`identity.prekeys.*`, `identity.user.setkey`, `identity.device.list`,
//     `identity.device.revoke`) — по v1, а без него: список и отзыв устройств —
//     методами v2, `setkey` — пустой успех, прекеи — ошибка транспорта;
//   - остальное (переписка v1, группы v1, сигналы звонка v1, присутствие v1) —
//     только через inner; без него запрос бросает TransportError, публикация и
//     подписка молча ничего не делают.
// Блобы (загрузка/скачивание) уводит не мост, а CloudClient — через control().
//
// Текста ошибок в протоколе v2 нет (только код): мост подставляет в поле
// `error` ответа прежние формулировки сервера по методу и коду — на них
// завязаны экраны входа.
#pragma once

#include <map>
#include <memory>
#include <mutex>
#include <string>

#include <nlohmann/json.hpp>

#include "parvane/itransport.h"
#include "parvane/v2_control.h"

namespace parvane::v2 {

struct BridgeConfig {
    // ws://…/ws, wss://…/ws или host:port (TCP с преамбулой PVN2).
    std::string gatewayUrl;
    // JWT сессии; пуст — транспорт до входа (доступны только методы канала PRE,
    // для остальных берётся `token` из тела запроса).
    std::string token;
    std::string clientVersion = "desktop";
    std::function<void(const std::string &)> log;
};

class BridgeTransport : public ITransport {
public:
    // inner — соединение v1 или nullptr (сервер отключил v1).
    BridgeTransport(BridgeConfig cfg, std::unique_ptr<ITransport> inner);
    ~BridgeTransport() override;

    std::string request(const std::string &subject, const std::string &payload,
                        std::int64_t timeout_ms) override;
    void publish(const std::string &subject, const std::string &payload) override;
    void requestMany(const std::string &subject, const std::string &payload,
                     const ReplyHandler &onReply, std::int64_t timeout_ms) override;
    void subscribe(const std::string &subject, Handler handler) override;

    [[nodiscard]] bool hasV1() const { return inner_ != nullptr; }
    [[nodiscard]] ITransport *inner() const { return inner_.get(); }
    // Подать кадр подписчикам subject'а, как если бы он пришёл по v1. Нужно для
    // записей `LegacyV1` инбокса v2: сервер кладёт в них кадры инбокса v1
    // (история при первом синке и живые кадры), а без соединения v1 это
    // единственный путь, которым они доходят (FR-053).
    void deliver(const std::string &subject, const std::string &payload);
    // Соединение управления (канал ID) под токеном моста либо запроса.
    [[nodiscard]] Control &control(const std::string &requestToken = std::string());

private:
    // nullopt — subject мостом не обслуживается.
    bool viaV2(const std::string &subject, const nlohmann::json &payload, std::string *reply);
    [[nodiscard]] nlohmann::json describe();

    BridgeConfig cfg_;
    std::unique_ptr<ITransport> inner_;
    std::mutex mu_;
    std::string token_; // последний токен: из конфигурации либо из запроса
    std::unique_ptr<Control> control_;
    nlohmann::json described_; // кэш server.describe
    std::mutex handlersMu_;
    std::multimap<std::string, Handler> handlers_; // подписки — для deliver()
};

} // namespace parvane::v2
