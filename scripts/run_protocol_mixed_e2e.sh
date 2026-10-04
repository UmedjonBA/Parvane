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
#   mixed-devices — у аккаунта v2- и v1-устройство: подписанный список
#                 v1-устройств в журнале, сообщение v2-отправителя доходит и до
#                 v1-устройства (легаси-копия, FR-054/FR-058), без дублей;
#   revoke      — отзыв своего v2-устройства (запись журнала + ротации ключей)
#                 и обновление ключа подписи устройств ключом восстановления
#                 (T128/T130, FR-066);
#   recovery    — новое устройство без других устройств: вход по ключу
#                 восстановления (копия корня на сервере), сброс личности;
#                 собеседник видит смену корня (KEY-1 v2) (T129/T130);
#   web2-groups — группа v2 из трёх web: создание, вступление по ссылке v2,
#                 бан → новая эпоха, забаненный не читает новое (T056/T084);
#   unknown-kinds — Rust-инжектор v2 (tests/v2_inject.rs, фича test-inject)
#                 шлёт web v2 10 записей неизвестного вида + текст (T041);
#   state-sync-desktop — личное состояние web → desktop одного аккаунта (T139)
#   group-migrate — группа, созданная по v1, после перехода участников на v2
#                 переводится владельцем в v2; чат и история остаются прежними (T180);
#   v1-off      — сервер с отключённым v1 (PARVANE_V1_MODE=disabled): регистрация,
#                 вход, поиск, текст и фото, перезагрузка, превью ссылки, звонок,
#                 группа v2 и её фото — всё методами v2 (T134)
#   web2-desktop2 — web v2 с desktop v2 (PARVANE_PROTO_V2=1; нужен бинарь
#                 desktop/build-probe/bin/Telegram с -DPARVANE_DEV=ON);
#   web2-desktop1 — web v2 с desktop v1;
#   web2-android1 — web v2 с Telegram X (шов) на v1, в эмуляторе: текст и фото
#                 web → X, ответ X → web (android/tgx_protocol_web_flow.sh: свой
#                 стек, готовый web dist, AVD);
#   call-web-desktop, call-web2-desktop2 — звонок web ↔ desktop в обе стороны
#                 (аудио, настоящий движок на десктопе): первая пара — v1-путём
#                 шарда call, вторая — запечатанными конвертами v2 (T089);
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
  call-web-desktop|call-web2-desktop2) exec "$ROOT/scripts/run_web_cross_calls_e2e.sh" "$PAIR" ;;
  desktop2-groups) exec "$ROOT/desktop/verify_protocol_v2_groups.sh" ;;
  web2-web2|web2-web1) SCRIPT="$ROOT/scripts/e2e_protocol_mixed.mjs" ;;
  web2-groups) SCRIPT="$ROOT/scripts/e2e_protocol_groups.mjs" ;;
  mixed-devices) SCRIPT="$ROOT/scripts/e2e_protocol_legacy_devices.mjs" ;;
  revoke) SCRIPT="$ROOT/scripts/e2e_protocol_revoke.mjs" ;;
  recovery) SCRIPT="$ROOT/scripts/e2e_protocol_recovery.mjs" ;;
  state-sync) SCRIPT="$ROOT/scripts/e2e_protocol_state_sync.mjs" ;;
  state-sync-desktop) SCRIPT="$ROOT/scripts/e2e_protocol_state_sync_desktop.mjs" ;;
  group-migrate) SCRIPT="$ROOT/scripts/e2e_protocol_group_migrate.mjs" ;;
  v1-off)
    SCRIPT="$ROOT/scripts/e2e_protocol_v1_off.mjs"
    # T134: gateway отвечает на JSON-соединение v1 `upgrade_required` и закрывает его
    export PARVANE_E2E_GATEWAY_ENV="PARVANE_V1_MODE=disabled ${PARVANE_E2E_GATEWAY_ENV:-}"
    ;;
  web2-desktop2|web2-desktop1) SCRIPT="$ROOT/scripts/e2e_protocol_mixed_desktop.mjs" ;;
  unknown-kinds)
    SCRIPT="$ROOT/scripts/e2e_protocol_unknown_kinds.mjs"
    # Инжектор собираем заранее: сценарий запускает его уже поднятым стеком
    cargo test --manifest-path "$ROOT/backend/Cargo.toml" -p parvane-integration --test v2_inject --no-run
    ;;
  *) echo "неизвестная пара: $PAIR" >&2; exit 2 ;;
esac
PARVANE_E2E_PAIR="$PAIR" PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$SCRIPT" "$ROOT/scripts/run_web_e2e.sh"
