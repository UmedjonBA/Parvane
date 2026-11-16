package org.drinkless.tdlib

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Музыка из X уходит файлом с аудио-MIME (раньше шов отвечал 400 на `InputMessageAudio`). */
class AudioContentTest {
    @Test fun mp3IsFileWithAudioMime() {
        val c = MediaFlags.audioContent("song.mp3", null, 215, "подпись")
        assertEquals("file", c.getString("kind"))
        assertEquals("audio/mpeg", c.getString("mime"))
        assertEquals("song.mp3", c.getString("filename"))
        assertEquals(215, c.getInt("duration_secs"))
        assertEquals("подпись", c.getString("caption"))
    }

    @Test fun systemMimeWinsOnlyWhenAudio() {
        assertEquals("audio/x-flac", MediaFlags.audioContent("a.flac", "audio/x-flac", 1, "").getString("mime"))
        assertEquals("audio/ogg", MediaFlags.audioContent("a.opus", "application/octet-stream", 1, "").getString("mime"))
        assertEquals("audio/mpeg", MediaFlags.audioContent("noext", null, 1, "").getString("mime"))
    }

    @Test fun unknownDurationIsOmitted() {
        assertFalse(MediaFlags.audioContent("a.mp3", null, 0, "").has("duration_secs"))
    }
}
