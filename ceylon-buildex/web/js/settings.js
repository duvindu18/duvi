// Settings: who writes the answers. Keys are sent to the server and never come back to this page.
import {$, $$, esc, api, post, icon} from "./util.js";
import {loadStatus} from "./status.js";

const dlg = $("#settings"), msg = $("#stMsg");
let ST = null, bootTimer = 0;

// Ollama's start-up check: shows where it is, and keeps looking while it is still busy
const BUSY = ["checking", "starting", "pulling", "warming"];
function paintBoot(b) {
  const box = $("#stBoot");
  if (!b || b.state === "idle" || b.state === "disabled") { box.hidden = true; return; }
  box.hidden = false; box.dataset.state = b.state;
  $("#stBootTxt").textContent = b.message || b.state;
  $("#stBootBtn").hidden = BUSY.includes(b.state);
  $("#stBootBtn").textContent = b.state === "ready" ? "Check again" : "Try again";
}
async function watchBoot() {
  clearTimeout(bootTimer);
  if (!dlg.open) return;
  try { const b = await api("/api/ollama"); paintBoot(b); if (BUSY.includes(b.state)) bootTimer = setTimeout(watchBoot, 1500); else if (b.state === "ready") { try { ST = await api("/api/settings"); $("#stSaved").innerHTML = savedLine(ST); } catch (e) { /* keep what is shown */ } loadStatus(); } } catch (e) { /* the line stays as it was */ }
}
const savedLine = st => (st.llm.provider === "none" ? "Now: <b>off</b>. Answers quote the closest passages." : `Now: <b>${esc(st.llm.model)}</b> (${esc(st.llm.source)}).`) + (st.ollama ? ` Ollama found on this computer: <b>${esc(st.ollama)}</b>.` : "");
$("#stBootBtn").addEventListener("click", async () => { try { paintBoot(await post("/api/ollama/check", {})); } catch (e) { /* ignore */ } watchBoot(); });
dlg.addEventListener("close", () => clearTimeout(bootTimer));

function sync() {
  const p = ($('input[name="prov"]:checked') || {}).value;
  $("#stAnth").hidden = p !== "anthropic"; $("#stOai").hidden = p !== "openai";
  $("#stSave").textContent = p === "anthropic" || p === "openai" ? "Save and test" : "Save";
}
$$('input[name="prov"]').forEach(r => r.addEventListener("change", sync));

async function open() {
  msg.innerHTML = ""; $("#stForce").hidden = true;
  if (!dlg.open) dlg.showModal();
  try {
    ST = await api("/api/settings");
    const s = ST.settings, d = ST.defaults;
    $(`input[name="prov"][value="${s.provider || "auto"}"]`).checked = true;
    $("#stKeyA").value = ""; $("#stKeyO").value = "";
    $("#stKeyA").placeholder = s.anthropic_key ? `Saved ${s.anthropic_key} — leave empty to keep` : "sk-ant-…";
    $("#stKeyO").placeholder = s.openai_key ? `Saved ${s.openai_key} — leave empty to keep` : "Not needed for Ollama";
    $("#stModelA").value = s.anthropic_model || d.anthropic_model; $("#stBase").value = s.openai_base || d.openai_base; $("#stModelO").value = s.openai_model || "";
    $("#stSaved").innerHTML = savedLine(ST);
    paintBoot(ST.ollama_boot); watchBoot();
    sync();
  } catch (e) { msg.innerHTML = `<div class="notice bad">${icon("alert")}<div>${esc(e.message)}</div></div>`; }
}

async function save(force) {
  const prov = $('input[name="prov"]:checked').value, body = {provider: prov, force: !!force};
  if (prov === "anthropic") { body.api_key = $("#stKeyA").value.trim(); body.model = $("#stModelA").value.trim(); }
  if (prov === "openai") { body.api_key = $("#stKeyO").value.trim(); body.model = $("#stModelO").value.trim(); body.base_url = $("#stBase").value.trim(); }
  const btn = $("#stSave"); btn.disabled = true; $("#stForce").hidden = true;
  msg.innerHTML = `<div class="notice">${icon("spinner", "spin")}<div>${prov === "anthropic" || prov === "openai" ? "Testing the connection…" : "Saving…"}</div></div>`;
  try {
    const r = await post("/api/settings", body);
    if (r.saved) {
      msg.innerHTML = `<div class="notice ok">${icon("check-c")}<div><b>Saved.</b> ${r.test && r.test.model ? `${esc(r.test.model)} answered in ${r.test.ms} ms. ` : ""}${r.llm.provider === "none" ? "Written answers are off." : "Every question will now get a written answer."}</div></div>`;
      $("#stKeyA").value = ""; $("#stKeyO").value = ""; loadStatus();
    } else {
      msg.innerHTML = `<div class="notice bad">${icon("x-c")}<div><b>Not saved — the test failed.</b> ${esc((r.test && r.test.error) || "No answer from the model.")}</div></div>`;
      $("#stForce").hidden = false;
    }
  } catch (e) { msg.innerHTML = `<div class="notice bad">${icon("alert")}<div>${esc(e.message)}</div></div>`; }
  finally { btn.disabled = false; }
}

$("#stForm").addEventListener("submit", e => { e.preventDefault(); save(false); });
$("#stForce").addEventListener("click", () => save(true));
$("#stOllama").addEventListener("click", () => {
  $("#stBase").value = ST ? ST.defaults.ollama_base : "http://127.0.0.1:11434/v1";
  if (ST && ST.ollama) $("#stModelO").value = ST.ollama; else if (!$("#stModelO").value || $("#stModelO").value.startsWith("gpt")) $("#stModelO").value = "llama3.1";
  $("#stKeyO").value = "";
});
$("#stClose").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
$("#settingsBtn").addEventListener("click", open);
document.addEventListener("click", e => { if (e.target.closest("[data-settings]")) { e.preventDefault(); open(); } });
