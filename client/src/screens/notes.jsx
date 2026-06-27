// NOTES screen — реальные заметки через notes-шард (RGA CRDT).

function NotesScreen({ me }) {
  const liveAvail = window.PARVANE.available;

  // Живые данные из бэкенда
  const liveNotes = liveAvail ? window.useLiveNotes() : null;

  // Список заметок: реальные или демо-данные
  const notesList = liveAvail && liveNotes
    ? liveNotes.notes
    : Object.values(MONO_DATA.vault.notes || {}).map((n) => ({
        note_id: n.id || n.title,
        title:   n.title,
        text:    n.body,
        deleted: false,
      }));

  const [selId, setSelId]   = useState(null);
  const [draft, setDraft]   = useState("");         // текущий текст в редакторе
  const [titleDraft, setTitleDraft] = useState(""); // заголовок
  const [viewMode, setViewMode] = useState("split");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const saveTimer = useRef(null);

  // Выбираем первую заметку по умолчанию
  useEffect(() => {
    if (!selId && notesList.length > 0) {
      const first = notesList[0];
      setSelId(first.note_id);
      setDraft(first.text || "");
      setTitleDraft(first.title || "");
    }
  }, [notesList.length]);

  // При смене выбранной заметки — загружаем её текст
  const selNote = notesList.find((n) => n.note_id === selId);
  useEffect(() => {
    if (selNote) {
      setDraft(selNote.text || "");
      setTitleDraft(selNote.title || "");
    }
  }, [selId]);

  // Автосохранение с дебаунсом 1.5 с
  const onBodyChange = (val) => {
    setDraft(val);
    if (!liveAvail || !selId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await liveNotes.save(selId, titleDraft, val);
      } catch (e) {
        console.error("[notes] save:", e);
      }
    }, 1500);
  };

  const onTitleChange = (val) => {
    setTitleDraft(val);
    if (!liveAvail || !selId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await liveNotes.save(selId, val, draft);
      } catch (e) {
        console.error("[notes] save title:", e);
      }
    }, 1500);
  };

  const createNote = async () => {
    const t = newTitle.trim() || "Без названия";
    if (!liveAvail) return;
    try {
      const id = await liveNotes.create(t);
      setSelId(id);
      setDraft("");
      setTitleDraft(t);
      setNewTitle("");
      setCreating(false);
    } catch (e) {
      console.error("[notes] create:", e);
    }
  };

  const deleteNote = async (note_id) => {
    if (!liveAvail) return;
    if (!confirm("Удалить заметку?")) return;
    try {
      await liveNotes.remove(note_id);
      if (selId === note_id) {
        setSelId(null);
        setDraft("");
        setTitleDraft("");
      }
    } catch (e) {
      console.error("[notes] delete:", e);
    }
  };

  // Фильтрация по поиску
  const visible = notesList.filter((n) =>
    !search || n.title.toLowerCase().includes(search.toLowerCase()) ||
    (n.text || "").toLowerCase().includes(search.toLowerCase())
  );

  const vault = liveAvail ? { backlinks: [], outgoing: [], graph: { nodes: [], edges: [] } } : MONO_DATA.vault;

  return (
    <div className="notes-screen">
      {/* LEFT: список заметок */}
      <div className="notes-tree col">
        <Panel
          title="ЗАМЕТКИ"
          sub={`${notesList.length} файлов`}
          hint="↑↓ · [Enter] открыть · [n] новая"
        >
          <div className="vault-search">
            <span className="muted">[/]</span>
            <input
              className="form-input"
              placeholder="поиск…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="hr" />

          {/* Новая заметка */}
          {creating && (
            <div style={{ padding: "4px 0", display: "flex", gap: 6 }}>
              <input
                className="form-input"
                placeholder="название…"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createNote();
                  if (e.key === "Escape") setCreating(false);
                }}
                autoFocus
                style={{ flex: 1 }}
              />
              <button className="btn primary" onClick={createNote}>✓</button>
              <button className="btn" onClick={() => setCreating(false)}>✕</button>
            </div>
          )}

          <div className="vault-tree">
            {visible.map((n) => (
              <button
                key={n.note_id}
                className={"vault-row" + (n.note_id === selId ? " sel" : "")}
                style={{ paddingLeft: 10 }}
                onClick={() => setSelId(n.note_id)}
              >
                <span className="muted" style={{ width: 10 }}>·</span>
                <span className="vault-glyph" style={{ color: "var(--aqua)" }}>md</span>
                <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {n.title || "Без названия"}
                </span>
                {liveAvail && (
                  <span
                    className="muted"
                    style={{ fontSize: 10, cursor: "pointer", padding: "0 4px" }}
                    onClick={(e) => { e.stopPropagation(); deleteNote(n.note_id); }}
                    title="удалить"
                  >✕</span>
                )}
              </button>
            ))}
            {visible.length === 0 && (
              <div className="muted" style={{ padding: "8px 10px", fontSize: 12 }}>
                {liveAvail && !liveNotes?.loading ? "нет заметок" : "загрузка…"}
              </div>
            )}
          </div>

          <div className="hr" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => liveAvail ? setCreating(true) : null}>[n] новая</button>
            {liveAvail && liveNotes?.refresh && (
              <button className="btn" onClick={liveNotes.refresh}>[r] refresh</button>
            )}
          </div>
        </Panel>

        <Panel title="ТЕГИ" sub="…">
          <div className="tag-cloud">
            {[
              ["#project", "orange"],["#wip", "yellow"],["#study", "blue"],
              ["#idea", "purple"],["#daily", "muted"],
            ].map(([t, c]) => (
              <button key={t} className="tag-pill" style={{ color: `var(--${c})` }}>{t}</button>
            ))}
          </div>
        </Panel>
      </div>

      {/* CENTER: редактор */}
      <div className="notes-center col">
        {selNote ? (
          <Panel
            title={titleDraft || "ЗАМЕТКА"}
            sub={liveAvail ? "notes-шард · RGA CRDT" : (selNote.path || "")}
            hint="[Tab] focus  [g] graph"
            focused
          >
            <div className="note-toolbar">
              {liveAvail ? (
                <input
                  className="form-input"
                  style={{ flex: 1, fontWeight: 700, color: "var(--text-strong)" }}
                  value={titleDraft}
                  onChange={(e) => onTitleChange(e.target.value)}
                  placeholder="заголовок…"
                />
              ) : (
                <div className="tag-cloud">
                  {(selNote.tags || []).map((t) => (
                    <span key={t} className="tag-pill" style={{ color: "var(--orange)" }}>{t}</span>
                  ))}
                </div>
              )}
              <div className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
                {liveNotes?.saving ? "сохраняю…" : (draft.length + " симв.")}
              </div>
              <button className={"btn" + (viewMode === "split" ? " primary" : "")} onClick={() => setViewMode("split")}>[s] split</button>
              <button className={"btn" + (viewMode === "graph" ? " primary" : "")} onClick={() => setViewMode("graph")}>[g] граф</button>
            </div>
            <div className="hr" />
            {viewMode === "split" ? (
              <div className="note-split">
                <div className="note-src">
                  {liveAvail ? (
                    <textarea
                      className="note-editor"
                      value={draft}
                      onChange={(e) => onBodyChange(e.target.value)}
                      placeholder="начните писать…"
                      style={{
                        width: "100%",
                        height: "100%",
                        background: "transparent",
                        border: "none",
                        color: "var(--text)",
                        fontFamily: "inherit",
                        fontSize: "inherit",
                        resize: "none",
                        outline: "none",
                        padding: 0,
                      }}
                    />
                  ) : (
                    <NoteSource body={selNote.body || selNote.text || ""} />
                  )}
                </div>
                <div className="note-preview">
                  <NotePreview body={draft} />
                </div>
              </div>
            ) : (
              <GraphView graph={vault.graph} activeId={titleDraft} />
            )}
          </Panel>
        ) : (
          <Panel title="ЗАМЕТКИ" focused>
            <div className="thread-empty">
              <div className="muted" style={{ textAlign: "center", paddingTop: 40 }}>
                выберите заметку или создайте новую [n]
              </div>
            </div>
          </Panel>
        )}
      </div>

      {/* RIGHT: метаданные */}
      <div className="notes-right col">
        <Panel title="СВЯЗИ" sub="backlinks">
          <div className="rowlist">
            {(vault.backlinks || []).map((b) => (
              <div key={b} className="row">
                <span className="marker">▌</span>
                <span style={{ color: "var(--purple)" }}>[[{b}]]</span>
                <span className="muted" style={{ marginLeft: "auto" }}>2</span>
              </div>
            ))}
            {(!vault.backlinks || vault.backlinks.length === 0) && (
              <div className="muted" style={{ fontSize: 12 }}>нет ссылок</div>
            )}
          </div>
        </Panel>

        <Panel title="ИСХОДЯЩИЕ" sub="links">
          <div className="rowlist">
            {(vault.outgoing || []).map((b) => (
              <div key={b} className="row">
                <span className="marker">▌</span>
                <span style={{ color: "var(--aqua)" }}>→ [[{b}]]</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="СТРУКТУРА" sub="">
          <div className="rowlist outline">
            {draft.split("\n").filter((l) => l.startsWith("#")).map((l, i) => {
              const level = l.match(/^#+/)?.[0].length || 1;
              return (
                <div key={i} className="row" style={{ paddingLeft: (level - 1) * 14 }}>
                  <span style={{ color: level === 1 ? "var(--yellow)" : "var(--orange)" }}>{"#".repeat(level)}</span>{" "}
                  <span className="strong">{l.replace(/^#+\s*/, "")}</span>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function NoteSource({ body }) {
  const lines = (body || "").split("\n");
  return (
    <pre className="note-code">
      {lines.map((ln, i) => (
        <div key={i} className="code-line">
          <span className="line-no muted">{String(i + 1).padStart(3, " ")}</span>
          <span className="line-body">{highlightMd(ln)}</span>
        </div>
      ))}
    </pre>
  );
}

function highlightMd(line) {
  if (line.startsWith("# "))    return <span style={{ color: "var(--yellow)", fontWeight: 700 }}>{line}</span>;
  if (line.startsWith("## "))   return <span style={{ color: "var(--orange)", fontWeight: 700 }}>{line}</span>;
  if (line.startsWith("> "))    return <span style={{ color: "var(--aqua)", fontStyle: "italic" }}>{line}</span>;
  if (line.startsWith("- [x]")) return <span style={{ color: "var(--muted)" }}>- <span style={{ color: "var(--green)" }}>[x]</span><s>{line.slice(5)}</s></span>;
  if (line.startsWith("- [ ]")) return <span>- <span style={{ color: "var(--yellow)" }}>[ ]</span>{tokenize(line.slice(5))}</span>;
  if (line.startsWith("- "))    return <span>- {tokenize(line.slice(2))}</span>;
  return tokenize(line);
}

function tokenize(text) {
  const out = [];
  const re = /(\[\[[^\]]+\]\]|#[a-zA-Z0-9_]+|`[^`]+`)/g;
  let last = 0, m, key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith("[["))     out.push(<span key={key++} style={{ color: "var(--purple)" }}>{tok}</span>);
    else if (tok.startsWith("#")) out.push(<span key={key++} style={{ color: "var(--orange)" }}>{tok}</span>);
    else if (tok.startsWith("`")) out.push(<span key={key++} style={{ color: "var(--aqua)" }}>{tok}</span>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

function NotePreview({ body }) {
  const lines = (body || "").split("\n");
  const out = [];
  let key = 0;
  lines.forEach((ln) => {
    if (ln.startsWith("# "))      out.push(<h1 key={key++}>{renderInline(ln.slice(2))}</h1>);
    else if (ln.startsWith("## ")) out.push(<h2 key={key++}>{renderInline(ln.slice(3))}</h2>);
    else if (ln.startsWith("> "))  out.push(<blockquote key={key++}>{renderInline(ln.slice(2))}</blockquote>);
    else if (ln.startsWith("- [x]")) out.push(<div key={key++} className="task done">☑ <s>{renderInline(ln.slice(5))}</s></div>);
    else if (ln.startsWith("- [ ]")) out.push(<div key={key++} className="task">☐ {renderInline(ln.slice(5))}</div>);
    else if (ln.startsWith("- "))    out.push(<div key={key++} className="li">• {renderInline(ln.slice(2))}</div>);
    else if (ln.trim() === "")       out.push(<div key={key++} style={{ height: 6 }} />);
    else                             out.push(<p key={key++}>{renderInline(ln)}</p>);
  });
  return <div className="preview-body">{out}</div>;
}

function renderInline(text) { return tokenize(text); }

function GraphView({ graph, activeId }) {
  const W = 760, H = 480;
  const [hover, setHover] = useState(null);
  const [pan, setPan]     = useState({ x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 });
  const [zoom, setZoom]   = useState(1);

  const toScreen = (x, y) => ({
    x: W / 2 + x * (W * 0.42) * zoom + pan.x,
    y: H / 2 + y * (H * 0.42) * zoom + pan.y,
  });

  const nodes = (graph && graph.nodes) ? graph.nodes : [];
  const edges = (graph && graph.edges) ? graph.edges : [];

  return (
    <div className="graph-wrap">
      <div className="graph-controls">
        <button className="btn" onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))}>−</button>
        <span className="muted">{Math.round(zoom * 100)}%</span>
        <button className="btn" onClick={() => setZoom((z) => Math.min(2.5, z + 0.2))}>+</button>
        <button className="btn" onClick={() => { setPan({ x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 }); setZoom(1); }}>[c] центр</button>
        <span className="muted" style={{ marginLeft: "auto" }}>
          {nodes.length} узлов · {edges.length} рёбер
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`} className="graph-svg"
        onMouseDown={(e) => setPan((p) => ({ ...p, dragging: true, lastX: e.clientX, lastY: e.clientY }))}
        onMouseUp={() => setPan((p) => ({ ...p, dragging: false }))}
        onMouseLeave={() => setPan((p) => ({ ...p, dragging: false }))}
        onMouseMove={(e) => {
          if (!pan.dragging) return;
          setPan((p) => ({ ...p, x: p.x + (e.clientX - p.lastX), y: p.y + (e.clientY - p.lastY), lastX: e.clientX, lastY: e.clientY }));
        }}
        style={{ cursor: pan.dragging ? "grabbing" : "grab" }}
      >
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#3c3836" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />
        {edges.map(([a, b], i) => {
          const na = nodes.find((n) => n.id === a);
          const nb = nodes.find((n) => n.id === b);
          if (!na || !nb) return null;
          const pa = toScreen(na.x, na.y);
          const pb = toScreen(nb.x, nb.y);
          const active = hover && (hover === a || hover === b);
          return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={active ? "#fabd2f" : "#504945"} strokeWidth={active ? 1.4 : 0.8} />;
        })}
        {nodes.map((n) => {
          const p        = toScreen(n.x, n.y);
          const isActive = n.id === activeId;
          const isHover  = n.id === hover;
          const color    = n.kind === "core" ? "#fe8019" : n.kind === "node" ? "#fabd2f" : n.kind === "doc" ? "#83a598" : "#d3869b";
          const r        = (n.r || 6) * zoom;
          return (
            <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
              {(isActive || isHover) && <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke={color} opacity={0.4} />}
              <circle cx={p.x} cy={p.y} r={r} fill={color} opacity={isActive ? 1 : 0.85} />
              <text x={p.x} y={p.y + r + 12} textAnchor="middle"
                fill={isActive ? "#fbf1c7" : "#ebdbb2"}
                fontFamily="JetBrains Mono, monospace"
                fontSize={11 * zoom}
                fontWeight={isActive ? 700 : 400}
              >{n.id}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

window.NotesScreen = NotesScreen;
