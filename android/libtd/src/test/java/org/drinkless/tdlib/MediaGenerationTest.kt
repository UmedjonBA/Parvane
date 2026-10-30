package org.drinkless.tdlib

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicReference

class MediaGenerationTest {
    private fun tmp(name: String) = File(System.getProperty("java.io.tmpdir"), "pv-gen-${System.nanoTime()}-$name").path

    @Test fun readyWhenXWritesFileAndFinishes() {
        val gen = MediaGeneration(5_000)
        val dest = tmp("a.jpg")
        val seen = AtomicReference<TdApi.UpdateFileGenerationStart>()
        val r = gen.generate("/o.jpg", "photo0,,0.1:0.1:0.5:0.5", dest, { u ->
            seen.set(u)
            Thread { File(u.destinationPath).writeBytes(byteArrayOf(1, 2, 3)); gen.finish(u.generationId, null) }.start()
        }, { })
        assertTrue(r is MediaGeneration.Result.Ready)
        assertEquals(dest, (r as MediaGeneration.Result.Ready).path)
        assertEquals("/o.jpg", seen.get().originalPath)
        assertEquals("photo0,,0.1:0.1:0.5:0.5", seen.get().conversion)
        File(dest).delete()
    }

    @Test fun errorFromXIsFailure() {
        val gen = MediaGeneration(5_000)
        val dest = tmp("b.mp4")
        val r = gen.generate("/o.mp4", "video1", dest, { u ->
            File(u.destinationPath).writeBytes(byteArrayOf(1))
            gen.finish(u.generationId, TdApi.Error())
        }, { })
        assertTrue(r is MediaGeneration.Result.Failed)
        File(dest).delete()
    }

    @Test fun emptyResultIsFailure() {
        val gen = MediaGeneration(5_000)
        val r = gen.generate("/o.jpg", "photo0,,0.1:0.1:0.5:0.5", tmp("c.jpg"), { u -> gen.finish(u.generationId, null) }, { })
        assertEquals("empty_result", (r as MediaGeneration.Result.Failed).reason)
    }

    @Test fun silenceTimesOutAndStops() {
        val gen = MediaGeneration(300)
        val stopped = AtomicReference<TdApi.UpdateFileGenerationStop>()
        val r = gen.generate("/o.jpg", "photo0,,0.1:0.1:0.5:0.5", tmp("d.jpg"), { }, { stopped.set(it) })
        assertEquals("timeout", (r as MediaGeneration.Result.Failed).reason)
        assertTrue(stopped.get() != null)
    }

    @Test fun progressExtendsDeadline() {
        val gen = MediaGeneration(400)
        val dest = tmp("e.mp4")
        val r = gen.generate("/o.mp4", "video0,start1000", dest, { u ->
            Thread {
                repeat(4) { Thread.sleep(200); gen.touch(u.generationId) }
                File(u.destinationPath).writeBytes(byteArrayOf(9)); gen.finish(u.generationId, null)
            }.start()
        }, { })
        assertTrue(r is MediaGeneration.Result.Ready)
        File(dest).delete()
    }

    @Test fun extensions() {
        assertEquals("jpg", MediaGeneration.extensionFor("photo0,,x", "/a.png"))
        assertEquals("mp4", MediaGeneration.extensionFor("video1", "/a.mov"))
    }
}
