// Parvane fork: см. storecrypt.h. OpenSSL 3 EVP, AES-256-GCM.
#include "parvane/storecrypt.h"

#include "parvane/linking.h" // b64encode/b64decode/randomBytes

#include <openssl/evp.h>
#include <openssl/sha.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <sstream>

namespace parvane::storecrypt {
namespace {

constexpr int kIvLen = 12;
constexpr int kTagLen = 16;
constexpr size_t kMagicLen = sizeof(kMagic) - 1;
const std::string kLinePrefix = std::string(kMagic) + ":";

std::mutex g_mu;
std::string g_key; // 32 байта или пусто
bool g_required = false; // NAT-13: без ключа не писать открытым текстом

// Ограда записи (NAT-16): писатели держат её разделяемо на время всей записи, blockWrites — исключительно.
std::shared_mutex g_fenceMu;
bool g_blocked = false; // под g_fenceMu

struct CipherDel {
    void operator()(EVP_CIPHER_CTX *p) const { EVP_CIPHER_CTX_free(p); }
};

std::string keyCopy() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_key;
}

// nonce || ct || tag (без магии)
std::optional<std::string> gcmSeal(const std::string &key, const std::string &plain) {
    const auto iv = linking::randomBytes(kIvLen);
    if (iv.size() != static_cast<size_t>(kIvLen)) {
        return std::nullopt;
    }
    std::unique_ptr<EVP_CIPHER_CTX, CipherDel> c(EVP_CIPHER_CTX_new());
    if (!c || EVP_EncryptInit_ex(c.get(), EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1
        || EVP_CIPHER_CTX_ctrl(c.get(), EVP_CTRL_GCM_SET_IVLEN, kIvLen, nullptr) != 1
        || EVP_EncryptInit_ex(c.get(), nullptr, nullptr,
               reinterpret_cast<const unsigned char *>(key.data()),
               reinterpret_cast<const unsigned char *>(iv.data())) != 1) {
        return std::nullopt;
    }
    std::string out(plain.size() + kTagLen, '\0');
    int len = 0, total = 0;
    if (!plain.empty()
        && EVP_EncryptUpdate(c.get(), reinterpret_cast<unsigned char *>(out.data()), &len,
               reinterpret_cast<const unsigned char *>(plain.data()),
               static_cast<int>(plain.size())) != 1) {
        return std::nullopt;
    }
    total = len;
    if (EVP_EncryptFinal_ex(c.get(), reinterpret_cast<unsigned char *>(out.data()) + total, &len) != 1) {
        return std::nullopt;
    }
    total += len;
    if (EVP_CIPHER_CTX_ctrl(c.get(), EVP_CTRL_GCM_GET_TAG, kTagLen,
            reinterpret_cast<unsigned char *>(out.data()) + total) != 1) {
        return std::nullopt;
    }
    out.resize(static_cast<size_t>(total + kTagLen));
    return iv + out;
}

std::optional<std::string> gcmOpen(const std::string &key, const std::string &blob) {
    if (blob.size() < static_cast<size_t>(kIvLen + kTagLen)) {
        return std::nullopt;
    }
    const std::string iv = blob.substr(0, kIvLen);
    const std::string body = blob.substr(kIvLen, blob.size() - kIvLen - kTagLen);
    std::string tag = blob.substr(blob.size() - kTagLen);
    std::unique_ptr<EVP_CIPHER_CTX, CipherDel> c(EVP_CIPHER_CTX_new());
    if (!c || EVP_DecryptInit_ex(c.get(), EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1
        || EVP_CIPHER_CTX_ctrl(c.get(), EVP_CTRL_GCM_SET_IVLEN, kIvLen, nullptr) != 1
        || EVP_DecryptInit_ex(c.get(), nullptr, nullptr,
               reinterpret_cast<const unsigned char *>(key.data()),
               reinterpret_cast<const unsigned char *>(iv.data())) != 1) {
        return std::nullopt;
    }
    std::string out(body.size() + 16, '\0');
    int len = 0, total = 0;
    if (!body.empty()
        && EVP_DecryptUpdate(c.get(), reinterpret_cast<unsigned char *>(out.data()), &len,
               reinterpret_cast<const unsigned char *>(body.data()),
               static_cast<int>(body.size())) != 1) {
        return std::nullopt;
    }
    total = len;
    if (EVP_CIPHER_CTX_ctrl(c.get(), EVP_CTRL_GCM_SET_TAG, kTagLen, tag.data()) != 1) {
        return std::nullopt;
    }
    if (EVP_DecryptFinal_ex(c.get(), reinterpret_cast<unsigned char *>(out.data()) + total, &len) != 1) {
        return std::nullopt;
    }
    total += len;
    out.resize(static_cast<size_t>(total));
    return out;
}

std::string rawRead(const std::string &path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        return {};
    }
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

bool rawWriteUnfenced(const std::string &path, std::string_view data) {
    const auto tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (!f) {
            return false;
        }
        f.write(data.data(), static_cast<std::streamsize>(data.size()));
        if (!f) {
            return false;
        }
    }
    std::error_code ec;
    std::filesystem::permissions(tmp,
        std::filesystem::perms::owner_read | std::filesystem::perms::owner_write,
        std::filesystem::perm_options::replace, ec);
    std::filesystem::rename(tmp, path, ec);
    if (ec) {
        std::filesystem::remove(tmp, ec);
        return false;
    }
    return true;
}

bool rawWrite(const std::string &path, std::string_view data) {
    std::shared_lock<std::shared_mutex> fence(g_fenceMu);
    return !g_blocked && rawWriteUnfenced(path, data);
}

} // namespace

void setKey(const std::string &key32) {
    std::lock_guard<std::mutex> lk(g_mu);
    g_key = (key32.size() == 32) ? key32 : std::string();
}

bool enabled() {
    std::lock_guard<std::mutex> lk(g_mu);
    return !g_key.empty();
}

void setRequired(bool value) {
    std::lock_guard<std::mutex> lk(g_mu);
    g_required = value;
}

bool required() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_required;
}

