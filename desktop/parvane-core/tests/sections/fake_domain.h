// Parvane fork (spec 029): поддельный транспорт разделов для тестов planner_sync / cloud_sync — движок и шина
// без стека. Вызовы движка — таблица обработчиков по имени (нет обработчика — исключение «UnknownCall»),
// запросы шины записываются и отвечаются обработчиками по методу; кодек тела — JSON-текст.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "parvane/sections/domain_sync.h"

namespace fake {

using nlohmann::json;
namespace d = parvane::sections::domain;

struct Sent {
    bool anon = false;
    std::string method;
    std::string body;
    std::string dest;
};

class Transport : public d::DomainTransport {
public:
    std::map<std::string, std::function<json(const json &)>> engineFns;
    std::map<std::string, std::function<std::string(const Sent &)>> busFns;
    std::vector<std::pair<std::string, json>> engineCalls;
    std::vector<Sent> sent;
    std::vector<std::string> logs;
    std::int64_t now = 1'760'000'000'000; // как Date.now() (октябрь 2025)
    bool client = true;
    bool ready = true;
    bool linking = false;
    int persists = 0;
    std::string me = "alice@local";
    std::string domainName = "local";

    json engine(const std::string &name, const json &args) override {
        engineCalls.emplace_back(name, args);
        const auto it = engineFns.find(name);
        if (it == engineFns.end()) throw std::runtime_error("{\"error\":\"UnknownCall\"} " + name);
        return it->second(args);
    }
    std::string request(bool anon, const std::string &method, const std::string &body,
                        const std::string &dest) override {
        Sent s{anon, method, body, dest};
        sent.push_back(s);
        const auto it = busFns.find(method);
        if (it == busFns.end()) return "{}";
        return it->second(s);
    }
    std::string encodeMethod(const std::string &method, const json &value) override { return value.dump(); }
    json decodeMethod(const std::string &method, const std::string &bytes) override { return json::parse(bytes); }
    bool hasClient() override { return client; }
    bool isReady() override { return ready; }
    bool needsLinking() override { return linking; }
    std::string self() override { return me; }
    std::string serverDomain() override { return domainName; }
    void persist() override { ++persists; }
    std::int64_t nowMs() override { return now; }
    void log(const std::string &m) override { logs.push_back(m); }

    int countSent(const std::string &method) const {
        int n = 0;
        for (const auto &s : sent) n += s.method == method;
        return n;
    }
    // Последний вызов движка с этим именем (аргументы); нет — null
    json lastEngine(const std::string &name) const {
        for (auto it = engineCalls.rbegin(); it != engineCalls.rend(); ++it) {
            if (it->first == name) return it->second;
        }
        return nullptr;
    }
    // Тело последнего запроса метода, разобранное как JSON (кодек поддельный); нет — null
    json lastBody(const std::string &method) const {
        for (auto it = sent.rbegin(); it != sent.rend(); ++it) {
            if (it->method == method) {
                try {
                    return json::parse(it->body);
                } catch (...) {
                    return json(it->body);
                }
            }
        }
        return nullptr;
    }
};

// Запрос движка {chan, method, body(base64)}
inline json req(const std::string &method, const std::string &body, const std::string &dest = {}) {
    json r{{"chan", "id"}, {"method", method}, {"body", d::toBase64(body)}};
    if (!dest.empty()) r["dest"] = dest;
    return r;
}

} // namespace fake
