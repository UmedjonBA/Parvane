// Parvane fork: тесты call-слоя parvane-core (CallClient + call.h-пейлоады)
// против ЖИВОГО бэкенда (NATS + identity + call, поднимает run_all_tests.sh).
//
// Покрытие:
//   A. Чистые (без бэкенда): билдеры сигналов, CallSignalIn/CallRecord::fromJson,
//      CallHistoryResponse::fromJson (конверт и голый payload).
//   B. Живой путь: onSignal(bob) ловит invite от alice (from/type/sdp);
//      история ringing→answered→ended со сменой статуса; reject-поток; ICE не
//      создаёт запись.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "parvane/call.h"
#include "parvane/call_client.h"
#include "parvane/events.h"
#include "parvane/ids.h"
#include "parvane/topics.h"
#include "parvane/transport.h"

using parvane::CallClient;
using parvane::CallRecord;
using parvane::CallSignalIn;
using parvane::json;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}

static std::string env(const char *n, const std::string &d) {
    const char *v = std::getenv(n);
    return (v && *v) ? std::string(v) : d;
}

static void sleepMs(int ms) {
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

static std::string issue(parvane::Transport &tr, const std::string &user) {
    parvane::IssueRequest req{user, "test"};
    auto resp = parvane::IssueResponse::fromJson(
        json::parse(tr.request(parvane::topics::IdentityIssue, req.toJson().dump())));
    return resp.token.value_or("");
}

static const CallRecord *find(const std::vector<CallRecord> &v, const std::string &id) {
    for (const auto &r : v)
        if (r.call_id == id) return &r;
    return nullptr;
}

int main() {
    const std::string url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    std::printf("=== parvane-core call tests (NATS %s) ===\n", url.c_str());

    // ── A. Чистые тесты ───────────────────────────────────────────────────────
    {
        auto inv = parvane::inviteSignal("c1", "audio", "OFFER");
        check(inv["type"] == "invite" && inv["call_id"] == "c1"
                  && inv["media"] == "audio" && inv["sdp"] == "OFFER",
              "inviteSignal — поля");
        auto rej = parvane::rejectSignal("c1", std::nullopt);
        check(rej["type"] == "reject" && rej["reason"].is_null(),
              "rejectSignal(nullopt) — reason=null");
        auto ice = parvane::iceSignal("c1", "cand:1");
        check(ice["type"] == "ice" && ice["candidate"] == "cand:1", "iceSignal — поля");
    }
    {
        json j = {{"type", "invite"}, {"call_id", "c9"}, {"media", "video"}, {"sdp", "S"}};
        auto s = CallSignalIn::fromJson(j);
        check(s.type == "invite" && s.call_id == "c9" && s.media == "video" && s.sdp == "S",
              "CallSignalIn::fromJson — invite");
        auto r = CallSignalIn::fromJson(json{{"type", "reject"}, {"call_id", "c9"},
                                             {"reason", "busy"}});
        check(r.type == "reject" && r.reason.value_or("") == "busy",
              "CallSignalIn::fromJson — reject reason");
    }
    {
        json rec = {{"call_id", "c1"}, {"caller", "a@l"}, {"callee", "b@l"},
                    {"media", "audio"}, {"status", "ended"}, {"started_at", 10},
                    {"ended_at", 20}};
        auto r = CallRecord::fromJson(rec);
        check(r.call_id == "c1" && r.caller == "a@l" && r.callee == "b@l"
                  && r.status == "ended" && r.started_at == 10
                  && r.ended_at.value_or(0) == 20,
              "CallRecord::fromJson — все поля");
        auto ringing = CallRecord::fromJson(json{{"call_id", "c2"}, {"status", "ringing"},
                                                 {"started_at", 5}});
        check(ringing.status == "ringing" && !ringing.ended_at.has_value(),
              "CallRecord::fromJson — ended_at отсутствует");
    }
    {
        json full = {{"from", "call"}, {"payload", {{"calls", json::array({
                        json{{"call_id", "x"}, {"status", "ended"}}})}}}};
        json bare = {{"calls", json::array({json{{"call_id", "y"}, {"status", "missed"}}})}};
        auto r1 = parvane::CallHistoryResponse::fromJson(full);
        auto r2 = parvane::CallHistoryResponse::fromJson(bare);
        check(r1.calls.size() == 1 && r1.calls[0].call_id == "x",
              "CallHistoryResponse::fromJson(конверт)");
        check(r2.calls.size() == 1 && r2.calls[0].call_id == "y",
              "CallHistoryResponse::fromJson(голый payload)");
    }

    // ── B. Живой бэкенд ───────────────────────────────────────────────────────
    parvane::Transport tr;
    try {
        tr.connect(url);
    } catch (const std::exception &e) {
        check(false, "connect к live NATS", e.what());
        std::printf("РЕЗУЛЬТАТ: НЕТ соединения, живые тесты пропущены\n");
        std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
        return 1;
    }

    const std::string alice = "alice@local";
    const std::string bob = "bob@local";
    const std::string jwtAlice = issue(tr, alice);
    const std::string jwtBob = issue(tr, bob);
    check(!jwtAlice.empty() && !jwtBob.empty(), "issue alice+bob токены");

    CallClient cc(tr);

    // B1. onSignal(bob) ловит invite от alice.
    std::mutex mu;
    std::string gotFrom, gotType, gotSdp, gotMedia;
    cc.onSignal(bob, [&](std::string from, CallSignalIn s) {
        std::lock_guard<std::mutex> lk(mu);
        gotFrom = from; gotType = s.type; gotSdp = s.sdp; gotMedia = s.media;
    });
    sleepMs(150); // дать подписке встать

    const std::string callId = parvane::newUuidV7();
    cc.invite(alice, bob, jwtAlice, callId, "audio", "OFFER-SDP");
    sleepMs(400);
    {
        std::lock_guard<std::mutex> lk(mu);
        check(gotFrom == alice && gotType == "invite" && gotSdp == "OFFER-SDP"
                  && gotMedia == "audio",
              "onSignal: bob получил invite от alice",
              gotFrom + " " + gotType + " '" + gotSdp + "'");
    }

    // B2. история alice — звонок ringing, стороны верны.
    {
        auto hist = cc.history(alice, jwtAlice);
        auto *r = find(hist, callId);
        check(r != nullptr, "история alice: звонок найден",
              "total=" + std::to_string(hist.size()));
        if (r) {
            check(r->status == "ringing", "статус ringing", r->status);
            check(r->caller == alice && r->callee == bob, "caller/callee",
                  r->caller + "→" + r->callee);
        }
    }

    // B3. answer → hangup ⇒ ended, ended_at проставлен.
    cc.answer(bob, alice, jwtBob, callId, "ANSWER-SDP");
    sleepMs(250);
    cc.hangup(alice, bob, jwtAlice, callId);
    sleepMs(300);
    {
        auto hist = cc.history(bob, jwtBob);
        auto *r = find(hist, callId);
        check(r && r->status == "ended", "жизненный цикл: статус ended",
              r ? r->status : "не найдено");
        check(r && r->ended_at.has_value() && r->ended_at.value() > 0,
              "ended_at проставлен", r && r->ended_at ? std::to_string(*r->ended_at) : "нет");
    }

    // B4. reject-поток: новый звонок, bob отклоняет ⇒ rejected.
    {
        const std::string cid = parvane::newUuidV7();
        cc.invite(alice, bob, jwtAlice, cid, "video", "OFF2");
        sleepMs(250);
        cc.reject(bob, alice, jwtBob, cid, std::string("занят"));
        sleepMs(300);
        auto hist = cc.history(alice, jwtAlice);
        auto *r = find(hist, cid);
        check(r && r->status == "rejected", "reject-поток: статус rejected",
              r ? r->status : "не найдено");
        check(r && r->media == "video", "media=video сохранена", r ? r->media : "?");
    }

    // B5. ICE до/без invite не создаёт запись звонка.
    {
        const std::string cid = parvane::newUuidV7();
        cc.ice(alice, bob, jwtAlice, cid, "cand:xyz");
        sleepMs(300);
        auto hist = cc.history(alice, jwtAlice);
        check(find(hist, cid) == nullptr, "ICE без invite не создаёт запись");
    }

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
