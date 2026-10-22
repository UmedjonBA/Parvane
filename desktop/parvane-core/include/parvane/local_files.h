// Parvane fork: локальные файлы экземпляра клиента — временный каталог, стирание данных при выходе,
// журнал строк клиента без утечек (ревью безопасности 21 окт 2026, хвосты NAT-16).
//
// Временный каталог: расшифрованные копии, которые нужны по пути (внешнее приложение, плеер tdesktop, загрузка
// в облако), лежат в `<tdata>/parvane-tmp/<вид>/…` (0700/0600) — у каждого экземпляра (`-workdir`) свой, а не
// общий `$TMPDIR/parvane-*` всех экземпляров пользователя. Стирается при старте и при выходе со стиранием (не
// сразу: файл должен жить, пока его держит внешнее приложение).
//
// Выход со стиранием: маркер `<tdata>/parvane-logout-pending` ставится ДО сетевой части выхода и снимается
// последним; оставшийся маркер (процесс закрыли или убили посреди выхода) значит «дотереть при старте».
#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace parvane::localfiles {

inline constexpr char kTempName[] = "parvane-tmp";
inline constexpr char kLogoutMarkerName[] = "parvane-logout-pending";

// Общие временные каталоги прежних версий ($TMPDIR/parvane-*, /tmp/parvane-media): при старте стираются.
[[nodiscard]] const std::vector<std::string> &legacySharedTempNames();

// `<tdata>/parvane-tmp`.
[[nodiscard]] std::string tempRoot(const std::string &tdataDir);
// Каталог `<tdata>/parvane-tmp/<kind>` (kind — [a-z0-9-], иначе ""), все уровни 0700. При поставленной ограде
// записи (storecrypt::blockWrites) или сбое — "".
[[nodiscard]] std::string tempKindDir(const std::string &tdataDir, const std::string &kind);
// Новый пустой подкаталог `<tdata>/parvane-tmp/<kind>/<случайное имя>` (0700); "" — как у tempKindDir.
[[nodiscard]] std::string makeTempDir(const std::string &tdataDir, const std::string &kind);
// Стереть временный каталог экземпляра целиком. true — его больше нет.
bool wipeTempRoot(const std::string &tdataDir);

// Стереть в `sharedTmp` прежние общие каталоги (legacySharedTempNames): только свои (владелец — текущий
// пользователь), символьная ссылка — сама ссылка, без перехода. Возвращает число стёртых.
int removeLegacySharedTemp(const std::string &sharedTmp, std::vector<std::string> *failed = nullptr);

// Маркер незавершённого выхода.
bool setLogoutPending(const std::string &tdataDir);
[[nodiscard]] bool logoutPending(const std::string &tdataDir);

struct WipeResult {
    int removed = 0;                 // стёрто записей tdata/parvane-*
    std::vector<std::string> failed; // не стёрлось (имена)
    bool tempWiped = false;
};
// Стирание данных аккаунта на устройстве (выход со стиранием или его доделка при старте), по порядку:
// 1) ограда записи storecrypt (идущие записи дописываются, новые отклоняются — до allowWrites при входе);
// 2) все `<tdata>/parvane-*`, кроме `keep` (настройки устройства) и маркера; 3) временный каталог;
// 4) ключ хранилища сброшен; 5) маркер снят — последним.
WipeResult wipeAccountData(const std::string &tdataDir, const std::vector<std::string> &keep);

} // namespace parvane::localfiles

