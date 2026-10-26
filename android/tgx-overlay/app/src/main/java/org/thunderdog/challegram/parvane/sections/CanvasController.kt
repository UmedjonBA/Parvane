package org.thunderdog.challegram.parvane.sections

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.R
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.parvane.sections.Kn.boardChip
import org.thunderdog.challegram.parvane.sections.Kn.boardTool
import org.thunderdog.challegram.telegram.Tdlib
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Parvane (spec 031/032): холст «Знаний» (JSON Canvas, общий с web/desktop) в виде web (`NotesCanvas.tsx`):
 * точечное поле, карточки текста, заметок (`file` = `<название>.md`, поле `pvNote`), ссылок и группы-рамки,
 * стрелки дугами. Сверху — чипы холстов, «+ Холст», «Из графа» и ряд инструментов; справа снизу — отмена, повтор,
 * масштаб. Сдвиг и масштаб пальцами, карточку можно перетащить; нажатие выделяет, повторное по заметке —
 * открывает её. Сохранение — `saveCanvas` через секунду после правки; неизвестные поля узлов сохраняются.
 */
class CanvasController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section = "knowledge"
    override val tab = ParvaneTabBar.Tab.KNOWLEDGE
    override fun getId() = R.id.controller_parvaneGraph
    override fun getName(): CharSequence = Sx.t("Холст", "Canvas")

    private var canvasId = ""
    private var board: KnowledgeCanvasBoard? = null

    companion object {
        fun open(owner: ViewController<*>, id: String) =
            owner.navigateTo(CanvasController(owner.context(), owner.tdlib()).also { it.canvasId = id })
    }

    override fun onBuilt() {
        scroll.visibility = View.GONE
        val b = KnowledgeCanvasBoard(context(), this) { id -> NoteController.open(this, id) }
        b.openId = canvasId
        board = b
        contentSlot.addView(b, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        watch("notes") { b.setSnapshot(it) }
    }
}

/** Холст из графа (порт `canvasFromGraph` web): карточка на заметку, кластеры по папкам с группами, стрелки по ссылкам. */
object CanvasFromGraph {
    private const val CARD_W = 250.0
    private const val CARD_H = 140.0
    private const val GAP = 60.0
    private const val GROUP_PAD = 20.0
    private const val GROUP_HEAD = 40.0
    private const val MAX_SPREAD = 6.0
    private const val MIN_OFFSET = 0.5
    private const val PACK_ASPECT = 1.5

    private fun newId(): String = java.util.UUID.randomUUID().toString().replace("-", "").take(16)

    fun build(notes: List<JSONObject>): JSONObject {
        val shown = notes.distinctBy { it.optString("id") }
        val nodes = JSONArray()
        val edges = JSONArray()
        if (shown.isEmpty()) return JSONObject().put("nodes", nodes).put("edges", edges)
        val idByTitle = LinkedHashMap<String, String>()
        shown.forEach { n -> n.optString("title").trim().lowercase().takeIf { it.isNotEmpty() }?.let { k -> if (k !in idByTitle) idByTitle[k] = n.optString("id") } }
        val links = shown.associate { n ->
            n.optString("id") to NoteText.linkList(NoteText.bodyWithoutProperties(n.optString("text"))).filter { it.trim().lowercase() in idByTitle }
        }
        val byFolder = shown.indices.groupBy { shown[it].optString("folder") }.toSortedMap()
        class Cluster(val folder: String, val indexes: List<Int>, val spots: List<Pair<Double, Double>>, val w: Double, val h: Double,
                      val pad: Double, val head: Double)
        val clusters = byFolder.map { (folder, indexes) ->
            val ids = indexes.map { shown[it].optString("id") }.toSet()
            val input = indexes.map { i ->
                val n = shown[i]
                NotesGraph.Input(n.optString("id"), n.optString("title"), folder,
                    links.getValue(n.optString("id")).filter { idByTitle[it.trim().lowercase()] in ids }, false)
            }
            val g = NotesGraph.build(input, emptyList(), true, false)
            NotesGraph.layout(g)
            val pos = g.nodes.associate { it.id to (it.x to it.y) }
            val points = indexes.map { i -> pos[shown[i].optString("id")]?.let { doubleArrayOf(it.first, it.second) } ?: doubleArrayOf(0.0, 0.0) }
            val spread = spreadOf(points, CARD_W + GAP, CARD_H + GAP)
            points.forEach { it[0] *= spread; it[1] *= spread }
            separate(points, CARD_W + GAP, CARD_H + GAP)
            val minX = points.minOf { it[0] }
            val minY = points.minOf { it[1] }
            val spots = points.map { Math.round(it[0] - minX).toDouble() to Math.round(it[1] - minY).toDouble() }
            val w = spots.maxOf { it.first } + CARD_W
            val h = spots.maxOf { it.second } + CARD_H
            val pad = if (folder.isEmpty()) 0.0 else GROUP_PAD
            val head = if (folder.isEmpty()) 0.0 else GROUP_HEAD
            Cluster(folder, indexes, spots, w + pad * 2, h + pad * 2 + head, pad, head)
        }
        // Ряды слева направо (`packBoxes`)
        val area = clusters.sumOf { (it.w + GAP) * (it.h + GAP) }
        val limit = max(clusters.maxOf { it.w }, sqrt(area) * PACK_ASPECT)
        var x = 0.0
        var y = 0.0
        var rowH = 0.0
        val places = clusters.map { c ->
            if (x > 0 && x + c.w > limit) { x = 0.0; y += rowH + GAP; rowH = 0.0 }
            val at = x to y
            x += c.w + GAP
            rowH = max(rowH, c.h)
            at
        }
        val top = clusters.indices.minOf { places[it].second + clusters[it].head }
        val cardIdByNote = HashMap<String, String>()
        val cards = JSONArray()
        clusters.forEachIndexed { ci, c ->
            if (c.folder.isNotEmpty()) {
                nodes.put(JSONObject().put("id", newId()).put("type", "group").put("x", places[ci].first.toInt())
                    .put("y", (places[ci].second + c.head - top).toInt()).put("width", c.w.toInt()).put("height", (c.h - c.head).toInt())
                    .put("label", Kn.folderCaption(c.folder)).put("pvFolder", c.folder))
            }
            c.indexes.forEachIndexed { k, i ->
                val n = shown[i]
                val id = newId()
                cardIdByNote[n.optString("id")] = id
                cards.put(JSONObject().put("id", id).put("type", "file")
                    .put("x", (places[ci].first + c.pad + c.spots[k].first).toInt())
                    .put("y", (places[ci].second + c.head + c.pad + c.spots[k].second - top).toInt())
                    .put("width", CARD_W.toInt()).put("height", CARD_H.toInt())
                    .put("file", n.optString("title") + ".md").put("pvNote", n.optString("id")))
            }
        }
        for (i in 0 until cards.length()) nodes.put(cards.get(i))
        val byKey = HashMap<String, JSONObject>()
        shown.forEach { n ->
            val from = n.optString("id")
            links.getValue(from).forEach { link ->
                val to = idByTitle.getValue(link.trim().lowercase())
                if (to == from || byKey.containsKey("$from>$to")) return@forEach
                val reverse = byKey["$to>$from"]
                if (reverse != null) { reverse.put("fromEnd", "arrow"); byKey["$from>$to"] = reverse; return@forEach }
                val e = JSONObject().put("id", "graph-" + newId()).put("fromNode", cardIdByNote[from]).put("toNode", cardIdByNote[to])
                byKey["$from>$to"] = e
                edges.put(e)
            }
        }
        return JSONObject().put("nodes", nodes).put("edges", edges)
    }

