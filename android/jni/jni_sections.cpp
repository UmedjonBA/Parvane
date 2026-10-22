// Parvane Android (spec 031): данные разделов «План», «Здоровье», «Знания», «Облако» — порт хозяйства desktop
// parvane_sections_data.cpp без Qt. Логика — в ядре (`parvane::sections::*`, порт web с тестами); здесь — один
// рабочий поток с PlannerSync/PlannerStore, CloudSync/CloudDrive и NotesStore (их вызовы блокирующие, сеть — через
// v2-сессию), записи устройства (зашифрованные файлы каталога состояния) и снимки для экранов Kotlin — JSON
// (имена полей как в web), событие `sections_snapshot` при каждом изменении (только когда данные изменились).
#include "jni_internal.h"

#include <parvane/blobcrypt.h>
#include <parvane/sections/cloud_sync.h>
#include <parvane/sections/notes_store.h>
#include <parvane/sections/planner_store.h>
#include <parvane/sections/planner_sync.h>
#include <parvane/storecrypt.h>
#include <parvane/v2_engine.h>

#include <openssl/rand.h>
#include <openssl/sha.h>

#include <chrono>
#include <condition_variable>
#include <ctime>
#include <deque>
#include <future>
#include <thread>

namespace pvjni {
namespace {

namespace planner = parvane::sections::planner;
namespace notes = parvane::sections::notes;
namespace cloud = parvane::sections::cloud;
namespace domain = parvane::sections::domain;
using SessionPtr = std::shared_ptr<parvane::v2::Session>;

constexpr auto kCloudChunkBytes = std::size_t(512 * 1024); // web CLOUD_CHUNK_BYTES
constexpr auto kDriveBucket = "BLOB_BUCKET_DRIVE";
constexpr auto kIdleWaitMs = std::int64_t(60 * 1000);
constexpr auto kLinkingPollMs = std::int64_t(3000);

std::atomic<bool> g_russian{true};

// ── транспорт поверх v2-сессии ─────────────────────────────────────────────────

class SessionTransport final : public domain::DomainTransport {
public:
    void setSession(SessionPtr session) { session_ = std::move(session); }
    [[nodiscard]] const SessionPtr &session() const { return session_; }

    json engine(const std::string &name, const json &args) override { return need()->engineCall(name, args, false); }
    json engineWithNeeds(const std::string &name, const json &args) override { return need()->engineCall(name, args, true); }
    std::string request(bool anon, const std::string &method, const std::string &body, const std::string &dest) override {
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
    bool hasClient() override { return session_ != nullptr; }
    bool isReady() override { return session_ && session_->isReady(); }
    bool needsLinking() override { return session_ && session_->needsLinking(); }
    std::string self() override { return session_ ? session_->self() : std::string(); }
    std::string serverDomain() override { return session_ ? session_->serverDomain() : std::string(); }
    void persist() override { if (session_) session_->persistEngine(); }
    std::int64_t nowMs() override { return pvjni::nowMs(); }
    void log(const std::string &message) override { LOGI("разделы — %s", message.c_str()); }

private:
    [[nodiscard]] parvane::v2::Session *need() const {
        if (!session_) throw domain::BusError("ERROR_CODE_UNAVAILABLE");
        return session_.get();
    }
    SessionPtr session_;
};

// ── записи устройства: зашифрованный файл, пишется, когда что-то изменилось ────

class FileRecords final : public domain::RecordStore {
public:
    void open(const std::string &path) {
        path_ = path;
        memory_ = domain::MemoryRecords();
        dirty_ = false;
        if (path.empty()) return;
        const auto raw = parvane::storecrypt::readFile(path);
        if (raw.empty()) return;
        const auto j = json::parse(raw, nullptr, false);
        if (j.is_object()) memory_ = domain::MemoryRecords(j);
    }
    std::optional<json> load(const std::string &key) override { return memory_.load(key); }
    void save(const std::string &key, const json &value) override {
        memory_.save(key, value);
        dirty_ = true;
    }
    void remove(const std::string &key) override {
        memory_.remove(key);
        dirty_ = true;
    }
    void flush() {
        if (!dirty_ || path_.empty()) return;
        dirty_ = false;
        if (!parvane::storecrypt::writeFile(path_, memory_.toJson().dump())) LOGE("разделы — записи не сохранены");
    }

private:
    std::string path_;
    domain::MemoryRecords memory_;
    bool dirty_ = false;
};

// ── блобы личного диска ────────────────────────────────────────────────────────

std::string randomRaw(std::size_t n) {
    std::string out(n, '\0');
    if (RAND_bytes(reinterpret_cast<unsigned char *>(out.data()), int(n)) != 1) throw std::runtime_error("RAND_bytes");
    return out;
}

class SessionBlobs final : public cloud::CloudBlobs {
public:
    explicit SessionBlobs(SessionTransport &transport) : transport_(transport) {}

