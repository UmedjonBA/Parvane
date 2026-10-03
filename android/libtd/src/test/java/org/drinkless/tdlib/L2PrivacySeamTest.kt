package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.parvane.core.ParvaneProtocol
import java.io.File
import java.util.Locale

/**
 * spec 007 в шве TDLib, без эмулятора (хостовая libparvane_protocol_jni.so — тот же
 * v2_bridge.h, что на телефоне):
 *  - правило L2-1: смена режима «усиленная приватность» — нативное служебное сообщение
 *    (личный чат: событие движка `direct` с `chat_mode`, своё переключение; группа: событие
 *    сессии `groupL2`), тексты EN/RU, своё/чужое; кэш `l2State` закрывает typing/presence и
 *    кормит строку-переключатель X;
 *  - T110: `upgrade_available` → `UpdateServiceNotification` один раз за запуск,
 *    `upgrade_required` → диалог «обновите приложение» + «Connecting…», без разлогина;
 *  - T079: «сообщения от незнакомых» — хранение по аккаунту, отправка только заданного здесь.
 */
class L2PrivacySeamTest {
    private val op = "0192f0e4-1a2b-7c3d-8e4f-001122334455"
    private val self = "bob@local"
    private val peer = "alice@local"
    private val defaultLocale: Locale = Locale.getDefault()

    @After
    fun restoreLocale() = Locale.setDefault(defaultLocale)

    private fun store() = ParvaneStore().apply {
        self = this@L2PrivacySeamTest.self
        setProfile(peer, JSONObject().put("display_name", "Alice"))
    }

    private fun direct(l2: Boolean, from: String) = """
        {"type":"direct","seq":1,"chat":"$peer","from":"$from","device":"d","opId":"$op",
         "tsMs":1700000000123,"content":{"chat_mode":{"l2":$l2}},"disposition":"show"}
    """.trimIndent()

    /** Событие ядра "message" → сообщение стора, как в Client.onCoreEvent. */
    private fun put(s: ParvaneStore, ev: JSONObject): TdApi.Message = s.putMessage(
        ev.getString("id"), ev.getString("from"), ev.getString("to"), ev.getLong("ts"), ev.getJSONObject("content"),
        ev.getBoolean("out"), read = ev.optBoolean("read"))!!

    private fun serviceText(m: TdApi.Message): String {
        assertTrue("служебное сообщение, не пузырь: ${m.content.javaClass.simpleName}", m.content is TdApi.MessageCustomServiceAction)
        return (m.content as TdApi.MessageCustomServiceAction).text
    }

    // ── L2-1: служебное сообщение о смене режима ─────────────────────────────

    @Test
    fun chatModeFromPeerIsNativeServiceMessageEnAndRu() {
        val r = ParvaneProtocol.interpretDirect(direct(true, peer), self)
        assertEquals("message", r.getJSONObject("incoming").getString("kind"))
        val ev = r.getJSONObject("event")
        assertEquals("chat_mode", ev.getString("kind"))
        assertEquals(op, ev.getString("id"))
        assertEquals(false, ev.getBoolean("out"))
        assertEquals(true, ev.getJSONObject("content").getBoolean("l2"))

        Locale.setDefault(Locale.ENGLISH)
        assertEquals("Alice enabled enhanced privacy", serviceText(put(store(), ev)))
        Locale.setDefault(Locale("ru"))
        assertEquals("Alice включил(а) усиленную приватность", serviceText(put(store(), ev)))

        val off = ParvaneProtocol.interpretDirect(direct(false, peer), self).getJSONObject("event")
        Locale.setDefault(Locale.ENGLISH)
        assertEquals("Alice disabled enhanced privacy", serviceText(put(store(), off)))
        Locale.setDefault(Locale("ru"))
        assertEquals("Alice выключил(а) усиленную приватность", serviceText(put(store(), off)))
    }

    @Test
    fun chatModeFromOwnOtherDeviceIsOwnServiceMessage() {
        val ev = ParvaneProtocol.interpretDirect(direct(true, self), self).getJSONObject("event")
        assertEquals(true, ev.getBoolean("out"))
        assertEquals(peer, ev.getString("to"))
        Locale.setDefault(Locale.ENGLISH)
        val m = put(store(), ev)
        assertEquals("You enabled enhanced privacy", serviceText(m))
        assertTrue(m.isOutgoing)
        Locale.setDefault(Locale("ru"))
        assertEquals("Вы включили усиленную приватность", serviceText(put(store(), ev)))
    }

