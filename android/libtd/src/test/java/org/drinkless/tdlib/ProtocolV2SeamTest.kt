package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.parvane.core.ParvaneProtocol
import java.io.File

/**
 * Протокол v2 в шве TDLib (spec 007, T067). Движок — через C ABI (хостовая
 * libparvane_protocol_jni.so из android/build-host-jni.sh, тот же
 * protocol_jni.cpp/v2_bridge.h, что в libparvane_jni.so на телефоне):
 *  - общие векторы conformance (SEAL-1, GSEAL-1, приглашения) — те же файлы
 *    proto/parvane/vectors, что гоняют Rust, web и desktop;
 *  - событие движка "direct" → событие ядра того же вида, что v1-входящее;
 *  - незнакомый вид → TdApi.MessageUnsupported (нативная заглушка X);
 *  - групповое v2 → событие в чат группы "v2g:<hex>" (group=true), ссылка v2 — токен.
 */
class ProtocolV2SeamTest {
    private val vectors = File(System.getProperty("parvane.vectors.dir") ?: "../../proto/parvane/vectors")
    private val op = "0192f0e4-1a2b-7c3d-8e4f-001122334455"

    private fun direct(content: String, disposition: String = "show", from: String = "alice@local") = """
        {"type":"direct","seq":1,"chat":"alice@local","from":"$from","device":"d","opId":"$op",
         "tsMs":1700000000123,"content":$content,"disposition":"$disposition"}
    """.trimIndent()

    private fun store() = ParvaneStore().apply { self = "bob@local" }

    @Test
    fun engineIsProtocolV2() {
        val e = ParvaneProtocol.engine()
        assertEquals(2, e.getInt("major"))
        assertTrue(e.getString("version").isNotEmpty())
    }

    @Test
    fun conformanceVectorsPassThroughCAbi() {
        // STATE-1 (T099): детерминированное сведение журнала личного состояния
        for ((suite, file) in listOf("seal/sealed" to "seal/sealed.json", "seal/group" to "seal/group.json", "invite/links" to "invite/links.json",
                "state/merge" to "state/merge.json")) {
            val json = File(vectors, file).readText()
            val n = ParvaneProtocol.runConformanceVectors(suite, json)
            assertTrue("$suite: $n случаев", n > 2)
        }
    }

    @Test
    fun brokenVectorIsReportedNotSwallowed() {
        val bad = runCatching { ParvaneProtocol.runConformanceVectors("seal/sealed", "{\"cases\":[{\"nope\":1}]}") }
        assertTrue("битый набор — ошибка движка", bad.isFailure)
    }

    @Test
    fun v2TextBecomesSameEventAsV1Incoming() {
        val r = ParvaneProtocol.interpretDirect(direct("""{"text":{"text":"hello"}}"""), "bob@local")
        assertEquals("message", r.getJSONObject("incoming").getString("kind"))
        val ev = r.getJSONObject("event")
        assertEquals("message", ev.getString("type"))
        assertEquals(op, ev.getString("id"))
        assertEquals("alice@local", ev.getString("from"))
        assertEquals("bob@local", ev.getString("to"))
        assertEquals(1700000000L, ev.getLong("ts"))
        assertEquals(false, ev.getBoolean("out"))
        assertEquals("text", ev.getString("kind"))
        val c = store().contentFrom(ev.getJSONObject("content"))
        assertTrue(c is TdApi.MessageText)
        assertEquals("hello", (c as TdApi.MessageText).text.text)
    }

    @Test
    fun unknownKindAndStubBecomeMessageUnsupported() {
        for (ev in listOf(
            direct("""{"contact":{"first_name":"A"}}"""),       // вид, которого клиент не знает
            direct("""{"text":{"text":"x"}}""", "stub"),         // движок велел показать заглушку
            direct("{}"),                                        // пустое содержимое
        )) {
            val r = ParvaneProtocol.interpretDirect(ev, "bob@local")
            assertEquals("stub", r.getJSONObject("incoming").getString("kind"))
            val content = r.getJSONObject("event").getJSONObject("content")
            assertEquals("unsupported", content.getString("kind"))
            assertTrue(store().contentFrom(content) is TdApi.MessageUnsupported)
        }
    }

    @Test
    fun ownMessageFromOtherDeviceGoesToPeerChat() {
        val r = ParvaneProtocol.interpretDirect(direct("""{"text":{"text":"mine"}}""", from = "bob@local"), "bob@local")
        val ev = r.getJSONObject("event")
        assertEquals(true, ev.getBoolean("out"))
        assertEquals("alice@local", ev.getString("to"))
    }

