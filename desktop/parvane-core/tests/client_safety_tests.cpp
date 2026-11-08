// Parvane fork: правила клиента desktop без Qt (этап 4 ревью 7 ноя 2026): формат чужой картинки по сигнатуре (C7-8),
// `Exec=` ярлыка автозапуска (C7-5), выбор устройства звука/камеры (п. 22), группировка альбома (MEDIA-2).
#include "parvane/client_safety.h"

#include <cstdio>
#include <string>

namespace cs = parvane::clientsafety;

static int g_fail = 0;
static void check(bool c, const char *msg) {
    std::printf("%s %s\n", c ? "[ok]" : "[FAIL]", msg);
    if (!c) ++g_fail;
}

// Независимый разбор значения `Exec=` по спецификации Desktop Entry: уровень строки ключа (`\\` → `\`, `\s`, `\n`,
// `\t`, `\r`), затем аргумент в кавычках (`\"`, `` \` ``, `\$`, `\\`), затем `%%` → `%`. nullopt — значение негодно.
static std::optional<std::string> parseExec(const std::string &value) {
    std::string level1;
    for (std::size_t i = 0; i < value.size(); ++i) {
        if (value[i] != '\\') {
            level1.push_back(value[i]);
            continue;
        }
        if (++i >= value.size()) return std::nullopt;
        switch (value[i]) {
        case '\\': level1.push_back('\\'); break;
        case 's': level1.push_back(' '); break;
        case 'n': level1.push_back('\n'); break;
        case 't': level1.push_back('\t'); break;
        case 'r': level1.push_back('\r'); break;
        default: return std::nullopt; // GLib: недопустимая последовательность (как `\"` прежнего кода)
        }
    }
    if (level1.size() < 2 || level1.front() != '"' || level1.back() != '"') return std::nullopt;
    std::string arg;
    for (std::size_t i = 1; i + 1 < level1.size(); ++i) {
        const char c = level1[i];
        if (c == '\\') {
            const char n = level1[++i];
            if (n != '"' && n != '`' && n != '$' && n != '\\') return std::nullopt;
            arg.push_back(n);
        } else if (c == '"' || c == '`' || c == '$') {
            return std::nullopt; // зарезервированный символ без экранирования
        } else if (c == '%') {
            if (level1[i + 1] != '%') return std::nullopt;
            arg.push_back('%');
            ++i;
        } else {
            arg.push_back(c);
        }
    }
    return arg;
}

