"""Shared agent core: system prompt, tools, task prompts and the turn runner.
Used by both the CLI (agent.py) and the web interface (web.py)."""

from __future__ import annotations

from typing import Iterator

import anthropic
from anthropic import beta_tool

from . import tools as T

MODEL = "claude-opus-5-5"

SYSTEM_PROMPT = """You are an expert Freelance SEO Strategist and AI Automation Engineer for high-ticket \
freelance platforms (Fiverr and Upwork), with deep domain expertise in Architectural Visualization (ArchViz). \
Your job: produce conversion-focused, algorithm-friendly gig listings, proposals and profile strategies that \
rank at the top of search and win ArchViz clients.

## Platform rules
Fiverr
- Primary keyword right after "I will" in the gig title (max 80 chars). The URL slug is generated from the \
title when the gig is first published and cannot be edited later, so the title must carry the keyword from day one.
- All 5 search tags used, each a buyer phrase (max 20 chars), no duplicates of the title's filler.
- Primary keyword inside the first 150 words of the description; the first 2 lines sell the outcome.
- Basic / Standard / Premium packages with keyword-bearing package names, clear scope, deliverables, delivery \
days, revision limits and price anchoring (Premium makes Standard look like the obvious choice).
- Category / subcategory: route to the most specific ArchViz subcategory. Fiverr reshuffles categories - \
confirm the current path with web_search and say if you couldn't verify it.
Upwork
- Parse the job post: deliverables, stated and implied software, style references, deadline, budget, \
red flags, and the questions the client asked. Answer every client question.
- Custom hook (first 1-2 lines, visible in the preview): prove you read the post by naming the client's \
specific aesthetic or technical challenge. Never open with a greeting, your name or "I read your job".
- Body: the ArchViz workflow you'd run for THIS project, software stack match, risk mitigation \
(clay/draft review before final, camera-angle approval, revision policy, file-handling), and a milestone \
plan where milestones map to approvals (e.g. 1 model + clay renders, 2 materials/lighting draft, 3 finals + post).
- Close with a low-friction question that is easy to answer in one line and starts a chat.

## ArchViz expertise
Speak the language of architects, interior designers, real estate developers and prop-tech firms: \
photorealism, PBR materials, HDRI and daylight studies, camera framing at eye level vs. aerial, clay renders, \
post-production, Revit-to-3ds Max / Datasmith pipelines, BIM, CAD to 3D, 3D floor plans, exterior / interior \
rendering, architectural animation and walkthroughs, 360 tours, Unreal Engine 5 real-time, Lumion, Enscape, \
D5, Twinmotion, V-Ray, Corona, Blender. Address their pain points: missed marketing launch dates, renders \
that don't match the design intent, endless revision loops, poor communication, pre-sales that need \
emotion-driven imagery.

## Conversion psychology
Direct-response copy: outcome first, concrete deliverables, turnaround, revision limits, risk reversal \
(free clay preview, revision guarantee within scope), portfolio-driven trust signals. No fluff, no hype \
words ("best", "cheap", "amazing"), no unverifiable claims, no contact details or external links (ToS).

## Workflow - for a gig/niche request deliver, in this order, with Markdown headings:
1. Market & Keyword Analysis - primary keyword, 5-10 long-tail keywords with intent and a qualitative \
competition estimate, and why each fits. Use keyword_ideas and web_search; never invent search-volume numbers.
2. Fiverr Gig Optimization Package - Gig Title, URL slug it will produce, Category / Subcategory path, \
5 Search Tags, a 3-tier Pricing table (scope, deliverables, delivery days, revisions, price), Gig Description, \
FAQs (3-5), Requirements Questionnaire (intake questions that prevent scope creep: drawings/CAD/model files, \
views and camera angles, material/finish references, mood/lighting references, resolution and aspect ratio, \
deadline, usage), and thumbnail text ideas.
3. Upwork Winning Proposal Framework - custom hook, body strategy, milestone plan, CTA question. If no job post \
is given, write a reusable framework with bracketed slots plus one filled example.
For an Upwork-only, audit, proposal or keyword request, deliver just the relevant parts.

## Quality gate
- Run audit_listing on every Fiverr gig / Upwork profile you write and check_proposal on every proposal. Fix \
the issues and re-run until the score is 85+ or the remaining issues are deliberate (say why).
- Prices: give anchors as ranges suitable for the seller's stated level; if unknown, assume a mid-level \
seller and say so.
- Finish by calling save_report with the deployable Markdown. Be analytical and precise; every output must be \
ready to paste into Fiverr or Upwork."""


@beta_tool
def keyword_ideas(niche: str = "all", seed: str = "") -> str:
    """Get curated architectural-visualization keywords with buyer intent and competition estimates.

    Args:
        niche: One of all, core, exterior, interior, real_estate, animation_interactive, software,
            modelling, commercial_niches.
        seed: Optional seed phrase (e.g. "villa rendering") to expand into long-tail variants.
    """
    return T.keyword_ideas(niche, seed)


@beta_tool
def platform_guide(platform: str) -> str:
    """Get SEO rules, character limits, ranking factors and (Fiverr) category candidates.

    Args:
        platform: "fiverr" or "upwork".
    """
    return T.platform_guide(platform)


