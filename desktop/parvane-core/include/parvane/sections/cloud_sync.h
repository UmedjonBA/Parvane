// Parvane fork (spec 029, T033/T034): «Облако» на сервере — порт web `api/parvane/v2/cloud.ts` (контейнеры
// домена `cloud.v1` шарда domains: личный диск, свои и чужие совместные папки), провайдерной части
// `api/parvane/cloudDrive.ts`, нужной разделам (состояние, правки дерева, запись/чтение текстов с проверкой
// версии, сверка личного диска, совместные папки, занятое место) и чистых построителей операций
// `components/parvane/cloud/cloudStore.ts` (новая папка, переименование, перенос, корзина, восстановление,
// окончательное удаление).
//
// Жизненный цикл (как web): найти контейнеры (журнал личного состояния + `domain.container.list` своего сервера
// и серверов чужих папок, spec 028), подключить, снимок и журнал (`domain.op.sync`), очередь отправки своих
// операций по контейнеру (запись `cloud-outbox:<id>`), снимок по порогу, опрос 8 с при открытом разделе и
// видимом окне / 60 с, повтор 15 с без связи, доступ участников, сборка блобов стёртых файлов (`cloud-gc`), срок
// корзины (раз в час). Статусы: loading | needs-linking | no-key | offline | ready.
// Устройство — как у planner_sync.h: блокирующие вызовы в одном рабочем потоке, «фоновое» web — сроки и `tick()`.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/cloud_model.h"
#include "parvane/sections/domain_sync.h"

namespace parvane::sections::cloud {

using nlohmann::json;

inline constexpr const char *kCloudDomain = "cloud.v1";
inline constexpr const char *kCloudOutboxRecord = "cloud-outbox:";
inline constexpr const char *kCloudGcRecord = "cloud-gc";
inline constexpr const char *kCloudRemoteDomainsRecord = "cloud-remote-domains";
inline constexpr std::size_t kGcKeep = 2000;
inline constexpr std::int64_t kSyncActiveMs = 8000;
inline constexpr std::int64_t kSyncIdleMs = 60000;
inline constexpr std::int64_t kRetryOfflineMs = 15000;
inline constexpr int kSyncPages = 50;
inline constexpr std::size_t kMaxOpsPerBatch = 400;
inline constexpr std::int64_t kTrashCheckMs = 60LL * 60 * 1000;

// Запись журнала личного состояния о контейнере облака (id — hex). role: root | owned | shared;
// status: "" | accepted | declined
struct CloudStateEntry {
    std::string id;
    std::string domain;
    std::string role;
    std::string status;
    bool isRemoved = false;
    std::string owner;
    bool operator==(const CloudStateEntry &) const = default;
};

// Снимок журнала личного состояния (proto3-JSON, поле `cloud_containers`) → записи (web `parseCloudEntries`);
// роль и статус — именем перечисления либо числом
std::vector<CloudStateEntry> parseCloudEntries(const json &snapshot);
// Запись → аргумент `containerJson` функции журнала `cloudContainerSet` (web `recordCloudEntry`)
json cloudEntryToState(const CloudStateEntry &entry);

struct ContainerMember {
    std::string user;
    std::string role; // owner | editor | reader
};

// Контейнер для экрана (web `CloudContainerInfo`); kind: root | owned | shared | invite
struct CloudContainerInfo {
    std::string id;
    std::string kind;
    std::string role;
    std::string owner;
    std::string name;
    bool hasKey = false;
    std::vector<ContainerMember> members;
};
json toJson(const CloudContainerInfo &info);

struct CloudHooks {
    // Контейнеры облака из журнала личного состояния (`parseCloudEntries` снимка сессии)
    std::function<std::vector<CloudStateEntry>()> stateEntries;
    // Записать контейнер в журнал личного состояния: `Session::stateCall("cloudContainerSet",
    // {"containerJson": cloudEntryToState(entry)})`
    std::function<void(const CloudStateEntry &)> recordEntry;
    // Стереть свой блоб на сервере (`cloud.blob.delete {file_id}`); отказ — domain::BusError
    std::function<void(const std::string &fileId)> deleteBlob;
    // Перечитать журнал устройств собеседника (новое устройство участника папки)
    std::function<void(const std::string &user)> refreshPeerLog;
    // Дерево, состав или статус изменились — UI перечитает
    std::function<void()> onChanged;
};

class CloudSync {
public:
    CloudSync(domain::DomainTransport &transport, domain::RecordStore &records, CloudHooks hooks);

