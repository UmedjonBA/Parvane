package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import org.drinkless.tdlib.TdApi
import org.thunderdog.challegram.BuildConfig
import org.thunderdog.challegram.R
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ThemeManager
import org.thunderdog.challegram.ui.ChatsController
import org.thunderdog.challegram.ui.ContactsController
import org.thunderdog.challegram.ui.SettingsDataController
import org.thunderdog.challegram.ui.SettingsFoldersController
import org.thunderdog.challegram.ui.SettingsLanguageController
import org.thunderdog.challegram.ui.SettingsNotificationController
import org.thunderdog.challegram.ui.SettingsPrivacyController
import org.thunderdog.challegram.ui.SettingsStickersAndEmojiController
import org.thunderdog.challegram.ui.SettingsThemeController

/**
 * Parvane (spec 032): вкладка «Профиль» 1:1 с телефонной версией web (`SettingsMain`): карточка аккаунта,
 * «Мессенджер — экраны настроек Telegram» (экраны X), «Parvane» (настройки плана, цели здоровья, хранилище
 * заметок, оформление), «Ещё» (ночной режим, работа в фоне, выгрузка), «Выйти» и версия.
 */
class ProfileHubController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section = "chats"
    override val tab = ParvaneTabBar.Tab.PROFILE
    override fun getId() = R.id.controller_parvaneProfile
    override fun getName(): CharSequence = Sx.t("Профиль", "Profile")

    override fun onBuilt() = render()
    override fun repaint() = render()

    private var photoAvatar: org.thunderdog.challegram.widget.AvatarView? = null

    override fun destroy() {
        photoAvatar?.performDestroy()
        photoAvatar = null
        super.destroy()
    }

    override fun onFocus() {
        super.onFocus()
        render()
    }

    private fun render(): Unit = rebuild {
        setPadding(Pv.rem(1f), Pv.rem(1f), Pv.rem(1f), Pv.rem(1f))
        val gap = Pv.rem(0.75f)
        fun add(view: android.view.View, top: Int = gap) = addView(view, lp(t = top))
        add(accountCard(), 0)
        add(context.pvCaption(Sx.t("Мессенджер — экраны настроек Telegram", "Messenger — Telegram settings screens")), Pv.rem(0.25f + 0.75f))
        add(context.pvCard().apply {
            row("star", Sx.t("Избранное", "Saved Messages")) { tdlib.ui().openChat(this@ProfileHubController, tdlib.selfChatId(), null) }
            row("folder", Sx.t("Архив", "Archived Chats")) {
                navigateTo(ChatsController(context(), tdlib).apply { setArguments(ChatsController.Arguments(TdApi.ChatListArchive()).setNeedMessagesSearch(true)) })
            }
            row("users", Sx.t("Контакты", "Contacts")) { navigateTo(ContactsController(context(), tdlib)) }
            row("sliders", Sx.t("Основные настройки", "General Settings"), Sx.t("размер текста, фон чатов", "text size, chat background")) {
                navigateTo(SettingsThemeController(context(), tdlib).apply { setArguments(SettingsThemeController.Args(SettingsThemeController.MODE_INTERFACE_OPTIONS)) })
            }
            row("bell", Sx.t("Уведомления", "Notifications")) { navigateTo(SettingsNotificationController(context(), tdlib)) }
            row("cloud", Sx.t("Данные и память", "Data and Storage"), Sx.t("автозагрузка, кэш", "auto-download, cache")) { navigateTo(SettingsDataController(context(), tdlib)) }
            row("user", Sx.t("Конфиденциальность", "Privacy and Security"), Sx.t("кто видит профиль, ключи", "who can see you, keys")) {
                navigateTo(SettingsPrivacyController(context(), tdlib))
            }
            row("chat", Sx.t("Папки чатов", "Chat Folders"), folderNames()) { navigateTo(SettingsFoldersController(context(), tdlib)) }
            row("link", Sx.t("Устройства", "Devices"), Sx.t("активные сеансы, привязка, ник", "active sessions, linking, username")) {
                navigateTo(AccountController(context(), tdlib))
            }
            row("book", Sx.t("Язык", "Language"), Sx.t("Русский", "English")) { navigateTo(SettingsLanguageController(context(), tdlib)) }
            row("smile", Sx.t("Стикеры и эмодзи", "Stickers and Emoji")) { navigateTo(SettingsStickersAndEmojiController(context(), tdlib)) }
        })
        add(context.pvCaption("Parvane"), Pv.rem(0.25f + 0.75f))
        add(context.pvCard().apply {
            row("sliders", Sx.t("Настройки плана", "Planner settings"), Sx.t("бюджет дня, рабочие часы", "day budget, working hours")) {
                navigateTo(PlannerController(context(), tdlib).openSettings())
            }
            row("heart", Sx.t("Цели здоровья", "Health goals"), Sx.t("КБЖУ, вода, сон, вес, шаги", "calories, water, sleep, weight, steps")) {
                navigateTo(PlannerController(context(), tdlib).openHealthGoals())
            }
            row("cloud", Sx.t("Хранилище заметок", "Notes vault"), Sx.t("папка «Знания» в облаке", "the “Knowledge” folder in the cloud")) {
                navigateTo(KnowledgeController(context(), tdlib).openFiles())
            }
            row("sun", Sx.t("Оформление", "Appearance"), appearanceName()) {
                navigateTo(SettingsThemeController(context(), tdlib).apply { setArguments(SettingsThemeController.Args(SettingsThemeController.MODE_THEMES)) })
            }
        })
        add(context.pvCaption(Sx.t("Ещё", "More")), Pv.rem(0.25f + 0.75f))
        add(context.pvCard().apply {
            val dark = ThemeManager.instance().isCurrentThemeDark
            addView(context.pvTileRow("sun", Sx.t("Ночной режим", "Night Mode"), trailing = context.pvSwitch(dark) {
                ThemeManager.instance().toggleNightMode()
                Sx.main.postDelayed({ render() }, 400)
            }, onClick = null), lp())
            row("refresh", Sx.t("Работа в фоне", "Background delivery"), backgroundSubtitle()) { chooseBackground() }
            row("download", Sx.t("Выгрузить мои данные", "Export my data"), Sx.t("ZIP: переписка, «План», заметки", "ZIP: chats, plan, notes")) {
                DataExport.start(context())
            }
        })
        add(context.pvCard().apply {
            addView(context.pvTileRow("logout", Sx.t("Выйти", "Log Out"), danger = true, chevron = false) {
                tdlib.ui().logOut(this@ProfileHubController, false)
            }, lp())
        })
        add(context.pvText("Parvane ${BuildConfig.VERSION_NAME}", 0.8125f, Pv.c.muted).apply { gravity = Gravity.CENTER })
    }

    private fun LinearLayout.row(icon: String, title: String, subtitle: String? = null, onClick: () -> Unit) {
        addView(context.pvTileRow(icon, title, subtitle, onClick = onClick), lp())
    }

    /** Карточка аккаунта (`.account`): аватар, имя 1,125 rem semibold, адрес моноширинным 0,8125 rem; → «Мой профиль». */
    private fun accountCard(): LinearLayout = context().pvCard(1f).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        val me = tdlib.myUser()
        val name = me?.let { listOf(it.firstName, it.lastName).filter { s -> s.isNotEmpty() }.joinToString(" ") }?.ifEmpty { null }
            ?: Sx.t("Мой профиль", "My profile")
        val avatarColor = Pv.c.let { c -> intArrayOf(c.red, c.orange, c.purple, c.green, c.aqua, c.blue)[((me?.id ?: 0L) % 6).toInt().let { if (it < 0) -it else it }] }
        // Фото профиля — штатным аватаром X (то же, что в «Моём профиле»); без фото — буква, как web
        photoAvatar?.performDestroy()
        photoAvatar = null
        val avatar: android.view.View = if (me?.profilePhoto != null) org.thunderdog.challegram.widget.AvatarView(context).apply {
            setUser(tdlib, me, false)
            photoAvatar = this
        } else PvAvatar(context, name, avatarColor, Pv.rem(3.5f))
        addView(avatar, LinearLayout.LayoutParams(Pv.rem(3.5f), Pv.rem(3.5f)).apply { rightMargin = Pv.rem(0.875f) })
        val info = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        info.addView(context.pvText(name, 1.125f, Pv.c.fg, semibold = true, maxLines = 1))
        me?.usernames?.activeUsernames?.firstOrNull()?.takeIf { it != name }?.let {
            info.addView(context.pvText("@$it", 0.8125f, Pv.c.muted, maxLines = 1, mono = true))
        }
        addView(info, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(context.pvIcon("right", Pv.alpha(Pv.c.fg, 85), 1.125f))
        Pv.pressable(this, Pv.c.raised, 0.75f) { me?.let { tdlib.ui().openPrivateProfile(this@ProfileHubController, it.id, null) } }
    }

    private fun folderNames(): String? = try {
        tdlib.chatFolders().take(3).joinToString(", ") { it.name.text.text }.ifEmpty { null }
    } catch (e: Throwable) { null }

    private fun appearanceName(): String {
        val id = ThemeManager.instance().currentThemeId()
        val scheme = when (id) {
            11, 10 -> "Gruvbox"; 9, 4 -> "Nord"; 7, 3 -> "Catppuccin"; 6, 5 -> "Solarized"; 1, 2 -> "Telegram"; else -> Sx.t("своя тема", "custom theme")
        }
        val mode = if (ThemeManager.instance().isCurrentThemeDark) Sx.t("тёмная", "dark") else Sx.t("светлая", "light")
        return "$scheme · $mode"
    }

    private fun backgroundSubtitle(): String = when (org.thunderdog.challegram.parvane.ParvaneBackground.mode()) {
        "unifiedpush" -> Sx.t("UnifiedPush — мгновенно, будит распространитель", "UnifiedPush — instant, a distributor wakes the app")
        "service" -> Sx.t("Постоянная связь — мгновенно, значок в шторке", "Always connected — instant, an icon in the shade")
        else -> Sx.t("Проверка раз в 15 минут, без значка в шторке", "Check every 15 minutes, no icon in the shade")
    }

    private fun chooseBackground() {
        val hasDistributor = org.thunderdog.challegram.parvane.ParvaneBackground.distributors().isNotEmpty()
        val items = arrayOf(
            Sx.t("Раз в 15 минут, без значка", "Every 15 minutes, no icon"),
            Sx.t("UnifiedPush (ntfy и др.) — мгновенно", "UnifiedPush (ntfy etc.) — instant") + if (hasDistributor) "" else Sx.t(" — не установлен", " — not installed"),
            Sx.t("Постоянная связь — мгновенно, значок в шторке", "Always connected — instant, icon in the shade"))
        PvSheet.choose(context(), Sx.t("Работа в фоне", "Background delivery"), items.toList()) { which ->
            if (which == 1 && !hasDistributor) {
                toast(Sx.t("Установите распространитель UnifiedPush, например ntfy", "Install a UnifiedPush distributor such as ntfy"))
                return@choose
            }
            org.thunderdog.challegram.parvane.ParvaneBackground.setMode(when (which) { 0 -> "periodic"; 1 -> "unifiedpush"; else -> "service" })
            render()
        }
    }
}
