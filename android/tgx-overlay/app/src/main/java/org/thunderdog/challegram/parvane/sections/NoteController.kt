package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.method.LinkMovementMethod
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.parvane.sections.Kn.ava
import org.thunderdog.challegram.parvane.sections.Kn.grpTitle
import org.thunderdog.challegram.parvane.sections.Kn.input
import org.thunderdog.challegram.parvane.sections.Kn.listRow
import org.thunderdog.challegram.telegram.Tdlib

/**
 * Parvane (spec 031/032): заметка «Знаний» в виде телефонной версии web (`NoteView`): шапка — папка и карандаш,
 * «‹ Знания», название крупно, чип папки (нажатие — перенести), Markdown со ссылками `[[…]]`, кнопки «Изменить» и
 * «Удалить», обратные ссылки. Правка — поле текста; сохранение с базовым текстом (конфликт с другим устройством
 * решает ядро). Ссылка на несуществующую заметку предлагает её создать.
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
    private var lastSnap: JSONObject? = null

    override fun getName(): CharSequence = title.ifEmpty { Sx.t("Заметка", "Note") }

    companion object {
        fun open(owner: ViewController<*>, id: String, edit: Boolean = false) {
            owner.navigateTo(NoteController(owner.context(), owner.tdlib()).also { it.noteId = id; it.editing = edit })
        }

        /** Экран заметки на этом id (для переходов из других разделов, например заметки дня на «Сегодня»). */
        @JvmStatic
        fun forNote(context: Context, tdlib: Tdlib, noteId: String): NoteController =
            NoteController(context, tdlib).also { it.noteId = noteId }
    }

    override fun buildHeader(context: Context): View? = header(null)

    /** Шапка заметки (`.noteBar` + `.hdr`): папка мелким заголовком и карандаш (в правке — «Готово»). */
    private fun header(n: JSONObject?): View = context().pvHeader().apply {
        setPadding(Pv.rem(0.75f), Pv.rem(0.5f), Pv.rem(0.5f), Pv.rem(0.5f))
        val folder = n?.let { if (it.optBoolean("isDaily")) Sx.t("Ежедневные", "Daily") else it.optString("folder").takeIf { f -> f.isNotEmpty() }?.let { f -> Kn.folderCaption(f) } }
            ?: Sx.t("Без папки", "No folder")
        addView(context.pvText(if (n == null) "" else folder, 1f, Pv.c.muted, semibold = true, maxLines = 1),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (n != null) {
            if (editing) addView(context.pvButton(Sx.t("Сохранить", "Save"), "acc") { save() })
            else addView(context.pvIconButton("edit", Sx.t("Изменить", "Edit"), Pv.c.muted) { startEdit() })
        }
    }

    override fun onBuilt() {
        watch("notes") { render(it) }
    }

    private fun note(snap: JSONObject?) = Sx.list(snap?.optJSONArray("notes")).firstOrNull { it.optString("id") == noteId }

    private fun startEdit() {
        editing = true
        editor = null
        lastSnap?.let { render(it) }
    }

    private fun render(snap: JSONObject) {
        lastSnap = snap
        val n = note(snap)
        if (editing && editor != null) return // правка не перебивается снимком
        setHeader(header(n))
        rebuild {
            setPadding(Pv.rem(1f), Pv.rem(0.875f), Pv.rem(1f), Pv.rem(1.5f))
            // «‹ Знания» — ghost-кнопка над названием
            addView(context.pvButton(Sx.t("Знания", "Knowledge"), "ghost", icon = "left") { navigateBack() }.apply {
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.25f)).apply {
                    leftMargin = -Pv.rem(0.5f); topMargin = -Pv.rem(0.25f); bottomMargin = Pv.rem(0.5f)
                }
            })
            if (n == null) {
                placeholder(if (snap.optString("status") == "ready") Sx.t("Заметка не найдена", "Note not found") else Sx.t("Загрузка заметок…", "Loading notes…"))
                return@rebuild
            }
            title = n.optString("title")
            addView(context.pvText(Kn.displayTitle(n), 1.5f, Pv.c.fg, semibold = true).apply {
                typeface = android.graphics.Typeface.create(Pv.semibold(), android.graphics.Typeface.BOLD)
                setOnLongClickListener { rename(n); true }
            })
            // Свойства: чип папки (нажатие — перенести)
            val props = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
            val folderName = if (n.optBoolean("isDaily")) Sx.t("Ежедневные", "Daily")
                else n.optString("folder").takeIf { it.isNotEmpty() }?.let { Kn.folderCaption(it) } ?: Sx.t("Без папки", "No folder")
            props.addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(Pv.rem(0.625f), Pv.rem(0.1875f), Pv.rem(0.625f), Pv.rem(0.1875f))
                addView(context.pvIcon("folder", Pv.c.muted, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.25f) })
                addView(context.pvText(folderName, 0.8125f, Pv.c.muted, maxLines = 1))
                Pv.pressable(this, Pv.c.raised, 0.75f) { move(snap) }
            })
            addView(props, lp(t = Pv.rem(0.375f), b = Pv.rem(1.125f)))
            if (editing) {
                baseText = n.optString("text")
                val field = context.input(n.optString("text"), Sx.t("Пишите в Markdown: # заголовок, - [ ] задача, [[ссылка]]",
                    "Write Markdown: # heading, - [ ] task, [[link]]"), multiline = true).apply {
                    minLines = 14
                    setTextSize(TypedValue.COMPLEX_UNIT_DIP, 15f)
                    typeface = Pv.mono()
                }
                editor = field
                addView(field, lp())
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    addView(context.pvButton(Sx.t("Сохранить", "Save"), "acc", icon = "check") { save() })
                    addView(context.pvButton(Sx.t("Отмена", "Cancel"), "ghost") { cancelEdit() }.apply {
                        (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f)
                    })
                }, lp(t = Pv.rem(1f)))
                field.requestFocus()
                return@rebuild
            }
            val all = Sx.list(snap.optJSONArray("notes"))
            val body = NoteText.bodyWithoutProperties(n.optString("text"))
            if (body.isBlank()) addView(context.pvText(Sx.t("Пусто — нажмите «Изменить»", "Empty — tap “Edit”"), 1f, Pv.c.faint))
            else addView(context.pvText(NoteText.render(body, { t -> openTitle(all, t) }, { url -> openUrl(url) }), 1f, Pv.c.fg).apply {
                movementMethod = LinkMovementMethod.getInstance()
                setLineSpacing(0f, 1.5f / 1.2f)
                highlightColor = Pv.alpha(Pv.c.accent, 22)
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(context.pvButton(Sx.t("Изменить", "Edit"), icon = "edit") { startEdit() })
                addView(context.pvButton(Sx.t("Удалить", "Delete"), "ghost", icon = "trash") { delete(n) }.apply {
                    (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f)
                })
            }, lp(t = Pv.rem(1f), b = Pv.rem(0.375f)))
            val back = all.filter { it.optString("id") != noteId && NoteText.links(it.optString("text")).any { l -> l.equals(title, ignoreCase = true) } }
            if (back.isNotEmpty()) {
                addView(context.grpTitle(Sx.t("Ссылаются сюда", "Linked from")), lp(t = Pv.rem(1f), b = Pv.rem(0.25f)))
                back.forEach { b ->
                    addView(context.listRow(context.ava(Kn.folderColor(b.optString("folder"), b.optBoolean("isDaily")), Kn.avatarText(b)),
                        Kn.displayTitle(b), Kn.previewOf(b).ifEmpty { null }) { open(this@NoteController, b.optString("id")) },
                        lp(l = -Pv.rem(0.625f), r = -Pv.rem(0.625f)))
                }
            }
        }
    }

    private fun cancelEdit() {
        editing = false
        editor = null
        lastSnap?.let { render(it) }
    }

    private fun openTitle(all: List<JSONObject>, t: String) {
        val target = all.firstOrNull { it.optString("title").equals(t, ignoreCase = true) }
        if (target != null) { open(this, target.optString("id")); return }
        PvSheet.confirm(context(), Sx.t("Заметки ещё нет", "No such note yet"), Sx.t("Заметки «$t» нет. Создать?", "No note “$t”. Create it?"),
            Sx.t("Создать", "Create")) {
            Sx.async({ ParvaneSections.notes("create", JSONObject().put("title", t).put("text", "").toString()) }) { id ->
                if (id is String) open(this, id, edit = true)
            }
        }
    }

    private fun openUrl(url: String) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        PvSheet.confirm(context(), Sx.t("Открыть ссылку?", "Open link?"), url, Sx.t("Открыть", "Open")) {
            try { context().startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Throwable) { }
        }
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

    private fun rename(n: JSONObject): Unit = Kn.askText(context(), Sx.t("Название заметки", "Note title"), n.optString("title")) { t ->
        Sx.async({ ParvaneSections.notes("rename", JSONObject().put("id", noteId).put("title", t).toString()) }) { ok ->
            if (ok != true) toast(Sx.t("Не переименовано — такое название уже есть?", "Not renamed — the title may be taken"))
        }
    }

    private fun move(snap: JSONObject) {
        val folders = Sx.list(snap.optJSONArray("folders"))
        val items = mutableListOf<Pair<String, () -> Unit>>()
        items += Sx.t("Без папки", "No folder") to { moveTo(null) }
        folders.forEach { f -> items += Kn.folderCaption(f.optString("path")) to { moveTo(f.optString("id")) } }
        Kn.menu(context(), Sx.t("Перенести в папку", "Move to folder"), items)
    }

    private fun moveTo(folderId: String?) {
        val args = JSONObject().put("id", noteId)
        folderId?.let { args.put("folderId", it) }
        Sx.async({ ParvaneSections.notes("move", args.toString()) }) { }
    }

    private fun delete(n: JSONObject) {
        PvSheet.confirm(context(), Sx.t("Удалить заметку?", "Delete note?"), Sx.t("«${n.optString("title")}» уйдёт в корзину облака.",
            "“${n.optString("title")}” goes to the cloud trash."), Sx.t("Удалить", "Delete"), danger = true) {
            Sx.async({ ParvaneSections.notes("delete", JSONObject().put("id", noteId).toString()) }) { navigateBack() }
        }
    }
}

/** Прежнее имя диалога ввода (его зовут экраны облака). */
object KnowledgeDialogs {
    fun askText(context: Context, title: String, value: String, done: (String) -> Unit) = Kn.askText(context, title, value, done = done)
}
