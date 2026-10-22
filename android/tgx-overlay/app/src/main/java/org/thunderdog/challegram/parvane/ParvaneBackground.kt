package org.thunderdog.challegram.parvane

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import org.parvane.core.ParvaneCore
import org.parvane.core.ParvanePush
import org.thunderdog.challegram.R
import org.thunderdog.challegram.telegram.TdlibManager
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.Executors

/**
 * Parvane (spec 031): работа в фоне без Firebase.
 * - Есть распространитель UnifiedPush (ntfy и др.) — регистрируемся у него по протоколу UnifiedPush (AND_2/AND_3),
 *   а адрес пробуждения отдаём серверу видом WEB_PUSH со своими ключами p256dh/auth: сервер шифрует пустое
 *   пробуждение (RFC 8291), содержимое не нужно — пробуждение само по себе сигнал. На пробуждение приложение на
 *   ~40 с поднимает сессию (служба переднего плана), забирает новое и показывает уведомления.
 * - Распространителя нет — постоянная служба связи «Parvane на связи» держит сессию.
 * Сервер видит только адрес распространителя и моменты пробуждения — ни собеседника, ни текста.
 */
object ParvaneBackground {
    private const val TAG = "ParvaneBackground"
    private const val PREFS = "parvane_background"
    const val ACTION_REGISTER = "org.unifiedpush.android.distributor.REGISTER"
    const val ACTION_UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER"
    private const val WAKE_HOLD_MS = 40_000L
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "parvane-background") }
    private lateinit var ctx: Context
    @Volatile private var sessionReady = false

    fun init(context: Context) {
        ctx = context.applicationContext
        ParvaneCore.addListener { event ->
            when (event.optString("type")) {
                "session" -> if (event.optString("state") == "ready") { sessionReady = true; io.execute { ensureChannel() } }
                "state_ready" -> io.execute { ensureChannel() }
            }
        }
    }

    private fun prefs() = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Пакеты распространителей UnifiedPush на устройстве. */
    fun distributors(): List<String> = ctx.packageManager
        .queryBroadcastReceivers(Intent(ACTION_REGISTER), 0)
        .map { it.activityInfo.packageName }.distinct().filter { it != ctx.packageName }

    /** Режим: «unifiedpush» (выбран распространитель) или «service» (постоянная служба). */
    fun mode(): String = prefs().getString("mode", null) ?: if (distributors().isNotEmpty()) "unifiedpush" else "service"

    fun setMode(mode: String) {
        prefs().edit().putString("mode", mode).apply()
        io.execute { ensureChannel() }
    }

    /** Канал пробуждения по режиму: регистрация у распространителя или постоянная служба. */
    private fun ensureChannel() {
        if (!sessionReady) return
        if (prefs().getString("mode", null) == null) prefs().edit().putString("mode", mode()).apply()
        if (mode() == "unifiedpush" && distributors().isNotEmpty()) {
            ParvaneLinkService.stop(ctx)
            registerUnifiedPush()
        } else {
            unregisterUnifiedPush()
            ParvaneLinkService.startPersistent(ctx)
        }
    }

    private fun instanceToken(): String = prefs().getString("token", null)
        ?: java.util.UUID.randomUUID().toString().also { prefs().edit().putString("token", it).apply() }

    /** Токен регистрации наш; debug: «parvane-e2e» — сценарий эмулятора подаёт события распространителя через adb. */
    private fun ownToken(token: String) =
        token == instanceToken() || (org.thunderdog.challegram.BuildConfig.DEBUG && token == "parvane-e2e")

    private fun registerUnifiedPush() {
        val distributor = prefs().getString("distributor", null)?.takeIf { it in distributors() } ?: distributors().first()
        prefs().edit().putString("distributor", distributor).apply()
        val vapid = try { ParvanePush.describe().optString("vapid") } catch (e: Throwable) { "" }
        val intent = Intent(ACTION_REGISTER).setPackage(distributor)
            .putExtra("token", instanceToken())
            .putExtra("application", ctx.packageName)
            .putExtra("message", "Parvane")
            .putExtra("features", arrayOf("org.unifiedpush.android.distributor.feature.BYTES_MESSAGE"))
            // AND_3: распространитель узнаёт приложение по PendingIntent; vapid — ключ сервера (base64url без =)
            .putExtra("pi", PendingIntent.getBroadcast(ctx, 0, Intent("org.unifiedpush.dummy_app"), PendingIntent.FLAG_IMMUTABLE))
        if (vapid.isNotEmpty()) intent.putExtra("vapid", toBase64Url(Base64.decode(vapid, Base64.DEFAULT)))
        ctx.sendBroadcast(intent)
        Log.i(TAG, "UnifiedPush: регистрация у распространителя")
    }

    private fun unregisterUnifiedPush() {
        val distributor = prefs().getString("distributor", null) ?: return
        ctx.sendBroadcast(Intent(ACTION_UNREGISTER).setPackage(distributor).putExtra("token", instanceToken()))
        prefs().getString("endpoint", null)?.let { ep -> io.execute { ParvanePush.unregister(ep) } }
        prefs().edit().remove("endpoint").remove("distributor").apply()
    }

    /** Ключи WEB_PUSH устройства: P-256 (несжатая точка, 65 байт) и auth (16 байт); хранятся в настройках. */
    private fun webPushKeys(): Pair<String, String> {
        val p = prefs()
        p.getString("p256dh", null)?.let { k -> p.getString("auth", null)?.let { a -> return k to a } }
        val kpg = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
        val pub = kpg.generateKeyPair().public as ECPublicKey
        fun fixed(b: java.math.BigInteger): ByteArray {
            val raw = b.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
            return ByteArray(32 - raw.size) + raw
        }
        val point = byteArrayOf(4) + fixed(pub.w.affineX) + fixed(pub.w.affineY)
        val auth = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val k = Base64.encodeToString(point, Base64.NO_WRAP)
        val a = Base64.encodeToString(auth, Base64.NO_WRAP)
        p.edit().putString("p256dh", k).putString("auth", a).apply()
        return k to a
    }

    /** Распространитель выдал адрес — отдать серверу (видом WEB_PUSH). */
    fun onNewEndpoint(token: String, endpoint: String) {
        if (!ownToken(token) || endpoint.isEmpty()) return
        prefs().edit().putString("endpoint", endpoint).apply()
        io.execute {
            val (k, a) = webPushKeys()
            val r = try { ParvanePush.register(ParvanePush.KIND_WEB_PUSH, endpoint, k, a) } catch (e: Throwable) { JSONObject().put("ok", false) }
            Log.i(TAG, "UnifiedPush: адрес ${if (r.optBoolean("ok")) "зарегистрирован" else "не принят сервером (${r.optString("error_code")})"}")
            if (!r.optBoolean("ok")) ParvaneLinkService.startPersistent(ctx) // запасной путь
        }
    }

    /** Пробуждение от сервера: поднять сессию ненадолго (служба переднего плана), забрать новое. */
    fun onWake(token: String) {
        if (!ownToken(token)) return
        Log.i(TAG, "пробуждение")
        ParvaneLinkService.startWake(ctx, WAKE_HOLD_MS)
    }

    fun onUnregistered(token: String) {
        if (!ownToken(token)) return
        prefs().edit().remove("endpoint").apply()
        Log.i(TAG, "UnifiedPush: распространитель снял регистрацию — постоянная служба")
        ParvaneLinkService.startPersistent(ctx)
    }

    private fun toBase64Url(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE)
}