    @Test
    fun ownToggleIsLocalServiceMessageWithOperationId() {
        // эхо от движка не приходит: JNI отдаёт то же событие "message" с id операции (журналируется)
        val ev = ParvaneProtocol.ownChatMode(self, peer, false, op, 1700000000L)
        assertEquals("message", ev.getString("type"))
        assertEquals(op, ev.getString("id"))
        assertEquals(self, ev.getString("from"))
        assertEquals(peer, ev.getString("to"))
        assertEquals(true, ev.getBoolean("out"))
        assertEquals(false, ev.getBoolean("group"))
        val s = store()
        Locale.setDefault(Locale.ENGLISH)
        val m = put(s, ev)
        assertEquals("You disabled enhanced privacy", serviceText(m))
        assertEquals(s.idOf(peer), m.chatId)
        assertNull("повтор того же id — дубль не создаётся", s.putMessage(op, self, peer, 1700000000L, ev.getJSONObject("content"), true))
        Locale.setDefault(Locale("ru"))
        assertEquals("Вы выключили усиленную приватность", serviceText(put(store(), ev)))
    }

    @Test
    fun serviceTextCoversAllVariantsInBothLanguages() {
        val on = JSONObject().put("kind", "chat_mode").put("l2", true)
        val off = JSONObject().put("kind", "chat_mode").put("l2", false)
        assertEquals("Carol enabled enhanced privacy", L2Mode.serviceText(on, false, "Carol", ru = false))
        assertEquals("Carol disabled enhanced privacy", L2Mode.serviceText(off, false, "Carol", ru = false))
        assertEquals("You enabled enhanced privacy", L2Mode.serviceText(on, true, "Carol", ru = false))
        assertEquals("You disabled enhanced privacy", L2Mode.serviceText(off, true, "Carol", ru = false))
        assertEquals("Carol включил(а) усиленную приватность", L2Mode.serviceText(on, false, "Carol", ru = true))
        assertEquals("Carol выключил(а) усиленную приватность", L2Mode.serviceText(off, false, "Carol", ru = true))
        assertEquals("Вы включили усиленную приватность", L2Mode.serviceText(on, true, "", ru = true))
        assertEquals("Вы выключили усиленную приватность", L2Mode.serviceText(off, true, "", ru = true))
        // автор записи группы неизвестен — без имени
        assertEquals("Enhanced privacy is enabled", L2Mode.serviceText(on, false, "", ru = false))
        assertEquals("Усиленная приватность выключена", L2Mode.serviceText(off, false, "", ru = true))
    }

    @Test
    fun groupL2SessionEventIsServiceMessageInGroupChat() {
        val gid = "v2g:00ff"
        val session = """{"type":"groupL2","address":"$gid","enabled":true,"by":"$peer","id":"$op","tsMs":1700000000123}"""
        val ev = ParvaneProtocol.sessionEvent(session, self)!!
        assertEquals("message", ev.getString("type"))
        assertEquals(op, ev.getString("id"))
        assertEquals(peer, ev.getString("from"))
        assertEquals(gid, ev.getString("to"))
        assertEquals(1700000000L, ev.getLong("ts"))
        assertEquals(true, ev.getBoolean("group"))
        assertEquals(false, ev.getBoolean("out"))
        assertEquals("квитанцию слать некому", true, ev.getBoolean("read"))
        assertEquals("chat_mode", ev.getJSONObject("content").getString("kind"))

        val s = store()
        val (chat, _, _) = s.ensureGroup(gid, "G", listOf(self, peer), peer)!!
        Locale.setDefault(Locale.ENGLISH)
        val m = put(s, ev)
        assertEquals(chat.id, m.chatId)
        assertEquals("Alice enabled enhanced privacy", serviceText(m))
        assertEquals("служебное сообщение группы не добавляет непрочитанное", 0, chat.unreadCount)

        // политику сменил я сам (событие приходит и автору) — «Вы …»
        val mine = ParvaneProtocol.sessionEvent(session.replace("\"by\":\"$peer\"", "\"by\":\"$self\"").replace("\"enabled\":true", "\"enabled\":false"), self)!!
        assertEquals(true, mine.getBoolean("out"))
        val s2 = store().also { it.ensureGroup(gid, "G", listOf(self, peer), peer) }
        Locale.setDefault(Locale("ru"))
        assertEquals("Вы выключили усиленную приватность", serviceText(put(s2, mine)))

        // автор неизвестен (вошли в группу с включённым режимом): шов ставит владельца и флаг anon
        val anon = ParvaneProtocol.sessionEvent(session.replace("\"by\":\"$peer\"", "\"by\":\"\""), self)!!
        assertEquals("", anon.getString("from"))
        val s3 = store().also { it.ensureGroup(gid, "G", listOf(self, peer), peer) }
        val content = anon.getJSONObject("content").put("anon", true)
        Locale.setDefault(Locale.ENGLISH)
        assertEquals("Enhanced privacy is enabled", serviceText(s3.putMessage(op, peer, gid, 1700000000L, content, false, read = true)!!))
    }