    private fun spreadOf(points: List<DoubleArray>, w: Double, h: Double): Double {
        var spread = 1.0
        for (i in points.indices) for (j in i + 1 until points.size) {
            val dx = max(MIN_OFFSET, abs(points[i][0] - points[j][0]))
            val dy = max(MIN_OFFSET, abs(points[i][1] - points[j][1]))
            spread = max(spread, min(w / dx, h / dy))
        }
        return min(MAX_SPREAD, spread)
    }

    private fun separate(points: List<DoubleArray>, w: Double, h: Double) {
        repeat(200) {
            var moved = false
            for (i in points.indices) for (j in i + 1 until points.size) {
                val a = points[i]; val b = points[j]
                val ox = w - abs(a[0] - b[0])
                val oy = h - abs(a[1] - b[1])
                if (ox <= 0 || oy <= 0) continue
                moved = true
                if (ox < oy) { val s = ox / 2 * (if (a[0] <= b[0]) 1 else -1); a[0] -= s; b[0] += s }
                else { val s = oy / 2 * (if (a[1] <= b[1]) 1 else -1); a[1] -= s; b[1] += s }
            }
            if (!moved) return
        }
    }
}

/**
 * Вкладка «Холст» (и экран [CanvasController]): чипы холстов, инструменты, поле; без холстов — пустое состояние web
 * («Холст из графа» акцентом и «Новый холст»).
 */
