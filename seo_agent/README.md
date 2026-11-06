# Arch Viz SEO Agent (Fiverr + Upwork)

An AI agent that writes and fixes Fiverr gigs and Upwork profiles for **architectural
visualization** freelancers: 3D exterior/interior rendering, floor plans, walkthrough
animations, virtual tours, 3ds Max / Corona / V-Ray / Lumion / Enscape / D5 / Revit / SketchUp / Blender / Unreal.

It works as an ArchViz SEO strategist and runs a fixed workflow:

1. **Market & keyword analysis**: a primary keyword plus long-tail keywords, with buyer intent and a rough competition estimate.
2. **Fiverr gig package**: title (80 chars max) and the URL slug it produces, category path, 5 tags,
   a Basic/Standard/Premium pricing table, description with the keyword in the first 150 words, FAQs,
   requirements questionnaire, and thumbnail text.
3. **Upwork proposal**: a hook written for the specific job post, a workflow and software-stack match,
   risk reduction, a milestone plan, and a closing question.

Tools the agent uses:

| Tool | What it does |
|---|---|
| `keyword_ideas` | Built-in arch viz keyword list by niche, with long-tail variants of a seed phrase |
| `platform_guide` | Fiverr/Upwork limits, ranking factors, Fiverr category options |
| `audit_listing` | Scores a gig/profile 0-100: length limits, keyword placement, URL slug, first 150 words, tags, filler words, contact-info ToS checks |
| `check_proposal` | Scores a proposal 0-100: generic openers, hook length, job-post wording, length, closing question, ToS |
| `web_search` | Current platform rules, categories, competitor wording |
| `save_report` | Saves the final listing to `seo_agent/reports/` |

The agent checks everything it writes and keeps rewriting until the score is 85 or higher.

## Requirements

**To run the Windows app (`ArchVizSEO.exe`)**
- Windows 10 or 11, 64-bit
- An internet connection (the agent calls the Claude API and searches the web)
- A modern browser (Edge, Chrome, Firefox); the app opens it for you
- An Anthropic API key from console.anthropic.com > API Keys. API usage is billed by Anthropic to your account.
- About 40 MB of disk space. No Python install is needed.

**To run from source (any OS)**
- Python 3.10 or newer
- `pip install -r seo_agent/requirements.txt`: `anthropic` 2.6.0 and its pinned dependencies

**To build the exe yourself**
- Windows with Python 3.10 or newer
- `pip install -r seo_agent/requirements-build.txt` (adds PyInstaller and pytest; `pip install pillow` is optional, for the app icon)

## Windows app (.exe)

1. Download `ArchVizSEO.exe` (see "Getting the exe" below) and double-click it.
2. A small console window opens and the app opens in your browser at `http://127.0.0.1:8765`.
   Keep the console window open while you work. Closing it quits the app.
3. The first time, paste your Anthropic API key in the dialog. It is saved in
   `%APPDATA%\ArchVizSEO\config.json` on your computer only. Change it later with **Settings**.
4. Reports the agent saves go to `Documents\ArchViz SEO Reports`.

The exe is not code-signed, so Windows SmartScreen may show "Windows protected your PC".
Click **More info**, then **Run anyway**. Check the file against the `.sha256` hash that ships with it.

**Getting the exe:** every push that changes `seo_agent/` runs the GitHub Actions workflow
**Build ArchViz SEO exe**. It builds the exe on Windows, runs the tests, starts the exe to check that it
works, and uploads `ArchVizSEO-windows` (the exe and its SHA256). Open the repo's **Actions** tab, select the
latest run, and download the artifact. You can also start a build by hand with **Run workflow**.

**Building locally on Windows:**
```bat
pip install -r seo_agent\requirements-build.txt pillow
python seo_agent\packaging\build_exe.py
dist\ArchVizSEO.exe
```

## Web interface (from source)

```bash
pip install -r seo_agent/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python -m seo_agent.web            # then open http://127.0.0.1:8000
```

A minimal single-page interface: pick a task (Full workflow, Fiverr gig, Upwork proposal,
Upwork profile, Audit listing, Keywords), enter your niche and a short "about you", and paste a
job post or your current listing if the task needs one. Results appear as they are written, and
the tool steps show while it works. You can send follow-ups to refine the result, copy it, or
download it as `.md`. It needs only the Python standard library plus `anthropic`, works in light
and dark mode, and works on phones. Use `--host 0.0.0.0 --port 8080` to reach it from another device on your network
(there is no login, so only do this on a network you trust).

## Setup (from source)

```bash
pip install -r seo_agent/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # or save it in the web UI's Settings
```

## Command line (run from the repo root)

```bash
# Interactive chat
python -m seo_agent.agent

# Fiverr gig package (use --task full for gig + proposal framework)
python -m seo_agent.agent --task fiverr --niche "exterior rendering" \
  --about "5 years, 3ds Max + Corona, villas and residential projects"

# Audit and rewrite your current Upwork profile (paste it into a text file)
python -m seo_agent.agent --task audit --platform upwork --file my_profile.txt

# Keyword strategy for a niche, both platforms
python -m seo_agent.agent --task keywords --niche "interior design rendering"

# Tailored Upwork proposal for a job post
python -m seo_agent.agent --task proposal --file job_post.txt
```

After a `--task` run you can keep chatting to refine the result, e.g. "make 3 variations
of the title" or "now do the Premium package for animation".

## Notes
- The platform limits in `knowledge.py` (Fiverr: 80-char title, 5 tags of up to 20 chars,
  1200-char description; Upwork: about 70-char title, 15 skills, the first ~200 characters
  of the overview visible) are the commonly documented values. Platforms change them, so
  the agent checks with web search when a limit matters.
- Competition levels are estimates, not measured search volume. The agent is told not to
  invent search numbers.
- Keywords get a listing into search results. Click-through rate, conversion, response
  time and reviews decide how it ranks, so the agent also suggests steps for those.
- Model: `claude-opus-5-5` with adaptive thinking and refusal fallbacks enabled
  (`fallbacks="default"`). Change `MODEL` in `agent.py` to use another model.

## Tests
```bash
python -m pytest -q seo_agent/tests
```
