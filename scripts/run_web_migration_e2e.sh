#!/usr/bin/env bash
# Разовый перенос web (spec 035, T109; contracts/migration.md): профиль, снятый ПРЕЖНИМ кодом, открывается новым.
#
#   scripts/run_web_migration_e2e.sh seed   — наполнение «всё понемногу» (T006, scripts/e2e_web_seed_everything.mjs)
#                                             прежним кодом исходной точки T008 (шарды, web-dist диаг-сборки и
#                                             конфиг NATS из local-workdirs/spec035/baseline): профили браузера,
#                                             копия баз шардов с ключом подписи JWT, выгрузки «до» (auditDump)
#   scripts/run_web_migration_e2e.sh        — три прогона нового кода на копии баз сида: plain (все профили),
#                                             M2 и M4 (вкладка alice1 закрыта посреди переноса → повторный запуск);
#                                             после каждого — выгрузка модели и migration_audit_diff.py = 0/0;
#                                             month (T142, «устройство отсутствовало») — alice1 переносится и правит,
#                                             messenger `--gc-as-of <+31 сутки>` (перезапуск шарда раннером,
#                                             файл messenger.restart), затем переносится alice2 и видит правку
#   PARVANE_MIGRATION_VARIANTS="month"        — только выбранные варианты
#
# Профиль браузера привязан к origin (`http://127.0.0.1:<порт web>`), сессия — к ключу JWT identity: оба прогона
# идут на одних и тех же фиксированных портах, а шарды нового прогона поднимаются на копии баз сида (вместе с
# `identity-jwt-ed25519.pem` и `parvane.json`). Ни run_web_e2e.sh, ни шарды для этого не меняются: стек
# поднимается через теневой корень (симлинки), где шард — обёртка, кладущая копию своих баз рядом с
# PARVANE_DB_PATH перед запуском настоящего бинаря. Тяжёлый прогон — по одному (корневой CLAUDE.md).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-migrate}"
BASE="${PARVANE_MIGRATION_BASELINE:-$ROOT/local-workdirs/spec035/baseline}"
WORK="${PARVANE_MIGRATION_WORK:-$ROOT/local-workdirs/spec035/t109}"
SEED="${PARVANE_MIGRATION_SEED:-$WORK/seed}"
BASE_COMMIT="${PARVANE_MIGRATION_BASE_COMMIT:-eefe766d}"
SHARDS=(identity messenger cloud call preview push domains gateway)

# Фиксированные порты: origin профиля и gateway, записанный в профиль, у обоих прогонов одни
export PARVANE_E2E_NATS_PORT="${PARVANE_E2E_NATS_PORT:-46222}"
export PARVANE_E2E_GATEWAY_WS_PORT="${PARVANE_E2E_GATEWAY_WS_PORT:-46280}"
export PARVANE_E2E_GATEWAY_TCP_PORT="${PARVANE_E2E_GATEWAY_TCP_PORT:-46281}"
export PARVANE_E2E_WEB_PORT="${PARVANE_E2E_WEB_PORT:-46173}"
export PARVANE_E2E_TURN_PORT="${PARVANE_E2E_TURN_PORT:-46478}"
export PARVANE_E2E_SKIP_BACKEND_BUILD=1 PARVANE_E2E_SKIP_WEB_BUILD=1