    @Test
    fun mutationsAndServiceKindsAreNotMessages() {
        val ref = ParvaneProtocol.toV2("""{"kind":"text","text":"t"}""", op)!!.getJSONObject("reply_to")
        val cases = mapOf(
            """{"edit":{"target":$ref,"text":{"text":"new"}}}""" to "edit",
            """{"delete":{"targets":[$ref],"for_everyone":true}}""" to "delete",
            """{"reaction":{"target":$ref,"emoji":"👍"}}""" to "reaction",
            """{"pin":{"target":$ref}}""" to "pin",
            """{"receipt":{"kind":"RECEIPT_KIND_READ","messages":[$ref]}}""" to "read",
            """{"receipt":{"kind":"RECEIPT_KIND_DELIVERED"}}""" to "none",
            """{"delivery_key":{"generation":"1"}}""" to "none",
        )
        for ((content, kind) in cases) {
            val r = ParvaneProtocol.interpretDirect(direct(content), "bob@local")
            assertEquals(content, kind, r.getJSONObject("incoming").getString("kind"))
            assertTrue(content, r.isNull("event"))
            if (kind != "none") assertEquals(op, r.getJSONObject("incoming").getJSONArray("targets").getString(0))
        }
    }

    @Test
    fun v1ContentMapsToV2AndUnknownStaysOnV1() {
        val t = ParvaneProtocol.toV2("""{"kind":"text","text":"hi"}""")
        assertNotNull(t)
        assertEquals("hi", t!!.getJSONObject("text").getString("text"))
        val photo = ParvaneProtocol.toV2("""{"kind":"photo","file_id":"f1","mime":"image/jpeg","file_key":"k","file_nonce":"n"}""")
        assertNotNull(photo)
        assertEquals("f1", photo!!.getJSONObject("media").getString("file_id"))
        // служебные ключи групп v1 — не содержимое v2 (идут по v1)
        assertNull(ParvaneProtocol.toV2("""{"kind":"skdm","group":"g"}"""))
    }

    @Test
    fun storeMapsUnknownKindsToUnsupportedButKeepsLegacyText() {
        val s = store()
        assertTrue(s.contentFrom(JSONObject("""{"kind":"unsupported"}""")) is TdApi.MessageUnsupported)
        assertTrue(s.contentFrom(JSONObject("""{"kind":"dice","emoji":"🎲"}""")) is TdApi.MessageUnsupported)
        assertTrue(s.contentFrom(JSONObject("""{"kind":"text","text":"a"}""")) is TdApi.MessageText)
        assertTrue("старые события без kind — текст", s.contentFrom(JSONObject("""{"text":"a"}""")) is TdApi.MessageText)
    }

    @Test
    fun v2GroupEventGoesToGroupChat() {
        val ev = """
            {"type":"group","seq":3,"group":{"domain":"local","id":"00ff"},"from":"alice@local","device":"d","opId":"$op",
             "tsMs":1700000000123,"content":{"text":{"text":"всем"}},"disposition":"show"}
        """.trimIndent()
        val r = ParvaneProtocol.interpretDirect(ev, "bob@local")
        val e = r.getJSONObject("event")
        assertEquals("v2g:00ff", e.getString("to"))
        assertEquals(true, e.getBoolean("group"))
        assertEquals(false, e.getBoolean("out"))
        assertEquals("всем", e.getJSONObject("content").getString("text"))
    }

    @Test
    fun v2InviteLinkIsItsOwnToken() {
        val url = "https://local/join/" + "A".repeat(43) + "#" + "b".repeat(43)
        assertEquals(url, ParvaneStore.inviteTokenOf(url))
        assertEquals(url, ParvaneStore.buildInviteLink(url))
        // формы v1 — как раньше
        assertEquals("0123456789abcdef0123456789abcdef", ParvaneStore.inviteTokenOf("https://parvane.invite/0123456789abcdef0123456789abcdef"))
        assertNull(ParvaneStore.inviteTokenOf("https://local/join/short#x"))
    }

    @Test
    fun serviceContentIsNativeServiceMessage() {
        val c = store().contentFrom(JSONObject("""{"kind":"service","text":"T080"}"""))
        assertTrue(c is TdApi.MessageCustomServiceAction)
        assertEquals("T080", (c as TdApi.MessageCustomServiceAction).text)
    }
}
