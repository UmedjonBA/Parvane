// Parvane fork (spec 035, contracts/storage.md, FR-028): файловый адаптер хранилища движка — общий для
// desktop и android. Движок sans-IO выпускает пачки `store_batch` (одна атомарная транзакция) и чтения
// `store_reads`; адаптер хранит словарь «ключ → байты» в каталоге `store/` профиля:
//   pack-<seq>.bin   — упакованный снимок всех записей на момент пачки <seq>;
//   batch-<seq>.bin  — пачка журнала после упаковки (применяются по возрастанию <seq>);
//   *.tmp            — недописанный файл (удаляется при открытии).
// Каждый файл пишется во временный, затем `fsync` файла, `fsync` каталога, `rename`, `fsync` каталога —
// пачка либо есть целиком, либо её нет (прерывание на любом шаге). Испорченный файл (контрольная сумма)
// — ошибка открытия, а не тихая потеря. Ключ — строка UTF-8, порядок — по байтам ключа.
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace parvane::store_fs {

// Слой ФС — подменяется в тестах (порядок fsync/rename, отказ на любом шаге).
struct FsOps {
    virtual ~FsOps() = default;
    // O_WRONLY|O_CREAT|O_TRUNC, права 0600; -1 — ошибка.
    virtual int openWrite(const std::string &path) = 0;
    // O_WRONLY|O_CREAT|O_APPEND, права 0600 (дозапись журналов storecrypt); -1 — ошибка либо не поддержано.
    virtual int openAppend(const std::string &) { return -1; }
    virtual bool writeAll(int fd, const void *data, size_t n) = 0;
    virtual bool fsyncFd(int fd) = 0;
    virtual bool closeFd(int fd) = 0;
    virtual bool fsyncDir(const std::string &dir) = 0;
    virtual bool rename(const std::string &from, const std::string &to) = 0;
    virtual bool remove(const std::string &path) = 0;
    virtual std::optional<std::string> readFile(const std::string &path) = 0;
    // Имена файлов каталога (без путей).
    virtual std::vector<std::string> list(const std::string &dir) = 0;
    virtual bool mkdirs(const std::string &dir) = 0;
};

// Настоящая ФС (POSIX).
FsOps &posixFs();
// ФС в памяти (модель движка без профиля: тесты, разовые проверки); ничего не переживает процесс.
std::unique_ptr<FsOps> memoryFs();

struct Put {
    std::string key;
    std::string value;
};

struct Batch {
    std::vector<Put> puts;
    std::vector<std::string> deletes;
};

struct Reads {
    std::vector<std::string> keys;  // только существующие, в порядке запроса
    std::string prefix;             // ключи с префиксом строго после after, по возрастанию
    std::string after;
    uint32_t limit = 0;              // 0 — без предела
    bool all = false;                // всё содержимое (тесты, перенос)
};

class Store {
public:
    // Открыть (создать) каталог хранилища. nullptr — ошибка (текст в *error).
    static std::unique_ptr<Store> open(const std::string &dir, FsOps &fs = posixFs(), std::string *error = nullptr);

    // Зафиксировать пачку (сначала deletes, затем puts) долговечно; false — пачки нет (на диске и в памяти).
    bool commit(const Batch &batch, std::string *error = nullptr);
    std::vector<Put> read(const Reads &reads) const;
    // Упаковать журнал в снимок (вызывается и сама — после kPackEvery пачек).
    bool pack(std::string *error = nullptr);

    // Граница движка — proto3-JSON типов `parvane.engine.v1` (StoreBatch / StoreReads → StoreLoaded).
    bool commitJson(const std::string &batchJson, std::string *error = nullptr);
    std::string readJson(const std::string &readsJson) const;

    size_t journalFiles() const { return journal_.size(); }
    const std::string &dir() const { return dir_; }

    static constexpr size_t kPackEvery = 64;

private:
    Store(std::string dir, FsOps &fs) : dir_(std::move(dir)), fs_(fs) {}
    bool load(std::string *error);
    bool writeDurable(const std::string &name, const std::string &bytes, std::string *error);

    std::string dir_;
    FsOps &fs_;
    std::map<std::string, std::string> kv_;
    uint64_t seq_ = 0;                 // последняя зафиксированная пачка
    std::vector<uint64_t> journal_;    // пачки после последней упаковки
    uint64_t packSeq_ = 0;             // seq последней упаковки (0 — нет)
};

}  // namespace parvane::store_fs
