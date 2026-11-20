import { memo, useState } from '../../../lib/teact/teact';

import type { CloudNode } from './cloudModel';

import { MAX_BUFFER_SIZE } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { pickCloudVersion } from '../../../api/parvane/cloudVersions';
import { readCloudVersionText, restoreCloudVersion } from './cloudCopies';
import { kindOfFile } from './cloudModel';
import {
  canEditContainer, downloadCloudNode, getCloudData, getNodes, peerLabel,
} from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import sheets from './CloudSheets.module.scss';
import styles from './CloudVersions.module.scss';

type OwnProps = {
  // Чью историю показать; не задано — окно закрыто
  container?: string;
  nodeId?: string;
  // Не текстовая версия открывается просмотром «Файлов»; не задано — только скачать
  onOpen?: (container: string, node: CloudNode) => void;
  onClose: NoneToVoidFunction;
};

// Сколько версий хранится (с текущей) — как `cloud::VERSIONS_KEEP` движка
const VERSIONS_KEEP = 10;

type Row = { fileId: string; mtime: number; size: number; uploader: string };

// Parvane (spec 041, CLOUD-3): история версий файла «Файлов» либо заметки — текущая и прежние, от новой к старой.
// Версию можно открыть (текст — здесь же), скачать и сделать текущей. Что хранить и что стирать, решает движок.
const CloudVersionsDialog = ({
  container, nodeId, onOpen, onClose,
}: OwnProps) => {
  const lang = useLang();
  const data = useDerivedState(getCloudData);
  const [shown, setShown] = useState<{ fileId: string; text?: string }>();
  const [busyId, setBusyId] = useState<string>();

  const target = container && nodeId ? { container, node: nodeId } : undefined;
  const node = target ? getNodes(target.container, data).find((n) => n.id === target.node) : undefined;
  const self = data?.containers.find((c) => c.kind === 'root')?.owner;
  const canEdit = target ? canEditContainer(target.container, data) : false;
  const isText = node ? kindOfFile(node.mime, node.name) === 'text' : false;

  const rows: Row[] = node?.blob ? [
    {
      fileId: node.blob.fileId, mtime: node.mtime, size: node.size, uploader: node.blob.uploader,
    },
    ...(node.versions || []).map((v) => ({
      fileId: v.blob.fileId, mtime: v.mtime, size: v.size, uploader: v.blob.uploader,
    })),
  ] : [];

  const handleClose = useLastCallback(() => {
    setShown(undefined);
    onClose();
  });

  const handleOpen = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const { fileId } = e.currentTarget.dataset;
    const version = pickCloudVersion(node, fileId);
    if (!target || !version || !fileId) return;
    if (!isText) {
      onOpen?.(target.container, version);
      return;
    }
    if (shown?.fileId === fileId) {
      setShown(undefined);
      return;
    }
    setShown({ fileId });
    const text = await readCloudVersionText(target.container, version);
    setShown((current) => (current?.fileId === fileId ? { fileId, text: text ?? '' } : current));
  });

  const handleDownload = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { fileId } = e.currentTarget.dataset;
    const version = pickCloudVersion(node, fileId);
    if (target && version) void downloadCloudNode(target.container, version, MAX_BUFFER_SIZE, fileId);
  });

  const handleRestore = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const { fileId } = e.currentTarget.dataset;
    if (!target || !fileId) return;
    setBusyId(fileId);
    await restoreCloudVersion(target.container, target.node, fileId);
    setBusyId(undefined);
    setShown(undefined);
  });

  const whenText = (mtime: number) => (mtime ? new Date(mtime).toLocaleString(lang.code, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : '');

  function renderRow(row: Row, index: number) {
    const isCurrent = index === 0;
    const facts = [
      isCurrent ? lang('ParvaneCloudVersionCurrent') : '',
      formatFileSize(lang, row.size),
      row.uploader && row.uploader !== self ? peerLabel(row.uploader) : '',
    ].filter(Boolean).join(' · ');
    return (
      <div
        key={row.fileId}
        className={styles.row}
        data-version={row.fileId}
        data-version-current={isCurrent || undefined}
      >
        <div className={sheets.member}>
          <span className={sheets.memberText}>
            <span className={sheets.memberName}>{whenText(row.mtime)}</span>
            <span className={sheets.memberSub}>{facts}</span>
          </span>
          {(isText || onOpen) && (
            <button
              type="button"
              className={kit.chip}
              aria-pressed={isText ? shown?.fileId === row.fileId : undefined}
              data-file-id={row.fileId}
              data-version-open
              onClick={handleOpen}
            >
              {lang('Open')}
            </button>
          )}
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('ParvaneCloudDownload')}
            title={lang('ParvaneCloudDownload')}
            data-file-id={row.fileId}
            data-version-download
            onClick={handleDownload}
          >
            <PvIcon name="download" isSmall />
          </button>
        </div>
        {shown?.fileId === row.fileId && (
          <pre className={styles.text} data-version-text>
            {shown.text === undefined ? lang('Loading') : shown.text}
          </pre>
        )}
        {!isCurrent && canEdit && (
          <div className={styles.actions}>
            <button
              type="button"
              className={buildClassName(kit.btn, styles.restore)}
              disabled={Boolean(busyId)}
              data-file-id={row.fileId}
              data-version-restore
              onClick={handleRestore}
            >
              {lang('ParvaneCloudVersionRestore')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <PvSheet
      isOpen={Boolean(target && node)}
      title={node ? lang('ParvaneCloudVersionsTitle', { name: node.name }) : undefined}
      className={buildClassName(sheets.narrow, sheets.full)}
      onClose={handleClose}
    >
      <div className={styles.list} role="list" data-cloud-versions={node?.id}>
        {rows.map(renderRow)}
      </div>
      {rows.length < 2 && <div className={sheets.note}>{lang('ParvaneCloudVersionsEmpty')}</div>}
      <div className={sheets.note}>{lang('ParvaneCloudVersionsNote', { count: VERSIONS_KEEP })}</div>
    </PvSheet>
  );
};

export default memo(CloudVersionsDialog);
