package org.parvane.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import org.drinkless.tdlib.TdApi
import org.parvane.app.ParvaneViewModel
import java.text.DateFormat
import java.util.Date

@Composable
fun ParvaneApp(vm: ParvaneViewModel) {
    val auth by vm.auth
    val open by vm.openChatId
    when {
        auth == ParvaneViewModel.Auth.LOADING -> Loading()
        auth != ParvaneViewModel.Auth.READY -> LoginScreen(vm)
        open != null -> ChatScreen(vm, open!!)
        else -> ChatListScreen(vm)
    }
}

@Composable
private fun Loading() {
    Column(Modifier.fillMaxSize(), Arrangement.Center, Alignment.CenterHorizontally) { CircularProgressIndicator() }
}

@Composable
fun LoginScreen(vm: ParvaneViewModel) {
    val auth by vm.auth
    val error by vm.error
    val busy by vm.busy
    var nick by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(24.dp), Arrangement.Center, Alignment.CenterHorizontally) {
        Text("Parvane", style = MaterialTheme.typography.headlineLarge)
        Text("Вход по нику и паролю", Modifier.padding(bottom = 24.dp))
        if (auth == ParvaneViewModel.Auth.NICK) {
            OutlinedTextField(nick, { nick = it }, Modifier.fillMaxWidth(), label = { Text("Ник") }, singleLine = true)
            Button({ vm.submitNick(nick) }, Modifier.padding(top = 16.dp), enabled = nick.isNotBlank()) { Text("Далее") }
        } else {
            OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("Пароль") },
                singleLine = true, visualTransformation = PasswordVisualTransformation())
            Button({ vm.submitPassword(password) }, Modifier.padding(top = 16.dp), enabled = password.isNotEmpty() && !busy) {
                Text(if (busy) "Входим…" else "Войти")
            }
        }
        error?.let { Text(it, Modifier.padding(top = 12.dp), color = MaterialTheme.colorScheme.error) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(vm: ParvaneViewModel) {
    var newChat by remember { mutableStateOf(false) }
    val error by vm.error
    val chats = vm.chats.values.sortedByDescending { it.positions.firstOrNull()?.order ?: 0L }
    Scaffold(
        topBar = {
            TopAppBar(title = { Text("Parvane") }, actions = {
                IconButton({ vm.logout() }) { Icon(Icons.Filled.Logout, "Выйти") }
            })
        },
        floatingActionButton = { FloatingActionButton({ newChat = true }) { Icon(Icons.Filled.Add, "Новый чат") } },
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize()) {
            items(chats, key = { it.id }) { chat ->
                val last = (chat.lastMessage?.content as? TdApi.MessageText)?.text?.text ?: ""
                ListItem(
                    headlineContent = { Text(chat.title) },
                    supportingContent = { Text(last, maxLines = 1) },
                    trailingContent = { if (chat.unreadCount > 0) Text("${chat.unreadCount}") },
                    modifier = Modifier.clickable { vm.openChat(chat.id) },
                )
                HorizontalDivider()
            }
        }
        if (newChat) {
            var nick by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { newChat = false },
                title = { Text("Новый чат") },
                text = {
                    Column {
                        OutlinedTextField(nick, { nick = it }, label = { Text("Ник собеседника") }, singleLine = true)
                        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    }
                },
                confirmButton = { TextButton({ vm.openByNick(nick); newChat = false }) { Text("Открыть") } },
                dismissButton = { TextButton({ newChat = false }) { Text("Отмена") } },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: ParvaneViewModel, chatId: Long) {
    BackHandler { vm.closeChat() }
    val list = vm.messages[chatId].orEmpty()
    var text by remember { mutableStateOf("") }
    val state = rememberLazyListState()
    LaunchedEffect(list.size) { if (list.isNotEmpty()) state.animateScrollToItem(list.size - 1) }
    Scaffold(
        topBar = {
            TopAppBar(title = { Text(vm.titleOf(chatId)) }, navigationIcon = {
                IconButton({ vm.closeChat() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Назад") }
            })
        },
        bottomBar = {
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(text, { text = it }, Modifier.weight(1f), placeholder = { Text("Сообщение") })
                IconButton({ if (text.isNotBlank()) { vm.sendText(chatId, text.trim()); text = "" } }) {
                    Icon(Icons.AutoMirrored.Filled.Send, "Отправить")
                }
            }
        },
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize(), state = state) {
            items(list, key = { it.id }) { m -> MessageRow(m) }
        }
    }
}

@Composable
private fun MessageRow(m: TdApi.Message) {
    val body = (m.content as? TdApi.MessageText)?.text?.text ?: "[медиа]"
    val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(m.date * 1000L))
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = if (m.isOutgoing) Arrangement.End else Arrangement.Start) {
        Column(Modifier.fillMaxWidth(0.8f)) {
            Text(body)
            Text(time, style = MaterialTheme.typography.labelSmall)
        }
    }
}
