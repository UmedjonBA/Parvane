// Parvane fork: e2e ГРУППОВОГО звонка (mesh) против живого call-шарда. Три
// участника (alice/bob/carol): alice инициирует групповой звонок → каждый строит
// P2P с каждым (StubMediaBackend, без звука) → у всех connectedCount()==2.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <thread>

#include "parvane/crypto.h"
#include "parvane/events.h"
#include "parvane/group_call_manager.h"
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
    IssueRequest req{ user, "test" };
    auto resp = IssueResponse::fromJson(
        json::parse(tr.request(topics::IdentityIssue, req.toJson().dump())));
    return resp.token.value_or("");
}
static std::unique_ptr<MediaBackend> makeStub() {
    return std::make_unique<StubMediaBackend>();
}

int main() {
    const std::string url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    std::printf("=== parvane-core group_call tests (NATS %s) ===\n", url.c_str());

    Transport trA, trB, trC;
    try {
        trA.connect(url);
        trB.connect(url);
        trC.connect(url);
    } catch (const std::exception &e) {
        check(false, "connect к live NATS", e.what());
        std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
        return 1;
    }

    const std::string alice = "alice@local", bob = "bob@local", carol = "carol@local";
    const std::string tA = issue(trA, alice), tB = issue(trB, bob), tC = issue(trC, carol);
    check(!tA.empty() && !tB.empty() && !tC.empty(), "issue токенов");

    auto kA = SigningKey::generate();
    auto kB = SigningKey::generate();
    auto kC = SigningKey::generate();
    auto pub = [&](const std::string &p) -> std::string {
        if (p == alice) return kA.publicB64();
        if (p == bob) return kB.publicB64();
        if (p == carol) return kC.publicB64();
        return {};
    };

    CallClient callsA(trA), callsB(trB), callsC(trC);
    GroupCallManager::Callbacks cb;
    cb.peerPubkey = pub;
    GroupCallManager mgrA(callsA, alice, tA, &kA, makeStub, cb);
    GroupCallManager mgrB(callsB, bob, tB, &kB, makeStub, cb);
    GroupCallManager mgrC(callsC, carol, tC, &kC, makeStub, cb);
    mgrA.start();
    mgrB.start();
    mgrC.start();
    sleepMs(200);

    // alice инициирует групповой звонок со всеми.
    mgrA.startCall("gc-1", { alice, bob, carol }, "audio");
    sleepMs(1500); // даём mesh собраться

    check(mgrA.connectedCount() == 2, "alice соединена с 2 участниками",
          "n=" + std::to_string(mgrA.connectedCount()));
    check(mgrB.connectedCount() == 2, "bob соединён с 2 участниками",
          "n=" + std::to_string(mgrB.connectedCount()));
    check(mgrC.connectedCount() == 2, "carol соединена с 2 участниками",
          "n=" + std::to_string(mgrC.connectedCount()));
    check(mgrB.groupCallId() == "gc-1", "bob присоединился к тому же звонку");

    // Выход одного участника: alice выходит → у неё 0.
    mgrA.leave();
    sleepMs(400);
    check(mgrA.connectedCount() == 0, "после leave у alice 0 соединений");

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
