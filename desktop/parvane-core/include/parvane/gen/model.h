// Сгенерировано gen_bindings (cargo run -p parvane-protocol --bin gen_bindings) из proto/parvane/engine/v1/** — не править руками; проверка — gen_bindings --check (тест bindings_are_fresh).
// Граница движка — proto3-JSON: имена полей схемы, int64 — строка, bytes — base64 (здесь — сырые байты в std::string), enum — имя.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::gen {

std::string toBase64(const std::string &bytes);
std::string fromBase64(const std::string &text);

enum class DeleteScope : int32_t {
    DELETE_SCOPE_UNSPECIFIED = 0,
    DELETE_SCOPE_ME = 1,
    DELETE_SCOPE_EVERYONE = 2,
};
void to_json(nlohmann::json &j, const DeleteScope &v);
void from_json(const nlohmann::json &j, DeleteScope &v);

enum class Delivery : int32_t {
    DELIVERY_UNSPECIFIED = 0,
    DELIVERY_PENDING = 1,
    DELIVERY_SENT = 2,
    DELIVERY_READ = 3,
    DELIVERY_FAILED = 4,
};
void to_json(nlohmann::json &j, const Delivery &v);
void from_json(const nlohmann::json &j, Delivery &v);

enum class Disposition : int32_t {
    DISPOSITION_UNSPECIFIED = 0,
    DISPOSITION_SHOW = 1,
    DISPOSITION_STUB = 2,
    DISPOSITION_STUB_CRITICAL = 3,
};
void to_json(nlohmann::json &j, const Disposition &v);
void from_json(const nlohmann::json &j, Disposition &v);

enum class GroupRole : int32_t {
    GROUP_ROLE_UNSPECIFIED = 0,
    GROUP_ROLE_MEMBER = 1,
    GROUP_ROLE_ADMIN = 2,
    GROUP_ROLE_OWNER = 3,
    GROUP_ROLE_LEFT = 4,
    GROUP_ROLE_BANNED = 5,
};
void to_json(nlohmann::json &j, const GroupRole &v);
void from_json(const nlohmann::json &j, GroupRole &v);

enum class JournalWrite : int32_t {
    JOURNAL_WRITE_UNSPECIFIED = 0,
    JOURNAL_WRITE_OPEN = 1,
    JOURNAL_WRITE_BLOCKED_CRITICAL_UNKNOWN = 2,
    JOURNAL_WRITE_BLOCKED_TOO_NEW = 3,
};
void to_json(nlohmann::json &j, const JournalWrite &v);
void from_json(const nlohmann::json &j, JournalWrite &v);

enum class ObjectKind : int32_t {
    OBJECT_KIND_UNSPECIFIED = 0,
    OBJECT_KIND_FOLDER = 1,
    OBJECT_KIND_BLOCK = 2,
    OBJECT_KIND_PEER_NOTIFY = 3,
    OBJECT_KIND_NOTIFY_DEFAULTS = 4,
    OBJECT_KIND_DRAFT = 5,
    OBJECT_KIND_SCHEDULED = 6,
    OBJECT_KIND_ARCHIVE = 7,
    OBJECT_KIND_PIN_LIST = 8,
    OBJECT_KIND_CALL = 9,
    OBJECT_KIND_GROUP_INVITE = 10,
    OBJECT_KIND_PLANNER_CONTAINER = 11,
    OBJECT_KIND_CLOUD_CONTAINER = 12,
    OBJECT_KIND_UNREAD_MARK = 13,
    OBJECT_KIND_QUICK_REACTION = 14,
    OBJECT_KIND_STICKER_PACK = 15,
    OBJECT_KIND_CONTACT = 16,
    OBJECT_KIND_FOLDER_ORDER = 17,
    OBJECT_KIND_CHAT_CLEARED = 18,
    OBJECT_KIND_SAVED_GIF = 19,
    OBJECT_KIND_FAVED_STICKER = 20,
    OBJECT_KIND_HEALTH_CONTAINER = 21,
    OBJECT_KIND_MUSIC_CONTAINER = 22,
};
void to_json(nlohmann::json &j, const ObjectKind &v);
void from_json(const nlohmann::json &j, ObjectKind &v);

enum class OpenState : int32_t {
    OPEN_STATE_UNSPECIFIED = 0,
    OPEN_STATE_READY = 1,
    OPEN_STATE_TOO_NEW = 3,
    OPEN_STATE_LOCKED = 4,
};
void to_json(nlohmann::json &j, const OpenState &v);
void from_json(const nlohmann::json &j, OpenState &v);

