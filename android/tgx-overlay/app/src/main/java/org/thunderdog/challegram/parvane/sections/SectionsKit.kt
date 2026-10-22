package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneCore
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.core.Lang
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import org.thunderdog.challegram.tool.Screen
import java.util.concurrent.Executors

/**
 * Parvane (spec 031, US5–US7): общее для родных экранов разделов «План», «Здоровье», «Знания», «Облако».
 * Данные — снимки хаба разделов ядра (`ParvaneSections`, событие `sections_snapshot`), правки — его операциями;
 * логика (повторы, подсчёты, разбор ввода) — в ядре, экраны только рисуют. Цвета — из текущей темы X,
 * тексты — EN/RU по языку интерфейса X.
 */
object Sx {
    val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "parvane-sections-ui") }

    fun isRu(): Boolean = try {
        Lang.packId()?.startsWith("ru") ?: (java.util.Locale.getDefault().language == "ru")
    } catch (e: Throwable) {
        java.util.Locale.getDefault().language == "ru"
    }

    fun t(ru: String, en: String) = if (isRu()) ru else en
    fun dp(v: Float) = Screen.dp(v)
    fun dp(v: Int) = Screen.dp(v.toFloat())
    fun color(id: Int) = Theme.getColor(id)

    /** Работа с ядром — на своём потоке, ответ — на главном. */
    fun <T> async(work: () -> T, done: (T) -> Unit) {
        io.execute {
            val r = try { work() } catch (e: Throwable) { android.util.Log.e("ParvaneSections", "операция", e); null }
            @Suppress("UNCHECKED_CAST")
            main.post { done(r as T) }
        }
    }

    fun planner(op: String, args: JSONObject = JSONObject(), done: (Any?) -> Unit = {}) =
        async({ ParvaneSections.planner(op, args) }, done)

    // ── снимки хаба ─────────────────────────────────────────────────────────────
    private val listeners = mutableMapOf<String, MutableList<(JSONObject) -> Unit>>()
    private val cache = mutableMapOf<String, JSONObject>()
    @Volatile private var hooked = false

    private fun hook() {
        if (hooked) return
        hooked = true
        ParvaneCore.addListener { event ->
            if (event.optString("type") != "sections_snapshot") return@addListener
            val domain = event.optString("domain")
            val snap = ParvaneSections.snapshot(domain) ?: return@addListener
            main.post {
                cache[domain] = snap
                listeners[domain]?.toList()?.forEach { it(snap) }
            }
        }
    }

    /** Подписка на снимки домена (planner | notes | cloud); текущий — сразу, если есть. Отписка — вернувшимся. */
    fun watch(domain: String, cb: (JSONObject) -> Unit): () -> Unit {
        hook()
        listeners.getOrPut(domain) { mutableListOf() }.add(cb)
        (cache[domain] ?: ParvaneSections.snapshot(domain)?.also { cache[domain] = it })?.let { cb(it) }
        return { listeners[domain]?.remove(cb) }
    }

    fun last(domain: String): JSONObject? = cache[domain]

    // ── даты ────────────────────────────────────────────────────────────────────
    private val dayFormat = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
    fun today(): String = dayFormat.format(java.util.Date())
    fun addDays(day: String, n: Int): String {
        val c = java.util.Calendar.getInstance()
        c.time = dayFormat.parse(day) ?: java.util.Date()
        c.add(java.util.Calendar.DAY_OF_MONTH, n)
        return dayFormat.format(c.time)
    }
    fun calendarOf(day: String): java.util.Calendar =
        java.util.Calendar.getInstance().apply { time = dayFormat.parse(day) ?: java.util.Date() }
    fun dayOf(c: java.util.Calendar): String = dayFormat.format(c.time)

    private val ruMonths = arrayOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")
    private val ruMonthsNom = arrayOf("Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь")
    private val enMonths = arrayOf("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
    private val ruWeek = arrayOf("вс", "пн", "вт", "ср", "чт", "пт", "сб")
    private val enWeek = arrayOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

    fun weekdayShort(dow0: Int) = if (isRu()) ruWeek[dow0] else enWeek[dow0]
    fun monthTitle(year: Int, month0: Int) = if (isRu()) "${ruMonthsNom[month0]} $year" else "${enMonths[month0]} $year"

    /** «Сегодня», «Завтра», «пн, 26 октября». */
    fun dayTitle(day: String): String {
        val today = today()
        if (day == today) return t("Сегодня", "Today")
        if (day == addDays(today, 1)) return t("Завтра", "Tomorrow")
        if (day == addDays(today, -1)) return t("Вчера", "Yesterday")
        val c = calendarOf(day)
        val dow = c.get(java.util.Calendar.DAY_OF_WEEK) - 1
        val d = c.get(java.util.Calendar.DAY_OF_MONTH)
        val m = c.get(java.util.Calendar.MONTH)
        return if (isRu()) "${ruWeek[dow]}, $d ${ruMonths[m]}" else "${enWeek[dow]}, ${enMonths[m]} $d"
    }

    fun minutesLabel(min: Int): String {
        val h = min / 60
        val m = min % 60
        return when {
            h == 0 -> t("$m мин", "$m min")
            m == 0 -> t("$h ч", "$h h")
            else -> t("$h ч $m мин", "$h h $m min")
        }
    }

    fun toMinutes(time: String?): Int {
        if (time.isNullOrEmpty() || time.length < 5) return -1
        return (time.substring(0, 2).toIntOrNull() ?: return -1) * 60 + (time.substring(3, 5).toIntOrNull() ?: return -1)
    }

    fun clock(min: Int) = String.format(java.util.Locale.US, "%02d:%02d", (min / 60) % 24, min % 60)

    // ── цвета списков (палитра собеседников X, индекс 1…8) ─────────────────────
    private val palette = intArrayOf(ColorId.avatarRed, ColorId.avatarOrange, ColorId.avatarViolet, ColorId.avatarGreen,
        ColorId.avatarCyan, ColorId.avatarBlue, ColorId.avatarPink, ColorId.avatarYellow)
    fun listColor(index: Int): Int = if (index in 1..palette.size) color(palette[index - 1]) else color(ColorId.iconLight)

    fun list(a: JSONArray?): List<JSONObject> = (0 until (a?.length() ?: 0)).mapNotNull { a!!.optJSONObject(it) }
}