namespace {

// Запечатать для записи на диск: nullopt — писать нельзя (обязательное шифрование, а ключа нет или
// шифр отказал). Без обязательного шифрования — прежнее поведение seal()/sealLine().
std::optional<std::string> sealForDisk(const std::string &plain, bool line) {
    std::string key;
    bool mandatory = false;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        key = g_key;
        mandatory = g_required;
    }
    if (key.empty()) {
        if (mandatory) return std::nullopt;
        return plain;
    }
    const auto sealed = gcmSeal(key, plain);
    if (!sealed) {
        if (mandatory) return std::nullopt;
        return plain; // RAND/EVP отказали — не теряем данные, но и не врём о шифровании
    }
    return line ? kLinePrefix + linking::b64encode(*sealed) : std::string(kMagic) + '\0' + *sealed;
}

} // namespace

std::string deriveKey(const std::string &secret) {
    const std::string input = "parvane-store-v1" + secret;
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char *>(input.data()), input.size(), digest);
    return std::string(reinterpret_cast<const char *>(digest), sizeof(digest));
}

// Бинарный формат: "PVSE1" + '\0' + iv(12) + ct + tag(16). Разделитель '\0'
// делает формат однозначным: раньше сразу после магии шёл случайный iv, и файл,
// чей iv начинался с ':', принимался за line-формат/plain (1/256 записей) —
// при миграции шифровался повторно и терялся. Старые бинарные файлы (без '\0')
// читаются по-прежнему.
bool isSealed(const std::string &blob) {
    return blob.size() > kMagicLen && blob.compare(0, kMagicLen, kMagic) == 0
        && blob[kMagicLen] != ':';
}

bool hasBinarySeparator(const std::string &blob) {
    return blob.size() > kMagicLen && blob[kMagicLen] == '\0';
}

std::string seal(const std::string &plain) {
    const auto key = keyCopy();
    if (key.empty()) {
        return plain;
    }
    const auto sealed = gcmSeal(key, plain);
    if (!sealed) {
        return plain; // RAND/EVP отказали — не теряем данные, но и не врём о шифровании
    }
    return std::string(kMagic) + '\0' + *sealed;
}

