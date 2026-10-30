// Parvane: опросы — сведение двух исторических наборов имён полей контента
// kind=poll к одному (spec 005). Web пишет options/is_public/is_multiple/is_quiz,
// desktop — answers/public/multiple/quiz; голоса (poll_vote) и закрытие
// (poll_close) совпадают. Читатели всех клиентов принимают оба набора; android
// пишет оба сразу. Заголовочная чистая функция без транспорта.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::poll {

// Дополняет отсутствующие имена парными: после вызова в объекте есть и
// options, и answers (одинаковые), и все три пары флагов. Не-объект — как есть.
inline nlohmann::json normalize(nlohmann::json c) {
    if (!c.is_object()) return c;
    const auto copy = [&](const char *a, const char *b) {
        if (c.contains(a) && !c.contains(b)) c[b] = c[a];
        else if (c.contains(b) && !c.contains(a)) c[a] = c[b];
    };
    copy("options", "answers");
    copy("is_public", "public");
    copy("is_multiple", "multiple");
    copy("is_quiz", "quiz");
    return c;
}

// Правила голоса (spec 024, как web polls.ts applyVote): голос после срока (`close_ms`) плюс минута на
// доставку не принимается; в викторине и в опросе без переголосования первый голос окончательный.
constexpr std::int64_t kCloseGraceMs = 60 * 1000;

struct VoteRules {
    bool closed = false;
    std::int64_t closeAtMs = 0; // 0 — без срока
    bool quiz = false;
    bool noRevote = false;
};

inline VoteRules rulesOf(const nlohmann::json &content) {
    VoteRules r;
    if (!content.is_object()) return r;
    const auto c = normalize(content);
    if (const auto it = c.find("close_ms"); it != c.end()) {
        if (it->is_number()) r.closeAtMs = it->get<std::int64_t>();
        else if (it->is_string()) r.closeAtMs = std::strtoll(it->get<std::string>().c_str(), nullptr, 10);
    }
    r.quiz = c.value("quiz", false);
    r.noRevote = c.value("no_revote", false);
    return r;
}

// atMs — время голоса (у истории — время отправки): после перезагрузки старые голоса не отбрасываются.
inline bool acceptsVote(const VoteRules &r, bool alreadyVoted, std::int64_t atMs) {
    if (r.closed) return false;
    if (r.closeAtMs > 0 && atMs > r.closeAtMs + kCloseGraceMs) return false;
    if ((r.quiz || r.noRevote) && alreadyVoted) return false;
    return true;
}

inline bool isClosedAt(const VoteRules &r, std::int64_t nowMs) {
    return r.closed || (r.closeAtMs > 0 && nowMs >= r.closeAtMs);
}

// ── POLL-1: анонимный опрос группы ──────────────────────────────────────────
// Голос анонимного опроса группы уходит ТОЛЬКО автору опроса личным сообщением (участникам группы адрес
// голосующего не виден), автор публикует в группу итоги: poll_vote с `tally:true`, `counts` (по вариантам)
// и `voters` — без адресов. Участник (не автор) считает только итоги автора и свой выбор; итоги принимаются
// только от автора, из чата опроса. Автор виден голосующих только себе (как в сообщении 1:1).
constexpr std::int64_t kMaxTally = 10'000'000;

[[nodiscard]] inline bool isAnonymousGroup(bool isGroup, bool publicVoters, const std::string &author) {
    return isGroup && !publicVoters && !author.empty();
}

// Итоги от автора: счётчики приводятся к числу вариантов `answers` (лишние отбрасываются, недостающие — 0,
// отрицательные и дробные — 0, потолок kMaxTally); `voters` — не отрицательное.
struct Tally {
    std::vector<int> counts;
    int voters = 0;
};

[[nodiscard]] inline bool isTallyContent(const nlohmann::json &c) {
    return c.is_object() && c.value("kind", std::string()) == "poll_vote" && c.value("tally", false);
}

[[nodiscard]] inline Tally readTally(const nlohmann::json &c, int answers) {
    Tally t;
    t.counts.assign(answers > 0 ? std::size_t(answers) : 0, 0);
    const auto clamp = [](const nlohmann::json &v) -> int {
        if (!v.is_number_integer()) return 0;
        const auto n = v.get<std::int64_t>();
        return n < 0 ? 0 : int(n > kMaxTally ? kMaxTally : n);
    };
    if (c.contains("counts") && c["counts"].is_array()) {
        for (std::size_t i = 0; i < t.counts.size() && i < c["counts"].size(); ++i) t.counts[i] = clamp(c["counts"][i]);
    }
    if (c.contains("voters")) t.voters = clamp(c["voters"]);
    return t;
}

[[nodiscard]] inline nlohmann::json tallyContent(const std::string &pollUuid, const Tally &t) {
    return nlohmann::json{{"kind", "poll_vote"}, {"poll", pollUuid}, {"options", nlohmann::json::array()},
                          {"tally", true}, {"counts", t.counts}, {"voters", t.voters}};
}

// Куда засчитать голос. `inPollChat` — сообщение пришло в чат опроса (группу); иначе это личное сообщение.
struct VoteCtx {
    bool anonGroup = false;
    bool inPollChat = false;
    std::string self, author, voter, to;
    bool voterIsMember = false; // голосующий — действующий участник группы опроса (знает только автор)
};
struct VoteRoute {
    bool count = false;   // записать голос в агрегат
    bool publish = false; // автор: опубликовать обновлённые итоги
};

[[nodiscard]] inline VoteRoute routeVote(const VoteCtx &x) {
    VoteRoute r;
    const bool iAmAuthor = !x.author.empty() && x.author == x.self;
    if (x.inPollChat) {
        // Участник анонимного опроса чужие голоса из группы не считает — они в итогах автора
        if (x.anonGroup && !iAmAuthor && x.voter != x.self) return r;
        r.count = true;
        r.publish = x.anonGroup && iAmAuthor;
        return r;
    }
    if (!x.anonGroup) return r;
    if (x.voter == x.self && x.to == x.author) { // свой голос автору (журнал, другое устройство)
        r.count = true;
        return r;
    }
    if (iAmAuthor && x.to == x.self && x.voterIsMember) { // чужой голос автору в личку
        r.count = true;
        r.publish = true;
    }
    return r;
}

} // namespace parvane::poll
