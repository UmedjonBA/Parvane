package org.webrtc;

import android.content.Context;

/**
 * Parvane (spec 031): подготовка org.webrtc без {@link PeerConnectionFactory#initialize}. Нативная часть WebRTC
 * живёт в libtgcallsjni.so Telegram X и уже инициализирована им при старте (tgcalls::initialize →
 * webrtc::JVM::Initialize); повторный JVM::Initialize из PeerConnectionFactory.initialize роняет процесс
 * («Check failed: !g_jvm»). Здесь — только то, что проверяет PeerConnectionFactory.Builder: контекст и отметка
 * «библиотека загружена» (загрузчик ничего не грузит).
 */
public final class ParvaneWebrtcInit {
  private ParvaneWebrtcInit () { }

  public static synchronized void prepare (Context context) {
    if (ContextUtils.getApplicationContext() == null) {
      ContextUtils.initialize(context.getApplicationContext());
    }
    if (!NativeLibrary.isLoaded()) {
      NativeLibrary.initialize(name -> true, "jingle_peerconnection_so");
    }
  }
}
