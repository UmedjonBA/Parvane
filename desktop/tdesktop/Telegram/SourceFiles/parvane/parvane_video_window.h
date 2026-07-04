// Parvane fork: окно активного звонка (таймер, mute/hangup, удалённое видео +
// self-preview, SAS-код). Отделено от webrtc-кода (Qt здесь, webrtc — в бэкенде):
// бэкенд конвертирует кадры в ARGB и зовёт ShowRemote/LocalVideoFrame; парвейн-
// клиент открывает/закрывает окно и задаёт SAS.
#pragma once

#include <string>

namespace Parvane {

// Открыть окно звонка (на Active). peer — адрес собеседника, video — видеозвонок.
void OpenCallWindow(const std::string &peer, bool video);

// Кадр удалённого видео (ARGB8888, w*h*4). Копирует + рисует на main-потоке.
void ShowRemoteVideoFrame(int width, int height, const unsigned char *argb);

// Кадр СВОЕЙ камеры (self-preview, inset).
void ShowLocalVideoFrame(int width, int height, const unsigned char *argb);

// Задать SAS-код (эмодзи для сверки голосом) в окне.
void SetCallSasText(const std::string &sas);

// Закрыть окно звонка (на Ended).
void CloseVideoWindow();

} // namespace Parvane
