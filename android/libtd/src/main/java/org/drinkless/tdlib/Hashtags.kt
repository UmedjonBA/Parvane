package org.drinkless.tdlib

/** Подсказки «#» (`SearchHashtags`): хэштеги из своей истории на устройстве, частые — первыми (сервера хэштегов нет). */
object Hashtags {
    private val TAG_RE = Regex("#[\\p{L}\\p{N}_]{1,64}")

    /** Хэштеги текстов [texts], начинающиеся с [prefix] (без «#», регистр не важен), без повторов, не больше [limit]. */
    fun search(texts: List<String>, prefix: String, limit: Int): List<String> {
        val p = prefix.removePrefix("#").lowercase()
        val count = LinkedHashMap<String, Int>()
        for (t in texts) for (m in TAG_RE.findAll(t)) {
            val tag = m.value.substring(1)
            if (p.isEmpty() || tag.lowercase().startsWith(p)) count[tag] = (count[tag] ?: 0) + 1
        }
        return count.entries.sortedByDescending { it.value }.map { it.key }.take(limit)
    }
}