    // ── L2-1: эфемерные события и строка-переключатель по кэшу l2State ─────────

    @Test
    fun l2StateCacheGatesTypingAndPresence() {
        val gid = "v2g:00ff"
        val l2 = L2Mode()
        assertTrue("до события — режим выключен", l2.ephemeralAllowed(peer))
        assertTrue(l2.presenceAllowed)

        val session = """{"type":"l2State","chats":["$peer","carol@local","$gid"],"mine":["$peer"],"presenceAllowed":false}"""
        val ev = ParvaneProtocol.sessionEvent(session, self)!!
        assertEquals("l2_state", ev.getString("type"))
        assertEquals(false, ev.getBoolean("presence_allowed"))
        val v = l2.version()
        assertEquals(setOf(peer, "carol@local", gid), l2.apply(ev))
        assertTrue(l2.awaitChange(v, 10))

        assertFalse("typing в L2-чат не шлём и входящий игнорируем", l2.ephemeralAllowed(peer))
        assertFalse(l2.ephemeralAllowed("carol@local"))
        assertFalse(l2.ephemeralAllowed(gid))
        assertTrue("обычный чат не затронут", l2.ephemeralAllowed("dave@local"))
        assertFalse("присутствие одно на аккаунт — не публикуем", l2.presenceAllowed)

        // строка-переключатель: моё предпочтение / включена собеседником / политика группы
        assertEquals(L2Mode.BIT_ACTIVE or L2Mode.BIT_CHECKED or L2Mode.BIT_CAN_CHANGE, l2.optionBits(peer, group = false, canChange = true))
        assertEquals(L2Mode.BIT_ACTIVE or L2Mode.BIT_BY_PEER or L2Mode.BIT_CAN_CHANGE, l2.optionBits("carol@local", group = false, canChange = true))
        assertEquals(L2Mode.BIT_ACTIVE or L2Mode.BIT_CHECKED, l2.optionBits(gid, group = true, canChange = false))
        assertEquals(L2Mode.BIT_CAN_CHANGE, l2.optionBits("dave@local", group = false, canChange = true))

        // режим выключен везде — всё снова разрешено
        val off = ParvaneProtocol.sessionEvent("""{"type":"l2State","chats":[],"mine":[],"presenceAllowed":true}""", self)!!
        assertEquals(setOf(peer, "carol@local", gid), l2.apply(off))
        assertTrue(l2.ephemeralAllowed(peer))
        assertTrue(l2.presenceAllowed)
        assertEquals(0, l2.activeCount())
        assertFalse("события нет — ожидание истекает", l2.awaitChange(l2.version(), 10))
    }

    @Test
    fun onlineStatusOfL2PeerIsCleared() {
        val s = store()
        s.ensurePeer(peer)
        assertTrue(s.setOnline(peer, 1700000090) is TdApi.UpdateUserStatus)
        val upd = s.setOffline(peer) as TdApi.UpdateUserStatus
        assertTrue(upd.status is TdApi.UserStatusOffline)
        assertNull("уже не в сети — апдейта нет", s.setOffline(peer))
    }

    @Test
    fun groupPolicyRightFollowsChangeInfo() {
        assertTrue(L2Mode.canChangeGroup("owner", null, null))
        assertTrue("админ без записи прав — полный набор", L2Mode.canChangeGroup("admin", null, null))
        assertFalse(L2Mode.canChangeGroup("admin", JSONObject().put("change_info", false), null))
        assertFalse("участник — по правам по умолчанию", L2Mode.canChangeGroup("member", null, null))
        assertTrue(L2Mode.canChangeGroup("member", null, JSONObject().put("change_info", true)))
        assertFalse(L2Mode.canChangeGroup(null, null, JSONObject().put("change_info", true)))
    }

