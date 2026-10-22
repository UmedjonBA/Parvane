package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import org.json.JSONObject
import org.thunderdog.challegram.R
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId

/**
 * Parvane (spec 031, T061): раздел «План» — день (сводка загрузки, весь день, дела по времени, задачи без
 * времени, сроки), месяц (сетка с отметками дел), список (задачи без даты по спискам) и «Здоровье». Данные —
 * запросы `days`/`undated` к логике ядра по снимку «Плана»; правки — `taskDone`, редактор и «+».
 */
class PlannerController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section get() = if (mode == "health") "health" else "calendar"
    override val tab = ParvaneTabBar.Tab.PLAN
    override fun getId() = R.id.controller_parvanePlanner
    override fun getName(): CharSequence = Sx.t("План", "Plan")

    private var mode = "day" // day | month | list | health
    private var day = Sx.today()
    private var monthAnchor = Sx.today()
    private var status = "loading"
    private var generation = 0

    fun openHealth() = apply { mode = "health" }

    override fun onBuilt() {
        watch("planner") { snap ->
            status = snap.optString("status", "loading")
            snap.optJSONObject("notice")?.let { n -> showNotice(n) }
            refresh()
        }
        if (Sx.last("planner") == null) refresh()
    }

    private var lastNotice = ""
    private fun showNotice(n: JSONObject) {
        val text = n.optString("text")
        if (text.isEmpty() || text == lastNotice) return
        lastNotice = text
        if (n.optBoolean("canUndo")) {
            context().let { ctx ->
                android.app.AlertDialog.Builder(ctx, org.thunderdog.challegram.theme.Theme.dialogTheme())
                    .setMessage(text)
                    .setPositiveButton(Sx.t("Отменить", "Undo")) { _, _ -> org.parvane.core.ParvaneSections.plannerUndo(Sx.t("Отменено", "Undone")) }
                    .setNegativeButton(android.R.string.ok, null).show()
            }
        }
    }

    fun refresh() {
        val gen = ++generation
        when (mode) {
            "day" -> Sx.planner("days", JSONObject().put("from", day).put("to", day).put("layout", true)) { r ->
                if (gen == generation) renderDay((r as? JSONObject)?.optJSONObject(day))
            }
            "month" -> {
                val c = Sx.calendarOf(monthAnchor)
                val y = c.get(java.util.Calendar.YEAR)
                val m = c.get(java.util.Calendar.MONTH)
                Sx.planner("monthGrid", JSONObject().put("year", y).put("month", m)) { keys ->
                    val list = (keys as? org.json.JSONArray)?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
                    if (list.isEmpty()) return@planner
                    Sx.planner("days", JSONObject().put("from", list.first()).put("to", list.last())) { r ->
                        if (gen == generation) renderMonth(y, m, list, r as? JSONObject ?: JSONObject())
                    }
                }
            }
            "list" -> Sx.planner("undated") { r -> if (gen == generation) renderList(r as? JSONObject ?: JSONObject()) }
            "health" -> Sx.planner("health", JSONObject().put("day", day)) { r ->
                if (gen == generation) rebuild { header(); HealthView.render(this, this@PlannerController, day, r as? JSONObject) }
            }
        }
    }

    private fun setMode(next: String) {
        mode = next
        org.parvane.core.ParvaneSections.show(section)
        refresh()
    }

    private fun LinearLayout.header() {
        tabs(listOf("day" to Sx.t("День", "Day"), "month" to Sx.t("Месяц", "Month"), "list" to Sx.t("Задачи", "Tasks"),
            "health" to Sx.t("Здоровье", "Health")), mode) { setMode(it) }
        statusLine()?.let { addView(context.label(it, 13f, ColorId.textLight).apply { layoutParams = lp(l = Sx.dp(18f), t = Sx.dp(4f)) }) }
        if (mode == "day" || mode == "health") {
            val row = context.hbox().apply { setPadding(Sx.dp(8f), Sx.dp(6f), Sx.dp(8f), 0) }
            row.addView(arrow(R.drawable.baseline_arrow_back_24) { day = Sx.addDays(day, -1); refresh() })
            row.addView(context.label(Sx.dayTitle(day), 18f, bold = true).apply {
                gravity = Gravity.CENTER
                layoutParams = lp(0, weight = 1f)
                setOnClickListener { pickDay() }
            })
            row.addView(arrow(R.drawable.baseline_arrow_back_24, flip = true) { day = Sx.addDays(day, 1); refresh() })
            addView(row)
            if (day != Sx.today()) addView(context.chip(Sx.t("К сегодня", "Go to today"), false) { day = Sx.today(); refresh() }.apply {
                layoutParams = lp(ViewGroup.LayoutParams.WRAP_CONTENT, l = Sx.dp(16f), t = Sx.dp(4f))
            })
        }
    }

    private fun statusLine(): String? = when (status) {
        "ready" -> null
        "needs-linking" -> Sx.t("Устройство ещё не привязано — «План» появится после привязки", "This device is not linked yet — the plan appears after linking")
        "no-key" -> Sx.t("Нет ключа «Плана» на этом устройстве", "No plan key on this device")
        "offline" -> Sx.t("Нет связи — показана сохранённая копия", "Offline — showing the saved copy")
        else -> Sx.t("Загрузка…", "Loading…")
    }

    private fun arrow(icon: Int, flip: Boolean = false, onClick: () -> Unit) = ImageView(context()).apply {
        setImageResource(icon)
        if (flip) rotation = 180f
        colorFilter = PorterDuffColorFilter(Sx.color(ColorId.icon), PorterDuff.Mode.SRC_IN)
        scaleType = ImageView.ScaleType.CENTER
        layoutParams = LinearLayout.LayoutParams(Sx.dp(44f), Sx.dp(44f))
        pressable(22f, Sx.color(ColorId.background), onClick)
    }

    private fun pickDay() {
        val c = Sx.calendarOf(day)
        android.app.DatePickerDialog(context(), org.thunderdog.challegram.theme.Theme.dialogTheme(), { _, y, m, d ->
            day = String.format(java.util.Locale.US, "%04d-%02d-%02d", y, m + 1, d)
            refresh()
        }, c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH), c.get(java.util.Calendar.DAY_OF_MONTH)).show()
    }

    // ── день ───────────────────────────────────────────────────────────────────

    private fun renderDay(d: JSONObject?): Unit = rebuild {
        header()
        if (d == null) {
            placeholder(statusLine() ?: Sx.t("Нет данных", "No data"))
            return@rebuild
        }
        // сводка: загрузка дня по бюджету
        val minutes = d.optInt("minutes")
        val budget = d.optDouble("budget", 0.0)
        addView(context.card().apply {
            addView(context.label(Sx.t("Загрузка дня", "Day load"), 13f, ColorId.textLight))
            addView(context.label(if (budget > 0) "${Sx.minutesLabel(minutes)} / ${Sx.minutesLabel(budget.toInt())}" else Sx.minutesLabel(minutes), 17f, bold = true))
            addView(context.bar(d.optDouble("load", 0.0), if (d.optDouble("load", 0.0) > 1.0) ColorId.iconNegative else ColorId.progress))
            val extra = mutableListOf<String>()
            if (d.has("freeMinutes")) extra += Sx.t("свободно ${Sx.minutesLabel(d.optInt("freeMinutes"))}", "${Sx.minutesLabel(d.optInt("freeMinutes"))} free")
            if (d.optInt("conflicts") > 0) extra += Sx.t("пересечений: ${d.optInt("conflicts")}", "overlaps: ${d.optInt("conflicts")}")
            if (d.optInt("unrated") > 0) extra += Sx.t("без оценки: ${d.optInt("unrated")}", "unrated: ${d.optInt("unrated")}")
            if (extra.isNotEmpty()) addView(context.label(extra.joinToString(" · "), 13f, ColorId.textLight).apply { layoutParams = lp(t = Sx.dp(6f)) })
        })
        val allDay = Sx.list(d.optJSONArray("allDay"))
        if (allDay.isNotEmpty()) {
            addView(context.sectionTitle(Sx.t("Весь день", "All day")))
            allDay.forEach { addView(eventRow(it, Sx.t("весь день", "all day"))) }
        }
        val timed = Sx.list(d.optJSONArray("timed"))
        if (timed.isNotEmpty()) {
            addView(context.sectionTitle(Sx.t("По времени", "Scheduled")))
            timed.sortedBy { Sx.toMinutes(it.optString("start")) }.forEach { t ->
                val time = "${t.optString("start")}–${t.optString("end")}"
                t.optJSONObject("task")?.let { addView(taskRow(it, time, t.optInt("color"))) }
                    ?: t.optJSONObject("event")?.let { addView(eventRow(it, time, t.optInt("color"))) }
            }
        }
        val untimed = Sx.list(d.optJSONArray("untimed"))
        if (untimed.isNotEmpty()) {
            addView(context.sectionTitle(Sx.t("Задачи", "Tasks")))
            untimed.forEach { addView(taskRow(it, it.optInt("minutes").takeIf { m -> m > 0 }?.let { m -> Sx.minutesLabel(m) } ?: "")) }
        }
        val deadlines = Sx.list(d.optJSONArray("deadlines"))
        if (deadlines.isNotEmpty()) {
            addView(context.sectionTitle(Sx.t("Сроки", "Due")))
            deadlines.forEach { addView(taskRow(it, Sx.t("срок", "due"))) }
        }
        if (allDay.isEmpty() && timed.isEmpty() && untimed.isEmpty() && deadlines.isEmpty())
            placeholder(Sx.t("На этот день ничего нет. Нажмите «+», чтобы добавить", "Nothing planned. Tap “+” to add"))
        addView(context.action(Sx.t("Новая задача", "New task")) { ItemEditor.open(this@PlannerController, "task", null, day) })
        addView(context.action(Sx.t("Новое событие", "New event")) { ItemEditor.open(this@PlannerController, "event", null, day) })
    }

    private fun stripe(color: Int) = View(context()).apply {
        background = rounded(if (color > 0) Sx.listColor(color) else Sx.color(ColorId.iconLight), 2f)
        layoutParams = LinearLayout.LayoutParams(Sx.dp(4f), Sx.dp(36f)).apply { rightMargin = Sx.dp(10f) }
    }

    fun taskRow(task: JSONObject, meta: String, color: Int = 0): View {
        val ctx = context()
        val done = task.optString("status") == "done"
        val row = ctx.hbox().apply {
            setPadding(Sx.dp(12f), Sx.dp(10f), Sx.dp(12f), Sx.dp(10f))
            layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(12f), r = Sx.dp(12f))
            pressable { ItemEditor.open(this@PlannerController, "task", task, task.optString("instanceDay", day)) }
        }
        row.addView(ImageView(ctx).apply {
            setImageResource(if (done) R.drawable.baseline_check_circle_24 else R.drawable.baseline_check_box_outline_blank_24)
            colorFilter = PorterDuffColorFilter(Sx.color(if (done) ColorId.iconPositive else ColorId.icon), PorterDuff.Mode.SRC_IN)
            contentDescription = Sx.t(if (done) "Выполнено" else "Отметить выполненной", if (done) "Done" else "Mark done")
            layoutParams = LinearLayout.LayoutParams(Sx.dp(36f), Sx.dp(36f)).apply { rightMargin = Sx.dp(8f) }
            scaleType = ImageView.ScaleType.CENTER
            setOnClickListener {
                Sx.planner("taskDone", JSONObject().put("id", task.optString("id")).put("day", task.optString("instanceDay", ""))
                    .put("done", !done).put("notice", if (!done) Sx.t("Задача выполнена", "Task done") else ""))
            }
        })
        if (color > 0 || task.optString("project").isNotEmpty()) row.addView(stripe(color))
        val texts = ctx.vbox().apply { layoutParams = lp(0, weight = 1f) }
        texts.addView(ctx.label(task.optString("name"), 15f, if (done) ColorId.textLight else ColorId.text, maxLines = 2).apply {
            if (done) paintFlags = paintFlags or android.graphics.Paint.STRIKE_THRU_TEXT_FLAG
        })
        val sub = listOf(meta, task.optString("project"), stepsLabel(task)).filter { it.isNotEmpty() }.joinToString(" · ")
        if (sub.isNotEmpty()) texts.addView(ctx.label(sub, 13f, ColorId.textLight, maxLines = 1))
        row.addView(texts)
        return row
    }

    private fun stepsLabel(task: JSONObject): String {
        val steps = task.optJSONArray("steps") ?: return ""
        if (steps.length() == 0) return ""
        val done = (0 until steps.length()).count { steps.optJSONObject(it)?.optBoolean("isDone") == true }
        return "$done/${steps.length()}"
    }

    fun eventRow(event: JSONObject, meta: String, color: Int = event.optInt("color")): View {
        val ctx = context()
        val row = ctx.hbox().apply {
            setPadding(Sx.dp(12f), Sx.dp(10f), Sx.dp(12f), Sx.dp(10f))
            layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(12f), r = Sx.dp(12f))
            pressable { ItemEditor.open(this@PlannerController, "event", event, event.optString("instanceDay", day)) }
        }
        row.addView(stripe(color))
        val texts = ctx.vbox().apply { layoutParams = lp(0, weight = 1f) }
        texts.addView(ctx.label(event.optString("name"), 15f, maxLines = 2))
        val sub = listOfNotNull(meta, event.optString("description").lineSequence().firstOrNull()?.takeIf { it.isNotBlank() },
            if (event.optBoolean("isHoliday")) Sx.t("выходной", "day off") else null).joinToString(" · ")
        texts.addView(ctx.label(sub, 13f, ColorId.textLight, maxLines = 1))
        row.addView(texts)
        return row
    }

    // ── месяц ──────────────────────────────────────────────────────────────────

    private fun renderMonth(year: Int, month0: Int, keys: List<String>, days: JSONObject): Unit = rebuild {
        header()
        val nav = context.hbox().apply { setPadding(Sx.dp(8f), Sx.dp(6f), Sx.dp(8f), 0) }
        nav.addView(arrow(R.drawable.baseline_arrow_back_24) { monthAnchor = shiftMonth(-1); refresh() })
        nav.addView(context.label(Sx.monthTitle(year, month0), 18f, bold = true).apply { gravity = Gravity.CENTER; layoutParams = lp(0, weight = 1f) })
        nav.addView(arrow(R.drawable.baseline_arrow_back_24, flip = true) { monthAnchor = shiftMonth(1); refresh() })
        addView(nav)
        val grid = GridLayout(context).apply { columnCount = 7; setPadding(Sx.dp(8f), Sx.dp(4f), Sx.dp(8f), 0) }
        val first = Sx.calendarOf(keys.first()).get(java.util.Calendar.DAY_OF_WEEK) - 1
        for (i in 0 until 7) grid.addView(context.label(Sx.weekdayShort((first + i) % 7), 12f, ColorId.textLight).apply {
            gravity = Gravity.CENTER
        }, cell())
        val today = Sx.today()
        keys.forEach { key ->
            val entry = days.optJSONObject(key)
            val c = Sx.calendarOf(key)
            val inMonth = c.get(java.util.Calendar.MONTH) == month0
            val count = (entry?.optJSONArray("tasks")?.length() ?: 0) + (entry?.optJSONArray("events")?.length() ?: 0)
            val box = context.vbox().apply {
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(0, Sx.dp(6f), 0, Sx.dp(6f))
                val fill = when {
                    key == today -> Sx.color(ColorId.fillingPositive)
                    entry?.optBoolean("isHoliday") == true -> Sx.color(ColorId.fillingNegative)
                    else -> Sx.color(ColorId.filling)
                }
                pressable(10f, fill) { day = key; setMode("day") }
                addView(context.label("${c.get(java.util.Calendar.DAY_OF_MONTH)}", 15f,
                    when {
                        key == today -> ColorId.fillingPositiveContent
                        inMonth -> ColorId.text
                        else -> ColorId.textLight
                    }, bold = key == today).apply { gravity = Gravity.CENTER })
                addView(context.label(if (count > 0) "•".repeat(count.coerceAtMost(3)) else " ", 12f, ColorId.iconActive).apply { gravity = Gravity.CENTER })
            }
            grid.addView(box, cell())
        }
        addView(grid, lp())
    }

    private fun cell() = GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED, 1f), GridLayout.spec(GridLayout.UNDEFINED, 1f)).apply {
        width = 0
        setMargins(Sx.dp(2f), Sx.dp(2f), Sx.dp(2f), Sx.dp(2f))
    }

    private fun shiftMonth(n: Int): String {
        val c = Sx.calendarOf(monthAnchor)
        c.set(java.util.Calendar.DAY_OF_MONTH, 1)
        c.add(java.util.Calendar.MONTH, n)
        return Sx.dayOf(c)
    }

    // ── список задач без даты ──────────────────────────────────────────────────

    private fun renderList(r: JSONObject): Unit = rebuild {
        header()
        val undated = Sx.list(r.optJSONArray("undated"))
        if (undated.isEmpty()) placeholder(Sx.t("Задач без даты нет", "No undated tasks"))
        undated.groupBy { it.optString("project") }.toSortedMap(compareBy { it.isEmpty() }).forEach { (project, tasks) ->
            addView(context.sectionTitle(project.ifEmpty { Sx.t("Без списка", "No list") }))
            tasks.forEach { t ->
                val status = when (t.optString("status")) {
                    "active" -> Sx.t("в работе", "in progress")
                    else -> ""
                }
                addView(taskRow(t, status))
            }
        }
        val completed = Sx.list(r.optJSONArray("completed"))
        if (completed.isNotEmpty()) {
            addView(context.sectionTitle(Sx.t("Выполнено: ${completed.size}", "Completed: ${completed.size}")))
            completed.take(30).forEach { addView(taskRow(it, "")) }
        }
        addView(context.action(Sx.t("Новая задача", "New task")) { ItemEditor.open(this@PlannerController, "task", null, "") })
    }
}
