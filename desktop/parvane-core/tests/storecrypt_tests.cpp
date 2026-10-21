// Parvane fork: тесты шифрования локального хранилища (P-13).
#include "parvane/storecrypt.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <unistd.h>

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}
static std::string raw(const std::string &path) {
    std::ifstream f(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

int main() {
    namespace sc = parvane::storecrypt;
    const auto dir = std::filesystem::temp_directory_path() / "parvane-storecrypt-test";
    std::filesystem::remove_all(dir);
    std::filesystem::create_directories(dir);

    // Без ключа — plain как раньше (legacy/тесты)
    sc::setKey("");
    check(!sc::enabled(), "без ключа: выключено");
    check(sc::seal("abc") == "abc" && sc::open("abc").value_or("") == "abc", "без ключа: seal/open = plain");
    check(sc::writeFile((dir / "plain.json").string(), "{\"a\":1}"), "без ключа: writeFile");
    check(raw((dir / "plain.json").string()) == "{\"a\":1}", "без ключа: файл plain");
    check(sc::appendLine((dir / "j.jsonl").string(), "{\"id\":1}") && sc::appendLine((dir / "j.jsonl").string(), "{\"id\":2}"),
          "без ключа: appendLine");

    // Ключ: deriveKey — 32 байта, детерминирован
    const auto key = sc::deriveKey("os-secret");
    check(key.size() == 32 && key == sc::deriveKey("os-secret") && key != sc::deriveKey("other"), "deriveKey");
    sc::setKey("short");
    check(!sc::enabled(), "ключ не 32 байта — отвергнут");
    sc::setKey(key);
    check(sc::enabled(), "ключ установлен");

    // Миграция: plain-файлы читаются, следующая запись — шифртекст
    check(sc::readFile((dir / "plain.json").string()) == "{\"a\":1}", "миграция: plain читается с ключом");
    check(sc::migrateDir(dir.string()) == 2, "migrateDir: 2 файла перешифрованы");
    check(sc::isSealed(raw((dir / "plain.json").string())), "после миграции файл шифртекст (магия)");
    check(raw((dir / "plain.json").string()).find("\"a\"") == std::string::npos, "в файле нет plain");
    check(sc::readFile((dir / "plain.json").string()) == "{\"a\":1}", "readFile после миграции");
    const auto lines = sc::readLines((dir / "j.jsonl").string());
    check(lines.size() == 2 && lines[0] == "{\"id\":1}" && lines[1] == "{\"id\":2}", "readLines после миграции");
    check(raw((dir / "j.jsonl").string()).find("\"id\"") == std::string::npos
              && raw((dir / "j.jsonl").string()).rfind("PVSE1:", 0) == 0, "jsonl строки зашифрованы");
    check(sc::migrateDir(dir.string()) == 0, "повторная миграция — нечего");

    // Seal/open, порча, чужой ключ
    const auto sealed = sc::seal("secret data");
    check(sc::isSealed(sealed) && sealed != "secret data", "seal даёт шифртекст");
    check(sc::open(sealed).value_or("") == "secret data", "open");
    check(sc::seal("x") != sc::seal("x"), "случайный nonce: разные шифртексты");
    auto tampered = sealed;
    tampered[tampered.size() - 1] ^= 0x01;
    check(!sc::open(tampered).has_value(), "порча тега → nullopt");
    sc::setKey(sc::deriveKey("other"));
    check(!sc::open(sealed).has_value(), "чужой ключ → nullopt");
    check(sc::readFile((dir / "plain.json").string()).empty(), "readFile чужим ключом → пусто");
    sc::setKey(key);
    check(sc::open(sc::seal("")).value_or("x").empty(), "пустой plain");

    // Строки
    const auto l = sc::sealLine("{\"z\":true}");
    check(l.rfind("PVSE1:", 0) == 0 && l.find('\n') == std::string::npos, "sealLine: префикс, без перевода строки");
    check(sc::openLine(l).value_or("") == "{\"z\":true}", "openLine");
    check(sc::openLine("{\"legacy\":1}").value_or("") == "{\"legacy\":1}", "openLine: legacy plain");
    check(!sc::openLine("PVSE1:!!!").has_value(), "openLine: мусор → nullopt");

    // Атомарная запись и права
    check(sc::writeFile((dir / "w.bin").string(), "payload"), "writeFile");
    check(!std::filesystem::exists(dir / "w.bin.tmp"), "tmp убран");
    const auto perms = std::filesystem::status(dir / "w.bin").permissions();
    check((perms & (std::filesystem::perms::group_all | std::filesystem::perms::others_all)) == std::filesystem::perms::none,
          "права 0600");
    check(sc::readFile((dir / "w.bin").string()) == "payload", "readFile");
    check(sc::writeLines((dir / "k.jsonl").string(), {"a", "b"}) && sc::readLines((dir / "k.jsonl").string()).size() == 2,
          "writeLines/readLines");
    // Без ключа шифртекст не читается (не подменяем данными)
    sc::setKey("");
    check(sc::readFile((dir / "w.bin").string()).empty(), "без ключа шифртекст → пусто");
    check(sc::readLines((dir / "k.jsonl").string()).empty(), "без ключа строки → пусто");

    std::filesystem::remove_all(dir);
    // P-13: бинарный формат однозначен — разделитель '\0' после магии; legacy
    // (iv сразу после магии) читается; line-формат ("PVSE1:") не путается с бинарным.
    {
        using namespace parvane::storecrypt;
        setKey(deriveKey("sep-key"));
        const std::string plain = "{\"k\":1}";
        const auto sealed = seal(plain);
        check(sealed.size() > 6 && sealed[5] == '\0', "seal: разделитель \\0 после магии");
        check(isSealed(sealed) && open(sealed).value_or("") == plain, "open: новый формат");
        const auto legacy = sealed.substr(0, 5) + sealed.substr(6);
        check(open(legacy).value_or("") == plain, "open: legacy-бинарный без разделителя читается");
        check(!isSealed("PVSE1:abcd"), "line-формат не считается бинарным sealed");
        // 300 запечатываний подряд: ни одно не путается с line-форматом (раньше ~1/256)
        bool allOk = true;
        for (int i = 0; i < 300; ++i) {
            const auto s2 = seal(plain);
            if (!isSealed(s2) || open(s2).value_or("") != plain) allOk = false;
        }
        check(allOk, "300 seal/open без ложного plain");
    }

    {
        // Журналы с именем не *.jsonl (v2-ids, READ-1, очищенные чаты): миграция
        // не запечатывает их целиком, а уже испорченные — читает и чинит.
        namespace sc = parvane::storecrypt;
        sc::setKey(sc::deriveKey("os-secret"));
        const auto rawOf = [](const std::string &path) {
            std::ifstream f(path, std::ios::binary);
            return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        };
        const auto put = [](const std::string &path, const std::string &data) {
            std::ofstream f(path, std::ios::binary | std::ios::trunc);
            f << data;
        };
        const auto base = std::filesystem::temp_directory_path() / "pv-storecrypt-lines";
        std::filesystem::remove_all(base);
        std::filesystem::create_directories(base);

        // (а) обычный путь: строки дописаны запечатанными, рестарт (миграция), ещё строка
        const auto ids = (base / "v2-ids.txt").string();
        check(sc::appendLine(ids, "uuid-1 bob@local") && sc::appendLine(ids, "uuid-2 bob@local"), "журнал .txt: appendLine");
        check(sc::migrateFile(ids) == 0, "журнал .txt: миграция не трогает построчный файл");
        check(rawOf(ids).rfind("PVSE1:", 0) == 0, "журнал .txt: остался построчным");
        check(sc::appendLine(ids, "uuid-3 bob@local"), "журнал .txt: дозапись после рестарта");
        auto got = sc::readLines(ids);
        check(got.size() == 3 && got[0] == "uuid-1 bob@local" && got[2] == "uuid-3 bob@local", "журнал .txt: все строки читаются");

        // (б) файл, испорченный прежней миграцией: голова запечатана целиком, следом строки
        const auto read = (base / "read.txt").string();
        const std::string head = rawOf(ids); // три запечатанные строки
        put(read, sc::seal(head));
        check(sc::appendLine(read, "uuid-4 bob@local"), "испорченный журнал: дозапись строки");
        got = sc::readLines(read);
        check(got.size() == 4 && got[0] == "uuid-1 bob@local" && got[3] == "uuid-4 bob@local",
              "испорченный журнал: голова и дописанные строки читаются");
        check(sc::migrateFile(read) == 1 && rawOf(read).rfind("PVSE1:", 0) == 0, "испорченный журнал: починен в построчный вид");
        check(sc::readLines(read).size() == 4 && sc::migrateFile(read) == 0, "починенный журнал: строки на месте, повторной миграции нет");

        // (в) старый plain-журнал: первая миграция запечатала целиком, потом дозапись
        const auto cleared = (base / "cleared.txt").string();
        put(cleared, "alice@local 100\nbob@local 200\n");
        check(sc::migrateFile(cleared) == 1, "plain-журнал: первая миграция");
        check(sc::readLines(cleared).size() == 2, "plain-журнал: читается после миграции");
        check(sc::appendLine(cleared, "carol@local 300"), "plain-журнал: дозапись");
        got = sc::readLines(cleared);
        check(got.size() == 3 && got[0] == "alice@local 100" && got[2] == "carol@local 300", "plain-журнал: все строки читаются");
        check(sc::migrateFile(cleared) == 1 && sc::readLines(cleared).size() == 3, "plain-журнал: починен при следующем запуске");

        // обычный файл целиком по-прежнему не трогается
        const auto whole = (base / "session.txt").string();
        check(sc::writeFile(whole, "token") && sc::migrateFile(whole) == 0 && sc::readFile(whole) == "token", "обычный файл: без изменений");
        std::filesystem::remove_all(base);
    }

    // NAT-13: обязательное шифрование — без ключа хелперы открытый текст не пишут
    {
        namespace sc = parvane::storecrypt;
        const auto base = std::filesystem::temp_directory_path() / ("pv-sc-required-" + std::to_string(::getpid()));
        std::filesystem::remove_all(base);
        std::filesystem::create_directories(base);
        const auto file = (base / "parvane-session.txt").string();
        const auto journal = (base / "parvane-history.jsonl").string();
        sc::setKey("");
        sc::setRequired(true);
        check(sc::required(), "NAT-13: обязательное шифрование включено");
        check(!sc::writeFile(file, "alice@local jwt-secret"), "NAT-13: writeFile без ключа — отказ");
        check(!std::filesystem::exists(file), "NAT-13: writeFile без ключа — файла нет");
        check(!sc::appendLine(journal, "{\"text\":\"secret\"}"), "NAT-13: appendLine без ключа — отказ");
        check(!std::filesystem::exists(journal), "NAT-13: appendLine без ключа — файла нет");
        check(!sc::writeLines(journal, {"one", "two"}), "NAT-13: writeLines без ключа — отказ");
        check(!std::filesystem::exists(journal), "NAT-13: writeLines без ключа — файла нет");
        // Старый открытый файл без ключа не трогается (миграция — только с ключом)
        {
            std::ofstream f(file, std::ios::binary);
            f << "legacy-plain";
        }
        check(sc::migrateFile(file) == 0 && sc::readFile(file) == "legacy-plain", "NAT-13: без ключа миграция не пишет");
        // С ключом — пишет запечатанным и перешифровывает старое
        sc::setKey(sc::deriveKey("required-secret"));
        check(sc::migrateFile(file) == 1, "NAT-13: с ключом старый открытый файл перешифрован");
        check(sc::writeFile(file, "alice@local jwt-secret") && sc::readFile(file) == "alice@local jwt-secret",
              "NAT-13: с ключом writeFile пишет и читает");
        {
            std::ifstream f(file, std::ios::binary);
            const std::string raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
            check(sc::isSealed(raw) && raw.find("jwt-secret") == std::string::npos, "NAT-13: на диске — шифртекст");
        }
        check(sc::appendLine(journal, "line-1") && sc::readLines(journal).size() == 1, "NAT-13: с ключом appendLine пишет");
        sc::setRequired(false);
        sc::setKey("");
        check(sc::writeFile(file, "plain-again") && sc::readFile(file) == "plain-again",
              "без обязательного шифрования — прежнее поведение (plain)");
        std::filesystem::remove_all(base);
    }

    // NAT-16: стирание данных Parvane при выходе — только parvane-*, кроме настроек устройства
    {
        namespace sc = parvane::storecrypt;
        namespace fs = std::filesystem;
        const auto base = fs::temp_directory_path() / ("pv-sc-wipe-" + std::to_string(::getpid()));
        const auto tdata = base / "tdata";
        const auto outside = base / "outside";
        fs::remove_all(base);
        fs::create_directories(tdata / "parvane-v2-alice@local");
        fs::create_directories(tdata / "parvane-media" / "sub");
        fs::create_directories(tdata / "D877F783D5D3EF8C");
        fs::create_directories(outside);
        const auto put = [](const fs::path &p, const std::string &data) {
            std::ofstream f(p, std::ios::binary);
            f << data;
        };
        put(tdata / "parvane-v2-alice@local" / "state", "engine");
        put(tdata / "parvane-v2-alice@local" / "device-id", "dev-1");
        put(tdata / "parvane-media" / "sub" / "photo.jpg", "jpeg");
        put(tdata / "parvane-history-alice@local.jsonl", "line");
        put(tdata / "parvane-session.txt", "jwt");
        put(tdata / "parvane-background", "pattern");
        put(tdata / "parvane-scheme", "dark");
        put(tdata / "key_datas", "tdesktop");
        put(tdata / "settingss", "tdesktop");
        put(tdata / "D877F783D5D3EF8C" / "maps", "tdesktop");
        put(outside / "keep.txt", "not ours");
        fs::create_directory_symlink(outside, tdata / "parvane-link");
        std::vector<std::string> failed;
        const auto n = sc::removePrefixed(tdata.string(), "parvane-", {"parvane-background", "parvane-scheme"}, &failed);
        check(n == 5 && failed.empty(), "NAT-16: стёрты 5 записей parvane-* (каталоги целиком, ссылка)");
        check(!fs::exists(tdata / "parvane-v2-alice@local") && !fs::exists(tdata / "parvane-media")
                  && !fs::exists(tdata / "parvane-history-alice@local.jsonl") && !fs::exists(tdata / "parvane-session.txt")
                  && !fs::exists(fs::symlink_status(tdata / "parvane-link")),
              "NAT-16: состояние движка, медиа, журнал, учётные данные стёрты");
        check(fs::exists(tdata / "parvane-background") && fs::exists(tdata / "parvane-scheme"),
              "NAT-16: настройки устройства оставлены");
        check(fs::exists(tdata / "key_datas") && fs::exists(tdata / "settingss") && fs::exists(tdata / "D877F783D5D3EF8C" / "maps"),
              "NAT-16: файлы tdesktop не тронуты");
        check(fs::exists(outside / "keep.txt"), "NAT-16: цель символьной ссылки не тронута");
        check(sc::removePrefixed(tdata.string(), "", {}) == 0 && fs::exists(tdata / "key_datas"),
              "NAT-16: пустой префикс ничего не стирает");
        fs::remove_all(base);
    }

    // Ограда записи (хвост NAT-16): после blockWrites ни один хелпер не пишет, пока не allowWrites
    {
        namespace sc = parvane::storecrypt;
        namespace fs = std::filesystem;
        const auto base = fs::temp_directory_path() / ("pv-sc-fence-" + std::to_string(::getpid()));
        fs::remove_all(base);
        fs::create_directories(base);
        sc::setKey(sc::deriveKey("fence"));
        const auto file = (base / "parvane-session.txt").string();
        const auto journal = (base / "parvane-history.jsonl").string();
        const auto plainOld = (base / "parvane-old.json").string();
        {
            std::ofstream f(plainOld, std::ios::binary);
            f << "legacy-plain";
        }
        sc::blockWrites();
        check(sc::writesBlocked(), "ограда: поставлена");
        check(!sc::writeFile(file, "jwt") && !fs::exists(file), "ограда: writeFile — отказ, файла нет");
        check(!sc::appendLine(journal, "line") && !fs::exists(journal), "ограда: appendLine — отказ, файла нет");
        check(!sc::writeLines(journal, {"a"}) && !fs::exists(journal), "ограда: writeLines — отказ");
        check(sc::migrateFile(plainOld) == 0, "ограда: миграция не пишет");
        check(!sc::writeRawFile((base / "copy.bin").string(), "x") && !fs::exists(base / "copy.bin"),
              "ограда: writeRawFile — отказ");
        check(sc::readFile(plainOld) == "legacy-plain", "ограда: чтение идёт");
        sc::allowWrites();
        check(!sc::writesBlocked() && sc::writeFile(file, "jwt") && sc::readFile(file) == "jwt", "ограда снята: запись идёт");
        sc::setKey("");
        fs::remove_all(base);
    }

    std::printf("%s\n", g_fail ? "FAILED" : "ALL OK");
    return g_fail ? 1 : 0;
}