    json upload(const std::string &bytes, const std::string &) override {
        const auto session = transport_.session();
        if (!session) throw domain::BusError("ERROR_CODE_UNAVAILABLE");
        const auto sealed = parvane::blobcrypt::encrypt(bytes);
        const auto capability = randomRaw(32);
        std::string fileId;
        try {
            fileId = session->uploadBlob(sealed.ciphertext, capability, kCloudChunkBytes, kDriveBucket);
        } catch (const parvane::v2::V2Error &e) {
            throw domain::BusError(e.code());
        }
        const auto chunks = std::max<std::size_t>(1, (sealed.ciphertext.size() + kCloudChunkBytes - 1) / kCloudChunkBytes);
        return json{{"fileId", fileId}, {"key", sealed.keyB64}, {"nonce", sealed.nonceB64},
                    {"capability", domain::toBase64(capability)}, {"size", std::int64_t(bytes.size())},
                    {"chunks", std::int64_t(chunks)}};
    }
    std::optional<std::string> download(const json &blob) override {
        const auto session = transport_.session();
        if (!session || !blob.is_object()) return std::nullopt;
        const auto fileId = blob.value("fileId", std::string());
        const auto capability = blob.value("capability", std::string());
        if (fileId.empty() || capability.empty()) return std::nullopt;
        try {
            const auto cipher = session->downloadBlobCap(
                fileId, domain::fromBase64(capability), blob.value("domain", std::string()),
                std::size_t(std::max<std::int64_t>(0, blob.value(cloud::kBlobMaxBytesKey, std::int64_t(0)))));
            return parvane::blobcrypt::decrypt(cipher, blob.value("key", std::string()), blob.value("nonce", std::string()));
        } catch (const parvane::v2::V2Error &e) {
            throw domain::BusError(e.code());
        }
    }
    json usage() override {
        const auto body = transport_.encodeMethod("cloud.blob.usage", json::object());
        return transport_.decodeMethod("cloud.blob.usage", transport_.request(false, "cloud.blob.usage", body, {}));
    }
    std::string randomBytes(std::size_t n) override { return randomRaw(n); }
    std::string sha256(const std::string &bytes) override {
        std::string out(SHA256_DIGEST_LENGTH, '\0');
        SHA256(reinterpret_cast<const unsigned char *>(bytes.data()), bytes.size(), reinterpret_cast<unsigned char *>(out.data()));
        return out;
    }
    std::string sealWithKey(const std::string &plain, const std::string &keyRaw, const std::string &nonceRaw) override {
        return parvane::blobcrypt::encryptWithKey(plain, keyRaw, nonceRaw);
    }
    std::optional<std::string> openWithKey(const std::string &cipher, const std::string &keyB64, const std::string &nonceB64) override {
        return parvane::blobcrypt::decrypt(cipher, keyB64, nonceB64);
    }
    std::string uploadCipher(const std::string &cipher, const std::string &capabilityRaw) override {
        const auto session = transport_.session();
        if (!session) throw domain::BusError("ERROR_CODE_UNAVAILABLE");
        try {
            return session->uploadBlob(cipher, capabilityRaw, kCloudChunkBytes, kDriveBucket);
        } catch (const parvane::v2::V2Error &e) {
            throw domain::BusError(e.code());
        }
    }

private:
    SessionTransport &transport_;
};

// ── хозяйство рабочего потока ──────────────────────────────────────────────────

class Hub;

class PlannerHost final : public planner::PlannerStoreHost {
public:
    explicit PlannerHost(Hub &hub) : hub_(hub) {}
    void apply(const std::vector<planner::PlannerChange> &changes) override;
    void flush() override;

private:
    Hub &hub_;
};

std::string localDate(std::int64_t ms, const char *format) {
    const std::time_t t = static_cast<std::time_t>(ms / 1000);
    std::tm tm{};
    localtime_r(&t, &tm);
    char buf[32];
    std::strftime(buf, sizeof(buf), format, &tm);
    return buf;
}

class NotesHostImpl final : public notes::NotesHost {
public:
    explicit NotesHostImpl(Hub &hub) : hub_(hub) {}
    std::optional<json> callParvane(const std::string &method, const json &args) override;
    int64_t nowMs() override { return pvjni::nowMs(); }
    std::string today() override { return localDate(pvjni::nowMs(), "%Y-%m-%d"); }
    double nowMinutes() override {
        const std::time_t t = std::time(nullptr);
        std::tm tm{};
        localtime_r(&t, &tm);
        return tm.tm_hour * 60. + tm.tm_min + tm.tm_sec / 60.;
    }
    std::string localTimeLabel(int64_t ms) override { return localDate(ms, "%Y-%m-%d %H:%M:%S"); }
    domain::RecordStore *textCache() override;
    planner::State plannerState() override;
    void updatePlanner(const std::function<void(planner::State &)> &mutate) override;

private:
    Hub &hub_;
};

json noteJson(const notes::NoteRef &n) {
    return json{{"id", n->id}, {"title", n->title}, {"folder", n->folder}, {"text", n->text},
                {"updatedAt", n->updatedAt}, {"fileId", n->fileId}, {"isDaily", n->isDaily}};
}

json canvasJson(const notes::CanvasRef &c) {
    return json{{"id", c->id}, {"title", c->title}, {"text", c->text}, {"fileId", c->fileId}};
}

// Снимки для Kotlin (последние; читаются по событию `sections_snapshot`)
std::mutex g_snapMu;
std::map<std::string, std::string> g_snapshots;

void publishSnapshot(const std::string &domainName, const json &snapshot) {
    {
        std::lock_guard<std::mutex> lk(g_snapMu);
        g_snapshots[domainName] = snapshot.dump();
    }
    emit(json{{"type", "sections_snapshot"}, {"domain", domainName}});
}

class Hub final {
public:
    Hub()
        : blobs_(transport_), plannerHost_(*this), notesHost_(*this),
          plannerSync_(transport_, records_, plannerHooks()), planner_(plannerHost_),
          cloud_(transport_, records_, cloudHooks()), drive_(cloud_, blobs_, transport_), notes_(notesHost_) {
        notes_.onChanged = [this] { notesDirty_ = true; };
    }

