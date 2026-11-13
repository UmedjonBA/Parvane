// Parvane fork: журнал истории аккаунта на клиенте (spec 033, правила HIST-1, HIST-2, READ-2) — общий для
// desktop (tdesktop) и Android (jni). Порт web `src/api/parvane/v2/history.ts`.
//
// Сведение строк (RowState), маркер прочтения, подсчёт непрочитанного, права удаления, ключ/AEAD записей — ТОЛЬКО
// в движке (`parvane-protocol`, модуль `history`, C ABI `pv_history_call`/`pv_call`; контракт —
// `specs/033-history-sync/contracts/engine-api.md`). Строки, маркеры и их хранение — в модели движка профиля
// (spec 035 T125, ENGINE-1: `rowsApply`/`rowsAll`/`rowsRead` через `engine::Host`, как web `historyRows.ts`);
// своей копии строк и своего сведения у ядра нет. С spec 036 (ENGINE-1, `engine_rows`) журнал истории аккаунта
// (очередь пачкой S7-3, догон, вход по точке, контрольные точки, замена, книга цепочек) ведёт МОДЕЛЬ сессии — порт
// прежнего web `v2/history.ts` удалён. Здесь:
//   - доступ к строкам модели (`ModelRows`: состояния, готовый показ `views` — MessageView) и служебные документы;
//   - перевод показа модели в прежнюю форму хоста (`viewOfModel`, `removedOfModel`, `unreadOfModel`);
//   - разовый перенос прежних файлов строк хоста в модель (`importLegacyRows`, spec 033 FileRowStore);
//   - `HistorySync`: событие устройства → строка модели «в журнал», прочтение — намерением модели.
// Потоки: публичные методы потокобезопасны и в сеть не ходят.
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
    // Файлы служебных документов (spec 036 T036): чтение и запись по пути; не заданы — storecrypt (прежний путь).
    // Хосты отдают файлы хоста (`PathFiles`: android — каталог хранилища, desktop — tdata), прежний файл storecrypt
    // переносится при первом обращении.
    struct AuxIo {
        std::function<std::string(const std::string &path)> read;
        std::function<bool(const std::string &path, const std::string &data)> write;
    };
    ModelRows(HostFn host, std::string auxPrefix, AuxIo io = {});

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
    // journal — операции в журнал истории аккаунта ставит модель (spec 036 `engine_rows`; пачку отправляет такт
    // модели сессии).
    Applied apply(const json &ops, const json &legacyRows = json::array(), const json &forget = json::array(),
                  bool wipe = false, bool journal = false);
    // spec 036 (ENGINE-1): готовый показ модели — MessageView (proto3-JSON, с `wire` у хоста с возможностью
    // `wire_rows`) по порядку ленты (ORDER-1 — место модели): строки с этими id; строки чата; все строки (видимые —
    // надгробий и сирот у показа нет).
    [[nodiscard]] std::vector<json> views(const std::vector<std::string> &ids) const;
    [[nodiscard]] std::vector<json> chatViews(const std::string &chatKey) const;
    [[nodiscard]] std::vector<json> allViews() const;
    // spec 036 (T030/T035): список чатов модели целиком (`chatList` по страницам) — `chatViewOfModel` по порядку модели
    // (закреплённые первыми, дальше по `order`); модели нет — пусто.
    [[nodiscard]] std::vector<json> chatList() const;
    // Страница истории чата (`historyPage`): строки — `viewOfModel` по порядку ленты (старые первыми). anchor — id
    // строки-якоря (UUID; "" — с конца); direction — "older" (строго старше якоря), "newer" (строго новее), "around".
    struct Page {
        std::vector<json> rows;
        bool hasOlder = false;
        bool hasNewer = false;
        bool ok = false; // модель ответила
    };
    [[nodiscard]] Page page(const json &peer, const std::string &anchorId, const std::string &direction, int limit) const;
    // Убрать строки у себя по id (очистка чата «у себя», самоуничтожение); в журнале аккаунта они остаются.
    void forget(const std::vector<std::string> &ids);
    // Служебные документы ("meta" — курсор и пр., "pending" — очередь записи, "imported" — отметка переноса).
    [[nodiscard]] json aux(const std::string &name);
    void setAux(const std::string &name, const json &value);

private:
    [[nodiscard]] json rowsAll(const json &what) const;
    HostFn host_;
    std::string auxPrefix_;
    AuxIo io_;
    std::mutex auxMu_;
    std::map<std::string, json> aux_;
};

