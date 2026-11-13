// Parvane fork: журнал истории аккаунта (spec 033; правила HIST-1, HIST-2, READ-2) — строки истории tdesktop и
// жизненный цикл `parvane::history::HistorySync` ядра. Строки, их сведение, маркеры «прочитано до», непрочитанное и
// хранение — модель движка профиля (spec 035 T125, ENGINE-1: `ModelRows` ядра над моделью сессии v2 — та же, что
// держит клиентское ядро; без сети — по прошлому открытию); права удаления — движок. Здесь — собеседник журнала по
// адресу чата, разовый перенос прежних файлов строк в модель (spec 033 RowState, журнал до spec 033 и
// `parvane-read.txt`) и мост к UI (parvane_client.cpp: ShowHistoryStates, ShowModelRows, ApplyReadState).
//
// Файлы аккаунта (шифрует storecrypt):
//   tdata/parvane-history-<адрес>.jsonl        — прежние строки (RowState, до spec 033 — StoredMessage): только
//                                                 читаются один раз при переносе в модель, не удаляются (D2);
//   tdata/parvane-readmarks-<адрес>.json       — прежние маркеры «прочитано до» (так же);
//   tdata/parvane-history-sync-<адрес>-pending.json / -imported.json — очередь прежнего журнала устройства (до
//                                                 spec 036; передаётся модели один раз), отметка переноса строк в модель.
// spec 036 (ENGINE-1, `engine_rows`): журнал истории аккаунта ведёт модель сессии; показ строк — её готовые
// MessageView (`message_upsert/remove`), счётчики — `unread_changed`, прочтение — намерение `read`.
#include "parvane/parvane_client_internal.h"

#include <cstdio>
#include <fstream>

#include <parvane/history_sync.h>
#include <parvane/v2_engine.h>
#include <parvane/v2_session.h>

#include <thread>