enum class PageDirection : int32_t {
    PAGE_DIRECTION_UNSPECIFIED = 0,
    PAGE_DIRECTION_OLDER = 1,
    PAGE_DIRECTION_NEWER = 2,
    PAGE_DIRECTION_AROUND = 3,
};
void to_json(nlohmann::json &j, const PageDirection &v);
void from_json(const nlohmann::json &j, PageDirection &v);

enum class RequestChannel : int32_t {
    REQUEST_CHANNEL_UNSPECIFIED = 0,
    REQUEST_CHANNEL_ID = 1,
    REQUEST_CHANNEL_ANON = 2,
};
void to_json(nlohmann::json &j, const RequestChannel &v);
void from_json(const nlohmann::json &j, RequestChannel &v);

enum class ServerInputKind : int32_t {
    SERVER_INPUT_KIND_UNSPECIFIED = 0,
    SERVER_INPUT_KIND_RESPONSE = 1,
    SERVER_INPUT_KIND_EVENT = 2,
    SERVER_INPUT_KIND_INBOX_RECORD = 3,
    SERVER_INPUT_KIND_STREAM_CHUNK = 4,
};
void to_json(nlohmann::json &j, const ServerInputKind &v);
void from_json(const nlohmann::json &j, ServerInputKind &v);

struct CallResult;
struct Capabilities;
struct CapabilitiesRequest;
struct ChatAnchor;
struct ChatListRequest;
struct ChatPage;
struct ChatView;
struct ClientCall;
struct ClientEvents;
struct ClientReplace;
struct ComposeContent;
struct CriticalRange;
struct DeviceWrap;
struct EngineConfig;
struct EngineError;
struct EngineInfo;
struct FieldValue;
struct GroupPerms;
struct GroupView;
struct HistoryPage;
struct HistoryPageRequest;
struct Intent;
struct IntentDelete;
struct IntentDomainOp;
struct IntentEdit;
struct IntentFaveSticker;
struct IntentGroupChange;
struct IntentGroupCreate;
struct IntentGroupJoinByLink;
struct IntentPin;
struct IntentReact;
struct IntentRead;
struct IntentRevoke;
struct IntentRotateSsk;
struct IntentSend;
struct IntentStateCreate;
struct IntentStateDelete;
struct IntentStatePatch;
struct IntentStateSetAdd;
struct IntentStateSetRemove;
struct IntentTyping;
struct JournalState;
struct KindFormat;
struct MarkValue;
struct MessageRemove;
struct MessageView;
struct MigrationProgress;
struct ModelChange;
struct ModelDelta;
struct MsgAnchor;
struct Need;
struct Notice;
struct ObjectKey;
struct OpenResult;
struct OutRequest;
struct Outcome;
struct Peer;
struct PinWrap;
struct RangeHold;
struct RangeHolds;
struct Ref;
struct Root;
struct RowsAllRequest;
struct RowsApply;
struct RowsReadRequest;
struct ServerInput;
struct StateChanged;
struct StateObjectView;
struct StateView;
struct StorageFormat;
struct StoreBatch;
struct StoreCommitted;
struct StoreLoaded;
struct StorePut;
struct StoreReads;
struct Stored;
struct Tick;
struct UnlockPin;
struct UnreadChanged;
struct UserRef;
struct ViewArticle;
struct ViewBody;
struct ViewCall;
struct ViewCloudInvite;
struct ViewContact;
struct ViewEntity;
struct ViewGroupRequest;
struct ViewLocation;
struct ViewMedia;
struct ViewPoll;
struct ViewReaction;
struct ViewService;
struct ViewStateRequest;
struct ViewSticker;
struct ViewTaskOffer;
struct ViewText;
struct Wrap;
struct WriteBlocked;

struct CallResult {
    std::string result_json;
};
void to_json(nlohmann::json &j, const CallResult &m);
void from_json(const nlohmann::json &j, CallResult &m);

struct Capabilities {
    bool send_text = false;
    bool send_media = false;
    bool send_stickers = false;
    bool send_polls = false;
    bool send_links = false;
    bool delete_everyone = false;
    bool pin = false;
    bool edit = false;
    bool react = false;
    bool forward = false;
    bool reply = false;
};
void to_json(nlohmann::json &j, const Capabilities &m);
void from_json(const nlohmann::json &j, Capabilities &m);

struct ChatAnchor {
    int64_t ts_ms = 0;
    std::string chat_key;
};
void to_json(nlohmann::json &j, const ChatAnchor &m);
void from_json(const nlohmann::json &j, ChatAnchor &m);

