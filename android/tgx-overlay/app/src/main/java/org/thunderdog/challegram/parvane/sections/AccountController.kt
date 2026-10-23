package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.content.Context
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject
import org.parvane.core.ParvaneCore
import org.thunderdog.challegram.R
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import org.thunderdog.challegram.tool.UI

/**
 * Parvane (spec 031, T023/T025–T028): «Аккаунт и устройства» — устройства аккаунта (это устройство, последняя
 * активность, выход: «просто выйти» либо «выйти и сменить ключи», «украдено»), подтверждение привязки нового
 * устройства по коду сверки, вход по ключу восстановления, смена ника (RENAME-1) и удаление аккаунта (DELETE-1).
 * Логика — ядро (`ParvaneCore`), как у desktop `parvane_account_ui`.
 */
class AccountController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section = "chats"
    override val tab = ParvaneTabBar.Tab.PROFILE
    override fun getId() = R.id.controller_parvaneProfile
    override fun getName(): CharSequence = Sx.t("Аккаунт и устройства", "Account and devices")

    override fun onBuilt() { load() }

    private fun load() {
        rebuild { placeholder(Sx.t("Загрузка…", "Loading…")) }
        Sx.async({ ParvaneCore.listDevices() }) { r -> render(r ?: JSONObject()) }
    }

    private fun render(r: JSONObject): Unit = rebuild {
        addView(context.sectionTitle(Sx.t("Устройства", "Devices")))
        val devices = Sx.list(r.optJSONArray("devices"))
        if (devices.isEmpty()) placeholder(Sx.t("Список устройств недоступен — нет связи?", "Device list unavailable — offline?"))
        devices.forEach { d ->
            val card = context.card()
            val current = d.optBoolean("current")
            card.addView(context.label(kindName(d.optString("client_kind")) + if (current) Sx.t(" · это устройство", " · this device") else "", 16f, bold = true))
            val seen = d.optLong("last_seen_ms")
            val meta = listOfNotNull(
                d.optString("device_id").take(12),
                if (seen > 0) Sx.t("был(о) в сети ", "last seen ") + java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(seen)) else null,
                if (!d.optBoolean("in_log", true)) Sx.t("не в журнале устройств", "not in the device log") else null,
            ).joinToString(" · ")
            card.addView(context.label(meta, 13f, ColorId.textLight))
            if (!current) {
                val row = context.hbox()
                row.addView(context.chip(Sx.t("Выйти на нём", "Sign out"), false) { revoke(d.optString("device_id")) })
                row.addView(context.chip(Sx.t("Украдено", "Stolen"), false) { stolen(d.optString("device_id")) })
                card.addView(row)
            }
            addView(card)
        }
        if (r.optBoolean("rotation_needed")) addView(context.label(Sx.t("Нужно сменить ключ подписи устройств — введите ключ восстановления ниже",
            "The device signing key must be rotated — enter your recovery key below"), 13f, ColorId.textNegative).apply { layoutParams = lp(t = Sx.dp(8f), l = Sx.dp(18f), r = Sx.dp(18f)) })
        addView(context.action(Sx.t("Привязать новое устройство", "Link a new device")) {
            info(Sx.t("Войдите в аккаунт на новом устройстве — здесь появится запрос с кодом сверки. Сверьте код и подтвердите.",
                "Sign in on the new device — a request with a verification code appears here. Compare the codes and confirm."))
        })
        if (r.optBoolean("rotation_needed"))
            addView(context.action(Sx.t("Ввести ключ восстановления", "Enter recovery key")) { AccountUi.askRecoveryKey(context(), rotate = true) { load() } })
        addView(context.sectionTitle(Sx.t("Аккаунт", "Account")))
        addView(context.action(Sx.t("Сменить ник", "Change username")) { rename() })
        addView(context.action(Sx.t("Удалить аккаунт", "Delete account"), ColorId.textNegative) { deleteAccount() })
    }

    private fun kindName(kind: String) = when {
        kind.contains("ANDROID", true) -> "Android"
        kind.contains("DESKTOP", true) -> "Desktop"
        kind.contains("WEB", true) -> "Web"
        kind.isEmpty() -> Sx.t("Устройство", "Device")
        else -> kind.removePrefix("CLIENT_KIND_").lowercase().replaceFirstChar { it.uppercase() }
    }

    private fun info(text: String) {
        AlertDialog.Builder(context(), Theme.dialogTheme()).setMessage(text).setPositiveButton(android.R.string.ok, null).show()
    }

    private fun password(title: String, done: (String) -> Unit) {
        val input = EditText(context()).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = Sx.t("Пароль", "Password")
            setTextColor(Sx.color(ColorId.text))
        }
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(title).setView(context().vbox(Sx.dp(20f)).apply { addView(input) })
            .setPositiveButton(android.R.string.ok) { _, _ -> input.text.toString().takeIf { it.isNotEmpty() }?.let(done) }
            .setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun revoke(device: String) {
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(Sx.t("Выйти на устройстве", "Sign out the device"))
            .setItems(arrayOf(Sx.t("Просто выйти", "Just sign out"), Sx.t("Выйти и сменить ключи (нужен пароль)", "Sign out and rotate keys (password)"))) { _, which ->
                val go = { pw: String ->
                    Sx.async({ ParvaneCore.revokeDevice(device, pw, which == 1) }) { r ->
                        toast(if (r?.optBoolean("ok") == true) Sx.t("Устройство отключено", "Device signed out")
                            else Sx.t("Не получилось: ${r?.optString("error_code")}", "Failed: ${r?.optString("error_code")}"))
                        load()
                    }
                }
                if (which == 1) password(Sx.t("Подтвердите паролем", "Confirm with password")) { go(it) } else go("")
            }.show()
    }

    private fun stolen(device: String) {
        AlertDialog.Builder(context(), Theme.dialogTheme())
            .setMessage(Sx.t("Устройство будет отключено, ключи — сменены, собеседники получат предупреждение. Продолжить?",
                "The device will be signed out, keys rotated and contacts warned. Continue?"))
            .setPositiveButton(Sx.t("Украдено", "Stolen")) { _, _ ->
                Sx.async({ ParvaneCore.reportDeviceStolen(device) }) { ok ->
                    toast(if (ok == true) Sx.t("Устройство отключено", "Device signed out") else Sx.t("Не получилось", "Failed"))
                    load()
                }
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun rename() {
        val form = context().vbox(Sx.dp(20f))
        fun field(hint: String, type: Int) = EditText(context()).apply {
            this.hint = hint; inputType = type; setTextColor(Sx.color(ColorId.text)); form.addView(this)
        }
        val nick = field(Sx.t("Новый ник", "New username"), InputType.TYPE_CLASS_TEXT)
        val pw = field(Sx.t("Пароль", "Password"), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val key = field(Sx.t("Ключ восстановления (если спросит)", "Recovery key (if asked)"), InputType.TYPE_CLASS_TEXT)
        form.addView(context().label(Sx.t("Собеседники увидят, что вы сменили ник. Старый ник освободится.",
            "Contacts will see that you changed your username. The old one becomes free."), 12f, ColorId.textLight))
        AlertDialog.Builder(context(), Theme.dialogTheme()).setTitle(Sx.t("Смена ника", "Change username")).setView(form)
            .setPositiveButton(Sx.t("Сменить", "Change")) { _, _ ->
                val n = nick.text.toString().trim().removePrefix("@")
                if (n.isEmpty()) return@setPositiveButton
                Sx.async({ ParvaneCore.renameAccount(n, pw.text.toString(), key.text.toString().trim()) }) { r ->
                    toast(if (r?.optBoolean("ok") == true) Sx.t("Ник изменён", "Username changed")
                        else Sx.t("Не получилось: ${r?.optString("error_code")}", "Failed: ${r?.optString("error_code")}"))
                }
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun deleteAccount() {
        AlertDialog.Builder(context(), Theme.dialogTheme())
            .setMessage(Sx.t("Аккаунт будет удалён через 7 дней. Войдите за это время, чтобы отменить. Переписку и данные на сервере восстановить будет нельзя.",
                "The account will be deleted in 7 days. Sign in during this time to cancel. Messages and data on the server cannot be restored."))
            .setPositiveButton(Sx.t("Удалить", "Delete")) { _, _ ->
                password(Sx.t("Подтвердите паролем", "Confirm with password")) { pw ->
                    Sx.async({ ParvaneCore.deleteAccount(pw) }) { r ->
                        if (r?.optBoolean("ok") == true) toast(Sx.t("Аккаунт будет удалён", "The account is scheduled for deletion"))
                        else toast(Sx.t("Не получилось: ${r?.optString("error_code")}", "Failed: ${r?.optString("error_code")}"))
                    }
                }
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }
}

/**
 * Parvane: окна аккаунта поверх любого экрана X — запрос привязки от нового устройства (код сверки, «Подтвердить»
 * / «Отклонить») и ввод ключа восстановления, когда бот Telegram недоступен (RECOVER-2).
 */
object AccountUi {
    fun init() {
        // DELETE-1: вход в аккаунт, ждущий удаления, — дата и выбор «Восстановить» / «Не входить» (шов ждёт ответа)
        org.drinkless.tdlib.Client.deletionPrompt = { atMs, answer ->
            Sx.main.post {
                val ctx = UI.getUiContext()
                if (ctx == null) answer(false) else {
                    val date = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.LONG, java.text.DateFormat.SHORT).format(java.util.Date(atMs))
                    AlertDialog.Builder(ctx, Theme.dialogTheme()).setTitle(Sx.t("Аккаунт удаляется", "Account is being deleted"))
                        .setMessage(Sx.t("Этот аккаунт будет удалён $date. Восстановить его и войти?",
                            "This account will be deleted on $date. Restore it and sign in?"))
                        .setPositiveButton(Sx.t("Восстановить", "Restore")) { _, _ -> answer(true) }
                        .setNegativeButton(Sx.t("Не входить", "Don’t sign in")) { _, _ -> answer(false) }
                        .setCancelable(false).show()
                }
            }
        }
        org.drinkless.tdlib.Client.noticeSink = { text ->
            val activity = UI.getUiContext() as? android.app.Activity
            if (activity == null) false else { Sx.main.post { PvToast.showInWindow(activity, text) }; true }
        }
        ParvaneCore.addListener { event ->
            when (event.optString("type")) {
                "link_request" -> {
                    val device = event.optString("device_id")
                    val code = event.optString("code")
                    if (org.thunderdog.challegram.BuildConfig.DEBUG && java.io.File("/data/local/tmp/parvane-autolink").canRead()) return@addListener
                    Sx.main.post { confirmLink(device, code) }
                }
                "federation_error" -> federationToast(event.optString("reason"))
                "link_granted", "link_request_gone" -> event.optString("device_id").let { dev -> Sx.main.post { linkDialogs.remove(dev)?.dismiss() } }
                "recovery" -> if (event.optString("state") == "unavailable" || event.optString("state") == "expired")
                    Sx.main.post { UI.getUiContext()?.let { askRecoveryKey(it, rotate = false) {} } }
            }
        }
    }

    private val federationShown = HashMap<String, Long>()

    /** FED-1: понятная причина отказа другого сервера (как desktop/web); одна причина — не чаще раза в 10 с. */
    private fun federationToast(reason: String) {
        val text = when (reason) {
            "disabled" -> Sx.t("На вашем сервере переписка с другими серверами выключена", "Messaging with other servers is turned off on your server")
            "blocked" -> Sx.t("Администратор вашего сервера заблокировал этот сервер", "Your server’s administrator has blocked this server")
            "refused" -> Sx.t("Другой сервер не принимает сообщения с вашего сервера", "The other server does not accept messages from your server")
            "unreachable" -> Sx.t("Другой сервер недоступен. Отправка будет повторена", "The other server is unreachable. Sending will be retried")
            "key_changed" -> Sx.t("Другой сервер сменил ключ. Обратитесь к администратору вашего сервера", "The other server changed its key. Contact your server’s administrator")
            else -> return
        }
        Sx.main.post {
            val now = System.currentTimeMillis()
            if (now - (federationShown[reason] ?: 0L) < 10_000) return@post
            federationShown[reason] = now
            UI.showToast(text, android.widget.Toast.LENGTH_LONG)
        }
    }

    /** Открытые окна подтверждения привязки по устройству: грант, выданный иным путём, и исчезнувший запрос их закрывают. */
    private val linkDialogs = HashMap<String, PvSheet>()

    /**
     * Запрос привязки нового устройства — шторка в стиле приложения (как web): код сверки крупно, «Отклонить» /
     * «Подтвердить»; ход и исход — в самой шторке, а не всплывающей строкой. Окно закрывается само, если устройство
     * вошло иным путём (ключом восстановления, подтверждением с другого устройства) или запрос исчез.
     */
    private fun confirmLink(device: String, code: String) {
        val ctx = UI.getUiContext() ?: return
        linkDialogs.remove(device)?.dismiss()
        val c = Pv.c
        val sheet = PvSheet.create(ctx, Sx.t("Вход с нового устройства", "Sign-in from a new device"))
        sheet.add(ctx.pvText(Sx.t("Кто-то входит в ваш аккаунт на новом устройстве. Подтвердите, только если это вы " +
            "и код ниже совпадает с кодом на экране нового устройства.",
            "Someone is signing in to your account on a new device. Confirm only if it is you and the code below " +
            "matches the code on the new device’s screen."), 0.9375f, c.muted))
        sheet.add(ctx.pvText(code, 1.75f, c.fg, semibold = true, mono = true).apply {
            gravity = android.view.Gravity.CENTER
            letterSpacing = 0.08f
            setPadding(Pv.rem(1f), Pv.rem(1f), Pv.rem(1f), Pv.rem(1f))
            background = Pv.shape(c.raised, 0.75f, c.line2)
        })
        val status = ctx.pvText("", 0.875f, c.muted).apply { visibility = android.view.View.GONE }
        sheet.add(status, 0.5f)
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.END
        }
        lateinit var confirm: LinearLayout
        val reject = ctx.pvButton(Sx.t("Отклонить", "Reject"), "ghost") { sheet.dismiss() }
        confirm = ctx.pvButton(Sx.t("Подтвердить", "Confirm"), "acc") {
            confirm.isEnabled = false
            reject.isEnabled = false
            confirm.alpha = 0.6f
            status.visibility = android.view.View.VISIBLE
            status.setTextColor(c.muted)
            status.text = Sx.t("Передаём ключи новому устройству…", "Handing keys to the new device…")
            Sx.async({ ParvaneCore.linkGrant(device) }) { ok ->
                if (ok == true) {
                    sheet.dismiss()
                    UI.showToast(Sx.t("Устройство подключено", "Device connected"), android.widget.Toast.LENGTH_SHORT)
                } else {
                    confirm.isEnabled = true
                    reject.isEnabled = true
                    confirm.alpha = 1f
                    status.setTextColor(c.red)
                    status.text = Sx.t("Не удалось подтвердить. Если новое устройство уже вошло другим способом, ничего делать не нужно.",
                        "Could not confirm. If the new device has already signed in another way, nothing else is needed.")
                }
            }
        }
        row.addView(reject)
        row.addView(confirm.apply { (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f) })
        sheet.add(row)
        sheet.onClose { if (linkDialogs[device] === sheet) linkDialogs.remove(device) }
        linkDialogs[device] = sheet
        sheet.show()
    }

    /** rotate — смена ключа подписи устройств (SSK) на привязанном устройстве; иначе — вход нового устройства. */
    fun askRecoveryKey(ctx: Context, rotate: Boolean, done: () -> Unit) {
        val c = Pv.c
        val sheet = PvSheet.create(ctx, Sx.t("Ключ восстановления", "Recovery key"))
        sheet.add(ctx.pvText(Sx.t("Ключ показывался при создании аккаунта и пришёл от бота в Telegram. Регистр и пробелы не важны.",
            "The key was shown when the account was created and sent by the Telegram bot. Case and spaces do not matter."),
            0.9375f, c.muted))
        val input = with(Kn) { ctx.input(hint = "XXXX-XXXX-XXXX-…") }.apply {
            typeface = Pv.mono()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        sheet.add(input)
        val status = ctx.pvText("", 0.875f, c.muted).apply { visibility = android.view.View.GONE }
        sheet.add(status, 0.5f)
        lateinit var ok: LinearLayout
        ok = ctx.pvButton(if (rotate) Sx.t("Сменить ключ подписи", "Change signing key") else Sx.t("Войти", "Sign in"), "acc") {
            val key = input.text.toString().trim()
            if (key.isEmpty()) return@pvButton
            ok.isEnabled = false
            ok.alpha = 0.6f
            status.visibility = android.view.View.VISIBLE
            status.setTextColor(c.muted)
            status.text = Sx.t("Проверяем ключ…", "Checking the key…")
            Sx.async({ if (rotate) ParvaneCore.rotateSsk(key) else ParvaneCore.recoverWithKey(key) }) { r ->
                if (r == "ok") {
                    sheet.dismiss()
                    UI.showToast(Sx.t("Готово", "Done"), android.widget.Toast.LENGTH_SHORT)
                    done()
                    return@async
                }
                ok.isEnabled = true
                ok.alpha = 1f
                status.setTextColor(c.red)
                status.text = when (r) {
                    "bad_key" -> Sx.t("Ключ не подошёл. Проверьте его в сообщении бота.", "The key did not work. Check it in the bot’s message.")
                    "no_backup" -> Sx.t("На сервере нет копии ключей аккаунта", "No account key backup on the server")
                    else -> Sx.t("Не получилось, попробуйте ещё раз", "Failed, try again")
                }
            }
        }
        sheet.add(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.END
            addView(ctx.pvButton(Sx.t("Отмена", "Cancel"), "ghost") { sheet.dismiss() })
            addView(ok.apply { (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f) })
        })
        sheet.show()
        input.requestFocus()
    }
}
