package org.thunderdog.challegram.parvane.sections

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import org.json.JSONObject
import org.thunderdog.challegram.parvane.sections.Kn.boardChip
import org.thunderdog.challegram.parvane.sections.Kn.boardTool
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Parvane (spec 032): граф «Знаний» 1:1 с web (`notesGraph.ts`, `NotesGraph.tsx`): узлы — заметки (цвет папки),
 * заметки, которых ещё нет (бледные), заметки дней и записи «Плана» по переключателям; связи — `[[ссылки]]` со
 * стрелкой, взаимные — с двумя. Раскладка Fruchterman–Reingold с гравитацией к центру, длина связи 70, зерно 1 —
 * та же, что в web; поле вписывается в экран при открытии. Точечный фон, подписи под точками (с масштаба 0,55),
 * выбранная точка подсвечивает соседей. Нажатие — выбрать, повторное (или «Открыть») — открыть заметку.
 */
object NotesGraph {
    const val SPRING = 70.0
    const val GRAVITY = 0.8
    const val ATTRACTION = 0.6
    const val ITERATIONS = 400
    const val WORK_BUDGET = 50_000_000.0
    const val MARGIN = 24.0
    const val MIN_RADIUS = 6f
    const val MAX_RADIUS = 28f
    const val ARROW = 7f
    const val EDGE_GAP = 3f
    private const val START_TEMPERATURE = 40.0
    private const val COOLING = 0.99
    private const val START_SPREAD = 300.0
    private const val MIN_DISTANCE = 4.0
    const val MISSING = "missing:"

    class Node(val id: String, val title: String, val kind: String, val group: String, var degree: Int = 0, var x: Double = 0.0, var y: Double = 0.0)
    class Edge(val from: String, val to: String, var isMutual: Boolean = false)
    class Graph(val nodes: List<Node>, val edges: List<Edge>)
    class Input(val id: String, val title: String, val folder: String, val links: List<String>, val isDaily: Boolean)
    class Record(val id: String, val title: String, val links: List<String>, val type: String)

    private fun titleKey(t: String) = t.trim().lowercase()

    /** Граф из заметок и записей «Плана» (как `buildGraph`). */
    fun build(notes: List<Input>, records: List<Record>, withDays: Boolean, withRecords: Boolean): Graph {
        val nodes = mutableListOf<Node>()
        val byId = HashMap<String, Node>()
        val noteIdByTitle = HashMap<String, String>()
        val hidden = HashSet<String>()
        val edges = mutableListOf<Edge>()
        val edgeByKey = HashMap<String, Edge>()
        fun add(id: String, title: String, kind: String, group: String) {
            val n = Node(id, title, kind, group)
            nodes += n
            byId[id] = n
        }
        fun resolve(link: String): String? {
            val key = titleKey(link)
            if (key.isEmpty() || key in hidden) return null
            noteIdByTitle[key]?.let { return it }
            val id = MISSING + key
            if (id !in byId) add(id, link.trim(), "missing", "")
            return id
        }
        fun connect(from: String, links: List<String>) = links.forEach { link ->
            val to = resolve(link) ?: return@forEach
            if (to == from) return@forEach
            val key = if (from < to) "$from>$to" else "$to>$from"
            val known = edgeByKey[key]
            if (known != null) { if (known.from == to) known.isMutual = true; return@forEach }
            val e = Edge(from, to)
            edgeByKey[key] = e
            edges += e
        }
        fun shown(n: Input) = !n.isDaily || withDays
        val shownNotes = mutableListOf<Input>()
        notes.forEach { n ->
            if (!shown(n) || n.id in byId) return@forEach
            add(n.id, n.title, if (n.isDaily) "day" else "note", n.folder)
            shownNotes += n
            val key = titleKey(n.title)
            if (key.isNotEmpty() && key !in noteIdByTitle) noteIdByTitle[key] = n.id
        }
        notes.forEach { n ->
            val key = titleKey(n.title)
            if (!shown(n) && key.isNotEmpty() && key !in noteIdByTitle) hidden += key
        }
        shownNotes.forEach { connect(it.id, it.links) }
        if (withRecords) {
            val recordIdByTitle = HashMap<String, String>()
            records.forEach { r ->
                if (r.links.none { l -> titleKey(l).let { it.isNotEmpty() && it !in hidden } }) return@forEach
                val key = titleKey(r.title)
                var id = recordIdByTitle[key]
                if (id == null) {
                    if (r.id in byId) return@forEach
                    id = r.id
                    recordIdByTitle[key] = id
                    add(id, r.title, "record", r.type)
                }
                connect(id, r.links)
            }
        }
        edges.forEach { e -> byId[e.from]?.let { it.degree++ }; byId[e.to]?.let { it.degree++ } }
        return Graph(nodes, edges)
    }

