package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.content.Context
import android.view.Gravity
import org.drinkless.tdlib.Client
import org.json.JSONObject
import org.parvane.core.ParvaneCalls
import org.parvane.core.ParvaneCore
import org.thunderdog.challegram.R
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.telegram.Tdlib
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import org.thunderdog.challegram.tool.UI

/**
 * Parvane (spec 031, T057; CALL-2): групповой звонок — сетка до 8 участников (mesh) поверх `GroupCallManager` ядра
 * и org.webrtc X. Экран: название группы, участники с состоянием («соединение», «на связи», микрофон выключен,
 * «отклонил»), свой микрофон, «Выйти». Начать — кнопка звонка в профиле группы; входящее приглашение — окно
 * «Принять / Отклонить» с названием группы поверх любого экрана.
 */
class GroupCallController(context: Context, tdlib: Tdlib) : SectionController(context, tdlib) {
    override val section = "chats"
    override val tab = ParvaneTabBar.Tab.CHATS
    override fun getId() = R.id.controller_parvaneProfile
    override fun getName(): CharSequence = title.ifEmpty { Sx.t("Групповой звонок", "Group call") }

    private var title = ""
    private var muted = false

    companion object {
        /** Состояние текущего звонка: участник → состояние; приглушённые. */
        internal val peers = linkedMapOf<String, String>()
        internal val mutedPeers = mutableSetOf<String>()
        @Volatile internal var active = false
        @Volatile internal var currentTitle = ""
        private val watchers = mutableListOf<() -> Unit>()

        fun start(owner: ViewController<*>, chatId: Long) {
            val g = Client.groupForChat(chatId) ?: return
            val self = g.optString("self")
            val members = (0 until g.optJSONArray("members")!!.length()).map { g.optJSONArray("members")!!.getString(it) }.filter { it != self }
            if (members.isEmpty()) {
                UI.showToast(Sx.t("В группе нет других участников", "No other members in the group"), android.widget.Toast.LENGTH_SHORT)
                return
            }
            if (members.size > 7) {
                UI.showToast(Sx.t("Групповой звонок — до 8 участников", "Group calls support up to 8 participants"), android.widget.Toast.LENGTH_LONG)
                return
            }
            begin(g.optString("title"), members)
            Sx.async({ ParvaneCalls.groupStart(members, false, g.optString("gid"), g.optString("title")) }) { }
            open(owner)
        }

        private fun begin(title: String, members: List<String>) {
            peers.clear()
            mutedPeers.clear()
            members.forEach { peers[it] = "connecting" }
            currentTitle = title
            active = true
            notifyWatchers()
        }

        fun open(owner: ViewController<*>) {
            owner.navigateTo(GroupCallController(owner.context(), owner.tdlib()).also { it.title = currentTitle })
        }

        private fun notifyWatchers() = Sx.main.post { watchers.toList().forEach { it() } }

        /** События ядра `group_call` (подключается один раз при старте приложения). */
        fun init() {
            ParvaneCore.addListener { e ->
                if (e.optString("type") != "group_call") return@addListener
                when (e.optString("state")) {
                    "invite" -> Sx.main.post { invite(e) }
                    "invite_closed" -> Sx.main.post { inviteDialog?.dismiss(); inviteDialog = null }
                    // peers/mutedPeers читает render() на главном потоке — меняем их там же, а не на потоке событий ядра
                    "peer" -> Sx.main.post { peers[e.optString("peer")] = e.optString("peer_state"); notifyWatchers() }
                    "media" -> Sx.main.post {
                        if (e.optBoolean("audio_muted")) mutedPeers += e.optString("peer") else mutedPeers -= e.optString("peer")
                        notifyWatchers()
                    }
                    "declined" -> Sx.main.post { peers[e.optString("peer")] = "declined:" + e.optString("reason"); notifyWatchers() }
                    "left" -> Sx.main.post { active = false; notifyWatchers() }
                }
            }
        }

        private var inviteDialog: AlertDialog? = null

        private fun invite(e: JSONObject) {
            val ctx = UI.getUiContext() ?: return
            val from = Client.displayName(e.optString("from"))
            // CALL-2: известная группа — название из своего журнала; присланное — только для незнакомой
            val title = Client.groupTitle(e.optString("group")) ?: e.optString("title").ifEmpty { Sx.t("группа", "group") }
            val participants = e.optJSONArray("participants")
            inviteDialog?.dismiss()
            inviteDialog = AlertDialog.Builder(ctx, Theme.dialogTheme())
                .setTitle(Sx.t("Групповой звонок", "Group call"))
                .setMessage(Sx.t("$from зовёт в звонок «$title»", "$from invites you to a call in “$title”"))
                .setPositiveButton(Sx.t("Принять", "Accept")) { _, _ ->
                    val list = (0 until (participants?.length() ?: 0)).map { participants!!.getString(it) }.filter { it != Client.selfAddress() }
                    begin(title, list.ifEmpty { listOf(e.optString("from")) })
                    ParvaneCalls.groupAccept()
                    ctx.navigation()?.currentStackItem?.let { open(it) }
                }
                .setNegativeButton(Sx.t("Отклонить", "Decline")) { _, _ -> ParvaneCalls.groupDecline() }
                .setCancelable(false).show()
        }
    }

