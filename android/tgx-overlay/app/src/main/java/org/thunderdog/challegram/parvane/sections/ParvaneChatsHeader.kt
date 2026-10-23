package org.thunderdog.challegram.parvane.sections

import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import org.drinkless.tdlib.TdApi
import org.thunderdog.challegram.R
import org.thunderdog.challegram.data.TD
import org.thunderdog.challegram.ui.MainController

/**
 * Parvane (spec 032): шапка списка чатов как телефонная версия web (`LeftMainHeader` + `ChatFolderTabList`):
 * слева «Чаты», справа лупа; меню ☰ и боковой панели Telegram нет (всё — в «Профиле»). Папки — чипами под
 * шапкой: значок и название, выбранная — заливкой цвета папки 22 %, остальные — рамкой. Страницы — те же
 * страницы X (`ViewPager` главного экрана), чип лишь переключает их.
 */
object ParvaneChatsHeader {
    private const val TAG_CHIPS = "parvane-folder-chips"

    /** Заголовок шапки: «Чаты», 1,25 rem semibold, отступ слева 1 rem. */
    @JvmStatic
    fun title(owner: MainController): View = owner.context().pvText(Sx.t("Чаты", "Chats"), 1.25f, Pv.c.fg, semibold = true).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Pv.rem(1f), 0, 0, 0)
        // HeaderView X двигает шапку отступами — параметры FrameLayout (с отступами), иначе ClassCastException
        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, org.thunderdog.challegram.unsorted.Size.getHeaderPortraitSize(), Gravity.TOP)
    }

    /** Лупа справа (линейный значок web). */
    @JvmStatic
    fun searchButton(owner: MainController): View = owner.context().pvIconButton("search", Sx.t("Поиск", "Search"), Pv.c.muted) {
        owner.onMenuItemPressed(R.id.menu_btn_search, null)
    }.apply {
        layoutParams = LinearLayout.LayoutParams(Pv.rem(3f), ViewGroup.LayoutParams.MATCH_PARENT)
    }

    /** Полоса чипов над списком; показывается, только если папок больше одной. */
    @JvmStatic
    fun attach(owner: MainController, contentView: ViewGroup, below: View) {
        val ctx = owner.context()
        val scroll = HorizontalScrollView(ctx).apply {
            tag = TAG_CHIPS
            isHorizontalScrollBarEnabled = false
            setBackgroundColor(Pv.c.panel)
            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(Pv.rem(1f), Pv.rem(0.625f), Pv.rem(1f), Pv.rem(0.5f))
            })
            visibility = View.GONE
        }
        contentView.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, chipsHeight(), Gravity.TOP))
        owner.parvaneChips = scroll
        owner.parvaneChipsBelow = below
        refresh(owner)
    }

    private fun chipsHeight() = Pv.rem(0.625f + 1.875f + 0.5f)

    /** Папки изменились (`updatePagerSections`) — перестроить чипы. */
    @JvmStatic
    fun refresh(owner: MainController) {
        val scroll = owner.parvaneChips as? HorizontalScrollView ?: return
        val row = scroll.getChildAt(0) as LinearLayout
        val lists = owner.parvaneChatLists()
        val infos = owner.parvaneFolderInfos()
        row.removeAllViews()
        val show = lists.size > 1
        scroll.visibility = if (show) View.VISIBLE else View.GONE
        (owner.parvaneChipsBelow?.layoutParams as? ViewGroup.MarginLayoutParams)?.let {
            val top = if (show) chipsHeight() else 0
            if (it.topMargin != top) { it.topMargin = top; owner.parvaneChipsBelow?.layoutParams = it }
        }
        if (!show) return
        val current = owner.parvaneCurrentPage()
        var fallback = 0
        lists.forEachIndexed { index, list ->
            val info = (list as? TdApi.ChatListFolder)?.let { f -> infos?.firstOrNull { it.id == f.chatFolderId } }
            val (title, icon, color) = when {
                list is TdApi.ChatListMain -> Triple(Sx.t("Все чаты", "All chats"), R.drawable.baseline_forum_24, Pv.c.accent)
                list is TdApi.ChatListArchive -> Triple(Sx.t("Архив", "Archive"), R.drawable.baseline_archive_24, Pv.c.muted)
                else -> Triple(info?.name?.text?.text ?: "", info?.let { TD.findFolderIcon(it.icon, R.drawable.baseline_folder_24) }
                    ?: R.drawable.baseline_folder_24, folderColor(info?.colorId ?: -1, fallback++))
            }
            row.addView(chip(owner, title, icon, color, index == current) { owner.parvaneSelectPage(index) })
        }
    }

    /** Страница переключена (свайпом или чипом) — выделить чип. */
    @JvmStatic
    fun select(owner: MainController, position: Int) {
        if (owner.parvaneChips == null) return
        Sx.main.post { refresh(owner) }
    }

    // Цвета папок, как `util/folderColors.ts`: выбранный в настройках папки — семь цветов Telegram, иначе по порядку
    private fun folderColor(colorId: Int, fallbackIndex: Int): Int {
        val c = Pv.c
        val chosen = intArrayOf(c.red, c.orange, c.purple, c.green, c.aqua, c.blue, c.purple)
        val fallback = intArrayOf(c.blue, c.orange, c.purple, c.aqua, c.green, c.red)
        return if (colorId >= 0) chosen[colorId % chosen.size] else fallback[fallbackIndex % fallback.size]
    }

    private fun chip(owner: MainController, title: String, icon: Int, color: Int, active: Boolean, onClick: () -> Unit): View {
        val ctx = owner.context()
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Pv.rem(0.75f), 0, Pv.rem(0.75f), 0)
            addView(ImageView(ctx).apply {
                setImageResource(icon)
                setColorFilter(color)
                layoutParams = LinearLayout.LayoutParams(Pv.rem(1.125f), Pv.rem(1.125f)).apply { rightMargin = Pv.rem(0.375f) }
            })
            addView(ctx.pvText(title, 0.8125f, if (active) color else Pv.c.muted))
            if (active) Pv.pressable(this, Pv.alpha(color, 22), 0.9375f, onClick = onClick)
            else Pv.pressable(this, 0, 0.9375f, Pv.mix(color, Pv.c.line2, 45), onClick)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Pv.rem(1.875f)).apply { rightMargin = Pv.rem(0.375f) }
        }
    }
}
