// Parvane fork: простое окно удалённого видео звонка. Отделено от webrtc-кода
// (чтобы Qt и webrtc-заголовки не пересекались): webrtc-движок конвертирует кадр
// в ARGB и зовёт ShowRemoteVideoFrame; здесь — только Qt-отрисовка.
#pragma once

namespace Parvane {

// Показать кадр удалённого видео (ARGB8888, w*h*4 байт, stride = w*4). Копирует
// байты и отрисовывает на main-потоке; при первом кадре создаёт окно.
void ShowRemoteVideoFrame(int width, int height, const unsigned char *argb);

// Закрыть окно видео (по завершении звонка).
void CloseVideoWindow();

} // namespace Parvane
