package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.parvane.core.EngineHost
import org.parvane.core.ParvaneProtocol
import java.nio.file.Files

/**
 * Личное состояние в шве (spec 007 T098; spec 036 ENGINE-1): локальные папки/черновики/архив/отложенные/закреп/…
 * → объекты видов state.v2 ([StateJournal.objects]) → модель → объекты модели (`viewStateJson`) → показ на другом
 * «устройстве» ([StateJournal.show]). Сведение, разница по полям и метки — только в модели (последний тест гоняет
 * настоящую модель движка через хост ядра). Имена и тексты — выдуманные.
 */
class StateJournalTest {
    private val ids = mapOf("bob@local" to 11L, "carol@local" to 12L, "v2g:" + "ab".repeat(16) to -21L)

    private fun resolver(knownV2: Boolean = true) = object : StateJournal.Resolver {
        override fun addressOf(chatId: Long) = ids.entries.firstOrNull { it.value == chatId }?.key
        override fun chatIdOf(address: String) = ids[address]
        override fun domain() = "local"
        override fun isKnownV2Group(hex: String) = knownV2 && ids.containsKey("v2g:$hex")
    }

    private fun tmp() = Files.createTempDirectory("pv-state").toFile()

    private val allKinds = listOf("FOLDER", "FOLDER_ORDER", "BLOCK", "PEER_NOTIFY", "NOTIFY_DEFAULTS", "DRAFT", "SCHEDULED", "ARCHIVE",
        "PIN_LIST", "UNREAD_MARK", "QUICK_REACTION", "STICKER_PACK", "SAVED_GIF", "CONTACT")

    /** Модель без сведения: объекты видов шва как есть (вид, ключ, значение) — форма ответа `viewStateJson`. */
    private fun viewOf(j: StateJournal, local: ChatLocalState, queue: ScheduledQueue, blocked: Set<String> = emptySet(),
                       notify: StateJournal.NotifyView? = null, shown: JSONObject? = null): JSONObject {
        val objects = JSONArray()
        for (kind in allKinds) {
            val list = j.objects(kind, StateJournal.objectsOf(shown, kind), local, queue, blocked, notify, nowMs = 1_800_000_000_000L) ?: continue
            for (i in 0 until list.length()) {
                val o = list.getJSONObject(i)
                objects.put(JSONObject().put("kind", "OBJECT_KIND_$kind").put("key", o.getString("key")).put("value", o.getJSONObject("value"))
                    .put("marks", JSONArray()))
            }
        }
        return JSONObject().put("objects", objects)
    }

    private fun valueOf(view: JSONObject, kind: String, key: String): JSONObject? {
        val list = StateJournal.objectsOf(view, kind)
        return (0 until list.length()).map { list.getJSONObject(it) }.firstOrNull { it.getString("key") == key }?.getJSONObject("value")
    }

    /** STATE-2: закреп главного списка (порядок), отметка «непрочитано» и быстрая реакция переходят на другое устройство. */
    @Test
    fun pinsUnreadAndReactionRoundTrip() {
        val a = tmp()
        val local = ChatLocalState(a)
        local.setPinned(11L, true)
        local.setPinned(-21L, true) // последний закреплённый — первым
        local.setMarkedUnread(12L, true)
        local.setQuickReaction("🔥")
        assertTrue("закреплённый выше любого времени сообщения", local.pinnedOrder(-21L)!! > local.pinnedOrder(11L)!!)
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val view = viewOf(j, local, ScheduledQueue(a) { 1000L })
        val pins = valueOf(view, "PIN_LIST", "1")!!
        assertEquals("PIN_LIST_MAIN", pins.getString("list"))
        assertEquals(2, pins.getJSONArray("peers").length())
        assertNotNull("«непрочитано» — признак по ключу собеседника", valueOf(view, "UNREAD_MARK", "u:carol@local"))
        assertEquals("🔥", valueOf(view, "QUICK_REACTION", "")!!.getString("emoji"))

        val b = tmp()
        val other = ChatLocalState(b)
        val ch = StateJournal(ParvaneProtocol.stateCodec, resolver()).show(view, other, ScheduledQueue(b) { 1000L })
        assertEquals(listOf(-21L, 11L), other.pinnedChatIds())
        assertTrue(other.isMarkedUnread(12L))
        assertEquals("🔥", other.quickReaction())
        assertEquals(setOf(-21L, 11L), ch.pinned)
        assertEquals(setOf(12L), ch.unread)
        assertTrue(ch.reaction)
        // переживает перезапуск (pins.json)
        val reopened = ChatLocalState(b)
        assertEquals(listOf(-21L, 11L), reopened.pinnedChatIds())
        assertTrue(reopened.isMarkedUnread(12L))
        // снятие на первом устройстве доходит до второго
        local.setPinned(11L, false)
        local.setMarkedUnread(12L, false)
        val ch2 = StateJournal(ParvaneProtocol.stateCodec, resolver()).show(viewOf(j, local, ScheduledQueue(a) { 1000L }), other, ScheduledQueue(b) { 1000L })
        assertEquals(listOf(-21L), other.pinnedChatIds())
        assertFalse(other.isMarkedUnread(12L))
        assertEquals(setOf(12L), ch2.unread)
        assertFalse(ch2.reaction)
    }