    // Раздел открыт (`active`) либо облако понадобилось в фоне: синхронизация сейчас (со списком)
    void ensure(bool active);
    // То же «в фоне» (web `void cloud.ensure(false)` из `parvaneCloudState`): срок «сейчас»
    void ensureSoon(bool active);
    void setActive(bool active);
    void setVisible(bool visible);
    // Правки дерева (`container` — id либо "root"): применяются локально сразу (ошибка движка — исключением),
    // на сервер уходят очередью (`tick`). Возвращает id контейнера
    std::string apply(const std::string &container, const json &ops);
    // Дослать очередь контейнера и стереть блобы удалённого; true — сервер принял всё
    bool flush(const std::string &id);
    void syncNow(bool shouldDiscover = false);
    void tick();
    [[nodiscard]] std::optional<std::int64_t> nextWakeMs() const;

    // Сверка личного диска: "unknown" | "none" | "synced"
    std::string checkDrive();
    std::vector<CloudContainerInfo> containers();
    std::optional<json> stateJson(const std::string &id);
    // Ревизия деревьев в движке: растёт при каждом их изменении (ключ кэша разбора)
    [[nodiscard]] std::uint64_t revision() const { return revision_; }
    std::optional<std::string> rootId();
    std::string status();
    [[nodiscard]] std::optional<std::string> lastError() const { return lastError_; }
    [[nodiscard]] bool hasPending(const std::string &id) const;
    std::string createFolder(const std::string &name);
    // role: editor | reader
    void share(const std::string &id, const std::string &user, const std::string &role, const std::string &inviteText);
    void unshare(const std::string &id, const std::string &user);
    void answerInvite(const std::string &id, bool accept);
    void noteRemoteDomain(const std::string &domainName);
    void leave(const std::string &id);
    void removeFolder(const std::string &id);
    void rotate(const std::string &id);
    std::optional<json> keysExport();
    void keysImport(const json &value);
    // Событие движка `cloudChanged` (ключ принят / контейнер надо подключить)
    void onEngineEvent(const std::string &id);
    void reset();

private:
    struct OutboxItem {
        std::string opId;
        std::string op;
    };
    struct EngineContainer {
        std::string id, owner, role, name;
        bool hasKey = false;
        std::int64_t headSeq = 0, epoch = 0, grantVersion = 0;
        std::vector<ContainerMember> members;
    };

    json engine(const std::string &name, const json &args = json::object());
    json engineNeeds(const std::string &name, const json &args);
    bool hasClient();
    std::string call(const std::string &method, const std::string &body, const std::string &dest);
    std::string encode(const std::string &method, const json &value);
    void run(const json &reqs);
    void setStatus(const std::string &next);
    std::string domainOf(const std::string &id);
    json refJson(const std::string &id);
    std::vector<EngineContainer> engineContainers();
    std::optional<EngineContainer> findEngine(const std::string &id);
    std::vector<CloudStateEntry> stateEntries();
    std::vector<CloudStateEntry> liveEntries();
    bool isAttached(const std::string &id);
    bool hasKey(const std::string &id);
    std::int64_t headSeq(const std::string &id);
    std::int64_t grantVersion(const std::string &id);
    void touch();
    void persistIfDirty();

