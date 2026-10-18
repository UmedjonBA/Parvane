// Parvane fork (spec 029, T029): «План» на сервере — порт web `api/parvane/v2/planner.ts` (жизненный цикл
// контейнера домена `parvane.planner.v1` шарда domains) и `plannerCoalesce.ts` (склейка правок одной операции).
// Движок держит сведённое состояние, ключи эпох и метки; здесь — найти/создать контейнер (журнал личного
// состояния → `domain.container.list`), снимок и журнал (`domain.op.sync`), очередь отправки своих операций
// (переживает перезапуск — запись `planner-outbox`), непревращённые правки (`planner-pending`), пакетирование
// правок (тишина 1,5 с, потолок 10 с), снимок по порогу, опрос 8 с (раздел нужен и окно видно) / 60 с, повтор
// через 15 с без связи. Статусы — как в web: loading | needs-linking | no-key | offline | ready.
//
// Устройство (см. domain_sync.h): вызовы блокирующие, модуль живёт в одном рабочем потоке. То, что в web
// запускается «в фоне» (`void flushNow()`, `void syncNow()` из таймера, события вкладки, `setActive`), здесь
// ставит срок «сейчас»: вызывающий зовёт `tick()` не позже `nextWakeMs()`. Явные `ensure/syncNow/flush` —
// выполняются сразу (в web их ждут `await`).
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/domain_sync.h"

namespace parvane::sections::planner {

using nlohmann::json;

// Правки одного объекта перед отправкой склеиваются: поздние поля заменяют ранние, списки по ключу — тоже
// (web `coalesceChanges`). Удаление заменяет всё прежнее; правка после удаления — новая запись целиком.
json coalesceChanges(const json &changes);

inline constexpr const char *kPlannerDomain = "parvane.planner.v1";
inline constexpr const char *kOutboxRecord = "planner-outbox";
inline constexpr const char *kPendingRecord = "planner-pending";
inline constexpr std::int64_t kFlushIdleMs = 1500;
inline constexpr std::int64_t kFlushMaxMs = 10000;
inline constexpr std::int64_t kSyncIntervalMs = 8000;
inline constexpr std::int64_t kSyncIdleMs = 60000;
inline constexpr std::int64_t kRetryOfflineMs = 15000;
inline constexpr int kSyncPages = 50;
inline constexpr std::size_t kMaxChangesPerOp = 400;

// Контейнер: домен сервера и id (hex)
struct ContainerRef {
    std::string domain;
    std::string id;
    bool operator==(const ContainerRef &) const = default;
};

// То, что web берёт из журнала личного состояния и отдаёт экрану
struct PlannerHooks {
    // Контейнер из журнала личного состояния (другое устройство уже объявило). Сессия: снимок журнала,
    // поле `planner_container.ref` (id — base64 → hex)
    std::function<std::optional<ContainerRef>()> stateContainer;
    // Объявить контейнер в журнале личного состояния: `Session::stateCall("plannerContainerSet",
    // {"domain", "idHex"})`
    std::function<void(const ContainerRef &)> recordContainer;
    // Состояние или статус изменились — UI перечитает
    std::function<void()> onChanged;
};

class PlannerSync {
public:
    PlannerSync(domain::DomainTransport &transport, domain::RecordStore &records, PlannerHooks hooks);

    // UI открыл «План»: подключить контейнер и синхронизировать. `isBackground` — запуск без потребителей
    // (напоминания): опрос редкий, пока UI сам не позовёт `ensure`; уже запущенный планировщик он не трогает
    void ensure(bool isBackground = false);
    // Есть ли потребители состояния (раздел, палитра, карточки задания в чате)
    void setActive(bool active);
    // Окно видно/скрыто (web `visibilitychange`)
    void setVisible(bool visible);
    // Окно закрывается (web `pagehide`): накопленные правки — сразу
    void pageHide();
    // Правки (массив изменений для движка): копятся и уходят одной операцией по тишине 1,5 с
    void apply(const json &changes);
    // Все накопленные правки — немедленно
    void flush();
    // Синхронизация сейчас (свои правки, затем журнал)
    void syncNow();
    // Сработавшие сроки (пакет, опрос, повтор)
    void tick();
    // Ближайший срок, когда нужен `tick()`; nullopt — сроков нет
    [[nodiscard]] std::optional<std::int64_t> nextWakeMs() const;

    // Сведённое состояние движка (JSON `planner_json.rs`); нет — nullopt
    std::optional<json> stateJson();
    std::string status();
    [[nodiscard]] std::optional<std::string> lastError() const { return lastError_; }
    std::int64_t sizeBytes();
    // Правки, ещё не превращённые в операцию: состояние движка их не содержит
    [[nodiscard]] bool hasPending() const { return !pendingChanges_.empty(); }
    std::optional<json> keysExport();
    void keysImport(const json &value);
    // Событие движка `plannerChanged` (ключ принят / контейнер надо подключить)
    void onEngineEvent();
    void reset();

    // Для тестов и диагностики
    [[nodiscard]] std::size_t outboxSize() const { return outbox_.size(); }
    [[nodiscard]] bool isWanted() const { return isWanted_; }

private:
    struct OutboxItem {
        std::string opId; // hex
        std::string op;   // base64
    };

    json engine(const std::string &name, const json &args = json::object());
    bool hasClient();
    bool isAttached();
    bool hasKey();
    std::int64_t headSeq();
    std::string call(bool anon, const std::string &method, const std::string &body, const std::string &dest = {});
    std::string callRequest(const json &req);
    std::string encode(const std::string &method, const json &value);
    json refJson(const ContainerRef &ref) const;
    void setStatus(const std::string &next);
    std::optional<ContainerRef> currentRef();

    void loadOutbox();
    void saveOutbox();
    void savePending();
    void loadPending();

    std::optional<ContainerRef> findContainer();
    void attach(const ContainerRef &ref);
    void create();
    void shareKeys();
    bool ensureAttached(bool createIfMissing);
    void pullGrants(const ContainerRef &ref);
    bool pull();
    bool maybeSnapshot();
    int prepareLocal();
    void sendOutbox();
    void scheduleRetry();
    void scheduleFlush();
    void clearFlushTimers();
    void flushNow();
    void scheduleSync();

    domain::DomainTransport &t_;
    domain::RecordStore &records_;
    PlannerHooks hooks_;

    std::string status_ = "loading";
    std::optional<ContainerRef> container_;
    std::vector<OutboxItem> outbox_;
    bool isOutboxLoaded_ = false;
    bool isPendingLoaded_ = false;
    std::vector<json> pendingChanges_;
    domain::Deadline flushTimer_, flushDeadline_, syncTimer_, retryTimer_;
    // Запуск «в фоне» (web `void syncNow()` / `void flushNow()`): срок «сейчас»
    domain::Deadline syncSoon_, flushSoon_;
    bool isWanted_ = false;
    bool isActive_ = true;
    bool isVisible_ = true;
    bool isBackgroundOnly_ = false;
    bool isSnapshotTried_ = false;
    bool isNoContainerAnnounced_ = false;
    std::optional<std::string> lastError_;
};

} // namespace parvane::sections::planner
