package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** spec 005 / история 2: агрегат опроса, оба формата провода (web/desktop), викторина, отзыв, буфер голосов, TdApi.Poll. */
class PollStoreTest {
    private val idOf: (String) -> Long = { it.hashCode().toLong() and 0xFFFFFF }

    @Test
    fun readsWebAndDesktopFormats() {
        val s = PollStore()
        val web = JSONObject("""{"kind":"poll","question":"Q","options":["a","b"],"is_public":true,"is_multiple":true,"is_quiz":false}""")
        val desk = JSONObject("""{"kind":"poll","question":"Q2","answers":["x","y","z"],"public":false,"multiple":false,"quiz":true,"correct":[2],"solution":"because"}""")
        val e1 = s.register("u1", "alice@local", web)!!
        val e2 = s.register("u2", "bob@local", desk)!!
        assertTrue(e1.isPublic && e1.isMultiple && !e1.isQuiz); assertEquals(listOf("a", "b"), e1.options)
        assertTrue(!e2.isPublic && !e2.isMultiple && e2.isQuiz); assertEquals(listOf(2), e2.correct); assertEquals("because", e2.solution)
        assertNull(s.register("u3", "x", JSONObject("""{"kind":"poll","question":"empty"}""")))
        // buildContent несёт оба набора имён
        val c = PollStore.buildContent("Q", listOf("a", "b"), true, false, true, listOf(1), "sol")
        for (k in listOf("options", "answers", "is_public", "public", "is_quiz", "quiz", "is_multiple", "multiple", "correct", "solution")) assertTrue(k, c.has(k))
        assertNotNull(s.register("u4", "me", c))
    }

    @Test
    fun votesAggregateAndRetract() {
        val s = PollStore()
        s.register("p", "alice@local", PollStore.buildContent("Q", listOf("a", "b"), true, true, false, emptyList(), ""))
        assertTrue(s.applyVote("p", "bob@local", listOf(0, 1)))
        assertTrue(s.applyVote("p", "carol@local", listOf(1)))
        assertTrue(s.applyVote("p", "dave@local", listOf(5))) // вне диапазона → отзыв (пусто)
        val poll = s.toTdPoll("p", "carol@local", idOf)!!
        assertEquals(2, poll.totalVoterCount)
        assertEquals(1, poll.options[0].voterCount); assertEquals(2, poll.options[1].voterCount)
        assertEquals(50, poll.options[0].votePercentage); assertEquals(100, poll.options[1].votePercentage)
        assertTrue(poll.options[1].isChosen && !poll.options[0].isChosen)
        assertTrue(poll.allowsMultipleAnswers); assertFalse(poll.isAnonymous); assertTrue(poll.type is TdApi.PollTypeRegular)
        assertEquals(2, poll.recentVoterIds.size)
        assertEquals(listOf("bob@local", "carol@local"), s.voters("p", 1))
        assertTrue(s.applyVote("p", "bob@local", emptyList())) // отзыв
        assertEquals(1, s.toTdPoll("p", "x", idOf)!!.totalVoterCount)
        assertFalse(s.close("p", "mallory@local")) // чужое закрытие не принимается
        assertFalse(s.toTdPoll("p", "x", idOf)!!.isClosed)
        assertTrue(s.close("p", "alice@local")); assertFalse(s.close("p", "alice@local"))
        assertFalse(s.applyVote("p", "eve@local", listOf(0)))
        assertTrue(s.toTdPoll("p", "x", idOf)!!.isClosed)
    }

    @Test
    fun quizVoteIsFinalAndRevealsAfterVote() {
        val s = PollStore()
        s.register("q", "alice@local", PollStore.buildContent("Q", listOf("a", "b"), false, false, true, listOf(1), "sol"))
        val before = s.toTdPoll("q", "bob@local", idOf)!!.type as TdApi.PollTypeQuiz
        assertEquals(0, before.correctOptionIds.size); assertEquals("", before.explanation.text)
        assertTrue(s.applyVote("q", "bob@local", listOf(0, 1)))
        assertFalse(s.applyVote("q", "bob@local", listOf(1))) // финален
        val after = s.toTdPoll("q", "bob@local", idOf)!!
        assertEquals(1, after.options[0].voterCount); assertEquals(0, after.options[1].voterCount) // не multiple → первый
        assertEquals(1, (after.type as TdApi.PollTypeQuiz).correctOptionIds[0]); assertEquals("sol", (after.type as TdApi.PollTypeQuiz).explanation.text)
        assertTrue(after.isAnonymous); assertEquals(0, after.recentVoterIds.size); assertTrue(s.voters("q", 0).isEmpty())
    }

    @Test
    fun votesBeforePollAreBuffered() {
        val s = PollStore()
        assertFalse(s.applyVote("late", "bob@local", listOf(0)))
        assertFalse(s.close("late", "mallory@local"))
        assertFalse(s.close("late", "alice@local"))
        val e = s.register("late", "alice@local", PollStore.buildContent("Q", listOf("a"), true, false, false, emptyList(), ""))!!
        assertEquals(1, e.votes.size); assertTrue(e.closed)
        // отложенное закрытие от чужого не закрывает опрос, когда он приходит
        val s2 = PollStore()
        assertFalse(s2.close("x", "mallory@local"))
        val e2 = s2.register("x", "alice@local", PollStore.buildContent("Q", listOf("a"), true, false, false, emptyList(), ""))!!
        assertFalse(e2.closed)
        assertTrue(PollStore.isService("poll_vote") && PollStore.isService("poll_close") && !PollStore.isService("poll"))
        assertEquals("poll_vote", PollStore.voteContent("late", listOf(0)).getString("kind"))
        assertEquals("late", PollStore.closeContent("late").getString("poll"))
    }

