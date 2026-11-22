import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { GlobalState } from '../../../global/types';
import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { callApi } from '../../../api/gramjs';
import { closeCloudBridge, getCloudBridgeRequest } from './cloudBridge';
import { childrenOf, listedNodes, pathOf, sortNodes } from './cloudModel';
import {
  createCloudFolderAt, getCloudData, getNodes, loadCloud, refreshCloud, refreshCloudUsage,
} from './cloudStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';
import CloudMoveDialog from './CloudMoveDialog';
import { CLOUD_ERROR_KEYS } from './CloudTransfers';

import kit from '../notes/PvKit.module.scss';
import styles from './CloudSheets.module.scss';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const NAME_SORT = { key: 'name', isDescending: false } as const;
const NO_IDS: string[] = [];
const ROOT = 'root';
// Как в стилях: уже — раскладка телефона (окно сохранения — папка за папкой)
const NARROW_WIDTH = 760;

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Parvane (spec 016): диалоги связи чатов с облаком — «Сохранить в облако»
// (выбор папки личного диска) и «Из облака» (выбор файлов для отправки в чат).
// Файлы не перекачиваются через устройство: сервер копирует блоб.
const CloudChatDialogs = () => {
  const { showNotification } = getActions();
  const lang = useLang();
  const request = useDerivedState(getCloudBridgeRequest);
  const data = useDerivedState(getCloudData);
  const currentUserId = useSelector(selectCurrentUserId);
  const [folder, setFolder] = useState<string>();
  const [picked, setPicked] = useState<string[]>([]);
  const { width: windowWidth } = useWindowSize();

  const isOpen = Boolean(request);
  useEffect(() => {
    if (!isOpen) return;
    setFolder(undefined);
    setPicked([]);
    void loadCloud(currentUserId).then(() => refreshCloud());
  }, [isOpen, currentUserId]);

  const rootId = data?.rootId;
  const nodes = getNodes(rootId, data);
  const path = useMemo(() => pathOf(nodes, folder), [nodes, folder]);
  const children = useMemo(() => sortNodes(childrenOf(listedNodes(nodes), folder), NAME_SORT), [nodes, folder]);

  const notify = (result: CloudResult | undefined, doneKey: 'ParvaneCloudSavedToCloud' | 'ParvaneCloudSentToChat') => {
    showNotification({ message: lang(result?.ok ? doneKey : CLOUD_ERROR_KEYS[result?.error || 'rejected']) });
  };

  const handleSave = useLastCallback((target?: string) => {
    if (request?.type !== 'save') return;
    const { files } = request;
    closeCloudBridge();
    void (async () => {
      let last: CloudResult | undefined;
      for (const file of files) {
        last = await callParvane('parvaneCloudSaveFromChat', { file, container: rootId || ROOT, parent: target })
          .catch(() => undefined) as CloudResult | undefined;
        if (!last?.ok) break;
      }
      notify(last, 'ParvaneCloudSavedToCloud');
      void refreshCloud();
      void refreshCloudUsage();
    })();
  });

  // «Новая папка» в окне сохранения — на личном диске
  const handleNewFolder = useLastCallback((
    place: string | undefined, parent: string | undefined, name: string,
  ) => createCloudFolderAt(rootId || ROOT, parent, name));

  const handleSend = useLastCallback(() => {
    if (request?.type !== 'attach' || !rootId || !picked.length) return;
    const { chatId } = request;
    const chosen = picked;
    closeCloudBridge();
    void callParvane('parvaneCloudSendToChat', { container: rootId, nodes: chosen, chatId })
      .then((result) => {
        const r = result as CloudResult | undefined;
        if (!r?.ok) notify(r, 'ParvaneCloudSentToChat');
      }).catch(() => notify(undefined, 'ParvaneCloudSentToChat'));
  });

  const handleRowClick = (node: CloudNode) => () => {
    if (node.kind === 'folder') {
      setFolder(node.id);
      return;
    }
    setPicked(picked.includes(node.id) ? picked.filter((id) => id !== node.id) : [...picked, node.id]);
  };

  return (
    <>
      <CloudMoveDialog
        isOpen={request?.type === 'save'}
        isStepwise={windowWidth <= NARROW_WIDTH}
        title={lang('ParvaneCloudChooseFolder')}
        confirmLabel={lang('ParvaneCloudSaveHere')}
        rootName={lang('ParvaneCloudTabDrive')}
        nodes={nodes}
        movedIds={NO_IDS}
        onCreateFolder={handleNewFolder}
        onSubmit={handleSave}
        onClose={closeCloudBridge}
      />
      <PvSheet
        isOpen={request?.type === 'attach'}
        title={lang('ParvaneCloudChooseFiles')}
        className={styles.narrow}
        isPage
        onClose={closeCloudBridge}
      >
        <div className={styles.pickPath}>
          <button
            type="button"
            className={buildClassName(styles.pickCrumb, !path.length && styles.pickCrumbLast)}
            onClick={() => setFolder(undefined)}
          >
            {lang('ParvaneCloudTabDrive')}
          </button>
          {path.map((n, index) => (
            <span key={n.id}>
              {'/ '}
              <button
                type="button"
                className={buildClassName(styles.pickCrumb, index === path.length - 1 && styles.pickCrumbLast)}
                onClick={() => setFolder(n.id)}
              >
                {n.name}
              </button>
            </span>
          ))}
        </div>
        <div className={buildClassName(styles.tree, 'custom-scroll')} role="list">
          {children.map((n) => {
            const isPicked = picked.includes(n.id);
            return (
              <button
                key={n.id}
                type="button"
                role="listitem"
                className={buildClassName(styles.treeRow, isPicked && styles.treeRowOn)}
                aria-selected={isPicked}
                data-name={n.name}
                onClick={handleRowClick(n)}
              >
                <PvIcon
                  name={n.kind === 'folder' ? 'folder' : isPicked ? 'check' : 'file'}
                  isSmall
                  className={n.kind === 'folder' ? styles.treeIcon : undefined}
                />
                <span className={styles.treeName} dir="auto">{n.name}</span>
                {n.kind === 'file' && <span className={styles.pickSize}>{formatFileSize(lang, n.size)}</span>}
                {n.kind === 'folder' && <PvIcon name="right" isSmall />}
              </button>
            );
          })}
          {!children.length && (
            <div className={styles.pickEmpty}>
              {lang(nodes.length ? 'ParvaneCloudEmptyFolder' : 'ParvaneCloudEmpty')}
            </div>
          )}
        </div>
        <div className={styles.buttons}>
          <button type="button" className={kit.btn} onClick={closeCloudBridge}>{lang('Cancel')}</button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={!picked.length}
            onClick={handleSend}
          >
            {lang('ParvaneCloudSend')}
          </button>
        </div>
      </PvSheet>
    </>
  );
};

export default memo(CloudChatDialogs);
