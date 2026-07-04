// Parvane fork: см. parvane_client.h.
#include "parvane/parvane_client.h"

#include "base/debug_log.h"
#include "base/weak_ptr.h"
#include "base/timer.h"
#include "main/main_session.h"
#include "data/data_session.h"
#include "data/data_user.h"
#include "data/data_document.h"
#include "data/data_photo.h"
#include "data/data_types.h"
#include "data/data_msg_id.h"      // IsClientMsgId
#include "data/data_peer_id.h"
#include "core/file_location.h"
#include "base/unixtime.h"
#include "ui/image/image_location_factory.h" // Images::FromImageInMemory
#include "storage/storage_facade.h"
#include "storage/storage_shared_media.h"
#include "data/data_send_action.h"
#include "data/data_lastseen_status.h"
#include "data/data_changes.h"
#include "data/data_histories.h"
#include "base/call_delayed.h"
#include <QtCore/QQueue>
#include <QtCore/QSet>
#include <QtCore/QBuffer>
#include "history/history.h"
#include "history/history_item.h"
#include "dialogs/dialogs_main_list.h"
#include "apiwrap.h"
#include "api/api_common.h"
#include "storage/localimageloader.h" // FilePrepareResult, SendMediaType

#include <parvane/events.h>          // parvane-core
#include <parvane/topics.h>          // parvane-core
#include <parvane/transport.h>       // parvane-core
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
#include "boxes/abstract_box.h"      // Ui::show() — бокс входящего звонка
#include "ui/boxes/confirm_box.h"    // Ui::MakeConfirmBox
#include "settings.h"                // cWorkingDir() — путь для ключа звонков