    void syncSession() {
        const auto session = v2Any();
        const auto me = session ? session->self() : std::string();
        if (session == transport_.session()) return;
        flushRecords();
        transport_.setSession(session);
        if (me != self_) switchAccount(me);
        applyWanted();
    }

    void resetAccount() {
        flushRecords();
        transport_.setSession(nullptr);
        switchAccount(std::string());
    }

    void switchAccount(const std::string &me) {
        self_ = me;
        plannerSync_.reset();
        planner_.reset();
        cloud_.reset();
        notes_.signOut();
        if (notesRelease_) std::exchange(notesRelease_, nullptr)();
        usage_.reset();
        const auto dir = me.empty() ? std::string() : v2StateDir(me);
        records_.open(dir.empty() ? std::string() : dir + "/sections-records.json");
        texts_.open(dir.empty() ? std::string() : dir + "/sections-texts.json");
        if (!me.empty()) planner_.setUser(me);
        notesLoaded_ = false;
        notesSent_ = {};
        cloudSent_ = {};
        plannerSent_ = {};
        plannerDirty_ = cloudDirty_ = notesDirty_ = true;
    }

    void setShown(const std::string &section) {
        shown_ = section;
        applyWanted();
    }
    void setPaletteOpen(bool open) {
        paletteOpen_ = open;
        applyWanted();
    }
    void setVisible(bool visible) {
        plannerSync_.setVisible(visible);
        cloud_.setVisible(visible);
    }

    void engineEvent(const std::string &domainName, const std::string &id) {
        if (domainName == "planner") {
            plannerSync_.onEngineEvent();
            plannerDirty_ = true;
        } else if (domainName == "cloud") {
            cloud_.onEngineEvent(id);
            cloudDirty_ = true;
        }
    }

