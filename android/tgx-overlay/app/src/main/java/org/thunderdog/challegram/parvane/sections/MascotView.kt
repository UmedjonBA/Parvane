package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.os.SystemClock
import android.view.View
import org.thunderdog.challegram.R

/**
 * Parvane (spec 031, T071): маскот загрузки — пиксельный дух, как web `ParvaneMascot` и desktop: лист из 16 кадров
 * 24×24 (`parvane_mascot.png`, тот же файл), цикл 2 с, масштаб без сглаживания. При выключенных анимациях системы
 * стоит на первом кадре.
 */
class MascotView(context: Context, private val sizeDp: Float = 48f) : View(context) {
    private val sprite: Bitmap? = BitmapFactory.decodeResource(resources, R.drawable.parvane_mascot,
        BitmapFactory.Options().apply { inScaled = false })
    private val paint = Paint().apply { isFilterBitmap = false }
    private val src = Rect()
    private val dst = Rect()
    private val animate = android.provider.Settings.Global.getFloat(context.contentResolver,
        android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f

    init {
        contentDescription = Sx.t("Загрузка", "Loading")
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val px = Sx.dp(sizeDp)
        setMeasuredDimension(resolveSize(px, widthMeasureSpec), resolveSize(px, heightMeasureSpec))
    }

    override fun onDraw(canvas: Canvas) {
        val bmp = sprite ?: return
        val frames = bmp.width / bmp.height
        val frame = if (animate) ((SystemClock.uptimeMillis() % CYCLE_MS) * frames / CYCLE_MS).toInt() else 0
        src.set(frame * bmp.height, 0, (frame + 1) * bmp.height, bmp.height)
        val side = minOf(width, height)
        dst.set((width - side) / 2, (height - side) / 2, (width + side) / 2, (height + side) / 2)
        canvas.drawBitmap(bmp, src, dst, paint)
        if (animate && isShown) postInvalidateDelayed(CYCLE_MS / frames)
    }

    companion object {
        private const val CYCLE_MS = 2000L
    }
}
