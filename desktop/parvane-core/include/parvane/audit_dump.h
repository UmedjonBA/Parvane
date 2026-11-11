// Parvane fork: выгрузка «ничего не потеряно» (spec 035, T007; `specs/035-protocol-evolution/contracts/migration.md`,
// раздел «Видимые значения»), общая для desktop (tdesktop) и Android (jni). Строка — {"kind","key","digest"}, digest —
// SHA-256 канонического JSON видимого значения. Правила разбиения и ключей — те же, что у web
// (`web/telegram-tt/src/api/parvane/auditDump.ts`); общий вход и ожидаемые строки — `conformance/audit/`.
// Выгрузка только читает: хост собирает источники (JSON движка, хранилище строк истории) и зовёт build().
#pragma once

#include <functional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::history {
class ModelRows;
}

namespace parvane::audit {

using nlohmann::json;

struct Line {
    std::string kind;
    std::string key;
    std::string digest;
};

// Канонический JSON: ключи по возрастанию, без пробелов, поля со значением null выбрасываются, целые числа с
// плавающей точкой — как целые (как JSON.stringify).
[[nodiscard]] std::string canonicalJson(const json &value);
[[nodiscard]] std::string sha256Hex(const std::string &data);
// Ключ собеседника состояния (`parvane.state.v1.Peer`): "u:<адрес>" | "g:<id base64>" | "".
[[nodiscard]] std::string statePeerKey(const json &peer);
// Ключ элемента списка: id-поля → собеседник → user/group → ref → поля-имена → "h:" + 16 знаков дайджеста.
[[nodiscard]] std::string elementKey(const json &element);

struct Sources {
    std::vector<json> rows;        // RowState движка (proto3-JSON)
    std::vector<json> marks;       // ReadMark (с полем chat)
    std::vector<json> ownJournal;  // своё исходящее вне строк истории (id, to, ts, content, reply_to)
    std::string stateSnapshot;     // JSON снимка личного состояния движка ("" — нет)
    std::string plannerState;      // JSON «Плана» движка ("" — нет)
    std::vector<std::pair<json, std::string>> cloud;  // (сводка контейнера движка, JSON дерева)
    std::vector<std::pair<std::string, json>> groups; // (hex id, groupInfo движка)
    std::vector<json> deviceLogs;  // {"user","version","devices"}
    json accountKeys = json::object();
    // Вид строки (`historyView`) и ключ чата (`historyChatKey`); по умолчанию — движок через C ABI.
    std::function<json(const json &state)> view;
    std::function<std::string(const json &peer)> chatKey;
};

// Строки и маркеры истории из модели движка профиля (spec 035 T125: строки desktop и android — в модели).
void addModelRows(Sources &sources, const history::ModelRows &rows);

[[nodiscard]] std::vector<Line> build(const Sources &sources);
[[nodiscard]] std::string jsonl(const std::vector<Line> &lines);

} // namespace parvane::audit
