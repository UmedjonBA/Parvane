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
    /** PACK-3: записи наборов в журнале состояния изменились своей правкой — дослать вид `packs`. */
    private val journalChanged: () -> Unit = {},
) {
    /** Мост к ядру (подменяется в JVM-тестах). */
    interface Core {
        fun packFetch(refJson: String): JSONObject
        fun packRefFor(dir: String, rawName: String, recipients: List<String>): JSONObject
        /** GIF-1: файл GIF по ссылке журнала, sha256 сверяется с wantHex (пусто — только посчитать) → {ok,path,sha256,size}. */
        fun gifFetch(refJson: String, wantHex: String): JSONObject = JSONObject().put("ok", false).put("error", "unsupported")
    }
    object RealCore : Core {
        override fun packFetch(refJson: String) = ParvaneCore.packFetch(refJson)
        override fun gifFetch(refJson: String, wantHex: String) = ParvaneCore.gifFetch(refJson, wantHex)
        override fun packRefFor(dir: String, rawName: String, recipients: List<String>) = ParvaneCore.packRefFor(dir, rawName) // CAP-1: блоб по секрету, получатели не нужны
    }

    val index = PackIndex(root)
    /** PACK-3: рабочая копия записей вида `packs` журнала личного состояния и сопоставление ключей. */
    val journal = PackJournal(root)
    private val stateFile = File(root, "stickers-state.json")
    private val recent = ArrayList<String>()     // "setId:name"
    private val favorite = ArrayList<String>()
    private val savedGifs = ArrayList<JSONObject>() // {file_id,key,nonce,width,height,duration_secs,mime,size_bytes,filename,local_path,sha256?}
    /** GIF-1: записи журнала, чей файл не скачался (нет сети) — повтор [retryPendingGifs]. */
    private val pendingGifs = LinkedHashMap<String, JSONObject>()
    @Volatile private var pendingTriedMs = 0L
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
        val r = applyChange(setId, isInstalled, isArchived)
        if (r !is TdApi.Ok) return r
        val p = index.bySetId(setId) ?: return r
        // PACK-3: установка — запись журнала, удаление — запись снимается; архив набор не снимает (остаётся своим)
        if (isInstalled && !isArchived) { if (recordInJournal(p)) journalChanged() }
        else if (!isInstalled && journal.forget(setId) != null) journalChanged()
        return r
    }
    private fun applyChange(setId: Long, isInstalled: Boolean, isArchived: Boolean): TdApi.Object {
        val p = index.bySetId(setId) ?: return TdApi.Error(404, "sticker set not found")
        if (isInstalled && !ensureMaterialized(p)) return TdApi.Error(400, "pack not available")
        if (!index.change(setId, isInstalled, isArchived)) return TdApi.Error(400, "builtin pack cannot be removed")
        Log.i(TAG, "пак ${p.rawName} ${if (isInstalled && !isArchived) "установлен: ${p.files.size} ${if (p.isEmoji) "эмодзи" else "стикеров"}" else if (isArchived) "в архиве" else "удалён"}")
        post(TdApi.UpdateInstalledStickerSets(PackIndex.stickerType(p.isEmoji), index.installedIds(p.isEmoji)))
        return TdApi.Ok()
    }

    // ── журнал личного состояния (PACK-3) ──────────────────────────────────
    /**
     * Установленный набор → запись журнала ссылкой на архив (полученный набор — его `pack_ref`; свой без ссылки —
     * архив загружается тем же путём, что при отправке). Встроенные не пишутся (они есть у всех). true — запись новая.
     */
    private fun recordInJournal(p: PackIndex.Pack): Boolean {
        if (p.builtin) return false
        val ref = p.ref ?: packRefForSend(p, emptyList())
        if (ref == null || ref.optString("file_id").isEmpty()) { Log.w(TAG, "стикеры: набор ${p.setId} не записан в журнал — архив не загружен"); return false }
        val before = journal.records().toString()
        journal.record(ref, p.isEmoji, p.setId) ?: return false
        if (journal.records().toString() == before) return false
        Log.i(TAG, "стикеры: набор ${p.setId} записан в журнал состояния")
        return true
    }

    /**
     * Проекция журнала: снятые на другом своём устройстве наборы — снять здесь, недостающие — скачать архив по
     * ссылке и поставить (без подтверждения). Сеть — блокирует: звать не с потока X.
     */
    @Synchronized fun applyJournal(pr: PackJournal.Projection) {
        applyJournalGifs(pr.gifs, pr.gifsRemoved)
        for (setId in pr.removed) {
            val p = index.bySetId(setId) ?: continue
            if (!p.installed || p.builtin) continue
            if (applyChange(setId, false, false) is TdApi.Ok) Log.i(TAG, "стикеры: набор $setId снят (журнал состояния)")
        }
        for (rec in pr.records) {
            val key = rec.optString("set_id")
            val ref = rec.optJSONObject("ref") ?: continue
            // PACK-2: тот же набор у этого устройства — один набор; id — по правилам этого клиента
            val p = journal.localIdOf(key)?.let(index::bySetId) ?: index.registerReceived(ref, rec.optBoolean("emoji"))
            journal.setLocalId(key, p.setId)
            if (p.installed) continue
            if (applyChange(p.setId, true, false) is TdApi.Ok) Log.i(TAG, "стикеры: набор ${p.setId} установлен из журнала состояния")
            else Log.w(TAG, "стикеры: набор ${p.setId} из журнала не установлен (архив недоступен)")
        }
    }

    /**
     * Наборы, установленные до PACK-3, — в журнал один раз на устройство (дальше журнал главнее). Набор без ссылки
     * на архив пропускается (своих наборов шов не создаёт — такие бывают только встроенные). true — записи добавлены.
     */
    @Synchronized fun migrateToJournal(): Boolean {
        if (journal.isMigrated()) return false
        val have = journal.keys()
        var added = 0; var skipped = 0
        for (p in index.all()) {
            if (p.builtin || !p.installed) continue
            val ref = p.ref
            val key = ref?.let(PackJournal::keyOf)
            if (ref == null || key == null) { skipped++; Log.w(TAG, "стикеры: набор ${p.setId} без ссылки на архив — в журнал не перенесён"); continue }
            if (key in have) { journal.setLocalId(key, p.setId); continue }
            journal.record(ref, p.isEmoji, p.setId)
            Log.i(TAG, "стикеры: набор ${p.setId} записан в журнал состояния")
            added++
        }
        journal.markMigrated()
        if (added > 0 || skipped > 0) Log.i(TAG, "стикеры: перенос в журнал состояния — записано $added, без ссылки $skipped")
        return added > 0
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

    // ── GIF (сохранённые, ≤50 как web; GIF-1 — на всех своих устройствах) ──────
    @Synchronized fun savedAnimations(): TdApi.Animations = TdApi.Animations(savedGifs.map { animationOf(it) }.toTypedArray())
    private fun animationOf(g: JSONObject): TdApi.Animation {
        // рабочая копия могла пропасть (временный каталог) — тогда файл скачивается заново (кэш устройства)
        val local = g.optString("local_path").takeIf { it.isNotEmpty() && File(it).isFile } ?: ""
        val f = store.fileFor(g.optString("file_id"), g.optString("key"), g.optString("nonce"), g.optLong("size_bytes"), g.optString("mime", "video/webm"), local)
        return TdApi.Animation(g.optInt("duration_secs", 1), g.optInt("width", 240), g.optInt("height", 240), g.optString("filename", "animation.webm"),
            g.optString("mime", "video/webm"), false, null, null, f)
    }
    private fun postSavedGifs() = post(TdApi.UpdateSavedAnimations(savedAnimations().animations.map { it.animation.id }.toIntArray()))
    private fun trimSavedGifs() { while (savedGifs.size > 50) savedGifs.removeAt(savedGifs.size - 1) }

    /** Принятый gif → в сохранённые этого устройства (как web rememberSavedGif; в журнал не пишется — только «Сохранить в GIF»). */
    @Synchronized fun noteReceivedGif(content: JSONObject) {
        val fid = content.optString("file_id"); if (fid.isEmpty() || savedGifs.any { it.optString("file_id") == fid }) return
        savedGifs.add(0, JSONObject().put("file_id", fid).put("key", content.optString("file_key")).put("nonce", content.optString("file_nonce"))
            .put("width", content.optInt("width", 240)).put("height", content.optInt("height", 240)).put("duration_secs", content.optInt("duration_secs", 1))
            .put("mime", content.optString("mime", "video/webm")).put("size_bytes", content.optLong("size_bytes")).put("filename", content.optString("filename", "animation.webm")))
        trimSavedGifs()
        saveState(); postSavedGifs()
    }

    /**
     * «Сохранить в GIF» (X: AddSavedAnimation). GIF-1: запись журнала `g:<sha256>` ссылкой из сообщения (файл заново
     * не загружается); sha256 — по рабочей копии, иначе файл скачивается ядром. Сеть — блокирует (поток io шва).
     */
    @Synchronized fun addSavedAnimation(input: TdApi.InputFile?): TdApi.Object {
        val id = (input as? TdApi.InputFileId)?.id ?: return TdApi.Error(400, "unsupported input")
        val ref = store.fileRef(id) ?: return TdApi.Error(404, "file not found")
        val had = savedGifs.firstOrNull { it.optString("file_id") == ref.remoteId }
        val g: JSONObject = had ?: newSavedGif(ref)
        if (had != null) {
            savedGifs.remove(had)
            if (had.optString("local_path").isEmpty() && ref.path.isNotEmpty()) had.put("local_path", ref.path)
        }
        savedGifs.add(0, g); trimSavedGifs()
        if (recordGifInJournal(g)) journalChanged()
        saveState(); postSavedGifs(); return TdApi.Ok()
    }

    private fun newSavedGif(ref: ParvaneStore.FileRef): JSONObject {
        val g = JSONObject().put("file_id", ref.remoteId).put("key", ref.key).put("nonce", ref.nonce).put("mime", ref.mime).put("size_bytes", ref.size).put("local_path", ref.path)
        val c = store.contentByFileId(ref.remoteId) ?: return g
        g.put("width", c.optInt("width", 240)).put("height", c.optInt("height", 240)).put("duration_secs", c.optInt("duration_secs", 1))
        if (!c.isNull("filename") && c.optString("filename").isNotEmpty()) g.put("filename", c.optString("filename"))
        if (!c.isNull("mime") && c.optString("mime").isNotEmpty()) g.put("mime", c.optString("mime"))
        return g
    }

    @Synchronized fun removeSavedAnimation(input: TdApi.InputFile?): TdApi.Object {
        val id = (input as? TdApi.InputFileId)?.id ?: return TdApi.Error(400, "unsupported input")
        val ref = store.fileRef(id) ?: return TdApi.Error(404, "file not found")
        val gone = savedGifs.filter { it.optString("file_id") == ref.remoteId }
        savedGifs.removeAll(gone.toSet()); saveState()
        // GIF-1: снятие — sticker_pack_remove с тем же ключом
        var changed = false
        for (g in gone) {
            val hex = g.optString("sha256").ifEmpty { g.optString("local_path").takeIf { it.isNotEmpty() }?.let { sha256Of(File(it)) } ?: "" }
            if (hex.isNotEmpty() && journal.forgetGif(hex)) changed = true
        }
        if (changed) { Log.i(TAG, "GIF ${ref.remoteId} снят из журнала состояния"); journalChanged() }
        postSavedGifs(); return TdApi.Ok()
    }

    /** GIF → запись журнала (ссылка на файл из сообщения). true — запись новая. */
    private fun recordGifInJournal(g: JSONObject): Boolean {
        val fid = g.optString("file_id"); if (fid.isEmpty()) return false
        val c = store.contentByFileId(fid)
        fun pick(k: String, ck: String) = g.optString(k).ifEmpty { c?.takeUnless { it.isNull(ck) }?.optString(ck) ?: "" }
        val name = gifName(pick("filename", "filename"), g.optString("mime"))
        val ref = JSONObject().put("file_id", fid).put("name", name)
        pick("key", "file_key").takeIf { it.isNotEmpty() }?.let { ref.put("key", it) }
        pick("nonce", "file_nonce").takeIf { it.isNotEmpty() }?.let { ref.put("nonce", it) }
        pick("capability", "capability").takeIf { it.isNotEmpty() }?.let { ref.put("capability", it); g.put("capability", it) }
        pick("blob_domain", "blob_domain").takeIf { it.isNotEmpty() }?.let { ref.put("blob_domain", it); g.put("blob_domain", it) }
        var hex = g.optString("sha256")
        if (hex.isEmpty()) hex = g.optString("local_path").takeIf { it.isNotEmpty() && File(it).isFile }?.let { sha256Of(File(it)) } ?: ""
        if (hex.isEmpty()) {
            val r = try { core.gifFetch(JSONObject(ref.toString()).put("size_bytes", g.optLong("size_bytes")).toString(), "") } catch (e: Throwable) { JSONObject().put("error", e.message) }
            if (!r.optBoolean("ok")) { Log.w(TAG, "GIF $fid: в журнал не записан — файл не получен (${r.optString("error")})"); return false }
            hex = r.optString("sha256")
            r.optString("path").takeIf { it.isNotEmpty() }?.let { g.put("local_path", it) }
        }
        if (hex.isEmpty()) return false
        g.put("sha256", hex)
        val before = journal.records().toString()
        journal.recordGif(ref, hex) ?: return false
        if (journal.records().toString() == before) return false
        Log.i(TAG, "GIF $fid записан в журнал состояния")
        return true
    }

    /**
     * Проекция журнала (GIF-1): снятые на другом своём устройстве — убрать, недостающие — скачать по ссылке, сверить
     * sha256, добавить (новые первыми по added_ms). Неудачные скачивания ждут [retryPendingGifs].
     */
    @Synchronized private fun applyJournalGifs(gifs: List<JSONObject>, removed: List<String>) {
        var changed = false
        for (hex in removed) {
            pendingGifs.remove(hex)
            if (savedGifs.removeAll { it.optString("sha256") == hex }) { changed = true; Log.i(TAG, "GIF $hex снят (журнал состояния)") }
        }
        val want = gifs.mapNotNull { r -> r.optString("set_id").takeIf { PackJournal.isGifKey(it) }?.removePrefix(PackJournal.GIF_PREFIX)?.let { it to r } }.toMap()
        pendingGifs.keys.retainAll(want.keys)
        for ((hex, r) in want) if (savedGifs.none { it.optString("sha256") == hex }) pendingGifs[hex] = r
        if (fetchPendingGifs()) changed = true
        if (changed) { saveState(); postSavedGifs() }
    }

    /** Повтор скачивания GIF журнала (не чаще раза в 60 с). Сеть — блокирует. */
    @Synchronized fun retryPendingGifs(nowMs: Long = System.currentTimeMillis()) {
        if (pendingGifs.isEmpty() || nowMs - pendingTriedMs < 60_000) return
        if (fetchPendingGifs()) { saveState(); postSavedGifs() }
    }
    fun hasPendingGifs() = pendingGifs.isNotEmpty()

    private fun fetchPendingGifs(): Boolean {
        if (pendingGifs.isEmpty()) return false
        pendingTriedMs = System.currentTimeMillis()
        val added = ArrayList<JSONObject>()
        for ((hex, rec) in pendingGifs.entries.toList()) {
            val ref = rec.optJSONObject("ref")
            if (ref == null) { pendingGifs.remove(hex); continue }
            val fid = ref.optString("file_id")
            val r = try { core.gifFetch(ref.toString(), hex) } catch (e: Throwable) { JSONObject().put("error", e.message) }
            if (!r.optBoolean("ok")) { Log.w(TAG, "GIF $fid из журнала не получен (${r.optString("error")})"); continue }
            pendingGifs.remove(hex)
            val name = ref.optString("name").ifEmpty { "animation.mp4" }
            val g = JSONObject().put("file_id", fid).put("key", ref.optString("key")).put("nonce", ref.optString("nonce"))
                .put("mime", mimeOf(name)).put("size_bytes", r.optLong("size")).put("filename", name)
                .put("local_path", r.optString("path")).put("sha256", hex).put("added_ms", rec.optString("added_ms"))
            ref.optString("capability").takeIf { it.isNotEmpty() }?.let { g.put("capability", it) }
            ref.optString("blob_domain").takeIf { it.isNotEmpty() }?.let { g.put("blob_domain", it) }
            savedGifs.removeAll { it.optString("file_id") == fid }
            added.add(g)
            Log.i(TAG, "GIF $fid добавлен из журнала состояния")
        }
        if (added.isEmpty()) return false
        // новые первыми (added_ms записи журнала)
        added.sortByDescending { it.optString("added_ms").toLongOrNull() ?: 0L }
        savedGifs.addAll(0, added); trimSavedGifs()
        return true
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

    companion object {
        private const val TAG = "ParvaneClient"
        /** GIF-1: тип файла — по расширению имени (`.mp4`, `.webm`, `.gif`). */
        fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
            "gif" -> "image/gif"; "mp4" -> "video/mp4"; else -> "video/webm"
        }
        /** Имя файла с расширением (PackRef.name ≤ 64): без расширения — по типу. */
        fun gifName(filename: String, mime: String): String {
            val ext = when { mime.contains("gif") -> "gif"; mime.contains("mp4") -> "mp4"; else -> "webm" }
            var n = filename.trim().substringAfterLast('/').ifEmpty { "animation.$ext" }
            if (!n.contains('.')) n = "$n.$ext"
            if (n.length > 64) { val e = n.substringAfterLast('.'); n = n.substring(0, 63 - e.length) + "." + e }
            return n
        }
        fun sha256Of(f: File): String = try {
            val md = java.security.MessageDigest.getInstance("SHA-256")
            f.inputStream().use { input -> val buf = ByteArray(64 * 1024); while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
            md.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        } catch (e: Exception) { "" }
    }
}
