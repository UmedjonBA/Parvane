package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneSections

/**
 * Parvane (spec 032): «Здоровье» 1:1 с телефонной версией web (`PlannerHealth.tsx`): «Всё вводится текстом» с
 * примерами, «Питание» (ккал, закрыть день, БЖУ, клетчатка, сахар и соль, приёмы пищи), «Вода» и «Тело» (вес за три
 * недели, давление, пульс, самочувствие), «Сон» (сны дня, строка сна, неделя столбиками, «Режим сна» за две недели),
 * «Активность» (шаги, активные минуты, тренировки, шаги неделей), «Калории за неделю». Сводки — операция ядра
 * `health`; правки — операции ядра, отметка «день закрыт» и сны других дней — новым состоянием «Плана».
 * Строка даты над экраном — у `PlannerController`.
 */
object HealthView {
    private const val GLASS_ML = 250
    private const val BOTTLE_ML = 500
    private const val SHORT_SLEEP = 360.0
    private const val ROUTINE_DAYS = 14
    private const val ROUTINE_MIN_NIGHTS = 4
    private const val WEIGHT_DAYS = 21

    /** Состояние «Плана» (web-JSON) из последнего снимка — для данных, которых нет в сводке `health`. */
    private fun state(): JSONObject? = (Sx.last("planner") ?: ParvaneSections.snapshot("planner"))?.optJSONObject("state")

    fun render(container: LinearLayout, owner: SectionController, day: String, data: JSONObject?,
               onExample: (String) -> Unit, onSettings: () -> Unit, onDay: (String) -> Unit) {
        val ctx = container.context
        if (data == null) {
            container.addView(MascotView(ctx), LinearLayout.LayoutParams(Pv.rem(4f), Pv.rem(4f)).apply {
                gravity = Gravity.CENTER_HORIZONTAL; topMargin = Pv.rem(2.5f)
            })
            return
        }
        val st = state()
        val goals = data.optJSONObject("goals") ?: JSONObject()
        val healthGoals = st?.optJSONObject("healthGoals") ?: JSONObject()
        val week = (0 until (data.optJSONArray("week")?.length() ?: 0)).map { data.getJSONArray("week").getString(it) }
        val weekLabels = week.map { Hk.weekdayOf(it) }
        val current = week.indexOf(day)
        fun add(view: View) = container.addView(view, lpTop(if (container.childCount == 0) 0f else 1f))

        add(hintCard(ctx, onExample, onSettings))
        add(nutritionCard(ctx, day, data, healthGoals, st))
        add(waterBodyCard(ctx, day, data, healthGoals, st, onExample))
        add(sleepCard(ctx, owner, day, data, goals, healthGoals, st, week, weekLabels, current, onExample, onDay))
        add(activityCard(ctx, data, goals, weekLabels, current, onExample))
        add(kcalWeekCard(ctx, day, data, week, weekLabels, current))
    }

    // ── «Всё вводится текстом» ────────────────────────────────────────────────────

    private fun hintCard(ctx: Context, onExample: (String) -> Unit, onSettings: () -> Unit) = ctx.hkCard().apply {
        addView(ctx.hkHead(Sx.t("Всё вводится текстом", "Everything is entered as text"),
            ctx.hkGhost("sliders", Sx.t("Цели", "Goals"), onSettings)))
        addView(ctx.hkText(Sx.t("Еда с КБЖУ, вода, вес, давление, шаги и сами цели — одной строкой через «+». Нажмите пример, чтобы попробовать.",
            "Meals with nutrients, water, weight, pressure, steps and the goals themselves go in as one line via «+». Tap an example to try it.")))
        val flow = HkFlow(ctx)
        examples().forEach { text -> flow.addView(ctx.hkChip(text) { onExample("$text ") }) }
        addView(flow)
    }

    private fun examples(): List<String> = Sx.t(
        "обед гречка 150г б30 ж10 у60 кл6 520 ккал | вода 500 мл | вес 72,4 | давление 120/80 | шаги 9500 | самочувствие 4 | сон 23:40-07:30 | бег 5 км 28 мин | цель белок 140 вода 2,5л",
        "lunch buckwheat 150g p30 f10 c60 fiber 6 520 kcal | water 500 ml | weight 72.4 | bp 120/80 | steps 9500 | mood 4 | sleep 23:40-07:30 | run 5 km 28 min | goal protein 140 water 2.5l",
    ).split("|").map { it.trim() }.filter { it.isNotEmpty() }

    // ── «Питание» ─────────────────────────────────────────────────────────────────

    private class Macro(val key: String, val ru: String, val en: String, val color: () -> Int)

    private val macros = listOf(
        Macro("protein", "Белки", "Protein") { Pv.c.sleep },
        Macro("fat", "Жиры", "Fat") { Pv.c.note },
        Macro("carbs", "Углеводы", "Carbs") { Pv.c.food },
        Macro("fiber", "Клетчатка", "Fiber") { Pv.c.workout },
    )

