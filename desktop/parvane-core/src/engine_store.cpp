// Parvane fork (spec 035 T048): хранилище движка ядра — `pv_store_*` (C ABI) поверх `store_fs`.
#include "parvane/engine_store.h"
#include <filesystem>

#include <tuple>

#include <nlohmann/json.hpp>

#include <parvane_protocol.h>

#include "parvane/crypto.h"
#include "parvane/storecrypt.h"

namespace parvane::engine_store {

using nlohmann::json;

namespace {

void setErr(std::string *error, const std::string &text) {
    if (error) *error = text;
}

// Строка движка → std::string (и освобождение).
std::string take(char *p) {
    if (!p) return {};
    std::string out(p);
    pv_free_string(p);
    return out;
}

std::string takeErr(char *err, const char *what) {
    return std::string(what) + ": " + (err ? take(err) : std::string("ошибка движка"));
}

uint64_t batchIdOf(const json &batch) {
    // proto3-JSON движка — имена полей схемы (`batch_id`); принимается и lowerCamel
    const auto &id = batch.contains("batch_id") ? batch["batch_id"] : batch.contains("batchId") ? batch["batchId"] : json();
    if (id.is_string()) return std::stoull(id.get<std::string>());
    if (id.is_number_unsigned()) return id.get<uint64_t>();
    return 0;
}

}  // namespace

std::unique_ptr<EngineStore> EngineStore::open(const std::string &dir, const std::string &deviceKey32,
                                               std::string *error, store_fs::FsOps &fs) {
    if (deviceKey32.size() != 32) {
        setErr(error, "engine_store: ключ устройства — 32 байта");
        return nullptr;
    }
    auto files = store_fs::Store::open(dir, fs, error);
    if (!files) return nullptr;
    store_fs::Reads r;
    r.keys = {"root"};
    const auto found = files->read(r);
    const auto *key = reinterpret_cast<const uint8_t *>(deviceKey32.data());
    char *err = nullptr;
    PvStoreHandle *h = nullptr;
    if (found.empty()) {
        h = pv_store_open(nullptr, 0, &err);
        if (!h) {
            setErr(error, takeErr(err, "engine_store: новый профиль"));
            return nullptr;
        }
        std::unique_ptr<EngineStore> s(new EngineStore(std::move(files), h));
        const auto batch = take(pv_store_wrap_device(h, key, 32, &err));
        if (batch.empty()) {
            setErr(error, takeErr(err, "engine_store: обёртка ключом устройства"));
            return nullptr;
        }
        std::lock_guard lock(s->mu_);
        if (!s->commitLocked(batch, error)) return nullptr;
        return s;
    }
    const auto &root = found.front().value;
    h = pv_store_open(reinterpret_cast<const uint8_t *>(root.data()), root.size(), &err);
    if (!h) {
        setErr(error, takeErr(err, "engine_store: корень"));
        return nullptr;
    }
    std::unique_ptr<EngineStore> s(new EngineStore(std::move(files), h));
    const auto st = json::parse(take(pv_store_info(h)), nullptr, false);
    if (st.value("state", std::string()) == "too_new") {
        setErr(error, "engine_store: формат хранилища новее этой версии (TOO_NEW)");
        return nullptr;
    }
    if (!pv_store_unlock_device(h, key, 32, &err)) {
        setErr(error, takeErr(err, "engine_store: ключ устройства не открывает хранилище"));
        return nullptr;
    }
    // Прерванный перенос поколения доводится до конца (или откатывается) сразу после открытия
    const auto info = json::parse(take(pv_store_info(h)), nullptr, false);
    if (info.value("pendingGeneration", 0) != 0 || info.value("retiringGeneration", 0) != 0) {
        std::string why;
        if (!s->rotate(&why)) setErr(error, why);
    }
    return s;
}

EngineStore::~EngineStore() {
    if (h_) pv_store_free(h_);
}

bool EngineStore::commitLocked(const std::string &batchJson, std::string *error) {
    const auto batch = json::parse(batchJson, nullptr, false);
    const uint64_t id = batch.is_object() ? batchIdOf(batch) : 0;
    std::string why;
    if (!fs_->commitJson(batchJson, &why)) {
        pv_store_failed(h_, id, why.c_str());
        setErr(error, why);
        return false;
    }
    pv_store_committed(h_, id);
    return true;
}

std::string EngineStore::infoLocked() const {
    return take(pv_store_info(h_));
}

bool EngineStore::write(const std::vector<std::tuple<std::string, std::string, std::string>> &puts,
                        const std::vector<std::pair<std::string, std::string>> &deletes, std::string *error) {
    json ops{{"puts", json::array()}, {"deletes", json::array()}};
    for (const auto &[kind, name, value] : puts) {
        ops["puts"].push_back({{"kind", kind}, {"name", name}, {"value", crypto::b64encode(value)}});
    }
    for (const auto &[kind, name] : deletes) ops["deletes"].push_back({{"kind", kind}, {"name", name}});
    std::lock_guard lock(mu_);
    char *err = nullptr;
    const auto batch = take(pv_store_write(h_, ops.dump().c_str(), &err));
    if (batch.empty()) {
        setErr(error, takeErr(err, "engine_store: запись"));
        return false;
    }
    return commitLocked(batch, error);
}

bool EngineStore::put(const std::string &kind, const std::string &name, const std::string &value,
                      std::string *error) {
    return write({{kind, name, value}}, {}, error);
}

bool EngineStore::remove(const std::string &kind, const std::string &name, std::string *error) {
    return write({}, {{kind, name}}, error);
}

std::optional<std::string> EngineStore::get(const std::string &kind, const std::string &name) const {
    std::lock_guard lock(mu_);
    const auto info = json::parse(infoLocked(), nullptr, false);
    const std::string key = "g" + std::to_string(info.value("activeGeneration", 0u)) + "/" + kind + "/" + name;
    store_fs::Reads r;
    r.keys = {key};
    const auto found = fs_->read(r);
    if (found.empty()) return std::nullopt;
    char *err = nullptr;
    const auto &v = found.front().value;
    PvBytes plain = pv_store_open_record(h_, key.c_str(), reinterpret_cast<const uint8_t *>(v.data()), v.size(), &err);
    if (err) {
        pv_free_string(err);
        return std::nullopt;
    }
    std::string out(reinterpret_cast<const char *>(plain.data), plain.len);
    parvane_protocol_bytes_free(plain);
    return out;
}

std::vector<std::pair<std::string, std::string>> EngineStore::list(const std::string &kind,
                                                                   const std::string &prefix) const {
    std::lock_guard lock(mu_);
    const auto info = json::parse(infoLocked(), nullptr, false);
    const std::string base = "g" + std::to_string(info.value("activeGeneration", 0u)) + "/" + kind + "/";
    store_fs::Reads r;
    r.prefix = base + prefix;
    std::vector<std::pair<std::string, std::string>> out;
    for (const auto &e : fs_->read(r)) {
        char *err = nullptr;
        PvBytes plain = pv_store_open_record(h_, e.key.c_str(), reinterpret_cast<const uint8_t *>(e.value.data()),
                                             e.value.size(), &err);
        if (err) {
            pv_free_string(err);  // не открылась своим ключом — пропуск, как испорченная
            continue;
        }
        out.emplace_back(e.key.substr(base.size()), std::string(reinterpret_cast<const char *>(plain.data), plain.len));
        parvane_protocol_bytes_free(plain);
    }
    return out;
}

bool EngineStore::rewrapDevice(const std::string &deviceKey32, std::string *error) {
    if (deviceKey32.size() != 32) {
        setErr(error, "engine_store: ключ устройства — 32 байта");
        return false;
    }
    std::lock_guard lock(mu_);
    char *err = nullptr;
    const auto batch = take(pv_store_wrap_device(h_, reinterpret_cast<const uint8_t *>(deviceKey32.data()), 32, &err));
    if (batch.empty()) {
        setErr(error, takeErr(err, "engine_store: смена обёртки"));
        return false;
    }
    return commitLocked(batch, error);
}

bool EngineStore::rotate(std::string *error) {
    std::lock_guard lock(mu_);
    char *err = nullptr;
    const auto info = json::parse(infoLocked(), nullptr, false);
    if (info.value("pendingGeneration", 0) == 0 && info.value("retiringGeneration", 0) == 0) {
        const auto begin = take(pv_store_begin_rotation(h_, &err));
        if (begin.empty()) {
            setErr(error, takeErr(err, "engine_store: начало переноса поколения"));
            return false;
        }
        if (!commitLocked(begin, error)) return false;
    }
    for (;;) {
        err = nullptr;
        const auto step = json::parse(take(pv_store_rotation_next(h_, &err)), nullptr, false);
        if (!step.is_object()) {
            setErr(error, takeErr(err, "engine_store: перенос поколения"));
            return false;
        }
        const auto type = step.value("type", std::string());
        if (type == "done") return true;
        if (type == "aborted") {
            setErr(error, "engine_store: перенос поколения остановлен: " + step.value("errors", json::array()).dump());
            return false;
        }
        if (type == "continue") continue;
        if (type == "read") {
            const auto loaded = fs_->readJson(step["reads"].dump());
            if (!pv_store_rotation_loaded(h_, loaded.c_str(), &err) && err) {
                pv_free_string(err);  // не открылась запись — движок перевёл перенос в откат
            }
            continue;
        }
        if (type == "write") {
            std::string why;
            commitLocked(step["batch"].dump(), &why);  // отказ сообщён движку (failed) — следующий шаг — откат
            continue;
        }
        setErr(error, "engine_store: неизвестный шаг переноса " + type);
        return false;
    }
}

uint32_t EngineStore::activeGeneration() const {
    std::lock_guard lock(mu_);
    return json::parse(infoLocked(), nullptr, false).value("activeGeneration", 0u);
}

std::string EngineStore::state() const {
    std::lock_guard lock(mu_);
    return json::parse(infoLocked(), nullptr, false).value("state", std::string());
}

// ── HostFiles (spec 036 T031) ─────────────────────────────────────────────────────────────────────────────────

namespace {

constexpr char kHostFile[] = "host-file";
constexpr char kMigrated[] = "migrated:";

bool endsWith(const std::string &s, const std::string &tail) {
    return s.size() >= tail.size() && s.compare(s.size() - tail.size(), tail.size(), tail) == 0;
}

}  // namespace

std::unique_ptr<HostFiles> HostFiles::open(const std::string &dir, const std::string &deviceKey32, std::string *error,
                                           store_fs::FsOps &fs) {
    auto s = EngineStore::open(dir, deviceKey32, error, fs);
    if (!s) return nullptr;
    return std::unique_ptr<HostFiles>(new HostFiles(std::move(s), fs));
}

std::optional<std::string> HostFiles::read(const std::string &name) const {
    return store_->get(kHostFile, name);
}

bool HostFiles::write(const std::string &name, const std::string &data, std::string *error) {
    if (name.empty() || name.rfind(kMigrated, 0) == 0) {
        setErr(error, "host-file: недопустимое имя");
        return false;
    }
    return store_->put(kHostFile, name, data, error);
}

bool HostFiles::remove(const std::string &name, std::string *error) {
    return store_->remove(kHostFile, name, error);
}

std::vector<std::string> HostFiles::names(const std::string &prefix) const {
    std::vector<std::string> out;
    for (const auto &[name, _] : store_->list(kHostFile, prefix)) {
        if (name.rfind(kMigrated, 0) != 0) out.push_back(name);
    }
    return out;
}

bool HostFiles::migrated(const std::string &name) const {
    return store_->get(kHostFile, kMigrated + name).has_value();
}

HostFiles::Moved HostFiles::migrateFrom(const std::string &name, const std::string &path, std::string *error) {
    if (name.empty() || name.rfind(kMigrated, 0) == 0) {
        setErr(error, "host-file: недопустимое имя");
        return Moved::Failed;
    }
    const auto old = fs_.readFile(path);
    if (migrated(name)) {
        // Перенос был; прервался до переименования прежнего — доделать
        if (old) fs_.rename(path, path + ".migrated");
        return Moved::Already;
    }
    if (!old) return Moved::Missing;
    // Прежний формат: файл целиком (`PVSE1…` либо открытый текст) или JSONL построчно (`PVSE1:` на строку)
    std::optional<std::string> plain;
    bool damaged = false;
    if (endsWith(path, ".jsonl")) {
        std::string joined;
        std::size_t at = 0;
        while (at <= old->size()) {
            const auto nl = old->find('\n', at);
            const auto line = old->substr(at, nl == std::string::npos ? std::string::npos : nl - at);
            if (!line.empty()) {
                if (const auto open = storecrypt::openLine(line)) {
                    joined += *open;
                    joined.push_back('\n');
                } else {
                    damaged = true;
                }
            }
            if (nl == std::string::npos) break;
            at = nl + 1;
        }
        plain = std::move(joined);
    } else if (old->rfind("PVSE1:", 0) == 0 || old->find("\nPVSE1:") != std::string::npos) {
        // Журнал `appendLine` с именем не `.jsonl` (v2-ids.txt, read.txt, cleared-*.txt): голова целиком (после
        // прежнего `migrateFile`) и дописанные строки `PVSE1:` — тем же разбором, что storecrypt::readLines. Целиком
        // такой файл не открывается, а «открытым текстом» строки легли бы как есть
        std::string joined;
        for (const auto &line : storecrypt::readLines(path)) {
            joined += line;
            joined.push_back('\n');
        }
        damaged = joined.empty();
        plain = std::move(joined);
    } else {
        plain = storecrypt::open(*old);
        damaged = !plain.has_value();
    }
    std::vector<std::tuple<std::string, std::string, std::string>> puts;
    const bool hasData = plain && (!damaged || !plain->empty());
    if (hasData) puts.emplace_back(kHostFile, name, *plain);
    if (damaged) puts.emplace_back("quarantine", std::string(kHostFile) + "/" + name, *old);
    puts.emplace_back(kHostFile, kMigrated + name, "1");
    // Данные и отметка — одной пачкой: либо перенесено всё, либо ничего
    if (!store_->write(puts, {}, error)) return Moved::Failed;
    // Сверка чтением до того, как прежний файл уйдёт с места
    if (!migrated(name) || (hasData && read(name) != *plain)) {
        setErr(error, "host-file: сверка переноса не сошлась");
        return Moved::Failed;
    }
    fs_.rename(path, path + (damaged ? ".quarantined" : ".migrated"));
    return damaged ? Moved::Quarantined : Moved::Moved;
}

// ── PathFiles ───────────────────────────────────────────────────────────────────────────────────────────────────

PathFiles::PathFiles(std::string dir, std::string deviceKey32, Log log, std::string sub)
: dir_(std::move(dir)), key_(std::move(deviceKey32)), log_(std::move(log)), sub_(std::move(sub)) {}

std::optional<std::string> PathFiles::nameOf(const std::string &path) const {
    if (dir_.empty() || path.size() <= dir_.size() + 1 || path.compare(0, dir_.size(), dir_) != 0 || path[dir_.size()] != '/')
        return std::nullopt;
    auto name = path.substr(dir_.size() + 1);
    if (name.find("..") != std::string::npos || name.rfind(sub_ + "/", 0) == 0 || name == sub_)
        return std::nullopt;
    return name;
}

HostFiles *PathFiles::openLocked() {
    if (hf_ || tried_) return hf_.get();
    tried_ = true;
    if (key_.size() != 32 || dir_.empty()) return nullptr;
    std::string err;
    hf_ = HostFiles::open(dir_ + "/" + sub_, key_, &err);
    if (!hf_ && log_) log_("хранилище файлов хоста не открылось: " + err + " — прежний путь");
    return hf_.get();
}

bool PathFiles::migratedLocked(HostFiles &hf, const std::string &name, const std::string &path) {
    std::string err;
    switch (hf.migrateFrom(name, path, &err)) {
        case HostFiles::Moved::Moved:
            if (log_) log_("файл перенесён в хранилище движка: " + name);
            return true;
        case HostFiles::Moved::Quarantined:
            if (log_) log_("файл " + name + " испорчен — в карантине, остальное перенесено");
            return true;
        case HostFiles::Moved::Failed:
            if (log_) log_("файл " + name + " не перенесён (" + err + ") — повтор при следующем обращении");
            return false;
        default:
            return true;
    }
}

std::string PathFiles::read(const std::string &path) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto *hf = openLocked();
        const auto name = nameOf(path);
        if (hf && name && migratedLocked(*hf, *name, path)) return hf->read(*name).value_or(std::string());
    }
    return storecrypt::readFile(path);
}

