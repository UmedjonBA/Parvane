// Parvane fork (spec 035 T048): хранилище движка ядра (`engine_store`) — `pv_store_*` поверх `store_fs`.
//  - запись/чтение/удаление, перезапуск тем же ключом устройства, чужой ключ — отказ открытия;
//  - на диске нет открытого текста; запись другого профиля не открывается (AAD по store_id);
//  - смена ключа устройства — пачка корня, записи не перешифровываются (файлы записей те же);
//  - смена DEK поколением: после переноса всё читается, прежнего поколения на диске нет, перезапуск;
//  - отказ записи посреди переноса: откат, прежнее поколение активно, все записи читаются.
// Данные выдуманные.
#include "parvane/engine_store.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

#include <unistd.h>

namespace es = parvane::engine_store;
namespace sf = parvane::store_fs;

static int g_fail = 0;
static void check(bool c, const std::string &msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg.c_str());
    if (!c) ++g_fail;
}

static const std::string kDevice(32, '\x5a');
static const std::string kOther(32, '\x33');

// Все байты файлов каталога подряд (поиск открытого текста на диске).
static std::string dirBytes(const std::filesystem::path &dir) {
    std::string out;
    for (const auto &e : std::filesystem::directory_iterator(dir)) {
        std::ifstream f(e.path(), std::ios::binary);
        out.append(std::istreambuf_iterator<char>(f), {});
    }
    return out;
}

// Слой ФС с отказом одного `rename` — номер `failAt` с нуля (нет места посреди переноса; откат уже проходит).
struct FailingFs : sf::FsOps {
    sf::FsOps &real = sf::posixFs();
    int failAt = -1;
    int renames = 0;
    int openWrite(const std::string &p) override { return real.openWrite(p); }
    bool writeAll(int fd, const void *d, size_t n) override { return real.writeAll(fd, d, n); }
    bool fsyncFd(int fd) override { return real.fsyncFd(fd); }
    bool closeFd(int fd) override { return real.closeFd(fd); }
    bool fsyncDir(const std::string &d) override { return real.fsyncDir(d); }
    bool rename(const std::string &a, const std::string &b) override {
        if (renames++ == failAt) return false;
        return real.rename(a, b);
    }
    bool remove(const std::string &p) override { return real.remove(p); }
    std::optional<std::string> readFile(const std::string &p) override { return real.readFile(p); }
    std::vector<std::string> list(const std::string &d) override { return real.list(d); }
    bool mkdirs(const std::string &d) override { return real.mkdirs(d); }
};

static void basics(const std::filesystem::path &base) {
    const auto dir = (base / "basics").string();
    std::string err;
    {
        auto s = es::EngineStore::open(dir, kDevice, &err);
        check(s != nullptr, "новый профиль открыт: " + err);
        if (!s) return;
        check(s->state() == "ready" && s->activeGeneration() == 1, "поколение 1, готово");
        check(s->put("engine-core", "session", "выдуманная-сессия-маркер", &err), "запись");
        check(s->write({{"history-row", "m:1", "строка-1"}, {"history-row", "m:2", "строка-2"},
                        {"history-row", "x:1", "чужой префикс"}}, {}, &err), "пачка записей");
        check(s->get("engine-core", "session") == std::optional<std::string>("выдуманная-сессия-маркер"), "чтение");
        const auto rows = s->list("history-row", "m:");
        check(rows.size() == 2 && rows[0].first == "m:1" && rows[1].second == "строка-2", "список по префиксу");
        check(s->remove("history-row", "m:2", &err) && !s->get("history-row", "m:2"), "удаление");
        check(!s->get("engine-core", "nope"), "нет записи — пусто");
    }
    check(dirBytes(dir).find("выдуманная-сессия-маркер") == std::string::npos, "на диске нет открытого текста");
    {
        auto s = es::EngineStore::open(dir, kDevice, &err);
        check(s && s->get("engine-core", "session") == std::optional<std::string>("выдуманная-сессия-маркер"),
              "перезапуск тем же ключом устройства");
        check(s && s->list("history-row", "m:").size() == 1, "после перезапуска — без удалённого");
    }
    check(es::EngineStore::open(dir, kOther, &err) == nullptr, "чужой ключ устройства — отказ: " + err);
    check(es::EngineStore::open(dir, "short", &err) == nullptr, "ключ не 32 байта — отказ");
}

