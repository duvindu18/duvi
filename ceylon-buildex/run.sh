#!/usr/bin/env bash
# Ceylon Buildex - one-command setup and start (Linux, macOS, WSL).
#
#   ./run.sh            install whatever is missing, then start the portal at http://127.0.0.1:8080
#   ./run.sh update     install whatever is missing, download / refresh every source, then exit
#   ./run.sh setup      install only
#   ./run.sh test       install (with test tools) and run the test suite
#
# Environment:  PORT=8080   OPEN_BROWSER=0   WITH_SIN_TAM=1 (also install Sinhala + Tamil OCR)
#               FIRST_RUN_UPDATE=0 (do not download the documents on the very first start)
#               ANTHROPIC_API_KEY=...  (written answers from Claude)   AUTO_UPDATE_HOURS=24
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

CMD="${1:-serve}"
case "$CMD" in serve|update|setup|test) ;; *) die "unknown command '$CMD' (use: serve | update | setup | test)";; esac

SUDO=""
if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

# ---------------------------------------------------------------------------- what is missing?
py_ok()   { have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; }
venv_ok() { py_ok && python3 -c 'import venv, ensurepip' 2>/dev/null; }
tess_lang() { have tesseract && tesseract --list-langs 2>/dev/null | grep -qx "$1"; }

missing=()
py_ok          || missing+=("python3 (3.9 or newer)")
venv_ok        || missing+=("python venv module")
have pdftotext || missing+=("poppler (pdftotext, pdftoppm)")
have tesseract || missing+=("tesseract-ocr")
if [ "${WITH_SIN_TAM:-0}" = 1 ]; then
  tess_lang sin || missing+=("tesseract Sinhala data")
  tess_lang tam || missing+=("tesseract Tamil data")
fi

# ---------------------------------------------------------------------------- install system packages
install_system() {
  local pm="" cmds=()
  if   have apt-get; then pm=apt
  elif have dnf;     then pm=dnf
  elif have yum;     then pm=yum
  elif have pacman;  then pm=pacman
  elif have zypper;  then pm=zypper
  elif have apk;     then pm=apk
  elif have brew;    then pm=brew
  fi
  local sin_tam=0; [ "${WITH_SIN_TAM:-0}" = 1 ] && sin_tam=1
  case "$pm" in
    apt)    local pk=(python3 python3-venv python3-pip poppler-utils tesseract-ocr)
            [ $sin_tam = 1 ] && pk+=(tesseract-ocr-sin tesseract-ocr-tam)
            cmds=("$SUDO apt-get update -qq" "$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y ${pk[*]}");;
    dnf|yum) local pk=(python3 python3-pip poppler-utils tesseract)
            [ $sin_tam = 1 ] && pk+=(tesseract-langpack-sin tesseract-langpack-tam)
            cmds=("$SUDO $pm install -y ${pk[*]}");;
    pacman) local pk=(python python-pip poppler tesseract tesseract-data-eng)
            [ $sin_tam = 1 ] && pk+=(tesseract-data-sin tesseract-data-tam)
            cmds=("$SUDO pacman -S --noconfirm --needed ${pk[*]}");;
    zypper) local pk=(python3 python3-pip poppler-tools tesseract-ocr tesseract-ocr-traineddata-english)
            [ $sin_tam = 1 ] && pk+=(tesseract-ocr-traineddata-sinhala tesseract-ocr-traineddata-tamil)
            cmds=("$SUDO zypper --non-interactive install ${pk[*]}");;
    apk)    local pk=(python3 py3-pip poppler-utils tesseract-ocr tesseract-ocr-data-eng)
            [ $sin_tam = 1 ] && pk+=(tesseract-ocr-data-sin tesseract-ocr-data-tam)
            cmds=("$SUDO apk add ${pk[*]}");;
    brew)   local pk=(python poppler tesseract)
            [ $sin_tam = 1 ] && pk+=(tesseract-lang)
            cmds=("brew install ${pk[*]}");;
    *)      if [ "$(uname -s)" = Darwin ]; then
              die "Homebrew is needed to install the system tools. Install it from https://brew.sh, then run ./run.sh again."
            fi
            warn "No supported package manager found. Install by hand: python3 (3.9+, with venv), poppler-utils, tesseract-ocr - then run ./run.sh again."
            return 1;;
  esac
  if [ "$(id -u)" -ne 0 ] && [ "$pm" != brew ] && [ -z "$SUDO" ]; then
    warn "Not root and sudo is not available. Run these as root, then run ./run.sh again:"
    for c in "${cmds[@]}"; do note "$c"; done
    return 1
  fi
  for c in "${cmds[@]}"; do note "\$ $c"; eval "$c" || { warn "'$c' failed"; return 1; }; done
}

