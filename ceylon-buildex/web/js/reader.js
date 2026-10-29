// Document reader dialog: every [data-doc] button anywhere opens it (optionally at a page).
import {$, esc, api, tags, hl, icon, CAT, debounce, fmtDate} from "./util.js";

const dlg = $("#reader"), body = $("#rdBody"), search = $("#rdQ");
let cur = null, reqId = 0;

function renderChunks(chunks, q, page) {
  body.innerHTML = chunks.length
    ? chunks.map(c => `<div class="chunk" data-pg="${esc(c.page)}"><div class="pg">Page ${esc(c.page)}${c.heading ? " · " + esc(c.heading.slice(0, 90)) : ""}${c.method === "ocr" ? " · OCR" : ""}</div><pre>${hl(c.text, q)}</pre></div>`).join("")
    : `<p class="muted">No passages match.</p>`;
  if (page && !q) { const el = body.querySelector(`[data-pg="${CSS.escape(String(page))}"]`); if (el) el.scrollIntoView({block: "start"}); }
}

export async function openDoc(id, page) {
  const my = ++reqId;
  search.value = ""; $("#rdTitle").textContent = "Loading…"; $("#rdMeta").innerHTML = "";
  body.innerHTML = `<div class="skel flat" aria-hidden="true"><i class="sk w90"></i><i class="sk"></i><i class="sk w75"></i></div>`;
  if (!dlg.open) dlg.showModal();
  try {
    const j = await api("/api/doc/" + encodeURIComponent(id));
    if (my !== reqId) return;
    cur = {id, chunks: j.chunks};
    const d = j.document;
    $("#rdTitle").textContent = d.title;
    const bits = [CAT[d.category] || d.category, d.authority, d.gazette_no ? "Gazette " + d.gazette_no : "", d.doc_date ? fmtDate(d.doc_date) || d.doc_date : "",
      `${d.pages} page${d.pages === 1 ? "" : "s"}${d.ocr_pages ? ` (${d.ocr_pages} OCR)` : ""}`].filter(Boolean);
    $("#rdMeta").innerHTML = bits.map(b => `<span>${esc(b)}</span>`).join("") + `<span>${tags(d)}</span>` +
      (d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">Original ${icon("ext", "sm")}</a>` : "") +
      (d.origin !== "seed-extract" && d.sha256 ? `<a href="/api/doc/${encodeURIComponent(id)}/file" target="_blank" rel="noopener">Stored copy</a>` : "");
    if (d.notes) $("#rdMeta").insertAdjacentHTML("afterend", `<p class="small muted" id="rdNotes" style="margin-top:6px">${esc(d.notes)}</p>`);
    renderChunks(j.chunks, "", page);
  } catch (e) {
    if (my !== reqId) return;
    $("#rdTitle").textContent = "Couldn't open this document";
    body.innerHTML = `<div class="notice bad">${icon("alert")}<div>${esc(e.message)}</div></div>`;
  }
}

dlg.addEventListener("close", () => { const n = $("#rdNotes"); if (n) n.remove(); });
$("#rdClose").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
search.addEventListener("input", debounce(async () => {
  if (!cur) return;
  const q = search.value.trim(), my = ++reqId;
  if (!q) return renderChunks(cur.chunks, "");
  try { const j = await api(`/api/doc/${encodeURIComponent(cur.id)}?q=${encodeURIComponent(q)}`); if (my === reqId) renderChunks(j.chunks, q); }
  catch { /* keep what is shown */ }
}, 220));
document.addEventListener("click", e => { const b = e.target.closest("[data-doc]"); if (b) openDoc(b.dataset.doc, b.dataset.page); });
