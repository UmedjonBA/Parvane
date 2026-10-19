// Parvane fork: пауза переподключения (spec 029, T025) — те же случаи, что web `v2/reconnectBackoff.test.ts`.
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/reconnect_backoff.h"

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

int main() {
    using parvane::v2::ReconnectBackoff;
    std::printf("=== parvane-core reconnect backoff tests ===\n");
    {
        ReconnectBackoff b(1000, 60000, [] { return 0.5; });
        std::vector<std::int64_t> delays;
        for (int i = 0; i < 8; ++i) delays.push_back(b.next());
        const std::vector<std::int64_t> want{1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000};
        check(delays == want, "удваивается до потолка и держит потолок");
    }
    {
        ReconnectBackoff low(1000, 60000, [] { return 0.0; });
        ReconnectBackoff high(1000, 60000, [] { return 0.999; });
        check(low.next() == 500, "разброс: нижняя граница −50 %");
        check(high.next() == 1499, "разброс: верхняя граница +50 %");
    }
    {
        ReconnectBackoff b(1000, 60000, [] { return 0.5; });
        (void)b.next();
        (void)b.next();
        b.reset();
        check(b.attempts() == 0, "после reset() попыток 0");
        check(b.next() == 1000, "после reset() — снова с базы");
    }
    {
        ReconnectBackoff b; // свой генератор
        bool inRange = true;
        for (int i = 0; i < 50; ++i) {
            const auto d = b.next();
            if (d < 500 || d > 60000 * 1.5) inRange = false;
        }
        check(inRange, "свой генератор: задержки в [0.5·база, 1.5·потолок]");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
