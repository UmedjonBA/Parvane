// Parvane fork: этап 4 ревью UI 7 ноя 2026 («редкое сломанное»): штатные пункты tdesktop, которые уходили в
// MTProto, ведутся в Parvane в одном месте — «Открепить все», выход/удаление группы с подтверждением, вкладки медиа
// глобального поиска по своему индексу, «Настройки архива», выбор устройств звонка, удаление и порядок своих наборов
// стикеров. Хук сценариев — `RunRareUiStep` (шаги PARVANE_AUTOUI сверх этапа 2; только dev-сборка).
#include "parvane/parvane_client_internal.h"

#include "api/api_global_privacy.h"
#include "api/api_messages_search.h"
#include "data/data_search_controller.h"
#include "data/data_chat_filters.h"
#include "data/stickers/data_stickers.h"
#include "data/stickers/data_stickers_set.h"
#include "data/data_folder.h"
#include "dialogs/dialogs_key.h"
#include "styles/style_layers.h"

#include <parvane/client_safety.h>

#include <QtCore/QDirIterator>

namespace Parvane {
namespace Internal {

extern std::map<PeerId, std::array<std::vector<MsgId>, Storage::kSharedMediaTypeCount>> g_sharedMedia;

} // namespace Internal

// ── п. 14: «Открепить все» ──────────────────────────────────────────────────
bool UnpinAllMessages(not_null<History*> history) {
	auto pinned = std::vector<not_null<HistoryItem*>>();
	for (const auto &block : history->blocks) {
		for (const auto &view : block->messages) {
			if (view->data()->isPinned()) {
				pinned.push_back(view->data());
			}
		}
	}
	for (const auto item : pinned) {
		MirrorPin(item, false);
		item->setIsPinned(false);
		history->owner().notifyItemDataChange(item);
	}
	history->unpinMessagesFor(MsgId(0), PeerId(0));
	LOG(("Parvane: «Открепить все» — откреплено %1").arg(pinned.size()));
	return true;
}

// ── п. 16: вкладки «Фото / Видео / Ссылки / Файлы / Музыка / Голосовые» глобального поиска ──
Api::GlobalMediaResult GlobalMediaLocal(
		not_null<Main::Session*> session,
		Storage::SharedMediaType type,
		const QString &query) {
	auto items = std::vector<not_null<HistoryItem*>>();
	const auto q = query.trimmed();
	const auto index = static_cast<int>(type);
	for (const auto &[peerId, perType] : g_sharedMedia) {
		if (index < 0 || index >= int(perType.size())) {
			continue;
		}
		for (const auto msgId : perType[index]) {
			const auto item = session->data().message(peerId, msgId);
			if (!item) {
				continue;
			}
			if (!q.isEmpty()) {
				auto haystack = item->originalText().text;
				if (const auto media = item->media()) {
					if (const auto document = media->document()) {
						haystack += ' ' + document->filename();
					}
				}
				if (!haystack.contains(q, Qt::CaseInsensitive)) {
					continue;
				}
			}
			items.push_back(item);
		}
	}
	ranges::sort(items, [](not_null<HistoryItem*> a, not_null<HistoryItem*> b) {
		return a->date() > b->date(); // свежие первыми, как messages.searchGlobal
	});
	auto result = Api::GlobalMediaResult();
	for (const auto item : items) {
		result.messageIds.push_back(item->position());
	}
	result.fullCount = int(result.messageIds.size());
	LOG(("Parvane: глобальный поиск медиа (тип %1, «%2») — найдено %3").arg(index).arg(q).arg(result.fullCount));
	return result;
}

// ── п. 19: «Удалить и покинуть» группу — с подтверждением; владельцу — «Удалить группу» ──
// Подтверждено: владелец удаляет группу (выйти он не может — движок отвергает), остальные выходят; чат убирается
// только после успеха записи журнала группы.
void LeaveOrDeleteGroupNow(not_null<PeerData*> peer, Fn<void(bool ok)> done) {
	const auto gid = GroupIdForChat(peer);
	const auto chat = peer->asChat();
	const auto owner = chat && chat->amCreator();
	const auto session = &peer->session();
	const auto weak = base::make_weak(session);
	const auto peerId = peer->id;
	const auto finish = [=](bool ok, const QString &error) {
		const auto alive = weak.get();
		const auto strong = alive ? alive->data().peerLoaded(peerId) : nullptr;
		if (ok && strong) {
			session->data().deleteConversationLocally(strong);
		}
		LOG(("Parvane: группа %1 — %2 %3").arg(gid, owner ? u"удаление"_q : u"выход"_q, ok ? u"ok"_q : error));
		if (done) {
			done(ok);
		}
	};
	if (owner) {
		DeleteGroup(gid, finish);
	} else {
		LeaveGroup(gid, finish);
	}
}

void ConfirmLeaveOrDeleteGroup(std::shared_ptr<Ui::Show> show, not_null<PeerData*> peer) {
	const auto gid = GroupIdForChat(peer);
	if (gid.isEmpty()) {
		return;
	}
	const auto chat = peer->asChat();
	const auto owner = chat && chat->amCreator();
	const auto channel = IsChannelChat(peer);
	const auto confirmed = [=](Fn<void()> &&close) {
		close();
		LeaveOrDeleteGroupNow(peer, [=](bool ok) {
			if (!ok) {
				show->showToast(tr::lng_parvane_group_leave_failed(tr::now));
			}
		});
	};
	show->showBox(Ui::MakeConfirmBox({
		.text = owner
			? (channel ? tr::lng_sure_delete_channel : tr::lng_sure_delete_group)(tr::now)
			: (channel ? tr::lng_sure_leave_channel : tr::lng_sure_leave_group)(tr::now),
		.confirmed = confirmed,
		.confirmText = owner
			? (channel ? tr::lng_profile_delete_channel : tr::lng_profile_delete_group)()
			: (channel ? tr::lng_profile_leave_channel : tr::lng_profile_leave_group)(),
		.confirmStyle = &st::attentionBoxButton,
	}));
}

// ── п. 21: «Настройки архива» ───────────────────────────────────────────────
// Устройства: tdata/parvane-archive-settings.json {unarchive: 0 — держать в архиве, 1 — кроме чатов из папок,
// 2 — возвращать все незаглушённые}. По умолчанию — держать (как прежде desktop и web).
namespace {

[[nodiscard]] QString ArchiveSettingsPath() {
	return cWorkingDir() + u"tdata/parvane-archive-settings.json"_q;
}

} // namespace

int ArchiveUnarchiveMode() {
	const auto j = parvane::json::parse(StoreRead(ArchiveSettingsPath()).toStdString(), nullptr, false);
	const auto v = j.is_object() ? j.value("unarchive", 0) : 0;
	return (v >= 0 && v <= 2) ? v : 0;
}

void SetArchiveUnarchiveMode(int mode) {
	StoreWrite(ArchiveSettingsPath(), QByteArray::fromStdString(parvane::json{ { "unarchive", mode } }.dump()));
	LOG(("Parvane: настройки архива — режим %1").arg(mode));
}

void MaybeUnarchiveOnIncoming(not_null<History*> history) {
	if (!history->folder() || history->muted()) {
		return;
	}
	const auto mode = ArchiveUnarchiveMode();
	if (mode == 0) {
		return;
	}
	if (mode == 1) {
		for (const auto &filter : history->owner().chatsFilters().list()) {
			if (filter.id() > 1 && filter.contains(history)) {
				return; // «Чаты из папок — держать в архиве»
			}
		}
	}
	LOG(("Parvane: новое сообщение — чат возвращён из архива (режим %1)").arg(mode));
	history->session().api().toggleHistoryArchived(history, false, nullptr);
}

// ── п. 23: свои наборы стикеров — удаление и порядок ───────────────────────
namespace {

[[nodiscard]] QString StickerOrderPath() {
	return cWorkingDir() + u"tdata/parvane-sticker-order.json"_q;
}

} // namespace

void SaveLocalStickerOrder(not_null<Main::Session*> session) {
	auto names = parvane::json::array();
	for (const auto setId : session->data().stickers().setsOrder()) {
		const auto info = LocalStickerPackDir(setId);
		if (!info.isEmpty()) {
			names.push_back(QFileInfo(info).fileName().toStdString());
		}
	}
	StoreWrite(StickerOrderPath(), QByteArray::fromStdString(parvane::json{ { "order", names } }.dump()));
	LOG(("Parvane: стикеры: порядок наборов сохранён (%1)").arg(int(names.size())));
}

QStringList LocalStickerOrder() {
	const auto j = parvane::json::parse(StoreRead(StickerOrderPath()).toStdString(), nullptr, false);
	auto out = QStringList();
	if (j.is_object() && j.contains("order") && j["order"].is_array()) {
		for (const auto &n : j["order"]) {
			if (n.is_string()) {
				out.push_back(QString::fromStdString(n.get<std::string>()));
			}
		}
	}
	return out;
}

} // namespace Parvane

