// Parvane fork (spec 035 T120, contracts/engine-api.md «Векторы»): векторы модели движка
// `proto/parvane/vectors/model/*.json` через C ABI (`pv_engine_*`) и хост ядра `parvane::engine::Host` над НАСТОЯЩИМ
// файловым хранилищем `store_fs` (каталог во временной папке, fsync) — тот же прогон, что `cargo test -p
// parvane-protocol --test model_vectors` (эталон хоста — `backend/protocol/tests/model_common`), web
// `modelVectors.test.ts`, android `ModelVectorsTest.kt`. Общий для desktop и android (одна ctest-цель ядра).
//
// Шаг вектора — `submit` / `input` (`vectorInput`) / чтение (`historyPage`, `chatList`, `capabilities`, `viewState`,
// `viewGroup`). Ожидания шага: `changes` — изменения модели по порядку (каждое — подмножество фактического),
// `requests` — методы запросов по порядку, `puts` — виды записей, которые обязаны быть в пачке, `error` — вид
// ошибки, `result` — подмножество ответа чтения. Ревизия растёт на 1 с каждым непустым изменением.
//
// Дополнительно (то, чего нет в векторах, но что обязан соблюдать хост): после «перезапуска» (новый Host над тем
// же каталогом) история и состояние на месте — пачки действительно на диске.
#include "parvane/engine_host.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>
#include <string>

#include <unistd.h>

#include <nlohmann/json.hpp>

#ifndef PARVANE_VECTORS_DIR
#define PARVANE_VECTORS_DIR "../../proto/parvane/vectors"
#endif

using nlohmann::json;
namespace eh = parvane::engine;

static int g_fail = 0;
static void check(bool c, const std::string &msg) {
    if (!c) std::printf("[FAIL] %s\n", msg.c_str());
    if (!c) ++g_fail;
}

static const char *kSuites[] = {
    "send_direct",       "delete_everyone_direct", "delete_me",      "edit_before_row",       "state_patch_folder",
    "group_perms_media", "unknown_content_stub",   "features_text_fallback", "history_paging", "fave_sticker",
};

static json load(const std::string &name) {
    std::ifstream f(std::string(PARVANE_VECTORS_DIR) + "/model/" + name + ".json");
    std::stringstream ss;
    ss << f.rdbuf();
    return json::parse(ss.str(), nullptr, false);
}

// Ожидаемое — подмножество фактического (как `matches` эталонного хоста): `null` — поле отсутствует (proto3-JSON
// опускает умолчания), строка "$имя" — переменная (первое вхождение связывает, следующие сравнивают).
static bool absent(const json &v) {
    if (v.is_null()) return true;
    if (v.is_boolean()) return !v.get<bool>();
    if (v.is_string()) return v.get<std::string>().empty() || v.get<std::string>() == "0";
    if (v.is_array() || v.is_object()) return v.empty();
    if (v.is_number()) return v.get<double>() == 0.0;
    return false;
}

static bool matches(const json &exp, const json &act, std::map<std::string, json> &vars, const std::string &path,
                    std::string &why) {
    if (exp.is_null()) {
        if (absent(act)) return true;
        why = path + ": ожидалось отсутствие, есть " + act.dump();
        return false;
    }
    if (exp.is_string() && !exp.get<std::string>().empty() && exp.get<std::string>()[0] == '$') {
        const auto name = exp.get<std::string>();
        const auto it = vars.find(name);
        if (it == vars.end()) {
            vars[name] = act;
            return true;
        }
        if (it->second == act) return true;
        why = path + ": " + name + " = " + it->second.dump() + ", а здесь " + act.dump();
        return false;
    }
    if (exp.is_object()) {
        for (auto it = exp.begin(); it != exp.end(); ++it) {
            const json a = act.is_object() && act.contains(it.key()) ? act[it.key()] : json();
            if (!matches(it.value(), a, vars, path + "." + it.key(), why)) return false;
        }
        return true;
    }
    if (exp.is_array()) {
        const json a = act.is_array() ? act : json::array();
        if (a.size() != exp.size()) {
            why = path + ": длина " + std::to_string(a.size()) + " вместо " + std::to_string(exp.size()) + " — " + act.dump();
            return false;
        }
        for (size_t i = 0; i < exp.size(); ++i)
            if (!matches(exp[i], a[i], vars, path + "[" + std::to_string(i) + "]", why)) return false;
        return true;
    }
    if (exp.is_number()) {
        const double want = exp.get<double>();
        bool ok = act.is_number() && act.get<double>() == want;
        if (!ok && act.is_string()) {
            try {
                ok = std::stod(act.get<std::string>()) == want;
            } catch (...) {
            }
        }
        if (!ok) why = path + ": " + act.dump() + " вместо " + exp.dump();
        return ok;
    }
    if (exp == act) return true;
    why = path + ": " + act.dump() + " вместо " + exp.dump();
    return false;
}

