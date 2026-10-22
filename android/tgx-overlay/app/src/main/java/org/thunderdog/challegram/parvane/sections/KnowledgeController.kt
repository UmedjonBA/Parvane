package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.content.Context
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme

/**
 * Parvane (spec 031, T064/T065): раздел «Знания» — папки, заметки (поиск по названию и тексту), заметка дня,
 * граф связей и холсты. Хранилище — `NotesStore` ядра (заметки — файлы облака, общие с web и desktop);
 * экран зовёт его операции (`create`, `createFolder`, `openDaily`…), заметку открывает [NoteController].
 */
class KnowledgeController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section = "knowledge"
    override val tab = ParvaneTabBar.Tab.KNOWLEDGE
    override fun getId() = R.id.controller_parvaneKnowledge
    override fun getName(): CharSequence = Sx.t("Знания", "Knowledge")

    private var mode = "notes" // notes | graph | canvases
    private var folder: String? = null
    private var query = ""
    private var snap: JSONObject? = null
    private var searchField: EditText? = null

    override fun onBuilt() {
        watch("notes") { s ->
            snap = s
            s.optString("guideOpenId").takeIf { it.isNotEmpty() && it != "null" }?.let { id ->
                Sx.async({ ParvaneSections.notes("consumeGuideOpen") }) { }
                NoteController.open(this, id)
            }
            render()
        }
        if (snap == null) render()
    }

    private fun notes() = Sx.list(snap?.optJSONArray("notes"))
    private fun folders() = Sx.list(snap?.optJSONArray("folders"))
    private fun canvases() = Sx.list(snap?.optJSONArray("canvases"))

    private fun render(): Unit = rebuild {
        tabs(listOf("notes" to Sx.t("Заметки", "Notes"), "graph" to Sx.t("Граф", "Graph"), "canvases" to Sx.t("Холсты", "Canvases")), mode) {
            mode = it
            render()
        }
        val s = snap
        if (s == null || s.optString("status") != "ready") {
            placeholder(Sx.t("Загрузка заметок…", "Loading notes…"))
            return@rebuild
        }
        when (mode) {
            "graph" -> addView(NotesGraphView(context, notes()) { id -> NoteController.open(this@KnowledgeController, id) },
                lp(h = Sx.dp(520f), t = Sx.dp(8f)))
            "canvases" -> renderCanvases()
            else -> renderNotes()
        }
    }

    private fun LinearLayout.renderNotes() {
        val actions = context.hbox().apply { setPadding(Sx.dp(8f), Sx.dp(4f), Sx.dp(8f), 0) }
        actions.addView(context.chip(Sx.t("Новая заметка", "New note"), false) { newNote() })
        actions.addView(context.chip(Sx.t("Сегодня", "Today"), false) { openDaily() })
        actions.addView(context.chip(Sx.t("Новая папка", "New folder"), false) { newFolder() })
        addView(android.widget.HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(actions) })
        val search = (searchField ?: EditText(context).also { searchField = it }).apply {
            (parent as? android.view.ViewGroup)?.removeView(this)
            hint = Sx.t("Поиск по заметкам", "Search notes")
            setSingleLine()
            setTextColor(Sx.color(ColorId.text))
            setHintTextColor(Sx.color(ColorId.textPlaceholder))
            background = rounded(Sx.color(ColorId.filling), 12f)
            setPadding(Sx.dp(14f), Sx.dp(10f), Sx.dp(14f), Sx.dp(10f))
            if (tag == null) {
                tag = "watch"
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun afterTextChanged(e: Editable?) {
                        query = e?.toString().orEmpty().trim()
                        render()
                        searchField?.let { f -> f.post { f.requestFocus(); f.setSelection(f.text.length) } }
                    }
                })
            }
        }
        addView(search, lp(t = Sx.dp(8f), l = Sx.dp(12f), r = Sx.dp(12f)))
        val fs = folders()
        if (fs.isNotEmpty()) {
            val chips = context.hbox().apply { setPadding(Sx.dp(8f), Sx.dp(8f), Sx.dp(8f), 0) }
            chips.addView(context.chip(Sx.t("Все", "All"), folder == null) { folder = null; render() })
            fs.forEach { f ->
                val id = f.optString("id")
                chips.addView(context.chip(f.optString("name"), folder == id) { folder = id; render() }.apply {
                    setOnLongClickListener { folderMenu(f); true }
                })
            }
            addView(android.widget.HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(chips) })
        }
        val folderPath = fs.firstOrNull { it.optString("id") == folder }?.optString("path")
        val q = query.lowercase()
        val list = notes().filter { n ->
            (folderPath == null || n.optString("folder") == folderPath || n.optString("folder").startsWith("$folderPath/")) &&
                (q.isEmpty() || n.optString("title").lowercase().contains(q) || n.optString("text").lowercase().contains(q))
        }.sortedByDescending { it.optLong("updatedAt") }
        if (list.isEmpty()) placeholder(if (q.isEmpty()) Sx.t("Заметок пока нет", "No notes yet") else Sx.t("Ничего не найдено", "Nothing found"))
        list.forEach { n ->
            val row = context.vbox().apply {
                setPadding(Sx.dp(14f), Sx.dp(12f), Sx.dp(14f), Sx.dp(12f))
                layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(12f), r = Sx.dp(12f))
                pressable { NoteController.open(this@KnowledgeController, n.optString("id")) }
            }
            row.addView(context.label(n.optString("title"), 16f, bold = true, maxLines = 1))
            val preview = NoteText.preview(n.optString("text"))
            val meta = listOf(n.optString("folder"), preview).filter { it.isNotEmpty() }.joinToString(" · ")
            if (meta.isNotEmpty()) row.addView(context.label(meta, 13f, ColorId.textLight, maxLines = 2))
            addView(row)
        }
    }

    private fun LinearLayout.renderCanvases() {
        addView(context.action(Sx.t("Новый холст", "New canvas")) {
            askText(Sx.t("Название холста", "Canvas name"), "") { title ->
                Sx.async({ ParvaneSections.notes("saveCanvas", JSONObject().put("title", title)
                    .put("text", JSONObject().put("nodes", org.json.JSONArray()).put("edges", org.json.JSONArray()).toString()).toString()) }) { id ->
                    (id as? String)?.let { CanvasController.open(this@KnowledgeController, it) }
                }
            }
        })
        val list = canvases()
        if (list.isEmpty()) placeholder(Sx.t("Холстов пока нет", "No canvases yet"))
        list.forEach { c ->
            addView(context.label(c.optString("title"), 16f, bold = true).apply {
                setPadding(Sx.dp(14f), Sx.dp(14f), Sx.dp(14f), Sx.dp(14f))
                layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(12f), r = Sx.dp(12f))
                pressable { CanvasController.open(this@KnowledgeController, c.optString("id")) }
                setOnLongClickListener {
                    AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(c.optString("title"))
                        .setItems(arrayOf(Sx.t("Переименовать", "Rename"), Sx.t("Удалить", "Delete"))) { _, which ->
                            if (which == 0) askText(Sx.t("Название холста", "Canvas name"), c.optString("title")) { t ->
                                Sx.async({ ParvaneSections.notes("renameCanvas", JSONObject().put("id", c.optString("id")).put("title", t).toString()) }) { }
                            } else Sx.async({ ParvaneSections.notes("deleteCanvas", JSONObject().put("id", c.optString("id")).toString()) }) { }
                        }.show()
                    true
                }
            })
        }
    }

    fun askText(title: String, value: String, done: (String) -> Unit) {
        val input = EditText(context()).apply {
            setText(value)
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            setTextColor(Sx.color(ColorId.text))
        }
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(title)
            .setView(context().vbox(Sx.dp(20f)).apply { addView(input) })
            .setPositiveButton(android.R.string.ok) { _, _ -> input.text.toString().trim().takeIf { it.isNotEmpty() }?.let(done) }
            .setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
        input.requestFocus()
    }

    private fun newNote() = askText(Sx.t("Название заметки", "Note title"), "") { title ->
        val args = JSONObject().put("title", title).put("text", "")
        folder?.let { args.put("folderId", it) }
        Sx.async({ ParvaneSections.notes("create", args.toString()) }) { id ->
            if (id is String) NoteController.open(this, id, edit = true)
            else toast(Sx.t("Заметка не создана — такое название уже есть?", "Note not created — the title may already exist"))
        }
    }

    private fun openDaily(): Unit = Sx.async({ ParvaneSections.notes("openDaily", JSONObject().put("day", Sx.today()).toString()) }) { id ->
        if (id is String) NoteController.open(this, id)
    }

    private fun newFolder() = askText(Sx.t("Название папки", "Folder name"), "") { name ->
        Sx.async({ ParvaneSections.notes("createFolder", JSONObject().put("name", name).toString()) }) { r ->
            (r as? JSONObject)?.optString("error")?.takeIf { it.isNotEmpty() && it != "null" }?.let { toast(Sx.t("Папка не создана: $it", "Folder not created: $it")) }
        }
    }

    private fun folderMenu(f: JSONObject) {
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(f.optString("name"))
            .setItems(arrayOf(Sx.t("Переименовать", "Rename"), Sx.t("Удалить папку, заметки — наверх", "Delete folder, keep notes"),
                Sx.t("Удалить вместе с заметками", "Delete with notes"))) { _, which ->
                val id = f.optString("id")
                when (which) {
                    0 -> askText(Sx.t("Название папки", "Folder name"), f.optString("name")) { name ->
                        Sx.async({ ParvaneSections.notes("renameFolder", JSONObject().put("id", id).put("name", name).toString()) }) { }
                    }
                    1 -> Sx.async({ ParvaneSections.notes("deleteFolder", JSONObject().put("id", id).put("mode", "move").toString()) }) { folder = null }
                    else -> Sx.async({ ParvaneSections.notes("deleteFolder", JSONObject().put("id", id).put("mode", "with-notes").toString()) }) { folder = null }
                }
            }.show()
    }
}
