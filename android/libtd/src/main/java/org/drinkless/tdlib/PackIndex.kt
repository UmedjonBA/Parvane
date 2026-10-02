package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * spec 005: локальный индекс паков стикеров/эмодзи (`packs.json` в каталоге
 * ядра) и их представление для панели Telegram X. Чистый JVM-класс: файлы —
 * через [dir], без Android API. Паки: встроенные (builtin), полученные из
 * `pack_ref`/`emoji_packs` (received — известны имя/ссылка, файлов может ещё не
 * быть), установленные (installed — файлы распакованы в `packs/<sanitized>/`),
 * архивные. Один и тот же пак у разных отправителей с одним именем —
 * различается сырым именем (rawName) как на web (`<name>⁣<from>` не
 * применяем: сырое имя и есть ключ docId по EMOJI-1).
 */
class PackIndex(private val dir: File) {
    data class PackFile(val name: String, val mime: String, val width: Int, val height: Int, val emoji: String, val docId: Long) {
        fun toJson(): JSONObject = JSONObject().put("name", name).put("mime", mime).put("width", width).put("height", height).put("emoji", emoji).put("docId", docId)
        companion object {
            fun fromJson(o: JSONObject) = PackFile(o.optString("name"), o.optString("mime"), o.optInt("width", 512), o.optInt("height", 512), o.optString("emoji", "🙂"), o.optLong("docId"))
        }
    }