/** После перезагрузки телефона — снова на связи (режим службы; у UnifiedPush распространитель разбудит сам). */
class ParvaneBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != "android.intent.action.MY_PACKAGE_REPLACED") return
        val mode = context.getSharedPreferences("parvane_background", Context.MODE_PRIVATE).getString("mode", null)
        if (mode == "service") ParvaneLinkService.startPersistent(context)
    }
}

/** Сообщения распространителя UnifiedPush (протокол AND_2/AND_3). */
class ParvaneUnifiedPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val token = intent.getStringExtra("token") ?: return
        when (intent.action) {
            "org.unifiedpush.android.connector.NEW_ENDPOINT" -> ParvaneBackground.onNewEndpoint(token, intent.getStringExtra("endpoint") ?: "")
            "org.unifiedpush.android.connector.MESSAGE" -> ParvaneBackground.onWake(token)
            "org.unifiedpush.android.connector.UNREGISTERED" -> ParvaneBackground.onUnregistered(token)
            "org.unifiedpush.android.connector.REGISTRATION_FAILED" -> ParvaneBackground.onUnregistered(token)
        }
    }
}

/** Служба связи: постоянная («Parvane на связи») либо на время пробуждения; держит аккаунт X активным. */
class ParvaneLinkService : Service() {
    companion object {
        private const val CHANNEL = "parvane_link"
        private const val ID = 0x5076
        private const val EXTRA_HOLD = "hold_ms"
        @Volatile private var persistent = false

        fun startPersistent(ctx: Context) {
            persistent = true
            start(ctx, 0L)
        }

        fun startWake(ctx: Context, holdMs: Long) = start(ctx, holdMs)

        private fun start(ctx: Context, holdMs: Long) {
            val i = Intent(ctx, ParvaneLinkService::class.java).putExtra(EXTRA_HOLD, holdMs)
            try {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (e: Throwable) {
                Log.w("ParvaneBackground", "служба связи не запущена: ${e.message}")
            }
        }

        fun stop(ctx: Context) {
            persistent = false
            ctx.stopService(Intent(ctx, ParvaneLinkService::class.java))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var holding = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val ru = java.util.Locale.getDefault().language == "ru"
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, if (ru) "Связь с сервером" else "Server connection", NotificationManager.IMPORTANCE_MIN))
        val n: Notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.app_notification)
            .setContentTitle(if (persistent) (if (ru) "Parvane на связи" else "Parvane is connected") else (if (ru) "Parvane получает сообщения" else "Parvane is fetching messages"))
            .setOngoing(true).setShowWhen(false).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(ID, n)
        if (!holding) {
            holding = true
            TdlibManager.instance().current().incrementUiReferenceCount() // аккаунт X не засыпает, шов держит сессию
            ParvaneCore.networkAvailable()
        }
        val hold = intent?.getLongExtra(EXTRA_HOLD, 0L) ?: 0L
        handler.removeCallbacksAndMessages(null)
        if (!persistent && hold > 0) handler.postDelayed({ stopSelf() }, hold)
        return if (persistent) START_STICKY else START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (holding) {
            holding = false
            TdlibManager.instance().current().decrementUiReferenceCount()
        }
        super.onDestroy()
    }
}
