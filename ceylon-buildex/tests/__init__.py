"""Test package. Points the app at a throw-away data directory (copy of the shipped seed + rules) BEFORE app.config is imported,
so tests never touch the real dataset."""
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if "app.config" not in sys.modules and "LRP_DATA" not in os.environ:
    _tmp = Path(tempfile.mkdtemp(prefix="lrp-test-"))
    shutil.copytree(ROOT / "data" / "seed", _tmp / "seed")
    shutil.copytree(ROOT / "data" / "rules", _tmp / "rules")
    os.environ["LRP_DATA"] = str(_tmp)
    os.environ["LRP_DELAY"] = "0"
    os.environ["LLM_PROVIDER"] = "none"
    os.environ.pop("ANTHROPIC_API_KEY", None)
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    os.environ["no_proxy"] = "127.0.0.1,localhost"
sys.path.insert(0, str(ROOT))
