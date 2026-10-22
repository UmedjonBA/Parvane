package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.parvane.core.ParvaneProtocol
import java.io.File

/**
 * PACK-2 (spec 031): отпечаток содержимого набора — общий вектор с web и desktop
 * (`proto/parvane/vectors/clients/pack-hash.json`), считает ядро (pack_archive.cpp) через хостовую
 * libparvane_protocol_jni.so — тот же код, которым nativePackFetch сверяет скачанный архив и ищет
 * установленный набор под другим именем.
 */
class PackHashVectorsTest {
    private val vectors = File(System.getProperty("parvane.vectors.dir") ?: "../../proto/parvane/vectors")

    @Test
    fun contentHashMatchesSharedVectors() {
        assumeTrue("нет хостовой JNI", !System.getProperty("parvane.protocol.jni").isNullOrEmpty())
        val cases = JSONObject(File(vectors, "clients/pack-hash.json").readText()).getJSONArray("cases")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val r = ParvaneProtocol.packHash(c.getJSONArray("files").toString())
            assertEquals(c.getString("name"), c.getString("content_hash"), r.getString("hash"))
            assertTrue(c.getString("name"), r.getBoolean("matches"))
        }
    }

    @Test
    fun changedFileChangesHash() {
        assumeTrue("нет хостовой JNI", !System.getProperty("parvane.protocol.jni").isNullOrEmpty())
        val a = JSONArray().put(JSONObject().put("name", "a.webp").put("data", "AQID"))
        val b = JSONArray().put(JSONObject().put("name", "a.webp").put("data", "AQIE"))
        assertNotEquals(ParvaneProtocol.packHash(a.toString()).getString("hash"), ParvaneProtocol.packHash(b.toString()).getString("hash"))
    }
}
