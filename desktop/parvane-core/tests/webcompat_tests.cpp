// Parvane fork: общие векторы форматов клиентов web ↔ desktop (spec 029, FR-006), без стека.
// Файл, который пишет web (`web/.../clientVectors.test.ts`), обязан читаться здесь, и наоборот:
// вектор desktop создаётся этим тестом (если его нет или PARVANE_REGEN_VECTORS=1), web его читает.
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>

#include <nlohmann/json.hpp>

#include "parvane/crypto.h"
#include "parvane/keybackup.h"
#include "parvane/keybundle.h"
#include "parvane/pack_archive.h"
#include "parvane/v2_content.h"

using nlohmann::json;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(), info.empty() ? "" : (" — " + info).c_str());
}

static std::string vectorPath(const std::string &name) {
    return std::string(PARVANE_VECTORS_DIR) + "/clients/" + name;
}

static std::string readText(const std::string &path) {
    std::ifstream f(path, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static bool regen() {
    const char *v = std::getenv("PARVANE_REGEN_VECTORS");
    return v && std::string(v) == "1";
}

static void keyBackup() {
    // Файл web — читается desktop
    const auto web = json::parse(readText(vectorPath("keybackup-web.json")), nullptr, false);
    check(web.is_object(), "keybackup: вектор web есть (сгенерировать: vitest clientVectors)");
    if (web.is_object()) {
        const auto got = parvane::keybackup::importEncrypted(web["file"].dump(), web.value("password", std::string()));
        check(got.has_value(), "keybackup: файл web расшифрован паролем");
        check(got && json::parse(*got, nullptr, false) == web["payload"], "keybackup: содержимое файла web совпало");
        check(!parvane::keybackup::importEncrypted(web["file"].dump(), "wrong-password"), "keybackup: неверный пароль — отказ");
    }

    // Файл desktop — пишется здесь, читает web
    const auto desktopPath = vectorPath("keybackup-desktop.json");
    if (regen() || readText(desktopPath).empty()) {
        const json payload{{"deviceId", "vec-device-desktop"},
                           {"v2", {{"key", "HxweHRwbGhkYFxYVFBMSERAPDg0MCwoJCAcGBQQDAgE="}, {"state", "ZGVza3RvcC1zdGF0ZQ=="}}},
                           {"v2History", json::array({json{{"chat", "alice@local"}, {"id", "0192f1a2-0000-7000-8000-0000000000aa"},
                                                           {"text", "с компьютера"}}})}};
        const auto file = parvane::keybackup::exportEncrypted(payload.dump(), "Desktop-vector-2026");
        std::ofstream(desktopPath) << json{{"password", "Desktop-vector-2026"}, {"payload", payload},
                                           {"file", json::parse(file)}}.dump(2) << "\n";
    }
    const auto desktop = json::parse(readText(desktopPath), nullptr, false);
    check(desktop.is_object() && desktop["file"].value("v", 0) == 2, "keybackup: файл desktop — конверт версии 2");
    if (desktop.is_object()) {
        const auto got = parvane::keybackup::importEncrypted(desktop["file"].dump(), desktop.value("password", std::string()));
        check(got && json::parse(*got, nullptr, false) == desktop["payload"], "keybackup: файл desktop читается обратно");
    }

    // P-48: границы конверта — до KDF
    const auto fresh = json::parse(parvane::keybackup::exportEncrypted(R"({"deviceId":"x","v2":{}})", "pass-12345678"));
    auto bad = fresh;
    bad["v"] = 1;
    check(!parvane::keybackup::importEncrypted(bad.dump(), "pass-12345678"), "keybackup: конверт версии 1 не читается (T110)");
    bad = fresh;
    bad["iterations"] = 5000001;
    check(!parvane::keybackup::importEncrypted(bad.dump(), "pass-12345678"), "keybackup: итераций больше 5 млн — отказ до KDF");
    bad = fresh;
    bad["salt"] = parvane::crypto::b64encode(std::string(8, 'x'));
    check(!parvane::keybackup::importEncrypted(bad.dump(), "pass-12345678"), "keybackup: короткая соль — отказ");
    bad = fresh;
    bad["iv"] = parvane::crypto::b64encode(std::string(16, 'x'));
    check(!parvane::keybackup::importEncrypted(bad.dump(), "pass-12345678"), "keybackup: iv не 12 байт — отказ");
    check(parvane::keybackup::importEncrypted(fresh.dump(), "pass-12345678").has_value(), "keybackup: свой файл читается");
}

static void keyBundle() {
    namespace kb = parvane::keybundle;
    const auto web = json::parse(readText(vectorPath("keybundle-web.json")), nullptr, false);
    check(web.is_object(), "keybundle: вектор web есть");
    if (web.is_object()) {
        const auto key = kb::deriveBundleKey(web.value("recoveryKey", std::string()), web.value("address", std::string()));
        check(key && parvane::crypto::b64encode(*key) == web.value("bundleKey", std::string()), "keybundle: ключ копии совпал с web (HKDF)");
        const auto sealed = parvane::crypto::b64decode(web.value("sealed", std::string())).value_or(std::string());
        const auto opened = key ? kb::open(*key, web.value("address", std::string()), sealed) : std::nullopt;
        check(opened && *opened == web["payload"], "keybundle: копия web открыта, содержимое совпало");
        check(key && !kb::open(*key, "other@parvane.example", sealed), "keybundle: чужой адрес (AAD) — отказ");
        bool pickOk = true;
        for (const auto &c : web["pick"]) {
            const auto got = kb::pickRecoveryKey(c.value("input", std::string()));
            if (got != c.value("output", std::string())) {
                pickOk = false;
                std::printf("    pick: «%s» → «%s», web «%s»\n", c.value("input", std::string()).c_str(), got.c_str(),
                            c.value("output", std::string()).c_str());
            }
        }
        check(pickOk, "keybundle: разбор ключа из текста — как web (" + std::to_string(web["pick"].size()) + " случаев)");
    }
    const auto desktopPath = vectorPath("keybundle-desktop.json");
    if (regen() || readText(desktopPath).empty()) {
        const std::string recoveryKey = "Z9Y8-X7W6-V5T4-S3R2-Q1P0-N9M8-K7J6-H5G4-F3E2-D1C0";
        const std::string address = "gleb@parvane.example";
        const json payload{{"grant", "eyJzc2siOiJmZiJ9"}, {"cloud", "[]"},
                           {"history", {{"fileId", "f2"}, {"fileKey", "k2"}, {"fileNonce", "n2"}, {"at", 1760000000001LL},
                                        {"mark", "m2"}}}};
        const auto key = kb::deriveBundleKey(recoveryKey, address);
        const auto sealed = key ? kb::seal(*key, address, payload) : std::string();
        std::ofstream(desktopPath) << json{{"recoveryKey", recoveryKey}, {"address", address},
                                           {"sealed", parvane::crypto::b64encode(sealed)}, {"payload", payload}}.dump(2) << "\n";
    }
    const auto desktop = json::parse(readText(desktopPath), nullptr, false);
    if (desktop.is_object()) {
        const auto key = kb::deriveBundleKey(desktop.value("recoveryKey", std::string()), desktop.value("address", std::string()));
        const auto opened = key ? kb::open(*key, desktop.value("address", std::string()),
            parvane::crypto::b64decode(desktop.value("sealed", std::string())).value_or(std::string())) : std::nullopt;
        check(opened && *opened == desktop["payload"], "keybundle: файл desktop открывается обратно");
    }
    check(!kb::canonicalRecoveryKey("UUUU-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"), "keybundle: «U» — не ключ");
    check(kb::withBundleKey(R"({"ssk":"00"})", "QUJD") == R"({"bk":"QUJD","ssk":"00"})", "keybundle: ключ копии в грант (поле bk)");
    check(kb::readGrantBundleKey(R"({"bk":"QUJD"})") == "QUJD", "keybundle: ключ копии из гранта");
    check(json::parse(kb::withFreshLog(R"({"log":"aa"})", std::string("\x01\xff", 2)))["log"] == "01ff", "keybundle: свежий журнал (hex)");
    // Слияние при записи — общие с web случаи: копия не «беднеет» от только что вошедшего устройства
    const auto merge = json::parse(readText(vectorPath("keybundle-merge.json")), nullptr, false);
    check(merge.is_object() && merge["cases"].is_array() && merge["cases"].size() >= 4, "keybundle: вектор слияния есть");
    if (merge.is_object()) {
        const auto normalize = [](json p) {
            if (p.contains("cloud") && p["cloud"].is_string()) p["cloud"] = json::parse(p["cloud"].get<std::string>(), nullptr, false);
            return p;
        };
        for (const auto &c : merge["cases"]) {
            const auto got = kb::mergeWithServer(c["own"], c["server"]);
            check(normalize(got) == normalize(c["merged"]), "keybundle: слияние — " + c.value("name", std::string()));
        }
    }
}

static void calls() {
    const auto t = json::parse(readText(vectorPath("calls-web.json")), nullptr, false);
    check(t.is_object(), "звонки: вектор web есть");
    if (!t.is_object()) return;
    const auto domain = t.value("domain", std::string());
    int i = 0;
    for (const auto &c : t["toV2"]) {
        const auto got = parvane::v2::callSignalToV2(c["input"], std::string(), domain);
        const auto want = c["output"];
        check((got ? *got : json(nullptr)) == want, "звонки v1→v2 #" + std::to_string(i++) + " " + c["input"].value("type", std::string()),
              got ? got->dump() : "null");
    }
    i = 0;
    for (const auto &c : t["fromV2"]) {
        auto got = parvane::v2::callSignalFromV2(c["input"]);
        const auto want = c["output"];
        check((got ? *got : json(nullptr)) == want, "звонки v2→v1 #" + std::to_string(i++), got ? got->dump() : "null");
    }
    bool titles = true;
    for (const auto &c : t["titles"]) {
        const auto got = parvane::v2::cleanGroupTitle(c.value("input", std::string()));
        if (got != c.value("output", std::string())) {
            titles = false;
            std::printf("    название: «%s» → «%s», web «%s»\n", c.value("input", std::string()).c_str(), got.c_str(),
                        c.value("output", std::string()).c_str());
        }
    }
    check(titles, "звонки: название группы очищается как web (CALL-2)");
}

// PACK-2: отпечаток набора стикеров по вектору web (`pack-hash.json`, его проверяет и web clientVectors.test.ts)
static void packHash() {
    const auto table = json::parse(readText(vectorPath("pack-hash.json")), nullptr, false);
    check(table.is_object() && table["cases"].is_array() && !table["cases"].empty(), "pack-hash: вектор есть");
    if (!table.is_object() || !table["cases"].is_array()) return;
    for (const auto &c : table["cases"]) {
        std::vector<parvane::pack::Entry> files;
        for (const auto &f : c["files"]) {
            const auto data = parvane::crypto::b64decode(f.value("data", std::string()));
            files.push_back({f.value("name", std::string()), data.value_or(std::string())});
        }
        const auto name = c.value("name", std::string());
        const auto expected = c.value("content_hash", std::string());
        const auto got = parvane::crypto::b64encode(parvane::pack::contentHash(files));
        check(got == expected, "pack-hash: " + name, got);
        const auto archive = parvane::pack::build(files);
        check(parvane::pack::archiveContentHashB64(archive) == expected
                  && parvane::pack::archiveMatchesContentHash(archive, expected),
              "pack-hash: архив PVPK1 — " + name);
    }
}

int main() {
    std::printf("=== parvane-core: векторы форматов web ↔ desktop (%s) ===\n", PARVANE_VECTORS_DIR);
    keyBackup();
    keyBundle();
    calls();
    packHash();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
