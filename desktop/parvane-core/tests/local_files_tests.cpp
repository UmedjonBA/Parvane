// Parvane fork: тесты локальных файлов экземпляра (ревью безопасности 21 окт 2026, хвосты NAT-16):
// временный каталог экземпляра, стирание прежних общих каталогов, стирание данных при выходе с оградой поздней
// записи, маркер незавершённого выхода, строки журнала клиента.
#include "parvane/local_files.h"
#include "parvane/storecrypt.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include <sys/stat.h>
#include <unistd.h>

namespace fs = std::filesystem;
namespace lf = parvane::localfiles;
namespace sc = parvane::storecrypt;
namespace lp = parvane::logpriv;

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}
static void put(const fs::path &p, const std::string &data) {
    std::ofstream f(p, std::ios::binary);
    f << data;
}
static unsigned mode(const fs::path &p) {
    struct stat st {};
    ::lstat(p.c_str(), &st);
    return st.st_mode & 0777;
}

int main() {
    const auto base = fs::temp_directory_path() / ("pv-localfiles-" + std::to_string(::getpid()));
    fs::remove_all(base);
    const auto instA = base / "instA" / "tdata";
    const auto instB = base / "instB" / "tdata";
    fs::create_directories(instA);
    fs::create_directories(instB);

    // ── п.1: временный каталог — свой у каждого экземпляра, 0700, внутри tdata ──
    {
        sc::allowWrites();
        const auto a = lf::makeTempDir(instA.string(), "cloud");
        const auto a2 = lf::makeTempDir(instA.string(), "cloud");
        const auto b = lf::makeTempDir(instB.string(), "cloud");
        check(!a.empty() && !b.empty() && a != a2, "временный каталог: создан, каждый вызов — новый");
        check(fs::path(a).parent_path().parent_path() == instA / "parvane-tmp"
                  && fs::path(b).parent_path().parent_path() == instB / "parvane-tmp",
              "временный каталог: внутри tdata своего экземпляра, у экземпляров разные");
        check(mode(instA / "parvane-tmp") == 0700 && mode(instA / "parvane-tmp" / "cloud") == 0700 && mode(a) == 0700,
              "временный каталог: все уровни 0700");
        const auto file = (fs::path(a) / "отчёт.pdf").string();
        check(sc::writeRawFile(file, "pdf-bytes") && mode(file) == 0600, "файл во временном каталоге: 0600");
        check(lf::makeTempDir(instA.string(), "../x").empty() && lf::makeTempDir(instA.string(), "").empty(),
              "временный каталог: вид только [a-z0-9-]");
        check(lf::makeTempDir((base / "нет-такого").string(), "cloud").empty(), "временный каталог: без tdata — пусто");
        // ссылка на месте корня — не идём по ней
        const auto outside = base / "outside";
        fs::create_directories(outside);
        fs::remove_all(instB / "parvane-tmp");
        fs::create_directory_symlink(outside, instB / "parvane-tmp");
        check(lf::makeTempDir(instB.string(), "cloud").empty() && fs::is_empty(outside),
              "временный каталог: ссылка вместо корня — отказ, цель не тронута");
        check(lf::wipeTempRoot(instB.string()) && !fs::exists(fs::symlink_status(instB / "parvane-tmp")) && fs::exists(outside),
              "стирание временного: ссылка — сама ссылка");
        check(lf::wipeTempRoot(instA.string()) && !fs::exists(instA / "parvane-tmp") && fs::exists(instB),
              "стирание временного: корень экземпляра целиком, другой экземпляр не тронут");
        check(lf::wipeTempRoot(instA.string()), "стирание временного: уже нет — успех");
        // при ограде записи новых каталогов нет
        sc::blockWrites();
        check(lf::makeTempDir(instA.string(), "media").empty() && !fs::exists(instA / "parvane-tmp"),
              "временный каталог: под оградой не создаётся");
        check(!sc::writeRawFile((instA / "x.bin").string(), "x") && !fs::exists(instA / "x.bin"),
              "открытый файл под оградой не пишется");
        sc::allowWrites();
    }

    // ── п.1: прежние общие каталоги $TMPDIR/parvane-* — стираются свои ──
    {
        const auto shared = base / "shared-tmp";
        fs::create_directories(shared / "parvane-media" / "sub");
        fs::create_directories(shared / "parvane-cloud" / "abc");
        fs::create_directories(shared / "parvane-article");
        put(shared / "parvane-media" / "sub" / "photo.jpg", "jpeg");
        put(shared / "parvane-cloud" / "abc" / "doc.pdf", "pdf");
        fs::create_directories(shared / "other-app");
        put(shared / "other-app" / "keep", "x");
        const auto outside = base / "outside2";
        fs::create_directories(outside);
        put(outside / "keep.txt", "not ours");
        fs::create_directory_symlink(outside, shared / "parvane-embed");
        std::vector<std::string> failed;
        const auto n = lf::removeLegacySharedTemp(shared.string(), &failed);
        check(n == 4 && failed.empty(), "прежние общие каталоги: стёрты 4 (media, cloud, article, ссылка embed)");
        check(!fs::exists(shared / "parvane-media") && !fs::exists(shared / "parvane-cloud")
                  && !fs::exists(fs::symlink_status(shared / "parvane-embed")),
              "прежние общие каталоги: расшифрованных файлов не осталось");
        check(fs::exists(outside / "keep.txt") && fs::exists(shared / "other-app" / "keep"),
              "прежние общие каталоги: цель ссылки и чужие каталоги не тронуты");
        check(lf::removeLegacySharedTemp(shared.string()) == 0, "прежние общие каталоги: повтор — ничего");
    }

    // ── п.3/п.4: стирание при выходе — ограда против поздней записи, маркер, настройки устройства ──
    {
        const auto tdata = base / "wipe" / "tdata";
        fs::create_directories(tdata / "parvane-v2-alice@local");
        fs::create_directories(tdata / "parvane-media-cache");
        sc::setKey(sc::deriveKey("wipe-test"));
        sc::allowWrites();
        put(tdata / "parvane-background", "pattern");
        put(tdata / "key_datas", "tdesktop");
        check(sc::writeFile((tdata / "parvane-v2-alice@local" / "state").string(), "engine")
                  && sc::writeFile((tdata / "parvane-media-cache" / "file1").string(), "jpeg"),
              "стирание: данные аккаунта записаны");
        const auto tmp = lf::makeTempDir(tdata.string(), "media");
        check(!tmp.empty() && sc::writeRawFile((fs::path(tmp) / "photo.jpg").string(), "jpeg"), "стирание: копия во временном");
        check(lf::setLogoutPending(tdata.string()) && lf::logoutPending(tdata.string()), "маркер выхода поставлен");

        // Фоновая задача прежней сессии пишет журнал истории без остановки — и до, и после стирания
        const auto journal = (tdata / "parvane-history-alice@local.jsonl").string();
        const auto records = (tdata / "parvane-v2-alice@local" / "sections-records.json").string();
        std::atomic<bool> stop{false};
        std::atomic<int> before{0}, after{0};
        std::atomic<bool> wiped{false};
        std::thread writer([&] {
            while (!stop) {
                const bool wasWiped = wiped; // до записи: запись, начатая после стирания, обязана получить отказ
                const bool ok1 = sc::appendLine(journal, "{\"id\":\"m1\",\"text\":\"secret\"}");
                const bool ok2 = sc::writeFile(records, "{\"planner\":1}");
                if (wasWiped) {
                    if (ok1 || ok2) ++after;
                } else if (ok1) {
                    ++before;
                }
                std::this_thread::sleep_for(std::chrono::microseconds(200));
            }
        });
        while (before < 20) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        const auto res = lf::wipeAccountData(tdata.string(), {"parvane-background"});
        wiped = true;
        std::this_thread::sleep_for(std::chrono::milliseconds(100)); // писатель продолжает после стирания
        stop = true;
        writer.join();
        check(res.failed.empty() && res.tempWiped && res.removed >= 3, "стирание: данные аккаунта и временный каталог стёрты");
        check(after == 0, "поздняя запись после стирания отклонена (ограда)");
        check(!fs::exists(journal) && !fs::exists(records), "поздняя запись не пересоздала файлы");
        check(!fs::exists(tdata / "parvane-media-cache") && !fs::exists(tdata / "parvane-tmp"),
              "кэш медиа и временный каталог стёрты");
        check(fs::exists(tdata / "parvane-background") && fs::exists(tdata / "key_datas"),
              "настройки устройства и файлы tdesktop целы");
        check(!lf::logoutPending(tdata.string()), "маркер выхода снят последним");
        check(!sc::enabled(), "ключ хранилища сброшен");
        // Новый вход снимает ограду
        sc::setKey(sc::deriveKey("wipe-test-2"));
        sc::allowWrites();
        check(sc::appendLine(journal, "{\"id\":\"m2\"}") && sc::readLines(journal).size() == 1,
              "после allowWrites (новый вход) запись снова идёт");

        // Выход, прерванный посреди: маркер остался — дотереть при старте
        sc::writeFile((tdata / "parvane-session.txt").string(), "alice@local\njwt\n");
        lf::setLogoutPending(tdata.string());
        check(lf::logoutPending(tdata.string()), "прерванный выход: маркер на месте");
        const auto res2 = lf::wipeAccountData(tdata.string(), {"parvane-background"});
        check(res2.failed.empty() && !fs::exists(tdata / "parvane-session.txt") && !lf::logoutPending(tdata.string()),
              "прерванный выход: дотёрто при старте, маркер снят");
        sc::allowWrites();
        sc::setKey("");
    }

    // ── п.2: строки журнала клиента ──
    {
        lp::forget();
        lp::setDevBuild(false);
        check(!lp::keepOnDisk("Parvane: alice@local msg m1: привет", false), "релиз: строка клиента на диск не идёт");
        check(lp::keepOnDisk("Parvane: alice@local msg m1", true), "релиз в режиме отладки: на диск идёт");
        check(lp::keepOnDisk("Moved logging from 'a' to 'b'!", false), "релиз: строки tdesktop — как раньше");
        check(lp::secret("привет") != "привет" && lp::secret("привет").find("привет") == std::string::npos,
              "релиз: содержимое скрыто");
        lp::setDevBuild(true);
        check(lp::keepOnDisk("Parvane: x", false) && lp::secret("привет") == "привет", "dev: как раньше");
        lp::setDevBuild(false);
        for (int i = 0; i < 600; ++i) lp::remember("Parvane: строка " + std::to_string(i));
        const auto r = lp::recent();
        check(r.size() == lp::kRingCapacity && r.front() == "Parvane: строка 100" && r.back() == "Parvane: строка 599",
              "память строк: последние 500");
        lp::forget();
        check(lp::recent().empty(), "память строк: стирается при выходе");
    }

    fs::remove_all(base);
    std::printf("%s\n", g_fail ? "FAILED" : "ALL OK");
    return g_fail ? 1 : 0;
}
