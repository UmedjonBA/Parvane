package org.thunderdog.challegram.parvane.sections

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.parvane.sections.Kn.ava
import org.thunderdog.challegram.parvane.sections.Kn.listRow
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.tool.UI
import java.io.File

/**
 * Parvane (spec 031, T066; вид spec 032): экран «Облако» — тот же вид, что вкладка «Файлы» в «Знаниях» ([CloudPane]);
 * отдельным экраном открывается для выбора файла (меню чата «Отправить из облака», [onPick]).
 */
class CloudController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib),
    org.thunderdog.challegram.navigation.ActivityResultHandler {
    override val section = "files"
    override val tab = ParvaneTabBar.Tab.KNOWLEDGE
    override fun getId() = R.id.controller_parvaneCloud
    override fun getName(): CharSequence = if (onPick != null) Sx.t("Выберите файл", "Choose a file") else Sx.t("Облако", "Cloud")

    /** Режим выбора файла (меню чата «Отправить из облака»): узел и контейнер; экран закрывается сам. */
    var onPick: ((JSONObject, String) -> Unit)? = null
    private lateinit var pane: CloudPane

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) = pane.onActivityResult(requestCode, resultCode, data)

    override fun onBuilt() {
        pane = CloudPane(context(), { render() }) { n, container ->
            onPick?.let { pick -> navigateBack(); pick(n, container); true } ?: false
        }
        watch("cloud") { s -> pane.snap = s; render() }
        render()
        pane.refreshUsage()
    }

    private fun render(): Unit = rebuild { pane.render(this) }
}

/**
 * Файлы облака в виде телефонной версии web (`Cloud.tsx`): строка пути «Облако / …» и сортировка пилюлей, чипы
 * «Новая папка · Загрузить файл · Новая общая папка», строки с плитками (хранилище «Знания» — жёлтая, папки — синие,
 * чужие — фиолетовые), в корне — «Доступные мне», «Мои ссылки», «Корзина», внизу — занятое место. Логика и
 * шифрование — ядро (`CloudFiles`, правки дерева), здесь только вид.
 */
