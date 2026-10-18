// Parvane fork (spec 029, фаза 4): ZIP STORE потоком — порт web `publicLink/zip.ts` (байт в байт тот же формат)
// с проверками web `export/exportZip.ts` (повтор пути, отмена, предел без ZIP64).
#include "parvane/sections/export_zip.h"

#include <array>

#include "unicode_lite.h"

namespace parvane::sections::exportdata {

namespace u = parvane::sections::unicode_lite;

namespace {

constexpr uint32_t kLocalSig = 0x04034b50;
constexpr uint32_t kDescriptorSig = 0x08074b50;
constexpr uint32_t kCentralSig = 0x02014b50;
constexpr uint32_t kEndSig = 0x06054b50;
constexpr uint16_t kVersion = 20;
constexpr uint16_t kFlags = 0x0808;
constexpr uint64_t kLocalBytes = 30;
constexpr uint64_t kDescriptorBytes = 16;
constexpr uint64_t kCentralBytes = 46;
constexpr uint64_t kEndBytes = 22;
constexpr uint64_t kMaxOffset = 0xFFFFFFFFULL;
constexpr uint32_t kDirAttr = 0x10;

const std::array<uint32_t, 256> &crcTable() {
    static const auto table = [] {
        std::array<uint32_t, 256> t{};
        for (uint32_t n = 0; n < 256; ++n) {
            uint32_t c = n;
            for (int k = 0; k < 8; ++k) c = (c & 1) ? 0xEDB88320U ^ (c >> 1) : c >> 1;
            t[n] = c;
        }
        return t;
    }();
    return table;
}

void le16(std::string &out, uint32_t v) {
    out.push_back(static_cast<char>(v & 0xFF));
    out.push_back(static_cast<char>((v >> 8) & 0xFF));
}

void le32(std::string &out, uint64_t v) {
    for (int i = 0; i < 4; ++i) out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
}

void dosDateTime(const ZipTime &at, uint16_t &time, uint16_t &date) {
    time = static_cast<uint16_t>((at.hour << 11) | (at.minute << 5) | (at.second / 2));
    date = static_cast<uint16_t>((std::max(0, at.year - 1980) << 9) | (at.month << 5) | at.day);
}

} // namespace

const char *exportErrorCodeName(ExportErrorCode code) {
    switch (code) {
    case ExportErrorCode::Canceled: return "canceled";
    case ExportErrorCode::TooLarge: return "too-large";
    case ExportErrorCode::Failed: return "failed";
    }
    return "failed";
}

ExportError::ExportError(ExportErrorCode code, const std::string &message)
    : std::runtime_error(message.empty() ? exportErrorCodeName(code) : message), code_(code) {}

uint32_t crc32(std::string_view bytes, uint32_t crc) {
    const auto &table = crcTable();
    uint32_t c = crc ^ 0xFFFFFFFFU;
    for (const char ch : bytes) c = table[(c ^ static_cast<unsigned char>(ch)) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFU;
}

bool canZip(const std::vector<ZipSizedEntry> &entries) {
    if (entries.size() >= kZipMaxEntries) return false;
    uint64_t total = kEndBytes;
    for (const auto &e : entries) {
        total += kLocalBytes + kDescriptorBytes + kCentralBytes + e.name.size() * 2 + e.size;
        if (total > kMaxOffset) return false;
    }
    return total <= kMaxOffset;
}

std::string archiveFileName(std::string_view title) {
    constexpr size_t kMax = 120;
    // Знаки, которых не бывает в именах файлов Windows/macOS, и управляющие — пробелом; пробелы — одним
    std::u32string base;
    bool space = false;
    for (char32_t c : u::decode(title)) {
        const bool bad = c == U'\\' || c == U'/' || c == U':' || c == U'*' || c == U'?' || c == U'"' || c == U'<'
            || c == U'>' || c == U'|' || c < 0x20 || c == 0x7F;
        if (bad || u::isJsSpace(c)) {
            space = true;
            continue;
        }
        if (space) base.push_back(U' ');
        space = false;
        base.push_back(c);
    }
    if (space) base.push_back(U' ');
    base = u::trim32(base);
    if (base.size() >= 4) {
        std::u32string tail = base.substr(base.size() - 4);
        for (auto &c : tail) c = u::lower(c);
        if (tail == U".zip") base.erase(base.size() - 4);
    }
    if (base.size() > kMax) base.resize(kMax);
    size_t a = 0, b = base.size();
    while (a < b && (base[a] == U'.' || u::isJsSpace(base[a]))) ++a;
    while (b > a && (base[b - 1] == U'.' || u::isJsSpace(base[b - 1]))) --b;
    base = base.substr(a, b - a);
    return (base.empty() ? std::string("parvane") : u::encode(base)) + ".zip";
}

ZipWriter::ZipWriter(Sink out, ZipTime at, std::function<bool()> canceled)
    : out_(std::move(out)), at_(at), canceled_(std::move(canceled)) {}

void ZipWriter::put(const std::string &bytes) {
    if (out_ && !bytes.empty()) out_(reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size());
    offset_ += bytes.size();
}

void ZipWriter::checkCanceled() const {
    if (canceled_ && canceled_()) throw ExportError(ExportErrorCode::Canceled);
}

void ZipWriter::begin(const std::string &path, bool isDir, std::optional<ZipTime> mtime, uint64_t size) {
    checkCanceled();
    if (finished_) throw ExportError(ExportErrorCode::Failed, "zip: archive is finished");
    if (isOpen_) throw ExportError(ExportErrorCode::Failed, "zip: previous entry is not closed");
    const std::string name = isDir ? path + "/" : path;
    if (paths_.count(name)) throw ExportError(ExportErrorCode::Failed, "duplicate path " + path);
    if (name.size() > 0xFFFF) throw ExportError(ExportErrorCode::Failed, "zip: name is too long");
    if (entries_.size() + 1 >= kZipMaxEntries) throw ExportError(ExportErrorCode::TooLarge);
    if (offset_ + size > kZipMaxBytes) throw ExportError(ExportErrorCode::TooLarge);
    paths_.insert(name);
    Entry entry;
    entry.name = name;
    entry.offset = offset_;
    entry.isDir = isDir;
    dosDateTime(mtime.value_or(at_), entry.time, entry.date);
    std::string head;
    head.reserve(kLocalBytes + name.size());
    le32(head, kLocalSig);
    le16(head, kVersion);
    le16(head, kFlags);
    le16(head, 0); // STORE
    le16(head, entry.time);
    le16(head, entry.date);
    le32(head, 0); // CRC и размеры — в дескрипторе после данных
    le32(head, 0);
    le32(head, 0);
    le16(head, static_cast<uint32_t>(name.size()));
    le16(head, 0);
    head += name;
    entries_.push_back(entry);
    put(head);
}

void ZipWriter::addDir(const std::string &path, std::optional<ZipTime> mtime) {
    begin(path, true, mtime, 0);
    isOpen_ = true;
    closeFile();
}

void ZipWriter::beginFile(const std::string &path, std::optional<ZipTime> mtime) {
    begin(path, false, mtime, 0);
    isOpen_ = true;
}

void ZipWriter::write(std::string_view bytes) {
    if (!isOpen_) throw ExportError(ExportErrorCode::Failed, "zip: no open entry");
    checkCanceled();
    auto &entry = entries_.back();
    entry.crc = crc32(bytes, entry.crc);
    entry.size += bytes.size();
    put(std::string(bytes));
    if (offset_ > kZipMaxBytes || entry.size > kMaxOffset) throw ExportError(ExportErrorCode::TooLarge);
}

void ZipWriter::closeFile() {
    if (!isOpen_) throw ExportError(ExportErrorCode::Failed, "zip: no open entry");
    isOpen_ = false;
    const auto &entry = entries_.back();
    std::string tail;
    le32(tail, kDescriptorSig);
    le32(tail, entry.crc);
    le32(tail, entry.size);
    le32(tail, entry.size);
    put(tail);
}

void ZipWriter::addBytes(const std::string &path, std::string_view bytes, std::optional<ZipTime> mtime) {
    begin(path, false, mtime, bytes.size());
    isOpen_ = true;
    write(bytes);
    closeFile();
}

void ZipWriter::addChunks(const std::string &path, const ChunkSource &next, std::optional<ZipTime> mtime) {
    beginFile(path, mtime);
    std::string chunk;
    while (true) {
        checkCanceled();
        chunk.clear();
        if (!next || !next(chunk)) break;
        if (!chunk.empty()) write(chunk);
    }
    closeFile();
}

void ZipWriter::finish() {
    checkCanceled();
    if (isOpen_) throw ExportError(ExportErrorCode::Failed, "zip: previous entry is not closed");
    if (finished_) throw ExportError(ExportErrorCode::Failed, "zip: archive is finished");
    const uint64_t start = offset_;
    for (const auto &entry : entries_) {
        std::string head;
        head.reserve(kCentralBytes + entry.name.size());
        le32(head, kCentralSig);
        le16(head, kVersion);
        le16(head, kVersion);
        le16(head, kFlags);
        le16(head, 0); // STORE
        le16(head, entry.time);
        le16(head, entry.date);
        le32(head, entry.crc);
        le32(head, entry.size);
        le32(head, entry.size);
        le16(head, static_cast<uint32_t>(entry.name.size()));
        le16(head, 0); // extra
        le16(head, 0); // комментарий
        le16(head, 0); // диск
        le16(head, 0); // внутренние атрибуты
        le32(head, entry.isDir ? kDirAttr : 0);
        le32(head, entry.offset);
        head += entry.name;
        put(head);
    }
    if (offset_ > kMaxOffset) throw ExportError(ExportErrorCode::TooLarge);
    std::string end;
    le32(end, kEndSig);
    le16(end, 0);
    le16(end, 0);
    le16(end, static_cast<uint32_t>(entries_.size()));
    le16(end, static_cast<uint32_t>(entries_.size()));
    le32(end, offset_ - start);
    le32(end, start);
    le16(end, 0);
    put(end);
    finished_ = true;
}

} // namespace parvane::sections::exportdata
