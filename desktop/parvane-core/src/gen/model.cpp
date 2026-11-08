// Сгенерировано gen_bindings (cargo run -p parvane-protocol --bin gen_bindings) из proto/parvane/engine/v1/** — не править руками; проверка — gen_bindings --check (тест bindings_are_fresh).
#include "parvane/gen/model.h"

#include <stdexcept>

namespace parvane::gen {

namespace {
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

template <typename T> T numFrom(const nlohmann::json &v) {
    if (v.is_string()) {
        const auto &s = v.get_ref<const std::string &>();
        if constexpr (std::is_signed_v<T>) return static_cast<T>(std::stoll(s));
        else return static_cast<T>(std::stoull(s));
    }
    return v.get<T>();
}

const nlohmann::json *pick(const nlohmann::json &j, const char *proto, const char *camel) {
    if (!j.is_object()) return nullptr;
    auto it = j.find(proto);
    if (it != j.end() && !it->is_null()) return &*it;
    it = j.find(camel);
    if (it != j.end() && !it->is_null()) return &*it;
    return nullptr;
}
} // namespace

std::string toBase64(const std::string &b) {
    std::string out;
    for (size_t i = 0; i < b.size(); i += 3) {
        const uint32_t n = (uint32_t(uint8_t(b[i])) << 16) | (i + 1 < b.size() ? uint32_t(uint8_t(b[i + 1])) << 8 : 0) | (i + 2 < b.size() ? uint32_t(uint8_t(b[i + 2])) : 0);
        out += kB64[(n >> 18) & 63];
        out += kB64[(n >> 12) & 63];
        out += i + 1 < b.size() ? kB64[(n >> 6) & 63] : '=';
        out += i + 2 < b.size() ? kB64[n & 63] : '=';
    }
    return out;
}

std::string fromBase64(const std::string &t) {
    std::string out;
    uint32_t acc = 0;
    int bits = 0;
    for (char ch : t) {
        if (ch == '=' || ch == '\n' || ch == '\r' || ch == ' ') continue;
        if (ch == '-') ch = '+';
        if (ch == '_') ch = '/';
        const char *p = std::char_traits<char>::find(kB64, 64, ch);
        if (!p) throw std::invalid_argument("base64");
        acc = (acc << 6) | uint32_t(p - kB64);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += char((acc >> bits) & 0xff);
        }
    }
    return out;
}

void to_json(nlohmann::json &j, const DeviceWrap &m) {
    j = nlohmann::json::object();
    if (!m.wrapped_dek.empty()) j["wrapped_dek"] = toBase64(m.wrapped_dek);
}

void from_json(const nlohmann::json &j, DeviceWrap &m) {
    m = DeviceWrap{};
    if (const auto *v = pick(j, "wrapped_dek", "wrappedDek")) m.wrapped_dek = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const KindFormat &m) {
    j = nlohmann::json::object();
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (m.format != 0) j["format"] = m.format;
}

void from_json(const nlohmann::json &j, KindFormat &m) {
    m = KindFormat{};
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "format", "format")) m.format = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const MigrationProgress &m) {
    j = nlohmann::json::object();
    if (m.from_generation != 0) j["from_generation"] = m.from_generation;
    if (m.to_generation != 0) j["to_generation"] = m.to_generation;
    if (m.point != 0) j["point"] = m.point;
    if (!m.errors.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.errors) a.push_back(x);
        j["errors"] = a;
    }
}

void from_json(const nlohmann::json &j, MigrationProgress &m) {
    m = MigrationProgress{};
    if (const auto *v = pick(j, "from_generation", "fromGeneration")) m.from_generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "to_generation", "toGeneration")) m.to_generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "point", "point")) m.point = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "errors", "errors"); v && v->is_array())
        for (const auto &x : *v) m.errors.push_back(x.get<std::string>());
}

void to_json(nlohmann::json &j, const PinWrap &m) {
    j = nlohmann::json::object();
    if (!m.salt.empty()) j["salt"] = toBase64(m.salt);
    if (m.iterations != 0) j["iterations"] = m.iterations;
    if (!m.wrapped_dek.empty()) j["wrapped_dek"] = toBase64(m.wrapped_dek);
    if (!m.check.empty()) j["check"] = toBase64(m.check);
}

void from_json(const nlohmann::json &j, PinWrap &m) {
    m = PinWrap{};
    if (const auto *v = pick(j, "salt", "salt")) m.salt = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "iterations", "iterations")) m.iterations = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "wrapped_dek", "wrappedDek")) m.wrapped_dek = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "check", "check")) m.check = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const StorePut &m) {
    j = nlohmann::json::object();
    if (!m.key.empty()) j["key"] = m.key;
    if (!m.value.empty()) j["value"] = toBase64(m.value);
}

