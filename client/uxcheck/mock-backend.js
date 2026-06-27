// In-memory stand-in for the Parvane Tauri backend, used by the headless UX
// harness. By defining window.__TAURI__ BEFORE live.jsx runs, the real
// `useLiveNotes` hook (and window.PARVANE) light up with available=true and
// route every call through this mock — so we exercise the actual UI code path.
(function () {
  const notes = [];          // { note_id, title, text, deleted }
  let seq = 0;
  // monotonically increasing, lexicographically sortable id (mimics UUIDv7 order)
  const newId = () =>
    "note-" + String(Date.now()).slice(-9) + "-" + String(++seq).padStart(6, "0");

  const handlers = {
    nats_status:       () => true,
    current_user:      () => "tester@local",
    login:             () => true,
    logout:            () => null,
    get_conversations: () => [],
    get_messages:      () => [],
    sync_messages:     () => [],
    list_events:       () => [],
    list_files:        () => ({ files: [] }),
    call_history:      () => ({ calls: [] }),

    list_notes: () => notes.map((n) => ({ ...n })),
    create_note: ({ title }) => {
      const note_id = newId();
      notes.push({ note_id, title: title || "untitled", text: "", deleted: false });
      return note_id;
    },
    save_note: ({ id, title, body }) => {
      const n = notes.find((x) => x.note_id === id);
      if (n) { n.title = title; n.text = body; }
      return null;
    },
    delete_note: ({ id }) => {
      const n = notes.find((x) => x.note_id === id);
      if (n) n.deleted = true;
      return null;
    },
  };

  window.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
        const h = handlers[cmd];
        if (!h) return Promise.resolve(null);
        try { return Promise.resolve(h(args || {})); }
        catch (e) { return Promise.reject(e); }
      },
    },
  };

  // expose the raw store so the test runner can assert backend state directly
  window.__MOCK_NOTES__ = notes;
})();
