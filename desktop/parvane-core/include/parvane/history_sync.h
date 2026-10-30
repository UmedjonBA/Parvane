// Parvane fork: журнал истории аккаунта на клиенте (spec 033, правила HIST-1, HIST-2, READ-2) — общий для
// desktop (tdesktop) и Android (jni). Порт web `src/api/parvane/v2/history.ts`.
//
// Сведение строк (RowState), маркер прочтения, подсчёт непрочитанного, права удаления, ключ/AEAD записей — ТОЛЬКО
// в движке (`parvane-protocol`, модуль `history`, C ABI `pv_history_call`/`pv_call`; контракт —
// `specs/033-history-sync/contracts/engine-api.md`). Здесь — ввод-вывод вокруг движка:
//   - хранилище строк хоста (`RowStore`: RowState по id, перебор по чату, маркеры, служебные документы);
//   - очередь записи в журнал: свои действия — через ≤ 300 мс (маркер — ≤ 1 с), входящее — через случайные 1–5 с
//     и только то, чего устройство ещё не видело в журнале;
//   - sync по событию `{"type":"journal","journal":"history"}` и раз в 60 с; курсор, наибольшая виденная голова
//     (откат сервера — журнал не применяется), время полной синхронизации, флаг миграции — на диске (RowStore);
//   - вход нового устройства: history.head → сводка (список чатов) → сегменты свежими первыми →
//     history.sync(after = upto, skip_chunks); `compacted` в ответе sync → точка (замена при `historyNeedsReplace`);
//   - контрольная точка (устройство с курсором = голова; > 5000 записей после точки или точке > 24 ч; задержка
//     0–60 с; неизменные сегменты — прежний seq; `stale` и всё после смены ключа состояния — заново; отказ CAS —
//     не повторять до новой точки);
//   - перенос локальной истории хоста в журнал один раз (`legacyOps`).
//
// Потоки: свой рабочий поток (таймеры и сеть); публичные методы потокобезопасны и не ходят в сеть (кроме
// `syncNow`/`flushNow`/`checkpointNow`, которые блокируют вызывающего). Колбэки `onRows`/`onMark`/`onReplaced` —
// на рабочем потоке, вне внутренних замков.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::v2 {
class HistorySession;
}

