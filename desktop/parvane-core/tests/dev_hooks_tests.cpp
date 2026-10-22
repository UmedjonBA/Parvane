// Parvane fork: тесты шлюза dev-хуков, переключателя PARVANE_CA_DIRS, отчёта об ошибке без содержимого и запрета
// дампов памяти (ревью безопасности 21 окт 2026, «dev-сборка и журналы»).
#include "parvane/dev_hooks.h"
#include "parvane/gateway_ws_transport.h"
#include "parvane/local_files.h"
#include "parvane/process_hardening.h"

#include <cstdio>
#include <string>

#if defined(__linux__)
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>
#endif

namespace dh = parvane::devhooks;
namespace lp = parvane::logpriv;

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}

int main() {
    // ── loopback-адреса gateway ──
    check(dh::isLoopbackGatewayUrl("127.0.0.1:9223"), "host:port 127.0.0.1");
    check(dh::isLoopbackGatewayUrl("tcp://127.0.0.1:9223"), "tcp://127.0.0.1");
    check(dh::isLoopbackGatewayUrl("ws://127.0.0.1:9222/ws"), "ws://127.0.0.1/ws");
    check(dh::isLoopbackGatewayUrl("wss://localhost/ws"), "wss://localhost");
    check(dh::isLoopbackGatewayUrl("WS://LOCALHOST:9222/ws"), "регистр не важен");
    check(dh::isLoopbackGatewayUrl("ws://[::1]:9222/ws"), "ws://[::1]");
    check(dh::isLoopbackGatewayUrl("[::1]:9223"), "[::1]:порт");
    check(dh::isLoopbackGatewayUrl("::1"), "голый ::1");
    check(!dh::isLoopbackGatewayUrl(""), "пустой адрес (прод по умолчанию) — нет");
    check(!dh::isLoopbackGatewayUrl("wss://parvane.duckdns.org:20443/ws"), "прод — нет");
    check(!dh::isLoopbackGatewayUrl("ws://localhost.evil.com/ws"), "localhost.evil.com — нет");
    check(!dh::isLoopbackGatewayUrl("ws://127.0.0.1@evil.com/ws"), "userinfo — нет");
    check(!dh::isLoopbackGatewayUrl("ws://evil.com/127.0.0.1"), "loopback в пути — нет");
    check(!dh::isLoopbackGatewayUrl("ws://127.0.0.2:9222/ws"), "127.0.0.2 — нет (только точные имена)");
    check(!dh::isLoopbackGatewayUrl("nats://127.0.0.1:4222"), "чужая схема — нет");
    check(!dh::isLoopbackGatewayUrl("ws://[::1]x/ws"), "мусор после ] — нет");
    check(!dh::isLoopbackGatewayUrl("fe80::1:9223"), "голый не-loopback IPv6 — нет");

    // ── решение шлюза ──
    check(dh::allowed("1", "127.0.0.1:9223"), "флаг + loopback — включены");
    check(!dh::allowed(nullptr, "127.0.0.1:9223"), "без флага — выключены");
    check(!dh::allowed("0", "127.0.0.1:9223"), "флаг 0 — выключены");
    check(!dh::allowed("yes", "127.0.0.1:9223"), "флаг не «1» — выключены");
    check(!dh::allowed("1", "wss://parvane.duckdns.org:20443/ws"), "флаг + прод — выключены");
    check(!dh::allowed("1", ""), "флаг без адреса (прод по умолчанию) — выключены");

    // ── PARVANE_CA_DIRS: по умолчанию разрешено (Android), desktop выключает ──
    check(parvane::GatewayWsTransport::envCaDirsAllowed(), "CA_DIRS: по умолчанию разрешено (Android)");
    parvane::GatewayWsTransport::setEnvCaDirsAllowed(false);
    check(!parvane::GatewayWsTransport::envCaDirsAllowed(), "CA_DIRS: desktop выключает");
    parvane::GatewayWsTransport::setEnvCaDirsAllowed(true);

    // ── отчёт об ошибке: в релизе — память строк, при содержимом в журнале — без журнала ──
    {
        lp::forget();
        lp::setDevBuild(false);
        lp::setLogContent(false);
        lp::remember("Parvane: строка " + lp::secret("секрет"));
        auto r = lp::reportLines();
        check(r.size() == 1 && r.front().find("секрет") == std::string::npos, "релиз: отчёт без содержимого");
        lp::setDevBuild(true);
        lp::forget();
        lp::remember("Parvane: строка " + lp::secret("секрет"));
        r = lp::reportLines();
        check(r.size() == 1 && r.front().find("секрет") == std::string::npos, "dev без флага: отчёт без содержимого");
        lp::setLogContent(true);
        lp::remember("Parvane: строка " + lp::secret("секрет"));
        r = lp::reportLines();
        check(r.size() == 1 && r.front().find("секрет") == std::string::npos && r.front().find("PARVANE_LOG_CONTENT") != std::string::npos,
              "dev с содержимым: журнал не прикладывается");
        lp::setLogContent(false);
        lp::setDevBuild(false);
        lp::forget();
    }

    // ── запрет дампов памяти ──
#if defined(__linux__)
    check(parvane::hardening::disableCoreDumps(), "prctl + setrlimit приняты");
    check(parvane::hardening::coreDumpsDisabled(), "процесс не dumpable, RLIMIT_CORE = 0");
    struct rlimit raise {};
    raise.rlim_cur = RLIM_INFINITY;
    raise.rlim_max = RLIM_INFINITY;
    check(::setrlimit(RLIMIT_CORE, &raise) != 0 || ::geteuid() == 0, "предел core-файла обратно не поднять");
    check(std::fopen("/proc/self/status", "r") != nullptr, "свой /proc/self читается");
#endif

    std::printf("%s\n", g_fail ? "FAILED" : "ALL OK");
    return g_fail ? 1 : 0;
}
