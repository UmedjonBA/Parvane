#!/usr/bin/env bash
# Протокол v2 (spec 007, T039): смешанные пары клиентов на изолированном
# стеке (как run_web_e2e.sh). Пара — первый аргумент:
#   web2-web2   — оба web на v2;
#   web2-web1   — web v2 с web v1 (переходный период, v1-путь): фото, голос,
#                 группа из v2- и v1-участника, затем второй клиент переходит
#                 на v2 и читает историю до перехода;
#   state-sync  — второе web-устройство аккаунта: линковка v2 по гранту
#                 (LINK-1), сообщения на оба устройства, папка и блок-лист
#                 с одного устройства на другом ≤ 10 с (SC-009);
#   web2-groups — группа v2 из трёх web: создание, вступление по ссылке v2,
#                 бан → новая эпоха, забаненный не читает новое (T056/T084);
#   unknown-kinds — Rust-инжектор v2 (tests/v2_inject.rs, фича test-inject)
#                 шлёт web v2 10 записей неизвестного вида + текст (T041);
#   web2-desktop2 — web v2 с desktop v2 (PARVANE_PROTO_V2=1; нужен бинарь
#                 desktop/build-probe/bin/Telegram с -DPARVANE_DEV=ON);
#   web2-desktop1 — web v2 с desktop v1;
#   web2-android1 — web v2 с Telegram X (шов) на v1, в эмуляторе: текст и фото
#                 web → X, ответ X → web (android/tgx_protocol_web_flow.sh: свой
#                 стек, готовый web dist, AVD);
#   desktop2-android1 — desktop v2 с Telegram X (шов) на v1, в эмуляторе;
#   desktop2-android2 — desktop v2 с Telegram X на v2 (флаг шва), в эмуляторе
#                 (обе — android/tgx_protocol_v2_flow.sh: свой стек на 4222/9222,
#                 нужен x64-debug APK X с текущим libparvane_jni.so);
#   desktop2-groups — группа v2 из четырёх desktop: создание, исключение → новая
#                 эпоха, ссылка v2 и вступление, журнал личного состояния
#                 (desktop/verify_protocol_v2_groups.sh, свой стек);
# (desktop2-desktop2 — desktop/verify_protocol_v2.sh).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAIR="${1:-web2-web2}"
case "$PAIR" in
  desktop2-android1|desktop2-android2) exec "$ROOT/android/tgx_protocol_v2_flow.sh" "$PAIR" ;;
  web2-android1) exec "$ROOT/android/tgx_protocol_web_flow.sh" ;;
  desktop2-groups) exec "$ROOT/desktop/verify_protocol_v2_groups.sh" ;;
  web2-web2|web2-web1) SCRIPT="$ROOT/scripts/e2e_protocol_mixed.mjs" ;;
  web2-groups) SCRIPT="$ROOT/scripts/e2e_protocol_groups.mjs" ;;
  state-sync) SCRIPT="$ROOT/scripts/e2e_protocol_state_sync.mjs" ;;
  web2-desktop2|web2-desktop1) SCRIPT="$ROOT/scripts/e2e_protocol_mixed_desktop.mjs" ;;
  unknown-kinds)
    SCRIPT="$ROOT/scripts/e2e_protocol_unknown_kinds.mjs"
    # Инжектор собираем заранее: сценарий запускает его уже поднятым стеком
    cargo test --manifest-path "$ROOT/backend/Cargo.toml" -p parvane-integration --test v2_inject --no-run
    ;;
  *) echo "неизвестная пара: $PAIR" >&2; exit 2 ;;
esac
PARVANE_E2E_PAIR="$PAIR" PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$SCRIPT" "$ROOT/scripts/run_web_e2e.sh"
