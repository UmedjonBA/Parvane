// Parvane fork: отображение содержимого протокола v2 (spec 007, T063) —
// proto3-JSON `parvane.msg.v2.Content` (его выдаёт и принимает движок) ↔
// v1-содержимое клиента (MessageContent: {"kind":"text"|"photo"|…}), которое
// рисует штатный конвейер. Это НЕ разбор протокола: байты провода разбирает
// только движок; здесь — перекладка полей уже проверенного движком объекта.
// Порт web `src/api/parvane/v2/contentMap.ts` (те же правила полей).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::v2 {

using nlohmann::json;

// base64 (стандартный алфавит, с '=') ↔ байты; hex ↔ base64 (id групп в JSON).
[[nodiscard]] std::string toBase64(const std::string &bytes);
[[nodiscard]] std::optional<std::string> fromBase64Safe(const std::string &b64);
[[nodiscard]] std::string hexToB64(const std::string &hex);
[[nodiscard]] std::string b64ToHex(const std::string &b64);

// Адрес группы v2 в клиентах: "v2g:<hex id>" (как web `v2g:`).
inline constexpr const char *kGroupPrefix = "v2g:";
[[nodiscard]] bool isGroupAddress(const std::string &address);
[[nodiscard]] std::string groupAddress(const std::string &hex);
[[nodiscard]] std::string groupHex(const std::string &address);

// UUID ("xxxxxxxx-xxxx-…") ↔ base64 16 байт (op_id в протоколе).
[[nodiscard]] std::string uuidToB64(const std::string &uuid);
[[nodiscard]] std::optional<std::string> b64ToUuid(const std::string &b64);
// Сигнал личного звонка: v1 JSON (`{"type":"invite|answer|ice|reject|hangup",…}`)
// ↔ proto3-JSON parvane.call.v2.CallSignal. Подписи SDP (`sig`) в v2 нет —
// операцию подписывает ключ устройства, проверяет движок. nullopt — сигнал по
// v2 не выражается (групповые сигналы, id звонка не UUID) / нечего передавать.
[[nodiscard]] std::optional<json> callSignalToV2(const json &v1);
[[nodiscard]] std::optional<json> callSignalFromV2(const json &v2);
// MessageRef {"op_id": base64}.
[[nodiscard]] json ref(const std::string &uuid);
// Новый UUIDv7 (id служебных операций: мутации, квитанции).
[[nodiscard]] std::string newUuidV7();

// v1-содержимое → Content движка. nullopt — вид не поддержан v2
// (вызывающий решает: v1-путь или отказ).
[[nodiscard]] std::optional<json> toV2(const json &v1, const std::string &replyTo = std::string());

// Content движка → v1-содержимое; nullopt — не «сообщение» (мутация/служебное)
// или вид, которого клиент не знает (вызывающий показывает заглушку).
[[nodiscard]] std::optional<json> fromV2(const json &v2);

// Режим «усиленная приватность» (L2, T079) в конвейере клиента — содержимое
// {"kind":"chat_mode","l2":bool}: клиент рисует его нативным служебным
// сообщением чата («… включил(а)/выключил(а) усиленную приватность»), не пузырём.
inline constexpr const char *kChatModeKind = "chat_mode";
[[nodiscard]] inline json chatModeContent(bool l2) { return json{{"kind", kChatModeKind}, {"l2", l2}}; }

// Вид содержимого движка ("text", "media", "edit", "reaction", …, "" — пусто).
[[nodiscard]] std::string v2Kind(const json &v2);

// Содержимое заглушки «сообщение не поддерживается» (нативный путь клиента).
[[nodiscard]] inline json unsupportedContent() { return json{{"kind", "unsupported"}}; }

// Событие движка "direct" (1-на-1) или "group" (группа v2), разложенное для
// конвейера клиента.
struct Incoming {
    enum class Kind { None, Message, Stub, Edit, Delete, Reaction, Pin, Read };
    Kind kind = Kind::None;
    std::string id;   // op_id события (UUID) — id сообщения для Message/Stub
    std::string from; // автор (проверен движком по журналу)
    std::string chat; // собеседник; группа — "v2g:<hex>"
    std::string to;   // адресат v1-строки: собеседник (своё) или self (входящее); группа — chat
    bool group = false;
    std::int64_t ts = 0; // секунды
    json content;        // Message — v1-содержимое (в т.ч. chat_mode); Edit — новое v1 (text/location)
    std::string replyTo;
    std::vector<std::string> targets; // Edit/Delete/Reaction/Pin/Read
    std::string emoji;
    bool remove = false; // Reaction: снять
    bool unpin = false;  // Pin: открепить
};
// Не "direct"/"group" или без opId → Kind::None. disposition "stub" и виды, которых
// клиент не знает (контакт, служебные ключи и т.п.) → Kind::Stub.
[[nodiscard]] Incoming interpretDirect(const json &event, const std::string &self);

} // namespace parvane::v2
