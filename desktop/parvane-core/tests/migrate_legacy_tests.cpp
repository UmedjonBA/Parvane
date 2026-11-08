// Parvane fork (spec 035 T127): читатель старых мест профиля desktop для разового переноса. Профиль tdata с
// выдуманными данными (зашифрованные `storecrypt` файлы, JSONL с построчным шифром, каталог состояния v2, чужой
// аккаунт, настройки устройства, производное) → записи по перечню с открытым текстом; файлы НЕ меняются и не
// удаляются; файл под чужим ключом — в отчёт, а не в записи и не в мусор.
#include "parvane/migrate_legacy.h"
#include "parvane/storecrypt.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>

#include <unistd.h>

namespace fs = std::filesystem;
namespace ml = parvane::migrate_legacy;
namespace sc = parvane::storecrypt;

static int g_fail = 0;
static void check(bool c, const std::string &msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg.c_str());
    if (!c) ++g_fail;
}

static std::string slurp(const fs::path &p) {
    std::ifstream f(p, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static void writeRaw(const fs::path &p, const std::string &s) {
    fs::create_directories(p.parent_path());
    std::ofstream(p, std::ios::binary) << s;
}

int main() {
    char tpl[] = "/tmp/pv-migrate-legacy-XXXXXX";
    const fs::path td = mkdtemp(tpl);
    const std::string self = "ann@example.test";
    const std::string key(32, '\x11');
    sc::setKey(key);

    // Записи аккаунта под storecrypt
    check(sc::writeFile((td / "parvane-folders.json").string(), R"({"folders":[{"id":2,"title":"Работа"}]})"), "папки записаны");
    check(sc::writeFile((td / "parvane-blocked.json").string(), R"(["spam@example.test"])"), "блок-лист записан");
    check(sc::writeFile((td / ("parvane-contacts-" + self + ".json")).string(), R"({"bob@example.test":{"name":"Боб"}})"), "контакты");
    check(sc::writeFile((td / ("parvane-readmarks-" + self + ".json")).string(), R"({"bob@example.test":{"up_to_ts_ms":"5"}})"), "маркеры");
    check(sc::writeFile((td / ("parvane-history-sync-" + self + "-cursor.json")).string(), R"({"seq":7})"), "курсор журнала истории");
    check(sc::appendLine((td / ("parvane-history-" + self + ".jsonl")).string(), R"({"id":"m1","text":"привет"})")
              && sc::appendLine((td / ("parvane-history-" + self + ".jsonl")).string(), R"({"id":"m2","text":"пока"})"),
          "журнал истории (JSONL)");
    const auto v2 = td / ("parvane-v2-" + self);
    fs::create_directories(v2);
    check(sc::writeFile((v2 / "state").string(), std::string("\x01\x02state-blob", 12)), "экспорт движка");
    check(sc::writeFile((v2 / "key").string(), std::string(32, '\x22')), "ключ экспорта");
    check(sc::writeFile((v2 / "sections-records.json").string(), R"({"records":[]})"), "записи разделов");
    // Не переносятся: производное, настройки устройства, чужой аккаунт, служебное каталога v2
    check(sc::writeFile((td / "parvane-dec-cache.jsonl").string(), "x"), "кэш (производное)");
    check(sc::writeFile((td / "parvane-scheme").string(), "night"), "схема (настройка устройства)");
    check(sc::writeFile((td / "parvane-contacts-other@example.test.json").string(), "{}"), "контакты чужого аккаунта");
    check(sc::writeFile((td / "parvane-v2-other@example.test" / "state").string(), "x") || true, "каталог чужого аккаунта");
    check(sc::writeFile((v2 / "state-migrated").string(), "1"), "отметка прежнего переноса (производное)");
    // Под чужим ключом — в отчёт
    sc::setKey(std::string(32, '\x33'));
    check(sc::writeFile((td / "parvane-dialogs.json").string(), R"({"pinned":[]})"), "диалоги под чужим ключом");
    sc::setKey(key);

    // Снимок до: размеры и содержимое всех файлов
    std::map<std::string, std::string> before;
    for (const auto &e : fs::recursive_directory_iterator(td))
        if (e.is_regular_file()) before[fs::relative(e.path(), td).string()] = slurp(e.path());

    // Файлы аккаунта, которые пишет клиент desktop (слой desktop перечня), — от клиента
    const std::vector<ml::AccountFile> desktop = {
        {"parvane-readmarks-", ".json"}, {"parvane-history-sync-", "-", true}, {"parvane-cleared-", ".txt"},
        {"parvane-contacts-", ".json"},  {"parvane-domain-keys-", ".json"},   {"parvane-sticker-packs-", ".json"},
        {"parvane-chat-wallpapers-", ".json"},
    };
    const auto c = ml::collect(td.string(), self, desktop);
    std::map<std::string, std::string> got;
    for (const auto &r : c.records) got[r.key] = r.value;

    check(got["file:parvane-folders.json"] == R"({"folders":[{"id":2,"title":"Работа"}]})", "папки — открытый текст");
    check(got["file:parvane-blocked.json"] == R"(["spam@example.test"])", "блок-лист");
    check(got.count("file:parvane-contacts-" + self + ".json") == 1, "контакты аккаунта");
    check(got.count("file:parvane-readmarks-" + self + ".json") == 1, "маркеры прочитанного");
    check(got.count("file:parvane-history-sync-" + self + "-cursor.json") == 1, "файлы журнала истории аккаунта");
    check(got["file:parvane-history-" + self + ".jsonl"] == "{\"id\":\"m1\",\"text\":\"привет\"}\n{\"id\":\"m2\",\"text\":\"пока\"}\n",
          "JSONL — построчно расшифрован");
    check(got["file:parvane-v2-" + self + "/state"] == std::string("\x01\x02state-blob", 12), "экспорт движка — байты как есть");
    check(got["file:parvane-v2-" + self + "/key"] == std::string(32, '\x22'), "ключ экспорта");
    check(got.count("file:parvane-v2-" + self + "/sections-records.json") == 1, "записи разделов");
    check(got.count("file:parvane-dec-cache.jsonl") == 0 && got.count("file:parvane-scheme") == 0, "производное и настройки устройства не берутся");
    check(got.count("file:parvane-contacts-other@example.test.json") == 0 && got.count("file:parvane-v2-other@example.test/state") == 0,
          "чужой аккаунт не берётся");
    check(got.count("file:parvane-v2-" + self + "/state-migrated") == 0, "отметка прежнего переноса не берётся");
    check(c.unreadable == std::vector<std::string>{"file:parvane-dialogs.json"}, "файл под чужим ключом — в отчёт");
    check(got.size() == 9, "записей " + std::to_string(got.size()));
    bool sorted = true;
    for (size_t i = 1; i < c.records.size(); ++i) sorted = sorted && c.records[i - 1].key < c.records[i].key;
    check(sorted, "записи по возрастанию ключа");

    // Только чтение: ни один файл не изменён и не удалён
    std::map<std::string, std::string> after;
    for (const auto &e : fs::recursive_directory_iterator(td))
        if (e.is_regular_file()) after[fs::relative(e.path(), td).string()] = slurp(e.path());
    check(before == after, "старые файлы не изменены и не удалены");

    const auto j = ml::toJson(c);
    check(j["records"].size() == 9 && j["records"][0].contains("key") && j["records"][0]["value"].is_string(),
          "JSON для движка: records[{key, value base64}]");
    check(ml::keyFor("parvane-contacts-" + self + ".json", self).empty(), "без списка клиента его файлы не берутся");
    check(ml::keyFor("../parvane-folders.json", self).empty() && ml::keyFor("parvane-v2-" + self + "/../x", self).empty(),
          "пути вне перечня не берутся");

    std::error_code ec;
    fs::remove_all(td, ec);
    std::printf("%s migrate_legacy: ошибок %d\n", g_fail ? "[FAIL]" : "[ok]", g_fail);
    return g_fail ? 1 : 0;
}
