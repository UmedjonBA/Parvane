// Parvane Android (spec 031): данные разделов «План», «Здоровье», «Знания», «Облако» — порт хозяйства desktop
// parvane_sections_data.cpp без Qt. Логика — в ядре (`parvane::sections::*`, порт web с тестами); здесь — один
// рабочий поток с PlannerSync/PlannerStore, CloudSync/CloudDrive и NotesStore (их вызовы блокирующие, сеть — через
// v2-сессию), записи устройства (зашифрованные файлы каталога состояния) и снимки для экранов Kotlin — JSON
// (имена полей как в web), событие `sections_snapshot` при каждом изменении (только когда данные изменились).
#include "jni_internal.h"
#include "jni_planner_ops.h"

#include <parvane/blobcrypt.h>
#include <parvane/sections/cloud_files.h>
#include <parvane/sections/export_source.h>
#include <parvane/sections/cloud_sync.h>
#include <parvane/sections/notes_store.h>
#include <parvane/sections/planner_store.h>
#include <parvane/sections/planner_sync.h>
#include <parvane/sections/task_offer.h>
#include <parvane/storecrypt.h>
#include <parvane/v2_engine.h>

#include <openssl/rand.h>
#include <openssl/sha.h>

#include <chrono>
#include <condition_variable>
#include <ctime>
#include <deque>
#include <fstream>
#include <sstream>
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
            std::int64_t wakeMs = 0;
            try {
                wakeMs = hub->nextWakeMs();
            } catch (const std::exception &e) {
                LOGE("разделы — срок пробуждения: %s", e.what());
                wakeMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count() + 60000;
            }
            const auto until = std::chrono::system_clock::time_point(std::chrono::milliseconds(wakeMs));
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

// Файлы «Облака» (`CloudFiles`/правки дерева ядра) — экрану «Облако»: загрузка/скачивание через файлы
// рабочего каталога (Kotlin копирует из/в content://), папки, переименование, корзина, перенос, совместные
// папки, ссылки для людей без аккаунта.
std::vector<cloud::CloudNode> treeNodes(Hub &hub, const std::string &container) {
    std::vector<cloud::CloudNode> out;
    const auto state = hub.drive().state();
    const auto trees = state.value("trees", json::object());
    const auto it = trees.find(container);
    if (it == trees.end() || !it->is_object()) return out;
    for (const auto &n : it->value("nodes", json::array())) {
        try {
            out.push_back(n.get<cloud::CloudNode>());
        } catch (const std::exception &) {
        }
    }
    return out;
}

std::vector<cloud::CloudNode> pick(const std::vector<cloud::CloudNode> &all, const json &ids) {
    std::vector<cloud::CloudNode> out;
    for (const auto &id : ids) {
        if (!id.is_string()) continue;
        for (const auto &n : all)
            if (n.id == id.get<std::string>()) out.push_back(n);
    }
    return out;
}

std::string gatewayOrigin() {
    std::lock_guard<std::mutex> lk(g_mu);
    return cloud::originOfGateway(g_gatewayUrl);
}

