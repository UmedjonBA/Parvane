package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.DashPathEffect
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.PathParser
import org.thunderdog.challegram.theme.Theme
import org.thunderdog.challegram.theme.ThemeManager
import org.thunderdog.challegram.tool.Fonts

/**
 * Parvane (spec 032): вид телефонной версии web 1:1. Тона — переменные `--pv-*` схемы текущей темы
 * ([PvPalette], генерируется из `colorScheme.ts`), значки — линейные значки web ([PvIcons]), размеры — в rem web
 * (1 rem = 16 dp: телефон web шириной 360 CSS px = 360 dp), шрифты — Plex X. Детали повторяют `PvKit.module.scss`.
 */
object Pv {
    class Set(
        val bg: Int, val panel: Int, val raised: Int, val hover: Int, val line: Int, val line2: Int,
        val fg: Int, val muted: Int, val faint: Int,
        val accent: Int, val accentInk: Int, val blue: Int, val purple: Int, val orange: Int, val aqua: Int,
        val green: Int, val red: Int, val yellow: Int,
    ) {
        // Виды записей, как в web
        val event get() = blue
        val task get() = purple
        val food get() = orange
        val sleep get() = aqua
        val workout get() = green
        val note get() = yellow
        val metric get() = red
    }

    /** Тона текущей темы X; своя тема — по базовой, иначе Gruvbox светлая/тёмная. */
    val c: Set
        get() {
            val id = try { ThemeManager.instance().currentThemeId() } catch (e: Throwable) { 11 }
            return PvPalette.byTheme[id]
                ?: PvPalette.byTheme[try { ThemeManager.resolveCustomThemeId(id) } catch (e: Throwable) { -1 }]
                ?: PvPalette.byTheme.getValue(if (Theme.isDark()) 10 else 11)
        }

    fun rem(r: Float): Int = Sx.dp(r * 16f)

