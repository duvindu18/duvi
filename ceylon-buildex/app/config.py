"""Paths and settings. Everything can be overridden with environment variables."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("LRP_DATA", ROOT / "data"))
RAW = DATA / "raw"
INBOX = RAW / "inbox"          # drop any PDF / DOCX / image here; `update` ingests it
RULES = DATA / "rules"
SEED = DATA / "seed"
DB_PATH = Path(os.environ.get("LRP_DB", DATA / "dataset.sqlite"))
JSONL_PATH = DATA / "dataset.jsonl"
DOCS_JSON = DATA / "documents.json"
SOURCES_JSON = ROOT / "config" / "sources.json"
WEB = ROOT / "web"
UPLOADS = DATA / "uploads"

# OCR
OCR_LANGS = os.environ.get("OCR_LANGS", "eng")           # e.g. eng+sin+tam when those traineddata files are installed
OCR_DPI_FAST = int(os.environ.get("OCR_DPI_FAST", "170"))
OCR_DPI_ACCURATE = int(os.environ.get("OCR_DPI_ACCURATE", "300"))
OCR_WORKERS = int(os.environ.get("OCR_WORKERS", str(max(1, (os.cpu_count() or 2)))))
MIN_TEXT_CHARS_PER_PAGE = int(os.environ.get("MIN_TEXT_CHARS_PER_PAGE", "60"))

# Downloads
USER_AGENT = os.environ.get("LRP_USER_AGENT", "CeylonBuildex/1.0 (research dataset builder; contact: set LRP_USER_AGENT)")
POLITE_DELAY = float(os.environ.get("LRP_DELAY", "1.0"))
MAX_DOWNLOAD_MB = int(os.environ.get("LRP_MAX_MB", "120"))
HTTP_TIMEOUT = int(os.environ.get("LRP_TIMEOUT", "45"))

# LLM: provider = anthropic | openai | none
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "auto")    # auto = anthropic if ANTHROPIC_API_KEY is set, else openai if OPENAI_API_KEY / LLM_BASE_URL, else none
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
ANTHROPIC_URL = os.environ.get("ANTHROPIC_URL", "https://api.anthropic.com/v1/messages")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_BASE = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")   # Ollama: http://localhost:11434/v1
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "1200"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")      # a running Ollama is picked up automatically (no key needed)
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:4b")             # checked at start-up with: ollama run <model> "<prompt>"
OLLAMA_CHECK_PROMPT = os.environ.get("OLLAMA_CHECK_PROMPT", "Say ready")
OLLAMA_BOOT = os.environ.get("LRP_OLLAMA_BOOT", "auto").lower()          # auto (when Ollama could be used) | 0 (never) | 1 (always)
OLLAMA_AUTOPULL = os.environ.get("OLLAMA_AUTOPULL", "1").lower() not in ("0", "false", "no", "off")   # download the model if it is missing
OLLAMA_BIN = os.environ.get("OLLAMA_BIN", "")                            # full path to the ollama program, if it is not on the PATH
ALLOWED_HOSTS = {h.strip().lower() for h in os.environ.get("LRP_ALLOWED_HOSTS", "").split(",") if h.strip()}   # extra Host names allowed to change settings

# Server
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
AUTO_UPDATE_HOURS = float(os.environ.get("AUTO_UPDATE_HOURS", "0"))   # >0 = background refresh while the server runs
UPDATE_ON_START = os.environ.get("UPDATE_ON_START", "0").lower()      # 0 | first (download everything the first time the server starts) | always
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "60"))

for d in (DATA, RAW, INBOX, RULES, SEED, UPLOADS):
    d.mkdir(parents=True, exist_ok=True)
