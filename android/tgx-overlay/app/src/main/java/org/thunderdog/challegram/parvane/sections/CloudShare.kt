package org.thunderdog.challegram.parvane.sections

import android.content.Context
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import org.drinkless.tdlib.Client
import org.json.JSONObject
import org.parvane.core.ParvaneSections
import org.thunderdog.challegram.parvane.sections.Kn.ava
import org.thunderdog.challegram.parvane.sections.Kn.input
import org.thunderdog.challegram.parvane.sections.Kn.listRow
import org.thunderdog.challegram.tool.UI

/**
 * Parvane (ревью 7 ноя 2026, B7): совместная папка «Облака» — окно «Доступ к «…»» (web `CloudShareDialog`, desktop
 * `parvane_cloud_dialogs.cpp`) и ответ на приглашение. Владелец: права нового участника («Просмотр» / «Правка»),
 * «Добавить» по нику либо из контактов, участники с их правами (нажатие — сменить, ✕ — убрать), «Сделать личной»
 * (файлы — в личный диск, доступ закрывается) и «Удалить общую папку». Участник: владелец и свои права, «Покинуть».
 * Всё — вызовы провайдера облака ядра (`parvaneCloudShare/Unshare/AnswerInvite/Leave/RemoveShared`), как web.
 * В журнал — только действие и итог (без ников и названий): `облако: доступ <действие> → ok|<ошибка>`.
 */
object CloudShare {
    private const val TAG = "ParvaneCloud"

    fun roleTitle(role: String) = when (role) {
        "editor" -> Sx.t("Правка", "Editor")
        "owner" -> Sx.t("Владелец", "Owner")
        else -> Sx.t("Просмотр", "Reader")
    }

    fun nameOf(address: String): String = try { Client.displayName(address) } catch (e: Throwable) { address.substringBefore('@') }

    fun containerOf(snap: JSONObject?, id: String): JSONObject? =
        Sx.list(snap?.optJSONArray("containers")).firstOrNull { it.optString("id") == id }

    fun invites(snap: JSONObject?): List<JSONObject> = Sx.list(snap?.optJSONArray("containers")).filter { it.optString("kind") == "invite" }

    /** Ник либо адрес → адрес: без домена — домен своего адреса (как ввод ника в поиске X). */
    fun addressOf(input: String): String? {
        val text = input.trim().removePrefix("@").trim()
        if (text.isEmpty() || text.any { it.isWhitespace() }) return null
        if (text.contains('@')) return text
        val domain = Client.selfAddress().substringAfter('@', "")
        return if (domain.isEmpty()) null else "$text@$domain"
    }

    fun errorText(code: String) = when (code) {
        "not-found" -> Sx.t("Такого пользователя нет", "No such user")
        "forbidden" -> Sx.t("Нет прав", "No permission")
        "unavailable", "offline" -> Sx.t("Нет связи с сервером", "No connection to the server")
        else -> Sx.t("Не получилось: $code", "Failed: $code")
    }

    /** Вызов провайдера облака ядра с потока разделов; ответ (ok, error) — на главном. */
    fun call(action: String, method: String, args: JSONObject, done: (Boolean) -> Unit = {}) {
        Sx.async({ ParvaneSections.cloudCall(method, args.toString()) }) { r ->
            val o = r as? JSONObject
            val ok = o?.optBoolean("ok", false) == true
            val err = o?.optString("error").orEmpty().ifEmpty { if (o == null) "failed" else "" }
            Log.i(TAG, "облако: доступ $action → ${if (ok) "ok" else err}")
            if (!ok) UI.showToast(errorText(err), android.widget.Toast.LENGTH_SHORT)
            done(ok)
        }
    }

    /** Ответ на приглашение; принятая папка открывается в [onAccepted]. */
    fun answer(container: String, accept: Boolean, onAccepted: () -> Unit = {}) =
        call(if (accept) "accept" else "decline", "parvaneCloudAnswerInvite",
            JSONObject().put("container", container).put("isAccepted", accept)) { ok -> if (ok && accept) onAccepted() }