    /**
     * Новое устройство получает объекты модели раньше своих групп: папка с группой показывается без неё, но правка
     * этого устройства не стирает группу из папки (иначе папка пустела у всех), а когда группа известна — она в папке.
     */
    @Test
    fun folderKeepsGroupUnknownToThisDevice() {
        val a = tmp()
        val local = ChatLocalState(a)
        local.folders.create(TdApi.ChatFolder(TdApi.ChatFolderName(TdApi.FormattedText("Учёба", arrayOf()), false), null, -1, false,
            longArrayOf(-21L), longArrayOf(11L, -21L), LongArray(0), false, false, false, false, false, false, false, false))
        local.setArchived(-21L, true)
        val view = viewOf(StateJournal(ParvaneProtocol.stateCodec, resolver()), local, ScheduledQueue(a) { 1000L })

        val b = tmp()
        val other = ChatLocalState(b)
        var knowsGroup = false
        val partial = object : StateJournal.Resolver {
            override fun addressOf(chatId: Long) = ids.entries.firstOrNull { it.value == chatId && (knowsGroup || it.value > 0) }?.key
            override fun chatIdOf(address: String) = ids[address]?.takeIf { knowsGroup || it > 0 }
            override fun domain() = "local"
            override fun isKnownV2Group(hex: String) = knowsGroup && ids.containsKey("v2g:$hex")
        }
        val j = StateJournal(ParvaneProtocol.stateCodec, partial)
        j.show(view, other, ScheduledQueue(b) { 1000L })
        assertEquals(listOf(11L), other.folders.all().single().included)
        assertTrue(other.archivedChatIds().isEmpty())
        assertTrue(j.hasUnresolved)
        val folderShown = StateJournal.objectsOf(view, "FOLDER")
        val written = j.objects("FOLDER", folderShown, other, ScheduledQueue(b) { 1000L })!!.getJSONObject(0).getJSONObject("value")
        assertEquals("группа осталась в папке", 2, written.getJSONArray("include_peers").length())
        assertEquals(1, written.getJSONArray("pinned_peers").length())
        val archive = j.objects("ARCHIVE", StateJournal.objectsOf(view, "ARCHIVE"), other, ScheduledQueue(b) { 1000L })!!
        assertEquals("архивная группа не снимается правкой", "g:local:" + "ab".repeat(16), archive.getJSONObject(0).getString("key"))

        knowsGroup = true
        // Группу узнали, показ ещё не повторён: правка в это окно не стирает её из папки
        val between = j.objects("FOLDER", folderShown, other, ScheduledQueue(b) { 1000L })!!.getJSONObject(0).getJSONObject("value")
        assertEquals(2, between.getJSONArray("include_peers").length())
        val ch = j.show(view, other, ScheduledQueue(b) { 1000L })
        assertTrue(ch.folders)
        assertEquals(listOf(11L, -21L), other.folders.all().single().included)
        assertEquals(listOf(-21L), other.folders.all().single().pinned)
        assertTrue(other.isArchived(-21L))
        assertFalse(j.hasUnresolved)
        val after = j.objects("FOLDER", folderShown, other, ScheduledQueue(b) { 1000L })!!.getJSONObject(0).getJSONObject("value")
        assertEquals("без повторов", 2, after.getJSONArray("include_peers").length())
    }