// Строки журнала клиента («Parvane…»): в них адреса, имена групп, пути файлов, а в отдельных — содержимое
// (текст сообщения, координаты, SAS звонка, токены ссылок). Релиз пишет их на диск (log.txt tdesktop) только
// при включённом режиме отладки; иначе — только в память (последние строки — для «Сообщить об ошибке»).
// Содержимое заменяется отметкой (secret), даже в памяти — в релизе всегда, в dev-сборке тоже, если явно не
// включено PARVANE_LOG_CONTENT=1 (вместе с шлюзом dev-хуков; verify_*.sh сверяют содержимое по log.txt; ревью 21 окт
// 2026). Строки клиента dev-сборка по-прежнему пишет в log.txt.
namespace parvane::logpriv {

void setDevBuild(bool dev);
[[nodiscard]] bool devBuild();
// Строка клиента (начинается с "Parvane")?
[[nodiscard]] bool isClientLine(const std::string &line);
// Писать ли строку на диск: строки клиента — только в dev-сборке или при явном режиме отладки.
[[nodiscard]] bool keepOnDisk(const std::string &line, bool debugMode);
// Содержимое в журнале открытым текстом: только dev-сборка И setLogContent(true). Иначе — false.
void setLogContent(bool on);
[[nodiscard]] bool logContent();
// Значение, которому не место в журнале (текст, координаты, токен): отметка с длиной, кроме logContent().
[[nodiscard]] std::string secret(const std::string &value);

// Память последних строк клиента (кольцо).
inline constexpr std::size_t kRingCapacity = 500;
void remember(const std::string &line);
[[nodiscard]] std::vector<std::string> recent();
// Строки для «Сообщить об ошибке»: recent(), а при logContent() — одна отметка вместо журнала (содержимое не уходит).
[[nodiscard]] std::vector<std::string> reportLines();
void forget();

} // namespace parvane::logpriv

// Изоляция аккаунтов на устройстве (ревью безопасности 21 окт 2026, вечер). Файлы данных аккаунта без адреса в
// имени (`<tdata>/parvane-scheduled.json`, `-folders.json`, `-notify.json`, кэш расшифровки, кэш медиа…) принадлежат
// аккаунту из маркера `<tdata>/parvane-account-owner` (шифром хранилища). Вход другим адресом (после выхода без
// стирания: протухший или отозванный JWT, удалённый аккаунт, «сессия без адреса») уносит их в каталог прежнего
// аккаунта `<tdata>/parvane-v2-<адрес>/account-files/` и возвращает из такого же каталога файлы входящего —
// новый аккаунт не читает чужое, а прежний при повторном входе получает своё обратно. Установка без маркера
// (до 21 окт): файлы отдаются входящему, только если они его (журнал истории с самой свежей правкой — его адреса).
namespace parvane::accountfiles {

inline constexpr char kOwnerMarkerName[] = "parvane-account-owner";
inline constexpr char kStashDirName[] = "account-files";

// Адрес аккаунта годится как часть имени файла и как адрес: `ник@домен`, ник 1–64 символа [A-Za-z0-9_.-]
// (первый — буква, цифра или `_`), домен — метки [A-Za-z0-9-] через точку (до 253 символов) и, возможно, `:порт`.
// Ни `/`, ни `\`, ни `..`, ни управляющих символов.
[[nodiscard]] bool isValidAddress(const std::string &address);
// Адрес → часть имени файла (как SafeAddressPart клиента): буквы, цифры, `@`, `.`, `-` — как есть, прочее — `_`.
[[nodiscard]] std::string safePart(const std::string &address);
// Имена файлов и каталогов `<tdata>` с данными аккаунта без адреса в имени.
[[nodiscard]] const std::vector<std::string> &accountFileNames();
// `<tdata>/parvane-v2-<safe>/account-files`.
[[nodiscard]] std::string stashDir(const std::string &tdataDir, const std::string &safe);
// Адрес владельца файлов из маркера ("" — маркера нет либо не прочитан).
[[nodiscard]] std::string owner(const std::string &tdataDir);

struct AdoptResult {
    std::string previousOwner; // safe-часть прежнего владельца ("" — тот же либо не было)
    bool switched = false;     // файлы прежнего владельца унесены, свои — возвращены
    bool legacy = false;       // маркера не было — владелец определён по журналу истории
    int stashed = 0;           // унесено записей прежнего
    int restored = 0;          // возвращено записей входящего
    std::vector<std::string> failed; // не перенеслось (такие стёрты — чужим не достаются)
};
// Отдать файлы аккаунта `address` (вход, восстановление сессии при старте). Без ключа хранилища маркер не пишется,
// и файлы входящего не возвращаются (иначе следующий вход принял бы их за файлы прежнего владельца).
AdoptResult adopt(const std::string &tdataDir, const std::string &address);
// Смена ника (spec 026): маркер прежнего адреса переходит к новому (каталог parvane-v2-* переносит клиент).
void renameOwner(const std::string &tdataDir, const std::string &oldAddress, const std::string &newAddress);

} // namespace parvane::accountfiles
