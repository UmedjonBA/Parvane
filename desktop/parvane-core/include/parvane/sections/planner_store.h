// Parvane fork (spec 029, T029): состояние «Плана» для экранов — порт чистой логики web
// `components/parvane/planner/plannerStore.ts`. Экраны правят `State` через `update`: разница состояний уходит
// провайдеру (`PlannerStoreHost::apply` — в web `parvanePlannerApply`, у desktop — `PlannerSync::apply`),
// сведённое состояние приходит ответом `parvanePlannerState` (`applyEngineResult`). «Отменить» — обратные
// изменения (обычная правка с новой меткой), а не откат. Данные этапа 1 переносятся один раз.
//
// Отличия от web по устройству: сигналов и событий окна нет — экран читает `state()`/`status()` после вызовов;
// таймер уведомления — срок на явном «сейчас» (`notice(nowMs)`); опрос до готовности (`LOAD_ATTEMPTS`,
// `linkingTimer`) ведёт вызывающий: после `applyEngineResult` он смотрит `needsLinkingPoll()`. Словарь правок и
// история ввода на устройстве (web `plannerQuickLearn`/`plannerQuickSuggest`, localStorage) — за хостом.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/planner_engine.h"
#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

// Ответ `parvanePlannerState` (web `StateResult`)
struct EngineStateResult {
    std::string status = "loading"; // loading | needs-linking | no-key | offline | ready
    std::optional<json> state;      // JSON движка (`plannerStateJson`)
    std::int64_t sizeBytes = 0;
    bool hasPending = false;
    std::optional<std::string> error;
    // Сырая строка JSON состояния и ревизия: по ним без разбора видно, что состояние не изменилось
    std::optional<std::string> raw;
    std::optional<std::int64_t> revision;

    static EngineStateResult fromJson(const json &j);
};

// Отметка показанного состояния движка: строка, ревизия либо отпечаток JSON
struct EngineMark {
    std::optional<std::string> raw;
    std::optional<std::int64_t> revision;
    std::optional<std::string> fingerprint;
};
EngineMark engineMarkOf(const EngineStateResult &result);
// Состояние движка — то же, что уже показано (`isLoaded` — «План» загружен)
bool isAppliedEngineState(const std::optional<EngineMark> &applied, bool isLoaded, const EngineStateResult &result);

// Что «План» берёт у хоста
class PlannerStoreHost {
public:
    virtual ~PlannerStoreHost() = default;
    // Правки — провайдеру (web `parvanePlannerApply`)
    virtual void apply(const std::vector<PlannerChange> &changes) = 0;
    // Перенос этапа 1: дослать немедленно и отметить перенос (web `parvanePlannerFlush`, `…MarkMigrated`)
    virtual void flush() {}
    virtual void markMigrated(int count) {}
    // Словарь правок на устройстве (web `readLearned/hasLearned/mergeLearnStores/resetLearned`): есть ли запись;
    // слова «Плана», в которые влита запись устройства; стереть запись
    virtual bool hasLocalLearned() { return false; }
    virtual std::vector<LearnedWord> mergeLocalLearned(const std::vector<LearnedWord> &planner) { return planner; }
    virtual void resetLocalLearned() {}
    // История ввода текстом на устройстве (web `readHistory/hasHistory/mergeHistories/historyToLines/resetHistory`)
    virtual bool hasLocalHistory() { return false; }
    virtual std::vector<QuickLine> mergeLocalHistory(const std::vector<QuickLine> &planner) { return planner; }
    virtual void resetLocalHistory() {}
};

struct PlannerNotice {
    std::string text;
    bool canUndo = false;
};

class PlannerStore {
public:
    static constexpr std::int64_t kNoticeHideMs = 3000;

    explicit PlannerStore(PlannerStoreHost &host);

    // Текущий аккаунт (web `loadPlanner(userId)`): при смене всё сбрасывается
    void setUser(const std::string &userId);
    void reset();

    // Ответ `parvanePlannerState` (web `refreshFromEngine`); true — состояние для экранов заменено
    bool applyEngineResult(const EngineStateResult &result);
    // Снимок с устройства до движка (web `showCachedPlanner`): только просмотр
    void showCached(const json &engineState);
    // Пока устройство не привязано, стек «Плана» не запущен — вызывающий опрашивает раз в 3 с
    [[nodiscard]] bool needsLinkingPoll() const { return status_ == "needs-linking"; }

    // Перенос данных этапа 1 (web `migrateLegacy`): `legacyRecord` — запись устройства, `prefix` — метка устройства.
    // `normalized` — запись, приведённая `normalizeState`. true — перенос выполнен
    bool migrateLegacy(const EngineStateResult &result, const json &legacyRecord, const State &normalized,
                       const std::string &prefix);

    // Правка экранов (web `updatePlanner`); без загрузки — ничего
    void update(const std::function<void(State &)> &mutate, const std::optional<std::string> &noticeText,
                std::int64_t nowMs);
    void undo(const std::string &noticeText, std::int64_t nowMs);
    void showNotice(const std::string &text, std::int64_t nowMs);
    [[nodiscard]] std::optional<PlannerNotice> notice(std::int64_t nowMs) const;
    [[nodiscard]] bool canUndo() const { return stateBeforeLastChange_.has_value(); }

    [[nodiscard]] bool canSyncLearned() const;
    [[nodiscard]] bool canSyncQuickHistory() const;

    [[nodiscard]] const State &state() const { return state_; }
    [[nodiscard]] const std::string &status() const { return status_; }
    [[nodiscard]] bool isLoaded() const { return isLoaded_; }
    [[nodiscard]] bool isCached() const { return isCached_; }
    [[nodiscard]] std::int64_t sizeBytes() const { return sizeBytes_; }
    [[nodiscard]] bool hasQuickLines() const { return hasQuickLines_; }

private:
    void markLoaded();
    void setLocalState(State state);
    // false — провайдер отверг правки (вызывающий не стирает записи устройства)
    bool sendChanges(const std::vector<PlannerChange> &changes);
    void publishNotice(std::optional<PlannerNotice> notice, std::int64_t nowMs);
    void migrateLearned();
    void migrateQuickHistory();

    PlannerStoreHost &host_;
    std::optional<std::string> userId_;
    State state_;
    std::string status_ = "loading";
    bool isLoaded_ = false;
    bool isCached_ = false;
    std::int64_t sizeBytes_ = 0;
    bool hasQuickLines_ = false;
    std::optional<State> stateBeforeLastChange_;
    std::optional<EngineMark> appliedEngine_;
    bool isMigrating_ = false;
    bool isLearnedMigrated_ = false;
    std::optional<PlannerNotice> notice_;
    std::int64_t noticeHideAt_ = 0;
};

} // namespace parvane::sections::planner
