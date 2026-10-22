package org.thunderdog.challegram.parvane.sections

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.InputType
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import kotlin.math.max
import kotlin.math.min

/**
 * Parvane (spec 031, T065): холст «Знаний» (JSON Canvas, общий с web/desktop) — карточки текста, файлов,
 * ссылок и группы, связи. Сдвиг и масштаб пальцами; карточку можно перетащить, нажатие — правка текста,
 * связь с другой карточкой, удаление; долгое нажатие на пустом месте — новая карточка. Сохранение — `saveCanvas`
 * через секунду после правки. Неизвестные поля узлов сохраняются как были.
 */
class CanvasController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section = "knowledge"
    override val tab = ParvaneTabBar.Tab.KNOWLEDGE
    override fun getId() = R.id.controller_parvaneGraph
    override fun getName(): CharSequence = title.ifEmpty { Sx.t("Холст", "Canvas") }

    private var canvasId = ""
    private var title = ""
    private var board: BoardView? = null

    companion object {
        fun open(owner: ViewController<*>, id: String) =
            owner.navigateTo(CanvasController(owner.context(), owner.tdlib()).also { it.canvasId = id })
    }

    override fun onBuilt() {
        watch("notes") { snap ->
            val c = Sx.list(snap.optJSONArray("canvases")).firstOrNull { it.optString("id") == canvasId } ?: return@watch
            title = c.optString("title")
            if (board == null) {
                val doc = try { JSONObject(c.optString("text").ifEmpty { "{}" }) } catch (e: Throwable) { JSONObject() }
                val view = BoardView(context(), doc) { save(it) }
                board = view
                rebuild {
                    addView(context.label(Sx.t("Долгое нажатие на пустом месте — новая карточка; карточку можно перетащить",
                        "Long-press empty space to add a card; drag cards to move"), 12f, ColorId.textLight).apply {
                        layoutParams = lp(t = Sx.dp(8f), l = Sx.dp(16f), r = Sx.dp(16f))
                    })
                    addView(view, lp(h = Sx.dp(560f), t = Sx.dp(8f)))
                }
            }
        }
    }

    private var pending: Runnable? = null
    private fun save(doc: JSONObject) {
        pending?.let { Sx.main.removeCallbacks(it) }
        pending = Runnable {
            val args = JSONObject().put("id", canvasId).put("title", title).put("text", doc.toString())
            Sx.async({ ParvaneSections.notes("saveCanvas", args.toString()) }) { r ->
                if (r == null) toast(Sx.t("Холст не сохранён — нет связи?", "Canvas not saved — offline?"))
            }
        }.also { Sx.main.postDelayed(it, 1000) }
    }

    @SuppressLint("ViewConstructor")
    class BoardView(context: Context, private val doc: JSONObject, private val changed: (JSONObject) -> Unit) : View(context) {
        private val nodes: JSONArray = doc.optJSONArray("nodes") ?: JSONArray().also { doc.put("nodes", it) }
        private val edges: JSONArray = doc.optJSONArray("edges") ?: JSONArray().also { doc.put("edges", it) }
        private var scale = 0.6f
        private var ox = 0f
        private var oy = 0f
        private var fitted = false
        private var dragging: JSONObject? = null
        private var connectFrom: String? = null
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = Sx.dp(1.5f).toFloat() }
        private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = Sx.dp(13f).toFloat() }

        private fun list() = (0 until nodes.length()).mapNotNull { nodes.optJSONObject(it) }
        private fun rect(n: JSONObject) = RectF(n.optDouble("x").toFloat(), n.optDouble("y").toFloat(),
            (n.optDouble("x") + n.optDouble("width", 250.0)).toFloat(), (n.optDouble("y") + n.optDouble("height", 60.0)).toFloat())
        private fun screen(r: RectF) = RectF(r.left * scale + ox, r.top * scale + oy, r.right * scale + ox, r.bottom * scale + oy)
        private fun world(x: Float, y: Float) = ((x - ox) / scale) to ((y - oy) / scale)

        private fun label(n: JSONObject): String = when (n.optString("type")) {
            "file" -> "📄 " + n.optString("file").substringAfterLast('/')
            "link" -> "🔗 " + n.optString("url")
            "group" -> n.optString("label")
            else -> n.optString("text")
        }

        override fun onDraw(canvas: Canvas) {
            canvas.drawColor(Sx.color(ColorId.background))
            val all = list()
            if (!fitted && width > 0 && all.isNotEmpty()) {
                fitted = true
                val rs = all.map { rect(it) }
                val l = rs.minOf { it.left }; val r = rs.maxOf { it.right }
                val t = rs.minOf { it.top }; val b = rs.maxOf { it.bottom }
                scale = min(width / max(r - l + 80f, 1f), height / max(b - t + 80f, 1f)).coerceIn(0.15f, 1.5f)
                ox = width / 2f - (l + r) / 2f * scale
                oy = height / 2f - (t + b) / 2f * scale
            }
            val byId = all.associateBy { it.optString("id") }
            stroke.color = Sx.color(ColorId.iconLight)
            for (i in 0 until edges.length()) {
                val e = edges.optJSONObject(i) ?: continue
                val a = byId[e.optString("fromNode")]?.let { screen(rect(it)) } ?: continue
                val b = byId[e.optString("toNode")]?.let { screen(rect(it)) } ?: continue
                canvas.drawLine(a.centerX(), a.centerY(), b.centerX(), b.centerY(), stroke)
            }
            all.sortedBy { if (it.optString("type") == "group") 0 else 1 }.forEach { n ->
                val r = screen(rect(n))
                val radius = Sx.dp(10f) * scale
                if (n.optString("type") == "group") {
                    stroke.color = Sx.color(ColorId.iconActive)
                    canvas.drawRoundRect(r, radius, radius, stroke)
                    text.color = Sx.color(ColorId.textLight)
                    canvas.drawText(label(n), r.left + Sx.dp(6f), r.top - Sx.dp(4f), text)
                    return@forEach
                }
                fill.color = Sx.color(if (n.optString("id") == connectFrom) ColorId.fillingPositive else ColorId.filling)
                canvas.drawRoundRect(r, radius, radius, fill)
                stroke.color = Sx.color(ColorId.separator)
                canvas.drawRoundRect(r, radius, radius, stroke)
                text.color = Sx.color(ColorId.text)
                text.textSize = Sx.dp(13f) * scale.coerceIn(0.4f, 1.6f)
                val w = (r.width() - Sx.dp(12f)).toInt().coerceAtLeast(1)
                val layout = StaticLayout.Builder.obtain(label(n), 0, label(n).length, text, w).setAlignment(Layout.Alignment.ALIGN_NORMAL)
                    .setMaxLines(max(1, (r.height() / (text.textSize * 1.3f)).toInt())).setEllipsize(android.text.TextUtils.TruncateAt.END).build()
                canvas.save()
                canvas.clipRect(r)
                canvas.translate(r.left + Sx.dp(6f), r.top + Sx.dp(6f))
                layout.draw(canvas)
                canvas.restore()
            }
        }

        private fun hit(x: Float, y: Float): JSONObject? =
            list().filter { it.optString("type") != "group" }.lastOrNull { screen(rect(it)).contains(x, y) }

        private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(d: ScaleGestureDetector): Boolean {
                val next = (scale * d.scaleFactor).coerceIn(0.1f, 3f)
                ox = d.focusX - (d.focusX - ox) * next / scale
                oy = d.focusY - (d.focusY - oy) * next / scale
                scale = next
                invalidate()
                return true
            }
        })

        private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean {
                dragging = hit(e.x, e.y)
                return true
            }
            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
                val d = dragging
                if (d != null) {
                    d.put("x", d.optDouble("x") - dx / scale)
                    d.put("y", d.optDouble("y") - dy / scale)
                    moved = true
                } else { ox -= dx; oy -= dy }
                invalidate()
                return true
            }
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                val n = hit(e.x, e.y) ?: return true
                val from = connectFrom
                if (from != null) {
                    if (from != n.optString("id")) {
                        edges.put(JSONObject().put("id", java.util.UUID.randomUUID().toString().take(16)).put("fromNode", from).put("toNode", n.optString("id")))
                        changed(doc)
                    }
                    connectFrom = null
                    invalidate()
                    return true
                }
                menu(n)
                return true
            }
            override fun onLongPress(e: MotionEvent) {
                if (hit(e.x, e.y) != null) return
                val (wx, wy) = world(e.x, e.y)
                edit("") { t ->
                    nodes.put(JSONObject().put("id", java.util.UUID.randomUUID().toString().take(16)).put("type", "text").put("text", t)
                        .put("x", wx.toInt()).put("y", wy.toInt()).put("width", 260).put("height", 120))
                    changed(doc)
                    invalidate()
                }
            }
        })

        private var moved = false

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(event: MotionEvent): Boolean {
            parent?.requestDisallowInterceptTouchEvent(true)
            scaler.onTouchEvent(event)
            if (!scaler.isInProgress) gestures.onTouchEvent(event)
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                if (moved) changed(doc)
                moved = false
                dragging = null
            }
            return true
        }

        private fun menu(n: JSONObject) {
            val items = mutableListOf<Pair<String, () -> Unit>>()
            if (n.optString("type") == "text") items += Sx.t("Изменить текст", "Edit text") to { edit(n.optString("text")) { t -> n.put("text", t); changed(doc); invalidate() } }
            items += Sx.t("Связать с карточкой…", "Connect to card…") to { connectFrom = n.optString("id"); invalidate(); Unit }
            items += Sx.t("Удалить", "Delete") to {
                val id = n.optString("id")
                val keep = JSONArray()
                for (i in 0 until nodes.length()) nodes.optJSONObject(i)?.takeIf { it.optString("id") != id }?.let { keep.put(it) }
                doc.put("nodes", keep)
                val keepEdges = JSONArray()
                for (i in 0 until edges.length()) edges.optJSONObject(i)?.takeIf { it.optString("fromNode") != id && it.optString("toNode") != id }?.let { keepEdges.put(it) }
                doc.put("edges", keepEdges)
                changed(doc)
                (parent as? android.view.ViewGroup)?.let { p ->
                    val idx = p.indexOfChild(this)
                    p.removeView(this)
                    p.addView(BoardView(context, doc, changed), idx, layoutParams)
                }
            }
            AlertDialog.Builder(context, Theme.dialogTheme()).setTitle(label(n).take(60))
                .setItems(items.map { it.first }.toTypedArray()) { _, which -> items[which].second() }.show()
        }

        private fun edit(value: String, done: (String) -> Unit) {
            val input = EditText(context).apply {
                setText(value)
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                minLines = 3
                setTextColor(Sx.color(ColorId.text))
            }
            AlertDialog.Builder(context, Theme.dialogTheme()).setTitle(Sx.t("Карточка", "Card"))
                .setView(FrameLayout(context).apply { setPadding(Sx.dp(20f), 0, Sx.dp(20f), 0); addView(input) })
                .setPositiveButton(android.R.string.ok) { _, _ -> done(input.text.toString()) }
                .setNegativeButton(Sx.t("Отмена", "Cancel"), null).show()
        }
    }
}
