// Parvane fork: реализация parvane_sections_data.h.
#include "parvane/parvane_sections_data.h"

#include "parvane/parvane_client.h"

#include <parvane/blobcrypt.h>
#include <parvane/v2_engine.h>
#include <parvane/v2_link.h>
#include <parvane/v2_session.h>

#include <crl/crl_on_main.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <rpl/variable.h>

#include <QtCore/QDateTime>
#include <QtCore/QDir>

#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <random>
#include <thread>

namespace Parvane::Sections {
namespace {

using SessionPtr = std::shared_ptr<parvane::v2::Session>;

constexpr auto kCloudChunkBytes = std::size_t(512 * 1024); // web CLOUD_CHUNK_BYTES
constexpr auto kDriveBucket = "BLOB_BUCKET_DRIVE";
constexpr auto kIdleWaitMs = std::int64_t(60 * 1000);
constexpr auto kLinkingPollMs = std::int64_t(3000); // web: опрос «Плана», пока устройство не привязано

[[nodiscard]] std::int64_t NowMs() {
	return QDateTime::currentMSecsSinceEpoch();
}

[[nodiscard]] std::string RandomHex(int bytes) {
	static thread_local std::mt19937_64 rng(std::random_device{}());
	static const char digits[] = "0123456789abcdef";
	auto result = std::string();
	result.reserve(bytes * 2);
	for (auto i = 0; i != bytes; ++i) {
		const auto b = std::uint8_t(rng() & 0xFF);
		result.push_back(digits[b >> 4]);
		result.push_back(digits[b & 0x0F]);
	}
	return result;
}

// ── транспорт поверх v2-сессии ─────────────────────────────────────────────────

class SessionTransport final : public domain::DomainTransport {
public:
	void setSession(SessionPtr session) { _session = std::move(session); }
	[[nodiscard]] const SessionPtr &session() const { return _session; }

	json engine(const std::string &name, const json &args) override {
		return need()->engineCall(name, args, false);
	}
	json engineWithNeeds(const std::string &name, const json &args) override {
		return need()->engineCall(name, args, true);
	}
	std::string request(bool anon, const std::string &method, const std::string &body,
			const std::string &dest) override {
		try {
			return need()->busRequest(anon, method, body, dest);
		} catch (const parvane::v2::V2Error &e) {
			throw domain::BusError(e.code());
		}
	}
	std::string encodeMethod(const std::string &method, const json &value) override {
		return parvane::v2::encodeMethodRequest(method, value);
	}
	json decodeMethod(const std::string &method, const std::string &bytes) override {
		return parvane::v2::decodeMethodResponse(method, bytes);
	}
	bool hasClient() override { return _session != nullptr; }
	bool isReady() override { return _session && _session->isReady(); }
	bool needsLinking() override { return _session && _session->needsLinking(); }
	std::string self() override { return _session ? _session->self() : std::string(); }
	std::string serverDomain() override { return _session ? _session->serverDomain() : std::string(); }
	void persist() override {
		if (_session) {
			_session->persistEngine();
		}
	}
	std::int64_t nowMs() override { return NowMs(); }
	void log(const std::string &message) override {
		LOG(("Parvane: разделы — %1").arg(QString::fromStdString(message)));
	}

private:
	[[nodiscard]] parvane::v2::Session *need() const {
		if (!_session) {
			throw domain::BusError("ERROR_CODE_UNAVAILABLE");
		}
		return _session.get();
	}