if [ ${#missing[@]} -gt 0 ]; then
  say "Installing system requirements: ${missing[*]}"
  install_system || warn "System packages were not installed automatically."
  hash -r
fi

py_ok   || die "Python 3.9 or newer is required and could not be installed automatically."
venv_ok || die "Python's venv module is missing (Debian/Ubuntu: sudo apt install python3-venv)."
have pdftotext || warn "pdftotext not found: PDF text cannot be read (install poppler-utils). The portal still starts with the built-in extracts."
have tesseract || warn "tesseract not found: scanned pages cannot be OCR'd (install tesseract-ocr)."
[ "${WITH_SIN_TAM:-0}" = 1 ] && { tess_lang sin && tess_lang tam || warn "Sinhala/Tamil OCR data not installed; OCR will use English only."; }

# ---------------------------------------------------------------------------- python environment
VENV=".venv"
if [ ! -x "$VENV/bin/python" ]; then
  say "Creating the Python environment (.venv)"
  python3 -m venv ${VENV_ARGS:-} "$VENV"
fi
PY="$VENV/bin/python"

REQ="requirements.txt"; STAMP="$VENV/.requirements.ok"
if [ "$CMD" = test ]; then REQ="requirements-dev.txt"; STAMP="$VENV/.requirements-dev.ok"; fi
sig="$("$PY" -c 'import hashlib,sys; print(hashlib.sha256(b"".join(open(f,"rb").read() for f in sys.argv[1:])).hexdigest())' requirements.txt "$REQ")"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$sig" ]; then
  say "Installing Python packages ($REQ)"
  ok=0
  for attempt in 1 2 3; do
    if "$PY" -m pip install --quiet --disable-pip-version-check -r "$REQ"; then ok=1; break; fi
    warn "pip install failed (attempt $attempt of 3)"; sleep 3
  done
  [ $ok = 1 ] || die "Could not install the Python packages - check your internet connection and try again."
  echo "$sig" > "$STAMP"
fi

# ---------------------------------------------------------------------------- data
"$PY" -m app.ingest init >/dev/null
[ "${WITH_SIN_TAM:-0}" = 1 ] && export OCR_LANGS="${OCR_LANGS:-eng+sin+tam}"

case "$CMD" in
  setup)  say "Setup complete. Start the portal with ./run.sh";;
  update) say "Downloading / refreshing every source"; exec "$PY" -m app.ingest update;;
  test)   say "Running the tests"; exec "$PY" -m unittest discover -s tests -t . ;;
  serve)
    export PORT="${PORT:-8080}"
    URL="http://127.0.0.1:$PORT"
    [ "${FIRST_RUN_UPDATE:-1}" = 1 ] && export UPDATE_ON_START="${UPDATE_ON_START:-first}"
    say "Starting Ceylon Buildex at $URL   (Ctrl+C to stop)"
    if [ -n "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${LLM_BASE_URL:-}" ]; then note "Answers: written by the language model."
    else note "Answers: quoted passages for now - open the portal and click 'Answers' (top right) to add your Claude API key or a local model."; fi
    if [ "${OPEN_BROWSER:-1}" = 1 ]; then
      ( sleep 3
        if [ "$(uname -s)" = Darwin ]; then open "$URL"
        elif have xdg-open && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then xdg-open "$URL"; fi ) >/dev/null 2>&1 &
    fi
    exec "$PY" -m app.server;;
esac
