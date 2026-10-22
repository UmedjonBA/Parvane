package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.navigation.BackHeaderButton
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId

/**
 * Parvane (spec 031): экран раздела внутри навигации X — заголовок X, прокручиваемое тело и нижняя панель
 * разделов (как телефонная версия web: Чаты · План · + · Знания · Профиль). Тело перестраивается целиком по
 * снимку данных ([render]); раздел сообщает хабу ядра, что он на экране (подписка на данные «Плана»/облака).
 */
abstract class SectionController(context: Context, tdlib: Tdlib) : ViewController<Void>(context, tdlib) {
    protected lateinit var scroll: ScrollView
    protected lateinit var body: LinearLayout
    private val unwatch = mutableListOf<() -> Unit>()

    /** chats | calendar | health | knowledge | files — имя раздела для хаба ядра. */
    abstract val section: String
    /** Вкладка нижней панели, подсвеченная на этом экране. */
    abstract val tab: ParvaneTabBar.Tab

    override fun getBackButton(): Int = BackHeaderButton.TYPE_BACK

    override fun onCreateView(context: Context): View {
        val root = FrameLayout(context).apply { setBackgroundColor(Sx.color(ColorId.background)) }
        val (s, b) = context.scrollBody()
        scroll = s
        body = b
        root.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
            bottomMargin = ParvaneTabBar.height()
        })
        // Экран раздела X уже ставит над системной навигацией (в отличие от главного экрана — ParvaneTabBar.fitNavigation)
        root.addView(ParvaneTabBar.create(context, this, tab), FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
            ParvaneTabBar.height(), Gravity.BOTTOM))
        addThemeInvalidateListener(root)
        onBuilt()
        return root
    }

    /** Вид построен: подписки на данные. */
    protected open fun onBuilt() {}

    protected fun watch(domain: String, cb: (org.json.JSONObject) -> Unit) {
        unwatch += Sx.watch(domain, cb)
    }

    /** Перестроить тело, сохранив прокрутку. */
    protected fun rebuild(fill: LinearLayout.() -> Unit) {
        val y = scroll.scrollY
        body.removeAllViews()
        body.fill()
        scroll.post { scroll.scrollTo(0, y) }
    }

    override fun onFocus() {
        super.onFocus()
        ParvaneSections.show(section)
        ParvaneSections.setVisible(true)
    }

    override fun onBlur() {
        super.onBlur()
        ParvaneSections.show("chats")
    }

    override fun destroy() {
        unwatch.forEach { it() }
        unwatch.clear()
        super.destroy()
    }

    /** Пустое состояние / загрузка (текст с многоточием — с маскотом, как web). */
    protected fun LinearLayout.placeholder(text: String) {
        if (text.endsWith("…")) addView(MascotView(context), lp(t = Sx.dp(40f)).apply { gravity = Gravity.CENTER_HORIZONTAL; width = Sx.dp(64f) })
        addView(context.label(text, 15f, ColorId.textLight).apply {
            gravity = Gravity.CENTER
            layoutParams = lp(t = Sx.dp(48f), l = Sx.dp(24f), r = Sx.dp(24f))
        })
    }

    /** Ряд вкладок раздела (Сегодня/Месяц/… ) — горизонтально прокручиваемые пилюли. */
    protected fun LinearLayout.tabs(items: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit) {
        val row = context.hbox().apply { setPadding(Sx.dp(8f), Sx.dp(10f), Sx.dp(8f), Sx.dp(4f)) }
        items.forEach { (id, title) -> row.addView(context.chip(title, id == selected) { onPick(id) }) }
        addView(android.widget.HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            addView(row)
        }, lp())
    }

    protected fun toast(text: String) = org.thunderdog.challegram.tool.UI.showToast(text, android.widget.Toast.LENGTH_SHORT)

    protected fun TextView.grow(): TextView = apply { layoutParams = lp(0, weight = 1f) }
}
