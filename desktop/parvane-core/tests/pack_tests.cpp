// Parvane fork: тесты PVPK1 / PACK-1 / EMOJI-1 без стека (spec 005).
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "parvane/pack_archive.h"

using namespace parvane::pack;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(), info.empty() ? "" : (" — " + info).c_str());
}

int main() {
    std::printf("=== parvane-core pack tests (без стека) ===\n");

    // ── round-trip ──
    std::vector<Entry> in = {{"00-1f98b.png", std::string(100, 'a')}, {"dir/01-2728.webp", std::string(5, 'b')},
                             {"bad.txt", "zzz"}, {"empty.png", ""}, {"anim.tgs", "gz"}, {"vid.webm", "webm"}};
    const auto bytes = build(in);
    check(bytes.compare(0, 5, "PVPK1") == 0, "магия PVPK1");
    const auto out = parse(bytes);
    check(out.size() == 4, "round-trip: 4 допустимых файла (txt и пустой отброшены)", std::to_string(out.size()));
    check(out.size() == 4 && out[0].name == "00-1f98b.png" && out[0].bytes.size() == 100, "первый файл и байты");
    check(out.size() == 4 && out[1].name == "01-2728.webp", "имя сведено к basename");
    check(out.size() == 4 && out[2].name == "anim.tgs" && out[3].name == "vid.webm", "порядок сохранён");
    // индекс: длина u32 LE
    std::uint32_t len = 0;
    std::memcpy(&len, bytes.data() + 5, 4);
    check(bytes.substr(9, len).front() == '[', "индекс JSON начинается сразу после длины");

    // ── отказы ──
    check(parse("PVPK").empty(), "короче 9 байт → пусто");
    check(parse(std::string("XXXXX") + std::string(4, '\0')).empty(), "чужая магия → пусто");
    check(build({}).empty(), "пустой список → пустой архив");
    check(build({{"only.txt", "x"}}).empty(), "только недопустимые расширения → пусто");
    {
        std::vector<Entry> many;
        for (int i = 0; i < 205; ++i) many.push_back({"s" + std::to_string(i) + ".png", "x"});
        check(parse(build(many)).size() == kMaxFiles, "лимит 200 файлов");
    }
    {
        std::string big(kMaxBytes - 10, 'q');
        const auto a = build({{"a.png", big}, {"b.png", std::string(100, 'r')}});
        check(parse(a).size() == 1, "лимит 20 МБ: второй файл не влез");
    }
    {
        // подделанный индекс: size больше данных
        std::string forged("PVPK1");
        const std::string idx = R"([{"name":"a.png","size":50}])";
        const auto l = static_cast<std::uint32_t>(idx.size());
        forged.append(reinterpret_cast<const char *>(&l), 4);
        forged.append(idx);
        forged.append("short");
        check(parse(forged).empty(), "индекс требует больше байт, чем есть → пусто");
    }

    for (const char *badIdx : {R"([{"name":"a.png","size":-1},{"name":"b.png","size":1}])", R"([{"name":"a.png","size":"5"}])",
                               R"([{"name":5,"size":1}])", R"([{"name":"a.png"}])"}) {
        // враждебный индекс: отрицательный/нестроковый size и name не должны бросать и раздувать разбор
        std::string forged("PVPK1");
        const std::string idx = badIdx;
        const auto l = static_cast<std::uint32_t>(idx.size());
        forged.append(reinterpret_cast<const char *>(&l), 4);
        forged.append(idx);
        forged.append("xxxxxxxxxx");
        bool threw = false;
        std::vector<Entry> r;
        try { r = parse(forged); } catch (...) { threw = true; }
        check(!threw && r.empty(), "индекс с полями не того типа/знака → пусто без исключения", idx);
    }

    // ── расширения/mime ──
    check(isAllowedExtension("A.WEBP") && isAllowedExtension("x.tgs") && !isAllowedExtension("x.jpg"), "расширения без учёта регистра");
    check(mimeForName("a.png") == "image/png" && mimeForName("a.webm") == "video/webm" && mimeForName("a.tgs") == "application/x-tgsticker" && mimeForName("a.gif").empty(), "mime по расширению");

    // ── sanitize (как web sanitizePackName / desktop SanitizePackName) ──
    check(sanitizeName("  My Pack_1-x!@#  ") == "My Pack_1-x", "sanitize: буквы/цифры/пробел/-/_ и trim", sanitizeName("  My Pack_1-x!@#  "));
    check(sanitizeName("!!!") == "Pack", "sanitize: пусто → Pack");
    check(sanitizeName("Кошки и котики") == "Кошки и котики", "sanitize: кириллица сохраняется");
    check(sanitizeName(std::string(40, 'a')).size() == 32, "sanitize: ≤32");

    // ── EMOJI-1 / id наборов ──
    // Эталон web: fnv1a64Signed('pvemoji:ParvaneEmoji|00-1f98b.png') с offset 1469598103934665603.
    const auto d = emojiDocId("ParvaneEmoji", "00-1f98b.png");
    check(d != 0 && d == fnv1a64Signed("pvemoji:ParvaneEmoji|00-1f98b.png"), "docId = FNV(pvemoji:<raw>|<file>)");
    check(fnv1a64Signed("") == static_cast<std::int64_t>(kFnvOffsetBasis), "FNV пустой строки = смещение провода");
    // Пошаговый эталон для одной буквы: (basis ^ 'a') * prime
    {
        std::uint64_t h = kFnvOffsetBasis; h ^= 'a'; h *= kFnvPrime;
        check(fnv1a64Signed("a") == static_cast<std::int64_t>(h), "FNV-1a: xor затем умножение");
    }
    check(packSetId("Cats") == fnv1a64Signed("pack:Cats") && emojiSetId("ParvaneEmoji") == fnv1a64Signed("pvemoji-set:ParvaneEmoji"), "id наборов по префиксам desktop");
    check(emojiDocId("A", "f.png") != emojiDocId("B", "f.png"), "docId зависит от сырого имени пака");

    // ── PACK-1 ──
    check(canReuseRef({"a@x", "b@x"}, {"a@x"}), "PACK-1: подмножество → можно");
    check(!canReuseRef({"a@x"}, {"a@x", "c@x"}), "PACK-1: новый получатель → нельзя");
    check(canReuseRef({}, {}), "PACK-1: пустые наборы → можно");

    // ── PACK-2: отпечаток содержимого ──
    {
        const Entry a{"a.webp", std::string("\x01\x02\x03", 3)};
        const Entry b{"b.webp", std::string("\x04\x05", 2)};
        const auto one = contentHash({a, b});
        check(one.size() == 32, "PACK-2: отпечаток — 32 байта");
        check(contentHash({b, a}) == one, "PACK-2: от порядка файлов не зависит");
        check(contentHash({a, {"b.webp", std::string("\x04\x06", 2)}}) != one, "PACK-2: другой байт — другой отпечаток");
        check(contentHash({a, {"c.webp", b.bytes}}) != one, "PACK-2: другое имя — другой отпечаток");
        const auto archive = build({b, a});
        const auto hashB64 = archiveContentHashB64(archive);
        // Эталон web (`proto/parvane/vectors/clients/pack-hash.json`, первый случай)
        check(hashB64 == "wOtWDi36OhUURnUZGyYsN5DXpqYeu1MsE3cmIQV/sQM=", "PACK-2: отпечаток архива = вектор web", hashB64);
        check(archiveMatchesContentHash(archive, hashB64), "PACK-2: архив с заявленным отпечатком принят");
        check(archiveMatchesContentHash(archive, ""), "PACK-2: ссылка без отпечатка (старый клиент) — принят");
        check(!archiveMatchesContentHash(build({a}), hashB64), "PACK-2: подменённое содержимое — отказ");
        check(!archiveMatchesContentHash(archive, "не base64!"), "PACK-2: битый отпечаток — отказ");
        check(!archiveMatchesContentHash(archive, "AQID"), "PACK-2: отпечаток не 32 байта — отказ");
        check(!archiveMatchesContentHash("PVPK1", ""), "PACK-2: неразбираемый архив — отказ");
        check(archiveContentHashB64("мусор").empty(), "PACK-2: у битого архива отпечатка нет");
        // Каталог с лишним файлом другого расширения: отпечаток — по тому, что распакует получатель
        check(archiveContentHashB64(build({a, b, {"readme.txt", "x"}})) == hashB64, "PACK-2: недопустимые файлы в отпечаток не входят");
    }

    // ── alt-эмодзи из имени файла ──
    check(altEmojiForFileName("00-1f98b.png", "🙂") == "🦋", "alt: NN-<hex>.<ext> → эмодзи", altEmojiForFileName("00-1f98b.png", "🙂"));
    check(altEmojiForFileName("sticker.webp", "🙂") == "🙂", "alt: без кода → fallback");
    check(altEmojiForFileName("01-zz.png", "🙂") == "🙂", "alt: не hex → fallback");

    std::printf("=== итог: %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
