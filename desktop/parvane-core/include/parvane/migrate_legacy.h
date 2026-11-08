// Parvane fork (spec 035 T127, US1, contracts/migration.md): читатель старых мест профиля desktop для разового
// переноса в хранилище движка. Тонкий: открывает старые файлы tdata ТОЛЬКО на чтение, снимает своё шифрование
// хранилища (`storecrypt`) и отдаёт записи как есть — `{key, value}`, где `key` — ключ по перечню
// `specs/035-protocol-evolution/migration-inventory.json` (`file:<путь от tdata>`, каталог состояния v2 —
// `file:parvane-v2-<адрес>/<имя>`), `value` — открытый текст. Разбор форматов — в движке
// (`backend/protocol/src/migrate/core.rs`, `migrateStep{legacy_input}`). Файлы не меняются и не удаляются:
// стирание старого — вручную по решению пользователя (D2), после переноса они только помечаются «перенесено».
//
// Берутся только записи с судьбой `migrate` (производное — `drop-derived`/`recompute` — движок пересчитывает,
// настройки устройства — `keep` — остаются на месте). Общий для desktop; android читает свой профиль сам
// (`MigrateLegacy.kt`), формат записей тот же.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::migrate_legacy {

struct Record {
    std::string key;   // "file:<путь от tdata>"
    std::string value; // открытый текст
};

struct Collected {
    std::vector<Record> records;          // по возрастанию ключа
    std::vector<std::string> unreadable;  // ключи файлов, которые есть, но не открылись (чужой ключ, порча) — в отчёт
    [[nodiscard]] bool empty() const { return records.empty() && unreadable.empty(); }
};

// Файл аккаунта: `<prefix><безопасная часть адреса><suffix>`; many — после суффикса идёт ещё имя
// (`…-history-sync-<s>-<имя>.json`).
struct AccountFile {
    std::string prefix;
    std::string suffix;
    bool many = false;
};

// Собрать записи аккаунта `self` из каталога tdata (ключ `storecrypt` установлен вызывающим). Только чтение.
// Ядро знает свои места (каталог состояния v2, журнал истории, общие файлы личного состояния); файлы аккаунта,
// которые пишет сам клиент (слой desktop перечня: маркеры, контакты, наборы стикеров, …), он передаёт в `extra`.
[[nodiscard]] Collected collect(const std::string &tdataDir, const std::string &self,
                                const std::vector<AccountFile> &extra = {});

// Граница движка: `{"records": [{"key", "value": base64}], "unreadable": [...]}` (LegacyRecord, proto3-JSON).
[[nodiscard]] nlohmann::json toJson(const Collected &c);

// Ключ записи по перечню для имени файла tdata (`""` — файл не переносится: не из перечня, производное, настройка
// устройства или чужой аккаунт). `relPath` — путь от tdata (`parvane-folders.json`, `parvane-v2-<s>/state`).
[[nodiscard]] std::string keyFor(const std::string &relPath, const std::string &self,
                                 const std::vector<AccountFile> &extra = {});

} // namespace parvane::migrate_legacy
