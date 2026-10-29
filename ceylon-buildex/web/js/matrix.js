// Library matrix: link and layout logic with no DOM, so it can be tested on its own.
// Each kind of document gets a labelled box (sized by how many documents it holds). Inside a box the documents are round nodes joined
// into a mesh of triangles (a Delaunay triangulation, so the lines never cross). That mesh only says "same kind of document".
// The lines drawn over it are the real relations from the dataset: same gazette number or "supersedes" (strongest), same issuing authority,
// same publishing website. Nothing is guessed from titles; a relation line exists only because the dataset says so.

export const ORDER = ["building-regulations", "development-plans", "gazette", "procurement-sbd", "procurement-policy", "legislation", "other"];
export const KIND_RANK = {cat: 1, site: 2, auth: 3, gaz: 4, sup: 5};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const norm = s => String(s || "").trim().toLowerCase();
const host = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const rank = k => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i; };
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

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


/* ---------- geometry ---------- */

/** Squarified treemap: items [{value, ...}] sorted by value (largest first) packed into x, y, w, h. Returns the items with x, y, w, h added. */
export function treemap(items, x, y, w, h) {
  const out = [], total = items.reduce((s, i) => s + i.value, 0) || 1, k = (w * h) / total;
  let rest = items.map(i => ({...i, area: i.value * k}));
  const worst = (row, len) => { const s = row.reduce((t, r) => t + r.area, 0), mx = Math.max(...row.map(r => r.area)), mn = Math.min(...row.map(r => r.area)); return Math.max((len * len * mx) / (s * s), (s * s) / (len * len * mn)); };
  while (rest.length) {
    const len = Math.min(w, h) || 1;
    let row = [rest[0]], n = 1;
    while (n < rest.length && worst([...row, rest[n]], len) <= worst(row, len)) { row.push(rest[n]); n++; }
    const s = row.reduce((t, r) => t + r.area, 0);
    if (w >= h) {                      // a column on the left
      const cw = s / h; let yy = y;
      row.forEach(r => { const ih = r.area / cw; out.push({...r, x, y: yy, w: cw, h: ih}); yy += ih; });
      x += cw; w -= cw;
    } else {                           // a row along the top
      const rh = s / w; let xx = x;
      row.forEach(r => { const iw = r.area / rh; out.push({...r, x: xx, y, w: iw, h: rh}); xx += iw; });
      y += rh; h -= rh;
    }
    rest = rest.slice(row.length);
  }
  return out;
}

/** Delaunay triangulation (Bowyer-Watson). pts [{x, y}] -> unique edges [[i, j]]. Fewer than three points, or points on one line, give a simple chain. */
export function delaunay(pts) {
  const n = pts.length;
  if (n < 2) return [];
  const chain = () => { const idx = pts.map((_, i) => i).sort((a, b) => pts[a].x - pts[b].x || pts[a].y - pts[b].y); return idx.slice(1).map((v, i) => [idx[i], v]); };
  if (n === 2) return [[0, 1]];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y), minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const d = Math.max(maxX - minX, maxY - minY, 1) * 20, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = pts.concat([{x: mx - d, y: my - d}, {x: mx, y: my + d}, {x: mx + d, y: my - d}]);
  const tri = (a, b, c) => {
    const A = P[a], B = P[b], C = P[c], dd = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
    if (Math.abs(dd) < 1e-9) return null;
    const ux = ((A.x ** 2 + A.y ** 2) * (B.y - C.y) + (B.x ** 2 + B.y ** 2) * (C.y - A.y) + (C.x ** 2 + C.y ** 2) * (A.y - B.y)) / dd;
    const uy = ((A.x ** 2 + A.y ** 2) * (C.x - B.x) + (B.x ** 2 + B.y ** 2) * (A.x - C.x) + (C.x ** 2 + C.y ** 2) * (B.x - A.x)) / dd;
    return {a, b, c, ux, uy, r2: (A.x - ux) ** 2 + (A.y - uy) ** 2};
  };
  let T = [tri(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const p = P[i], bad = [], keep = [];
    for (const t of T) ((p.x - t.ux) ** 2 + (p.y - t.uy) ** 2 < t.r2 - 1e-9 ? bad : keep).push(t);
    const count = new Map();
    for (const t of bad) for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) { const key = u < v ? u + "_" + v : v + "_" + u; count.set(key, (count.get(key) || 0) + 1); }
    T = keep;
    for (const [key, c] of count) if (c === 1) { const [u, v] = key.split("_").map(Number), t = tri(u, v, i); if (t) T.push(t); }
  }
  const edges = new Set();
  for (const t of T) {
    if (t.a >= n || t.b >= n || t.c >= n) continue;
    for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) edges.add(u < v ? u + "_" + v : v + "_" + u);
  }
  if (!edges.size) return chain();
  return [...edges].map(k => k.split("_").map(Number));
}

const PATTERN = {1: [[.5, .5]], 2: [[.27, .36], [.73, .64]], 3: [[.5, .16], [.16, .82], [.84, .82]], 4: [[.5, .12], [.12, .56], [.88, .5], [.5, .9]], 5: [[.16, .2], [.84, .2], [.5, .52], [.16, .84], [.84, .84]]};
const yearOf = d => { const m = /^(\d{4})/.exec(String((d && d.doc_date) || "")); return m ? m[1] : ""; };
/** The short caption under a node: its gazette number, else its year. */
export const caption = d => String((d && d.gazette_no) || "").trim() || yearOf(d);

