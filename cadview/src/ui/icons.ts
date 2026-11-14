import {
  createElement, Ruler, SquareDashed, MapPin, Layers, Ellipsis, Search, GitCompare, Scissors, Cuboid, Sun, Share2, Maximize,
  Compass, ChevronLeft, FolderOpen, Trash2, X, Undo2, Check, Lock, LockOpen, Info, FileText, RotateCcw, Copy, Hand,
  CircleHelp, LocateFixed, Image, Shapes, Navigation, Plus, ScanLine, Sparkles,
} from 'lucide';

// Icons are bundled SVG (no icon font, no network): crisp at any density, identical on Android and iOS.
const ICONS = {
  ruler: Ruler, area: SquareDashed, pin: MapPin, layers: Layers, more: Ellipsis, search: Search, compare: GitCompare,
  section: Scissors, cube: Cuboid, sun: Sun, share: Share2, fit: Maximize, compass: Compass, back: ChevronLeft,
  open: FolderOpen, trash: Trash2, close: X, undo: Undo2, check: Check, lock: Lock, unlock: LockOpen, info: Info,
  notes: FileText, reset: RotateCcw, copy: Copy, hand: Hand, help: CircleHelp, locate: LocateFixed, image: Image,
  shapes: Shapes, north: Navigation, plus: Plus, scan: ScanLine, sparkles: Sparkles,
};
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 22): string {
  const el = createElement(ICONS[name]);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('stroke-width', '1.9');
  el.setAttribute('aria-hidden', 'true');
  return el.outerHTML;
}

/** Replace every <i data-icon="name"> in a subtree. */
export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((i) => {
    i.outerHTML = icon(i.dataset.icon as IconName, Number(i.dataset.size) || 22);
  });
}
