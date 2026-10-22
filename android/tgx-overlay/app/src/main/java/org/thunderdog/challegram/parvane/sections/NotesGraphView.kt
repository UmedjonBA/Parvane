package org.thunderdog.challegram.parvane.sections

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import org.json.JSONObject
import org.thunderdog.challegram.theme.ColorId
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Parvane (spec 031, T065): граф заметок «Знаний» — узлы-заметки, рёбра — ссылки `[[…]]`; раскладка силами
 * (отталкивание узлов, притяжение по рёбрам, тяга к центру) считается один раз при построении. Сдвиг пальцем,
 * масштаб щипком, нажатие на узел открывает заметку. Размер узла — по числу связей.
 */
@SuppressLint("ViewConstructor")
class NotesGraphView(context: Context, notes: List<JSONObject>, private val onOpen: (String) -> Unit) : View(context) {
    private class Node(val id: String, val title: String, var x: Float, var y: Float, var degree: Int = 0)

    private val nodes: List<Node>
    private val edges = mutableListOf<Pair<Int, Int>>()
    private val nodePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeWidth = Sx.dp(1f).toFloat() }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = Sx.dp(11f).toFloat(); textAlign = Paint.Align.CENTER }
    private var scale = 1f
    private var offsetX = 0f
    private var offsetY = 0f
    private var centered = false

    init {
        val rnd = java.util.Random(7)
        nodes = notes.map { Node(it.optString("id"), it.optString("title"), rnd.nextFloat() * 400 - 200, rnd.nextFloat() * 400 - 200) }
        val byTitle = nodes.withIndex().associate { (i, n) -> n.title.lowercase() to i }
        notes.forEachIndexed { i, n ->
            NoteText.links(n.optString("text")).mapNotNull { byTitle[it.lowercase()] }.filter { it != i }.forEach { j ->
                if (edges.none { (a, b) -> (a == i && b == j) || (a == j && b == i) }) edges += i to j
            }
        }
        edges.forEach { (a, b) -> nodes[a].degree++; nodes[b].degree++ }
        layout()
        contentDescription = Sx.t("Граф заметок", "Notes graph")
    }

    private fun layout() {
        val n = nodes.size
        if (n == 0) return
        val k = 60f
        repeat(if (n > 300) 80 else 220) { step ->
            val t = 12f * (1f - step / 220f) + 1f
            val dx = FloatArray(n)
            val dy = FloatArray(n)
            for (i in 0 until n) for (j in i + 1 until n) {
                val ax = nodes[i].x - nodes[j].x
                val ay = nodes[i].y - nodes[j].y
                val d2 = max(ax * ax + ay * ay, 1f)
                val f = k * k / d2
                dx[i] += ax * f; dy[i] += ay * f
                dx[j] -= ax * f; dy[j] -= ay * f
            }
            edges.forEach { (a, b) ->
                val ax = nodes[a].x - nodes[b].x
                val ay = nodes[a].y - nodes[b].y
                val d = sqrt(ax * ax + ay * ay).coerceAtLeast(1f)
                val f = d / k
                dx[a] -= ax * f; dy[a] -= ay * f
                dx[b] += ax * f; dy[b] += ay * f
            }
            for (i in 0 until n) {
                dx[i] -= nodes[i].x * 0.02f
                dy[i] -= nodes[i].y * 0.02f
                val len = sqrt(dx[i] * dx[i] + dy[i] * dy[i]).coerceAtLeast(0.01f)
                nodes[i].x += dx[i] / len * min(len, t)
                nodes[i].y += dy[i] / len * min(len, t)
            }
        }
    }

    private fun radius(n: Node) = Sx.dp(5f) + min(n.degree, 10) * Sx.dp(1f).toFloat()
    private fun sx(x: Float) = x * scale + offsetX
    private fun sy(y: Float) = y * scale + offsetY

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Sx.color(ColorId.filling))
        if (nodes.isEmpty()) {
            textPaint.color = Sx.color(ColorId.textLight)
            canvas.drawText(Sx.t("Заметок пока нет", "No notes yet"), width / 2f, height / 2f, textPaint)
            return
        }
        if (!centered && width > 0) {
            centered = true
            val minX = nodes.minOf { it.x }; val maxX = nodes.maxOf { it.x }
            val minY = nodes.minOf { it.y }; val maxY = nodes.maxOf { it.y }
            scale = min(width / max(maxX - minX + 120f, 1f), height / max(maxY - minY + 120f, 1f)).coerceIn(0.2f, 2.5f)
            offsetX = width / 2f - (minX + maxX) / 2f * scale
            offsetY = height / 2f - (minY + maxY) / 2f * scale
        }
        edgePaint.color = Sx.color(ColorId.separator)
        edges.forEach { (a, b) -> canvas.drawLine(sx(nodes[a].x), sy(nodes[a].y), sx(nodes[b].x), sy(nodes[b].y), edgePaint) }
        nodePaint.color = Sx.color(ColorId.iconActive)
        textPaint.color = Sx.color(ColorId.text)
        nodes.forEach { n ->
            canvas.drawCircle(sx(n.x), sy(n.y), radius(n) * min(scale, 1.6f).coerceAtLeast(0.6f), nodePaint)
            if (scale > 0.55f) canvas.drawText(n.title.take(24), sx(n.x), sy(n.y) - radius(n) - Sx.dp(4f), textPaint)
        }
    }

    private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean {
            val next = (scale * d.scaleFactor).coerceIn(0.15f, 4f)
            offsetX = d.focusX - (d.focusX - offsetX) * next / scale
            offsetY = d.focusY - (d.focusY - offsetY) * next / scale
            scale = next
            invalidate()
            return true
        }
    })

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            offsetX -= dx; offsetY -= dy
            invalidate()
            return true
        }
        override fun onSingleTapUp(e: MotionEvent): Boolean {
            val hit = nodes.minByOrNull { n -> (sx(n.x) - e.x).let { it * it } + (sy(n.y) - e.y).let { it * it } } ?: return false
            val d = sqrt((sx(hit.x) - e.x).let { it * it } + (sy(hit.y) - e.y).let { it * it })
            if (d < Sx.dp(28f)) onOpen(hit.id)
            return true
        }
    })

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        scaler.onTouchEvent(event)
        if (!scaler.isInProgress) gestures.onTouchEvent(event)
        return true
    }
}
