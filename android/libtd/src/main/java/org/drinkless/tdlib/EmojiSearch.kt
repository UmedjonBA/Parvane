package org.drinkless.tdlib

/**
 * Поиск эмодзи по слову (подсказки `:слово` и поле поиска панели эмодзи X, `SearchEmojis`/`GetKeywordEmojis`) без
 * сервера ключевых слов Telegram: по названиям символов Unicode (`Character.getName`, английские слова) и небольшому
 * русскому словарю частых эмодзи. Поиск стикеров по слову (`SearchStickers`) — по найденным эмодзи среди установленных
 * наборов. Чистый JVM-класс.
 */
object EmojiSearch {
    /** Однокодовые эмодзи: основные блоки Unicode (смайлы, символы, транспорт, дополнительные пиктограммы). */
    private val RANGES = listOf(0x1F600..0x1F64F, 0x1F300..0x1F5FF, 0x1F680..0x1F6FF, 0x1F900..0x1F9FF, 0x1FA70..0x1FAFF, 0x2600..0x27BF)

    /** Русские слова → эмодзи (первым — самое частое). */
    private val RU = linkedMapOf(
        "смех" to "😂", "смеюсь" to "😂", "улыб" to "😊", "радост" to "😄", "груст" to "😢", "плач" to "😭", "слез" to "😢",
        "сердц" to "❤️", "любов" to "❤️", "люблю" to "😍", "поцел" to "😘", "огон" to "🔥", "класс" to "👍", "лайк" to "👍",
        "хорош" to "👌", "ок" to "👌", "плох" to "👎", "злост" to "😡", "злой" to "😠", "удивл" to "😮", "шок" to "😱",
        "думаю" to "🤔", "подума" to "🤔", "спасиб" to "🙏", "пожалуйст" to "🙏", "хлоп" to "👏", "аплод" to "👏",
        "праздн" to "🎉", "поздрав" to "🎉", "торт" to "🎂", "подар" to "🎁", "солнц" to "☀️", "дожд" to "🌧", "снег" to "❄️",
        "звезд" to "⭐", "цвет" to "🌸", "роз" to "🌹", "кот" to "🐱", "собак" to "🐶", "кофе" to "☕", "чай" to "🍵",
        "пиво" to "🍺", "вино" to "🍷", "пицц" to "🍕", "яблок" to "🍎", "машин" to "🚗", "самолет" to "✈️", "самолёт" to "✈️",
        "дом" to "🏠", "деньг" to "💰", "время" to "⏰", "часы" to "⌚", "телефон" to "📱", "книг" to "📚", "музык" to "🎵",
        "спорт" to "⚽", "мяч" to "⚽", "сон" to "😴", "сплю" to "😴", "устал" to "😩", "круто" to "😎", "очки" to "😎",
        "привет" to "👋", "пока" to "👋", "сила" to "💪", "ракет" to "🚀", "ура" to "🥳", "больн" to "🤒", "болею" to "🤒",
        "клоун" to "🤡", "призрак" to "👻", "череп" to "💀", "глаз" to "👀", "молни" to "⚡", "галочк" to "✅", "крест" to "❌",
    )

    data class Hit(val emoji: String, val keyword: String)

    /** Эмодзи по слову (начало слова; регистр не важен), не больше [limit]. */
    fun search(text: String?, limit: Int = 50): List<Hit> {
        val q = (text ?: "").trim().lowercase()
        if (q.length < 2) return emptyList()
        val out = LinkedHashMap<String, Hit>()
        for ((word, emoji) in RU) if (word.startsWith(q) || (word.length >= 4 && q.startsWith(word))) out.putIfAbsent(emoji, Hit(emoji, word))
        for (range in RANGES) for (cp in range) {
            if (out.size >= limit) break
            val name = try { Character.getName(cp) } catch (e: Exception) { null } ?: continue
            val words = name.lowercase().split(' ', '-')
            val word = words.firstOrNull { it.startsWith(q) } ?: continue
            val emoji = String(Character.toChars(cp))
            out.putIfAbsent(emoji, Hit(emoji, word))
        }
        return out.values.take(limit)
    }
}
