// Parvane fork (spec 029, T064): файлы раздела «Облако» на desktop — порт частей web `api/parvane/cloudDrive.ts`,
// которых нет в cloud_sync.h: загрузка файла с миниатюрой и проверкой места, скачивание, миниатюра, перенос между
// контейнерами (копия блобов на сервере, `moveNodes`), «Сделать общей» / «Закрыть доступ», ссылки для людей без
// аккаунта (spec 022: план, список, запись владельца — `api/parvane/cloudLinks.ts`).
//
// Отличие от web: блобы грузятся и качаются целиком (CloudBlobs без потока), поэтому ход загрузки и скачивания —
// пофайловый (0 → 100 %); у переноса и ссылки — по порциям/файлам, как в web. Отмена — между шагами.
// Крипто (SHA-256, PVB2 заданным ключом, случайные байты) и сырые загрузки — у CloudBlobs (сессия).
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/cloud_sync.h"

namespace parvane::sections::cloud {

using nlohmann::json;

// ── размеры шифртекста PVB2 (cloudBlobs.ts) ──────────────────────────────────────────────────────────────────

inline constexpr std::int64_t kBlobChunkBytes = 256 * 1024;
inline constexpr std::int64_t kBlobHeaderBytes = 8;
inline constexpr std::int64_t kBlobTagBytes = 16;

// Длина шифртекста PVB2 для открытого файла `size` байт
std::int64_t cloudCipherSize(std::int64_t size);
// Открытый размер по длине шифртекста (обратное к cloudCipherSize)
std::int64_t cloudPlainSize(std::int64_t cipherSize);

// ── потолки скачивания в память (ревью безопасности 21 окт 2026, 2.2) ─────────────────────────────────────────
// Размер блоба называет загрузивший (в совместной папке — любой редактор), число чанков — сервер. Потолок
// шифртекста едет в описании блоба полем kBlobMaxBytesKey (cloud_sync.h).
// Миниатюра узла (JPEG до 320 px — с запасом)
inline constexpr std::int64_t kThumbMaxBytes = 2 * 1024 * 1024;
// Наибольший шифртекст PVB2 для открытого размера `plain` при любом размере чанка (0 и меньше — 0)
std::int64_t cipherCeiling(std::int64_t plain);
// Описание блоба с потолком шифртекста для открытого размера `plain` (0 — без своего потолка)
json withMaxBytes(json blob, std::int64_t plain);

// ── ссылки (cloudLinks.ts) ────────────────────────────────────────────────────────────────────────────────────

inline constexpr int kLinkMaxFiles = 500;
inline constexpr int kLinkMaxThumbs = 60;
inline constexpr std::size_t kLinkManifestMaxBytes = 1024 * 1024;
inline constexpr std::size_t kLinkOwnerRecordMaxBytes = 4096;
inline constexpr int kLinkTtlDays[] = {1, 7, 30, 0};
inline constexpr int kLinkDefaultTtlDays = 7;
inline constexpr std::size_t kLinkKeyBytes = 32;

struct LinkPlanFile {
    std::string path;
    json node; // узел дерева (CloudNodeJson)
};

// Что войдёт в ссылку: файл либо папка со всем вложенным (корзина и служебные файлы — нет). `error` — "not-found" |
// "too-many" (тогда остальное пусто)
struct LinkPlan {
    std::string name;
    std::string kind; // file | folder
    std::vector<std::string> dirs;
    std::vector<LinkPlanFile> files;
    std::int64_t bytes = 0;
    std::string error;
};

// `nodeId` не задан — весь контейнер (совместная папка целиком) под названием `rootName`
LinkPlan buildLinkPlan(const json &nodes, const std::optional<std::string> &nodeId, const std::string &rootName = {});

struct LinkCopy {
    std::string fileId;
    std::int64_t blobSize = 0;
    std::int64_t chunks = 1;
    std::optional<json> thumb; // {fileId, nonce, blobSize}
};

// Список ссылки (manifest v1): папки, затем файлы плана с указателями на копии. Файл без копии — исключение
json buildManifest(const LinkPlan &plan, const std::map<std::string, LinkCopy> &copies, std::int64_t createdSec);

std::string toBase64Url(const std::string &bytes);
// base64url (и обычный base64) → байты; негодная строка — nullopt
std::optional<std::string> fromBase64Url(const std::string &text);
// `https://<сервер>/s/<link_id>#k=<ключ>`; ключ остаётся во фрагменте
std::string buildLinkUrl(const std::string &origin, const std::string &linkId, const std::string &keyB64Url);
// Адрес web-клиента по адресу gateway: `wss://host:port/ws` → `https://host:port` (ws:// → http://)
std::string originOfGateway(const std::string &gatewayUrl);

// Запись владельца (`u32 BE эпоха | шифртекст`): открытый JSON и разбор (проверки — как `openOwnerRecord` web)
json ownerRecordJson(const std::string &name, const std::string &kind, const std::string &keyB64Url, std::int64_t epoch,
                     const std::optional<std::pair<std::string, std::string>> &source);
// Разобрать расшифрованную запись; негодная — nullopt. В ответе: name, kind, key, source?
std::optional<json> parseOwnerRecord(const std::string &plain);

// Последняя готовая ссылка на узел (источник — из записи владельца): `node` пусто — вся папка-контейнер
std::optional<json> linkOfSource(const json &links, const std::string &container, const std::string &node);

// ── операции ──────────────────────────────────────────────────────────────────────────────────────────────────

struct MoveItem {
    std::string id;
    std::string name;
};

struct UploadThumb {
    std::string jpeg;
    int width = 0;
    int height = 0;
};

struct UploadRequest {
    std::string container; // id либо "root"
    std::optional<std::string> parent;
    std::string name;
    std::string mime;
    std::int64_t mtime = 0;
    std::string bytes;
    std::optional<UploadThumb> thumb; // JPEG не больше 320 px — готовит вызывающий (в web — canvas)
};

struct DownloadResult {
    bool ok = false;
    std::string bytes;
    std::string name;
    std::string error;
};

class CloudFiles {
public:
    // done, total; у ссылки — число файлов
    using Progress = std::function<void(std::int64_t done, std::int64_t total)>;
    // true — пользователь отменил (проверяется между шагами)
    using Cancelled = std::function<bool()>;

