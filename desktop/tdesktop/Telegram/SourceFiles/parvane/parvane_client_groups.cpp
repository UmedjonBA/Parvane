// Parvane fork: группы: сведения, управление, ссылки, заявки, публичные (spec 029, T038 — вынесено из parvane_client.cpp).
#include "parvane/parvane_client_internal.h"
#include <parvane/chat_rules.h> // parvane-core: потолок скачивания картинки

namespace Parvane {


// Гарантирует, что пир (отправитель) существует и «загружен» в Data::Session.
// Синтезируем MTPUser с first_name = адрес, чтобы диалог имел имя. Идемпотентно.
namespace Internal {
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

// Время первого появления группы на этом устройстве (main): строке списка чатов нужна дата, а у группы без
// сообщений её нет — tdesktop такой чат не показывает (web показывает сразу, spec 030). Дата хранится, чтобы
// пустая группа не всплывала наверх при каждом запуске; первое же сообщение её перезапишет.
[[nodiscard]] TimeId GroupFirstSeen(const QString &gid) {
	static auto loadedFrom = QString();
	static auto seen = QHash<QString, TimeId>();
	const auto path = cWorkingDir() + u"tdata/parvane-groups-seen.json"_q;
	// Файл — аккаунта (ревью 21 окт, вечер): другой аккаунт — перечитать, память прежнего не переносить
	const auto key = path + u'\n' + SelfAddress();
	if (loadedFrom != key) {
		loadedFrom = key;
		seen.clear();
		const auto j = nlohmann::json::parse(StoreRead(path).toStdString(), nullptr, false);
		if (j.is_object()) {
			for (const auto &[key, value] : j.items()) {
				if (value.is_number_integer()) {
					seen.insert(QString::fromStdString(key), TimeId(value.get<std::int64_t>()));
				}
			}
		}
	}
	if (const auto i = seen.constFind(gid); i != seen.constEnd()) {
		return *i;
	}
	const auto now = base::unixtime::now();
	seen.insert(gid, now);
	auto j = nlohmann::json::object();
	for (auto i = seen.cbegin(); i != seen.cend(); ++i) {
		j[i.key().toStdString()] = std::int64_t(i.value());
	}
	StoreWrite(path, QByteArray::fromStdString(j.dump()));
	return now;
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
		if (!history->chatListTimeId()) {
			history->setChatListTimeId(GroupFirstSeen(gid)); // группа без сообщений — тоже в списке (spec 030)
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
	// Группа v2: ключи — эпохи движка (новая эпоха по записи журнала).
	(void)recipients;
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
	// Снова участник (вступил из превью публичной группы или вернулся) — чат не «покинут»
	if (!selfRole.empty() && selfRole != "banned") {
		chat->removeFlags(ChatDataFlag::Left);
	}
	if (selfRole == "owner") {
		chat->addFlags(ChatDataFlag::Creator);
		chat->setAdminRights(adminRightsFrom(parvane::AdminRights{}));
	} else {
		chat->removeFlags(ChatDataFlag::Creator);
		chat->setAdminRights(selfRole == "admin"
			? adminRightsFrom(selfRights)
			: ChatAdminRights());
	}
	// Права по умолчанию только у групп: в канале пишут владелец и админы — у подписчика композер закрыт
	// (владелец и админы освобождены от ограничений по умолчанию, как в группе).
	auto channelPerms = parvane::DefaultPermissions();
	channelPerms.send_messages = channelPerms.send_media = channelPerms.send_stickers_gifs = false;
	channelPerms.send_polls = channelPerms.embed_links = channelPerms.invite_users = false;
	chat->setDefaultRestrictions(restrictionsFromPerms(gi.kind == "channel"
		? channelPerms
		: gi.default_permissions));
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


// ── spec 004: доступ к кэшу сведений группы (main-поток), публичные функции
// экранов управления (объявлены в parvane_client.h) ───────────────────────
} // namespace Internal
std::optional<parvane::GroupInfo> GroupInfoFor(const QString &gid) {
	const auto it = g_groupInfo.constFind(gid);
	return (it == g_groupInfo.constEnd())
		? std::nullopt
		: std::optional<parvane::GroupInfo>(it.value());
}

bool IsChannelChat(not_null<PeerData*> peer) {
	if (!peer->isChat()) {
		return false;
	}
	const auto gid = GroupIdForChat(peer);
	if (gid.isEmpty()) {
		return false;
	}
	const auto it = g_groupInfo.constFind(gid);
	return (it != g_groupInfo.constEnd()) && (it->kind == "channel");
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
// Группа не v2: групп v1 больше нет (spec 029) — отказ без сети.
void GroupV1Gone(GroupOpDone done) {
	if (done) {
		crl::on_main([done = std::move(done)] { done(false, u"bad_request"_q); });
	}
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
	GroupV1Gone(std::move(done));
}

void ClearGroupPhoto(const QString &groupId, GroupOpDone done) {
	if (RunV2GroupChange(u"SETINFO clear_avatar '%1'"_q.arg(groupId), groupId, [](const nlohmann::json &info) {
			return V2SetInfo(info, std::nullopt, std::nullopt, std::string());
		}, done)) {
		return;
	}
	GroupV1Gone(std::move(done));
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
	if (RunV2GroupChange(u"SETADMIN '%1' %2 %3"_q.arg(groupId, member, isPromotion ? u"rights"_q : u"demote"_q),
			groupId, [member, isPromotion, wire](const nlohmann::json &) {
				return nlohmann::json{ { "set_role", {
					{ "member", { { "address", member.toStdString() } } },
					{ "role", isPromotion ? "ROLE_ADMIN" : "ROLE_MEMBER" },
					{ "rights", isPromotion ? wire.toJson() : nlohmann::json::object() } } } };
			}, done)) {
		return;
	}
	GroupV1Gone(std::move(done));
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
	GroupV1Gone(std::move(done));
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
		const auto t = ControlSnapshot();
		std::string fileId;
		if (t && !bytesStd.empty()) {
			try {
				fileId = t->uploadBlob(bytesStd, /*isPublic=*/true);
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
		GroupV1Gone(done);
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
	// Группы v2 приходят событиями журнала (groupUpdated); списка с сервера нет, «печатает…» групп —
	// эфемерными каналами сессии (ensureEphemeral при публикации группы). Делать нечего.
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
		LOG(("Parvane: группа '%1' не создана (сессия v2 не готова)").arg(QString::fromStdString(nameStd)));
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
	LOG(("Parvane: админ-действие над %1: группа не v2").arg(groupId));
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
}

// ── US4/US5: инвайт-ссылки, вступление, заявки (spec 004) ────────────────────
// Универсальный воркер запроса: op(client, token) → T на воркере, done(optional<T>,
// error) на main. Исключения транспорта → error.


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
[[nodiscard]] GroupInviteLink V2InviteLink(const nlohmann::json &r, bool revoked = false) {
	auto l = GroupInviteLink();
	l.token = QString::fromStdString(r.value("url", std::string()));
	const auto creator = QString::fromStdString(r.value("creator", std::string()));
	l.createdBy = creator.isEmpty() ? SelfAddress() : creator;
	l.title = QString::fromStdString(r.value("title", std::string()));
	l.state = revoked ? u"revoked"_q : u"active"_q;
	l.revoked = revoked;
	l.date = int(r.value("date", std::int64_t(0)));
	l.expireDate = int(r.value("expiresAt", std::int64_t(0)));
	l.usageLimit = int(r.value("usageLimit", 0));
	l.usage = int(r.value("usage", 0));
	l.requestApproval = r.value("isRequestNeeded", false);
	return l;
}

// Основная ссылка (как web pickPrimaryInvite): первая без названия, срока и лимита; открытая в приоритете,
// иначе — с одобрением (группа «по заявке»).
void MarkPrimaryInvite(std::vector<GroupInviteLink> &links) {
	const auto plain = [](const GroupInviteLink &l) {
		return l.title.isEmpty() && !l.expireDate && !l.usageLimit && !l.revoked;
	};
	auto chosen = -1;
	for (auto i = 0; i != int(links.size()); ++i) {
		if (plain(links[i]) && !links[i].requestApproval) {
			chosen = i;
			break;
		}
	}
	for (auto i = 0; chosen < 0 && i != int(links.size()); ++i) {
		if (plain(links[i])) {
			chosen = i;
		}
	}
	for (auto i = 0; i != int(links.size()); ++i) {
		links[i].permanent = (i == chosen);
	}
}

// id ссылки v2 (hex) по адресу https://<domain>/join/<id base64url>#<секрет>
[[nodiscard]] std::string InviteLinkIdHex(const QString &url) {
	const auto at = url.indexOf(u"/join/"_q);
	if (at < 0) {
		return std::string();
	}
	auto id = url.mid(at + 6).section('#', 0, 0).section('?', 0, 0);
	id.replace('-', '+').replace('_', '/');
	while (id.size() % 4) {
		id += '=';
	}
	return parvane::v2::b64ToHex(id.toStdString());
}

void ListGroupInvites(const QString &groupId, bool revoked,
		Fn<void(bool ok, std::vector<GroupInviteLink> links, const QString &error)> done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		// Отозванные ссылки v2 из журнала исчезают (сервер знает только link_id).
		crl::async([=] {
			auto links = std::vector<GroupInviteLink>();
			const auto s = V2Ready();
			if (s) {
				const auto records = revoked
					? s->listRevokedInvites(groupId.toStdString())
					: s->listInvites(groupId.toStdString());
				for (const auto &r : records) {
					links.push_back(V2InviteLink(r, revoked));
				}
				if (!revoked) {
					MarkPrimaryInvite(links);
				}
			}
			LOG(("Parvane: ссылки v2 %1 (%2): %3").arg(groupId,
				revoked ? u"отозванные"_q : u"активные"_q).arg(int(links.size())));
			crl::on_main([=] { done(s != nullptr, links, s ? QString() : u"failed"_q); });
		});
		return;
	}
	done(false, {}, u"bad_request"_q);
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
	done(false, {}, u"bad_request"_q);
}

void FetchPublicImage(const QString &fileId, Fn<void(QImage image, QByteArray bytes)> done) {
	const auto self = SelfAddress().toStdString();
	const auto token = Token().toStdString();
	const auto fid = fileId.toStdString();
	crl::async([=] {
		const auto t = ControlSnapshot();
		std::string bytes;
		if (t) {
			try {
				auto d = DownloadChatBlob(
					fid,
					parvane::chatrules::chatBlobCipherCap("avatar", 0));
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
			LOG(("Parvane: INVITE revoke %1 → %2 (v2)").arg(LogSecret(token), ok ? u"ok"_q : u"отказ"_q));
			crl::on_main([=] {
				if (done) {
					done(ok, ok ? QString() : u"failed"_q);
				}
			});
		});
		return;
	}
	GroupV1Gone(std::move(done));
}

void DeleteGroupInvite(const QString &groupId, const QString &token, GroupOpDone done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		// Отозванная ссылка v2 — из списка отозванных у сервера (T188)
		const auto linkId = InviteLinkIdHex(token);
		crl::async([=] {
			const auto s = V2Ready();
			const auto ok = s && !linkId.empty() && s->deleteRevokedInvite(groupId.toStdString(), linkId);
			LOG(("Parvane: INVITE delete %1 → %2 (v2)").arg(LogSecret(token), ok ? u"ok"_q : u"отказ"_q));
			crl::on_main([=] {
				if (done) {
					done(ok, ok ? QString() : u"failed"_q);
				}
			});
		});
		return;
	}
	GroupV1Gone(std::move(done));
}

void EditGroupInvite(const QString &groupId, const QString &url, const QString &title, int expireDate,
		int usageLimit, Fn<void(bool ok, GroupInviteLink link, const QString &error)> done) {
	crl::async([=] {
		const auto s = V2Ready();
		const auto ok = s && s->editInvite(groupId.toStdString(), url.toStdString(), title.toStdString(),
			expireDate, std::uint32_t(std::max(usageLimit, 0)));
		auto link = GroupInviteLink();
		if (ok) {
			auto links = std::vector<GroupInviteLink>();
			for (const auto &r : s->listInvites(groupId.toStdString())) {
				links.push_back(V2InviteLink(r));
			}
			MarkPrimaryInvite(links);
			for (const auto &l : links) {
				if (l.token == url) {
					link = l;
				}
			}
		}
		LOG(("Parvane: INVITE edit %1 → %2 (v2)").arg(url, ok ? u"ok"_q : u"отказ"_q));
		crl::on_main([=] { done(ok, link, ok ? QString() : u"failed"_q); });
	});
}

void ListInviteJoins(const QString &groupId, const QString &url,
		Fn<void(std::vector<std::pair<QString, int>> joined)> done) {
	const auto linkId = InviteLinkIdHex(url);
	crl::async([=] {
		auto out = std::vector<std::pair<QString, int>>();
		if (const auto s = V2Ready(); s && !linkId.empty()) {
			for (const auto &j : s->listInviteJoins(groupId.toStdString(), linkId)) {
				out.emplace_back(QString::fromStdString(j.value("user", std::string())),
					int(j.value("date", std::int64_t(0))));
			}
		}
		crl::on_main([=] { done(out); });
	});
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
	LOG(("Parvane: INVITE check → отказ invalid (не ссылка v2)"));
	done(false, {}, u"invalid"_q);
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
	LOG(("Parvane: INVITE join → отказ invalid (не ссылка v2)"));
	done(false, QString(), false, u"invalid"_q);
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
							QString::fromStdString(q.value("linkId", std::string())),
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
	done(false, {}, u"bad_request"_q);
}

void DecideJoinRequest(const QString &groupId, const QString &member, bool approve, GroupOpDone done) {
	if (parvane::v2::isGroupAddress(groupId.toStdString())) {
		// Заявка v2 (T143): одобрение — запись AddMember журнала и новая эпоха
		const auto tag = u"REQUEST %1 %2"_q.arg(approve ? u"approve"_q : u"decline"_q, member);
		crl::async([=] {
			const auto s = V2Ready();
			// spec 024: ссылка, по которой пришла заявка, — одобренный считается вступившим по ней
			auto linkId = std::string();
			if (s && approve) {
				const auto requests = s->listJoinRequests(groupId.toStdString());
				for (const auto &q : requests.is_array() ? requests : nlohmann::json::array()) {
					if (q.value("user", std::string()) == member.toStdString()) {
						linkId = q.value("linkId", std::string());
					}
				}
			}
			const auto ok = s && s->decideJoinRequest(groupId.toStdString(), member.toStdString(), approve, linkId);
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
	GroupV1Gone(std::move(done));
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
		LOG(("Parvane: ссылка группы %1 — нет активного окна").arg(LogSecret(token)));
		return true;
	}
	Api::CheckChatInvite(controller, token);
	return true;
}
void LeaveGroup(const QString &groupId) {
	groupAdminAction(groupId, SelfAddress(), u"remove"_q); // сам себя = выйти
}


namespace Internal {
constexpr auto kReportSubmitMark = ":send";
constexpr auto kReportCommentMax = 1024;
constexpr auto kReportTextMax = 4096;
constexpr auto kReportFallbackMax = 600;

[[nodiscard]] std::vector<std::pair<QByteArray, QString>> ReportReasons() {
	return {
		{ "spam", tr::lng_parvane_report_reason_spam(tr::now) },
		{ "violence", tr::lng_parvane_report_reason_violence(tr::now) },
		{ "porn", tr::lng_parvane_report_reason_porn(tr::now) },
		{ "child", tr::lng_parvane_report_reason_child(tr::now) },
		{ "copyright", tr::lng_parvane_report_reason_copyright(tr::now) },
		{ "illegal", tr::lng_parvane_report_reason_illegal(tr::now) },
		{ "personal", tr::lng_parvane_report_reason_personal(tr::now) },
		{ "fake", tr::lng_parvane_report_reason_fake(tr::now) },
		{ "other", tr::lng_parvane_report_reason_other(tr::now) },
	};
}

// Админы группы v2 с правом удалять сообщения или банить (кроме себя) — как web reportAdmins.
[[nodiscard]] std::vector<std::string> ReportAdmins(const QString &gid) {
	auto out = std::vector<std::string>();
	if (!parvane::v2::isGroupAddress(gid.toStdString())) {
		return out;
	}
	const auto self = SelfAddress().toStdString();
	const auto it = g_groupInfo.constFind(gid);
	if (it == g_groupInfo.constEnd()) {
		return out;
	}
	for (const auto &m : it->members) {
		if (m.address == self) {
			continue;
		}
		const auto rights = m.admin_rights.value_or(parvane::AdminRights());
		if (m.role == "owner" || (m.role == "admin" && (rights.delete_messages || rights.ban_users))) {
			out.push_back(m.address);
		}
	}
	return out;
}

void ShowReportOutcome(const QString &outcome) {
	if (const auto window = Core::App().activeWindow()) {
		window->showToast((outcome == u"sent"_q)
			? tr::lng_parvane_report_sent(tr::now)
			: (outcome == u"unavailable"_q)
			? tr::lng_parvane_report_unavailable(tr::now)
			: tr::lng_parvane_report_failed(tr::now));
	}
}


} // namespace Internal
void ReportMessages(
		not_null<PeerData*> peer,
		const QByteArray &optionId,
		const QString &comment,
		const std::vector<MsgId> &ids,
		Fn<void(ReportStep)> done) {
	const auto address = peer->isChat()
		? GroupIdForChat(peer)
		: AddressForId(std::uint64_t(peerToUser(peer->id).bare));
	if (address.isEmpty()) {
		done({ .error = u"PARVANE_NO_PEER"_q });
		return;
	}
	const auto admins = ids.empty() ? std::vector<std::string>() : ReportAdmins(address);
	if (optionId.isEmpty()) {
		done({
			.options = ReportReasons(),
			.title = admins.empty()
				? tr::lng_parvane_report_to_server_title(tr::now)
				: tr::lng_parvane_report_to_admins_title(tr::now),
		});
		return;
	}
	// Второй шаг — необязательный комментарий; отметка в id отличает отправку от него
	if (!optionId.endsWith(kReportSubmitMark)) {
		done({ .commentId = optionId + kReportSubmitMark });
		return;
	}
	const auto reason = optionId.left(optionId.size() - int(std::strlen(kReportSubmitMark))).toStdString();
	const auto note = comment.left(kReportCommentMax).toStdString();
	auto reported = parvane::json::array();
	auto fallback = QStringList();
	for (const auto &id : ids) {
		const auto item = peer->owner().message(peer->id, id);
		const auto uuid = g_msgIdToUuid.value(id.bare);
		const auto from = item ? item->from().get() : nullptr;
		const auto author = (from && from->isUser())
			? AddressForId(std::uint64_t(peerToUser(from->id).bare))
			: QString();
		if (!item || uuid.isEmpty() || author.isEmpty()) {
			continue;
		}
		// Без текста (фото, видео, стикер) — пометка: само вложение жалоба не несёт
		auto text = item->originalText().text;
		if (text.isEmpty()) {
			text = u"[media]"_q;
		}
		fallback.push_back(text);
		reported.push_back({
			{ "op_id", uuid.toStdString() },
			{ "author", author.toStdString() },
			{ "text", text.left(kReportTextMax).toStdString() },
			{ "ts", std::int64_t(item->date()) },
		});
	}
	const auto chat = address.toStdString();
	const auto self = SelfAddress().toStdString();
	crl::async([=] {
		auto outcome = QString();
		if (!admins.empty() && !reported.empty()) {
			const auto hex = parvane::v2::groupHex(chat);
			auto content = parvane::json{
				{ "kind", "mod_report" },
				{ "report_group", {
					{ "domain", self.substr(self.find('@') == std::string::npos ? self.size() : self.find('@') + 1) },
					{ "id", parvane::v2::hexToB64(hex) },
				} },
				{ "reason", reason },
				{ "reported", reported },
				{ "text", (u"⚠️ "_q + fallback.join(u" / "_q)).left(kReportFallbackMax).toStdString() },
			};
			if (!note.empty()) {
				content["comment"] = note;
			}
			auto sent = false;
			for (const auto &admin : admins) {
				sent = !sendSealedDirect(admin, content).empty() || sent;
			}
			outcome = sent ? u"sent"_q : u"failed"_q;
		} else if (const auto s = V2Ready()) {
			outcome = QString::fromStdString(s->submitReport({
				{ "version", 1 },
				{ "reason", reason },
				{ "comment", note },
				{ "chat", chat },
				{ "target", reported.empty() ? chat : reported[0].value("author", chat) },
				{ "messages", reported },
			}));
		} else {
			outcome = u"failed"_q;
		}
		LOG(("Parvane: жалоба (%1) → %2").arg(QString::fromStdString(reason), outcome));
		crl::on_main([=] {
			ShowReportOutcome(outcome);
			done((outcome == u"sent"_q)
				? ReportStep{ .successful = true }
				: ReportStep{ .error = u"PARVANE_REPORT_"_q + outcome });
		});
	});
}

// ── публичные группы (spec 023, как web groups.ts) ─────────────────────────

// Публичные группы, показанные не-участнику (поиск): адрес → имя и настройки каталога. Только main.
namespace Internal {
QHash<QString, GroupPublicInfo> g_publicPreviews;
QSet<QString> g_loadedPreviews; // превью ленты уже загружено

[[nodiscard]] QString PublicNameError(const std::string &reason) {
	return (reason == "taken") ? u"taken"_q : u"invalid"_q;
}

// Чат публичной группы из карточки каталога: участнику — обычный, иначе превью с «Вступить».
ChatData *AnnouncePublicCard(not_null<Main::Session*> session, const parvane::json &card) {
	const auto group = card.value("group", parvane::json::object());
	const auto id = group.is_object() ? group.value("id", std::string()) : std::string();
	const auto hex = QString::fromStdString(parvane::v2::b64ToHex(id));
	if (hex.size() != 32) {
		return nullptr;
	}
	const auto address = u"v2g:"_q + hex;
	const auto self = SelfAddress().toStdString();
	if (const auto known = g_groupInfo.constFind(address); known != g_groupInfo.constEnd()) {
		for (const auto &m : known->members) {
			if (m.address == self && m.role != "banned") {
				return session->data().chatLoaded(ChatId(BareId(IdForAddress(address))));
			}
		}
	}
	const auto name = QString::fromStdString(card.value("name", std::string()));
	g_publicPreviews.insert(address, GroupPublicInfo{
		.name = name,
		.preview = card.value("preview", false),
		.history = card.value("history", false),
	});
	auto gi = parvane::GroupInfo();
	gi.group_id = address.toStdString();
	gi.name = card.value("title", std::string());
	if (gi.name.empty()) {
		gi.name = name.toStdString();
	}
	gi.kind = (card.value("kind", std::string()) == "GROUP_KIND_CHANNEL") ? "channel" : "group";
	gi.avatar = card.value("avatar_file_id", std::string());
	gi.about = card.value("about", std::string());
	ApplyGroupInfo(session, gi, u"v2 каталог"_q);
	const auto chat = session->data().chatLoaded(ChatId(BareId(IdForAddress(address))));
	if (chat) {
		chat->addFlags(ChatDataFlag::Left);
		chat->count = int(card.value("members", 0));
		session->changes().peerUpdated(chat, Data::PeerUpdate::Flag::Members);
	}
	return chat;
}


} // namespace Internal
GroupPublicInfo GroupPublic(not_null<PeerData*> peer) {
	const auto gid = GroupIdForChat(peer);
	const auto it = g_groupPublic.constFind(gid);
	return (it == g_groupPublic.constEnd()) ? GroupPublicInfo() : it.value();
}

// Выход из аккаунта / вход другим (ревью 21 окт 2026, вечер)
void ResetGroupsAccountData() {
	g_publicPreviews.clear();
	g_loadedPreviews.clear();
}

} // namespace Parvane
