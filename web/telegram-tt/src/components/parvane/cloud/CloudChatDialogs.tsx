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
import { childrenOf, pathOf, sortNodes } from './cloudModel';
import {
  getCloudData, getNodes, loadCloud, refreshCloud, refreshCloudUsage,
} from './cloudStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import { CloudFolderDialog } from './CloudDialogs';
import { CLOUD_ERROR_KEYS } from './CloudTransfers';

import styles from './Cloud.module.scss';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const NAME_SORT = { key: 'name', isDescending: false } as const;
const ROOT = 'root';

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
  const children = useMemo(() => sortNodes(childrenOf(nodes, folder), NAME_SORT), [nodes, folder]);

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
      <CloudFolderDialog
        isOpen={request?.type === 'save'}
        title={lang('ParvaneCloudChooseFolder')}
        confirmLabel={lang('ParvaneCloudSaveHere')}
        rootName={lang('ParvaneCloudTabDrive')}
        nodes={nodes}
        movedIds={[]}
        onSubmit={handleSave}
        onClose={closeCloudBridge}
      />
      <Modal
        isOpen={request?.type === 'attach'}
        title={lang('ParvaneCloudChooseFiles')}
        className={styles.dialog}
        onClose={closeCloudBridge}
      >
        <div className={styles.dialogPath}>
          <button type="button" className={styles.pathLink} onClick={() => setFolder(undefined)}>
            {lang('ParvaneCloudTabDrive')}
          </button>
          {path.map((n) => (
            <span key={n.id} className={styles.pathStep}>
              <Icon name="next" className={styles.pathArrow} />
              <button type="button" className={styles.pathLink} onClick={() => setFolder(n.id)}>{n.name}</button>
            </span>
          ))}
        </div>
        <div className={buildClassName(styles.dialogList, 'custom-scroll')} role="list">
          {children.map((n) => (
            <button
              key={n.id}
              type="button"
              role="listitem"
              className={buildClassName(styles.dialogFolder, picked.includes(n.id) && styles.dialogPicked)}
              aria-selected={picked.includes(n.id)}
              data-name={n.name}
              onClick={handleRowClick(n)}
            >
              <Icon name={n.kind === 'folder' ? 'folder' : picked.includes(n.id) ? 'check' : 'document'} />
              <span className={styles.dialogFolderName} dir="auto">{n.name}</span>
              {n.kind === 'file' && <span className={styles.dialogSize}>{formatFileSize(lang, n.size)}</span>}
            </button>
          ))}
          {!children.length && (
            <div className={styles.dialogEmpty}>
              {lang(nodes.length ? 'ParvaneCloudEmptyFolder' : 'ParvaneCloudEmpty')}
            </div>
          )}
        </div>
        <div className="dialog-buttons">
          <Button className="confirm-dialog-button" isText disabled={!picked.length} onClick={handleSend}>
            {lang('ParvaneCloudSend')}
          </Button>
          <Button className="confirm-dialog-button" isText onClick={closeCloudBridge}>
            {lang('ParvaneCloudCancel')}
          </Button>
        </div>
      </Modal>
    </>
  );
};

export default memo(CloudChatDialogs);
