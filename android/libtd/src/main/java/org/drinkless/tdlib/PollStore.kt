package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject

/**
 * spec 005 / история 2: опросы — тот же клиентский контракт, что web (`polls.ts`)
 * и desktop (`PollState`): сообщение `kind=poll` (uuid = id опроса), голоса —
 * отдельные сообщения `poll_vote {poll, options[]}` (пусто — отзыв), закрытие —
 * `poll_close {poll}`; сервер ничего не считает — агрегат у каждого клиента свой,
 * после перезапуска восстанавливается реплеем журнала. Web и desktop пишут РАЗНЫЕ
 * имена полей (`options/is_public/is_multiple/is_quiz` и `answers/public/multiple/quiz`)
 * — читаем оба, пишем оба ([buildContent]). Чистый JVM-класс.
 */
class PollStore {
    class Entry(val uuid: String, val question: String, val options: List<String>, val isPublic: Boolean,
                val isMultiple: Boolean, val isQuiz: Boolean, val correct: List<Int>, val solution: String, val owner: String) {
        var closed = false
        val votes = LinkedHashMap<String, List<Int>>() // voter address → индексы
    }

    private val byUuid = HashMap<String, Entry>()
    private val pendingVotes = HashMap<String, ArrayList<Pair<String, List<Int>>>>() // голоса до прихода опроса
    private val pendingClose = HashSet<String>()

    fun get(uuid: String): Entry? = byUuid[uuid]

    /** Разобрать `kind=poll` в любом из двух форматов; null — не опрос/битый. */
    fun register(uuid: String, from: String, c: JSONObject): Entry? {
        if (c.optString("kind") != "poll") return null
        val opts = (c.optJSONArray("options") ?: c.optJSONArray("answers")) ?: return null
        val options = (0 until opts.length()).map { opts.optString(it) }.filter { it.isNotEmpty() }
        if (options.isEmpty()) return null
        fun flag(web: String, desk: String) = c.optBoolean(web, false) || c.optBoolean(desk, false)
        val correct = c.optJSONArray("correct")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList()
        val e = byUuid.getOrPut(uuid) {
            Entry(uuid, c.optString("question"), options, flag("is_public", "public"), flag("is_multiple", "multiple"), flag("is_quiz", "quiz"),
                correct, if (c.isNull("solution")) "" else c.optString("solution"), from)
        }
        pendingVotes.remove(uuid)?.forEach { (voter, idx) -> applyVote(uuid, voter, idx) }
        if (pendingClose.remove(uuid)) e.closed = true
        return e
    }

    /** `poll_vote`: true — агрегат изменился (или отложен до прихода опроса). */
    fun applyVote(uuid: String, voter: String, indices: List<Int>): Boolean {
        val e = byUuid[uuid] ?: run { pendingVotes.getOrPut(uuid) { ArrayList() }.add(voter to indices); return false }
        if (e.closed) return false
        if (e.isQuiz && e.votes.containsKey(voter)) return false // в викторине голос финален
        val clean = indices.filter { it in e.options.indices }.distinct()
        if (clean.isEmpty()) e.votes.remove(voter) else e.votes[voter] = if (e.isMultiple) clean else clean.take(1)
        return true
    }

    fun close(uuid: String): Boolean {
        val e = byUuid[uuid] ?: run { pendingClose.add(uuid); return false }
        if (e.closed) return false
        e.closed = true; return true
    }

    /** Голосовавшие за вариант (только публичные опросы). */
    fun voters(uuid: String, option: Int): List<String> {
        val e = byUuid[uuid] ?: return emptyList()
        if (!e.isPublic) return emptyList()
        return e.votes.filter { option in it.value }.keys.toList()
    }

    /** TdApi.Poll для сообщения; [idOf] — адрес → id пользователя X. */
    fun toTdPoll(uuid: String, self: String, idOf: (String) -> Long): TdApi.Poll? {
        val e = byUuid[uuid] ?: return null
        val total = e.votes.size
        val mine = e.votes[self] ?: emptyList()
        val reveal = e.closed || mine.isNotEmpty()
        val options = e.options.mapIndexed { i, text ->
            val count = e.votes.count { i in it.value }
            val recent = if (e.isPublic) e.votes.filter { i in it.value }.keys.take(3).map { TdApi.MessageSenderUser(idOf(it)) as TdApi.MessageSender }.toTypedArray() else arrayOf()
            TdApi.PollOption(i.toString(), TdApi.FormattedText(text, arrayOf()), null, count,
                if (total == 0) 0 else (count * 100 / total), recent, i in mine, false, null, 0)
        }.toTypedArray()
        val type: TdApi.PollType = if (e.isQuiz)
            TdApi.PollTypeQuiz(if (reveal) e.correct.toIntArray() else IntArray(0), TdApi.FormattedText(if (reveal) e.solution else "", arrayOf()), null)
        else TdApi.PollTypeRegular()
        val recentAll = if (e.isPublic) e.votes.keys.take(3).map { TdApi.MessageSenderUser(idOf(it)) as TdApi.MessageSender }.toTypedArray() else arrayOf()
        return TdApi.Poll(EmojiDocId.fnv1a64Signed(uuid), TdApi.FormattedText(e.question, arrayOf()), options, total, recentAll,
            e.isPublic && total > 0, true, !e.isPublic, e.isMultiple, !e.isQuiz, false, arrayOf(), IntArray(0), type, 0, 0, e.closed, null)
    }

    companion object {
        /** Контент `kind=poll` с ОБОИМИ наборами имён (web + desktop). */
        fun buildContent(question: String, options: List<String>, isPublic: Boolean, isMultiple: Boolean, isQuiz: Boolean,
                         correct: List<Int>, solution: String): JSONObject {
            val opts = JSONArray(options)
            val o = JSONObject().put("kind", "poll").put("question", question)
                .put("options", opts).put("is_public", isPublic).put("is_multiple", isMultiple).put("is_quiz", isQuiz)
                .put("answers", JSONArray(options)).put("public", isPublic).put("multiple", isMultiple).put("quiz", isQuiz)
            if (isQuiz) { o.put("correct", JSONArray(correct)); if (solution.isNotEmpty()) o.put("solution", solution) }
            return o
        }
        fun voteContent(uuid: String, indices: List<Int>): JSONObject = JSONObject().put("kind", "poll_vote").put("poll", uuid).put("options", JSONArray(indices))
        fun closeContent(uuid: String): JSONObject = JSONObject().put("kind", "poll_close").put("poll", uuid)
        fun isService(kind: String) = kind == "poll_vote" || kind == "poll_close"
    }
}
