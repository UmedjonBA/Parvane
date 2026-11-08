package org.drinkless.tdlib

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * S7-1 (ревью безопасности сервера 7 ноя 2026): вошедший паролем «как» новое устройство (тот же device_id)
 * не должен перехватить его запрос ключа восстановления через Telegram. Ядро (`parvane-core`
 * `Session::pollTelegramKey`) не заменяет показанный код кодом из опроса и отмечает `intercepted`; шов
 * Android показывает «запрос перехвачен» и перестаёт ждать ответа. JNI в JVM не поднять — сверяем исходник.
 */
class RecoveryInterceptTest {
    private fun jni(): String = (listOf(File("../jni/jni_account.cpp"), File("jni/jni_account.cpp")).firstOrNull { it.exists() }
        ?: throw AssertionError("нет jni_account.cpp")).readText()

    @Test
    fun interceptedRequestStopsWaitingAndIsShown() {
        val loop = jni().substringAfter("void pollTelegramLoop(").substringBefore("JNIEXPORT")
        val intercepted = loop.indexOf("reply.value(\"intercepted\", false)")
        assertTrue("опрос проверяет перехват до ключа из ответа", intercepted in 0 until loop.indexOf("reply.value(\"recovery_key\""))
        assertTrue("перехват — своё состояние и конец ожидания", loop.contains("setTelegramState(\"intercepted\"); return;"))
        assertTrue("повторный запрос с отказом FORBIDDEN — тоже перехват", loop.contains("again == \"intercepted\""))
        val start = jni().substringAfter("Java_org_parvane_core_ParvaneCore_nativeTelegramRecovery").substringBefore("JNIEXPORT")
        assertTrue("первый запрос с отказом — «перехвачен», а не «не удалось»", start.contains("requested == \"intercepted\" ? \"intercepted\""))
    }

    @Test
    fun interceptedTextInBothLanguages() {
        val ru = SeamText.of("recovery_intercepted", ru = true)
        assertNotNull("русский текст", ru)
        val en = SeamText.of("recovery_intercepted", ru = false)!!
        assertTrue(ru!!.contains("перехвачен") && ru.contains("пароль"))
        assertTrue(en.contains("intercepted") && en.contains("password"))
    }

    @Test
    fun coreDoesNotAdoptPolledCode() {
        val core = listOf(File("../../desktop/parvane-core/src/v2_session_account.cpp"), File("../desktop/parvane-core/src/v2_session_account.cpp"))
            .firstOrNull { it.exists() } ?: throw AssertionError("нет v2_session_account.cpp")
        val poll = core.readText().substringAfter("json Session::pollTelegramKey(bool done)").substringBefore("KeyJoinOutcome Session::")
        assertTrue("перехват — по смене кода", poll.contains("telegramCodeIntercepted(tgCode_, code)"))
        assertTrue("код из опроса — только когда своего нет", poll.contains("if (!code.empty() && tgCode_.empty()) tgCode_ = code;"))
    }
}
