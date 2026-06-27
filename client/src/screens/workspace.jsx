// WORKSPACE — Notes + Journal tab. Owns VaultCtx with live backend data.
// Two lenses over one vault: "journal" (diary) and "notes". Labels follow the
// MONOVIEW design (English). Folder structure is UI-only (localStorage); the
// backend stores only title + body per note.

const DEFAULT_FOLDERS = [
  { id: "f_inbox",  name: "00 inbox",   parent: null },
  { id: "f_daily",  name: "20 daily",   parent: null },
];
const SYSTEM_FOLDERS = ["f_inbox", "f_daily"];

function loadLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function WorkspaceScreen({ me }) {
  const liveAvail = window.PARVANE.available;
  const liveNotes = window.useLiveNotes();

  const [mode, setMode]           = useState("journal");
  const [activeId, setActiveId]   = useState(null);
  const [tagFilter, setTagFilter] = useState(null);
  const [query, setQuery]         = useState("");
  const [palette, setPalette]     = useState(false);
  const [menu, setMenu]           = useState(null); // {x,y,type,id,editing}
  const [toast, setToast]         = useState(null);
  // local optimistic overrides for instant UI updates
  const [localBodies, setLocalBodies] = useState({});
  const [localMoods,  setLocalMoods]  = useState({});
  // folder structure in localStorage (UI-only, no backend equivalent)
  const [folders, setFolders]     = useState(() => loadLS("pv_folders", DEFAULT_FOLDERS));
  const [noteFolder, setNoteFolder] = useState(() => loadLS("pv_note_folders", {}));
  const bodyTimers = useRef({});
  const toastTimer = useRef(null);

  const flash = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  // convert backend notes → vault format with local overrides
  const vaultNotes = useMemo(() =>
    (liveNotes.notes || [])
      .filter(n => !n.deleted)
      .map(n => {
        const vn = liveNoteToVault(n, localBodies[n.note_id], localMoods[n.note_id]);
        // apply user-assigned folder (unless daily, which always goes to f_daily)
        if (!vn.isDaily && noteFolder[n.note_id]) vn.folder = noteFolder[n.note_id];
        return vn;
      }),
    [liveNotes.notes, localBodies, localMoods, noteFolder]
  );

  const notesById = useMemo(() =>
    Object.fromEntries(vaultNotes.map(n => [n.id, n])),
    [vaultNotes]
  );

  const tagCounts = useMemo(() => {
    const c = {};
    vaultNotes.forEach(n => noteTags(n).forEach(t => { c[t] = (c[t] || 0) + 1; }));
    return c;
  }, [vaultNotes]);

  const graph = useMemo(() => computeGraph(vaultNotes), [vaultNotes]);

  // ── actions ──────────────────────────────────────────────────────────────

  const openNote = useCallback((id) => { setActiveId(id); setMode("notes"); }, []);

  // assign note to folder in local state
  const setNoteToFolder = useCallback((noteId, folderId) => {
    setNoteFolder(prev => {
      const next = { ...prev, [noteId]: folderId };
      saveLS("pv_note_folders", next);
      return next;
    });
  }, []);

  const openByTitle = useCallback((title) => {
    const found = vaultNotes.find(n => n.title.toLowerCase() === title.toLowerCase());
    if (found) { openNote(found.id); return; }
    liveNotes.create(title)
      .then(id => { if (id) { setNoteToFolder(id, "f_inbox"); openNote(id); flash(`created note “${title}”`); } })
      .catch(console.error);
  }, [vaultNotes, liveNotes, openNote, setNoteToFolder, flash]);

  // debounced body save with instant local update
  const updateBody = useCallback((id, body) => {
    setLocalBodies(prev => ({ ...prev, [id]: body }));
    clearTimeout(bodyTimers.current[id]);
    bodyTimers.current[id] = setTimeout(() => {
      const note = liveNotes.notes.find(n => n.note_id === id);
      if (note) liveNotes.save(id, note.title, body).catch(console.error);
    }, 1500);
  }, [liveNotes]);

  // Ctrl+S — мгновенно сбросить отложенное автосохранение и записать сейчас.
  const saveNow = useCallback((id) => {
    if (!id) return;
    clearTimeout(bodyTimers.current[id]);
    const note = liveNotes.notes.find(n => n.note_id === id);
    if (!note) return;
    const body = localBodies[id] !== undefined ? localBodies[id] : (note.text || "");
    liveNotes.save(id, note.title, body).then(() => flash("saved ✓")).catch(console.error);
  }, [liveNotes, localBodies, flash]);

  // create a NEW journal entry — always a distinct note (never overwrites a date).
  // Mood stored in title: "YYYY-MM-DD moodkey".
  const createDaily = useCallback(async ({ date, mood, body }) => {
    const title = mood ? `${date} ${mood}` : date;
    const id = await liveNotes.create(title).catch(() => null);
    if (id) {
      setLocalBodies(prev => ({ ...prev, [id]: body }));
      setLocalMoods(prev => ({ ...prev, [id]: mood }));
      await liveNotes.save(id, title, body).catch(console.error);
      setActiveId(id);
    }
    flash(`journal entry ${date} saved`);
    return id;
  }, [liveNotes, flash]);

  // change the mood of an existing journal entry, addressed by note id
  const updateDailyMood = useCallback((id, date, mood) => {
    const note = liveNotes.notes.find(n => n.note_id === id);
    if (!note) return;
    const title = mood ? `${date} ${mood}` : date;
    const body = localBodies[id] !== undefined ? localBodies[id] : (note.text || "");
    setLocalMoods(prev => ({ ...prev, [id]: mood }));
    liveNotes.save(id, title, body).catch(console.error);
  }, [liveNotes, localBodies]);

  // create note in a folder
  const createNote = useCallback(async (folderId, title) => {
    const t = title || "untitled";
    const id = await liveNotes.create(t).catch(() => null);
    if (id) {
      setNoteToFolder(id, folderId || "f_inbox");
      setActiveId(id);
      setMode("notes");
      flash(`new note in ${folders.find(f => f.id === folderId)?.name || folderId || "inbox"}`);
    }
    return id;
  }, [liveNotes, setNoteToFolder, folders, flash]);

  // rename note title
  const renameNote = useCallback((id, title) => {
    const note = liveNotes.notes.find(n => n.note_id === id);
    if (!note || !title.trim()) return;
    const body = localBodies[id] !== undefined ? localBodies[id] : (note.text || "");
    liveNotes.save(id, title.trim(), body).catch(console.error);
  }, [liveNotes, localBodies]);

  // delete note
  const deleteNote = useCallback(async (id) => {
    await liveNotes.remove(id).catch(console.error);
    if (activeId === id) setActiveId(null);
    flash("note deleted");
  }, [liveNotes, activeId, flash]);

  // add tag to note body
  const addTag = useCallback((id, tag) => {
    const note = vaultNotes.find(n => n.id === id);
    if (!note) return;
    const tagStr = tag.startsWith("#") ? tag : `#${tag}`;
    if (noteTags(note).includes(tagStr)) return;
    updateBody(id, (note.body || "").replace(/\s*$/, "") + "\n" + tagStr);
    flash(`tagged ${tagStr}`);
  }, [vaultNotes, updateBody, flash]);

  // remove tag from note body
  const removeTag = useCallback((id, tag) => {
    const note = vaultNotes.find(n => n.id === id);
    if (!note) return;
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const newBody = (note.body || "").replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "g"), " ")
      .replace(/[ \t]+\n/g, "\n").trim();
    updateBody(id, newBody);
  }, [vaultNotes, updateBody]);

  // folder management (localStorage only)
  const createFolder = useCallback((name, parent = null) => {
    const id = "f_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    setFolders(prev => {
      const next = [...prev, { id, name: name || "new-folder", parent }];
      saveLS("pv_folders", next);
      return next;
    });
    flash(`folder “${name || "new-folder"}” created`);
    return id;
  }, [flash]);

  const renameFolder = useCallback((id, name) => {
    setFolders(prev => {
      const next = prev.map(f => f.id === id ? { ...f, name } : f);
      saveLS("pv_folders", next);
      return next;
    });
  }, []);

  const deleteFolder = useCallback((id) => {
    if (SYSTEM_FOLDERS.includes(id)) { flash("cannot delete system folder"); return; }
    setFolders(prev => {
      const next = prev.filter(f => f.id !== id && f.parent !== id);
      saveLS("pv_folders", next);
      return next;
    });
    // notes assigned to the folder (or its subfolders) fall back to inbox
    setNoteFolder(prev => {
      const removed = new Set([id, ...folders.filter(f => f.parent === id).map(f => f.id)]);
      const next = {};
      Object.keys(prev).forEach(k => { if (!removed.has(prev[k])) next[k] = prev[k]; });
      saveLS("pv_note_folders", next);
      return next;
    });
    flash("folder deleted");
  }, [folders, flash]);

  // workspace-level keyboard: [g]/[j] mode, Ctrl+P palette, Esc closes overlays
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyP") {
        e.preventDefault(); setPalette(p => !p); return;
      }
      if (e.key === "Escape") { setPalette(false); setMenu(null); return; }
      if (e.code === "KeyG") setMode("notes");
      if (e.code === "KeyJ") setMode("journal");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = notesById[activeId] || null;

  const ctx = {
    // data
    notes: vaultNotes, notesById,
    active, activeId,
    folders,
    tagCounts, graph,
    // ui state
    mode, setMode,
    tagFilter, setTagFilter,
    query, setQuery,
    menu, setMenu,
    menuEditingFor: menu && menu.editing ? menu.id : null,
    // actions
    openNote, openByTitle,
    updateBody, saveNow, createDaily, updateDailyMood,
    createNote, renameNote, deleteNote,
    setNoteToFolder,
    addTag, removeTag,
    createFolder, renameFolder, deleteFolder,
    liveNotes,
    flash, setPalette,
  };

  const dailyCount = vaultNotes.filter(n => n.isDaily).length;
  const tagsCount  = Object.keys(tagCounts).length;

  return (
    <VaultCtx.Provider value={ctx}>
      <div className="ws-screen" onClick={() => menu && setMenu(null)}>
        <div className="ws-modebar">
          <div className="ws-modes">
            <button className={"ws-mode" + (mode === "journal" ? " on" : "")} onClick={() => setMode("journal")}>
              <span className="k">[j]</span> JOURNAL
            </button>
            <button className={"ws-mode" + (mode === "notes" ? " on" : "")} onClick={() => setMode("notes")}>
              <span className="k">[g]</span> NOTES
            </button>
          </div>
          <div className="ws-context muted">
            {mode === "journal"
              ? `${dailyCount} entries · daily notes`
              : `vault://monolith · ${vaultNotes.length} notes · ${folders.length} folders · ${tagsCount} tags`}
          </div>
          <div className="ws-cross">
            {liveAvail && (
              <button className="btn" onClick={() => setPalette(true)}>[Ctrl+P] palette</button>
            )}
            {mode === "journal"
              ? <button className="btn primary" onClick={() => setMode("notes")}>open vault →</button>
              : <button className="btn primary" onClick={() => setMode("journal")}>← journal</button>}
          </div>
        </div>

        <div className="ws-body">
          {mode === "notes"
            ? <NotesScreen me={me} />
            : <DiaryScreen />}
        </div>

        {palette && <WsPalette ctx={ctx} onClose={() => setPalette(false)} />}
        {menu && <ContextMenu menu={menu} ctx={ctx} />}
        {toast && <div className="ws-toast">{toast}</div>}
      </div>
    </VaultCtx.Provider>
  );
}