@SuppressLint("ViewConstructor")
class KnowledgeCanvasBoard(context: Context, private val owner: ViewController<*>, private val onOpenNote: (String) -> Unit) : FrameLayout(context) {
    var openId: String = ""
    private var snap: JSONObject? = null
    private var board: CanvasBoardView? = null
    private var boardFor = ""
    private val chips = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private val tools = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    private val side = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val boardSlot = FrameLayout(context)
    private val empty = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        visibility = GONE
    }
    private var pending: Runnable? = null
    var query: String = ""
        set(value) { field = value; board?.query = value }

    init {
        setBackgroundColor(Kn.boardFill())
        addView(boardSlot, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(empty, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
            leftMargin = Pv.rem(1.5f); rightMargin = Pv.rem(1.5f)
        })
        val top = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        top.addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(chips) })
        top.addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(tools) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = Pv.rem(0.5f) })
        addView(top, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
            topMargin = Pv.rem(0.625f); leftMargin = Pv.rem(0.625f); rightMargin = Pv.rem(0.625f)
        })
        addView(side, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            rightMargin = Pv.rem(0.625f); bottomMargin = Pv.rem(0.625f)
        })
        empty.addView(context.pvText(Sx.t("Холстов пока нет. Начните с графа связей: каждая заметка станет карточкой, каждая [[ссылка]] — стрелкой, дальше двигайте и дорисовывайте как угодно.",
            "No canvases yet. Start from the link graph: every note becomes a card, every [[link]] an arrow — then move and draw as you like."),
            1f, Pv.c.muted).apply { gravity = Gravity.CENTER })
        empty.addView(context.pvButton(Sx.t("Холст из графа", "Canvas from graph"), "acc", icon = "graph") { fromGraph() }.apply {
            (layoutParams as LinearLayout.LayoutParams).topMargin = Pv.rem(1.25f)
        })
        empty.addView(context.pvButton(Sx.t("Новый холст", "New canvas"), icon = "plus") { newCanvas() }.apply {
            (layoutParams as LinearLayout.LayoutParams).topMargin = Pv.rem(0.75f)
        })
    }

    private fun canvases() = Sx.list(snap?.optJSONArray("canvases"))
    private fun notes() = Sx.list(snap?.optJSONArray("notes"))

    fun setSnapshot(s: JSONObject) {
        snap = s
        val list = canvases()
        if (openId.isEmpty() || list.none { it.optString("id") == openId }) openId = list.firstOrNull()?.optString("id").orEmpty()
        val current = list.firstOrNull { it.optString("id") == openId }
        empty.visibility = if (current == null) VISIBLE else GONE
        if (current == null) {
            boardSlot.removeAllViews(); board = null; boardFor = ""
        } else if (boardFor != openId || (pending == null && board?.sourceText != current.optString("text"))) {
            val doc = try { JSONObject(current.optString("text").ifEmpty { "{}" }) } catch (e: Throwable) { JSONObject() }
            val view = CanvasBoardView(context, doc, current.optString("text"), { notes() }, { changed -> save(changed) }, onOpenNote) { renderTools() }
            view.query = query
            board = view
            boardFor = openId
            boardSlot.removeAllViews()
            boardSlot.addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        } else board?.invalidate()
        renderChips()
        renderTools()
    }

    private fun renderChips() {
        chips.removeAllViews()
        canvases().forEach { c ->
            val id = c.optString("id")
            chips.addView(context.boardChip(c.optString("title"), id == openId, icon = "board") {
                if (id == openId) canvasMenu(c) else { flush(); openId = id; snap?.let { setSnapshot(it) } }
            })
        }
        if (canvases().isNotEmpty()) {
            chips.addView(context.boardChip(Sx.t("Холст", "Canvas"), false, icon = "plus") { newCanvas() })
            chips.addView(context.boardChip(Sx.t("Из графа", "From graph"), false, icon = "graph") { fromGraph() })
        }
    }

    private fun renderTools() {
        tools.removeAllViews()
        side.removeAllViews()
        val b = board ?: return
        fun tool(icon: String, desc: String, enabled: Boolean = true, on: Boolean = false, action: () -> Unit) {
            tools.addView(context.boardTool(icon, desc, enabled, on, action).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = Pv.rem(0.375f) })
        }
        tool("text", Sx.t("Текстовая карточка", "Text card")) {
            Kn.askText(context, Sx.t("Текст карточки", "Card text"), "") { t -> b.addCard(JSONObject().put("type", "text").put("text", t), 260, 120) }
        }
        tool("note", Sx.t("Карточка заметки", "Note card")) { pickNote { n -> b.addNoteCard(n) } }
        tool("noteNew", Sx.t("Новая заметка", "New note")) {
            Kn.askText(context, Sx.t("Название заметки", "Note title"), "") { title ->
                Sx.async({ ParvaneSections.notes("create", JSONObject().put("title", title).put("text", "").toString()) }) { id ->
                    if (id is String) b.addNoteCard(JSONObject().put("id", id).put("title", title))
                    else org.thunderdog.challegram.tool.UI.showToast(Sx.t("Заметка не создана", "Note not created"), android.widget.Toast.LENGTH_SHORT)
                }
            }
        }
        // Карточка-ссылка (`data-canvas-tool="link"` web): адрес http(s), открывается браузером
        tool("open", Sx.t("Карточка-ссылка", "Link card")) {
            Kn.askText(context, Sx.t("Адрес ссылки", "Link address"), "https://") { raw ->
                val url = raw.trim().let { if (it.startsWith("http://") || it.startsWith("https://")) it else "https://$it" }
                if (url.length > "https://".length) b.addCard(JSONObject().put("type", "link").put("url", url), 320, 160)
            }
        }
        tool("group", Sx.t("Группа", "Group")) {
            Kn.askText(context, Sx.t("Название группы", "Group name"), Sx.t("Группа", "Group")) { label -> b.addGroup(label) }
        }
        tool("link", Sx.t("Связать", "Connect"), enabled = b.selectedId != null, on = b.connecting) { b.toggleConnect() }
        tool("trash", Sx.t("Удалить", "Delete"), enabled = b.selectedId != null) { b.deleteSelected() }
        fun sideTool(icon: String, desc: String, enabled: Boolean = true, action: () -> Unit) {
            side.addView(context.boardTool(icon, desc, enabled, false, action).apply {
                if (side.childCount > 0) (layoutParams as LinearLayout.LayoutParams).topMargin = Pv.rem(0.375f)
            })
        }
        sideTool("undo", Sx.t("Отменить", "Undo"), b.canUndo()) { b.undo() }
        sideTool("redo", Sx.t("Повторить", "Redo"), b.canRedo()) { b.redo() }
        sideTool("plus", Sx.t("Крупнее", "Zoom in")) { b.zoom(1.25f) }
        sideTool("minus", Sx.t("Мельче", "Zoom out")) { b.zoom(1 / 1.25f) }
        sideTool("fit", Sx.t("Вписать", "Fit")) { b.fit() }
    }

    private fun pickNote(done: (JSONObject) -> Unit) {
        val list = notes().sortedBy { it.optString("title").lowercase() }
        if (list.isEmpty()) return
        Kn.menu(context, Sx.t("Заметка на холст", "Note to canvas"), list.map { n -> n.optString("title") to { done(n) } })
    }

    private fun save(doc: JSONObject) {
        val id = boardFor
        val title = canvases().firstOrNull { it.optString("id") == id }?.optString("title") ?: return
        pending?.let { Sx.main.removeCallbacks(it) }
        pending = Runnable {
            pending = null
            val text = doc.toString()
            board?.sourceText = text
            val args = JSONObject().put("id", id).put("title", title).put("text", text)
            Sx.async({ ParvaneSections.notes("saveCanvas", args.toString()) }) { r ->
                if (r == null) org.thunderdog.challegram.tool.UI.showToast(Sx.t("Холст не сохранён — нет связи?", "Canvas not saved — offline?"), android.widget.Toast.LENGTH_SHORT)
            }
        }.also { Sx.main.postDelayed(it, 1000) }
        renderTools()
    }

    /** Сохранить сразу (уход с холста). */
    fun flush() {
        pending?.let { Sx.main.removeCallbacks(it); it.run() }
    }

    private fun freeTitle(base: String): String {
        val taken = canvases().map { it.optString("title").lowercase() }.toSet()
        if (base.lowercase() !in taken) return base
        var i = 2
        while ("$base $i".lowercase() in taken) i++
        return "$base $i"
    }

    private fun create(title: String, doc: JSONObject) {
        Sx.async({ ParvaneSections.notes("saveCanvas", JSONObject().put("title", title).put("text", doc.toString()).toString()) }) { id ->
            if (id is String) { openId = id; boardFor = ""; snap?.let { setSnapshot(it) } }
            else org.thunderdog.challegram.tool.UI.showToast(Sx.t("Холст не создан", "Canvas not created"), android.widget.Toast.LENGTH_SHORT)
        }
    }

    fun fromGraph() {
        val doc = CanvasFromGraph.build(notes().filter { !it.optBoolean("isDaily") })
        create(freeTitle(Sx.t("Граф связей", "Link graph")), doc)
    }

    private fun newCanvas() = Kn.askText(context, Sx.t("Название холста", "Canvas name"), freeTitle(Sx.t("Холст", "Canvas")), Sx.t("Создать", "Create")) { title ->
        create(title, JSONObject().put("nodes", JSONArray()).put("edges", JSONArray()))
    }

    private fun canvasMenu(c: JSONObject) {
        val id = c.optString("id")
        Kn.menu(context, c.optString("title"), listOf(
            Sx.t("Переименовать", "Rename") to {
                Kn.askText(context, Sx.t("Название холста", "Canvas name"), c.optString("title")) { t ->
                    Sx.async({ ParvaneSections.notes("renameCanvas", JSONObject().put("id", id).put("title", t).toString()) }) { }
                }
            },
            Sx.t("В корзину", "Move to trash") to {
                PvSheet.confirm(context, Sx.t("Удалить холст?", "Delete canvas?"), c.optString("title"), Sx.t("В корзину", "Move to trash"), danger = true) {
                    Sx.async({ ParvaneSections.notes("deleteCanvas", JSONObject().put("id", id).toString()) }) { openId = ""; boardFor = "" }
                }
            },
        ), dangerLast = true)
    }

    override fun onDetachedFromWindow() {
        flush()
        super.onDetachedFromWindow()
    }
}

