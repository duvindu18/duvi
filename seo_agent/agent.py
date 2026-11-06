"""Arch Viz SEO Agent - optimizes Fiverr gigs and Upwork profiles for
architectural visualization freelancers, using Claude + tools.

Usage:
    python -m seo_agent.agent                          # interactive chat
    python -m seo_agent.agent --task create --platform fiverr --niche exterior
    python -m seo_agent.agent --task audit  --platform upwork --file my_profile.txt
    python -m seo_agent.agent --task keywords --niche interior
    python -m seo_agent.agent --task proposal --file job_post.txt
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import anthropic
from anthropic import beta_tool

from . import tools as T

MODEL = "claude-opus-5-5"

SYSTEM_PROMPT = """You are an SEO and marketplace-growth specialist for architectural visualization \
(arch viz) freelancers selling on Fiverr and Upwork. Your client renders buildings, interiors, \
exteriors, floor plans, walkthrough animations and virtual tours with tools such as 3ds Max, Corona, \
V-Ray, Lumion, Enscape, D5, Twinmotion, SketchUp, Revit, Blender and Unreal Engine.

What you produce:
- Fiverr gigs: title ("I will ..."), 5 search tags, category/subcategory, description (<=1200 chars), \
3 package names + deliverables, FAQs, gig image/thumbnail text ideas.
- Upwork: profile title, the 200-character overview hook, full overview, 15 skills, specialized-profile \
ideas, Project Catalog titles ("You will get ..."), and proposal openers tailored to a job post.
- Keyword strategies: one high-volume core phrase plus low-competition long-tail phrases \
(niche + software + use case, e.g. "exterior rendering lumion", "real estate 3d floor plan").

How you work:
- Use keyword_ideas and platform_guide for grounded data, and web_search to check current marketplace \
rules, competitor gig wording, and trending buyer phrases. Say which suggestions came from research \
and which are your judgment; never invent search-volume numbers.
- Always run audit_listing on any title/tags/description you write or are given, fix the issues it \
reports, and re-run it until the score is 85+ or the remaining issues are deliberate trade-offs.
- Write for humans first: clear outcome, deliverables, turnaround, revisions, software, file formats. \
No keyword stuffing, no fake claims, no contact details or external links (marketplace ToS).
- Remind the user that keywords get a listing into results, but CTR, conversion, response time and \
reviews decide ranking - give 2-3 concrete actions for those too.
- When you deliver a final listing, call save_report with clean Markdown the user can copy-paste."""


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
    """Get SEO rules, character limits and ranking factors for a marketplace.

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
    """Score a Fiverr gig or Upwork profile 0-100 and list concrete SEO issues.

    Args:
        platform: "fiverr" or "upwork".
        title: Gig title (Fiverr) or profile / catalog title (Upwork).
        description: Gig description (Fiverr) or profile overview (Upwork).
        tags: Fiverr search tags or Upwork skills.
        target_keywords: Keywords to rank for, most important first.
    """
    return T.audit_listing(platform, title, description, tags, target_keywords)


@beta_tool
def save_report(filename: str, content: str) -> str:
    """Save a final optimized listing or SEO report as a Markdown file.

    Args:
        filename: Short file name, e.g. "fiverr-exterior-gig".
        content: Full Markdown content to save.
    """
    return T.save_report(filename, content)


TOOLS = [
    keyword_ideas,
    platform_guide,
    audit_listing,
    save_report,
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 5},
]


def build_task_prompt(args: argparse.Namespace) -> str | None:
    extra = ""
    if args.file:
        extra = "\n\n---\n" + Path(args.file).read_text(encoding="utf-8")
    profile = f"\nAbout me: {args.about}" if args.about else ""
    niche = args.niche or "general architectural visualization"
    if args.task == "create":
        return (f"Create a fully optimized {args.platform} listing for my {niche} service.{profile}"
                f"{extra}")
    if args.task == "audit":
        return (f"Audit and rewrite my current {args.platform} listing below for better search "
                f"ranking. Show the before/after score.{profile}{extra}")
    if args.task == "keywords":
        return (f"Build a keyword strategy for {niche} on both Fiverr and Upwork, with title and "
                f"tag recommendations for each.{profile}{extra}")
    if args.task == "proposal":
        return (f"Write an Upwork proposal for this job post. Mirror the client's wording, keep "
                f"the opener under 2 lines, and suggest a price structure.{profile}{extra}")
    return None


def run_turn(client: anthropic.Anthropic, history: list) -> None:
    """Run one agent turn (with as many tool calls as needed), appending to history."""
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
        max_iterations=25,
    )
    for message in runner:
        history.append({"role": "assistant", "content": message.content})
        for block in message.content:
            if block.type == "text" and block.text.strip():
                print(block.text)
            elif block.type == "tool_use":
                print(f"  [tool] {block.name}", file=sys.stderr)
            elif block.type == "server_tool_use":
                query = (block.input or {}).get("query", "")
                print(f"  [web_search] {query}", file=sys.stderr)
        if message.stop_reason == "refusal":
            print("(The model declined this request.)", file=sys.stderr)
            return
        tool_response = runner.generate_tool_call_response()
        if tool_response is not None:
            history.append(tool_response)


def main() -> None:
    parser = argparse.ArgumentParser(description="Arch Viz SEO agent for Fiverr & Upwork")
    parser.add_argument("--task", choices=["create", "audit", "keywords", "proposal"])
    parser.add_argument("--platform", choices=["fiverr", "upwork"], default="fiverr")
    parser.add_argument("--niche", help="e.g. exterior, interior, real estate, 3d animation")
    parser.add_argument("--about", help="Short description of your skills, software and experience")
    parser.add_argument("--file", help="Text file with your current listing or a job post")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    history: list = []
    first = build_task_prompt(args)

    if first:
        history.append({"role": "user", "content": first})
        run_turn(client, history)
        if not sys.stdin.isatty():
            return

    print("\nArch Viz SEO Agent - ask anything (type 'exit' to quit).")
    while True:
        try:
            user = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if user.lower() in {"exit", "quit"}:
            break
        if not user:
            continue
        mark = len(history)
        history.append({"role": "user", "content": user})
        try:
            run_turn(client, history)
        except anthropic.APIStatusError as e:
            print(f"API error {e.status_code}: {e.message}", file=sys.stderr)
            del history[mark:]
        except anthropic.APIConnectionError:
            print("Network error - check your connection.", file=sys.stderr)
            del history[mark:]


if __name__ == "__main__":
    main()
