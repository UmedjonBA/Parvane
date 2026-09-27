// Parvane fork: тесты шифрования локального хранилища (P-13).
#include "parvane/storecrypt.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>

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
    std::printf("%s\n", g_fail ? "FAILED" : "ALL OK");
    return g_fail ? 1 : 0;
}
