package org.thunderdog.challegram.parvane.sections

import android.app.Dialog
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.navigation.ViewController

/**
 * Parvane (spec 032): «+» — окно «Новая запись» 1:1 с телефонной версией web (`PlannerQuickInput.tsx`): окно прижато
 * к низу, «× Новая запись», поле с рамкой акцента, под ним — подсказка либо распознанное чипами (вид, повтор, день,
 * время, длительность, срок… — снимаемые ×), название и описание; переключатель вида «Авто · Событие · Задача · Еда ·
 * Сон · Спорт»; «Примеры» / «Недавние» / «Подсказки» в две строки с прокруткой; «По умолчанию: <сегодня>»,
 * «Подробнее», «Отмена», «Добавить». Разбор — операция ядра `quickParse`, запись — `quickAdd` (та же логика, что web).
 */
object QuickAdd {
    private val choices = listOf("auto", "event", "task", "food", "sleep", "workout")
    private const val SUGGESTIONS_MAX = 24

    /**
     * [initialText] с пробелом в конце — начало строки (ставится в поле); без пробела — пример вида (подсказкой в пустом
     * поле, вид выбран, подсказки — этого вида), как кнопки «Здоровья». [kind] — вид окна заранее.
     */
    @JvmStatic
    @JvmOverloads
    fun show(owner: ViewController<*>, initialText: String = "", kind: String? = null) {
        Window(owner, initialText, kind).show()
    }

    private fun kindLabel(kind: String, metric: String? = null): String = when (kind) {
        "auto" -> Sx.t("Авто", "Auto")
        "event" -> Sx.t("Событие", "Event")
        "task" -> Sx.t("Задача", "Task")
        "food" -> Sx.t("Еда", "Food")
        "water" -> Sx.t("Вода", "Water")
        "sleep" -> Sx.t("Сон", "Sleep")
        "workout" -> Sx.t("Спорт", "Sport")
        "metric" -> when (metric) {
            "weight" -> Sx.t("Вес", "Weight")
            "pressure" -> Sx.t("Давление", "Pressure")
            "pulse" -> Sx.t("Пульс", "Pulse")
            "steps" -> Sx.t("Шаги", "Steps")
            "mood" -> Sx.t("Самочувствие", "Mood")
            else -> Sx.t("Тело", "Body")
        }
        "goal" -> Sx.t("Цели и настройки", "Goals and settings")
        else -> kind
    }

    /** Цвет вида (`KIND_CLASSES` web). */
    private fun kindColor(kind: String): Int = Pv.c.let { c ->
        when (kind) {
            "event" -> c.event
            "task" -> c.task
            "food", "water" -> c.food
            "sleep" -> c.sleep
            "workout" -> c.workout
            "metric" -> c.metric
            "goal" -> c.muted
            else -> c.accent
        }
    }

    /** Ошибки черновика (`EVENT_ERROR_KEYS` / `TASK_ERROR_KEYS` web). */
    private fun errorText(code: String) = when (code) {
        "name" -> Sx.t("Введите название.", "Enter a name.")
        "minutes" -> Sx.t("Оценка — от 5 минут.", "The estimate must be at least 5 minutes.")
        "startNeedsDayAndMinutes" -> Sx.t("Для времени начала нужны день и длительность.", "A start time needs a day and a duration.")
        "pastMidnight" -> Sx.t("Задача заходит за полночь.", "The task runs past midnight.")
        "dayAfterDue" -> Sx.t("День работы позже срока.", "The day is after the deadline.")
        "time", "eventTime" -> Sx.t("Конец раньше начала.", "The end is before the start.")
        "loading" -> Sx.t("«План» ещё загружается.", "The plan is still loading.")
        else -> Sx.t("Не распознано: $code", "Not recognised: $code")
    }

    private class Chip(val field: String, val text: String, val fixed: Boolean)

