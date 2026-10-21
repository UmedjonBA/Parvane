// Parvane fork: см. local_files.h.
#include "parvane/local_files.h"

#include "parvane/linking.h" // randomBytes
#include "parvane/storecrypt.h"

#include <algorithm>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>

#include <sys/stat.h>
#include <unistd.h>

namespace fs = std::filesystem;

namespace parvane::localfiles {
namespace {

constexpr auto kOwnerOnly = fs::perms::owner_all;

bool validKind(const std::string &kind) {
    if (kind.empty() || kind.size() > 32) return false;
    return std::all_of(kind.begin(), kind.end(), [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
    });
}

// Каталог 0700: создать, если нет; существующий — только настоящий каталог (не ссылка), права — 0700.
bool ensurePrivateDir(const fs::path &dir) {
    std::error_code ec;
    const auto st = fs::symlink_status(dir, ec);
    if (st.type() == fs::file_type::not_found) {
        if (!fs::create_directory(dir, ec) && ec) return false;
    } else if (st.type() != fs::file_type::directory) {
        return false; // ссылка или файл на месте каталога — не идём по ней
    }
    fs::permissions(dir, kOwnerOnly, fs::perm_options::replace, ec);
    return !ec;
}

std::string hex(const std::string &bytes) {
    static const char digits[] = "0123456789abcdef";
    std::string out;
    out.reserve(bytes.size() * 2);
    for (const auto ch : bytes) {
        const auto b = static_cast<unsigned char>(ch);
        out += digits[b >> 4];
        out += digits[b & 15];
    }
    return out;
}

} // namespace

const std::vector<std::string> &legacySharedTempNames() {
    static const std::vector<std::string> names = {
        "parvane-media", "parvane-article", "parvane-cloud", "parvane-embed", "parvane-paste",
    };
    return names;
}

std::string tempRoot(const std::string &tdataDir) {
    if (tdataDir.empty()) return {};
    return (fs::path(tdataDir) / kTempName).string();
}

std::string tempKindDir(const std::string &tdataDir, const std::string &kind) {
    if (tdataDir.empty() || !validKind(kind) || storecrypt::writesBlocked()) return {};
    std::error_code ec;
    if (!fs::is_directory(tdataDir, ec)) return {};
    const auto root = fs::path(tempRoot(tdataDir));
    const auto dir = root / kind;
    if (!ensurePrivateDir(root) || !ensurePrivateDir(dir)) return {};
    return dir.string();
}

std::string makeTempDir(const std::string &tdataDir, const std::string &kind) {
    const auto parent = tempKindDir(tdataDir, kind);
    if (parent.empty()) return {};
    const auto rnd = linking::randomBytes(12);
    if (rnd.size() != 12) return {};
    const auto dir = fs::path(parent) / hex(rnd);
    std::error_code ec;
    if (!fs::create_directory(dir, ec)) return {};
    fs::permissions(dir, kOwnerOnly, fs::perm_options::replace, ec);
    return ec ? std::string() : dir.string();
}

bool wipeTempRoot(const std::string &tdataDir) {
    const auto root = tempRoot(tdataDir);
    if (root.empty()) return false;
    std::error_code ec;
    const auto st = fs::symlink_status(root, ec);
    if (st.type() == fs::file_type::not_found) return true;
    if (fs::is_directory(st)) {
        fs::remove_all(root, ec);
    } else {
        fs::remove(root, ec); // ссылка — сама ссылка
    }
    std::error_code check;
    return fs::symlink_status(root, check).type() == fs::file_type::not_found;
}

int removeLegacySharedTemp(const std::string &sharedTmp, std::vector<std::string> *failed) {
    if (sharedTmp.empty()) return 0;
    const auto uid = ::geteuid();
    int n = 0;
    for (const auto &name : legacySharedTempNames()) {
        const auto path = fs::path(sharedTmp) / name;
        struct stat st {};
        if (::lstat(path.c_str(), &st) != 0) continue; // нет — нечего стирать
        if (st.st_uid != uid) continue;                // чужой (другой пользователь) — не наш
        std::error_code ec;
        if (S_ISDIR(st.st_mode)) {
            fs::remove_all(path, ec);
        } else {
            fs::remove(path, ec);
        }
        std::error_code check;
        if (ec || fs::symlink_status(path, check).type() != fs::file_type::not_found) {
            if (failed) failed->push_back(name);
        } else {
            ++n;
        }
    }
    return n;
}

bool setLogoutPending(const std::string &tdataDir) {
    if (tdataDir.empty()) return false;
    const auto path = fs::path(tdataDir) / kLogoutMarkerName;
    // Маркер — не данные аккаунта: пишется мимо ограды и без шифрования (ключ к этому моменту может быть сброшен)
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    f << "1";
    f.close();
    std::error_code ec;
    fs::permissions(path, fs::perms::owner_read | fs::perms::owner_write, fs::perm_options::replace, ec);
    return static_cast<bool>(f) || fs::exists(path, ec);
}

bool logoutPending(const std::string &tdataDir) {
    if (tdataDir.empty()) return false;
    std::error_code ec;
    return fs::exists(fs::path(tdataDir) / kLogoutMarkerName, ec);
}

WipeResult wipeAccountData(const std::string &tdataDir, const std::vector<std::string> &keep) {
    WipeResult result;
    if (tdataDir.empty()) return result;
    storecrypt::blockWrites();
    auto keepAll = keep;
    keepAll.push_back(kLogoutMarkerName);
    result.removed = storecrypt::removePrefixed(tdataDir, "parvane-", keepAll, &result.failed);
    result.tempWiped = wipeTempRoot(tdataDir);
    storecrypt::setKey(std::string());
    if (result.failed.empty() && result.tempWiped) {
        std::error_code ec;
        fs::remove(fs::path(tdataDir) / kLogoutMarkerName, ec);
    }
    return result;
}

} // namespace parvane::localfiles

namespace parvane::logpriv {
namespace {

struct Ring {
    std::mutex mu;
    std::deque<std::string> lines;
    bool dev = false;
};

// Не разрушается: строки журнала пишутся и из статических деструкторов
Ring &ring() {
    static auto *r = new Ring();
    return *r;
}

} // namespace

void setDevBuild(bool dev) {
    auto &r = ring();
    std::lock_guard<std::mutex> lk(r.mu);
    r.dev = dev;
}

bool devBuild() {
    auto &r = ring();
    std::lock_guard<std::mutex> lk(r.mu);
    return r.dev;
}

bool isClientLine(const std::string &line) {
    return line.rfind("Parvane", 0) == 0;
}

bool keepOnDisk(const std::string &line, bool debugMode) {
    return !isClientLine(line) || debugMode || devBuild();
}

std::string secret(const std::string &value) {
    if (devBuild()) return value;
    return "<скрыто, " + std::to_string(value.size()) + " Б>";
}

void remember(const std::string &line) {
    auto &r = ring();
    std::lock_guard<std::mutex> lk(r.mu);
    r.lines.push_back(line);
    while (r.lines.size() > kRingCapacity) r.lines.pop_front();
}

std::vector<std::string> recent() {
    auto &r = ring();
    std::lock_guard<std::mutex> lk(r.mu);
    return {r.lines.begin(), r.lines.end()};
}

void forget() {
    auto &r = ring();
    std::lock_guard<std::mutex> lk(r.mu);
    r.lines.clear();
}

} // namespace parvane::logpriv