    /**
     * Перекрасить вид, когда X сменит тему (ночной режим по системе/датчику, выбор в «Оформлении»): наши виды берут
     * цвета [c] при создании, сами они не перекрашиваются. Слушатель держится, пока вид в окне; вид, снятый с экрана
     * во время смены, перекрашивается при возвращении.
     */
    fun onTheme(view: View, recolor: () -> Unit) {
        var builtFor = themeId()
        fun sync() { val id = themeId(); if (id != builtFor) { builtFor = id; recolor() } }
        val listener = object : org.thunderdog.challegram.theme.ThemeChangeListener {
            override fun needsTempUpdates() = false
            override fun onThemeColorsChanged(areTemp: Boolean, state: org.thunderdog.challegram.theme.ColorState?) {}
            override fun onThemeChanged(fromTheme: org.thunderdog.challegram.theme.ThemeDelegate, toTheme: org.thunderdog.challegram.theme.ThemeDelegate) {
                view.post { sync() }
                // X переключает тему с анимацией: номер темы (и [c]) новый сразу, а Theme.getColor ещё ~0,3 с отдаёт
                // промежуточные цвета — видам на цветах X (экран входа) нужна вторая перекраска после неё
                view.postDelayed({ if (view.isAttachedToWindow) recolor() }, 700)
            }
        }
        view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) { ThemeManager.instance().addThemeListener(listener); v.post { sync() } }
            override fun onViewDetachedFromWindow(v: View) { ThemeManager.instance().removeThemeListener(listener) }
        })
        if (view.isAttachedToWindow) ThemeManager.instance().addThemeListener(listener)
    }

    private fun themeId(): Int = try { ThemeManager.instance().currentThemeId() } catch (e: Throwable) { 11 }

    /** Значки шрифта Telegram, которые web рисует в «Плане» (`eats`, `darkmode`, флажок срока, часы), — линейными контурами. */
    val extraIcons: Map<String, List<PvIcons.S>> = mapOf(
        "eats" to listOf(PvIcons.S("M12 7.5c-1.6-1.4-6.5-1.4-6.5 3.5 0 4.2 2.6 9 4.8 9 .9 0 1.1-.5 1.7-.5s.8.5 1.7.5c2.2 0 4.8-4.8 4.8-9 0-4.9-4.9-4.9-6.5-3.5z"),
            PvIcons.S("M12 7.5c0-2.2 1.1-3.6 2.8-4.3")),
        "moon" to listOf(PvIcons.S("M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"), PvIcons.S("M17 3v3M15.5 4.5h3")),
        "flag" to listOf(PvIcons.S("M6 21V4"), PvIcons.S("M6 4h11l-2.5 4 2.5 4H6")),
        "clock" to listOf(PvIcons.S("M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z"), PvIcons.S("M12 7v5l3 2")),
        "archive" to listOf(PvIcons.S("M3 4h18v4H3z"), PvIcons.S("M5 8v12h14V8M10 12h4")),
        "repeat" to listOf(PvIcons.S("M17 2l3 3-3 3"), PvIcons.S("M4 11V9a4 4 0 0 1 4-4h12"), PvIcons.S("M7 22l-3-3 3-3"), PvIcons.S("M20 13v2a4 4 0 0 1-4 4H4")),
        "alarm" to listOf(PvIcons.S("M12 6a7 7 0 1 0 0 14a7 7 0 1 0 0-14z"), PvIcons.S("M12 10v3l2 1.5M5 3L2 6M19 3l3 3")),
        "settings" to listOf(PvIcons.S("M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z"),
            PvIcons.S("M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z")),
    )
    fun px(p: Float): Int = Sx.dp(p)

    fun regular(): Typeface = Fonts.getRobotoRegular()
    fun semibold(): Typeface = Fonts.getRobotoMedium()
    fun mono(): Typeface = Fonts.getRobotoMono()

    /** Смешение цвета с прозрачным: `color-mix(in srgb, c p%, transparent)`. */
    fun alpha(color: Int, percent: Int): Int = (color and 0x00ffffff) or ((0xff * percent / 100) shl 24)

    fun mix(a: Int, b: Int, percentA: Int): Int {
        fun ch(shift: Int) = (((a shr shift) and 0xff) * percentA + ((b shr shift) and 0xff) * (100 - percentA)) / 100
        return (0xff shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    fun shape(fill: Int, radiusRem: Float, stroke: Int = 0, strokePx: Float = 1f): GradientDrawable = GradientDrawable().apply {
        cornerRadius = rem(radiusRem).toFloat()
        setColor(fill)
        if (stroke != 0) setStroke(px(strokePx), stroke)
    }

    fun pressable(view: View, fill: Int, radiusRem: Float, stroke: Int = 0, onClick: (() -> Unit)?) {
        val base = shape(fill, radiusRem, stroke)
        view.background = RippleDrawable(ColorStateList.valueOf(alpha(c.fg, 12)), base, shape(0xff000000.toInt(), radiusRem))
        if (onClick != null) {
            view.isClickable = true
            view.setOnClickListener { onClick() }
        }
    }
}

/** Линейный значок web: поле 24×24, обводка 1,8, концы и стыки круглые. */
class PvIconDrawable(name: String, private var color: Int, private val sizePx: Int, private val stroke: Float = 1.8f) : Drawable() {
    private val shapes = (PvIcons.all[name] ?: Pv.extraIcons[name] ?: PvIcons.all.getValue("note")).map { s ->
        Triple(PathParser.createPathFromPathData(s.d), s.filled, s.dashed)
    }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val scaled = Path()
    private val matrix = Matrix()

    fun setTintColor(c: Int) { color = c; invalidateSelf() }

    override fun draw(canvas: Canvas) {
        val b = bounds
        val k = minOf(b.width(), b.height()) / 24f
        matrix.setScale(k, k)
        matrix.postTranslate(b.left + (b.width() - 24f * k) / 2f, b.top + (b.height() - 24f * k) / 2f)
        for ((path, filled, dashed) in shapes) {
            scaled.reset()
            path.transform(matrix, scaled)
            paint.color = color
            paint.style = if (filled) Paint.Style.FILL else Paint.Style.STROKE
            paint.strokeWidth = stroke * k
            paint.pathEffect = if (dashed) DashPathEffect(floatArrayOf(3f * k, 3f * k), 0f) else null
            canvas.drawPath(scaled, paint)
        }
    }

    override fun getIntrinsicWidth() = sizePx
    override fun getIntrinsicHeight() = sizePx
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

// ── построители ──────────────────────────────────────────────────────────────────

fun Context.pvText(text: CharSequence, sizeRem: Float = 0.9375f, color: Int = Pv.c.fg, semibold: Boolean = false,
                   maxLines: Int = 0, mono: Boolean = false): TextView = TextView(this).apply {
    this.text = text
    setTextSize(TypedValue.COMPLEX_UNIT_DIP, sizeRem * 16f)
    setTextColor(color)
    typeface = if (mono) Pv.mono() else if (semibold) Pv.semibold() else Pv.regular()
    includeFontPadding = false
    setLineSpacing(0f, 1.2f)
    if (maxLines > 0) {
        this.maxLines = maxLines
        ellipsize = TextUtils.TruncateAt.END
    }
}

fun Context.pvIcon(name: String, color: Int = Pv.c.muted, sizeRem: Float = 1.375f): ImageView = ImageView(this).apply {
    setImageDrawable(PvIconDrawable(name, color, Pv.rem(sizeRem)))
    scaleType = ImageView.ScaleType.CENTER
    layoutParams = LinearLayout.LayoutParams(Pv.rem(sizeRem), Pv.rem(sizeRem))
}

/** `.ib` — круглая кнопка-значок 2,25 rem. */
fun Context.pvIconButton(name: String, description: String, color: Int = Pv.c.muted, onClick: () -> Unit): FrameLayout =
    FrameLayout(this).apply {
        contentDescription = description
        addView(pvIcon(name, color), FrameLayout.LayoutParams(Pv.rem(1.375f), Pv.rem(1.375f), Gravity.CENTER))
        Pv.pressable(this, 0, 1.125f, onClick = onClick)
        layoutParams = LinearLayout.LayoutParams(Pv.rem(2.25f), Pv.rem(2.25f))
    }

/** `.pill` / `.pillAcc` — 2,125 rem, радиус половина высоты. */
fun Context.pvPill(text: String, accent: Boolean = false, icon: String? = null, onClick: () -> Unit): LinearLayout =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(0.875f), 0, Pv.rem(0.875f), 0)
        val fg = if (accent) Pv.c.accentInk else Pv.c.fg
        icon?.let { addView(pvIcon(it, fg, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.375f) }) }
        addView(pvText(text, 0.875f, fg, semibold = accent))
        Pv.pressable(this, if (accent) Pv.c.accent else Pv.c.raised, 1.0625f, onClick = onClick)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.125f))
    }

