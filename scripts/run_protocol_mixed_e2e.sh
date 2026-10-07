#!/usr/bin/env bash
# Протокол v2 (spec 007, T039): пары клиентов на изолированном стеке (как
# run_web_e2e.sh). С T110 (7 окт 2026) сервер и web без v1 — пары с ролью v1
# (web1, desktop1, android1, mixed-devices, group-migrate, v1-off) удалены.
# Пара — первый аргумент:
#   web2-web2   — оба web на v2: фото, голос, правка, режим L2, звонок, история
#                 после перезагрузки;
#   state-sync  — второе web-устройство аккаунта: линковка v2 по гранту
#                 (LINK-1), сообщения на оба устройства, папка и блок-лист
#                 с одного устройства на другом ≤ 10 с (SC-009);
#   revoke      — отзыв своего v2-устройства (запись журнала + ротации ключей)
#                 и обновление ключа подписи устройств ключом восстановления
#                 (T128/T130, FR-066);
#   escrow      — ключ восстановления утерян: администратор своим ключом (вне
#                 сервера) выписывает новый, вход по нему (scripts/admin_recover_user.sh);
#   relink      — выход и повторный вход на устройстве при живом втором: привязка
#                 возвращает обе стороны переписки;
#   recovery    — новое устройство без других устройств: вход по ключу
#                 восстановления (копия корня на сервере), сброс личности;
#                 собеседник видит смену корня (KEY-1 v2) (T129/T130);
#   web2-groups — группа v2 из трёх web: создание, вступление по ссылке v2,
#                 бан → новая эпоха, забаненный не читает новое (T056/T084);
#   unknown-kinds — Rust-инжектор v2 (tests/v2_inject.rs, фича test-inject)
#                 шлёт web v2 10 записей неизвестного вида + текст (T041);
#   state-sync-desktop — личное состояние web → desktop одного аккаунта (T139)
#   web2-desktop2 — web v2 с desktop v2 (PARVANE_PROTO_V2=1; нужен бинарь
#                 desktop/build-probe/bin/Telegram с -DPARVANE_DEV=ON);
#   call-web2-desktop2 — звонок web ↔ desktop в обе стороны (аудио, настоящий
#                 движок на десктопе) запечатанными конвертами v2 (T089);
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
  desktop2-android2) exec "$ROOT/android/tgx_protocol_v2_flow.sh" "$PAIR" ;;
  call-web2-desktop2) exec "$ROOT/scripts/run_web_cross_calls_e2e.sh" "$PAIR" ;;
  desktop2-groups) exec "$ROOT/desktop/verify_protocol_v2_groups.sh" ;;
  web2-web2) SCRIPT="$ROOT/scripts/e2e_protocol_mixed.mjs" ;;
  web2-groups) SCRIPT="$ROOT/scripts/e2e_protocol_groups.mjs" ;;
  revoke) SCRIPT="$ROOT/scripts/e2e_protocol_revoke.mjs" ;;
  relink) SCRIPT="$ROOT/scripts/e2e_protocol_relink.mjs" ;;
  recovery) SCRIPT="$ROOT/scripts/e2e_protocol_recovery.mjs" ;;
  escrow)
    SCRIPT="$ROOT/scripts/e2e_protocol_escrow.mjs"
    # Ключ администратора — вне каталога стека; серверу отдаётся только открытый
    cargo build --manifest-path "$ROOT/backend/Cargo.toml" -p parvane-protocol --bin escrow_admin
    ESCROW_DIR="$(mktemp -d)"
    trap 'rm -rf "$ESCROW_DIR"' EXIT
    export PARVANE_E2E_ESCROW_KEY_FILE="$ESCROW_DIR/admin.key"
    PARVANE_ESCROW_PUBLIC_KEY="$("$ROOT/backend/target/debug/escrow_admin" keygen "$PARVANE_E2E_ESCROW_KEY_FILE")"
    export PARVANE_ESCROW_PUBLIC_KEY
    ;;
  state-sync) SCRIPT="$ROOT/scripts/e2e_protocol_state_sync.mjs" ;;
  state-sync-desktop) SCRIPT="$ROOT/scripts/e2e_protocol_state_sync_desktop.mjs" ;;
  web2-desktop2) SCRIPT="$ROOT/scripts/e2e_protocol_mixed_desktop.mjs" ;;
  unknown-kinds)
    SCRIPT="$ROOT/scripts/e2e_protocol_unknown_kinds.mjs"
    # Инжектор собираем заранее: сценарий запускает его уже поднятым стеком
    cargo test --manifest-path "$ROOT/backend/Cargo.toml" -p parvane-integration --test v2_inject --no-run
    ;;
  *) echo "неизвестная пара: $PAIR" >&2; exit 2 ;;
esac
PARVANE_E2E_PAIR="$PAIR" PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$SCRIPT" "$ROOT/scripts/run_web_e2e.sh"
