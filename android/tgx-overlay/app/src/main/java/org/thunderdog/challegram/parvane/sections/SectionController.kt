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

/**
 * Parvane (spec 031/032): экран раздела внутри навигации X, вид телефонной версии web: своя шапка раздела
 * ([buildHeader] — вкладки «Плана», «Знаний» либо «← Название»), прокручиваемое тело на фоне `--pv-panel` и нижняя
 * панель разделов. Шапки X нет. Тело перестраивается целиком по снимку данных ([rebuild]); раздел сообщает хабу ядра,
 * что он на экране (подписка на данные «Плана»/облака).
 */
abstract class SectionController(context: Context, tdlib: Tdlib) : ViewController<Void>(context, tdlib) {
    protected lateinit var scroll: ScrollView
    protected lateinit var body: LinearLayout
    protected lateinit var headerSlot: FrameLayout
    /** Закреплённая полоса под шапкой (полоса дней «Дня»): не прокручивается с телом, снимается при [rebuild]. */
    protected lateinit var pinnedSlot: FrameLayout
    protected lateinit var contentSlot: FrameLayout
    private val unwatch = mutableListOf<() -> Unit>()

    /** chats | calendar | health | knowledge | files — имя раздела для хаба ядра. */
    abstract val section: String
    /** Вкладка нижней панели, подсвеченная на этом экране. */
    abstract val tab: ParvaneTabBar.Tab

    override fun getBackButton(): Int = BackHeaderButton.TYPE_NONE
    override fun getHeaderHeight(): Int = 0
    // Шапка X рисует название и при нулевой высоте — вместо него пустая ячейка (параметры FrameLayout: X двигает её отступами)
    private val emptyHeader by lazy { android.view.View(context()).apply { layoutParams = android.widget.FrameLayout.LayoutParams(0, 0) } }
    override fun getCustomHeaderCell(): android.view.View = emptyHeader

    override fun onCreateView(context: Context): View {
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Pv.c.panel)
        }
        headerSlot = FrameLayout(context)
        root.addView(headerSlot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        pinnedSlot = FrameLayout(context)
        root.addView(pinnedSlot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        contentSlot = FrameLayout(context)
        root.addView(contentSlot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val (s, b) = context.scrollBody()
        scroll = s
        body = b
        contentSlot.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(ParvaneTabBar.create(context, this, tab), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ParvaneTabBar.height()))
        setHeader(buildHeader(context))
        addThemeInvalidateListener(root)
        root.coverHeaderArea()
        onBuilt()
        return root
    }

    /** Шапка раздела; по умолчанию — «← Название», как шапка «Профиля» web. */
    protected open fun buildHeader(context: Context): View? = backHeader(getName()?.toString().orEmpty())

    protected fun setHeader(view: View?) {
        headerSlot.removeAllViews()
        view?.let { headerSlot.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)) }
    }

    /** «← Название»: стрелка `.ib` и заголовок 1,25 rem semibold, линия снизу (шапка экранов настроек web). */
    protected fun backHeader(title: String, trailing: View? = null): View = context().pvHeader().apply {
        minimumHeight = Pv.rem(3.5f)
        setPadding(Pv.rem(0.5f), 0, Pv.rem(0.5f), 0)
        addView(context.pvIconButton("left", Sx.t("Назад", "Back"), Pv.c.muted) { navigateBack() })
        addView(context.pvText(title, 1.25f, Pv.c.fg, semibold = true, maxLines = 1).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Pv.rem(1.25f) }
        })
        trailing?.let { addView(it) }
    }

    /** Вид построен: подписки на данные. */
    protected open fun onBuilt() {}

    protected fun watch(domain: String, cb: (org.json.JSONObject) -> Unit) {
        unwatch += Sx.watch(domain, cb)
    }

    internal fun setPinned(view: View?) {
        pinnedSlot.removeAllViews()
        view?.let { pinnedSlot.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)) }
    }

    /** Перестроить тело, сохранив прокрутку. */
    protected fun rebuild(fill: LinearLayout.() -> Unit) {
        val y = scroll.scrollY
        pinnedSlot.removeAllViews()
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
        if (text.endsWith("…")) addView(MascotView(context), lp(t = Pv.rem(2.5f)).apply { gravity = Gravity.CENTER_HORIZONTAL; width = Pv.rem(4f) })
        addView(context.pvText(text, 0.9375f, Pv.c.muted).apply {
            gravity = Gravity.CENTER
            layoutParams = lp(t = Pv.rem(1.5f), l = Pv.rem(1.5f), r = Pv.rem(1.5f))
        })
    }

    protected fun toast(text: String) = org.thunderdog.challegram.tool.UI.showToast(text, android.widget.Toast.LENGTH_SHORT)

    protected fun TextView.grow(): TextView = apply { layoutParams = lp(0, weight = 1f) }
}
