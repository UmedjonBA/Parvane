package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.text.InputType
import android.widget.EditText
import org.drinkless.tdlib.Client
import org.drinkless.tdlib.TdApi
import org.json.JSONObject
import org.parvane.core.ParvaneCore
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.data.TD
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import org.thunderdog.challegram.tool.UI
import java.io.File

/**
 * Parvane (spec 031, T067): связь чатов с разделами, как web/desktop — «Сохранить в облако» в меню сообщения,
 * в меню чата «Отправить из облака», «Предложить в план» (задание `task_offer`, TASK-1) и «Статья» (заметка
 * «Знаний» целиком, ARTICLE-1). Файлы — через ядро (`CloudFiles`), сообщения — обычной отправкой шва.
 */
object CloudBridge {
    private fun toast(text: String) = UI.showToast(text, android.widget.Toast.LENGTH_SHORT)

    /** Файлы сообщения — в корень личного диска «Облака». */
    @JvmStatic
    fun saveFiles(owner: ViewController<*>, files: List<TD.DownloadedFile>?) {
        if (files.isNullOrEmpty()) return
        toast(Sx.t("Сохраняется в облако…", "Saving to Cloud…"))
        Sx.async({
            ParvaneSections.show("files")
            val root = waitRoot() ?: return@async -1
            files.count { f ->
                val path = f.path ?: return@count false
                val name = File(path).name.let { n -> if (n.contains('.')) n else n + extFor(f.mimeType) }
                val args = JSONObject().put("container", root).put("path", path)
                    .put("name", name).put("mime", f.mimeType ?: "application/octet-stream")
                val thumb = CloudThumbs.attach(args, File(path), f.mimeType)
                val r = try { ParvaneSections.cloudFiles("upload", args) as? JSONObject } finally { thumb?.delete() }
                r?.optBoolean("ok") == true
            }
        }) { n ->
            toast(when {
                n == null || n < 0 -> Sx.t("Облако ещё не готово", "Cloud is not ready yet")
                n == files.size -> Sx.t("Сохранено в облако", "Saved to Cloud")
                else -> Sx.t("Сохранено файлов: $n из ${files.size}", "Saved $n of ${files.size} files")
            })
        }
    }

    /** Личный диск: снимок облака приходит после показа раздела — ждём до 20 с. */
    private fun waitRoot(): String? {
        repeat(40) {
            ParvaneSections.snapshot("cloud")?.optString("rootId")?.takeIf { it.isNotEmpty() && it != "null" }?.let { return it }
            Thread.sleep(500)
        }
        return null
    }

    private fun extFor(mime: String?): String = when {
        mime == null -> ""
        mime.startsWith("image/jpeg") -> ".jpg"
        mime.startsWith("image/png") -> ".png"
        mime.startsWith("video/mp4") -> ".mp4"
        mime == "application/pdf" -> ".pdf"
        else -> ""
    }

    /** Выход из аккаунта: расшифрованные копии файлов облака, отправленных в чаты, не остаются в кэше. */
    @JvmStatic
    fun clearSendCache(ctx: android.content.Context) {
        try { File(ctx.cacheDir, "parvane-send").deleteRecursively() } catch (_: Throwable) {}
    }

