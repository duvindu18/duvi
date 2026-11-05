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

from content import OFFICES, PEOPLE, PRINCIPLES, PROJECTS, RECOGNITION, SITE

OUT = Path(__file__).resolve().parent.parent
FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=League+Spartan:wght@300;400;500;600;700;800;900&display=swap"


# ---------------------------------------------------------------- helpers
def wordmark():
    return '<span class="wordmark">Halde.</span>'


def reveal(lines, delay=0.0, tag="span"):
    inner = "".join(f'<span class="line"><span style="--i:{i}">{l}</span></span>' for i, l in enumerate(lines))
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


def splash():
    bands = ""
    for i in range(3):
        light = " band--light" if i == 1 else ""
        direction = "r" if i == 1 else "l"
        marks = "".join(f"<span>{wordmark()}</span>" for _ in range(10))
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
    <div><p class="label">Loading</p><p class="label">Selected works 2020 — 2026</p></div>
    <div class="counter" aria-hidden="true">{digits}<span class="counter-unit">%</span></div>
  </div>
  <div class="splash-resolved">
    {wordmark()}
    <p class="label">{SITE['tagline']}<br>{SITE['city']} — Est. {SITE['founded']}</p>
  </div>
  <div class="splash-meta"><span class="label">{SITE['full_name']}</span><span class="label">{SITE['coordinates']}</span></div>
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
        f'<li><a class="label hairline-link" href="{h}" target="_blank" rel="noreferrer" aria-label="{n}">{s}</a></li>'
        for h, n, s in SITE["social"]
    )
    return f"""
<aside class="rail">
  <div class="rail__brand" data-animate>
    <a href="{root}index.html" aria-label="{SITE['full_name']}, home">{wordmark()}</a>
    <p class="label">Architecture Office</p>
  </div>
  <nav class="rail__nav" aria-label="Primary">
    <ul>
{items}    </ul>
    <a class="btn-dark" href="{root}contact.html">Start a project</a>
  </nav>
  <div>
    <div class="rail__ticker">
      <p class="label">{SITE['city']}</p>
      <time data-clock>--:--:--</time>
      <p class="label">{SITE['coordinates']}</p>
    </div>
    <div class="rail__foot"><ul>{social}</ul><span class="label">© {SITE['year']}</span></div>
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
  <a href="{root}index.html" aria-label="{SITE['full_name']}, home">{wordmark()}</a>
  <button class="menu-btn" type="button" aria-expanded="false" aria-controls="mobile-menu" data-menu-toggle>
    <span data-menu-label>Menu</span><span class="bars"><i></i><i></i></span>
  </button>
</header>
<div class="mobile-menu" id="mobile-menu">
  <nav aria-label="Primary"><ul>{items}</ul></nav>
  <div class="mobile-menu__foot">
    <div><p class="label">{SITE['city']}</p><time data-clock>--:--:--</time></div>
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
<meta name="theme-color" content="#FAFAFA">
<link rel="icon" href="{root}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{FONTS}">
<link rel="stylesheet" href="{root}css/style.css">
<script>
  /* Skip the splash for the rest of the session once seen (runs before paint). */
  try {{ if (sessionStorage.getItem("halde:splash")) document.documentElement.setAttribute("data-splash-seen", ""); }} catch (e) {{}}
</script>
{js}
</head>
<body data-page="{current or 'home'}">
<a class="sr-only" href="#main">Skip to content</a>
{splash()}
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

    run = "Selected works / 2020 — 2026 / Six buildings / Copenhagen — Lisbon — Reykjavík / " * 3
    body = f"""
