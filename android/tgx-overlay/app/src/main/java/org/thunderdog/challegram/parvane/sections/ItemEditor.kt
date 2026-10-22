package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.text.InputType
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme

/**
 * Parvane (spec 031, T061): редактор задачи и события «Плана» — название, день, время начала и конца
 * (у задачи — оценка в минутах), список, описание, повтор (нет / каждый день / неделю / месяц / год, шаг),
 * напоминание, у задачи — статус и шаги. Сохранение и удаление — правками ядра (`save`, `remove`); у
 * повторяющейся записи спрашивается «только этот день / этот и следующие / все» (как web).
 */
object ItemEditor {
    private val repeatKinds = listOf("", "daily", "weekly", "monthly", "yearly")
    private val remindValues = listOf(-1, 0, 5, 10, 15, 30, 60, 120, 1440)

    fun open(owner: PlannerController, kind: String, item: JSONObject?, day: String) {
        val ctx = owner.context()
        val isTask = kind == "task"
        val src = item ?: JSONObject()
        val form = ctx.vbox(Sx.dp(20f))
        fun field(hint: String, value: String, type: Int = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES): EditText =
            EditText(ctx).apply {
                this.hint = hint
                setText(value)
                inputType = type
                setTextColor(Sx.color(ColorId.text))
                setHintTextColor(Sx.color(ColorId.textPlaceholder))
                form.addView(this, lp(t = Sx.dp(4f)))
            }
        fun caption(text: String) = form.addView(ctx.label(text, 12f, ColorId.textLight).apply { layoutParams = lp(t = Sx.dp(10f)) })
        fun picker(initial: String, empty: String, pick: (TextView) -> Unit): TextView = ctx.label(initial.ifEmpty { empty }, 16f, ColorId.textNeutral).apply {
            tag = initial
            setPadding(0, Sx.dp(10f), 0, Sx.dp(10f))
            setOnClickListener { pick(this) }
            form.addView(this, lp())
        }

        val name = field(Sx.t("Название", "Name"), src.optString("name"))
        caption(Sx.t("День", "Day"))
        val itemDay = src.optString("instanceDay").ifEmpty { src.optString("day") }.ifEmpty { day }
        val dayView = picker(itemDay, Sx.t("Без даты", "No date")) { v ->
            val c = Sx.calendarOf((v.tag as String).ifEmpty { Sx.today() })
            DatePickerDialog(ctx, Theme.dialogTheme(), { _, y, m, d ->
                val s = String.format(java.util.Locale.US, "%04d-%02d-%02d", y, m + 1, d)
                v.tag = s; v.text = Sx.dayTitle(s)
            }, c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH), c.get(java.util.Calendar.DAY_OF_MONTH)).apply {
                if (isTask) setButton(DatePickerDialog.BUTTON_NEUTRAL, Sx.t("Без даты", "No date")) { _, _ -> v.tag = ""; v.text = Sx.t("Без даты", "No date") }
            }.show()
        }
        if (itemDay.isNotEmpty()) dayView.text = Sx.dayTitle(itemDay)
        fun timePicker(initial: String, empty: String) = picker(initial, empty) { v ->
            val m = Sx.toMinutes(v.tag as String).takeIf { it >= 0 } ?: (9 * 60)
            TimePickerDialog(ctx, Theme.dialogTheme(), { _, h, mm -> val s = Sx.clock(h * 60 + mm); v.tag = s; v.text = s }, m / 60, m % 60, true).apply {
                setButton(TimePickerDialog.BUTTON_NEUTRAL, Sx.t("Без времени", "No time")) { _, _ -> v.tag = ""; v.text = empty }
            }.show()
        }
        caption(Sx.t("Начало", "Start"))
        val start = timePicker(src.optString("start").takeUnless { src.optBoolean("isAllDay") } ?: "", Sx.t("Без времени", "No time"))
        var end: TextView? = null
        var minutes: EditText? = null
        if (isTask) minutes = field(Sx.t("Оценка, минут", "Estimate, minutes"), src.optInt("minutes").takeIf { it > 0 }?.toString() ?: "", InputType.TYPE_CLASS_NUMBER)
        else {
            caption(Sx.t("Конец", "End"))
            end = timePicker(src.optString("end").takeUnless { src.optBoolean("isAllDay") } ?: "", Sx.t("Без времени", "No time"))
        }
        val project = field(Sx.t("Список", "List"), src.optString("project"))
        val description = field(Sx.t("Описание", "Description"), src.optString("description"),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES).apply { minLines = 2 }
        var steps: EditText? = null
        if (isTask) {
            val lines = Sx.list(src.optJSONArray("steps")).joinToString("\n") { (if (it.optBoolean("isDone")) "[x] " else "") + it.optString("text") }
            steps = field(Sx.t("Шаги — по одному в строке, [x] — сделан", "Steps — one per line, [x] — done"), lines,
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE).apply { minLines = 2 }
        }
        caption(Sx.t("Повтор", "Repeat"))
        val repeat = src.optJSONObject("repeat")
        val repeatSpinner = Spinner(ctx).apply {
            adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, listOf(Sx.t("Не повторять", "Don't repeat"),
                Sx.t("Каждый день", "Daily"), Sx.t("Каждую неделю", "Weekly"), Sx.t("Каждый месяц", "Monthly"), Sx.t("Каждый год", "Yearly")))
            setSelection(repeatKinds.indexOf(repeat?.optString("kind") ?: "").coerceAtLeast(0))
            form.addView(this, lp())
        }
        val interval = field(Sx.t("Шаг повтора (1 — каждый)", "Repeat every (1 = each)"), (repeat?.optInt("interval", 1) ?: 1).toString(), InputType.TYPE_CLASS_NUMBER)
        caption(Sx.t("Напомнить", "Remind"))
        val remindSpinner = Spinner(ctx).apply {
            adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, remindValues.map { v ->
                when (v) {
                    -1 -> Sx.t("Не напоминать", "No reminder")
                    0 -> Sx.t("В момент начала", "At start")
                    1440 -> Sx.t("За день", "1 day before")
                    else -> Sx.t("За ${Sx.minutesLabel(v)}", "${Sx.minutesLabel(v)} before")
                }
            })
            setSelection(remindValues.indexOf(if (src.has("remind")) src.optInt("remind") else -1).coerceAtLeast(0))
            form.addView(this, lp())
        }
        var statusSpinner: Spinner? = null
        if (isTask) {
            caption(Sx.t("Статус", "Status"))
            statusSpinner = Spinner(ctx).apply {
                adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item,
                    listOf(Sx.t("В очереди", "Queued"), Sx.t("В работе", "In progress"), Sx.t("Выполнено", "Done")))
                setSelection(listOf("queue", "active", "done").indexOf(src.optString("status", "queue")).coerceAtLeast(0))
                form.addView(this, lp())
            }
        }

        val id = src.optString("id")
        val repeating = repeat != null
        val dialog = AlertDialog.Builder(ctx, Theme.dialogTheme())
            .setTitle(if (id.isEmpty()) (if (isTask) Sx.t("Новая задача", "New task") else Sx.t("Новое событие", "New event"))
                else (if (isTask) Sx.t("Задача", "Task") else Sx.t("Событие", "Event")))
            .setView(ScrollView(ctx).apply { addView(form, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)) })
            .setPositiveButton(Sx.t("Сохранить", "Save"), null)
            .setNegativeButton(Sx.t("Отмена", "Cancel"), null)
        if (id.isNotEmpty()) dialog.setNeutralButton(Sx.t("Удалить", "Delete"), null)
        val shown = dialog.show()

        fun collect(): JSONObject {
            val out = JSONObject().put("name", name.text.toString().trim())
            if (id.isNotEmpty()) out.put("id", id)
            val d = dayView.tag as String
            val s = start.tag as String
            if (isTask) {
                out.put("day", if (d.isEmpty()) JSONObject.NULL else d)
                out.put("start", if (s.isEmpty()) JSONObject.NULL else s)
                out.put("minutes", minutes!!.text.toString().toIntOrNull()?.takeIf { it > 0 } ?: JSONObject.NULL)
                out.put("status", listOf("queue", "active", "done")[statusSpinner!!.selectedItemPosition])
                out.put("project", project.text.toString().trim())
                out.put("description", description.text.toString())
                out.put("steps", JSONArray(steps!!.text.lines().filter { it.isNotBlank() }.map { line ->
                    val doneMark = line.trimStart().startsWith("[x]", ignoreCase = true)
                    JSONObject().put("text", line.trimStart().removePrefix("[x]").removePrefix("[X]").trim()).put("isDone", doneMark)
                }))
            } else {
                val e = end!!.tag as String
                out.put("day", if (d.isEmpty()) Sx.today() else d)
                if (s.isEmpty() && e.isEmpty()) {
                    out.put("isAllDay", true); out.put("start", "00:00"); out.put("end", "23:59")
                } else {
                    out.put("isAllDay", false)
                    out.put("start", s.ifEmpty { "09:00" })
                    out.put("end", e.ifEmpty { Sx.clock(Sx.toMinutes(s.ifEmpty { "09:00" }) + 60) })
                }
                out.put("description", description.text.toString())
                if (project.text.isNotBlank()) out.put("project", project.text.toString().trim())
            }
            val kindIdx = repeatSpinner.selectedItemPosition
            if (kindIdx == 0) out.put("repeat", JSONObject.NULL)
            else {
                val base = repeat ?: JSONObject()
                val r = JSONObject().put("kind", repeatKinds[kindIdx])
                    .put("interval", interval.text.toString().toIntOrNull()?.coerceIn(1, 99) ?: 1)
                    .put("startDay", base.optString("startDay").ifEmpty { d.ifEmpty { Sx.today() } })
                if (repeatKinds[kindIdx] == "weekly") r.put("weekdays", base.optJSONArray("weekdays")
                    ?: JSONArray().put(Sx.calendarOf(d.ifEmpty { Sx.today() }).get(java.util.Calendar.DAY_OF_WEEK) - 1))
                if (repeatKinds[kindIdx] == "monthly") r.put("monthDay", base.optInt("monthDay",
                    Sx.calendarOf(d.ifEmpty { Sx.today() }).get(java.util.Calendar.DAY_OF_MONTH)))
                if (base.has("endDay")) r.put("endDay", base.opt("endDay"))
                if (base.has("count")) r.put("count", base.opt("count"))
                out.put("repeat", r)
            }
            val rm = remindValues[remindSpinner.selectedItemPosition]
            out.put("remind", if (rm < 0) JSONObject.NULL else rm)
            return out
        }

        fun withScope(title: String, then: (String) -> Unit) {
            if (!repeating) { then("all"); return }
            val scopes = listOf("this", "following", "all")
            AlertDialog.Builder(ctx, Theme.dialogTheme()).setTitle(title)
                .setItems(arrayOf(Sx.t("Только этот день", "This day only"), Sx.t("Этот и следующие", "This and following"),
                    Sx.t("Все повторы", "All repeats"))) { _, which -> then(scopes[which]) }
                .show()
        }

        shown.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val data = collect()
            if (data.optString("name").isEmpty()) { name.error = Sx.t("Нужно название", "Name required"); return@setOnClickListener }
            withScope(Sx.t("Изменить повторяющуюся запись", "Edit repeating item")) { scope ->
                Sx.planner("save", JSONObject().put("kind", kind).put("item", data).put("scope", scope)
                    .put("day", if (repeating) day else "")) { r ->
                    val err = (r as? JSONObject)?.optString("error").orEmpty()
                    if (err.isNotEmpty()) org.thunderdog.challegram.tool.UI.showToast(errorText(err), android.widget.Toast.LENGTH_LONG)
                    else shown.dismiss()
                }
            }
        }
        shown.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener {
            withScope(Sx.t("Удалить повторяющуюся запись", "Delete repeating item")) { scope ->
                Sx.planner("remove", JSONObject().put("kind", kind).put("id", id).put("day", if (repeating) day else "").put("scope", scope)
                    .put("notice", Sx.t("Удалено", "Deleted"))) { shown.dismiss() }
            }
        }
    }

    fun errorText(code: String) = when (code) {
        "name" -> Sx.t("Нужно название", "Name required")
        "minutes" -> Sx.t("Оценка — от 5 минут", "Estimate must be at least 5 minutes")
        "startNeedsDayAndMinutes" -> Sx.t("Для времени начала нужны день и оценка", "A start time needs a day and an estimate")
        "pastMidnight" -> Sx.t("Задача заходит за полночь", "The task runs past midnight")
        "dayAfterDue" -> Sx.t("День позже срока", "The day is after the due date")
        "time" -> Sx.t("Конец раньше начала", "End is before start")
        "loading" -> Sx.t("«План» ещё загружается", "The plan is still loading")
        else -> Sx.t("Не сохранено: $code", "Not saved: $code")
    }
}