json cloudFilesOp(Hub &hub, const std::string &op, const json &a) {
    const auto s = [&](const char *k) { return a.value(k, std::string()); };
    const auto container = s("container");
    const auto parent = a.contains("parent") && a["parent"].is_string() && !a["parent"].get<std::string>().empty()
                            ? std::optional<std::string>(a["parent"].get<std::string>())
                            : std::nullopt;
    auto files = cloud::CloudFiles(hub.drive());
    if (op == "upload") {
        std::ifstream in(s("path"), std::ios::binary);
        if (!in) return json{{"ok", false}, {"error", "read"}};
        std::ostringstream buf;
        buf << in.rdbuf();
        auto r = cloud::UploadRequest();
        r.container = container;
        r.parent = parent;
        r.name = s("name");
        r.mime = s("mime");
        r.mtime = a.value("mtime", nowMs());
        r.bytes = buf.str();
        if (!s("thumbPath").empty()) {
            std::ifstream t(s("thumbPath"), std::ios::binary);
            std::ostringstream tb;
            tb << t.rdbuf();
            if (!tb.str().empty()) r.thumb = cloud::UploadThumb{tb.str(), a.value("thumbWidth", 0), a.value("thumbHeight", 0)};
        }
        return files.upload(r);
    }
    if (op == "download") {
        const auto r = files.download(container, s("node"));
        if (!r.ok) return json{{"ok", false}, {"error", r.error}};
        std::ofstream out(s("out"), std::ios::binary | std::ios::trunc);
        out.write(r.bytes.data(), std::streamsize(r.bytes.size()));
        return json{{"ok", bool(out)}, {"name", r.name}, {"size", std::int64_t(r.bytes.size())}};
    }
    if (op == "thumb") {
        const auto all = treeNodes(hub, container);
        const auto nodes = pick(all, json::array({s("node")}));
        if (nodes.empty()) return json();
        const auto jpeg = files.thumb(json(nodes.front()));
        if (!jpeg) return json();
        std::ofstream out(s("out"), std::ios::binary | std::ios::trunc);
        out.write(jpeg->data(), std::streamsize(jpeg->size()));
        return bool(out);
    }
    if (op == "createFolder")
        return hub.drive().applyOps(container, cloud::createFolderOps(treeNodes(hub, container), parent, s("name"), cloud::newCloudNodeId()));
    if (op == "rename") {
        const auto all = treeNodes(hub, container);
        const auto nodes = pick(all, json::array({s("node")}));
        if (nodes.empty()) return json{{"ok", false}, {"error", "not-found"}};
        return hub.drive().applyOps(container, cloud::renameOps(all, nodes.front(), s("name")));
    }
    if (op == "trash") return hub.drive().applyOps(container, cloud::trashOps(pick(treeNodes(hub, container), a.value("nodes", json::array())), nowMs()));
    if (op == "restore") {
        const auto all = treeNodes(hub, container);
        return hub.drive().applyOps(container, cloud::restoreOps(all, pick(all, a.value("nodes", json::array()))));
    }
    if (op == "purge") {
        auto r = hub.drive().applyOps(container, cloud::purgeOps(pick(treeNodes(hub, container), a.value("nodes", json::array())), nowMs()));
        hub.drive().handle("parvaneCloudSync", json::object());
        return r;
    }
    if (op == "move") {
        std::vector<cloud::MoveItem> items;
        for (const auto &n : pick(treeNodes(hub, container), a.value("nodes", json::array()))) items.push_back({n.id, n.name});
        const auto to = s("to").empty() ? container : s("to");
        if (to == container) {
            const auto all = treeNodes(hub, container);
            return hub.drive().applyOps(container, cloud::moveOps(all, pick(all, a.value("nodes", json::array())), parent));
        }
        return files.move(container, items, to, parent);
    }
    if (op == "shareFolder") return files.shareFolder(container, s("node"));
    if (op == "unshareFolder") return files.unshareFolder(container, s("name"));
    if (op == "links") return files.links(gatewayOrigin());
    if (op == "linkCreate") {
        const auto node = s("node");
        return files.linkCreate(container, node.empty() ? std::nullopt : std::optional(node), s("name"), a.value("ttlDays", 7),
                                gatewayOrigin());
    }
    if (op == "linkRevoke") return files.linkRevoke(s("id"));
    if (op == "linkExtend") return files.linkExtend(s("id"), a.value("ttlDays", 7));
    throw std::runtime_error("облако: неизвестная операция " + op);
}

// ── выгрузка данных (T039, как desktop parvane_data_export) ──────────────────
// Снимок переписки — из журнала истории устройства (свёртка по uuid), имена чатов и контакты даёт Kotlin;
// «План» и облако — хаб разделов; вложения — кэш устройства либо сервер (расшифровка ключом из содержимого).
json exportSnapshot(const json &meta) {
    const auto session = v2Any();
    const auto self = session ? session->self() : std::string();
    const auto names = meta.value("chats", json::object());
    std::map<std::string, json> chats;
    std::vector<std::string> order;
    for (const auto &e : journalFold()) {
        const auto out = e.value("out", false);
        const auto group = e.value("group", false);
        const auto chat = group ? e.value("to", std::string()) : (out ? e.value("to", std::string()) : e.value("from", std::string()));
        if (chat.empty()) continue;
        if (!chats.count(chat)) {
            order.push_back(chat);
            const auto n = names.value(chat, json::object());
            chats[chat] = json{{"address", chat}, {"kind", chat == self ? "saved" : n.value("kind", group ? "group" : "user")},
                               {"title", n.value("title", chat)}, {"messages", json::array()}};
        }
        auto reactions = json::array();
        for (const auto &r : e.value("reactions", json::array()))
            if (r.is_object()) reactions.push_back(json{{"emoji", r.value("emoji", std::string())}, {"count", r.value("count", 1)}});
        const auto from = e.value("from", std::string());
        auto msg = json{{"uuid", e.value("id", std::string())}, {"from", from},
                        {"fromName", names.value(from, json::object()).value("title", from)}, {"isOutgoing", out},
                        {"ts", e.value("ts", std::int64_t(0))}, {"edited", e.value("edited", false)},
                        {"pinned", e.value("pinned", false)}, {"content", e.value("content", json::object())}};
        if (e.contains("reply_to") && e["reply_to"].is_string()) msg["replyTo"] = e["reply_to"];
        if (!reactions.empty()) msg["reactions"] = reactions;
        chats[chat]["messages"].push_back(std::move(msg));
    }
    auto list = json::array();
    for (const auto &a : order) list.push_back(chats[a]);
    return json{{"self", self}, {"selfName", meta.value("selfName", self)}, {"chats", list},
                {"contacts", meta.value("contacts", json::array())}};
}