int main() {
    // ── C7-8 ──
    check(cs::sniffFormat(std::string("\x89PNG\r\n\x1a\nxxxx", 12)) == "png", "PNG по сигнатуре");
    check(cs::sniffFormat("\xFF\xD8\xFF\xE0") == "jpeg", "JPEG");
    check(cs::sniffFormat("GIF89a....") == "gif", "GIF");
    check(cs::sniffFormat(std::string("RIFF\x10\0\0\0WEBPVP8 ", 16)) == "webp", "WEBP");
    check(cs::sniffFormat(std::string("\x1F\x8B\x08\0", 4)) == "tgs", "TGS (gzip)");
    check(cs::sniffFormat("\x1A\x45\xDF\xA3....") == "webm", "WEBM");
    check(cs::sniffFormat(std::string("\0\0\0\x20" "ftypisom", 12)) == "mp4", "MP4");
    check(cs::sniffFormat("II*\0").empty(), "TIFF не узнаётся (не наш формат)");
    check(cs::sniffFormat("<svg xmlns=").empty(), "SVG не узнаётся");
    check(cs::sniffFormat(std::string("\0\0\0\x0cjP  ", 8)).empty(), "JPEG 2000 не узнаётся");
    check(cs::isAllowedStickerFormat("webp") && cs::isAllowedStickerFormat("tgs") && !cs::isAllowedStickerFormat("jpeg")
              && !cs::isAllowedStickerFormat(""),
          "стикер: только png/webp/tgs/webm");
    check(cs::isAllowedGifFormat("mp4") && cs::isAllowedGifFormat("gif") && !cs::isAllowedGifFormat("png"),
          "GIF: gif/mp4/webm");
    check(!cs::isDecodableImage("tgs") && cs::isDecodableImage("webp"), "Qt-декодер — только картинки");

    // ── C7-5 ──
    const std::string tricky = "/tmp/a b\"$x%f`y\\z/bin";
    const auto q = cs::desktopExecQuote(tricky);
    check(q.has_value(), "путь с особыми символами экранирован");
    const auto back = q ? parseExec(*q) : std::nullopt;
    check(back && *back == tricky, "разбор по спецификации даёт исходный путь");
    check(!cs::desktopExecQuote("/tmp/a\nb").has_value(), "перевод строки — отказ");
    check(!cs::desktopExecQuote("/tmp/a\rb").has_value(), "возврат каретки — отказ");
    check(parseExec(*cs::desktopExecQuote("/home/u/.local/bin/parvane-desktop")) == std::string("/home/u/.local/bin/parvane-desktop"),
          "обычный путь без изменений");
    check(cs::autostartFileName("") == "parvane-desktop.desktop", "профиль по умолчанию — общий ярлык");
    check(cs::autostartFileName("1a2b3c4d") == "parvane-desktop-1a2b3c4d.desktop", "свой профиль — свой ярлык");

    // ── п. 22 ──
    const std::vector<cs::DeviceCandidate> sinks{
        {"alsa_output.pci.analog-stereo", "Built-in Audio Analog Stereo"},
        {"bluez_output.AA_BB.1", "Наушники"},
        {"alsa_output.usb.analog-stereo", "USB Audio Analog Stereo"},
    };
    check(cs::pickDevice("", sinks).empty(), "пусто — по умолчанию");
    check(cs::pickDevice("default", sinks).empty(), "default — по умолчанию");
    check(cs::pickDevice("bluez_output.AA_BB.1", sinks) == "bluez_output.AA_BB.1", "по имени");
    check(cs::pickDevice("Наушники", sinks) == "bluez_output.AA_BB.1", "по описанию");
    check(cs::pickDevice("OpenAL Soft on USB Audio Analog Stereo", sinks) == "alsa_output.usb.analog-stereo",
          "описание внутри id OpenAL");
    check(cs::pickDevice("нет такого", sinks).empty(), "неизвестное — по умолчанию");

    // ── звук звонка без звукового сервера ──
    {
        cs::CallAudioStream st(1000, 3);
        check(st.shouldOpen(0), "поток открывается сразу при старте");
        check(st.opened(false, 0), "первый сбой открытия пишется в журнал");
        check(!st.isOpen(), "без потока — тишина/сброс, звонок не остановлен");
        check(!st.shouldOpen(999), "повтор не раньше срока");
        check(st.shouldOpen(1000), "повтор через секунду");
        check(!st.opened(false, 1000), "повторные сбои журнал не засыпают");
        check(st.shouldOpen(2000), "звонок не сдаётся после серии сбоев открытия");
        for (int i = 3; i < 20; ++i) st.opened(false, i * 1000);
        check(st.shouldOpen(20000), "и после двадцати сбоев открытия поток ещё пробуется");
        check(!st.opened(true, 20000) && st.isOpen(), "сервер появился — поток открыт");
        check(!st.shouldOpen(20000), "открытый поток не переоткрывается");
        check(!st.ioFailed(20010) && !st.ioFailed(20020), "единичные ошибки чтения поток не закрывают");
        st.ioOk();
        check(!st.ioFailed(20030) && !st.ioFailed(20040), "успех сбрасывает счёт ошибок");
        check(st.ioFailed(20050) && !st.isOpen(), "серия ошибок — поток закрыть");
        check(st.shouldOpen(20050), "после серии ошибок переоткрытие сразу");
        check(st.opened(false, 20050), "сбой после работавшего потока снова пишется в журнал");
    }

    // ── MEDIA-2 ──
    using S = cs::AlbumSlot;
    const auto g = cs::albumGroups({
        S{"c", "a", "X"}, S{"c", "a", "X"}, S{"c", "a", "X"},  // альбом из 3
        S{"c", "a", ""},                                       // одиночное
        S{"c", "a", "Y"}, S{"c", "b", "Y"},                     // другой автор — не вместе
        S{"c", "a", "Z"}, S{"d", "a", "Z"},                     // другой чат — не вместе
    });
    check(g[0] == g[1] && g[1] == g[2], "подряд с одним album_id — одна группа");
    check(g[3] != g[2], "без album_id — своя группа");
    check(g[4] != g[5], "другой автор — разные группы");
    check(g[6] != g[7], "другой чат — разные группы");
    auto eleven = std::vector<S>(11, S{"c", "a", "Q"});
    const auto ge = cs::albumGroups(eleven);
    check(ge[0] == ge[9] && ge[10] != ge[9], "не больше 10 в альбоме");
    const auto split = cs::albumGroups({S{"c", "a", "X"}, S{"c", "a", ""}, S{"c", "a", "X"}});
    check(split[0] != split[2], "альбом, разорванный другим сообщением, — две группы");

    std::printf("%s (%d)\n", g_fail ? "FAIL" : "OK", g_fail);
    return g_fail ? 1 : 0;
}
