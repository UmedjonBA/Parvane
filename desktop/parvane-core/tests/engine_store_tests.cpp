// Parvane fork (spec 035 T048): хранилище движка ядра (`engine_store`) — `pv_store_*` поверх `store_fs`.
//  - запись/чтение/удаление, перезапуск тем же ключом устройства, чужой ключ — отказ открытия;
//  - на диске нет открытого текста; запись другого профиля не открывается (AAD по store_id);
//  - смена ключа устройства — пачка корня, записи не перешифровываются (файлы записей те же);
//  - смена DEK поколением: после переноса всё читается, прежнего поколения на диске нет, перезапуск;
//  - отказ записи посреди переноса: откат, прежнее поколение активно, все записи читаются;
//  - spec 036 T031: файлы хоста (`HostFiles`, вид host-file): разовый перенос файла storecrypt (целиком и JSONL),
//    отметка и данные одной пачкой, сверка, прежний файл → `.migrated`; отказ носителя на любом шаге — прежний
//    файл на месте и читается, повтор доходит до конца; испорченный — в карантин, остальное переносится.
// Данные выдуманные.
#include "parvane/engine_store.h"
#include "parvane/storecrypt.h"
#include "parvane/v2_session.h"

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

static void writeOld(const std::string &path, const std::string &bytes) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    f << bytes;
}

static void hostFiles(const std::filesystem::path &base) {
    namespace sc = parvane::storecrypt;
    const auto store = (base / "host" / "parvane-store").string();
    const auto tdata = base / "host";
    std::filesystem::create_directories(tdata);
    sc::setKey(std::string(32, '\x11'));
    const auto oldJson = (tdata / "parvane-folders.json").string();
    const auto oldLines = (tdata / "parvane-cleared.jsonl").string();
    const auto oldBad = (tdata / "parvane-broken.json").string();
    writeOld(oldJson, sc::seal(R"({"folders":["Работа-выдуманная"]})"));
    writeOld(oldLines, sc::sealLine("uuid-1") + "\n" + sc::sealLine("uuid-2") + "\n");
    writeOld(oldBad, std::string("PVSE1") + std::string(40, '\x7f'));
    std::string err;
    using M = es::HostFiles::Moved;
    // Отказ носителя на каждом шаге фиксации пачки: прежний файл на месте и читается, отметки нет
    for (int failAt = 0; failAt < 3; ++failAt) {
        FailingFs fs;
        auto h = es::HostFiles::open(store, kDevice, &err, fs);
        if (!h) return check(false, "host-file: открыт: " + err);
        fs.renames = 0;
        fs.failAt = failAt;
        const auto r = h->migrateFrom("parvane-folders.json", oldJson, &err);
        if (r == M::Failed) {
            check(std::filesystem::exists(oldJson) && sc::readFile(oldJson).find("Работа-выдуманная") != std::string::npos,
                  "отказ на шаге " + std::to_string(failAt) + ": прежний файл цел");
            check(!h->migrated("parvane-folders.json"), "отказ на шаге " + std::to_string(failAt) + ": отметки нет");
        } else {
            // Пачка дошла, отказал только rename прежнего файла: перенос состоялся, прежний — на месте до повтора
            check(r == M::Moved && h->read("parvane-folders.json").has_value(),
                  "шаг " + std::to_string(failAt) + ": перенос состоялся");
            break;
        }
    }
    {
        auto h = es::HostFiles::open(store, kDevice, &err);
        if (!h) return check(false, "host-file: повторное открытие: " + err);
        const auto r = h->migrateFrom("parvane-folders.json", oldJson, &err);
        check(r == M::Moved || r == M::Already, "повтор переноса доходит до конца");
        check(h->read("parvane-folders.json") == std::optional<std::string>(R"({"folders":["Работа-выдуманная"]})"),
              "данные перенесены без потерь");
        check(!std::filesystem::exists(oldJson) && std::filesystem::exists(oldJson + ".migrated"),
              "прежний файл — .migrated");
        check(h->migrateFrom("parvane-folders.json", oldJson, &err) == M::Already, "второй перенос — уже");
        check(h->migrateFrom("parvane-none.json", (tdata / "parvane-none.json").string(), &err) == M::Missing,
              "нет прежнего файла — нечего переносить");
        check(h->migrateFrom("parvane-cleared.jsonl", oldLines, &err) == M::Moved
                  && h->read("parvane-cleared.jsonl") == std::optional<std::string>("uuid-1\nuuid-2\n"),
              "JSONL — построчно");
        check(h->migrateFrom("parvane-broken.json", oldBad, &err) == M::Quarantined && h->migrated("parvane-broken.json")
                  && !h->read("parvane-broken.json") && std::filesystem::exists(oldBad + ".quarantined"),
              "испорченный — в карантин, не данными");
        check(h->write("parvane-new.json", "новое", &err) && h->read("parvane-new.json") == std::optional<std::string>("новое"),
              "запись и чтение");
        const auto names = h->names("parvane-");
        check(names.size() == 3, "имена без отметок переноса: " + std::to_string(names.size()));
        check(!h->write("migrated:x", "1", &err), "имя отметки записью не подделать");
    }
    check(dirBytes(store).find("Работа-выдуманная") == std::string::npos, "в хранилище нет открытого текста");
    auto h = es::HostFiles::open(store, kDevice, &err);
    check(h && h->read("parvane-new.json") == std::optional<std::string>("новое"), "перезапуск — данные на месте");
    sc::setKey(std::string());
}

