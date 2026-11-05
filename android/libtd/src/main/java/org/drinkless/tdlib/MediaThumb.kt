package org.drinkless.tdlib

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * Миниатюра фото/видео в содержимом (`Media.thumbnail`, как web `mediaThumb.ts`, perf A10): JPEG не больше 320 px по
 * длинной стороне и не больше 16 КиБ, base64 — внутри шифрования. Получатель рисует превью сразу; у видео без неё web
 * вырезал кадр сам и в мобильном браузере часто оставался без превью. Не вышло — без миниатюры, как раньше.
 */
internal object MediaThumb {
    private const val MAX_SIDE = 320
    private const val MAX_BYTES = 16 * 1024
    private val QUALITIES = intArrayOf(80, 60, 45, 30)

    fun of(path: String, video: Boolean): String? = try {
        val frame = if (video) videoFrame(path) else photo(path)
        frame?.let { encode(it).also { _ -> it.recycle() } }
    } catch (e: Throwable) {
        null
    }

    private fun photo(path: String): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
        return BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun videoFrame(path: String): Bitmap? {
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(path)
            r.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } finally {
            try { r.release() } catch (_: Throwable) {}
        }
    }

    private fun encode(src: Bitmap): String? {
        val scale = minOf(1f, MAX_SIDE.toFloat() / maxOf(src.width, src.height))
        val bmp = if (scale < 1f) Bitmap.createScaledBitmap(src, maxOf(1, (src.width * scale).toInt()), maxOf(1, (src.height * scale).toInt()), true) else src
        try {
            for (q in QUALITIES) {
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, q, out)
                if (out.size() <= MAX_BYTES) return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            }
            return null
        } finally {
            if (bmp !== src) bmp.recycle()
        }
    }
}
