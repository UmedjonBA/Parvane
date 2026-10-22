// Parvane fork (spec 029, T034): хранилище «Знаний» — порт web `components/parvane/notes/notesStore.ts`.
// Заметки — обычные `.md` (и холсты `.canvas`) в папке «Знания»/«Knowledge» в корне личного диска облака. Тексты
// читаются пачкой и помнятся по версии файла (`fileId`) в памяти и в кэше устройства; объекты заметок, которые не
// изменились, остаются прежними (`std::shared_ptr` — тот же указатель); пока заметки никому не нужны
// (`retainNotes`), изменение облака лишь помечает хранилище «грязным». Сохранение сводит правки построчно
// (`mergeNotes`), при расхождении рядом создаётся копия «… (конфликт …)»; запись с карточки холста восстанавливает
// заметку, удалённую за время правки.
//
// Хост (`NotesHost`) — то, что в web дают провайдер (`callParvane('parvaneCloud*' …)` — имена и формы аргументов
// и ответов ровно как в `api/parvane/cloudDrive.ts`), «Пейджер» облака (`cloudStore`: дерево и правки),
// «План» (`plannerStore`) и шифрованное хранилище устройства (кэш текстов).
//
// Отличия от web по устройству (поведение то же):
// - вызовы синхронные: проход по дереву и запись идут в потоке вызывающего; «проход в работе» — флаг, просьбы во
//   время прохода сливаются в следующий (как `syncRun` web);
// - подписки на сигнал облака нет: хост зовёт `setCloudData()` при каждом новом состоянии облака, а `refreshCloud`
//   хранилище делает само вызовом `parvaneCloudState`;
// - правки дерева (`renameCloudNode`, `moveCloudNodes`, `trashCloudNodes` web `cloudStore`) собираются здесь же и
//   уходят `parvaneCloudApply`; уведомление облака при отказе (`showCloudNotice`) — забота экрана облака;
// - кэш текстов устройства — одна запись `notes-text-cache` (узел → {fileId, text}) в `RecordStore`, а не по
//   записи на узел (у `RecordStore` нет чтения по префиксу); пишется сразу, без фоновых пачек с паузами;
// - справка, папки и холсты — готовые порты ядра: notes_guide.h, notes_folders.h, notes_canvas_graph.h.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/cloud_model.h"
#include "parvane/sections/domain_sync.h"
#include "parvane/sections/notes_folders.h"
#include "parvane/sections/notes_guide.h"
#include "parvane/sections/notes_model.h"
#include "parvane/sections/planner_types.h"

namespace parvane::sections::notes {

using nlohmann::json;
using cloud::CloudNode;

// Папка хранилища в корне личного диска; создаётся под названием на языке интерфейса
inline const std::vector<std::string> kVaultNames = {"Знания", "Knowledge"};
inline const std::vector<std::string> kDailyFolderNames = {"Ежедневные", "Daily"};
inline constexpr const char *kNoteExtension = ".md";
inline constexpr const char *kCanvasExtension = ".canvas";
inline constexpr const char *kCanvasMime = "application/json";
inline constexpr const char *kRootContainer = "root";
inline constexpr const char *kTextCacheRecord = "notes-text-cache";
inline constexpr int kGuideAttemptsMax = 3;

// ── записи хранилища ────────────────────────────────────────────────────────────

struct NoteEntry : NoteSource {
    std::string fileId; // версия содержимого, от которой идёт следующая правка
    bool isDaily = false;
};
using NoteRef = std::shared_ptr<const NoteEntry>;

struct CanvasEntry {
    std::string id;
    std::string title;
    std::string text;
    std::string fileId;
};
using CanvasRef = std::shared_ptr<const CanvasEntry>;

enum class NotesStatus { Loading, Ready };

struct NotesNotice {
    std::string code; // conflict | failed | merged | folder-files | guide-failed
    std::string title;
    int64_t at = 0;
};

// Итог записи с карточки холста: `restored` — заметки уже не было, текст лёг в новую заметку
struct NoteSaveResult {
    std::string status; // saved | failed | restored
    std::string id;
    std::string title;
    bool operator==(const NoteSaveResult &) const = default;
};

struct NotesOptions {
    std::string guideLang = "ru"; // ru | en
    std::string vaultName = "Знания";
};

// Состояние облака, как его отдаёт `parvaneCloudState` (web `CloudDriveState`), разобранное один раз
struct CloudData {
    json raw;
    std::string status;
    std::optional<std::string> rootId;
    std::map<std::string, std::vector<CloudNode>> trees;
    const std::vector<CloudNode> &nodesOf(const std::optional<std::string> &id) const;
};
using CloudDataRef = std::shared_ptr<const CloudData>;
CloudDataRef parseCloudData(const json &state);

// ── хост ────────────────────────────────────────────────────────────────────────

class NotesHost {
public:
    virtual ~NotesHost() = default;
    // Вызов провайдера по имени web (`parvaneCloudState`, `parvaneCloudApply`, `parvaneCloudWriteText`,
    // `parvaneCloudReadText`, `parvaneCloudReadTexts`, `parvaneCloudCheckDrive`, `parvaneCloudSaveFromChat`).
    // nullopt — вызов не удался (как `.catch(() => undefined)` web); ответ `undefined` метода — json null.
    virtual std::optional<json> callParvane(const std::string &method, const json &args) = 0;
    // «Сейчас», мс эпохи
    virtual int64_t nowMs() = 0;
    // Новый id узла облака (32 hex); по умолчанию — случайный
    virtual std::string newNodeId();
    // Местные «сегодня» (YYYY-MM-DD) и минуты от полуночи — для пунктов с датой; по умолчанию — по UTC
    virtual std::string today();
    virtual double nowMinutes();
    // Подпись времени в названии копии при конфликте (web `toLocaleString()`); по умолчанию — `YYYY-MM-DD HH:MM:SS` UTC
    virtual std::string localTimeLabel(int64_t ms);
    // Кэш текстов на устройстве (web — SecureE2eStorage аккаунта); nullptr — кэша нет
    virtual domain::RecordStore *textCache() { return nullptr; }
    // «План»: состояние и правка (web `getPlannerState` / `updatePlanner`)
    virtual planner::State plannerState() { return {}; }
    virtual void updatePlanner(const std::function<void(planner::State &)> &mutate) {}
};

// ── хранилище ───────────────────────────────────────────────────────────────────

class NotesStore {
public:
    explicit NotesStore(NotesHost &host);

