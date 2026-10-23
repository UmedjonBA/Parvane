package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneSections

/**
 * Parvane (spec 032): виды «Плана» 1:1 с телефонной версией web — `PlannerToday`, `PlannerDayFeed`, `PlannerTaskRow`,
 * `PlannerMonth` с `PlannerDayPanel`, `PlannerDayStrip` + `PlannerWeek` (один день), `PlannerYear`, `PlannerAgenda`
 * с `PlannerGroupBar`. Размеры — из `Planner.module.scss` (узкий экран ≤ 925 px), тона — `--pv-*`.
 */
object PlannerViews {
    private val ruMonthsGen = arrayOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")
    private val ruMonthsShort = arrayOf("янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек.")
    private val enMonths = arrayOf("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
    private val ruWeekFull = arrayOf("Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота")
    private val enWeekFull = arrayOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
    private val ruWeekShort = arrayOf("ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС")
    private val enWeekShort = arrayOf("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")

    // ── форматы дат ────────────────────────────────────────────────────────────────

    /** «23 октября» / «October 23». */
    fun dayLong(day: String): String {
        val c = Sx.calendarOf(day)
        val d = c.get(java.util.Calendar.DAY_OF_MONTH)
        val m = c.get(java.util.Calendar.MONTH)
        return if (Sx.isRu()) "$d ${ruMonthsGen[m]}" else "${enMonths[m]} $d"
    }

    /** «Сегодня» / «Завтра» / «Вчера» / «Пятница». */
    fun relative(day: String): String {
        val today = Sx.today()
        return when (day) {
            today -> Sx.t("Сегодня", "Today")
            Sx.addDays(today, 1) -> Sx.t("Завтра", "Tomorrow")
            Sx.addDays(today, -1) -> Sx.t("Вчера", "Yesterday")
            else -> Sx.calendarOf(day).get(java.util.Calendar.DAY_OF_WEEK).let { if (Sx.isRu()) ruWeekFull[it - 1] else enWeekFull[it - 1] }
        }
    }

    /** «Сегодня, 23 октября» — заголовки дня в списке и карточке дня. */
    fun dayHeading(day: String) = "${relative(day)}, ${dayLong(day)}"

    fun shortDate(day: String): String {
        val c = Sx.calendarOf(day)
        val d = c.get(java.util.Calendar.DAY_OF_MONTH)
        val m = c.get(java.util.Calendar.MONTH)
        return if (Sx.isRu()) "$d ${ruMonthsShort[m].trimEnd('.')}" else "${enMonths[m].take(3)} $d"
    }

    /** «23 окт. – 21 нояб. 2026». */
    fun rangeTitle(from: String, to: String): String {
        val a = Sx.calendarOf(from)
        val b = Sx.calendarOf(to)
        fun part(c: java.util.Calendar) = if (Sx.isRu()) "${c.get(java.util.Calendar.DAY_OF_MONTH)} ${ruMonthsShort[c.get(java.util.Calendar.MONTH)]}"
            else "${enMonths[c.get(java.util.Calendar.MONTH)].take(3)} ${c.get(java.util.Calendar.DAY_OF_MONTH)}"
        return "${part(a)} – ${part(b)} ${b.get(java.util.Calendar.YEAR)}"
    }

    /** Понедельник…воскресенье недели дня. */
    fun weekKeys(day: String): List<String> {
        val c = Sx.calendarOf(day)
        val dow = (c.get(java.util.Calendar.DAY_OF_WEEK) + 5) % 7
        val monday = Sx.addDays(day, -dow)
        return (0 until 7).map { Sx.addDays(monday, it) }
    }

    /** «7:50» — длительность сна; «0,8» — часы одной цифрой после запятой. */
    fun span(minutes: Int) = "${minutes / 60}:${String.format(java.util.Locale.US, "%02d", minutes % 60)}"
    fun hours(minutes: Int): String {
        val h = minutes / 60.0
        val s = if (h % 1.0 == 0.0) h.toInt().toString() else String.format(java.util.Locale.US, "%.1f", h)
        return if (Sx.isRu()) s.replace('.', ',') else s
    }
    fun number(n: Int): String = String.format(java.util.Locale("ru"), "%,d", n).replace(' ', ' ')

    // ── общее: карточка, заголовки, отметка ─────────────────────────────────────────

    /** `.card`: raised, радиус 0,75 rem, отступ 1 rem. */
    fun card(ctx: Context): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(Pv.rem(1f), Pv.rem(1f), Pv.rem(1f), Pv.rem(1f))
        background = Pv.shape(Pv.c.raised, 0.75f)
    }

    /** Подпись карточки (`.cardTitle`): моноширинный 0,8125 rem semibold, прописные, разрядка 0,06 em. */
    fun capsTitle(ctx: Context, text: String, sizeRem: Float = 0.8125f, color: Int = Pv.c.muted): TextView =
        ctx.pvText(text.uppercase(), sizeRem, color, semibold = true, mono = true).apply { letterSpacing = 0.06f }