    void tick() {
        plannerSync_.tick();
        cloud_.tick();
        if (planner_.needsLinkingPoll() && nowMs() >= linkingPollAt_) {
            linkingPollAt_ = nowMs() + kLinkingPollMs;
            plannerDirty_ = true;
        }
    }

    [[nodiscard]] std::int64_t nextWakeMs() const {
        auto result = nowMs() + kIdleWaitMs;
        if (const auto at = plannerSync_.nextWakeMs()) result = std::min(result, *at);
        if (const auto at = cloud_.nextWakeMs()) result = std::min(result, *at);
        if (planner_.needsLinkingPoll()) result = std::min(result, linkingPollAt_);
        if (planner_.notice(nowMs())) result = std::min(result, nowMs() + planner::PlannerStore::kNoticeHideMs);
        return result;
    }

    void publish() {
        if (plannerDirty_) {
            plannerDirty_ = false;
            refreshPlanner();
        }
        if (cloudDirty_) {
            cloudDirty_ = false;
            refreshCloud();
        }
        if (notesDirty_) {
            notesDirty_ = false;
            publishNotes();
        }
        publishPlanner();
        flushRecords();
    }

    void markAllDirty() { plannerDirty_ = cloudDirty_ = notesDirty_ = true; }
    void bumpPlanner() { ++plannerRevision_; }
    void setUsage(std::optional<json> usage) {
        usage_ = std::move(usage);
        cloudDirty_ = true;
    }

    planner::PlannerSync &plannerSync() { return plannerSync_; }
    planner::PlannerStore &plannerStore() { return planner_; }
    cloud::CloudDrive &drive() { return drive_; }
    notes::NotesStore &notesStore() { return notes_; }
    FileRecords &texts() { return texts_; }
    const std::string &self() const { return self_; }
    [[nodiscard]] std::string vaultName() const { return g_russian ? "Знания" : "Knowledge"; }

    void shutdown() {
        try {
            plannerSync_.pageHide();
            plannerSync_.flush();
        } catch (const std::exception &e) {
            LOGE("разделы — правки «Плана» не досланы: %s", e.what());
        }
        flushRecords();
    }

private:
    planner::PlannerHooks plannerHooks() {
        return planner::PlannerHooks{
            .stateContainer = [this]() -> std::optional<planner::ContainerRef> {
                const auto session = transport_.session();
                if (!session) return std::nullopt;
                const auto snapshot = session->stateSnapshot();
                if (!snapshot.is_object() || !snapshot.contains("planner_container")) return std::nullopt;
                const auto &entry = snapshot["planner_container"];
                const auto ref = entry.is_object() ? entry.value("ref", json::object()) : json::object();
                const auto id = ref.is_object() ? ref.value("id", std::string()) : std::string();
                if (id.empty()) return std::nullopt;
                return planner::ContainerRef{.domain = ref.value("domain", std::string()), .id = domain::b64ToHex(id)};
            },
            .recordContainer =
                [this](const planner::ContainerRef &ref) {
                    if (const auto session = transport_.session())
                        session->stateCall("plannerContainerSet", json{{"domain", ref.domain}, {"idHex", ref.id}});
                },
            .onChanged = [this] { plannerDirty_ = true; },
        };
    }

    cloud::CloudHooks cloudHooks() {
        return cloud::CloudHooks{
            .stateEntries =
                [this] {
                    const auto session = transport_.session();
                    return session ? cloud::parseCloudEntries(session->stateSnapshot()) : std::vector<cloud::CloudStateEntry>();
                },
            .recordEntry =
                [this](const cloud::CloudStateEntry &entry) {
                    if (const auto session = transport_.session())
                        session->stateCall("cloudContainerSet", json{{"containerJson", cloud::cloudEntryToState(entry)}});
                },
            .deleteBlob =
                [this](const std::string &fileId) {
                    const auto body = transport_.encodeMethod("cloud.blob.delete", json{{"file_id", fileId}});
                    transport_.request(false, "cloud.blob.delete", body, {});
                },
            .refreshPeerLog =
                [this](const std::string &user) {
                    if (const auto session = transport_.session()) session->refreshPeerLog(user);
                },
            .onChanged = [this] { cloudDirty_ = true; },
        };
    }

