package org.drinkless.tdlib

import org.json.JSONObject
import java.io.File

/**
 * Приватность аккаунта, которую исполняет сервер (spec 007, T079, FR-040) — как web
 * (`provider.ts`: readStrangersAllowed/readGroupAddPolicy/pushV2Privacy): значения лежат
 * локально на устройстве, а `identity.privacy.set` уходит ЦЕЛИКОМ (перезаписывает все поля).
 *
 * Файл `privacy.json` в каталоге ядра, рядом с `ttl.json`/`drafts.json`/`folders.json`:
 * `{"<адрес аккаунта>": {"strangers": bool, "group_add": "anyone"|"nobody"}}`.
 *  - `strangers` — «сообщения от незнакомых»; ключа нет — на этом устройстве не задавали
 *    (экран показывает умолчание сервера — «разрешено»);
 *  - `group_add` — «кто может добавлять меня в группы» (P-34): своего экрана в шве нет,
 *    значение приходит блобом настроек уведомлений с другого устройства.
 * Метода чтения у сервера нет, поэтому устройство, где настройку НЕ задавали, ничего не шлёт —
 * иначе умолчание затёрло бы выбор, сделанный на другом устройстве ([toPush] → null).
 * Чистый JVM-класс.
 */
class PrivacyPrefs(private val dir: File) {
    private val file get() = File(dir, "privacy.json")
    private var root = JSONObject()

    init {
        try { if (file.exists()) root = JSONObject(SeamFiles.read(file)) } catch (e: Exception) { root = JSONObject() }
    }

    private fun entry(self: String): JSONObject? = if (self.isEmpty()) null else root.optJSONObject(self)
    private fun entryForWrite(self: String): JSONObject = root.optJSONObject(self) ?: JSONObject().also { root.put(self, it) }
    private fun save() { try { dir.mkdirs(); SeamFiles.write(file, root.toString()) } catch (e: Exception) { } }

    /** Задавал ли пользователь «сообщения от незнакомых» на этом устройстве. */
    @Synchronized fun strangersSet(self: String): Boolean = entry(self)?.has("strangers") == true
    /** «Сообщения от незнакомых» разрешены (не задано — умолчание сервера: разрешено). */
    @Synchronized fun strangersAllowed(self: String): Boolean = entry(self)?.optBoolean("strangers", true) ?: true
    @Synchronized fun setStrangersAllowed(self: String, allowed: Boolean) {
        if (self.isEmpty()) return
        entryForWrite(self).put("strangers", allowed)
        save()
    }

    /** «Никто не может добавлять меня в группы» (из блоба настроек уведомлений; не известно — false). */
    @Synchronized fun groupAddNobody(self: String): Boolean = entry(self)?.optString("group_add") == "nobody"
    /** Известное значение блоба: "anyone" | "nobody" | "" (не приходило). */
    @Synchronized fun groupAdd(self: String): String = entry(self)?.optString("group_add") ?: ""
    /** Значение `group_add` из блоба с другого устройства; true — изменилось. */
    @Synchronized fun noteGroupAdd(self: String, policy: String?): Boolean {
        if (self.isEmpty() || (policy != "anyone" && policy != "nobody")) return false
        if (groupAdd(self) == policy) return false
        entryForWrite(self).put("group_add", policy)
        save()
        return true
    }

    /** Настройка для нативного экрана X «Who can send me messages?» (платных сообщений нет). */
    fun newChatSettings(self: String): TdApi.NewChatPrivacySettings = TdApi.NewChatPrivacySettings(strangersAllowed(self), 0)

    /** Аргументы `Session::setPrivacy` (groupAddNobody, strangersAllowed); null — не отправлять. */
    @Synchronized fun toPush(self: String): Pair<Boolean, Boolean>? =
        if (strangersSet(self)) Pair(groupAddNobody(self), strangersAllowed(self)) else null
}