	SessionPtr _session;

};

// ── записи устройства: зашифрованный файл, пишется, когда что-то изменилось ────

class FileRecords final : public domain::RecordStore {
public:
	void open(const QString &path) {
		_path = path;
		_memory = domain::MemoryRecords();
		_dirty = false;
		if (path.isEmpty()) {
			return;
		}
		const auto raw = SectionsRead(path);
		if (raw.isEmpty()) {
			return;
		}
		try {
			_memory = domain::MemoryRecords(json::parse(raw.toStdString()));
		} catch (const std::exception &e) {
			LOG(("Parvane: разделы — записи %1 не прочитаны: %2").arg(path, QString::fromUtf8(e.what())));
		}
	}
	std::optional<json> load(const std::string &key) override { return _memory.load(key); }
	void save(const std::string &key, const json &value) override {
		_memory.save(key, value);
		_dirty = true;
	}
	void remove(const std::string &key) override {
		_memory.remove(key);
		_dirty = true;
	}
	void flush() {
		if (!_dirty || _path.isEmpty()) {
			return;
		}
		_dirty = false;
		if (!SectionsWrite(_path, QByteArray::fromStdString(_memory.toJson().dump()))) {
			LOG(("Parvane: разделы — записи %1 не сохранены").arg(_path));
		}
	}

private:
	QString _path;
	domain::MemoryRecords _memory;
	bool _dirty = false;

};

// ── блобы личного диска ────────────────────────────────────────────────────────

class SessionBlobs final : public cloud::CloudBlobs {
public:
	explicit SessionBlobs(SessionTransport &transport) : _transport(transport) {
	}

	json upload(const std::string &bytes, const std::string &mime) override {
		const auto session = _transport.session();
		if (!session) {
			throw domain::BusError("ERROR_CODE_UNAVAILABLE");
		}
		const auto sealed = parvane::blobcrypt::encrypt(bytes);
		auto capability = std::string(32, '\0');
		static thread_local std::mt19937_64 rng(std::random_device{}());
		for (auto &ch : capability) {
			ch = char(rng() & 0xFF);
		}
		auto fileId = std::string();
		try {
			fileId = session->uploadBlob(sealed.ciphertext, capability, kCloudChunkBytes, kDriveBucket);
		} catch (const parvane::v2::V2Error &e) {
			throw domain::BusError(e.code());
		}
		const auto chunks = std::max<std::size_t>(
			1,
			(sealed.ciphertext.size() + kCloudChunkBytes - 1) / kCloudChunkBytes);
		return json{
			{ "fileId", fileId },
			{ "key", sealed.keyB64 },
			{ "nonce", sealed.nonceB64 },
			{ "capability", domain::toBase64(capability) },
			{ "size", std::int64_t(bytes.size()) },
			{ "chunks", std::int64_t(chunks) },
		};
	}

	std::optional<std::string> download(const json &blob) override {
		const auto session = _transport.session();
		if (!session || !blob.is_object()) {
			return std::nullopt;
		}
		const auto fileId = blob.value("fileId", std::string());
		const auto capability = blob.value("capability", std::string());
		if (fileId.empty() || capability.empty()) {
			return std::nullopt;
		}
		try {
			// Ревью 21 окт (2.2): потолок шифртекста из описания блоба (миниатюра, просмотр) — сессии
			const auto cipher = session->downloadBlobCap(
				fileId,
				domain::fromBase64(capability),
				blob.value("domain", std::string()),
				std::size_t(std::max<std::int64_t>(0, blob.value(cloud::kBlobMaxBytesKey, std::int64_t(0)))));
			return parvane::blobcrypt::decrypt(
				cipher,
				blob.value("key", std::string()),
				blob.value("nonce", std::string()));
		} catch (const parvane::v2::V2Error &e) {
			throw domain::BusError(e.code());
		}
	}

	json usage() override {
		const auto body = _transport.encodeMethod("cloud.blob.usage", json::object());
		return _transport.decodeMethod("cloud.blob.usage", _transport.request(false, "cloud.blob.usage", body, {}));
	}