    void applyWanted() {
        if (self_.empty()) return;
        const auto plannerShown = shown_ == "calendar" || shown_ == "health";
        const auto cloudShown = shown_ == "files" || shown_ == "knowledge";
        plannerSync_.ensure(!plannerShown); // «План» нужен и в фоне (напоминания, карточки задания)
        plannerSync_.setActive(plannerShown);
        if (cloudShown || paletteOpen_) cloud_.ensureSoon(true);
        cloud_.setActive(cloudShown);
        if (shown_ == "knowledge" || paletteOpen_) {
            if (!notesLoaded_) {
                notesLoaded_ = true;
                auto options = notes::NotesOptions();
                if (!g_russian) {
                    options.guideLang = "en";
                    options.vaultName = "Knowledge";
                }
                notes_.loadNotes(self_, options);
            }
            if (!notesRelease_) notesRelease_ = notes_.retainNotes();
        } else if (notesRelease_) {
            std::exchange(notesRelease_, nullptr)();
        }
        plannerDirty_ = cloudDirty_ = true;
    }

    void refreshPlanner() {
        auto result = planner::EngineStateResult();
        result.status = plannerSync_.status();
        result.state = plannerSync_.stateJson();
        result.sizeBytes = plannerSync_.sizeBytes();
        result.hasPending = plannerSync_.hasPending();
        result.error = plannerSync_.lastError();
        try {
            if (planner_.applyEngineResult(result)) ++plannerRevision_;
        } catch (const std::exception &e) {
            LOGE("разделы — состояние «Плана» не разобрано: %s", e.what());
        }
    }

    void refreshCloud() {
        json state;
        try {
            state = drive_.state();
        } catch (const std::exception &e) {
            LOGE("разделы — состояние облака: %s", e.what());
        }
        const auto status = cloud_.status();
        const auto rootId = cloud_.rootId();
        const auto containers = cloud_.containers();
        const auto lastError = cloud_.lastError();
        const auto revision = cloud_.revision();
        const auto key = std::make_tuple(status, rootId.value_or(std::string()), revision, lastError.value_or(std::string()),
                                         usage_ ? usage_->dump() : std::string(), containers.size());
        if (key == cloudSent_) return;
        cloudSent_ = key;
        if (notesLoaded_) notes_.setCloudData(state);
        auto list = json::array();
        for (const auto &c : containers) list.push_back(cloud::toJson(c));
        publishSnapshot("cloud", json{{"state", state}, {"status", status}, {"rootId", rootId ? json(*rootId) : json()},
                                      {"containers", list}, {"lastError", lastError ? json(*lastError) : json()},
                                      {"usage", usage_ ? *usage_ : json()}, {"revision", revision}});
    }

    void publishPlanner() {
        const auto now = nowMs();
        const auto notice = planner_.notice(now);
        const auto key = std::make_tuple(planner_.status(), planner_.isLoaded(), planner_.canUndo(),
                                         notice ? notice->text : std::string(), plannerRevision_);
        if (key == plannerSent_) return;
        plannerSent_ = key;
        const auto lastError = plannerSync_.lastError();
        publishSnapshot("planner", json{{"state", planner_.state()}, {"status", planner_.status()}, {"isLoaded", planner_.isLoaded()},
                                        {"isCached", planner_.isCached()}, {"canUndo", planner_.canUndo()},
                                        {"notice", notice ? json{{"text", notice->text}, {"canUndo", notice->canUndo}} : json()},
                                        {"sizeBytes", planner_.sizeBytes()},
                                        {"lastError", lastError ? json(*lastError) : json()}, {"revision", plannerRevision_}});
    }

    void publishNotes() {
        const auto notice = notes_.notice();
        const auto key = std::make_tuple(notes_.revision(), int(notes_.status()),
                                         notice ? (notice->code + '\x01' + std::to_string(notice->at)) : std::string(),
                                         notes_.guideOpenId().value_or(std::string()),
                                         static_cast<const void *>(notes_.cloudData().get()));
        if (key == notesSent_) return;
        notesSent_ = key;
        auto list = json::array(), canvases = json::array(), folders = json::array();
        for (const auto &n : notes_.notes()) list.push_back(noteJson(n));
        for (const auto &c : notes_.canvases()) canvases.push_back(canvasJson(c));
        for (const auto &f : notes_.folders()) folders.push_back(json{{"id", f.id}, {"path", f.path}, {"name", f.name}});
        publishSnapshot("notes", json{{"notes", list}, {"canvases", canvases}, {"folders", folders},
                                      {"status", notes_.status() == notes::NotesStatus::Ready ? "ready" : "loading"},
                                      {"notice", notice ? json{{"code", notice->code}, {"title", notice->title}, {"at", notice->at}} : json()},
                                      {"guideOpenId", notes_.guideOpenId() ? json(*notes_.guideOpenId()) : json()},
                                      {"revision", notes_.revision()}});
    }