    private fun nutritionCard(ctx: Context, day: String, data: JSONObject, healthGoals: JSONObject, st: JSONObject?) = ctx.hkCard().apply {
        val c = Pv.c
        val nutrients = data.optJSONObject("nutrients") ?: JSONObject()
        val kcalObj = nutrients.optJSONObject("kcal")
        val kcal = kcalObj?.optDouble("value", 0.0) ?: 0.0
        val kcalGoal = Hk.optNum(kcalObj?.optJSONObject("goal"), "target")?.takeIf { it > 0 }
        val over = kcalGoal != null && kcal > kcalGoal
        addView(ctx.hkHead(Sx.t("Питание", "Nutrition"),
            *listOfNotNull(kcalGoal?.let { ctx.hkNote(Sx.t("цель ${Hk.number(it)}", "goal ${Hk.number(it)}")) }).toTypedArray()))
        addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.BOTTOM
            addView(big(ctx, Hk.number(kcal), if (over) c.red else c.food))
            val rest = if (kcalGoal == null) "" else " · " + if (over) Sx.t("перебор ${Hk.number(kcal - kcalGoal)}", "${Hk.number(kcal - kcalGoal)} over")
                else Sx.t("осталось ${Hk.number(kcalGoal - kcal)}", "${Hk.number(kcalGoal - kcal)} left")
            addView(ctx.pvText(Sx.t("ккал", "kcal") + rest, 0.9375f, c.muted), LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = Pv.rem(0.5f) })
        })
        addView(HkProg(ctx, Hk.share(kcal, kcalGoal), if (over) c.red else c.food, thick = true))
        // «Закрыть день питания»: отметка дня в состоянии «Плана» (`nutrition[day].isComplete`)
        val isClosed = st?.optJSONObject("nutrition")?.optJSONObject(day)?.optBoolean("isComplete") == true
        addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = Pv.rem(2.75f)
            setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
            addView(HkCheck(ctx, isClosed, c.green))
            addView(ctx.pvText(if (isClosed) Sx.t("День питания закрыт — итог учтён в статистике", "Nutrition day closed — the total counts in statistics")
                else Sx.t("Закрыть день питания", "Close the nutrition day"), 0.9375f, c.fg), LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Pv.rem(0.75f) })
            Pv.pressable(this, 0, 0.5f) {
                editState(if (isClosed) Sx.t("День питания открыт снова", "Nutrition day reopened") else Sx.t("День питания закрыт", "Nutrition day closed")) { s ->
                    val nutrition = s.optJSONObject("nutrition") ?: JSONObject().also { s.put("nutrition", it) }
                    val rec = nutrition.optJSONObject(day) ?: JSONObject().put("entries", JSONArray()).also { nutrition.put(day, it) }
                    rec.put("isComplete", !isClosed)
                }
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = -Pv.rem(0.625f); rightMargin = -Pv.rem(0.625f)
        })
        // БЖУ и клетчатка против целей, сахар и соль против предела
        val rows = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        macros.forEach { m ->
            val n = nutrients.optJSONObject(m.key)
            val v = n?.optDouble("value", 0.0) ?: 0.0
            val g = Hk.optNum(n?.optJSONObject("goal"), "target")?.takeIf { it > 0 }
            rows.addView(macroRow(ctx, Sx.t(m.ru, m.en), Hk.number(v), if (g != null) " / ${Hk.number(g)} ${Sx.t("г", "g")}" else " ${Sx.t("г", "g")}",
                Hk.share(v, g), m.color(), false), lpTop(if (rows.childCount == 0) 0f else 0.5f))
        }
        listOf(Triple("sugar", Sx.t("Сахар", "Sugar"), "sugarMax"), Triple("salt", Sx.t("Соль", "Salt"), "saltMax")).forEach { (key, label, goalKey) ->
            val v = data.optDouble(key, 0.0).takeIf { !it.isNaN() } ?: 0.0
            val limit = Hk.optNum(healthGoals, goalKey)?.takeIf { it > 0 }
            val tone = if (key == "sugar") c.metric else c.task
            rows.addView(macroRow(ctx, label, Hk.number(v, 1), if (limit != null) " ≤ ${Hk.number(limit, 1)} ${Sx.t("г", "g")}" else " ${Sx.t("г", "g")}",
                Hk.share(v, limit), if (limit != null && v > limit) c.red else tone, limit != null && v > limit), lpTop(0.5f))
        }
        addView(rows)
        val food = Hk.objects(data.optJSONArray("food")).filterNotNull().sortedBy { it.optString("time").ifEmpty { "99" } }
        val list = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        if (food.isEmpty()) list.addView(ctx.hkText(Sx.t("Приёмов пищи пока нет", "No meals yet"), sizeRem = 0.9375f))
        food.forEach { list.addView(mealRow(ctx, day, it)) }
        addView(list)
    }

    private fun big(ctx: Context, text: String, color: Int): TextView =
        ctx.pvText(text, 2.125f, color, semibold = true, mono = true).apply { setLineSpacing(0f, 1f) }

    /** `.macroRow`: 5,25 rem название · 6,5 rem «значение / цель» · полоса. */
    private fun macroRow(ctx: Context, label: String, value: String, goalPart: String, fraction: Double, color: Int, red: Boolean) =
        LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(ctx.pvText(label, 0.875f, Pv.c.muted, maxLines = 1), LinearLayout.LayoutParams(Pv.rem(5.25f), ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(ctx.pvText(android.text.SpannableStringBuilder().apply {
                append(value)
                val start = length
                append(goalPart)
                setSpan(android.text.style.ForegroundColorSpan(Pv.c.muted), start, length, 0)
            }, 0.875f, if (red) Pv.c.red else Pv.c.fg, mono = true, maxLines = 1),
                LinearLayout.LayoutParams(Pv.rem(6.5f), ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = Pv.rem(0.625f) })
            addView(HkProg(ctx, fraction, color), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Pv.rem(0.625f) })
        }

    private val mealNames = mapOf("breakfast" to ("Завтрак" to "Breakfast"), "lunch" to ("Обед" to "Lunch"), "dinner" to ("Ужин" to "Dinner"),
        "snack" to ("Перекусы" to "Snacks"), "other" to ("Другие записи" to "Other"))

    private fun mealRow(ctx: Context, day: String, e: JSONObject) = row(ctx).apply {
        addView(ctx.pvText(e.optString("time"), 0.8125f, Pv.c.muted, mono = true), LinearLayout.LayoutParams(Pv.rem(2.875f), ViewGroup.LayoutParams.WRAP_CONTENT))
        val meal = mealNames[e.optString("meal")] ?: mealNames.getValue("other")
        val p = Hk.optNum(e, "protein"); val f = Hk.optNum(e, "fat"); val cb = Hk.optNum(e, "carbs"); val fiber = Hk.optNum(e, "fiber")
        val macrosText = if (p != null || f != null || cb != null) Sx.t("Б${Hk.number(p ?: 0.0)} Ж${Hk.number(f ?: 0.0)} У${Hk.number(cb ?: 0.0)}",
            "P${Hk.number(p ?: 0.0)} F${Hk.number(f ?: 0.0)} C${Hk.number(cb ?: 0.0)}") else null
        val sub = listOfNotNull(macrosText, fiber?.let { Sx.t("кл ${Hk.number(it)}", "fiber ${Hk.number(it)}") }).joinToString(" · ")
            .ifEmpty { Sx.t("КБЖУ не указаны", "No nutrients") }
        addView(body(ctx, "${Sx.t(meal.first, meal.second)}: ${e.optString("name")}", sub, subMono = true))
        addView(meta(ctx, Hk.number(e.optDouble("kcal", 0.0))))
        addView(smallIb(ctx, "x", Sx.t("Удалить запись", "Delete record")) {
            Sx.planner("removeFood", JSONObject().put("day", day).put("id", e.optString("id")).put("notice", Sx.t("Запись удалена", "Record deleted")))
        })
    }

    // ── «Вода» и «Тело» ───────────────────────────────────────────────────────────

    private fun waterBodyCard(ctx: Context, day: String, data: JSONObject, healthGoals: JSONObject, st: JSONObject?,
                              onExample: (String) -> Unit) = ctx.hkCard().apply {
        val c = Pv.c
        val water = data.optJSONObject("nutrients")?.optJSONObject("water")
        val waterMl = water?.optDouble("value", 0.0) ?: 0.0
        val waterGoal = Hk.optNum(water?.optJSONObject("goal"), "target")?.takeIf { it > 0 }
        val litres = { ml: Double -> Sx.t("${Hk.number(ml / 1000, 1)} л", "${Hk.number(ml / 1000, 1)} l") }
        addView(ctx.hkHead(Sx.t("Вода", "Water"), *listOfNotNull(waterGoal?.let { ctx.hkNote(Sx.t("цель ${litres(it)}", "goal ${litres(it)}")) }).toTypedArray()))
        addView(valueButton(ctx, Hk.number(waterMl / 1000, 2), Sx.t("л", "l"), c.event) { onExample(Sx.t("вода 300 мл", "water 300 ml")) })
        addView(HkProg(ctx, Hk.share(waterMl, waterGoal), c.event, thick = true))
        addView(HkFlow(ctx).apply {
            listOf(GLASS_ML to Sx.t("+ стакан 250", "+ glass 250"), BOTTLE_ML to Sx.t("+ бутылка 500", "+ bottle 500")).forEach { (ml, text) ->
                addView(ctx.hkChip(text) {
                    Sx.planner("water", JSONObject().put("day", day).put("add", ml).put("notice", Sx.t("Добавлено: $ml мл", "Added: $ml ml")))
                })
            }
        })
        // «Тело»: вес (последний и изменение за неделю), график трёх недель, давление, пульс, самочувствие
        val weights = weightSeries(st, day)
        val latest = weights.lastOrNull { it != null }
        val metrics = data.optJSONObject("metrics") ?: JSONObject()
        val latestWeight = metrics.optJSONObject("weight")?.optJSONObject("latest")
        val weightGoal = Hk.optNum(healthGoals, "weight")?.takeIf { it > 0 }
        addView(ctx.hkHead(Sx.t("Тело", "Body"),
            *listOfNotNull(weightGoal?.let { ctx.hkNote(Sx.t("цель ${Hk.number(it, 1)} кг", "goal ${Hk.number(it, 1)} kg")) }).toTypedArray()),
            lpTop(1.25f))
        val change = latestWeight?.let { w -> weightBefore(st, w.optString("day"))?.let { w.optDouble("value") - it } }
        val unit = Sx.t("кг", "kg") + (change?.let { " · " + Sx.t("${if (it > 0) "+" else ""}${Hk.number(it, 1)} за неделю",
            "${if (it > 0) "+" else ""}${Hk.number(it, 1)} in a week") } ?: "")
        addView(valueButton(ctx, latestWeight?.let { Hk.number(it.optDouble("value"), 1) } ?: "—", unit, c.workout) {
            onExample(Sx.t("вес 72,4", "weight 72.4"))
        })
        if (latest == null) addView(ctx.hkText(Sx.t("Нет записей", "No records"), sizeRem = 0.9375f))
        else addView(HealthWeightSpark(ctx, weights, weightGoal))
        val pressure = metrics.optJSONObject("pressure")?.optJSONObject("latest")
        val pulse = metrics.optJSONObject("pulse")?.optJSONObject("latest")
        val mood = metrics.optJSONObject("mood")?.optJSONObject("day")
        addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            listOf(
                Triple(Sx.t("Давление", "Pressure"), pressure?.let { "${Hk.number(it.optDouble("value"))}/${Hk.number(it.optDouble("value2", 0.0))}" },
                    Sx.t("давление 120/80", "pressure 120/80")),
                Triple(Sx.t("Пульс", "Pulse"), pulse?.let { Sx.t("${Hk.number(it.optDouble("value"))} уд/мин", "${Hk.number(it.optDouble("value"))} bpm") },
                    Sx.t("пульс 64", "pulse 64")),
                Triple(Sx.t("Самочувствие", "Mood"), mood?.let { Hk.number(it.optDouble("value")) }, Sx.t("самочувствие 4", "mood 4")),
            ).forEachIndexed { i, (label, value, example) ->
                addView(fact(ctx, label, value, i == 2) { onExample(example) }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    if (i > 0) leftMargin = Pv.rem(0.5f)
                })
            }
        })
    }

    /** Кнопка значения (`.healthBig` + `.healthValueButton`): крупное число цвета вида и подпись. */
    private fun valueButton(ctx: Context, value: String, unit: String, color: Int, onClick: () -> Unit) = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.BOTTOM
        addView(big(ctx, value, color))
        addView(ctx.pvText(unit, 0.9375f, Pv.c.muted), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = Pv.rem(0.5f) })
        isClickable = true
        setOnClickListener { onClick() }
    }

    /** `.healthFact`: плитка на фоне панели, подпись 0,75 rem, значение моноширинным. */
    private fun fact(ctx: Context, label: String, value: String?, accent: Boolean, onClick: () -> Unit) = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(Pv.rem(0.75f), Pv.rem(0.625f), Pv.rem(0.75f), Pv.rem(0.625f))
        addView(ctx.pvText(label, 0.75f, Pv.c.muted, maxLines = 1))
        addView(ctx.pvText(value ?: "—", 0.9375f, if (value == null) Pv.c.faint else if (accent) Pv.c.note else Pv.c.fg, semibold = true, mono = true, maxLines = 1),
            lpTop(0.125f))
        Pv.pressable(this, Pv.c.panel, 0.75f, onClick = onClick)
    }

    /** Вес за три недели по дням (последняя запись дня), из состояния «Плана». */
    private fun weightSeries(st: JSONObject?, day: String): List<Double?> {
        val days = (WEIGHT_DAYS - 1 downTo 0).map { Sx.addDays(day, -it) }
        val byDay = HashMap<String, Double>()
        Hk.objects(st?.optJSONArray("health")).filterNotNull().filter { it.optString("kind") == "weight" }.forEach { r ->
            if (r.optString("day") in days) byDay[r.optString("day")] = r.optDouble("value")
        }
        return days.map { byDay[it] }
    }

    /** Вес, записанный не позже чем за неделю до [day] (для «за неделю»). */
    private fun weightBefore(st: JSONObject?, day: String): Double? {
        if (day.isEmpty()) return null
        val limit = Sx.addDays(day, -7)
        return Hk.objects(st?.optJSONArray("health")).filterNotNull()
            .filter { it.optString("kind") == "weight" && it.optString("day") <= limit }
            .maxByOrNull { it.optString("day") }?.optDouble("value")
    }

    // ── «Сон» ─────────────────────────────────────────────────────────────────────

    private fun sleepCard(ctx: Context, owner: SectionController, day: String, data: JSONObject, goals: JSONObject, healthGoals: JSONObject,
                          st: JSONObject?, week: List<String>, weekLabels: List<String>, current: Int,
                          onExample: (String) -> Unit, onDay: (String) -> Unit) = ctx.hkCard().apply {
        val c = Pv.c
        val sleep = data.optJSONObject("sleep")
        val records = Hk.objects(data.optJSONArray("sleepRecords")).filterNotNull()
        val series = Hk.objects(data.optJSONArray("sleepWeek")).map { r -> r?.optDouble("value")?.takeIf { !it.isNaN() } }
        val known = series.filterNotNull()
        val sleepGoal = Hk.optNum(goals, "sleepMinutes")?.takeIf { it > 0 }
        addView(ctx.hkHead(Sx.t("Сон", "Sleep"), *listOfNotNull(known.takeIf { it.isNotEmpty() }?.let {
            ctx.hkNote(Sx.t("ср. ${Hk.span(it.average())}", "avg ${Hk.span(it.average())}"))
        }).toTypedArray()))
        var editingId: String? = null
        val formSlot = FrameLayout(ctx)
        fun buildForm(fill: String?) {
            formSlot.removeAllViews()
            val form = ctx.hkTextForm(Sx.t("23:40-07:30 или 7,5 ч", "23:40-07:30 or 7.5 h"),
                if (editingId != null) Sx.t("Сохранить", "Save") else Sx.t("Добавить", "Add"), accent = false, fill = fill) { text, done ->
                submitSleep(day, text, editingId) { ok ->
                    if (ok) { editingId = null; done(true) } else {
                        org.thunderdog.challegram.tool.UI.showToast(Sx.t("Не распознано. Пример: 23:40-07:30", "Not recognised. Example: 23:40-07:30"), android.widget.Toast.LENGTH_SHORT)
                        done(false)
                    }
                }
            }
            formSlot.addView(form)
        }
        if (sleep != null) {
            val value = sleep.optDouble("value", 0.0)
            addView(big(ctx, Hk.span(value), if (value < SHORT_SLEEP) c.red else c.sleep))
            records.forEach { r ->
                addView(LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, Pv.rem(0.125f), 0, Pv.rem(0.125f))
                    background = pvBottomLine(c.raised)
                    val time = r.optString("time"); val end = r.optString("endTime")
                    addView(ctx.pvText(if (time.isNotEmpty() && end.isNotEmpty()) "$time → $end" else "—", 0.875f, c.fg, mono = true))
                    addView(ctx.pvText(Hk.span(r.optDouble("value", 0.0)), 0.9375f, c.muted), LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = Pv.rem(0.5f) })
                    addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
                    addView(ctx.pvIconButton("edit", Sx.t("Изменить", "Edit"), c.muted) {
                        editingId = r.optString("id")
                        buildForm(if (time.isNotEmpty() && end.isNotEmpty()) "$time–$end"
                            else Sx.t("${Hk.number(r.optDouble("value") / 60, 2)} ч", "${Hk.number(r.optDouble("value") / 60, 2)} h"))
                    })
                    addView(ctx.pvIconButton("trash", Sx.t("Удалить", "Delete"), c.muted) {
                        Sx.planner("removeHealth", JSONObject().put("id", r.optString("id")).put("notice", Sx.t("Сон удалён", "Sleep deleted")))
                    })
                })
            }
        } else {
            addView(ctx.pvButton(Sx.t("Записать сон за эту ночь", "Record sleep for last night")) { onExample(Sx.t("сон 23:30-07:30", "sleep 23:30-07:30")) })
        }
        buildForm(null)
        addView(formSlot)
        addView(HkBars(ctx, series, weekLabels, current, c.sleep, sleepGoal, { Hk.span(it) }, { it < SHORT_SLEEP }))
        addView(ctx.hkText(Sx.t("Меньше 6 ч сна — бюджет дня в календаре снижается на 20%.", "Less than 6 h of sleep cuts the day budget in the calendar by 20%.")))
        addView(routine(ctx, day, data, healthGoals, st, onExample, onDay))
    }

    /** Сон дня строкой: сегодня — как есть, вчера — «вчера …»; правка — прежний сон удаляется, новый добавляется. */
    private fun submitSleep(day: String, text: String, replaceId: String?, done: (Boolean) -> Unit) {
        val today = Sx.today()
        val prefix = when (day) {
            today -> ""
            Sx.addDays(today, -1) -> Sx.t("вчера ", "yesterday ")
            Sx.addDays(today, -2) -> Sx.t("позавчера ", "the day before yesterday ")
            else -> ""
        }
        val line = prefix + Sx.t("спал ", "slept ") + text.trim()
        Sx.planner("quickParse", JSONObject().put("text", line).put("kind", "sleep")) { r ->
            val draft = r as? JSONObject
            if (draft == null || draft.optString("error").isNotEmpty() || draft.optString("kind") != "sleep") { done(false); return@planner }
            val add = {
                Sx.planner("quickAdd", JSONObject().put("text", line).put("kind", "sleep")
                    .put("notice", if (replaceId != null) Sx.t("Сон изменён", "Sleep updated") else Sx.t("Добавлено: сон", "Added: sleep"))) { res ->
                    done((res as? JSONObject)?.optString("error").isNullOrEmpty())
                }
            }
            if (replaceId != null) Sx.planner("removeHealth", JSONObject().put("id", replaceId)) { add() } else add()
        }
    }

    /** «Режим сна»: уровень плашкой, подсказка либо график двух недель с выбором дня. */
    private fun routine(ctx: Context, day: String, data: JSONObject, healthGoals: JSONObject, st: JSONObject?,
                        onExample: (String) -> Unit, onDay: (String) -> Unit) = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        val c = Pv.c
        val level = data.optString("sleepLevel", "none").ifEmpty { "none" }
        val (label, tone) = when (level) {
            "stable" -> Sx.t("Стабильный", "Stable") to c.green
            "drifting" -> Sx.t("Плавает", "Drifting") to c.yellow
            "broken" -> Sx.t("Сбит", "Off track") to c.red
            else -> Sx.t("Мало данных", "Not enough data") to c.muted
        }
        val bed = Hk.optNum(healthGoals, "bedtime")?.takeIf { it >= 0 && it < 1440 }
        val wake = Hk.optNum(healthGoals, "wakeTime")?.takeIf { it >= 0 && it < 1440 }
        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = Pv.rem(2.25f)
            addView(ctx.hkTitle(Sx.t("Режим сна", "Sleep routine"), 0.75f), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (bed != null && wake != null) addView(ctx.hkNote(Sx.t("цель ${Hk.clock(bed)}–${Hk.clock(wake)}", "goal ${Hk.clock(bed)}–${Hk.clock(wake)}")),
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = Pv.rem(0.5f) })
            addView(ctx.hkTag(label, tone))
        }
        addView(head, lpTop(0.75f))
        val days = (ROUTINE_DAYS - 1 downTo 0).map { Sx.addDays(day, -it) }
        val sleeps = Hk.objects(st?.optJSONArray("health")).filterNotNull().filter { it.optString("kind") == "sleep" && it.optString("day") in days }
        val timed = days.count { d -> sleeps.any { it.optString("day") == d && it.optString("time").isNotEmpty() && it.optString("endTime").isNotEmpty() } }
        if (level == "none") addView(ctx.hkText(Sx.t("Записывайте сон со временем: «сон 23:40-07:30». Есть $timed из $ROUTINE_MIN_NIGHTS ночей.",
            "Record sleep with times, like «sleep 23:40-07:30» — $timed of $ROUTINE_MIN_NIGHTS nights so far.")), lpTop(0.875f))
        if (sleeps.isNotEmpty()) {
            val detail = ctx.hkText("")
            val chart = HealthRoutineChart(ctx, days, day, sleeps, bed, wake) { picked -> detail.text = sleepDetail(picked, sleeps) }
            addView(chart, lpTop(0.875f))
            detail.text = sleepDetail(day, sleeps)
            addView(detail, lpTop(0.875f))
            addView(ctx.pvText(Sx.t("Столбик — сон от отхода до подъёма: яркий — основной сон дня, бледный — дневной. Нажмите на день — под графиком появится время. Сплошные линии — среднее, пунктир — цель, точка — сон без времени.",
                "A bar is a sleep from bedtime to wake-up: bright is the main sleep of the day, pale is a nap. Tap a day to see the times below the chart. Solid lines are the average, dashed ones the goal, a dot is a sleep without times."),
                0.8125f, c.muted).apply { setLineSpacing(0f, 1.3f) }, lpTop(0.875f))
        }
        if (bed == null || wake == null) addView(HkFlow(ctx).apply {
            addView(ctx.hkText(Sx.t("Задайте цель режима:", "Set a routine goal:")))
            val example = Sx.t("цель сон 23:30-07:00", "goal sleep 23:30-07:00")
            addView(ctx.hkChip(example) { onExample(example) })
        }, lpTop(0.875f))
    }

    /** «23 окт: 23:40 → 07:30 (7:50)» — сны дня под графиком. */
    private fun sleepDetail(day: String, sleeps: List<JSONObject>): String {
        val label = Hk.dayShort(day)
        val list = sleeps.filter { it.optString("day") == day }
        if (list.isEmpty()) return Sx.t("$label: сон не записан", "$label: no sleep recorded")
        val text = list.sortedBy { HealthRoutineChart.spanOf(it)?.first ?: 0.0 }.joinToString(", ") { r ->
            if (HealthRoutineChart.spanOf(r) != null) "${r.optString("time")} → ${r.optString("endTime")} (${Hk.span(r.optDouble("value"))})"
            else Sx.t("${Hk.span(r.optDouble("value"))} без времени", "${Hk.span(r.optDouble("value"))} without times")
        }
        if (list.size < 2) return "$label: $text"
        val total = Hk.span(list.sumOf { it.optDouble("value", 0.0) })
        return Sx.t("$label: $text · всего $total", "$label: $text · total $total")
    }

    // ── «Активность» ──────────────────────────────────────────────────────────────

    private fun activityCard(ctx: Context, data: JSONObject, goals: JSONObject, weekLabels: List<String>, current: Int,
                             onExample: (String) -> Unit) = ctx.hkCard().apply {
        val c = Pv.c
        val metrics = data.optJSONObject("metrics") ?: JSONObject()
        val steps = metrics.optJSONObject("steps")?.optJSONObject("day")?.optDouble("value", 0.0) ?: 0.0
        val stepsGoal = Hk.optNum(goals, "steps")?.takeIf { it > 0 }
        val active = data.optDouble("activeMinutes", 0.0).takeIf { !it.isNaN() } ?: 0.0
        val activeGoal = Hk.optNum(goals, "activeMinutes")?.takeIf { it > 0 }
        val workouts = Hk.objects(data.optJSONArray("workouts")).filterNotNull()
        val workoutsGoal = Hk.optNum(goals, "workouts")?.takeIf { it > 0 }
        addView(ctx.hkHead(Sx.t("Активность", "Activity"), ctx.hkGhost("plus", Sx.t("Спорт", "Sport")) {
            onExample(Sx.t("бег 5 км 30 мин", "run 5 km 30 min"))
        }))
        addView(progressRow(ctx, Sx.t("Шаги сегодня", "Steps today"), Hk.number(steps), stepsGoal?.let { " / ${Hk.number(it)}" } ?: "",
            Hk.share(steps, stepsGoal), c.workout))
        addView(progressRow(ctx, Sx.t("Активные минуты · 7 дней", "Active minutes · 7 days"), Hk.number(active),
            activeGoal?.let { Sx.t(" / ${Hk.number(it)} мин", " / ${Hk.number(it)} min") } ?: Sx.t(" мин", " min"), Hk.share(active, activeGoal), c.food))
        addView(progressRow(ctx, Sx.t("Тренировки · 7 дней", "Workouts · 7 days"), workouts.size.toString(),
            workoutsGoal?.let { " / ${Hk.number(it)}" } ?: "", Hk.share(workouts.size.toDouble(), workoutsGoal), c.event))
        val stepSeries = Hk.numbers(metrics.optJSONObject("steps")?.optJSONArray("week"))
        addView(HkBars(ctx, stepSeries, weekLabels, current, c.workout, stepsGoal,
            { v -> if (v >= 1000) "${Hk.number(v / 1000, 1)}k" else Hk.number(v) }))
        val list = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        if (workouts.isEmpty()) list.addView(ctx.hkText(Sx.t("За 7 дней тренировок нет", "No workouts in the last 7 days"), sizeRem = 0.9375f))
        workouts.forEach { list.addView(workoutRow(ctx, it)) }
        addView(list)
        addView(ctx.hkText(Sx.t("Текстом: «бег 5 км 28 мин», «зал присед 4x8x80, жим 3x10x60», «шаги 9500». Норма ВОЗ — от 150 минут умеренной активности в неделю.",
            "As text: «run 5 km 28 min», «gym squat 4x8x80, bench 3x10x60», «steps 9500». WHO advises at least 150 minutes of moderate activity a week.")))
    }

    /** `.healthRowHead` + толстая полоса. */
    private fun progressRow(ctx: Context, label: String, value: String, goalPart: String, fraction: Double, color: Int) = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(ctx.pvText(label, 0.875f, Pv.c.fg), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(ctx.pvText(android.text.SpannableStringBuilder().apply {
                append(value)
                setSpan(android.text.style.ForegroundColorSpan(color), 0, length, 0)
                setSpan(android.text.style.StyleSpan(android.graphics.Typeface.BOLD), 0, length, 0)
                val start = length
                append(goalPart)
                setSpan(android.text.style.ForegroundColorSpan(Pv.c.muted), start, length, 0)
            }, 0.875f, Pv.c.fg, mono = true))
        })
        addView(HkProg(ctx, fraction, color, thick = true), lpTop(0.25f))
    }

    private fun workoutRow(ctx: Context, r: JSONObject) = row(ctx).apply {
        addView(FrameLayout(ctx).apply {
            background = Pv.shape(Pv.alpha(Pv.c.workout, 22), 0.5f)
            addView(ctx.pvIcon("heart", Pv.c.workout, 1.125f), FrameLayout.LayoutParams(Pv.rem(1.125f), Pv.rem(1.125f), Gravity.CENTER))
        }, LinearLayout.LayoutParams(Pv.rem(1.75f), Pv.rem(1.75f)))
        val minutes = r.optDouble("value", 0.0)
        val km = Hk.optNum(r, "value2") ?: 0.0
        val pace = if (minutes > 0 && km > 0) (minutes / km).let { p -> "${p.toInt()}:${Math.round((p % 1) * 60).toString().padStart(2, '0')}" } else null
        val exercises = Hk.objects(r.optJSONArray("exercises")).filterNotNull().joinToString(", ") { e ->
            "${e.optString("name")} ${listOfNotNull(Hk.optNum(e, "sets"), Hk.optNum(e, "reps"), Hk.optNum(e, "weight")).joinToString("×") { Hk.number(it) }}"
        }.ifEmpty { null }
        val details = listOfNotNull(
            minutes.takeIf { it > 0 }?.let { Hk.duration(it) },
            km.takeIf { it > 0 }?.let { Sx.t("${Hk.number(it, 1)} км", "${Hk.number(it, 1)} km") },
            pace?.let { Sx.t("$it/км", "$it/km") }, exercises).joinToString(" · ")
        addView(body(ctx, r.optString("name"), details, subMono = false), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = Pv.rem(0.75f)
        })
        addView(meta(ctx, Hk.dayShort(r.optString("day"))))
        addView(smallIb(ctx, "x", Sx.t("Удалить запись", "Delete record")) {
            Sx.planner("removeHealth", JSONObject().put("id", r.optString("id")).put("notice", Sx.t("Запись удалена", "Record deleted")))
        })
    }

    // ── «Калории за неделю» ───────────────────────────────────────────────────────

    private fun kcalWeekCard(ctx: Context, day: String, data: JSONObject, week: List<String>, weekLabels: List<String>, current: Int) =
        ctx.hkCard().apply {
            val kcalGoal = Hk.optNum(data.optJSONObject("nutrients")?.optJSONObject("kcal")?.optJSONObject("goal"), "target")?.takeIf { it > 0 }
            val note = ctx.hkNote("")
            addView(ctx.hkHead(Sx.t("Калории за неделю", "Calories this week"), note))
            val slot = FrameLayout(ctx)
            addView(slot)
            fun draw(values: List<Double?>) {
                slot.removeAllViews()
                slot.addView(HkBars(ctx, values, weekLabels, current, Pv.c.food, kcalGoal, { Hk.number(it) }))
                val known = values.filterNotNull()
                note.text = if (known.isEmpty()) "" else Sx.t("ср. ${Hk.number(known.average())}", "avg ${Hk.number(known.average())}")
            }
            val todayKcal = data.optJSONObject("nutrients")?.optJSONObject("kcal")?.optDouble("value", 0.0) ?: 0.0
            draw(week.map { if (it == day) Math.round(todayKcal).toDouble().takeIf { v -> v > 0 } else null })
            // Остальные дни недели — сводкой ядра за каждый день
            Sx.async({
                week.map { d ->
                    if (d == day) Math.round(todayKcal).toDouble().takeIf { it > 0 }
                    else (ParvaneSections.planner("health", JSONObject().put("day", d)) as? JSONObject)?.optJSONObject("nutrients")
                        ?.optJSONObject("kcal")?.optDouble("value", 0.0)?.let { Math.round(it).toDouble() }?.takeIf { it > 0 }
                }
            }) { values -> if (values != null) draw(values) }
        }

    // ── «Цели и настройки» ────────────────────────────────────────────────────────

    fun renderGoals(container: LinearLayout, owner: SectionController, data: JSONObject?) {
        val ctx = container.context
        val st = state()
        val goals = data?.optJSONObject("goals") ?: JSONObject()
        val healthGoals = st?.optJSONObject("healthGoals") ?: JSONObject()
        val nutrients = data?.optJSONObject("nutrients") ?: JSONObject()
        fun target(key: String) = Hk.optNum(nutrients.optJSONObject(key)?.optJSONObject("goal"), "target")?.takeIf { it > 0 }
        val settings = st?.optJSONObject("settings") ?: JSONObject()
        val budget = st?.optDouble("budget", 600.0)?.takeIf { !it.isNaN() } ?: 600.0
        val bed = Hk.optNum(healthGoals, "bedtime"); val wake = Hk.optNum(healthGoals, "wakeTime")
        val summary = listOfNotNull(
            target("kcal")?.let { Sx.t("${Hk.number(it)} ккал", "${Hk.number(it)} kcal") },
            target("protein")?.let { Sx.t("Белки ${Hk.number(it)}", "Protein ${Hk.number(it)}") },
            target("fat")?.let { Sx.t("Жиры ${Hk.number(it)}", "Fat ${Hk.number(it)}") },
            target("carbs")?.let { Sx.t("Углеводы ${Hk.number(it)}", "Carbs ${Hk.number(it)}") },
            target("fiber")?.let { Sx.t("Клетчатка ${Hk.number(it)}", "Fiber ${Hk.number(it)}") },
            target("water")?.let { Sx.t("Вода ${Hk.number(it / 1000, 1)} л", "Water ${Hk.number(it / 1000, 1)} l") },
            Hk.optNum(goals, "sleepMinutes")?.takeIf { it > 0 }?.let { Sx.t("Сон ${Hk.span(it)}", "Sleep ${Hk.span(it)}") },
            if (bed != null && wake != null) Sx.t("Режим ${Hk.clock(bed)}–${Hk.clock(wake)}", "Routine ${Hk.clock(bed)}–${Hk.clock(wake)}") else null,
            Hk.optNum(goals, "steps")?.takeIf { it > 0 }?.let { Sx.t("Шаги ${Hk.number(it)}", "Steps ${Hk.number(it)}") },
            Sx.t("День ${Hk.clock(settings.optDouble("dayStart", 540.0))}–${Hk.clock(settings.optDouble("dayEnd", 1260.0))} · бюджет ${Hk.number(budget / 60, 1)} ч",
                "Day ${Hk.clock(settings.optDouble("dayStart", 540.0))}–${Hk.clock(settings.optDouble("dayEnd", 1260.0))} · budget ${Hk.number(budget / 60, 1)} h"),
        ).joinToString(" · ")
        container.addView(ctx.hkCard().apply {
            addView(ctx.hkHead(Sx.t("Цели и настройки", "Goals and settings")))
            addView(ctx.hkText(summary))
            addView(ctx.hkTextForm(Sx.t("белок 140 вода 2,5л сон 8ч день с 8 до 22", "protein 140 water 2.5l sleep 8h day from 8 to 22"),
                Sx.t("Применить", "Apply"), accent = true) { text, done ->
                Sx.planner("quickAdd", JSONObject().put("text", text).put("kind", "goal").put("notice", Sx.t("Цели сохранены", "Goals saved"))) { r ->
                    val ok = (r as? JSONObject)?.optString("error").isNullOrEmpty() && (r as? JSONObject)?.optString("kind") == "goal"
                    if (!ok) org.thunderdog.challegram.tool.UI.showToast(Sx.t("Ничего не распознано. Пример: белок 140 вода 2,5л",
                        "Nothing recognised. Example: protein 140 water 2.5l"), android.widget.Toast.LENGTH_SHORT)
                    done(ok)
                }
            })
        }, lpTop(if (container.childCount == 0) 0f else 1f))
    }

    // ── общее ─────────────────────────────────────────────────────────────────────

    /** `.row`: мин. 2,75 rem, промежуток 0,75 rem, выступает на 0,625 rem за края карточки. */
    private fun row(ctx: Context) = object : LinearLayout(ctx) {
        override fun addView(child: View, index: Int, params: ViewGroup.LayoutParams) {
            if (childCount > 0 && params is LinearLayout.LayoutParams && params.leftMargin == 0) params.leftMargin = Pv.rem(0.75f)
            super.addView(child, index, params)
        }
    }.apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = Pv.rem(2.75f)
        setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = -Pv.rem(0.625f); rightMargin = -Pv.rem(0.625f)
        }
    }

    private fun body(ctx: Context, title: String, sub: String, subMono: Boolean) = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        addView(ctx.pvText(title, 0.9375f, Pv.c.fg, maxLines = 2))
        if (sub.isNotEmpty()) addView(ctx.pvText(sub, 0.8125f, Pv.c.muted, mono = subMono))
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }

    private fun meta(ctx: Context, text: String) = ctx.pvText(text, 0.8125f, Pv.c.muted, mono = true)

    /** `.ib.ibSmall` — 1,75 rem. */
    private fun smallIb(ctx: Context, icon: String, description: String, onClick: () -> Unit) = FrameLayout(ctx).apply {
        contentDescription = description
        addView(ctx.pvIcon(icon, Pv.c.muted, 1f), FrameLayout.LayoutParams(Pv.rem(1f), Pv.rem(1f), Gravity.CENTER))
        Pv.pressable(this, 0, 0.875f, onClick = onClick)
        layoutParams = LinearLayout.LayoutParams(Pv.rem(1.75f), Pv.rem(1.75f))
    }

    /** Правка состояния «Плана» целиком (то, чего нет среди операций ядра); `notice` — с «Отменить». */
    private fun editState(notice: String, mutate: (JSONObject) -> Unit) {
        val snap = Sx.last("planner") ?: return
        val copy = JSONObject(snap.optJSONObject("state")?.toString() ?: return)
        mutate(copy)
        Sx.async({ ParvaneSections.plannerReplace(copy.toString(), notice) }) {}
    }
}

