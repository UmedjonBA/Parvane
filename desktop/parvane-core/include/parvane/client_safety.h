#pragma once
// Parvane fork: мелкие правила клиента desktop без Qt, вынесенные ради тестов (этап 4 ревью 7 ноя 2026).
//  * формат чужой картинки — по сигнатуре, не по плагинам Qt (C7-8): декодер выбирается явно;
//  * экранирование пути в `Exec=` ярлыка автозапуска по спецификации Desktop Entry (C7-5);
//  * выбор устройства звука/камеры по id из настроек tdesktop (ревью UI, п. 22);
//  * группировка подряд идущих элементов альбома (`Media.album_id`, MEDIA-2).

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace parvane::clientsafety {

// ── C7-8: формат по сигнатуре ────────────────────────────────────────────────
// "png", "jpeg", "gif", "webp", "bmp", "tgs" (gzip lottie), "webm" (EBML), "mp4" (ftyp); "" — неизвестно.
[[nodiscard]] inline std::string sniffFormat(std::string_view b) {
    const auto starts = [&](std::string_view sig, std::size_t at = 0) {
        return b.size() >= at + sig.size() && b.substr(at, sig.size()) == sig;
    };
    if (starts(std::string_view("\x89PNG\r\n\x1a\n", 8))) return "png";
    if (starts(std::string_view("\xFF\xD8\xFF", 3))) return "jpeg";
    if (starts("GIF87a") || starts("GIF89a")) return "gif";
    if (starts("RIFF") && starts("WEBP", 8)) return "webp";
    if (starts("BM") && b.size() >= 26) return "bmp";
    if (starts(std::string_view("\x1F\x8B", 2))) return "tgs";
    if (starts(std::string_view("\x1A\x45\xDF\xA3", 4))) return "webm";
    if (starts("ftyp", 4)) return "mp4";
    return {};
}

// Картинка, которую разрешено отдавать Qt-декодеру (QImageReader с явным форматом).
[[nodiscard]] inline bool isDecodableImage(const std::string &format) {
    return format == "png" || format == "jpeg" || format == "gif" || format == "webp" || format == "bmp";
}

// Чужой стикер: только png/webp (картинка), tgs (lottie), webm (видеостикер).
[[nodiscard]] inline bool isAllowedStickerFormat(const std::string &format) {
    return format == "png" || format == "webp" || format == "tgs" || format == "webm";
}

// Чужая «гифка»: GIF либо ролик mp4/webm (так шлют Telegram и web).
[[nodiscard]] inline bool isAllowedGifFormat(const std::string &format) {
    return format == "gif" || format == "mp4" || format == "webm";
}

// ── C7-5: аргумент `Exec=` ярлыка .desktop ───────────────────────────────────
// Значение в кавычках по спецификации Desktop Entry: внутри кавычек `"`, `` ` ``, `$`, `\` экранируются `\`,
// затем уровень строкового значения ключа удваивает каждую `\`; `%` — `%%` (коды полей). Перевод строки / возврат
// каретки / NUL в пути — отказ (ярлык сломался бы новой строкой файла).
[[nodiscard]] inline std::optional<std::string> desktopExecQuote(std::string_view value) {
    std::string inner;
    for (const char c : value) {
        if (c == '\n' || c == '\r' || c == '\0') return std::nullopt;
        if (c == '"' || c == '`' || c == '$' || c == '\\') inner.push_back('\\');
        inner.push_back(c);
    }
    std::string out = "\"";
    for (const char c : inner) {
        if (c == '\\') {
            out += "\\\\";
        } else if (c == '%') {
            out += "%%";
        } else {
            out.push_back(c);
        }
    }
    out.push_back('"');
    return out;
}

// Имя файла автозапуска: свой профиль (`-workdir` не по умолчанию) — свой ярлык, иначе второй профиль затирал
// ярлык первого. tag — короткий отпечаток каталога профиля (пусто — профиль по умолчанию).
[[nodiscard]] inline std::string autostartFileName(std::string_view tag) {
    return tag.empty() ? std::string("parvane-desktop.desktop")
                       : "parvane-desktop-" + std::string(tag) + ".desktop";
}

// ── п. 22: устройство из настроек → имя устройства системы ──────────────────
struct DeviceCandidate {
    std::string name;        // имя для открытия (PulseAudio sink/source, uniqueId камеры)
    std::string description; // человекочитаемое (так его показывает список tdesktop / OpenAL)
};

// selected — id из настроек tdesktop ("" или "default" — по умолчанию). Совпадение имени, затем описания, затем
// описания, вложенного в id (OpenAL Soft добавляет к описанию суффиксы). "" — системное по умолчанию.
[[nodiscard]] inline std::string pickDevice(const std::string &selected, const std::vector<DeviceCandidate> &list) {
    if (selected.empty() || selected == "default") return {};
    for (const auto &d : list) {
        if (d.name == selected) return d.name;
    }
    for (const auto &d : list) {
        if (!d.description.empty() && d.description == selected) return d.name;
    }
    const DeviceCandidate *best = nullptr;
    for (const auto &d : list) {
        if (!d.description.empty() && selected.find(d.description) != std::string::npos
            && (!best || d.description.size() > best->description.size())) {
            best = &d;
        }
    }
    return best ? best->name : std::string();
}

// ── звук звонка без звукового сервера (пара call-web2-desktop2, 8 ноя 2026) ──
// Поток PulseAudio звонка (захват или воспроизведение) не открылся — нет звукового сервера, устройство пропало,
// сервер перезапускается. Прежде StartRecording/StartPlayout ADM возвращали -1: webrtc не слал RTP вовсе (звонок
// «Active», собеседник не получал ни пакета), а сбой посреди звонка после 5 неудачных переоткрытий останавливал
// поток до конца звонка. Теперь поток звонка не сдаётся: пока потока нет, захват отдаёт тишину, воспроизведение
// отбрасывает звук (оба в такт 10 мс), а открыть поток снова пробует раз в retryMs. Без потоков и часов: владелец
// передаёт время сам.
class CallAudioStream {
public:
    static constexpr std::int64_t kRetryMs = 1000;
    static constexpr int kErrorsBeforeReopen = 20;

    explicit CallAudioStream(std::int64_t retryMs = kRetryMs, int errorsBeforeReopen = kErrorsBeforeReopen)
    : retryMs_(retryMs), errorsBeforeReopen_(errorsBeforeReopen) {}

    // Пора открывать поток (его нет, и срок повтора наступил).
    [[nodiscard]] bool shouldOpen(std::int64_t nowMs) const { return !open_ && nowMs >= nextTryMs_; }

    // Итог открытия. true — сбой стоит записать в журнал (первый после старта либо после работавшего потока,
    // чтобы повтор раз в секунду не засыпал журнал).
    bool opened(bool ok, std::int64_t nowMs) {
        errors_ = 0;
        if (ok) {
            open_ = true;
            failureLogged_ = false;
            return false;
        }
        open_ = false;
        nextTryMs_ = nowMs + retryMs_;
        const bool log = !failureLogged_;
        failureLogged_ = true;
        return log;
    }

    // Чтение/запись потока прошли.
    void ioOk() { errors_ = 0; }

    // Чтение/запись потока не прошли. true — поток пора закрыть и открыть заново (серия ошибок подряд);
    // открытие разрешено сразу.
    bool ioFailed(std::int64_t nowMs) {
        if (++errors_ < errorsBeforeReopen_) return false;
        errors_ = 0;
        open_ = false;
        nextTryMs_ = nowMs;
        return true;
    }

    // Поток есть: кадры идут из него. Нет — тишина (захват) либо сброс (воспроизведение).
    [[nodiscard]] bool isOpen() const { return open_; }

private:
    std::int64_t retryMs_;
    int errorsBeforeReopen_;
    std::int64_t nextTryMs_ = 0;
    int errors_ = 0;
    bool open_ = false;
    bool failureLogged_ = false;
};

// ── MEDIA-2: альбом ──────────────────────────────────────────────────────────
// Элемент ленты для группировки: чат, автор, album_id (пусто — не альбом).
struct AlbumSlot {
    std::string chat;
    std::string author;
    std::string albumId;
};

inline constexpr std::size_t kMaxAlbumItems = 10;

// Номер группы для каждого элемента ленты (подряд идущие с одним album_id, автором и чатом, не больше 10 —
// одна группа); у элемента вне альбома своя группа. Номера возрастают с 0.
[[nodiscard]] inline std::vector<std::size_t> albumGroups(const std::vector<AlbumSlot> &feed) {
    std::vector<std::size_t> out(feed.size());
    std::size_t group = 0;
    std::size_t run = 0;
    for (std::size_t i = 0; i < feed.size(); ++i) {
        const auto &cur = feed[i];
        const bool joins = i > 0 && !cur.albumId.empty() && run < kMaxAlbumItems
            && feed[i - 1].albumId == cur.albumId && feed[i - 1].author == cur.author
            && feed[i - 1].chat == cur.chat;
        if (i > 0 && !joins) {
            ++group;
            run = 0;
        }
        out[i] = group;
        ++run;
    }
    return out;
}

} // namespace parvane::clientsafety
