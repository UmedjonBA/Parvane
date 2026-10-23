package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/**
 * Parvane (spec 032): детали «Плана» web на телефоне (`Planner.module.scss`) для «Здоровья» и окна ввода текстом:
 * карточка `.card`, заголовок `.cardTitle` (моноширинный, прописными, разрядка 0,06 em), полоса `.prog`, чип `.chip`,
 * плашка `.tag`, столбики недели `.bars`, поле `.fieldInput`; числа и даты — как `plannerFormat.ts`.
 */
internal object Hk {
    private val locale get() = if (Sx.isRu()) java.util.Locale("ru") else java.util.Locale.US

    /** `lang.number`: «2 000», «72,4». */
    fun number(value: Double, digits: Int = 0): String {
        val f = java.text.NumberFormat.getNumberInstance(locale)
        f.maximumFractionDigits = digits
        f.minimumFractionDigits = 0
        return f.format(value).replace(' ', ' ').replace(' ', ' ')
    }

    /** «7:50». */
    fun span(minutes: Double): String {
        val m = Math.round(minutes).toInt()
        return "${m / 60}:${(m % 60).toString().padStart(2, '0')}"
    }

    /** «45 мин», «1 ч 30 мин». */
    fun duration(minutes: Double): String {
        val m = Math.round(minutes).toInt()
        if (m < 60) return Sx.t("$m мин", "$m min")
        val hours = Sx.t("${m / 60} ч", "${m / 60} h")
        return if (m % 60 != 0) "$hours ${Sx.t("${m % 60} мин", "${m % 60} min")}" else hours
    }

    fun clock(minutes: Double): String {
        val m = ((Math.round(minutes).toInt() % 1440) + 1440) % 1440
        return String.format(java.util.Locale.US, "%02d:%02d", m / 60, m % 60)
    }

    private fun date(day: String): java.util.Date = Sx.calendarOf(day).time
    private fun cap(s: String) = s.replaceFirstChar { it.titlecase(locale) }

    /** «23 октября». */
    fun day(day: String): String = java.text.SimpleDateFormat("d MMMM", locale).format(date(day))
    /** «23 окт». */
    fun dayShort(day: String): String = java.text.SimpleDateFormat("d MMM", locale).format(date(day)).removeSuffix(".")
    /** «Пт, 23 октября». */
    fun dayLabel(day: String): String = cap(java.text.SimpleDateFormat("EE, d MMMM", locale).format(date(day)))
    /** «Пн»…«Вс» по номеру 0 = воскресенье. */
    fun weekday(dow0: Int): String = cap(Sx.weekdayShort(dow0).removeSuffix("."))
    fun weekdayOf(day: String): String = weekday(Sx.calendarOf(day).get(java.util.Calendar.DAY_OF_WEEK) - 1)

    /** `formatRepeat`: «Каждую неделю: Вт · до 27 марта». */
    fun repeat(r: JSONObject): String {
        val n = r.optInt("interval", 1)
        val base = when (r.optString("kind")) {
            "daily" -> if (n == 1) Sx.t("Каждый день", "Every day") else Sx.t("Каждые $n дн.", "Every $n days")
            "weekly" -> {
                val days = (0 until (r.optJSONArray("weekdays")?.length() ?: 0)).map { r.getJSONArray("weekdays").getInt(it) }
                    .sortedBy { (it + 6) % 7 }.joinToString(", ") { weekday(it) }
                if (n == 1) Sx.t("Каждую неделю: $days", "Weekly: $days") else Sx.t("Каждые $n нед.: $days", "Every $n weeks: $days")
            }
            "monthly" -> {
                val d = r.optInt("monthDay", 0).takeIf { it > 0 }
                    ?: r.optString("startDay").takeIf { it.isNotEmpty() }?.let { Sx.calendarOf(it).get(java.util.Calendar.DAY_OF_MONTH) } ?: 1
                if (n == 1) Sx.t("Ежемесячно $d-го", "Monthly on day $d") else Sx.t("Каждые $n мес. $d-го", "Every $n months on day $d")
            }
            else -> {
                val d = r.optString("startDay").takeIf { it.isNotEmpty() }?.let { day(it) } ?: ""
                if (n == 1) Sx.t("Ежегодно $d", "Yearly $d") else Sx.t("Каждые $n г. $d", "Every $n years $d")
            }
        }
        val tail = listOfNotNull(
            r.optString("endDay").takeIf { it.isNotEmpty() }?.let { Sx.t("до ${day(it)}", "until ${day(it)}") },
            r.optInt("count", 0).takeIf { it > 0 }?.let { Sx.t("$it раз", "$it times") })
        return (listOf(base) + tail).joinToString(" · ")
    }

