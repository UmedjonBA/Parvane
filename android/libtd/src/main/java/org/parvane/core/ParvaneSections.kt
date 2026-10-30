package org.parvane.core

import org.json.JSONObject

/**
 * Parvane: данные разделов «План», «Здоровье», «Знания», «Облако» (spec 031) — логика в ядре (порт web с тестами),
 * один рабочий поток ядра. Экраны: [show] при открытии раздела, снимки — [snapshot] по событию `sections_snapshot`
 * (domain: planner | notes | cloud). Правки «Плана» — новым состоянием целиком (web-JSON), разницу считает ядро.
 * Вызовы с ответом блокирующие — с io-потока.
 */
object ParvaneSections {
    init {
        ParvaneCore
    }

    /** chats | calendar | health | knowledge | files */
    fun show(section: String) = nativeShow(section)
    fun setVisible(visible: Boolean) = nativeVisible(visible)
    fun snapshot(domain: String): JSONObject? = nativeSnapshot(domain).takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    fun plannerReplace(stateJson: String, notice: String = ""): Boolean = nativePlannerReplace(stateJson, notice)
    fun plannerUndo(notice: String) = nativePlannerUndo(notice)
    /** Метод провайдера облака по имени web (`parvaneCloud*`); null — отказ. */
    fun cloudCall(method: String, argsJson: String): Any? = nativeCloudCall(method, argsJson).let { org.json.JSONTokener(it).nextValue() }
        .takeIf { it != JSONObject.NULL }
    /** Операция заметок: create, save, saveOrRestore, rename, delete, move, freeTitle, createFolder, renameFolder,
     *  deleteFolder, saveCanvas, renameCanvas, deleteCanvas, openDaily, readDaily, restoreGuide, consumeGuideOpen,
     *  applyPlanner, saveChatFiles, refresh. */
    fun notes(op: String, argsJson: String = "{}"): Any? = nativeNotes(op, argsJson).let { org.json.JSONTokener(it).nextValue() }
        .takeIf { it != JSONObject.NULL }

    /** «План»/«Здоровье»: запрос (days, undated, lists, settings, health, monthGrid, week, quickParse, stats, slots) либо
     *  правка (quickAdd, taskDone, stepDone, status, move, save, remove, food, removeFood, water, removeHealth, goals,
     *  healthGoals, settings, list) — логика ядра; правка с `notice` даёт «Отменить». */
    fun planner(op: String, args: JSONObject = JSONObject()): Any? = nativePlanner(op, args.toString())
        .let { org.json.JSONTokener(it).nextValue() }.takeIf { it != JSONObject.NULL }

    /** Файлы «Облака»: upload (path, name, mime, container, parent), download (container, node, out), thumb,
     *  createFolder, rename, trash/restore/purge (nodes), move, shareFolder, unshareFolder, links, linkCreate,
     *  linkRevoke, linkExtend. Блокирующий — с io-потока. */
    fun cloudFiles(op: String, args: JSONObject = JSONObject()): Any? = nativeCloudFiles(op, args.toString())
        .let { org.json.JSONTokener(it).nextValue() }.takeIf { it != JSONObject.NULL }

    /** Выгрузка данных в ZIP по пути `outPath` (meta — chats, selfName, contacts, labels, includeMedia, includeCloud,
     *  drive). Блокирующий; ход — событие `export_progress`. */
    fun exportData(meta: JSONObject, outPath: String): JSONObject = JSONObject(nativeExportData(meta.toString(), outPath))
    fun exportCancel() = nativeExportCancel()

    @JvmStatic private external fun nativeExportData(metaJson: String, outPath: String): String
    @JvmStatic private external fun nativeExportCancel()
    @JvmStatic private external fun nativeCloudFiles(op: String, argsJson: String): String
    @JvmStatic private external fun nativePlanner(op: String, argsJson: String): String
    @JvmStatic private external fun nativeShow(section: String)
    @JvmStatic private external fun nativeVisible(visible: Boolean)
    @JvmStatic private external fun nativeSnapshot(domain: String): String
    @JvmStatic private external fun nativePlannerReplace(stateJson: String, notice: String): Boolean
    @JvmStatic private external fun nativePlannerUndo(notice: String)
    @JvmStatic private external fun nativeCloudCall(method: String, argsJson: String): String
    @JvmStatic private external fun nativeNotes(op: String, argsJson: String): String
}
