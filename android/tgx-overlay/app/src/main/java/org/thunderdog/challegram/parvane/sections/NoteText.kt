package org.thunderdog.challegram.parvane.sections

import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.BulletSpan
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.QuoteSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.view.View

/**
 * Parvane (spec 031/032): Markdown заметок «Знаний» для просмотра, вид web (`Markdown.module.scss`): заголовки — акцент и
 * оранжевый, пункты списка — маркер `--pv-faint`, галочки задач, цитаты с полосой акцента, код — оранжевым на
 * подложке, ссылки `[[Заметка]]` — фиолетовым (нажатие — открыть заметку), #теги — цветом aqua, обычные ссылки.
 * Без HTML и без сети: картинки и встраивания показываются подписью.
 */
object NoteText {
    private val wiki = Regex("""\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?]]""")
    private val link = Regex("""\[([^\]]+)]\((https?://[^)\s]+)\)""")
    private val bold = Regex("""\*\*(.+?)\*\*""")
    private val italic = Regex("""(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)""")
    private val strike = Regex("""~~(.+?)~~""")
    private val code = Regex("""`([^`]+)`""")
    private val tag = Regex("""(?<![\p{L}\p{N}_/#])#[\p{L}\p{N}_][\p{L}\p{N}_/-]*""")
    private val embed = Regex("""!\[\[([^\]]+)]]|!\[([^\]]*)]\(([^)]+)\)""")

    /** Первая непустая строка без разметки — подпись в списке. */
    fun preview(text: String): String = text.lineSequence()
        .map { it.trim().trimStart('#', '>', '-', '*', ' ').replace(Regex("""\[\[([^\]|]+)(\|[^\]]+)?]]"""), "$1") }
        .firstOrNull { it.isNotBlank() && !it.startsWith("---") }.orEmpty().take(140)

    /** Тело заметки без свойств (`---` … `---` в начале). */
    fun bodyWithoutProperties(text: String): String {
        if (!text.startsWith("---\n")) return text
        val end = text.indexOf("\n---", 4)
        return if (end < 0) text else text.substring(end + 4).trimStart('\n')
    }

    /** Ссылки `[[…]]` заметки — названия. */
    fun links(text: String): Set<String> = wiki.findAll(text).map { it.groupValues[1].trim() }.toSet()

    /** Ссылки `[[…]]` по порядку появления (для графа: важен порядок, повторы убраны). */
    /** Ссылки `[[…]]` заметки; внутри кода (блоки ``` и `строчный`) — не ссылки, как `maskCode` web. */
    fun linkList(text: String): List<String> {
        var fenced = false
        val masked = text.lines().joinToString("\n") { line ->
            if (line.trimStart().startsWith("```")) { fenced = !fenced; "" }
            else if (fenced) ""
            else inlineCode.replace(line) { " ".repeat(it.value.length) }
        }
        return wiki.findAll(masked).map { it.groupValues[1].trim() }.filter { it.isNotEmpty() }.distinct().toList()
    }

    private val inlineCode = Regex("""(`+)(?!`)[\s\S]*?[^`]\1(?!`)""")

