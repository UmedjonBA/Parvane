// Parvane fork: журнал истории аккаунта на клиенте (spec 033, правила HIST-1, HIST-2, READ-2) — общий для
// desktop (tdesktop) и Android (jni). Порт web `src/api/parvane/v2/history.ts`.
//
// Сведение строк (RowState), маркер прочтения, подсчёт непрочитанного, права удаления, ключ/AEAD записей — ТОЛЬКО
// в движке (`parvane-protocol`, модуль `history`, C ABI `pv_history_call`/`pv_call`; контракт —
// `specs/033-history-sync/contracts/engine-api.md`). Строки, маркеры и их хранение — в модели движка профиля
// (spec 035 T125, ENGINE-1: `rowsApply`/`rowsAll`/`rowsRead` через `engine::Host`, как web `historyRows.ts`);
// своей копии строк и своего сведения у ядра нет. Здесь — ввод-вывод вокруг движка:
//   - доступ к строкам модели (`ModelRows`) и служебные документы журнала (курсор, очередь) в файлах;
//   - разовый перенос прежних файлов строк хоста в модель (`importLegacyRows`, spec 033 FileRowStore);
//   - очередь записи в журнал (ревью 7 ноя 2026, S7-3): свои действия, маркеры и входящее — одной пачкой через
//     случайные 30–120 с после первого события в очереди (по времени записи сервер не отличит автора сообщения от
//     получателя), входящее — только то, чего устройство ещё не видело в журнале; запечатанные тела хранятся и
//     повторяются как есть (номера цепочки писателя без пропусков, S7-4);
//   - sync по событию `{"type":"journal","journal":"history"}` и раз в 60 с; курсор, наибольшая виденная голова
//     (откат сервера — журнал не применяется), время полной синхронизации, флаг миграции — на диске (aux);
//   - вход нового устройства: history.head → сводка (сверена с точкой, historyVerifyCheckpoint) → сегменты свежими
//     первыми (op_id — из сводки) → history.sync(after = upto, skip_chunks) с книгой цепочек писателей (пропуск
//     номера — предупреждение); `compacted` в ответе sync → точка (замена при `historyNeedsReplace`); точка, не
//     сошедшаяся со сводкой, не применяется и курсор не двигает (S7-4);
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
namespace parvane::engine {
class Host;
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

// ── строки истории в модели движка (spec 035 T125, ENGINE-1) ──────────────────────────────────────────────────
// Строки (RowState с надгробиями и сиротами), место в ленте (ORDER-1), маркеры «прочитано до» (READ-2) и их
// хранение — модель профиля (режим `host_driven`, `history-row`/`history-mark` хранилища модели). Хост подаёт ей
// операции журнала истории (`rowsApply`) и читает готовое (`rowsAll` с выборкой по чату и id, `rowsRead` — счётчик
// чата). Модель — та же, что держит клиентское ядро сессии (`v2::Session::rowsModel`); пока она не открыта, чтения
// пусты и запись не идёт (`ready()` — false), хост откладывает события до открытия.
// Служебные документы журнала (курсор, очередь записи) — файлы `<auxPrefix><имя>.json` (storecrypt).
class ModelRows {
public:
    using HostFn = std::function<std::shared_ptr<engine::Host>()>;
    ModelRows(HostFn host, std::string auxPrefix);

    // Модель открыта (запись и чтение строк возможны).
    [[nodiscard]] bool ready() const;
    // RowState по id сообщения; строки нескольких id; строки чата; все строки (и надгробия, и сироты).
    [[nodiscard]] std::optional<json> get(const std::string &id) const;
    [[nodiscard]] std::vector<json> states(const std::vector<std::string> &ids) const;
    [[nodiscard]] std::vector<json> chat(const std::string &chatKey) const;
    [[nodiscard]] std::vector<json> all() const;
    // Маркер чата (ReadMark) и все маркеры.
    [[nodiscard]] std::optional<json> mark(const std::string &chatKey) const;
    [[nodiscard]] std::vector<json> marks() const;
    // Счётчик чата (`rowsRead`): непрочитанные от маркера, последняя прочитанная видимая строка, входящие, ставшие
    // прочитанными после `since` (прежний маркер; null — с начала).
    struct Read {
        int unread = 0;
        std::string lastReadId;
        json mark;
        std::vector<std::string> newlyRead;
    };
    [[nodiscard]] Read read(const std::string &chatKey, const json &since = nullptr) const;
    // `rowsApply`: операции журнала истории (HistoryOp), строки прежнего кэша ({hs, order?}), убрать у себя без
    // надгробия ({chat, target}), стереть всё (HIST-2). changed — id строк, чьё состояние изменилось, по порядку.
    struct Applied {
        bool ok = false;
        std::vector<std::string> changed;
        std::string error;
    };
    Applied apply(const json &ops, const json &legacyRows = json::array(), const json &forget = json::array(),
                  bool wipe = false);
    // Убрать строки у себя по id (очистка чата «у себя», самоуничтожение); в журнале аккаунта они остаются.
    void forget(const std::vector<std::string> &ids);
    // Служебные документы ("meta" — курсор и пр., "pending" — очередь записи, "imported" — отметка переноса).
    [[nodiscard]] json aux(const std::string &name);
    void setAux(const std::string &name, const json &value);

private:
    [[nodiscard]] json rowsAll(const json &what) const;
    HostFn host_;
    std::string auxPrefix_;
    std::mutex auxMu_;
    std::map<std::string, json> aux_;
};

// Прежние файлы строк хоста (spec 033, бывший FileRowStore: JSONL `RowState` — последнее состояние строки побеждает,
// строки до spec 033 — StoredMessage, маркеры `{chatKey: ReadMark}`) — только чтение для разового переноса в модель.
struct LegacyRowFiles {
    std::vector<json> states;         // RowState
    std::vector<json> storedMessages; // StoredMessage журнала до spec 033 (последняя строка по id)
    std::vector<json> marks;          // ReadMark
};
[[nodiscard]] LegacyRowFiles readLegacyRowFiles(const std::string &rowsPath, const std::string &marksPath);

// Разовый перенос прежних файлов строк хоста в модель (отметка — служебный документ "imported"; сам файл не
// трогается — удаляет прежнее пользователь, D2): RowState — строками прежнего кэша (сведение с известным — модель),
// маркеры — операциями read, StoredMessage до spec 033 — операциями, которые строит хост (`convertStored`: row,
// read), строки очищенного «у себя» (`dropRow`) — прочь из модели. Модель могла получить те же строки разовым
// переносом spec 035 (M2) — повтор сводится без следа. false — модель не открыта (повторить при открытии).
bool importLegacyRows(ModelRows &rows, const std::string &rowsPath, const std::string &marksPath,
                      const std::function<std::vector<json>(const std::vector<json> &stored)> &convertStored,
                      const std::function<bool(const json &state)> &dropRow,
                      const std::function<void(const std::string &)> &log);

// ── журнал истории ─────────────────────────────────────────────────────────────────────────────────────────────
struct HistorySyncConfig {
    std::string self;           // свой адрес (user@domain); прежние (смена ника) — из сессии движка (selfAddresses)
    ModelRows *rows = nullptr;  // принадлежит хосту, живёт дольше HistorySync
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

