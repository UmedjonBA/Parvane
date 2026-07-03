// Parvane fork: e2e-тест CallManager против ЖИВОГО бэкенда (NATS + identity +
// call, поднимает scripts/run_all_tests.sh). Проверяет ВЕСЬ путь сигналинга без
// звука (StubMediaBackend): alice звонит → bob получает входящий → принимает →
// оба доходят до Active, подписи проверены. Медиа-звук — Э3-b, вживую.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <thread>

#include "parvane/call_manager.h"
#include "parvane/crypto.h"
#include "parvane/events.h"
#include "parvane/stub_media_backend.h"
#include "parvane/topics.h"
#include "parvane/transport.h"

using namespace parvane;
using parvane::crypto::SigningKey;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}
static void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

static std::string env(const char *n, const std::string &d) {
    const char *v = std::getenv(n);
    return (v && *v) ? std::string(v) : d;
}
static std::string issue(Transport &tr, const std::string &user) {
    IssueRequest req{user, "test"};
    auto resp = IssueResponse::fromJson(
        json::parse(tr.request(topics::IdentityIssue, req.toJson().dump())));
    return resp.token.value_or("");
}
static std::unique_ptr<MediaBackend> makeStub() {
    return std::make_unique<StubMediaBackend>();
}

int main() {
    const std::string url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    std::printf("=== parvane-core call_manager tests (NATS %s) ===\n", url.c_str());

    Transport trA, trB;
    try {
        trA.connect(url);
        trB.connect(url);
    } catch (const std::exception &e) {
        check(false, "connect к live NATS", e.what());
        std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
        return 1;
    }

    const std::string alice = "alice@local", bob = "bob@local";
    const std::string tokA = issue(trA, alice), tokB = issue(trB, bob);
    check(!tokA.empty() && !tokB.empty(), "issue токенов alice+bob");

    // Ключи идентичности: каждый знает публичный ключ другого (эмулируем каталог).
    auto keyA = SigningKey::generate();
    auto keyB = SigningKey::generate();

    CallClient callsA(trA), callsB(trB);

    CallManager::Callbacks cbA;
    cbA.peerPubkey = [&](std::string) { return keyB.publicB64(); };
    CallManager::Callbacks cbB;
    cbB.peerPubkey = [&](std::string) { return keyA.publicB64(); };

    CallManager mgrA(callsA, alice, tokA, &keyA, makeStub, cbA);
    CallManager mgrB(callsB, bob, tokB, &keyB, makeStub, cbB);
    mgrA.start();
    mgrB.start();
    sleepMs(200); // дать подпискам встать

    // alice звонит bob.
    mgrA.placeCall(bob, "audio");
    sleepMs(600);

    check(mgrB.state() == CallState::Incoming, "bob получил входящий (Incoming)");
    check(mgrB.peer() == alice, "у bob собеседник = alice", mgrB.peer());
    check(mgrB.peerAuth() == PeerAuth::Verified,
          "подпись invite от alice проверена ключом из каталога");

    // bob принимает.
    mgrB.accept();
    sleepMs(700);

    check(mgrB.state() == CallState::Active, "принявший (bob) → Active");
    check(mgrA.state() == CallState::Active, "инициатор (alice) → Active");
    check(mgrA.peerAuth() == PeerAuth::Verified,
          "alice проверила подпись answer от bob");

    // Отбой инициатором → у обоих Ended.
    mgrA.hangup();
    sleepMs(500);
    check(mgrA.state() == CallState::Ended, "после hangup: инициатор Ended");
    check(mgrB.state() == CallState::Ended, "после hangup: собеседник получил hangup → Ended");

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
