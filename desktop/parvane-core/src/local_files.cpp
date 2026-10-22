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
    bool content = false; // PARVANE_LOG_CONTENT=1 в dev-сборке (ревью 21 окт 2026)
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

void setLogContent(bool on) {
    auto &r = ring();
    std::lock_guard<std::mutex> lk(r.mu);
    r.content = on;
}

bool logContent() {
    auto &r = ring();
    std::lock_guard<std::mutex> lk(r.mu);
    return r.dev && r.content;
}

bool isClientLine(const std::string &line) {
    return line.rfind("Parvane", 0) == 0;
}

bool keepOnDisk(const std::string &line, bool debugMode) {
    return !isClientLine(line) || debugMode || devBuild();
}

std::string secret(const std::string &value) {
    if (logContent()) return value;
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

std::vector<std::string> reportLines() {
    // Строки с открытым содержимым из журнала не уходят никогда: в режиме PARVANE_LOG_CONTENT в них текст
    // сообщений, координаты, коды сверки — отчёт тогда без журнала (фильтр релиза поверх готовых строк
    // невозможен: содержимое уже подставлено).
    if (logContent()) {
        return {"<журнал не приложен: dev-сборка пишет содержимое в журнал (PARVANE_LOG_CONTENT=1)>"};
    }
    return recent();
}

void forget() {
    auto &r = ring();
    std::lock_guard<std::mutex> lk(r.mu);
    r.lines.clear();
}

} // namespace parvane::logpriv

