import type {
  CloudBlobInfo, CloudErrorCode, CloudNodeJson, CloudResult,
} from './cloudDrive';
import type { CloudSync } from './v2/cloud';

// Parvane (spec 041, CLOUD-3): история версий файла «Файлов» и «Заметок». Сколько версий хранить, какие правки —
// одна версия (окно черновика) и какие блобы стереть, решает движок (`domain/cloud.rs`); здесь — выбор версии
// узла и возврат её текущей.

type Deps = {
  log: (message: string) => void;
  self: () => string | undefined;
  cloud: () => CloudSync;
  findNode: (container: string, node: string) => CloudNodeJson | undefined;
  /** Независимая копия чужого блоба под своим секретом (возврат версии, загруженной другим участником). */
  copyBlob: (fileId: string, capability: string) => Promise<{ fileId: string; capability: string }>;
  errorOf: (e: unknown) => CloudErrorCode;
};

/** Узел с содержимым выбранной версии (`fileId` — текущей либо прежней); такой версии нет — `undefined`. */
export function pickCloudVersion(node: CloudNodeJson | undefined, fileId?: string): CloudNodeJson | undefined {
  if (!node?.blob || !fileId || node.blob.fileId === fileId) return node;
  const version = node.versions?.find((v) => v.blob.fileId === fileId);
  if (!version) return undefined;
  return {
    ...node,
    blob: version.blob,
    thumb: version.thumb || undefined,
    size: version.size,
    mime: version.blob.mime || node.mime,
    mtime: version.mtime,
  };
}

export function createCloudVersions(deps: Deps) {
  return {
    /** Сделать прежнюю версию текущей: та же запись блоба (своя) либо его копия (загружена другим участником
     * совместной папки — движок не примет чужого загрузившего). Прежняя текущая остаётся в истории. */
    async parvaneCloudRestoreVersion({ container, node, fileId }: {
      container: string; node: string; fileId: string;
    }): Promise<CloudResult> {
      const found = deps.findNode(container, node);
      const version = found?.versions?.find((v) => v.blob.fileId === fileId);
      const self = deps.self();
      if (!found || !version || !self) return { ok: false, error: 'not-found' };
      try {
        let blob: CloudBlobInfo = version.blob;
        if (blob.uploader !== self) {
          const copy = await deps.copyBlob(blob.fileId, blob.capability);
          blob = { ...blob, ...copy, uploader: self };
        }
        // Миниатюра чужой версии осталась бы чужим блобом — у копии её нет
        const thumb = blob === version.blob ? version.thumb || undefined : undefined;
        await deps.cloud().apply(container, [{
          op: 'setBlob', id: node, blob, thumb, mtime: Date.now(), keep: true,
        }]);
        return { ok: true };
      } catch (e) {
        deps.log(`облако: версия не возвращена: ${String(e)}`);
        return { ok: false, error: deps.errorOf(e) };
      }
    },
  };
}
