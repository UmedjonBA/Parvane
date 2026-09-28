package org.parvane.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import org.drinkless.tdlib.Client
import org.parvane.app.ui.ParvaneApp

class MainActivity : ComponentActivity() {
    private val vm: ParvaneViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Дымовой тест/дев-стенд: gateway и dev-хуки из extras запуска — ТОЛЬКО в
        // debug-сборке (P-12). Activity экспортирована (LAUNCHER), и в release любое
        // приложение могло бы стартовать нас с gateway=ws://attacker (уводя JWT)
        // или autosend=… (отправка от имени пользователя).
        //   adb shell am start -n org.parvane.app/.MainActivity --es gateway ws://10.0.2.2:9222/ws
        //   --es autologin user@server:пароль  --es autosend peer@server:текст
        if (BuildConfig.DEBUG) {
            intent?.getStringExtra("gateway")?.takeIf { it.isNotBlank() }?.let { Client.gatewayUrl = it }
            DevHooks.autologin = intent?.getStringExtra("autologin")
            DevHooks.autosend = intent?.getStringExtra("autosend")
        }
        setContent {
            MaterialTheme {
                Surface { ParvaneApp(vm) }
            }
        }
    }
}