/** `.btn` (`acc`, `ghost`, `danger`, `wide`) — 2,25 rem, радиус 0,5 rem. */
fun Context.pvButton(text: String, kind: String = "", wide: Boolean = false, icon: String? = null, onClick: () -> Unit): LinearLayout =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = if (wide) Gravity.CENTER else Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(0.875f), 0, Pv.rem(0.875f), 0)
        val (fill, fg) = when (kind) {
            "acc" -> Pv.c.accent to Pv.c.accentInk
            "ghost" -> 0 to Pv.c.muted
            "danger" -> 0 to Pv.c.red
            else -> Pv.c.hover to Pv.c.fg
        }
        icon?.let { addView(pvIcon(it, fg, 1.125f).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.375f) }) }
        addView(pvText(text, 0.875f, fg, semibold = kind == "acc"))
        Pv.pressable(this, fill, 0.5f, onClick = onClick)
        layoutParams = LinearLayout.LayoutParams(if (wide) ViewGroup.LayoutParams.MATCH_PARENT else ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.25f))
    }

/** `.chip` / `.chipOn` — 1,875 rem, рамка line2; выбранный — заливка цвета 22 %. */
fun Context.pvChip(text: String, on: Boolean, color: Int = Pv.c.accent, dot: Boolean = false, onClick: () -> Unit): LinearLayout =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
        if (dot) addView(View(context).apply {
            background = Pv.shape(color, 0.25f)
            layoutParams = LinearLayout.LayoutParams(Pv.rem(0.5f), Pv.rem(0.5f)).apply { rightMargin = Pv.rem(0.375f) }
        })
        addView(pvText(text, 0.8125f, if (on) color else Pv.c.muted))
        if (on) Pv.pressable(this, Pv.alpha(color, 22), 0.9375f, onClick = onClick)
        else Pv.pressable(this, 0, 0.9375f, Pv.c.line2, onClick)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(1.875f))
    }

/** Шапка раздела на телефоне (`.hdr`): мин. 3,5 rem, отступы 0,5/0,75 rem, линия снизу. */
fun Context.pvHeader(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = Pv.rem(3.5f)
    setPadding(Pv.rem(0.75f), Pv.rem(0.5f), Pv.rem(0.75f), Pv.rem(0.5f))
    background = pvBottomLine(Pv.c.panel)
}

/** Заливка с линией `--pv-line` снизу. */
fun pvBottomLine(fill: Int): Drawable = android.graphics.drawable.LayerDrawable(arrayOf(
    GradientDrawable().apply { setColor(Pv.c.line) },
    GradientDrawable().apply { setColor(fill) },
)).apply { setLayerInset(1, 0, 0, 0, Pv.px(1f)) }

/** Вкладки телефона (`.seg` ≤ 760 px): подчёркнутые, 2,625 rem, 1 rem semibold. */
fun Context.pvTabs(items: List<Pair<String, String>>, current: String, onPick: (String) -> Unit): LinearLayout =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.BOTTOM
        for ((key, title) in items) {
            val on = key == current
            addView(pvText(title, 1f, if (on) Pv.c.fg else Pv.c.muted, semibold = true).apply {
                gravity = Gravity.CENTER
                setPadding(Pv.rem(0.625f), 0, Pv.rem(0.625f), 0)
                // Подчёркивание акцентом снизу (`.tab.active::after`), а не заливка вкладки
                background = if (on) android.graphics.drawable.LayerDrawable(arrayOf(
                    GradientDrawable().apply { setColor(Pv.c.accent); cornerRadius = Pv.px(1.5f).toFloat() },
                )).apply { setLayerGravity(0, Gravity.BOTTOM or Gravity.FILL_HORIZONTAL); setLayerHeight(0, Pv.px(3f)) } else null
                isClickable = true
                setOnClickListener { onPick(key) }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(2.625f)).apply { rightMargin = Pv.rem(0.125f) }
            })
        }
    }