<section class="home" aria-label="Selected works">
  <div class="track" data-track>

    <div class="panel intro" data-snap>
      <p class="label" data-animate="fade" style="--d:.6s">[ Selected works 2020 — 2026 ]</p>
      <h1 class="display">{reveal(["Rooms shaped", "by <em>mass,</em> light", "&amp; slow time."], 0.15)}</h1>
      <div class="intro__facts" data-animate style="--d:.7s">
        <p>{SITE['description']}</p>
        <dl>
          <dt class="label">Founded</dt><dd>{SITE['founded']}, {SITE['city']}</dd>
          <dt class="label">Practice</dt><dd>Houses, culture, public space</dd>
        </dl>
      </div>
    </div>

    <div class="panel mosaic" data-snap data-mosaic>
      <div class="mosaic__grid">{mosaic}</div>
    </div>

    <div class="panel chapter" data-snap>
      <div class="chapter__run"><div class="marquee marquee--l" style="--dur:40s"><span class="label">{run}</span><span class="label">{run}</span></div></div>
      <div class="chapter__body">
        <p class="chapter__big">Works</p>
        <div class="chapter__row">
          <p class="chapter__num">/26</p>
          <p>Six projects across four countries: a house, a pavilion, a chapel, an archive and two places to live.</p>
        </div>
      </div>
      <div class="chapter__foot"><span class="label">Chapter 01</span><span class="label">{len(P):02d} projects</span></div>
    </div>

    <div class="panels" data-panels>{panels}
    </div>

    <div class="cards">{cards}
    </div>

    <div class="panel end" data-snap>
      <p class="label">[ Continue ]</p>
      <a class="serif" href="archive.html" data-cursor="Open index">The full<br><em>index</em><span class="arrow">→</span></a>
      <p class="tiny muted">Every built work, competition and study since {SITE['founded']}, with drawings and material notes.</p>
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
      <p class="label">[ Index of works ]</p>
      <h1 class="display">{reveal(["Index"], 0.4)}</h1>
    </div>
    <div class="archive-head__aside">
      <p>A complete register of built and ongoing work. Hover a title to preview it; select to open the monograph.</p>
      <span class="label tabular" data-count>{len(PROJECTS):02d} / {len(PROJECTS):02d} entries</span>
    </div>
  </header>

  <div class="archive-tools">
    <ul aria-label="Filter by typology">{filters}</ul>
    <div class="archive-sort">
      <span class="label">Sort</span>
      <button type="button" data-sort="year" aria-pressed="true">Year</button>
      <button type="button" data-sort="title" aria-pressed="false">Project</button>
      <button type="button" data-sort="city" aria-pressed="false">Location</button>
    </div>
  </div>

  <div class="archive-cols grid-12 label">
    <span>No.</span><span>Project</span><span>Typology</span><span>Location</span><span>Status</span><span>Year</span>
  </div>

  <ul class="rows" data-rows>{rows}
  </ul>
</div>
<div class="preview" aria-hidden="true" data-preview-box>{previews}<span class="tag" data-preview-tag></span></div>"""
    page("archive.html", title="Index", description="Index of works by Halde Architecture Office.", body=body, current="archive", scripts=("archive.js",))


def project(i, p):
    root = "../"
    nxt = PROJECTS[(i + 1) % len(PROJECTS)]
    words = p["title"].split()
    lines = [" ".join(words[j:j + 2]) for j in range(0, len(words), 2)]
    specs = [("Year", p["year"]), ("Location", f"{p['city']}, {p['country']}"), ("Typology", p["typology"]),
             ("Status", p["status"]), ("Area", p["area"]), ("Client", p["client"])]
    spec_html = "".join(f'<div><dt class="label">{k}</dt><dd>{v}</dd></div>' for k, v in specs)
    mats = "".join(
        f'<li><span class="swatch" style="background:{s}"></span><span>{n}</span><span class="note">{note}</span></li>'
        for n, note, s in p["materials"]
    )
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
        <p class="label label--wide">[ {p['title']} ]</p>
        <h1 class="display mono__title">{reveal(lines, 0.45)}</h1>
        <p class="mono__lead" data-animate style="--d:.8s">{p['lead']}</p>
      </div>
      <div data-animate style="--d:.9s">
        <dl class="specs">{spec_html}</dl>
        <div class="materials"><p class="label">Materials</p><ul>{mats}</ul></div>
      </div>
    </header>
    <div class="mono__plates">{plates}
    </div>
  </div>

  <section class="spread" aria-label="Project text">
    <div class="spread__meta"><p class="label">[ Monograph ]</p><p class="label">pp. {int(p['index']) * 12} — {int(p['index']) * 12 + 1}</p></div>
    <div class="spread__book" data-animate>
      <div class="spread__page">
        <p class="spread__kicker">[ {p['title']} ]</p>
        <div class="spread__inset">{frame(root, inset[0], inset[1], inset[2], alt=inset[3])}</div>
        <hr>
        <div class="spread__text">{paras}</div>
        <p class="spread__credit">{p['title']} by Halde Architecture Office — {p['team']}</p>
      </div>
      <div class="spread__plate">{frame(root, plate[0], plate[1], plate[2], alt=plate[3])}</div>
      <div class="spread__gutter"></div>
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
    people = "".join(f'<li class="person"><span class="serif">{n}</span><span class="label">{r}</span></li>' for n, r in PEOPLE)
    awards = "".join(f'<li class="award"><span class="tabular">{y}</span><span>{a}</span><span>{p}</span></li>' for y, a, p in RECOGNITION)
    body = f"""