namespace Parvane {

// ── п. 31: клик по @упоминанию незнакомого адреса ───────────────────────────
// Каталог identity (resolveProfiles) вместо contacts.resolveUsername: есть — пользователь и его профиль, нет — null.
void ResolveAddressForLink(
		not_null<Main::Session*> session,
		const QString &username,
		Fn<void(PeerData*)> done) {
	auto address = username.trimmed();
	if (address.startsWith('@')) {
		address = address.mid(1);
	}
	if (!address.contains('@')) {
		const auto self = SelfAddress();
		const auto at = self.indexOf('@');
		address += (at >= 0) ? self.mid(at) : QString();
	}
	address = address.toLower();
	const auto weak = base::make_weak(session.get());
	crl::async([=] {
		auto found = false;
		if (const auto control = ControlSnapshot()) {
			try {
				for (const auto &p : parvane::v2::account::resolveProfiles(*control, { address.toStdString() })) {
					if (QString::fromStdString(p.address).compare(address, Qt::CaseInsensitive) == 0) {
						found = true;
					}
				}
			} catch (const std::exception &e) {
				LOG(("Parvane: упоминание — каталог не ответил: %1").arg(QString::fromUtf8(e.what())));
			}
		}
		crl::on_main([=] {
			const auto s = weak.get();
			LOG(("Parvane: упоминание @%1 — %2").arg(address, found ? u"найден"_q : u"не найден"_q));
			done((s && found) ? EnsureUser(s, address).get() : nullptr);
		});
	});
}

} // namespace Parvane

