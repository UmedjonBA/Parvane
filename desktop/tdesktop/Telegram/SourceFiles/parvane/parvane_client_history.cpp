// Parvane fork: журнал истории аккаунта (spec 033; правила HIST-1, HIST-2, READ-2) — хранилище строк tdesktop и
// жизненный цикл `parvane::history::HistorySync` ядра. Сведение строк, маркер прочтения, подсчёт непрочитанного и
// права удаления — в движке; здесь — пути файлов, собеседник журнала по адресу чата, перенос прежнего журнала
// (`parvane-history-*.jsonl` до spec 033 и `parvane-read.txt`) и мост к UI (parvane_client.cpp: ShowHistoryStates,
// ApplyReadState, ReplaceHistoryOnMain).
//
// Файлы аккаунта (шифрует storecrypt):
//   tdata/parvane-history-<адрес>.jsonl        — строки RowState (дозапись + свёртка, ядро FileRowStore);
//   tdata/parvane-readmarks-<адрес>.json       — маркеры «прочитано до» по чатам;
//   tdata/parvane-history-sync-<адрес>-meta.json / -pending.json — курсор, голова, точка, флаг переноса, очередь своих.
#include "parvane/parvane_client_internal.h"

#include <parvane/history_sync.h>
#include <parvane/v2_engine.h>

