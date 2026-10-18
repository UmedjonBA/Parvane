// Parvane fork: такты режима L2 (spec 025) — те же случаи, что web `v2/l2Ticks.test.ts`, без стека.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "parvane/l2_ticker.h"

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

struct Harness {
    std::mutex mu;
    std::vector<std::string> sent;
    std::atomic<bool> active{true};
    parvane::v2::L2Ticker ticker;
    explicit Harness(bool on)
    : ticker(parvane::v2::L2Ticker::Deps{
          [this] { return active.load(); },
          [this](const std::string &method, const std::string &, const std::string &) {
              std::lock_guard<std::mutex> lk(mu);
              sent.push_back(method);
              return std::string();
          },
          [] { return std::make_optional(std::make_pair(std::string("cover"), std::string())); },
          nullptr}) {
        active = on;
    }
    std::vector<std::string> got() {
        std::lock_guard<std::mutex> lk(mu);
        return sent;
    }
    // Дождаться, пока в очереди окажется n записей (submit блокирует свой поток)
    void waitPending(std::size_t n) {
        for (int i = 0; i < 200 && ticker.pending() < n; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
};

int main() {
    std::printf("=== parvane-core: такты L2 (spec 025) ===\n");
    {
        Harness h(false);
        h.ticker.submit("msg.deliver_sealed", "", "");
        check(h.got() == std::vector<std::string>{"msg.deliver_sealed"}, "без L2 запись уходит сразу, шума нет");
    }
    {
        Harness h(true);
        std::thread a([&] { h.ticker.submit("msg.deliver_sealed", "", ""); });
        h.waitPending(1);
        std::thread b([&] { h.ticker.submit("msg.deliver_group", "", ""); });
        h.waitPending(2);
        check(h.got().empty(), "в L2 запись ждёт такта");
        h.ticker.tick();
        check(h.got() == std::vector<std::string>{"msg.deliver_sealed"}, "в L2 — одна запись в такт");
        h.ticker.tick();
        a.join();
        b.join();
        check(h.got() == std::vector<std::string>{"msg.deliver_sealed", "msg.deliver_group"}, "вторая запись — следующим тактом");
        h.ticker.tick();
        check(h.got().size() == 3 && h.got()[2] == "cover" && h.ticker.coversSent() == 1, "пустой такт — пустышка");
    }
    {
        Harness h(true);
        h.ticker.submit("call.signal_sealed", "", "");
        check(h.got() == std::vector<std::string>{"call.signal_sealed"}, "сигналы звонка идут сразу и в L2");
    }
    {
        Harness h(true);
        std::thread a([&] { h.ticker.submit("msg.deliver_sealed", "", ""); });
        std::thread b([&] { h.ticker.submit("msg.deliver_sealed", "", ""); });
        h.waitPending(2);
        h.active = false;
        h.ticker.tick();
        a.join();
        b.join();
        check(h.got() == std::vector<std::string>{"msg.deliver_sealed", "msg.deliver_sealed"},
              "режим выключили — накопленное уходит разом");
    }
    {
        // Поток тактов: короткий такт, запись уходит сама, затем идут пустышки
        std::atomic<int> sends{0};
        parvane::v2::L2Ticker t(parvane::v2::L2Ticker::Deps{
            [] { return true; },
            [&](const std::string &, const std::string &, const std::string &) {
                ++sends;
                return std::string("ok");
            },
            [] { return std::make_optional(std::make_pair(std::string("cover"), std::string())); },
            nullptr, 20, 5});
        t.start();
        const auto r = t.submit("msg.deliver_sealed", "x", "");
        std::this_thread::sleep_for(std::chrono::milliseconds(120));
        t.stop();
        check(r == "ok" && sends.load() >= 3 && t.coversSent() >= 2, "поток тактов: запись и пустышки по таймеру");
    }
    {
        // Ошибка отправки возвращается тому, кто ждал запись
        parvane::v2::L2Ticker t(parvane::v2::L2Ticker::Deps{
            [] { return true; },
            [](const std::string &, const std::string &, const std::string &) -> std::string { throw std::runtime_error("сеть"); },
            [] { return std::nullopt; }, nullptr});
        bool thrown = false;
        std::thread a([&] {
            try {
                t.submit("msg.deliver_sealed", "", "");
            } catch (const std::exception &) {
                thrown = true;
            }
        });
        for (int i = 0; i < 200 && t.pending() < 1; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
        t.tick();
        a.join();
        check(thrown, "ошибка отправки — у ждавшего записи");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