struct ChatListRequest {
    std::optional<ChatAnchor> after;
    uint32_t limit = 0;
    uint32_t folder = 0;
};
void to_json(nlohmann::json &j, const ChatListRequest &m);
void from_json(const nlohmann::json &j, ChatListRequest &m);

struct ClientCall {
    std::string name;
    std::string args_json;
};
void to_json(nlohmann::json &j, const ClientCall &m);
void from_json(const nlohmann::json &j, ClientCall &m);

struct ClientEvents {
    std::string json;
};
void to_json(nlohmann::json &j, const ClientEvents &m);
void from_json(const nlohmann::json &j, ClientEvents &m);

struct ClientReplace {
    std::string mode;
    std::string blob;
    std::string key;
};
void to_json(nlohmann::json &j, const ClientReplace &m);
void from_json(const nlohmann::json &j, ClientReplace &m);

struct CriticalRange {
    std::string name;
    uint32_t from = 0;
    uint32_t to = 0;
};
void to_json(nlohmann::json &j, const CriticalRange &m);
void from_json(const nlohmann::json &j, CriticalRange &m);

struct DeviceWrap {
    std::string wrapped_dek;
};
void to_json(nlohmann::json &j, const DeviceWrap &m);
void from_json(const nlohmann::json &j, DeviceWrap &m);

struct EngineConfig {
    std::string user;
    std::string device_id;
    std::string domain;
    std::vector<std::string> features;
    int64_t now_ms = 0;
    uint64_t memory_budget_bytes = 0;
    std::string device_key;
    bool vectors = false;
    bool host_driven = false;
    bool engine_rows = false;
    uint32_t history_batch_min_ms = 0;
    uint32_t history_batch_max_ms = 0;
    uint64_t history_checkpoint_age_ms = 0;
    uint32_t history_checkpoint_records = 0;
    uint32_t history_checkpoint_jitter_ms = 0;
};
void to_json(nlohmann::json &j, const EngineConfig &m);
void from_json(const nlohmann::json &j, EngineConfig &m);

struct EngineError {
    std::string error;
};
void to_json(nlohmann::json &j, const EngineError &m);
void from_json(const nlohmann::json &j, EngineError &m);

struct FieldValue {
    uint32_t field = 0;
    std::string value;
};
void to_json(nlohmann::json &j, const FieldValue &m);
void from_json(const nlohmann::json &j, FieldValue &m);

struct GroupPerms {
    bool send_media = false;
    bool send_stickers = false;
    bool send_polls = false;
    bool send_links = false;
    bool invite = false;
    bool pin = false;
    bool change_info = false;
};
void to_json(nlohmann::json &j, const GroupPerms &m);
void from_json(const nlohmann::json &j, GroupPerms &m);

struct IntentFaveSticker {
    std::string set_id;
    std::string sticker_id;
    bool on = false;
};
void to_json(nlohmann::json &j, const IntentFaveSticker &m);
void from_json(const nlohmann::json &j, IntentFaveSticker &m);

struct IntentGroupCreate {
    std::string title;
    std::vector<std::string> members;
    std::string kind;
};
void to_json(nlohmann::json &j, const IntentGroupCreate &m);
void from_json(const nlohmann::json &j, IntentGroupCreate &m);

struct IntentGroupJoinByLink {
    std::string url;
};
void to_json(nlohmann::json &j, const IntentGroupJoinByLink &m);
void from_json(const nlohmann::json &j, IntentGroupJoinByLink &m);

struct IntentRevoke {
    std::string device_id;
    bool stolen = false;
};
void to_json(nlohmann::json &j, const IntentRevoke &m);
void from_json(const nlohmann::json &j, IntentRevoke &m);

struct IntentRotateSsk {
    std::string root_secret;
};
void to_json(nlohmann::json &j, const IntentRotateSsk &m);
void from_json(const nlohmann::json &j, IntentRotateSsk &m);

struct JournalState {
    std::string journal;
    uint64_t cursor = 0;
    uint64_t head = 0;
    JournalWrite write = {};
};
void to_json(nlohmann::json &j, const JournalState &m);
void from_json(const nlohmann::json &j, JournalState &m);

struct KindFormat {
    std::string kind;
    uint32_t format = 0;
};
void to_json(nlohmann::json &j, const KindFormat &m);
void from_json(const nlohmann::json &j, KindFormat &m);

