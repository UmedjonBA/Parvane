// Parvane fork (spec 035): файловый адаптер хранилища движка `store_fs` (desktop и android, contracts/storage.md).
//  T016 — общий набор адаптера `proto/parvane/vectors/storage/adapter.json` (пачки, чтения по ключам и
//         префиксу, прерывания на ЛЮБОМ шаге записи слоя ФС, перезапуск, упаковка);
//  T017 — долговечность (FR-028): перед `rename` временного файла вызываются `fsync` самого файла и каталога,
//         после `rename` — снова `fsync` каталога. Слой ФС подменяется (`RecordingFs`, `FaultFs`).
#include "parvane/store_fs.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <string>
#include <vector>

#include <unistd.h>

#include <nlohmann/json.hpp>

#ifndef PARVANE_VECTORS_DIR
#define PARVANE_VECTORS_DIR "../../proto/parvane/vectors"
#endif

namespace sf = parvane::store_fs;
using nlohmann::json;

static int g_fail = 0;
static void check(bool c, const std::string &msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg.c_str());
    if (!c) ++g_fail;
}

static std::string unhex(const std::string &h) {
    std::string out;
    for (size_t i = 0; i + 1 < h.size(); i += 2) out += char(std::stoi(h.substr(i, 2), nullptr, 16));
    return out;
}

// Слой ФС, записывающий порядок вызовов (поверх настоящей ФС).
struct RecordingFs : sf::FsOps {
    sf::FsOps &real = sf::posixFs();
    std::vector<std::string> log;  // "open:<path>", "fsync:<path>", "fsyncdir:<dir>", "rename:<from>><to>"
    std::map<int, std::string> fdPath;
    int openWrite(const std::string &p) override {
        const int fd = real.openWrite(p);
        fdPath[fd] = p;
        log.push_back("open:" + p);
        return fd;
    }
    bool writeAll(int fd, const void *d, size_t n) override { return real.writeAll(fd, d, n); }
    bool fsyncFd(int fd) override {
        log.push_back("fsync:" + fdPath[fd]);
        return real.fsyncFd(fd);
    }
    bool closeFd(int fd) override { return real.closeFd(fd); }
    bool fsyncDir(const std::string &d) override {
        log.push_back("fsyncdir:" + d);
        return real.fsyncDir(d);
    }
    bool rename(const std::string &a, const std::string &b) override {
        log.push_back("rename:" + a + ">" + b);
        return real.rename(a, b);
    }
    bool remove(const std::string &p) override { return real.remove(p); }
    std::optional<std::string> readFile(const std::string &p) override { return real.readFile(p); }
    std::vector<std::string> list(const std::string &d) override { return real.list(d); }
    bool mkdirs(const std::string &d) override { return real.mkdirs(d); }
};

// Слой ФС с отказом на k-м изменяющем шаге (запись, fsync, rename, удаление): после отказа «процесс
// мёртв» — все дальнейшие изменяющие шаги тоже отказывают (как при падении посреди пачки).
struct FaultFs : sf::FsOps {
    sf::FsOps &real = sf::posixFs();
    int failAt = -1;  // номер изменяющего шага (с 1); -1 — без отказов
    int step = 0;
    bool dead = false;
    bool hit() {
        if (dead) return true;
        if (failAt > 0 && ++step >= failAt) {
            dead = true;
            return true;
        }
        return false;
    }
    int openWrite(const std::string &p) override { return hit() ? -1 : real.openWrite(p); }
    bool writeAll(int fd, const void *d, size_t n) override {
        if (hit()) {
            // Частичная запись перед «падением»: половина байтов.
            real.writeAll(fd, d, n / 2);
            return false;
        }
        return real.writeAll(fd, d, n);
    }
    bool fsyncFd(int fd) override { return !hit() && real.fsyncFd(fd); }
    bool closeFd(int fd) override { return real.closeFd(fd); }
    bool fsyncDir(const std::string &d) override { return !hit() && real.fsyncDir(d); }
    bool rename(const std::string &a, const std::string &b) override { return !hit() && real.rename(a, b); }
    bool remove(const std::string &p) override { return !hit() && real.remove(p); }
    std::optional<std::string> readFile(const std::string &p) override { return real.readFile(p); }
    std::vector<std::string> list(const std::string &d) override { return real.list(d); }
    bool mkdirs(const std::string &d) override { return real.mkdirs(d); }
};

