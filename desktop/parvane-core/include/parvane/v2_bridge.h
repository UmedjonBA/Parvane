// Parvane fork: мост «запросы клиента → методы v2» (spec 007 T134, spec 029). Клиенты исторически говорят
// с сервером запросами вида subject + JSON (вход, регистрация, профили, поиск, 2FA, пароль, линковка,
// превью, тайлы карты, ICE, удаление файла): мост реализует ITransport и выполняет их методами протокола
// v2 (v2_control.h), отдавая ответ в прежнем виде — вызывающий код не меняется. Протокола v1 нет: запрос
// без метода v2 — TransportError, публикация — ничего. Переписка, группы и звонки идут v2-сессией.
//
// Текста ошибок в протоколе v2 нет (только код): мост подставляет в поле `error` ответа прежние
// формулировки сервера по методу и коду — на них завязаны экраны входа.
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
    // ID-01: доказательство ключа устройства для `identity.session.issue` (как web `setSessionProof`):
    // {"proof": base64, "tsMs": n} по сохранённому состоянию движка; null — устройства ещё нет (сервер
    // требует доказательство только от устройства, уже действующего в журнале).
    std::function<nlohmann::json(const std::string &user, const std::string &deviceId)> sessionProof;
};

class BridgeTransport : public ITransport {
public:
    explicit BridgeTransport(BridgeConfig cfg);
    ~BridgeTransport() override;

    std::string request(const std::string &subject, const std::string &payload,
                        std::int64_t timeout_ms) override;
    void publish(const std::string &subject, const std::string &payload) override;
    void requestMany(const std::string &subject, const std::string &payload,
                     const ReplyHandler &onReply, std::int64_t timeout_ms) override;
    void subscribe(const std::string &subject, Handler handler) override;

    // Соединение управления (канал ID) под токеном моста либо запроса.
    [[nodiscard]] Control &control(const std::string &requestToken = std::string());

private:
    // nullopt — subject мостом не обслуживается.
    bool viaV2(const std::string &subject, const nlohmann::json &payload, std::string *reply);
    [[nodiscard]] nlohmann::json describe();

    BridgeConfig cfg_;
    std::mutex mu_;
    std::string token_; // последний токен: из конфигурации либо из запроса
    std::unique_ptr<Control> control_;
    nlohmann::json described_; // кэш server.describe
    std::mutex handlersMu_;
    std::multimap<std::string, Handler> handlers_; // подписки (событий v1 нет — не зовутся)
};

} // namespace parvane::v2
