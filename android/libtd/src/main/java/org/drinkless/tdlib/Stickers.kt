package org.drinkless.tdlib

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneCore
import java.io.File

/**
 * spec 005 / история 1: стикеры, GIF и кастом-эмодзи для штатной панели Telegram X.
 * Данные — [PackIndex] (`packs.json`) и `stickers-state.json` (недавние/избранные/
 * сохранённые GIF, ≤50 как web). Файлы паков — `packs/<sanitized>/`; архивы
 * присланных паков скачиваются ядром по `pack_ref` (PACK-1) при первом обращении
 * панели (`GetStickerSet`/`GetCustomEmojiStickers`/установка). Без Android API,
 * кроме логов: JVM-тестируемо с фейковым [core].
 */
class Stickers(
    private val store: ParvaneStore,
    private val root: File,
    private val post: (TdApi.Update) -> Unit,
    private val core: Core = RealCore,
) {
    /** Мост к ядру (подменяется в JVM-тестах). */
    interface Core {
        fun packFetch(refJson: String): JSONObject
        fun packRefFor(dir: String, rawName: String, recipients: List<String>): JSONObject
    }
    object RealCore : Core {
        override fun packFetch(refJson: String) = ParvaneCore.packFetch(refJson)
        override fun packRefFor(dir: String, rawName: String, recipients: List<String>) = ParvaneCore.packRefFor(dir, rawName, recipients)
    }

    val index = PackIndex(root)
    private val stateFile = File(root, "stickers-state.json")
    private val recent = ArrayList<String>()     // "setId:name"
    private val favorite = ArrayList<String>()
    private val savedGifs = ArrayList<JSONObject>() // {file_id,key,nonce,width,height,duration_secs,mime,size_bytes,filename}
    private val fileKeyByTdId = HashMap<Int, Pair<Long, String>>()

    init { loadState() }

    fun ensureBuiltin(): Boolean = BuiltinPacks.ensure(root, index)

    // ── файлы/объекты ──────────────────────────────────────────────────────
    private fun fileOf(p: PackIndex.Pack, f: PackIndex.PackFile): TdApi.File {
        val local = if (p.dirPath.isNotEmpty()) File(p.dirPath, f.name) else null
        val path = if (local != null && local.exists()) local.absolutePath else ""
        val size = if (path.isNotEmpty()) local!!.length() else 0L
        val file = store.fileFor("pack:${p.setId}:${f.name}", "", "", size, f.mime, path)
        fileKeyByTdId[file.id] = p.setId to f.name
        return file
    }
    fun sticker(p: PackIndex.Pack, f: PackIndex.PackFile): TdApi.Sticker = PackIndex.toSticker(p, f, fileOf(p, f))
    private fun stickersOf(p: PackIndex.Pack): Array<TdApi.Sticker> = p.files.map { sticker(p, it) }.toTypedArray()
    private fun key(p: PackIndex.Pack, f: PackIndex.PackFile) = "${p.setId}:${f.name}"
    private fun byKey(k: String): Pair<PackIndex.Pack, PackIndex.PackFile>? {
        val setId = k.substringBefore(':').toLongOrNull() ?: return null
        val p = index.bySetId(setId) ?: return null
        val f = p.files.firstOrNull { it.name == k.substringAfter(':') } ?: return null
        return p to f
    }

    /** Пак материализован (файлы на диске)? Иначе — скачать архив ядром по ссылке. */
    @Synchronized private fun ensureMaterialized(p: PackIndex.Pack): Boolean {
        if (p.materialized && File(p.dirPath).isDirectory) return true
        val ref = p.ref ?: return false
        val r = try { core.packFetch(ref.toString()) } catch (e: Throwable) { JSONObject().put("error", e.message) }
        if (!r.optBoolean("ok")) { Log.w(TAG, "пак ${p.rawName}: не скачан (${r.optString("error")})"); return false }
        val names = ArrayList<String>()
        r.optJSONArray("files")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.optString("name")?.let { names.add(it) } }
        index.materialize(p, r.optString("dir"), names, install = false)
        Log.i(TAG, "пак ${p.rawName} материализован: ${names.size} файлов")
        return names.isNotEmpty()
    }

    // ── панель X ───────────────────────────────────────────────────────────
    private fun isEmoji(type: TdApi.StickerType?) = type is TdApi.StickerTypeCustomEmoji

    fun installedSets(type: TdApi.StickerType?): TdApi.StickerSets {
        val packs = index.installed(isEmoji(type)).filter { it.materialized }
        return TdApi.StickerSets(packs.size, packs.map { PackIndex.toInfo(it, stickersOf(it)) }.toTypedArray())
    }
    fun archivedSets(type: TdApi.StickerType?): TdApi.StickerSets {
        val packs = index.archived(isEmoji(type)).filter { it.materialized }
        return TdApi.StickerSets(packs.size, packs.map { PackIndex.toInfo(it, stickersOf(it)) }.toTypedArray())
    }
    fun stickerSet(setId: Long): TdApi.Object {
        val p = index.bySetId(setId) ?: return TdApi.Error(404, "sticker set not found")
        if (!ensureMaterialized(p)) return TdApi.Error(404, "sticker set not available")
        return PackIndex.toStickerSet(p, stickersOf(p))
    }
    fun searchSet(name: String?): TdApi.Object {
        val p = index.all().firstOrNull { it.name.equals(name ?: "", true) || it.rawName == name } ?: return TdApi.Error(404, "sticker set not found")
        return stickerSet(p.setId)
    }
    /** Стикеры по эмодзи среди установленных (пустой запрос — все). */
    fun stickersByEmoji(type: TdApi.StickerType?, query: String?, limit: Int): TdApi.Stickers {
        val q = (query ?: "").trim()
        val out = ArrayList<TdApi.Sticker>()
        for (p in index.installed(isEmoji(type)).filter { it.materialized }) for (f in p.files) {
            if (q.isEmpty() || f.emoji == q || q.contains(f.emoji)) out.add(sticker(p, f))
            if (limit > 0 && out.size >= limit) break
        }
        return TdApi.Stickers(out.toTypedArray())
    }
    fun customEmoji(ids: LongArray?): TdApi.Stickers {
        val out = ArrayList<TdApi.Sticker>()
        for (id in ids ?: LongArray(0)) {
            // docId ищется по файлам распакованных паков: полученный из emoji_packs пак (registerReceived,
            // files пуст) сначала материализуется — иначе эмодзи молча пропускалось (27 сен 2026)
            var hit = index.emojiByDocId(id)
            if (hit == null) {
                for (p in index.all().filter { it.isEmoji && !it.materialized && it.ref != null }) ensureMaterialized(p)
                hit = index.emojiByDocId(id)
            }
            val (p, f) = hit ?: run { Log.w(TAG, "эмодзи $id: пак не найден"); null } ?: continue
            if (!ensureMaterialized(p)) continue
            out.add(sticker(p, f))
            Log.i(TAG, "эмодзи $id → ${p.name}/${f.name}")
        }
        return TdApi.Stickers(out.toTypedArray())
    }
    fun change(setId: Long, isInstalled: Boolean, isArchived: Boolean): TdApi.Object {
        val p = index.bySetId(setId) ?: return TdApi.Error(404, "sticker set not found")
        if (isInstalled && !ensureMaterialized(p)) return TdApi.Error(400, "pack not available")
        if (!index.change(setId, isInstalled, isArchived)) return TdApi.Error(400, "builtin pack cannot be removed")
        Log.i(TAG, "пак ${p.rawName} ${if (isInstalled && !isArchived) "установлен: ${p.files.size} ${if (p.isEmoji) "эмодзи" else "стикеров"}" else if (isArchived) "в архиве" else "удалён"}")
        post(TdApi.UpdateInstalledStickerSets(PackIndex.stickerType(p.isEmoji), index.installedIds(p.isEmoji)))
        return TdApi.Ok()
    }

    // ── недавние / избранные ───────────────────────────────────────────────
    fun favorites(): TdApi.Stickers = TdApi.Stickers(favorite.mapNotNull { byKey(it) }.map { sticker(it.first, it.second) }.toTypedArray())
    fun recents(): TdApi.Stickers = TdApi.Stickers(recent.mapNotNull { byKey(it) }.map { sticker(it.first, it.second) }.toTypedArray())
    fun noteRecent(p: PackIndex.Pack, f: PackIndex.PackFile) {
        val k = key(p, f); recent.remove(k); recent.add(0, k); while (recent.size > 20) recent.removeAt(recent.size - 1)
        saveState(); post(TdApi.UpdateRecentStickers(false, recents().stickers.map { it.id.toInt() }.toIntArray()))
    }
    fun addFavorite(input: TdApi.InputFile?): TdApi.Object {
        val r = resolveInput(input) ?: return TdApi.Error(404, "sticker not found")
        val k = key(r.pack, r.file); favorite.remove(k); favorite.add(0, k); saveState()
        post(TdApi.UpdateFavoriteStickers(favorites().stickers.map { it.id.toInt() }.toIntArray())); return TdApi.Ok()
    }
    fun removeFavorite(input: TdApi.InputFile?): TdApi.Object {
        val r = resolveInput(input) ?: return TdApi.Error(404, "sticker not found")
        favorite.remove(key(r.pack, r.file)); saveState()
        post(TdApi.UpdateFavoriteStickers(favorites().stickers.map { it.id.toInt() }.toIntArray())); return TdApi.Ok()
    }
    fun removeRecent(input: TdApi.InputFile?): TdApi.Object {
        val r = resolveInput(input) ?: return TdApi.Error(404, "sticker not found")
        recent.remove(key(r.pack, r.file)); saveState()
        post(TdApi.UpdateRecentStickers(false, recents().stickers.map { it.id.toInt() }.toIntArray())); return TdApi.Ok()
    }

    // ── GIF (сохранённые, ≤50 как web) ─────────────────────────────────────
    fun savedAnimations(): TdApi.Animations = TdApi.Animations(savedGifs.map { animationOf(it) }.toTypedArray())
    private fun animationOf(g: JSONObject): TdApi.Animation {
        val f = store.fileFor(g.optString("file_id"), g.optString("key"), g.optString("nonce"), g.optLong("size_bytes"), g.optString("mime", "video/webm"), g.optString("local_path"))
        return TdApi.Animation(g.optInt("duration_secs", 1), g.optInt("width", 240), g.optInt("height", 240), g.optString("filename", "animation.webm"),
            g.optString("mime", "video/webm"), false, null, null, f)
    }
    /** Принятый gif → в сохранённые (как web rememberSavedGif). */
    fun noteReceivedGif(content: JSONObject) {
        val fid = content.optString("file_id"); if (fid.isEmpty() || savedGifs.any { it.optString("file_id") == fid }) return
        savedGifs.add(0, JSONObject().put("file_id", fid).put("key", content.optString("file_key")).put("nonce", content.optString("file_nonce"))
            .put("width", content.optInt("width", 240)).put("height", content.optInt("height", 240)).put("duration_secs", content.optInt("duration_secs", 1))
            .put("mime", content.optString("mime", "video/webm")).put("size_bytes", content.optLong("size_bytes")).put("filename", content.optString("filename", "animation.webm")))
        while (savedGifs.size > 50) savedGifs.removeAt(savedGifs.size - 1)
        saveState(); post(TdApi.UpdateSavedAnimations(savedAnimations().animations.map { it.animation.id }.toIntArray()))
    }
    fun addSavedAnimation(input: TdApi.InputFile?): TdApi.Object {
        val id = (input as? TdApi.InputFileId)?.id ?: return TdApi.Error(400, "unsupported input")
        val ref = store.fileRef(id) ?: return TdApi.Error(404, "file not found")
        if (savedGifs.none { it.optString("file_id") == ref.remoteId }) {
            savedGifs.add(0, JSONObject().put("file_id", ref.remoteId).put("key", ref.key).put("nonce", ref.nonce).put("mime", ref.mime).put("size_bytes", ref.size).put("local_path", ref.path))
            while (savedGifs.size > 50) savedGifs.removeAt(savedGifs.size - 1)
            saveState()
        }
        post(TdApi.UpdateSavedAnimations(savedAnimations().animations.map { it.animation.id }.toIntArray())); return TdApi.Ok()
    }
    fun removeSavedAnimation(input: TdApi.InputFile?): TdApi.Object {
        val id = (input as? TdApi.InputFileId)?.id ?: return TdApi.Error(400, "unsupported input")
        val ref = store.fileRef(id) ?: return TdApi.Error(404, "file not found")
        savedGifs.removeAll { it.optString("file_id") == ref.remoteId }; saveState()
        post(TdApi.UpdateSavedAnimations(savedAnimations().animations.map { it.animation.id }.toIntArray())); return TdApi.Ok()
    }

    // ── отправка ───────────────────────────────────────────────────────────
    /** Стикер по InputFile X: InputFileId (из панели) или локальный путь внутри каталога пака. */
    class Resolved(val pack: PackIndex.Pack, val file: PackIndex.PackFile) {
        val path: String get() = File(pack.dirPath, file.name).absolutePath
    }
    fun resolveInput(input: TdApi.InputFile?): Resolved? {
        when (input) {
            is TdApi.InputFileId -> {
                val key = fileKeyByTdId[input.id] ?: return null
                val p = index.bySetId(key.first) ?: return null
                val f = p.files.firstOrNull { it.name == key.second } ?: return null
                return Resolved(p, f)
            }
            is TdApi.InputFileLocal -> {
                val path = input.path ?: return null
                val p = index.all().firstOrNull { it.dirPath.isNotEmpty() && path.startsWith(it.dirPath) } ?: return null
                val f = p.files.firstOrNull { File(p.dirPath, it.name).absolutePath == path } ?: return null
                return Resolved(p, f)
            }
            else -> return null
        }
    }
    /** pack_ref для отправки стикера/эмодзи не из встроенного пака (PACK-1: по получателям). */
    fun packRefForSend(p: PackIndex.Pack, recipients: List<String>): JSONObject? {
        if (p.builtin || p.dirPath.isEmpty()) return null
        val r = try { core.packRefFor(p.dirPath, p.rawName, recipients) } catch (e: Throwable) { JSONObject().put("error", e.message) }
        if (r.has("error") || !r.has("file_id")) { Log.w(TAG, "пак ${p.rawName}: ссылка не получена (${r.optString("error")})"); return null }
        if (p.ref == null) { p.ref = r; index.change(p.setId, p.installed, p.archived) }
        return r
    }
    /** `emoji_packs` (≤4) для текста с кастом-эмодзи по docId. */
    fun emojiPacksFor(docIds: List<Long>, recipients: List<String>): JSONArray? {
        val packs = LinkedHashMap<Long, PackIndex.Pack>()
        for (id in docIds) index.emojiPackOf(id)?.let { packs[it.setId] = it }
        val out = JSONArray()
        for (p in packs.values.take(4)) {
            val ref = if (p.builtin) packRefForBuiltin(p, recipients) else packRefForSend(p, recipients)
            if (ref != null) out.put(ref)
        }
        return if (out.length() == 0) null else out
    }
    /** Встроенный эмодзи-пак тоже едет как pack_ref — у получателя без такого пака он материализуется (как desktop ParvaneEmoji). */
    private fun packRefForBuiltin(p: PackIndex.Pack, recipients: List<String>): JSONObject? {
        val r = try { core.packRefFor(p.dirPath, p.rawName, recipients) } catch (e: Throwable) { return null }
        return if (r.has("file_id")) r else null
    }

    // ── приём ──────────────────────────────────────────────────────────────
    /** Зарегистрировать паки из принятого сообщения (pack_ref стикера, emoji_packs текста); GIF — в сохранённые. */
    fun onReceived(content: JSONObject) {
        when (content.optString("kind")) {
            "sticker" -> content.optJSONObject("pack_ref")?.let { ref ->
                val p = index.registerReceived(ref, isEmoji = false)
                Log.i(TAG, "стикер ${content.optString("file_id")} ${content.optString("mime")} ${content.optInt("width")}x${content.optInt("height")} пак=${p.rawName}")
            } ?: Log.i(TAG, "стикер ${content.optString("file_id")} ${content.optString("mime")} ${content.optInt("width")}x${content.optInt("height")}")
            "gif" -> { Log.i(TAG, "gif ${content.optString("file_id")} ${content.optString("mime")}"); noteReceivedGif(content) }
            "text" -> content.optJSONArray("emoji_packs")?.let { a ->
                for (i in 0 until a.length()) a.optJSONObject(i)?.let { ref ->
                    val p = index.registerReceived(ref, isEmoji = true)
                    if (!p.materialized) Log.i(TAG, "пак ${p.rawName} получен (${ref.optString("file_id")}, ${ref.optInt("count")} файлов)")
                }
            }
        }
    }

    // ── состояние ──────────────────────────────────────────────────────────
    private fun loadState() {
        if (!stateFile.exists()) return
        try {
            val o = JSONObject(SeamFiles.read(stateFile))
            o.optJSONArray("recent")?.let { a -> for (i in 0 until a.length()) recent.add(a.getString(i)) }
            o.optJSONArray("favorite")?.let { a -> for (i in 0 until a.length()) favorite.add(a.getString(i)) }
            o.optJSONArray("savedGifs")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { savedGifs.add(it) } }
        } catch (e: Exception) { Log.w(TAG, "stickers-state: ${e.message}") }
    }
    private fun saveState() {
        try {
            root.mkdirs()
            SeamFiles.write(stateFile, JSONObject().put("recent", JSONArray(recent)).put("favorite", JSONArray(favorite)).put("savedGifs", JSONArray(savedGifs)).toString())
        } catch (e: Exception) { /* в памяти */ }
    }

    companion object { private const val TAG = "ParvaneClient" }
}
