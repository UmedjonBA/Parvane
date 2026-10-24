// Parvane fork: внутренний заголовок клиента Parvane (spec 029, T038) — общие #include, глобальное
// состояние и помощники, разделённые между parvane_client.cpp и файлами по темам
// (parvane_client_*.cpp). Снаружи каталога parvane/ не подключать: публичный API — parvane_client.h.
#pragma once

#include "parvane/parvane_client.h"

#include "base/debug_log.h"
#include "base/weak_ptr.h"
#include "base/timer.h"
#include "base/random.h" // секрет скачивания блоба (T131)
#include "main/main_session.h"
#include "main/main_account.h"       // forcedLogOut при отказе авторизации
#include "main/main_domain.h"         // локальный ключ tdesktop для storecrypt (P-13)
#include "storage/storage_account.h"  // peekLegacyLocalKey
#include "mtproto/mtproto_auth_key.h"
#include "parvane/keybackup.h"        // резервная копия ключей (формат веба)
#include "parvane/parvane_map.h"      // карта геолокации: сброс при StopSession
#include "data/data_session.h"
#include "data/data_user.h"
#include "data/data_document.h"
#include "data/data_photo.h"
#include "data/data_types.h"
#include "data/data_msg_id.h"      // IsClientMsgId
#include "data/data_peer_id.h"
#include "core/file_location.h"
#include "base/unixtime.h"
#include "history/history_item_edition.h"
#include "ui/image/image_location_factory.h" // Images::FromImageInMemory
#include "storage/storage_facade.h"
#include "storage/storage_shared_media.h"
#include "data/data_send_action.h"
#include "data/data_lastseen_status.h"
#include "data/data_changes.h"
#include "data/data_birthday.h"                  // профиль: дата рождения
#include "data/notify/data_notify_settings.h"   // уведомления кросс-девайс
#include "data/notify/data_peer_notify_settings.h"
#include "data/data_chat_filters.h" // папки (folders): персист + restore
#include "data/data_histories.h"
#include "base/call_delayed.h"
#include <QtCore/QQueue>
#include <QtCore/QThread>
#include <atomic>
#include <QtCore/QSet>
#include <QtCore/QBuffer>
#include <QtCore/QCryptographicHash>
#include "history/history.h"
#include "history/view/history_view_element.h"
#include "history/history_item.h"
#include "dialogs/dialogs_main_list.h"
#include "apiwrap.h"
#include "ui/text/text_entity.h"    // EntityInText/EntityType/EntitiesInText (форматирование)
#include "api/api_text_entities.h"  // Api::EntitiesToMTP

#include <QtNetwork/QNetworkRequest>
#include <QtCore/QRegularExpression>
#include <QtCore/QUrl>
#include "api/api_common.h"
#include "api/api_sending.h"          // Api::SendExistingDocument (autosticker)
#include "storage/localimageloader.h" // FilePrepareResult, SendMediaType

#include <parvane/group.h>           // parvane-core: сведения групп (внутренняя модель)
#include <parvane/messenger.h>       // parvane-core: сообщения (внутренняя модель)
#include <parvane/poll.h>            // parvane-core: опросы в обоих форматах (spec 005)
#include <parvane/v2_account.h>      // parvane-core: запросы аккаунта по v2 (вход, профили, устройства, привязка)
#include <parvane/v2_control.h>      // parvane-core: соединение управления v2 (JWT) — блобы, методы
#include <parvane/v2_link.h>         // parvane-core: V2Error (код отказа v2)
#include <parvane/v2_content.h>      // parvane-core: содержимое протокола v2 (spec 007)
#include <parvane/v2_engine.h>       // parvane-core: C ABI движка v2
#include <parvane/v2_session.h>      // parvane-core: v2-сессия (единственный путь переписки)

