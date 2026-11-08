// Сгенерировано gen_bindings (cargo run -p parvane-protocol --bin gen_bindings) из proto/parvane/engine/v1/** — не править руками; проверка — gen_bindings --check (тест bindings_are_fresh).
// Граница движка — proto3-JSON: имена полей схемы, int64 — строка, bytes — base64, enum — имя.
@file:Suppress("unused", "ArrayInDataClass")

package org.parvane.gen

import org.json.JSONArray
import org.json.JSONObject

private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

fun toBase64(b: ByteArray): String {
    val out = StringBuilder()
    var i = 0
    while (i < b.size) {
        val n = ((b[i].toInt() and 0xff) shl 16) or ((if (i + 1 < b.size) b[i + 1].toInt() and 0xff else 0) shl 8) or (if (i + 2 < b.size) b[i + 2].toInt() and 0xff else 0)
        out.append(B64[(n shr 18) and 63]).append(B64[(n shr 12) and 63])
        out.append(if (i + 1 < b.size) B64[(n shr 6) and 63] else '=')
        out.append(if (i + 2 < b.size) B64[n and 63] else '=')
        i += 3
    }
    return out.toString()
}

fun fromBase64(t: String): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    var acc = 0
    var bits = 0
    for (c0 in t) {
        if (c0 == '=' || c0.isWhitespace()) continue
        val c = when (c0) { '-' -> '+'; '_' -> '/'; else -> c0 }
        val v = B64.indexOf(c)
        require(v >= 0) { "base64" }
        acc = (acc shl 6) or v
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out.write((acc shr bits) and 0xff)
        }
    }
    return out.toByteArray()
}

private fun JSONObject.pick(proto: String, camel: String): Any? {
    val v = if (has(proto)) opt(proto) else opt(camel)
    return if (v == null || v == JSONObject.NULL) null else v
}

enum class DeleteScope(val number: Int) {
    DELETE_SCOPE_UNSPECIFIED(0),
    DELETE_SCOPE_ME(1),
    DELETE_SCOPE_EVERYONE(2);

