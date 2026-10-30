package org.thunderdog.challegram.parvane.sections

import android.app.AlertDialog
import android.text.InputType
import android.widget.CheckBox
import android.widget.EditText
import org.drinkless.tdlib.Client
import org.parvane.core.ParvaneCore
import org.thunderdog.challegram.navigation.ViewController
import org.thunderdog.challegram.theme.ColorId
import org.thunderdog.challegram.theme.Theme
import org.thunderdog.challegram.tool.UI

/**
 * Parvane (spec 031, PUBLIC-1): «Публичная группа» в меню «⋮» профиля группы — как web/desktop. Владелец делает
 * группу публичной и выбирает имя (общее пространство с никами, проверка занятости), включает просмотр без вступления
 * и историю для вступивших; либо снова делает её закрытой. Переписка публичной группы читаема вступившими и сервером —
 * окно об этом предупреждает.
 */
object PublicGroupUi {
    private fun toast(text: String) = UI.showToast(text, android.widget.Toast.LENGTH_SHORT)

    @JvmStatic
    fun canOpen(chatId: Long): Boolean = Client.publicInfo(chatId)?.optBoolean("owner") == true

    @JvmStatic
    fun open(owner: ViewController<*>, chatId: Long) {
        val info = Client.publicInfo(chatId) ?: return
        if (!info.optBoolean("owner")) { toast(Sx.t("Публичной группу делает владелец", "Only the owner can make the group public")); return }
        val ctx = owner.context()
        val channel = info.optString("kind") == "channel"
        val form = ctx.vbox(Sx.dp(20f))
        val public = CheckBox(ctx).apply {
            text = if (channel) Sx.t("Публичный канал", "Public channel") else Sx.t("Публичная группа", "Public group")
            isChecked = info.optBoolean("isPublic"); setTextColor(Sx.color(ColorId.text)); form.addView(this)
        }
        val name = EditText(ctx).apply {
            hint = Sx.t("Имя (латиница, цифры, _)", "Name (letters, digits, _)")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setText(info.optString("name")); setTextColor(Sx.color(ColorId.text)); form.addView(this)
        }
        val preview = CheckBox(ctx).apply {
            text = Sx.t("Можно читать без вступления", "Can be read without joining")
            isChecked = if (info.optBoolean("isPublic")) info.optBoolean("preview", true) else true
            setTextColor(Sx.color(ColorId.text)); form.addView(this)
        }
        val history = CheckBox(ctx).apply {
            text = Sx.t("Вступившие видят прежние сообщения", "New members see earlier messages")
            isChecked = if (info.optBoolean("isPublic")) info.optBoolean("history", true) else true
            setTextColor(Sx.color(ColorId.text)); form.addView(this)
        }
        form.addView(ctx.label(Sx.t("Сообщения публичной группы может прочитать любой вступивший и сервер.",
            "Messages of a public group can be read by anyone who joins and by the server."), 13f, ColorId.textLight).apply {
            setPadding(0, Sx.dp(8f), 0, 0)
        })
        val sync = { name.isEnabled = public.isChecked; preview.isEnabled = public.isChecked; history.isEnabled = public.isChecked }
        public.setOnCheckedChangeListener { _, _ -> sync() }
        sync()
        val dialog = AlertDialog.Builder(ctx, Theme.dialogTheme())
            .setTitle(if (channel) Sx.t("Тип канала", "Channel type") else Sx.t("Тип группы", "Group type"))
            .setView(form)
            .setPositiveButton(Sx.t("Сохранить", "Save"), null)
            .setNegativeButton(Sx.t("Отмена", "Cancel"), null)
            .show()
        // «Сохранить» не закрывает окно, пока имя не прошло проверку
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val isPublic = public.isChecked
            val n = name.text.toString().trim().removePrefix("@")
            if (isPublic && n.isEmpty()) { name.error = Sx.t("Введите имя", "Enter a name"); return@setOnClickListener }
            Sx.async({
                if (isPublic && n != info.optString("name")) {
                    val check = ParvaneCore.publicCheckName(n)
                    // proto3-JSON не несёт available=false — отсутствие поля и есть «занято/нельзя»
                    if (check.has("error_code")) return@async "failed"
                    if (!check.optBoolean("available", false)) return@async check.optString("reason").ifEmpty { "taken" }
                }
                Client.setPublic(chatId, isPublic, if (isPublic) n else "", preview.isChecked, history.isChecked)
            }) { r ->
                when (r) {
                    "ok" -> { toast(Sx.t("Сохранено", "Saved")); dialog.dismiss() }
                    "taken" -> name.error = Sx.t("Имя занято", "This name is taken")
                    "invalid", "format" -> name.error = Sx.t("Недопустимое имя: 5–32 символа, латиница, цифры и _, начинается с буквы", "Invalid name: 5–32 characters, letters, digits and _, starting with a letter")
                    "reserved" -> name.error = Sx.t("Это имя зарезервировано", "This name is reserved")
                    else -> toast(Sx.t("Не удалось. Попробуйте ещё раз", "Something went wrong. Try again"))
                }
            }
        }
    }
}