class CloudPane(private val context: Context, private val rerender: () -> Unit,
                private val onPickFile: (JSONObject, String) -> Boolean = { _, _ -> false }) {
    var snap: JSONObject? = null
    private var place = "drive" // drive | shared | links | trash
    private var container: String? = null // null — личный диск
    private var folder: String? = null
    private var sort = "name"
    private var descending = false
    var query = ""
        set(value) { field = value; rerender() }
    private var busy: String? = null
    private var links: JSONArray? = null

    companion object {
        const val PICK = 0x5071
    }

    private fun toast(text: String) = UI.showToast(text, android.widget.Toast.LENGTH_SHORT)

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK || resultCode != Activity.RESULT_OK || data == null) return
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri }
        data.data?.let { if (uris.isEmpty()) uris += it }
        upload(uris)
    }

    fun refreshUsage() {
        Sx.async({ ParvaneSections.cloudCall("parvaneCloudUsage", "{}") }) { }
        if (links == null) Sx.async({ ParvaneSections.cloudFiles("links") }) { r -> links = (r as? JSONObject)?.optJSONArray("links") ?: JSONArray(); rerender() }
    }

    /** Открыть папку хранилища заметок («Знания» / «Knowledge») в личном диске. */
    fun openVault() {
        place = "drive"; container = null
        folder = vault()?.optString("id")
        rerender()
    }

    private fun rootId(): String? = snap?.optString("rootId")?.takeIf { it.isNotEmpty() && it != "null" }
    private fun containerId(): String? = container ?: rootId()
    private fun nodesOf(id: String?): List<JSONObject> =
        if (id == null) emptyList() else Sx.list(snap?.optJSONObject("state")?.optJSONObject("trees")?.optJSONObject(id)?.optJSONArray("nodes"))
    private fun nodes(): List<JSONObject> = nodesOf(containerId())
    private fun parentOf(n: JSONObject): String? = if (n.isNull("parent")) null else n.optString("parent").ifEmpty { null }
    // Все контейнеры, кроме личного диска (поиск по id); свои общие папки — в корне диска, чужие — в «Доступные мне»
    private fun others(): List<JSONObject> = Sx.list(snap?.optJSONArray("containers")).filter { it.optString("kind") != "root" && it.optString("id") != rootId() }
    private fun owned(): List<JSONObject> = others().filter { it.optString("kind") == "owned" }
    private fun shared(): List<JSONObject> = others().filter { it.optString("kind") != "owned" }
    private fun isService(n: JSONObject) = n.optString("name").startsWith(".parvane-")
    private fun vault(): JSONObject? = nodesOf(rootId()).firstOrNull {
        it.optString("kind") == "folder" && parentOf(it) == null && !it.optBoolean("trashed") && it.optString("name") in listOf("Знания", "Knowledge")
    }
    private fun trash(): List<JSONObject> = nodesOf(rootId()).filter { it.optBoolean("trashed") && it.optBoolean("trashTop", true) }

    /** «Назад» внутри файлов: на уровень вверх; false — уже корень. */
    fun back(): Boolean {
        when {
            folder != null -> folder = nodes().firstOrNull { it.optString("id") == folder }?.let { parentOf(it) }
            container != null -> { place = if (owned().any { it.optString("id") == container }) "drive" else "shared"; container = null }
            place != "drive" -> place = "drive"
            else -> return false
        }
        rerender()
        return true
    }

    fun render(body: LinearLayout) {
        body.setPadding(Pv.rem(1f), Pv.rem(1f), Pv.rem(1f), Pv.rem(1.5f))
        val s = snap
        val status = s?.optString("status") ?: "loading"
        if (s == null || status == "loading" || status == "needs-linking") {
            if (status != "needs-linking") body.addView(MascotView(context), lp(t = Pv.rem(2.5f)).apply { gravity = Gravity.CENTER_HORIZONTAL; width = Pv.rem(4f) })
            body.addView(context.pvText(if (status == "needs-linking") Sx.t("Устройство ещё не привязано — облако появится после привязки", "This device is not linked yet")
                else Sx.t("Загрузка облака…", "Loading cloud…"), 0.9375f, Pv.c.muted).apply { gravity = Gravity.CENTER }, lp(t = Pv.rem(1.5f)))
            return
        }
        // Путь и сортировка (`.tools`)
        val tools = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val path = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        fun crumb(title: String, first: Boolean, go: () -> Unit) {
            if (!first) path.addView(context.pvText("/", 0.875f, Pv.c.faint))
            path.addView(context.pvText(title, 0.875f, Pv.c.muted, maxLines = 1).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(Pv.rem(0.625f), 0, Pv.rem(0.625f), 0)
                maxWidth = Pv.rem(10f)
                Pv.pressable(this, 0, 0.5f) { go() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.25f)))
        }
        if (query.isNotEmpty()) path.addView(context.pvText(Sx.t("Найдено: ${found().size}", "Found: ${found().size}"), 0.875f, Pv.c.muted))
        else {
            crumb(Sx.t("Облако", "Cloud"), true) { place = "drive"; container = null; folder = null; rerender() }
            if (place != "drive") crumb(virtualName(place), false) { container = null; folder = null; rerender() }
            container?.let { id -> crumb(others().firstOrNull { it.optString("id") == id }?.optString("name").orEmpty().ifEmpty { Sx.t("Общая папка", "Shared folder") }, false) { folder = null; rerender() } }
            val byId = nodes().associateBy { it.optString("id") }
            val chain = mutableListOf<JSONObject>()
            var cur = folder?.let { byId[it] }
            while (cur != null) { chain.add(0, cur); cur = parentOf(cur)?.let { byId[it] } }
            chain.forEach { p -> crumb(p.optString("name"), false) { folder = p.optString("id"); rerender() } }
        }
        tools.addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(path) },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = -Pv.rem(0.625f) })
        if (place == "drive" || container != null) tools.addView(sortPill())
        body.addView(tools, lp(b = Pv.rem(0.625f)))
        busy?.let { body.addView(context.pvText(it, 0.8125f, Pv.c.accent), lp(b = Pv.rem(0.5f))) }
        // Пустой диск без причины выглядел как «Здесь пусто» — состояние синхронизации показываем явно
        when (status) {
            "no-key" -> Sx.t("Ключ личного диска ещё не получен — откройте Parvane на другом своём устройстве",
                "The drive key has not arrived yet — open Parvane on another of your devices")
            "offline" -> Sx.t("Нет связи с сервером — показано сохранённое", "No connection — showing saved files")
            else -> null
        }?.let { body.addView(context.pvText(it, 0.8125f, Pv.c.muted), lp(b = Pv.rem(0.5f))) }
        val canAdd = query.isEmpty() && (place == "drive" || (container != null && others().firstOrNull { it.optString("id") == container }?.optString("role") != "reader"))
        if (canAdd) {
            val chips = FlowRow(context, Pv.rem(0.375f))
            chips.addView(chip("folder", Sx.t("Новая папка", "New folder")) { newFolder() })
            chips.addView(chip("upload", Sx.t("Загрузить файл", "Upload file")) { pick() })
            if (place == "drive" && container == null && folder == null)
                chips.addView(chip("users", Sx.t("Новая общая папка", "New shared folder")) { newShared() })
            body.addView(chips, lp(b = Pv.rem(0.625f)))
        }
        if (place == "trash" && trash().isNotEmpty()) {
            body.addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(context.pvText(Sx.t("Корзина хранится 30 дней", "Trash is kept for 30 days"), 0.8125f, Pv.c.muted),
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(context.pvButton(Sx.t("Очистить", "Empty"), "danger") {
                    PvSheet.confirm(context, Sx.t("Очистить корзину?", "Empty trash?"), Sx.t("Всё из корзины удалится навсегда.", "Everything in the trash is deleted forever."),
                        Sx.t("Очистить", "Empty"), danger = true) {
                        files("purge", JSONObject().put("container", rootId()).put("nodes", JSONArray(trash().map { it.optString("id") })))
                    }
                })
            }, lp(b = Pv.rem(0.375f)))
        }
        val list = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        body.addView(list, lp(l = -Pv.rem(0.625f), r = -Pv.rem(0.625f)))
        var rows = 0
        when {
            query.isNotEmpty() -> found().forEach { list.addView(nodeRow(it)); rows++ }
            place == "shared" && container == null -> shared().forEach { c -> list.addView(containerRow(c, isOwn = false)); rows++ }
            place == "links" -> Sx.list(links).forEach { l -> list.addView(linkRow(l)); rows++ }
            place == "trash" -> trash().forEach { list.addView(nodeRow(it, inTrash = true)); rows++ }
            else -> {
                if (container == null && folder == null) owned().forEach { c -> list.addView(containerRow(c, isOwn = true)); rows++ }
                visible().forEach { list.addView(nodeRow(it)); rows++ }
            }
        }
        if (rows == 0) list.addView(context.pvText(when {
            query.isNotEmpty() -> Sx.t("Ничего не найдено", "Nothing found")
            place == "shared" -> Sx.t("С вами пока ничем не поделились", "Nothing is shared with you yet")
            place == "links" -> Sx.t("Ссылок пока нет. Создать — «⋮» у файла или папки", "No links yet. Create one from a file or folder menu")
            place == "trash" -> Sx.t("Корзина пуста", "Trash is empty")
            else -> Sx.t("Здесь пусто", "Empty here")
        }, 0.9375f, Pv.c.muted).apply { gravity = Gravity.CENTER; setPadding(0, Pv.rem(2.5f), 0, Pv.rem(2.5f)) }, lp())
        if (query.isEmpty() && place == "drive" && container == null && folder == null) {
            val sharedCount = shared().size
            list.addView(virtualRow("shared", if (sharedCount > 0) Sx.t("Папок: $sharedCount", "Folders: $sharedCount") else Sx.t("Пока пусто", "Nothing yet")))
            val linkCount = links?.length() ?: 0
            list.addView(virtualRow("links", if (linkCount > 0) Sx.t("Ссылок: $linkCount", "Links: $linkCount") else Sx.t("Ссылок пока нет", "No links yet")))
            val trashCount = trash().size
            list.addView(virtualRow("trash", if (trashCount > 0) Sx.t("Элементов: $trashCount", "Items: $trashCount") else Sx.t("Корзина пуста", "Trash is empty")))
        }
        s.optJSONObject("usage")?.let { u ->
            // Ответ ядра `parvaneCloudUsage`: {used, quota, maxFile, linksBytes}; копии ссылок уже входят в used
            val used = u.optLong("used", 0)
            val quota = u.optLong("quota", 0)
            if (quota > 0) body.addView(context.pvText(Sx.t("Занято ${size(used)} из ${size(quota)} · файлы шифруются на устройстве, сервер видит только зашифрованные блоки",
                "${size(used)} of ${size(quota)} used · files are encrypted on the device, the server sees only encrypted blocks"),
                0.8125f, Pv.c.muted), lp(t = Pv.rem(0.875f)))
        }
    }

    private fun virtualName(view: String) = when (view) {
        "shared" -> Sx.t("Доступные мне", "Shared with me")
        "links" -> Sx.t("Мои ссылки", "My links")
        else -> Sx.t("Корзина", "Trash")
    }

    private fun virtualRow(view: String, hint: String): View = context.listRow(
        context.ava(Pv.c.fg, icon = when (view) { "shared" -> "users"; "links" -> "link"; else -> "trash" }), virtualName(view), hint) {
        place = view; container = null; folder = null
        if (view == "links") Sx.async({ ParvaneSections.cloudFiles("links") }) { r -> links = (r as? JSONObject)?.optJSONArray("links") ?: JSONArray(); rerender() }
        rerender()
    }

    private fun chip(icon: String, text: String, onClick: () -> Unit): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
        addView(context.pvIcon(icon, Pv.c.muted, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.375f) })
        addView(context.pvText(text, 0.8125f, Pv.c.muted, maxLines = 1))
        Pv.pressable(this, 0, 0.9375f, Pv.c.line2, onClick)
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(1.875f))
    }

    /** Сортировка (`.sortPill`): 2,625 rem, рамка line2; выбор — шторкой. */
    private fun sortPill(): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(1f), 0, Pv.rem(0.75f), 0)
        addView(context.pvText(sortName(sort), 0.9375f, Pv.c.fg))
        addView(context.pvIcon(if (descending) "down" else "up", Pv.c.fg, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.375f) })
        Pv.pressable(this, Pv.c.panel, 1.3125f, Pv.c.line2) {
            val keys = listOf("name", "date", "size")
            PvSheet.choose(context, Sx.t("Сортировка", "Sort"), keys.map { k -> sortName(k) + if (k == sort) (if (descending) " ↓" else " ↑") else "" }) { i ->
                if (keys[i] == sort) descending = !descending else { sort = keys[i]; descending = keys[i] != "name" }
                rerender()
            }
        }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.625f))
    }

    private fun sortName(k: String) = when (k) { "date" -> Sx.t("Дата", "Date"); "size" -> Sx.t("Размер", "Size"); else -> Sx.t("Имя", "Name") }

    private fun sorted(list: List<JSONObject>): List<JSONObject> {
        val cmp: Comparator<JSONObject> = when (sort) {
            "date" -> compareBy { it.optLong("mtime") }
            "size" -> compareBy { it.optLong("size") }
            else -> compareBy { it.optString("name").lowercase() }
        }
        return list.sortedWith(compareBy<JSONObject> { it.optString("kind") != "folder" }.then(if (descending) cmp.reversed() else cmp))
    }

    private fun visible() = sorted(nodes().filter { !it.optBoolean("trashed") && !isService(it) && parentOf(it) == folder })

    private fun found(): List<JSONObject> {
        val q = query.trim()
        val all = (listOfNotNull(rootId()) + others().map { it.optString("id") }).flatMap { nodesOf(it) }
        return sorted(all.filter { !it.optBoolean("trashed") && !isService(it) && it.optString("name").contains(q, ignoreCase = true) })
    }

    private fun nodeRow(n: JSONObject, inTrash: Boolean = false): View {
        val isFolder = n.optString("kind") == "folder"
        val isVault = container == null && parentOf(n) == null && n.optString("id") == vault()?.optString("id")
        val incoming = container != null && others().firstOrNull { it.optString("id") == container }?.optString("kind") == "shared"
        val color = when {
            isVault -> Pv.c.yellow
            incoming -> Pv.c.purple
            isFolder -> Pv.c.blue
            else -> Pv.c.fg
        }
        val mime = n.optString("mime")
        val icon = if (isFolder) "folder" else if (mime.startsWith("image/")) "image" else "note"
        val sub = when {
            inTrash -> Sx.t("В корзине", "In trash")
            isVault -> Sx.t("хранилище заметок · .md", "notes vault · .md")
            isFolder -> Sx.t("Элементов: ${nodes().count { parentOf(it) == n.optString("id") && !it.optBoolean("trashed") && !isService(it) }}",
                "Items: ${nodes().count { parentOf(it) == n.optString("id") && !it.optBoolean("trashed") && !isService(it) }}")
            else -> listOf(size(n.optLong("size")), date(n.optLong("mtime"))).filter { it.isNotEmpty() }.joinToString(" · ")
        }
        val dots = context.pvIconButton("dots", Sx.t("Действия", "Actions"), Pv.c.muted) {
            if (inTrash) trashMenu(n) else if (isFolder) folderMenu(n) else fileMenu(n)
        }
        return context.listRow(context.ava(color, icon = icon), n.optString("name"), sub, dots) {
            when {
                inTrash -> trashMenu(n)
                isFolder -> { folder = n.optString("id"); query = ""; rerender() }
                onPickFile(n, containerId() ?: "") -> Unit
                else -> fileMenu(n)
            }
        }
    }

    private fun linkRow(l: JSONObject): View {
        val state = when (l.optString("state")) { "ready", "active" -> ""; "revoked" -> Sx.t("отозвана", "revoked"); "expired" -> Sx.t("истекла", "expired"); else -> l.optString("state") }
        val exp = l.optLong("expiresAt").takeIf { it > 0 }?.let { Sx.t("до ${date(it * 1000)}", "until ${date(it * 1000)}") } ?: Sx.t("без срока", "no expiry")
        val sub = listOf(state, exp, size(l.optLong("bytes"))).filter { it.isNotEmpty() }.joinToString(" · ")
        val active = l.optString("state") in listOf("ready", "active")
        return context.listRow(context.ava(if (active) Pv.c.blue else Pv.c.muted, icon = "link"), l.optString("name").ifEmpty { l.optString("id") }, sub) {
            val url = l.optString("url")
            val items = mutableListOf<Pair<String, () -> Unit>>()
            if (url.isNotEmpty() && active) {
                items += Sx.t("Копировать", "Copy") to { copy(url) }
                items += Sx.t("Поделиться", "Share") to { share(url) }
                items += Sx.t("Продлить", "Extend") to { ttl { d -> files("linkExtend", JSONObject().put("id", l.optString("id")).put("ttlDays", d)) { loadLinks() } } }
                items += Sx.t("Отозвать", "Revoke") to { files("linkRevoke", JSONObject().put("id", l.optString("id"))) { loadLinks() } }
            }
            if (items.isNotEmpty()) Kn.menu(context, l.optString("name").ifEmpty { Sx.t("Ссылка", "Link") }, items, dangerLast = true)
        }
    }

    private fun loadLinks(): Unit = Sx.async({ ParvaneSections.cloudFiles("links") }) { r ->
        links = (r as? JSONObject)?.optJSONArray("links") ?: JSONArray()
        rerender()
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
        try { (context as Activity).startActivityForResult(intent, PICK) } catch (e: Throwable) { toast(Sx.t("Нет приложения для выбора файлов", "No file picker")) }
    }

    fun upload(uris: List<Uri>) {
        val target = containerId() ?: return
        val parent = folder
        val ctx = context
        busy = Sx.t("Загрузка: ${uris.size}…", "Uploading ${uris.size}…")
        rerender()
        Sx.async({
            val tmp = File(ctx.cacheDir, "parvane-upload").apply { mkdirs() }
            var failed = 0
            uris.forEachIndexed { i, uri ->
                val (name, mime) = describe(ctx, uri)
                val f = File(tmp, "u$i")
                try {
                    ctx.contentResolver.openInputStream(uri)?.use { input -> f.outputStream().use { input.copyTo(it) } }
                    val args = JSONObject().put("container", target).put("parent", parent ?: "")
                        .put("path", f.absolutePath).put("name", name).put("mime", mime)
                    val thumb = CloudThumbs.attach(args, f, mime)
                    val r = try { ParvaneSections.cloudFiles("upload", args) as? JSONObject } finally { thumb?.delete() }
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
            refreshUsage()
            rerender()
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
        val ctx = context
        busy = Sx.t("Скачивание «${n.optString("name")}»…", "Downloading “${n.optString("name")}”…")
        rerender()
        val from = containerId()
        Sx.async({
            val tmp = File(ctx.cacheDir, "parvane-download").apply { mkdirs() }
            val f = File(tmp, "d-" + System.nanoTime())
            try {
                val r = ParvaneSections.cloudFiles("download", JSONObject().put("container", from).put("node", n.optString("id")).put("out", f.absolutePath)) as? JSONObject
                if (r?.optBoolean("ok") != true) return@async false
                saveToDownloads(ctx, f, n.optString("name"), n.optString("mime"))
            } finally {
                f.delete()
            }
        }) { ok ->
            busy = null
            toast(if (ok == true) Sx.t("Сохранено в «Загрузки»", "Saved to Downloads") else Sx.t("Не скачано", "Download failed"))
            rerender()
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

    private fun trash(n: JSONObject) = files("trash", JSONObject().put("nodes", JSONArray().put(n.optString("id"))))

    private fun fileMenu(n: JSONObject) = Kn.menu(context, n.optString("name"), listOf(
        Sx.t("Скачать", "Download") to { download(n) },
        Sx.t("Переименовать", "Rename") to { rename(n) },
        Sx.t("Переместить", "Move") to { move(n) },
        Sx.t("Ссылка для всех", "Public link") to { createLink(n) },
        Sx.t("В корзину", "Move to trash") to { trash(n) },
    ), dangerLast = true)

    private fun folderMenu(n: JSONObject) {
        val items = mutableListOf<Pair<String, () -> Unit>>(
            Sx.t("Открыть", "Open") to { folder = n.optString("id"); rerender() },
            Sx.t("Переименовать", "Rename") to { rename(n) },
            Sx.t("Переместить", "Move") to { move(n) },
            Sx.t("Ссылка для всех", "Public link") to { createLink(n) },
        )
        if (container == null) items += Sx.t("Общий доступ", "Share") to {
            busy = Sx.t("Папка становится общей…", "Sharing folder…")
            rerender()
            files("shareFolder", JSONObject().put("node", n.optString("id"))) { busy = null; rerender() }
        }
        items += Sx.t("В корзину", "Move to trash") to { trash(n) }
        Kn.menu(context, n.optString("name"), items, dangerLast = true)
    }

    private fun trashMenu(n: JSONObject) = Kn.menu(context, n.optString("name"), listOf(
        Sx.t("Восстановить", "Restore") to { files("restore", JSONObject().put("container", rootId()).put("nodes", JSONArray().put(n.optString("id")))) },
        Sx.t("Удалить навсегда", "Delete forever") to { files("purge", JSONObject().put("container", rootId()).put("nodes", JSONArray().put(n.optString("id")))) },
    ), dangerLast = true)

    private fun containerRow(c: JSONObject, isOwn: Boolean): View {
        val top = nodesOf(c.optString("id")).count { parentOf(it) == null && !it.optBoolean("trashed") && !isService(it) }
        return context.listRow(context.ava(if (isOwn) Pv.c.blue else Pv.c.purple, icon = if (isOwn) "users" else "folder"),
            c.optString("name").ifEmpty { Sx.t("Общая папка", "Shared folder") },
            if (isOwn) Sx.t("Объектов: $top · общая", "Items: $top · shared") else Sx.t("Элементов: $top", "Items: $top"),
            onLong = { if (isOwn) ownContainerMenu(c) else containerMenu(c) }) { container = c.optString("id"); folder = null; rerender() }
    }

    /** Своя общая папка: удалить её (для всех участников) — не «покинуть». */
    private fun ownContainerMenu(c: JSONObject) = Kn.menu(context, c.optString("name"), listOf(
        Sx.t("Удалить общую папку", "Delete shared folder") to {
            PvSheet.confirm(context, Sx.t("Удалить общую папку?", "Delete the shared folder?"),
                Sx.t("Папка и её файлы удалятся у всех участников.", "The folder and its files are deleted for everyone."), Sx.t("Удалить", "Delete"), danger = true) {
                Sx.async({ ParvaneSections.cloudCall("parvaneCloudRemoveShared", JSONObject().put("container", c.optString("id")).toString()) }) { container = null; rerender() }
            }
        },
    ), dangerLast = true)

    private fun containerMenu(c: JSONObject) = Kn.menu(context, c.optString("name"), listOf(
        Sx.t("Покинуть папку", "Leave folder") to {
            PvSheet.confirm(context, Sx.t("Покинуть совместную папку?", "Leave the shared folder?"), c.optString("name"), Sx.t("Покинуть", "Leave"), danger = true) {
                Sx.async({ ParvaneSections.cloudCall("parvaneCloudLeave", JSONObject().put("container", c.optString("id")).toString()) }) { container = null; rerender() }
            }
        },
    ), dangerLast = true)

    private fun rename(n: JSONObject): Unit = Kn.askText(context, Sx.t("Новое имя", "New name"), n.optString("name")) { name ->
        files("rename", JSONObject().put("node", n.optString("id")).put("name", name))
    }

    private fun newFolder(): Unit = Kn.askText(context, Sx.t("Новая папка", "New folder"), "", Sx.t("Создать", "Create")) { name ->
        files("createFolder", JSONObject().put("name", name).put("parent", folder ?: ""))
    }

    /** Новая общая папка: папка в личном диске и сразу «Общий доступ». */
    private fun newShared(): Unit = Kn.askText(context, Sx.t("Новая общая папка", "New shared folder"), "", Sx.t("Создать", "Create")) { name ->
        files("createFolder", JSONObject().put("name", name).put("parent", "")) { r ->
            val id = r?.optString("id")?.takeIf { it.isNotEmpty() } ?: nodes().firstOrNull { it.optString("name") == name && parentOf(it) == null }?.optString("id")
            if (id != null) {
                busy = Sx.t("Папка становится общей…", "Sharing folder…")
                rerender()
                files("shareFolder", JSONObject().put("node", id)) { busy = null; rerender() }
            }
        }
    }

    private fun move(n: JSONObject) {
        val folders = nodes().filter { it.optString("kind") == "folder" && !it.optBoolean("trashed") && it.optString("id") != n.optString("id") }
        val items = mutableListOf<Pair<String, () -> Unit>>()
        items += Sx.t("Облако (корень)", "Cloud (root)") to { files("move", JSONObject().put("nodes", JSONArray().put(n.optString("id"))).put("parent", "")) }
        folders.forEach { f -> items += f.optString("name") to { files("move", JSONObject().put("nodes", JSONArray().put(n.optString("id"))).put("parent", f.optString("id"))) } }
        Kn.menu(context, Sx.t("Переместить в…", "Move to…"), items)
    }

    private fun createLink(n: JSONObject): Unit = ttl { days ->
        busy = Sx.t("Создаётся ссылка…", "Creating link…")
        rerender()
        files("linkCreate", JSONObject().put("node", n.optString("id")).put("name", n.optString("name")).put("ttlDays", days)) { r ->
            busy = null
            loadLinks()
            r?.optJSONObject("link")?.optString("url")?.takeIf { it.isNotEmpty() }?.let { url ->
                Kn.menu(context, Sx.t("Ссылка готова", "Link ready"), listOf(
                    Sx.t("Копировать", "Copy") to { copy(url) },
                    Sx.t("Поделиться", "Share") to { share(url) },
                ))
            }
        }
    }

    private fun ttl(done: (Int) -> Unit) {
        val values = intArrayOf(1, 7, 30, 0)
        PvSheet.choose(context, Sx.t("Срок ссылки", "Link expiry"),
            listOf(Sx.t("1 день", "1 day"), Sx.t("7 дней", "7 days"), Sx.t("30 дней", "30 days"), Sx.t("Без срока", "No expiry"))) { done(values[it]) }
    }

    private fun copy(text: String) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("Parvane", text))
        toast(Sx.t("Скопировано", "Copied"))
    }

    private fun share(text: String): Unit = try {
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), null))
    } catch (e: Throwable) { }

    private fun size(bytes: Long): String = when {
        bytes <= 0 -> ""
        bytes < 1024 -> "$bytes ${Sx.t("Б", "B")}"
        bytes < 1024 * 1024 -> String.format(java.util.Locale.US, "%.1f %s", bytes / 1024.0, Sx.t("КБ", "KB"))
        bytes < 1024L * 1024 * 1024 -> String.format(java.util.Locale.US, "%.1f %s", bytes / 1048576.0, Sx.t("МБ", "MB"))
        else -> String.format(java.util.Locale.US, "%.1f %s", bytes / 1073741824.0, Sx.t("ГБ", "GB"))
    }

    private fun date(ms: Long): String = if (ms <= 0) "" else java.text.SimpleDateFormat("d MMM", java.util.Locale.getDefault()).format(java.util.Date(ms)).trimEnd('.')
}

