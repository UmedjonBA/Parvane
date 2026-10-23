package org.thunderdog.challegram.parvane.sections

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.thunderdog.challegram.theme.Theme

/**
 * Parvane (spec 032): карточка записи «Плана» 1:1 с web на телефоне (`PlannerEventEditor`/`PlannerTaskEditor` в
 * шторке): в шапке — вид («Событие»/«Задача») и день, ниже название крупно и строки `PlannerCardRow` со значком слева —
 * время, повтор, группа (с цветами, если группы нет), напоминание, описание; у задачи — статус и шаги. Правки
 * сохраняются операцией ядра `save` (у ряда — «только это / это и последующие / весь ряд»), удаление — `remove`.
 * Здесь же — «Настройки плана» и группы вида «Список».
 */
object PlannerEditor {
    private val repeatKinds = listOf("", "daily", "weekly", "monthly", "yearly")
    private val remindValues = listOf(-1, 0, 5, 10, 15, 30, 60, 120, 1440)

    /** Открыть запись по id: ищется в днях вокруг [day] и в задачах без даты. */
    fun open(owner: PlannerController, kind: String, id: String, day: String) {
        val from = day.ifEmpty { Sx.today() }
        Sx.planner("days", JSONObject().put("from", from).put("to", from)) { r ->
            val d = (r as? JSONObject)?.optJSONObject(from)
            val pools = listOf("tasks", "events", "allDay", "deadlines", "untimed")
            val found = pools.asSequence().flatMap { Sx.list(d?.optJSONArray(it)).asSequence() }.firstOrNull { it.optString("id") == id }
            if (found != null) { show(owner, kind, found, day); return@planner }
            Sx.planner("undated") { u ->
                val all = Sx.list((u as? JSONObject)?.optJSONArray("undated")) + Sx.list((u as? JSONObject)?.optJSONArray("completed"))
                all.firstOrNull { it.optString("id") == id }?.let { show(owner, kind, it, day) }
            }
        }
    }

    /** Полная форма новой записи с черновиком ввода текстом («Подробнее»). */
    fun openNew(owner: org.thunderdog.challegram.navigation.ViewController<*>, draft: JSONObject?) {
        val planner = owner as? PlannerController
        val kind = if (draft?.optString("kind") == "event") "event" else "task"
        val item = JSONObject()
        draft?.let { d ->
            listOf("name", "day", "start", "end", "description", "due").forEach { k -> d.optString(k).takeIf { it.isNotEmpty() && it != "null" }?.let { item.put(k, it) } }
            if (d.has("minutes") && !d.isNull("minutes")) item.put("minutes", d.optInt("minutes"))
            d.optJSONObject("repeat")?.let { item.put("repeat", it) }
            d.optString("list").takeIf { it.isNotEmpty() }?.let { item.put("project", it) }
        }
        show(owner, kind, item, item.optString("day").ifEmpty { planner?.picked ?: Sx.today() })
    }