    // Состояние облака изменилось (сигнал `getCloudData` web): пока заметки нужны — проход сразу, иначе «грязно»
    void setCloudData(const json &state);
    // Открыть хранилище (`loadNotes`): смена аккаунта сбрасывает всё; дерево облака → тексты заметок
    void loadNotes(const std::string &userId, const std::optional<NotesOptions> &options = std::nullopt);
    // Экран читает заметки: изменения облака применяются сразу. Возвращает отпускание
    std::function<void()> retainNotes();
    // Выход из аккаунта либо вход другим (ревью 21 окт 2026, вечер): заметки, тексты, облако и справка прежнего —
    // прочь, хранилище не слушает облако до следующего loadNotes. Отпускания retainNotes остаются в силе
    void signOut();

    // Сигналы web
    const std::vector<NoteRef> &notes() const { return notes_; }
    const std::vector<CanvasRef> &canvases() const { return canvases_; }
    NotesStatus status() const { return status_; }
    const std::optional<NotesNotice> &notice() const { return notice_; }
    const std::vector<NoteFolder> &folders() const { return folders_; }
    const std::optional<std::string> &guideOpenId() const { return guideOpenId_; }
    // Ревизии: растут при каждой замене списка (setNotes, setCanvases, setNoteFolders) и при любом изменении сигналов
    uint64_t notesRevision() const { return notesRevision_; }
    uint64_t canvasesRevision() const { return canvasesRevision_; }
    uint64_t foldersRevision() const { return foldersRevision_; }
    uint64_t revision() const { return revision_; }
    // Колбэк «что-то из сигналов изменилось» (вызывается из потока вызывающего)
    std::function<void()> onChanged;
    // Текущее состояние облака (nullptr — ещё не прочитано)
    CloudDataRef cloudData() const { return data_; }

    NotesIndex notesIndex() const;
    NoteRef findNoteByTitle(const std::string &title) const;

    std::optional<std::string> createNote(const std::string &title, const std::string &vaultName,
                                          const std::optional<std::string> &text = std::nullopt,
                                          const std::optional<std::string> &folderName = std::nullopt,
                                          const std::optional<std::string> &folderId = std::nullopt);
    struct ChatFile {
        std::string fileId;
        std::string name;
        std::string mime;
        int64_t size = 0;
    };
    // Файлы чата — в корень хранилища; занятые имена → новые (`имя в тексте` → `имя в облаке`); nullopt — не вышло
    std::optional<std::map<std::string, std::string>> saveChatFilesToVault(const std::string &vaultName,
                                                                           const std::vector<ChatFile> &files);
    std::optional<std::string> openDailyNote(const std::string &day, const std::string &vaultName,
                                             const std::string &dailyFolderName);
    // Текст заметки дня: nullopt — дерева нет либо не прочиталось; {nullopt} — заметки дня нет
    std::optional<std::optional<std::string>> readDailyNote(const std::string &day);
    bool saveNote(const std::string &noteId, const std::string &draft, const std::string &vaultName,
                  const std::optional<std::string> &baseText = std::nullopt);
    NoteSaveResult saveNoteOrRestore(const std::string &noteId, const std::string &title, const std::string &draft,
                                     const std::string &vaultName,
                                     const std::optional<std::string> &baseText = std::nullopt);
    void applyPlannerToNotes(const std::string &vaultName);
    std::string freeNoteTitle(const std::string &noteId, const std::string &title) const;
    bool renameNote(const std::string &noteId, const std::string &title, const std::string &vaultName);
    bool deleteNote(const std::string &noteId);
    struct FolderCreateResult {
        std::optional<std::string> id;
        std::optional<FolderSubmitError> error; // BadName | Failed
    };
    FolderCreateResult createNoteFolder(const std::string &name, const std::string &vaultName);
    bool moveNote(const std::string &noteId, const std::optional<std::string> &folderId = std::nullopt);
    // nullopt — готово; иначе причина отказа
    std::optional<FolderSubmitError> renameNoteFolder(const std::string &folderId, const std::string &name,
                                                const std::string &vaultName);
    // notesMode: "" | "move" | "with-notes"; итог: done | has-notes | has-files | failed
    std::string deleteNoteFolder(const std::string &folderId, const std::string &notesMode = std::string());
    std::optional<std::string> saveCanvas(const std::string &title, const std::string &text,
                                          const std::string &vaultName,
                                          const std::optional<std::string> &canvasId = std::nullopt);
    bool renameCanvas(const std::string &canvasId, const std::string &title);
    bool deleteCanvas(const std::string &canvasId);
    std::optional<std::string> restoreGuide();
    void consumeGuideOpen();