/** Ряд с переносом (`flex-wrap`): дети слева направо, промежуток [gap] по обеим осям. */
class FlowRow(context: Context, private val gap: Int) : ViewGroup(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val maxW = MeasureSpec.getSize(widthMeasureSpec)
        var x = 0; var y = 0; var rowH = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            val lp = c.layoutParams
            c.measure(MeasureSpec.makeMeasureSpec(maxW, MeasureSpec.AT_MOST),
                if (lp != null && lp.height > 0) MeasureSpec.makeMeasureSpec(lp.height, MeasureSpec.EXACTLY) else MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            if (x > 0 && x + c.measuredWidth > maxW) { x = 0; y += rowH + gap; rowH = 0 }
            x += c.measuredWidth + gap
            rowH = maxOf(rowH, c.measuredHeight)
        }
        setMeasuredDimension(maxW, y + rowH)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val maxW = r - l
        var x = 0; var y = 0; var rowH = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            if (x > 0 && x + c.measuredWidth > maxW) { x = 0; y += rowH + gap; rowH = 0 }
            c.layout(x, y, x + c.measuredWidth, y + c.measuredHeight)
            x += c.measuredWidth + gap
            rowH = maxOf(rowH, c.measuredHeight)
        }
    }
}

/**
 * Миниатюра картинки при загрузке в облако, как web (`cloudDrive.ts`): JPEG не больше 320 точек по длинной стороне.
 * Без неё «Файлы» и мелкие карточки холста на других устройствах показывали значок вместо картинки.
 */
