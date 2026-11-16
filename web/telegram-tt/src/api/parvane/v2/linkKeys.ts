// LINK-1 п. 8: экспорт привязки (блоб старого устройства, координаты — в ECDH-боксе) несёт ключи «Плана» (`planner`),
// «Здоровья» (`health`) и «Облака» (`cloud`) — раздел открывается на новом устройстве сразу. Истории в экспорте больше нет (spec 033):
// новое устройство читает её из журнала истории аккаунта; прежнее поле `v2History` не пишется и не читается.

/** Ключи контейнера планировщика из экспорта линковки (spec 010) — JSON для
 * движка (`plannerKeysImport`); нет поля или мусор — undefined. */
export function parseLinkPlannerKeys(stateJson: string): string | undefined {
  return parseLinkPersonalKeys(stateJson, 'planner');
}

/** Ключи контейнера здоровья из экспорта линковки (spec 038) — JSON для движка (`healthKeysImport`). */
export function parseLinkHealthKeys(stateJson: string): string | undefined {
  return parseLinkPersonalKeys(stateJson, 'health');
}

function parseLinkPersonalKeys(stateJson: string, field: 'planner' | 'health'): string | undefined {
  try {
    const raw = (JSON.parse(stateJson) as Record<string, unknown>)[field];
    // Экспорт кладёт JSON движка строкой; объект — прежняя форма
    const planner = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
    if (!planner || typeof planner !== 'object') return undefined;
    const p = planner as { domain?: unknown; id?: unknown; keys?: unknown };
    if (typeof p.domain !== 'string' || typeof p.id !== 'string' || !Array.isArray(p.keys)) return undefined;
    return JSON.stringify({ domain: p.domain, id: p.id, keys: p.keys });
  } catch {
    return undefined;
  }
}

/** Ключи контейнеров облака из экспорта линковки (spec 016) — JSON-массив для
 * движка (`cloudKeysImport`); нет поля или мусор — undefined. */
export function parseLinkCloudKeys(stateJson: string): string | undefined {
  try {
    const raw = (JSON.parse(stateJson) as { cloud?: unknown }).cloud;
    const cloud = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
    if (!Array.isArray(cloud)) return undefined;
    const containers = cloud.filter((c: { domain?: unknown; id?: unknown; keys?: unknown }) => (
      typeof c?.domain === 'string' && typeof c.id === 'string' && Array.isArray(c.keys)
    )).map((c: { domain: string; id: string; keys: unknown[] }) => ({ domain: c.domain, id: c.id, keys: c.keys }));
    return containers.length ? JSON.stringify(containers) : undefined;
  } catch {
    return undefined;
  }
}