static std::string tmpDir(const std::string &tag) {
    char tpl[] = "/tmp/pv-model-vectors-XXXXXX";
    const char *d = mkdtemp(tpl);
    return std::string(d ? d : "/tmp/pv-model-vectors") + "/" + tag;
}

static int g_cases = 0;

static void runCase(const std::string &suite, const json &c) {
    const auto cname = suite + " / " + c.value("name", std::string());
    json cfg = c["config"];
    cfg["vectors"] = true;
    if (!cfg.contains("device_key")) cfg["device_key"] = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="; // [7; 32]
    const auto dir = tmpDir("store");
    std::string err;
    auto host = eh::Host::open(cfg, dir, &err);
    if (!host) {
        check(false, cname + ": хост не открыт: " + err);
        return;
    }
    std::map<std::string, json> vars;
    auto revision = host->revision();
    const auto &steps = c["steps"];
    for (size_t i = 0; i < steps.size(); ++i) {
        const auto at = cname + " шаг " + std::to_string(i);
        const auto &step = steps[i];
        const json exp = step.value("expect", json::object());
        std::string name;
        json args;
        for (auto it = step.begin(); it != step.end(); ++it) {
            if (it.key() != "expect") {
                name = it.key();
                args = it.value();
                break;
            }
        }
        const auto call = name == "input" ? std::string("vectorInput") : name;
        std::string why;
        if (exp.contains("error")) {
            const auto out = host->raw(call, args);
            check(out.is_object() && out.value("error", std::string()) == exp["error"].get<std::string>(),
                  at + ": ожидалась ошибка " + exp["error"].dump() + ", ответ " + out.dump());
            continue;
        }
        if (exp.contains("result")) {
            const auto out = host->read(call, args);
            check(!out.contains("error"), at + ": ошибка " + out.dump());
            check(matches(exp["result"], out, vars, at, why), why + "\nответ: " + out.dump());
            continue;
        }
        const auto st = host->step(call, args);
        if (!st.ok()) {
            check(false, at + ": ошибка " + st.error);
            continue;
        }
        for (auto r : st.revisions) {
            check(r == revision + 1, at + ": ревизия растёт на 1 (" + std::to_string(revision) + " → " + std::to_string(r) + ")");
            revision = r;
        }
        if (exp.contains("changes")) {
            const json changes = st.changes;
            check(matches(exp["changes"], changes, vars, at + " changes", why), why + "\nизменения: " + changes.dump(1));
        }
        if (exp.contains("requests")) {
            json methods = json::array();
            for (const auto &r : st.requests) methods.push_back(r.value("method", std::string()));
            check(methods == exp["requests"], at + ": запросы " + methods.dump() + " вместо " + exp["requests"].dump());
        }
        if (exp.contains("puts") && exp["puts"].is_array()) {
            for (const auto &p : exp["puts"]) {
                const auto k = p.get<std::string>();
                check(std::find(st.putKinds.begin(), st.putKinds.end(), k) != st.putKinds.end(),
                      at + ": в пачке нет " + k + " (" + json(st.putKinds).dump() + ")");
            }
        }
    }
    ++g_cases;
    // Перезапуск над тем же каталогом: профиль открывается из того, что записано на диск
    host.reset();
    eh::Step opened;
    auto again = eh::Host::open(cfg, dir, &err, parvane::store_fs::posixFs(), &opened);
    check(again != nullptr, cname + ": повторное открытие: " + err);
    if (again) {
        check(opened.open.value("state", std::string()) == "OPEN_STATE_READY", cname + ": после перезапуска READY: " + opened.open.dump());
    }
    std::error_code ec;
    std::filesystem::remove_all(std::filesystem::path(dir).parent_path(), ec);
}

int main() {
    for (const char *s : kSuites) {
        const auto v = load(s);
        if (!v.is_object()) {
            check(false, std::string("нет набора ") + s);
            continue;
        }
        check(v.value("suite", std::string()) == std::string("model/") + s, std::string("suite ") + s);
        for (const auto &c : v["cases"]) runCase(s, c);
    }
    check(g_cases >= 13, "векторов модели: " + std::to_string(g_cases));
    std::printf("%s model_vectors: %d случаев, ошибок %d\n", g_fail ? "[FAIL]" : "[ok]", g_cases, g_fail);
    return g_fail ? 1 : 0;
}
