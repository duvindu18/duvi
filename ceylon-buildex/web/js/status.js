// Server status: dataset size, answer-writer configuration, OCR engine. Other modules react to the "status" event.
import {$, api} from "./util.js";
import {S, emit} from "./state.js";

export async function loadStatus() {
  try { S.status = await api("/api/status"); }
  catch { S.status = null; emit("status:error"); document.documentElement.dataset.ready = "1"; return null; }
  const llm = S.status.llm || {};
  const dot = $("#setDot"); if (dot) dot.classList.toggle("off", llm.provider !== "none");
  emit("status", S.status);
  document.documentElement.dataset.ready = "1";
  return S.status;
}
