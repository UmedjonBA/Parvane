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
    // POLL-1: анонимный опрос группы
    using parvane::poll::VoteCtx;
    using parvane::poll::routeVote;
    check(parvane::poll::isAnonymousGroup(true, false, "alice@local") && !parvane::poll::isAnonymousGroup(true, true, "alice@local")
        && !parvane::poll::isAnonymousGroup(false, false, "alice@local") && !parvane::poll::isAnonymousGroup(true, false, ""),
        "анонимный — только в группе, не публичный и с известным автором");
    {
        const auto t = parvane::poll::readTally(json::parse(R"({"kind":"poll_vote","tally":true,"counts":[2,-1,1.5,99999999999,7],"voters":-3})"), 3);
        check(t.counts.size() == 3 && t.counts[0] == 2 && t.counts[1] == 0 && t.counts[2] == 0 && t.voters == 0, "итоги: размер по вариантам, отрицательные и дробные — 0");
        const auto big = parvane::poll::readTally(json::parse(R"({"counts":[99999999999],"voters":99999999999})"), 1);
        check(big.counts[0] == 10000000 && big.voters == 10000000, "итоги: потолок");
        const auto c = parvane::poll::tallyContent("p1", parvane::poll::Tally{{3, 0, 2}, 5});
        check(parvane::poll::isTallyContent(c) && c["counts"].size() == 3 && c["voters"] == 5 && c.dump().find('@') == std::string::npos,
            "итоги автора: без адресов");
        check(!parvane::poll::isTallyContent(json::parse(R"({"kind":"poll_vote","options":[1]})")), "обычный голос — не итоги");
    }
    {
        VoteCtx x;
        x.anonGroup = true; x.self = "bob@local"; x.author = "alice@local";
        x.voter = "carol@local"; x.inPollChat = true;
        check(!routeVote(x).count, "участник: чужой голос из группы анонимного опроса не считается");
        x.voter = "bob@local";
        check(routeVote(x).count && !routeVote(x).publish, "участник: свой голос считается, итоги не публикует");
        x.inPollChat = false; x.to = "alice@local";
        check(routeVote(x).count, "участник: свой голос автору в личку (журнал) считается");
        x.to = "dave@local";
        check(!routeVote(x).count, "участник: свой голос не автору не считается");
        VoteCtx a;
        a.anonGroup = true; a.self = "alice@local"; a.author = "alice@local";
        a.voter = "carol@local"; a.to = "alice@local"; a.inPollChat = false;
        check(!routeVote(a).count, "автор: голос в личку не от участника группы отброшен");
        a.voterIsMember = true;
        check(routeVote(a).count && routeVote(a).publish, "автор: голос участника в личку — считает и публикует итоги");
        a.to = "erin@local";
        check(!routeVote(a).count, "автор: чужое личное сообщение (не ему) не считается");
        a.to = "alice@local"; a.anonGroup = false;
        check(!routeVote(a).count, "публичный опрос: голос в личку не принимается");
        a.inPollChat = true;
        check(routeVote(a).count && !routeVote(a).publish, "публичный опрос: голос в группе считается как раньше");
    }
    std::printf("=== итог: %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