namespace parvane::history {

using nlohmann::json;

// ── чистые функции движка (статические `history*`, без сессии) ─────────────────────────────────────────────────
// Любая статическая функция по имени (`historyApply`, `historyView`, …). Бросает v2::EngineError.
json call(const std::string &name, const json &args);

// Ключ чата истории как у движка (`history::history_chat_key`, `historyChatKey`): "u:<адрес>" | "g:<hex id>" — у
// группы БЕЗ домена (id группы уникален глобально; домен группы хост может не знать); "" — не собеседник.
[[nodiscard]] std::string chatKeyOf(const json &peer);
// Ключ чата строки (`RowState.chat`).
[[nodiscard]] std::string chatKeyOfState(const json &state);
// Время и id строки ((row.ts_ms, target)); nullopt — сирота.
struct RowPos {
    std::int64_t tsMs = 0;
    std::string id;
};
[[nodiscard]] std::optional<RowPos> rowPos(const json &state);
// Маркер «прочитано до» этой строки (сирота — null).
[[nodiscard]] json markAt(const json &state);
// Операции истории (proto3-JSON HistoryOp; id — UUID). stamp — {"ts_ms","op_id"} (historyNewStamp, если null).
[[nodiscard]] json stampOf(std::int64_t tsMs, const std::string &opId);
// by — автор чужой мутации (адрес; пусто — своё действие): движок применяет её к строке, только если она
// действительна для автора строки (удаление: автор, админ группы с правом — byAdmin, любой участник личного чата;
// правка: только автор), а пока строки нет, хранит кандидатом (RowState.pending_*).
[[nodiscard]] json goneOp(const std::string &target, const json &chat, const json &stamp, bool everyone,
                          const std::string &by = std::string(), bool byAdmin = false);
[[nodiscard]] json editOp(const std::string &target, const json &chat, const json &stamp, const json &editFields,
                          const std::string &by = std::string());
[[nodiscard]] json reactOp(const std::string &target, const json &chat, const std::string &user, const json &stamp,
                           const std::string &emoji);
[[nodiscard]] json pinOp(const std::string &target, const json &chat, const json &stamp, bool pinned);
// Строка формата экспорта привязки (`id, from, to, ts (с, допустимы доли), content, reply_to, …`) → операция row.
// Бросает (нет содержимого, неверный id/автор).
[[nodiscard]] json rowOpFromWire(const json &wireRow, const json &chat);
// Цель операции (id сообщения) и чат; "" / null — операция не о строке (маркер, сводка).
[[nodiscard]] std::string opTarget(const json &op);
[[nodiscard]] json opChat(const json &op);

// ── хранилище строк хоста ──────────────────────────────────────────────────────────────────────────────────────
// Desktop — файл (`FileRowStore`), Android — свой журнал. Реализация обязана быть потокобезопасной.
class RowStore {
public:
    virtual ~RowStore() = default;
    // RowState (канонический proto3-JSON движка) по id сообщения.
    virtual std::optional<json> get(const std::string &id) = 0;
    virtual void put(const json &state) = 0;
    // Убрать строки локально (очистка чата, горизонт); в журнале они остаются.
    virtual void erase(const std::vector<std::string> &ids) = 0;
    virtual void forEachInChat(const std::string &chatKey, const std::function<void(const json &)> &f) = 0;
    virtual void forEach(const std::function<void(const json &)> &f) = 0;
    virtual std::size_t size() = 0;
    // Маркер прочтения чата (ReadMark).
    virtual std::optional<json> mark(const std::string &chatKey) = 0;
    virtual void setMark(const std::string &chatKey, const json &mark) = 0;
    virtual void forEachMark(const std::function<void(const std::string &chatKey, const json &mark)> &f) = 0;
    // Режим замены (HIST-2): строки и маркеры стираются (служебные документы — нет).
    virtual void clear() = 0;
    // Служебные документы журнала ("meta" — курсор и пр., "pending" — несданные свои операции).
    virtual json aux(const std::string &name) = 0;
    virtual void setAux(const std::string &name, const json &value) = 0;
    // Сбросить отложенные записи на диск.
    virtual void flush() {}
};

// Хранилище в файлах (desktop; шифрование — storecrypt, если ключ задан):
//   <rowsPath>  — JSONL, строка = RowState; новые состояния дописываются, при открытии и по накоплению файл
//                 перезаписывается свёрткой (атомарно, tmp + rename);
//   <marksPath> — {chatKey: ReadMark};  <auxPrefix><имя>.json — служебные документы.
// Строки прежнего формата (StoredMessage журнала `parvane-history-*.jsonl` до spec 033) при открытии
// откладываются — их забирает `takeLegacyRows()` (перенос в журнал один раз).
class FileRowStore final : public RowStore {
public:
    FileRowStore(std::string rowsPath, std::string marksPath, std::string auxPrefix);
    ~FileRowStore() override;
    std::optional<json> get(const std::string &id) override;
    void put(const json &state) override;
    void erase(const std::vector<std::string> &ids) override;
    void forEachInChat(const std::string &chatKey, const std::function<void(const json &)> &f) override;
    void forEach(const std::function<void(const json &)> &f) override;
    std::size_t size() override;
    std::optional<json> mark(const std::string &chatKey) override;
    void setMark(const std::string &chatKey, const json &mark) override;
    void forEachMark(const std::function<void(const std::string &, const json &)> &f) override;
    void clear() override;
    json aux(const std::string &name) override;
    void setAux(const std::string &name, const json &value) override;
    void flush() override;
    // Строки прежнего формата (JSON объектов StoredMessage); после вызова список пуст.
    std::vector<json> takeLegacyRows();
    // Перезаписать файл строк свёрткой сейчас.
    void compact();
    // Число дописанных строк сверх свёртки (для тестов).
    [[nodiscard]] std::size_t appendedSinceCompact();

private:
    void loadLocked();
    void compactLocked();
    void saveMarksLocked();
    std::mutex mu_;
    std::string rowsPath_, marksPath_, auxPrefix_;
    std::map<std::string, json> rows_;                         // id → RowState
    std::map<std::string, std::set<std::string>> byChat_;      // chatKey → ids
    std::map<std::string, json> marks_;
    std::map<std::string, json> aux_;
    std::vector<json> legacy_;
    std::size_t appended_ = 0;
};

// ── журнал истории ─────────────────────────────────────────────────────────────────────────────────────────────
struct HistorySyncConfig {
    std::string self;           // свой адрес (user@domain); прежние (смена ника) — из сессии движка (selfAddresses)
    RowStore *store = nullptr;  // принадлежит хосту, живёт дольше HistorySync
    // Запрос канала ID (метод реестра, тело — байты) → байты ответа. Бросает при отказе (v2::V2Error с кодом —
    // ERROR_CODE_DUPLICATE, ERROR_CODE_LIMIT, ERROR_CODE_UNAVAILABLE, …).
    std::function<std::string(const std::string &method, const std::string &body)> request;
    // Открыть сессию журнала движка (ключ — из ключей личного состояния); nullptr — ключа ещё нет.
    std::function<std::unique_ptr<v2::HistorySession>()> openEngine;
    // Строки, изменившиеся от журнала (не от record()): показать/убрать (historyView).
    std::function<void(const std::vector<json> &states)> onRows;
    // Маркер чата сдвинулся от журнала или копии своей квитанции (не от advanceMark(own=true)).
    std::function<void(const std::string &chatKey, const json &mark)> onMark;
    // Режим замены: хранилище стёрто и заполнено из контрольной точки — показать заново.
    std::function<void()> onReplaced;
    // Перенос локальной истории хоста (один раз, до первого sync): операции (row/gone/state/…, а также read —
    // маркеры), которые хост знал до журнала. Пустой — нечего переносить.
    std::function<std::vector<json>()> legacyOps;
    // Строку не хранить и не класть в точку (очистка чата «у себя», STATE-1: граница ChatCleared).
    std::function<bool(const json &state)> dropRow;
    std::function<void(const std::string &)> log;
    std::function<std::int64_t()> nowMs; // для тестов; по умолчанию — системные часы

