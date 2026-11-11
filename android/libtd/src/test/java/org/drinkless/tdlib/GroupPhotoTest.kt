package org.drinkless.tdlib

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** spec 035 T138 (PV-005): фото частной группы, чей секрет пришёл позже записи SetInfo, скачивается ещё раз. */
class GroupPhotoTest {
    @Test
    fun secretArrivingLaterRedownloadsSameFile() {
        assertTrue("новое фото", GroupPhoto.needsDownload("f1", "", "", ""))
        // прежнее правило (avatar != previousAvatar) здесь не скачивало: файл тот же, пришёл только секрет
        assertTrue("тот же файл, секрет пришёл позже", GroupPhoto.needsDownload("f1", "k1", "f1", ""))
        assertFalse("ничего не сменилось", GroupPhoto.needsDownload("f1", "k1", "f1", "k1"))
        assertTrue("сменился файл", GroupPhoto.needsDownload("f2", "k1", "f1", "k1"))
        assertFalse("фото снято — не скачивать", GroupPhoto.needsDownload("", "", "f1", "k1"))
    }
}