# Теневой корень: scripts и прочее — настоящие, шарды — обёртки над $bins, dist web — $dist, конфиг NATS — $conf
make_shadow() {
  local shadow="$1" bins="$2" dist="$3" conf="$4"
  rm -rf "$shadow"
  mkdir -p "$shadow/backend/target/debug" "$shadow/backend/infra/nats" "$shadow/web/telegram-tt"
  for entry in "$ROOT"/* "$ROOT"/.[!.]*; do
    case "$(basename "$entry")" in backend|web|local-workdirs|.git) continue ;; esac
    ln -s "$entry" "$shadow/$(basename "$entry")"
  done
  ln -s "$ROOT/local-workdirs" "$shadow/local-workdirs"
  for entry in "$ROOT"/backend/*; do
    case "$(basename "$entry")" in target|infra) continue ;; esac
    ln -s "$entry" "$shadow/backend/$(basename "$entry")"
  done
  for entry in "$ROOT"/backend/infra/*; do
    [[ "$(basename "$entry")" == nats ]] || ln -s "$entry" "$shadow/backend/infra/$(basename "$entry")"
  done
  for entry in "$ROOT"/backend/infra/nats/*; do ln -s "$entry" "$shadow/backend/infra/nats/$(basename "$entry")"; done
  rm -f "$shadow/backend/infra/nats/server.prod.conf"
  cp "$conf" "$shadow/backend/infra/nats/server.prod.conf"
  for entry in "$ROOT"/web/*; do
    [[ "$(basename "$entry")" == telegram-tt ]] || ln -s "$entry" "$shadow/web/$(basename "$entry")"
  done
  for entry in "$ROOT"/web/telegram-tt/* "$ROOT"/web/telegram-tt/.[!.]*; do
    [[ -e "$entry" ]] || continue
    case "$(basename "$entry")" in dist|test-results) continue ;; esac
    ln -s "$entry" "$shadow/web/telegram-tt/$(basename "$entry")"
  done
  ln -s "$dist" "$shadow/web/telegram-tt/dist"
  for shard in "${SHARDS[@]}"; do
    cat >"$shadow/backend/target/debug/$shard" <<EOF
#!/usr/bin/env bash
# Обёртка шарда (run_web_migration_e2e.sh): копия баз сида рядом с PARVANE_DB_PATH — один раз, затем настоящий бинарь
if [[ -n "\${PARVANE_MIGRATION_DB_SEED:-}" && -n "\${PARVANE_DB_PATH:-}" && ! -e "\$PARVANE_DB_PATH.seeded" ]]; then
  dir="\$(dirname "\$PARVANE_DB_PATH")"
  for f in "\$PARVANE_MIGRATION_DB_SEED/$shard".db*; do [[ -e "\$f" ]] && cp "\$f" "\$dir/"; done
  if [[ "$shard" == identity ]]; then
    for f in identity-jwt-ed25519.pem identity-server-ed25519.pem parvane.json; do
      [[ -e "\$PARVANE_MIGRATION_DB_SEED/\$f" ]] && cp "\$PARVANE_MIGRATION_DB_SEED/\$f" "\$dir/\$f"
    done
    chmod 600 "\$dir"/identity-*.pem 2>/dev/null || true
  fi
  : >"\$PARVANE_DB_PATH.seeded"
fi
exec "$bins/$shard" "\$@"
EOF
    chmod +x "$shadow/backend/target/debug/$shard"
  done
}

run_stack() {
  local shadow="$1" script="$2"
  PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/$script" bash "$shadow/scripts/run_web_e2e.sh"
}

mkdir -p "$WORK"
if [[ "$MODE" == seed ]]; then
  for f in "$BASE/web-dist-diag/index.html" "$BASE/shards/identity"; do
    [[ -e "$f" ]] || { echo "нет исходной точки T008: $f" >&2; exit 1; }
  done
  # Конфиг NATS исходной точки (ACL прежних шардов); дерево без git (копия на сборочной машине) — заранее
  # положенный файл
  if [[ ! -s "$WORK/nats-base.conf" ]]; then
    git -C "$ROOT" show "$BASE_COMMIT:backend/infra/nats/server.prod.conf" >"$WORK/nats-base.conf"
  fi
  make_shadow "$WORK/shadow-base" "$BASE/shards" "$BASE/web-dist-diag" "$WORK/nats-base.conf"
  rm -rf "$SEED"
  export PARVANE_SEED_OUT="$SEED"
  # Прежний клиент — минорной версии протокола до spec 035 (FR-047): стек исходной точки его принимает
  export PARVANE_V2_MIN_MINOR=0
  run_stack "$WORK/shadow-base" e2e_web_seed_everything.mjs
  echo "сид T109: $SEED"
  exit 0
fi

[[ -d "$SEED/profiles/server" ]] || { echo "нет сида: $SEED (сначала: $0 seed)" >&2; exit 1; }
NEW_DIST="${PARVANE_MIGRATION_DIST:-$ROOT/web/telegram-tt/dist}"
[[ -e "$NEW_DIST/index.html" ]] || { echo "нет нового web-dist диаг-сборки: $NEW_DIST" >&2; exit 1; }
make_shadow "$WORK/shadow-new" "$ROOT/backend/target/debug" "$NEW_DIST" \
  "$ROOT/backend/infra/nats/server.prod.conf"
rc=0
for variant in ${PARVANE_MIGRATION_VARIANTS:-plain M2 M4 month}; do
  echo "== перенос: $variant"
  PARVANE_MIGRATION_DB_SEED="$SEED/profiles/server" PARVANE_MIGRATION_VARIANT="$variant" \
    PARVANE_MIGRATION_SEED="$SEED" PARVANE_MIGRATION_OUT="$WORK/after/$variant" \
    run_stack "$WORK/shadow-new" e2e_web_migration.mjs || rc=1
done
exit "$rc"