// P-45/P-46: dev/e2e-хуки из окружения (PARVANE_AUTO*, прямой NATS) существуют
// только в сборке с -DPARVANE_DEV=ON (см. parvane-core/CMakeLists.txt). В релизе
// функция всегда возвращает nullptr — переменные окружения не могут включить
// автологин/автоотправку/автогрант линковки.
// Ревью 21 окт 2026: и в dev-сборке — только при PARVANE_DEV_HOOKS=1 И gateway на loopback
// (ParvaneDevHooksEnabled, parvane_client_auth.cpp; решение — parvane-core dev_hooks.h). Иначе nullptr.
[[nodiscard]] bool ParvaneDevHooksEnabled();
inline const char *ParvaneDevEnv(const char *name) {
#ifdef PARVANE_DEV
	return ParvaneDevHooksEnabled() ? std::getenv(name) : nullptr;
#else
	(void)name;
	return nullptr;
#endif
}
#include <optional>
#include <parvane/linking.h>         // parvane-core (авто-линковка истории)
#include <QtCore/QUrl>
#include <QtCore/QDateTime>
#include <parvane/blobcrypt.h>       // parvane-core (E2E медиа, Фаза 3)
#include <parvane/pack_archive.h>    // parvane-core: отпечаток набора стикеров (PACK-2)
#include "parvane/parvane_sections_data.h"
#include "parvane/parvane_knowledge.h"
#include "parvane/parvane_note_markdown.h"
#include <parvane/sections/planner_engine.h>
#include <parvane/sections/task_offer.h>
#include <parvane/storecrypt.h>      // parvane-core (шифрование tdata/parvane-*, P-13)
#include <parvane/local_files.h>     // parvane-core (временный каталог, стирание при выходе, строки журнала)
#include "parvane/parvane_local_files.h" // временный каталог экземпляра, LogSecret
#include <parvane/ids.h>             // parvane-core (newUuidV7)
#include <parvane/keybundle.h>       // parvane-core: отпечаток снимка истории (spec 015)
#include <parvane/call_manager.h>    // parvane-core (оркестрация звонка)
#include <parvane/stub_media_backend.h> // parvane-core (медиа-заглушка Э4)
#include "parvane/parvane_webrtc_backend.h" // реальный webrtc-движок (Э3-b)
#include <parvane/crypto.h>          // parvane-core (Ed25519 подпись SDP)
#include <parvane/group_call_manager.h> // parvane-core (групповые звонки, mesh)
#include "data/data_chat.h"          // ChatData (синтез группы)
#include "data/data_chat_participant_status.h" // ChatRestriction/ChatAdminRight (spec 003)
#include "data/data_poll.h"          // PollData (опросы)
#include "data/data_media_types.h"   // Data::Media::poll()
#include "core/version.h"                 // отчёт об ошибке: версия
#include "storage/storage_media_prepare.h" // отчёт об ошибке: вложение JSON
#include "ui/chat/attach/attach_prepare.h"
#include "data/stickers/data_stickers.h"     // стикеры: локальные паки → панель
#include "data/stickers/data_stickers_set.h"
#include <QtCore/QFileInfo>
#include "parvane/parvane_call_panel.h" // нативный экран звонка (Open/Close)
#include "parvane/parvane_account_ui.h" // окна аккаунта: привязка устройства, ключ восстановления
#include "media/audio/media_audio_track.h" // рингтон звонка
#include "media/audio/media_audio.h"  // audioCountWaveform (реальная волна голосового)
#include "core/file_location.h"       // Core::FileLocation
#include "core/application.h"        // Core::App().settings().getSoundPath
#include "window/window_controller.h" // Parvane: тост rate_limited
#include "window/window_session_controller.h" // Parvane: открыть чат группы (spec 004)
#include "history/history_item_reply_markup.h" // кнопки карточек (spec 029)
#include "api/api_chat_invite.h" // Parvane: CheckChatInvite по ссылке группы (spec 004)
#include "api/api_invite_links.h" // Parvane: перечитать ссылки по нотису (spec 004)
#include "api/api_blocked_peers.h" // Parvane: блок-лист из журнала состояния (T132)
#include "data/data_folder.h" // Parvane: архив чатов (T132)
#include "dialogs/dialogs_key.h"
#include "lang/lang_instance.h"    // Parvane: русский по умолчанию
#include "core/core_settings.h"
#include "boxes/abstract_box.h"      // Ui::show() — бокс входящего звонка
#include "ui/boxes/confirm_box.h"    // Ui::MakeConfirmBox
#include "ui/layers/generic_box.h"   // Parvane: диалог ключа восстановления (T140)
#include "ui/widgets/labels.h"
#include "styles/style_layers.h"
#include "settings.h"                // cWorkingDir() — путь для ключа звонков

