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
// Содержимое в релизе заменяется отметкой (secret), даже в памяти. Dev-сборка — как раньше (verify_*.sh читают
// log.txt).
namespace parvane::logpriv {

void setDevBuild(bool dev);
[[nodiscard]] bool devBuild();
// Строка клиента (начинается с "Parvane")?
[[nodiscard]] bool isClientLine(const std::string &line);
// Писать ли строку на диск: строки клиента — только в dev-сборке или при явном режиме отладки.
[[nodiscard]] bool keepOnDisk(const std::string &line, bool debugMode);
// Значение, которому не место в журнале (текст, координаты, токен): в релизе — отметка с длиной.
[[nodiscard]] std::string secret(const std::string &value);

// Память последних строк клиента (кольцо).
inline constexpr std::size_t kRingCapacity = 500;
void remember(const std::string &line);
[[nodiscard]] std::vector<std::string> recent();
void forget();

} // namespace parvane::logpriv
