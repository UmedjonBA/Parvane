package org.thunderdog.challegram.parvane.sections

import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.widget.ImageView
import android.widget.LinearLayout
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import java.io.File

/**
 * Parvane (spec 031, T066): раздел «Облако» — личный диск и совместные папки: папки и файлы с сортировкой и
 * поиском, загрузка из галереи/файлов (системный выбор документов), скачивание в «Загрузки», переименование,
 * перенос, корзина (восстановить / удалить навсегда), «Сделать общей», ссылки для людей без аккаунта (срок,
 * отзыв, продление), занятое место. Логика и шифрование — ядро (`CloudFiles`, правки дерева), экран — только вид.
 */
class CloudController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib),
    org.thunderdog.challegram.navigation.ActivityResultHandler {
    override val section = "files"
    override val tab = ParvaneTabBar.Tab.PROFILE
    override fun getId() = R.id.controller_parvaneCloud
    override fun getName(): CharSequence = if (onPick != null) Sx.t("Выберите файл", "Choose a file") else Sx.t("Облако", "Cloud")

    /** Режим выбора файла (меню чата «Отправить из облака»): узел и контейнер; экран закрывается сам. */
    var onPick: ((JSONObject, String) -> Unit)? = null
    private var snap: JSONObject? = null
    private var container: String? = null // null — личный диск
    private var folder: String? = null
    private var view = "files" // files | trash | links
    private var sort = "name"
    private var query = ""
    private var busy: String? = null
    private var links: JSONArray? = null

    companion object {
        private const val PICK = 0x5071
    }

    /** Результат системного выбора файлов (BaseActivity отдаёт верхнему контроллеру). */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK || resultCode != Activity.RESULT_OK || data == null) return
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri }
        data.data?.let { if (uris.isEmpty()) uris += it }
        upload(uris)
    }

    override fun onBuilt() {
        watch("cloud") { s ->
            snap = s
            render()
        }
        if (snap == null) render()
        Sx.async({ ParvaneSections.cloudCall("parvaneCloudUsage", "{}") }) { }
    }

    private fun containerId(): String? = container ?: snap?.optString("rootId")?.takeIf { it.isNotEmpty() && it != "null" }

    private fun nodes(): List<JSONObject> {
        val id = containerId() ?: return emptyList()
        return Sx.list(snap?.optJSONObject("state")?.optJSONObject("trees")?.optJSONObject(id)?.optJSONArray("nodes"))
    }

    private fun shared(): List<JSONObject> = Sx.list(snap?.optJSONArray("containers")).filter { it.optString("kind") != "root" && it.optString("id") != snap?.optString("rootId") }

    private fun render(): Unit = rebuild {
        tabs(listOf("files" to Sx.t("Файлы", "Files"), "trash" to Sx.t("Корзина", "Trash"), "links" to Sx.t("Ссылки", "Links")), view) {
            view = it
            if (it == "links") loadLinks()
            render()
        }
        val s = snap
        val status = s?.optString("status") ?: "loading"
        if (s == null || status == "loading" || status == "needs-linking") {
            placeholder(if (status == "needs-linking") Sx.t("Устройство ещё не привязано", "This device is not linked yet") else Sx.t("Загрузка облака…", "Loading cloud…"))
            return@rebuild
        }
        busy?.let { addView(context.label(it, 13f, ColorId.textNeutral).apply { layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(18f)) }) }
        s.optJSONObject("usage")?.let { u ->
            val used = u.optLong("used_bytes", u.optLong("usedBytes", 0)) + u.optLong("links_bytes", 0)
            val quota = u.optLong("quota_bytes", u.optLong("quotaBytes", 0))
            if (quota > 0) addView(context.card().apply {
                addView(context.label(Sx.t("Занято ${size(used)} из ${size(quota)}", "${size(used)} of ${size(quota)} used"), 13f, ColorId.textLight))
                addView(context.bar(used.toDouble() / quota))
            })
        }
        when (view) {
            "trash" -> renderTrash()
            "links" -> renderLinks()
            else -> renderFiles()
        }
    }

    private fun LinearLayout.renderFiles() {
        // где: личный диск или совместная папка
        val places = context.hbox().apply { setPadding(Sx.dp(8f), Sx.dp(8f), Sx.dp(8f), 0) }
        places.addView(context.chip(Sx.t("Мой диск", "My drive"), container == null) { container = null; folder = null; render() })
        shared().forEach { c ->
            places.addView(context.chip(c.optString("name").ifEmpty { Sx.t("Совместная", "Shared") }, container == c.optString("id")) {
                container = c.optString("id"); folder = null; render()
            })
        }
        addView(android.widget.HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(places) })
        val all = nodes()
        val byId = all.associateBy { it.optString("id") }
        // путь
        val path = mutableListOf<JSONObject>()
        var cur = folder?.let { byId[it] }
        while (cur != null) { path.add(0, cur); cur = cur.takeUnless { it.isNull("parent") }?.optString("parent")?.takeIf { it.isNotEmpty() }?.let { byId[it] } }
        val crumbs = context.hbox().apply { setPadding(Sx.dp(12f), Sx.dp(6f), Sx.dp(12f), 0) }
        crumbs.addView(context.label(Sx.t("Корень", "Root"), 14f, ColorId.textLink).apply { setOnClickListener { folder = null; render() } })
        path.forEach { p ->
            crumbs.addView(context.label(" / ", 14f, ColorId.textLight))
            crumbs.addView(context.label(p.optString("name"), 14f, ColorId.textLink).apply { setOnClickListener { folder = p.optString("id"); render() } })
        }
        addView(android.widget.HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(crumbs) })
        val actions = context.hbox().apply { setPadding(Sx.dp(8f), Sx.dp(6f), Sx.dp(8f), 0) }
        actions.addView(context.chip(Sx.t("Загрузить", "Upload"), false) { pick() })
        actions.addView(context.chip(Sx.t("Новая папка", "New folder"), false) { newFolder() })
        actions.addView(context.chip(Sx.t("Сортировка: ", "Sort: ") + when (sort) { "date" -> Sx.t("дата", "date"); "size" -> Sx.t("размер", "size"); else -> Sx.t("имя", "name") }, false) {
            sort = when (sort) { "name" -> "date"; "date" -> "size"; else -> "name" }
            render()
        })
        actions.addView(context.chip(Sx.t("Поиск", "Search"), query.isNotEmpty()) {
            KnowledgeDialogs.askText(context(), Sx.t("Поиск по облаку", "Search cloud"), query) { q -> query = q; render() }
        })
        if (query.isNotEmpty()) actions.addView(context.chip("✕ $query", true) { query = ""; render() })
        if (container != null) actions.addView(context.chip(Sx.t("Покинуть", "Leave"), false) { leaveShared() })
        addView(android.widget.HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(actions) })
        val visible = all.filter { !it.optBoolean("trashed") }.let { list ->
            if (query.isNotEmpty()) list.filter { it.optString("name").contains(query, ignoreCase = true) }
            else list.filter { ((if (it.isNull("parent")) null else it.optString("parent").ifEmpty { null })) == folder }
        }.sortedWith(compareBy<JSONObject> { it.optString("kind") != "folder" }.then(when (sort) {
            "date" -> compareByDescending { it.optLong("mtime") }
            "size" -> compareByDescending { it.optLong("size") }
            else -> compareBy { it.optString("name").lowercase() }
        }))
        if (visible.isEmpty()) placeholder(if (query.isEmpty()) Sx.t("Здесь пусто. «Загрузить» — добавить файлы", "Empty. Tap “Upload” to add files") else Sx.t("Ничего не найдено", "Nothing found"))
        visible.forEach { n ->
            addView(nodeRow(n) {
                val pick = onPick
                when {
                    n.optString("kind") == "folder" -> { folder = n.optString("id"); query = ""; render() }
                    pick != null -> { navigateBack(); pick(n, containerId() ?: "") }
                    else -> fileMenu(n)
                }
            })
        }
    }

    private fun nodeRow(n: JSONObject, onClick: () -> Unit): LinearLayout {
        val ctx = context()
        val isFolder = n.optString("kind") == "folder"
        val row = ctx.hbox().apply {
            setPadding(Sx.dp(12f), Sx.dp(10f), Sx.dp(12f), Sx.dp(10f))
            layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(12f), r = Sx.dp(12f))
            pressable(onClick = onClick)
            setOnLongClickListener { if (isFolder) folderMenu(n) else fileMenu(n); true }
        }
        row.addView(ImageView(ctx).apply {
            setImageResource(if (isFolder) R.drawable.baseline_folder_24 else R.drawable.baseline_insert_drive_file_24)
            colorFilter = PorterDuffColorFilter(Sx.color(if (isFolder) ColorId.iconActive else ColorId.icon), PorterDuff.Mode.SRC_IN)
            layoutParams = LinearLayout.LayoutParams(Sx.dp(36f), Sx.dp(36f)).apply { rightMargin = Sx.dp(10f) }
            scaleType = ImageView.ScaleType.CENTER
        })
        val texts = ctx.vbox().apply { layoutParams = lp(0, weight = 1f) }
        texts.addView(ctx.label(n.optString("name"), 15f, maxLines = 1))
        val meta = if (isFolder) Sx.t("Папка", "Folder") else listOf(size(n.optLong("size")), date(n.optLong("mtime"))).filter { it.isNotEmpty() }.joinToString(" · ")
        texts.addView(ctx.label(meta, 13f, ColorId.textLight, maxLines = 1))
        row.addView(texts)
        return row
    }

    private fun LinearLayout.renderTrash() {
        val trashed = nodes().filter { it.optBoolean("trashed") && it.optBoolean("trashTop", true) }
        if (trashed.isEmpty()) { placeholder(Sx.t("Корзина пуста", "Trash is empty")); return }
        addView(context.action(Sx.t("Очистить корзину", "Empty trash"), ColorId.textNegative) {
            confirm(Sx.t("Удалить всё из корзины навсегда?", "Delete everything in trash forever?")) {
                files("purge", JSONObject().put("nodes", JSONArray(trashed.map { it.optString("id") })))
            }
        })
        trashed.forEach { n ->
            addView(nodeRow(n) {
                AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(n.optString("name"))
                    .setItems(arrayOf(Sx.t("Восстановить", "Restore"), Sx.t("Удалить навсегда", "Delete forever"))) { _, which ->
                        files(if (which == 0) "restore" else "purge", JSONObject().put("nodes", JSONArray().put(n.optString("id"))))
                    }.show()
            })
        }
    }

    private fun LinearLayout.renderLinks() {
        val list = Sx.list(links)
        if (links == null) { placeholder(Sx.t("Загрузка ссылок…", "Loading links…")); return }
        if (list.isEmpty()) placeholder(Sx.t("Ссылок нет. Создать — долгое нажатие на файле или папке", "No links. Long-press a file or folder to create one"))
        list.forEach { l ->
            val card = context.card()
            card.addView(context.label(l.optString("name").ifEmpty { l.optString("id") }, 15f, bold = true))
            val state = when (l.optString("state")) { "ready" -> ""; "revoked" -> Sx.t("отозвана", "revoked"); "expired" -> Sx.t("истекла", "expired"); else -> l.optString("state") }
            val exp = l.optLong("expiresAt").takeIf { it > 0 }?.let { Sx.t("до ${date(it * 1000)}", "until ${date(it * 1000)}") } ?: Sx.t("без срока", "no expiry")
            card.addView(context.label(listOf(state, exp, size(l.optLong("bytes"))).filter { it.isNotEmpty() }.joinToString(" · "), 13f, ColorId.textLight))
            val url = l.optString("url")
            val row = context.hbox()
            if (url.isNotEmpty() && l.optString("state") == "ready") {
                row.addView(context.chip(Sx.t("Копировать", "Copy"), false) { copy(url) })
                row.addView(context.chip(Sx.t("Поделиться", "Share"), false) { share(url) })
                row.addView(context.chip(Sx.t("Продлить", "Extend"), false) { ttl { d -> files("linkExtend", JSONObject().put("id", l.optString("id")).put("ttlDays", d)) { loadLinks() } } })
                row.addView(context.chip(Sx.t("Отозвать", "Revoke"), false) {
                    confirm(Sx.t("Отозвать ссылку?", "Revoke link?")) { files("linkRevoke", JSONObject().put("id", l.optString("id"))) { loadLinks() } }
                })
            }
            card.addView(android.widget.HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(row) })
            addView(card)
        }
    }

    private fun loadLinks(): Unit = Sx.async({ ParvaneSections.cloudFiles("links") }) { r ->
        links = (r as? JSONObject)?.optJSONArray("links") ?: JSONArray()
        render()
    }

    // ── действия ───────────────────────────────────────────────────────────────

    private fun files(op: String, args: JSONObject, done: (JSONObject?) -> Unit = {}) {
        containerId()?.let { if (!args.has("container")) args.put("container", it) }
        Sx.async({ ParvaneSections.cloudFiles(op, args) }) { r ->
            val o = r as? JSONObject
            if (o != null && o.has("ok") && !o.optBoolean("ok")) toast(Sx.t("Не получилось: ${o.optString("error")}", "Failed: ${o.optString("error")}"))
            done(o)
        }
    }

    private fun pick() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        try { context().startActivityForResult(intent, PICK) } catch (e: Throwable) { toast(Sx.t("Нет приложения для выбора файлов", "No file picker")) }
    }

    fun upload(uris: List<Uri>) {
        val target = containerId() ?: return
        val parent = folder
        val ctx = context()
        busy = Sx.t("Загрузка: ${uris.size}…", "Uploading ${uris.size}…")
        render()
        Sx.async({
            val tmp = File(ctx.cacheDir, "parvane-upload").apply { mkdirs() }
            var failed = 0
            uris.forEachIndexed { i, uri ->
                val (name, mime) = describe(ctx, uri)
                val f = File(tmp, "u$i")
                try {
                    ctx.contentResolver.openInputStream(uri)?.use { input -> f.outputStream().use { input.copyTo(it) } }
                    val r = ParvaneSections.cloudFiles("upload", JSONObject().put("container", target).put("parent", parent ?: "")
                        .put("path", f.absolutePath).put("name", name).put("mime", mime)) as? JSONObject
                    if (r?.optBoolean("ok") != true) failed++
                } catch (e: Throwable) {
                    failed++
                } finally {
                    f.delete()
                }
            }
            failed
        }) { failed ->
            busy = null
            if ((failed ?: 0) > 0) toast(Sx.t("Не загружено файлов: $failed", "Files not uploaded: $failed"))
            Sx.async({ ParvaneSections.cloudCall("parvaneCloudUsage", "{}") }) { }
            render()
        }
    }

    private fun describe(ctx: Context, uri: Uri): Pair<String, String> {
        var name = "file"
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) name = c.getString(0) ?: name
        }
        return name to (ctx.contentResolver.getType(uri) ?: "application/octet-stream")
    }

    private fun download(n: JSONObject) {
        val ctx = context()
        busy = Sx.t("Скачивание «${n.optString("name")}»…", "Downloading “${n.optString("name")}”…")
        render()
        Sx.async({
            val tmp = File(ctx.cacheDir, "parvane-download").apply { mkdirs() }
            val f = File(tmp, "d-" + System.nanoTime())
            try {
                val r = ParvaneSections.cloudFiles("download", JSONObject().put("container", containerId()).put("node", n.optString("id")).put("out", f.absolutePath)) as? JSONObject
                if (r?.optBoolean("ok") != true) return@async false
                saveToDownloads(ctx, f, n.optString("name"), n.optString("mime"))
            } finally {
                f.delete()
            }
        }) { ok ->
            busy = null
            toast(if (ok == true) Sx.t("Сохранено в «Загрузки»", "Saved to Downloads") else Sx.t("Не скачано", "Download failed"))
            render()
        }
    }

    private fun saveToDownloads(ctx: Context, f: File, name: String, mime: String): Boolean {
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime.ifEmpty { "application/octet-stream" })
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
            ctx.contentResolver.openOutputStream(uri)?.use { out -> f.inputStream().use { it.copyTo(out) } } ?: return false
            return true
        }
        @Suppress("DEPRECATION")
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        f.copyTo(File(dir, name), overwrite = true)
        return true
    }

    private fun fileMenu(n: JSONObject) {
        val items = listOf(
            Sx.t("Скачать", "Download") to { download(n) },
            Sx.t("Переименовать", "Rename") to { rename(n) },
            Sx.t("Перенести", "Move") to { move(n) },
            Sx.t("Ссылка для всех", "Public link") to { createLink(n) },
            Sx.t("В корзину", "Move to trash") to { files("trash", JSONObject().put("nodes", JSONArray().put(n.optString("id")))) },
        )
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(n.optString("name"))
            .setItems(items.map { it.first }.toTypedArray()) { _, which -> items[which].second() }.show()
    }

    private fun folderMenu(n: JSONObject) {
        val items = mutableListOf(
            Sx.t("Открыть", "Open") to { folder = n.optString("id"); render() },
            Sx.t("Переименовать", "Rename") to { rename(n) },
            Sx.t("Перенести", "Move") to { move(n) },
            Sx.t("Ссылка для всех", "Public link") to { createLink(n) },
            Sx.t("В корзину", "Move to trash") to { files("trash", JSONObject().put("nodes", JSONArray().put(n.optString("id")))) },
        )
        if (container == null) items.add(3, Sx.t("Сделать общей", "Make shared") to {
            busy = Sx.t("Папка становится общей…", "Sharing folder…")
            render()
            files("shareFolder", JSONObject().put("node", n.optString("id"))) { busy = null; render() }
        })
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(n.optString("name"))
            .setItems(items.map { it.first }.toTypedArray()) { _, which -> items[which].second() }.show()
    }

    private fun rename(n: JSONObject): Unit = KnowledgeDialogs.askText(context(), Sx.t("Новое имя", "New name"), n.optString("name")) { name ->
        files("rename", JSONObject().put("node", n.optString("id")).put("name", name))
    }

    private fun newFolder(): Unit = KnowledgeDialogs.askText(context(), Sx.t("Название папки", "Folder name"), "") { name ->
        files("createFolder", JSONObject().put("name", name).put("parent", folder ?: ""))
    }

    private fun move(n: JSONObject) {
        val folders = nodes().filter { it.optString("kind") == "folder" && !it.optBoolean("trashed") && it.optString("id") != n.optString("id") }
        val names = listOf(Sx.t("Корень", "Root")) + folders.map { it.optString("name") }
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(Sx.t("Перенести в…", "Move to…"))
            .setItems(names.toTypedArray()) { _, which ->
                files("move", JSONObject().put("nodes", JSONArray().put(n.optString("id"))).put("parent", if (which == 0) "" else folders[which - 1].optString("id")))
            }.show()
    }

    private fun createLink(n: JSONObject): Unit = ttl { days ->
        busy = Sx.t("Создаётся ссылка…", "Creating link…")
        render()
        files("linkCreate", JSONObject().put("node", n.optString("id")).put("name", n.optString("name")).put("ttlDays", days)) { r ->
            busy = null
            render()
            r?.optJSONObject("link")?.optString("url")?.takeIf { it.isNotEmpty() }?.let { url ->
                AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(Sx.t("Ссылка готова", "Link ready")).setMessage(url)
                    .setPositiveButton(Sx.t("Копировать", "Copy")) { _, _ -> copy(url) }
                    .setNeutralButton(Sx.t("Поделиться", "Share")) { _, _ -> share(url) }
                    .setNegativeButton(android.R.string.ok, null).show()
            }
        }
    }

    private fun ttl(done: (Int) -> Unit) {
        val values = intArrayOf(1, 7, 30, 0)
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(Sx.t("Срок ссылки", "Link expiry"))
            .setItems(arrayOf(Sx.t("1 день", "1 day"), Sx.t("7 дней", "7 days"), Sx.t("30 дней", "30 days"), Sx.t("Без срока", "No expiry"))) { _, which -> done(values[which]) }
            .show()
        Unit
    }

    private fun leaveShared(): Unit = confirm(Sx.t("Покинуть совместную папку?", "Leave the shared folder?")) {
        val id = container ?: return@confirm
        Sx.async({ ParvaneSections.cloudCall("parvaneCloudLeave", JSONObject().put("container", id).toString()) }) { container = null; render() }
    }

    private fun confirm(text: String, then: () -> Unit) {
        AlertDialog.Builder(context(), Theme.dialogTheme()).setMessage(text)
            .setPositiveButton(android.R.string.ok) { _, _ -> then() }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun copy(text: String) {
        val cm = context().getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("Parvane", text))
        toast(Sx.t("Скопировано", "Copied"))
    }

    private fun share(text: String): Unit = try {
        context().startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), null))
    } catch (e: Throwable) { }

    private fun size(bytes: Long): String = when {
        bytes <= 0 -> ""
        bytes < 1024 -> "$bytes ${Sx.t("Б", "B")}"
        bytes < 1024 * 1024 -> "${bytes / 1024} ${Sx.t("КБ", "KB")}"
        bytes < 1024L * 1024 * 1024 -> String.format(java.util.Locale.US, "%.1f %s", bytes / 1048576.0, Sx.t("МБ", "MB"))
        else -> String.format(java.util.Locale.US, "%.2f %s", bytes / 1073741824.0, Sx.t("ГБ", "GB"))
    }

    private fun date(ms: Long): String = if (ms <= 0) "" else java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(ms))
}