#include <QtCore/QFile>
#include <QtCore/QDir>
#include <QtCore/QDateTime>
#include <QtGui/QImage>
#include <QtGui/QGuiApplication>
#include <QtGui/QClipboard>

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>
#include <rpl/event_stream.h>
#include <rpl/lifetime.h>
#include <rpl/producer.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <map>
#include <memory>
#include <mutex>
#include <filesystem>              // миграция tdata/parvane-* (P-13)
#include <set>
#include <string>
#include <thread>
#include <chrono>
#include <cstring>
#include <vector>


namespace Parvane {

// ── типы и константы пространства Parvane, общие для файлов клиента ──
struct ScheduledItem {
	QString id;        // uuid будущего сообщения (для дедупа таймеров)
	QString address;   // получатель (адрес юзера/группы)
	QString text;
	nlohmann::json entities;
	std::optional<std::string> replyTo;
	qint64 dueAt = 0;  // unix-секунды
};

namespace Internal {

// ── типы и константы, общие для файлов клиента (прежде — анонимное пространство) ──
struct BlobDownload {
	bool ok = false;
	std::string bytes;
	std::string error; // при ok=false
};

struct PrivacyLocal {
	bool set = false;            // значение известно (с сервера или задано здесь)
	bool dirty = false;          // правка этого устройства ещё не на сервере
	bool dirtyCallsPresence = false; // то же для звонков/присутствия (T137)
	bool strangers = true;       // сообщения от незнакомых разрешены
	bool groupAddNobody = false; // «никто не может добавлять меня в группы»
	bool callsNobody = false;    // «никто не может мне звонить»
	bool presenceNobody = false; // «никто не видит, что я в сети»
};

// ── глобальное состояние (определено в parvane_client.cpp) ──
extern std::mutex g_sessionMutex;
extern QString g_token;
extern QString g_selfAddress;
extern std::shared_ptr<parvane::v2::Control> g_control;
// NAT-07: shared_ptr — поток, взявший менеджер под g_sessionMutex, держит его, даже если новый
// StartSession (смена ника, повторный вход) уже поставил другой.
extern std::shared_ptr<parvane::CallManager> g_callManager;
extern std::shared_ptr<parvane::GroupCallManager> g_groupCallManager;
extern QHash<QString, QString> g_knownGroups;
extern QHash<QString, QSet<quint64>> g_personalChannelUsers;
extern QHash<quint64, QString> g_chatIdToGroupId;
extern QHash<QString, QStringList> g_groupMembers;
extern base::weak_ptr<Main::Session> g_sessionWeak;
extern QHash<qint64, QString> g_msgIdToUuid;
extern QHash<QString, QString> g_displayNames;
extern QHash<QString, QString> g_notifyExceptions;
extern QHash<QString, QString> g_notifyDefaults;
extern QHash<QString, QString> g_avatarFileIds;
extern QSet<QString> g_avatarDownloaded;
extern QHash<QString, QImage> g_avatarImages;
extern QHash<QString, quint64> g_groupVersions;
extern QHash<QString, parvane::GroupInfo> g_groupInfo;
extern qint64 g_nextMsgId;
extern std::mutex g_l2Mutex;
extern QSet<QString> g_l2Chats;
extern QSet<QString> g_l2Mine;
extern std::atomic<bool> g_l2PresenceAllowed;
extern rpl::event_stream<> g_l2Updates;
extern QHash<QString, std::vector<std::pair<parvane::StoredMessage, bool>>> g_pendingGroupMsgs;
extern QSet<QString> g_clearedUuids;
extern QHash<QString, qint64> g_clearedUntilMs;
extern std::mutex g_v2Mutex;
extern std::shared_ptr<parvane::v2::Session> g_v2;
extern std::string g_v2Token;
extern QHash<QString, parvane::StoredMessage> g_v2Cache;
extern QHash<QString, QHash<QString, QString>> g_v2Reactions;
extern QHash<QString, GroupPublicInfo> g_groupPublic;
extern QHash<QString, GroupPublicInfo> g_publicPreviews;
extern QSet<QString> g_loadedPreviews;

// ── помощники (определены в файле своей темы) ──
void HistoryAppend(const parvane::StoredMessage &sm);
void sendInnerAsync(const QString &toAddress, const nlohmann::json &content, const std::string &preId);
[[nodiscard]] std::shared_ptr<parvane::v2::Control> ControlSnapshot();
void FlushPendingGroupMessages(const QString &gid);
void EnsureStoreKey();
[[nodiscard]] QByteArray StoreRead(const QString &path);
bool StoreWrite(const QString &path, const QByteArray &data);
[[nodiscard]] QStringList StoreReadLines(const QString &path);
// Кэш расшифрованных вложений (tdata/parvane-media-cache, зашифрован ключом хранилища)
[[nodiscard]] std::optional<std::string> ReadMediaCache(const QString &fileId);
void WriteMediaCache(const QString &fileId, const std::string &bytes);
[[nodiscard]] bool IsSafeFileId(const QString &fileId);
[[nodiscard]] QString HistoryPath();
void AppendCleared(const QStringList &uuids);
[[nodiscard]] bool IsCleared(const QString &uuid);
void ForgetClearedOnMain(not_null<Main::Session*> session, const QSet<QString> &uuids);
void SetPeerTtlLocal(const QString &address, int secs);
[[nodiscard]] QString V2StateDir(const QString &address);
[[nodiscard]] std::string OwnDeviceId();
[[nodiscard]] std::shared_ptr<parvane::v2::Session> V2Ready();
// maxBytes — потолок шифртекста (0 — общий 2 ГиБ ядра); для вложения чата —
// parvane::chatrules::chatBlobCipherCap(вид, size_bytes).
[[nodiscard]] BlobDownload DownloadChatBlob(
	const std::string &fileId,
	std::size_t maxBytes = 0);
void V2NoteRoot(const std::shared_ptr<parvane::v2::Session> &s, const std::string &user);
[[nodiscard]] std::shared_ptr<parvane::v2::Session> V2NeedsLinking();
[[nodiscard]] std::shared_ptr<parvane::v2::Session> V2AwaitNeedsLinking();
void LoadV2Ids();
void V2NoteMessage(const parvane::StoredMessage &sm, const QString &peer);
[[nodiscard]] bool IsV2Message(const std::string &uuid);
[[nodiscard]] PrivacyLocal LoadPrivacyLocal(const QString &self);
void SavePrivacyLocal(const QString &self, const PrivacyLocal &p);
void SaveL2Cache(const QString &self, const QSet<QString> &chats, const QSet<QString> &mine, bool presence);
[[nodiscard]] QString RecoveryKeyFromE2eFile();
std::string sendSealedDirect( const std::string &to, const parvane::json &content, const std::optional<std::string> &replyTo = std::nullopt, const std::optional<std::string> &preId = std::nullopt);
[[nodiscard]] QString CanonicalGroup(const QString &address);
[[nodiscard]] bool IsMigratedGroup(const QString &address);
bool NoteGroupMigrated(const QString &from, const QString &to);
void NoteAvatar(const QString &address, const QString &fileId);
[[nodiscard]] QString DisplayNameFor(const QString &address);
void applyAvatar(not_null<PeerData*> peer, const QString &address);
ChatData *ensureGroupChat( not_null<Main::Session*> session, const QString &rawGid, const QString &name, int memberCount);
[[nodiscard]] ChatRestrictions restrictionsFromPerms(const parvane::DefaultPermissions &p);
bool ApplyGroupInfo( not_null<Main::Session*> session, const parvane::GroupInfo &gi, const QString &source);
void DropGroupLocally(not_null<Main::Session*> session, const QString &gid, const QString &why);
not_null<UserData*> ensurePeerUser( not_null<Main::Session*> session, std::uint64_t id, const QString &rawAddress);
void ResolveNames(const QStringList &addresses);
[[nodiscard]] nlohmann::json entitiesToJson(const EntitiesInText &entities);
[[nodiscard]] EntitiesInText entitiesFromJson(const nlohmann::json &arr);
[[nodiscard]] int TtlFromContent(const parvane::json &c);
void DownloadAvatar(const QString &address, const QString &fileId);
void injectOnMain( not_null<Main::Session*> session, const std::vector<parvane::StoredMessage> &msgs, bool live);
void HandlePresencePayload(const std::string &payload);
void NoteV2GroupOrigin(not_null<Main::Session*> session, const QString &address, const parvane::json &g);
void MigrateGroupIfOwner(const parvane::GroupInfo &gi);
void LoadV2GroupCache(not_null<Main::Session*> session);
void NoteGroupPublic(const QString &address, const parvane::json &info);
void ApplyV2Group(const QString &address, const parvane::json &info, bool isNew);
[[nodiscard]] QString StateDomain();
[[nodiscard]] History *HistoryForAddress(not_null<Main::Session*> session, const QString &address);
[[nodiscard]] QString StateSyncedPath();
void NoteStateEdited(const char *kind);
void ApplyDialogState(not_null<Main::Session*> session);
void ApplyQuickReaction(not_null<Main::Session*> session);
void NoteArchive(not_null<History*> history, bool archived);
void NoteDialogPins(not_null<Main::Session*> session);
void NoteUnreadMark(not_null<History*> history, bool unread);
void NoteQuickReaction(const QString &emoji, std::uint64_t customId);
void ScheduleStateFlush(const char *kind);
void FireScheduledGated(const ScheduledItem &item);
bool HandleV2SessionEvent(const parvane::json &ev);
void PublishLinkingStatus();
void SyncFromKeyBundle();
void CompleteJoin(); // событие сессии `joined`: всё из копии ключей аккаунта, отзыв оффера (рабочий поток)
void RetractHistoryLinkOffer();
void StartTelegramRecovery(bool again);
[[nodiscard]] QString PublicNameError(const std::string &reason);
ChatData *AnnouncePublicCard(not_null<Main::Session*> session, const parvane::json &card);
[[nodiscard]] QString CurrentLinkCode();
[[nodiscard]] bool HeadlessUi();
[[nodiscard]] nlohmann::json CollectV2HistoryRows();
void ImportV2History(const std::string &stateJson);

} // namespace Internal
using namespace Internal;

// Ключи «Плана» и «Облака» (копия ключей аккаунта, экспорт привязки) — разделам и в файл (parvane_client.cpp)
void NoteDomainKeys(const std::string &planner, const std::string &cloud);

// Выход со стиранием (NAT-16): новый вход ждёт его конца и снимает ограду записи хранилища; false — выход ещё
// идёт (вход отложить). Звать не с главного потока (ждёт до 30 с).
[[nodiscard]] bool PrepareForLogin();
// При старте процесса, до хранилища и сессии: дотереть прерванный выход, стереть временный каталог экземпляра,
// прежний открытый кэш медиа и прежние общие $TMPDIR/parvane-*.
void StartupHousekeeping();

// ── то же в пространстве Parvane (прежде — объявления вперёд в parvane_client.cpp) ──
extern QSet<QString> g_blockedAddrs;
extern QSet<QString> g_archivedAddrs;
extern QStringList g_pinnedAddrs;
extern QSet<QString> g_unreadMarkAddrs;
extern QString g_quickEmoji;  // быстрая реакция: эмодзи
extern QString g_quickCustom; // либо id собственного эмодзи (десятичный); оба пусты — по умолчанию
extern std::vector<ScheduledItem> g_scheduled;
QString GatewayUrl();
[[nodiscard]] std::shared_ptr<parvane::v2::Control> MakeControl(const QString &token = QString());
void SaveBlockedState();
void SaveDialogState();
[[nodiscard]] QString NotifyJournaledPath();
void SaveSessionCreds(const QString &address, const QString &token);
bool RestoreSessionCreds();
void EnsurePresenceSubscription(const QString &address);
void OnAuthRejected(const QString &reason);
void handleTypingFrame(const std::string &payload);
std::optional<parvane::GroupInfo> GroupInfoFor(const QString &gid);
[[nodiscard]] QString findGroupIdByName(const QString &name);
[[nodiscard]] nlohmann::json V2SetInfo( const nlohmann::json &info, std::optional<std::string> name, std::optional<std::string> about, std::optional<std::string> avatar);
void AnnounceRename(const QString &from, const QString &to);
void MarkPeerDeleted(const QString &address, bool deleted);
void SaveScheduledLocked();
void FireScheduled(const ScheduledItem &item);
void ArmScheduledTimers();
bool RunV2GroupChange( const QString &tag, const QString &gid, std::function<parvane::json(const parvane::json &info)> change, GroupOpDone done);
void ApplyNotifyBlob(const QString &json);
void groupAdminAction(const QString &groupId, const QString &member, const QString &action);
void SaveFolders(not_null<Main::Session*> session);
void StartDeviceLinkOfferForV2();
void StartHistoryLinking();

// ── изоляция аккаунтов (ревью безопасности 21 окт 2026, вечер) ──
// Поколение аккаунта: растёт при каждом сбросе состояния аккаунта (выход, вход другим адресом). Отложенные задачи
// (таймеры отложенных, crl::on_main/call_delayed после сети) запоминают его при постановке и молча выходят, если
// аккаунт с тех пор сменился: иначе отложенное, черновик или ответ сети прежнего аккаунта доставались следующему.
[[nodiscard]] std::uint64_t AccountGeneration();
[[nodiscard]] bool AccountGenerationIs(std::uint64_t generation);
// Сброс всего состояния аккаунта в памяти (главный поток): кэши, очереди, отложенные, черновики, уведомления,
// группы, имена, аватары, журнал состояния, разделы. Поколение растёт. Файлы не трогает.
void ResetAccountState(const char *why);
// Файлы аккаунта без адреса в имени (tdata/parvane-*.json и т. п.) — этому адресу: прежнего владельца — в его
// каталог, свои — обратно (parvane::accountfiles::adopt). Главный поток, до чтения этих файлов.
void AdoptAccountFiles(const QString &address);
// Звонки при выходе: отбой личного, выход из группового (до остановки сессии v2), менеджеры сброшены.
void EndCallsForLogout();
// `tdata/<prefix><адрес>…<suffix>` с безопасной частью имени (SafeAddressPart); "" — адрес недопустим
// (parvane::accountfiles::isValidAddress). Файл прежних версий с сырым адресом в имени переименовывается.
[[nodiscard]] QString AccountFilePath(const QString &prefix, const QString &address, const QString &suffix);
// Части сброса в файлах своей темы.
void ResetStateAccountData();    // parvane_client_state.cpp: черновики, журнал состояния, кэш групп v2
void ResetGroupsAccountData();   // parvane_client_groups.cpp: превью публичных групп
void ResetLinkingAccountData();  // parvane_client_linking.cpp: офферы и ключи линковки
void ResetDevicesAccountData();  // parvane_client_devices.cpp: кэш STUN/TURN (выдан под JWT прежнего)

} // namespace Parvane
