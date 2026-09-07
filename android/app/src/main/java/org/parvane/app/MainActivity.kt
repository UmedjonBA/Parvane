package org.parvane.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import org.parvane.app.ui.ParvaneApp

class MainActivity : ComponentActivity() {
    private val vm: ParvaneViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface { ParvaneApp(vm) }
            }
        }
    }
}
