// Parvane fork: реализация CallClient (см. call_client.h).
#include "parvane/call_client.h"

#include "parvane/events.h"
#include "parvane/ids.h"
#include "parvane/topics.h"

namespace parvane {

namespace {

// Персональный инбокс сигналов звонка. Зеркалит call_inbox() из parvane-types:
// точный субъект call.user.<addr> (@ в токене субъекта допустим).
std::string callInbox(const std::string &user) {
    return "call.user." + user;
}

} // namespace

void CallClient::send(const std::string &from, const std::string &to,
                      const std::string &token, const json &signal) {
    const json payload{{"to", to}, {"signal", signal}};
    const json ev = makeEvent(newUuidV7(), from, nowUnix(), token, payload);
    _t.publish(topics::CallSignal, ev.dump());
}

void CallClient::invite(const std::string &from, const std::string &to,
                        const std::string &token, const std::string &callId,
                        const std::string &media, const std::string &sdp,
                        const std::string &sig) {
    send(from, to, token, inviteSignal(callId, media, sdp, sig));
}

void CallClient::answer(const std::string &from, const std::string &to,
                        const std::string &token, const std::string &callId,
                        const std::string &sdp, const std::string &sig) {
    send(from, to, token, answerSignal(callId, sdp, sig));
}

void CallClient::reject(const std::string &from, const std::string &to,
                        const std::string &token, const std::string &callId,
                        const std::optional<std::string> &reason) {
    send(from, to, token, rejectSignal(callId, reason));
}

void CallClient::ice(const std::string &from, const std::string &to,
                     const std::string &token, const std::string &callId,
                     const std::string &candidate) {
    send(from, to, token, iceSignal(callId, candidate));
}

void CallClient::hangup(const std::string &from, const std::string &to,
                        const std::string &token, const std::string &callId) {
    send(from, to, token, hangupSignal(callId));
}

void CallClient::onSignal(
        const std::string &me,
        std::function<void(std::string from, CallSignalIn signal)> handler) {
    _t.subscribe(callInbox(me),
                 [handler = std::move(handler)](std::string, std::string payload) {
                     try {
                         const json ev = json::parse(payload);
                         // relay = ParvaneEvent<CallSignal>: from = инициатор,
                         // payload = сам сигнал.
                         const std::string from = ev.value("from", std::string());
                         const auto it = ev.find("payload");
                         if (it == ev.end() || !it->is_object()) return;
                         handler(from, CallSignalIn::fromJson(*it));
                     } catch (...) {
                         // битый сигнал — игнор (не критичный путь).
                     }
                 });
}

std::vector<CallRecord> CallClient::history(const std::string &from,
                                            const std::string &token, int timeoutMs) {
    const json ev = makeEvent(newUuidV7(), from, nowUnix(), token, json::object());
    const std::string raw =
        _t.request(topics::CallHistoryRequest, ev.dump(), timeoutMs);
    return CallHistoryResponse::fromJson(json::parse(raw)).calls;
}

} // namespace parvane
