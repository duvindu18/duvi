#!/usr/bin/env python3
"""Generates the static HTML pages from _build/content.py.

    python3 _build/build.py

Output (relative to the static/ folder):
    index.html, archive.html, studio.html, contact.html, 404.html,
    projects/<slug>.html
The HTML it writes is plain, readable and safe to edit by hand; just note that
re-running this script overwrites it.
"""
from pathlib import Path

import re
from datetime import date

from content import CONTACT_PAGE, CONTACTS, HOME, PRINCIPLES, PROJECTS, SITE, STUDIO, WORKS

OUT = Path(__file__).resolve().parent.parent
FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=League+Spartan:wght@300;400;500;600;700;800;900&display=swap"


# ---------------------------------------------------------------- helpers
def wordmark(root="", alt="Studio Morfis."):
    """The studio logo (black on transparent; inverted with CSS on dark grounds)."""
    return f'<img class="logo" src="{root}images/logo.png" width="1546" height="503" alt="{alt}">'


THIS_YEAR = date.today().year

# Monochrome social icons (24px grid, currentColor), chosen by the link's site.
SOCIAL_ICONS = {
    "behance.net": '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.2 5.5c.7 0 1.3.1 1.9.2.6.1 1 .3 1.4.6.4.3.7.6.9 1.1.2.5.3 1 .3 1.7 0 .7-.2 1.3-.5 1.8-.3.5-.8.9-1.4 1.2.9.3 1.5.7 1.9 1.3.4.6.6 1.3.6 2.2 0 .7-.1 1.3-.4 1.8-.3.5-.6.9-1.1 1.2-.5.3-1 .6-1.6.7-.6.2-1.2.2-1.8.2H1V5.5h6.2zm-.4 5.3c.5 0 1-.1 1.3-.4.3-.3.5-.7.5-1.2 0-.3-.1-.6-.2-.8-.1-.2-.3-.4-.5-.5-.2-.1-.4-.2-.7-.2-.3-.1-.5-.1-.8-.1H3.8v3.2h3zm.2 5.5c.3 0 .6 0 .8-.1.3-.1.5-.2.7-.3.2-.1.4-.3.5-.5.1-.2.2-.5.2-.9 0-.7-.2-1.2-.6-1.5-.4-.3-.9-.4-1.6-.4H3.8v3.7H7zm9.6 0c.4.4 1 .6 1.7.6.5 0 1-.1 1.4-.4.4-.3.6-.6.7-.9h2.4c-.4 1.2-1 2-1.8 2.6-.8.5-1.8.8-2.9.8-.8 0-1.5-.1-2.1-.4-.6-.3-1.2-.6-1.6-1.1-.4-.5-.8-1-1-1.6-.2-.6-.4-1.3-.4-2.1 0-.7.1-1.4.4-2.1.2-.6.6-1.2 1-1.6.5-.5 1-.8 1.6-1.1.6-.3 1.3-.4 2-.4.8 0 1.6.2 2.2.5.6.3 1.1.8 1.5 1.3.4.6.7 1.2.9 1.9.2.7.2 1.4.2 2.2h-7.2c0 .8.3 1.5.7 1.8zm3.1-5.2c-.3-.3-.8-.5-1.5-.5-.4 0-.8.1-1 .2-.3.1-.5.3-.6.5-.2.2-.3.4-.3.6-.1.2-.1.4-.1.6h4.4c-.2-.6-.5-1.1-.9-1.4zm-4.3-4.7h5.6v1.4h-5.6V6.4z"/></svg>',
    "instagram.com": '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5.2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="17.3" cy="6.7" r="1.25" fill="currentColor"/></svg>',
    "facebook.com": '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.4 21.5v-8.2h2.8l.4-3.2h-3.2v-2c0-.9.3-1.6 1.6-1.6h1.7V3.6c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.4H7.2v3.2H10v8.2h3.4z"/></svg>',
}


def social_icon(url, short):
    for host, svg in SOCIAL_ICONS.items():
        if host in url:
            return svg
    return f'<span class="label">{short}</span>'


NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
                "nineteen", "twenty"]


def number_word(n):
    return NUMBER_WORDS[n] if 0 <= n < len(NUMBER_WORDS) else str(n)



