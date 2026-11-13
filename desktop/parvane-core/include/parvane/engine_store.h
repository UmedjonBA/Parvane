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

#include <functional>
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

// spec 036 T031 (T048 spec 035): файлы хоста (сессия, доверие, кэши, настройки — всё, что ядро и клиент держали
// файлами storecrypt) — записями вида `host-file` хранилища движка: шифрует движок (DEK под ключом устройства, AAD
// по профилю), на диск — пачкой `store_fs` (атомарно, fsync). Разовый перенос прежнего файла storecrypt —
// `migrateFrom`: отметка `migrated:<имя>` и данные — одной пачкой, сверка чтением, затем прежний файл
// переименовывается в `<путь>.migrated` (данные не теряются: до сверки прежний файл не трогается; прерывание на
// любом шаге — перенос повторяется при следующем открытии). Испорченный прежний файл — копией в карантин
// (`quarantine`, `host-file/<имя>`), прежний — в `<путь>.quarantined`, остальное переносится.
class HostFiles {
public:
    static std::unique_ptr<HostFiles> open(const std::string &dir, const std::string &deviceKey32,
                                           std::string *error = nullptr, store_fs::FsOps &fs = store_fs::posixFs());

    [[nodiscard]] std::optional<std::string> read(const std::string &name) const;
    bool write(const std::string &name, const std::string &data, std::string *error = nullptr);
    bool remove(const std::string &name, std::string *error = nullptr);
    // Имена файлов с префиксом (без отметок переноса).
    [[nodiscard]] std::vector<std::string> names(const std::string &prefix = "") const;
    [[nodiscard]] bool migrated(const std::string &name) const;

    enum class Moved {
        Already,     // перенесён раньше (прежний файл, если остался, переименован сейчас)
        Missing,     // прежнего файла нет — переносить нечего
        Moved,       // перенесён и сверен
        Quarantined, // прежний не открылся (порча, чужой ключ) — в карантине, отметка поставлена
        Failed,      // запись или сверка не удались — прежний файл на месте, повтор при следующем вызове
    };
    // Перенести файл storecrypt `path` (целиком; `.jsonl` — построчно, строки через '\n') под имя `name`.
    // Ключ storecrypt — установленный (`storecrypt::setKey`).
    Moved migrateFrom(const std::string &name, const std::string &path, std::string *error = nullptr);

private:
    HostFiles(std::unique_ptr<EngineStore> s, store_fs::FsOps &fs) : store_(std::move(s)), fs_(fs) {}
    std::unique_ptr<EngineStore> store_;
    store_fs::FsOps &fs_;
};

// spec 036 T036: файлы каталога хоста по ПУТИ (android: файлы шва, сессия, доверие, владелец, служебное журнала
// истории) — записями `HostFiles` в `<dir>/host-files` под именем «путь относительно каталога»; прежний файл
// storecrypt по этому пути переносится один раз при первом обращении (`migrateFrom`). Хранилище не открылось (нет
// ключа, сбой носителя) или путь вне каталога — прежний путь storecrypt (данные не теряются). Потокобезопасно.
class PathFiles {
public:
    using Log = std::function<void(const std::string &)>;
    // deviceKey32 — ключ устройства (тот же, что у storecrypt); пустой — хранилище не открывается (прежний путь).
    PathFiles(std::string dir, std::string deviceKey32, Log log = nullptr);
    [[nodiscard]] std::string read(const std::string &path);
    [[nodiscard]] bool exists(const std::string &path);
    bool write(const std::string &path, const std::string &data);
    void remove(const std::string &path);
    // Закрыть хранилище (каталог стирается — открытое не должно его пережить); следующее обращение откроет заново.
    void reset();
    // Имя записи для пути (относительно каталога); вне каталога и внутри `host-files/` — nullopt.
    [[nodiscard]] std::optional<std::string> nameOf(const std::string &path) const;

private:
    HostFiles *openLocked();
    bool migratedLocked(HostFiles &hf, const std::string &name, const std::string &path);
    std::string dir_;
    std::string key_;
    Log log_;
    std::mutex mu_;
    std::unique_ptr<HostFiles> hf_;
    bool tried_ = false;
};

}  // namespace parvane::engine_store
