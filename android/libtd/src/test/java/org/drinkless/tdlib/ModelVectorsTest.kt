package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.parvane.core.EngineHost
import org.parvane.core.ParvaneProtocol
import java.io.File
import java.nio.file.Files

/**
 * spec 035 T130 (contracts/engine-api.md «Векторы»): векторы модели движка `proto/parvane/vectors/model/*.json` через
 * JNI → хост ядра `parvane::engine::Host` (тот же, что desktop `model_vectors_tests.cpp`) над НАСТОЯЩИМ файловым
 * хранилищем `store_fs` во временном каталоге. Тот же прогон, что `cargo test -p parvane-protocol --test
 * model_vectors`, web `modelVectors.test.ts`, ctest ядра `model_vectors`.
 *
 * Шаг вектора — `submit` / `input` (`vectorInput`) / чтение. Ожидания шага: `changes` — изменения модели по порядку
 * (каждое — подмножество фактического), `requests` — методы запросов по порядку, `puts` — виды записей, которые
 * обязаны быть в пачке, `error` — вид ошибки, `result` — подмножество ответа чтения. Ревизия растёт на 1 с каждым
 * непустым изменением. После «перезапуска» (новый хост над тем же каталогом) профиль открывается READY — пачки на диске.
 * Плюс критичность номером вида (`content/critical`, `model/critical_journal`) — через C ABI векторов.
 */
class ModelVectorsTest {
    private val vectors = File(System.getProperty("parvane.vectors.dir") ?: "../../proto/parvane/vectors")

    private val suites = listOf(
        "send_direct", "delete_everyone_direct", "delete_me", "edit_before_row", "state_patch_folder",
        "group_perms_media", "unknown_content_stub", "features_text_fallback", "history_paging", "fave_sticker",
    )

    /** Отсутствие в proto3-JSON: поле опущено либо умолчание. */
    private fun absent(v: Any?): Boolean = when (v) {
        null, JSONObject.NULL -> true
        is Boolean -> !v
        is String -> v.isEmpty() || v == "0"
        is JSONArray -> v.length() == 0
        is JSONObject -> v.length() == 0
        is Number -> v.toDouble() == 0.0
        else -> false
    }

    private fun same(a: Any?, b: Any?): Boolean = when {
        a is JSONObject && b is JSONObject -> a.similar(b)
        a is JSONArray && b is JSONArray -> a.similar(b)
        a is Number && b is Number -> a.toDouble() == b.toDouble()
        else -> a == b
    }

    /** Ожидаемое — подмножество фактического; `null` — поле отсутствует; строка "$имя" — переменная. */
    private fun matches(exp: Any?, act: Any?, vars: MutableMap<String, Any?>, path: String, why: StringBuilder): Boolean {
        if (exp == null || exp == JSONObject.NULL) {
            if (absent(act)) return true
            why.append("$path: ожидалось отсутствие, есть $act"); return false
        }
        if (exp is String && exp.startsWith("$")) {
            if (!vars.containsKey(exp)) { vars[exp] = act; return true }
            if (same(vars[exp], act)) return true
            why.append("$path: $exp = ${vars[exp]}, а здесь $act"); return false
        }
        if (exp is JSONObject) {
            for (k in exp.keys()) {
                val a = (act as? JSONObject)?.opt(k)
                if (!matches(exp.get(k), a, vars, "$path.$k", why)) return false
            }
            return true
        }
        if (exp is JSONArray) {
            val a = act as? JSONArray ?: JSONArray()
            if (a.length() != exp.length()) { why.append("$path: длина ${a.length()} вместо ${exp.length()} — $act"); return false }
            for (i in 0 until exp.length()) if (!matches(exp.get(i), a.get(i), vars, "$path[$i]", why)) return false
            return true
        }
        if (exp is Number) {
            val ok = when (act) {
                is Number -> act.toDouble() == exp.toDouble()
                is String -> act.toDoubleOrNull() == exp.toDouble()
                else -> false
            }
            if (!ok) why.append("$path: $act вместо $exp")
            return ok
        }
        if (exp == act) return true
        why.append("$path: $act вместо $exp"); return false
    }

    private val failures = ArrayList<String>()
    private fun check(ok: Boolean, msg: () -> String) { if (!ok) failures += msg() }