/** График веса за три недели (`.spark`): ломаная по записям, пунктир цели с подписью, точка последней записи. */
internal class HealthWeightSpark(context: Context, private val values: List<Double?>, private val goal: Double?) : View(context) {
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = Pv.px(2f).toFloat(); strokeJoin = Paint.Join.ROUND }
    private val dash = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = Pv.px(1f).toFloat(); pathEffect = DashPathEffect(floatArrayOf(Pv.px(4f).toFloat(), Pv.px(4f).toFloat()), 0f)
    }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Pv.mono(); textAlign = Paint.Align.RIGHT
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 11f, context.resources.displayMetrics)
    }

    // Поле 300 × 90, как viewBox web: высота по ширине
    override fun onMeasure(w: Int, h: Int) {
        val width = MeasureSpec.getSize(w)
        setMeasuredDimension(width, width * 90 / 300)
    }

    override fun onDraw(canvas: Canvas) {
        val c = Pv.c
        val known = values.mapIndexedNotNull { i, v -> v?.let { i to it } }
        if (known.isEmpty()) return
        val k = width / 300f
        val pad = 6f
        val low = minOf(known.minOf { it.second }, goal ?: Double.MAX_VALUE) - 0.5
        val high = maxOf(known.maxOf { it.second }, goal ?: -Double.MAX_VALUE) + 0.5
        fun x(i: Int) = (pad + i * (300 - pad * 2) / (values.size - 1).coerceAtLeast(1)) * k
        fun y(v: Double) = ((90 - pad - ((v - low) / (high - low)) * (90 - pad * 2)) * k).toFloat()
        goal?.let {
            dash.color = c.faint
            canvas.drawLine(0f, y(it), width.toFloat(), y(it), dash)
            text.color = c.faint
            canvas.drawText(Sx.t("цель ${Hk.number(it, 1)}", "goal ${Hk.number(it, 1)}"), (300 - pad) * k, y(it) - pad * k, text)
        }
        line.color = c.green
        val path = android.graphics.Path()
        known.forEachIndexed { n, (i, v) -> if (n == 0) path.moveTo(x(i), y(v)) else path.lineTo(x(i), y(v)) }
        canvas.drawPath(path, line)
        dot.color = c.green
        val (li, lv) = known.last()
        canvas.drawCircle(x(li), y(lv), 4f * k, dot)
    }
}