    // ── POLL-1: анонимный опрос группы ──────────────────────────────────────

    private fun anon(self: String): PollStore {
        val s = PollStore()
        s.isMember = { chat, address -> chat == "group:g1" && address in setOf("alice@local", "bob@local", "carol@local") }
        s.register("p", "alice@local", PollStore.buildContent("Q", listOf("a", "b", "c"), false, false, false, emptyList(), ""), "group:g1", true, self)
        return s
    }

    @Test
    fun anonymousGroupPollIsRecognised() {
        assertTrue(anon("bob@local").get("p")!!.isAnonymousGroup)
        val pub = PollStore(); pub.register("q", "alice@local", PollStore.buildContent("Q", listOf("a", "b"), true, false, false, emptyList(), ""), "group:g1", true)
        assertFalse(pub.get("q")!!.isAnonymousGroup)
        val dm = PollStore(); dm.register("r", "alice@local", PollStore.buildContent("Q", listOf("a", "b"), false, false, false, emptyList(), ""), "bob@local", false)
        assertFalse(dm.get("r")!!.isAnonymousGroup)
    }

    @Test
    fun participantCountsOnlyAuthorTally() {
        val s = anon("bob@local")
        // чужой голос из группы не считается, свой — считается и в группу не публикуется
        assertFalse(s.route("p", "bob@local", "carol@local", "group:g1", true).count)
        val own = s.route("p", "bob@local", "bob@local", "group:g1", true)
        assertTrue(own.count && !own.publish)
        s.applyVote("p", "bob@local", listOf(1))
        // свой голос автору в личку (журнал) считается; не автору — нет
        assertTrue(s.route("p", "bob@local", "bob@local", "alice@local", false).count)
        assertFalse(s.route("p", "bob@local", "bob@local", "dave@local", false).count)
        // итоги — только от автора и только из группы опроса
        assertFalse(s.applyTally("p", "carol@local", "group:g1", listOf(9, 9, 9), 27))
        assertFalse(s.applyTally("p", "alice@local", "other-group", listOf(9, 9, 9), 27))
        assertTrue(s.applyTally("p", "alice@local", "group:g1", listOf(2, 3, -1, 7), 5))
        val poll = s.toTdPoll("p", "bob@local", idOf)!!
        assertEquals(5, poll.totalVoterCount)
        assertEquals(2, poll.options[0].voterCount); assertEquals(3, poll.options[1].voterCount); assertEquals(0, poll.options[2].voterCount)
        assertTrue(poll.options[1].isChosen)
        assertTrue(poll.isAnonymous)
        assertEquals(0, poll.recentVoterIds.size)
    }

    @Test
    fun authorCountsPrivateVotesAndPublishesAddressFreeTally() {
        val s = anon("alice@local")
        // голос участника в личку автору: засчитан и вызывает публикацию; не участник — нет; чужое личное — нет
        val vote = s.route("p", "alice@local", "bob@local", "alice@local", false)
        assertTrue(vote.count && vote.publish)
        assertFalse(s.route("p", "alice@local", "mallory@local", "alice@local", false).count)
        assertFalse(s.route("p", "alice@local", "bob@local", "erin@local", false).count)
        s.applyVote("p", "bob@local", listOf(0)); s.applyVote("p", "carol@local", listOf(0)); s.applyVote("p", "alice@local", listOf(2))
        val tally = s.tallyToPublish("p", "alice@local")!!
        assertTrue(PollStore.isTally(tally))
        assertEquals("[2,0,1]", tally.getJSONArray("counts").toString()); assertEquals(3, tally.getInt("voters"))
        assertFalse(tally.toString().contains("@"))
        assertNull(s.tallyToPublish("p", "alice@local")) // то же самое повторно не публикуем
        s.applyVote("p", "bob@local", emptyList()) // отзыв
        assertEquals(2, s.tallyToPublish("p", "alice@local")!!.getInt("voters"))
        assertNull(s.tallyToPublish("p", "bob@local")) // не автор итогов не публикует
    }

    @Test
    fun publicPollAndDirectChatKeepOldRoutes() {
        val pub = PollStore(); pub.register("q", "alice@local", PollStore.buildContent("Q", listOf("a", "b"), true, false, false, emptyList(), ""), "group:g1", true, "bob@local")
        assertTrue(pub.route("q", "bob@local", "carol@local", "group:g1", true).count)
        assertFalse(pub.route("q", "bob@local", "carol@local", "bob@local", false).count) // личный голос публичного опроса не принимается
        assertNull(pub.tallyToPublish("q", "alice@local"))
    }

    @Test
    fun voteBeforePollIsRoutedOnRegister() {
        val s = PollStore()
        s.isMember = { _, a -> a == "bob@local" }
        s.applyVote("p", "bob@local", listOf(1), "alice@local", false)    // личный голос пришёл раньше опроса
        s.applyVote("p", "carol@local", listOf(0), "group:g1", true)      // и групповой
        s.register("p", "alice@local", PollStore.buildContent("Q", listOf("a", "b"), false, false, false, emptyList(), ""), "group:g1", true, "alice@local")
        val e = s.get("p")!!
        assertEquals(setOf("bob@local", "carol@local"), e.votes.keys) // автор принимает оба (carol — голос в группе, как у старых клиентов)
    }
}