    /** «Напомнить за 15 мин». */
    fun remind(minutes: Double): String {
        val m = minutes.toInt()
        if (m == 0) return Sx.t("Напомнить в начале", "Remind at start")
        val amount = if (m % 1440 == 0) Sx.t("${m / 1440} дн.", "${m / 1440} d") else duration(minutes)
        return Sx.t("Напомнить за $amount", "Remind $amount before")
    }

    fun optNum(o: JSONObject?, key: String): Double? = o?.takeIf { it.has(key) && !it.isNull(key) }?.optDouble(key)?.takeIf { !it.isNaN() }

    fun objects(a: JSONArray?): List<JSONObject?> = (0 until (a?.length() ?: 0)).map { a!!.optJSONObject(it) }
    fun numbers(a: JSONArray?): List<Double?> = (0 until (a?.length() ?: 0)).map { i ->
        if (a!!.isNull(i)) null else a.optDouble(i).takeIf { !it.isNaN() }
    }

    fun share(value: Double, goal: Double?): Double = if (goal == null || goal <= 0) 0.0 else (value / goal).coerceIn(0.0, 1.0)
}

// ── виды ─────────────────────────────────────────────────────────────────────────

/** `.card` «Плана»: фон raised, радиус 0,75 rem, отступ 1 rem; дети — столбиком с промежутком [gapRem]. */
internal fun Context.hkCard(gapRem: Float = 0.875f): LinearLayout = object : LinearLayout(this) {
    override fun addView(child: View, index: Int, params: ViewGroup.LayoutParams) {
        if (childCount > 0 && params is LinearLayout.LayoutParams && params.topMargin == 0) params.topMargin = Pv.rem(gapRem)
        super.addView(child, index, params)
    }
}.apply {
    orientation = LinearLayout.VERTICAL
    setPadding(Pv.rem(1f), Pv.rem(1f), Pv.rem(1f), Pv.rem(1f))
    background = Pv.shape(Pv.c.raised, 0.75f)
}

/** `.cardTitle` / `.groupTitle`: моноширинный, прописными, разрядка 0,06 em. */
internal fun Context.hkTitle(text: String, sizeRem: Float = 0.8125f, color: Int = Pv.c.muted): TextView =
    pvText(text.uppercase(), sizeRem, color, semibold = true, mono = true).apply { letterSpacing = 0.06f }

/** `.cardHead`: заголовок слева, справа — [trailing] (мин. высота 2,25 rem). */
internal fun Context.hkHead(title: String, vararg trailing: View): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = Pv.rem(2.25f)
    addView(hkTitle(title), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    trailing.forEach { addView(it) }
}

/** `.cardNote` — 0,8125 rem muted. */
internal fun Context.hkNote(text: String): TextView = pvText(text, 0.8125f, Pv.c.muted)

/** `.cardText` — 0,875 rem muted. */
internal fun Context.hkText(text: String, color: Int = Pv.c.muted, sizeRem: Float = 0.875f): TextView =
    pvText(text, sizeRem, color).apply { setLineSpacing(0f, 1.3f) }

/** Кнопка `.btn` + `.btnGhost` со значком: «⚙ Цели», «+ Спорт». */
internal fun Context.hkGhost(icon: String?, text: String, onClick: () -> Unit): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(Pv.rem(0.875f), 0, Pv.rem(0.875f), 0)
    minimumHeight = Pv.rem(2.25f)
    icon?.let { addView(pvIcon(it, Pv.c.muted, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.375f) }) }
    addView(pvText(text, 0.875f, Pv.c.muted))
    Pv.pressable(this, 0, 0.5f, onClick = onClick)
}

/** `.chip`: рамка line2, 1,875 rem, радиус 0,9375 rem, 0,8125 rem muted; [on] — заливка цвета 22 %. */
internal fun Context.hkChip(text: String, on: Boolean = false, color: Int = Pv.c.accent, onClick: (() -> Unit)?): LinearLayout =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = Pv.rem(1.875f)
        setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
        addView(pvText(text, 0.8125f, if (on) color else Pv.c.muted, maxLines = 1))
        if (on) Pv.pressable(this, Pv.alpha(color, 22), 0.9375f, onClick = onClick)
        else Pv.pressable(this, 0, 0.9375f, Pv.c.line2, onClick)
    }

