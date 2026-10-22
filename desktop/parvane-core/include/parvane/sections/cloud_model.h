// Parvane fork (spec 029, фаза 4): чистая логика раздела «Облако» — порт web
// `components/parvane/cloud/cloudModel.ts`. Дерево контейнера, как его отдаёт движок (узлы уже сведены, имена
// соседей различны), и то, что над ним считает экран: содержимое папки, путь, сортировка, поиск, корзина,
// свободное имя, занятое место, вид файла. Без UI, сети и часов: «сейчас» — параметр.
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::sections::cloud {

// Узел дерева (web `CloudNodeJson`): `kind` — "folder" | "file"; `blob`/`thumb` — как есть из движка
struct CloudNode {
    std::string id;
    std::string kind = "file";
    std::optional<std::string> parent; // нет (или "") — корень
    std::string name;
    int64_t size = 0;
    std::string mime;
    int64_t mtime = 0;
    bool trashed = false;
    bool trashTop = false;
    int64_t trashedAt = 0;
    std::optional<nlohmann::json> blob;
    std::optional<nlohmann::json> thumb;

    bool isFolder() const { return kind == "folder"; }
};

// JSON узла — те же имена полей, что в web (camelCase); пустой `parent` читается как «корень»
void from_json(const nlohmann::json &j, CloudNode &node);
void to_json(nlohmann::json &j, const CloudNode &node);

enum class SortKey { Name, Date, Size };
struct Sort {
    SortKey key = SortKey::Name;
    bool isDescending = false;
};

enum class FileKind { Photo, Video, Audio, Pdf, Text, Other };
// "photo" | "video" | "audio" | "pdf" | "text" | "other" — как в web
const char *fileKindName(FileKind kind);

enum class NameError { Empty, TooLong, BadChars, Reserved };
// "empty" | "too-long" | "bad-chars" | "reserved"
const char *nameErrorName(NameError error);

inline constexpr int64_t kNameMaxBytes = 255;
inline constexpr int kMaxNodes = 8000;
inline constexpr int64_t kDayMs = 24LL * 60 * 60 * 1000;
// Срок корзины: старше — стирает устройство владельца при синхронизации
inline constexpr int64_t kTrashLifetimeMs = 30 * kDayMs;
// Текстовый файл крупнее в просмотре не открывается (его можно скачать)
inline constexpr int64_t kTextPreviewMaxBytes = 1024 * 1024;

// Расширение без точки, строчными; нет — ""
std::string getExtension(std::string_view name);

// Проверка имени — та же, что в движке (`cloud::check_name`)
std::optional<NameError> validateName(std::string_view name);

// Свободное имя среди соседей: «отчёт.pdf» → «отчёт (2).pdf»
std::string freeName(const std::vector<std::string> &taken, const std::string &name);

// Содержимое папки (`parent` не задан — корень); корзина — отдельно
std::vector<CloudNode> childrenOf(const std::vector<CloudNode> &nodes, const std::optional<std::string> &parent = {});

// Служебный файл Parvane: файл с именем на `.parvane-` (без учёта регистра)
bool isServiceNode(const CloudNode &node);

// Узлы для показа: без служебных файлов (в web без служебных возвращается тот же массив — здесь копия)
std::vector<CloudNode> listedNodes(const std::vector<CloudNode> &nodes);

// Имена, занятые в папке (для подбора свободного)
std::vector<std::string> namesIn(const std::vector<CloudNode> &nodes, const std::optional<std::string> &parent = {},
    const std::optional<std::string> &exceptId = {});

// Путь от корня до узла включительно
std::vector<CloudNode> pathOf(const std::vector<CloudNode> &nodes, const std::optional<std::string> &id = {});

// Узел и все его потомки (порядок — обход в ширину, как в web)
std::vector<CloudNode> subtreeOf(const std::vector<CloudNode> &nodes, const std::string &id);

// Можно ли переместить узлы в папку: не в себя и не в свою вложенную
bool canMoveInto(const std::vector<CloudNode> &nodes, const std::vector<std::string> &movedIds,
    const std::optional<std::string> &target = {});

// Сравнение имён как Intl.Collator({numeric: true}): числа по значению, регистр и диакритика — слабее букв.
// Без ICU — приближение корневой сортировки Unicode (латиница, кириллица, греческий и т. п.).
// `numeric = false` — как `String.prototype.localeCompare` без числового режима (цифры знак за знаком:
// «отчёт 10» раньше «отчёт 2»); так web строит план ссылки для людей без аккаунта (`cloudLinks.ts buildLinkPlan`)
int compareNames(std::string_view a, std::string_view b, bool numeric = true);

// Папки выше файлов; дальше — по выбранному полю, при равенстве — по имени
std::vector<CloudNode> sortNodes(const std::vector<CloudNode> &nodes, const Sort &sort);

// Поиск по части имени во всём контейнере, кроме корзины
std::vector<CloudNode> searchNodes(const std::vector<CloudNode> &nodes, std::string_view query);

// Корзина: положенное явно, свежие первыми
std::vector<CloudNode> trashOf(const std::vector<CloudNode> &nodes);

// Положенное в корзину и пролежавшее там дольше срока
std::vector<CloudNode> expiredTrashOf(const std::vector<CloudNode> &nodes, int64_t nowMs,
    int64_t lifetimeMs = kTrashLifetimeMs);

// Сколько полных или начатых дней осталось лежать в корзине (0 — срок вышел); не больше срока
int trashDaysLeft(const CloudNode &node, int64_t nowMs, int64_t lifetimeMs = kTrashLifetimeMs);

struct Usage {
    int64_t total = 0;
    int64_t trash = 0;
    bool operator==(const Usage &) const = default;
};
// Размеры: всё содержимое и отдельно корзина
Usage usageOf(const std::vector<CloudNode> &nodes);

// Размер папки со всем вложенным
int64_t sizeOf(const std::vector<CloudNode> &nodes, const std::string &id);

struct FolderStats {
    int count = 0;
    int64_t size = 0;
    bool operator==(const FolderStats &) const = default;
};
// Счётчики всех папок одним проходом: `count` — показываемые дети, `size` — всё поддерево (с корзиной и
// служебными). Папки без детей в ответе нет
std::map<std::string, FolderStats> folderStats(const std::vector<CloudNode> &nodes);

FileKind kindOfFile(std::string_view mime, std::string_view name);

// Подпись типа файла для заглушки просмотра: расширение прописными («3MF»); нет короткого — ""
std::string fileTypeLabel(std::string_view name);

// Ревью безопасности 21 окт 2026 (2.3): файл, имя и тип которого выбирает другой (вложение статьи, файл
// совместной папки), система откроет по расширению. Открывать можно только картинку, видео или звук с известным
// расширением, и только если вид по расширению совпадает с видом по mime (пустой mime — по расширению);
// иначе — «Сохранить как». `x.desktop` с `image/png` — нет.
bool safeToOpenExternally(std::string_view mime, std::string_view name);

// Имя файла на диске из чужого имени: без `/`, `\`, управляющих знаков и ведущих точек, не длиннее
// kLocalNameMaxBytes байт (расширение сохраняется); пустое и «.»/«..» — "file"
inline constexpr std::size_t kLocalNameMaxBytes = 200;
std::string safeLocalName(std::string_view name);

// Текст файла для просмотра (UTF-8 на выходе): UTF-8 (в том числе с меткой), UTF-16 с меткой, иначе —
// windows-1251. Двоичное (нулевые байты) — nullopt
std::optional<std::string> decodeTextPreview(std::string_view bytes);

} // namespace parvane::sections::cloud
