// Parvane: опросы — сведение двух исторических наборов имён полей контента
// kind=poll к одному (spec 005). Web пишет options/is_public/is_multiple/is_quiz,
// desktop — answers/public/multiple/quiz; голоса (poll_vote) и закрытие
// (poll_close) совпадают. Читатели всех клиентов принимают оба набора; android
// пишет оба сразу. Заголовочная чистая функция без транспорта.
#pragma once

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

} // namespace parvane::poll
