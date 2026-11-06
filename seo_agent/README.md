# Arch Viz SEO Agent (Fiverr + Upwork)

An AI agent that writes and fixes Fiverr gigs and Upwork profiles for **architectural
visualization** freelancers: 3D exterior/interior rendering, floor plans, walkthrough
animations, virtual tours, 3ds Max / Corona / V-Ray / Lumion / Enscape / D5 / Revit / SketchUp / Blender / Unreal.

It runs on Claude and has these tools:

| Tool | What it does |
|---|---|
| `keyword_ideas` | Built-in arch-viz keyword list grouped by niche, with buyer intent and a rough competition estimate, plus long-tail variants of a seed phrase |
| `platform_guide` | Fiverr and Upwork character limits, rules and ranking factors |
| `audit_listing` | Scores a title, tags/skills and description from 0 to 100: length limits, keyword placement, filler words, tag quality, the 200-character Upwork hook, contact-info ToS violations, call to action |
| `web_search` | Live search for current platform rules, competitor wording and trending phrases |
| `save_report` | Saves the final listing as Markdown in `seo_agent/reports/` |

The agent audits everything it writes and keeps rewriting until the score is 85 or higher.

## Setup

```bash
pip install -r seo_agent/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # from console.anthropic.com
```

## Usage (run from the repo root)

```bash
# Interactive chat
python -m seo_agent.agent

# Create a new optimized Fiverr gig
python -m seo_agent.agent --task create --platform fiverr --niche "exterior rendering" \
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