def tok(text):
    """Fill {founded}, {year}, {yy}, {experience}, {experience_words}; escape bare "&".

    The year values are wrapped in spans that js/main.js refreshes in the
    browser, so the static pages stay current without a rebuild.
    """
    founded = int(SITE["founded"])
    text = re.sub(r"&(?![a-zA-Z]+;|#\d+;)", "&amp;", str(text))
    return (text.replace("{founded}", str(founded))
                .replace("{year}", f'<span data-now-year>{THIS_YEAR}</span>')
                .replace("{yy}", f'<span data-now-yy>{str(THIS_YEAR)[-2:]}</span>')
                .replace("{experience_words}", f'<span data-years-since="{founded}" data-words>{number_word(max(1, THIS_YEAR - founded))}</span>')
                .replace("{experience}", f'<span data-years-since="{founded}">{max(1, THIS_YEAR - founded)}</span>'))


def rich(text):
    """tok() plus *word* -> light-weight accent."""
    return re.sub(r"\*(.+?)\*", r"<em>\1</em>", tok(text))


def reveal(lines, delay=0.0, tag="span"):
    inner = "".join(f'<span class="line"><span style="--i:{i}">{rich(l)}</span></span>' for i, l in enumerate(lines))
    return f'<{tag} class="reveal" data-reveal style="--d:{delay}s">{inner}</{tag}>'


def img_tag(root, file, w, h, alt="", eager=False, parallax=None):
    """<img> (optionally wrapped for parallax) without the surrounding frame."""
    loading = 'fetchpriority="high"' if eager else 'loading="lazy"'
    img = f'<img src="{root}images/{file}" width="{w}" height="{h}" alt="{alt}" {loading} decoding="async">'
    if parallax is not None:
        img = f'<div class="parallax-inner" data-parallax="{parallax}">{img}</div>'
    return img


def frame(root, file, w, h, alt="", cls="", eager=False, parallax=None):
    classes = f"frame {cls}".strip()
    return f'<div class="{classes}">{img_tag(root, file, w, h, alt, eager, parallax)}</div>'


def proj_href(root, p):
    return f"{root}projects/{p['slug']}.html"


def splash(root):
    bands = ""
    for i in range(3):
        light = " band--light" if i == 1 else ""
        direction = "r" if i == 1 else "l"
        marks = "".join(f"<span>{wordmark(root, alt='')}</span>" for _ in range(10))
        bands += (
            f'<div class="band{light}" style="--i:{i}">'
            f'<div class="marquee marquee--{direction}" style="--dur:{18 + i * 4}s">{marks}</div></div>\n'
        )
    digits = "".join(
        '<span class="digit"><span class="strip">' + "".join(f"<span>{n}</span>" for n in range(10)) + "</span></span>"
        for _ in range(3)
    )
    return f"""
<div id="splash" role="status" aria-label="Loading {SITE['full_name']}">
{bands}  <div class="splash-foot">
    <div><p class="label">Loading</p><p class="label">{tok(HOME['kicker'])}</p></div>
    <div class="counter" aria-hidden="true">{digits}<span class="counter-unit">%</span></div>
  </div>
  <div class="splash-resolved">
    {wordmark(root)}
    <p class="label">{tok(SITE['tagline'])}<br>{SITE['based']}</p>
  </div>
  <div class="splash-meta"><span class="label">{SITE['full_name']}</span><span class="label">{SITE['descriptor']}</span></div>
</div>"""


def rail(root, current):
    items = ""
    for i, (href, label, key) in enumerate(SITE["nav"]):
        cur = key == current
        items += (
            f'<li class="{"is-current" if cur else ""}" data-animate style="--d:{0.1 + i * 0.07:.2f}s">'
            f'<span class="tick"></span><a href="{root}{href}"{" aria-current=\"page\"" if cur else ""}>{label}</a></li>\n'
        )
    social = "".join(
        f'<li><a class="social-link" href="{h}" target="_blank" rel="noreferrer" aria-label="{n}" title="{n}">{social_icon(h, s)}</a></li>'
        for h, n, s in SITE["social"]
    )
    return f"""
<aside class="rail">
  <div class="rail__brand" data-animate>
    <a href="{root}index.html" aria-label="{SITE['full_name']}, home">{wordmark(root)}</a>
    <p class="label">{SITE['descriptor']}</p>
  </div>
  <nav class="rail__nav" aria-label="Primary">
    <ul>
{items}    </ul>
    <a class="btn-dark" href="{root}contact.html"><span class="btn-roll"><span data-label="Start a project">Start a project</span></span><i class="btn-arrow" aria-hidden="true">→</i></a>
  </nav>
  <div>
    <div class="rail__theme"><button class="theme-toggle" type="button" aria-pressed="false" data-theme-toggle><span class="dot" aria-hidden="true"></span><span data-theme-label>Dark mode</span></button></div>
    <div class="rail__foot"><ul>{social}</ul><span class="label">© {tok('{year}')}</span></div>
  </div>
</aside>"""


