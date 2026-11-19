import {
  useEffect, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import useLastCallback from '../../../hooks/useLastCallback';

type OutputDevices = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};

const mediaDevices = navigator.mediaDevices as OutputDevices | undefined;
const canSetSink = typeof HTMLMediaElement.prototype.setSinkId === 'function';

export default function useCallAudioOutput(isActive: boolean, localStream?: MediaStream) {
  const audioHostRef = useRef<HTMLDivElement>();
  const generationRef = useRef(0);
  const isSelectingRef = useRef(false);
  const [sinkId, setSinkId] = useState('');
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const [hasOutputError, setHasOutputError] = useState(false);

  useEffect(() => {
    if (!isActive || !canSetSink || !mediaDevices) return undefined;
    let isCurrent = true;
    const update = () => {
      void mediaDevices.enumerateDevices().then((devices) => {
        if (isCurrent) {
          setOutputs(devices.filter((device) => device.kind === 'audiooutput'
            && device.deviceId && device.deviceId !== 'default'));
        }
      }).catch(() => undefined);
    };
    update();
    mediaDevices.addEventListener('devicechange', update);
    return () => {
      isCurrent = false;
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

  const applyOutput = useLastCallback(async (nextId: string, started: number) => {
    const players = Array.from(audioHostRef.current?.querySelectorAll('audio') || []);
    const results = await Promise.allSettled(players.map((audio) => audio.setSinkId(nextId)));
    if (generationRef.current !== started) return;
    if (results.some((result) => result.status === 'rejected')) {
      await Promise.allSettled(players.map((audio) => audio.setSinkId(sinkId)));
      if (generationRef.current === started) setHasOutputError(true);
      return;
    }
    setSinkId(nextId);
    setIsOutputOpen(false);
  });

  const chooseOutput = useLastCallback(async (nextId: string) => {
    if (isSelectingRef.current) return;
    const started = generationRef.current;
    isSelectingRef.current = true;
    setHasOutputError(false);
    try {
      await applyOutput(nextId, started);
    } finally {
      if (generationRef.current === started) isSelectingRef.current = false;
    }
  });

  const toggleOutput = useLastCallback(async () => {
    if (isSelectingRef.current) return;
    setHasOutputError(false);
    if (!mediaDevices?.selectAudioOutput) {
      setIsOutputOpen(!isOutputOpen);
      return;
    }
    const started = generationRef.current;
    isSelectingRef.current = true;
    try {
      const output = await mediaDevices.selectAudioOutput();
      if (started === generationRef.current) await applyOutput(output.deviceId, started);
    } catch (error) {
      if (started === generationRef.current && !(error instanceof DOMException && error.name === 'NotAllowedError')) {
        setHasOutputError(true);
      }
    } finally {
      if (started === generationRef.current) isSelectingRef.current = false;
    }
  });

  const resetOutput = useLastCallback(() => {
    generationRef.current += 1;
    isSelectingRef.current = false;
    setSinkId('');
    setIsOutputOpen(false);
    setHasOutputError(false);
  });

  return {
    audioHostRef, sinkId, outputs, isOutputOpen, hasOutputError, chooseOutput, toggleOutput, resetOutput,
    closeOutput: () => setIsOutputOpen(false),
    canChooseOutput: canSetSink && (Boolean(mediaDevices?.selectAudioOutput) || Boolean(outputs.length)),
  };
}
