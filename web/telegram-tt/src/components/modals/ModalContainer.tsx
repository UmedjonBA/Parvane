import { type FC, memo } from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import type { TabState } from '../../global/types';

import { selectCanAnimateInterface, selectTabState } from '../../global/selectors';
import { pick } from '../../util/iteratees';

import useCurrentOrPrev from '../../hooks/useCurrentOrPrev';
import useShowTransition from '../../hooks/useShowTransition';

import VerificationMonetizationModal from '../common/VerificationMonetizationModal.async';
import SafeLinkModal from '../main/SafeLinkModal.async';
import AiTonePreviewModal from './aiTonePreview/AiTonePreviewModal.async';
import BirthdaySetupModal from './birthday/BirthdaySetupModal.async';
import BrowserModal from './browser/BrowserModal.async';
import ChatInviteModal from './chatInvite/ChatInviteModal.async';
import DeleteAccountModal from './deleteAccount/DeleteAccountModal.async';
import MapModal from './map/MapModal.async';
import PollModal from './poll/PollModal.async';
import QrCodeModal from './qrCode/QrCodeModal.async';
import QuickPreviewModal from './quickPreview/QuickPreviewModal.async';
import EditRankModal from './rank/EditRankModal.async';
import RankModal from './rank/RankModal.async';
import ReportModal from './reportModal/ReportModal.async';

// `Pick` used only to provide tab completion
type ModalKey = keyof Pick<TabState,
  'safeLinkModalUrl' |
  'mapModal' |
  'reportModal' |
  'pollModal' |
  'browser' |
  'chatInviteModal' |
  'monetizationVerificationModal' |
  'deleteAccountModal' |
  'qrCodeModal' |
  'quickPreview' |
  'birthdaySetupModal' |
  'editRankModal' |
  'rankModal' |
  'aiTonePreviewModal'
>;
type WrappedModalKey = 'pollModal' | 'mapModal' | 'safeLinkModalUrl';
type LegacyModalKey = Exclude<ModalKey, WrappedModalKey>;

type ModalStateProps = {
  [K in ModalKey]?: TabState[K];
};
type StateProps = ModalStateProps & {
  shouldAnimateInterface: boolean;
};
type LegacyModalRegistry = {
  [K in LegacyModalKey]: FC<{
    modal: TabState[K];
  }>;
};
type WrappedModalRegistry = {
  [K in WrappedModalKey]: FC<{
    modal: NonNullable<TabState[K]>;
    isOpen: boolean;
  }>;
};
type Entries<T> = {
  [K in keyof T]: [K, T[K]];
}[keyof T][];

const WRAPPED_MODAL_CLOSE_DURATION = 200;
const WRAPPED_MODAL_CLOSE_DURATIONS: Record<WrappedModalKey, number> = {
  pollModal: WRAPPED_MODAL_CLOSE_DURATION,
  mapModal: WRAPPED_MODAL_CLOSE_DURATION,
  safeLinkModalUrl: WRAPPED_MODAL_CLOSE_DURATION,
};

type WrappedModalBoundaryProps<T> = {
  modal: T;
  ModalComponent: FC<{
    modal: NonNullable<T>;
    isOpen: boolean;
  }>;
  closeDuration: number;
  shouldAnimateInterface: boolean;
};

const WrappedModalBoundary = <T,>({
  modal,
  ModalComponent,
  closeDuration,
  shouldAnimateInterface,
}: WrappedModalBoundaryProps<T>) => {
  const isOpen = Boolean(modal);
  const renderingModal = useCurrentOrPrev(modal, true);
  const { shouldRender } = useShowTransition({
    isOpen,
    withShouldRender: true,
    closeDuration,
    noCloseTransition: !shouldAnimateInterface,
  });

  if (!shouldRender || !renderingModal) {
    return undefined;
  }

  return <ModalComponent modal={renderingModal} isOpen={isOpen} />;
};

const LEGACY_MODALS: LegacyModalRegistry = {
  reportModal: ReportModal,
  browser: BrowserModal,
  chatInviteModal: ChatInviteModal,
  monetizationVerificationModal: VerificationMonetizationModal,
  deleteAccountModal: DeleteAccountModal,
  qrCodeModal: QrCodeModal,
  quickPreview: QuickPreviewModal,
  birthdaySetupModal: BirthdaySetupModal,
  editRankModal: EditRankModal,
  rankModal: RankModal,
  aiTonePreviewModal: AiTonePreviewModal,
};
const WRAPPED_MODALS: WrappedModalRegistry = {
  pollModal: PollModal,
  mapModal: MapModal,
  safeLinkModalUrl: SafeLinkModal,
};

const LEGACY_MODAL_KEYS = Object.keys(LEGACY_MODALS) as LegacyModalKey[];
const WRAPPED_MODAL_KEYS = Object.keys(WRAPPED_MODALS) as WrappedModalKey[];
const MODAL_KEYS = [...LEGACY_MODAL_KEYS, ...WRAPPED_MODAL_KEYS] as ModalKey[];

const LEGACY_MODAL_ENTRIES = Object.entries(LEGACY_MODALS) as Entries<LegacyModalRegistry>;
const WRAPPED_MODAL_ENTRIES = Object.entries(WRAPPED_MODALS) as Entries<WrappedModalRegistry>;

function renderWrappedModal<K extends WrappedModalKey>(
  key: K,
  ModalComponent: WrappedModalRegistry[K],
  modal: TabState[K],
  shouldAnimateInterface: boolean,
) {
  return (
    <WrappedModalBoundary<TabState[K]>
      key={key}
      modal={modal}
      ModalComponent={ModalComponent}
      closeDuration={WRAPPED_MODAL_CLOSE_DURATIONS[key]}
      shouldAnimateInterface={shouldAnimateInterface}
    />
  );
}

const ModalContainer = (modalProps: StateProps) => {
  const { shouldAnimateInterface } = modalProps;

  return [
    ...LEGACY_MODAL_ENTRIES.map(([key, ModalComponent]) => (
      // @ts-ignore -- TS does not preserve tuple types in `map` callbacks
      <ModalComponent key={key} modal={modalProps[key]} />
    )),
    ...WRAPPED_MODAL_ENTRIES.map(([key, ModalComponent]) => {
      return renderWrappedModal(key, ModalComponent, modalProps[key], shouldAnimateInterface);
    }),
  ];
};

export default memo(withGlobal(
  (global): Complete<StateProps> => ({
    ...(pick(selectTabState(global), MODAL_KEYS) as Complete<ModalStateProps>),
    shouldAnimateInterface: selectCanAnimateInterface(global),
  }),
)(ModalContainer));
