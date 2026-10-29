// Update: fetch the latest documents. The log and the state shown are the server's real job state, polled while it runs.
import {$, esc, api, post, pollTask, icon, CAT, fmtTime, fmt} from "./util.js";
import {on, emit, S} from "./state.js";
import {loadStatus} from "./status.js";

const btn = $("#updBtn"), msg = $("#updMsg"), log = $("#updLog"), progEl = $("#updProg"), summary = $("#updSummary"), live = $("#updLive");
let timer = null;

function render(s) {
  const lines = s.log || [];
  log.hidden = !lines.length;
  if (lines.length) { log.textContent = lines.join("\n"); log.scrollTop = log.scrollHeight; }
  btn.disabled = !!s.running;
  btn.innerHTML = s.running ? `${icon("spinner", "spin")}Updating` : `${icon("refresh")}Update now`;
  progEl.hidden = !s.running; live.hidden = !s.running;
  emit("update:running", !!s.running);
  msg.textContent = s.running ? "Scanned documents can take a few minutes." : (s.finished ? "Finished " + fmtTime(s.finished) : "");
  if (s.running) { if (!timer) timer = setInterval(poll, 1500); return; }
  if (timer) { clearInterval(timer); timer = null; loadStatus(); emit("docs:changed"); loadSources(); }
  if (s.summary) {
    const m = s.summary;
    summary.hidden = false;
    summary.innerHTML = `${icon("info")}<div><b>Last run:</b> ${m.new} new, ${m.updated} updated, ${m.unchanged} unchanged · ${m.discovered_added} discovered · ${m.inbox} from inbox · <b>${m.errors.length}</b> error${m.errors.length === 1 ? "" : "s"}${m.errors.length ? "<ul class='small'>" + m.errors.slice(0, 8).map(x => `<li>${esc(x.id)}: ${esc(x.error)}</li>`).join("") + "</ul>" : ""}</div>`;
    summary.className = "notice " + (m.errors.length ? "" : "ok");
  }
}
async function poll() { try { render(await api("/api/update/status")); } catch { /* try again on the next tick */ } }

btn.addEventListener("click", async () => {
  btn.disabled = true;
  try {
    const r = await post("/api/update", {discover: $("#updDisc").checked, accurate_ocr: $("#updAcc").checked, force: $("#updForce").checked});
    render(r.state);
  } catch (e) { btn.disabled = false; msg.textContent = e.status === 409 ? "An update is already running." : e.message; if (e.status === 409) poll(); }
});

$("#addForm").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("#addUrl").value.trim(), m = $("#addMsg"), b = $("#addBtn");
  if (!url) return;
  b.disabled = true; m.className = "small muted"; m.textContent = "Fetching…";
  try {
    const {task} = await post("/api/sources/add-url", {url});
    const t = await pollTask(task);
    if (t.status === "error") throw new Error(t.error);
    const r = t.result;
    if (r.result === "error") throw new Error(r.error);
    m.textContent = `Added: ${r.pages} pages, ${r.chunks} passages.`; $("#addUrl").value = "";
    loadStatus(); emit("docs:changed"); loadSources();
  } catch (err) { m.className = "small"; m.innerHTML = `<span class="notice bad" style="display:inline-flex">${esc(err.message)}</span>`; }
  finally { b.disabled = false; }
});

export async function loadSources() {
  const list = $("#srcList");
  try {
    const {sources, listings} = await api("/api/sources");
    $("#srcCount").textContent = `(${sources.length})`;
    $("#srcNote").textContent = `${sources.length} documents registered · ${listings.length} listing pages scanned on every update`;
    list.innerHTML = sources.map(s => `<li><div class="row-doc static" data-status="${esc(s.status || "")}"><div><div class="t">${esc(s.title)}</div>
      <div class="m"><span>${esc(CAT[s.category] || s.category || "")}</span><span>${s.last_checked ? "checked " + fmtTime(s.last_checked) + (s.last_result ? " → " + esc(s.last_result) : "") : "never downloaded"}</span>${s.last_error ? `<span style="color:var(--bad)">${esc(s.last_error)}</span>` : ""}</div></div>
      <div class="side">${s.status ? `<span class="tag ${esc(s.status)}">${esc(s.status.replace("-", " "))}</span>` : ""}<span class="tag ${s.in_dataset ? (s.origin === "seed-extract" ? "seed" : "full") : "superseded"}">${s.in_dataset ? (s.origin === "seed-extract" ? "seed extract" : "full text") : "not in dataset"}</span>${s.verified ? "" : `<span class="tag unverified">link unverified</span>`}${s.enabled === false ? `<span class="tag">disabled</span>` : ""}</div></div></li>`).join("");
  } catch (e) { list.innerHTML = `<li><div class="notice bad">${icon("alert")}<div>${esc(e.message)}</div></div></li>`; }
}

on("view", e => { if (e.detail === "update") { loadSources(); poll(); } });
on("status", () => {
  const d = S.status && S.status.dataset; if (!d) return;
  const seeds = (d.by_origin || {})["seed-extract"] || 0;
  $("#libNote").textContent = `${fmt(d.documents, 0)} documents, ${fmt(d.pages, 0)} pages.` + (seeds ? ` ${seeds} ${seeds === 1 ? "is a verified summary" : "are verified summaries"}, not full text: update to fetch the full documents.` : "");
});
// If an update was already running when the page opened, pick it up.
api("/api/update/status").then(s => { if (s.running) render(s); }).catch(() => {});