/** Поле холста: карточки, группы, стрелки дугами; отмена/повтор снимками документа. */
@SuppressLint("ViewConstructor")
class CanvasBoardView(
    context: Context,
    private var doc: JSONObject,
    var sourceText: String,
    private val notes: () -> List<JSONObject>,
    private val changed: (JSONObject) -> Unit,
    private val onOpenNote: (String) -> Unit,
    private val onState: () -> Unit,
) : View(context) {
    private val density = Pv.px(1f).toFloat().coerceAtLeast(1f)
    private var scale = 0.6f
    private var ox = 0f
    private var oy = 0f
    private var fitted = false
    private var dragging: JSONObject? = null
    private var moved = false
    var selectedId: String? = null
        private set
    var connecting = false
        private set
    var query: String = ""
        set(value) { field = value; invalidate() }
    private val undoStack = ArrayDeque<String>()
    private val redoStack = ArrayDeque<String>()
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val headPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Pv.regular() }
    private val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Pv.semibold() }
    private val path = Path()

    private fun nodes(): JSONArray = doc.optJSONArray("nodes") ?: JSONArray().also { doc.put("nodes", it) }
    private fun edges(): JSONArray = doc.optJSONArray("edges") ?: JSONArray().also { doc.put("edges", it) }
    private fun list() = (0 until nodes().length()).mapNotNull { nodes().optJSONObject(it) }
    private fun rect(n: JSONObject) = RectF(n.optDouble("x").toFloat(), n.optDouble("y").toFloat(),
        (n.optDouble("x") + n.optDouble("width", 250.0)).toFloat(), (n.optDouble("y") + n.optDouble("height", 60.0)).toFloat())
    private val k get() = scale * density
    private fun screen(r: RectF) = RectF(r.left * k + ox, r.top * k + oy, r.right * k + ox, r.bottom * k + oy)
    private fun world(x: Float, y: Float) = ((x - ox) / k) to ((y - oy) / k)

    fun canUndo() = undoStack.isNotEmpty()
    fun canRedo() = redoStack.isNotEmpty()

    private fun remember() {
        undoStack.addLast(doc.toString())
        if (undoStack.size > 100) undoStack.removeFirst()
        redoStack.clear()
    }

    private fun commit() {
        changed(doc)
        invalidate()
        onState()
    }

    fun undo() {
        val prev = undoStack.removeLastOrNull() ?: return
        redoStack.addLast(doc.toString())
        doc = JSONObject(prev)
        commit()
    }

    fun redo() {
        val next = redoStack.removeLastOrNull() ?: return
        undoStack.addLast(doc.toString())
        doc = JSONObject(next)
        commit()
    }

    private fun newId() = java.util.UUID.randomUUID().toString().replace("-", "").take(16)

    /** Новая карточка в середине видимой части поля. */
    fun addCard(node: JSONObject, w: Int, h: Int) {
        remember()
        val (cx, cy) = world(width / 2f, height / 2f)
        node.put("id", newId()).put("x", (cx - w / 2).toInt()).put("y", (cy - h / 2).toInt()).put("width", w).put("height", h)
        nodes().put(node)
        selectedId = node.optString("id")
        commit()
    }

    fun addNoteCard(note: JSONObject) = addCard(JSONObject().put("type", "file").put("file", note.optString("title") + ".md")
        .put("pvNote", note.optString("id")), 250, 140)

    fun addGroup(label: String) {
        remember()
        val (cx, cy) = world(width / 2f, height / 2f)
        val g = JSONObject().put("id", newId()).put("type", "group").put("label", label)
            .put("x", (cx - 200).toInt()).put("y", (cy - 150).toInt()).put("width", 400).put("height", 300)
        // Группа — под карточками: в начало списка узлов
        val all = JSONArray().put(g)
        for (i in 0 until nodes().length()) all.put(nodes().get(i))
        doc.put("nodes", all)
        commit()
    }

    fun toggleConnect() {
        connecting = !connecting && selectedId != null
        invalidate()
        onState()
    }

    fun deleteSelected() {
        val id = selectedId ?: return
        remember()
        val keep = JSONArray()
        for (i in 0 until nodes().length()) nodes().optJSONObject(i)?.takeIf { it.optString("id") != id }?.let { keep.put(it) }
        doc.put("nodes", keep)
        val keepEdges = JSONArray()
        for (i in 0 until edges().length()) edges().optJSONObject(i)?.takeIf { it.optString("fromNode") != id && it.optString("toNode") != id }?.let { keepEdges.put(it) }
        doc.put("edges", keepEdges)
        selectedId = null
        connecting = false
        commit()
    }

    fun zoom(factor: Float) = zoomAround(scale * factor, width / 2f, height / 2f)

    private fun zoomAround(next: Float, cx: Float, cy: Float) {
        val s = next.coerceIn(0.15f, 2.5f)
        ox = cx - (cx - ox) * s / scale
        oy = cy - (cy - oy) * s / scale
        scale = s
        invalidate()
    }

    /** Вписать всё (сверху место под чипы и инструменты). */
    fun fit() {
        val all = list()
        if (width == 0) return
        fitted = true
        if (all.isEmpty()) { scale = 1f; ox = width / 2f; oy = height / 2f; invalidate(); return }
        val rs = all.map { rect(it) }
        val l = rs.minOf { it.left }; val r = rs.maxOf { it.right }
        val t = rs.minOf { it.top }; val b = rs.maxOf { it.bottom }
        val w = width / density; val h = height / density
        val top = 110f; val bottom = 20f; val side = 20f
        val roomY = max(1f, h - top - bottom)
        scale = min(min(max(1f, w - side * 2) / max(1f, r - l), roomY / max(1f, b - t)), 1.2f).coerceIn(0.15f, 2.5f)
        ox = ((w - (r - l) * scale) / 2 - l * scale) * density
        oy = (top + (roomY - (b - t) * scale) / 2 - t * scale) * density
        invalidate()
    }

    private fun noteOf(n: JSONObject): JSONObject? {
        val all = notes()
        n.optString("pvNote").takeIf { it.isNotEmpty() }?.let { id -> all.firstOrNull { it.optString("id") == id }?.let { return it } }
        val file = n.optString("file").substringAfterLast('/').removeSuffix(".md")
        return all.firstOrNull { it.optString("title").equals(file, ignoreCase = true) }
    }

    private fun titleOf(n: JSONObject): String = when (n.optString("type")) {
        "file" -> if (isNoteFile(n)) noteOf(n)?.optString("title") ?: n.optString("file").substringAfterLast('/').removeSuffix(".md")
            else n.optString("file").substringAfterLast('/')
        "link" -> n.optString("url")
        "group" -> n.optString("label")
        else -> ""
    }

    private fun bodyOf(n: JSONObject): String = when (n.optString("type")) {
        "file" -> noteOf(n)?.takeIf { isNoteFile(n) }?.let { NoteText.bodyWithoutProperties(it.optString("text")).replace(Regex("""\[\[([^\]|]+)(\|[^\]]+)?]]"""), "$1") } ?: ""
        "text" -> n.optString("text")
        else -> ""
    }

    private fun matches(n: JSONObject) = query.isNotBlank() &&
        (titleOf(n).contains(query.trim(), true) || bodyOf(n).contains(query.trim(), true))

    override fun onDraw(canvas: Canvas) {
        val c = Pv.c
        canvas.drawColor(Kn.boardFill())
        if (!fitted && width > 0) fit()
        Kn.drawDots(canvas, width, height, scale, ox, oy, dotPaint)
        val all = list()
        val byId = all.associateBy { it.optString("id") }
        val searching = query.isNotBlank()
        // группы
        for (n in all) if (n.optString("type") == "group") {
            val r = screen(rect(n))
            val rad = 8f * k
            fill.color = Pv.alpha(c.fg, 3)
            canvas.drawRoundRect(r, rad, rad, fill)
            stroke.color = if (n.optString("id") == selectedId) c.accent else c.line2
            stroke.strokeWidth = (if (n.optString("id") == selectedId) 2f else 1f) * density
            canvas.drawRoundRect(r, rad, rad, stroke)
            titlePaint.color = c.muted
            titlePaint.textSize = 12f * k
            canvas.drawText(n.optString("label"), r.left + 8f * k, r.top + 16f * k, titlePaint)
        }
        // стрелки дугами
        edgePaint.strokeWidth = 1.5f * k
        for (i in 0 until edges().length()) {
            val e = edges().optJSONObject(i) ?: continue
            val a = byId[e.optString("fromNode")]?.let { screen(rect(it)) } ?: continue
            val b = byId[e.optString("toNode")]?.let { screen(rect(it)) } ?: continue
            val on = selectedId != null && (e.optString("fromNode") == selectedId || e.optString("toNode") == selectedId)
            val color = if (on) c.accent else Pv.mix(c.fg, c.panel, 55)
            edgePaint.color = color
            headPaint.color = color
            val (p1, d1) = anchor(a, b.centerX(), b.centerY())
            val (p2, d2) = anchor(b, a.centerX(), a.centerY())
            val bend = max(40f * k, (abs(p2[0] - p1[0]) + abs(p2[1] - p1[1])) / 3f)
            path.reset()
            path.moveTo(p1[0], p1[1])
            path.cubicTo(p1[0] + d1[0] * bend, p1[1] + d1[1] * bend, p2[0] + d2[0] * bend, p2[1] + d2[1] * bend, p2[0], p2[1])
            canvas.drawPath(path, edgePaint)
            if (e.optString("toEnd", "arrow") != "none") arrow(canvas, p2[0], p2[1], -d2[0], -d2[1])
            if (e.optString("fromEnd") == "arrow") arrow(canvas, p1[0], p1[1], -d1[0], -d1[1])
        }
        // карточки
        for (n in all) if (n.optString("type") != "group") {
            val r = screen(rect(n))
            val rad = 6f * k
            val dim = searching && !matches(n)
            fill.color = c.panel
            fill.alpha = 255
            canvas.drawRoundRect(r, rad, rad, fill)
            val sel = n.optString("id") == selectedId
            stroke.color = if (sel || (searching && !dim)) c.accent else c.line2
            stroke.strokeWidth = (if (sel) 2f else 1f) * density
            stroke.pathEffect = if (sel && connecting) DashPathEffect(floatArrayOf(6f * density, 4f * density), 0f) else null
            canvas.drawRoundRect(r, rad, rad, stroke)
            stroke.pathEffect = null
            canvas.save()
            canvas.clipRect(r)
            val pad = 10f * k
            var y = r.top + pad
            val type = n.optString("type")
            if (type == "link" || (type == "file" && !isNoteFile(n))) {
                if (type == "link") drawLink(canvas, n, r, pad) else drawFile(canvas, n, r, pad)
                canvas.restore()
                if (dim) {
                    fill.color = Kn.boardFill()
                    fill.alpha = 166
                    canvas.drawRoundRect(r, rad, rad, fill)
                    fill.alpha = 255
                }
                continue
            }
            val title = titleOf(n)
            if (title.isNotEmpty()) {
                val note = if (n.optString("type") == "file") noteOf(n) else null
                fill.color = note?.let { Kn.folderColor(it.optString("folder"), it.optBoolean("isDaily")) } ?: c.blue
                canvas.drawCircle(r.left + pad + 3f * k, y + 6f * k, 3f * k, fill)
                titlePaint.color = c.fg
                titlePaint.textSize = 11f * k
                val tw = r.width() - pad * 2 - 12f * k
                val shown = android.text.TextUtils.ellipsize(title, titlePaint, tw.coerceAtLeast(1f), android.text.TextUtils.TruncateAt.END)
                canvas.drawText(shown, 0, shown.length, r.left + pad + 10f * k, y + 10f * k, titlePaint)
                y += 20f * k
            }
            val body = bodyOf(n)
            if (body.isNotEmpty()) {
                text.color = if (title.isEmpty()) c.fg else c.muted
                text.textSize = (if (title.isEmpty()) 13f else 10f) * k
                val w = (r.width() - pad * 2).toInt().coerceAtLeast(1)
                val maxLines = max(1, ((r.bottom - y - pad / 2) / (text.textSize * 1.3f)).toInt())
                val layout = StaticLayout.Builder.obtain(body, 0, body.length, text, w).setAlignment(Layout.Alignment.ALIGN_NORMAL)
                    .setMaxLines(maxLines).setEllipsize(android.text.TextUtils.TruncateAt.END).build()
                canvas.translate(r.left + pad, y)
                layout.draw(canvas)
            }
            canvas.restore()
            if (dim) {
                fill.color = Kn.boardFill()
                fill.alpha = 166
                canvas.drawRoundRect(r, rad, rad, fill)
                fill.alpha = 255
            }
        }
    }

    private fun isNoteFile(n: JSONObject) = n.optString("pvNote").isNotEmpty() ||
        n.optString("file").substringAfterLast('/').let { it.length > 3 && it.endsWith(".md", ignoreCase = true) }

    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

    /** Картинка по ширине области с обрезкой краёв (`object-fit: cover`). */
    private fun drawCover(canvas: Canvas, bmp: android.graphics.Bitmap, area: RectF) {
        if (area.width() <= 0f || area.height() <= 0f) return
        val s = max(area.width() / bmp.width, area.height() / bmp.height)
        val w = area.width() / s
        val h = area.height() / s
        val src = android.graphics.Rect(((bmp.width - w) / 2).toInt(), ((bmp.height - h) / 2).toInt(), ((bmp.width + w) / 2).toInt(), ((bmp.height + h) / 2).toInt())
        canvas.drawBitmap(bmp, src, area, bitmapPaint)
    }

    private fun drawEllipsized(canvas: Canvas, value: String, paint: TextPaint, x: Float, baseline: Float, width: Float) {
        val shown = android.text.TextUtils.ellipsize(value, paint, width.coerceAtLeast(1f), android.text.TextUtils.TruncateAt.END)
        canvas.drawText(shown, 0, shown.length, x, baseline, paint)
    }

    /** Карточка файла облака (`CanvasFileBody`): картинка либо значок с типом, внизу имя и размер. */
    private fun drawFile(canvas: Canvas, n: JSONObject, r: RectF, pad: Float) {
        val c = Pv.c
        val path = n.optString("file")
        val onScreen = RectF.intersects(r, RectF(0f, 0f, width.toFloat(), height.toFloat()))
        val info = if (onScreen) CanvasMedia.file(context, path, r.width() >= 320f * density) { invalidate() } else null
        val foot = 30f * k
        val body = RectF(r.left, r.top, r.right, r.bottom - foot)
        val bmp = info?.image
        if (bmp != null) drawCover(canvas, bmp, body)
        else {
            titlePaint.color = c.faint
            titlePaint.textSize = 18f * k
            titlePaint.textAlign = Paint.Align.CENTER
            val label = info?.type?.takeIf { it.isNotEmpty() } ?: path.substringAfterLast('.', "").uppercase().take(6).ifEmpty { "FILE" }
            canvas.drawText(label, body.centerX(), body.centerY() + 6f * k, titlePaint)
            titlePaint.textAlign = Paint.Align.LEFT
        }
        fill.color = c.panel
        canvas.drawRect(r.left, r.bottom - foot, r.right, r.bottom, fill)
        val name = info?.name?.takeIf { it.isNotEmpty() } ?: path.substringAfterLast('/')
        val size = when {
            info != null -> CanvasMedia.size(info.size)
            else -> ""
        }
        text.color = c.muted
        text.textSize = 10f * k
        val sizeW = if (size.isEmpty()) 0f else text.measureText(size) + 8f * k
        titlePaint.color = c.fg
        titlePaint.textSize = 11f * k
        val base = r.bottom - foot / 2 + 4f * k
        drawEllipsized(canvas, name, titlePaint, r.left + pad, base, r.width() - pad * 2 - sizeW)
        if (size.isNotEmpty()) canvas.drawText(size, r.right - pad - text.measureText(size), base, text)
    }

    /** Карточка-ссылка (`CanvasLinkBody`): картинка страницы, заголовок, описание, внизу узел сайта. */
    private fun drawLink(canvas: Canvas, n: JSONObject, r: RectF, pad: Float) {
        val c = Pv.c
        val url = n.optString("url")
        val onScreen = RectF.intersects(r, RectF(0f, 0f, width.toFloat(), height.toFloat()))
        val info = if (onScreen) CanvasMedia.link(url) { invalidate() } else null
        val foot = 26f * k
        var y = r.top
        info?.image?.let { bmp ->
            val h = min(r.height() * 0.5f, (r.width() * bmp.height / max(1, bmp.width)).coerceAtLeast(40f * k))
            drawCover(canvas, bmp, RectF(r.left, r.top, r.right, r.top + h))
            y += h
        }
        y += pad
        val w = (r.width() - pad * 2).toInt().coerceAtLeast(1)
        val room = r.bottom - foot - y
        val title = info?.title.orEmpty()
        val description = info?.description.orEmpty()
        if (title.isNotEmpty() && room > 12f * k) {
            titlePaint.color = c.fg
            titlePaint.textSize = 12f * k
            val lines = max(1, min(2, (room / (titlePaint.textSize * 1.3f)).toInt()))
            val l = StaticLayout.Builder.obtain(title, 0, title.length, titlePaint, w).setMaxLines(lines)
                .setEllipsize(android.text.TextUtils.TruncateAt.END).build()
            canvas.save(); canvas.translate(r.left + pad, y); l.draw(canvas); canvas.restore()
            y += l.height + 4f * k
        }
        val shown = description.ifEmpty { if (info == null || !info.hasContent) url else "" }
        if (shown.isNotEmpty() && r.bottom - foot - y > 10f * k) {
            text.color = c.muted
            text.textSize = 10f * k
            val lines = max(1, ((r.bottom - foot - y) / (text.textSize * 1.3f)).toInt())
            val l = StaticLayout.Builder.obtain(shown, 0, shown.length, text, w).setMaxLines(lines)
                .setEllipsize(android.text.TextUtils.TruncateAt.END).build()
            canvas.save(); canvas.translate(r.left + pad, y); l.draw(canvas); canvas.restore()
        }
        fill.color = c.blue
        canvas.drawCircle(r.left + pad + 3f * k, r.bottom - foot / 2, 3f * k, fill)
        text.color = c.muted
        text.textSize = 10f * k
        drawEllipsized(canvas, info?.site?.takeIf { it.isNotEmpty() } ?: CanvasMedia.host(url), text, r.left + pad + 10f * k,
            r.bottom - foot / 2 + 3.5f * k, r.width() - pad * 2 - 10f * k)
    }

    /** Точка выхода стрелки: середина стороны карточки, обращённой к цели, и направление наружу. */
    private fun anchor(r: RectF, tx: Float, ty: Float): Pair<FloatArray, FloatArray> {
        val dx = tx - r.centerX()
        val dy = ty - r.centerY()
        return if (abs(dx) / max(r.width(), 1f) > abs(dy) / max(r.height(), 1f)) {
            if (dx > 0) floatArrayOf(r.right, r.centerY()) to floatArrayOf(1f, 0f) else floatArrayOf(r.left, r.centerY()) to floatArrayOf(-1f, 0f)
        } else {
            if (dy > 0) floatArrayOf(r.centerX(), r.bottom) to floatArrayOf(0f, 1f) else floatArrayOf(r.centerX(), r.top) to floatArrayOf(0f, -1f)
        }
    }

    private fun arrow(canvas: Canvas, tipX: Float, tipY: Float, ux: Float, uy: Float) {
        val a = 9f * k
        val backX = tipX - ux * a
        val backY = tipY - uy * a
        val wing = a * 0.5f
        path.reset()
        path.moveTo(tipX, tipY)
        path.lineTo(backX - uy * wing, backY + ux * wing)
        path.lineTo(backX + uy * wing, backY - ux * wing)
        path.close()
        canvas.drawPath(path, headPaint)
    }

    private fun hit(x: Float, y: Float): JSONObject? {
        val all = list()
        all.filter { it.optString("type") != "group" }.lastOrNull { screen(rect(it)).contains(x, y) }?.let { return it }
        // Группа берётся только за шапку (как web: пустое место внутри двигает поле)
        return all.filter { it.optString("type") == "group" }.lastOrNull {
            val r = screen(rect(it))
            RectF(r.left, r.top, r.right, r.top + 24f * k).contains(x, y)
        }
    }

    private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean {
            zoomAround(scale * d.scaleFactor, d.focusX, d.focusY)
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
                if (!moved) remember()
                moved = true
                val ddx = dx / k
                val ddy = dy / k
                d.put("x", d.optDouble("x") - ddx)
                d.put("y", d.optDouble("y") - ddy)
                // Группа двигается вместе с карточками внутри
                if (d.optString("type") == "group") {
                    val g = rect(d)
                    list().filter { it !== d && it.optString("type") != "group" && g.contains(rect(it).centerX() + ddx, rect(it).centerY() + ddy) }.forEach {
                        it.put("x", it.optDouble("x") - ddx)
                        it.put("y", it.optDouble("y") - ddy)
                    }
                }
            } else { ox -= dx; oy -= dy }
            invalidate()
            return true
        }
        override fun onSingleTapUp(e: MotionEvent): Boolean {
            val n = hit(e.x, e.y)
            val from = selectedId
            if (connecting && from != null && n != null && n.optString("id") != from) {
                remember()
                edges().put(JSONObject().put("id", newId()).put("fromNode", from).put("toNode", n.optString("id")))
                connecting = false
                selectedId = n.optString("id")
                commit()
                return true
            }
            when {
                n == null -> { selectedId = null; connecting = false }
                n.optString("id") == selectedId -> open(n)
                else -> { selectedId = n.optString("id"); connecting = false }
            }
            invalidate()
            onState()
            return true
        }
        override fun onLongPress(e: MotionEvent) {
            val n = hit(e.x, e.y) ?: return
            selectedId = n.optString("id")
            invalidate()
            onState()
            menu(n)
        }
    })

    private fun open(n: JSONObject) {
        when (n.optString("type")) {
            "file" -> noteOf(n)?.let { onOpenNote(it.optString("id")) }
            "text" -> edit(n)
            "group" -> Kn.askText(context, Sx.t("Название группы", "Group name"), n.optString("label")) { t -> remember(); n.put("label", t); commit() }
            "link" -> n.optString("url").takeIf { it.startsWith("http") }?.let {
                try { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(it))) } catch (e: Throwable) { }
            }
        }
    }

    private fun edit(n: JSONObject) = Kn.askText(context, Sx.t("Текст карточки", "Card text"), n.optString("text")) { t -> remember(); n.put("text", t); commit() }

    private fun menu(n: JSONObject) {
        val items = mutableListOf<Pair<String, () -> Unit>>()
        when (n.optString("type")) {
            "file" -> if (isNoteFile(n)) items += Sx.t("Открыть заметку", "Open note") to { open(n) }
            "link" -> items += Sx.t("Открыть ссылку", "Open link") to { open(n) }
            "text" -> items += Sx.t("Изменить текст", "Edit text") to { edit(n) }
            "group" -> items += Sx.t("Переименовать", "Rename") to { open(n) }
        }
        items += Sx.t("Связать с карточкой…", "Connect to card…") to { connecting = true; invalidate(); onState() }
        items += Sx.t("Удалить", "Delete") to { deleteSelected() }
        Kn.menu(context, titleOf(n).ifEmpty { n.optString("text").take(40) }.ifEmpty { Sx.t("Карточка", "Card") }, items, dangerLast = true)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        scaler.onTouchEvent(event)
        if (!scaler.isInProgress) gestures.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            if (moved) commit()
            moved = false
            dragging = null
        }
        return true
    }
}