static sf::Batch batchOf(const json &step) {
    sf::Batch b;
    for (const auto &p : step.value("puts", json::array())) b.puts.push_back({p["key"].get<std::string>(), unhex(p["value_hex"].get<std::string>())});
    for (const auto &d : step.value("deletes", json::array())) b.deletes.push_back(d.get<std::string>());
    return b;
}

static std::vector<sf::Put> expectOf(const json &arr) {
    std::vector<sf::Put> out;
    for (const auto &e : arr) out.push_back({e["key"].get<std::string>(), unhex(e["value_hex"].get<std::string>())});
    return out;
}

static bool same(const std::vector<sf::Put> &a, const std::vector<sf::Put> &b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i)
        if (a[i].key != b[i].key || a[i].value != b[i].value) return false;
    return true;
}

// Прогнать случай; failAt > 0 — отказ слоя ФС на failAt-м шаге первой прерванной пачки. Вернуть false, если
// при этом failAt шаг не был достигнут (пачка прошла целиком) — перебор точек отказа окончен.
static bool runCase(const json &c, const std::filesystem::path &dir, int failAt, const std::string &tag) {
    std::filesystem::remove_all(dir);
    const std::string name = c["name"].get<std::string>() + tag;
    std::string err;
    auto st = sf::Store::open(dir.string(), sf::posixFs(), &err);
    check(st != nullptr, name + ": open " + err);
    if (!st) return false;
    bool reached = true;
    for (const auto &step : c["steps"]) {
        const auto op = step["op"].get<std::string>();
        if (op == "batch") {
            check(st->commit(batchOf(step), &err), name + ": batch " + err);
        } else if (op == "batch_interrupted") {
            FaultFs fault;
            fault.failAt = failAt;
            auto dying = sf::Store::open(dir.string(), fault, &err);
            if (!dying) {
                check(false, name + ": open под отказами " + err);
                return false;
            }
            const bool okCommit = dying->commit(batchOf(step), &err);
            if (okCommit) {
                // Отказ не случился — шагов меньше failAt: точки отказа перебраны.
                reached = false;
                return reached;
            }
            dying.reset();  // «процесс упал»
            st = sf::Store::open(dir.string(), sf::posixFs(), &err);
            check(st != nullptr, name + ": open после падения " + err);
            if (!st) return true;
        } else if (op == "reopen") {
            st.reset();
            st = sf::Store::open(dir.string(), sf::posixFs(), &err);
            check(st != nullptr, name + ": reopen " + err);
            if (!st) return true;
        } else if (op == "pack") {
            check(st->pack(&err), name + ": pack " + err);
        } else if (op == "read") {
            sf::Reads r;
            for (const auto &k : step.value("keys", json::array())) r.keys.push_back(k.get<std::string>());
            r.prefix = step.value("prefix", "");
            r.after = step.value("after", "");
            r.limit = step.value("limit", 0u);
            check(same(st->read(r), expectOf(step["expect"])), name + ": read " + r.prefix + "|" + r.after);
        } else if (op == "expect_one_of") {
            sf::Reads r;
            r.all = true;
            const auto got = st->read(r);
            bool any = false;
            for (const auto &opt : step["options"]) any = any || same(got, expectOf(opt));
            check(any, name + ": пачка атомарна (до или целиком после)");
        } else if (op == "expect_all") {
            sf::Reads r;
            r.prefix = "";
            r.all = true;
            check(same(st->read(r), expectOf(step["entries"])), name + ": expect_all");
        }
    }
    return reached;
}

