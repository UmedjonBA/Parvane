// Parvane: опросы — сведение двух исторических наборов имён полей контента
// kind=poll к одному (spec 005). Web пишет options/is_public/is_multiple/is_quiz,
// desktop — answers/public/multiple/quiz; голоса (poll_vote) и закрытие
// (poll_close) совпадают. Читатели всех клиентов принимают оба набора; android
// пишет оба сразу. Заголовочная чистая функция без транспорта.
#pragma once

#include <cstdint>

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

} // namespace parvane::poll