    /** Чипы распознанного (`buildChips` web). */
    private fun chipsOf(d: JSONObject): List<Chip> {
        val spans = (0 until (d.optJSONArray("spans")?.length() ?: 0)).mapNotNull { d.getJSONArray("spans").optJSONObject(it)?.optString("field") }
        fun has(f: String) = f in spans
        val out = mutableListOf<Chip>()
        fun fixed(f: String, t: String) = out.add(Chip(f, t, true))
        val kind = d.optString("kind")
        when (kind) {
            "goal" -> {
                val g = d.optJSONObject("goalChanges") ?: return out
                g.optJSONObject("goals")?.let { o -> o.keys().forEach { k -> fixed("health", "$k → ${Hk.number(o.optDouble(k))}") } }
                g.optJSONObject("health")?.let { o ->
                    o.keys().forEach { k -> fixed("health", "$k → ${if (k == "bedtime" || k == "wakeTime") Hk.clock(o.optDouble(k)) else Hk.number(o.optDouble(k))}") }
                }
                Hk.optNum(g, "dayStart")?.let { fixed("time", "${Hk.clock(it)}–${Hk.clock(g.optDouble("dayEnd"))}") }
                Hk.optNum(g, "budget")?.takeIf { it > 0 }?.let { fixed("minutes", Hk.duration(it)) }
                return out
            }
            "metric" -> {
                Hk.optNum(d, "value")?.let { v -> fixed("health", Hk.optNum(d, "value2")?.takeIf { it != 0.0 }?.let { "${Hk.number(v)}/${Hk.number(it)}" } ?: Hk.number(v, 1)) }
                return out
            }
            "water" -> {
                Hk.optNum(d, "waterMl")?.let { fixed("water", Sx.t("${Hk.number(it)} мл", "${Hk.number(it)} ml")) }
                return out
            }
            "sleep" -> {
                val start = d.optString("start"); val end = d.optString("end")
                if (start.isNotEmpty() && end.isNotEmpty()) fixed("time", "$start–$end")
                Hk.optNum(d, "minutes")?.takeIf { it > 0 }?.let { fixed("minutes", Hk.span(it)) }
                return out
            }
        }
        val repeat = d.optJSONObject("repeat")
        val day = d.optString("day")
        if (repeat != null) out.add(Chip("repeat", Hk.repeat(repeat), false))
        else if (day.isNotEmpty()) out.add(Chip("day", Hk.day(day), d.optBoolean("isDayAssumed") || !has("day")))
        if (kind == "food") {
            val n = d.optJSONObject("nutrients") ?: JSONObject()
            val meals = mapOf("breakfast" to Sx.t("Завтрак", "Breakfast"), "lunch" to Sx.t("Обед", "Lunch"), "dinner" to Sx.t("Ужин", "Dinner"),
                "snack" to Sx.t("Перекусы", "Snacks"), "other" to Sx.t("Другие записи", "Other"))
            d.optString("meal").takeIf { it.isNotEmpty() }?.let { fixed("meal", meals[it] ?: it) }
            Hk.optNum(n, "kcal")?.let { fixed("kcal", Sx.t("${Hk.number(it)} ккал", "${Hk.number(it)} kcal")) }
            if (n.has("protein") || n.has("fat") || n.has("carbs")) {
                val p = Hk.number(n.optDouble("protein", 0.0)); val f = Hk.number(n.optDouble("fat", 0.0)); val cb = Hk.number(n.optDouble("carbs", 0.0))
                fixed("protein", Sx.t("Б$p Ж$f У$cb", "P$p F$f C$cb"))
            }
            Hk.optNum(n, "fiber")?.let { fixed("fiber", Sx.t("кл ${Hk.number(it)}", "fiber ${Hk.number(it)}")) }
            Hk.optNum(d, "grams")?.let { fixed("grams", Sx.t("${Hk.number(it)} г", "${Hk.number(it)} g")) }
            return out
        }
        if (kind == "workout") {
            d.optString("start").takeIf { it.isNotEmpty() }?.let { fixed("time", it) }
            val minutes = Hk.optNum(d, "minutes")
            minutes?.takeIf { it > 0 }?.let { fixed("minutes", Hk.duration(it)) }
            Hk.optNum(d, "distanceKm")?.takeIf { it > 0 }?.let { km ->
                val pace = minutes?.takeIf { it > 0 }?.let { m -> (m / km).let { p -> "${p.toInt()}:${Math.round((p % 1) * 60).toString().padStart(2, '0')}" } }
                fixed("health", listOfNotNull(Sx.t("${Hk.number(km, 1)} км", "${Hk.number(km, 1)} km"), pace?.let { Sx.t("$it/км", "$it/km") }).joinToString(" · "))
            }
            d.optJSONArray("exercises")?.let { fixed("grams", Sx.t("упражнений: ${it.length()}", "exercises: ${it.length()}")) }
            return out
        }
        val start = d.optString("start"); val end = d.optString("end")
        if (d.optBoolean("isAllDay")) out.add(Chip("time", Sx.t("весь день", "all day"), true))
        else if (start.isNotEmpty()) out.add(Chip("time", if (end.isNotEmpty()) "$start–$end" else start, false))
        Hk.optNum(d, "minutes")?.takeIf { it > 0 && (kind == "task" || end.isEmpty()) }?.let { out.add(Chip("minutes", Hk.duration(it), !has("minutes"))) }
        d.optString("due").takeIf { it.isNotEmpty() }?.let { out.add(Chip("due", Sx.t("до ${Hk.day(it)}", "by ${Hk.day(it)}"), false)) }
        d.optString("list").takeIf { it.isNotEmpty() }?.let { out.add(Chip("list", "#$it", false)) }
        d.optString("place").takeIf { it.isNotEmpty() }?.let { out.add(Chip("place", "@$it", false)) }
        if (d.optBoolean("isImportant")) out.add(Chip("important", "! ${Sx.t("В работе", "In progress")}", false))
        Hk.optNum(d, "remind")?.let { out.add(Chip("remind", Hk.remind(it), false)) }
        return out
    }