	// Для файлов «Облака» (cloud_files.h, T064): миниатюры, перенос, ссылки
	std::string randomBytes(std::size_t n) override {
		auto result = std::string(n, '\0');
		if (RAND_bytes(reinterpret_cast<unsigned char*>(result.data()), int(n)) != 1) {
			throw std::runtime_error("RAND_bytes");
		}
		return result;
	}
	std::string sha256(const std::string &bytes) override {
		auto result = std::string(SHA256_DIGEST_LENGTH, '\0');
		SHA256(
			reinterpret_cast<const unsigned char*>(bytes.data()),
			bytes.size(),
			reinterpret_cast<unsigned char*>(result.data()));
		return result;
	}
	std::string sealWithKey(const std::string &plain, const std::string &keyRaw, const std::string &nonceRaw) override {
		return parvane::blobcrypt::encryptWithKey(plain, keyRaw, nonceRaw);
	}
	std::optional<std::string> openWithKey(
			const std::string &cipher,
			const std::string &keyB64,
			const std::string &nonceB64) override {
		return parvane::blobcrypt::decrypt(cipher, keyB64, nonceB64);
	}
	std::string uploadCipher(const std::string &cipher, const std::string &capabilityRaw) override {
		const auto session = _transport.session();
		if (!session) {
			throw domain::BusError("ERROR_CODE_UNAVAILABLE");
		}
		try {
			return session->uploadBlob(cipher, capabilityRaw, kCloudChunkBytes, kDriveBucket);
		} catch (const parvane::v2::V2Error &e) {
			throw domain::BusError(e.code());
		}
	}

private:
	SessionTransport &_transport;

};

// ── хозяйство рабочего потока ──────────────────────────────────────────────────

class Hub;

class PlannerHost final : public planner::PlannerStoreHost {
public:
	explicit PlannerHost(Hub &hub) : _hub(hub) {
	}
	void apply(const std::vector<planner::PlannerChange> &changes) override;
	void flush() override;

private:
	Hub &_hub;

};

class NotesHostImpl final : public notes::NotesHost {
public:
	explicit NotesHostImpl(Hub &hub) : _hub(hub) {
	}
	std::optional<json> callParvane(const std::string &method, const json &args) override;
	int64_t nowMs() override { return NowMs(); }
	std::string today() override {
		return QDate::currentDate().toString(Qt::ISODate).toStdString();
	}
	double nowMinutes() override {
		const auto t = QTime::currentTime();
		return t.hour() * 60. + t.minute() + t.second() / 60.;
	}
	std::string localTimeLabel(int64_t ms) override {
		return QDateTime::fromMSecsSinceEpoch(ms).toString(u"yyyy-MM-dd HH:mm:ss"_q).toStdString();
	}
	domain::RecordStore *textCache() override;
	planner::State plannerState() override;
	void updatePlanner(const std::function<void(planner::State&)> &mutate) override;

private:
	Hub &_hub;

};

class Hub final {
public:
	Hub()
	: _blobs(_transport)
	, _plannerHost(*this)
	, _notesHost(*this)
	, _plannerSync(_transport, _records, plannerHooks())
	, _planner(_plannerHost)
	, _cloud(_transport, _records, cloudHooks())
	, _drive(_cloud, _blobs, _transport)
	, _notes(_notesHost) {
		_notes.onChanged = [this] { _notesDirty = true; };
	}

	Workers workers() {
		return Workers{
			.transport = _transport,
			.plannerSync = _plannerSync,
			.planner = _planner,
			.cloud = _cloud,
			.drive = _drive,
			.notes = _notes,
			.self = _self,
			.nowMs = NowMs(),
		};
	}

	// Сессия: сменилась — всё сбросить и подключить заново
	void syncSession() {
		const auto session = SectionsSession();
		const auto self = session ? session->self() : std::string();
		if (session == _transport.session()) {
			return;
		}
		flushRecords();
		_transport.setSession(session);
		if (self != _self) {
			switchAccount(self);
		}
		applyWanted();
	}

	// Выход из аккаунта (ревью 21 окт 2026, вечер): модули и снимки прежнего — прочь, до новой сессии
	void resetAccount() {
		flushRecords();
		_transport.setSession(nullptr);
		switchAccount(std::string());
	}

