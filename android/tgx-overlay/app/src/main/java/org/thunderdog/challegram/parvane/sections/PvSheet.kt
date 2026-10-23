package org.thunderdog.challegram.parvane.sections

import android.app.Dialog
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView

/**
 * Parvane (spec 032): шторка web (`PvSheet`, ≤ 760 px): лист снизу во всю ширину, радиус сверху 1,125 rem, ручка
 * 2,5 × 0,25 rem, шапка «название · крестик» (1,125 rem semibold), содержимое с отступами 0,5/1,25/1,25 rem и
 * промежутком 0,875 rem, не выше 90 % экрана; фон под листом — чёрный 45 %.
 */
class PvSheet private constructor(val context: Context, title: String?, headBefore: View?, headAfter: View?) {
    private val dialog = Dialog(context, android.R.style.Theme_Translucent_NoTitleBar)
    val content: LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(Pv.rem(1.25f), Pv.rem(0.5f), Pv.rem(1.25f), Pv.rem(1.25f))
    }
    private var onClose: (() -> Unit)? = null

    init {
        val c = Pv.c
        val sheet = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                val r = Pv.rem(1.125f).toFloat()
                cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
                setColor(c.panel)
            }
            isClickable = true
        }
        sheet.addView(View(context).apply { background = Pv.shape(c.line2, 0.125f) },
            LinearLayout.LayoutParams(Pv.rem(2.5f), Pv.rem(0.25f)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = Pv.rem(0.5f) })
        val head = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(1.25f), Pv.rem(0.875f), Pv.rem(1f), Pv.rem(0.25f))
        }
        headBefore?.let { head.addView(it); (it.layoutParams as? LinearLayout.LayoutParams)?.rightMargin = Pv.rem(0.5f) }
        head.addView(context.pvText(title.orEmpty(), 1.125f, c.fg, semibold = true, maxLines = 1),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        headAfter?.let { head.addView(it) }
        head.addView(context.pvIconButton("x", Sx.t("Закрыть", "Close"), c.muted) { dismiss() })
        sheet.addView(head)
        sheet.addView(ScrollView(context).apply {
            isFillViewport = false
            addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val root = FrameLayout(context).apply {
            setBackgroundColor(0x73000000)
            setOnClickListener { dismiss() }
            val maxHeight = (context.resources.displayMetrics.heightPixels * 0.9f).toInt()
            addView(object : FrameLayout(context) {
                override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                    super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST))
                }
            }.apply { addView(sheet) }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        }
        dialog.setContentView(root)
        dialog.setOnDismissListener { onClose?.invoke() }
        dialog.window?.apply {
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            @Suppress("DEPRECATION")
            addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            navigationBarColor = c.panel
        }
    }

    /** Дочерний вид содержимого с промежутком 0,875 rem сверху (кроме первого). */
    fun add(view: View, gapRem: Float = 0.875f): PvSheet {
        content.addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            if (content.childCount > 0) topMargin = Pv.rem(gapRem)
        })
        return this
    }

    fun onClose(cb: () -> Unit): PvSheet { onClose = cb; return this }
    fun show(): PvSheet { dialog.show(); return this }
    fun dismiss() = dialog.dismiss()

    companion object {
        fun create(context: Context, title: String?, headBefore: View? = null, headAfter: View? = null) =
            PvSheet(context, title, headBefore, headAfter)

        /** Выбор одного из вариантов строками-кнопками (`.row`). */
        fun choose(context: Context, title: String, items: List<String>, onPick: (Int) -> Unit) {
            val sheet = create(context, title)
            items.forEachIndexed { i, text ->
                sheet.add(context.pvText(text, 0.9375f, Pv.c.fg).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    minHeight = Pv.rem(2.75f)
                    setPadding(Pv.rem(0.625f), Pv.rem(0.375f), Pv.rem(0.625f), Pv.rem(0.375f))
                    Pv.pressable(this, 0, 0.5f) { sheet.dismiss(); onPick(i) }
                }, 0.125f)
            }
            sheet.show()
        }

        /** Подтверждение: текст и две кнопки (вторая — акцент либо красная). */
        fun confirm(context: Context, title: String, text: String, ok: String, danger: Boolean = false, onOk: () -> Unit) {
            val sheet = create(context, title)
            sheet.add(context.pvText(text, 0.9375f, Pv.c.muted))
            sheet.add(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END
                addView(context.pvButton(Sx.t("Отмена", "Cancel"), "ghost") { sheet.dismiss() })
                addView(context.pvButton(ok, if (danger) "danger" else "acc") { sheet.dismiss(); onOk() }.apply {
                    (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f)
                })
            })
            sheet.show()
        }
    }
}