    companion object {
        fun fromJson(v: Any?): DeleteScope = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class Delivery(val number: Int) {
    DELIVERY_UNSPECIFIED(0),
    DELIVERY_PENDING(1),
    DELIVERY_SENT(2),
    DELIVERY_READ(3),
    DELIVERY_FAILED(4);

    companion object {
        fun fromJson(v: Any?): Delivery = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class Disposition(val number: Int) {
    DISPOSITION_UNSPECIFIED(0),
    DISPOSITION_SHOW(1),
    DISPOSITION_STUB(2),
    DISPOSITION_STUB_CRITICAL(3);

    companion object {
        fun fromJson(v: Any?): Disposition = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class GroupRole(val number: Int) {
    GROUP_ROLE_UNSPECIFIED(0),
    GROUP_ROLE_MEMBER(1),
    GROUP_ROLE_ADMIN(2),
    GROUP_ROLE_OWNER(3),
    GROUP_ROLE_LEFT(4),
    GROUP_ROLE_BANNED(5);

    companion object {
        fun fromJson(v: Any?): GroupRole = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class JournalWrite(val number: Int) {
    JOURNAL_WRITE_UNSPECIFIED(0),
    JOURNAL_WRITE_OPEN(1),
    JOURNAL_WRITE_BLOCKED_CRITICAL_UNKNOWN(2),
    JOURNAL_WRITE_BLOCKED_TOO_NEW(3);

    companion object {
        fun fromJson(v: Any?): JournalWrite = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class ObjectKind(val number: Int) {
    OBJECT_KIND_UNSPECIFIED(0),
    OBJECT_KIND_FOLDER(1),
    OBJECT_KIND_BLOCK(2),
    OBJECT_KIND_PEER_NOTIFY(3),
    OBJECT_KIND_NOTIFY_DEFAULTS(4),
    OBJECT_KIND_DRAFT(5),
    OBJECT_KIND_SCHEDULED(6),
    OBJECT_KIND_ARCHIVE(7),
    OBJECT_KIND_PIN_LIST(8),
    OBJECT_KIND_CALL(9),
    OBJECT_KIND_GROUP_INVITE(10),
    OBJECT_KIND_PLANNER_CONTAINER(11),
    OBJECT_KIND_CLOUD_CONTAINER(12),
    OBJECT_KIND_UNREAD_MARK(13),
    OBJECT_KIND_QUICK_REACTION(14),
    OBJECT_KIND_STICKER_PACK(15),
    OBJECT_KIND_CONTACT(16),
    OBJECT_KIND_FOLDER_ORDER(17),
    OBJECT_KIND_CHAT_CLEARED(18),
    OBJECT_KIND_SAVED_GIF(19),
    OBJECT_KIND_FAVED_STICKER(20);

    companion object {
        fun fromJson(v: Any?): ObjectKind = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class OpenState(val number: Int) {
    OPEN_STATE_UNSPECIFIED(0),
    OPEN_STATE_READY(1),
    OPEN_STATE_MIGRATION_NEEDED(2),
    OPEN_STATE_TOO_NEW(3),
    OPEN_STATE_LOCKED(4);

    companion object {
        fun fromJson(v: Any?): OpenState = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class PageDirection(val number: Int) {
    PAGE_DIRECTION_UNSPECIFIED(0),
    PAGE_DIRECTION_OLDER(1),
    PAGE_DIRECTION_NEWER(2),
    PAGE_DIRECTION_AROUND(3);

    companion object {
        fun fromJson(v: Any?): PageDirection = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class RequestChannel(val number: Int) {
    REQUEST_CHANNEL_UNSPECIFIED(0),
    REQUEST_CHANNEL_ID(1),
    REQUEST_CHANNEL_ANON(2);

    companion object {
        fun fromJson(v: Any?): RequestChannel = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

enum class ServerInputKind(val number: Int) {
    SERVER_INPUT_KIND_UNSPECIFIED(0),
    SERVER_INPUT_KIND_RESPONSE(1),
    SERVER_INPUT_KIND_EVENT(2),
    SERVER_INPUT_KIND_INBOX_RECORD(3),
    SERVER_INPUT_KIND_STREAM_CHUNK(4);

    companion object {
        fun fromJson(v: Any?): ServerInputKind = values().firstOrNull { it.name == v?.toString() }
            ?: values().firstOrNull { it.number == v?.toString()?.toIntOrNull() } ?: values()[0]
    }
}

data class AuditDump(
    val jsonl: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(jsonl.isEmpty())) j.put("jsonl", jsonl)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): AuditDump {
            return AuditDump(
                jsonl = j.pick("jsonl", "jsonl")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class CallResult(
    val resultJson: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(resultJson.isEmpty())) j.put("result_json", resultJson)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): CallResult {
            return CallResult(
                resultJson = j.pick("result_json", "resultJson")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class Capabilities(
    val sendText: Boolean = false,
    val sendMedia: Boolean = false,
    val sendStickers: Boolean = false,
    val sendPolls: Boolean = false,
    val sendLinks: Boolean = false,
    val deleteEveryone: Boolean = false,
    val pin: Boolean = false,
    val edit: Boolean = false,
    val react: Boolean = false,
    val forward: Boolean = false,
    val reply: Boolean = false
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(!sendText)) j.put("send_text", sendText)
        if (!(!sendMedia)) j.put("send_media", sendMedia)
        if (!(!sendStickers)) j.put("send_stickers", sendStickers)
        if (!(!sendPolls)) j.put("send_polls", sendPolls)
        if (!(!sendLinks)) j.put("send_links", sendLinks)
        if (!(!deleteEveryone)) j.put("delete_everyone", deleteEveryone)
        if (!(!pin)) j.put("pin", pin)
        if (!(!edit)) j.put("edit", edit)
        if (!(!react)) j.put("react", react)
        if (!(!forward)) j.put("forward", forward)
        if (!(!reply)) j.put("reply", reply)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Capabilities {
            return Capabilities(
                sendText = j.pick("send_text", "sendText")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                sendMedia = j.pick("send_media", "sendMedia")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                sendStickers = j.pick("send_stickers", "sendStickers")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                sendPolls = j.pick("send_polls", "sendPolls")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                sendLinks = j.pick("send_links", "sendLinks")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                deleteEveryone = j.pick("delete_everyone", "deleteEveryone")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                pin = j.pick("pin", "pin")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                edit = j.pick("edit", "edit")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                react = j.pick("react", "react")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                forward = j.pick("forward", "forward")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                reply = j.pick("reply", "reply")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false
            )
        }
    }
}

data class CapabilitiesRequest(
    val chat: Peer? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): CapabilitiesRequest {
            return CapabilitiesRequest(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class ChatAnchor(
    val tsMs: Long = 0L,
    val chatKey: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(tsMs == 0L)) j.put("ts_ms", tsMs.toString())
        if (!(chatKey.isEmpty())) j.put("chat_key", chatKey)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ChatAnchor {
            return ChatAnchor(
                tsMs = j.pick("ts_ms", "tsMs")?.let { it.toString().toLong() } ?: 0L,
                chatKey = j.pick("chat_key", "chatKey")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ChatListRequest(
    val after: ChatAnchor? = null,
    val limit: Long = 0L,
    val folder: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(after == null)) j.put("after", after!!.toJson())
        if (!(limit == 0L)) j.put("limit", limit)
        if (!(folder == 0L)) j.put("folder", folder)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ChatListRequest {
            return ChatListRequest(
                after = j.pick("after", "after")?.let { ChatAnchor.fromJson(it as JSONObject) } ?: null,
                limit = j.pick("limit", "limit")?.let { it.toString().toLong() } ?: 0L,
                folder = j.pick("folder", "folder")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class ChatPage(
    val chats: List<ChatView> = emptyList(),
    val next: ChatAnchor? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (chats.isNotEmpty()) j.put("chats", JSONArray().apply { chats.forEach { put(it.toJson()) } })
        if (!(next == null)) j.put("next", next!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ChatPage {
            return ChatPage(
                chats = (j.pick("chats", "chats") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { ChatView.fromJson(it as JSONObject) } } } ?: emptyList(),
                next = j.pick("next", "next")?.let { ChatAnchor.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class ChatView(
    val chat: Peer? = null,
    val title: String = "",
    val photo: ViewMedia? = null,
    val last: MessageView? = null,
    val unread: Long = 0L,
    val mention: Boolean = false,
    val pinnedRank: Long = 0L,
    val archived: Boolean = false,
    val mutedUntilMs: Long = 0L,
    val draft: String = "",
    val folderIds: List<Long> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(title.isEmpty())) j.put("title", title)
        if (!(photo == null)) j.put("photo", photo!!.toJson())
        if (!(last == null)) j.put("last", last!!.toJson())
        if (!(unread == 0L)) j.put("unread", unread)
        if (!(!mention)) j.put("mention", mention)
        if (!(pinnedRank == 0L)) j.put("pinned_rank", pinnedRank)
        if (!(!archived)) j.put("archived", archived)
        if (!(mutedUntilMs == 0L)) j.put("muted_until_ms", mutedUntilMs.toString())
        if (!(draft.isEmpty())) j.put("draft", draft)
        if (folderIds.isNotEmpty()) j.put("folder_ids", JSONArray().apply { folderIds.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ChatView {
            return ChatView(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                title = j.pick("title", "title")?.let { it.toString() } ?: "",
                photo = j.pick("photo", "photo")?.let { ViewMedia.fromJson(it as JSONObject) } ?: null,
                last = j.pick("last", "last")?.let { MessageView.fromJson(it as JSONObject) } ?: null,
                unread = j.pick("unread", "unread")?.let { it.toString().toLong() } ?: 0L,
                mention = j.pick("mention", "mention")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                pinnedRank = j.pick("pinned_rank", "pinnedRank")?.let { it.toString().toLong() } ?: 0L,
                archived = j.pick("archived", "archived")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                mutedUntilMs = j.pick("muted_until_ms", "mutedUntilMs")?.let { it.toString().toLong() } ?: 0L,
                draft = j.pick("draft", "draft")?.let { it.toString() } ?: "",
                folderIds = (j.pick("folder_ids", "folderIds") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString().toLong() } } } ?: emptyList()
            )
        }
    }
}

data class ClientCall(
    val name: String = "",
    val argsJson: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(name.isEmpty())) j.put("name", name)
        if (!(argsJson.isEmpty())) j.put("args_json", argsJson)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ClientCall {
            return ClientCall(
                name = j.pick("name", "name")?.let { it.toString() } ?: "",
                argsJson = j.pick("args_json", "argsJson")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ClientEvents(
    val json: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(json.isEmpty())) j.put("json", json)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ClientEvents {
            return ClientEvents(
                json = j.pick("json", "json")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ClientReplace(
    val mode: String = "",
    val blob: ByteArray = ByteArray(0),
    val key: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(mode.isEmpty())) j.put("mode", mode)
        if (!(blob.isEmpty())) j.put("blob", toBase64(blob))
        if (!(key.isEmpty())) j.put("key", toBase64(key))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ClientReplace {
            return ClientReplace(
                mode = j.pick("mode", "mode")?.let { it.toString() } ?: "",
                blob = j.pick("blob", "blob")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                key = j.pick("key", "key")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

sealed interface ComposeContentKind {
    data class Text(val value: org.parvane.gen.ViewText) : ComposeContentKind
    data class Media(val value: org.parvane.gen.ViewMedia) : ComposeContentKind
    data class Sticker(val value: org.parvane.gen.ViewSticker) : ComposeContentKind
    data class Poll(val value: org.parvane.gen.ViewPoll) : ComposeContentKind
    data class Location(val value: org.parvane.gen.ViewLocation) : ComposeContentKind
    data class Contact(val value: org.parvane.gen.ViewContact) : ComposeContentKind
    data class Article(val value: org.parvane.gen.ViewArticle) : ComposeContentKind
}

data class ComposeContent(
    val replyTo: ByteArray = ByteArray(0),
    val silent: Boolean = false,
    val kind: ComposeContentKind? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(replyTo.isEmpty())) j.put("reply_to", toBase64(replyTo))
        if (!(!silent)) j.put("silent", silent)
        when (val o = kind) {
            is ComposeContentKind.Text -> j.put("text", o.value.toJson())
            is ComposeContentKind.Media -> j.put("media", o.value.toJson())
            is ComposeContentKind.Sticker -> j.put("sticker", o.value.toJson())
            is ComposeContentKind.Poll -> j.put("poll", o.value.toJson())
            is ComposeContentKind.Location -> j.put("location", o.value.toJson())
            is ComposeContentKind.Contact -> j.put("contact", o.value.toJson())
            is ComposeContentKind.Article -> j.put("article", o.value.toJson())
            null -> {}
        }
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ComposeContent {
            var kind: ComposeContentKind? = null
            j.pick("text", "text")?.let { kind = ComposeContentKind.Text(ViewText.fromJson(it as JSONObject)) }
            j.pick("media", "media")?.let { kind = ComposeContentKind.Media(ViewMedia.fromJson(it as JSONObject)) }
            j.pick("sticker", "sticker")?.let { kind = ComposeContentKind.Sticker(ViewSticker.fromJson(it as JSONObject)) }
            j.pick("poll", "poll")?.let { kind = ComposeContentKind.Poll(ViewPoll.fromJson(it as JSONObject)) }
            j.pick("location", "location")?.let { kind = ComposeContentKind.Location(ViewLocation.fromJson(it as JSONObject)) }
            j.pick("contact", "contact")?.let { kind = ComposeContentKind.Contact(ViewContact.fromJson(it as JSONObject)) }
            j.pick("article", "article")?.let { kind = ComposeContentKind.Article(ViewArticle.fromJson(it as JSONObject)) }
            return ComposeContent(
                replyTo = j.pick("reply_to", "replyTo")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                silent = j.pick("silent", "silent")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                kind = kind
            )
        }
    }
}

data class CriticalRange(
    val name: String = "",
    val from: Long = 0L,
    val to: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(name.isEmpty())) j.put("name", name)
        if (!(from == 0L)) j.put("from", from)
        if (!(to == 0L)) j.put("to", to)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): CriticalRange {
            return CriticalRange(
                name = j.pick("name", "name")?.let { it.toString() } ?: "",
                from = j.pick("from", "from")?.let { it.toString().toLong() } ?: 0L,
                to = j.pick("to", "to")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class DeviceWrap(
    val wrappedDek: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(wrappedDek.isEmpty())) j.put("wrapped_dek", toBase64(wrappedDek))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): DeviceWrap {
            return DeviceWrap(
                wrappedDek = j.pick("wrapped_dek", "wrappedDek")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class EngineConfig(
    val user: String = "",
    val deviceId: String = "",
    val domain: String = "",
    val features: List<String> = emptyList(),
    val nowMs: Long = 0L,
    val memoryBudgetBytes: Long = 0L,
    val deviceKey: ByteArray = ByteArray(0),
    val vectors: Boolean = false,
    val legacyPresent: Boolean = false,
    val hostDriven: Boolean = false
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(user.isEmpty())) j.put("user", user)
        if (!(deviceId.isEmpty())) j.put("device_id", deviceId)
        if (!(domain.isEmpty())) j.put("domain", domain)
        if (features.isNotEmpty()) j.put("features", JSONArray().apply { features.forEach { put(it) } })
        if (!(nowMs == 0L)) j.put("now_ms", nowMs.toString())
        if (!(memoryBudgetBytes == 0L)) j.put("memory_budget_bytes", memoryBudgetBytes.toString())
        if (!(deviceKey.isEmpty())) j.put("device_key", toBase64(deviceKey))
        if (!(!vectors)) j.put("vectors", vectors)
        if (!(!legacyPresent)) j.put("legacy_present", legacyPresent)
        if (!(!hostDriven)) j.put("host_driven", hostDriven)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): EngineConfig {
            return EngineConfig(
                user = j.pick("user", "user")?.let { it.toString() } ?: "",
                deviceId = j.pick("device_id", "deviceId")?.let { it.toString() } ?: "",
                domain = j.pick("domain", "domain")?.let { it.toString() } ?: "",
                features = (j.pick("features", "features") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList(),
                nowMs = j.pick("now_ms", "nowMs")?.let { it.toString().toLong() } ?: 0L,
                memoryBudgetBytes = j.pick("memory_budget_bytes", "memoryBudgetBytes")?.let { it.toString().toLong() } ?: 0L,
                deviceKey = j.pick("device_key", "deviceKey")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                vectors = j.pick("vectors", "vectors")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                legacyPresent = j.pick("legacy_present", "legacyPresent")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                hostDriven = j.pick("host_driven", "hostDriven")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false
            )
        }
    }
}

data class EngineError(
    val error: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(error.isEmpty())) j.put("error", error)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): EngineError {
            return EngineError(
                error = j.pick("error", "error")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class EngineInfo(
    val engineApi: String = "",
    val protoMajor: Long = 0L,
    val protoMinor: Long = 0L,
    val minSupportedMinor: Long = 0L,
    val features: List<String> = emptyList(),
    val storageFormats: List<StorageFormat> = emptyList(),
    val criticalRanges: List<CriticalRange> = emptyList(),
    val sourceHash: String = "",
    val schemaHash: String = "",
    val buildId: String = "",
    val target: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(engineApi.isEmpty())) j.put("engine_api", engineApi)
        if (!(protoMajor == 0L)) j.put("proto_major", protoMajor)
        if (!(protoMinor == 0L)) j.put("proto_minor", protoMinor)
        if (!(minSupportedMinor == 0L)) j.put("min_supported_minor", minSupportedMinor)
        if (features.isNotEmpty()) j.put("features", JSONArray().apply { features.forEach { put(it) } })
        if (storageFormats.isNotEmpty()) j.put("storage_formats", JSONArray().apply { storageFormats.forEach { put(it.toJson()) } })
        if (criticalRanges.isNotEmpty()) j.put("critical_ranges", JSONArray().apply { criticalRanges.forEach { put(it.toJson()) } })
        if (!(sourceHash.isEmpty())) j.put("source_hash", sourceHash)
        if (!(schemaHash.isEmpty())) j.put("schema_hash", schemaHash)
        if (!(buildId.isEmpty())) j.put("build_id", buildId)
        if (!(target.isEmpty())) j.put("target", target)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): EngineInfo {
            return EngineInfo(
                engineApi = j.pick("engine_api", "engineApi")?.let { it.toString() } ?: "",
                protoMajor = j.pick("proto_major", "protoMajor")?.let { it.toString().toLong() } ?: 0L,
                protoMinor = j.pick("proto_minor", "protoMinor")?.let { it.toString().toLong() } ?: 0L,
                minSupportedMinor = j.pick("min_supported_minor", "minSupportedMinor")?.let { it.toString().toLong() } ?: 0L,
                features = (j.pick("features", "features") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList(),
                storageFormats = (j.pick("storage_formats", "storageFormats") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { StorageFormat.fromJson(it as JSONObject) } } } ?: emptyList(),
                criticalRanges = (j.pick("critical_ranges", "criticalRanges") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { CriticalRange.fromJson(it as JSONObject) } } } ?: emptyList(),
                sourceHash = j.pick("source_hash", "sourceHash")?.let { it.toString() } ?: "",
                schemaHash = j.pick("schema_hash", "schemaHash")?.let { it.toString() } ?: "",
                buildId = j.pick("build_id", "buildId")?.let { it.toString() } ?: "",
                target = j.pick("target", "target")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class FieldValue(
    val field: Long = 0L,
    val value: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(field == 0L)) j.put("field", field)
        if (!(value.isEmpty())) j.put("value", toBase64(value))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): FieldValue {
            return FieldValue(
                field = j.pick("field", "field")?.let { it.toString().toLong() } ?: 0L,
                value = j.pick("value", "value")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class GroupPerms(
    val sendMedia: Boolean = false,
    val sendStickers: Boolean = false,
    val sendPolls: Boolean = false,
    val sendLinks: Boolean = false,
    val invite: Boolean = false,
    val pin: Boolean = false,
    val changeInfo: Boolean = false
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(!sendMedia)) j.put("send_media", sendMedia)
        if (!(!sendStickers)) j.put("send_stickers", sendStickers)
        if (!(!sendPolls)) j.put("send_polls", sendPolls)
        if (!(!sendLinks)) j.put("send_links", sendLinks)
        if (!(!invite)) j.put("invite", invite)
        if (!(!pin)) j.put("pin", pin)
        if (!(!changeInfo)) j.put("change_info", changeInfo)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): GroupPerms {
            return GroupPerms(
                sendMedia = j.pick("send_media", "sendMedia")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                sendStickers = j.pick("send_stickers", "sendStickers")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                sendPolls = j.pick("send_polls", "sendPolls")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                sendLinks = j.pick("send_links", "sendLinks")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                invite = j.pick("invite", "invite")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                pin = j.pick("pin", "pin")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                changeInfo = j.pick("change_info", "changeInfo")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false
            )
        }
    }
}

data class GroupView(
    val group: Ref? = null,
    val kind: String = "",
    val title: String = "",
    val about: String = "",
    val photo: ViewMedia? = null,
    val membersCount: Long = 0L,
    val myRole: GroupRole = GroupRole.values()[0],
    val perms: GroupPerms? = null,
    val isPublic: Boolean = false,
    val inviteLinks: List<String> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(group == null)) j.put("group", group!!.toJson())
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(title.isEmpty())) j.put("title", title)
        if (!(about.isEmpty())) j.put("about", about)
        if (!(photo == null)) j.put("photo", photo!!.toJson())
        if (!(membersCount == 0L)) j.put("members_count", membersCount)
        if (!(myRole == GroupRole.values()[0])) j.put("my_role", myRole.name)
        if (!(perms == null)) j.put("perms", perms!!.toJson())
        if (!(!isPublic)) j.put("is_public", isPublic)
        if (inviteLinks.isNotEmpty()) j.put("invite_links", JSONArray().apply { inviteLinks.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): GroupView {
            return GroupView(
                group = j.pick("group", "group")?.let { Ref.fromJson(it as JSONObject) } ?: null,
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                title = j.pick("title", "title")?.let { it.toString() } ?: "",
                about = j.pick("about", "about")?.let { it.toString() } ?: "",
                photo = j.pick("photo", "photo")?.let { ViewMedia.fromJson(it as JSONObject) } ?: null,
                membersCount = j.pick("members_count", "membersCount")?.let { it.toString().toLong() } ?: 0L,
                myRole = j.pick("my_role", "myRole")?.let { GroupRole.fromJson(it) } ?: GroupRole.values()[0],
                perms = j.pick("perms", "perms")?.let { GroupPerms.fromJson(it as JSONObject) } ?: null,
                isPublic = j.pick("is_public", "isPublic")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                inviteLinks = (j.pick("invite_links", "inviteLinks") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList()
            )
        }
    }
}

data class HistoryPage(
    val rows: List<MessageView> = emptyList(),
    val older: MsgAnchor? = null,
    val newer: MsgAnchor? = null,
    val hasOlder: Boolean = false,
    val hasNewer: Boolean = false,
    val pending: StoreReads? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (rows.isNotEmpty()) j.put("rows", JSONArray().apply { rows.forEach { put(it.toJson()) } })
        if (!(older == null)) j.put("older", older!!.toJson())
        if (!(newer == null)) j.put("newer", newer!!.toJson())
        if (!(!hasOlder)) j.put("has_older", hasOlder)
        if (!(!hasNewer)) j.put("has_newer", hasNewer)
        if (!(pending == null)) j.put("pending", pending!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): HistoryPage {
            return HistoryPage(
                rows = (j.pick("rows", "rows") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { MessageView.fromJson(it as JSONObject) } } } ?: emptyList(),
                older = j.pick("older", "older")?.let { MsgAnchor.fromJson(it as JSONObject) } ?: null,
                newer = j.pick("newer", "newer")?.let { MsgAnchor.fromJson(it as JSONObject) } ?: null,
                hasOlder = j.pick("has_older", "hasOlder")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                hasNewer = j.pick("has_newer", "hasNewer")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                pending = j.pick("pending", "pending")?.let { StoreReads.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class HistoryPageRequest(
    val chat: Peer? = null,
    val anchor: MsgAnchor? = null,
    val direction: PageDirection = PageDirection.values()[0],
    val limit: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(anchor == null)) j.put("anchor", anchor!!.toJson())
        if (!(direction == PageDirection.values()[0])) j.put("direction", direction.name)
        if (!(limit == 0L)) j.put("limit", limit)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): HistoryPageRequest {
            return HistoryPageRequest(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                anchor = j.pick("anchor", "anchor")?.let { MsgAnchor.fromJson(it as JSONObject) } ?: null,
                direction = j.pick("direction", "direction")?.let { PageDirection.fromJson(it) } ?: PageDirection.values()[0],
                limit = j.pick("limit", "limit")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

sealed interface IntentKind {
    data class Send(val value: org.parvane.gen.IntentSend) : IntentKind
    data class Edit(val value: org.parvane.gen.IntentEdit) : IntentKind
    data class DeleteMessages(val value: org.parvane.gen.IntentDelete) : IntentKind
    data class React(val value: org.parvane.gen.IntentReact) : IntentKind
    data class Pin(val value: org.parvane.gen.IntentPin) : IntentKind
    data class Read(val value: org.parvane.gen.IntentRead) : IntentKind
    data class Typing(val value: org.parvane.gen.IntentTyping) : IntentKind
    data class StatePatch(val value: org.parvane.gen.IntentStatePatch) : IntentKind
    data class StateCreate(val value: org.parvane.gen.IntentStateCreate) : IntentKind
    data class StateDelete(val value: org.parvane.gen.IntentStateDelete) : IntentKind
    data class StateSetAdd(val value: org.parvane.gen.IntentStateSetAdd) : IntentKind
    data class StateSetRemove(val value: org.parvane.gen.IntentStateSetRemove) : IntentKind
    data class GroupCreate(val value: org.parvane.gen.IntentGroupCreate) : IntentKind
    data class GroupChange(val value: org.parvane.gen.IntentGroupChange) : IntentKind
    data class GroupJoinByLink(val value: org.parvane.gen.IntentGroupJoinByLink) : IntentKind
    data class DomainOp(val value: org.parvane.gen.IntentDomainOp) : IntentKind
    data class FaveSticker(val value: org.parvane.gen.IntentFaveSticker) : IntentKind
    data class RotateSsk(val value: org.parvane.gen.IntentRotateSsk) : IntentKind
    data class Revoke(val value: org.parvane.gen.IntentRevoke) : IntentKind
}

data class Intent(
    val kind: IntentKind? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        when (val o = kind) {
            is IntentKind.Send -> j.put("send", o.value.toJson())
            is IntentKind.Edit -> j.put("edit", o.value.toJson())
            is IntentKind.DeleteMessages -> j.put("delete_messages", o.value.toJson())
            is IntentKind.React -> j.put("react", o.value.toJson())
            is IntentKind.Pin -> j.put("pin", o.value.toJson())
            is IntentKind.Read -> j.put("read", o.value.toJson())
            is IntentKind.Typing -> j.put("typing", o.value.toJson())
            is IntentKind.StatePatch -> j.put("state_patch", o.value.toJson())
            is IntentKind.StateCreate -> j.put("state_create", o.value.toJson())
            is IntentKind.StateDelete -> j.put("state_delete", o.value.toJson())
            is IntentKind.StateSetAdd -> j.put("state_set_add", o.value.toJson())
            is IntentKind.StateSetRemove -> j.put("state_set_remove", o.value.toJson())
            is IntentKind.GroupCreate -> j.put("group_create", o.value.toJson())
            is IntentKind.GroupChange -> j.put("group_change", o.value.toJson())
            is IntentKind.GroupJoinByLink -> j.put("group_join_by_link", o.value.toJson())
            is IntentKind.DomainOp -> j.put("domain_op", o.value.toJson())
            is IntentKind.FaveSticker -> j.put("fave_sticker", o.value.toJson())
            is IntentKind.RotateSsk -> j.put("rotate_ssk", o.value.toJson())
            is IntentKind.Revoke -> j.put("revoke", o.value.toJson())
            null -> {}
        }
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Intent {
            var kind: IntentKind? = null
            j.pick("send", "send")?.let { kind = IntentKind.Send(IntentSend.fromJson(it as JSONObject)) }
            j.pick("edit", "edit")?.let { kind = IntentKind.Edit(IntentEdit.fromJson(it as JSONObject)) }
            j.pick("delete_messages", "deleteMessages")?.let { kind = IntentKind.DeleteMessages(IntentDelete.fromJson(it as JSONObject)) }
            j.pick("react", "react")?.let { kind = IntentKind.React(IntentReact.fromJson(it as JSONObject)) }
            j.pick("pin", "pin")?.let { kind = IntentKind.Pin(IntentPin.fromJson(it as JSONObject)) }
            j.pick("read", "read")?.let { kind = IntentKind.Read(IntentRead.fromJson(it as JSONObject)) }
            j.pick("typing", "typing")?.let { kind = IntentKind.Typing(IntentTyping.fromJson(it as JSONObject)) }
            j.pick("state_patch", "statePatch")?.let { kind = IntentKind.StatePatch(IntentStatePatch.fromJson(it as JSONObject)) }
            j.pick("state_create", "stateCreate")?.let { kind = IntentKind.StateCreate(IntentStateCreate.fromJson(it as JSONObject)) }
            j.pick("state_delete", "stateDelete")?.let { kind = IntentKind.StateDelete(IntentStateDelete.fromJson(it as JSONObject)) }
            j.pick("state_set_add", "stateSetAdd")?.let { kind = IntentKind.StateSetAdd(IntentStateSetAdd.fromJson(it as JSONObject)) }
            j.pick("state_set_remove", "stateSetRemove")?.let { kind = IntentKind.StateSetRemove(IntentStateSetRemove.fromJson(it as JSONObject)) }
            j.pick("group_create", "groupCreate")?.let { kind = IntentKind.GroupCreate(IntentGroupCreate.fromJson(it as JSONObject)) }
            j.pick("group_change", "groupChange")?.let { kind = IntentKind.GroupChange(IntentGroupChange.fromJson(it as JSONObject)) }
            j.pick("group_join_by_link", "groupJoinByLink")?.let { kind = IntentKind.GroupJoinByLink(IntentGroupJoinByLink.fromJson(it as JSONObject)) }
            j.pick("domain_op", "domainOp")?.let { kind = IntentKind.DomainOp(IntentDomainOp.fromJson(it as JSONObject)) }
            j.pick("fave_sticker", "faveSticker")?.let { kind = IntentKind.FaveSticker(IntentFaveSticker.fromJson(it as JSONObject)) }
            j.pick("rotate_ssk", "rotateSsk")?.let { kind = IntentKind.RotateSsk(IntentRotateSsk.fromJson(it as JSONObject)) }
            j.pick("revoke", "revoke")?.let { kind = IntentKind.Revoke(IntentRevoke.fromJson(it as JSONObject)) }
            return Intent(
                kind = kind
            )
        }
    }
}

data class IntentDelete(
    val chat: Peer? = null,
    val targets: List<ByteArray> = emptyList(),
    val scope: DeleteScope = DeleteScope.values()[0]
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (targets.isNotEmpty()) j.put("targets", JSONArray().apply { targets.forEach { put(toBase64(it)) } })
        if (!(scope == DeleteScope.values()[0])) j.put("scope", scope.name)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentDelete {
            return IntentDelete(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                targets = (j.pick("targets", "targets") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { fromBase64(it.toString()) } } } ?: emptyList(),
                scope = j.pick("scope", "scope")?.let { DeleteScope.fromJson(it) } ?: DeleteScope.values()[0]
            )
        }
    }
}

data class IntentDomainOp(
    val container: Ref? = null,
    val op: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(container == null)) j.put("container", container!!.toJson())
        if (!(op.isEmpty())) j.put("op", toBase64(op))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentDomainOp {
            return IntentDomainOp(
                container = j.pick("container", "container")?.let { Ref.fromJson(it as JSONObject) } ?: null,
                op = j.pick("op", "op")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class IntentEdit(
    val chat: Peer? = null,
    val target: ByteArray = ByteArray(0),
    val content: ComposeContent? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(target.isEmpty())) j.put("target", toBase64(target))
        if (!(content == null)) j.put("content", content!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentEdit {
            return IntentEdit(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                target = j.pick("target", "target")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                content = j.pick("content", "content")?.let { ComposeContent.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class IntentFaveSticker(
    val setId: String = "",
    val stickerId: String = "",
    val on: Boolean = false
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(setId.isEmpty())) j.put("set_id", setId)
        if (!(stickerId.isEmpty())) j.put("sticker_id", stickerId)
        if (!(!on)) j.put("on", on)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentFaveSticker {
            return IntentFaveSticker(
                setId = j.pick("set_id", "setId")?.let { it.toString() } ?: "",
                stickerId = j.pick("sticker_id", "stickerId")?.let { it.toString() } ?: "",
                on = j.pick("on", "on")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false
            )
        }
    }
}

data class IntentGroupChange(
    val group: Ref? = null,
    val change: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(group == null)) j.put("group", group!!.toJson())
        if (!(change.isEmpty())) j.put("change", toBase64(change))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentGroupChange {
            return IntentGroupChange(
                group = j.pick("group", "group")?.let { Ref.fromJson(it as JSONObject) } ?: null,
                change = j.pick("change", "change")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class IntentGroupCreate(
    val title: String = "",
    val members: List<String> = emptyList(),
    val kind: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(title.isEmpty())) j.put("title", title)
        if (members.isNotEmpty()) j.put("members", JSONArray().apply { members.forEach { put(it) } })
        if (!(kind.isEmpty())) j.put("kind", kind)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentGroupCreate {
            return IntentGroupCreate(
                title = j.pick("title", "title")?.let { it.toString() } ?: "",
                members = (j.pick("members", "members") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList(),
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class IntentGroupJoinByLink(
    val url: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(url.isEmpty())) j.put("url", url)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentGroupJoinByLink {
            return IntentGroupJoinByLink(
                url = j.pick("url", "url")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class IntentPin(
    val chat: Peer? = null,
    val target: ByteArray = ByteArray(0),
    val on: Boolean = false
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(target.isEmpty())) j.put("target", toBase64(target))
        if (!(!on)) j.put("on", on)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentPin {
            return IntentPin(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                target = j.pick("target", "target")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                on = j.pick("on", "on")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false
            )
        }
    }
}

data class IntentReact(
    val chat: Peer? = null,
    val target: ByteArray = ByteArray(0),
    val emoji: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(target.isEmpty())) j.put("target", toBase64(target))
        if (!(emoji.isEmpty())) j.put("emoji", emoji)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentReact {
            return IntentReact(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                target = j.pick("target", "target")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                emoji = j.pick("emoji", "emoji")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class IntentRead(
    val chat: Peer? = null,
    val upTo: MsgAnchor? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(upTo == null)) j.put("up_to", upTo!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentRead {
            return IntentRead(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                upTo = j.pick("up_to", "upTo")?.let { MsgAnchor.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class IntentRevoke(
    val deviceId: String = "",
    val stolen: Boolean = false
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(deviceId.isEmpty())) j.put("device_id", deviceId)
        if (!(!stolen)) j.put("stolen", stolen)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentRevoke {
            return IntentRevoke(
                deviceId = j.pick("device_id", "deviceId")?.let { it.toString() } ?: "",
                stolen = j.pick("stolen", "stolen")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false
            )
        }
    }
}

data class IntentRotateSsk(
    val rootSecret: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(rootSecret.isEmpty())) j.put("root_secret", toBase64(rootSecret))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentRotateSsk {
            return IntentRotateSsk(
                rootSecret = j.pick("root_secret", "rootSecret")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class IntentSend(
    val chat: Peer? = null,
    val content: ComposeContent? = null,
    val scheduleAtMs: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(content == null)) j.put("content", content!!.toJson())
        if (!(scheduleAtMs == 0L)) j.put("schedule_at_ms", scheduleAtMs.toString())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentSend {
            return IntentSend(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                content = j.pick("content", "content")?.let { ComposeContent.fromJson(it as JSONObject) } ?: null,
                scheduleAtMs = j.pick("schedule_at_ms", "scheduleAtMs")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class IntentStateCreate(
    val `object`: ObjectKey? = null,
    val set: List<FieldValue> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(`object` == null)) j.put("object", `object`!!.toJson())
        if (set.isNotEmpty()) j.put("set", JSONArray().apply { set.forEach { put(it.toJson()) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentStateCreate {
            return IntentStateCreate(
                `object` = j.pick("object", "object")?.let { ObjectKey.fromJson(it as JSONObject) } ?: null,
                set = (j.pick("set", "set") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { FieldValue.fromJson(it as JSONObject) } } } ?: emptyList()
            )
        }
    }
}

data class IntentStateDelete(
    val `object`: ObjectKey? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(`object` == null)) j.put("object", `object`!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentStateDelete {
            return IntentStateDelete(
                `object` = j.pick("object", "object")?.let { ObjectKey.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class IntentStatePatch(
    val `object`: ObjectKey? = null,
    val set: List<FieldValue> = emptyList(),
    val clear: List<Long> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(`object` == null)) j.put("object", `object`!!.toJson())
        if (set.isNotEmpty()) j.put("set", JSONArray().apply { set.forEach { put(it.toJson()) } })
        if (clear.isNotEmpty()) j.put("clear", JSONArray().apply { clear.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentStatePatch {
            return IntentStatePatch(
                `object` = j.pick("object", "object")?.let { ObjectKey.fromJson(it as JSONObject) } ?: null,
                set = (j.pick("set", "set") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { FieldValue.fromJson(it as JSONObject) } } } ?: emptyList(),
                clear = (j.pick("clear", "clear") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString().toLong() } } } ?: emptyList()
            )
        }
    }
}

data class IntentStateSetAdd(
    val `object`: ObjectKey? = null,
    val field: Long = 0L,
    val element: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(`object` == null)) j.put("object", `object`!!.toJson())
        if (!(field == 0L)) j.put("field", field)
        if (!(element.isEmpty())) j.put("element", toBase64(element))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentStateSetAdd {
            return IntentStateSetAdd(
                `object` = j.pick("object", "object")?.let { ObjectKey.fromJson(it as JSONObject) } ?: null,
                field = j.pick("field", "field")?.let { it.toString().toLong() } ?: 0L,
                element = j.pick("element", "element")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class IntentStateSetRemove(
    val `object`: ObjectKey? = null,
    val field: Long = 0L,
    val element: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(`object` == null)) j.put("object", `object`!!.toJson())
        if (!(field == 0L)) j.put("field", field)
        if (!(element.isEmpty())) j.put("element", toBase64(element))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentStateSetRemove {
            return IntentStateSetRemove(
                `object` = j.pick("object", "object")?.let { ObjectKey.fromJson(it as JSONObject) } ?: null,
                field = j.pick("field", "field")?.let { it.toString().toLong() } ?: 0L,
                element = j.pick("element", "element")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class IntentTyping(
    val chat: Peer? = null,
    val action: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(action.isEmpty())) j.put("action", action)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): IntentTyping {
            return IntentTyping(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                action = j.pick("action", "action")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class JournalState(
    val journal: String = "",
    val cursor: Long = 0L,
    val head: Long = 0L,
    val write: JournalWrite = JournalWrite.values()[0]
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(journal.isEmpty())) j.put("journal", journal)
        if (!(cursor == 0L)) j.put("cursor", cursor.toString())
        if (!(head == 0L)) j.put("head", head.toString())
        if (!(write == JournalWrite.values()[0])) j.put("write", write.name)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): JournalState {
            return JournalState(
                journal = j.pick("journal", "journal")?.let { it.toString() } ?: "",
                cursor = j.pick("cursor", "cursor")?.let { it.toString().toLong() } ?: 0L,
                head = j.pick("head", "head")?.let { it.toString().toLong() } ?: 0L,
                write = j.pick("write", "write")?.let { JournalWrite.fromJson(it) } ?: JournalWrite.values()[0]
            )
        }
    }
}

data class KindFormat(
    val kind: String = "",
    val format: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(format == 0L)) j.put("format", format)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): KindFormat {
            return KindFormat(
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                format = j.pick("format", "format")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class LegacyRecord(
    val key: String = "",
    val value: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(key.isEmpty())) j.put("key", key)
        if (!(value.isEmpty())) j.put("value", toBase64(value))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): LegacyRecord {
            return LegacyRecord(
                key = j.pick("key", "key")?.let { it.toString() } ?: "",
                value = j.pick("value", "value")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class MarkValue(
    val field: Long = 0L,
    val value: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(field == 0L)) j.put("field", field)
        if (!(value.isEmpty())) j.put("value", toBase64(value))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MarkValue {
            return MarkValue(
                field = j.pick("field", "field")?.let { it.toString().toLong() } ?: 0L,
                value = j.pick("value", "value")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class MessageRemove(
    val chat: Peer? = null,
    val id: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(id.isEmpty())) j.put("id", toBase64(id))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MessageRemove {
            return MessageRemove(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                id = j.pick("id", "id")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class MessageView(
    val id: ByteArray = ByteArray(0),
    val chat: Peer? = null,
    val from: String = "",
    val tsMs: Long = 0L,
    val editedTsMs: Long = 0L,
    val outgoing: Boolean = false,
    val disposition: Disposition = Disposition.values()[0],
    val body: ViewBody? = null,
    val replyTo: ByteArray = ByteArray(0),
    val forwardFrom: String = "",
    val reactions: List<ViewReaction> = emptyList(),
    val pinned: Boolean = false,
    val ttlSecs: Long = 0L,
    val delivery: Delivery = Delivery.values()[0],
    val forwardName: String = "",
    val replyQuote: ViewText? = null,
    val silent: Boolean = false,
    val order: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(id.isEmpty())) j.put("id", toBase64(id))
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(from.isEmpty())) j.put("from", from)
        if (!(tsMs == 0L)) j.put("ts_ms", tsMs.toString())
        if (!(editedTsMs == 0L)) j.put("edited_ts_ms", editedTsMs.toString())
        if (!(!outgoing)) j.put("outgoing", outgoing)
        if (!(disposition == Disposition.values()[0])) j.put("disposition", disposition.name)
        if (!(body == null)) j.put("body", body!!.toJson())
        if (!(replyTo.isEmpty())) j.put("reply_to", toBase64(replyTo))
        if (!(forwardFrom.isEmpty())) j.put("forward_from", forwardFrom)
        if (reactions.isNotEmpty()) j.put("reactions", JSONArray().apply { reactions.forEach { put(it.toJson()) } })
        if (!(!pinned)) j.put("pinned", pinned)
        if (!(ttlSecs == 0L)) j.put("ttl_secs", ttlSecs)
        if (!(delivery == Delivery.values()[0])) j.put("delivery", delivery.name)
        if (!(forwardName.isEmpty())) j.put("forward_name", forwardName)
        if (!(replyQuote == null)) j.put("reply_quote", replyQuote!!.toJson())
        if (!(!silent)) j.put("silent", silent)
        if (!(order == 0L)) j.put("order", order.toString())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MessageView {
            return MessageView(
                id = j.pick("id", "id")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                from = j.pick("from", "from")?.let { it.toString() } ?: "",
                tsMs = j.pick("ts_ms", "tsMs")?.let { it.toString().toLong() } ?: 0L,
                editedTsMs = j.pick("edited_ts_ms", "editedTsMs")?.let { it.toString().toLong() } ?: 0L,
                outgoing = j.pick("outgoing", "outgoing")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                disposition = j.pick("disposition", "disposition")?.let { Disposition.fromJson(it) } ?: Disposition.values()[0],
                body = j.pick("body", "body")?.let { ViewBody.fromJson(it as JSONObject) } ?: null,
                replyTo = j.pick("reply_to", "replyTo")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                forwardFrom = j.pick("forward_from", "forwardFrom")?.let { it.toString() } ?: "",
                reactions = (j.pick("reactions", "reactions") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { ViewReaction.fromJson(it as JSONObject) } } } ?: emptyList(),
                pinned = j.pick("pinned", "pinned")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                ttlSecs = j.pick("ttl_secs", "ttlSecs")?.let { it.toString().toLong() } ?: 0L,
                delivery = j.pick("delivery", "delivery")?.let { Delivery.fromJson(it) } ?: Delivery.values()[0],
                forwardName = j.pick("forward_name", "forwardName")?.let { it.toString() } ?: "",
                replyQuote = j.pick("reply_quote", "replyQuote")?.let { ViewText.fromJson(it as JSONObject) } ?: null,
                silent = j.pick("silent", "silent")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                order = j.pick("order", "order")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class MigrateStatus(
    val point: Long = 0L,
    val done: Boolean = false,
    val reportJson: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(point == 0L)) j.put("point", point)
        if (!(!done)) j.put("done", done)
        if (!(reportJson.isEmpty())) j.put("report_json", reportJson)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MigrateStatus {
            return MigrateStatus(
                point = j.pick("point", "point")?.let { it.toString().toLong() } ?: 0L,
                done = j.pick("done", "done")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                reportJson = j.pick("report_json", "reportJson")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class MigrateStep(
    val layer: String = "",
    val records: List<LegacyRecord> = emptyList(),
    val last: Boolean = false,
    val chunk: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(layer.isEmpty())) j.put("layer", layer)
        if (records.isNotEmpty()) j.put("records", JSONArray().apply { records.forEach { put(it.toJson()) } })
        if (!(!last)) j.put("last", last)
        if (!(chunk == 0L)) j.put("chunk", chunk)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MigrateStep {
            return MigrateStep(
                layer = j.pick("layer", "layer")?.let { it.toString() } ?: "",
                records = (j.pick("records", "records") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { LegacyRecord.fromJson(it as JSONObject) } } } ?: emptyList(),
                last = j.pick("last", "last")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                chunk = j.pick("chunk", "chunk")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class MigrationPlan(
    val steps: List<String> = emptyList(),
    val legacyRecords: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (steps.isNotEmpty()) j.put("steps", JSONArray().apply { steps.forEach { put(it) } })
        if (!(legacyRecords == 0L)) j.put("legacy_records", legacyRecords.toString())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MigrationPlan {
            return MigrationPlan(
                steps = (j.pick("steps", "steps") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList(),
                legacyRecords = j.pick("legacy_records", "legacyRecords")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class MigrationProgress(
    val fromGeneration: Long = 0L,
    val toGeneration: Long = 0L,
    val point: Long = 0L,
    val errors: List<String> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(fromGeneration == 0L)) j.put("from_generation", fromGeneration)
        if (!(toGeneration == 0L)) j.put("to_generation", toGeneration)
        if (!(point == 0L)) j.put("point", point)
        if (errors.isNotEmpty()) j.put("errors", JSONArray().apply { errors.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MigrationProgress {
            return MigrationProgress(
                fromGeneration = j.pick("from_generation", "fromGeneration")?.let { it.toString().toLong() } ?: 0L,
                toGeneration = j.pick("to_generation", "toGeneration")?.let { it.toString().toLong() } ?: 0L,
                point = j.pick("point", "point")?.let { it.toString().toLong() } ?: 0L,
                errors = (j.pick("errors", "errors") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList()
            )
        }
    }
}

sealed interface ModelChangeChange {
    data class ChatUpsert(val value: org.parvane.gen.ChatView) : ModelChangeChange
    data class ChatRemove(val value: org.parvane.gen.Peer) : ModelChangeChange
    data class MessageUpsert(val value: org.parvane.gen.MessageView) : ModelChangeChange
    data class MessageRemove(val value: org.parvane.gen.MessageRemove) : ModelChangeChange
    data class StateChanged(val value: org.parvane.gen.StateChanged) : ModelChangeChange
    data class GroupChanged(val value: org.parvane.gen.GroupView) : ModelChangeChange
    data class Notice(val value: org.parvane.gen.Notice) : ModelChangeChange
    data class UnreadChanged(val value: org.parvane.gen.UnreadChanged) : ModelChangeChange
    data class WriteBlocked(val value: org.parvane.gen.WriteBlocked) : ModelChangeChange
    data class Needs(val value: org.parvane.gen.Need) : ModelChangeChange
    data class ClientEvents(val value: org.parvane.gen.ClientEvents) : ModelChangeChange
}

data class ModelChange(
    val change: ModelChangeChange? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        when (val o = change) {
            is ModelChangeChange.ChatUpsert -> j.put("chat_upsert", o.value.toJson())
            is ModelChangeChange.ChatRemove -> j.put("chat_remove", o.value.toJson())
            is ModelChangeChange.MessageUpsert -> j.put("message_upsert", o.value.toJson())
            is ModelChangeChange.MessageRemove -> j.put("message_remove", o.value.toJson())
            is ModelChangeChange.StateChanged -> j.put("state_changed", o.value.toJson())
            is ModelChangeChange.GroupChanged -> j.put("group_changed", o.value.toJson())
            is ModelChangeChange.Notice -> j.put("notice", o.value.toJson())
            is ModelChangeChange.UnreadChanged -> j.put("unread_changed", o.value.toJson())
            is ModelChangeChange.WriteBlocked -> j.put("write_blocked", o.value.toJson())
            is ModelChangeChange.Needs -> j.put("needs", o.value.toJson())
            is ModelChangeChange.ClientEvents -> j.put("client_events", o.value.toJson())
            null -> {}
        }
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ModelChange {
            var change: ModelChangeChange? = null
            j.pick("chat_upsert", "chatUpsert")?.let { change = ModelChangeChange.ChatUpsert(ChatView.fromJson(it as JSONObject)) }
            j.pick("chat_remove", "chatRemove")?.let { change = ModelChangeChange.ChatRemove(Peer.fromJson(it as JSONObject)) }
            j.pick("message_upsert", "messageUpsert")?.let { change = ModelChangeChange.MessageUpsert(MessageView.fromJson(it as JSONObject)) }
            j.pick("message_remove", "messageRemove")?.let { change = ModelChangeChange.MessageRemove(MessageRemove.fromJson(it as JSONObject)) }
            j.pick("state_changed", "stateChanged")?.let { change = ModelChangeChange.StateChanged(StateChanged.fromJson(it as JSONObject)) }
            j.pick("group_changed", "groupChanged")?.let { change = ModelChangeChange.GroupChanged(GroupView.fromJson(it as JSONObject)) }
            j.pick("notice", "notice")?.let { change = ModelChangeChange.Notice(Notice.fromJson(it as JSONObject)) }
            j.pick("unread_changed", "unreadChanged")?.let { change = ModelChangeChange.UnreadChanged(UnreadChanged.fromJson(it as JSONObject)) }
            j.pick("write_blocked", "writeBlocked")?.let { change = ModelChangeChange.WriteBlocked(WriteBlocked.fromJson(it as JSONObject)) }
            j.pick("needs", "needs")?.let { change = ModelChangeChange.Needs(Need.fromJson(it as JSONObject)) }
            j.pick("client_events", "clientEvents")?.let { change = ModelChangeChange.ClientEvents(ClientEvents.fromJson(it as JSONObject)) }
            return ModelChange(
                change = change
            )
        }
    }
}

data class ModelDelta(
    val revision: Long = 0L,
    val changes: List<ModelChange> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(revision == 0L)) j.put("revision", revision.toString())
        if (changes.isNotEmpty()) j.put("changes", JSONArray().apply { changes.forEach { put(it.toJson()) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ModelDelta {
            return ModelDelta(
                revision = j.pick("revision", "revision")?.let { it.toString().toLong() } ?: 0L,
                changes = (j.pick("changes", "changes") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { ModelChange.fromJson(it as JSONObject) } } } ?: emptyList()
            )
        }
    }
}

data class MsgAnchor(
    val tsMs: Long = 0L,
    val id: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(tsMs == 0L)) j.put("ts_ms", tsMs.toString())
        if (!(id.isEmpty())) j.put("id", toBase64(id))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): MsgAnchor {
            return MsgAnchor(
                tsMs = j.pick("ts_ms", "tsMs")?.let { it.toString().toLong() } ?: 0L,
                id = j.pick("id", "id")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class Need(
    val kind: String = "",
    val chat: Peer? = null,
    val detail: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(detail.isEmpty())) j.put("detail", detail)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Need {
            return Need(
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                detail = j.pick("detail", "detail")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class Notice(
    val chat: Peer? = null,
    val kind: String = "",
    val detail: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(detail.isEmpty())) j.put("detail", detail)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Notice {
            return Notice(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                detail = j.pick("detail", "detail")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ObjectKey(
    val kind: ObjectKind = ObjectKind.values()[0],
    val key: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(kind == ObjectKind.values()[0])) j.put("kind", kind.name)
        if (!(key.isEmpty())) j.put("key", key)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ObjectKey {
            return ObjectKey(
                kind = j.pick("kind", "kind")?.let { ObjectKind.fromJson(it) } ?: ObjectKind.values()[0],
                key = j.pick("key", "key")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class OpenResult(
    val state: OpenState = OpenState.values()[0],
    val migration: MigrationPlan? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(state == OpenState.values()[0])) j.put("state", state.name)
        if (!(migration == null)) j.put("migration", migration!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): OpenResult {
            return OpenResult(
                state = j.pick("state", "state")?.let { OpenState.fromJson(it) } ?: OpenState.values()[0],
                migration = j.pick("migration", "migration")?.let { MigrationPlan.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class OutRequest(
    val reqId: Long = 0L,
    val method: String = "",
    val channel: RequestChannel = RequestChannel.values()[0],
    val body: ByteArray = ByteArray(0),
    val deadlineMs: Long = 0L,
    val destDomain: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(reqId == 0L)) j.put("req_id", reqId.toString())
        if (!(method.isEmpty())) j.put("method", method)
        if (!(channel == RequestChannel.values()[0])) j.put("channel", channel.name)
        if (!(body.isEmpty())) j.put("body", toBase64(body))
        if (!(deadlineMs == 0L)) j.put("deadline_ms", deadlineMs.toString())
        if (!(destDomain.isEmpty())) j.put("dest_domain", destDomain)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): OutRequest {
            return OutRequest(
                reqId = j.pick("req_id", "reqId")?.let { it.toString().toLong() } ?: 0L,
                method = j.pick("method", "method")?.let { it.toString() } ?: "",
                channel = j.pick("channel", "channel")?.let { RequestChannel.fromJson(it) } ?: RequestChannel.values()[0],
                body = j.pick("body", "body")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                deadlineMs = j.pick("deadline_ms", "deadlineMs")?.let { it.toString().toLong() } ?: 0L,
                destDomain = j.pick("dest_domain", "destDomain")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class Outcome(
    val storeBatch: StoreBatch? = null,
    val storeReads: List<StoreReads> = emptyList(),
    val requests: List<OutRequest> = emptyList(),
    val delta: ModelDelta? = null,
    val open: OpenResult? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(storeBatch == null)) j.put("store_batch", storeBatch!!.toJson())
        if (storeReads.isNotEmpty()) j.put("store_reads", JSONArray().apply { storeReads.forEach { put(it.toJson()) } })
        if (requests.isNotEmpty()) j.put("requests", JSONArray().apply { requests.forEach { put(it.toJson()) } })
        if (!(delta == null)) j.put("delta", delta!!.toJson())
        if (!(open == null)) j.put("open", open!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Outcome {
            return Outcome(
                storeBatch = j.pick("store_batch", "storeBatch")?.let { StoreBatch.fromJson(it as JSONObject) } ?: null,
                storeReads = (j.pick("store_reads", "storeReads") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { StoreReads.fromJson(it as JSONObject) } } } ?: emptyList(),
                requests = (j.pick("requests", "requests") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { OutRequest.fromJson(it as JSONObject) } } } ?: emptyList(),
                delta = j.pick("delta", "delta")?.let { ModelDelta.fromJson(it as JSONObject) } ?: null,
                open = j.pick("open", "open")?.let { OpenResult.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

sealed interface PeerKind {
    data class User(val value: org.parvane.gen.UserRef) : PeerKind
    data class Group(val value: org.parvane.gen.Ref) : PeerKind
}

data class Peer(
    val kind: PeerKind? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        when (val o = kind) {
            is PeerKind.User -> j.put("user", o.value.toJson())
            is PeerKind.Group -> j.put("group", o.value.toJson())
            null -> {}
        }
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Peer {
            var kind: PeerKind? = null
            j.pick("user", "user")?.let { kind = PeerKind.User(UserRef.fromJson(it as JSONObject)) }
            j.pick("group", "group")?.let { kind = PeerKind.Group(Ref.fromJson(it as JSONObject)) }
            return Peer(
                kind = kind
            )
        }
    }
}

data class PinWrap(
    val salt: ByteArray = ByteArray(0),
    val iterations: Long = 0L,
    val wrappedDek: ByteArray = ByteArray(0),
    val check: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(salt.isEmpty())) j.put("salt", toBase64(salt))
        if (!(iterations == 0L)) j.put("iterations", iterations)
        if (!(wrappedDek.isEmpty())) j.put("wrapped_dek", toBase64(wrappedDek))
        if (!(check.isEmpty())) j.put("check", toBase64(check))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): PinWrap {
            return PinWrap(
                salt = j.pick("salt", "salt")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                iterations = j.pick("iterations", "iterations")?.let { it.toString().toLong() } ?: 0L,
                wrappedDek = j.pick("wrapped_dek", "wrappedDek")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                check = j.pick("check", "check")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class RangeHold(
    val journal: String = "",
    val fromSeq: Long = 0L,
    val toSeq: Long = 0L,
    val paths: List<String> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(journal.isEmpty())) j.put("journal", journal)
        if (!(fromSeq == 0L)) j.put("from_seq", fromSeq.toString())
        if (!(toSeq == 0L)) j.put("to_seq", toSeq.toString())
        if (paths.isNotEmpty()) j.put("paths", JSONArray().apply { paths.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): RangeHold {
            return RangeHold(
                journal = j.pick("journal", "journal")?.let { it.toString() } ?: "",
                fromSeq = j.pick("from_seq", "fromSeq")?.let { it.toString().toLong() } ?: 0L,
                toSeq = j.pick("to_seq", "toSeq")?.let { it.toString().toLong() } ?: 0L,
                paths = (j.pick("paths", "paths") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList()
            )
        }
    }
}

data class RangeHolds(
    val holds: List<RangeHold> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (holds.isNotEmpty()) j.put("holds", JSONArray().apply { holds.forEach { put(it.toJson()) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): RangeHolds {
            return RangeHolds(
                holds = (j.pick("holds", "holds") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { RangeHold.fromJson(it as JSONObject) } } } ?: emptyList()
            )
        }
    }
}

data class Ref(
    val domain: String = "",
    val id: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(domain.isEmpty())) j.put("domain", domain)
        if (!(id.isEmpty())) j.put("id", toBase64(id))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Ref {
            return Ref(
                domain = j.pick("domain", "domain")?.let { it.toString() } ?: "",
                id = j.pick("id", "id")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class Root(
    val storeId: ByteArray = ByteArray(0),
    val activeGeneration: Long = 0L,
    val pendingGeneration: Long = 0L,
    val wraps: List<Wrap> = emptyList(),
    val kindsMaxFormat: List<KindFormat> = emptyList(),
    val retiringGeneration: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(storeId.isEmpty())) j.put("store_id", toBase64(storeId))
        if (!(activeGeneration == 0L)) j.put("active_generation", activeGeneration)
        if (!(pendingGeneration == 0L)) j.put("pending_generation", pendingGeneration)
        if (wraps.isNotEmpty()) j.put("wraps", JSONArray().apply { wraps.forEach { put(it.toJson()) } })
        if (kindsMaxFormat.isNotEmpty()) j.put("kinds_max_format", JSONArray().apply { kindsMaxFormat.forEach { put(it.toJson()) } })
        if (!(retiringGeneration == 0L)) j.put("retiring_generation", retiringGeneration)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Root {
            return Root(
                storeId = j.pick("store_id", "storeId")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                activeGeneration = j.pick("active_generation", "activeGeneration")?.let { it.toString().toLong() } ?: 0L,
                pendingGeneration = j.pick("pending_generation", "pendingGeneration")?.let { it.toString().toLong() } ?: 0L,
                wraps = (j.pick("wraps", "wraps") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { Wrap.fromJson(it as JSONObject) } } } ?: emptyList(),
                kindsMaxFormat = (j.pick("kinds_max_format", "kindsMaxFormat") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { KindFormat.fromJson(it as JSONObject) } } } ?: emptyList(),
                retiringGeneration = j.pick("retiring_generation", "retiringGeneration")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class ServerInput(
    val kind: ServerInputKind = ServerInputKind.values()[0],
    val method: String = "",
    val reqId: Long = 0L,
    val body: ByteArray = ByteArray(0),
    val error: Int = 0
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(kind == ServerInputKind.values()[0])) j.put("kind", kind.name)
        if (!(method.isEmpty())) j.put("method", method)
        if (!(reqId == 0L)) j.put("req_id", reqId.toString())
        if (!(body.isEmpty())) j.put("body", toBase64(body))
        if (!(error == 0)) j.put("error", error)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ServerInput {
            return ServerInput(
                kind = j.pick("kind", "kind")?.let { ServerInputKind.fromJson(it) } ?: ServerInputKind.values()[0],
                method = j.pick("method", "method")?.let { it.toString() } ?: "",
                reqId = j.pick("req_id", "reqId")?.let { it.toString().toLong() } ?: 0L,
                body = j.pick("body", "body")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                error = j.pick("error", "error")?.let { it.toString().toInt() } ?: 0
            )
        }
    }
}

data class StateChanged(
    val `object`: ObjectKey? = null,
    val view: StateObjectView? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(`object` == null)) j.put("object", `object`!!.toJson())
        if (!(view == null)) j.put("view", view!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StateChanged {
            return StateChanged(
                `object` = j.pick("object", "object")?.let { ObjectKey.fromJson(it as JSONObject) } ?: null,
                view = j.pick("view", "view")?.let { StateObjectView.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class StateObjectView(
    val `object`: ObjectKey? = null,
    val fields: List<FieldValue> = emptyList(),
    val marks: List<MarkValue> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(`object` == null)) j.put("object", `object`!!.toJson())
        if (fields.isNotEmpty()) j.put("fields", JSONArray().apply { fields.forEach { put(it.toJson()) } })
        if (marks.isNotEmpty()) j.put("marks", JSONArray().apply { marks.forEach { put(it.toJson()) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StateObjectView {
            return StateObjectView(
                `object` = j.pick("object", "object")?.let { ObjectKey.fromJson(it as JSONObject) } ?: null,
                fields = (j.pick("fields", "fields") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { FieldValue.fromJson(it as JSONObject) } } } ?: emptyList(),
                marks = (j.pick("marks", "marks") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { MarkValue.fromJson(it as JSONObject) } } } ?: emptyList()
            )
        }
    }
}

data class StateView(
    val objects: List<StateObjectView> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (objects.isNotEmpty()) j.put("objects", JSONArray().apply { objects.forEach { put(it.toJson()) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StateView {
            return StateView(
                objects = (j.pick("objects", "objects") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { StateObjectView.fromJson(it as JSONObject) } } } ?: emptyList()
            )
        }
    }
}

data class StorageFormat(
    val kind: String = "",
    val format: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(format == 0L)) j.put("format", format)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StorageFormat {
            return StorageFormat(
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                format = j.pick("format", "format")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class StoreBatch(
    val batchId: Long = 0L,
    val puts: List<StorePut> = emptyList(),
    val deletes: List<String> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(batchId == 0L)) j.put("batch_id", batchId.toString())
        if (puts.isNotEmpty()) j.put("puts", JSONArray().apply { puts.forEach { put(it.toJson()) } })
        if (deletes.isNotEmpty()) j.put("deletes", JSONArray().apply { deletes.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StoreBatch {
            return StoreBatch(
                batchId = j.pick("batch_id", "batchId")?.let { it.toString().toLong() } ?: 0L,
                puts = (j.pick("puts", "puts") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { StorePut.fromJson(it as JSONObject) } } } ?: emptyList(),
                deletes = (j.pick("deletes", "deletes") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList()
            )
        }
    }
}

data class StoreCommitted(
    val batchId: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(batchId == 0L)) j.put("batch_id", batchId.toString())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StoreCommitted {
            return StoreCommitted(
                batchId = j.pick("batch_id", "batchId")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class StoreLoaded(
    val readId: Long = 0L,
    val entries: List<StorePut> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(readId == 0L)) j.put("read_id", readId.toString())
        if (entries.isNotEmpty()) j.put("entries", JSONArray().apply { entries.forEach { put(it.toJson()) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StoreLoaded {
            return StoreLoaded(
                readId = j.pick("read_id", "readId")?.let { it.toString().toLong() } ?: 0L,
                entries = (j.pick("entries", "entries") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { StorePut.fromJson(it as JSONObject) } } } ?: emptyList()
            )
        }
    }
}

data class StorePut(
    val key: String = "",
    val value: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(key.isEmpty())) j.put("key", key)
        if (!(value.isEmpty())) j.put("value", toBase64(value))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StorePut {
            return StorePut(
                key = j.pick("key", "key")?.let { it.toString() } ?: "",
                value = j.pick("value", "value")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class StoreReads(
    val readId: Long = 0L,
    val keys: List<String> = emptyList(),
    val prefix: String = "",
    val after: String = "",
    val limit: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(readId == 0L)) j.put("read_id", readId.toString())
        if (keys.isNotEmpty()) j.put("keys", JSONArray().apply { keys.forEach { put(it) } })
        if (!(prefix.isEmpty())) j.put("prefix", prefix)
        if (!(after.isEmpty())) j.put("after", after)
        if (!(limit == 0L)) j.put("limit", limit)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): StoreReads {
            return StoreReads(
                readId = j.pick("read_id", "readId")?.let { it.toString().toLong() } ?: 0L,
                keys = (j.pick("keys", "keys") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList(),
                prefix = j.pick("prefix", "prefix")?.let { it.toString() } ?: "",
                after = j.pick("after", "after")?.let { it.toString() } ?: "",
                limit = j.pick("limit", "limit")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class Stored(
    val format: Long = 0L,
    val kind: String = "",
    val generation: Long = 0L,
    val payload: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(format == 0L)) j.put("format", format)
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(generation == 0L)) j.put("generation", generation)
        if (!(payload.isEmpty())) j.put("payload", toBase64(payload))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Stored {
            return Stored(
                format = j.pick("format", "format")?.let { it.toString().toLong() } ?: 0L,
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                generation = j.pick("generation", "generation")?.let { it.toString().toLong() } ?: 0L,
                payload = j.pick("payload", "payload")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class Tick(
    val nowMs: Long = 0L
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(nowMs == 0L)) j.put("now_ms", nowMs.toString())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Tick {
            return Tick(
                nowMs = j.pick("now_ms", "nowMs")?.let { it.toString().toLong() } ?: 0L
            )
        }
    }
}

data class UnlockPin(
    val pin: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(pin.isEmpty())) j.put("pin", pin)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): UnlockPin {
            return UnlockPin(
                pin = j.pick("pin", "pin")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class UnreadChanged(
    val chat: Peer? = null,
    val count: Long = 0L,
    val mention: Boolean = false
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(chat == null)) j.put("chat", chat!!.toJson())
        if (!(count == 0L)) j.put("count", count)
        if (!(!mention)) j.put("mention", mention)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): UnreadChanged {
            return UnreadChanged(
                chat = j.pick("chat", "chat")?.let { Peer.fromJson(it as JSONObject) } ?: null,
                count = j.pick("count", "count")?.let { it.toString().toLong() } ?: 0L,
                mention = j.pick("mention", "mention")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false
            )
        }
    }
}

data class UserRef(
    val address: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(address.isEmpty())) j.put("address", address)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): UserRef {
            return UserRef(
                address = j.pick("address", "address")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ViewArticle(
    val title: String = "",
    val markdown: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(title.isEmpty())) j.put("title", title)
        if (!(markdown.isEmpty())) j.put("markdown", markdown)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewArticle {
            return ViewArticle(
                title = j.pick("title", "title")?.let { it.toString() } ?: "",
                markdown = j.pick("markdown", "markdown")?.let { it.toString() } ?: ""
            )
        }
    }
}

sealed interface ViewBodyKind {
    data class Text(val value: org.parvane.gen.ViewText) : ViewBodyKind
    data class Media(val value: org.parvane.gen.ViewMedia) : ViewBodyKind
    data class Sticker(val value: org.parvane.gen.ViewSticker) : ViewBodyKind
    data class Poll(val value: org.parvane.gen.ViewPoll) : ViewBodyKind
    data class Location(val value: org.parvane.gen.ViewLocation) : ViewBodyKind
    data class Contact(val value: org.parvane.gen.ViewContact) : ViewBodyKind
    data class Call(val value: org.parvane.gen.ViewCall) : ViewBodyKind
    data class TaskOffer(val value: org.parvane.gen.ViewTaskOffer) : ViewBodyKind
    data class Article(val value: org.parvane.gen.ViewArticle) : ViewBodyKind
    data class CloudInvite(val value: org.parvane.gen.ViewCloudInvite) : ViewBodyKind
    data class Service(val value: org.parvane.gen.ViewService) : ViewBodyKind
}

data class ViewBody(
    val kind: ViewBodyKind? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        when (val o = kind) {
            is ViewBodyKind.Text -> j.put("text", o.value.toJson())
            is ViewBodyKind.Media -> j.put("media", o.value.toJson())
            is ViewBodyKind.Sticker -> j.put("sticker", o.value.toJson())
            is ViewBodyKind.Poll -> j.put("poll", o.value.toJson())
            is ViewBodyKind.Location -> j.put("location", o.value.toJson())
            is ViewBodyKind.Contact -> j.put("contact", o.value.toJson())
            is ViewBodyKind.Call -> j.put("call", o.value.toJson())
            is ViewBodyKind.TaskOffer -> j.put("task_offer", o.value.toJson())
            is ViewBodyKind.Article -> j.put("article", o.value.toJson())
            is ViewBodyKind.CloudInvite -> j.put("cloud_invite", o.value.toJson())
            is ViewBodyKind.Service -> j.put("service", o.value.toJson())
            null -> {}
        }
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewBody {
            var kind: ViewBodyKind? = null
            j.pick("text", "text")?.let { kind = ViewBodyKind.Text(ViewText.fromJson(it as JSONObject)) }
            j.pick("media", "media")?.let { kind = ViewBodyKind.Media(ViewMedia.fromJson(it as JSONObject)) }
            j.pick("sticker", "sticker")?.let { kind = ViewBodyKind.Sticker(ViewSticker.fromJson(it as JSONObject)) }
            j.pick("poll", "poll")?.let { kind = ViewBodyKind.Poll(ViewPoll.fromJson(it as JSONObject)) }
            j.pick("location", "location")?.let { kind = ViewBodyKind.Location(ViewLocation.fromJson(it as JSONObject)) }
            j.pick("contact", "contact")?.let { kind = ViewBodyKind.Contact(ViewContact.fromJson(it as JSONObject)) }
            j.pick("call", "call")?.let { kind = ViewBodyKind.Call(ViewCall.fromJson(it as JSONObject)) }
            j.pick("task_offer", "taskOffer")?.let { kind = ViewBodyKind.TaskOffer(ViewTaskOffer.fromJson(it as JSONObject)) }
            j.pick("article", "article")?.let { kind = ViewBodyKind.Article(ViewArticle.fromJson(it as JSONObject)) }
            j.pick("cloud_invite", "cloudInvite")?.let { kind = ViewBodyKind.CloudInvite(ViewCloudInvite.fromJson(it as JSONObject)) }
            j.pick("service", "service")?.let { kind = ViewBodyKind.Service(ViewService.fromJson(it as JSONObject)) }
            return ViewBody(
                kind = kind
            )
        }
    }
}

data class ViewCall(
    val video: Boolean = false,
    val outgoing: Boolean = false,
    val durationS: Long = 0L,
    val reason: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(!video)) j.put("video", video)
        if (!(!outgoing)) j.put("outgoing", outgoing)
        if (!(durationS == 0L)) j.put("duration_s", durationS)
        if (!(reason.isEmpty())) j.put("reason", reason)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewCall {
            return ViewCall(
                video = j.pick("video", "video")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                outgoing = j.pick("outgoing", "outgoing")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                durationS = j.pick("duration_s", "durationS")?.let { it.toString().toLong() } ?: 0L,
                reason = j.pick("reason", "reason")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ViewCloudInvite(
    val title: String = "",
    val owner: String = "",
    val role: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(title.isEmpty())) j.put("title", title)
        if (!(owner.isEmpty())) j.put("owner", owner)
        if (!(role.isEmpty())) j.put("role", role)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewCloudInvite {
            return ViewCloudInvite(
                title = j.pick("title", "title")?.let { it.toString() } ?: "",
                owner = j.pick("owner", "owner")?.let { it.toString() } ?: "",
                role = j.pick("role", "role")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ViewContact(
    val user: String = "",
    val firstName: String = "",
    val lastName: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(user.isEmpty())) j.put("user", user)
        if (!(firstName.isEmpty())) j.put("first_name", firstName)
        if (!(lastName.isEmpty())) j.put("last_name", lastName)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewContact {
            return ViewContact(
                user = j.pick("user", "user")?.let { it.toString() } ?: "",
                firstName = j.pick("first_name", "firstName")?.let { it.toString() } ?: "",
                lastName = j.pick("last_name", "lastName")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ViewEntity(
    val type: String = "",
    val offset: Long = 0L,
    val length: Long = 0L,
    val url: String = "",
    val user: String = "",
    val language: String = "",
    val customEmojiId: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(type.isEmpty())) j.put("type", type)
        if (!(offset == 0L)) j.put("offset", offset)
        if (!(length == 0L)) j.put("length", length)
        if (!(url.isEmpty())) j.put("url", url)
        if (!(user.isEmpty())) j.put("user", user)
        if (!(language.isEmpty())) j.put("language", language)
        if (!(customEmojiId.isEmpty())) j.put("custom_emoji_id", customEmojiId)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewEntity {
            return ViewEntity(
                type = j.pick("type", "type")?.let { it.toString() } ?: "",
                offset = j.pick("offset", "offset")?.let { it.toString().toLong() } ?: 0L,
                length = j.pick("length", "length")?.let { it.toString().toLong() } ?: 0L,
                url = j.pick("url", "url")?.let { it.toString() } ?: "",
                user = j.pick("user", "user")?.let { it.toString() } ?: "",
                language = j.pick("language", "language")?.let { it.toString() } ?: "",
                customEmojiId = j.pick("custom_emoji_id", "customEmojiId")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ViewGroupRequest(
    val group: Ref? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(group == null)) j.put("group", group!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewGroupRequest {
            return ViewGroupRequest(
                group = j.pick("group", "group")?.let { Ref.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class ViewLocation(
    val lat: Double = 0.0,
    val lon: Double = 0.0,
    val title: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(lat == 0.0)) j.put("lat", lat)
        if (!(lon == 0.0)) j.put("lon", lon)
        if (!(title.isEmpty())) j.put("title", title)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewLocation {
            return ViewLocation(
                lat = j.pick("lat", "lat")?.let { it.toString().toDouble() } ?: 0.0,
                lon = j.pick("lon", "lon")?.let { it.toString().toDouble() } ?: 0.0,
                title = j.pick("title", "title")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ViewMedia(
    val kind: String = "",
    val fileId: String = "",
    val blobDomain: String = "",
    val key: ByteArray = ByteArray(0),
    val nonce: ByteArray = ByteArray(0),
    val capability: ByteArray = ByteArray(0),
    val mime: String = "",
    val name: String = "",
    val size: Long = 0L,
    val width: Long = 0L,
    val height: Long = 0L,
    val durationS: Long = 0L,
    val thumb: ByteArray = ByteArray(0),
    val caption: ViewText? = null,
    val spoiler: Boolean = false,
    val captionAbove: Boolean = false,
    val waveform: ByteArray = ByteArray(0),
    val albumId: ByteArray = ByteArray(0),
    val title: String = "",
    val performer: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(fileId.isEmpty())) j.put("file_id", fileId)
        if (!(blobDomain.isEmpty())) j.put("blob_domain", blobDomain)
        if (!(key.isEmpty())) j.put("key", toBase64(key))
        if (!(nonce.isEmpty())) j.put("nonce", toBase64(nonce))
        if (!(capability.isEmpty())) j.put("capability", toBase64(capability))
        if (!(mime.isEmpty())) j.put("mime", mime)
        if (!(name.isEmpty())) j.put("name", name)
        if (!(size == 0L)) j.put("size", size.toString())
        if (!(width == 0L)) j.put("width", width)
        if (!(height == 0L)) j.put("height", height)
        if (!(durationS == 0L)) j.put("duration_s", durationS)
        if (!(thumb.isEmpty())) j.put("thumb", toBase64(thumb))
        if (!(caption == null)) j.put("caption", caption!!.toJson())
        if (!(!spoiler)) j.put("spoiler", spoiler)
        if (!(!captionAbove)) j.put("caption_above", captionAbove)
        if (!(waveform.isEmpty())) j.put("waveform", toBase64(waveform))
        if (!(albumId.isEmpty())) j.put("album_id", toBase64(albumId))
        if (!(title.isEmpty())) j.put("title", title)
        if (!(performer.isEmpty())) j.put("performer", performer)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewMedia {
            return ViewMedia(
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                fileId = j.pick("file_id", "fileId")?.let { it.toString() } ?: "",
                blobDomain = j.pick("blob_domain", "blobDomain")?.let { it.toString() } ?: "",
                key = j.pick("key", "key")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                nonce = j.pick("nonce", "nonce")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                capability = j.pick("capability", "capability")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                mime = j.pick("mime", "mime")?.let { it.toString() } ?: "",
                name = j.pick("name", "name")?.let { it.toString() } ?: "",
                size = j.pick("size", "size")?.let { it.toString().toLong() } ?: 0L,
                width = j.pick("width", "width")?.let { it.toString().toLong() } ?: 0L,
                height = j.pick("height", "height")?.let { it.toString().toLong() } ?: 0L,
                durationS = j.pick("duration_s", "durationS")?.let { it.toString().toLong() } ?: 0L,
                thumb = j.pick("thumb", "thumb")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                caption = j.pick("caption", "caption")?.let { ViewText.fromJson(it as JSONObject) } ?: null,
                spoiler = j.pick("spoiler", "spoiler")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                captionAbove = j.pick("caption_above", "captionAbove")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                waveform = j.pick("waveform", "waveform")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                albumId = j.pick("album_id", "albumId")?.let { fromBase64(it.toString()) } ?: ByteArray(0),
                title = j.pick("title", "title")?.let { it.toString() } ?: "",
                performer = j.pick("performer", "performer")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ViewPoll(
    val question: String = "",
    val options: List<String> = emptyList(),
    val multiple: Boolean = false,
    val quiz: Boolean = false,
    val myVotes: List<Long> = emptyList(),
    val votes: List<Long> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(question.isEmpty())) j.put("question", question)
        if (options.isNotEmpty()) j.put("options", JSONArray().apply { options.forEach { put(it) } })
        if (!(!multiple)) j.put("multiple", multiple)
        if (!(!quiz)) j.put("quiz", quiz)
        if (myVotes.isNotEmpty()) j.put("my_votes", JSONArray().apply { myVotes.forEach { put(it) } })
        if (votes.isNotEmpty()) j.put("votes", JSONArray().apply { votes.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewPoll {
            return ViewPoll(
                question = j.pick("question", "question")?.let { it.toString() } ?: "",
                options = (j.pick("options", "options") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList(),
                multiple = j.pick("multiple", "multiple")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                quiz = j.pick("quiz", "quiz")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false,
                myVotes = (j.pick("my_votes", "myVotes") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString().toLong() } } } ?: emptyList(),
                votes = (j.pick("votes", "votes") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString().toLong() } } } ?: emptyList()
            )
        }
    }
}

data class ViewReaction(
    val emoji: String = "",
    val count: Long = 0L,
    val mine: Boolean = false
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(emoji.isEmpty())) j.put("emoji", emoji)
        if (!(count == 0L)) j.put("count", count)
        if (!(!mine)) j.put("mine", mine)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewReaction {
            return ViewReaction(
                emoji = j.pick("emoji", "emoji")?.let { it.toString() } ?: "",
                count = j.pick("count", "count")?.let { it.toString().toLong() } ?: 0L,
                mine = j.pick("mine", "mine")?.let { (it as? Boolean ?: it.toString().toBoolean()) } ?: false
            )
        }
    }
}

data class ViewService(
    val kind: String = "",
    val actor: String = "",
    val targets: List<String> = emptyList(),
    val text: String = ""
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(kind.isEmpty())) j.put("kind", kind)
        if (!(actor.isEmpty())) j.put("actor", actor)
        if (targets.isNotEmpty()) j.put("targets", JSONArray().apply { targets.forEach { put(it) } })
        if (!(text.isEmpty())) j.put("text", text)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewService {
            return ViewService(
                kind = j.pick("kind", "kind")?.let { it.toString() } ?: "",
                actor = j.pick("actor", "actor")?.let { it.toString() } ?: "",
                targets = (j.pick("targets", "targets") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList(),
                text = j.pick("text", "text")?.let { it.toString() } ?: ""
            )
        }
    }
}

data class ViewStateRequest(
    val kinds: List<String> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (kinds.isNotEmpty()) j.put("kinds", JSONArray().apply { kinds.forEach { put(it) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewStateRequest {
            return ViewStateRequest(
                kinds = (j.pick("kinds", "kinds") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { it.toString() } } } ?: emptyList()
            )
        }
    }
}

data class ViewSticker(
    val pack: String = "",
    val stickerId: String = "",
    val emoji: String = "",
    val media: ViewMedia? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(pack.isEmpty())) j.put("pack", pack)
        if (!(stickerId.isEmpty())) j.put("sticker_id", stickerId)
        if (!(emoji.isEmpty())) j.put("emoji", emoji)
        if (!(media == null)) j.put("media", media!!.toJson())
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewSticker {
            return ViewSticker(
                pack = j.pick("pack", "pack")?.let { it.toString() } ?: "",
                stickerId = j.pick("sticker_id", "stickerId")?.let { it.toString() } ?: "",
                emoji = j.pick("emoji", "emoji")?.let { it.toString() } ?: "",
                media = j.pick("media", "media")?.let { ViewMedia.fromJson(it as JSONObject) } ?: null
            )
        }
    }
}

data class ViewTaskOffer(
    val title: String = "",
    val text: String = "",
    val taskId: ByteArray = ByteArray(0)
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(title.isEmpty())) j.put("title", title)
        if (!(text.isEmpty())) j.put("text", text)
        if (!(taskId.isEmpty())) j.put("task_id", toBase64(taskId))
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewTaskOffer {
            return ViewTaskOffer(
                title = j.pick("title", "title")?.let { it.toString() } ?: "",
                text = j.pick("text", "text")?.let { it.toString() } ?: "",
                taskId = j.pick("task_id", "taskId")?.let { fromBase64(it.toString()) } ?: ByteArray(0)
            )
        }
    }
}

data class ViewText(
    val text: String = "",
    val entities: List<ViewEntity> = emptyList()
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(text.isEmpty())) j.put("text", text)
        if (entities.isNotEmpty()) j.put("entities", JSONArray().apply { entities.forEach { put(it.toJson()) } })
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): ViewText {
            return ViewText(
                text = j.pick("text", "text")?.let { it.toString() } ?: "",
                entities = (j.pick("entities", "entities") as? JSONArray)?.let { a -> (0 until a.length()).map { i -> a.get(i).let { ViewEntity.fromJson(it as JSONObject) } } } ?: emptyList()
            )
        }
    }
}

sealed interface WrapKind {
    data class Device(val value: org.parvane.gen.DeviceWrap) : WrapKind
    data class Pin(val value: org.parvane.gen.PinWrap) : WrapKind
}

data class Wrap(
    val generation: Long = 0L,
    val kind: WrapKind? = null
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(generation == 0L)) j.put("generation", generation)
        when (val o = kind) {
            is WrapKind.Device -> j.put("device", o.value.toJson())
            is WrapKind.Pin -> j.put("pin", o.value.toJson())
            null -> {}
        }
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): Wrap {
            var kind: WrapKind? = null
            j.pick("device", "device")?.let { kind = WrapKind.Device(DeviceWrap.fromJson(it as JSONObject)) }
            j.pick("pin", "pin")?.let { kind = WrapKind.Pin(PinWrap.fromJson(it as JSONObject)) }
            return Wrap(
                generation = j.pick("generation", "generation")?.let { it.toString().toLong() } ?: 0L,
                kind = kind
            )
        }
    }
}

data class WriteBlocked(
    val journal: String = "",
    val reason: JournalWrite = JournalWrite.values()[0]
) {
    fun toJson(): JSONObject {
        val j = JSONObject()
        if (!(journal.isEmpty())) j.put("journal", journal)
        if (!(reason == JournalWrite.values()[0])) j.put("reason", reason.name)
        return j
    }

    companion object {
        fun fromJson(j: JSONObject): WriteBlocked {
            return WriteBlocked(
                journal = j.pick("journal", "journal")?.let { it.toString() } ?: "",
                reason = j.pick("reason", "reason")?.let { JournalWrite.fromJson(it) } ?: JournalWrite.values()[0]
            )
        }
    }
}

