// Parvane fork (spec 029, фаза 4): «Выгрузка данных» — порт web `components/parvane/export/exportModel.ts`
// (что лежит в архиве, имена файлов, страницы чатов HTML/JSON) и чистой части `exportRun.ts` (пути файлов облака,
// сборка архива из подставляемого источника). Вид — как у выгрузки Telegram Desktop: на чат папка с
// `messages.html` и `messages.json`, вложения — рядом в `media/`.
//
// Время: в web страницы показывают местное время браузера. Здесь местное время даёт функция `LocalTimeFn`
// (по умолчанию — UTC); системные часы и часовой пояс внутри логики не читаются.
// Длины («80 знаков» имени, «80 знаков» превью ответа) — в кодовых точках (в web — кодовые единицы UTF-16).
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/cloud_model.h"
#include "parvane/sections/export_zip.h"

namespace parvane::sections::exportdata {

// --- время ---

struct CivilTime {
    int year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0;
};
// Местное время по unix-секундам (подставляет UI: часовой пояс устройства)
using LocalTimeFn = std::function<CivilTime(int64_t unixSeconds)>;
CivilTime utcCivil(int64_t unixSeconds);

// `YYYY-MM-DD`
std::string formatDay(const CivilTime &t);
// `YYYY-MM-DDTHH:MM:SS.000Z` (как Date.toISOString)
std::string isoOf(int64_t unixSeconds);

// --- снимок ---

struct ExportReaction {
    std::string emoji;
    int64_t count = 0;
};

// Сообщение чата в снимке (из строки кэша истории); `content` — содержимое провода (JSON, поля snake_case)
struct ExportSourceMessage {
    std::string uuid;
    std::string from;
    std::string fromName;
    bool isOutgoing = false;
    int64_t ts = 0; // unix-секунды
    std::optional<std::string> replyTo;
    bool edited = false;
    std::optional<int64_t> editedAt;
    bool pinned = false;
    nlohmann::json content = nlohmann::json::object();
    std::optional<std::vector<ExportReaction>> reactions;
};

struct ExportSourceChat {
    std::string address;
    std::string kind; // user | group | channel | saved
    std::string title;
    std::vector<ExportSourceMessage> messages;
};

struct ExportContact {
    std::string address;
    std::string name;
    bool isExplicit = false;
};

struct ExportSnapshot {
    std::string self;
    std::string selfName;
    std::vector<ExportSourceChat> chats;
    std::vector<ExportContact> contacts;
};

enum class ExportMediaStatus { Included, NotIncluded, Unavailable };
// "included" | "not_included" | "unavailable"
const char *mediaStatusName(ExportMediaStatus status);

struct ExportMedia {
    std::string kind;
    std::string fileId;
    // Путь в архиве относительно папки чата (`media/…`)
    std::string path;
    std::optional<std::string> fileName;
    std::optional<std::string> mime;
    // Числа — как пришли в содержимом (JSON), чтобы вывод совпадал с web
    std::optional<nlohmann::json> size;
    std::optional<nlohmann::json> width;
    std::optional<nlohmann::json> height;
    std::optional<nlohmann::json> duration;
    ExportMediaStatus status = ExportMediaStatus::Included;
};

struct ExportPoll {
    std::string question;
    std::vector<std::string> options;
};

struct ExportLocation {
    nlohmann::json lat;
    nlohmann::json lon; // в JSON — "long"
};

struct ExportArticle {
    std::string title;
    std::string markdown;
};

// Сообщение, как оно ляжет в архив: номер в чате, ответ — номером, вложение — путём
struct ExportMessage {
    int id = 0;
    std::string uuid;
    std::string type; // message | service
    std::string kind;
    int64_t ts = 0;
    std::string from;
    std::string fromName;
    bool isOutgoing = false;
    std::string text;
    std::optional<int> replyToId;
    bool edited = false;
    std::optional<int64_t> editedAt;
    bool pinned = false;
    std::optional<std::string> forwardedFrom;
    std::optional<ExportMedia> media;
    std::optional<ExportPoll> poll;
    std::optional<ExportLocation> location;
    std::optional<ExportArticle> article;
    std::optional<std::vector<ExportReaction>> reactions;
    // Служебное: privacy_on | privacy_off
    std::optional<std::string> action;
};

struct ExportChat {
    // Папка чата в архиве (`chats/…`), без завершающей косой
    std::string dir;
    std::string address;
    std::string kind;
    std::string title;
    std::vector<ExportMessage> messages;
};

// Подписи страниц архива (на языке интерфейса); по умолчанию — английские, как в web
struct ExportLabels {
    std::string title = "Parvane data export";
    std::string chats = "Chats";
    std::string planner = "Planner";
    std::string notes = "Notes";
    std::string contacts = "Contacts";
    std::string cloud = "Cloud files";
    std::string savedMessages = "Saved Messages";
    std::string replyTo = "In reply to";
    std::string forwardedFrom = "Forwarded from";
    std::string edited = "edited";
    std::string mediaNotIncluded = "Media not included";
    std::string mediaUnavailable = "Media unavailable";
    std::string poll = "Poll";
    std::string location = "Location";
    std::string messages = "messages";
    std::string exportedAt = "Exported";
    std::string privacyOn = "enabled enhanced privacy";
    std::string privacyOff = "disabled enhanced privacy";
};

// --- имена и строки ---

std::string escapeHtml(std::string_view value);
// Имя файла без путей и запрещённых в Windows/macOS/Linux символов; пустое — `fallback`
std::string sanitizeFileName(std::string_view name, std::string_view fallback = "file");
// Свободное имя среди занятых (без учёта регистра): `a.jpg` → `a (2).jpg`. Имя запоминается как занятое
std::string uniqueName(std::set<std::string> &taken, const std::string &name);
std::string extForMime(const std::optional<std::string> &mime);
// Имя архива: `parvane-export-<ник>-<YYYY-MM-DD>.zip`
std::string exportArchiveName(std::string_view address, const CivilTime &date);
// Относительная ссылка на файл архива: каждая часть пути — с процентным кодированием (encodeURIComponent)
std::string hrefOf(std::string_view path);

// --- модель и страницы ---

std::vector<ExportMessage> buildChatMessages(const ExportSourceChat &chat, bool includeMedia);
std::vector<ExportChat> assignChatDirs(const std::vector<ExportSourceChat> &chats, const ExportLabels &labels,
    bool includeMedia);
// `messages.json` чата (поля snake_case, отступ 2 — как JSON.stringify(…, 2))
std::string renderChatJson(const ExportChat &chat);
// `messages.html` чата
std::string renderChatHtml(const ExportChat &chat, const ExportLabels &labels, const LocalTimeFn &localTime = {});

struct ExportIndexSections {
    std::optional<std::string> planner;
    std::optional<std::vector<std::string>> notes;
    std::optional<std::string> contacts;
    std::optional<std::vector<std::string>> cloud;
};
struct ExportOwner {
    std::string address;
    std::string name;
};
// `index.html` в корне архива
std::string renderIndexHtml(const ExportOwner &owner, const std::vector<ExportChat> &chats,
    const ExportIndexSections &sections, const ExportLabels &labels, int64_t exportedAtUnixSeconds,
    const LocalTimeFn &localTime = {});

// `contacts.json`
std::string renderContactsJson(const std::vector<ExportContact> &contacts);
// JSON-текст с отступом 2; не JSON — как есть
std::string prettyJson(const std::string &text);

// --- облако в архиве (exportRun.ts) ---

struct ExportTreeFile {
    cloud::CloudNode node;
    std::string path;
};
// Пути файлов дерева облака: папки — каталогами, имена — очищенными и различными в пределах папки. Корзина и
// служебные файлы пропускаются; `root` — откуда начинать. Соседи — по байтам имени (в web — по кодовым единицам
// UTF-16; различие только между знаками вне BMP и U+E000–U+FFFF)
std::vector<ExportTreeFile> treeFilePaths(const std::vector<cloud::CloudNode> &nodes, const std::string &prefix,
    const std::optional<std::string> &root = {},
    const std::function<bool(const cloud::CloudNode &)> &accept = {});

struct ExportCloudFile {
    std::string container;
    std::string node;
    std::string path;
    int64_t size = 0;
    std::optional<int64_t> mtime; // мс
};
struct ExportCloudTree {
    std::string id;
    std::string name;
    std::vector<cloud::CloudNode> nodes;
};
// Файлы облака по контейнерам: каждый контейнер — своя папка `cloud/<название>/`
std::vector<ExportCloudFile> cloudExportFiles(const std::vector<ExportCloudTree> &trees,
    const std::string &fallbackName);

// --- сборка архива (runDataExport, без браузера: источник синхронный) ---

struct ExportNote {
    std::string path; // внутри `notes/`
    std::string text;
    std::optional<int64_t> mtime; // мс
};

struct ExportSource {
    std::function<std::optional<ExportSnapshot>()> snapshot;
    // Расшифрованное вложение кусками; nullopt — недоступно
    std::function<std::optional<ZipWriter::ChunkSource>(const std::string &fileId)> media;
    // Состояние «Плана» (JSON-текст); nullopt — нет данных
    std::function<std::optional<std::string>()> planner;
    std::function<std::vector<ExportNote>()> notes;
    std::function<std::vector<ExportCloudFile>()> cloudFiles;
    std::function<std::optional<ZipWriter::ChunkSource>(const ExportCloudFile &)> cloudBlob;
};

struct ExportOptions {
    bool includeMedia = true;
    bool includeCloud = false;
};

struct ExportProgress {
    std::string stage; // prepare | chats | planner | notes | contacts | cloud | finishing
    int64_t done = 0;
    int64_t total = 0;
    uint64_t bytes = 0;
};

struct ExportResult {
    std::string fileName;
    uint64_t bytes = 0;
    int chats = 0;
    int messages = 0;
    int media = 0;
    int mediaFailed = 0;
    int notes = 0;
    int cloudFiles = 0;
    int cloudFailed = 0;
};

struct ExportRunArgs {
    ExportSource source;
    ExportOptions options;
    ExportLabels labels;
    ZipWriter::Sink sink; // куда пишется архив
    std::function<bool()> canceled;
    std::function<void(const ExportProgress &)> onProgress;
    int64_t nowUnixMs = 0;
    LocalTimeFn localTime; // по умолчанию — UTC
};

// Порядок: чаты (сначала вложения, затем messages.json/html), «План», заметки, контакты, по желанию — облако,
// в конце index.html. Ошибки — ExportError (canceled | too-large | failed); при ошибке записанное в sink
// вызывающий выбрасывает
ExportResult runDataExport(const ExportRunArgs &args);

} // namespace parvane::sections::exportdata