/**
 * Картинки карточек холста (как web `CanvasFileBody`/`CanvasLinkBody`): файл личного диска по пути карточки —
 * миниатюра облака, у крупной на экране карточки — сам файл; у ссылки — превью страницы через шард preview (на чужой
 * сайт телефон не ходит). Всё в памяти (не больше [MAX_BYTES] картинок), в файл холста не пишется; ненайденное и
 * недоступное повторяется не раньше чем через [RETRY_MS] — облако могло ещё не загрузиться.
 */
object CanvasMedia {
    class FileInfo(val name: String, val size: Long, val type: String, val image: android.graphics.Bitmap?, val askedFull: Boolean)
    class LinkInfo(val title: String, val description: String, val site: String, val image: android.graphics.Bitmap?) {
        val hasContent get() = title.isNotEmpty() || description.isNotEmpty() || image != null
    }

    private const val MAX_BYTES = 96 * 1024 * 1024
    private const val RETRY_MS = 15_000L
    private const val MAX_SIDE = 1280
    private val worker = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "parvane-canvas-media") }
    private val files = object : android.util.LruCache<String, FileInfo>(MAX_BYTES) {
        override fun sizeOf(key: String, value: FileInfo) = (value.image?.byteCount ?: 0) + 256
    }
    private val links = object : android.util.LruCache<String, LinkInfo>(MAX_BYTES / 4) {
        override fun sizeOf(key: String, value: LinkInfo) = (value.image?.byteCount ?: 0) + 256
    }
    private val loading = HashSet<String>()
    private val failedAt = HashMap<String, Long>()

    private fun busy(key: String): Boolean {
        if (key in loading) return true
        val at = failedAt[key] ?: return false
        if (System.currentTimeMillis() - at < RETRY_MS) return true
        failedAt.remove(key)
        return false
    }

    /** Файл карточки; `full` — карточка на экране крупная, нужен сам файл. Готово позже — `ready()` на главном потоке. */
    fun file(context: Context, path: String, full: Boolean, ready: () -> Unit): FileInfo? {
        val have = files.get(path)
        if (have != null && (!full || have.askedFull)) return have
        val key = "$path|$full"
        if (busy(key)) return have
        val root = (Sx.last("cloud") ?: ParvaneSections.snapshot("cloud"))?.optString("rootId")?.takeIf { it.isNotEmpty() && it != "null" }
            ?: return have
        loading += key
        worker.execute {
            val out = java.io.File(context.cacheDir, "parvane-canvas-${Integer.toHexString(path.hashCode())}")
            val info = try {
                val r = ParvaneSections.cloudFiles("canvasFile", JSONObject().put("container", root).put("path", path)
                    .put("full", full).put("out", out.absolutePath)) as? JSONObject
                if (r == null || !r.optBoolean("found")) null else {
                    val kind = r.optString("image")
                    val bmp = if (kind == "full" || kind == "thumb") decode(out) else null
                    FileInfo(r.optString("name"), r.optLong("size"), r.optString("type"), bmp, full)
                }
            } catch (e: Throwable) { null } finally { out.delete() }
            Sx.main.post {
                loading -= key
                if (info == null) failedAt[key] = System.currentTimeMillis()
                else {
                    // Не прочитавшийся файл (нет связи) оставляет прежнюю миниатюру
                    val old = files.get(path)?.image
                    files.put(path, if (info.image == null && old != null) FileInfo(info.name, info.size, info.type, old, full) else info)
                }
                ready()
            }
        }
        return have
    }

    /** Превью ссылки: нет — ещё грузится (null) либо пустое (`hasContent == false`). */
    fun link(url: String, ready: () -> Unit): LinkInfo? {
        links.get(url)?.let { return it }
        if (busy(url)) return null
        loading += url
        worker.execute {
            val info = try {
                val wp = org.parvane.core.ParvaneCore.previewFetch(url, 8000)
                // Картинку рисуем только растровую: SVG может нести сценарий
                val mime = wp.optString("image_mime").lowercase()
                val bmp = wp.optString("image").takeIf { it.isNotEmpty() && mime in listOf("image/jpeg", "image/png", "image/webp", "image/gif") }?.let {
                    val bytes = android.util.Base64.decode(it, android.util.Base64.DEFAULT)
                    decodeBytes(bytes)
                }
                LinkInfo(wp.optString("title").trim().take(200), wp.optString("description").replace(Regex("\\s+"), " ").trim().take(400),
                    wp.optString("site_name").trim(), bmp)
            } catch (e: Throwable) { null }
            Sx.main.post {
                loading -= url
                // Недоступное превью не запоминается: новая попытка через RETRY_MS
                if (info == null || !info.hasContent) failedAt[url] = System.currentTimeMillis()
                if (info != null && info.hasContent) links.put(url, info)
                ready()
            }
        }
        return null
    }

    private fun decode(file: java.io.File): android.graphics.Bitmap? {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0) return null
        return android.graphics.BitmapFactory.decodeFile(file.absolutePath, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample(bounds) })
    }

    private fun decodeBytes(bytes: ByteArray): android.graphics.Bitmap? {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample(bounds) })
    }

    private fun sample(o: android.graphics.BitmapFactory.Options): Int {
        var s = 1
        while (max(o.outWidth, o.outHeight) / (s * 2) >= MAX_SIDE) s *= 2
        return s
    }

    /** Размер файла для карточки: «0 B», «1.5 KB», «12 MB» (`formatCardSize`). */
    fun size(bytes: Long): String {
        var v = max(0L, bytes).toDouble()
        var unit = 0
        val units = listOf("B", "KB", "MB", "GB")
        while (v >= 1024 && unit < units.size - 1) { v /= 1024; unit++ }
        val t = if (v >= 10 || unit == 0) Math.round(v).toString() else String.format(java.util.Locale.US, "%.1f", v).removeSuffix(".0")
        return "$t ${units[unit]}"
    }

    /** Узел сайта без `www.`; адрес не разобрать — он сам. */
    fun host(url: String): String = try { android.net.Uri.parse(url).host?.removePrefix("www.")?.takeIf { it.isNotEmpty() } ?: url } catch (e: Throwable) { url }
}
