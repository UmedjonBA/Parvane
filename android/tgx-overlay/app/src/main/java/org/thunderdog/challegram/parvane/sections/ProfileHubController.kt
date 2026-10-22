package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.widget.ImageView
import android.widget.LinearLayout
import org.drinkless.tdlib.TdApi
import org.thunderdog.challegram.R
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.ui.ChatsController
import org.thunderdog.challegram.ui.SettingsController
import org.thunderdog.challegram.ui.SettingsThemeController

/**
 * Parvane (spec 031, T072): вкладка «Профиль» — хаб карточками, как телефонная версия web: свой профиль и
 * настройки, «Здоровье», «Облако», «Избранное», «Архив», «Устройства», «Оформление». Разделы и экраны X —
 * штатные, хаб только ведёт к ним.
 */
class ProfileHubController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section = "chats"
    override val tab = ParvaneTabBar.Tab.PROFILE
    override fun getId() = R.id.controller_parvaneProfile
    override fun getName(): CharSequence = Sx.t("Профиль", "Profile")

    override fun onBuilt() = render()

    private fun render(): Unit = rebuild {
        val me = tdlib.myUser()
        addView(context.card().apply {
            addView(context.label(me?.let { listOf(it.firstName, it.lastName).filter { s -> s.isNotEmpty() }.joinToString(" ") }
                ?.ifEmpty { null } ?: Sx.t("Мой профиль", "My profile"), 20f, bold = true))
            me?.usernames?.activeUsernames?.firstOrNull()?.let { addView(context.label("@$it", 14f, ColorId.textLight)) }
            pressable { navigateTo(SettingsController(context(), tdlib)) }
        })
        addView(context.sectionTitle(Sx.t("Разделы", "Sections")))
        tile(R.drawable.baseline_favorite_24, Sx.t("Здоровье", "Health"), Sx.t("Питание, вода, сон, активность", "Food, water, sleep, activity")) {
            navigateTo(PlannerController(context(), tdlib).openHealth())
        }
        tile(R.drawable.baseline_folder_24, Sx.t("Облако", "Cloud"), Sx.t("Файлы, совместные папки, ссылки", "Files, shared folders, links")) {
            navigateTo(CloudController(context(), tdlib))
        }
        addView(context.sectionTitle(Sx.t("Чаты", "Chats")))
        tile(R.drawable.baseline_bookmark_24, Sx.t("Избранное", "Saved Messages"), Sx.t("Заметки себе", "Notes to self")) {
            tdlib.ui().openChat(this@ProfileHubController, tdlib.selfChatId(), null)
        }
        tile(R.drawable.baseline_archive_24, Sx.t("Архив", "Archive"), null) {
            navigateTo(ChatsController(context(), tdlib).apply { setArguments(ChatsController.Arguments(TdApi.ChatListArchive()).setNeedMessagesSearch(true)) })
        }
        addView(context.sectionTitle(Sx.t("Ещё", "More")))
        tile(R.drawable.baseline_settings_24, Sx.t("Настройки", "Settings"), null) { navigateTo(SettingsController(context(), tdlib)) }
        tile(R.drawable.baseline_account_circle_24, Sx.t("Аккаунт и устройства", "Account and devices"), Sx.t("Привязка, выход с устройств, ник, удаление", "Linking, devices, username, deletion")) {
            navigateTo(AccountController(context(), tdlib))
        }
        tile(R.drawable.baseline_settings_24, Sx.t("Работа в фоне", "Background delivery"), backgroundSubtitle()) { chooseBackground() }
        tile(R.drawable.baseline_cloud_download_24, Sx.t("Выгрузить мои данные", "Export my data"), Sx.t("ZIP: переписка, «План», заметки", "ZIP: chats, plan, notes")) {
            DataExport.start(context())
        }
        tile(R.drawable.baseline_palette_24, Sx.t("Оформление", "Appearance"), Sx.t("Цветовая схема, тёмная тема", "Color scheme, dark mode")) {
            navigateTo(SettingsThemeController(context(), tdlib))
        }
    }

    private fun backgroundSubtitle(): String = when (org.thunderdog.challegram.parvane.ParvaneBackground.mode()) {
        "unifiedpush" -> Sx.t("UnifiedPush — приложение будит распространитель", "UnifiedPush — a distributor wakes the app")
        else -> Sx.t("Постоянная связь — значок в шторке", "Always connected — an icon in the shade")
    }

    private fun chooseBackground() {
        val hasDistributor = org.thunderdog.challegram.parvane.ParvaneBackground.distributors().isNotEmpty()
        val items = arrayOf(
            Sx.t("UnifiedPush (ntfy и др.)", "UnifiedPush (ntfy etc.)") + if (hasDistributor) "" else Sx.t(" — не установлен", " — not installed"),
            Sx.t("Постоянная связь", "Always connected"))
        android.app.AlertDialog.Builder(context(), org.thunderdog.challegram.theme.Theme.dialogTheme())
            .setTitle(Sx.t("Работа в фоне", "Background delivery"))
            .setItems(items) { _, which ->
                if (which == 0 && !hasDistributor) {
                    toast(Sx.t("Установите распространитель UnifiedPush, например ntfy", "Install a UnifiedPush distributor such as ntfy"))
                    return@setItems
                }
                org.thunderdog.challegram.parvane.ParvaneBackground.setMode(if (which == 0) "unifiedpush" else "service")
                render()
            }.show()
    }

    private fun LinearLayout.tile(icon: Int, title: String, subtitle: String?, onClick: () -> Unit) {
        val row = context.hbox().apply {
            setPadding(Sx.dp(14f), Sx.dp(12f), Sx.dp(14f), Sx.dp(12f))
            layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(12f), r = Sx.dp(12f))
            pressable(onClick = onClick)
        }
        row.addView(ImageView(context).apply {
            setImageResource(icon)
            colorFilter = PorterDuffColorFilter(Sx.color(ColorId.iconActive), PorterDuff.Mode.SRC_IN)
            layoutParams = LinearLayout.LayoutParams(Sx.dp(28f), Sx.dp(28f)).apply { rightMargin = Sx.dp(14f) }
        })
        val texts = context.vbox().apply { layoutParams = lp(0, weight = 1f) }
        texts.addView(context.label(title, 16f))
        subtitle?.let { texts.addView(context.label(it, 13f, ColorId.textLight)) }
        row.addView(texts)
        addView(row)
    }
}
