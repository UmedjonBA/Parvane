// NOTES screen — Obsidian-style with vault tree, editor, backlinks, graph.

function NotesScreen() {
  const vault = MONO_DATA.vault;
  const [viewMode, setViewMode] = useState("split"); // "split" | "graph"
  const note = vault.notes[vault.activeId];

  return (
    <div className="notes-screen">
      <div className="notes-tree col">
        <Panel
          title="VAULT"
          sub={vault.name}
          hint="↑↓ · [Enter] open · [n] new"
        >
          <div className="vault-search">
            <span className="muted">[/]</span>
            <input className="form-input" placeholder="search notes, tags..." />
          </div>
          <div className="hr" />
          <VaultTree tree={vault.tree} />
          <div className="hr" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary">[n] new note</button>
            <button className="btn">[t] tag</button>
            <button className="btn">[d] daily</button>
          </div>
        </Panel>

        <Panel title="TAGS" sub="12 tags">
          <div className="tag-cloud">
            {[
              ["#project", 14, "orange"],["#os", 9, "yellow"],["#wip", 7, "yellow"],
              ["#study", 21, "blue"],["#go", 11, "aqua"],["#math", 8, "red"],
              ["#daily", 30, "muted"],["#idea", 12, "purple"],["#fix", 6, "green"],
              ["#archive", 4, "muted"],
            ].map(([t, n, c]) => (
              <button key={t} className="tag-pill" style={{ color: `var(--${c})` }}>
                {t}<span className="muted"> · {n}</span>
              </button>
            ))}
          </div>
        </Panel>
      </div>

      <div className="notes-center col">
        <Panel
          title={"NOTE · " + note.title}
          sub={note.path}
          hint={viewMode === "split" ? "[Tab] focus  [Ctrl+P] palette  [g] graph" : "[g] back to editor"}
          focused
        >
          <div className="note-toolbar">
            <div className="tag-cloud">
              {note.tags.map(t => <span key={t} className="tag-pill" style={{ color: "var(--orange)" }}>{t}</span>)}
            </div>
            <div className="muted" style={{ marginLeft: "auto" }}>
              {note.words} words · modified {note.modified}
            </div>
            <button className={"btn" + (viewMode === "split" ? " primary" : "")} onClick={() => setViewMode("split")}>[s] split</button>
            <button className={"btn" + (viewMode === "graph" ? " primary" : "")} onClick={() => setViewMode("graph")}>[g] graph</button>
          </div>
          <div className="hr" />
          {viewMode === "split" ? (
            <div className="note-split">
              <div className="note-src">
                <NoteSource body={note.body} />
              </div>
              <div className="note-preview">
                <NotePreview body={note.body} />
              </div>
            </div>
          ) : (
            <GraphView graph={vault.graph} activeId={note.title} />
          )}
        </Panel>
      </div>

      <div className="notes-right col">
        <Panel title="BACKLINKS" sub={vault.backlinks.length + " notes"}>
          <div className="rowlist">
            {vault.backlinks.map(b => (
              <div key={b} className="row">
                <span className="marker">▌</span>
                <span style={{ color: "var(--purple)" }}>[[{b}]]</span>
                <span className="muted" style={{ marginLeft: "auto" }}>2</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="OUTGOING" sub={vault.outgoing.length + " links"}>
          <div className="rowlist">
            {vault.outgoing.map(b => (
              <div key={b} className="row">
                <span className="marker">▌</span>
                <span style={{ color: "var(--aqua)" }}>→ [[{b}]]</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="OUTLINE" sub="2 headings">
          <div className="rowlist outline">
            <div className="row"><span style={{ color: "var(--yellow)" }}>#</span> <span className="strong">MONOLITH</span></div>
            <div className="row" style={{ paddingLeft: 18 }}><span style={{ color: "var(--orange)" }}>##</span> Текущее</div>
            <div className="row" style={{ paddingLeft: 18 }}><span style={{ color: "var(--orange)" }}>##</span> TODO</div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function VaultTree({ tree, level = 0 }) {
  return (
    <div className="vault-tree">
      {tree.map((node, i) => (
        <VaultNode key={i} node={node} level={level} />
      ))}
    </div>
  );
}

function VaultNode({ node, level }) {
  const [open, setOpen] = useState(node.open);
  const pad = level * 14;
  if (node.type === "dir") {
    return (
      <>
        <button
          className="vault-row"
          style={{ paddingLeft: pad }}
          onClick={() => setOpen(o => !o)}
        >
          <span className="muted" style={{ width: 10 }}>{open ? "▾" : "▸"}</span>
          <span className="vault-glyph" style={{ color: "var(--orange)" }}>📁</span>
          <span className="strong">{node.name}</span>
          <span className="muted" style={{ marginLeft: "auto" }}>{node.children?.length || 0}</span>
        </button>
        {open && node.children?.map((c, i) => (
          <VaultNode key={i} node={c} level={level + 1} />
        ))}
      </>
    );
  }
  return (
    <button
      className={"vault-row" + (node.active ? " sel" : "")}
      style={{ paddingLeft: pad + 10 }}
    >
      <span className="muted" style={{ width: 10 }}>·</span>
      <span className="vault-glyph" style={{ color: "var(--aqua)" }}>md</span>
      <span>{node.name}</span>
    </button>
  );
}

function NoteSource({ body }) {
  // syntax-highlight markdown in TUI style
  const lines = body.split("\n");
  return (
    <pre className="note-code">
      {lines.map((ln, i) => {
        const lineNo = String(i + 1).padStart(3, " ");
        return (
          <div key={i} className="code-line">
            <span className="line-no muted">{lineNo}</span>
            <span className="line-body">{highlightMd(ln)}</span>
          </div>
        );
      })}
    </pre>
  );
}

function highlightMd(line) {
  if (line.startsWith("# ")) return <span style={{ color: "var(--yellow)", fontWeight: 700 }}>{line}</span>;
  if (line.startsWith("## ")) return <span style={{ color: "var(--orange)", fontWeight: 700 }}>{line}</span>;
  if (line.startsWith("> ")) return <span style={{ color: "var(--aqua)", fontStyle: "italic" }}>{line}</span>;
  if (line.startsWith("- [x]")) return <span style={{ color: "var(--muted)" }}>- <span style={{ color: "var(--green)" }}>[x]</span><s>{line.slice(5)}</s></span>;
  if (line.startsWith("- [ ]")) return <span>- <span style={{ color: "var(--yellow)" }}>[ ]</span>{tokenize(line.slice(5))}</span>;
  if (line.startsWith("- ")) return <span>- {tokenize(line.slice(2))}</span>;
  return tokenize(line);
}

function tokenize(text) {
  // simple [[wiki-link]] and #tag highlight
  const out = [];
  const re = /(\[\[[^\]]+\]\]|#[a-zA-Z0-9_]+|`[^`]+`)/g;
  let last = 0, m, key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith("[[")) out.push(<span key={key++} style={{ color: "var(--purple)" }}>{tok}</span>);
    else if (tok.startsWith("#")) out.push(<span key={key++} style={{ color: "var(--orange)" }}>{tok}</span>);
    else if (tok.startsWith("`")) out.push(<span key={key++} style={{ color: "var(--aqua)" }}>{tok}</span>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

function NotePreview({ body }) {
  const lines = body.split("\n");
  const out = [];
  let key = 0;
  lines.forEach((ln, i) => {
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

function renderInline(text) {
  return tokenize(text);
}

function GraphView({ graph, activeId }) {
  const W = 760, H = 480;
  const [hover, setHover] = useState(null);
  const [pan, setPan] = useState({ x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 });
  const [zoom, setZoom] = useState(1);

  const toScreen = (x, y) => ({
    x: W / 2 + x * (W * 0.42) * zoom + pan.x,
    y: H / 2 + y * (H * 0.42) * zoom + pan.y,
  });

  const onMD = e => setPan(p => ({ ...p, dragging: true, lastX: e.clientX, lastY: e.clientY }));
  const onMU = () => setPan(p => ({ ...p, dragging: false }));
  const onMM = e => {
    if (!pan.dragging) return;
    setPan(p => ({ ...p, x: p.x + (e.clientX - p.lastX), y: p.y + (e.clientY - p.lastY), lastX: e.clientX, lastY: e.clientY }));
  };

  return (
    <div className="graph-wrap">
      <div className="graph-controls">
        <button className="btn" onClick={() => setZoom(z => Math.max(0.5, z - 0.2))}>−</button>
        <span className="muted">{Math.round(zoom * 100)}%</span>
        <button className="btn" onClick={() => setZoom(z => Math.min(2.5, z + 0.2))}>+</button>
        <button className="btn" onClick={() => { setPan({ x:0,y:0,dragging:false,lastX:0,lastY:0 }); setZoom(1); }}>[c] center</button>
        <span className="muted" style={{ marginLeft: "auto" }}>
          {graph.nodes.length} nodes · {graph.edges.length} edges · drag to pan
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="graph-svg"
        onMouseDown={onMD} onMouseUp={onMU} onMouseLeave={onMU} onMouseMove={onMM}
        style={{ cursor: pan.dragging ? "grabbing" : "grab" }}
      >
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#3c3836" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />
        {graph.edges.map(([a, b], i) => {
          const na = graph.nodes.find(n => n.id === a);
          const nb = graph.nodes.find(n => n.id === b);
          if (!na || !nb) return null;
          const pa = toScreen(na.x, na.y);
          const pb = toScreen(nb.x, nb.y);
          const active = hover && (hover === a || hover === b);
          return (
            <line key={i}
              x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
              stroke={active ? "#fabd2f" : "#504945"}
              strokeWidth={active ? 1.4 : 0.8}
            />
          );
        })}
        {graph.nodes.map(n => {
          const p = toScreen(n.x, n.y);
          const isActive = n.id === activeId;
          const isHover = n.id === hover;
          const color = n.kind === "core" ? "#fe8019"
            : n.kind === "node" ? "#fabd2f"
            : n.kind === "doc"  ? "#83a598"
            : "#d3869b";
          const r = (n.r) * zoom;
          return (
            <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
              {(isActive || isHover) && (
                <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke={color} opacity={0.4} />
              )}
              <circle cx={p.x} cy={p.y} r={r} fill={color} opacity={isActive ? 1 : 0.85} />
              <text x={p.x} y={p.y + r + 12} textAnchor="middle"
                fill={isActive ? "#fbf1c7" : "#ebdbb2"}
                fontFamily="JetBrains Mono, monospace"
                fontSize={11 * zoom}
                fontWeight={isActive ? 700 : 400}
              >
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