#include "data/data_wall_paper.h"

namespace Parvane {

// ── раздел 5 ревью UI 7 ноя: обои одного чата — на устройстве ──────────────
// tdata/parvane-chat-wallpapers.json {self, papers: {адрес: base64(WallPaper::serialize)}} (шифр хранилища).
namespace {

std::optional<parvane::json> g_chatPapersCache; // main
QString g_chatPapersOwner;

[[nodiscard]] QString ChatWallPapersPath() {
	return AccountFilePath(u"parvane-chat-wallpapers-"_q, SelfAddress(), u".json"_q);
}

[[nodiscard]] QString WallPaperAddress(not_null<PeerData*> peer) {
	if (peer->isUser()) {
		return peer->isSelf() ? SelfAddress() : AddressForUser(peer->asUser());
	}
	return GroupIdForChat(peer);
}

[[nodiscard]] parvane::json LoadChatWallPapers() {
	const auto path = ChatWallPapersPath();
	auto j = path.isEmpty()
		? parvane::json()
		: parvane::json::parse(StoreRead(path).toStdString(), nullptr, false);
	if (!j.is_object() || !j.contains("papers") || !j["papers"].is_object()) {
		return parvane::json::object();
	}
	return j["papers"];
}

} // namespace

void SaveChatWallPaper(not_null<PeerData*> peer, const Data::WallPaper &paper) {
	const auto address = WallPaperAddress(peer);
	const auto path = ChatWallPapersPath();
	if (address.isEmpty() || path.isEmpty()) {
		return;
	}
	auto papers = LoadChatWallPapers();
	papers[address.toStdString()] = paper.serialize().toBase64().toStdString();
	StoreWrite(path, QByteArray::fromStdString(parvane::json{
		{ "self", SelfAddress().toStdString() },
		{ "papers", std::move(papers) },
	}.dump()));
	g_chatPapersCache.reset();
	LOG(("Parvane: обои чата %1 сохранены на устройстве").arg(address));
}

void RestoreChatWallPaper(not_null<PeerData*> peer) {
	if (peer->wallPaper()) {
		return;
	}
	auto &cache = g_chatPapersCache;
	auto &cacheOwner = g_chatPapersOwner;
	if (!cache || cacheOwner != SelfAddress()) {
		cache = LoadChatWallPapers();
		cacheOwner = SelfAddress();
	}
	const auto address = WallPaperAddress(peer).toStdString();
	if (address.empty() || !cache->contains(address) || !(*cache)[address].is_string()) {
		return;
	}
	const auto bytes = QByteArray::fromBase64(QByteArray::fromStdString((*cache)[address].get<std::string>()));
	if (const auto paper = Data::WallPaper::FromSerialized(bytes)) {
		peer->setWallPaper(*paper);
	}
}

} // namespace Parvane

