package org.drinkless.tdlib

import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ConnectionHeaderTest {
    // 12 ноя 2026: «связь готова» пришла во время переноса → после переноса шапка пустая, а не «Соединение…»
    @Test
    fun readyDuringMigrationStaysReadyAfterIt() {
        assertTrue(ConnectionHeader.afterMigrationStep(done = false, connectionReady = true) is TdApi.ConnectionStateUpdating)
        assertTrue(ConnectionHeader.afterMigrationStep(done = true, connectionReady = true) is TdApi.ConnectionStateReady)
        assertTrue(ConnectionHeader.afterMigrationStep(done = true, connectionReady = false) is TdApi.ConnectionStateConnecting)
    }

    @Test
    fun connectionEventsDuringMigration() {
        assertTrue(ConnectionHeader.onConnection(ready = true, migrating = true) is TdApi.ConnectionStateReady)
        assertNull(ConnectionHeader.onConnection(ready = false, migrating = true))
        assertTrue(ConnectionHeader.onConnection(ready = false, migrating = false) is TdApi.ConnectionStateConnecting)
    }

    // шов пользуется именно этими функциями (Client.kt в JVM не поднять)
    @Test
    fun clientUsesHeaderRules() {
        val f = listOf(File("src/main/java/org/drinkless/tdlib/Client.kt"), File("libtd/src/main/java/org/drinkless/tdlib/Client.kt"))
            .first { it.exists() }.readText()
        assertTrue(f.contains("ConnectionHeader.afterMigrationStep(done, connectionReady)"))
        assertTrue(f.contains("ConnectionHeader.onConnection(connectionReady, migrating)"))
        assertTrue("после переноса не должно быть безусловного «Соединение…»",
            !f.contains("if (done) TdApi.ConnectionStateConnecting() else TdApi.ConnectionStateUpdating()"))
    }
}
