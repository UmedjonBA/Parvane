// Parvane fork: см. parvane_client.h.
#include "parvane/parvane_client.h"

#include "base/debug_log.h"
#include "base/weak_ptr.h"
#include "base/timer.h"
#include "main/main_session.h"
#include "data/data_session.h"
#include "data/data_user.h"
#include "data/data_types.h"
#include "data/data_peer_id.h"
#include "history/history.h"
#include "history/history_item.h"
#include "apiwrap.h"
#include "api/api_common.h"
#include "storage/localimageloader.h" // FilePrepareResult, SendMediaType

#include <parvane/events.h>          // parvane-core
#include <parvane/topics.h>          // parvane-core
#include <parvane/transport.h>       // parvane-core
#include <parvane/messenger_client.h> // parvane-core
#include <parvane/cloud_client.h>    // parvane-core

#include <QtCore/QFile>

#include <crl/crl_async.h>
#include <crl/crl_on_main.h>

#include <cstdint>
#include <cstdlib>
#include <memory>
#include <mutex>

namespace Parvane {
namespace {

// Состояние процесса. g_sessionMutex охраняет транспорт/мессенджер и реестр.
std::mutex g_sessionMutex;
QString g_token;
QString g_selfAddress;
std::unique_ptr<parvane::Transport> g_transport;
std::unique_ptr<parvane::MessengerClient> g_messenger;
QHash<quint64, QString> g_idToAddress;

// Состояние приёма (Фаза 3c) — трогается ТОЛЬКО на main-потоке (инъекция и
// AfterSessionReady идут через crl::on_main), поэтому без мьютекса.
base::weak_ptr<Main::Session> g_sessionWeak;
QHash<QString, qint64> g_uuidToMsgId; // UUID сообщения → синтетический MsgId
qint64 g_nextMsgId = 1;               // серверный диапазон (0 < id < 2^56)
std::unique_ptr<base::Timer> g_pumpTimer; // периодический sync (main-поток)

constexpr auto kPumpIntervalMs = crl::time(3000);

// Публикует текст в шину с воркер-потока (не блокирует UI).
void sendTextAsync(const QString &toAddress, const QString &text) {
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
			const auto id = m->sendText(from, to, body, token);
			LOG(("Parvane: отправлено msg %1 → %2")
				.arg(QString::fromStdString(id))
				.arg(QString::fromStdString(to)));
		} catch (const std::exception &e) {
			LOG(("Parvane: ошибка отправки: %1").arg(QString::fromUtf8(e.what())));
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

void MirrorOutgoing(PeerData *peer, const QString &text) {
	if (!peer || !peer->isUser() || text.isEmpty()) {
		return;
	}
	const auto bare = std::uint64_t(peerToUser(peer->id).bare);
	const auto address = AddressForId(bare);
	if (address.isEmpty()) {
		LOG(("Parvane: исходящее не зеркалится — адрес пира неизвестен (id=%1)")
			.arg(bare));
		return;
	}
	sendTextAsync(address, text);
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
		const std::string &caption) {
	const parvane::json cap =
		caption.empty() ? parvane::json(nullptr) : parvane::json(caption);
	switch (type) {
	case SendMediaType::Photo:
		return parvane::json{{"kind", "photo"}, {"file_id", fileId},
			{"width", 0}, {"height", 0}, {"mime", mime},
			{"size_bytes", size}, {"caption", cap}};
	case SendMediaType::Audio:
		return parvane::json{{"kind", "voice"}, {"file_id", fileId},
			{"duration_secs", 0}, {"mime", mime}, {"size_bytes", size}};
	case SendMediaType::Round:
		return parvane::json{{"kind", "video_note"}, {"file_id", fileId},
			{"duration_secs", 0}, {"mime", mime}, {"size_bytes", size}};
	default:
		// video/* как Video, всё прочее — File.
		if (mime.rfind("video/", 0) == 0) {
			return parvane::json{{"kind", "video"}, {"file_id", fileId},
				{"duration_secs", 0}, {"width", 0}, {"height", 0},
				{"mime", mime}, {"size_bytes", size}, {"caption", cap}};
		}
		return parvane::json{{"kind", "file"}, {"file_id", fileId},
			{"filename", filename}, {"mime", mime},
			{"size_bytes", size}, {"caption", cap}};
	}
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

	// Байты: из памяти (content) либо читаем с диска (filepath).
	auto bytes = file->content;
	if (bytes.isEmpty() && !file->filepath.isEmpty()) {
		auto f = QFile(file->filepath);
		if (f.open(QIODevice::ReadOnly)) {
			bytes = f.readAll();
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
				type, fileId, filenameStd, mimeStd, bytesStd.size(), captionStd);
			const auto id = m->sendContent(from, to, content, token);
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

namespace {

// Гарантирует, что пир (отправитель) существует и «загружен» в Data::Session.
// Синтезируем MTPUser с first_name = адрес, чтобы диалог имел имя. Идемпотентно.
not_null<UserData*> ensurePeerUser(
		not_null<Main::Session*> session,
		std::uint64_t id,
		const QString &address) {
	auto flags = MTPDuser::Flags();
	if (address == SelfAddress()) {
		flags |= MTPDuser::Flag::f_self;
	}
	const auto user = MTP_user(
		MTP_flags(flags),
		MTP_long(id),
		MTPlong(),           // access_hash
		MTP_string(address), // first_name — показываем адрес
		MTPstring(),         // last_name
		MTPstring(),         // username
		MTPstring(),         // phone
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
	return session->data().processUser(user);
}

// Строит входящий MTPMessage (out=false) от отправителя в его 1-на-1 диалоге.
// Раскладка полей сверена с GenerateForwardedItem (settings_privacy_controllers).
[[nodiscard]] MTPMessage buildIncoming(
		std::uint64_t senderId,
		std::int64_t ts,
		const QString &text) {
	const auto senderPeer = peerFromUser(UserId(BareId(senderId)));
	using Flag = MTPDmessage::Flag;
	return MTP_message(
		MTP_flags(Flag::f_from_id),
		MTP_int(0),                 // id (override через addNewMessage)
		peerToMTP(senderPeer),      // from_id — отправитель
		MTPint(),                   // from_boosts_applied
		MTPstring(),                // from_rank
		peerToMTP(senderPeer),      // peer_id — диалог с отправителем
		MTPPeer(),                  // saved_peer_id
		MTPMessageFwdHeader(),      // fwd_from
		MTPlong(),                  // via_bot_id
		MTPlong(),                  // via_business_bot_id
		MTPPeer(),                  // guestchat_via_from
		MTPMessageReplyHeader(),    // reply_to
		MTP_int(int(ts)),           // date
		MTP_string(text),           // message
		MTPMessageMedia(),
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

// Инъекция результатов sync в Data::Session. Только main-поток. Дедуп по UUID.
void injectOnMain(
		not_null<Main::Session*> session,
		const std::vector<parvane::StoredMessage> &msgs) {
	const auto self = SelfAddress();
	int added = 0;
	for (const auto &sm : msgs) {
		const auto from = QString::fromStdString(sm.from);
		if (from == self || sm.deleted) {
			continue; // своё (есть локальное эхо) или томбстоун — пропускаем
		}
		const auto uuid = QString::fromStdString(sm.id);
		if (g_uuidToMsgId.contains(uuid)) {
			continue; // уже инъецировано
		}
		const auto maybeText = sm.text();
		if (!maybeText) {
			continue; // не текст — медиа в Фазе 4
		}
		const auto text = QString::fromStdString(*maybeText);
		RegisterPeer(from);
		const auto senderId = IdForAddress(from);
		ensurePeerUser(session, senderId, from);
		const auto msgId = MsgId(g_nextMsgId++);
		g_uuidToMsgId.insert(uuid, msgId.bare);
		const auto item = session->data().addNewMessage(
			msgId,
			buildIncoming(senderId, sm.ts, text),
			MessageFlags(),
			NewMessageType::Unread);
		++added;
		LOG(("Parvane: получено msg %1 от %2: %3").arg(uuid).arg(from).arg(text));
		if (item) {
			const auto history = item->history();
			// Без живого MTProto папка истории остаётся «неизвестной», и
			// shouldBeInChatList() = false → диалог не появляется в списке.
			// Помечаем основную папку известной (как applyDialog с folder=null):
			// это вызывает updateChatListSortPosition и регистрирует диалог.
			if (!history->folderKnown()) {
				history->clearFolder();
			}
			LOG(("Parvane: диалог %1 — в списке=%2 непрочитано=%3")
				.arg(from)
				.arg(history->inChatList() ? 1 : 0)
				.arg(history->unreadCount()));
		}
	}
	if (added > 0) {
		LOG(("Parvane: инъецировано %1 входящих").arg(added));
	}
}

} // namespace

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

void AfterSessionReady(not_null<Main::Session*> session) {
	const auto weak = base::make_weak(session);
	// Откладываем на main, чтобы конструктор Main::Session завершился.
	crl::on_main(weak, [=] {
		g_sessionWeak = weak;
		RegisterPeer(SelfAddress());
		if (!SessionActive()) {
			StartSession(); // на случай гонки с воркер-StartSession из логина
		}
		// Первичный приём: подтягиваем то, что уже лежит в шарде (офлайн-бэклог).
		PumpReceive();

		// Периодический sync (Фаза 3d): ловит сообщения, чей delivered-бродкаст
		// был пропущен (NATS fire-and-forget) или пришёл, пока клиент был офлайн.
		if (!g_pumpTimer) {
			g_pumpTimer = std::make_unique<base::Timer>([] { PumpReceive(); });
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