    class Pack(
        val setId: Long,
        val name: String,        // sanitized — каталог и короткое имя набора
        val rawName: String,     // как на проводе (ключ docId, EMOJI-1)
        val isEmoji: Boolean,
        var builtin: Boolean = false,
        var installed: Boolean = false,
        var archived: Boolean = false,
        var ref: JSONObject? = null,   // pack_ref/emoji_packs (для повторной подачи и скачивания)
        var files: List<PackFile> = emptyList(),
        var dirPath: String = "",
    ) {
        val materialized get() = files.isNotEmpty() && dirPath.isNotEmpty()
        fun toJson(): JSONObject = JSONObject().put("setId", setId).put("name", name).put("rawName", rawName).put("isEmoji", isEmoji)
            .put("builtin", builtin).put("installed", installed).put("archived", archived).put("ref", ref ?: JSONObject.NULL)
            .put("files", JSONArray().also { a -> files.forEach { a.put(it.toJson()) } }).put("dir", dirPath)
        companion object {
            fun fromJson(o: JSONObject): Pack {
                val files = ArrayList<PackFile>()
                o.optJSONArray("files")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { files.add(PackFile.fromJson(it)) } }
                return Pack(o.optLong("setId"), o.optString("name"), o.optString("rawName"), o.optBoolean("isEmoji"),
                    o.optBoolean("builtin"), o.optBoolean("installed"), o.optBoolean("archived"),
                    if (o.isNull("ref")) null else o.optJSONObject("ref"), files, o.optString("dir"))
            }
        }
    }

    private val packs = LinkedHashMap<Long, Pack>()
    private val indexFile get() = File(dir, "packs.json")

    init { load() }

    @Synchronized fun all(): List<Pack> = packs.values.toList()
    @Synchronized fun bySetId(id: Long): Pack? = packs[id]
    @Synchronized fun byRawName(rawName: String, isEmoji: Boolean): Pack? = packs.values.firstOrNull { it.rawName == rawName && it.isEmoji == isEmoji }
    @Synchronized fun byFileId(fileId: String): Pack? = packs.values.firstOrNull { it.ref?.optString("file_id") == fileId }
    /** Наборы для панели: сначала встроенные, потом установленные (не архивные) нужного типа. */
    @Synchronized fun installed(isEmoji: Boolean): List<Pack> =
        packs.values.filter { it.isEmoji == isEmoji && it.installed && !it.archived }.sortedByDescending { it.builtin }
    @Synchronized fun archived(isEmoji: Boolean): List<Pack> = packs.values.filter { it.isEmoji == isEmoji && it.archived }

    /** Эмодзи по docId среди всех паков (и не установленных — файл может ещё не быть скачан). */
    @Synchronized fun emojiByDocId(docId: Long): Pair<Pack, PackFile>? {
        for (p in packs.values) if (p.isEmoji) p.files.firstOrNull { it.docId == docId }?.let { return p to it }
        return null
    }
    /** Пак эмодзи, содержащий docId, для `emoji_packs` при отправке. */
    @Synchronized fun emojiPackOf(docId: Long): Pack? = emojiByDocId(docId)?.first

    /** Зарегистрировать пак из ссылки провода (получен, файлов ещё нет). Возвращает пак. */
    @Synchronized fun registerReceived(ref: JSONObject, isEmoji: Boolean): Pack {
        val raw = ref.optString("name").ifEmpty { "Pack" }
        val existing = byRawName(raw, isEmoji)
        if (existing != null) { if (existing.ref == null) existing.ref = ref; save(); return existing }
        val sanitized = EmojiDocId.sanitizeName(raw)
        val setId = if (isEmoji) EmojiDocId.emojiSetId(raw) else EmojiDocId.packSetId(sanitized)
        val p = Pack(setId, sanitized, raw, isEmoji, ref = ref)
        packs[setId] = p; save(); return p
    }

    /** Файлы распакованы (или нарисованы) в каталог: заполнить список, посчитать docId, при install — установить. */
    @Synchronized fun materialize(p: Pack, dirPath: String, names: List<String>, sizes: Map<String, Pair<Int, Int>> = emptyMap(), install: Boolean): Pack {
        val files = names.filter { EmojiDocId.isAllowedName(it) }.sorted().map { n ->
            val (w, h) = sizes[n] ?: (512 to 512)
            PackFile(n, EmojiDocId.mimeForName(n), w, h, EmojiDocId.altEmojiForFileName(n), if (p.isEmoji) EmojiDocId.emojiDocId(p.rawName, n) else 0L)
        }
        p.files = files; p.dirPath = dirPath
        if (install) { p.installed = true; p.archived = false }
        save(); return p
    }

    @Synchronized fun addBuiltin(rawName: String, isEmoji: Boolean, dirPath: String, names: List<String>, size: Int): Pack {
        val sanitized = EmojiDocId.sanitizeName(rawName)
        val setId = if (isEmoji) EmojiDocId.emojiSetId(rawName) else EmojiDocId.packSetId(sanitized)
        val p = packs.getOrPut(setId) { Pack(setId, sanitized, rawName, isEmoji) }
        p.builtin = true
        materialize(p, dirPath, names, names.associateWith { size to size }, install = true)
        return p
    }

    /** ChangeStickerSet: установка/удаление/архив. Встроенный удалить нельзя (false). */
    @Synchronized fun change(setId: Long, isInstalled: Boolean, isArchived: Boolean): Boolean {
        val p = packs[setId] ?: return false
        if (p.builtin && (!isInstalled || isArchived)) return false
        p.installed = isInstalled; p.archived = isArchived && isInstalled
        save(); return true
    }

    @Synchronized fun installedIds(isEmoji: Boolean): LongArray = installed(isEmoji).map { it.setId }.toLongArray()

    private fun load() {
        val f = indexFile
        if (!f.exists()) return
        val arr = try { JSONArray(SeamFiles.read(f)) } catch (e: Exception) { return }
        for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { val p = Pack.fromJson(it); packs[p.setId] = p }
    }
    private fun save() {
        try {
            dir.mkdirs()
            SeamFiles.write(indexFile, JSONArray().also { a -> packs.values.forEach { a.put(it.toJson()) } }.toString())
        } catch (e: Exception) { /* диск недоступен — индекс живёт в памяти до следующей записи */ }
    }

    companion object {
        /** TdApi.StickerFormat по mime — X роняет `Td.unsupported` на null. */
        fun formatFor(mime: String): TdApi.StickerFormat = when (mime) {
            "application/x-tgsticker" -> TdApi.StickerFormatTgs()
            "video/webm" -> TdApi.StickerFormatWebm()
            else -> TdApi.StickerFormatWebp() // webp и png — обычный загрузчик картинок X
        }
        fun thumbnailFormatFor(mime: String): TdApi.ThumbnailFormat = when (mime) {
            "image/png" -> TdApi.ThumbnailFormatPng()
            "application/x-tgsticker" -> TdApi.ThumbnailFormatTgs()
            "video/webm" -> TdApi.ThumbnailFormatWebm()
            else -> TdApi.ThumbnailFormatWebp()
        }

        /** Sticker для панели/сообщения. [file] — TdApi.File с локальным путём (или без него, пока не скачан). */
        fun toSticker(p: Pack, f: PackFile, file: TdApi.File): TdApi.Sticker {
            val fullType: TdApi.StickerFullType = if (p.isEmoji) TdApi.StickerFullTypeCustomEmoji(f.docId, false) else TdApi.StickerFullTypeRegular(null)
            return TdApi.Sticker(file.id.toLong(), p.setId, f.width, f.height, f.emoji, formatFor(f.mime), fullType,
                TdApi.Thumbnail(thumbnailFormatFor(f.mime), f.width, f.height, file), file)
        }

        fun stickerType(isEmoji: Boolean): TdApi.StickerType = if (isEmoji) TdApi.StickerTypeCustomEmoji() else TdApi.StickerTypeRegular()

        fun toStickerSet(p: Pack, stickers: Array<TdApi.Sticker>): TdApi.StickerSet =
            TdApi.StickerSet(p.setId, p.rawName, p.name, stickers.firstOrNull()?.thumbnail, null, false, p.installed, p.archived, p.builtin,
                stickerType(p.isEmoji), false, false, true, stickers, stickers.map { TdApi.Emojis(arrayOf(it.emoji)) }.toTypedArray())

        fun toInfo(p: Pack, covers: Array<TdApi.Sticker>): TdApi.StickerSetInfo =
            TdApi.StickerSetInfo(p.setId, p.rawName, p.name, covers.firstOrNull()?.thumbnail, null, false, p.installed, p.archived, p.builtin,
                stickerType(p.isEmoji), false, false, true, p.files.size, covers)
    }
}
