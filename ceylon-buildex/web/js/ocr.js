// Scan: OCR a PDF / photo, with real page-by-page progress from the server's task.
import {$, esc, api, pollTask, copyText, toast, fillCats} from "./util.js";
import {S, on, emit} from "./state.js";
import {go} from "./router.js";
import {loadStatus} from "./status.js";

const drop = $("#drop"), fileIn = $("#file"), msg = $("#ocrMsg"), prog = $("#ocrProg"), bar = prog.firstElementChild;
let busy = false;
fillCats($("#ocrCat"), "Detect automatically");

function pick() { if (!busy) fileIn.click(); }
drop.addEventListener("click", pick);
drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); if (!busy) drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files[0] && !busy) run(e.dataTransfer.files[0]); });
fileIn.addEventListener("change", () => { if (fileIn.files[0]) run(fileIn.files[0]); fileIn.value = ""; });
$("#ocrAdd").addEventListener("change", e => { $("#ocrAddBox").hidden = !e.target.checked; });

on("status", () => {
  const s = S.status; if (!s) return;
  const o = s.ocr, langs = $("#ocrLang");
  $("#ocrInfo").innerHTML = o.available
    ? `OCR is ready · ${esc((o.languages || []).join(", ") || "eng")} · ${o.workers} worker${o.workers > 1 ? "s" : ""}`
    : `<span class="notice bad" style="display:inline-flex">Tesseract isn't installed on the server, so image-only pages can't be read.</span>`;
  const keep = langs.value;
  langs.innerHTML = `<option value="">Default (${esc((o.languages || [])[0] || "eng")})</option>` + (o.languages || []).map(x => `<option>${esc(x)}</option>`).join("");
  langs.value = keep;
});

function setBusy(b) { busy = b; drop.setAttribute("aria-disabled", String(b)); drop.style.opacity = b ? ".6" : ""; drop.style.pointerEvents = b ? "none" : ""; }

async function run(file) {
  const fd = new FormData();
  fd.append("file", file); fd.append("mode", $("#ocrMode").value); fd.append("lang", $("#ocrLang").value);
  if ($("#ocrForce").checked) fd.append("force_ocr", "1");
  if ($("#ocrAdd").checked) { fd.append("add", "1"); fd.append("title", $("#ocrTitle").value || file.name.replace(/\.[^.]+$/, "")); fd.append("category", $("#ocrCat").value); }
  setBusy(true);
  $("#ocrOut").hidden = true; $("#ocrStatus").hidden = false;
  prog.classList.add("indet"); bar.style.width = ""; msg.className = "small"; msg.textContent = `Uploading ${file.name}`;
  try {
    const {task} = await api("/api/ocr", {method: "POST", body: fd});
    const t = await pollTask(task, t => {
      const [d, n] = t.progress || [0, 1];
      prog.classList.remove("indet");
      bar.style.width = Math.max(6, Math.round(100 * d / Math.max(n, 1))) + "%";
      msg.textContent = n > 1 ? `Reading page ${Math.min(d + 1, n)} of ${n}` : "Reading";
    });
    if (t.status === "error") throw new Error(t.error);
    const r = t.result, confs = r.confs || [], avg = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;
    prog.classList.remove("indet"); bar.style.width = "100%"; msg.textContent = "Done";
    $("#ocrStats").innerHTML = `${esc(r.filename)} · ${r.n_pages} page${r.n_pages === 1 ? "" : "s"} (${r.ocr_pages} by OCR${avg ? `, ${avg}% confidence` : ""}) · ${r.seconds} s${r.added ? ` · <b>added to the dataset</b> (${r.added.chunks} passages)` : ""}`;
    $("#ocrText").value = r.text || "(no text recognised)";
    $("#ocrOut").hidden = false;
    if (r.added) { loadStatus(); emit("docs:changed"); }
  } catch (e) {
    prog.classList.remove("indet"); bar.style.width = "0";
    msg.className = "small"; msg.innerHTML = `<span class="notice bad" style="display:inline-flex">${esc(e.message)}</span>`;
  } finally { setBusy(false); }
}

$("#ocrCopy").addEventListener("click", async () => toast((await copyText($("#ocrText").value)) ? "Copied" : "Couldn't copy"));
$("#ocrDl").addEventListener("click", () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([$("#ocrText").value], {type: "text/plain"})); a.download = "ocr-text.txt"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); });
$("#ocrAsk").addEventListener("click", () => {
  const words = $("#ocrText").value.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  go("ask"); emit("ask:prefill", {text: words, mode: "passages", run: true});
});
