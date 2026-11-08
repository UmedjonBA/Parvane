// Parvane fork (spec 035 T127): читатель старых мест профиля desktop — см. migrate_legacy.h.
#include "parvane/migrate_legacy.h"

#include "parvane/crypto.h"
#include "parvane/local_files.h"
#include "parvane/storecrypt.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>

namespace parvane::migrate_legacy {

namespace fs = std::filesystem;

namespace {

// Файлы tdata без адреса в имени (перечень, судьба migrate)
const std::vector<std::string> &sharedFiles() {
    static const std::vector<std::string> v = {
        "parvane-blocked.json",  "parvane-dialogs.json",      "parvane-drafts.json",      "parvane-folders.json",
        "parvane-groups-seen.json", "parvane-hidden-gifs.json", "parvane-notify.json",    "parvane-privacy.json",
        "parvane-renames.json",  "parvane-scheduled.json",    "parvane-ttl.json",
    };
    return v;
}

// Файлы аккаунта ядра (слой core перечня); файлы, которые пишет сам клиент, он передаёт в `extra`
const std::vector<AccountFile> &coreAccountFiles() {
    static const std::vector<AccountFile> v = {{"parvane-history-", ".jsonl", false}};
    return v;
}

// Каталог состояния v2 `parvane-v2-<s>/` (перечень, судьба migrate)
const std::vector<std::string> &v2Files() {
    static const std::vector<std::string> v = {
        "bundle-key", "bundle-seq", "device", "device-id", "groups-reshared-v1", "invites", "invites-shared", "key",
        "root", "root-backup", "root-backup-received", "root-backup-sent", "root-escrow", "state",
        "sections-records.json",
    };
    return v;
}

bool endsWith(const std::string &s, const std::string &suf) {
    return s.size() >= suf.size() && s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
}

std::optional<std::string> readRaw(const fs::path &p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return std::nullopt;
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Открытый текст файла: JSONL — построчно (каждая строка шифруется отдельно), остальное — целиком.
// nullopt — файл есть, но не открылся.
std::optional<std::string> readPlain(const fs::path &p) {
    const auto raw = readRaw(p);
    if (!raw) return std::nullopt;
    if (endsWith(p.filename().string(), ".jsonl")) {
        std::string out;
        std::istringstream in(*raw);
        std::string line;
        while (std::getline(in, line)) {
            if (line.empty()) continue;
            const auto plain = storecrypt::openLine(line);
            if (!plain) return std::nullopt; // строка под чужим ключом или испорчена — весь файл в отчёт
            out += *plain;
            out += '\n';
        }
        return out;
    }
    return storecrypt::open(*raw);
}

} // namespace

std::string keyFor(const std::string &relPath, const std::string &self, const std::vector<AccountFile> &extra) {
    if (self.empty()) return {};
    const auto safe = accountfiles::safePart(self);
    const auto slash = relPath.find('/');
    if (slash != std::string::npos) {
        if (relPath.substr(0, slash) != "parvane-v2-" + safe) return {};
        const auto name = relPath.substr(slash + 1);
        const auto &v = v2Files();
        return std::find(v.begin(), v.end(), name) != v.end() ? "file:" + relPath : std::string();
    }
    const auto &shared = sharedFiles();
    if (std::find(shared.begin(), shared.end(), relPath) != shared.end()) return "file:" + relPath;
    std::vector<AccountFile> all = coreAccountFiles();
    all.insert(all.end(), extra.begin(), extra.end());
    // Сначала «много файлов» (`parvane-history-sync-<s>-…` раньше точного `parvane-history-<s>.jsonl`)
    for (const auto &a : all) {
        if (!a.many) continue;
        const auto head = a.prefix + safe + a.suffix;
        if (relPath.size() > head.size() && relPath.rfind(head, 0) == 0) return "file:" + relPath;
    }
    for (const auto &a : all) {
        if (!a.many && relPath == a.prefix + safe + a.suffix) return "file:" + relPath;
    }
    return {};
}

Collected collect(const std::string &tdataDir, const std::string &self, const std::vector<AccountFile> &extra) {
    Collected out;
    if (tdataDir.empty() || self.empty()) return out;
    const fs::path root(tdataDir);
    std::vector<std::string> rel;
    std::error_code ec;
    for (const auto &e : fs::directory_iterator(root, ec)) {
        std::error_code tc;
        const auto name = e.path().filename().string();
        if (e.is_regular_file(tc)) {
            rel.push_back(name);
        } else if (e.is_directory(tc) && name == "parvane-v2-" + accountfiles::safePart(self)) {
            for (const auto &f : fs::directory_iterator(e.path(), tc)) {
                std::error_code fc;
                if (f.is_regular_file(fc)) rel.push_back(name + "/" + f.path().filename().string());
            }
        }
    }
    std::sort(rel.begin(), rel.end());
    for (const auto &r : rel) {
        const auto key = keyFor(r, self, extra);
        if (key.empty()) continue;
        auto plain = readPlain(root / r);
        if (!plain) {
            out.unreadable.push_back(key);
            continue;
        }
        out.records.push_back(Record{key, std::move(*plain)});
    }
    return out;
}

nlohmann::json toJson(const Collected &c) {
    auto records = nlohmann::json::array();
    for (const auto &r : c.records) records.push_back({{"key", r.key}, {"value", crypto::b64encode(r.value)}});
    return {{"records", records}, {"unreadable", c.unreadable}};
}

} // namespace parvane::migrate_legacy
