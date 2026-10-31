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
 *
 * POLL-1 (анонимный опрос группы): голос уходит ТОЛЬКО автору опроса личным сообщением (участникам группы адрес
 * голосующего не виден), автор публикует в группу итоги — `poll_vote {tally:true, counts[], voters}` без адресов.
 * Участник (не автор) считает только итоги автора и свой выбор; итоги принимаются только от автора, из чата опроса.
 */
class PollStore {
    class Entry(val uuid: String, val question: String, val options: List<String>, val isPublic: Boolean,
                val isMultiple: Boolean, val isQuiz: Boolean, val correct: List<Int>, val solution: String, val owner: String,
                val chat: String = "", val isGroup: Boolean = false) {
        var closed = false
        val votes = LinkedHashMap<String, List<Int>>() // voter address → индексы
        /** POLL-1: итоги автора (у участника анонимного опроса группы вместо подсчёта голосов). */
        var tallyCounts: List<Int>? = null
        var tallyVoters = 0
        /** POLL-1: автор — последние опубликованные итоги (то же самое повторно не шлём). */
        var published: String? = null
        val isAnonymousGroup get() = isGroup && !isPublic && owner.isNotEmpty()
    }

    /** POLL-1: куда засчитать голос. */
    class Route(val count: Boolean, val publish: Boolean)

    /** POLL-1: действующий участник группы [chat] (знает только автор); ставит [ParvaneStore]. */
    var isMember: (chat: String, address: String) -> Boolean = { _, _ -> false }

    /** `chat` — чат, в котором пришёл голос: адрес группы либо собеседника личного чата. */
    private class PendingVote(val voter: String, val indices: List<Int>, val to: String, val chat: String)

    private val byUuid = HashMap<String, Entry>()
    private val pendingVotes = HashMap<String, ArrayList<PendingVote>>() // голоса до прихода опроса
    private val pendingClose = HashMap<String, HashSet<String>>() // uuid → отправители закрытия до прихода опроса

    fun get(uuid: String): Entry? = byUuid[uuid]

    /** Разобрать `kind=poll` в любом из двух форматов; null — не опрос/битый. */
    fun register(uuid: String, from: String, c: JSONObject, chat: String = "", isGroup: Boolean = false, self: String = ""): Entry? {
        if (c.optString("kind") != "poll") return null
        val opts = (c.optJSONArray("options") ?: c.optJSONArray("answers")) ?: return null
        val options = (0 until opts.length()).map { opts.optString(it) }.filter { it.isNotEmpty() }
        if (options.isEmpty()) return null
        fun flag(web: String, desk: String) = c.optBoolean(web, false) || c.optBoolean(desk, false)
        val correct = c.optJSONArray("correct")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList()
        val e = byUuid.getOrPut(uuid) {
            Entry(uuid, c.optString("question"), options, flag("is_public", "public"), flag("is_multiple", "multiple"), flag("is_quiz", "quiz"),
                correct, if (c.isNull("solution")) "" else c.optString("solution"), from, chat, isGroup)
        }
        pendingVotes.remove(uuid)?.forEach { p ->
            if (route(uuid, self, p.voter, p.to, p.chat == e.chat).count) applyVote(uuid, p.voter, p.indices)
        }
        if (pendingClose.remove(uuid)?.contains(e.owner) == true) e.closed = true
        return e
    }

    /** POLL-1: куда засчитать голос (чистая логика, как `parvane::poll::routeVote` desktop и web `sync.ts`). */
    fun route(uuid: String, self: String, voter: String, to: String, inPollChat: Boolean): Route {
        val e = byUuid[uuid] ?: return Route(count = false, publish = false)
        val iAmAuthor = e.owner.isNotEmpty() && e.owner == self
        if (inPollChat) {
            // Участник анонимного опроса чужие голоса из группы не считает — они в итогах автора
            if (e.isAnonymousGroup && !iAmAuthor && voter != self) return Route(count = false, publish = false)
            return Route(count = true, publish = e.isAnonymousGroup && iAmAuthor)
        }
        if (!e.isAnonymousGroup) return Route(count = false, publish = false)
        if (voter == self && to == e.owner) return Route(count = true, publish = false) // свой голос автору (журнал)
        if (iAmAuthor && to == self && isMember(e.chat, voter)) return Route(count = true, publish = true)
        return Route(count = false, publish = false)
    }