    explicit CloudFiles(CloudDrive &drive, std::function<std::string()> newNodeId = {});

    // Загрузить файл в папку (`parvaneCloudUpload`): {ok, container, node} | {ok:false, error}
    json upload(const UploadRequest &request);
    // Скачать файл узла целиком (`parvaneCloudDownload` в память)
    DownloadResult download(const std::string &container, const std::string &node);
    // Байты по описанию блоба узла (`parvaneCloudOpenBlob`); нет — nullopt. `maxPlainBytes` > 0 — потолок
    // содержимого (просмотр): больше — nullopt без скачивания целиком
    std::optional<std::string> open(const json &node, std::int64_t maxPlainBytes = 0);
    // Миниатюра узла (JPEG) по `blob` и `thumb` узла (`parvaneCloudThumb`), не больше kThumbMaxBytes; нет — nullopt
    std::optional<std::string> thumb(const json &node);

    // Узлы со всем вложенным — в папку другого контейнера (`parvaneCloudMove`): {ok} | {ok:false, error}
    json move(const std::string &from, const std::vector<MoveItem> &items, const std::string &to,
              const std::optional<std::string> &parent, Progress progress = {}, Cancelled cancelled = {});
    // Папку личного диска — в новую совместную (`parvaneCloudShareFolder`): {ok, container}
    json shareFolder(const std::string &container, const std::string &node, Progress progress = {},
                     Cancelled cancelled = {});
    // Свою совместную папку — в папку личного диска `name` (`parvaneCloudUnshareFolder`)
    json unshareFolder(const std::string &container, const std::string &name, Progress progress = {},
                       Cancelled cancelled = {});

    // Свои ссылки (`parvaneCloudLinks`): {ok, links:[{id, state, createdAt, expiresAt, bytes, files, name?, kind?,
    // url?, source?}]} — свежие первыми; `origin` — адрес web-клиента для полного адреса ссылки
    json links(const std::string &origin);
    // Создать ссылку (`parvaneCloudLinkCreate`): {ok, link}; ход — «N из M» файлов
    json linkCreate(const std::string &container, const std::optional<std::string> &node, const std::string &name,
                    int ttlDays, const std::string &origin, Progress progress = {}, Cancelled cancelled = {});
    json linkRevoke(const std::string &linkId);
    // Новый срок (0 — без срока): {ok, expiresAt}
    json linkExtend(const std::string &linkId, int ttlDays);

private:
    json call(const std::string &method, const json &body);
    std::optional<json> findNode(const std::string &container, const std::string &node);
    json nodesOf(const std::string &container);
    json withDomain(json blob);
    std::pair<std::string, std::string> copyDriveBlob(const std::string &fileId, const std::string &capability);
    void dropBlobs(const std::vector<std::string> &ids);
    std::int64_t moveNodes(const std::string &from, const std::vector<MoveItem> &items, const std::string &to,
                           const std::optional<std::string> &parent, const std::optional<std::string> &wrapper,
                           const Progress &progress, const Cancelled &cancelled);
    void removeShared(const std::string &container);
    std::map<std::int64_t, std::string> driveKeys();
    std::string labelNonce(const std::string &label, const std::string &linkId);
    std::optional<json> readLink(const json &reply, const std::map<std::int64_t, std::string> &keys,
                                 const std::string &origin);
    json createLink(const std::string &container, const std::optional<std::string> &node, const std::string &name,
                    int ttlDays, const std::string &origin, const Progress &progress, const Cancelled &cancelled);

    CloudDrive &drive_;
    std::function<std::string()> newNodeId_;
};

} // namespace parvane::sections::cloud
