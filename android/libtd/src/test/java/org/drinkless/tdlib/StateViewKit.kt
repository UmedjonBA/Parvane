package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject

/**
 * Тестовая модель без сведения (spec 036): объекты видов шва ([StateJournal.objects]) как есть — в форме ответа
 * `viewStateJson` ({objects: [{kind, key, value, marks}]}). Сведение и разница по полям — в настоящей модели
 * (StateJournalTest.editsGoThroughEngineModelWithShownBase).
 */
private val VIEW_KINDS = listOf("FOLDER", "FOLDER_ORDER", "BLOCK", "PEER_NOTIFY", "NOTIFY_DEFAULTS", "DRAFT", "SCHEDULED", "ARCHIVE",
    "PIN_LIST", "UNREAD_MARK", "QUICK_REACTION", "STICKER_PACK", "SAVED_GIF", "CONTACT")

fun StateJournal.viewOf(local: ChatLocalState, queue: ScheduledQueue, blocked: Set<String> = emptySet(),
                        notify: StateJournal.NotifyView? = null, packs: PackJournal? = null, shown: JSONObject? = null): JSONObject {
    val objects = JSONArray()
    for (kind in VIEW_KINDS) {
        val list = objects(kind, StateJournal.objectsOf(shown, kind), local, queue, blocked, notify, packs, nowMs = 1_800_000_000_000L) ?: continue
        for (i in 0 until list.length()) {
            val o = list.getJSONObject(i)
            objects.put(JSONObject().put("kind", "OBJECT_KIND_$kind").put("key", o.getString("key")).put("value", o.getJSONObject("value"))
                .put("marks", JSONArray()))
        }
    }
    return JSONObject().put("objects", objects)
}

/** Значения объектов вида [kind] по порядку. */
fun valuesOf(view: JSONObject, kind: String): JSONArray = JSONArray().also { a ->
    val list = StateJournal.objectsOf(view, kind)
    for (i in 0 until list.length()) a.put(list.getJSONObject(i).getJSONObject("value"))
}

/** Вид с объектами STICKER_PACK/SAVED_GIF из записей наборов (как их отдала бы модель). */
fun packsView(records: JSONArray): JSONObject = JSONObject().put("objects", JSONArray().also { a ->
    for (i in 0 until records.length()) {
        val r = records.getJSONObject(i)
        val key = r.optString("set_id")
        a.put(JSONObject().put("kind", if (key.startsWith("g:")) "OBJECT_KIND_SAVED_GIF" else "OBJECT_KIND_STICKER_PACK").put("key", key).put("value", r))
    }
})