/**
 * «Режим сна» за две недели (`.routineChart`, 13 rem): столбики сна на шкале часов (сон через полночь — с вечера
 * накануне), основной сон дня ярче, дневной — бледнее, точка — сон без времени; справа подписи часов, снизу числа
 * дней; пунктир — цель режима. Нажатие на день выделяет его и показывает его сны под графиком ([onPick]).
 */
internal class HealthRoutineChart(
    context: Context,
    private val days: List<String>,
    private var picked: String,
    private val sleeps: List<JSONObject>,
    bedGoal: Double?,
    wakeGoal: Double?,
    private val onPick: (String) -> Unit,
) : View(context) {
    companion object {
        /** Сон от отхода до подъёма в минутах от полуночи дня подъёма; без времени — null. */
        fun spanOf(r: JSONObject): Pair<Double, Double>? {
            fun parse(t: String) = t.takeIf { it.length >= 5 }?.let { (it.substring(0, 2).toIntOrNull() ?: return null) * 60.0 + (it.substring(3, 5).toIntOrNull() ?: return null) }
            val bed = parse(r.optString("time")) ?: return null
            val wake = parse(r.optString("endTime")) ?: return null
            if (bed == wake) return null
            return (if (bed < wake) bed else bed - 1440) to wake
        }
    }

    private val goalLines = if (bedGoal != null && wakeGoal != null) listOf(if (bedGoal >= 720) bedGoal - 1440 else bedGoal, wakeGoal) else emptyList()
    private val low: Double
    private val high: Double
    private val ticks: List<Double>
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dash = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = Pv.px(1f).toFloat(); pathEffect = DashPathEffect(floatArrayOf(Pv.px(4f).toFloat(), Pv.px(3f).toFloat()), 0f)
    }
    private val tick = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Pv.mono(); textAlign = Paint.Align.RIGHT
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 11f, context.resources.displayMetrics)
    }
    private val rect = RectF()
    private val gutter = Pv.rem(3f).toFloat()
    private val daysH = Pv.rem(1.5f).toFloat()
    private val top = Pv.rem(0.5f).toFloat()

    init {
        val marks = sleeps.mapNotNull { spanOf(it) }.flatMap { listOf(it.first, it.second) } + goalLines
        val from = if (marks.isEmpty()) -120.0 else marks.minOf { it } - 30
        val to = if (marks.isEmpty()) 480.0 else marks.maxOf { it } + 30
        val step = listOf(60.0, 120.0, 180.0, 240.0).firstOrNull { (to - from) / it <= 8 } ?: 240.0
        low = Math.floor(from / step) * step
        high = Math.ceil(to / step) * step
        ticks = generateSequence(low) { it + step }.takeWhile { it <= high + 0.1 }.toList()
    }

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(MeasureSpec.getSize(w), Pv.rem(13f))

    private fun y(v: Double): Float = top + ((v - low) / (high - low)).toFloat() * (height - top - daysH)

    override fun onDraw(canvas: Canvas) {
        val c = Pv.c
        val plotW = width - gutter
        val colW = plotW / days.size
        // Сетка и подписи часов
        ticks.forEach { t ->
            val wrapped = ((t.toInt() % 1440) + 1440) % 1440
            paint.color = if (wrapped == 0) c.muted else c.line
            paint.strokeWidth = Pv.px(1f).toFloat()
            canvas.drawLine(0f, y(t), plotW, y(t), paint)
            tick.color = c.muted
            canvas.drawText(Hk.clock(t), width.toFloat(), y(t) - (tick.ascent() + tick.descent()) / 2, tick)
        }
        days.forEachIndexed { i, d ->
            val x0 = i * colW
            if (d == picked) {
                paint.color = c.hover
                rect.set(x0, 0f, x0 + colW, height.toFloat())
                canvas.drawRoundRect(rect, Pv.rem(0.375f).toFloat(), Pv.rem(0.375f).toFloat(), paint)
            }
            val list = sleeps.filter { it.optString("day") == d }
            val main = list.maxByOrNull { it.optDouble("value", 0.0) }
            list.forEach { r ->
                val s = spanOf(r)
                if (s == null) {
                    paint.color = c.faint
                    canvas.drawCircle(x0 + colW / 2, top + (height - top - daysH) / 2, Pv.rem(0.1875f).toFloat(), paint)
                    return@forEach
                }
                paint.color = if (r === main) c.sleep else Pv.alpha(c.sleep, 50)
                rect.set(x0 + colW * 0.22f, y(s.first), x0 + colW * 0.78f, maxOf(y(s.second), y(s.first) + Pv.rem(0.125f)))
                canvas.drawRoundRect(rect, Pv.rem(0.125f).toFloat(), Pv.rem(0.125f).toFloat(), paint)
            }
            tick.color = if (d == days.last()) c.fg else c.muted
            tick.typeface = if (d == days.last()) Pv.semibold() else Pv.mono()
            tick.textAlign = Paint.Align.CENTER
            canvas.drawText(Sx.calendarOf(d).get(java.util.Calendar.DAY_OF_MONTH).toString(), x0 + colW / 2,
                height - daysH / 2 - (tick.ascent() + tick.descent()) / 2, tick)
            tick.textAlign = Paint.Align.RIGHT
            tick.typeface = Pv.mono()
        }
        dash.color = c.green
        goalLines.forEach { canvas.drawLine(0f, y(it), plotW, y(it), dash) }
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_DOWN) return true
        if (event.action != MotionEvent.ACTION_UP) return super.onTouchEvent(event)
        val plotW = width - gutter
        if (event.x >= plotW) return true
        val i = (event.x / (plotW / days.size)).toInt().coerceIn(0, days.size - 1)
        picked = days[i]
        invalidate()
        onPick(picked)
        return true
    }
}