	// Другой аккаунт (или никакого): всё прежнего сбрасывается — «План», облако, заметки (иначе publishNotes
	// переопубликовал бы заметки прежнего аккаунта следующему), сводка квоты; экранам уходят пустые снимки
	void switchAccount(const std::string &self) {
		_self = self;
		_plannerSync.reset();
		_planner.reset();
		_cloud.reset();
		_notes.signOut();
		if (_notesRelease) {
			std::exchange(_notesRelease, nullptr)();
		}
		_usage.reset();
		const auto dir = SectionsStateDir(_self);
		_records.open(dir.isEmpty() ? QString() : dir + u"/sections-records.json"_q);
		_texts.open(dir.isEmpty() ? QString() : dir + u"/sections-texts.json"_q);
		if (!_self.empty()) {
			_planner.setUser(_self);
		}
		_notesLoaded = false;
		_notesSent = {};
		_cloudSent = {};
		_plannerSent = {};
		_plannerDirty = _cloudDirty = _notesDirty = true;
	}

	void setShown(Section section) {
		_shown = section;
		applyWanted();
	}

	void setPaletteOpen(bool open) {
		_paletteOpen = open;
		applyWanted();
	}

	void setVisible(bool visible) {
		_plannerSync.setVisible(visible);
		_cloud.setVisible(visible);
	}

	void engineEvent(const json &event) {
		const auto type = event.value("type", std::string());
		if (type == "plannerChanged") {
			_plannerSync.onEngineEvent();
			_plannerDirty = true;
		} else if (type == "cloudChanged") {
			_cloud.onEngineEvent(event.value("id", std::string()));
			_cloudDirty = true;
		}
	}

	void tick() {
		_plannerSync.tick();
		_cloud.tick();
		if (_planner.needsLinkingPoll() && NowMs() >= _linkingPollAt) {
			_linkingPollAt = NowMs() + kLinkingPollMs;
			_plannerDirty = true;
		}
	}

	[[nodiscard]] std::int64_t nextWakeMs() const {
		auto result = NowMs() + kIdleWaitMs;
		if (const auto at = _plannerSync.nextWakeMs()) {
			result = std::min(result, *at);
		}
		if (const auto at = _cloud.nextWakeMs()) {
			result = std::min(result, *at);
		}
		if (_planner.needsLinkingPoll()) {
			result = std::min(result, _linkingPollAt);
		}
		if (const auto notice = _planner.notice(NowMs())) {
			result = std::min(result, NowMs() + planner::PlannerStore::kNoticeHideMs);
		}
		return result;
	}

	// После задания или такта: перечитать модули и отдать снимки экранам
	void publish() {
		if (_plannerDirty) {
			_plannerDirty = false;
			refreshPlanner();
		}
		if (_cloudDirty) {
			_cloudDirty = false;
			refreshCloud();
		}
		if (_notesDirty) {
			_notesDirty = false;
			publishNotes();
		}
		publishPlanner();
		flushRecords();
	}

	void markPlannerDirty() { _plannerDirty = true; }
	void markCloudDirty() { _cloudDirty = true; }
	void markNotesDirty() { _notesDirty = true; }

	planner::PlannerSync &plannerSync() { return _plannerSync; }
	planner::PlannerStore &plannerStore() { return _planner; }
	cloud::CloudDrive &drive() { return _drive; }
	FileRecords &texts() { return _texts; }

	void shutdown() {
		try {
			_plannerSync.pageHide();
			_plannerSync.flush();
		} catch (const std::exception &e) {
			LOG(("Parvane: разделы — правки «Плана» не досланы при выходе: %1").arg(QString::fromUtf8(e.what())));
		}
		flushRecords();
	}

private:
	planner::PlannerHooks plannerHooks() {
		return planner::PlannerHooks{
			.stateContainer = [this]() -> std::optional<planner::ContainerRef> {
				const auto session = _transport.session();
				if (!session) {
					return std::nullopt;
				}
				const auto snapshot = session->stateSnapshot();
				if (!snapshot.is_object() || !snapshot.contains("planner_container")) {
					return std::nullopt;
				}
				const auto &entry = snapshot["planner_container"];
				const auto ref = entry.is_object() ? entry.value("ref", json::object()) : json::object();
				const auto id = ref.is_object() ? ref.value("id", std::string()) : std::string();
				if (id.empty()) {
					return std::nullopt;
				}
				return planner::ContainerRef{
					.domain = ref.value("domain", std::string()),
					.id = domain::b64ToHex(id),
				};
			},
			.recordContainer = [this](const planner::ContainerRef &ref) {
				if (const auto session = _transport.session()) {
					session->stateCall("plannerContainerSet", json{ { "domain", ref.domain }, { "idHex", ref.id } });
				}
			},
			.onChanged = [this] { _plannerDirty = true; },
		};
	}