    std::vector<OutboxItem> &loadOutbox(const std::string &id);
    void saveOutbox(const std::string &id);
    bool attach(const std::string &id);
    void dropContainer(const std::string &id);
    std::set<std::string> &loadRemoteDomains();
    void discover();
    void shareWithOwnDevices(const std::string &id);
    std::string createContainer(const std::string &role, const std::string &name);
    std::optional<std::string> ensureRoot(bool createIfMissing);
    void pullGrants(const std::string &id);
    void refreshAuthors(const std::string &id);
    bool pull(const std::string &id);
    void maybeSnapshot(const std::string &id);
    int sendOutbox(const std::string &id);
    void collectGarbage(const std::string &id);
    bool purgeExpiredTrash(const std::string &id);
    bool syncContainer(const std::string &id);
    void scheduleRetry();
    void scheduleSync();
    void applyNow(const std::string &id, const json &ops);
    void runGrantRequests(const std::string &id, const json &reqs);
    void leaveNow(const std::string &id);
    void runEngineEvent(const std::string &id);
    void sendSoonQueue();

    domain::DomainTransport &t_;
    domain::RecordStore &records_;
    CloudHooks hooks_;

    std::string status_ = "loading";
    std::map<std::string, std::vector<OutboxItem>> outboxes_;
    std::set<std::string> snapshotTried_;
    // Чужие контейнеры, в которых доступа больше нет (сервер ответил NOT_FOUND)
    std::set<std::string> lost_;
    std::optional<std::vector<std::string>> gcDone_;
    std::set<std::string> gcChecked_;
    std::map<std::string, std::int64_t> trashCheckedAt_;
    std::optional<std::set<std::string>> remoteDomains_;
    domain::Deadline syncTimer_, retryTimer_, syncSoon_, sendSoon_, eventSoon_;
    bool discoverSoon_ = false;
    std::vector<std::string> sendQueue_;   // контейнеры, чью очередь дослать (web — фоновый sendOutbox после apply)
    std::vector<std::string> eventQueue_;  // события движка cloudChanged
    bool isWanted_ = false;
    bool isActive_ = false;
    bool isVisible_ = true;
    bool isDiscovered_ = false;
    bool isDirty_ = false;
    std::uint64_t revision_ = 0;
    std::optional<int> ownOnServer_;
    std::optional<std::string> lastError_;
};

// ── провайдер раздела (cloudDrive.ts): методы `parvaneCloud*` ─────────────────────────────────────────────

// Потолок шифртекста в описании блоба для CloudBlobs::download (ревью безопасности 21 окт 2026, 2.2): реализация
// передаёт его сессии (Session::downloadBlobCap), больше — отказ до приёма чанков. Нет поля — общий потолок сессии.
inline constexpr char kBlobMaxBytesKey[] = "maxBytes";

// Блобы личного диска (PVB2, bucket DRIVE): загрузка и скачивание делает сессия
class CloudBlobs {
public:
    virtual ~CloudBlobs() = default;
    // Загрузить байты → {fileId, key, nonce, capability, size, chunks} (base64-поля как в web
    // `uploadCloudBlob`). Отказ — исключение (domain::BusError с кодом сервера)
    virtual json upload(const std::string &bytes, const std::string &mime) = 0;
    // Скачать и расшифровать блоб узла (`CloudBlobInfo` web); нет — nullopt
    virtual std::optional<std::string> download(const json &blob) = 0;
    // `cloud.blob.usage` → ответ (proto3-JSON: buckets[], links_bytes)
    virtual json usage() = 0;

    // ── для файлов раздела (cloud_files.h, spec 029 T064): миниатюры, перенос, ссылки ──
    // Крипто и сеть — у сессии; по умолчанию не поддержано (исключение std::runtime_error)
    // Случайные байты (секреты доступа, nonce, ключ ссылки)
    virtual std::string randomBytes(std::size_t n);
    // SHA-256 (сырые 32 байта)
    virtual std::string sha256(const std::string &bytes);
    // PVB2 заданным ключом и nonce (сырые 32 и 12 байт) — как `encryptBlobWithKey` web
    virtual std::string sealWithKey(const std::string &plain, const std::string &keyRaw, const std::string &nonceRaw);
    // Расшифровать PVB2 (ключ и nonce — base64); подделка либо чужой ключ — nullopt
    virtual std::optional<std::string> openWithKey(const std::string &cipher, const std::string &keyB64,
                                                   const std::string &nonceB64);
    // Загрузить готовый шифртекст в bucket DRIVE под секретом доступа (сырые 32 байта) → file_id
    virtual std::string uploadCipher(const std::string &cipher, const std::string &capabilityRaw);
};

// Код ошибки для экрана (web `errorOf`): offline | no-space | too-large | forbidden | rejected | not-found |
// too-many | link-*
std::string errorOf(const std::exception &e);

class CloudDrive {
public:
    CloudDrive(CloudSync &cloud, CloudBlobs &blobs, domain::DomainTransport &transport,
               std::function<std::string()> newNodeId = {});