// ── command palette ──────────────────────────────────────────────────────────
function WsPalette({ ctx, onClose }) {
  const [q, setQ] = useState("");
  const inputRef  = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ql   = q.toLowerCase();
  const hits = ctx.notes.filter(n => n.title.toLowerCase().includes(ql)).slice(0, 6);
  const commands = [
    { label: "Create note: " + (q || "…"), hint: "new", run: () => { ctx.createNote("f_inbox", q || "untitled"); onClose(); } },
    { label: "Create folder: " + (q || "…"), hint: "new", run: () => { ctx.createFolder(q || "new-folder"); onClose(); } },
    { label: "New journal entry", hint: "journal", run: () => { ctx.setMode("journal"); onClose(); ctx.flash("compose a journal entry"); } },
  ].filter(c => !q || c.label.toLowerCase().includes(ql));

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <div className="palette-input">
          <span style={{ color: "var(--orange)" }}>⌘</span>
          <input
            ref={inputRef}
            className="form-input"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="type to search notes or create…"
            onKeyDown={e => {
              if (e.key === "Enter") {
                if (hits[0]) { ctx.openNote(hits[0].id); onClose(); }
                else commands[0]?.run();
              }
            }}
          />
          <span className="muted">esc</span>
        </div>
        {hits.length > 0 && (
          <div className="palette-group">
            <div className="palette-head muted">NOTES</div>
            {hits.map(n => (
              <button key={n.id} className="palette-row" onClick={() => { ctx.openNote(n.id); onClose(); }}>
                <span className="vault-glyph" style={{ color: n.isDaily ? "var(--muted)" : "var(--aqua)" }}>
                  {n.isDaily ? "◆" : "md"}
                </span>
                <span>{n.title}</span>
                <span className="muted" style={{ marginLeft: "auto" }}>
                  {ctx.folders.find(f => f.id === n.folder)?.name}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="palette-group">
          <div className="palette-head muted">ACTIONS</div>
          {commands.map((c, i) => (
            <button key={i} className="palette-row" onClick={c.run}>
              <span style={{ color: "var(--yellow)" }}>›</span>
              <span>{c.label}</span>
              <span className="muted" style={{ marginLeft: "auto" }}>{c.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── right-click context menu on the vault tree ────────────────────────────────
function ContextMenu({ menu, ctx }) {
  const isFolder = menu.type === "folder";
  const note = !isFolder ? ctx.notesById[menu.id] : null;
  const moveTargets = ctx.folders.filter(f => !note || f.id !== note.folder);

  const items = isFolder
    ? [
        { label: "New note here", run: () => ctx.createNote(menu.id) },
        { label: "New subfolder",  run: () => ctx.createFolder("subfolder", menu.id) },
        { label: "Rename",         run: () => ctx.setMenu({ ...menu, editing: true }) },
        { label: "Delete folder", danger: true, run: () => ctx.deleteFolder(menu.id) },
      ]
    : [
        { label: "Open",   run: () => ctx.openNote(menu.id) },
        { label: "Rename", run: () => ctx.setMenu({ ...menu, editing: true }) },
        { label: "Add tag #", run: () => ctx.addTag(menu.id, "tag") },
        { label: "Delete note", danger: true, run: () => ctx.deleteNote(menu.id) },
      ];

  // rename uses the inline editor in the tree (menuEditingFor) — keep menu open
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
      {items.map((it, i) => (
        <button key={i} className={"ctx-item" + (it.danger ? " danger" : "")}
          onClick={() => { it.run(); if (it.label !== "Rename") ctx.setMenu(null); }}>
          {it.label}
        </button>
      ))}
      {!isFolder && note && moveTargets.length > 0 && (
        <>
          <div className="ctx-sep" />
          <div className="ctx-head">MOVE TO</div>
          {moveTargets.map(f => (
            <button key={f.id} className="ctx-item"
              onClick={() => { ctx.setNoteToFolder(menu.id, f.id); ctx.flash(`moved to ${f.name}`); ctx.setMenu(null); }}>
              {f.name}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

window.WorkspaceScreen = WorkspaceScreen;
