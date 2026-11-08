// Parvane fork (spec 035): C ABI движка в сборке ядра desktop/android.
//  T012 — кодек по имени типа у КАЖДОГО сообщения схемы: `pv_encode_message`/`pv_decode_message`
//         (кругооборот пустого сообщения по списку `pv_schema_message_names`; «максимально заполненные»
//         образцы через C ABI проверяет тест крейта parvane-protocol-ffi);
//  T014 — `pv_engine_info()`: пять осей версий (contracts/versioning.md), освобождение `pv_free_string`.
#include <algorithm>
#include <cstdio>
#include <string>

#include <nlohmann/json.hpp>

#include <parvane_protocol.h>

static int g_fail = 0;
static void check(bool c, const std::string &msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg.c_str());
    if (!c) ++g_fail;
}

static bool hex64(const nlohmann::json &v) {
    if (!v.is_string()) return false;
    const auto s = v.get<std::string>();
    if (s.size() != 64) return false;
    for (char c : s)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
}

static void engineInfo() {
    char *p = pv_engine_info();
    check(p != nullptr, "pv_engine_info");
    if (!p) return;
    const auto info = nlohmann::json::parse(p, nullptr, false);
    pv_free_string(p);
    check(info.is_object(), "engineInfo — JSON-объект");
    if (!info.is_object()) return;
    const auto api = info.value("engineApi", std::string());
    check(std::count(api.begin(), api.end(), '.') == 2, "engineApi MAJOR.MINOR.PATCH: " + api);
    check(info.value("protoMajor", 0) == 2, "protoMajor = 2");
    check(info.value("protoMinor", 0) >= 1 && info.value("protoMinor", 0) == info.value("minSupportedMinor", -1),
          "protoMinor = minSupportedMinor = PROTO_MINOR_035");
    check(info["features"].is_array(), "features");
    check(info["storageFormats"].is_object() && info["storageFormats"].contains("engine-core") && info["storageFormats"].contains("state-object"),
          "storageFormats");
    check(info["criticalRanges"]["default"] == nlohmann::json::array({1000, 1999}), "criticalRanges.default = [1000, 1999]");
    check(hex64(info["sourceHash"]) && hex64(info["schemaHash"]), "sourceHash/schemaHash — SHA-256");
    check(!info.value("buildId", std::string()).empty() && !info.value("target", std::string()).empty(), "buildId/target");
}

static void everyMessageHasACodec() {
    char *p = pv_schema_message_names();
    const auto names = nlohmann::json::parse(p ? p : "[]", nullptr, false);
    if (p) pv_free_string(p);
    check(names.is_array() && names.size() >= 300, "pv_schema_message_names: " + std::to_string(names.size()));
    int missing = 0;
    std::string first;
    for (const auto &n : names) {
        const auto name = n.get<std::string>();
        char *err = nullptr;
        PvBytes b = pv_encode_message(name.c_str(), "{}", &err);
        bool ok = err == nullptr && b.len == 0;
        if (err) parvane_protocol_string_free(err);
        parvane_protocol_bytes_free(b);
        err = nullptr;
        char *j = pv_decode_message(name.c_str(), nullptr, 0, &err);
        ok = ok && err == nullptr && j && std::string(j) == "{}";
        if (j) parvane_protocol_string_free(j);
        if (err) parvane_protocol_string_free(err);
        if (!ok) {
            ++missing;
            if (first.empty()) first = name;
        }
    }
    check(missing == 0, "кодек по имени типа у всех сообщений схемы (нет у " + std::to_string(missing) + (first.empty() ? "" : ", например " + first) + ")");
    // Сообщение модели движка и планировщика — с данными.
    char *err = nullptr;
    PvBytes b = pv_encode_message("parvane.engine.v1.StorePut", R"({"key":"root","value":"CAE="})", &err);
    check(err == nullptr && b.len > 0, "StorePut кодируется");
    char *j = pv_decode_message("parvane.engine.v1.StorePut", b.data, b.len, &err);
    check(j && std::string(j) == R"({"key":"root","value":"CAE="})", "StorePut кругооборот");
    if (j) parvane_protocol_string_free(j);
    parvane_protocol_bytes_free(b);
    b = pv_encode_message("parvane.nope.v1.Nope", "{}", &err);
    check(err != nullptr, "незнакомый тип — ошибка");
    if (err) parvane_protocol_string_free(err);
    parvane_protocol_bytes_free(b);
}

int main() {
    engineInfo();
    everyMessageHasACodec();
    std::printf(g_fail ? "engine_abi: %d FAIL\n" : "engine_abi: OK\n", g_fail);
    return g_fail ? 1 : 0;
}
