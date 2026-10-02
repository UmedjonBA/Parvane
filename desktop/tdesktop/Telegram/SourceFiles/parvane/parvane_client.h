// Parvane fork: клиент Parvane внутри tdesktop. Владеет персистентным
// parvane::Transport+MessengerClient после логина, реестром пиров (address↔id)
// и зеркалит исходящие сообщения в шину (Фаза 3).
#pragma once

#include <optional>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "data/data_chat_participant_status.h" // ChatAdminRights (spec 004)

#include <rpl/producer.h>

class PeerData;
class ChatData;
class UserData;
class HistoryItem;
class DocumentData;
class QImage;
struct FilePrepareResult; // storage/localimageloader.h
struct TextWithEntities;   // ui/text/text_entity.h (форматирование)
struct PollData;           // data/data_poll.h (опросы)

namespace Data {
enum class DefaultNotify : uint8_t;
} // namespace Data

namespace Main {
class Session;
} // namespace Main

namespace parvane {
class ITransport;
} // namespace parvane

namespace Parvane {

// URL шины из PARVANE_NATS_URL (или дефолт). Реального соединения не открывает.
[[nodiscard]] QString NatsUrl();

// Снимок шины для воркеров (транспорт/self/JWT под g_sessionMutex). Транспорт
// не владеющий — как в fetchWebpage; nullptr, если сессии нет.
struct BusSnapshot {
	parvane::ITransport *transport = nullptr;
	std::string self;
	std::string token;
};
[[nodiscard]] BusSnapshot SnapshotBus();

// Текущая Main::Session форка (nullptr до входа); для проверок на main-потоке,
// что асинхронный результат относится к живой сессии.
[[nodiscard]] Main::Session *ActiveMainSession();

// Логирует факт линковки транспорта и целевой NATS-URL (ранний sanity-check).
void LogStartup();

// Публичные параметры сервера (identity.server.info): домен адресов (ник →
// ник@домен), режим подтверждения регистрации и бот Telegram.
struct ServerInfo {
	QString domain;
	QString confirm = u"none"_q; // none | email | telegram
	QString telegramBot;
};
// БЛОКИРУЮЩИЙ. При недоступности — домен по умолчанию "local", confirm none.
[[nodiscard]] ServerInfo FetchServerInfo();
// Голый ник → ник@домен (полный адрес возвращается как есть).
[[nodiscard]] QString CanonicalAddress(const QString &input, const QString &domain);

// Результат identity.token.issue.
struct IssueResult {
	bool ok = false;
	QString token;
	QString error;
	// Двухфакторный вход: пароль верен, нужен Start в привязанном Telegram по
	// deep link t.me/<bot>?start=<loginToken>; затем Issue с loginToken.
	bool twofaRequired = false;
	QString loginToken;
	QString telegramBot;
};

// БЛОКИРУЮЩИЙ запрос identity.token.issue. Звать с воркер-потока (crl::async).
[[nodiscard]] IssueResult Issue(
	const QString &user,
	const QString &password,
	const QString &loginToken = QString());

// Результат identity.user.register (регистрация отделена от логина, Фаза 0).
struct RegisterResult {
	bool ok = false;
	QString error;
	bool confirmRequired = false; // регистрация через почту: ждём код
	QString telegramToken;        // режим Telegram: токен deep link для бота
};

// Подтверждён ли pending-аккаунт / вход (identity.register.status, pre-auth).
[[nodiscard]] bool RegisterStatus(const QString &user, const QString &token);

// Двухфакторный вход (identity.user.twofa, JWT сессии). Блокирующие.
struct TwoFactorState {
	bool ok = false;
	bool enabled = false;
	bool telegramLinked = false;
	QString error;
};
[[nodiscard]] TwoFactorState FetchTwoFactor();
// P-07: выключение 2FA требует текущий пароль (сервер отклонит без него).
[[nodiscard]] TwoFactorState SetTwoFactor(bool enabled, const QString &password = QString());

// Протокол v2 (T079, FR-040): «сообщения от незнакомых» — нативный пункт
// Settings → Privacy → Messages. Настройка хранится на устройстве и уходит в
// identity.privacy.set при изменении и при готовности v2-сессии.
[[nodiscard]] bool StrangersPolicyAvailable(); // v2 включён
[[nodiscard]] bool StrangersAllowed();
void SetStrangersAllowed(bool allowed);

// Режим чата «усиленная приватность» (L2, T079; правило conformance L2-1):
// выравнивание размеров конвертов, без typing/presence, виден участникам.
// Личный чат — своё предпочтение (режим активен, пока включён хотя бы у
// одного участника); группа v2 — политика журнала (право как у изменения
// сведений). Состояние — из кэша события l2State v2-сессии (main).
struct ChatL2 {
	bool available = false; // пункт показывать (v2-собеседник / группа v2)
	bool active = false;    // режим чата активен
	bool mine = false;      // личный чат: включён мной; группа: = active
	bool canChange = false; // право менять (группа — canEditInformation)

