package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.text.Editable
import android.text.TextWatcher
import android.widget.EditText
import org.json.JSONObject
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme

/**
 * Parvane (spec 031, T062): «+» — ввод текстом в «План», как web/desktop: «встреча завтра в 15 на час»,
 * «каша 200 г», «вода 300», «спал 23:30–7:10», «вес 72.5»… Разбор — ядро (`quickParse`, RU/EN), под строкой —
 * что получится; «Добавить» — `quickAdd` (запись черновика в состояние той же логикой).
 */
object QuickAdd {
    fun show(owner: ViewController<*>) {
        val ctx = owner.context()
        val box = ctx.vbox(Sx.dp(20f))
        val input = EditText(ctx).apply {
            hint = Sx.t("Например: встреча завтра в 15 на час", "E.g.: meeting tomorrow at 3pm for an hour")
            setTextColor(Sx.color(ColorId.text))
            setHintTextColor(Sx.color(ColorId.textPlaceholder))
        }
        box.addView(input, lp())
        val preview = ctx.label("", 14f, ColorId.textLight)
        box.addView(preview, lp(t = Sx.dp(8f)))
        box.addView(ctx.label(Sx.t("Задача, событие, еда, вода, сон, вес, тренировка, цель — одной строкой",
            "Task, event, food, water, sleep, weight, workout, goal — in one line"), 12f, ColorId.textLight), lp(t = Sx.dp(10f)))
        var generation = 0
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) {
                val text = s?.toString().orEmpty()
                val gen = ++generation
                if (text.isBlank()) { preview.text = ""; return }
                Sx.main.postDelayed({
                    if (gen != generation) return@postDelayed
                    Sx.planner("quickParse", JSONObject().put("text", text)) { r -> if (gen == generation) preview.text = describe(r as? JSONObject) }
                }, 250)
            }
        })
        val dialog = AlertDialog.Builder(ctx, Theme.dialogTheme())
            .setTitle(Sx.t("Добавить в «План»", "Add to Plan"))
            .setView(box)
            .setPositiveButton(Sx.t("Добавить", "Add"), null)
            .setNegativeButton(Sx.t("Отмена", "Cancel"), null)
            .show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val text = input.text.toString()
            if (text.isBlank()) return@setOnClickListener
            Sx.planner("quickAdd", JSONObject().put("text", text).put("notice", Sx.t("Добавлено", "Added"))) { r ->
                val err = (r as? JSONObject)?.optString("error").orEmpty()
                if (err.isNotEmpty()) preview.text = ItemEditor.errorText(err)
                else dialog.dismiss()
            }
        }
        input.requestFocus()
        dialog.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
    }

    /** Черновик разбора словами: «Событие · завтра · 15:00–16:00 · встреча». */
    fun describe(d: JSONObject?): String {
        if (d == null) return ""
        d.optString("error").takeIf { it.isNotEmpty() }?.let { return ItemEditor.errorText(it) }
        val kind = when (d.optString("kind")) {
            "task" -> Sx.t("Задача", "Task")
            "event" -> Sx.t("Событие", "Event")
            "food" -> Sx.t("Еда", "Food")
            "water" -> Sx.t("Вода", "Water")
            "sleep" -> Sx.t("Сон", "Sleep")
            "metric" -> Sx.t("Показатель", "Measurement")
            "workout" -> Sx.t("Тренировка", "Workout")
            "goal" -> Sx.t("Цель", "Goal")
            else -> d.optString("kind")
        }
        val parts = mutableListOf(kind)
        d.optString("day").takeIf { it.isNotEmpty() }?.let { parts += Sx.dayTitle(it) }
        val start = d.optString("start")
        val end = d.optString("end")
        if (start.isNotEmpty()) parts += if (end.isNotEmpty()) "$start–$end" else start
        if (d.has("minutes") && !d.isNull("minutes")) parts += Sx.minutesLabel(d.optDouble("minutes").toInt())
        if (d.has("waterMl")) parts += "${d.optDouble("waterMl").toInt()} ${Sx.t("мл", "ml")}"
        if (d.has("grams")) parts += "${d.optDouble("grams").toInt()} ${Sx.t("г", "g")}"
        d.optJSONObject("nutrients")?.optDouble("kcal")?.takeIf { !it.isNaN() }?.let { parts += "${it.toInt()} ${Sx.t("ккал", "kcal")}" }
        if (d.has("metric")) parts += "${d.optString("metric")} ${d.optDouble("value").let { if (it % 1.0 == 0.0) it.toInt().toString() else it.toString() }}"
        d.optJSONObject("repeat")?.let { parts += Sx.t("повтор", "repeats") }
        d.optString("name").takeIf { it.isNotEmpty() }?.let { parts += it }
        return parts.joinToString(" · ")
    }
}