class AndroidExportHost final : public parvane::sections::exportdata::ExportHost {
public:
    AndroidExportHost(json snapshot, std::function<bool()> canceled) : snapshot_(std::move(snapshot)), canceled_(std::move(canceled)) {
        for (const auto &chat : snapshot_.value("chats", json::array()))
            for (const auto &m : chat.value("messages", json::array())) {
                const auto &c = m.value("content", json::object());
                const auto fileId = c.value("file_id", std::string());
                if (!fileId.empty()) keys_[fileId] = {c.value("file_key", std::string()), c.value("file_nonce", std::string())};
            }
    }
    std::optional<json> callParvane(const std::string &method, const json &args) override {
        if (method == "parvaneExportSnapshot") return snapshot_;
        if (method == "parvanePlannerState") {
            return ask([](Hub &hub) -> json {
                if (!hub.plannerStore().isLoaded()) return json{{"status", hub.plannerStore().status()}};
                return json{{"status", "ready"}, {"state", hub.plannerSync().stateJson()}};
            });
        }
        if (method == "parvanePlannerCachedState") return json(nullptr);
        if (method.rfind("parvaneCloud", 0) == 0) {
            const auto r = ask([method, args](Hub &hub) -> json {
                const auto out = hub.drive().handle(method, args);
                return out ? *out : json{{"__none", true}};
            }, 300000);
            if (r.is_object() && r.value("__none", false)) return std::nullopt;
            return r;
        }
        return std::nullopt;
    }
    std::optional<parvane::sections::exportdata::ZipWriter::ChunkSource> blob(const std::string &method, const json &args) override {
        std::optional<std::string> bytes;
        if (method == "parvaneExportMedia") {
            const auto fileId = args.value("fileId", std::string());
            if (!isSafeFileId(fileId)) return std::nullopt;
            bytes = readMediaCache(fileId);
            if (!bytes) {
                const auto d = downloadChatBlob(fileId);
                const auto it = keys_.find(fileId);
                if (d.ok && it != keys_.end()) bytes = parvane::blobcrypt::decrypt(d.bytes, it->second.first, it->second.second);
            }
        } else if (method == "parvaneCloudExportBlob") {
            const auto container = args.value("container", std::string());
            const auto node = args.value("node", std::string());
            const auto r = ask([container, node](Hub &hub) -> json {
                auto got = cloud::CloudFiles(hub.drive()).download(container, node);
                return got.ok ? json(domain::toBase64(got.bytes)) : json();
            }, 600000);
            if (r.is_string()) bytes = domain::fromBase64(r.get<std::string>());
        }
        if (!bytes) return std::nullopt;
        auto data = std::make_shared<std::string>(std::move(*bytes));
        auto offset = std::make_shared<std::size_t>(0);
        return [data, offset](std::string &chunk) {
            if (*offset >= data->size()) return false;
            const auto n = std::min<std::size_t>(1024 * 1024, data->size() - *offset);
            chunk.assign(data->data() + *offset, n);
            *offset += n;
            return true;
        };
    }
    int64_t nowMs() override { return pvjni::nowMs(); }
    void sleepMs(int64_t ms) override { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

private:
    json snapshot_;
    std::function<bool()> canceled_;
    std::map<std::string, std::pair<std::string, std::string>> keys_;
};

std::atomic<bool> g_exportCanceled{false};

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
    try {
        const auto m = jstr(env, method);
        const auto args = json::parse(jstr(env, argsJson), nullptr, false);
        const auto r = ask([m, args](Hub &hub) -> json {
            const auto result = hub.drive().handle(m, args.is_discarded() ? json() : args);
            if (m == "parvaneCloudUsage" && result) hub.setUsage(*result);
            return result ? *result : json();
        }, 300000);
        return jreply(env, r);
    } catch (const std::exception &e) {
        LOGE("nativeCloudCall: %s", e.what());
        return jreply(env, json());
    }
}

