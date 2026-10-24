// Parvane fork: копия ключей аккаунта под ключом восстановления (spec 015) — ФОРМАТ ВЕБ-КЛИЕНТА
// (web `v2/keyBundle.ts`). Лежит на сервере рядом с копией корня (`RootBackupSet.key_bundle`) и несёт то,
// что получает устройство при привязке: материал гранта движка, ключи планировщика и облака, указатель
// на снимок истории. По ней новое устройство входит в журнал с одним ключом восстановления.
//
// Формат: "PVKB" ‖ версия (1) ‖ nonce (12) ‖ AES-256-GCM(JSON), ключ = HKDF-SHA256(ikm = ключ
// восстановления в каноничной записи без «-», salt = "parvane/v2/key-bundle", info = адрес),
// AAD = "PVKB" ‖ версия ‖ адрес. Общие векторы с web — proto/parvane/vectors/clients/keybundle-*.json.
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

namespace parvane::keybundle {

// Ключ восстановления без оформления (регистр, пробелы, «-» не важны; O→0, I/L→1); nullopt — не ключ.
[[nodiscard]] std::optional<std::string> canonicalRecoveryKey(const std::string &text);
// Ключ из того, что вставил человек (с окружающим текстом, длинным тире): запись `XXXX-XXXX-…`;
// ничего похожего — исходный текст без пробелов по краям.
[[nodiscard]] std::string pickRecoveryKey(const std::string &text);
// Ключ копии (32 байта); nullopt — это не ключ восстановления.
[[nodiscard]] std::optional<std::string> deriveBundleKey(const std::string &recoveryKey, const std::string &address);
// payload — {grant (base64), planner?, cloud?, history?}. Пусто — сбой.
[[nodiscard]] std::string seal(const std::string &bundleKey, const std::string &address, const nlohmann::json &payload);
// nullopt — чужой ключ/адрес, испорченные байты или нет `grant`.
[[nodiscard]] std::optional<nlohmann::json> open(const std::string &bundleKey, const std::string &address,
                                                 const std::string &bytes);
// Журнал устройств в материале гранта — свежий ответ `identity.device.log_sync` (hex), ключ копии — поле `bk`.
[[nodiscard]] std::string withFreshLog(const std::string &grant, const std::string &logResponse);
[[nodiscard]] std::string withBundleKey(const std::string &grant, const std::string &bundleKeyB64);
[[nodiscard]] std::string readGrantBundleKey(const std::string &grant);
// Копия при записи (без групп — их сводит движок, `groupKeysMerge`): своё поверх серверного, а не вместо. Только что
// вошедшее устройство не стирает из копии «План», «Облако» и историю, которых само ещё не получило. Правила — как
// web `mergeKeyBundlePayload` (вектор `keybundle-merge.json`): грант — свой, но ключ личного состояния (`sk`/`skv`) и
// ключ доставки (`dk`/`gen`) — более новой версии из двух; «План» — свой, если есть, но серверный при том же
// контейнере с бо́льшим числом эпох; «Облако» — объединение по `id`, у общего — с бо́льшим числом эпох; история — свой
// снимок, если он не меньше серверного.
[[nodiscard]] nlohmann::json mergeWithServer(const nlohmann::json &own, const nlohmann::json &server);

// Экспорт привязки (LINK-1, формат web `linkHistory.ts`): ключи «Плана» и «Облака» старого устройства — строками JSON
// движка, как в копии ключей (`plannerKeysImport`/`cloudKeysImport`). Поле может быть строкой либо объектом
// (прежняя форма); мусор и отсутствующее поле — пустая строка.
struct LinkDomainKeys {
    std::string planner;
    std::string cloud;
};
[[nodiscard]] LinkDomainKeys readLinkDomainKeys(const std::string &stateJson);
// Ключи «Плана» и «Облака» в экспорт привязки (`planner`/`cloud` — ответы движка `plannerKeysExport`/`cloudKeysExport`)
void putLinkDomainKeys(nlohmann::json &exported, const nlohmann::json &planner, const nlohmann::json &cloud);
// SHA-256 текста, hex.
[[nodiscard]] std::string digestHex(const std::string &text);

} // namespace parvane::keybundle
