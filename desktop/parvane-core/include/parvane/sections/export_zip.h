// Parvane fork (spec 029, фаза 4): потоковая запись ZIP для «Выгрузки данных» (web `export/exportZip.ts`) в
// формате ZIP «Скачать всё» страницы ссылки (web `publicLink/zip.ts`): без сжатия (STORE), заголовок файла
// уходит до содержимого, CRC-32 и размер считаются на лету и пишутся дескриптором после него (флаг 3), имена —
// UTF-8 (флаг 11). Без ZIP64: архив и каждый файл — до 4 ГиБ, элементов меньше 65 535.
//
// Отличие от web-выгрузки: web сжимает тексты (fflate, DEFLATE); здесь всё STORE (без zlib) — архив крупнее,
// содержимое то же. Ошибки — исключение `ExportError` с кодом, как в web.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace parvane::sections::exportdata {

enum class ExportErrorCode { Canceled, TooLarge, Failed };
// "canceled" | "too-large" | "failed"
const char *exportErrorCodeName(ExportErrorCode code);

class ExportError : public std::runtime_error {
public:
    explicit ExportError(ExportErrorCode code, const std::string &message = {});
    ExportErrorCode code() const { return code_; }

private:
    ExportErrorCode code_;
};

// Потолок ZIP без ZIP64 с запасом на заголовки и центральный каталог (как web `ZIP_MAX_BYTES`)
inline constexpr uint64_t kZipMaxBytes = 0xFFFFFFFFULL - 64ULL * 1024 * 1024;
inline constexpr uint32_t kZipMaxEntries = 0xFFFF;

// CRC-32 (IEEE, как zlib); `crc` — значение по предыдущим кускам
uint32_t crc32(std::string_view bytes, uint32_t crc = 0);

struct ZipSizedEntry {
    std::string name;
    uint64_t size = 0;
};
// Уместятся ли файлы (открытые размеры) с именами в ZIP без ZIP64 (web `canZip`)
bool canZip(const std::vector<ZipSizedEntry> &entries);

// Имя архива «Скачать всё» по названию ссылки (web `archiveFileName`): без запрещённых знаков, не длиннее 120
// знаков до `.zip`; пустое — `parvane.zip`
std::string archiveFileName(std::string_view title);

// Местное время элемента архива (DOS-время хранит местное; часовой пояс выбирает вызывающий)
struct ZipTime {
    int year = 1980, month = 1, day = 1, hour = 0, minute = 0, second = 0;
};

class ZipWriter {
public:
    using Sink = std::function<void(const uint8_t *data, size_t size)>;
    // Следующий кусок файла: true и данные в `chunk`; false — конец
    using ChunkSource = std::function<bool(std::string &chunk)>;

    // `canceled` проверяется перед каждым файлом и куском (как AbortSignal в web)
    ZipWriter(Sink out, ZipTime at = {}, std::function<bool()> canceled = {});

    // Папка без файлов: элемент `путь/` нулевой длины
    void addDir(const std::string &path, std::optional<ZipTime> mtime = {});
    // Файл кусками: begin → write… → close; следующий файл — только после close
    void beginFile(const std::string &path, std::optional<ZipTime> mtime = {});
    void write(std::string_view bytes);
    void closeFile();
    // Целиком (web `addText`)
    void addBytes(const std::string &path, std::string_view bytes, std::optional<ZipTime> mtime = {});
    // Потоком из источника (web `addBlob`)
    void addChunks(const std::string &path, const ChunkSource &next, std::optional<ZipTime> mtime = {});
    // Оглавление и конец архива
    void finish();

    // Байт архива уже записано
    uint64_t bytes() const { return offset_; }
    // Файлов в архиве
    size_t count() const { return entries_.size(); }

private:
    struct Entry {
        std::string name;
        uint32_t crc = 0;
        uint64_t size = 0;
        uint64_t offset = 0;
        bool isDir = false;
        uint16_t time = 0;
        uint16_t date = 0;
    };

    void put(const std::string &bytes);
    void checkCanceled() const;
    void begin(const std::string &path, bool isDir, std::optional<ZipTime> mtime, uint64_t size);

    Sink out_;
    ZipTime at_;
    std::function<bool()> canceled_;
    std::vector<Entry> entries_;
    std::set<std::string> paths_;
    uint64_t offset_ = 0;
    bool isOpen_ = false;
    bool finished_ = false;
};

} // namespace parvane::sections::exportdata