struct MarkValue {
    uint32_t field = 0;
    std::string value;
};
void to_json(nlohmann::json &j, const MarkValue &m);
void from_json(const nlohmann::json &j, MarkValue &m);

struct MigrationProgress {
    uint32_t from_generation = 0;
    uint32_t to_generation = 0;
    uint32_t point = 0;
    std::vector<std::string> errors;
};
void to_json(nlohmann::json &j, const MigrationProgress &m);
void from_json(const nlohmann::json &j, MigrationProgress &m);

struct MsgAnchor {
    int64_t ts_ms = 0;
    std::string id;
};
void to_json(nlohmann::json &j, const MsgAnchor &m);
void from_json(const nlohmann::json &j, MsgAnchor &m);

struct ObjectKey {
    ObjectKind kind = {};
    std::string key;
};
void to_json(nlohmann::json &j, const ObjectKey &m);
void from_json(const nlohmann::json &j, ObjectKey &m);

struct OpenResult {
    OpenState state = {};
};
void to_json(nlohmann::json &j, const OpenResult &m);
void from_json(const nlohmann::json &j, OpenResult &m);

struct OutRequest {
    uint64_t req_id = 0;
    std::string method;
    RequestChannel channel = {};
    std::string body;
    int64_t deadline_ms = 0;
    std::string dest_domain;
};
void to_json(nlohmann::json &j, const OutRequest &m);
void from_json(const nlohmann::json &j, OutRequest &m);

struct PinWrap {
    std::string salt;
    uint32_t iterations = 0;
    std::string wrapped_dek;
    std::string check;
};
void to_json(nlohmann::json &j, const PinWrap &m);
void from_json(const nlohmann::json &j, PinWrap &m);

struct RangeHold {
    std::string journal;
    uint64_t from_seq = 0;
    uint64_t to_seq = 0;
    std::vector<std::string> paths;
};
void to_json(nlohmann::json &j, const RangeHold &m);
void from_json(const nlohmann::json &j, RangeHold &m);

struct RangeHolds {
    std::vector<RangeHold> holds;
};
void to_json(nlohmann::json &j, const RangeHolds &m);
void from_json(const nlohmann::json &j, RangeHolds &m);

struct Ref {
    std::string domain;
    std::string id;
};
void to_json(nlohmann::json &j, const Ref &m);
void from_json(const nlohmann::json &j, Ref &m);

struct RowsAllRequest {
    bool views = false;
    bool states = false;
    bool marks = false;
    std::string chat_key;
    std::vector<std::string> ids;
};
void to_json(nlohmann::json &j, const RowsAllRequest &m);
void from_json(const nlohmann::json &j, RowsAllRequest &m);

struct RowsApply {
    std::string ops_json;
    std::string receipts_json;
    std::string forget_json;
    bool wipe = false;
    int64_t now_ms = 0;
    std::string rows_json;
    bool journal = false;
};
void to_json(nlohmann::json &j, const RowsApply &m);
void from_json(const nlohmann::json &j, RowsApply &m);

struct RowsReadRequest {
    std::string chat_key;
    std::string since_json;
};
void to_json(nlohmann::json &j, const RowsReadRequest &m);
void from_json(const nlohmann::json &j, RowsReadRequest &m);

struct ServerInput {
    ServerInputKind kind = {};
    std::string method;
    uint64_t req_id = 0;
    std::string body;
    int32_t error = 0;
};
void to_json(nlohmann::json &j, const ServerInput &m);
void from_json(const nlohmann::json &j, ServerInput &m);

struct StateObjectView {
    std::optional<ObjectKey> object;
    std::vector<FieldValue> fields;
    std::vector<MarkValue> marks;
};
void to_json(nlohmann::json &j, const StateObjectView &m);
void from_json(const nlohmann::json &j, StateObjectView &m);

struct StateView {
    std::vector<StateObjectView> objects;
};
void to_json(nlohmann::json &j, const StateView &m);
void from_json(const nlohmann::json &j, StateView &m);

struct StorageFormat {
    std::string kind;
    uint32_t format = 0;
};
void to_json(nlohmann::json &j, const StorageFormat &m);
void from_json(const nlohmann::json &j, StorageFormat &m);

struct StoreCommitted {
    uint64_t batch_id = 0;
};
void to_json(nlohmann::json &j, const StoreCommitted &m);
void from_json(const nlohmann::json &j, StoreCommitted &m);

struct StorePut {
    std::string key;
    std::string value;
};
void to_json(nlohmann::json &j, const StorePut &m);
void from_json(const nlohmann::json &j, StorePut &m);

