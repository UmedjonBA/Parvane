// Parvane fork (spec 035 T125, как web `openStateModel` в v2/engine.ts): личное состояние — через модель движка
// (`state.v2`, `state.ops.*`) той же модели, что держит клиентское ядро сессии (`v2::Client` поверх `engine::Host`):
// ключи личного состояния не выходят из движка, хранилище — общее хранилище модели профиля (курсор журнала и
// сведённое переживают перезапуск). Хост отдаёт ЖЕЛАЕМОЕ в форме снимка `state.v1` (`stateApplyV1`): разницу
// «желаемое ↔ `base`» по полям (Patch/Create/Delete), сведение по регистрам и метки считает только движок
// (ENGINE-1); показ — `stateViewV1` (сведённое в форме `state.v1`, избранные стикеры, журнал закрыт для записи).
// Запросы шагов модели исполняет сессия (`Runner`: отправка, ответ — `ingest`, изменения модели — хосту).
// Не потокобезопасен: вызывать под мьютексом сессии.
#pragma once

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

    // Показ: {snapshot (state.v1), faved_stickers, write_blocked}.
    [[nodiscard]] json view();
    [[nodiscard]] json snapshot() { return view().value("snapshot", json::object()); }

    // Желаемое (state.v1.StateSnapshot) → модель → только изменившиеся поля в журнал. kinds — управляемые виды (пусто
    // — объекты снимка), prune — удалить пропавшие из управляемых, rewrite — переписать целиком (новый ключ),
    // base — что хост показывал последним (разница с ним, а не со сведённым: правка другого устройства после
    // проекции не откатывается). false — запрос не дошёл (связь, отказ): правку держать «несохранённой».
    bool apply(const json &desired, const std::vector<std::string> &kinds = {}, bool prune = false,
               bool rewrite = false, const json &base = json());
    // Намерение модели (`fave_sticker`, `state_delete`, …).
    bool submit(const json &intent);
    // Свои неотправленные — серверу, затем журнал до головы. true — показ изменился.
    bool sync();

private:
    std::shared_ptr<engine::Host> host_;
    Runner run_;
};

// Номер ErrorCode по имени (`ERROR_CODE_UNAVAILABLE` → 11); незнакомое — UNAVAILABLE.
[[nodiscard]] int errorCodeNumber(const std::string &code);

} // namespace parvane::v2