std::optional<std::string> open(const std::string &blob) {
    if (!isSealed(blob)) {
        return blob; // legacy plain
    }
    const auto key = keyCopy();
    if (key.empty()) {
        return std::nullopt;
    }
    return gcmOpen(key, blob.substr(hasBinarySeparator(blob) ? kMagicLen + 1 : kMagicLen));
}

std::string sealLine(const std::string &plain) {
    const auto key = keyCopy();
    if (key.empty()) {
        return plain;
    }
    const auto sealed = gcmSeal(key, plain);
    if (!sealed) {
        return plain;
    }
    return kLinePrefix + linking::b64encode(*sealed);
}

std::optional<std::string> openLine(const std::string &line) {
    if (line.compare(0, kLinePrefix.size(), kLinePrefix) != 0) {
        return line; // legacy plain
    }
    const auto key = keyCopy();
    if (key.empty()) {
        return std::nullopt;
    }
    const auto raw = linking::b64decode(line.substr(kLinePrefix.size()));
    if (!raw) {
        return std::nullopt;
    }
    return gcmOpen(key, *raw);
}

std::string readFile(const std::string &path) {
    const auto blob = rawRead(path);
    if (blob.empty()) {
        return {};
    }
    return open(blob).value_or(std::string());
}

bool writeFile(const std::string &path, const std::string &data) {
    const auto sealed = sealForDisk(data, /*line=*/false);
    return sealed && rawWrite(path, *sealed);
}

// Строки файла-журнала в любом исторически возможном виде. Журналы с именем не
// *.jsonl (список v2-сообщений, журнал прочитанного READ-1, отметки очищенных
// чатов) старая миграция принимала за обычный файл и запечатывала ЦЕЛИКОМ, а
// appendLine потом дописывал строки следом за двоичным блобом — такой файл
// читался как мусор, записи терялись при каждом рестарте (2 окт 2026).
std::vector<std::string> linesOf(const std::string &blob) {
    std::string text;
    if (isSealed(blob)) {
        std::optional<std::string> head = open(blob);
        size_t tailAt = blob.size();
        if (!head) {
            // Целиком запечатанная голова + дописанные строки: граница — первое
            // вхождение префикса строки, до которого блоб проходит проверку GCM.
            for (auto p = blob.find(kLinePrefix, kMagicLen + 1); p != std::string::npos;
                 p = blob.find(kLinePrefix, p + 1)) {
                if (auto part = open(blob.substr(0, p))) {
                    head = std::move(part);
                    tailAt = p;
                    break;
                }
            }
        }
        if (!head) {
            return {};
        }
        text = std::move(*head);
        if (!text.empty() && text.back() != '\n') {
            text += '\n';
        }
        text += blob.substr(tailAt);
    } else {
        text = blob;
    }
    std::vector<std::string> out;
    std::istringstream in(text);
    std::string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (line.empty()) {
            continue;
        }
        if (auto plain = openLine(line)) {
            out.push_back(std::move(*plain));
        }
    }
    return out;
}

std::vector<std::string> readLines(const std::string &path) {
    return linesOf(rawRead(path));
}

bool appendLine(const std::string &path, const std::string &line) {
    const auto sealed = sealForDisk(line, /*line=*/true);
    if (!sealed) {
        return false;
    }
    std::shared_lock<std::shared_mutex> fence(g_fenceMu);
    if (g_blocked) {
        return false;
    }
    std::ofstream f(path, std::ios::binary | std::ios::app);
    if (!f) {
        return false;
    }
    f << *sealed << '\n';
    std::error_code ec;
    std::filesystem::permissions(path,
        std::filesystem::perms::owner_read | std::filesystem::perms::owner_write,
        std::filesystem::perm_options::replace, ec);
    return static_cast<bool>(f);
}

bool writeLines(const std::string &path, const std::vector<std::string> &lines) {
    std::string data;
    for (const auto &line : lines) {
        const auto sealed = sealForDisk(line, /*line=*/true);
        if (!sealed) {
            return false;
        }
        data += *sealed;
        data += '\n';
    }
    return rawWrite(path, data);
}

