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
    // spec 024: срок, переголосование, викторина (как web polls.ts applyVote)
    using parvane::poll::acceptsVote;
    using parvane::poll::rulesOf;
    const auto timed = rulesOf(json::parse(R"({"kind":"poll","close_ms":"100000","no_revote":true})"));
    check(timed.closeAtMs == 100000 && timed.noRevote, "close_ms строкой (protobuf int64) и no_revote читаются");
    check(rulesOf(json::parse(R"({"close_ms":5})")).closeAtMs == 5, "close_ms числом");
    check(acceptsVote(timed, false, 100000 + 59000), "голос в пределах минуты после срока принят (доставка)");
    check(!acceptsVote(timed, false, 100000 + 61000), "голос после срока и минуты отброшен");
    check(!acceptsVote(timed, true, 1000), "без переголосования второй голос отброшен");
    const auto quiz = rulesOf(json::parse(R"({"is_quiz":true})"));
    check(quiz.quiz && !acceptsVote(quiz, true, 1) && acceptsVote(quiz, false, 1), "викторина: первый голос окончательный");
    auto closed = rulesOf(json::object());
    closed.closed = true;
    check(!acceptsVote(closed, false, 1), "закрытый опрос голосов не принимает");
    check(parvane::poll::isClosedAt(timed, 100000) && !parvane::poll::isClosedAt(timed, 99999), "закрыт с наступлением срока");
    std::printf("=== итог: %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
