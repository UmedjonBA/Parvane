package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.text.style.BackgroundColorSpan
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.SubscriptSpan
import android.text.style.SuperscriptSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvaneSections

/**
 * Parvane (доработка 6 ноя 2026): показ Markdown заметки по разбору ядра (`ParvaneSections.markdown` — тот же разбор,
 * что web `markdown.ts` и desktop; сверка — `conformance/markdown/`). Вид — web `MarkdownBlocks` / `Markdown.module.scss`:
 * заголовки H1–H6, абзацы, списки (номера, галочки, блоки внутри пункта), цитаты с блоками и callouts, код с языком,
 * таблицы, черта, встроенные файлы; в строке — жирный, курсив, зачёркнутый, подчёркнутый, выделение, индексы, код,
 * ссылки (http(s)/mailto — через подтверждение, `#раздел` — прокрутка к заголовку), [[заметки]], #теги.
 */
class NoteMarkdown(
    private val context: Context,
    private val onNote: (String) -> Unit,
    private val onUrl: (String) -> Unit,
    // Галочка пункта: номер строки текста заметки и новое состояние; null — галочки только показываются
    private val onTask: ((Int, Boolean) -> Unit)?,
    // Встроенный файл (`embed`): вид картинки/видео облака; внешний адрес показывается ссылкой здесь
    private val embed: (String) -> View,
    // Прокрутка для якорей `#раздел`
    private val scroll: () -> ScrollView?,
) {
    private val anchors = HashMap<String, View>()

    /** Вид текста заметки: блоки сверху вниз. */
    fun render(text: String, title: String): LinearLayout = blocks(ParvaneSections.markdown(text, title))

    private fun blocks(list: JSONArray): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        for (i in 0 until list.length()) {
            val block = list.optJSONObject(i) ?: continue
            val view = block(block) ?: continue
            val top = if (childCount == 0) 0 else Pv.rem(0.5f) + headingMargin(block)
            addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = top
            })
        }
    }

    private fun headingMargin(block: JSONObject): Int = if (block.optString("type") != "heading") 0 else when (block.optInt("level")) {
        1 -> Pv.rem(0.625f)
        2 -> Pv.rem(0.5f)
        3 -> Pv.rem(0.375f)
        else -> Pv.rem(0.25f)
    }

    private fun block(block: JSONObject): View? = when (block.optString("type")) {
        "heading" -> heading(block)
        "paragraph" -> textView(block.optJSONArray("parts"), 1f, Pv.c.fg)
        "list" -> list(block)
        "quote" -> quote(block)
        "code" -> code(block)
        "rule" -> View(context).apply {
            setBackgroundColor(Pv.c.line)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.px(1f))
            minimumHeight = Pv.px(1f)
        }.let { line ->
            LinearLayout(context).apply {
                setPadding(0, Pv.rem(0.25f), 0, Pv.rem(0.25f))
                addView(line, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Pv.px(1f)))
            }
        }
        "table" -> table(block)
        "embed" -> if (block.has("url")) textView(JSONArray().put(JSONObject().put("type", "link")
            .put("text", block.optString("alt").ifEmpty { block.optString("url") }).put("url", block.optString("url"))), 1f, Pv.c.muted)
            else embed(block.optString("name"))
        else -> null
    }

    // `.heading1` 1.125rem `--pv-accent`, `.heading2/3` `--pv-orange`, `.heading4/5` `--pv-yellow`, `.heading6` `--pv-muted`
    private fun heading(block: JSONObject): View {
        val level = block.optInt("level", 1)
        val size = when (level) { 1 -> 1.125f; 2 -> 1f; 3 -> 0.9375f; else -> 0.875f }
        val color = when (level) { 1 -> Pv.c.accent; 2, 3 -> Pv.c.orange; 4, 5 -> Pv.c.yellow; else -> Pv.c.muted }
        return textView(block.optJSONArray("parts"), size, color, bold = true).also { view ->
            block.optString("id").takeIf { it.isNotEmpty() }?.let { anchors[it] = view }
        }
    }

    private fun list(block: JSONObject): View = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        val items = block.optJSONArray("items") ?: JSONArray()
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            addView(item(item), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                if (i > 0) topMargin = Pv.rem(0.25f)
                marginStart = item.optInt("depth") * Pv.rem(1.25f)
            })
        }
    }

    private fun item(item: JSONObject): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        val isTask = item.has("isChecked")
        val done = item.optBoolean("isChecked")
        val marker = when {
            isTask -> if (done) "●" else "○"
            item.has("number") -> "${item.optInt("number")}."
            else -> "•"
        }
        addView(context.pvText(marker, 1f, if (isTask) (if (done) Pv.c.task else Pv.c.line2) else Pv.c.faint).apply {
            gravity = Gravity.END
            minWidth = Pv.rem(1f)
            if (isTask) {
                contentDescription = Sx.t(if (done) "Выполнено" else "Не выполнено", if (done) "Done" else "Not done")
                val line = item.optInt("line")
                onTask?.let { toggle -> setOnClickListener { toggle(line, !done) } }
                setPadding(Pv.rem(0.25f), 0, Pv.rem(0.25f), 0)
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            marginEnd = Pv.rem(0.375f)
        })
        addView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(textView(item.optJSONArray("parts"), 1f, if (isTask && done) Pv.c.faint else Pv.c.fg, strike = isTask && done))
            item.optJSONArray("blocks")?.takeIf { it.length() > 0 }?.let { inner ->
                addView(blocks(inner), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = Pv.rem(0.375f)
                })
            }
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    // Цитата: черта `--pv-accent` слева и отступ; callout — подложка и черта тоном вида, заголовок, сворачивание
    private fun quote(block: JSONObject): View {
        val callout = block.optJSONObject("callout")
        val tone = callout?.let { calloutTone(it.optString("kind")) } ?: Pv.c.accent
        val body = blocks(block.optJSONArray("blocks") ?: JSONArray())
        val content = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        if (callout != null) {
            val fold = callout.optString("fold")
            var collapsed = fold == "closed"
            val titleParts = callout.optJSONArray("titleParts")?.takeIf { it.length() > 0 }
                ?: JSONArray().put(JSONObject().put("type", "text").put("text", calloutTitle(callout.optString("kind"))))
            val title = textView(titleParts, 1f, tone, bold = true)
            fun refresh() {
                body.visibility = if (collapsed) View.GONE else View.VISIBLE
                if (fold.isNotEmpty()) title.text = SpannableStringBuilder(if (collapsed) "▸ " else "▾ ").append(spans(titleParts))
            }
            if (fold.isNotEmpty()) title.setOnClickListener { collapsed = !collapsed; refresh() }
            refresh()
            content.addView(title)
            content.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Pv.rem(0.375f)
            })
            content.setPadding(Pv.rem(0.75f), Pv.rem(0.5f), Pv.rem(0.75f), Pv.rem(0.5f))
            content.background = Pv.shape(Pv.alpha(tone, 10), 0.375f)
        } else {
            content.addView(body)
            content.setPadding(Pv.rem(0.75f), 0, 0, 0)
            tintMuted(body)
        }
        return LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(View(context).apply { setBackgroundColor(tone) },
                LinearLayout.LayoutParams(Pv.rem(0.1875f), ViewGroup.LayoutParams.MATCH_PARENT))
            addView(content, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
    }

    // Текст простой цитаты — `--pv-muted` (куски с цветом — теги, ссылки — свой цвет сохраняют)
    private fun tintMuted(view: View) {
        if (view is TextView) view.setTextColor(Pv.c.muted)
        if (view is ViewGroup) for (i in 0 until view.childCount) tintMuted(view.getChildAt(i))
    }

    // Код: подложка `--pv-raised`, моноширинный 0.8125rem, язык подписью справа; длинные строки листаются вбок
    private fun code(block: JSONObject): View = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = Pv.shape(Pv.c.raised, 0.5f)
        setPadding(Pv.rem(0.75f), Pv.rem(0.5f), Pv.rem(0.75f), Pv.rem(0.5f))
        block.optString("lang").takeIf { it.isNotEmpty() }?.let { lang ->
            addView(context.pvText(lang, 0.6875f, Pv.c.faint, mono = true).apply { gravity = Gravity.END },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        addView(HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            addView(context.pvText(block.optString("text"), 0.8125f, Pv.c.fg, mono = true).apply { setTextIsSelectable(true) })
        })
    }

    // Таблица: ячейки в рамке `--pv-line`, шапка полужирная на `--pv-raised`, текст 0.875rem; широкая — листается вбок
    private fun table(block: JSONObject): View {
        val align = block.optJSONArray("align") ?: JSONArray()
        val table = TableLayout(context)
        fun row(cells: JSONArray?, head: Boolean) = TableRow(context).apply {
            for (i in 0 until (cells?.length() ?: 0)) {
                val gravity = when (align.optString(i)) { "center" -> Gravity.CENTER_HORIZONTAL; "right" -> Gravity.END; else -> Gravity.START }
                addView(textView(cells?.optJSONArray(i), 0.875f, Pv.c.fg, bold = head).apply {
                    this.gravity = gravity
                    setPadding(Pv.rem(0.625f), Pv.rem(0.3125f), Pv.rem(0.625f), Pv.rem(0.3125f))
                    background = Pv.shape(if (head) Pv.c.raised else 0, 0f, Pv.c.line)
                })
            }
        }
        table.addView(row(block.optJSONArray("headerParts"), true))
        val rows = block.optJSONArray("rowParts") ?: JSONArray()
        for (r in 0 until rows.length()) table.addView(row(rows.optJSONArray(r), false))
        return HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            addView(table)
        }
    }

    private fun textView(parts: JSONArray?, size: Float, color: Int, bold: Boolean = false, strike: Boolean = false): TextView =
        context.pvText(spans(parts ?: JSONArray()).also { s ->
            if (strike && s.isNotEmpty()) s.setSpan(StrikethroughSpan(), 0, s.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }, size, color, semibold = bold).apply {
            if (bold) typeface = Typeface.create(Pv.semibold(), Typeface.BOLD)
            movementMethod = LinkMovementMethod.getInstance()
            setLineSpacing(0f, 1.5f / 1.2f)
            highlightColor = Pv.alpha(Pv.c.accent, 22)
        }

    /** Куски строки → текст со стилями (биты стиля — как MD_* web: 1 жирный … 128 код). */
    private fun spans(parts: JSONArray): SpannableStringBuilder {
        val c = Pv.c
        val out = SpannableStringBuilder()
        for (i in 0 until parts.length()) {
            val part = parts.optJSONObject(i) ?: continue
            val text = part.optString("text")
            if (text.isEmpty()) continue
            val a = out.length
            out.append(text)
            val b = out.length
            fun span(what: Any) = out.setSpan(what, a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            val style = part.optInt("style")
            if (style and 1 != 0) span(StyleSpan(Typeface.BOLD))
            if (style and 2 != 0) span(StyleSpan(Typeface.ITALIC))
            if (style and 4 != 0) span(StrikethroughSpan())
            if (style and 8 != 0) span(UnderlineSpan())
            if (style and 16 != 0) span(BackgroundColorSpan(Pv.alpha(c.yellow, 35)))
            if (style and 32 != 0) { span(SubscriptSpan()); span(RelativeSizeSpan(0.75f)) }
            if (style and 64 != 0) { span(SuperscriptSpan()); span(RelativeSizeSpan(0.75f)) }
            if (style and 128 != 0) {
                span(TypefaceSpan("monospace"))
                span(RelativeSizeSpan(0.8125f))
                span(ForegroundColorSpan(c.orange))
                span(BackgroundColorSpan(c.hover))
            }
            when (part.optString("type")) {
                "tag" -> span(ForegroundColorSpan(c.aqua))
                "note" -> {
                    val target = part.optString("target")
                    span(Link(c.purple, false) { onNote(target) })
                    span(StyleSpan(Typeface.BOLD))
                }
                "link" -> {
                    val url = part.optString("url")
                    span(Link(c.blue, true) { if (url.startsWith("#")) scrollTo(url.substring(1)) else onUrl(url) })
                }
            }
        }
        return out
    }

    // Якорь `#раздел`: заголовок с этим id (без учёта регистра) — к верху видимой области
    private fun scrollTo(raw: String) {
        val id = try { java.net.URLDecoder.decode(raw, "UTF-8") } catch (e: Throwable) { raw }
        val target = anchors[id] ?: anchors[id.lowercase()] ?: return
        val scroll = scroll() ?: return
        var y = 0
        var view: View? = target
        while (view != null && view.parent !== scroll) {
            y += view.top
            view = view.parent as? View
        }
        scroll.smoothScrollTo(0, y)
    }

    private class Link(private val color: Int, private val underline: Boolean, private val action: () -> Unit) : ClickableSpan() {
        override fun onClick(widget: View) = action()
        override fun updateDrawState(ds: TextPaint) {
            ds.color = color
            ds.isUnderlineText = underline
        }
    }

    private fun calloutTone(kind: String): Int = when (kind) {
        "note", "info", "todo" -> Pv.c.blue
        "abstract", "summary", "tldr" -> Pv.c.aqua
        "tip", "hint", "success", "check", "done" -> Pv.c.green
        "important", "example" -> Pv.c.purple
        "question", "help", "faq" -> Pv.c.yellow
        "warning", "attention" -> Pv.c.orange
        "caution", "danger", "error", "failure", "fail", "missing", "bug" -> Pv.c.red
        "quote", "cite" -> Pv.c.muted
        else -> Pv.c.accent
    }

    private fun calloutTitle(kind: String): String = when (kind) {
        "note" -> Sx.t("Примечание", "Note")
        "tip" -> Sx.t("Совет", "Tip")
        "important" -> Sx.t("Важно", "Important")
        "warning" -> Sx.t("Предупреждение", "Warning")
        "caution" -> Sx.t("Осторожно", "Caution")
        else -> kind.replaceFirstChar { it.uppercase() }
    }
}
