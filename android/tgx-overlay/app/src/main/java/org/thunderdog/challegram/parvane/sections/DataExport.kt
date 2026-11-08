package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.content.Context
import android.net.Uri
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
 * «План», заметки, контакты, по желанию — файлы облака). Сборка — ядро (`runDataExport`) во временный файл приложения,
 * архив — туда, куда пользователь укажет в системном окне выбора места (как Telegram), без общих «Загрузок». Всё
 * берётся с устройства; на сервер ничего не уходит.
 */
object DataExport {
    fun start(context: Context) {
        val form = context.vbox(Sx.dp(20f))
        val media = CheckBox(context).apply { text = Sx.t("Вложения (фото, видео, файлы)", "Attachments (photos, videos, files)"); isChecked = true; setTextColor(Sx.color(ColorId.text)) }
        val cloud = CheckBox(context).apply { text = Sx.t("Файлы «Облака»", "Cloud files"); setTextColor(Sx.color(ColorId.text)) }
        form.addView(context.label(Sx.t("Архив ZIP: переписка, «План», заметки, контакты. Место сохранения выберете сами.",
            "ZIP archive: chats, plan, notes, contacts. You choose where to save it."), 14f, ColorId.textLight))
        form.addView(media)
        form.addView(cloud)
        AlertDialog.Builder(context, Theme.dialogTheme()).setTitle(Sx.t("Выгрузить мои данные", "Export my data")).setView(form)
            .setPositiveButton(Sx.t("Выгрузить", "Export")) { _, _ ->
                val includeMedia = media.isChecked
                val includeCloud = cloud.isChecked
                // Сначала место (как Telegram): отказ — ничего не собирается и не остаётся на устройстве
                SaveTo.pick(context, defaultName(), "application/zip") { uri -> if (uri != null) run(context, uri, includeMedia, includeCloud) }
            }
            .setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun defaultName() = "parvane-export-" + java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date()) + ".zip"

    private fun run(context: Context, target: Uri, includeMedia: Boolean, includeCloud: Boolean) {
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
            try {
                val r = ParvaneSections.exportData(meta, tmp.absolutePath)
                if (r.optBoolean("ok")) {
                    val saved = SaveTo.write(context, target, tmp)
                    r.put("saved", saved)
                    if (saved) r.put("savedAs", SaveTo.label(context, target))
                } else SaveTo.discard(context, target)
                r
            } catch (e: Throwable) {
                SaveTo.discard(context, target)
                throw e
            } finally {
                tmp.delete()
            }
        }) { r ->
            ParvaneCore.removeListener(listener)
            progress.dismiss()
            val text = when {
                r == null -> Sx.t("Выгрузка не удалась", "Export failed")
                r.optBoolean("ok") && r.optBoolean("saved") -> Sx.t("Готово: сохранено «${r.optString("savedAs")}». Чатов: ${r.optInt("chats")}, сообщений: ${r.optInt("messages")}",
                    "Done: saved “${r.optString("savedAs")}”. Chats: ${r.optInt("chats")}, messages: ${r.optInt("messages")}")
                r.optBoolean("ok") -> Sx.t("Архив собран, но не записан в выбранное место", "Archive built but could not be written to the chosen place")
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
}
