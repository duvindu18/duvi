# Halde — architecture studio website

An ultra-minimalist editorial site for a (fictional) architecture office, built
like an architectural monograph: Swiss-grid layouts, hairline rules, a serif /
grotesk pairing and slow, inertia-based motion.

**Stack:** Next.js 14 (App Router) · React 18 · Tailwind CSS 3 · Framer Motion 11 · Zustand

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
```

## Pages

| Route | What it is |
| --- | --- |
| `/` | Splash → horizontal editorial track: intro, image mosaic, chapter title, numbered project panels, index link. Wheel/trackpad and ← → are eased and snap to panels. Stacks vertically below 1024px. |
| `/archive` | "Index": text table of works with filters, sort and a cursor-following image preview. |
| `/projects/[slug]` | Monograph: sticky narrative/spec page on the left, parallax plates on the right, an open printed spread, next project. |
| `/studio`, `/contact` | Practice, principles, people, recognition; offices and enquiries. |

## Where things live

- `lib/projects.ts` — all project content (text, specs, materials, images). Add a project here and every page picks it up.
- `lib/site.ts` — studio name, address, time zone, nav, socials.
- `tailwind.config.ts` — design tokens: `canvas #FAFAFA`, `charcoal #0A0A0A`, `stoneSubtle #E5E5E2`, `mutedText`, `ease-editorial`.
- `lib/motion.ts` — the two shared easing curves.
- `lib/splash-store.ts` — Zustand store for the splash lifecycle; page intros wait on `done`.
- `components/SplashScreen.tsx` — marquee bands + rolling counter; shown once per browser session.
- `components/home/useInertiaScroll.ts` — the lerped, snapping horizontal scroller.
- `app/template.tsx` — the charcoal curtain wipe between pages.

## Images

`public/images/*.jpg` are **placeholder** architectural studies rendered procedurally
(`npm run images`, which needs Playwright). Replace them with real photography
using the same file names, or change the imports in `lib/projects.ts`. They are
imported statically, so Next.js generates sizes and blur placeholders automatically.

Motion respects `prefers-reduced-motion`.