    // Перечитать облако (`refreshCloud` web): ответ `parvaneCloudState`; nullptr — не ответил
    CloudDataRef refreshCloud();

private:
    struct TextContent {
        std::string fileId;
        std::string text;
    };
    struct VaultFile {
        CloudNode node;
        std::string folder;
        bool isNote = false;
    };
    struct WriteResult {
        bool ok = false;
        std::optional<std::string> node;
        std::optional<std::string> fileId;
        std::optional<std::string> conflict;
    };
    struct GuideResult {
        std::string status; // retry | skipped | done
        bool isFreshVault = false;
        std::optional<std::string> overviewId;
    };

    void changed();
    void setNotes(std::vector<NoteRef> next);
    void setCanvases(std::vector<CanvasRef> next);
    void setFolders(std::vector<NoteFolder> next);
    void setStatus(NotesStatus next);
    void notify(const std::string &code, const std::string &title);
    void resetForUser();
    void adoptData(const json &state, bool keepIfEqual);
    void handleCloudChange();
    void queueSync();
    void syncFromCloud(const CloudDataRef &data);
    std::vector<CloudNode> rootNodes() const;
    std::optional<std::string> rootId() const;

    // тексты
    std::map<std::string, TextContent> &cache();
    void storeTexts(const std::vector<std::pair<std::string, TextContent>> &items);
    void pruneTextCache(const std::set<std::string> &alive);
    void rememberText(const std::string &nodeId, const TextContent &content);
    std::optional<TextContent> readText(const CloudNode &node);
    std::map<std::string, TextContent> readTextsOf(const std::vector<CloudNode> &nodes);
    void readTexts(const std::vector<VaultFile> &files);

    // справка
    void startGuide();
    GuideResult writeGuide(GuideMode mode, GuideDrive check, const NotesOptions &options);
    bool writeGuideMarker(const NotesOptions &options);

    // правки
    std::optional<std::string> ensureFolder(const std::string &name, const std::optional<std::string> &parent = {});
    std::string uniqueTitle(const std::string &title, const std::vector<NoteRef> &notes) const;
    std::optional<WriteResult> writeText(const json &args);
    std::optional<WriteResult> writeNote(const NoteEntry &note, const std::string &text,
                                         const std::optional<std::string> &expectedFileId);
    std::string reconcileNote(const NoteEntry &note, const std::string &base, const std::string &mine,
                              const std::string &theirs, const std::string &vaultName);
    bool applyOps(const std::string &container, const json &ops);
    bool renameCloudNode(const std::string &container, const CloudNode &node, const std::string &name);
    bool moveCloudNodes(const std::string &container, const std::vector<CloudNode> &nodes,
                        const std::optional<std::string> &target);
    bool trashCloudNodes(const std::string &container, const std::vector<CloudNode> &nodes);
    template <typename F> void withSyncSuspended(F &&run);

    NotesHost &host_;
    std::vector<NoteRef> notes_;
    std::vector<CanvasRef> canvases_;
    std::vector<NoteFolder> folders_;
    NotesStatus status_ = NotesStatus::Loading;
    std::optional<NotesNotice> notice_;
    std::optional<std::string> guideOpenId_;
    uint64_t notesRevision_ = 0, canvasesRevision_ = 0, foldersRevision_ = 0, revision_ = 0;

    CloudDataRef data_;
    CloudDataRef lastSyncedData_;
    bool isListening_ = false;
    bool isDirty_ = false;
    bool isSyncing_ = false;
    int consumers_ = 0;
    int suspendDepth_ = 0;
    std::set<std::string> knownMarkers_;
    std::map<std::string, TextContent> texts_;
    std::optional<std::string> userId_;
    std::optional<NotesOptions> options_;
    bool isGuideRunning_ = false;
    bool isGuideSettled_ = false;
    int guideAttempts_ = 0;
    bool isBatchReadMissing_ = false;
    std::optional<std::map<std::string, TextContent>> textCache_;
    std::optional<std::pair<std::string, uint64_t>> appliedPlanner_; // подпись задач и ревизия заметок
};

} // namespace parvane::sections::notes