    std::int64_t ownDelayMs = 300;
    std::int64_t markDelayMs = 1000;
    std::int64_t incomingMinMs = 1000;
    std::int64_t incomingMaxMs = 5000;
    std::int64_t pollMs = 60000;
    std::int64_t retryMs = 5000;
    std::uint64_t checkpointRecords = 5000;
    std::int64_t checkpointAgeMs = 24LL * 3600 * 1000;
    std::int64_t checkpointJitterMs = 60000;
    // Свой рабочий поток (таймеры). false — только ручные syncNow/flushNow/checkpointNow (тесты).
    bool thread = true;
};

// Счётчик чата для UI: непрочитанные (historyIsUnread) и последняя прочитанная видимая строка.
struct ReadState {
    int unread = 0;
    std::string lastReadId; // "" — нет прочитанных
    json mark;              // ReadMark или null
};

class HistorySync {
public:
    explicit HistorySync(HistorySyncConfig cfg);
    ~HistorySync();
    HistorySync(const HistorySync &) = delete;
    HistorySync &operator=(const HistorySync &) = delete;

    // Рабочий поток: открыть сессию движка, перенос (один раз), вход/догон, далее по событиям и таймерам.
    void start();
    // Остановить поток и дождаться его (между сетевыми шагами поток проверяет остановку и выходит). Хост, которому
    // нельзя ждать (выход из аккаунта в главном потоке), зовёт stop() с рабочего потока, а запросы прежнего
    // аккаунта к этому времени отказывает сам (request бросает).
    void stop();

    // Событие сессии v2: {"type":"journal","journal":"history"} — sync сейчас; {"type":"stateReady"[,"rotated":true]}
    // — открыть сессию движка заново (после смены ключа состояния — принудительная точка с перезаливкой сегментов).
    void onSessionEvent(const json &ev);

    // Событие истории на этом устройстве → historyApply к строке хранилища → сохранить → в очередь журнала.
    // own — действие пользователя этого устройства (≤ 300 мс), иначе входящее (1–5 с, если журнал его ещё не знает).
    // Неизвестная цель — сирота. Результат — новый RowState (null — операция отвергнута движком, причина в логе).
    // Своя строка (from == self) сдвигает маркер чата до неё (READ-2, FR-011).
    // requiredAuthor — мутация допустима только для сообщения этого автора (правка; удаление в группе не админом):
    // строка известна — проверка сразу (чужая — отказ, null); неизвестна — мутация ждёт в памяти, пока строка не
    // придёт (из инбокса или журнала), и применяется только при совпадении автора.
    json record(const json &op, bool own, const std::string &requiredAuthor = std::string());
    // Маркер «прочитано до» (ReadMark). Сводится максимумом; own — в журнал через ≤ 1 с. Результат — строки
    // входящих, которые стали прочитанными (для квитанций собеседникам); пусто — маркер не сдвинулся.
    std::vector<json> advanceMark(const json &mark, bool own);