def mobile(root):
    links = [("index.html", "Home")] + [(h, l) for h, l, _ in SITE["nav"]]
    items = "".join(
        f'<li><a href="{root}{h}"><span class="serif">{l}</span><span class="label">0{i + 1}</span></a></li>'
        for i, (h, l) in enumerate(links)
    )
    return f"""
<header class="mobile-bar">
  <a href="{root}index.html" aria-label="{SITE['full_name']}, home">{wordmark(root)}</a>
  <button class="menu-btn" type="button" aria-expanded="false" aria-controls="mobile-menu" data-menu-toggle>
    <span data-menu-label>Menu</span><span class="bars"><i></i><i></i></span>
  </button>
</header>
<div class="mobile-menu" id="mobile-menu">
  <nav aria-label="Primary"><ul>{items}</ul></nav>
  <div class="mobile-menu__foot">
    <button class="theme-toggle" type="button" aria-pressed="false" data-theme-toggle><span class="dot" aria-hidden="true"></span><span data-theme-label>Dark mode</span></button>
    <a href="mailto:{SITE['email']}">{SITE['email']}</a>
  </div>
</div>"""


def page(filename, *, title, description, body, current="", root="", scripts=()):
    full_title = SITE["full_name"] if not title else f"{title} — {SITE['name']}"
    js = "\n".join(f'<script src="{root}js/{s}" defer></script>' for s in ("main.js", *scripts))
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{full_title}</title>
<meta name="description" content="{description}">
<meta name="theme-color" content="#FAFAFA" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E0E0D" media="(prefers-color-scheme: dark)">
<link rel="icon" href="{root}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{FONTS}">
<link rel="stylesheet" href="{root}css/style.css">
<script>
  /* Skip the splash for the rest of the session once seen (runs before paint). */
  try {{ if (sessionStorage.getItem("morfis:splash")) document.documentElement.setAttribute("data-splash-seen", ""); }} catch (e) {{}}
  /* Apply a saved light/dark choice before paint; otherwise the system setting applies. */
  try {{ var t = localStorage.getItem("morfis:theme"); if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); }} catch (e) {{}}
</script>
{js}
</head>
<body data-page="{current or 'home'}">
<a class="sr-only" href="#main">Skip to content</a>
{splash(root)}
<div id="curtain" aria-hidden="true"></div>
{rail(root, current)}
{mobile(root)}
<main id="main" class="page">
{body}
</main>
<div class="cursor-label" aria-hidden="true"></div>
</body>
</html>
"""
    path = OUT / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")
    print("wrote", path.relative_to(OUT))


# ---------------------------------------------------------------- pages
def home():
    P = PROJECTS
    cols = [[(P[1], 1), (P[3], 0), (P[0], 2)], [(P[2], 0), (P[4], 2), (P[5], 1)], [(P[0], 1), (P[5], 2), (P[3], 1)]]
    mosaic = ""
    for c, col in enumerate(cols):
        links = ""
        for p, fi in col:
            f, w, h, cap = p["figures"][fi]
            links += (
                f'<a href="{proj_href("", p)}" data-cursor="{p["title"]}">'
                f'{frame("", f, w, h, alt=f"{p["title"]}: {cap}", cls="frame--hover")}</a>'
            )
        mosaic += f'<div class="mosaic__col" data-col="{c}">{links}</div>'

    panels = ""
    for i, p in enumerate(P):
        f, w, h, _ = p["figures"][0]
        panels += f"""
      <a class="p-panel{' is-active' if i == 0 else ''}" href="{proj_href('', p)}" data-snap data-cursor="View project">
        <div class="p-panel__media" aria-hidden="true">{frame('', f, w, h)}</div>
        <div class="p-panel__body">
          <div class="p-panel__num"><strong>{p['index']}</strong><small>’{str(p['year'])[2:]}</small></div>
          <div class="p-panel__meta"><b>{p['city']} / {p['country']}</b><br>{p['typology']}<br>{p['year']}</div>
          <h2 class="p-panel__title">{p['title']}</h2>
          <div class="p-panel__foot">
            <span class="p-panel__status">{p['status']}</span>
            <span class="p-panel__cta">See project <i>→</i></span>
          </div>
        </div>
      </a>"""

    cards = ""
    for p in P:
        f, w, h, _ = p["figures"][0]
        cards += f"""
      <a class="card" href="{proj_href('', p)}">
        <div class="frame" style="aspect-ratio:4/5">{img_tag('', f, w, h, alt=p['title'])}<span class="card__num">{p['index']}</span></div>
        <div class="card__head"><h2 class="serif">{p['title']}</h2><span class="label">{p['year']}</span></div>
        <p class="label">{p['city']}, {p['country']} — {p['typology']}</p>
      </a>"""

    run = (tok(HOME["marquee"]).rstrip() + " ") * 3
    body = f"""