    @Test
    fun optionNameCarriesChatId() {
        assertEquals(-1234L, L2Mode.chatIdOfOption(L2Mode.OPTION_PREFIX + "-1234"))
        assertNull(L2Mode.chatIdOfOption("x_parvane_phone"))
        assertNull(L2Mode.chatIdOfOption(L2Mode.OPTION_PREFIX + "abc"))
    }

    // ── T110: кадры перехода на v2 ───────────────────────────────────────────

    private fun text(u: TdApi.Update): String = ((u as TdApi.UpdateServiceNotification).content as TdApi.MessageText).text.text

    @Test
    fun upgradeAvailableIsServiceNotificationOncePerLaunch() {
        val n = UpgradeNotices()
        val first = n.onAvailable(ru = false)
        assertEquals(1, first.size)
        assertEquals(UpgradeNotices.TYPE_AVAILABLE, (first[0] as TdApi.UpdateServiceNotification).type)
        assertEquals("A new version of Parvane is available. Please update the app — this version will stop working soon.", text(first[0]))
        assertTrue("кадр приходит после каждого входа — показываем один раз", n.onAvailable(ru = false).isEmpty())
        assertFalse("v1 ещё работает", n.required)
        assertEquals("Доступна новая версия Parvane. Обновите приложение — эта версия скоро перестанет работать.",
            text(UpgradeNotices().onAvailable(ru = true)[0]))
    }

    @Test
    fun upgradeRequiredIsUpdateDialogAndConnectingStateOnce() {
        val n = UpgradeNotices()
        val first = n.onRequired(ru = false)
        assertEquals(2, first.size)
        assertTrue("соединения по v1 нет — «Connecting…», сессия остаётся",
            (first[0] as TdApi.UpdateConnectionState).state is TdApi.ConnectionStateConnecting)
        assertEquals(UpgradeNotices.TYPE_REQUIRED, (first[1] as TdApi.UpdateServiceNotification).type)
        assertEquals("This version of Parvane is no longer supported. Update the app to continue.", text(first[1]))
        assertTrue(n.required)
        assertTrue("транспорт пробует раз в 5 минут — диалог один раз за запуск", n.onRequired(ru = false).isEmpty())
        assertTrue("после «не поддерживается» мягкое уведомление не показываем", n.onAvailable(ru = false).isEmpty())
        n.onConnected()
        assertFalse("оператор вернул v1", n.required)
        assertEquals("Эта версия Parvane больше не поддерживается. Обновите приложение, чтобы продолжить.",
            text(UpgradeNotices().onRequired(ru = true)[1]))
    }

    @Test
    fun upgradeRequiredErrorIsNotAuthFailure() {
        assertTrue(UpgradeNotices.isUpgradeError("gateway: upgrade_required"))
        assertFalse(UpgradeNotices.isUpgradeError("gateway: отказ авторизации: просроченный JWT"))
        assertFalse(UpgradeNotices.isUpgradeError(null))
        // сторож исходников: ветка разлогина pump в JNI проверяет upgrade_required раньше текста «отказ авторизации»,
        // обработчик кадров подключён, шов не уводит upgrade в sessionExpired
        val jni = source("jni/parvane_jni.cpp")
        assertTrue(jni.contains("setUpgradeHandler("))
        assertTrue(jni.contains("if (!upgrade && (what.find(\"отказ авторизации\")"))
        assertTrue(jni.contains("if (upgradeBlocked()) throw"))
        val client = source("libtd/src/main/java/org/drinkless/tdlib/Client.kt")
        assertTrue(client.contains("\"upgrade_available\" -> upgrade.onAvailable()"))
        assertTrue(client.contains("\"upgrade_required\" -> upgrade.onRequired()"))
        assertTrue(client.contains("if (event.optString(\"reason\") == \"auth\") sessionExpired()"))
    }

    // ── T079: «сообщения от незнакомых» ───────────────────────────────────────

