// Parvane: архив стикер-/эмодзи-пака PVPK1 и правила PACK-1/EMOJI-1 — чистый
// код без транспорта, общий для android (JNI) и тестов. Формат байт-в-байт
// совпадает с web (`stickerPacks.ts: buildPvpkArchive/parsePvpkArchive`) и
// desktop (`parvane_client.cpp: BuildPackArchive/UnpackPackArchive`):
//   "PVPK1" + u32 LE длина индекса + JSON [{"name","size"},…] + байты файлов.
// Лимиты: ≤200 файлов, ≤20 МБ; расширения .webp .png .tgs .webm; имена — только
// basename (защита от обхода каталога у получателя).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace parvane::pack {

constexpr const char *kMagic = "PVPK1";
constexpr std::size_t kMaxFiles = 200;
constexpr std::size_t kMaxBytes = 20 * 1024 * 1024;
// EMOJI-1: смещение FNV без последней цифры — исторический формат провода
// (conformance/sync-rules.json → EMOJI-1.offsetBasis/prime).
constexpr std::uint64_t kFnvOffsetBasis = 1469598103934665603ULL;
constexpr std::uint64_t kFnvPrime = 1099511628211ULL;

struct Entry {
    std::string name;  // basename с расширением
    std::string bytes; // содержимое файла
};

// Расширение допустимо (регистр не важен).
bool isAllowedExtension(const std::string &name);
// MIME по расширению: image/webp | image/png | application/x-tgsticker | video/webm; "" — неизвестно.
std::string mimeForName(const std::string &name);

// Собрать архив: недопустимые/пустые файлы пропускаются, порядок сохраняется,
// остановка на лимитах. Пусто — ни одного файла.
std::string build(const std::vector<Entry> &entries);
// Разобрать архив: пусто — битый/сверх лимитов. Имена сводятся к basename.
std::vector<Entry> parse(const std::string &bytes);

// Имя пака как каталог: буквы/цифры/пробел/-/_, trim, ≤32 символа (по code point), fallback "Pack".
std::string sanitizeName(const std::string &name);

// FNV-1a-64 со смещением провода (см. kFnvOffsetBasis), знаковый int64 — как
// docIdFromFileId на desktop и fnv1a64Signed на web.
std::int64_t fnv1a64Signed(const std::string &utf8);
// docId кастом-эмодзи: FNV("pvemoji:<rawName>|<file>") — EMOJI-1.
std::int64_t emojiDocId(const std::string &rawName, const std::string &file);
// id набора стикеров: FNV("pack:<sanitizedName>") — как desktop.
std::int64_t packSetId(const std::string &sanitizedName);
// id набора эмодзи: FNV("pvemoji-set:<rawName>") — как desktop.
std::int64_t emojiSetId(const std::string &rawName);

// PACK-1: загруженную под набор получателей ссылку можно переиспользовать,
// только если новый набор ⊆ старого.
bool canReuseRef(const std::vector<std::string> &uploadedFor,
                 const std::vector<std::string> &recipients);

// Alt-эмодзи по имени файла пака `NN-<hex code point>.<ext>` (как web
// altEmojiForFileName и desktop FeedCustomEmojiSet); иначе fallback.
std::string altEmojiForFileName(const std::string &name, const std::string &fallback);

} // namespace parvane::pack
