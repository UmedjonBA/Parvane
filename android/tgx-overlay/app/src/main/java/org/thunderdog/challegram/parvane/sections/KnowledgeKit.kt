package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * Parvane (spec 032): детали «Знаний» и «Файлов» телефонной версии web (`PvKit.module.scss`, `Knowledge.module.scss`):
 * плитка `.ava`, строка списка `.row` (мин. 3,25 rem), заголовок группы `.grp` (моноширинный капслок), поле ввода,
 * точечное поле графа и холста (`.board`), кнопки поля (`.boardTool`), чипы на поле (`.boardChip`).
 */
object Kn {
    private val folderTones = listOf("blue", "green", "orange", "purple", "aqua", "red")

    /** Цвет папки заметки, как `folderColor` web: по первой части пути; заметки дня и корень — `--pv-note`. */
    fun folderColor(folder: String, isDaily: Boolean = false): Int {
        val top = folder.split('/').first()
        if (isDaily || top.isEmpty()) return Pv.c.note
        var hash = 7
        top.codePoints().forEach { hash = (hash * 31 + it) % 0xffff }
        return tone(folderTones[hash % folderTones.size])
    }

    fun tone(name: String): Int = Pv.c.let { c ->
        when (name) {
            "blue" -> c.blue; "green" -> c.green; "orange" -> c.orange; "purple" -> c.purple; "aqua" -> c.aqua; "red" -> c.red
            "yellow" -> c.yellow; else -> c.fg
        }
    }

    private val dayKey = Regex("""^\d{4}-\d{2}-\d{2}$""")
    fun isDayTitle(title: String) = dayKey.matches(title)

    /** Знак на плитке: первая буква названия, у заметки дня — число. */
    fun avatarText(n: JSONObject): String {
        val title = n.optString("title")
        if (n.optBoolean("isDaily") && isDayTitle(title)) return title.substring(8).trimStart('0')
        return title.trim().take(1).uppercase()
    }

    /** Название для показа: у заметки дня — «пн, 12 октября». */
    fun displayTitle(n: JSONObject): String {
        val title = n.optString("title")
        return if (n.optBoolean("isDaily") && isDayTitle(title)) Sx.dayTitle(title) else title
    }

    /** Название папки для показа: путь через « / ». */
    fun folderCaption(path: String) = path.split('/').joinToString(" / ")

    /** Строка начала текста заметки (как `previewOf` web): первая содержательная, не совпадающая с названием. */
    fun previewOf(n: JSONObject): String {
        val title = n.optString("title").trim().lowercase()
        for (raw in NoteText.bodyWithoutProperties(n.optString("text")).lineSequence()) {
            val item = raw.replace(Regex("""^#+\s*|^\s*[-*+] (\[[ xX]] )?"""), "")
                .replace(Regex(""" \^t[a-z0-9]{4,12}\s*$"""), "")
                .replace(Regex("""\[\[([^\]|]+)(\|[^\]]+)?]]"""), "$1")
                .replace("`", "")
                .trim()
            if (item.isNotEmpty() && item.lowercase() != title) return item.take(140)
        }
        return ""
    }

    /** Плитка `.ava`: 2,5 rem, радиус 0,625 rem, цвет 22 %, буква моноширинным 1 rem либо значок. */
    fun Context.ava(color: Int, letter: String? = null, icon: String? = null, sizeRem: Float = 2.5f): View = FrameLayout(this).apply {
        background = Pv.shape(Pv.alpha(color, 22), 0.625f)
        if (icon != null) addView(pvIcon(icon, color, 1.125f), FrameLayout.LayoutParams(Pv.rem(1.125f), Pv.rem(1.125f), Gravity.CENTER))
        else addView(pvText(letter.orEmpty(), 1f, color, semibold = true, mono = true).apply { gravity = Gravity.CENTER },
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        layoutParams = LinearLayout.LayoutParams(Pv.rem(sizeRem), Pv.rem(sizeRem)).apply { rightMargin = Pv.rem(0.75f) }
    }

    /** Строка списка (`.row` + `.listRow`): плитка, название и подпись в одну строку, справа — [trailing]. */
    fun Context.listRow(tile: View, title: String, sub: String?, trailing: View? = null, onLong: (() -> Unit)? = null,
                        onClick: () -> Unit): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = Pv.rem(3.25f)
        setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
        addView(tile)
        val texts = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(pvText(title, 1f, Pv.c.fg, maxLines = 1))
        sub?.let { texts.addView(pvText(it, 0.8125f, Pv.c.muted, maxLines = 1)) }
        addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        trailing?.let { addView(it) }
        Pv.pressable(this, 0, 0.5f, onClick = onClick)
        onLong?.let { cb -> setOnLongClickListener { cb(); true } }
    }

    /** Заголовок группы (`.grp`): моноширинный капслок 0,75 rem semibold, разрядка 0,06 em. */
    fun Context.grpTitle(text: String): TextView = pvText(text.uppercase(), 0.75f, Pv.c.muted, semibold = true, maxLines = 1, mono = true).apply {
        letterSpacing = 0.06f
    }