    /**
     * Окно «Доступ» совместной папки [containerId]; перерисовывается по снимкам облака, пока открыто.
     * [onGone] — папки больше нет (сделана личной, удалена, покинута): экран уходит из неё.
     */
    fun open(context: Context, containerId: String, knownName: String = "", onGone: () -> Unit = {}) {
        val first = containerOf(Sx.last("cloud") ?: ParvaneSections.snapshot("cloud"), containerId)
        val title = first?.optString("name").orEmpty().ifEmpty { knownName }.ifEmpty { Sx.t("Общая папка", "Shared folder") }
        val sheet = PvSheet.create(context, Sx.t("Доступ к «$title»", "Access to “$title”"))
        var newRole = "reader"
        var busy = false
        var nick = ""
        var closed = false
        var snap: JSONObject? = null
        var render: () -> Unit = {}
        var shown = "" // что нарисовано: снимок облака приходит часто, а пересборка снимала фокус с поля ника
        fun act(action: String, method: String, args: JSONObject, after: (Boolean) -> Unit = {}) {
            busy = true; render()
            call(action, method, args.put("container", containerId)) { ok -> busy = false; after(ok); if (!closed) render() }
        }
        fun share(address: String) {
            val roleText = roleTitle(newRole).lowercase()
            val name = containerOf(snap, containerId)?.optString("name").orEmpty()
            act("share", "parvaneCloudShare", JSONObject().put("user", address).put("role", newRole)
                .put("inviteText", Sx.t("Приглашение в папку «$name» ($roleText)", "Invitation to the folder “$name” ($roleText)"))) { ok -> if (ok) nick = "" }
        }
        fun leave() { closed = true; sheet.dismiss(); onGone() }
        render = render@{
            if (closed) return@render
            val c = containerOf(snap, containerId)
            val sig = "${c?.toString()}|$busy|$newRole"
            if (sig == shown) return@render
            shown = sig
            val content = sheet.content
            content.removeAllViews()
            if (c == null || c.optString("kind") == "invite") {
                // Только что созданной папки в снимке ещё нет — она появится следующим снимком
                sheet.add(context.pvText(if (c == null && first == null) Sx.t("Папка готовится…", "Preparing the folder…")
                    else Sx.t("Приглашение больше не действует", "The invitation is no longer valid"), 0.9375f, Pv.c.muted))
                return@render
            }
            val isOwner = c.optString("kind") == "owned" || c.optString("role") == "owner"
            val small = 0.8125f
            if (!isOwner) {
                val role = c.optString("role")
                sheet.add(context.pvText(Sx.t("Владелец: ${nameOf(c.optString("owner"))}", "Owner: ${nameOf(c.optString("owner"))}") +
                    if (role.isEmpty()) "" else " · ${roleTitle(role)}", small, Pv.c.muted))
                sheet.add(context.pvButton(Sx.t("Покинуть папку", "Leave folder"), "danger") {
                    if (busy) return@pvButton
                    PvSheet.confirm(context, Sx.t("Покинуть совместную папку?", "Leave the shared folder?"), c.optString("name"), Sx.t("Покинуть", "Leave"), danger = true) {
                        act("leave", "parvaneCloudLeave", JSONObject()) { ok -> if (ok) leave() }
                    }
                })
                return@render
            }
            sheet.add(context.pvText(Sx.t("Всё вложенное станет общим. Участники получают ключ к файлам — сервер их по-прежнему не видит.",
                "Everything inside becomes shared. Members get the key to the files — the server still cannot see them."), small, Pv.c.muted))
            // Права нового участника и подсказка (`.shareAdd`)
            sheet.add(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                for (r in listOf("reader", "editor")) addView(context.pvChip(roleTitle(r), newRole == r) { newRole = r; render() }.apply {
                    (layoutParams as? LinearLayout.LayoutParams)?.rightMargin = Pv.rem(0.375f)
                })
            })
            sheet.add(context.pvText(if (newRole == "editor") Sx.t("Может загружать, переименовывать, перемещать и удалять", "Can upload, rename, move and delete")
                else Sx.t("Может смотреть и скачивать", "Can view and download"), small, Pv.c.muted), 0.375f)
            val field = context.input(nick, Sx.t("Ник собеседника", "Username"))
            field.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            field.addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(s: android.text.Editable?) { nick = s?.toString().orEmpty() }
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
            })
            fun submit() {
                if (busy) return
                val address = addressOf(field.text.toString()) ?: run { UI.showToast(Sx.t("Введите ник", "Enter a username"), android.widget.Toast.LENGTH_SHORT); return }
                if (address == Client.selfAddress()) return
                share(address)
            }
            field.setOnEditorActionListener { _, _, _ -> submit(); true }
            sheet.add(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(field, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(context.pvButton(Sx.t("Добавить", "Add people"), "acc") { submit() }.apply {
                    (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f)
                    alpha = if (busy) 0.5f else 1f
                })
            })
            // Как выбор собеседника web/desktop: известные контакты
            sheet.add(context.pvButton(Sx.t("Из контактов", "From contacts"), "ghost", icon = "users") {
                if (busy) return@pvButton
                val members = Sx.list(c.optJSONArray("members")).map { it.optString("user") }.toSet()
                val people = Sx.list(Client.exportMeta().optJSONArray("contacts"))
                    .filter { val a = it.optString("address"); a.isNotEmpty() && a != Client.selfAddress() && a !in members }
                    .sortedBy { it.optString("name").lowercase() }
                if (people.isEmpty()) { UI.showToast(Sx.t("Контактов пока нет — введите ник", "No contacts yet — enter a username"), android.widget.Toast.LENGTH_SHORT); return@pvButton }
                PvSheet.choose(context, Sx.t("Кому открыть доступ", "Share with"), people.map { it.optString("name").ifEmpty { it.optString("address") } }) { i ->
                    share(people[i].optString("address"))
                }
            }, 0.375f)
            // Участники и их права
            val members = Sx.list(c.optJSONArray("members")).filter { it.optString("user").isNotEmpty() && it.optString("role") != "owner" }
            if (members.isEmpty()) sheet.add(context.pvText(Sx.t("Пока доступ только у вас", "Only you have access so far"), 0.9375f, Pv.c.muted))
            members.forEach { m ->
                val user = m.optString("user")
                val name = nameOf(user)
                val isEditor = m.optString("role") == "editor"
                val trailing = LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    addView(context.pvPill(roleTitle(if (isEditor) "editor" else "reader"), icon = "down") {
                        if (!busy) act("role", "parvaneCloudShare", JSONObject().put("user", user).put("role", if (isEditor) "reader" else "editor").put("inviteText", ""))
                    }.apply { contentDescription = Sx.t("Права: $name", "Role: $name") })
                    addView(context.pvIconButton("x", Sx.t("Убрать: $name", "Remove: $name"), Pv.c.muted) {
                        if (!busy) act("remove", "parvaneCloudUnshare", JSONObject().put("user", user))
                    })
                }
                sheet.add(context.listRow(context.ava(Pv.c.purple, letter = name.take(1).uppercase()), name, user, trailing) {}, 0.125f)
            }
            sheet.add(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END
                addView(context.pvButton(Sx.t("Сделать личной", "Make private")) {
                    if (busy) return@pvButton
                    PvSheet.confirm(context, Sx.t("Сделать личной", "Make private"),
                        Sx.t("Файлы папки перейдут в ваш личный диск, у участников доступ пропадёт.", "The files move to your personal drive; members lose access."),
                        Sx.t("Сделать личной", "Make private")) {
                        busy = true; render()
                        Sx.async({ ParvaneSections.cloudFiles("unshareFolder", JSONObject().put("container", containerId).put("name", privateName(c.optString("name")))) }) { r ->
                            val o = r as? JSONObject
                            val ok = o?.optBoolean("ok") == true
                            Log.i(TAG, "облако: доступ private → ${if (ok) "ok" else o?.optString("error").orEmpty().ifEmpty { "failed" }}")
                            busy = false
                            if (ok) leave() else { UI.showToast(errorText(o?.optString("error").orEmpty().ifEmpty { "failed" }), android.widget.Toast.LENGTH_SHORT); render() }
                        }
                    }
                })
                addView(context.pvButton(Sx.t("Удалить общую папку", "Delete shared folder"), "danger") {
                    if (busy) return@pvButton
                    PvSheet.confirm(context, Sx.t("Удалить общую папку?", "Delete the shared folder?"),
                        Sx.t("Папка и её файлы удалятся у всех участников.", "The folder and its files are deleted for everyone."), Sx.t("Удалить", "Delete"), danger = true) {
                        act("delete", "parvaneCloudRemoveShared", JSONObject()) { ok -> if (ok) leave() }
                    }
                }.apply { (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.5f) })
            })
        }
        val stop = Sx.watch("cloud") { s -> snap = s; render() }
        sheet.onClose { closed = true; stop() }
        if (snap == null) { snap = Sx.last("cloud"); render() }
        sheet.show()
    }

    /** Свободное имя для папки, которая станет личной (ядро `freeName`: «Имя», «Имя (1)», …). */
    private fun privateName(name: String): String {
        val base = name.ifEmpty { Sx.t("Общая папка", "Shared folder") }
        val snap = Sx.last("cloud")
        val root = snap?.optString("rootId").orEmpty()
        val taken = Sx.list(snap?.optJSONObject("state")?.optJSONObject("trees")?.optJSONObject(root)?.optJSONArray("nodes"))
            .filter { (it.isNull("parent") || it.optString("parent").isEmpty()) && !it.optBoolean("trashed") }
            .map { it.optString("name").lowercase() }.toSet()
        if (base.lowercase() !in taken) return base
        var n = 1
        while ("$base ($n)".lowercase() in taken) n++
        return "$base ($n)"
    }

    /** Строка приглашения (`.invite` web): «X приглашает в «…»», права, «Отклонить» и «Принять». */
    fun inviteRow(context: Context, c: JSONObject, onAccepted: () -> Unit): View {
        val owner = nameOf(c.optString("owner"))
        val folder = c.optString("name").ifEmpty { Sx.t("Общая папка", "Shared folder") }
        val id = c.optString("id")
        val buttons = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(context.pvButton(Sx.t("Отклонить", "Decline"), "ghost") { answer(id, false) })
            addView(context.pvButton(Sx.t("Принять", "Accept"), "acc") { answer(id, true, onAccepted) }.apply {
                (layoutParams as LinearLayout.LayoutParams).leftMargin = Pv.rem(0.375f)
            })
        }
        return context.listRow(context.ava(Pv.c.purple, letter = owner.take(1).uppercase()),
            Sx.t("$owner приглашает в «$folder»", "$owner invites you to “$folder”"), roleTitle(c.optString("role")).lowercase(), buttons) {}.apply {
            background = Pv.shape(Pv.mix(Pv.c.purple, Pv.c.panel, 10), 0.5f)
        }
    }
}