    /** mulberry32 — тот же генератор, что в web. */
    private fun seeded(seed: Int): () -> Double {
        var state = seed
        return {
            state += 0x6D2B79F5
            var t = state
            t = (t xor (t ushr 15)) * (t or 1)
            t = t xor (t + (t xor (t ushr 7)) * (t or 61))
            ((t xor (t ushr 14)).toLong() and 0xffffffffL).toDouble() / 4294967296.0
        }
    }

    /** Полная раскладка (`layoutGraph` web с `isLoose`): координаты в единицах web (CSS px), центр — 450 × 310. */
    fun layout(graph: Graph) {
        val nodes = graph.nodes
        val count = nodes.size
        if (count == 0) return
        val px = DoubleArray(count)
        val py = DoubleArray(count)
        val random = seeded(1)
        for (i in 0 until count) {
            px[i] = (random() * 2 - 1) * START_SPREAD
            py[i] = (random() * 2 - 1) * START_SPREAD
        }
        val index = HashMap<String, Int>()
        nodes.forEachIndexed { i, n -> if (n.id !in index) index[n.id] = i }
        val links = graph.edges.mapNotNull { e ->
            val a = index[e.from]; val b = index[e.to]
            if (a != null && b != null && a != b) a to b else null
        }
        val pairs = count.toDouble() * (count - 1) / 2
        val iterations = if (count > 1) min(ITERATIONS.toDouble(), max(1.0, kotlin.math.floor(WORK_BUDGET / max(pairs, 1.0)))).toInt() else 0
        var temperature = START_TEMPERATURE
        val cooling = Math.pow(COOLING, ITERATIONS.toDouble() / max(iterations, 1))
        val fx = DoubleArray(count)
        val fy = DoubleArray(count)
        val k2 = SPRING * SPRING
        repeat(iterations) {
            for (i in 0 until count) { fx[i] = -px[i] * GRAVITY; fy[i] = -py[i] * GRAVITY }
            for (i in 0 until count) for (j in i + 1 until count) {
                var dx = px[i] - px[j]
                var dy = py[i] - py[j]
                if (dx == 0.0 && dy == 0.0) { dx = 0.01 * (i - j); dy = 0.01 }
                val d = max(MIN_DISTANCE, sqrt(dx * dx + dy * dy))
                val f = k2 / (d * d)
                fx[i] += dx * f; fy[i] += dy * f
                fx[j] -= dx * f; fy[j] -= dy * f
            }
            for ((a, b) in links) {
                val dx = px[a] - px[b]
                val dy = py[a] - py[b]
                val d = max(MIN_DISTANCE, sqrt(dx * dx + dy * dy))
                val f = d / SPRING * ATTRACTION
                fx[a] -= dx * f; fy[a] -= dy * f
                fx[b] += dx * f; fy[b] += dy * f
            }
            for (i in 0 until count) {
                val len = max(1.0, sqrt(fx[i] * fx[i] + fy[i] * fy[i]))
                val lim = min(len, temperature) / len
                px[i] += fx[i] * lim
                py[i] += fy[i] * lim
            }
            temperature *= cooling
        }
        if (count == 1) { nodes[0].x = 450.0; nodes[0].y = 310.0; return }
        val midX = (px.minOrNull()!! + px.maxOrNull()!!) / 2
        val midY = (py.minOrNull()!! + py.maxOrNull()!!) / 2
        nodes.forEachIndexed { i, n -> n.x = 450.0 + (px[i] - midX); n.y = 310.0 + (py[i] - midY) }
    }

