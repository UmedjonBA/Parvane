// Parvane fork: опросы читаются в обоих форматах (web и desktop) — spec 005.
#include <cstdio>
#include <string>

#include "parvane/poll.h"

using nlohmann::json;
static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total; if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

int main() {
    std::printf("=== parvane-core poll tests (без стека) ===\n");
    const auto web = parvane::poll::normalize(json::parse(R"({"kind":"poll","question":"Q","options":["a","b"],"is_public":true,"is_multiple":false,"is_quiz":true,"correct":[1]})"));
    check(web["answers"].size() == 2 && web["answers"][0] == "a", "web → answers дополнены");
    check(web["public"] == true && web["multiple"] == false && web["quiz"] == true, "web → флаги desktop дополнены");
    check(web["options"].size() == 2 && web["is_public"] == true, "web-имена сохранены");
    const auto desk = parvane::poll::normalize(json::parse(R"({"kind":"poll","question":"Q","answers":["x"],"public":false,"multiple":true,"quiz":false})"));
    check(desk["options"].size() == 1 && desk["options"][0] == "x", "desktop → options дополнены");
    check(desk["is_public"] == false && desk["is_multiple"] == true && desk["is_quiz"] == false, "desktop → флаги web дополнены");
    const auto both = parvane::poll::normalize(json::parse(R"({"options":["a"],"answers":["b"],"is_quiz":true,"quiz":false})"));
    check(both["options"][0] == "a" && both["answers"][0] == "b" && both["quiz"] == false, "оба имени есть — ничего не трогаем");
    check(parvane::poll::normalize(json("str")).is_string(), "не-объект возвращается как есть");
    std::printf("=== итог: %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