// Правки дерева облака. Блокирующий. → true — применено.
JNIEXPORT jboolean JNICALL Java_org_parvane_core_ParvaneSections_nativeCloudApply(JNIEnv *env, jclass, jstring container, jstring opsJson) {
    try {
        const auto c = jstr(env, container);
        const auto ops = json::parse(jstr(env, opsJson), nullptr, false);
        const auto r = ask([c, ops](Hub &hub) -> json {
            const auto result = hub.drive().applyOps(c, ops);
            return !result.is_object() || !result.contains("error");
        });
        return r.is_boolean() && r.get<bool>() ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &e) {
        LOGE("nativeCloudApply: %s", e.what());
        return JNI_FALSE;
    }
}

// Операция заметок по имени (create, save, rename, delete, move, folders, canvas, daily, guide…). Блокирующий.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneSections_nativeNotes(JNIEnv *env, jclass, jstring op, jstring argsJson) {
    try {
        const auto o = jstr(env, op);
        const auto args = json::parse(jstr(env, argsJson), nullptr, false);
        return jreply(env, ask([o, args](Hub &hub) { return notesOp(hub, o, args.is_object() ? args : json::object()); }));
    } catch (const std::exception &e) {
        LOGE("nativeNotes: %s", e.what());
        return jreply(env, json{{"ok", false}, {"error", "failed"}});
    }
}

// «План»/«Здоровье»: запрос (days, health, quickParse…) либо правка (save, remove, taskDone, food…) по имени над
// логикой ядра; правка идёт через PlannerStore::update (разница — на сервер, notice — «Отменить»). Блокирующий.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneSections_nativePlanner(JNIEnv *env, jclass, jstring op, jstring argsJson) {
    const auto o = jstr(env, op);
    auto args = json::parse(jstr(env, argsJson), nullptr, false);
    if (!args.is_object()) args = json::object();
    return jreply(env, ask([o, args](Hub &hub) -> json {
        const auto now = nowMs();
        auto ctx = plannerops::Context();
        ctx.today = localDate(now, "%Y-%m-%d");
        const auto hm = localDate(now, "%H:%M");
        ctx.nowMinutes = std::stoi(hm.substr(0, 2)) * 60 + std::stoi(hm.substr(3, 2));
        ctx.lang = g_russian ? "ru" : "en";
        // Задание в чат (TASK-1): «Принять» — запись в «План» правкой движка (дубль не создаётся), ответ — текстом ядра
        if (o == "offerAccept") {
            if (hub.self().empty()) return "unavailable";
            hub.plannerSync().ensure(true);
            const auto status = hub.plannerSync().status();
            if (status == "needs-linking" || status == "no-key") return status;
            const auto uuid = args.value("uuid", std::string());
            if (const auto state = hub.plannerSync().stateJson()) {
                const auto st = planner::fromEngineState(*state);
                if (planner::findOfferInPlan(&st, uuid)) return "exists";
            }
            const auto offer = planner::OfferFields::fromContent(args.value("content", json::object()));
            hub.plannerSync().apply(json::array({planner::offerPlanChange(uuid, args.value("chat", std::string()), offer, parvane::v2::newUuidV7())}));
            hub.bumpPlanner();
            return "ok";
        }
        if (o == "offerResponse") {
            const auto offer = planner::OfferFields::fromContent(args.value("content", json::object()));
            const auto accepted = args.value("accepted", false);
            return json{{"kind", "task_response"}, {"accepted", accepted},
                        {"text", planner::taskResponseText(offer.name, accepted, planner::offerKind(offer))}};
        }
        if (!plannerops::isEdit(o)) return plannerops::query(hub.plannerStore().state(), o, args, ctx);
        if (!hub.plannerStore().isLoaded()) return json{{"error", "loading"}};
        json result;
        const auto notice = args.value("notice", std::string());
        hub.plannerStore().update([&](planner::State &s) { result = plannerops::edit(s, o, args, ctx); },
                                  notice.empty() ? std::nullopt : std::optional(notice), now);
        hub.bumpPlanner();
        return result;
    }));
}

// Файлы «Облака» по имени операции (upload, download, thumb, createFolder, rename, trash, restore, purge, move,
// shareFolder, unshareFolder, links, linkCreate, linkRevoke, linkExtend). Блокирующий.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneSections_nativeCloudFiles(JNIEnv *env, jclass, jstring op, jstring argsJson) {
    try {
        const auto o = jstr(env, op);
        auto args = json::parse(jstr(env, argsJson), nullptr, false);
        if (!args.is_object()) args = json::object();
        return jreply(env, ask([o, args](Hub &hub) { return cloudFilesOp(hub, o, args); }, 30 * 60 * 1000));
    } catch (const std::exception &e) {
        LOGE("nativeCloudFiles: %s", e.what());
        return jreply(env, json{{"ok", false}, {"error", "failed"}});
    }
}