    // Окно пачки записи (S7-3): всё в очереди уходит одной записью через случайные [batchMinMs, batchMaxMs] после
    // первого события. Хост может сузить окно для сценариев (desktop — PARVANE_HISTORY_BATCH_MS в dev-сборке со
    // стендом на loopback, android — debug-сборка).
    std::int64_t batchMinMs = 30000;
    std::int64_t batchMaxMs = 120000;
    std::int64_t pollMs = 60000;
    std::int64_t retryMs = 5000;
    std::uint64_t checkpointRecords = 5000;
    std::int64_t checkpointAgeMs = 24LL * 3600 * 1000;
    std::int64_t checkpointJitterMs = 60000;
    // Свой рабочий поток (таймеры). false — только ручные syncNow/flushNow/checkpointNow (тесты).
    bool thread = true;
};

// Счётчик чата для UI (`rowsRead` модели): непрочитанные от маркера и последняя прочитанная видимая строка.
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

    // Событие истории на этом устройстве → строке модели (`rowsApply`, сведение — модель) → в очередь журнала.
    // own — действие пользователя этого устройства, иначе входящее (пишется, если журнал его ещё не знает); то и другое —
    // общей пачкой (S7-3).
    // Неизвестная цель — сирота. Результат — RowState строки после операции (null — модель не открыта или у операции
    // нет строки). Права чужой мутации (поле `by` операции: правка — только автор, удаление — по праву) сверяет
    // модель, и у сироты — когда строка придёт. Своя строка (from == self) сдвигает маркер чата до неё (READ-2, FR-011).
    json record(const json &op, bool own);
    // Маркер «прочитано до» (ReadMark). Сводит модель (максимум); own — в журнал общей пачкой. Результат — строки
    // входящих, которые стали прочитанными (для квитанций собеседникам); пусто — маркер не сдвинулся.
    std::vector<json> advanceMark(const json &mark, bool own);

    // Чтение строк модели (без сети).
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
    // Операции → строкам модели (пачками); результат — изменившиеся строки (RowState). false в *ok — модель не открыта.
    std::vector<json> applyOps(const std::vector<json> &ops, bool *ok = nullptr);
    // Операции из журнала (records — опорные записи ingest) → строкам модели, колбэки.
    void absorbOps(const json &ops, std::vector<json> &rows, std::map<std::string, json> &marks);
    void deliver(std::vector<json> &rows, std::map<std::string, json> &marks);
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
    // expect — {номер: op_id} (сегменты по сводке, S7-4); *mismatched — сервер отдал под номером другую запись.
    std::vector<json> getRecordsLocked(const std::vector<std::uint64_t> &seqs, json *recordsOut, const json *expect = nullptr,
                                       bool *mismatched = nullptr);
    // Записи-сегменты (chunk) и прочее, что можно запечатать заново при повторе; opIds — op_id записей.
    bool appendLocked(const std::vector<json> &ops, bool chunk, std::vector<std::uint64_t> *seqs,
                      std::vector<std::string> *opIds = nullptr);
    // Разбор страницы sync с книгой цепочек (meta_["chains"]).
    json ingestChained(const std::string &resp);
    // Отправить запечатанные тела очереди по порядку; false — не все ушли (повтор позже).
    bool sendBodiesLocked();
    // Срок текущей пачки (под mu_): назначить, если пачки нет.
    std::int64_t batchDueLocked();
    bool flushLocked(bool includeIncoming, bool dueOnly);
    bool maybeCheckpointLocked(bool force);
    bool buildCheckpointLocked(const json &head);

    HistorySyncConfig cfg_;
    std::mutex mu_;  // очереди, meta, флаги
    json meta_;
    std::vector<json> pendingOwn_;          // свои операции (на диске — aux "pending")
    std::map<std::string, json> pendingMarks_; // chatKey → маркер к записи
    std::int64_t batchDue_ = 0;                // срок пачки (S7-3); 0 — очередь пуста
    std::vector<std::string> bodies_;          // запечатанные тела (base64) к отправке по порядку (на диске)
    std::int64_t bodiesRetryAt_ = 0;
    std::vector<Incoming> incoming_;
    std::unordered_set<std::string> seen_;
    std::deque<std::string> seenOrder_;
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