<section class="home" aria-label="Selected work">
  <div class="track" data-track>

    <div class="panel intro" data-snap>
      <p class="label" data-animate="fade" style="--d:.6s">{tok(HOME['kicker'])}</p>
      <h1 class="display">{reveal(HOME["headline"], 0.15)}</h1>
      <div class="intro__facts" data-animate style="--d:.7s">
        <p>{SITE['description']}</p>
        <dl>
          <dt class="label">Founded</dt><dd>{SITE['founded']}</dd>
          <dt class="label">Based</dt><dd>{SITE['based']}</dd>
          <dt class="label">Experience</dt><dd>{tok('{experience} years')}</dd>
          <dt class="label">{HOME['facts_label']}</dt><dd>{tok(HOME['facts'])}</dd>
        </dl>
      </div>
    </div>

    <div class="panel mosaic" data-snap data-mosaic>
      <div class="mosaic__grid">{mosaic}</div>
    </div>

    <div class="panel chapter" data-snap>
      <div class="chapter__run"><div class="marquee marquee--l" style="--dur:40s"><span class="label">{run}</span><span class="label">{run}</span></div></div>
      <div class="chapter__body">
        <p class="chapter__big">{HOME['chapter_word']}</p>
        <div class="chapter__row">
          <p class="chapter__num">{tok(HOME['chapter_number'])}</p>
          <p>{tok(HOME['chapter_text'])}</p>
        </div>
      </div>
      <div class="chapter__foot"><span class="label">Chapter 01</span><span class="label">{len(P):02d} projects</span></div>
    </div>

    <div class="panels" data-panels>{panels}
    </div>

    <div class="cards">{cards}
    </div>

    <div class="panel end" data-snap>
      <p class="label">Continue</p>
      <a class="serif" href="archive.html" data-cursor="Open index">The full<br><em>index</em><span class="arrow">→</span></a>
      <p class="tiny muted">{tok(HOME['end_text'])}</p>
    </div>
  </div>

  <div class="track-foot">
    <span class="label">Scroll or use ← →</span>
    <div class="progress"><i data-progress></i></div>
    <div class="track-foot__btns">
      <button class="round-btn" type="button" aria-label="Previous" data-prev>←</button>
      <button class="round-btn" type="button" aria-label="Next" data-next>→</button>
    </div>
  </div>
</section>"""
    page("index.html", title="", description=SITE["description"], body=body, scripts=("home.js",))


def archive():
    typologies = list(dict.fromkeys(p["typology"] for p in PROJECTS))
    filters = '<li><button type="button" class="hairline-link" data-filter="" aria-pressed="true">All</button></li>' + "".join(
        f'<li><button type="button" class="hairline-link" data-filter="{t}" aria-pressed="false">{t}</button></li>' for t in typologies
    )
    rows = ""
    for i, p in enumerate(sorted(PROJECTS, key=lambda p: -p["year"])):
        rows += f"""
    <li style="--i:{i}" data-typology="{p['typology']}" data-year="{p['year']}" data-title="{p['title']}" data-city="{p['city']}">
      <a class="row" href="{proj_href('', p)}" data-preview="{p['slug']}">
        <span class="label row__no tabular">{p['index']}</span>
        <span class="row__title">{p['title']}</span>
        <span class="row__type">{p['typology']}</span>
        <span class="row__loc">{p['city']}, {p['country']}</span>
        <span class="row__status">{p['status']}</span>
        <span class="row__year tabular">{p['year']}</span>
      </a>
    </li>"""
    previews = "".join(
        f'<img src="images/{p["figures"][0][0]}" alt="" data-slug="{p["slug"]}" data-tag="{p["index"]} — {p["city"]}" loading="lazy">' for p in PROJECTS
    )
    body = f"""
