// Parvane fork: методы управления по протоколу v2 (spec 007, T134/T168) —
// всё, что раньше шло JSON-соединением v1 и не является перепиской: вход и
// регистрация, профили, поиск, устройства, линковка, 2FA, файлы без
// capability (аватары, фото групп, блобы линковки), превью, тайлы, ICE.
// С этим слоем клиент работает при `PARVANE_V1_MODE=disabled`.
//
// Два вида вызовов:
//   - preauth(): до входа. Одноразовое соединение Hello → Welcome → Request
//     (gateway пускает на него только методы канала PRE и закрывает через
//     10 с без Auth — опрос подтверждения регистрации идёт новыми вызовами).
//   - Control: после входа. Своё соединение Hello → Auth(JWT), открывается при
//     первом вызове и переоткрывается после обрыва. Отдельное от соединения
//     сессии движка (v2_session.h): работает и когда устройство ещё ждёт
//     линковки, и пока сессия переподключается.
// Тела кодирует движок по имени метода (v2_engine.h encodeMethodRequest);
// запросы и ответы — proto3-JSON (имена полей как в схеме, в ответах — оба
// написания принимать через field()).
// Потоки: вызовы блокирующие (сеть) — не с UI-потока; объект потокобезопасен.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include <nlohmann/json.hpp>

namespace parvane::v2 {

using nlohmann::json;

class Connection;

struct ControlConfig {
    // ws://…/ws, wss://…/ws или host:port (TCP с преамбулой PVN2).
    std::string gatewayUrl;
    // Текущий JWT — зовётся при каждом (пере)подключении.
    std::function<std::string()> token;
    std::string clientVersion = "desktop";
    std::function<void(const std::string &)> log;
};

// Метод канала PRE без входа (`server.describe`, `identity.session.issue`,
// `identity.account.*`). Подпись дескриптора сервера проверяется. Бросает
// V2Error (код протокола) либо std::runtime_error (сеть, негодный ответ).
[[nodiscard]] json preauth(const std::string &gatewayUrl, const std::string &method, const json &request,
                           const std::string &clientVersion = "desktop", std::int64_t timeoutMs = 15000);

// Поле proto3-JSON в любом из двух написаний (camelCase / snake_case); null — нет.
[[nodiscard]] const json *field(const json &object, const char *camel, const char *snake);

class Control {
public:
    explicit Control(ControlConfig cfg);
    ~Control();
    Control(const Control &) = delete;
    Control &operator=(const Control &) = delete;

    // Метод реестра канала ID. Бросает V2Error / std::runtime_error.
    json call(const std::string &method, const json &request, std::int64_t timeoutMs = 15000);

    // Блоб без capability: владелец — этот аккаунт. `isPublic` — открытый
    // объект (аватар, фото группы), иначе доступен только владельцу (блоб
    // линковки своему устройству). Возвращает file_id.
    std::string uploadBlob(const std::string &bytes, bool isPublic, std::size_t chunkBytes = 512 * 1024);
    // Скачать блоб, доступный аккаунту: свой, открытый либо с v1-грантом.
    std::string downloadBlob(const std::string &fileId);
    void deleteBlob(const std::string &fileId);

    void close();

private:
    std::shared_ptr<Connection> connection(); // открыть при необходимости
    void drop(const std::shared_ptr<Connection> &c);
    void log(const std::string &m) const;

    ControlConfig cfg_;
    std::mutex mu_;
    std::shared_ptr<Connection> conn_;
};

} // namespace parvane::v2