struct StoreReads {
    uint64_t read_id = 0;
    std::vector<std::string> keys;
    std::string prefix;
    std::string after;
    uint32_t limit = 0;
};
void to_json(nlohmann::json &j, const StoreReads &m);
void from_json(const nlohmann::json &j, StoreReads &m);

struct Stored {
    uint32_t format = 0;
    std::string kind;
    uint32_t generation = 0;
    std::string payload;
};
void to_json(nlohmann::json &j, const Stored &m);
void from_json(const nlohmann::json &j, Stored &m);

struct Tick {
    int64_t now_ms = 0;
};
void to_json(nlohmann::json &j, const Tick &m);
void from_json(const nlohmann::json &j, Tick &m);

struct UnlockPin {
    std::string pin;
};
void to_json(nlohmann::json &j, const UnlockPin &m);
void from_json(const nlohmann::json &j, UnlockPin &m);

struct UserRef {
    std::string address;
};
void to_json(nlohmann::json &j, const UserRef &m);
void from_json(const nlohmann::json &j, UserRef &m);

struct ViewArticle {
    std::string title;
    std::string markdown;
};
void to_json(nlohmann::json &j, const ViewArticle &m);
void from_json(const nlohmann::json &j, ViewArticle &m);

struct ViewCall {
    bool video = false;
    bool outgoing = false;
    uint32_t duration_s = 0;
    std::string reason;
};
void to_json(nlohmann::json &j, const ViewCall &m);
void from_json(const nlohmann::json &j, ViewCall &m);

struct ViewCloudInvite {
    std::string title;
    std::string owner;
    std::string role;
};
void to_json(nlohmann::json &j, const ViewCloudInvite &m);
void from_json(const nlohmann::json &j, ViewCloudInvite &m);

struct ViewContact {
    std::string user;
    std::string first_name;
    std::string last_name;
};
void to_json(nlohmann::json &j, const ViewContact &m);
void from_json(const nlohmann::json &j, ViewContact &m);

struct ViewEntity {
    std::string type;
    uint32_t offset = 0;
    uint32_t length = 0;
    std::string url;
    std::string user;
    std::string language;
    std::string custom_emoji_id;
};
void to_json(nlohmann::json &j, const ViewEntity &m);
void from_json(const nlohmann::json &j, ViewEntity &m);

struct ViewGroupRequest {
    std::optional<Ref> group;
};
void to_json(nlohmann::json &j, const ViewGroupRequest &m);
void from_json(const nlohmann::json &j, ViewGroupRequest &m);

struct ViewLocation {
    double lat = 0;
    double lon = 0;
    std::string title;
};
void to_json(nlohmann::json &j, const ViewLocation &m);
void from_json(const nlohmann::json &j, ViewLocation &m);

struct ViewPoll {
    std::string question;
    std::vector<std::string> options;
    bool multiple = false;
    bool quiz = false;
    std::vector<uint32_t> my_votes;
    std::vector<uint32_t> votes;
};
void to_json(nlohmann::json &j, const ViewPoll &m);
void from_json(const nlohmann::json &j, ViewPoll &m);

struct ViewReaction {
    std::string emoji;
    uint32_t count = 0;
    bool mine = false;
};
void to_json(nlohmann::json &j, const ViewReaction &m);
void from_json(const nlohmann::json &j, ViewReaction &m);

struct ViewService {
    std::string kind;
    std::string actor;
    std::vector<std::string> targets;
    std::string text;
};
void to_json(nlohmann::json &j, const ViewService &m);
void from_json(const nlohmann::json &j, ViewService &m);

struct ViewStateRequest {
    std::vector<std::string> kinds;
};
void to_json(nlohmann::json &j, const ViewStateRequest &m);
void from_json(const nlohmann::json &j, ViewStateRequest &m);

struct ViewTaskOffer {
    std::string title;
    std::string text;
    std::string task_id;
};
void to_json(nlohmann::json &j, const ViewTaskOffer &m);
void from_json(const nlohmann::json &j, ViewTaskOffer &m);

struct ViewText {
    std::string text;
    std::vector<ViewEntity> entities;
};
void to_json(nlohmann::json &j, const ViewText &m);
void from_json(const nlohmann::json &j, ViewText &m);

struct Wrap {
    uint32_t generation = 0;
    // oneof kind: device, pin
    std::variant<std::monostate, DeviceWrap, PinWrap> kind;
};
void to_json(nlohmann::json &j, const Wrap &m);
void from_json(const nlohmann::json &j, Wrap &m);

