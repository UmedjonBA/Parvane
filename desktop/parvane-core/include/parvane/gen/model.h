// Сгенерировано gen_bindings (cargo run -p parvane-protocol --bin gen_bindings) из proto/parvane/engine/v1/** — не править руками; проверка — gen_bindings --check (тест bindings_are_fresh).
// Граница движка — proto3-JSON: имена полей схемы, int64 — строка, bytes — base64 (здесь — сырые байты в std::string), enum — имя.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::gen {

std::string toBase64(const std::string &bytes);
std::string fromBase64(const std::string &text);

struct DeviceWrap;
struct KindFormat;
struct MigrationProgress;
struct PinWrap;
struct Root;
struct StoreBatch;
struct StoreLoaded;
struct StorePut;
struct StoreReads;
struct Stored;
struct Wrap;

struct DeviceWrap {
    std::string wrapped_dek;
};
void to_json(nlohmann::json &j, const DeviceWrap &m);
void from_json(const nlohmann::json &j, DeviceWrap &m);

struct KindFormat {
    std::string kind;
    uint32_t format = 0;
};
void to_json(nlohmann::json &j, const KindFormat &m);
void from_json(const nlohmann::json &j, KindFormat &m);

struct MigrationProgress {
    uint32_t from_generation = 0;
    uint32_t to_generation = 0;
    uint32_t point = 0;
    std::vector<std::string> errors;
};
void to_json(nlohmann::json &j, const MigrationProgress &m);
void from_json(const nlohmann::json &j, MigrationProgress &m);

struct PinWrap {
    std::string salt;
    uint32_t iterations = 0;
    std::string wrapped_dek;
    std::string check;
};
void to_json(nlohmann::json &j, const PinWrap &m);
void from_json(const nlohmann::json &j, PinWrap &m);

struct StorePut {
    std::string key;
    std::string value;
};
void to_json(nlohmann::json &j, const StorePut &m);
void from_json(const nlohmann::json &j, StorePut &m);

struct StoreReads {
    uint64_t read_id = 0;
    std::vector<std::string> keys;
    std::string prefix;
    std::string after;
    uint32_t limit = 0;
};
void to_json(nlohmann::json &j, const StoreReads &m);
void from_json(const nlohmann::json &j, StoreReads &m);

struct Stored {
    uint32_t format = 0;
    std::string kind;
    uint32_t generation = 0;
    std::string payload;
};
void to_json(nlohmann::json &j, const Stored &m);
void from_json(const nlohmann::json &j, Stored &m);

struct Wrap {
    uint32_t generation = 0;
    // oneof kind: device, pin
    std::variant<std::monostate, DeviceWrap, PinWrap> kind;
};
void to_json(nlohmann::json &j, const Wrap &m);
void from_json(const nlohmann::json &j, Wrap &m);

struct Root {
    std::string store_id;
    uint32_t active_generation = 0;
    uint32_t pending_generation = 0;
    std::vector<Wrap> wraps;
    std::vector<KindFormat> kinds_max_format;
    uint32_t retiring_generation = 0;
};
void to_json(nlohmann::json &j, const Root &m);
void from_json(const nlohmann::json &j, Root &m);

struct StoreBatch {
    uint64_t batch_id = 0;
    std::vector<StorePut> puts;
    std::vector<std::string> deletes;
};
void to_json(nlohmann::json &j, const StoreBatch &m);
void from_json(const nlohmann::json &j, StoreBatch &m);

struct StoreLoaded {
    uint64_t read_id = 0;
    std::vector<StorePut> entries;
};
void to_json(nlohmann::json &j, const StoreLoaded &m);
void from_json(const nlohmann::json &j, StoreLoaded &m);

} // namespace parvane::gen