    void flushRecords() {
        records_.flush();
        texts_.flush();
    }

    SessionTransport transport_;
    FileRecords records_;
    FileRecords texts_;
    SessionBlobs blobs_;
    PlannerHost plannerHost_;
    NotesHostImpl notesHost_;
    planner::PlannerSync plannerSync_;
    planner::PlannerStore planner_;
    cloud::CloudSync cloud_;
    cloud::CloudDrive drive_;
    notes::NotesStore notes_;

    std::string self_;
    std::string shown_ = "chats";
    bool paletteOpen_ = false;
    bool notesLoaded_ = false;
    std::function<void()> notesRelease_;
    bool plannerDirty_ = false;
    bool cloudDirty_ = false;
    bool notesDirty_ = false;
    std::int64_t linkingPollAt_ = 0;
    std::uint64_t plannerRevision_ = 0;
    std::tuple<std::string, bool, bool, std::string, std::uint64_t> plannerSent_;
    std::tuple<std::uint64_t, int, std::string, std::string, const void *> notesSent_;
    std::tuple<std::string, std::string, std::uint64_t, std::string, std::string, std::size_t> cloudSent_;
    std::optional<json> usage_;
};

void PlannerHost::apply(const std::vector<planner::PlannerChange> &changes) {
    hub_.plannerSync().apply(json(changes));
    hub_.bumpPlanner();
}

void PlannerHost::flush() { hub_.plannerSync().flush(); }

std::optional<json> NotesHostImpl::callParvane(const std::string &method, const json &args) {
    try {
        return hub_.drive().handle(method, args);
    } catch (const std::exception &e) {
        LOGE("разделы — %s: %s", method.c_str(), e.what());
        return std::nullopt;
    }
}

domain::RecordStore *NotesHostImpl::textCache() { return &hub_.texts(); }
planner::State NotesHostImpl::plannerState() { return hub_.plannerStore().state(); }
void NotesHostImpl::updatePlanner(const std::function<void(planner::State &)> &mutate) {
    hub_.plannerStore().update(mutate, std::nullopt, nowMs());
    hub_.bumpPlanner();
}

// ── поток ──────────────────────────────────────────────────────────────────────

struct Worker {
    std::mutex mutex;
    std::condition_variable wake;
    std::deque<std::function<void(Hub &)>> jobs;
    bool started = false;
};

Worker &worker() {
    static Worker w;
    return w;
}

void run() {
    auto &t = worker();
    auto hub = std::make_unique<Hub>();
    for (;;) {
        std::function<void(Hub &)> job;
        {
            std::unique_lock<std::mutex> lock(t.mutex);
            const auto until = std::chrono::system_clock::time_point(std::chrono::milliseconds(hub->nextWakeMs()));
            t.wake.wait_until(lock, until, [&] { return !t.jobs.empty(); });
            if (!t.jobs.empty()) {
                job = std::move(t.jobs.front());
                t.jobs.pop_front();
            }
        }
        try {
            hub->syncSession();
            if (job) job(*hub);
            hub->tick();
            hub->publish();
        } catch (const std::exception &e) {
            LOGE("разделы — задание не выполнено: %s", e.what());
        }
    }
}

void enqueue(std::function<void(Hub &)> job) {
    auto &t = worker();
    {
        std::lock_guard<std::mutex> lock(t.mutex);
        if (!t.started) {
            t.started = true;
            std::thread(run).detach();
        }
        t.jobs.push_back(std::move(job));
    }
    t.wake.notify_one();
}

// Задание с ответом (Kotlin зовёт с io-потока): ждёт не дольше timeoutMs. null — не успело или сбой.
json ask(std::function<json(Hub &)> job, int timeoutMs = 60000) {
    auto promise = std::make_shared<std::promise<json>>();
    auto future = promise->get_future();
    enqueue([job = std::move(job), promise](Hub &hub) {
        try {
            promise->set_value(job(hub));
        } catch (const std::exception &e) {
            LOGE("разделы — задание: %s", e.what());
            promise->set_value(json());
        }
        hub.markAllDirty();
    });
    if (future.wait_for(std::chrono::milliseconds(timeoutMs)) != std::future_status::ready) return json();
    return future.get();
}

std::optional<std::string> optString(const json &args, const char *key) {
    if (args.contains(key) && args[key].is_string()) return args[key].get<std::string>();
    return std::nullopt;
}

// Операции заметок (`NotesStore`) по имени — экранам «Знаний».
json notesOp(Hub &hub, const std::string &op, const json &a) {
    auto &n = hub.notesStore();
    const auto vault = hub.vaultName();
    const auto s = [&](const char *k) { return a.value(k, std::string()); };
    if (op == "create") {
        const auto id = n.createNote(s("title"), vault, optString(a, "text"), optString(a, "folderName"), optString(a, "folderId"));
        return id ? json(*id) : json();
    }
    if (op == "save") return n.saveNote(s("id"), s("text"), vault, optString(a, "baseText"));
    if (op == "saveOrRestore") {
        const auto r = n.saveNoteOrRestore(s("id"), s("title"), s("text"), vault, optString(a, "baseText"));
        return json{{"status", r.status}, {"id", r.id}, {"title", r.title}};
    }
    if (op == "rename") return n.renameNote(s("id"), s("title"), vault);
    if (op == "delete") return n.deleteNote(s("id"));
    if (op == "move") return n.moveNote(s("id"), optString(a, "folderId"));
    if (op == "freeTitle") return n.freeNoteTitle(s("id"), s("title"));
    if (op == "createFolder") {
        const auto r = n.createNoteFolder(s("name"), vault);
        return json{{"id", r.id ? json(*r.id) : json()}, {"error", r.error ? json(notes::folderErrorKey(*r.error)) : json()}};
    }
    if (op == "renameFolder") {
        const auto e = n.renameNoteFolder(s("id"), s("name"), vault);
        return e ? json(notes::folderErrorKey(*e)) : json();
    }
    if (op == "deleteFolder") return n.deleteNoteFolder(s("id"), s("mode"));
    if (op == "saveCanvas") {
        const auto id = n.saveCanvas(s("title"), s("text"), vault, optString(a, "id"));
        return id ? json(*id) : json();
    }
    if (op == "renameCanvas") return n.renameCanvas(s("id"), s("title"));
    if (op == "deleteCanvas") return n.deleteCanvas(s("id"));
    if (op == "openDaily") {
        const auto id = n.openDailyNote(s("day"), vault, g_russian ? "Ежедневные" : "Daily");
        return id ? json(*id) : json();
    }
    if (op == "readDaily") {
        const auto r = n.readDailyNote(s("day"));
        if (!r) return json();
        return *r ? json{{"text", **r}} : json{{"text", nullptr}};
    }
    if (op == "restoreGuide") {
        const auto id = n.restoreGuide();
        return id ? json(*id) : json();
    }
    if (op == "consumeGuideOpen") {
        n.consumeGuideOpen();
        return true;
    }
    if (op == "applyPlanner") {
        n.applyPlannerToNotes(vault);
        return true;
    }
    if (op == "saveChatFiles") {
        std::vector<notes::NotesStore::ChatFile> files;
        for (const auto &f : a.value("files", json::array()))
            files.push_back({f.value("fileId", std::string()), f.value("name", std::string()), f.value("mime", std::string()),
                             f.value("size", std::int64_t(0))});
        const auto r = n.saveChatFilesToVault(vault, files);
        return r ? json(*r) : json();
    }
    if (op == "refresh") {
        n.refreshCloud();
        return true;
    }
    throw std::runtime_error("заметки: неизвестная операция " + op);
}

} // namespace

void sectionsEngineEvent(const std::string &domainName, const std::string &id) {
    enqueue([domainName, id](Hub &hub) { hub.engineEvent(domainName, id); });
}

void sectionsSessionChanged() {
    enqueue([](Hub &hub) { hub.syncSession(); });
}

void sectionsAccountReset() {
    {
        std::lock_guard<std::mutex> lk(g_snapMu);
        g_snapshots.clear();
    }
    enqueue([](Hub &hub) { hub.resetAccount(); });
}

} // namespace pvjni

using namespace pvjni;

extern "C" {

// Раздел на экране: chats | calendar | health | knowledge | files.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneSections_nativeShow(JNIEnv *env, jclass, jstring section) {
    const auto s = jstr(env, section);
    enqueue([s](Hub &hub) { hub.setShown(s); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneSections_nativeVisible(JNIEnv *, jclass, jboolean visible) {
    const bool v = visible == JNI_TRUE;
    enqueue([v](Hub &hub) { hub.setVisible(v); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneSections_nativePaletteOpen(JNIEnv *, jclass, jboolean open) {
    const bool o = open == JNI_TRUE;
    enqueue([o](Hub &hub) { hub.setPaletteOpen(o); });
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneSections_nativeSetLanguage(JNIEnv *, jclass, jboolean russian) {
    g_russian = russian == JNI_TRUE;
}

// Сессия сменилась (вход, привязка): поток разделов переподключается.
JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneSections_nativeSessionChanged(JNIEnv *, jclass) {
    enqueue([](Hub &hub) { hub.syncSession(); });
}

// Последний снимок: planner | notes | cloud ("" — ещё нет).
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneSections_nativeSnapshot(JNIEnv *env, jclass, jstring domainJ) {
    const auto d = jstr(env, domainJ);
    std::lock_guard<std::mutex> lk(g_snapMu);
    const auto it = g_snapshots.find(d);
    return jout(env, it == g_snapshots.end() ? std::string() : it->second);
}

// Правка «Плана»: новое состояние целиком (web-JSON) — разница уходит на сервер пакетом; notice — «Отменить».
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneSections_nativePlannerReplace(JNIEnv *env, jclass, jstring stateJson, jstring notice) {
    auto next = json::parse(jstr(env, stateJson), nullptr, false);
    if (!next.is_object()) return JNI_FALSE;
    planner::State state;
    try {
        state = next.get<planner::State>();
    } catch (const std::exception &e) {
        LOGE("«План»: состояние не разобрано: %s", e.what());
        return JNI_FALSE;
    }
    const auto text = jstr(env, notice);
    enqueue([state = std::move(state), text](Hub &hub) {
        hub.plannerStore().update([&](planner::State &s) { s = state; }, text.empty() ? std::nullopt : std::optional(text), nowMs());
        hub.bumpPlanner();
    });
    return JNI_TRUE;
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneSections_nativePlannerUndo(JNIEnv *env, jclass, jstring notice) {
    const auto text = jstr(env, notice);
    enqueue([text](Hub &hub) {
        hub.plannerStore().undo(text, nowMs());
        hub.bumpPlanner();
    });
}

// Метод провайдера облака по имени web (`parvaneCloud*`). Блокирующий. → JSON ответа | "null".
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneSections_nativeCloudCall(JNIEnv *env, jclass, jstring method, jstring argsJson) {
    const auto m = jstr(env, method);
    const auto args = json::parse(jstr(env, argsJson), nullptr, false);
    const auto r = ask([m, args](Hub &hub) -> json {
        const auto result = hub.drive().handle(m, args.is_discarded() ? json() : args);
        if (m == "parvaneCloudUsage" && result) hub.setUsage(*result);
        return result ? *result : json();
    }, 300000);
    return jreply(env, r);
}

// Правки дерева облака. Блокирующий. → true — применено.
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneSections_nativeCloudApply(JNIEnv *env, jclass, jstring container, jstring opsJson) {
    const auto c = jstr(env, container);
    const auto ops = json::parse(jstr(env, opsJson), nullptr, false);
    const auto r = ask([c, ops](Hub &hub) -> json {
        const auto result = hub.drive().applyOps(c, ops);
        return !result.is_object() || !result.contains("error");
    });
    return r.is_boolean() && r.get<bool>() ? JNI_TRUE : JNI_FALSE;
}

// Операция заметок по имени (create, save, rename, delete, move, folders, canvas, daily, guide…). Блокирующий.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneSections_nativeNotes(JNIEnv *env, jclass, jstring op, jstring argsJson) {
    const auto o = jstr(env, op);
    const auto args = json::parse(jstr(env, argsJson), nullptr, false);
    return jreply(env, ask([o, args](Hub &hub) { return notesOp(hub, o, args.is_object() ? args : json::object()); }));
}

} // extern "C"
