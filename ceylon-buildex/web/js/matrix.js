// Library matrix: grouping and link logic with no DOM, so it can be tested on its own.
// Rows are kinds of document, columns are the years the documents carry (plus "Undated"), so where a document sits is its data:
// its category and its date. The lines drawn when you point at one are the real relations from the dataset: same gazette number or
// "supersedes" (strongest), same issuing authority, same publishing website. Nothing is guessed from titles.

export const ORDER = ["building-regulations", "development-plans", "gazette", "procurement-sbd", "procurement-policy", "legislation", "other"];
export const KIND_RANK = {cat: 1, site: 2, auth: 3, gaz: 4, sup: 5};

const norm = s => String(s || "").trim().toLowerCase();
const host = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const rank = k => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i; };

/** Sortable date text; "2008" and "2019-07" are accepted, undated documents sort last. */
export function dateKey(d) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String((d && d.doc_date) || "").trim());
  return m ? `${m[1]}-${m[2] || "00"}-${m[3] || "00"}` : "9999";
}
export const byDate = (a, b) => dateKey(a).localeCompare(dateKey(b)) || String(a.title).localeCompare(String(b.title));

export function groupBands(docs) {
  const by = new Map();
  for (const d of docs) { const k = d.category || "other"; if (!by.has(k)) by.set(k, []); by.get(k).push(d); }
  return [...by.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(cat => ({cat, docs: by.get(cat).slice().sort(byDate)}));
}

/** Lines between documents: [{a, b, kind}] with a < b; where two reasons apply the stronger one is kept. */
export function links(docs) {
  const out = new Map(), byId = new Map(docs.map(d => [d.id, d]));
  const add = (x, y, kind) => {
    if (!x || !y || x.id === y.id) return;
    const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id], key = a + "|" + b, prev = out.get(key);
    if (!prev || KIND_RANK[kind] > KIND_RANK[prev.kind]) out.set(key, {a, b, kind});
  };
  const groups = (keyFn) => { const m = new Map(); for (const d of docs) { const k = keyFn(d); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(d); } } return [...m.values()]; };
  const chain = (list, kind) => { const s = list.slice().sort(byDate); for (let i = 1; i < s.length; i++) add(s[i - 1], s[i], kind); };
  groups(d => d.category || "other").forEach(g => chain(g, "cat"));
  groups(d => host(d.url)).forEach(g => chain(g, "site"));
  groups(d => norm(d.authority)).forEach(g => chain(g, "auth"));
  groups(d => norm(d.gazette_no)).forEach(g => {
    if (g.length <= 4) { for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) add(g[i], g[j], "gaz"); } else chain(g, "gaz");
  });
  docs.forEach(d => { if (d.supersedes && byId.has(d.supersedes)) add(d, byId.get(d.supersedes), "sup"); });
  return [...out.values()];
}

/** Neighbours through the meaningful lines only (not the "same kind" chain): [{id, kind}] per document id. */
export function related(docs, lk = links(docs)) {
  const m = new Map(docs.map(d => [d.id, []]));
  for (const e of lk) if (e.kind !== "cat") { m.get(e.a).push({id: e.b, kind: e.kind}); m.get(e.b).push({id: e.a, kind: e.kind}); }
  return m;
}


/* ---------- the grid ---------- */

export const yearOf = d => { const m = /^(\d{4})/.exec(String((d && d.doc_date) || "")); return m ? m[1] : ""; };

/** {cols: ["2006", ..., ""], rows: [{cat, docs, cells: [[doc, ...] per column]}]}; "" is the Undated column, last, only when needed. */
export function grid(docs) {
  const years = [...new Set(docs.map(yearOf).filter(Boolean))].sort();
  const cols = docs.some(d => !yearOf(d)) ? [...years, ""] : years;
  const rows = groupBands(docs).map(g => ({cat: g.cat, docs: g.docs, cells: cols.map(c => g.docs.filter(d => yearOf(d) === c))}));
  return {cols, rows};
}

/** The short name on a document's chip: its gazette number, else the first words of its title (about 22 characters). */
export function caption(d) {
  const g = String((d && d.gazette_no) || "").trim();
  if (g) return g;
  const title = String((d && d.title) || ""), vol = /\bVol(?:ume)?\.?\s*([IVX]+|\d+)\b/i.exec(title);
  const words = title.split(/\s+[-–(]|[:(]/)[0].replace(/[(),:–-]+/g, " ").split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of words) { if ((out + " " + w).trim().length > (vol ? 18 : 22)) break; out = (out + " " + w).trim(); }
  out = out.replace(/(\s+(to|the|of|and|for|in|a|on))+$/i, "") || title.slice(0, 22);
  return vol ? `${out} · Vol ${vol[1].toUpperCase()}` : out;
}

/** Diameter of the status mark, 7-13 px, growing with the page count (log scale, so one long document does not dwarf the rest). */
export const markSize = (pages, maxPages) => Math.round((7 + 6 * Math.log(1 + Math.max(1, pages || 1)) / Math.log(1 + Math.max(2, maxPages || 2))) * 10) / 10;
