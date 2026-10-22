package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.InputType
import android.text.method.LinkMovementMethod
import android.view.Gravity
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme

/**
 * Parvane (spec 031, T064): заметка «Знаний» — просмотр Markdown со ссылками `[[…]]`, обратные ссылки,
 * правка текста (сохранение с базовым текстом: конфликт с другим устройством решает ядро), переименование,
 * перенос в папку, удаление. Ссылка на несуществующую заметку предлагает её создать.
 */
class NoteController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section = "knowledge"
    override val tab = ParvaneTabBar.Tab.KNOWLEDGE
    override fun getId() = R.id.controller_parvaneNote

    private var noteId = ""
    private var editing = false
    private var baseText: String? = null
    private var editor: EditText? = null
    private var title = ""

    override fun getName(): CharSequence = title.ifEmpty { Sx.t("Заметка", "Note") }

    companion object {
        fun open(owner: ViewController<*>, id: String, edit: Boolean = false) {
            owner.navigateTo(NoteController(owner.context(), owner.tdlib()).also { it.noteId = id; it.editing = edit })
        }
    }

    override fun onBuilt() {
        watch("notes") { render(it) }
    }

    private fun note(snap: JSONObject?) = Sx.list(snap?.optJSONArray("notes")).firstOrNull { it.optString("id") == noteId }

    private fun render(snap: JSONObject) {
        val n = note(snap)
        if (editing && editor != null) return // правка не перебивается снимком
        rebuild {
            if (n == null) {
                placeholder(Sx.t("Заметка не найдена", "Note not found"))
                return@rebuild
            }
            title = n.optString("title")
            val actions = context.hbox().apply { setPadding(Sx.dp(8f), Sx.dp(8f), Sx.dp(8f), 0) }
            if (!editing) actions.addView(context.chip(Sx.t("Править", "Edit"), false) { editing = true; render(snap) })
            else actions.addView(context.chip(Sx.t("Сохранить", "Save"), true) { save() })
            actions.addView(context.chip(Sx.t("Переименовать", "Rename"), false) { rename(n) })
            actions.addView(context.chip(Sx.t("В папку", "Move"), false) { move(snap) })
            actions.addView(context.chip(Sx.t("Удалить", "Delete"), false) { delete(n) })
            addView(android.widget.HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(actions) })
            addView(context.label(n.optString("title"), 22f, bold = true).apply { layoutParams = lp(t = Sx.dp(12f), l = Sx.dp(18f), r = Sx.dp(18f)) })
            if (n.optString("folder").isNotEmpty()) addView(context.label(n.optString("folder"), 13f, ColorId.textLight).apply { layoutParams = lp(l = Sx.dp(18f)) })
            if (editing) {
                baseText = n.optString("text")
                editor = EditText(context).apply {
                    setText(n.optString("text"))
                    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                    gravity = Gravity.TOP
                    minLines = 12
                    setTextColor(Sx.color(ColorId.text))
                    background = rounded(Sx.color(ColorId.filling), 12f)
                    setPadding(Sx.dp(14f), Sx.dp(12f), Sx.dp(14f), Sx.dp(12f))
                }
                addView(editor, lp(t = Sx.dp(10f), l = Sx.dp(12f), r = Sx.dp(12f)))
                addView(context.label(Sx.t("Markdown: # заголовок, **жирный**, - [ ] задача, [[ссылка на заметку]]",
                    "Markdown: # heading, **bold**, - [ ] task, [[link to note]]"), 12f, ColorId.textLight).apply { layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(18f), r = Sx.dp(18f)) })
                return@rebuild
            }
            val all = Sx.list(snap.optJSONArray("notes"))
            addView(context.card().apply {
                addView(context.label(NoteText.render(n.optString("text"), { t -> openTitle(all, t) }, { url -> openUrl(url) }), 16f).apply {
                    movementMethod = LinkMovementMethod.getInstance()
                    setTextIsSelectable(false)
                    setLineSpacing(0f, 1.15f)
                })
            })
            val back = all.filter { it.optString("id") != noteId && NoteText.links(it.optString("text")).any { l -> l.equals(title, ignoreCase = true) } }
            if (back.isNotEmpty()) {
                addView(context.sectionTitle(Sx.t("Ссылаются сюда", "Linked from")))
                back.forEach { b ->
                    addView(context.label(b.optString("title"), 15f, ColorId.textLink).apply {
                        setPadding(Sx.dp(14f), Sx.dp(10f), Sx.dp(14f), Sx.dp(10f))
                        layoutParams = lp(t = Sx.dp(4f), l = Sx.dp(12f), r = Sx.dp(12f))
                        pressable { open(this@NoteController, b.optString("id")) }
                    })
                }
            }
        }
    }

    private fun openTitle(all: List<JSONObject>, t: String) {
        val target = all.firstOrNull { it.optString("title").equals(t, ignoreCase = true) }
        if (target != null) { open(this, target.optString("id")); return }
        AlertDialog.Builder(context(), Theme.dialogTheme()).setMessage(Sx.t("Заметки «$t» нет. Создать?", "No note “$t”. Create it?"))
            .setPositiveButton(Sx.t("Создать", "Create")) { _, _ ->
                Sx.async({ ParvaneSections.notes("create", JSONObject().put("title", t).put("text", "").toString()) }) { id ->
                    if (id is String) open(this, id, edit = true)
                }
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun openUrl(url: String) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        AlertDialog.Builder(context(), Theme.dialogTheme()).setMessage(Sx.t("Открыть ссылку?\n$url", "Open link?\n$url"))
            .setPositiveButton(Sx.t("Открыть", "Open")) { _, _ ->
                try { context().startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Throwable) { }
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun save() {
        val text = editor?.text?.toString() ?: return
        val args = JSONObject().put("id", noteId).put("text", text)
        baseText?.let { args.put("baseText", it) }
        Sx.async({ ParvaneSections.notes("save", args.toString()) }) { ok ->
            if (ok == true) {
                editing = false
                editor = null
                Sx.last("notes")?.let { render(it) }
            } else toast(Sx.t("Не сохранено — нет связи?", "Not saved — offline?"))
        }
    }

    private fun rename(n: JSONObject): Unit = KnowledgeDialogs.askText(context(), Sx.t("Название заметки", "Note title"), n.optString("title")) { t ->
        Sx.async({ ParvaneSections.notes("rename", JSONObject().put("id", noteId).put("title", t).toString()) }) { ok ->
            if (ok != true) toast(Sx.t("Не переименовано — такое название уже есть?", "Not renamed — the title may be taken"))
        }
    }

    private fun move(snap: JSONObject) {
        val folders = Sx.list(snap.optJSONArray("folders"))
        val names = listOf(Sx.t("Корень", "Root")) + folders.map { it.optString("path") }
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(Sx.t("Перенести в папку", "Move to folder"))
            .setItems(names.toTypedArray()) { _, which ->
                val args = JSONObject().put("id", noteId)
                if (which > 0) args.put("folderId", folders[which - 1].optString("id"))
                Sx.async({ ParvaneSections.notes("move", args.toString()) }) { }
            }.show()
    }

    private fun delete(n: JSONObject) {
        AlertDialog.Builder(context(), Theme.dialogTheme()).setMessage(Sx.t("Удалить заметку «${n.optString("title")}»?", "Delete note “${n.optString("title")}”?"))
            .setPositiveButton(Sx.t("Удалить", "Delete")) { _, _ ->
                Sx.async({ ParvaneSections.notes("delete", JSONObject().put("id", noteId).toString()) }) { navigateBack() }
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }
}

object KnowledgeDialogs {
    fun askText(context: Context, title: String, value: String, done: (String) -> Unit) {
        val input = EditText(context).apply {
            setText(value)
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            setTextColor(Sx.color(ColorId.text))
        }
        AlertDialog.Builder(context, Theme.dialogTheme()).setTitle(title)
            .setView(context.vbox(Sx.dp(20f)).apply { addView(input) })
            .setPositiveButton(android.R.string.ok) { _, _ -> input.text.toString().trim().takeIf { it.isNotEmpty() }?.let(done) }
            .setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
        input.requestFocus()
    }
}
