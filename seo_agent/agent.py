"""ArchViz SEO Agent - command line.

    python -m seo_agent.agent                                   # interactive chat
    python -m seo_agent.agent --task full --niche "exterior rendering"
    python -m seo_agent.agent --task proposal --file job_post.txt
    python -m seo_agent.agent --task audit --platform upwork --file my_profile.txt

For the web interface run:  python -m seo_agent.web
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import anthropic

from .core import TASKS, build_task_prompt, run_turn
from .paths import api_key


def _print_events(client: anthropic.Anthropic, history: list) -> None:
    for ev in run_turn(client, history):
        if ev["type"] == "text":
            print(ev["text"])
        elif ev["type"] == "tool":
            print(f"  [{ev['name']}] {ev['detail']}", file=sys.stderr)
        else:
            print(f"  ({ev['text']})", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="ArchViz SEO agent for Fiverr & Upwork")
    parser.add_argument("--task", choices=list(TASKS))
    parser.add_argument("--platform", choices=["fiverr", "upwork"], default="fiverr")
    parser.add_argument("--niche", default="", help="e.g. exterior rendering, 3D floor plans")
    parser.add_argument("--about", default="", help="Your skills, software, experience, price level")
    parser.add_argument("--file", help="Text file with a job post or your current listing")
    args = parser.parse_args()

    key = api_key()
    client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
    history: list = []

    if args.task:
        text = Path(args.file).read_text(encoding="utf-8") if args.file else ""
        history.append({"role": "user", "content": build_task_prompt(
            args.task, args.niche, args.about, text, args.platform)})
        _print_events(client, history)
        if not sys.stdin.isatty():
            return

    print("\nArchViz SEO Agent - ask anything (type 'exit' to quit).")
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
            _print_events(client, history)
        except anthropic.APIStatusError as e:
            print(f"API error {e.status_code}: {e.message}", file=sys.stderr)
            del history[mark:]
        except anthropic.APIConnectionError:
            print("Network error - check your connection.", file=sys.stderr)
            del history[mark:]


if __name__ == "__main__":
    main()
