package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.text.InputType
import android.widget.LinearLayout
import org.drinkless.tdlib.Client
import org.thunderdog.challegram.BuildConfig
import org.thunderdog.challegram.tool.UI

/**
 * Parvane: «Сообщить об ошибке» (как web `ParvaneBugReportModal`, desktop `ShowBugReportBox`): описание и журнал
 * клиента этого запуска уходят E2E-сообщением с JSON-вложением на `bugs@<домен сервера>` (шов `Client.sendBugReport`).
 * Журнал — строки logcat СВОЕГО процесса с тегами Parvane (чужие приложения приложению не видны); текстов сообщений
 * шов в журнал не пишет (P-46), адреса скрывает шов, ключи и токены — здесь.
 */
object BugReport {
    private const val MAX_LINES = 3000
    private val tags = Regex("""\s[VDIWEF]/(parvane|Parvane\w*)\s*\(""")
    // Ключ восстановления (XXXX-XXXX-…) и длинные токены/ключи (base64/hex) — не в отчёт
    private val recoveryKey = Regex("""\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){5,}\b""")
    private val token = Regex("""[A-Za-z0-9+/_=-]{40,}""")

    fun show(ctx: Context) {
        val c = Pv.c
        val sheet = PvSheet.create(ctx, Sx.t("Сообщить об ошибке", "Report a bug"))
        sheet.add(ctx.pvText(Sx.t("Опишите, что случилось. К описанию приложится журнал приложения этого запуска — без текстов сообщений, адресов и ключей.",
            "Describe what happened. The app log of this session is attached — without message texts, addresses or keys."), 0.9375f, c.muted))
        val input = with(Kn) { ctx.input(hint = Sx.t("Что пошло не так", "What went wrong"), multiline = true) }.apply {
            minLines = 4
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        sheet.add(input)
        val status = ctx.pvText("", 0.875f, c.muted).apply { visibility = android.view.View.GONE }
        sheet.add(status, 0.5f)
        lateinit var send: LinearLayout
        send = ctx.pvButton(Sx.t("Отправить", "Send"), "acc") {
            val text = input.text.toString().trim()
            if (text.isEmpty()) return@pvButton
            send.isEnabled = false
            send.alpha = 0.6f
            status.visibility = android.view.View.VISIBLE
            status.setTextColor(c.muted)
            status.text = Sx.t("Отправляем…", "Sending…")
            Sx.async({ Client.sendBugReport(text, log(), BuildConfig.VERSION_NAME, ctx.cacheDir) }) { r ->
                if (r == "sent") {
                    sheet.dismiss()
                    UI.showToast(Sx.t("Отчёт отправлен, спасибо", "Report sent, thank you"), android.widget.Toast.LENGTH_SHORT)
                    return@async
                }
                send.isEnabled = true
                send.alpha = 1f
                status.setTextColor(c.red)
                status.text = if (r == "not_found") Sx.t("На сервере нет адреса для отчётов", "The server has no bug report address")
                    else Sx.t("Не получилось отправить, попробуйте ещё раз", "Could not send, try again")
            }
        }
        sheet.add(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.END
            addView(ctx.pvButton(Sx.t("Отмена", "Cancel"), "ghost") { sheet.dismiss() })
            addView(send.apply { (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f) })
        })
        sheet.show()
    }

    /** Строки журнала этого процесса с тегами Parvane (последние [MAX_LINES]). */
    private fun log(): List<String> = try {
        val p = ProcessBuilder("logcat", "-d", "-v", "time", "--pid", android.os.Process.myPid().toString())
            .redirectErrorStream(true).start()
        val lines = p.inputStream.bufferedReader().useLines { seq -> seq.filter { tags.containsMatchIn(it) }.toList() }
        p.waitFor()
        lines.takeLast(MAX_LINES).map { token.replace(recoveryKey.replace(it, "<ключ>"), "<скрыто>") }
    } catch (e: Throwable) {
        listOf("журнал недоступен: ${e.javaClass.simpleName}")
    }
}