	friend inline bool operator==(const ChatL2 &, const ChatL2 &) = default;
};
[[nodiscard]] ChatL2 ChatL2State(not_null<PeerData*> peer);
// Кэш изменился (или стало известно, что собеседник на v2) — перечитать.
[[nodiscard]] rpl::producer<> ChatL2Updates();
// Узнать (на воркере), на v2 ли собеседник; итог — через ChatL2Updates.
void RefreshChatL2(not_null<PeerData*> peer);
// Включить/выключить; done(ok) — на main. Служебное сообщение чата — само.
void SetChatL2(not_null<PeerData*> peer, bool enabled, Fn<void(bool ok)> done);

// E6 (T110): сервер отключил протокол v1 (кадр upgrade_required) — клиент
// показывает «обновите приложение» и не крутит переподключение.
[[nodiscard]] bool UpgradeRequired();

// БЛОКИРУЮЩИЙ запрос identity.user.register. Звать с воркер-потока.
[[nodiscard]] RegisterResult Register(
	const QString &user,
	const QString &password,
	const QString &email = QString());

struct ConfirmResult {
	bool ok = false;
	QString error;
};

// БЛОКИРУЮЩИЙ identity.email.confirm (код из письма). Звать с воркер-потока.
[[nodiscard]] ConfirmResult ConfirmEmail(const QString &user, const QString &code);

// Устройства аккаунта (Settings → Devices): identity.device.list / revoke.
struct DeviceEntry {
	QString deviceId;
	QString signingKey;
	qint64 updatedAt = 0;
	int oneTimeAvailable = 0;
	bool current = false;
};
void ListDevices(Fn<void(std::vector<DeviceEntry>)> done);
// P-07: отзыв устройства требует текущий пароль (сервер отклонит без него).
void RevokeDevice(const QString &deviceId, Fn<void(bool)> done, const QString &password = QString());

// Прочитавшие сообщение (msg.chat.readers) — для нативного «Seen by»/«read at».
struct ReaderEntry {
	QString address;
	qint64 userId = 0; // IdForAddress(address) — BareId пользователя
	qint64 date = 0;   // unix ts прочтения
};
void FetchReaders(qint64 msgId, Fn<void(std::vector<ReaderEntry>)> done);

// STUN/TURN из шарда call (эфемерные креды, кэш 0.8×TTL). Блокирующий.
struct IceServer {
	std::vector<std::string> urls;
	std::string username;
	std::string password;
};
[[nodiscard]] std::vector<IceServer> FetchIceServers();

void RenameGroup(const QString &groupId, const QString &name);
void DeleteGroup(const QString &groupId);

// Авто-линковка истории: код на новом устройстве (пусто — не ждём грант).
[[nodiscard]] QString HistoryLinkCode();

// JWT текущей сессии (хранится в процессе).
void SetToken(const QString &token);
[[nodiscard]] QString Token();

// ── identity/peer ────────────────────────────────────────────────────────────
// Детерминированный 48-бит UserId из адреса user@server (FNV-1a, ненулевой).
// Один и тот же адрес → один и тот же id между запусками. Используется и при
// синтезе self в intro, и в реестре пиров — поэтому единая точка.
[[nodiscard]] std::uint64_t IdForAddress(const QString &address);

// Запомнить адрес пира (заполняет обратный поиск id→address). Идемпотентно.
void RegisterPeer(const QString &address);

// Адрес по UserId (bare). "" если неизвестен.
[[nodiscard]] QString AddressForId(std::uint64_t userId);

// Ссылка-профиль Parvane для QR/шаринга: адрес `ник@домен` →
// `https://<домен>/#@<ник>` (открывается веб-клиентом, находит пользователя).
[[nodiscard]] QString ProfileLink(const QString &address);

// ── сессия ───────────────────────────────────────────────────────────────────
// Запомнить себя (адрес + JWT) после успешного логина.
void SetSelf(const QString &address, const QString &token);
[[nodiscard]] QString SelfAddress();

// Открыть/переиспользовать персистентное соединение с шиной (по SelfAddress/Token).
// Идемпотентно: если сессия уже активна — no-op, true. БЛОКИРУЮЩАЯ (connect),
// для нормального логина звать с воркер-потока; быстрый локальный connect.
bool StartSession();
[[nodiscard]] bool SessionActive();
void StopSession();

// Выход из аккаунта: гасит сессию и снимает учётные данные (адрес + JWT).
// Ключи E2E и историю НЕ трогает — повторный вход на том же устройстве
// возвращает переписку. Зовётся из Main::Account::logOut.
void ClearLocalState();

// Резервная копия ключей E2E в формате веб-клиента (файл годится для
// переноса между клиентами). Блокирующие — звать с воркера. error —
// человекочитаемая причина при false.
[[nodiscard]] bool ExportKeyBackup(const QString &path, const QString &password, QString *error);
[[nodiscard]] bool ImportKeyBackup(const QString &path, const QString &password, QString *error);
// Делалась ли копия на этом устройстве (маркер tdata/parvane-backup-done).
[[nodiscard]] bool KeyBackupDone();

// Профиль в identity (setname): bio / дата рождения (ISO YYYY-MM-DD, пусто —
// очистить) / телефон / индекс цвета имени. Меняются только присланные поля.
struct ProfileFields {
	std::optional<QString> bio;
	std::optional<QString> birthday;
	std::optional<QString> phone;
	std::optional<int> nameColor;
	std::optional<QString> personalChannel; // group_id; пустая строка = убрать
};
void SetProfileFields(const ProfileFields &fields);
// Личный канал: известные группы/каналы Parvane как ChatData (для выбора в
// настройках). Обратно group_id по чату — GroupIdForChat.
[[nodiscard]] std::vector<not_null<ChatData*>> KnownGroupChats(
	not_null<Main::Session*> session);

// Настройки уведомлений (мут/тихие/звук) — кросс-девайс через msg.chat.setnotify
// тем же блобом, что у веба: {defaults, exceptions}. Звать с main-потока после
// локального изменения (ApiWrap::updateNotifySettingsDelayed).
void MirrorNotifySettings(not_null<const PeerData*> peer);
void MirrorNotifyDefault(Data::DefaultNotify type);

// Зеркалит исходящее текстовое сообщение (с форматированием) в шину. Адрес
// получателя — из реестра по userId пира; если неизвестен/нет сессии — no-op.
// Неблокирующая: публикация уходит на воркер-поток.
void MirrorOutgoing(
	PeerData *peer,
	const TextWithEntities &text,
	std::int64_t replyToMsgId = 0);

// Зеркалит исходящее МЕДИА-сообщение (Фаза 4). Грузит байты файла в cloud-шард
// (CloudClient, чанками), затем публикует msg.chat.send с медиа-MessageContent
// (file_id + метаданные). Вызывается из Api::SendConfirmedFile — локальное
// отображение у отправителя делает штатный tdesktop, мы лишь дублируем в шину.
// Неблокирующая: upload+publish уходят на воркер-поток. Адрес пира — из реестра.
void MirrorOutgoingFile(
	not_null<Main::Session*> session,
	const std::shared_ptr<FilePrepareResult> &file);

// Привязывает локальный файл к СВОЕМУ (исходящему) медиа, чтобы отправитель
// видел фото inline / файл как скачанный. Нужно потому, что в форке штатный
// uploader пропущен (иначе вечная крутилка) и DocumentData/PhotoData остаются
// без локальных данных. Звать на main после создания локального сообщения.
void AttachLocalOutgoingMedia(
	not_null<Main::Session*> session,
	const std::shared_ptr<FilePrepareResult> &file);

// Зеркалит «печатает…» в шину (msg.typing.<id получателя>, fire-and-forget).
// Вызывается из SendProgressManager при вводе. Адрес пира — из реестра.
void MirrorTyping(PeerData *peer);

// Пересылает сообщение (текст или медиа) пиру toPeer через шину. Медиа —
// повторной ссылкой на уже загруженный в cloud блоб (без пере-загрузки).
void MirrorForward(PeerData *toPeer, not_null<HistoryItem*> item);

// Зеркалит реакцию на сообщение (msg.chat.react). emoji пустой — снять свою.
// Вызывается из HistoryItem::toggleReaction после локального обновления.
void MirrorReact(not_null<HistoryItem*> item, const QString &emoji);

// Зеркалит закрепление/открепление сообщения (msg.chat.pin).
void MirrorPin(not_null<HistoryItem*> item, bool pin);

// Русский по умолчанию при первом старте: если задан PARVANE_LANG_FILE и язык
// ещё не выбирался (маркер отсутствует), грузит кастомный русский языковой
// пакет. Дальше пользователь свободно меняет язык — не навязываем.
void EnsureDefaultLanguage();

// Удаление/очистка чата «для меня» (msg.chat.clear): все известные сообщения
// диалога скрываются на сервере для этого пользователя, локальный журнал
// переписывается без них. Зовётся из ApiWrap::deleteHistory до локальной очистки.
void MirrorClearHistory(not_null<PeerData*> peer);

// Удаляет СВОЁ сообщение «у всех» (msg.chat.delete). msgId — локальный
// синтетический id; uuid ищется в обратной карте. Чужое/неизвестное — no-op.
void MirrorDelete(std::int64_t msgId);

// Правит текст СВОЕГО сообщения (msg.chat.edit). Аналогично MirrorDelete.
void MirrorEdit(not_null<HistoryItem*> item, const TextWithEntities &text);

// Отмечает прочитанными непрочитанные входящие от пира (msg.chat.read → ✓✓ у
// отправителя). peerId — локальный id пира (bare). Вызывается из readInbox.
void MirrorRead(std::int64_t peerId);

// Синтезирует (идемпотентно) пира по адресу и возвращает его UserData — чтобы
// начать чат по адресу. Используется в поиске (PeerSearch) вместо MTProto.
[[nodiscard]] not_null<UserData*> EnsurePeer(
	not_null<Main::Session*> session,
	const QString &address);

// Ключи безопасности (паритет с вебом): свой отпечаток identity-ключа
// (SHA-256, 48 hex группами по 4) — показывается в Settings → Privacy;
// "" до готовности E2E.
[[nodiscard]] QString OwnFingerprint();

// Глобальный поиск по сообщениям (паритет с вебом): локально по всем
// сообщениям, восстановленным из журнала/sync (MTProto SearchGlobal нет).
// Подстрока без учёта регистра в тексте/подписи, свежие первыми, не более limit.
[[nodiscard]] std::vector<not_null<HistoryItem*>> SearchMessagesLocal(
	not_null<Main::Session*> session,
	const QString &query,
	int limit = 100);

// Ключ безопасности контакта сменился (новый identity у известного адреса):
// локальное служебное сообщение в его чате + обновление отпечатков в профиле.
// Только main-поток.
void AnnounceKeyChange(const QString &address);

// Поиск пользователей в каталоге identity (identity.user.search). Асинхронно:
// запрос на воркере, callback с найденными адресами — на main-потоке.
void SearchUsers(const QString &query, Fn<void(QStringList)> callback);

// Задаёт СВОЁ отображаемое имя (identity.user.setname) + кладёт в локальный кэш.
void SetDisplayName(const QString &name);

// Ставит СВОЙ аватар: грузит фото в cloud + identity.user.setavatar, показывает
// локально. selfPeer — свой UserData, image — выбранное фото.
void SetOwnAvatar(PeerData *selfPeer, const QImage &image);

// ── звонки (Фаза 4) ────────────────────────────────────────────────────────
// Инициировать звонок пиру (audio/video). Подтягивает pubkey собеседника
// (для проверки подписи) и публикует подписанный invite в шину.
void PlaceCall(const QString &peer, bool video);
// Принять текущий входящий звонок.
void AcceptCall();
// Завершить/отклонить текущий звонок.
void HangupCall();

// ── группы/каналы ────────────────────────────────────────────────────────────
// Тянет список групп пользователя и синтезирует их как чаты (появляются в
// списке диалогов). Звать после логина и при обновлениях.
void RefreshGroups();
// Создаёт группу (channel=false) или канал (channel=true) с участниками и
// синтезирует её локально.
void CreateGroup(const QString &name, const QStringList &members, bool channel);

// Админка групп: добавить/удалить участника, промоут/демоут (роль admin/member),
// выйти самому. groupId — адрес группы. Все зовут messenger (owner/admin проверка
// на бэкенде), потом RefreshGroups. Пустой ответ/нет прав — просто лог.
void AddMember(const QString &groupId, const QString &member);
void KickMember(const QString &groupId, const QString &member);
void SetMemberRole(const QString &groupId, const QString &member, bool admin);
void LeaveGroup(const QString &groupId);

// Адрес нашей группы по peer (Chat) — "" если это не наша группа. Для врезки
// нативного «выйти из группы» в меню.
[[nodiscard]] QString GroupIdForChat(not_null<PeerData*> peer);

// ── spec 004: экраны управления группой (нативные боксы tdesktop) ────────────
// Результат операции: ok и код ошибки сервера (forbidden|bad_request|limit|…)
// либо текст исключения. Вызывается на main-потоке после RefreshGroups.
using GroupOpDone = Fn<void(bool ok, const QString &error)>;
// Роль участника по кэшу сведений (owner|admin|member|banned), "" — неизвестно.
[[nodiscard]] QString GroupRoleOf(const QString &groupId, const QString &address);
// Нативные права админа участника (по гранулярному набору провода; legacy —
// полный). Для «Edit admin» как стартовые значения.
[[nodiscard]] ChatAdminRights GroupMemberAdminRights(const QString &groupId, const QString &address);
// Ожидающих заявок (0, если сведений нет или self не менеджер ссылок).
[[nodiscard]] int GroupPendingRequests(const QString &groupId);
// US1: описание (≤255) и фото группы через group.setinfo. Локально
// применяется по нотису/RefreshGroups; done — на main.
void SetGroupAbout(const QString &groupId, const QString &about, GroupOpDone done);
void SetGroupPhoto(const QString &groupId, const QImage &image, GroupOpDone done);
void ClearGroupPhoto(const QString &groupId, GroupOpDone done);
// US2: права участников по умолчанию (экран «Permissions») → group.setperms.
// rights — нативные запреты; инверсия в 8 разрешений провода внутри.
void SetGroupPerms(const QString &groupId, ChatRestrictions rights, GroupOpDone done);
// US3: гранулярные права админа (экран «Edit admin») → group.setadmin;
// demote=true (или пустой набор) — снять админа.
void SetGroupAdmin(const QString &groupId, const QString &member, ChatAdminRights rights, bool demote, GroupOpDone done);
// Адрес участника по его UserData (по маппингу id↔адрес); "" — неизвестен.
[[nodiscard]] QString AddressForUser(not_null<UserData*> user);

// ── модерация групп и инвайт-ссылки (P2) ─────────────────────────────────────
// Бан/разбан участника (owner/admin; бэкенд сам гейтит права).
void BanMember(const QString &groupId, const QString &member, bool ban);
// Мьют на minutes минут (0 — снять). owner/admin.
void MuteMember(const QString &groupId, const QString &member, int minutes);
// Перехват клика по ссылке группы (https://parvane.invite/<token>,
// …#+<token>): проверка group.invite.check → нативный ConfirmInviteBox →
// вступление. true — ссылка наша (обработана), false — не наша.
[[nodiscard]] bool JoinByInviteLink(const QString &url);

// ── US4/US5: инвайт-ссылки и заявки (spec 004) — данные для Api::InviteLinks ─
struct GroupInviteLink {
	QString token;
	QString createdBy; // адрес автора
	QString title;
	QString state; // active | revoked | expired | exhausted
	int date = 0;
	int expireDate = 0;
	int usageLimit = 0;
	int usage = 0;
	int requested = 0;
	bool requestApproval = false;
	bool permanent = false;
	bool revoked = false;
};
struct GroupInvitePreview {
	QString groupId;
	QString name;
	QString kind; // group | channel
	QString avatar;
	QString about;
	int members = 0;
	bool requestNeeded = false;
	bool alreadyMember = false;
	bool pending = false;
};
struct GroupJoinRequest {
	QString member;
	QString invite;
	int date = 0;
};
// Ссылка по токену — https://parvane.invite/<token> (web открывает её).
[[nodiscard]] QString GroupInviteUrl(const QString &token);
// Токен из ссылки любого формата (parvane.invite/<t>, …#+<t>, голый 32 hex); "" — не наша.
[[nodiscard]] QString GroupInviteToken(const QString &linkOrToken);
// Текст отказа по коду сервера (invalid|revoked|expired|exhausted|banned|declined).
[[nodiscard]] QString InviteErrorText(const QString &errorCode);
void ListGroupInvites(const QString &groupId, bool revoked,
	Fn<void(bool ok, std::vector<GroupInviteLink> links, const QString &error)> done);
void CreateGroupInvite(const QString &groupId, const QString &title, int expireDate,
	int usageLimit, bool requestApproval,
	Fn<void(bool ok, GroupInviteLink link, const QString &error)> done);
// Активные ссылки для экрана «Invite Links» (FR-040): как в web — если в списке
// сервера нет активной основной (is_primary = самая ранняя активная ссылка
// владельца без параметров), создаётся ссылка без параметров и список
// перечитывается; без права приглашать — просто список.
void ListGroupInvitesWithPrimary(const QString &groupId,
	Fn<void(bool ok, std::vector<GroupInviteLink> links, const QString &error)> done);
void RevokeGroupInvite(const QString &groupId, const QString &token, GroupOpDone done);
void DeleteGroupInvite(const QString &groupId, const QString &token, GroupOpDone done);
// Открытый объект cloud (фото группы, аватар) → картинка на main-потоке;
// пустая QImage при сбое. Для модалки «Join group» (FR-041: фото в превью).
void FetchPublicImage(const QString &fileId, Fn<void(QImage image, QByteArray bytes)> done);
void CheckGroupInvite(const QString &token,
	Fn<void(bool ok, GroupInvitePreview preview, const QString &error)> done);
void JoinGroupByInvite(const QString &token,
	Fn<void(bool ok, const QString &groupId, bool pending, const QString &error)> done);
void ListJoinRequests(const QString &groupId,
	Fn<void(bool ok, std::vector<GroupJoinRequest> requests, const QString &error)> done);
void DecideJoinRequest(const QString &groupId, const QString &member, bool approve, GroupOpDone done);
// UserData по адресу (синтез при отсутствии) и открытие чата группы.
[[nodiscard]] not_null<UserData*> EnsureUser(not_null<Main::Session*> session, const QString &address);
void OpenGroupChat(const QString &groupId);

// ── стикеры/GIF (паритет) ────────────────────────────────────────────────────
// Зеркалит отправку СУЩЕСТВУЮЩЕГО документа (стикер из панели / GIF из
// сохранённых): байты локального файла → cloud (E2E-блоб), content kind=
// sticker/gif. Прочие документы — no-op. Локальное эхо делает штатный
// SendExistingMedia. Вызывается из Api::SendExistingDocument.
void MirrorOutgoingSticker(PeerData *peer, DocumentData *document);

// Обмен стикер-паками «как в Telegram»: отправляемый стикер несёт pack_ref
// (весь набор один раз пакуется в cloud E2E-блобом); у получателя клик по
// стикеру предлагает установить набор.
// Есть ли у принятого стикера ссылка на пак (для клика в ленте).
[[nodiscard]] bool HasStickerPackRef(DocumentData *document);
// Показать конфирм-бокс и установить набор (скачать, распаковать, подхватить).
void InstallStickerPackFromDocument(DocumentData *document);

// ── опросы (паритет) ─────────────────────────────────────────────────────────
// Опрос едет ВНУТРИ E2E-контента (kind=poll), голоса — отдельными kind=poll_vote
// событиями; сервер их не видит, каждый клиент агрегирует сам. Все три —
// перехваты Api::Polls (create/sendVotes/close): true = обработано форком,
// MTProto звать не нужно; false = наш путь неприменим (нет сессии/не наш опрос).

// Создать опрос: шлёт poll-контент через шину и синтезирует локальное эхо.
bool MirrorPollCreate(PeerData *peer, const PollData &data);
// Геолокация через шину (E2E). true — обработано нашим пиром (MTProto
// не нужен); false — пир нераспознан. livePeriod > 0 — live-локация
// (uuidOut — id сообщения для последующих правок позиции).
[[nodiscard]] bool MirrorLocationIfOurs(
	PeerData *peer,
	double lat,
	double lon,
	int livePeriod = 0,
	std::string *uuidOut = nullptr);
// Обновление позиции live-локации: правка своего сообщения uuid (msg.chat.edit
// с kind=location, формат web publishLivePosition) + локальное применение к
// собственному пузырю. livePeriod = 0 — остановка трансляции.
void MirrorLiveLocationUpdate(
	PeerData *peer,
	const std::string &uuid,
	double lat,
	double lon,
	int livePeriod);

// Запланированные сообщения: очередь+таймер (нативная вкладка Scheduled в
// форке без MTProto не работает; сообщение уходит в назначенное время).
void ScheduleOutgoing(
	PeerData *peer,
	const TextWithEntities &text,
	std::int64_t replyToMsgId,
	qint64 dueAtUnix);
void RestoreScheduled();

// Проголосовать. options — байты выбранных вариантов ("0","1",…); пусто —
// отозвать голос. Локально применяется сразу, остальным уходит poll_vote.
bool MirrorPollVotes(std::uint64_t pollId, const std::vector<QByteArray> &options);

// Остановить опрос (только свой; UI сам гейтит по автору).
bool MirrorPollClose(std::uint64_t pollId);

// «Кто голосовал»: свой бокс результатов вместо нативной Info-секции
// (та ходит в MTProto). true — показано (наш опрос), false — не наш.
bool ShowPollResultsBox(PollData *poll);

// Пользователь задал таймер самоуничтожения (нативное меню Auto-Delete) — сохранить
// TTL чата у нас (peer->messagesTTL() уже выставлен вызывающим). Исходящие в этот
// чат получат ttl_secs → у получателя нативный ttl_period (авто-удаление).
void OnPeerTtlChanged(not_null<PeerData*> peer);

// Групповой звонок: инициировать mesh со всеми участниками группы groupId.
void StartGroupCall(const QString &groupId, bool video);
// Групповой звонок по чат-пиру (для кнопки звонка в шапке группы).
void StartGroupCallForChat(PeerData *chat, bool video);
// Выйти из текущего группового звонка.
void LeaveGroupCall();

// Вызывается в конце конструктора Main::Session. Запоминает сессию (weak),
// запускает первичный приём и debug-autosend (PARVANE_AUTOSEND=peer@server:текст).
void AfterSessionReady(not_null<Main::Session*> session);

// Один цикл приёма (Фаза 3c): sync с шины на воркере → инъекция НОВЫХ входящих
// сообщений в Data::Session активной сессии (на main). Дедуп по UUID. Безопасно
// звать с любого потока; если сессии нет — no-op. Триггерится onDelivered и при
// старте сессии.
void PumpReceive();

} // namespace Parvane
