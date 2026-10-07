// Parvane fork: см. parvane_client.h.
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

#include <parvane/events.h>          // parvane-core
#include <parvane/poll.h>            // parvane-core: опросы в обоих форматах (spec 005)
#include <parvane/topics.h>          // parvane-core
#include <parvane/v2_bridge.h>       // parvane-core: мост «запросы клиента → методы v2» (T134)
#include <parvane/v2_content.h>      // parvane-core: содержимое протокола v2 (spec 007)
#include <parvane/v2_engine.h>       // parvane-core: C ABI движка v2
#include <parvane/v2_legacy.h>       // parvane-core: v1-устройства в переходный период v2
#include <parvane/v2_session.h>      // parvane-core: v2-сессия (двойной стек)

// P-45/P-46: dev/e2e-хуки из окружения (PARVANE_AUTO*, прямой NATS) существуют
// только в сборке с -DPARVANE_DEV=ON (см. parvane-core/CMakeLists.txt). В релизе
// функция всегда возвращает nullptr — переменные окружения не могут включить
// автологин/автоотправку/автогрант линковки.
[[maybe_unused]] static const char *ParvaneDevEnv(const char *name) {
#ifdef PARVANE_DEV
	return std::getenv(name);
#else
	(void)name;
	return nullptr;
#endif
}
#include <parvane/transport.h>       // parvane-core
#include <parvane/gateway_transport.h> // parvane-core (доступ через gateway, Фаза 0)
#include <parvane/gateway_ws_transport.h> // parvane-core (WebSocket/TLS — прод)
#include <parvane/e2e.h>             // parvane-core (E2E, Фаза 2)
#include <optional>
#include <parvane/linking.h>         // parvane-core (авто-линковка истории)
#include <QtCore/QUrl>
#include <QtCore/QDateTime>
#include <parvane/blobcrypt.h>       // parvane-core (E2E медиа, Фаза 3)
#include <parvane/storecrypt.h>      // parvane-core (шифрование tdata/parvane-*, P-13)
#include <parvane/messenger_client.h> // parvane-core
#include <parvane/cloud_client.h>    // parvane-core
#include <parvane/ids.h>             // parvane-core (newUuidV7)
#include <parvane/call_client.h>     // parvane-core (сигналинг звонков)
#include <parvane/call_manager.h>    // parvane-core (оркестрация звонка)
#include <parvane/stub_media_backend.h> // parvane-core (медиа-заглушка Э4)
#include "parvane/parvane_webrtc_backend.h" // реальный webrtc-движок (Э3-b)
#include <parvane/crypto.h>          // parvane-core (Ed25519 подпись SDP)
#include <parvane/group_client.h>    // parvane-core (группы/каналы)
#include <parvane/group_call_manager.h> // parvane-core (групповые звонки, mesh)
#include "data/data_chat.h"          // ChatData (синтез группы)
#include "data/data_chat_participant_status.h" // ChatRestriction/ChatAdminRight (spec 003)
#include "data/data_poll.h"          // PollData (опросы)
#include "data/data_media_types.h"   // Data::Media::poll()
#include "data/stickers/data_stickers.h"     // стикеры: локальные паки → панель
#include "data/stickers/data_stickers_set.h"
#include <QtCore/QFileInfo>
#include "parvane/parvane_call_panel.h" // нативный экран звонка (Open/Close)
#include "media/audio/media_audio_track.h" // рингтон звонка
#include "media/audio/media_audio.h"  // audioCountWaveform (реальная волна голосового)
#include "core/file_location.h"       // Core::FileLocation
#include "core/application.h"        // Core::App().settings().getSoundPath
#include "window/window_controller.h" // Parvane: тост rate_limited
#include "window/window_session_controller.h" // Parvane: открыть чат группы (spec 004)
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

// Объявления вперёд (определены ниже по файлу, вне анонимного пространства).
void DecCachePut(const QString &id, const QString &inner);
[[nodiscard]] QString DecCacheGet(const QString &id);
void DecCacheRemove(const QString &id);
[[nodiscard]] bool DecCacheEmpty();
[[nodiscard]] nlohmann::json DecCacheSnapshot();
void OnAuthRejected(const QString &reason); // fwd: отказ JWT → экран входа
void ApplyNotifyBlob(const QString &json);   // fwd: настройки уведомлений с другого устройства
void NoteReported(const std::vector<std::string> &ids);     // fwd (READ-1)
void NoteConfirmedRead(const std::vector<std::string> &ids); // fwd (READ-1, сервер уже знает)
void AppendReadJournal(const std::vector<std::string> &ids); // fwd (worker)
[[nodiscard]] QString GatewayUrl();                          // fwd: адрес gateway (v2-сессия)
void SaveFolders(not_null<Main::Session*> session);          // fwd: папки → tdata (журнал состояния v2)
// fwd: изменение группы v2 записью журнала (раздел «Протокол v2: группы…»).
bool RunV2GroupChange(
	const QString &tag,
	const QString &gid,
	std::function<nlohmann::json(const nlohmann::json &info)> change,
	GroupOpDone done);

namespace {

// Протокол v2 (определены ниже, раздел «Протокол v2»).
void LoadV2Ids();
void V2CacheReplayed(const std::vector<parvane::StoredMessage> &msgs);

// true — проход применил всё; false — что-то не расшифровалось (нет ключа,
// нет копии для устройства, E2E не поднялся). Дисковый курсор при false НЕ
// двигаем, иначе пропущенное после рестарта не придёт дельтой.
[[nodiscard]] bool prepareIncoming(
	std::vector<parvane::StoredMessage> &msgs,
	bool live,
	std::vector<std::string> *failed = nullptr);
not_null<UserData*> ensurePeerUser(
	not_null<Main::Session*> session,
	std::uint64_t id,
	const QString &address);
[[nodiscard]] std::int64_t docIdFromFileId(const QString &fileId);
// Кастом-эмодзи (определены ниже): pack_ref используемых эмодзи для отправки;
// материализация пришедших паков; поиск набора по docId.
[[nodiscard]] nlohmann::json BuildEmojiPacks(
	parvane::ITransport *t, const nlohmann::json &entities,
	const std::string &from, const std::string &token,
	const std::vector<std::string> &recipients);
void MaterializeEmojiPacks(
	not_null<Main::Session*> session, const nlohmann::json &content);
[[nodiscard]] std::string sendSealedDirect(
	parvane::MessengerClient *m,
	parvane::ITransport *t,
	const std::string &to,
	const parvane::json &content,
	const std::string &token,
	const std::optional<std::string> &replyTo = std::nullopt,
	const std::optional<std::string> &preId = std::nullopt);

// Состояние процесса. g_sessionMutex охраняет транспорт/мессенджер и реестр.
std::mutex g_sessionMutex;
QString g_token;
QString g_selfAddress;
// Транспорт: прямой NATS (dev) либо через gateway (PARVANE_GATEWAY_URL, Фаза 0).
std::unique_ptr<parvane::ITransport> g_transport;
std::unique_ptr<parvane::MessengerClient> g_messenger;
// Звонки (Фаза 4): сигналинг + оркестрация + ключ подписи SDP. Под g_sessionMutex.
std::unique_ptr<parvane::CallClient> g_callClient;
std::unique_ptr<parvane::CallManager> g_callManager;
std::unique_ptr<parvane::crypto::SigningKey> g_callKey;
// Кэш публичных ключей пиров (адрес → base64) для проверки подписи invite/answer.
// Читается из потока cnats (peerPubkey-колбэк) → отдельный мьютекс.
std::mutex g_pubkeyMutex;
QHash<QString, QString> g_peerPubkeys;
QHash<quint64, QString> g_idToAddress;
// Группы/каналы: клиент + реестр. g_knownGroups: gid → имя (для роутинга
// входящих и синтеза чата). g_chatIdToGroupId: chatId(FNV) → gid (для роутинга
// исходящих из чат-пира). Под g_sessionMutex.
std::unique_ptr<parvane::GroupClient> g_groupClient;
std::unique_ptr<parvane::GroupCallManager> g_groupCallManager;
QHash<QString, QString> g_knownGroups;
QHash<QString, QSet<quint64>> g_personalChannelUsers; // group_id → user id, чей личный канал ещё не синтезирован
QHash<quint64, QString> g_chatIdToGroupId;
// Участники групп (адреса) — для инициации группового звонка. Под g_sessionMutex.
QHash<QString, QStringList> g_groupMembers;
// TTL самоуничтожения по адресу собеседника/группы (сек, 0 — выкл). Под g_sessionMutex.
QHash<QString, int> g_peerTtl;
// Текущий собеседник по звонку (для панели активного звонка). Под g_sessionMutex.
// НЕ читать через g_callManager->peer() из onState — там уже держится мьютекс
// менеджера (дедлок). Пишем при placeCall/incoming, читаем в onState.
QString g_currentCallPeer;
// Текущий звонок — видео? (для размера/self-preview окна). Под g_sessionMutex.
bool g_currentCallVideo = false;
// UUID сообщений, которые ОТПРАВИЛИ мы сами в этой сессии — чтобы на sync НЕ
// задваивать (у них уже есть локальное эхо). Свои сообщения ВНЕ этого набора
// (из прошлой сессии) восстанавливаем как исходящие. Под g_sessionMutex.
std::set<std::string> g_ownSentUuids;
// Кэш расшифрованного E2E-контента (uuid → inner JSON), персистится на диск.
// Чтобы на РЕСТАРТЕ/пере-синке НЕ гонять уже виденное сообщение через Olm-ratchet
// повторно (второй раз ratchet не расшифрует → «НЕ расшифровано» + порча). Под
// g_sessionMutex.
QHash<QString, QString> g_decCache;

// Общие медиа диалога по типу (msgId'ы) для панели профиля. Без живого MTProto
// messages.getSearchCounters не отвечает → счётчики/галереи пусты; заполняем
// сами полным срезом с известным count. Только main-поток.
std::map<PeerId, std::array<std::vector<MsgId>, Storage::kSharedMediaTypeCount>>
	g_sharedMedia;

// Состояние приёма (Фаза 3c) — трогается ТОЛЬКО на main-потоке (инъекция и
// AfterSessionReady идут через crl::on_main), поэтому без мьютекса.
base::weak_ptr<Main::Session> g_sessionWeak;
QHash<QString, qint64> g_uuidToMsgId; // UUID сообщения → синтетический MsgId
QHash<qint64, QString> g_msgIdToUuid; // обратная карта (для delete/edit/read своих)
QQueue<QString> g_pendingOwnUuids;    // uuid'ы своих ТЕКСТ-отправок, ждут эха (main)
QHash<qint64, QVector<QString>> g_unreadIncoming; // peerId → uuid'ы непрочит. входящих
QHash<QString, QString> g_displayNames; // адрес → отображаемое имя (из каталога)
// Когда последний раз спрашивали каталог о профиле адреса (мс от старта).
// Раньше здесь было QSet «уже спрашивали», из-за чего профиль резолвился РОВНО
// один раз за сессию и только при неизвестном имени: аватар или имя, менявшиеся
// на другом устройстве, десктоп не видел до перезапуска. Веб перезапрашивает
// профили на каждом проходе синка — выравниваемся по нему, но с TTL, чтобы не
// дёргать identity на каждое сообщение.
QHash<QString, qint64> g_resolvedAt;
constexpr qint64 kProfileTtlMs = 10 * 60 * 1000;
// READ-1 (conformance): прочитанное ЭТИМ устройством. Журнал на диске
// (переживает рестарт — бейдж не возвращается), очередь неподтверждённых
// (msg.chat.read уходит без ответа — повторяем, пока сервер не вернёт
// read=true / ReadNotice) и счётчик попыток. Под g_sessionMutex.
QSet<QString> g_reportedRead;
QSet<QString> g_unconfirmedRead;
QHash<QString, int> g_readRetries;
constexpr int kReadRetryMax = 3;
constexpr int kReadRetryPerPass = 50;
// Уведомления (кросс-девайс): наш снимок блоба веба {defaults, exceptions}.
// Только main-поток.
QHash<QString, QString> g_notifyExceptions; // адрес → JSON настроек
QHash<QString, QString> g_notifyDefaults;   // users|groups|channels → JSON
bool g_applyingNotify = false;              // применяем чужое — не зеркалим назад
QHash<QString, QString> g_avatarFileIds; // адрес → file_id аватара (cloud)
QSet<QString> g_avatarDownloaded;        // аватары, уже скачанные/в процессе
QHash<QString, QImage> g_avatarImages;   // адрес → скачанная картинка (кэш для
                                         // повторной установки: ensurePeerUser с
                                         // пустым фото стирает userpic).
QHash<qint64, QString> g_mediaContentByMsgId; // msgId → content JSON (для forward)
// spec 003 / GROUP-1: ревизия сведений группы — нотис или список, догнавший
// более свежие сведения, не откатывает их. Только main-поток.
QHash<QString, quint64> g_groupVersions; // gid → version
// spec 004: полные сведения группы (роли и права участников, права по
// умолчанию, заявки) — для нативных экранов управления и приёмного фильтра
// GROUP-2. Заполняется только в ApplyGroupInfo. Только main-поток.
QHash<QString, parvane::GroupInfo> g_groupInfo;
bool ApplyGroupInfo(not_null<Main::Session*> session, const parvane::GroupInfo &gi, const QString &source); // fwd
void DropGroupLocally(not_null<Main::Session*> session, const QString &gid, const QString &why); // fwd
void MigrateGroupIfOwner(const parvane::GroupInfo &gi); // fwd: перевод группы v1 в v2 (T180)
void NoteV2GroupOrigin(not_null<Main::Session*> session, const QString &address, const parvane::json &g); // fwd
// ── обмен стикер-паками ──────────────────────────────────────────────────────
// Отправляемый стикер из локального пака несёт pack_ref = {file_id архива в
// cloud, name, count, key, nonce}; архив грузится ОДИН раз за сессию на пак.
struct PackDirInfo {
	QString dir;   // абсолютный путь локального пака
	QString name;  // имя (заголовок набора)
	int count = 0;
};
QHash<quint64, PackDirInfo> g_stickerPackDirs; // setId → пак (main)
QHash<qint64, QString> g_packRefByDocId;       // docId → pack_ref JSON (main)
// conformance PACK-1: ссылка на архив пака выдаётся ПОД НАБОР ПОЛУЧАТЕЛЕЙ
// (в cloud доступ к файлу получают только они) — переиспользуем ссылку, только
// если новый набор входит в тот, под который архив загружен.
struct UploadedPackRef {
	QSet<QString> recipients;
	QString ref;
};
QHash<quint64, QVector<UploadedPackRef>> g_packRefUploaded; // setId → ссылки (g_sessionMutex)
constexpr auto kPackRefVariantsLimit = 16;

[[nodiscard]] QSet<QString> RecipientsSet(
		const std::vector<std::string> &recipients) {
	auto out = QSet<QString>();
	for (const auto &address : recipients) {
		out.insert(QString::fromStdString(address));
	}
	return out;
}

// Вызывать под g_sessionMutex
[[nodiscard]] QString FindUploadedPackRef(
		quint64 setId,
		const QSet<QString> &recipients) {
	for (const auto &entry : g_packRefUploaded.value(setId)) {
		// новый набор ⊆ того, под который загружен архив
		if ((recipients - entry.recipients).isEmpty()) {
			return entry.ref;
		}
	}
	return QString();
}

// Вызывать под g_sessionMutex
void RememberUploadedPackRef(
		quint64 setId,
		const QSet<QString> &recipients,
		const QString &ref) {
	auto &variants = g_packRefUploaded[setId];
	variants.push_back(UploadedPackRef{ recipients, ref });
	while (variants.size() > kPackRefVariantsLimit) {
		variants.removeFirst();
	}
}
QSet<QString> g_packInstallBusy;               // file_id идущих установок (main)
// Кастом-эмодзи: docId детерминирован от (имя пака|файл) → резолвится у
// получателя после материализации того же пака. g_emojiDocToSet — для поиска
// набора по docId при отправке (какой pack_ref приложить к тексту).
QHash<qint64, quint64> g_emojiDocToSet;        // docId эмодзи → setId (main)
QHash<quint64, PackDirInfo> g_emojiPackDirs;   // setId → локальный пак (main)
QSet<QString> g_emojiPackMaterialized;         // имена уже материализованных паков (main)
// ── опросы (паритет) — только main-поток ─────────────────────────────────────
// Опрос = обычное сообщение с E2E-контентом kind=poll (uuid сообщения и есть
// идентификатор опроса). Голоса/закрытие — отдельные kind=poll_vote/poll_close
// события; сервер их не видит и не считает — агрегирует каждый клиент сам.
// Журнал истории + дедуп по uuid восстанавливают агрегат после рестарта.
struct PollState {
	QString uuid;              // uuid сообщения-опроса
	std::uint64_t pollId = 0;  // FNV от uuid — PollId для Data::Session
	QString chatAddress;       // адрес диалога (пир или группа)
	int answers = 0;           // число вариантов
	bool quiz = false;
	QString solution;          // пояснение (quiz)
	QVector<int> correct;      // индексы правильных (quiz)
	bool closed = false;
	bool publicVoters = false; // публичный опрос — можно показывать голосовавших
	QHash<QString, QVector<int>> votes; // голосовавший → индексы вариантов
};
QHash<QString, PollState> g_pollsByUuid;   // uuid опроса → состояние
QHash<quint64, QString> g_pollUuidById;    // PollId → uuid опроса
// Голоса/закрытия, пришедшие РАНЬШЕ самого опроса (сортировка не гарантирована).
QHash<QString, QVector<QPair<QString, QVector<int>>>> g_pendingPollVotes;
QSet<QString> g_pendingPollClose;
qint64 g_nextMsgId = 1;               // серверный диапазон (0 < id < 2^56)
std::unique_ptr<base::Timer> g_pumpTimer; // периодический sync (main-поток)
rpl::lifetime g_finalizeLifetime;         // подписка newItemAdded (main-поток)
bool g_finalizeHooked = false;
bool g_typingSubscribed = false;          // подписка на msg.typing.<self> (once)
QSet<quint64> g_typingGroupSubs;          // id групп, на typing которых подписаны
bool g_foldersSubscribed = false;         // подписка на изменения папок (once)
rpl::lifetime g_foldersLifetime;          // время жизни подписки на папки
FullMsgId g_lastOwnFullId;                 // последнее своё исходящее (debug-хуки)
QString g_lastOwnUuid;                     // его uuid — переживает сброс сессии
QString g_firstOwnUuid;                    // первое своё за процесс (хуки: headless шлёт autosend при каждой пересборке сессии)
bool g_presenceSubscribed = false;        // presence: хартбит + подписки по пирам (once)
// P-18: presence — только конкретных собеседников (presence.<id>), не presence.*
QSet<quint64> g_presenceSubscribedIds;      // под g_sessionMutex
std::unique_ptr<base::Timer> g_presenceTimer; // хартбит присутствия (main)

// Режим «усиленная приватность» (L2, T079; правило L2-1): кэш из события
// l2State v2-сессии. typing/presence решаются по нему без вызова сессии — её
// методы ждут мьютекс движка, занятый на время сетевых операций.
std::mutex g_l2Mutex;
QSet<QString> g_l2Chats;   // чаты с активным режимом (собеседник или v2g:<hex>)
QSet<QString> g_l2Mine;    // личные чаты, где режим включён мной
QSet<QString> g_l2V2Peers; // собеседники на v2 (пункт в профиле показывается им)
std::atomic<bool> g_l2PresenceAllowed{ true };
// FR-040 (T137): «звонки — никто» и «не показывать, что я в сети». Соблюдает
// клиент владельца; значения — из tdata/parvane-privacy.json (SavePrivacyLocal).
std::atomic<bool> g_privacyCallsNobody{ false };
std::atomic<bool> g_privacyPresenceHidden{ false };
rpl::event_stream<> g_l2Updates; // main: кэш изменился

[[nodiscard]] bool L2Active(const QString &chat) {
	std::lock_guard<std::mutex> lk(g_l2Mutex);
	return g_l2Chats.contains(chat);
}

// Переход на протокол v2 (E6, T110): кадры gateway upgrade_available /
// upgrade_required на v1-транспорте.
std::atomic<qint64> g_upgradeRequiredAtMs{ 0 };
std::atomic<bool> g_upgradeAvailablePending{ false };

// Курсоры инкрементального синка (Фаза 1): двигаются ТОЛЬКО по результатам
// sync (не по push — иначе можно перескочить невиденное). Оба обязательны:
// id ловит новые сообщения, updated_at — мутации старых (правки/read/реакции).
// Доступ под g_sessionMutex; персист — в tdata/parvane-cursors.txt.
std::string g_lastSeenId;
std::int64_t g_sinceUpdated = 0;
// Вход через экран логина (SetSelf), а не рестарт: первый sync идёт с
// since_updated=0 — сервер отдаёт ВСЕ мутации и все мои read-receipts, иначе
// после повторного входа прочитанное до дискового курсора (на другом
// устройстве или на этом до READ-1) снова светится непрочитанным (10 сен 2026).
bool g_freshLogin = false;

constexpr auto kPumpIntervalMs = crl::time(3000);

// Публикует текст в шину с воркер-потока (не блокирует UI).
// EntitiesInText → JSON (определена ниже) — нужна в MirrorOutgoing выше по коду.
[[nodiscard]] nlohmann::json entitiesToJson(const EntitiesInText &entities);

// Инъекция сообщений в Data::Session (определена ниже) — нужна onInbox-push'у
// из StartSession (Фаза 1: прямое применение без sync-round-trip). `live=false` —
// воспроизведение локальной истории при старте (без ack и без пере-записи в журнал).
void injectOnMain(
	not_null<Main::Session*> session,
	const std::vector<parvane::StoredMessage> &msgs,
	bool live = true);

// Сообщения групп, о которых устройство ещё не знает (только главный поток).
// Первое сообщение в только что созданную группу обгоняет опрос списка групп
// (раз в 9 с) — без ожидания оно уходило в личный чат с автором (T139, 3 окт 2026).
QHash<QString, std::vector<std::pair<parvane::StoredMessage, bool>>> g_pendingGroupMsgs;
// Потолок — с запасом: при старте журнал истории воспроизводится раньше, чем
// приходит список групп, и через очередь проходит вся история группы.
constexpr auto kPendingGroupMsgsMax = std::size_t(100000);

void DeferUnknownGroupMessage(
		const QString &gid,
		const parvane::StoredMessage &sm,
		bool live) {
	auto &queue = g_pendingGroupMsgs[gid];
	if (queue.size() >= kPendingGroupMsgsMax) {
		return;
	}
	const auto first = queue.empty();
	queue.emplace_back(sm, live);
	LOG(("Parvane: групповое %1 для неизвестной группы %2 — ждёт синхронизации групп")
		.arg(QString::fromStdString(sm.id), gid));
	if (first) {
		RefreshGroups();
	}
}

// Группа стала известна (ensureGroupChat) — отдать её отложенные сообщения.
void FlushPendingGroupMessages(const QString &gid) {
	const auto it = g_pendingGroupMsgs.find(gid);
	if (it == g_pendingGroupMsgs.end()) {
		return;
	}
	auto pending = std::move(it.value());
	g_pendingGroupMsgs.erase(it);
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	auto live = std::vector<parvane::StoredMessage>();
	auto replay = std::vector<parvane::StoredMessage>();
	for (auto &[sm, isLive] : pending) {
		(isLive ? live : replay).push_back(std::move(sm));
	}
	LOG(("Parvane: группа %1 появилась — отложенных сообщений %2")
		.arg(gid).arg(int(live.size() + replay.size())));
	if (!replay.empty()) {
		injectOnMain(session, replay, /*live=*/false);
	}
	if (!live.empty()) {
		injectOnMain(session, live, /*live=*/true);
	}
}

// ── Превью ссылок: отправитель тянет OG-метаданные первой ссылки и кладёт их в
// content.webpage (получатель рендерит без похода во внешний URL). ────────────
[[nodiscard]] QString firstUrlInText(const QString &text) {
	static const auto re = QRegularExpression(
		u"https?://[^\\s<>\"]+"_q, QRegularExpression::CaseInsensitiveOption);
	auto m = re.match(text);
	if (!m.hasMatch()) {
		return QString();
	}
	auto url = m.captured(0);
	while (!url.isEmpty()
			&& QString(u".,;:!?)]}'\"»"_q).contains(url.back())) {
		url.chop(1); // хвостовая пунктуация не часть URL
	}
	return url;
}

// @упоминания: находит @user@server в тексте → mention-entities (offset/length в
// UTF-16, как EntitiesInText). Возвращает json-массив для content.entities.
[[nodiscard]] nlohmann::json detectMentions(const QString &text) {
	static const auto re = QRegularExpression(
		u"@[A-Za-z0-9_.+-]+@[A-Za-z0-9_.-]+"_q);
	auto arr = nlohmann::json::array();
	auto it = re.globalMatch(text);
	while (it.hasNext()) {
		const auto m = it.next();
		nlohmann::json o;
		o["type"] = "mention";
		o["offset"] = int(m.capturedStart());
		o["length"] = int(m.capturedLength());
		arr.push_back(std::move(o));
	}
	return arr;
}

// Упомянут ли `self` (для нативного флага f_mentioned → бейдж «вас упомянули»).
[[nodiscard]] bool MentionsSelf(
		const QString &text,
		const nlohmann::json &entities,
		const QString &self) {
	if (self.isEmpty() || !entities.is_array()) {
		return false;
	}
	const auto needle = u"@"_q + self;
	for (const auto &o : entities) {
		if (!o.is_object() || o.value("type", std::string()) != "mention") {
			continue;
		}
		const auto off = o.value("offset", 0);
		const auto len = o.value("length", 0);
		if (off >= 0 && len > 0 && off + len <= int(text.size())
				&& text.mid(off, len) == needle) {
			return true;
		}
	}
	return false;
}


void fetchWebpage(const QString &url, Fn<void(nlohmann::json)> done) {
	// Превью тянет шард preview (SSRF-безопасно, IP клиента не светится
	// целевому сайту) — паритет с web media.ts. Шард недоступен/таймаут →
	// деградация до {url, site_name=host} (как у web).
	const auto urlStd = url.toStdString();
	crl::async([=] {
		parvane::ITransport *t = nullptr;
		std::string self, token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			self = g_selfAddress.toStdString();
			token = g_token.toStdString();
		}
		auto result = nlohmann::json();
		if (t) {
			try {
				const auto ev = parvane::makeEvent(parvane::newUuidV7(), self,
					parvane::nowUnix(), token, nlohmann::json{{"url", urlStd}});
				const auto raw = t->request(parvane::topics::PreviewLinkFetch,
					ev.dump(), 4000);
				const auto resp = nlohmann::json::parse(raw, nullptr, false);
				if (resp.is_object() && resp.value("ok", false)
					&& resp.contains("webpage") && resp["webpage"].is_object()) {
					result = resp["webpage"];
				}
			} catch (const std::exception &) {
			}
		}
		if (!result.is_object()) {
			result = {{"url", urlStd}, {"site_name", QUrl(url).host().toStdString()}};
		}
		crl::on_main([done, result] { done(result); });
	});
}

// ── Шифрование tdata/parvane-* (P-13) ─────────────────────────────────────────
// Ключ хранилища — производная от локального ключа tdesktop (тот лежит под
// паскодом): SHA-256("parvane-store-v1" || AuthKey). Все файлы parvane-*
// (JWT, секрет доверия, кэш расшифровки, журнал истории, курсоры, ключ
// звонков, Olm-стор ядра) пишутся шифртекстом; plain прежних версий читается
// и перешифровывается при первом доступе. Без ключа (домен ещё не стартовал)
// хелперы работают как раньше — plain, и миграция догоняет позже.
std::once_flag g_storeMigrated;

void EnsureStoreKey() {
	if (parvane::storecrypt::enabled()) {
		return;
	}
	if (!Core::App().domain().started()) {
		return;
	}
	const auto key = Core::App().domain().active().local().peekLegacyLocalKey();
	if (!key) {
		return;
	}
	const auto &data = key->data();
	parvane::storecrypt::setKey(parvane::storecrypt::deriveKey(
		std::string(reinterpret_cast<const char *>(data.data()), data.size())));
	std::call_once(g_storeMigrated, [] {
		const auto dir = (cWorkingDir() + u"tdata"_q).toStdString();
		auto migrated = 0;
		std::error_code ec;
		for (const auto &entry : std::filesystem::directory_iterator(dir, ec)) {
			const auto name = entry.path().filename().string();
			if (name.rfind("parvane-", 0) != 0) {
				continue;
			}
			if (entry.is_regular_file(ec)) {
				migrated += parvane::storecrypt::migrateFile(entry.path().string());
			} else if (entry.is_directory(ec)) {
				migrated += parvane::storecrypt::migrateDir(entry.path().string());
			}
		}
		if (migrated) {
			LOG(("Parvane: хранилище — перешифровано %1 файлов tdata/parvane-*").arg(migrated));
		}
	});
}

[[nodiscard]] QByteArray StoreRead(const QString &path) {
	EnsureStoreKey();
	return QByteArray::fromStdString(parvane::storecrypt::readFile(path.toStdString()));
}

bool StoreWrite(const QString &path, const QByteArray &data) {
	EnsureStoreKey();
	return parvane::storecrypt::writeFile(path.toStdString(), data.toStdString());
}

[[nodiscard]] QStringList StoreReadLines(const QString &path) {
	EnsureStoreKey();
	auto out = QStringList();
	for (const auto &line : parvane::storecrypt::readLines(path.toStdString())) {
		const auto trimmed = QString::fromStdString(line).trimmed();
		if (!trimmed.isEmpty()) {
			out.push_back(trimmed);
		}
	}
	return out;
}

bool StoreAppendLine(const QString &path, const QString &line) {
	EnsureStoreKey();
	return parvane::storecrypt::appendLine(path.toStdString(), line.toStdString());
}

bool StoreWriteLines(const QString &path, const QStringList &lines) {
	EnsureStoreKey();
	auto raw = std::vector<std::string>();
	raw.reserve(lines.size());
	for (const auto &line : lines) {
		raw.push_back(line.toStdString());
	}
	return parvane::storecrypt::writeLines(path.toStdString(), raw);
}

// ── локальный журнал истории (Фаза 2 доводка) ────────────────────────────────
// Свои исходящие sealed на сервер как «свои» не попадают (from_user=''), а входящие
// инкрементальный курсор при рестарте не пере-запрашивает → история терялась.
// Пишем каждое ПОКАЗАННОЕ сообщение (своё при отправке, принятое в injectOnMain) в
// РАСШИФРОВАННОМ виде в per-self journal и воспроизводим при старте. Переживает
// и рестарт, и релогин (файл наш, не чистится логаутом tdesktop).
// NAT-02/NAT-05: расшифрованные медиа — в tdata (не в общем /tmp, где файлы
// читались всеми и жили вечно), каталог 0700, файлы 0600; имя и id файла из
// сообщения — только безопасные символы (иначе `../` писал в домашний каталог).
[[nodiscard]] QString MediaDir() {
	const auto dir = cWorkingDir() + u"tdata/parvane-media"_q;
	QDir().mkpath(dir);
	QFile::setPermissions(dir, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
	return dir;
}

[[nodiscard]] bool IsSafeFileId(const QString &fileId) {
	static const auto re = QRegularExpression(u"^[A-Za-z0-9_-]{1,64}$"_q);
	return re.match(fileId).hasMatch();
}

[[nodiscard]] QString SafeFileName(const QString &name) {
	auto base = QFileInfo(name).fileName();
	static const auto bad = QRegularExpression(u"[\\\\/:*?\"<>|\\x00-\\x1f]"_q);
	base.remove(bad);
	while (base.startsWith('.')) {
		base.remove(0, 1);
	}
	base = base.left(128).trimmed();
	return base.isEmpty() ? u"file"_q : base;
}

void RestrictToOwner(const QString &path) {
	QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
}

[[nodiscard]] QString HistoryPath() {
	auto self = SelfAddress();
	if (self.isEmpty()) {
		self = u"anon"_q;
	}
	QString safe;
	for (const auto ch : self) {
		safe += (ch.isLetterOrNumber() || ch == '@' || ch == '.' || ch == '-')
			? ch : QChar('_');
	}
	return cWorkingDir() + u"tdata/parvane-history-"_q + safe + u".jsonl"_q;
}

void HistoryAppend(const parvane::StoredMessage &sm) {
	if (sm.id.empty()) {
		return;
	}
	StoreAppendLine(HistoryPath(), QString::fromStdString(sm.toJson().dump()));
}

// Воспроизвести локальную историю в UI при старте (до первого sync). Дедуп по
// uuid делает injectOnMain; live=false → без ack и без пере-записи в журнал.
void ReplayHistory() {
	std::vector<parvane::StoredMessage> msgs;
	for (const auto &line : StoreReadLines(HistoryPath())) {
		try {
			msgs.push_back(parvane::StoredMessage::fromJson(
				nlohmann::json::parse(line.toStdString())));
		} catch (const std::exception &) {
		}
	}
	if (msgs.empty()) {
		return;
	}
	LoadV2Ids();
	V2CacheReplayed(msgs); // правки/реакции v2 после рестарта находят сообщение
	const auto n = int(msgs.size());
	crl::on_main([msgs = std::move(msgs)]() mutable {
		if (const auto session = g_sessionWeak.get()) {
			injectOnMain(session, msgs, /*live=*/false);
		}
	});
	LOG(("Parvane: история: воспроизведено %1 сообщений из журнала").arg(n));
}

// ── Очищенные/удалённые чаты (msg.chat.clear, «для меня») ────────────────────
// uuid скрытых сообщений: сервер исключает их из sync, но локальный журнал
// (HistoryPath) воспроизвёл бы их при старте → журнал переписываем без них, а
// набор персистим на случай гонки (sync до перезаписи, второе устройство).
QSet<QString> g_clearedUuids; // под g_sessionMutex
// Применённая граница очистки чата из журнала личного состояния v2 (T145):
// адрес → время (мс), не позже которого сообщения скрыты. Под g_sessionMutex.
QHash<QString, qint64> g_clearedUntilMs;

[[nodiscard]] QString ClearedPathFor(QString self) {
	if (self.isEmpty()) {
		self = u"anon"_q;
	}
	QString safe;
	for (const auto ch : self) {
		safe += (ch.isLetterOrNumber() || ch == '@' || ch == '.' || ch == '-')
			? ch : QChar('_');
	}
	return cWorkingDir() + u"tdata/parvane-cleared-"_q + safe + u".txt"_q;
}

[[nodiscard]] QString ClearedPath() {
	return ClearedPathFor(SelfAddress());
}

// Звать ПОД g_sessionMutex (из StartSession): SelfAddress() тут нельзя —
// он берёт тот же мьютекс (дедлок).
void LoadClearedLocked() {
	g_clearedUuids.clear();
	for (const auto &line : StoreReadLines(ClearedPathFor(g_selfAddress))) {
		g_clearedUuids.insert(line);
	}
}

void AppendCleared(const QStringList &uuids) {
	for (const auto &u : uuids) {
		StoreAppendLine(ClearedPath(), u);
	}
}

[[nodiscard]] bool IsCleared(const QString &uuid) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_clearedUuids.contains(uuid);
}

// Переписать журнал истории без скрытых сообщений (иначе воскреснут при старте).
void RewriteHistoryWithout(const QSet<QString> &uuids) {
	QStringList kept;
	auto dropped = 0;
	for (const auto &line : StoreReadLines(HistoryPath())) {
		auto id = QString();
		try {
			const auto j = nlohmann::json::parse(line.toStdString());
			id = QString::fromStdString(j.value("id", std::string()));
		} catch (const std::exception &) {
		}
		if (!id.isEmpty() && uuids.contains(id)) {
			++dropped;
			continue;
		}
		kept.push_back(line);
	}
	if (!dropped) {
		return;
	}
	StoreWriteLines(HistoryPath(), kept);
}

// Журнал истории хранит `read` на момент записи, а он append-only: receipt
// собеседника на СВОЁ сообщение раньше жил только в памяти → после рестарта
// реплей показывал одну галочку, хотя sync курсор уже прошёл эту мутацию и
// повторно её не отдавал (10 сен 2026). Перезаписываем записи с read=true.
// Воркер; файл под мьютексом — параллельные перезаписи теряли бы правки.
std::mutex g_historyFileMutex;
void MarkHistoryRead(const QSet<QString> &uuids) {
	std::lock_guard<std::mutex> lk(g_historyFileMutex);
	QStringList kept;
	auto changed = 0;
	for (const auto &line : StoreReadLines(HistoryPath())) {
		try {
			auto j = nlohmann::json::parse(line.toStdString());
			const auto id = QString::fromStdString(j.value("id", std::string()));
			if (!id.isEmpty() && uuids.contains(id) && !j.value("read", false)) {
				j["read"] = true;
				++changed;
				kept.push_back(QString::fromStdString(j.dump()));
				continue;
			}
		} catch (const std::exception &) {
		}
		kept.push_back(line);
	}
	if (!changed) {
		return;
	}
	StoreWriteLines(HistoryPath(), kept);
}

// Локально забыть скрытые сообщения (карты uuid, медиа-контент, кэш расшифровки)
// и удалить их из UI. uuids — уже в g_clearedUuids.
// Кросс-девайс прочитанное: пометить сообщения прочитанными на ЭТОМ устройстве
// (я прочитал их на другом). Снимаем из непрочитанного и двигаем бейдж чата.
void MarkUuidsReadLocal(not_null<Main::Session*> session, const QSet<QString> &uuids) {
	// В журнал прочитанного — иначе после рестарта реплей журнала истории
	// снова покажет их непрочитанными (запись read в журнале — на момент
	// получения).
	{
		auto ids = std::vector<std::string>();
		ids.reserve(uuids.size());
		for (const auto &uuid : uuids) {
			ids.push_back(uuid.toStdString());
		}
		// Сюда приходят receipts, которые сервер УЖЕ знает (sync read=true,
		// ReadNotice с другого устройства) — это подтверждение, а не наш
		// отчёт. Раньше клалось в g_unconfirmedRead → RetryUnconfirmedReads
		// слал msg.chat.read заново → сервер обновлял updated_at → следующий
		// sync снова отдавал те же uuid в readSet → снова сюда: вечный цикл
		// (9000 повторов за вечер 10 сен 2026, rate_limited на gateway, а все
		// другие устройства пересинхронизировали эти сообщения каждые 3 с).
		NoteConfirmedRead(ids);
		crl::async([ids = std::move(ids)] { AppendReadJournal(ids); });
	}
	auto maxByHistory = QHash<History*, MsgId>();
	for (const auto &uuid : uuids) {
		const auto found = g_uuidToMsgId.constFind(uuid);
		if (found == g_uuidToMsgId.constEnd() || found.value() == 0) {
			continue;
		}
		const auto msgId = MsgId(found.value());
		// Убираем из списков непрочитанного по всем пирам
		for (auto it = g_unreadIncoming.begin(); it != g_unreadIncoming.end(); ++it) {
			it.value().removeAll(uuid);
		}
		if (const auto item = session->data().nonChannelMessage(msgId)) {
			const auto history = item->history();
			auto &cur = maxByHistory[history];
			if (msgId > cur) {
				cur = msgId;
			}
		}
	}
	for (auto it = maxByHistory.constBegin(); it != maxByHistory.constEnd(); ++it) {
		if (it.value() > 0) {
			it.key()->inboxRead(it.value()); // двигает бейдж непрочитанного
		}
	}
}

void ForgetClearedOnMain(not_null<Main::Session*> session, const QSet<QString> &uuids) {
	for (const auto &uuid : uuids) {
		const auto found = g_uuidToMsgId.find(uuid);
		if (found != g_uuidToMsgId.end() && found.value() != 0) {
			const auto msgId = found.value();
			g_msgIdToUuid.remove(msgId);
			g_mediaContentByMsgId.remove(msgId);
			// Синтетические пиры — пользователи/чаты (не каналы): общее id-пространство
			if (const auto item = session->data().nonChannelMessage(MsgId(msgId))) {
				item->destroy();
			}
		}
		g_uuidToMsgId.insert(uuid, 0); // обработано, больше не показываем
		DecCacheRemove(uuid);
	}
	RewriteHistoryWithout(uuids);
}

// ── TTL самоуничтожения по чату (persist в tdata/parvane-ttl.json) ────────────
[[nodiscard]] QString TtlStorePath() {
	return cWorkingDir() + u"tdata/parvane-ttl.json"_q;
}
[[nodiscard]] int PeerTtl(const QString &address) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_peerTtl.value(address, 0);
}
void SaveTtlStore() {
	nlohmann::json j = nlohmann::json::object();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		for (auto it = g_peerTtl.constBegin(); it != g_peerTtl.constEnd(); ++it) {
			if (it.value() > 0) {
				j[it.key().toStdString()] = it.value();
			}
		}
	}
	StoreWrite(TtlStorePath(), QString::fromStdString(j.dump()).toUtf8());
}
void LoadTtlStore() {
	const auto raw = StoreRead(TtlStorePath());
	if (raw.isEmpty()) {
		return;
	}
	try {
		auto j = nlohmann::json::parse(raw.toStdString());
		if (j.is_object()) {
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			for (auto it = j.begin(); it != j.end(); ++it) {
				if (it.value().is_number()) {
					g_peerTtl.insert(QString::fromStdString(it.key()),
						it.value().get<int>());
				}
			}
		}
	} catch (const std::exception &) {
	}
}
void SetPeerTtlLocal(const QString &address, int secs) {
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (secs > 0) {
			g_peerTtl.insert(address, secs);
		} else {
			g_peerTtl.remove(address);
		}
	}
	SaveTtlStore();
}

// Групповое E2E (Megolm/sender keys, Фаза 3): раздаёт SKDM (свой session_key)
// каждому участнику по 1-на-1 E2E (sealed) и возвращает group_encrypted-конверт
// для рассылки в группу. "" — E2E не готов или хотя бы один участник не получил
// ключ; вызывающий обязан оставить сообщение неотправленным. Вызывать
// вне g_sessionMutex (внутри сеть: fetch бандлов участников).
[[nodiscard]] std::string sealGroup(
		parvane::MessengerClient *m,
		parvane::ITransport *t,
		const std::string &groupId,
		const parvane::json &content,
		const std::string &token) {
	if (!m || !t || !parvane::e2e::ready()) {
		return {};
	}
	QStringList members;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		members = g_groupMembers.value(QString::fromStdString(groupId));
	}
	std::vector<std::string> recipients;
	for (const auto &member : members) {
		recipients.push_back(member.toStdString());
	}
	// Каталоги устройств участников (и свои) — ДО выбора ключа/эпохи: ротация
	// при исчезновении устройства должна случиться до раздачи SKDM.
	{
		auto prime = recipients;
		prime.push_back(SelfAddress().toStdString());
		parvane::e2e::primeContactDevices(prime, *t, token);
	}
	if (parvane::e2e::groupSyncRecipients(groupId, recipients)) {
		LOG(("Parvane: состав %1 сократился → ротация ключа группы")
			.arg(QString::fromStdString(groupId)));
	}
	const auto skey = parvane::e2e::groupSessionKey(groupId);
	const auto myId = parvane::e2e::myIdentity();
	if (skey.empty() || myId.empty()) {
		return {};
	}
	const auto self = SelfAddress().toStdString();
	// Эпоха ключа — получатель принимает только строго новее (ротация после
	// удаления участника даёт бОльшую эпоху → замена входящей сессии).
	const auto epoch = parvane::e2e::groupEpoch(groupId);
	const parvane::json skdm = {
		{"kind", "skdm"},
		{"group", groupId},
		{"session_key", skey},
		{"sender_identity", myId},
		{"epoch", epoch},
	};
	// SKDM участникам ДО самого сообщения → у получателя ключ раньше шифртекста.
	for (const auto &mem : members) {
		const auto memStd = mem.toStdString();
		if (memStd == self || memStd.empty()) {
			continue;
		}
		try {
			if (sendSealedDirect(m, t, memStd, skdm, token).empty()) {
				return {};
			}
		} catch (const std::exception &) {
			return {};
		}
	}
	// SKDM своим другим устройствам (to=self, best-effort) — иначе они не
	// прочтут мои групповые сообщения.
	try {
		sendSealedDirect(m, t, self, skdm, token);
	} catch (const std::exception &) {
	}
	return parvane::e2e::groupSeal(groupId, content.dump(), epoch);
}

// Cloud ACL хранит конкретных получателей: для лички это peer, для группы —
// актуальный активный состав. Владелец файла имеет доступ неявно.
[[nodiscard]] std::vector<std::string> cloudRecipients(const std::string &to) {
	auto recipients = std::vector<std::string>();
	const auto qto = QString::fromStdString(to);
	const auto self = SelfAddress().toStdString();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (g_knownGroups.contains(qto)) {
			for (const auto &member : g_groupMembers.value(qto)) {
				recipients.push_back(member.toStdString());
			}
		} else {
			recipients.push_back(to);
		}
	}
	recipients.erase(std::remove_if(recipients.begin(), recipients.end(), [&](const auto &member) {
		return member.empty() || member == self;
	}), recipients.end());
	std::sort(recipients.begin(), recipients.end());
	recipients.erase(std::unique(recipients.begin(), recipients.end()), recipients.end());
	return recipients;
}

// P-10 (SEND-1): подписант E2E-отправки — Ed25519 устройства
// (`send:<message_id>:<ciphertext>`), сервер проверяет владение sender_signing_key.
[[nodiscard]] std::function<std::string(const std::string &)> E2eSigner() {
	return [](const std::string &statement) { return parvane::e2e::sign(statement); };
}

// ── Протокол v2 (spec 007, T063): двойной стек, как в вебе ──────────────────
// v1-стек (parvane-e2e) обслуживает v1-собеседников, v2-сессия parvane-core —
// собеседников с журналом устройств v2 (формат выбирается по подписанному
// журналу собеседника, D-13). Включён по умолчанию (T135, FR-055); остаться на
// v1 — PARVANE_PROTO_V2=0 или файл-флаг tdata/parvane-proto-v1 (как localStorage
// parvane:proto=v1 в вебе). События движка перекладываются в те же
// parvane::StoredMessage, что и v1-входящие, и идут в injectOnMain — UI не
// знает, по какому протоколу пришло сообщение. Группы — пока по v1.
std::mutex g_v2Mutex; // g_v2, g_v2Token, g_v2Ids, g_v2Cache, g_v2Reactions
std::shared_ptr<parvane::v2::Session> g_v2;
std::string g_v2Token;
QHash<QString, QString> g_v2Ids;                        // uuid → собеседник (сообщение v2)
QHash<QString, parvane::StoredMessage> g_v2Cache;       // uuid → строка (правки/реакции)
QHash<QString, QHash<QString, QString>> g_v2Reactions; // uuid → (автор → эмодзи)
bool g_v2IdsLoaded = false;

[[nodiscard]] bool V2Enabled() {
	if (const char *v = std::getenv("PARVANE_PROTO_V2"); v && *v) {
		return std::strcmp(v, "0") != 0;
	}
	return !QFile::exists(cWorkingDir() + u"tdata/parvane-proto-v1"_q);
}

[[nodiscard]] std::shared_ptr<parvane::v2::Session> V2Ready() {
	std::lock_guard<std::mutex> lk(g_v2Mutex);
	return (g_v2 && g_v2->isReady()) ? g_v2 : nullptr;
}

// ── блобы вложений по capability (T131, FR-062, D-08) ────────────────────────
// Блоб сообщения v2-чата грузится без per-recipient гранта: сервер хранит
// SHA-256 секрета, сам секрет (поле content.capability) едет внутри E2E.
// Получатель качает блоб анонимным каналом. Есть v1-устройства (LEGACY-1)
// либо чат v1 — гранты получателям, как раньше.
const char *const kBlobCapabilityMark = "capability:";
std::mutex g_blobCapMutex;
std::map<std::string, std::string> g_blobCaps; // file_id → секрет (base64)

void RememberBlobCap(const std::string &fileId, const std::string &capB64) {
	if (fileId.empty() || capB64.empty()) {
		return;
	}
	std::lock_guard<std::mutex> lk(g_blobCapMutex);
	g_blobCaps[fileId] = capB64;
}

// Секреты из содержимого сообщения: вложение, pack_ref стикера, emoji_packs.
void RememberBlobCaps(const parvane::json &content) {
	if (!content.is_object()) {
		return;
	}
	RememberBlobCap(content.value("file_id", std::string()),
		content.value("capability", std::string()));
	if (content.contains("pack_ref") && content["pack_ref"].is_object()) {
		RememberBlobCaps(content["pack_ref"]);
	}
	if (content.contains("emoji_packs") && content["emoji_packs"].is_array()) {
		for (const auto &ref : content["emoji_packs"]) {
			RememberBlobCaps(ref);
		}
	}
}

[[nodiscard]] std::string BlobCapOf(const std::string &fileId) {
	std::lock_guard<std::mutex> lk(g_blobCapMutex);
	const auto it = g_blobCaps.find(fileId);
	return (it == g_blobCaps.end()) ? std::string() : it->second;
}

// Секрет только что загруженного блоба — в содержимое/ссылку на пак.
void AttachBlobCap(parvane::json &target, const std::string &fileId) {
	if (const auto cap = BlobCapOf(fileId); !cap.empty()) {
		target["capability"] = cap;
	} else {
		target.erase("capability");
	}
}

// Получатели гранта для блоба чата `to`; {kBlobCapabilityMark} — чат v2 без
// v1-устройств: грузить по capability. Сеть (журнал собеседника) — звать с
// рабочего потока.
[[nodiscard]] std::shared_ptr<parvane::v2::Session> V2ReadyForSend();

[[nodiscard]] std::vector<std::string> BlobRecipientsFor(const std::string &to) {
	// Ждём исхода запуска v2 (как отправка текста, T149): файл, отправленный
	// сразу после входа, иначе уходил с грантами v1 — а без v1 не уходил вовсе.
	if (const auto s = V2ReadyForSend()) {
		const auto self = SelfAddress().toStdString();
		const auto v2Chat = parvane::v2::isGroupAddress(to) || (to != self && s->isV2Peer(to));
		if (v2Chat && s->legacyDevices(to).empty() && s->legacyDevices(self).empty()) {
			return { kBlobCapabilityMark };
		}
	}
	return cloudRecipients(to);
}

// Загрузить шифртекст блоба: по capability (метка в recipients) либо v1 с
// грантами. Возвращает file_id; секрет запоминается (AttachBlobCap).
[[nodiscard]] std::string UploadBlobWith(
		parvane::CloudClient &cloud,
		const std::string &from,
		const std::string &token,
		const std::string &filename,
		const std::string &mime,
		const std::string &bytes,
		const std::vector<std::string> &recipients,
		int timeoutMs) {
	if (recipients.size() == 1 && recipients[0] == kBlobCapabilityMark) {
		if (const auto s = V2Ready()) {
			auto capability = std::string(32, '\0');
			base::RandomFill(capability.data(), capability.size());
			const auto fileId = s->uploadBlob(bytes, capability);
			RememberBlobCap(fileId, parvane::v2::toBase64(capability));
			return fileId;
		}
		throw std::runtime_error("v2: сессия не готова — блоб не загружен");
	}
	return cloud.upload(from, token, filename, mime, bytes, recipients, false, 256 * 1024, timeoutMs);
}

// Скачать блоб: известен секрет — анонимным каналом v2; иначе v1 (владелец
// или получатель гранта).
[[nodiscard]] parvane::CloudClient::Downloaded DownloadChatBlob(
		parvane::CloudClient &cloud,
		const std::string &self,
		const std::string &token,
		const std::string &fileId,
		int timeoutMs) {
	if (const auto cap = BlobCapOf(fileId); !cap.empty()) {
		if (const auto s = V2Ready()) {
			parvane::CloudClient::Downloaded d;
			try {
				d.bytes = s->downloadBlobCap(fileId, parvane::v2::fromBase64(cap));
				d.ok = true;
			} catch (const std::exception &e) {
				d.error = e.what();
			}
			return d;
		}
	}
	return cloud.download(self, token, fileId, timeoutMs);
}

// «Ключ безопасности» собеседника на v2 (T153) — отпечаток корневого ключа его
// личности из проверенного журнала устройств (один на аккаунт, а не по
// устройствам, как в v1). Журнал читает движок под своим мьютексом, поэтому
// отпечаток считается на воркере и кладётся в кэш; профиль (main) берёт из кэша.
std::mutex g_v2RootMutex;
QHash<QString, QString> g_v2RootFp;

[[nodiscard]] QString V2RootFingerprint(const QString &address) {
	std::lock_guard<std::mutex> lk(g_v2RootMutex);
	return g_v2RootFp.value(address);
}

void V2NoteRoot(const std::shared_ptr<parvane::v2::Session> &s, const std::string &user) {
	if (!s || user.empty() || parvane::v2::isGroupAddress(user)) {
		return;
	}
	const auto root = s->rootKeyOf(user);
	if (root.empty()) {
		return;
	}
	const auto address = QString::fromStdString(user);
	const auto fp = QString::fromStdString(parvane::e2e::fingerprintOf(root));
	{
		std::lock_guard<std::mutex> lk(g_v2RootMutex);
		if (g_v2RootFp.value(address) == fp) {
			return;
		}
		g_v2RootFp.insert(address, fp);
	}
	if (address == SelfAddress()) {
		LOG(("Parvane: свой ключ безопасности v2 (отпечаток): %1").arg(fp));
		return;
	}
	// Профиль собеседника (about) обновляет main — ensurePeerUser читает кэш
	crl::on_main([address] {
		if (const auto session = g_sessionWeak.get()) {
			ensurePeerUser(session, IdForAddress(address), address);
		}
	});
}

// Сессия v2 для ОТПРАВКИ: если она ещё поднимается (вход, рестарт), отправка
// ждёт исхода запуска, а не уходит по v1 — иначе сообщение v2-собеседнику сразу
// после входа молча понижалось до v1 и не доходило до его устройств, которых
// нет в каталоге v1 (D-13; найдено сценарием verify_linking.sh, T135). Ждём
// только на воркере: главный поток не блокируем.
constexpr auto kV2SendStartupWaitMs = 20000;
[[nodiscard]] std::shared_ptr<parvane::v2::Session> V2ReadyForSend() {
	const auto worker = (QThread::currentThread() != QCoreApplication::instance()->thread());
	const auto current = [] {
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		return g_v2;
	};
	auto s = current();
	// Сессию создаёт вход; отправка сразу после него может её опередить
	for (auto i = 0; !s && worker && V2Enabled() && SessionActive() && i != 30; ++i) {
		QThread::msleep(100);
		s = current();
	}
	if (!s) {
		return nullptr;
	}
	if (!s->isReady() && !s->needsLinking() && worker) {
		s->waitReady(kV2SendStartupWaitMs);
	}
	return s->isReady() ? s : nullptr;
}

// Сессия v2 ждёт грант линковки: у аккаунта есть журнал устройств, а этого
// устройства в нём нет (LINK-1 v2). До гранта устройство работает по v1.
[[nodiscard]] std::shared_ptr<parvane::v2::Session> V2NeedsLinking() {
	std::lock_guard<std::mutex> lk(g_v2Mutex);
	return (g_v2 && g_v2->needsLinking()) ? g_v2 : nullptr;
}

// То же для приёма гранта: грант может прийти раньше, чем запуск сессии
// выяснил «нужна линковка», — дожидаемся исхода запуска. Блокирующий (воркер).
[[nodiscard]] std::shared_ptr<parvane::v2::Session> V2AwaitNeedsLinking() {
	std::shared_ptr<parvane::v2::Session> s;
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		s = g_v2;
	}
	if (!s) {
		return nullptr;
	}
	if (!s->isReady() && !s->needsLinking()) {
		s->waitReady(30000);
	}
	return s->needsLinking() ? s : nullptr;
}

[[nodiscard]] QString V2IdsPath() {
	return cWorkingDir() + u"tdata/parvane-v2-ids.txt"_q;
}

// Список v2-сообщений (uuid → собеседник) переживает рестарт: мутации
// сообщений v2-чата уходят по v2 и после перезапуска.
void LoadV2Ids() {
	// Второй вызывающий ЖДЁТ конца чтения. Раньше флаг ставился до чтения файла:
	// запуск v2-сессии (воркер) и воспроизведение журнала (main) стартуют
	// одновременно, и реплей видел пустой список — служебные сообщения режима L2
	// после рестарта отбрасывались как «chat_mode по v1» (2 окт 2026).
	static std::mutex loadMutex;
	std::lock_guard<std::mutex> load(loadMutex);
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		if (g_v2IdsLoaded) {
			return;
		}
	}
	const auto lines = StoreReadLines(V2IdsPath());
	std::lock_guard<std::mutex> lk(g_v2Mutex);
	for (const auto &line : lines) {
		const auto sp = line.indexOf(' ');
		if (sp > 0 && !g_v2Ids.contains(line.left(sp))) {
			g_v2Ids.insert(line.left(sp), line.mid(sp + 1));
		}
	}
	g_v2IdsLoaded = true;
}

void V2NoteMessage(const parvane::StoredMessage &sm, const QString &peer) {
	const auto uuid = QString::fromStdString(sm.id);
	bool fresh = false;
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		fresh = !g_v2Ids.contains(uuid);
		g_v2Ids.insert(uuid, peer);
		g_v2Cache.insert(uuid, sm);
	}
	if (fresh) {
		StoreAppendLine(V2IdsPath(), uuid + u' ' + peer);
	}
}

// Собеседник v2-сообщения ("" — сообщение v1).
[[nodiscard]] QString V2PeerOf(const QString &uuid) {
	std::lock_guard<std::mutex> lk(g_v2Mutex);
	return g_v2Ids.value(uuid);
}

[[nodiscard]] bool IsV2Message(const std::string &uuid) {
	std::lock_guard<std::mutex> lk(g_v2Mutex);
	return g_v2Ids.contains(QString::fromStdString(uuid));
}

// Строка журнала после рестарта — в кэш правок/реакций, если она из v2.
void V2CacheReplayed(const std::vector<parvane::StoredMessage> &msgs) {
	std::lock_guard<std::mutex> lk(g_v2Mutex);
	for (const auto &sm : msgs) {
		const auto uuid = QString::fromStdString(sm.id);
		if (g_v2Ids.contains(uuid) && !g_v2Cache.contains(uuid)) {
			g_v2Cache.insert(uuid, sm);
		}
	}
}

// Отправить содержимое собеседнику на v2. "" — собеседник не на v2 (или вид
// не поддержан v2): идти по v1. Бросает при сбое v2-отправки v2-собеседнику
// (формат не понижается — D-13).
std::string TrySendV2(
		const std::string &to,
		const parvane::json &content,
		const std::optional<std::string> &replyTo,
		const std::optional<std::string> &preId) {
	const auto kind = parvane::contentKind(content);
	if (kind == "skdm" || kind.empty()) {
		return {}; // ключи групп v1 и служебное — только v1
	}
	// Группа v2 — только v2 (конверт эпохи): v1-пути у неё нет.
	const auto isGroup = parvane::v2::isGroupAddress(to);
	const auto s = V2ReadyForSend();
	if (isGroup && !s) {
		throw std::runtime_error("группа v2, а сессия v2 не готова");
	}
	// Устройство ещё не в журнале устройств аккаунта (ждёт привязки, восстановления
	// или сброса): у него нет сертификата, v1-бандл identity не принимает — его
	// v1-сообщение собеседники отвергли бы или не получили. Отправка — после привязки.
	if (!s && V2NeedsLinking()) {
		throw std::runtime_error("устройство не привязано к аккаунту — отправка недоступна до привязки");
	}
	// «Избранное» (чат с собой, T147) — по v2: копии своим устройствам журнала;
	// по v1 оно не дошло бы до привязанных устройств вне каталога v1.
	const auto isSelf = (to == SelfAddress().toStdString());
	if (!s || (!isGroup && !isSelf && !s->isV2Peer(to))) {
		return {};
	}
	if (!isGroup && !isSelf) {
		V2NoteRoot(s, to);
	}
	const auto mapped = parvane::v2::toV2(content, replyTo.value_or(std::string()));
	if (!mapped) {
		if (isGroup) {
			throw std::runtime_error("вид " + kind + " не поддержан v2 (группа v2)");
		}
		LOG(("Parvane: v2: вид %1 не поддержан v2 — по v1")
			.arg(QString::fromStdString(kind)));
		return {};
	}
	const auto id = (preId && !preId->empty()) ? *preId : parvane::v2::newUuidV7();
	s->sendContent(to, *mapped, id);
	parvane::StoredMessage sm;
	sm.id = id;
	sm.from = SelfAddress().toStdString();
	sm.to = to;
	sm.ts = QDateTime::currentSecsSinceEpoch();
	sm.content = content;
	sm.reply_to = replyTo;
	V2NoteMessage(sm, QString::fromStdString(to));
	LOG(("Parvane: v2 → %1 msg %2 (%3)")
		.arg(QString::fromStdString(to), QString::fromStdString(id), QString::fromStdString(kind)));
	// Переходный период (FR-054): та же запись — v1-устройствам из подписанных
	// списков собеседника и своего.
	if (!isGroup) {
		parvane::ITransport *t = nullptr;
		std::string token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			token = g_token.toStdString();
		}
		if (t) {
			parvane::v2::sendLegacyCopies(*s, *t, token, to, content, id, replyTo);
		}
	}
	return id;
}

// T146: сессия v2 готова — устройство в журнале устройств. Если identity при
// входе отверг его v1-бандл (у аккаунта на v2 устройство без сертификата в
// каталог v1 не попадает), публикация повторяется: v1-собеседники шлют копии
// только устройствам каталога.
void RepublishDeviceIfRefused() {
	crl::async([] {
		if (!parvane::e2e::ready() || parvane::e2e::published()) {
			return;
		}
		parvane::ITransport *t = nullptr;
		std::string token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			token = g_token.toStdString();
		}
		if (t && !token.empty()) {
			const auto ok = parvane::e2e::republishDevice(*t, token);
			LOG(("Parvane: v1-бандл устройства после привязки к журналу v2 — %1")
				.arg(ok ? u"опубликован"_q : u"не принят"_q));
		}
	});
}

// Свой подписанный список v1-устройств (FR-058): публикует первое
// v2-устройство, дальше список только сокращается.
void PublishLegacySet() {
	crl::async([] {
		const auto s = V2Ready();
		parvane::ITransport *t = nullptr;
		std::string token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			token = g_token.toStdString();
		}
		if (s && t) {
			parvane::v2::publishLegacySet(*s, *t, token);
		}
	});
}

// Мутация сообщения v2-чата (правка/удаление/реакция/закреп/прочтение) —
// E2E-содержимым v2 собеседнику. false — сообщение не v2 (идти по v1).
bool TryMutateV2(const QString &uuid, const parvane::json &content) {
	const auto peer = V2PeerOf(uuid);
	if (peer.isEmpty()) {
		return false;
	}
	const auto peerStd = peer.toStdString();
	crl::async([peerStd, content, uuid] {
		const auto s = V2Ready();
		if (!s) {
			LOG(("Parvane: v2: мутация %1 не отправлена — сессия v2 не готова").arg(uuid));
			return;
		}
		try {
			s->sendContent(peerStd, content, parvane::v2::newUuidV7());
			LOG(("Parvane: v2 → %1 %2 для %3")
				.arg(QString::fromStdString(peerStd),
					QString::fromStdString(parvane::v2::v2Kind(content)), uuid));
		} catch (const std::exception &e) {
			LOG(("Parvane: v2: мутация %1 не отправлена: %2")
				.arg(uuid, QString::fromUtf8(e.what())));
		}
	});
	return true;
}

// Правка (content задан) или удаление v2-сообщения — и v1-устройствам,
// получившим его легаси-копией (FR-054).
void MirrorLegacyMutation(const QString &uuid, std::optional<parvane::json> content) {
	const auto peer = V2PeerOf(uuid).toStdString();
	if (peer.empty() || parvane::v2::isGroupAddress(peer)) {
		return;
	}
	crl::async([peer, uuid, content = std::move(content)] {
		const auto s = V2Ready();
		parvane::MessengerClient *m = nullptr;
		parvane::ITransport *t = nullptr;
		std::string token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
			t = g_transport.get();
			token = g_token.toStdString();
		}
		if (!s || !m || !t) {
			return;
		}
		if (content) {
			parvane::v2::editLegacyCopies(*s, *t, *m, token, peer, *content, uuid.toStdString());
		} else {
			parvane::v2::deleteLegacyCopies(*s, *m, token, peer, uuid.toStdString());
		}
	});
}

// Сводка реакций сообщения из известных v2-реакций (под g_v2Mutex).
std::vector<parvane::ReactionSummary> V2ReactionsLocked(const QString &uuid, const std::string &self) {
	std::map<std::string, parvane::ReactionSummary> by;
	const auto users = g_v2Reactions.value(uuid);
	for (auto it = users.cbegin(); it != users.cend(); ++it) {
		auto &r = by[it.value().toStdString()];
		r.emoji = it.value().toStdString();
		++r.count;
		if (it.key().toStdString() == self) {
			r.mine = true;
		}
	}
	auto out = std::vector<parvane::ReactionSummary>();
	for (auto &[emoji, r] : by) {
		out.push_back(r);
	}
	return out;
}

// События v2-сессии (группы, свои устройства, журнал состояния) — ниже по
// файлу, раздел «Протокол v2: группы и журнал состояния».
[[nodiscard]] bool HandleV2SessionEvent(const parvane::json &ev);
void ScheduleStateFlush(const char *kind);
void NoteStateEdited(const char *kind); // T150                                  // журнал состояния: своя правка
void LoadV2GroupCache(not_null<Main::Session*> session);    // группы v2 до подъёма сессии

// Групповое сообщение: группа v2 → движок (конверт эпохи, T056), иначе
// Megolm v1. "" — не отправлено (причина в логе).
std::string sendGroupContent(
		parvane::MessengerClient *m,
		parvane::ITransport *t,
		const std::string &to,
		const parvane::json &content,
		const std::string &token,
		const std::optional<std::string> &replyTo = std::nullopt,
		const std::optional<std::string> &preId = std::nullopt) {
	if (parvane::v2::isGroupAddress(to)) {
		try {
			return TrySendV2(to, content, replyTo, preId);
		} catch (const std::exception &e) {
			LOG(("Parvane: v2-отправка в группу %1 не удалась: %2 — НЕ отправлено")
				.arg(QString::fromStdString(to), QString::fromUtf8(e.what())));
			return {};
		}
	}
	const auto sealed = sealGroup(m, t, to, content, token);
	if (sealed.empty()) {
		return {};
	}
	// Групповое v1: from ВИДЕН (сервер проверяет членство), content —
	// group_encrypted (Megolm), непрозрачен для сервера.
	return m->sendContent(SelfAddress().toStdString(), to, nlohmann::json::parse(sealed), token,
		replyTo, preId, parvane::json::array(), E2eSigner());
}

// Событие движка (рабочий поток v2-сессии) → строки конвейера UI.
void HandleV2Event(const parvane::json &ev) {
	if (HandleV2SessionEvent(ev)) {
		return;
	}
	const auto self = SelfAddress().toStdString();
	const auto in = parvane::v2::interpretDirect(ev, self);
	using Kind = parvane::v2::Incoming::Kind;
	if (in.kind == Kind::None) {
		return;
	}
	auto out = std::vector<parvane::StoredMessage>();
	if (in.kind == Kind::Message || in.kind == Kind::Stub) {
		parvane::StoredMessage sm;
		sm.id = in.id;
		sm.from = in.from;
		sm.to = in.to;
		sm.ts = in.ts ? in.ts : QDateTime::currentSecsSinceEpoch();
		sm.content = in.content;
		if (!in.replyTo.empty()) {
			sm.reply_to = in.replyTo;
		}
		V2NoteMessage(sm, QString::fromStdString(in.chat));
		if (in.from != self) {
			V2NoteRoot(V2Ready(), in.from);
		}
		LOG(("Parvane: v2 ← %1 msg %2 (%3)")
			.arg(QString::fromStdString(in.from), QString::fromStdString(in.id),
				QString::fromStdString(parvane::contentKind(in.content))));
		out.push_back(std::move(sm));
	} else {
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		for (const auto &target : in.targets) {
			const auto uuid = QString::fromStdString(target);
			auto it = g_v2Cache.find(uuid);
			if (it == g_v2Cache.end()) {
				LOG(("Parvane: v2: мутация для неизвестного %1 — пропуск").arg(uuid));
				continue;
			}
			auto sm = it.value();
			switch (in.kind) {
			case Kind::Edit: {
				if (sm.from != in.from || !in.content.is_object()) {
					continue; // править можно только своё
				}
				const auto nk = parvane::contentKind(in.content);
				if (nk == "location") {
					for (auto f = in.content.begin(); f != in.content.end(); ++f) {
						sm.content[f.key()] = f.value();
					}
				} else if (parvane::contentKind(sm.content) == "text") {
					sm.content["text"] = in.content.value("text", std::string());
					sm.content["entities"] = in.content.contains("entities")
						? in.content["entities"] : parvane::json::array();
				} else {
					sm.content["caption"] = in.content.value("text", std::string());
					sm.content["entities"] = in.content.contains("entities")
						? in.content["entities"] : parvane::json::array();
				}
				sm.edited = true;
			} break;
			case Kind::Delete:
				if (sm.from != in.from) {
					continue; // удалить у всех можно только своё
				}
				sm.deleted = true;
				break;
			case Kind::Reaction: {
				auto &users = g_v2Reactions[uuid];
				const auto author = QString::fromStdString(in.from);
				if (in.remove) {
					users.remove(author);
				} else {
					users.insert(author, QString::fromStdString(in.emoji));
				}
				sm.reactions = V2ReactionsLocked(uuid, self);
			} break;
			case Kind::Pin:
				sm.pinned = !in.unpin;
				break;
			case Kind::Read:
				if (sm.from != self || in.from == self) {
					continue; // квитанция собеседника о МОЁМ сообщении
				}
				sm.read = true;
				break;
			default:
				continue;
			}
			it.value() = sm;
			out.push_back(sm);
		}
	}
	if (out.empty()) {
		return;
	}
	crl::on_main([out = std::move(out)] {
		if (const auto session = g_sessionWeak.get()) {
			injectOnMain(session, out, /*live=*/true);
		}
	});
}

// ── Приватность v2 (T079, FR-040): «сообщения от незнакомых» ───────────────
// Источник истины — сервер: сессия при готовности читает identity.privacy.get
// (событие `privacy`) и кладёт значение в tdata/parvane-privacy.json (под
// storecrypt). Своя правка помечается `dirty`, пока сервер её не принял
// (событие `privacySaved`), и досылается при следующем запуске.
struct PrivacyLocal {
	bool set = false;            // значение известно (с сервера или задано здесь)
	bool dirty = false;          // правка этого устройства ещё не на сервере
	bool dirtyCallsPresence = false; // то же для звонков/присутствия (T137)
	bool strangers = true;       // сообщения от незнакомых разрешены
	bool groupAddNobody = false; // «никто не может добавлять меня в группы»
	bool callsNobody = false;    // «никто не может мне звонить»
	bool presenceNobody = false; // «никто не видит, что я в сети»
};

[[nodiscard]] QString PrivacyPath() {
	return cWorkingDir() + u"tdata/parvane-privacy.json"_q;
}

[[nodiscard]] PrivacyLocal LoadPrivacyLocal(const QString &self) {
	auto out = PrivacyLocal();
	const auto j = parvane::json::parse(StoreRead(PrivacyPath()).toStdString(), nullptr, false);
	if (j.is_object() && j.value("self", std::string()) == self.toStdString()) {
		out.set = true;
		out.strangers = j.value("strangers", true);
		out.groupAddNobody = (j.value("group_add", std::string()) == "nobody");
		out.dirty = j.value("dirty", false);
		out.callsNobody = (j.value("calls_from", std::string()) == "nobody");
		out.presenceNobody = (j.value("presence_visibility", std::string()) == "nobody");
		out.dirtyCallsPresence = j.value("dirty_calls_presence", false);
	}
	g_privacyCallsNobody = out.callsNobody;
	g_privacyPresenceHidden = out.presenceNobody;
	return out;
}

void SavePrivacyLocal(const QString &self, const PrivacyLocal &p) {
	const parvane::json j{
		{ "self", self.toStdString() },
		{ "strangers", p.strangers },
		{ "group_add", p.groupAddNobody ? "nobody" : "anyone" },
		{ "dirty", p.dirty },
		{ "calls_from", p.callsNobody ? "nobody" : "anyone" },
		{ "presence_visibility", p.presenceNobody ? "nobody" : "anyone" },
		{ "dirty_calls_presence", p.dirtyCallsPresence },
	};
	g_privacyCallsNobody = p.callsNobody;
	g_privacyPresenceHidden = p.presenceNobody;
	StoreWrite(PrivacyPath(), QString::fromStdString(j.dump()).toUtf8());
}

// Режим L2 между запусками (L2-1): последнее известное состояние действует с
// запуска — до готовности v2-сессии присутствие уже могло бы уйти в сеть.
[[nodiscard]] QString L2CachePath() {
	return cWorkingDir() + u"tdata/parvane-l2.json"_q;
}

void SaveL2Cache(const QString &self, const QSet<QString> &chats, const QSet<QString> &mine, bool presence) {
	auto list = [](const QSet<QString> &set) {
		auto out = parvane::json::array();
		for (const auto &item : set) out.push_back(item.toStdString());
		return out;
	};
	const parvane::json j{
		{ "self", self.toStdString() },
		{ "chats", list(chats) },
		{ "mine", list(mine) },
		{ "presence", presence },
	};
	StoreWrite(L2CachePath(), QString::fromStdString(j.dump()).toUtf8());
}

void LoadL2Cache(const QString &self) {
	const auto j = parvane::json::parse(StoreRead(L2CachePath()).toStdString(), nullptr, false);
	if (!j.is_object() || j.value("self", std::string()) != self.toStdString()) {
		return;
	}
	const auto list = [&](const char *key) {
		auto out = QSet<QString>();
		if (j.contains(key) && j[key].is_array()) {
			for (const auto &c : j[key]) {
				if (c.is_string()) out.insert(QString::fromStdString(c.get<std::string>()));
			}
		}
		return out;
	};
	{
		std::lock_guard<std::mutex> lk(g_l2Mutex);
		g_l2Chats = list("chats");
		g_l2Mine = list("mine");
	}
	g_l2PresenceAllowed = j.value("presence", true);
}

// ── ключ восстановления (T140, FR-066; D-12, C1-06) ────────────────────────
// Корень личности нового аккаунта на диске не хранится: остаётся его копия под
// ключом восстановления, а сам ключ показывается один раз. Сценарии e2e
// (PARVANE_AUTOLOGIN) диалог не показывают: с PARVANE_RECOVERY_KEY_FILE ключ
// пишется в этот файл, без него остаётся прежняя схема — корень в файле `root`.
QString g_pendingRecoveryKey; // только main

[[nodiscard]] QString RecoveryKeyFileForE2e() {
	const char *path = ParvaneDevEnv("PARVANE_RECOVERY_KEY_FILE");
	return (path && *path) ? QString::fromUtf8(path) : QString();
}

void ShowPendingRecoveryKey(int attempt) {
	if (g_pendingRecoveryKey.isEmpty()) {
		return;
	}
	if (!Core::App().activeWindow() || !g_sessionWeak.get()) {
		// Окно ещё не готово (вход в процессе) — ключ ждёт, терять его нельзя.
		if (attempt < 150) {
			base::call_delayed(crl::time(2000), [=] { ShowPendingRecoveryKey(attempt + 1); });
		}
		return;
	}
	const auto key = base::take(g_pendingRecoveryKey);
	Ui::show(Box([=](not_null<Ui::GenericBox*> box) {
		box->setTitle(rpl::single(u"Ключ восстановления"_q));
		box->setCloseByOutsideClick(false);
		box->setCloseByEscape(false);
		box->addRow(object_ptr<Ui::FlatLabel>(
			box,
			rpl::single(u"Сохраните этот ключ в надёжном месте — он показывается один раз. "
				"Им вы войдёте в аккаунт, если потеряете все устройства, и подтвердите "
				"смену ключа подписи после отзыва устройства. Сервер ключа не знает."_q),
			st::boxLabel));
		const auto label = box->addRow(
			object_ptr<Ui::FlatLabel>(box, rpl::single(key), st::boxLabel),
			st::boxRowPadding + QMargins(0, st::boxLittleSkip, 0, 0));
		label->setSelectable(true);
		box->addButton(rpl::single(u"Я сохранил(а) ключ"_q), [=] { box->closeBox(); });
		box->addLeftButton(rpl::single(u"Скопировать"_q), [=] {
			QGuiApplication::clipboard()->setText(key);
			box->showToast(u"Ключ восстановления скопирован"_q);
		});
	}));
	LOG(("Parvane: v2: ключ восстановления показан"));
}

void HandleRecoveryKey(const std::string &key) {
	const auto text = QString::fromStdString(key);
	if (const auto path = RecoveryKeyFileForE2e(); !path.isEmpty()) {
		QFile file(path);
		if (file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
			file.write(text.toUtf8());
		}
		LOG(("Parvane: v2: ключ восстановления записан в файл e2e"));
		return;
	}
	crl::on_main([text] {
		g_pendingRecoveryKey = text;
		ShowPendingRecoveryKey(0);
	});
}

[[nodiscard]] QString RecoveryKeyFromE2eFile() {
	const auto path = RecoveryKeyFileForE2e();
	if (path.isEmpty()) {
		return QString();
	}
	QFile file(path);
	return file.open(QIODevice::ReadOnly)
		? QString::fromUtf8(file.readAll()).trimmed()
		: QString();
}

// Поднять v2-сессию (под g_sessionMutex из StartSession: адрес и JWT уже есть).
void StartV2Locked() {
	if (!V2Enabled()) {
		return;
	}
	const auto url = GatewayUrl();
	if (url.isEmpty()) {
		LOG(("Parvane: v2 включён, но нет gateway (прямой NATS) — только v1"));
		return;
	}
	const auto self = g_selfAddress.toStdString();
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		if (g_v2) {
			return;
		}
		g_v2Token = g_token.toStdString();
	}
	LoadV2Ids();
	LoadL2Cache(g_selfAddress); // режим L2 — с запуска, до готовности сессии
	parvane::v2::SessionConfig cfg;
	cfg.gatewayUrl = url.toStdString();
	cfg.self = self;
	cfg.token = [] {
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		return g_v2Token;
	};
	QString safe;
	for (const auto ch : g_selfAddress) {
		safe += (ch.isLetterOrNumber() || ch == '@' || ch == '.' || ch == '-')
			? ch : QChar('_');
	}
	cfg.stateDir = (cWorkingDir() + u"tdata/parvane-v2-"_q + safe).toStdString();
	cfg.clientVersion = "desktop";
	cfg.log = [](const std::string &m) {
		LOG(("Parvane: %1").arg(QString::fromStdString(m)));
	};
	cfg.onEvent = [](const parvane::json &ev) { HandleV2Event(ev); };
	if (!ParvaneDevEnv("PARVANE_AUTOLOGIN") || !RecoveryKeyFileForE2e().isEmpty()) {
		cfg.onRecoveryKey = [](const std::string &key) { HandleRecoveryKey(key); };
	}
	auto s = std::make_shared<parvane::v2::Session>(std::move(cfg));
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		g_v2 = s;
	}
	// Несохранённая правка приватности — сессия отправит при готовности; без неё
	// сессия сама прочитает серверное значение (событие `privacy`).
	if (const auto privacy = LoadPrivacyLocal(g_selfAddress); privacy.set) {
		if (privacy.dirty) {
			s->setPrivacy(privacy.groupAddNobody, privacy.strangers);
		}
		if (privacy.dirtyCallsPresence) {
			s->setCallsPresencePrivacy(privacy.callsNobody, privacy.presenceNobody);
		}
	}
	s->start();
	LOG(("Parvane: v2: сессия запускается (%1, движок %2)")
		.arg(url, QString::fromStdString(parvane::v2::engineVersion())));
}

void StopV2() {
	std::shared_ptr<parvane::v2::Session> s;
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		s = std::move(g_v2);
		g_v2Cache.clear();
		g_v2Reactions.clear();
	}
	if (s) {
		s->stop();
	}
	{
		std::lock_guard<std::mutex> lk(g_l2Mutex);
		g_l2Chats.clear();
		g_l2Mine.clear();
		g_l2V2Peers.clear();
	}
	g_l2PresenceAllowed = true;
}

// 1-на-1 sealed-отправка с fan-out копий по устройствам получателя и своим
// устройствам (мультидевайс). "" — E2E не удался (ничего не отправлено).
// На проводе from ПУСТОЙ (sealed sender). Токен передаём: messenger требует
// его и для sealed (P-40 — отозванное устройство не должно слать до истечения
// JWT). Gateway всё равно подставляет токен сессии сам; на прямом NATS
// (dev-транспорт) без него сервер отвергал отправку («неверный или
// просроченный JWT») — 1-на-1 и раздача ключей групп (SKDM) не доходили.
std::string sendSealedDirect(
		parvane::MessengerClient *m,
		parvane::ITransport *t,
		const std::string &to,
		const parvane::json &content,
		const std::string &token,
		const std::optional<std::string> &replyTo,
		const std::optional<std::string> &preId) {
	// Протокол v2: собеседник с журналом устройств v2 — по v2 (двойной стек).
	try {
		if (auto id = TrySendV2(to, content, replyTo, preId); !id.empty()) {
			return id;
		}
	} catch (const std::exception &e) {
		LOG(("Parvane: v2-отправка %1 не удалась: %2 — НЕ отправлено")
			.arg(QString::fromStdString(to), QString::fromUtf8(e.what())));
		return {};
	}
	const auto sealed = parvane::e2e::sealForAddress(to, content.dump(), *t, token);
	if (!sealed) {
		return {};
	}
	auto copies = parvane::json::array();
	for (const auto &c : sealed->copies) {
		copies.push_back(c.toJson());
	}
	return m->sendContent(std::string(), to, sealed->content, token,
		replyTo, preId, copies, E2eSigner());
}

// Своё исходящее — в кэш расшифровки (как у web): так оно попадает в экспорт
// при линковке и читается из подписанного sync на этом же устройстве.
void cacheOwnOutgoing(const std::string &id, const std::string &self,
		const parvane::json &content) {
	const nlohmann::json inner = {{"from", self}, {"content", content}};
	DecCachePut(QString::fromStdString(id), QString::fromStdString(inner.dump()));
}

void sendTextAsync(
		const QString &toAddress,
		const QString &text,
		const nlohmann::json &entities,
		const std::string &preId,
		const std::optional<std::string> &replyToUuid = std::nullopt,
		const nlohmann::json &webpage = nlohmann::json()) {
	const auto from = SelfAddress().toStdString();
	const auto to = toAddress.toStdString();
	const auto body = text.toStdString();
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		parvane::ITransport *t = nullptr;
		bool isGroup = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
			t = g_transport.get();
			isGroup = g_knownGroups.contains(QString::fromStdString(to));
		}
		if (!m) {
			LOG(("Parvane: sendText без активной сессии — пропуск"));
			return;
		}
		// TTL самоуничтожения по чату (сек): едет ВНУТРИ E2E-content (сервер не
		// знает), получатель ставит нативный ttl_period → авто-удаление.
		const int ttl = PeerTtl(toAddress);
		try {
			std::string id;
			// 1-на-1 текст → E2E (Фаза 2): шифруем реальный content, шлём вариант
			// Encrypted. Группы → E2E Megolm (Фаза 3, sender keys).
			if (!isGroup && t && parvane::e2e::ready()) {
				auto content = parvane::textContent(body, entities, webpage);
				if (ttl > 0) {
					content["ttl_secs"] = ttl;
				}
				if (auto packs = BuildEmojiPacks(t, entities, from, token,
						BlobRecipientsFor(to)); !packs.empty()) {
					content["emoji_packs"] = packs;
				}
				// Sealed sender: from ПУСТОЙ на проводе (отправитель скрыт от
				// получателей; подлинность — крипто Olm), токен — см. sendSealedDirect.
				id = sendSealedDirect(m, t, to, content, token, replyToUuid,
					preId.empty() ? std::optional<std::string>{} : std::optional<std::string>{preId});
				if (id.empty()) {
					// Не удалось (нет бандла/one-time) — НЕ слать открытым текстом.
					LOG(("Parvane: E2E не удался для %1 — сообщение НЕ отправлено")
						.arg(QString::fromStdString(to)));
					return;
				}
				// Каталог устройств собеседника только что прогрет (первый
				// контакт) — обновить отпечатки ключа в его профиле, не дожидаясь
				// входящего (профиль синтезируется в ensurePeerUser).
				crl::on_main([toQ = QString::fromStdString(to)] {
					if (const auto session = g_sessionWeak.get()) {
						ensurePeerUser(session, IdForAddress(toQ), toQ);
					}
				});
			} else if (isGroup && t && parvane::e2e::ready()) {
				auto content = parvane::textContent(body, entities, webpage);
				if (ttl > 0) {
					content["ttl_secs"] = ttl;
				}
				if (auto packs = BuildEmojiPacks(t, entities, from, token,
						BlobRecipientsFor(to)); !packs.empty()) {
					content["emoji_packs"] = packs;
				}
				// Пустой preId → nullopt (иначе event.id="" — невалидный uuid).
				const auto pre = preId.empty()
					? std::optional<std::string>{}
					: std::optional<std::string>{preId};
				id = sendGroupContent(m, t, to, content, token, replyToUuid, pre);
				if (id.empty()) {
					LOG(("Parvane: E2E группы не удался для %1 — НЕ отправлено")
						.arg(QString::fromStdString(to)));
					return;
				}
			} else {
				LOG(("Parvane: E2E недоступен для %1 — сообщение НЕ отправлено")
					.arg(QString::fromStdString(to)));
				return;
			}
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_ownSentUuids.insert(id);
			}
			if (!id.empty() && ttl == 0) {
				auto content = parvane::textContent(body, entities, webpage);
				cacheOwnOutgoing(id, from, content);
			}
			if (!id.empty() && ttl > 0) {
				// TTL: эфемерное — НЕ журналируем и планируем авто-удаление своего эха
				// (на wall-clock как у получателя: примерно send_time + ttl).
				const auto uuidQ = QString::fromStdString(id);
				const auto peerAddr = toAddress;
				const auto grp = isGroup;
				crl::on_main([uuidQ, peerAddr, grp, ttl] {
					base::call_delayed(ttl * crl::time(1000), [uuidQ, peerAddr, grp] {
						const auto session = g_sessionWeak.get();
						if (!session) {
							return;
						}
						std::int64_t bare = 0;
						{
							std::lock_guard<std::mutex> lk(g_sessionMutex);
							const auto it = g_uuidToMsgId.find(uuidQ);
							if (it != g_uuidToMsgId.end()) {
								bare = it.value();
							}
						}
						if (!bare) {
							return;
						}
						const auto peerId = grp
							? peerFromChat(ChatId(BareId(IdForAddress(peerAddr))))
							: peerFromUser(UserId(BareId(IdForAddress(peerAddr))));
						if (const auto item = session->data().message(
								FullMsgId(peerId, MsgId(bare)))) {
							item->destroy();
							LOG(("Parvane: ttl — своё %1 самоуничтожено").arg(uuidQ));
						}
					});
				});
			} else if (!id.empty()) {
				// Своё исходящее — в локальный журнал (плейнтекст), переживёт рестарт/
				// релогин: свои sealed на сервере как «свои» не лежат, восстановить нечем.
				parvane::StoredMessage own;
				own.id = id;
				own.from = from;
				own.to = to;
				own.ts = QDateTime::currentSecsSinceEpoch();
				own.content = parvane::textContent(body, entities, webpage);
				if (replyToUuid) {
					own.reply_to = *replyToUuid;
				}
				HistoryAppend(own);
			}
			LOG(("Parvane: отправлено msg %1 → %2%3")
				.arg(QString::fromStdString(id))
				.arg(QString::fromStdString(to))
				.arg((t && parvane::e2e::ready()) ? u" [E2E]"_q : QString()));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка отправки: %1").arg(QString::fromUtf8(e.what())));
		}
	});
}

// Публикует готовый MessageContent (для пересылки медиа — блоб уже в cloud).
void sendContentAsync(const QString &toAddress, const std::string &contentJson) {
	const auto from = SelfAddress().toStdString();
	const auto to = toAddress.toStdString();
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		parvane::ITransport *t = nullptr;
		bool isGroup = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
			t = g_transport.get();
			isGroup = g_knownGroups.contains(QString::fromStdString(to));
		}
		if (!m || !t || !parvane::e2e::ready()) {
			LOG(("Parvane: пересылка не отправлена — E2E недоступен для %1")
				.arg(toAddress));
			return;
		}
		try {
			const auto content = parvane::json::parse(contentJson);
			std::string id;
			if (!isGroup) {
				id = sendSealedDirect(m, t, to, content, token);
				if (id.empty()) {
					LOG(("Parvane: E2E пересылки не удался для %1 — не отправлено")
						.arg(toAddress));
					return;
				}
			} else {
				id = sendGroupContent(m, t, to, content, token);
				if (id.empty()) {
					LOG(("Parvane: E2E пересылки группы не удался для %1 — не отправлено")
						.arg(toAddress));
					return;
				}
			}
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_ownSentUuids.insert(id);
			}
			LOG(("Parvane: переслано медиа → %1").arg(toAddress));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка пересылки: %1").arg(QString::fromUtf8(e.what())));
		}
	});
}

// Шлёт произвольный inner-контент СТРОГО через E2E (sealed 1-на-1 / Megolm для
// группы). Для контента, которого сервер не знает (опросы и т.п.): messenger
// парсит только верхний MessageContent, а sealed/group_encrypted для него
// непрозрачны. E2E не готов — НЕ отправляем (открытым текстом сервер такой
// kind всё равно отвергнет). preId — uuid события (сгенерирован на main).
void sendInnerAsync(
		const QString &toAddress,
		const nlohmann::json &content,
		const std::string &preId) {
	const auto from = SelfAddress().toStdString();
	const auto to = toAddress.toStdString();
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		parvane::ITransport *t = nullptr;
		bool isGroup = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
			t = g_transport.get();
			isGroup = g_knownGroups.contains(QString::fromStdString(to));
		}
		if (!m || !t || !parvane::e2e::ready()) {
			LOG(("Parvane: inner-контент не отправлен (нет сессии/E2E) → %1")
				.arg(toAddress));
			return;
		}
		try {
			std::string id;
			if (!isGroup) {
				id = sendSealedDirect(m, t, to, content, token, std::nullopt,
					preId.empty() ? std::optional<std::string>{} : std::optional<std::string>{preId});
				if (id.empty()) {
					LOG(("Parvane: E2E не удался для %1 — inner-контент НЕ отправлен")
						.arg(toAddress));
					return;
				}
			} else {
				const auto pre = preId.empty()
					? std::optional<std::string>{}
					: std::optional<std::string>{preId};
				id = sendGroupContent(m, t, to, content, token, std::nullopt, pre);
				if (id.empty()) {
					LOG(("Parvane: E2E группы не удался для %1 — НЕ отправлено")
						.arg(toAddress));
					return;
				}
			}
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_ownSentUuids.insert(id);
			}
			LOG(("Parvane: inner-контент %1 → %2 [E2E]")
				.arg(QString::fromStdString(
					content.value("kind", std::string())))
				.arg(toAddress));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка отправки inner-контента: %1")
				.arg(QString::fromUtf8(e.what())));
		}
	});
}

} // namespace

// Рингтон звонка (определены ниже) — нужны в onIncoming/onState выше по коду.
void PlayRingtone(bool outgoing);
void StopRingtone();

QString NatsUrl() {
	if (const char *v = ParvaneDevEnv("PARVANE_NATS_URL"); v && *v) {
		return QString::fromUtf8(v);
	}
	return u"nats://127.0.0.1:4222"_q;
}

// Адрес gateway: "host:port" / "tcp://host:port" (TCP, dev) либо
// "wss://host:port/ws" / "ws://host:port/ws" (WebSocket — единственный путь
// на прод: Caddy публикует только HTTPS). Без PARVANE_GATEWAY_URL и без
// PARVANE_NATS_URL — прод по WSS, как у веб-клиента.
constexpr auto kDefaultGatewayWss = "wss://parvane.duckdns.org:20443/ws";

QString GatewayUrl() {
	if (const char *v = std::getenv("PARVANE_GATEWAY_URL"); v && *v) {
		const auto url = QString::fromUtf8(v);
#ifndef PARVANE_DEV
		// P-45: в релизе только wss:// — plaintext TCP/ws:// к gateway отдал бы
		// JWT в открытом виде; переменной окружения этого не обойти.
		if (!url.startsWith(u"wss://"_q, Qt::CaseInsensitive)) {
			LOG(("Parvane: PARVANE_GATEWAY_URL без wss:// проигнорирован в релизе: %1").arg(url));
			return QString::fromUtf8(kDefaultGatewayWss);
		}
#endif
		return url;
	}
	if (const char *n = ParvaneDevEnv("PARVANE_NATS_URL"); n && *n) {
		return QString(); // явный прямой NATS (dev-стенд)
	}
	return QString::fromUtf8(kDefaultGatewayWss);
}

namespace {

// E6 (T110): сервер переводит клиентов на v2 (gateway PARVANE_V1_MODE).
//  - upgrade_available (режим notice): нативное сервисное уведомление в чате
//    служебных уведомлений (как T119), один раз за запуск;
//  - upgrade_required (режим disabled): v1 отключён — нативный диалог
//    «обновите приложение», один раз за запуск. Учётные данные в порядке —
//    не разлогиниваем. Транспорт ядра сам не переподключается чаще раза в
//    5 минут; новых соединений в это время не открываем и здесь.
void ShowUpgradeAvailableIfPending() {
	if (!g_upgradeAvailablePending) {
		return;
	}
	const auto session = g_sessionWeak.get();
	if (!session) {
		return; // покажем из AfterSessionReady
	}
	g_upgradeAvailablePending = false;
	const auto history = session->data().history(PeerData::kServiceNotificationsId);
	if (!history->folderKnown()) {
		history->clearFolder(); // иначе requestDialogEntry ушёл бы в MTProto
	}
	session->data().serviceNotification(
		TextWithEntities{ tr::lng_parvane_upgrade_available(tr::now) });
	LOG(("Parvane: сервер сообщает о новой версии (upgrade_available) — сервисное уведомление"));
}

void EnsureUpgradeHandler() {
	static const auto installed = [] {
		parvane::GatewayTransport::setUpgradeHandler([](parvane::GatewayTransport::Upgrade kind) {
			using Upgrade = parvane::GatewayTransport::Upgrade;
			if (kind == Upgrade::Available) {
				static std::atomic<bool> shown{ false };
				if (shown.exchange(true)) {
					return;
				}
				g_upgradeAvailablePending = true;
				crl::on_main([] { ShowUpgradeAvailableIfPending(); });
			} else if (kind == Upgrade::Required) {
				g_upgradeRequiredAtMs = QDateTime::currentMSecsSinceEpoch();
				static std::atomic<bool> shown{ false };
				if (shown.exchange(true)) {
					return;
				}
				if (V2Enabled()) {
					// T134: клиент на v2 без v1 работоспособен — это не «обновите приложение»
					LOG(("Parvane: сервер отключил протокол v1 (upgrade_required) — работаем по v2"));
					return;
				}
				LOG(("Parvane: сервер отключил протокол v1 (upgrade_required) — нужна новая версия приложения"));
				crl::on_main([] {
					Ui::show(Ui::MakeInformBox(tr::lng_parvane_upgrade_required()));
				});
			}
		});
		return true;
	}();
	(void)installed;
}

// v1 отключён сервером, и это подтверждалось недавно — соединений не открываем.
[[nodiscard]] bool UpgradeBlocked() {
	if (!parvane::GatewayTransport::upgradeRequired()) {
		return false;
	}
	const auto at = g_upgradeRequiredAtMs.load();
	return at && (QDateTime::currentMSecsSinceEpoch() - at
		< parvane::GatewayTransport::kUpgradeRetryGapMs);
}

} // namespace

bool UpgradeRequired() {
	return parvane::GatewayTransport::upgradeRequired();
}

// Создать и подключить транспорт по окружению: gateway (TCP, с authenticate,
// если задан token) либо прямой NATS (cnats). Бросает при ошибке соединения.
// token пустой — bootstrap-режим (до логина gateway пускает только issue/register).
std::unique_ptr<parvane::ITransport> MakeV1Transport(const QString &token);

// T134: при включённом v2 транспорт — мост: вход, профили, устройства,
// линковка, превью, ICE и свои/открытые файлы идут методами v2, соединение v1
// нужно только переписке с v1-собеседниками и может отсутствовать (сервер с
// PARVANE_V1_MODE=disabled).
std::unique_ptr<parvane::ITransport> MakeTransport(const QString &token) {
	const auto gw = GatewayUrl();
	if (gw.isEmpty() || !V2Enabled()) {
		return MakeV1Transport(token);
	}
	auto inner = std::unique_ptr<parvane::ITransport>();
	try {
		inner = MakeV1Transport(token);
	} catch (const std::exception &e) {
		if (!UpgradeRequired()) {
			throw;
		}
		static auto logged = false;
		if (!logged) {
			logged = true;
			LOG(("Parvane: соединения v1 нет (%1) — все запросы идут по v2").arg(QString::fromUtf8(e.what())));
		}
	}
	auto cfg = parvane::v2::BridgeConfig();
	cfg.gatewayUrl = gw.toStdString();
	cfg.token = token.toStdString();
	cfg.log = [](const std::string &line) {
		LOG(("Parvane: %1").arg(QString::fromStdString(line)));
	};
	return std::make_unique<parvane::v2::BridgeTransport>(std::move(cfg), std::move(inner));
}

std::unique_ptr<parvane::ITransport> MakeV1Transport(const QString &token) {
	const auto gw = GatewayUrl();
	EnsureUpgradeHandler();
	if (!gw.isEmpty() && UpgradeBlocked()) {
		throw parvane::GatewayError("gateway: upgrade_required");
	}
	if (gw.startsWith(u"wss://"_q) || gw.startsWith(u"ws://"_q)) {
		auto t = std::make_unique<parvane::GatewayWsTransport>();
		t->connectUrl(gw.toStdString());
		if (!token.isEmpty()) {
			t->authenticate(token.toStdString());
		}
		static auto logged = false;
		if (!logged) {
			logged = true;
			LOG(("Parvane: транспорт gateway WebSocket %1").arg(gw));
		}
		return t;
	}
	if (!gw.isEmpty()) {
		auto url = gw;
		if (url.startsWith(u"tcp://"_q)) {
			url = url.mid(6);
		}
		const auto colon = url.lastIndexOf(':');
		const auto host = (colon > 0) ? url.left(colon) : url;
		const auto port = (colon > 0) ? url.mid(colon + 1).toInt() : 9223;
		auto t = std::make_unique<parvane::GatewayTransport>();
		t->connect(host.toStdString(), port > 0 ? port : 9223);
		if (!token.isEmpty()) {
			t->authenticate(token.toStdString());
		}
		return t;
	}
	auto t = std::make_unique<parvane::Transport>();
	t->connect(NatsUrl().toStdString());
	return t;
}

// ── персист курсоров синка (Фаза 1) ─────────────────────────────────────────
// Формат файла: 2 строки — last_seen_id и since_updated. Потеря файла не
// страшна: будет одноразовый полный ресинк (дедуп по UUID).
[[nodiscard]] QString CursorsPath() {
	return cWorkingDir() + u"tdata/parvane-cursors.txt"_q;
}

// Звать ПОД g_sessionMutex (например из StartSession) — сама не лочит.
void LoadCursorsLocked() {
	if (const auto raw = StoreRead(CursorsPath()); !raw.isEmpty()) {
		const auto lines = QString::fromUtf8(raw).split('\n');
		if (lines.size() > 0) {
			g_lastSeenId = lines[0].trimmed().toStdString();
		}
		if (lines.size() > 1) {
			g_sinceUpdated = lines[1].trimmed().toLongLong();
		}
	}
	// Ниже — и без файла курсоров: маркер должен встать на первом же запуске.
	// Один раз на установку — тоже полный: у профилей, заведённых до этой
	// правки, прочитанное/✓✓ до курсора иначе не подтянулись бы без выхода.
	const auto marker = cWorkingDir() + u"tdata/parvane-fullsync-v1"_q;
	const auto firstOnThisBuild = !QFile::exists(marker);
	if (g_freshLogin || firstOnThisBuild) {
		g_freshLogin = false;
		g_sinceUpdated = 0;
		if (firstOnThisBuild) {
			QFile f(marker);
			if (f.open(QIODevice::WriteOnly)) {
				f.write("1");
			}
		}
		LOG(("Parvane: вход — первый sync полный (since_updated=0): "
			"подтянуть прочитанное и мутации до курсора"));
	}
}

// Значения передаются аргументами (зовётся с worker после захвата под локом).
void SaveCursors(const std::string &lastSeen, std::int64_t sinceUpdated) {
	StoreWrite(CursorsPath(), QString::fromStdString(lastSeen).toUtf8() + "\n"
		+ QString::number(sinceUpdated).toUtf8() + "\n");
}

// ── очередь починки нерасшифрованного ───────────────────────────────────────
// Сообщение, не прочитанное этим устройством (нет копии под наш device_id, не
// поднялся E2E), НЕ должно молча уезжать за курсор: после рестарта дельта его
// уже не вернёт. Пока такие есть, дисковый курсор придерживаем — рестарт даёт
// ещё попытку. Но держать его вечно нельзя: копия могла не создаваться вовсе,
// и тогда десктоп пересинхронизировал бы всё при каждом старте. Поэтому у
// каждого uuid счётчик попыток; после kRepairAttempts сдаёмся, пишем в лог и
// пропускаем (историю в этом случае возвращает авто-линковка с другого
// устройства). Формат файла: строки "uuid попытки".
constexpr int kRepairAttempts = 3;

[[nodiscard]] QString PendingPath() {
	return cWorkingDir() + u"tdata/parvane-pending.txt"_q;
}

[[nodiscard]] QHash<QString, int> LoadPending() {
	auto out = QHash<QString, int>();
	const auto lines = QString::fromUtf8(StoreRead(PendingPath())).split('\n', Qt::SkipEmptyParts);
	for (const auto &line : lines) {
		const auto parts = line.trimmed().split(' ');
		if (parts.size() == 2) {
			out.insert(parts[0], parts[1].toInt());
		}
	}
	return out;
}

void SavePending(const QHash<QString, int> &pending) {
	QByteArray data;
	for (auto it = pending.constBegin(); it != pending.constEnd(); ++it) {
		data += it.key().toUtf8() + " " + QString::number(it.value()).toUtf8() + "\n";
	}
	StoreWrite(PendingPath(), data);
}

// Учитывает провалы прохода. Возвращает true, если дисковый курсор двигать
// можно: непрочитанных нет либо все они исчерпали попытки.
[[nodiscard]] bool NotePendingAndMayAdvance(const std::vector<std::string> &failed) {
	if (failed.empty()) {
		// Проход прочитал всё: то, что ждало починки, либо прочиталось на этом
		// круге, либо исчерпало попытки и осталось позади — очередь не нужна.
		if (QFile::exists(PendingPath())) {
			QFile::remove(PendingPath());
		}
		return true;
	}
	auto pending = LoadPending();
	auto mayAdvance = true;
	for (const auto &id : failed) {
		const auto key = QString::fromStdString(id);
		const auto attempts = pending.value(key, 0) + 1;
		pending.insert(key, attempts);
		if (attempts < kRepairAttempts) {
			mayAdvance = false;
		} else {
			LOG(("Parvane: сообщение %1 не прочитано за %2 попытки — пропускаем "
				"(история восстанавливается линковкой с другого устройства)")
				.arg(key).arg(kRepairAttempts));
		}
	}
	SavePending(pending);
	return mayAdvance;
}

// ── READ-1: журнал прочитанного + очередь подтверждения ─────────────────────
[[nodiscard]] QString ReadJournalPath() {
	return cWorkingDir() + u"tdata/parvane-read.txt"_q;
}

// main-поток, ДО воспроизведения журнала истории (AfterSessionReady).
void LoadReadJournal() {
	const auto lines = StoreReadLines(ReadJournalPath());
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	for (const auto &line : lines) {
		g_reportedRead.insert(line);
	}
}

void AppendReadJournal(const std::vector<std::string> &ids) { // worker
	for (const auto &id : ids) {
		StoreAppendLine(ReadJournalPath(), QString::fromStdString(id));
	}
}

[[nodiscard]] bool IsReportedRead(const QString &uuid) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_reportedRead.contains(uuid);
}

void NoteReported(const std::vector<std::string> &ids) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	for (const auto &id : ids) {
		const auto q = QString::fromStdString(id);
		g_reportedRead.insert(q);
		g_unconfirmedRead.insert(q);
	}
}

void ConfirmReads(const std::vector<std::string> &ids) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	for (const auto &id : ids) {
		const auto q = QString::fromStdString(id);
		g_unconfirmedRead.remove(q);
		g_readRetries.remove(q);
	}
}

// Receipt известен серверу (sync/ReadNotice): помним как отчитанный, чтобы не
// слать msg.chat.read повторно, и снимаем ожидание подтверждения.
void NoteConfirmedRead(const std::vector<std::string> &ids) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	for (const auto &id : ids) {
		const auto q = QString::fromStdString(id);
		g_reportedRead.insert(q);
		g_unconfirmedRead.remove(q);
		g_readRetries.remove(q);
	}
}

// Повторить неподтверждённые msg.chat.read (worker): не больше
// kReadRetryPerPass за проход и kReadRetryMax раз на сообщение.
void RetryUnconfirmedReads(
		parvane::MessengerClient *m,
		const std::string &from,
		const std::string &token) {
	auto batch = std::vector<std::string>();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		for (auto it = g_unconfirmedRead.begin();
			it != g_unconfirmedRead.end() && int(batch.size()) < kReadRetryPerPass;) {
			const auto attempts = g_readRetries.value(*it, 0) + 1;
			if (attempts > kReadRetryMax) {
				g_readRetries.remove(*it);
				it = g_unconfirmedRead.erase(it);
				continue;
			}
			g_readRetries.insert(*it, attempts);
			batch.push_back(it->toStdString());
			++it;
		}
	}
	for (const auto &id : batch) {
		try {
			m->markRead(from, id, token);
		} catch (const std::exception &) {
		}
	}
	if (!batch.empty()) {
		LOG(("Parvane: повторно отправлено %1 msg.chat.read без подтверждения")
			.arg(int(batch.size())));
	}
}

// ── уведомления: снимок блоба веба + персист ────────────────────────────────
[[nodiscard]] QString NotifyStatePath() {
	return cWorkingDir() + u"tdata/parvane-notify.json"_q;
}

[[nodiscard]] QString NotifyBlob() { // main
	auto j = nlohmann::json::object();
	j["defaults"] = nlohmann::json::object();
	j["exceptions"] = nlohmann::json::object();
	for (auto it = g_notifyDefaults.constBegin(); it != g_notifyDefaults.constEnd(); ++it) {
		const auto v = nlohmann::json::parse(it.value().toStdString(), nullptr, false);
		if (v.is_object()) j["defaults"][it.key().toStdString()] = v;
	}
	for (auto it = g_notifyExceptions.constBegin(); it != g_notifyExceptions.constEnd(); ++it) {
		const auto v = nlohmann::json::parse(it.value().toStdString(), nullptr, false);
		if (v.is_object()) j["exceptions"][it.key().toStdString()] = v;
	}
	return QString::fromStdString(j.dump());
}

void SaveNotifyState() { // main
	StoreWrite(NotifyStatePath(), NotifyBlob().toUtf8());
}

void LoadNotifyState() { // main
	const auto raw = StoreRead(NotifyStatePath());
	if (raw.isEmpty()) {
		return;
	}
	const auto j = nlohmann::json::parse(raw.toStdString(), nullptr, false);
	if (!j.is_object()) {
		return;
	}
	for (const char *section : { "defaults", "exceptions" }) {
		if (!j.contains(section) || !j[section].is_object()) continue;
		auto &target = (std::string(section) == "defaults") ? g_notifyDefaults : g_notifyExceptions;
		for (auto it = j[section].begin(); it != j[section].end(); ++it) {
			target.insert(QString::fromStdString(it.key()), QString::fromStdString(it.value().dump()));
		}
	}
}

// ── блок-лист: локальный персист (T132) ─────────────────────────────────────
// Блокировка в форке локальная (MTProto contacts.block заглушён) и раньше жила
// только в памяти; теперь список адресов хранится на диске и синхронизируется
// журналом личного состояния (вид `blocked`).
QSet<QString> g_blockedAddrs; // main

[[nodiscard]] QString BlockedStatePath() {
	return cWorkingDir() + u"tdata/parvane-blocked.json"_q;
}

void SaveBlockedState() { // main
	auto a = nlohmann::json::array();
	for (const auto &address : g_blockedAddrs) {
		a.push_back(address.toStdString());
	}
	StoreWrite(BlockedStatePath(), QByteArray::fromStdString(a.dump()));
}

void LoadBlockedState() { // main
	g_blockedAddrs.clear();
	const auto j = nlohmann::json::parse(StoreRead(BlockedStatePath()).toStdString(), nullptr, false);
	if (!j.is_array()) {
		return;
	}
	for (const auto &v : j) {
		if (v.is_string()) {
			g_blockedAddrs.insert(QString::fromStdString(v.get<std::string>()));
		}
	}
}

// ── архив и закреплённые чаты: локальный персист (T132) ────────────────────
// MTProto folders.editPeerFolders / messages.toggleDialogPin заглушены: архив и
// закреп ведём локально (адреса чатов на диске) и синхронизируем журналом
// личного состояния (виды `archived`, `pinned`).
QSet<QString> g_archivedAddrs; // main
QStringList g_pinnedAddrs;     // main: основной список, сверху вниз

[[nodiscard]] QString DialogStatePath() {
	return cWorkingDir() + u"tdata/parvane-dialogs.json"_q;
}

void SaveDialogState() { // main
	auto archived = nlohmann::json::array();
	for (const auto &address : g_archivedAddrs) {
		archived.push_back(address.toStdString());
	}
	auto pinned = nlohmann::json::array();
	for (const auto &address : g_pinnedAddrs) {
		pinned.push_back(address.toStdString());
	}
	const nlohmann::json j{ { "archived", std::move(archived) }, { "pinned", std::move(pinned) } };
	StoreWrite(DialogStatePath(), QByteArray::fromStdString(j.dump()));
}

void LoadDialogState() { // main
	g_archivedAddrs.clear();
	g_pinnedAddrs.clear();
	const auto j = nlohmann::json::parse(StoreRead(DialogStatePath()).toStdString(), nullptr, false);
	if (!j.is_object()) {
		return;
	}
	if (j.contains("archived") && j["archived"].is_array()) {
		for (const auto &v : j["archived"]) {
			if (v.is_string()) {
				g_archivedAddrs.insert(QString::fromStdString(v.get<std::string>()));
			}
		}
	}
	if (j.contains("pinned") && j["pinned"].is_array()) {
		for (const auto &v : j["pinned"]) {
			if (v.is_string()) {
				g_pinnedAddrs.push_back(QString::fromStdString(v.get<std::string>()));
			}
		}
	}
}

// Настройки уведомлений уже в журнале личного состояния (маркер на диске):
// до первого переноса проекция журнала не должна стирать локальные настройки.
[[nodiscard]] QString NotifyJournaledPath() {
	return cWorkingDir() + u"tdata/parvane-notify-journaled"_q;
}

// ── секрет доверия (2FA) ────────────────────────────────────────────────────
// Выдаётся identity ОДИН раз после подтверждённого входа в Telegram; с ним
// доверенное устройство входит по паролю без Telegram. device_id для этого не
// годится — он публичен (каталог прекеев отдаёт его любому).
[[nodiscard]] QString TrustSecretPath(const QString &user) {
	return cWorkingDir() + u"tdata/parvane-trust-"_q + user + u".txt"_q;
}

[[nodiscard]] QString ReadTrustSecret(const QString &user) {
	return QString::fromUtf8(StoreRead(TrustSecretPath(user))).trimmed();
}

void WriteTrustSecret(const QString &user, const QString &secret) {
	if (user.isEmpty() || secret.isEmpty()) {
		return;
	}
	if (StoreWrite(TrustSecretPath(user), secret.toUtf8())) {
		LOG(("Parvane: получен секрет доверия устройства (2FA) для %1").arg(user));
	}
}

// ── персист логин-состояния (self+token) ─────────────────────────────────────
// tdesktop на РЕСТАРТЕ возобновляет кэшированную сессию, минуя экран логина
// (SetSelf не зовётся). Чтобы Parvane-слой поднялся с той же личностью,
// сохраняем self+token и восстанавливаем в AfterSessionReady при пустом self.
[[nodiscard]] QString SessionCredsPath() {
	return cWorkingDir() + u"tdata/parvane-session.txt"_q;
}

void SaveSessionCreds(const QString &address, const QString &token) {
	StoreWrite(SessionCredsPath(), address.toUtf8() + "\n" + token.toUtf8() + "\n");
}

// Восстановить self+token с диска (для рестарта). true — восстановлено.
bool RestoreSessionCreds() {
	const auto raw = StoreRead(SessionCredsPath());
	if (raw.isEmpty()) {
		return false;
	}
	const auto lines = QString::fromUtf8(raw).split('\n');
	if (lines.size() < 2 || lines[0].trimmed().isEmpty()) {
		return false;
	}
	const auto address = lines[0].trimmed();
	const auto token = lines[1].trimmed();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_selfAddress = address;
		g_token = token;
	}
	RegisterPeer(address);
	LOG(("Parvane: логин-состояние восстановлено с диска (%1)").arg(address));
	return true;
}

// ── кэш расшифрованного E2E (uuid → inner JSON) ──────────────────────────────
[[nodiscard]] QString DecCachePath() {
	return cWorkingDir() + u"tdata/parvane-dec-cache.jsonl"_q;
}

// Загрузить кэш. Звать ПОД g_sessionMutex (из StartSession).
void LoadDecCacheLocked() {
	for (const auto &line : StoreReadLines(DecCachePath())) {
		try {
			const auto j = nlohmann::json::parse(line.toStdString());
			const auto id = QString::fromStdString(j.value("id", std::string()));
			if (!id.isEmpty()) {
				g_decCache.insert(id, QString::fromStdString(j.value("inner", std::string())));
			}
		} catch (const std::exception &) {
		}
	}
}

// Прочитать из кэша (пусто — нет). Лочит g_sessionMutex.
[[nodiscard]] QString DecCacheGet(const QString &id) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_decCache.value(id);
}

// Записать расшифрованное (в память + append на диск). Лочит для памяти.
void DecCachePut(const QString &id, const QString &inner) {
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_decCache.insert(id, inner);
	}
	const nlohmann::json j = {{"id", id.toStdString()}, {"inner", inner.toStdString()}};
	StoreAppendLine(DecCachePath(), QString::fromStdString(j.dump()));
}

// Удалить запись (TTL-эфемерка не должна лежать плейнтекстом вечно): память +
// перезапись файла. Лочит g_sessionMutex.
void DecCacheRemove(const QString &id) {
	QHash<QString, QString> snapshot;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (!g_decCache.remove(id)) {
			return;
		}
		snapshot = g_decCache;
	}
	QStringList lines;
	for (auto it = snapshot.cbegin(); it != snapshot.cend(); ++it) {
		const nlohmann::json j = {{"id", it.key().toStdString()},
			{"inner", it.value().toStdString()}};
		lines.push_back(QString::fromStdString(j.dump()));
	}
	StoreWriteLines(DecCachePath(), lines);
}

[[nodiscard]] bool DecCacheEmpty() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_decCache.isEmpty();
}

// Снимок кэша в формате decCache веб-экспорта: uuid → {from, content}.
[[nodiscard]] nlohmann::json DecCacheSnapshot() {
	QHash<QString, QString> snapshot;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		snapshot = g_decCache;
	}
	auto out = nlohmann::json::object();
	for (auto it = snapshot.cbegin(); it != snapshot.cend(); ++it) {
		try {
			auto inner = nlohmann::json::parse(it.value().toStdString());
			if (inner.is_object()) {
				if (inner.contains("sender_identity")) {
					inner["senderIdentity"] = inner["sender_identity"];
					inner.erase("sender_identity");
				}
				out[it.key().toStdString()] = inner;
			}
		} catch (const std::exception &) {
		}
	}
	return out;
}

// Язык интерфейса — русский (пакет Parvane) или нет: для коротких уведомлений,
// которым не заведён ключ lang.strings (новый ключ — пересборка ~100 объектов).
[[nodiscard]] bool IsRussianUi() {
	return tr::lng_parvane_enhanced_privacy(tr::now) != u"Enhanced privacy"_q;
}

void EnsureDefaultLanguage() {
	const char *lf = std::getenv("PARVANE_LANG_FILE");
	if (!lf || !*lf) {
		return;
	}
	const auto path = QString::fromUtf8(lf);
	if (!QFileInfo::exists(path)) {
		LOG(("Parvane: языковой файл не найден: %1").arg(path));
		return;
	}
	// Однократно: маркер в tdata. Дальше язык — выбор пользователя.
	const auto marker = cWorkingDir() + u"tdata/parvane-lang-applied"_q;
	if (QFileInfo::exists(marker)) {
		return;
	}
	Core::App().langpack().switchToCustomFile(path);
	QFile f(marker);
	if (f.open(QIODevice::WriteOnly)) {
		f.write("ru");
	}
	LOG(("Parvane: язык по умолчанию — русский (%1)").arg(path));
}

void LogStartup() {
	// Конструирование parvane::Transport заставляет линкер втянуть cnats.
	parvane::Transport transport;
	LOG(("Parvane: transport linked, NATS target %1 (connected=%2)")
		.arg(NatsUrl())
		.arg(transport.connected() ? 1 : 0));
}

ServerInfo FetchServerInfo() {
	ServerInfo out;
	out.domain = u"local"_q;
	try {
		auto transport = MakeTransport(QString());
		const auto raw = transport->request(parvane::topics::IdentityServerInfo, "{}", 5000);
		const auto resp = nlohmann::json::parse(raw);
		if (resp.contains("domain") && resp["domain"].is_string()) {
			const auto d = resp["domain"].get<std::string>();
			if (!d.empty()) {
				out.domain = QString::fromStdString(d);
			}
		}
		if (resp.contains("confirm") && resp["confirm"].is_string()) {
			out.confirm = QString::fromStdString(resp["confirm"].get<std::string>());
		} else if (resp.value("email_required", false)) {
			out.confirm = u"email"_q;
		}
		if (resp.contains("telegram_bot") && resp["telegram_bot"].is_string()) {
			out.telegramBot = QString::fromStdString(resp["telegram_bot"].get<std::string>());
		}
	} catch (const std::exception &e) {
		LOG(("Parvane: server.info недоступен (%1), домен по умолчанию")
			.arg(QString::fromUtf8(e.what())));
	}
	return out;
}

QString CanonicalAddress(const QString &input, const QString &domain) {
	const auto trimmed = input.trimmed().toLower();
	if (trimmed.isEmpty() || trimmed.contains('@')) {
		return trimmed;
	}
	return trimmed + '@' + domain;
}

IssueResult Issue(
		const QString &user,
		const QString &password,
		const QString &loginToken) {
	IssueResult out;
	try {
		// bootstrap: без токена (gateway пускает issue/register до auth).
		auto transport = MakeTransport(QString());

		parvane::IssueRequest req{user.toStdString(), password.toStdString()};
		// device_id этой установки (тот же каталог, что initDevice ниже) →
		// claim dev в JWT: отозванное устройство теряет токен сразу. Для
		// свежей установки id создаётся здесь же — иначе первый токен без dev.
		// Ключ хранилища (P-13) — ДО чтения device.json: вход со свежего старта
		// процесса шёл раньше первого StoreRead, зашифрованный device.json без
		// ключа не читался, и устройство каждый раз получало НОВЫЙ device_id
		// (в каталоге копились «призраки» с тем же identity-ключом, доверенное
		// устройство 2FA переставало узнаваться).
		EnsureStoreKey();
		req.deviceId = parvane::e2e::ensureDeviceId(
			(cWorkingDir() + u"tdata/parvane-e2e-"_q + user).toStdString());
		auto reqJson = req.toJson();
		if (!loginToken.isEmpty()) {
			// Двухфакторный вход: подтверждённый в Telegram токен входа
			reqJson["login_token"] = loginToken.toStdString();
		}
		if (const auto secret = ReadTrustSecret(user); !secret.isEmpty()) {
			reqJson["trust_secret"] = secret.toStdString(); // доверенное устройство
		}
		const auto raw = transport->request(
			parvane::topics::IdentityIssue,
			reqJson.dump(),
			5000);
		const auto rawJson = parvane::json::parse(raw);
		const auto resp = parvane::IssueResponse::fromJson(rawJson);
		out.ok = resp.ok && resp.token.has_value();
		if (resp.token) {
			out.token = QString::fromStdString(*resp.token);
		}
		if (resp.error) {
			out.error = QString::fromStdString(*resp.error);
		}
		if (rawJson.contains("trust_secret") && rawJson["trust_secret"].is_string()) {
			WriteTrustSecret(user, QString::fromStdString(rawJson["trust_secret"].get<std::string>()));
		}
		if (rawJson.value("twofa_required", false)
			&& rawJson.contains("login_token") && rawJson["login_token"].is_string()) {
			out.twofaRequired = true;
			out.loginToken = QString::fromStdString(rawJson["login_token"].get<std::string>());
			if (rawJson.contains("telegram_bot") && rawJson["telegram_bot"].is_string()) {
				out.telegramBot = QString::fromStdString(rawJson["telegram_bot"].get<std::string>());
			}
		}
		if (!out.ok && out.error.isEmpty()) {
			out.error = u"identity отклонил вход"_q;
		}
	} catch (const std::exception &e) {
		out.ok = false;
		out.error = QString::fromUtf8(e.what());
		LOG(("Parvane: Issue exception: %1").arg(out.error));
	}
	return out;
}

RegisterResult Register(const QString &user, const QString &password,
		const QString &email) {
	RegisterResult out;
	try {
		// bootstrap: как Issue, до auth (identity.user.register разрешён).
		// email — регистрация через почту (PARVANE_EMAIL_REQUIRED на identity):
		// ответ confirm_required → нужен код из письма (identity.email.confirm).
		auto transport = MakeTransport(QString());
		const nlohmann::json req = {
			{"user", user.toStdString()},
			{"password", password.toStdString()},
			{"invite", ""},
			{"email", email.trimmed().toStdString()},
		};
		const auto raw = transport->request(
			parvane::topics::IdentityRegister, req.dump(), 5000);
		const auto resp = nlohmann::json::parse(raw);
		out.ok = resp.value("ok", false);
		out.confirmRequired = resp.value("confirm_required", false);
		if (resp.contains("telegram_token") && resp["telegram_token"].is_string()) {
			out.telegramToken = QString::fromStdString(resp["telegram_token"].get<std::string>());
		}
		if (resp.contains("error") && resp["error"].is_string()) {
			out.error = QString::fromStdString(resp["error"].get<std::string>());
		}
		if (!out.ok && out.error.isEmpty()) {
			out.error = u"identity отклонил регистрацию"_q;
		}
	} catch (const std::exception &e) {
		out.ok = false;
		out.error = QString::fromUtf8(e.what());
		LOG(("Parvane: Register exception: %1").arg(out.error));
	}
	return out;
}

bool RegisterStatus(const QString &user, const QString &token) {
	try {
		auto transport = MakeTransport(QString());
		const nlohmann::json req = {
			{"user", user.toStdString()},
			{"token", token.toStdString()},
		};
		const auto raw = transport->request(parvane::topics::IdentityRegisterStatus, req.dump(), 5000);
		return nlohmann::json::parse(raw).value("confirmed", false);
	} catch (const std::exception &e) {
		LOG(("Parvane: RegisterStatus exception: %1").arg(QString::fromUtf8(e.what())));
		return false;
	}
}

namespace {

TwoFactorState RequestTwoFactor(
		const std::optional<bool> &enabled,
		const QString &password = QString()) {
	TwoFactorState out;
	try {
		auto transport = MakeTransport(Token());
		nlohmann::json req = {{"token", Token().toStdString()}};
		if (enabled) {
			req["enabled"] = *enabled;
		}
		// P-07: выключение 2FA — только с паролем.
		if (!password.isEmpty()) {
			req["password"] = password.toStdString();
		}
		const auto raw = transport->request(parvane::topics::IdentityTwoFa, req.dump(), 5000);
		const auto resp = nlohmann::json::parse(raw);
		out.ok = resp.value("ok", false);
		out.enabled = resp.value("enabled", false);
		out.telegramLinked = resp.value("telegram_linked", false);
		if (resp.contains("trust_secret") && resp["trust_secret"].is_string()) {
			// Устройство, включившее 2FA, доверенное сразу — иначе при следующем
			// старте оно само попросило бы подтверждение в Telegram
			WriteTrustSecret(SelfAddress(), QString::fromStdString(resp["trust_secret"].get<std::string>()));
		}
		if (resp.contains("error") && resp["error"].is_string()) {
			out.error = QString::fromStdString(resp["error"].get<std::string>());
		}
	} catch (const std::exception &e) {
		out.error = QString::fromUtf8(e.what());
		LOG(("Parvane: twofa exception: %1").arg(out.error));
	}
	return out;
}

} // namespace

TwoFactorState FetchTwoFactor() {
	return RequestTwoFactor(std::nullopt);
}

TwoFactorState SetTwoFactor(bool enabled, const QString &password) {
	return RequestTwoFactor(enabled, password);
}

ConfirmResult ConfirmEmail(const QString &user, const QString &code) {
	ConfirmResult out;
	try {
		auto transport = MakeTransport(QString());
		const nlohmann::json req = {
			{"user", user.toStdString()},
			{"code", code.trimmed().toStdString()},
		};
		const auto raw = transport->request(
			parvane::topics::IdentityEmailConfirm, req.dump(), 5000);
		const auto resp = nlohmann::json::parse(raw);
		out.ok = resp.value("ok", false);
		if (resp.contains("error") && resp["error"].is_string()) {
			out.error = QString::fromStdString(resp["error"].get<std::string>());
		}
		if (!out.ok && out.error.isEmpty()) {
			out.error = u"identity отклонил код"_q;
		}
	} catch (const std::exception &e) {
		out.ok = false;
		out.error = QString::fromUtf8(e.what());
		LOG(("Parvane: ConfirmEmail exception: %1").arg(out.error));
	}
	return out;
}

void SetToken(const QString &token) {
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_token = token;
	}
	std::lock_guard<std::mutex> lk(g_v2Mutex);
	g_v2Token = token.toStdString(); // v2-сессия берёт JWT при переподключении
}

QString Token() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_token;
}

// ── identity/peer ────────────────────────────────────────────────────────────
namespace {

// Группа v1, переведённая в v2 (T180): прежний group_id ↔ адрес группы v2. Чат в
// UI остаётся прежним — id считается от прежнего адреса, история v1 лежит в нём;
// всё новое (отправка, сведения, журнал) идёт по адресу v2.
std::mutex g_migratedMutex;
QHash<QString, QString> g_migratedTo;   // group_id v1 → v2g:…
QHash<QString, QString> g_migratedFrom; // v2g:… → group_id v1

[[nodiscard]] QString CanonicalGroup(const QString &address) {
	std::lock_guard<std::mutex> lk(g_migratedMutex);
	const auto it = g_migratedTo.constFind(address);
	return (it != g_migratedTo.constEnd()) ? it.value() : address;
}

[[nodiscard]] bool IsMigratedGroup(const QString &address) {
	std::lock_guard<std::mutex> lk(g_migratedMutex);
	return g_migratedTo.contains(address);
}

// true — связь новая (чат прежней группы надо перевести на адрес v2).
bool NoteGroupMigrated(const QString &from, const QString &to) {
	if (from.isEmpty() || to.isEmpty()) {
		return false;
	}
	std::lock_guard<std::mutex> lk(g_migratedMutex);
	if (g_migratedTo.value(from) == to) {
		return false;
	}
	g_migratedTo.insert(from, to);
	g_migratedFrom.insert(to, from);
	return true;
}

} // namespace

std::uint64_t IdForAddress(const QString &rawAddress) {
	auto address = rawAddress;
	{
		std::lock_guard<std::mutex> lk(g_migratedMutex);
		if (const auto it = g_migratedFrom.constFind(rawAddress); it != g_migratedFrom.constEnd()) {
			address = it.value(); // группа v2, переведённая из v1, — прежний чат
		}
	}
	const auto utf8 = address.toUtf8();
	std::uint64_t h = 1469598103934665603ULL; // FNV offset basis
	for (const auto c : utf8) {
		h ^= static_cast<unsigned char>(c);
		h *= 1099511628211ULL; // FNV prime
	}
	h &= ((std::uint64_t(1) << 48) - 1); // в безопасный диапазон id
	return h ? h : 1;
}

namespace {
// Определена ниже в анонимном пространстве (приём presence.<id>).
void HandlePresencePayload(const std::string &payload);
} // namespace

// P-18: подписка на presence конкретного собеседника (идемпотентно). Зовётся
// при регистрации пира и для всех известных пиров при старте сессии.
void EnsurePresenceSubscription(const QString &address) {
	if (address.isEmpty() || address == SelfAddress()) {
		return;
	}
	// L2-1: в чате с усиленной приватностью присутствие собеседника не
	// запрашиваем (подписка появится, когда режим снимут, — событие l2State).
	if (L2Active(address)) {
		return;
	}
	parvane::ITransport *t = nullptr;
	const auto id = quint64(IdForAddress(address));
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (!g_presenceSubscribed || g_presenceSubscribedIds.contains(id)) {
			return;
		}
		t = g_transport.get();
		if (!t) {
			return;
		}
		g_presenceSubscribedIds.insert(id);
	}
	t->subscribe(parvane::topics::presence(std::to_string(id)),
		[](std::string, std::string payload) { HandlePresencePayload(payload); });
	// Канал присутствия v2 этого собеседника (T134) — на воркере: методы сессии
	// ждут мьютекс движка.
	crl::async([peer = address.toStdString()] {
		if (const auto s = V2ReadyForSend()) {
			s->watchPeers({ peer });
		}
	});
}

void RegisterPeer(const QString &address) {
	if (address.isEmpty()) {
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_idToAddress.insert(quint64(IdForAddress(address)), address);
	}
	EnsurePresenceSubscription(address);
}

QString AddressForId(std::uint64_t userId) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_idToAddress.value(quint64(userId));
}

QString ProfileLink(const QString &address) {
	const auto at = address.indexOf('@');
	if (at <= 0 || at + 1 >= address.size()) {
		return QString();
	}
	const auto nick = address.left(at);
	const auto domain = address.mid(at + 1);
	return u"https://"_q + domain + u"/#@"_q + nick;
}

// ── сессия ───────────────────────────────────────────────────────────────────
void SetSelf(const QString &address, const QString &token) {
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_selfAddress = address;
		g_token = token;
		g_freshLogin = true; // см. LoadCursorsLocked
	}
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		g_v2Token = token.toStdString();
	}
	RegisterPeer(address);
	SaveSessionCreds(address, token); // пережить рестарт (tdesktop минует логин)
}

QString SelfAddress() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_selfAddress;
}

bool SessionActive() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_messenger != nullptr;
}

// Путь к приватному ключу подписи звонков (per-instance, в рабочем каталоге).
[[nodiscard]] QString CallKeyPath() {
	return cWorkingDir() + u"tdata/parvane-callkey.txt"_q;
}

// Человекочитаемое имя состояния звонка (для логов).
[[nodiscard]] const char *CallStateName(parvane::CallState s) {
	switch (s) {
	case parvane::CallState::Idle: return "Idle";
	case parvane::CallState::Outgoing: return "Outgoing";
	case parvane::CallState::Incoming: return "Incoming";
	case parvane::CallState::Connecting: return "Connecting";
	case parvane::CallState::Active: return "Active";
	case parvane::CallState::Ended: return "Ended";
	}
	return "?";
}

// identity не принял наш ключ звонков: на аккаунте уже ключ другого устройства,
// а замена — только с паролем (P-07), которого у запущенной сессии нет. Такое
// устройство подписывает сигналы звонка signing-ключом устройства из каталога
// prekeys (как веб) — собеседник находит его среди ключей устройств контакта.
std::atomic<bool> g_callKeyForeign{ false };

// Подпись данных звонка для CallManager/GroupCallManager: "" → подпишет ключ
// звонков (обычный путь первого устройства).
[[nodiscard]] std::string SignCallData(const std::string &data) {
	return g_callKeyForeign.load() ? parvane::e2e::sign(data) : std::string();
}

// Публикует наш публичный ключ звонков в каталоге identity (identity.user.setkey),
// чтобы собеседник мог проверять подпись SDP. Неблокирующая (worker). Значения
// передаются аргументами (НЕ лочим g_sessionMutex: зовётся из StartSession,
// который его уже держит — иначе дедлок).
void RegisterCallKey(const QString &pub, const QString &token) {
	g_callKeyForeign = false;
	if (pub.isEmpty() || token.isEmpty()) {
		return;
	}
	const auto req = parvane::json{
		{ "token", token.toStdString() },
		{ "pubkey", pub.toStdString() } }.dump();
	crl::async([req, pub] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		try {
			const auto raw = t->request(parvane::topics::IdentitySetKey, req, 3000);
			const auto resp = parvane::json::parse(raw, nullptr, false);
			if (resp.is_object() && resp.value("ok", false)) {
				LOG(("Parvane: зарегистрирован ключ звонков %1…")
					.arg(pub.left(12)));
			} else if (resp.is_object()) {
				// Отказ по существу (не сбой сети): ключ аккаунта принадлежит
				// другому устройству.
				g_callKeyForeign = true;
				LOG(("Parvane: ключ звонков не принят identity (на аккаунте ключ "
					"другого устройства) — сигналы звонка подписывает ключ устройства"));
			}
		} catch (const std::exception &) {
		}
	});
}

// E2E (Фаза 2): создать Olm-аккаунт и опубликовать prekeys. На воркере (сетевой
// request), берёт транспорт/токен под локом и отпускает — НЕ звать под
// g_sessionMutex напрямую (initDevice блокирующий).
void StartHistoryLinking();
void StartDeviceLinkOfferForV2();

void InitE2E() {
	crl::async([] {
		parvane::ITransport *t = nullptr;
		std::string self, token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			self = g_selfAddress.toStdString();
			token = g_token.toStdString();
		}
		if (t && !token.empty()) {
			// Персист E2E — per-self каталог в рабочем каталоге инстанса.
			const auto dir = (cWorkingDir() + u"tdata/parvane-e2e-"_q
				+ QString::fromStdString(self)).toStdString();
			parvane::e2e::initDevice(*t, self, token, dir);
			LOG(("Parvane: E2E-устройство готово (prekeys опубликованы, персист)"));
			LOG(("Parvane: свой ключ безопасности (отпечаток): %1")
				.arg(QString::fromStdString(parvane::e2e::ownFingerprint())));
			StartHistoryLinking();
		}
	});
}

bool StartSession() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	if (g_messenger) {
		return true; // идемпотентно
	}
	try {
		// Лимит частоты gateway (безадресный err rate_limited на publish): как
		// в вебе — предупреждение пользователю, не чаще раза в 5 с.
		static const auto reconnectHandlerInstalled = [] {
			parvane::GatewayTransport::setReconnectHandler(
				[](bool ok, const std::string &error) {
					if (ok) {
						LOG(("Parvane: gateway переподключён (auth + подписки восстановлены)"));
						// Карты геолокации, не собранные без связи, — повторить сразу
						crl::on_main([] { RetryFailedLocationMaps(); });
					} else {
						LOG(("Parvane: gateway переподключение не удалось: %1")
							.arg(QString::fromStdString(error)));
					}
				});
			return true;
		}();
		(void)reconnectHandlerInstalled;
		static const auto rateLimitHandlerInstalled = [] {
			parvane::GatewayTransport::setUnaddressedErrorHandler(
				[](const std::string &error, const std::string &subject) {
					if (error.rfind("rate_limited", 0) != 0) {
						return;
					}
					static std::atomic<qint64> last{0};
					const auto now = QDateTime::currentMSecsSinceEpoch();
					if (now - last.load() < 5000) {
						return;
					}
					last = now;
					LOG(("Parvane: gateway rate_limited (%1) — слишком много действий")
						.arg(QString::fromStdString(subject)));
					crl::on_main([] {
						if (const auto window = Core::App().activeWindow()) {
							window->showToast(u"Слишком много действий, помедленнее."_q);
						}
					});
				});
			return true;
		}();
		(void)rateLimitHandlerInstalled;
		// Транспорт по окружению: gateway (PARVANE_GATEWAY_URL, auth по JWT)
		// либо прямой NATS (dev). Токен уже установлен (SetSelf до StartSession).
		auto transport = MakeTransport(g_token);
		auto messenger = std::make_unique<parvane::MessengerClient>(*transport);
		g_transport = std::move(transport);
		g_messenger = std::move(messenger);
		EnsureStoreKey();     // P-13: ключ шифрования tdata/parvane-* до чтения файлов
		LoadCursorsLocked();  // курсоры инкрементального синка (Фаза 1)
		LoadDecCacheLocked(); // кэш расшифрованного E2E (пережить рестарт/пере-синк)
		LoadClearedLocked();  // скрытые «для меня» сообщения (удалённые чаты)

		const auto self = g_selfAddress.toStdString();
		// Очистка с другого устройства этого же пользователя → убрать локально.
		g_messenger->onCleared(self, [](std::vector<std::string> ids) {
			auto set = QSet<QString>();
			for (const auto &id : ids) {
				set.insert(QString::fromStdString(id));
			}
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_clearedUuids.unite(set);
			}
			AppendCleared(QStringList(set.begin(), set.end()));
			crl::on_main([set] {
				if (const auto session = g_sessionWeak.get()) {
					ForgetClearedOnMain(session, set);
				}
			});
		});
		// Прочтение с другого своего устройства → снять непрочитанное здесь.
		g_messenger->onReadNotice(self, [](std::vector<std::string> ids) {
			ConfirmReads(ids); // READ-1: сервер подтвердил наши msg.chat.read
			auto set = QSet<QString>();
			for (const auto &id : ids) {
				set.insert(QString::fromStdString(id));
			}
			crl::on_main([set] {
				if (const auto session = g_sessionWeak.get()) {
					MarkUuidsReadLocal(session, set);
				}
			});
		});
		// Настройки уведомлений с другого устройства (NotifyNotice в инбоксе).
		g_messenger->onNotifyNotice(self, [](std::string json) {
			crl::on_main([json] { ApplyNotifyBlob(QString::fromStdString(json)); });
		});
		// Изменение группы (spec 003, GROUP-1): сведения применяются по ревизии,
		// removed/deleted снимают чат, остальное — перечитать список.
		g_messenger->onGroupNotice(self, [](parvane::GroupNotice n) {
			crl::on_main([n = std::move(n)] {
				const auto session = g_sessionWeak.get();
				if (!session) {
					return;
				}
				const auto gid = QString::fromStdString(n.group_id);
				if (parvane::v2::isGroupAddress(n.group_id)) {
					// Группа v2 — только журнал: v1-нотис не меняет и не снимает её
					LOG(("Parvane: v1-нотис о группе v2 %1 (%2) отброшен")
						.arg(gid, QString::fromStdString(n.change)));
					return;
				}
				if (n.change == "removed" || n.change == "deleted") {
					DropGroupLocally(session, gid, QString::fromStdString(n.change));
					return;
				}
				if (n.info) {
					ApplyGroupInfo(session, *n.info, u"нотис"_q);
					return;
				}
				LOG(("Parvane: нотис группы %1 (%2, v%3) → перечитываем список")
					.arg(gid, QString::fromStdString(n.change)).arg(n.version));
				// spec 004: открытый экран «Invite Links» перечитывает список по
				// нотису invites (Api::InviteLinks::requestMyLinks → врезка → group.invite.list)
				if (n.change == "invites") {
					if (const auto chat = session->data().chatLoaded(ChatId(BareId(IdForAddress(gid))))) {
						session->api().inviteLinks().requestMyLinks(chat);
					}
				}
				RefreshGroups();
			});
		});
		// delivered (после ack получателя) → пинок синка: обновит ✓-статусы.
		g_messenger->onDelivered(self, [](std::string id) {
			LOG(("Parvane: delivered %1 → pump").arg(QString::fromStdString(id)));
			PumpReceive();
		});
		// Входящее сообщение (InboxPush) → мгновенная вставка + ack (Фаза 1).
		// НЕ лочить g_sessionMutex на потоке доставки (close() джойнит его под
		// этим мьютексом — дедлок) → уходим на worker.
		g_messenger->onInbox(self, [](parvane::StoredMessage sm) {
			// Расшифровка+верификация на воркере, вставка на main; ack (снятие из
			// очереди + delivered) делает injectOnMain — там уже известен
			// реальный отправитель (sealed).
			crl::async([sm = std::move(sm)]() mutable {
				std::vector<parvane::StoredMessage> batch;
				batch.push_back(std::move(sm));
				// Живой пуш курсоры не двигает, поэтому результат не нужен:
				// не прочитанное сейчас придёт следующим sync.
				(void)prepareIncoming(batch, /*live=*/true);
				if (batch.empty()) {
					return;
				}
				crl::on_main([batch = std::move(batch)]() mutable {
					if (const auto session = g_sessionWeak.get()) {
						injectOnMain(session, batch);
					}
				});
			});
		});

		// ── Звонки: ключ подписи + сигналинг + менеджер ──
		g_callKey = std::make_unique<parvane::crypto::SigningKey>(
			parvane::crypto::SigningKey::loadOrCreate(CallKeyPath().toStdString()));
		g_callClient = std::make_unique<parvane::CallClient>(*g_transport);
		g_groupClient = std::make_unique<parvane::GroupClient>(*g_transport);
		parvane::CallManager::Callbacks ccb;
		// Публичный ключ собеседника из кэша (заполняется при resolve). Зовётся
		// из потока cnats — под g_pubkeyMutex.
		ccb.peerPubkey = [](std::string peer) -> std::string {
			std::lock_guard<std::mutex> lk(g_pubkeyMutex);
			return g_peerPubkeys.value(QString::fromStdString(peer)).toStdString();
		};
		// Ключи всех устройств собеседника: identity хранит один pubkey на
		// пользователя, звонок с другого устройства иначе отвергался
		ccb.peerPubkeys = [](std::string peer) {
			return parvane::e2e::contactSigningKeys(peer);
		};
		ccb.sign = SignCallData;
		// Протокол v2 (D-08): собеседнику с журналом устройств v2 сигнал личного
		// звонка уходит запечатанным конвертом по анонимному каналу — сервер не
		// видит ни сторон, ни SDP; false — v1-путём шарда call.
		ccb.sendV2 = [](const std::string &peer, const parvane::json &signal) {
			const auto s = V2Ready();
			auto error = std::string();
			if (!s || !s->sendCallSignal(peer, signal, std::string(), &error)) {
				return false;
			}
			if (!error.empty() && signal.value("type", std::string()) == "invite") {
				// Вызов по v2 не ушёл: не висеть «звоним», сказать причину (T148).
				// Менеджер держит свой мьютекс — отбой с главного потока.
				LOG(("Parvane: звонок %1 не начат (%2)").arg(
					QString::fromStdString(peer), QString::fromStdString(error)));
				crl::on_main([notContact = (error == "forbidden")] {
					HangupCall();
					if (const auto window = Core::App().activeWindow()) {
						const auto ru = IsRussianUi();
						window->showToast(notContact
							? (ru
								? u"Позвонить можно после того, как собеседник ответит на ваше сообщение"_q
								: u"You can call this person after they reply to your message"_q)
							: (ru
								? u"Не удалось позвонить. Попробуйте позже"_q
								: u"The call could not be placed. Try again later"_q));
					}
				});
				return true;
			}
			LOG(("Parvane: v2 → %1 сигнал звонка (%2)").arg(
				QString::fromStdString(peer),
				QString::fromStdString(signal.value("type", std::string()))));
			return true;
		};
		// LEGACY-1: у собеседника на v2 есть v1-устройства — сигнал дублируется
		// им v1-путём шарда call (иначе звонок на них не приходит)
		ccb.hasLegacyDevices = [](const std::string &peer) {
			const auto s = V2Ready();
			return s && !s->legacyDevices(peer).empty();
		};
		// Входящий звонок (прошёл аутентификацию). Пока — лог + опц. авто-приём
		// (headless e2e). UI-панель — Э4-b2. НЕ звать accept() синхронно (дедлок
		// мьютекса менеджера) — откладываем на main.
		ccb.onIncoming = [](std::string peer, std::string media) {
			LOG(("Parvane: ВХОДЯЩИЙ звонок от %1 (%2)")
				.arg(QString::fromStdString(peer), QString::fromStdString(media)));
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_currentCallPeer = QString::fromStdString(peer);
				g_currentCallVideo = (media == "video");
			}
			// Заблокированный пир: авто-отклонение без звонка/UI (как web calls.ts).
			{
				const auto peerQ = QString::fromStdString(peer);
				crl::on_main([peerQ] {
					const auto session = g_sessionWeak.get();
					if (!session) {
						return;
					}
					const auto u = session->data().userLoaded(
						UserId(BareId(IdForAddress(peerQ))));
					// «Звонки — никто» (FR-040, T137): как от заблокированного.
					const auto nobody = g_privacyCallsNobody.load();
					if ((u && u->isBlocked()) || nobody) {
						LOG((nobody
							? "Parvane: входящий звонок от %1 — отклонён (звонки: никто)"
							: "Parvane: входящий звонок от заблокированного %1 — отклонён")
							.arg(peerQ));
						StopRingtone();
						Parvane::CloseNativeCallPanel();
						if (g_callManager) {
							g_callManager->hangup();
						}
					}
				});
			}
			// Авто-приём (e2e) без UI.
			if (const char *aa = ParvaneDevEnv("PARVANE_AUTOACCEPT"); aa && *aa) {
				crl::on_main([] { if (g_callManager) g_callManager->accept(); });
				return;
			}
			// UI: рингтон + НАТИВНЫЙ экран входящего звонка (кнопки Ответить/Отклонить).
			const auto peerQ = QString::fromStdString(peer);
			const auto isVideo = (media == "video");
			crl::on_main([peerQ, isVideo] {
				PlayRingtone(/*outgoing=*/false);
				if (const auto session = g_sessionWeak.get()) {
					const auto p = session->data().user(
						UserId(BareId(IdForAddress(peerQ))));
					Parvane::OpenNativeCallPanel(p, isVideo, /*incoming=*/true);
				}
			});
		};
		ccb.onState = [](parvane::CallState s) {
			LOG(("Parvane: звонок → %1").arg(CallStateName(s)));
			// UI активного звонка: окно с таймером/mute/hangup + видео (peer из
			// g_currentCallPeer — НЕ g_callManager->peer(): его мьютекс держится в
			// onState → дедлок). OpenCallWindow идемпотентно.
			QString peer;
			bool video = false;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				peer = g_currentCallPeer;
				video = g_currentCallVideo;
			}
			const auto peerStd = peer.toStdString();
			crl::on_main([s, peerStd, video] {
				// Рингтон: дозвон (Outgoing) — ringback; глохнет на Active/Ended.
				if (s == parvane::CallState::Outgoing) {
					PlayRingtone(/*outgoing=*/true);
				} else if (s == parvane::CallState::Active
						|| s == parvane::CallState::Ended) {
					StopRingtone();
				}
				const auto inCall = (s == parvane::CallState::Outgoing
					|| s == parvane::CallState::Connecting
					|| s == parvane::CallState::Active);
				if (inCall) {
					// Нативный экран звонка: пир уже синтезирован при старте звонка
					// (ResolveNames), берём его как PeerData (аватар/имя).
					if (const auto session = g_sessionWeak.get()) {
						const auto addr = QString::fromStdString(peerStd);
						const auto peer = session->data().user(
							UserId(BareId(IdForAddress(addr))));
						Parvane::OpenNativeCallPanel(peer, video);
					}
					if (s == parvane::CallState::Active) {
						Parvane::NativeCallConnected();
					}
				} else if (s == parvane::CallState::Ended) {
					Parvane::CloseNativeCallPanel();
				}
			});
		};
		g_callManager = std::make_unique<parvane::CallManager>(
			*g_callClient, g_selfAddress.toStdString(), g_token.toStdString(),
			g_callKey.get(),
			[] {
				// PARVANE_REAL_MEDIA=1 → реальный webrtc-звук; иначе заглушка
				// (для e2e сигналинга без звука). Если webrtc не поднялся —
				// откат на заглушку.
				if (const char *rm = std::getenv("PARVANE_REAL_MEDIA");
						rm && *rm) {
					if (auto w = Parvane::MakeWebrtcBackend()) {
						LOG(("Parvane: медиа-движок = webrtc (реальный звук)"));
						return w;
					}
					LOG(("Parvane: webrtc недоступен → заглушка"));
				}
				return std::unique_ptr<parvane::MediaBackend>(
					std::make_unique<parvane::StubMediaBackend>());
			},
			std::move(ccb));
		g_callManager->start();

		// Групповые звонки (mesh). Тот же движок-фабрика (webrtc/заглушка) + кэш
		// pubkey. onPeerState — лог (UI-бокс — в StartGroupCall).
		const auto makeBackend = [] {
			if (const char *rm = std::getenv("PARVANE_REAL_MEDIA"); rm && *rm) {
				if (auto w = Parvane::MakeWebrtcBackend()) {
					return w;
				}
			}
			return std::unique_ptr<parvane::MediaBackend>(
				std::make_unique<parvane::StubMediaBackend>());
		};
		parvane::GroupCallManager::Callbacks gcb;
		gcb.peerPubkey = [](std::string peer) -> std::string {
			std::lock_guard<std::mutex> lk(g_pubkeyMutex);
			return g_peerPubkeys.value(QString::fromStdString(peer)).toStdString();
		};
		// Ключи всех устройств собеседника: identity хранит один pubkey на
		// пользователя, звонок с другого устройства иначе отвергался
		gcb.peerPubkeys = [](std::string peer) {
			return parvane::e2e::contactSigningKeys(peer);
		};
		gcb.sign = SignCallData;
		// Протокол v2 (T141, FR-062): приглашение в групповой звонок и попарные
		// сигналы mesh — запечатанными конвертами участникам с известным ключом
		// доступа; остальным — инбоксом gcall: шарда call.
		gcb.sendV2 = [](const std::string &peer, const parvane::json &signal, const std::string &groupCallId) {
			const auto s = V2Ready();
			if (!s || !s->sendCallSignal(peer, signal, groupCallId)) {
				return false;
			}
			LOG(("Parvane: v2 → %1 сигнал группового звонка (%2)").arg(
				QString::fromStdString(peer),
				QString::fromStdString(signal.value("type", std::string()))));
			return true;
		};
		gcb.onPeerState = [](std::string peer, parvane::CallState s) {
			LOG(("Parvane: groupcall %1 → %2")
				.arg(QString::fromStdString(peer)).arg(CallStateName(s)));
		};
		g_groupCallManager = std::make_unique<parvane::GroupCallManager>(
			*g_callClient, g_selfAddress.toStdString(), g_token.toStdString(),
			g_callKey.get(), makeBackend, std::move(gcb));
		g_groupCallManager->start();

		RegisterCallKey(QString::fromStdString(g_callKey->publicB64()), g_token);
		// ICE-серверы — заранее: входящий вызов создаёт движок на потоке чтения
		// транспорта, оттуда запрос к шарду делать нельзя (см. PrefetchIceServers).
		PrefetchIceServers();
		InitE2E(); // E2E: аккаунт + публикация prekeys (Фаза 2), на воркере
		StartV2Locked(); // протокол v2 (двойной стек), если включён

		LOG(("Parvane: сессия поднята для %1").arg(g_selfAddress));
		return true;
	} catch (const std::exception &e) {
		const auto what = QString::fromUtf8(e.what());
		LOG(("Parvane: StartSession не удался: %1").arg(what));
		if (what.contains(u"отказ авторизации"_q)) {
			OnAuthRejected(what);
		}
		return false;
	}
}

// Сервер отверг наш JWT: истёк (срок 24 ч) либо устройство отозвано.
// Раньше клиент МОЛЧАЛ: ловил ошибку в лог и дальше показывал журнал с диска —
// пользователь видел «мессенджер, который отстаёт», не понимая, что он вообще
// не в сети (8 сен 2026 — так выглядели все жалобы «не синхронизируется»).
// Теперь снимаем учётные данные (иначе рестарт зациклится на том же токене) и
// показываем экран входа. Ключи и история остаются — повторный вход вернёт их.
std::atomic<bool> g_authRejectHandling{ false };
void OnAuthRejected(const QString &reason) {
	if (g_authRejectHandling.exchange(true)) {
		return;
	}
	LOG(("Parvane: авторизация отклонена (%1) — на экран входа; ключи и история "
		"сохранены").arg(reason));
	crl::on_main([] {
		ClearLocalState();
		if (const auto session = g_sessionWeak.get()) {
			session->account().forcedLogOut();
		}
		g_authRejectHandling = false;
	});
}

void StopSession() {
	ResetLocationMaps(); // склейки карт и кэш тайлов — на сессию
	StopV2(); // до g_sessionMutex: рабочий поток v2 берёт его в обработчиках
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	g_messenger.reset();
	g_transport.reset();
}

BusSnapshot SnapshotBus() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return BusSnapshot{
		.transport = g_transport.get(),
		.self = g_selfAddress.toStdString(),
		.token = g_token.toStdString(),
	};
}

Main::Session *ActiveMainSession() {
	return g_sessionWeak.get();
}

// Выход из аккаунта. Снимаем ТОЛЬКО учётные данные сессии (адрес + JWT):
// после этого нужен повторный ввод пароля, но повторный вход на ТОМ ЖЕ
// устройстве возвращает всю переписку.
//
// ПОЧЕМУ НЕ СНОСИМ КЛЮЧИ. История у нас сквозным шифрованием: на сервере лежит
// только шифртекст, читаемый исключительно ключами устройства. Ручного
// экспорта ключей на десктопе НЕТ (в ядре есть exportStateJson, но подключён
// он только к авто-линковке, а ей нужно ВТОРОЕ живое устройство). Значит для
// человека, у которого стоит один десктоп, снос ключей = безвозвратная потеря
// всей переписки, причём по нажатию кнопки, от которой такого никто не ждёт.
// Поэтому «выйти» ≠ «стереть устройство». Полное стирание — отдельное явное
// действие (и его стоит давать только вместе с экспортом ключей).
void ClearLocalState() {
	StopSession();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_token.clear();
		g_selfAddress.clear();
		g_lastSeenId.clear();
		g_sinceUpdated = 0;
		g_ownSentUuids.clear();
	}
	// Только учётные данные. Ключи E2E, журнал истории, кэш расшифровки,
	// курсоры и папки остаются — иначе повторный вход показал бы пустоту.
	const auto creds = cWorkingDir() + u"tdata/parvane-session.txt"_q;
	const auto removed = QFile::remove(creds);
	LOG(("Parvane: выход — учётные данные %1; ключи и история СОХРАНЕНЫ "
		"(повторный вход на этом устройстве вернёт переписку)")
		.arg(removed ? u"удалены"_q : u"не найдены"_q));
}

void MirrorOutgoing(
		PeerData *peer,
		const TextWithEntities &textWithEntities,
		std::int64_t replyToMsgId) {
	const auto &text = textWithEntities.text;
	if (!peer || text.isEmpty()) {
		return;
	}
	// Адрес получателя: 1-на-1 — адрес юзера; группа — group_id по chatId.
	QString address;
	if (peer->isChat()) {
		const auto chatBare = std::uint64_t(peerToChat(peer->id).bare);
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		address = g_chatIdToGroupId.value(chatBare);
	} else if (peer->isUser()) {
		const auto bare = std::uint64_t(peerToUser(peer->id).bare);
		address = AddressForId(bare);
	}
	if (address.isEmpty()) {
		LOG(("Parvane: исходящее не зеркалится — адрес пира неизвестен"));
		return;
	}
	// Ответ: uuid цитируемого сообщения по обратной карте (если известно).
	auto replyToUuid = std::optional<std::string>();
	if (replyToMsgId != 0) {
		const auto it = g_msgIdToUuid.find(replyToMsgId);
		if (it != g_msgIdToUuid.end()) {
			replyToUuid = it.value().toStdString();
		}
	}
	// Пред-генерируем id (uuid7) на main и кладём в очередь — finalize-хук
	// свяжет его с локальным эхом (msgId↔uuid) для delete/edit/read СВОИХ.
	const auto preId = parvane::newUuidV7();
	g_pendingOwnUuids.enqueue(QString::fromStdString(preId));
	auto entitiesJson = entitiesToJson(textWithEntities.entities);
	// @упоминания: авто-детект @user@server → mention-entities (поверх форматирования).
	auto mentionCount = 0;
	for (auto &me : detectMentions(text)) {
		entitiesJson.push_back(std::move(me));
		++mentionCount;
	}
	if (mentionCount > 0) {
		// Журнал на диске зашифрован (P-13) — e2e сверяет round-trip по логу.
		LOG(("Parvane: исходящее msg %1: mention-entity ×%2")
			.arg(QString::fromStdString(preId)).arg(mentionCount));
	}
	const auto url = firstUrlInText(text);
	if (url.isEmpty()) {
		sendTextAsync(address, text, entitiesJson, preId, replyToUuid);
		return;
	}
	// Есть ссылка — тянем OG-превью и отправляем ПОСЛЕ (или без превью по ошибке/
	// таймауту). preId уже в очереди, так что локальное эхо свяжется корректно.
	const auto textCopy = text;
	fetchWebpage(url, [=](nlohmann::json wp) {
		sendTextAsync(address, textCopy, entitiesJson, preId, replyToUuid, wp);
	});
}

void ForwardPollCopy(const QString &toAddress, const QString &contentJson);

void ForwardMediaReshared(const QString &toAddress, const QString &contentJson, int attempt = 0);

void MirrorForward(PeerData *toPeer, not_null<HistoryItem*> item) {
	if (!toPeer || !toPeer->isUser()) {
		return;
	}
	const auto bare = std::uint64_t(peerToUser(toPeer->id).bare);
	const auto address = AddressForId(bare);
	if (address.isEmpty()) {
		return;
	}
	const auto found = g_mediaContentByMsgId.constFind(item->id.bare);
	// Опрос: пересылка = независимая копия (новый uuid, голоса с нуля).
	if (item->media() && item->media()->poll()
		&& found != g_mediaContentByMsgId.constEnd()) {
		ForwardPollCopy(address, found.value());
		return;
	}
	// Медиа — блоб перезаливается под нового получателя (гранты cloud выдаются
	// только при загрузке; см. ForwardMediaReshared).
	if (item->media() && found != g_mediaContentByMsgId.constEnd()) {
		ForwardMediaReshared(address, found.value());
		return;
	}
	const auto text = item->originalText();
	if (!text.text.isEmpty()) {
		MirrorOutgoing(toPeer, text); // с форматированием (entities сохраняются)
	}
}

void MirrorClearHistory(not_null<PeerData*> peer) {
	const auto session = &peer->session();
	const auto peerAddr = AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	const auto self = SelfAddress();
	// Граница очистки для журнала личного состояния v2 (T145): время самого
	// позднего скрываемого сообщения — остальные свои устройства скрывают всё,
	// что не позже неё.
	auto clearedUntilMs = std::int64_t(0);
	// uuid всех сообщений этого диалога берём из локального журнала (HistoryPath):
	// именно он воспроизводит переписку при старте и переживает пере-создание
	// сессии в headless, тогда как HistoryItem'ы и реестр nonChannelMessage
	// эфемерны. Диалог сообщения — собеседник (для своих исходящих это `to`).
	auto uuids = QSet<QString>();
	// Журнал истории зашифрован построчно (P-13) — читать через хранилище
	// (чтение файла напрямую после P-13 не находило ни одной строки).
	for (const auto &line : StoreReadLines(HistoryPath())) {
		const auto j = nlohmann::json::parse(line.toStdString(), nullptr, false);
		if (!j.is_object()) {
			continue;
		}
		const auto id = QString::fromStdString(j.value("id", std::string()));
		const auto from = QString::fromStdString(j.value("from", std::string()));
		const auto to = QString::fromStdString(j.value("to", std::string()));
		const auto dialog = (from == self) ? to : from;
		if (!id.isEmpty() && dialog == peerAddr) {
			uuids.insert(id);
			clearedUntilMs = std::max(clearedUntilMs, j.value("ts", std::int64_t(0)) * 1000 + 999);
		}
	}
	// Плюс всё, что уже инъецировано в текущей сессии (на случай сообщений,
	// пришедших после последней записи журнала).
	for (auto it = g_msgIdToUuid.constBegin(); it != g_msgIdToUuid.constEnd(); ++it) {
		if (it.key() == 0 || it.value().isEmpty()) {
			continue;
		}
		if (const auto item = session->data().nonChannelMessage(MsgId(it.key()))) {
			if (item->history()->peer == peer) {
				uuids.insert(it.value());
			}
		}
	}
	if (uuids.isEmpty()) {
		LOG(("Parvane: очистка чата %1 — нет известных сообщений (нечего скрывать)")
			.arg(peerAddr));
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_clearedUuids.unite(uuids);
	}
	AppendCleared(QStringList(uuids.begin(), uuids.end()));
	for (const auto &uuid : uuids) {
		const auto found = g_uuidToMsgId.find(uuid);
		if (found != g_uuidToMsgId.end() && found.value() != 0) {
			g_msgIdToUuid.remove(found.value());
			g_mediaContentByMsgId.remove(found.value());
		}
		g_uuidToMsgId.insert(uuid, 0);
		DecCacheRemove(uuid);
	}
	RewriteHistoryWithout(uuids);
	LOG(("Parvane: очистка чата %1 — скрыто %2 сообщений")
		.arg(peerAddr).arg(uuids.size()));
	// Свои устройства на v2 узнают об очистке из журнала личного состояния:
	// сообщений v2 сервер v1 не знает, и нотис `cleared` до них не дойдёт.
	if (const auto s = V2Ready()) {
		const auto until = clearedUntilMs ? clearedUntilMs : QDateTime::currentMSecsSinceEpoch();
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g_clearedUntilMs[peerAddr] = std::max(g_clearedUntilMs.value(peerAddr), qint64(until));
		}
		crl::async([s, address = peerAddr.toStdString(), until] {
			s->stateChatCleared(address, until);
		});
	}
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	auto ids = std::vector<std::string>();
	ids.reserve(uuids.size());
	for (const auto &uuid : uuids) {
		ids.push_back(uuid.toStdString());
	}
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
		}
		if (!m) {
			return;
		}
		try {
			m->clearMessages(from, ids, token);
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка msg.chat.clear: %1").arg(QString::fromUtf8(e.what())));
		}
	});
}

// Пересылка медиа: блоб перезаливается в cloud под нового получателя. Гранты
// на файл выдаются только при загрузке (владелец + recipients), поэтому ссылка
// на старый file_id у нового получателя не откроется. Скачать → расшифровать
// старым ключом → зашифровать новым → загрузить с recipients целевого чата →
// подменить file_id/file_key/file_nonce → отправить. Без file_key (открытый
// блоб, напр. стикер из пака) — как прежде, той же ссылкой.
void ForwardMediaReshared(const QString &toAddress, const QString &contentJson, int attempt) {
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto to = toAddress.toStdString();
	crl::async([=] {
		auto content = parvane::json::parse(contentJson.toStdString(), nullptr, false);
		if (!content.is_object()) {
			return;
		}
		const auto fileId = content.value("file_id", std::string());
		const auto fileKey = content.value("file_key", std::string());
		const auto fileNonce = content.value("file_nonce", std::string());
		if (fileId.empty() || fileKey.empty() || fileNonce.empty()) {
			sendContentAsync(toAddress, content.dump());
			return;
		}
		const auto retry = [=](const QString &why) {
			if (attempt >= 4) {
				LOG(("Parvane: пересылка — блоб %1 не перезалит (%2), сдаюсь")
					.arg(QString::fromStdString(fileId), why));
				return;
			}
			LOG(("Parvane: пересылка — %1, повтор через 3с").arg(why));
			crl::on_main([=] {
				base::call_delayed(3 * crl::time(1000), [=] {
					ForwardMediaReshared(toAddress, contentJson, attempt + 1);
				});
			});
		};
		try {
			// СОБСТВЕННЫЙ транспорт (аутентифицированный по JWT): перезаливка —
			// самодостаточная операция и не должна зависеть от живой сессии
			// (в т.ч. переживает пере-логин/обрыв основного gateway-канала).
			auto t2 = MakeTransport(QString::fromStdString(token));
			if (!t2 || !parvane::e2e::ready()) {
				retry("нет транспорта/E2E");
				return;
			}
			parvane::CloudClient cloud(*t2);
			const auto d = DownloadChatBlob(cloud, from, token, fileId, 60000);
			if (!d.ok) {
				retry("блоб не скачался");
				return;
			}
			const auto plain = parvane::blobcrypt::decrypt(d.bytes, fileKey, fileNonce);
			if (!plain) {
				LOG(("Parvane: пересылка — блоб %1 не расшифровался")
					.arg(QString::fromStdString(fileId)));
				return;
			}
			auto enc = parvane::blobcrypt::encrypt(*plain);
			if (enc.ciphertext.empty()) {
				return;
			}
			const auto filename = d.filename.empty()
				? content.value("kind", std::string("media")) + ".bin" : d.filename;
			const auto mime = d.mime.empty()
				? content.value("mime", std::string("application/octet-stream")) : d.mime;
			const auto newId = UploadBlobWith(
				cloud, from, token, filename, mime, enc.ciphertext,
				BlobRecipientsFor(to), 60000);
			if (newId.empty()) {
				retry("блоб не загрузился");
				return;
			}
			content["file_id"] = newId;
			content["file_key"] = enc.keyB64;
			content["file_nonce"] = enc.nonceB64;
			AttachBlobCap(content, newId);
			LOG(("Parvane: пересылка — блоб перезалит %1 → %2 для %3")
				.arg(QString::fromStdString(fileId), QString::fromStdString(newId), toAddress));
			// Отправляем sealed на том же собственном транспорте (target — user;
			// MirrorForward зовёт reshare только для 1-на-1).
			parvane::MessengerClient m2(*t2);
			const auto id = sendSealedDirect(&m2, t2.get(), to, content, token);
			if (id.empty()) {
				retry("sealed-отправка не удалась");
				return;
			}
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_ownSentUuids.insert(id);
			}
			LOG(("Parvane: переслано медиа → %1").arg(toAddress));
		} catch (const std::exception &e) {
			retry(u"исключение: "_q + QString::fromUtf8(e.what()));
		}
	});
}

void MirrorReact(not_null<HistoryItem*> item, const QString &emoji) {
	const auto it = g_msgIdToUuid.find(item->id.bare);
	if (it == g_msgIdToUuid.end()) {
		return; // неизвестное сообщение (нет uuid) — не реагируем
	}
	const auto uuid = it.value().toStdString();
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto emojiStd = emoji.toStdString();
	if (TryMutateV2(it.value(), parvane::json{{"reaction", {
			{"target", parvane::v2::ref(uuid)},
			{"emoji", emojiStd},
			{"remove", emojiStd.empty()}}}})) {
		return; // сообщение v2-чата: реакция — E2E-содержимым v2
	}
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
		}
		if (!m) {
			return;
		}
		try {
			m->react(from, uuid, emojiStd, token,
				parvane::e2e::sign("react:" + uuid + ":" + emojiStd));
		} catch (const std::exception &) {
		}
	});
}

void MirrorPin(not_null<HistoryItem*> item, bool pin) {
	const auto it = g_msgIdToUuid.find(item->id.bare);
	if (it == g_msgIdToUuid.end()) {
		return;
	}
	const auto uuid = it.value().toStdString();
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	if (TryMutateV2(it.value(), parvane::json{{"pin", {
			{"target", parvane::v2::ref(uuid)},
			{"unpin", !pin}}}})) {
		return;
	}
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
		}
		if (!m) {
			return;
		}
		try {
			m->pin(from, uuid, pin, token,
				parvane::e2e::sign("pin:" + uuid + ":" + (pin ? "true" : "false")));
		} catch (const std::exception &) {
		}
	});
}

void MirrorTyping(PeerData *peer) {
	if (!peer) {
		return;
	}
	// 1-на-1 → typing на id получателя; группа → typing на id группы (chatId),
	// в `to` кладём адрес группы, чтобы получатель сроутил в чат группы.
	quint64 id = 0;
	QString address;
	if (peer->isUser()) {
		id = std::uint64_t(peerToUser(peer->id).bare);
		address = AddressForId(id);
	} else if (peer->isChat()) {
		id = std::uint64_t(peerToChat(peer->id).bare);
		address = GroupIdForChat(peer);
	}
	if (address.isEmpty()) {
		return;
	}
	// L2-1: в чате с усиленной приватностью «печатает» не передаётся.
	if (L2Active(address)) {
		return;
	}
	// Эфемерно (fire-and-forget) на msg.typing.<id>; шард не нужен.
	const auto self = SelfAddress().toStdString();
	const auto to = address.toStdString();
	crl::async([=] {
		// Чат v2 — эфемерным каналом v2 (T127): кадр v1 несёт серверу {from, to}.
		// Сбой v2 не понижает до v1 — «печатает» просто не уходит.
		if (const auto s = V2Ready()) {
			if (s->sendTyping(to)) {
				return;
			}
		} else if (parvane::v2::isGroupAddress(to)) {
			return;
		}
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		const parvane::json ev{ { "from", self }, { "to", to } };
		try {
			t->publish(parvane::topics::msgTyping(std::to_string(id)), ev.dump());
		} catch (const std::exception &) {
		}
	});
}

namespace {
not_null<UserData*> ensurePeerUser(
	not_null<Main::Session*> session,
	std::uint64_t id,
	const QString &address); // определена ниже (в анонимном пространстве)
} // namespace

// Обработка входящего typing-кадра (1-на-1 и группа). `to` пуст/свой адрес →
// личка от `from`; `to` = известная группа → индикатор в чате группы. Main-поток.
void handleTypingFrame(const std::string &payload) {
	std::string from, to;
	try {
		const auto j = parvane::json::parse(payload);
		from = j.value("from", std::string());
		to = j.value("to", std::string());
	} catch (const std::exception &) {
		return;
	}
	if (from.empty()) {
		return;
	}
	const auto fromQ = QString::fromStdString(from);
	const auto toQ = QString::fromStdString(to);
	if (fromQ == SelfAddress()) {
		return; // своё эхо не показываем
	}
	// L2-1: «печатает» в чате с усиленной приватностью не показываем, даже
	// если собеседник (старый клиент) его прислал.
	if (L2Active((!toQ.isEmpty() && toQ != SelfAddress()) ? toQ : fromQ)) {
		return;
	}
	crl::on_main([fromQ, toQ] {
		const auto session = g_sessionWeak.get();
		if (!session) {
			return;
		}
		RegisterPeer(fromQ);
		const auto fromId = IdForAddress(fromQ);
		const auto user = ensurePeerUser(session, fromId, fromQ);
		bool isGroup = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			isGroup = !toQ.isEmpty() && g_knownGroups.contains(toQ);
		}
		const auto history = isGroup
			? session->data().history(
				peerFromChat(ChatId(BareId(IdForAddress(toQ)))))
			: session->data().history(user);
		session->data().sendActionManager().registerFor(
			history, MsgId(0), user,
			MTP_sendMessageTypingAction(),
			base::unixtime::now());
	});
}

// Подписаться на typing известных групп (idempotent). Воркер/main — берём t под локом.
void SubscribeGroupTyping() {
	parvane::ITransport *t = nullptr;
	QStringList groups;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_transport.get();
		for (auto it = g_knownGroups.constBegin(); it != g_knownGroups.constEnd(); ++it) {
			groups.push_back(it.key());
		}
	}
	if (!t) {
		return;
	}
	for (const auto &gid : groups) {
		const auto id = IdForAddress(gid);
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (g_typingGroupSubs.contains(id)) {
				continue;
			}
			g_typingGroupSubs.insert(id);
		}
		t->subscribe(parvane::topics::msgTyping(std::to_string(id)),
			[](std::string, std::string payload) { handleTypingFrame(payload); });
	}
}

void MirrorDelete(std::int64_t msgId) {
	// Удаляем «у всех» только СВОИ сообщения (шард проверяет автора). Ищем uuid
	// по локальному msgId; неизвестный (чужое/несинхронизированное) — no-op.
	const auto it = g_msgIdToUuid.find(msgId);
	if (it == g_msgIdToUuid.end()) {
		return;
	}
	const auto uuid = it.value().toStdString();
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	if (TryMutateV2(it.value(), parvane::json{{"delete", {
			{"targets", parvane::json::array({ parvane::v2::ref(uuid) })},
			{"for_everyone", true}}}})) {
		LOG(("Parvane: удаление своего msg %1 [v2]").arg(it.value()));
		MirrorLegacyMutation(it.value(), std::nullopt);
		return;
	}
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
		}
		if (!m) {
			return;
		}
		try {
			m->deleteMessage(from, uuid, token,
				parvane::e2e::sign("delete:" + uuid));
			LOG(("Parvane: удаление своего msg %1").arg(QString::fromStdString(uuid)));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка удаления: %1").arg(QString::fromUtf8(e.what())));
		}
	});
}

// Публикация правки своего сообщения (msg.chat.edit) с новым E2E-контентом:
// общий хвост MirrorEdit (текст/подпись) и MirrorLiveLocationUpdate (позиция).
void publishEditAsync(
		const std::string &to,
		const std::string &uuid,
		const parvane::json &content) {
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	if (const auto uuidQ = QString::fromStdString(uuid); !V2PeerOf(uuidQ).isEmpty()) {
		// Сообщение v2-чата: правка — E2E-содержимым v2 (Edit{target,text|location}).
		auto edit = parvane::json{{"target", parvane::v2::ref(uuid)}};
		const auto kind = parvane::contentKind(content);
		if (kind == "location") {
			if (const auto m = parvane::v2::toV2(content)) {
				edit["location"] = (*m)["location"];
			}
		} else {
			const auto text = (kind == "text")
				? content.value("text", std::string())
				: content.value("caption", std::string());
			if (const auto m = parvane::v2::toV2(parvane::textContent(
					text, parvane::contentEntities(content)))) {
				edit["text"] = (*m)["text"];
			}
		}
		{
			std::lock_guard<std::mutex> lk(g_v2Mutex);
			if (auto it = g_v2Cache.find(uuidQ); it != g_v2Cache.end()) {
				it.value().content = content;
				it.value().edited = true;
			}
		}
		cacheOwnOutgoing(uuid, from, content);
		TryMutateV2(uuidQ, parvane::json{{"edit", edit}});
		MirrorLegacyMutation(uuidQ, content);
		return;
	}
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		parvane::ITransport *t = nullptr;
		bool isGroup = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
			t = g_transport.get();
			isGroup = g_knownGroups.contains(QString::fromStdString(to));
		}
		if (!m || !t || !parvane::e2e::ready()) {
			return;
		}
		try {
			parvane::json envelope;
			auto copies = parvane::json::array();
			if (!isGroup) {
				const auto sealed = parvane::e2e::sealForAddress(
					to, content.dump(), *t, token);
				if (!sealed) {
					LOG(("Parvane: E2E правки не удался для %1").arg(QString::fromStdString(to)));
					return;
				}
				envelope = sealed->content;
				for (const auto &c : sealed->copies) {
					copies.push_back(c.toJson());
				}
			} else {
				const auto sealed = sealGroup(m, t, to, content, token);
				if (sealed.empty()) {
					LOG(("Parvane: E2E правки группы не удался для %1").arg(QString::fromStdString(to)));
					return;
				}
				envelope = parvane::json::parse(sealed);
			}
			const auto sig = parvane::e2e::sign(
				"edit:" + uuid + ":" + envelope.value("ciphertext", std::string()));
			m->editContent(from, uuid, envelope, sig, copies, token);
			cacheOwnOutgoing(uuid, from, content);
			LOG(("Parvane: правка своего msg %1 [E2E]").arg(QString::fromStdString(uuid)));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка правки: %1").arg(QString::fromUtf8(e.what())));
		}
	});
}

void MirrorEdit(not_null<HistoryItem*> item, const TextWithEntities &text) {
	// Правим только СВОИ сообщения. Контент пересобирается и шифруется заново
	// (E2E; сервер видит только новый шифртекст): текст → text+entities; медиа →
	// прежний контент с новой подписью (caption). Подпись `edit:<id>:<ct>`
	// ключом устройства авторизует правку sealed-сообщения; копии — по
	// устройствам получателя и своим.
	const auto it = g_msgIdToUuid.find(item->id.bare);
	if (it == g_msgIdToUuid.end()) {
		return;
	}
	const auto peer = item->history()->peer;
	QString address;
	if (peer->isChat()) {
		const auto chatBare = std::uint64_t(peerToChat(peer->id).bare);
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		address = g_chatIdToGroupId.value(chatBare);
	} else if (peer->isUser()) {
		address = AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	}
	if (address.isEmpty()) {
		return;
	}
	const auto uuid = it.value().toStdString();
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto to = address.toStdString();
	auto entitiesJson = entitiesToJson(text.entities);
	for (auto &me : detectMentions(text.text)) {
		entitiesJson.push_back(std::move(me));
	}
	parvane::json content;
	const auto prev = g_mediaContentByMsgId.value(item->id.bare);
	auto prevJson = prev.isEmpty()
		? parvane::json()
		: parvane::json::parse(prev.toStdString(), nullptr, false);
	if (prevJson.is_object() && prevJson.value("kind", std::string()) != "text") {
		content = prevJson;
		content["caption"] = text.text.toStdString();
		content["entities"] = entitiesJson;
	} else {
		content = parvane::textContent(text.text.toStdString(), entitiesJson);
	}
	g_mediaContentByMsgId.insert(item->id.bare, QString::fromStdString(content.dump()));
	publishEditAsync(to, uuid, content);
}

void MirrorRead(std::int64_t peerId) {
	// Отмечаем прочитанными все непрочитанные входящие от пира (msg.chat.read →
	// у отправителя ✓✓). Собираем uuid'ы и чистим, чтобы не слать повторно.
	const auto it = g_unreadIncoming.find(peerId);
	if (it == g_unreadIncoming.end() || it.value().isEmpty()) {
		return;
	}
	auto ids = std::vector<std::string>();
	// v2-сообщения: квитанция прочтения — E2E-содержимым v2 их автору.
	auto v2ByPeer = QHash<QString, parvane::json>();
	for (const auto &u : it.value()) {
		if (const auto peer = V2PeerOf(u); !peer.isEmpty()) {
			auto &list = v2ByPeer[peer];
			if (!list.is_array()) {
				list = parvane::json::array();
			}
			list.push_back(parvane::v2::ref(u.toStdString()));
			continue;
		}
		ids.push_back(u.toStdString());
	}
	it.value().clear();
	if (!v2ByPeer.isEmpty()) {
		auto v2ids = std::vector<std::string>();
		for (auto p = v2ByPeer.cbegin(); p != v2ByPeer.cend(); ++p) {
			for (const auto &r : p.value()) {
				if (const auto u = parvane::v2::b64ToUuid(r.value("op_id", std::string()))) {
					v2ids.push_back(*u);
				}
			}
		}
		// READ-1: отчитано (квитанцию доставит движок, v1-повторы не нужны).
		crl::async([v2ids] {
			NoteConfirmedRead(v2ids);
			AppendReadJournal(v2ids);
		});
	}
	for (auto p = v2ByPeer.cbegin(); p != v2ByPeer.cend(); ++p) {
		const auto first = p.value().empty()
			? QString()
			: QString::fromStdString(parvane::v2::b64ToUuid(
				p.value()[0].value("op_id", std::string())).value_or(std::string()));
		TryMutateV2(first, parvane::json{{"receipt", {
			{"kind", "RECEIPT_KIND_READ"},
			{"messages", p.value()}}}});
	}
	if (ids.empty()) {
		return;
	}
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
		}
		if (!m) {
			return;
		}
		for (const auto &id : ids) {
			try {
				m->markRead(from, id, token);
			} catch (const std::exception &) {
			}
		}
		NoteReported(ids);      // READ-1: помним локально и ждём подтверждения
		AppendReadJournal(ids); // переживает рестарт
		LOG(("Parvane: отмечено прочитанным %1 входящих").arg(int(ids.size())));
	});
}

namespace {

// Строит MessageContent JSON (зеркало parvane_types::MessageContent) по типу
// tdesktop-файла. Размеры/длительность в MVP = 0 (не критично для контракта —
// шард хранит content как есть; рендер получателя — Фаза 4b). caption=null при
// пустой подписи (serde Option<String> ← null = None).
parvane::json buildMediaContent(
		SendMediaType type,
		const std::string &fileId,
		const std::string &filename,
		const std::string &mime,
		std::uint64_t size,
		int durationSecs,
		int width,
		int height,
		const std::string &caption,
		const std::string &fileKey = {},   // E2E медиа (Фаза 3): ключ+nonce блоба
		const std::string &fileNonce = {}) {
	const parvane::json cap =
		caption.empty() ? parvane::json(nullptr) : parvane::json(caption);
	parvane::json content;
	switch (type) {
	case SendMediaType::Photo:
		content = parvane::json{{"kind", "photo"}, {"file_id", fileId},
			{"width", width}, {"height", height}, {"mime", mime},
			{"size_bytes", size}, {"caption", cap}};
		break;
	case SendMediaType::Audio:
		content = parvane::json{{"kind", "voice"}, {"file_id", fileId},
			{"duration_secs", durationSecs}, {"mime", mime}, {"size_bytes", size}};
		break;
	case SendMediaType::Round:
		content = parvane::json{{"kind", "video_note"}, {"file_id", fileId},
			{"duration_secs", durationSecs}, {"width", width}, {"height", height},
			{"mime", mime}, {"size_bytes", size}};
		break;
	default:
		// image/gif как GIF (анимация), video/* как Video, всё прочее — File.
		if (mime == "image/gif") {
			// filename с расширением обязателен: enforceNameType(Video) без него
			// деградирует AnimatedDocument в файл (рендер файлом вместо гифки).
			content = parvane::json{{"kind", "gif"}, {"file_id", fileId},
				{"filename", filename}, {"duration_secs", durationSecs},
				{"width", width}, {"height", height},
				{"mime", mime}, {"size_bytes", size}, {"caption", cap}};
		} else if (mime.rfind("video/", 0) == 0) {
			content = parvane::json{{"kind", "video"}, {"file_id", fileId},
				{"duration_secs", durationSecs}, {"width", width}, {"height", height},
				{"mime", mime}, {"size_bytes", size}, {"caption", cap}};
		} else {
			content = parvane::json{{"kind", "file"}, {"file_id", fileId},
				{"filename", filename}, {"mime", mime},
				{"size_bytes", size}, {"caption", cap}};
		}
		break;
	}
	if (!fileKey.empty()) {
		content["file_key"] = fileKey;
		content["file_nonce"] = fileNonce;
	}
	return content;
}

// Извлекает длительность(сек)/ширину/высоту из атрибутов file->document
// (audio/video) или file->photo — чтобы на приёме собрать плеер/кружок.
void extractMediaMeta(
		const std::shared_ptr<FilePrepareResult> &file,
		int &durationSecs, int &width, int &height) {
	durationSecs = width = height = 0;
	file->document.match([&](const MTPDdocument &d) {
		for (const auto &attr : d.vattributes().v) {
			attr.match([&](const MTPDdocumentAttributeAudio &a) {
				durationSecs = a.vduration().v;
			}, [&](const MTPDdocumentAttributeVideo &v) {
				durationSecs = int(v.vduration().v);
				width = v.vw().v;
				height = v.vh().v;
			}, [&](const MTPDdocumentAttributeImageSize &s) {
				width = s.vw().v;
				height = s.vh().v;
			}, [](const auto &) {});
		}
	}, [](const MTPDdocumentEmpty &) {});
}

} // namespace

void MirrorOutgoingFile(
		not_null<Main::Session*> session,
		const std::shared_ptr<FilePrepareResult> &file) {
	if (!file) {
		return;
	}
	// Адрес получателя: 1-на-1 — адрес юзера; группа — group_id по chatId.
	QString address;
	if (peerIsChat(file->to.peer)) {
		const auto chatBare = std::uint64_t(peerToChat(file->to.peer).bare);
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		address = g_chatIdToGroupId.value(chatBare);
	} else {
		address = AddressForId(std::uint64_t(peerToUser(file->to.peer).bare));
	}
	if (address.isEmpty()) {
		LOG(("Parvane: медиа не зеркалится — адрес пира неизвестен"));
		return;
	}

	// Байты: из памяти (content) либо с диска (filepath). ВАЖНО: для ФОТО
	// tdesktop не кладёт байты в content/filepath — сжатый JPEG уходит в
	// fileparts (см. Uploader::Entry: Photo → &file->fileparts). Поэтому
	// если content/filepath пусты — собираем блоб из fileparts.
	auto bytes = file->content;
	if (bytes.isEmpty() && !file->filepath.isEmpty()) {
		auto f = QFile(file->filepath);
		if (f.open(QIODevice::ReadOnly)) {
			bytes = f.readAll();
		}
	}
	if (bytes.isEmpty() && !file->fileparts.empty()) {
		for (const auto &part : file->fileparts) {
			bytes.append(part);
		}
	}
	if (bytes.isEmpty()) {
		LOG(("Parvane: медиа не зеркалится — нет байтов (%1)").arg(file->filename));
		return;
	}

	const auto type = file->type;
	auto filename = file->filename;
	if (filename.isEmpty()) {
		filename = u"file"_q;
	}
	int durationSecs = 0, mediaW = 0, mediaH = 0;
	extractMediaMeta(file, durationSecs, mediaW, mediaH);
	// TTL самоуничтожения чата — внутри E2E-контента (как для текста).
	const int ttl = PeerTtl(address);
	const auto from = SelfAddress().toStdString();
	const auto to = address.toStdString();
	const auto token = Token().toStdString();
	const auto filenameStd = filename.toStdString();
	const auto mimeStd = file->filemime.toStdString();
	const auto captionStd = file->caption.text.toStdString();
	const auto bytesStd = std::string(bytes.constData(), bytes.size());

	crl::async([=] {
		parvane::ITransport *t = nullptr;
		parvane::MessengerClient *m = nullptr;
		bool isGroup = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			m = g_messenger.get();
			isGroup = g_knownGroups.contains(QString::fromStdString(to));
		}
		if (!t || !m) {
			LOG(("Parvane: медиа-отправка без активной сессии — пропуск"));
			return;
		}
		try {
			// E2E медиа (Фаза 3): шифруем БЛОБ (cloud хранит шифртекст), ключ+nonce
			// кладём в content, а сам content шифруем E2E. 1-на-1 → sealed (Olm);
			// группа → Megolm (sender keys) + раздача SKDM.
			if (!parvane::e2e::ready()) {
				LOG(("Parvane: E2E медиа недоступен для %1 — не отправлено")
					.arg(QString::fromStdString(to)));
				return;
			}
			std::string uploadBytes = bytesStd, fileKey, fileNonce;
			auto enc = parvane::blobcrypt::encrypt(bytesStd);
			if (enc.ciphertext.empty()) {
				LOG(("Parvane: медиа не зашифровано (блоб) — пропуск"));
				return;
			}
			uploadBytes = std::move(enc.ciphertext);
			fileKey = enc.keyB64;
			fileNonce = enc.nonceB64;
			parvane::CloudClient cloud(*t);
			// Таймаут щедрый: fsync шарда на медленном диске может стоить секунды.
			// P-29: имя E2E-вложения серверу не сообщаем — оно едет внутри
			// E2E-контента (buildMediaContent), cloud видит только «blob»
			const auto fileId = UploadBlobWith(cloud, from, token, "blob", mimeStd,
				uploadBytes, BlobRecipientsFor(to), 20000);
			auto content = buildMediaContent(
				type, fileId, filenameStd, mimeStd, bytesStd.size(),
				durationSecs, mediaW, mediaH, captionStd, fileKey, fileNonce);
			AttachBlobCap(content, fileId);
			if (ttl > 0) {
				content["ttl_secs"] = ttl;
			}
			std::string id;
			if (!isGroup) {
				id = sendSealedDirect(m, t, to, content, token);
				if (id.empty()) {
					LOG(("Parvane: E2E медиа не удался для %1 — не отправлено")
						.arg(QString::fromStdString(to)));
					return;
				}
			} else {
				id = sendGroupContent(m, t, to, content, token);
				if (id.empty()) {
					LOG(("Parvane: E2E медиа группы не удался для %1 — не отправлено")
						.arg(QString::fromStdString(to)));
					return;
				}
			}
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_ownSentUuids.insert(id);
			}
			// Своё медиа — в журнал (плейнтекст-content с file_key/nonce): при старте
			// injectOnMain перекачает блоб из cloud и расшифрует. Переживает рестарт.
			// TTL-медиа эфемерно — НЕ журналируем (иначе воскреснет).
			if (!id.empty() && ttl == 0) {
				parvane::StoredMessage own;
				own.id = id;
				own.from = from;
				own.to = to;
				own.ts = QDateTime::currentSecsSinceEpoch();
				own.content = content;
				HistoryAppend(own);
			}
			LOG(("Parvane: медиа отправлено msg %1 (file %2, %3 байт) → %4%5")
				.arg(QString::fromStdString(id))
				.arg(QString::fromStdString(fileId))
				.arg(bytesStd.size())
				.arg(QString::fromStdString(to))
				.arg(u" [E2E]"_q));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка отправки медиа: %1")
				.arg(QString::fromUtf8(e.what())));
		}
	});
}

namespace {

// Корень локальных стикер-паков (тот же, что в LoadLocalStickerPacks).
[[nodiscard]] QString StickerPacksRoot() {
	if (const char *v = std::getenv("PARVANE_STICKERS_DIR"); v && *v) {
		return QString::fromUtf8(v);
	}
	return QDir::homePath() + u"/.local/share/ParvaneStickers"_q;
}

// Сырое имя пака хранится в каталоге файлом .pvname: имя каталога
// нормализовано, а docId эмодзи считается от имени из ссылки (EMOJI-1).
constexpr auto kRawPackNameFile = ".pvname";

void WriteRawPackName(const QString &dir, const QString &rawName) {
	if (rawName.isEmpty() || dir.isEmpty()) {
		return;
	}
	auto file = QFile(dir + u"/"_q + QString::fromLatin1(kRawPackNameFile));
	if (file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
		file.write(rawName.toUtf8());
	}
}

// Сырое имя пака, если его сохранили при материализации; иначе имя каталога
[[nodiscard]] QString ReadRawPackName(
		const QString &dir,
		const QString &fallback) {
	auto file = QFile(dir + u"/"_q + QString::fromLatin1(kRawPackNameFile));
	if (!file.open(QIODevice::ReadOnly)) {
		return fallback;
	}
	const auto raw = QString::fromUtf8(file.read(256)).trimmed();
	return raw.isEmpty() ? fallback : raw;
}

// Имя пака → безопасное имя каталога (без путей/спецсимволов).
[[nodiscard]] QString SanitizePackName(const QString &name) {
	auto out = QString();
	for (const auto &ch : name) {
		if (ch.isLetterOrNumber() || ch == u' ' || ch == u'-' || ch == u'_') {
			out.append(ch);
		}
	}
	out = out.trimmed().left(32);
	return out.isEmpty() ? u"Pack"_q : out;
}

// Контейнер пака: "PVPK1" + u32-длина JSON-индекса + индекс
// [{"name","size"}...] + байты файлов подряд. Лимиты: 200 файлов, 20 МБ.
constexpr auto kPackMagic = "PVPK1";
constexpr auto kPackMaxBytes = 20 * 1024 * 1024;
constexpr auto kPackMaxFiles = 200;

[[nodiscard]] std::string BuildPackArchive(const QString &dir) {
	const auto d = QDir(dir);
	const auto files = d.entryList(
		{ u"*.webp"_q, u"*.png"_q, u"*.tgs"_q, u"*.webm"_q },
		QDir::Files,
		QDir::Name);
	auto index = nlohmann::json::array();
	std::string blob;
	auto count = 0;
	for (const auto &name : files) {
		if (++count > kPackMaxFiles) {
			break;
		}
		auto f = QFile(d.filePath(name));
		if (!f.open(QIODevice::ReadOnly)) {
			continue;
		}
		const auto bytes = f.readAll();
		if (blob.size() + bytes.size() > kPackMaxBytes) {
			break;
		}
		index.push_back({
			{ "name", name.toStdString() },
			{ "size", std::size_t(bytes.size()) },
		});
		blob.append(bytes.constData(), bytes.size());
	}
	if (index.empty()) {
		return {};
	}
	const auto indexStr = index.dump();
	std::string out(kPackMagic);
	const auto len = std::uint32_t(indexStr.size());
	out.append(reinterpret_cast<const char*>(&len), 4);
	out.append(indexStr);
	out.append(blob);
	return out;
}

// Распаковка с санитизацией: только basename, только знакомые расширения.
[[nodiscard]] int UnpackPackArchive(
		const std::string &bytes,
		const QString &destDir) {
	if (bytes.size() < 9 || bytes.compare(0, 5, kPackMagic) != 0
		|| bytes.size() > std::size_t(kPackMaxBytes) + (1 << 20)) {
		return 0;
	}
	std::uint32_t len = 0;
	memcpy(&len, bytes.data() + 5, 4);
	if (9 + std::size_t(len) > bytes.size()) {
		return 0;
	}
	auto index = nlohmann::json();
	try {
		index = nlohmann::json::parse(bytes.substr(9, len));
	} catch (const std::exception &) {
		return 0;
	}
	if (!index.is_array() || index.size() > kPackMaxFiles) {
		return 0;
	}
	if (!QDir().mkpath(destDir)) {
		return 0;
	}
	auto offset = std::size_t(9) + len;
	auto written = 0;
	for (const auto &e : index) {
		const auto name = QFileInfo(QString::fromStdString(
			e.value("name", std::string()))).fileName();
		const auto size = e.value("size", std::size_t(0));
		if (offset + size > bytes.size()) {
			break;
		}
		const auto lower = name.toLower();
		const auto okExt = lower.endsWith(u".webp"_q)
			|| lower.endsWith(u".png"_q)
			|| lower.endsWith(u".tgs"_q)
			|| lower.endsWith(u".webm"_q);
		if (!name.isEmpty() && okExt && size > 0) {
			auto f = QFile(QDir(destDir).filePath(name));
			if (f.open(QIODevice::WriteOnly)) {
				f.write(bytes.data() + offset, size);
				++written;
			}
		}
		offset += size;
	}
	return written;
}

} // namespace

void MirrorOutgoingSticker(PeerData *peer, DocumentData *document) {
	if (!peer || !document) {
		return;
	}
	const auto sticker = document->sticker();
	const auto animated = document->isAnimation();
	if (!sticker && !animated) {
		return; // прочие «существующие документы» не наш случай
	}
	// Адрес получателя — как в MirrorOutgoing.
	QString address;
	if (peer->isChat()) {
		const auto chatBare = std::uint64_t(peerToChat(peer->id).bare);
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		address = g_chatIdToGroupId.value(chatBare);
	} else if (peer->isUser()) {
		address = peer->isSelf()
			? SelfAddress()
			: AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	}
	if (address.isEmpty()) {
		LOG(("Parvane: стикер не зеркалится — адрес пира неизвестен"));
		return;
	}
	// Байты — из локального файла документа (паки локальные; принятые стикеры
	// тоже привязаны к файлу при инъекции).
	const auto path = document->filepath(true);
	auto bytes = QByteArray();
	if (!path.isEmpty()) {
		auto f = QFile(path);
		if (f.open(QIODevice::ReadOnly)) {
			bytes = f.readAll();
		}
	}
	if (bytes.isEmpty()) {
		LOG(("Parvane: стикер без локальных байтов — не отправлен (%1)")
			.arg(path));
		return;
	}
	const auto kind = sticker ? std::string("sticker") : std::string("gif");
	const auto alt = (sticker ? sticker->alt : QString()).toStdString();
	const auto w = document->dimensions.width();
	const auto h = document->dimensions.height();
	const auto durationSecs = int(std::max(document->duration(), crl::time(0))
		/ 1000);
	const auto from = SelfAddress().toStdString();
	const auto to = address.toStdString();
	const auto token = Token().toStdString();
	const auto mimeStd = document->mimeString().toStdString();
	const auto bytesStd = std::string(bytes.constData(), bytes.size());
	const int ttl = PeerTtl(address); // TTL чата: стикер/гиф тоже эфемерны
	// Стикер из НАШЕГО локального пака — приложим pack_ref (набор пакуется в
	// cloud один раз за сессию), получатель сможет установить весь набор.
	auto packSetId = quint64(0);
	auto packInfo = PackDirInfo();
	if (sticker && sticker->set.id) {
		const auto it = g_stickerPackDirs.constFind(sticker->set.id);
		if (it != g_stickerPackDirs.constEnd()) {
			packSetId = sticker->set.id;
			packInfo = it.value();
		}
	}
	crl::async([=] {
		parvane::ITransport *t = nullptr;
		parvane::MessengerClient *m = nullptr;
		bool isGroup = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			m = g_messenger.get();
			isGroup = g_knownGroups.contains(QString::fromStdString(to));
		}
		if (!t || !m || !parvane::e2e::ready()) {
			LOG(("Parvane: стикер не отправлен (нет сессии/E2E)"));
			return;
		}
		try {
			auto enc = parvane::blobcrypt::encrypt(bytesStd);
			if (enc.ciphertext.empty()) {
				LOG(("Parvane: стикер не зашифрован (блоб) — пропуск"));
				return;
			}
			parvane::CloudClient cloud(*t);
			// Таймаут щедрый: fsync шарда на медленном диске может стоить секунды.
			const auto blobRecipients = BlobRecipientsFor(to);
			const auto fileId = UploadBlobWith(
				cloud, from, token, kind + ".bin", mimeStd, enc.ciphertext,
				blobRecipients, 20000);
			parvane::json content{
				{"kind", kind}, {"file_id", fileId},
				{"width", w}, {"height", h},
				{"mime", mimeStd}, {"size_bytes", bytesStd.size()},
				{"file_key", enc.keyB64}, {"file_nonce", enc.nonceB64}};
			AttachBlobCap(content, fileId);
			if (kind == "gif") {
				content["duration_secs"] = durationSecs;
				content["caption"] = parvane::json(nullptr);
			}
			if (!alt.empty()) {
				// alt-эмодзи → filename (buildLocalMtpDocument кладёт его в
				// Sticker-атрибут на приёме).
				content["filename"] = alt;
			}
			if (ttl > 0) {
				content["ttl_secs"] = ttl;
			}
			// pack_ref: архив набора в cloud (кэш на сессию по setId).
			if (packSetId) {
				const auto packRecipients = RecipientsSet(blobRecipients);
				auto refStr = QString();
				{
					std::lock_guard<std::mutex> lk(g_sessionMutex);
					refStr = FindUploadedPackRef(packSetId, packRecipients);
				}
				if (refStr.isEmpty()) {
					const auto archive = BuildPackArchive(packInfo.dir);
					if (!archive.empty()) {
						auto penc = parvane::blobcrypt::encrypt(archive);
						if (!penc.ciphertext.empty()) {
							const auto pfid = UploadBlobWith(
								cloud, from, token, "pack.pvpk",
								"application/octet-stream",
								penc.ciphertext, blobRecipients, 20000);
							auto ref = parvane::json{
								{ "file_id", pfid },
								{ "name", packInfo.name.toStdString() },
								{ "count", packInfo.count },
								{ "key", penc.keyB64 },
								{ "nonce", penc.nonceB64 }};
							AttachBlobCap(ref, pfid);
							refStr = QString::fromStdString(ref.dump());
							std::lock_guard<std::mutex> lk(g_sessionMutex);
							RememberUploadedPackRef(
								packSetId, packRecipients, refStr);
							LOG(("Parvane: пак «%1» загружен в cloud (%2 байт)")
								.arg(packInfo.name)
								.arg(qint64(archive.size())));
						}
					}
				}
				if (!refStr.isEmpty()) {
					content["pack_ref"] = parvane::json::parse(
						refStr.toStdString());
				}
			}
			std::string id;
			if (!isGroup) {
				id = sendSealedDirect(m, t, to, content, token);
				if (id.empty()) {
					LOG(("Parvane: E2E стикера не удался для %1")
						.arg(QString::fromStdString(to)));
					return;
				}
			} else {
				id = sendGroupContent(m, t, to, content, token);
				if (id.empty()) {
					LOG(("Parvane: E2E стикера группы не удался для %1")
						.arg(QString::fromStdString(to)));
					return;
				}
			}
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_ownSentUuids.insert(id);
			}
			if (!id.empty() && ttl == 0) { // TTL-эфемерное не журналируем
				parvane::StoredMessage own;
				own.id = id;
				own.from = from;
				own.to = to;
				own.ts = QDateTime::currentSecsSinceEpoch();
				own.content = content;
				HistoryAppend(own);
			}
			LOG(("Parvane: %1 отправлен → %2 [E2E]")
				.arg(QString::fromStdString(kind))
				.arg(QString::fromStdString(to)));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка отправки стикера: %1")
				.arg(QString::fromUtf8(e.what())));
		}
	});
}

namespace {
// ── Кастом-эмодзи: локальные паки → нативная эмодзи-панель + инлайн-рендер ─────
// Секция кастом-эмодзи появляется, когда feedSetFull получает набор с флагом
// f_emojis: type()==Emoji → set попадает в emojiSetsOrder, документы с
// documentAttributeCustomEmoji резолвятся CustomEmojiManager'ом из локального
// файла (без MTProto). docId детерминирован от (rawName|file), поэтому entity
// custom_emoji (data=docId) резолвится и у получателя после материализации.
[[nodiscard]] QString CustomEmojiRoot() {
	if (const char *v = std::getenv("PARVANE_EMOJI_DIR"); v && *v) {
		return QString::fromUtf8(v);
	}
	return QDir::homePath() + u"/.local/share/ParvaneEmoji"_q;
}

[[nodiscard]] std::int64_t EmojiDocId(const QString &rawName, const QString &file) {
	return docIdFromFileId(u"pvemoji:"_q + rawName + u"|"_q + file);
}

// Синтезировать/обновить один эмодзи-набор из каталога `dir` под ИМЕНЕМ
// `rawName` (важно: docId считается по rawName, одинаковому у отправителя и
// получателя). Возвращает setId (0 — пусто). Только main-поток.
[[nodiscard]] quint64 FeedCustomEmojiSet(
		not_null<Main::Session*> session,
		const QString &rawName,
		const QString &dir) {
	const auto packDir = QDir(dir);
	const auto files = packDir.entryList(
		{ u"*.webp"_q, u"*.png"_q, u"*.tgs"_q, u"*.webm"_q },
		QDir::Files, QDir::Name);
	if (files.isEmpty()) {
		return 0;
	}
	const auto setId = std::uint64_t(docIdFromFileId(u"pvemoji-set:"_q + rawName));
	auto &stickers = session->data().stickers();
	auto docs = QVector<MTPDocument>();
	auto paths = QVector<QPair<qint64, QString>>();
	for (const auto &name : files) {
		const auto path = packDir.filePath(name);
		const auto isTgs = name.endsWith(u".tgs"_q, Qt::CaseInsensitive);
		const auto isWebm = name.endsWith(u".webm"_q, Qt::CaseInsensitive);
		auto w = 100, h = 100;
		if (!isTgs && !isWebm) {
			const auto img = QImage(path);
			if (img.isNull()) {
				continue;
			}
			w = img.width();
			h = img.height();
		}
		const auto docId = EmojiDocId(rawName, name);
		const auto size = QFileInfo(path).size();
		const auto mime = isTgs
			? u"application/x-tgsticker"_q
			: isWebm ? u"video/webm"_q
			: name.endsWith(u".png"_q, Qt::CaseInsensitive) ? u"image/png"_q
			: u"image/webp"_q;
		auto alt = QString::fromUtf8("\xF0\x9F\x99\x82");
		const auto base = QFileInfo(name).completeBaseName();
		if (const auto dash = base.lastIndexOf(u'-'); dash >= 0) {
			auto ok = false;
			const auto code = base.mid(dash + 1).toUInt(&ok, 16);
			if (ok && code >= 0x80 && code <= 0x10FFFF) {
				const char32_t c = code;
				alt = QString::fromUcs4(&c, 1);
			}
		}
		auto attrs = QVector<MTPDocumentAttribute>();
		attrs.push_back(MTP_documentAttributeImageSize(MTP_int(w), MTP_int(h)));
		attrs.push_back(MTP_documentAttributeCustomEmoji(
			MTP_flags(MTPDdocumentAttributeCustomEmoji::Flag::f_free),
			MTP_string(alt),
			MTP_inputStickerSetID(MTP_long(setId), MTP_long(0))));
		docs.push_back(MTP_document(
			MTP_flags(0), MTP_long(docId), MTP_long(0), MTP_bytes(),
			MTP_int(int(base::unixtime::now())), MTP_string(mime), MTP_long(size),
			MTP_vector<MTPPhotoSize>(), MTPVector<MTPVideoSize>(),
			MTP_int(session->mainDcId()),
			MTP_vector<MTPDocumentAttribute>(attrs)));
		paths.push_back({ docId, path });
		g_emojiDocToSet.insert(docId, setId);
	}
	if (docs.isEmpty()) {
		return 0;
	}
	using SFlag = MTPDstickerSet::Flag;
	const auto set = MTP_stickerSet(
		MTP_flags(SFlag::f_installed_date | SFlag::f_emojis),
		MTP_int(int(base::unixtime::now())),
		MTP_long(setId), MTP_long(0),
		MTP_string(rawName), MTP_string(rawName),
		MTPVector<MTPPhotoSize>(), MTPint(), MTPint(), MTPlong(),
		MTP_int(docs.size()), MTP_int(0));
	const auto full = MTP_messages_stickerSet(
		set, MTP_vector<MTPStickerPack>(), MTP_vector<MTPStickerKeyword>(),
		MTP_vector<MTPDocument>(docs));
	full.match([&](const MTPDmessages_stickerSet &data) {
		stickers.feedSetFull(data);
	}, [](const auto &) {});
	for (const auto &[docId, path] : paths) {
		session->data().document(DocumentId(docId))->setLocation(
			Core::FileLocation(path));
	}
	auto &order = stickers.emojiSetsOrderRef();
	if (!order.contains(setId)) {
		order.push_back(setId);
	}
	g_emojiPackDirs.insert(setId, PackDirInfo{
		packDir.absolutePath(), rawName, int(docs.size()) });
	g_emojiPackMaterialized.insert(rawName);
	return setId;
}

// Загрузка своих локальных эмодзи-паков (авторство): каждый подкаталог
// ParvaneEmoji/<Имя> → набор. Имя каталога = rawName (для совпадения docId).
void LoadLocalCustomEmoji(not_null<Main::Session*> session) {
	const auto rootDir = QDir(CustomEmojiRoot());
	if (!rootDir.exists()) {
		return;
	}
	auto loaded = 0;
	for (const auto &packName : rootDir.entryList(
			QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name)) {
		const auto dir = rootDir.filePath(packName);
		// EMOJI-1: набор строится от сырого имени из ссылки, каталог может
		// называться нормализованно
		const auto rawName = ReadRawPackName(dir, packName);
		if (FeedCustomEmojiSet(session, rawName, dir)) {
			++loaded;
			LOG(("Parvane: эмодзи-пак «%1» загружен (каталог «%2»)")
				.arg(rawName, packName));
		}
	}
	if (loaded > 0) {
		session->data().stickers().notifyUpdated(Data::StickersType::Emoji);
	}
}

// Материализовать эмодзи-паки, пришедшие в сообщении (content.emoji_packs):
// скачать архив из cloud, распаковать в ParvaneEmoji/<name>, синтезировать набор
// → entity custom_emoji резолвятся. Идемпотентно по имени пака. Триггерится на
// приёме текста с кастом-эмодзи. Скачивание — воркер, feed — main.
void MaterializeEmojiPacks(not_null<Main::Session*> session,
		const nlohmann::json &content) {
	if (!content.is_object() || !content.contains("emoji_packs")
		|| !content["emoji_packs"].is_array()) {
		return;
	}
	// Лимит паков на сообщение (анти-DoS: иначе одно сообщение порождает
	// множество параллельных скачиваний из cloud).
	auto processed = 0;
	for (const auto &ref : content["emoji_packs"]) {
		if (!ref.is_object() || ++processed > 4) {
			continue;
		}
		const auto rawName = QString::fromStdString(ref.value("name", std::string()));
		const auto fileId = QString::fromStdString(ref.value("file_id", std::string()));
		const auto key = ref.value("key", std::string());
		const auto nonce = ref.value("nonce", std::string());
		RememberBlobCaps(ref);
		if (rawName.isEmpty() || fileId.isEmpty()) {
			continue;
		}
		if (g_emojiPackMaterialized.contains(rawName)
			|| g_packInstallBusy.contains(fileId)) {
			continue;
		}
		const auto dest = CustomEmojiRoot() + u"/"_q + SanitizePackName(rawName);
		// Защита от подмены: НЕ перезаписываем уже существующий пак (свой или
		// ранее полученный) — иначе отправитель, зная имя, подменил бы содержимое
		// (и docId, детерминированный от имени|файла). Существующий пак уже
		// загружается LoadLocalCustomEmoji на старте.
		if (QDir(dest).exists()) {
			g_emojiPackMaterialized.insert(rawName);
			continue;
		}
		g_packInstallBusy.insert(fileId);
		const auto fidStd = fileId.toStdString();
		const auto weak = base::make_weak(session.get());
		crl::async([=] {
			parvane::ITransport *t = nullptr;
			std::string self, token;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				t = g_transport.get();
				self = g_selfAddress.toStdString();
				token = g_token.toStdString();
			}
			auto written = 0;
			if (t) {
				try {
					parvane::CloudClient cloud(*t);
					auto d = DownloadChatBlob(cloud, self, token, fidStd, 20000);
					if (d.ok) {
						auto dec = parvane::blobcrypt::decrypt(d.bytes, key, nonce);
						if (dec) {
							written = UnpackPackArchive(*dec, dest);
							if (written > 0) {
								// conformance EMOJI-1: docId считается от ИМЕНИ
								// ИЗ ССЫЛКИ, а каталог назван нормализованным
								// именем — сохраняем сырое рядом, иначе после
								// рестарта docId разъедутся с отправителем.
								WriteRawPackName(dest, rawName);
							}
						}
					}
				} catch (const std::exception &) {
				}
			}
			crl::on_main([weak, rawName, dest, fileId, written] {
				g_packInstallBusy.remove(fileId);
				const auto s = weak.get();
				if (!s || written <= 0) {
					return;
				}
				if (FeedCustomEmojiSet(s, rawName, dest)) {
					s->data().stickers().notifyUpdated(Data::StickersType::Emoji);
					// Перерисовать открытые сообщения — кастом-эмодзи резолвятся.
					s->data().stickers().notifyRecentUpdated(Data::StickersType::Emoji);
					LOG(("Parvane: эмодзи-пак «%1» материализован (%2 шт)")
						.arg(rawName).arg(written));
				}
			});
		});
	}
}

// Прикрепить pack_ref используемых кастом-эмодзи к контенту (для отправки).
// Возвращает json-массив emoji_packs (пусто — эмодзи нет / наши локальные не
// найдены). Вызывать из async send-контекста (нужен cloud). from/token/to —
// как в остальных отправках.
[[nodiscard]] nlohmann::json BuildEmojiPacks(
		parvane::ITransport *t,
		const nlohmann::json &entities,
		const std::string &from,
		const std::string &token,
		const std::vector<std::string> &recipients) {
	auto out = nlohmann::json::array();
	if (!t || !entities.is_array()) {
		return out;
	}
	// Собрать setId, на которые ссылаются custom_emoji-entities.
	QSet<quint64> setIds;
	for (const auto &e : entities) {
		if (!e.is_object() || e.value("type", std::string()) != "custom_emoji") {
			continue;
		}
		const auto data = QString::fromStdString(e.value("data", std::string()));
		auto ok = false;
		const auto docId = qint64(data.toLongLong(&ok));
		if (!ok) {
			continue;
		}
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		const auto it = g_emojiDocToSet.constFind(docId);
		if (it != g_emojiDocToSet.constEnd()) {
			setIds.insert(it.value());
		}
	}
	if (setIds.isEmpty()) {
		return out;
	}
	parvane::CloudClient cloud(*t);
	const auto packRecipients = RecipientsSet(recipients);
	for (const auto setId : setIds) {
		QString refStr;
		PackDirInfo info;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			refStr = FindUploadedPackRef(setId, packRecipients);
			info = g_emojiPackDirs.value(setId);
		}
		if (refStr.isEmpty() && !info.dir.isEmpty()) {
			const auto archive = BuildPackArchive(info.dir);
			if (!archive.empty()) {
				auto penc = parvane::blobcrypt::encrypt(archive);
				if (!penc.ciphertext.empty()) {
					try {
						const auto pfid = UploadBlobWith(cloud, from, token, "emoji.pvpk",
							"application/octet-stream", penc.ciphertext,
							recipients, 20000);
						auto ref = nlohmann::json{
							{ "file_id", pfid },
							{ "name", info.name.toStdString() },
							{ "count", info.count },
							{ "key", penc.keyB64 },
							{ "nonce", penc.nonceB64 }};
						AttachBlobCap(ref, pfid);
						refStr = QString::fromStdString(ref.dump());
						std::lock_guard<std::mutex> lk(g_sessionMutex);
						RememberUploadedPackRef(
							setId, packRecipients, refStr);
					} catch (const std::exception &) {
					}
				}
			}
		}
		if (!refStr.isEmpty()) {
			out.push_back(nlohmann::json::parse(refStr.toStdString()));
		}
	}
	return out;
}

} // namespace (кастом-эмодзи)

void LoadLocalStickerPacks(not_null<Main::Session*> session); // ниже по файлу

bool HasStickerPackRef(DocumentData *document) {
	return document && g_packRefByDocId.contains(qint64(document->id));
}

void InstallStickerPackFromDocument(DocumentData *document) {
	if (!document) {
		return;
	}
	const auto refStr = g_packRefByDocId.value(qint64(document->id));
	if (refStr.isEmpty()) {
		return;
	}
	auto ref = nlohmann::json();
	try {
		ref = nlohmann::json::parse(refStr.toStdString());
	} catch (const std::exception &) {
		return;
	}
	const auto name = SanitizePackName(
		QString::fromStdString(ref.value("name", std::string())));
	const auto count = ref.value("count", 0);
	const auto fileId = QString::fromStdString(
		ref.value("file_id", std::string()));
	if (fileId.isEmpty() || g_packInstallBusy.contains(fileId)) {
		return;
	}
	const auto dest = StickerPacksRoot() + u"/"_q + name;
	if (QDir(dest).exists()) {
		Ui::show(Ui::MakeInformBox(
			u"Набор «%1» уже установлен."_q.arg(name)));
		return;
	}
	const auto key = ref.value("key", std::string());
	const auto nonce = ref.value("nonce", std::string());
	RememberBlobCaps(ref);
	Ui::show(Ui::MakeConfirmBox({
		.text = u"Добавить набор стикеров «%1» (%2 шт.)?"_q
			.arg(name)
			.arg(count),
		.confirmed = [=](Fn<void()> &&close) {
			close();
			g_packInstallBusy.insert(fileId);
			const auto fid = fileId.toStdString();
			const auto self = SelfAddress().toStdString();
			const auto token = Token().toStdString();
			crl::async([=] {
				parvane::ITransport *t = nullptr;
				{
					std::lock_guard<std::mutex> lk(g_sessionMutex);
					t = g_transport.get();
				}
				auto unpacked = 0;
				if (t) {
					try {
						parvane::CloudClient cloud(*t);
						auto d = DownloadChatBlob(cloud, self, token, fid, 20000);
						if (d.ok) {
							auto bytes = std::string();
							if (key.empty()) {
								bytes = std::move(d.bytes);
							} else if (auto dec = parvane::blobcrypt::decrypt(
									d.bytes, key, nonce)) {
								bytes = std::move(*dec);
							}
							if (!bytes.empty()) {
								unpacked = UnpackPackArchive(bytes, dest);
							}
						}
					} catch (const std::exception &e) {
						LOG(("Parvane: установка пака не удалась: %1")
							.arg(QString::fromUtf8(e.what())));
					}
				}
				crl::on_main([=] {
					g_packInstallBusy.remove(fileId);
					if (unpacked > 0) {
						if (const auto s = g_sessionWeak.get()) {
							LoadLocalStickerPacks(s);
						}
						LOG(("Parvane: пак «%1» установлен (%2 шт)")
							.arg(name)
							.arg(unpacked));
						Ui::show(Ui::MakeInformBox(
							u"Набор «%1» добавлен (%2 шт.)."_q
								.arg(name)
								.arg(unpacked)));
					} else {
						Ui::show(Ui::MakeInformBox(
							u"Не удалось установить набор «%1»."_q.arg(name)));
					}
				});
			});
		},
		.confirmText = u"Добавить"_q,
	}));
}

void AttachLocalOutgoingMedia(
		not_null<Main::Session*> session,
		const std::shared_ptr<FilePrepareResult> &file) {
	if (!file) {
		return;
	}
	const auto photoId = file->photo.match(
		[](const MTPDphoto &p) { return std::uint64_t(p.vid().v); },
		[](const MTPDphotoEmpty &) { return std::uint64_t(0); });
	const auto docId = file->document.match(
		[](const MTPDdocument &d) { return std::uint64_t(d.vid().v); },
		[](const MTPDdocumentEmpty &) { return std::uint64_t(0); });

	// Байты своего файла: content / filepath / fileparts (для фото из буфера
	// обмена байты лежат в fileparts, см. MirrorOutgoingFile).
	auto raw = file->content;
	if (raw.isEmpty() && !file->filepath.isEmpty()) {
		auto f = QFile(file->filepath);
		if (f.open(QIODevice::ReadOnly)) {
			raw = f.readAll();
		}
	}
	if (raw.isEmpty() && !file->fileparts.empty()) {
		for (const auto &part : file->fileparts) {
			raw.append(part);
		}
	}
	if (raw.isEmpty()) {
		return;
	}

	if (photoId) {
		// Своё фото — заполняем PhotoData картинкой из памяти (inline).
		auto image = QImage();
		image.loadFromData(raw);
		if (image.isNull()) {
			return;
		}
		const auto photo = session->data().photo(photoId);
		const auto large = Images::FromImageInMemory(image, "JPG", raw);
		photo->updateImages(
			QByteArray(), ImageWithLocation(), large, large,
			ImageWithLocation(), ImageWithLocation(), 0);
	} else if (docId) {
		// Свой файл — привязываем локальную копию, чтобы считался скачанным.
		auto localPath = file->filepath;
		if (localPath.isEmpty()) {
			localPath = MediaDir() + u"/out_"_q + QString::number(docId) + u"_"_q
				+ SafeFileName(file->filename);
			auto f = QFile(localPath);
			if (!f.open(QIODevice::WriteOnly)
				|| f.write(raw) != qint64(raw.size())) {
				return;
			}
			f.close();
			RestrictToOwner(localPath);
		}
		const auto ownDoc = session->data().document(docId);
		ownDoc->setLocation(Core::FileLocation(localPath));
		// Свою гифку — в Saved GIFs (нативный checkSavedGif гейтится по
		// isGifv = mp4, а наши .gif — image/gif, добавляем сами).
		if (ownDoc->isAnimation()) {
			session->data().stickers().addSavedGif(nullptr, ownDoc);
		}
	}
}

namespace {

// Гарантирует, что пир (отправитель) существует и «загружен» в Data::Session.
// Синтезируем MTPUser с first_name = адрес, чтобы диалог имел имя. Идемпотентно.
void ResolveNames(const QStringList &addresses); // fwd
void DownloadAvatar(const QString &address, const QString &fileId); // fwd
// Сохраняет file_id аватара и запускает загрузку (если ещё не грузили).
void NoteAvatar(const QString &address, const QString &fileId) {
	// СВОЙ адрес раньше отбрасывался здесь же — из-за этого аватар, поставленный
	// на другом устройстве (вебе), на десктопе не появлялся никогда, хотя
	// каталог identity отдаёт его и для себя.
	if (fileId.isEmpty()) {
		return;
	}
	g_avatarFileIds.insert(address, fileId);
	const auto key = address + '|' + fileId;
	if (!g_avatarDownloaded.contains(key)) {
		g_avatarDownloaded.insert(key);
		DownloadAvatar(address, fileId);
	}
}

// Отображаемое имя по адресу: из каталога (g_displayNames) либо локальная часть
// адреса до '@' по умолчанию.
[[nodiscard]] QString DisplayNameFor(const QString &address) {
	const auto it = g_displayNames.constFind(address);
	if (it != g_displayNames.constEnd() && !it.value().isEmpty()) {
		return it.value();
	}
	const auto at = address.indexOf('@');
	return (at > 0) ? address.left(at) : address;
}

// Ставит пиру закэшированный аватар (если есть). Нужно после каждого processUser
// с пустым фото (тот стирает userpic) — иначе аватар пропадает.
void applyAvatar(not_null<PeerData*> peer, const QString &address) {
	const auto it = g_avatarImages.constFind(address);
	if (it == g_avatarImages.constEnd() || it.value().isNull()) {
		return;
	}
	const auto photoId = PhotoId(qHash(address)) | 0x2000000000000000ULL;
	peer->setUserpicInMemory(
		photoId,
		Images::FromImageInMemory(it.value(), "JPG", QByteArray()));
}

// Синтезирует (идемпотентно) базовую группу как ChatData, чтобы она появилась в
// списке диалогов. gid — group_id (адрес переписки), name — заголовок,
// memberCount — число участников (для «N members»). Регистрирует chatId↔gid.
ChatData *ensureGroupChat(
		not_null<Main::Session*> session,
		const QString &rawGid,
		const QString &name,
		int memberCount) {
	const auto gid = CanonicalGroup(rawGid); // группа, переведённая в v2 (T180)
	const auto chatId = IdForAddress(gid);
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_knownGroups.insert(gid, name);
		g_chatIdToGroupId.insert(chatId, gid);
	}
	if (g_pendingGroupMsgs.contains(gid)) {
		// После синтеза чата (иначе отложенные снова не нашли бы группу)
		crl::on_main([gid] { FlushPendingGroupMessages(gid); });
	}
	const auto existing = session->data().chatLoaded(ChatId(BareId(chatId)));
	const auto title = name.isEmpty() ? gid.left(8) : name;
	if (existing) {
		if (!title.isEmpty() && existing->name() != title) {
			existing->setName(title);
		}
		return existing;
	}
	const auto chat = MTP_chat(
		MTP_flags(MTPDchat::Flags()),
		MTP_long(chatId),
		MTP_string(title),
		MTP_chatPhotoEmpty(),
		MTP_int(memberCount > 0 ? memberCount : 1),
		MTP_int(int(base::unixtime::now())),
		MTP_int(1),                            // version
		MTPInputChannel(),                     // migrated_to
		MTP_chatAdminRights(MTP_flags(0)),
		MTP_chatBannedRights(MTP_flags(0), MTP_int(0)));
	const auto peer = session->data().processChat(chat);
	const auto result = peer->asChat();
	if (result) {
		const auto history = session->data().history(result);
		if (!history->folderKnown()) {
			history->clearFolder();
		}
		if (!history->unreadCountKnown()) {
			history->setUnreadCount(0);
		}
		LOG(("Parvane: группа синтезирована %1 (%2)").arg(gid, title));
		// Личный канал контактов, указывающий на эту группу, теперь можно
		// показать — перерисовать секцию профиля.
		auto waiting = QSet<quint64>();
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			waiting = g_personalChannelUsers.take(gid);
		}
		for (const auto uid : waiting) {
			if (const auto user = session->data().userLoaded(UserId(BareId(uid)))) {
				session->changes().peerUpdated(
					user,
					Data::PeerUpdate::Flag::PersonalChannel);
			}
		}
	}
	return result;
}

// ── spec 003: сведения группы → нативные объекты (просмотр) ──────────────────
// Права по умолчанию провода (разрешено) → запреты tdesktop.
[[nodiscard]] ChatRestrictions restrictionsFromPerms(const parvane::DefaultPermissions &p) {
	using R = ChatRestriction;
	auto r = ChatRestrictions();
	const auto media = R::SendPhotos | R::SendVideos | R::SendVideoMessages
		| R::SendMusic | R::SendVoiceMessages | R::SendFiles;
	if (!p.send_messages) {
		r |= R::SendOther | media | R::SendStickers | R::SendGifs | R::SendPolls | R::EmbedLinks;
	}
	if (!p.send_media) r |= media;
	if (!p.send_stickers_gifs) r |= R::SendStickers | R::SendGifs;
	if (!p.send_polls) r |= R::SendPolls;
	if (!p.embed_links) r |= R::EmbedLinks;
	if (!p.invite_users) r |= R::AddParticipants;
	if (!p.pin_messages) r |= R::PinMessages;
	if (!p.change_info) r |= R::ChangeInfo;
	return r;
}

// Обратно: запреты tdesktop (экран «Permissions») → разрешения провода.
// «Писать сообщения» читаем ТОЛЬКО по SendOther (как web по sendPlain): общий
// запрет медиа не должен гасить текст.
[[nodiscard]] parvane::DefaultPermissions permsFromRestrictions(ChatRestrictions r) {
	using R = ChatRestriction;
	auto p = parvane::DefaultPermissions();
	const auto media = R::SendPhotos | R::SendVideos | R::SendVideoMessages
		| R::SendMusic | R::SendVoiceMessages | R::SendFiles;
	p.send_messages = !(r & R::SendOther);
	p.send_media = !(r & media);
	p.send_stickers_gifs = !(r & (R::SendStickers | R::SendGifs));
	p.send_polls = !(r & R::SendPolls);
	p.embed_links = !(r & R::EmbedLinks);
	p.invite_users = !(r & R::AddParticipants);
	p.pin_messages = !(r & R::PinMessages);
	p.change_info = !(r & R::ChangeInfo);
	return p;
}

[[nodiscard]] ChatAdminRights adminRightsFrom(const parvane::AdminRights &a) {
	using A = ChatAdminRight;
	auto r = ChatAdminRights();
	if (a.change_info) r |= A::ChangeInfo;
	if (a.delete_messages) r |= A::DeleteMessages;
	if (a.ban_users) r |= A::BanUsers;
	if (a.invite_users) r |= A::InviteByLinkOrAdd;
	if (a.pin_messages) r |= A::PinMessages;
	if (a.add_admins) r |= A::AddAdmins;
	return r;
}

// Применить сведения группы (из group.list/group.info или нотиса) к чату:
// имя, состав, ротация ключа, роль и права своего участника, права по
// умолчанию, описание, фото. Ревизия ниже известной — пропуск (GROUP-1).
// Возвращает true, если сведения применены.
bool ApplyGroupInfo(
		not_null<Main::Session*> session,
		const parvane::GroupInfo &gi,
		const QString &source) {
	const auto gid = QString::fromStdString(gi.group_id);
	// Группа v2: сведения — только из подписанного журнала (FR-028). Нотис или
	// список v1-шарда о ней (сервер мог бы подменить состав, роли, права) не
	// применяются — найдено сценарием verify_conformance_group.sh (T135).
	if (parvane::v2::isGroupAddress(gi.group_id) && !source.startsWith(u"v2"_q)) {
		LOG(("Parvane: сведения группы %1 из v1 (%2) отброшены — группа v2 ведётся по журналу")
			.arg(gid, source));
		return false;
	}
	// Группа v1, уже переведённая в v2 (T180): её ведёт журнал группы v2
	if (IsMigratedGroup(gid)) {
		return false;
	}
	if (!parvane::v2::isGroupAddress(gi.group_id)) {
		MigrateGroupIfOwner(gi);
	}
	if (gid.isEmpty()) {
		return false;
	}
	const auto known = g_groupVersions.constFind(gid);
	if (known != g_groupVersions.constEnd() && gi.version < known.value()) {
		LOG(("Parvane: нотис группы %1 устарел (v%2 < v%3), пропущен")
			.arg(gid).arg(gi.version).arg(known.value()));
		return false;
	}
	g_groupVersions.insert(gid, gi.version);
	g_groupInfo.insert(gid, gi);

	QStringList mem;
	std::string selfRole;
	parvane::AdminRights selfRights;
	const auto self = SelfAddress().toStdString();
	for (const auto &m : gi.members) {
		if (m.role != "banned") {
			mem.push_back(QString::fromStdString(m.address));
		}
		if (m.address == self) {
			selfRole = m.role;
			selfRights = m.effectiveRights();
		}
	}
	const auto chat = ensureGroupChat(session, gid, QString::fromStdString(gi.name), mem.size());
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_groupMembers.insert(gid, mem);
	}
	std::vector<std::string> recipients;
	for (const auto &member : mem) {
		recipients.push_back(member.toStdString());
	}
	// Группа v2: ключи — эпохи движка (новая эпоха по записи журнала), не Megolm v1.
	if (!parvane::v2::isGroupAddress(gi.group_id)
			&& parvane::e2e::groupSyncRecipients(gid.toStdString(), recipients)) {
		LOG(("Parvane: участник выбыл из %1 → ротация ключа группы").arg(gid));
	}
	if (!chat) {
		return true;
	}
	// spec 004: нативные списки «Участники»/«Администраторы» читают
	// chat->participants/admins/creator; без них tdesktop уходит в
	// updateFullForced → MTProto (FAIL-1) и крутит спиннер вечно. Ставим
	// напрямую, а не через Data::ApplyChatUpdate(MTPChatParticipants): тот
	// перетирает гранулярные права self полным набором.
	{
		auto participants = base::flat_set<not_null<UserData*>>();
		auto admins = base::flat_set<not_null<UserData*>>();
		auto creator = UserId(0);
		for (const auto &m : gi.members) {
			if (m.role == "banned") {
				continue;
			}
			const auto address = QString::fromStdString(m.address);
			const auto user = ensurePeerUser(session, IdForAddress(address), address);
			participants.emplace(user);
			if (m.role == "admin") {
				admins.emplace(user);
			} else if (m.role == "owner") {
				creator = peerToUser(user->id);
			}
		}
		chat->participants = std::move(participants);
		chat->admins = std::move(admins);
		chat->creator = creator;
		chat->count = mem.size();
	}
	// Роль и права своего участника: владелец — Creator, админ — гранулярные
	// права; по ним tdesktop сам решает, что показывать в меню и композере.
	if (selfRole == "owner") {
		chat->addFlags(ChatDataFlag::Creator);
		chat->setAdminRights(adminRightsFrom(parvane::AdminRights{}));
	} else {
		chat->removeFlags(ChatDataFlag::Creator);
		chat->setAdminRights(selfRole == "admin"
			? adminRightsFrom(selfRights)
			: ChatAdminRights());
	}
	// Права по умолчанию только у групп: в канале пишут владелец и админы.
	chat->setDefaultRestrictions(gi.kind == "channel"
		? ChatRestrictions()
		: restrictionsFromPerms(gi.default_permissions));
	chat->setAbout(QString::fromStdString(gi.about));
	// Фото группы — открытый объект cloud, как аватар пользователя.
	const auto avatar = QString::fromStdString(gi.avatar);
	if (!avatar.isEmpty()) {
		NoteAvatar(gid, avatar);
		applyAvatar(chat, gid);
	} else if (g_avatarFileIds.contains(gid)) {
		g_avatarFileIds.remove(gid);
		g_avatarImages.remove(gid);
		chat->setPhoto(MTP_chatPhotoEmpty());
	}
	// Счётчик заявок — ПОСЛЕ setAdminRights: тот сбрасывает его в 0, если у
	// self нет права на ссылки (data_chat.cpp). Владельцу/админам сервер
	// отдаёт число, остальным -1 → 0.
	chat->setPendingRequestsCount(
		gi.pending_requests > 0 ? gi.pending_requests : 0,
		std::vector<UserId>());
	chat->fullUpdated();
	session->changes().peerUpdated(chat, Data::PeerUpdate::Flag::Rights
		| Data::PeerUpdate::Flag::About
		| Data::PeerUpdate::Flag::Members
		| Data::PeerUpdate::Flag::Admins
		| Data::PeerUpdate::Flag::PendingRequests);
	auto adminsLog = QStringList();
	for (const auto &m : gi.members) {
		if (m.role != "admin") {
			continue;
		}
		const auto r = m.effectiveRights();
		adminsLog.push_back(QString::fromStdString(m.address) + ':'
			+ (r.change_info ? 'c' : '-') + (r.delete_messages ? 'd' : '-')
			+ (r.ban_users ? 'b' : '-') + (r.invite_users ? 'i' : '-')
			+ (r.pin_messages ? 'p' : '-') + (r.add_admins ? 'a' : '-'));
	}
	LOG(("Parvane: группа %1 обновлена (v%2, %3) about=%4 avatar=%5 perms=%6 role=%7 pending=%8 admins=%9")
		.arg(gid)
		.arg(gi.version)
		.arg(source)
		.arg(QString::fromStdString(gi.about))
		.arg(avatar.isEmpty() ? u"-"_q : avatar)
		.arg(QString::fromStdString(gi.default_permissions.toJson().dump()))
		.arg(QString::fromStdString(selfRole))
		.arg(gi.pending_requests > 0 ? gi.pending_requests : 0)
		.arg(adminsLog.isEmpty() ? u"-"_q : adminsLog.join(';')));
	return true;
}

} // namespace

// ── spec 004: доступ к кэшу сведений группы (main-поток), публичные функции
// экранов управления (объявлены в parvane_client.h) ───────────────────────
std::optional<parvane::GroupInfo> GroupInfoFor(const QString &gid) {
	const auto it = g_groupInfo.constFind(gid);
	return (it == g_groupInfo.constEnd())
		? std::nullopt
		: std::optional<parvane::GroupInfo>(it.value());
}

QString GroupRoleOf(const QString &gid, const QString &address) {
	const auto it = g_groupInfo.constFind(gid);
	if (it == g_groupInfo.constEnd()) {
		return QString();
	}
	const auto a = address.toStdString();
	for (const auto &m : it.value().members) {
		if (m.address == a) {
			return QString::fromStdString(m.role);
		}
	}
	return QString();
}

parvane::AdminRights GroupAdminRightsOf(const QString &gid, const QString &address) {
	const auto it = g_groupInfo.constFind(gid);
	if (it != g_groupInfo.constEnd()) {
		const auto a = address.toStdString();
		for (const auto &m : it.value().members) {
			if (m.address == a) {
				return (m.role == "admin" || m.role == "owner")
					? m.effectiveRights()
					: parvane::AdminRights::none();
			}
		}
	}
	return parvane::AdminRights::none();
}

ChatAdminRights GroupMemberAdminRights(const QString &gid, const QString &address) {
	return adminRightsFrom(GroupAdminRightsOf(gid, address));
}

int GroupPendingRequests(const QString &gid) {
	const auto it = g_groupInfo.constFind(gid);
	return (it == g_groupInfo.constEnd() || it.value().pending_requests < 0)
		? 0
		: it.value().pending_requests;
}

// ── spec 004: общий воркер операций управления группой ───────────────────────
// Берёт клиент и токен под мьютексом, зовёт op на воркере, логирует маркер
// «Parvane: <tag> → ok (vN)» либо «… → отказ <код>», на main — RefreshGroups
// при успехе и done(ok, error). error = error_code сервера, иначе текст.
struct GroupOpResult {
	bool ok = false;
	quint64 version = 0;
	QString error;
};
[[nodiscard]] GroupOpResult normalizeOp(const parvane::GroupVersionResponse &r) {
	return { r.ok, r.version, QString::fromStdString(
		!r.error_code.empty() ? r.error_code : r.error) };
}
[[nodiscard]] GroupOpResult normalizeOp(const parvane::GroupActionResponse &r) {
	return { r.ok, 0, QString::fromStdString(
		!r.error_code.empty() ? r.error_code : r.error) };
}
template <typename Op>
void runGroupOp(const QString &tag, Op op, GroupOpDone done) {
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g = g_groupClient.get();
		}
		auto result = GroupOpResult();
		if (!g || token.empty()) {
			result.error = u"нет сессии"_q;
		} else {
			try {
				result = normalizeOp(op(*g, token));
			} catch (const std::exception &e) {
				result.error = QString::fromUtf8(e.what());
			}
		}
		if (result.ok) {
			LOG(("Parvane: %1 → ok (v%2)").arg(tag).arg(result.version));
		} else {
			LOG(("Parvane: %1 → отказ %2").arg(tag, result.error));
		}
		crl::on_main([=] {
			if (result.ok) {
				RefreshGroups();
			}
			if (done) {
				done(result.ok, result.error);
			}
		});
	});
}

// gid по имени группы (для e2e-хуков PARVANE_AUTOGROUP*). "" — не найдена.
[[nodiscard]] QString findGroupIdByName(const QString &name) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	for (auto it = g_knownGroups.constBegin(); it != g_knownGroups.constEnd(); ++it) {
		if (it.value() == name) {
			return it.key();
		}
	}
	return QString();
}

// Группа v2: set_info целиком (имя/описание/фото — одна запись журнала).
[[nodiscard]] nlohmann::json V2SetInfo(
		const nlohmann::json &info,
		std::optional<std::string> name,
		std::optional<std::string> about,
		std::optional<std::string> avatar) {
	if (!info.is_object()) {
		return nullptr;
	}
	// Только изменяемые поля: остальные сессия берёт из журнала атомарно с
	// записью (иначе название и описание с одного экрана откатывали друг друга)
	auto patch = nlohmann::json::object();
	if (name) patch["name"] = *name;
	if (about) patch["about"] = *about;
	if (avatar) patch["avatar_file_id"] = *avatar;
	return { { "set_info_patch", std::move(patch) } };
}

[[nodiscard]] nlohmann::json V2MemberRef(const QString &member) {
	return { { "member", { { "address", member.toStdString() } } } };
}

// ── US1: описание и фото группы ──────────────────────────────────────────────
void SetGroupAbout(const QString &groupId, const QString &about, GroupOpDone done) {
	// Схема v2 меряет описание байтами (1024) — предел в символах, как у
	// v1-шарда (255), держит клиент: поведение экрана одно для обеих версий.
	if (parvane::v2::isGroupAddress(groupId.toStdString()) && about.toUcs4().size() > 255) {
		LOG(("Parvane: SETINFO about '%1' → отказ bad_request (описание длиннее 255 символов)").arg(groupId));
		if (done) {
			done(false, u"bad_request"_q);
		}
		return;
	}
	if (RunV2GroupChange(u"SETINFO about '%1'"_q.arg(groupId), groupId, [text = about.toStdString()](const nlohmann::json &info) {
			return V2SetInfo(info, std::nullopt, text, std::nullopt);
		}, done)) {
		return;
	}
	const auto gid = groupId.toStdString();
	const auto text = about.toStdString();
	runGroupOp(u"SETINFO about '%1'"_q.arg(groupId), [gid, text](parvane::GroupClient &g, const std::string &token) {
		return g.setInfo(token, gid, text, std::nullopt, false);
	}, std::move(done));
}

void ClearGroupPhoto(const QString &groupId, GroupOpDone done) {
	if (RunV2GroupChange(u"SETINFO clear_avatar '%1'"_q.arg(groupId), groupId, [](const nlohmann::json &info) {
			return V2SetInfo(info, std::nullopt, std::nullopt, std::string());
		}, done)) {
		return;
	}
	const auto gid = groupId.toStdString();
	runGroupOp(u"SETINFO clear_avatar '%1'"_q.arg(groupId), [gid](parvane::GroupClient &g, const std::string &token) {
		return g.setInfo(token, gid, std::nullopt, std::nullopt, true);
	}, std::move(done));
}

// ── US3: гранулярные права админа ────────────────────────────────────────────
// Нативные права tdesktop → 6 флагов провода (остальные нативные флаги
// у наших групп не имеют смысла и отбрасываются).
[[nodiscard]] parvane::AdminRights adminRightsToWire(ChatAdminRights r) {
	using A = ChatAdminRight;
	auto a = parvane::AdminRights::none();
	a.change_info = (r & A::ChangeInfo) != 0;
	a.delete_messages = (r & A::DeleteMessages) != 0;
	a.ban_users = (r & A::BanUsers) != 0;
	a.invite_users = (r & A::InviteByLinkOrAdd) != 0;
	a.pin_messages = (r & A::PinMessages) != 0;
	a.add_admins = (r & A::AddAdmins) != 0;
	return a;
}

QString AddressForUser(not_null<UserData*> user) {
	return AddressForId(std::uint64_t(peerToUser(user->id).bare));
}

void SetGroupAdmin(const QString &groupId, const QString &member, ChatAdminRights rights, bool demote, GroupOpDone done) {
	const auto gid = groupId.toStdString();
	const auto mem = member.toStdString();
	const auto wire = adminRightsToWire(rights);
	const auto isPromotion = !demote && (wire.change_info || wire.delete_messages || wire.ban_users
		|| wire.invite_users || wire.pin_messages || wire.add_admins);
	const auto opt = isPromotion ? std::optional<parvane::AdminRights>(wire) : std::nullopt;
	if (RunV2GroupChange(u"SETADMIN '%1' %2 %3"_q.arg(groupId, member, isPromotion ? u"rights"_q : u"demote"_q),
			groupId, [member, isPromotion, wire](const nlohmann::json &) {
				return nlohmann::json{ { "set_role", {
					{ "member", { { "address", member.toStdString() } } },
					{ "role", isPromotion ? "ROLE_ADMIN" : "ROLE_MEMBER" },
					{ "rights", isPromotion ? wire.toJson() : nlohmann::json::object() } } } };
			}, done)) {
		return;
	}
	runGroupOp(u"SETADMIN '%1' %2 %3"_q.arg(groupId, member, isPromotion ? u"rights"_q : u"demote"_q),
		[gid, mem, opt](parvane::GroupClient &g, const std::string &token) {
			return g.setAdmin(token, gid, mem, opt);
		}, std::move(done));
}

// ── US2: права по умолчанию ──────────────────────────────────────────────────
void SetGroupPerms(const QString &groupId, ChatRestrictions rights, GroupOpDone done) {
	const auto gid = groupId.toStdString();
	const auto perms = permsFromRestrictions(rights);
	if (RunV2GroupChange(u"SETPERMS '%1'"_q.arg(groupId), groupId, [perms](const nlohmann::json &) {
			return nlohmann::json{ { "set_permissions", { { "default_permissions", perms.toJson() } } } };
		}, done)) {
		return;
	}
	runGroupOp(u"SETPERMS '%1'"_q.arg(groupId), [gid, perms](parvane::GroupClient &g, const std::string &token) {
		return g.setPerms(token, gid, perms);
	}, std::move(done));
}

// Фото группы — открытый объект cloud, как аватар пользователя (SetOwnAvatar):
// JPEG → cloud (public) на воркере → group.setinfo{avatar_file_id}; локально
// фото применит ApplyGroupInfo по нотису («аватар применён для <gid>»).
void SetGroupPhoto(const QString &groupId, const QImage &image, GroupOpDone done) {
	if (image.isNull()) {
		if (done) {
			done(false, u"bad_request"_q);
		}
		return;
	}
	auto bytes = QByteArray();
	{
		QBuffer buf(&bytes);
		buf.open(QIODevice::WriteOnly);
		image.save(&buf, "JPG", 87);
	}
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto bytesStd = std::string(bytes.constData(), bytes.size());
	const auto gid = groupId.toStdString();
	crl::async([=] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		std::string fileId;
		if (t && !bytesStd.empty()) {
			try {
				parvane::CloudClient cloud(*t);
				fileId = cloud.upload(from, token, "group.jpg", "image/jpeg", bytesStd, {}, true);
			} catch (const std::exception &e) {
				LOG(("Parvane: фото группы %1 не загружено: %2")
					.arg(groupId, QString::fromUtf8(e.what())));
			}
		}
		if (fileId.empty()) {
			crl::on_main([done] {
				if (done) {
					done(false, u"upload_failed"_q);
				}
			});
			return;
		}
		if (RunV2GroupChange(u"SETINFO avatar '%1'"_q.arg(groupId), groupId, [fileId](const nlohmann::json &info) {
				return V2SetInfo(info, std::nullopt, std::nullopt, fileId);
			}, done)) {
			return;
		}
		runGroupOp(u"SETINFO avatar '%1'"_q.arg(groupId), [gid, fileId](parvane::GroupClient &g, const std::string &token) {
			return g.setInfo(token, gid, std::nullopt, fileId, false);
		}, done);
	});
}

namespace {

// Группа удалена или нас удалили/забанили (нотис removed/deleted): убрать из
// реестров и пометить чат покинутым — tdesktop прячет его из списка.
void DropGroupLocally(not_null<Main::Session*> session, const QString &gid, const QString &why) {
	if (IsMigratedGroup(gid)) {
		return; // нотис v1 о группе, переведённой в v2 (T180): чат продолжается по v2
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_knownGroups.remove(gid);
		g_groupMembers.remove(gid);
	}
	g_groupVersions.remove(gid);
	const auto chatId = IdForAddress(gid);
	if (const auto chat = session->data().chatLoaded(ChatId(BareId(chatId)))) {
		chat->addFlags(ChatDataFlag::Left);
		session->data().history(chat)->clear(History::ClearType::DeleteChat);
	}
	LOG(("Parvane: группа %1 снята (%2)").arg(gid, why));
}

QString GroupIdByName(const QString &name) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	for (auto it = g_knownGroups.constBegin(); it != g_knownGroups.constEnd(); ++it) {
		if (it.value() == name) {
			return it.key();
		}
	}
	return QString();
}

// personal_channel из identity — group_id группы Parvane. Личный канал в
// UserData — ChannelId с bare = IdForAddress(group_id) (см.
// Info::Profile::PersonalChannelValue: ищет ChatData по этому id). Если группа
// ещё не известна (не участник / group.list не пришёл) — запомним и
// перерисуем, когда ensureGroupChat её синтезирует.
void ApplyPersonalChannel(not_null<UserData*> user, const QString &gid) {
	if (gid.isEmpty()) {
		user->setPersonalChannel(ChannelId(), MsgId());
		return;
	}
	const auto id = IdForAddress(gid);
	auto known = false;
	auto name = QString();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		known = g_knownGroups.contains(gid);
		name = g_knownGroups.value(gid);
		if (!known) {
			g_personalChannelUsers[gid].insert(std::uint64_t(peerToUser(user->id).bare));
		}
	}
	if (known) {
		ensureGroupChat(&user->session(), gid, name, 0);
	}
	user->setPersonalChannel(ChannelId(BareId(id)), MsgId());
}

not_null<UserData*> ensurePeerUser(
		not_null<Main::Session*> session,
		std::uint64_t id,
		const QString &address) {
	const auto existed = (session->data().userLoaded(
		UserId(BareId(id))) != nullptr);
	// Отображаемое имя = display_name (каталог); @username = адрес (уникален).
	// f_first_name/f_username ОБЯЗАТЕЛЬНЫ: без них processUser игнорирует поля.
	auto flags = MTPDuser::Flags()
		| MTPDuser::Flag::f_first_name
		| MTPDuser::Flag::f_username;
	if (address == SelfAddress()) {
		flags |= MTPDuser::Flag::f_self;
	}
	// Профиль (имя + аватар) спрашиваем у каталога, если не спрашивали вовсе
	// либо ответ устарел. Условие «имя неизвестно» здесь было ошибкой: после
	// первого резолва имя известно всегда, и смена аватара уже не подхватывалась.
	// Свой адрес — тоже: аватар/bio, изменённые в вебе, иначе подхватывались
	// только одним запросом на старте, без повтора при его сбое (10 сен 2026).
	{
		const auto now = crl::now();
		const auto last = g_resolvedAt.value(address, 0);
		if (!last || now - last > kProfileTtlMs) {
			g_resolvedAt.insert(address, now);
			ResolveNames({ address });
		}
	}
	const auto user = MTP_user(
		MTP_flags(flags),
		MTP_long(id),
		MTPlong(),                    // access_hash
		MTP_string(DisplayNameFor(address)), // first_name — отображаемое имя
		MTPstring(),                  // last_name
		MTP_string(address),          // username — уникальный адрес (@handle)
		MTPstring(),                  // phone
		MTPUserProfilePhoto(),
		MTPUserStatus(),
		MTPint(),            // bot_info_version
		MTPVector<MTPRestrictionReason>(),
		MTPstring(),         // bot_inline_placeholder
		MTPstring(),         // lang_code
		MTPEmojiStatus(),
		MTPVector<MTPUsername>(),
		MTPRecentStory(),
		MTPPeerColor(),      // color
		MTPPeerColor(),      // profile_color
		MTPint(),            // bot_active_users
		MTPlong(),           // bot_verification_icon
		MTPlong());          // send_paid_messages_stars
	const auto result = session->data().processUser(user);

	// Делаем unreadCount диалога ИЗВЕСТНЫМ (=0 при первом касании). Иначе при
	// входящем tdesktop видит unreadCountKnown()==false и вместо инкремента
	// бейджа шлёт dialogs.getDialogs в MTProto (заглушён, не вернётся) → бейдж
	// непрочитанного не появляется. Входящие уже «server-side unread»
	// (_inboxReadBefore не задан), поэтому после этого бейдж считается штатно.
	if (!existed && address != SelfAddress()) {
		const auto history = session->data().history(result);
		// setUnreadCount требует folderKnown() (assert) — сперва помечаем папку
		// известной (как инъекция входящих), потом делаем счётчик известным.
		if (!history->folderKnown()) {
			history->clearFolder();
		}
		if (!history->unreadCountKnown()) {
			history->setUnreadCount(0);
		}
	}
	// processUser выше стёр userpic пустым фото — возвращаем аватар из кэша.
	applyAvatar(result, address);
	// Блок-лист с диска/из журнала состояния (T132): флаг живёт только в памяти
	// tdesktop, после рестарта его возвращаем при первом появлении пользователя.
	if (g_blockedAddrs.contains(address) && !result->isBlocked()) {
		result->setIsBlocked(true);
	}
	// E2E: ключ безопасности в bio профиля — ручная верификация против MITM.
	// Формат тот же, что в веб-клиенте (отпечаток SHA-256 identity-ключа
	// каждого устройства собеседника), чтобы сверять между клиентами. Появляется,
	// как только известен каталог/identity контакта. Нативный профиль рендерит about().
	if (const auto rootFp = (address != SelfAddress()) ? V2RootFingerprint(address) : QString();
			!rootFp.isEmpty()) {
		// Собеседник на v2: ключ безопасности — отпечаток корня его личности
		// (сверяется с «своим ключом v2» на его устройстве)
		const auto about = u"\xF0\x9F\x94\x92 Ключ безопасности (сверьте с устройством собеседника):\n"_q + rootFp;
		if (result->setAbout(about)) {
			LOG(("Parvane: ключ безопасности с %1 в профиле: %2").arg(address, rootFp));
		}
	} else if (address != SelfAddress()) {
		const auto fps = parvane::e2e::contactFingerprints(address.toStdString());
		if (!fps.empty()) {
			auto about = u"\xF0\x9F\x94\x92 Ключ безопасности (сверьте с устройством собеседника):"_q;
			for (const auto &fp : fps) {
				about += u"\n"_q + QString::fromStdString(fp.fingerprint);
			}
			// setAbout вернёт true только при реальном изменении → лог однократно.
			if (result->setAbout(about)) {
				// Все устройства: после переустановки у собеседника их два (старое
				// не отозвано), порядок — по device_id, первым бывает и старое.
				auto all = QStringList();
				for (const auto &fp : fps) {
					all.push_back(QString::fromStdString(fp.fingerprint));
				}
				LOG(("Parvane: ключ безопасности с %1 в профиле: %2")
					.arg(address, all.join(u"; "_q)));
			}
		}
	}
	// TTL самоуничтожения чата (нативное меню показывает таймер по messagesTTL).
	if (const auto ttl = PeerTtl(address); ttl > 0 && result->messagesTTL() != ttl) {
		result->setMessagesTTL(TimeId(ttl));
	}
	return result;
}

// Резолвит отображаемые имена по адресам (identity.user.resolve) и обновляет
// уже синтезированных юзеров. Воркер → main.
void ResolveNames(const QStringList &addresses) {
	if (addresses.isEmpty()) {
		return;
	}
	auto arr = parvane::json::array();
	for (const auto &a : addresses) {
		arr.push_back(a.toStdString());
	}
	const auto reqStr = parvane::json{ { "usernames", arr } }.dump();
	crl::async([reqStr] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		auto names = QHash<QString, QString>();
		auto avatars = QHash<QString, QString>();
		auto profiles = QHash<QString, QString>(); // адрес → UserInfo JSON (bio/birthday/…)
		try {
			const auto reply = t->request(
				parvane::topics::IdentityResolve, reqStr, 3000);
			const auto j = parvane::json::parse(reply);
			if (j.contains("users") && j["users"].is_array()) {
				for (const auto &u : j["users"]) {
					if (!u.contains("username")) {
						continue;
					}
					const auto addr = QString::fromStdString(
						u["username"].get<std::string>());
					if (u.contains("display_name")) {
						names.insert(addr, QString::fromStdString(
							u["display_name"].get<std::string>()));
					}
					if (u.contains("avatar") && u["avatar"].is_string()) {
						avatars.insert(addr, QString::fromStdString(
							u["avatar"].get<std::string>()));
					}
					profiles.insert(addr, QString::fromStdString(u.dump()));
					// Публичный ключ звонков → кэш для проверки подписи SDP.
					if (u.contains("pubkey") && u["pubkey"].is_string()) {
						const auto pk = u["pubkey"].get<std::string>();
						if (!pk.empty()) {
							std::lock_guard<std::mutex> lk(g_pubkeyMutex);
							g_peerPubkeys.insert(addr, QString::fromStdString(pk));
						}
					}
				}
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: identity.user.resolve не удался (%1): %2")
				.arg(QString::fromStdString(reqStr).left(120))
				.arg(QString::fromUtf8(e.what())));
			return;
		}
		if (names.isEmpty() && avatars.isEmpty() && profiles.isEmpty()) {
			LOG(("Parvane: identity.user.resolve — пустой ответ на %1")
				.arg(QString::fromStdString(reqStr).left(120)));
			return;
		}
		crl::on_main([names, avatars, profiles] {
			const auto session = g_sessionWeak.get();
			if (!session) {
				return;
			}
			for (auto it = names.constBegin(); it != names.constEnd(); ++it) {
				g_displayNames.insert(it.key(), it.value());
				const auto id = IdForAddress(it.key());
				if (session->data().userLoaded(UserId(BareId(id)))) {
					ensurePeerUser(session, id, it.key()); // обновит имя
				}
			}
			for (auto it = avatars.constBegin(); it != avatars.constEnd(); ++it) {
				NoteAvatar(it.key(), it.value());
			}
			// Профильные поля из identity (bio, дата рождения, телефон, цвет
			// имени) — в синтезированный UserData; свои тоже (настройки их
			// показывают через Info::Profile::*Value).
			for (auto it = profiles.constBegin(); it != profiles.constEnd(); ++it) {
				const auto user = session->data().userLoaded(
					UserId(BareId(IdForAddress(it.key()))));
				if (!user) {
					if (it.key() == SelfAddress()) {
						LOG(("Parvane: свой профиль пришёл, но self не загружен (%1)")
							.arg(it.key()));
					}
					continue;
				}
				const auto j = nlohmann::json::parse(it.value().toStdString(), nullptr, false);
				if (!j.is_object()) {
					continue;
				}
				if (j.contains("bio") && j["bio"].is_string()) {
					user->setAbout(QString::fromStdString(j["bio"].get<std::string>()));
				}
				if (j.contains("birthday") && j["birthday"].is_string()) {
					const auto parts = QString::fromStdString(
						j["birthday"].get<std::string>()).split('-');
					user->setBirthday((parts.size() == 3)
						? Data::Birthday(parts[2].toInt(), parts[1].toInt(), parts[0].toInt())
						: Data::Birthday());
				}
				if (j.contains("phone") && j["phone"].is_string()) {
					user->setPhone(QString::fromStdString(j["phone"].get<std::string>()));
				}
				if (j.contains("name_color") && j["name_color"].is_number_integer()) {
					const auto color = j["name_color"].get<int>();
					if (color >= 0 && color < 256) {
						user->changeColorIndex(uint8(color));
					} else if (color < 0) {
						user->clearColorIndex(); // сброшен на цвет по умолчанию
					}
				}
				if (j.contains("personal_channel") && j["personal_channel"].is_string()) {
					ApplyPersonalChannel(user, QString::fromStdString(
						j["personal_channel"].get<std::string>()));
				}
				const auto str = [&](const char *key) {
					return (j.contains(key) && j[key].is_string())
						? QString::fromStdString(j[key].get<std::string>())
						: QString();
				};
				LOG(("Parvane: профиль %1: bio=%2 phone=%3 color=%4 channel=%5 birthday=%6")
					.arg(it.key(), str("bio"), str("phone"))
					.arg((j.contains("name_color") && j["name_color"].is_number_integer())
						? j["name_color"].get<int>()
						: -1)
					.arg(str("personal_channel"), str("birthday")));
			}
		});
	});
}

// Строит MTPMessage в 1-на-1 диалоге. authorId — автор (from_id), peerId —
// собеседник (peer_id диалога), out — исходящее (наше). Для входящих
// authorId==peerId==отправитель, out=false; для СВОИХ (восстановление истории
// после рестарта) authorId=self, peerId=получатель, out=true.
// ── Форматирование текста (entities): tdesktop ↔ наш JSON ────────────────────
// offset/length — в UTF-16 (как у Telegram). Маппим типы имя↔enum; сама
// конвертация в MTP делается родным Api::EntitiesToMTP (на приёме).
[[nodiscard]] QString entityKindName(EntityType t) {
	switch (t) {
	case EntityType::Bold: return u"bold"_q;
	case EntityType::Italic: return u"italic"_q;
	case EntityType::Underline: return u"underline"_q;
	case EntityType::StrikeOut: return u"strike"_q;
	case EntityType::Code: return u"code"_q;
	case EntityType::Pre: return u"pre"_q;
	case EntityType::Blockquote: return u"blockquote"_q;
	case EntityType::Spoiler: return u"spoiler"_q;
	case EntityType::CustomUrl: return u"text_url"_q;
	case EntityType::Mention: return u"mention"_q;
	case EntityType::CustomEmoji: return u"custom_emoji"_q;
	default: return QString();
	}
}
[[nodiscard]] EntityType entityKindFromName(const QString &n) {
	if (n == u"bold"_q) return EntityType::Bold;
	if (n == u"italic"_q) return EntityType::Italic;
	if (n == u"underline"_q) return EntityType::Underline;
	if (n == u"strike"_q) return EntityType::StrikeOut;
	if (n == u"code"_q) return EntityType::Code;
	if (n == u"pre"_q) return EntityType::Pre;
	if (n == u"blockquote"_q) return EntityType::Blockquote;
	if (n == u"spoiler"_q) return EntityType::Spoiler;
	if (n == u"text_url"_q) return EntityType::CustomUrl;
	if (n == u"mention"_q) return EntityType::Mention;
	// Кастом-эмодзи: data = документ-id. Рендерится, если документ локально
	// доступен (CustomEmojiManager резолвит без MTProto — как стикер); иначе
	// деградирует в запасной символ. Полноценная панель-автор/обмен паками —
	// отдельная крупная работа (см. PARITY).
	if (n == u"custom_emoji"_q) return EntityType::CustomEmoji;
	return EntityType::Invalid;
}
// EntitiesInText → JSON-массив (для отправки в content).
[[nodiscard]] nlohmann::json entitiesToJson(const EntitiesInText &entities) {
	auto arr = nlohmann::json::array();
	for (const auto &e : entities) {
		const auto name = entityKindName(e.type());
		if (name.isEmpty()) {
			continue;
		}
		nlohmann::json o;
		o["type"] = name.toStdString();
		o["offset"] = e.offset();
		o["length"] = e.length();
		if (!e.data().isEmpty()) {
			o["data"] = e.data().toStdString();
		}
		arr.push_back(std::move(o));
	}
	return arr;
}
// JSON-массив → EntitiesInText (для приёма).
[[nodiscard]] EntitiesInText entitiesFromJson(const nlohmann::json &arr) {
	auto result = EntitiesInText();
	if (!arr.is_array()) {
		return result;
	}
	for (const auto &o : arr) {
		if (!o.is_object()) {
			continue;
		}
		const auto type = entityKindFromName(
			QString::fromStdString(o.value("type", std::string())));
		if (type == EntityType::Invalid) {
			continue;
		}
		result.push_back(EntityInText(
			type,
			o.value("offset", 0),
			o.value("length", 0),
			QString::fromStdString(o.value("data", std::string()))));
	}
	return result;
}

// content.webpage (OG-превью ссылки) → MTP_messageMediaWebPage. Пусто — если нет.
[[nodiscard]] MTPMessageMedia buildWebpageMedia(const nlohmann::json &wp) {
	if (!wp.is_object() || !wp.contains("url")) {
		return MTPMessageMedia();
	}
	const auto str = [&](const char *k) {
		return (wp.contains(k) && wp[k].is_string())
			? QString::fromStdString(wp[k].get<std::string>())
			: QString();
	};
	const auto url = str("url");
	const auto siteName = str("site_name");
	const auto title = str("title");
	const auto description = str("description");
	using PageFlag = MTPDwebPage::Flag;
	const auto pageFlags = PageFlag(0)
		| (siteName.isEmpty() ? PageFlag(0) : PageFlag::f_site_name)
		| (title.isEmpty() ? PageFlag(0) : PageFlag::f_title)
		| (description.isEmpty() ? PageFlag(0) : PageFlag::f_description);
	const auto id = std::int64_t(
		std::hash<std::string>{}(url.toStdString()) & 0x7fffffffffffffffULL);
	const auto page = MTP_webPage(
		MTP_flags(pageFlags),
		MTP_long(id),
		MTP_string(url),          // url
		MTP_string(url),          // display_url
		MTP_int(0),               // hash
		MTPstring(),              // type
		MTP_string(siteName),     // site_name
		MTP_string(title),        // title
		MTP_string(description),  // description
		MTPPhoto(),               // photo (пока без картинки)
		MTPstring(),              // embed_url
		MTPstring(),              // embed_type
		MTPint(),                 // embed_width
		MTPint(),                 // embed_height
		MTPint(),                 // duration
		MTPstring(),              // author
		MTPDocument(),            // document
		MTPPage(),                // cached_page
		MTP_vector<MTPWebPageAttribute>());
	return MTP_messageMediaWebPage(
		MTP_flags(MTPDmessageMediaWebPage::Flags(0)),
		page);
}

// content kind=location {lat,long[,live_period,heading,accuracy]} →
// MTP_messageMediaGeo / MTP_messageMediaGeoLive (нативный рендер карты и
// таймера live-локации; обновления позиции приходят правкой сообщения).
[[nodiscard]] MTPMessageMedia buildLocationMedia(const nlohmann::json &c) {
	if (!c.is_object() || !c.contains("lat") || !c.contains("long")
		|| !c["lat"].is_number() || !c["long"].is_number()) {
		return MTPMessageMedia();
	}
	const auto accuracy = (c.contains("accuracy") && c["accuracy"].is_number())
		? c["accuracy"].get<int>()
		: 0;
	const auto geo = MTP_geoPoint(
		MTP_flags(accuracy > 0
			? MTPDgeoPoint::Flag::f_accuracy_radius
			: MTPDgeoPoint::Flag(0)),
		MTP_double(c["long"].get<double>()),
		MTP_double(c["lat"].get<double>()),
		MTP_long(0),
		MTP_int(accuracy));
	if (c.contains("live_period") && c["live_period"].is_number()
		&& c["live_period"].get<int>() > 0) {
		const auto hasHeading = c.contains("heading") && c["heading"].is_number();
		LOG(("Parvane: live-локация live_period=%1 lat=%2 long=%3")
			.arg(c["live_period"].get<int>())
			.arg(c["lat"].get<double>(), 0, 'f', 5)
			.arg(c["long"].get<double>(), 0, 'f', 5));
		return MTP_messageMediaGeoLive(
			MTP_flags(hasHeading
				? MTPDmessageMediaGeoLive::Flag::f_heading
				: MTPDmessageMediaGeoLive::Flag(0)),
			geo,
			MTP_int(hasHeading ? c["heading"].get<int>() : 0),
			MTP_int(c["live_period"].get<int>()),
			MTPint());
	}
	return MTP_messageMediaGeo(geo);
}

// TTL (самоуничтожение) сообщения в секундах из content.ttl_secs (0 — нет).
[[nodiscard]] int TtlFromContent(const parvane::json &c) {
	return (c.contains("ttl_secs") && c["ttl_secs"].is_number())
		? c["ttl_secs"].get<int>() : 0;
}

[[nodiscard]] MTPMessage buildMessage(
		std::uint64_t authorId,
		std::uint64_t peerId,
		bool out,
		std::int64_t ts,
		const QString &text,
		const MTPMessageMedia &media = MTPMessageMedia(),
		bool hasMedia = false,
		std::int64_t replyToMsgId = 0,
		bool peerIsChat = false,
		const MTPVector<MTPMessageEntity> &entities = MTPVector<MTPMessageEntity>(),
		int ttlSecs = 0,
		bool mentionsSelf = false) {
	const auto authorPeer = peerFromUser(UserId(BareId(authorId)));
	// Диалог — 1-на-1 (user) или группа (chat). Для группы peerId = chatId.
	const auto dialogPeer = peerIsChat
		? peerFromChat(ChatId(BareId(peerId)))
		: peerFromUser(UserId(BareId(peerId)));
	using Flag = MTPDmessage::Flag;
	const auto hasEntities = (entities.v.size() > 0);
	const auto flags = Flag::f_from_id
		| (out ? Flag::f_out : Flag(0))
		| (hasMedia ? Flag::f_media : Flag(0))
		| (hasEntities ? Flag::f_entities : Flag(0))
		| (ttlSecs > 0 ? Flag::f_ttl_period : Flag(0)) // самоуничтожение (TTL)
		| (mentionsSelf ? Flag::f_mentioned : Flag(0)) // «вас упомянули»
		| (replyToMsgId ? Flag::f_reply_to : Flag(0));
	const auto replyHeader = replyToMsgId
		? MTP_messageReplyHeader(
			MTP_flags(MTPDmessageReplyHeader::Flag::f_reply_to_msg_id),
			MTP_int(int(replyToMsgId)),
			MTPPeer(),                      // reply_to_peer_id
			MTPMessageFwdHeader(),          // reply_from
			MTPMessageMedia(),              // reply_media
			MTPint(),                       // reply_to_top_id
			MTPstring(),                    // quote_text
			MTPVector<MTPMessageEntity>(),  // quote_entities
			MTPint(),                       // quote_offset
			MTPint(),                       // todo_item_id
			MTPbytes())                     // poll_option
		: MTPMessageReplyHeader();
	return MTP_message(
		MTP_flags(flags),
		MTP_int(0),                 // id (override через addNewMessage)
		peerToMTP(authorPeer),      // from_id — автор
		MTPint(),                   // from_boosts_applied
		MTPstring(),                // from_rank
		peerToMTP(dialogPeer),      // peer_id — диалог с собеседником
		MTPPeer(),                  // saved_peer_id
		MTPMessageFwdHeader(),      // fwd_from
		MTPlong(),                  // via_bot_id
		MTPlong(),                  // via_business_bot_id
		MTPPeer(),                  // guestchat_via_from
		replyHeader,                // reply_to
		MTP_int(int(ts)),           // date
		MTP_string(text),           // message (для медиа — caption)
		media,
		MTPReplyMarkup(),
		entities,                   // форматирование (bold/italic/code/…)
		MTPint(),                   // views
		MTPint(),                   // forwards
		MTPMessageReplies(),
		MTPint(),                   // edit_date
		MTPstring(),                // post_author
		MTPlong(),                  // grouped_id
		MTPMessageReactions(),
		MTPVector<MTPRestrictionReason>(),
		ttlSecs > 0 ? MTP_int(ttlSecs) : MTPint(), // ttl_period (self-destruct)
		MTPint(),                   // quick_reply_shortcut_id
		MTPlong(),                  // effect
		MTPFactCheck(),
		MTPint(),                   // report_delivery_until_date
		MTPlong(),                  // paid_message_stars
		MTPSuggestedPost(),
		MTPint(),                   // schedule_repeat_period
		MTPstring(),                // summary_from_language
		MTPRichMessage());
}

// ── приём медиа (Фаза 4b) ──────────────────────────────────────────────────

// FNV-1a 64 → стабильный локальный DocumentId из file_id (детерминированный,
// чтобы processDocument дедупил один и тот же файл между pump'ами).
[[nodiscard]] std::int64_t docIdFromFileId(const QString &fileId) {
	const auto utf8 = fileId.toUtf8();
	std::uint64_t h = 1469598103934665603ULL;
	for (const auto c : utf8) {
		h ^= static_cast<unsigned char>(c);
		h *= 1099511628211ULL;
	}
	return static_cast<std::int64_t>(h);
}

// Скачивает аватар из cloud и ставит его пиру (setUserpic из in-memory картинки,
// как inline-фото). Воркер → main.
void DownloadAvatar(const QString &address, const QString &fileId) {
	const auto self = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto fid = fileId.toStdString();
	const auto id = IdForAddress(address);
	const auto photoId = docIdFromFileId(fileId);
	crl::async([=] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		std::string bytes;
		try {
			parvane::CloudClient cloud(*t);
			auto d = DownloadChatBlob(cloud, self, token, fid, 20000);
			if (!d.ok) {
				return;
			}
			bytes = std::move(d.bytes);
		} catch (const std::exception &) {
			return;
		}
		const auto addressCopy = address;
		crl::on_main([id, bytes, photoId, addressCopy] {
			const auto session = g_sessionWeak.get();
			if (!session) {
				return;
			}
			// Пользователь или группа (spec 003: фото группы — тот же путь)
			PeerData *peer = session->data().userLoaded(UserId(BareId(id)));
			if (!peer) {
				peer = session->data().chatLoaded(ChatId(BareId(id)));
			}
			if (!peer) {
				return;
			}
			const auto qb = QByteArray(bytes.data(), int(bytes.size()));
			auto image = QImage();
			if (!image.loadFromData(qb) || image.isNull()) {
				return;
			}
			g_avatarImages.insert(addressCopy, image); // кэш для повторной установки
			peer->setUserpicInMemory(photoId,
				Images::FromImageInMemory(image, "JPG", qb));
			LOG(("Parvane: аватар применён для %1").arg(addressCopy));
		});
	});
}

// Локальный MTPDocument: без DC-локации (файл лежит на диске, см. setLocation).
// Атрибуты по kind: voice → голосовое (audio+voice), video_note → кружок
// (video+round), video → видео, иначе filename-документ. Тогда UI рисует плеер/
// кружок, а не строку-файл. Длительность/размеры — из контента (0 → дефолты).
[[nodiscard]] MTPDocument buildLocalMtpDocument(
		not_null<Main::Session*> session,
		std::int64_t docId,
		const QString &kind,
		const QString &mime,
		std::int64_t size,
		const QString &filename,
		std::int64_t ts,
		int durationSecs,
		int width,
		int height,
		const QString &localPath = QString()) {
	auto attributes = QVector<MTPDocumentAttribute>();
	if (kind == u"voice"_q) {
		// Голосовое: audio+voice+waveform. Реальную волну считаем из файла
		// (audioCountWaveform); если не вышло — плоский placeholder (пустой ронял
		// рендер через qAbs(min())).
		using AF = MTPDdocumentAttributeAudio::Flag;
		auto wf = VoiceWaveform();
		if (!localPath.isEmpty()) {
			wf = audioCountWaveform(Core::FileLocation(localPath), QByteArray());
		}
		if (wf.isEmpty()) {
			wf.reserve(64);
			for (auto i = 0; i != 64; ++i) {
				wf.push_back(8 + (i % 16));
			}
		}
		const auto encoded = documentWaveformEncode5bit(wf);
		attributes.push_back(MTP_documentAttributeAudio(
			MTP_flags(AF::f_voice | AF::f_waveform),
			MTP_int(durationSecs > 0 ? durationSecs : 1),
			MTPstring(), MTPstring(), MTP_bytes(encoded)));
	} else if (kind == u"video_note"_q) {
		using VF = MTPDdocumentAttributeVideo::Flag;
		const auto w = (width > 0) ? width : 384;
		const auto h = (height > 0) ? height : 384;
		attributes.push_back(MTP_documentAttributeVideo(
			MTP_flags(VF::f_round_message),
			MTP_double(double(durationSecs > 0 ? durationSecs : 1)),
			MTP_int(w), MTP_int(h),
			MTPint(), MTPdouble(), MTPstring()));
	} else if (kind == u"video"_q) {
		const auto w = (width > 0) ? width : 640;
		const auto h = (height > 0) ? height : 480;
		attributes.push_back(MTP_documentAttributeVideo(
			MTP_flags(0),
			MTP_double(double(durationSecs > 0 ? durationSecs : 1)),
			MTP_int(w), MTP_int(h),
			MTPint(), MTPdouble(), MTPstring()));
		attributes.push_back(MTP_documentAttributeFilename(MTP_string(
			filename.isEmpty() ? u"video.mp4"_q : filename)));
	} else if (kind == u"sticker"_q) {
		// Стикер: ImageSize + Sticker-атрибут → нативный рендер стикером.
		const auto w = (width > 0) ? width : 512;
		const auto h = (height > 0) ? height : 512;
		attributes.push_back(MTP_documentAttributeImageSize(
			MTP_int(w), MTP_int(h)));
		attributes.push_back(MTP_documentAttributeSticker(
			MTP_flags(0),
			MTP_string(filename), // alt-эмодзи кладём в filename при отправке
			MTP_inputStickerSetEmpty(),
			MTPMaskCoords()));
	} else if (kind == u"gif"_q) {
		// GIF: video+animated → нативный автоплей «гифки». Имя ОБЯЗАНО иметь
		// видео-расширение: enforceNameType(Video) иначе деградирует тип в
		// FileDocument (рендер файлом).
		const auto w = (width > 0) ? width : 320;
		const auto h = (height > 0) ? height : 240;
		attributes.push_back(MTP_documentAttributeVideo(
			MTP_flags(0),
			MTP_double(double(durationSecs > 0 ? durationSecs : 1)),
			MTP_int(w), MTP_int(h),
			MTPint(), MTPdouble(), MTPstring()));
		attributes.push_back(MTP_documentAttributeAnimated());
		const auto gifName = (filename.isEmpty() || !filename.contains(u'.'))
			? (mime == u"video/mp4"_q
				? u"animation.mp4"_q
				: u"animation.gif"_q)
			: filename;
		attributes.push_back(MTP_documentAttributeFilename(
			MTP_string(gifName)));
	} else {
		attributes.push_back(MTP_documentAttributeFilename(MTP_string(
			filename.isEmpty() ? (kind + u"_file"_q) : filename)));
	}
	return MTP_document(
		MTP_flags(0),
		MTP_long(docId),
		MTP_long(0),                    // access_hash (локальный — не нужен)
		MTP_bytes(),                    // file_reference
		MTP_int(int(ts)),               // date
		MTP_string(mime),
		MTP_long(size),
		MTP_vector<MTPPhotoSize>(),     // thumbs — без превью
		MTPVector<MTPVideoSize>(),
		MTP_int(session->mainDcId()),
		MTP_vector<MTPDocumentAttribute>(attributes));
}

// Индексирует медиа-элемент в SharedMedia С ИЗВЕСТНЫМ счётчиком, чтобы панель
// профиля показывала общие медиа (иначе fullCount неизвестен из-за заглушённого
// messages.getSearchCounters → секция пуста, как в оригинале не выглядит).
// Применяет агрегат реакций из sync к локальному сообщению (updateReactions).
void applyReactions(
		not_null<HistoryItem*> item,
		const std::vector<parvane::ReactionSummary> &reactions) {
	if (reactions.empty()) {
		return;
	}
	auto results = QVector<MTPReactionCount>();
	for (const auto &r : reactions) {
		if (r.emoji.empty() || r.count <= 0) {
			continue;
		}
		using RFlag = MTPDreactionCount::Flag;
		results.push_back(MTP_reactionCount(
			MTP_flags(r.mine ? RFlag::f_chosen_order : RFlag(0)),
			MTP_int(0),
			MTP_reactionEmoji(MTP_string(QString::fromStdString(r.emoji))),
			MTP_int(int(r.count))));
	}
	if (results.isEmpty()) {
		return;
	}
	const MTPMessageReactions mtp = MTP_messageReactions(
		MTP_flags(0),
		MTP_vector<MTPReactionCount>(results),
		MTP_vector<MTPMessagePeerReaction>(),
		MTP_vector<MTPMessageReactor>());
	item->updateReactions(&mtp);
}

// Применяет флаг закрепления из sync к локальному сообщению.
void applyPin(
		not_null<Main::Session*> session,
		not_null<HistoryItem*> item,
		bool pinned) {
	if (item->isPinned() == pinned) {
		return;
	}
	item->setIsPinned(pinned);
	if (pinned) {
		Data::SetTopPinnedMessageId(item->history()->peer, item->id);
	}
	session->data().notifyItemDataChange(item);
}

void indexSharedMediaWithCount(
		not_null<Main::Session*> session,
		not_null<HistoryItem*> item) {
	const auto peerId = item->history()->peer->id;
	const auto types = item->sharedMediaTypes();
	auto &perType = g_sharedMedia[peerId];
	for (auto i = 0; i != Storage::kSharedMediaTypeCount; ++i) {
		const auto type = static_cast<Storage::SharedMediaType>(i);
		if (!types.test(type)) {
			continue;
		}
		auto &ids = perType[i];
		if (std::find(ids.begin(), ids.end(), item->id) == ids.end()) {
			ids.push_back(item->id);
			std::sort(ids.begin(), ids.end());
		}
		auto copy = ids;
		session->storage().add(Storage::SharedMediaAddSlice(
			peerId, MsgId(0), PeerId(0), type,
			std::move(copy),
			MsgRange{ MsgId(1), ids.back() },
			int(ids.size())));
	}
}

// Инъекция уже СКАЧАННОГО медиа-сообщения (main-поток): документ + локальный
// файл + сообщение с media. msgId уже зарезервирован в injectOnMain.
void injectMediaOnMain(
		not_null<Main::Session*> session,
		const QString &from,       // адрес собеседника (диалог)
		std::uint64_t senderId,    // id собеседника (peer_id)
		std::uint64_t authorId,    // from_id (self для исходящих)
		bool out,                  // наше исходящее
		std::int64_t ts,
		MsgId msgId,
		std::int64_t docId,
		const QString &kind,
		const QString &localPath,
		const QString &filename,
		const QString &mime,
		std::int64_t size,
		int durationSecs,
		int width,
		int height,
		const QString &caption,
		bool peerIsChat = false,
		const QString &authorAddr = QString(),
		int ttlSecs = 0) {
	// Диалог: группа (chat) → синтез группы + автор-юзер; иначе 1-на-1 user-пир.
	if (peerIsChat) {
		ensureGroupChat(session, from, g_knownGroups.value(from), 0);
		if (!authorAddr.isEmpty()) {
			ensurePeerUser(session, authorId, authorAddr);
		}
	} else {
		RegisterPeer(from);
		ensurePeerUser(session, senderId, from);
	}

	const auto mtpDoc = buildLocalMtpDocument(
		session, docId, kind, mime, size, filename, ts,
		durationSecs, width, height, localPath);
	using Flag = MTPDmessageMediaDocument::Flag;
	const auto mflags = Flag::f_document
		| ((kind == u"voice"_q) ? Flag::f_voice : Flag(0))
		| ((kind == u"video_note"_q) ? Flag::f_round : Flag(0));
	const auto media = MTP_messageMediaDocument(
		MTP_flags(mflags),
		mtpDoc,
		MTPVector<MTPDocument>(),
		MTPPhoto(),
		MTPint(),
		MTPint());

	// Привязываем локальный файл к документу ДО инъекции сообщения: если чат
	// открыт (tdesktop восстанавливает последний чат при старте), вьюха
	// кружка/гифки автоплеится сразу при addNewMessage — старт стриминга на
	// документе без location проваливается и StreamingPlaybackFailed залипает
	// на всю сессию (кружок навсегда «не скачан»).
	const auto doc = session->data().processDocument(mtpDoc);
	doc->setLocation(Core::FileLocation(localPath));
	// Гифки — в Saved GIFs (вкладка GIFs панели): на реплее журнала список
	// восстанавливается сам, нативный персист не задействуем.
	if (kind == u"gif"_q) {
		session->data().stickers().addSavedGif(nullptr, doc);
	}

	const auto item = session->data().addNewMessage(
		msgId,
		buildMessage(authorId, senderId, out, ts, caption, media,
			/*hasMedia=*/true, 0, peerIsChat,
			MTPVector<MTPMessageEntity>(), ttlSecs),
		MessageFlags(),
		NewMessageType::Unread);

	LOG(("Parvane: %1 медиа %2: %3 (%4 байт) → %5")
		.arg(out ? u"своё"_q : u"получено"_q).arg(from).arg(filename)
		.arg(size).arg(localPath));
	if (item) {
		indexSharedMediaWithCount(session, item);
		const auto history = item->history();
		if (!history->folderKnown()) {
			history->clearFolder();
		}
		LOG(("Parvane: медиа-диалог %1 — в списке=%2")
			.arg(from).arg(history->inChatList() ? 1 : 0));
	}
}

// Инъекция ФОТО inline (Фаза 4c): картинка из локального файла прямо в ленту.
// При неудаче декодирования — деградирует в документ (injectMediaOnMain).
void injectPhotoOnMain(
		not_null<Main::Session*> session,
		const QString &from,
		std::uint64_t senderId,
		std::uint64_t authorId,
		bool out,
		std::int64_t ts,
		MsgId msgId,
		std::int64_t mediaId,
		const QString &kind,
		const QString &localPath,
		const QString &filename,
		const QString &mime,
		std::int64_t size,
		int durationSecs,
		int width,
		int height,
		const QString &caption,
		bool peerIsChat = false,
		const QString &authorAddr = QString(),
		int ttlSecs = 0) {
	auto raw = QByteArray();
	{
		auto f = QFile(localPath);
		if (f.open(QIODevice::ReadOnly)) {
			raw = f.readAll();
		}
	}
	auto image = QImage();
	image.loadFromData(raw);
	if (image.isNull()) {
		// не изображение — показываем как документ (с атрибутами по kind)
		injectMediaOnMain(session, from, senderId, authorId, out, ts, msgId,
			mediaId, kind, localPath, filename, mime, size,
			durationSecs, width, height, caption, peerIsChat, authorAddr);
		return;
	}
	if (peerIsChat) {
		ensureGroupChat(session, from, g_knownGroups.value(from), 0);
		if (!authorAddr.isEmpty()) {
			ensurePeerUser(session, authorId, authorAddr);
		}
	} else {
		RegisterPeer(from);
		ensurePeerUser(session, senderId, from);
	}

	auto sizes = QVector<MTPPhotoSize>();
	sizes.push_back(MTP_photoSize(
		MTP_string("y"),
		MTP_int(image.width()),
		MTP_int(image.height()),
		MTP_int(int(raw.size()))));
	const auto mtpPhoto = MTP_photo(
		MTP_flags(0),
		MTP_long(mediaId),
		MTP_long(0),                    // access_hash
		MTP_bytes(),                    // file_reference
		MTP_int(int(ts)),               // date
		MTP_vector<MTPPhotoSize>(sizes),
		MTPVector<MTPVideoSize>(),
		MTP_int(session->mainDcId()));
	using Flag = MTPDmessageMediaPhoto::Flag;
	const auto media = MTP_messageMediaPhoto(
		MTP_flags(Flag::f_photo),
		mtpPhoto,
		MTPint(),                       // ttl_seconds
		MTPDocument());                 // video

	const auto item = session->data().addNewMessage(
		msgId,
		buildMessage(authorId, senderId, out, ts, caption, media,
			/*hasMedia=*/true, 0, peerIsChat,
			MTPVector<MTPMessageEntity>(), ttlSecs),
		MessageFlags(),
		NewMessageType::Unread);

	// Заполняем изображение из памяти ПОСЛЕ addNewMessage (иначе MTP-apply
	// затрёт его пустыми локациями), затем просим перерисовать элемент.
	const auto photo = session->data().processPhoto(mtpPhoto);
	const auto large = Images::FromImageInMemory(image, "JPG", raw);
	photo->updateImages(
		QByteArray(),        // inlineThumbnailBytes
		ImageWithLocation(), // small
		large,               // thumbnail
		large,               // large
		ImageWithLocation(), // videoSmall
		ImageWithLocation(), // videoLarge
		0);

	LOG(("Parvane: %1 фото %2: %3x%4 (%5 байт)")
		.arg(out ? u"своё"_q : u"получено"_q).arg(from)
		.arg(image.width()).arg(image.height()).arg(size));
	if (item) {
		indexSharedMediaWithCount(session, item);
		session->data().notifyItemDataChange(item);
		const auto history = item->history();
		if (!history->folderKnown()) {
			history->clearFolder();
		}
		LOG(("Parvane: медиа-диалог %1 — в списке=%2")
			.arg(from).arg(history->inChatList() ? 1 : 0));
	}
}

// Скачивает блоб из cloud на воркере, сохраняет на диск, затем инъецирует на
// main. Дедуп-резервирование msgId делает вызывающий (injectOnMain).
void pumpMediaDownload(
		const QString &from,
		std::uint64_t senderId,
		std::uint64_t authorId,
		bool out,
		std::int64_t ts,
		MsgId msgId,
		const QString &kind,
		const QString &fileId,
		const QString &filename,
		const QString &mime,
		std::int64_t size,
		int durationSecs,
		int width,
		int height,
		const QString &caption,
		bool peerIsChat = false,
		const QString &authorAddr = QString(),
		const QString &fileKey = QString(),   // E2E медиа (Фаза 3): ключ блоба
		const QString &fileNonce = QString(),
		int ttlSecs = 0) {
	const auto self = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto fileIdStd = fileId.toStdString();
	const auto fileKeyStd = fileKey.toStdString();
	const auto fileNonceStd = fileNonce.toStdString();
	crl::async([=] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		std::string bytes;
		try {
			parvane::CloudClient cloud(*t);
			auto d = DownloadChatBlob(cloud, self, token, fileIdStd, 20000);
			if (!d.ok) {
				LOG(("Parvane: скачивание медиа %1 не удалось: %2")
					.arg(fileId).arg(QString::fromStdString(d.error)));
				return;
			}
			bytes = std::move(d.bytes);
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка скачивания медиа: %1")
				.arg(QString::fromUtf8(e.what())));
			return;
		}
		// E2E медиа (Фаза 3): блоб зашифрован (1-на-1) — расшифровать ключом из
		// сообщения. Пустой ключ — открытый блоб (группы/legacy).
		if (!fileKeyStd.empty()) {
			auto dec = parvane::blobcrypt::decrypt(bytes, fileKeyStd, fileNonceStd);
			if (!dec) {
				LOG(("Parvane: медиа %1 — блоб НЕ расшифрован").arg(fileId));
				return;
			}
			bytes = std::move(*dec);
		}
		if (!IsSafeFileId(fileId)) {
			LOG(("Parvane: недопустимый file_id медиа — пропущено"));
			return;
		}
		const auto path = MediaDir() + u"/"_q + fileId + u"_"_q + SafeFileName(filename);
		{
			auto f = QFile(path);
			if (!f.open(QIODevice::WriteOnly)
				|| f.write(bytes.data(), bytes.size()) != qint64(bytes.size())) {
				LOG(("Parvane: не записать медиа-файл %1").arg(path));
				return;
			}
			f.close();
			RestrictToOwner(path);
		}
		const auto mediaId = docIdFromFileId(fileId);
		crl::on_main([=] {
			const auto session = g_sessionWeak.get();
			if (!session) {
				return;
			}
			// Инлайн-фото, если контент помечен photo ИЛИ mime — image/* (tdesktop
			// иногда даунгрейдит Photo→File при отправке; смотрим по факту).
			// injectPhotoOnMain сам деградирует в документ, если байты не картинка.
			if (kind != u"sticker"_q && kind != u"gif"_q
				&& (kind == u"photo"_q || mime.startsWith(u"image/"_q))) {
				injectPhotoOnMain(session, from, senderId, authorId, out,
					ts, msgId, mediaId, kind, path, filename, mime, size,
					durationSecs, width, height, caption, peerIsChat, authorAddr,
					ttlSecs);
			} else {
				injectMediaOnMain(session, from, senderId, authorId, out,
					ts, msgId, mediaId, kind, path, filename, mime, size,
					durationSecs, width, height, caption, peerIsChat, authorAddr,
					ttlSecs);
			}
		});
	});
}

// ── опросы (паритет): синтез и агрегация ─────────────────────────────────────

// MTP_messageMediaPoll из poll-контента. option варианта — его индекс строкой
// ("0","1",…) — так голос сериализуется без обратного поиска байтов.
[[nodiscard]] MTPMessageMedia buildPollMedia(
		const PollState &st,
		const nlohmann::json &cIn) {
	// spec 005: web пишет options/is_*, desktop — answers/…; читаем оба
	const auto c = parvane::poll::normalize(cIn);
	const auto question = QString::fromStdString(
		c.value("question", std::string()));
	auto answers = QVector<MTPPollAnswer>();
	if (c.contains("answers") && c["answers"].is_array()) {
		auto i = 0;
		for (const auto &a : c["answers"]) {
			if (!a.is_string()) {
				continue;
			}
			answers.push_back(MTP_pollAnswer(
				MTP_flags(MTPDpollAnswer::Flags(0)),
				MTP_textWithEntities(
					MTP_string(QString::fromStdString(a.get<std::string>())),
					MTP_vector<MTPMessageEntity>()),
				MTP_bytes(QByteArray::number(i)),
				MTPMessageMedia(),          // media (flags.0 — нет)
				MTPPeer(),                  // added_by (flags.1 — нет)
				MTPint()));                 // date (flags.1 — нет)
			++i;
		}
	}
	using Flag = MTPDpoll::Flag;
	const auto flags = (st.closed ? Flag::f_closed : Flag(0))
		| (c.value("multiple", false) ? Flag::f_multiple_choice : Flag(0))
		| (c.value("quiz", false) ? Flag::f_quiz : Flag(0))
		| (c.value("public", false) ? Flag::f_public_voters : Flag(0));
	const auto poll = MTP_poll(
		MTP_long(st.pollId),
		MTP_flags(flags),
		MTP_textWithEntities(
			MTP_string(question),
			MTP_vector<MTPMessageEntity>()),
		MTP_vector<MTPPollAnswer>(answers),
		MTP_int(0),                 // close_period (flags.4 — нет)
		MTP_int(0),                 // close_date (flags.5 — нет)
		MTPVector<MTPstring>(),     // countries_iso2 (flags.12 — нет)
		MTP_long(0));               // hash
	const auto results = MTP_pollResults(
		MTP_flags(MTPDpollResults::Flags(0)),
		MTPVector<MTPPollAnswerVoters>(),
		MTPint(),                   // total_voters
		MTPVector<MTPPeer>(),       // recent_voters
		MTPstring(),                // solution
		MTPVector<MTPMessageEntity>(),
		MTPMessageMedia());         // solution_media
	return MTP_messageMediaPoll(
		MTP_flags(MTPDmessageMediaPoll::Flags(0)),
		poll,
		results,
		MTPMessageMedia());         // attached_media
}

// Применяет агрегат голосов к зарегистрированному PollData (через штатный
// updateMessagePoll → applyResults) и флаг закрытия. Опрос ещё не инъецирован
// (нет в _polls) — no-op, вызовется повторно после инъекции.
void applyPollState(not_null<Main::Session*> session, const PollState &st) {
	const auto self = SelfAddress();
	const auto myVote = st.votes.value(self);
	auto counts = QVector<int>(st.answers, 0);
	auto total = 0;
	for (auto i = st.votes.constBegin(); i != st.votes.constEnd(); ++i) {
		if (i.value().isEmpty()) {
			continue; // отозванный голос
		}
		++total;
		for (const auto option : i.value()) {
			if (option >= 0 && option < st.answers) {
				++counts[option];
			}
		}
	}
	auto voters = QVector<MTPPollAnswerVoters>();
	voters.reserve(st.answers);
	using VFlag = MTPDpollAnswerVoters::Flag;
	for (auto i = 0; i != st.answers; ++i) {
		const auto flags = VFlag::f_voters
			| (myVote.contains(i) ? VFlag::f_chosen : VFlag(0))
			| ((st.quiz && st.correct.contains(i))
				? VFlag::f_correct
				: VFlag(0));
		voters.push_back(MTP_pollAnswerVoters(
			MTP_flags(flags),
			MTP_bytes(QByteArray::number(i)),
			MTP_int(counts[i]),
			MTP_vector<MTPPeer>(QVector<MTPPeer>()))); // recent (flags.2 общий)
	}
	using RFlag = MTPDpollResults::Flag;
	const auto hasSolution = st.quiz && !st.solution.isEmpty();
	// Публичный опрос: последние голосовавшие (аватарки у опроса).
	auto recent = QVector<MTPPeer>();
	if (st.publicVoters) {
		for (auto i = st.votes.constBegin();
				i != st.votes.constEnd() && recent.size() < 3;
				++i) {
			if (i.value().isEmpty()) {
				continue;
			}
			const auto vid = IdForAddress(i.key());
			ensurePeerUser(session, vid, i.key());
			recent.push_back(MTP_peerUser(MTP_long(qint64(vid))));
		}
	}
	const auto rflags = RFlag::f_results
		| RFlag::f_total_voters
		| (recent.isEmpty() ? RFlag(0) : RFlag::f_recent_voters)
		| (hasSolution ? RFlag::f_solution : RFlag(0));
	const auto results = MTP_pollResults(
		MTP_flags(rflags),
		MTP_vector<MTPPollAnswerVoters>(voters),
		MTP_int(total),
		MTP_vector<MTPPeer>(recent),    // recent_voters
		MTP_string(st.solution),
		MTP_vector<MTPMessageEntity>(QVector<MTPMessageEntity>()),
		MTPMessageMedia());             // solution_media (flags.5 — нет)
	const auto update = MTP_updateMessagePoll(
		MTP_flags(MTPDupdateMessagePoll::Flags(0)),
		MTPPeer(),                      // peer (flags.1 — нет)
		MTPint(),                       // msg_id (flags.1 — нет)
		MTPint(),                       // top_msg_id (flags.2 — нет)
		MTP_long(st.pollId),
		MTPPoll(),                      // poll (flags.0 — нет)
		results);
	session->data().applyUpdate(update.c_updateMessagePoll());
	// Закрытие: флаг прямо на PollData (не пересобираем весь MTPPoll).
	if (st.closed) {
		if (const auto item = session->data().findItemForPoll(st.pollId)) {
			const auto media = item->media();
			if (const auto poll = media ? media->poll() : nullptr) {
				if (!poll->closed()) {
					poll->setFlags(poll->flags() | PollData::Flag::Closed);
					++poll->version;
					session->data().notifyPollUpdateDelayed(poll);
				}
			}
		}
	}
	// Мы вне пайплайна Api::Updates — отложенные уведомления шлём сами, иначе
	// вью опроса не перерисуется до чужого события.
	session->data().sendWebPageGamePollTodoListNotifications();
}

// Голос/закрытие с шины (и свои на воспроизведении журнала). Не отображается
// как сообщение. Опрос ещё не пришёл — откладываем до его инъекции.
void handlePollService(
		not_null<Main::Session*> session,
		const parvane::StoredMessage &sm,
		const std::string &kind) {
	const auto pollUuid = QString::fromStdString(
		sm.content.value("poll", std::string()));
	if (pollUuid.isEmpty()) {
		return;
	}
	const auto voter = QString::fromStdString(sm.from);
	auto options = QVector<int>();
	if (sm.content.contains("options") && sm.content["options"].is_array()) {
		for (const auto &o : sm.content["options"]) {
			if (o.is_number_integer()) {
				options.push_back(o.get<int>());
			}
		}
	}
	const auto it = g_pollsByUuid.find(pollUuid);
	if (it == g_pollsByUuid.end()) {
		if (kind == "poll_close") {
			g_pendingPollClose.insert(pollUuid);
		} else {
			g_pendingPollVotes[pollUuid].push_back({ voter, options });
		}
		return;
	}
	if (kind == "poll_close") {
		it->closed = true;
	} else if (options.isEmpty()) {
		it->votes.remove(voter);
	} else {
		it->votes.insert(voter, options);
	}
	applyPollState(session, *it);
	LOG(("Parvane: опрос %1 — %2 от %3")
		.arg(pollUuid)
		.arg(QString::fromStdString(kind))
		.arg(voter));
}

// Инъекция сообщения-опроса (1-на-1 и группа; входящие, свои с другого девайса
// и свои на воспроизведении журнала). Регистрирует PollState, применяет
// отложенные голоса.
void injectPollMessage(
		not_null<Main::Session*> session,
		const parvane::StoredMessage &smIn) {
	auto sm = smIn; // spec 005: оба формата имён полей опроса
	sm.content = parvane::poll::normalize(smIn.content);
	const auto self = SelfAddress();
	const auto from = QString::fromStdString(sm.from);
	const auto uuid = QString::fromStdString(sm.id);
	const auto toStr = QString::fromStdString(sm.to);
	const auto isOwn = (from == self);
	const auto isGroup = g_knownGroups.contains(toStr);
	auto peerId = std::uint64_t(0);
	auto authorId = std::uint64_t(0);
	if (isGroup) {
		ensureGroupChat(session, toStr, g_knownGroups.value(toStr), 0);
		peerId = IdForAddress(toStr);
		authorId = IdForAddress(from);
		ensurePeerUser(session, authorId, from);
	} else {
		const auto peerAddress = isOwn ? toStr : from;
		if (peerAddress.isEmpty()) {
			return;
		}
		RegisterPeer(peerAddress);
		peerId = IdForAddress(peerAddress);
		authorId = isOwn ? IdForAddress(self) : peerId;
		ensurePeerUser(session, peerId, peerAddress);
		// Личная переписка → собеседник становится контактом (список Contacts
		// показывает реальных людей, а не дамп директории). Себя (Избранное)
		// контактом не помечаем.
		if (peerAddress != self) {
			if (const auto u = session->data().userLoaded(UserId(BareId(peerId)))) {
				if (!u->isContact()) {
					u->setIsContact(true);
				}
			}
		}
		if (!isOwn) {
			const auto u = session->data().userLoaded(UserId(BareId(peerId)));
			if (u && u->isBlocked()) {
				return;
			}
		}
	}
	auto &st = g_pollsByUuid[uuid];
	st.uuid = uuid;
	st.pollId = std::uint64_t(docIdFromFileId(uuid));
	st.chatAddress = isGroup ? toStr : (isOwn ? toStr : from);
	st.quiz = sm.content.value("quiz", false);
	st.publicVoters = sm.content.value("public", false);
	st.solution = QString::fromStdString(
		sm.content.value("solution", std::string()));
	st.answers = (sm.content.contains("answers")
			&& sm.content["answers"].is_array())
		? int(sm.content["answers"].size())
		: 0;
	st.correct.clear();
	if (sm.content.contains("correct") && sm.content["correct"].is_array()) {
		for (const auto &o : sm.content["correct"]) {
			if (o.is_number_integer()) {
				st.correct.push_back(o.get<int>());
			}
		}
	}
	g_pollUuidById.insert(st.pollId, uuid);
	// Отложенные голоса/закрытие (пришли раньше опроса).
	for (const auto &[voter, options] : g_pendingPollVotes.take(uuid)) {
		if (options.isEmpty()) {
			st.votes.remove(voter);
		} else {
			st.votes.insert(voter, options);
		}
	}
	if (g_pendingPollClose.remove(uuid)) {
		st.closed = true;
	}
	const auto msgId = MsgId(g_nextMsgId++);
	g_uuidToMsgId.insert(uuid, msgId.bare);
	g_msgIdToUuid.insert(msgId.bare, uuid);
	g_mediaContentByMsgId.insert(msgId.bare,
		QString::fromStdString(sm.content.dump())); // для пересылки опроса
	if (!isOwn && !isGroup && !IsReportedRead(uuid)) {
		g_unreadIncoming[peerId].push_back(uuid);
	}
	const auto item = session->data().addNewMessage(
		msgId,
		buildMessage(authorId, peerId, isOwn, sm.ts, QString(),
			buildPollMedia(st, sm.content), /*hasMedia=*/true,
			/*replyToMsgId=*/0, /*peerIsChat=*/isGroup),
		MessageFlags(),
		NewMessageType::Unread);
	if (item) {
		const auto history = item->history();
		if (!history->folderKnown()) {
			history->clearFolder();
		}
	}
	if (!st.votes.isEmpty() || st.closed) {
		applyPollState(session, st);
	}
	// Debug-autovote для e2e: PARVANE_AUTOVOTE=<индекс> — голосуем во входящем
	// опросе автоматически (headless-проверка агрегации).
	if (!isOwn) {
		if (const char *av = ParvaneDevEnv("PARVANE_AUTOVOTE"); av && *av) {
			const auto option = QByteArray(av);
			const auto pollId = st.pollId;
			crl::on_main([pollId, option] {
				MirrorPollVotes(pollId, { option });
				LOG(("Parvane: autovote — опрос %1, вариант %2")
					.arg(pollId)
					.arg(QString::fromUtf8(option)));
			});
		}
	}
	LOG(("Parvane: опрос %1 (%2) от %3 инъецирован")
		.arg(uuid, st.chatAddress, from));
}

// Воркер: расшифровка + верификация отправителя ДО инъекции (сеть при промахе
// каталога — не на main). Результат: sm.from/sm.content заменены расшифрованным
// inner; подменённые/нерасшифрованные — выброшены (spoofed ещё и ack'нуты
// анонимно, чтобы сервер не передоставлял). Кэш расшифровки: uuid → inner
// (+sender_identity для повторной сверки и экспорта при линковке); правка =
// новый шифртекст → перерасшифровка (кэш хранит отпечаток шифртекста).
bool prepareIncoming(
		std::vector<parvane::StoredMessage> &msgs,
		bool live,
		std::vector<std::string> *failed) {
	// Сбрасывается, когда сообщение не удалось прочитать. Умышленные отказы
	// (подмена отправителя, чужой SKDM) флаг НЕ трогают — иначе злоумышленник
	// одним подложным сообщением заморозил бы синк жертвы навсегда.
	bool clean = true;
	parvane::MessengerClient *m = nullptr;
	parvane::ITransport *t = nullptr;
	std::string self, token;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		m = g_messenger.get();
		t = g_transport.get();
		self = g_selfAddress.toStdString();
		token = g_token.toStdString();
	}
	const auto ackAnon = [&](const std::string &mid) {
		if (!m || !live) {
			return;
		}
		try {
			m->ack(self, mid, token, std::string());
		} catch (const std::exception &) {
		}
	};
	std::vector<parvane::StoredMessage> out;
	out.reserve(msgs.size());
	for (auto &sm : msgs) {
		const auto kind = parvane::contentKind(sm.content);
		if (kind != "encrypted" && kind != "group_encrypted") {
		try {
			out.push_back(std::move(sm));
			continue;
		} catch (const std::exception &e) {
			// NAT-01: содержимое от собеседника не должно ронять клиент (и
			// повторно — при каждом запуске из журнала): запись пропускается
			LOG(("Parvane: входящее (воркер) пропущено: %1").arg(QString::fromUtf8(e.what())));
			continue;
		}
	}
		if (!parvane::e2e::ready() || !t) {
			clean = false; // из кэша может не найтись → курсор не двигаем
			if (failed) { failed->push_back(sm.id); }
			out.push_back(std::move(sm)); // main-поток попробует из кэша
			continue;
		}
		const auto uuidQ = QString::fromStdString(sm.id);
		const bool direct = (kind == "encrypted");
		if (direct) {
			sm.content = parvane::e2e::pickOwnCopy(sm.content, sm.copies, self);
			// Легаси-копия v2-отправителя для чужих v1-устройств (FR-054): нашей
			// копии нет — запись не для этого устройства, курсор не держим.
			if (!sm.deleted && parvane::e2e::isForeignLegacyCopy(sm.content)) {
				ackAnon(sm.id);
				continue;
			}
		}
		const auto ct = sm.content.value("ciphertext", std::string());
		// Отпечаток ПОЛНОГО шифртекста (FNV-1a): у двух prekey-сообщений одной
		// сессии общий заголовок, поэтому префикс не различает оригинал и правку.
		std::uint64_t fp = 1469598103934665603ULL;
		for (const unsigned char cc : ct) { fp ^= cc; fp *= 1099511628211ULL; }
		const auto ctFp = QString::number(fp, 16);
		const auto envIdentity = sm.content.value("sender_identity", std::string());
		auto innerQ = DecCacheGet(uuidQ);
		nlohmann::json inner;
		bool fresh = false;
		if (!innerQ.isEmpty()) {
			inner = nlohmann::json::parse(innerQ.toStdString(), nullptr, false);
			if (!inner.is_object()) {
				innerQ.clear();
			} else if (sm.edited && inner.contains("ct")
				&& inner["ct"].is_string()
				&& QString::fromStdString(inner["ct"].get<std::string>()) != ctFp) {
				innerQ.clear(); // правка: новый шифртекст → перерасшифровать
			}
		}
		if (innerQ.isEmpty()) {
			std::string dec;
			if (direct) {
				dec = parvane::e2e::open(sm.from, sm.content.dump());
			} else {
				dec = parvane::e2e::groupOpen(sm.content.value("group", std::string()),
					envIdentity, ct);
			}
			if (dec.empty()) {
				clean = false;
				if (failed) { failed->push_back(sm.id); }
				LOG(("Parvane: НЕ расшифровано msg %1%2")
					.arg(uuidQ, direct ? QString() : u" (группа, нет SKDM?)"_q));
				ackAnon(sm.id); // как web: снять из очереди, не показывать
				continue;
			}
			inner = nlohmann::json::parse(dec, nullptr, false);
			if (!inner.is_object()) {
				clean = false;
				if (failed) { failed->push_back(sm.id); }
				continue;
			}
			fresh = true;
		}
		const auto claimedFrom = inner.value("from", std::string());
		// АВТОР сообщения: 1-на-1 — реальный отправитель ВНУТРИ шифртекста
		// (sealed, скрыт на проводе); ГРУППА — ВСЕГДА gateway-аутентифицированный
		// wire from. Для групп inner.from контролирует отправитель (Megolm
		// plaintext) → доверять ему нельзя (иначе любой участник выдаёт себя за
		// другого). wireFrom подставляет gateway и подделать нельзя.
		const auto wireFrom = sm.from;
		const auto author = direct ? claimedFrom : wireFrom;
		// Верификация: identity конверта обязана принадлежать устройствам АВТОРА
		// (в т.ч. from==self — анти-вброс в «Избранное»). Свои исходящие (кэш без
		// identity) — не сверяем.
		const auto cachedIdentity = inner.value("sender_identity", std::string());
		const auto verifyIdentity = fresh ? envIdentity : cachedIdentity;
		// Кэшируем результат расшифровки СРАЗУ (до верификации): Olm/Megolm-ратчет
		// уже продвинулся при decrypt, и если бы мы вышли по `continue` без кэша,
		// то же сообщение после рестарта уже не расшифровалось бы (SYNC-1).
		if (fresh) {
			auto cached = inner;
			cached["ct"] = ctFp.toStdString();
			// sender_identity в кэш для ОБОИХ (иначе cached-путь групп не сверялся
			// бы и доверял бы кэшированной подмене).
			if (!envIdentity.empty()) {
				cached["sender_identity"] = envIdentity;
			}
			DecCachePut(uuidQ, QString::fromStdString(cached.dump()));
		}
		if (!verifyIdentity.empty() && !author.empty()) {
			const auto v = parvane::e2e::verifySender(author, verifyIdentity, *t, token);
			if (v == parvane::e2e::Verdict::Spoofed) {
				LOG(("Parvane: ОТКЛОНЕНО: подмена отправителя %1 в %2%3")
					.arg(QString::fromStdString(author), uuidQ,
						direct ? QString() : u" (группа)"_q));
				ackAnon(sm.id);
				continue;
			} else if (v == parvane::e2e::Verdict::Unknown) {
				// E2E-1: каталог отправителя недоступен — подтвердить нельзя. НЕ
				// показываем и НЕ ack'аем; курсор держим, sync повторит. Ратчет
				// уже закэширован выше, повтор расшифруется из кэша.
				LOG(("Parvane: отправитель %1 в %2 не подтверждён (каталог недоступен) — откладываем")
					.arg(QString::fromStdString(author), uuidQ));
				clean = false;
				if (failed) { failed->push_back(sm.id); }
				continue;
			} else if (author != self) {
				if (parvane::e2e::rememberContactIdentity(author, verifyIdentity)) {
					// Ключ известного контакта сменился — служебное сообщение в чат
					const auto authorQ = QString::fromStdString(author);
					crl::on_main([authorQ] { AnnounceKeyChange(authorQ); });
				}
			}
		}
		// 1-на-1: реальный отправитель — inner.from (sealed). Группа: inner.from
		// НЕ доверяем — автор остаётся wire from (не перезаписываем sm.from).
		if (direct && !claimedFrom.empty()) {
			sm.from = claimedFrom;
		}
		// E2E-1: канонический Megolm-plaintext — голый content; принимаем и
		// legacy-обёртку {from, content}. Для 1-1 (sealed) обёртка обязательна.
		if (inner.contains("content") && inner.contains("from") && inner["content"].is_object()) {
			sm.content = inner["content"];
		} else if (!direct) {
			sm.content = inner;
		}
		// SKDM: ключ принимаем только если заявленный sender_identity совпадает с
		// identity конверта (иначе участник мог бы подменить чужой Megolm-канал).
		// SKDM всегда приходит как direct sealed — verifyIdentity уже сверен с
		// автором (inner.from) выше.
		if (parvane::contentKind(sm.content) == "skdm") {
			if (!direct || sm.content.value("sender_identity", std::string()) != verifyIdentity) {
				LOG(("Parvane: SKDM с чужим sender_identity от %1 — отклонён")
					.arg(QString::fromStdString(claimedFrom)));
				ackAnon(sm.id);
				continue;
			}
			sm.content["sender_identity"] = verifyIdentity;
		}
		out.push_back(std::move(sm));
	}
	msgs = std::move(out);
	return clean;
}

// Инъекция результатов sync в Data::Session. Только main-поток. Дедуп по UUID.
// T079 (правило L2-1, CONTENT-1): содержимое {"kind":"chat_mode","l2":bool} —
// нативное служебное сообщение чата «… включил(а)/выключил(а) усиленную
// приватность». Личный чат: автор — участник (операция ChatMode); группа v2:
// автор — тот, кто задал политику (событие сессии groupL2).
void injectChatModeMessage(
		not_null<Main::Session*> session,
		const parvane::StoredMessage &sm) {
	const auto self = SelfAddress();
	const auto from = QString::fromStdString(sm.from);
	const auto to = QString::fromStdString(sm.to);
	const auto uuid = QString::fromStdString(sm.id);
	const auto enabled = sm.content.is_object() && sm.content.value("l2", false);
	const auto isOwn = (from == self);
	auto dialog = PeerId();
	auto chatAddress = QString();
	if (g_knownGroups.contains(to)) {
		ensureGroupChat(session, to, g_knownGroups.value(to), 0);
		dialog = peerFromChat(ChatId(BareId(IdForAddress(to))));
		chatAddress = to;
	} else {
		chatAddress = isOwn ? to : from;
		if (chatAddress.isEmpty() || parvane::v2::isGroupAddress(chatAddress.toStdString())) {
			g_uuidToMsgId.insert(uuid, 0); // группа ещё не известна — не показываем
			return;
		}
		RegisterPeer(chatAddress);
		const auto peerId = IdForAddress(chatAddress);
		ensurePeerUser(session, peerId, chatAddress);
		dialog = peerFromUser(UserId(BareId(peerId)));
	}
	auto text = QString();
	if (isOwn) {
		text = enabled
			? tr::lng_parvane_chat_mode_on_you(tr::now)
			: tr::lng_parvane_chat_mode_off_you(tr::now);
	} else if (from.isEmpty()) {
		text = tr::lng_parvane_enhanced_privacy(tr::now);
	} else {
		const auto user = ensurePeerUser(session, IdForAddress(from), from);
		text = enabled
			? tr::lng_parvane_chat_mode_on(tr::now, lt_user, user->name())
			: tr::lng_parvane_chat_mode_off(tr::now, lt_user, user->name());
	}
	const auto msgId = MsgId(g_nextMsgId++);
	g_uuidToMsgId.insert(uuid, msgId.bare);
	g_msgIdToUuid.insert(msgId.bare, uuid);
	const auto item = session->data().addNewMessage(
		msgId,
		MTP_messageService(
			MTP_flags(MTPDmessageService::Flags(0)),
			MTP_int(0),
			MTPPeer(),                  // from_id
			peerToMTP(dialog),
			MTPPeer(),                  // saved_peer_id
			MTPMessageReplyHeader(),
			MTP_int(int(sm.ts ? sm.ts : QDateTime::currentSecsSinceEpoch())),
			MTP_messageActionCustomAction(MTP_string(text)),
			MTPMessageReactions(),
			MTPint()),                  // ttl_period
		MessageFlags(),
		NewMessageType::Unread);
	if (item && !item->history()->folderKnown()) {
		item->history()->clearFolder();
	}
	LOG(("Parvane: режим L2 чата %1: %2 (%3) — служебное сообщение msg %4")
		.arg(chatAddress, enabled ? u"включён"_q : u"выключен"_q,
			isOwn ? u"мной"_q : from, uuid));
}

void injectOnMain(
		not_null<Main::Session*> session,
		const std::vector<parvane::StoredMessage> &msgs,
		bool live) {
	const auto self = SelfAddress();
	const auto selfId = IdForAddress(self);
	const auto selfStd = self.toStdString();
	int added = 0;
	for (const auto &smOrig : msgs) {
		auto sm = smOrig; // мутабельная копия — для расшифровки E2E-контента
		// История группы v1, переведённой в v2 (T180), — в тот же чат
		if (const auto to = QString::fromStdString(sm.to); IsMigratedGroup(to)) {
		try {
			sm.to = CanonicalGroup(to).toStdString();
		} catch (const std::exception &e) {
			// NAT-01: содержимое от собеседника не должно ронять клиент (и
			// повторно — при каждом запуске из журнала): запись пропускается
			LOG(("Parvane: входящее (вставка) пропущено: %1").arg(QString::fromUtf8(e.what())));
			continue;
		}
	}
		// E2E (Фаза 2): входящий Encrypted-контент → расшифровать в реальный
		// MessageContent, дальше синтез как обычно. Свои исходящие (from==self)
		// зашифрованы ДЛЯ собеседника — их не расшифровать, но они идут через
		// дедуп локального эха. Ошибка расшифровки — плейсхолдер, не краш.
		if (parvane::contentKind(sm.content) == "encrypted") {
			// Кэш: если это сообщение уже расшифровывали — берём результат из
			// кэша (НЕ гоняем Olm-ratchet повторно; иначе после рестарта/пере-
			// синка расшифровка ломается). Иначе — расшифровать и запомнить.
			const auto uuidQ = QString::fromStdString(sm.id);
			auto innerQ = DecCacheGet(uuidQ);
			if (innerQ.isEmpty()) {
				// Не подготовлено воркером (prepareIncoming) и нет в кэше —
				// на main не расшифровываем (верификация ходит в сеть).
				continue;
			}
			try {
				auto inner = nlohmann::json::parse(innerQ.toStdString());
				if (inner.contains("from") && inner["from"].is_string()) {
					sm.from = inner["from"].get<std::string>(); // реальный отправитель (sealed)
				}
				if (inner.contains("content")) {
					sm.content = inner["content"];
				}
			} catch (const std::exception &) {
				continue;
			}
		} else if (parvane::contentKind(sm.content) == "group_encrypted") {
			// E2E группы (Megolm): расшифровать входящей group-сессией отправителя
			// (нужен предварительно принятый SKDM). from виден на проводе.
			const auto uuidQ = QString::fromStdString(sm.id);
			auto innerQ = DecCacheGet(uuidQ);
			if (innerQ.isEmpty()) {
				continue; // см. prepareIncoming
			}
			try {
				auto inner = nlohmann::json::parse(innerQ.toStdString());
				// E2E-1/P-02: автор группового — ТОЛЬКО wire sm.from; inner.from
				// не используем. Принимаем голый content и legacy {from, content}.
				if (inner.contains("content") && inner.contains("from")
						&& inner["content"].is_object()) {
					sm.content = inner["content"];
				} else {
					sm.content = inner;
				}
			} catch (const std::exception &) {
				continue;
			}
		}
		// Ack входящего (не своего): снять из очереди + delivered отправителю
		// (sealed: указываем реального отправителя из конверта). Идемпотентно.
		// При воспроизведении журнала (live=false) НЕ ackаем (сообщение уже давно
		// обработано; ack сорвал бы офлайн-очередь для реально новых).
		// v2-сообщения подтверждает движок (msg.inbox.ack) — v1-ack не шлём.
		if (live && sm.from != selfStd && !IsV2Message(sm.id)) {
			const auto mid = sm.id;
			const auto sender = sm.from;
			crl::async([mid, sender] {
				parvane::MessengerClient *m = nullptr;
				std::string self, token;
				{
					std::lock_guard<std::mutex> lk(g_sessionMutex);
					m = g_messenger.get();
					self = g_selfAddress.toStdString();
					token = g_token.toStdString();
				}
				if (m) {
					try {
						m->ack(self, mid, token, sender);
					} catch (const std::exception &) {
					}
				}
			});
		}
		// SKDM (раздача Megolm-ключа участника): принять входящий group-ключ и НЕ
		// показывать как сообщение (пришёл 1-на-1 sealed, уже расшифрован + ack'нут).
		if (parvane::contentKind(sm.content) == "skdm") {
			parvane::e2e::groupAcceptKey(
				sm.content.value("group", std::string()),
				sm.content.value("sender_identity", std::string()),
				sm.content.value("session_key", std::string()),
				sm.content.value("epoch", std::uint64_t(0)));
			continue;
		}
		const auto from = QString::fromStdString(sm.from);
		const auto uuid = QString::fromStdString(sm.id);
		if (IsCleared(uuid)) {
			continue; // скрыто «для меня» (удалённый/очищенный чат)
		}
		// Сообщение группы, которой устройство ещё не знает: ждёт появления
		// группы (адрес группы — без «@»: UUID v1 или v2g:<hex>), иначе ушло
		// бы в личный чат с автором.
		if (const auto toAddr = QString::fromStdString(sm.to);
				!toAddr.isEmpty()
				&& !toAddr.contains(u'@')
				&& !g_knownGroups.contains(toAddr)
				&& !g_uuidToMsgId.contains(uuid)) {
			DeferUnknownGroupMessage(toAddr, sm, live);
			continue;
		}
		if (sm.deleted) {
			// Томбстоун: если сообщение было инъецировано — удаляем локальный item.
			const auto found = g_uuidToMsgId.find(uuid);
			if (found != g_uuidToMsgId.end() && found.value() != 0) {
				const auto isOwn = (from == self);
				const auto peerAddr = isOwn
					? QString::fromStdString(sm.to) : from;
				const auto peerId = IdForAddress(peerAddr);
				const auto full = FullMsgId(
					peerFromUser(UserId(BareId(peerId))),
					MsgId(found.value()));
				if (const auto item = session->data().message(full)) {
					item->destroy();
				}
				g_msgIdToUuid.remove(found.value());
			}
			g_uuidToMsgId.insert(uuid, 0); // помечаем обработанным
			continue;
		}
		if (sm.edited) {
			// Правка: если уже инъецировано — обновляем текст/подпись локального
			// item (с форматированием). Медиа: меняется только caption.
			const auto found = g_uuidToMsgId.find(uuid);
			if (found != g_uuidToMsgId.end() && found.value() != 0) {
				const auto maybeText = sm.text();
				const auto &ec = sm.content;
				const auto hasCaption = ec.is_object() && ec.contains("caption")
					&& ec["caption"].is_string();
				if (ec.is_object() && ec.value("kind", std::string()) == "location") {
					// Live-локация: новая позиция приходит правкой того же
					// сообщения — подменяем медиа (geo/geoLive), текст не трогаем
					const auto toR = QString::fromStdString(sm.to);
					const auto isOwn = (from == self);
					const auto peerAddr = isOwn ? toR : from;
					const auto dialogPeer = g_knownGroups.contains(toR)
						? peerFromChat(ChatId(BareId(IdForAddress(toR))))
						: peerFromUser(UserId(BareId(IdForAddress(peerAddr))));
					const auto full = FullMsgId(dialogPeer, MsgId(found.value()));
					if (const auto item = session->data().message(full)) {
						const auto media = buildLocationMedia(ec);
						HistoryMessageEdition edition;
						edition.editDate = TimeId(base::unixtime::now());
						edition.useSameViews = true;
						edition.useSameForwards = true;
						edition.useSameReplies = true;
						edition.useSameMarkup = true;
						edition.useSameReactions = true;
						edition.textWithEntities = item->originalText();
						edition.mtpMedia = &media;
						item->applyEdition(std::move(edition));
						LOG(("Parvane: правка локации применена msg %1").arg(uuid));
					}
				}
				if (maybeText || hasCaption) {
					const auto toR = QString::fromStdString(sm.to);
					const auto isOwn = (from == self);
					const auto peerAddr = isOwn ? toR : from;
					const auto dialogPeer = g_knownGroups.contains(toR)
						? peerFromChat(ChatId(BareId(IdForAddress(toR))))
						: peerFromUser(UserId(BareId(IdForAddress(peerAddr))));
					const auto full = FullMsgId(dialogPeer, MsgId(found.value()));
					const auto newText = QString::fromStdString(
						maybeText ? *maybeText : ec["caption"].get<std::string>());
					const auto entities = (ec.is_object() && ec.contains("entities"))
						? entitiesFromJson(ec["entities"]) : EntitiesInText();
					if (const auto item = session->data().message(full)) {
						if (item->originalText().text != newText
							|| !entities.isEmpty()) {
							item->setText({ newText, entities });
							session->data().requestItemViewRefresh(item);
							g_mediaContentByMsgId.insert(found.value(),
								QString::fromStdString(ec.dump()));
							LOG(("Parvane: правка применена msg %1").arg(uuid));
						}
					}
				}
				continue; // уже инъецировано — только обновили текст
			}
			// не инъецировано — упадёт в обычную инъекцию ниже (с новым текстом)
		}
		if (sm.read && (from == self)) {
			// Получатель прочитал моё сообщение → ставим ✓✓ на локальном эхо.
			const auto found = g_uuidToMsgId.find(uuid);
			if (found != g_uuidToMsgId.end() && found.value() != 0) {
				const auto pid = IdForAddress(QString::fromStdString(sm.to));
				const auto full = FullMsgId(
					peerFromUser(UserId(BareId(pid))),
					MsgId(found.value()));
				if (const auto item = session->data().message(full)) {
					const auto history = item->history();
					if (history->outboxReadTillId() < item->id) {
						history->outboxRead(item);
						LOG(("Parvane: своё прочитано ✓✓ msg %1").arg(uuid));
					}
				}
				// В журнал — чтобы ✓✓ пережило рестарт (раз на uuid за сессию)
				static QSet<QString> journaled;
				if (!journaled.contains(uuid)) {
					journaled.insert(uuid);
					crl::async([uuid] { MarkHistoryRead({ uuid }); });
				}
			}
			// не continue — ниже contains→continue пропустит уже инъецированное
		}
		{
			// Реакции/закрепление могли измениться (delta-sync или live-пуш
			// мутации) — обновляем инъецированное; снятие пина тоже применяем.
			// Диалог: группа → chat-пир, иначе 1-на-1 user-пир.
			const auto found = g_uuidToMsgId.find(uuid);
			if (found != g_uuidToMsgId.end() && found.value() != 0) {
				const auto toR = QString::fromStdString(sm.to);
				const auto dialogPeer = g_knownGroups.contains(toR)
					? peerFromChat(ChatId(BareId(IdForAddress(toR))))
					: peerFromUser(UserId(BareId(IdForAddress(
						(from == self) ? toR : from))));
				const auto full = FullMsgId(dialogPeer, MsgId(found.value()));
				if (const auto item = session->data().message(full)) {
					applyReactions(item, sm.reactions);
					applyPin(session, item, sm.pinned);
				}
			}
		}
		if (g_uuidToMsgId.contains(uuid)) {
			continue; // уже инъецировано
		}
		// Новое принятое сообщение (текст/медиа, уже расшифровано) — в локальный
		// журнал, чтобы пережить рестарт/релогин (инкрем. курсор его не пере-тянет).
		// При воспроизведении журнала (live=false) НЕ пишем повторно. TTL-сообщения
		// эфемерны — НЕ журналируем (иначе воскреснут при рестарте).
		if (live && TtlFromContent(sm.content) == 0) {
			HistoryAppend(sm);
		} else if (const auto ttl = TtlFromContent(sm.content); ttl > 0) {
			// Эфемерное: после TTL плейнтекст не должен остаться в кэше расшифровки.
			base::call_delayed(ttl * crl::time(1000), [uuid] {
				DecCacheRemove(uuid);
			});
		}
		// Режим «усиленная приватность» (T079, L2-1): смена режима — нативное
		// служебное сообщение чата (личный чат и группа v2), не пузырь.
		if (parvane::contentKind(sm.content) == parvane::v2::kChatModeKind) {
			// Только подписанная операция v2 (состояние ведёт движок): присланное
			// по v1 (старый или злонамеренный клиент) не показываем — иначе
			// собеседник нарисовал бы «режим включён».
			LoadV2Ids();
			if (!IsV2Message(sm.id)) {
				LOG(("Parvane: chat_mode по v1 отброшен msg %1").arg(uuid));
				g_uuidToMsgId.insert(uuid, 0);
				continue;
			}
			injectChatModeMessage(session, sm);
			++added;
			continue;
		}
		// Опросы: голос/закрытие — служебные события (в агрегат, не в историю);
		// сам опрос — отдельная инъекция (медиа-poll, 1-на-1 и группа).
		const auto pollKind = parvane::contentKind(sm.content);
		if (pollKind == "poll_vote" || pollKind == "poll_close") {
			handlePollService(session, sm, pollKind);
			g_uuidToMsgId.insert(uuid, 0); // обработано, не показываем
			continue;
		} else if (pollKind == "poll") {
			if (sm.from == selfStd) {
				// Своё из этой сессии (создание/пересылка) — эхо уже есть.
				auto liveEcho = false;
				{
					std::lock_guard<std::mutex> lk(g_sessionMutex);
					liveEcho = (g_ownSentUuids.count(sm.id) > 0);
				}
				if (liveEcho) {
					g_uuidToMsgId.insert(uuid, 0);
					continue;
				}
			}
			injectPollMessage(session, sm);
			++added;
			continue;
		}
		// Групповое сообщение: to — известная группа → инъекция в историю группы.
		const auto toStr = QString::fromStdString(sm.to);
		if (g_knownGroups.contains(toStr)) {
			// conformance GROUP-2: сервер видит шифртекст и тип не проверяет —
			// сообщение запрещённого вида от участника БЕЗ роли, присланное в
			// обход композера, не показываем (как web). Владелец/админ/self и
			// неизвестная роль — показываем. Оценка при приёме, сообщение
			// считается обработанным (курсор двигается).
			{
				const auto authorAddr = QString::fromStdString(sm.from);
				const auto info = g_groupInfo.constFind(toStr);
				if (authorAddr != SelfAddress()
					&& info != g_groupInfo.constEnd()
					&& GroupRoleOf(toStr, authorAddr) == u"member"_q
					&& !parvane::isContentAllowedForMember(info.value().default_permissions, sm.content)) {
					LOG(("Parvane: групповое %1 (%2) от %3 скрыто правами группы")
						.arg(uuid, QString::fromStdString(parvane::contentKind(sm.content)), authorAddr));
					g_uuidToMsgId.insert(uuid, 0);
					continue;
				}
			}
			const auto gOwn = (from == self);
			if (gOwn) {
				bool liveEcho = false;
				{
					std::lock_guard<std::mutex> lk(g_sessionMutex);
					liveEcho = (g_ownSentUuids.count(sm.id) > 0);
				}
				if (liveEcho) {
					g_uuidToMsgId.insert(uuid, 0);
					continue;
				}
			}
			ensureGroupChat(session, toStr, g_knownGroups.value(toStr), 0);
			const auto gChatId = IdForAddress(toStr);
			const auto gAuthorId = IdForAddress(from);
			const auto gtext = sm.text();
			if (!gtext) {
				// Медиа в группе: качаем блоб → инъекция в историю группы (peerIsChat;
				// автор-юзер синтезируется в inject). Метаданные — как в 1-на-1.
				const auto &c = sm.content;
				const auto kind = QString::fromStdString(parvane::contentKind(c));
				const auto fileId = c.contains("file_id") && c["file_id"].is_string()
					? QString::fromStdString(c["file_id"].get<std::string>())
					: QString();
				if (fileId.isEmpty()) {
					continue;
				}
				auto filename = (c.contains("filename") && c["filename"].is_string())
					? QString::fromStdString(c["filename"].get<std::string>())
					: QString();
				if (filename.isEmpty()) {
					filename = kind + u"_"_q + fileId.left(8);
				}
				const auto mime = (c.contains("mime") && c["mime"].is_string())
					? QString::fromStdString(c["mime"].get<std::string>())
					: u"application/octet-stream"_q;
				const auto size = std::int64_t(
					c.contains("size_bytes") && c["size_bytes"].is_number()
						? c["size_bytes"].get<std::int64_t>() : 0);
				const auto caption = (c.contains("caption")
						&& c["caption"].is_string())
					? QString::fromStdString(c["caption"].get<std::string>())
					: QString();
				const auto jint = [&](const char *k) {
					return (c.contains(k) && c[k].is_number())
						? c[k].get<int>() : 0;
				};
				const auto gjstr = [&](const char *k) {
					return (c.contains(k) && c[k].is_string())
						? QString::fromStdString(c[k].get<std::string>())
						: QString();
				};
				const auto gMsgId = MsgId(g_nextMsgId++);
				g_uuidToMsgId.insert(uuid, gMsgId.bare);
				g_msgIdToUuid.insert(gMsgId.bare, uuid);
				g_mediaContentByMsgId.insert(gMsgId.bare,
					QString::fromStdString(c.dump()));
				if (kind == u"sticker"_q && c.contains("pack_ref")) {
					g_packRefByDocId.insert(docIdFromFileId(fileId),
						QString::fromStdString(c["pack_ref"].dump()));
				}
				RememberBlobCaps(c);
				pumpMediaDownload(toStr, gChatId, gAuthorId, gOwn, sm.ts, gMsgId,
					kind, fileId, filename, mime, size,
					jint("duration_secs"), jint("width"), jint("height"), caption,
					/*peerIsChat=*/true, /*authorAddr=*/from,
					gjstr("file_key"), gjstr("file_nonce"),
					TtlFromContent(sm.content));
				++added;
				LOG(("Parvane: групповое медиа %1 в %2 от %3 (kind=%4) → скачивание")
					.arg(uuid, toStr, from, kind));
				continue;
			}
			const auto gtextQ = QString::fromStdString(*gtext);
			MaterializeEmojiPacks(session, sm.content); // кастом-эмодзи в тексте
			ensurePeerUser(session, gAuthorId, from); // автор в группе
			const auto gMsgId = MsgId(g_nextMsgId++);
			g_uuidToMsgId.insert(uuid, gMsgId.bare);
			g_msgIdToUuid.insert(gMsgId.bare, uuid);
			const auto gEntities = Api::EntitiesToMTP(
				session,
				entitiesFromJson(parvane::contentEntities(sm.content)),
				Api::ConvertOption::WithLocal);
			const auto gWpJson = parvane::contentWebpage(sm.content);
			const auto gHasWp = gWpJson.is_object() && gWpJson.contains("url");
			const auto gIsLoc = (parvane::contentKind(sm.content) == "location");
			const auto gItem = session->data().addNewMessage(
				gMsgId,
				buildMessage(gAuthorId, gChatId, gOwn, sm.ts, gtextQ,
					gHasWp ? buildWebpageMedia(gWpJson)
						: gIsLoc ? buildLocationMedia(sm.content) : MTPMessageMedia(),
					gHasWp || gIsLoc, 0, /*peerIsChat=*/true, gEntities,
					TtlFromContent(sm.content),
					/*mentionsSelf=*/!gOwn && MentionsSelf(
						gtextQ, parvane::contentEntities(sm.content), self)),
				MessageFlags(), NewMessageType::Unread);
			if (gItem) {
				const auto h = gItem->history();
				if (!h->folderKnown()) {
					h->clearFolder();
				}
				LOG(("Parvane: групповое %1 в %2 от %3: %4")
					.arg(uuid, toStr, from, gtextQ));
			}
			++added;
			continue;
		}
		const auto isOwn = (from == self);
		if (isOwn) {
			// Своё сообщение: если отправлено в ЭТОЙ сессии — уже есть локальное
			// эхо, пропускаем (дедуп). Иначе (из прошлой сессии) — восстанавливаем
			// как исходящее, чтобы история пережила рестарт.
			bool liveEcho = false;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				liveEcho = (g_ownSentUuids.count(sm.id) > 0);
			}
			if (liveEcho) {
				g_uuidToMsgId.insert(uuid, 0);
				continue;
			}
		}
		// Диалог — с собеседником (для входящих = отправитель, для своих = to);
		// автор = self для своих; out = своё.
		const auto peerAddress = isOwn
			? QString::fromStdString(sm.to)
			: from;
		if (peerAddress.isEmpty()) {
			continue;
		}
		const auto peerId = IdForAddress(peerAddress);
		// От заблокированного пира входящие не принимаем.
		if (!isOwn) {
			const auto u = session->data().userLoaded(UserId(BareId(peerId)));
			if (u && u->isBlocked()) {
				continue;
			}
		}
		const auto authorId = isOwn ? selfId : peerId;
		const auto out = isOwn;
		if (parvane::contentKind(sm.content) == "unsupported") {
			// Протокол v2: вид, которого клиент не знает (или движок пометил
			// заглушкой), — штатное «сообщение не поддерживается» tdesktop
			// (messageMediaUnsupported → UnsupportedMessageText), курсор идёт.
			RegisterPeer(peerAddress);
			ensurePeerUser(session, peerId, peerAddress);
			const auto msgId = MsgId(g_nextMsgId++);
			g_uuidToMsgId.insert(uuid, msgId.bare);
			g_msgIdToUuid.insert(msgId.bare, uuid);
			const auto item = session->data().addNewMessage(
				msgId,
				buildMessage(authorId, peerId, out, sm.ts, QString(),
					MTP_messageMediaUnsupported(), /*hasMedia=*/true),
				MessageFlags(),
				NewMessageType::Unread);
			if (item && !item->history()->folderKnown()) {
				item->history()->clearFolder();
			}
			++added;
			LOG(("Parvane: заглушка unsupported msg %1 (%2)").arg(uuid, peerAddress));
			continue;
		}
		const auto maybeText = sm.text();
		if (!maybeText) {
			// Медиа (Фаза 4b): резервируем msgId и уходим качать блоб на воркер;
			// инъекция сообщения — после скачивания (injectMediaOnMain).
			const auto &c = sm.content;
			const auto kind = QString::fromStdString(parvane::contentKind(c));
			const auto fileId = c.contains("file_id") && c["file_id"].is_string()
				? QString::fromStdString(c["file_id"].get<std::string>())
				: QString();
			if (fileId.isEmpty()) {
				continue; // неизвестный/битый медиа-контент — пропускаем
			}
			auto filename = (c.contains("filename") && c["filename"].is_string())
				? QString::fromStdString(c["filename"].get<std::string>())
				: QString();
			if (filename.isEmpty()) {
				filename = kind + u"_"_q + fileId.left(8);
			}
			const auto mime = (c.contains("mime") && c["mime"].is_string())
				? QString::fromStdString(c["mime"].get<std::string>())
				: u"application/octet-stream"_q;
			const auto size = std::int64_t(
				c.contains("size_bytes") && c["size_bytes"].is_number()
					? c["size_bytes"].get<std::int64_t>()
					: 0);
			const auto caption = (c.contains("caption") && c["caption"].is_string())
				? QString::fromStdString(c["caption"].get<std::string>())
				: QString();
			const auto jint = [&](const char *k) {
				return (c.contains(k) && c[k].is_number())
					? c[k].get<int>() : 0;
			};
			const auto durationSecs = jint("duration_secs");
			const auto width = jint("width");
			const auto height = jint("height");

			RegisterPeer(peerAddress);
			const auto msgId = MsgId(g_nextMsgId++);
			g_uuidToMsgId.insert(uuid, msgId.bare);
			g_msgIdToUuid.insert(msgId.bare, uuid);
			g_mediaContentByMsgId.insert(msgId.bare,
				QString::fromStdString(c.dump())); // для пересылки
			if (kind == u"sticker"_q && c.contains("pack_ref")) {
				g_packRefByDocId.insert(docIdFromFileId(fileId),
					QString::fromStdString(c["pack_ref"].dump()));
			}
			if (!out && !sm.read && !IsReportedRead(uuid)) {
				g_unreadIncoming[peerId].push_back(uuid);
			}
			const auto jstr = [&](const char *k) {
				return (c.contains(k) && c[k].is_string())
					? QString::fromStdString(c[k].get<std::string>()) : QString();
			};
			RememberBlobCaps(c);
			pumpMediaDownload(peerAddress, peerId, authorId, out, sm.ts, msgId,
				kind, fileId, filename, mime, size,
				durationSecs, width, height, caption,
				/*peerIsChat=*/false, /*authorAddr=*/QString(),
				jstr("file_key"), jstr("file_nonce"),
				TtlFromContent(sm.content)); // E2E медиа (Фаза 3)
			++added;
			LOG(("Parvane: %1 медиа %2 (%3, kind=%4) → скачивание")
				.arg(out ? u"своё"_q : u"входящее"_q)
				.arg(uuid).arg(peerAddress).arg(kind));
			continue;
		}
		const auto text = QString::fromStdString(*maybeText);
		MaterializeEmojiPacks(session, sm.content); // кастом-эмодзи в тексте
		RegisterPeer(peerAddress);
		ensurePeerUser(session, peerId, peerAddress);
		// Ответ: uuid цитируемого → локальный msgId (если он уже инъецирован).
		auto replyToMsgId = std::int64_t(0);
		if (sm.reply_to) {
			const auto rq = QString::fromStdString(*sm.reply_to);
			const auto found = g_uuidToMsgId.value(rq, 0);
			if (found != 0) {
				replyToMsgId = found;
			}
		}
		const auto msgId = MsgId(g_nextMsgId++);
		g_uuidToMsgId.insert(uuid, msgId.bare);
		g_msgIdToUuid.insert(msgId.bare, uuid);
		// read=true у входящего — мой receipt уже есть на сервере (прочитано на
		// любом устройстве); журнал прочитанного — READ-1 этого устройства.
		if (!out && !sm.read && !IsReportedRead(uuid)) {
			g_unreadIncoming[peerId].push_back(uuid);
		}
		const auto entities = Api::EntitiesToMTP(
			session,
			entitiesFromJson(parvane::contentEntities(sm.content)),
			Api::ConvertOption::WithLocal);
		const auto wpJson = parvane::contentWebpage(sm.content);
		const auto hasWp = wpJson.is_object() && wpJson.contains("url");
		const auto isLoc = (parvane::contentKind(sm.content) == "location");
		const auto ttl = TtlFromContent(sm.content);
		const auto mentionsSelf = !out && MentionsSelf(
			text, parvane::contentEntities(sm.content), self);
		if (mentionsSelf) {
			LOG(("Parvane: msg %1: mention-entity этого аккаунта → f_mentioned").arg(uuid));
		}
		const auto item = session->data().addNewMessage(
			msgId,
			buildMessage(authorId, peerId, out, sm.ts, text,
				hasWp ? buildWebpageMedia(wpJson)
					: isLoc ? buildLocationMedia(sm.content) : MTPMessageMedia(),
				/*hasMedia=*/hasWp || isLoc, replyToMsgId,
				/*peerIsChat=*/false, entities, ttl, mentionsSelf),
			MessageFlags(),
			NewMessageType::Unread);
		if (ttl > 0) {
			LOG(("Parvane: ttl-сообщение %1 самоуничтожится через %2с")
				.arg(uuid).arg(ttl));
		}
		++added;
		LOG(("Parvane: %1 msg %2 (%3): %4")
			.arg(out ? u"своё"_q : u"входящее"_q).arg(uuid)
			.arg(peerAddress).arg(text));
		// Диагностика кросс-сценария web→desktop: сообщение принято — это ещё
		// не значит, что кастом-эмодзи отрисовано. Эмодзи рендерится, только
		// если его документ скормлен из локального пака (g_emojiDocToSet);
		// иначе оно деградирует в запасной символ
		for (const auto &e : entitiesFromJson(
				parvane::contentEntities(sm.content))) {
			if (e.type() != EntityType::CustomEmoji) {
				continue;
			}
			auto ok = false;
			const auto docId = qint64(e.data().toLongLong(&ok));
			const auto it = ok
				? g_emojiDocToSet.constFind(docId)
				: g_emojiDocToSet.constEnd();
			if (it != g_emojiDocToSet.constEnd()) {
				LOG(("Parvane: кастом-эмодзи %1 резолвится (набор %2)")
					.arg(docId).arg(it.value()));
			} else {
				LOG(("Parvane: кастом-эмодзи %1 НЕ резолвится — пака нет локально")
					.arg(e.data()));
			}
		}
		if (item) {
			applyReactions(item, sm.reactions);
			if (sm.pinned) {
				applyPin(session, item, true);
			}
			const auto history = item->history();
			// Без живого MTProto папка истории остаётся «неизвестной», и
			// shouldBeInChatList() = false → диалог не появляется в списке.
			// Помечаем основную папку известной (как applyDialog с folder=null):
			// это вызывает updateChatListSortPosition и регистрирует диалог.
			if (!history->folderKnown()) {
				history->clearFolder();
			}
			LOG(("Parvane: диалог %1 — в списке=%2 непрочитано=%3")
				.arg(peerAddress)
				.arg(history->inChatList() ? 1 : 0)
				.arg(history->unreadCount()));
		}
	}
	if (added > 0) {
		{
		// READ-1: входящие, которые ЭТО устройство уже читало (журнал на диске),
		// после воспроизведения/синка не должны возвращать бейдж.
		auto reported = QSet<QString>();
		for (const auto &sm : msgs) {
			const auto q = QString::fromStdString(sm.id);
			if (sm.from != selfStd && IsReportedRead(q)) {
				reported.insert(q);
			}
		}
		if (!reported.isEmpty()) {
			MarkUuidsReadLocal(session, reported);
		}
	}
	LOG(("Parvane: инъецировано %1 сообщений").arg(added));
	}
}

// Приём presence.<id> собеседника: OnlineTill(now+90) известному пиру.
void HandlePresencePayload(const std::string &payload) {
	std::string from;
	try {
		from = parvane::json::parse(payload).value("from", std::string());
	} catch (const std::exception &) {
		return;
	}
	if (from.empty()) {
		return;
	}
	const auto fromQ = QString::fromStdString(from);
	if (L2Active(fromQ)) {
		return; // L2-1: «в сети» собеседника L2-чата не показываем
	}
	crl::on_main([fromQ] {
		const auto session = g_sessionWeak.get();
		if (!session || fromQ == SelfAddress()) {
			return;
		}
		const auto id = IdForAddress(fromQ);
		const auto user = session->data().userLoaded(UserId(BareId(id)));
		if (!user) {
			return; // присутствие незнакомого пира игнорируем
		}
		if (user->updateLastseen(
				Data::LastseenStatus::OnlineTill(base::unixtime::now() + 90))) {
			session->changes().peerUpdated(user, Data::PeerUpdate::Flag::OnlineStatus);
		}
	});
}

// Публикует хартбит присутствия на presence.<мой id> (эфемерно). Зовётся с main
// (таймер). Подписчики ставят пиру OnlineTill(now+90); без нового хартбита за
// 90с статус сам «протухает» → «был(а) недавно» (offline-таймер не нужен).
void publishPresenceHeartbeat() {
	const auto self = SelfAddress();
	if (self.isEmpty()) {
		return;
	}
	// L2-1: присутствие одно на аккаунт — не публикуем, пока усиленная
	// приватность активна хотя бы в одном чате.
	if (!g_l2PresenceAllowed) {
		return;
	}
	// FR-040 (T137): «не показывать, что я в сети» — присутствие не публикуется.
	if (g_privacyPresenceHidden) {
		return;
	}
	const auto selfStd = self.toStdString();
	const auto id = IdForAddress(self);
	crl::async([selfStd, id] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		const parvane::json ev{ { "from", selfStd } };
		try {
			t->publish(parvane::topics::presence(std::to_string(id)), ev.dump());
		} catch (const std::exception &) {
		}
		// То же эфемерным каналом v2 (T134): без соединения v1 это единственный
		// путь, а собеседники на v2 без v1 слушают только его.
		if (const auto s = V2Ready()) {
			s->sendPresence(true);
		}
	});
}

} // namespace

not_null<UserData*> EnsurePeer(
		not_null<Main::Session*> session,
		const QString &address) {
	RegisterPeer(address);
	return ensurePeerUser(session, IdForAddress(address), address);
}

QString OwnFingerprint() {
	return QString::fromStdString(parvane::e2e::ownFingerprint());
}

// Как announceKeyChange в вебе: локальное служебное сообщение (на сервер не
// уходит, в журнал не пишется — после перезапуска остаётся только в логе),
// отпечатки в профиле пересчитываются через ensurePeerUser.
void AnnounceKeyChange(const QString &address) {
	const auto session = g_sessionWeak.get();
	if (!session || address == SelfAddress()) {
		return;
	}
	const auto user = EnsurePeer(session, address);
	const auto text = u"Ключ безопасности %1 изменился."_q.arg(user->name());
	const auto msgId = MsgId(g_nextMsgId++);
	session->data().addNewMessage(
		msgId,
		MTP_messageService(
			MTP_flags(MTPDmessageService::Flag::f_from_id),
			MTP_int(0),
			peerToMTP(user->id),
			peerToMTP(user->id),
			MTPPeer(),                  // saved_peer_id
			MTPMessageReplyHeader(),
			MTP_int(int(QDateTime::currentSecsSinceEpoch())),
			MTP_messageActionCustomAction(MTP_string(text)),
			MTPMessageReactions(),
			MTPint()),                  // ttl_period
		MessageFlags(),
		NewMessageType::Unread);
	LOG(("Parvane: ключ безопасности %1 изменился — служебное сообщение в чате")
		.arg(address));
}

std::vector<not_null<HistoryItem*>> SearchMessagesLocal(
		not_null<Main::Session*> session,
		const QString &query,
		int limit) {
	auto found = std::vector<not_null<HistoryItem*>>();
	const auto needle = query.trimmed();
	if (needle.isEmpty()) {
		return found;
	}
	// Все инъецированные сообщения известны по карте uuid → msgId; пиры у нас
	// только user/chat, поэтому nonChannelMessage находит их без загрузки
	// блоков истории (в отличие от history->blocks закрытых чатов).
	for (auto i = g_uuidToMsgId.cbegin(); i != g_uuidToMsgId.cend(); ++i) {
		const auto item = session->data().nonChannelMessage(MsgId(i.value()));
		if (!item || item->isService()) {
			continue;
		}
		if (item->originalText().text.contains(needle, Qt::CaseInsensitive)) {
			found.push_back(item);
		}
	}
	ranges::sort(found, std::greater<>(), [](not_null<HistoryItem*> item) {
		return std::pair(item->date(), item->id.bare);
	});
	if (int(found.size()) > limit) {
		found.erase(found.begin() + limit, found.end());
	}
	LOG(("Parvane: локальный поиск «%1»: %2 совпадений").arg(needle).arg(found.size()));
	return found;
}

bool MirrorPollCreate(PeerData *peer, const PollData &data) {
	const auto session = g_sessionWeak.get();
	if (!peer || !session || !SessionActive()) {
		return false;
	}
	// Адрес назначения — как в MirrorOutgoing (группа/пир/Saved Messages).
	QString address;
	if (peer->isChat()) {
		const auto chatBare = std::uint64_t(peerToChat(peer->id).bare);
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		address = g_chatIdToGroupId.value(chatBare);
	} else if (peer->isUser()) {
		address = peer->isSelf()
			? SelfAddress()
			: AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	}
	if (address.isEmpty()) {
		LOG(("Parvane: опрос не создан — адрес пира неизвестен"));
		return false;
	}
	auto answers = nlohmann::json::array();
	auto correct = nlohmann::json::array();
	auto i = 0;
	for (const auto &answer : data.answers) {
		answers.push_back(answer.text.text.toStdString());
		if (answer.correct) {
			correct.push_back(i);
		}
		++i;
	}
	auto content = nlohmann::json{
		{ "kind", "poll" },
		{ "question", data.question.text.toStdString() },
		{ "answers", answers },
		{ "multiple", data.multiChoice() },
		{ "quiz", data.quiz() },
		{ "public", data.publicVotes() },
	};
	if (data.quiz()) {
		content["correct"] = correct;
		if (!data.solution.text.isEmpty()) {
			content["solution"] = data.solution.text.toStdString();
		}
	}
	// Локальное эхо + PollState — общий путь инъекции (isOwn по from==self).
	parvane::StoredMessage own;
	own.id = parvane::newUuidV7();
	own.from = SelfAddress().toStdString();
	own.to = address.toStdString();
	own.ts = QDateTime::currentSecsSinceEpoch();
	own.content = content;
	injectPollMessage(session, own);
	HistoryAppend(own); // журнал: свой опрос переживёт рестарт/релогин
	sendInnerAsync(address, content, own.id);
	LOG(("Parvane: опрос создан → %1").arg(address));
	return true;
}

bool MirrorPollVotes(
		std::uint64_t pollId,
		const std::vector<QByteArray> &options) {
	const auto session = g_sessionWeak.get();
	const auto uuid = g_pollUuidById.value(pollId);
	if (!session || uuid.isEmpty()) {
		return false; // не наш опрос — пусть решает нативный путь
	}
	const auto it = g_pollsByUuid.find(uuid);
	if (it == g_pollsByUuid.end()) {
		return false;
	}
	if (it->closed) {
		return true; // опрос остановлен — голос не принимаем
	}
	const auto self = SelfAddress();
	auto idx = QVector<int>();
	auto jopts = nlohmann::json::array();
	for (const auto &option : options) {
		auto ok = false;
		const auto v = option.toInt(&ok);
		if (ok && v >= 0 && v < it->answers) {
			idx.push_back(v);
			jopts.push_back(v);
		}
	}
	if (idx.isEmpty()) {
		it->votes.remove(self); // отзыв голоса
	} else {
		it->votes.insert(self, idx);
	}
	applyPollState(session, *it);
	const auto content = nlohmann::json{
		{ "kind", "poll_vote" },
		{ "poll", uuid.toStdString() },
		{ "options", jopts },
	};
	parvane::StoredMessage own;
	own.id = parvane::newUuidV7();
	own.from = self.toStdString();
	own.to = it->chatAddress.toStdString();
	own.ts = QDateTime::currentSecsSinceEpoch();
	own.content = content;
	g_uuidToMsgId.insert(QString::fromStdString(own.id), 0); // эхо не показываем
	HistoryAppend(own); // журнал: свой выбор переживёт рестарт
	sendInnerAsync(it->chatAddress, content, own.id);
	LOG(("Parvane: голос в опросе %1 (%2 вариантов)")
		.arg(uuid)
		.arg(idx.size()));
	return true;
}

bool MirrorPollClose(std::uint64_t pollId) {
	const auto session = g_sessionWeak.get();
	const auto uuid = g_pollUuidById.value(pollId);
	if (!session || uuid.isEmpty()) {
		return false;
	}
	const auto it = g_pollsByUuid.find(uuid);
	if (it == g_pollsByUuid.end()) {
		return false;
	}
	it->closed = true;
	applyPollState(session, *it);
	const auto content = nlohmann::json{
		{ "kind", "poll_close" },
		{ "poll", uuid.toStdString() },
	};
	parvane::StoredMessage own;
	own.id = parvane::newUuidV7();
	own.from = SelfAddress().toStdString();
	own.to = it->chatAddress.toStdString();
	own.ts = QDateTime::currentSecsSinceEpoch();
	own.content = content;
	g_uuidToMsgId.insert(QString::fromStdString(own.id), 0);
	HistoryAppend(own);
	sendInnerAsync(it->chatAddress, content, own.id);
	LOG(("Parvane: опрос %1 остановлен").arg(uuid));
	return true;
}

void ForwardPollCopy(const QString &toAddress, const QString &contentJson) {
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	auto content = nlohmann::json();
	try {
		content = parvane::poll::normalize(nlohmann::json::parse(contentJson.toStdString()));
	} catch (const std::exception &) {
		return;
	}
	if (content.value("kind", std::string()) != "poll") {
		return;
	}
	parvane::StoredMessage own;
	own.id = parvane::newUuidV7();
	own.from = SelfAddress().toStdString();
	own.to = toAddress.toStdString();
	own.ts = QDateTime::currentSecsSinceEpoch();
	own.content = content;
	// Локальное эхо рисует ШТАТНЫЙ форвард (с меткой «Forwarded from»), мы
	// только регистрируем состояние копии (для голосов получателя) и шлём.
	const auto uuid = QString::fromStdString(own.id);
	auto &st = g_pollsByUuid[uuid];
	st.uuid = uuid;
	st.pollId = std::uint64_t(docIdFromFileId(uuid));
	st.chatAddress = toAddress;
	st.quiz = content.value("quiz", false);
	st.publicVoters = content.value("public", false);
	st.solution = QString::fromStdString(
		content.value("solution", std::string()));
	st.answers = (content.contains("answers")
			&& content["answers"].is_array())
		? int(content["answers"].size())
		: 0;
	g_pollUuidById.insert(st.pollId, uuid);
	HistoryAppend(own); // после рестарта реплей инъецирует копию
	sendInnerAsync(toAddress, content, own.id);
	LOG(("Parvane: опрос переслан (копией) → %1").arg(toAddress));
}

// Отправка геолокации (kind=location) — врезка вместо Api::SendLocation
// (MTProto). Локальное эхо через общий путь инъекции + журнал; на провод —
// E2E-inner (сервер видит только шифртекст).
// ── Запланированные сообщения (локальная очередь+таймер, паритет web
// localState.ts). Нативная вкладка Scheduled завязана на MTProto (в форке нет),
// поэтому сообщение просто уходит в назначенное время обычным путём и
// появляется в чате тогда же. Персист в tdata — переживает рестарт.
struct ScheduledItem {
	QString id;        // uuid будущего сообщения (для дедупа таймеров)
	QString address;   // получатель (адрес юзера/группы)
	QString text;
	nlohmann::json entities;
	std::optional<std::string> replyTo;
	qint64 dueAt = 0;  // unix-секунды
};
std::vector<ScheduledItem> g_scheduled; // под g_sessionMutex
namespace {
void FireScheduledGated(const ScheduledItem &item); // журнал состояния v2 (ниже)
} // namespace
QSet<QString> g_scheduledArmed;         // id, для которых таймер уже взведён (main)

QString ScheduledPath() { return cWorkingDir() + u"tdata/parvane-scheduled.json"_q; }

void SaveScheduledLocked() {
	auto arr = nlohmann::json::array();
	for (const auto &it : g_scheduled) {
		nlohmann::json j{{"id", it.id.toStdString()},
			{"address", it.address.toStdString()},
			{"text", it.text.toStdString()},
			{"entities", it.entities},
			{"due", it.dueAt}};
		if (it.replyTo) j["reply_to"] = *it.replyTo;
		arr.push_back(std::move(j));
	}
	StoreWrite(ScheduledPath(), QString::fromStdString(arr.dump()).toUtf8());
}

// Отправить одно запланированное сообщение сейчас (main-поток): локальное эхо
// через общий путь инъекции + журнал, на провод — E2E-inner (kind=text).
void FireScheduled(const ScheduledItem &item) {
	const auto session = g_sessionWeak.get();
	if (!session || !SessionActive()) {
		return;
	}
	auto content = parvane::textContent(
		item.text.toStdString(), item.entities);
	parvane::StoredMessage own;
	own.id = item.id.toStdString();
	own.from = SelfAddress().toStdString();
	own.to = item.address.toStdString();
	own.ts = QDateTime::currentSecsSinceEpoch();
	own.content = content;
	if (item.replyTo) own.reply_to = *item.replyTo;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_ownSentUuids.insert(own.id);
	}
	injectOnMain(session, { own }, /*live=*/false);
	HistoryAppend(own);
	sendInnerAsync(item.address, content, own.id);
	LOG(("Parvane: запланированное отправлено → %1").arg(item.address));
}

// Взвести таймеры на все элементы очереди (idempotent). Просроченные — сразу.
void ArmScheduledTimers() {
	std::vector<ScheduledItem> due, pending;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		const auto now = QDateTime::currentSecsSinceEpoch();
		for (const auto &it : g_scheduled) {
			if (g_scheduledArmed.contains(it.id)) continue;
			g_scheduledArmed.insert(it.id);
			(it.dueAt <= now ? due : pending).push_back(it);
		}
	}
	// Снятие из очереди + отправка; снятое журналом состояния (удалено или
	// отправлено другим устройством) не уходит (FireScheduledGated).
	for (const auto &it : due) {
		FireScheduledGated(it);
	}
	for (const auto &it : pending) {
		// Клампим задержку (защита от переполнения при испорченном далёком due
		// на диске): максимум ~24 дня.
		const auto secs = std::clamp<qint64>(
			it.dueAt - QDateTime::currentSecsSinceEpoch(), 0, qint64(2000000));
		base::call_delayed(std::max<crl::time>(crl::time(secs * 1000), 1), [it] {
			FireScheduledGated(it);
		});
	}
}

// Поставить сообщение в очередь на dueAt (unix-сек). Врезка вместо нативной
// отправки при action.options.scheduled.
void ScheduleOutgoing(PeerData *peer, const TextWithEntities &textWithEntities,
		std::int64_t replyToMsgId, qint64 dueAt) {
	if (!peer || textWithEntities.text.isEmpty()) {
		return;
	}
	QString address;
	if (peer->isChat()) {
		const auto chatBare = std::uint64_t(peerToChat(peer->id).bare);
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		address = g_chatIdToGroupId.value(chatBare);
	} else if (peer->isUser()) {
		address = peer->isSelf()
			? SelfAddress()
			: AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	}
	if (address.isEmpty()) {
		return;
	}
	auto entitiesJson = entitiesToJson(textWithEntities.entities);
	for (auto &me : detectMentions(textWithEntities.text)) {
		entitiesJson.push_back(std::move(me));
	}
	ScheduledItem item;
	item.id = QString::fromStdString(parvane::newUuidV7());
	item.address = address;
	item.text = textWithEntities.text;
	item.entities = entitiesJson;
	item.dueAt = dueAt;
	if (replyToMsgId != 0) {
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		const auto it = g_msgIdToUuid.find(replyToMsgId);
		if (it != g_msgIdToUuid.end()) item.replyTo = it.value().toStdString();
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_scheduled.push_back(item);
		SaveScheduledLocked();
	}
	LOG(("Parvane: сообщение запланировано → %1 на %2")
		.arg(address).arg(QDateTime::fromSecsSinceEpoch(dueAt).toString(Qt::ISODate)));
	ArmScheduledTimers();
	ScheduleStateFlush("scheduled"); // журнал личного состояния v2 (T098)
}

// Загрузить очередь с диска и взвести таймеры (на старте сессии).
void RestoreScheduled() {
	const auto raw = StoreRead(ScheduledPath());
	if (raw.isEmpty()) {
		return;
	}
	const auto arr = nlohmann::json::parse(raw.toStdString(), nullptr, false);
	if (!arr.is_array()) {
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_scheduled.clear();
		for (const auto &j : arr) {
			if (!j.is_object()) continue;
			ScheduledItem it;
			it.id = QString::fromStdString(j.value("id", std::string()));
			it.address = QString::fromStdString(j.value("address", std::string()));
			it.text = QString::fromStdString(j.value("text", std::string()));
			it.entities = j.contains("entities") ? j["entities"] : nlohmann::json::array();
			it.dueAt = j.value("due", qint64(0));
			if (j.contains("reply_to") && j["reply_to"].is_string())
				it.replyTo = j["reply_to"].get<std::string>();
			if (!it.id.isEmpty() && !it.address.isEmpty()) g_scheduled.push_back(it);
		}
	}
	ArmScheduledTimers();
}

namespace {

// Адрес пира для отправки через шину (группа → group_id, юзер → адрес)
[[nodiscard]] QString BusAddressForPeer(PeerData *peer) {
	if (peer->isChat()) {
		const auto chatBare = std::uint64_t(peerToChat(peer->id).bare);
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		return g_chatIdToGroupId.value(chatBare);
	} else if (peer->isUser()) {
		return peer->isSelf()
			? SelfAddress()
			: AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	}
	return QString();
}

} // namespace

// ── Протокол v2: группы, T080/T119 и журнал личного состояния (spec 007) ─────
// Порт web `src/api/parvane/v2/controller.ts` (группы, ссылки, свои
// устройства) и `stateJournal.ts` (папки/отложенные). Протокол целиком — в
// v2-сессии parvane-core; здесь — перекладка в нативные объекты tdesktop:
// сведения группы из проверенного журнала → тот же parvane::GroupInfo, что у
// v1-групп (ApplyGroupInfo → синтетический ChatData), адрес группы в
// клиентах — "v2g:<hex id>" (как в вебе).
namespace {

[[nodiscard]] QString V2GroupsCachePath() {
	return cWorkingDir() + u"tdata/parvane-v2-groups.json"_q;
}

// Права/разрешения движка (proto3-JSON, ложные поля опущены) → структуры v1.
[[nodiscard]] parvane::AdminRights V2AdminRights(const parvane::json &r) {
	auto a = parvane::AdminRights::none();
	if (!r.is_object()) {
		return a;
	}
	a.change_info = r.value("change_info", false);
	a.delete_messages = r.value("delete_messages", false);
	a.ban_users = r.value("ban_users", false);
	a.invite_users = r.value("invite_users", false);
	a.pin_messages = r.value("pin_messages", false);
	a.add_admins = r.value("add_admins", false);
	return a;
}

[[nodiscard]] parvane::DefaultPermissions V2Permissions(const parvane::json &p) {
	auto d = parvane::DefaultPermissions();
	const auto get = [&](const char *k) {
		return p.is_object() && p.value(k, false);
	};
	d.send_messages = get("send_messages");
	d.send_media = get("send_media");
	d.send_stickers_gifs = get("send_stickers_gifs");
	d.send_polls = get("send_polls");
	d.embed_links = get("embed_links");
	d.invite_users = get("invite_users");
	d.pin_messages = get("pin_messages");
	d.change_info = get("change_info");
	return d;
}

// Сведения группы из журнала (groupInfo движка) → parvane::GroupInfo.
// Группа v2 переведена из v1 (T180, поле журнала `migratedFrom`): связать адреса
// и перевести уже существующий чат прежней группы на адрес v2.
void NoteV2GroupOrigin(not_null<Main::Session*> session, const QString &address, const parvane::json &g) {
	const auto from = QString::fromStdString(g.value("migratedFrom", std::string()));
	if (!NoteGroupMigrated(from, address)) {
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_knownGroups.remove(from);
		g_groupMembers.remove(from);
	}
	g_groupVersions.remove(from);
	g_groupInfo.remove(from);
	LOG(("Parvane: v2: группа %1 продолжает группу v1 %2 (тот же чат)").arg(address, from));
}

// Перевод своей группы v1 в v2 (T180): владелец, все участники на v2 и без
// v1-устройств (проверяет ядро). Попытка — не чаще раза в минуту на группу.
QHash<QString, crl::time> g_migrationTriedAt; // main

void MigrateGroupIfOwner(const parvane::GroupInfo &gi) {
	if (gi.created_by != SelfAddress().toStdString() || !V2Ready()) {
		return;
	}
	const auto gid = QString::fromStdString(gi.group_id);
	const auto now = crl::now();
	if (const auto tried = g_migrationTriedAt.value(gid); tried && now - tried < 60 * crl::time(1000)) {
		return;
	}
	g_migrationTriedAt.insert(gid, now);
	auto members = parvane::json::array();
	for (const auto &m : gi.members) {
		members.push_back({
			{ "address", m.address },
			{ "role", m.role },
			{ "admin_rights", m.admin_rights ? m.admin_rights->toJson() : parvane::json() },
		});
	}
	const auto v1 = parvane::json{
		{ "group_id", gi.group_id }, { "name", gi.name }, { "kind", gi.kind },
		{ "created_by", gi.created_by }, { "members", std::move(members) },
		{ "about", gi.about }, { "avatar", gi.avatar },
		{ "default_permissions", gi.default_permissions.toJson() },
	};
	crl::async([v1, gid] {
		const auto s = V2Ready();
		if (!s) {
			return;
		}
		try {
			// Чат переводит событие groupUpdated новой группы (NoteV2GroupOrigin)
			const auto address = s->migrateGroup(v1);
			if (!address.empty()) {
				LOG(("Parvane: v2: группа v1 %1 переведена в %2").arg(gid, QString::fromStdString(address)));
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: v2: перевод группы %1 не выполнен: %2").arg(gid, QString::fromUtf8(e.what())));
		}
	});
}

[[nodiscard]] parvane::GroupInfo V2GroupInfo(const QString &address, const parvane::json &g) {
	auto gi = parvane::GroupInfo();
	gi.group_id = address.toStdString();
	gi.name = g.value("name", std::string());
	gi.kind = (g.value("kind", 1) == 2) ? "channel" : "group";
	gi.created_by = g.value("owner", std::string());
	if (g.contains("members") && g["members"].is_array()) {
		for (const auto &m : g["members"]) {
			auto gm = parvane::GroupMember();
			gm.address = m.value("user", std::string());
			const auto role = m.value("role", 1);
			gm.role = (role == 3) ? "owner" : (role == 2) ? "admin" : "member";
			if (role == 2) {
				gm.admin_rights = V2AdminRights(m.value("rights", parvane::json()));
			}
			gi.members.push_back(std::move(gm));
		}
	}
	if (g.contains("banned") && g["banned"].is_array()) {
		for (const auto &b : g["banned"]) {
			if (b.is_string()) {
				auto gm = parvane::GroupMember();
				gm.address = b.get<std::string>();
				gm.role = "banned";
				gi.members.push_back(std::move(gm));
			}
		}
	}
	gi.avatar = g.value("avatarFileId", std::string());
	gi.about = g.value("about", std::string());
	gi.default_permissions = V2Permissions(g.value("defaultPermissions", parvane::json()));
	gi.version = g.value("version", std::uint64_t(0));
	// Число заявок на вступление сессия кладёт только решающему (T143)
	gi.pending_requests = g.value("pendingRequests", -1);
	return gi;
}

// Сведения v2-групп переживают рестарт: история из журнала кладётся в чат
// группы, только если группа уже известна (до подъёма v2-сессии). Только
// метаданные (как web `parvane:v2groups:<self>`).
void SaveV2GroupCache(const QString &address, const parvane::json *info) {
	auto all = parvane::json::parse(StoreRead(V2GroupsCachePath()).toStdString(), nullptr, false);
	if (!all.is_object()) {
		all = parvane::json::object();
	}
	if (info) {
		all[address.toStdString()] = *info;
	} else {
		all.erase(address.toStdString());
	}
	StoreWrite(V2GroupsCachePath(), QString::fromStdString(all.dump()).toUtf8());
}

void LoadV2GroupCache(not_null<Main::Session*> session) {
	const auto all = parvane::json::parse(StoreRead(V2GroupsCachePath()).toStdString(), nullptr, false);
	if (!all.is_object()) {
		return;
	}
	auto n = 0;
	for (auto it = all.begin(); it != all.end(); ++it) {
		if (parvane::v2::isGroupAddress(it.key()) && it.value().is_object()) {
			NoteV2GroupOrigin(session, QString::fromStdString(it.key()), it.value());
			ApplyGroupInfo(session, V2GroupInfo(QString::fromStdString(it.key()), it.value()), u"v2 кэш"_q);
			++n;
		}
	}
	if (n) {
		LOG(("Parvane: v2: группы из кэша: %1").arg(n));
	}
}

// T080 (FR-028): сервер показывает участника без подтверждённой записи
// администратора — ключей он не получает; нативное служебное сообщение в чате.
void AnnounceUnconfirmed(const QString &address, const QStringList &members) {
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	const auto chat = ensureGroupChat(session, address, g_knownGroups.value(address), 0);
	if (!chat) {
		return;
	}
	for (const auto &member : members) {
		const auto user = ensurePeerUser(session, IdForAddress(member), member);
		const auto text = tr::lng_parvane_group_unconfirmed_member(tr::now, lt_user, user->name());
		session->data().addNewMessage(
			MsgId(g_nextMsgId++),
			MTP_messageService(
				MTP_flags(MTPDmessageService::Flags(0)),
				MTP_int(0),
				MTPPeer(),                  // from_id
				peerToMTP(chat->id),
				MTPPeer(),                  // saved_peer_id
				MTPMessageReplyHeader(),
				MTP_int(int(QDateTime::currentSecsSinceEpoch())),
				MTP_messageActionCustomAction(MTP_string(text)),
				MTPMessageReactions(),
				MTPint()),                  // ttl_period
			MessageFlags(),
			NewMessageType::Unread);
		LOG(("Parvane: v2: в группе %1 участник %2 без подтверждённой записи администратора — служебное сообщение")
			.arg(address, member));
	}
}

// T119: в своём журнале устройств появилось новое устройство — нативное
// сервисное уведомление (как «новый вход» в Telegram).
void AnnounceNewOwnDevices(int count) {
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	const auto history = session->data().history(PeerData::kServiceNotificationsId);
	if (!history->folderKnown()) {
		history->clearFolder(); // иначе requestDialogEntry ушёл бы в MTProto
	}
	session->data().serviceNotification(TextWithEntities{ tr::lng_parvane_new_own_device(tr::now) });
	LOG(("Parvane: v2: новое своё устройство (%1) — сервисное уведомление").arg(count));
}

void ApplyV2Group(const QString &address, const parvane::json &info, bool isNew) {
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	SaveV2GroupCache(address, &info);
	NoteV2GroupOrigin(session, address, info);
	ApplyGroupInfo(session, V2GroupInfo(address, info), isNew ? u"v2 новая"_q : u"v2 журнал"_q);
	LOG(("Parvane: v2: группа %1 %2 (v%3, эпоха %4, участников %5)")
		.arg(address, isNew ? u"появилась"_q : u"обновлена"_q)
		.arg(info.value("version", std::uint64_t(0)))
		.arg(info.value("epoch", std::uint64_t(0)))
		.arg(int(info.value("members", parvane::json::array()).size())));
}

// ── журнал личного состояния (T098): папки и отложенные ─────────────────────
// Рабочая копия — нативные данные tdesktop (фильтры Data::ChatFilters,
// очередь g_scheduled); правка пользователя → разница со сведённым снимком →
// записи журнала; записи других устройств → снимок → нативные объекты.
// Черновики tdesktop хранит в своём локальном хранилище, блок-лист и архив у
// десктопа локально не ведутся (MTProto заглушён) — эти виды журнал не трогает.
const std::vector<std::string> kV2StateKinds{
	"folders", "scheduled", "notify", "blocked", "archived", "pinned",
};
bool g_stateAttached = false;    // main
bool g_stateApplying = false;    // main: применяем снимок — не зеркалить назад
bool g_stateFlushQueued = false; // main
std::unique_ptr<base::Timer> g_stateTimer;

[[nodiscard]] QString StateDomain() {
	const auto self = SelfAddress();
	const auto at = self.indexOf('@');
	return (at >= 0) ? self.mid(at + 1) : QString();
}

[[nodiscard]] parvane::json StatePeerOf(const QString &address) {
	if (address.contains('@')) {
		return { { "user", { { "address", address.toStdString() } } } };
	}
	auto hex = parvane::v2::isGroupAddress(address.toStdString())
		? QString::fromStdString(parvane::v2::groupHex(address.toStdString()))
		: QString(address).remove('-').toLower();
	static const auto re = QRegularExpression(u"^[0-9a-f]{32}$"_q);
	if (!re.match(hex).hasMatch()) {
		return nullptr;
	}
	return { { "group", {
		{ "domain", StateDomain().toStdString() },
		{ "id", parvane::v2::hexToB64(hex.toStdString()) } } } };
}

// Группа v2 — зарегистрированная `v2g:<hex>`; иначе UUIDv7 группы v1.
[[nodiscard]] QString StateAddressOf(const parvane::json &peer) {
	if (!peer.is_object()) {
		return QString();
	}
	if (peer.contains("user") && peer["user"].is_object()) {
		return QString::fromStdString(peer["user"].value("address", std::string()));
	}
	if (!peer.contains("group") || !peer["group"].is_object()) {
		return QString();
	}
	const auto hex = QString::fromStdString(
		parvane::v2::b64ToHex(peer["group"].value("id", std::string())));
	if (hex.size() != 32) {
		return QString();
	}
	const auto v2 = u"v2g:"_q + hex;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (g_knownGroups.contains(v2)) {
			return v2;
		}
	}
	const auto isUuidV7 = hex[12] == '7' && QString(u"89ab"_q).contains(hex[16]);
	return isUuidV7
		? (hex.mid(0, 8) + '-' + hex.mid(8, 4) + '-' + hex.mid(12, 4) + '-'
			+ hex.mid(16, 4) + '-' + hex.mid(20))
		: v2;
}

[[nodiscard]] QString HistoryAddress(not_null<History*> history) {
	const auto peer = history->peer;
	if (peer->isUser()) {
		return peer->isSelf()
			? SelfAddress()
			: AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	} else if (peer->isChat()) {
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		return g_chatIdToGroupId.value(std::uint64_t(peerToChat(peer->id).bare));
	}
	return QString();
}

[[nodiscard]] History *HistoryForAddress(not_null<Main::Session*> session, const QString &address) {
	if (address.isEmpty()) {
		return nullptr;
	}
	if (address == SelfAddress()) {
		return session->data().history(session->user());
	}
	if (address.contains('@')) {
		RegisterPeer(address);
		return session->data().history(ensurePeerUser(session, IdForAddress(address), address));
	}
	QString name;
	bool known = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		known = g_knownGroups.contains(address);
		name = g_knownGroups.value(address);
	}
	if (known) {
		if (const auto chat = ensureGroupChat(session, address, name, 0)) {
			return session->data().history(chat);
		}
	}
	return session->data().history(peerFromChat(ChatId(BareId(IdForAddress(address)))));
}

// Нативные данные → proto3-JSON StateSnapshot по видам kV2StateKinds.
[[nodiscard]] parvane::json BuildLocalState(not_null<Main::Session*> session) {
	using Flag = Data::ChatFilter::Flag;
	const auto peers = [](const auto &histories) {
		auto a = parvane::json::array();
		for (const auto &h : histories) {
			if (auto p = StatePeerOf(HistoryAddress(h)); !p.is_null()) {
				a.push_back(std::move(p));
			}
		}
		return a;
	};
	auto folders = parvane::json::array();
	auto order = parvane::json::array();
	for (const auto &f : session->data().chatsFilters().list()) {
		if (f.id() <= 1) {
			continue; // 0 и 1 зарезервированы журналом («все чаты», архив) — не трогаем
		}
		const auto flags = f.flags();
		folders.push_back({
			{ "id", f.id() },
			{ "title", f.title().text.text.toStdString() },
			{ "emoticon", f.iconEmoji().toStdString() },
			{ "include_peers", peers(f.always()) },
			{ "exclude_peers", peers(f.never()) },
			{ "pinned_peers", peers(f.pinned()) },
			{ "contacts", bool(flags & Flag::Contacts) },
			{ "non_contacts", bool(flags & Flag::NonContacts) },
			{ "groups", bool(flags & Flag::Groups) },
			{ "channels", bool(flags & Flag::Channels) },
			{ "bots", bool(flags & Flag::Bots) },
			{ "exclude_muted", bool(flags & Flag::NoMuted) },
			{ "exclude_read", bool(flags & Flag::NoRead) },
			{ "exclude_archived", bool(flags & Flag::NoArchived) },
			{ "color", f.colorIndex() ? int(*f.colorIndex()) : -1 },
		});
		order.push_back(f.id());
	}
	auto scheduled = parvane::json::array();
	auto items = std::vector<ScheduledItem>();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		items = g_scheduled;
	}
	for (const auto &it : items) {
		auto peer = StatePeerOf(it.address);
		const auto content = parvane::v2::toV2(
			parvane::textContent(it.text.toStdString(), it.entities),
			it.replyTo.value_or(std::string()));
		if (peer.is_null() || !content) {
			continue;
		}
		try {
			scheduled.push_back({
				{ "op_id", parvane::v2::uuidToB64(it.id.toStdString()) },
				{ "peer", std::move(peer) },
				{ "send_at_ms", std::to_string(it.dueAt * 1000) },
				{ "content", parvane::v2::toBase64(
					parvane::v2::encodeMessage("parvane.msg.v2.Content", *content)) },
			});
		} catch (const std::exception &e) {
			LOG(("Parvane: v2: отложенное %1 не в журнал: %2").arg(it.id, QString::fromUtf8(e.what())));
		}
	}
	// Настройки уведомлений (FR-039): блоб веба → state.v1.NotifySettings.
	const auto notifyOf = [](const QString &webJson) {
		const auto w = parvane::json::parse(webJson.toStdString(), nullptr, false);
		auto out = parvane::json::object();
		const auto until = (w.is_object() && w.contains("mutedUntil") && w["mutedUntil"].is_number())
			? w["mutedUntil"].get<std::int64_t>() : 0;
		out["mute_until_ms"] = std::to_string(std::max<std::int64_t>(until, 0) * 1000);
		if (w.is_object() && w.contains("shouldShowPreviews") && w["shouldShowPreviews"].is_boolean()) {
			out["show_previews"] = w["shouldShowPreviews"];
		}
		if (w.is_object() && w.contains("isSilentPosting") && w["isSilentPosting"].is_boolean()) {
			out["silent"] = w["isSilentPosting"];
		}
		return out;
	};
	auto notify = parvane::json::array();
	for (auto it = g_notifyExceptions.constBegin(); it != g_notifyExceptions.constEnd(); ++it) {
		if (auto peer = StatePeerOf(it.key()); !peer.is_null()) {
			notify.push_back({ { "peer", std::move(peer) }, { "settings", notifyOf(it.value()) } });
		}
	}
	auto notifyDefaults = parvane::json::object();
	for (auto it = g_notifyDefaults.constBegin(); it != g_notifyDefaults.constEnd(); ++it) {
		notifyDefaults[it.key().toStdString()] = notifyOf(it.value());
	}
	auto blocked = parvane::json::array();
	for (const auto &address : g_blockedAddrs) {
		if (auto peer = StatePeerOf(address); !peer.is_null()) {
			blocked.push_back({ { "peer", std::move(peer) } });
		}
	}
	auto archived = parvane::json::array();
	for (const auto &address : g_archivedAddrs) {
		if (auto peer = StatePeerOf(address); !peer.is_null()) {
			archived.push_back(std::move(peer));
		}
	}
	auto pinnedPeers = parvane::json::array();
	for (const auto &address : g_pinnedAddrs) {
		if (auto peer = StatePeerOf(address); !peer.is_null()) {
			pinnedPeers.push_back(std::move(peer));
		}
	}
	return {
		{ "folders", std::move(folders) },
		{ "folder_order", { { "ids", std::move(order) } } },
		{ "scheduled", std::move(scheduled) },
		{ "notify", std::move(notify) },
		{ "notify_defaults", std::move(notifyDefaults) },
		{ "blocked", std::move(blocked) },
		{ "archived", std::move(archived) },
		{ "pinned", parvane::json::array({
			parvane::json{ { "list", "PIN_LIST_MAIN" }, { "peers", std::move(pinnedPeers) } } }) },
	};
}

// T150 (STATE-2): правка, не успевшая в журнал (сделана до подключения журнала
// либо перед самым выходом), не должна затираться снимком при подключении.
// После каждого сведения с журналом запоминаем отпечаток локального состояния
// по видам; вид, чей отпечаток при следующем подключении другой, правился на
// этом устройстве — он досылается в журнал до проекции снимка (web: `statedirty`).
[[nodiscard]] QString StateSyncedPath() {
	return cWorkingDir() + u"tdata/parvane-state-synced.json"_q;
}

[[nodiscard]] std::map<std::string, std::string> StateKindDigests(const parvane::json &local) {
	// Списки-множества (блок-лист, архив, исключения уведомлений) собираются из
	// QSet/QHash — порядок от запуска к запуску разный, в отпечаток идут сортированными.
	const auto canon = [&](const char *field, bool ordered) {
		if (!local.is_object() || !local.contains(field)) {
			return std::string();
		}
		const auto &value = local[field];
		if (ordered || !value.is_array()) {
			return value.dump();
		}
		auto items = std::vector<std::string>();
		for (const auto &item : value) {
			items.push_back(item.dump());
		}
		std::sort(items.begin(), items.end());
		auto out = std::string();
		for (const auto &item : items) {
			out += item;
			out += '\n';
		}
		return out;
	};
	const auto digest = [](const std::string &text) {
		return QCryptographicHash::hash(
			QByteArray::fromStdString(text),
			QCryptographicHash::Sha256).toHex().toStdString();
	};
	return {
		{ "folders", digest(canon("folders", true) + canon("folder_order", true)) },
		{ "scheduled", digest(canon("scheduled", false)) },
		{ "notify", digest(canon("notify", false) + canon("notify_defaults", true)) },
		{ "blocked", digest(canon("blocked", false)) },
		{ "archived", digest(canon("archived", false)) },
		{ "pinned", digest(canon("pinned", true)) },
	};
}

std::string g_stateSyncedSaved; // main: последнее записанное — не писать файл каждые 8 с

[[nodiscard]] parvane::json LoadStateSynced() { // main
	auto saved = parvane::json::parse(StoreRead(StateSyncedPath()).toStdString(), nullptr, false);
	if (!saved.is_object() || saved.value("self", std::string()) != SelfAddress().toStdString()) {
		return parvane::json::object(); // файла нет либо он другого аккаунта
	}
	return saved;
}

// Пользователь правил вид на этом устройстве. Одного отличия отпечатка мало:
// пропавший или нечитаемый локальный файл тоже меняет отпечаток, и «досылка»
// стёрла бы состояние в журнале у всех устройств (так упал verify_protocol_v2_groups).
void NoteStateEdited(const char *kind) { // main
	auto saved = LoadStateSynced();
	auto edited = saved.value("edited", parvane::json::array());
	for (const auto &k : edited) {
		if (k.is_string() && k.get<std::string>() == kind) {
			return;
		}
	}
	edited.push_back(kind);
	saved["self"] = SelfAddress().toStdString();
	saved["edited"] = std::move(edited);
	g_stateSyncedSaved.clear();
	StoreWrite(StateSyncedPath(), QByteArray::fromStdString(saved.dump()));
}

void SaveStateSynced(const parvane::json &local) { // main
	auto j = parvane::json::object();
	j["self"] = SelfAddress().toStdString();
	for (const auto &[kind, digest] : StateKindDigests(local)) {
		j[kind] = digest;
	}
	// Правка, сделанная, пока шёл синк, ещё ждёт своей отправки — отметки не снимаем
	j["edited"] = g_stateFlushQueued
		? LoadStateSynced().value("edited", parvane::json::array())
		: parvane::json::array();
	auto text = j.dump();
	if (text == g_stateSyncedSaved) {
		return;
	}
	if (StoreWrite(StateSyncedPath(), QByteArray::fromStdString(text))) {
		g_stateSyncedSaved = std::move(text);
	}
}

// Виды, которые правились на этом устройстве после последнего сведения с журналом.
[[nodiscard]] std::vector<std::string> StateDirtyKinds(const parvane::json &local) { // main
	auto out = std::vector<std::string>();
	const auto saved = LoadStateSynced();
	const auto edited = saved.value("edited", parvane::json::array());
	const auto wasEdited = [&](const std::string &kind) {
		for (const auto &k : edited) {
			if (k.is_string() && k.get<std::string>() == kind) {
				return true;
			}
		}
		return false;
	};
	for (const auto &[kind, digest] : StateKindDigests(local)) {
		// Вид правил пользователь И локальное состояние отличается от сведённого.
		// Отпечатка ещё нет (журнал подключается впервые) — главнее журнал.
		const auto differs = saved.contains(kind) && saved[kind].is_string()
			&& saved[kind].get<std::string>() != digest;
		if (wasEdited(kind) && differs) {
			out.push_back(kind);
		}
	}
	return out;
}

void ProjectFolders(not_null<Main::Session*> session, const parvane::json &snap) {
	using Flag = Data::ChatFilter::Flag;
	auto &filters = session->data().chatsFilters();
	const auto current = BuildLocalState(session)["folders"];
	auto currentById = std::map<int, parvane::json>();
	for (const auto &f : current) {
		currentById[f.value("id", 0)] = f;
	}
	const auto list = snap.contains("folders") && snap["folders"].is_array()
		? snap["folders"] : parvane::json::array();
	auto wanted = std::set<int>();
	auto changed = 0;
	for (const auto &f : list) {
		const auto id = f.value("id", 0);
		if (id <= 1) {
			continue;
		}
		wanted.insert(id);
		// Сравнение в нормализованном виде (как BuildLocalState).
		auto norm = parvane::json{
			{ "id", id },
			{ "title", f.value("title", std::string()) },
			{ "emoticon", f.value("emoticon", std::string()) },
			{ "include_peers", f.value("include_peers", parvane::json::array()) },
			{ "exclude_peers", f.value("exclude_peers", parvane::json::array()) },
			{ "pinned_peers", f.value("pinned_peers", parvane::json::array()) },
			{ "contacts", f.value("contacts", false) },
			{ "non_contacts", f.value("non_contacts", false) },
			{ "groups", f.value("groups", false) },
			{ "channels", f.value("channels", false) },
			{ "bots", f.value("bots", false) },
			{ "exclude_muted", f.value("exclude_muted", false) },
			{ "exclude_read", f.value("exclude_read", false) },
			{ "exclude_archived", f.value("exclude_archived", false) },
			{ "color", f.value("color", -1) },
		};
		if (const auto i = currentById.find(id); i != currentById.end() && i->second == norm) {
			continue;
		}
		const auto set = [&](const char *k) {
			auto s = base::flat_set<not_null<History*>>();
			for (const auto &p : norm[k]) {
				if (const auto h = HistoryForAddress(session, StateAddressOf(p))) {
					s.emplace(h);
				}
			}
			return s;
		};
		auto pinned = std::vector<not_null<History*>>();
		for (const auto &p : norm["pinned_peers"]) {
			if (const auto h = HistoryForAddress(session, StateAddressOf(p))) {
				pinned.push_back(h);
			}
		}
		auto flags = Data::ChatFilter::Flags();
		if (norm["contacts"].get<bool>()) flags |= Flag::Contacts;
		if (norm["non_contacts"].get<bool>()) flags |= Flag::NonContacts;
		if (norm["groups"].get<bool>()) flags |= Flag::Groups;
		if (norm["channels"].get<bool>()) flags |= Flag::Channels;
		if (norm["bots"].get<bool>()) flags |= Flag::Bots;
		if (norm["exclude_muted"].get<bool>()) flags |= Flag::NoMuted;
		if (norm["exclude_read"].get<bool>()) flags |= Flag::NoRead;
		if (norm["exclude_archived"].get<bool>()) flags |= Flag::NoArchived;
		const auto color = norm["color"].get<int>();
		filters.set(Data::ChatFilter(
			FilterId(id),
			Data::ChatFilterTitle{
				TextWithEntities{ QString::fromStdString(norm["title"].get<std::string>()) },
				false },
			QString::fromStdString(norm["emoticon"].get<std::string>()),
			(color >= 0) ? std::optional<uint8>(uint8(color)) : std::nullopt,
			flags,
			set("include_peers"),
			std::move(pinned),
			set("exclude_peers")));
		++changed;
	}
	for (const auto &[id, f] : currentById) {
		if (!wanted.contains(id)) {
			filters.remove(FilterId(id));
			++changed;
		}
	}
	// Порядок папок (LWW-регистр); «все чаты» (id 0) — на своём месте в начале.
	if (snap.contains("folder_order") && snap["folder_order"].contains("ids")) {
		auto ids = QVector<MTPint>();
		auto localOrder = std::vector<int>();
		for (const auto &f : filters.list()) {
			if (!f.id()) {
				ids.push_back(MTP_int(0));
			} else {
				localOrder.push_back(f.id());
			}
		}
		auto wantOrder = std::vector<int>();
		for (const auto &v : snap["folder_order"]["ids"]) {
			if (v.is_number_integer() && wanted.contains(v.get<int>())
				&& ranges::find(localOrder, v.get<int>()) != localOrder.end()) {
				wantOrder.push_back(v.get<int>());
			}
		}
		for (const auto id : localOrder) {
			if (ranges::find(wantOrder, id) == wantOrder.end()) {
				wantOrder.push_back(id);
			}
		}
		if (wantOrder != localOrder) {
			for (const auto id : wantOrder) {
				ids.push_back(MTP_int(id));
			}
			filters.apply(MTP_updateDialogFilterOrder(MTP_vector<MTPint>(ids)));
			++changed;
		}
	}
	if (changed) {
		LOG(("Parvane: v2: журнал состояния → папки (%1 изменений)").arg(changed));
	}
}

void ProjectScheduled(const parvane::json &snap) {
	auto sent = std::set<std::string>();
	if (snap.contains("scheduled_sent") && snap["scheduled_sent"].is_array()) {
		for (const auto &id : snap["scheduled_sent"]) {
			if (id.is_string()) sent.insert(id.get<std::string>());
		}
	}
	auto next = std::vector<ScheduledItem>();
	if (snap.contains("scheduled") && snap["scheduled"].is_array()) {
		for (const auto &s : snap["scheduled"]) {
			const auto opB64 = s.value("op_id", std::string());
			const auto id = parvane::v2::b64ToUuid(opB64);
			const auto address = StateAddressOf(s.value("peer", parvane::json()));
			if (!id || address.isEmpty() || sent.contains(opB64)) {
				continue;
			}
			auto item = ScheduledItem();
			item.id = QString::fromStdString(*id);
			item.address = address;
			try {
				item.dueAt = std::stoll(s.value("send_at_ms", std::string("0"))) / 1000;
				const auto raw = parvane::v2::fromBase64Safe(s.value("content", std::string()));
				const auto content = raw
					? parvane::v2::decodeMessage("parvane.msg.v2.Content", *raw)
					: parvane::json();
				const auto v1 = parvane::v2::fromV2(content);
				if (!v1 || parvane::contentKind(*v1) != "text") {
					continue;
				}
				item.text = QString::fromStdString(v1->value("text", std::string()));
				item.entities = v1->contains("entities") ? (*v1)["entities"] : parvane::json::array();
				if (content.contains("reply_to")) {
					if (const auto r = parvane::v2::b64ToUuid(content["reply_to"].value("op_id", std::string()))) {
						item.replyTo = *r;
					}
				}
			} catch (const std::exception &) {
				continue;
			}
			next.push_back(std::move(item));
		}
	}
	auto changed = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		const auto ids = [](const std::vector<ScheduledItem> &v) {
			auto r = std::vector<QString>();
			for (const auto &i : v) r.push_back(i.id + ':' + QString::number(i.dueAt) + ':' + i.text);
			ranges::sort(r);
			return r;
		};
		changed = ids(next) != ids(g_scheduled);
		if (changed) {
			g_scheduled = std::move(next);
			SaveScheduledLocked();
		}
	}
	if (changed) {
		LOG(("Parvane: v2: журнал состояния → отложенные"));
		ArmScheduledTimers();
	}
}

// Настройки уведомлений из журнала → блоб веба → нативные настройки
// (ApplyNotifyBlob). Исключение, которого в журнале больше нет, снимается.
void ProjectNotify(const parvane::json &snap) {
	const auto has = (snap.contains("notify") && snap["notify"].is_array() && !snap["notify"].empty())
		|| (snap.contains("notify_defaults") && snap["notify_defaults"].is_object()
			&& !snap["notify_defaults"].empty());
	if (!QFile::exists(NotifyJournaledPath())) {
		// Вид `notify` появился позже первого переноса состояния: в журнале его
		// ещё нет — локальные настройки уходят в журнал, а не стираются.
		QFile marker(NotifyJournaledPath());
		if (marker.open(QIODevice::WriteOnly)) {
			marker.close();
		}
		if (!has) {
			ScheduleStateFlush("notify");
			return;
		}
	}
	const auto webOf = [](const parvane::json &st) {
		auto w = parvane::json::object();
		try {
			w["mutedUntil"] = std::stoll(st.value("mute_until_ms", std::string("0"))) / 1000;
		} catch (const std::exception &) {
			w["mutedUntil"] = 0;
		}
		if (st.contains("show_previews") && st["show_previews"].is_boolean()) {
			w["shouldShowPreviews"] = st["show_previews"];
		}
		if (st.contains("silent") && st["silent"].is_boolean()) {
			w["isSilentPosting"] = st["silent"];
		}
		return w;
	};
	auto blob = parvane::json{ { "defaults", parvane::json::object() }, { "exceptions", parvane::json::object() } };
	auto next = QSet<QString>();
	if (snap.contains("notify") && snap["notify"].is_array()) {
		for (const auto &entry : snap["notify"]) {
			const auto address = StateAddressOf(entry.value("peer", parvane::json()));
			if (address.isEmpty()) {
				continue;
			}
			next.insert(address);
			const auto web = webOf(entry.value("settings", parvane::json::object()));
			const auto mine = parvane::json::parse(
				g_notifyExceptions.value(address).toStdString(), nullptr, false);
			if (!mine.is_object() || mine.value("mutedUntil", std::int64_t(0)) != web.value("mutedUntil", std::int64_t(0))
				|| mine.value("isSilentPosting", false) != web.value("isSilentPosting", false)) {
				blob["exceptions"][address.toStdString()] = web;
			}
		}
	}
	for (auto it = g_notifyExceptions.constBegin(); it != g_notifyExceptions.constEnd(); ++it) {
		const auto mine = parvane::json::parse(it.value().toStdString(), nullptr, false);
		if (!next.contains(it.key()) && mine.is_object() && mine.value("mutedUntil", std::int64_t(0)) != 0) {
			blob["exceptions"][it.key().toStdString()] = parvane::json{ { "mutedUntil", 0 } };
		}
	}
	if (snap.contains("notify_defaults") && snap["notify_defaults"].is_object()) {
		for (auto it = snap["notify_defaults"].begin(); it != snap["notify_defaults"].end(); ++it) {
			if (!it.value().is_object()) {
				continue;
			}
			const auto key = QString::fromStdString(it.key());
			const auto web = webOf(it.value());
			const auto mine = parvane::json::parse(g_notifyDefaults.value(key).toStdString(), nullptr, false);
			if (!mine.is_object() || mine.value("mutedUntil", std::int64_t(0)) != web.value("mutedUntil", std::int64_t(0))) {
				blob["defaults"][it.key()] = web;
			}
		}
	}
	if (blob["exceptions"].empty() && blob["defaults"].empty()) {
		return;
	}
	LOG(("Parvane: v2: журнал состояния → уведомления (%1 изменений)")
		.arg(int(blob["exceptions"].size() + blob["defaults"].size())));
	ApplyNotifyBlob(QString::fromStdString(blob.dump()));
}

// Блок-лист из журнала → нативный флаг пользователя и локальный список.
void ProjectBlocked(not_null<Main::Session*> session, const parvane::json &snap) {
	auto next = QSet<QString>();
	if (snap.contains("blocked") && snap["blocked"].is_array()) {
		for (const auto &entry : snap["blocked"]) {
			const auto address = StateAddressOf(entry.value("peer", parvane::json()));
			if (!address.isEmpty() && address.contains('@')) {
				next.insert(address);
			}
		}
	}
	if (next == g_blockedAddrs) {
		return;
	}
	const auto before = g_blockedAddrs;
	g_blockedAddrs = next;
	SaveBlockedState();
	auto changed = 0;
	for (const auto &address : (before + next)) {
		const auto isBlocked = next.contains(address);
		if (isBlocked == before.contains(address)) {
			continue;
		}
		RegisterPeer(address);
		const auto user = ensurePeerUser(session, IdForAddress(address), address);
		if (isBlocked) {
			session->api().blockedPeers().block(user);
		} else {
			session->api().blockedPeers().unblock(user, nullptr, true);
		}
		++changed;
	}
	LOG(("Parvane: v2: журнал состояния → блок-лист (%1 изменений)").arg(changed));
}

// Сохранённые архив и закреп → нативные списки чатов. Чат, которого ещё нет в
// списке, закрепится при следующем вызове (после синка / проекции журнала).
void ApplyDialogState(not_null<Main::Session*> session) { // main
	const auto wasApplying = g_stateApplying;
	g_stateApplying = true;
	auto &owner = session->data();
	const auto archive = [&](const QString &address, bool archived) {
		const auto history = HistoryForAddress(session, address);
		if (!history) {
			return;
		}
		const auto isArchived = history->folder() && (history->folder()->id() == Data::Folder::kId);
		if (archived && !isArchived) {
			history->setFolder(owner.folder(Data::Folder::kId));
		} else if (!archived && (isArchived || !history->folderKnown())) {
			history->clearFolder();
		}
	};
	for (const auto &address : g_archivedAddrs) {
		archive(address, true);
	}
	auto want = std::vector<Dialogs::Key>();
	for (const auto &address : g_pinnedAddrs) {
		const auto history = HistoryForAddress(session, address);
		if (!history || g_archivedAddrs.contains(address)) {
			continue;
		}
		if (!history->folderKnown()) {
			history->clearFolder();
		}
		want.push_back(Dialogs::Key(history));
	}
	if (owner.pinnedChatsOrder(static_cast<Data::Folder*>(nullptr)) != want) {
		owner.clearPinnedChats(nullptr);
		for (const auto &key : want) {
			owner.setPinnedFromEntryList(key, true);
		}
		owner.notifyPinnedDialogsOrderUpdated();
	}
	g_stateApplying = wasApplying;
}

// Архив и закреп основного списка из журнала → локальные списки → чаты.
void ProjectDialogs(not_null<Main::Session*> session, const parvane::json &snap) {
	auto archived = QSet<QString>();
	if (snap.contains("archived") && snap["archived"].is_array()) {
		for (const auto &peer : snap["archived"]) {
			if (const auto address = StateAddressOf(peer); !address.isEmpty()) {
				archived.insert(address);
			}
		}
	}
	auto pinned = QStringList();
	if (snap.contains("pinned") && snap["pinned"].is_array()) {
		for (const auto &list : snap["pinned"]) {
			const auto id = list.value("list", parvane::json());
			const auto isMain = (id.is_string() && id.get<std::string>() == "PIN_LIST_MAIN")
				|| (id.is_number_integer() && id.get<int>() == 1);
			if (!isMain || !list.contains("peers") || !list["peers"].is_array()) {
				continue;
			}
			for (const auto &peer : list["peers"]) {
				if (const auto address = StateAddressOf(peer); !address.isEmpty()) {
					pinned.push_back(address);
				}
			}
		}
	}
	if (archived == g_archivedAddrs && pinned == g_pinnedAddrs) {
		return;
	}
	const auto unarchived = g_archivedAddrs - archived;
	g_archivedAddrs = archived;
	g_pinnedAddrs = pinned;
	SaveDialogState();
	for (const auto &address : unarchived) {
		if (const auto history = HistoryForAddress(session, address)) {
			history->clearFolder();
		}
	}
	ApplyDialogState(session);
	LOG(("Parvane: v2: журнал состояния → архив %1, закреплено %2")
		.arg(g_archivedAddrs.size()).arg(g_pinnedAddrs.size()));
}

// «Удалить чат у себя» на другом своём устройстве (T145): в снимке — граница
// очистки по собеседнику; скрываем сообщения диалога не позже неё тем же путём,
// что нотис `cleared` v1 (g_clearedUuids, журнал скрытых, удаление из UI).
void ProjectCleared(not_null<Main::Session*> session, const parvane::json &snap) {
	if (!snap.contains("cleared") || !snap["cleared"].is_array()) {
		return;
	}
	const auto self = SelfAddress();
	auto fresh = QHash<QString, qint64>();
	for (const auto &entry : snap["cleared"]) {
		const auto address = StateAddressOf(entry.value("peer", parvane::json()));
		const auto raw = entry.contains("cleared_until_ms") ? entry["cleared_until_ms"]
			: entry.value("clearedUntilMs", parvane::json(0));
		const auto until = raw.is_string() ? QString::fromStdString(raw.get<std::string>()).toLongLong()
			: raw.is_number() ? qint64(raw.get<std::int64_t>()) : qint64(0);
		if (address.isEmpty() || !address.contains('@') || until <= 0) {
			continue;
		}
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (g_clearedUntilMs.value(address) < until) {
			g_clearedUntilMs[address] = until;
			fresh.insert(address, until);
		}
	}
	if (fresh.isEmpty()) {
		return;
	}
	auto uuids = QSet<QString>();
	// Журнал истории зашифрован построчно (P-13) — читать через хранилище
	for (const auto &line : StoreReadLines(HistoryPath())) {
		const auto j = nlohmann::json::parse(line.toStdString(), nullptr, false);
		if (!j.is_object()) {
			continue;
		}
		const auto id = QString::fromStdString(j.value("id", std::string()));
		const auto from = QString::fromStdString(j.value("from", std::string()));
		const auto to = QString::fromStdString(j.value("to", std::string()));
		const auto dialog = (from == self) ? to : from;
		const auto found = fresh.constFind(dialog);
		if (id.isEmpty() || found == fresh.constEnd()
			|| j.value("ts", std::int64_t(0)) * 1000 > found.value()) {
			continue;
		}
		uuids.insert(id);
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		uuids.subtract(g_clearedUuids);
		g_clearedUuids.unite(uuids);
	}
	// Нотис `cleared` v1-шарда обычно приходит раньше журнала (сервер записывает
	// скрытие и для неизвестных ему id сообщений v2) — тогда скрывать уже нечего,
	// но граница применена, и запись о ней нужна сценарию и разбору.
	LOG(("Parvane: v2: журнал состояния → очистка чатов (%1), скрыто %2 сообщений")
		.arg(fresh.size()).arg(uuids.size()));
	if (uuids.isEmpty()) {
		return;
	}
	AppendCleared(QStringList(uuids.begin(), uuids.end()));
	ForgetClearedOnMain(session, uuids);
}

void ProjectState(not_null<Main::Session*> session, const parvane::json &snap) {
	if (!snap.is_object()) {
		return;
	}
	g_stateApplying = true;
	ProjectCleared(session, snap);
	ProjectFolders(session, snap);
	ProjectScheduled(snap);
	ProjectNotify(snap);
	ProjectBlocked(session, snap);
	ProjectDialogs(session, snap);
	g_stateApplying = false;
	SaveFolders(session);
}

// Своя правка — сначала в журнал, затем чужие записи (web syncNow).
void StateSyncNow() {
	const auto session = g_sessionWeak.get();
	if (!g_stateAttached || !session) {
		return;
	}
	if (!V2Ready()) {
		return;
	}
	const auto desired = BuildLocalState(session);
	crl::async([desired] {
		const auto s = V2Ready();
		if (!s) {
			return;
		}
		parvane::json r;
		try {
			r = s->stateSync(desired, kV2StateKinds);
		} catch (const std::exception &e) {
			LOG(("Parvane: v2: синк журнала состояния: %1").arg(QString::fromUtf8(e.what())));
			return;
		}
		if (!r.is_object()) {
			return;
		}
		if (!r.value("changed", false)) {
			// Журнал принял ровно `desired` — это и есть сведённое состояние (T150)
			crl::on_main([desired] { SaveStateSynced(desired); });
			return;
		}
		crl::on_main([snap = r["snapshot"]] {
			if (const auto session = g_sessionWeak.get()) {
				ProjectState(session, snap);
				if (!g_stateFlushQueued) {
					SaveStateSynced(BuildLocalState(session));
				}
			}
		});
	});
}

// Пользователь заблокировал/разблокировал собеседника (api_blocked_peers.cpp):
// локальный список + журнал личного состояния.
void NoteBlock(not_null<PeerData*> peer, bool blocked) {
	if (g_stateApplying || !peer->isUser()) {
		return;
	}
	const auto address = AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	if (address.isEmpty() || (g_blockedAddrs.contains(address) == blocked)) {
		return;
	}
	if (blocked) {
		g_blockedAddrs.insert(address);
	} else {
		g_blockedAddrs.remove(address);
	}
	SaveBlockedState();
	LOG(("Parvane: %1 %2").arg(blocked ? u"заблокирован"_q : u"разблокирован"_q, address));
	ScheduleStateFlush("blocked");
	if (blocked) {
		// FR-033 (T133): блокировка сама ключ доступа к доставке не отнимает —
		// меняем ключ и раздаём всем, кроме заблокированного.
		crl::async([to = address.toStdString()] {
			const auto s = V2Ready();
			if (!s) {
				return;
			}
			try {
				if (s->revokeContactAccess(to)) {
					LOG(("Parvane: v2: доступ заблокированного отозван (ключ доступа сменён)"));
				}
			} catch (const std::exception &e) {
				LOG(("Parvane: v2: отзыв доступа не выполнен: %1").arg(QString::fromUtf8(e.what())));
			}
		});
	}
}

// Пользователь убрал чат в архив / вернул (ApiWrap::toggleHistoryArchived).
void NoteArchive(not_null<History*> history, bool archived) {
	if (g_stateApplying) {
		return;
	}
	const auto address = HistoryAddress(history);
	if (address.isEmpty() || (g_archivedAddrs.contains(address) == archived)) {
		return;
	}
	if (archived) {
		g_archivedAddrs.insert(address);
		g_pinnedAddrs.removeAll(address);
	} else {
		g_archivedAddrs.remove(address);
	}
	SaveDialogState();
	LOG(("Parvane: чат %1 %2").arg(address, archived ? u"в архиве"_q : u"возвращён из архива"_q));
	NoteStateEdited("pinned"); // архив снимает закреп
	ScheduleStateFlush("archived");
}

// Пользователь закрепил/открепил чат или переставил закреплённые в основном
// списке: порядок берём из нативного списка; закреплённое, которого на этом
// устройстве ещё нет в списке чатов, остаётся в конце.
void NoteDialogPins(not_null<Main::Session*> session) {
	if (g_stateApplying) {
		return;
	}
	auto next = QStringList();
	for (const auto &key : session->data().pinnedChatsOrder(static_cast<Data::Folder*>(nullptr))) {
		if (const auto history = key.history()) {
			if (const auto address = HistoryAddress(history); !address.isEmpty()) {
				next.push_back(address);
			}
		}
	}
	for (const auto &address : g_pinnedAddrs) {
		if (next.contains(address)) {
			continue;
		}
		const auto history = HistoryForAddress(session, address);
		if (!history || !history->inChatList()) {
			next.push_back(address);
		}
	}
	if (next == g_pinnedAddrs) {
		return;
	}
	g_pinnedAddrs = next;
	SaveDialogState();
	LOG(("Parvane: закреплено чатов: %1").arg(g_pinnedAddrs.size()));
	ScheduleStateFlush("pinned");
}

void ScheduleStateFlush(const char *kind) {
	if (g_stateApplying) {
		return;
	}
	NoteStateEdited(kind); // T150: правка пользователя — до журнала может не дойти
	if (!g_stateAttached || g_stateFlushQueued) {
		return;
	}
	g_stateFlushQueued = true;
	base::call_delayed(crl::time(700), [] {
		g_stateFlushQueued = false;
		StateSyncNow();
	});
}

// Подключить журнал (событие stateReady v2-сессии): первый запуск переносит
// локальные папки/отложенные в журнал, дальше — синк раз в 8 с и по правке.
void AttachStateJournal() {
	const auto session = g_sessionWeak.get();
	if (!session || !V2Ready()) {
		return;
	}
	const auto local = BuildLocalState(session);
	const auto dirty = StateDirtyKinds(local);
	crl::async([local, dirty] {
		const auto s = V2Ready();
		if (!s) {
			return;
		}
		parvane::json snap;
		try {
			snap = s->stateAttach(local);
			if (snap.is_object() && !dirty.empty()) {
				// T150: локальная правка этих видов новее журнала — сначала она,
				// затем снимок (иначе проекция её откатит)
				const auto r = s->stateSync(local, dirty);
				if (r.is_object() && r.contains("snapshot")) {
					snap = r["snapshot"];
					auto names = QStringList();
					for (const auto &kind : dirty) {
						names.push_back(QString::fromStdString(kind));
					}
					LOG(("Parvane: v2: несохранённая правка личного состояния дослана в журнал (%1)")
						.arg(names.join(u", "_q)));
				}
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: v2: журнал состояния не прочитан: %1").arg(QString::fromUtf8(e.what())));
			return;
		}
		if (!snap.is_object()) {
			return;
		}
		crl::on_main([snap] {
			const auto session = g_sessionWeak.get();
			if (!session) {
				return;
			}
			g_stateAttached = true;
			ProjectState(session, snap);
			SaveStateSynced(BuildLocalState(session));
			if (!g_stateTimer) {
				g_stateTimer = std::make_unique<base::Timer>([] { StateSyncNow(); });
			}
			// SC-009: правка с другого устройства видна ≤ 10 с (как web, 8 с)
			g_stateTimer->callEach(8 * crl::time(1000));
			LOG(("Parvane: v2: журнал личного состояния подключён (папки, отложенные)"));
		});
	});
}

// Отложенное: отправляет первое устройство, заметившее срок (web
// canSendScheduled/markScheduledSent); без журнала — как раньше.
void FireScheduledGated(const ScheduledItem &item) {
	auto existed = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		const auto before = g_scheduled.size();
		g_scheduled.erase(std::remove_if(g_scheduled.begin(), g_scheduled.end(),
			[&](const auto &s) { return s.id == item.id; }), g_scheduled.end());
		existed = (g_scheduled.size() != before);
		if (existed) {
			SaveScheduledLocked();
		}
	}
	if (!existed) {
		return; // снято журналом (удалено/отправлено другим устройством)
	}
	if (!g_stateAttached) {
		FireScheduled(item);
		return;
	}
	const auto opId = parvane::v2::uuidToB64(item.id.toStdString());
	crl::async([item, opId] {
		auto sent = false;
		if (const auto s = V2Ready()) {
			try {
				sent = s->stateScheduledSent(opId);
			} catch (const std::exception &) {
			}
		}
		crl::on_main([item, opId, sent] {
			if (sent) {
				LOG(("Parvane: v2: отложенное %1 уже отправлено другим устройством").arg(item.id));
			} else {
				FireScheduled(item);
				crl::async([opId] {
					if (const auto s = V2Ready()) {
						s->stateMarkSent(opId);
					}
				});
			}
			ScheduleStateFlush("scheduled");
		});
	});
}

// Событие v2-сессии (рабочий поток) → main.
bool HandleV2SessionEvent(const parvane::json &ev) {
	const auto type = ev.is_object() ? ev.value("type", std::string()) : std::string();
	const auto address = QString::fromStdString(ev.value("address", std::string()));
	if (type == "groupUpdated") {
		crl::on_main([address, info = ev.value("info", parvane::json()), isNew = ev.value("isNew", false)] {
			ApplyV2Group(address, info, isNew);
		});
		return true;
	}
	if (type == "groupLeft") {
		crl::on_main([address] {
			SaveV2GroupCache(address, nullptr);
			if (const auto session = g_sessionWeak.get()) {
				DropGroupLocally(session, address, u"v2: исключены или группа удалена"_q);
			}
		});
		return true;
	}
	if (type == "groupUnconfirmed") {
		auto members = QStringList();
		for (const auto &m : ev.value("members", parvane::json::array())) {
			if (m.is_string()) members.push_back(QString::fromStdString(m.get<std::string>()));
		}
		crl::on_main([address, members] { AnnounceUnconfirmed(address, members); });
		return true;
	}
	if (type == "peerRootChanged") {
		// KEY-1 v2 (T129): у собеседника сменился корень личности — то же
		// служебное сообщение «ключ безопасности изменился», что в v1.
		const auto user = QString::fromStdString(ev.value("user", std::string()));
		LOG(("Parvane: v2: у %1 сменился корневой ключ — предупреждение в чате").arg(user));
		V2NoteRoot(V2Ready(), user.toStdString());
		crl::on_main([user] { AnnounceKeyChange(user); });
		return true;
	}
	if (type == "sskRotationNeeded") {
		// Отозвано устройство, державшее SSK (D-12). Корень на этом устройстве —
		// меняем сразу; иначе ждём устройство с корнем либо ключ восстановления
		// (Settings → Privacy and Security → «Ключ восстановления», T140).
		crl::async([] {
			const auto s = V2Ready();
			if (!s) {
				return;
			}
			const auto state = s->sskState();
			if (!state.value("rotationNeeded", false)) {
				return;
			}
			if (state.value("hasRoot", false)) {
				LOG(("Parvane: v2: смена SSK корнем: %1")
					.arg(QString::fromStdString(s->rotateSsk(std::string()))));
			} else if (const auto key = RecoveryKeyFromE2eFile(); !key.isEmpty()) {
				LOG(("Parvane: v2: смена SSK ключом восстановления: %1")
					.arg(QString::fromStdString(s->rotateSsk(key.toStdString()))));
			} else {
				LOG(("Parvane: v2: SSK ждёт смены — корня на этом устройстве нет"));
				if (state.value("hasBackup", false)) {
					crl::on_main([] {
						if (const auto window = Core::App().activeWindow()) {
							window->showToast(u"Устройство отозвано: смените ключ подписи устройств "
								"в настройках приватности (нужен ключ восстановления)."_q);
						}
					});
				}
			}
		});
		return true;
	}
	if (type == "privacy" || type == "privacySaved") {
		// FR-040: серверное значение приватности (его могло сменить другое
		// устройство) либо подтверждение своей правки.
		const auto saved = (type == "privacySaved");
		const auto strangers = ev.value("strangersAllowed", true);
		const auto groupAddNobody = ev.value("groupAddNobody", false);
		const auto callsNobody = ev.value("callsNobody", false);
		const auto presenceNobody = ev.value("presenceNobody", false);
		crl::on_main([=] {
			const auto self = SelfAddress();
			if (self.isEmpty()) {
				return;
			}
			auto privacy = LoadPrivacyLocal(self);
			if (saved) {
				if (privacy.dirty || privacy.dirtyCallsPresence) {
					privacy.dirty = false;
					privacy.dirtyCallsPresence = false;
					SavePrivacyLocal(self, privacy);
				}
				return;
			}
			// Своя несохранённая правка новее серверного значения — она в пути;
			// остальные поля берём с сервера (их могло сменить другое устройство).
			privacy.set = true;
			if (!privacy.dirty) {
				privacy.strangers = strangers;
				privacy.groupAddNobody = groupAddNobody;
			}
			if (!privacy.dirtyCallsPresence) {
				privacy.callsNobody = callsNobody;
				privacy.presenceNobody = presenceNobody;
			}
			SavePrivacyLocal(self, privacy);
			LOG(("Parvane: приватность с сервера: незнакомые %1, добавление в группы %2, звонки %3, присутствие %4")
				.arg(privacy.strangers ? u"да"_q : u"нет"_q,
					privacy.groupAddNobody ? u"никто"_q : u"все"_q,
					privacy.callsNobody ? u"никто"_q : u"все"_q,
					privacy.presenceNobody ? u"скрыто"_q : u"видно"_q));
		});
		return true;
	}
	if (type == "presence") {
		// «В сети» по эфемерному каналу v2 (T134): автора проверил движок.
		if (ev.value("online", false)) {
			HandlePresencePayload(parvane::json{ { "from", ev.value("from", std::string()) } }.dump());
		}
		return true;
	}
	if (type == "typing") {
		// «Печатает» по эфемерному каналу v2 (T127): автор и чат проверены движком.
		const auto chat = ev.value("chat", std::string());
		handleTypingFrame(parvane::json{
			{"from", ev.value("from", std::string())},
			{"to", parvane::v2::isGroupAddress(chat) ? chat : std::string()},
		}.dump());
		return true;
	}
	if (type == "ownDevicesAdded") {
		const auto count = int(ev.value("devices", parvane::json::array()).size());
		crl::on_main([count] { AnnounceNewOwnDevices(count); });
		PublishLegacySet(); // устройство перешло на v2 — убрать из списка v1
		return true;
	}
	if (type == "stateReady") {
		crl::on_main([] { AttachStateJournal(); });
		PublishLegacySet();
		RepublishDeviceIfRefused();
		V2NoteRoot(V2Ready(), SelfAddress().toStdString());
		return true;
	}
	if (type == "authRejected") {
		// JWT не принят на соединении v2. При живом v1 тот же отказ приходит и по
		// нему; без v1 (E6-1) — только отсюда: иначе клиент молча оставался не в
		// сети, переподключаясь тем же токеном (JWT живёт 24 ч).
		OnAuthRejected(u"отказ авторизации (v2)"_q);
		return true;
	}
	if (type == "legacyV1") {
		// Кадр инбокса v1, переложенный сервером в инбокс v2 (история v1 при
		// первом синке и живые кадры, T045/T046). Пока соединение v1 живо, те же
		// кадры приходят по нему; без него (T134) это единственный путь — подаём
		// кадр тем же обработчикам инбокса (FR-053).
		const auto frame = ev.value("json", std::string());
		parvane::v2::BridgeTransport *bridge = nullptr;
		std::string self;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			bridge = dynamic_cast<parvane::v2::BridgeTransport*>(g_transport.get());
			self = g_selfAddress.toStdString();
		}
		if (bridge && !bridge->hasV1() && !frame.empty() && !self.empty()) {
			bridge->deliver(std::string("msg.user.") + self, frame);
		}
		return true;
	}
	if (type == "needsLinking") {
		// Debug для e2e (T130): других устройств аккаунта нет —
		// PARVANE_AUTORECOVER=<ключ восстановления> либо PARVANE_AUTORESET=1
		// (пароль — из PARVANE_AUTOLOGIN). UI для них на десктопе — T140.
		const auto recover = QString::fromUtf8(ParvaneDevEnv("PARVANE_AUTORECOVER")
			? ParvaneDevEnv("PARVANE_AUTORECOVER") : "");
		const auto reset = ParvaneDevEnv("PARVANE_AUTORESET") != nullptr;
		if (!recover.isEmpty() || reset) {
			const auto login = QString::fromUtf8(ParvaneDevEnv("PARVANE_AUTOLOGIN")
				? ParvaneDevEnv("PARVANE_AUTOLOGIN") : "");
			const auto colon = login.indexOf(':');
			const auto password = (colon > 0) ? login.mid(colon + 1) : QString();
			crl::async([recover, password] {
				std::shared_ptr<parvane::v2::Session> s;
				{
					std::lock_guard<std::mutex> lk(g_v2Mutex);
					s = g_v2;
				}
				if (!s) {
					return;
				}
				const auto result = recover.isEmpty()
					? s->resetIdentity(password.toStdString())
					: s->recoverWithKey(recover.toStdString());
				LOG(("Parvane: v2: %1 → %2")
					.arg(recover.isEmpty() ? u"autoreset"_q : u"autorecover"_q,
						QString::fromStdString(result)));
			});
			return true;
		}
		crl::async([] { StartDeviceLinkOfferForV2(); });
		return true;
	}
	if (type == "callSignal") {
		// Сигнал личного звонка по v2: отправителя проверил движок. Менеджер
		// зовём БЕЗ g_sessionMutex (его колбэки берут этот мьютекс сами).
		const auto from = ev.value("from", std::string());
		const auto signal = ev.contains("signal") ? ev["signal"] : parvane::json::object();
		if (ev.value("group", false)) {
			// Групповой звонок (T141): приглашение либо попарный сигнал mesh
			parvane::GroupCallManager *g = nullptr;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g = g_groupCallManager.get();
			}
			if (g && !from.empty() && signal.is_object()) {
				LOG(("Parvane: v2 ← %1 сигнал группового звонка (%2)").arg(
					QString::fromStdString(from),
					QString::fromStdString(signal.value("type", std::string()))));
				g->handleV2Signal(from, signal);
			}
			return true;
		}
		parvane::CallManager *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_callManager.get();
		}
		if (m && !from.empty() && signal.is_object()) {
			LOG(("Parvane: v2 ← %1 сигнал звонка (%2)").arg(
				QString::fromStdString(from),
				QString::fromStdString(signal.value("type", std::string()))));
			m->handleV2Signal(from, signal);
		}
		return true;
	}
	if (type == "l2State") {
		// Кэш чатов с активной «усиленной приватностью» (L2-1): по нему не
		// шлём typing, не публикуем присутствие и рисуем переключатели.
		const auto list = [&](const char *key) {
			auto out = QSet<QString>();
			if (ev.contains(key) && ev[key].is_array()) {
				for (const auto &c : ev[key]) {
					if (c.is_string()) out.insert(QString::fromStdString(c.get<std::string>()));
				}
			}
			return out;
		};
		const auto chats = list("chats");
		const auto mine = list("mine");
		auto entered = QSet<QString>();
		auto released = QSet<QString>();
		{
			std::lock_guard<std::mutex> lk(g_l2Mutex);
			entered = chats - g_l2Chats;
			released = g_l2Chats - chats;
			g_l2Chats = chats;
			g_l2Mine = mine;
		}
		const auto presence = ev.value("presenceAllowed", true);
		g_l2PresenceAllowed = presence;
		SaveL2Cache(SelfAddress(), chats, mine, presence);
		LOG(("Parvane: v2: режим L2 — активных чатов %1, присутствие %2")
			.arg(chats.size()).arg(presence ? u"публикуется"_q : u"не публикуется"_q));
		crl::on_main([entered, released] {
			const auto session = g_sessionWeak.get();
			for (const auto &chat : entered) {
				// «В сети» собеседника L2-чата больше не показываем.
				if (!session || parvane::v2::isGroupAddress(chat.toStdString())) {
					continue;
				}
				const auto user = session->data().userLoaded(UserId(BareId(IdForAddress(chat))));
				if (user && user->updateLastseen(Data::LastseenStatus::Recently())) {
					session->changes().peerUpdated(user, Data::PeerUpdate::Flag::OnlineStatus);
				}
			}
			for (const auto &chat : released) {
				if (!parvane::v2::isGroupAddress(chat.toStdString())) {
					EnsurePresenceSubscription(chat); // режим снят
				}
			}
			g_l2Updates.fire({});
		});
		return true;
	}
	if (type == "groupL2") {
		// Политика L2 группы изменилась по журналу — служебное сообщение в чате
		// группы от имени того, кто её задал (в журнал истории, как сообщение).
		parvane::StoredMessage sm;
		sm.id = ev.value("id", std::string());
		sm.from = ev.value("by", std::string());
		sm.to = address.toStdString();
		sm.ts = ev.value("tsMs", std::int64_t(0)) / 1000;
		sm.content = parvane::v2::chatModeContent(ev.value("enabled", false));
		if (sm.id.empty() || sm.to.empty()) {
			return true;
		}
		V2NoteMessage(sm, address); // id не v1: без v1-ack
		LOG(("Parvane: v2: политика L2 группы %1: %2 (задал %3)")
			.arg(address, ev.value("enabled", false) ? u"включена"_q : u"выключена"_q,
				QString::fromStdString(sm.from)));
		crl::on_main([sm] {
			if (const auto session = g_sessionWeak.get()) {
				injectOnMain(session, { sm }, /*live=*/true);
			}
		});
		return true;
	}
	return false;
}

} // namespace

// Личное состояние (T132): публичные точки врезки нативных путей.
void MirrorBlock(not_null<PeerData*> peer, bool blocked) {
	NoteBlock(peer, blocked);
}

void MirrorArchive(not_null<History*> history, bool archived) {
	NoteArchive(history, archived);
}

void MirrorDialogPins(not_null<Main::Session*> session) {
	NoteDialogPins(session);
}

// ── T079: приватность «сообщения от незнакомых» и режим L2 (публичное) ─────

bool StrangersPolicyAvailable() {
	return V2Enabled();
}

bool StrangersAllowed() {
	return LoadPrivacyLocal(SelfAddress()).strangers;
}

void SetStrangersAllowed(bool allowed) {
	const auto self = SelfAddress();
	if (self.isEmpty()) {
		return;
	}
	auto privacy = LoadPrivacyLocal(self);
	privacy.set = true;
	privacy.dirty = true;
	privacy.strangers = allowed;
	SavePrivacyLocal(self, privacy);
	LOG(("Parvane: приватность: сообщения от незнакомых — %1")
		.arg(allowed ? u"разрешены"_q : u"запрещены"_q));
	crl::async([privacy] {
		std::shared_ptr<parvane::v2::Session> s;
		{
			std::lock_guard<std::mutex> lk(g_v2Mutex);
			s = g_v2;
		}
		if (s) {
			s->setPrivacy(privacy.groupAddNobody, privacy.strangers); // не готова — дошлёт сама
		}
	});
}

// ── T140: ключ восстановления (публичное, для Settings → Privacy) ──────────

RecoveryState FetchRecoveryState() {
	auto out = RecoveryState();
	std::shared_ptr<parvane::v2::Session> s;
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		s = g_v2;
	}
	if (!s) {
		return out;
	}
	out.available = true;
	out.needsLinking = s->needsLinking();
	if (s->isReady()) {
		const auto state = s->sskState();
		out.rotationNeeded = state.value("rotationNeeded", false);
		out.hasRoot = state.value("hasRoot", false);
		out.hasBackup = state.value("hasBackup", false);
	}
	return out;
}

QString RotateSskWithKey(const QString &recoveryKey) {
	const auto s = V2Ready();
	if (!s) {
		return u"failed"_q;
	}
	const auto result = QString::fromStdString(s->rotateSsk(recoveryKey.trimmed().toStdString()));
	LOG(("Parvane: v2: смена SSK ключом восстановления: %1").arg(result));
	return result;
}

QString RecoverWithKey(const QString &recoveryKey) {
	std::shared_ptr<parvane::v2::Session> s;
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		s = g_v2;
	}
	if (!s || !s->needsLinking()) {
		return u"failed"_q;
	}
	const auto result = QString::fromStdString(s->recoverWithKey(recoveryKey.trimmed().toStdString()));
	LOG(("Parvane: v2: вход по ключу восстановления: %1").arg(result));
	return result;
}

QString ResetIdentityWithPassword(const QString &password) {
	std::shared_ptr<parvane::v2::Session> s;
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		s = g_v2;
	}
	if (!s || !s->needsLinking()) {
		return u"failed"_q;
	}
	const auto result = QString::fromStdString(s->resetIdentity(password.toStdString()));
	LOG(("Parvane: v2: сброс личности: %1").arg(result));
	return result;
}

// FR-040 (T137): нативные пункты Settings → Privacy «Last seen & online»,
// «Calls», «Groups & channels». У Parvane два значения — «все» и «никто».
bool PrivacyAudienceNobody(PrivacyAudience which) {
	const auto privacy = LoadPrivacyLocal(SelfAddress());
	switch (which) {
	case PrivacyAudience::Calls: return privacy.callsNobody;
	case PrivacyAudience::Presence: return privacy.presenceNobody;
	case PrivacyAudience::GroupAdd: return privacy.groupAddNobody;
	}
	return false;
}

void SetPrivacyAudienceNobody(PrivacyAudience which, bool nobody) {
	const auto self = SelfAddress();
	if (self.isEmpty()) {
		return;
	}
	auto privacy = LoadPrivacyLocal(self);
	privacy.set = true;
	const auto name = [&] {
		switch (which) {
		case PrivacyAudience::Calls:
			privacy.callsNobody = nobody;
			privacy.dirtyCallsPresence = true;
			return u"звонки"_q;
		case PrivacyAudience::Presence:
			privacy.presenceNobody = nobody;
			privacy.dirtyCallsPresence = true;
			return u"присутствие"_q;
		case PrivacyAudience::GroupAdd:
			privacy.groupAddNobody = nobody;
			privacy.dirty = true;
			return u"добавление в группы"_q;
		}
		return QString();
	}();
	SavePrivacyLocal(self, privacy);
	LOG(("Parvane: приватность: %1 — %2").arg(name, nobody ? u"никто"_q : u"все"_q));
	crl::async([privacy, which] {
		std::shared_ptr<parvane::v2::Session> s;
		{
			std::lock_guard<std::mutex> lk(g_v2Mutex);
			s = g_v2;
		}
		if (!s) {
			return;
		}
		// не готова — дошлёт сама
		if (which == PrivacyAudience::GroupAdd) {
			s->setPrivacy(privacy.groupAddNobody, privacy.strangers);
		} else {
			s->setCallsPresencePrivacy(privacy.callsNobody, privacy.presenceNobody);
		}
	});
}

ChatL2 ChatL2State(not_null<PeerData*> peer) {
	auto out = ChatL2();
	if (!V2Enabled()) {
		return out;
	}
	if (const auto user = peer->asUser()) {
		const auto address = AddressForId(peerToUser(user->id).bare);
		if (address.isEmpty() || address == SelfAddress()) {
			return out;
		}
		std::lock_guard<std::mutex> lk(g_l2Mutex);
		out.active = g_l2Chats.contains(address);
		out.mine = g_l2Mine.contains(address);
		out.available = out.active || g_l2V2Peers.contains(address);
		out.canChange = out.available;
	} else if (const auto chat = peer->asChat()) {
		const auto gid = GroupIdForChat(peer);
		if (!parvane::v2::isGroupAddress(gid.toStdString())) {
			return out;
		}
		std::lock_guard<std::mutex> lk(g_l2Mutex);
		out.available = true;
		out.active = g_l2Chats.contains(gid);
		out.mine = out.active;
		out.canChange = chat->canEditInformation();
	}
	return out;
}

rpl::producer<> ChatL2Updates() {
	return g_l2Updates.events();
}

void RefreshChatL2(not_null<PeerData*> peer) {
	const auto user = peer->asUser();
	if (!user || !V2Enabled()) {
		return;
	}
	const auto address = AddressForId(peerToUser(user->id).bare);
	if (address.isEmpty() || address == SelfAddress()) {
		return;
	}
	crl::async([address] {
		const auto s = V2Ready();
		if (!s || !s->isV2Peer(address.toStdString())) {
			return;
		}
		{
			std::lock_guard<std::mutex> lk(g_l2Mutex);
			if (g_l2V2Peers.contains(address)) {
				return;
			}
			g_l2V2Peers.insert(address);
		}
		crl::on_main([] { g_l2Updates.fire({}); });
	});
}

void SetChatL2(not_null<PeerData*> peer, bool enabled, Fn<void(bool ok)> done) {
	const auto finish = [done](bool ok) {
		crl::on_main([done, ok] {
			if (done) {
				done(ok);
			}
		});
	};
	if (const auto user = peer->asUser()) {
		const auto address = AddressForId(peerToUser(user->id).bare).toStdString();
		const auto self = SelfAddress().toStdString();
		if (address.empty() || address == self) {
			finish(false);
			return;
		}
		const auto id = parvane::v2::newUuidV7();
		crl::async([=] {
			const auto s = V2Ready();
			if (!s) {
				LOG(("Parvane: режим L2 не изменён — сессия v2 не готова"));
				finish(false);
				return;
			}
			try {
				s->setDirectL2(address, enabled, id);
			} catch (const std::exception &e) {
				LOG(("Parvane: режим L2 чата %1 не изменён: %2")
					.arg(QString::fromStdString(address), QString::fromUtf8(e.what())));
				finish(false);
				return;
			}
			// Своё служебное сообщение — локально (эхо своей операции не приходит);
			// в журнал истории оно попадёт как обычное сообщение.
			parvane::StoredMessage sm;
			sm.id = id;
			sm.from = self;
			sm.to = address;
			sm.ts = QDateTime::currentSecsSinceEpoch();
			sm.content = parvane::v2::chatModeContent(enabled);
			V2NoteMessage(sm, QString::fromStdString(address));
			crl::on_main([sm] {
				if (const auto session = g_sessionWeak.get()) {
					injectOnMain(session, { sm }, /*live=*/true);
				}
			});
			finish(true);
		});
		return;
	}
	const auto gid = GroupIdForChat(peer).toStdString();
	if (!parvane::v2::isGroupAddress(gid)) {
		finish(false);
		return;
	}
	crl::async([=] {
		const auto s = V2Ready();
		// Служебное сообщение придёт событием сессии groupL2 (всем участникам).
		const auto ok = s && s->setGroupL2(gid, enabled);
		if (!ok) {
			LOG(("Parvane: политика L2 группы %1 не изменена").arg(QString::fromStdString(gid)));
		}
		finish(ok);
	});
}

// Изменение группы v2 записью журнала (на воркере); change строится по
// текущим сведениям журнала. false — группа не v2 (идти по v1).
bool RunV2GroupChange(
		const QString &tag,
		const QString &gid,
		std::function<parvane::json(const parvane::json &info)> change,
		GroupOpDone done) {
	if (!parvane::v2::isGroupAddress(gid.toStdString())) {
		return false;
	}
	crl::async([=] {
		auto ok = false;
		auto error = u"failed"_q;
		if (const auto s = V2Ready()) {
			try {
				const auto info = s->groupInfo(gid.toStdString());
				const auto body = change(info);
				auto code = std::string("failed");
				ok = !body.is_null() && s->changeGroup(gid.toStdString(), body, &code);
				if (!ok) {
					// Код отказа — как у v1-шарда (forbidden, bad_request, …)
					error = QString::fromStdString(code);
				}
			} catch (const std::exception &e) {
				error = QString::fromUtf8(e.what());
			}
		} else {
			error = u"v2 не готов"_q;
		}
		if (ok) {
			LOG(("Parvane: %1 → ok (v2)").arg(tag));
		} else {
			LOG(("Parvane: %1 → отказ v2 %2").arg(tag, error));
		}
		crl::on_main([=] {
			if (done) {
				done(ok, ok ? QString() : error);
			}
		});
	});
	return true;
}

bool MirrorLocationIfOurs(
		PeerData *peer,
		double lat,
		double lon,
		int livePeriod,
		std::string *uuidOut) {
	const auto session = g_sessionWeak.get();
	if (!peer || !session || !SessionActive()) {
		return false;
	}
	const auto address = BusAddressForPeer(peer);
	if (address.isEmpty()) {
		LOG(("Parvane: геолокация не отправлена — адрес пира неизвестен"));
		return false;
	}
	auto content = nlohmann::json{{"kind", "location"}, {"lat", lat}, {"long", lon}};
	if (livePeriod > 0) {
		// Live-локация (формат web publishLivePosition): дальше позиция едет
		// правками того же сообщения через MirrorLiveLocationUpdate
		content["live_period"] = livePeriod;
	}
	const int ttl = PeerTtl(address);
	if (ttl > 0) {
		content["ttl_secs"] = ttl;
	}
	parvane::StoredMessage own;
	own.id = parvane::newUuidV7();
	own.from = SelfAddress().toStdString();
	own.to = address.toStdString();
	own.ts = QDateTime::currentSecsSinceEpoch();
	own.content = content;
	// Инъекция локального эха (live=false → без ack/повторного журнала);
	// журналируем сами (переживёт рестарт), если не эфемерное. Пометка в
	// g_ownSentUuids — ПОСЛЕ инъекции: injectOnMain пропускает свои uuid из
	// этого набора как уже показанное эхо, и до 15 сен 2026 собственный пузырь
	// геолокации не появлялся вовсе (только после рестарта из журнала).
	injectOnMain(session, { own }, /*live=*/false);
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_ownSentUuids.insert(own.id);
	}
	if (ttl == 0) {
		HistoryAppend(own);
	}
	sendInnerAsync(address, content, own.id);
	LOG(("Parvane: геолокация → %1 (%2,%3)").arg(address)
		.arg(lat).arg(lon));
	if (uuidOut) {
		*uuidOut = own.id;
	}
	return true;
}

void MirrorLiveLocationUpdate(
		PeerData *peer,
		const std::string &uuid,
		double lat,
		double lon,
		int livePeriod) {
	const auto session = g_sessionWeak.get();
	if (!peer || !session || !SessionActive()) {
		return;
	}
	const auto address = BusAddressForPeer(peer);
	if (address.isEmpty()) {
		return;
	}
	auto content = nlohmann::json{{"kind", "location"}, {"lat", lat}, {"long", lon}};
	if (livePeriod > 0) {
		content["live_period"] = livePeriod;
	}
	// Собственный пузырь: та же правка медиа, что для входящих live-правок
	// (новая точка → новый CloudImage → карта пересобирается)
	const auto msgId = g_uuidToMsgId.value(QString::fromStdString(uuid), 0);
	if (msgId != 0) {
		const auto full = FullMsgId(peer->id, MsgId(msgId));
		if (const auto item = session->data().message(full)) {
			const auto media = buildLocationMedia(content);
			HistoryMessageEdition edition;
			edition.editDate = TimeId(base::unixtime::now());
			edition.useSameViews = true;
			edition.useSameForwards = true;
			edition.useSameReplies = true;
			edition.useSameMarkup = true;
			edition.useSameReactions = true;
			edition.textWithEntities = item->originalText();
			edition.mtpMedia = &media;
			item->applyEdition(std::move(edition));
			g_mediaContentByMsgId.insert(msgId, QString::fromStdString(content.dump()));
			LOG(("Parvane: правка локации применена msg %1")
				.arg(QString::fromStdString(uuid)));
		}
	}
	publishEditAsync(address.toStdString(), uuid, content);
	LOG(("Parvane: live-правка → %1 (%2,%3)%4").arg(address).arg(lat).arg(lon)
		.arg(livePeriod > 0 ? QString() : u" стоп"_q));
}

bool ShowPollResultsBox(PollData *poll) {
	if (!poll) {
		return false;
	}
	const auto uuid = g_pollUuidById.value(poll->id);
	if (uuid.isEmpty()) {
		return false; // не наш опрос
	}
	const auto it = g_pollsByUuid.constFind(uuid);
	if (it == g_pollsByUuid.constEnd()) {
		return false;
	}
	auto text = poll->question.text + u"\n"_q;
	if (!it->publicVoters) {
		text += u"\nОпрос анонимный — виден только счётчик голосов."_q;
	} else {
		// вариант → список голосовавших (имя из каталога или адрес)
		for (auto i = 0; i != int(poll->answers.size()); ++i) {
			auto names = QStringList();
			for (auto v = it->votes.constBegin();
					v != it->votes.constEnd(); ++v) {
				if (v.value().contains(i)) {
					names.push_back(
						g_displayNames.value(v.key(), v.key()));
				}
			}
			text += u"\n%1 — %2"_q
				.arg(poll->answers[i].text.text)
				.arg(names.isEmpty()
					? u"нет голосов"_q
					: names.join(u", "_q));
		}
	}
	Ui::show(Ui::MakeInformBox(text));
	return true;
}

void SearchUsers(const QString &query, Fn<void(QStringList)> callback) {
	const auto q = query.trimmed().toStdString();
	if (q.empty()) {
		callback({});
		return;
	}
	crl::async([q, callback = std::move(callback)]() mutable {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		auto out = QStringList();
		auto names = QHash<QString, QString>();
		auto avatars = QHash<QString, QString>();
		if (t) {
			try {
				const parvane::json req{ { "query", q } };
				const auto reply = t->request(
					parvane::topics::IdentitySearch, req.dump(), 3000);
				const auto j = parvane::json::parse(reply);
				if (j.contains("users") && j["users"].is_array()) {
					for (const auto &u : j["users"]) {
						if (!u.contains("username")) {
							continue;
						}
						const auto addr = QString::fromStdString(
							u["username"].get<std::string>());
						out.push_back(addr);
						if (u.contains("display_name")) {
							names.insert(addr, QString::fromStdString(
								u["display_name"].get<std::string>()));
						}
						if (u.contains("avatar") && u["avatar"].is_string()) {
							avatars.insert(addr, QString::fromStdString(
								u["avatar"].get<std::string>()));
						}
					}
				}
			} catch (const std::exception &e) {
				LOG(("Parvane: поиск пользователей — ошибка: %1")
					.arg(QString::fromUtf8(e.what())));
			}
		}
		crl::on_main([callback = std::move(callback), out, names, avatars]() mutable {
			for (auto it = names.constBegin(); it != names.constEnd(); ++it) {
				g_displayNames.insert(it.key(), it.value());
			}
			for (auto it = avatars.constBegin(); it != avatars.constEnd(); ++it) {
				NoteAvatar(it.key(), it.value());
			}
			callback(out);
		});
	});
}

void SetDisplayName(const QString &name) {
	const auto n = name.trimmed();
	if (n.isEmpty()) {
		return;
	}
	g_displayNames.insert(SelfAddress(), n); // локально сразу
	const auto nStd = n.toStdString();
	const auto token = Token().toStdString();
	crl::async([nStd, token] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		const parvane::json req{ { "token", token }, { "display_name", nStd } };
		try {
			t->request(parvane::topics::IdentitySetName, req.dump(), 3000);
			LOG(("Parvane: имя обновлено на '%1'").arg(QString::fromStdString(nStd)));
		} catch (const std::exception &) {
		}
	});
}

void SetProfileFields(const ProfileFields &fields) {
	// identity.user.setname требует display_name — шлём текущее (каталог уже
	// резолвил себя при старте), остальные поля — только присланные.
	auto req = parvane::json{
		{ "token", Token().toStdString() },
		{ "display_name", DisplayNameFor(SelfAddress()).toStdString() },
	};
	if (fields.bio) req["bio"] = fields.bio->toStdString();
	if (fields.birthday) req["birthday"] = fields.birthday->toStdString();
	if (fields.phone) req["phone"] = fields.phone->toStdString();
	if (fields.nameColor) req["name_color"] = *fields.nameColor;
	if (fields.personalChannel) req["personal_channel"] = fields.personalChannel->toStdString();
	crl::async([req] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		try {
			t->request(parvane::topics::IdentitySetName, req.dump(), 3000);
			auto shown = req;
			shown.erase("token"); // JWT в лог не попадает
			LOG(("Parvane: профиль обновлён (%1)").arg(QString::fromStdString(shown.dump()).left(400)));
		} catch (const std::exception &e) {
			LOG(("Parvane: профиль не обновлён: %1").arg(QString::fromUtf8(e.what())));
		}
	});
}

namespace {

// Блоб веба → tdesktop. MuteValue: mutedUntil 0 — снять, MAX_INT32 — навсегда,
// иначе абсолютное время.
[[nodiscard]] std::optional<Data::MuteValue> MuteFromWeb(const nlohmann::json &s) {
	if (!s.contains("mutedUntil") || !s["mutedUntil"].is_number()) {
		return std::nullopt;
	}
	const auto until = s["mutedUntil"].get<std::int64_t>();
	if (until <= 0) {
		return Data::MuteValue{ .unmute = true };
	}
	if (until >= 2147483647LL) {
		return Data::MuteValue{ .forever = true };
	}
	const auto left = int(until - QDateTime::currentSecsSinceEpoch());
	return (left > 0) ? Data::MuteValue{ .period = left } : Data::MuteValue{ .unmute = true };
}

[[nodiscard]] std::optional<bool> SilentFromWeb(const nlohmann::json &s) {
	return (s.contains("isSilentPosting") && s["isSilentPosting"].is_boolean())
		? std::optional<bool>(s["isSilentPosting"].get<bool>())
		: std::nullopt;
}

// tdesktop → блоб веба (те же ключи, что у ApiPeerNotifySettings).
[[nodiscard]] QString NotifyToWeb(const Data::PeerNotifySettings &n) {
	auto s = nlohmann::json::object();
	if (const auto until = n.muteUntil()) s["mutedUntil"] = *until;
	if (const auto silent = n.silentPosts()) s["isSilentPosting"] = *silent;
	if (const auto sound = n.sound()) s["hasSound"] = !sound->none;
	return QString::fromStdString(s.dump());
}

[[nodiscard]] QString DefaultKey(Data::DefaultNotify type) {
	return (type == Data::DefaultNotify::User) ? u"users"_q
		: (type == Data::DefaultNotify::Group) ? u"groups"_q
		: u"channels"_q;
}

void PublishNotifyBlob() { // main → worker
	// v1-блоб открыт серверу (список заглушённых чатов). Когда настройки ведёт
	// журнал личного состояния (FR-039) и своих v1-устройств нет — не публикуем.
	if (g_stateAttached) {
		if (const auto s = V2Ready(); s && s->legacyDevices(SelfAddress().toStdString()).empty()) {
			return;
		}
	}
	const auto blob = NotifyBlob().toStdString();
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
		}
		if (!m) {
			return;
		}
		try {
			m->setNotify(from, blob, token);
		} catch (const std::exception &) {
		}
	});
}

struct ApplyingNotifyGuard {
	ApplyingNotifyGuard() { g_applyingNotify = true; }
	~ApplyingNotifyGuard() { g_applyingNotify = false; }
};

} // namespace

// Пришло с другого устройства (NotifyNotice / notify_settings в sync). main.
void ApplyNotifyBlob(const QString &json) {
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	const auto j = nlohmann::json::parse(json.toStdString(), nullptr, false);
	if (!j.is_object()) {
		return;
	}
	auto &settings = session->data().notifySettings();
	const auto guard = ApplyingNotifyGuard(); // локальные хуки не зеркалят обратно
	if (j.contains("defaults") && j["defaults"].is_object()) {
		for (auto it = j["defaults"].begin(); it != j["defaults"].end(); ++it) {
			const auto key = QString::fromStdString(it.key());
			auto type = std::optional<Data::DefaultNotify>();
			if (key == u"users"_q) type = Data::DefaultNotify::User;
			else if (key == u"groups"_q) type = Data::DefaultNotify::Group;
			else if (key == u"channels"_q) type = Data::DefaultNotify::Broadcast;
			if (!type) {
				continue;
			}
			g_notifyDefaults.insert(key, QString::fromStdString(it.value().dump()));
			if (const auto mute = MuteFromWeb(it.value())) {
				settings.defaultUpdate(*type, *mute, SilentFromWeb(it.value()));
			}
		}
	}
	if (j.contains("exceptions") && j["exceptions"].is_object()) {
		for (auto it = j["exceptions"].begin(); it != j["exceptions"].end(); ++it) {
			const auto address = QString::fromStdString(it.key());
			g_notifyExceptions.insert(address, QString::fromStdString(it.value().dump()));
			const auto mute = MuteFromWeb(it.value());
			LOG(("Parvane: уведомления с другого устройства: %1 mutedUntil=%2")
				.arg(address)
				.arg((it.value().contains("mutedUntil") && it.value()["mutedUntil"].is_number())
					? it.value()["mutedUntil"].get<std::int64_t>()
					: 0));
			if (!mute) {
				continue;
			}
			// Ключ исключения — адрес собеседника или group_id (в вебе
			// getAddressForId для группы отдаёт её group_id).
			auto groupName = QString();
			auto isGroup = false;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				isGroup = g_knownGroups.contains(address);
				groupName = g_knownGroups.value(address);
			}
			const auto peer = isGroup
				? static_cast<PeerData*>(ensureGroupChat(session, address, groupName, 0))
				: static_cast<PeerData*>(ensurePeerUser(session, IdForAddress(address), address));
			if (peer) {
				settings.update(peer, *mute, SilentFromWeb(it.value()));
			}
		}
	}
	SaveNotifyState();
	LOG(("Parvane: настройки уведомлений применены с другого устройства"));
}

void MirrorNotifySettings(not_null<const PeerData*> peer) {
	if (g_applyingNotify) {
		return; // применяем чужое — не зеркалим обратно
	}
	auto address = QString();
	if (peer->isUser()) {
		address = AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	} else if (peer->isChat()) {
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		address = g_chatIdToGroupId.value(std::uint64_t(peerToChat(peer->id).bare));
	}
	if (address.isEmpty()) {
		return;
	}
	g_notifyExceptions.insert(address, NotifyToWeb(peer->notify()));
	SaveNotifyState();
	PublishNotifyBlob();
	ScheduleStateFlush("notify");
}

void MirrorNotifyDefault(Data::DefaultNotify type) {
	if (g_applyingNotify) {
		return;
	}
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	g_notifyDefaults.insert(DefaultKey(type),
		NotifyToWeb(session->data().notifySettings().defaultSettings(type)));
	SaveNotifyState();
	PublishNotifyBlob();
	ScheduleStateFlush("notify");
}

void SetOwnAvatar(PeerData *selfPeer, const QImage &image) {
	if (!selfPeer || image.isNull()) {
		return;
	}
	auto bytes = QByteArray();
	{
		QBuffer buf(&bytes);
		buf.open(QIODevice::WriteOnly);
		image.save(&buf, "JPG", 87);
	}
	if (bytes.isEmpty()) {
		return;
	}
	// Локально показываем сразу (photoId — хэш байтов, роль — только идентификатор).
	const auto self = SelfAddress();
	const auto iwl = Images::FromImageInMemory(image, "JPG", bytes);
	const auto photoId = docIdFromFileId(
		QString::number(qHash(bytes)) + self);
	selfPeer->setUserpicInMemory(photoId, iwl);
	// Грузим в cloud + identity.user.setavatar на воркере.
	const auto from = self.toStdString();
	const auto token = Token().toStdString();
	const auto bytesStd = std::string(bytes.constData(), bytes.size());
	crl::async([from, token, bytesStd, self] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		std::string fileId;
		try {
			parvane::CloudClient cloud(*t);
			fileId = cloud.upload(
				from, token, "avatar.jpg", "image/jpeg", bytesStd, {}, true);
		} catch (const std::exception &) {
			return;
		}
		if (fileId.empty()) {
			return;
		}
		try {
			const parvane::json req{ { "token", token }, { "file_id", fileId } };
			t->request(parvane::topics::IdentitySetAvatar, req.dump(), 3000);
			LOG(("Parvane: аватар обновлён (%1)").arg(QString::fromStdString(fileId)));
		} catch (const std::exception &) {
		}
		crl::on_main([self, fileId] {
			g_avatarFileIds.insert(self, QString::fromStdString(fileId));
		});
	});
}

// T134: соединения v1 нет (сервер отключил v1) — запросы переписки и групп v1
// не шлём вовсе: всё приходит инбоксом v2. Звать под g_sessionMutex.
[[nodiscard]] bool V1AbsentLocked() {
	const auto *bridge = dynamic_cast<parvane::v2::BridgeTransport*>(g_transport.get());
	return bridge && !bridge->hasV1();
}

void PumpReceive() {
	crl::async([] {
		parvane::MessengerClient *m = nullptr;
		std::string self, token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (V1AbsentLocked()) {
				return;
			}
			m = g_messenger.get();
			self = g_selfAddress.toStdString();
			token = g_token.toStdString();
		}
		if (!m || self.empty()) {
			return;
		}
		// Инкрементальный синк по двум курсорам (Фаза 1): id — новые сообщения,
		// updated_at — мутации старых. Пагинация: шард отдаёт ≤100 за раз.
		std::string cursorId;
		std::int64_t cursorUpd = 0;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			cursorId = g_lastSeenId;
			cursorUpd = g_sinceUpdated;
		}
		std::vector<parvane::StoredMessage> msgs;
		std::vector<std::string> readIds; // кросс-девайс прочитанное
		std::string notifyJson;           // кросс-девайс настройки уведомлений
		try {
			for (;;) {
				// Подписанный sync: device_id (подмена per-device копии на
				// сервере), signing_key + подпись (свои sealed-исходящие),
				// legacy-подписанты (история прежних устройств после линковки).
				parvane::MessengerClient::SyncAuth auth;
				auth.device_id = parvane::e2e::deviceId();
				auth.signing_key = parvane::e2e::signingKey();
				auth.signer = [](const std::string &d) { return parvane::e2e::sign(d); };
				auth.extra = [](const std::string &d) { return parvane::e2e::extraSignatures(d); };
				auth.transfers = [] { return parvane::e2e::syncTransfers(); };
				std::vector<std::string> pageRead;
				std::string pageNotify;
				auto page = m->sync(self, token, cursorId, cursorUpd, 15000,
					parvane::e2e::ready() ? &auth : nullptr, &pageRead, &pageNotify);
				readIds.insert(readIds.end(), pageRead.begin(), pageRead.end());
				if (!pageNotify.empty()) {
					notifyJson = pageNotify;
				}
				if (page.empty()) {
					break;
				}
				// Продвигаем курсоры по максимумам страницы (uuid7 сравнивается
				// лексикографически = хронологически).
				for (const auto &sm : page) {
					if (sm.id > cursorId) {
						cursorId = sm.id;
					}
					if (sm.updated_at > cursorUpd) {
						cursorUpd = sm.updated_at;
					}
				}
				const auto lastPage = (page.size() < 100);
				msgs.insert(msgs.end(),
					std::make_move_iterator(page.begin()),
					std::make_move_iterator(page.end()));
				if (lastPage) {
					break;
				}
			}
		} catch (const std::exception &e) {
			const auto what = QString::fromUtf8(e.what());
			LOG(("Parvane: sync ошибка: %1").arg(what));
			if (what.contains(u"отказ авторизации"_q)) {
				OnAuthRejected(what); // истёк на ходу — не молчим
			}
			return;
		}
		// READ-1: read=true у входящих и ReadNotice — подтверждение наших
		// msg.chat.read; остальное неподтверждённое повторяем (ограниченно).
		{
			auto confirmed = std::vector<std::string>();
			for (const auto &sm : msgs) {
				if (sm.read) confirmed.push_back(sm.id);
			}
			ConfirmReads(confirmed);
			ConfirmReads(readIds);
			RetryUnconfirmedReads(m, self, token);
		}
		// Настройки уведомлений с другого устройства (из sync).
		if (!notifyJson.empty()) {
			crl::on_main([notifyJson] { ApplyNotifyBlob(QString::fromStdString(notifyJson)); });
		}
		// Кросс-девайс прочитанное можно применить даже без новых сообщений.
		auto readSet = QSet<QString>();
		for (const auto &id : readIds) {
			readSet.insert(QString::fromStdString(id));
		}
		for (const auto &sm : msgs) {
			if (sm.read && sm.from != self) { // входящее, мой receipt есть
				readSet.insert(QString::fromStdString(sm.id));
			}
		}
		if (msgs.empty()) {
			if (!readSet.isEmpty()) {
				crl::on_main([readSet] {
					if (const auto session = g_sessionWeak.get()) {
						MarkUuidsReadLocal(session, readSet);
					}
				});
			}
			return;
		}
		// Курсор в памяти двигаем всегда — иначе тот же кусок тянулся бы по кругу
		// внутри сессии. Дисковый курсор — отдельно, ниже (как web persistCursor).
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g_lastSeenId = cursorId;
			g_sinceUpdated = cursorUpd;
		}
		// Расшифровка + верификация на воркере. clean=false — проход что-то
		// не прочитал (E2E не поднялся, нет ключа/копии для этого устройства).
		std::vector<std::string> failed;
		const auto clean = prepareIncoming(msgs, /*live=*/true, &failed);
		// Непрочитанное придерживает дисковый курсор, но не навсегда: после
		// kRepairAttempts попыток отпускаем (см. NotePendingAndMayAdvance).
		// Пока E2E не поднялся, курсор не двигаем вообще.
		const auto mayAdvance = parvane::e2e::ready()
			&& NotePendingAndMayAdvance(failed);
		if (!clean) {
			LOG(("Parvane: sync не прочитал %1 сообщ.; дисковый курсор %2")
				.arg(int(failed.size()))
				.arg(mayAdvance ? u"двигаем (попытки исчерпаны)"_q : u"придержан"_q));
		}
		crl::on_main([msgs = std::move(msgs), readSet, cursorId, cursorUpd,
				mayAdvance]() mutable {
			const auto session = g_sessionWeak.get();
			if (!session) {
				return; // сессия не активна: дисковый курсор не двинут — вернётся
			}
			injectOnMain(session, msgs);
			// ТОЛЬКО здесь: сообщения расшифрованы и вставлены. Иначе после
			// рестарта пропущенное не пришло бы дельтой и терялось навсегда
			// (ратчет Olm одноразовый — второй раз тот же шифртекст не открыть).
			if (mayAdvance) {
				crl::async([cursorId, cursorUpd] {
					SaveCursors(cursorId, cursorUpd); // файловый I/O — вне main
				});
			}
			// После инъекции снимаем непрочитанное, прочитанное на другом
			// устройстве (в т.ч. если это же сообщение только что добавлено).
			if (!readSet.isEmpty()) {
				MarkUuidsReadLocal(session, readSet);
			}
		});
	});
}

// ── звонки: публичное API (кнопка UI / debug-хуки) ───────────────────────────

void PlaceCall(const QString &peer, bool video) {
	RegisterPeer(peer);
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_currentCallPeer = peer;
		g_currentCallVideo = video;
	}
	// Подтягиваем pubkey собеседника (для проверки его answer). Асинхронно;
	// answer приходит позже — к тому моменту кэш заполнен.
	ResolveNames({ peer });
	const auto p = peer.toStdString();
	const auto media = std::string(video ? "video" : "audio");
	crl::async([p, media] {
		parvane::CallManager *m = nullptr;
		parvane::ITransport *t = nullptr;
		std::string token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_callManager.get();
			t = g_transport.get();
			token = g_token.toStdString();
		}
		if (m) {
			// Ответить может любое устройство собеседника, в т.ч. то, чей ключ
			// звонков identity не принял (оно подписывает ключом устройства) —
			// перечитываем каталог его устройств до invite.
			if (t) {
				parvane::e2e::refreshContact(p, *t, token);
			}
			m->placeCall(p, media);
			LOG(("Parvane: исходящий звонок → %1 (%2)")
				.arg(QString::fromStdString(p), QString::fromStdString(media)));
		}
	});
}

// ВАЖНО: не держим g_sessionMutex при вызове менеджера — accept/hangup/setMuted
// синхронно дёргают onState, а тот берёт g_sessionMutex → self-deadlock (окно
// зависало). Берём указатель под локом, отпускаем, потом зовём.
void AcceptCall() {
	parvane::CallManager *m = nullptr;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		m = g_callManager.get();
	}
	if (m) m->accept();
}

void HangupCall() {
	parvane::CallManager *m = nullptr;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		m = g_callManager.get();
	}
	if (m) m->hangup();
}

// Заглушить/включить свой микрофон (кнопка в окне звонка).
void ToggleMute(bool muted) {
	parvane::CallManager *m = nullptr;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		m = g_callManager.get();
	}
	if (m) m->setMuted(muted);
}

// Рингтон звонка (штатные звуки tdesktop call_incoming/call_outgoing, в цикле).
// Только main-поток. Играет во время дозвона/входящего, глохнет на Active/Ended.
std::unique_ptr<Media::Audio::Track> g_ringtone;

void PlayRingtone(bool outgoing) {
	g_ringtone = Media::Audio::Current().createTrack();
	if (!g_ringtone) {
		return;
	}
	const auto path = Core::App().settings().getSoundPath(
		outgoing ? u"call_outgoing"_q : u"call_incoming"_q);
	g_ringtone->fillFromFile(path);
	g_ringtone->playInLoop();
}

void StopRingtone() {
	g_ringtone = nullptr;
}

void LeaveGroupCall() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	if (g_groupCallManager) g_groupCallManager->leave();
}

// Начать групповой звонок по чат-пиру (кнопка звонка в шапке группы).
void StartGroupCallForChat(PeerData *chat, bool video) {
	if (!chat || !chat->isChat()) {
		return;
	}
	const auto chatBare = std::uint64_t(peerToChat(chat->id).bare);
	QString gid;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		gid = g_chatIdToGroupId.value(chatBare);
	}
	if (!gid.isEmpty()) {
		StartGroupCall(gid, video);
	}
}

void StartGroupCall(const QString &groupId, bool video) {
	const auto token = Token().toStdString();
	if (token.empty()) {
		return;
	}
	const auto gidStd = groupId.toStdString();
	const auto media = std::string(video ? "video" : "audio");
	const auto self = SelfAddress();
	crl::async([groupId, gidStd, token, media, self] {
		// Участники: из кэша, иначе — запрос group.info.
		QStringList members;
		parvane::GroupClient *gc = nullptr;
		parvane::GroupCallManager *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			members = g_groupMembers.value(groupId);
			gc = g_groupClient.get();
			g = g_groupCallManager.get();
		}
		if (members.isEmpty() && gc) {
			try {
				const auto info = gc->info(token, gidStd);
				for (const auto &m : info.members) {
					members.push_back(QString::fromStdString(m.address));
				}
			} catch (const std::exception &) {
			}
			if (!members.isEmpty()) {
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_groupMembers.insert(groupId, members);
			}
		}
		if (members.isEmpty() || !g) {
			LOG(("Parvane: групповой звонок — нет участников для %1").arg(groupId));
			return;
		}
		// Список в group_invite — ПОЛНЫЙ состав звонка, включая инициатора, без
		// повторов: шард call отвергает приглашение, где нет отправителя
		// («некорректное групповое приглашение»), а кэш участников группы,
		// созданной на этом устройстве, себя не содержит — остальные участники
		// тогда не узнавали друг о друге и mesh между ними не строился.
		if (!self.isEmpty() && !members.contains(self)) {
			members.push_back(self);
		}
		members.removeDuplicates();
		// Подтягиваем pubkey участников (для проверки подписи их SDP).
		ResolveNames(members);
		std::vector<std::string> parts;
		for (const auto &m : members) {
			parts.push_back(m.toStdString());
		}
		g->startCall(parvane::newUuidV7(), parts, media);
		LOG(("Parvane: групповой звонок начат в %1 (%2 участников)")
			.arg(groupId).arg(int(parts.size())));
	});
	// UI-панель группового звонка.
	crl::on_main([] {
		Ui::show(Ui::MakeConfirmBox({
			.text = u"Групповой звонок"_q,
			.confirmed = [](Fn<void()> &&close) { LeaveGroupCall(); close(); },
			.confirmText = u"Завершить"_q,
			.inform = true,
		}));
	});
}

// ── группы: публичное API ────────────────────────────────────────────────────

void OnPeerTtlChanged(not_null<PeerData*> peer) {
	QString address;
	if (peer->isUser()) {
		address = AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	} else if (peer->isChat()) {
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		address = g_chatIdToGroupId.value(std::uint64_t(peerToChat(peer->id).bare));
	}
	if (address.isEmpty()) {
		return;
	}
	SetPeerTtlLocal(address, int(peer->messagesTTL()));
	LOG(("Parvane: TTL чата %1 = %2с").arg(address).arg(int(peer->messagesTTL())));
}

// Тянет список групп/каналов пользователя (group.list) и синтезирует их как
// чаты, чтобы появились в списке диалогов. Воркер → main.
void RefreshGroups() {
	const auto token = Token().toStdString();
	if (token.empty()) {
		return;
	}
	crl::async([token] {
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (V1AbsentLocked()) {
				return; // списка v1-групп нет; группы v2 знает движок
			}
			g = g_groupClient.get();
		}
		if (!g) {
			return;
		}
		std::vector<parvane::GroupInfo> groups;
		try {
			groups = g->list(token);
		} catch (const std::exception &) {
			return;
		}
		crl::on_main([groups] {
			const auto session = g_sessionWeak.get();
			if (!session) {
				return;
			}
			for (const auto &gi : groups) {
				ApplyGroupInfo(session, gi, u"список"_q);
			}
			SubscribeGroupTyping(); // групповой «печатает…»
			LOG(("Parvane: групп синхронизировано: %1").arg(int(groups.size())));
			// Возможно, пришли групповые сообщения до синтеза чата — прогоним sync.
			PumpReceive();
		});
	});
}

void CreateGroup(const QString &name, const QStringList &members, bool channel) {
	const auto token = Token().toStdString();
	if (token.empty() || name.isEmpty()) {
		return;
	}
	std::vector<std::string> mem;
	for (const auto &m : members) {
		mem.push_back(m.toStdString());
	}
	const auto nameStd = name.toStdString();
	const auto kind = std::string(channel ? "channel" : "group");
	crl::async([token, nameStd, kind, mem] {
		// Протокол v2: все участники на v2 — группа v2 (журнал состояния,
		// эпохи); иначе — v1. Чат группы синтезирует событие groupUpdated.
		// Сессия v2 ещё поднимается (сразу после входа) — дождаться, а не
		// создать молча v1-группу (как web isV2Peer ждёт starting).
		{
			std::shared_ptr<parvane::v2::Session> starting;
			{
				std::lock_guard<std::mutex> lk(g_v2Mutex);
				starting = g_v2;
			}
			if (starting && !starting->isReady() && !starting->needsLinking()) {
				starting->waitReady(30000);
			}
		}
		if (const auto s = V2Ready()) {
			try {
				const auto address = s->createGroup(nameStd, mem, kind == "channel");
				if (!address.empty()) {
					LOG(("Parvane: группа v2 '%1' создана: %2")
						.arg(QString::fromStdString(nameStd), QString::fromStdString(address)));
					return;
				}
			} catch (const std::exception &e) {
				LOG(("Parvane: группа v2 не создана: %1 — НЕ создана")
					.arg(QString::fromUtf8(e.what())));
				return;
			}
		}
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g = g_groupClient.get();
		}
		if (!g) {
			return;
		}
		parvane::GroupCreateResponse resp;
		try {
			resp = g->create(token, nameStd, kind, mem);
		} catch (const std::exception &) {
			return;
		}
		if (!resp.ok) {
			LOG(("Parvane: создание группы не удалось: %1")
				.arg(QString::fromStdString(resp.error)));
			return;
		}
		const auto gid = QString::fromStdString(resp.group_id);
		const auto nameQ = QString::fromStdString(nameStd);
		LOG(("Parvane: группа '%1' создана: %2").arg(nameQ, gid));
		// Создатель знает участников СРАЗУ — фиксируем локально, не дожидаясь
		// периодического RefreshGroups. Нужно для E2E-групп: первое же сообщение
		// раздаёт SKDM всем участникам (sealGroup читает g_groupMembers).
		{
			QStringList memQ;
			for (const auto &s : mem) {
				memQ.push_back(QString::fromStdString(s));
			}
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g_knownGroups.insert(gid, nameQ);
			g_groupMembers.insert(gid, memQ);
		}
		crl::on_main([gid, nameQ] {
			const auto session = g_sessionWeak.get();
			if (session) {
				ensureGroupChat(session, gid, nameQ, int(1));
			}
		});
	});
}

// ── Админка групп (add/kick/role/leave) ──────────────────────────────────────
// Общий воркер: зовёт messenger (проверка прав на бэкенде), логирует, обновляет
// список групп. action: "add"|"remove"|"admin"|"member" (роль) — по имени.
void groupAdminAction(const QString &groupId, const QString &member, const QString &action) {
	const auto token = Token().toStdString();
	const auto gid = groupId.toStdString();
	const auto mem = member.toStdString();
	const auto act = action.toStdString();
	if (token.empty() || gid.empty() || mem.empty()) {
		return;
	}
	// Группа v2: add/remove/роль/выход — записи журнала (исключение → новая эпоха).
	if (parvane::v2::isGroupAddress(gid)) {
		const auto self = SelfAddress();
		RunV2GroupChange(u"админ-действие '%1' над %2 в %3"_q.arg(action, member, groupId), groupId,
			[=](const nlohmann::json &) -> nlohmann::json {
				const auto ref = V2MemberRef(member);
				if (action == u"add"_q) {
					const auto s = V2Ready();
					// Добавить в группу v2 можно только v2-собеседника (ключи эпохи — по v2).
					if (!s || !s->isV2Peer(member.toStdString())) {
						LOG(("Parvane: %1 не на v2 — в группу v2 не добавить").arg(member));
						return nullptr;
					}
					return { { "add_member", ref } };
				} else if (action == u"remove"_q) {
					return (member == self)
						? nlohmann::json{ { "leave", nlohmann::json::object() } }
						: nlohmann::json{ { "remove_member", ref } };
				}
				return { { "set_role", {
					{ "member", ref["member"] },
					{ "role", action == u"admin"_q ? "ROLE_ADMIN" : "ROLE_MEMBER" },
					{ "rights", action == u"admin"_q
						? parvane::AdminRights().toJson() : nlohmann::json::object() } } } };
			}, nullptr);
		return;
	}
	crl::async([token, gid, mem, act] {
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g = g_groupClient.get();
		}
		if (!g) {
			return;
		}
		bool ok = false;
		try {
			if (act == "add") {
				ok = g->addMember(token, gid, mem).ok;
			} else if (act == "remove") {
				ok = g->removeMember(token, gid, mem).ok;
			} else { // "admin" | "member" — смена роли
				ok = g->setRole(token, gid, mem, act).ok;
			}
		} catch (const std::exception &) {
		}
		if (ok && act == "remove") {
			QStringList current;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				current = g_groupMembers.value(QString::fromStdString(gid));
				current.removeAll(QString::fromStdString(mem));
				g_groupMembers.insert(QString::fromStdString(gid), current);
			}
			std::vector<std::string> recipients;
			for (const auto &member : current) {
				recipients.push_back(member.toStdString());
			}
			if (parvane::e2e::groupSyncRecipients(gid, recipients)) {
				LOG(("Parvane: участник удалён из %1 → ротация ключа группы")
					.arg(QString::fromStdString(gid)));
			}
		}
		LOG(("Parvane: админ-действие '%1' над %2 в %3: %4")
			.arg(QString::fromStdString(act), QString::fromStdString(mem),
				QString::fromStdString(gid), ok ? u"ok"_q : u"отказ"_q));
		crl::on_main([] { RefreshGroups(); });
	});
}

void AddMember(const QString &groupId, const QString &member) {
	groupAdminAction(groupId, member, u"add"_q);
}
void KickMember(const QString &groupId, const QString &member) {
	groupAdminAction(groupId, member, u"remove"_q);
}
void SetMemberRole(const QString &groupId, const QString &member, bool admin) {
	groupAdminAction(groupId, member, admin ? u"admin"_q : u"member"_q);
}

void BanMember(const QString &groupId, const QString &member, bool ban) {
	// Группа v2: бан — запись журнала, движок помечает эпоху устаревшей →
	// новая эпоха (исключённый ключей не получает).
	if (RunV2GroupChange(u"%1 %2 в %3"_q.arg(ban ? u"бан"_q : u"разбан"_q, member, groupId), groupId,
			[member, ban](const nlohmann::json &) {
				return nlohmann::json{ { ban ? "ban" : "unban", V2MemberRef(member) } };
			}, nullptr)) {
		return;
	}
	const auto token = Token().toStdString();
	const auto gid = groupId.toStdString();
	const auto mem = member.toStdString();
	crl::async([token, gid, mem, ban] {
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g = g_groupClient.get();
		}
		if (!g) {
			return;
		}
		bool ok = false;
		try {
			const auto r = g->ban(token, gid, mem, ban);
			ok = r.ok;
			LOG(("Parvane: %1 %2 в %3 — %4")
				.arg(ban ? u"бан"_q : u"разбан"_q)
				.arg(QString::fromStdString(mem))
				.arg(QString::fromStdString(gid))
				.arg(r.ok ? u"ok"_q : u"ОТКАЗ"_q));
		} catch (const std::exception &) {
		}
		if (ok && ban) {
			QStringList current;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				current = g_groupMembers.value(QString::fromStdString(gid));
				current.removeAll(QString::fromStdString(mem));
				g_groupMembers.insert(QString::fromStdString(gid), current);
			}
			std::vector<std::string> recipients;
			for (const auto &member : current) {
				recipients.push_back(member.toStdString());
			}
			if (parvane::e2e::groupSyncRecipients(gid, recipients)) {
				LOG(("Parvane: участник забанен в %1 → ротация ключа группы")
					.arg(QString::fromStdString(gid)));
			}
		}
		crl::on_main([] { RefreshGroups(); });
	});
}

void MuteMember(const QString &groupId, const QString &member, int minutes) {
	const auto token = Token().toStdString();
	const auto gid = groupId.toStdString();
	const auto mem = member.toStdString();
	const auto until = (minutes > 0)
		? (QDateTime::currentSecsSinceEpoch() + qint64(minutes) * 60)
		: qint64(0);
	if (RunV2GroupChange(u"мьют %1 в %2"_q.arg(member, groupId), groupId, [member, until](const nlohmann::json &) {
			auto ref = V2MemberRef(member);
			ref["until_ms"] = std::to_string(until * 1000);
			return nlohmann::json{ { "mute", ref } };
		}, nullptr)) {
		return;
	}
	crl::async([token, gid, mem, until] {
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g = g_groupClient.get();
		}
		if (!g) {
			return;
		}
		try {
			const auto r = g->mute(token, gid, mem, until);
			LOG(("Parvane: мьют %1 в %2 до %3 — %4")
				.arg(QString::fromStdString(mem))
				.arg(QString::fromStdString(gid))
				.arg(until)
				.arg(r.ok ? u"ok"_q : u"ОТКАЗ"_q));
		} catch (const std::exception &) {
		}
	});
}

// ── US4/US5: инвайт-ссылки, вступление, заявки (spec 004) ────────────────────
// Универсальный воркер запроса: op(client, token) → T на воркере, done(optional<T>,
// error) на main. Исключения транспорта → error.
template <typename Op, typename Done>
void runGroupQuery(Op op, Done done) {
	using T = std::invoke_result_t<Op, parvane::GroupClient&, const std::string&>;
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g = g_groupClient.get();
		}
		auto result = std::optional<T>();
		auto error = QString();
		if (!g || token.empty()) {
			error = u"нет сессии"_q;
		} else {
			try {
				result = op(*g, token);
			} catch (const std::exception &e) {
				error = QString::fromUtf8(e.what());
			}
		}
		crl::on_main([=] { done(result, error); });
	});
}

[[nodiscard]] GroupInviteLink toInviteLink(const parvane::InviteLink &l) {
	auto r = GroupInviteLink();
	r.token = QString::fromStdString(l.token);
	r.createdBy = QString::fromStdString(l.created_by);
	r.title = QString::fromStdString(l.title);
	r.state = QString::fromStdString(l.state);
	r.date = int(l.created_at);
	r.expireDate = int(l.expires_at);
	r.usageLimit = l.max_uses;
	r.usage = l.uses;
	r.requested = l.pending_requests;
	r.requestApproval = l.request_needed;
	r.permanent = l.is_primary;
	r.revoked = l.revoked;
	return r;
}

[[nodiscard]] QString errorOf(const std::string &code, const std::string &text, const QString &transport) {
	if (!code.empty()) return QString::fromStdString(code);
	if (!text.empty()) return QString::fromStdString(text);
	return transport.isEmpty() ? u"failed"_q : transport;
}

QString GroupInviteUrl(const QString &token) {
	// Ссылка v2 (T084): токен — сама ссылка https://<domain>/join/<link_id>#<seed>.
	if (token.startsWith(u"https://"_q)) {
		return token;
	}
	return u"https://parvane.invite/"_q + token;
}

// Ссылка v2 (D-04/T084) — формат https://<domain>/join/<link_id>#<seed>;
// формы v1 (parvane.invite/<t>, …#+<t>, голый hex) — только как вход v1.
[[nodiscard]] bool IsV2InviteLink(const QString &link) {
	return parvane::v2::Session::isInviteUrl(link.trimmed().toStdString());
}

QString GroupInviteToken(const QString &linkOrToken) {
	static const auto hex = QRegularExpression(u"^[0-9a-f]{32}$"_q);
	static const auto hash = QRegularExpression(u"#\\+([0-9a-f]{32})"_q);
	const auto u = linkOrToken.trimmed();
	if (IsV2InviteLink(u)) {
		return u;
	}
	if (hex.match(u).hasMatch()) {
		return u;
	}
	if (const auto m = hash.match(u); m.hasMatch()) {
		return m.captured(1);
	}
	for (const auto &prefix : {
			u"https://parvane.invite/"_q,
			u"http://parvane.invite/"_q,
			u"parvane.invite/"_q }) {
		if (u.startsWith(prefix, Qt::CaseInsensitive)) {
			const auto t = u.mid(prefix.size()).section(u'/', 0, 0).section(u'?', 0, 0);
			return hex.match(t).hasMatch() ? t : QString();
		}
	}
	return QString();
}

QString InviteErrorText(const QString &code) {
	if (code == u"revoked"_q) return tr::lng_parvane_invite_revoked(tr::now);
	if (code == u"expired"_q) return tr::lng_parvane_invite_expired(tr::now);
	if (code == u"exhausted"_q) return tr::lng_parvane_invite_exhausted(tr::now);
	if (code == u"banned"_q) return tr::lng_parvane_invite_banned(tr::now);
	if (code == u"declined"_q) return tr::lng_parvane_invite_declined(tr::now);
	return tr::lng_group_invite_bad_link(tr::now); // invalid и всё прочее
}

// Запись ссылки v2 (хранится на устройстве, секрет — в url) → GroupInviteLink.
[[nodiscard]] GroupInviteLink V2InviteLink(const nlohmann::json &r) {
	auto l = GroupInviteLink();
	l.token = QString::fromStdString(r.value("url", std::string()));
	l.createdBy = SelfAddress();
	l.title = QString::fromStdString(r.value("title", std::string()));
	l.state = u"active"_q;
	l.date = int(r.value("date", std::int64_t(0)));
	l.expireDate = int(r.value("expiresAt", std::int64_t(0)));
	l.usageLimit = int(r.value("usageLimit", 0));
	l.requestApproval = r.value("isRequestNeeded", false);
	// Основная (FR-040) — без параметров.
	l.permanent = l.title.isEmpty() && !l.expireDate && !l.usageLimit && !l.requestApproval;
	return l;
}

void ListGroupInvites(const QString &groupId, bool revoked,
		Fn<void(bool ok, std::vector<GroupInviteLink> links, const QString &error)> done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		// Отозванные ссылки v2 из журнала исчезают (сервер знает только link_id).
		crl::async([=] {
			auto links = std::vector<GroupInviteLink>();
			const auto s = V2Ready();
			if (s && !revoked) {
				for (const auto &r : s->listInvites(groupId.toStdString())) {
					links.push_back(V2InviteLink(r));
				}
			}
			LOG(("Parvane: ссылки v2 %1: %2").arg(groupId).arg(int(links.size())));
			crl::on_main([=] { done(s != nullptr, links, s ? QString() : u"failed"_q); });
		});
		return;
	}
	const auto gid = groupId.toStdString();
	runGroupQuery([gid, revoked](parvane::GroupClient &g, const std::string &token) {
		return g.inviteList(token, gid, revoked);
	}, [=](std::optional<parvane::GroupInviteListResponse> r, const QString &transport) {
		auto links = std::vector<GroupInviteLink>();
		if (r && r->ok) {
			for (const auto &l : r->links) links.push_back(toInviteLink(l));
			auto log = QStringList();
			for (const auto &l : links) {
				log.push_back(l.token + ':' + l.state + ':' + QString::number(l.usage) + '/'
					+ QString::number(l.usageLimit) + ':' + (l.permanent ? u"primary"_q : u"-"_q));
			}
			LOG(("Parvane: ссылки %1 (%2): %3").arg(groupId, revoked ? u"отозванные"_q : u"активные"_q,
				log.isEmpty() ? u"-"_q : log.join(';')));
			done(true, std::move(links), QString());
			return;
		}
		const auto error = r ? errorOf(r->error_code, r->error, transport) : transport;
		LOG(("Parvane: ссылки %1 → отказ %2").arg(groupId, error));
		done(false, {}, error);
	});
}

void CreateGroupInvite(const QString &groupId, const QString &title, int expireDate,
		int usageLimit, bool requestApproval,
		Fn<void(bool ok, GroupInviteLink link, const QString &error)> done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		crl::async([=] {
			const auto s = V2Ready();
			const auto r = s
				? s->createInvite(groupId.toStdString(), title.toStdString(), expireDate,
					std::uint32_t(std::max(usageLimit, 0)), requestApproval)
				: nlohmann::json();
			const auto ok = r.is_object();
			LOG(("Parvane: INVITE create '%1' → %2 (v2)").arg(groupId, ok ? u"ok"_q : u"отказ"_q));
			crl::on_main([=] {
				done(ok, ok ? V2InviteLink(r) : GroupInviteLink(), ok ? QString() : u"failed"_q);
			});
		});
		return;
	}
	const auto gid = groupId.toStdString();
	auto params = parvane::InviteParams();
	params.title = title.toStdString();
	params.expires_at = expireDate;
	params.max_uses = usageLimit;
	params.request_needed = requestApproval;
	runGroupQuery([gid, params](parvane::GroupClient &g, const std::string &token) {
		return g.inviteCreate(token, gid, params);
	}, [=](std::optional<parvane::GroupInviteCreateResponse> r, const QString &transport) {
		if (r && r->ok && r->link) {
			const auto link = toInviteLink(*r->link);
			LOG(("Parvane: INVITE create '%1' → ok %2 state=%3").arg(groupId, link.token, link.state));
			done(true, link, QString());
			return;
		}
		const auto error = r ? errorOf(r->error_code, r->error, transport) : transport;
		LOG(("Parvane: INVITE create '%1' → отказ %2").arg(groupId, error));
		done(false, {}, error);
	});
}

void FetchPublicImage(const QString &fileId, Fn<void(QImage image, QByteArray bytes)> done) {
	const auto self = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto fid = fileId.toStdString();
	crl::async([=] {
		parvane::ITransport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		std::string bytes;
		if (t) {
			try {
				parvane::CloudClient cloud(*t);
				auto d = DownloadChatBlob(cloud, self, token, fid, 20000);
				if (d.ok) {
					bytes = std::move(d.bytes);
				}
			} catch (const std::exception &) {
			}
		}
		crl::on_main([=] {
			const auto qb = QByteArray(bytes.data(), int(bytes.size()));
			auto image = QImage();
			if (qb.isEmpty() || !image.loadFromData(qb)) {
				done(QImage(), QByteArray());
				return;
			}
			done(std::move(image), qb);
		});
	});
}

void ListGroupInvitesWithPrimary(const QString &groupId,
		Fn<void(bool ok, std::vector<GroupInviteLink> links, const QString &error)> done) {
	ListGroupInvites(groupId, false, [=](bool ok, std::vector<GroupInviteLink> links, const QString &error) {
		if (!ok) {
			done(false, {}, error);
			return;
		}
		const auto hasPrimary = ranges::any_of(links, [](const GroupInviteLink &l) {
			return l.permanent && l.state == u"active"_q;
		});
		if (hasPrimary) {
			done(true, std::move(links), QString());
			return;
		}
		CreateGroupInvite(groupId, QString(), 0, 0, false, [=](bool created, GroupInviteLink, const QString &createError) {
			if (!created) {
				LOG(("Parvane: основная ссылка %1 не создана: %2").arg(groupId, createError));
				done(true, links, QString());
				return;
			}
			LOG(("Parvane: основная ссылка %1 создана (в списке не было активной без параметров)").arg(groupId));
			ListGroupInvites(groupId, false, done);
		});
	});
}

void RevokeGroupInvite(const QString &groupId, const QString &token, GroupOpDone done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		// Отзыв ссылки v2 — запись журнала invite_key_revoke.
		crl::async([=] {
			const auto s = V2Ready();
			const auto ok = s && s->revokeInvite(groupId.toStdString(), token.toStdString());
			LOG(("Parvane: INVITE revoke %1 → %2 (v2)").arg(token, ok ? u"ok"_q : u"отказ"_q));
			crl::on_main([=] {
				if (done) {
					done(ok, ok ? QString() : u"failed"_q);
				}
			});
		});
		return;
	}
	const auto gid = groupId.toStdString();
	const auto t = token.toStdString();
	runGroupOp(u"INVITE revoke %1"_q.arg(token), [gid, t](parvane::GroupClient &g, const std::string &jwt) {
		return g.inviteRevoke(jwt, gid, t);
	}, std::move(done));
}

void DeleteGroupInvite(const QString &groupId, const QString &token, GroupOpDone done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		if (done) {
			done(true, QString()); // отозванная ссылка v2 уже не хранится
		}
		return;
	}
	const auto gid = groupId.toStdString();
	const auto t = token.toStdString();
	runGroupOp(u"INVITE delete %1"_q.arg(token), [gid, t](parvane::GroupClient &g, const std::string &jwt) {
		return g.inviteDelete(jwt, gid, t);
	}, std::move(done));
}

void CheckGroupInvite(const QString &token,
		Fn<void(bool ok, GroupInvitePreview preview, const QString &error)> done) {
	if (IsV2InviteLink(token)) {
		// Ссылка v2: group.invite.check по link_id (секрет серверу не уходит).
		crl::async([=] {
			const auto s = V2Ready();
			const auto r = s ? s->checkInvite(token.toStdString()) : nlohmann::json();
			auto p = GroupInvitePreview();
			auto error = QString();
			if (!r.is_object()) {
				error = u"failed"_q;
			} else if (r.contains("error")) {
				error = QString::fromStdString(r.value("error", std::string()));
			} else {
				p.groupId = QString::fromStdString(r.value("address", std::string()));
				p.name = QString::fromStdString(r.value("name", std::string()));
				p.about = QString::fromStdString(r.value("about", std::string()));
				p.avatar = QString::fromStdString(r.value("avatar", std::string()));
				p.kind = r.value("isChannel", false) ? u"channel"_q : u"group"_q;
				p.members = int(r.value("membersCount", std::int64_t(0)));
				p.requestNeeded = r.value("isRequestNeeded", false);
				p.alreadyMember = r.value("isMember", false);
			}
			LOG(("Parvane: INVITE check v2 → %1").arg(error.isEmpty() ? p.name : (u"отказ "_q + error)));
			crl::on_main([=] { done(error.isEmpty(), p, error); });
		});
		return;
	}
	const auto t = token.toStdString();
	runGroupQuery([t](parvane::GroupClient &g, const std::string &jwt) {
		return g.inviteCheck(jwt, t);
	}, [=](std::optional<parvane::GroupInviteCheckResponse> r, const QString &transport) {
		if (r && r->ok && !r->group_id.empty()) {
			auto p = GroupInvitePreview();
			p.groupId = QString::fromStdString(r->group_id);
			p.name = QString::fromStdString(r->name);
			p.kind = QString::fromStdString(r->kind);
			p.avatar = QString::fromStdString(r->avatar);
			p.about = QString::fromStdString(r->about);
			p.members = r->members_count;
			p.requestNeeded = r->request_needed;
			p.alreadyMember = r->already_member;
			p.pending = r->pending;
			LOG(("Parvane: INVITE check → %1 members=%2 request=%3 member=%4")
				.arg(p.name).arg(p.members).arg(p.requestNeeded ? 1 : 0).arg(p.alreadyMember ? 1 : 0));
			done(true, p, QString());
			return;
		}
		const auto error = r ? errorOf(r->error_code, r->error, transport) : transport;
		LOG(("Parvane: INVITE check → отказ %1").arg(error));
		done(false, {}, error);
	});
}

void JoinGroupByInvite(const QString &token,
		Fn<void(bool ok, const QString &groupId, bool pending, const QString &error)> done) {
	if (IsV2InviteLink(token)) {
		// Вступление v2: журнал по link_id + запись, подписанная ключом ссылки.
		crl::async([=] {
			const auto s = V2Ready();
			const auto r = s ? s->joinByInvite(token.toStdString()) : nlohmann::json();
			const auto status = r.is_object() ? r.value("status", std::string()) : std::string("error");
			const auto gid = QString::fromStdString(r.is_object() ? r.value("address", std::string()) : std::string());
			const auto code = QString::fromStdString(r.is_object() ? r.value("code", std::string("failed")) : std::string("failed"));
			LOG(("Parvane: INVITE join v2 → %1 %2").arg(QString::fromStdString(status), gid));
			crl::on_main([=] {
				if (status == "ok") {
					done(true, gid, false, QString());
				} else if (status == "requested") {
					done(true, QString(), true, QString());
				} else {
					done(false, QString(), false, code);
				}
			});
		});
		return;
	}
	const auto t = token.toStdString();
	runGroupQuery([t](parvane::GroupClient &g, const std::string &jwt) {
		return g.joinByInvite(jwt, t);
	}, [=](std::optional<parvane::GroupJoinResponse> r, const QString &transport) {
		if (r && r->ok) {
			const auto gid = QString::fromStdString(r->group_id);
			LOG(("Parvane: INVITE join → %1 %2").arg(r->pending ? u"pending"_q : u"ok"_q, gid));
			if (!r->pending) {
				RefreshGroups();
			}
			done(true, gid, r->pending, QString());
			return;
		}
		const auto error = r ? errorOf(r->error_code, r->error, transport) : transport;
		LOG(("Parvane: INVITE join → отказ %1").arg(error));
		done(false, QString(), false, error);
	});
}

void ListJoinRequests(const QString &groupId,
		Fn<void(bool ok, std::vector<GroupJoinRequest> requests, const QString &error)> done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		// Заявки v2 (T143): список отдаёт сервер владельцу и админам с правом
		// приглашать; по какой ссылке пришла заявка, он не сообщает
		crl::async([=] {
			auto ok = false;
			auto list = std::vector<GroupJoinRequest>();
			auto log = QStringList();
			if (const auto s = V2Ready()) {
				const auto requests = s->listJoinRequests(groupId.toStdString());
				if (requests.is_array()) {
					ok = true;
					for (const auto &q : requests) {
						list.push_back({
							QString::fromStdString(q.value("user", std::string())),
							QString(),
							int(q.value("date", std::int64_t(0))),
						});
						log.push_back(list.back().member + ':');
					}
				}
			}
			if (ok) {
				LOG(("Parvane: заявки %1: %2").arg(groupId, log.isEmpty() ? u"-"_q : log.join(';')));
			} else {
				LOG(("Parvane: заявки %1 → отказ v2").arg(groupId));
			}
			crl::on_main([=, list = std::move(list)]() mutable {
				done(ok, std::move(list), ok ? QString() : u"failed"_q);
			});
		});
		return;
	}
	const auto gid = groupId.toStdString();
	runGroupQuery([gid](parvane::GroupClient &g, const std::string &token) {
		return g.requestList(token, gid);
	}, [=](std::optional<parvane::GroupRequestListResponse> r, const QString &transport) {
		if (r && r->ok) {
			auto list = std::vector<GroupJoinRequest>();
			auto log = QStringList();
			for (const auto &q : r->requests) {
				list.push_back({ QString::fromStdString(q.member), QString::fromStdString(q.invite), int(q.created_at) });
				log.push_back(list.back().member + ':' + list.back().invite);
			}
			LOG(("Parvane: заявки %1: %2").arg(groupId, log.isEmpty() ? u"-"_q : log.join(';')));
			done(true, std::move(list), QString());
			return;
		}
		const auto error = r ? errorOf(r->error_code, r->error, transport) : transport;
		LOG(("Parvane: заявки %1 → отказ %2").arg(groupId, error));
		done(false, {}, error);
	});
}

void DecideJoinRequest(const QString &groupId, const QString &member, bool approve, GroupOpDone done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		// Заявка v2 (T143): одобрение — запись AddMember журнала и новая эпоха
		const auto tag = u"REQUEST %1 %2"_q.arg(approve ? u"approve"_q : u"decline"_q, member);
		crl::async([=] {
			const auto s = V2Ready();
			const auto ok = s && s->decideJoinRequest(groupId.toStdString(), member.toStdString(), approve);
			if (ok) {
				LOG(("Parvane: %1 → ok (v2)").arg(tag));
			} else {
				LOG(("Parvane: %1 → отказ v2 %2").arg(tag, s ? u"failed"_q : u"v2 не готов"_q));
			}
			crl::on_main([=] {
				if (done) {
					done(ok, ok ? QString() : u"failed"_q);
				}
			});
		});
		return;
	}
	const auto gid = groupId.toStdString();
	const auto mem = member.toStdString();
	runGroupOp(u"REQUEST %1 %2"_q.arg(approve ? u"approve"_q : u"decline"_q, member),
		[gid, mem, approve](parvane::GroupClient &g, const std::string &token) {
			return g.requestDecide(token, gid, mem, approve);
		}, std::move(done));
}

not_null<UserData*> EnsureUser(not_null<Main::Session*> session, const QString &address) {
	return ensurePeerUser(session, IdForAddress(address), address);
}

void OpenGroupChat(const QString &groupId) {
	const auto session = g_sessionWeak.get();
	if (!session || groupId.isEmpty()) {
		return;
	}
	const auto chat = ensureGroupChat(session, groupId, g_knownGroups.value(groupId), 0);
	const auto window = Core::App().activeWindow();
	const auto controller = window ? window->sessionController() : nullptr;
	if (chat && controller) {
		controller->showPeerHistory(chat, Window::SectionShow::Way::Forward);
	}
}

// Клик по ссылке группы: проверка + нативная модалка (Api::CheckChatInvite, где
// врезка для наших токенов), как t.me/+hash в Telegram.
bool JoinByInviteLink(const QString &url) {
	const auto token = GroupInviteToken(url);
	if (token.isEmpty()) {
		return false; // не наша ссылка
	}
	const auto window = Core::App().activeWindow();
	const auto controller = window ? window->sessionController() : nullptr;
	if (!controller) {
		LOG(("Parvane: ссылка группы %1 — нет активного окна").arg(token));
		return true;
	}
	Api::CheckChatInvite(controller, token);
	return true;
}
void LeaveGroup(const QString &groupId) {
	groupAdminAction(groupId, SelfAddress(), u"remove"_q); // сам себя = выйти
}

QString GroupIdForChat(not_null<PeerData*> peer) {
	if (!peer->isChat()) {
		return QString();
	}
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_chatIdToGroupId.value(std::uint64_t(peerToChat(peer->id).bare));
}

std::vector<not_null<ChatData*>> KnownGroupChats(not_null<Main::Session*> session) {
	auto groups = QHash<QString, QString>();
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		groups = g_knownGroups;
	}
	auto result = std::vector<not_null<ChatData*>>();
	for (auto it = groups.constBegin(); it != groups.constEnd(); ++it) {
		if (const auto chat = ensureGroupChat(session, it.key(), it.value(), 0)) {
			result.push_back(chat);
		}
	}
	return result;
}

// ── Папки (chat filters): персист локально + восстановление на старте ─────────
// tdesktop создаёт/применяет фильтры ЛОКАЛЬНО (local id + apply), но сохраняет их
// только в облако (MTProto заглушён) → при рестарте терялись. Сериализуем список
// фильтров в свой json и восстанавливаем при старте (histories по peer-id).
[[nodiscard]] QString FoldersPath() {
	return cWorkingDir() + u"tdata/parvane-folders.json"_q;
}

void SaveFolders(not_null<Main::Session*> session) {
	const auto &list = session->data().chatsFilters().list();
	auto arr = nlohmann::json::array();
	const auto peers = [](const auto &histories) {
		auto a = nlohmann::json::array();
		for (const auto &h : histories) {
			a.push_back(static_cast<std::uint64_t>(SerializePeerId(h->peer->id)));
		}
		return a;
	};
	for (const auto &f : list) {
		if (!f.id()) {
			continue;
		}
		nlohmann::json o;
		o["id"] = f.id();
		o["title"] = f.title().text.text.toStdString();
		o["static"] = f.title().isStatic;
		o["icon"] = f.iconEmoji().toStdString();
		o["color"] = f.colorIndex() ? int(*f.colorIndex()) : -1;
		o["flags"] = static_cast<std::uint32_t>(f.flags().value());
		o["always"] = peers(f.always());
		o["never"] = peers(f.never());
		o["pinned"] = peers(f.pinned());
		arr.push_back(std::move(o));
	}
	StoreWrite(FoldersPath(), QString::fromStdString(arr.dump()).toUtf8());
}

void LoadFolders(not_null<Main::Session*> session) {
	const auto raw = StoreRead(FoldersPath());
	if (raw.isEmpty()) {
		return;
	}
	nlohmann::json arr;
	try {
		arr = nlohmann::json::parse(raw.toStdString());
	} catch (const std::exception &) {
		return;
	}
	if (!arr.is_array()) {
		return;
	}
	const auto owner = &session->data();
	const auto histSet = [&](const nlohmann::json &o, const char *k) {
		base::flat_set<not_null<History*>> s;
		if (o.contains(k) && o[k].is_array()) {
			for (const auto &v : o[k]) {
				s.emplace(owner->history(
					DeserializePeerId(v.get<std::uint64_t>())));
			}
		}
		return s;
	};
	auto restored = 0;
	for (const auto &o : arr) {
		if (!o.is_object() || !o.value("id", 0)) {
			continue;
		}
		std::vector<not_null<History*>> pinned;
		if (o.contains("pinned") && o["pinned"].is_array()) {
			for (const auto &v : o["pinned"]) {
				pinned.push_back(owner->history(
					DeserializePeerId(v.get<std::uint64_t>())));
			}
		}
		const auto colorRaw = o.value("color", -1);
		auto title = Data::ChatFilterTitle{
			TextWithEntities{ QString::fromStdString(o.value("title", std::string())) },
			o.value("static", false) };
		auto filter = Data::ChatFilter(
			FilterId(o.value("id", 0)),
			std::move(title),
			QString::fromStdString(o.value("icon", std::string())),
			(colorRaw >= 0) ? std::optional<uint8>(uint8(colorRaw)) : std::nullopt,
			Data::ChatFilter::Flags::from_raw(
				static_cast<ushort>(o.value("flags", 0u))),
			histSet(o, "always"),
			std::move(pinned),
			histSet(o, "never"));
		session->data().chatsFilters().set(std::move(filter));
		++restored;
	}
	if (restored > 0) {
		LOG(("Parvane: папки восстановлены: %1").arg(restored));
	}
}

// ── стикеры: локальные паки → нативная панель ────────────────────────────────
// Каталог паков: PARVANE_STICKERS_DIR или ~/.local/share/ParvaneStickers.
// Каждая подпапка — пак: <Пак>/*.webp|png. Синтезируем установленный
// StickersSet (feedSetFull) с документами, привязанными к локальным файлам —
// нативная панель chat_helpers показывает и шлёт их без MTProto.
void LoadLocalStickerPacks(not_null<Main::Session*> session) {
	auto root = QString();
	if (const char *v = std::getenv("PARVANE_STICKERS_DIR"); v && *v) {
		root = QString::fromUtf8(v);
	} else {
		root = QDir::homePath() + u"/.local/share/ParvaneStickers"_q;
	}
	const auto rootDir = QDir(root);
	if (!rootDir.exists()) {
		return;
	}
	auto loaded = 0;
	auto &stickers = session->data().stickers();
	for (const auto &packName : rootDir.entryList(
			QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name)) {
		const auto packDir = QDir(rootDir.filePath(packName));
		const auto files = packDir.entryList(
			{ u"*.webp"_q, u"*.png"_q, u"*.tgs"_q, u"*.webm"_q },
			QDir::Files,
			QDir::Name);
		if (files.isEmpty()) {
			continue;
		}
		const auto setId = std::uint64_t(
			docIdFromFileId(u"pack:"_q + packName));
		auto docs = QVector<MTPDocument>();
		auto paths = QVector<QPair<qint64, QString>>();
		for (const auto &name : files) {
			const auto path = packDir.filePath(name);
			// Анимированные (tgs=lottie, webm) — размер не из QImage.
			const auto isTgs = name.endsWith(u".tgs"_q, Qt::CaseInsensitive);
			const auto isWebm = name.endsWith(u".webm"_q, Qt::CaseInsensitive);
			auto w = 512, h = 512;
			if (!isTgs && !isWebm) {
				const auto img = QImage(path);
				if (img.isNull()) {
					continue;
				}
				w = img.width();
				h = img.height();
			}
			const auto docId = docIdFromFileId(path);
			const auto size = QFileInfo(path).size();
			const auto mime = isTgs
				? u"application/x-tgsticker"_q
				: isWebm
				? u"video/webm"_q
				: name.endsWith(u".png"_q, Qt::CaseInsensitive)
				? u"image/png"_q
				: u"image/webp"_q;
			auto attrs = QVector<MTPDocumentAttribute>();
			attrs.push_back(MTP_documentAttributeImageSize(
				MTP_int(w), MTP_int(h)));
			// alt-эмодзи из hex-кода в имени (NN-1f602.png); нет — 🙂.
			auto alt = QString::fromUtf8("\xF0\x9F\x99\x82");
			const auto base = QFileInfo(name).completeBaseName();
			if (const auto dash = base.lastIndexOf(u'-'); dash >= 0) {
				auto ok = false;
				const auto code = base.mid(dash + 1).toUInt(&ok, 16);
				if (ok && code >= 0x80 && code <= 0x10FFFF) {
					const char32_t c = code;
					alt = QString::fromUcs4(&c, 1);
				}
			}
			attrs.push_back(MTP_documentAttributeSticker(
				MTP_flags(0),
				MTP_string(alt),
				MTP_inputStickerSetID(MTP_long(setId), MTP_long(0)),
				MTPMaskCoords()));
			docs.push_back(MTP_document(
				MTP_flags(0),
				MTP_long(docId),
				MTP_long(0),                     // access_hash
				MTP_bytes(),                     // file_reference
				MTP_int(int(base::unixtime::now())),
				MTP_string(mime),
				MTP_long(size),
				MTP_vector<MTPPhotoSize>(),
				MTPVector<MTPVideoSize>(),
				MTP_int(session->mainDcId()),
				MTP_vector<MTPDocumentAttribute>(attrs)));
			paths.push_back({ docId, path });
		}
		if (docs.isEmpty()) {
			continue;
		}
		using SFlag = MTPDstickerSet::Flag;
		const auto set = MTP_stickerSet(
			MTP_flags(SFlag::f_installed_date),
			MTP_int(int(base::unixtime::now())), // installed_date
			MTP_long(setId),
			MTP_long(0),                         // access_hash
			MTP_string(packName),
			MTP_string(packName),                // short_name
			MTPVector<MTPPhotoSize>(),           // thumbs (flags.4 — нет)
			MTPint(),                            // thumb_dc_id
			MTPint(),                            // thumb_version
			MTPlong(),                           // thumb_document_id (flags.8)
			MTP_int(docs.size()),
			MTP_int(0));                         // hash
		const auto full = MTP_messages_stickerSet(
			set,
			MTP_vector<MTPStickerPack>(),
			MTP_vector<MTPStickerKeyword>(),
			MTP_vector<MTPDocument>(docs));
		full.match([&](const MTPDmessages_stickerSet &data) {
			stickers.feedSetFull(data);
		}, [](const auto &) {});
		// Локальные файлы → документы «скачаны» (панель рендерит и шлёт).
		for (const auto &[docId, path] : paths) {
			const auto doc = session->data().document(DocumentId(docId));
			doc->setLocation(Core::FileLocation(path));
		}
		auto &order = stickers.setsOrderRef();
		if (!order.contains(setId)) {
			order.push_back(setId);
		}
		g_stickerPackDirs.insert(setId, PackDirInfo{
			packDir.absolutePath(), packName, int(docs.size()) });
		++loaded;
		LOG(("Parvane: стикер-пак «%1» загружен (%2 шт)")
			.arg(packName)
			.arg(docs.size()));
	}
	if (loaded > 0) {
		stickers.notifyUpdated(Data::StickersType::Stickers);
		// Диагностика: не стёр ли кто-то наши наборы позже (storage-чейн и т.п.).
		const auto weakS = base::make_weak(session.get());
		base::call_delayed(30 * crl::time(1000), [weakS] {
			const auto s = weakS.get();
			if (!s) {
				return;
			}
			auto total = 0, withStickers = 0;
			for (const auto &[id, set] : s->data().stickers().sets()) {
				++total;
				if (!set->stickers.isEmpty()) {
					++withStickers;
				}
			}
			LOG(("Parvane: стикеры t+30с: наборов=%1 с контентом=%2 (order=%3)")
				.arg(total)
				.arg(withStickers)
				.arg(s->data().stickers().setsOrder().size()));
		});
	}
}

// GIF-посев: локальная папка → Saved GIFs, чтобы вкладка GIFs не была пуста
// из коробки. PARVANE_GIFS_DIR или ~/.local/share/ParvaneGifs, файлы *.gif.
// Идемпотентно (docId стабилен от пути); дальше список живёт журналом.
void LoadLocalSavedGifs(not_null<Main::Session*> session) {
	auto root = QString();
	if (const char *v = std::getenv("PARVANE_GIFS_DIR"); v && *v) {
		root = QString::fromUtf8(v);
	} else {
		root = QDir::homePath() + u"/.local/share/ParvaneGifs"_q;
	}
	const auto dir = QDir(root);
	if (!dir.exists()) {
		return;
	}
	auto files = dir.entryList({ u"*.gif"_q }, QDir::Files, QDir::Name);
	// addSavedGif пушит в начало — идём с конца, чтобы порядок сохранился.
	std::reverse(files.begin(), files.end());
	auto loaded = 0;
	for (const auto &name : files) {
		const auto path = dir.filePath(name);
		const auto img = QImage(path);
		if (img.isNull()) {
			continue;
		}
		const auto docId = docIdFromFileId(path);
		const auto mtpDoc = buildLocalMtpDocument(
			session, docId, u"gif"_q, u"image/gif"_q,
			QFileInfo(path).size(), name,
			std::int64_t(base::unixtime::now()),
			/*durationSecs=*/2, img.width(), img.height(), path);
		const auto doc = session->data().processDocument(mtpDoc);
		doc->setLocation(Core::FileLocation(path));
		session->data().stickers().addSavedGif(nullptr, doc);
		++loaded;
	}
	if (loaded > 0) {
		LOG(("Parvane: гифок в Saved GIFs с диска: %1").arg(loaded));
	}
}

// Сброс всего, что привязано к КОНКРЕТНОЙ Data::Session (msgId-карты, хуки
// newItemAdded/папок, локальные паки, опросы): при новой Main::Session
// (релогин в этом же процессе; в headless — пересоздание сессии интро) старые
// msgId не существуют, а дедуп по uuid молча пропустил бы воспроизведение
// журнала — список чатов оставался бы пустым.
void ResetSessionBoundState() {
	g_uuidToMsgId.clear();
	g_msgIdToUuid.clear();
	g_pendingOwnUuids.clear();
	g_unreadIncoming.clear();
	g_mediaContentByMsgId.clear();
	g_stickerPackDirs.clear();
	g_packRefByDocId.clear();
	g_packInstallBusy.clear();
	g_emojiDocToSet.clear();
	g_emojiPackDirs.clear();
	g_emojiPackMaterialized.clear();
	g_pollsByUuid.clear();
	g_pollUuidById.clear();
	g_pendingPollVotes.clear();
	g_pendingPollClose.clear();
	g_lastOwnFullId = FullMsgId();
	g_finalizeLifetime.destroy();
	g_finalizeHooked = false;
	g_foldersLifetime.destroy();
	g_foldersSubscribed = false;
	{
		// «Живое эхо» своих отправок жило в прежней Data::Session — иначе свои
		// сообщения из журнала не воспроизведутся в новой (liveEcho → пропуск).
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_ownSentUuids.clear();
	}
	LOG(("Parvane: новая сессия — состояние прежней Data::Session сброшено"));
}

namespace {

// Шаг хука PARVANE_AUTOL2 (main): найти чат и переключить режим штатным путём.
void AutoL2Step(
		base::weak_ptr<Main::Session> weak,
		const QString &chatSpec,
		bool enabled,
		int attempt) {
	const auto session = weak.get();
	if (!session) {
		return;
	}
	const auto retry = [=] {
		if (attempt < 60) {
			base::call_delayed(2 * crl::time(1000), [=] {
				AutoL2Step(weak, chatSpec, enabled, attempt + 1);
			});
		} else {
			LOG(("Parvane: autol2 → %1: не удалось (%2)")
				.arg(chatSpec, enabled ? u"on"_q : u"off"_q));
		}
	};
	auto peer = (PeerData*)nullptr;
	if (chatSpec.startsWith(u"group="_q) || parvane::v2::isGroupAddress(chatSpec.toStdString())) {
		auto gid = chatSpec;
		if (chatSpec.startsWith(u"group="_q)) {
			gid = QString();
			const auto name = chatSpec.mid(6);
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			for (auto it = g_knownGroups.constBegin(); it != g_knownGroups.constEnd(); ++it) {
				if (it.value() == name && parvane::v2::isGroupAddress(it.key().toStdString())) {
					gid = it.key();
					break;
				}
			}
		}
		if (!gid.isEmpty()) {
			peer = session->data().chatLoaded(ChatId(BareId(IdForAddress(gid))));
		}
	} else {
		RegisterPeer(chatSpec);
		peer = session->data().user(UserId(BareId(IdForAddress(chatSpec))));
	}
	if (!peer) {
		retry();
		return;
	}
	SetChatL2(peer, enabled, [=](bool ok) {
		if (ok) {
			LOG(("Parvane: autol2 → %1: %2").arg(chatSpec, enabled ? u"on"_q : u"off"_q));
		} else {
			retry();
		}
	});
}

} // namespace

void AfterSessionReady(not_null<Main::Session*> session) {
	const auto weak = base::make_weak(session);
	// Откладываем на main, чтобы конструктор Main::Session завершился.
	crl::on_main(weak, [=] {
		// Признак «прежняя сессия разрушена» — через её lifetime, а не по
		// сравнению указателей: новая Main::Session часто получает тот же адрес.
		static bool previousEnded = false;
		if (previousEnded) {
			ResetSessionBoundState();
			previousEnded = false;
		}
		session->lifetime().add([] { previousEnded = true; });
		g_sessionWeak = weak;
		ShowUpgradeAvailableIfPending(); // E6: кадр notice пришёл до сессии
		// Рестарт: tdesktop возобновил кэшированную сессию, минуя экран логина
		// (SetSelf не звался) → self пуст. Восстанавливаем логин-состояние с
		// диска, иначе Parvane-слой поднимется без личности (отправка/приём/E2E
		// не работают).
		LoadReadJournal();  // READ-1: до воспроизведения журнала истории
		LoadNotifyState();  // снимок настроек уведомлений
		LoadBlockedState(); // блок-лист (применяется к пользователям по мере появления)
		LoadDialogState();  // архив и закреп (применяются после воспроизведения истории)
		if (SelfAddress().isEmpty()) {
			RestoreSessionCreds();
		}
		if (SelfAddress().isEmpty()) {
			// tdesktop восстановил сессию по userId из mtp-данных, а
			// учётных данных Parvane на диске нет (выход/отказ JWT не дошёл до
			// local().reset() — например, из-за падения). Продолжать нельзя:
			// self не загружен, окно пустое, выйти неоткуда. Уводим на экран
			// входа; ключи и история остаются.
			LOG(("Parvane: сессия без адреса — учётных данных нет, "
				"на экран входа"));
			session->account().forcedLogOut();
			return;
		}
		RegisterPeer(SelfAddress());
		// Свой профиль (имя + аватар) мог быть задан на другом устройстве (веб).
		// identity хранит их per-user — подтягиваем себя, иначе своя иконка,
		// поставленная в вебе, на десктопе не видна.
		ResolveNames({ SelfAddress() });
		if (!SessionActive()) {
			StartSession(); // на случай гонки с воркер-StartSession из логина
		}
		// Напоминание о резервной копии ключей: у ЕДИНСТВЕННОГО устройства
		// перенести ключи некуда (линковке нужно второе живое), потеря профиля
		// необратима. Раз на установку (маркер), не в headless-прогонах.
		if (!KeyBackupDone() && !ParvaneDevEnv("PARVANE_AUTOLOGIN")) {
			base::call_delayed(8000, [] {
				ListDevices([](std::vector<DeviceEntry> devices) {
					if (devices.size() > 1) {
						return;
					}
					crl::on_main([] {
						static auto shown = false;
						if (shown || !g_sessionWeak.get()) {
							return;
						}
						shown = true;
						Ui::show(Ui::MakeInformBox(u"Это единственное устройство аккаунта. "
							"История зашифрована его ключами: без резервной копии "
							"переустановка или сбой диска уничтожат переписку навсегда.\n\n"
							"Сделайте копию: Настройки → Конфиденциальность → "
							"«Сохранить копию ключей»."_q));
					});
				});
			});
		}

		// Подписка на «печатает…» (эфемерно): msg.typing.<мой id>. Хендлер
		// приходит с NATS-потока → маршалим на main и показываем действие пира.
		if (!g_typingSubscribed) {
			g_typingSubscribed = true;
			const auto selfId = IdForAddress(SelfAddress());
			parvane::ITransport *t = nullptr;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				t = g_transport.get();
			}
			if (t) {
				t->subscribe(parvane::topics::msgTyping(std::to_string(selfId)),
					[](std::string, std::string payload) { handleTypingFrame(payload); });
				LOG(("Parvane: подписка на msg.typing.%1").arg(selfId));
			}
		}

		// Присутствие (real online): подписки на presence.<id> известных
		// собеседников (P-18: не presence.* всех) + хартбит своего присутствия
		// каждые 30с. На приёме ставим пиру OnlineTill(now+90).
		if (!g_presenceSubscribed) {
			QList<QString> known;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_presenceSubscribed = true;
				known = g_idToAddress.values();
			}
			for (const auto &address : known) {
				EnsurePresenceSubscription(address);
			}
			LOG(("Parvane: presence — подписки на %1 собеседников").arg(known.size()));
			g_presenceTimer = std::make_unique<base::Timer>(
				[] { publishPresenceHeartbeat(); });
			g_presenceTimer->callEach(30000);
			publishPresenceHeartbeat();
		}

		// Без живого MTProto dialogs.getDialogs не завершается → список диалогов
		// вечно «Loading…» на пустом аккаунте. Помечаем список загруженным. Сам
		// плейсхолдер пустого списка гейтится по contactsLoaded() (dialogs_inner_
		// widget.cpp) — ставим и его, тогда вместо «Loading…» обычный пустой вид.
		session->data().chatsList()->setLoaded();
		session->data().contactsLoaded() = true;

		// Исходящие эхо помечаем «отправленными» (Фаза 4, фикс вечной крутилки):
		// без MTProto локальное сообщение висит в BeingSent (часики; для медиа мы
		// ещё и не стартуем uploader). Как только сообщение добавлено — присваиваем
		// серверный id: setRealId снимает BeingSent|Local → «отправлено».
		if (!g_finalizeHooked) {
			g_finalizeHooked = true;
			session->data().newItemAdded(
			) | rpl::on_next([](not_null<HistoryItem*> item) {
				// В чате с самим собой («Избранное») tdesktop не помечает
				// локальное сообщение как исходящее, поэтому эхо не получало
				// серверный id и висело с «часиками» вечно. Для self-чата
				// условие out() снимаем: там все сообщения по определению наши.
				const auto selfChat = item->history()->peer->isSelf();
				if ((!item->out() && !selfChat)
					|| !item->isSending()
					|| !IsClientMsgId(item->id)) {
					return;
				}
				// Своё ТЕКСТ-эхо: связываем с заранее сгенерённым uuid из очереди
				// (msgId↔uuid) для delete/edit/read СВОИХ сообщений. Медиа —
				// не берём (у него нет пред-id в очереди).
				auto uuid = QString();
				if (!item->media() && !g_pendingOwnUuids.isEmpty()) {
					uuid = g_pendingOwnUuids.dequeue();
				}
				const auto fullId = item->fullId();
				crl::on_main([fullId, uuid] {
					const auto session = g_sessionWeak.get();
					if (!session) {
						return;
					}
					const auto it = session->data().message(fullId);
					if (!it) {
						return;
					}
					if (it->isSending() && IsClientMsgId(it->id)) {
						const auto newId = MsgId(g_nextMsgId++);
						it->setRealId(newId);
						if (!uuid.isEmpty()) {
							g_uuidToMsgId.insert(uuid, newId.bare);
							g_msgIdToUuid.insert(newId.bare, uuid);
							g_lastOwnFullId = it->fullId(); // debug AUTODELETE/EDIT
							g_lastOwnUuid = uuid;
							if (g_firstOwnUuid.isEmpty()) {
								g_firstOwnUuid = uuid;
							}
						}
					}
					// СВОЁ медиа — в общие медиа (профиль отправителя иначе показывает
					// только входящие; приём — в injectMediaOnMain). Дедуп по msgId.
					if (it->media()) {
						indexSharedMediaWithCount(session, it);
					}
					// Показать диалог отправителя в списке: без живого MTProto
					// список диалогов вечно «Loading…», а исходящее сообщение не
					// регистрирует диалог. Помечаем папку известной — как для
					// входящих (injectOnMain), тогда диалог появляется.
					const auto history = it->history();
					if (!history->folderKnown()) {
						history->clearFolder();
					}
				});
			}, g_finalizeLifetime);
		}
		// TTL-таймеры чатов (самоуничтожение) — восстановить с диска.
		LoadTtlStore();
		// Папки (chat filters): восстановить с диска, затем персистить при изменениях
		// (создание/редактирование фильтров облачно у tdesktop, MTProto заглушён).
		LoadFolders(session);
		if (!g_foldersSubscribed) {
			g_foldersSubscribed = true;
			session->data().chatsFilters().changed(
			) | rpl::on_next([weak] {
				if (const auto s = weak.get()) {
					SaveFolders(s);
					ScheduleStateFlush("folders"); // журнал личного состояния v2 (T098)
				}
			}, g_foldersLifetime);
		}
		// Стикеры: локальные паки → нативная панель (chat_helpers). ОТЛОЖЕНО:
		// init-чейн Main::Session (readInstalledStickers и далее) выполняется
		// цепочкой on_main ПОСЛЕ этого хука; feedSetFull провоцирует
		// writeInstalledStickers, чейн читает файл обратно с setsRef().clear()
		// и спотыкается на нашей синтетике — наборы стирались. Грузим после.
		base::call_delayed(3 * crl::time(1000), [weak] {
			if (const auto s = weak.get()) {
				LoadLocalStickerPacks(s);
				LoadLocalSavedGifs(s);
				LoadLocalCustomEmoji(s); // кастом-эмодзи: локальные паки → панель
			}
		});
		// Воспроизводим локальную историю (свои + принятые) ДО первого sync —
		// восстанавливает переписку после рестарта/релогина; новые сообщения sync
		// добавит поверх (дедуп по uuid).
		LoadV2GroupCache(session); // группы v2 — до истории (её сообщения идут в их чаты)
		ReplayHistory();
		// Архив и закреп — после истории (её инъекция стоит в очереди main раньше).
		crl::on_main([weak] {
			if (const auto s = weak.get()) {
				ApplyDialogState(s);
			}
		});
		RestoreScheduled(); // запланированные сообщения: восстановить очередь+таймеры
		// Первичный приём: подтягиваем то, что уже лежит в шарде (офлайн-бэклог).
		PumpReceive();

		// Периодический sync (Фаза 3d): ловит сообщения, чей delivered-бродкаст
		// был пропущен (NATS fire-and-forget) или пришёл, пока клиент был офлайн.
		if (!g_pumpTimer) {
			g_pumpTimer = std::make_unique<base::Timer>([] {
				PumpReceive();
				// Реже (раз в ~10с) обновляем список групп — ловит группы, в
				// которые нас добавили, и новые каналы.
				static int tick = 0;
				if ((++tick % 3) == 0) {
					RefreshGroups();
				}
				// Свой профиль (имя/аватар) мог измениться на другом устройстве:
				// перечитываем по тому же TTL, что и профили собеседников.
				// main-поток — g_resolvedAt трогается только отсюда и из
				// ensurePeerUser, оба на main.
				const auto self = SelfAddress();
				const auto now = crl::now();
				if (!self.isEmpty()
					&& now - g_resolvedAt.value(self, 0) > kProfileTtlMs) {
					g_resolvedAt.insert(self, now);
					ResolveNames({ self });
				}
			});
			g_pumpTimer->callEach(kPumpIntervalMs);
			LOG(("Parvane: периодический sync каждые %1 мс").arg(kPumpIntervalMs));
		}

		// Debug-autosendfile для e2e Фазы 4: PARVANE_AUTOSENDFILE=peer@server:/path.
		// Отправляет файл штатным путём tdesktop (FileLoadTask → SendConfirmedFile
		// → MirrorOutgoingFile). Тип по расширению: png/jpg → Photo, иначе File.
		if (const char *fv = ParvaneDevEnv("PARVANE_AUTOSENDFILE"); fv && *fv) {
			const auto spec = QString::fromUtf8(fv);
			const auto sep = spec.indexOf(':');
			if (sep > 0) {
				const auto peerAddr = spec.left(sep);
				const auto path = spec.mid(sep + 1);
				auto f = QFile(path);
				if (f.open(QIODevice::ReadOnly)) {
					const auto bytes = f.readAll();
					// Цель: группа (chat), если известна, иначе 1-на-1 (user).
					History *fileHistory = nullptr;
					if (g_knownGroups.contains(peerAddr)) {
						ensureGroupChat(session, peerAddr,
							g_knownGroups.value(peerAddr), 0);
						const auto chat = session->data().chat(
							ChatId(BareId(IdForAddress(peerAddr))));
						fileHistory = session->data().history(chat);
					} else {
						RegisterPeer(peerAddr);
						const auto fileUser = session->data().user(
							UserId(BareId(IdForAddress(peerAddr))));
						fileHistory = session->data().history(fileUser);
					}
					const auto lower = path.toLower();
					const auto type = (lower.endsWith(u".png"_q)
							|| lower.endsWith(u".jpg"_q)
							|| lower.endsWith(u".jpeg"_q))
						? SendMediaType::Photo
						: SendMediaType::File;
					session->api().sendFile(
						bytes, type, Api::SendAction(fileHistory));
					LOG(("Parvane: autosendfile → %1: %2 (%3 байт)")
						.arg(peerAddr).arg(path).arg(bytes.size()));
				} else {
					LOG(("Parvane: autosendfile — не открыть %1").arg(path));
				}
			}
		}

		// Debug-autotwofa: PARVANE_AUTOTWOFA=on|off — переключает двухфакторный
		// вход (identity.user.twofa) как тумблер в настройках; результат — в лог.
		if (const char *tv = ParvaneDevEnv("PARVANE_AUTOTWOFA"); tv && *tv) {
			const auto enable = (QString::fromUtf8(tv) == u"on"_q);
			// P-07: выключение 2FA сервер принимает только с текущим паролем —
			// берём его из PARVANE_AUTOLOGIN (user:pass), как AUTOREVOKE_OTHERS.
			const auto login = QString::fromUtf8(ParvaneDevEnv("PARVANE_AUTOLOGIN")
				? ParvaneDevEnv("PARVANE_AUTOLOGIN") : "");
			const auto password = login.contains(':')
				? login.mid(login.indexOf(':') + 1)
				: QString();
			base::call_delayed(2 * crl::time(1000), [enable, password] {
				crl::async([enable, password] {
					const auto st = SetTwoFactor(enable, password);
					LOG(("Parvane: autotwofa → enabled=%1 ok=%2 linked=%3 err=%4")
						.arg(st.enabled ? 1 : 0).arg(st.ok ? 1 : 0)
						.arg(st.telegramLinked ? 1 : 0).arg(st.error));
				});
			});
		}

		// Debug-autoclearchat: PARVANE_AUTOCLEARCHAT=peer@server:<секунды> —
		// удаляет диалог штатным путём (deleteConversation → deleteHistory →
		// MirrorClearHistory → msg.chat.clear).
		if (const char *cv = ParvaneDevEnv("PARVANE_AUTOCLEARCHAT"); cv && *cv) {
			const auto spec = QString::fromUtf8(cv);
			const auto sep = spec.lastIndexOf(':');
			if (sep > 0) {
				const auto peerAddr = spec.left(sep);
				const auto secs = std::max(spec.mid(sep + 1).toInt(), 1);
				base::call_delayed(secs * crl::time(1000), [peerAddr] {
					const auto session = g_sessionWeak.get();
					if (!session) {
						return;
					}
					RegisterPeer(peerAddr);
					const auto user = session->data().user(
						UserId(BareId(IdForAddress(peerAddr))));
					LOG(("Parvane: autoclearchat → %1").arg(peerAddr));
					session->api().deleteConversation(user, false);
				});
			}
		}

		// Debug-automute для e2e: PARVANE_AUTOMUTE=цель[,цель]:<секунды>; цель —
		// адрес собеседника или group:<имя группы>. Мут навсегда штатным
		// NotifySettings::update → MirrorNotifySettings → другие устройства.
		if (const char *mv = ParvaneDevEnv("PARVANE_AUTOMUTE"); mv && *mv) {
			const auto spec = QString::fromUtf8(mv);
			const auto sep = spec.lastIndexOf(':');
			if (sep > 0) {
				const auto targets = spec.left(sep).split(',', Qt::SkipEmptyParts);
				const auto secs = std::max(spec.mid(sep + 1).toInt(), 1);
				base::call_delayed(secs * crl::time(1000), [targets] {
					const auto session = g_sessionWeak.get();
					if (!session) {
						return;
					}
					for (const auto &target : targets) {
						PeerData *peer = nullptr;
						if (target.startsWith(u"group:"_q)) {
							const auto gname = target.mid(6);
							const auto gid = GroupIdByName(gname);
							if (!gid.isEmpty()) {
								peer = ensureGroupChat(session, gid, gname, 0);
							}
						} else {
							RegisterPeer(target);
							peer = session->data().user(
								UserId(BareId(IdForAddress(target))));
						}
						if (!peer) {
							LOG(("Parvane: automute: не нашёл %1").arg(target));
							continue;
						}
						session->data().notifySettings().update(
							peer,
							Data::MuteValue{ .forever = true });
						LOG(("Parvane: automute → %1").arg(target));
					}
				});
			}
		}

		// Debug-autoprofile для e2e: PARVANE_AUTOPROFILE=bio=..;phone=..;color=N;
		// channel=<имя группы>:<секунды> — свои профильные поля в identity
		// (channel пустой = убрать личный канал).
		if (const char *pv = ParvaneDevEnv("PARVANE_AUTOPROFILE"); pv && *pv) {
			const auto spec = QString::fromUtf8(pv);
			const auto sep = spec.lastIndexOf(':');
			if (sep > 0) {
				const auto pairs = spec.left(sep).split(';', Qt::SkipEmptyParts);
				const auto secs = std::max(spec.mid(sep + 1).toInt(), 1);
				base::call_delayed(secs * crl::time(1000), [pairs] {
					const auto session = g_sessionWeak.get();
					if (!session) {
						return;
					}
					const auto self = session->user();
					auto fields = ProfileFields();
					for (const auto &pair : pairs) {
						const auto eq = pair.indexOf('=');
						if (eq <= 0) {
							continue;
						}
						const auto key = pair.left(eq);
						const auto value = pair.mid(eq + 1);
						if (key == u"bio"_q) {
							fields.bio = value;
							self->setAbout(value);
						} else if (key == u"phone"_q) {
							fields.phone = value;
							self->setPhone(value);
						} else if (key == u"color"_q) {
							fields.nameColor = value.toInt();
							if (*fields.nameColor >= 0) {
								self->changeColorIndex(uint8(*fields.nameColor));
							} else {
								self->clearColorIndex();
							}
						} else if (key == u"channel"_q) {
							const auto gid = GroupIdByName(value);
							fields.personalChannel = gid;
							ApplyPersonalChannel(self, gid);
						}
					}
					SetProfileFields(fields);
					LOG(("Parvane: autoprofile применён (%1)").arg(pairs.join(';')));
				});
			}
		}

		// Debug-autosearch: PARVANE_AUTOSEARCH=<подстрока>:<секунды> — глобальный
		// локальный поиск по сообщениям, результат в лог (для e2e).
		if (const char *sv = ParvaneDevEnv("PARVANE_AUTOSEARCH"); sv && *sv) {
			const auto spec = QString::fromUtf8(sv);
			const auto sep = spec.lastIndexOf(':');
			if (sep > 0) {
				const auto needle = spec.left(sep);
				const auto secs = std::max(spec.mid(sep + 1).toInt(), 1);
				base::call_delayed(secs * crl::time(1000), [needle] {
					const auto session = g_sessionWeak.get();
					if (!session) {
						return;
					}
					const auto found = SearchMessagesLocal(session, needle);
					for (const auto &item : found) {
						LOG(("Parvane: autosearch «%1» → %2 в %3: %4")
							.arg(needle).arg(item->id.bare)
							.arg(item->history()->peer->name())
							.arg(item->originalText().text.left(60)));
					}
				});
			}
		}

		// Debug-autoforward: PARVANE_AUTOFORWARD=from@server:to@server:<секунды> —
		// пересылает последнее МЕДИА диалога from получателю to. В headless
		// history->blocks часто пуст, поэтому берём сохранённый media-content
		// напрямую из g_mediaContentByMsgId (тот же content, что несёт
		// MirrorForward) и гоним через ForwardMediaReshared — путь перезаливки
		// блоба под нового получателя (то, что проверяем).
		if (const char *fw = ParvaneDevEnv("PARVANE_AUTOFORWARD"); fw && *fw) {
			const auto parts = QString::fromUtf8(fw).split(':');
			if (parts.size() == 3) {
				const auto fromAddr = parts[0];
				const auto toAddr = parts[1];
				const auto secs = std::max(parts[2].toInt(), 1);
				base::call_delayed(secs * crl::time(1000), [fromAddr, toAddr] {
					const auto session = g_sessionWeak.get();
					if (!session) {
						return;
					}
					RegisterPeer(fromAddr);
					RegisterPeer(toAddr);
					const auto fromUser = session->data().user(
						UserId(BareId(IdForAddress(fromAddr))));
					// Последнее медиа из диалога fromAddr: наибольший msgId с
					// media-контентом, чей пир (если item жив) — fromUser
					qint64 bestId = 0;
					QString bestContent;
					for (auto it = g_mediaContentByMsgId.constBegin();
							it != g_mediaContentByMsgId.constEnd(); ++it) {
						if (it.key() <= bestId) {
							continue;
						}
						const auto item = session->data().nonChannelMessage(MsgId(it.key()));
						if (item && item->history()->peer != fromUser) {
							continue; // media из другого диалога
						}
						bestId = it.key();
						bestContent = it.value();
					}
					if (bestContent.isEmpty()) {
						LOG(("Parvane: autoforward — в диалоге %1 нет медиа").arg(fromAddr));
						return;
					}
					LOG(("Parvane: autoforward %1 → %2 (msgId %3)")
						.arg(fromAddr, toAddr).arg(bestId));
					ForwardMediaReshared(toAddr, bestContent);
				});
			}
		}

		// Своё исходящее для debug-хуков: ПЕРВОЕ за процесс (headless пересоздаёт
		// сессию и autosend шлёт заново — «последнее» было бы только что
		// отправленным и ещё не прочитанным); после сброса сессии msgId
		// переназначен — ищем по uuid через текущую карту.
		const auto lastOwnItem = [](not_null<Main::Session*> session) -> HistoryItem* {
			for (const auto &uuid : { g_firstOwnUuid, g_lastOwnUuid }) {
				if (const auto msgId = g_uuidToMsgId.value(uuid, 0)) {
					if (const auto item = session->data().nonChannelMessage(MsgId(msgId))) {
						return item;
					}
				}
			}
			// Эхо первого своего могло пройти до подписки newItemAdded — берём
			// самое раннее своё текстовое из карты текущей сессии (журнал
			// воспроизводится в порядке отправки → минимальный msgId).
			HistoryItem *oldest = nullptr;
			for (auto i = g_msgIdToUuid.cbegin(); i != g_msgIdToUuid.cend(); ++i) {
				const auto item = session->data().nonChannelMessage(MsgId(i.key()));
				if (item && item->out() && !item->media()
					&& (!oldest || item->id < oldest->id)) {
					oldest = item;
				}
			}
			if (oldest) {
				return oldest;
			}
			return g_lastOwnFullId ? session->data().message(g_lastOwnFullId) : nullptr;
		};
		// Debug-autodelete для e2e delete: PARVANE_AUTODELETE=<секунды> — удаляет
		// своё последнее исходящее штатным путём (deleteMessages → MirrorDelete).
		if (const char *dv = ParvaneDevEnv("PARVANE_AUTODELETE"); dv && *dv) {
			const auto secs = std::max(QString::fromUtf8(dv).toInt(), 1);
			base::call_delayed(secs * crl::time(1000), [lastOwnItem] {
				const auto session = g_sessionWeak.get();
				if (!session) {
					return;
				}
				const auto item = lastOwnItem(session);
				if (!item) {
					LOG(("Parvane: autodelete — сообщение не найдено"));
					return;
				}
				session->data().histories().deleteMessages(
					item->history(),
					QVector<MTPint>{ MTP_int(int(item->id.bare)) },
					true);
				LOG(("Parvane: autodelete → msgId %1").arg(item->id.bare));
			});
		}

		// Debug-autoreaders для e2e «seen by / read at»: PARVANE_AUTOREADERS=<секунды>
		// — запрашивает msg.chat.readers для своего последнего исходящего и пишет
		// результат в лог (см. FetchReaders).
		if (const char *rv = ParvaneDevEnv("PARVANE_AUTOREADERS"); rv && *rv) {
			const auto secs = std::max(QString::fromUtf8(rv).toInt(), 1);
			base::call_delayed(secs * crl::time(1000), [lastOwnItem] {
				const auto session = g_sessionWeak.get();
				const auto item = session ? lastOwnItem(session) : nullptr;
				if (!item) {
					LOG(("Parvane: autoreaders — нет своего исходящего"));
					return;
				}
				FetchReaders(item->id.bare, [](std::vector<ReaderEntry>) {});
			});
		}

		// Debug-autoedit для e2e edit: PARVANE_AUTOEDIT=<секунды>:новый текст.
		if (const char *ev = ParvaneDevEnv("PARVANE_AUTOEDIT"); ev && *ev) {
			const auto spec = QString::fromUtf8(ev);
			const auto sep = spec.indexOf(':');
			if (sep > 0) {
				const auto secs = std::max(spec.left(sep).toInt(), 1);
				const auto newText = spec.mid(sep + 1);
				base::call_delayed(secs * crl::time(1000), [newText, lastOwnItem] {
					const auto session = g_sessionWeak.get();
					if (!session) {
						return;
					}
					const auto item = lastOwnItem(session);
					if (!item) {
						return;
					}
					MirrorEdit(item, TextWithEntities{ newText });
					item->setText({ newText });
					session->data().requestItemViewRefresh(item);
					LOG(("Parvane: autoedit → %1").arg(newText));
				});
			}
		}

		// Debug для e2e devices: PARVANE_AUTOREVOKE_OTHERS=<секунды> — перечислить
		// устройства и отозвать все, кроме текущего (как «Terminate all»).
		if (const char *rv = ParvaneDevEnv("PARVANE_AUTOREVOKE_OTHERS"); rv && *rv) {
			const auto secs = std::max(QString::fromUtf8(rv).toInt(), 1);
			base::call_delayed(secs * crl::time(1000), [] {
				ListDevices([](std::vector<DeviceEntry> devices) {
					for (const auto &d : devices) {
						LOG(("Parvane: устройство %1%2 (otk=%3)")
							.arg(d.deviceId.isEmpty() ? u"<legacy>"_q : d.deviceId)
							.arg(d.current ? u" [текущее]"_q : QString())
							.arg(d.oneTimeAvailable));
						if (!d.current) {
							// P-07: отзыв требует текущий пароль — хук берёт его из
							// PARVANE_AUTOLOGIN (user:pass); без него сервер отказывал,
							// и android tgx_conformance_flow.sh (FAIL-1) краснел.
							const auto login = QString::fromUtf8(ParvaneDevEnv("PARVANE_AUTOLOGIN")
								? ParvaneDevEnv("PARVANE_AUTOLOGIN") : "");
							const auto colon = login.indexOf(':');
							const auto password = (colon > 0) ? login.mid(colon + 1) : QString();
							RevokeDevice(d.deviceId, [id = d.deviceId](bool ok) {
								LOG(("Parvane: autorevoke %1 → %2")
									.arg(id, ok ? u"ok"_q : u"fail"_q));
							}, password);
						}
					}
				});
			});
		}

		// Группы: подтягиваем список пользователя (после StartSession).
		base::call_delayed(2 * crl::time(1000), [] { RefreshGroups(); });

		// Debug-autogroup для e2e: PARVANE_AUTOGROUP=Имя:member1,member2 (пусто —
		// без начальных участников). Создаёт группу через ~4с.
		if (const char *gv = ParvaneDevEnv("PARVANE_AUTOGROUP"); gv && *gv) {
			auto spec = QString::fromUtf8(gv);
			const auto sep = spec.indexOf(':');
			const auto gname = (sep > 0) ? spec.left(sep) : spec;
			const auto membersStr = (sep >= 0) ? spec.mid(sep + 1) : QString();
			const auto members = membersStr.isEmpty()
				? QStringList()
				: membersStr.split(',', Qt::SkipEmptyParts);
			base::call_delayed(4 * crl::time(1000), [gname, members] {
				LOG(("Parvane: AUTOGROUP создаю '%1'").arg(gname));
				CreateGroup(gname, members, false);
			});
		}

		// Debug-autogroupcall для e2e: PARVANE_AUTOGROUPCALL=Имя_группы →
		// групповой звонок со всеми участниками (через ~9с — дать группе
		// синхронизироваться).
		if (const char *gcv = ParvaneDevEnv("PARVANE_AUTOGROUPCALL"); gcv && *gcv) {
			const auto gname = QString::fromUtf8(gcv);
			base::call_delayed(9 * crl::time(1000), [gname] {
				QString gid;
				{
					std::lock_guard<std::mutex> lk(g_sessionMutex);
					for (auto it = g_knownGroups.constBegin();
							it != g_knownGroups.constEnd(); ++it) {
						if (it.value() == gname) {
							gid = it.key();
							break;
						}
					}
				}
				if (!gid.isEmpty()) {
					LOG(("Parvane: AUTOGROUPCALL в '%1' (%2)").arg(gname, gid));
					StartGroupCall(gid, false);
				} else {
					LOG(("Parvane: AUTOGROUPCALL — группа '%1' не найдена").arg(gname));
				}
			});
		}

		// Debug-autottl для e2e самоуничтожения: PARVANE_AUTOTTL=peer@server:секунды
		// → выставить TTL чата (как нативное меню Auto-Delete). Исходящие получат
		// ttl_secs → у получателя нативный ttl_period (авто-удаление).
		if (const char *tv = ParvaneDevEnv("PARVANE_AUTOTTL"); tv && *tv) {
			auto spec = QString::fromUtf8(tv);
			const auto sp = spec.lastIndexOf(':');
			if (sp > 0) {
				const auto addr = spec.left(sp);
				const auto secs = spec.mid(sp + 1).toInt();
				SetPeerTtlLocal(addr, secs);
				LOG(("Parvane: AUTOTTL — TTL чата %1 = %2с").arg(addr).arg(secs));
			}
		}

		// Копия ключей (T152): PARVANE_AUTOKEYBACKUP=export|import:<пароль>:<путь>
		// через ~10 с. Маркер: «AUTOKEYBACKUP <действие> → ok» / «→ отказ <причина>».
		if (const char *kb = ParvaneDevEnv("PARVANE_AUTOKEYBACKUP"); kb && *kb) {
			const auto parts = QString::fromUtf8(kb).split(':');
			if (parts.size() >= 3) {
				const auto action = parts[0];
				const auto password = parts[1];
				const auto path = parts.mid(2).join(':');
				base::call_delayed(10 * crl::time(1000), [action, password, path] {
					crl::async([action, password, path] {
						auto error = QString();
						const auto ok = (action == u"import"_q)
							? ImportKeyBackup(path, password, &error)
							: ExportKeyBackup(path, password, &error);
						LOG(("Parvane: AUTOKEYBACKUP %1 → %2").arg(action, ok ? u"ok"_q : u"отказ "_q + error));
					});
				});
			}
		}

		// Debug-autofolder для папок: PARVANE_AUTOFOLDER=Имя:peer@server → создаёт
		// папку с этим чатом (нативный ChatFilters::set) через ~6с. Персист свой.
		if (const char *fv = ParvaneDevEnv("PARVANE_AUTOFOLDER"); fv && *fv) {
			auto spec = QString::fromUtf8(fv);
			const auto c = spec.indexOf(':');
			if (c > 0) {
				const auto fname = spec.left(c);
				const auto peerAddr = spec.mid(c + 1);
				base::call_delayed(6 * crl::time(1000), [fname, peerAddr] {
					const auto s = g_sessionWeak.get();
					if (!s) {
						return;
					}
					RegisterPeer(peerAddr);
					const auto hist = s->data().history(
						peerFromUser(UserId(BareId(IdForAddress(peerAddr)))));
					auto newId = 2; // как нативный редактор (0/1 зарезервированы)
					for (const auto &f : s->data().chatsFilters().list()) {
						if (f.id() >= newId) {
							newId = f.id() + 1;
						}
					}
					base::flat_set<not_null<History*>> always;
					always.emplace(hist);
					s->data().chatsFilters().set(Data::ChatFilter(
						FilterId(newId),
						Data::ChatFilterTitle{ TextWithEntities{ fname }, false },
						QString(), std::nullopt, Data::ChatFilter::Flags(),
						std::move(always), {}, {}));
					LOG(("Parvane: AUTOFOLDER создал папку '%1' (id=%2) → %3")
						.arg(fname, QString::number(newId), peerAddr));
				});
			}
		}

		// Debug-autoadmin для админки групп: PARVANE_AUTOADMIN=Имя_группы;act:member;…
		// act ∈ add|remove|admin|member. Через ~11с (группа синхронизирована)
		// выполняет действия ЧЕРЕЗ клиент (GroupClient → messenger), стаггер по 3с.
		if (const char *av = ParvaneDevEnv("PARVANE_AUTOADMIN"); av && *av) {
			const auto parts = QString::fromUtf8(av).split(';', Qt::SkipEmptyParts);
			if (parts.size() >= 2) {
				const auto gname = parts.first();
				for (auto i = 1; i < parts.size(); ++i) {
					const auto pair = parts[i];
					const auto c = pair.indexOf(':');
					if (c <= 0) {
						continue;
					}
					const auto act = pair.left(c);
					const auto mem = pair.mid(c + 1);
					const auto delayMs = (11 + (i - 1) * 3) * crl::time(1000);
					base::call_delayed(delayMs, [gname, act, mem] {
						QString gid;
						{
							std::lock_guard<std::mutex> lk(g_sessionMutex);
							for (auto it = g_knownGroups.constBegin();
									it != g_knownGroups.constEnd(); ++it) {
								if (it.value() == gname) {
									gid = it.key();
									break;
								}
							}
						}
						if (gid.isEmpty()) {
							LOG(("Parvane: AUTOADMIN — группа '%1' не найдена").arg(gname));
							return;
						}
						LOG(("Parvane: AUTOADMIN %1 %2 в '%3'").arg(act, mem, gname));
						groupAdminAction(gid, mem, act);
					});
				}
			}
		}

		// spec 004 / US1: PARVANE_AUTOGROUPINFO=Имя:about=<текст>[;avatar=<путь>][;clear_avatar=1]
		// Через ~11с (группа синхронизирована) зовёт те же функции, что экран
		// «Edit». Маркеры: «AUTOGROUPINFO '<Имя>' → ok (vN)» / «→ отказ <код>».
		if (const char *giv = ParvaneDevEnv("PARVANE_AUTOGROUPINFO"); giv && *giv) {
			const auto spec = QString::fromUtf8(giv);
			const auto c = spec.indexOf(':');
			if (c > 0) {
				const auto gname = spec.left(c);
				const auto fields = spec.mid(c + 1).split(';', Qt::SkipEmptyParts);
				base::call_delayed(11 * crl::time(1000), [gname, fields] {
					const auto gid = findGroupIdByName(gname);
					if (gid.isEmpty()) {
						LOG(("Parvane: AUTOGROUPINFO — группа '%1' не найдена").arg(gname));
						return;
					}
					const auto report = [gname](const QString &what) {
						return [gname, what](bool ok, const QString &error) {
							if (ok) {
								LOG(("Parvane: AUTOGROUPINFO '%1' %2 → ok").arg(gname, what));
							} else {
								LOG(("Parvane: AUTOGROUPINFO '%1' %2 → отказ %3").arg(gname, what, error));
							}
						};
					};
					for (const auto &field : fields) {
						const auto eq = field.indexOf('=');
						const auto key = (eq > 0) ? field.left(eq) : field;
						const auto value = (eq > 0) ? field.mid(eq + 1) : QString();
						if (key == u"about"_q) {
							SetGroupAbout(gid, value, report(u"about"_q));
						} else if (key == u"avatar"_q) {
							const auto image = QImage(value);
							if (image.isNull()) {
								LOG(("Parvane: AUTOGROUPINFO '%1' avatar → файл не прочитан %2").arg(gname, value));
								continue;
							}
							SetGroupPhoto(gid, image, report(u"avatar"_q));
						} else if (key == u"clear_avatar"_q) {
							ClearGroupPhoto(gid, report(u"clear_avatar"_q));
						}
					}
				});
			}
		}

		// spec 004 / US2: PARVANE_AUTOGROUPPERMS=Имя:send_media=0;send_polls=1;…
		// Незаданные права — текущие из кэша сведений. Зовёт SetGroupPerms (как
		// экран «Permissions»). Маркер «AUTOGROUPPERMS '<Имя>' → ok|отказ <код>».
		if (const char *gpv = ParvaneDevEnv("PARVANE_AUTOGROUPPERMS"); gpv && *gpv) {
			const auto spec = QString::fromUtf8(gpv);
			const auto c = spec.indexOf(':');
			if (c > 0) {
				const auto gname = spec.left(c);
				const auto fields = spec.mid(c + 1).split(';', Qt::SkipEmptyParts);
				base::call_delayed(11 * crl::time(1000), [gname, fields] {
					const auto gid = findGroupIdByName(gname);
					if (gid.isEmpty()) {
						LOG(("Parvane: AUTOGROUPPERMS — группа '%1' не найдена").arg(gname));
						return;
					}
					auto perms = parvane::DefaultPermissions();
					if (const auto info = g_groupInfo.constFind(gid); info != g_groupInfo.constEnd()) {
						perms = info.value().default_permissions;
					}
					for (const auto &field : fields) {
						const auto eq = field.indexOf('=');
						if (eq <= 0) {
							continue;
						}
						const auto key = field.left(eq);
						const auto on = (field.mid(eq + 1) != u"0"_q);
						if (key == u"send_messages"_q) perms.send_messages = on;
						else if (key == u"send_media"_q) perms.send_media = on;
						else if (key == u"send_stickers_gifs"_q) perms.send_stickers_gifs = on;
						else if (key == u"send_polls"_q) perms.send_polls = on;
						else if (key == u"embed_links"_q) perms.embed_links = on;
						else if (key == u"invite_users"_q) perms.invite_users = on;
						else if (key == u"pin_messages"_q) perms.pin_messages = on;
						else if (key == u"change_info"_q) perms.change_info = on;
					}
					SetGroupPerms(gid, restrictionsFromPerms(perms), [gname](bool ok, const QString &error) {
						if (ok) {
							LOG(("Parvane: AUTOGROUPPERMS '%1' → ok").arg(gname));
						} else {
							LOG(("Parvane: AUTOGROUPPERMS '%1' → отказ %2").arg(gname, error));
						}
					});
				});
			}
		}

		// spec 004 / US3: PARVANE_AUTOGROUPADMIN=Имя:<member>:<right,right,…> —
		// назначить админом с набором прав (как экран «Edit admin»); пустой
		// набор после второго ':' — снять. Маркер «AUTOGROUPADMIN '<Имя>' <member>
		// [rights] → ok|отказ <код>».
		if (const char *gav = ParvaneDevEnv("PARVANE_AUTOGROUPADMIN"); gav && *gav) {
			const auto spec = QString::fromUtf8(gav);
			const auto parts = spec.split(':');
			if (parts.size() >= 2) {
				const auto gname = parts[0];
				const auto member = parts[1];
				const auto rightsSpec = (parts.size() >= 3) ? parts[2] : QString();
				base::call_delayed(11 * crl::time(1000), [=] {
					const auto gid = findGroupIdByName(gname);
					if (gid.isEmpty()) {
						LOG(("Parvane: AUTOGROUPADMIN — группа '%1' не найдена").arg(gname));
						return;
					}
					using A = ChatAdminRight;
					auto rights = ChatAdminRights();
					for (const auto &r : rightsSpec.split(',', Qt::SkipEmptyParts)) {
						if (r == u"change_info"_q) rights |= A::ChangeInfo;
						else if (r == u"delete_messages"_q) rights |= A::DeleteMessages;
						else if (r == u"ban_users"_q) rights |= A::BanUsers;
						else if (r == u"invite_users"_q) rights |= A::InviteByLinkOrAdd;
						else if (r == u"pin_messages"_q) rights |= A::PinMessages;
						else if (r == u"add_admins"_q) rights |= A::AddAdmins;
					}
					const auto demote = rightsSpec.trimmed().isEmpty();
					SetGroupAdmin(gid, member, rights, demote, [=](bool ok, const QString &error) {
						if (ok) {
							LOG(("Parvane: AUTOGROUPADMIN '%1' %2 [%3] → ok").arg(gname, member, rightsSpec));
						} else {
							LOG(("Parvane: AUTOGROUPADMIN '%1' %2 [%3] → отказ %4").arg(gname, member, rightsSpec, error));
						}
					});
				});
			}
		}

		// spec 004 / US4: PARVANE_AUTOGROUPINVITE=Имя:create[;title=…][;expires=<unix>][;max=<n>][;request=1]
		// | Имя:revoke:<token> | Имя:delete:<token> | Имя:list — те же функции,
		// что экран «Invite Links». Маркеры: «AUTOGROUPINVITE '<Имя>' create → ok <token> state=…»,
		// «… revoke <token> → ok», «ссылки <gid> (активные|отозванные): …».
		if (const char *giv2 = ParvaneDevEnv("PARVANE_AUTOGROUPINVITE"); giv2 && *giv2) {
			const auto spec = QString::fromUtf8(giv2);
			const auto parts = spec.split(':');
			if (parts.size() >= 2) {
				const auto gname = parts[0];
				const auto actionSpec = parts[1];
				// Аргумент — всё после второго двоеточия: ссылка v2 — это URL
				const auto arg = (parts.size() >= 3) ? spec.section(':', 2) : QString();
				base::call_delayed(11 * crl::time(1000), [=] {
					const auto gid = findGroupIdByName(gname);
					if (gid.isEmpty()) {
						LOG(("Parvane: AUTOGROUPINVITE — группа '%1' не найдена").arg(gname));
						return;
					}
					const auto fields = actionSpec.split(';', Qt::SkipEmptyParts);
					const auto action = fields.isEmpty() ? QString() : fields.first();
					if (action == u"create"_q) {
						auto title = QString();
						auto expires = 0, max = 0;
						auto request = false;
						for (const auto &f : fields.mid(1)) {
							const auto eq = f.indexOf('=');
							const auto k = f.left(eq), v = f.mid(eq + 1);
							if (k == u"title"_q) title = v;
							else if (k == u"expires"_q) expires = v.toInt();
							else if (k == u"max"_q) max = v.toInt();
							else if (k == u"request"_q) request = (v != u"0"_q);
						}
						CreateGroupInvite(gid, title, expires, max, request, [=](bool ok, GroupInviteLink l, const QString &error) {
							if (ok) {
								LOG(("Parvane: AUTOGROUPINVITE '%1' create → ok %2 state=%3").arg(gname, l.token, l.state));
							} else {
								LOG(("Parvane: AUTOGROUPINVITE '%1' create → отказ %2").arg(gname, error));
							}
						});
					} else if (action == u"revoke"_q || action == u"delete"_q) {
						const auto report = [=](bool ok, const QString &error) {
							if (ok) {
								LOG(("Parvane: AUTOGROUPINVITE '%1' %2 %3 → ok").arg(gname, action, arg));
							} else {
								LOG(("Parvane: AUTOGROUPINVITE '%1' %2 %3 → отказ %4").arg(gname, action, arg, error));
							}
						};
						if (action == u"revoke"_q) RevokeGroupInvite(gid, arg, report);
						else DeleteGroupInvite(gid, arg, report);
					} else if (action == u"list"_q) {
						// тот же путь, что экран «Invite Links» (основная создаётся при отсутствии)
						ListGroupInvitesWithPrimary(gid, [=](bool ok, std::vector<GroupInviteLink>, const QString &error) {
							LOG(("Parvane: AUTOGROUPINVITE '%1' list → %2").arg(gname, ok ? u"ok"_q : u"отказ "_q + error));
							ListGroupInvites(gid, true, [](bool, std::vector<GroupInviteLink>, const QString &) {});
						});
					}
				});
			}
		}

		// spec 004 / US4: PARVANE_AUTOGROUPJOIN=<ссылка|токен>[;confirm=0] — проверка
		// (как модалка) и вступление. Маркеры «AUTOGROUPJOIN check → <name> members=N request=0/1»,
		// «AUTOGROUPJOIN join → ok <gid> | → pending | → отказ <код>».
		if (const char *gjv = ParvaneDevEnv("PARVANE_AUTOGROUPJOIN"); gjv && *gjv) {
			const auto spec = QString::fromUtf8(gjv).split(';', Qt::SkipEmptyParts);
			const auto token = spec.isEmpty() ? QString() : GroupInviteToken(spec.first());
			const auto confirm = !spec.contains(u"confirm=0"_q);
			base::call_delayed(6 * crl::time(1000), [=] {
				if (token.isEmpty()) {
					LOG(("Parvane: AUTOGROUPJOIN → отказ invalid (ссылка не распознана)"));
					return;
				}
				CheckGroupInvite(token, [=](bool ok, GroupInvitePreview p, const QString &error) {
					if (!ok) {
						LOG(("Parvane: AUTOGROUPJOIN check → отказ %1").arg(error));
						LOG(("Parvane: AUTOGROUPJOIN join → отказ %1").arg(error));
						return;
					}
					LOG(("Parvane: AUTOGROUPJOIN check → %1 members=%2 request=%3")
						.arg(p.name).arg(p.members).arg(p.requestNeeded ? 1 : 0));
					// FR-041: фото группы в превью — тот же путь, что модалка
					if (!p.avatar.isEmpty()) {
						FetchPublicImage(p.avatar, [=](QImage image, QByteArray) {
							if (image.isNull()) {
								LOG(("Parvane: AUTOGROUPJOIN превью: фото группы %1 не загружено").arg(p.avatar));
							} else {
								LOG(("Parvane: AUTOGROUPJOIN превью: фото группы %1x%2")
									.arg(image.width()).arg(image.height()));
							}
						});
					}
					if (p.alreadyMember) {
						LOG(("Parvane: AUTOGROUPJOIN join → ok %1 (уже участник)").arg(p.groupId));
						return;
					}
					if (!confirm) {
						return;
					}
					JoinGroupByInvite(token, [=](bool ok2, const QString &gid, bool pending, const QString &error2) {
						if (!ok2) {
							LOG(("Parvane: AUTOGROUPJOIN join → отказ %1").arg(error2));
						} else if (pending) {
							LOG(("Parvane: AUTOGROUPJOIN join → pending"));
						} else {
							LOG(("Parvane: AUTOGROUPJOIN join → ok %1").arg(gid));
						}
					});
				});
			});
		}

		// spec 004 / US5: PARVANE_AUTOGROUPREQUEST=Имя:list | Имя:approve:<member> |
		// Имя:decline:<member> | Имя:approve:all — как экран «Join Requests».
		// Маркеры: «заявки <gid>: …», «AUTOGROUPREQUEST '<Имя>' approve <member> → ok|отказ <код>».
		if (const char *grv = ParvaneDevEnv("PARVANE_AUTOGROUPREQUEST"); grv && *grv) {
			const auto parts = QString::fromUtf8(grv).split(':');
			if (parts.size() >= 2) {
				const auto gname = parts[0];
				const auto action = parts[1];
				const auto member = (parts.size() >= 3) ? parts[2] : QString();
				base::call_delayed(11 * crl::time(1000), [=] {
					const auto gid = findGroupIdByName(gname);
					if (gid.isEmpty()) {
						LOG(("Parvane: AUTOGROUPREQUEST — группа '%1' не найдена").arg(gname));
						return;
					}
					const auto decide = [=](const QString &who, bool approve) {
						DecideJoinRequest(gid, who, approve, [=](bool ok, const QString &error) {
							LOG(("Parvane: AUTOGROUPREQUEST '%1' %2 %3 → %4")
								.arg(gname, approve ? u"approve"_q : u"decline"_q, who,
									ok ? u"ok"_q : u"отказ "_q + error));
						});
					};
					if (action == u"list"_q) {
						ListJoinRequests(gid, [](bool, std::vector<GroupJoinRequest>, const QString &) {});
					} else if (member == u"all"_q) {
						ListJoinRequests(gid, [=](bool ok, std::vector<GroupJoinRequest> list, const QString &) {
							if (!ok) {
								return;
							}
							for (const auto &r : list) {
								decide(r.member, action == u"approve"_q);
							}
						});
					} else if (!member.isEmpty()) {
						decide(member, action == u"approve"_q);
					}
				});
			}
		}

		// spec 004 / GROUP-2: PARVANE_AUTOGROUPSENDFILE=Имя:<путь>[;bypass=1] —
		// файл в группу. Без bypass — через штатную проверку прав композера
		// (Data::AnyFileRestrictionError): при запрете маркер «запрещено правами»
		// и отправки нет. С bypass=1 — мимо проверки (участник-нарушитель для
		// теста приёмного фильтра). Через ~11с (группа синхронизирована).
		if (const char *gfv = ParvaneDevEnv("PARVANE_AUTOGROUPSENDFILE"); gfv && *gfv) {
			const auto spec = QString::fromUtf8(gfv);
			const auto c = spec.indexOf(':');
			if (c > 0) {
				const auto gname = spec.left(c);
				const auto rest = spec.mid(c + 1).split(';', Qt::SkipEmptyParts);
				const auto path = rest.isEmpty() ? QString() : rest.first();
				const auto bypass = rest.contains(u"bypass=1"_q);
				base::call_delayed(11 * crl::time(1000), [=] {
					const auto gid = findGroupIdByName(gname);
					if (gid.isEmpty()) {
						LOG(("Parvane: AUTOGROUPSENDFILE — группа '%1' не найдена").arg(gname));
						return;
					}
					auto f = QFile(path);
					if (!f.open(QIODevice::ReadOnly)) {
						LOG(("Parvane: AUTOGROUPSENDFILE — не открыть %1").arg(path));
						return;
					}
					const auto bytes = f.readAll();
					ensureGroupChat(session, gid, gname, 0);
					const auto chat = session->data().chat(ChatId(BareId(IdForAddress(gid))));
					const auto lower = path.toLower();
					const auto type = (lower.endsWith(u".png"_q) || lower.endsWith(u".jpg"_q) || lower.endsWith(u".jpeg"_q))
						? SendMediaType::Photo
						: SendMediaType::File;
					if (!bypass) {
						// Как штатная отправка (Data::FileRestrictionError): проверка
						// ПО ТИПУ файла. AnyFileRestrictionError тут не годится — он
						// «запрещено», только когда закрыты все типы, включая стикеры/GIF.
						const auto right = (type == SendMediaType::Photo)
							? ChatRestriction::SendPhotos
							: ChatRestriction::SendFiles;
						if (const auto error = Data::RestrictionError(chat, right)) {
							LOG(("Parvane: AUTOGROUPSENDFILE → запрещено правами (%1)").arg(error.text));
							return;
						}
					}
					session->api().sendFile(bytes, type, Api::SendAction(session->data().history(chat)));
					LOG(("Parvane: AUTOGROUPSENDFILE → отправлено (%1 байт%2)")
						.arg(bytes.size()).arg(bypass ? u", bypass"_q : QString()));
				});
			}
		}

		// Debug-autogroupsend для e2e групп (Фаза 3, Megolm): PARVANE_AUTOGROUPSEND=
		// Имя_группы:текст → через ~9с (дать группе синхронизироваться) отправляет
		// текст в группу ЧЕРЕЗ E2E-путь клиента (sender keys + раздача SKDM).
		if (const char *gsv = ParvaneDevEnv("PARVANE_AUTOGROUPSEND"); gsv && *gsv) {
			auto spec = QString::fromUtf8(gsv);
			const auto sp = spec.indexOf(':');
			if (sp > 0) {
				const auto gname = spec.left(sp);
				const auto text = spec.mid(sp + 1);
				base::call_delayed(9 * crl::time(1000), [gname, text] {
					QString gid;
					{
						std::lock_guard<std::mutex> lk(g_sessionMutex);
						for (auto it = g_knownGroups.constBegin();
								it != g_knownGroups.constEnd(); ++it) {
							if (it.value() == gname) {
								gid = it.key();
								break;
							}
						}
					}
					if (gid.isEmpty()) {
						LOG(("Parvane: AUTOGROUPSEND — группа '%1' не найдена").arg(gname));
						return;
					}
					LOG(("Parvane: AUTOGROUPSEND → '%1' (%2): %3").arg(gname, gid, text));
					sendTextAsync(gid, text, nlohmann::json::array(), std::string());
				});
			}
		}

		// Debug-autogroupsend2 для e2e ротации: второе групповое сообщение через ~24с
		// (ПОСЛЕ удаления участника + ротации ключа — проверяет re-key у оставшихся).
		if (const char *gs2 = ParvaneDevEnv("PARVANE_AUTOGROUPSEND2"); gs2 && *gs2) {
			auto spec = QString::fromUtf8(gs2);
			const auto sp = spec.indexOf(':');
			if (sp > 0) {
				const auto gname = spec.left(sp);
				const auto text = spec.mid(sp + 1);
				base::call_delayed(24 * crl::time(1000), [gname, text] {
					QString gid;
					{
						std::lock_guard<std::mutex> lk(g_sessionMutex);
						for (auto it = g_knownGroups.constBegin();
								it != g_knownGroups.constEnd(); ++it) {
							if (it.value() == gname) {
								gid = it.key();
								break;
							}
						}
					}
					if (gid.isEmpty()) {
						return;
					}
					LOG(("Parvane: AUTOGROUPSEND2 → '%1' (%2): %3").arg(gname, gid, text));
					sendTextAsync(gid, text, nlohmann::json::array(), std::string());
				});
			}
		}

		// Debug-autocall для e2e звонков: PARVANE_AUTOCALL=peer@server[:video].
		// Инициатор через ~4с звонит; принимающий ставит PARVANE_AUTOACCEPT=1.
		if (const char *cv = ParvaneDevEnv("PARVANE_AUTOCALL"); cv && *cv) {
			auto spec = QString::fromUtf8(cv);
			const auto video = spec.endsWith(u":video"_q);
			if (video) spec.chop(6);
			base::call_delayed(4 * crl::time(1000), [spec, video] {
				LOG(("Parvane: AUTOCALL → %1").arg(spec));
				PlaceCall(spec, video);
			});
		}

		// Debug-autohangup для диагностики закрытия окна: через N сек отбой.
		if (const char *hv = ParvaneDevEnv("PARVANE_AUTOHANGUP"); hv && *hv) {
			const auto secs = std::max(QString::fromUtf8(hv).toInt(), 1);
			base::call_delayed(secs * crl::time(1000), [] {
				LOG(("Parvane: AUTOHANGUP"));
				HangupCall();
			});
		}

		// Протокол v2 (e2e, spec 007): PARVANE_AUTOSEND_V2=peer:msg1|msg2|… —
		// ждёт готовности v2-сессии и журнала устройств собеседника (до 120 с),
		// затем шлёт по одному в секунду ШТАТНЫМ путём отправки (маршрутизация
		// по журналу, как у человека). Элемент, начинающийся с «{», — сырое
		// содержимое v2 (proto3-JSON Content) прямо в v2-сессию: так у
		// получателя проверяется заглушка вида, которого клиент не знает.
		if (const char *v2v = ParvaneDevEnv("PARVANE_AUTOSEND_V2"); v2v && *v2v) {
			const auto spec = QString::fromUtf8(v2v);
			const auto sep = spec.indexOf(':');
			if (sep > 0) {
				const auto peerAddr = spec.left(sep);
				const auto items = spec.mid(sep + 1).split(u'|', Qt::SkipEmptyParts);
				crl::async([weak, peerAddr, items] {
					const auto peerStd = peerAddr.toStdString();
					auto ready = false;
					for (auto i = 0; i < 120 && !ready; ++i) {
						if (const auto s = V2Ready(); s && s->isV2Peer(peerStd)) {
							ready = true;
							break;
						}
						std::this_thread::sleep_for(std::chrono::seconds(1));
					}
					if (!ready) {
						LOG(("Parvane: autosend-v2 → %1: собеседник не на v2 (таймаут)").arg(peerAddr));
						return;
					}
					LOG(("Parvane: autosend-v2: %1 на v2").arg(peerAddr));
					for (const auto &item : items) {
						if (item.startsWith(u'{')) {
							const auto content = nlohmann::json::parse(item.toStdString(), nullptr, false);
							const auto s = V2Ready();
							if (s && content.is_object()) {
								try {
									s->sendContent(peerStd, content, parvane::v2::newUuidV7());
									LOG(("Parvane: autosend-v2 raw → %1: %2").arg(peerAddr, item));
								} catch (const std::exception &e) {
									LOG(("Parvane: autosend-v2 raw не отправлено: %1").arg(QString::fromUtf8(e.what())));
								}
							}
						} else {
							crl::on_main([weak, peerAddr, item] {
								const auto s = weak.get();
								if (!s) {
									return;
								}
								RegisterPeer(peerAddr);
								const auto user = s->data().user(
									UserId(BareId(IdForAddress(peerAddr))));
								auto message = Api::MessageToSend(
									Api::SendAction(s->data().history(user)));
								message.textWithTags = TextWithTags{ item, TextWithTags::Tags() };
								s->api().sendMessage(std::move(message));
								LOG(("Parvane: autosend-v2 → %1: %2").arg(peerAddr, item));
							});
						}
						std::this_thread::sleep_for(std::chrono::seconds(1));
					}
				});
			}
		}

		// Режим «усиленная приватность» (e2e, T079): PARVANE_AUTOL2=<чат>:<шаг>[,<шаг>…],
		// шаг — on|off[@сек]; чат — адрес собеседника, адрес группы v2
		// (v2g:<hex>) или group=<имя группы>. Каждый шаг зовёт штатный
		// SetChatL2 (тот же путь, что переключатель в профиле/управлении
		// группой), при неготовой сессии повторяет раз в 2 с до 2 минут.
		if (const char *l2v = ParvaneDevEnv("PARVANE_AUTOL2"); l2v && *l2v) {
			const auto spec = QString::fromUtf8(l2v);
			const auto sep = spec.lastIndexOf(u':'); // адрес группы сам содержит ':'
			if (sep > 0) {
				const auto chatSpec = spec.left(sep);
				for (const auto &step : spec.mid(sep + 1).split(u',', Qt::SkipEmptyParts)) {
					const auto at = step.indexOf(u'@');
					const auto enabled = ((at < 0) ? step : step.left(at)) == u"on"_q;
					const auto delay = (at < 0) ? 0 : step.mid(at + 1).toInt();
					base::call_delayed(delay * crl::time(1000), [weak, chatSpec, enabled] {
						AutoL2Step(weak, chatSpec, enabled, 0);
					});
				}
			}
		}

		// «Печатает» (e2e, L2-1): PARVANE_AUTOTYPING=<собеседник>@сек[,…] — зовёт
		// штатный MirrorTyping и пишет, ушёл ли он (в L2-чате — подавлен).
		if (const char *tv = ParvaneDevEnv("PARVANE_AUTOTYPING"); tv && *tv) {
			for (const auto &item : QString::fromUtf8(tv).split(u',', Qt::SkipEmptyParts)) {
				const auto at = item.lastIndexOf(u'@');
				const auto address = (at > 0) ? item.left(at) : item;
				const auto delay = (at > 0) ? item.mid(at + 1).toInt() : 0;
				base::call_delayed(delay * crl::time(1000), [weak, address] {
					const auto s = weak.get();
					if (!s) {
						return;
					}
					RegisterPeer(address);
					const auto user = s->data().user(UserId(BareId(IdForAddress(address))));
					const auto suppressed = L2Active(address);
					MirrorTyping(user);
					LOG(("Parvane: autotyping → %1: %2")
						.arg(address, suppressed ? u"подавлен (L2)"_q : u"отправлен"_q));
				});
			}
		}

		// «Сообщения от незнакомых» (e2e, T079): PARVANE_AUTOSTRANGERS=on|off[@сек].
		if (const char *pv = ParvaneDevEnv("PARVANE_AUTOSTRANGERS"); pv && *pv) {
			const auto spec = QString::fromUtf8(pv);
			const auto at = spec.indexOf(u'@');
			const auto allowed = ((at < 0) ? spec : spec.left(at)) == u"on"_q;
			const auto delay = (at < 0) ? 0 : spec.mid(at + 1).toInt();
			base::call_delayed(delay * crl::time(1000), [allowed] {
				SetStrangersAllowed(allowed);
			});
		}

		// Приватность звонков/присутствия/добавления в группы (e2e, T137):
		// PARVANE_AUTOAUDIENCE=<calls|presence|groupadd>:<nobody|all>@сек[,…].
		if (const char *av = ParvaneDevEnv("PARVANE_AUTOAUDIENCE"); av && *av) {
			for (const auto &part : QString::fromUtf8(av).split(QChar(','), Qt::SkipEmptyParts)) {
				const auto colon = part.indexOf(u':');
				const auto at = part.lastIndexOf(u'@');
				if (colon <= 0 || at <= colon) {
					continue;
				}
				const auto name = part.left(colon);
				const auto which = (name == u"calls"_q)
					? PrivacyAudience::Calls
					: (name == u"presence"_q)
					? PrivacyAudience::Presence
					: PrivacyAudience::GroupAdd;
				const auto nobody = (part.mid(colon + 1, at - colon - 1) == u"nobody"_q);
				base::call_delayed(part.mid(at + 1).toInt() * crl::time(1000), [=] {
					SetPrivacyAudienceNobody(which, nobody);
				});
			}
		}

		// Личное состояние (e2e, T132): PARVANE_AUTOSTATE=<op>:<адрес>@сек[,…],
		// op = block|unblock|archive|unarchive|pin|unpin — нативными путями.
		if (const char *sv = ParvaneDevEnv("PARVANE_AUTOSTATE"); sv && *sv) {
			for (const auto &part : QString::fromUtf8(sv).split(QChar(','), Qt::SkipEmptyParts)) {
				const auto colon = part.indexOf(u':');
				const auto at = part.lastIndexOf(u'@');
				const auto dog = part.indexOf(u'@');
				if (colon <= 0 || at <= colon || at == dog) {
					continue;
				}
				const auto op = part.left(colon);
				const auto address = part.mid(colon + 1, at - colon - 1);
				const auto delay = part.mid(at + 1).toInt();
				base::call_delayed(delay * crl::time(1000), [weak, op, address] {
					const auto s = weak.get();
					if (!s) {
						return;
					}
					const auto history = HistoryForAddress(s, address);
					if (!history) {
						return;
					}
					if (op == u"block"_q) {
						s->api().blockedPeers().block(history->peer);
					} else if (op == u"unblock"_q) {
						s->api().blockedPeers().unblock(history->peer, nullptr, true);
					} else if (op == u"archive"_q || op == u"unarchive"_q) {
						s->api().toggleHistoryArchived(history, op == u"archive"_q, nullptr);
					} else if (op == u"pin"_q || op == u"unpin"_q) {
						if (!history->folderKnown()) {
							history->clearFolder();
						}
						s->data().setChatPinned(history, FilterId(), op == u"pin"_q);
						MirrorDialogPins(s);
					}
					LOG(("Parvane: autostate %1 → %2").arg(op, address));
				});
			}
		}

		// Debug-autosticker для e2e стикеров: PARVANE_AUTOSTICKER=peer@server —
		// шлёт первый стикер первого локального пака нативным путём
		// (SendExistingDocument → врезка MirrorOutgoingSticker). Отложен за
		// LoadLocalStickerPacks (t+3с) и E2E-инициализацию.
		if (const char *sv = ParvaneDevEnv("PARVANE_AUTOSTICKER"); sv && *sv) {
			const auto peerAddr = QString::fromUtf8(sv);
			base::call_delayed(6 * crl::time(1000), [weak, peerAddr] {
				const auto s = weak.get();
				if (!s) {
					return;
				}
				LoadLocalStickerPacks(s); // идемпотентно (вдруг стёрло)
				RegisterPeer(peerAddr);
				const auto user = s->data().user(
					UserId(BareId(IdForAddress(peerAddr))));
				const auto history = s->data().history(user);
				// Только локальные стикер-паки (g_stickerPackDirs): sets() — flat_map по id, и первым
				// непустым набором оказывался эмодзи-набор (pvemoji-set:…), у которого нет каталога пака —
				// в cloud уходил один файл без pack_ref (tgx_stickers_flow.sh, 27 сен 2026)
				auto sticker = (DocumentData*)nullptr;
				{
					const auto &sets = s->data().stickers().sets();
					for (auto it = g_stickerPackDirs.constBegin(); it != g_stickerPackDirs.constEnd(); ++it) {
						const auto found = sets.find(it.key());
						if (found != sets.end() && !found->second->stickers.isEmpty()) {
							sticker = found->second->stickers.front();
							break;
						}
					}
				}
				if (sticker) {
					Api::SendExistingDocument(
						Api::MessageToSend(Api::SendAction(history)), sticker);
					LOG(("Parvane: autosticker → %1").arg(peerAddr));
				} else {
					LOG(("Parvane: autosticker — локальных паков нет"));
				}
			});
		}

		// Debug-autopoll для e2e опросов: PARVANE_AUTOPOLL=peer@server:Вопрос:а,б,в
		if (const char *pv = ParvaneDevEnv("PARVANE_AUTOPOLL"); pv && *pv) {
			const auto spec = QString::fromUtf8(pv);
			const auto parts = spec.split(u':');
			if (parts.size() >= 3) {
				const auto peerAddr = parts[0];
				RegisterPeer(peerAddr);
				const auto user = session->data().user(
					UserId(BareId(IdForAddress(peerAddr))));
				auto poll = PollData(&session->data(), 0);
				poll.setFlags(PollData::Flag::PublicVotes); // как дефолт UI
				poll.question.text = parts[1];
				for (const auto &optionText : parts[2].split(u',')) {
					auto answer = PollAnswer();
					answer.text.text = optionText;
					poll.answers.push_back(std::move(answer));
				}
				MirrorPollCreate(user, poll);
				LOG(("Parvane: autopoll → %1: %2").arg(peerAddr, parts[1]));
			}
		}

		// Debug-autosend для e2e Фазы 3b: PARVANE_AUTOSEND=peer@server:текст.
		const char *v = ParvaneDevEnv("PARVANE_AUTOSEND");
		if (!v || !*v) {
			return;
		}
		const auto spec = QString::fromUtf8(v);
		const auto sep = spec.indexOf(':');
		if (sep <= 0) {
			return;
		}
		const auto peerAddr = spec.left(sep);
		const auto text = spec.mid(sep + 1);
		RegisterPeer(peerAddr);
		const auto user = session->data().user(
			UserId(BareId(IdForAddress(peerAddr))));
		const auto history = session->data().history(user);
		auto message = Api::MessageToSend(Api::SendAction(history));
		message.textWithTags = TextWithTags{ text, TextWithTags::Tags() };
		session->api().sendMessage(std::move(message));
		LOG(("Parvane: autosend → %1: %2").arg(peerAddr).arg(text));

		// Debug-autolocation для e2e: PARVANE_AUTOLOCATION=peer@server:lat,lon —
		// отправляет геолокацию тем же путём, что меню вложений (MirrorLocationIfOurs).
		// Debug-autoemoji для e2e кастом-эмодзи: PARVANE_AUTOEMOJI=peer[,peer2]:pack:file —
		// отправляет текст с одним custom_emoji-entity (как выбор из панели):
		// грузит локальный пак, шлёт entity(docId)+emoji_packs получателю.
		// Несколько адресатов через запятую — для conformance PACK-1: архив
		// пака грузится в cloud ОТДЕЛЬНО под каждый набор получателей.
		if (const char *ev = ParvaneDevEnv("PARVANE_AUTOEMOJI"); ev && *ev) {
			const auto espec = QString::fromUtf8(ev);
			const auto p1 = espec.indexOf(':');
			const auto p2 = espec.indexOf(':', p1 + 1);
			if (p1 > 0 && p2 > p1) {
				const auto eaddrs = espec.left(p1).split(
					QChar(','), Qt::SkipEmptyParts);
				const auto pack = espec.mid(p1 + 1, p2 - p1 - 1);
				const auto file = espec.mid(p2 + 1);
				auto delaySecs = 5;
				for (const auto &eaddr : eaddrs) {
					RegisterPeer(eaddr);
					const auto eu = session->data().user(
						UserId(BareId(IdForAddress(eaddr))));
					// t+5с: после LoadLocalCustomEmoji (t+3с), чтобы
					// g_emojiDocToSet знал набор и BuildEmojiPacks приложил
					// pack_ref; следующему адресату — ещё +5 с, архив под
					// предыдущий набор получателей успевает загрузиться
					base::call_delayed(delaySecs * crl::time(1000), [eu, pack, file] {
						const auto docId = EmojiDocId(pack, file);
						auto alt = QString::fromUtf8("\xF0\x9F\x99\x82");
						const auto base = QFileInfo(file).completeBaseName();
						if (const auto d = base.lastIndexOf(u'-'); d >= 0) {
							auto ok = false;
							const auto code = base.mid(d + 1).toUInt(&ok, 16);
							if (ok && code >= 0x80 && code <= 0x10FFFF) {
								const char32_t c = code; alt = QString::fromUcs4(&c, 1);
							}
						}
						auto entities = EntitiesInText();
						entities.push_back(EntityInText(
							EntityType::CustomEmoji, 0, int(alt.size()),
							QString::number(docId)));
						MirrorOutgoing(eu, TextWithEntities{ alt, entities });
						LOG(("Parvane: autoemoji → %1 (docId=%2)")
							.arg(eu ? u"peer"_q : QString()).arg(docId));
					});
					delaySecs += 5;
				}
			}
		}
		// Debug-autoschedule для e2e: PARVANE_AUTOSCHEDULE=peer@server:secs:текст —
		// планирует сообщение через secs секунд тем же путём, что нативное меню.
		if (const char *sv = ParvaneDevEnv("PARVANE_AUTOSCHEDULE"); sv && *sv) {
			const auto sspec = QString::fromUtf8(sv);
			const auto s1 = sspec.indexOf(':');
			const auto s2i = sspec.indexOf(':', s1 + 1);
			if (s1 > 0 && s2i > s1) {
				const auto saddr = sspec.left(s1);
				const auto secs = sspec.mid(s1 + 1, s2i - s1 - 1).toInt();
				const auto stext = sspec.mid(s2i + 1);
				RegisterPeer(saddr);
				const auto su = session->data().user(
					UserId(BareId(IdForAddress(saddr))));
				const auto due = QDateTime::currentSecsSinceEpoch() + std::max(secs, 1);
				ScheduleOutgoing(su, TextWithEntities{ stext }, 0, due);
			}
		}
		// PARVANE_AUTOLOCATION=peer:lat,lon[:live=SEC[:moves=lat,lon;lat,lon…]]
		// live — трансляция на SEC секунд; moves — правки позиции каждые 2 с,
		// после последней — стоп (правка без live_period). Собственный пузырь
		// обновляется локально (карта следует за координатами и у отправителя).
		if (const char *lv = ParvaneDevEnv("PARVANE_AUTOLOCATION"); lv && *lv) {
			const auto parts = QString::fromUtf8(lv).split(':');
			const auto coords = (parts.size() > 1) ? parts[1].split(',') : QStringList();
			if (parts.size() >= 2 && coords.size() == 2) {
				const auto laddr = parts[0];
				const auto lat = coords[0].toDouble();
				const auto lon = coords[1].toDouble();
				auto live = 0;
				auto moves = std::vector<std::pair<double, double>>();
				for (auto i = 2; i < parts.size(); ++i) {
					if (parts[i].startsWith(u"live="_q)) {
						live = parts[i].mid(5).toInt();
					} else if (parts[i].startsWith(u"moves="_q)) {
						for (const auto &m : parts[i].mid(6).split(';')) {
							const auto c = m.split(',');
							if (c.size() == 2) {
								moves.emplace_back(c[0].toDouble(), c[1].toDouble());
							}
						}
					}
				}
				RegisterPeer(laddr);
				const auto lu = session->data().user(
					UserId(BareId(IdForAddress(laddr))));
				const auto uuid = std::make_shared<std::string>();
				base::call_delayed(crl::time(1500), [lu, lat, lon, live, uuid] {
					(void)MirrorLocationIfOurs(lu, lat, lon, live, uuid.get());
				});
				if (live > 0) {
					auto delay = crl::time(1500);
					for (const auto &[mlat, mlon] : moves) {
						delay += 2000;
						base::call_delayed(delay, [lu, mlat, mlon, live, uuid] {
							if (!uuid->empty()) {
								MirrorLiveLocationUpdate(lu, *uuid, mlat, mlon, live);
							}
						});
					}
					const auto last = moves.empty()
						? std::make_pair(lat, lon)
						: moves.back();
					base::call_delayed(delay + 2000, [lu, last, uuid] {
						if (!uuid->empty()) {
							MirrorLiveLocationUpdate(lu, *uuid, last.first, last.second, 0);
						}
					});
				}
			}
		}
	});
}

// ── Мультидевайс: устройства (identity.device.list / revoke) ─────────────────
void ListDevices(Fn<void(std::vector<DeviceEntry>)> done) {
	crl::async([done = std::move(done)] {
		parvane::ITransport *t = nullptr;
		std::string token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			token = g_token.toStdString();
		}
		std::vector<DeviceEntry> out;
		if (t) {
			try {
				const auto raw = t->request(parvane::topics::IdentityDeviceList,
					parvane::json{{"token", token}}.dump(), 5000);
				const auto resp = parvane::json::parse(raw, nullptr, false);
				if (resp.is_object() && resp.value("ok", false)
					&& resp.contains("devices") && resp["devices"].is_array()) {
					const auto mine = parvane::e2e::deviceId();
					for (const auto &d : resp["devices"]) {
						if (!d.is_object()) {
							continue;
						}
						DeviceEntry e;
						e.deviceId = QString::fromStdString(d.value("device_id", std::string()));
						e.signingKey = QString::fromStdString(d.value("signing_key", std::string()));
						e.updatedAt = d.value("updated_at", std::int64_t(0));
						e.oneTimeAvailable = d.value("one_time_available", 0);
						e.current = (e.deviceId.toStdString() == mine);
						out.push_back(std::move(e));
					}
				}
			} catch (const std::exception &e) {
				LOG(("Parvane: device.list ошибка: %1").arg(QString::fromUtf8(e.what())));
			}
		}
		// Устройства только из журнала v2: у аккаунта на v2 новое устройство в
		// каталог v1 не попадает (T048) — иначе его не видно и не отозвать.
		if (const auto s = V2Ready()) {
			const auto mine = parvane::e2e::deviceId();
			for (const auto &id : s->ownDevices()) {
				const auto idQ = QString::fromStdString(id);
				const auto known = std::any_of(out.begin(), out.end(), [&](const DeviceEntry &e) {
					return e.deviceId == idQ;
				});
				if (known) {
					continue;
				}
				DeviceEntry e;
				e.deviceId = idQ;
				e.updatedAt = QDateTime::currentSecsSinceEpoch();
				e.current = (id == mine);
				out.push_back(std::move(e));
			}
		}
		crl::on_main([done, out = std::move(out)]() mutable { done(std::move(out)); });
	});
}

// «Seen by» / «read at» для нативного меню: список прочитавших сообщение из
// messenger (msg.chat.readers). Воркер → main. Себя не отдаём.
void FetchReaders(qint64 msgId, Fn<void(std::vector<ReaderEntry>)> done) {
	QString uuid;
	{
		const auto it = g_msgIdToUuid.find(msgId);
		if (it != g_msgIdToUuid.end()) {
			uuid = it.value();
		}
	}
	parvane::MessengerClient *m = nullptr;
	std::string self, token;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		m = g_messenger.get();
		self = g_selfAddress.toStdString();
		token = g_token.toStdString();
	}
	if (uuid.isEmpty() || !m || token.empty()) {
		done({});
		return;
	}
	crl::async([=, uuid = uuid.toStdString()] {
		std::vector<ReaderEntry> out;
		try {
			// Сообщение v2: прочтения — E2E-квитанции, их знает только движок
			// (серверу не видно, кто что прочитал); v1 — список шарда.
			const auto v2 = IsV2Message(uuid) ? V2Ready() : nullptr;
			const auto signature = v2 ? std::string() : parvane::e2e::sign("readers:" + uuid);
			const auto list = v2 ? v2->readers(uuid) : m->readers(self, uuid, token, signature);
			for (const auto &[address, ts] : list) {
				if (address == self || address.empty()) {
					continue;
				}
				out.push_back(ReaderEntry{
					.address = QString::fromStdString(address),
					.userId = qint64(IdForAddress(QString::fromStdString(address))),
					.date = ts,
				});
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: readers %1 — ошибка: %2")
				.arg(QString::fromStdString(uuid))
				.arg(QString::fromUtf8(e.what())));
		}
		QStringList who;
		for (const auto &r : out) {
			who.push_back(r.address + '@' + QString::number(r.date));
		}
		LOG(("Parvane: readers %1: %2")
			.arg(QString::fromStdString(uuid))
			.arg(who.isEmpty() ? u"—"_q : who.join(", ")));
		crl::on_main([done, out = std::move(out)]() mutable {
			done(std::move(out));
		});
	});
}

void RevokeDevice(const QString &deviceId, Fn<void(bool)> done, const QString &password) {
	const auto devStd = deviceId.toStdString();
	const auto pwStd = password.toStdString();
	crl::async([=] {
		parvane::ITransport *t = nullptr;
		std::string token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			token = g_token.toStdString();
		}
		bool ok = false;
		if (t && devStd != parvane::e2e::deviceId()) {
			try {
				// P-07: отзыв устройства требует текущий пароль.
				parvane::json body{{"token", token}, {"device_id", devStd}};
				if (!pwStd.empty()) {
					body["password"] = pwStd;
				}
				const auto raw = t->request(parvane::topics::IdentityDeviceRevoke,
					body.dump(), 5000);
				ok = parvane::json::parse(raw, nullptr, false).value("ok", false);
			} catch (const std::exception &e) {
				LOG(("Parvane: device.revoke ошибка: %1").arg(QString::fromUtf8(e.what())));
			}
		}
		if (ok) {
			// Отозванное устройство больше не должно читать новые групповые
			// сообщения → ротация всех своих Megolm-сессий (новый ключ раздастся
			// текущим устройствам при следующей отправке).
			parvane::e2e::forgetOwnDevice(devStd);
			LOG(("Parvane: устройство %1 отозвано, групповые ключи ротированы")
				.arg(deviceId));
			// Протокол v2 (T128, FR-066): запись отзыва в журнале устройств и
			// ротации ключей, которые устройство держало. После v1-отзыва (он
			// проверил пароль): сбой v2 устройство не возвращает.
			auto journaled = false;
			if (const auto s = V2Ready()) {
				try {
					if (s->revokeDevice(devStd)) {
						journaled = true;
						LOG(("Parvane: v2: устройство %1 отозвано в журнале устройств").arg(deviceId));
					}
				} catch (const std::exception &e) {
					LOG(("Parvane: v2: отзыв устройства в журнале не выполнен: %1")
						.arg(QString::fromUtf8(e.what())));
				}
			}
			// Без соединения v1 (E6-1) отзыв — только запись журнала устройств: мост
			// отвечает «ok» уже после проверки пароля. Записи нет (это устройство
			// не привязано к журналу либо сервер её не принял) — отзыва не было.
			auto v1Absent = false;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				v1Absent = V1AbsentLocked();
			}
			if (v1Absent && !journaled) {
				LOG(("Parvane: устройство %1 не отозвано: без v1 нужна запись журнала устройств").arg(deviceId));
				ok = false;
			}
		}
		crl::on_main([done, ok] { done(ok); });
	});
}

// ── ICE-серверы (STUN/TURN с эфемерными кредами) из шарда call ───────────────
// Запрос к шарду НЕЛЬЗЯ делать там, где создаётся движок звонка: входящий вызов
// обрабатывается на потоке чтения транспорта gateway, и request оттуда ждал
// ответ, который должен был прочитать этот же поток, — 4 с таймаута, звонок без
// STUN/TURN (за NAT он не соединялся). Поэтому серверы запрашиваются заранее
// воркером (PrefetchIceServers: при готовности сессии и по сроку кэша), а
// FetchIceServers только отдаёт кэш и никогда не блокирует.
namespace {

std::mutex g_iceMutex;
std::vector<IceServer> g_iceCached;
std::int64_t g_iceCachedUntil = 0;
bool g_iceRefreshing = false;

// Воркер: один запрос call.ice.request, результат — в кэш.
void RefreshIceServers() {
	parvane::ITransport *t = nullptr;
	std::string self, token;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_transport.get();
		self = g_selfAddress.toStdString();
		token = g_token.toStdString();
	}
	std::vector<IceServer> out;
	std::int64_t ttl = 600;
	if (t) {
		try {
			const auto ev = parvane::makeEvent(parvane::newUuidV7(), self,
				parvane::nowUnix(), token, parvane::json::object());
			const auto raw = t->request(parvane::topics::CallIceRequest, ev.dump(), 4000);
			const auto resp = parvane::json::parse(raw, nullptr, false);
			const auto &pl = (resp.is_object() && resp.contains("payload")) ? resp["payload"] : resp;
			if (pl.is_object() && pl.contains("ice_servers") && pl["ice_servers"].is_array()) {
				ttl = pl.value("ttl_secs", std::int64_t(600));
				for (const auto &srv : pl["ice_servers"]) {
					if (!srv.is_object() || !srv.contains("urls")) {
						continue;
					}
					IceServer ice;
					if (srv["urls"].is_array()) {
						for (const auto &u : srv["urls"]) {
							if (u.is_string()) {
								ice.urls.push_back(u.get<std::string>());
							}
						}
					} else if (srv["urls"].is_string()) {
						ice.urls.push_back(srv["urls"].get<std::string>());
					}
					ice.username = srv.value("username", std::string());
					ice.password = srv.value("credential", std::string());
					if (!ice.urls.empty()) {
						out.push_back(std::move(ice));
					}
				}
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: call.ice.request ошибка: %1").arg(QString::fromUtf8(e.what())));
		}
	}
	std::lock_guard<std::mutex> lk(g_iceMutex);
	g_iceRefreshing = false;
	if (!out.empty()) {
		g_iceCached = out;
		g_iceCachedUntil = parvane::nowUnix() + (ttl * 8) / 10; // как web: 0.8×TTL
		LOG(("Parvane: ICE-серверы получены: %1").arg(int(out.size())));
	}
}

} // namespace

void PrefetchIceServers() {
	{
		std::lock_guard<std::mutex> lk(g_iceMutex);
		if (g_iceRefreshing
			|| (!g_iceCached.empty() && parvane::nowUnix() < g_iceCachedUntil)) {
			return;
		}
		g_iceRefreshing = true;
	}
	crl::async([] { RefreshIceServers(); });
}

std::vector<IceServer> FetchIceServers() {
	// Просроченный кэш обновляем фоном к следующему звонку; этот берёт что есть.
	PrefetchIceServers();
	std::lock_guard<std::mutex> lk(g_iceMutex);
	return g_iceCached;
}

// ── Группы: переименование / удаление ────────────────────────────────────────
void RenameGroup(const QString &groupId, const QString &name) {
	if (RunV2GroupChange(u"group.rename %1"_q.arg(groupId), groupId, [nm = name.trimmed().toStdString()](const nlohmann::json &info) {
			return V2SetInfo(info, nm, std::nullopt, std::nullopt);
		}, nullptr)) {
		return;
	}
	const auto gid = groupId.toStdString();
	const auto nm = name.trimmed().toStdString();
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g = g_groupClient.get();
		}
		if (!g) {
			return;
		}
		try {
			const auto r = g->rename(token, gid, nm);
			LOG(("Parvane: group.rename %1 → %2").arg(QString::fromStdString(gid),
				r.ok ? u"ok"_q : QString::fromStdString(r.error.empty() ? std::string("ошибка") : r.error)));
		} catch (const std::exception &e) {
			LOG(("Parvane: group.rename ошибка: %1").arg(QString::fromUtf8(e.what())));
		}
		crl::on_main([] { RefreshGroups(); });
	});
}

void DeleteGroup(const QString &groupId) {
	if (RunV2GroupChange(u"group.delete %1"_q.arg(groupId), groupId, [](const nlohmann::json &) {
			return nlohmann::json{ { "delete_group", nlohmann::json::object() } };
		}, nullptr)) {
		return;
	}
	const auto gid = groupId.toStdString();
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::GroupClient *g = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g = g_groupClient.get();
		}
		if (!g) {
			return;
		}
		try {
			const auto r = g->remove(token, gid);
			LOG(("Parvane: group.delete %1 → %2").arg(QString::fromStdString(gid),
				r.ok ? u"ok"_q : QString::fromStdString(r.error.empty() ? std::string("ошибка") : r.error)));
		} catch (const std::exception &e) {
			LOG(("Parvane: group.delete ошибка: %1").arg(QString::fromUtf8(e.what())));
		}
		crl::on_main([] { RefreshGroups(); });
	});
}

// ── Авто-линковка истории (паритет web provider.ts / linking.ts) ─────────────
// Протокол v2 (P-03/P-48, правило LINK-1): новое устройство публикует
// обязательство на эфемерный ключ и свой signing-ключ; старое шлёт challenge
// своим эфемерным ключом; новое раскрывает ключ; SAS считается от ПАРЫ ключей
// (12 цифр); грант принимается только под ключ challenge; экспорт — без
// приватного Olm-аккаунта, с подписанным переносом владения исходящими.
namespace {

constexpr auto kLinkGrantPollMs = 5000;
constexpr auto kLinkOffersPollMs = 10000;
constexpr auto kLinkOfferLifetimeMs = 10 * 60 * 1000;

// Новое устройство: эфемерный ключ оффера (пока ждём грант). Под g_sessionMutex.
std::optional<parvane::linking::EphemeralKey> g_linkEph;
std::string g_linkCommitment;
std::string g_linkChallenge; // эфемерный ключ старого устройства (после challenge)
QString g_linkCode;
std::int64_t g_linkStartedMs = 0;
bool g_linkActive = false;
// Грант сервер отдаёт ОДИН раз в любом identity.link.poll — и в опросе чужих
// офферов тоже. Грант, пришедший туда, ждёт здесь ближайшего опроса своего
// оффера (иначе терялся: опрос офферов каждые 10 с съедал его раньше).
parvane::json g_linkPendingGrant;
// Старое устройство: свой эфемерный ключ на каждый challenge (device_id → ключ)
// и офферы, уже показанные пользователю (device_id → раскрытый eph_pub).
std::map<QString, parvane::linking::EphemeralKey> g_linkChallenges;
QHash<QString, QString> g_linkOffersShown;
bool g_linkOffersPolling = false;

[[nodiscard]] std::int64_t NowMs() {
	return QDateTime::currentMSecsSinceEpoch();
}

[[nodiscard]] bool HeadlessUi() {
	return std::getenv("QT_QPA_PLATFORM")
		&& QString::fromUtf8(std::getenv("QT_QPA_PLATFORM")) == u"offscreen"_q;
}

// ── LINK-1 п. 8 (spec 007, T138, SC-002): история v2-эпохи при линковке ────
// Сообщения v2 запечатаны под устройства, существовавшие при отправке: новому
// устройству сервер их не отдаст, а грант движка несёт только ключи. Старое
// устройство кладёт уже расшифрованные строки v2 в экспорт линковки (поле
// `v2History` рядом с decCache; формат строки — StoredMessage, общий с web
// `v2/linkHistory.ts`), новое применяет их как строки v2.
constexpr auto kV2HistoryLimit = std::size_t(20000);
constexpr auto kLinkedGroupRetryMs = crl::time(3000);
constexpr auto kLinkedGroupRetries = 40;

[[nodiscard]] bool V2HistoryRowOk(const nlohmann::json &row) {
	try {
		if (!row.is_object()
			|| !row.contains("content")
			|| !row["content"].is_object()
			|| row.value("id", std::string()).empty()
			|| row.value("from", std::string()).empty()
			|| row.value("to", std::string()).empty()
			|| !row.contains("ts")
			|| !row["ts"].is_number()) {
			return false;
		}
		if (row.contains("deleted") && row["deleted"].is_boolean() && row["deleted"].get<bool>()) {
			return false;
		}
		const auto &content = row["content"];
		const auto kind = content.value("kind", std::string());
		if (kind.empty() || kind == "encrypted" || kind == "group_encrypted") {
			return false;
		}
		return TtlFromContent(content) == 0; // эфемерное не переносится
	} catch (const std::exception &) {
		return false;
	}
}

// Строки v2 из журнала истории (с правками и реакциями из кэша v2) — для
// экспорта линковки и ручной копии ключей.
[[nodiscard]] nlohmann::json CollectV2HistoryRows() {
	LoadV2Ids();
	auto rows = nlohmann::json::array();
	auto seen = std::set<std::string>();
	for (const auto &line : StoreReadLines(HistoryPath())) {
		try {
			auto row = nlohmann::json::parse(line.toStdString());
			const auto id = row.value("id", std::string());
			if (id.empty() || !IsV2Message(id) || !seen.insert(id).second) {
				continue;
			}
			{
				std::lock_guard<std::mutex> lk(g_v2Mutex);
				const auto it = g_v2Cache.find(QString::fromStdString(id));
				if (it != g_v2Cache.end()) {
					row = it.value().toJson();
				}
			}
			if (!V2HistoryRowOk(row)) {
				continue;
			}
			for (const auto key : { "copies", "updated_at", "origin" }) {
				row.erase(key);
			}
			rows.push_back(std::move(row));
		} catch (const std::exception &) {
		}
	}
	if (rows.size() > kV2HistoryLimit) {
		rows.erase(rows.begin(), rows.begin() + (rows.size() - kV2HistoryLimit));
	}
	return rows;
}

// Старое устройство: экспорт линковки + история v2-эпохи.
[[nodiscard]] std::string WithV2History(const std::string &exported) {
	auto rows = CollectV2HistoryRows();
	if (rows.empty()) {
		return exported;
	}
	try {
		auto state = nlohmann::json::parse(exported);
		const auto count = int(rows.size());
		state["v2History"] = std::move(rows);
		LOG(("Parvane: линковка: в экспорт добавлена история v2 (%1 сообщений)").arg(count));
		return state.dump();
	} catch (const std::exception &) {
		return exported;
	}
}

// Новое устройство: применить привезённые строки. Строки групп v2 ждут, пока
// группа появится из журнала групп (иначе сообщение ушло бы в чат с «адресом»).
void ApplyLinkedV2History(std::vector<parvane::StoredMessage> rows, QString owner, int attempt) {
	crl::on_main([rows = std::move(rows), owner, attempt]() mutable {
		const auto session = g_sessionWeak.get();
		if (!session || SelfAddress() != owner) {
			return;
		}
		auto ready = std::vector<parvane::StoredMessage>();
		auto waiting = std::vector<parvane::StoredMessage>();
		for (auto &sm : rows) {
			const auto group = parvane::v2::isGroupAddress(sm.to);
			const auto known = [&] {
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				return g_knownGroups.contains(QString::fromStdString(sm.to));
			}();
			if (group && !known) {
				waiting.push_back(std::move(sm));
			} else {
				ready.push_back(std::move(sm));
			}
		}
		if (!ready.empty()) {
			LOG(("Parvane: линковка: история v2 перенесена (%1 сообщений)").arg(int(ready.size())));
			injectOnMain(session, ready, /*live=*/true);
		}
		if (waiting.empty() || attempt >= kLinkedGroupRetries) {
			return;
		}
		base::call_delayed(kLinkedGroupRetryMs, [waiting = std::move(waiting), owner, attempt]() mutable {
			ApplyLinkedV2History(std::move(waiting), owner, attempt + 1);
		});
	});
}

void ImportV2History(const std::string &stateJson) {
	auto out = std::vector<parvane::StoredMessage>();
	const auto owner = SelfAddress();
	const auto self = owner.toStdString();
	try {
		const auto state = nlohmann::json::parse(stateJson);
		if (!state.is_object() || !state.contains("v2History") || !state["v2History"].is_array()) {
			return;
		}
		LoadV2Ids();
		for (const auto &row : state["v2History"]) {
			if (out.size() >= kV2HistoryLimit) {
				break;
			}
			try {
				if (!V2HistoryRowOk(row)) {
					continue;
				}
				auto sm = parvane::StoredMessage::fromJson(row);
				if (sm.id.empty() || IsV2Message(sm.id)) {
					continue;
				}
				const auto chat = parvane::v2::isGroupAddress(sm.to)
					? sm.to
					: (sm.from == self) ? sm.to : sm.from;
				if (sm.from != self) {
					sm.read = true; // история, а не новые входящие
				}
				V2NoteMessage(sm, QString::fromStdString(chat));
				out.push_back(std::move(sm));
			} catch (const std::exception &) {
			}
		}
	} catch (const std::exception &) {
		return;
	}
	if (!out.empty()) {
		ApplyLinkedV2History(std::move(out), owner, 0);
	}
}

// Полный ресинк после импорта истории: курсоры в ноль → sync вернёт всё, что
// теперь читается (кэш + переносы владения), дедуп — по uuid.
void ResyncFromScratch() {
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_lastSeenId = parvane::MessengerClient::zeroCursor();
		g_sinceUpdated = 0;
	}
	SaveCursors(parvane::MessengerClient::zeroCursor(), 0);
	PumpReceive();
}

// Воркер: публикует оффер (identity.link.offer: commitment + signing_key, без
// ключа) и запускает опрос гранта.
void StartHistoryLinkOffer() {
	parvane::ITransport *t = nullptr;
	std::string token;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_transport.get();
		token = g_token.toStdString();
	}
	if (!t) {
		return;
	}
	auto eph = parvane::linking::EphemeralKey::generate();
	if (!eph) {
		return;
	}
	const auto commitment = parvane::linking::commitment(eph->publicB64());
	try {
		const auto raw = t->request(parvane::topics::IdentityLinkOffer,
			parvane::json{{"token", token}, {"device_id", parvane::e2e::deviceId()},
				{"commitment", commitment}, {"signing_key", parvane::e2e::signingKey()}}.dump(), 5000);
		if (!parvane::json::parse(raw, nullptr, false).value("ok", false)) {
			LOG(("Parvane: линковка: оффер отклонён"));
			return;
		}
	} catch (const std::exception &e) {
		LOG(("Parvane: линковка: оффер не опубликован: %1").arg(QString::fromUtf8(e.what())));
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_linkEph = std::move(eph);
		g_linkCommitment = commitment;
		g_linkPendingGrant = nullptr;
		g_linkChallenge.clear();
		g_linkCode.clear();
		g_linkStartedMs = NowMs();
		g_linkActive = true;
	}
	LOG(("Parvane: линковка: оффер (обязательство) опубликован"));
}

void RetractHistoryLinkOffer() {
	parvane::ITransport *t = nullptr;
	std::string token;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_transport.get();
		token = g_token.toStdString();
		g_linkActive = false;
		g_linkPendingGrant = nullptr;
		g_linkEph.reset();
		g_linkCommitment.clear();
		g_linkChallenge.clear();
		g_linkCode.clear();
	}
	if (!t) {
		return;
	}
	try {
		t->request(parvane::topics::IdentityLinkOffer,
			parvane::json{{"token", token}, {"device_id", parvane::e2e::deviceId()},
				{"revoke", true}}.dump(), 5000);
	} catch (const std::exception &) {
	}
}

// Воркер: один опрос гранта. true — линковка завершена (успех/стоп).
bool PollLinkGrantOnce() {
	parvane::ITransport *t = nullptr;
	std::string self, token, commitment, challenge;
	std::optional<parvane::linking::EphemeralKey> eph;
	std::int64_t started = 0;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (!g_linkActive) {
			return true;
		}
		t = g_transport.get();
		self = g_selfAddress.toStdString();
		token = g_token.toStdString();
		eph = g_linkEph;
		commitment = g_linkCommitment;
		challenge = g_linkChallenge;
		started = g_linkStartedMs;
	}
	if (!t || !eph) {
		return true;
	}
	if (NowMs() - started > kLinkOfferLifetimeMs) {
		LOG(("Parvane: линковка: оффер истёк (10 мин) — отзываю"));
		RetractHistoryLinkOffer();
		return true;
	}
	if (!parvane::e2e::needsHistoryLink(DecCacheEmpty()) && !V2NeedsLinking()) {
		LOG(("Parvane: линковка: история появилась сама — отзываю оффер"));
		RetractHistoryLinkOffer();
		return true;
	}
	parvane::json grant;
	std::string newChallenge;
	try {
		const auto raw = t->request(parvane::topics::IdentityLinkPoll,
			parvane::json{{"token", token}, {"device_id", parvane::e2e::deviceId()}}.dump(), 5000);
		const auto resp = parvane::json::parse(raw, nullptr, false);
		if (!resp.is_object() || !resp.value("ok", false)) {
			return false;
		}
		newChallenge = resp.value("challenge", std::string());
		if (resp.contains("grant") && resp["grant"].is_object()) {
			grant = resp["grant"];
		} else {
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (g_linkPendingGrant.is_object()) {
				grant = g_linkPendingGrant;
			}
		}
	} catch (const std::exception &) {
		return false;
	}
	// Challenge пришёл — раскрываем ключ (сервер сверяет с обязательством) и
	// показываем SAS от пары ключей. Фиксируется первый challenge.
	if (challenge.empty() && !newChallenge.empty()) {
		try {
			const auto raw = t->request(parvane::topics::IdentityLinkOffer,
				parvane::json{{"token", token}, {"device_id", parvane::e2e::deviceId()},
					{"eph_pub", eph->publicB64()}, {"commitment", commitment},
					{"signing_key", parvane::e2e::signingKey()}}.dump(), 5000);
			if (!parvane::json::parse(raw, nullptr, false).value("ok", false)) {
				LOG(("Parvane: линковка: раскрытие ключа отклонено"));
				return false;
			}
		} catch (const std::exception &) {
			return false;
		}
		const auto code = QString::fromStdString(
			parvane::linking::sasCodeV2(eph->publicB64(), newChallenge));
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (!g_linkActive) {
				return true;
			}
			g_linkChallenge = newChallenge;
			g_linkCode = code;
		}
		challenge = newChallenge;
		LOG(("Parvane: линковка: ключ раскрыт, код сверки готов"));
#ifdef PARVANE_DEV
		// Только dev-сборка: headless e2e сверяет код по логу.
		LOG(("Parvane: линковка (dev): код сверки %1").arg(code));
#endif
		crl::on_main([code] {
			if (HeadlessUi()) {
				return; // headless e2e — без боксов
			}
			Ui::show(Ui::MakeInformBox(
				u"Перенос истории: сверьте код на другом устройстве (Настройки → Устройства) и подтвердите там.\nКод: %1"_q.arg(code)));
		});
	}
	if (grant.is_null()) {
		return false;
	}
	if (challenge.empty() || grant.value("eph_pub", std::string()) != challenge) {
		// Грант не под тот ключ, с которым считался SAS: гонка двух старых
		// устройств или подмена — игнорируем.
		LOG(("Parvane: линковка: грант под чужой эфемерный ключ — отклонён"));
		return false;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_linkActive = false;
	}
	const auto plain = eph->open(grant.value("eph_pub", std::string()),
		grant.value("box_payload", std::string()));
	if (!plain) {
		LOG(("Parvane: линковка: бокс не расшифровался (чужой эфемерный ключ?)"));
		return true;
	}
	const auto box = parvane::json::parse(*plain, nullptr, false);
	if (!box.is_object()) {
		return true;
	}
	// LINK-1 v2: материал гранта движка (SSK, журнал устройств, ключ доставки,
	// ключ личного состояния) лежит отдельным блобом — как web joinV2WithLinkGrant.
	if (box.contains("v2") && box["v2"].is_object()) {
		if (const auto s = V2AwaitNeedsLinking()) {
			try {
				const auto &coords = box["v2"];
				parvane::CloudClient cloud(*t);
				auto d = DownloadChatBlob(cloud, self, token, coords.value("file_id", std::string()), 30000);
				auto material = d.ok
					? parvane::blobcrypt::decrypt(d.bytes,
						coords.value("file_key", std::string()),
						coords.value("file_nonce", std::string()))
					: std::nullopt;
				if (material) {
					LOG(("Parvane: линковка: грант v2 получен — устройство вступает в журнал устройств"));
					s->joinWithGrant(std::move(*material));
				} else {
					LOG(("Parvane: линковка: грант v2 не скачался или не расшифровался"));
				}
			} catch (const std::exception &e) {
				LOG(("Parvane: линковка: грант v2: %1").arg(QString::fromUtf8(e.what())));
			}
		}
	}
	std::string stateJson;
	try {
		parvane::CloudClient cloud(*t);
		auto d = DownloadChatBlob(cloud, self, token, box.value("file_id", std::string()), 30000);
		if (!d.ok) {
			LOG(("Parvane: линковка: экспорт не скачался из cloud: %1")
				.arg(QString::fromStdString(d.error)));
			return true;
		}
		const auto dec = parvane::blobcrypt::decrypt(d.bytes,
			box.value("file_key", std::string()), box.value("file_nonce", std::string()));
		if (!dec) {
			LOG(("Parvane: линковка: экспорт не расшифровался"));
			return true;
		}
		stateJson = *dec;
	} catch (const std::exception &e) {
		LOG(("Parvane: линковка: скачивание: %1").arg(QString::fromUtf8(e.what())));
		return true;
	}
	std::pair<std::string, std::string> transfer;
	if (box.contains("transfer") && box["transfer"].is_object()) {
		transfer = {box["transfer"].value("old_signing_key", std::string()),
			box["transfer"].value("signature", std::string())};
	}
	int merged = 0;
	const auto ok = parvane::e2e::importLinkedHistory(stateJson,
		[&](const std::string &uuid, const nlohmann::json &inner) {
			const auto q = QString::fromStdString(uuid);
			if (!DecCacheGet(q).isEmpty() || !inner.is_object()) {
				return;
			}
			auto entry = inner;
			if (entry.contains("senderIdentity")) {
				entry["sender_identity"] = entry["senderIdentity"];
				entry.erase("senderIdentity");
			}
			DecCachePut(q, QString::fromStdString(entry.dump()));
			++merged;
		}, transfer);
	if (!ok) {
		LOG(("Parvane: линковка: импорт не удался"));
		return true;
	}
	LOG(("Parvane: линковка: история получена и импортирована (%1 сообщений в кэше)")
		.arg(merged));
	ResyncFromScratch();
	ImportV2History(stateJson); // LINK-1 п. 8: история v2-эпохи
	return true;
}

void ScheduleLinkGrantPoll() {
	crl::on_main([] {
		base::call_delayed(kLinkGrantPollMs, [] {
			crl::async([] {
				if (!PollLinkGrantOnce()) {
					ScheduleLinkGrantPoll();
				}
			});
		});
	});
}

// Воркер (старое устройство): выдать грант устройству deviceId с раскрытым
// ключом ephPub — экспорт БЕЗ приватного материала → blobcrypt → cloud
// (owner-only) → ECDH-бокс (с подписанным переносом владения) → link.grant.
void GrantLink(const QString &deviceId, const QString &ephPub, const QString &signingKey) {
	parvane::ITransport *t = nullptr;
	std::string self, token;
	std::optional<parvane::linking::EphemeralKey> own;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_transport.get();
		self = g_selfAddress.toStdString();
		token = g_token.toStdString();
		if (const auto it = g_linkChallenges.find(deviceId); it != g_linkChallenges.end()) {
			own = it->second;
		}
	}
	if (!t || !own) {
		LOG(("Parvane: линковка: нет своего challenge для устройства %1").arg(deviceId));
		return;
	}
	try {
		auto exported = parvane::e2e::exportLinkStateJson(DecCacheSnapshot());
		if (exported.empty()) {
			return;
		}
		exported = WithV2History(exported); // LINK-1 п. 8
		auto enc = parvane::blobcrypt::encrypt(exported);
		parvane::CloudClient cloud(*t);
		const auto fileId = cloud.upload(self, token, "link-transfer",
			"application/octet-stream", enc.ciphertext, {}, false, 192 * 1024, 30000);
		parvane::json boxPlain = {{"file_id", fileId},
			{"file_key", enc.keyB64}, {"file_nonce", enc.nonceB64}};
		if (!signingKey.isEmpty()) {
			const auto tr = parvane::e2e::signLinkTransfer(self, signingKey.toStdString());
			if (!tr.second.empty()) {
				boxPlain["transfer"] = {{"old_signing_key", tr.first}, {"signature", tr.second}};
			}
		}
		// LINK-1 v2: грант движка — вторым блобом (бокс ограничен 8 КБ).
		if (const auto s = V2Ready()) {
			auto material = s->linkGrantMaterial();
			if (!material.empty()) {
				auto encV2 = parvane::blobcrypt::encrypt(material);
				std::fill(material.begin(), material.end(), '\0');
				const auto v2File = cloud.upload(self, token, "link-grant-v2",
					"application/octet-stream", encV2.ciphertext, {}, false, 192 * 1024, 30000);
				boxPlain["v2"] = {{"file_id", v2File},
					{"file_key", encV2.keyB64}, {"file_nonce", encV2.nonceB64}};
				LOG(("Parvane: линковка: грант v2 приложен"));
			}
		}
		const auto box = own->seal(ephPub.toStdString(), boxPlain.dump());
		if (!box) {
			return;
		}
		const auto raw = t->request(parvane::topics::IdentityLinkGrant,
			parvane::json{{"token", token}, {"device_id", deviceId.toStdString()},
				{"box_payload", *box}, {"eph_pub", own->publicB64()}}.dump(), 5000);
		const auto resp = parvane::json::parse(raw, nullptr, false);
		if (resp.value("ok", false)) {
			LOG(("Parvane: линковка: грант выдан устройству %1").arg(deviceId));
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g_linkChallenges.erase(deviceId);
		} else {
			LOG(("Parvane: линковка: грант не удался: %1")
				.arg(QString::fromStdString(resp.value("error", std::string("?")))));
		}
	} catch (const std::exception &e) {
		LOG(("Parvane: линковка: грант не удался: %1").arg(QString::fromUtf8(e.what())));
	}
}

// Воркер (старое устройство): опрос чужих офферов → challenge → после
// раскрытия ключа подтверждение с SAS-кодом. Legacy-офферы v1 (без
// обязательства) не обслуживаются.
void PollLinkOffersOnce() {
	parvane::ITransport *t = nullptr;
	std::string token;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_transport.get();
		token = g_token.toStdString();
	}
	if (!t) {
		return;
	}
	parvane::json offers;
	try {
		const auto raw = t->request(parvane::topics::IdentityLinkPoll,
			parvane::json{{"token", token}, {"device_id", parvane::e2e::deviceId()}}.dump(), 5000);
		const auto resp = parvane::json::parse(raw, nullptr, false);
		if (resp.is_object() && resp.value("ok", false)
			&& resp.contains("grant") && resp["grant"].is_object()) {
			// Свой грант пришёл в опросе чужих офферов — оставляем опросу своего оффера.
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (g_linkActive) {
				g_linkPendingGrant = resp["grant"];
			}
		}
		if (!resp.is_object() || !resp.value("ok", false) || !resp.contains("offers")) {
			return;
		}
		offers = resp["offers"];
	} catch (const std::exception &) {
		return;
	}
	if (!offers.is_array()) {
		return;
	}
	// Ключи challenge для исчезнувших офферов больше не нужны.
	{
		std::set<QString> live;
		for (const auto &o : offers) {
			if (o.is_object()) {
				live.insert(QString::fromStdString(o.value("device_id", std::string())));
			}
		}
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		for (auto it = g_linkChallenges.begin(); it != g_linkChallenges.end();) {
			it = live.count(it->first) ? std::next(it) : g_linkChallenges.erase(it);
		}
	}
	for (const auto &o : offers) {
		if (!o.is_object()) {
			continue;
		}
		const auto dev = QString::fromStdString(o.value("device_id", std::string()));
		const auto eph = QString::fromStdString(o.value("eph_pub", std::string()));
		const auto commitment = o.value("commitment", std::string());
		const auto challengePub = o.value("challenge_pub", std::string());
		const auto signingKey = QString::fromStdString(o.value("signing_key", std::string()));
		if (dev.isEmpty() || commitment.empty()) {
			continue;
		}
		std::optional<parvane::linking::EphemeralKey> own;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (const auto it = g_linkChallenges.find(dev); it != g_linkChallenges.end()) {
				own = it->second;
			}
		}
		if (!own && !challengePub.empty()) {
			continue; // challenge выставило другое наше устройство
		}
		if (!own || challengePub.empty()) {
			// Нет challenge (или новое устройство переофферило — сервер его
			// сбросил): шлём свой ключ; при повторе — тот же (идемпотентно).
			auto key = own ? own : parvane::linking::EphemeralKey::generate();
			if (!key) {
				continue;
			}
			try {
				const auto raw = t->request(parvane::topics::IdentityLinkChallenge,
					parvane::json{{"token", token}, {"device_id", dev.toStdString()},
						{"eph_pub", key->publicB64()}}.dump(), 5000);
				if (!parvane::json::parse(raw, nullptr, false).value("ok", false)) {
					continue;
				}
			} catch (const std::exception &) {
				continue;
			}
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			g_linkChallenges.insert_or_assign(dev, *key);
			continue;
		}
		if (challengePub != own->publicB64() || eph.isEmpty()) {
			continue; // ждём раскрытия ключа (или это чужой challenge)
		}
		if (!parvane::linking::commitmentMatches(eph.toStdString(), commitment)) {
			LOG(("Parvane: линковка: ключ оффера %1 не соответствует обязательству").arg(dev));
			continue;
		}
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			if (g_linkOffersShown.value(dev) == eph) {
				continue;
			}
			g_linkOffersShown.insert(dev, eph);
		}
		const auto code = QString::fromStdString(
			parvane::linking::sasCodeV2(eph.toStdString(), own->publicB64()));
		LOG(("Parvane: линковка: запрос переноса истории от устройства %1, код готов").arg(dev));
#ifdef PARVANE_DEV
		// Только dev-сборка: headless e2e сверяет код с кодом нового устройства.
		LOG(("Parvane: линковка (dev): код сверки %1 для устройства %2").arg(code, dev));
#endif
		// Headless e2e: PARVANE_AUTOLINK_GRANT=1 — подтверждать без UI (только dev-сборка).
		if (const char *ag = ParvaneDevEnv("PARVANE_AUTOLINK_GRANT"); ag && *ag) {
			GrantLink(dev, eph, signingKey);
			continue;
		}
		crl::on_main([dev, eph, signingKey, code] {
			Ui::show(Ui::MakeConfirmBox({
				.text = u"Новое устройство запрашивает перенос истории.\nСверьте код — он должен совпадать с кодом на новом устройстве:\n%1\nПередать историю?"_q.arg(code),
				.confirmed = [dev, eph, signingKey](Fn<void()> &&close) {
					crl::async([dev, eph, signingKey] { GrantLink(dev, eph, signingKey); });
					close();
				},
				.confirmText = u"Передать"_q,
			}));
		});
	}
}

void ScheduleLinkOffersPoll() {
	crl::on_main([] {
		base::call_delayed(kLinkOffersPollMs, [] {
			if (!SessionActive()) {
				return;
			}
			crl::async([] {
				PollLinkOffersOnce();
				ScheduleLinkOffersPoll();
			});
		});
	});
}

} // namespace

// ── Резервная копия ключей (PARITY «ДЫРА: нет резервной копии ключей») ──────
// Формат веб-клиента (keybackup.h), файл годится для переноса между клиентами.
// Блокирующие — звать с воркера (crl::async).
[[nodiscard]] QString BackupMarkerPath() {
	return cWorkingDir() + u"tdata/parvane-backup-done"_q;
}

bool KeyBackupDone() {
	return QFile::exists(BackupMarkerPath());
}

bool ExportKeyBackup(const QString &path, const QString &password, QString *error) {
	if (!parvane::e2e::ready()) {
		*error = u"Ключи ещё не готовы — подождите несколько секунд после входа"_q;
		return false;
	}
	auto state = parvane::e2e::exportStateJson(DecCacheSnapshot());
	if (state.empty()) {
		*error = u"Нечего сохранять"_q;
		return false;
	}
	// T152: копия несёт устройство v2 и историю v2-эпохи (поле `extra`, как в
	// вебе) — сервер v2 историю заново не отдаст
	if (const auto s = V2Ready()) {
		try {
			auto extra = nlohmann::json::object();
			if (auto device = s->deviceBackup(); device.is_object()) {
				extra["v2"] = std::move(device);
			}
			if (auto rows = CollectV2HistoryRows(); !rows.empty()) {
				LOG(("Parvane: копия ключей: история v2 (%1 сообщений)").arg(int(rows.size())));
				extra["v2History"] = std::move(rows);
			}
			if (!extra.empty()) {
				auto parsed = nlohmann::json::parse(state);
				parsed["extra"] = std::move(extra);
				state = parsed.dump();
			}
		} catch (const std::exception &) {
		}
	}
	const auto file = parvane::keybackup::exportEncrypted(state, password.toStdString());
	if (file.empty()) {
		*error = u"Не удалось зашифровать копию"_q;
		return false;
	}
	auto f = QFile(path);
	if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)
		|| f.write(file.data(), qint64(file.size())) != qint64(file.size())) {
		*error = u"Не удалось записать файл"_q;
		return false;
	}
	auto marker = QFile(BackupMarkerPath());
	if (marker.open(QIODevice::WriteOnly)) {
		marker.write("1");
	}
	LOG(("Parvane: копия ключей сохранена (%1 байт)").arg(qint64(file.size())));
	return true;
}

bool ImportKeyBackup(const QString &path, const QString &password, QString *error) {
	if (!parvane::e2e::ready()) {
		*error = u"Ключи ещё не готовы — подождите несколько секунд после входа"_q;
		return false;
	}
	auto f = QFile(path);
	if (!f.open(QIODevice::ReadOnly)) {
		*error = u"Не удалось прочитать файл"_q;
		return false;
	}
	const auto state = parvane::keybackup::importEncrypted(
		f.readAll().toStdString(), password.toStdString());
	if (!state) {
		*error = u"Неверный пароль или повреждённый файл"_q;
		return false;
	}
	// СЛИЯНИЕ, как при линковке: расшифрованная история + входящие Megolm +
	// прежний аккаунт как legacy-подписант; своя identity сохраняется.
	int merged = 0;
	const auto ok = parvane::e2e::importLinkedHistory(*state,
		[&](const std::string &uuid, const nlohmann::json &inner) {
			const auto q = QString::fromStdString(uuid);
			if (!DecCacheGet(q).isEmpty() || !inner.is_object()) {
				return;
			}
			auto entry = inner;
			if (entry.contains("senderIdentity")) {
				entry["sender_identity"] = entry["senderIdentity"];
				entry.erase("senderIdentity");
			}
			DecCachePut(q, QString::fromStdString(entry.dump()));
			++merged;
		});
	if (!ok) {
		*error = u"Копия не подошла к этому аккаунту"_q;
		return false;
	}
	LOG(("Parvane: копия ключей восстановлена, слито %1 сообщений — ресинк").arg(merged));
	ResyncFromScratch();
	// T152: история v2-эпохи из копии. Устройство v2 копии (`extra.v2`) десктоп
	// не перенимает: копия здесь сливается, своя личность устройства сохраняется;
	// в журнал устройств оно входит линковкой или ключом восстановления.
	try {
		const auto parsed = nlohmann::json::parse(*state);
		if (const auto it = parsed.find("extra"); it != parsed.end() && it->is_object()
			&& it->contains("v2History") && V2Enabled()) {
			ImportV2History(nlohmann::json{ { "v2History", (*it)["v2History"] } }.dump());
		}
	} catch (const std::exception &) {
	}
	return true;
}

// Воркер: сессии v2 нужен грант линковки (событие `needsLinking`) — оффер
// публикуется, даже если история v1 на устройстве уже есть.
void StartDeviceLinkOfferForV2() {
	if (std::getenv("PARVANE_NO_LINK_OFFER")) {
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		if (g_linkActive) {
			return;
		}
	}
	LOG(("Parvane: линковка: журнал устройств v2 уже есть — публикую оффер"));
	StartHistoryLinkOffer();
	bool active = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		active = g_linkActive;
	}
	if (active) {
		ScheduleLinkGrantPoll();
	}
}

// Воркер, после initDevice: новое устройство без истории публикует оффер и
// ждёт грант; любое устройство опрашивает чужие офферы (роль «старого»).
void StartHistoryLinking() {
	bool offered = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		offered = g_linkActive; // оффер уже опубликован по событию v2 `needsLinking`
	}
	if (!offered && parvane::e2e::needsHistoryLink(DecCacheEmpty())
		&& !std::getenv("PARVANE_NO_LINK_OFFER")) {
		StartHistoryLinkOffer();
		bool active = false;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			active = g_linkActive;
		}
		if (active) {
			ScheduleLinkGrantPoll();
		}
	}
	bool start = false;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		start = !g_linkOffersPolling;
		g_linkOffersPolling = true;
	}
	if (start) {
		PollLinkOffersOnce();
		ScheduleLinkOffersPoll();
	}
}

// Код линковки (новое устройство, пока ждём грант); пусто — не ждём или
// старое устройство ещё не прислало challenge (v2: код появляется после него).
QString HistoryLinkCode() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_linkActive ? g_linkCode : QString();
}

} // namespace Parvane
