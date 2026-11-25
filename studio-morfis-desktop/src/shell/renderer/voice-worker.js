/* The voice assistant's ears and mouth, in a worker so the window never stalls. Nothing leaves the computer:
   every model and engine file is served by the app itself (morfis://app/...).
     ears:  Whisper base (Xenova/whisper-base, 8-bit) through transformers.js: 16 kHz audio in, English text out.
     mouth: Kokoro-82M (8-bit ONNX) through ONNX Runtime: text -> espeak-ng phonemes -> token ids -> 24 kHz audio.
   The text clean-up before phonemes follows kokoro-js (Apache-2.0, hexgrad/kokoro), so numbers, times, money and
   titles are read the way Kokoro expects. */
import * as T from './vendor/transformers/transformers.min.js';
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { phonemize } from './vendor/phonemizer/phonemizer.js';

const BASE = new URL('./', self.location.href).href;
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, (self.navigator.hardwareConcurrency || 2) - 1)) : 1;

T.env.allowRemoteModels = false;
T.env.allowLocalModels = true;
T.env.localModelPath = BASE + 'voice/models/';
T.env.useBrowserCache = false;
T.env.backends.onnx.wasm.wasmPaths = BASE + 'vendor/ort/';
T.env.backends.onnx.wasm.numThreads = THREADS;
ort.env.wasm.wasmPaths = BASE + 'vendor/ort/';
ort.env.wasm.numThreads = THREADS;

const post = (m, transfer) => self.postMessage(m, transfer || []);

