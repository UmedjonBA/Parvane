package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import org.json.JSONArray
import org.json.JSONObject
import org.thunderdog.challegram.R
import org.thunderdog.challegram.telegram.Tdlib

/**
 * Parvane (spec 032): раздел «План» 1:1 с телефонной версией web (`Planner.tsx` ≤ 925 px). Шапка — вкладки
 * «Календарь · Здоровье» и лупа; у календаря — строка периода и переключатель «Сегодня · День · Мес · Год · Список»
 * с шестерёнкой. Данные — запросы к логике ядра (`days`, `health`, `undated`, `lists`), правки — её операциями;
 * экраны только рисуют ([PlannerViews]).
 */
class PlannerController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section get() = if (tabHealth) "health" else "calendar"
    override val tab = ParvaneTabBar.Tab.PLAN
    override fun getId() = R.id.controller_parvanePlanner
    override fun getName(): CharSequence = Sx.t("План", "Planner")

    private val prefs get() = context().getSharedPreferences("parvane_planner_ui", Context.MODE_PRIVATE)

    internal var tabHealth = false
    /** today | week | month | year | agenda — как `calendarView` web, «Сегодня» — первое положение. */
    internal var segment = "today"
    internal var picked = Sx.today()
    internal var layers = mutableSetOf("sleep", "food", "work")
    internal var status = "loading"
    private var generation = 0
    private var startAction: (() -> Unit)? = null

    fun openSettings() = apply { startAction = { PlannerEditor.openSettings(this) } }
    fun openHealthGoals() = apply { tabHealth = true; startAction = { openHealthGoalsSheet() } }

    override fun onBuilt() {
        segment = prefs.getString("segment", "today") ?: "today"
        layers = (prefs.getStringSet("layers", setOf("sleep", "food", "work")) ?: setOf("sleep", "food", "work")).toMutableSet()
        watch("planner") { snap ->
            status = snap.optString("status", "loading")
            snap.optJSONObject("notice")?.let { PlannerViews.showNotice(this, it) }
            refresh()
        }
        if (Sx.last("planner") == null) refresh()
        startAction?.let { a -> startAction = null; Sx.main.post { a() } }
    }

    override fun buildHeader(context: Context): View = header()
    override fun repaint() = refresh()

    // ── шапка ────────────────────────────────────────────────────────────────────────

    /** `.mtabs`: вкладки-пилюли «Календарь · Здоровье» и лупа; ниже — шапка календаря (`.hdr.calendarHdr`). */
    private fun header(): View {
        val ctx = context()
        val c = Pv.c
        val box = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(c.panel) }
        val tabs = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.5f), Pv.rem(0.375f))
            background = pvBottomLine(c.panel)
        }
        fun tab(title: String, on: Boolean, onClick: () -> Unit) = ctx.pvText(title, 1.0625f, if (on) c.accent else c.muted, semibold = true).apply {
            gravity = Gravity.CENTER
            setPadding(Pv.rem(1f), 0, Pv.rem(1f), 0)
            Pv.pressable(this, if (on) Pv.mix(c.accent, c.panel, 15) else 0, 1.25f, onClick = onClick)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.5f)).apply { rightMargin = Pv.rem(0.25f) }
        }
        tabs.addView(tab(Sx.t("Календарь", "Calendar"), !tabHealth) { switchTab(false) })
        tabs.addView(tab(Sx.t("Здоровье", "Health"), tabHealth) { switchTab(true) })
        tabs.addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
        tabs.addView(ctx.pvIconButton("search", Sx.t("Поиск по «Плану»", "Search the plan"), c.muted) { PlannerViews.openSearch(this) })
        box.addView(tabs)
        if (!tabHealth) box.addView(calendarHeader())
        return box
    }

    private fun calendarHeader(): View {
        val ctx = context()
        val c = Pv.c
        val hdr = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Pv.rem(0.75f), Pv.rem(0.5f), Pv.rem(0.75f), Pv.rem(0.5f))
            background = pvBottomLine(c.panel)
        }
        if (segment != "today") {
            // `.periodNav`: заголовок периода (1,0625 rem semibold, выбор месяца) и «Текущая дата», если день не сегодня
            val nav = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            nav.addView(ctx.pvText(periodTitle(), 1.0625f, c.fg, semibold = true, maxLines = 1).apply {
                setPadding(Pv.rem(0.375f), Pv.rem(0.25f), Pv.rem(0.375f), Pv.rem(0.25f))
                Pv.pressable(this, 0, 0.5f) { PlannerViews.pickPeriod(this@PlannerController) }
            })
            nav.addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
            if (picked != Sx.today()) nav.addView(ctx.pvPill(Sx.t("Текущая дата", "Current date")) { pickDay(Sx.today()) })
            hdr.addView(nav, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.rem(2.75f)))
        }
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        // `.seg`: группа 0,1875 rem отступа на raised, выбранный — panel с тенью
        val seg = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(Pv.rem(0.1875f), Pv.rem(0.1875f), Pv.rem(0.1875f), Pv.rem(0.1875f))
            background = Pv.shape(c.raised, 1.125f)
        }
        val items = listOf("today" to Sx.t("Сегодня", "Today"), "week" to Sx.t("День", "Day"), "month" to Sx.t("Мес", "Mon"),
            "year" to Sx.t("Год", "Year"), "agenda" to Sx.t("Список", "List"))
        for ((value, title) in items) {
            val on = value == segment
            seg.addView(ctx.pvText(title, 0.875f, if (on) c.fg else c.muted).apply {
                gravity = Gravity.CENTER
                setPadding(Pv.rem(0.625f), 0, Pv.rem(0.625f), 0)
                if (on) { background = Pv.shape(c.panel, 0.9375f); elevation = Pv.px(1.5f).toFloat() }
                isClickable = true
                setOnClickListener { switchSegment(value) }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(1.875f)))
        }
        row.addView(HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(seg)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(ctx.pvIconButton("settings", Sx.t("Настройки плана", "Planner settings"), c.muted) { PlannerEditor.openSettings(this) }.apply {
            (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f)
        })
        hdr.addView(row)
        return hdr
    }

    internal fun periodTitle(): String {
        val cal = Sx.calendarOf(picked)
        val y = cal.get(java.util.Calendar.YEAR)
        val m = cal.get(java.util.Calendar.MONTH)
        return when (segment) {
            "year" -> "$y"
            "agenda" -> PlannerViews.rangeTitle(picked, Sx.addDays(picked, 29))
            else -> Sx.monthTitle(y, m)
        }
    }

    private fun switchTab(health: Boolean) {
        if (tabHealth == health) return
        tabHealth = health
        org.parvane.core.ParvaneSections.show(section)
        setHeader(header())
        refresh()
    }

    internal fun switchSegment(value: String) {
        segment = value
        prefs.edit().putString("segment", value).apply()
        setHeader(header())
        refresh()
    }

    internal fun pickDay(day: String) {
        picked = day
        setHeader(header())
        refresh()
    }

    internal fun toggleLayer(layer: String) {
        if (!layers.remove(layer)) layers.add(layer)
        prefs.edit().putStringSet("layers", layers).apply()
        refresh()
    }

    /** Сдвиг периода стрелками и свайпом: день, месяц, год либо 30 дней. */
    internal fun shift(sign: Int) {
        val c = Sx.calendarOf(picked)
        when (if (tabHealth) "today" else segment) {
            "month" -> c.add(java.util.Calendar.MONTH, sign)
            "year" -> c.add(java.util.Calendar.YEAR, sign)
            "agenda" -> c.add(java.util.Calendar.DAY_OF_MONTH, 30 * sign)
            "week" -> c.add(java.util.Calendar.DAY_OF_MONTH, 7 * sign)
            else -> c.add(java.util.Calendar.DAY_OF_MONTH, sign)
        }
        pickDay(Sx.dayOf(c))
    }

    // ── данные ───────────────────────────────────────────────────────────────────────

    fun refresh() {
        val gen = ++generation
        if (status != "ready" && Sx.last("planner") == null) {
            rebuild { placeholder(Sx.t("Загрузка…", "Loading…")) }
            return
        }
        if (tabHealth) {
            Sx.planner("health", JSONObject().put("day", picked)) { r ->
                if (gen == generation) rebuild {
                    page()
                    PlannerViews.dateNav(this@PlannerController, this)
                    HealthView.render(this, this@PlannerController, picked, r as? JSONObject,
                        onExample = { QuickAdd.show(this@PlannerController, it) },
                        onSettings = { openHealthGoalsSheet() },
                        onDay = { pickDay(it) })
                }
            }
            return
        }
        when (segment) {
            "today" -> load(gen, picked, picked) { days, health, undated ->
                rebuild { page(); PlannerViews.dateNav(this@PlannerController, this); PlannerViews.today(this@PlannerController, this, days.optJSONObject(picked) ?: JSONObject(), health, undated) }
            }
            "week" -> load(gen, picked, picked, withUndated = false) { days, health, _ ->
                val week = PlannerViews.weekKeys(picked)
                Sx.planner("days", JSONObject().put("from", week.first()).put("to", week.last())) { strip ->
                    if (gen == generation) rebuild { PlannerViews.dayView(this@PlannerController, this, days.optJSONObject(picked) ?: JSONObject(), health, strip as? JSONObject ?: JSONObject()) }
                }
            }
            "month" -> {
                val c = Sx.calendarOf(picked)
                Sx.planner("monthGrid", JSONObject().put("year", c.get(java.util.Calendar.YEAR)).put("month", c.get(java.util.Calendar.MONTH) + 1)) { keys ->
                    val list = (keys as? JSONArray)?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
                    if (list.isEmpty() || gen != generation) return@planner
                    load(gen, list.first(), list.last(), layout = false, withUndated = false) { days, health, _ ->
                        Sx.planner("days", JSONObject().put("from", picked).put("to", picked).put("layout", true)) { one ->
                            if (gen == generation) rebuild {
                                page()
                                PlannerViews.month(this@PlannerController, this, list, days, (one as? JSONObject)?.optJSONObject(picked) ?: JSONObject(), health)
                            }
                        }
                    }
                }
            }
            "year" -> {
                val y = Sx.calendarOf(picked).get(java.util.Calendar.YEAR)
                Sx.planner("days", JSONObject().put("from", "$y-01-01").put("to", "$y-12-31")) { r ->
                    if (gen == generation) rebuild { page(); PlannerViews.year(this@PlannerController, this, y, r as? JSONObject ?: JSONObject()) }
                }
            }
            "agenda" -> Sx.planner("days", JSONObject().put("from", picked).put("to", Sx.addDays(picked, 29)).put("layout", true)) { r ->
                Sx.planner("lists") { lists ->
                    if (gen == generation) rebuild { page(); PlannerViews.agenda(this@PlannerController, this, r as? JSONObject ?: JSONObject(), lists as? JSONArray ?: JSONArray()) }
                }
            }
        }
    }

    /** Отступы `.content` телефона: 0,875 / 1 / 1,5 rem. */
    private fun LinearLayout.page() = setPadding(Pv.rem(1f), Pv.rem(0.875f), Pv.rem(1f), Pv.rem(1.5f))

    private fun load(gen: Int, from: String, to: String, layout: Boolean = true, withUndated: Boolean = true,
                     done: (JSONObject, JSONObject?, JSONObject?) -> Unit) {
        Sx.planner("days", JSONObject().put("from", from).put("to", to).put("layout", layout)) { days ->
            Sx.planner("health", JSONObject().put("day", picked)) { health ->
                val finish = { undated: Any? ->
                    if (gen == generation) done(days as? JSONObject ?: JSONObject(), health as? JSONObject, undated as? JSONObject)
                }
                if (withUndated) Sx.planner("undated") { finish(it) } else finish(null)
            }
        }
    }

    /** К вкладке «Здоровье» на выбранном дне (карточки «Сон»/«Еда», метки сна и калорий). */
    internal fun openHealthTab() = switchTab(true)

    internal fun scrollTo(y: Int) = scroll.post { scroll.scrollTo(0, y) }

    internal fun toastText(text: String) = toast(text)

    internal fun openHealthGoalsSheet() {
        Sx.planner("health", JSONObject().put("day", picked)) { r ->
            val sheet = PvSheet.create(context(), Sx.t("Настройки здоровья", "Health settings"))
            val box = LinearLayout(context()).apply { orientation = LinearLayout.VERTICAL }
            HealthView.renderGoals(box, this, r as? JSONObject)
            sheet.add(box).show()
        }
    }
}