    private fun show(owner: org.thunderdog.challegram.navigation.ViewController<*>, kind: String, src: JSONObject, day: String) {
        val ctx = owner.context()
        val c = Pv.c
        val isTask = kind == "task"
        val id = src.optString("id")
        val repeat = src.optJSONObject("repeat")
        val repeating = repeat != null
        val itemDay = src.optString("instanceDay").ifEmpty { src.optString("day") }.ifEmpty { if (isTask && id.isNotEmpty()) "" else day }
        // Шапка: метка вида и день
        val kindColor = if (isTask) c.task else c.event
        val kindChip = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(0.75f), Pv.rem(0.25f), Pv.rem(0.75f), Pv.rem(0.25f))
            addView(ctx.pvIcon(if (isTask) "check" else "cal", kindColor, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.375f) })
            addView(ctx.pvText(if (isTask) Sx.t("Задача", "Task") else Sx.t("Событие", "Event"), 0.875f, kindColor, semibold = true))
            background = Pv.shape(Pv.alpha(kindColor, 18), 1f)
        }
        // Шапка карточки web: вид записи и рядом дата приглушённо («Пт, 23 октября»), без заголовка
        val dateText = if (itemDay.isEmpty()) Sx.t("Без даты", "No date") else {
            val weekday = java.text.SimpleDateFormat("EE", if (Sx.isRu()) java.util.Locale("ru") else java.util.Locale.ENGLISH)
                .format(Sx.calendarOf(itemDay).time).trimEnd('.').replaceFirstChar { it.uppercase() }
            "$weekday, ${PlannerViews.dayLong(itemDay)}"
        }
        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(kindChip)
            addView(ctx.pvText(dateText, 0.9375f, Pv.c.muted, maxLines = 1),
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = Pv.rem(0.75f) })
        }
        val sheet = PvSheet.create(ctx, null, headBefore = head)
        // Название крупно, с линией снизу
        val name = EditText(ctx).apply {
            setText(src.optString("name"))
            hint = Sx.t("Название", "Name")
            textSize = 20f
            typeface = Pv.semibold()
            setTextColor(c.fg)
            setHintTextColor(c.faint)
            background = pvBottomLine(c.panel)
            setPadding(0, Pv.rem(0.5f), 0, Pv.rem(0.625f))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        sheet.add(name)
        // Когда
        var dayValue = itemDay
        var startValue = src.optString("start").takeUnless { src.optBoolean("isAllDay") } ?: ""
        var endValue = src.optString("end").takeUnless { src.optBoolean("isAllDay") } ?: ""
        val whenBody = column(ctx)
        val dayField = pickField(ctx, dayLabel(dayValue, isTask)) { v ->
            val cal = Sx.calendarOf(dayValue.ifEmpty { Sx.today() })
            DatePickerDialog(ctx, Theme.dialogTheme(), { _, y, m, d ->
                dayValue = String.format(java.util.Locale.US, "%04d-%02d-%02d", y, m + 1, d); v.text = dayLabel(dayValue, isTask)
            }, cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH), cal.get(java.util.Calendar.DAY_OF_MONTH)).apply {
                if (isTask) setButton(DatePickerDialog.BUTTON_NEUTRAL, Sx.t("Без даты", "No date")) { _, _ -> dayValue = ""; v.text = dayLabel("", true) }
            }.show()
        }
        whenBody.addView(labeled(ctx, if (isTask) Sx.t("День", "Day") else Sx.t("Дата события", "Event date"), dayField))
        val times = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        fun timeField(initial: String, empty: String, set: (String) -> Unit) = pickField(ctx, initial.ifEmpty { empty }) { v ->
            val m = Sx.toMinutes(v.text.toString()).takeIf { it >= 0 } ?: (9 * 60)
            TimePickerDialog(ctx, Theme.dialogTheme(), { _, h, mm -> val s = Sx.clock(h * 60 + mm); set(s); v.text = s }, m / 60, m % 60, true).apply {
                setButton(TimePickerDialog.BUTTON_NEUTRAL, Sx.t("Без времени", "No time")) { _, _ -> set(""); v.text = empty }
            }.show()
        }
        times.addView(labeled(ctx, Sx.t("Начало", "Start"), timeField(startValue, "—") { startValue = it }), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        var minutes: EditText? = null
        if (isTask) {
            minutes = input(ctx, src.optInt("minutes").takeIf { it > 0 }?.toString() ?: "", Sx.t("мин", "min"), InputType.TYPE_CLASS_NUMBER)
            times.addView(labeled(ctx, Sx.t("Длительность, мин", "Duration, min"), minutes), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Pv.rem(0.75f) })
        } else {
            times.addView(labeled(ctx, Sx.t("Конец", "End"), timeField(endValue, "—") { endValue = it }), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Pv.rem(0.75f) })
        }
        whenBody.addView(times, gapLp(0.625f))
        var allDay: CheckBox? = null
        var holiday: CheckBox? = null
        var due: TextView? = null
        var dueValue = src.optString("due")
        if (!isTask) {
            val checks = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            allDay = check(ctx, Sx.t("Весь день", "All day"), src.optBoolean("isAllDay"))
            holiday = check(ctx, Sx.t("Праздник", "Holiday"), src.optBoolean("isHoliday"))
            checks.addView(allDay, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            checks.addView(holiday, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            whenBody.addView(checks, gapLp(0.625f))
        } else {
            due = pickField(ctx, if (dueValue.isEmpty()) Sx.t("Без срока", "No due date") else Sx.dayTitle(dueValue)) { v ->
                val cal = Sx.calendarOf(dueValue.ifEmpty { Sx.today() })
                DatePickerDialog(ctx, Theme.dialogTheme(), { _, y, m, d ->
                    dueValue = String.format(java.util.Locale.US, "%04d-%02d-%02d", y, m + 1, d); v.text = Sx.dayTitle(dueValue)
                }, cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH), cal.get(java.util.Calendar.DAY_OF_MONTH)).apply {
                    setButton(DatePickerDialog.BUTTON_NEUTRAL, Sx.t("Без срока", "No due date")) { _, _ -> dueValue = ""; v.text = Sx.t("Без срока", "No due date") }
                }.show()
            }
            whenBody.addView(labeled(ctx, Sx.t("Срок", "Due"), due), gapLp(0.625f))
        }
        sheet.add(cardRow(ctx, "clock", whenBody), 0f)
        // Повтор: правило одной строкой, поля раскрываются
        var repeatKind = repeatKinds.indexOf(repeat?.optString("kind") ?: "").coerceAtLeast(0)
        val interval = input(ctx, (repeat?.optInt("interval", 1) ?: 1).toString(), "1", InputType.TYPE_CLASS_NUMBER)
        val repeatBody = column(ctx)
        val repeatFields = column(ctx).apply { visibility = View.GONE }
        val repeatNames = listOf(Sx.t("Не повторяется", "Does not repeat"), Sx.t("Каждый день", "Daily"), Sx.t("Каждую неделю", "Weekly"),
            Sx.t("Каждый месяц", "Monthly"), Sx.t("Каждый год", "Yearly"))
        val repeatButton = selectField(ctx, repeatNames[repeatKind]) { v ->
            if (repeatFields.visibility == View.GONE) repeatFields.visibility = View.VISIBLE
            PvSheet.choose(ctx, Sx.t("Повтор", "Repeat"), repeatNames) { i -> repeatKind = i; v.text = repeatNames[i] }
        }
        repeatBody.addView(repeatButton)
        repeatFields.addView(labeled(ctx, Sx.t("Шаг повтора (1 — каждый)", "Every (1 — each)"), interval), gapLp(0.625f))
        repeatBody.addView(repeatFields)
        sheet.add(cardRow(ctx, "repeat", repeatBody), 0f)
        // Группа
        var project = src.optString("project")
        var color = src.optInt("color", 0)
        val groupBody = column(ctx)
        val swatches = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        fun paintSwatches() {
            swatches.removeAllViews()
            swatches.visibility = if (project.isEmpty() && !isTask) View.VISIBLE else View.GONE
            for (i in 0..8) {
                val col = if (i == 0) c.panel else Sx.listColor(i)
                swatches.addView(View(ctx).apply {
                    background = Pv.shape(col, 0.875f, if (i == color) c.accent else if (i == 0) c.line2 else 0, if (i == color) 2f else 1f)
                    setOnClickListener { color = i; paintSwatches() }
                }, LinearLayout.LayoutParams(Pv.rem(1.75f), Pv.rem(1.75f)).apply { rightMargin = Pv.rem(0.5f); topMargin = Pv.rem(0.25f) })
            }
        }
        val groupButton = selectField(ctx, project.ifEmpty { Sx.t("Без группы", "No group") }) { v ->
            Sx.planner("lists") { lists ->
                val names = listOf(Sx.t("Без группы", "No group")) + Sx.list(lists as? JSONArray).map { it.optString("name") } + Sx.t("Новая группа…", "New group…")
                PvSheet.choose(ctx, Sx.t("Группа", "Group"), names) { i ->
                    when (i) {
                        0 -> { project = ""; v.text = names[0] }
                        names.size - 1 -> askName(ctx, Sx.t("Новая группа", "New group"), "") { n -> project = n; v.text = n; paintSwatches() }
                        else -> { project = names[i]; v.text = names[i] }
                    }
                    paintSwatches()
                }
            }
        }
        groupBody.addView(labeled(ctx, Sx.t("Группа", "Group"), groupButton))
        groupBody.addView(android.widget.HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; addView(swatches) }, gapLp(0.375f))
        paintSwatches()
        sheet.add(cardRow(ctx, "folder", groupBody), 0f)
        // Напомнить
        var remind = remindValues.indexOf(if (src.has("remind") && !src.isNull("remind")) src.optInt("remind") else -1).coerceAtLeast(0)
        val remindNames = remindValues.map { v ->
            when (v) {
                -1 -> Sx.t("Без напоминания", "No reminder"); 0 -> Sx.t("В момент начала", "At start"); 1440 -> Sx.t("За день", "1 day before")
                else -> Sx.t("За ${Sx.minutesLabel(v)}", "${Sx.minutesLabel(v)} before")
            }
        }
        val remindBody = column(ctx)
        remindBody.addView(labeled(ctx, Sx.t("Напомнить", "Remind"), selectField(ctx, remindNames[remind]) { v ->
            PvSheet.choose(ctx, Sx.t("Напомнить", "Remind"), remindNames) { i -> remind = i; v.text = remindNames[i] }
        }))
        sheet.add(cardRow(ctx, "alarm", remindBody), 0f)
        // Статус и шаги задачи
        var status = src.optString("status", "queue").let { if (it == "later" || it == "waiting") "queue" else it }
        var steps: EditText? = null
        if (isTask) {
            val statusNames = listOf(Sx.t("В очереди", "Queued"), Sx.t("В работе", "In progress"), Sx.t("Выполнено", "Done"))
            val statusKeys = listOf("queue", "active", "done")
            val statusBody = column(ctx)
            statusBody.addView(labeled(ctx, Sx.t("Статус", "Status"), selectField(ctx, statusNames[statusKeys.indexOf(status).coerceAtLeast(0)]) { v ->
                PvSheet.choose(ctx, Sx.t("Статус", "Status"), statusNames) { i -> status = statusKeys[i]; v.text = statusNames[i] }
            }))
            sheet.add(cardRow(ctx, "check", statusBody), 0f)
            val lines = Sx.list(src.optJSONArray("steps")).joinToString("\n") { (if (it.optBoolean("isDone")) "[x] " else "") + it.optString("text") }
            steps = input(ctx, lines, Sx.t("Шаги — по одному в строке, [x] — сделан", "Steps — one per line, [x] — done"),
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE).apply { minLines = 2; isSingleLine = false; gravity = Gravity.TOP }
            sheet.add(cardRow(ctx, "note", column(ctx).apply { addView(labeled(ctx, Sx.t("Шаги", "Steps"), steps)) }), 0f)
        }
        // Описание
        val description = input(ctx, src.optString("description"), Sx.t("Описание", "Description"),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES).apply { minLines = 2; isSingleLine = false; gravity = Gravity.TOP }
        sheet.add(cardRow(ctx, "text", column(ctx).apply { addView(description) }), 0f)
        // Кнопки
        val error = ctx.pvText("", 0.8125f, c.red).apply { visibility = View.GONE }
        sheet.add(error)
        val actions = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        if (id.isNotEmpty()) actions.addView(ctx.pvButton(Sx.t("Удалить", "Delete"), "danger", icon = "trash") {
            withScope(ctx, repeating, Sx.t("Удалить повторяющуюся запись", "Delete repeating item")) { scope ->
                Sx.planner("remove", JSONObject().put("kind", kind).put("id", id).put("day", if (repeating) day else "").put("scope", scope)
                    .put("notice", Sx.t("Удалено", "Deleted"))) { sheet.dismiss() }
            }
        })
        actions.addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
        actions.addView(ctx.pvButton(Sx.t("Отмена", "Cancel"), "ghost") { sheet.dismiss() })
        actions.addView(ctx.pvButton(if (id.isEmpty()) Sx.t("Создать", "Create") else Sx.t("Сохранить", "Save"), "acc") {
            val out = JSONObject().put("name", name.text.toString().trim())
            if (id.isNotEmpty()) out.put("id", id)
            if (isTask) {
                out.put("day", if (dayValue.isEmpty()) JSONObject.NULL else dayValue)
                out.put("start", if (startValue.isEmpty()) JSONObject.NULL else startValue)
                out.put("minutes", minutes!!.text.toString().toIntOrNull()?.takeIf { it > 0 } ?: JSONObject.NULL)
                out.put("due", if (dueValue.isEmpty()) JSONObject.NULL else dueValue)
                out.put("status", status)
                out.put("project", project)
                out.put("description", description.text.toString())
                out.put("steps", JSONArray(steps!!.text.lines().filter { it.isNotBlank() }.map { line ->
                    val mark = line.trimStart().startsWith("[x]", ignoreCase = true)
                    JSONObject().put("text", line.trimStart().removePrefix("[x]").removePrefix("[X]").trim()).put("isDone", mark)
                }))
            } else {
                out.put("day", dayValue.ifEmpty { Sx.today() })
                val whole = allDay!!.isChecked || (startValue.isEmpty() && endValue.isEmpty())
                out.put("isAllDay", whole)
                out.put("isHoliday", holiday!!.isChecked)
                if (whole) { out.put("start", "00:00"); out.put("end", "23:59") }
                else {
                    val s = startValue.ifEmpty { "09:00" }
                    out.put("start", s)
                    out.put("end", endValue.ifEmpty { Sx.clock(Sx.toMinutes(s) + 60) })
                }
                out.put("description", description.text.toString())
                out.put("project", if (project.isEmpty()) JSONObject.NULL else project)
                out.put("color", if (project.isEmpty() && color > 0) color else JSONObject.NULL)
            }
            if (repeatKind == 0) out.put("repeat", JSONObject.NULL)
            else {
                val base = repeat ?: JSONObject()
                val anchor = dayValue.ifEmpty { Sx.today() }
                val r = JSONObject().put("kind", repeatKinds[repeatKind])
                    .put("interval", interval.text.toString().toIntOrNull()?.coerceIn(1, 99) ?: 1)
                    .put("startDay", base.optString("startDay").ifEmpty { anchor })
                if (repeatKinds[repeatKind] == "weekly") r.put("weekdays", base.optJSONArray("weekdays")
                    ?: JSONArray().put(Sx.calendarOf(anchor).get(java.util.Calendar.DAY_OF_WEEK) - 1))
                if (repeatKinds[repeatKind] == "monthly") r.put("monthDay", base.optInt("monthDay", Sx.calendarOf(anchor).get(java.util.Calendar.DAY_OF_MONTH)))
                if (base.has("endDay")) r.put("endDay", base.opt("endDay"))
                if (base.has("count")) r.put("count", base.opt("count"))
                out.put("repeat", r)
            }
            out.put("remind", if (remindValues[remind] < 0) JSONObject.NULL else remindValues[remind])
            if (out.optString("name").isEmpty()) { error.text = Sx.t("Нужно название", "Name required"); error.visibility = View.VISIBLE; return@pvButton }
            withScope(ctx, repeating && id.isNotEmpty(), Sx.t("Изменить повторяющуюся запись", "Edit repeating item")) { scope ->
                Sx.planner("save", JSONObject().put("kind", kind).put("item", out).put("scope", scope).put("day", if (repeating) day else dayValue)) { r ->
                    val err = (r as? JSONObject)?.optString("error").orEmpty()
                    if (err.isNotEmpty()) { error.text = errorText(err); error.visibility = View.VISIBLE }
                    else sheet.dismiss()
                }
            }
        }.apply { (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f) })
        sheet.add(actions)
        sheet.show()
        if (id.isEmpty()) name.requestFocus()
    }

    // ── «Настройки плана» ──────────────────────────────────────────────────────────

    fun openSettings(owner: SectionController) {
        val ctx = owner.context()
        val c = Pv.c
        Sx.planner("settings") { r ->
            val s = (r as? JSONObject)?.optJSONObject("settings") ?: JSONObject()
            var start = s.optInt("dayStart", 9 * 60)
            var end = s.optInt("dayEnd", 21 * 60)
            val sheet = PvSheet.create(ctx, Sx.t("Настройки плана", "Planner settings"))
            sheet.add(PlannerViews.capsTitle(ctx, Sx.t("План", "Plan")))
            val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            row.addView(labeled(ctx, Sx.t("Начало дня", "Day start"), pickField(ctx, Sx.clock(start)) { v ->
                TimePickerDialog(ctx, Theme.dialogTheme(), { _, h, m -> start = h * 60 + m; v.text = Sx.clock(start) }, start / 60, start % 60, true).show()
            }), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(labeled(ctx, Sx.t("Конец дня", "Day end"), pickField(ctx, Sx.clock(end)) { v ->
                TimePickerDialog(ctx, Theme.dialogTheme(), { _, h, m -> end = h * 60 + m; v.text = Sx.clock(end) }, end / 60, end % 60, true).show()
            }), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Pv.rem(0.75f) })
            sheet.add(row)
            val budget = input(ctx, ((r as? JSONObject)?.optInt("budget", 600) ?: 600).toString(), "600", InputType.TYPE_CLASS_NUMBER)
            sheet.add(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(labeled(ctx, Sx.t("Дневной бюджет, мин", "Daily budget, min"), budget), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f).apply { leftMargin = Pv.rem(0.75f) })
            })
            sheet.add(ctx.pvText(Sx.t("По этим значениям считаются окна дня, поиск времени и цвет загрузки дня.",
                "Day windows, time search and the day load colour are computed from these values."), 0.875f, c.muted))
            sheet.add(ctx.pvText(Sx.t("Цели меняются и текстом: начните строку в «+» со слова «цель».",
                "Goals can also be changed with text: start a line in “+” with the word “goal”."), 0.875f, c.muted))
            val error = ctx.pvText("", 0.8125f, c.red).apply { visibility = View.GONE }
            sheet.add(error)
            sheet.add(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(ctx.pvButton(Sx.t("Сбросить по умолчанию", "Reset to defaults"), "danger") {
                    Sx.planner("settings", JSONObject().put("dayStart", 9 * 60).put("dayEnd", 21 * 60).put("budget", 600)) { sheet.dismiss() }
                })
                addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
                addView(ctx.pvButton(Sx.t("Сохранить", "Save"), "acc") {
                    Sx.planner("settings", JSONObject().put("dayStart", start).put("dayEnd", end).put("budget", budget.text.toString().toIntOrNull() ?: 600)) { res ->
                        val err = (res as? JSONObject)?.optString("error").orEmpty()
                        if (err.isNotEmpty()) { error.text = errorText(err); error.visibility = View.VISIBLE } else sheet.dismiss()
                    }
                })
            })
            sheet.add(ctx.pvText(Sx.t("Ввод текстом запоминает, как вы поправляете тип и длительность для первого слова названия. После трёх одинаковых правок значение подставляется само. Выученное хранится вместе с данными «Плана» и синхронизируется между вашими устройствами.",
                "Text input remembers how you correct the type and duration for the first word of a name. After three identical corrections the value is filled in automatically. What it learns is stored with your plan and synced between your devices."), 0.875f, c.muted))
            sheet.show()
        }
    }

    // ── группы вида «Список» ───────────────────────────────────────────────────────

    /** Новая группа ([group] = null) либо правка: имя, цвет, удаление. */
    fun editGroup(owner: PlannerController, group: JSONObject?) {
        val ctx = owner.context()
        val c = Pv.c
        val oldName = group?.optString("name").orEmpty()
        var color = group?.optInt("color", 1) ?: 1
        val sheet = PvSheet.create(ctx, if (group == null) Sx.t("Новая группа", "New group") else oldName)
        val name = input(ctx, oldName, Sx.t("Название группы", "Group name"))
        sheet.add(name)
        val swatches = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        fun paint() {
            swatches.removeAllViews()
            for (i in 1..8) swatches.addView(View(ctx).apply {
                background = Pv.shape(Sx.listColor(i), 0.875f, if (i == color) c.accent else 0, 2f)
                setOnClickListener { color = i; paint() }
            }, LinearLayout.LayoutParams(Pv.rem(1.75f), Pv.rem(1.75f)).apply { rightMargin = Pv.rem(0.5f) })
        }
        paint()
        sheet.add(swatches)
        val error = ctx.pvText("", 0.8125f, c.red).apply { visibility = View.GONE }
        sheet.add(error)
        sheet.add(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            if (group != null) addView(ctx.pvButton(Sx.t("Удалить группу", "Delete group"), "danger") {
                PvSheet.confirm(ctx, Sx.t("Удалить группу", "Delete group"),
                    Sx.t("Удалить группу «$oldName»? Её задачи и события останутся, без группы.", "Delete the group “$oldName”? Its tasks and events stay, without a group."),
                    Sx.t("Удалить", "Delete"), danger = true) { Sx.planner("groupDelete", JSONObject().put("name", oldName)) { sheet.dismiss() } }
            })
            addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
            addView(ctx.pvButton(Sx.t("Сохранить", "Save"), "acc") {
                val n = name.text.toString().trim()
                val done: (Any?) -> Unit = { r ->
                    val err = (r as? JSONObject)?.optString("error").orEmpty()
                    if (err.isNotEmpty()) { error.text = if (err == "duplicate") Sx.t("Такая группа уже есть", "This group already exists") else Sx.t("Нужно название", "Name required"); error.visibility = View.VISIBLE }
                    else sheet.dismiss()
                }
                if (group == null) Sx.planner("groupCreate", JSONObject().put("name", n).put("color", color), done)
                else Sx.planner("groupColor", JSONObject().put("name", oldName).put("color", color)) {
                    if (n != oldName) Sx.planner("groupRename", JSONObject().put("from", oldName).put("name", n), done) else sheet.dismiss()
                }
            })
        })
        sheet.show()
    }

    /** «Добавить в группу»: отметить записи 30 дней и выбрать группу. */
    fun pickGroup(owner: PlannerController, days: JSONObject) {
        val ctx = owner.context()
        val c = Pv.c
        val sheet = PvSheet.create(ctx, Sx.t("Добавить в группу", "Add to group"))
        sheet.add(ctx.pvText(Sx.t("Отметьте записи, которые добавить, и выберите группу.", "Mark the entries to add and choose a group."), 0.875f, c.muted))
        val picks = mutableListOf<Pair<JSONObject, CheckBox>>()
        val seen = HashSet<String>()
        for (i in 0 until 30) {
            val key = Sx.addDays(owner.picked, i)
            val d = days.optJSONObject(key) ?: continue
            Sx.list(d.optJSONArray("timed")).forEach { item ->
                val obj = item.optJSONObject("task") ?: item.optJSONObject("event") ?: return@forEach
                if (!seen.add(obj.optString("id") + key)) return@forEach
                val cb = check(ctx, "${PlannerViews.shortDate(key)} · ${item.optString("start")} ${obj.optString("name")}", false)
                picks += JSONObject().put("kind", if (item.has("task")) "task" else "event").put("id", obj.optString("id")).put("day", key)
                    .put("isRepeat", obj.has("repeat") && !obj.isNull("repeat")) to cb
                sheet.add(cb, 0.25f)
            }
        }
        val withRepeats = check(ctx, Sx.t("Вместе с повторами", "Together with repeats"), true)
        sheet.add(withRepeats)
        sheet.add(ctx.pvButton(Sx.t("Выбрать группу", "Choose group"), "acc", wide = true) {
            val chosen = picks.filter { it.second.isChecked }.map { it.first }
            if (chosen.isEmpty()) return@pvButton
            Sx.planner("lists") { lists ->
                val names = Sx.list(lists as? JSONArray).map { it.optString("name") }
                if (names.isEmpty()) { owner.toastText(Sx.t("Сначала создайте группу", "Create a group first")); return@planner }
                PvSheet.choose(ctx, Sx.t("Группа", "Group"), names) { i ->
                    Sx.planner("groupAssign", JSONObject().put("name", names[i]).put("withRepeats", withRepeats.isChecked).put("picks", JSONArray(chosen))) { sheet.dismiss() }
                }
            }
        })
        sheet.show()
    }

    // ── детали формы ───────────────────────────────────────────────────────────────

    private fun dayLabel(day: String, isTask: Boolean) = if (day.isEmpty()) (if (isTask) Sx.t("Без даты", "No date") else "—") else {
        val c = Sx.calendarOf(day)
        String.format(java.util.Locale.US, "%02d.%02d.%04d", c.get(java.util.Calendar.DAY_OF_MONTH), c.get(java.util.Calendar.MONTH) + 1, c.get(java.util.Calendar.YEAR))
    }

    private fun column(ctx: Context) = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }

    private fun gapLp(rem: Float) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(rem) }

    /** `PlannerCardRow`: значок 1,25 rem слева (отступ сверху 0,6875 rem), поля справа, линия снизу. */
    private fun cardRow(ctx: Context, icon: String, body: View): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(0, Pv.rem(0.5f), 0, Pv.rem(0.5f))
        background = pvBottomLine(Pv.c.panel)
        addView(ctx.pvIcon(icon, Pv.c.muted, 1.25f).apply {
            (layoutParams as LinearLayout.LayoutParams).apply { topMargin = Pv.rem(0.6875f); rightMargin = Pv.rem(0.75f) }
        })
        addView(body, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    /** Подпись 0,75 rem muted над полем (`.input-group > label` «Плана»). */
    private fun labeled(ctx: Context, label: String, field: View): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        addView(ctx.pvText(label, 0.75f, Pv.c.muted), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = Pv.rem(0.25f) })
        addView(field, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun input(ctx: Context, text: String, hint: String, type: Int = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES): EditText =
        PlannerViews.pvInput(ctx, hint, text).apply { inputType = type }

    /** Поле-кнопка (дата/время): рамка line2, радиус 0,5 rem, высота 2,625 rem. */
    private fun pickField(ctx: Context, text: String, onClick: (TextView) -> Unit): TextView = ctx.pvText(text, 0.9375f, Pv.c.fg).apply {
        gravity = Gravity.CENTER_VERTICAL
        minHeight = Pv.rem(2.625f)
        setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
        background = Pv.shape(Pv.c.panel, 0.5f, Pv.c.line2)
        setOnClickListener { onClick(this) }
    }

    /** Выпадающий выбор («Не повторяется ⌄»). */
    private fun selectField(ctx: Context, text: String, onClick: (TextView) -> Unit): TextView = pickField(ctx, text, onClick).apply {
        setCompoundDrawablesRelativeWithIntrinsicBounds(null, null, PvIconDrawable("down", Pv.c.muted, Pv.rem(1.125f)), null)
    }

    private fun check(ctx: Context, text: String, checked: Boolean): CheckBox = CheckBox(ctx).apply {
        this.text = text
        isChecked = checked
        setTextColor(Pv.c.fg)
        textSize = 15f
        typeface = Pv.regular()
        buttonTintList = android.content.res.ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(Pv.c.accent, Pv.c.line2))
    }

    private fun askName(ctx: Context, title: String, initial: String, done: (String) -> Unit) {
        val sheet = PvSheet.create(ctx, title)
        val field = input(ctx, initial, Sx.t("Название", "Name"))
        sheet.add(field)
        sheet.add(ctx.pvButton(Sx.t("Готово", "Done"), "acc", wide = true) {
            field.text.toString().trim().takeIf { it.isNotEmpty() }?.let { sheet.dismiss(); done(it) }
        })
        sheet.show()
        field.requestFocus()
    }

    private fun withScope(ctx: Context, repeating: Boolean, title: String, then: (String) -> Unit) {
        if (!repeating) { then("all"); return }
        val scopes = listOf("this", "following", "all")
        PvSheet.choose(ctx, title, listOf(Sx.t("Только это", "This only"), Sx.t("Это и последующие", "This and following"), Sx.t("Все в серии", "All in series"))) { then(scopes[it]) }
    }

    fun errorText(code: String) = when (code) {
        "name" -> Sx.t("Нужно название", "Name required")
        "minutes" -> Sx.t("Оценка — от 5 минут", "Estimate must be at least 5 minutes")
        "startNeedsDayAndMinutes" -> Sx.t("Для времени начала нужны день и оценка", "A start time needs a day and an estimate")
        "pastMidnight" -> Sx.t("Задача заходит за полночь", "The task runs past midnight")
        "dayAfterDue" -> Sx.t("День позже срока", "The day is after the due date")
        "time" -> Sx.t("Конец раньше начала", "End is before start")
        "budget" -> Sx.t("Бюджет — от 30 минут до 24 часов", "Budget must be between 30 minutes and 24 hours")
        "loading" -> Sx.t("«План» ещё загружается", "The plan is still loading")
        else -> Sx.t("Не сохранено: $code", "Not saved: $code")
    }
}