    private class Candidate(val text: String, val isExample: Boolean, var kind: String? = null)

    private class Window(private val owner: ViewController<*>, initialText: String, private val presetKind: String?) {
        private val ctx: Context = owner.context()
        private val c = Pv.c
        private val dialog = Dialog(ctx, android.R.style.Theme_Translucent_NoTitleBar)
        private val input = EditText(ctx)
        private val preview = HkFlow(ctx)
        private val choiceRow = LinearLayout(ctx)
        private val suggestionsBox = LinearLayout(ctx)
        private lateinit var addButton: LinearLayout
        private var choice = presetKind?.takeIf { it in choices } ?: "auto"
        private var skip = mutableListOf<String>()
        private var draft: JSONObject? = null
        private var generation = 0
        private var exampleKind: String? = null
        private var examplePlaceholder: String? = null
        private val candidates = mutableListOf<Candidate>()
        private val today = Sx.today()

        init {
            val isExample = initialText.isNotEmpty() && !initialText.endsWith(" ")
            if (isExample) examplePlaceholder = initialText
            val sheet = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                background = GradientDrawable().apply {
                    val r = Pv.rem(1.25f).toFloat()
                    cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
                    setColor(c.panel)
                }
                isClickable = true
            }
            // Шапка окна мессенджера: крестик слева, название
            sheet.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(Pv.rem(1f), Pv.rem(1f), Pv.rem(1.5f), Pv.rem(0.5f))
                addView(ctx.pvIconButton("x", Sx.t("Закрыть", "Close"), c.muted) { dialog.dismiss() }.apply {
                    layoutParams = LinearLayout.LayoutParams(Pv.rem(2.5f), Pv.rem(2.5f))
                })
                addView(ctx.pvText(Sx.t("Новая запись", "New entry"), 1.125f, c.fg, semibold = true),
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Pv.rem(1.25f) })
            })
            val form = object : LinearLayout(ctx) {
                override fun addView(child: View, index: Int, params: ViewGroup.LayoutParams) {
                    if (childCount > 0 && params is LinearLayout.LayoutParams) params.topMargin = Pv.rem(0.875f)
                    super.addView(child, index, params)
                }
            }.apply {
                orientation = LinearLayout.VERTICAL
                setPadding(Pv.rem(1.5f), Pv.rem(0.5f), Pv.rem(1.5f), Pv.rem(1.5f))
            }
            input.apply {
                setTextSize(TypedValue.COMPLEX_UNIT_DIP, 17f)
                setTextColor(c.fg)
                setHintTextColor(c.faint)
                typeface = Pv.regular()
                setSingleLine()
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                imeOptions = EditorInfo.IME_ACTION_DONE
                filters = arrayOf<android.text.InputFilter>(android.text.InputFilter.LengthFilter(300))
                setPadding(Pv.rem(1f), 0, Pv.rem(1f), 0)
                background = Pv.shape(c.raised, 0.75f, c.accent, 2f)
                hint = examplePlaceholder ?: Sx.t("созвон завтра 16:00 45 мин", "call tomorrow 16:00 45 min")
                if (!isExample && initialText.isNotEmpty()) { setText(initialText); setSelection(initialText.length) }
                setOnEditorActionListener { _, _, _ -> submit(); true }
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, cc: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, cc: Int) {}
                    override fun afterTextChanged(s: Editable?) {
                        // Правка строки возвращает снятые значения
                        skip.clear()
                        reparse()
                    }
                })
            }
            form.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.rem(3.25f)))
            form.addView(preview)
            choiceRow.orientation = LinearLayout.HORIZONTAL
            form.addView(HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false
                addView(choiceRow)
            })
            suggestionsBox.orientation = LinearLayout.VERTICAL
            form.addView(suggestionsBox)
            form.addView(ctx.pvText(Sx.t("По умолчанию: ${Hk.dayLabel(today)}", "Default: ${Hk.dayLabel(today)}"), 0.8125f, c.muted))
            addButton = ctx.pvButton(Sx.t("Добавить", "Add"), "acc") { submit() }
            form.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
                addView(ctx.pvButton(Sx.t("Подробнее", "More options"), "ghost") { more() })
                addView(ctx.pvButton(Sx.t("Отмена", "Cancel"), "ghost") { dialog.dismiss() }.apply {
                    (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f)
                })
            })
            form.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END
                addView(addButton)
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(0.5f) })
            sheet.addView(ScrollView(ctx).apply {
                isVerticalScrollBarEnabled = false
                addView(form, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            val root = FrameLayout(ctx).apply {
                setBackgroundColor(0x73000000)
                setOnClickListener { dialog.dismiss() }
                val maxHeight = (ctx.resources.displayMetrics.heightPixels * 0.9f).toInt()
                addView(object : FrameLayout(ctx) {
                    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
                        super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST))
                }.apply { addView(sheet) }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
                    leftMargin = Pv.rem(1.5f); rightMargin = Pv.rem(1.5f)
                })
            }
            dialog.setContentView(root)
            dialog.window?.apply {
                setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
            }
            renderChoices()
            renderPreview()
            loadCandidates()
            if (isExample) {
                // Пример вида: вид окна и подсказки этого вида
                Sx.planner("quickParse", JSONObject().put("text", initialText)) { r ->
                    val k = (r as? JSONObject)?.takeIf { it.optString("error").isEmpty() }?.optString("kind")
                    val mapped = when (k) { "food", "water" -> "food"; "sleep" -> "sleep"; "workout" -> "workout"; "metric" -> "auto"; else -> null }
                    if (mapped != null) {
                        exampleKind = k
                        if (presetKind == null) choice = mapped
                        renderChoices()
                        renderSuggestions()
                    }
                }
            }
            if (input.text.isNotEmpty()) reparse()
        }

        fun show() {
            dialog.show()
            input.postDelayed({
                input.requestFocus()
                (ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
            }, 200)
        }

        private fun args(text: String): JSONObject = JSONObject().put("text", text).apply {
            if (choice != "auto") put("kind", choice)
            if (skip.isNotEmpty()) put("skip", JSONArray(skip))
        }

        private fun reparse() {
            val text = input.text.toString()
            val gen = ++generation
            if (text.isBlank()) {
                draft = null
                renderPreview()
                renderChoices()
                renderSuggestions()
                return
            }
            Sx.planner("quickParse", args(text)) { r ->
                if (gen != generation) return@planner
                draft = r as? JSONObject
                renderPreview()
                renderChoices()
                renderSuggestions()
            }
        }

        private fun renderPreview() {
            preview.removeAllViews()
            val d = draft
            val text = input.text.toString()
            if (text.isBlank() || d == null) {
                preview.addView(ctx.pvText(Sx.t(
                    "Пишите как в заметке: дата, время, длительность, срок и повтор распознаются сами. Описание пишите после «--»: «пара по английскому вт 15:00 -- тест по лисенингу». Числа можно словами («в пять вечера»). Метки #группа, @место и ! в конце — группа (у задачи и события), место и «в работе» (у задачи).",
                    "Type as you would in a note: date, time, duration, deadline and repeat are recognised. Put a description after “--”: “English lesson tue 15:00 -- listening test”. Numbers can be words (“at five pm”). Markers #group, @place and a final ! set the group (task or event), the place and “in progress” (task)."),
                    0.9375f, c.muted).apply { setLineSpacing(0f, 1.35f) })
                addButton.alpha = 0.5f
                return
            }
            val kind = d.optString("kind")
            val color = kindColor(kind)
            preview.addView(tag(kindIcon(kind), kindLabel(kind, d.optString("metric").ifEmpty { null }), color, null))
            chipsOf(d).forEach { chip -> preview.addView(tag(null, chip.text, c.muted, if (chip.fixed) null else chip.field)) }
            if (kind == "task" || kind == "event") {
                preview.addView(part(Sx.t("Название", "Name"), d.optString("name").ifEmpty { Sx.t("Названия пока нет", "No name yet") }, true, null))
                d.optString("description").takeIf { it.isNotEmpty() }?.let { preview.addView(part(Sx.t("Описание", "Description"), it, false, "description")) }
            } else {
                val name = d.optString("name").ifEmpty {
                    when (kind) { "metric" -> kindLabel(kind, d.optString("metric")); "sleep" -> Sx.t("Сон", "Sleep"); "water" -> Sx.t("Вода", "Water")
                        "goal" -> kindLabel(kind); else -> Sx.t("Названия пока нет", "No name yet") }
                }
                preview.addView(ctx.pvText(name, 0.9375f, c.fg, semibold = true).apply { minWidth = fullWidth() })
            }
            val error = d.optString("error")
            val tooLong = d.optString("name").length > 160
            if (error.isNotEmpty() || tooLong) preview.addView(ctx.pvText(if (tooLong) Sx.t("Название слишком длинное.", "The name is too long.") else errorText(error),
                0.8125f, c.red).apply { minWidth = fullWidth() })
            addButton.alpha = if (error.isEmpty() && !tooLong) 1f else 0.5f
        }

        private fun fullWidth() = ctx.resources.displayMetrics.widthPixels - Pv.rem(6f)

        private fun kindIcon(kind: String): View = when (kind) {
            "food", "water" -> ImageView(ctx).apply {
                setImageResource(R.drawable.baseline_restaurant_menu_24)
                setColorFilter(kindColor(kind))
                layoutParams = LinearLayout.LayoutParams(Pv.rem(0.9375f), Pv.rem(0.9375f))
            }
            else -> ctx.pvIcon(when (kind) {
                "event" -> "calendar"; "task" -> "check"; "sleep" -> "sun"; "workout", "metric" -> "heart"; "goal" -> "sliders"; else -> "plus"
            }, kindColor(kind), 0.9375f)
        }

        /** `.tag.tagLarge`: 0,25/0,625 rem, радиус 0,875 rem, 0,8125 rem; цвет вида на его заливке 18 %, × снимает. */
        private fun tag(icon: View?, text: String, color: Int, field: String?): View = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(0.625f), Pv.rem(0.25f), Pv.rem(if (field != null) 0.375f else 0.625f), Pv.rem(0.25f))
            background = Pv.shape(Pv.alpha(color, 18), 0.875f)
            icon?.let { addView(it); (it.layoutParams as? LinearLayout.LayoutParams)?.rightMargin = Pv.rem(0.25f) }
            addView(ctx.pvText(text, 0.8125f, color, maxLines = 1))
            field?.let { f ->
                addView(FrameLayout(ctx).apply {
                    alpha = 0.7f
                    contentDescription = Sx.t("Убрать: $text", "Remove: $text")
                    addView(ctx.pvIcon("x", color, 0.875f), FrameLayout.LayoutParams(Pv.rem(0.875f), Pv.rem(0.875f), Gravity.CENTER))
                    setOnClickListener { skip.add(f); reparseKeepSkip() }
                }, LinearLayout.LayoutParams(Pv.rem(1.25f), Pv.rem(1.25f)).apply { leftMargin = Pv.rem(0.25f) })
            }
        }

        /** Снятие значения: разбор заново без сброса снятых. */
        private fun reparseKeepSkip() {
            val text = input.text.toString()
            val gen = ++generation
            Sx.planner("quickParse", args(text)) { r ->
                if (gen != generation) return@planner
                draft = r as? JSONObject
                renderPreview()
                renderChoices()
            }
        }

        /** `.quickPart`: подпись 0,75 rem (мин. 5 rem) и текст. */
        private fun part(label: String, text: String, isName: Boolean, field: String?): View = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumWidth = fullWidth()
            addView(ctx.pvText(label, 0.75f, c.muted).apply { minWidth = Pv.rem(5f) })
            addView(ctx.pvText(text, 0.9375f, c.fg, semibold = isName), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = Pv.rem(0.625f)
            })
            field?.let { f ->
                addView(FrameLayout(ctx).apply {
                    alpha = 0.7f
                    addView(ctx.pvIcon("x", c.muted, 0.875f), FrameLayout.LayoutParams(Pv.rem(0.875f), Pv.rem(0.875f), Gravity.CENTER))
                    setOnClickListener { skip.add(f); reparseKeepSkip() }
                }, LinearLayout.LayoutParams(Pv.rem(1.5f), Pv.rem(1.5f)))
            }
        }

        /** Переключатель вида: выбранный (либо распознанный при «Авто») — заливкой цвета вида. */
        private fun renderChoices() {
            choiceRow.removeAllViews()
            val text = input.text.toString()
            val drafted = draft?.optString("kind")?.let { when (it) { "water" -> "food"; "metric", "goal" -> "auto"; else -> it } }
            choices.forEach { k ->
                val active = choice == k || (choice == "auto" && text.isNotBlank() && drafted == k)
                val color = if (k == "auto") Pv.c.accent else kindColor(k)
                choiceRow.addView(ctx.hkChip(kindLabel(k), active, color) {
                    choice = k
                    reparse()
                    input.requestFocus()
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    if (choiceRow.childCount > 0) leftMargin = Pv.rem(0.375f)
                })
            }
        }

        /** История строк (данные «Плана», `quickLines`) и примеры; вид каждой строки — разбором ядра. */
        private fun loadCandidates() {
            val state = (Sx.last("planner") ?: ParvaneSections.snapshot("planner"))?.optJSONObject("state")
            val lines = Hk.objects(state?.optJSONArray("quickLines")).filterNotNull().filter { !it.optBoolean("isHidden") }
                .sortedByDescending { it.optDouble("touched", 0.0) }.map { it.optString("text") }.filter { it.isNotBlank() }.distinct()
            val examples = Sx.t(
                "созвон завтра 16:00 45 мин | пара по английскому вт 15:00 -- тест по лисенингу | задача проверить работы до пт | обед гречка 13:00 650 ккал | сон 23:40-07:30 | бег 5 км 28 мин | вес 72,4 | вода 500 мл | спал с 14 до 15 | вчера не спал | зал присед 4x8x80, жим 3x10x60 | йога 40 мин | завтрак овсянка 350 ккал | перекус яблоко 80 ккал | вода 300 мл | давление 120/80 | пульс 64 | самочувствие 4 | шаги 9500",
                "call tomorrow 16:00 45 min | English lesson tue 15:00 -- listening test | task check the papers by fri | lunch buckwheat 13:00 650 kcal | sleep 23:40-07:30 | run 5 km 28 min | weight 72.4 | water 500 ml | slept from 14 to 15 | didn't sleep yesterday | gym squat 4x8x80, bench 3x10x60 | yoga 40 min | breakfast oatmeal 350 kcal | snack apple 80 kcal | water 300 ml | pressure 120/80 | pulse 64 | mood 4 | steps 9500",
            ).split("|").map { it.trim() }.filter { it.isNotEmpty() }
            candidates.clear()
            lines.forEach { candidates.add(Candidate(it, false)) }
            examples.filter { e -> lines.none { it.equals(e, true) } }.forEach { candidates.add(Candidate(it, true)) }
            renderSuggestions()
            val list = candidates.toList()
            Sx.async({ list.map { (ParvaneSections.planner("quickParse", JSONObject().put("text", it.text)) as? JSONObject)?.optString("kind") } }) { kinds ->
                kinds?.forEachIndexed { i, k -> list.getOrNull(i)?.kind = k }
                renderSuggestions()
            }
        }

        private fun renderSuggestions() {
            suggestionsBox.removeAllViews()
            val text = input.text.toString().trim().lowercase()
            val kinds: Set<String>? = when {
                exampleKind != null && presetKind == null && choice == mapChoice(exampleKind!!) -> setOf(exampleKind!!)
                choice == "auto" -> null
                choice == "food" -> setOf("food", "water")
                else -> setOf(choice)
            }
            val list = candidates.filter { cand ->
                val line = cand.text.lowercase()
                (text.isEmpty() || (line.contains(text) && line != text)) && (kinds == null || cand.kind == null || cand.kind in kinds)
            }.take(SUGGESTIONS_MAX)
            if (list.isEmpty()) return
            val hasExamples = list.any { it.isExample }
            val hasOwn = list.any { !it.isExample }
            suggestionsBox.addView(ctx.pvText(when {
                !hasExamples -> Sx.t("Недавние", "Recent")
                hasOwn -> Sx.t("Подсказки", "Suggestions")
                else -> Sx.t("Примеры", "Examples")
            }, 0.8125f, c.muted))
            // Две строки, листаются вбок (`.quickSuggestions` на телефоне): столбцами по две
            val columns = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            list.chunked(2).forEachIndexed { i, pair ->
                columns.addView(LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    pair.forEachIndexed { j, cand ->
                        addView(suggestion(cand.text), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                            if (j > 0) topMargin = Pv.rem(0.375f)
                        })
                    }
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    if (i > 0) leftMargin = Pv.rem(0.375f)
                })
            }
            suggestionsBox.addView(HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false
                addView(columns)
            }, lpTop(0.375f))
        }

        private fun mapChoice(kind: String) = when (kind) { "food", "water" -> "food"; "sleep" -> "sleep"; "workout" -> "workout"; else -> "auto" }

        /** `.quickSuggestion`: пилюля с рамкой line2, 1,875 rem, 0,8125 rem; нажатие ставит строку в поле. */
        private fun suggestion(text: String): View = TextView(ctx).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f)
            typeface = Pv.regular()
            setTextColor(c.fg)
            maxLines = 1
            gravity = Gravity.CENTER_VERTICAL
            minHeight = Pv.rem(1.875f)
            setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
            Pv.pressable(this, 0, 0.9375f, c.line2) {
                input.setText(text)
                input.setSelection(text.length)
                input.requestFocus()
            }
        }

        private fun submit() {
            val text = input.text.toString()
            if (text.isBlank()) return
            val gen = ++generation
            Sx.planner("quickParse", args(text)) { r ->
                if (gen != generation) return@planner
                val d = r as? JSONObject ?: return@planner
                draft = d
                if (d.optString("error").isNotEmpty() || d.optString("name").length > 160) { renderPreview(); return@planner }
                val notice = if (d.optString("kind") == "goal") Sx.t("Цели сохранены", "Goals saved")
                    else Sx.t("Добавлено: ${d.optString("name").ifEmpty { text.trim() }}", "Added: ${d.optString("name").ifEmpty { text.trim() }}")
                Sx.planner("quickAdd", args(text).put("notice", notice)) { res ->
                    val err = (res as? JSONObject)?.optString("error").orEmpty()
                    if (err.isNotEmpty()) { draft = d.put("error", err); renderPreview() } else dialog.dismiss()
                }
            }
        }

        /** «Подробнее» — полная форма записи с распознанным черновиком. */
        private fun more() {
            val text = input.text.toString()
            val open = { d: JSONObject ->
                dialog.dismiss()
                PlannerEditor.openNew(owner, d)
            }
            if (text.isBlank()) { open(JSONObject().put("kind", if (choice == "event") "event" else "task").put("name", "")); return }
            Sx.planner("quickParse", args(text)) { r -> open(r as? JSONObject ?: JSONObject().put("kind", "task").put("name", text)) }
        }
    }
}