/**
 * Positions for a W x H panel. Returns
 *   {nodes: Map(id -> {id, doc, x, y, r, box, seq}), boxes: [{cat, x, y, w, h, count, ids}], mesh: [{a, b, box}], order: [id], height, base, labels}.
 * `height` can exceed H when there are very many documents; the caller then lets the pane scroll.
 */
export function layout(docs, W, H) {
  const nodes = new Map();
  if (!docs.length) return {nodes, boxes: [], mesh: [], order: [], height: H, base: 8, labels: false};
  const groups = groupBands(docs), maxPages = Math.max(1, ...docs.map(d => d.pages || 1));
  const pad = clamp(W * 0.018, 10, 26), top = 10, gap = 16, per = 4200;            // per: the room one document needs in its box
  const need = docs.length * per * 1.45 + groups.length * 5200;
  let height = Math.ceil(Math.max(H, need / Math.max(1, W - pad * 2) + pad * 2 + top)), rects;
  const items = groups.map(g => ({cat: g.cat, docs: g.docs, value: Math.max(g.docs.length, 1) + 1.6}));
  if (W < 560) {
    // narrow screens: one column of full-width boxes in reading order, so each box label has room
    const L = Math.max(60, W - pad * 2), iw = L - gap - 32, per1 = Math.max(1, Math.floor(iw / 74));
    const minH = n => gap + 46 + (n <= 5 ? 100 : Math.ceil(n / per1) * 72), tot = items.reduce((t, i) => t + i.value, 0);
    const room = Math.max(60, height - pad * 2 - top);
    let y = pad + top;
    rects = items.map(it => { const h = Math.max(room * it.value / tot, minH(it.docs.length)), r = {...it, x: pad, y, w: L, h}; y += h; return r; });
    height = Math.ceil(Math.max(height, y + pad));
  } else {
    items.sort((a, b) => b.value - a.value || rank(a.cat) - rank(b.cat));
    rects = treemap(items, pad, pad + top, Math.max(60, W - pad * 2), Math.max(60, height - pad * 2 - top));
  }
  const boxes = [], order = [], mesh = [];
  let cellMin = Infinity;
  rects.forEach((r, bi) => {
    const bx = {cat: r.cat, x: r.x + gap / 2, y: r.y + gap / 2, w: Math.max(40, r.w - gap), h: Math.max(40, r.h - gap), count: r.docs.length, ids: []};
    // documents of one gazette sit next to each other, otherwise oldest first
    const byG = new Map(); r.docs.forEach(d => { const k = norm(d.gazette_no) || "~" + d.id; if (!byG.has(k)) byG.set(k, []); byG.get(k).push(d); });
    const list = [...byG.values()].map(g => g.slice().sort(byDate)).sort((a, b) => byDate(a[0], b[0])).flat();
    const ix = bx.x + 16, iy = bx.y + 30, iw = Math.max(20, bx.w - 32), ih = Math.max(20, bx.h - 30 - 16), n = list.length;
    const cols = n === 1 ? 1 : clamp(Math.round(Math.sqrt((n * iw) / ih)), 1, n), rows = Math.ceil(n / cols), cw = iw / cols, rh = ih / rows;
    const pat = PATTERN[n];            // up to five documents form a clean triangle, diamond or envelope; more use a jittered grid
    if (pat) { let dm = Infinity; pat.forEach((p, i) => pat.forEach((q, j) => { if (j > i) dm = Math.min(dm, Math.hypot((p[0] - q[0]) * iw, (p[1] - q[1]) * ih)); })); cellMin = Math.min(cellMin, n === 1 ? Math.min(iw, ih) : dm * 0.86); }
    else cellMin = Math.min(cellMin, cw, rh);
    list.forEach((d, i) => {
      const t = Math.log(1 + (d.pages || 1)) / Math.log(1 + maxPages);
      let x, y;
      if (pat) { x = ix + pat[i][0] * iw + (n > 1 ? (hash(d.id + "x") - 0.5) * iw * 0.05 : 0); y = iy + pat[i][1] * ih + (n > 1 ? (hash(d.id + "y") - 0.5) * ih * 0.05 : 0); }
      else {
        const row = Math.floor(i / cols), inRow = Math.min(cols, n - row * cols);
        let c = i % cols;
        if (inRow < cols) c = ((c + 0.5) * cols) / inRow - 0.5;           // a short last row is spread across the box
        if (row % 2) c = cols - 1 - c;                                    // snake order keeps neighbours in the sequence close together
        x = ix + (c + 0.5) * cw + (hash(d.id + "x") - 0.5) * cw * 0.36; y = iy + (row + 0.5) * rh + (hash(d.id + "y") - 0.5) * rh * 0.36;
      }
      nodes.set(d.id, {id: d.id, doc: d, box: bi, seq: order.length, t, x, y, r: 8});
      bx.ids.push(d.id); order.push(d.id);
    });
    boxes.push(bx);
  });
  const base = clamp(cellMin * 0.2, 5.5, 12.5);
  nodes.forEach(n => { n.r = Math.min(base * (0.8 + 0.55 * n.t), cellMin * 0.34 + 2); });
  boxes.forEach((bx, bi) => {
    const pts = bx.ids.map(id => nodes.get(id));
    delaunay(pts).forEach(([i, j]) => mesh.push({a: pts[i].id, b: pts[j].id, box: bi}));
  });
  return {nodes, boxes, mesh, order, height, base, labels: cellMin >= 56};
}