<div class="container">
  <header class="studio-head">
    <div>
      <p class="label">[ The studio ]</p>
      <h1 class="display">{reveal(["A small office for", "buildings that <em>take</em>", "their time."], 0.4)}</h1>
    </div>
    <div class="studio-head__text" data-animate style="--d:.7s">
      <p>Halde was founded in {SITE['city']} in {SITE['founded']} by Astrid Halde. We are fourteen people working between Copenhagen and Lisbon, on a deliberately small number of projects at a time.</p>
      <p>Our work spans private houses, cultural and sacred buildings, and public housing. The scale changes; the questions stay the same: mass, light, and how a room will feel in forty years.</p>
    </div>
  </header>

  <section class="studio-sec">
    <figure class="plate" data-inview>
      <div class="frame" style="aspect-ratio:1600/2000">{img_tag('', 'studio-1.jpg', 1600, 2000, alt='The studio on Strandgade', parallax=9)}</div>
      <figcaption><b>Fig. 01</b><span>The studio, Strandgade 27B</span></figcaption>
    </figure>
    <div><p class="label">Principles</p><ol class="list">{principles}</ol></div>
  </section>

  <section class="studio-sec">
    <div><p class="label">People</p><ul class="list">{people}</ul></div>
    <div><p class="label">Recognition</p><ul class="list">{awards}</ul></div>
  </section>

  <figure class="plate" data-inview>
    <div class="frame" style="aspect-ratio:2000/1334">{img_tag('', 'studio-2.jpg', 2000, 1334, alt='Model workshop', parallax=6)}</div>
    <figcaption><b>Fig. 02</b><span>Model workshop, winter</span></figcaption>
  </figure>
</div>"""
    page("studio.html", title="Studio", description="About Halde Architecture Office.", body=body, current="studio")


def contact():
    offices = ""
    for note, city, lines in OFFICES:
        addr = "".join(f"{l}<br>" for l in lines)
        offices += f'<div><p class="label">{note}</p><p class="serif">{city}</p><address class="small" style="margin-top:8px">{addr}</address></div>'
    social = "".join(f'<li><a class="hairline-link" href="{h}" target="_blank" rel="noreferrer">{n}</a></li>' for h, n, _ in SITE["social"])
    body = f"""
<div class="container contact">
  <div>
    <p class="label">[ Contact ]</p>
    <h1 class="display">{reveal(["Begin with", "<em>a conversation.</em>"], 0.4)}</h1>
  </div>
  <div class="contact__grid" data-animate style="--d:.7s">
    <div>
      <p class="label">New projects</p>
      <a class="contact__mail hairline-link" href="mailto:{SITE['email']}">{SITE['email']}</a>
      <p class="small" style="margin-top:12px">{SITE['phone']}</p>
      <p class="small muted" style="margin-top:24px;max-width:360px">We take on four to six new commissions a year. Tell us about the site, the people who will use it, and the timeframe you have in mind.</p>
    </div>
    {offices}
    <div class="contact__foot">
      <p class="label">Local time — <time class="label--ink" data-clock>--:--:--</time></p>
      <ul>{social}</ul>
    </div>
  </div>
</div>"""
    page("contact.html", title="Contact", description="Contact Halde Architecture Office.", body=body, current="contact")


def not_found():
    body = """
<div class="container notfound">
  <p class="label">[ 404 ]</p>
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
