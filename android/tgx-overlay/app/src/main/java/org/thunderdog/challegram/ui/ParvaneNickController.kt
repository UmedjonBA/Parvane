package org.thunderdog.challegram.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.method.PasswordTransformationMethod
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.drinkless.tdlib.TdApi
import org.json.JSONObject
import org.parvane.core.ParvaneCore
import org.thunderdog.challegram.R
import org.thunderdog.challegram.data.TD
import org.thunderdog.challegram.navigation.BackHeaderButton
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.parvane.sections.Pv
import org.thunderdog.challegram.parvane.sections.Sx
import org.thunderdog.challegram.parvane.sections.pvText
import org.thunderdog.challegram.parvane.sections.coverHeaderArea
import org.thunderdog.challegram.telegram.AuthorizationListener
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import org.thunderdog.challegram.tool.Keyboard
import org.thunderdog.challegram.tool.UI

/**
 * Parvane (spec 032): вход и регистрация 1:1 с web (`AuthParvane`, `AuthPassword`, `AuthParvaneRegister`,
 * `AuthParvaneTelegram`): логотип 7,5 rem, заголовок, подсказка, поле с подписью на рамке, кнопка цвета
 * мессенджера, текстовые кнопки. Один экран X на все шаги: шов отдаёт WaitPhoneNumber → ник, WaitPassword →
 * пароль, WaitOtherDeviceConfirmation(ссылка) → подтверждение входа в Telegram (2FA); регистрация — свой шаг с
 * подтверждением ботом (опрос `identity.register.status`) либо кодом почты. MainActivity для этих состояний
 * отдаёт этот же экран (тот же id), он переключается сам по [onAuthorizationStateChanged].
 */
class ParvaneNickController(context: Context, tdlib: Tdlib) : ViewController<Void>(context, tdlib), AuthorizationListener {
    private enum class Step { NICK, PASSWORD, REGISTER, TELEGRAM, LOGIN_2FA, EMAIL_CODE }

    private lateinit var root: FrameLayout
    private var step = Step.NICK
    private var nick = ""
    private var inProgress = false
    private var serverConfirm = ""
    private var serverBot = ""
    // Регистрация: подтверждение ботом либо кодом почты
    private var regAddress = ""
    private var regPassword = ""
    private var regToken = ""
    private var pollGeneration = 0
    private var pollStartedAt = 0L
    private var loginLink = ""

    override fun getId() = R.id.controller_phone
    override fun getName(): CharSequence = "Parvane"
    override fun isUnauthorized() = true
    override fun getBackButton() = BackHeaderButton.TYPE_NONE
    override fun getHeaderHeight() = 0
    // Шапка X рисует название и при нулевой высоте — вместо него пустая ячейка (параметры FrameLayout: X двигает её отступами)
    private val emptyHeader by lazy { android.view.View(context()).apply { layoutParams = android.widget.FrameLayout.LayoutParams(0, 0) } }
    override fun getCustomHeaderCell(): android.view.View = emptyHeader

    override fun onCreateView(context: Context): View {
        root = FrameLayout(context).apply { setBackgroundColor(Theme.getColor(ColorId.filling)) }
        root.coverHeaderArea()
        tdlib.listeners().addAuthorizationChangeListener(this)
        applyState(tdlib.authorizationState())
        Thread({
            val info = try { ParvaneCore.serverInfo() } catch (e: Throwable) { JSONObject() }
            runOnUiThreadOptional {
                serverConfirm = info.optString("confirm")
                serverBot = info.optString("telegram_bot")
            }
        }, "parvane-serverinfo").start()
        return root
    }

    override fun destroy() {
        tdlib.listeners().removeAuthorizationChangeListener(this)
        pollGeneration++
        super.destroy()
    }

    override fun onAuthorizationStateChanged(state: TdApi.AuthorizationState) {
        runOnUiThreadOptional { applyState(state) }
    }

    private fun applyState(state: TdApi.AuthorizationState?) {
        when (state) {
            is TdApi.AuthorizationStateWaitPassword -> if (step != Step.PASSWORD && step != Step.REGISTER && step != Step.TELEGRAM && step != Step.EMAIL_CODE) show(Step.PASSWORD)
            is TdApi.AuthorizationStateWaitOtherDeviceConfirmation -> { loginLink = state.link; show(Step.LOGIN_2FA) }
            is TdApi.AuthorizationStateWaitPhoneNumber -> if (step == Step.PASSWORD || step == Step.LOGIN_2FA || !::root.isInitialized || root.childCount == 0) show(Step.NICK)
            else -> if (root.childCount == 0) show(Step.NICK)
        }
    }