// Выгрузка данных в ZIP (`outPath`): meta — {chats:{адрес:{title,kind}}, selfName, contacts, labels, includeMedia,
// includeCloud, drive}. Блокирующий (Kotlin — с io-потока), ход — событие `export_progress`. → {ok, fileName, …} | {ok:false, error}.
JNIEXPORT jstring JNICALL Java_org_parvane_core_ParvaneSections_nativeExportData(JNIEnv *env, jclass, jstring metaJson, jstring outPath) {
    namespace ex = parvane::sections::exportdata;
    auto meta = json::parse(jstr(env, metaJson), nullptr, false);
    if (!meta.is_object()) meta = json::object();
    const auto path = jstr(env, outPath);
    g_exportCanceled = false;
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file) return jreply(env, json{{"ok", false}, {"error", "write"}});
    const auto canceled = [] { return g_exportCanceled.load(); };
    try {
        AndroidExportHost host(exportSnapshot(meta), canceled);
        auto args = ex::ExportRunArgs();
        args.source = ex::createProviderSource(host, ex::ProviderNames{meta.value("drive", std::string("Drive"))}, canceled);
        args.options.includeMedia = meta.value("includeMedia", true);
        args.options.includeCloud = meta.value("includeCloud", false);
        const auto labels = meta.value("labels", json::object());
        const auto l = [&](const char *k, std::string &v) { if (labels.contains(k) && labels[k].is_string()) v = labels[k].get<std::string>(); };
        l("title", args.labels.title); l("chats", args.labels.chats); l("planner", args.labels.planner); l("notes", args.labels.notes);
        l("contacts", args.labels.contacts); l("cloud", args.labels.cloud); l("savedMessages", args.labels.savedMessages);
        l("replyTo", args.labels.replyTo); l("forwardedFrom", args.labels.forwardedFrom); l("edited", args.labels.edited);
        l("mediaNotIncluded", args.labels.mediaNotIncluded); l("mediaUnavailable", args.labels.mediaUnavailable);
        l("poll", args.labels.poll); l("location", args.labels.location); l("messages", args.labels.messages);
        l("exportedAt", args.labels.exportedAt); l("privacyOn", args.labels.privacyOn); l("privacyOff", args.labels.privacyOff);
        args.canceled = canceled;
        args.nowUnixMs = nowMs();
        args.localTime = [](int64_t sec) {
            const std::time_t t = static_cast<std::time_t>(sec);
            std::tm tm{};
            localtime_r(&t, &tm);
            return ex::CivilTime{tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec};
        };
        args.sink = [&](const uint8_t *data, size_t size) {
            file.write(reinterpret_cast<const char *>(data), std::streamsize(size));
            if (!file) throw ex::ExportError(ex::ExportErrorCode::Failed, "write");
        };
        auto lastAt = std::int64_t(0);
        std::string lastStage;
        args.onProgress = [&](const ex::ExportProgress &p) {
            const auto now = nowMs();
            if (p.stage == lastStage && now - lastAt < 250) return;
            lastStage = p.stage;
            lastAt = now;
            emit(json{{"type", "export_progress"}, {"stage", p.stage}, {"done", p.done}, {"total", p.total}});
        };
        const auto r = ex::runDataExport(args);
        file.close();
        return jreply(env, json{{"ok", true}, {"fileName", r.fileName}, {"bytes", std::int64_t(r.bytes)}, {"chats", r.chats},
                                {"messages", r.messages}, {"media", r.media}, {"mediaFailed", r.mediaFailed}, {"notes", r.notes},
                                {"cloudFiles", r.cloudFiles}});
    } catch (const ex::ExportError &e) {
        return jreply(env, json{{"ok", false}, {"error", g_exportCanceled ? "canceled" : (e.code() == ex::ExportErrorCode::TooLarge ? "too-large" : "failed")}});
    } catch (const std::exception &e) {
        LOGE("выгрузка данных: %s", e.what());
        return jreply(env, json{{"ok", false}, {"error", "failed"}});
    }
}

JNIEXPORT void JNICALL Java_org_parvane_core_ParvaneSections_nativeExportCancel(JNIEnv *, jclass) { g_exportCanceled = true; }

} // extern "C"
