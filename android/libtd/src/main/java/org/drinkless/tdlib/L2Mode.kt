package org.drinkless.tdlib

import org.json.JSONObject

/**
 * Режим «усиленная приватность» (L2, правило conformance L2-1; spec 007, T079) в шве.
 *
 * Кэш события ядра `{"type":"l2_state","chats":[…],"mine":[…],"presence_allowed":bool}`
 * (v2-сессия шлёт его при готовности и при каждом изменении набора): чаты с активным
 * режимом (адрес собеседника или группа "v2g:<hex>"), из них личные чаты, где режим включён
 * мной. Решения «слать ли typing», «показывать ли typing/в сети» принимаются ТОЛЬКО по кэшу —
 * методы сессии ждут мьютекс движка и на горячем пути недопустимы.
 *
 * Смена режима — видимое служебное сообщение чата: содержимое `{"kind":"chat_mode","l2":bool}`
 * → `TdApi.MessageCustomServiceAction` ([serviceText]).
 *
 * Строка-переключатель в профиле X читает состояние опцией `x_parvane_l2:<chatId>`
 * (биты [BIT_ACTIVE]…) и меняет его `SetOption` с тем же именем. Чистый JVM-класс.
 */
class L2Mode {
    private var chats: Set<String> = emptySet()
    private var mine: Set<String> = emptySet()
    @Volatile var presenceAllowed: Boolean = true
        private set
    private var version = 0L
    private val lock = Object()

    /** Принять событие ядра `l2_state`; возвращает чаты, у которых «активен» изменилось. */
    fun apply(event: JSONObject): Set<String> = synchronized(lock) {
        fun list(key: String): Set<String> {
            val arr = event.optJSONArray(key) ?: return emptySet()
            return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }.toSet()
        }
        val next = list("chats")
        val changed = (chats - next) + (next - chats)
        chats = next
        mine = list("mine").intersect(next)
        presenceAllowed = event.optBoolean("presence_allowed", true)
        version++
        lock.notifyAll()
        changed
    }

    fun clear() = synchronized(lock) { chats = emptySet(); mine = emptySet(); presenceAllowed = true; version++; lock.notifyAll() }

    /** Режим активен в чате (включён мной, собеседником или политикой группы). */
    fun isActive(chat: String): Boolean = synchronized(lock) { chat in chats }
    /** Личный чат: режим включён мной (моё предпочтение). */
    fun isMine(chat: String): Boolean = synchronized(lock) { chat in mine }
    /** typing/«в сети» в этом чате разрешены. */
    fun ephemeralAllowed(chat: String): Boolean = !isActive(chat)
    fun activeCount(): Int = synchronized(lock) { chats.size }

    /** Номер состояния (растёт с каждым событием) — для [awaitChange]. */
    fun version(): Long = synchronized(lock) { version }
    /** Дождаться события ядра после своей смены режима (≤ timeoutMs); true — пришло. */
    fun awaitChange(since: Long, timeoutMs: Long): Boolean = synchronized(lock) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (version == since) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) return@synchronized false
            lock.wait(left)
        }
        true
    }

    /**
     * Состояние строки-переключателя (значение опции `x_parvane_l2:<chatId>`).
     * Личный чат: «включено» = моё предпочтение; режим активен, но не мной — «включена собеседником».
     * Группа: «включено» = политика группы; менять может тот, у кого право менять сведения.
     */
    fun optionBits(chat: String, group: Boolean, canChange: Boolean): Long = synchronized(lock) {
        val active = chat in chats
        val checked = if (group) active else chat in mine
        var bits = 0L
        if (active) bits = bits or BIT_ACTIVE
        if (checked) bits = bits or BIT_CHECKED
        if (!group && active && !checked) bits = bits or BIT_BY_PEER
        if (canChange) bits = bits or BIT_CAN_CHANGE
        bits
    }

    companion object {
        const val CONTENT_KIND = "chat_mode"
        const val OPTION_PREFIX = "x_parvane_l2:"
        const val BIT_ACTIVE = 1L      // режим активен в чате
        const val BIT_CHECKED = 2L     // тумблер включён (моё предпочтение / политика группы)
        const val BIT_BY_PEER = 4L     // активен из-за собеседника — подпись «Включена собеседником»
        const val BIT_CAN_CHANGE = 8L  // можно менять (личный чат — всегда; группа — право менять сведения)

        fun isChatMode(content: JSONObject?): Boolean = content?.optString("kind") == CONTENT_KIND

        /** chatId из имени опции `x_parvane_l2:<chatId>`; null — не она. */
        fun chatIdOfOption(name: String?): Long? =
            if (name != null && name.startsWith(OPTION_PREFIX)) name.substring(OPTION_PREFIX.length).toLongOrNull() else null

        /**
         * Текст служебного сообщения о смене режима. [own] — своё действие («Вы …»);
         * [actor] — имя участника (пусто — автор записи неизвестен).
         */
        fun serviceText(content: JSONObject, own: Boolean, actor: String, ru: Boolean = SeamText.isRu()): String {
            val state = if (content.optBoolean("l2")) "l2_enabled" else "l2_disabled"
            return when {
                own -> SeamText.of(state + "_you", ru)!!
                actor.isEmpty() -> SeamText.of(state + "_anon", ru)!!
                else -> SeamText.of(state, ru)!!.replace("%s", actor)
            }
        }

        /**
         * Право менять политику группы — как у изменения сведений: владелец; админ с правом
         * `change_info` (прав нет в записи — полный набор); участник — по правам по умолчанию.
         */
        fun canChangeGroup(role: String?, adminRights: JSONObject?, defaultPermissions: JSONObject?): Boolean = when (role) {
            "owner" -> true
            "admin" -> adminRights?.optBoolean("change_info", true) ?: true
            "member" -> defaultPermissions?.optBoolean("change_info", false) ?: false
            else -> false
        }
    }
}