    private fun runCase(suite: String, c: JSONObject) {
        val name = "$suite / ${c.optString("name")}"
        val cfg = JSONObject(c.getJSONObject("config").toString()).put("vectors", true)
        if (!cfg.has("device_key")) cfg.put("device_key", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=") // [7; 32]
        val root = Files.createTempDirectory("pv-model-vectors").toFile()
        val dir = File(root, "store").path
        try {
            val host = try { EngineHost.open(cfg, dir) } catch (e: IllegalStateException) { check(false) { "$name: ${e.message}" }; return }
            val vars = HashMap<String, Any?>()
            var revision = host.revision
            host.use {
                val steps = c.getJSONArray("steps")
                for (i in 0 until steps.length()) {
                    val at = "$name шаг $i"
                    val step = steps.getJSONObject(i)
                    val exp = step.optJSONObject("expect") ?: JSONObject()
                    val key = step.keys().asSequence().first { it != "expect" }
                    val args = step.get(key)
                    val call = if (key == "input") "vectorInput" else key
                    val why = StringBuilder()
                    if (exp.has("error")) {
                        val out = host.raw(call, args)
                        check(out.optString("error") == exp.getString("error")) { "$at: ожидалась ошибка ${exp.get("error")}, ответ $out" }
                        continue
                    }
                    if (exp.has("result")) {
                        val out = host.read(call, args)
                        check(!out.has("error")) { "$at: ошибка $out" }
                        check(matches(exp.get("result"), out, vars, at, why)) { "$why\nответ: $out" }
                        continue
                    }
                    val st = host.step(call, args)
                    if (st.has("error")) { check(false) { "$at: ошибка ${st.optString("error")}" }; continue }
                    val revs = st.optJSONArray("revisions") ?: JSONArray()
                    for (r in 0 until revs.length()) {
                        val rv = revs.get(r).toString().toLong()
                        check(rv == revision + 1) { "$at: ревизия растёт на 1 ($revision → $rv)" }
                        revision = rv
                    }
                    if (exp.has("changes")) {
                        val changes = st.optJSONArray("changes") ?: JSONArray()
                        check(matches(exp.get("changes"), changes, vars, "$at changes", why)) { "$why\nизменения: ${changes.toString(1)}" }
                    }
                    if (exp.has("requests")) {
                        val reqs = st.optJSONArray("requests") ?: JSONArray()
                        val methods = JSONArray().also { m -> for (r in 0 until reqs.length()) m.put(reqs.getJSONObject(r).optString("method")) }
                        check(methods.similar(exp.getJSONArray("requests"))) { "$at: запросы $methods вместо ${exp.get("requests")}" }
                    }
                    exp.optJSONArray("puts")?.let { puts ->
                        val kinds = st.optJSONArray("put_kinds") ?: JSONArray()
                        val have = (0 until kinds.length()).map { kinds.getString(it) }.toSet()
                        for (p in 0 until puts.length()) check(puts.getString(p) in have) { "$at: в пачке нет ${puts.getString(p)} ($kinds)" }
                    }
                }
            }
            // Перезапуск над тем же каталогом: профиль открывается из того, что записано на диск
            EngineHost.open(cfg, dir).use { again ->
                check(again.opened.optString("state") == "OPEN_STATE_READY") { "$name: после перезапуска READY: ${again.opened}" }
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun modelVectorsThroughJniHost() {
        var cases = 0
        for (s in suites) {
            val v = JSONObject(File(vectors, "model/$s.json").readText())
            assertEquals("suite $s", "model/$s", v.getString("suite"))
            val list = v.getJSONArray("cases")
            for (i in 0 until list.length()) { runCase(s, list.getJSONObject(i)); cases++ }
        }
        if (failures.isNotEmpty()) fail("векторы модели: ${failures.size} расхождений\n" + failures.joinToString("\n"))
        assertTrue("векторов модели: $cases", cases >= 13)
    }

    /** Критичность номером вида (US5): показ заглушки «обновите приложение» и закрытие журнала для записи. */
    @Test
    fun criticalVectorsThroughCAbi() {
        for ((suite, file, least) in listOf(Triple("content/critical", "content/critical.json", 7), Triple("model/critical_journal", "model/critical_journal.json", 4))) {
            val n = ParvaneProtocol.runConformanceVectors(suite, File(vectors, file).readText())
            assertTrue("$suite: $n случаев", n >= least)
        }
    }

    /** Каждый набор `model/` либо в прогоне выше, либо в своём (критичность): новый набор не теряется. */
    @Test
    fun everyModelSuiteIsRun() {
        val known = suites.toSet() + "critical_journal"
        val files = File(vectors, "model").listFiles { f -> f.name.endsWith(".json") }!!.map { it.name.removeSuffix(".json") }
        assertEquals("наборы model/ без прогона в android", emptyList<String>(), files.filter { it !in known }.sorted())
    }
}
