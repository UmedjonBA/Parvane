import decoderWorkerUrl from 'opus-recorder/dist/decoderWorker.min.js?url';
import waveWorkerUrl from 'opus-recorder/dist/waveWorker.min.js?url';

const SAMPLE_RATE = 48000;
const BIT_DEPTH = 16;
const CONVERT_TIMEOUT_MS = 30000;

export async function oggToWav(opusData: Blob): Promise<Blob> {
  const arrayBuffer = await new Response(opusData).arrayBuffer();

  return new Promise((resolve, reject) => {
    const typedArray = new Uint8Array(arrayBuffer);

    let decoderWorker: Worker | undefined = new Worker(decoderWorkerUrl);
    let wavWorker: Worker | undefined = new Worker(waveWorkerUrl);
    const cleanup = () => {
      clearTimeout(timeoutId);
      decoderWorker?.terminate();
      decoderWorker = undefined;
      wavWorker?.terminate();
      wavWorker = undefined;
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    // испорченный OGG: воркер падает или молчит — не зависаем и не держим воркеры
    decoderWorker.onerror = () => fail('OGG decoder failed');
    decoderWorker.onmessageerror = () => fail('OGG decoder message error');
    wavWorker.onerror = () => fail('WAV encoder failed');
    wavWorker.onmessageerror = () => fail('WAV encoder message error');
    const timeoutId = setTimeout(() => fail('OGG conversion timed out'), CONVERT_TIMEOUT_MS);

    decoderWorker.onmessage = (e) => {
      // eslint-disable-next-line no-null/no-null
      if (e.data === null) {
        // `null` means decoder is finished
        wavWorker?.postMessage({ command: 'done' });
      } else {
        // `e.data` contains decoded buffers as float32 values
        wavWorker?.postMessage(
          {
            command: 'encode',
            buffers: e.data,
          },
          e.data.map(({ buffer }: Float32Array) => buffer),
        );
      }
    };

    wavWorker.onmessage = (e) => {
      if (e.data.message === 'page') {
        resolve(new Blob([e.data.page], { type: 'audio/wav' }));
        cleanup();
      }
    };

    wavWorker.postMessage({
      command: 'init',
      wavBitDepth: BIT_DEPTH,
      wavSampleRate: SAMPLE_RATE,
    });

    decoderWorker.postMessage({
      command: 'init',
      decoderSampleRate: SAMPLE_RATE,
      outputBufferSampleRate: SAMPLE_RATE,
    });

    decoderWorker.postMessage({
      command: 'decode',
      pages: typedArray,
    }, [typedArray.buffer]);
  });
}
