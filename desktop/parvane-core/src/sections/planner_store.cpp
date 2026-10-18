// Parvane fork (spec 029, T029): состояние «Плана» для экранов — порт web `plannerStore.ts` (см. заголовок).
#include "parvane/sections/planner_store.h"

#include "parvane/sections/planner_model.h"

namespace parvane::sections::planner {

EngineStateResult EngineStateResult::fromJson(const json &j) {
    EngineStateResult r;
    if (!j.is_object()) return r;
    r.status = j.value("status", std::string("loading"));
    if (const auto it = j.find("state"); it != j.end() && it->is_object()) r.state = *it;
    if (const auto it = j.find("sizeBytes"); it != j.end() && it->is_number()) r.sizeBytes = it->get<std::int64_t>();
    if (const auto it = j.find("hasPending"); it != j.end() && it->is_boolean()) r.hasPending = it->get<bool>();
    if (const auto it = j.find("error"); it != j.end() && it->is_string()) r.error = it->get<std::string>();
    if (const auto it = j.find("raw"); it != j.end() && it->is_string()) r.raw = it->get<std::string>();
    if (const auto it = j.find("revision"); it != j.end() && it->is_number()) r.revision = it->get<std::int64_t>();
    return r;
}

// Отметка состояния движка: строка JSON либо ревизия, иначе — отпечаток разобранного JSON
EngineMark engineMarkOf(const EngineStateResult &result) {
    EngineMark mark;
    if (result.raw) mark.raw = result.raw;
    else if (result.revision) mark.revision = result.revision;
    else mark.fingerprint = result.state ? result.state->dump() : std::string("null");
    return mark;
}

bool isAppliedEngineState(const std::optional<EngineMark> &applied, bool isLoaded, const EngineStateResult &result) {
    if (!applied || !isLoaded) return false;
    if (result.raw) return result.raw == applied->raw;
    if (result.revision) return result.revision == applied->revision;
    return applied->fingerprint && (result.state ? result.state->dump() : std::string("null")) == *applied->fingerprint;
}

PlannerStore::PlannerStore(PlannerStoreHost &host) : host_(host), state_(createEmptyState()) {}

void PlannerStore::setUser(const std::string &userId) {
    if (userId_ == userId) return;
    reset();
    userId_ = userId;
}

void PlannerStore::reset() {
    stateBeforeLastChange_.reset();
    appliedEngine_.reset();
    isLearnedMigrated_ = false;
    hasQuickLines_ = false;
    isLoaded_ = false;
    isCached_ = false;
    status_ = "loading";
    notice_.reset();
    sizeBytes_ = 0;
    state_ = createEmptyState();
}

void PlannerStore::markLoaded() {
    isCached_ = false;
    isLoaded_ = true;
}

bool PlannerStore::applyEngineResult(const EngineStateResult &result) {
    bool replaced = false;
    status_ = result.status;
    sizeBytes_ = result.sizeBytes;
    if (result.state) hasQuickLines_ = hasEngineQuickLines(*result.state);
    if (result.state && result.status != "needs-linking" && !result.hasPending) {
        // Пока у провайдера есть непревращённые в операцию правки, состояние движка отстаёт от черновика экрана
        if (!isAppliedEngineState(appliedEngine_, isLoaded_, result)) {
            try {
                state_ = fromEngineState(*result.state);
                appliedEngine_ = engineMarkOf(result);
                replaced = true;
            } catch (const std::exception &) {
                // Состояние движка не разобрано — экран остаётся прежним
            }
        }
        markLoaded();
    } else if (result.status == "ready" || result.status == "offline" || result.status == "no-key") {
        // Контейнера ещё нет (создастся первой правкой) — пустой планировщик
        if (isCached_) {
            state_ = createEmptyState();
            replaced = true;
        }
        markLoaded();
    }
    // Словарь на экране — весь словарь из «Плана» (нет непревращённых правок): можно вливать запись устройства
    if (result.status == "ready" && !result.hasPending) {
        migrateLearned();
        migrateQuickHistory();
    }
    return replaced;
}

void PlannerStore::showCached(const json &engineState) {
    if (isLoaded_) return;
    try {
        state_ = fromEngineState(engineState);
        isCached_ = true;
    } catch (const std::exception &) {
        // Снимок не разобран
    }
}

bool PlannerStore::migrateLegacy(const EngineStateResult &result, const json &legacyRecord, const State &normalized,
                                 const std::string &prefix) {
    if (isMigrating_ || result.status != "ready" || !isLegacyPlannerRecord(legacyRecord)) return false;
    isMigrating_ = true;
    const auto changes = legacyToChanges(normalized, prefix);
    const int count = static_cast<int>(normalized.tasks.size() + normalized.events.size() + normalized.nutrition.size());
    host_.apply(changes);
    host_.flush();
    host_.markMigrated(count);
    isMigrating_ = false;
    return true;
}

bool PlannerStore::canSyncLearned() const { return isLoaded_ && (status_ == "ready" || status_ == "offline"); }

bool PlannerStore::canSyncQuickHistory() const { return canSyncLearned() && hasQuickLines_; }

// Словарь правок с устройства вливается в «План» и стирается с устройства (без уведомления и «Отменить»)
void PlannerStore::migrateLearned() {
    if (isLearnedMigrated_ || !canSyncLearned()) return;
    isLearnedMigrated_ = true;
    if (!host_.hasLocalLearned()) return;
    const State previous = state_;
    State draft = previous;
    draft.learned = host_.mergeLocalLearned(previous.learned);
    // «Отменить» прежней правки вернуло бы и состояние без словаря
    stateBeforeLastChange_.reset();
    setLocalState(draft);
    sendChanges(diffChanges(previous, draft));
    host_.resetLocalLearned();
}

// История ввода с устройства вливается в «План» и стирается; отметки о переносе нет — перенесённое стёрто
void PlannerStore::migrateQuickHistory() {
    if (!canSyncQuickHistory() || !host_.hasLocalHistory()) return;
    const State previous = state_;
    State draft = previous;
    draft.quickLines = host_.mergeLocalHistory(previous.quickLines);
    stateBeforeLastChange_.reset();
    setLocalState(draft);
    sendChanges(diffChanges(previous, draft));
    host_.resetLocalHistory();
}

// Черновик экрана: показан он, а не состояние движка — следующий ответ движка применяется обязательно
void PlannerStore::setLocalState(State state) {
    appliedEngine_.reset();
    state_ = std::move(state);
}

void PlannerStore::sendChanges(const std::vector<PlannerChange> &changes) {
    if (changes.empty()) return;
    try {
        host_.apply(changes);
    } catch (const std::exception &) {
        // Правки не переданы провайдеру
    }
}

void PlannerStore::update(const std::function<void(State &)> &mutate, const std::optional<std::string> &noticeText,
                          std::int64_t nowMs) {
    if (!isLoaded_) return;
    const State previous = state_;
    State draft = previous;
    mutate(draft);
    stateBeforeLastChange_ = previous;
    setLocalState(draft);
    if (noticeText) publishNotice(PlannerNotice{*noticeText, true}, nowMs);
    sendChanges(diffChanges(previous, state_));
}

void PlannerStore::undo(const std::string &noticeText, std::int64_t nowMs) {
    if (!stateBeforeLastChange_) return;
    const State current = state_;
    State target = *stateBeforeLastChange_;
    stateBeforeLastChange_.reset();
    setLocalState(target);
    publishNotice(PlannerNotice{noticeText, false}, nowMs);
    sendChanges(diffChanges(current, state_));
}

// Уведомление без изменения состояния (ошибка ввода): «Отменить» к нему не относится
void PlannerStore::showNotice(const std::string &text, std::int64_t nowMs) {
    publishNotice(PlannerNotice{text, false}, nowMs);
}

// Полоска уходит сама; новое уведомление начинает отсчёт заново
void PlannerStore::publishNotice(std::optional<PlannerNotice> notice, std::int64_t nowMs) {
    notice_ = std::move(notice);
    noticeHideAt_ = nowMs + kNoticeHideMs;
}

std::optional<PlannerNotice> PlannerStore::notice(std::int64_t nowMs) const {
    if (!notice_ || nowMs >= noticeHideAt_) return std::nullopt;
    return notice_;
}

} // namespace parvane::sections::planner