int migrateFile(const std::string &path) {
    if (!enabled()) {
        return 0;
    }
    const auto blob = rawRead(path);
    if (blob.empty()) {
        return 0;
    }
    const bool jsonl = path.size() > 6 && path.compare(path.size() - 6, 6, ".jsonl") == 0;
    if (jsonl) {
        bool anyPlain = false;
        std::istringstream in(blob);
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.compare(0, kLinePrefix.size(), kLinePrefix) != 0) {
                anyPlain = true;
                break;
            }
        }
        if (!anyPlain) {
            return 0;
        }
        return writeLines(path, readLines(path)) ? 1 : 0;
    }
    // Журнал с именем не *.jsonl узнаём по содержимому: в нём есть запечатанные строки.
    const bool hasLines = blob.find(kLinePrefix) != std::string::npos;
    if (isSealed(blob)) {
        if (!hasLines || open(blob)) {
            return 0; // обычный запечатанный файл
        }
        // Запечатанная целиком голова + дописанные строки — чиним в построчный вид.
        const auto lines = linesOf(blob);
        return (!lines.empty() && writeLines(path, lines)) ? 1 : 0;
    }
    if (hasLines) {
        bool anyPlain = false;
        std::istringstream in(blob);
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.compare(0, kLinePrefix.size(), kLinePrefix) != 0) {
                anyPlain = true;
                break;
            }
        }
        return (anyPlain && writeLines(path, readLines(path))) ? 1 : 0;
    }
    const auto sealed = sealForDisk(blob, /*line=*/false);
    return (sealed && rawWrite(path, *sealed)) ? 1 : 0;
}

int migrateDir(const std::string &dir, const std::string &skipPrefix) {
    if (!enabled() || dir.empty()) {
        return 0;
    }
    int n = 0;
    std::error_code ec;
    // Сначала собираем список, потом переписываем: rename tmp→файл во время
    // обхода каталога заставляет readdir пропускать записи (файл оставался plain).
    std::vector<std::string> files;
    for (const auto &entry : std::filesystem::directory_iterator(dir, ec)) {
        if (!entry.is_regular_file(ec)) {
            continue;
        }
        const auto name = entry.path().filename().string();
        if (!skipPrefix.empty() && name.rfind(skipPrefix, 0) == 0) {
            continue;
        }
        if (name.size() > 4 && name.compare(name.size() - 4, 4, ".tmp") == 0) {
            continue;
        }
        files.push_back(entry.path().string());
    }
    for (const auto &path : files) {
        n += migrateFile(path);
    }
    return n;
}

int removePrefixed(const std::string &dir, const std::string &prefix, const std::vector<std::string> &keep,
                   std::vector<std::string> *failed) {
    if (dir.empty() || prefix.empty()) {
        return 0;
    }
    std::error_code ec;
    std::vector<std::filesystem::path> victims;
    for (const auto &entry : std::filesystem::directory_iterator(dir, ec)) {
        const auto name = entry.path().filename().string();
        if (name.rfind(prefix, 0) != 0 || std::find(keep.begin(), keep.end(), name) != keep.end()) {
            continue;
        }
        victims.push_back(entry.path());
    }
    int n = 0;
    for (const auto &path : victims) {
        std::error_code rc;
        // symlink_status: ссылка удаляется сама, без перехода по ней
        const auto st = std::filesystem::symlink_status(path, rc);
        if (std::filesystem::is_directory(st)) {
            std::filesystem::remove_all(path, rc);
        } else {
            std::filesystem::remove(path, rc);
        }
        std::error_code check;
        const bool left = std::filesystem::symlink_status(path, check).type() != std::filesystem::file_type::not_found;
        if (rc || left) {
            if (failed) failed->push_back(path.filename().string());
        } else {
            ++n;
        }
    }
    return n;
}

void blockWrites() {
    std::unique_lock<std::shared_mutex> fence(g_fenceMu); // ждёт идущие записи
    g_blocked = true;
}

void allowWrites() {
    std::unique_lock<std::shared_mutex> fence(g_fenceMu);
    g_blocked = false;
}

bool writesBlocked() {
    std::shared_lock<std::shared_mutex> fence(g_fenceMu);
    return g_blocked;
}

bool writeRawFile(const std::string &path, std::string_view data) {
    return rawWrite(path, data);
}

} // namespace parvane::storecrypt
