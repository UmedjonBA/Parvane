package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * spec 035 T138 (US5, FR-041/FR-042, STUB_CRITICAL): содержимое критичного вида из более новой версии (событие ядра
 * `{"kind": "unsupported", "critical": true}`) — служебная строка «обновите приложение» (EN+RU), а не нативная
 * заглушка X «не поддерживается»; обычный незнакомый вид — по-прежнему заглушка. Строки — те же, что в ресурсах
 * оверлея (values/parvane.xml, values-ru/parvane.xml).
 */
class CriticalStubTest {
    @Test
    fun criticalUnknownKindAsksToUpdate() {
        val store = ParvaneStore().apply { self = "bob@local" }
        val critical = store.contentFrom(JSONObject().put("kind", "unsupported").put("critical", true))
        assertTrue("критичный вид — служебная строка", critical is TdApi.MessageCustomServiceAction)
        assertEquals(SeamText.of("stub_critical"), (critical as TdApi.MessageCustomServiceAction).text)
        assertTrue("обычный незнакомый вид — заглушка X", store.contentFrom(JSONObject().put("kind", "unsupported")) is TdApi.MessageUnsupported)
        assertTrue(SeamText.of("stub_critical", ru = true)!!.contains("Обновите приложение"))
        assertTrue(SeamText.of("stub_critical", ru = false)!!.contains("Update the app"))
        assertTrue(SeamText.of("upgrade_state_blocked", ru = true)!!.contains("Обновите приложение"))
        assertTrue(SeamText.of("too_new", ru = false)!!.contains("Update the app"))
    }
}