/* ----- ears ----- */
let asrP = null;
function ears() {
  if (!asrP) asrP = T.pipeline('automatic-speech-recognition', 'Xenova/whisper-base', { dtype: 'q8', device: 'wasm' });
  return asrP;
}
async function listen(id, audio) {
  const asr = await ears();
  const r = await asr(audio, { language: 'english', task: 'transcribe', chunk_length_s: 30, return_timestamps: false });
  return String((r && r.text) || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ----- mouth ----- */
/* Kokoro-82M's phoneme vocabulary (symbol -> input id), from the model's config.json; "$" is the pad token */
const VOCAB = { '$': 0, ';': 1, ':': 2, ',': 3, '.': 4, '!': 5, '?': 6, '—': 9, '…': 10, '"': 11, '(': 12, ')': 13, '“': 14, '”': 15, ' ': 16, '̃': 17,
  'ʣ': 18, 'ʥ': 19, 'ʦ': 20, 'ʨ': 21, 'ᵝ': 22, 'ꭧ': 23, A: 24, I: 25, O: 31, Q: 33, S: 35, T: 36, W: 39, Y: 41, 'ᵊ': 42,
  a: 43, b: 44, c: 45, d: 46, e: 47, f: 48, h: 50, i: 51, j: 52, k: 53, l: 54, m: 55, n: 56, o: 57, p: 58, q: 59, r: 60, s: 61, t: 62, u: 63, v: 64, w: 65, x: 66, y: 67, z: 68,
  'ɑ': 69, 'ɐ': 70, 'ɒ': 71, 'æ': 72, 'β': 75, 'ɔ': 76, 'ɕ': 77, 'ç': 78, 'ɖ': 80, 'ð': 81, 'ʤ': 82, 'ə': 83, 'ɚ': 85, 'ɛ': 86, 'ɜ': 87, 'ɟ': 90, 'ɡ': 92, 'ɥ': 99,
  'ɨ': 101, 'ɪ': 102, 'ʝ': 103, 'ɯ': 110, 'ɰ': 111, 'ŋ': 112, 'ɳ': 113, 'ɲ': 114, 'ɴ': 115, 'ø': 116, 'ɸ': 118, 'θ': 119, 'œ': 120, 'ɹ': 123, 'ɾ': 125, 'ɻ': 126,
  'ʁ': 128, 'ɽ': 129, 'ʂ': 130, 'ʃ': 131, 'ʈ': 132, 'ʧ': 133, 'ʊ': 135, 'ʋ': 136, 'ʌ': 138, 'ɣ': 139, 'ɤ': 140, 'χ': 142, 'ʎ': 143, 'ʒ': 147, 'ʔ': 148,
  'ˈ': 156, 'ˌ': 157, 'ː': 158, 'ʰ': 162, 'ʲ': 164, '↓': 169, '→': 171, '↗': 172, '↘': 173, 'ᵻ': 177 };
const MAX_TOKENS = 512, STYLE = 256;

/* text clean-up, after kokoro-js */
function year(e) {
  if (e.includes('.')) return e;
  if (e.includes(':')) { const [a, t] = e.split(':').map(Number); return t === 0 ? a + " o'clock" : t < 10 ? a + ' oh ' + t : a + ' ' + t; }
  const a = parseInt(e.slice(0, 4), 10);
  if (a < 1100 || a % 1000 < 10) return e;
  const t = e.slice(0, 2), r = parseInt(e.slice(2, 4), 10), s = e.endsWith('s') ? 's' : '';
  if (a % 1000 >= 100 && a % 1000 <= 999) { if (r === 0) return t + ' hundred' + s; if (r < 10) return t + ' oh ' + r + s; }
  return t + ' ' + r + s;
}
function cash(e) {
  const unit = e[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(e.slice(1)))) return e.slice(1) + ' ' + unit + 's';
  if (!e.includes('.')) return e.slice(1) + ' ' + unit + (e.slice(1) === '1' ? '' : 's');
  const [w, f] = e.slice(1).split('.'), n = parseInt(f.padEnd(2, '0'), 10);
  return w + ' ' + unit + (w === '1' ? '' : 's') + ' and ' + n + ' ' + (e[0] === '$' ? (n === 1 ? 'cent' : 'cents') : (n === 1 ? 'penny' : 'pence'));
}
function point(e) { const [a, t] = e.split('.'); return a + ' point ' + t.split('').join(' '); }
function clean(e) {
  return e.replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"').replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ').replace(/  +/, ' ').replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor').replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister').replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss').replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc').replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, year).replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, cash).replace(/\d*\.\d+/g, point)
    .replace(/(?<=\d)-(?=\d)/g, ' to ').replace(/(?<=\d)S/g, ' S').replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S").replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-')).replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-').trim();
}
const PUNCT = new RegExp('(\\s*[' + ';:,.!?¡¿—…"«»“”(){}[]'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ']+\\s*)+', 'g');
async function phonemes(text, british) {
  const t = clean(text), parts = [];
  let at = 0;
  for (const m of t.matchAll(PUNCT)) { if (at < m.index) parts.push({ p: false, s: t.slice(at, m.index) }); if (m[0].length) parts.push({ p: true, s: m[0] }); at = m.index + m[0].length; }
  if (at < t.length) parts.push({ p: false, s: t.slice(at) });
  const lang = british ? 'en' : 'en-us';
  let out = (await Promise.all(parts.map(async (x) => (x.p ? x.s : (await phonemize(x.s, lang)).join(' '))))).join('');
  out = out.replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ').replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ').replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (!british) out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return out.trim();
}
function ids(ph) {
  const out = [0];
  for (const ch of ph) { const v = VOCAB[ch]; if (v !== undefined) out.push(v); }
  out.push(0);
  if (out.length > MAX_TOKENS) { out.length = MAX_TOKENS - 1; out.push(0); }
  return out;
}
let ttsP = null;
const VOICES = new Map();
function mouth() {
  if (!ttsP) ttsP = ort.InferenceSession.create(BASE + 'voice/kokoro/model_quantized.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return ttsP;
}
async function voice(name) {
  if (!VOICES.has(name)) VOICES.set(name, fetch(BASE + 'voice/kokoro/voices/' + name + '.bin').then((r) => { if (!r.ok) throw new Error('No voice called ' + name + '.'); return r.arrayBuffer(); }).then((b) => new Float32Array(b)));
  return VOICES.get(name);
}
/* sentences, so the first one can be heard while the next is made */
function sentences(text) {
  const out = [];
  String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+(?=[A-Z0-9"“(])/).forEach((s) => {
    while (s.length > 260) { let cut = s.lastIndexOf(', ', 240); if (cut < 80) cut = s.lastIndexOf(' ', 240); if (cut < 40) cut = 240; out.push(s.slice(0, cut + 1).trim()); s = s.slice(cut + 1); }
    if (s.trim()) out.push(s.trim());
  });
  /* a long first sentence is cut at its first comma, so the voice starts sooner */
  if (out[0] && out[0].length > 70) { const c = out[0].indexOf(', ', 18); if (c > 0 && c < out[0].length - 12) out.splice(0, 1, out[0].slice(0, c + 1), out[0].slice(c + 2)); }
  return out;
}
const STOP = new Set();
async function speak(id, text, name, speed) {
  const [session, style] = await Promise.all([mouth(), voice(name || 'af_heart')]);
  const british = /^b/.test(name || '');
  const list = sentences(text);
  for (let i = 0; i < list.length; i++) {
    if (STOP.has(id)) { STOP.delete(id); post({ id, type: 'end', stopped: true }); return; }
    const tok = ids(await phonemes(list[i], british));
    const n = Math.min(Math.max(tok.length - 2, 0), 509);
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(tok.map(BigInt)), [1, tok.length]),
      style: new ort.Tensor('float32', style.slice(n * STYLE, n * STYLE + STYLE), [1, STYLE]),
      speed: new ort.Tensor('float32', new Float32Array([speed || 1]), [1])
    };
    const out = await session.run(feeds);
    const wave = (out.waveform || out[Object.keys(out)[0]]).data;
    const pcm = new Float32Array(wave);
    post({ id, type: 'audio', index: i, of: list.length, text: list[i], rate: 24000, pcm }, [pcm.buffer]);
  }
  post({ id, type: 'end' });
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'warm') {
      const t0 = performance.now();
      await Promise.all([m.ears !== false ? ears() : null, m.mouth !== false ? Promise.all([mouth(), voice(m.voice || 'af_heart')]) : null]);
      post({ id: m.id, type: 'ready', ms: Math.round(performance.now() - t0), threads: THREADS, isolated: !!self.crossOriginIsolated });
    } else if (m.type === 'listen') {
      const t0 = performance.now();
      const text = await listen(m.id, m.audio);
      post({ id: m.id, type: 'text', text, ms: Math.round(performance.now() - t0) });
    } else if (m.type === 'speak') {
      await speak(m.id, m.text, m.voice, m.speed);
    } else if (m.type === 'stop') {
      STOP.add(m.of);
    } else if (m.type === 'phonemes') {
      post({ id: m.id, type: 'phonemes', text: await phonemes(m.text, false) });
    }
  } catch (err) {
    post({ id: m.id, type: 'error', message: String((err && err.message) || err) });
  }
};
post({ type: 'loaded', threads: THREADS, isolated: !!self.crossOriginIsolated });