@beta_tool
def audit_listing(
    platform: str,
    title: str,
    description: str = "",
    tags: list[str] | None = None,
    target_keywords: list[str] | None = None,
) -> str:
    """Score a Fiverr gig or Upwork profile 0-100: limits, keyword placement, slug, first 150 words, tags, ToS.

    Args:
        platform: "fiverr" or "upwork".
        title: Gig title (Fiverr) or profile / catalog title (Upwork).
        description: Gig description (Fiverr) or profile overview (Upwork).
        tags: Fiverr search tags or Upwork skills.
        target_keywords: Keywords to rank for, most important first.
    """
    return T.audit_listing(platform, title, description, tags, target_keywords)


@beta_tool
def check_proposal(proposal: str, job_post: str = "") -> str:
    """Score an Upwork proposal 0-100: generic openers, hook length, job-post mirroring, length, CTA, ToS.

    Args:
        proposal: Full proposal text.
        job_post: The client's job post, to check that the proposal mirrors its key terms.
    """
    return T.check_proposal(proposal, job_post)


@beta_tool
def save_report(filename: str, content: str) -> str:
    """Save the final deployable listing / proposal / report as a Markdown file.

    Args:
        filename: Short file name, e.g. "fiverr-exterior-gig".
        content: Full Markdown content to save.
    """
    return T.save_report(filename, content)


TOOLS = [
    keyword_ideas,
    platform_guide,
    audit_listing,
    check_proposal,
    save_report,
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 5},
]

TASKS = {
    "full": "Run the full workflow (keyword analysis, Fiverr gig package, Upwork proposal framework)",
    "fiverr": "Create a Fiverr gig optimization package",
    "proposal": "Write an Upwork proposal for a job post",
    "upwork_profile": "Create / optimize an Upwork profile",
    "audit": "Audit and rewrite an existing listing",
    "keywords": "Market & keyword analysis only",
}


def build_task_prompt(task: str, niche: str = "", about: str = "", text: str = "",
                      platform: str = "fiverr") -> str:
    niche = niche.strip() or "architectural visualization"
    parts = []
    if task == "full":
        parts.append(f"Niche focus: {niche}. Run the full workflow.")
    elif task == "fiverr":
        parts.append(f"Create a Fiverr gig for {niche}. Deliver sections 1 and 2 of the workflow.")
    elif task == "proposal":
        parts.append("Write a winning Upwork proposal for the job post below (section 3), including a "
                     f"milestone plan. My niche: {niche}.")
    elif task == "upwork_profile":
        parts.append(f"Create an optimized Upwork profile for {niche}: title, 200-char overview hook, full "
                     "overview, 15 skills, specialized-profile ideas and 3 Project Catalog offers.")
    elif task == "audit":
        parts.append(f"Audit my current {platform} listing below, show the before score, then rewrite it "
                     "and show the after score.")
    elif task == "keywords":
        parts.append(f"Market & keyword analysis for {niche} on Fiverr and Upwork (section 1), with title "
                     "and tag recommendations.")
    else:
        parts.append(niche)
    if about.strip():
        parts.append(f"About me (seller): {about.strip()}")
    if text.strip():
        label = "Job post" if task == "proposal" else "My current listing / extra context"
        parts.append(f"{label}:\n---\n{text.strip()}\n---")
    return "\n\n".join(parts)


def run_turn(client: anthropic.Anthropic, history: list) -> Iterator[dict]:
    """Run one agent turn (any number of tool calls), appending to `history` and yielding UI events:
    {"type": "text", "text"}, {"type": "tool", "name", "detail"}, {"type": "notice", "text"}."""
    runner = client.beta.messages.tool_runner(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        tools=TOOLS,
        messages=list(history),
        output_config={"effort": "high"},
        thinking={"type": "adaptive"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        max_iterations=30,
    )
    for message in runner:
        history.append({"role": "assistant", "content": message.content})
        for block in message.content:
            if block.type == "text" and block.text.strip():
                yield {"type": "text", "text": block.text}
            elif block.type == "tool_use":
                yield {"type": "tool", "name": block.name, "detail": _tool_detail(block.input)}
            elif block.type == "server_tool_use":
                yield {"type": "tool", "name": "web_search",
                       "detail": str((block.input or {}).get("query", ""))}
        if message.stop_reason == "refusal":
            yield {"type": "notice", "text": "The model declined this request."}
            return
        if message.stop_reason == "max_tokens":
            yield {"type": "notice", "text": "Response hit the length limit - ask it to continue."}
        tool_response = runner.generate_tool_call_response()
        if tool_response is not None:
            history.append(tool_response)


def _tool_detail(inp: object) -> str:
    if not isinstance(inp, dict):
        return ""
    for key in ("title", "niche", "platform", "filename", "seed"):
        if inp.get(key):
            return str(inp[key])[:80]
    if inp.get("proposal"):
        return str(inp["proposal"])[:60] + "..."
    return ""


def final_markdown(history: list, start: int) -> str:
    """Join the assistant text produced since history[start] into one Markdown document."""
    chunks = []
    for msg in history[start:]:
        if msg["role"] != "assistant":
            continue
        for block in msg["content"]:
            if getattr(block, "type", None) == "text" and block.text.strip():
                chunks.append(block.text.strip())
    return "\n\n".join(chunks)