    fun radius(degree: Int): Float = min(MAX_RADIUS, MIN_RADIUS + sqrt(max(0, degree).toFloat()) * 3.2f)
}

/** Поле графа: точки, связи, подписи; сдвиг пальцем, щипок, нажатие на точку. */
@SuppressLint("ViewConstructor")
class NotesGraphView(context: Context, private val onPick: (NotesGraph.Node?) -> Unit, private val onOpen: (NotesGraph.Node) -> Unit) : View(context) {
    private var graph = NotesGraph.Graph(emptyList(), emptyList())
    private var byId = emptyMap<String, NotesGraph.Node>()
    var picked: String? = null
        private set
    var query: String = ""
        set(value) { field = value; invalidate() }
    private var neighbours = emptySet<String>()
    private val density = Pv.px(1f).toFloat().coerceAtLeast(1f)
    private var scale = 1f
    private var ox = 0f
    private var oy = 0f
    private var fitPending = true
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val head = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Pv.regular() }
    private val labelStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER; typeface = Pv.regular(); style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND
    }
    private val path = Path()

    init {
        contentDescription = Sx.t("Граф заметок", "Notes graph")
    }

    fun setGraph(g: NotesGraph.Graph, refit: Boolean) {
        graph = g
        byId = g.nodes.associateBy { it.id }
        if (picked != null && picked !in byId) pick(null)
        if (refit) fitPending = true
        invalidate()
    }

    fun pick(id: String?) {
        picked = id
        neighbours = if (id == null) emptySet() else graph.edges.flatMap { e ->
            when (id) { e.from -> listOf(e.to); e.to -> listOf(e.from); else -> emptyList() }
        }.toSet()
        onPick(id?.let { byId[it] })
        invalidate()
    }

    /** Вписать граф (`fitRects`: коробка 120 × 60 на точку, сверху 60 под чипы, снизу 20, по бокам 20). */
    fun fit() {
        val nodes = graph.nodes
        if (width == 0 || height == 0) { fitPending = true; return }
        fitPending = false
        val w = width / density
        val h = height / density
        if (nodes.isEmpty()) { scale = 1f; ox = width / 2f; oy = height / 2f; invalidate(); return }
        val x0 = nodes.minOf { it.x - 60 }.toFloat(); val x1 = nodes.maxOf { it.x + 60 }.toFloat()
        val y0 = nodes.minOf { it.y - 30 }.toFloat(); val y1 = nodes.maxOf { it.y + 30 }.toFloat()
        val top = 60f; val bottom = 20f; val side = 20f
        val roomY = max(1f, h - top - bottom)
        val s = min(min(max(1f, w - side * 2) / max(1f, x1 - x0), roomY / max(1f, y1 - y0)), 1.2f).coerceIn(0.15f, 2.5f)
        scale = s
        ox = ((w - (x1 - x0) * s) / 2 - x0 * s) * density
        oy = (top + (roomY - (y1 - y0) * s) / 2 - y0 * s) * density
        invalidate()
    }

    fun zoom(factor: Float) {
        zoomAround(scale * factor, width / 2f, height / 2f)
    }

    private fun zoomAround(next: Float, cx: Float, cy: Float) {
        val s = next.coerceIn(0.15f, 2.5f)
        ox = cx - (cx - ox) * s / scale
        oy = cy - (cy - oy) * s / scale
        scale = s
        invalidate()
    }

    private fun sx(x: Double) = (x * scale * density + ox).toFloat()
    private fun sy(y: Double) = (y * scale * density + oy).toFloat()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (fitPending) fit()
    }

    private fun colorOf(n: NotesGraph.Node): Int = when (n.kind) {
        "missing" -> Pv.c.faint
        "day" -> Pv.c.note
        "record" -> if (n.group == "task") Pv.c.task else Pv.c.event
        else -> Kn.folderColor(n.group)
    }

    private fun isFound(n: NotesGraph.Node) = query.isNotBlank() && n.title.contains(query.trim(), ignoreCase = true)

    override fun onDraw(canvas: Canvas) {
        val c = Pv.c
        canvas.drawColor(Kn.boardFill())
        Kn.drawDots(canvas, width, height, scale, ox, oy, dotPaint)
        if (fitPending && width > 0) fit()
        val k = scale * density
        val searching = query.isNotBlank()
        val found = if (searching) graph.nodes.filter { isFound(it) }.map { it.id }.toSet() else emptySet()
        // связи
        line.strokeWidth = 1.5f * k
        for (e in graph.edges) {
            val a = byId[e.from] ?: continue
            val b = byId[e.to] ?: continue
            val on = picked == e.from || picked == e.to
            val dim = if (searching) !(e.from in found && e.to in found) else picked != null && !on
            val color = if (on && !dim) c.accent else c.line2
            line.color = color
            head.color = color
            val alpha = if (dim) 38 else 255
            line.alpha = alpha
            head.alpha = alpha
            val ra = NotesGraph.radius(a.degree)
            val rb = NotesGraph.radius(b.degree)
            val len = hypot(b.x - a.x, b.y - a.y).toFloat()
            if (len <= ra + rb + NotesGraph.EDGE_GAP * 2 + NotesGraph.ARROW) {
                canvas.drawLine(sx(a.x), sy(a.y), sx(b.x), sy(b.y), line)
                continue
            }
            val ux = ((b.x - a.x) / len).toFloat()
            val uy = ((b.y - a.y) / len).toFloat()
            val x1 = a.x.toFloat() + ux * (ra + NotesGraph.EDGE_GAP)
            val y1 = a.y.toFloat() + uy * (ra + NotesGraph.EDGE_GAP)
            val x2 = b.x.toFloat() - ux * (rb + NotesGraph.EDGE_GAP)
            val y2 = b.y.toFloat() - uy * (rb + NotesGraph.EDGE_GAP)
            canvas.drawLine(sx(x1.toDouble()), sy(y1.toDouble()), sx(x2.toDouble()), sy(y2.toDouble()), line)
            arrow(canvas, x2, y2, ux, uy)
            if (e.isMutual) arrow(canvas, x1, y1, -ux, -uy)
        }
        // точки
        val textSize = 12f * k
        label.textSize = textSize
        labelStroke.textSize = textSize
        labelStroke.strokeWidth = 4f * k
        labelStroke.color = c.bg
        label.color = c.fg
        val labelsShown = scale >= 0.55f
        for (n in graph.nodes) {
            val r = NotesGraph.radius(n.degree) * k
            val near = picked == n.id || (picked != null && n.id in neighbours)
            val isFound = n.id in found
            val dim = if (searching) !isFound else picked != null && !near
            val alpha = if (dim) 38 else 255
            fill.color = colorOf(n)
            fill.alpha = if (n.kind == "missing") (alpha * 0.35f).toInt() else alpha
            canvas.drawCircle(sx(n.x), sy(n.y), r, fill)
            ring.color = if (picked == n.id || isFound) c.accent else c.bg
            ring.strokeWidth = (if (picked == n.id || isFound) 3f else 2f) * k
            ring.alpha = alpha
            canvas.drawCircle(sx(n.x), sy(n.y), r, ring)
            if (labelsShown || near || isFound) {
                val text = if (n.title.length > 22) n.title.take(21) + "…" else n.title
                val y = sy(n.y) + r + 17f * k - textSize * 0.25f
                labelStroke.alpha = alpha
                label.alpha = alpha
                canvas.drawText(text, sx(n.x), y, labelStroke)
                canvas.drawText(text, sx(n.x), y, label)
            }
        }
    }

    private fun arrow(canvas: Canvas, tipX: Float, tipY: Float, ux: Float, uy: Float) {
        val a = NotesGraph.ARROW
        val backX = tipX - ux * a
        val backY = tipY - uy * a
        val wing = a * 0.5f
        path.reset()
        path.moveTo(sx(tipX.toDouble()), sy(tipY.toDouble()))
        path.lineTo(sx((backX - uy * wing).toDouble()), sy((backY + ux * wing).toDouble()))
        path.lineTo(sx((backX + uy * wing).toDouble()), sy((backY - ux * wing).toDouble()))
        path.close()
        canvas.drawPath(path, head)
    }

    private fun nodeAt(x: Float, y: Float): NotesGraph.Node? {
        val wx = (x - ox) / (scale * density)
        val wy = (y - oy) / (scale * density)
        val slop = 10f / scale
        var best: NotesGraph.Node? = null
        var bestD = Float.MAX_VALUE
        for (n in graph.nodes) {
            val d = hypot(n.x - wx, n.y - wy).toFloat()
            if (d <= NotesGraph.radius(n.degree) + slop && d < bestD) { bestD = d; best = n }
        }
        return best
    }

    private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean {
            zoomAround(scale * d.scaleFactor, d.focusX, d.focusY)
            return true
        }
    })

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            ox -= dx; oy -= dy
            invalidate()
            return true
        }
        override fun onSingleTapUp(e: MotionEvent): Boolean {
            val n = nodeAt(e.x, e.y)
            when {
                n == null -> pick(null)
                n.id == picked && n.kind != "missing" -> onOpen(n)
                else -> pick(n.id)
            }
            return true
        }
        override fun onDoubleTap(e: MotionEvent): Boolean {
            nodeAt(e.x, e.y)?.takeIf { it.kind != "missing" }?.let { onOpen(it) }
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

/**
 * Вкладка «Граф»: поле во весь экран, сверху чипы (`Заметки N`, `Дни`, `События и задачи`, «Холст из графа»), справа
 * снизу масштаб; выбранная заметка — плашкой снизу с «Открыть».
 */
@SuppressLint("ViewConstructor")
class KnowledgeGraphBoard(context: Context, private val onOpenNote: (String) -> Unit, private val onMakeCanvas: () -> Unit,
                          private val onCreateMissing: (String) -> Unit) : FrameLayout(context) {
    private var withDays = false
    private var withRecords = false
    private var notes = emptyList<JSONObject>()
    private var lastKey = ""
    private val chips = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private val pickBar = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(0.875f), Pv.rem(0.5f), Pv.rem(0.5f), Pv.rem(0.5f))
        background = Pv.shape(Pv.c.panel, 0.75f, Pv.c.line2)
        elevation = Pv.px(4f).toFloat()
        visibility = GONE
    }
    private val view: NotesGraphView = NotesGraphView(context, { showPick(it) }) { n -> open(n) }
    private val empty = context.pvText(Sx.t("Заметок пока нет — граф пуст", "No notes yet — the graph is empty"), 0.9375f, Pv.c.muted).apply {
        gravity = Gravity.CENTER
        visibility = GONE
    }

    var query: String
        get() = view.query
        set(value) { view.query = value }

    init {
        addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(empty, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
            leftMargin = Pv.rem(1f); rightMargin = Pv.rem(1f)
        })
        addView(HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            addView(chips)
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
            topMargin = Pv.rem(0.625f); leftMargin = Pv.rem(0.625f); rightMargin = Pv.rem(0.625f)
        })
        addView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(context.boardTool("plus", Sx.t("Крупнее", "Zoom in")) { view.zoom(1.25f) })
            addView(context.boardTool("minus", Sx.t("Мельче", "Zoom out")) { view.zoom(1 / 1.25f) }.apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = Pv.rem(0.375f)
            })
            addView(context.boardTool("fit", Sx.t("Вписать", "Fit")) { view.fit() }.apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = Pv.rem(0.375f)
            })
        }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            rightMargin = Pv.rem(0.625f); bottomMargin = Pv.rem(0.625f)
        })
        addView(pickBar, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            leftMargin = Pv.rem(0.625f); rightMargin = Pv.rem(3.625f); bottomMargin = Pv.rem(0.625f)
        })
    }

    /** Новые заметки из снимка: граф перестраивается, вписывается только при смене набора точек. */
    fun setNotes(list: List<JSONObject>) {
        notes = list
        rebuild(false)
    }

    private fun records(): List<NotesGraph.Record> {
        val state = Sx.last("planner")?.optJSONObject("state") ?: return emptyList()
        val out = mutableListOf<NotesGraph.Record>()
        Sx.list(state.optJSONArray("tasks")).forEach { t ->
            val links = NoteText.linkList(t.optString("name") + "\n" + t.optString("description"))
            if (links.isNotEmpty()) out += NotesGraph.Record(t.optString("id"), t.optString("name").replace(Regex("""\[\[|]]"""), ""), links, "task")
        }
        Sx.list(state.optJSONArray("events")).forEach { e ->
            val links = NoteText.linkList(e.optString("name") + "\n" + e.optString("description"))
            if (links.isNotEmpty()) out += NotesGraph.Record(e.optString("id"), e.optString("name").replace(Regex("""\[\[|]]"""), ""), links, "event")
        }
        return out
    }

    private fun rebuild(force: Boolean) {
        val input = notes.map { n ->
            NotesGraph.Input(n.optString("id"), n.optString("title"), n.optString("folder"),
                NoteText.linkList(NoteText.bodyWithoutProperties(n.optString("text"))), n.optBoolean("isDaily"))
        }
        val g = NotesGraph.build(input, records(), withDays, withRecords)
        NotesGraph.layout(g)
        val key = g.nodes.joinToString("|") { it.id } + withDays + withRecords
        val refit = force || key != lastKey
        lastKey = key
        view.setGraph(g, refit)
        empty.visibility = if (g.nodes.isEmpty()) VISIBLE else GONE
        renderChips(input.count { !it.isDaily })
    }

    private fun renderChips(noteCount: Int) {
        chips.removeAllViews()
        chips.addView(context.boardChip(Sx.t("Заметки $noteCount", "Notes $noteCount"), true) { })
        chips.addView(context.boardChip(Sx.t("Дни", "Days"), withDays) { withDays = !withDays; rebuild(true) })
        chips.addView(context.boardChip(Sx.t("События и задачи", "Events and tasks"), withRecords) { withRecords = !withRecords; rebuild(true) })
        chips.addView(context.boardChip(Sx.t("Холст из графа", "Canvas from graph"), false, icon = "board") { onMakeCanvas() })
    }

    private fun showPick(n: NotesGraph.Node?) {
        pickBar.removeAllViews()
        if (n == null) { pickBar.visibility = GONE; return }
        pickBar.visibility = VISIBLE
        pickBar.addView(context.pvText(n.title, 0.9375f, Pv.c.fg, semibold = true, maxLines = 1),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (n.kind == "note" || n.kind == "day") pickBar.addView(context.pvButton(Sx.t("Открыть", "Open"), "acc") { open(n) })
        else if (n.kind == "missing") pickBar.addView(context.pvButton(Sx.t("Создать", "Create"), "acc") { onCreateMissing(n.title) })
    }

    private fun open(n: NotesGraph.Node) {
        when (n.kind) {
            "note", "day" -> onOpenNote(n.id)
            "missing" -> onCreateMissing(n.title)
        }
    }

    /** Текущий граф (для «Холста из графа»): точки с координатами и связи. */
    fun currentGraph(): NotesGraph.Graph {
        val input = notes.map { n ->
            NotesGraph.Input(n.optString("id"), n.optString("title"), n.optString("folder"),
                NoteText.linkList(NoteText.bodyWithoutProperties(n.optString("text"))), n.optBoolean("isDaily"))
        }
        val g = NotesGraph.build(input, emptyList(), false, false)
        NotesGraph.layout(g)
        return g
    }
}