namespace parvane::accountfiles {
namespace {

constexpr auto kOwnerOnly = fs::perms::owner_all;

bool asciiAlnum(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

bool validNick(const std::string &nick) {
    if (nick.empty() || nick.size() > 64) return false;
    if (!(asciiAlnum(nick[0]) || nick[0] == '_')) return false;
    if (nick.find("..") != std::string::npos) return false;
    return std::all_of(nick.begin(), nick.end(), [](char c) {
        return asciiAlnum(c) || c == '_' || c == '.' || c == '-';
    });
}

bool validHost(const std::string &host) {
    if (host.empty() || host.size() > 253) return false;
    std::size_t start = 0;
    while (start <= host.size()) {
        const auto dot = host.find('.', start);
        const auto label = host.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
        if (label.empty() || label.size() > 63 || label.front() == '-' || label.back() == '-') return false;
        if (!std::all_of(label.begin(), label.end(), [](char c) { return asciiAlnum(c) || c == '-'; })) {
            return false;
        }
        if (dot == std::string::npos) break;
        start = dot + 1;
    }
    return true;
}

bool validDomain(const std::string &domain) {
    const auto colon = domain.find(':');
    if (colon == std::string::npos) return validHost(domain);
    const auto port = domain.substr(colon + 1);
    if (port.empty() || port.size() > 5) return false;
    if (!std::all_of(port.begin(), port.end(), [](char c) { return c >= '0' && c <= '9'; })) return false;
    return validHost(domain.substr(0, colon));
}

fs::path markerPath(const std::string &tdataDir) {
    return fs::path(tdataDir) / kOwnerMarkerName;
}

bool writeMarker(const std::string &tdataDir, const std::string &address) {
    return storecrypt::writeFile(markerPath(tdataDir).string(), address);
}

bool present(const fs::path &path) {
    std::error_code ec;
    return fs::symlink_status(path, ec).type() != fs::file_type::not_found;
}

void removeEntry(const fs::path &path) {
    std::error_code ec;
    if (fs::is_directory(fs::symlink_status(path, ec))) {
        fs::remove_all(path, ec);
    } else {
        fs::remove(path, ec);
    }
}

// Перенести запись; на месте цели прежнее стирается. Не вышло — источник стирается (чужому не достаётся).
bool moveEntry(const fs::path &from, const fs::path &to) {
    if (present(to)) removeEntry(to);
    std::error_code ec;
    fs::rename(from, to, ec);
    if (!ec) return true;
    removeEntry(from);
    return false;
}

bool anyAccountFiles(const std::string &tdataDir) {
    for (const auto &name : accountFileNames()) {
        if (present(fs::path(tdataDir) / name)) return true;
    }
    return false;
}

// Установка до маркера: владелец — адрес журнала истории с самой свежей правкой, иначе — каталога состояния v2.
std::string guessLegacyOwner(const std::string &tdataDir) {
    const std::string historyPrefix = "parvane-history-";
    const std::string historySuffix = ".jsonl";
    const std::string v2Prefix = "parvane-v2-";
    auto best = std::string();
    auto bestTime = fs::file_time_type::min();
    auto bestDir = std::string();
    auto bestDirTime = fs::file_time_type::min();
    std::error_code ec;
    for (const auto &entry : fs::directory_iterator(tdataDir, ec)) {
        const auto name = entry.path().filename().string();
        std::error_code tc;
        const auto time = fs::last_write_time(entry.path(), tc);
        if (tc) continue;
        if (name.rfind(historyPrefix, 0) == 0 && name.size() > historyPrefix.size() + historySuffix.size()
            && name.compare(name.size() - historySuffix.size(), historySuffix.size(), historySuffix) == 0
            && entry.is_regular_file(tc)) {
            const auto safe = name.substr(historyPrefix.size(),
                                          name.size() - historyPrefix.size() - historySuffix.size());
            if (safe != "anon" && (best.empty() || time > bestTime)) {
                best = safe;
                bestTime = time;
            }
        } else if (name.rfind(v2Prefix, 0) == 0 && entry.is_directory(tc)) {
            const auto safe = name.substr(v2Prefix.size());
            if (safe.find('@') != std::string::npos && (bestDir.empty() || time > bestDirTime)) {
                bestDir = safe;
                bestDirTime = time;
            }
        }
    }
    return best.empty() ? bestDir : best;
}

} // namespace

bool isValidAddress(const std::string &address) {
    if (address.empty() || address.size() > 320) return false;
    const auto at = address.find('@');
    if (at == std::string::npos || address.find('@', at + 1) != std::string::npos) return false;
    return validNick(address.substr(0, at)) && validDomain(address.substr(at + 1));
}

std::string safePart(const std::string &address) {
    auto out = address;
    for (auto &c : out) {
        if (!(asciiAlnum(c) || c == '@' || c == '.' || c == '-')) c = '_';
    }
    return out;
}

const std::vector<std::string> &accountFileNames() {
    // Настройки устройства (фон, схема, язык, «звонки через сервер», ключ звонков, ширины панелей) сюда не входят
    static const std::vector<std::string> names = {
        "parvane-scheduled.json",   "parvane-v2-groups.json", "parvane-v2-ids.txt",
        "parvane-folders.json",     "parvane-blocked.json",   "parvane-dialogs.json",
        "parvane-notify.json",      "parvane-notify-journaled", "parvane-ttl.json",
        "parvane-read.txt",         "parvane-groups-seen.json", "parvane-drafts.json",
        "parvane-dec-cache.jsonl",  "parvane-renames.json",   "parvane-hidden-gifs.json",
        "parvane-privacy.json",     "parvane-l2.json",        "parvane-state-synced.json",
        "parvane-backup-done",      "parvane-media-cache",
    };
    return names;
}

std::string stashDir(const std::string &tdataDir, const std::string &safe) {
    if (tdataDir.empty() || safe.empty()) return {};
    return (fs::path(tdataDir) / ("parvane-v2-" + safe) / kStashDirName).string();
}

std::string owner(const std::string &tdataDir) {
    if (tdataDir.empty()) return {};
    return storecrypt::readFile(markerPath(tdataDir).string());
}

AdoptResult adopt(const std::string &tdataDir, const std::string &address) {
    AdoptResult result;
    if (tdataDir.empty() || !isValidAddress(address)) return result;
    const auto safe = safePart(address);
    const auto markerOwner = owner(tdataDir);
    auto ownerSafe = markerOwner.empty() ? std::string() : safePart(markerOwner);
    if (markerOwner.empty() && present(markerPath(tdataDir))) {
        // Маркер есть, но не читается (чужой ключ, порча): владелец неизвестен — считать чужим
        ownerSafe = "unknown";
    }
    if (ownerSafe.empty()) {
        if (!anyAccountFiles(tdataDir)) {
            writeMarker(tdataDir, address);
            return result;
        }
        const auto guess = guessLegacyOwner(tdataDir);
        result.legacy = true;
        if (guess.empty() || guess == safe) {
            writeMarker(tdataDir, address);
            return result;
        }
        ownerSafe = guess;
    }
    if (ownerSafe == safe) {
        if (markerOwner != address) writeMarker(tdataDir, address); // тот же аккаунт, адрес уточнён
        return result;
    }
    // Файлы прежнего владельца — в его каталог
    result.switched = true;
    result.previousOwner = ownerSafe;
    const auto away = fs::path(stashDir(tdataDir, ownerSafe));
    std::error_code ec;
    fs::create_directories(away, ec);
    fs::permissions(away.parent_path(), kOwnerOnly, fs::perm_options::replace, ec);
    fs::permissions(away, kOwnerOnly, fs::perm_options::replace, ec);
    for (const auto &name : accountFileNames()) {
        const auto from = fs::path(tdataDir) / name;
        if (!present(from)) continue;
        if (moveEntry(from, away / name)) {
            ++result.stashed;
        } else {
            result.failed.push_back(name);
        }
    }
    // Маркер — до возврата своих: не записался — свои не возвращаются (иначе следующий вход принял бы их за чужие)
    if (!writeMarker(tdataDir, address)) {
        result.failed.push_back(kOwnerMarkerName);
        return result;
    }
    const auto home = fs::path(stashDir(tdataDir, safe));
    for (const auto &name : accountFileNames()) {
        const auto from = home / name;
        if (!present(from)) continue;
        if (moveEntry(from, fs::path(tdataDir) / name)) {
            ++result.restored;
        } else {
            result.failed.push_back(name);
        }
    }
    return result;
}

void renameOwner(const std::string &tdataDir, const std::string &oldAddress, const std::string &newAddress) {
    if (tdataDir.empty() || !isValidAddress(newAddress)) return;
    if (owner(tdataDir) == oldAddress) writeMarker(tdataDir, newAddress);
}

} // namespace parvane::accountfiles