/** Карточка «Профиля» (`.card`): фон raised, радиус 0,75 rem, отступ 0,375 rem. */
fun Context.pvCard(padRem: Float = 0.375f): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(Pv.rem(padRem), Pv.rem(padRem), Pv.rem(padRem), Pv.rem(padRem))
    background = Pv.shape(Pv.c.raised, 0.75f)
}

/** Подпись над карточкой (`.caption`): 0,8125 rem muted. */
fun Context.pvCaption(text: String): TextView = pvText(text, 0.8125f, Pv.c.muted).apply {
    setPadding(Pv.rem(0.25f), 0, Pv.rem(0.25f), 0)
}

/**
 * Строка с плиткой-значком (`.row` + `.tile`): мин. 2,75 rem, плитка 2,25 rem цвета [tone] 22 %, название
 * 0,9375 rem, подпись 0,8125 rem muted, справа — стрелка либо [trailing].
 */
fun Context.pvTileRow(icon: String, title: String, subtitle: String? = null, tone: Int = Pv.c.accent, danger: Boolean = false,
                      trailing: View? = null, chevron: Boolean = trailing == null, onClick: (() -> Unit)?): LinearLayout =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = Pv.rem(2.75f)
        setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
        val c = Pv.c
        val color = if (danger) c.red else tone
        addView(FrameLayout(context).apply {
            background = Pv.shape(Pv.alpha(color, if (danger) 18 else 22), 0.625f)
            addView(pvIcon(icon, color, 1.125f), FrameLayout.LayoutParams(Pv.rem(1.125f), Pv.rem(1.125f), Gravity.CENTER))
        }, LinearLayout.LayoutParams(Pv.rem(2.25f), Pv.rem(2.25f)).apply { rightMargin = Pv.rem(0.75f) })
        val texts = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(pvText(title, 0.9375f, if (danger) c.red else c.fg, maxLines = 1))
        subtitle?.takeIf { it.isNotEmpty() }?.let { texts.addView(pvText(it, 0.8125f, c.muted, maxLines = 1)) }
        addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        trailing?.let { addView(it) }
        if (chevron) addView(pvIcon("right", Pv.alpha(c.fg, 85), 1.125f))
        Pv.pressable(this, 0, 0.5f, onClick = onClick)
    }

/** Переключатель в духе web (дорожка и кружок с обводкой акцента). */
fun Context.pvSwitch(on: Boolean, onChange: (Boolean) -> Unit): View = android.widget.Switch(this).apply {
    isChecked = on
    val c = Pv.c
    thumbTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(c.panel, c.muted))
    trackTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(c.accent, c.line2))
    setOnCheckedChangeListener { _, v -> onChange(v) }
}

/** Круглый аватар без фото, как web: буква на градиенте цвета собеседника. */
class PvAvatar(context: Context, letter: String, color: Int, private val sizePx: Int) : View(context) {
    private val text = letter.take(1).uppercase()
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = 0xffffffff.toInt()
        typeface = Pv.semibold()
        textAlign = Paint.Align.CENTER
        textSize = sizePx * 0.42f
    }
    private val top = Pv.mix(0xffffffff.toInt(), color, 25)
    private val bottom = color

    override fun onDraw(canvas: Canvas) {
        val r = minOf(width, height) / 2f
        fill.shader = android.graphics.LinearGradient(0f, 0f, 0f, height.toFloat(), top, bottom, android.graphics.Shader.TileMode.CLAMP)
        canvas.drawCircle(width / 2f, height / 2f, r, fill)
        val y = height / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(text, width / 2f, y, paint)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) = setMeasuredDimension(sizePx, sizePx)
}

/**
 * Экран без шапки X (своя шапка, как web): контейнер навигации X держит сверху отступ под шапку для любого экрана —
 * корень растягивается вверх на высоту шапки и рисуется в этом отступе.
 */
fun View.coverHeaderArea() {
    addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) {
            (v.parent as? ViewGroup)?.clipToPadding = false
            (v.layoutParams as? ViewGroup.MarginLayoutParams)?.let { lp ->
                val top = -org.thunderdog.challegram.navigation.HeaderView.getSize(false)
                if (lp.topMargin != top) { lp.topMargin = top; v.layoutParams = lp }
            }
        }
        override fun onViewDetachedFromWindow(v: View) {}
    })
}
