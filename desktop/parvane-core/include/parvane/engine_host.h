// Parvane fork (spec 035, contracts/engine-api.md): хост модели движка в ядре desktop/android — единственная точка
// вызова `pv_engine_*`. Движок sans-IO: каждый вызов возвращает `Outcome` (пачка хранилища, чтения, запросы
// серверу, изменения модели), хост исполняет его в обязательном порядке:
//   1. `store_reads` — прочитать из `store_fs` и отдать `storeLoaded` (итог — снова в цикл);
//   2. `store_batch` — зафиксировать ОДНОЙ транзакцией `store_fs` (fsync файла и каталога) ДО отправки
//      `requests` того же итога («на диске раньше подтверждения», SYNC-1, OPT-024);
//   3. `requests` — отдать вызывающему по порядку (отправка — его дело, ответ — обратно через `ingest`);
//   4. после фиксации — `storeCommitted{batch_id}`: движок выпускает подтверждения, зависевшие от пачки.
// Хост ничего не разбирает: изменения модели (`ModelDelta`) и запросы отдаются как есть (proto3-JSON).
// Ввода-вывода сети нет — шаг возвращает запросы, отправляет их вызывающий (вне своих мьютексов).
// Потокобезопасен (один мьютекс на движок и хранилище).
#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/store_fs.h"

struct PvEngine;

namespace parvane::engine {

using nlohmann::json;

// Итог одного шага хоста (вызов движка и всё, что из него последовало).
struct Step {
    std::vector<json> changes;          // ModelChange по порядку
    std::vector<std::uint64_t> revisions;
    std::vector<json> requests;         // OutRequest по порядку (уже после фиксации своих пачек)
    std::vector<std::string> putKinds;  // виды записей зафиксированных пачек (`g<n>/<вид>/<имя>` → вид)
    std::size_t batches = 0;            // зафиксировано пачек
    json open;                          // OpenResult, если был
    std::string error;                  // ошибка движка или носителя; пусто — успех
    [[nodiscard]] bool ok() const { return error.empty(); }
};

class Host {
public:
    // Открыть движок (`config` — EngineConfig: user, device_id, domain, features, now_ms, device_key base64, …) над
    // хранилищем в каталоге `storeDir` (создаётся) и выполнить `start` до открытия профиля. nullptr — ошибка.
    static std::unique_ptr<Host> open(const json &config, const std::string &storeDir, std::string *error = nullptr,
                                      store_fs::FsOps &fs = store_fs::posixFs(), Step *opened = nullptr);
    ~Host();
    Host(const Host &) = delete;
    Host &operator=(const Host &) = delete;

    // Вызов, меняющий модель (`submit`, `ingest`, `tick`, `storeCommitted`, `vectorInput`, …), с исполнением итога.
    Step step(const std::string &name, const json &args);
    Step submit(const json &intent) { return step("submit", intent); }
    Step ingest(const json &input) { return step("ingest", input); }
    Step tick(std::int64_t nowMs) { return step("tick", json{{"now_ms", std::to_string(nowMs)}}); }

    // Чтение (`historyPage`, `chatList`, `viewState`, `viewGroup`, `capabilities`, `engineInfo`). Ответ
    // `{pending: store_reads}` хост дочитывает сам и повторяет вызов. Ошибка — `{"error": вид}`.
    json read(const std::string &name, const json &args);

    // Сырой вызов без исполнения итога (тесты): разобранный JSON ответа.
    json raw(const std::string &name, const json &args);

    [[nodiscard]] std::uint64_t revision() const;
    [[nodiscard]] const store_fs::Store &store() const { return *store_; }
    [[nodiscard]] std::uint64_t commits() const;  // зафиксировано пачек за жизнь хоста

private:
    Host(PvEngine *e, std::unique_ptr<store_fs::Store> s) : e_(e), store_(std::move(s)) {}
    json callLocked(const std::string &name, const json &args);
    void driveLocked(json outcome, Step &st);

    PvEngine *e_ = nullptr;
    std::unique_ptr<store_fs::Store> store_;
    mutable std::mutex mu_;
    std::uint64_t revision_ = 0;
    std::uint64_t commits_ = 0;
};

// Вид записи из ключа носителя `g<n>/<вид>/<имя>` (`root` → "root").
[[nodiscard]] std::string kindOfKey(const std::string &key);

} // namespace parvane::engine