#include <QtCore/QFile>
#include <QtCore/QDir>
#include <QtGui/QImage>

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>
#include <rpl/lifetime.h>
#include <rpl/producer.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace Parvane {
namespace {

// Состояние процесса. g_sessionMutex охраняет транспорт/мессенджер и реестр.
std::mutex g_sessionMutex;
QString g_token;
QString g_selfAddress;
std::unique_ptr<parvane::Transport> g_transport;
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
QHash<quint64, QString> g_chatIdToGroupId;
// Участники групп (адреса) — для инициации группового звонка. Под g_sessionMutex.
QHash<QString, QStringList> g_groupMembers;
// Текущий собеседник по звонку (для панели активного звонка). Под g_sessionMutex.
// НЕ читать через g_callManager->peer() из onState — там уже держится мьютекс
// менеджера (дедлок). Пишем при placeCall/incoming, читаем в onState.
QString g_currentCallPeer;
// UUID сообщений, которые ОТПРАВИЛИ мы сами в этой сессии — чтобы на sync НЕ
// задваивать (у них уже есть локальное эхо). Свои сообщения ВНЕ этого набора
// (из прошлой сессии) восстанавливаем как исходящие. Под g_sessionMutex.
std::set<std::string> g_ownSentUuids;

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
QSet<QString> g_resolveRequested;       // адреса, для которых уже запросили имя
QHash<QString, QString> g_avatarFileIds; // адрес → file_id аватара (cloud)
QSet<QString> g_avatarDownloaded;        // аватары, уже скачанные/в процессе
QHash<QString, QImage> g_avatarImages;   // адрес → скачанная картинка (кэш для
                                         // повторной установки: ensurePeerUser с
                                         // пустым фото стирает userpic).
QHash<qint64, QString> g_mediaContentByMsgId; // msgId → content JSON (для forward)
qint64 g_nextMsgId = 1;               // серверный диапазон (0 < id < 2^56)
std::unique_ptr<base::Timer> g_pumpTimer; // периодический sync (main-поток)
rpl::lifetime g_finalizeLifetime;         // подписка newItemAdded (main-поток)
bool g_finalizeHooked = false;
bool g_typingSubscribed = false;          // подписка на msg.typing.<self> (once)
FullMsgId g_lastOwnFullId;                 // последнее своё исходящее (debug-хуки)
bool g_presenceSubscribed = false;        // подписка на presence.* (once)
std::unique_ptr<base::Timer> g_presenceTimer; // хартбит присутствия (main)

constexpr auto kPumpIntervalMs = crl::time(3000);

// Публикует текст в шину с воркер-потока (не блокирует UI).
void sendTextAsync(
		const QString &toAddress,
		const QString &text,
		const std::string &preId,
		const std::optional<std::string> &replyToUuid = std::nullopt) {
	const auto from = SelfAddress().toStdString();
	const auto to = toAddress.toStdString();
	const auto body = text.toStdString();
	const auto token = Token().toStdString();
	crl::async([=] {
		parvane::MessengerClient *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
		}
		if (!m) {
			LOG(("Parvane: sendText без активной сессии — пропуск"));
			return;
		}
		try {
			const auto id = m->sendText(from, to, body, token,
				replyToUuid, preId);
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_ownSentUuids.insert(id);
			}
			LOG(("Parvane: отправлено msg %1 → %2")
				.arg(QString::fromStdString(id))
				.arg(QString::fromStdString(to)));
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
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
		}
		if (!m) {
			return;
		}
		try {
			const auto content = parvane::json::parse(contentJson);
			const auto id = m->sendContent(from, to, content, token);
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

} // namespace

QString NatsUrl() {
	if (const char *v = std::getenv("PARVANE_NATS_URL"); v && *v) {
		return QString::fromUtf8(v);
	}
	return u"nats://127.0.0.1:4222"_q;
}

void LogStartup() {
	// Конструирование parvane::Transport заставляет линкер втянуть cnats.
	parvane::Transport transport;
	LOG(("Parvane: transport linked, NATS target %1 (connected=%2)")
		.arg(NatsUrl())
		.arg(transport.connected() ? 1 : 0));
}

IssueResult Issue(const QString &user, const QString &password) {
	IssueResult out;
	try {
		parvane::Transport transport;
		transport.connect(NatsUrl().toStdString());

		parvane::IssueRequest req{user.toStdString(), password.toStdString()};
		const auto raw = transport.request(
			parvane::topics::IdentityIssue,
			req.toJson().dump(),
			5000);
		const auto resp = parvane::IssueResponse::fromJson(
			parvane::json::parse(raw));
		out.ok = resp.ok && resp.token.has_value();
		if (resp.token) {
			out.token = QString::fromStdString(*resp.token);
		}
		if (resp.error) {
			out.error = QString::fromStdString(*resp.error);
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

void SetToken(const QString &token) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	g_token = token;
}

QString Token() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_token;
}

// ── identity/peer ────────────────────────────────────────────────────────────
std::uint64_t IdForAddress(const QString &address) {
	const auto utf8 = address.toUtf8();
	std::uint64_t h = 1469598103934665603ULL; // FNV offset basis
	for (const auto c : utf8) {
		h ^= static_cast<unsigned char>(c);
		h *= 1099511628211ULL; // FNV prime
	}
	h &= ((std::uint64_t(1) << 48) - 1); // в безопасный диапазон id
	return h ? h : 1;
}

void RegisterPeer(const QString &address) {
	if (address.isEmpty()) {
		return;
	}
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	g_idToAddress.insert(quint64(IdForAddress(address)), address);
}

QString AddressForId(std::uint64_t userId) {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	return g_idToAddress.value(quint64(userId));
}

// ── сессия ───────────────────────────────────────────────────────────────────
void SetSelf(const QString &address, const QString &token) {
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_selfAddress = address;
		g_token = token;
	}
	RegisterPeer(address);
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

// Публикует наш публичный ключ звонков в каталоге identity (identity.user.setkey),
// чтобы собеседник мог проверять подпись SDP. Неблокирующая (worker). Значения
// передаются аргументами (НЕ лочим g_sessionMutex: зовётся из StartSession,
// который его уже держит — иначе дедлок).
void RegisterCallKey(const QString &pub, const QString &token) {
	if (pub.isEmpty() || token.isEmpty()) {
		return;
	}
	const auto req = parvane::json{
		{ "token", token.toStdString() },
		{ "pubkey", pub.toStdString() } }.dump();
	crl::async([req, pub] {
		parvane::Transport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		try {
			t->request("identity.user.setkey", req, 3000);
			LOG(("Parvane: зарегистрирован ключ звонков %1…")
				.arg(pub.left(12)));
		} catch (const std::exception &) {
		}
	});
}

bool StartSession() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	if (g_messenger) {
		return true; // идемпотентно
	}
	try {
		auto transport = std::make_unique<parvane::Transport>();
		transport->connect(NatsUrl().toStdString());
		auto messenger = std::make_unique<parvane::MessengerClient>(*transport);
		// delivered = ack/«что-то изменилось» → триггерим цикл приёма (Фаза 3c).
		messenger->onDelivered([](std::string id) {
			LOG(("Parvane: delivered %1 → pump").arg(QString::fromStdString(id)));
			PumpReceive();
		});
		g_transport = std::move(transport);
		g_messenger = std::move(messenger);

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
		// Входящий звонок (прошёл аутентификацию). Пока — лог + опц. авто-приём
		// (headless e2e). UI-панель — Э4-b2. НЕ звать accept() синхронно (дедлок
		// мьютекса менеджера) — откладываем на main.
		ccb.onIncoming = [](std::string peer, std::string media) {
			LOG(("Parvane: ВХОДЯЩИЙ звонок от %1 (%2)")
				.arg(QString::fromStdString(peer), QString::fromStdString(media)));
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_currentCallPeer = QString::fromStdString(peer);
			}
			// Авто-приём (e2e) без UI.
			if (const char *aa = std::getenv("PARVANE_AUTOACCEPT"); aa && *aa) {
				crl::on_main([] { if (g_callManager) g_callManager->accept(); });
				return;
			}
			// UI: бокс «принять/отклонить» на main-потоке.
			const auto peerQ = QString::fromStdString(peer);
			crl::on_main([peerQ] {
				Ui::show(Ui::MakeConfirmBox({
					.text = u"Входящий звонок от "_q + peerQ,
					.confirmed = [](Fn<void()> &&close) { AcceptCall(); close(); },
					.cancelled = [](Fn<void()> &&close) { HangupCall(); close(); },
					.confirmText = u"Принять"_q,
					.cancelText = u"Отклонить"_q,
				}));
			});
		};
		ccb.onState = [](parvane::CallState s) {
			LOG(("Parvane: звонок → %1").arg(CallStateName(s)));
			// UI активного звонка: показываем панель с «Завершить» на время
			// звонка, закрываем при Ended. peer — из g_currentCallPeer (НЕ через
			// g_callManager->peer(): его мьютекс уже держится в onState → дедлок).
			QString peer;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				peer = g_currentCallPeer;
			}
			crl::on_main([s, peer] {
				static bool boxShown = false;
				const auto inCall = (s == parvane::CallState::Outgoing
					|| s == parvane::CallState::Connecting
					|| s == parvane::CallState::Active);
				if (inCall && !boxShown) {
					boxShown = true;
					Ui::show(Ui::MakeConfirmBox({
						.text = (peer.isEmpty()
							? u"Идёт звонок…"_q
							: u"Звонок с "_q + peer),
						.confirmed = [](Fn<void()> &&close) {
							HangupCall();
							close();
						},
						.confirmText = u"Завершить"_q,
						.inform = true,
					}));
				} else if (s == parvane::CallState::Ended && boxShown) {
					boxShown = false;
					Ui::hideLayer();
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
		gcb.onPeerState = [](std::string peer, parvane::CallState s) {
			LOG(("Parvane: groupcall %1 → %2")
				.arg(QString::fromStdString(peer)).arg(CallStateName(s)));
		};
		g_groupCallManager = std::make_unique<parvane::GroupCallManager>(
			*g_callClient, g_selfAddress.toStdString(), g_token.toStdString(),
			g_callKey.get(), makeBackend, std::move(gcb));
		g_groupCallManager->start();

		RegisterCallKey(QString::fromStdString(g_callKey->publicB64()), g_token);

		LOG(("Parvane: сессия поднята для %1").arg(g_selfAddress));
		return true;
	} catch (const std::exception &e) {
		LOG(("Parvane: StartSession не удался: %1").arg(QString::fromUtf8(e.what())));
		return false;
	}
}

void StopSession() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	g_messenger.reset();
	g_transport.reset();
}

void MirrorOutgoing(PeerData *peer, const QString &text, std::int64_t replyToMsgId) {
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
	sendTextAsync(address, text, preId, replyToUuid);
}

void MirrorForward(PeerData *toPeer, not_null<HistoryItem*> item) {
	if (!toPeer || !toPeer->isUser()) {
		return;
	}
	const auto bare = std::uint64_t(peerToUser(toPeer->id).bare);
	const auto address = AddressForId(bare);
	if (address.isEmpty()) {
		return;
	}
	// Медиа — пересылаем сохранённый content (блоб уже в cloud, без пере-загрузки).
	const auto found = g_mediaContentByMsgId.constFind(item->id.bare);
	if (item->media() && found != g_mediaContentByMsgId.constEnd()) {
		sendContentAsync(address, found.value().toStdString());
		return;
	}
	const auto text = item->originalText().text;
	if (!text.isEmpty()) {
		MirrorOutgoing(toPeer, text);
	}
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
			m->react(from, uuid, emojiStd, token);
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
			m->pin(from, uuid, pin, token);
		} catch (const std::exception &) {
		}
	});
}