    /** Поле ввода (`.input`): высота 2,5 rem, рамка line2, радиус 0,5 rem; фокус — рамка акцента. */
    fun Context.input(value: String = "", hint: String = "", multiline: Boolean = false): EditText = EditText(this).apply {
        setText(value)
        this.hint = hint
        setTextColor(Pv.c.fg)
        setHintTextColor(Pv.c.faint)
        textSize = 15f
        typeface = Pv.regular()
        setPadding(Pv.rem(0.75f), Pv.rem(0.5f), Pv.rem(0.75f), Pv.rem(0.5f))
        val normal = Pv.shape(Pv.c.panel, 0.5f, Pv.c.line2)
        val focused = Pv.shape(Pv.c.panel, 0.5f, Pv.c.accent)
        background = normal
        setOnFocusChangeListener { _, has -> background = if (has) focused else normal }
        if (multiline) {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            gravity = Gravity.TOP
        } else {
            setSingleLine()
            minHeight = Pv.rem(2.5f)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = EditorInfo.IME_ACTION_DONE
        }
    }

    /** Шторка с полем: название, значение, «Готово». Пустое значение не принимается. */
    fun askText(context: Context, title: String, value: String, ok: String = Sx.t("Готово", "Done"), done: (String) -> Unit) {
        val sheet = PvSheet.create(context, title)
        val field = context.input(value)
        fun submit() {
            val text = field.text.toString().trim()
            if (text.isEmpty()) return
            sheet.dismiss()
            done(text)
        }
        field.setOnEditorActionListener { _, _, _ -> submit(); true }
        sheet.add(field)
        sheet.add(LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            addView(context.pvButton(Sx.t("Отмена", "Cancel"), "ghost") { sheet.dismiss() })
            addView(context.pvButton(ok, "acc") { submit() }.apply { (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f) })
        })
        sheet.show()
        field.requestFocus()
        field.setSelection(field.text.length)
        field.postDelayed({
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)
                ?.showSoftInput(field, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }, 200)
    }

    /** Меню действий шторкой: строки-кнопки, красная — последняя при [dangerLast]. */
    fun menu(context: Context, title: String, items: List<Pair<String, () -> Unit>>, dangerLast: Boolean = false) {
        val sheet = PvSheet.create(context, title)
        items.forEachIndexed { i, (text, action) ->
            val danger = dangerLast && i == items.lastIndex
            sheet.add(context.pvText(text, 0.9375f, if (danger) Pv.c.red else Pv.c.fg).apply {
                gravity = Gravity.CENTER_VERTICAL
                minHeight = Pv.rem(2.75f)
                setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
                Pv.pressable(this, 0, 0.5f) { sheet.dismiss(); action() }
            }, 0.125f)
        }
        sheet.show()
    }

    /** Кнопка поля (`.boardTool`): 2,375 rem, рамка line2, радиус 0,625 rem, фон панели. */
    fun Context.boardTool(icon: String, description: String, enabled: Boolean = true, on: Boolean = false, onClick: () -> Unit): View =
        FrameLayout(this).apply {
            contentDescription = description
            addView(pvIcon(icon, if (on) Pv.c.accent else Pv.c.fg, 1.375f), FrameLayout.LayoutParams(Pv.rem(1.375f), Pv.rem(1.375f), Gravity.CENTER))
            Pv.pressable(this, if (on) Pv.mix(Pv.c.accent, Pv.c.panel, 22) else Pv.c.panel, 0.625f, Pv.c.line2) { if (enabled) onClick() }
            alpha = if (enabled) 1f else 0.4f
            layoutParams = LinearLayout.LayoutParams(Pv.rem(2.375f), Pv.rem(2.375f))
        }

    /** Чип на поле (`.boardChip`): как `.chip`, фон панели; выбранный — цвет 22 % поверх панели. */
    fun Context.boardChip(text: String, on: Boolean, icon: String? = null, color: Int = Pv.c.accent, onClick: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
            val fg = if (on) color else Pv.c.muted
            icon?.let { addView(pvIcon(it, fg, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = if (text.isEmpty()) 0 else Pv.rem(0.375f) }) }
            if (text.isNotEmpty()) addView(pvText(text, 0.8125f, fg, maxLines = 1))
            if (on) Pv.pressable(this, Pv.mix(color, Pv.c.panel, 22), 0.9375f, onClick = onClick)
            else Pv.pressable(this, Pv.c.panel, 0.9375f, Pv.c.line2, onClick)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(1.875f)).apply { rightMargin = Pv.rem(0.375f) }
        }

    /** Фон поля: `color-mix(bg 55%, panel)`. */
    fun boardFill(): Int = Pv.mix(Pv.c.bg, Pv.c.panel, 55)

    /** Точечная сетка поля (клетка 22 при масштабе 1, точка 1 px цвета line2), едет вместе с полем. */
    fun drawDots(canvas: Canvas, width: Int, height: Int, scale: Float, ox: Float, oy: Float, paint: Paint) {
        // Мелкий масштаб — шаг сетки удваивается, а не пропадает (web рисует точки при любом масштабе)
        var cell = 22f * Pv.px(1f) * scale
        if (cell <= 0f) return
        while (cell < Pv.px(10f)) cell *= 2
        paint.color = Pv.c.line2
        paint.style = Paint.Style.FILL
        val r = Pv.px(1f).toFloat().coerceAtLeast(1f)
        var x = ((ox % cell) + cell) % cell
        while (x < width) {
            var y = ((oy % cell) + cell) % cell
            while (y < height) {
                canvas.drawCircle(x, y, r, paint)
                y += cell
            }
            x += cell
        }
    }
}
