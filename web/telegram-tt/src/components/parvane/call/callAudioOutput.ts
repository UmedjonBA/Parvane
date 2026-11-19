type AudioOutputOptions = {
  getPlayers: () => Pick<HTMLMediaElement, 'setSinkId'>[];
  onSelecting: () => void;
  onSelected: (sinkId: string) => void;
  onError: () => void;
};

export function createCallAudioOutput(options: AudioOutputOptions) {
  let sinkId = '';
  let generation = 0;
  let isSelecting = false;

  async function chooseOutput(selection: string | (() => Promise<string>)) {
    if (isSelecting) return;
    isSelecting = true;
    const started = generation;
    options.onSelecting();

    try {
      const nextId = typeof selection === 'string' ? selection : await selection();
      if (started !== generation) return;
      const players = options.getPlayers();
      const results = await Promise.allSettled(players.map((player) => player.setSinkId(nextId)));
      if (started !== generation) return;
      if (results.some((result) => result.status === 'rejected')) {
        await Promise.allSettled(players.map((player) => player.setSinkId(sinkId)));
        if (started === generation) options.onError();
        return;
      }
      sinkId = nextId;
      options.onSelected(sinkId);
    } catch (error) {
      if (started === generation && !(error instanceof DOMException && error.name === 'NotAllowedError')) {
        options.onError();
      }
    } finally {
      if (started === generation) isSelecting = false;
    }
  }

  function reset() {
    generation += 1;
    isSelecting = false;
    sinkId = '';
  }

  return { chooseOutput, reset };
}