bool PathFiles::exists(const std::string &path) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto *hf = openLocked();
        const auto name = nameOf(path);
        if (hf && name && migratedLocked(*hf, *name, path)) return hf->read(*name).has_value();
    }
    std::error_code ec;
    return std::filesystem::exists(path, ec);
}

bool PathFiles::write(const std::string &path, const std::string &data) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto *hf = openLocked();
        const auto name = nameOf(path);
        if (hf && name && migratedLocked(*hf, *name, path)) {
            if (storecrypt::writesBlocked()) return false; // выход: стирание идёт (NAT-16)
            std::string err;
            if (hf->write(*name, data, &err)) return true;
            if (log_) log_("файл " + *name + " не записан в хранилище движка: " + err);
            return false;
        }
    }
    return storecrypt::writeFile(path, data);
}

void PathFiles::remove(const std::string &path) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto *hf = openLocked();
        if (const auto name = nameOf(path); hf && name) {
            (void)migratedLocked(*hf, *name, path); // отметка переноса: прежний файл не вернётся при следующем чтении
            hf->remove(*name);
        }
    }
    std::error_code ec;
    std::filesystem::remove(path, ec);
    std::filesystem::remove(path + ".migrated", ec); // перенесённая копия прежнего файла (сессия, доверие) — тоже
}