    @Test
    fun strangersSettingIsStoredPerAccountAndPushedOnlyWhenSetHere() {
        val dir = File.createTempFile("pv-privacy", "").let { it.delete(); it.mkdirs(); it }
        try {
            val p = PrivacyPrefs(dir)
            assertTrue("умолчание сервера — разрешено", p.strangersAllowed(self))
            assertTrue(p.newChatSettings(self).allowNewChatsFromUnknownUsers)
            assertFalse(p.strangersSet(self))
            assertNull("не задавали здесь — в identity ничего не шлём (не затираем выбор другого устройства)", p.toPush(self))

            p.setStrangersAllowed(self, false)
            assertFalse(p.newChatSettings(self).allowNewChatsFromUnknownUsers)
            assertEquals(0L, p.newChatSettings(self).incomingPaidMessageStarCount)
            assertEquals(Pair(false, false), p.toPush(self))

            // переживает рестарт; другой аккаунт на том же устройстве не затронут
            val again = PrivacyPrefs(dir)
            assertTrue(again.strangersSet(self))
            assertFalse(again.strangersAllowed(self))
            assertTrue(again.strangersAllowed("carol@local"))
            assertNull(again.toPush("carol@local"))

            // «кто добавляет в группы» с другого устройства (блоб уведомлений) уходит вместе с настройкой
            assertTrue(again.noteGroupAdd(self, "nobody"))
            assertFalse("то же значение — без записи", again.noteGroupAdd(self, "nobody"))
            assertFalse(again.noteGroupAdd(self, "garbage"))
            assertEquals(Pair(true, false), PrivacyPrefs(dir).toPush(self))
            again.setStrangersAllowed(self, true)
            assertEquals(Pair(true, true), PrivacyPrefs(dir).toPush(self))

            // FR-040: источник истины — сервер. Подтверждённая правка больше не досылается,
            // серверное значение принимается; неподтверждённая своя — сильнее прочитанного
            val synced = PrivacyPrefs(dir)
            assertFalse("своя правка ещё в пути — серверное значение не применяется", synced.applyServer(self, false, false))
            synced.notePushed(self)
            assertNull("подтверждено сервером — при запуске не досылаем", PrivacyPrefs(dir).toPush(self))
            assertTrue(synced.applyServer(self, false, false))
            assertFalse("то же значение — без записи", synced.applyServer(self, false, false))
            val fresh = PrivacyPrefs(dir)
            assertFalse(fresh.strangersAllowed(self))
            assertEquals("anyone", fresh.groupAdd(self))
            assertNull("значение с сервера — не своя правка", fresh.toPush(self))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun notifyBlobKeepsGroupAddPolicyOfOtherDevice() {
        val s = store()
        assertFalse("не приходило — в свой блоб не пишем", JSONObject(s.setChatMute(peer, 3600)).has("group_add"))
        s.applyNotifyBlob(JSONObject().put("defaults", JSONObject()).put("exceptions", JSONObject()).put("group_add", "nobody"))
        assertEquals("nobody", s.groupAddPolicy)
        assertEquals("nobody", JSONObject(s.setChatMute(peer, 3600)).getString("group_add"))
        assertEquals("nobody", JSONObject(s.setScopeMute("users", 0)).getString("group_add"))
    }

    @Test
    fun privacyAndL2AreWiredIntoSeam() {
        val client = source("libtd/src/main/java/org/drinkless/tdlib/Client.kt")
        for (h in listOf("GetNewChatPrivacySettings", "SetNewChatPrivacySettings", "GetUserPrivacySettingRules"))
            assertTrue("нет обработчика $h", client.contains("is TdApi.$h ->"))
        assertTrue("typing в L2-чат не уходит", client.contains("if (l2.ephemeralAllowed(it)) ParvaneCore.sendTyping(it)"))
        assertTrue("кэш l2State подключён", client.contains("\"l2_state\" -> {"))
        assertTrue("приватность шлём только заданную здесь", client.contains("privacy.toPush(store.self) ?: return"))
        val jni = source("jni/parvane_jni.cpp")
        assertTrue("присутствие не публикуется при активном режиме", jni.contains("&& g_l2PresenceAllowed"))
        assertTrue(jni.contains("if (l2Active(toStd)) return;"))
    }

    private fun source(path: String): String =
        listOf(File(path), File("../$path"), File(path.removePrefix("libtd/"))).firstOrNull { it.exists() }?.readText()
            ?: throw AssertionError("нет $path рядом с модулем")
}
