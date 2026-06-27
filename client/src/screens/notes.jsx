// NOTES screen — live notes via VaultCtx + notes shard. Labels follow the
// MONOVIEW design (English). Right-click a row for the context menu; drag a
// note row onto a folder to move it.

function NotesScreen({ me }) {
  const v = useVault();
  const [viewMode, setViewMode] = useState("split");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);

  const note = v.active;
  const out       = note ? outlineOf(note.body) : [];
  const links     = note ? extractLinks(note.body) : [];
  const backlinks = note ? v.notes.filter(n =>
    n.id !== note.id && extractLinks(n.body).some(l => l.toLowerCase() === note.title.toLowerCase())
  ) : [];
  const tags = note ? noteTags(note) : [];

  // keyboard: ↑↓ through the tree, [n] new note
  const visible = v.notes.filter(n => {
    if (v.query && !n.title.toLowerCase().includes(v.query.toLowerCase())) return false;
    if (v.tagFilter && !noteTags(n).includes(v.tagFilter)) return false;
    return true;
  });
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.code === "KeyN") { setNewFolderOpen(false); setNewNoteOpen(true); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = visible.findIndex(n => n.id === v.activeId);
        const next = e.key === "ArrowDown"
          ? Math.min(idx + 1, visible.length - 1)
          : Math.max(idx - 1, 0);
        if (visible[next]) v.openNote(visible[next].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, v.activeId]);

  const copyLink = () => {
    if (!note) return;
    const link = `[[${note.title}]]`;
    try {
      navigator.clipboard?.writeText(link);
      v.flash(`copied ${link}`);
    } catch { v.flash("clipboard unavailable"); }
  };

  return (
    <div className="notes-screen">
      {/* LEFT: vault tree + tags */}
      <div className="notes-tree col">
        <Panel title="VAULT" sub="vault://monolith" hint="↑↓ · [n] new · right-click row → menu">
          <div className="vault-search">
            <span className="muted">[/]</span>
            <input className="form-input" placeholder="filter notes…"
              value={v.query} onChange={e => v.setQuery(e.target.value)} />
            {v.query && <button className="x-btn" onClick={() => v.setQuery("")}>✕</button>}
          </div>
          {v.tagFilter && (
            <div className="active-filter">
              filter: <span style={{ color: `var(--${tagColor(v.tagFilter)})` }}>{v.tagFilter}</span>
              <button className="x-btn" onClick={() => v.setTagFilter(null)}>✕ clear</button>
            </div>
          )}
          <div className="hr" />
          <VaultTree />
          <div className="hr" />
          {newNoteOpen ? (
            <InlineCreate
              placeholder="note title…"
              onSubmit={title => { v.createNote("f_inbox", title); setNewNoteOpen(false); }}
              onCancel={() => setNewNoteOpen(false)}
            />
          ) : newFolderOpen ? (
            <InlineCreate
              placeholder="folder name…"
              onSubmit={name => { v.createFolder(name); setNewFolderOpen(false); }}
              onCancel={() => setNewFolderOpen(false)}
            />
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" onClick={() => { setNewFolderOpen(false); setNewNoteOpen(true); }}>[n] new note</button>
              <button className="btn" onClick={() => { setNewNoteOpen(false); setNewFolderOpen(true); }}>[+] folder</button>
              <button className="btn" onClick={() => v.setMode("journal")}>[j] journal</button>
            </div>
          )}
        </Panel>

        <Panel title="TAGS" sub={Object.keys(v.tagCounts).length + " tags"} hint="click to filter">
          <div className="tag-cloud">
            {Object.entries(v.tagCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
              <button key={t}
                className={"tag-pill" + (v.tagFilter === t ? " on" : "")}
                style={v.tagFilter === t
                  ? { background: `var(--${tagColor(t)})`, color: "var(--bg)", borderColor: `var(--${tagColor(t)})` }
                  : { color: `var(--${tagColor(t)})` }}
                onClick={() => v.setTagFilter(v.tagFilter === t ? null : t)}>
                {t}<span style={{ opacity: 0.6 }}> · {n}</span>
              </button>
            ))}
            {Object.keys(v.tagCounts).length === 0 && (
              <div className="muted" style={{ fontSize: 12 }}>write #tag in the note body</div>
            )}
          </div>
        </Panel>
      </div>

      {/* CENTER: editor / graph */}
      <div className="notes-center col">
        <Panel
          title="NOTE"
          sub={note ? note.title : "—"}
          hint={viewMode === "graph" ? "click a node → open · drag to pan" : "editor left · preview right"}
          focused
        >
          {note ? (
            <>
              <div className="note-toolbar">
                <NoteTitle note={note} onRename={t => v.renameNote(note.id, t)} />
                <div className="note-tags-inline">
                  {tags.map(t => (
                    <span key={t} className="tag-pill removable"
                      style={{ color: `var(--${tagColor(t)})` }}
                      onClick={() => v.setTagFilter(t)}>
                      {t}
                      <button className="tag-x"
                        onClick={e => { e.stopPropagation(); v.removeTag(note.id, t); }}>✕</button>
                    </span>
                  ))}
                  <AddTagInline onAdd={t => v.addTag(note.id, t)} />
                </div>
                <div className="note-meta-actions">
                  <span className="muted">{wordCount(note.body)}w · {note.body.length}ch</span>
                  <button className={"btn" + (viewMode === "split" ? " primary" : "")} onClick={() => setViewMode("split")}>[s] edit</button>
                  <button className={"btn" + (viewMode === "graph" ? " primary" : "")} onClick={() => setViewMode("graph")}>[g] graph</button>
                </div>
              </div>
              <div className="hr" />
              {viewMode === "split" ? (
                <div className="note-split">
                  <div className="note-src">
                    <UndoTextarea
                      key={note.id}
                      className="note-editor"
                      value={note.body}
                      onChange={val => v.updateBody(note.id, val)}
                      onSaveNow={() => v.saveNow(note.id)}
                      spellCheck={false}
                      placeholder="start writing…"
                    />
                  </div>
                  <div className="note-preview">
                    <NotePreview body={note.body} onLink={v.openByTitle} onTag={v.setTagFilter} />
                  </div>
                </div>
              ) : (
                <GraphView graph={v.graph} activeId={note.title} onOpen={nodeId => v.openNote(nodeId)} />
              )}
            </>
          ) : (
            <div className="muted" style={{ padding: 20 }}>
              No note selected. Press <span className="kbd">[n]</span> to create one.
            </div>
          )}
        </Panel>
      </div>

      {/* RIGHT: backlinks / outgoing / outline */}
      <div className="notes-right col">
        <Panel title="BACKLINKS" sub={backlinks.length + " notes"}>
          {backlinks.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>No backlinks yet</div>
          ) : (
            <div className="rowlist">
              {backlinks.map(b => (
                <button key={b.id} className="row link-row" onClick={() => v.openNote(b.id)}>
                  <span className="marker">▌</span>
                  <span style={{ color: "var(--purple)" }}>[[{b.title}]]</span>
                  <span className="muted" style={{ marginLeft: "auto" }}>open</span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="OUTGOING" sub={links.length + " links"}>
          {links.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>No [[wiki-link]] yet</div>
          ) : (
            <div className="rowlist">
              {links.map((l, i) => {
                const exists = v.notes.some(n => n.title.toLowerCase() === l.toLowerCase());
                return (
                  <button key={i} className="row link-row" onClick={() => v.openByTitle(l)}>
                    <span className="marker">▌</span>
                    <span style={{ color: exists ? "var(--aqua)" : "var(--dim)" }}>→ [[{l}]]</span>
                    {!exists && <span className="muted" style={{ marginLeft: "auto" }}>create</span>}
                  </button>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="OUTLINE" sub={out.length + " headings"}>
          {out.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>No headings (#, ##, ###)</div>
          ) : (
            <div className="rowlist outline">
              {out.map((h, i) => (
                <div key={i} className="row" style={{ paddingLeft: 10 + (h.level - 1) * 16 }}>
                  <span style={{ color: h.level === 1 ? "var(--yellow)" : "var(--orange)" }}>{"#".repeat(h.level)}</span>{" "}
                  <span className={h.level === 1 ? "strong" : ""}>{h.text}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {note && (
          <Panel title="ACTIONS" sub="">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button className="btn" onClick={copyLink}>copy [[link]]</button>
              <button className="btn danger"
                onClick={() => { if (confirm("Delete this note?")) v.deleteNote(note.id); }}>
                delete note
              </button>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

// ── vault tree ────────────────────────────────────────────────────────────────

function VaultTree() {
  const v = useVault();
  const roots = v.folders.filter(f => !f.parent);
  return (
    <div className="vault-tree scroll">
      {roots.map(f => <FolderNode key={f.id} folder={f} level={0} />)}
    </div>
  );
}

function FolderNode({ folder, level }) {
  const v = useVault();
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dropping, setDropping] = useState(false);

  const subFolders = v.folders.filter(f => f.parent === folder.id);
  let notesIn = v.notes.filter(n => n.folder === folder.id);
  if (v.query) notesIn = notesIn.filter(n => n.title.toLowerCase().includes(v.query.toLowerCase()));
  if (v.tagFilter) notesIn = notesIn.filter(n => noteTags(n).includes(v.tagFilter));
  const pad = level * 14;

  const onFolderDrop = (e) => {
    e.preventDefault();
    setDropping(false);
    const noteId = e.dataTransfer.getData("text/note-id");
    if (noteId) {
      v.setNoteToFolder(noteId, folder.id);
      v.flash(`moved to ${folder.name}`);
    }
  };

  return (
    <>
      <div className="vault-row-wrap">
        <button
          className={"vault-row" + (dropping ? " drop-target" : "")}
          style={{ paddingLeft: pad }}
          onClick={() => setOpen(o => !o)}
          onContextMenu={e => { e.preventDefault(); v.setMenu({ x: e.clientX, y: e.clientY, type: "folder", id: folder.id }); }}
          onDragOver={e => { e.preventDefault(); setDropping(true); }}
          onDragLeave={() => setDropping(false)}
          onDrop={onFolderDrop}
        >
          <span className="muted" style={{ width: 10 }}>{open ? "▾" : "▸"}</span>
          <span className="vault-glyph" style={{ color: "var(--orange)" }}>{open ? "▼" : "▶"}</span>
          <RenamableName
            value={folder.name}
            onRename={name => v.renameFolder(folder.id, name)}
            autoEdit={v.menuEditingFor === folder.id}
            onDone={() => v.setMenu(null)}
            strong
          />
          <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{notesIn.length}</span>
          <span className="row-add" onClick={e => { e.stopPropagation(); setCreating(true); setOpen(true); }} title="new note">＋</span>
        </button>
      </div>
      {open && (
        <>
          {subFolders.map(sf => <FolderNode key={sf.id} folder={sf} level={level + 1} />)}
          {notesIn.map(n => (
            <button
              key={n.id}
              className={"vault-row" + (n.id === v.activeId ? " sel" : "")}
              style={{ paddingLeft: pad + 24 }}
              draggable
              onDragStart={e => { e.dataTransfer.setData("text/note-id", n.id); e.dataTransfer.effectAllowed = "move"; }}
              onClick={() => v.openNote(n.id)}
              onContextMenu={e => { e.preventDefault(); v.setMenu({ x: e.clientX, y: e.clientY, type: "note", id: n.id }); }}
            >
              <span className="vault-glyph" style={{ color: n.isDaily ? "var(--muted)" : "var(--aqua)" }}>
                {n.isDaily ? "◆" : "md"}
              </span>
              <RenamableName
                value={n.title}
                onRename={t => v.renameNote(n.id, t)}
                autoEdit={v.menuEditingFor === n.id}
                onDone={() => v.setMenu(null)}
              />
            </button>
          ))}
          {creating && (
            <div style={{ paddingLeft: pad + 24 }}>
              <InlineCreate
                placeholder="note title…"
                onSubmit={t => { v.createNote(folder.id, t); setCreating(false); }}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}

function RenamableName({ value, onRename, strong, autoEdit, onDone }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);
  useEffect(() => { if (autoEdit) setEditing(true); }, [autoEdit]);
  const finish = (commit) => {
    if (commit) onRename(val || value);
    setEditing(false);
    onDone && onDone();
  };
  if (editing) {
    return (
      <input
        className="form-input inline-rename"
        value={val}
        autoFocus
        onClick={e => e.stopPropagation()}
        onChange={e => setVal(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={e => {
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
        }}
      />
    );
  }
  return (
    <span
      className={strong ? "strong" : ""}
      style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      onDoubleClick={e => { e.stopPropagation(); setEditing(true); }}
    >
      {value}
    </span>
  );
}

function InlineCreate({ placeholder, onSubmit, onCancel }) {
  const [val, setVal] = useState("");
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="inline-create">
      <span style={{ color: "var(--yellow)" }}>›</span>
      <input
        ref={ref}
        className="form-input"
        value={val}
        placeholder={placeholder}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && val.trim()) onSubmit(val.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <button className="btn" onClick={() => val.trim() && onSubmit(val.trim())}>add</button>
      <button className="x-btn" onClick={onCancel}>✕</button>
    </div>
  );
}

function NoteTitle({ note, onRename }) {
  const v = useVault();
  const folderName = v.folders.find(f => f.id === note.folder)?.name || note.folder;
  return (
    <div className="note-title-block">
      <RenamableName value={note.title} onRename={onRename} strong />
      <span className="muted note-path">{folderName}</span>
    </div>
  );
}

function AddTagInline({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  if (!open) return <button className="tag-add-btn" onClick={() => setOpen(true)}>+ tag</button>;
  return (
    <span className="tag-add-input">
      <span className="muted">#</span>
      <input
        className="form-input"
        autoFocus
        value={val}
        placeholder="tag"
        onChange={e => setVal(e.target.value.replace(/^#/, ""))}
        onBlur={() => { if (val.trim()) onAdd(val.trim()); setOpen(false); setVal(""); }}
        onKeyDown={e => {
          if (e.key === "Enter" && val.trim()) { onAdd(val.trim()); setOpen(false); setVal(""); }
          if (e.key === "Escape") { setOpen(false); setVal(""); }
        }}
      />
    </span>
  );
}

// ── markdown preview with clickable links / tags ──────────────────────────────

function tokenizeRich(text, onLink, onTag) {
  const out = [];
  const re = /(\[\[[^\]]+\]\]|#[a-zA-Zа-яА-Я0-9_\-\/]+|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0, m, key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith("[[")) {
      const name = tok.slice(2, -2).trim();
      out.push(<button key={key++} className="wiki-link" onClick={() => onLink && onLink(name)}>{tok}</button>);
    } else if (tok.startsWith("#")) {
      out.push(<button key={key++} className="inline-tag" style={{ color: `var(--${tagColor(tok)})` }} onClick={() => onTag && onTag(tok)}>{tok}</button>);
    } else if (tok.startsWith("`")) {
      out.push(<code key={key++} className="inline-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      out.push(<em key={key++} style={{ color: "var(--yellow)", fontStyle: "italic" }}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

function NotePreview({ body, onLink, onTag }) {
  const lines = (body || "").split("\n");
  const out = [];
  let key = 0;
  const inline = t => tokenizeRich(t, onLink, onTag);
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      out.push(<pre key={key++} style={{ background: "var(--bg2)", padding: "8px", borderRadius: 4, fontSize: 12, margin: "4px 0", overflowX: "auto" }}><code style={{ color: "var(--aqua)" }}>{codeLines.join("\n")}</code></pre>);
    } else if (
      ln.trim().startsWith("|") &&
      i + 1 < lines.length &&
      lines[i + 1].includes("-") &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])
    ) {
      // GitHub-style таблица: строка-заголовок, строка-разделитель |---|, строки данных.
      const splitRow = (row) =>
        row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = splitRow(ln);
      i += 2; // пропускаем заголовок и разделитель
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        <table key={key++} className="md-table">
          <thead><tr>{header.map((c, ci) => <th key={ci}>{inline(c)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => (
            <tr key={ri}>{header.map((_, ci) => <td key={ci}>{inline(r[ci] || "")}</td>)}</tr>
          ))}</tbody>
        </table>
      );
      continue; // i уже указывает на следующую необработанную строку
    } else if (ln.startsWith("# "))    out.push(<h1 key={key++}>{inline(ln.slice(2))}</h1>);
    else if (ln.startsWith("## "))     out.push(<h2 key={key++}>{inline(ln.slice(3))}</h2>);
    else if (ln.startsWith("### "))    out.push(<h3 key={key++}>{inline(ln.slice(4))}</h3>);
    else if (ln.startsWith("> "))      out.push(<blockquote key={key++}>{inline(ln.slice(2))}</blockquote>);
    else if (ln.match(/^---+$/))       out.push(<hr key={key++} style={{ border: "none", borderTop: "1px solid var(--border-dim)", margin: "8px 0" }} />);
    else if (ln.startsWith("- [x]"))  out.push(<div key={key++} className="task done">☑ <s>{inline(ln.slice(5))}</s></div>);
    else if (ln.startsWith("- [ ]"))  out.push(<div key={key++} className="task">☐ {inline(ln.slice(5))}</div>);
    else if (ln.startsWith("- "))     out.push(<div key={key++} className="li">• {inline(ln.slice(2))}</div>);
    else if (ln.match(/^\d+\. /))     out.push(<div key={key++} className="li">{inline(ln)}</div>);
    else if (ln.trim() === "")        out.push(<div key={key++} style={{ height: 6 }} />);
    else                              out.push(<p key={key++}>{inline(ln)}</p>);
    i++;
  }
  return <div className="preview-body">{out}</div>;
}

// ── graph ─────────────────────────────────────────────────────────────────────

function GraphView({ graph, activeId, onOpen }) {
  const W = 760, H = 460;
  const [hover, setHover] = useState(null);
  const [pan, setPan]     = useState({ x: 0, y: 0 });
  const [drag, setDrag]   = useState(null);
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
        <button className="btn" onClick={() => setZoom(z => Math.max(0.5, z - 0.2))}>−</button>
        <span className="muted">{Math.round(zoom * 100)}%</span>
        <button className="btn" onClick={() => setZoom(z => Math.min(2.5, z + 0.2))}>+</button>
        <button className="btn" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}>[c] center</button>
        <span className="muted" style={{ marginLeft: "auto" }}>{nodes.length} nodes · {edges.length} links</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="graph-svg"
        onMouseDown={e => setDrag({ x: e.clientX, y: e.clientY, moved: false })}
        onMouseUp={() => setDrag(null)}
        onMouseLeave={() => setDrag(null)}
        onMouseMove={e => {
          if (!drag) return;
          setPan(p => ({ x: p.x + (e.clientX - drag.x), y: p.y + (e.clientY - drag.y) }));
          setDrag(d => ({ ...d, x: e.clientX, y: e.clientY, moved: true }));
        }}
        style={{ cursor: drag ? "grabbing" : "grab" }}>
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#3c3836" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />
        {edges.map(([a, b], i) => {
          const na = nodes.find(n => n.id === a);
          const nb = nodes.find(n => n.id === b);
          if (!na || !nb) return null;
          const pa = toScreen(na.x, na.y), pb = toScreen(nb.x, nb.y);
          const act = hover && (hover === a || hover === b);
          return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
            stroke={act ? "#fabd2f" : "#504945"} strokeWidth={act ? 1.5 : 0.8} />;
        })}
        {nodes.map(n => {
          const p = toScreen(n.x, n.y);
          const isActive = n.id === activeId;
          const isHover  = n.id === hover;
          const color = n.kind === "core" ? "#fe8019" : n.kind === "node" ? "#fabd2f" : "#83a598";
          const r = (n.r || 6) * zoom;
          return (
            <g key={n.id} style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
              onClick={() => { if (!drag?.moved && onOpen) onOpen(n.noteId); }}>
              {(isActive || isHover) && <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke={color} opacity={0.4} />}
              <circle cx={p.x} cy={p.y} r={r} fill={color} opacity={isActive ? 1 : 0.85} />
              <text x={p.x} y={p.y + r + 12} textAnchor="middle"
                fill={isActive || isHover ? "#fbf1c7" : "#ebdbb2"}
                fontFamily="JetBrains Mono, monospace"
                fontSize={11 * zoom} fontWeight={isActive ? 700 : 400}>
                {n.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

window.NotesScreen = NotesScreen;
