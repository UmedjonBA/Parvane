package org.thunderdog.challegram.parvane.sections

/**
 * Parvane (spec 031/032): текстовые помощники заметок «Знаний» — подпись в списке, тело без свойств, ссылки `[[…]]`
 * для графа. Показ Markdown — `NoteMarkdown` (разбор ядра, 6 ноя 2026).
 */
object NoteText {
    private val wiki = Regex("""\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?]]""")

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
        return wiki.findAll(masked).filterNot { isFileEmbed(masked, it) }
            .map { it.groupValues[1].trim() }.filter { it.isNotEmpty() }.distinct().toList()
    }

    /** Встраивание файла (`![[x.png]]`, расширение не `.md`) — не связь графа (web `notesModel.ts isFileEmbed`,
     *  ядро `notes_model.cpp`): иначе файлы заметок висят в графе бледными «несуществующими заметками». */
    private fun isFileEmbed(text: String, match: MatchResult): Boolean {
        val from = match.range.first
        if (from == 0 || text[from - 1] != '!') return false
        val name = match.groupValues[1].trim().substringAfterLast('/')
        val ext = Regex("""\.([A-Za-z0-9]{1,8})$""").find(name)?.groupValues?.get(1) ?: return false
        return !ext.equals("md", ignoreCase = true)
    }

    private val inlineCode = Regex("""(`+)(?!`)[\s\S]*?[^`]\1(?!`)""")
}
