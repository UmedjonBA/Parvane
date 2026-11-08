package org.drinkless.tdlib

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** spec 035, T007: выгрузка «ничего не потеряно» — запись файла профиля (строки собирает ядро, его тест — ctest audit_dump). */
class AuditDumpTest {
    @Test
    fun writesCoreLinesIntoProfile() {
        val dir = Files.createTempDirectory("pv-audit").toFile()
        val lines = "{\"kind\":\"chat\",\"key\":\"u:bob@local\",\"digest\":\"00\"}\n" +
            "{\"kind\":\"message\",\"key\":\"u:bob@local/1\",\"digest\":\"11\"}\n"
        assertEquals(2, AuditDump.write(dir) { lines })
        assertEquals(lines, File(dir, AuditDump.FILE_NAME).readText())
        assertFalse(File(dir, AuditDump.FILE_NAME + ".tmp").exists())
    }

    @Test
    fun releaseBuildWritesNothing() {
        val dir = Files.createTempDirectory("pv-audit").toFile()
        assertEquals(-1, AuditDump.write(dir) { "" })
        assertTrue(dir.listFiles().isNullOrEmpty())
    }
}
