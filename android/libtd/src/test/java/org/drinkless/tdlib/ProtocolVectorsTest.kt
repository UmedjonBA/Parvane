package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.parvane.core.ParvaneProtocol
import java.io.File

/**
 * Общие векторы протокола v2 (spec 007, T081/T085) через C ABI движка
 * (хостовая libparvane_protocol_jni.so) — те же файлы proto/parvane/vectors,
 * что гоняют Rust, web и desktop:
 *  - наборы движка: SEAL-1, GSEAL-1, приглашения, STATE-1, все виды содержимого;
 *  - перекладка содержимого движка в содержимое UI (поле `client` векторов
 *    content/kinds.json): класс вида и поля — те же, что в web и desktop,
 *    и каждое сообщение шов превращает в нативный TdApi-объект.
 */
class ProtocolVectorsTest {
    private val vectors = File(System.getProperty("parvane.vectors.dir") ?: "../../proto/parvane/vectors")
    private val op = "0192f0e4-1a2b-7c3d-8e4f-001122334455"

    private val suites = listOf(
        "seal/sealed" to "seal/sealed.json",
        "seal/group" to "seal/group.json",
        "invite/links" to "invite/links.json",
        "state/merge" to "state/merge.json",
        "content/kinds" to "content/kinds.json",
        "l2/mode" to "l2/mode.json", // режим «усиленная приватность» (правило L2-1)
    )

    @Test
    fun engineSuitesPassThroughCAbi() {
        for ((suite, file) in suites) {
            val n = ParvaneProtocol.runConformanceVectors(suite, File(vectors, file).readText())
            assertTrue("$suite: $n случаев", n > 2)
        }
    }

    /** Ожидание — подмножество полученного: каждое поле ожидания совпадает. */
    private fun subset(expect: Any?, got: Any?): Boolean = when (expect) {
        is JSONObject -> got is JSONObject && expect.keys().asSequence().all { got.has(it) && subset(expect.get(it), got.get(it)) }
        is JSONArray -> got is JSONArray && got.length() == expect.length() &&
            (0 until expect.length()).all { subset(expect.get(it), got.get(it)) }
        is Number -> got is Number && expect.toDouble() == got.toDouble()
        else -> expect == got
    }

    @Test
    fun contentKindsMapToSameUiContentAsOtherClients() {
        val cases = JSONObject(File(vectors, "content/kinds.json").readText()).getJSONArray("cases")
        val store = ParvaneStore().apply { self = "bob@local" }
        var checked = 0
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val client = c.optJSONObject("client") ?: continue
            checked++
            val name = c.getString("name")
            val expect = c.getJSONObject("expect")
            val ev = JSONObject()
                .put("type", "direct").put("seq", 1).put("chat", "alice@local").put("from", "alice@local")
                .put("device", "d").put("opId", op).put("tsMs", 1700000000123L)
                .put("content", expect.optJSONObject("content") ?: JSONObject())
                .put("disposition", expect.optString("disposition", "show"))
            val r = ParvaneProtocol.interpretDirect(ev.toString(), "bob@local")
            val kind = r.getJSONObject("incoming").getString("kind")
            when (val want = client.getString("class")) {
                "message" -> {
                    assertEquals(name, "message", kind)
                    val content = r.getJSONObject("event").getJSONObject("content")
                    assertTrue("$name: содержимое UI $content", subset(client.getJSONObject("v1"), content))
                    // опрос и его мутации шов ведёт отдельным хранилищем — не через contentFrom
                    if (!content.getString("kind").startsWith("poll")) {
                        assertTrue("$name: нативный объект", store.contentFrom(content) !is TdApi.MessageUnsupported)
                    }
                }
                "stub" -> {
                    assertEquals(name, "stub", kind)
                    val content = r.getJSONObject("event").getJSONObject("content")
                    assertEquals(name, "unsupported", content.getString("kind"))
                    assertTrue(name, store.contentFrom(content) is TdApi.MessageUnsupported)
                }
                "mutation" -> {
                    assertTrue("$name: $kind", kind in setOf("edit", "delete", "reaction", "pin", "read", "none"))
                    assertTrue(name, r.isNull("event"))
                }
                "service" -> {
                    assertEquals(name, "none", kind)
                    assertTrue(name, r.isNull("event"))
                }
                else -> fail("$name: неизвестный класс $want")
            }
        }
        assertTrue("случаев с ожиданием клиента: $checked", checked > 30)
    }
}