std::vector<std::string> PathFiles::readLines(const std::string &path) {
    std::vector<std::string> out;
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto *hf = openLocked();
        const auto name = nameOf(path);
        if (hf && name && migratedLocked(*hf, *name, path)) {
            const auto text = hf->read(*name).value_or(std::string());
            std::size_t at = 0;
            while (at < text.size()) {
                const auto nl = text.find('\n', at);
                auto line = text.substr(at, nl == std::string::npos ? std::string::npos : nl - at);
                if (!line.empty()) out.push_back(std::move(line));
                if (nl == std::string::npos) break;
                at = nl + 1;
            }
            return out;
        }
    }
    return storecrypt::readLines(path);
}

bool PathFiles::appendLine(const std::string &path, const std::string &line) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto *hf = openLocked();
        const auto name = nameOf(path);
        if (hf && name && migratedLocked(*hf, *name, path)) {
            if (storecrypt::writesBlocked()) return false;
            auto text = hf->read(*name).value_or(std::string());
            if (!text.empty() && text.back() != '\n') text.push_back('\n');
            text += line;
            text.push_back('\n');
            std::string err;
            if (hf->write(*name, text, &err)) return true;
            if (log_) log_("журнал " + *name + " не дописан в хранилище движка: " + err);
            return false;
        }
    }
    return storecrypt::appendLine(path, line);
}