// spec 036 (ENGINE-1): MessageView модели (`message_upsert`, `rowsAll.views`, `historyPage`) → показ хоста в той же
// форме, что прежде отдавал `historyView` (хосты desktop/android переводят её в свои объекты): {id (UUID), chat (Peer),
// chatKey, from, tsMs, editTsMs, edited, visible: true, orphan: false, pinned, reactions [{emoji, count, users}],
// body {content, reply_to?, proof?, …} — тело `wire` с наложенной правкой, order (место в ленте), unread (входящее
// после маркера), read (своё прочитано собеседником — доставка READ), outgoing}. Не MessageView — null.
[[nodiscard]] json viewOfModel(const json &messageView);
// `message_remove` модели → {id (UUID), chat (Peer), chatKey}; null — не снятие.
[[nodiscard]] json removedOfModel(const json &messageRemove);
// `unread_changed` модели → {chat (Peer), chatKey, unread, lastReadId (UUID; "" — нет), lastReadTsMs, mention,
// mentions [UUID]}; null — не изменение счётчика.
[[nodiscard]] json unreadOfModel(const json &unreadChanged);
// spec 036 (T030/T035, ENGINE-1): ChatView модели (`chatList`, `chat_upsert`) → показ хоста: {chat (Peer), chatKey,
// order (мс — место в списке, ORDER-1; у чата без строк — черновик либо время появления), pinnedRank (0 — не закреплён;
// закреп основного списка либо архива — по `archived`), archived, unreadMark, mutedUntilMs, draft (текст),
// folderIds [id], unread, mention, last (viewOfModel последней строки либо null)}. Не ChatView — null.
[[nodiscard]] json chatViewOfModel(const json &chatView);
// `chat_remove` модели (Peer) → {chat, chatKey}; null — не снятие.
[[nodiscard]] json removedChatOfModel(const json &peer);
// UUID-строка по base64 16 байт ("" — не id).
[[nodiscard]] std::string uuidOfB64(const std::string &b64);
// base64 16 байт по UUID-строке ("" — не UUID).
[[nodiscard]] std::string b64OfUuid(const std::string &uuid);

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
// spec 036 (ENGINE-1, `engine_rows`): журнал истории аккаунта (очередь пачкой S7-3, догон, вход нового устройства по
// контрольной точке, точки, замена дальше горизонта, книга цепочек) и маркеры ведёт МОДЕЛЬ сессии
// (`SessionConfig.engineRows`, такт сессии) — своей сети и потока у HistorySync нет. Здесь — то, что хост делает со
// строками модели: событие устройства (своё, входящее вне итога модели) → строка модели с отметкой «в журнал»,
// прочтение — намерением модели, счётчик и свои адреса.
struct HistorySyncConfig {
    std::string self;           // свой адрес (user@domain); прежние (смена ника) — из сессии движка (selfAddresses)
    ModelRows *rows = nullptr;  // принадлежит хосту, живёт дольше HistorySync
    // Открыть сессию журнала движка (свои адреса — текущий и прежние); nullptr — сессии ещё нет (повтор позже).
    std::function<std::unique_ptr<v2::HistorySession>()> openEngine;
    // Прочтение намерением модели (`read`): маркер, квитанции собеседникам о ставших прочитанными и счётчик — у
    // модели (сессия исполняет запросы итога). false — не принято (нет сессии) — маркер операцией журнала.
    std::function<bool(const json &mark)> readIntent;
    std::function<void(const std::string &)> log;
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

    // Запуск: не записанное прежним журналом устройства (очередь `pending` на диске, до spec 036) — модели в журнал
    // один раз; запечатанные прежней цепочкой тела не повторяются.
    void start();
    void stop();

    // Событие истории на этом устройстве → строке модели (`rowsApply`, сведение и права — модель) с отметкой «в
    // журнал» (пачку S7-3 отправляет такт модели). Неизвестная цель — сирота. Результат — RowState строки после
    // операции (null — модель не открыта или у операции нет строки). Своя строка (from — свой адрес) сдвигает маркер
    // чата до неё (READ-2, FR-011; в журнал — если own).
    json record(const json &op, bool own);
    // Маркер «прочитано до» (ReadMark). own — намерением модели `read` (квитанции шлёт модель), иначе операцией без
    // журнала (копия своей квитанции, маркер журнала). Ответ всегда пуст: квитанций хосту слать не нужно.
    std::vector<json> advanceMark(const json &mark, bool own);

    // Чтение строк модели (без сети).
    [[nodiscard]] std::optional<json> state(const std::string &id);
    [[nodiscard]] ReadState readState(const std::string &chatKey);
    [[nodiscard]] int unreadCount(const std::string &chatKey);
    [[nodiscard]] json mark(const std::string &chatKey);
    // Свои адреса: текущий первым, затем прежние (смена ника, spec 026) — из сессии движка, пока она не открыта —
    // только cfg.self. Своё сообщение под прежним адресом — своё (не входящее, сдвигает маркер).
    [[nodiscard]] std::vector<std::string> selfAddresses();
    [[nodiscard]] bool isSelf(const std::string &address);

private:
    void log(const std::string &m) const;
    void ensureSelves();

    HistorySyncConfig cfg_;
    std::mutex engMu_;
    std::unique_ptr<v2::HistorySession> engine_;
    std::mutex selvesMu_;
    std::vector<std::string> selves_; // под selvesMu_; пусто — сессия движка не открывалась
    std::atomic<bool> started_{false};
};

} // namespace parvane::history