static void foreignProfile(const std::filesystem::path &base) {
    // Файлы профиля A, подложенные профилю B (тот же ключ устройства), не открываются: AAD — store_id профиля
    const auto a = (base / "pa").string();
    const auto b = (base / "pb").string();
    std::string err;
    {
        auto sa = es::EngineStore::open(a, kDevice, &err);
        auto sb = es::EngineStore::open(b, kDevice, &err);
        check(sa && sb, "два профиля");
        if (!sa || !sb) return;
        sa->put("state-object", "contacts", "секрет-профиля-A", &err);
        sb->put("state-object", "other", "b", &err);
    }
    // Записи A переносим в каталог B, сохраняя корень B
    std::filesystem::path rootB;
    {
        auto sa = es::EngineStore::open(a, kDevice, &err);
        sf::Reads all;
        all.all = true;
        auto fa = sf::Store::open(a);
        auto fb = sf::Store::open(b);
        sf::Batch batch;
        for (auto &p : fa->read(all)) {
            if (p.key != "root") batch.puts.push_back(p);
        }
        check(fb->commit(batch, &err), "подложить записи A в B");
    }
    auto sb = es::EngineStore::open(b, kDevice, &err);
    check(sb && !sb->get("state-object", "contacts"), "чужая запись в своём профиле не открывается");
    check(sb && sb->get("state-object", "other") == std::optional<std::string>("b"), "своя — открывается");
}

static void rewrap(const std::filesystem::path &base) {
    const auto dir = (base / "rewrap").string();
    std::string err;
    auto s = es::EngineStore::open(dir, kDevice, &err);
    if (!s) return check(false, "rewrap: открыт");
    for (int i = 0; i < 50; ++i) s->put("history-row", "m:" + std::to_string(i), "v" + std::to_string(i), &err);
    sf::Reads all;
    all.all = true;
    auto before = sf::Store::open(dir)->read(all);
    check(s->rewrapDevice(kOther, &err), "смена ключа устройства");
    auto after = sf::Store::open(dir)->read(all);
    size_t same = 0;
    for (const auto &p : after) {
        for (const auto &q : before)
            if (p.key == q.key && p.key != "root" && p.value == q.value) ++same;
    }
    check(same == 50, "записи не перешифрованы (те же байты): " + std::to_string(same));
    s.reset();
    check(es::EngineStore::open(dir, kDevice, &err) == nullptr, "прежний ключ больше не открывает");
    auto again = es::EngineStore::open(dir, kOther, &err);
    check(again && again->get("history-row", "m:7") == std::optional<std::string>("v7"), "новый ключ открывает");
}

static void rotation(const std::filesystem::path &base) {
    const auto dir = (base / "rotate").string();
    std::string err;
    {
        auto s = es::EngineStore::open(dir, kDevice, &err);
        if (!s) return check(false, "rotate: открыт");
        std::vector<std::tuple<std::string, std::string, std::string>> rows;
        for (int i = 0; i < 700; ++i) rows.emplace_back("history-row", "m:" + std::to_string(i), "r" + std::to_string(i));
        check(s->write(rows, {}, &err), "700 записей");
        const bool rotated = s->rotate(&err);
        check(rotated, "смена DEK поколением: " + err);
        check(s->activeGeneration() == 2, "активно поколение 2");
        check(s->list("history-row").size() == 700, "все записи читаются");
        sf::Reads g1;
        g1.prefix = "g1/";
        check(sf::Store::open(dir)->read(g1).empty(), "прежнего поколения на диске нет");
    }
    auto s = es::EngineStore::open(dir, kDevice, &err);
    check(s && s->activeGeneration() == 2 && s->get("history-row", "m:699") == std::optional<std::string>("r699"),
          "перезапуск после переноса");
}

static void rotationFailure(const std::filesystem::path &base) {
    const auto dir = (base / "rotate-fail").string();
    std::string err;
    {
        auto s = es::EngineStore::open(dir, kDevice, &err);
        if (!s) return check(false, "rotate-fail: открыт");
        std::vector<std::tuple<std::string, std::string, std::string>> rows;
        for (int i = 0; i < 600; ++i) rows.emplace_back("history-row", "m:" + std::to_string(i), "r" + std::to_string(i));
        s->write(rows, {}, &err);
    }
    FailingFs fs;
    {
        auto s = es::EngineStore::open(dir, kDevice, &err, fs);
        if (!s) return check(false, "rotate-fail: открыт с отказами");
        fs.renames = 0;
        fs.failAt = 2;  // P1 и первая пачка копии — записаны, вторая пачка — нет места
        const bool rotated = s->rotate(&err);
        check(!rotated, "перенос остановлен: " + err);
        fs.failAt = -1;
        check(s->activeGeneration() == 1, "активно прежнее поколение");
        check(s->list("history-row").size() == 600, "все записи читаются после отказа");
    }
    auto s = es::EngineStore::open(dir, kDevice, &err);
    check(s && s->activeGeneration() == 1 && s->list("history-row").size() == 600, "перезапуск после отказа");
    const bool again = s && s->rotate(&err);
    check(again && s->activeGeneration() == 2 && s->list("history-row").size() == 600,
          "повторный перенос доходит до конца: " + err);
}

int main() {
    const auto base = std::filesystem::temp_directory_path() / ("parvane-engine-store-test-" + std::to_string(::getpid()));
    std::filesystem::remove_all(base);
    std::filesystem::create_directories(base);
    basics(base);
    foreignProfile(base);
    rewrap(base);
    rotation(base);
    rotationFailure(base);
    std::filesystem::remove_all(base);
    std::printf(g_fail ? "engine_store: %d FAIL\n" : "engine_store: OK\n", g_fail);
    return g_fail ? 1 : 0;
}