object CloudThumbs {
    private const val MAX_SIDE = 320
    private const val QUALITY = 80

    /** Кладёт `thumbPath`/`thumbWidth`/`thumbHeight` в [args]; возвращает временный файл (удалить после загрузки). */
    fun attach(args: JSONObject, file: File, mime: String?): File? {
        if (mime?.startsWith("image/") != true || mime == "image/svg+xml") return null
        return try {
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeFile(file.absolutePath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
            val src = android.graphics.BitmapFactory.decodeFile(file.absolutePath, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
                ?: return null
            val k = minOf(1f, MAX_SIDE.toFloat() / maxOf(src.width, src.height))
            val w = maxOf(1, (src.width * k).toInt())
            val h = maxOf(1, (src.height * k).toInt())
            val scaled = if (w == src.width && h == src.height) src else android.graphics.Bitmap.createScaledBitmap(src, w, h, true)
            // JPEG без прозрачности: прозрачное — на белом
            val out = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.RGB_565)
            android.graphics.Canvas(out).apply { drawColor(0xffffffff.toInt()); drawBitmap(scaled, 0f, 0f, null) }
            if (scaled !== src) scaled.recycle()
            src.recycle()
            val thumb = File(file.parentFile, file.name + ".thumb.jpg")
            thumb.outputStream().use { out.compress(android.graphics.Bitmap.CompressFormat.JPEG, QUALITY, it) }
            out.recycle()
            args.put("thumbPath", thumb.absolutePath).put("thumbWidth", w).put("thumbHeight", h)
            thumb
        } catch (e: Throwable) {
            null
        }
    }
}
