package org.drinkless.tdlib

/**
 * CONTACT-1 (порт web `contactInfo.ts`): своё имя контакта из формы «Изменить»/«Добавить в контакты». Имя, совпадающее с
 * заданным самим собеседником (форма предзаполнена и сохранена без правки), своим не считается — иначе смена имени
 * собеседником перестала бы быть видна. Предел — 256 байт UTF-8 на имя, 4096 на заметку.
 */
object ContactNames {
    private const val MAX_NAME_BYTES = 256
    private const val MAX_NOTE_BYTES = 4096

    fun clamp(value: String, maxBytes: Int): String {
        val text = value.trim()
        if (text.toByteArray(Charsets.UTF_8).size <= maxBytes) return text
        val out = StringBuilder()
        var bytes = 0
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val s = String(Character.toChars(cp))
            val n = s.toByteArray(Charsets.UTF_8).size
            if (bytes + n > maxBytes) break
            out.append(s); bytes += n; i += Character.charCount(cp)
        }
        return out.toString()
    }

    fun clampNote(note: String): String = clamp(note, MAX_NOTE_BYTES)

    /** (имя, фамилия) своего имени контакта либо null — показывать имя, заданное собеседником. */
    fun override(publicName: String, firstName: String, lastName: String): Pair<String, String>? {
        val first = clamp(firstName, MAX_NAME_BYTES)
        val last = clamp(lastName, MAX_NAME_BYTES)
        if (first.isEmpty() && last.isEmpty()) return null
        if (last.isEmpty() && first == publicName.trim()) return null
        return first to last
    }
}