    // Метод провайдера по имени web (`parvaneCloudState`, `parvaneCloudApply`, `parvaneCloudWriteText`, …) с
    // аргументами-объектом как в web. nullopt — метод не поддержан либо отказ, который web отдаёт `undefined`
    std::optional<json> handle(const std::string &method, const json &args);

    json state();
    json applyOps(const std::string &container, const json &ops);
    json writeText(const json &args);
    std::optional<json> readText(const std::string &container, const std::string &node, const json &blob);
    json readTexts(const std::string &container, const json &nodes);
    std::optional<json> usage(bool force = false);
    json createShared(const std::string &name);
    json removeShared(const std::string &container);

    // Разобранное дерево контейнера (кэш по ревизии CloudSync)
    std::optional<json> readTree(const std::string &container);

    // Для файлов раздела (cloud_files.h): общие синхронизация, блобы, транспорт; занятое место перечитать
    CloudSync &sync() { return cloud_; }
    CloudBlobs &blobs() { return blobs_; }
    domain::DomainTransport &transport() { return t_; }
    void forgetUsage() { usage_.reset(); }

private:
    std::optional<json> findNode(const std::string &container, const std::string &node);
    template <typename F> json result(F &&f);

    CloudSync &cloud_;
    CloudBlobs &blobs_;
    domain::DomainTransport &t_;
    std::function<std::string()> newNodeId_;
    std::map<std::string, std::optional<json>> treeCache_;
    std::uint64_t treeCacheRevision_ = UINT64_MAX;
    bool isEnsureStarted_ = false;
    std::optional<std::pair<std::int64_t, json>> usage_;
};

// Новый id узла: 16 случайных байт hex (web `newCloudNodeId`)
std::string newCloudNodeId();

// ── построители операций экрана (cloudStore.ts) ────────────────────────────────────────────────────────────

// Новая папка в `parent` (нет — корень) со свободным именем
json createFolderOps(const std::vector<CloudNode> &nodes, const std::optional<std::string> &parent,
                     const std::string &name, const std::string &newId);
// Переименование (то же имя — операций нет)
json renameOps(const std::vector<CloudNode> &nodes, const CloudNode &node, const std::string &name);
// Перенос узлов в папку того же контейнера; уже лежащие там пропускаются, имена — свободные
json moveOps(const std::vector<CloudNode> &all, const std::vector<CloudNode> &moved,
             const std::optional<std::string> &target);
json trashOps(const std::vector<CloudNode> &nodes, std::int64_t at);
// Вернуть из корзины: в прежнюю папку, а если её уже нет (либо она в корзине) — в корень; занятое имя — с номером
json restoreOps(const std::vector<CloudNode> &all, const std::vector<CloudNode> &nodes);
json purgeOps(const std::vector<CloudNode> &nodes, std::int64_t at);
// Может ли пользователь менять содержимое контейнера (личный диск, свой либо как редактор)
bool canEditContainer(const std::optional<CloudContainerInfo> &container);
// Корзины всех контейнеров, где можно восстанавливать и стирать: (контейнер, узел)
std::vector<std::pair<std::string, CloudNode>> trashAcross(const std::vector<CloudContainerInfo> &containers,
    const std::map<std::string, std::vector<CloudNode>> &trees);

} // namespace parvane::sections::cloud