    /** POLL-1: итоги принимаются только от автора опроса и из его группы; счётчики приводятся к числу вариантов. */
    fun applyTally(uuid: String, from: String, to: String, counts: List<Long>, voters: Long): Boolean {
        val e = byUuid[uuid] ?: return false
        if (!e.isAnonymousGroup || from != e.owner || to != e.chat) return false
        fun clamp(n: Long) = if (n < 0) 0 else minOf(n, MAX_TALLY).toInt()
        e.tallyCounts = e.options.indices.map { clamp(counts.getOrElse(it) { 0L }) }
        e.tallyVoters = clamp(voters)
        return true
    }

    /** POLL-1: итоги автора из его подсчёта; null — публиковать нечего (то же уже опубликовано) или не его опрос. */
    fun tallyToPublish(uuid: String, self: String): JSONObject? {
        val e = byUuid[uuid] ?: return null
        if (!e.isAnonymousGroup || e.owner != self) return null
        val counts = IntArray(e.options.size)
        e.votes.values.forEach { v -> v.forEach { if (it in counts.indices) counts[it]++ } }
        val content = tallyContent(uuid, counts.toList(), e.votes.size)
        val signature = content.toString()
        if (e.published == signature) return null
        e.published = signature
        return content
    }

    /** POLL-1: свои опубликованные итоги из журнала — запомнить, чтобы после рестарта не публиковать то же. */
    fun markPublished(uuid: String, content: JSONObject) { byUuid[uuid]?.published = content.toString() }

    /** `poll_vote`: true — агрегат изменился (или отложен до прихода опроса). */
    fun applyVote(uuid: String, voter: String, indices: List<Int>, pendingTo: String = "", pendingChat: String = ""): Boolean {
        val e = byUuid[uuid] ?: run {
            if (pendingVotes.size < MAX_PENDING || pendingVotes.containsKey(uuid)) {
                val list = pendingVotes.getOrPut(uuid) { ArrayList() }
                if (list.size < MAX_PENDING) list.add(PendingVote(voter, indices, pendingTo, pendingChat))
            }
            return false
        }
        if (e.closed) return false
        if (e.isQuiz && e.votes.containsKey(voter)) return false // в викторине голос финален
        val clean = indices.filter { it in e.options.indices }.distinct()
        if (clean.isEmpty()) e.votes.remove(voter) else e.votes[voter] = if (e.isMultiple) clean else clean.take(1)
        return true
    }

    /** `poll_close`: закрыть может только владелец опроса ([from]); закрытие до прихода опроса ждёт, но проверяется при регистрации. */
    fun close(uuid: String, from: String): Boolean {
        val e = byUuid[uuid] ?: run {
            if (pendingClose.size < MAX_PENDING || pendingClose.containsKey(uuid)) {
                val set = pendingClose.getOrPut(uuid) { HashSet() }
                if (set.size < MAX_PENDING) set.add(from)
            }
            return false
        }
        if (from != e.owner) return false
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
        // POLL-1: участник анонимного опроса группы показывает итоги автора, а не свой подсчёт
        val tally = e.tallyCounts?.takeIf { e.isAnonymousGroup && e.owner != self }
        val total = if (tally != null) e.tallyVoters else e.votes.size
        val mine = e.votes[self] ?: emptyList()
        val reveal = e.closed || mine.isNotEmpty()
        val options = e.options.mapIndexed { i, text ->
            val count = if (tally != null) tally.getOrElse(i) { 0 } else e.votes.count { i in it.value }
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
        private const val MAX_TALLY = 10_000_000L
        private const val MAX_PENDING = 256 // отложенные голоса/закрытия неизвестных опросов не растут без предела
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
        /** POLL-1: итоги анонимного опроса от автора — счётчики по вариантам, без адресов. */
        fun tallyContent(uuid: String, counts: List<Int>, voters: Int): JSONObject = JSONObject().put("kind", "poll_vote").put("poll", uuid)
            .put("options", JSONArray()).put("tally", true).put("counts", JSONArray(counts)).put("voters", voters)
        fun isTally(c: JSONObject) = c.optString("kind") == "poll_vote" && c.optBoolean("tally", false)
        fun closeContent(uuid: String): JSONObject = JSONObject().put("kind", "poll_close").put("poll", uuid)
        fun isService(kind: String) = kind == "poll_vote" || kind == "poll_close"
    }
}
