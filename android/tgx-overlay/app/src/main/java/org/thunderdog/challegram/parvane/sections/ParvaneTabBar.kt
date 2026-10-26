package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import org.drinkless.tdlib.TdApi
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.ui.ContactsController
import org.thunderdog.challegram.ui.CreateChannelController

/**
 * Parvane (spec 032): нижняя панель разделов 1:1 с телефонной версией web (`ParvaneTabBar.tsx` /
 * `.module.scss`): Чаты · План · «+» · Знания · Профиль. Линейные значки web, выбранная вкладка и «+» — акцент
 * `--pv-accent`, у «Чатов» — число чатов с непрочитанным. «+» на списке чатов — меню (новое сообщение, группа,
 * канал, запись в план), в остальных разделах — сразу ввод текстом в «План».
 */
object ParvaneTabBar {
    enum class Tab { CHATS, PLAN, KNOWLEDGE, PROFILE }

    /** 3,5 rem, как `--parvane-tab-bar-height` (без системной навигации). */
    fun height() = Pv.rem(3.5f)

    /** Главный экран X: панель поверх низа списка чатов; список поднимается над ней, карандаша X нет. */
    @JvmStatic
    fun attachToMain(owner: ViewController<*>, contentView: ViewGroup, mainWrap: View, compose: View?) {
        compose?.visibility = View.GONE
        val bar = create(owner.context(), owner, Tab.CHATS)
        contentView.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height(), Gravity.BOTTOM))
        fitNavigation(bar, mainWrap)
        (owner as? org.thunderdog.challegram.ui.MainController)?.let { ParvaneChatsHeader.attach(it, contentView, mainWrap) }
    }

    /**
     * Главный экран X рисует под системной панелью навигации: панель разделов встаёт над ней (нижний отступ на её высоту), а
     * содержимое [above] поднимается над панелью целиком. Высоту и padding панели корень X при раскладке не учитывает. Без этого подписи и нажатия панели
     * уходили под кнопки ◀ ● ■ (снимки тем T074).
     */
    private fun fitNavigation(bar: View, vararg above: View) {
        fun apply(inset: Int) {
            val total = height() + inset
            (bar.layoutParams as? ViewGroup.MarginLayoutParams)?.let {
                if (it.bottomMargin != inset) { it.bottomMargin = inset; bar.layoutParams = it; android.util.Log.i("ParvaneClient", "панель разделов: отступ навигации $inset") }
            }
            above.forEach { v ->
                (v.layoutParams as? ViewGroup.MarginLayoutParams)?.let { if (it.bottomMargin != total) { it.bottomMargin = total; v.layoutParams = it } }
            }
        }
        // Только панель навигации, без клавиатуры: панель не прыгает, когда открыт ввод
        fun insetOf(w: WindowInsets?): Int = when {
            w == null -> 0
            Build.VERSION.SDK_INT >= 30 -> w.getInsets(WindowInsets.Type.navigationBars()).bottom
            else -> @Suppress("DEPRECATION") w.stableInsetBottom
        }
        apply(0)
        // Вставки, которые X передаёт детям, уже «съедены» (0) — высота навигации берётся у окна
        bar.setOnApplyWindowInsetsListener { v, w -> apply(insetOf(v.rootWindowInsets)); w }
        bar.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) { v.post { apply(insetOf(v.rootWindowInsets)) } }
            override fun onViewDetachedFromWindow(v: View) {}
        })
    }

    fun create(context: Context, owner: ViewController<*>, current: Tab): View {
        val bar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(0.375f), Pv.rem(0.25f), Pv.rem(0.375f), Pv.rem(0.25f))
            isClickable = true // нажатия мимо кнопок не проходят в список под панелью
        }
        val badge = arrayOfNulls<TextView>(1)
        fill(context, owner, current, bar, badge)
        if (badge[0] != null) trackUnread(owner, bar, badge)
        // Смена темы (ночной режим): панель — та же, кнопки заново цветами новой темы
        Pv.onTheme(bar) { bar.removeAllViews(); fill(context, owner, current, bar, badge); trackUnread(owner, bar, badge, attach = false) }
        return bar
    }

    private fun fill(context: Context, owner: ViewController<*>, current: Tab, bar: LinearLayout, badgeOut: Array<TextView?>) {
        val c = Pv.c
        // Линия `--pv-line` сверху, фон `--pv-panel`
        bar.background = LayerDrawable(arrayOf(GradientDrawable().apply { setColor(c.line) }, GradientDrawable().apply { setColor(c.panel) }))
            .apply { setLayerInset(1, 0, Pv.px(1f), 0, 0) }
        var badge: TextView? = null
        fun item(icon: String, title: String, tab: Tab, onClick: () -> Unit) {
            val selected = tab == current
            val tint = if (selected) c.accent else c.muted
            val box = FrameLayout(context).apply {
                contentDescription = title
                isClickable = true
                setOnClickListener { onClick() }
            }
            val column = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
            }
            column.addView(context.pvIcon(icon, tint, 1.375f))
            column.addView(context.pvText(title, 0.6875f, tint, maxLines = 1).apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(0.125f) }
            })
            box.addView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER))
            if (tab == Tab.CHATS) {
                // Счётчик — справа сверху от значка: top .125rem, left 50% + .375rem
                val b = context.pvText("", 0.6875f, c.accentInk, semibold = true, mono = true).apply {
                    gravity = Gravity.CENTER
                    minWidth = Pv.rem(1.125f)
                    setPadding(Pv.rem(0.3125f), 0, Pv.rem(0.3125f), 0)
                    background = Pv.shape(c.blue, 0.5625f)
                    visibility = View.GONE
                }
                box.addView(b, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(1.125f), Gravity.TOP or Gravity.START))
                box.addOnLayoutChangeListener { _, l, _, r, _, _, _, _, _ ->
                    b.translationX = ((r - l) / 2 + Pv.rem(0.375f)).toFloat()
                    b.translationY = Pv.rem(0.125f).toFloat()
                }
                badge = b
            }
            bar.addView(box, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        }
        item("chat", Sx.t("Чаты", "Chats"), Tab.CHATS) { open(owner, Tab.CHATS, current) }
        item("calendar", Sx.t("План", "Planner"), Tab.PLAN) { open(owner, Tab.PLAN, current) }
        // «+» — пилюля акцента 3,5 × 2,75 rem, радиус 0,875 rem, значок 1,625 rem толщиной 2,4
        val plus = FrameLayout(context).apply {
            contentDescription = Sx.t("Новая запись", "New entry")
            addView(android.widget.ImageView(context).apply {
                setImageDrawable(PvIconDrawable("plus", c.accentInk, Pv.rem(1.625f), 2.4f))
                scaleType = android.widget.ImageView.ScaleType.CENTER
            }, FrameLayout.LayoutParams(Pv.rem(1.625f), Pv.rem(1.625f), Gravity.CENTER))
            Pv.pressable(this, c.accent, 0.875f) {
                if (current == Tab.CHATS) showAddMenu(owner, this) else QuickAdd.show(owner)
            }
        }
        bar.addView(plus, LinearLayout.LayoutParams(Pv.rem(3.5f), Pv.rem(2.75f)).apply {
            setMargins(Pv.rem(0.375f), Pv.rem(0.125f), Pv.rem(0.375f), Pv.rem(0.125f))
        })
        item("book", Sx.t("Знания", "Knowledge"), Tab.KNOWLEDGE) { open(owner, Tab.KNOWLEDGE, current) }
        item("user", Sx.t("Профиль", "Profile"), Tab.PROFILE) { open(owner, Tab.PROFILE, current) }
        badgeOut[0] = badge
    }

    /** Число чатов с непрочитанным (как `chatsCount` папки «Все» в web), до 99+. */
    /** Счётчик в [holder] (после смены темы там новый вид); [attach] — подписаться на счётчики (один раз на панель). */
    private fun trackUnread(owner: ViewController<*>, bar: View, holder: Array<TextView?>, attach: Boolean = true) {
        val tdlib = owner.tdlib()
        fun update() {
            val badge = holder[0] ?: return
            val n = try { tdlib.getMainCounter().chatCount } catch (e: Throwable) { 0 }
            badge.text = if (n > 99) "99+" else n.toString()
            badge.visibility = if (n > 0) View.VISIBLE else View.GONE
        }
        if (!attach) { update(); return }
        val listener = object : org.thunderdog.challegram.telegram.CounterChangeListener {
            override fun onChatCounterChanged(chatList: TdApi.ChatList, counter: org.thunderdog.challegram.telegram.TdlibCounter, availabilityChanged: Boolean, totalCount: Int, unreadCount: Int, unreadUnmutedCount: Int) {
                if (chatList is TdApi.ChatListMain) Sx.main.post { update() }
            }
        }
        bar.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) { tdlib.listeners().addTotalChatCounterListener(listener); update() }
            override fun onViewDetachedFromWindow(v: View) { tdlib.listeners().removeTotalChatCounterListener(listener) }
        })
        update()
    }

    /** Меню «+» на списке чатов — над кнопкой, по центру панели, ширина 13,5 rem (`.addMenu`). */
    private fun showAddMenu(owner: ViewController<*>, anchor: View) {
        val ctx = owner.context()
        val c = Pv.c
        lateinit var popup: PopupWindow
        val list = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, Pv.rem(0.25f), 0, Pv.rem(0.25f))
            background = Pv.shape(c.panel, 0.75f, c.line)
            elevation = Pv.px(8f).toFloat()
        }
        fun row(icon: String, title: String, action: () -> Unit) {
            list.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(Pv.rem(1f), 0, Pv.rem(1f), 0)
                addView(ctx.pvIcon(icon, c.muted, 1.5f))
                addView(ctx.pvText(title, 0.875f, c.fg).apply {
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = Pv.rem(1.25f) }
                })
                Pv.pressable(this, 0, 0.375f) { popup.dismiss(); action() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.rem(3f)))
        }
        row("user", Sx.t("Новое сообщение", "New Message")) {
            owner.navigateTo(ContactsController(ctx, owner.tdlib()).apply { initWithMode(ContactsController.MODE_NEW_CHAT) })
        }
        row("users", Sx.t("Новая группа", "New Group")) {
            owner.navigateTo(ContactsController(ctx, owner.tdlib()).apply { initWithMode(ContactsController.MODE_NEW_GROUP) })
        }
        row("megaphone", Sx.t("Новый канал", "New Channel")) { owner.navigateTo(CreateChannelController(ctx, owner.tdlib())) }
        row("calendar", Sx.t("Запись в план", "Plan entry")) { QuickAdd.show(owner) }
        val width = Pv.rem(13.5f)
        popup = PopupWindow(list, width, ViewGroup.LayoutParams.WRAP_CONTENT, true).apply {
            elevation = Pv.px(8f).toFloat()
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(0))
        }
        list.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.UNSPECIFIED)
        val bar = anchor.parent as View
        val loc = IntArray(2).also { bar.getLocationInWindow(it) }
        popup.showAtLocation(bar, Gravity.TOP or Gravity.START, loc[0] + (bar.width - width) / 2, loc[1] - list.measuredHeight - Pv.rem(0.25f))
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