struct WriteBlocked {
    std::string journal;
    JournalWrite reason = {};
};
void to_json(nlohmann::json &j, const WriteBlocked &m);
void from_json(const nlohmann::json &j, WriteBlocked &m);

struct EngineInfo {
    std::string engine_api;
    uint32_t proto_major = 0;
    uint32_t proto_minor = 0;
    uint32_t min_supported_minor = 0;
    std::vector<std::string> features;
    std::vector<StorageFormat> storage_formats;
    std::vector<CriticalRange> critical_ranges;
    std::string source_hash;
    std::string schema_hash;
    std::string build_id;
    std::string target;
};
void to_json(nlohmann::json &j, const EngineInfo &m);
void from_json(const nlohmann::json &j, EngineInfo &m);

struct IntentDomainOp {
    std::optional<Ref> container;
    std::string op;
};
void to_json(nlohmann::json &j, const IntentDomainOp &m);
void from_json(const nlohmann::json &j, IntentDomainOp &m);

struct IntentGroupChange {
    std::optional<Ref> group;
    std::string change;
};
void to_json(nlohmann::json &j, const IntentGroupChange &m);
void from_json(const nlohmann::json &j, IntentGroupChange &m);

struct IntentStateCreate {
    std::optional<ObjectKey> object;
    std::vector<FieldValue> set;
};
void to_json(nlohmann::json &j, const IntentStateCreate &m);
void from_json(const nlohmann::json &j, IntentStateCreate &m);

struct IntentStateDelete {
    std::optional<ObjectKey> object;
};
void to_json(nlohmann::json &j, const IntentStateDelete &m);
void from_json(const nlohmann::json &j, IntentStateDelete &m);

struct IntentStatePatch {
    std::optional<ObjectKey> object;
    std::vector<FieldValue> set;
    std::vector<uint32_t> clear;
};
void to_json(nlohmann::json &j, const IntentStatePatch &m);
void from_json(const nlohmann::json &j, IntentStatePatch &m);

struct IntentStateSetAdd {
    std::optional<ObjectKey> object;
    uint32_t field = 0;
    std::string element;
};
void to_json(nlohmann::json &j, const IntentStateSetAdd &m);
void from_json(const nlohmann::json &j, IntentStateSetAdd &m);

struct IntentStateSetRemove {
    std::optional<ObjectKey> object;
    uint32_t field = 0;
    std::string element;
};
void to_json(nlohmann::json &j, const IntentStateSetRemove &m);
void from_json(const nlohmann::json &j, IntentStateSetRemove &m);

struct Peer {
    // oneof kind: user, group
    std::variant<std::monostate, UserRef, Ref> kind;
};
void to_json(nlohmann::json &j, const Peer &m);
void from_json(const nlohmann::json &j, Peer &m);

struct Root {
    std::string store_id;
    uint32_t active_generation = 0;
    uint32_t pending_generation = 0;
    std::vector<Wrap> wraps;
    std::vector<KindFormat> kinds_max_format;
    uint32_t retiring_generation = 0;
};
void to_json(nlohmann::json &j, const Root &m);
void from_json(const nlohmann::json &j, Root &m);

struct StateChanged {
    std::optional<ObjectKey> object;
    std::optional<StateObjectView> view;
};
void to_json(nlohmann::json &j, const StateChanged &m);
void from_json(const nlohmann::json &j, StateChanged &m);

struct StoreBatch {
    uint64_t batch_id = 0;
    std::vector<StorePut> puts;
    std::vector<std::string> deletes;
};
void to_json(nlohmann::json &j, const StoreBatch &m);
void from_json(const nlohmann::json &j, StoreBatch &m);

struct StoreLoaded {
    uint64_t read_id = 0;
    std::vector<StorePut> entries;
};
void to_json(nlohmann::json &j, const StoreLoaded &m);
void from_json(const nlohmann::json &j, StoreLoaded &m);

struct UnreadChanged {
    std::optional<Peer> chat;
    uint32_t count = 0;
    bool mention = false;
    std::string last_read_id;
    int64_t last_read_ts_ms = 0;
    std::vector<std::string> mentions;
};
void to_json(nlohmann::json &j, const UnreadChanged &m);
void from_json(const nlohmann::json &j, UnreadChanged &m);