<div class="container">
  <header class="archive-head">
    <div>
      <p class="label">Index of works</p>
      <h1 class="display">{reveal(["Index"], 0.4)}</h1>
    </div>
    <div class="archive-head__aside">
      <p>{tok(WORKS['intro'])}</p>
      <span class="label tabular" data-count>{len(PROJECTS):02d} / {len(PROJECTS):02d} entries</span>
    </div>
  </header>

  <div class="archive-tools">
    <ul aria-label="Filter by typology">{filters}</ul>
    <div class="archive-sort">
      <span class="label">Sort</span>
      <button type="button" data-sort="title" aria-pressed="false">Name</button>
      <button type="button" data-sort="year" aria-pressed="true">Year</button>
      <button type="button" data-sort="typology" aria-pressed="false">Project</button>
    </div>
  </div>

  <div class="archive-cols grid-12 label">
    <span>No.</span><span>Name</span><span>Project</span><span>Location</span><span>Status</span><span>Year</span>
  </div>

  <ul class="rows" data-rows>{rows}
  </ul>
</div>
<div class="preview" aria-hidden="true" data-preview-box>{previews}<span class="tag" data-preview-tag></span></div>"""
    page("archive.html", title="Index", description="Index of works by Studio Morfis.", body=body, current="archive", scripts=("archive.js",))


def project(i, p):
    root = "../"
    nxt = PROJECTS[(i + 1) % len(PROJECTS)]
    words = p["title"].split()
    lines = [" ".join(words[j:j + 2]) for j in range(0, len(words), 2)]
    specs = [("Year", p["year"]), ("Location", f"{p['city']}, {p['country']}"), ("Typology", p["typology"]),
             ("Status", p["status"]), ("Area", p["area"])]
    spec_html = "".join(f'<div><dt class="label">{k}</dt><dd>{v}</dd></div>' for k, v in specs)
    # Client and materials stay in content.py but are not shown (visualization studio).
    plates = ""
    for n, (f, w, h, cap) in enumerate(p["figures"]):
        plates += f"""
      <figure class="plate" data-inview>
        <div class="frame frame--hover" style="aspect-ratio:{w}/{h}">{img_tag(root, f, w, h, alt=f"{p['title']}: {cap}", eager=n == 0, parallax=9)}</div>
        <figcaption><b class="tabular">Fig. {n + 1:02d}</b><span>{cap}</span></figcaption>
      </figure>"""
    inset = p["figures"][1]
    plate = p["figures"][2]
    paras = "".join(f"<p>{t}</p>" for t in p["narrative"])
    nf = nxt["figures"][0]
    body = f"""
<article>
  <div class="mono">
    <header class="mono__text">
      <div class="mono__top">
        <a class="label hairline-link" href="{root}archive.html">← Index</a>
        <span class="label tabular">{p['index']} / {len(PROJECTS):02d}</span>
      </div>
      <div>
        <p class="label label--wide">{p['title']}</p>
        <h1 class="display mono__title">{reveal(lines, 0.45)}</h1>
        <p class="mono__lead" data-animate style="--d:.8s">{p['lead']}</p>
      </div>
      <div data-animate style="--d:.9s">
        <dl class="specs">{spec_html}</dl>
      </div>
    </header>
    <div class="mono__plates">{plates}
    </div>
  </div>

  <section class="spread" aria-label="Project text">
    <div class="spread__meta"><p class="label">Monograph</p><p class="label">pp. {int(p['index']) * 12} — {int(p['index']) * 12 + 1}</p></div>
    <div class="spread__book" data-animate>
      <div class="spread__page">
        <p class="spread__kicker">{p['title']}</p>
        <div class="spread__inset">{frame(root, inset[0], inset[1], inset[2], alt=inset[3])}</div>
        <hr>
        <div class="spread__text">{paras}</div>
        <p class="spread__credit">{p['title']} by Studio Morfis — {p['team']}</p>
      </div>
      <div class="spread__plate">{frame(root, plate[0], plate[1], plate[2], alt=plate[3])}</div>
    </div>
  </section>

  <a class="next" href="{proj_href(root, nxt)}" data-cursor="Next project">
    <div class="next__text">
      <span class="label">Next project — {nxt['index']}</span>
      <span class="display next__title">{nxt['title']} →</span>
      <span class="label">{nxt['city']}, {nxt['country']} — {nxt['year']}</span>
    </div>
    <div class="next__img">{frame(root, nf[0], nf[1], nf[2])}</div>
  </a>