    override fun performOnBackPressed(fromTop: Boolean, commit: Boolean): Boolean {
        if (step == Step.NICK) return super.performOnBackPressed(fromTop, commit)
        if (commit) when (step) {
            Step.REGISTER, Step.TELEGRAM, Step.EMAIL_CODE -> { pollGeneration++; show(Step.NICK) }
            else -> cancelLogin()
        }
        return true
    }

    // ── вид ──────────────────────────────────────────────────────────────────────────

    private val accent get() = Theme.getColor(ColorId.fillingPositive)

    private fun show(next: Step) {
        step = next
        inProgress = false
        val ctx = context()
        root.removeAllViews()
        val form = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(Pv.rem(1f), Pv.rem(6f), Pv.rem(1f), Pv.rem(1f))
        }
        root.addView(ScrollView(ctx).apply {
            isFillViewport = true
            addView(form, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        // Логотип 7,5 rem и отступ 1,75 rem
        form.addView(ImageView(ctx).apply { setImageResource(R.drawable.parvane_logo); scaleType = ImageView.ScaleType.FIT_CENTER },
            LinearLayout.LayoutParams(Pv.rem(7.5f), Pv.rem(7.5f)).apply { bottomMargin = Pv.rem(1.75f) })
        when (next) {
            Step.NICK -> nickForm(form)
            Step.PASSWORD -> passwordForm(form)
            Step.REGISTER -> registerForm(form)
            Step.TELEGRAM -> telegramForm(form, isLogin = false)
            Step.LOGIN_2FA -> telegramForm(form, isLogin = true)
            Step.EMAIL_CODE -> codeForm(form)
        }
    }

    private fun title(form: LinearLayout, text: String) = form.addView(context().pvText(text, 1.375f, Theme.getColor(ColorId.text), semibold = true).apply { gravity = Gravity.CENTER },
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = Pv.rem(0.5f) })

    private fun note(form: LinearLayout, text: String, bottom: Float = 2.5f): TextView = context().pvText(text, 0.9375f, Theme.getColor(ColorId.textLight)).apply {
        gravity = Gravity.CENTER
        form.addView(this, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = Pv.rem(bottom) })
    }

