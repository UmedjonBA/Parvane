// Parvane fork: правила окна чата desktop (spec 030, «тупики UI» 21 окт 2026) — потолок скачивания вложения,
// клик по стикеру без MTProto, пересылка в группу по правам GROUP-2.
#include "parvane/chat_rules.h"

#include <cstdio>

namespace cr = parvane::chatrules;
namespace bc = parvane::blobcrypt;

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}

int main() {
    // ── потолок скачивания ──
    check(cr::chatBlobCipherCap("file", 1000) == bc::maxCipherSize(1000), "файл: потолок по заявленному размеру");
    check(cr::chatBlobCipherCap("file", 1000) >= 1000 + bc::kHeaderLen + bc::kTagLen,
          "потолок покрывает накладку PVB2");
    check(cr::chatBlobCipherCap("photo", 0) == bc::maxCipherSize(cr::kMaxImageBytes), "фото без размера — предел картинки");
    check(cr::chatBlobCipherCap("sticker", -5) == bc::maxCipherSize(cr::kMaxImageBytes), "стикер с отрицательным размером");
    check(cr::chatBlobCipherCap("photo", std::int64_t(1) << 40) == bc::maxCipherSize(cr::kMaxImageBytes),
          "фото с огромным заявленным размером — не больше предела картинки");
    check(cr::chatBlobCipherCap("video", 0) == bc::maxCipherSize(cr::kMaxFileBytes), "видео без размера — 2 ГиБ");
    check(cr::chatBlobCipherCap("file", std::int64_t(5) << 30) == bc::maxCipherSize(cr::kMaxFileBytes),
          "файл больше 2 ГиБ — 2 ГиБ");
    check(cr::chatBlobCipherCap("pack", 0) == bc::maxCipherSize(cr::kMaxPackArchiveBytes), "архив набора");
    check(cr::chatBlobCipherCap("avatar", 0) < cr::chatBlobCipherCap("file", 0), "аватар меньше файла");
    check(cr::chatBlobCipherCap("anything", 0) != 0, "потолок никогда не 0");

    // ── клик по стикеру ──
    using O = cr::StickerSetOpen;
    check(cr::stickerSetOpenAction(true, false) == O::InstallFromRef, "есть pack_ref — установка");
    check(cr::stickerSetOpenAction(true, true) == O::InstallFromRef, "pack_ref главнее (PACK-2 найдёт уже стоящий)");
    check(cr::stickerSetOpenAction(false, true) == O::ShowLocal, "свой набор — показать локально");
    check(cr::stickerSetOpenAction(false, false) == O::Unavailable, "набор неизвестен — ничего не открывать");

    // ── пересылка в группу ──
    parvane::DefaultPermissions all;
    parvane::DefaultPermissions noMedia;
    noMedia.send_media = false;
    parvane::DefaultPermissions noStickers;
    noStickers.send_stickers_gifs = false;
    parvane::DefaultPermissions readOnly;
    readOnly.send_messages = false;
    const auto photo = parvane::json{{"kind", "photo"}, {"file_id", "f"}};
    const auto sticker = parvane::json{{"kind", "sticker"}, {"file_id", "s"}};
    const auto text = parvane::json{{"kind", "text"}, {"text", "привет"}};
    check(cr::canForwardToGroup("member", false, all, photo), "участник, всё разрешено — фото");
    check(!cr::canForwardToGroup("member", false, noMedia, photo), "участник без медиа — фото нельзя");
    check(cr::canForwardToGroup("member", false, noMedia, text), "участник без медиа — текст можно");
    check(!cr::canForwardToGroup("member", false, noStickers, sticker), "участник без стикеров — стикер нельзя");
    check(!cr::canForwardToGroup("member", false, readOnly, text), "только чтение — ничего");
    check(cr::canForwardToGroup("admin", false, readOnly, photo), "админ не подпадает под права");
    check(cr::canForwardToGroup("owner", true, readOnly, photo), "владелец канала публикует");
    check(!cr::canForwardToGroup("member", true, all, text), "подписчик канала не публикует");
    check(!cr::canForwardToGroup("banned", false, all, text), "исключённый — ничего");
    check(cr::canForwardToGroup("", false, noMedia, photo), "роль неизвестна — решает композер");

    std::printf("%s (%d)\n", g_fail ? "FAIL" : "OK", g_fail);
    return g_fail ? 1 : 0;
}
