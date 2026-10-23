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
    private const val LONG_HIDE_MS = 5000L
    private var current: PopupWindow? = null

    fun show(owner: ViewController<*>, text: String, action: String? = null, onAction: (() -> Unit)? = null) {
        val anchor = owner.getValue() ?: return
        showAt(anchor, owner.context(), text, action, onAction, 2, HIDE_MS)
    }

    /** Без экрана-владельца (служебные сообщения шва: вход, привязка, ключ): над нижней панелью окна активности. */
    fun showInWindow(activity: android.app.Activity, text: String): Boolean {
        val anchor = activity.window?.decorView ?: return false
        if (anchor.windowToken == null) return false
        showAt(anchor, activity, text, null, null, 4, LONG_HIDE_MS)
        return true
    }

    private fun showAt(anchor: View, ctx: android.content.Context, text: String, action: String?, onAction: (() -> Unit)?,
                       maxLines: Int, hideMs: Long) {
        if (anchor.windowToken == null) return
        current?.dismiss()
        val c = Pv.c
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(1f), Pv.rem(0.625f), Pv.rem(0.5f), Pv.rem(0.625f))
            background = Pv.shape(Pv.mix(0xff000000.toInt(), c.raised, 55), 0.75f)
            elevation = Pv.px(6f).toFloat()
            addView(ctx.pvText(text, 0.875f, 0xffffffff.toInt(), maxLines = maxLines), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
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
        box.postDelayed({ if (current === popup) { popup.dismiss(); current = null } }, hideMs)
    }
}