void MirrorTyping(PeerData *peer) {
	if (!peer || !peer->isUser()) {
		return;
	}
	const auto bare = std::uint64_t(peerToUser(peer->id).bare);
	const auto address = AddressForId(bare);
	if (address.isEmpty()) {
		return;
	}
	// Эфемерно (fire-and-forget) на msg.typing.<id получателя>; шард не нужен.
	// id пира == IdForAddress(address) (реестр), поэтому берём bare.
	const auto self = SelfAddress().toStdString();
	const auto to = address.toStdString();
	const auto id = bare;
	crl::async([=] {
		parvane::Transport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		const parvane::json ev{ { "from", self }, { "to", to } };
		try {
			t->publish("msg.typing." + std::to_string(id), ev.dump());
		} catch (const std::exception &) {
		}
	});
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
			m->deleteMessage(from, uuid, token);
			LOG(("Parvane: удаление своего msg %1").arg(QString::fromStdString(uuid)));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка удаления: %1").arg(QString::fromUtf8(e.what())));
		}
	});
}

void MirrorEdit(std::int64_t msgId, const QString &newText) {
	// Правим текст только СВОИХ сообщений (шард проверяет автора). uuid — по
	// обратной карте; неизвестное — no-op.
	const auto it = g_msgIdToUuid.find(msgId);
	if (it == g_msgIdToUuid.end()) {
		return;
	}
	const auto uuid = it.value().toStdString();
	const auto from = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto text = newText.toStdString();
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
			m->editText(from, uuid, text, token);
			LOG(("Parvane: правка своего msg %1").arg(QString::fromStdString(uuid)));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка правки: %1").arg(QString::fromUtf8(e.what())));
		}
	});
}