    /** Строка ошибки под полями. */
    private fun errorLine(form: LinearLayout): TextView = context().pvText("", 0.875f, Theme.getColor(ColorId.textNegative)).apply {
        gravity = Gravity.CENTER
        visibility = View.GONE
        form.addView(this, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(0.75f) })
    }

    private fun TextView.showError(text: String) { this.text = text; visibility = if (text.isEmpty()) View.GONE else View.VISIBLE }

    /** Поле `InputText` web: рамка со скруглением 0,75 rem, подпись на рамке; в фокусе — рамка 2 px цвета акцента. */
    private fun field(form: LinearLayout, label: String, password: Boolean = false, top: Float = 0f): EditText {
        val ctx = context()
        val box = FrameLayout(ctx)
        val text = Theme.getColor(ColorId.text)
        val muted = Theme.getColor(ColorId.textLight)
        val line = Theme.getColor(ColorId.inputInactive)
        val bg = Theme.getColor(ColorId.filling)
        val edit = EditText(ctx).apply {
            setTextColor(text)
            textSize = 16f
            typeface = Pv.regular()
            setPadding(Pv.rem(1.125f), Pv.rem(0.875f), Pv.rem(if (password) 3f else 1.125f), Pv.rem(0.875f))
            inputType = if (password) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_DONE
            isSingleLine = true
            background = Pv.shape(bg, 0.75f, line, 1f)
        }
        val caption = ctx.pvText(label, 0.8125f, muted).apply {
            setBackgroundColor(bg)
            setPadding(Pv.rem(0.25f), 0, Pv.rem(0.25f), 0)
        }
        edit.setOnFocusChangeListener { _, focused ->
            edit.background = Pv.shape(bg, 0.75f, if (focused) accent else line, if (focused) 2f else 1f)
            caption.setTextColor(if (focused) accent else muted)
        }
        box.addView(edit, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.rem(3.375f)).apply { topMargin = Pv.rem(0.5f) })
        box.addView(caption, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = Pv.rem(0.875f) })
        if (password) {
            var visible = false
            box.addView(ImageView(ctx).apply {
                setImageResource(R.drawable.baseline_eye_off_24)
                setColorFilter(muted)
                scaleType = ImageView.ScaleType.CENTER
                setOnClickListener {
                    visible = !visible
                    edit.transformationMethod = if (visible) null else PasswordTransformationMethod.getInstance()
                    edit.setSelection(edit.text.length)
                    setImageResource(if (visible) R.drawable.baseline_visibility_24 else R.drawable.baseline_eye_off_24)
                }
            }, FrameLayout.LayoutParams(Pv.rem(3f), Pv.rem(3.375f), Gravity.END).apply { topMargin = Pv.rem(0.5f) })
        }
        form.addView(box, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(top) })
        return edit
    }

    /** `auth-button`: на всю ширину, 3,375 rem, цвет акцента мессенджера, прописные буквы. */
    private fun button(form: LinearLayout, text: String, top: Float = 2.5f, onClick: () -> Unit): TextView = context().pvText(text.uppercase(), 1f, 0xffffffff.toInt(), semibold = true).apply {
        gravity = Gravity.CENTER
        Pv.pressable(this, accent, 0.75f, onClick = onClick)
        form.addView(this, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.rem(3.375f)).apply { topMargin = Pv.rem(top) })
    }

    /** Текстовая кнопка (`auth-button isText`): цвет акцента, прописные. */
    private fun textButton(form: LinearLayout, text: String, top: Float = 0.5f, onClick: () -> Unit): TextView = context().pvText(text.uppercase(), 1f, accent, semibold = true).apply {
        gravity = Gravity.CENTER
        Pv.pressable(this, 0, 0.75f, onClick = onClick)
        form.addView(this, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.rem(3.375f)).apply { topMargin = Pv.rem(top) })
    }

    private fun setBusy(view: TextView, busy: Boolean, label: String) {
        inProgress = busy
        view.alpha = if (busy) 0.6f else 1f
        view.text = if (busy) Sx.t("Подождите…", "Please wait…").uppercase() else label.uppercase()
    }

    // ── шаги ─────────────────────────────────────────────────────────────────────────

    private fun nickForm(form: LinearLayout) {
        title(form, "Parvane")
        note(form, Sx.t("Введите ник, чтобы войти.", "Enter your nickname to sign in."))
        val input = field(form, Sx.t("Ник", "Nickname"))
        input.setText(nick)
        val error = errorLine(form)
        val next = Sx.t("Далее", "Next")
        lateinit var go: TextView
        go = button(form, next) {
            val value = input.text.toString().trim()
            if (value.isEmpty() || inProgress) return@button
            nick = value
            setBusy(go, true, next)
            tdlib.client().send(TdApi.SetAuthenticationPhoneNumber(value, null)) { r ->
                runOnUiThreadOptional {
                    if (step != Step.NICK) return@runOnUiThreadOptional
                    setBusy(go, false, next)
                    if (r is TdApi.Error) error.showError(TD.toErrorString(r))
                }
            }
        }
        go.visibility = if (nick.isEmpty()) View.GONE else View.VISIBLE
        input.addTextChangedListener(watcher { go.visibility = if (it.isBlank()) View.GONE else View.VISIBLE; error.showError("") })
        input.setOnEditorActionListener { _, _, _ -> go.performClick(); true }
        textButton(form, Sx.t("Создать аккаунт", "Create account"), top = 0.5f) { show(Step.REGISTER) }
        focus(input)
    }

    private fun passwordForm(form: LinearLayout) {
        title(form, Sx.t("Введите пароль", "Enter Password"))
        note(form, if (nick.isNotEmpty()) "@$nick" else Sx.t("Пароль аккаунта Parvane.", "Your Parvane account password."))
        val input = field(form, Sx.t("Пароль", "Password"), password = true)
        val error = errorLine(form)
        val next = Sx.t("Далее", "Next")
        lateinit var go: TextView
        go = button(form, next) {
            val value = input.text.toString()
            if (value.isEmpty() || inProgress) return@button
            setBusy(go, true, next)
            tdlib.client().send(TdApi.CheckAuthenticationPassword(value)) { r ->
                runOnUiThreadOptional {
                    setBusy(go, false, next)
                    if (r is TdApi.Error) error.showError(TD.toErrorString(r))
                }
            }
        }
        input.setOnEditorActionListener { _, _, _ -> go.performClick(); true }
        input.addTextChangedListener(watcher { error.showError("") })
        textButton(form, Sx.t("Другой ник", "Another nickname")) { cancelLogin() }
        textButton(form, Sx.t("Создать аккаунт", "Create account"), top = 0f) { cancelLogin(); show(Step.REGISTER) }
        focus(input)
    }

    private fun registerForm(form: LinearLayout) {
        title(form, Sx.t("Новый аккаунт", "New account"))
        note(form, Sx.t("Придумайте ник и пароль.", "Pick a nickname and a password."))
        val nickInput = field(form, Sx.t("Ник", "Nickname"))
        nickInput.setText(nick)
        val password = field(form, Sx.t("Пароль", "Password"), password = true, top = 1f)
        val email = field(form, Sx.t("Почта", "Email"), top = 1f).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS }
        (email.parent as View).visibility = if (serverConfirm == "email") View.VISIBLE else View.GONE
        val error = errorLine(form)
        val label = Sx.t("Создать аккаунт", "Create account")
        lateinit var go: TextView
        go = button(form, label) {
            if (inProgress) return@button
            val n = nickInput.text.toString().trim()
            val p = password.text.toString()
            if (n.isEmpty() || p.length < 8) { error.showError(Sx.t("Пароль — не короче 8 символов, с заглавной буквой и цифрой", "Password: at least 8 characters with a capital letter and a digit")); return@button }
            setBusy(go, true, label)
            Thread({
                val r = try { ParvaneCore.register(n, p, email.text.toString().trim()) } catch (e: Throwable) { JSONObject() }
                runOnUiThreadOptional {
                    setBusy(go, false, label)
                    if (!r.optBoolean("ok")) {
                        if (r.optBoolean("email_required")) {
                            (email.parent as View).visibility = View.VISIBLE
                            error.showError(Sx.t("Сервер подтверждает аккаунты почтой — укажите адрес", "This server confirms accounts by email — enter an address"))
                            email.requestFocus()
                            return@runOnUiThreadOptional
                        }
                        error.showError(registerError(r.optString("error_code")))
                        return@runOnUiThreadOptional
                    }
                    nick = n
                    regAddress = r.optString("address", n)
                    regPassword = p
                    when {
                        r.optBoolean("confirm_required") && r.optString("telegram_token").isNotEmpty() -> { regToken = r.optString("telegram_token"); show(Step.TELEGRAM); startPolling() }
                        r.optBoolean("confirm_required") -> show(Step.EMAIL_CODE)
                        else -> login(regAddress, regPassword, null)
                    }
                }
            }, "parvane-register").start()
        }
        textButton(form, Sx.t("У меня уже есть аккаунт", "I already have an account")) { show(Step.NICK) }
        focus(nickInput)
    }

    private fun telegramForm(form: LinearLayout, isLogin: Boolean) {
        title(form, if (isLogin) Sx.t("Подтвердите вход через Telegram", "Confirm sign-in via Telegram") else Sx.t("Подтверждение через Telegram", "Confirm via Telegram"))
        if (nick.isNotEmpty()) note(form, "@$nick", 0.5f)
        note(form, if (isLogin) Sx.t("Включена двухфакторная аутентификация. Откройте нашего Telegram-бота и нажмите Start — подтвердить вход может только Telegram, привязанный к этому аккаунту.",
            "Two-factor authentication is on. Open our Telegram bot and press Start — only the Telegram account linked to this profile can confirm the sign-in.")
            else Sx.t("Откройте нашего Telegram-бота и нажмите Start — аккаунт подтвердится автоматически.", "Open our Telegram bot and press Start — the account will be confirmed automatically."))
        val link = if (isLogin) loginLink else "https://t.me/$serverBot?start=$regToken"
        button(form, Sx.t("Открыть Telegram", "Open Telegram"), top = 0f) {
            try { context().startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) } catch (e: Throwable) { UI.showToast(link, android.widget.Toast.LENGTH_LONG) }
        }
        form.addView(context().pvText(link, 0.875f, accent).apply {
            gravity = Gravity.CENTER
            setOnClickListener { try { context().startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) } catch (e: Throwable) { } }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(1f) })
        form.addView(org.thunderdog.challegram.parvane.sections.MascotView(context()), LinearLayout.LayoutParams(Pv.rem(3f), Pv.rem(3f)).apply { topMargin = Pv.rem(1.5f) })
        note(form, Sx.t("Ждём подтверждения в Telegram…", "Waiting for confirmation in Telegram…"), 0f)
        if (!isLogin) textButton(form, Sx.t("Я нажал Start", "I pressed Start"), top = 1f) { pollOnce(pollGeneration) }
        textButton(form, Sx.t("Отмена", "Cancel"), top = 0f) { pollGeneration++; if (isLogin) cancelLogin() else show(Step.NICK) }
        if (!isLogin) try { context().startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) } catch (e: Throwable) { }
    }

    private fun codeForm(form: LinearLayout) {
        title(form, Sx.t("Код из письма", "Code from the email"))
        note(form, Sx.t("Мы отправили код на вашу почту. Введите его, чтобы подтвердить аккаунт.", "We sent a code to your email. Enter it to confirm the account."))
        val code = field(form, Sx.t("Код", "Code")).apply { inputType = InputType.TYPE_CLASS_NUMBER }
        val error = errorLine(form)
        val label = Sx.t("Подтвердить", "Confirm")
        lateinit var go: TextView
        go = button(form, label) {
            val value = code.text.toString().trim()
            if (value.isEmpty() || inProgress) return@button
            setBusy(go, true, label)
            Thread({
                val r = try { ParvaneCore.confirmEmail(regAddress, value) } catch (e: Throwable) { JSONObject() }
                runOnUiThreadOptional {
                    setBusy(go, false, label)
                    if (r.optBoolean("ok")) login(regAddress, regPassword, error)
                    else error.showError(Sx.t("Неверный код", "Wrong code"))
                }
            }, "parvane-confirm").start()
        }
        textButton(form, Sx.t("Отмена", "Cancel")) { show(Step.NICK) }
        focus(code)
    }

    // ── действия ─────────────────────────────────────────────────────────────────────

    private fun startPolling() {
        pollStartedAt = System.currentTimeMillis()
        val generation = ++pollGeneration
        UI.post({ pollOnce(generation) }, 2000)
    }

    private fun pollOnce(generation: Int) {
        if (generation != pollGeneration || isDestroyed) return
        if (System.currentTimeMillis() - pollStartedAt > 14 * 60 * 1000L) {
            UI.showToast(Sx.t("Ссылка устарела — зарегистрируйтесь снова", "The link has expired — sign up again"), android.widget.Toast.LENGTH_LONG)
            show(Step.REGISTER)
            return
        }
        val address = regAddress
        val token = regToken
        Thread({
            val confirmed = try { ParvaneCore.registerStatus(address, token) } catch (e: Throwable) { false }
            runOnUiThreadOptional {
                if (generation != pollGeneration) return@runOnUiThreadOptional
                if (confirmed) { pollGeneration++; login(regAddress, regPassword, null) }
                else UI.post({ pollOnce(generation) }, 2000)
            }
        }, "parvane-poll").start()
    }

    /** Вход штатным путём X: шов → WaitPassword → CheckAuthenticationPassword → Ready. */
    private fun login(address: String, password: String, error: TextView?) {
        tdlib.client().send(TdApi.SetAuthenticationPhoneNumber(address, null)) {
            tdlib.client().send(TdApi.CheckAuthenticationPassword(password)) { r ->
                runOnUiThreadOptional { if (r is TdApi.Error) (error ?: run { show(Step.NICK); null })?.showError(TD.toErrorString(r)) }
            }
        }
    }

    /** Назад к нику. Выход нужен только при подтверждении 2FA (шов ждёт Telegram); на шаге пароля ник просто вводится заново. */
    private fun cancelLogin() {
        if (step == Step.LOGIN_2FA) tdlib.client().send(TdApi.LogOut()) { }
        show(Step.NICK)
    }

    private fun registerError(code: String) = when (code) {
        "ERROR_CODE_DUPLICATE" -> Sx.t("Этот ник уже занят", "This nickname is taken")
        "ERROR_CODE_INVALID" -> Sx.t("Ник: латиница, цифры, точка, дефис и подчёркивание", "Nickname: latin letters, digits, dot, hyphen and underscore")
        "ERROR_CODE_RATE_LIMITED" -> Sx.t("Слишком много попыток — попробуйте позже", "Too many attempts — try again later")
        "ERROR_CODE_UPGRADE_REQUIRED" -> Sx.t("Обновите приложение", "Please update the app")
        else -> Sx.t("Не удалось создать аккаунт", "Could not create the account")
    }

    private fun focus(edit: EditText) = edit.post { edit.requestFocus(); Keyboard.show(edit) }

    private fun watcher(cb: (String) -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun afterTextChanged(s: Editable?) = cb(s?.toString().orEmpty())
    }
}