// ── построители видов ────────────────────────────────────────────────────────────

fun Context.vbox(pad: Int = 0): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(pad, pad, pad, pad)
}

fun Context.hbox(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
}

fun Context.label(text: CharSequence, sizeSp: Float = 15f, colorId: Int = ColorId.text, bold: Boolean = false,
                  maxLines: Int = 0): TextView = TextView(this).apply {
    this.text = text
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
    setTextColor(Sx.color(colorId))
    typeface = if (bold) Typeface.create(Typeface.DEFAULT, Typeface.BOLD) else Typeface.DEFAULT
    if (maxLines > 0) {
        this.maxLines = maxLines
        ellipsize = TextUtils.TruncateAt.END
    }
}

fun rounded(fill: Int, radiusDp: Float = 14f, stroke: Int = 0): GradientDrawable = GradientDrawable().apply {
    cornerRadius = Sx.dp(radiusDp).toFloat()
    setColor(fill)
    if (stroke != 0) setStroke(Sx.dp(1f), stroke)
}

fun View.pressable(radiusDp: Float = 14f, fill: Int = Sx.color(ColorId.filling), onClick: () -> Unit) {
    background = RippleDrawable(ColorStateList.valueOf(Sx.color(ColorId.fillingPressed)), rounded(fill, radiusDp), rounded(0xff000000.toInt(), radiusDp))
    isClickable = true
    setOnClickListener { onClick() }
}

fun lp(w: Int = ViewGroup.LayoutParams.MATCH_PARENT, h: Int = ViewGroup.LayoutParams.WRAP_CONTENT, weight: Float = 0f,
       l: Int = 0, t: Int = 0, r: Int = 0, b: Int = 0) = LinearLayout.LayoutParams(w, h, weight).apply { setMargins(l, t, r, b) }

/** Карточка: скруглённый блок цвета «заливки» с отступами. */
fun Context.card(): LinearLayout = vbox(Sx.dp(14f)).apply {
    background = rounded(Sx.color(ColorId.filling))
    layoutParams = lp(t = Sx.dp(10f), l = Sx.dp(12f), r = Sx.dp(12f))
}

/** Пилюля-переключатель (вкладки внутри раздела, фильтры). */
fun Context.chip(text: String, selected: Boolean, onClick: () -> Unit): TextView = label(text, 14f,
    if (selected) ColorId.fillingPositiveContent else ColorId.text, bold = selected).apply {
    gravity = Gravity.CENTER
    setPadding(Sx.dp(14f), Sx.dp(7f), Sx.dp(14f), Sx.dp(7f))
    pressable(18f, if (selected) Sx.color(ColorId.fillingPositive) else Sx.color(ColorId.filling), onClick)
    layoutParams = lp(ViewGroup.LayoutParams.WRAP_CONTENT, l = Sx.dp(4f), r = Sx.dp(4f))
}

/** Кнопка действия во всю ширину. */
fun Context.action(text: String, colorId: Int = ColorId.textNeutral, onClick: () -> Unit): TextView =
    label(text, 15f, colorId, bold = true).apply {
        gravity = Gravity.CENTER
        setPadding(Sx.dp(12f), Sx.dp(12f), Sx.dp(12f), Sx.dp(12f))
        pressable(12f, Sx.color(ColorId.filling), onClick)
        layoutParams = lp(t = Sx.dp(8f), l = Sx.dp(12f), r = Sx.dp(12f))
    }

/** Полоса доли (загрузка дня, цель питания). */
fun Context.bar(fraction: Double, colorId: Int = ColorId.progress): View = FrameLayout(this).apply {
    background = rounded(Sx.color(ColorId.background), 4f)
    layoutParams = lp(h = Sx.dp(8f), t = Sx.dp(6f))
    val fill = View(context).apply { background = rounded(Sx.color(colorId), 4f) }
    addView(fill, FrameLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT))
    addOnLayoutChangeListener { v, l, _, r, _, _, _, _, _ ->
        val w = ((r - l) * fraction.coerceIn(0.0, 1.0)).toInt()
        if (fill.layoutParams.width != w) fill.post { fill.layoutParams = fill.layoutParams.apply { width = w }; fill.requestLayout() }
    }
}

fun Context.scrollBody(): Pair<ScrollView, LinearLayout> {
    val body = vbox().apply { setPadding(0, 0, 0, Sx.dp(96f)) }
    val scroll = ScrollView(this).apply {
        isFillViewport = true
        addView(body, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    return scroll to body
}

fun Context.sectionTitle(text: String): TextView = label(text, 13f, ColorId.textNeutral, bold = true).apply {
    layoutParams = lp(t = Sx.dp(16f), l = Sx.dp(18f), r = Sx.dp(18f))
}
