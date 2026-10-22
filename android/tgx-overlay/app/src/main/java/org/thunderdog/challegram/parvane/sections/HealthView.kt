package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme

/**
 * Parvane (spec 031, T063): «Здоровье» внутри «Плана» — питание (ккал и БЖУ, клетчатка против цели дня,
 * сахар и соль против предела), вода (+250 мл), сон (ночь, неделя, режим), вес/шаги/пульс/давление/настроение,
 * тренировки недели и активные минуты, записи еды за день (удаление), цели. Сводки — ядро (`health`),
 * запись — «+» (ввод текстом) либо кнопки здесь.
 */
object HealthView {
    private val nutrientNames = linkedMapOf(
        "kcal" to ("Калории" to "Calories"), "protein" to ("Белки" to "Protein"), "fat" to ("Жиры" to "Fat"),
        "carbs" to ("Углеводы" to "Carbs"), "fiber" to ("Клетчатка" to "Fiber"), "water" to ("Вода" to "Water"))

    private fun num(v: Double) = if (v % 1.0 == 0.0) v.toLong().toString() else String.format(java.util.Locale.US, "%.1f", v)

    fun render(body: LinearLayout, owner: PlannerController, day: String, h: JSONObject?) {
        val ctx = body.context
        if (h == null) {
            body.addView(ctx.label(Sx.t("Загрузка…", "Loading…"), 15f, ColorId.textLight).apply { layoutParams = lp(t = Sx.dp(32f), l = Sx.dp(24f)) })
            return
        }
        // питание
        body.addView(ctx.sectionTitle(Sx.t("Питание", "Nutrition")))
        body.addView(ctx.card().apply {
            val nutrients = h.optJSONObject("nutrients") ?: JSONObject()
            nutrientNames.forEach { (key, names) ->
                val n = nutrients.optJSONObject(key) ?: return@forEach
                val value = n.optDouble("value", 0.0)
                val goal = n.optJSONObject("goal")
                val unit = when (key) { "kcal" -> Sx.t("ккал", "kcal"); "water" -> Sx.t("мл", "ml"); else -> Sx.t("г", "g") }
                val row = ctx.hbox().apply { layoutParams = lp(t = Sx.dp(6f)) }
                row.addView(ctx.label(Sx.t(names.first, names.second), 14f).apply { layoutParams = lp(0, weight = 1f) })
                row.addView(ctx.label(if (goal != null) "${num(value)} / ${num(goal.optDouble("target"))} $unit" else "${num(value)} $unit", 14f,
                    when (n.optString("status")) { "above" -> ColorId.textNegative; "ok" -> ColorId.iconPositive; else -> ColorId.text }))
                addView(row)
                if (goal != null && goal.optDouble("target") > 0) addView(ctx.bar(value / goal.optDouble("target"),
                    if (n.optString("status") == "above") ColorId.iconNegative else ColorId.progress))
            }
            val goals = h.optJSONObject("goals") ?: JSONObject()
            listOf("sugar" to ("Сахар" to "Sugar"), "salt" to ("Соль" to "Salt")).forEach { (k, names) ->
                val v = h.optDouble(k, 0.0)
                val max = goals.optDouble("${k}Max", Double.NaN)
                if (v <= 0 && max.isNaN()) return@forEach
                addView(ctx.label("${Sx.t(names.first, names.second)}: ${num(v)}${if (!max.isNaN()) " / ${num(max)}" else ""} ${Sx.t("г", "g")}", 13f,
                    if (!max.isNaN() && v > max) ColorId.textNegative else ColorId.textLight).apply { layoutParams = lp(t = Sx.dp(6f)) })
            }
            val waterRow = ctx.hbox().apply { layoutParams = lp(t = Sx.dp(10f)) }
            waterRow.addView(ctx.chip(Sx.t("+250 мл воды", "+250 ml water"), false) {
                Sx.planner("water", JSONObject().put("day", day).put("add", 250))
            })
            waterRow.addView(ctx.chip(Sx.t("Еда…", "Food…"), false) { foodDialog(owner, day) })
            waterRow.addView(ctx.chip(Sx.t("Цели…", "Goals…"), false) { goalsDialog(owner, nutrients) })
            addView(waterRow)
        })
        val food = Sx.list(h.optJSONArray("food"))
        if (food.isNotEmpty()) {
            body.addView(ctx.sectionTitle(Sx.t("Еда за день", "Food today")))
            food.forEach { f ->
                val row = ctx.hbox().apply {
                    setPadding(Sx.dp(14f), Sx.dp(10f), Sx.dp(14f), Sx.dp(10f))
                    layoutParams = lp(t = Sx.dp(6f), l = Sx.dp(12f), r = Sx.dp(12f))
                    pressable {
                        AlertDialog.Builder(owner.context(), Theme.dialogTheme()).setMessage(f.optString("name"))
                            .setPositiveButton(Sx.t("Удалить", "Delete")) { _, _ ->
                                Sx.planner("removeFood", JSONObject().put("day", day).put("id", f.optString("id")).put("notice", Sx.t("Удалено", "Deleted")))
                            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
                    }
                }
                row.addView(ctx.label(f.optString("name"), 15f, maxLines = 1).apply { layoutParams = lp(0, weight = 1f) })
                row.addView(ctx.label("${num(f.optDouble("kcal", 0.0))} ${Sx.t("ккал", "kcal")}", 14f, ColorId.textLight))
                body.addView(row)
            }
        }
        // сон
        body.addView(ctx.sectionTitle(Sx.t("Сон", "Sleep")))
        body.addView(ctx.card().apply {
            val sleep = h.optJSONObject("sleep")
            if (sleep != null) {
                val mins = sleep.optDouble("value", 0.0).toInt()
                addView(ctx.label(Sx.minutesLabel(mins), 17f, if (h.optBoolean("shortSleep")) ColorId.textNegative else ColorId.text, bold = true))
                val span = listOf(sleep.optString("time"), sleep.optString("endTime")).filter { it.isNotEmpty() }.joinToString("–")
                if (span.isNotEmpty()) addView(ctx.label(span, 13f, ColorId.textLight))
            } else addView(ctx.label(Sx.t("Нет записи. Например: «спал 23:30–7:10»", "No record. E.g.: “slept 23:30–7:10”"), 14f, ColorId.textLight))
            val level = when (h.optString("sleepLevel")) {
                "stable" -> Sx.t("Режим ровный", "Steady schedule")
                "drifting" -> Sx.t("Режим плывёт", "Schedule drifting")
                "broken" -> Sx.t("Режим сбит", "Schedule broken")
                else -> ""
            }
            if (level.isNotEmpty()) addView(ctx.label(level, 13f, ColorId.textLight).apply { layoutParams = lp(t = Sx.dp(4f)) })
            val week = Sx.list(h.optJSONArray("sleepWeek").let { a ->
                org.json.JSONArray().apply { for (i in 0 until (a?.length() ?: 0)) put(a!!.optJSONObject(i) ?: JSONObject()) }
            })
            if (week.any { it.has("value") }) {
                val goal = h.optJSONObject("goals")?.optDouble("sleepMinutes", 480.0) ?: 480.0
                val bars = ctx.hbox().apply { layoutParams = lp(h = Sx.dp(56f), t = Sx.dp(8f)); gravity = android.view.Gravity.BOTTOM }
                week.forEach { r ->
                    val v = r.optDouble("value", 0.0)
                    bars.addView(android.view.View(ctx).apply {
                        background = rounded(Sx.color(if (v in 1.0..359.0) ColorId.iconNegative else ColorId.progress), 3f)
                    }, LinearLayout.LayoutParams(0, (Sx.dp(52f) * (v / (goal * 1.25)).coerceIn(0.04, 1.0)).toInt(), 1f).apply {
                        leftMargin = Sx.dp(3f); rightMargin = Sx.dp(3f)
                    })
                }
                addView(bars)
            }
        })
        // показатели
        body.addView(ctx.sectionTitle(Sx.t("Показатели", "Measurements")))
        body.addView(ctx.card().apply {
            val metrics = h.optJSONObject("metrics") ?: JSONObject()
            val names = linkedMapOf("weight" to Sx.t("Вес", "Weight"), "steps" to Sx.t("Шаги", "Steps"), "pulse" to Sx.t("Пульс", "Pulse"),
                "pressure" to Sx.t("Давление", "Blood pressure"), "mood" to Sx.t("Настроение", "Mood"))
            var any = false
            names.forEach { (key, title) ->
                val m = metrics.optJSONObject(key) ?: return@forEach
                val r = m.optJSONObject("day") ?: m.optJSONObject("latest") ?: return@forEach
                any = true
                val v = if (key == "pressure") "${num(r.optDouble("value"))}/${num(r.optDouble("value2"))}" else num(r.optDouble("value"))
                val when_ = if (m.optJSONObject("day") == null) " (${Sx.dayTitle(r.optString("day"))})" else ""
                val row = ctx.hbox().apply { layoutParams = lp(t = Sx.dp(6f)) }
                row.addView(ctx.label(title, 14f).apply { layoutParams = lp(0, weight = 1f) })
                row.addView(ctx.label(v + when_, 14f, ColorId.textLight))
                addView(row)
            }
            if (!any) addView(ctx.label(Sx.t("Например: «вес 72.5», «шаги 9000», «давление 120/80»", "E.g.: “weight 72.5”, “steps 9000”, “pressure 120/80”"), 14f, ColorId.textLight))
        })
        // тренировки
        val workouts = Sx.list(h.optJSONArray("workouts"))
        body.addView(ctx.sectionTitle(Sx.t("Активность за неделю", "Activity this week")))
        body.addView(ctx.card().apply {
            val goals = h.optJSONObject("goals") ?: JSONObject()
            val active = h.optDouble("activeMinutes", 0.0)
            addView(ctx.label("${Sx.minutesLabel(active.toInt())}${goals.optDouble("activeMinutes", Double.NaN).let { if (it.isNaN()) "" else " / ${Sx.minutesLabel(it.toInt())}" }}", 17f, bold = true))
            goals.optDouble("activeMinutes", Double.NaN).takeIf { !it.isNaN() && it > 0 }?.let { addView(ctx.bar(active / it)) }
            workouts.take(10).forEach { w ->
                addView(ctx.label("${Sx.dayTitle(w.optString("day"))} · ${w.optString("name").ifEmpty { Sx.t("Тренировка", "Workout") }} · ${Sx.minutesLabel(w.optDouble("value").toInt())}",
                    13f, ColorId.textLight).apply { layoutParams = lp(t = Sx.dp(4f)) })
            }
            if (workouts.isEmpty()) addView(ctx.label(Sx.t("Например: «бег 30 мин 5 км»", "E.g.: “run 30 min 5 km”"), 14f, ColorId.textLight).apply { layoutParams = lp(t = Sx.dp(4f)) })
        })
        body.addView(ctx.action(Sx.t("Записать через «+»", "Log with “+”")) { QuickAdd.show(owner) })
    }

    private fun foodDialog(owner: PlannerController, day: String) {
        val ctx = owner.context()
        val form = ctx.vbox(Sx.dp(20f))
        fun field(hint: String, type: Int = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL) = EditText(ctx).apply {
            this.hint = hint; inputType = type
            setTextColor(Sx.color(ColorId.text)); setHintTextColor(Sx.color(ColorId.textPlaceholder))
            form.addView(this, lp())
        }
        val name = field(Sx.t("Название", "Name"), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        val grams = field(Sx.t("Граммы (если значения на 100 г)", "Grams (if values are per 100 g)"))
        val kcal = field(Sx.t("Ккал", "Kcal"))
        val protein = field(Sx.t("Белки, г", "Protein, g"))
        val fat = field(Sx.t("Жиры, г", "Fat, g"))
        val carbs = field(Sx.t("Углеводы, г", "Carbs, g"))
        AlertDialog.Builder(ctx, Theme.dialogTheme()).setTitle(Sx.t("Еда", "Food")).setView(form)
            .setPositiveButton(Sx.t("Добавить", "Add")) { _, _ ->
                val values = JSONObject()
                listOf("kcal" to kcal, "protein" to protein, "fat" to fat, "carbs" to carbs).forEach { (k, f) ->
                    f.text.toString().replace(',', '.').toDoubleOrNull()?.let { values.put(k, it) }
                }
                val g = grams.text.toString().replace(',', '.').toDoubleOrNull()
                if (name.text.isBlank()) return@setPositiveButton
                Sx.planner("food", JSONObject().put("day", day).put("name", name.text.toString().trim()).put("values", values)
                    .put("isPer100", g != null).apply { if (g != null) put("grams", g) }.put("notice", Sx.t("Добавлено", "Added")))
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }

    private fun goalsDialog(owner: PlannerController, nutrients: JSONObject) {
        val ctx = owner.context()
        val form = ctx.vbox(Sx.dp(20f))
        val fields = nutrientNames.mapValues { (key, names) ->
            EditText(ctx).apply {
                hint = Sx.t(names.first, names.second)
                inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
                nutrients.optJSONObject(key)?.optJSONObject("goal")?.optDouble("target")?.let { setText(num(it)) }
                setTextColor(Sx.color(ColorId.text)); setHintTextColor(Sx.color(ColorId.textPlaceholder))
                form.addView(ctx.label(Sx.t(names.first, names.second), 12f, ColorId.textLight), lp(t = Sx.dp(6f)))
                form.addView(this, lp())
            }
        }
        AlertDialog.Builder(ctx, Theme.dialogTheme()).setTitle(Sx.t("Цели на день", "Daily goals"))
            .setView(android.widget.ScrollView(ctx).apply { addView(form) })
            .setPositiveButton(Sx.t("Сохранить", "Save")) { _, _ ->
                val goals = JSONObject()
                fields.forEach { (k, f) ->
                    val v = f.text.toString().replace(',', '.').toDoubleOrNull()
                    goals.put(k, if (v == null || v <= 0) JSONObject.NULL else JSONObject().put("target", v).put("tolerance", if (k == "water") 0 else v * 0.1))
                }
                Sx.planner("goals", JSONObject().put("goals", goals).put("notice", Sx.t("Цели сохранены", "Goals saved")))
            }.setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
    }
}
