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

## Web interface

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

## Setup

```bash
pip install -r seo_agent/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # from console.anthropic.com
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