/** Ряд с переносом (`.chips`, промежуток 0,375 rem). */
internal class HkFlow(context: Context, private val gap: Int = Pv.rem(0.375f)) : ViewGroup(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
        var x = 0; var y = 0; var line = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            if (c.visibility == GONE) continue
            c.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            if (x > 0 && x + c.measuredWidth > width) { x = 0; y += line + gap; line = 0 }
            x += c.measuredWidth + gap
            line = maxOf(line, c.measuredHeight)
        }
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), y + line + paddingTop + paddingBottom)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val width = r - l - paddingLeft - paddingRight
        var x = 0; var y = 0; var line = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            if (c.visibility == GONE) continue
            if (x > 0 && x + c.measuredWidth > width) { x = 0; y += line + gap; line = 0 }
            val top = paddingTop + y
            c.layout(paddingLeft + x, top, paddingLeft + x + c.measuredWidth, top + c.measuredHeight)
            x += c.measuredWidth + gap
            line = maxOf(line, c.measuredHeight)
        }
    }
}

/** Полоса `.prog` (0,375 rem) либо `.progThick` (0,5 rem): дорожка line, заливка цветом вида. */
internal class HkProg(context: Context, private val fraction: Double, private val color: Int, thick: Boolean = false) : View(context) {
    private val heightPx = Pv.rem(if (thick) 0.5f else 0.375f)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rect = RectF()

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(MeasureSpec.getSize(w), heightPx)

    override fun onDraw(canvas: Canvas) {
        val r = height / 2f
        paint.color = Pv.c.line
        rect.set(0f, 0f, width.toFloat(), height.toFloat())
        canvas.drawRoundRect(rect, r, r, paint)
        if (fraction <= 0) return
        paint.color = color
        rect.set(0f, 0f, (width * fraction.coerceIn(0.0, 1.0)).toFloat(), height.toFloat())
        canvas.drawRoundRect(rect, r, r, paint)
    }
}

/**
 * Столбики недели (`.bars`): значение над столбиком (прочерк — нет данных), пунктир цели с подписью справа, день
 * экрана обведён, записанный ноль — красная отметка, «низкое» значение — красный столбик; подписи дней снизу.
 */
internal class HkBars(
    context: Context,
    private val values: List<Double?>,
    private val labels: List<String>,
    private val current: Int,
    private val color: Int,
    private val goal: Double?,
    private val format: (Double) -> String,
    private val isLow: (Double) -> Boolean = { false },
) : View(context) {
    private val chartH = Pv.rem(9.375f)
    private val topPad = Pv.rem(1.125f).toFloat()
    private val labelsH = Pv.rem(0.375f + 1.125f)
    private val gap = Pv.rem(0.5f).toFloat()
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = Pv.rem(0.125f).toFloat() }
    private val dash = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = Pv.px(1f).toFloat(); pathEffect = DashPathEffect(floatArrayOf(Pv.px(4f).toFloat(), Pv.px(3f).toFloat()), 0f)
    }
    private val small = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Pv.mono(); textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 11f, context.resources.displayMetrics)
    }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER; textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 12f, context.resources.displayMetrics)
    }
    private val rect = RectF()

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(MeasureSpec.getSize(w), chartH + labelsH)

    override fun onDraw(canvas: Canvas) {
        val c = Pv.c
        val n = values.size.coerceAtLeast(1)
        val max = maxOf(1.0, goal ?: 0.0, (values.maxOfOrNull { it ?: 0.0 } ?: 0.0)) * 1.15
        val area = (chartH - topPad) * 0.86f
        val bottom = chartH.toFloat()
        val colW = (width - gap * (n - 1)) / n
        if (goal != null && goal > 0) {
            val y = bottom - (goal / max).toFloat() * area
            dash.color = c.faint
            canvas.drawLine(0f, y, width.toFloat(), y, dash)
            small.color = c.faint
            small.textAlign = Paint.Align.RIGHT
            canvas.drawText(format(goal), width.toFloat(), y - Pv.px(4f), small)
        }
        values.forEachIndexed { i, v ->
            val x0 = i * (colW + gap)
            val barW = minOf(colW, Pv.rem(2.125f).toFloat())
            val left = x0 + (colW - barW) / 2
            var h = ((v ?: 0.0) / max).toFloat() * area
            val zero = v == 0.0
            if (zero) h = Pv.rem(0.375f).toFloat()
            val top = bottom - h
            fill.color = if (zero || (v != null && isLow(v))) c.red else color
            if (h > 0) {
                rect.set(left, top, left + barW, bottom)
                val r = Pv.rem(0.375f).toFloat()
                canvas.drawRoundRect(rect, minOf(r, h / 2), minOf(r, h / 2), fill)
                if (i == current) {
                    stroke.color = c.fg
                    canvas.drawRoundRect(rect, minOf(r, h / 2), minOf(r, h / 2), stroke)
                }
            }
            small.color = c.muted
            small.textAlign = Paint.Align.CENTER
            canvas.drawText(if (v != null) format(v) else "—", x0 + colW / 2, top - Pv.rem(0.25f), small)
            label.color = if (i == current) c.fg else c.muted
            label.typeface = if (i == current) Pv.semibold() else Pv.regular()
            canvas.drawText(labels.getOrElse(i) { "" }, x0 + colW / 2, bottom + Pv.rem(0.375f) - label.ascent(), label)
        }
    }
}

