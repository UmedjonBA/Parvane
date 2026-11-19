import {
  useEffect, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import { createCallAudioOutput } from './callAudioOutput';

import useLastCallback from '../../../hooks/useLastCallback';

type OutputDevices = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};

const mediaDevices = navigator.mediaDevices as OutputDevices | undefined;
const canSetSink = typeof HTMLMediaElement.prototype.setSinkId === 'function';

export default function useCallAudioOutput(isActive: boolean, localStream?: MediaStream) {
  const audioHostRef = useRef<HTMLDivElement>();
  const [sinkId, setSinkId] = useState('');
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const [hasOutputError, setHasOutputError] = useState(false);

  const [routing] = useState(() => createCallAudioOutput({
    getPlayers: () => Array.from(audioHostRef.current?.querySelectorAll('audio') || []),
    onSelecting: () => setHasOutputError(false),
    onSelected: (selectedId) => {
      setSinkId(selectedId);
      setIsOutputOpen(false);
    },
    onError: () => setHasOutputError(true),
  }));

  useEffect(() => {
    if (!isActive || !canSetSink || !mediaDevices) return undefined;
    let request = 0;
    const update = () => {
      const started = ++request;
      void mediaDevices.enumerateDevices().then((devices) => {
        if (started === request) {
          setOutputs(devices.filter((device) => device.kind === 'audiooutput'
            && device.deviceId && device.deviceId !== 'default'));
        }
      }).catch(() => undefined);
    };
    update();
    mediaDevices.addEventListener('devicechange', update);
    return () => {
      request += 1;
      mediaDevices.removeEventListener('devicechange', update);
      setOutputs([]);
    };
  }, [isActive, localStream]);

  useLayoutEffect(() => {
    if (!isOutputOpen) return undefined;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setIsOutputOpen(false);
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [isOutputOpen]);

  const toggleOutput = useLastCallback(() => {
    const selectAudioOutput = mediaDevices?.selectAudioOutput;
    if (selectAudioOutput) {
      return routing.chooseOutput(async () => (await selectAudioOutput.call(mediaDevices)).deviceId);
    }
    setHasOutputError(false);
    setIsOutputOpen(!isOutputOpen);
    return undefined;
  });

  const resetOutput = useLastCallback(() => {
    routing.reset();
    setSinkId('');
    setIsOutputOpen(false);
    setHasOutputError(false);
  });

  return {
    audioHostRef,
    sinkId,
    outputs,
    isOutputOpen,
    hasOutputError,
    chooseOutput: routing.chooseOutput,
    toggleOutput,
    resetOutput,
    closeOutput: () => setIsOutputOpen(false),
    canChooseOutput: canSetSink && (Boolean(mediaDevices?.selectAudioOutput) || Boolean(outputs.length)),
  };
}