	cloud::CloudHooks cloudHooks() {
		return cloud::CloudHooks{
			.stateEntries = [this] {
				const auto session = _transport.session();
				return session
					? cloud::parseCloudEntries(session->stateSnapshot())
					: std::vector<cloud::CloudStateEntry>();
			},
			.recordEntry = [this](const cloud::CloudStateEntry &entry) {
				if (const auto session = _transport.session()) {
					session->stateCall("cloudContainerSet", json{ { "containerJson", cloud::cloudEntryToState(entry) } });
				}
			},
			.deleteBlob = [this](const std::string &fileId) {
				const auto body = _transport.encodeMethod("cloud.blob.delete", json{ { "file_id", fileId } });
				_transport.request(false, "cloud.blob.delete", body, {});
			},
			.refreshPeerLog = [this](const std::string &user) {
				if (const auto session = _transport.session()) {
					session->refreshPeerLog(user);
				}
			},
			.onChanged = [this] { _cloudDirty = true; },
		};
	}

	void applyWanted() {
		if (_self.empty()) {
			return;
		}
		const auto plannerShown = (_shown == Section::Calendar) || (_shown == Section::Health);
		const auto cloudShown = (_shown == Section::Files) || (_shown == Section::Knowledge);
		// «План» нужен и в фоне (напоминания, карточки задания в чате) — опрос редкий
		_plannerSync.ensure(!plannerShown);
		_plannerSync.setActive(plannerShown);
		// Палитра Ctrl+K ищет по заметкам и файлам: пока она открыта, облако и заметки читаются, как в «Знаниях»
		if (cloudShown || _paletteOpen) {
			_cloud.ensureSoon(true);
		}
		_cloud.setActive(cloudShown);
		if (_shown == Section::Knowledge || _paletteOpen) {
			if (!_notesLoaded) {
				_notesLoaded = true;
				_notes.loadNotes(_self, notesOptions());
			}
			if (!_notesRelease) {
				_notesRelease = _notes.retainNotes();
			}
		} else if (_notesRelease) {
			std::exchange(_notesRelease, nullptr)();
		}
		_plannerDirty = _cloudDirty = true;
	}

	[[nodiscard]] notes::NotesOptions notesOptions() const {
		auto result = notes::NotesOptions();
		if (!IsRussianUi()) {
			result.guideLang = "en";
			result.vaultName = "Knowledge";
		}
		return result;
	}

