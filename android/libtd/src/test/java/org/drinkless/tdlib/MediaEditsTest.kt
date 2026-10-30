package org.drinkless.tdlib

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaEditsTest {
    @Test fun plainPhotoIsNotEdited() {
        assertFalse(MediaEdits.needsGeneration("photo0"))
        assertFalse(MediaEdits.needsGeneration("photo90,,,1700000000"))
        assertFalse(MediaEdits.needsGeneration("photo0,f1,,1700000000"))
        assertFalse(MediaEdits.needsGeneration(null))
    }

    @Test fun croppedOrPaintedPhotoIsEdited() {
        assertTrue(MediaEdits.needsGeneration("photo0,,0.1:0.1:0.5:0.5,1700000000"))
        assertTrue(MediaEdits.needsGeneration("photo0,,,p:abcd,1700000000"))
    }

    @Test fun videoEdits() {
        assertFalse(MediaEdits.needsGeneration("video0,limit1280x720,modified1"))
        assertTrue(MediaEdits.needsGeneration("video1"))
        assertTrue(MediaEdits.needsGeneration("video0,start1000,end5000"))
        assertTrue(MediaEdits.needsGeneration("video0,crop1:2:3"))
    }
}