/** Поле `.fieldInput` с кнопкой (форма «сон дня», «цели»): Enter и кнопка отдают текст; `done(true)` — поле очищается. */
internal fun Context.hkTextForm(placeholder: String, button: String, accent: Boolean, fill: String? = null,
                                onSubmit: (text: String, done: (Boolean) -> Unit) -> Unit): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    val c = Pv.c
    val input = EditText(context).apply {
        hint = placeholder
        setHintTextColor(c.faint)
        setTextColor(c.fg)
        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 15f)
        typeface = Pv.regular()
        setSingleLine()
        inputType = InputType.TYPE_CLASS_TEXT
        imeOptions = EditorInfo.IME_ACTION_DONE
        setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
        background = Pv.shape(c.panel, 0.5f, c.line2)
        fill?.let { setText(it); setSelection(it.length); post { requestFocus() } }
    }
    val buttonView = pvButton(button, if (accent) "acc" else "") {}
    fun submit() {
        val text = input.text.toString()
        if (text.isBlank()) return
        onSubmit(text) { ok -> if (ok) input.setText("") }
    }
    fun sync() { buttonView.alpha = if (input.text.isBlank()) 0.5f else 1f }
    buttonView.setOnClickListener { submit() }
    input.setOnEditorActionListener { _, _, _ -> submit(); true }
    input.addTextChangedListener(object : android.text.TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun afterTextChanged(s: android.text.Editable?) = sync()
    })
    sync()
    addView(input, LinearLayout.LayoutParams(0, Pv.rem(2.625f), 1f))
    addView(buttonView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.25f)).apply { leftMargin = Pv.rem(0.5f) })
}

/** Плашка `.tag`: текст цвета вида на его заливке 18 %. */
internal fun Context.hkTag(text: String, color: Int): TextView = pvText(text, 0.75f, color, maxLines = 1).apply {
    setPadding(Pv.rem(0.375f), Pv.rem(0.0625f), Pv.rem(0.375f), Pv.rem(0.0625f))
    background = Pv.shape(Pv.alpha(color, 18), 0.3125f)
}

/** Круглая галочка `.check` (1,375 rem). */
internal class HkCheck(context: Context, private val checked: Boolean, private val color: Int) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val size = Pv.rem(1.375f)

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(size, size)

    override fun onDraw(canvas: Canvas) {
        val r = size / 2f
        val sw = Pv.rem(0.125f).toFloat()
        if (checked) {
            paint.style = Paint.Style.FILL
            paint.color = color
            canvas.drawCircle(r, r, r, paint)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = sw
            paint.color = Pv.c.accentInk
            canvas.drawLine(size * 0.28f, size * 0.5f, size * 0.44f, size * 0.66f, paint)
            canvas.drawLine(size * 0.44f, size * 0.66f, size * 0.74f, size * 0.36f, paint)
        } else {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = sw
            paint.color = Pv.c.line2
            canvas.drawCircle(r, r, r - sw / 2, paint)
        }
    }
}

/** Отступ сверху у элемента столбика. */
internal fun lpTop(topRem: Float, width: Int = ViewGroup.LayoutParams.MATCH_PARENT): LinearLayout.LayoutParams =
    LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(topRem) }