void MirrorRead(std::int64_t peerId) {
	// Отмечаем прочитанными все непрочитанные входящие от пира (msg.chat.read →
	// у отправителя ✓✓). Собираем uuid'ы и чистим, чтобы не слать повторно.
	const auto it = g_unreadIncoming.find(peerId);
	if (it == g_unreadIncoming.end() || it.value().isEmpty()) {
		return;
	}
	auto ids = std::vector<std::string>();
	for (const auto &u : it.value()) {
		ids.push_back(u.toStdString());
	}
	it.value().clear();
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
		const std::string &caption) {
	const parvane::json cap =
		caption.empty() ? parvane::json(nullptr) : parvane::json(caption);
	switch (type) {
	case SendMediaType::Photo:
		return parvane::json{{"kind", "photo"}, {"file_id", fileId},
			{"width", width}, {"height", height}, {"mime", mime},
			{"size_bytes", size}, {"caption", cap}};
	case SendMediaType::Audio:
		return parvane::json{{"kind", "voice"}, {"file_id", fileId},
			{"duration_secs", durationSecs}, {"mime", mime}, {"size_bytes", size}};
	case SendMediaType::Round:
		return parvane::json{{"kind", "video_note"}, {"file_id", fileId},
			{"duration_secs", durationSecs}, {"width", width}, {"height", height},
			{"mime", mime}, {"size_bytes", size}};
	default:
		// video/* как Video, всё прочее — File.
		if (mime.rfind("video/", 0) == 0) {
			return parvane::json{{"kind", "video"}, {"file_id", fileId},
				{"duration_secs", durationSecs}, {"width", width}, {"height", height},
				{"mime", mime}, {"size_bytes", size}, {"caption", cap}};
		}
		return parvane::json{{"kind", "file"}, {"file_id", fileId},
			{"filename", filename}, {"mime", mime},
			{"size_bytes", size}, {"caption", cap}};
	}
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
	const auto bare = std::uint64_t(peerToUser(file->to.peer).bare);
	const auto address = AddressForId(bare);
	if (address.isEmpty()) {
		LOG(("Parvane: медиа не зеркалится — адрес пира неизвестен (id=%1)")
			.arg(bare));
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
	const auto from = SelfAddress().toStdString();
	const auto to = address.toStdString();
	const auto token = Token().toStdString();
	const auto filenameStd = filename.toStdString();
	const auto mimeStd = file->filemime.toStdString();
	const auto captionStd = file->caption.text.toStdString();
	const auto bytesStd = std::string(bytes.constData(), bytes.size());

	crl::async([=] {
		parvane::Transport *t = nullptr;
		parvane::MessengerClient *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
			m = g_messenger.get();
		}
		if (!t || !m) {
			LOG(("Parvane: медиа-отправка без активной сессии — пропуск"));
			return;
		}
		try {
			parvane::CloudClient cloud(*t);
			const auto fileId = cloud.upload(from, token, filenameStd, mimeStd, bytesStd);
			const auto content = buildMediaContent(
				type, fileId, filenameStd, mimeStd, bytesStd.size(),
				durationSecs, mediaW, mediaH, captionStd);
			const auto id = m->sendContent(from, to, content, token);
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_ownSentUuids.insert(id);
			}
			LOG(("Parvane: медиа отправлено msg %1 (file %2, %3 байт) → %4")
				.arg(QString::fromStdString(id))
				.arg(QString::fromStdString(fileId))
				.arg(bytesStd.size())
				.arg(QString::fromStdString(to)));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка отправки медиа: %1")
				.arg(QString::fromUtf8(e.what())));
		}
	});
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
			const auto dir = QDir::tempPath() + u"/parvane-media"_q;
			QDir().mkpath(dir);
			localPath = dir + u"/out_"_q + QString::number(docId) + u"_"_q
				+ (file->filename.isEmpty() ? u"file"_q : file->filename);
			auto f = QFile(localPath);
			if (!f.open(QIODevice::WriteOnly)
				|| f.write(raw) != qint64(raw.size())) {
				return;
			}
		}
		session->data().document(docId)->setLocation(
			Core::FileLocation(localPath));
	}
}

namespace {

// Гарантирует, что пир (отправитель) существует и «загружен» в Data::Session.
// Синтезируем MTPUser с first_name = адрес, чтобы диалог имел имя. Идемпотентно.
void ResolveNames(const QStringList &addresses); // fwd
void DownloadAvatar(const QString &address, const QString &fileId); // fwd
// Сохраняет file_id аватара и запускает загрузку (если ещё не грузили).
void NoteAvatar(const QString &address, const QString &fileId) {
	if (fileId.isEmpty() || address == SelfAddress()) {
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
		const QString &gid,
		const QString &name,
		int memberCount) {
	const auto chatId = IdForAddress(gid);
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_knownGroups.insert(gid, name);
		g_chatIdToGroupId.insert(chatId, gid);
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
	}
	return result;
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
	// Незнакомое имя — просим каталог его резолвнуть (обновим, когда придёт).
	if (address != SelfAddress()
		&& !g_displayNames.contains(address)
		&& !g_resolveRequested.contains(address)) {
		g_resolveRequested.insert(address);
		ResolveNames({ address });
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
		parvane::Transport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		auto names = QHash<QString, QString>();
		auto avatars = QHash<QString, QString>();
		try {
			const auto reply = t->request(
				"identity.user.resolve", reqStr, 3000);
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
		} catch (const std::exception &) {
			return;
		}
		if (names.isEmpty() && avatars.isEmpty()) {
			return;
		}
		crl::on_main([names, avatars] {
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
		});
	});
}

