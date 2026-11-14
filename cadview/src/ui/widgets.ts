// Small UI primitives: bottom sheet (swipe to dismiss; side panel on wide screens),
// toast, context popover, loading overlay, haptics.
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { hydrateIcons } from './icons';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- haptics (native on Android/iOS through Capacitor; vibrate() fallback on the web) ----------
export const haptic = {
  tick() { Haptics.selectionChanged().catch(() => {}); },
  tap() { Haptics.impact({ style: ImpactStyle.Light }).catch(() => navigator.vibrate?.(8)); },
  strong() { Haptics.impact({ style: ImpactStyle.Medium }).catch(() => navigator.vibrate?.(18)); },
};

// ---------- toast ----------
let toastTimer = 0;
export function toast(msg: string, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- bottom sheet ----------
let onSheetClose: (() => void) | null = null;
/** history.back() used to close a sheet must not be treated as "leave the viewer". */
let skipPop = false;
export const consumeSkipPop = () => { const v = skipPop; skipPop = false; return v; };
export function openSheet(title: string, html: string, wire?: (body: HTMLElement) => void, opts: { onClose?: () => void; tall?: boolean } = {}) {
  const sheet = $('#sheet');
  $('#sheetTitle', sheet).textContent = title;
  const body = $('#sheetBody', sheet);
  body.innerHTML = html;
  hydrateIcons(body);
  onSheetClose?.();
  onSheetClose = opts.onClose ?? null;
  sheet.classList.toggle('tall', !!opts.tall);
  sheet.style.transform = '';
  sheet.classList.add('open');
  $('#scrim').classList.add('show');
  if (!history.state?.sheet) history.pushState({ ...history.state, sheet: true }, '');
  wire?.(body);
}
export function closeSheet(fromHistory = false) {
  const sheet = $('#sheet');
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  sheet.style.transform = '';
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (scrollY || document.documentElement.scrollTop) scrollTo(0, 0); // undo any focus-induced page scroll
  $('#scrim').classList.remove('show');
  const cb = onSheetClose; onSheetClose = null; cb?.();
  if (!fromHistory && history.state?.sheet) { skipPop = true; history.back(); }
}
export const sheetOpen = () => $('#sheet').classList.contains('open');

/** Drag the sheet's handle/header down to dismiss it. */
export function wireSheetDrag() {
  const sheet = $('#sheet'), grab = $('#sheetGrab');
  let y0 = 0, dy = 0, dragging = false, t0 = 0;
  grab.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return; // let the ✕ button get its click
    if (getComputedStyle(sheet).getPropertyValue('--side').trim() === '1') return;
    dragging = true; y0 = e.clientY; dy = 0; t0 = performance.now();
    grab.setPointerCapture(e.pointerId);
    sheet.style.transition = 'none';
  });
  grab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    const fast = dy / Math.max(1, performance.now() - t0) > 0.5;
    if (dy > 90 || (fast && dy > 30)) closeSheet(); else sheet.style.transform = '';
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  $('#scrim').addEventListener('click', () => closeSheet());
  $('#sheetClose').addEventListener('click', () => closeSheet());
}

// ---------- context popover (long-press menu) ----------
export function popover(x: number, y: number, items: { icon: string; label: string; run: () => void }[]) {
  const p = $('#popover');
  p.innerHTML = items.map((it, i) => `<button data-i="${i}"><i data-icon="${it.icon}" data-size="18"></i><span>${esc(it.label)}</span></button>`).join('');
  hydrateIcons(p);
  p.classList.add('show');
  const r = p.getBoundingClientRect(), W = innerWidth, H = innerHeight;
  const px = Math.min(Math.max(12, x - r.width / 2), W - r.width - 12);
  const py = y - r.height - 24 > 70 ? y - r.height - 24 : Math.min(y + 24, H - r.height - 12);
  p.style.transform = `translate(${px}px, ${py}px)`;
  p.querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => { hidePopover(); items[+b.dataset.i!].run(); }));
  setTimeout(() => document.addEventListener('pointerdown', outside, { capture: true }), 0);
}
function outside(e: Event) {
  if (!$('#popover').contains(e.target as Node)) hidePopover();
}
export function hidePopover() {
  $('#popover').classList.remove('show');
  document.removeEventListener('pointerdown', outside, { capture: true });
}

// ---------- loading overlay ----------
export const loading = {
  show(name: string, onCancel?: () => void) {
    const l = $('#loading');
    $('#loadName', l).textContent = name;
    $('#loadStage', l).textContent = 'Opening…';
    $('#loadBar', l).style.width = '0%';
    l.classList.add('show', 'indeterminate');
    $('#loadCancel', l).onclick = () => { onCancel?.(); loading.hide(); };
  },
  progress(stage: string, f: number) {
    const l = $('#loading');
    $('#loadStage', l).textContent = stage;
    if (f > 0 && f < 1) { l.classList.remove('indeterminate'); $('#loadBar', l).style.width = `${Math.round(f * 100)}%`; }
    else l.classList.add('indeterminate');
  },
  hide() { $('#loading').classList.remove('show'); },
};

export function fmtBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
}
export function fmtAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}