    /** Меню чата → «Отправить из облака»: выбор файла в «Облаке», скачивание и отправка документом. */
    @JvmStatic
    fun attachFromCloud(owner: ViewController<*>, chatId: Long) {
        val picker = CloudController(owner.context(), owner.tdlib())
        picker.onPick = { node, container ->
            toast(Sx.t("Файл готовится…", "Preparing file…"))
            Sx.async({
                val dir = File(owner.context().cacheDir, "parvane-send").apply { mkdirs() }
                // открытые копии прежних отправок не копим: старше часа удаляем (текущая отправка уже загружена)
                dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 3_600_000L }?.forEach { it.delete() }
                val out = File(dir, node.optString("name").replace('/', '_').ifEmpty { "file" })
                val r = ParvaneSections.cloudFiles("download", JSONObject().put("container", container).put("node", node.optString("id")).put("out", out.absolutePath)) as? JSONObject
                if (r?.optBoolean("ok") == true) out else null
            }) { file ->
                if (file == null) { toast(Sx.t("Файл не скачан", "File not downloaded")); return@async }
                val content = TdApi.InputMessageDocument(TdApi.InputDocument(TdApi.InputFileLocal(file.absolutePath), null, false), TdApi.FormattedText("", arrayOf()))
                owner.tdlib().send(TdApi.SendMessage(chatId, null, null, null, null, content)) { _, error ->
                    if (error != null) Sx.main.post { toast(Sx.t("Не отправлено", "Not sent")) }
                }
            }
        }
        owner.navigateTo(picker)
    }

    /** Меню чата → «Предложить в план»: название, день и время (необязательно) → задание `task_offer`. */
    @JvmStatic
    fun suggestPlan(owner: ViewController<*>, chatId: Long) {
        val ctx = owner.context()
        val form = ctx.vbox(Sx.dp(20f))
        val name = EditText(ctx).apply {
            hint = Sx.t("Что сделать", "What to do"); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            setTextColor(Sx.color(ColorId.text)); form.addView(this)
        }
        val description = EditText(ctx).apply {
            hint = Sx.t("Подробности (необязательно)", "Details (optional)"); setTextColor(Sx.color(ColorId.text)); form.addView(this)
        }
        var day = ""
        var start = ""
        val when_ = ctx.label(Sx.t("Без даты", "No date"), 15f, ColorId.textNeutral).apply {
            setPadding(0, Sx.dp(12f), 0, Sx.dp(12f))
            form.addView(this)
        }
        when_.setOnClickListener {
            val c = Sx.calendarOf(day.ifEmpty { Sx.today() })
            DatePickerDialog(ctx, Theme.dialogTheme(), { _, y, m, d ->
                day = String.format(java.util.Locale.US, "%04d-%02d-%02d", y, m + 1, d)
                TimePickerDialog(ctx, Theme.dialogTheme(), { _, h, mm -> start = Sx.clock(h * 60 + mm); when_.text = "${Sx.dayTitle(day)} $start" }, 10, 0, true).apply {
                    setButton(TimePickerDialog.BUTTON_NEUTRAL, Sx.t("Без времени", "No time")) { _, _ -> start = ""; when_.text = Sx.dayTitle(day) }
                }.show()
                when_.text = Sx.dayTitle(day)
            }, c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH), c.get(java.util.Calendar.DAY_OF_MONTH)).show()
        }
        AlertDialog.Builder(ctx, Theme.dialogTheme()).setTitle(Sx.t("Предложить в план", "Suggest for plan")).setView(form)
            .setPositiveButton(Sx.t("Отправить", "Send")) { _, _ ->
                val n = name.text.toString().trim()
                if (n.isEmpty()) return@setPositiveButton
                val address = Client.addressOfChat(chatId) ?: return@setPositiveButton
                val content = JSONObject().put("kind", "task_offer").put("name", n)
                    .put("description", description.text.toString().trim())
                    .put("text", Sx.t("Задание: $n", "Task: $n") + if (day.isNotEmpty()) " — ${Sx.dayTitle(day)}${if (start.isNotEmpty()) " $start" else ""}" else "")
                if (day.isNotEmpty()) content.put("day", day)
                if (start.isNotEmpty()) content.put("start", start).put("minutes", 60)
                Sx.async({ ParvaneCore.sendContent(address, content.toString(), "") }) { id ->
                    if (id.isNullOrEmpty()) toast(Sx.t("Не отправлено", "Not sent"))
                }
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    /** Меню чата → «Статья»: заметка «Знаний» целиком (`article`); получатель читает её и может сохранить к себе. */
    @JvmStatic
    fun sendArticle(owner: ViewController<*>, chatId: Long) {
        ParvaneSections.show("knowledge")
        val notes = Sx.list(Sx.last("notes")?.optJSONArray("notes") ?: ParvaneSections.snapshot("notes")?.optJSONArray("notes"))
            .sortedByDescending { it.optLong("updatedAt") }
        if (notes.isEmpty()) { toast(Sx.t("Заметок пока нет — откройте «Знания»", "No notes yet — open Knowledge")); return }
        AlertDialog.Builder(owner.context(), Theme.dialogTheme()).setTitle(Sx.t("Статья из заметки", "Article from a note"))
            .setItems(notes.map { it.optString("title") }.toTypedArray()) { _, which ->
                val n = notes[which]
                val markdown = NoteText.bodyWithoutProperties(n.optString("text"))
                if (markdown.length > 65536) { toast(Sx.t("Заметка слишком длинная для статьи", "The note is too long for an article")); return@setItems }
                val address = Client.addressOfChat(chatId) ?: return@setItems
                val content = JSONObject().put("kind", "article").put("title", n.optString("title")).put("markdown", markdown)
                    .put("text", "📄 ${n.optString("title")}\n${NoteText.preview(markdown)}".take(600))
                Sx.async({ ParvaneCore.sendContent(address, content.toString(), "") }) { id ->
                    if (id.isNullOrEmpty()) toast(Sx.t("Не отправлено", "Not sent"))
                }
            }.show()
    }
}
