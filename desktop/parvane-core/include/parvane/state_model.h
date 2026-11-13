// Parvane fork (spec 035 T125, spec 036): личное состояние — через модель движка (`state.v2`, `state.ops.*`) той же
// модели, что держит клиентское ядро сессии (`v2::Client` поверх `engine::Host`): ключи личного состояния не выходят
// из движка, хранилище — общее хранилище модели профиля (курсор журнала и сведённое переживают перезапуск). Показ —
// объекты модели по видам (`viewStateJson`), запись — `stateSet` объекта / `stateMark` отметки: разницу по полям,
// сведение по регистрам и метки считает только движок (ENGINE-1). Мост снимка `state.v1` (`stateApplyV1`/
// `stateViewV1`) удалён (spec 036 T038); форма `state.v1` осталась только проекцией показа (`stateview::snapshotOf`)
// для разделов, читающих контейнеры и ссылки-приглашения.
// Запросы шагов модели исполняет сессия (`Runner`: отправка, ответ — `ingest`, изменения модели — хосту).
// Не потокобезопасен: вызывать под мьютексом сессии.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::engine {
class Host;
struct Step;
} // namespace parvane::engine

namespace parvane::v2 {

using nlohmann::json;

class StateModel {
public:
    // Исполнить итог шага модели: запросы — серверу по порядку, ответы — `ingest` (и их итоги — тем же путём),
    // изменения — хосту. false — шаг с ошибкой или запрос не дошёл (связь, отказ).
    using Runner = std::function<bool(const engine::Step &step)>;

    StateModel(std::shared_ptr<engine::Host> host, Runner run);
    ~StateModel();
    StateModel(const StateModel &) = delete;
    StateModel &operator=(const StateModel &) = delete;

    // Показ модели: {objects: [{kind, key, value, marks}], write_blocked} (`viewStateJson`, все виды).
    [[nodiscard]] json objects();
    // Показ в форме снимка `state.v1.StateSnapshot` (`stateview::snapshotOf`) — для разделов и ссылок-приглашений.
    [[nodiscard]] json snapshot();
    // Избранные стикеры (`FAVED_STICKER`): [{set_id, sticker_id, added_ms}].
    [[nodiscard]] json favedStickers();
    // Журнал закрыт для записи более новой версией (T117).
    [[nodiscard]] bool writeBlocked();

    // Записать объект вида kind (`FOLDER` либо `OBJECT_KIND_FOLDER`) значением value (proto3-JSON сообщения вида;
    // признак — `{}`): разницу с моделью считает движок; rewrite — `Create` целиком (новый ключ личного состояния).
    // false — шаг с ошибкой или запрос не дошёл (связь, отказ).
    bool set(const std::string &kind, const std::string &key, const json &value, bool rewrite = false);
    // Отметка поля (только растёт): `SCHEDULED` 1 — «отправлено», `CHAT_CLEARED` 2 — граница очистки.
    bool mark(const std::string &kind, const std::string &key, std::uint32_t field, std::uint64_t value);
    // Переписать показ objects() целиком под новый ключ личного состояния: каждый объект и его отметки.
    bool rewrite(const json &view);
    // Намерение модели (`fave_sticker`, `state_delete`, …).
    bool submit(const json &intent);
    // Свои неотправленные — серверу, затем журнал до головы. true — показ изменился.
    bool sync();

private:
    std::shared_ptr<engine::Host> host_;
    Runner run_;
};

// ── spec 036 (ENGINE-1, desktop): личное состояние по видам ──────────────────────────────────────────────────────
// Показ — объекты модели (`viewStateJson`: {objects: [{kind, key, value — proto3-JSON сообщения вида, marks}]}),
// правка — `stateSet` объекта (разницу по полям от показанного хостом считает модель, `base`). Здесь — только
// перекладка готового: ни сведения, ни сравнения меток.
namespace stateview {

// Полное имя вида (`FOLDER` → `OBJECT_KIND_FOLDER`).
[[nodiscard]] std::string kindName(const std::string &kind);
// Объекты вида из ответа `viewStateJson` по порядку: [{key, value, marks}].
[[nodiscard]] json objectsOf(const json &view, const std::string &kind);
// Ключ собеседника как у модели (`state::peer_key`): `u:<адрес>` | `g:<домен>:<hex id>`; "" — не собеседник.
[[nodiscard]] std::string peerKeyOf(const json &peer);
// Собеседник из ключа (proto3-JSON Peer: user.address | group.{domain, id base64}); null — не ключ собеседника.
[[nodiscard]] json peerOfKey(const std::string &key);
// Значение отметки (base64 big-endian без ведущих нулей) числом; отметки нет — 0.
[[nodiscard]] std::uint64_t markValue(const json &object, std::uint32_t field);
// Число отметки → base64 big-endian без ведущих нулей (как ждёт `stateMark`).
[[nodiscard]] std::string markBytes(std::uint64_t value);
// Объекты модели → снимок формы `state.v1.StateSnapshot` для проекции хоста (значения — как отдала модель:
// папки, порядок папок, блок-лист, уведомления, черновики, отложенные и «отправлено», архив, закреп, звонки,
// ссылки, контейнеры, «непрочитано», быстрая реакция, наборы и GIF, контакты, граница очистки).
[[nodiscard]] json snapshotOf(const json &view);
// Записи `stateSet` вида kind: desired/shown — [{key, value}] (что хост хочет и что показывал). Объект, не
// изменившийся относительно показанного, не пишется; изменённый — с `base` (показанным); показанный, которого
// хост больше не хочет, — удаляется. Объекты модели, которых хост не показывал, не трогаются.
[[nodiscard]] std::vector<json> setsFor(const std::string &kind, const json &desired, const json &shown);
// Изменения модели, которые хост показывает (строки, чаты, прочитанность, личное состояние, группы), — событием
// сессии {"type":"model","changes":[…]}; нет таких — null.
[[nodiscard]] json modelEventOf(const std::vector<json> &changes);

} // namespace stateview

// Номер ErrorCode по имени (`ERROR_CODE_UNAVAILABLE` → 11); незнакомое — UNAVAILABLE.
[[nodiscard]] int errorCodeNumber(const std::string &code);

} // namespace parvane::v2
