// Parvane fork: группы v2 и журнал личного состояния (spec 029, T038 — вынесено из parvane_client.cpp).
#include "parvane/parvane_client_internal.h"

namespace Parvane {

// ── Протокол v2: группы, T080/T119 и журнал личного состояния (spec 007) ─────
// Порт web `src/api/parvane/v2/controller.ts` (группы, ссылки, свои
// устройства) и `stateJournal.ts` (папки/отложенные). Протокол целиком — в
// v2-сессии parvane-core; здесь — перекладка в нативные объекты tdesktop:
// сведения группы из проверенного журнала → тот же parvane::GroupInfo, что у
// v1-групп (ApplyGroupInfo → синтетический ChatData), адрес группы в
// клиентах — "v2g:<hex id>" (как в вебе).

namespace Internal {
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
			NoteGroupPublic(QString::fromStdString(it.key()), it.value());
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

// Публичность групп v2 по сведениям журнала (main): адрес → имя и настройки (spec 023)
QHash<QString, GroupPublicInfo> g_groupPublic;

void NoteGroupPublic(const QString &address, const parvane::json &info) {
	const auto name = info.contains("publicName") && info["publicName"].is_string()
		? QString::fromStdString(info["publicName"].get<std::string>())
		: QString();
	if (name.isEmpty()) {
		g_groupPublic.remove(address);
		return;
	}
	g_groupPublic.insert(address, GroupPublicInfo{
		.name = name,
		.preview = info.value("publicPreview", false),
		.history = info.value("publicHistory", false),
	});
}

void ApplyV2Group(const QString &address, const parvane::json &info, bool isNew) {
	const auto session = g_sessionWeak.get();
	if (!session) {
		return;
	}
	NoteGroupPublic(address, info);
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
	"folders", "scheduled", "notify", "blocked", "archived", "pinned", "drafts",
};
// T024: черновики (как web stateJournal drafts) — адрес → {text, entities, dateMs}. Только main; файл в tdata.
struct DraftEntry {
	QString text;
	nlohmann::json entities = nlohmann::json::array();
	std::int64_t dateMs = 0;
};
QHash<QString, DraftEntry> g_drafts;
bool g_draftsLoaded = false;
void LoadDraftsLocal();
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
	auto drafts = parvane::json::array();
	LoadDraftsLocal();
	for (auto it = g_drafts.constBegin(); it != g_drafts.constEnd(); ++it) {
		auto peer = StatePeerOf(it.key());
		const auto content = parvane::v2::toV2(parvane::textContent(it->text.toStdString(), it->entities));
		if (peer.is_null() || !content || !content->contains("text")) {
			continue;
		}
		try {
			drafts.push_back({
				{ "peer", std::move(peer) },
				{ "text", parvane::v2::toBase64(parvane::v2::encodeMessage("parvane.msg.v2.Text", (*content)["text"])) },
				{ "date_ms", std::to_string(it->dateMs) },
			});
		} catch (const std::exception &e) {
			LOG(("Parvane: v2: черновик %1 не в журнал: %2").arg(it.key(), QString::fromUtf8(e.what())));
		}
	}
	return {
		{ "drafts", std::move(drafts) },
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
		{ "drafts", digest(canon("drafts", false)) },
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
		// Под оградой хранилища: событие прежней сессии после выхода со стиранием маркер не пересоздаёт
		parvane::storecrypt::writeRawFile(NotifyJournaledPath().toStdString(), std::string_view());
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

[[nodiscard]] QString DraftsPath() {
	return cWorkingDir() + u"tdata/parvane-drafts.json"_q;
}

void LoadDraftsLocal() {
	if (g_draftsLoaded) {
		return;
	}
	g_draftsLoaded = true;
	const auto j = parvane::json::parse(StoreRead(DraftsPath()).toStdString(), nullptr, false);
	if (!j.is_object() || j.value("self", std::string()) != SelfAddress().toStdString()) {
		return;
	}
	// items() временного объекта ссылается на уже разрушенный json (-Wdangling-reference) — держим копию
	const auto drafts = j.value("drafts", parvane::json::object());
	for (const auto &[address, d] : drafts.items()) {
		g_drafts.insert(QString::fromStdString(address), DraftEntry{
			QString::fromStdString(d.value("text", std::string())),
			d.value("entities", parvane::json::array()),
			d.value("date_ms", std::int64_t(0)),
		});
	}
}

void SaveDraftsLocal() {
	auto drafts = parvane::json::object();
	for (auto it = g_drafts.constBegin(); it != g_drafts.constEnd(); ++it) {
		drafts[it.key().toStdString()] = {
			{ "text", it->text.toStdString() },
			{ "entities", it->entities },
			{ "date_ms", it->dateMs },
		};
	}
	StoreWrite(DraftsPath(), QByteArray::fromStdString(parvane::json{
		{ "self", SelfAddress().toStdString() },
		{ "drafts", drafts },
	}.dump()));
}

// Снимок журнала → черновики (штатный путь облачного черновика tdesktop: поле ввода обновится само)
void ProjectDrafts(not_null<Main::Session*> session, const parvane::json &snap) {
	if (!snap.contains("drafts") || !snap["drafts"].is_array()) {
		return;
	}
	LoadDraftsLocal();
	auto next = QHash<QString, DraftEntry>();
	for (const auto &d : snap["drafts"]) {
		const auto address = StateAddressOf(d.value("peer", parvane::json()));
		if (address.isEmpty() || !d.contains("text") || !d["text"].is_string()) {
			continue;
		}
		try {
			const auto textJson = parvane::v2::decodeMessage("parvane.msg.v2.Text",
				parvane::v2::fromBase64(d["text"].get<std::string>()));
			const auto wire = parvane::v2::fromV2(parvane::json{ { "text", textJson } });
			if (!wire || wire->value("text", std::string()).empty()) {
				continue;
			}
			const auto ms = d.contains("date_ms") && d["date_ms"].is_string()
				? std::atoll(d["date_ms"].get<std::string>().c_str())
				: d.value("date_ms", std::int64_t(0));
			next.insert(address, DraftEntry{
				QString::fromStdString(wire->value("text", std::string())),
				parvane::contentEntities(*wire),
				ms,
			});
		} catch (const std::exception &) {
		}
	}
	auto addresses = QSet<QString>();
	for (auto it = g_drafts.constBegin(); it != g_drafts.constEnd(); ++it) addresses.insert(it.key());
	for (auto it = next.constBegin(); it != next.constEnd(); ++it) addresses.insert(it.key());
	auto changed = 0;
	for (const auto &address : addresses) {
		const auto before = g_drafts.value(address).text;
		const auto after = next.value(address).text;
		if (before == after) {
			continue;
		}
		const auto history = HistoryForAddress(session, address);
		if (!history) {
			continue;
		}
		const auto peerId = history->peer->id;
		const auto date = TimeId(next.value(address).dateMs / 1000);
		if (after.isEmpty()) {
			Data::ClearPeerCloudDraft(session, peerId, MsgId(), PeerId(), date ? date : base::unixtime::now());
		} else {
			const auto entities = Api::EntitiesToMTP(session, entitiesFromJson(next.value(address).entities),
				Api::ConvertOption::SkipLocal);
			using DFlag = MTPDdraftMessage::Flag;
			const auto draft = MTP_draftMessage(
				MTP_flags(entities.v.isEmpty() ? DFlag(0) : DFlag::f_entities),
				MTPInputReplyTo(),
				MTP_string(after),
				entities,
				MTPInputMedia(),
				MTP_int(date ? date : base::unixtime::now()),
				MTPlong(),
				MTPSuggestedPost(),
				MTPRichMessage());
			Data::ApplyPeerCloudDraft(session, peerId, MsgId(), PeerId(), draft.c_draftMessage());
		}
		++changed;
	}
	g_drafts = next;
	SaveDraftsLocal();
	if (changed) {
		LOG(("Parvane: журнал состояния → черновики (%1 изменений)").arg(changed));
	}
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
	ProjectDrafts(session, snap);
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
	const auto generation = AccountGeneration();
	crl::async([desired, generation] {
		if (!AccountGenerationIs(generation)) {
			return;
		}
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
			crl::on_main([desired, generation] {
				if (AccountGenerationIs(generation)) {
					SaveStateSynced(desired);
				}
			});
			return;
		}
		crl::on_main([snap = r["snapshot"], generation] {
			if (!AccountGenerationIs(generation)) {
				return;
			}
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
	base::call_delayed(crl::time(700), [generation = AccountGeneration()] {
		if (!AccountGenerationIs(generation)) {
			return; // правка прежнего аккаунта — не в журнал следующего
		}
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
	const auto generation = AccountGeneration();
	// Маркер сценария verify_relogin_other_account.sh: что этот аккаунт несёт в журнал при подключении
	LOG(("Parvane: v2: журнал состояния — подключение (черновиков %1, отложенных %2)")
		.arg(int(local.value("drafts", parvane::json::array()).size()))
		.arg(int(local.value("scheduled", parvane::json::array()).size())));
	crl::async([local, dirty, generation] {
		if (!AccountGenerationIs(generation)) {
			return; // состояние прежнего аккаунта — не в журнал следующего
		}
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
		crl::on_main([snap, generation] {
			const auto session = g_sessionWeak.get();
			if (!session || !AccountGenerationIs(generation)) {
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
	const auto generation = AccountGeneration();
	crl::async([item, opId, generation] {
		auto sent = false;
		if (const auto s = V2Ready()) {
			try {
				sent = s->stateScheduledSent(opId);
			} catch (const std::exception &) {
			}
		}
		crl::on_main([item, opId, sent, generation] {
			if (!AccountGenerationIs(generation)) {
				return; // отложенное прежнего аккаунта — не от имени следующего
			}
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

// Задача события сессии — на главный поток, только если аккаунт за это время не сменился (ревью 21 окт,
// вечер: событие сессии прежнего аккаунта, дошедшее после выхода, наполняло память следующего)
template <typename Callable>
void OnMainForAccount(Callable &&callable) {
	crl::on_main([generation = AccountGeneration(), callable = std::forward<Callable>(callable)]() mutable {
		if (AccountGenerationIs(generation)) {
			callable();
		}
	});
}

// Событие v2-сессии (рабочий поток) → main.
bool HandleV2SessionEvent(const parvane::json &ev) {
	const auto type = ev.is_object() ? ev.value("type", std::string()) : std::string();
	if (type == "plannerChanged" || type == "cloudChanged") {
		Sections::OnEngineEvent(ev); // spec 029: «План», «Облако»
		return true;
	}
	if (type == "stateReady") {
		Sections::OnSessionChanged();
	}
	const auto address = QString::fromStdString(ev.value("address", std::string()));
	if (type == "groupUpdated") {
		OnMainForAccount([address, info = ev.value("info", parvane::json()), isNew = ev.value("isNew", false)] {
			ApplyV2Group(address, info, isNew);
		});
		return true;
	}
	if (type == "groupLeft") {
		OnMainForAccount([address] {
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
		OnMainForAccount([address, members] { AnnounceUnconfirmed(address, members); });
		return true;
	}
	if (type == "peerRenamed") {
		// RENAME-1: собеседник сменил ник — тот же чат, служебное сообщение
		const auto from = QString::fromStdString(ev.value("from", std::string()));
		const auto to = QString::fromStdString(ev.value("to", std::string()));
		if (NoteRename(from, to)) {
			RegisterPeer(to);
			OnMainForAccount([from, to] { AnnounceRename(from, to); });
		}
		return true;
	}
	if (type == "peerDeleted") {
		// spec 027: аккаунт собеседника удалён — «Удалённый аккаунт»
		const auto user = QString::fromStdString(ev.value("user", std::string()));
		OnMainForAccount([user] { MarkPeerDeleted(user, true); });
		return true;
	}
	if (type == "peerRootChanged") {
		// KEY-1 v2 (T129): у собеседника сменился корень личности — то же
		// служебное сообщение «ключ безопасности изменился», что в v1.
		const auto user = QString::fromStdString(ev.value("user", std::string()));
		LOG(("Parvane: v2: у %1 сменился корневой ключ — предупреждение в чате").arg(user));
		V2NoteRoot(V2Ready(), user.toStdString());
		OnMainForAccount([user] { AnnounceKeyChange(user); });
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
					OnMainForAccount([] {
						if (const auto window = Core::App().activeWindow()) {
							window->showToast(IsRussianUi()
								? u"Устройство отозвано: смените ключ подписи устройств "
									"в настройках приватности (нужен ключ восстановления)."_q
								: u"Device revoked: change the device signing key "
									"in Privacy settings (requires the recovery key)."_q);
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
		OnMainForAccount([=] {
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
		OnMainForAccount([count] { AnnounceNewOwnDevices(count); });
		return true;
	}
	if (type == "stateReady") {
		OnMainForAccount([] {
			AttachStateJournal();
			RetryFailedLocationMaps(); // карты геолокации, не собранные без связи, — повторить сразу
		});
		crl::async([] {
			StartHistoryLinking(); // роль «старого» устройства: опрос чужих офферов
			SyncFromKeyBundle();   // снимок истории свежее применённого — с другого своего устройства
		});
		PublishLinkingStatus();
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
		return true; // кадры v1 больше не разбираются (spec 029): v1 удалён
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
		crl::async([] {
			StartDeviceLinkOfferForV2();
			StartTelegramRecovery(false);
		});
		PublishLinkingStatus();
		OnMainForAccount([] {
			if (!HeadlessUi()) {
				ShowLinkingBox();
			}
		});
		return true;
	}
	if (type == "callSignal") {
		// Сигнал личного звонка по v2: отправителя проверил движок. Менеджер
		// зовём БЕЗ g_sessionMutex (его колбэки берут этот мьютекс сами).
		const auto from = ev.value("from", std::string());
		const auto signal = ev.contains("signal") ? ev["signal"] : parvane::json::object();
		if (ev.value("group", false)) {
			// Групповой звонок (T141): приглашение либо попарный сигнал mesh
			std::shared_ptr<parvane::GroupCallManager> g;
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				g = g_groupCallManager;
			}
			if (g && !from.empty() && signal.is_object()) {
				LOG(("Parvane: v2 ← %1 сигнал группового звонка (%2)").arg(
					QString::fromStdString(from),
					QString::fromStdString(signal.value("type", std::string()))));
				g->handleV2Signal(from, signal);
			}
			return true;
		}
		std::shared_ptr<parvane::CallManager> m;
		{
			std::lock_guard<std::mutex> lk(g_sessionMutex);
			m = g_callManager;
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
		OnMainForAccount([entered, released] {
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
		OnMainForAccount([sm] {
			if (const auto session = g_sessionWeak.get()) {
				injectOnMain(session, { sm }, /*live=*/true);
			}
		});
		return true;
	}
	return false;
}


// Личное состояние (T132): публичные точки врезки нативных путей.
} // namespace Internal
void MirrorBlock(not_null<PeerData*> peer, bool blocked) {
	NoteBlock(peer, blocked);
}

bool MirrorDraft(not_null<History*> history, const TextWithTags &text) {
	if (!SessionActive()) {
		return false;
	}
	const auto address = HistoryAddress(history);
	if (address.isEmpty()) {
		return true;
	}
	LoadDraftsLocal();
	const auto clean = text.text.trimmed();
	if (g_drafts.value(address).text == text.text && (clean.isEmpty() == !g_drafts.contains(address))) {
		return true;
	}
	if (clean.isEmpty()) {
		if (!g_drafts.remove(address)) {
			return true;
		}
	} else {
		g_drafts.insert(address, DraftEntry{
			text.text,
			entitiesToJson(TextUtilities::ConvertTextTagsToEntities(text.tags)),
			QDateTime::currentMSecsSinceEpoch(),
		});
	}
	SaveDraftsLocal();
	ScheduleStateFlush("drafts");
	return true;
}

// Выход из аккаунта / вход другим (ревью 21 окт 2026, вечер): черновики, журнал состояния, сведения групп v2
// прежнего — прочь из памяти. Иначе первое подключение журнала следующего аккаунта (BuildLocalState →
// stateAttach) переносило в его журнал черновики и отложенные прежнего.
void ResetStateAccountData() {
	g_drafts.clear();
	g_draftsLoaded = false;
	g_stateAttached = false;
	g_stateApplying = false;
	g_stateFlushQueued = false;
	g_stateTimer = nullptr;
	g_stateSyncedSaved.clear();
	g_migrationTriedAt.clear();
	g_groupPublic.clear();
}

} // namespace Parvane
