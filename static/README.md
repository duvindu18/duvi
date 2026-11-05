# Studio Morfis — static HTML / CSS / JS version

The same minimalist architecture site as `../web` (Next.js), rebuilt with
**no framework and no build step**: plain HTML pages, one stylesheet and three
small vanilla-JS files. Open `index.html` in a browser, or upload the folder to
any static host (Netlify, GitHub Pages, S3, Apache/Nginx…).

```bash
# optional: preview with a local server
cd static && python3 -m http.server 8000   # → http://localhost:8000
```

## File list

```
static/
├── index.html                    Home: splash → horizontal editorial track
├── archive.html                  "Index": filterable / sortable table + cursor image preview
├── studio.html                   Practice, principles, people, recognition
├── contact.html                  Email, offices, live studio clock
├── 404.html                      Not-found page
├── projects/
│   ├── the-monolithic-void.html  Monograph page per project: sticky narrative +
│   ├── timber-pavilion.html      spec sheet, parallax plates, printed book spread,
│   ├── house-of-clay.html        next-project link
│   ├── basalt-archive.html
│   ├── chapel-of-still-light.html
│   └── courtyard-houses.html
├── css/
│   └── style.css                 All styles: tokens, splash, curtain, rail, pages, responsive
├── js/
│   ├── main.js                   Every page: splash, page curtain, reveals, image fade,
│   │                             parallax, clock, mobile menu, cursor label
│   ├── home.js                   Home only: inertia + snap horizontal scroll, progress, panels
│   └── archive.js                Index only: filter, sort, hover dim, floating preview
├── images/                       20 placeholder JPGs (swap for real photography)
│   ├── monolith-1..3.jpg  timber-1..3.jpg  clay-1..3.jpg
│   ├── basalt-1..3.jpg    chapel-1..3.jpg  courtyard-1..3.jpg
│   └── studio-1..2.jpg
├── favicon.svg
├── _build/                       Optional: regenerates the HTML from one content file
│   ├── content.py                All text, project data, people, awards
│   └── build.py                  python3 _build/build.py
└── README.md
```

External dependency: Google Fonts (League Spartan for headings, labels and navigation; Inter for body text), loaded from
`fonts.googleapis.com`. Everything else is local.

## Editing content

- **Small edits:** change the HTML files directly.
- **Larger edits / new projects:** edit `_build/content.py` and run
  `python3 _build/build.py`. This rewrites every `.html` file, so don't mix the
  two approaches without care.
- **Images:** replace files in `images/` keeping the names (or update
  `content.py`). Portrait plates are 1600×2000, landscape 2000×1334.

## Design tokens (`css/style.css`, `:root`)

| Token | Value |
| --- | --- |
| `--canvas` | `#FAFAFA` |
| `--charcoal` | `#0A0A0A` |
| `--stone` | `#E5E5E2` |
| `--muted` | `#8A8883` |
| `--hairline` | `rgba(0,0,0,0.08)` |
| `--ease` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--curtain` | `cubic-bezier(0.76, 0, 0.24, 1)` |

The splash runs once per browser session (`sessionStorage`). All motion is
reduced when the visitor's system asks for reduced motion.