</article>"""
    page(f"projects/{p['slug']}.html", title=p["title"], description=p["lead"], body=body, current="archive", root=root)


def studio():
    principles = "".join(
        f'<li class="principle"><span class="label label--ink tabular">0{i + 1}</span><div><h2>{t}</h2><p>{b}</p></div></li>'
        for i, (t, b) in enumerate(PRINCIPLES)
    )
    # People and Recognition stay in content.py but are not shown for now.
    f1, f2 = STUDIO["figures"]
    body = f"""
<div class="container">
  <header class="studio-head">
    <div>
      <p class="label">The studio</p>
      <h1 class="display">{reveal(STUDIO["headline"], 0.4)}</h1>
    </div>
    <div class="studio-head__text" data-animate style="--d:.7s">
      {"".join(f"<p>{tok(t)}</p>" for t in STUDIO["paragraphs"])}
    </div>
  </header>

  <section class="studio-sec">
    <figure class="plate" data-inview>
      <div class="frame" style="aspect-ratio:{f1[1]}/{f1[2]}">{img_tag('', f1[0], f1[1], f1[2], alt=f1[3], parallax=9)}</div>
      <figcaption><b>Fig. 01</b><span>{f1[3]}</span></figcaption>
    </figure>
    <div><p class="label">Principles</p><ol class="list">{principles}</ol></div>
  </section>


  <figure class="plate" data-inview>
    <div class="frame" style="aspect-ratio:{f2[1]}/{f2[2]}">{img_tag('', f2[0], f2[1], f2[2], alt=f2[3], parallax=6)}</div>
    <figcaption><b>Fig. 02</b><span>{f2[3]}</span></figcaption>
  </figure>
</div>"""
    page("studio.html", title="Studio", description="About Studio Morfis.", body=body, current="studio")


def contact():
    extra = "".join(
        f'<div><p class="label">{label}</p><p class="serif">{mail}</p><p class="small muted" style="margin-top:8px">{note}</p></div>'
        for label, mail, note in CONTACTS
    )
    social = "".join(f'<li><a class="social-link social-link--named" href="{h}" target="_blank" rel="noreferrer">{social_icon(h, s)}<span>{n}</span></a></li>' for h, n, s in SITE["social"])
    body = f"""
<div class="container contact">
  <div>
    <p class="label">Contact</p>
    <h1 class="display">{reveal(CONTACT_PAGE["headline"], 0.4)}</h1>
  </div>
  <div class="contact__grid" data-animate style="--d:.7s">
    <div>
      <p class="label">New projects</p>
      <a class="contact__mail hairline-link" href="mailto:{SITE['email']}">{SITE['email']}</a>
      <p class="small" style="margin-top:12px">{SITE['phone']}</p>
      <p class="small muted" style="margin-top:24px;max-width:360px">{tok(CONTACT_PAGE['intro'])}</p>
    </div>
    <div><p class="label">Studio</p><p class="serif contact__based">{SITE['based']}</p><p class="small muted" style="margin-top:8px">{CONTACT_PAGE['based_note']}</p></div>
    {extra}
    <div class="contact__foot">
      <p class="label">© {tok('{year}')} {SITE['full_name']}</p>
      <ul>{social}</ul>
    </div>
  </div>
</div>"""
    page("contact.html", title="Contact", description="Contact Studio Morfis.", body=body, current="contact")


def not_found():
    body = """
<div class="container notfound">
  <p class="label">404</p>
  <h1 class="display">This room <em>was never built.</em></h1>
  <a class="hairline-link small" href="/archive.html">Return to the index →</a>
</div>"""
    page("404.html", title="Not found", description="Page not found.", body=body)


if __name__ == "__main__":
    home()
    archive()
    for i, p in enumerate(PROJECTS):
        project(i, p)
    studio()
    contact()
    not_found()
