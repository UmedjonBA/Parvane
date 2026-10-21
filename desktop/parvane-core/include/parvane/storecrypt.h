// Parvane fork: шифрование локального хранилища клиента (P-13).
// Все файлы, которые ядро и клиенты кладут на диск (Olm-pickle, сессии,
// групповые ключи, JWT, секрет доверия, кэш расшифровки, журнал истории),
// шифруются AES-256-GCM ключом, который клиент получает из ОС:
//   desktop — производная от локального ключа tdesktop (под паскодом);
//   android — случайный ключ, завёрнутый ключом Android Keystore.
// Без установленного ключа (тесты, legacy) файлы пишутся как раньше; чтение
// всегда принимает и plain (миграция: следующая запись — уже шифртекст).
// Формат файла: "PVSE1" || nonce(12) || ciphertext || tag(16).
// Формат строки JSONL: "PVSE1:" + base64(nonce || ciphertext || tag).
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace parvane::storecrypt {

inline constexpr char kMagic[] = "PVSE1";

// Установить ключ (ровно 32 байта); пустая строка — выключить. Потокобезопасно.
void setKey(const std::string &key32);
[[nodiscard]] bool enabled();
// NAT-13: обязательное шифрование. Включено — файловые хелперы (writeFile, appendLine, writeLines,
// migrate*) без ключа или при сбое шифра НЕ пишут открытый текст, а возвращают false (запись
// не сделана). Выключено (по умолчанию: тесты, android до своего ключа) — прежнее поведение.
// Desktop включает при старте: ключ у него есть всегда (локальный ключ tdata).
void setRequired(bool required);
[[nodiscard]] bool required();
// Производная ключа хранилища из произвольного секрета ОС:
// SHA-256("parvane-store-v1" || secret) — 32 байта.
[[nodiscard]] std::string deriveKey(const std::string &secret);

// Файл целиком. Без ключа seal возвращает plain как есть (и при setRequired — хелперы ниже его не пишут).
[[nodiscard]] std::string seal(const std::string &plain);
// nullopt — шифртекст без ключа / порча / чужой ключ. Plain (без магии) — как есть.
[[nodiscard]] std::optional<std::string> open(const std::string &blob);
[[nodiscard]] bool isSealed(const std::string &blob);

// Одна строка JSONL (без '\n').
[[nodiscard]] std::string sealLine(const std::string &plain);
[[nodiscard]] std::optional<std::string> openLine(const std::string &line);

// Файловые хелперы: чтение с расшифровкой ("" — нет файла/не открылся),
// атомарная запись (tmp + rename, права 0600) с шифрованием.
[[nodiscard]] std::string readFile(const std::string &path);
bool writeFile(const std::string &path, const std::string &data);
// Строки JSONL-файла (пустые пропущены; нечитаемые — пропущены).
[[nodiscard]] std::vector<std::string> readLines(const std::string &path);
bool appendLine(const std::string &path, const std::string &line);
bool writeLines(const std::string &path, const std::vector<std::string> &lines);

// Миграция: все обычные файлы каталога (не рекурсивно, кроме `skipPrefix`)
// без магии перезаписываются шифртекстом. Возвращает число перешифрованных.
// JSONL-файлы (расширение .jsonl) перешифровываются построчно.
int migrateDir(const std::string &dir, const std::string &skipPrefix = std::string());
int migrateFile(const std::string &path);

// NAT-16: стереть в каталоге `dir` (не рекурсивно по имени) всё, чьё имя начинается с `prefix`, кроме имён из
// `keep`: файлы, каталоги — целиком, символьные ссылки — сами ссылки (цель не трогается). Прочие имена
// каталога не затрагиваются. Возвращает число стёртых записей; несбывшиеся — в `failed` (имена), если задан.
int removePrefixed(const std::string &dir, const std::string &prefix, const std::vector<std::string> &keep,
                   std::vector<std::string> *failed = nullptr);

// Ограда записи (NAT-16, поздняя запись после стирания). blockWrites() дожидается записей, уже идущих через
// хелперы этого файла (writeFile, appendLine, writeLines, migrate*, writeRawFile), и с этого момента все они
// отказывают (false, на диск ничего), пока не вызван allowWrites(). Так фоновая задача прежней сессии (поток
// разделов, журнал истории, кэш) не пересоздаёт стёртый файл: запись либо закончилась до ограды (и стирается
// вслед за ней), либо отклонена. Desktop ставит ограду при выходе со стиранием и снимает при следующем входе.
void blockWrites();
void allowWrites();
[[nodiscard]] bool writesBlocked();

// Открытый файл под той же оградой (атомарно: tmp + rename, права 0600): расшифрованные копии во временном
// каталоге экземпляра, которые нужны внешнему приложению по пути. Шифрованием НЕ закрывается — только оградой.
bool writeRawFile(const std::string &path, std::string_view data);

} // namespace parvane::storecrypt
