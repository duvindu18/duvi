# ArchViz SEO Agent (Fiverr + Upwork)

An SEO tool for **architectural visualization** freelancers. It writes and checks Fiverr gigs,
Upwork profiles and Upwork proposals for 3D exterior and interior rendering, 3D floor plans,
walkthrough animation, 360 tours, Unreal Engine 5, real estate rendering and 3D modeling.

**It is free by default.** You don't need an account, an API key or a credit card.

## Engines

| Engine | Cost | Needs | What it does |
|---|---|---|---|
| **Built-in** (default) | Free | Nothing. Works offline | Generates the full package from built-in ArchViz knowledge and templates, then scores it with the SEO checkers. Instant. |
| **Local AI (Ollama)** | Free | [Ollama](https://ollama.com) installed on your PC + one model | Takes the built-in draft and rewrites it with an open AI model that runs on your own computer. Supports follow-up chat. Nothing leaves your PC. |
| **Copy prompt for a free chatbot** | Free | Any free chatbot account | Copies a ready-made prompt (instructions + research + draft) to paste into the free tier of claude.ai, ChatGPT or Gemini. |
| Claude API | Paid per use | Anthropic API key | Full AI agent with live web research. Optional; ignore it to stay free. |

### What you get (Full workflow)
1. **Market & keyword analysis**: primary keyword plus long-tail phrases, with intent, a competition estimate and where to use each.
2. **Fiverr gig package**: title (80 chars max) with alternatives, the URL slug it creates, category path, 5 tags,
   a Basic/Standard/Premium pricing table scaled to your experience, a description (1200 chars max) with the keyword
   in the first sentence, FAQs, a requirements questionnaire and thumbnail ideas.
3. **Upwork proposal**: paste a job post and it reads the property, style, lighting, source files,
   quantity, software, deadline, budget and client questions. It then writes a hook about that project,
   a modelling/render pipeline, a milestone plan, answers to common questions and a closing question.

Other tasks: **Upwork profile** (title, 200-character hook, overview, 15 skills, catalog offers),
**Audit listing** (scores your current gig or profile, then rewrites it), and **Keywords**.

Every listing and proposal is scored 0-100 by the built-in checkers. They cover character limits,
keyword placement, URL slug, first 150 words, tag quality, filler words, generic proposal openers,
reuse of the job post's wording, the closing question, and contact details that break the platforms' rules.
A high score means the listing passes these checks. It does not guarantee a search ranking.

## Verify tab: check keywords and results with real data (free)

The Built-in engine works offline, so its competition levels are estimates. The **Verify** tab
replaces them with real numbers that you collect yourself:

1. **Keyword checker:** load the keywords for your niche (or add your own). Each keyword has buttons
   that open the normal **Fiverr**, **Upwork Jobs** and **Upwork Talent** search pages in your browser.
   Type in the number of results, and whether Fiverr suggests the phrase as you type it. Each keyword
   gets a 0-100 score (demand against competition, on a log scale) and advice: title, tag, description
   only, or drop.
2. **Used automatically:** your best-scoring checked keywords become the gig's tags, keywords you
   checked and scored as weak are left out, and the keyword table shows your real scores.
3. **Gig stats tracker:** from Fiverr Analytics, log impressions, clicks and orders for the same period
   each time, plus what you changed. It works out the click-through rate (CTR) and conversion rate, shows
   the change since your last entry, and tells you what to fix next: tags if impressions are low, the
   thumbnail or title if CTR is under 1%, the description or packages if conversion is under 2%.
   These thresholds are rules of thumb.

The app never scrapes Fiverr or Upwork, which their rules forbid. It only opens search pages for you.
Everything you enter is saved on your computer only, in `%APPDATA%\ArchVizSEO\verify.json`
(or `~/.config/ArchVizSEO/` on Linux/macOS).

## Requirements

**Windows app (`ArchVizSEO.exe`)**
- Windows 10 or 11, 64-bit, and a browser (Edge, Chrome, Firefox)
- About 40 MB of disk space. No Python, no internet and no account needed for the Built-in engine
- Optional: [Ollama](https://ollama.com) for the free Local AI engine. An 8B model needs about 5 GB of
  disk and 8 GB+ RAM, and runs faster with a GPU

**From source (any OS)**: Python 3.10+ and `pip install -r seo_agent/requirements.txt`

**To build the exe yourself**: Windows, Python 3.10+, `pip install -r seo_agent/requirements-build.txt`

## Windows app (.exe)

1. Download `ArchVizSEO.exe` (see below) and double-click it.
2. A small console window opens and the app opens in your browser at `http://127.0.0.1:8765`.
   Keep the console window open while you use the app. Closing it quits the app.
3. Leave the engine on **Built-in**, pick a task, type your niche and press **Generate**.

The exe isn't code-signed, so Windows SmartScreen may say "Windows protected your PC". Click
**More info**, then **Run anyway**. You can check the file against the `.sha256` hash that comes with it.

**Getting the exe:** each push that changes `seo_agent/` runs the GitHub Actions workflow
**Build ArchViz SEO exe**. It builds the exe on Windows, runs the tests, starts the exe and checks that
it generates a gig, then uploads `ArchVizSEO-windows`. Open the repo's **Actions** tab, select the latest
green run, and download the artifact.

### Free Local AI with Ollama (optional)
1. Install Ollama from https://ollama.com (free).
2. In a terminal: `ollama pull llama3.1:8b` (or `qwen2.5:7b`, `gemma2:9b`).
3. Reopen the app and pick **Local AI**. Your installed models appear in a list.

## From source

```bash
pip install -r seo_agent/requirements.txt
python -m seo_agent.web                    # web UI at http://127.0.0.1:8000
python -m seo_agent.launcher               # same, opens the browser (what the exe runs)

# command line (Built-in engine by default)
python -m seo_agent.agent --task full --niche "exterior rendering" --about "5 years, 3ds Max + Corona"
python -m seo_agent.agent --task proposal --file job_post.txt
python -m seo_agent.agent --task audit --platform upwork --file my_profile.txt
python -m seo_agent.agent --task full --niche "interior rendering" --engine ollama
```

Tasks: `full`, `fiverr`, `proposal`, `upwork_profile`, `audit`, `keywords`.
For `audit`, paste your listing with lines like `Title: ...`, `Tags: a, b, c`, then the description.

## Notes
- Platform limits (Fiverr: 80-char title, 5 tags of up to 20 chars, 1200-char description;
  Upwork: about 70-char title, 15 skills, the first ~200 characters of the overview visible) are the
  commonly documented values. You can edit them in `knowledge.py` if a platform changes them.
- Fiverr category paths are a best guess. Pick the closest match in the gig editor.
- Competition levels are estimates, not measured search volume.
- Prices scale with the experience you enter in *About you* (`2 years`, `senior`, ...). Without it, the
  app assumes a mid-level seller and says so.
- Replace every `[bracketed]` placeholder (prices, portfolio notes) before you send a proposal.
- Keywords get you into search results. Click-through rate, conversion, response time and reviews decide your ranking.

## Tests
```bash
python -m pytest -q seo_agent/tests
```