    fun render(text: String, onWiki: (String) -> Unit, onUrl: (String) -> Unit): CharSequence {
        val c = Pv.c
        val out = SpannableStringBuilder()
        var inCode = false
        var frontMatter = false
        text.lines().forEachIndexed { index, raw ->
            if (index == 0 && raw.trim() == "---") { frontMatter = true; return@forEachIndexed }
            if (frontMatter) { if (raw.trim() == "---") frontMatter = false; return@forEachIndexed }
            if (raw.trimStart().startsWith("```")) { inCode = !inCode; return@forEachIndexed }
            val start = out.length
            if (inCode) {
                out.append(raw).append('\n')
                out.setSpan(TypefaceSpan("monospace"), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                out.setSpan(RelativeSizeSpan(0.8125f), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                out.setSpan(BackgroundColorSpan(c.raised), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                return@forEachIndexed
            }
            var line = raw
            val heading = Regex("""^(#{1,6})\s+(.*)$""").find(line)
            val task = Regex("""^\s*[-*]\s+\[([ xX])]\s+(.*)$""").find(line)
            val bullet = Regex("""^\s*[-*+]\s+(.*)$""").find(line)
            val numbered = Regex("""^\s*(\d+)[.)]\s+(.*)$""").find(line)
            val quote = Regex("""^>\s?(.*)$""").find(line)
            val rule = Regex("""^\s*(---|\*\*\*|___)\s*$""").matches(line)
            var prefix = ""
            when {
                rule -> line = "────────────"
                heading != null -> line = heading.groupValues[2]
                task != null -> { prefix = if (task.groupValues[1].isBlank()) "○  " else "●  "; line = task.groupValues[2] }
                bullet != null -> line = bullet.groupValues[1]
                numbered != null -> { prefix = "${numbered.groupValues[1]}. "; line = numbered.groupValues[2] }
                quote != null -> line = quote.groupValues[1]
            }
            // Встраивания (картинки, файлы) — подписью
            line = embed.replace(line) { m -> "▫ " + (m.groupValues[1].ifEmpty { m.groupValues[2].ifEmpty { m.groupValues[3] } }) }
            out.append(prefix)
            if (prefix.isNotEmpty() && task != null) {
                out.setSpan(ForegroundColorSpan(if (task.groupValues[1].isBlank()) c.line2 else c.task), start, start + prefix.length,
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            if (prefix.isNotEmpty() && numbered != null) {
                out.setSpan(ForegroundColorSpan(c.faint), start, start + prefix.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            inline(out, line, onWiki, onUrl)
            out.append('\n')
            val end = out.length
            when {
                rule -> out.setSpan(ForegroundColorSpan(c.line), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                heading != null -> {
                    val level = heading.groupValues[1].length
                    out.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(if (level == 1) c.accent else c.orange), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(RelativeSizeSpan(when (level) { 1 -> 1.125f; 2 -> 1f; else -> 0.9375f }), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                task != null -> {
                    if (task.groupValues[1].isNotBlank()) {
                        out.setSpan(StrikethroughSpan(), start + prefix.length, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                        out.setSpan(ForegroundColorSpan(c.faint), start + prefix.length, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    }
                }
                bullet != null -> out.setSpan(BulletSpan(Pv.rem(0.875f), c.faint), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                numbered != null -> out.setSpan(LeadingMarginSpan.Standard(Pv.rem(0.375f)), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                quote != null -> {
                    out.setSpan(QuoteSpan(c.accent), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(c.muted), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
        while (out.isNotEmpty() && out[out.length - 1] == '\n') out.delete(out.length - 1, out.length)
        return out
    }

    private class Link(private val color: Int, private val underline: Boolean, private val action: () -> Unit) : ClickableSpan() {
        override fun onClick(widget: View) = action()
        override fun updateDrawState(ds: TextPaint) {
            ds.color = color
            ds.isUnderlineText = underline
        }
    }

    // Строчная разметка: ссылки, затем жирный/курсив/код/зачёркнутый, теги
    private fun inline(out: SpannableStringBuilder, line: String, onWiki: (String) -> Unit, onUrl: (String) -> Unit) {
        val c = Pv.c
        data class Mark(val range: IntRange, val shown: String, val apply: (SpannableStringBuilder, Int, Int) -> Unit)
        val marks = mutableListOf<Mark>()
        fun add(r: Regex, shown: (MatchResult) -> String, apply: (MatchResult) -> (SpannableStringBuilder, Int, Int) -> Unit) {
            r.findAll(line).forEach { m -> if (marks.none { it.range.first <= m.range.last && m.range.first <= it.range.last }) marks += Mark(m.range, shown(m), apply(m)) }
        }
        add(wiki, { m -> m.groupValues[2].ifEmpty { m.groupValues[1] } }) { m ->
            val title = m.groupValues[1].trim()
            ({ s, a, b ->
                s.setSpan(Link(c.purple, false) { onWiki(title) }, a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                s.setSpan(StyleSpan(Typeface.BOLD), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            })
        }
        add(link, { m -> m.groupValues[1] }) { m ->
            val url = m.groupValues[2]
            ({ s, a, b -> s.setSpan(Link(c.blue, true) { onUrl(url) }, a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) })
        }
        add(code, { m -> m.groupValues[1] }) { _ ->
            ({ s, a, b ->
                s.setSpan(TypefaceSpan("monospace"), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                s.setSpan(RelativeSizeSpan(0.8125f), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                s.setSpan(ForegroundColorSpan(c.orange), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                s.setSpan(BackgroundColorSpan(c.hover), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            })
        }
        add(bold, { m -> m.groupValues[1] }) { _ -> ({ s, a, b -> s.setSpan(StyleSpan(Typeface.BOLD), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }) }
        add(strike, { m -> m.groupValues[1] }) { _ -> ({ s, a, b -> s.setSpan(StrikethroughSpan(), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }) }
        add(italic, { m -> m.groupValues[1].ifEmpty { m.groupValues[2] } }) { _ -> ({ s, a, b -> s.setSpan(StyleSpan(Typeface.ITALIC), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }) }
        add(tag, { m -> m.value }) { _ -> ({ s, a, b -> s.setSpan(ForegroundColorSpan(c.aqua), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }) }
        var pos = 0
        marks.sortedBy { it.range.first }.forEach { m ->
            out.append(line, pos, m.range.first)
            val a = out.length
            out.append(m.shown)
            m.apply(out, a, out.length)
            pos = m.range.last + 1
        }
        out.append(line, pos, line.length)
    }
}
