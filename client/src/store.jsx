// VAULT STORE — VaultCtx + helper functions shared by Notes + Journal screens.

const { createContext, useContext } = React;

const VaultCtx = createContext(null);
const useVault = () => useContext(VaultCtx);

// ── tag / link helpers ────────────────────────────────────────────────────────

function extractBodyTags(body) {
  const out = [];
  const re = /(^|\s)(#[a-zA-Zа-яА-Я0-9_\-\/]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[2]);
  return out;
}
function noteTags(note) {
  const set = new Set([...(note.tags || []), ...extractBodyTags(note.body || "")]);
  return [...set];
}
function extractLinks(body) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1].trim());
  return out;
}
function wordCount(body) {
  return (body || "").split(/\s+/).filter(Boolean).length;
}
function outlineOf(body) {
  return (body || "").split("\n")
    .map(l => { const m = l.match(/^(#{1,3})\s+(.*)/); return m ? { level: m[1].length, text: m[2] } : null; })
    .filter(Boolean);
}
function tagColor(tag) {
  const map = {
    "#project":"orange","#os":"yellow","#wip":"yellow","#study":"blue","#go":"aqua",
    "#math":"red","#daily":"muted","#idea":"purple","#fix":"green","#archive":"muted",
    "#node":"aqua","#hw":"orange","#spec":"blue","#fl":"blue",
  };
  return map[tag] || "purple";
}
function computeGraph(notes) {
  const byTitle = {};
  notes.forEach(n => { byTitle[n.title.toLowerCase()] = n; });
  const edges = [], degree = {};
  notes.forEach(n => {
    extractLinks(n.body || "").forEach(lk => {
      const tgt = byTitle[lk.toLowerCase()];
      if (tgt && tgt.id !== n.id) {
        edges.push([n.title, tgt.title]);
        degree[n.title]   = (degree[n.title]   || 0) + 1;
        degree[tgt.title] = (degree[tgt.title] || 0) + 1;
      }
    });
  });
  const maxDeg = Math.max(1, ...Object.values(degree));
  const nodes = notes.map((n, i) => {
    const d = degree[n.title] || 0;
    const angle = (i / Math.max(notes.length, 1)) * Math.PI * 2;
    const radius = 0.92 - 0.62 * (d / maxDeg);
    return { id: n.title, noteId: n.id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius,
             r: 8 + Math.min(8, d * 1.6), kind: n.isDaily ? "doc" : "doc", deg: d };
  });
  return { nodes, edges };
}

// Convert backend note {note_id, title, text, deleted} → vault format
function liveNoteToVault(n, localBody, localMood) {
  const dateMatch = /^(\d{4}-\d{2}-\d{2})\s*(\S*)/.exec(n.title || "");
  const isDaily = !!dateMatch;
  const created  = isDaily ? dateMatch[1] : "";
  const moodFromTitle = isDaily && dateMatch[2] ? dateMatch[2] : null;
  return {
    id:      n.note_id,
    title:   n.title,
    body:    localBody !== undefined ? localBody : (n.text || ""),
    isDaily,
    created,
    mood:    localMood !== undefined ? localMood : moodFromTitle,
    folder:  isDaily ? "f_daily" : "f_inbox",
    tags:    [],
    deleted: n.deleted || false,
  };
}

window.VaultCtx = VaultCtx;
window.useVault = useVault;
Object.assign(window, {
  extractBodyTags, noteTags, extractLinks, wordCount, outlineOf, tagColor,
  computeGraph, liveNoteToVault,
});
