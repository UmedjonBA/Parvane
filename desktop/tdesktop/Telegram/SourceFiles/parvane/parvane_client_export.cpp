// Parvane fork: данные разделов и выгрузка данных (spec 029, T038 — вынесено из parvane_client.cpp).
#include "parvane/parvane_client_internal.h"

namespace Parvane {

// ── spec 029, L3: данные разделов ────────────────────────────────────────────

std::shared_ptr<parvane::v2::Session> SectionsSession() {
	return V2Ready();
}

QString SectionsStateDir(const std::string &self) {
	return self.empty() ? QString() : V2StateDir(QString::fromStdString(self));
}

QByteArray SectionsRead(const QString &path) {
	return StoreRead(path);
}

bool SectionsWrite(const QString &path, const QByteArray &data) {
	return StoreWrite(path, data);
}

// ── spec 029, T036: «Выгрузка данных» — снимок переписки и вложения ──────────
// Порт web `parvaneExportSnapshot` / `parvaneExportMedia`: всё — с устройства (журнал истории + кэш правок v2),
// на сервер ничего не уходит, кроме скачивания вложений, которых нет в кэше.

std::string ExportSnapshotJson(const QStringList &contacts) {
	const auto self = SelfAddress();
	if (self.isEmpty()) {
		return std::string();
	}
	LoadV2Ids();
	const auto isSelf = [&](const QString &address) {
		return !address.isEmpty() && (address == self || LatestAddress(address) == self);
	};
	// Последняя строка журнала по id (порядок — первого появления); правки и реакции — из кэша v2
	auto order = std::vector<std::string>();
	auto rows = std::map<std::string, nlohmann::json>();
	for (const auto &line : StoreReadLines(HistoryPath())) {
		try {
			auto row = nlohmann::json::parse(line.toStdString());
			const auto id = row.value("id", std::string());
			if (id.empty()) {
				continue;
			}
			if (!rows.contains(id)) {
				order.push_back(id);
			}
			rows[id] = std::move(row);
		} catch (const std::exception &) {
		}
	}
	{
		std::lock_guard<std::mutex> lk(g_v2Mutex);
		for (auto &[id, row] : rows) {
			const auto it = g_v2Cache.find(QString::fromStdString(id));
			if (it != g_v2Cache.end()) {
				row = it.value().toJson();
			}
		}
	}
	auto list = std::vector<nlohmann::json>();
	list.reserve(order.size());
	for (const auto &id : order) {
		auto &row = rows[id];
		if (!row.is_object()
			|| row.value("deleted", false)
			|| !row.contains("content")
			|| !row["content"].is_object()
			|| !row.contains("ts")
			|| !row["ts"].is_number()) {
			continue;
		}
		const auto kind = row["content"].value("kind", std::string());
		if (kind.empty() || kind == "encrypted" || kind == "group_encrypted") {
			continue;
		}
		// Исчезающие сообщения на устройстве не хранятся дольше срока — в архив не идут
		if (TtlFromContent(row["content"]) != 0 || IsCleared(QString::fromStdString(id))) {
			continue;
		}
		list.push_back(std::move(row));
	}
	std::stable_sort(list.begin(), list.end(), [](const nlohmann::json &a, const nlohmann::json &b) {
		return a.value("ts", std::int64_t(0)) < b.value("ts", std::int64_t(0));
	});

	const auto selfName = DisplayNameFor(self);
	auto chats = std::map<QString, nlohmann::json>();
	for (auto &row : list) {
		const auto from = QString::fromStdString(row.value("from", std::string()));
		const auto to = QString::fromStdString(row.value("to", std::string()));
		const auto isOutgoing = isSelf(from);
		const auto isGroup = parvane::v2::isGroupAddress(to.toStdString());
		const auto address = isGroup
			? CanonicalGroup(to)
			: LatestAddress(isOutgoing ? to : from);
		if (address.isEmpty()) {
			continue;
		}
		if (!isGroup && !isOutgoing && g_blockedAddrs.contains(LatestAddress(from))) {
			continue;
		}
		auto &chat = chats[address];
		if (chat.is_null()) {
			const auto info = isGroup ? GroupInfoFor(address) : std::nullopt;
			const auto kind = isSelf(address)
				? "saved"
				: info
				? (info->kind == "channel" ? "channel" : "group")
				: isGroup
				? "group"
				: "user";
			const auto title = (info && !info->name.empty())
				? info->name
				: DisplayNameFor(address).toStdString();
			chat = nlohmann::json{
				{ "address", address.toStdString() },
				{ "kind", kind },
				{ "title", title },
				{ "messages", nlohmann::json::array() },
			};
		}
		auto message = nlohmann::json{
			{ "uuid", row.value("id", std::string()) },
			{ "from", (isOutgoing ? self : from).toStdString() },
			{ "fromName", (isOutgoing ? selfName : DisplayNameFor(from)).toStdString() },
			{ "isOutgoing", isOutgoing },
			{ "ts", row.value("ts", std::int64_t(0)) },
			{ "edited", row.value("edited", false) },
			{ "pinned", row.value("pinned", false) },
			{ "content", row["content"] },
		};
		if (row.contains("reply_to") && row["reply_to"].is_string()) {
			message["replyTo"] = row["reply_to"];
		}
		if (row.value("edited", false) && row.value("updated_at", std::int64_t(0)) > 0) {
			message["editedAt"] = row.value("updated_at", std::int64_t(0));
		}
		if (row.contains("reactions") && row["reactions"].is_array() && !row["reactions"].empty()) {
			auto reactions = nlohmann::json::array();
			for (const auto &r : row["reactions"]) {
				if (r.is_object()) {
					reactions.push_back({
						{ "emoji", r.value("emoji", std::string()) },
						{ "count", r.value("count", std::int64_t(0)) },
					});
				}
			}
			message["reactions"] = std::move(reactions);
		}
		chat["messages"].push_back(std::move(message));
	}

	// Чаты — по последнему сообщению, свежие сверху (как список чатов); «Избранное» первым
	auto ordered = std::vector<nlohmann::json>();
	for (auto &[address, chat] : chats) {
		ordered.push_back(std::move(chat));
	}
	const auto lastTs = [](const nlohmann::json &chat) {
		const auto &messages = chat["messages"];
		return messages.empty() ? std::int64_t(0) : messages.back().value("ts", std::int64_t(0));
	};
	std::stable_sort(ordered.begin(), ordered.end(), [&](const nlohmann::json &a, const nlohmann::json &b) {
		const auto aSaved = (a.value("kind", std::string()) == "saved");
		const auto bSaved = (b.value("kind", std::string()) == "saved");
		if (aSaved != bSaved) {
			return aSaved;
		}
		return lastTs(a) > lastTs(b);
	});

	auto contactSet = std::set<QString>();
	for (const auto &address : contacts) {
		if (!address.isEmpty() && !isSelf(address)) {
			contactSet.insert(LatestAddress(address));
		}
	}
	auto contactList = nlohmann::json::array();
	for (const auto &address : contactSet) {
		contactList.push_back({
			{ "address", address.toStdString() },
			{ "name", DisplayNameFor(address).toStdString() },
			{ "isExplicit", true },
		});
	}

	return nlohmann::json{
		{ "self", self.toStdString() },
		{ "selfName", selfName.toStdString() },
		{ "chats", std::move(ordered) },
		{ "contacts", std::move(contactList) },
	}.dump();
}

std::optional<std::string> ExportMediaBytes(
		const std::string &fileId,
		const std::string &fileKey,
		const std::string &fileNonce) {
	const auto id = QString::fromStdString(fileId);
	if (!IsSafeFileId(id)) {
		return std::nullopt;
	}
	// Уже расшифрованное устройством при показе (`<file_id>_<имя>`)
	const auto dir = QDir(MediaDir());
	for (const auto &name : dir.entryList(QStringList{ id + u"_*"_q }, QDir::Files)) {
		auto f = QFile(dir.filePath(name));
		if (f.open(QIODevice::ReadOnly)) {
			return f.readAll().toStdString();
		}
	}
	std::shared_ptr<parvane::v2::Control> t;
	std::string self, token;
	{
		std::lock_guard<std::mutex> lk(g_sessionMutex);
		t = g_control;
		self = g_selfAddress.toStdString();
		token = g_token.toStdString();
	}
	if (!t) {
		return std::nullopt;
	}
	try {
		auto d = DownloadChatBlob(fileId);
		if (!d.ok) {
			LOG(("Parvane: выгрузка — вложение %1 не скачано: %2").arg(id, QString::fromStdString(d.error)));
			return std::nullopt;
		}
		if (fileKey.empty()) {
			return std::move(d.bytes);
		}
		auto plain = parvane::blobcrypt::decrypt(d.bytes, fileKey, fileNonce);
		if (!plain) {
			LOG(("Parvane: выгрузка — вложение %1 не расшифровано").arg(id));
			return std::nullopt;
		}
		return std::move(*plain);
	} catch (const std::exception &e) {
		LOG(("Parvane: выгрузка — вложение %1: %2").arg(id, QString::fromUtf8(e.what())));
		return std::nullopt;
	}
}

} // namespace Parvane
