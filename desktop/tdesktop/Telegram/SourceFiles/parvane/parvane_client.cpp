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
#include "data/data_peer_id.h"
#include "core/file_location.h"
#include "base/unixtime.h"
#include "ui/image/image_location_factory.h" // Images::FromImageInMemory
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
#include <QtCore/QDir>
#include <QtGui/QImage>

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
		const QString &text,
		const MTPMessageMedia &media = MTPMessageMedia(),
		bool hasMedia = false) {
	const auto senderPeer = peerFromUser(UserId(BareId(senderId)));
	using Flag = MTPDmessage::Flag;
	const auto flags = Flag::f_from_id
		| (hasMedia ? Flag::f_media : Flag(0));
	return MTP_message(
		MTP_flags(flags),
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

// Локальный MTPDocument: без DC-локации (файл лежит на диске, см. setLocation).
// В MVP любое медиа представляем документом с filename-атрибутом — открывается
// и сохраняется штатным UI; inline-рендер фото — задача Фазы 4c.
[[nodiscard]] MTPDocument buildLocalMtpDocument(
		not_null<Main::Session*> session,
		std::int64_t docId,
		const QString &mime,
		std::int64_t size,
		const QString &filename,
		std::int64_t ts) {
	auto attributes = QVector<MTPDocumentAttribute>();
	attributes.push_back(MTP_documentAttributeFilename(MTP_string(filename)));
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

// Инъекция уже СКАЧАННОГО медиа-сообщения (main-поток): документ + локальный
// файл + сообщение с media. msgId уже зарезервирован в injectOnMain.
void injectMediaOnMain(
		not_null<Main::Session*> session,
		const QString &from,
		std::uint64_t senderId,
		std::int64_t ts,
		MsgId msgId,
		std::int64_t docId,
		const QString &localPath,
		const QString &filename,
		const QString &mime,
		std::int64_t size,
		const QString &caption) {
	RegisterPeer(from);
	ensurePeerUser(session, senderId, from);

	const auto mtpDoc = buildLocalMtpDocument(
		session, docId, mime, size, filename, ts);
	using Flag = MTPDmessageMediaDocument::Flag;
	const auto media = MTP_messageMediaDocument(
		MTP_flags(Flag::f_document),
		mtpDoc,
		MTPVector<MTPDocument>(),
		MTPPhoto(),
		MTPint(),
		MTPint());

	const auto item = session->data().addNewMessage(
		msgId,
		buildIncoming(senderId, ts, caption, media, /*hasMedia=*/true),
		MessageFlags(),
		NewMessageType::Unread);

	// Привязываем локальный файл к документу — тогда UI считает его скачанным.
	const auto doc = session->data().processDocument(mtpDoc);
	doc->setLocation(Core::FileLocation(localPath));

	LOG(("Parvane: получено медиа от %1: %2 (%3 байт) → %4")
		.arg(from).arg(filename).arg(size).arg(localPath));
	if (item) {
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
		std::int64_t ts,
		MsgId msgId,
		std::int64_t mediaId,
		const QString &localPath,
		const QString &filename,
		const QString &mime,
		std::int64_t size,
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
		// не изображение — показываем как документ
		injectMediaOnMain(session, from, senderId, ts, msgId, mediaId,
			localPath, filename, mime, size, caption);
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
		buildIncoming(senderId, ts, caption, media, /*hasMedia=*/true),
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

	LOG(("Parvane: получено фото от %1: %2x%3 (%4 байт)")
		.arg(from).arg(image.width()).arg(image.height()).arg(size));
	if (item) {
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
		std::int64_t ts,
		MsgId msgId,
		const QString &kind,
		const QString &fileId,
		const QString &filename,
		const QString &mime,
		std::int64_t size,
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
				injectPhotoOnMain(session, from, senderId, ts, msgId, mediaId,
					path, filename, mime, size, caption);
			} else {
				injectMediaOnMain(session, from, senderId, ts, msgId, mediaId,
					path, filename, mime, size, caption);
			}
		});
	});
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

			RegisterPeer(from);
			const auto senderId = IdForAddress(from);
			const auto msgId = MsgId(g_nextMsgId++);
			g_uuidToMsgId.insert(uuid, msgId.bare);
			pumpMediaDownload(from, senderId, sm.ts, msgId, kind,
				fileId, filename, mime, size, caption);
			++added;
			LOG(("Parvane: медиа %1 от %2 (kind=%3) → скачивание")
				.arg(uuid).arg(from).arg(kind));
			continue;
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