	void refreshPlanner() {
		auto result = planner::EngineStateResult();
		result.status = _plannerSync.status();
		result.state = _plannerSync.stateJson();
		result.sizeBytes = _plannerSync.sizeBytes();
		result.hasPending = _plannerSync.hasPending();
		result.error = _plannerSync.lastError();
		try {
			if (_planner.applyEngineResult(result)) {
				++_plannerRevision;
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: разделы — состояние «Плана» не разобрано: %1").arg(QString::fromUtf8(e.what())));
		}
	}

	void refreshCloud() {
		auto view = std::make_shared<CloudView>();
		try {
			view->state = _drive.state();
		} catch (const std::exception &e) {
			LOG(("Parvane: разделы — состояние облака: %1").arg(QString::fromUtf8(e.what())));
		}
		view->status = _cloud.status();
		view->rootId = _cloud.rootId();
		view->containers = _cloud.containers();
		view->lastError = _cloud.lastError();
		view->usage = _usage;
		view->revision = _cloud.revision();
		const auto key = std::make_tuple(
			view->status,
			view->rootId.value_or(std::string()),
			view->revision,
			view->lastError.value_or(std::string()),
			view->usage ? view->usage->dump() : std::string(),
			view->containers.size());
		if (key == _cloudSent) {
			return;
		}
		_cloudSent = key;
		if (_notesLoaded) {
			_notes.setCloudData(view->state);
		}
		PostMain([view] { SetCloud(view); });
	}

	void publishPlanner() {
		const auto now = NowMs();
		auto view = std::make_shared<PlannerView>();
		view->state = _planner.state();
		view->status = _planner.status();
		view->isLoaded = _planner.isLoaded();
		view->isCached = _planner.isCached();
		view->canUndo = _planner.canUndo();
		view->notice = _planner.notice(now);
		view->sizeBytes = _planner.sizeBytes();
		view->lastError = _plannerSync.lastError();
		// Снимок не изменился — экранам не слать (сравнение по JSON состояния дорого: по полям статуса и ревизии)
		const auto key = std::make_tuple(
			view->status,
			view->isLoaded,
			view->canUndo,
			view->notice ? view->notice->text : std::string(),
			_plannerRevision);
		if (key == _plannerSent) {
			return;
		}
		_plannerSent = key;
		view->revision = _plannerRevision;
		PostMain([view] { SetPlanner(view); });
	}

	void publishNotes() {
		const auto notice = _notes.notice();
		const auto key = std::make_tuple(
			_notes.revision(),
			int(_notes.status()),
			notice ? (notice->code + '\x01' + std::to_string(notice->at)) : std::string(),
			_notes.guideOpenId().value_or(std::string()),
			static_cast<const void*>(_notes.cloudData().get()));
		if (key == _notesSent) {
			return;
		}
		_notesSent = key;
		auto view = std::make_shared<NotesView>();
		view->notes = _notes.notes();
		view->canvases = _notes.canvases();
		view->folders = _notes.folders();
		view->status = _notes.status();
		view->notice = _notes.notice();
		view->guideOpenId = _notes.guideOpenId();
		view->cloud = _notes.cloudData();
		view->revision = _notes.revision();
		PostMain([view] { SetNotes(view); });
	}

	void flushRecords() {
		_records.flush();
		_texts.flush();
	}

public:
	// Ревизия «Плана»: растёт при каждой правке и ответе движка (ключ снимка)
	void bumpPlanner() { ++_plannerRevision; }
	void setUsage(std::optional<json> usage) { _usage = std::move(usage); _cloudDirty = true; }

	static void SetPlanner(std::shared_ptr<const PlannerView> view);
	static void SetCloud(std::shared_ptr<const CloudView> view);
	static void SetNotes(std::shared_ptr<const NotesView> view);

private:
	SessionTransport _transport;
	FileRecords _records;
	FileRecords _texts;
	SessionBlobs _blobs;
	PlannerHost _plannerHost;
	NotesHostImpl _notesHost;
	planner::PlannerSync _plannerSync;
	planner::PlannerStore _planner;
	cloud::CloudSync _cloud;
	cloud::CloudDrive _drive;
	notes::NotesStore _notes;

	std::string _self;
	Section _shown = Section::Chats;
	bool _paletteOpen = false;
	bool _notesLoaded = false;
	std::function<void()> _notesRelease;
	bool _plannerDirty = false;
	bool _cloudDirty = false;
	bool _notesDirty = false;
	std::int64_t _linkingPollAt = 0;
	std::uint64_t _plannerRevision = 0;
	std::tuple<std::string, bool, bool, std::string, std::uint64_t> _plannerSent;
	std::tuple<std::uint64_t, int, std::string, std::string, const void*> _notesSent;
	std::tuple<std::string, std::string, std::uint64_t, std::string, std::string, std::size_t> _cloudSent;
	std::optional<json> _usage;

};

void PlannerHost::apply(const std::vector<planner::PlannerChange> &changes) {
	_hub.plannerSync().apply(json(changes));
	_hub.bumpPlanner();
}

void PlannerHost::flush() {
	_hub.plannerSync().flush();
}

std::optional<json> NotesHostImpl::callParvane(const std::string &method, const json &args) {
	try {
		auto result = _hub.drive().handle(method, args);
		_hub.markCloudDirty();
		return result;
	} catch (const std::exception &e) {
		LOG(("Parvane: разделы — %1: %2").arg(QString::fromStdString(method), QString::fromUtf8(e.what())));
		return std::nullopt;
	}
}

domain::RecordStore *NotesHostImpl::textCache() {
	return &_hub.texts();
}

planner::State NotesHostImpl::plannerState() {
	return _hub.plannerStore().state();
}

void NotesHostImpl::updatePlanner(const std::function<void(planner::State&)> &mutate) {
	_hub.plannerStore().update(mutate, std::nullopt, NowMs());
	_hub.bumpPlanner();
}

// ── поток ──────────────────────────────────────────────────────────────────────

struct Thread {
	std::mutex mutex;
	std::condition_variable wake;
	std::deque<std::function<void(Hub&)>> jobs;
	bool stop = false;
	bool started = false;
	std::thread thread;
};

Thread &Worker() {
	static auto result = Thread();
	return result;
}

void Run() {
	auto &t = Worker();
	auto hub = std::make_unique<Hub>();
	while (true) {
		auto job = std::function<void(Hub&)>();
		{
			auto lock = std::unique_lock(t.mutex);
			const auto until = std::chrono::system_clock::time_point(std::chrono::milliseconds(hub->nextWakeMs()));
			t.wake.wait_until(lock, until, [&] { return t.stop || !t.jobs.empty(); });
			if (t.stop && t.jobs.empty()) {
				break;
			}
			if (!t.jobs.empty()) {
				job = std::move(t.jobs.front());
				t.jobs.pop_front();
			}
		}
		try {
			hub->syncSession();
			if (job) {
				job(*hub);
			}
			hub->tick();
			hub->publish();
		} catch (const std::exception &e) {
			LOG(("Parvane: разделы — задание не выполнено: %1").arg(QString::fromUtf8(e.what())));
		}
	}
	hub->shutdown();
}

void Enqueue(std::function<void(Hub&)> job) {
	auto &t = Worker();
	{
		auto lock = std::lock_guard(t.mutex);
		if (t.stop) {
			return;
		}
		if (!t.started) {
			t.started = true;
			t.thread = std::thread(Run);
		}
		t.jobs.push_back(std::move(job));
	}
	t.wake.notify_one();
}

// ── снимки на главном потоке ───────────────────────────────────────────────────

rpl::variable<std::shared_ptr<const PlannerView>> &PlannerVar() {
	static auto result = rpl::variable<std::shared_ptr<const PlannerView>>(std::make_shared<PlannerView>());
	return result;
}

rpl::variable<std::shared_ptr<const NotesView>> &NotesVar() {
	static auto result = rpl::variable<std::shared_ptr<const NotesView>>(std::make_shared<NotesView>());
	return result;
}

rpl::variable<std::shared_ptr<const CloudView>> &CloudVar() {
	static auto result = rpl::variable<std::shared_ptr<const CloudView>>(std::make_shared<CloudView>());
	return result;
}

void Hub::SetPlanner(std::shared_ptr<const PlannerView> view) {
	PlannerVar() = std::move(view);
}

void Hub::SetCloud(std::shared_ptr<const CloudView> view) {
	CloudVar() = std::move(view);
}

void Hub::SetNotes(std::shared_ptr<const NotesView> view) {
	NotesVar() = std::move(view);
}

} // namespace

void PostMain(std::function<void()> fn) {
	crl::on_main([fn = std::move(fn)] { fn(); });
}

void Post(std::function<void(Workers&)> job) {
	Enqueue([job = std::move(job)](Hub &hub) {
		auto workers = hub.workers();
		job(workers);
		// Перечитать модули; экранам уйдёт снимок, только если данные изменились (иначе экран, который
		// на каждый снимок спрашивает данные заданием, зацикливается)
		hub.markPlannerDirty();
		hub.markCloudDirty();
		hub.markNotesDirty();
	});
}

std::shared_ptr<const PlannerView> Planner() {
	return PlannerVar().current();
}

rpl::producer<std::shared_ptr<const PlannerView>> PlannerValue() {
	return PlannerVar().value();
}

std::shared_ptr<const NotesView> Notes() {
	return NotesVar().current();
}

rpl::producer<std::shared_ptr<const NotesView>> NotesValue() {
	return NotesVar().value();
}

std::shared_ptr<const CloudView> Cloud() {
	return CloudVar().current();
}

rpl::producer<std::shared_ptr<const CloudView>> CloudValue() {
	return CloudVar().value();
}

void UpdatePlanner(std::function<void(planner::State&)> mutate, const QString &notice) {
	auto text = notice.isEmpty() ? std::optional<std::string>() : std::optional(notice.toStdString());
	Enqueue([mutate = std::move(mutate), text = std::move(text)](Hub &hub) {
		hub.plannerStore().update(mutate, text, NowMs());
		hub.bumpPlanner();
	});
}

void UndoPlanner(const QString &notice) {
	Enqueue([text = notice.toStdString()](Hub &hub) {
		hub.plannerStore().undo(text, NowMs());
		hub.bumpPlanner();
	});
}

void ApplyCloud(const std::string &container, json ops, std::function<void(bool)> done) {
	Enqueue([container, ops = std::move(ops), done = std::move(done)](Hub &hub) {
		auto ok = false;
		try {
			const auto result = hub.drive().applyOps(container, ops);
			ok = !result.is_object() || !result.contains("error");
		} catch (const std::exception &e) {
			LOG(("Parvane: разделы — правка облака не применена: %1").arg(QString::fromUtf8(e.what())));
		}
		hub.markCloudDirty();
		hub.markNotesDirty();
		if (done) {
			PostMain([done, ok] { done(ok); });
		}
	});
}

void CallCloud(const std::string &method, json args, std::function<void(std::optional<json>)> done) {
	Enqueue([method, args = std::move(args), done = std::move(done)](Hub &hub) {
		auto result = std::optional<json>();
		try {
			result = hub.drive().handle(method, args);
			if (method == "parvaneCloudUsage" && result) {
				hub.setUsage(*result);
			}
		} catch (const std::exception &e) {
			LOG(("Parvane: разделы — %1: %2").arg(QString::fromStdString(method), QString::fromUtf8(e.what())));
		}
		hub.markCloudDirty();
		hub.markNotesDirty();
		if (done) {
			PostMain([done, result = std::move(result)] { done(result); });
		}
	});
}

void SetShownSection(Section section) {
	Enqueue([section](Hub &hub) { hub.setShown(section); });
}

void SetPaletteOpen(bool open) {
	Enqueue([open](Hub &hub) { hub.setPaletteOpen(open); });
}

void SetWindowVisible(bool visible) {
	Enqueue([visible](Hub &hub) { hub.setVisible(visible); });
}

void OnEngineEvent(const json &event) {
	Enqueue([event](Hub &hub) { hub.engineEvent(event); });
}

void OnSessionChanged() {
	Enqueue([](Hub &hub) { hub.syncSession(); });
}

void OnAccountReset() {
	// Экранам и палитре — сразу пустые снимки (окно «Статья», палитра Ctrl+K читают их), модули — потоком разделов
	Hub::SetPlanner(std::make_shared<PlannerView>());
	Hub::SetCloud(std::make_shared<CloudView>());
	Hub::SetNotes(std::make_shared<NotesView>());
	Enqueue([](Hub &hub) { hub.resetAccount(); });
}

void DetachAccount(std::function<void()> done) {
	{
		auto &t = Worker();
		auto lock = std::lock_guard(t.mutex);
		if (t.stop) {
			PostMain(std::move(done)); // потока уже нет — писать некому
			return;
		}
	}
	Enqueue([done = std::move(done)](Hub &hub) mutable {
		hub.resetAccount();
		PostMain(std::move(done));
	});
}

void Shutdown() {
	auto &t = Worker();
	{
		auto lock = std::lock_guard(t.mutex);
		if (!t.started || t.stop) {
			t.stop = true;
			return;
		}
		t.stop = true;
	}
	t.wake.notify_one();
	if (t.thread.joinable()) {
		t.thread.join();
	}
}

} // namespace Parvane::Sections
