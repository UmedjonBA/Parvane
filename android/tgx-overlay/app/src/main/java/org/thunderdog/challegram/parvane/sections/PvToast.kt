package org.thunderdog.challegram.parvane.sections

import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.PopupWindow
import org.thunderdog.challegram.navigation.ViewController

/**
 * Parvane (spec 032): полоска уведомления web (`ui/Notification` в «Плане»): над нижней панелью, тёмная, со
 * скруглением, текст и необязательное действие («Отменить»); скрывается через 3 с.
 */
object PvToast {
    private const val HIDE_MS = 3000L
    private var current: PopupWindow? = null

    fun show(owner: ViewController<*>, text: String, action: String? = null, onAction: (() -> Unit)? = null) {
        val anchor = owner.getValue() ?: return
        if (anchor.windowToken == null) return
        current?.dismiss()
        val ctx = owner.context()
        val c = Pv.c
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(1f), Pv.rem(0.625f), Pv.rem(0.5f), Pv.rem(0.625f))
            background = Pv.shape(Pv.mix(0xff000000.toInt(), c.raised, 55), 0.75f)
            elevation = Pv.px(6f).toFloat()
            addView(ctx.pvText(text, 0.875f, 0xffffffff.toInt(), maxLines = 2), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (action != null) addView(ctx.pvText(action.uppercase(), 0.875f, c.accent, semibold = true).apply {
                setPadding(Pv.rem(0.75f), Pv.rem(0.375f), Pv.rem(0.75f), Pv.rem(0.375f))
                Pv.pressable(this, 0, 0.5f) { current?.dismiss(); onAction?.invoke() }
            })
        }
        val width = anchor.width - Pv.rem(1.5f)
        val popup = PopupWindow(box, width, ViewGroup.LayoutParams.WRAP_CONTENT, false).apply {
            isTouchable = true
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(0))
        }
        current = popup
        box.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.UNSPECIFIED)
        popup.showAtLocation(anchor, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL, 0, ParvaneTabBar.height() + Pv.rem(0.75f))
        box.postDelayed({ if (current === popup) { popup.dismiss(); current = null } }, HIDE_MS)
    }
}
