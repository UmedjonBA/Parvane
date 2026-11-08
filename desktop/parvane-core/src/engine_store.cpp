// Parvane fork (spec 035 T048): хранилище движка ядра — `pv_store_*` (C ABI) поверх `store_fs`.
#include "parvane/engine_store.h"

#include <tuple>

#include <nlohmann/json.hpp>

#include <parvane_protocol.h>

#include "parvane/crypto.h"

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

}  // namespace parvane::engine_store
