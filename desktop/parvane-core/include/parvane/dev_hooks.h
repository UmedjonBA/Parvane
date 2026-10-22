// Parvane fork: шлюз dev-хуков клиента (ревью безопасности 21 окт 2026, «dev-сборка и журналы»).
//
// Dev-сборка (-DPARVANE_DEV=ON) понимает переменные окружения сценариев: PARVANE_AUTO* (автовход, автоотправка,
// автоодобрение привязки любого устройства, отправка любого файла …), ws:// и TCP к gateway, PARVANE_WSS_INSECURE.
// Пользователь запускал такую сборку против прода каждый день — любой, кто мог подложить переменную в окружение
// (ярлык, профиль оболочки, systemd --user), получал автоодобрение привязки и выгрузку файлов. Теперь хуки
// действуют только при ОБОИХ условиях: явный PARVANE_DEV_HOOKS=1 и адрес gateway на loopback (127.0.0.1,
// localhost, ::1) — то есть только на локальном стенде. В релизе хуков нет вовсе (они не компилируются).
//
// Только заголовок (inline): ядро собирает и android/jni своим списком исходников — новый .cpp сломал бы его.
#pragma once

#include <cctype>
#include <cstring>
#include <string>

namespace parvane::devhooks {

// Хост — loopback? Только точные имена: 127.0.0.1, localhost, ::1 (в т.ч. в скобках) — без «localhost.evil».
[[nodiscard]] inline bool isLoopbackHost(std::string host) {
    for (auto &c : host) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (host.size() >= 2 && host.front() == '[' && host.back() == ']') host = host.substr(1, host.size() - 2);
    return host == "127.0.0.1" || host == "localhost" || host == "::1";
}

// Адрес gateway (wss://host[:port][/path], ws://…, tcp://host:port, host:port, [::1]:port) указывает на loopback?
// Пустой адрес — нет (клиент тогда идёт на прод по умолчанию). Адрес с userinfo («ws://127.0.0.1@evil/») — нет.
[[nodiscard]] inline bool isLoopbackGatewayUrl(const std::string &url) {
    if (url.empty()) return false;
    std::string rest = url;
    const auto scheme = rest.find("://");
    if (scheme != std::string::npos) {
        std::string s = rest.substr(0, scheme);
        for (auto &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (s != "ws" && s != "wss" && s != "tcp") return false;
        rest = rest.substr(scheme + 3);
    }
    const auto end = rest.find_first_of("/?#");
    std::string hostport = end == std::string::npos ? rest : rest.substr(0, end);
    if (hostport.empty() || hostport.find('@') != std::string::npos) return false;
    std::string host;
    if (hostport.front() == '[') {
        const auto close = hostport.find(']');
        if (close == std::string::npos) return false;
        host = hostport.substr(0, close + 1);
        const auto tail = hostport.substr(close + 1);
        if (!tail.empty() && tail.front() != ':') return false;
    } else if (hostport == "::1") {
        host = hostport; // голый IPv6 без порта
    } else {
        const auto colon = hostport.find(':');
        if (colon != std::string::npos && hostport.find(':', colon + 1) != std::string::npos) return false;
        host = colon == std::string::npos ? hostport : hostport.substr(0, colon);
    }
    return isLoopbackHost(host);
}

// Флаг PARVANE_DEV_HOOKS включён? Только точное "1".
[[nodiscard]] inline bool flagOn(const char *value) {
    return value && std::strcmp(value, "1") == 0;
}

// Решение шлюза: PARVANE_DEV_HOOKS=1 И gateway на loopback.
[[nodiscard]] inline bool allowed(const char *hooksFlag, const std::string &gatewayUrl) {
    return flagOn(hooksFlag) && isLoopbackGatewayUrl(gatewayUrl);
}

} // namespace parvane::devhooks