    // Чтение хранилища (без сети).
    [[nodiscard]] std::optional<json> state(const std::string &id);
    [[nodiscard]] json view(const json &state); // historyView; {} — сбой
    [[nodiscard]] ReadState readState(const std::string &chatKey);
    [[nodiscard]] int unreadCount(const std::string &chatKey);
    [[nodiscard]] json mark(const std::string &chatKey);
    // Свои адреса: текущий первым, затем прежние (смена ника, spec 026) — из сессии движка, пока она не открыта —
    // только cfg.self. Своё сообщение под прежним адресом — своё (не входящее, сдвигает маркер).
    [[nodiscard]] std::vector<std::string> selfAddresses();
    [[nodiscard]] bool isSelf(const std::string &address);

    // Блокирующие (сеть на потоке вызывающего; для тестов и хуков). false — не вышло (причина в логе).
    bool syncNow();
    bool flushNow(bool includeIncoming = true);
    bool checkpointNow(bool force = true);
    // {"cursor","headSeq","lastFullSyncMs","migrated","joined","checkpointId","pendingOwn","pendingIncoming",
    //  "engine"}
    [[nodiscard]] json status();

private:
    struct Incoming {
        json op;
        std::string key;
        std::int64_t due = 0;
    };
    std::int64_t now() const;
    void log(const std::string &m) const;
    void loop();
    void wake();
    bool ensureEngineLocked();                       // под engMu_
    json engine(const std::string &name, const json &args); // сессия движка (под engMu_); бросает
    std::string req(const std::string &method, const std::string &body);
    // Применить операцию к хранилищу; changed — состояние изменилось. Бросает (движок отверг).
    json applyToStore(const json &op, bool *changed);
    // Операции из журнала (records — опорные записи ingest) → хранилище, колбэки.
    void absorbOps(const json &ops, std::vector<json> &rows, std::map<std::string, json> &marks);
    void deliver(std::vector<json> &rows, std::map<std::string, json> &marks);
    bool mergeMark(const json &mark, std::string *chatKey);
    void noteSeen(const json &op);
    [[nodiscard]] bool seen(const std::string &key);
    static std::string opKey(const json &op);
    void saveMetaLocked();
    void savePendingLocked();
    // Сеть (под netMu_).
    bool migrateLocked();
    bool joinLocked();
    bool pullLocked();
    bool loadCheckpointLocked(const json &cp, bool isJoin);
    std::vector<json> getRecordsLocked(const std::vector<std::uint64_t> &seqs, json *recordsOut);
    bool appendLocked(const std::vector<json> &ops, bool chunk, std::vector<std::uint64_t> *seqs);
    bool flushLocked(bool includeIncoming, bool dueOnly);
    bool maybeCheckpointLocked(bool force);
    bool buildCheckpointLocked(const json &head);

    HistorySyncConfig cfg_;
    std::mutex mu_;  // очереди, meta, флаги
    json meta_;
    std::vector<json> pendingOwn_;          // свои операции (на диске — aux "pending")
    std::map<std::string, json> pendingMarks_; // chatKey → маркер к записи
    std::int64_t ownDue_ = 0, marksDue_ = 0;
    std::vector<Incoming> incoming_;
    std::unordered_set<std::string> seen_;
    std::deque<std::string> seenOrder_;
    struct Parked {
        json op;
        bool own = false;
        std::string author;
    };
    std::map<std::string, std::vector<Parked>> parked_; // id сообщения → мутации, ждущие строку (под mu_)
    std::size_t parkedCount_ = 0;
    // Строка цели появилась — применить дождавшиеся её мутации (автор совпал); новые состояния — в rows.
    void releaseParked(const json &state, std::vector<json> *rows);
    bool syncRequested_ = false;
    bool reopenRequested_ = false;
    bool rotated_ = false;
    std::int64_t nextPoll_ = 0;
    std::int64_t nextCheckpoint_ = 0;
    std::int64_t retryAt_ = 0;

    std::mutex netMu_;  // одна сетевая операция за раз
    std::mutex engMu_;
    std::unique_ptr<v2::HistorySession> engine_;
    std::mutex selvesMu_;
    std::vector<std::string> selves_; // под selvesMu_; пусто — сессия движка не открывалась
    [[nodiscard]] json selvesJson();

    std::mutex cvMu_;
    std::condition_variable cv_;
    bool kicked_ = false; // под cvMu_
    std::atomic<bool> stop_{false};
    std::atomic<bool> started_{false};
    std::thread worker_;
};

} // namespace parvane::history
