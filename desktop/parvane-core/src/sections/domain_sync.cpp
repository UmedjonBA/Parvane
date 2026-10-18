// Parvane fork (spec 029, T029/T033/T034): общий слой синхронизации разделов — см. domain_sync.h.
#include "parvane/sections/domain_sync.h"

#include <array>

namespace parvane::sections::domain {

std::optional<std::string> errorCode(const std::exception &e) {
    if (const auto *b = dynamic_cast<const BusError *>(&e)) return b->code();
    return std::nullopt;
}

std::string errorText(const std::exception &e) {
    return e.what();
}

OutRequest OutRequest::fromJson(const json &r) {
    OutRequest out;
    if (!r.is_object()) throw std::invalid_argument("запрос движка: не объект");
    out.anon = r.value("chan", std::string("id")) == "anon";
    out.method = r.value("method", std::string());
    out.body = fromBase64(r.value("body", std::string()));
    if (r.contains("dest") && r["dest"].is_string()) out.dest = r["dest"].get<std::string>();
    return out;
}

MemoryRecords::MemoryRecords(const json &saved) {
    if (saved.is_object()) all_ = saved;
}

std::optional<json> MemoryRecords::load(const std::string &key) {
    const auto it = all_.find(key);
    if (it == all_.end()) return std::nullopt;
    return *it;
}

void MemoryRecords::save(const std::string &key, const json &value) {
    all_[key] = value;
}

void MemoryRecords::remove(const std::string &key) {
    all_.erase(key);
}

// ── base64 / hex ───────────────────────────────────────────────────────────────

namespace {

constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int b64Value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

} // namespace

std::string toBase64(const std::string &bytes) {
    std::string out;
    out.reserve((bytes.size() + 2) / 3 * 4);
    size_t i = 0;
    for (; i + 2 < bytes.size(); i += 3) {
        const unsigned v = (static_cast<unsigned char>(bytes[i]) << 16)
            | (static_cast<unsigned char>(bytes[i + 1]) << 8) | static_cast<unsigned char>(bytes[i + 2]);
        out += kAlphabet[(v >> 18) & 63];
        out += kAlphabet[(v >> 12) & 63];
        out += kAlphabet[(v >> 6) & 63];
        out += kAlphabet[v & 63];
    }
    const size_t rest = bytes.size() - i;
    if (rest == 1) {
        const unsigned v = static_cast<unsigned char>(bytes[i]) << 16;
        out += kAlphabet[(v >> 18) & 63];
        out += kAlphabet[(v >> 12) & 63];
        out += "==";
    } else if (rest == 2) {
        const unsigned v = (static_cast<unsigned char>(bytes[i]) << 16) | (static_cast<unsigned char>(bytes[i + 1]) << 8);
        out += kAlphabet[(v >> 18) & 63];
        out += kAlphabet[(v >> 12) & 63];
        out += kAlphabet[(v >> 6) & 63];
        out += '=';
    }
    return out;
}

std::string fromBase64(const std::string &b64) {
    std::string out;
    unsigned acc = 0;
    int bits = 0;
    for (const char c : b64) {
        if (c == '=' ) break;
        if (c == '\n' || c == '\r' || c == ' ') continue;
        const int v = b64Value(c);
        if (v < 0) throw std::invalid_argument("base64: негодный символ");
        acc = (acc << 6) | static_cast<unsigned>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += static_cast<char>((acc >> bits) & 0xFF);
        }
    }
    return out;
}

std::string hexToB64(const std::string &hex) {
    std::string bytes;
    bytes.reserve(hex.size() / 2);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        const int hi = hexValue(hex[i]);
        const int lo = hexValue(hex[i + 1]);
        // Как parseInt(…, 16) в web: негодная пара — 0 (NaN → 0 в Uint8Array)
        bytes += static_cast<char>(hi < 0 || lo < 0 ? 0 : hi * 16 + lo);
    }
    return toBase64(bytes);
}

std::string b64ToHex(const std::string &b64) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string out;
    for (const char c : fromBase64(b64)) {
        const auto b = static_cast<unsigned char>(c);
        out += digits[b >> 4];
        out += digits[b & 15];
    }
    return out;
}

std::string runRequest(DomainTransport &t, const OutRequest &r) {
    return t.request(r.anon, r.method, r.body, r.dest);
}

void runRequests(DomainTransport &t, const json &reqs) {
    if (!reqs.is_array()) return;
    for (const auto &r : reqs) runRequest(t, OutRequest::fromJson(r));
}

std::optional<std::int64_t> earliest(std::initializer_list<const Deadline *> list) {
    std::optional<std::int64_t> best;
    for (const auto *d : list) {
        if (d && d->at && (!best || *d->at < *best)) best = d->at;
    }
    return best;
}

} // namespace parvane::sections::domain
