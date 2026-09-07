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
        // Дымовой тест/дев-стенд: gateway из extra запуска, ДО создания VM
        //   adb shell am start -n org.parvane.app/.MainActivity --es gateway ws://10.0.2.2:9222/ws
        intent?.getStringExtra("gateway")?.takeIf { it.isNotBlank() }?.let { Client.gatewayUrl = it }
        // Dev-хуки дымового теста (как PARVANE_AUTOLOGIN/AUTOSEND у десктопа):
        //   --es autologin user@server:пароль  --es autosend peer@server:текст
        DevHooks.autologin = intent?.getStringExtra("autologin")
        DevHooks.autosend = intent?.getStringExtra("autosend")
        setContent {
            MaterialTheme {
                Surface { ParvaneApp(vm) }
            }
        }
    }
}
