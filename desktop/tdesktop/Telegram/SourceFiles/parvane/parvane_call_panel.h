// Parvane fork: НАТИВНЫЙ экран звонка на виджетах/стилях tdesktop (calls.style,
// Calls::Userpic, Ui::CallButton, Ui::FlatLabel) — вид как в Telegram. Управляется
// нашим CallManager через функции ниже. Заменяет самодельное parvane_video_window.
#pragma once

#include <string>

class PeerData;

namespace Parvane {

// Открыть экран звонка для пира (аватар/имя/статус/кнопки). video — видеозвонок.
// incoming — входящий (кнопки «Ответить»/«Отклонить») vs исходящий (mute/hangup).
void OpenNativeCallPanel(PeerData *peer, bool video, bool incoming = false);

// Соединение установлено (Active): статус «Вызов…» → таймер.
void NativeCallConnected();

// SAS-код (эмодзи сверки голосом).
void NativeCallSas(const std::string &sas);

// Закрыть экран звонка (Ended). Видео рендерится нативным Calls::VideoBubble из
// общих видео-треков (parvane_call_video.h) — отдельного API кадров не нужно.
void CloseNativeCallPanel();

} // namespace Parvane