// Строит MTPMessage в 1-на-1 диалоге. authorId — автор (from_id), peerId —
// собеседник (peer_id диалога), out — исходящее (наше). Для входящих
// authorId==peerId==отправитель, out=false; для СВОИХ (восстановление истории
// после рестарта) authorId=self, peerId=получатель, out=true.
[[nodiscard]] MTPMessage buildMessage(
		std::uint64_t authorId,
		std::uint64_t peerId,
		bool out,
		std::int64_t ts,
		const QString &text,
		const MTPMessageMedia &media = MTPMessageMedia(),
		bool hasMedia = false,
		std::int64_t replyToMsgId = 0,
		bool peerIsChat = false) {
	const auto authorPeer = peerFromUser(UserId(BareId(authorId)));
	// Диалог — 1-на-1 (user) или группа (chat). Для группы peerId = chatId.
	const auto dialogPeer = peerIsChat
		? peerFromChat(ChatId(BareId(peerId)))
		: peerFromUser(UserId(BareId(peerId)));
	using Flag = MTPDmessage::Flag;
	const auto flags = Flag::f_from_id
		| (out ? Flag::f_out : Flag(0))
		| (hasMedia ? Flag::f_media : Flag(0))
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
		MTPVector<MTPMessageEntity>(),
		MTPint(),                   // views
		MTPint(),                   // forwards
		MTPMessageReplies(),
		MTPint(),                   // edit_date
		MTPstring(),                // post_author
		MTPlong(),                  // grouped_id
		MTPMessageReactions(),
		MTPVector<MTPRestrictionReason>(),
		MTPint(),                   // ttl_period
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
		parvane::Transport *t = nullptr;
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
			auto d = cloud.download(self, token, fid);
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
			const auto user = session->data().userLoaded(UserId(BareId(id)));
			if (!user) {
				return;
			}
			const auto qb = QByteArray(bytes.data(), int(bytes.size()));
			auto image = QImage();
			if (!image.loadFromData(qb) || image.isNull()) {
				return;
			}
			g_avatarImages.insert(addressCopy, image); // кэш для повторной установки
			user->setUserpicInMemory(photoId,
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
		int height) {
	auto attributes = QVector<MTPDocumentAttribute>();
	if (kind == u"voice"_q) {
		// Голосовое: audio+voice+waveform. Пустой waveform ронял рендер
		// (qAbs(min())), поэтому даём валидный плоский waveform 5-bit.
		using AF = MTPDdocumentAttributeAudio::Flag;
		auto wf = VoiceWaveform();
		wf.reserve(64);
		for (auto i = 0; i != 64; ++i) {
			wf.push_back(8 + (i % 16)); // мягкая «волна», не нули
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
		const QString &caption) {
	RegisterPeer(from);
	ensurePeerUser(session, senderId, from);

	const auto mtpDoc = buildLocalMtpDocument(
		session, docId, kind, mime, size, filename, ts,
		durationSecs, width, height);
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

	const auto item = session->data().addNewMessage(
		msgId,
		buildMessage(authorId, senderId, out, ts, caption, media, /*hasMedia=*/true),
		MessageFlags(),
		NewMessageType::Unread);

	// Привязываем локальный файл к документу — тогда UI считает его скачанным.
	const auto doc = session->data().processDocument(mtpDoc);
	doc->setLocation(Core::FileLocation(localPath));

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
		const QString &caption) {
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
			durationSecs, width, height, caption);
		return;
	}
	RegisterPeer(from);
	ensurePeerUser(session, senderId, from);

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
		buildMessage(authorId, senderId, out, ts, caption, media, /*hasMedia=*/true),
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
		const QString &caption) {
	const auto self = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto fileIdStd = fileId.toStdString();
	crl::async([=] {
		parvane::Transport *t = nullptr;
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
			auto d = cloud.download(self, token, fileIdStd);
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
		const auto dir = QDir::tempPath() + u"/parvane-media"_q;
		QDir().mkpath(dir);
		const auto path = dir + u"/"_q + fileId + u"_"_q + filename;
		{
			auto f = QFile(path);
			if (!f.open(QIODevice::WriteOnly)
				|| f.write(bytes.data(), bytes.size()) != qint64(bytes.size())) {
				LOG(("Parvane: не записать медиа-файл %1").arg(path));
				return;
			}
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
			if (kind == u"photo"_q || mime.startsWith(u"image/"_q)) {
				injectPhotoOnMain(session, from, senderId, authorId, out,
					ts, msgId, mediaId, kind, path, filename, mime, size,
					durationSecs, width, height, caption);
			} else {
				injectMediaOnMain(session, from, senderId, authorId, out,
					ts, msgId, mediaId, kind, path, filename, mime, size,
					durationSecs, width, height, caption);
			}
		});
	});
}