namespace Parvane {
namespace Internal {
namespace {

// Под g_historyMutex держатся только короткие операции (файлы читаются и переносятся вне его): главный поток
// берёт его на каждом событии.
std::mutex g_historyMutex; // всё ниже до g_historyCv
std::shared_ptr<parvane::history::FileRowStore> g_historyStore;
std::shared_ptr<parvane::history::HistorySync> g_historySync;
QString g_historyOwner;     // аккаунт хранилища (или создаваемого прямо сейчас)
bool g_historyCreating = false;
bool g_historyReady = false; // хранилище открыто и прежний журнал перенесён
bool g_historyStarted = false;
std::vector<std::function<void()>> g_historyDeferred; // записи, пришедшие до готовности (по порядку)
std::condition_variable g_historyCv;
constexpr std::size_t kHistoryDeferredMax = 20000;

[[nodiscard]] std::shared_ptr<parvane::history::FileRowStore> StoreNow() {
	std::lock_guard<std::mutex> lk(g_historyMutex);
	return g_historyStore;
}

// Отложить запись до готовности хранилища; false — уже готово (писать сразу).
bool DeferUntilReady(std::function<void()> task) {
	std::lock_guard<std::mutex> lk(g_historyMutex);
	if (g_historyReady) {
		return false;
	}
	if (g_historyDeferred.size() < kHistoryDeferredMax) {
		g_historyDeferred.push_back(std::move(task));
	}
	return true;
}

std::mutex g_groupDomainMutex;
QHash<QString, QString> g_groupDomains; // "v2g:<hex>" → домен сервера группы (из событий и журнала)
QString g_ownDomain; // домен своего адреса — группе без известного домена (под g_groupDomainMutex)

[[nodiscard]] QString ReadMarksPath(const QString &self) {
	return AccountFilePath(u"parvane-readmarks-"_q, self, u".json"_q);
}

[[nodiscard]] QString SyncAuxPrefix(const QString &self) {
	return AccountFilePath(u"parvane-history-sync-"_q, self, u"-"_q);
}

[[nodiscard]] QString LegacyReadPath() {
	return cWorkingDir() + u"tdata/parvane-read.txt"_q;
}

[[nodiscard]] QString ChatOf(const parvane::StoredMessage &sm, const std::string &self) {
	if (parvane::v2::isGroupAddress(sm.to)) {
		return QString::fromStdString(sm.to);
	}
	return QString::fromStdString(sm.from == self ? sm.to : sm.from);
}

// Сообщение, которое можно перенести в журнал истории: расшифровано, не служебный шифртекст v1, не исчезающее
[[nodiscard]] bool JournaledContent(const parvane::json &content) {
	const auto kind = parvane::contentKind(content);
	return !kind.empty()
		&& kind != "encrypted"
		&& kind != "group_encrypted"
		&& kind != "skdm"
		&& kind != "unsupported"
		&& TtlFromContent(content) == 0;
}

// Строка формата экспорта привязки (LINK-1 п. 8) из строки клиента. ts — секунды (доли — миллисекунды).
[[nodiscard]] parvane::json WireRow(const parvane::StoredMessage &sm, std::int64_t tsMs) {
	auto row = parvane::json{
		{ "id", sm.id },
		{ "from", sm.from },
		{ "to", sm.to },
		{ "ts", tsMs > 0 ? double(tsMs) / 1000.0 : double(sm.ts) },
		{ "content", sm.content },
	};
	if (sm.reply_to && !sm.reply_to->empty()) {
		row["reply_to"] = *sm.reply_to;
	}
	if (!sm.proof.empty()) {
		row["proof"] = sm.proof;
	}
	return row;
}

[[nodiscard]] bool IsClearedRow(const parvane::json &state) {
	const auto address = HistoryChatAddress(state.value("chat", parvane::json()));
	const auto target = QString::fromStdString(state.value("target", std::string()));
	const auto pos = parvane::history::rowPos(state);
	std::lock_guard<std::mutex> lk(g_sessionMutex);
	if (g_clearedUuids.contains(target)) {
		return true;
	}
	const auto until = g_clearedUntilMs.value(address, 0);
	return pos && until > 0 && pos->tsMs <= until;
}

// Прежний журнал (StoredMessage построчно, до spec 033) и журнал прочитанного READ-1 → строки и маркеры хранилища.
// Один раз: строки берутся из файла и после свёртки там уже RowState; журнал прочитанного удаляется.
void ConvertLegacyLocked(parvane::history::FileRowStore &store, const QString &self) {
	auto legacy = store.takeLegacyRows();
	auto readIds = QSet<QString>();
	for (const auto &line : StoreReadLines(LegacyReadPath())) {
		readIds.insert(line.trimmed());
	}
	if (legacy.empty() && readIds.isEmpty()) {
		return;
	}
	const auto selfStd = self.toStdString();
	auto last = std::map<std::string, parvane::json>(); // id → последняя строка (журнал дописывался)
	for (auto &row : legacy) {
		last[row.value("id", std::string())] = std::move(row);
	}
	auto converted = 0;
	auto marks = std::map<std::string, parvane::json>();
	for (const auto &[id, row] : last) {
		try {
			const auto sm = parvane::StoredMessage::fromJson(row);
			if (sm.deleted || !JournaledContent(sm.content) || sm.from.empty() || sm.to.empty()) {
				continue;
			}
			{
				std::lock_guard<std::mutex> lk(g_sessionMutex);
				if (g_clearedUuids.contains(QString::fromStdString(sm.id))) {
					continue;
				}
			}
			const auto peer = HistoryPeerFor(ChatOf(sm, selfStd));
			if (peer.is_null()) {
				continue;
			}
			const auto op = parvane::history::rowOpFromWire(WireRow(sm, 0), peer);
			auto state = parvane::history::call("historyApply", { { "op", op } });
			if (const auto prev = store.get(sm.id)) {
				state = parvane::history::call("historyMerge", { { "a", *prev }, { "b", state } });
			}
			store.put(state);
			++converted;
			// Прочитано: своё, отмеченное прочитанным в журнале или в журнале прочитанного этого устройства
			if (sm.from == selfStd || sm.read || readIds.contains(QString::fromStdString(sm.id))) {
				const auto mark = parvane::history::markAt(state);
				const auto key = parvane::history::chatKeyOfState(state);
				auto &cur = marks[key];
				cur = parvane::history::call("historyMarkMerge", cur.is_null()
					? parvane::json{ { "b", mark } }
					: parvane::json{ { "a", cur }, { "b", mark } });
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: журнал истории: строка прежнего журнала не перенесена: %1").arg(QString::fromUtf8(e.what())));
		}
	}
	for (const auto &[key, mark] : marks) {
		if (!mark.is_object()) {
			continue;
		}
		const auto prev = store.mark(key);
		store.setMark(key, prev
			? parvane::history::call("historyMarkMerge", { { "a", *prev }, { "b", mark } })
			: mark);
	}
	store.compact();
	QFile::remove(LegacyReadPath());
	LOG(("Parvane: журнал истории: прежний журнал переведён в строки RowState (%1 строк, маркеров %2)")
		.arg(converted).arg(int(marks.size())));
}

} // namespace

parvane::json HistoryPeerFor(const QString &chatAddress) {
	if (chatAddress.isEmpty()) {
		return nullptr;
	}
	const auto addr = chatAddress.toStdString();
	if (parvane::v2::isGroupAddress(addr)) {
		const auto hex = parvane::v2::groupHex(addr);
		if (hex.size() != 32) {
			return nullptr;
		}
		auto domain = QString();
		{
			std::lock_guard<std::mutex> lk(g_groupDomainMutex);
			domain = g_groupDomains.value(chatAddress);
		}
		if (domain.isEmpty()) {
			std::lock_guard<std::mutex> lk(g_groupDomainMutex);
			domain = g_ownDomain;
		}
		return { { "group", { { "domain", domain.toStdString() }, { "id", parvane::v2::hexToB64(hex) } } } };
	}
	if (!chatAddress.contains('@')) {
		return nullptr;
	}
	return { { "user", { { "address", addr } } } };
}

QString HistoryChatAddress(const parvane::json &peer) {
	return QString::fromStdString(parvane::v2::Session::historyAddress(peer));
}

QString HistoryChatKey(const QString &chatAddress) {
	return QString::fromStdString(parvane::history::chatKeyOf(HistoryPeerFor(chatAddress)));
}

void NoteHistoryGroupDomain(const QString &address, const std::string &domain, bool authoritative) {
	if (address.isEmpty() || domain.empty()) {
		return;
	}
	std::lock_guard<std::mutex> lk(g_groupDomainMutex);
	if (!authoritative && g_groupDomains.contains(address)) {
		return;
	}
	g_groupDomains.insert(address, QString::fromStdString(domain));
}

bool IsHistorySelf(const std::string &address) {
	if (address.empty()) {
		return false;
	}
	if (const auto sync = HistorySyncNow()) {
		return sync->isSelf(address);
	}
	return address == SelfAddress().toStdString();
}

parvane::json HistorySelves() {
	auto out = parvane::json::array();
	if (const auto sync = HistorySyncNow()) {
		for (const auto &a : sync->selfAddresses()) {
			out.push_back(a);
		}
	}
	if (out.empty()) {
		out.push_back(SelfAddress().toStdString());
	}
	return out;
}

void EnsureHistory(const QString &self) {
	if (self.isEmpty() || !parvane::accountfiles::isValidAddress(self.toStdString())) {
		return;
	}
	{
		std::lock_guard<std::mutex> lk(g_historyMutex);
		if ((g_historyStore || g_historyCreating) && g_historyOwner == self) {
			return; // есть или создаётся другим потоком — ждущим WaitHistoryReady
		}
	}
	StopHistorySync(); // журнал прежнего аккаунта — дорабатывает фоном
	{
		std::lock_guard<std::mutex> lk(g_historyMutex);
		if (g_historyStore || g_historyCreating) {
			return; // создаётся параллельно
		}
		g_historyCreating = true;
		g_historyReady = false;
		g_historyOwner = self;
	}
	const auto fail = [] {
		std::lock_guard<std::mutex> lk(g_historyMutex);
		g_historyCreating = false;
		g_historyOwner.clear();
		g_historyDeferred.clear();
		g_historyCv.notify_all();
	};
	{
		std::lock_guard<std::mutex> dlk(g_groupDomainMutex);
		g_ownDomain = self.mid(self.indexOf('@') + 1);
	}
	const auto rows = AccountFilePath(u"parvane-history-"_q, self, u".jsonl"_q);
	const auto marks = ReadMarksPath(self);
	const auto aux = SyncAuxPrefix(self);
	if (rows.isEmpty() || marks.isEmpty() || aux.isEmpty()) {
		fail();
		return;
	}
	EnsureStoreKey();
	// Открытие файла и перенос прежнего журнала — вне замка (не главный поток: ReplayHistory, StartHistorySync)
	auto store = std::make_shared<parvane::history::FileRowStore>(
		rows.toStdString(), marks.toStdString(), aux.toStdString());

	auto cfg = parvane::history::HistorySyncConfig();
	cfg.self = self.toStdString();
	cfg.store = store.get();
	const auto generation = AccountGeneration();
	// Запросы прежнего аккаунта после выхода не уходят: поток журнала дорабатывает без сети
	cfg.request = [generation](const std::string &method, const std::string &body) {
		const auto s = AccountGenerationIs(generation) ? V2Ready() : nullptr;
		if (!s) {
			throw parvane::v2::V2Error("ERROR_CODE_UNAVAILABLE");
		}
		return s->busRequest(false, method, body, std::string());
	};
	cfg.openEngine = [generation]() -> std::unique_ptr<parvane::v2::HistorySession> {
		const auto s = AccountGenerationIs(generation) ? V2Ready() : nullptr;
		return s ? s->openHistorySession() : nullptr;
	};
	cfg.onRows = [generation](const std::vector<parvane::json> &states) {
		for (const auto &s : states) {
			const auto &chat = s.value("chat", parvane::json());
			if (chat.contains("group") && chat["group"].is_object()) {
				NoteHistoryGroupDomain(
					HistoryChatAddress(chat),
					chat["group"].value("domain", std::string()),
					/*authoritative=*/false);
			}
		}
		crl::on_main([generation, states] {
			if (AccountGenerationIs(generation)) {
				ShowHistoryStates(states);
			}
		});
	};
	cfg.onMark = [generation](const std::string &, const parvane::json &mark) {
		const auto address = HistoryChatAddress(mark.value("chat", parvane::json()));
		crl::on_main([generation, address] {
			if (AccountGenerationIs(generation)) {
				ApplyReadState(address);
			}
		});
	};
	cfg.onReplaced = [generation] {
		crl::on_main([generation] {
			if (AccountGenerationIs(generation)) {
				ReplaceHistoryOnMain();
			}
		});
	};
	// Перенос (FR-024): всё, что устройство знает, — в журнал один раз (повторы с других устройств сводятся).
	// Хранилище своё (не глобальное): живёт, пока поток этого журнала не остановлен.
	cfg.legacyOps = [raw = store.get()] {
		auto ops = std::vector<parvane::json>();
		raw->forEach([&](const parvane::json &s) {
			if (!IsClearedRow(s)) {
				ops.push_back({ { "state", s } });
			}
		});
		raw->forEachMark([&](const std::string &, const parvane::json &m) {
			ops.push_back({ { "read", m } });
		});
		return ops;
	};
	cfg.dropRow = [](const parvane::json &state) { return IsClearedRow(state); };
	cfg.log = [](const std::string &m) {
		LOG(("Parvane: %1").arg(QString::fromStdString(m)));
	};
	auto sync = std::make_shared<parvane::history::HistorySync>(std::move(cfg));
	{
		std::lock_guard<std::mutex> lk(g_historyMutex);
		if (g_historyOwner != self) {
			return; // аккаунт сменился за время открытия
		}
		g_historyStore = store;
		g_historySync = sync;
	}
	// Записи, пришедшие во время переноса, ложатся сразу в хранилище (сведение коммутативно); перенос — тоже
	ConvertLegacyLocked(*store, self);
	// Снимок истории прежнего механизма (spec 015) больше не применяется — его отметка не нужна
	QFile::remove(AccountFilePath(u"parvane-bundle-history-"_q, self, u".txt"_q));
	auto deferred = std::vector<std::function<void()>>();
	{
		std::lock_guard<std::mutex> lk(g_historyMutex);
		if (g_historyStore != store) {
			return;
		}
		g_historyCreating = false;
		g_historyReady = true;
		deferred = std::move(g_historyDeferred);
		g_historyDeferred.clear();
		g_historyCv.notify_all();
	}
	for (const auto &task : deferred) {
		task();
	}
}

void WaitHistoryReady() {
	std::unique_lock<std::mutex> lk(g_historyMutex);
	g_historyCv.wait_for(lk, std::chrono::minutes(5), [] { return g_historyReady || !g_historyCreating; });
}

void StartHistorySync(const QString &self) {
	EnsureHistory(self);
	WaitHistoryReady();
	std::shared_ptr<parvane::history::HistorySync> sync;
	{
		std::lock_guard<std::mutex> lk(g_historyMutex);
		if (!g_historySync || !g_historyReady || g_historyStarted || g_historyOwner != self) {
			return;
		}
		g_historyStarted = true;
		sync = g_historySync;
	}
	sync->start();
	LOG(("Parvane: журнал истории аккаунта запущен"));
}

// Не ждёт: поток журнала прежнего аккаунта останавливается фоном (его запросы уже отказывают — поколение аккаунта
// сменилось), хранилище разрушается после остановки потока. Главный поток (выход) не блокируется.
void StopHistorySync() {
	std::shared_ptr<parvane::history::HistorySync> sync;
	std::shared_ptr<parvane::history::FileRowStore> store;
	{
		std::lock_guard<std::mutex> lk(g_historyMutex);
		sync = std::move(g_historySync);
		store = std::move(g_historyStore);
		g_historySync = nullptr;
		g_historyStore = nullptr;
		g_historyOwner.clear();
		g_historyStarted = false;
		g_historyReady = false;
		g_historyCreating = false;
		g_historyDeferred.clear();
		g_historyCv.notify_all();
	}
	if (sync || store) {
		crl::async([sync = std::move(sync), store = std::move(store)]() mutable {
			if (sync) {
				sync->stop();
			}
			sync.reset();
			store.reset();
		});
	}
	std::lock_guard<std::mutex> lk(g_groupDomainMutex);
	g_groupDomains.clear();
}

std::shared_ptr<parvane::history::HistorySync> HistorySyncNow() {
	std::lock_guard<std::mutex> lk(g_historyMutex);
	return g_historySync;
}

void OnHistorySessionEvent(const parvane::json &ev) {
	if (const auto sync = HistorySyncNow()) {
		sync->onSessionEvent(ev);
	}
}

parvane::json HistoryRecordMessage(const parvane::StoredMessage &sm, bool own, std::int64_t tsMs) {
	if (sm.id.empty() || !JournaledContent(sm.content)) {
		return nullptr;
	}
	if (DeferUntilReady([sm, own, tsMs] { HistoryRecordMessage(sm, own, tsMs); })) {
		return nullptr; // хранилище ещё переносит прежний журнал — запишется по готовности
	}
	const auto sync = HistorySyncNow();
	if (!sync) {
		return nullptr;
	}
	const auto self = SelfAddress().toStdString();
	const auto peer = HistoryPeerFor(ChatOf(sm, self));
	if (peer.is_null()) {
		return nullptr;
	}
	try {
		return sync->record(parvane::history::rowOpFromWire(WireRow(sm, tsMs), peer), own);
	} catch (const std::exception &e) {
		LOG(("Parvane: журнал истории: сообщение %1 не записано: %2")
			.arg(QString::fromStdString(sm.id), QString::fromUtf8(e.what())));
		return nullptr;
	}
}

parvane::json HistoryRecordOp(const parvane::json &op, bool own, const std::string &requiredAuthor) {
	if (DeferUntilReady([op, own, requiredAuthor] {
			if (const auto next = HistoryRecordOp(op, own, requiredAuthor); next.is_object()) {
				crl::on_main([next] { ShowHistoryStates({ next }); });
			}
		})) {
		return nullptr;
	}
	const auto sync = HistorySyncNow();
	return sync ? sync->record(op, own, requiredAuthor) : parvane::json(nullptr);
}

std::optional<parvane::json> HistoryState(const QString &uuid) {
	const auto sync = HistorySyncNow();
	return sync ? sync->state(uuid.toStdString()) : std::nullopt;
}

std::optional<parvane::StoredMessage> StoredFromHistory(const parvane::json &state, parvane::json *viewOut) {
	parvane::json view;
	try {
		view = parvane::history::call("historyView", { { "state", state } });
	} catch (const std::exception &) {
		return std::nullopt;
	}
	if (viewOut) {
		*viewOut = view;
	}
	if (view.value("orphan", true)) {
		return std::nullopt;
	}
	const auto self = SelfAddress().toStdString();
	const auto chat = HistoryChatAddress(view.value("chat", parvane::json())).toStdString();
	if (chat.empty()) {
		return std::nullopt;
	}
	auto sm = parvane::StoredMessage();
	sm.id = view.value("id", std::string());
	sm.from = view.value("from", std::string());
	// Своё под прежним адресом (смена ника) — своё: показывается исходящим
	if (sm.from != self && IsHistorySelf(sm.from)) {
		sm.from = self;
	}
	sm.to = parvane::v2::isGroupAddress(chat) ? chat : (sm.from == self ? chat : self);
	sm.ts = view.value("tsMs", std::int64_t(0)) / 1000;
	sm.deleted = !view.value("visible", false);
	if (sm.deleted) {
		return sm;
	}
	const auto &body = view.value("body", parvane::json::object());
	sm.content = body.value("content", parvane::json::object());
	if (body.contains("reply_to") && body["reply_to"].is_string()) {
		sm.reply_to = body["reply_to"].get<std::string>();
	}
	sm.proof = body.value("proof", std::string());
	sm.edited = view.value("edited", false);
	sm.pinned = view.value("pinned", false);
	for (const auto &r : view.value("reactions", parvane::json::array())) {
		auto rs = parvane::ReactionSummary();
		rs.emoji = r.value("emoji", std::string());
		rs.count = r.value("count", std::int64_t(0));
		for (const auto &u : r.value("users", parvane::json::array())) {
			rs.mine = rs.mine || (u.is_string() && IsHistorySelf(u.get<std::string>()));
		}
		sm.reactions.push_back(std::move(rs));
	}
	return sm;
}

std::vector<parvane::json> HistoryStatesOfChat(const QString &chatAddress) {
	auto out = std::vector<parvane::json>();
	if (const auto store = StoreNow()) {
		store->forEachInChat(HistoryChatKey(chatAddress).toStdString(), [&](const parvane::json &s) {
			out.push_back(s);
		});
	}
	return out;
}

std::vector<parvane::json> HistoryAllStates() {
	auto out = std::vector<parvane::json>();
	if (const auto store = StoreNow()) {
		out.reserve(store->size());
		store->forEach([&](const parvane::json &s) { out.push_back(s); });
	}
	return out;
}

std::vector<QString> HistoryMarkedChats() {
	auto out = std::vector<QString>();
	if (const auto store = StoreNow()) {
		store->forEachMark([&](const std::string &, const parvane::json &m) {
			out.push_back(HistoryChatAddress(m.value("chat", parvane::json())));
		});
	}
	return out;
}

void HistoryEraseLocal(const QSet<QString> &uuids) {
	if (uuids.isEmpty()) {
		return;
	}
	auto ids = std::vector<std::string>();
	ids.reserve(uuids.size());
	for (const auto &u : uuids) {
		ids.push_back(u.toStdString());
	}
	if (const auto store = StoreNow()) {
		store->erase(ids);
	}
}

// Переименование аккаунта (MoveAccountLocal): файлы журнала — под новым адресом. Строки не переписываются (автор
// своих строк — прежний адрес, как у остальных устройств); маркеры и курсор переезжают как есть.
void MoveHistoryFiles(const QString &oldAddress, const QString &newAddress) {
	StopHistorySync();
	const auto move = [](const QString &from, const QString &to) {
		if (!from.isEmpty() && !to.isEmpty() && QFile::exists(from) && !QFile::exists(to)) {
			QFile::rename(from, to);
		}
	};
	move(ReadMarksPath(oldAddress), ReadMarksPath(newAddress));
	for (const auto &name : { u"meta.json"_q, u"pending.json"_q }) {
		const auto from = SyncAuxPrefix(oldAddress);
		const auto to = SyncAuxPrefix(newAddress);
		if (!from.isEmpty() && !to.isEmpty()) {
			move(from + name, to + name);
		}
	}
}

} // namespace Internal
} // namespace Parvane