static void adapterVectors(const std::filesystem::path &base) {
    std::ifstream f(std::string(PARVANE_VECTORS_DIR) + "/storage/adapter.json");
    check(f.good(), "adapter.json открыт");
    if (!f) return;
    const json v = json::parse(f);
    for (const auto &c : v["cases"]) {
        bool interrupted = false;
        for (const auto &s : c["steps"]) interrupted = interrupted || s["op"] == "batch_interrupted";
        if (!interrupted) {
            runCase(c, base / "case", -1, "");
            continue;
        }
        // Все точки отказа слоя ФС во время прерванной пачки.
        int points = 0;
        for (int k = 1; k < 200; ++k) {
            if (!runCase(c, base / "case", k, " [отказ на шаге " + std::to_string(k) + "]")) break;
            ++points;
        }
        check(points >= 4, c["name"].get<std::string>() + ": перебрано точек отказа " + std::to_string(points));
    }
}

// T017: fsync файла и каталога до rename, fsync каталога после.
static void durability(const std::filesystem::path &base) {
    const auto dir = base / "durable";
    std::filesystem::remove_all(dir);
    RecordingFs rec;
    std::string err;
    auto st = sf::Store::open(dir.string(), rec, &err);
    check(st != nullptr, "durable: open " + err);
    if (!st) return;
    rec.log.clear();
    sf::Batch b;
    b.puts.push_back({"root", "\x08\x01"});
    b.puts.push_back({"g1/state-object/A", "aa"});
    check(st->commit(b, &err), "durable: commit " + err);
    auto checkOrder = [&](const std::string &what) {
        int renames = 0;
        for (size_t i = 0; i < rec.log.size(); ++i) {
            const auto &e = rec.log[i];
            if (e.rfind("rename:", 0) != 0) continue;
            ++renames;
            const auto from = e.substr(7, e.find('>') - 7);
            const auto dirOf = std::filesystem::path(from).parent_path().string();
            bool fileSynced = false, dirSynced = false, dirAfter = false;
            for (size_t k = 0; k < i; ++k) {
                if (rec.log[k] == "fsync:" + from) fileSynced = true;
                if (rec.log[k] == "fsyncdir:" + dirOf) dirSynced = true;
            }
            for (size_t k = i + 1; k < rec.log.size(); ++k)
                if (rec.log[k] == "fsyncdir:" + dirOf) dirAfter = true;
            check(fileSynced, what + ": fsync файла до rename " + from);
            check(dirSynced, what + ": fsync каталога до rename " + from);
            check(dirAfter, what + ": fsync каталога после rename " + from);
        }
        check(renames >= 1, what + ": запись через временный файл и rename");
    };
    checkOrder("пачка");
    rec.log.clear();
    check(st->pack(&err), "durable: pack " + err);
    checkOrder("упаковка");
}

// Испорченный файл журнала — явная ошибка открытия, а не тихая потеря пачек.
static void corruption(const std::filesystem::path &base) {
    const auto dir = base / "corrupt";
    std::filesystem::remove_all(dir);
    std::string err;
    {
        auto st = sf::Store::open(dir.string(), sf::posixFs(), &err);
        sf::Batch b;
        b.puts.push_back({"a", "1"});
        st->commit(b, &err);
    }
    for (const auto &e : std::filesystem::directory_iterator(dir)) {
        if (e.path().filename().string().rfind("batch-", 0) != 0) continue;
        std::fstream f(e.path(), std::ios::in | std::ios::out | std::ios::binary);
        f.seekp(-1, std::ios::end);
        f.put('\x7f');
    }
    auto st = sf::Store::open(dir.string(), sf::posixFs(), &err);
    check(st == nullptr && !err.empty(), "испорченный журнал — ошибка открытия: " + err);
}

int main() {
    const auto base = std::filesystem::temp_directory_path() / ("parvane-store-fs-test-" + std::to_string(::getpid()));
    std::filesystem::remove_all(base);
    std::filesystem::create_directories(base);
    adapterVectors(base);
    durability(base);
    corruption(base);
    std::filesystem::remove_all(base);
    std::printf(g_fail ? "store_fs: %d FAIL\n" : "store_fs: OK\n", g_fail);
    return g_fail ? 1 : 0;
}
