// Parvane fork (spec 029, T029): «План» на сервере — порт web `planner.ts` и `plannerCoalesce.ts`.
#include "parvane/sections/planner_sync.h"

#include <map>

namespace parvane::sections::planner {

namespace d = parvane::sections::domain;

// ── склейка правок (plannerCoalesce.ts) ───────────────────────────────────────

namespace {

// Истинность значения JS (поле отсутствует — null здесь)
bool truthy(const json *v) {
    if (!v || v->is_null()) return false;
    if (v->is_boolean()) return v->get<bool>();
    if (v->is_number_integer() || v->is_number_unsigned()) return v->get<double>() != 0;
    if (v->is_number_float()) {
        const double x = v->get<double>();
        return x == x && x != 0;
    }
    if (v->is_string()) return !v->get<std::string>().empty();
    return true; // объект и массив истинны
}

const json *field(const json &obj, const std::string &key) {
    if (!obj.is_object()) return nullptr;
    const auto it = obj.find(key);
    return it == obj.end() ? nullptr : &*it;
}

// String(value) JS для ключа объекта правки
std::string jsString(const json *v) {
    if (!v) return "undefined";
    if (v->is_null()) return "null";
    if (v->is_string()) return v->get<std::string>();
    if (v->is_boolean()) return v->get<bool>() ? "true" : "false";
    if (v->is_number_integer() || v->is_number_unsigned()) return v->dump();
    if (v->is_number_float()) {
        const double x = v->get<double>();
        if (x == static_cast<double>(static_cast<long long>(x))) return std::to_string(static_cast<long long>(x));
        return v->dump();
    }
    if (v->is_object()) return "[object Object]";
    std::string out;
    for (size_t i = 0; i < v->size(); ++i) {
        if (i) out += ',';
        const auto &e = (*v)[i];
        if (!e.is_null()) out += jsString(&e);
    }
    return out;
}

struct KeyedList {
    const char *field;
    const char *key;
};

const KeyedList *keyedListOf(const std::string &kind) {
    static const std::map<std::string, KeyedList> lists = {
        {"task", {"occurrences", "day"}},
        {"event", {"occurrences", "day"}},
        {"nutritionDay", {"entries", "id"}},
    };
    const auto it = lists.find(kind);
    return it == lists.end() ? nullptr : &it->second;
}

// Объект правки: у дня питания ключ — день, у настроек и целей объект один, у остальных — id
std::string targetOf(const std::string &kind, const json &body) {
    if (kind == "nutritionDay") return kind + ":" + jsString(field(body, "day"));
    if (kind == "settings" || kind == "goals" || kind == "migration") return kind;
    return kind + ":" + jsString(field(body, "id"));
}

// Списки по ключу: как Map JS — повторный ключ заменяет значение на прежнем месте
json mergeKeyed(const json *before, const json *after, const std::string &key) {
    std::vector<std::string> order;
    std::map<std::string, json> items;
    for (const json *list : {before, after}) {
        if (!list || !list->is_array()) continue;
        for (const auto &item : *list) {
            const json *k = field(item, key);
            // Ключ с типом: 1 и "1" — разные ключи Map
            const std::string id = k ? std::string(k->type_name()) + ":" + k->dump() : "undefined";
            if (!items.count(id)) order.push_back(id);
            items[id] = item;
        }
    }
    json out = json::array();
    for (const auto &id : order) out.push_back(items[id]);
    return out;
}

} // namespace

json coalesceChanges(const json &changes) {
    json result = json::array();
    if (!changes.is_array()) return result;
    std::map<std::string, size_t> indexByTarget;
    for (const auto &change : changes) {
        // Вид правки — первый (единственный) ключ объекта
        if (!change.is_object() || change.empty()) {
            result.push_back(change);
            continue;
        }
        const std::string kind = change.begin().key();
        const json &body = change.begin().value();
        if (!truthy(&body) || !body.is_object() || kind == "migration") {
            result.push_back(change);
            continue;
        }
        const auto target = targetOf(kind, body);
        const auto found = indexByTarget.find(target);
        if (found == indexByTarget.end()) {
            indexByTarget[target] = result.size();
            result.push_back(change);
            continue;
        }
        const json before = result[found->second][kind];
        const json &after = body;
        // Удаление заменяет всё прежнее; правка после удаления — новая запись целиком
        if (truthy(field(after, "deleted")) || truthy(field(before, "deleted"))) {
            result[found->second] = change;
            continue;
        }
        json merged = before;
        for (auto it = after.begin(); it != after.end(); ++it) merged[it.key()] = it.value();
        if (const auto *list = keyedListOf(kind)) {
            const json *b = field(before, list->field);
            const json *a = field(after, list->field);
            if (truthy(b) || truthy(a)) merged[list->field] = mergeKeyed(b, a, list->key);
        }
        result[found->second] = json{{kind, merged}};
    }
    return result;
}

// ── жизненный цикл (planner.ts) ──────────────────────────────────────────────

namespace {

bool isUnavailable(const std::exception &e) {
    const auto code = d::errorCode(e);
    // Ошибка движка (кода нет) — тоже «недоступно», как в web
    return !code || *code == "ERROR_CODE_UNAVAILABLE" || *code == "ERROR_CODE_RATE_LIMITED";
}

} // namespace

PlannerSync::PlannerSync(d::DomainTransport &transport, d::RecordStore &records, PlannerHooks hooks)
: t_(transport), records_(records), hooks_(std::move(hooks)) {}

json PlannerSync::engine(const std::string &name, const json &args) {
    return t_.engine(name, args);
}

bool PlannerSync::hasClient() {
    return t_.hasClient();
}

bool PlannerSync::isAttached() {
    return hasClient() && engine("plannerIsAttached").get<bool>();
}

bool PlannerSync::hasKey() {
    return hasClient() && engine("plannerHasKey").get<bool>();
}

std::int64_t PlannerSync::headSeq() {
    if (!hasClient()) return 0;
    const auto v = engine("plannerHeadSeq");
    return v.is_number() ? v.get<std::int64_t>() : 0;
}

std::string PlannerSync::call(bool anon, const std::string &method, const std::string &body, const std::string &dest) {
    return t_.request(anon, method, body, dest);
}

std::string PlannerSync::callRequest(const json &req) {
    return d::runRequest(t_, d::OutRequest::fromJson(req));
}

std::string PlannerSync::encode(const std::string &method, const json &value) {
    return t_.encodeMethod(method, value);
}

json PlannerSync::refJson(const ContainerRef &ref) const {
    return json{{"domain", ref.domain}, {"id", d::hexToB64(ref.id)}};
}

void PlannerSync::setStatus(const std::string &next) {
    if (status_ == next) return;
    status_ = next;
    if (hooks_.onChanged) hooks_.onChanged();
}

std::optional<ContainerRef> PlannerSync::currentRef() {
    if (hasClient()) {
        const auto r = engine("plannerContainer");
        if (r.is_object()) return ContainerRef{r.value("domain", std::string()), r.value("id", std::string())};
    }
    return container_;
}

void PlannerSync::loadOutbox() {
    if (isOutboxLoaded_) return;
    isOutboxLoaded_ = true;
    outbox_.clear();
    try {
        if (const auto saved = records_.load(kOutboxRecord); saved && saved->is_array()) {
            for (const auto &item : *saved) {
                outbox_.push_back({item.value("opId", std::string()), item.value("op", std::string())});
            }
        }
    } catch (const std::exception &) {
    }
    // Операции очереди уже применены локально до перезапуска — движок их не помнит (состояние без них
    // в персисте): применить заново (идемпотентно)
    if (isAttached()) {
        for (const auto &item : outbox_) {
            try {
                engine("plannerApplyLocal", json{{"op", item.op}});
            } catch (const std::exception &e) {
                t_.log(std::string("планировщик: операция из очереди не применена: ") + e.what());
            }
        }
    }
}

void PlannerSync::saveOutbox() {
    if (!outbox_.empty()) {
        json list = json::array();
        for (const auto &item : outbox_) list.push_back(json{{"opId", item.opId}, {"op", item.op}});
        records_.save(kOutboxRecord, list);
    } else {
        try {
            records_.remove(kOutboxRecord);
        } catch (const std::exception &) {
        }
    }
}

void PlannerSync::savePending() {
    try {
        if (!pendingChanges_.empty()) records_.save(kPendingRecord, json(pendingChanges_));
        else records_.remove(kPendingRecord);
    } catch (const std::exception &) {
    }
}

void PlannerSync::loadPending() {
    if (isPendingLoaded_) return;
    isPendingLoaded_ = true;
    std::vector<json> saved;
    try {
        if (const auto v = records_.load(kPendingRecord); v && v->is_array()) saved = v->get<std::vector<json>>();
    } catch (const std::exception &) {
    }
    if (saved.empty()) return;
    pendingChanges_.insert(pendingChanges_.begin(), saved.begin(), saved.end());
    t_.log("планировщик: правок из прошлой сессии " + std::to_string(saved.size()));
}

// ── контейнер ─────────────────────────────────────────────────────────────────

std::optional<ContainerRef> PlannerSync::findContainer() {
    if (hooks_.stateContainer) {
        if (auto fromState = hooks_.stateContainer()) return fromState;
    }
    const auto resp = call(false, "domain.container.list",
                           encode("domain.container.list", json{{"domain", kPlannerDomain}}));
    const auto list = t_.decodeMethod("domain.container.list", resp);
    if (!list.is_object() || !list.contains("containers") || !list["containers"].is_array()
        || list["containers"].empty()) {
        return std::nullopt;
    }
    const auto &first = list["containers"][0];
    if (!first.contains("ref") || !first["ref"].is_object()) return std::nullopt;
    const auto domainName = first["ref"].value("domain", std::string());
    const auto id = first["ref"].value("id", std::string());
    if (domainName.empty() || id.empty()) return std::nullopt;
    return ContainerRef{domainName, d::b64ToHex(id)};
}

void PlannerSync::attach(const ContainerRef &ref) {
    if (!hasClient()) return;
    const auto got = call(false, "domain.container.get", encode("domain.container.get", json{{"container", refJson(ref)}}));
    const auto grants = call(false, "domain.grant.list",
                             encode("domain.grant.list", json{{"container", refJson(ref)}, {"after_version", "0"}}));
    engine("plannerAttach", json{{"getResponse", d::toBase64(got)}, {"grantsResponse", d::toBase64(grants)}});
    container_ = ref;
    isSnapshotTried_ = false;
    if (hooks_.recordContainer) hooks_.recordContainer(ref);
    t_.persist();
    t_.log("планировщик: контейнер подключён (" + ref.id.substr(0, 8) + "…)");
}

void PlannerSync::create() {
    if (!hasClient()) throw d::BusError("ERROR_CODE_UNAVAILABLE");
    callRequest(engine("plannerCreate", json{{"tsMs", t_.nowMs()}}));
    const auto r = engine("plannerContainer");
    container_ = ContainerRef{r.value("domain", std::string()), r.value("id", std::string())};
    if (hooks_.recordContainer) hooks_.recordContainer(*container_);
    t_.persist();
    t_.log("планировщик: контейнер создан (" + container_->id.substr(0, 8) + "…)");
    shareKeys();
}

void PlannerSync::shareKeys() {
    if (!hasClient()) return;
    try {
        const auto reqs = t_.engineWithNeeds("sharePlannerWithOwnDevices", json::object());
        d::runRequests(t_, reqs);
        if (reqs.is_array() && !reqs.empty()) t_.log("планировщик: ключ контейнера передан своим устройствам");
    } catch (const std::exception &e) {
        t_.log(std::string("планировщик: ключ своим устройствам не передан: ") + e.what());
    }
}

bool PlannerSync::ensureAttached(bool createIfMissing) {
    const bool client = hasClient();
    if (!client || !t_.isReady()) {
        t_.log(std::string("планировщик: стек не готов (движок ") + (client ? "есть" : "нет") + ", линковка "
               + (t_.needsLinking() ? "нужна" : "не нужна") + ")");
        setStatus(t_.needsLinking() ? "needs-linking" : "loading");
        return false;
    }
    if (isAttached()) return true;
    if (const auto ref = findContainer()) {
        attach(*ref);
        return true;
    }
    if (!createIfMissing) {
        t_.log("планировщик: контейнера у аккаунта нет — создастся первой правкой");
        return false;
    }
    create();
    return true;
}

// ── журнал и снимок ───────────────────────────────────────────────────────────

void PlannerSync::pullGrants(const ContainerRef &ref) {
    const auto resp = call(false, "domain.grant.list",
                           encode("domain.grant.list", json{{"container", refJson(ref)}, {"after_version", "0"}}));
    engine("plannerIngestGrants", json{{"grantsResponse", d::toBase64(resp)}});
}

bool PlannerSync::pull() {
    const auto ref = currentRef();
    if (!hasClient() || !ref || !isAttached()) return false;
    bool changed = false;
    if (!isSnapshotTried_ && headSeq() == 0 && hasKey()) {
        isSnapshotTried_ = true;
        const auto resp = call(false, "domain.snapshot.get", encode("domain.snapshot.get", json{{"container", refJson(*ref)}}));
        const auto before = headSeq();
        try {
            const auto after = engine("plannerIngestSnapshot", json{{"snapshotResponse", d::toBase64(resp)}});
            if (!after.is_number() || after.get<std::int64_t>() != before) {
                changed = true;
                // Состояние из снимка — на экран сразу, догон журнала после него — следом (R5, T028)
                t_.log("планировщик: снимок применён (seq " + std::to_string(headSeq()) + ")");
                if (hooks_.onChanged) hooks_.onChanged();
            }
        } catch (const std::exception &e) {
            t_.log(std::string("планировщик: снимок не прочитан: ") + e.what());
        }
    }
    bool missingKey = false;
    for (int page = 0; page < kSyncPages; ++page) {
        const auto resp = call(false, "domain.op.sync",
                               encode("domain.op.sync", json{{"container", refJson(*ref)},
                                                             {"after_seq", std::to_string(headSeq())},
                                                             {"max_bytes", 0}}));
        const auto r = engine("plannerIngestSync", json{{"syncResponse", d::toBase64(resp)}});
        if (r.value("applied", 0) != 0) changed = true;
        if (r.contains("missingEpoch") && !r["missingEpoch"].is_null()) missingKey = true;
        if (r.value("grantsBehind", false)) {
            pullGrants(*ref);
            continue;
        }
        if (!r.value("more", false)) break;
    }
    setStatus(missingKey || !hasKey() ? "no-key" : "ready");
    if (changed) t_.log("планировщик: журнал применён (seq " + std::to_string(headSeq()) + ")");
    return changed;
}

bool PlannerSync::maybeSnapshot() {
    if (!hasKey()) return false;
    try {
        const auto req = engine("plannerSnapshotRequest", json{{"tsMs", t_.nowMs()}});
        if (req.is_null()) return false;
        callRequest(req);
        t_.log("планировщик: снимок записан (seq " + std::to_string(headSeq()) + ")");
        return true;
    } catch (const std::exception &e) {
        t_.log(std::string("планировщик: снимок не записан: ") + e.what());
        return false;
    }
}

// ── своя очередь ──────────────────────────────────────────────────────────────

int PlannerSync::prepareLocal() {
    const bool client = hasClient();
    if (!client && !pendingChanges_.empty()) t_.log("планировщик: движка нет — правки ждут");
    if (!client || pendingChanges_.empty()) return 0;
    if (!isAttached()) {
        // Первая правка без контейнера: создать (непривязанное устройство сюда не попадает)
        if (!ensureAttached(true)) return 0;
    }
    loadOutbox();
    // Одна операция — одна метка: правки одного объекта склеиваются
    const auto changes = coalesceChanges(json(pendingChanges_));
    pendingChanges_.clear();
    savePending();
    int prepared = 0;
    for (size_t i = 0; i < changes.size(); i += kMaxChangesPerOp) {
        json chunk = json::array();
        for (size_t k = i; k < changes.size() && k < i + kMaxChangesPerOp; ++k) chunk.push_back(changes[k]);
        const auto prepareChunk = [&](const json &part) {
            try {
                const auto local = engine("plannerPrepareLocal", json{{"changesJson", json{{"changes", part}}}});
                outbox_.push_back({local.value("opId", std::string()), local.value("op", std::string())});
                prepared += 1;
                return true;
            } catch (const std::exception &e) {
                t_.log(std::string("планировщик: правка отвергнута движком: ") + e.what());
                return false;
            }
        };
        // Одна негодная правка (например, поле задания из чата вне схемы) не уносит остальные: пакет, который
        // движок отверг, повторяется по одной правке (A0082-1)
        if (!prepareChunk(chunk) && chunk.size() > 1) {
            for (const auto &single : chunk) prepareChunk(json::array({single}));
        }
    }
    saveOutbox();
    t_.persist();
    return prepared;
}

void PlannerSync::sendOutbox() {
    if (!isAttached()) return;
    loadOutbox();
    int expiredRetries = 0;  // подряд на одной операции: постоянный EXPIRED не должен крутить цикл бесконечно
    std::string expiredFor;
    while (!outbox_.empty()) {
        const auto item = outbox_.front();
        if (item.opId != expiredFor) {
            expiredFor = item.opId;
            expiredRetries = 0;
        }
        if (!hasKey()) {
            setStatus("no-key");
            return;
        }
        try {
            callRequest(engine("plannerSeal", json{{"op", item.op}, {"opIdHex", item.opId}, {"tsMs", t_.nowMs()}}));
        } catch (const std::exception &e) {
            const auto code = d::errorCode(e);
            if (code && *code == "ERROR_CODE_DUPLICATE") {
                // Уже принято до обрыва — считаем отправленным
            } else if (code && *code == "ERROR_CODE_EXPIRED") {
                // Эпоха сменилась другим устройством: догнать гранты, ключ придёт по E2E
                if (const auto ref = currentRef()) pullGrants(*ref);
                if (!hasKey()) {
                    setStatus("no-key");
                    return;
                }
                if (++expiredRetries > 3) {
                    // Ключ есть, а эпоха всё равно устарела: ждём новых грантов позже, а не крутимся (A0068-1)
                    setStatus("no-key");
                    scheduleRetry();
                    return;
                }
                continue;
            } else {
                lastError_ = d::errorText(e);
                setStatus(isUnavailable(e) ? "offline" : status_);
                scheduleRetry();
                return;
            }
        }
        outbox_.erase(outbox_.begin());
        saveOutbox();
    }
}

void PlannerSync::scheduleRetry() {
    if (retryTimer_.armed()) return;
    retryTimer_.set(t_.nowMs() + kRetryOfflineMs);
}

void PlannerSync::scheduleFlush() {
    const auto now = t_.nowMs();
    flushTimer_.set(now + kFlushIdleMs);
    if (!flushDeadline_.armed()) flushDeadline_.set(now + kFlushMaxMs);
}

void PlannerSync::clearFlushTimers() {
    flushTimer_.clear();
    flushDeadline_.clear();
    flushSoon_.clear();
}

void PlannerSync::flushNow() {
    clearFlushTimers();
    bool changed = false;
    try {
        changed = prepareLocal() > 0;
        sendOutbox();
        if (maybeSnapshot()) t_.persist();
    } catch (const std::exception &e) {
        const auto text = d::errorText(e);
        if (lastError_ != text) changed = true;
        lastError_ = text;
        t_.log("планировщик: отправка не удалась: " + text);
        if (isUnavailable(e)) {
            setStatus("offline");
            scheduleRetry();
        }
    }
    // Состояние движка менялось только подготовленными правками (и ошибка нужна экрану)
    if (changed && hooks_.onChanged) hooks_.onChanged();
}

void PlannerSync::syncNow() {
    syncSoon_.clear();
    bool changed = false;
    try {
        // Накопленные правки уходят и отсюда: периодический синк не должен ни отменять пакет, ни оставлять
        // его без контейнера
        const bool hasPendingChanges = !pendingChanges_.empty();
        if (hasPendingChanges) clearFlushTimers();
        if (!ensureAttached(hasPendingChanges)) {
            // Контейнера нет (создастся первой правкой): экрану это сообщается один раз
            if (!isNoContainerAnnounced_) {
                isNoContainerAnnounced_ = true;
                if (hooks_.onChanged) hooks_.onChanged();
            }
            scheduleSync();
            return;
        }
        if (prepareLocal() > 0) changed = true;
        sendOutbox();
        if (pull()) changed = true;
        const bool isSnapshotWritten = maybeSnapshot();
        // Персист — только когда движок что-то менял
        if (changed || isSnapshotWritten) t_.persist();
    } catch (const std::exception &e) {
        // Новая ошибка нужна экрану; та же самая при каждом опросе — нет
        const auto text = d::errorText(e);
        if (lastError_ != text) changed = true;
        lastError_ = text;
        t_.log("планировщик: синхронизация: " + text);
        if (isUnavailable(e)) {
            setStatus("offline");
            scheduleRetry();
        }
    }
    scheduleSync();
    if (changed && hooks_.onChanged) hooks_.onChanged();
}

void PlannerSync::scheduleSync() {
    syncTimer_.clear();
    if (!isWanted_) return;
    syncTimer_.set(t_.nowMs() + d::pollDelay(kSyncIntervalMs, kSyncIdleMs, isActive_ && isVisible_));
}

// ── API ───────────────────────────────────────────────────────────────────────

void PlannerSync::ensure(bool isBackground) {
    if (isBackground) {
        if (isWanted_) return;
        isActive_ = false;
        isBackgroundOnly_ = true;
    } else if (isBackgroundOnly_) {
        isBackgroundOnly_ = false;
        isActive_ = true;
    }
    isWanted_ = true;
    scheduleSync();
    // Движок до готовности сессии не спрашиваем: его вызов ждёт конца подключения (замок движка) либо бросает
    const bool client = hasClient() && t_.isReady();
    t_.log(std::string("планировщик: запуск (контейнер ") + (client && isAttached() ? "есть" : "нет") + ", ключ "
           + (client && hasKey() ? "есть" : "нет") + ", seq " + std::to_string(client ? headSeq() : 0) + ")");
    loadPending();
    syncNow();
}

void PlannerSync::setActive(bool active) {
    isBackgroundOnly_ = false;
    if (isActive_ == active) return;
    isActive_ = active;
    if (!isWanted_) return;
    if (active && isVisible_) syncSoon_.set(t_.nowMs());
    else scheduleSync();
}

void PlannerSync::setVisible(bool visible) {
    isVisible_ = visible;
    if (!isWanted_) return;
    // Окно снова видно: догнать сразу, дальше — по обычному расписанию
    if (visible && isActive_) syncSoon_.set(t_.nowMs());
    else scheduleSync();
}

void PlannerSync::pageHide() {
    if (!pendingChanges_.empty()) flushNow();
}

void PlannerSync::apply(const json &changes) {
    if (!changes.is_array() || changes.empty()) return;
    for (const auto &c : changes) pendingChanges_.push_back(c);
    savePending();
    // Без контейнера не ждём тишины: первая правка создаёт его сразу
    if (pendingChanges_.size() >= kMaxChangesPerOp || !isAttached()) {
        flushSoon_.set(t_.nowMs());
        return;
    }
    scheduleFlush();
}

void PlannerSync::flush() {
    flushNow();
}

void PlannerSync::tick() {
    const auto now = t_.nowMs();
    const bool flushDue = flushSoon_.fire(now) | flushTimer_.fire(now) | flushDeadline_.fire(now);
    if (flushDue) flushNow();
    const bool syncDue = syncSoon_.fire(now) | syncTimer_.fire(now) | retryTimer_.fire(now);
    if (syncDue) syncNow();
}

std::optional<std::int64_t> PlannerSync::nextWakeMs() const {
    return d::earliest({&flushSoon_, &flushTimer_, &flushDeadline_, &syncSoon_, &syncTimer_, &retryTimer_});
}

std::optional<json> PlannerSync::stateJson() {
    if (!hasClient()) return std::nullopt;
    auto v = engine("plannerStateJson");
    if (v.is_null()) return std::nullopt;
    return v;
}

std::string PlannerSync::status() {
    if (!hasClient() || !t_.isReady()) return t_.needsLinking() ? "needs-linking" : "loading";
    if (!isAttached()) return status_ == "offline" ? "offline" : "ready";
    if (!hasKey()) return "no-key";
    return status_ == "loading" || status_ == "needs-linking" ? "ready" : status_;
}

std::int64_t PlannerSync::sizeBytes() {
    if (!hasClient()) return 0;
    const auto v = engine("plannerSize");
    return v.is_number() ? v.get<std::int64_t>() : 0;
}

std::optional<json> PlannerSync::keysExport() {
    if (!hasClient()) return std::nullopt;
    auto v = engine("plannerKeysExport");
    if (v.is_null()) return std::nullopt;
    return v;
}

void PlannerSync::keysImport(const json &value) {
    if (!hasClient()) return;
    try {
        engine("plannerKeysImport", json{{"json", value}});
    } catch (const std::exception &e) {
        t_.log(std::string("планировщик: ключи из экспорта линковки не приняты: ") + e.what());
    }
}

void PlannerSync::onEngineEvent() {
    if (!isWanted_) return;
    syncSoon_.set(t_.nowMs());
}

void PlannerSync::reset() {
    clearFlushTimers();
    syncTimer_.clear();
    retryTimer_.clear();
    syncSoon_.clear();
    status_ = "loading";
    container_.reset();
    outbox_.clear();
    isOutboxLoaded_ = false;
    isPendingLoaded_ = false;
    pendingChanges_.clear();
    isWanted_ = false;
    isActive_ = true;
    isBackgroundOnly_ = false;
    isSnapshotTried_ = false;
    isNoContainerAnnounced_ = false;
    lastError_.reset();
}

} // namespace parvane::sections::planner