// Инъекция результатов sync в Data::Session. Только main-поток. Дедуп по UUID.
void injectOnMain(
		not_null<Main::Session*> session,
		const std::vector<parvane::StoredMessage> &msgs) {
	const auto self = SelfAddress();
	const auto selfId = IdForAddress(self);
	int added = 0;
	for (const auto &sm : msgs) {
		const auto from = QString::fromStdString(sm.from);
		const auto uuid = QString::fromStdString(sm.id);
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
			// Правка: если уже инъецировано — обновляем текст локального item.
			const auto found = g_uuidToMsgId.find(uuid);
			if (found != g_uuidToMsgId.end() && found.value() != 0) {
				if (const auto maybeText = sm.text()) {
					const auto isOwn = (from == self);
					const auto peerAddr = isOwn
						? QString::fromStdString(sm.to) : from;
					const auto peerId = IdForAddress(peerAddr);
					const auto full = FullMsgId(
						peerFromUser(UserId(BareId(peerId))),
						MsgId(found.value()));
					const auto newText = QString::fromStdString(*maybeText);
					if (const auto item = session->data().message(full)) {
						if (item->originalText().text != newText) {
							item->setText({ newText });
							session->data().requestItemViewRefresh(item);
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
			}
			// не continue — ниже contains→continue пропустит уже инъецированное
		}
		if (!sm.reactions.empty() || sm.pinned) {
			// Реакции/закрепление могли измениться — обновляем инъецированное.
			const auto found = g_uuidToMsgId.find(uuid);
			if (found != g_uuidToMsgId.end() && found.value() != 0) {
				const auto react_own = (from == self);
				const auto pid = IdForAddress(react_own
					? QString::fromStdString(sm.to) : from);
				const auto full = FullMsgId(
					peerFromUser(UserId(BareId(pid))),
					MsgId(found.value()));
				if (const auto item = session->data().message(full)) {
					applyReactions(item, sm.reactions);
					if (sm.pinned) {
						applyPin(session, item, true);
					}
				}
			}
		}
		if (g_uuidToMsgId.contains(uuid)) {
			continue; // уже инъецировано
		}
		// Групповое сообщение: to — известная группа → инъекция в историю группы.
		const auto toStr = QString::fromStdString(sm.to);
		if (g_knownGroups.contains(toStr)) {
			const auto gtext = sm.text();
			if (!gtext) {
				continue; // медиа в группах — позже
			}
			const auto gtextQ = QString::fromStdString(*gtext);
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
			ensurePeerUser(session, IdForAddress(from), from); // автор в группе
			const auto gMsgId = MsgId(g_nextMsgId++);
			g_uuidToMsgId.insert(uuid, gMsgId.bare);
			g_msgIdToUuid.insert(gMsgId.bare, uuid);
			const auto gItem = session->data().addNewMessage(
				gMsgId,
				buildMessage(IdForAddress(from), gChatId, gOwn, sm.ts, gtextQ,
					MTPMessageMedia(), false, 0, /*peerIsChat=*/true),
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
			if (!out) {
				g_unreadIncoming[peerId].push_back(uuid);
			}
			pumpMediaDownload(peerAddress, peerId, authorId, out, sm.ts, msgId,
				kind, fileId, filename, mime, size,
				durationSecs, width, height, caption);
			++added;
			LOG(("Parvane: %1 медиа %2 (%3, kind=%4) → скачивание")
				.arg(out ? u"своё"_q : u"входящее"_q)
				.arg(uuid).arg(peerAddress).arg(kind));
			continue;
		}
		const auto text = QString::fromStdString(*maybeText);
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
		if (!out) {
			g_unreadIncoming[peerId].push_back(uuid);
		}
		const auto item = session->data().addNewMessage(
			msgId,
			buildMessage(authorId, peerId, out, sm.ts, text,
				MTPMessageMedia(), /*hasMedia=*/false, replyToMsgId),
			MessageFlags(),
			NewMessageType::Unread);
		++added;
		LOG(("Parvane: %1 msg %2 (%3): %4")
			.arg(out ? u"своё"_q : u"входящее"_q).arg(uuid)
			.arg(peerAddress).arg(text));
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
		LOG(("Parvane: инъецировано %1 сообщений").arg(added));
	}
}

// Публикует хартбит присутствия на presence.<мой id> (эфемерно). Зовётся с main
// (таймер). Подписчики ставят пиру OnlineTill(now+90); без нового хартбита за
// 90с статус сам «протухает» → «был(а) недавно» (offline-таймер не нужен).
void publishPresenceHeartbeat() {
	const auto self = SelfAddress();
	if (self.isEmpty()) {
		return;
	}
	const auto selfStd = self.toStdString();
	const auto id = IdForAddress(self);
	crl::async([selfStd, id] {
		parvane::Transport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		const parvane::json ev{ { "from", selfStd } };
		try {
			t->publish("presence." + std::to_string(id), ev.dump());
		} catch (const std::exception &) {
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

void SearchUsers(const QString &query, Fn<void(QStringList)> callback) {
	const auto q = query.trimmed().toStdString();
	if (q.empty()) {
		callback({});
		return;
	}
	crl::async([q, callback = std::move(callback)]() mutable {
		parvane::Transport *t = nullptr;
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
					"identity.user.search", req.dump(), 3000);
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
		parvane::Transport *t = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			t = g_transport.get();
		}
		if (!t) {
			return;
		}
		const parvane::json req{ { "token", token }, { "display_name", nStd } };
		try {
			t->request("identity.user.setname", req.dump(), 3000);
			LOG(("Parvane: имя обновлено на '%1'").arg(QString::fromStdString(nStd)));
		} catch (const std::exception &) {
		}
	});
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
		parvane::Transport *t = nullptr;
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
			fileId = cloud.upload(from, token, "avatar.jpg", "image/jpeg", bytesStd);
		} catch (const std::exception &) {
			return;
		}
		if (fileId.empty()) {
			return;
		}
		try {
			const parvane::json req{ { "token", token }, { "file_id", fileId } };
			t->request("identity.user.setavatar", req.dump(), 3000);
			LOG(("Parvane: аватар обновлён (%1)").arg(QString::fromStdString(fileId)));
		} catch (const std::exception &) {
		}
		crl::on_main([self, fileId] {
			g_avatarFileIds.insert(self, QString::fromStdString(fileId));
		});
	});
}

void PumpReceive() {
	crl::async([] {
		parvane::MessengerClient *m = nullptr;
		std::string self, token;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_messenger.get();
			self = g_selfAddress.toStdString();
			token = g_token.toStdString();
		}
		if (!m || self.empty()) {
			return;
		}
		std::vector<parvane::StoredMessage> msgs;
		try {
			// Полный ресинк (since=0 → шард отдаёт всё), дедуп по UUID на main.
			msgs = m->sync(self, token, parvane::MessengerClient::zeroCursor(), 0);
		} catch (const std::exception &e) {
			LOG(("Parvane: sync ошибка: %1").arg(QString::fromUtf8(e.what())));
			return;
		}
		if (msgs.empty()) {
			return;
		}
		crl::on_main([msgs = std::move(msgs)]() mutable {
			const auto session = g_sessionWeak.get();
			if (!session) {
				return; // сессия ещё/уже не активна — придёт со следующим pump
			}
			injectOnMain(session, msgs);
		});
	});
}

// ── звонки: публичное API (кнопка UI / debug-хуки) ───────────────────────────

void PlaceCall(const QString &peer, bool video) {
	RegisterPeer(peer);
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		g_currentCallPeer = peer;
	}
	// Подтягиваем pubkey собеседника (для проверки его answer). Асинхронно;
	// answer приходит позже — к тому моменту кэш заполнен.
	ResolveNames({ peer });
	const auto p = peer.toStdString();
	const auto media = std::string(video ? "video" : "audio");
	crl::async([p, media] {
		parvane::CallManager *m = nullptr;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_callManager.get();
		}
		if (m) {
			m->placeCall(p, media);
			LOG(("Parvane: исходящий звонок → %1 (%2)")
				.arg(QString::fromStdString(p), QString::fromStdString(media)));
		}
	});
}