struct ViewMedia {
    std::string kind;
    std::string file_id;
    std::string blob_domain;
    std::string key;
    std::string nonce;
    std::string capability;
    std::string mime;
    std::string name;
    uint64_t size = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t duration_s = 0;
    std::string thumb;
    std::optional<ViewText> caption;
    bool spoiler = false;
    bool caption_above = false;
    std::string waveform;
    std::string album_id;
    std::string title;
    std::string performer;
};
void to_json(nlohmann::json &j, const ViewMedia &m);
void from_json(const nlohmann::json &j, ViewMedia &m);

struct ViewSticker {
    std::string pack;
    std::string sticker_id;
    std::string emoji;
    std::optional<ViewMedia> media;
};
void to_json(nlohmann::json &j, const ViewSticker &m);
void from_json(const nlohmann::json &j, ViewSticker &m);

struct CapabilitiesRequest {
    std::optional<Peer> chat;
};
void to_json(nlohmann::json &j, const CapabilitiesRequest &m);
void from_json(const nlohmann::json &j, CapabilitiesRequest &m);

struct ComposeContent {
    std::string reply_to;
    bool silent = false;
    // oneof kind: text, media, sticker, poll, location, contact, article
    std::variant<std::monostate, ViewText, ViewMedia, ViewSticker, ViewPoll, ViewLocation, ViewContact, ViewArticle> kind;
};
void to_json(nlohmann::json &j, const ComposeContent &m);
void from_json(const nlohmann::json &j, ComposeContent &m);

struct GroupView {
    std::optional<Ref> group;
    std::string kind;
    std::string title;
    std::string about;
    std::optional<ViewMedia> photo;
    uint32_t members_count = 0;
    GroupRole my_role = {};
    std::optional<GroupPerms> perms;
    bool is_public = false;
    std::vector<std::string> invite_links;
    std::string info_json;
    uint64_t version = 0;
    bool deleted = false;
    bool can_manage_invites = false;
    bool can_decide_requests = false;
    bool can_rotate = false;
    bool can_ban = false;
    bool can_add_admins = false;
    bool can_delete_messages = false;
};
void to_json(nlohmann::json &j, const GroupView &m);
void from_json(const nlohmann::json &j, GroupView &m);

struct HistoryPageRequest {
    std::optional<Peer> chat;
    std::optional<MsgAnchor> anchor;
    PageDirection direction = {};
    uint32_t limit = 0;
};
void to_json(nlohmann::json &j, const HistoryPageRequest &m);
void from_json(const nlohmann::json &j, HistoryPageRequest &m);

struct IntentDelete {
    std::optional<Peer> chat;
    std::vector<std::string> targets;
    DeleteScope scope = {};
};
void to_json(nlohmann::json &j, const IntentDelete &m);
void from_json(const nlohmann::json &j, IntentDelete &m);

struct IntentEdit {
    std::optional<Peer> chat;
    std::string target;
    std::optional<ComposeContent> content;
};
void to_json(nlohmann::json &j, const IntentEdit &m);
void from_json(const nlohmann::json &j, IntentEdit &m);

struct IntentPin {
    std::optional<Peer> chat;
    std::string target;
    bool on = false;
};
void to_json(nlohmann::json &j, const IntentPin &m);
void from_json(const nlohmann::json &j, IntentPin &m);

struct IntentReact {
    std::optional<Peer> chat;
    std::string target;
    std::string emoji;
};
void to_json(nlohmann::json &j, const IntentReact &m);
void from_json(const nlohmann::json &j, IntentReact &m);

struct IntentRead {
    std::optional<Peer> chat;
    std::optional<MsgAnchor> up_to;
};
void to_json(nlohmann::json &j, const IntentRead &m);
void from_json(const nlohmann::json &j, IntentRead &m);

struct IntentSend {
    std::optional<Peer> chat;
    std::optional<ComposeContent> content;
    int64_t schedule_at_ms = 0;
};
void to_json(nlohmann::json &j, const IntentSend &m);
void from_json(const nlohmann::json &j, IntentSend &m);

struct IntentTyping {
    std::optional<Peer> chat;
    std::string action;
};
void to_json(nlohmann::json &j, const IntentTyping &m);
void from_json(const nlohmann::json &j, IntentTyping &m);

struct MessageRemove {
    std::optional<Peer> chat;
    std::string id;
};
void to_json(nlohmann::json &j, const MessageRemove &m);
void from_json(const nlohmann::json &j, MessageRemove &m);

struct Need {
    std::string kind;
    std::optional<Peer> chat;
    std::string detail;
};
void to_json(nlohmann::json &j, const Need &m);
void from_json(const nlohmann::json &j, Need &m);

