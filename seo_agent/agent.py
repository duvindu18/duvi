"""ArchViz SEO Agent - command line.

Free by default: the built-in engine needs no API key and no internet.

    python -m seo_agent.agent --task full --niche "exterior rendering"
    python -m seo_agent.agent --task full --engine ollama       # free local AI (Ollama)
    python -m seo_agent.agent --engine claude                   # paid Claude API, interactive chat
    python -m seo_agent.agent --task proposal --file job_post.txt
    python -m seo_agent.agent --task audit --platform upwork --file my_profile.txt

For the web interface run:  python -m seo_agent.web
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import anthropic

from . import local_llm, offline
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
    parser.add_argument("--engine", choices=["builtin", "ollama", "claude"], default="builtin",
                        help="builtin (free, offline, default), ollama (free local AI) or claude (paid API)")
    parser.add_argument("--model", default="", help="Ollama model name (default: first installed)")
    args = parser.parse_args()
    text = Path(args.file).read_text(encoding="utf-8") if args.file else ""

    if args.engine == "builtin":
        for ev in offline.run(args.task or "full", args.niche, args.about, text, args.platform):
            if ev["type"] == "text":
                print(ev["text"] + "\n")
            elif ev["type"] == "notice":
                print(f"({ev['text']})", file=sys.stderr)
        return
    if args.engine == "ollama":
        model = args.model or (local_llm.ollama_models() or [""])[0]
        if not model:
            sys.exit("Ollama isn't running or has no models. Install it from ollama.com, then: ollama pull llama3.1:8b")
        history = [{"role": "user", "content": local_llm.first_prompt(
            args.task or "full", args.niche, args.about, text, args.platform)}]
        while True:
            for ev in local_llm.run_ollama(model, history):
                if ev["type"] == "delta":
                    print(ev["text"], end="", flush=True)
            print()
            try:
                user = input("\nyou> ").strip()
            except (EOFError, KeyboardInterrupt):
                return
            if not user or user.lower() in {"exit", "quit"}:
                return
            history.append({"role": "user", "content": user})

    key = api_key()
    client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
    history: list = []

    if args.task:
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