void AcceptCall() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	if (g_callManager) g_callManager->accept();
}

void HangupCall() {
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	if (g_callManager) g_callManager->hangup();
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
	crl::async([groupId, gidStd, token, media] {
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
				const auto gid = QString::fromStdString(gi.group_id);
				ensureGroupChat(session, gid,
					QString::fromStdString(gi.name),
					int(gi.members.size()));
				// Кэшируем участников (для группового звонка).
				QStringList mem;
				for (const auto &m : gi.members) {
					mem.push_back(QString::fromStdString(m.address));
				}
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g_groupMembers.insert(gid, mem);
			}
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
		crl::on_main([gid, nameQ] {
			const auto session = g_sessionWeak.get();
			if (session) {
				ensureGroupChat(session, gid, nameQ, int(1));
			}
		});
	});
}

void AfterSessionReady(not_null<Main::Session*> session) {
	const auto weak = base::make_weak(session);
	// Откладываем на main, чтобы конструктор Main::Session завершился.
	crl::on_main(weak, [=] {
		g_sessionWeak = weak;
		RegisterPeer(SelfAddress());
		if (!SessionActive()) {
			StartSession(); // на случай гонки с воркер-StartSession из логина
		}

		// Подписка на «печатает…» (эфемерно): msg.typing.<мой id>. Хендлер
		// приходит с NATS-потока → маршалим на main и показываем действие пира.
		if (!g_typingSubscribed) {
			g_typingSubscribed = true;
			const auto selfId = IdForAddress(SelfAddress());
			parvane::Transport *t = nullptr;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				t = g_transport.get();
			}
			if (t) {
				t->subscribe("msg.typing." + std::to_string(selfId),
					[](std::string, std::string payload) {
						std::string from;
						try {
							from = parvane::json::parse(payload)
								.value("from", std::string());
						} catch (const std::exception &) {
							return;
						}
						if (from.empty()) {
							return;
						}
						const auto fromQ = QString::fromStdString(from);
						crl::on_main([fromQ] {
							const auto session = g_sessionWeak.get();
							if (!session) {
								return;
							}
							RegisterPeer(fromQ);
							const auto id = IdForAddress(fromQ);
							const auto user = ensurePeerUser(session, id, fromQ);
							const auto history = session->data().history(user);
							session->data().sendActionManager().registerFor(
								history, MsgId(0), user,
								MTP_sendMessageTypingAction(),
								base::unixtime::now());
						});
					});
				LOG(("Parvane: подписка на msg.typing.%1").arg(selfId));
			}
		}

		// Присутствие (real online): подписка на presence.* + хартбит своего
		// присутствия каждые 30с. На приёме ставим пиру OnlineTill(now+90).
		if (!g_presenceSubscribed) {
			g_presenceSubscribed = true;
			parvane::Transport *t = nullptr;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				t = g_transport.get();
			}
			if (t) {
				t->subscribe("presence.*",
					[](std::string, std::string payload) {
						std::string from;
						try {
							from = parvane::json::parse(payload)
								.value("from", std::string());
						} catch (const std::exception &) {
							return;
						}
						if (from.empty()) {
							return;
						}
						const auto fromQ = QString::fromStdString(from);
						crl::on_main([fromQ] {
							const auto session = g_sessionWeak.get();
							if (!session || fromQ == SelfAddress()) {
								return;
							}
							const auto id = IdForAddress(fromQ);
							const auto user = session->data().userLoaded(
								UserId(BareId(id)));
							if (!user) {
								return; // присутствие незнакомого пира игнорируем
							}
							if (user->updateLastseen(
									Data::LastseenStatus::OnlineTill(
										base::unixtime::now() + 90))) {
								session->changes().peerUpdated(user,
									Data::PeerUpdate::Flag::OnlineStatus);
							}
						});
					});
				LOG(("Parvane: подписка на presence.*"));
			}
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
				if (!item->out()
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
			});
			g_pumpTimer->callEach(kPumpIntervalMs);
			LOG(("Parvane: периодический sync каждые %1 мс").arg(kPumpIntervalMs));
		}

		// Debug-autosendfile для e2e Фазы 4: PARVANE_AUTOSENDFILE=peer@server:/path.
		// Отправляет файл штатным путём tdesktop (FileLoadTask → SendConfirmedFile
		// → MirrorOutgoingFile). Тип по расширению: png/jpg → Photo, иначе File.
		if (const char *fv = std::getenv("PARVANE_AUTOSENDFILE"); fv && *fv) {
			const auto spec = QString::fromUtf8(fv);
			const auto sep = spec.indexOf(':');
			if (sep > 0) {
				const auto peerAddr = spec.left(sep);
				const auto path = spec.mid(sep + 1);
				auto f = QFile(path);
				if (f.open(QIODevice::ReadOnly)) {
					const auto bytes = f.readAll();
					RegisterPeer(peerAddr);
					const auto fileUser = session->data().user(
						UserId(BareId(IdForAddress(peerAddr))));
					const auto fileHistory = session->data().history(fileUser);
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

		// Debug-autodelete для e2e delete: PARVANE_AUTODELETE=<секунды> — удаляет
		// своё последнее исходящее штатным путём (deleteMessages → MirrorDelete).
		if (const char *dv = std::getenv("PARVANE_AUTODELETE"); dv && *dv) {
			const auto secs = std::max(QString::fromUtf8(dv).toInt(), 1);
			base::call_delayed(secs * crl::time(1000), [] {
				const auto session = g_sessionWeak.get();
				if (!session || !g_lastOwnFullId) {
					return;
				}
				const auto item = session->data().message(g_lastOwnFullId);
				if (!item) {
					LOG(("Parvane: autodelete — сообщение не найдено"));
					return;
				}
				session->data().histories().deleteMessages(
					item->history(),
					QVector<MTPint>{ MTP_int(g_lastOwnFullId.msg.bare) },
					true);
				LOG(("Parvane: autodelete → msgId %1")
					.arg(g_lastOwnFullId.msg.bare));
			});
		}

		// Debug-autoedit для e2e edit: PARVANE_AUTOEDIT=<секунды>:новый текст.
		if (const char *ev = std::getenv("PARVANE_AUTOEDIT"); ev && *ev) {
			const auto spec = QString::fromUtf8(ev);
			const auto sep = spec.indexOf(':');
			if (sep > 0) {
				const auto secs = std::max(spec.left(sep).toInt(), 1);
				const auto newText = spec.mid(sep + 1);
				base::call_delayed(secs * crl::time(1000), [newText] {
					if (!g_lastOwnFullId) {
						return;
					}
					MirrorEdit(g_lastOwnFullId.msg.bare, newText);
					LOG(("Parvane: autoedit → %1").arg(newText));
				});
			}
		}

		// Группы: подтягиваем список пользователя (после StartSession).
		base::call_delayed(2 * crl::time(1000), [] { RefreshGroups(); });

		// Debug-autogroup для e2e: PARVANE_AUTOGROUP=Имя:member1,member2 (пусто —
		// без начальных участников). Создаёт группу через ~4с.
		if (const char *gv = std::getenv("PARVANE_AUTOGROUP"); gv && *gv) {
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
		if (const char *gcv = std::getenv("PARVANE_AUTOGROUPCALL"); gcv && *gcv) {
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

		// Debug-autocall для e2e звонков: PARVANE_AUTOCALL=peer@server[:video].
		// Инициатор через ~4с звонит; принимающий ставит PARVANE_AUTOACCEPT=1.
		if (const char *cv = std::getenv("PARVANE_AUTOCALL"); cv && *cv) {
			auto spec = QString::fromUtf8(cv);
			const auto video = spec.endsWith(u":video"_q);
			if (video) spec.chop(6);
			base::call_delayed(4 * crl::time(1000), [spec, video] {
				LOG(("Parvane: AUTOCALL → %1").arg(spec));
				PlaceCall(spec, video);
			});
		}

		// Debug-autosend для e2e Фазы 3b: PARVANE_AUTOSEND=peer@server:текст.
		const char *v = std::getenv("PARVANE_AUTOSEND");
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
	});
}

} // namespace Parvane
