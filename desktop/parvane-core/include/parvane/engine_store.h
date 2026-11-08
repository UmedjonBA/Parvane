// Parvane fork (spec 035 T048, contracts/storage.md): хранилище движка в ядре desktop/android — замена
// `storecrypt` (один ключ на все файлы, AAD без контекста, запись без `fsync`). Записи `Stored` под DEK
// поколения с AAD по `store_id` профиля шифрует и открывает движок (`pv_store_*`, C ABI); на диск их кладёт
// файловый адаптер `store_fs` (каталог `store/` профиля, пачка — атомарно, `fsync` файла и каталога).
//
// DEK — под обёрткой ключа устройства: тот же 32-байтовый ключ, что ядро получает сейчас для `storecrypt`
// (desktop — производная локального ключа tdata под паскодом, android — ключ под Android Keystore). Смена
// ключа устройства — смена обёртки одной пачкой корня (`rewrapDevice`), записи не перешифровываются; смена
// самого DEK — перенос поколения P1–P6 (`rotate`), переживающий прерывание на любом шаге.
//
// Переезд вызовов `storecrypt::*` на этот класс — вместе с сессией на `pv_engine_*` (T125), удаление
// `storecrypt` — T129.
#pragma once

#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "parvane/store_fs.h"

struct PvStoreHandle;

namespace parvane::engine_store {

class EngineStore {
public:
    // Открыть (создать) профиль в каталоге `dir` ключом устройства (ровно 32 байта). nullptr — ошибка
    // (*error): ключ не тот, формат новее известного, испорченный носитель.
    static std::unique_ptr<EngineStore> open(const std::string &dir, const std::string &deviceKey32,
                                             std::string *error = nullptr,
                                             store_fs::FsOps &fs = store_fs::posixFs());
    ~EngineStore();
    EngineStore(const EngineStore &) = delete;
    EngineStore &operator=(const EngineStore &) = delete;

    // Записать/удалить (одна пачка — одна транзакция носителя). `kind` — вид из store_kinds движка
    // (`engine-core`, `history-row`, `state-object`, …), `name` — ключ записи.
    bool put(const std::string &kind, const std::string &name, const std::string &value, std::string *error = nullptr);
    bool write(const std::vector<std::tuple<std::string, std::string, std::string>> &puts,
               const std::vector<std::pair<std::string, std::string>> &deletes, std::string *error = nullptr);
    bool remove(const std::string &kind, const std::string &name, std::string *error = nullptr);
    [[nodiscard]] std::optional<std::string> get(const std::string &kind, const std::string &name) const;
    // Записи вида с префиксом имени: (имя, значение) по возрастанию имени.
    [[nodiscard]] std::vector<std::pair<std::string, std::string>> list(const std::string &kind,
                                                                       const std::string &prefix = "") const;

    // Новый ключ устройства (сменился ключ ОС/паскод): обёртка DEK — одной пачкой корня, записи не трогаются.
    bool rewrapDevice(const std::string &deviceKey32, std::string *error = nullptr);
    // Смена DEK поколением (P1–P6) до конца; при отказе записи — откат, активным остаётся прежнее поколение.
    bool rotate(std::string *error = nullptr);

    [[nodiscard]] uint32_t activeGeneration() const;
    [[nodiscard]] std::string state() const;  // ready | locked | too_new
    [[nodiscard]] const std::string &dir() const { return fs_->dir(); }

private:
    EngineStore(std::unique_ptr<store_fs::Store> fs, PvStoreHandle *h) : fs_(std::move(fs)), h_(h) {}
    bool commitLocked(const std::string &batchJson, std::string *error);
    std::string infoLocked() const;

    std::unique_ptr<store_fs::Store> fs_;
    PvStoreHandle *h_ = nullptr;
    mutable std::mutex mu_;
};

}  // namespace parvane::engine_store
