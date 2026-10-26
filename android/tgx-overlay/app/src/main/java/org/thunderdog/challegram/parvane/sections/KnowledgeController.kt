package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.content.Intent
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.parvane.sections.Kn.ava
import org.thunderdog.challegram.parvane.sections.Kn.grpTitle
import org.thunderdog.challegram.parvane.sections.Kn.input
import org.thunderdog.challegram.parvane.sections.Kn.listRow
import org.thunderdog.challegram.telegram.Tdlib

/**
 * Parvane (spec 031/032): раздел «Знания» 1:1 с телефонной версией web (`Knowledge.tsx`): шапка — подчёркнутые вкладки
 * «Заметки · Граф · Холст · Файлы» и лупа (поиск раскрывается на месте вкладок и ищет по текущей вкладке).
 * «Заметки» — список как список чатов: плашка новой справки, группы-папки («Без папки», папки, «Ежедневные») со
 * свёрткой, «+» и «⋮», строки с плиткой-буквой цвета папки; «Граф» и «Холст» — поля во весь экран; «Файлы» — облако.
 * Хранилище — `NotesStore` ядра (заметки — файлы облака, общие с web и desktop); заметку открывает [NoteController].
 */
class KnowledgeController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib),
    org.thunderdog.challegram.navigation.ActivityResultHandler {
    override val section = "knowledge"
    override val tab = ParvaneTabBar.Tab.KNOWLEDGE
    override fun getId() = R.id.controller_parvaneKnowledge
    override fun getName(): CharSequence = Sx.t("Знания", "Knowledge")

    private var view = "notes" // notes | graph | canvas | files
    private var snap: JSONObject? = null
    private var query = ""
    private var searching = false
    private var searchField: EditText? = null
    private val collapsed = HashSet<String>()
    private var allDaily = false
    private var openVaultOnStart = false
    private var graphBoard: KnowledgeGraphBoard? = null
    private var canvasBoard: KnowledgeCanvasBoard? = null
    private lateinit var cloud: CloudPane

    /** Открыть сразу вкладку «Файлы» в папке хранилища заметок («Профиль» → «Хранилище заметок»). */
    fun openFiles(): KnowledgeController = apply { view = "files"; openVaultOnStart = true }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) = cloud.onActivityResult(requestCode, resultCode, data)

    private fun prefs() = context().getSharedPreferences("parvane_knowledge", Context.MODE_PRIVATE)
    private fun guideSeenKey() = "guideSeen:" + (tdlib.myUserId())

    override fun buildHeader(context: Context): View? = header()

    /** Шапка (`.hdr.hdrTabs` на телефоне): вкладки снизу, лупа справа; в поиске — поле на месте вкладок. */
    private fun header(): View = context().pvHeader().apply {
        minimumHeight = 0
        setPadding(Pv.rem(0.625f), if (searching) Pv.rem(0.5f) else Pv.rem(0.375f), Pv.rem(0.5f), if (searching) Pv.rem(0.5f) else 0)
        gravity = if (searching) Gravity.CENTER_VERTICAL else Gravity.BOTTOM
        if (searching) {
            addView(context.pvIconButton("left", Sx.t("Закрыть поиск", "Close search"), Pv.c.muted) { closeSearch() })
            val field = searchField ?: context.input(query, searchLabel()).also { f ->
                searchField = f
                f.addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun afterTextChanged(e: Editable?) = applyQuery(e?.toString().orEmpty())
                })
            }
            (field.parent as? ViewGroup)?.removeView(field)
            field.hint = searchLabel()
            addView(field, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Pv.rem(0.25f); rightMargin = Pv.rem(0.25f) })
            if (query.isNotEmpty()) addView(context.pvIconButton("x", Sx.t("Очистить", "Clear"), Pv.c.muted) { field.setText("") })
            field.post {
                field.requestFocus()
                (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)
                    ?.showSoftInput(field, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
            }
        } else {
            addView(context.pvTabs(listOf("notes" to Sx.t("Заметки", "Notes"), "graph" to Sx.t("Граф", "Graph"),
                "canvas" to Sx.t("Холст", "Canvas"), "files" to Sx.t("Файлы", "Files")), view) { switchTo(it) },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(context.pvIconButton("search", searchLabel(), Pv.c.muted) { openSearch() }.apply {
                (layoutParams as LinearLayout.LayoutParams).apply { gravity = Gravity.CENTER_VERTICAL; bottomMargin = Pv.rem(0.1875f) }
            })
        }
    }

    private fun searchLabel() = when (view) {
        "graph" -> Sx.t("Поиск по графу", "Search graph")
        "canvas" -> Sx.t("Поиск по холсту", "Search canvas")
        "files" -> Sx.t("Поиск файлов", "Search files")
        else -> Sx.t("Поиск по заметкам", "Search notes")
    }

    private fun openSearch() { searching = true; setHeader(header()) }

    private fun closeSearch() {
        searching = false
        searchField?.setText("")
        searchField = null
        applyQuery("")
        setHeader(header())
    }

    private fun applyQuery(q: String) {
        if (q == query) return
        query = q
        graphBoard?.query = q
        canvasBoard?.query = q
        if (::cloud.isInitialized && view == "files") cloud.query = q
        if (view == "notes") render()
        if (searching) setHeader(header())
    }

    private fun switchTo(next: String) {
        if (next == view) return
        canvasBoard?.flush()
        view = next
        query = ""
        graphBoard?.query = ""
        canvasBoard?.query = ""
        if (::cloud.isInitialized) cloud.query = ""
        setHeader(header())
        render()
    }

    override fun repaint() {
        canvasBoard?.repaint()
        graphBoard?.invalidate()
        render()
    }

    override fun onBuilt() {
        cloud = CloudPane(context(), { if (view == "files") render() })
        watch("notes") { s ->
            snap = s
            s.optString("guideOpenId").takeIf { it.isNotEmpty() && it != "null" }?.let { id ->
                Sx.async({ ParvaneSections.notes("consumeGuideOpen") }) { }
                NoteController.open(this, id)
            }
            graphBoard?.setNotes(notes())
            canvasBoard?.setSnapshot(s)
            if (view == "notes") render()
        }
        watch("cloud") { s ->
            cloud.snap = s
            if (openVaultOnStart && s.optString("status") == "ready") { openVaultOnStart = false; cloud.openVault() }
            if (view == "files") render()
        }
        cloud.refreshUsage()
        render()
    }

    override fun performOnBackPressed(fromTop: Boolean, commit: Boolean): Boolean {
        if (searching) { if (commit) closeSearch(); return true }
        if (view == "files" && ::cloud.isInitialized) {
            if (!commit) return true
            if (cloud.back()) return true
        }
        return super.performOnBackPressed(fromTop, commit)
    }

    private fun notes() = Sx.list(snap?.optJSONArray("notes"))
    private fun folders() = Sx.list(snap?.optJSONArray("folders"))

    private fun render() {
        val full = view == "graph" || view == "canvas"
        scroll.visibility = if (full) View.GONE else View.VISIBLE
        graphBoard?.visibility = if (view == "graph") View.VISIBLE else View.GONE
        canvasBoard?.visibility = if (view == "canvas") View.VISIBLE else View.GONE
        if (full) {
            val ready = snap?.optString("status") == "ready"
            if (!ready) { scroll.visibility = View.VISIBLE; rebuild { placeholder(Sx.t("Загрузка заметок…", "Loading notes…")) }; return }
            if (view == "graph" && graphBoard == null) {
                val b = KnowledgeGraphBoard(context(), { id -> NoteController.open(this, id) }, { makeCanvasFromGraph() }) { title -> createNote(title) }
                graphBoard = b
                contentSlot.addView(b, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                b.setNotes(notes())
            }
            if (view == "canvas" && canvasBoard == null) {
                val b = KnowledgeCanvasBoard(context(), this) { id -> NoteController.open(this, id) }
                canvasBoard = b
                contentSlot.addView(b, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                snap?.let { b.setSnapshot(it) }
            }
            return
        }
        rebuild {
            if (view == "files") { cloud.render(this); return@rebuild }
            renderNotes()
        }
    }

    private fun makeCanvasFromGraph() {
        switchTo("canvas")
        canvasBoard?.fromGraph()
    }

    // ── «Заметки» ──────────────────────────────────────────────────────────────

    private class Group(val key: String, val folder: String, val folderId: String?, val isDaily: Boolean, val items: List<JSONObject>, val hidden: Int)

    private fun guideFolder() = Sx.t("Справка Parvane", "Parvane guide")

    private fun groups(list: List<JSONObject>, isSearch: Boolean): List<Group> {
        val fs = folders()
        val byFolder = LinkedHashMap<String, MutableList<JSONObject>>()
        val daily = mutableListOf<JSONObject>()
        list.forEach { n ->
            if (n.optBoolean("isDaily") && Kn.isDayTitle(n.optString("title"))) daily += n
            else byFolder.getOrPut(n.optString("folder")) { mutableListOf() } += n
        }
        val dailyNames = listOf("Ежедневные", "Daily")
        if (!isSearch) {
            fs.forEach { f -> val p = f.optString("path"); if (p !in byFolder && p !in dailyNames) byFolder[p] = mutableListOf() }
            if (fs.isNotEmpty() && "" !in byFolder) byFolder[""] = mutableListOf()
        }
        val idOf = { path: String -> fs.firstOrNull { it.optString("path") == path }?.optString("id") }
        val out = byFolder.entries.sortedBy { it.key }.map { (folder, items) -> Group(folder, folder, idOf(folder), false, items, 0) }.toMutableList()
        if (daily.isNotEmpty()) {
            daily.sortByDescending { it.optString("title") }
            val shown = if (isSearch || allDaily) daily else daily.take(5)
            out += Group("daily", daily[0].optString("folder"), idOf(daily[0].optString("folder")), true, shown, daily.size - shown.size)
        }
        return out
    }

    private fun LinearLayout.renderNotes() {
        setPadding(Pv.rem(1f), Pv.rem(0.875f), Pv.rem(1f), Pv.rem(1.5f))
        val s = snap
        // Как web: до готовности хранилища — маскот загрузки
        if (s == null || s.optString("status") != "ready") {
            placeholder(Sx.t("Загрузка заметок…", "Loading notes…"))
            return
        }
        val all = notes()
        val q = query.trim().lowercase()
        val found = if (q.isEmpty()) null else all.filter { n -> n.optString("title").lowercase().contains(q) || n.optString("text").lowercase().contains(q) }
        val overview = all.firstOrNull { it.optString("folder") == guideFolder() && it.optString("title") in listOf("Обзор", "Overview") }
            ?: all.firstOrNull { it.optString("folder") == guideFolder() }
        if (overview != null && found == null && !prefs().getBoolean(guideSeenKey(), false)) addView(guideNotice(overview), lp(b = Pv.rem(0.5f)))
        if (all.isEmpty()) addView(context.pvText(Sx.t("Заметок пока нет. Заметки — обычные .md в зашифрованной папке «Знания» вашего облака.",
            "No notes yet. Notes are plain .md files in the encrypted “Knowledge” folder of your cloud."), 1f, Pv.c.muted))
        val groups = groups(found ?: all, found != null)
        if (all.isNotEmpty() && groups.isEmpty()) addView(context.pvText(Sx.t("Ничего не найдено", "Nothing found"), 1f, Pv.c.muted))
        groups.forEach { g -> renderGroup(g, found != null) }
        // Кнопки под списком: «+ Новая заметка», «Новая папка»
        addView(LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(context.pvButton(Sx.t("Новая заметка", "New note"), wide = true, icon = "plus") { newNote(null) }.apply {
                layoutParams = LinearLayout.LayoutParams(0, Pv.rem(2.25f), 1f)
            })
            addView(context.pvButton(Sx.t("Новая папка", "New folder"), wide = true, icon = "folder") { newFolder() }.apply {
                layoutParams = LinearLayout.LayoutParams(0, Pv.rem(2.25f), 1f).apply { leftMargin = Pv.rem(0.5f) }
            })
        }, lp(t = Pv.rem(0.75f), b = Pv.rem(0.25f)))
        if (overview == null) addView(context.pvButton(Sx.t("Вернуть справку Parvane", "Restore the Parvane guide"), "ghost", wide = true) {
            Sx.async({ ParvaneSections.notes("restoreGuide") }) { id -> if (id is String) NoteController.open(this@KnowledgeController, id) }
        }, lp(t = Pv.rem(0.5f)))
    }

    /** Плашка новой справки (`.guideNotice`): текст, «Открыть» акцентом, крестик. */
    private fun guideNotice(overview: JSONObject): View = LinearLayout(context()).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(0.75f), Pv.rem(0.5f), Pv.rem(0.25f), Pv.rem(0.5f))
        background = Pv.shape(Pv.c.raised, 0.5f)
        addView(context.pvText(Sx.t("Добавлена папка «${guideFolder()}»: заметки обо всех разделах Parvane",
            "Added the “${guideFolder()}” folder: notes about every Parvane section"), 0.8125f, Pv.c.fg),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = Pv.rem(0.5f) })
        addView(context.pvButton(Sx.t("Открыть", "Open"), "acc") { markGuide(); NoteController.open(this@KnowledgeController, overview.optString("id")) })
        addView(context.pvIconButton("x", Sx.t("Скрыть", "Dismiss"), Pv.c.muted) { markGuide(); render() })
    }

    private fun markGuide() = prefs().edit().putBoolean(guideSeenKey(), true).apply()

    private fun LinearLayout.renderGroup(g: Group, isSearch: Boolean) {
        val isRoot = !g.isDaily && g.folder.isEmpty()
        val caption = when { g.isDaily -> Sx.t("Ежедневные", "Daily"); isRoot -> Sx.t("Без папки", "No folder"); else -> Kn.folderCaption(g.folder) }
        val isCollapsed = !isSearch && g.key in collapsed
        val isTarget = !isSearch && !g.isDaily && (isRoot || g.folderId != null)
        // Шапка папки (`.folderHead`): стрелка свёртки и название капслоком, справа «+» и «⋮»
        val head = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = Pv.rem(2.25f)
            setPadding(0, Pv.rem(0.375f), 0, 0)
        }
        val toggle = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = Pv.rem(1.875f)
            setPadding(Pv.rem(0.25f), 0, Pv.rem(0.25f), 0)
            addView(context.pvIcon(if (isCollapsed) "right" else "down", Pv.c.muted, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.25f) })
            addView(context.grpTitle(caption), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (isCollapsed) addView(context.pvText("${g.items.size + g.hidden}", 0.75f, Pv.c.faint, mono = true).apply {
                (layoutParams as? LinearLayout.LayoutParams)?.leftMargin = Pv.rem(0.375f)
            })
            Pv.pressable(this, 0, 0.375f) {
                if (!collapsed.add(g.key)) collapsed.remove(g.key)
                render()
            }
        }
        head.addView(toggle, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (isTarget) head.addView(context.pvIconButton("plus", Sx.t("Заметка в «$caption»", "Note in “$caption”"), Pv.c.muted) { newNote(g.folderId) }.apply {
            layoutParams = LinearLayout.LayoutParams(Pv.rem(1.875f), Pv.rem(1.875f)).apply { leftMargin = Pv.rem(0.125f) }
        })
        if (isTarget && g.folderId != null) head.addView(context.pvIconButton("dots", Sx.t("Действия с папкой", "Folder actions"), Pv.c.muted) { folderMenu(g) }.apply {
            layoutParams = LinearLayout.LayoutParams(Pv.rem(1.875f), Pv.rem(1.875f)).apply { leftMargin = Pv.rem(0.125f) }
        })
        addView(head, lp())
        if (isCollapsed) return
        g.items.forEach { n ->
            addView(context.listRow(context.ava(Kn.folderColor(n.optString("folder"), n.optBoolean("isDaily")), Kn.avatarText(n)),
                Kn.displayTitle(n), Kn.previewOf(n).ifEmpty { Sx.t("Пусто", "Empty") },
                onLong = { noteMenu(n) }) { NoteController.open(this@KnowledgeController, n.optString("id")) },
                lp(l = -Pv.rem(0.625f), r = -Pv.rem(0.625f)))
        }
        if (g.items.isEmpty()) addView(context.pvText(Sx.t("Пусто — добавить заметку", "Empty — add a note"), 0.8125f, Pv.c.faint).apply {
            setPadding(Pv.rem(1.625f), Pv.rem(0.375f), Pv.rem(0.25f), Pv.rem(0.5f))
            Pv.pressable(this, 0, 0.375f) { newNote(g.folderId) }
        }, lp())
        if (g.hidden > 0) addView(context.pvButton(Sx.t("Показать все (${g.hidden + g.items.size})", "Show all (${g.hidden + g.items.size})"), "ghost", wide = true) {
            allDaily = true; render()
        }, lp())
    }

    private fun noteMenu(n: JSONObject) = Kn.menu(context(), Kn.displayTitle(n), listOf(
        Sx.t("Открыть", "Open") to { NoteController.open(this, n.optString("id")) },
        Sx.t("Переименовать", "Rename") to {
            Kn.askText(context(), Sx.t("Название заметки", "Note title"), n.optString("title")) { t ->
                Sx.async({ ParvaneSections.notes("rename", JSONObject().put("id", n.optString("id")).put("title", t).toString()) }) { ok ->
                    if (ok != true) toast(Sx.t("Не переименовано — такое название уже есть?", "Not renamed — the title may be taken"))
                }
            }
        },
        Sx.t("Перенести в папку", "Move to folder") to {
            val items = mutableListOf<Pair<String, () -> Unit>>()
            items += Sx.t("Без папки", "No folder") to { moveNote(n, null) }
            folders().forEach { f -> items += Kn.folderCaption(f.optString("path")) to { moveNote(n, f.optString("id")) } }
            Kn.menu(context(), Sx.t("Перенести в папку", "Move to folder"), items)
        },
        Sx.t("Удалить", "Delete") to {
            PvSheet.confirm(context(), Sx.t("Удалить заметку?", "Delete note?"), n.optString("title"), Sx.t("Удалить", "Delete"), danger = true) {
                Sx.async({ ParvaneSections.notes("delete", JSONObject().put("id", n.optString("id")).toString()) }) { }
            }
        },
    ), dangerLast = true)

    private fun moveNote(n: JSONObject, folderId: String?) {
        val args = JSONObject().put("id", n.optString("id"))
        folderId?.let { args.put("folderId", it) }
        Sx.async({ ParvaneSections.notes("move", args.toString()) }) { }
    }

    private fun newNote(folderId: String?) = Kn.askText(context(), Sx.t("Новая заметка", "New note"), "", Sx.t("Создать", "Create")) { title ->
        val args = JSONObject().put("title", title).put("text", "")
        folderId?.let { args.put("folderId", it) }
        Sx.async({ ParvaneSections.notes("create", args.toString()) }) { id ->
            if (id is String) NoteController.open(this, id, edit = true)
            else toast(Sx.t("Заметка не создана — такое название уже есть?", "Note not created — the title may already exist"))
        }
    }

    private fun createNote(title: String) {
        Sx.async({ ParvaneSections.notes("create", JSONObject().put("title", title).put("text", "").toString()) }) { id ->
            if (id is String) NoteController.open(this, id, edit = true)
        }
    }

    private fun newFolder() = Kn.askText(context(), Sx.t("Новая папка", "New folder"), "", Sx.t("Создать", "Create")) { name ->
        Sx.async({ ParvaneSections.notes("createFolder", JSONObject().put("name", name).toString()) }) { r ->
            (r as? JSONObject)?.optString("error")?.takeIf { it.isNotEmpty() && it != "null" }?.let { toast(Sx.t("Папка не создана: $it", "Folder not created: $it")) }
        }
    }

    private fun folderMenu(g: Group) {
        val id = g.folderId ?: return
        val name = g.folder.substringAfterLast('/')
        Kn.menu(context(), Kn.folderCaption(g.folder), listOf(
            Sx.t("Новая заметка", "New note") to { newNote(id) },
            Sx.t("Переименовать", "Rename") to {
                Kn.askText(context(), Sx.t("Название папки", "Folder name"), name) { n ->
                    Sx.async({ ParvaneSections.notes("renameFolder", JSONObject().put("id", id).put("name", n).toString()) }) { }
                }
            },
            Sx.t("Удалить папку, заметки — в «Без папки»", "Delete folder, keep notes") to {
                Sx.async({ ParvaneSections.notes("deleteFolder", JSONObject().put("id", id).put("mode", "move").toString()) }) { }
            },
            Sx.t("Удалить вместе с заметками", "Delete with notes") to {
                PvSheet.confirm(context(), Sx.t("Удалить папку?", "Delete folder?"), Sx.t("Папка «$name» уйдёт в корзину вместе с заметками.",
                    "The “$name” folder goes to the trash with its notes."), Sx.t("Удалить", "Delete"), danger = true) {
                    Sx.async({ ParvaneSections.notes("deleteFolder", JSONObject().put("id", id).put("mode", "with-notes").toString()) }) { }
                }
            },
        ), dangerLast = true)
    }
}
