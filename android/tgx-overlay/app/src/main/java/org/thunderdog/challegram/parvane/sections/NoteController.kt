package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.content.Intent
import android.net.Uri
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
    // Правка: текст черновика (переживает переключение на просмотр) и что показано — редактор либо просмотр
    private var draft: String? = null
    private var previewShown = false
    private var previewToggle: View? = null
    private var title = ""
    private var lastSnap: JSONObject? = null

    override fun getName(): CharSequence = title.ifEmpty { Sx.t("Заметка", "Note") }

    companion object {
        /** Предел ролика для кадра-заставки без миниатюры (как web `VIDEO_THUMB_BACKFILL_MAX`). */
        private const val VIDEO_POSTER_MAX = 64L * 1024 * 1024

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
            else {
                // «Запланировать» в шапке (как web `.noteBar`): в длинной заметке не листать до кнопок в конце
                if (!n.optBoolean("isDaily")) addView(context.pvIconButton("calendar", Sx.t("Запланировать", "Schedule"), Pv.c.muted) { plan(n) })
                addView(context.pvIconButton("edit", Sx.t("Изменить", "Edit"), Pv.c.muted) { startEdit() })
            }
        }
    }

    override fun onBuilt() {
        watch("notes") { render(it) }
    }

    override fun repaint() { lastSnap?.let { render(it) } }

    private fun note(snap: JSONObject?) = Sx.list(snap?.optJSONArray("notes")).firstOrNull { it.optString("id") == noteId }

    /** Встроенный файл заметки (web `NoteEmbed`): картинка — сам файл из облака по ширине экрана; пока грузится,
     *  не картинка или не нашёлся — подпись с именем. */
    /** Файл заметки — во временный каталог, который отдаёт FileProvider X (`files/media`), и системным приложением. */
    private fun openEmbed(context: Context, info: CanvasMedia.FileInfo) {
        val root = (Sx.last("cloud") ?: ParvaneSections.snapshot("cloud"))?.optString("rootId")?.takeIf { it.isNotEmpty() && it != "null" }
            ?: return toast(Sx.t("Облако ещё загружается", "Cloud is still loading"))
        toast(Sx.t("Открываем «${info.name}»…", "Opening “${info.name}”…"))
        Sx.async({
            val dir = java.io.File(context.filesDir, "media/parvane-notes").apply { deleteRecursively(); mkdirs() }
            // Имя выбирает автор заметки или редактор папки: только безопасные символы, без пути
            val f = java.io.File(dir, info.name.substringAfterLast('/').replace(Regex("""[^\p{L}\p{N}._ -]+"""), "_").ifEmpty { "file" })
            val r = ParvaneSections.cloudFiles("download", JSONObject().put("container", root).put("node", info.node).put("out", f.absolutePath)) as? JSONObject
            if (r?.optBoolean("ok") == true) f else null
        }) { f ->
            if (f == null) { toast(Sx.t("Не скачано — нет связи?", "Download failed — offline?")); return@async }
            if (info.kind == "video" && openInPlayer(f, info)) return@async
            val activity = org.thunderdog.challegram.tool.UI.getContext(context)
            if (activity == null || !org.thunderdog.challegram.tool.Intents.openFile(activity, f, info.mime.ifEmpty { "application/octet-stream" }))
                toast(Sx.t("Нет приложения, чтобы открыть файл", "No app to open the file"))
        }
    }

    /** Видео заметки — штатным плеером X (как видео в чате: перемотка, время, звук, во весь экран). */
    private fun openInPlayer(file: java.io.File, info: CanvasMedia.FileInfo): Boolean = try {
        val meta = android.media.MediaMetadataRetriever()
        val (w, h, secs) = try {
            meta.setDataSource(file.absolutePath)
            Triple(meta.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0,
                meta.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0,
                ((meta.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) / 1000).toInt())
        } finally { meta.release() }
        val video = org.drinkless.tdlib.Client.localVideo(file.absolutePath, info.name, info.mime, file.length(), w, h, secs)
        val activity = org.thunderdog.challegram.tool.UI.getContext(context)
        if (video == null || activity == null) false else {
            val item = org.thunderdog.challegram.mediaview.data.MediaItem(activity, tdlib, video, null, null,
                org.drinkless.tdlib.TdApi.FormattedText("", arrayOf()), false)
            val stack = org.thunderdog.challegram.mediaview.data.MediaStack(activity, tdlib)
            stack.set(item)
            org.thunderdog.challegram.mediaview.MediaViewController.openWithStack(this, stack, info.name, null, false)
            android.util.Log.i("ParvaneSections", "заметка: видео открыто плеером X")
            true
        }
    } catch (e: Throwable) {
        android.util.Log.w("ParvaneSections", "заметка: плеер X не открылся: ${e.javaClass.simpleName}")
        false
    }

    /** Кадр видео без миниатюры облака: ролик до 64 МБ скачивается во временный файл, кадр (≤ 1 с) кэшируется
     *  JPEG по узлу облака — повторно не качается. Ролик больше — остаётся строкой «Воспроизвести». */
    private fun loadVideoPoster(context: Context, info: CanvasMedia.FileInfo, done: (android.graphics.Bitmap?) -> Unit) {
        if (info.size > VIDEO_POSTER_MAX) return done(null)
        val root = (Sx.last("cloud") ?: ParvaneSections.snapshot("cloud"))?.optString("rootId")?.takeIf { it.isNotEmpty() && it != "null" }
            ?: return done(null)
        val dir = java.io.File(context.cacheDir, "parvane-note-posters").apply { mkdirs() }
        val key = info.node.replace(Regex("""[^A-Za-z0-9_-]+"""), "_").take(96).ifEmpty { return done(null) }
        val jpg = java.io.File(dir, "$key.jpg")
        Sx.async({
            if (jpg.isFile) return@async android.graphics.BitmapFactory.decodeFile(jpg.absolutePath)
            val tmp = java.io.File(dir, "$key.video")
            try {
                val r = ParvaneSections.cloudFiles("download", JSONObject().put("container", root).put("node", info.node).put("out", tmp.absolutePath)) as? JSONObject
                if (r?.optBoolean("ok") != true) return@async null
                val meta = android.media.MediaMetadataRetriever()
                val frame = try {
                    meta.setDataSource(tmp.absolutePath)
                    val ms = meta.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                    meta.getFrameAtTime(minOf(1_000_000L, ms * 100), android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                } finally { try { meta.release() } catch (_: Throwable) {} }
                frame?.also { b -> jpg.outputStream().use { b.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, it) } }
            } catch (e: Throwable) {
                null
            } finally {
                tmp.delete()
            }
        }) { bmp ->
            if (bmp != null) android.util.Log.i("ParvaneSections", "заметка: кадр видео показан (${bmp.width}×${bmp.height})")
            done(bmp)
        }
    }

    private fun embedView(context: Context, name: String): View {
        val box = android.widget.FrameLayout(context)
        val caption = context.pvText("▫ " + name.substringAfterLast('/'), 0.875f, Pv.c.muted)
        val image = android.widget.ImageView(context).apply {
            adjustViewBounds = true
            scaleType = android.widget.ImageView.ScaleType.FIT_START
            visibility = View.GONE
            clipToOutline = true
            outlineProvider = object : android.view.ViewOutlineProvider() {
                override fun getOutline(view: View, outline: android.graphics.Outline) =
                    outline.setRoundRect(0, 0, view.width, view.height, Pv.rem(0.5f).toFloat())
            }
        }
        box.addView(image, android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        box.addView(caption)
        val play = context.pvText("▶", 1.25f, Pv.c.bg).apply {
            gravity = Gravity.CENTER
            visibility = View.GONE
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(Pv.c.accent)
            }
        }
        box.addView(play, android.widget.FrameLayout.LayoutParams(Pv.rem(3f), Pv.rem(3f), Gravity.CENTER))
        val id = noteId
        fun showPoster(bmp: android.graphics.Bitmap, info: CanvasMedia.FileInfo) {
            image.setImageBitmap(bmp)
            image.visibility = View.VISIBLE
            caption.visibility = View.GONE
            play.visibility = View.VISIBLE
            box.setOnClickListener { openEmbed(context, info) }
        }
        fun show(info: CanvasMedia.FileInfo?) {
            // Видео с миниатюрой облака — кадр со значком ▶, нажатие — плеер X
            if (info != null && info.kind == "video" && info.image != null) {
                showPoster(info.image, info)
                return
            }
            // Видео без миниатюры (залито до 5 ноя 2026 или клиентом без кадра) — кадр из самого ролика
            // (как web `loadVideoPoster`); пока кадра нет, видна строка «Воспроизвести»
            if (info != null && info.kind == "video" && info.node.isNotEmpty()) {
                loadVideoPoster(context, info) { bmp -> if (bmp != null) showPoster(bmp, info) }
            }
            if (info != null && (info.image == null || info.kind == "video" || info.kind == "audio")) {
                // Не картинка (как desktop `EmbedView`): видео и звук — «Воспроизвести» системным проигрывателем,
                // прочее — «Скачать» (открыть системным приложением)
                val playable = info.kind == "video" || info.kind == "audio"
                val action = if (playable) Sx.t("Воспроизвести", "Play") else Sx.t("Открыть", "Open")
                caption.text = "${if (playable) "▶" else "▫"} ${info.name} · ${CanvasMedia.size(info.size)} · $action"
                caption.setTextColor(Pv.c.accent)
                caption.setOnClickListener { openEmbed(context, info) }
                return
            }
            val bmp = info?.image ?: return
            image.setImageBitmap(bmp)
            image.visibility = View.VISIBLE
            caption.visibility = View.GONE
            android.util.Log.i("ParvaneSections", "заметка: встроенная картинка показана (${bmp.width}×${bmp.height})")
        }
        show(CanvasMedia.embed(context, name, id) { show(CanvasMedia.embed(context, name, id) {}) })
        return box
    }

    private fun startEdit() {
        editing = true
        editor = null
        draft = null
        previewShown = false
        lastSnap?.let { render(it) }
    }

    private fun render(snap: JSONObject, force: Boolean = false) {
        lastSnap = snap
        val n = note(snap)
        if (editing && (editor != null || previewShown) && !force) return // правка не перебивается снимком
        showPreviewToggle(editing && n != null)
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
            val all = Sx.list(snap.optJSONArray("notes"))
            if (editing && previewShown) {
                // Просмотр черновика (телефон: одно окно, переключение кнопкой в углу)
                baseText = baseText ?: n.optString("text")
                addView(markdown(all, n, withTasks = false).render(draft ?: n.optString("text"), n.optString("title")), lp())
                addView(editButtons(), lp(t = Pv.rem(1f)))
                return@rebuild
            }
            if (editing) {
                baseText = n.optString("text")
                val field = context.input(draft ?: n.optString("text"), Sx.t("Пишите в Markdown: # заголовок, - [ ] задача, [[ссылка]]",
                    "Write Markdown: # heading, - [ ] task, [[link]]"), multiline = true).apply {
                    minLines = 14
                    setTextSize(TypedValue.COMPLEX_UNIT_DIP, 15f)
                    typeface = Pv.mono()
                }
                editor = field
                field.addTextChangedListener(object : android.text.TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                    override fun afterTextChanged(s: android.text.Editable?) { draft = s?.toString() }
                })
                addView(field, lp())
                addView(editButtons(), lp(t = Pv.rem(1f)))
                field.requestFocus()
                return@rebuild
            }
            val body = NoteText.bodyWithoutProperties(n.optString("text"))
            if (body.isBlank()) addView(context.pvText(Sx.t("Пусто — нажмите «Изменить»", "Empty — tap “Edit”"), 1f, Pv.c.faint))
            // Разбор ядра по всему тексту: номера строк — строки текста заметки (свойства в начале — тоже строки)
            else addView(markdown(all, n, withTasks = true).render(n.optString("text"), n.optString("title")), lp())
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(context.pvButton(Sx.t("Изменить", "Edit"), icon = "edit") { startEdit() })
                if (!n.optBoolean("isDaily")) addView(context.pvButton(Sx.t("Запланировать", "Schedule"), "ghost", icon = "calendar") { plan(n) }.apply {
                    (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f)
                })
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

    /**
     * «Запланировать» (web `handlePlan` → `notePlanLine`): окно «Новая запись» со строкой `[[название]] ` — запись со
     * ссылкой на заметку встаёт в её «Запланировано».
     */
    private fun plan(n: JSONObject) {
        QuickAdd.show(this, "[[${n.optString("title").trim()}]] ")
    }

    private fun cancelEdit() {
        editing = false
        editor = null
        draft = null
        previewShown = false
        lastSnap?.let { render(it) }
    }

    private fun editButtons(): View = LinearLayout(context()).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(context.pvButton(Sx.t("Сохранить", "Save"), "acc", icon = "check") { save() })
        addView(context.pvButton(Sx.t("Отмена", "Cancel"), "ghost") { cancelEdit() }.apply {
            (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f)
        })
    }

    private fun markdown(all: List<JSONObject>, n: JSONObject, withTasks: Boolean) = NoteMarkdown(
        context(),
        onNote = { t -> openTitle(all, t) },
        onUrl = { url -> openUrl(url) },
        onTask = if (withTasks) { line, done -> setTask(n, line, done) } else null,
        embed = { name -> embedView(context(), name) },
        scroll = { scroll },
    )

    /** Кнопка «правка ↔ просмотр» в правом нижнем углу: поверх прокрутки, всегда на месте. */
    private fun showPreviewToggle(shown: Boolean) {
        previewToggle?.let { contentSlot.removeView(it) }
        previewToggle = null
        if (!shown) return
        val ctx = context()
        val button = android.widget.FrameLayout(ctx).apply {
            contentDescription = if (previewShown) Sx.t("Вернуться к правке", "Back to editor") else Sx.t("Показать просмотр", "Show preview")
            addView(ctx.pvIcon(if (previewShown) "edit" else "eye", Pv.c.accentInk, 1.5f),
                android.widget.FrameLayout.LayoutParams(Pv.rem(1.5f), Pv.rem(1.5f), Gravity.CENTER))
            Pv.pressable(this, Pv.c.accent, 1.5f) { togglePreview() }
            elevation = Pv.rem(0.375f).toFloat()
        }
        contentSlot.addView(button, android.widget.FrameLayout.LayoutParams(Pv.rem(3f), Pv.rem(3f), Gravity.BOTTOM or Gravity.END).apply {
            setMargins(0, 0, Pv.rem(1f), Pv.rem(1f))
        })
        previewToggle = button
    }

    private fun togglePreview() {
        editor?.text?.toString()?.let { draft = it }
        previewShown = !previewShown
        editor = null
        lastSnap?.let { render(it, force = true) }
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
        val lower = url.lowercase()
        if (!lower.startsWith("https://") && !lower.startsWith("http://") && !lower.startsWith("mailto:")) return
        PvSheet.confirm(context(), Sx.t("Открыть ссылку?", "Open link?"), url, Sx.t("Открыть", "Open")) {
            try { context().startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Throwable) { }
        }
    }

    /** Галочка пункта (как desktop `NoteView::toggleTask`): ядро меняет `[ ]`/`[x]` в строке и сохраняет заметку. */
    private fun setTask(n: JSONObject, line: Int, done: Boolean) {
        val args = JSONObject().put("id", noteId).put("text", n.optString("text")).put("line", line).put("done", done)
        Sx.async({ ParvaneSections.notes("setTask", args.toString()) }) { ok ->
            if (ok == true) Sx.last("notes")?.let { render(it) } else toast(Sx.t("Не сохранено — нет связи?", "Not saved — offline?"))
        }
    }

    private fun save() {
        val text = editor?.text?.toString() ?: draft ?: note(lastSnap)?.optString("text") ?: return
        val args = JSONObject().put("id", noteId).put("text", text)
        baseText?.let { args.put("baseText", it) }
        Sx.async({ ParvaneSections.notes("save", args.toString()) }) { ok ->
            if (ok == true) {
                editing = false
                editor = null
                draft = null
                previewShown = false
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
