#pragma once
// Parvane fork: правила окна чата desktop, вынесенные из tdesktop ради тестов (spec 030, «тупики UI» 21 окт 2026).
//  * потолок скачивания вложения чата по заявленному размеру и виду (ревью 21 окт 2026, 2.2);
//  * что делает клик по стикеру в чате (окно набора без MTProto, как web: свой набор / pack_ref / ничего);
//  * можно ли переслать содержимое в группу (GROUP-2 на стороне отправителя — для каждого получателя).

#include "parvane/blobcrypt.h"
#include "parvane/group.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace parvane::chatrules {

// ── потолок скачивания вложения ──────────────────────────────────────────────
// Картинки (фото, стикер, превью ссылки, аватар) — десятки МБ; архив набора стикеров/эмодзи — так же;
// файл, видео, гифка, голос — файл облака до 2 ГиБ (spec 016, как web MAX_FILE_BYTES).
inline constexpr std::size_t kMaxImageBytes = std::size_t(64) << 20;
inline constexpr std::size_t kMaxPackArchiveBytes = std::size_t(64) << 20;
inline constexpr std::size_t kMaxFileBytes = std::size_t(2) << 30;

[[nodiscard]] inline std::size_t plainLimitForKind(std::string_view kind) {
    if (kind == "photo" || kind == "sticker" || kind == "avatar" || kind == "preview") {
        return kMaxImageBytes;
    }
    if (kind == "pack") {
        return kMaxPackArchiveBytes;
    }
    return kMaxFileBytes;
}

// Потолок ШИФРТЕКСТА (для downloadBlobCap/downloadBlob): заявленный отправителем размер содержимого
// (`size_bytes`, открытый текст) плюс накладка PVB2 (`blobcrypt::maxCipherSize`), но не больше предела вида.
// Размер не заявлен (0, отрицательный) — предел вида. Никогда не 0 (0 у ядра — «общий потолок 2 ГиБ»).
[[nodiscard]] inline std::size_t chatBlobCipherCap(std::string_view kind, std::int64_t declaredPlainBytes) {
    auto limit = plainLimitForKind(kind);
    if (declaredPlainBytes > 0 && std::uint64_t(declaredPlainBytes) < std::uint64_t(limit)) {
        limit = std::size_t(declaredPlainBytes);
    }
    return blobcrypt::maxCipherSize(limit);
}

// ── клик по стикеру в чате ───────────────────────────────────────────────────
// Как web (StickerSetModal на своих наборах): у принятого стикера есть ссылка на архив набора (pack_ref,
// PACK-1/PACK-2) — предложить установку (уже стоит — «уже есть»); набор есть на устройстве — показать его;
// иначе — ничего не открывать (подсказка). Запроса набора к серверу Telegram нет никогда.
enum class StickerSetOpen {
    InstallFromRef,
    ShowLocal,
    Unavailable,
};

[[nodiscard]] inline StickerSetOpen stickerSetOpenAction(bool hasPackRef, bool localSetLoaded) {
    if (hasPackRef) {
        return StickerSetOpen::InstallFromRef;
    }
    if (localSetLoaded) {
        return StickerSetOpen::ShowLocal;
    }
    return StickerSetOpen::Unavailable;
}

// ── пересылка в группу (GROUP-2, сторона отправителя) ────────────────────────
// Своя роль в группе-получателе: владелец и админ шлют всё; участник канала не публикует; участник группы —
// только разрешённые правами по умолчанию виды; исключённый — ничего. Роль неизвестна (сведения группы ещё
// не пришли) — решает штатная проверка композера, здесь не режем.
[[nodiscard]] inline bool canForwardToGroup(const std::string &ownRole, bool channel,
                                            const DefaultPermissions &perms, const json &content) {
    if (ownRole == "owner" || ownRole == "admin") {
        return true;
    }
    if (ownRole == "banned") {
        return false;
    }
    if (ownRole == "member") {
        return !channel && isContentAllowedForMember(perms, content);
    }
    return true;
}

} // namespace parvane::chatrules
