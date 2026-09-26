// Parvane fork: фейковый ITransport для тестов без стека. Запоминает последний
// subject/payload запроса (payload — разобранный JSON) и отдаёт заранее
// заданный ответ. Подписки и publish — заглушки.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/itransport.h"

namespace parvane::test {

class FakeTransport : public ITransport {
public:
    std::string nextReply = "{}";
    std::string lastSubject;
    nlohmann::json lastPayload;
    std::vector<std::string> subjects; // история subject'ов по порядку

    std::string request(const std::string &subject, const std::string &payload,
                        std::int64_t) override {
        lastSubject = subject;
        subjects.push_back(subject);
        lastPayload = nlohmann::json::parse(payload, nullptr, false);
        return nextReply;
    }
    void publish(const std::string &subject, const std::string &payload) override {
        lastSubject = subject;
        subjects.push_back(subject);
        lastPayload = nlohmann::json::parse(payload, nullptr, false);
    }
    void requestMany(const std::string &subject, const std::string &, const ReplyHandler &onReply,
                     std::int64_t) override {
        lastSubject = subject;
        subjects.push_back(subject);
        onReply(nextReply);
    }
    void subscribe(const std::string &, Handler) override {}
};

} // namespace parvane::test
