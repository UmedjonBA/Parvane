// Parvane fork: общие векторы conformance протокола v2 (spec 007, T081/T085:
// SEAL-1, GSEAL-1, приглашения, STATE-1, все виды содержимого) через C ABI
// движка — те же файлы proto/parvane/vectors/**, что гоняют Rust, web и
// android. Для содержимого дополнительно сверяется перекладка ядра в
// содержимое UI (v2_content) — та же, что в web. Без стека.
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include <nlohmann/json.hpp>

#include <parvane/v2_content.h>
#include <parvane_protocol.h>

#ifndef PARVANE_VECTORS_DIR
#define PARVANE_VECTORS_DIR "../../../proto/parvane/vectors"
#endif

static int g_total = 0, g_fail = 0;

static void run(const std::string &suite, const std::string &file) {
    ++g_total;
    const auto path = std::string(PARVANE_VECTORS_DIR) + "/" + file;
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        ++g_fail;
        std::printf("  FAIL  %s — нет файла %s\n", suite.c_str(), path.c_str());
        return;
    }
    std::stringstream ss;
    ss << f.rdbuf();
    const auto json = ss.str();
    char *err = nullptr;
    const auto n = pv_run_conformance_vectors(suite.c_str(), json.c_str(), &err);
    const bool ok = n > 2 && err == nullptr;
    if (!ok) ++g_fail;
    std::printf("  %s  %s: %lld случаев%s%s\n", ok ? "ok  " : "FAIL", suite.c_str(),
                static_cast<long long>(n), err ? " — " : "", err ? err : "");
    if (err) parvane_protocol_string_free(err);
}

static bool readFile(const std::string &file, std::string &out) {
    std::ifstream f(std::string(PARVANE_VECTORS_DIR) + "/" + file, std::ios::binary);
    if (!f) return false;
    std::stringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

// Ожидание — подмножество полученного: каждое поле ожидания совпадает.
static bool subset(const nlohmann::json &expect, const nlohmann::json &got) {
    if (expect.is_object()) {
        if (!got.is_object()) return false;
        for (auto it = expect.begin(); it != expect.end(); ++it) {
            if (!got.contains(it.key()) || !subset(it.value(), got[it.key()])) return false;
        }
        return true;
    }
    if (expect.is_array()) {
        if (!got.is_array() || got.size() != expect.size()) return false;
        for (std::size_t i = 0; i < expect.size(); ++i) {
            if (!subset(expect[i], got[i])) return false;
        }
        return true;
    }
    return expect == got;
}

// T085: каждый вид содержимого ядро относит к тому же классу и перекладывает
// в то же содержимое UI, что и web (поле `client` вектора).
static void runContentClient() {
    using nlohmann::json;
    using Kind = parvane::v2::Incoming::Kind;
    std::string text;
    if (!readFile("content/kinds.json", text)) {
        ++g_total;
        ++g_fail;
        std::printf("  FAIL  content/kinds (клиент) — нет файла\n");
        return;
    }
    const auto file = json::parse(text, nullptr, false);
    int checked = 0;
    for (const auto &c : file.value("cases", json::array())) {
        if (!c.contains("client")) continue;
        ++g_total;
        ++checked;
        const auto name = c.value("name", std::string("?"));
        const auto &expect = c["expect"];
        const json ev{{"type", "direct"}, {"seq", 1}, {"chat", "alice@local"}, {"from", "alice@local"},
                      {"device", "d"}, {"opId", "0192f0e4-1a2b-7c3d-8e4f-001122334455"},
                      {"tsMs", 1700000000123LL}, {"content", expect.value("content", json::object())},
                      {"disposition", expect.value("disposition", std::string("show"))}};
        const auto in = parvane::v2::interpretDirect(ev, "bob@local");
        const auto want = c["client"].value("class", std::string());
        bool ok = false;
        if (want == "message") {
            ok = in.kind == Kind::Message && subset(c["client"].value("v1", json::object()), in.content);
        } else if (want == "stub") {
            ok = in.kind == Kind::Stub && in.content.value("kind", std::string()) == "unsupported";
        } else if (want == "mutation") {
            ok = in.kind != Kind::Message && in.kind != Kind::Stub;
        } else if (want == "service") {
            ok = in.kind == Kind::None;
        }
        if (!ok) {
            ++g_fail;
            std::printf("  FAIL  content/kinds (клиент) %s: ожидался класс %s, содержимое UI %s\n",
                        name.c_str(), want.c_str(), in.content.dump().c_str());
        }
    }
    ++g_total;
    if (checked < 30) {
        ++g_fail;
        std::printf("  FAIL  content/kinds (клиент): случаев %d\n", checked);
    } else {
        std::printf("  ok    content/kinds (клиент): %d случаев\n", checked);
    }
}

int main() {
    std::printf("=== parvane-core protocol vectors (C ABI, %s) ===\n", PARVANE_VECTORS_DIR);
    run("seal/sealed", "seal/sealed.json");
    run("seal/group", "seal/group.json");
    run("invite/links", "invite/links.json");
    // STATE-1 (T099): детерминированное сведение журнала личного состояния
    run("state/merge", "state/merge.json");
    // T085: все виды содержимого — байты ↔ JSON, лимиты, показ/заглушка
    run("content/kinds", "content/kinds.json");
    runContentClient();
    // L2-1 (T079): сетка выравнивания, согласование режима, запрет typing/presence
    run("l2/mode", "l2/mode.json");
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
