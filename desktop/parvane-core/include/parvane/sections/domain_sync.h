// Parvane fork (spec 029, T029/T033/T034): общий слой синхронизации разделов («План», «Облако», «Знания») с
// сервером — домены `parvane.planner.v1` и `cloud.v1` шарда domains, блобы cloud, журнал личного состояния.
// Порт того, что в web дают `controller.ts` и зависимости `createPlannerSync`/`createCloudSync`
// (`api/parvane/v2/planner.ts`, `cloud.ts`): вызов движка по имени WASM, запрос шины, персист движка, хранилище
// записей (в web — IndexedDB), «сейчас». Реализацию подставляет сессия (`parvane::v2::Session`) либо тест.
//
// Отличия от web по устройству (поведение то же):
// - вызовы синхронные (блокирующие): вызывающий держит модуль в одном рабочем потоке — это и есть `serial()` web;
// - таймеры (пакет правок 1,5/10 с, опрос 8/60 с, повтор 15 с) — сроки на явном «сейчас»: вызывающий зовёт
//   `tick()` не позже `nextWakeMs()`; браузерных событий (`visibilitychange`, `pagehide`) нет — их заменяют
//   `setVisible()`/`flush()` модулей;
// - предел ожидания ответа (CALL_TIMEOUT_MS web = 20 с) — забота транспорта (у сессии — 15 с на запрос).
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::sections::domain {

using nlohmann::json;

// Ошибка шины (web `V2Error`): код сервера `ERROR_CODE_*`. Ошибка движка — любое другое исключение (кода нет).
class BusError : public std::runtime_error {
public:
    explicit BusError(std::string code) : std::runtime_error("v2: " + code), code_(std::move(code)) {}
    [[nodiscard]] const std::string &code() const { return code_; }

private:
    std::string code_;
};

// Код ошибки шины; не ошибка шины — пусто (web `errorCode` → undefined)
std::optional<std::string> errorCode(const std::exception &e);
// Текст ошибки как `String(e)` web (для lastError и журнала): у ошибки шины — "v2: <код>"
std::string errorText(const std::exception &e);

// Запрос, который движок просит выполнить (`{chan, method, body, dest?}`, тело — base64 в JSON движка)
struct OutRequest {
    bool anon = false;
    std::string method;
    std::string body; // байты
    std::string dest; // домен сервера объекта; "" — свой
    static OutRequest fromJson(const json &r);
};

// Транспорт разделов: то, что web получает из controller.ts.
class DomainTransport {
public:
    virtual ~DomainTransport() = default;
    // Вызов движка по имени WASM (`Client::call`, backend/protocol/src/host/call.rs): аргументы — объект JSON,
    // байты в обе стороны — base64. Ошибка движка — исключение (не BusError).
    virtual json engine(const std::string &name, const json &args) = 0;
    // То же, но с удовлетворением «нужд» движка (журналы устройств собеседников и т. п.) — web `withNeeds`
    virtual json engineWithNeeds(const std::string &name, const json &args) { return engine(name, args); }
    // Запрос шины по каналу ("id" — anon=false, "anon" — anon=true): тело и ответ — байты. dest — сервер
    // объекта (spec 028); пусто — свой. Отказ сервера — BusError.
    virtual std::string request(bool anon, const std::string &method, const std::string &body,
                                const std::string &dest) = 0;
    // Тело по ИМЕНИ МЕТОДА реестра (proto3-JSON → байты) и ответ (байты → proto3-JSON): `pv.encodeMethodRequest`,
    // `pv.decodeMethodResponse` web. Отдельными методами, чтобы поддельный транспорт обходился без кодека.
    virtual std::string encodeMethod(const std::string &method, const json &value) = 0;
    virtual json decodeMethod(const std::string &method, const std::string &bytes) = 0;
    // Движок есть (web `deps.client()`), стек поднят (`isReady`), устройству нужна линковка
    virtual bool hasClient() = 0;
    virtual bool isReady() = 0;
    virtual bool needsLinking() = 0;
    // Свой адрес и домен своего сервера
    virtual std::string self() { return {}; }
    virtual std::string serverDomain() { return {}; }
    // Сохранить состояние движка (web `persistUrgent`, у сессии — `persistLocked`)
    virtual void persist() = 0;
    // «Сейчас», мс эпохи (Date.now() web)
    virtual std::int64_t nowMs() = 0;
    virtual void log(const std::string &message) {}
};

// Хранилище записей устройства (web: `storage.loadRecord/saveRecord/deleteRecord`, IndexedDB). Сохранять между
// запусками — забота вызывающего (MemoryRecords::toJson).
class RecordStore {
public:
    virtual ~RecordStore() = default;
    virtual std::optional<json> load(const std::string &key) = 0;
    virtual void save(const std::string &key, const json &value) = 0;
    virtual void remove(const std::string &key) = 0;
};

// Записи в памяти; всё содержимое — одним JSON-объектом (ключ → значение) для сохранения на диск.
class MemoryRecords : public RecordStore {
public:
    MemoryRecords() = default;
    explicit MemoryRecords(const json &saved);
    std::optional<json> load(const std::string &key) override;
    void save(const std::string &key, const json &value) override;
    void remove(const std::string &key) override;
    [[nodiscard]] json toJson() const { return all_; }

private:
    json all_ = json::object();
};

// ── служебное ──────────────────────────────────────────────────────────────────

std::string toBase64(const std::string &bytes);
// Негодный base64 — исключение std::invalid_argument
std::string fromBase64(const std::string &b64);
std::string hexToB64(const std::string &hex);
std::string b64ToHex(const std::string &b64);

// Выполнить запрос движка (один либо массив)
std::string runRequest(DomainTransport &t, const OutRequest &r);
void runRequests(DomainTransport &t, const json &reqs);

// web `pollDelay` без режима L2 (такты L2 — забота сессии)
inline std::int64_t pollDelay(std::int64_t fastMs, std::int64_t slowMs, bool isFast) {
    return isFast ? fastMs : slowMs;
}

// Таймер на явном «сейчас» (замена setTimeout): срок либо нет.
struct Deadline {
    std::optional<std::int64_t> at;
    void set(std::int64_t when) { at = when; }
    void clear() { at.reset(); }
    [[nodiscard]] bool armed() const { return at.has_value(); }
    // Срок наступил — снять и вернуть true
    bool fire(std::int64_t now) {
        if (!at || *at > now) return false;
        at.reset();
        return true;
    }
};

// Ближайший срок из нескольких (нет ни одного — nullopt)
std::optional<std::int64_t> earliest(std::initializer_list<const Deadline *> list);

} // namespace parvane::sections::domain
