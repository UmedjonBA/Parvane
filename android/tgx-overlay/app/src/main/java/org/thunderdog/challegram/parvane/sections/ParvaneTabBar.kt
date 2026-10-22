package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import org.thunderdog.challegram.R
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.theme.ColorId

/**
 * Parvane (spec 031, T060): нижняя панель разделов, как в телефонной версии web — Чаты · План · + · Знания ·
 * Профиль. «+» — ввод текстом в «План» (задача, событие, еда, вода, сон…). На главном экране X добавляется
 * патчем MainController (setup-tgx.sh), на экранах разделов — их базой [SectionController]. Переход между
 * разделами заменяет экран раздела (корень — список чатов остаётся первым в стеке).
 */
object ParvaneTabBar {
    enum class Tab { CHATS, PLAN, KNOWLEDGE, PROFILE }

    fun height() = Sx.dp(56f)

    /** Главный экран X: панель поверх низа списка чатов; список и плавающая кнопка поднимаются над ней. */
    @JvmStatic
    fun attachToMain(owner: ViewController<*>, contentView: ViewGroup, mainWrap: View, compose: View?) {
        contentView.addView(create(owner.context(), owner, Tab.CHATS),
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height(), Gravity.BOTTOM))
        (mainWrap.layoutParams as? ViewGroup.MarginLayoutParams)?.let {
            it.bottomMargin = height()
            mainWrap.layoutParams = it
        }
        compose?.let { c ->
            (c.layoutParams as? ViewGroup.MarginLayoutParams)?.let {
                it.bottomMargin = height()
                c.layoutParams = it
            }
        }
    }

    fun create(context: Context, owner: ViewController<*>, current: Tab): View {
        val bar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Sx.color(ColorId.filling))
            elevation = Sx.dp(6f).toFloat()
        }
        fun item(icon: Int, title: String, tab: Tab?, onClick: () -> Unit) {
            val selected = tab == current
            val tint = Sx.color(if (selected) ColorId.iconActive else ColorId.icon)
            val box = context.vbox().apply {
                gravity = Gravity.CENTER
                contentDescription = title
                addView(ImageView(context).apply {
                    setImageResource(icon)
                    colorFilter = PorterDuffColorFilter(tint, PorterDuff.Mode.SRC_IN)
                }, LinearLayout.LayoutParams(Sx.dp(24f), Sx.dp(24f)))
                addView(context.label(title, 11f, if (selected) ColorId.iconActive else ColorId.textLight, bold = selected).apply {
                    gravity = Gravity.CENTER
                })
                setOnClickListener { onClick() }
                isClickable = true
            }
            bar.addView(box, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        }
        item(R.drawable.baseline_chat_bubble_24, Sx.t("Чаты", "Chats"), Tab.CHATS) { open(owner, Tab.CHATS, current) }
        item(R.drawable.baseline_date_range_24, Sx.t("План", "Plan"), Tab.PLAN) { open(owner, Tab.PLAN, current) }
        // «+» — круглая кнопка в центре
        val plus = FrameLayout(context).apply {
            contentDescription = Sx.t("Добавить", "Add")
            addView(ImageView(context).apply {
                setImageResource(R.drawable.baseline_add_24)
                colorFilter = PorterDuffColorFilter(Sx.color(ColorId.circleButtonRegularIcon), PorterDuff.Mode.SRC_IN)
                scaleType = ImageView.ScaleType.CENTER
                background = rounded(Sx.color(ColorId.circleButtonRegular), 22f)
                setOnClickListener { QuickAdd.show(owner) }
            }, FrameLayout.LayoutParams(Sx.dp(44f), Sx.dp(44f), Gravity.CENTER))
        }
        bar.addView(plus, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        item(R.drawable.baseline_book_24, Sx.t("Знания", "Knowledge"), Tab.KNOWLEDGE) { open(owner, Tab.KNOWLEDGE, current) }
        item(R.drawable.baseline_person_24, Sx.t("Профиль", "Profile"), Tab.PROFILE) { open(owner, Tab.PROFILE, current) }
        return bar
    }

    private fun open(owner: ViewController<*>, tab: Tab, current: Tab) {
        if (tab == current) return
        val nav = owner.navigationController() ?: return
        if (tab == Tab.CHATS) {
            // назад к списку чатов: всё над корнем снимается
            while (nav.stackSize > 2) owner.destroyStackItemAt(nav.stackSize - 2)
            owner.navigateBack()
            return
        }
        val context = owner.context()
        val tdlib = owner.tdlib()
        val next: ViewController<*> = when (tab) {
            Tab.PLAN -> PlannerController(context, tdlib)
            Tab.KNOWLEDGE -> KnowledgeController(context, tdlib)
            else -> ProfileHubController(context, tdlib)
        }
        if (current == Tab.CHATS) owner.navigateTo(next)
        else nav.setControllerAnimated(next, true, true)
    }
}
