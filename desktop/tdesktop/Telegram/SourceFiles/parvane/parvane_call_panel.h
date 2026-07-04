// Parvane fork: НАТИВНЫЙ экран звонка на виджетах/стилях tdesktop (calls.style,
// Calls::Userpic, Ui::CallButton, Ui::FlatLabel) — вид как в Telegram. Управляется
// нашим CallManager через функции ниже. Заменяет самодельное parvane_video_window.
#pragma once

#include <string>

class PeerData;

namespace Parvane {

// Открыть экран звонка для пира (аватар/имя/статус/кнопки). video — видеозвонок.
void OpenNativeCallPanel(PeerData *peer, bool video);

// Соединение установлено (Active): статус «Вызов…» → таймер.
void NativeCallConnected();

// SAS-код (эмодзи сверки голосом).
void NativeCallSas(const std::string &sas);

// Кадр удалённого видео / своей камеры (сырой ARGB8888, w*h*4) — рендер в панель.
void NativeCallRemoteFrame(int width, int height, const unsigned char *argb);
void NativeCallLocalFrame(int width, int height, const unsigned char *argb);

// Закрыть экран звонка (Ended).
void CloseNativeCallPanel();

} // namespace Parvane