namespace Parvane {
namespace Internal {
namespace {

// Под g_historyMutex держатся только короткие операции (модель ждётся и прежнее переносится вне его): главный поток
// берёт его на каждом событии.
std::mutex g_historyMutex; // всё ниже до g_historyCv
std::shared_ptr<parvane::history::ModelRows> g_historyStore;
std::shared_ptr<parvane::history::HistorySync> g_historySync;
QString g_historyOwner;     // аккаунт хранилища (или создаваемого прямо сейчас)
bool g_historyCreating = false;
bool g_historyReady = false; // модель открыта и прежние строки перенесены в неё
bool g_historyStarted = false;
std::vector<std::function<void()>> g_historyDeferred; // записи, пришедшие до готовности (по порядку)
std::condition_variable g_historyCv;
constexpr std::size_t kHistoryDeferredMax = 20000;
constexpr auto kModelPoll = std::chrono::milliseconds(300);

[[nodiscard]] std::shared_ptr<parvane::history::ModelRows> StoreNow() {
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

// Прежний журнал (StoredMessage построчно, до spec 033; последняя строка по id) и журнал прочитанного READ-1 →
// операции для модели: строка (row) и маркер «прочитано до» прочитанного (read). Сведение строк и маркеров (максимум)
// — модель. Журнал прочитанного после переноса удаляется; файл строк остаётся как был (переносится один раз).
[[nodiscard]] std::vector<parvane::json> ConvertLegacyOps(const std::vector<parvane::json> &stored, const QString &self) {
	auto readIds = QSet<QString>();
	for (const auto &line : StoreReadLines(LegacyReadPath())) {
		readIds.insert(line.trimmed());
	}
	const auto selfStd = self.toStdString();
	auto ops = std::vector<parvane::json>();
	auto converted = 0;
	for (const auto &row : stored) {
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
			ops.push_back(op);
			++converted;
			// Прочитано: своё, отмеченное прочитанным в журнале или в журнале прочитанного этого устройства
			if (sm.from == selfStd || sm.read || readIds.contains(QString::fromStdString(sm.id))) {
				const auto &r = op["row"];
				ops.push_back({ { "read", {
					{ "chat", peer },
					{ "up_to_ts_ms", r.value("ts_ms", std::string("0")) },
					{ "up_to_id", r.value("id", std::string()) },
				} } });
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: журнал истории: строка прежнего журнала не перенесена: %1").arg(QString::fromUtf8(e.what())));
		}
	}
	StoreRemove(LegacyReadPath());
	LOG(("Parvane: журнал истории: прежний журнал (до spec 033) — в модель (%1 строк)").arg(converted));
	return ops;
}

// Модель профиля для строк истории (сессия v2 этого поколения аккаунта; без сети — по прошлому открытию).
[[nodiscard]] parvane::history::ModelRows::HostFn RowsHostFor(std::uint64_t generation) {
	return [generation]() -> std::shared_ptr<parvane::engine::Host> {
		if (!AccountGenerationIs(generation)) {
			return nullptr;
		}
		auto s = std::shared_ptr<parvane::v2::Session>();
		{
			std::lock_guard<std::mutex> lk(g_v2Mutex);
			s = g_v2;
		}
		return s ? s->rowsModel() : nullptr;
	};
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
	const auto generation = AccountGeneration();
	// Строки — в модели профиля сессии v2 (её открывает сессия; без сети — по прошлому открытию)
	// Служебные документы журнала (отметка переноса, очередь прежнего журнала) — файлы tdata через хранилище движка
	auto store = std::make_shared<parvane::history::ModelRows>(RowsHostFor(generation), aux.toStdString(),
		parvane::history::ModelRows::AuxIo{
			[](const std::string &p) { return StoreRead(QString::fromStdString(p)).toStdString(); },
			[](const std::string &p, const std::string &d) { return StoreWrite(QString::fromStdString(p), QByteArray::fromStdString(d)); } });

	auto cfg = parvane::history::HistorySyncConfig();
	cfg.self = self.toStdString();
	cfg.rows = store.get();
	cfg.openEngine = [generation]() -> std::unique_ptr<parvane::v2::HistorySession> {
		const auto s = AccountGenerationIs(generation) ? V2Ready() : nullptr;
		return s ? s->openHistorySession() : nullptr;
	};
	// spec 036 (ENGINE-1, `engine_rows`): журнал истории аккаунта (пачка S7-3, догон, вход по точке, контрольные точки)
	// ведёт модель сессии; здесь — строки модели и прочтение её намерением (квитанции шлёт модель)
	cfg.readIntent = [generation](const parvane::json &mark) {
		// Намерение ходит в сеть (квитанции) — не на главном потоке; счётчик чата придёт `unread_changed`. Без сессии
		// (нет связи) — маркер операцией журнала (модель сведёт, квитанции уйдут при следующем прочтении)
		if (!AccountGenerationIs(generation) || !V2Ready()) {
			return false;
		}
		crl::async([generation, mark] {
			if (const auto s = AccountGenerationIs(generation) ? V2Ready() : nullptr) {
				s->readTo(mark);
			}
		});
		return true;
	};
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
	// Модель открывает сессия v2 (подключение) либо открытие без сети по прошлому разу — ждём её своим потоком (не
	// пулом crl: без сети ожидание длится до подключения); события до готовности откладываются (DeferUntilReady)
	std::thread([self, generation, store, rows, marks] {
		const auto owned = [&] {
			std::lock_guard<std::mutex> lk(g_historyMutex);
			return g_historyStore == store && AccountGenerationIs(generation);
		};
		auto tried = false;
		while (owned() && !store->ready()) {
			if (!tried) {
				auto s = std::shared_ptr<parvane::v2::Session>();
				{
					std::lock_guard<std::mutex> lk(g_v2Mutex);
					s = g_v2;
				}
				tried = s && s->openModelOffline();
			}
			std::this_thread::sleep_for(kModelPoll);
		}
		if (!owned()) {
			return;
		}
		// Прежние файлы строк (spec 033) и журнал до spec 033 — в модель один раз (сведение — модель)
		const auto log = [](const std::string &m) { LOG(("Parvane: %1").arg(QString::fromStdString(m))); };
		if (!parvane::history::importLegacyRows(
				*store,
				rows.toStdString(),
				marks.toStdString(),
				[self](const std::vector<parvane::json> &stored) { return ConvertLegacyOps(stored, self); },
				[](const parvane::json &state) { return IsClearedRow(state); },
				log)) {
			LOG(("Parvane: журнал истории: прежние строки не перенесены в модель — повтор при следующем запуске"));
		}
		// Снимок истории прежнего механизма (spec 015) больше не применяется — его отметка не нужна
		StoreRemove(AccountFilePath(u"parvane-bundle-history-"_q, self, u".txt"_q));
		// ✓✓ своих — доставка строки в модели (spec 036): прежний файл отметок не нужен
		StoreRemove(AccountFilePath(u"parvane-outbox-read-"_q, self, u".json"_q));
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
	}).detach();
}

bool DeferHistoryUntilReady(std::function<void()> task) {
	{
		std::lock_guard<std::mutex> lk(g_historyMutex);
		if (!g_historyReady && !g_historyCreating) {
			return false; // журнала нет (нет аккаунта) — ждать нечего
		}
	}
	return DeferUntilReady(std::move(task));
}

void StartHistorySync(const QString &self) {
	EnsureHistory(self);
	if (DeferUntilReady([self] { StartHistorySync(self); })) {
		return; // модель ещё не открыта — запуск по готовности
	}
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
	std::shared_ptr<parvane::history::ModelRows> store;
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

parvane::json HistoryRecordOp(const parvane::json &op, bool own) {
	if (DeferUntilReady([op, own] {
			if (const auto next = HistoryRecordOp(op, own); next.is_object()) {
				crl::on_main([next] { ShowHistoryStates({ next }); });
			}
		})) {
		return nullptr;
	}
	const auto sync = HistorySyncNow();
	return sync ? sync->record(op, own) : parvane::json(nullptr);
}

std::optional<parvane::json> HistoryState(const QString &uuid) {
	const auto sync = HistorySyncNow();
	return sync ? sync->state(uuid.toStdString()) : std::nullopt;
}

// Показ строки — готовый вид модели (MessageView, `wire_rows`; ядро переводит его в прежнюю форму показа,
// `parvane::history::viewOfModel`) → StoredMessage конвейера UI. Своя расстановки и сведения у хоста нет (ENGINE-1).
std::optional<parvane::StoredMessage> StoredFromView(const parvane::json &view) {
	if (!view.is_object() || view.value("orphan", true)) {
		return std::nullopt;
	}
	const auto self = SelfAddress().toStdString();
	const auto chat = HistoryChatAddress(view.value("chat", parvane::json())).toStdString();
	if (chat.empty()) {
		return std::nullopt;
	}
	auto sm = parvane::StoredMessage();
	sm.inModel = true;
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
	sm.read = view.value("read", false);
	for (const auto &r : view.value("reactions", parvane::json::array())) {
		auto rs = parvane::ReactionSummary();
		rs.emoji = r.value("emoji", std::string());
		rs.count = r.value("count", std::int64_t(0));
		rs.mine = r.value("mine", false);
		for (const auto &u : r.value("users", parvane::json::array())) {
			rs.mine = rs.mine || (u.is_string() && IsHistorySelf(u.get<std::string>()));
		}
		sm.reactions.push_back(std::move(rs));
	}
	return sm;
}

// Снятая моделью строка (надгробие, очистка, замена точкой) → томбстоун конвейера UI (чат — по собеседнику).
parvane::StoredMessage RemovedStored(const QString &uuid, const QString &chat) {
	auto sm = parvane::StoredMessage();
	sm.inModel = true;
	sm.id = uuid.toStdString();
	sm.deleted = true;
	const auto self = SelfAddress().toStdString();
	if (parvane::v2::isGroupAddress(chat.toStdString())) {
		sm.from = self;
		sm.to = chat.toStdString();
	} else {
		sm.from = chat.toStdString();
		sm.to = self;
	}
	return sm;
}

std::optional<parvane::StoredMessage> StoredFromHistory(const parvane::json &state, parvane::json *viewOut) {
	const auto store = StoreNow();
	const auto target = state.value("target", std::string());
	if (!store || target.empty() || !state.contains("row")) {
		return std::nullopt; // сирота — ждёт сообщение
	}
	const auto views = store->views({ target });
	if (views.empty()) {
		// Строки нет в показе модели (надгробие) — томбстоун
		const auto chat = HistoryChatAddress(state.value("chat", parvane::json()));
		if (viewOut) {
			*viewOut = parvane::json{ { "id", target }, { "chat", state.value("chat", parvane::json()) }, { "visible", false } };
		}
		return chat.isEmpty() ? std::nullopt : std::make_optional(RemovedStored(QString::fromStdString(target), chat));
	}
	const auto view = parvane::history::viewOfModel(views.front());
	if (viewOut) {
		*viewOut = view;
	}
	return StoredFromView(view);
}

bool HistoryViewVisible(const QString &uuid) {
	const auto store = StoreNow();
	return store && !uuid.isEmpty() && !store->views({ uuid.toStdString() }).empty();
}

std::vector<parvane::json> HistoryChatViews(const QString &chatAddress) {
	auto out = std::vector<parvane::json>();
	if (const auto store = StoreNow()) {
		for (const auto &v : store->chatViews(HistoryChatKey(chatAddress).toStdString())) {
			if (auto view = parvane::history::viewOfModel(v); view.is_object()) {
				out.push_back(std::move(view));
			}
		}
	}
	return out;
}

std::vector<parvane::json> HistoryAllViews() {
	auto out = std::vector<parvane::json>();
	if (const auto store = StoreNow()) {
		for (const auto &v : store->allViews()) {
			if (auto view = parvane::history::viewOfModel(v); view.is_object()) {
				out.push_back(std::move(view));
			}
		}
	}
	return out;
}

std::vector<parvane::json> HistoryChatList() {
	const auto store = StoreNow();
	return store ? store->chatList() : std::vector<parvane::json>();
}

std::vector<parvane::json> HistoryStatesOfChat(const QString &chatAddress) {
	const auto store = StoreNow();
	return store ? store->chat(HistoryChatKey(chatAddress).toStdString()) : std::vector<parvane::json>();
}

std::vector<parvane::json> HistoryStatesOf(const std::vector<std::string> &uuids) {
	const auto store = StoreNow();
	return store ? store->states(uuids) : std::vector<parvane::json>();
}

std::vector<parvane::json> HistoryAllStates() {
	const auto store = StoreNow();
	return store ? store->all() : std::vector<parvane::json>();
}

std::vector<QString> HistoryMarkedChats() {
	auto out = std::vector<QString>();
	if (const auto store = StoreNow()) {
		for (const auto &m : store->marks()) {
			out.push_back(HistoryChatAddress(m.value("chat", parvane::json())));
		}
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
		store->forget(ids); // у себя без надгробия (модель); в журнале аккаунта строки остаются
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
	for (const auto &name : { u"meta.json"_q, u"pending.json"_q, u"imported.json"_q }) {
		const auto from = SyncAuxPrefix(oldAddress);
		const auto to = SyncAuxPrefix(newAddress);
		if (!from.isEmpty() && !to.isEmpty() && StoreExists(from + name) && !StoreExists(to + name)) {
			StoreRename(from + name, to + name); // записи хранилища движка (spec 036 T031)
		}
	}
}

} // namespace Internal
} // namespace Parvane