#include "settings/settings_builder.h"
#include "storage/storage_media_prepare.h"
#include "ui/chat/attach/attach_prepare.h"
#include "main/main_session.h"

namespace Parvane {
namespace {

[[nodiscard]] History *RareHistoryOf(not_null<Main::Session*> session, const QString &address) {
	if (address.isEmpty()) {
		return nullptr;
	}
	for (auto i = g_knownGroups.constBegin(); i != g_knownGroups.constEnd(); ++i) {
		if (i.key() == address || i.value() == address) { // адрес либо имя группы
			if (const auto chat = ensureGroupChat(session, i.key(), i.value(), 0)) {
				return session->data().history(chat);
			}
		}
	}
	if (address == SelfAddress()) {
		return session->data().history(session->user());
	}
	return session->data().history(EnsureUser(session, address));
}

[[nodiscard]] std::vector<not_null<HistoryItem*>> RegularItems(not_null<History*> history) {
	auto result = std::vector<not_null<HistoryItem*>>();
	for (const auto &block : history->blocks) {
		for (const auto &view : block->messages) {
			if (!view->data()->isService()) {
				result.push_back(view->data());
			}
		}
	}
	return result;
}

} // namespace

// Шаги PARVANE_AUTOUI этапа 4 (сценарии verify_rare_ui.sh, verify_contacts.sh). Тот же вход, что у кнопки.
//   contactset:<адрес>|<имя>|<фамилия>|<заметка>   contactdel:<адрес>   contactshow:<адрес>
//   pinlast:<адрес>|<сколько>   unpinall:<адрес>   pinned:<адрес>
//   globalmedia:<номер SharedMediaType>   chatsearch:<адрес>|<текст>|<адрес автора>
//   leavegroup:<имя группы>   archivemode:<0|1|2>   profilelink:<адрес>   resolve:<адрес>
//   settingssearch:-   album:<адрес>|<путь>;<путь>…[|spoiler][|invert]   replyquote:<адрес>|<текст>|<цитата>
bool RunRareUiStep(const QString &op, const QStringList &args) {
	const auto session = g_sessionWeak.get();
	if (!session) {
		return false;
	}
	const auto arg = [&](int i) { return args.value(i); };
	if (op == u"contactset"_q) {
		const auto user = EnsureUser(session, arg(0));
		SetContact(user, arg(1), arg(2), arg(3));
	} else if (op == u"contactdel"_q) {
		RemoveContact(EnsureUser(session, arg(0)));
	} else if (op == u"contactshow"_q) {
		const auto user = EnsureUser(session, arg(0));
		LOG(("Parvane: autoui контакт %1: имя=«%2» контакт=%3 заметка=«%4»")
			.arg(arg(0), user->name(), user->isContact() ? u"1"_q : u"0"_q, user->note().text));
	} else if (op == u"pinlast"_q) {
		if (const auto history = RareHistoryOf(session, arg(0))) {
			auto items = RegularItems(history);
			const auto count = std::min(int(items.size()), std::max(arg(1).toInt(), 1));
			for (auto i = int(items.size()) - count; i < int(items.size()); ++i) {
				MirrorPin(items[i], true);
				items[i]->setIsPinned(true);
				Data::SetTopPinnedMessageId(history->peer, items[i]->id);
			}
			LOG(("Parvane: autoui pinlast %1 → закреплено %2").arg(arg(0)).arg(count));
		}
	} else if (op == u"unpinall"_q) {
		if (const auto history = RareHistoryOf(session, arg(0))) {
			UnpinAllMessages(history);
		}
	} else if (op == u"pinned"_q) {
		if (const auto history = RareHistoryOf(session, arg(0))) {
			auto pinned = 0;
			for (const auto item : RegularItems(history)) {
				pinned += item->isPinned() ? 1 : 0;
			}
			LOG(("Parvane: autoui закреплённых в %1: %2").arg(arg(0)).arg(pinned));
		}
	} else if (op == u"globalmedia"_q) {
		const auto type = static_cast<Storage::SharedMediaType>(arg(0).toInt());
		session->api().requestGlobalMedia(type, QString(), 0, Data::MessagePosition(), [=](Api::GlobalMediaResult r) {
			LOG(("Parvane: autoui глобальные медиа тип %1: %2").arg(int(type)).arg(r.messageIds.size()));
		});
	} else if (op == u"chatsearch"_q) {
		const auto history = RareHistoryOf(session, arg(0));
		if (!history) {
			return true;
		}
		const auto search = std::make_shared<Api::MessagesSearch>(history);
		const auto lifetime = std::make_shared<rpl::lifetime>();
		search->messagesFounds() | rpl::on_next([=, a0 = arg(0), a1 = arg(1), a2 = arg(2)](
				const Api::FoundMessages &found) {
			LOG(("Parvane: autoui поиск в чате %1 «%2» от %3 — найдено %4")
				.arg(a0, a1, a2.isEmpty() ? u"всех"_q : a2)
				.arg(found.total));
			(void)search; // держит поиск до ответа
		}, *lifetime);
		auto request = Api::MessagesSearch::Request{ .query = arg(1) };
		if (!arg(2).isEmpty()) {
			request.from = (arg(2) == SelfAddress())
				? static_cast<PeerData*>(session->user().get())
				: EnsureUser(session, arg(2)).get();
		}
		search->searchMessages(std::move(request));
	} else if (op == u"leavegroup"_q) {
		if (const auto history = RareHistoryOf(session, arg(0)); history && history->peer->isChat()) {
			LeaveOrDeleteGroupNow(history->peer, nullptr);
		}
	} else if (op == u"stickerlist"_q || op == u"stickerorder"_q || op == u"stickerremove"_q) {
		// п. 23: тот же вход, что у окна «Стикеры» (ApiWrap::saveStickerSets с новым порядком и удалёнными)
		auto &stickers = session->data().stickers();
		const auto nameOf = [&](uint64 id) {
			return QFileInfo(LocalStickerPackDir(id)).fileName();
		};
		auto order = stickers.setsOrder();
		if (op == u"stickerlist"_q) {
			auto names = QStringList();
			for (const auto id : order) {
				names.push_back(nameOf(id));
			}
			LOG(("Parvane: autoui наборы стикеров: %1").arg(names.join(';')));
			return true;
		}
		auto removed = Data::StickersSetsOrder();
		if (op == u"stickerorder"_q) {
			const auto wanted = arg(0).split(';', Qt::SkipEmptyParts);
			std::stable_sort(order.begin(), order.end(), [&](uint64 a, uint64 b) {
				const auto ia = wanted.indexOf(nameOf(a)), ib = wanted.indexOf(nameOf(b));
				return (ia < 0 ? 1000 : ia) < (ib < 0 ? 1000 : ib);
			});
		} else {
			for (const auto id : order) {
				if (nameOf(id) == arg(0)) {
					removed.push_back(id);
				}
			}
			for (const auto id : removed) {
				order.removeAll(id);
			}
		}
		session->api().saveStickerSets(order, removed, Data::StickersType::Stickers);
	} else if (op == u"clearchat"_q) {
		if (const auto history = RareHistoryOf(session, arg(0))) {
			MirrorClearHistory(history->peer); // тот же путь, что «Очистить историю» (apiwrap.cpp)
		}
	} else if (op == u"archivemode"_q) {
		session->api().globalPrivacy().updateUnarchiveOnNewMessage(
			Api::UnarchiveOnNewMessage(std::clamp(arg(0).toInt(), 0, 2)));
	} else if (op == u"profilelink"_q) {
		LOG(("Parvane: autoui ссылка профиля %1 → %2").arg(arg(0), session->createInternalLinkFull(arg(0))));
	} else if (op == u"resolve"_q) {
		ResolveAddressForLink(session, arg(0), [address = arg(0)](PeerData *peer) {
			LOG(("Parvane: autoui resolve %1 → %2").arg(address, peer ? peer->name() : u"нет"_q));
		});
	} else if (op == u"settingssearch"_q) {
		const auto all = Settings::Builder::SearchRegistry::Instance().collectAll(session);
		auto hidden = QStringList();
		for (const auto &entry : all) {
			for (const auto &prefix : { u"notifications/reactions"_q, u"edit/chat-automation"_q,
					u"chat/themes-edit"_q, u"chat/themes-system-accent"_q }) {
				if (entry.id.startsWith(prefix)) {
					hidden.push_back(entry.id);
				}
			}
		}
		LOG(("Parvane: autoui поиск настроек: всего %1, мёртвых %2 [%3]")
			.arg(all.size()).arg(hidden.size()).arg(hidden.join(',')));
	} else if (op == u"album"_q) {
		const auto history = RareHistoryOf(session, arg(0));
		if (!history) {
			return true;
		}
		// Как окно отправки: картинки — фото (Storage::PrepareMediaList), «Скрыть под спойлер» — у каждого
		auto list = Storage::PrepareMediaList(arg(1).split(';', Qt::SkipEmptyParts), 512, false);
		for (auto &prepared : list.files) {
			prepared.spoiler = args.contains(u"spoiler"_q);
		}
		if (!list.files.empty()) {
			list.files.front().caption = TextWithTags{ u"подпись альбома"_q };
		}
		auto action = Api::SendAction(history);
		action.options.invertCaption = args.contains(u"invert"_q);
		const auto count = int(list.files.size());
		session->api().sendFiles(std::move(list), SendMediaType::Photo, std::make_shared<SendingAlbum>(), action);
		LOG(("Parvane: autoui альбом из %1 → %2").arg(count).arg(arg(0)));
	} else if (op == u"replyquote"_q) {
		const auto history = RareHistoryOf(session, arg(0));
		if (!history) {
			return true;
		}
		auto target = (HistoryItem*)nullptr;
		for (const auto item : RegularItems(history)) {
			if (!item->out()) {
				target = item;
			}
		}
		if (!target) {
			LOG(("Parvane: autoui replyquote — нет входящего в %1").arg(arg(0)));
			return true;
		}
		auto action = Api::SendAction(history);
		action.replyTo = FullReplyTo{
			.messageId = target->fullId(),
			.quote = TextWithEntities{ arg(2) },
			.quoteOffset = int(std::max(qsizetype(0), target->originalText().text.indexOf(arg(2)))),
		};
		auto message = Api::MessageToSend(action);
		message.textWithTags = TextWithTags{ arg(1) };
		session->api().sendMessage(std::move(message));
	} else {
		return false;
	}
	return true;
}

} // namespace Parvane
