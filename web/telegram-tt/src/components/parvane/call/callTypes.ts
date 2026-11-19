// Состояние звонка, которое провайдер кладёт в `window.parvaneCall` (`api/parvane/calls.ts`)
export type CallInfo = {
  state: string;
  peerName?: string;
  incoming?: { from: string; callId: string; media: string };
  remoteStream?: MediaStream;
  localStream?: MediaStream;
  sas?: string;
  hasSecurityError?: boolean;
  isMuted?: boolean;
  isCameraOff?: boolean;
  isRemoteMuted?: boolean;
  isRemoteCameraOff?: boolean;
  groupVideoMuted?: Record<string, boolean>;
  screenStream?: MediaStream;
  canShareScreen?: boolean;
  hasScreenShareError?: boolean;
  pendingGroup?: boolean;
  pendingGroupTitle?: string;
  group?: {
    groupCallId: string;
    title: string;
    peerStates: Record<string, string>;
    peerNames: Record<string, string>;
  };
  groupStreams?: Record<string, MediaStream>;
};

const SECONDS_IN_MINUTE = 60;

export function getWindowCall(): CallInfo | undefined {
  return (window as unknown as { parvaneCall?: CallInfo }).parvaneCall;
}

export function formatCallDuration(seconds: number) {
  const minutes = Math.floor(seconds / SECONDS_IN_MINUTE);
  const rest = seconds % SECONDS_IN_MINUTE;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function getCallInitial(name: string) {
  return name.trim().charAt(0).toUpperCase();
}

export function hasVideoTrack(stream?: MediaStream) {
  return Boolean(stream?.getVideoTracks().length);
}