bool PathFiles::writeLines(const std::string &path, const std::vector<std::string> &lines) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto *hf = openLocked();
        const auto name = nameOf(path);
        if (hf && name && migratedLocked(*hf, *name, path)) {
            if (storecrypt::writesBlocked()) return false;
            std::string text;
            for (const auto &l : lines) {
                text += l;
                text.push_back('\n');
            }
            std::string err;
            if (hf->write(*name, text, &err)) return true;
            if (log_) log_("журнал " + *name + " не записан в хранилище движка: " + err);
            return false;
        }
    }
    return storecrypt::writeLines(path, lines);
}

bool PathFiles::rename(const std::string &from, const std::string &to) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto *hf = openLocked();
        const auto a = nameOf(from);
        const auto b = nameOf(to);
        if (hf && a && b && migratedLocked(*hf, *a, from) && migratedLocked(*hf, *b, to)) {
            if (storecrypt::writesBlocked()) return false;
            const auto data = hf->read(*a);
            if (!data || hf->read(*b)) return false;
            std::string err;
            if (!hf->write(*b, *data, &err)) {
                if (log_) log_("файл " + *b + " не записан при переименовании: " + err);
                return false;
            }
            hf->remove(*a);
            return true;
        }
    }
    std::error_code ec;
    if (!std::filesystem::exists(from, ec) || std::filesystem::exists(to, ec)) return false;
    std::filesystem::rename(from, to, ec);
    return !ec;
}

void PathFiles::reset() {
    std::lock_guard<std::mutex> lk(mu_);
    hf_.reset();
    tried_ = false;
}

}  // namespace parvane::engine_store
