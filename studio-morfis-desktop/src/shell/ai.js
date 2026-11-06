'use strict';
/* The automation agent's model runs on this computer through Ollama (MIT licence, free): https://ollama.com
   Nothing is sent to an online service. The endpoint is limited to this computer by prefs.js. */

const SUGGESTED = [
  { name: 'qwen2.5:3b', size: '1.9 GB', note: 'Recommended. Fast, good at structured answers. Apache 2.0.' },
  { name: 'qwen2.5:7b', size: '4.7 GB', note: 'Better writing, needs 8 GB of free memory. Apache 2.0.' },
  { name: 'llama3.2:3b', size: '2.0 GB', note: 'Good general writing. Llama 3.2 community licence.' },
  { name: 'gemma3:4b', size: '3.3 GB', note: 'Good writing and reasoning. Gemma licence.' }
];

const base = (prefs) => String(prefs.get('aiEndpoint')).replace(/\/+$/, '');

async function call(prefs, pathName, body, timeoutMs) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs || 120000);
  try {
    const r = await fetch(base(prefs) + pathName, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal } : { signal: ctl.signal });
    if (!r.ok) { const txt = await r.text().catch(() => ''); throw new Error(/not found/i.test(txt) ? 'The model is not downloaded yet.' : 'The AI engine answered ' + r.status + '.'); }
    return r;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The AI engine took too long to answer.');
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(e.message) + String(e.cause && e.cause.code))) { const x = new Error('The AI engine is not running. Start Ollama and try again.'); x.code = 'OFFLINE'; throw x; }
    throw e;
  } finally { clearTimeout(t); }
}

async function status(prefs) {
  const want = prefs.get('aiModel');
  try {
    const r = await call(prefs, '/api/tags', null, 2500), j = await r.json();
    const models = (j.models || []).map((m) => ({ name: m.name, size: m.size || 0 }));
    const has = models.some((m) => m.name === want || m.name === want + ':latest' || m.name.split(':')[0] === want && !/:/.test(want));
    let version = '';
    try { version = (await (await call(prefs, '/api/version', null, 2000)).json()).version || ''; } catch (e) { version = ''; }
    return { running: true, version: version, models: models, model: want, ready: has, enabled: prefs.get('aiEnabled'), suggested: SUGGESTED };
  } catch (e) {
    return { running: false, models: [], model: want, ready: false, enabled: prefs.get('aiEnabled'), suggested: SUGGESTED, error: e.message };
  }
}

/* one question, one answer; with json: true the model must answer with a JSON object, which is parsed here */
async function chat(prefs, o) {
  if (!prefs.get('aiEnabled')) throw new Error('The AI assistant is turned off in Automations.');
  const body = {
    model: prefs.get('aiModel'), stream: false, keep_alive: '10m',
    messages: [{ role: 'system', content: String(o.system || '') }, { role: 'user', content: String(o.prompt || '') }],
    options: { temperature: o.temperature == null ? 0.2 : +o.temperature, num_ctx: 8192 }
  };
  if (o.json) body.format = 'json';
  const r = await call(prefs, '/api/chat', body, o.timeoutMs || 180000), j = await r.json();
  const text = (j.message && j.message.content) || '';
  if (!o.json) return { text: text.trim() };
  try { return { data: JSON.parse(text) }; }
  catch (e) {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) { try { return { data: JSON.parse(m[0]) }; } catch (x) { /* fall through */ } }
    throw new Error('The AI answer could not be read. Try again.');
  }
}

/* download a model, reporting progress as it goes */
async function pull(prefs, name, onProgress) {
  const r = await call(prefs, '/api/pull', { model: name || prefs.get('aiModel'), stream: true }, 6 * 3600 * 1000);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', last = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { last = JSON.parse(line); } catch (e) { continue; }
      if (last.error) throw new Error(last.error);
      onProgress({ status: last.status || '', completed: last.completed || 0, total: last.total || 0 });
    }
  }
  return { ok: /success/i.test(last.status || '') };
}

module.exports = { status, chat, pull, SUGGESTED };