    /** T132 (FR-039, правило STATE-2): настройки уведомлений — объекты модели, поля, которых шов не ведёт, не стираются. */
    @Test
    fun notifySettingsRoundTripThroughModel() {
        val a = tmp()
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val mine = StateJournal.NotifyView(
            JSONObject().put("groups", JSONObject().put("mutedUntil", 2147483647L)),
            JSONObject().put("bob@local", JSONObject().put("mutedUntil", 1900000000L)))
        val view = viewOf(j, ChatLocalState(a), ScheduledQueue(a) { 1000L }, emptySet(), mine)
        val entry = valueOf(view, "PEER_NOTIFY", "u:bob@local")!!
        assertEquals("bob@local", entry.getJSONObject("peer").getJSONObject("user").getString("address"))
        assertEquals("1900000000000", entry.getJSONObject("settings").getString("mute_until_ms"))
        val defaults = valueOf(view, "NOTIFY_DEFAULTS", "")!!
        assertEquals("2147483647000", defaults.getJSONObject("groups").getString("mute_until_ms"))
        assertFalse("умолчание, которого нет ни у шва, ни в модели, не выдумывается", defaults.has("users"))

        // Другое «устройство» без настроек: модель → блоб для applyNotifyBlob
        val b = tmp()
        val other = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val empty = StateJournal.NotifyView(JSONObject(), JSONObject())
        val ch = other.show(view, ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), empty)
        assertEquals(1900000000L, ch.notify!!.getJSONObject("exceptions").getJSONObject("bob@local").getLong("mutedUntil"))
        assertEquals(2147483647L, ch.notify!!.getJSONObject("defaults").getJSONObject("groups").getLong("mutedUntil"))
        // То же состояние — изменений нет; без настроек (null) показ их не трогает
        assertFalse(other.show(view, ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), mine).any())
        assertFalse(other.show(view, ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), null).any())

        // Объект другого клиента с полями, которых шов не ведёт (звук, тихий режим): правка мута их сохраняет
        valueOf(view, "PEER_NOTIFY", "u:bob@local")!!.getJSONObject("settings").put("sound", "chime").put("silent", true)
        val unmuted = StateJournal.NotifyView(JSONObject(), JSONObject().put("bob@local", JSONObject().put("mutedUntil", 0L)))
        val rebuilt = other.objects("PEER_NOTIFY", StateJournal.objectsOf(view, "PEER_NOTIFY"), ChatLocalState(b), ScheduledQueue(b) { 1000L }, emptySet(), unmuted)!!
            .getJSONObject(0).getJSONObject("value").getJSONObject("settings")
        assertEquals("0", rebuilt.getString("mute_until_ms"))
        assertEquals("chime", rebuilt.getString("sound"))
        assertTrue(rebuilt.getBoolean("silent"))

        // Исключение, которого в модели больше нет, снимается
        val gone = other.show(JSONObject().put("objects", JSONArray()), ChatLocalState(b), ScheduledQueue(b) { 1000L }, HashSet(), mine)
        assertEquals(0L, gone.notify!!.getJSONObject("exceptions").getJSONObject("bob@local").getLong("mutedUntil"))
        a.deleteRecursively(); b.deleteRecursively()
    }

    @Test
    fun localStateRoundTripsThroughModelObjects() {
        val a = tmp()
        val local = ChatLocalState(a)
        val queue = ScheduledQueue(a) { 1000L }
        local.folders.create(TdApi.ChatFolder(TdApi.ChatFolderName(TdApi.FormattedText("Работа", arrayOf()), false), null, 3, false,
            longArrayOf(), longArrayOf(11L, -21L), longArrayOf(12L), false, false, true, true, false, true, false, false))
        local.setDraft(11L, JSONObject().put("text", "черновик 🙂").put("date", 1700000000))
        local.setArchived(12L, true)
        queue.add("0192f0e4-1a2b-7c3d-8e4f-001122334455", 11L, "bob@local", JSONObject().put("kind", "text").put("text", "позже"), null, null, 5000L)
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val view = viewOf(j, local, queue, setOf("carol@local"))
        assertEquals(1, StateJournal.objectsOf(view, "BLOCK").length())
        assertEquals(1, StateJournal.objectsOf(view, "FOLDER").length())
        assertEquals(2, valueOf(view, "FOLDER", "3")?.getJSONArray("include_peers")?.length() ?: StateJournal.objectsOf(view, "FOLDER").getJSONObject(0).getJSONObject("value").getJSONArray("include_peers").length())
        assertNotNull(valueOf(view, "DRAFT", "u:bob@local"))
        assertNotNull(valueOf(view, "ARCHIVE", "u:carol@local"))
        assertNotNull("ключ отложенного — hex op_id", valueOf(view, "SCHEDULED", "0192f0e41a2b7c3d8e4f001122334455"))

        // Другое «устройство»: пустые файлы → объекты модели
        val b = tmp()
        val local2 = ChatLocalState(b)
        val queue2 = ScheduledQueue(b) { 1000L }
        val blocked2 = HashSet<String>()
        val ch = j.show(view, local2, queue2, blocked2)
        assertTrue(ch.folders)
        assertEquals(setOf("carol@local"), blocked2)
        val f = local2.folders.all().single()
        assertEquals("Работа", f.title)
        assertEquals(listOf(11L, -21L), f.included)
        assertEquals(listOf(12L), f.excluded)
        assertTrue(f.includeContacts && f.includeBots)
        assertEquals("черновик 🙂", local2.draftOf(11L)!!.getString("text"))
        assertTrue(local2.isArchived(12L))
        val s = queue2.all().single()
        assertEquals("0192f0e4-1a2b-7c3d-8e4f-001122334455", s.uuid)
        assertEquals("позже", s.content.getString("text"))
        assertEquals(5000L, s.due)
        // Повторный показ того же — изменений нет; время блокировки — показанное (правка его не меняет)
        assertFalse(j.show(view, local2, queue2, blocked2).any())
        val again = j.objects("BLOCK", StateJournal.objectsOf(view, "BLOCK"), local2, queue2, blocked2, nowMs = 1L)!!
        assertEquals("1800000000000", again.getJSONObject(0).getJSONObject("value").getString("blocked_at_ms"))
    }

    @Test
    fun removedInModelLeavesLocalFiles() {
        val a = tmp()
        val local = ChatLocalState(a)
        val queue = ScheduledQueue(a) { 1000L }
        local.setArchived(12L, true)
        queue.add("0192f0e4-1a2b-7c3d-8e4f-001122334466", 11L, "bob@local", JSONObject().put("kind", "text").put("text", "x"), null, null, 5000L)
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        // Модель: архив пуст, отложенное отправлено другим устройством (отметка 1 у объекта без значения)
        val key = "0192f0e41a2b7c3d8e4f001122334466"
        val sent = JSONObject().put("kind", "OBJECT_KIND_SCHEDULED").put("key", key).put("value", JSONObject())
            .put("marks", JSONArray().put(JSONObject().put("field", 1).put("value", "AQ==")))
        val view = JSONObject().put("objects", JSONArray().put(sent))
        val ch = j.show(view, local, queue)
        assertFalse(local.isArchived(12L))
        assertTrue(queue.all().isEmpty())
        assertEquals(1, ch.scheduledRemoved.size)
        // Правка отложенных не снимает отправленное (объект с отметкой остаётся как показан)
        val objs = j.objects("SCHEDULED", StateJournal.objectsOf(view, "SCHEDULED"), local, queue)!!
        assertEquals(key, objs.getJSONObject(0).getString("key"))
        assertEquals(0, objs.getJSONObject(0).getJSONObject("value").length())
    }

    @Test
    fun groupPeersKeepV2AndV1Addresses() {
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val v2 = j.peerOf("v2g:" + "ab".repeat(16))!!
        assertEquals("v2g:" + "ab".repeat(16), j.addressOf(v2))
        assertEquals("g:local:" + "ab".repeat(16), j.peerKeyOf(v2))
        assertEquals("v2g:" + "ab".repeat(16), j.addressOf(j.peerOfKey("g:local:" + "ab".repeat(16))))
        val v1 = j.peerOf("0192f0e4-1a2b-7c3d-8e4f-001122334455")!!
        assertEquals("0192f0e4-1a2b-7c3d-8e4f-001122334455", j.addressOf(v1))
        assertEquals("bob@local", j.addressOf(j.peerOf("bob@local")))
        assertEquals("u:bob@local", j.peerKeyOf(j.peerOf("bob@local")))
    }

    /** Место «Все чаты» (id 0 в FOLDER_ORDER) из модели → `Folders.mainPosition` (по нему X ставит страницу и чип). */
    @Test
    fun allChatsPositionFromModel() {
        val b = tmp()
        val local = ChatLocalState(b)
        val folder = { id: Int, t: String -> JSONObject().put("kind", "OBJECT_KIND_FOLDER").put("key", "$id").put("value", JSONObject().put("id", id).put("title", t)) }
        val order = { ids: List<Int> -> JSONObject().put("kind", "OBJECT_KIND_FOLDER_ORDER").put("key", "").put("value", JSONObject().put("ids", JSONArray(ids))) }
        val viewWith = { ids: List<Int> -> JSONObject().put("objects", JSONArray().put(folder(2, "A")).put(folder(3, "B")).put(order(ids))) }
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val ch = j.show(viewWith(listOf(2, 0, 3)), local, ScheduledQueue(b) { 1000L })
        assertTrue(ch.folders)
        assertEquals(1, local.folders.mainPosition)
        assertEquals(1, j.allFolderAt)
        // только место «Все чаты» сменилось — тоже изменение папок
        assertTrue(j.show(viewWith(listOf(2, 3, 0)), local, ScheduledQueue(b) { 1000L }).folders)
        assertEquals(2, local.folders.mainPosition)
        assertFalse(j.show(viewWith(listOf(2, 3, 0)), local, ScheduledQueue(b) { 1000L }).folders)
        // правка этого устройства сохраняет место; своя перестановка — в следующую правку
        val ids = { o: JSONArray -> o.getJSONObject(0).getJSONObject("value").getJSONArray("ids").let { a -> (0 until a.length()).map { a.getInt(it) } } }
        assertEquals(listOf(2, 3, 0), ids(j.objects("FOLDER_ORDER", JSONArray(), local, ScheduledQueue(b) { 1000L })!!))
        j.noteAllFolderAt(0)
        assertEquals(listOf(0, 2, 3), ids(j.objects("FOLDER_ORDER", JSONArray(), local, ScheduledQueue(b) { 1000L })!!))
        assertEquals(2, ChatLocalState(b).folders.mainPosition) // переживает перезапуск (folders.json)
        // B1 ревью 7 ноя 2026: папок стало меньше места «Все чаты» — id 0 остаётся последним, не пропадает
        j.noteAllFolderAt(2)
        assertTrue(local.folders.delete(3))
        assertEquals(listOf(2, 0), ids(j.objects("FOLDER_ORDER", JSONArray(), local, ScheduledQueue(b) { 1000L })!!))
        assertTrue(local.folders.delete(2))
        assertEquals(listOf(0), ids(j.objects("FOLDER_ORDER", JSONArray(), local, ScheduledQueue(b) { 1000L })!!))
    }

    /** Порт `stateview::setsFor` ядра (Session::stateSubmit): записи `stateSet` вида по желаемому и показанному. */
    private fun setsFor(kind: String, desired: JSONArray, shown: JSONArray): List<JSONObject> {
        val was = LinkedHashMap<String, JSONObject>()
        for (i in 0 until shown.length()) shown.getJSONObject(i).let { was[it.getString("key")] = it.optJSONObject("value") ?: JSONObject() }
        val out = ArrayList<JSONObject>()
        val wanted = HashSet<String>()
        for (i in 0 until desired.length()) {
            val o = desired.getJSONObject(i)
            val key = o.getString("key"); val value = o.getJSONObject("value")
            wanted += key
            val hit = was[key]
            if (hit != null && hit.similar(value)) continue
            val args = JSONObject().put("kind", "OBJECT_KIND_$kind").put("key", key).put("value", value)
            if (hit != null) args.put("base", hit)
            out += args
        }
        was.keys.filter { it !in wanted }.forEach { out += JSONObject().put("kind", "OBJECT_KIND_$kind").put("key", it).put("delete", true) }
        return out
    }

    /**
     * spec 036 (ENGINE-1, T034): через НАСТОЯЩУЮ модель движка (хост ядра, хранилище store_fs): правка устройства A —
     * объекты вида → `stateSet` с показанным; правка другого устройства, сведённая моделью после показа, не
     * откатывается устаревшей копией A (разница по полям от показанного — в модели); показ `viewStateJson` → B.
     */
    @Test
    fun editsGoThroughEngineModelWithShownBase() {
        val dir = Files.createTempDirectory("pv-state-model").toFile()
        val cfg = JSONObject().put("user", "alice@local").put("device_id", "d1").put("domain", "local").put("features", JSONArray())
            .put("now_ms", "1800000000000").put("vectors", true)
            .put("device_key", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=") // ключ хранилища модели — выдуманный [7; 32]
        EngineHost.open(cfg, java.io.File(dir, "store").path).use { host ->
            val view = { JSONObject(host.read("viewStateJson", JSONObject().put("kinds", JSONArray())).toString()) }
            val submit = { j: StateJournal, edited: String, local: ChatLocalState, queue: ScheduledQueue, shownView: JSONObject? ->
                for (kind in StateJournal.kindsOf(edited)) {
                    val shown = StateJournal.objectsOf(shownView, kind)
                    val desired = j.objects(kind, shown, local, queue) ?: continue
                    for (args in setsFor(kind, desired, shown)) {
                        val st = host.step("stateSet", args)
                        assertFalse("stateSet $kind: $st", st.has("error"))
                    }
                }
            }
            val a = tmp(); val la = ChatLocalState(a); val qa = ScheduledQueue(a) { 1000L }
            val ja = StateJournal(ParvaneProtocol.stateCodec, resolver())
            la.folders.create(TdApi.ChatFolder(TdApi.ChatFolderName(TdApi.FormattedText("Работа", arrayOf()), false), null, 3, false,
                longArrayOf(), longArrayOf(11L), longArrayOf(), false, false, false, false, false, false, false, false))
            la.setPinned(11L, true)
            la.setDraft(12L, JSONObject().put("text", "набросок").put("date", 1700000000))
            submit(ja, "folders", la, qa, null); submit(ja, "pinned", la, qa, null); submit(ja, "drafts", la, qa, null)
            val shownA = view()
            assertEquals(1, StateJournal.objectsOf(shownA, "FOLDER").length())

            // Устройство B показывает модель: папка, закреп, черновик
            val b = tmp(); val lb = ChatLocalState(b); val qb = ScheduledQueue(b) { 1000L }
            val jb = StateJournal(ParvaneProtocol.stateCodec, resolver())
            jb.show(shownA, lb, qb)
            assertEquals("Работа", lb.folders.all().single().title)
            assertEquals(listOf(11L), lb.pinnedChatIds())
            assertEquals("набросок", lb.draftOf(12L)!!.getString("text"))

            // B переименовывает папку; A (показ устарел) правит в ней состав — название B не откатывается
            lb.folders.replaceAll(listOf(lb.folders.all().single().let { f ->
                Folders.Folder(f.id, "Дела", f.icon, f.colorId, f.pinned, f.included, f.excluded, f.excludeMuted, f.excludeRead,
                    f.excludeArchived, f.includeContacts, f.includeNonContacts, f.includeBots, f.includeGroups, f.includeChannels)
            }))
            submit(jb, "folders", lb, qb, shownA)
            la.folders.replaceAll(listOf(la.folders.all().single().let { f ->
                Folders.Folder(f.id, f.title, f.icon, f.colorId, f.pinned, listOf(11L, 12L), f.excluded, f.excludeMuted, f.excludeRead,
                    f.excludeArchived, f.includeContacts, f.includeNonContacts, f.includeBots, f.includeGroups, f.includeChannels)
            }))
            submit(ja, "folders", la, qa, shownA)
            val merged = view()
            val folder = StateJournal.objectsOf(merged, "FOLDER").getJSONObject(0).getJSONObject("value")
            assertEquals("название с B не откатилось", "Дела", folder.getString("title"))
            assertEquals("состав с A", 2, folder.getJSONArray("include_peers").length())

            // Снятие закрепа на A — объект закрепа без собеседников; черновик снят — объект удалён
            la.setPinned(11L, false); la.setDraft(12L, null)
            submit(ja, "pinned", la, qa, merged); submit(ja, "drafts", la, qa, merged)
            val last = view()
            val ch = jb.show(last, lb, qb)
            assertTrue(lb.pinnedChatIds().isEmpty())
            assertEquals(null, lb.draftOf(12L))
            assertEquals(setOf(12L), ch.drafts)
            assertEquals(listOf(11L, 12L), lb.folders.all().single().included)
            assertEquals("Дела", lb.folders.all().single().title)
            a.deleteRecursively(); b.deleteRecursively()
        }
        dir.deleteRecursively()
    }
}