// Воронка каталога состояния сессии (spec 036 T031): id устройства прежней версии (файл storecrypt `device`) после
// включения файлов хоста читается тем же — перенесён в хранилище движка, прежний файл → `.migrated`; новое
// устройство не заводится (иначе — новое устройство и привязка заново).
// spec 036 T036 (android): файлы каталога хоста по пути — разовый перенос СУЩЕСТВУЮЩЕГО прежнего файла (сессия,
// владелец, доверие, служебное журнала истории — файлы storecrypt установки прежней версии), затем чтение и запись
// записями хранилища движка; переживает перезапуск; удаление снимает и перенесённую копию; без ключа и вне каталога —
// прежний путь.
static void pathFiles(const std::filesystem::path &base) {
    namespace sc = parvane::storecrypt;
    const auto dir = (base / "seam").string();
    std::filesystem::create_directories(dir);
    sc::setKey(std::string(32, '\x22'));
    const auto key = std::string(32, '\x22');
    const auto session = dir + "/session.json";
    const auto owner = dir + "/account-owner";
    const auto lines = dir + "/history-sync-a-pending.jsonl";
    // Прежняя версия: файлы storecrypt (целиком и построчно)
    check(sc::writeFile(session, R"({"self":"alice@local","token":"t-old"})"), "прежний session.json записан");
    check(sc::writeFile(owner, "alice@local"), "прежний account-owner записан");
    check(sc::appendLine(lines, "{\"a\":1}") && sc::appendLine(lines, "{\"b\":2}"), "прежний JSONL записан");
    {
        es::PathFiles pf(dir, key);
        check(pf.exists(session), "перенос: файл есть (через хранилище)");
        check(pf.read(session) == R"({"self":"alice@local","token":"t-old"})", "перенос: содержимое прежнего файла");
        check(!std::filesystem::exists(session) && std::filesystem::exists(session + ".migrated"),
              "перенос: прежний файл переименован в .migrated");
        check(pf.read(owner) == "alice@local", "перенос второго файла");
        check(pf.read(lines) == "{\"a\":1}\n{\"b\":2}\n", "перенос JSONL построчно");
        check(pf.write(session, R"({"self":"alice@local","token":"t-new"})"), "запись после переноса");
        check(!std::filesystem::exists(session), "запись не возвращает прежний файл на диск");
        check(pf.write(dir + "/trust-bob.txt", "секрет"), "новый файл — сразу записью");
        check(!std::filesystem::exists(dir + "/trust-bob.txt"), "новый файл на диске не появляется");
    }
    {
        es::PathFiles pf(dir, key);
        check(pf.read(session) == R"({"self":"alice@local","token":"t-new"})", "после перезапуска — новое значение");
        check(pf.read(dir + "/trust-bob.txt") == "секрет" && pf.exists(dir + "/trust-bob.txt"), "после перезапуска — новый файл");
        pf.remove(session);
        check(!pf.exists(session) && pf.read(session).empty(), "удаление: файла нет");
        check(!std::filesystem::exists(session + ".migrated"), "удаление снимает и перенесённую копию (токен сессии)");
        check(!pf.nameOf(dir + "/host-files/x").has_value() && !pf.nameOf("/elsewhere/x").has_value()
                  && !pf.nameOf(dir + "/../x").has_value(),
              "пути вне каталога и внутри host-files — не записи");
        const auto outside = (base / "outside.txt").string();
        check(pf.write(outside, "вне") && sc::readFile(outside) == "вне", "вне каталога — прежний путь storecrypt");
    }
    {
        es::PathFiles pf(dir, key);
        check(!pf.exists(session), "удаление пережило перезапуск");
    }
    {
        // Без ключа устройства хранилище не открывается — прежний путь (ничего не теряется)
        const auto dir2 = (base / "seam-nokey").string();
        std::filesystem::create_directories(dir2);
        check(sc::writeFile(dir2 + "/session.json", "x"), "прежний файл без ключа");
        es::PathFiles pf(dir2, "");
        check(pf.read(dir2 + "/session.json") == "x" && std::filesystem::exists(dir2 + "/session.json")
                  && !std::filesystem::exists(dir2 + "/host-files"),
              "без ключа — прежний путь, файл на месте");
    }
}

static void sessionFunnel(const std::filesystem::path &base) {
    namespace sc = parvane::storecrypt;
    const auto dir = (base / "parvane-v2-alice@local").string();
    std::filesystem::create_directories(dir);
    sc::setKey(std::string(32, '\x22'));
    writeOld(dir + "/device", sc::seal("dev-0190-выдуманное"));
    parvane::v2::Session::useHostFiles(true);
    check(parvane::v2::Session::deviceIdFor(dir) == "dev-0190-выдуманное", "id устройства прежней версии — тот же");
    check(!std::filesystem::exists(dir + "/device") && std::filesystem::exists(dir + "/device.migrated"),
          "прежний файл — .migrated");
    check(std::filesystem::exists(dir + "/host"), "файлы — в хранилище движка");
    check(parvane::v2::Session::deviceIdFor(dir) == "dev-0190-выдуманное", "повторное чтение — то же");
    // Каталог стёрт (выход) — новое устройство, хранилище открыто заново
    std::filesystem::remove_all(dir);
    const auto fresh = parvane::v2::Session::deviceIdFor(dir);
    check(!fresh.empty() && fresh != "dev-0190-выдуманное" && parvane::v2::Session::deviceIdFor(dir) == fresh,
          "после стирания — новое устройство, стабильно");
    parvane::v2::Session::useHostFiles(false);
    sc::setKey(std::string());
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
    hostFiles(base);
    sessionFunnel(base);
    pathFiles(base);
    std::filesystem::remove_all(base);
    std::printf(g_fail ? "engine_store: %d FAIL\n" : "engine_store: OK\n", g_fail);
    return g_fail ? 1 : 0;
}
