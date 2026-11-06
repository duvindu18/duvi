"""Local tools the SEO agent can call. Plain functions so they are easy to test;
agent.py wraps them as Claude tools."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from .knowledge import (
    BANNED_CONTACT_PATTERNS,
    FIVERR_CATEGORY_CANDIDATES,
    GENERIC_OPENERS,
    STOPWORDS,
    KEYWORD_BANK,
    PLATFORM_RULES,
    UPWORK_SKILL_SUGGESTIONS,
    WEAK_WORDS,
)

REPORTS_DIR = Path(__file__).resolve().parent / "reports"


def keyword_ideas(niche: str = "all", seed: str = "") -> str:
    """Return curated arch-viz keywords for a niche, plus seed-based long-tail combos."""
    niche = niche.strip().lower().replace(" ", "_")
    groups = KEYWORD_BANK if niche in ("", "all") else {
        k: v for k, v in KEYWORD_BANK.items() if niche in k
    }
    if not groups:
        groups = KEYWORD_BANK
    out = {
        group: [{"keyword": k, "intent": i, "competition": c} for k, i, c in items]
        for group, items in groups.items()
    }
    seed = seed.strip().lower()
    if seed:
        modifiers = ["photorealistic", "3d", "exterior", "interior", "for real estate",
                     "in 3ds max", "in lumion", "animation", "render"]
        out["long_tail_from_seed"] = sorted({f"{m} {seed}" if not m.startswith(("for", "in")) else f"{seed} {m}"
                                             for m in modifiers})
    out["_note"] = ("Competition is a qualitative estimate. Low-competition long-tail phrases "
                    "rank faster for new sellers; pair one high-volume core phrase with 2-4 long-tail ones.")
    return json.dumps(out, indent=2)


def _found_keywords(text: str, keywords: list[str]) -> list[str]:
    t = text.lower()
    return [k for k in keywords if k.lower() in t]


def _contact_violations(text: str) -> list[str]:
    hits = []
    for pat in BANNED_CONTACT_PATTERNS:
        if re.search(pat, text, flags=re.IGNORECASE):
            hits.append(pat)
    return hits


def audit_listing(
    platform: str,
    title: str,
    description: str = "",
    tags: list[str] | None = None,
    target_keywords: list[str] | None = None,
) -> str:
    """Score a Fiverr gig or Upwork profile against platform limits and SEO rules (0-100)."""
    platform = platform.strip().lower()
    if platform not in PLATFORM_RULES:
        return json.dumps({"error": f"platform must be one of {list(PLATFORM_RULES)}"})
    rules = PLATFORM_RULES[platform]
    tags = [t.strip() for t in (tags or []) if t.strip()]
    targets = [k.strip() for k in (target_keywords or []) if k.strip()]
    issues: list[str] = []
    wins: list[str] = []
    score = 100

    title_max = rules["title_max"]
    if len(title) > title_max:
        issues.append(f"Title is {len(title)} chars; limit is {title_max}.")
        score -= 15
    elif len(title) < title_max * 0.6:
        issues.append(f"Title uses only {len(title)}/{title_max} chars - room for another keyword.")
        score -= 5
    else:
        wins.append(f"Title length {len(title)}/{title_max} is good.")

    if platform == "fiverr" and not title.lower().startswith("i will"):
        issues.append("Fiverr titles must start with 'I will'.")
        score -= 10

    weak = sorted(w for w in WEAK_WORDS if re.search(rf"(?<!\w){re.escape(w)}(?!\w)", title.lower()))
    if weak:
        issues.append(f"Title wastes space on filler words buyers don't search: {weak}.")
        score -= 5 * min(len(weak), 3)

    if targets:
        primary = targets[0].lower()
        head = title.lower()[: max(len(title) // 2, 30)]
        if primary not in title.lower():
            issues.append(f"Primary keyword '{targets[0]}' is missing from the title.")
            score -= 15
        elif primary not in head:
            issues.append(f"Move primary keyword '{targets[0]}' closer to the start of the title.")
            score -= 5
        else:
            wins.append("Primary keyword sits early in the title.")
        in_desc = _found_keywords(description, targets)
        missing = [k for k in targets if k not in in_desc]
        if description and missing:
            issues.append(f"Description lacks target keywords: {missing}.")
            score -= min(4 * len(missing), 12)

    if platform == "fiverr":
        if len(tags) != rules["tags_max"]:
            issues.append(f"Use exactly {rules['tags_max']} tags (you have {len(tags)}).")
            score -= 8
        long_tags = [t for t in tags if len(t) > rules["tag_chars_max"]]
        if long_tags:
            issues.append(f"Tags over {rules['tag_chars_max']} chars: {long_tags}.")
            score -= 5
        single = [t for t in tags if " " not in t]
        if len(single) > 2:
            issues.append(f"Too many one-word tags {single}; use 2-3 word buyer phrases.")
            score -= 4
        dup = {t.lower() for t in tags if tags and [x.lower() for x in tags].count(t.lower()) > 1}
        if dup:
            issues.append(f"Duplicate tags: {sorted(dup)}.")
            score -= 4
        slug = slugify(title[len("i will"):] if title.lower().startswith("i will") else title)
        if targets and slugify(targets[0]) not in slug:
            issues.append(f"URL slug '{slug}' won't contain the primary keyword - Fiverr builds the slug "
                          "from the title when the gig is first published and it can't be edited later.")
            score -= 5
        if description and targets:
            first150 = " ".join(description.split()[:150])
            if targets[0].lower() not in first150.lower():
                issues.append(f"Primary keyword '{targets[0]}' is not in the first 150 words of the description.")
                score -= 6
        if description and len(description) > rules["description_max"]:
            issues.append(f"Description is {len(description)} chars; limit is {rules['description_max']}.")
            score -= 10
    else:
        if len(tags) > rules["skills_max"]:
            issues.append(f"Upwork allows {rules['skills_max']} skills; you listed {len(tags)}.")
            score -= 5
        elif len(tags) < 10:
            issues.append(f"Only {len(tags)} skills - add more (up to {rules['skills_max']}) from Upwork's list.")
            score -= 4
        if description:
            if len(description) > rules["overview_max"]:
                issues.append(f"Overview is {len(description)} chars; limit is {rules['overview_max']}.")
                score -= 10
            hook = description[: rules["overview_visible"]]
            if targets and not _found_keywords(hook, targets[:2]):
                issues.append("The first ~200 visible overview characters don't contain your top keywords.")
                score -= 8

    if description:
        if len(description) < 400:
            issues.append("Description is thin (<400 chars). Add process, deliverables, software, and FAQs.")
            score -= 6
        violations = _contact_violations(description + " " + title)
        if violations:
            issues.append("Contains contact details/links - these break marketplace ToS and can get the listing removed.")
            score -= 20
        if not re.search(r"(order|message|contact|hire|invite|let'?s)", description.lower()):
            issues.append("No call to action at the end of the description.")
            score -= 3
    else:
        issues.append("No description provided - only partial audit.")

    return json.dumps({
        "platform": platform,
        "score": max(score, 0),
        "issues": issues,
        "wins": wins,
        "limits": {k: v for k, v in rules.items() if k != "notes"},
    }, indent=2)


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def check_proposal(proposal: str, job_post: str = "") -> str:
    """Check an Upwork proposal for generic openers, hook length, job-post mirroring and a CTA."""
    issues: list[str] = []
    wins: list[str] = []
    score = 100
    text = proposal.strip()
    lines = [l for l in text.splitlines() if l.strip()]
    first = lines[0].lower() if lines else ""
    opener_hits = [g for g in GENERIC_OPENERS if g in first]
    if opener_hits:
        issues.append(f"Generic opener {opener_hits} - the first line must speak to the client's project.")
        score -= 25
    preview = text[:220]
    if len(lines) and len(lines[0]) > 220:
        issues.append("The hook runs past the ~220 characters clients see in the proposal preview.")
        score -= 8
    words = len(text.split())
    if words > 300:
        issues.append(f"{words} words - aim for 120-250 so it gets read in full.")
        score -= 8
    elif words < 60:
        issues.append(f"Only {words} words - add workflow, stack match and a deliverable plan.")
        score -= 8
    if not re.search(r"\?\s*$", lines[-1] if lines else ""):
        issues.append("Doesn't end with a question - close with a low-friction question to start a chat.")
        score -= 10
    else:
        wins.append("Ends with a question CTA.")
    if _contact_violations(text):
        issues.append("Contains contact details/links - against Upwork ToS before a contract starts.")
        score -= 20
    you = len(re.findall(r"\byou(r)?\b", text.lower()))
    me = len(re.findall(r"\b(i|my|me)\b", text.lower()))
    if me > you * 2 and me > 6:
        issues.append(f"Talks about 'I/my' {me}x vs 'you/your' {you}x - make it client-centred.")
        score -= 6
    matched: list[str] = []
    if job_post:
        terms = [w for w in re.findall(r"[a-zA-Z0-9+#]{3,}", job_post.lower()) if w not in STOPWORDS]
        freq: dict[str, int] = {}
        for w in terms:
            freq[w] = freq.get(w, 0) + 1
        key_terms = [w for w, _ in sorted(freq.items(), key=lambda kv: -kv[1])[:15]]
        matched = [w for w in key_terms if w in text.lower()]
        missing = [w for w in key_terms if w not in matched]
        if len(matched) < len(key_terms) * 0.4:
            issues.append(f"Mirrors few of the job post's key terms. Missing: {missing[:8]}.")
            score -= 12
        else:
            wins.append(f"Mirrors job-post terms: {matched}.")
        if not any(w in preview.lower() for w in key_terms[:6]):
            issues.append("The visible hook doesn't reference anything specific from the job post.")
            score -= 10
    return json.dumps({"score": max(score, 0), "issues": issues, "wins": wins,
                       "word_count": words}, indent=2)


def platform_guide(platform: str) -> str:
    """Return SEO rules and ranking factors for 'fiverr' or 'upwork'."""
    platform = platform.strip().lower()
    if platform not in PLATFORM_RULES:
        return json.dumps({"error": f"platform must be one of {list(PLATFORM_RULES)}"})
    data = dict(PLATFORM_RULES[platform])
    if platform == "upwork":
        data["skill_suggestions"] = UPWORK_SKILL_SUGGESTIONS
    else:
        data["category_candidates"] = FIVERR_CATEGORY_CANDIDATES
    return json.dumps(data, indent=2)


def save_report(filename: str, content: str) -> str:
    """Save the final optimized listing/report as Markdown in seo_agent/reports/."""
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", filename).strip("._") or "report"
    if not safe.endswith(".md"):
        safe += ".md"
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORTS_DIR / f"{datetime.now():%Y%m%d-%H%M%S}-{safe}"
    path.write_text(content, encoding="utf-8")
    return f"Saved to {path}"