struct Notice {
    std::optional<Peer> chat;
    std::string kind;
    std::string detail;
};
void to_json(nlohmann::json &j, const Notice &m);
void from_json(const nlohmann::json &j, Notice &m);

struct ViewBody {
    // oneof kind: text, media, sticker, poll, location, contact, call, task_offer, article, cloud_invite, service
    std::variant<std::monostate, ViewText, ViewMedia, ViewSticker, ViewPoll, ViewLocation, ViewContact, ViewCall, ViewTaskOffer, ViewArticle, ViewCloudInvite, ViewService> kind;
};
void to_json(nlohmann::json &j, const ViewBody &m);
void from_json(const nlohmann::json &j, ViewBody &m);

struct Intent {
    // oneof kind: send, edit, delete_messages, react, pin, read, typing, state_patch, state_create, state_delete, state_set_add, state_set_remove, group_create, group_change, group_join_by_link, domain_op, fave_sticker, rotate_ssk, revoke
    std::variant<std::monostate, IntentSend, IntentEdit, IntentDelete, IntentReact, IntentPin, IntentRead, IntentTyping, IntentStatePatch, IntentStateCreate, IntentStateDelete, IntentStateSetAdd, IntentStateSetRemove, IntentGroupCreate, IntentGroupChange, IntentGroupJoinByLink, IntentDomainOp, IntentFaveSticker, IntentRotateSsk, IntentRevoke> kind;
};
void to_json(nlohmann::json &j, const Intent &m);
void from_json(const nlohmann::json &j, Intent &m);

struct MessageView {
    std::string id;
    std::optional<Peer> chat;
    std::string from;
    int64_t ts_ms = 0;
    int64_t edited_ts_ms = 0;
    bool outgoing = false;
    Disposition disposition = {};
    std::optional<ViewBody> body;
    std::string reply_to;
    std::string forward_from;
    std::vector<ViewReaction> reactions;
    bool pinned = false;
    uint32_t ttl_secs = 0;
    Delivery delivery = {};
    std::string forward_name;
    std::optional<ViewText> reply_quote;
    bool silent = false;
    int64_t order = 0;
    std::string wire;
    bool unread = false;
};
void to_json(nlohmann::json &j, const MessageView &m);
void from_json(const nlohmann::json &j, MessageView &m);

struct ChatView {
    std::optional<Peer> chat;
    std::string title;
    std::optional<ViewMedia> photo;
    std::optional<MessageView> last;
    uint32_t unread = 0;
    bool mention = false;
    uint32_t pinned_rank = 0;
    bool archived = false;
    int64_t muted_until_ms = 0;
    std::string draft;
    std::vector<uint32_t> folder_ids;
    bool unread_mark = false;
    int64_t order = 0;
};
void to_json(nlohmann::json &j, const ChatView &m);
void from_json(const nlohmann::json &j, ChatView &m);

struct HistoryPage {
    std::vector<MessageView> rows;
    std::optional<MsgAnchor> older;
    std::optional<MsgAnchor> newer;
    bool has_older = false;
    bool has_newer = false;
    std::optional<StoreReads> pending;
};
void to_json(nlohmann::json &j, const HistoryPage &m);
void from_json(const nlohmann::json &j, HistoryPage &m);

struct ModelChange {
    // oneof change: chat_upsert, chat_remove, message_upsert, message_remove, state_changed, group_changed, notice, unread_changed, write_blocked, needs, client_events
    std::variant<std::monostate, ChatView, Peer, MessageView, MessageRemove, StateChanged, GroupView, Notice, UnreadChanged, WriteBlocked, Need, ClientEvents> change;
};
void to_json(nlohmann::json &j, const ModelChange &m);
void from_json(const nlohmann::json &j, ModelChange &m);

struct ModelDelta {
    uint64_t revision = 0;
    std::vector<ModelChange> changes;
};
void to_json(nlohmann::json &j, const ModelDelta &m);
void from_json(const nlohmann::json &j, ModelDelta &m);

struct Outcome {
    std::optional<StoreBatch> store_batch;
    std::vector<StoreReads> store_reads;
    std::vector<OutRequest> requests;
    std::optional<ModelDelta> delta;
    std::optional<OpenResult> open;
};
void to_json(nlohmann::json &j, const Outcome &m);
void from_json(const nlohmann::json &j, Outcome &m);

struct ChatPage {
    std::vector<ChatView> chats;
    std::optional<ChatAnchor> next;
};
void to_json(nlohmann::json &j, const ChatPage &m);
void from_json(const nlohmann::json &j, ChatPage &m);

} // namespace parvane::gen
