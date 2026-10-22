package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.CheckBox
import org.drinkless.tdlib.Client
import org.json.JSONObject
import org.parvane.core.ParvaneCore
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import java.io.File

/**
 * Parvane (spec 031, T039): «Выгрузить мои данные» — ZIP как у web/desktop (переписка JSON+HTML, вложения,
 * «План», заметки, контакты, по желанию — файлы облака). Сборка — ядро (`runDataExport`), архив сохраняется в
 * «Загрузки». Всё берётся с устройства; на сервер ничего не уходит.
 */
object DataExport {
    fun start(context: Context) {
        val form = context.vbox(Sx.dp(20f))
        val media = CheckBox(context).apply { text = Sx.t("Вложения (фото, видео, файлы)", "Attachments (photos, videos, files)"); isChecked = true; setTextColor(Sx.color(ColorId.text)) }
        val cloud = CheckBox(context).apply { text = Sx.t("Файлы «Облака»", "Cloud files"); setTextColor(Sx.color(ColorId.text)) }
        form.addView(context.label(Sx.t("Архив ZIP: переписка, «План», заметки, контакты. Сохранится в «Загрузки».",
            "ZIP archive: chats, plan, notes, contacts. Saved to Downloads."), 14f, ColorId.textLight))
        form.addView(media)
        form.addView(cloud)
        AlertDialog.Builder(context, Theme.dialogTheme()).setTitle(Sx.t("Выгрузить мои данные", "Export my data")).setView(form)
            .setPositiveButton(Sx.t("Выгрузить", "Export")) { _, _ -> run(context, media.isChecked, cloud.isChecked) }
            .setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun run(context: Context, includeMedia: Boolean, includeCloud: Boolean) {
        val status = context.label(Sx.t("Подготовка…", "Preparing…"), 15f)
        val progress = AlertDialog.Builder(context, Theme.dialogTheme()).setTitle(Sx.t("Выгрузка данных", "Data export"))
            .setView(context.vbox(Sx.dp(20f)).apply { addView(status) })
            .setNegativeButton(Sx.t("Отменить", "Cancel")) { _, _ -> ParvaneSections.exportCancel() }
            .setCancelable(false).show()
        val listener = ParvaneCore.Listener { e ->
            if (e.optString("type") != "export_progress") return@Listener
            val text = when (e.optString("stage")) {
                "chats" -> Sx.t("Чаты: ${e.optLong("done")} из ${e.optLong("total")}", "Chats: ${e.optLong("done")} of ${e.optLong("total")}")
                "planner" -> Sx.t("«План»…", "Plan…")
                "notes" -> Sx.t("Заметки: ${e.optLong("done")} из ${e.optLong("total")}", "Notes: ${e.optLong("done")} of ${e.optLong("total")}")
                "contacts" -> Sx.t("Контакты…", "Contacts…")
                "cloud" -> Sx.t("Облако: ${e.optLong("done")} из ${e.optLong("total")}", "Cloud: ${e.optLong("done")} of ${e.optLong("total")}")
                "finishing" -> Sx.t("Завершение…", "Finishing…")
                else -> Sx.t("Подготовка…", "Preparing…")
            }
            Sx.main.post { status.text = text }
        }
        ParvaneCore.addListener(listener)
        val tmp = File(context.cacheDir, "parvane-export-${System.nanoTime()}.zip")
        Sx.async({
            val meta = Client.exportMeta().put("includeMedia", includeMedia).put("includeCloud", includeCloud)
                .put("drive", Sx.t("Мой диск", "My drive")).put("labels", labels())
            val r = ParvaneSections.exportData(meta, tmp.absolutePath)
            if (r.optBoolean("ok")) {
                val saved = save(context, tmp, r.optString("fileName").ifEmpty { "parvane-export.zip" })
                r.put("saved", saved)
            }
            tmp.delete()
            r
        }) { r ->
            ParvaneCore.removeListener(listener)
            progress.dismiss()
            val text = when {
                r == null -> Sx.t("Выгрузка не удалась", "Export failed")
                r.optBoolean("ok") && r.optBoolean("saved") -> Sx.t("Готово: ${r.optString("fileName")} в «Загрузках». Чатов: ${r.optInt("chats")}, сообщений: ${r.optInt("messages")}",
                    "Done: ${r.optString("fileName")} in Downloads. Chats: ${r.optInt("chats")}, messages: ${r.optInt("messages")}")
                r.optBoolean("ok") -> Sx.t("Архив собран, но не сохранён в «Загрузки»", "Archive built but not saved to Downloads")
                r.optString("error") == "canceled" -> Sx.t("Выгрузка отменена", "Export canceled")
                r.optString("error") == "too-large" -> Sx.t("Слишком большой архив — попробуйте без вложений", "Archive too large — try without attachments")
                else -> Sx.t("Выгрузка не удалась", "Export failed")
            }
            AlertDialog.Builder(context, Theme.dialogTheme()).setMessage(text).setPositiveButton(android.R.string.ok, null).show()
        }
    }

    private fun labels() = JSONObject()
        .put("title", Sx.t("Выгрузка данных Parvane", "Parvane data export")).put("chats", Sx.t("Чаты", "Chats"))
        .put("planner", Sx.t("План", "Plan")).put("notes", Sx.t("Заметки", "Notes")).put("contacts", Sx.t("Контакты", "Contacts"))
        .put("cloud", Sx.t("Файлы облака", "Cloud files")).put("savedMessages", Sx.t("Избранное", "Saved Messages"))
        .put("replyTo", Sx.t("В ответ на", "In reply to")).put("forwardedFrom", Sx.t("Переслано от", "Forwarded from"))
        .put("edited", Sx.t("изменено", "edited")).put("mediaNotIncluded", Sx.t("Вложение не включено", "Media not included"))
        .put("mediaUnavailable", Sx.t("Вложение недоступно", "Media unavailable")).put("poll", Sx.t("Опрос", "Poll"))
        .put("location", Sx.t("Место", "Location")).put("messages", Sx.t("сообщений", "messages"))
        .put("exportedAt", Sx.t("Выгружено", "Exported")).put("privacyOn", Sx.t("включил(а) усиленную приватность", "enabled enhanced privacy"))
        .put("privacyOff", Sx.t("выключил(а) усиленную приватность", "disabled enhanced privacy"))

    private fun save(ctx: Context, f: File, name: String): Boolean = try {
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "application/zip")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            uri != null && ctx.contentResolver.openOutputStream(uri)?.use { out -> f.inputStream().use { it.copyTo(out) }; true } == true
        } else {
            @Suppress("DEPRECATION")
            f.copyTo(File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name), overwrite = true)
            true
        }
    } catch (e: Throwable) {
        false
    }
}
