// Parvane fork (spec 035 T125, переходный период desktop/android, как web `openStateModel` в v2/engine.ts): личное
// состояние — через модель движка (`state.v2`, `state.ops.*`). Личность, инбокс и группы пока ведёт прежний клиент
// (`v2::Client`); его ключи личного состояния передаются модели внутри движка (`adoptStateKeys`). Хост отдаёт
// ЖЕЛАЕМОЕ в форме снимка `state.v1` (`stateApplyV1`): разницу «желаемое ↔ `base`» по полям (Patch/Create/Delete),
// сведение по регистрам и метки считает только движок (ENGINE-1); показ — `stateViewV1` (сведённое в форме
// `state.v1`, избранные стикеры, журнал закрыт для записи). Хранилище модели — во временном каталоге профиля,
// стирается при открытии: журнал читается с начала при каждом подключении (как прежний `PvState`).
// Не потокобезопасен: вызывать под мьютексом сессии.
#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::engine {
class Host;
}

namespace parvane::v2 {

using nlohmann::json;
class Client;

class StateModel {
public:
    // Отправить запрос модели (OutRequest: method, channel, body base64, dest_domain) и вернуть тело ответа; при
    // отказе — *errorCode = номер ErrorCode (UNAVAILABLE — сбой связи), тело пустое.
    using Send = std::function<std::string(const json &request, int *errorCode)>;

    // nullptr — у клиента нет ключа личного состояния или модель не открылась (*error).
    static std::unique_ptr<StateModel> open(const Client &client, const std::string &user, const std::string &deviceId,
                                            const std::string &domain, const std::string &dir, Send send,
                                            std::string *error = nullptr);
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
    StateModel(std::unique_ptr<engine::Host> host, Send send);
    bool run(const json &step); // исполнить запросы итога шага (ответы — через ingest), false — отказ хоть одного

    std::unique_ptr<engine::Host> host_;
    Send send_;
};

// Номер ErrorCode по имени (`ERROR_CODE_UNAVAILABLE` → 11); незнакомое — UNAVAILABLE.
[[nodiscard]] int errorCodeNumber(const std::string &code);

} // namespace parvane::v2
