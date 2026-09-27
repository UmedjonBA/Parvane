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
        assertTrue(s.close("p")); assertFalse(s.close("p"))
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
        assertFalse(s.close("late"))
        val e = s.register("late", "alice@local", PollStore.buildContent("Q", listOf("a"), true, false, false, emptyList(), ""))!!
        assertEquals(1, e.votes.size); assertTrue(e.closed)
        assertTrue(PollStore.isService("poll_vote") && PollStore.isService("poll_close") && !PollStore.isService("poll"))
        assertEquals("poll_vote", PollStore.voteContent("late", listOf(0)).getString("kind"))
        assertEquals("late", PollStore.closeContent("late").getString("poll"))
    }
}