    private val watcher: () -> Unit = { if (isFocused) render() }

    override fun onBuilt() {
        watchers += watcher
        render()
    }

    override fun destroy() {
        watchers -= watcher
        super.destroy()
    }

    private fun stateText(state: String): String = when {
        state == "active" -> Sx.t("на связи", "connected")
        state == "connecting" || state == "outgoing" || state == "incoming" -> Sx.t("соединение…", "connecting…")
        state == "ended" -> Sx.t("вышел(а)", "left")
        state.startsWith("declined:busy") -> Sx.t("занят(а)", "busy")
        state.startsWith("declined") -> Sx.t("отклонил(а)", "declined")
        else -> state
    }

    override fun repaint() = render()

    private fun render(): Unit = rebuild {
        addView(context.label(title.ifEmpty { currentTitle }, 22f, bold = true).apply {
            gravity = Gravity.CENTER
            layoutParams = lp(t = Sx.dp(20f), l = Sx.dp(16f), r = Sx.dp(16f))
        })
        addView(context.label(if (active) Sx.t("Групповой звонок", "Group call") else Sx.t("Звонок завершён", "Call ended"), 14f, ColorId.textLight).apply {
            gravity = Gravity.CENTER
            layoutParams = lp(t = Sx.dp(4f))
        })
        peers.forEach { (peer, state) ->
            val row = context.hbox().apply {
                setPadding(Sx.dp(14f), Sx.dp(12f), Sx.dp(14f), Sx.dp(12f))
                background = rounded(Sx.color(ColorId.filling))
                layoutParams = lp(t = Sx.dp(8f), l = Sx.dp(12f), r = Sx.dp(12f))
            }
            row.addView(context.label(Client.displayName(peer), 16f).apply { layoutParams = lp(0, weight = 1f) })
            val meta = listOfNotNull(stateText(state), if (peer in mutedPeers) Sx.t("микрофон выкл.", "muted") else null).joinToString(" · ")
            row.addView(context.label(meta, 13f, if (state == "active") ColorId.iconPositive else ColorId.textLight))
            addView(row)
        }
        if (active) {
            addView(context.action(if (muted) Sx.t("Включить микрофон", "Unmute") else Sx.t("Выключить микрофон", "Mute")) {
                muted = !muted
                ParvaneCalls.groupSetMuted(muted)
                render()
            })
            addView(context.action(Sx.t("Выйти из звонка", "Leave call"), ColorId.textNegative) {
                ParvaneCalls.groupLeave()
                active = false
                navigateBack()
            })
        } else addView(context.action(Sx.t("Закрыть", "Close")) { navigateBack() })
    }
}