    /** `.cardHead`: подпись слева, справа — [trailing]; мин. 2,25 rem, отступ снизу 0,625 rem. */
    fun cardHead(ctx: Context, title: String, trailing: View? = null): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = Pv.rem(2.25f)
        addView(capsTitle(ctx, title), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        trailing?.let { addView(it) }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = Pv.rem(0.625f) }
    }

    /** `.btn.btnGhost` со значком. */
    fun ghost(ctx: Context, icon: String, text: String, onClick: () -> Unit): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(0.875f), 0, Pv.rem(0.875f), 0)
        addView(ctx.pvIcon(icon, Pv.c.muted, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.375f) })
        addView(ctx.pvText(text, 0.875f, Pv.c.muted))
        Pv.pressable(this, 0, 0.5f, onClick = onClick)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.25f))
    }

    private fun gap(rem: Float) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(rem) }

    /** Цвет группы (списка) записи: индекс 1…8 — палитра собеседников, как `listColorStyle` web. */
    fun listColor(index: Int): Int = if (index in 1..8) Sx.listColor(index) else 0

    // ── уведомления, поиск, выбор периода ──────────────────────────────────────────

    private var lastNotice = ""
    fun showNotice(owner: PlannerController, n: JSONObject) {
        val text = n.optString("text")
        if (text.isEmpty() || text == lastNotice) return
        lastNotice = text
        PvToast.show(owner, text, if (n.optBoolean("canUndo")) Sx.t("Отменить", "Undo") else null) {
            ParvaneSections.plannerUndo(Sx.t("Отменено", "Undone"))
        }
    }

    /** Поиск по записям «Плана» (лупа шапки): названия задач и событий на год вперёд и назад, задачи без даты. */
    fun openSearch(owner: PlannerController) {
        val ctx = owner.context()
        val sheet = PvSheet.create(ctx, Sx.t("Поиск по «Плану»", "Search the plan"))
        val input = pvInput(ctx, Sx.t("Название записи", "Entry name"))
        val results = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        sheet.add(input).add(results)
        var all: List<Triple<String, String, JSONObject>> = emptyList() // день, вид, запись
        fun show(q: String) {
            results.removeAllViews()
            if (q.isBlank()) return
            all.filter { it.third.optString("name").contains(q, ignoreCase = true) }.take(40).forEach { (day, kind, item) ->
                results.addView(ctx.pvTileRow(if (kind == "event") "cal" else "check", item.optString("name"),
                    if (day.isEmpty()) Sx.t("Без даты", "No date") else dayHeading(day), tone = if (kind == "event") Pv.c.event else Pv.c.task) {
                    sheet.dismiss()
                    if (day.isNotEmpty()) owner.pickDay(day)
                    PlannerEditor.open(owner, kind, item.optString("id"), day)
                }, gap(0.125f))
            }
        }
        input.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) = show(s?.toString().orEmpty())
        })
        Sx.planner("days", JSONObject().put("from", Sx.addDays(Sx.today(), -365)).put("to", Sx.addDays(Sx.today(), 365))) { r ->
            val out = mutableListOf<Triple<String, String, JSONObject>>()
            val seen = HashSet<String>()
            (r as? JSONObject)?.let { days ->
                days.keys().forEach { day ->
                    val d = days.optJSONObject(day) ?: return@forEach
                    Sx.list(d.optJSONArray("tasks")).forEach { t -> if (seen.add("t" + t.optString("id"))) out += Triple(day, "task", t) }
                    Sx.list(d.optJSONArray("events")).forEach { e -> if (seen.add("e" + e.optString("id"))) out += Triple(day, "event", e) }
                }
            }
            Sx.planner("undated") { u ->
                Sx.list((u as? JSONObject)?.optJSONArray("undated")).forEach { t -> if (seen.add("t" + t.optString("id"))) out += Triple("", "task", t) }
                all = out.sortedBy { it.first }
                show(input.text.toString())
            }
        }
        sheet.show()
        input.requestFocus()
    }

    /** Поле ввода в духе web: рамка line2, радиус 0,5 rem, высота 2,625 rem. */
    fun pvInput(ctx: Context, hint: String, text: String = ""): android.widget.EditText = android.widget.EditText(ctx).apply {
        setText(text)
        this.hint = hint
        setTextColor(Pv.c.fg)
        setHintTextColor(Pv.c.faint)
        textSize = 15f
        typeface = Pv.regular()
        setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
        background = Pv.shape(Pv.c.panel, 0.5f, Pv.c.line2)
        minHeight = Pv.rem(2.625f)
        isSingleLine = true
    }

    /** Выбор месяца и года (`periodPicker`): год стрелками и двенадцать месяцев. */
    fun pickPeriod(owner: PlannerController) {
        val ctx = owner.context()
        val sheet = PvSheet.create(ctx, Sx.t("Месяц и год", "Month and year"))
        var year = Sx.calendarOf(owner.picked).get(java.util.Calendar.YEAR)
        val yearRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val yearText = ctx.pvText("$year", 1.125f, Pv.c.fg, semibold = true, mono = true).apply { gravity = Gravity.CENTER }
        val grid = android.widget.GridLayout(ctx).apply { columnCount = 4 }
        fun fill() {
            yearText.text = "$year"
            grid.removeAllViews()
            val cur = Sx.calendarOf(owner.picked)
            for (m in 0 until 12) {
                val on = year == cur.get(java.util.Calendar.YEAR) && m == cur.get(java.util.Calendar.MONTH)
                grid.addView(ctx.pvText(if (Sx.isRu()) ruMonthsShort[m] else enMonths[m].take(3), 0.875f, if (on) Pv.c.accentInk else Pv.c.fg).apply {
                    gravity = Gravity.CENTER
                    Pv.pressable(this, if (on) Pv.c.accent else Pv.c.raised, 0.5f) {
                        sheet.dismiss()
                        val c = Sx.calendarOf(owner.picked)
                        val day = minOf(c.get(java.util.Calendar.DAY_OF_MONTH), java.util.GregorianCalendar(year, m, 1).getActualMaximum(java.util.Calendar.DAY_OF_MONTH))
                        owner.pickDay(String.format(java.util.Locale.US, "%04d-%02d-%02d", year, m + 1, day))
                    }
                    layoutParams = android.widget.GridLayout.LayoutParams(android.widget.GridLayout.spec(m / 4, 1f), android.widget.GridLayout.spec(m % 4, 1f)).apply {
                        width = 0; height = Pv.rem(2.5f); setMargins(Pv.rem(0.1875f), Pv.rem(0.1875f), Pv.rem(0.1875f), Pv.rem(0.1875f))
                    }
                })
            }
        }
        yearRow.addView(ctx.pvIconButton("left", Sx.t("Предыдущий год", "Previous year")) { year--; fill() })
        yearRow.addView(yearText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        yearRow.addView(ctx.pvIconButton("right", Sx.t("Следующий год", "Next year")) { year++; fill() })
        fill()
        sheet.add(yearRow).add(grid).show()
    }

    // ── строка даты (`PlannerDateNav`) ──────────────────────────────────────────────

    fun dateNav(owner: PlannerController, into: LinearLayout) {
        val ctx = owner.context()
        val c = Pv.c
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(ctx.pvText(relative(owner.picked), 0.875f, c.muted))
        texts.addView(ctx.pvText(dayLong(owner.picked), 1.375f, c.fg, semibold = true, mono = true).apply { setLineSpacing(0f, 1.1f) })
        row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (owner.picked != Sx.today()) row.addView(ctx.pvPill(Sx.t("Текущая дата", "Current date")) { owner.pickDay(Sx.today()) }.apply {
            (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.625f)
        })
        row.addView(ctx.pvIconButton("left", Sx.t("Предыдущий день", "Previous day")) { owner.shift(-1) })
        row.addView(ctx.pvIconButton("right", Sx.t("Следующий день", "Next day")) { owner.shift(1) })
        into.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = Pv.rem(1f) })
        swipeDays(owner, into)
    }

    /** Свайп по дню (≥ 60 px по горизонтали) — соседний день, как `plannerSwipe.ts`. */
    private fun swipeDays(owner: PlannerController, view: View) {
        // Экранные координаты и только жест, начало которого видели: прокрутку забирает ScrollView, и без этого
        // отпускание сравнивалось с началом прошлого жеста — прокрутка «Сегодня» листала день
        var x0 = 0f
        var y0 = 0f
        var isTracking = false
        (view.parent as? View ?: view).setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { x0 = e.rawX; y0 = e.rawY; isTracking = true }
                MotionEvent.ACTION_CANCEL -> isTracking = false
                MotionEvent.ACTION_UP -> {
                    val dx = e.rawX - x0
                    if (isTracking && kotlin.math.abs(dx) > Pv.px(60f) && kotlin.math.abs(dx) > 2 * kotlin.math.abs(e.rawY - y0)) owner.shift(if (dx < 0) 1 else -1)
                    isTracking = false
                }
            }
            false
        }
    }

    // ── «Сегодня» ───────────────────────────────────────────────────────────────────

    fun today(owner: PlannerController, into: LinearLayout, day: JSONObject, health: JSONObject?, undated: JSONObject?) {
        val ctx = owner.context()
        val c = Pv.c
        val tasks = Sx.list(day.optJSONArray("tasks")).sortedWith(compareBy({ if (it.optString("status") == "done") 1 else 0 }, { it.optString("start", "99").ifEmpty { "99" } }))
        val done = tasks.count { it.optString("status") == "done" }
        val load = day.optInt("minutes")
        val budget = day.optInt("budget", health?.optInt("budget") ?: 600)
        val isOver = load > budget
        val isShort = health?.optBoolean("shortSleep") == true
        val sleep = health?.optJSONObject("sleep")
        val sleepGoal = health?.optJSONObject("goals")?.optDouble("sleepMinutes")?.takeIf { !it.isNaN() }?.toInt()
        val kcalInfo = health?.optJSONObject("nutrients")?.optJSONObject("kcal")
        val kcal = kcalInfo?.optDouble("value")?.takeIf { !it.isNaN() }?.toInt() ?: 0
        val kcalGoal = kcalInfo?.optJSONObject("goal")?.optDouble("target")?.takeIf { !it.isNaN() && it > 0 }?.toInt()

        // `.stats`: сетка 2 × 2, промежуток 0,625 rem
        val grid = android.widget.GridLayout(ctx).apply { columnCount = 2 }
        fun stat(index: Int, label: String, kind: Int, value: String, unit: String?, share: Double, sub: String, onClick: () -> Unit) {
            val box = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(Pv.rem(1f), Pv.rem(1f), Pv.rem(1f), Pv.rem(1f))
                Pv.pressable(this, c.raised, 0.75f, onClick = onClick)
            }
            box.addView(capsTitle(ctx, label, 0.75f, kind))
            box.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.BOTTOM
                addView(ctx.pvText(value, 1.5f, c.fg, semibold = true, mono = true))
                unit?.let { addView(ctx.pvText(" $it", 0.875f, c.muted, mono = true).apply { setPadding(0, 0, 0, Pv.px(2f)) }) }
            }, gap(0.375f))
            box.addView(progress(ctx, share, kind), gap(0.375f).apply { height = Pv.rem(0.375f) })
            box.addView(ctx.pvText(sub, 0.75f, c.muted).apply { minHeight = Pv.rem(1.125f) }, gap(0.375f))
            grid.addView(box, android.widget.GridLayout.LayoutParams(android.widget.GridLayout.spec(index / 2), android.widget.GridLayout.spec(index % 2, 1f)).apply {
                width = 0
                setMargins(if (index % 2 == 1) Pv.rem(0.3125f) else 0, if (index >= 2) Pv.rem(0.625f) else 0, if (index % 2 == 0) Pv.rem(0.3125f) else 0, 0)
                setGravity(Gravity.FILL)
            })
        }
        val sleepValue = sleep?.optDouble("value")?.takeIf { !it.isNaN() }?.toInt()
        stat(0, Sx.t("Сон", "Sleep"), if (isShort) c.red else c.sleep, sleepValue?.let { span(it) } ?: "—", null,
            if (sleepValue != null && sleepGoal != null && sleepGoal > 0) sleepValue.toDouble() / sleepGoal else 0.0,
            when {
                sleep == null -> Sx.t("Сон не записан", "No sleep logged")
                sleep.optString("time").isNotEmpty() && sleep.optString("endTime").isNotEmpty() && sleepGoal != null ->
                    "${sleep.optString("time")}–${sleep.optString("endTime")} · ${Sx.t("цель", "goal")} ${span(sleepGoal)}"
                sleepGoal != null -> "${Sx.t("цель", "goal")} ${span(sleepGoal)}"
                else -> ""
            }) { owner.openHealthTab() }
        stat(1, Sx.t("Еда", "Food"), c.food, number(kcal), Sx.t("ккал", "kcal"), if (kcalGoal != null) kcal.toDouble() / kcalGoal else 0.0,
            when {
                kcalGoal == null -> ""
                kcal > kcalGoal -> Sx.t("перебор ${number(kcal - kcalGoal)}", "${number(kcal - kcalGoal)} over")
                else -> Sx.t("осталось ${number(kcalGoal - kcal)} из ${number(kcalGoal)}", "${number(kcalGoal - kcal)} left of ${number(kcalGoal)}")
            }) { owner.openHealthTab() }
        val left = tasks.size - done
        stat(2, Sx.t("Задачи", "Tasks"), c.task, "$done", "/ ${tasks.size}", if (tasks.isNotEmpty()) done.toDouble() / tasks.size else 0.0,
            when {
                tasks.isEmpty() -> Sx.t("На этот день задач нет", "No tasks for this day")
                left > 0 -> Sx.t("Осталось: $left", "$left left")
                else -> Sx.t("Всё сделано", "All done")
            }) { }
        stat(3, Sx.t("План", "Plan"), if (isOver) c.red else c.event, hours(load), "/ ${hours(budget)} ${Sx.t("ч", "h")}",
            if (budget > 0) load.toDouble() / budget else 0.0,
            when { isOver -> Sx.t("Больше бюджета дня", "Over the day budget"); isShort -> Sx.t("Мало сна: бюджет дня снижен", "Short sleep: day budget reduced"); else -> Sx.t("Загрузка дня", "Day load") }
        ) { owner.switchSegment("week") }
        into.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        // Расписание
        val feedCard = card(ctx)
        feedCard.addView(cardHead(ctx, Sx.t("Расписание", "Schedule"), ghost(ctx, "eats", Sx.t("Еда", "Food")) {
            QuickAdd.show(owner, Sx.t("обед ", "lunch "))
        }))
        feed(owner, feedCard, owner.picked, day, health, owner.layers)
        into.addView(feedCard, gap(0.875f))

        // Задачи
        val tasksCard = card(ctx)
        tasksCard.addView(cardHead(ctx, Sx.t("Задачи", "Tasks"), ctx.pvIconButton("plus", Sx.t("Новая задача", "New task")) {
            val d = Sx.calendarOf(owner.picked)
            val word = if (owner.picked == Sx.today()) Sx.t("сегодня", "today")
                else String.format(java.util.Locale.US, "%02d.%02d", d.get(java.util.Calendar.DAY_OF_MONTH), d.get(java.util.Calendar.MONTH) + 1)
            QuickAdd.show(owner, "${Sx.t("задача", "task")} $word ", "task")
        }))
        val undatedList = Sx.list(undated?.optJSONArray("undated"))
        val active = undatedList.filter { it.optString("status") == "active" }
        val queued = undatedList.filter { it.optString("status") == "queue" }
        if (tasks.isEmpty() && active.isEmpty() && queued.isEmpty()) tasksCard.addView(ctx.pvText(Sx.t("На этот день задач нет", "No tasks for this day"), 0.9375f, c.muted))
        tasks.forEach { tasksCard.addView(taskRow(owner, it, owner.picked)) }
        if (active.isNotEmpty()) tasksCard.addView(groupTitle(ctx, Sx.t("В работе", "In progress")))
        active.forEach { tasksCard.addView(taskRow(owner, it, "")) }
        if (queued.isNotEmpty()) tasksCard.addView(groupTitle(ctx, Sx.t("Без даты", "No date")))
        queued.take(5).forEach { tasksCard.addView(taskRow(owner, it, "")) }
        if (undatedList.isNotEmpty()) {
            tasksCard.addView(DashedLine(ctx), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.px(1f)).apply { topMargin = Pv.rem(0.375f) })
            tasksCard.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = Pv.rem(2.75f)
                setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
                addView(FrameLayout(ctx).apply {
                    background = Pv.shape(Pv.alpha(c.muted, 22), 0.5f)
                    addView(ctx.pvIcon("archive", c.muted, 1.125f), FrameLayout.LayoutParams(Pv.rem(1.125f), Pv.rem(1.125f), Gravity.CENTER))
                }, LinearLayout.LayoutParams(Pv.rem(1.75f), Pv.rem(1.75f)).apply { rightMargin = Pv.rem(0.75f) })
                addView(ctx.pvText(Sx.t("Все без даты", "All without a date"), 0.9375f, c.fg), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(ctx.pvText("${undatedList.size}", 0.8125f, c.muted, mono = true).apply { setPadding(0, 0, Pv.rem(0.5f), 0) })
                addView(ctx.pvIcon("right", c.muted, 1.125f))
                Pv.pressable(this, 0, 0.5f) { openUndated(owner, undatedList) }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                leftMargin = -Pv.rem(0.625f); rightMargin = -Pv.rem(0.625f)
            })
        }
        into.addView(tasksCard, gap(0.875f))
        into.addView(dailyNote(owner), gap(0.875f))
    }

    private fun groupTitle(ctx: Context, text: String) = capsTitle(ctx, text, 0.75f).apply {
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(0.75f); bottomMargin = Pv.rem(0.125f) }
    }

    /** Все задачи без даты (`PlannerUndated`): шторка по спискам. */
    private fun openUndated(owner: PlannerController, tasks: List<JSONObject>) {
        val ctx = owner.context()
        val sheet = PvSheet.create(ctx, Sx.t("Без даты", "No date"))
        tasks.groupBy { it.optString("project") }.forEach { (project, list) ->
            sheet.add(capsTitle(ctx, project.ifEmpty { Sx.t("Без группы", "No group") }, 0.75f), 0.75f)
            list.forEach { t -> sheet.add(taskRow(owner, t, "", onOpen = { sheet.dismiss() }), 0.125f) }
        }
        sheet.show()
    }

    /** Заметка дня (`PlannerDailyNote`): первые строки заметки дня из «Знаний», «Изменить» — открыть её. */
    private fun dailyNote(owner: PlannerController): View {
        val ctx = owner.context()
        val c = Pv.c
        val box = card(ctx)
        val day = owner.picked
        fun open() = Sx.async({ ParvaneSections.notes("openDaily", JSONObject().put("day", day).toString()) }) { id ->
            (id as? String)?.takeIf { it.isNotEmpty() }?.let { owner.navigateTo(NoteController.forNote(owner.context(), owner.tdlib(), it)) }
                ?: owner.toastText(Sx.t("Хранилище заметок ещё не готово", "The notes vault is not ready yet"))
        }
        box.addView(cardHead(ctx, Sx.t("Заметка дня", "Daily note"), LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(0.875f), 0, Pv.rem(0.875f), 0)
            addView(ctx.pvIcon("edit", c.muted, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.375f) })
            addView(ctx.pvText(Sx.t("Изменить", "Edit"), 0.875f, c.muted))
            Pv.pressable(this, 0, 0.5f) { open() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.25f))
        }))
        val text = ctx.pvText(Sx.t("Написать заметку дня", "Write a daily note"), 0.9375f, c.muted).apply { setOnClickListener { open() } }
        box.addView(text)
        Sx.async({ ParvaneSections.notes("readDaily", JSONObject().put("day", day).toString()) }) { r ->
            val body = (r as? JSONObject)?.optString("text")?.takeIf { it.isNotBlank() && it != "null" } ?: return@async
            val lines = body.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") && !it.startsWith("---") }.take(6)
            if (lines.isEmpty()) return@async
            text.text = lines.joinToString("\n") { it.removePrefix("- [ ] ").removePrefix("- [x] ").removePrefix("- ") }
            text.setTextColor(c.fg)
            text.setLineSpacing(Pv.px(4f).toFloat(), 1f)
        }
        return box
    }

    // ── отметка задачи (`.check`) ──────────────────────────────────────────────────

    class CheckView(context: Context, var checked: Boolean, private val color: Int, private val small: Boolean) : View(context) {
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onMeasure(w: Int, h: Int) = Pv.rem(if (small) 1.25f else 1.375f).let { setMeasuredDimension(it, it) }
        override fun onDraw(canvas: Canvas) {
            val s = width.toFloat()
            val stroke = Pv.rem(0.125f).toFloat()
            if (checked) {
                p.style = Paint.Style.FILL; p.color = color
                canvas.drawCircle(s / 2, s / 2, s / 2, p)
                p.style = Paint.Style.STROKE; p.strokeWidth = stroke; p.color = Pv.c.accentInk; p.strokeCap = Paint.Cap.ROUND
                val path = android.graphics.Path().apply { moveTo(s * 0.28f, s * 0.52f); lineTo(s * 0.44f, s * 0.67f); lineTo(s * 0.73f, s * 0.36f) }
                canvas.drawPath(path, p)
            } else {
                p.style = Paint.Style.STROKE; p.strokeWidth = stroke; p.color = Pv.c.line2
                canvas.drawCircle(s / 2, s / 2, s / 2 - stroke / 2, p)
            }
        }
    }

    /** Строка задачи (`PlannerTaskRow`, вид «day»): отметка, название в две строки, подпись (время, срок, группа, шаги). */
    fun taskRow(owner: PlannerController, task: JSONObject, day: String, onOpen: (() -> Unit)? = null): View {
        val ctx = owner.context()
        val c = Pv.c
        val isDone = task.optString("status") == "done"
        val instance = task.optString("instanceDay").ifEmpty { day }
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = Pv.rem(2.75f)
            setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
        }
        val check = CheckView(ctx, isDone, c.task, false)
        check.setOnClickListener {
            check.checked = !check.checked
            check.invalidate()
            Sx.planner("taskDone", JSONObject().put("id", task.optString("id")).put("day", instance).put("done", check.checked)
                .put("notice", if (check.checked) Sx.t("Готово: ${task.optString("name")}", "Done: ${task.optString("name")}") else Sx.t("Снова в работе: ${task.optString("name")}", "Reopened: ${task.optString("name")}")))
        }
        row.addView(check, LinearLayout.LayoutParams(Pv.rem(1.375f), Pv.rem(1.375f)).apply { rightMargin = Pv.rem(0.75f) })
        val body = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        body.addView(ctx.pvText(task.optString("name"), 0.9375f, if (isDone) c.faint else c.fg, maxLines = 2).apply {
            if (isDone) paintFlags = paintFlags or Paint.STRIKE_THRU_TEXT_FLAG
        })
        val sub = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        fun subItem(icon: String?, text: String, color: Int = c.muted) {
            if (sub.childCount > 0) sub.addView(View(ctx), LinearLayout.LayoutParams(Pv.rem(0.625f), 1))
            icon?.let { sub.addView(ctx.pvIcon(it, color, 0.875f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.25f) }) }
            sub.addView(ctx.pvText(text, 0.8125f, color, maxLines = 1))
        }
        task.optString("start").takeIf { it.isNotEmpty() }?.let { start ->
            val m = task.optInt("minutes", 0)
            subItem(null, if (m > 0) "$start–${Sx.clock(Sx.toMinutes(start) + m)}" else start)
        }
        task.optString("due").takeIf { it.isNotEmpty() }?.let { due ->
            subItem("flag", "${Sx.t("срок", "due")} ${shortDate(due)}", if (due < Sx.today() && !isDone) c.red else c.muted)
        }
        Sx.list(task.optJSONArray("steps")).takeIf { it.isNotEmpty() }?.let { steps -> subItem(null, "${steps.count { it.optBoolean("isDone") }}/${steps.size}") }
        task.optString("project").takeIf { it.isNotEmpty() }?.let { subItem(null, it) }
        if (sub.childCount > 0) body.addView(sub)
        row.addView(body, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        Pv.pressable(row, 0, 0.5f) { onOpen?.invoke(); PlannerEditor.open(owner, "task", task.optString("id"), instance) }
        row.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = -Pv.rem(0.625f); rightMargin = -Pv.rem(0.625f)
        }
        return row
    }

    // ── лента дня (`PlannerDayFeed`) ───────────────────────────────────────────────

    fun feed(owner: PlannerController, into: LinearLayout, dayKey: String, day: JSONObject, health: JSONObject?, layers: Set<String>) {
        val ctx = owner.context()
        val c = Pv.c
        val rows = mutableListOf<Pair<Double, View>>()
        val isToday = dayKey == Sx.today()
        val sameDay = health?.optString("day") == dayKey
        if ("sleep" in layers && sameDay) {
            val sleep = health?.optJSONObject("sleep")
            val end = sleep?.optString("endTime").orEmpty()
            if (sleep != null && end.isNotEmpty()) {
                val color = if (health.optBoolean("shortSleep")) c.red else c.sleep
                rows += (Sx.toMinutes(end) - 0.5) to feedLine(ctx, end, LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, Pv.rem(0.25f), 0, Pv.rem(0.25f))
                    addView(ctx.pvIcon("moon", color, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.5f) })
                    addView(ctx.pvText(Sx.t("Подъём · сон ", "Wake-up · sleep ") + span(sleep.optDouble("value").toInt()), 0.875f, c.fg, maxLines = 1))
                    setOnClickListener { owner.openHealthTab() }
                })
            }
        }
        if ("food" in layers && sameDay) {
            Sx.list(health?.optJSONArray("food")).forEach { meal ->
                val time = meal.optString("time")
                if (time.isEmpty()) return@forEach
                rows += Sx.toMinutes(time).toDouble() to feedLine(ctx, time, LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, Pv.rem(0.25f), 0, Pv.rem(0.25f))
                    addView(ctx.pvIcon("eats", c.food, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.5f) })
                    addView(ctx.pvText("${mealName(meal.optString("meal"))}: ${meal.optString("name")}", 0.875f, c.fg, maxLines = 1),
                        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                    addView(ctx.pvText(number(meal.optDouble("kcal").toInt()), 0.8125f, c.muted, mono = true))
                })
            }
        }
        if ("work" in layers) {
            Sx.list(day.optJSONArray("timed")).forEach { item ->
                val task = item.optJSONObject("task")
                val event = item.optJSONObject("event")
                val color = listColor(item.optInt("color", 0)).takeIf { it != 0 } ?: if (task != null) c.task else c.event
                val start = item.optString("start")
                rows += Sx.toMinutes(start).toDouble() to feedLine(ctx, start, block(owner, color, item.optString("name"),
                    "$start–${item.optString("end")}", (task ?: event)?.optString("description"), task, event, dayKey))
            }
        }
        rows.sortBy { it.first }
        val allDay = if ("work" in layers) Sx.list(day.optJSONArray("allDay")) else emptyList()
        if (rows.isEmpty() && allDay.isEmpty() && !isToday) {
            into.addView(ctx.pvText(Sx.t("День свободен", "The day is free"), 0.9375f, c.muted))
            return
        }
        allDay.forEach { e ->
            val color = if (e.optBoolean("isHoliday")) c.red else (listColor(e.optInt("color", 0)).takeIf { it != 0 } ?: c.event)
            into.addView(feedLine(ctx, Sx.t("весь", "all"), block(owner, color, e.optString("name"),
                if (e.optBoolean("isHoliday")) Sx.t("Праздник", "Holiday") else Sx.t("Весь день", "All day"), e.optString("description"), null, e, dayKey)), gap(0.25f))
        }
        val now = java.util.Calendar.getInstance().let { it.get(java.util.Calendar.HOUR_OF_DAY) * 60 + it.get(java.util.Calendar.MINUTE) }
        val nowIndex = if (isToday) rows.count { it.first <= now } else -1
        rows.forEachIndexed { i, (_, v) ->
            if (i == nowIndex) into.addView(nowLine(ctx, now), gap(0.25f))
            into.addView(v, gap(0.25f))
        }
        if (nowIndex == rows.size) into.addView(nowLine(ctx, now), gap(0.25f))
    }

    private fun mealName(meal: String) = when (meal) {
        "breakfast" -> Sx.t("Завтрак", "Breakfast"); "lunch" -> Sx.t("Обед", "Lunch"); "dinner" -> Sx.t("Ужин", "Dinner")
        "snack" -> Sx.t("Перекус", "Snack"); else -> Sx.t("Еда", "Food")
    }

    /** `.feedLine`: колонка времени 3 rem (моноширинный 0,8125 rem muted) и содержимое. */
    private fun feedLine(ctx: Context, time: String, content: View): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, Pv.rem(0.1875f), 0, Pv.rem(0.1875f))
        addView(ctx.pvText(time, 0.8125f, Pv.c.muted, mono = true, maxLines = 1), LinearLayout.LayoutParams(Pv.rem(3f), ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = Pv.rem(0.625f) })
        addView(content, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    private fun nowLine(ctx: Context, now: Int): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(ctx.pvText(Sx.clock(now), 0.8125f, Pv.c.red, semibold = true, mono = true), LinearLayout.LayoutParams(Pv.rem(3f), ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = Pv.rem(0.625f) })
        addView(View(ctx).apply { background = Pv.shape(Pv.c.red, 0.0625f) }, LinearLayout.LayoutParams(0, Pv.rem(0.125f), 1f))
    }

    /** `.feedBlock`: полоса цвета 0,1875 rem слева, фон цвета 16 % на raised, название и время моноширинным. */
    fun block(owner: PlannerController, color: Int, name: String, sub: String, note: String?, task: JSONObject?, event: JSONObject?, day: String,
              base: Int = Pv.c.raised): View {
        val ctx = owner.context()
        val c = Pv.c
        val isDone = task?.optString("status") == "done"
        return object : LinearLayout(ctx) {
            private val bar = Paint().apply { this.color = color }
            override fun dispatchDraw(canvas: Canvas) {
                super.dispatchDraw(canvas)
                canvas.save()
                val r = Pv.rem(0.375f).toFloat()
                val path = android.graphics.Path().apply { addRoundRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), r, r, android.graphics.Path.Direction.CW) }
                canvas.clipPath(path)
                canvas.drawRect(0f, 0f, Pv.rem(0.1875f).toFloat(), height.toFloat(), bar)
                canvas.restore()
            }
        }.apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(0.625f + 0.1875f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
            setWillNotDraw(false)
            if (task != null) {
                val check = CheckView(ctx, isDone, color, true)
                check.setOnClickListener {
                    check.checked = !check.checked; check.invalidate()
                    Sx.planner("taskDone", JSONObject().put("id", task.optString("id")).put("day", task.optString("instanceDay").ifEmpty { day }).put("done", check.checked))
                }
                addView(check, LinearLayout.LayoutParams(Pv.rem(1.25f), Pv.rem(1.25f)).apply { rightMargin = Pv.rem(0.5f) })
            }
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(ctx.pvText(name, 0.9375f, if (isDone) c.faint else c.fg, semibold = true, maxLines = 2).apply {
                if (isDone) paintFlags = paintFlags or Paint.STRIKE_THRU_TEXT_FLAG
            })
            texts.addView(ctx.pvText(sub, 0.75f, c.muted, mono = true, maxLines = 1))
            note?.lineSequence()?.firstOrNull { it.isNotBlank() }?.let { texts.addView(ctx.pvText(it.trim(), 0.8125f, c.muted, maxLines = 1)) }
            addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            Pv.pressable(this, Pv.mix(color, base, 16), 0.375f) {
                if (task != null) PlannerEditor.open(owner, "task", task.optString("id"), task.optString("instanceDay").ifEmpty { day })
                else if (event != null) PlannerEditor.open(owner, "event", event.optString("id"), event.optString("instanceDay").ifEmpty { day })
            }
        }
    }

    /** Полоса доли (`.prog`): 0,375 rem, радиус 0,1875 rem, дорожка line. */
    fun progress(ctx: Context, share: Double, color: Int, thick: Float = 0.375f): View = object : View(ctx) {
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(canvas: Canvas) {
            val r = Pv.rem(thick / 2f).toFloat()
            p.color = Pv.c.line
            canvas.drawRoundRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), r, r, p)
            val w = (width * share.coerceIn(0.0, 1.0)).toFloat()
            if (w > 0f) { p.color = color; canvas.drawRoundRect(RectF(0f, 0f, maxOf(w, 2 * r), height.toFloat()), r, r, p) }
        }
    }

    // ── слои календаря (`PlannerLayerChips`) ───────────────────────────────────────

    fun layerChips(owner: PlannerController, small: Boolean = false): LinearLayout {
        val ctx = owner.context()
        val c = Pv.c
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            for ((key, title, color) in listOf(Triple("sleep", Sx.t("Сон", "Sleep"), c.sleep), Triple("food", Sx.t("Еда", "Food"), c.food), Triple("work", Sx.t("Дела", "Tasks"), c.event))) {
                val on = key in owner.layers
                addView(LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(Pv.rem(if (small) 0.5f else 0.75f), 0, Pv.rem(if (small) 0.5f else 0.75f), 0)
                    if (!small) addView(View(ctx).apply { background = Pv.shape(color, 0.25f) },
                        LinearLayout.LayoutParams(Pv.rem(0.5f), Pv.rem(0.5f)).apply { rightMargin = Pv.rem(0.375f) })
                    addView(ctx.pvText(title, 0.8125f, if (on) color else c.muted))
                    if (on) Pv.pressable(this, Pv.alpha(color, 22), 0.9375f) { owner.toggleLayer(key) }
                    else Pv.pressable(this, 0, 0.9375f, c.line2) { owner.toggleLayer(key) }
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(if (small) 1.625f else 1.875f)).apply { rightMargin = Pv.rem(0.375f) })
            }
        }
    }

    /** `.tag.tagLarge`: метка цвета 18 % со значком. */
    private fun tag(ctx: Context, text: String, color: Int, icon: String? = null, onClick: (() -> Unit)? = null): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(0.5f), Pv.rem(0.1875f), Pv.rem(0.5f), Pv.rem(0.1875f))
        icon?.let { addView(ctx.pvIcon(it, color, 1f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.25f) }) }
        addView(ctx.pvText(text, 0.8125f, color))
        Pv.pressable(this, Pv.alpha(color, 18), 0.875f, onClick = onClick)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = Pv.rem(0.3125f) }
    }

    // ── «Мес» (`PlannerMonth` + карточка дня) ───────────────────────────────────────

    fun month(owner: PlannerController, into: LinearLayout, keys: List<String>, days: JSONObject, picked: JSONObject, health: JSONObject?) {
        val ctx = owner.context()
        val c = Pv.c
        into.addView(layerChips(owner), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = Pv.rem(0.75f) })
        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        for (i in 0 until 7) head.addView(ctx.pvText(if (Sx.isRu()) ruWeekShort[i] else enWeekShort[i], 0.75f, c.muted).apply { setPadding(Pv.rem(0.375f), 0, 0, Pv.rem(0.25f)) },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        into.addView(head)
        val month = Sx.calendarOf(owner.picked).get(java.util.Calendar.MONTH)
        keys.chunked(7).forEach { week ->
            val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            week.forEachIndexed { i, key ->
                val d = days.optJSONObject(key) ?: JSONObject()
                val isToday = key == Sx.today()
                val isPicked = key == owner.picked
                val outside = Sx.calendarOf(key).get(java.util.Calendar.MONTH) != month
                val cell = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER_HORIZONTAL
                    setPadding(Pv.rem(0.25f), Pv.rem(0.3125f), Pv.rem(0.25f), Pv.rem(0.3125f))
                    minimumHeight = Pv.rem(3.375f)
                    if (outside) alpha = 0.4f
                    val fill = if (d.optBoolean("isHoliday")) Pv.mix(c.red, c.raised, 14) else c.raised
                    Pv.pressable(this, fill, 0.5f, if (isPicked) c.accent else 0) { owner.pickDay(key) }
                    if (isPicked) (background as? android.graphics.drawable.RippleDrawable)?.let { rip ->
                        (rip.getDrawable(0) as? android.graphics.drawable.GradientDrawable)?.setStroke(Pv.rem(0.125f), c.accent)
                    }
                }
                val num = ctx.pvText("${Sx.calendarOf(key).get(java.util.Calendar.DAY_OF_MONTH)}", 0.875f, if (isToday) c.accentInk else c.fg, semibold = true, mono = true).apply {
                    gravity = Gravity.CENTER
                    if (isToday) { background = Pv.shape(c.accent, 0.625f); setPadding(Pv.rem(0.375f), 0, Pv.rem(0.375f), 0) }
                }
                cell.addView(num, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                val dots = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
                val colors = mutableListOf<Int>()
                if ("work" in owner.layers) {
                    Sx.list(d.optJSONArray("events")).forEach { e -> colors += listColor(e.optInt("color", 0)).takeIf { it != 0 } ?: c.event }
                    Sx.list(d.optJSONArray("tasks")).forEach { _ -> colors += c.task }
                    if ((d.optJSONArray("deadlines")?.length() ?: 0) > 0) colors += c.red
                }
                colors.take(3).forEach { col ->
                    dots.addView(View(ctx).apply { background = Pv.shape(col, 0.15625f) }, LinearLayout.LayoutParams(Pv.rem(0.3125f), Pv.rem(0.3125f)).apply {
                        leftMargin = Pv.rem(0.09375f); rightMargin = Pv.rem(0.09375f)
                    })
                }
                cell.addView(dots, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(0.3125f)).apply { topMargin = Pv.rem(0.25f) })
                row.addView(cell, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    if (i > 0) leftMargin = Pv.rem(0.1875f)
                })
            }
            into.addView(row, gap(0.1875f))
        }
        into.addView(dayCard(owner, picked, health), gap(1f))
    }

    /** Карточка дня под месяцем (`PlannerDayPanel variant="card"`). */
    private fun dayCard(owner: PlannerController, day: JSONObject, health: JSONObject?): View {
        val ctx = owner.context()
        val c = Pv.c
        val box = card(ctx)
        box.addView(ctx.pvText(dayHeading(owner.picked), 1f, c.fg, semibold = true))
        val sum = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        sum.addView(tag(ctx, "${Sx.t("План", "Plan")}: ${hours(day.optInt("minutes"))} / ${hours(day.optInt("budget", 600))} ${Sx.t("ч", "h")}",
            if (day.optInt("minutes") > day.optInt("budget", 600)) c.red else c.event))
        val kcal = health?.takeIf { it.optString("day") == owner.picked }?.optJSONObject("nutrients")?.optJSONObject("kcal")?.optDouble("value")?.takeIf { !it.isNaN() && it > 0 }
        kcal?.let { sum.addView(tag(ctx, Sx.t("${number(it.toInt())} ккал", "${number(it.toInt())} kcal"), c.food, "eats") { owner.openHealthTab() }) }
        box.addView(sum, gap(0.625f))
        val feedBox = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        feed(owner, feedBox, owner.picked, day, health, owner.layers)
        box.addView(feedBox, gap(0.625f))
        box.addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(ctx.pvButton(Sx.t("Добавить на этот день", "Add to this day"), icon = "plus") {
                QuickAdd.show(owner, if (owner.picked == Sx.today()) Sx.t("сегодня ", "today ") else {
                    val d = Sx.calendarOf(owner.picked)
                    String.format(java.util.Locale.US, "%02d.%02d ", d.get(java.util.Calendar.DAY_OF_MONTH), d.get(java.util.Calendar.MONTH) + 1)
                })
            })
        }, gap(0.75f))
        return box
    }

    // ── «День» (`PlannerDayStrip` + `PlannerWeek` одного дня) ──────────────────────

    fun dayView(owner: PlannerController, into: LinearLayout, day: JSONObject, health: JSONObject?, week: JSONObject) {
        val ctx = owner.context()
        val c = Pv.c
        into.setPadding(0, 0, 0, Pv.rem(1.5f))
        // Полоса дней недели (`.stripBar`)
        val strip = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(Pv.rem(0.75f), Pv.rem(0.5f), Pv.rem(0.75f), Pv.rem(0.625f))
            background = pvBottomLine(c.panel)
        }
        weekKeys(owner.picked).forEachIndexed { i, key ->
            val d = week.optJSONObject(key) ?: JSONObject()
            val isPicked = key == owner.picked
            val isToday = key == Sx.today()
            strip.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(0, Pv.rem(0.375f), 0, Pv.rem(0.4375f))
                addView(ctx.pvText(if (Sx.isRu()) ruWeekShort[i] else enWeekShort[i], 0.6875f, if (d.optBoolean("isHoliday")) c.red else c.muted))
                addView(ctx.pvText("${Sx.calendarOf(key).get(java.util.Calendar.DAY_OF_MONTH)}", 1.0625f,
                    if (isPicked) c.accentInk else if (isToday) c.accent else c.fg, semibold = true, mono = true).apply {
                    gravity = Gravity.CENTER
                    if (isPicked) background = Pv.shape(c.accent, 1.0625f)
                }, LinearLayout.LayoutParams(Pv.rem(2.125f), Pv.rem(2.125f)).apply { topMargin = Pv.rem(0.125f) })
                val load = d.optDouble("load").takeIf { !it.isNaN() } ?: 0.0
                addView(progress(ctx, load, if (load > 1) c.red else c.event, 0.1875f), LinearLayout.LayoutParams(Pv.rem(1.375f), Pv.rem(0.1875f)).apply { topMargin = Pv.rem(0.125f) })
                isClickable = true
                setOnClickListener { owner.pickDay(key) }
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (i > 0) leftMargin = Pv.rem(0.25f) })
        }
        // Полоса дней и сводка закреплены над сеткой (как web): листается только сетка часов
        val pinned = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(c.panel)
            addView(strip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val content = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Pv.rem(1f), 0, Pv.rem(1f), 0)
        }
        // Сводка: слои мелко, загрузка, сон, калории
        val sum = WrapLayout(ctx, Pv.rem(0.3125f))
        sum.addView(layerChips(owner, small = true))
        sum.addView(tag(ctx, "${hours(day.optInt("minutes"))} / ${hours(day.optInt("budget", 600))} ${Sx.t("ч", "h")}", c.event, "clock"))
        val sameDay = health?.optString("day") == owner.picked
        health?.optJSONObject("sleep")?.takeIf { sameDay }?.let { s -> sum.addView(tag(ctx, span(s.optDouble("value").toInt()), c.sleep, "moon") { owner.openHealthTab() }) }
        health?.takeIf { sameDay }?.optJSONObject("nutrients")?.optJSONObject("kcal")?.optDouble("value")?.takeIf { !it.isNaN() && it > 0 }?.let {
            sum.addView(tag(ctx, Sx.t("${number(it.toInt())} ккал", "${number(it.toInt())} kcal"), c.food, "eats") { owner.openHealthTab() })
        }
        pinned.addView(sum, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            setMargins(Pv.rem(1f), Pv.rem(0.75f), Pv.rem(1f), Pv.rem(0.5f))
        })
        owner.setPinned(pinned)
        val grid = DayGridView(ctx, owner, owner.picked, day, health?.takeIf { sameDay })
        content.addView(grid, gap(0.25f).apply { height = grid.totalHeight() })
        into.addView(content)
        // Сетка открывается на подъёме либо на первом деле дня
        val firstMinute = listOfNotNull(
            health?.takeIf { sameDay }?.optJSONObject("sleep")?.optString("endTime")?.takeIf { it.isNotEmpty() }?.let { Sx.toMinutes(it) },
            Sx.list(day.optJSONArray("timed")).minOfOrNull { Sx.toMinutes(it.optString("start")) },
        ).minOrNull() ?: (8 * 60)
        owner.scrollTo(grid.yOf(maxOf(0, firstMinute - 60)))
    }

    /** Сетка часов одного дня (`PlannerWeek` с `isSingle`): час 3,5 rem, подписи 2,875 rem, вне окон дня — тень bg 35 %. */
    class DayGridView(ctx: Context, private val owner: PlannerController, private val dayKey: String, private val day: JSONObject,
                      private val health: JSONObject?) : FrameLayout(ctx) {
        private val hour = Pv.rem(3.5f)
        private val hoursWidth = Pv.rem(2.875f)
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)
        private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Pv.mono(); textSize = Pv.rem(0.6875f).toFloat(); textAlign = Paint.Align.RIGHT }
        fun totalHeight() = hour * 24
        fun yOf(minute: Int) = (minute.toFloat() / 60f * hour).toInt()

        init {
            setWillNotDraw(false)
            setPadding(hoursWidth, 0, 0, 0)
            Sx.list(day.optJSONArray("timed")).forEach { item ->
                val task = item.optJSONObject("task")
                val event = item.optJSONObject("event")
                val c = Pv.c
                val color = listColor(item.optInt("color", 0)).takeIf { it != 0 } ?: if (task != null) c.task else c.event
                val start = Sx.toMinutes(item.optString("start"))
                val end = maxOf(Sx.toMinutes(item.optString("end")), start + 15)
                val lanes = maxOf(1, item.optInt("lanes", 1))
                val lane = item.optInt("lane", 0)
                val v = owner.context().let { context ->
                    LinearLayout(context).apply {
                        orientation = LinearLayout.VERTICAL
                        setPadding(Pv.rem(0.4375f + 0.1875f), Pv.rem(0.1875f), Pv.rem(0.4375f), Pv.rem(0.1875f))
                        addView(context.pvText(item.optString("name"), 0.8125f, c.fg, semibold = true, maxLines = 2))
                        addView(context.pvText("${item.optString("start")}–${item.optString("end")}", 0.6875f, c.muted, mono = true, maxLines = 1))
                        background = android.graphics.drawable.LayerDrawable(arrayOf(
                            Pv.shape(Pv.mix(color, c.panel, 20), 0.375f, c.panel),
                            android.graphics.drawable.GradientDrawable().apply {
                                setColor(color)
                                val r = Pv.rem(0.375f).toFloat()
                                cornerRadii = floatArrayOf(r, r, 0f, 0f, 0f, 0f, r, r)
                            })).apply { setLayerWidth(1, Pv.rem(0.1875f)) }
                        if (task?.optString("status") == "done") alpha = 0.55f
                        isClickable = true
                        setOnClickListener {
                            if (task != null) PlannerEditor.open(owner, "task", task.optString("id"), task.optString("instanceDay").ifEmpty { dayKey })
                            else if (event != null) PlannerEditor.open(owner, "event", event.optString("id"), event.optString("instanceDay").ifEmpty { dayKey })
                        }
                    }
                }
                addView(v, LayoutParams(0, yOf(end) - yOf(start) - Pv.px(1f)).apply { topMargin = yOf(start) + Pv.px(1f) })
                v.tag = floatArrayOf(lane.toFloat(), lanes.toFloat())
            }
            // Нажатие на свободное время — запись с этого времени (шаг 30 мин)
            setOnTouchListener { _, e ->
                if (e.actionMasked == MotionEvent.ACTION_UP && e.x > hoursWidth) {
                    val minute = ((e.y / hour) * 60).toInt() / 30 * 30
                    val d = Sx.calendarOf(dayKey)
                    QuickAdd.show(owner, String.format(java.util.Locale.US, "%02d.%02d %s ", d.get(java.util.Calendar.DAY_OF_MONTH), d.get(java.util.Calendar.MONTH) + 1, Sx.clock(minute)))
                }
                true
            }
        }

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
            super.onLayout(changed, l, t, r, b)
            val w = width - hoursWidth
            for (i in 0 until childCount) {
                val v = getChildAt(i)
                val lanes = (v.tag as? FloatArray) ?: continue
                val laneW = w / lanes[1]
                val left = hoursWidth + (laneW * lanes[0]).toInt()
                v.layout(left, v.top, left + laneW.toInt(), v.bottom)
            }
        }

        override fun onDraw(canvas: Canvas) {
            val c = Pv.c
            val w = width.toFloat()
            // Вне окон дня (до начала и после конца) — тень
            Sx.last("planner")?.optJSONObject("state")?.optJSONObject("settings").let { s ->
                val start = s?.optInt("dayStart", 9 * 60) ?: 9 * 60
                val end = s?.optInt("dayEnd", 21 * 60) ?: 21 * 60
                p.color = Pv.alpha(c.bg, 35); p.style = Paint.Style.FILL
                canvas.drawRect(hoursWidth.toFloat(), 0f, w, yOf(start).toFloat(), p)
                canvas.drawRect(hoursWidth.toFloat(), yOf(end).toFloat(), w, height.toFloat(), p)
            }
            // Сон: заливка 10 % до подъёма и пунктир на подъёме
            health?.optJSONObject("sleep")?.let { s ->
                val end = s.optString("endTime")
                val start = s.optString("time")
                if (end.isNotEmpty()) {
                    val endY = yOf(Sx.toMinutes(end)).toFloat()
                    val startY = if (start.isNotEmpty() && Sx.toMinutes(start) < Sx.toMinutes(end)) yOf(Sx.toMinutes(start)).toFloat() else 0f
                    p.color = Pv.alpha(c.sleep, 10)
                    canvas.drawRect(hoursWidth.toFloat(), startY, w, endY, p)
                    p.color = Pv.alpha(c.sleep, 50); p.style = Paint.Style.STROKE; p.strokeWidth = Pv.px(1f).toFloat()
                    p.pathEffect = DashPathEffect(floatArrayOf(Pv.px(4f).toFloat(), Pv.px(3f).toFloat()), 0f)
                    canvas.drawLine(hoursWidth.toFloat(), endY, w, endY, p)
                    p.pathEffect = null; p.style = Paint.Style.FILL
                }
            }
            // Линии часов, левая граница, подписи
            p.color = c.line; p.strokeWidth = Pv.px(1f).toFloat()
            for (h in 1..24) canvas.drawLine(hoursWidth.toFloat(), (h * hour - 1).toFloat(), w, (h * hour - 1).toFloat(), p)
            canvas.drawLine(hoursWidth.toFloat(), 0f, hoursWidth.toFloat(), height.toFloat(), p)
            text.color = c.faint
            for (h in 1 until 24) canvas.drawText(Sx.clock(h * 60), (hoursWidth - Pv.rem(0.5f)).toFloat(), h * hour + text.textSize / 3f, text)
            // «Сейчас»
            if (dayKey == Sx.today()) {
                val now = java.util.Calendar.getInstance().let { it.get(java.util.Calendar.HOUR_OF_DAY) * 60 + it.get(java.util.Calendar.MINUTE) }
                val y = yOf(now).toFloat()
                p.color = c.red
                canvas.drawRect(hoursWidth.toFloat(), y - Pv.px(1f), w, y + Pv.px(1f), p)
                canvas.drawCircle(hoursWidth.toFloat(), y, Pv.rem(0.25f).toFloat(), p)
            }
            super.onDraw(canvas)
        }
    }

    // ── «Год» (`PlannerYear`) ───────────────────────────────────────────────────────

    fun year(owner: PlannerController, into: LinearLayout, year: Int, days: JSONObject) {
        val ctx = owner.context()
        val c = Pv.c
        val letters = if (Sx.isRu()) arrayOf("п", "в", "с", "ч", "п", "с", "в") else arrayOf("m", "t", "w", "t", "f", "s", "s")
        val today = Sx.today()
        for (m in 0 until 12) {
            val isCurrent = today.startsWith(String.format(java.util.Locale.US, "%04d-%02d", year, m + 1))
            into.addView(ctx.pvText(Sx.monthTitle(year, m).substringBefore(" "), 0.9375f, if (isCurrent) c.accent else c.fg, semibold = true).apply {
                Pv.pressable(this, 0, 0.25f) { owner.picked = String.format(java.util.Locale.US, "%04d-%02d-01", year, m + 1); owner.switchSegment("month") }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = if (m == 0) 0 else Pv.rem(1.125f); bottomMargin = Pv.rem(0.375f)
            })
            val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            letters.forEach { head.addView(ctx.pvText(it, 0.625f, c.faint).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)) }
            into.addView(head)
            val first = java.util.GregorianCalendar(year, m, 1)
            val offset = (first.get(java.util.Calendar.DAY_OF_WEEK) + 5) % 7
            val count = first.getActualMaximum(java.util.Calendar.DAY_OF_MONTH)
            val cells = (0 until offset).map { null } + (1..count).map { it }
            cells.chunked(7).forEach { week ->
                val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                for (i in 0 until 7) {
                    val n = week.getOrNull(i)
                    if (n == null) { row.addView(View(ctx), square(i)); continue }
                    val key = String.format(java.util.Locale.US, "%04d-%02d-%02d", year, m + 1, n)
                    val d = days.optJSONObject(key)
                    val load = d?.optDouble("load")?.takeIf { !it.isNaN() } ?: 0.0
                    val holiday = d?.optBoolean("isHoliday") == true
                    row.addView(object : TextView(ctx) {
                        override fun onMeasure(w: Int, h: Int) { super.onMeasure(w, w) }
                    }.apply {
                        text = "$n"
                        gravity = Gravity.CENTER
                        textSize = 11f
                        typeface = if (holiday) Pv.semibold() else Pv.mono()
                        setTextColor(if (holiday) c.red else c.fg)
                        val stroke = when (key) { today -> c.accent; owner.picked -> c.muted; else -> 0 }
                        background = Pv.shape(Pv.mix(c.event, c.raised, (load * 100).toInt().coerceIn(0, 100)), 0.3125f, stroke, if (key == today) 2f else 1f)
                        isClickable = true
                        setOnClickListener { owner.picked = key; owner.switchSegment("month") }
                    }, square(i))
                }
                into.addView(row, gap(0.125f))
            }
        }
    }

    private fun square(i: Int) = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (i > 0) leftMargin = Pv.rem(0.125f) }

    // ── «Список» (`PlannerAgenda` + `PlannerGroupBar`) ─────────────────────────────

    fun agenda(owner: PlannerController, into: LinearLayout, days: JSONObject, lists: JSONArray) {
        val ctx = owner.context()
        val c = Pv.c
        // Группы
        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val headText = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        headText.addView(ctx.pvText(Sx.t("Группы", "Groups"), 1f, c.fg, semibold = true))
        headText.addView(ctx.pvText(Sx.t("записей · часов за 30 дней", "entries · hours in 30 days"), 0.75f, c.muted))
        head.addView(headText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(ctx.pvButton(Sx.t("Добавить в группу", "Add to group"), "acc") { PlannerEditor.pickGroup(owner, days) })
        into.addView(head)
        val chips = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        fun groupChip(dot: Int?, text: String, icon: String?, onClick: () -> Unit) {
            chips.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
                dot?.let { addView(View(ctx).apply { background = Pv.shape(it, 0.3125f) }, LinearLayout.LayoutParams(Pv.rem(0.625f), Pv.rem(0.625f)).apply { rightMargin = Pv.rem(0.5f) }) }
                icon?.let { addView(ctx.pvIcon(it, c.muted, 1f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.5f) }) }
                addView(ctx.pvText(text, 0.875f, if (icon != null) c.muted else c.fg))
                Pv.pressable(this, c.panel, 1f, c.line2, onClick)
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2f)).apply { rightMargin = Pv.rem(0.375f) })
        }
        groupChip(c.muted, Sx.t("Без группы", "No group"), null) { }
        Sx.list(lists).forEach { l -> groupChip(listColor(l.optInt("color", 0)).takeIf { it != 0 } ?: c.muted, l.optString("name"), null) { PlannerEditor.editGroup(owner, l) } }
        groupChip(null, Sx.t("Группа", "Group"), "plus") { PlannerEditor.editGroup(owner, null) }
        into.addView(HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; addView(chips) }, gap(0.75f))
        // Дни
        var any = false
        for (i in 0 until 30) {
            val key = Sx.addDays(owner.picked, i)
            val d = days.optJSONObject(key) ?: continue
            val timed = Sx.list(d.optJSONArray("timed"))
            val allDay = Sx.list(d.optJSONArray("allDay"))
            val untimed = Sx.list(d.optJSONArray("untimed"))
            val deadlines = Sx.list(d.optJSONArray("deadlines"))
            if (timed.isEmpty() && allDay.isEmpty() && untimed.isEmpty() && deadlines.isEmpty()) continue
            any = true
            into.addView(ctx.pvText(dayHeading(key), 0.875f, if (key == Sx.today()) c.accent else c.muted, semibold = true).apply {
                Pv.pressable(this, 0, 0.25f) { owner.picked = key; owner.switchSegment("week") }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(0.875f); bottomMargin = Pv.rem(0.375f) })
            allDay.forEach { e -> into.addView(feedLine(ctx, Sx.t("весь", "all"), block(owner, listColor(e.optInt("color", 0)).takeIf { it != 0 } ?: c.event, e.optString("name"), Sx.t("Весь день", "All day"), e.optString("description"), null, e, key, c.panel)), gap(0.25f)) }
            timed.forEach { item ->
                val task = item.optJSONObject("task")
                val color = listColor(item.optInt("color", 0)).takeIf { it != 0 } ?: if (task != null) c.task else c.event
                into.addView(feedLine(ctx, item.optString("start"), block(owner, color, item.optString("name"), "${item.optString("start")}–${item.optString("end")}",
                    (task ?: item.optJSONObject("event"))?.optString("description"), task, item.optJSONObject("event"), key, c.panel)), gap(0.25f))
            }
            untimed.forEach { t -> into.addView(feedLine(ctx, "", block(owner, listColor(0).takeIf { it != 0 } ?: c.task, t.optString("name"), t.optString("project").ifEmpty { Sx.t("Без группы", "No group") }, null, t, null, key, c.panel)), gap(0.25f)) }
            deadlines.forEach { t -> into.addView(feedLine(ctx, Sx.t("срок", "due"), block(owner, c.red, t.optString("name"), t.optString("project").ifEmpty { Sx.t("Без группы", "No group") }, null, t, null, key, c.panel)), gap(0.25f)) }
        }
        if (!any) into.addView(ctx.pvText(Sx.t("На ближайшие 30 дней ничего не запланировано", "Nothing planned for the next 30 days"), 0.9375f, c.muted), gap(1f))
    }

    // ── мелочи ──────────────────────────────────────────────────────────────────────

    class DashedLine(ctx: Context) : View(ctx) {
        private val p = Paint().apply { style = Paint.Style.STROKE; pathEffect = DashPathEffect(floatArrayOf(Pv.px(4f).toFloat(), Pv.px(3f).toFloat()), 0f) }
        override fun onDraw(canvas: Canvas) {
            p.color = Pv.c.line2; p.strokeWidth = height.toFloat()
            canvas.drawLine(0f, height / 2f, width.toFloat(), height / 2f, p)
        }
    }

    /** Ряд с переносом (как `flex-wrap`). */
    class WrapLayout(ctx: Context, private val spacing: Int) : ViewGroup(ctx) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val maxW = MeasureSpec.getSize(widthMeasureSpec)
            var x = 0; var y = 0; var line = 0
            for (i in 0 until childCount) {
                val v = getChildAt(i)
                measureChild(v, MeasureSpec.makeMeasureSpec(maxW, MeasureSpec.AT_MOST), heightMeasureSpec)
                if (x > 0 && x + v.measuredWidth > maxW) { x = 0; y += line + spacing; line = 0 }
                x += v.measuredWidth + spacing
                line = maxOf(line, v.measuredHeight)
            }
            setMeasuredDimension(maxW, y + line)
        }

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
            val maxW = r - l
            var x = 0; var y = 0; var line = 0
            for (i in 0 until childCount) {
                val v = getChildAt(i)
                if (x > 0 && x + v.measuredWidth > maxW) { x = 0; y += line + spacing; line = 0 }
                v.layout(x, y, x + v.measuredWidth, y + v.measuredHeight)
                x += v.measuredWidth + spacing
                line = maxOf(line, v.measuredHeight)
            }
        }
    }
}
