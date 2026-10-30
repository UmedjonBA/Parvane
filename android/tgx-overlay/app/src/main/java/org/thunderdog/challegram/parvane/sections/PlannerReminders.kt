package org.thunderdog.challegram.parvane.sections

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import org.parvane.core.ParvanePush
import org.thunderdog.challegram.R
import java.util.TimeZone

/**
 * Parvane (spec 031, T051): напоминания «Плана» на телефоне. Ближайшие (месяц, до 64) — будильники AlarmManager
 * с текстом на устройстве; серверу (`push.alarm.set`) — только моменты пробуждения, чтобы UnifiedPush разбудил
 * приложение и без постоянной службы. Сработавшее отмечается в «Плане» (`reminded`, общее для всех устройств) —
 * второе устройство уже не напомнит. Наступившие, пока телефон спал, показываются при следующей загрузке «Плана».
 * Моменты ядра — «настенные» (день и время без пояса), здесь переводятся в настоящие по местной зоне.
 */
object PlannerReminders {
    private const val PREFS = "parvane_reminders"
    private const val CHANNEL = "parvane_reminders"
    private const val ACTION = "org.parvane.REMINDER"
    private lateinit var ctx: Context
    private var lastAlarms = ""

    fun init(context: Context) {
        ctx = context.applicationContext
        Sx.watch("planner") { snap -> if (snap.optString("status") == "ready") refresh() }
    }

    private fun prefs() = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun realMs(wall: Long): Long {
        val tz = TimeZone.getDefault()
        val guess = wall - tz.getOffset(wall)
        return wall - tz.getOffset(guess)
    }

    private fun refresh(): Unit = Sx.planner("reminders") { r ->
        val plan = r as? JSONObject ?: return@planner
        val shown = prefs().getStringSet("shown", emptySet())!!.toMutableSet()
        // наступившие: уже показанные будильником — только отметить; остальные — показать и отметить
        val due = Sx.list(plan.optJSONArray("due"))
        due.filter { it.optString("key") !in shown }.forEach { notify(ctx, it.optString("key"), it.optString("title"), it.optString("start")) }
        if (due.isNotEmpty()) Sx.planner("markReminded", JSONObject().put("keys", JSONArray(due.map { it.optString("key") })))
        shown.retainAll(Sx.list(plan.optJSONArray("upcoming")).map { it.optString("key") }.toSet())
        prefs().edit().putStringSet("shown", shown).apply()
        schedule(Sx.list(plan.optJSONArray("upcoming")))
    }

    private fun schedule(upcoming: List<JSONObject>) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val now = System.currentTimeMillis()
        val keys = mutableSetOf<String>()
        val moments = mutableListOf<Long>()
        upcoming.forEach { r ->
            val at = realMs(r.optLong("at"))
            if (at <= now) return@forEach
            val key = r.optString("key")
            keys += key
            moments += at
            val pi = pending(key, r.optString("title"), r.optString("start"), PendingIntent.FLAG_UPDATE_CURRENT) ?: return@forEach
            try {
                if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
                else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            } catch (e: SecurityException) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            }
        }
        // снятые и перенесённые напоминания — отменить
        prefs().getStringSet("scheduled", emptySet())!!.filter { it !in keys }.forEach { key ->
            pending(key, "", "", PendingIntent.FLAG_NO_CREATE)?.let { am.cancel(it) }
        }
        prefs().edit().putStringSet("scheduled", keys).apply()
        val alarms = moments.sorted().take(64).joinToString(",")
        if (alarms != lastAlarms) {
            lastAlarms = alarms
            Sx.async({ ParvanePush.setAlarms(moments.sorted().take(64)) }) { }
        }
    }

    private fun pending(key: String, title: String, start: String, flags: Int): PendingIntent? {
        val code = requestCode(key)
        val intent = Intent(ctx, ParvaneReminderReceiver::class.java).setAction(ACTION).putExtra("key", key)
            .putExtra("title", title).putExtra("start", start).putExtra("rc", code)
        return PendingIntent.getBroadcast(ctx, code, intent, flags or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Свой номер на каждый ключ (hashCode двух ключей может совпасть — тогда они делили бы будильник и уведомление). */
    private fun requestCode(key: String): Int {
        val p = prefs()
        if (p.contains("rc:$key")) return p.getInt("rc:$key", 0)
        val next = p.getInt("rc_next", 1)
        p.edit().putInt("rc:$key", next).putInt("rc_next", next + 1).apply()
        return next
    }

    fun notify(context: Context, key: String, title: String, start: String, notificationId: Int = key.hashCode()) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val ru = java.util.Locale.getDefault().language == "ru"
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, if (ru) "Напоминания «Плана»" else "Plan reminders", NotificationManager.IMPORTANCE_HIGH))
        val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
            PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        val n = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.mipmap.app_notification)
            .setContentTitle(title)
            .setContentText(if (start.isNotEmpty() && start != "null") (if (ru) "Начало в $start" else "Starts at $start") else (if (ru) "Напоминание" else "Reminder"))
            .setAutoCancel(true)
            .apply { open?.let { setContentIntent(it) } }
            .build()
        nm.notify(notificationId, n)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).let { p ->
            p.edit().putStringSet("shown", (p.getStringSet("shown", emptySet())!! + key)).apply()
        }
    }
}

/** Будильник напоминания: текст — из самого будильника (ядро и сессия могут быть ещё не подняты). */
class ParvaneReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val key = intent.getStringExtra("key") ?: return
        PlannerReminders.notify(context, key, intent.getStringExtra("title") ?: "", intent.getStringExtra("start") ?: "",
            intent.getIntExtra("rc", key.hashCode()))
    }
}
