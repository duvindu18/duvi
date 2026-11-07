"""Runs a command, shows its output live and also writes it to a file (CI logs that survive the run).

    python packaging/ci_tee.py ci-out/unit-tests.txt -- python -m unittest discover -s tests -v
"""
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if "--" not in sys.argv:
        print(__doc__)
        return 2
    i = sys.argv.index("--")
    out = Path(sys.argv[1])
    cmd = sys.argv[i + 1:]
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8", errors="replace") as f:
        f.write("$ " + " ".join(cmd) + "\n")
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1, text=True,
                             encoding="utf-8", errors="replace")
        for line in p.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            f.write(line)
            f.flush()
        code = p.wait()
        f.write(f"\n[exit code {code}]\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