void from_json(const nlohmann::json &j, StorePut &m) {
    m = StorePut{};
    if (const auto *v = pick(j, "key", "key")) m.key = (*v).get<std::string>();
    if (const auto *v = pick(j, "value", "value")) m.value = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const StoreReads &m) {
    j = nlohmann::json::object();
    if (m.read_id != 0) j["read_id"] = std::to_string(m.read_id);
    if (!m.keys.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.keys) a.push_back(x);
        j["keys"] = a;
    }
    if (!m.prefix.empty()) j["prefix"] = m.prefix;
    if (!m.after.empty()) j["after"] = m.after;
    if (m.limit != 0) j["limit"] = m.limit;
}

void from_json(const nlohmann::json &j, StoreReads &m) {
    m = StoreReads{};
    if (const auto *v = pick(j, "read_id", "readId")) m.read_id = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "keys", "keys"); v && v->is_array())
        for (const auto &x : *v) m.keys.push_back(x.get<std::string>());
    if (const auto *v = pick(j, "prefix", "prefix")) m.prefix = (*v).get<std::string>();
    if (const auto *v = pick(j, "after", "after")) m.after = (*v).get<std::string>();
    if (const auto *v = pick(j, "limit", "limit")) m.limit = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const Stored &m) {
    j = nlohmann::json::object();
    if (m.format != 0) j["format"] = m.format;
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (m.generation != 0) j["generation"] = m.generation;
    if (!m.payload.empty()) j["payload"] = toBase64(m.payload);
}

void from_json(const nlohmann::json &j, Stored &m) {
    m = Stored{};
    if (const auto *v = pick(j, "format", "format")) m.format = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "generation", "generation")) m.generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "payload", "payload")) m.payload = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const Wrap &m) {
    j = nlohmann::json::object();
    if (m.generation != 0) j["generation"] = m.generation;
    if (const auto *p = std::get_if<1>(&m.kind)) j["device"] = *p;
    if (const auto *p = std::get_if<2>(&m.kind)) j["pin"] = *p;
}

void from_json(const nlohmann::json &j, Wrap &m) {
    m = Wrap{};
    if (const auto *v = pick(j, "generation", "generation")) m.generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "device", "device")) m.kind.emplace<1>(v->get<DeviceWrap>());
    if (const auto *v = pick(j, "pin", "pin")) m.kind.emplace<2>(v->get<PinWrap>());
}

void to_json(nlohmann::json &j, const Root &m) {
    j = nlohmann::json::object();
    if (!m.store_id.empty()) j["store_id"] = toBase64(m.store_id);
    if (m.active_generation != 0) j["active_generation"] = m.active_generation;
    if (m.pending_generation != 0) j["pending_generation"] = m.pending_generation;
    if (!m.wraps.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.wraps) a.push_back(x);
        j["wraps"] = a;
    }
    if (!m.kinds_max_format.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.kinds_max_format) a.push_back(x);
        j["kinds_max_format"] = a;
    }
    if (m.retiring_generation != 0) j["retiring_generation"] = m.retiring_generation;
}

void from_json(const nlohmann::json &j, Root &m) {
    m = Root{};
    if (const auto *v = pick(j, "store_id", "storeId")) m.store_id = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "active_generation", "activeGeneration")) m.active_generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "pending_generation", "pendingGeneration")) m.pending_generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "wraps", "wraps"); v && v->is_array())
        for (const auto &x : *v) m.wraps.push_back(x.get<Wrap>());
    if (const auto *v = pick(j, "kinds_max_format", "kindsMaxFormat"); v && v->is_array())
        for (const auto &x : *v) m.kinds_max_format.push_back(x.get<KindFormat>());
    if (const auto *v = pick(j, "retiring_generation", "retiringGeneration")) m.retiring_generation = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const StoreBatch &m) {
    j = nlohmann::json::object();
    if (m.batch_id != 0) j["batch_id"] = std::to_string(m.batch_id);
    if (!m.puts.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.puts) a.push_back(x);
        j["puts"] = a;
    }
    if (!m.deletes.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.deletes) a.push_back(x);
        j["deletes"] = a;
    }
}

void from_json(const nlohmann::json &j, StoreBatch &m) {
    m = StoreBatch{};
    if (const auto *v = pick(j, "batch_id", "batchId")) m.batch_id = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "puts", "puts"); v && v->is_array())
        for (const auto &x : *v) m.puts.push_back(x.get<StorePut>());
    if (const auto *v = pick(j, "deletes", "deletes"); v && v->is_array())
        for (const auto &x : *v) m.deletes.push_back(x.get<std::string>());
}

void to_json(nlohmann::json &j, const StoreLoaded &m) {
    j = nlohmann::json::object();
    if (m.read_id != 0) j["read_id"] = std::to_string(m.read_id);
    if (!m.entries.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.entries) a.push_back(x);
        j["entries"] = a;
    }
}

void from_json(const nlohmann::json &j, StoreLoaded &m) {
    m = StoreLoaded{};
    if (const auto *v = pick(j, "read_id", "readId")) m.read_id = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "entries", "entries"); v && v->is_array())
        for (const auto &x : *v) m.entries.push_back(x.get<StorePut>());
}

} // namespace parvane::gen
